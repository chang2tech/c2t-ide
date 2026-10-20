/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Migrated from extensions/ide-agent/src/services/slashCommandService.ts (CAT-B, vscode→DI)
//
// vscode API → core mapping used here (per docs/rea/ext-api-audit-2026-10-19.md §3):
//   workspace.workspaceFolders              → IWorkspaceContextService.getWorkspace().folders
//   workspace.createFileSystemWatcher       → IFileService.watch + onDidFilesChange (glob-filtered;
//                                             createWatcher is non-recursive only — used for the
//                                             flat personal ~/.cursor/commands dir)
//   commands.executeCommand("ide.*")        → ICommandService.executeCommand("composer.*")
//                                             (extension-owned `ide.*` ids renamed to the
//                                             `composer.*` layer — registered by a future
//                                             composer contribution)
//   window.show*Message                     → INotificationService
//   window.showInputBox                     → IQuickInputService.input
//   window.showQuickPick                    → IQuickInputService.pick
//   window.withProgress                     → IProgressService.withProgress
//   env.clipboard.writeText                 → IClipboardService.writeText
//   commands.executeCommand("vscode.openFolder", uri, {forceNewWindow:true})
//                                           → IHostService.openWindow([{ folderUri }], { forceNewWindow: true })
//   workspace.openTextDocument + window.showTextDocument
//                                           → IEditorService.openEditor({ resource })
//   vscode.ExtensionContext (ctor)          → DROPPED (stored but never used in the original)
//   vscode.EventEmitter / vscode.Disposable → Emitter / Disposable (base/common)
//
// Choice prompts ("Open worktrees", "Summarize", "Open SKILL.md") used
// showInformationMessage with buttons → IDialogService.confirm.
//
// PARITY EVIDENCE STATUS (rule: ~/AGENTS.md "KHÔNG BỊA ĐẶT", 2026-10-19):
//   UNKNOWN: the "/" command palette concept and the .cursor/commands +
//     .cursor/skills directory layout have NO REA/binary/docs evidence cited
//     in this file — every "parity" claim below (§2.x refs are OUR internal
//     spec, not Cursor sources) is aspirational, not verified. Do not treat
//     them as verified Cursor behavior.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { URI } from "../../../../base/common/uri.js";
import { Emitter } from "../../../../base/common/event.js";
import { Disposable } from "../../../../base/common/lifecycle.js";
import { extUri } from "../../../../base/common/resources.js";
import { match as globMatch } from "../../../../base/common/glob.js";
import { ICommandService } from "../../../../platform/commands/common/commands.js";
import { INotificationService } from "../../../../platform/notification/common/notification.js";
import { IDialogService } from "../../../../platform/dialogs/common/dialogs.js";
import { IQuickInputService } from "../../../../platform/quickinput/common/quickInput.js";
import { IProgressService, ProgressLocation } from "../../../../platform/progress/common/progress.js";
import { IClipboardService } from "../../../../platform/clipboard/common/clipboardService.js";
import { IFileService } from "../../../../platform/files/common/files.js";
import { IWorkspaceContextService, IWorkspaceFolder } from "../../../../platform/workspace/common/workspace.js";
import { IHostService } from "../../../services/host/browser/host.js";
import { IEditorService } from "../../../../workbench/services/editor/common/editorService.js";
import { WorktreeService } from "./worktreeService.js";
import {
	ISlashCommandService,
	SlashCommandDef,
	CustomSlashCommand,
	SkillSlashItem,
} from "../common/slashCommandService.js";

import type { ComposerDataService } from "./composerDataService.js";
import {
  emptyMru,
  mruRankOf,
  parseSkillFrontmatter,
  recordMru,
  type SlashItem,
  type SlashItemType,
  type SlashMru,
} from "../common/slashRegistry.js";

