/**
 * MentionService — Cursor-style @-mention providers for the agent chat.
 *
 * Spec: ~/workspace/ide-code-mission/docs/rea/parity-at-mentions.md
 * (REA of Cursor 3.25.6: mention-chip-utils.js chunk, getMentionItems
 * builders, insertMention/removeMention, Amp click actions).
 *
 * Architecture: the composer webview cannot query VS Code state, so it posts
 * `{type:'mentionQuery', requestId, query}` to the host; the host resolves
 * items through the provider registry below and replies with
 * `{type:'mentionItems', requestId, items, isLoading}`. Selected chips come
 * back on submit and are resolved to real context blocks by
 * resolveMentionContext() before the prompt reaches the engine.
 *
 * 15 providers (Cursor's canonical type set Tmp + the observed payload
 * cases Emp):
 *   file, folder, code, doc, terminal, chat, git (working diff — Cursor's
 *   docs-observed "(commit)" item), branch, browser, mcp, canvas, clipboard,
 *   cursorRule, gitPRDiff, codebase (local index: Instant Grep + symbols).
 *
 * Providers with no backing implementation return [] — an honest empty
 * result, never a fabricated item:
 *   - docs: Cursor's client returns [] too (server-provided suggestions).
 *   - chat (past chats): no persisted side-chat store exists yet.
 *   - mcp: no servers configured (MCP client workstream owns this).
 *   - canvas: no canvas feature in this IDE.
 *   - gitPRDiff: no PR integration.
 */

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { searchCodebase } from "./codebaseIndexService";
import {
  MentionChip,
  MentionItem,
  MentionKind,
  MentionPayload,
  MENTION_ITEM_CAP,
  MENTION_QUERY_CAP,
  fuzzyMatch,
  isMentionChip,
  matchesMentionQuery,
  normalizeMentionQuery,
  parseMentionScope,
} from "./mentionMatch";
// Re-export the shared mention model for consumers (extension host wiring).
export {
  MentionChip,
  MentionItem,
  MentionKind,
  MentionPayload,
  MENTION_ITEM_CAP,
  MENTION_QUERY_CAP,
  isMentionChip,
};
import type { TerminalService } from "./terminalService";
import type { ProjectRulesService } from "./projectRulesService";
import { browserCaptureDir } from "../browser/chromium";

/** Context attachment caps. */

/**
 * A file attachment for the engine prompt (mirrors PromptInput.FileAttachment:
 * {uri, name, description}). Used for browser-tab screenshots — the engine
 * reads the PNG as an image part.
 */
export interface FileAttachment {
  uri: string;
  name: string;
  description?: string;
}
const FILE_CONTEXT_CHARS = 60_000; // curation restored 2026-10-19: focused file context keeps the model sharp
const DIFF_CONTEXT_LINES = 400;
const FOLDER_TREE_ENTRIES = 2000; // raised per user directive 2026-10-19 (was 200)
const CLIPBOARD_CHARS = 8_000;

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

interface MentionProvider {
  kinds: MentionKind[];
  /** Providers that only make sense with a non-empty query set this. */
  queryOnly?: boolean;
  getItems(query: string): Promise<MentionItem[]>;
}

const execFileAsync = promisify(execFile);

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function relPath(fsPath: string): string {
  const root = workspaceRoot();
  if (root) {
    const rel = path.relative(root, fsPath);
    if (rel && !rel.startsWith("..")) {
      return rel;
    }
  }
  return path.basename(fsPath);
}

/**
 * Resolve a webview-supplied relative path back to a file, rejecting
 * anything that escapes the workspace root (the webview is untrusted).
 */
function safeWorkspaceFile(rel: string): string | undefined {
  const root = workspaceRoot();
  if (!root) {
    return undefined;
  }
  const abs = path.resolve(root, rel);
  const rel2 = path.relative(root, abs);
  if (rel2.startsWith("..") || path.isAbsolute(rel2)) {
    return undefined;
  }
  return abs;
}

/** Recently used URIs (open editors first) for file recency ranking. */
function recentUris(): vscode.Uri[] {
  const seen = new Set<string>();
  const out: vscode.Uri[] = [];
  const push = (u: vscode.Uri) => {
    if (u.scheme === "file" && !seen.has(u.fsPath)) {
      seen.add(u.fsPath);
      out.push(u);
    }
  };
  for (const ed of vscode.window.visibleTextEditors) {
    push(ed.document.uri);
  }
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input as { uri?: vscode.Uri } | undefined;
      if (input && input.uri instanceof vscode.Uri) {
        push(input.uri);
      }
    }
  }
  return out;
}

