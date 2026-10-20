/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Migrated from extensions/ide-agent/src/services/mentionService.ts (CAT-B, vscode→DI)
//
// vscode API → core mapping used here (per docs/rea/ext-api-audit-2026-10-19.md §3):
//   workspace.workspaceFolders            → IWorkspaceContextService.getWorkspace().folders
//   workspace.findFiles                   → ISearchService.fileSearch ({ type: QueryType.File })
//   workspace.fs.readDirectory            → IFileService.resolve (children)
//   workspace.fs.stat / readFile          → IFileService.stat / readFile
//   window.visibleTextEditors + tabGroups → IEditorGroupsService.groups (+ active editor first)
//   window.terminals                      → ITerminalService.instances (ITerminalInstance.title)
//   workspace.textDocuments               → IModelService.getModels()
//   commands.executeCommand("vscode.executeWorkspaceSymbolProvider")
//                                         → getWorkspaceSymbols() (workbench/contrib/search)
//   commands.executeCommand("vscode.executeDocumentSymbolProvider")
//                                         → ILanguageFeaturesService.documentSymbolProvider
//                                           (ordered per model; no command-string indirection)
//   env.clipboard.readText                → IClipboardService.readText
//   vscode.Uri / vscode.Range / FileType  → URI / (core Range not needed here) / FileType
//                                           (vs/platform/files/common/files)
//   Extension's TerminalService/ProjectRulesService (optional ctor params)
//                                         → required DI deps: ITerminalComposerService
//                                           (./terminalService.js) + IProjectRulesService
//                                           (./projectRulesService.js) + ICodebaseIndexService
//
// The module-level providers became private methods built in the constructor;
// pure helpers (git, dedupe, escaping) stay module-level. `mentionMatch`
// now comes from the migrated agents contrib
// (../../agents/common/mentionMatch.js).
//
// PARITY EVIDENCE STATUS (rule: ~/AGENTS.md "KHÔNG BỊA ĐẶT", 2026-10-19):
//   COMMUNITY-CORROBORATED (not REA): @-mentions for files/folders/symbols/
//     terminal are a user-visible Cursor feature. Internal dispatch names
//     cited below (getMentionItems, publishUnscopedFullMentionItems,
//     getMentionFileRecencyData, "Cursor's fenced rawText") have NO evidence
//     and are marked UNKNOWN inline — do not treat them as verified Cursor
//     internals.