/**
 * SlashCommandService — `/` slash commands. (UNKNOWN: "Cursor `/` slash-command
 * parity" — no REA/docs evidence; §2.x refs are OUR internal spec.)
 *
 * Spec: docs/rea/parity-slash-commands.md
 *
 * Built-ins (§2.1): /worktree, /apply-worktree, /delete-worktree, /best-of-n,
 * /summarize, /create-skill, /migrate-to-skills. Cloud-only (/in-cloud,
 * /autopilot) are honestly reported as unavailable — no silent stubs.
 *
 * Custom file-based commands (§2.2): <workspace>/.cursor/commands/*.md|*.txt
 * and ~/.cursor/commands/*.md|*.txt. 100 MB cap (raised per user directive
 * 2026-10-19 — no artificial limits), recursion depth ≤ 10,
 * case-insensitive dedup (first source wins), live file watching.
 * Multi-root workspaces prefix the folder name (§2.2).
 *
 * Skills surfaced as /<name> (§2.4): .cursor/skills, .agents/skills
 * (workspace + personal), parsed from SKILL.md frontmatter.
 * disable-model-invocation ⇒ menu-only (never auto-pulled).
 *
 * Palette ranking (§3, §4.2): per-type MRU capped at 5, global cross-type
 * order capped at 15, persisted in extension globalState by the host.
 *
 * Execution semantics (§5): commands are prompt macros — on submit the
 * command content is prepended to the prompt as structured context.
 */

const MAX_COMMAND_FILE_BYTES = 100 * 1024 * 1024; // user directive 2026-10-19: no artificial limits
const MAX_COMMAND_DEPTH = 10;

/** Skill directories scanned (spec §2.4), workspace + personal. */
function skillDirs(folders: IWorkspaceFolder[]): string[] {
	const dirs: string[] = [];
	for (const folder of folders) {
		dirs.push(path.join(folder.uri.fsPath, ".cursor", "skills"));
		dirs.push(path.join(folder.uri.fsPath, ".agents", "skills"));
	}
	dirs.push(path.join(os.homedir(), ".cursor", "skills"));
	dirs.push(path.join(os.homedir(), ".agents", "skills"));
	return dirs;
}

/** Recursively collect *.md/*.txt command files (spec §2.2). Depth-capped; missing dirs are fine. */
function collectCommandFiles(dir: string, depth: number, files: string[]): void {
	if (depth > MAX_COMMAND_DEPTH) {
		return;
	}
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return; // missing/unreadable dir — fine
	}
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			collectCommandFiles(full, depth + 1, files);
		} else if (entry.isFile() && /\.(md|txt)$/i.test(entry.name)) {
			files.push(full);
		}
	}
}

/** Recursively collect SKILL.md files (spec §2.4). Depth-capped; missing dirs are fine. */
function collectSkillFiles(dir: string, depth: number, files: string[]): void {
	if (depth > MAX_COMMAND_DEPTH) {
		return;
	}
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return; // missing/unreadable dir — fine
	}
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			collectSkillFiles(full, depth + 1, files);
		} else if (entry.isFile() && entry.name.toLowerCase() === "skill.md") {
			files.push(full);
		}
	}
}

/** Slugify free text for branch names and generated skill names. */
function slugify(s: string): string {
	return (
		s
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 40) || "task"
	);
}

export class SlashCommandService extends Disposable implements ISlashCommandService {

  declare readonly _serviceBrand: undefined;

  private customCommands: CustomSlashCommand[] = [];
  private skills: SkillSlashItem[] = [];
  private mru: SlashMru = emptyMru();
  private readonly changeEmitter = new Emitter<void>();
  readonly onDidChangeCommands = this.changeEmitter.event;