function makeFileItem(uri: vscode.Uri): MentionItem {
  const rel = relPath(uri.fsPath);
  return {
    id: `file:${uri.toString()}`,
    label: path.basename(uri.fsPath),
    rawText: rel,
    mentionType: "file",
    description: path.dirname(rel) === "." ? undefined : path.dirname(rel),
    payload: { case: "fileSelection", uri: uri.toString() },
    searchAliases: [rel],
  };
}

const filesProvider: MentionProvider = {
  kinds: ["file"],
  async getItems(query: string): Promise<MentionItem[]> {
    const items: MentionItem[] = [];
    // Recency-ranked: open editors first (Cursor's getMentionFileRecencyData).
    for (const uri of recentUris()) {
      const item = makeFileItem(uri);
      if (matchesMentionQuery(item, query)) {
        items.push(item);
        if (items.length >= MENTION_ITEM_CAP) {
          return items;
        }
      }
    }
    const found = await vscode.workspace.findFiles(
      "**/*",
      "{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**,**/.vscode-test/**}",
      100,
    );
    for (const uri of found) {
      if (items.length >= MENTION_ITEM_CAP) {
        break;
      }
      const item = makeFileItem(uri);
      if (items.some((i) => i.id === item.id)) {
        continue;
      }
      if (matchesMentionQuery(item, query)) {
        items.push(item);
      }
    }
    return items;
  },
};

const foldersProvider: MentionProvider = {
  kinds: ["folder"],
  async getItems(query: string): Promise<MentionItem[]> {
    const items: MentionItem[] = [];
    const push = (uri: vscode.Uri) => {
      const rel = relPath(uri.fsPath);
      const item: MentionItem = {
        id: `folder:${uri.toString()}`,
        label: path.basename(uri.fsPath) || rel,
        rawText: rel,
        mentionType: "folder",
        description: path.dirname(rel) === "." ? "workspace folder" : path.dirname(rel),
        payload: { case: "folderSelection", uri: uri.toString() },
        searchAliases: [rel],
      };
      if (
        !items.some((i) => i.id === item.id) &&
        matchesMentionQuery(item, query) &&
        items.length < MENTION_ITEM_CAP
      ) {
        items.push(item);
      }
    };
    for (const wf of vscode.workspace.workspaceFolders ?? []) {
      push(wf.uri);
      // One level of subdirectories (bounded; deep trees go through search).
      try {
        const entries = await vscode.workspace.fs.readDirectory(wf.uri);
        for (const [name, type] of entries) {
          if (type === vscode.FileType.Directory && !name.startsWith(".") && name !== "node_modules") {
            push(vscode.Uri.joinPath(wf.uri, name));
            if (items.length >= MENTION_ITEM_CAP) {
              return items;
            }
          }
        }
      } catch {
        // Unreadable workspace folder — skip it.
      }
    }
    return items;
  },
};