import * as path from "path";
import * as fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { URI } from '../../../../base/common/uri.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { ICodeEditor, isCodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { DocumentSymbol } from '../../../../editor/common/languages.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IEditorGroupsService } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { ISearchService, QueryType } from '../../../../workbench/services/search/common/search.js';
import { getWorkspaceSymbols } from '../../../../workbench/contrib/search/common/search.js';
import { ITerminalInstance, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { ICodebaseIndexService } from "../common/codebaseIndexService.js";
import {
  MentionChip,
  MentionItem,
  MentionKind,
  MENTION_ITEM_CAP,
  isMentionChip,
  matchesMentionQuery,
  normalizeMentionQuery,
  parseMentionScope,
} from "../../agents/common/mentionMatch.js";
import { ITerminalComposerService } from "../common/terminalService.js";
import { IProjectRulesService } from "../common/projectRulesService.js";
import { withSafeGitArgs } from "../common/gitSanitize.js";
import { browserCaptureDir } from "./browser/chromium.js";


/** Context attachment caps. */

/**
 * A file attachment for the engine prompt (mirrors PromptInput.FileAttachment:
 * {uri, name, description}). Used for browser-tab screenshots — the engine
 * reads the PNG as an image part.
 */
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

async function gitDiff(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    // DEV-GAPS-14 `ext-git-sanitize`: URL credentials stripped, safe `-c`
    // configs forced before the subcommand (verbatim per Cursor evidence).
    const { stdout } = await execFileAsync("git", withSafeGitArgs(args), { cwd, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
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

/** UNKNOWN: "Cursor's client returns []" — no evidence. This provider
 *  returns [] because doc suggestions are server-provided in OUR design. */
const docsProvider: MentionProvider = {
  kinds: ["doc"],
  async getItems(): Promise<MentionItem[]> {
    return [];
  },
};

/**
 * Past chats: there is no persisted side-chat store in this IDE yet, so the
 * provider honestly returns []. (UNKNOWN: "Cursor's items carry
 *  pastChatSelection" — no evidence.)
 * agentId/name; wire this provider to the side-chat store when it exists.)
 */
const pastChatsProvider: MentionProvider = {
  kinds: ["chat"],
  async getItems(): Promise<MentionItem[]> {
    return [];
  },
};

/**
 * Browser: enables the browser toolset for the turn. (UNKNOWN: "Cursor's
 * browserConnection payload" — no evidence.) The headless browser tools live in
 * browser/mcp-tools.ts; selecting this chip attaches the
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

/** PR diffs: no PR integration exists — honestly empty. */
const prDiffProvider: MentionProvider = {
  kinds: ["git"],
  queryOnly: true,
  async getItems(): Promise<MentionItem[]> {
    return [];
  },
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------


import {
	IMentionService,
	FileAttachment,
} from "../common/mentionService.js";

export class MentionService implements IMentionService {

  declare readonly _serviceBrand: undefined;

  private readonly providers: MentionProvider[];

  constructor(
    @IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
    @IFileService private readonly fileService: IFileService,
    @ISearchService private readonly searchService: ISearchService,
    @IEditorService private readonly editorService: IEditorService,
    @IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
    @ITerminalService private readonly coreTerminalService: ITerminalService,
    @IClipboardService private readonly clipboardService: IClipboardService,
    @IModelService private readonly modelService: IModelService,
    @ILanguageFeaturesService private readonly languageFeaturesService: ILanguageFeaturesService,
    @ITerminalComposerService private readonly terminalComposerService: ITerminalComposerService,
    @IProjectRulesService private readonly projectRulesService: IProjectRulesService,
    @ICodebaseIndexService private readonly codebaseIndexService: ICodebaseIndexService,
  ) {
    this.providers = [
      { kinds: ["file"], getItems: (q) => this.filesItems(q) },
      { kinds: ["folder"], getItems: (q) => this.foldersItems(q) },
      { kinds: ["code"], queryOnly: true, getItems: (q) => this.codeItems(q) },
      docsProvider,
      { kinds: ["terminal"], getItems: (q) => this.terminalsItems(q) },
      pastChatsProvider,
      { kinds: ["git"], getItems: (q) => this.workingDiffItems(q) },
      { kinds: ["branch"], getItems: (q) => this.branchDiffItems(q) },
      browserProvider,
      mcpProvider,
      canvasProvider,
      { kinds: ["clipboard"], getItems: (q) => this.clipboardItems(q) },
      prDiffProvider,
      { kinds: ["codebase"], queryOnly: true, getItems: (q) => this.codebaseItems(q) },
      { kinds: ["cursorRule"], getItems: (q) => this.cursorRuleItems(q) },
    ];
  }

  // ---- workspace helpers -------------------------------------------------

  private workspaceRoot(): string | undefined {
    return this.workspaceContextService.getWorkspace().folders[0]?.uri.fsPath;
  }

  private relPath(fsPath: string): string {
    const root = this.workspaceRoot();
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
  private safeWorkspaceFile(rel: string): string | undefined {
    const root = this.workspaceRoot();
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
  private recentUris(): URI[] {
    const seen = new Set<string>();
    const out: URI[] = [];
    const push = (u: URI | undefined) => {
      if (u && u.scheme === "file" && !seen.has(u.fsPath)) {
        seen.add(u.fsPath);
        out.push(u);
      }
    };
    // Active editor first, then every open editor group (replaces the
    // extension's visibleTextEditors + tabGroups.all ordering).
    const control = this.editorService.activeTextEditorControl;
    const codeEditor: ICodeEditor | undefined = control && isCodeEditor(control) ? control : undefined;
    push(codeEditor?.getModel()?.uri);
    for (const group of this.editorGroupsService.groups) {
      for (const editor of group.editors) {
        push(editor.resource);
      }
    }
    return out;
  }

  private makeFileItem(uri: URI): MentionItem {
    const rel = this.relPath(uri.fsPath);
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

  private relFromUri(uri: string): string {
    try {
      return this.relPath(URI.parse(uri).fsPath);
    } catch {
      return "";
    }
  }

  private uriToPath(uri: string): string | undefined {
    try {
      const u = URI.parse(uri);
      return u.scheme === "file" ? u.fsPath : undefined;
    } catch {
      return undefined;
    }
  }

  private async readTextFile(abs: string, cap: number): Promise<string | undefined> {
    // Curation restored (user directive 2026-10-19 refined): an @-mentioned
    // file sends a focused 60k-char head, not megabytes — this is a big part
    // of why the agent stays sharp. The 100MB read guard (anti-freeze) stays.
    try {
      const uri = URI.file(abs);
      const stat = await this.fileService.stat(uri);
      if (stat.isDirectory || (stat.size ?? 0) > 100 * 1024 * 1024) {
        return undefined;
      }
      const content = await this.fileService.readFile(uri);
      const text = content.value.toString();
      return text.length > cap ? text.slice(0, cap) + "\n…(truncated)" : text;
    } catch {
      return undefined;
    }
  }

  private async folderTree(abs: string): Promise<string> {
    const lines: string[] = [];
    const walk = async (dir: string, prefix: string, depth: number): Promise<void> => {
      if (depth > 3 || lines.length >= FOLDER_TREE_ENTRIES) {
        return;
      }
      let children: { name: string; isDirectory: boolean }[];
      try {
        const stat = await this.fileService.resolve(URI.file(dir));
        children = stat.children ?? [];
      } catch {
        return;
      }
      children.sort((a, b) => a.name.localeCompare(b.name));
      for (const child of children) {
        const name = child.name;
        if (name.startsWith(".") || name === "node_modules") {
          continue;
        }
        if (lines.length >= FOLDER_TREE_ENTRIES) {
          break;
        }
        lines.push(`${prefix}${name}${child.isDirectory ? "/" : ""}`);
        if (child.isDirectory) {
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

  private findTerminalText(name: string): { name: string; text: string } | undefined {
    for (const term of this.coreTerminalService.instances) {
      if ((term.title || "Terminal") === name) {
        return this.terminalComposerService.getTerminalText(term);
      }
    }
    return undefined;
  }

  // ---- providers ---------------------------------------------------------

  private async filesItems(query: string): Promise<MentionItem[]> {
    const items: MentionItem[] = [];
    // Recency-ranked: open editors first. (UNKNOWN: "getMentionFileRecencyData"
    // was presented as Cursor's name — no evidence.)
    for (const uri of this.recentUris()) {
      const item = this.makeFileItem(uri);
      if (matchesMentionQuery(item, query)) {
        items.push(item);
        if (items.length >= MENTION_ITEM_CAP) {
          return items;
        }
      }
    }
    let found: URI[];
    try {
      const complete = await this.searchService.fileSearch({
        type: QueryType.File,
        folderQueries: this.workspaceContextService.getWorkspace().folders.map((f) => ({ folder: f.uri })),
        filePattern: "**/*",
        excludePattern: {
          "**/node_modules/**": true,
          "**/.git/**": true,
          "**/dist/**": true,
          "**/out/**": true,
          "**/build/**": true,
          "**/.vscode-test/**": true,
        },
        maxResults: 100,
      });
      found = complete.results.map((r) => r.resource);
    } catch {
      found = [];
    }
    for (const uri of found) {
      if (items.length >= MENTION_ITEM_CAP) {
        break;
      }
      const item = this.makeFileItem(uri);
      if (items.some((i) => i.id === item.id)) {
        continue;
      }
      if (matchesMentionQuery(item, query)) {
        items.push(item);
      }
    }
    return items;
  }

  private async foldersItems(query: string): Promise<MentionItem[]> {
    const items: MentionItem[] = [];
    const push = (uri: URI) => {
      const rel = this.relPath(uri.fsPath);
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
    for (const wf of this.workspaceContextService.getWorkspace().folders) {
      push(wf.uri);
      // One level of subdirectories (bounded; deep trees go through search).
      try {
        const stat = await this.fileService.resolve(wf.uri);
        for (const child of stat.children ?? []) {
          if (child.isDirectory && !child.name.startsWith(".") && child.name !== "node_modules") {
            push(child.resource);
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
  }

  private async codeItems(query: string): Promise<MentionItem[]> {
    const items: MentionItem[] = [];
    const push = (
      name: string,
      uri: URI,
      startLine: number,
      endLine: number,
      container?: string,
    ) => {
      const rel = this.relPath(uri.fsPath);
      // Fenced rawText: ```path:start:end\n<code>\n``` — code is (UNKNOWN:
      // "Cursor's fenced rawText" — no evidence this matches Cursor's format).
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
      // Core equivalent of vscode.executeWorkspaceSymbolProvider (no
      // command-string indirection — calls the registry directly).
      const symbols = await getWorkspaceSymbols(query);
      for (const entry of symbols ?? []) {
        if (items.length >= MENTION_ITEM_CAP) {
          break;
        }
        const s = entry.symbol;
        const r = s.location.range;
        push(s.name, s.location.uri, r.startLineNumber - 1, r.endLineNumber - 1, s.containerName);
      }
    } catch {
      // Workspace symbol provider unavailable — fall back to open documents.
    }
    if (items.length === 0) {
      for (const model of this.modelService.getModels()) {
        if (model.uri.scheme !== "file" || items.length >= MENTION_ITEM_CAP) {
          continue;
        }
        try {
          // Core equivalent of vscode.executeDocumentSymbolProvider.
          const providers = this.languageFeaturesService.documentSymbolProvider.ordered(model);
          for (const provider of providers) {
            const syms = await provider.provideDocumentSymbols(model, CancellationToken.None);
            const walk = (list: DocumentSymbol[]) => {
              for (const s of list) {
                const r = s.selectionRange;
                push(s.name, model.uri, r.startLineNumber - 1, r.endLineNumber - 1);
                walk(s.children ?? []);
                if (items.length >= MENTION_ITEM_CAP) {
                  return;
                }
              }
            };
            walk(syms ?? []);
            if (items.length >= MENTION_ITEM_CAP) {
              break;
            }
          }
        } catch {
          // Skip documents whose symbols fail.
        }
      }
    }
    return items;
  }

  private async terminalsItems(query: string): Promise<MentionItem[]> {
    const items: MentionItem[] = [];
    for (const term of this.coreTerminalService.instances) {
      // Skip terminals the user hid from the UI (Cursor parity). Core's
      // ITerminalInstance does not expose hideFromUser; the composer's
      // terminal layer tracks visibility — best-effort read keeps the
      // original filter semantics where available.
      const t = term as ITerminalInstance & { hideFromUser?: boolean };
      if (t.hideFromUser) {
        continue;
      }
      const name = term.title || "Terminal";
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
  }

  private async workingDiffItems(query: string): Promise<MentionItem[]> {
    const root = this.workspaceRoot();
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
  }

  private async branchDiffItems(query: string): Promise<MentionItem[]> {
    const root = this.workspaceRoot();
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
      // rawText for this item. (UNKNOWN: "Cursor's rawText" — no evidence
      // this matches Cursor's format.)
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
  }

  private async clipboardItems(query: string): Promise<MentionItem[]> {
    let text = "";
    try {
      text = await this.clipboardService.readText();
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
  }

  private async cursorRuleItems(query: string): Promise<MentionItem[]> {
    const items: MentionItem[] = [];
    for (const rule of this.projectRulesService.getRules()) {
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
  }

  private async codebaseItems(query: string): Promise<MentionItem[]> {
    const q = query.trim();
    if (!q) {
      return [];
    }
    const hits = await this.codebaseIndexService.searchCodebase(q, { limit: 5 });
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
  }

  // ---- service API -------------------------------------------------------

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
   * Implements the mention dispatch (§1.2–1.4 are OUR internal spec sections,
   * not Cursor sources). (UNKNOWN: "getMentionItems" was presented as Cursor's
   * name — no evidence.)
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
    // mcp, files, folders, terminals). (UNKNOWN: "publishUnscopedFullMentionItems"
    // was presented as Cursor's name — no evidence.)
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
   * Resolve a chip to its model-visible context block (spec §3 is OUR
   * internal spec, not a Cursor source). Returns "" when the provider has no
   * data — the
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
          const abs = this.safeWorkspaceFile(this.relFromUri(p.uri)) ?? this.uriToPath(p.uri);
          if (!abs) {
            return "";
          }
          const content = await this.readTextFile(abs, FILE_CONTEXT_CHARS);
          if (content === undefined) {
            return "";
          }
          return `<context type="file" name="${escapeAttr(this.relPath(abs))}">\n${content}\n</context>`;
        }
        case "folderSelection": {
          const abs = this.safeWorkspaceFile(this.relFromUri(p.uri)) ?? this.uriToPath(p.uri);
          if (!abs) {
            return "";
          }
          const tree = await this.folderTree(abs);
          return `<context type="folder" name="${escapeAttr(this.relPath(abs))}">\n${tree}\n</context>`;
        }
        case "codeSelection": {
          const abs = this.safeWorkspaceFile(this.relFromUri(p.uri)) ?? this.uriToPath(p.uri);
          if (!abs) {
            return "";
          }
          const content = await this.readTextFile(abs, FILE_CONTEXT_CHARS);
          if (content === undefined) {
            return "";
          }
          const lines = content.split("\n");
          const slice = lines.slice(p.startLine, p.endLine + 1).join("\n");
          // Fenced rawText: ```path:start:end\n<code>\n``` (UNKNOWN: no
          // evidence this matches Cursor's format).
          return `\`\`\`${p.filePath}:${p.startLine + 1}:${p.endLine + 1}\n${slice}\n\`\`\``;
        }
        case "terminalFile": {
          const t = this.findTerminalText(p.terminalName);
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
          const hits = await this.codebaseIndexService.searchCodebase(p.query, { limit: 12 });
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
        default:
          return "";
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
      // P3 (QA-MODELPICKER Round-B): filePath round-trips through the
      // untrusted webview — guard the type before path.resolve.
      if (typeof p.filePath !== "string") continue;
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

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