  constructor(
    @IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
    @IFileService private readonly fileService: IFileService,
    @ICommandService private readonly commandService: ICommandService,
    @INotificationService private readonly notificationService: INotificationService,
    @IDialogService private readonly dialogService: IDialogService,
    @IQuickInputService private readonly quickInputService: IQuickInputService,
    @IProgressService private readonly progressService: IProgressService,
    @IClipboardService private readonly clipboardService: IClipboardService,
    @IEditorService private readonly editorService: IEditorService,
    @IHostService private readonly hostService: IHostService,
    /**
     * IDE-CODE: the ExtensionContext param of the original is DROPPED — it was
     * stored but never used. The per-tab composer is supplied by this factory
     * callback (same pattern as the migrated chatTabService).
     */
    private readonly getComposer: () => ComposerDataService | undefined,
  ) {
    super();
    this._register(this.changeEmitter);
    // Live refresh when command files change (§3 refresh triggers).
    // IFileService.createWatcher is non-recursive only, so workspace watching
    // goes through watch() + the shared onDidFilesChange event, filtered to
    // the command/skill globs below.
    for (const folder of this.workspaceContextService.getWorkspace().folders) {
      this._register(this.fileService.watch(folder.uri, {
        recursive: true,
        excludes: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/out/**'],
      }));
    }
    this._register(this.fileService.onDidFilesChange((e) => {
      const changed = [...e.rawAdded, ...e.rawUpdated, ...e.rawDeleted];
      const rels = changed.map((resource) => {
        const folder = this.workspaceContextService.getWorkspaceFolder(resource);
        return folder ? extUri.relativePath(folder.uri, resource) : undefined;
      });
      if (rels.some((rel) => !!rel && globMatch('**/.cursor/commands/*.{md,txt}', rel))) {
        void this.reloadCustomCommands();
      }
      if (rels.some((rel) => !!rel && globMatch('**/{.cursor,.agents}/skills/**/SKILL.md', rel))) {
        void this.reloadSkills();
      }
    }));
    // Personal dir lives outside the workspace — watch it directly
    // (non-recursive; the commands dir is flat).
    const personalDir = URI.file(path.join(os.homedir(), '.cursor', 'commands'));
    void this.fileService.exists(personalDir).then((exists) => {
      if (exists && !this.disposed) {
        const watcher = this.fileService.createWatcher(personalDir, { recursive: false, excludes: [] });
        this._register(watcher.onDidChange(() => void this.reloadCustomCommands()));
        this._register(watcher);
      }
    });
  }

  private disposed = false;

  override dispose(): void {
    this.disposed = true;
    super.dispose();
  }

  /** Built-in command registry (spec §2.1). */
  getBuiltins(): SlashCommandDef[] {
    return [
      {
        name: "worktree",
        description: "Start a task in a separate git checkout (isolated worktree)",
        source: "builtin",
        keywords: ["isolated", "checkout", "branch", "parallel"],
        aliases: ["wt"],
      },
      {
        name: "apply-worktree",
        description: "Bring worktree changes into the main checkout",
        source: "builtin",
        keywords: ["merge", "worktree", "checkout"],
      },
      {
        name: "delete-worktree",
        description: "Remove an isolated worktree checkout",
        source: "builtin",
        keywords: ["remove", "worktree", "cleanup"],
      },
      {
        name: "best-of-n",
        description: "Run the same task in N parallel worktrees to compare approaches",
        argumentHint: "<task>",
        source: "builtin",
        keywords: ["compare", "parallel", "models", "approaches"],
      },
      {
        name: "summarize",
        description: "Summarize the conversation to reduce context usage",
        source: "builtin",
        keywords: ["compress", "context", "summary"],
        aliases: ["compress"],
      },
      {
        name: "create-skill",
        description: "Walk through creating a new agent skill",
        source: "builtin",
        keywords: ["skill", "new", "wizard"],
      },
      {
        name: "migrate-to-skills",
        description: "Convert eligible rules and commands to skills automatically",
        source: "builtin",
        keywords: ["skill", "migrate", "convert", "rules"],
      },
      {
        name: "in-cloud",
        description: "Run the next task as a cloud subagent (requires IDE Code cloud)",
        source: "builtin",
        keywords: ["cloud"],
      },
      {
        name: "autopilot",
        description: "Let a cloud agent take over the PR (requires IDE Code cloud)",
        source: "builtin",
        keywords: ["cloud", "pr"],
      },
    ];
  }