const codeProvider: MentionProvider = {
  kinds: ["code"],
  queryOnly: true,
  async getItems(query: string): Promise<MentionItem[]> {
    const items: MentionItem[] = [];
    const push = (
      name: string,
      uri: vscode.Uri,
      startLine: number,
      endLine: number,
      container?: string,
    ) => {
      const rel = relPath(uri.fsPath);
      // Cursor's fenced rawText: ```path:start:end\n<code>\n``` — code is
      // filled in at context-resolution time; the menu row carries location.
      const rawText = `${rel}:L${startLine + 1}-L${endLine + 1}`;
      const item: MentionItem = {
        id: `code:${uri.toString()}#${startLine}:${endLine}`,
        label: name,
        rawText,
        mentionType: "code",
        secondaryText: startLine === endLine ? `L${startLine + 1}` : `L${startLine + 1}-${endLine + 1}`,
        description: container ? `${container} · ${rel}` : rel,
        payload: {
          case: "codeSelection",
          uri: uri.toString(),
          startLine,
          endLine,
          filePath: rel,
          fileName: path.basename(uri.fsPath),
        },
        searchAliases: [rel, container ?? ""],
      };
      if (
        !items.some((i) => i.id === item.id) &&
        matchesMentionQuery(item, query) &&
        items.length < MENTION_ITEM_CAP
      ) {
        items.push(item);
      }
    };
    try {
      const symbols = await vscode.commands.executeCommand<
        (vscode.SymbolInformation & { location: vscode.Location })[] | undefined
      >("vscode.executeWorkspaceSymbolProvider", query);
      for (const s of symbols ?? []) {
        if (items.length >= MENTION_ITEM_CAP) {
          break;
        }
        const r = s.location.range;
        push(s.name, s.location.uri, r.start.line, r.end.line, s.containerName);
      }
    } catch {
      // Workspace symbol provider unavailable — fall back to open documents.
    }
    if (items.length === 0) {
      for (const doc of vscode.workspace.textDocuments) {
        if (doc.uri.scheme !== "file" || items.length >= MENTION_ITEM_CAP) {
          continue;
        }
        try {
          const syms = await vscode.commands.executeCommand<
            vscode.DocumentSymbol[] | undefined
          >("vscode.executeDocumentSymbolProvider", doc.uri);
          const walk = (list: vscode.DocumentSymbol[]) => {
            for (const s of list) {
              const r = s.selectionRange;
              push(s.name, doc.uri, r.start.line, r.end.line);
              walk(s.children);
              if (items.length >= MENTION_ITEM_CAP) {
                return;
              }
            }
          };
          walk(syms ?? []);
        } catch {
          // Skip documents whose symbols fail.
        }
      }
    }
    return items;
  },
};

/** Cursor's client returns [] for "docs" — suggestions are server-provided. */
const docsProvider: MentionProvider = {
  kinds: ["doc"],
  async getItems(): Promise<MentionItem[]> {
    return [];
  },
};

function makeTerminalsProvider(terminalService?: TerminalService): MentionProvider {
  return {
    kinds: ["terminal"],
    async getItems(query: string): Promise<MentionItem[]> {
      const items: MentionItem[] = [];
      for (const term of vscode.window.terminals) {
        // Skip terminals the user hid from the UI (Cursor parity).
        const t = term as vscode.Terminal & { hideFromUser?: boolean };
        if (t.hideFromUser) {
          continue;
        }
        const name = term.name || "Terminal";
        const item: MentionItem = {
          id: `terminal:${name}`,
          label: name,
          rawText: name,
          mentionType: "terminal",
          secondaryText: "terminal",
          description: "Attach terminal output",
          payload: { case: "terminalFile", terminalName: name },
        };
        if (matchesMentionQuery(item, query) && items.length < MENTION_ITEM_CAP) {
          items.push(item);
        }
      }
      return items;
    },
  };
}

/**
 * Past chats: there is no persisted side-chat store in this IDE yet, so the
 * provider honestly returns []. (Cursor's items carry pastChatSelection with
 * agentId/name; wire this provider to the side-chat store when it exists.)
 */
const pastChatsProvider: MentionProvider = {
  kinds: ["chat"],
  async getItems(): Promise<MentionItem[]> {
    return [];
  },
};

async function gitDiff(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
    return stdout;
  } catch {
    return undefined;
  }
}

function capDiffLines(diff: string): string {
  // Curation restored (user directive 2026-10-19 refined): diffs are
  // head-truncated so the prompt stays focused.
  const lines = diff.split("\n");
  if (lines.length > DIFF_CONTEXT_LINES) {
    return lines.slice(0, DIFF_CONTEXT_LINES).join("\n") + "\n... diff truncated ...";
  }
  return diff;
}

const workingDiffProvider: MentionProvider = {
  kinds: ["git"],
  async getItems(query: string): Promise<MentionItem[]> {
    const root = workspaceRoot();
    if (!root) {
      return [];
    }
    const diff = await gitDiff(root, ["diff", "--no-color"]);
    if (!diff || !diff.trim()) {
      return [];
    }
    const item: MentionItem = {
      id: "git:working-diff",
      label: "Commit (Diff of Working State)",
      rawText: "diff of working state",
      mentionType: "git",
      secondaryText: "working diff",
      description: "Attach uncommitted changes",
      payload: { case: "workingDiff", content: diff },
    };
    return matchesMentionQuery(item, query) ? [item] : [];
  },
};

