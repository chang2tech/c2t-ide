/**
 * ProjectRulesService — Cursor-style .mdc project rules for the agent chat.
 *
 * Parity spec: docs/rea/parity-rules-mcp.md §A.
 *
 * - Discovers `**\/.cursor/rules/**\/*.mdc` in every workspace folder (nested
 *   .cursor/rules dirs supported for monorepos).
 * - Watches for changes and refreshes live.
 * - On every agent-chat submit (Cursor's onBeforeSubmitChat), buildInjection()
 *   produces the rules block (Cursor's writeRulesEntry() equivalent) that is
 *   merged into the agent request.
 *
 * SCOPE (parity spec §A6): rules apply to Agent Chat ONLY. They are NOT
 * applied to the Cmd+K inline prompt and do NOT affect Tab completion.
 * This service is only ever consulted from ComposerDataService (agent chat);
 * no other submit path exists in this extension.
 */

import * as vscode from "vscode";
import * as path from "path";
import {
  ParsedRule,
  RulesBlock,
  buildRulesBlock,
  getRulesForFiles,
  normalizeRelPath,
  parseMdcFile,
  ruleAppliesToEnv,
  CURRENT_ENVIRONMENT,
} from "./projectRules";

const RULES_GLOB = "**/.cursor/rules/**/*.mdc";

export class ProjectRulesService implements vscode.Disposable {
  private rules: ParsedRule[] = [];
  private watchers: vscode.FileSystemWatcher[] = [];
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  /** Fires whenever the discovered rule set changes. */
  readonly onDidChangeRules = this.changeEmitter.event;

  constructor(private readonly output?: vscode.OutputChannel) {}

  /** (Re)discover all .mdc rules in every workspace folder. */
  async refresh(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const found: ParsedRule[] = [];
    for (const folder of folders) {
      const uris = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder, RULES_GLOB),
      );
      for (const uri of uris) {
        const rule = await this.loadRule(folder, uri);
        if (rule) {
          found.push(rule);
        }
      }
    }
    // Deterministic order: workspace root, then path.
    found.sort((a, b) =>
      a.workspaceRoot === b.workspaceRoot
        ? a.fullPath.localeCompare(b.fullPath)
        : a.workspaceRoot.localeCompare(b.workspaceRoot),
    );
    this.rules = found;
    this.log(`discovered ${found.length} rule(s)`);
    this.changeEmitter.fire();
  }

  private async loadRule(
    folder: vscode.WorkspaceFolder,
    uri: vscode.Uri,
  ): Promise<ParsedRule | null> {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const content = Buffer.from(bytes).toString("utf8");
      const filename = path.basename(uri.fsPath);
      // Split "<root>/.cursor/rules/<internalPath>" for nested-rule scoping.
      const rel = normalizeRelPath(path.relative(folder.uri.fsPath, uri.fsPath));
      const marker = ".cursor/rules/";
      const idx = rel.toLowerCase().lastIndexOf(marker);
      const subdirPath = idx > 0 ? rel.slice(0, idx) : "";
      const internalPath = idx >= 0 ? rel.slice(idx + marker.length) : rel;
      return parseMdcFile(filename, uri.fsPath, folder.uri.fsPath, subdirPath, internalPath, content);
    } catch (err) {
      this.log(`failed to load ${uri.fsPath}: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  /** Start file watchers (call once from extension activation). */
  startWatching(context: vscode.ExtensionContext): void {
    this.stopWatching();
    const folders = vscode.workspace.workspaceFolders ?? [];
    for (const folder of folders) {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(folder, RULES_GLOB),
      );
      const refresh = (): void => {
        void this.refresh().then(undefined, (err: unknown) => this.log(`refresh failed: ${String(err)}`));
      };
      watcher.onDidCreate(refresh);
      watcher.onDidChange(refresh);
      watcher.onDidDelete(refresh);
      this.watchers.push(watcher);
      context.subscriptions.push(watcher);
    }
  }

  private stopWatching(): void {
    for (const w of this.watchers) {
      w.dispose();
    }
    this.watchers = [];
  }

  /** All discovered rules (a copy). */
  getRules(): ParsedRule[] {
    return [...this.rules];
  }

  /**
   * Look up a single rule by file name or stem (e.g. "fastapi" or
   * "fastapi.mdc"), case-insensitive. This is the on-demand fetch path for
   * agent-requested rules listed in <available-rules>.
   */
  getRuleByName(name: string): ParsedRule | undefined {
    const want = name.trim().toLowerCase().replace(/\.mdc$/i, "");
    return this.rules.find((r) => {
      const stem = r.filename.toLowerCase().replace(/\.mdc$/i, "");
      return stem === want;
    });
  }

  /**
   * Rules whose globs match the given workspace-relative file paths
   * (Cursor's getRulesForFiles). Exported for the read-path and future UI.
   */
  getRulesForFiles(relPaths: string[]): ParsedRule[] {
    return getRulesForFiles(
      this.rules.filter((r) => ruleAppliesToEnv(r, CURRENT_ENVIRONMENT)),
      relPaths,
    );
  }

  /**
   * Workspace-relative paths forming the current context for auto-attach:
   * the active editor's file plus any workspace-relative paths that appear
   * verbatim in the prompt.
   */
  getContextFiles(prompt: string): string[] {
    const files = new Set<string>();
    const active = vscode.window.activeTextEditor?.document.uri;
    if (active && active.scheme === "file") {
      const folder = vscode.workspace.getWorkspaceFolder(active);
      if (folder) {
        files.add(normalizeRelPath(path.relative(folder.uri.fsPath, active.fsPath)));
      }
    }
    // Paths mentioned in the prompt (e.g. pasted by the user).
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const root = folder.uri.fsPath;
      const candidates = prompt.match(/[\w.\-@/]+(?:\/[\w.\-@]+)+/g) ?? [];
      for (const c of candidates) {
        const cleaned = c.replace(/^@/, "");
        try {
          const abs = path.resolve(root, cleaned);
          if (abs.startsWith(root + path.sep)) {
            files.add(normalizeRelPath(path.relative(root, abs)));
          }
        } catch {
          // Ignore unresolvable candidates.
        }
      }
    }
    return [...files];
  }

  /**
   * Cursor's writeRulesEntry() equivalent. Called on EVERY agent-chat submit
   * (onBeforeSubmitChat) — the returned text is merged into the agent request.
   * Never called from Cmd+K or Tab paths (those do not exist here / never
   * consult this service) — parity spec §A6.
   */
  buildInjection(prompt: string, mode?: string): RulesBlock {
    return buildRulesBlock(this.rules, {
      contextFiles: this.getContextFiles(prompt),
      prompt,
      mode,
      env: CURRENT_ENVIRONMENT,
    });
  }

  private log(message: string): void {
    this.output?.appendLine(`[ide-agent][rules] ${message}`);
  }

  dispose(): void {
    this.stopWatching();
    this.changeEmitter.dispose();
  }
}