  /** Load custom commands from workspace + personal dirs (spec §2.2, §3). */
  async reloadCustomCommands(): Promise<void> {
    const found: CustomSlashCommand[] = [];
    const seen = new Set<string>(); // case-insensitive dedup, first wins

    const folders = this.workspaceContextService.getWorkspace().folders;
    const multiRoot = folders.length > 1;
    const dirs: Array<{ dir: string; source: "workspace" | "personal"; folderName?: string }> = [];
    for (const folder of folders) {
      dirs.push({
        dir: path.join(folder.uri.fsPath, ".cursor", "commands"),
        source: "workspace",
        folderName: folder.name,
      });
    }
    dirs.push({ dir: path.join(os.homedir(), ".cursor", "commands"), source: "personal" });

    for (const { dir, source, folderName } of dirs) {
      const files: string[] = [];
      collectCommandFiles(dir, 0, files);
      for (const file of files) {
        let stat: fs.Stats;
        try {
          stat = fs.statSync(file);
        } catch {
          continue;
        }
        if (stat.size > MAX_COMMAND_FILE_BYTES) {
          console.warn(`[ide-agent] slash command skipped (>100MB): ${file}`);
          continue;
        }
        let content: string;
        try {
          content = fs.readFileSync(file, "utf8");
        } catch {
          continue;
        }
        if (!content.trim()) {
          continue; // empty files skipped
        }
        const baseName = path.basename(file).replace(/\.(md|txt)$/i, "");
        // §2.2 multi-root: prefix the folder name in multi-folder workspaces.
        const displayName = multiRoot && source === "workspace" && folderName ? `${folderName}/${baseName}` : baseName;
        const key = displayName.toLowerCase();
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        found.push({
          name: displayName,
          description: `Custom command from ${source === "workspace" ? "workspace" : "personal"} .cursor/commands`,
          source,
          filePath: file,
          content: content.trim(),
        });
      }
    }
    this.customCommands = found;
    this.changeEmitter.fire();
  }

  getCustomCommands(): CustomSlashCommand[] {
    return [...this.customCommands];
  }

  /** Load skills surfaced as /<name> (spec §2.4). */
  async reloadSkills(): Promise<void> {
    const found: SkillSlashItem[] = [];
    const seen = new Set<string>(); // case-insensitive dedup, first wins
    for (const dir of skillDirs(this.workspaceContextService.getWorkspace().folders)) {
      const files: string[] = [];
      collectSkillFiles(dir, 0, files);
      for (const file of files) {
        let raw: string;
        try {
          raw = fs.readFileSync(file, "utf8");
        } catch {
          continue;
        }
        if (!raw.trim()) {
          continue;
        }
        const fm = parseSkillFrontmatter(raw);
        const name = (fm.name || path.basename(path.dirname(file))).trim();
        if (!name) {
          continue;
        }
        const key = name.toLowerCase();
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        found.push({
          name,
          description: fm.description || `Skill from ${path.dirname(file)}`,
          filePath: file,
          content: raw.trim(),
          menuOnly: fm.disableModelInvocation === true,
        });
      }
    }
    this.skills = found;
    this.changeEmitter.fire();
  }

  getSkills(): SkillSlashItem[] {
    return [...this.skills];
  }

  /** Full palette list: built-ins first, then workspace, then personal, then skills. */
  getAll(): SlashCommandDef[] {
    return [...this.getBuiltins(), ...this.customCommands];
  }