const branchDiffProvider: MentionProvider = {
  kinds: ["branch"],
  async getItems(query: string): Promise<MentionItem[]> {
    const root = workspaceRoot();
    if (!root) {
      return [];
    }
    const branch = (await gitDiff(root, ["rev-parse", "--abbrev-ref", "HEAD"]))?.trim();
    if (!branch) {
      return [];
    }
    // Prefer main, then master, then origin/*.
    let base: string | undefined;
    for (const candidate of ["main", "master", "origin/main", "origin/master"]) {
      const probe = await gitDiff(root, ["rev-parse", "--verify", "--quiet", candidate]);
      if (probe !== undefined) {
        base = candidate;
        break;
      }
    }
    if (!base) {
      return [];
    }
    const diff = await gitDiff(root, ["diff", "--no-color", `${base}...HEAD`]);
    if (!diff || !diff.trim()) {
      return [];
    }
    const item: MentionItem = {
      id: "branch:read-branch",
      label: "Branch",
      // Cursor's rawText for this item.
      rawText: "<branch_context_reference>",
      mentionType: "branch",
      secondaryText: "branch read-branch",
      description: `Reference the ${branch} diff (vs ${base})`,
      payload: {
        case: "branch",
        content: `\`\`\`diff pr=.. branch=${branch} commit=..\n${capDiffLines(diff)}\n\`\`\``,
      },
    };
    return matchesMentionQuery(item, query) ? [item] : [];
  },
};

/**
 * Browser: enables the browser toolset for the turn (Cursor's
 * browserConnection payload). The headless browser tools live in
 * src/browser/mcp-tools.ts; selecting this chip attaches the
 * use-browser marker the engine understands.
 */
const browserProvider: MentionProvider = {
  kinds: ["browser"],
  async getItems(query: string): Promise<MentionItem[]> {
    const item: MentionItem = {
      id: "browser:connection",
      label: "Browser",
      rawText: "browser playwright mcp tools use-browser",
      mentionType: "browser",
      description: "Enable browser tools",
      payload: { case: "browserConnection" },
    };
    return matchesMentionQuery(item, query) ? [item] : [];
  },
};

/** MCP servers: no servers are configured (MCP client workstream owns
 * config + connection state) — honestly empty until then. */
const mcpProvider: MentionProvider = {
  kinds: ["mcp"],
  async getItems(): Promise<MentionItem[]> {
    return [];
  },
};

/** Canvas: no canvas feature exists in this IDE — honestly empty. */
const canvasProvider: MentionProvider = {
  kinds: ["canvas"],
  async getItems(): Promise<MentionItem[]> {
    return [];
  },
};

const clipboardProvider: MentionProvider = {
  kinds: ["clipboard"],
  async getItems(query: string): Promise<MentionItem[]> {
    let text = "";
    try {
      text = await vscode.env.clipboard.readText();
    } catch {
      return [];
    }
    if (!text.trim()) {
      return [];
    }
    const item: MentionItem = {
      id: "clipboard:current",
      label: "Clipboard",
      rawText: "clipboard contents",
      mentionType: "clipboard",
      secondaryText: `${text.length} chars`,
      description: "Attach clipboard text",
      // Curation restored (user directive 2026-10-19 refined): clipboard head only.
      payload: { case: "clipboardSelection", text: text.slice(0, CLIPBOARD_CHARS) },
    };
    return matchesMentionQuery(item, query) ? [item] : [];
  },
};

function makeCursorRuleProvider(rules: ProjectRulesService): MentionProvider {
  return {
    kinds: ["cursorRule"],
    async getItems(query: string): Promise<MentionItem[]> {
      const items: MentionItem[] = [];
      for (const rule of rules.getRules()) {
        const item: MentionItem = {
          id: `cursorRule:${rule.internalPath}`,
          label: rule.filename.replace(/\.mdc$/, ""),
          rawText: `rule ${rule.filename}`,
          mentionType: "cursorRule",
          secondaryText: "cursor rule",
          description: rule.description || rule.internalPath,
          payload: { case: "cursorRule", name: rule.filename, content: rule.body },
        };
        if (matchesMentionQuery(item, query) && items.length < MENTION_ITEM_CAP) {
          items.push(item);
        }
      }
      return items;
    },
  };
}

/** PR diffs: no PR integration exists — honestly empty. */
const prDiffProvider: MentionProvider = {
  kinds: ["git"],
  queryOnly: true,
  async getItems(): Promise<MentionItem[]> {
    return [];
  },
};

/**
 * @Codebase: local-first codebase index (Instant Grep + symbols).
 * One item per query — the chip resolves to a context block at submit time
 * via the engine's `indexing search` CLI. Empty when the engine is
 * unavailable (searchCodebase resolves [] honestly).
 */
const codebaseProvider: MentionProvider = {
  kinds: ["codebase"],
  queryOnly: true,
  async getItems(query: string): Promise<MentionItem[]> {
    const q = query.trim();
    if (!q) {
      return [];
    }
    const hits = await searchCodebase(q, { limit: 5 });
    const secondary = hits.length === 0 ? "no indexed matches" : `${hits.length} indexed matches`;
    return [
      {
        id: `codebase:${q}`,
        label: "@Codebase",
        rawText: `@Codebase ${q}`,
        mentionType: "codebase",
        secondaryText: secondary,
        description: `Search the local codebase index for "${q}"`,
        payload: { case: "codebaseSelection", query: q },
      },
    ];
  },
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class MentionService {
  private readonly providers: MentionProvider[];

  constructor(
    private readonly terminalService?: TerminalService,
    private readonly projectRules?: ProjectRulesService,
  ) {
    this.providers = [
      filesProvider,
      foldersProvider,
      codeProvider,
      docsProvider,
      makeTerminalsProvider(terminalService),
      pastChatsProvider,
      workingDiffProvider,
      branchDiffProvider,
      browserProvider,
      mcpProvider,
      canvasProvider,
      clipboardProvider,
      prDiffProvider,
      codebaseProvider,
    ];
    if (projectRules) {
      this.providers.push(makeCursorRuleProvider(projectRules));
    }
  }

  /** All 15 provider kinds this service covers (for parity audits). */
  coveredKinds(): MentionKind[] {
    const kinds = new Set<MentionKind>();
    for (const p of this.providers) {
      for (const k of p.kinds) {
        kinds.add(k);
      }
    }
    return [...kinds];
  }

  /**
   * Resolve mention menu items for a raw `@` query.
   * Implements Cursor's getMentionItems dispatch (§1.2–1.4):
   * normalize → scope → unscoped "fast" set or scoped/full provider run.
   */
  async getMentionItems(rawQuery: string): Promise<MentionItem[]> {
    const normalized = normalizeMentionQuery(rawQuery);
    const { kinds, query } = parseMentionScope(normalized);

    // Scoped query: only that scope's providers.
    if (kinds) {
      const out: MentionItem[] = [];
      for (const p of this.providers) {
        if (!p.kinds.some((k) => kinds.includes(k))) {
          continue;
        }
        for (const item of await this.safeGet(p, query)) {
          if (out.length >= MENTION_ITEM_CAP * 2) {
            break;
          }
          out.push(item);
        }
      }
      return dedupeById(out);
    }

    // Unscoped menu: "fast" synchronous-ish subset first (branch, browser,
    // mcp, files, folders, terminals) — Cursor's publishUnscopedFullMentionItems.
    // We run everything concurrently and merge; async sources resolve in the
    // same pass (no progressive partials — the menu shows a loading row).
    const out: MentionItem[] = [];
    const empty = query.length === 0;
    await Promise.all(
      this.providers.map(async (p) => {
        if (p.queryOnly && empty) {
          return;
        }
        const got = await this.safeGet(p, query);
        out.push(...got);
      }),
    );
    return dedupeById(out).slice(0, MENTION_ITEM_CAP * 2);
  }

  private async safeGet(p: MentionProvider, query: string): Promise<MentionItem[]> {
    try {
      return (await p.getItems(query)).slice(0, MENTION_ITEM_CAP);
    } catch {
      return [];
    }
  }

  /**
   * Resolve a chip to its model-visible context block (Cursor's context
   * resolution, spec §3). Returns "" when the provider has no data — the
   * caller skips empty blocks rather than fabricating context.
   */
  async resolveMentionContext(chip: MentionChip): Promise<string> {
    if (!isMentionChip(chip)) {
      return "";
    }
    const p = chip.payload;
    try {
      switch (p.case) {
        case "fileSelection": {
          const abs = safeWorkspaceFile(relFromUri(p.uri)) ?? uriToPath(p.uri);
          if (!abs) {
            return "";
          }
          const content = await readTextFile(abs, FILE_CONTEXT_CHARS);
          if (content === undefined) {
            return "";
          }
          return `<context type="file" name="${escapeAttr(relPath(abs))}">\n${content}\n</context>`;
        }
        case "folderSelection": {
          const abs = safeWorkspaceFile(relFromUri(p.uri)) ?? uriToPath(p.uri);
          if (!abs) {
            return "";
          }
          const tree = await folderTree(abs);
          return `<context type="folder" name="${escapeAttr(relPath(abs))}">\n${tree}\n</context>`;
        }
        case "codeSelection": {
          const abs = safeWorkspaceFile(relFromUri(p.uri)) ?? uriToPath(p.uri);
          if (!abs) {
            return "";
          }
          const content = await readTextFile(abs, FILE_CONTEXT_CHARS);
          if (content === undefined) {
            return "";
          }
          const lines = content.split("\n");
          const slice = lines.slice(p.startLine, p.endLine + 1).join("\n");
          // Cursor's fenced rawText: ```path:start:end\n<code>\n```
          return `\`\`\`${p.filePath}:${p.startLine + 1}:${p.endLine + 1}\n${slice}\n\`\`\``;
        }
        case "terminalFile": {
          const t = this.terminalService?.getTerminalText
            ? findTerminalText(this.terminalService, p.terminalName)
            : undefined;
          return t
            ? `<terminal name="${escapeAttr(t.name)}">\n${t.text}\n</terminal>`
            : `(no captured output for terminal "${p.terminalName}")`;
        }
        case "branch":
        case "workingDiff": {
          return p.content;
        }
        case "cursorRule": {
          return `<context type="cursor-rule" name="${escapeAttr(p.name)}">\n${p.content}\n</context>`;
        }
        case "clipboardSelection": {
          return `<context type="clipboard">\n${p.text}\n</context>`;
        }
        case "selectionContext": {
          // Curation restored (user directive 2026-10-19 refined).
          const capped =
            p.content.length > FILE_CONTEXT_CHARS
              ? p.content.slice(0, FILE_CONTEXT_CHARS) + "\n…(truncated)"
              : p.content;
          return `<context type="selection" name="${escapeAttr(p.label)}">\n\`\`\`\n${capped}\n\`\`\`\n</context>`;
        }
        case "codebaseSelection": {
          // @Codebase: resolve through the engine's local index at submit
          // time (fresh results, not the menu-time preview).
          //
          // NOTE (P3, QA-INDEXING-01 — deliberate accept, shared pattern):
          // hit text is embedded verbatim, not XML-escaped. These blocks are
          // prompt text, not a machine-parsed security boundary — nothing in
          // the engine XML-parses `<context type="...">` blocks, and the
          // content comes from the user's own workspace/clipboard. Escaping
          // would corrupt code samples the agent must read exactly
          // (e.g. `a < b` → `a &lt; b`). Same applies to file/folder/
          // cursor-rule/clipboard providers above; changing one without the
          // others would be inconsistent, so all stay verbatim.
          if (!p.query.trim()) {
            return "";
          }
          const hits = await searchCodebase(p.query, { limit: 12 });
          if (hits.length === 0) {
            return "";
          }
          const lines = hits.map((h) =>
            h.kind === "symbol"
              ? `${h.path}:${h.line} ${h.symbolKind} ${h.name}${h.signature ? ` — ${h.signature}` : ""}`
              : `${h.path}:${h.line}: ${h.text}`,
          );
          return `<context type="codebase" query="${escapeAttr(p.query)}">\n${lines.join("\n")}\n</context>`;
        }
        case "imageContext": {
          // Browser-tab screenshot. The image bytes travel as an engine file
          // attachment (extractFileAttachments); the text block only marks
          // its place so the agent knows an image follows.
          return `<context type="image" name="${escapeAttr(p.label)}" file="${escapeAttr(p.filePath)}" />`;
        }
        case "browserConnection": {
          // Marker the engine's browser tool path understands.
          return "browser playwright mcp tools use-browser";
        }
        case "docSelection":
        case "pastChatSelection":
        case "mcpSelection":
        case "canvasSelection":
        case "gitPRDiffSelection":
        case "chatSelection": {
          // No backing data in this IDE (server-side / unimplemented
          // workstreams) — return "" so the caller skips the block.
          return "";
        }
      }
    } catch {
      return "";
    }
  }

  /**
   * Build the engine prompt: user text followed by one context block per
   * mention chip (skipping providers with no data).
   */
  async composePromptWithMentions(text: string, chips: MentionChip[]): Promise<string> {
    const blocks: string[] = [];
    for (const chip of chips) {
      const block = await this.resolveMentionContext(chip);
      if (block) {
        blocks.push(block);
      }
    }
    if (blocks.length === 0) {
      return text;
    }
    return `${text}\n\n${blocks.join("\n\n")}`;
  }

  /**
   * Extract real file attachments from image chips (browser-tab
   * screenshots). The engine's session.prompt accepts
   * PromptInput.files: [{uri, name, description}] — a PNG on disk is read
   * by the engine as an image part, so the agent literally sees it.
   * Chips whose file is missing/unreadable are skipped (never fabricated).
   */
  extractFileAttachments(chips: MentionChip[]): FileAttachment[] {
    const out: FileAttachment[] = [];
    // Defense in depth (QA-BROWSERTAB-01 P2): the filePath round-trips
    // through the untrusted webview, so only files inside our own capture
    // directory may become attachments — never an arbitrary host path.
    const captureDir = path.resolve(browserCaptureDir());
    const prefix = captureDir + path.sep;
    for (const chip of chips) {
      if (!isMentionChip(chip)) continue;
      const p = chip.payload;
      if (p.case !== "imageContext") continue;
      const abs = path.resolve(p.filePath);
      if (!abs.startsWith(prefix)) continue;
      try {
        const stat = fs.statSync(abs);
        if (!stat.isFile() || stat.size === 0 || stat.size > 15 * 1024 * 1024) continue;
      } catch {
        continue;
      }
      out.push({
        uri: `file://${abs}`,
        name: path.basename(abs),
        description: p.label,
      });
    }
    return out;
  }
}

function dedupeById(items: MentionItem[]): MentionItem[] {
  const seen = new Set<string>();
  return items.filter((i) => {
    if (seen.has(i.id)) {
      return false;
    }
    seen.add(i.id);
    return true;
  });
}

function relFromUri(uri: string): string {
  try {
    return relPath(vscode.Uri.parse(uri).fsPath);
  } catch {
    return "";
  }
}

function uriToPath(uri: string): string | undefined {
  try {
    const u = vscode.Uri.parse(uri);
    return u.scheme === "file" ? u.fsPath : undefined;
  } catch {
    return undefined;
  }
}

async function readTextFile(abs: string, cap: number): Promise<string | undefined> {
  // Curation restored (user directive 2026-10-19 refined): an @-mentioned
  // file sends a focused 60k-char head, not megabytes — this is a big part
  // of why the agent stays sharp. The 100MB read guard (anti-freeze) stays.
  try {
    const stat = await vscode.workspace.fs.stat(vscode.Uri.file(abs));
    if (stat.type !== vscode.FileType.File || stat.size > 100 * 1024 * 1024) {
      return undefined;
    }
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(abs));
    const text = Buffer.from(bytes).toString("utf8");
    return text.length > cap ? text.slice(0, cap) + "\n…(truncated)" : text;
  } catch {
    return undefined;
  }
}

async function folderTree(abs: string): Promise<string> {
  const lines: string[] = [];
  const walk = async (dir: string, prefix: string, depth: number): Promise<void> => {
    if (depth > 3 || lines.length >= FOLDER_TREE_ENTRIES) {
      return;
    }
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir));
    } catch {
      return;
    }
    entries.sort(([a], [b]) => a.localeCompare(b));
    for (const [name, type] of entries) {
      if (name.startsWith(".") || name === "node_modules") {
        continue;
      }
      if (lines.length >= FOLDER_TREE_ENTRIES) {
        break;
      }
      lines.push(`${prefix}${name}${type === vscode.FileType.Directory ? "/" : ""}`);
      if (type === vscode.FileType.Directory) {
        await walk(path.join(dir, name), `${prefix}  `, depth + 1);
      }
    }
  };
  await walk(abs, "", 0);
  if (lines.length >= FOLDER_TREE_ENTRIES) {
    lines.push("…(truncated)");
  }
  return lines.join("\n");
}

function findTerminalText(
  service: TerminalService,
  name: string,
): { name: string; text: string } | undefined {
  for (const term of vscode.window.terminals) {
    if ((term.name || "Terminal") === name) {
      return service.getTerminalText(term);
    }
  }
  return undefined;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