  /** Resolve the palette item type for an exact (case-insensitive) name. */
  resolveType(name: string): SlashItemType | undefined {
    const lower = name.toLowerCase();
    if (this.getBuiltins().some((b) => b.name.toLowerCase() === lower)) {
      return "builtin";
    }
    if (this.customCommands.some((c) => c.name.toLowerCase() === lower)) {
      return "command";
    }
    if (this.skills.some((s) => s.name.toLowerCase() === lower)) {
      return "skill";
    }
    return undefined;
  }

  /** Find any command/skill by exact case-insensitive name. */
  findCommand(name: string): SlashCommandDef | SkillSlashItem | undefined {
    const lower = name.toLowerCase();
    return (
      this.getBuiltins().find((b) => b.name.toLowerCase() === lower) ??
      this.customCommands.find((c) => c.name.toLowerCase() === lower) ??
      this.skills.find((s) => s.name.toLowerCase() === lower)
    );
  }

  /**
   * Parse a leading `/name args…` command from submitted text (spec §4.1:
   * longest command-name prefix followed by whitespace/end; our names never
   * contain spaces so the token must equal a known name). Returns null when
   * the text is not a slash invocation.
   */
  parseLeadingCommand(text: string): { name: string; args: string; rest: string } | null {
    const m = /^\s*\/([A-Za-z0-9_/-]+)([\s\S]*)$/.exec(text);
    if (!m) {
      return null;
    }
    const token = m[1].toLowerCase();
    const found = this.findCommand(token);
    if (!found) {
      return null;
    }
    const lines = m[2].split("\n");
    return {
      name: found.name,
      args: (lines[0] ?? "").trim(),
      rest: lines.slice(1).join("\n").trim(),
    };
  }

  /** Record a palette use in the MRU (spec §3: 5/type, 15 global). */
  recordUse(name: string): void {
    const type = this.resolveType(name);
    if (!type) {
      return;
    }
    this.mru = recordMru(this.mru, type, name);
    this.changeEmitter.fire();
  }

  serializeMru(): string {
    return JSON.stringify(this.mru);
  }

  restoreMru(json: string | undefined): void {
    if (!json) {
      return;
    }
    try {
      const parsed = JSON.parse(json) as SlashMru;
      if (parsed && typeof parsed === "object" && Array.isArray(parsed.global) && parsed.byType && typeof parsed.byType === "object") {
        this.mru = parsed;
      }
    } catch {
      // Corrupt stored MRU — start fresh rather than crashing activation.
    }
  }

  /**
   * Palette items for the webview, ordered for the empty-query display:
   * MRU-ranked items first (spec §4.2 ranking signals), then definition order.
   * The webview applies fuzzy ranking for non-empty queries.
   */
  getPaletteItems(): SlashItem[] {
    const items: SlashItem[] = [];
    for (const b of this.getBuiltins()) {
      items.push({
        name: b.name,
        description: b.description,
        argumentHint: b.argumentHint,
        source: "builtin",
        type: "builtin",
        keywords: b.keywords,
        aliases: b.aliases,
      });
    }
    for (const c of this.customCommands) {
      items.push({
        name: c.name,
        description: c.description,
        source: c.source,
        type: "command",
      });
    }
    for (const s of this.skills) {
      items.push({
        name: s.name,
        description: s.description,
        source: "skill",
        type: "skill",
        menuOnly: s.menuOnly,
      });
    }
    // Case-insensitive dedup, first wins (spec §2.2/§3 load order).
    const seen = new Set<string>();
    const deduped = items.filter((i) => {
      const key = i.name.toLowerCase();
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
    for (const item of deduped) {
      item.mruRank = mruRankOf(this.mru, item.type, item.name);
    }
    deduped.sort((a, b) => {
      const ra = a.mruRank ?? Number.MAX_SAFE_INTEGER;
      const rb = b.mruRank ?? Number.MAX_SAFE_INTEGER;
      return ra - rb; // Array.prototype.sort is stable — definition order kept on ties.
    });
    return deduped;
  }

  /**
   * Dispatch a slash command. Returns the prompt-macro content for custom
   * commands (the caller inserts it into the composer input); built-ins
   * execute their side effects directly.
   */
  async run(name: string, args: string): Promise<{ macro?: string }> {
    const lower = name.toLowerCase();
    const custom = this.customCommands.find((c) => c.name.toLowerCase() === lower);
    if (custom) {
      // Prompt macro (§5): content is prepended to the prompt as context.
      const argSuffix = args.trim() ? `\n\nArguments: ${args.trim()}` : "";
      return { macro: `<slash-command name="${custom.name}">\n${custom.content}${argSuffix}\n</slash-command>` };
    }
    const skill = this.skills.find((s) => s.name.toLowerCase() === lower);
    if (skill) {
      // Skills invoked as /<name> (§2.4): same prompt-macro treatment.
      const argSuffix = args.trim() ? `\n\nArguments: ${args.trim()}` : "";
      return { macro: `<skill name="${skill.name}">\n${skill.content}${argSuffix}\n</skill>` };
    }
    switch (lower) {
      case "worktree":
        await this.commandService.executeCommand("composer.worktreeCommand");
        return {};
      case "apply-worktree":
        await this.commandService.executeCommand("composer.applyWorktree");
        return {};
      case "delete-worktree":
        await this.commandService.executeCommand("composer.deleteWorktree");
        return {};
      case "best-of-n":
        await this.bestOfN(args);
        return {};
      case "summarize":
        await this.summarize();
        return {};
      case "create-skill":
        await this.createSkill();
        return {};
      case "migrate-to-skills":
        await this.migrateToSkills();
        return {};
      case "in-cloud":
      case "autopilot":
        // Cloud-only by design — honest capability message, not a stub.
        void this.notificationService.info(
          `IDE Agent: /${lower} needs the IDE Code cloud backend, which is not connected in this build. ` +
            `Local alternative: use /worktree + /best-of-n for parallel isolated runs.`,
        );
        return {};
      default:
        void this.notificationService.warn(`IDE Agent: unknown slash command /${name}.`);
        return {};
    }
  }

  /**
   * /best-of-n — run the same task in N parallel worktrees (§2.1).
   * Each run gets its own worktree; the user picks the winner and merges
   * with /apply-worktree. Compares only — does NOT merge back.
   */
  private async bestOfN(args: string): Promise<void> {
    const service = new WorktreeService(this.workspaceContextService, this.hostService);
    const repoRoot = await service.getRepoRoot();
    if (!repoRoot) {
      void this.notificationService.error("IDE Agent: /best-of-n needs an open git repository.");
      return;
    }
    const task =
      args.trim() ||
      (await this.quickInputService.input({
        prompt: "/best-of-n — describe the task to run in parallel",
        placeHolder: "e.g. refactor the auth module to use sessions",
      }));
    if (!task) {
      return;
    }
    const nPick = await this.quickInputService.pick(
      ["2", "3", "4", "5"].map((label) => ({ label })),
      { placeHolder: "How many parallel runs?" },
    );
    if (!nPick) {
      return;
    }
    const n = parseInt(nPick.label, 10);
    const slug = slugify(task);
    const created: string[] = [];
    await this.progressService.withProgress(
      { location: ProgressLocation.Notification, title: `/best-of-n — creating ${n} worktrees…` },
      async () => {
        for (let i = 1; i <= n; i++) {
          const branch = `bestofn/${slug}-${i}`;
          try {
            const wt = await service.create(repoRoot, service.defaultWorktreePath(repoRoot, branch), branch);
            created.push(wt.path);
          } catch (err) {
            void this.notificationService.error(
              `IDE Agent: failed to create worktree ${i}/${n} — ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      },
    );
    if (created.length === 0) {
      return;
    }
    // Copy the task so the user can paste it into the agent in each window.
    await this.clipboardService.writeText(task);
    const { confirmed } = await this.dialogService.confirm({
      message: `IDE Agent: /best-of-n created ${created.length} worktrees. Task copied to clipboard — ` +
        `open each worktree, paste the task into the agent, then pick the winner and /apply-worktree.`,
      primaryButton: 'Open worktrees',
    });
    if (confirmed) {
      for (const p of created) {
        await this.hostService.openWindow([{ folderUri: URI.file(p) }], { forceNewWindow: true });
      }
    }
  }

  /**
   * /summarize — condense the conversation to reduce context (§2.1).
   * Builds a transcript from the bubble store and asks the engine to
   * summarize it; the summary replaces the visible history.
   */
  private async summarize(): Promise<void> {
    const composer = this.getComposer();
    if (!composer) {
      void this.notificationService.error("IDE Agent: /summarize — chat is not available.");
      return;
    }
    const bubbles = composer.bubbles.getAllInOrder();
    const transcript = bubbles
      .filter((b) => b.text && b.text.trim())
      .map((b) => `${b.role === "human" ? "User" : b.role === "assistant" ? "Assistant" : b.role}: ${b.text.trim()}`)
      .join("\n\n");
    if (!transcript) {
      void this.notificationService.info("IDE Agent: /summarize — nothing to summarize yet.");
      return;
    }
    if (composer.isRunning) {
      void this.notificationService.warn("IDE Agent: /summarize — wait for the current turn to finish first.");
      return;
    }
    const { confirmed } = await this.dialogService.confirm({
      message: `IDE Agent: /summarize will condense ${bubbles.length} messages into a summary. Continue?`,
      primaryButton: 'Summarize',
    });
    if (!confirmed) {
      return;
    }
    composer.submit(
      `<slash-command name="summarize">\n` +
        `Summarize the conversation below into a compact context note (decisions, open tasks, key file changes). ` +
        `After summarizing, continue working from the summary.\n\n${transcript}\n</slash-command>`,
    );
  }

  /**
   * /create-skill — wizard that walks the user through naming, describing
   * and saving a new skill (§2.1). Saves to .cursor/skills/<name>/SKILL.md.
   */
  private async createSkill(): Promise<void> {
    const folder = this.workspaceContextService.getWorkspace().folders[0];
    if (!folder) {
      void this.notificationService.error("IDE Agent: /create-skill needs an open workspace folder.");
      return;
    }
    const name = await this.quickInputService.input({
      prompt: "/create-skill — skill name (lowercase, hyphens)",
      placeHolder: "e.g. review-pr",
      validateInput: async (v) =>
        /^[a-z0-9][a-z0-9-]*$/.test(v.trim()) ? undefined : "Use lowercase letters, digits and hyphens.",
    });
    if (!name) {
      return;
    }
    const description = await this.quickInputService.input({
      prompt: "/create-skill — one-line description (when should the agent use this skill?)",
      placeHolder: "e.g. Review pull requests for security issues",
    });
    if (description === undefined) {
      return;
    }
    const content = await this.quickInputService.input({
      prompt: "/create-skill — instructions for the agent (the skill body)",
      placeHolder: "e.g. Check for SQL injection, XSS, …",
    });
    if (content === undefined) {
      return;
    }
    const dir = path.join(folder.uri.fsPath, ".cursor", "skills", name.trim());
    const file = path.join(dir, "SKILL.md");
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        file,
        `---\nname: ${name.trim()}\ndescription: ${description.trim()}\n---\n\n${content.trim()}\n`,
        "utf8",
      );
    } catch (err) {
      void this.notificationService.error(
        `IDE Agent: failed to save skill — ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    const { confirmed: openSkill } = await this.dialogService.confirm({
      message: `IDE Agent: skill "${name.trim()}" created.`,
      primaryButton: 'Open SKILL.md',
    });
    if (openSkill) {
      await this.editorService.openEditor({ resource: URI.file(file) });
    }
  }

  /**
   * /migrate-to-skills — convert eligible rules and commands to skills (§2.1).
   * Converts dynamic rules (alwaysApply: false, no globs) and user/workspace
   * slash commands, preserving explicit-invocation behavior.
   */
  private async migrateToSkills(): Promise<void> {
    const folder = this.workspaceContextService.getWorkspace().folders[0];
    if (!folder) {
      void this.notificationService.error("IDE Agent: /migrate-to-skills needs an open workspace folder.");
      return;
    }
    const root = folder.uri.fsPath;
    const skillsDir = path.join(root, ".cursor", "skills");
    const candidates: Array<{ name: string; description: string; body: string; from: string }> = [];

    // 1. Workspace slash commands → skills (explicit invocation preserved).
    for (const cmd of this.customCommands.filter((c) => c.source === "workspace")) {
      candidates.push({
        name: slugify(cmd.name),
        description: `Slash command /${cmd.name} migrated to a skill`,
        body: cmd.content,
        from: `command /${cmd.name}`,
      });
    }

    // 2. Dynamic rules: .cursor/rules/*.mdc with alwaysApply=false and no globs.
    const rulesDir = path.join(root, ".cursor", "rules");
    let ruleFiles: string[] = [];
    try {
      ruleFiles = fs.readdirSync(rulesDir).filter((f) => f.endsWith(".mdc"));
    } catch {
      // no rules dir — fine
    }
    for (const f of ruleFiles) {
      const full = path.join(rulesDir, f);
      let raw: string;
      try {
        raw = fs.readFileSync(full, "utf8");
      } catch {
        continue;
      }
      const fm = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
      const head = fm ? fm[1] : "";
      const body = fm ? fm[2].trim() : raw.trim();
      const alwaysApply = /alwaysApply\s*:\s*true/i.test(head);
      const hasGlobs = /globs\s*:/i.test(head);
      if (!alwaysApply && !hasGlobs && body) {
        const base = path.basename(f, ".mdc");
        candidates.push({
          name: slugify(base),
          description: `Rule "${base}" migrated to a skill (was dynamically attached)`,
          body,
          from: `rule ${f}`,
        });
      }
    }

    // 3. Legacy .cursorrules (project-level, always-on → still eligible as a skill).
    const cursorrules = path.join(root, ".cursorrules");
    if (fs.existsSync(cursorrules)) {
      try {
        const body = fs.readFileSync(cursorrules, "utf8").trim();
        if (body) {
          candidates.push({
            name: "project-rules",
            description: "Project .cursorrules migrated to a skill",
            body,
            from: ".cursorrules",
          });
        }
      } catch {
        // ignore
      }
    }

    if (candidates.length === 0) {
      void this.notificationService.info(
        "IDE Agent: /migrate-to-skills — nothing eligible found (no workspace commands, dynamic rules, or .cursorrules).",
      );
      return;
    }
    const pick = await this.quickInputService.pick(
      candidates.map((c) => ({ label: c.name, description: c.from, detail: c.description })),
      { placeHolder: `/migrate-to-skills — ${candidates.length} eligible item(s). Select to convert:`, canPickMany: true },
    );
    if (!pick || pick.length === 0) {
      return;
    }
    let done = 0;
    for (const p of pick) {
      const c = candidates.find((x) => x.name === p.label);
      if (!c) {
        continue;
      }
      const dir = path.join(skillsDir, c.name);
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
          path.join(dir, "SKILL.md"),
          `---\nname: ${c.name}\ndescription: ${c.description}\n---\n\n${c.body}\n`,
          "utf8",
        );
        done++;
      } catch (err) {
        void this.notificationService.error(
          `IDE Agent: failed to migrate ${c.from} — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    void this.notificationService.info(`IDE Agent: /migrate-to-skills converted ${done} item(s) to skills.`);
  }
}
