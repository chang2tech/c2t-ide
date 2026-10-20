import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { WorktreeService } from "./worktreeService";
import type { ComposerDataService } from "./composerDataService";
import {
  emptyMru,
  mruRankOf,
  parseSkillFrontmatter,
  recordMru,
  type SlashItem,
  type SlashItemType,
  type SlashMru,
} from "./slashRegistry";
import {
  LOOP_SKILL_CONTENT,
  LOOP_SKILL_DESCRIPTION,
  LOOP_SKILL_KEYWORDS,
  LOOP_SKILL_NAME,
} from "./loopSkill";
import {
  buildSubagentInvokeMacro,
  getBuiltinSubagent,
} from "./builtinSubagents";

/**
 * SlashCommandService — Cursor `/` slash-command parity.
 *
 * Spec: docs/rea/parity-slash-commands.md
 *
 * Built-ins (§2.1): /worktree, /apply-worktree, /delete-worktree, /best-of-n,
 * /summarize, /create-skill, /migrate-to-skills, /multitask, /loop.
 * Cloud-only (/in-cloud, /autopilot, /babysit) are honestly reported as
 * unavailable — no silent stubs.
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

export interface SlashCommandDef {
  name: string;
  description: string;
  argumentHint?: string;
  source: "builtin" | "workspace" | "personal";
  keywords?: string[];
  aliases?: string[];
}

export interface CustomSlashCommand extends SlashCommandDef {
  source: "workspace" | "personal";
  filePath: string;
  content: string;
}

/** A skill surfaced as /<name> (spec §2.4). */
export interface SkillSlashItem {
  name: string;
  description: string;
  filePath: string;
  content: string;
  /** disable-model-invocation: menu-only, never auto-pulled by the model. */
  menuOnly: boolean;
  /**
   * GAPS-46D (agent-custom-modes): optional `icon` / `color` frontmatter
   * fields that style the custom mode's badge (docs.cursor.com/agent/prompting).
   */
  icon?: string;
  color?: string;
}

const MAX_COMMAND_FILE_BYTES = 100 * 1024 * 1024; // user directive 2026-10-19: no artificial limits
const MAX_COMMAND_DEPTH = 10;

/** Skill directories scanned (spec §2.4), workspace + personal. */
function skillDirs(): string[] {
  const dirs: string[] = [];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    dirs.push(path.join(folder.uri.fsPath, ".cursor", "skills"));
    dirs.push(path.join(folder.uri.fsPath, ".agents", "skills"));
  }
  dirs.push(path.join(os.homedir(), ".cursor", "skills"));
  dirs.push(path.join(os.homedir(), ".agents", "skills"));
  return dirs;
}

/** Recursively collect SKILL.md files (depth ≤ 10). */
function collectSkillFiles(dir: string, depth: number, out: string[]): void {
  if (depth > MAX_COMMAND_DEPTH) {
    return;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip the usual heavy/irrelevant dirs.
      if (entry.name === "node_modules" || entry.name === ".git") {
        continue;
      }
      collectSkillFiles(full, depth + 1, out);
    } else if (entry.isFile() && /^SKILL\.md$/i.test(entry.name)) {
      out.push(full);
    }
  }
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "task";
}

/** Recursively collect *.md/*.txt files (depth ≤ 10). */
function collectCommandFiles(dir: string, depth: number, out: string[]): void {
  if (depth > MAX_COMMAND_DEPTH) {
    return;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectCommandFiles(full, depth + 1, out);
    } else if (entry.isFile() && /\.(md|txt)$/i.test(entry.name)) {
      out.push(full);
    }
  }
}

export class SlashCommandService {
  private readonly disposables: vscode.Disposable[] = [];
  private customCommands: CustomSlashCommand[] = [];
  private skills: SkillSlashItem[] = [];
  private mru: SlashMru = emptyMru();
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCommands = this.changeEmitter.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly getComposer: () => ComposerDataService | undefined,
  ) {
    // Live refresh when command files change (§3 refresh triggers).
    const watcher = vscode.workspace.createFileSystemWatcher("**/.cursor/commands/*.{md,txt}");
    watcher.onDidChange(() => void this.reloadCustomCommands());
    watcher.onDidCreate(() => void this.reloadCustomCommands());
    watcher.onDidDelete(() => void this.reloadCustomCommands());
    this.disposables.push(watcher);
    // Personal dir lives outside the workspace — watch it via RelativePattern.
    const personalWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(os.homedir(), ".cursor/commands/*.{md,txt}"),
    );
    personalWatcher.onDidChange(() => void this.reloadCustomCommands());
    personalWatcher.onDidCreate(() => void this.reloadCustomCommands());
    personalWatcher.onDidDelete(() => void this.reloadCustomCommands());
    this.disposables.push(personalWatcher);
    // Skills: refresh when SKILL.md files change.
    const skillWatcher = vscode.workspace.createFileSystemWatcher("**/{.cursor,.agents}/skills/**/SKILL.md");
    skillWatcher.onDidChange(() => void this.reloadSkills());
    skillWatcher.onDidCreate(() => void this.reloadSkills());
    skillWatcher.onDidDelete(() => void this.reloadSkills());
    this.disposables.push(skillWatcher);
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
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
        // /loop — recurring skill execution. Binary evidence (Cursor 3.25.9
        // slashMenuData.js @18202214):
        // loop:{searchKeywords:["Repeat","Recurring","Interval","Periodic"]}.
        // Description is docs-sourced (cursor.com/docs: "Recurring skill
        // execution"); the binary entry carries no description. The daemon
        // mechanism (LOOP_PROTECTED_SKILL_NAMES + protectLoopSkillDescription)
        // lives in ./loopSkill.ts.
        name: LOOP_SKILL_NAME,
        description: LOOP_SKILL_DESCRIPTION,
        source: "builtin",
        keywords: [...LOOP_SKILL_KEYWORDS],
      },
      {
        name: "multitask",
        description: "Run subtasks in parallel, each in its own git worktree",
        source: "builtin",
        keywords: ["parallel", "tasks", "multitask", "worktree"],
      },
      {
        // DEV-GAPS-40 (subagent-builtin): Cursor's built-in subagents
        // (docs/rea/deep-docs-all.md: "Built-in: explore (codebase search),
        // browser (browser automation via MCP)"). Invoke via `/name`
        // (Cursor's invoke syntax) — run() below expands to the subagent
        // invoke macro; the engine resolves the agent id server-side.
        name: "explore",
        description:
          "Delegate to the built-in explore subagent (codebase search)",
        argumentHint: "<task>",
        source: "builtin",
        keywords: ["explore", "codebase", "search", "subagent"],
      },
      {
        name: "browser",
        description:
          "Delegate to the built-in browser subagent (browser automation via MCP)",
        argumentHint: "<task>",
        source: "builtin",
        keywords: ["browser", "automation", "mcp", "subagent"],
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
        // Binary-exact keywords (Cursor 3.25.9 slashMenuData.js @18200750):
        // autopilot:{searchKeywords:["PR","CI","Comments","Merge"]}.
        keywords: ["PR", "CI", "Comments", "Merge"],
      },
      {
        // Cursor lists `babysit` as its own slash-menu entry with the same
        // keywords as autopilot (slashMenuData.js @18200750), and maps the
        // two as aliases (HAh: e==="autopilot"?["babysit"] @18190628).
        name: "babysit",
        description: "Let a cloud agent take over the PR (requires IDE Code cloud)",
        source: "builtin",
        keywords: ["PR", "CI", "Comments", "Merge"],
      },
    ];
  }

  /** Load custom commands from workspace + personal dirs (spec §2.2, §3). */
  async reloadCustomCommands(): Promise<void> {
    const found: CustomSlashCommand[] = [];
    const seen = new Set<string>(); // case-insensitive dedup, first wins

    const folders = vscode.workspace.workspaceFolders ?? [];
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
    for (const dir of skillDirs()) {
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
          // GAPS-46D (agent-custom-modes): badge styling from frontmatter.
          ...(fm.icon !== undefined ? { icon: fm.icon } : {}),
          ...(fm.color !== undefined ? { color: fm.color } : {}),
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
        await vscode.commands.executeCommand("ide.worktreeCommand");
        return {};
      case "apply-worktree":
        await vscode.commands.executeCommand("ide.applyWorktree");
        return {};
      case "delete-worktree":
        await vscode.commands.executeCommand("ide.deleteWorktree");
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
      case "multitask": {
        // DEV-MULTITASK: entrypoint "slash" — Cursor's `/multitask` slash
        // (spec §4.1: `A==="multitask" && startMultitasking({entrypoint:"slash"})`).
        const composer = this.getComposer();
        if (!composer) {
          void vscode.window.showErrorMessage("IDE Agent: /multitask — chat is not available.");
          return {};
        }
        composer.modes.setMode("multitask");
        if (args.trim()) {
          // Submit the args as the orchestration request; the multitask
          // branch of runTurn picks up the real fan-out.
          composer.submit(args.trim());
        }
        // No args: just switch mode — the next submit in multitask mode
        // starts the orchestration.
        return {};
      }
      case "loop": {
        // /loop — built-in recurring-skill invocation. Same prompt-macro
        // treatment as §2.4 skills: the loop skill content is prepended to
        // the prompt as structured context (see ./loopSkill.ts for the
        // binary evidence and the HONEST-DIVERGENCE note on the content).
        const argSuffix = args.trim() ? `\n\nArguments: ${args.trim()}` : "";
        return { macro: `<skill name="${LOOP_SKILL_NAME}">\n${LOOP_SKILL_CONTENT}${argSuffix}\n</skill>` };
      }
      case "explore":
      case "browser": {
        // DEV-GAPS-40 (subagent-builtin): `/name` invoke syntax for Cursor's
        // built-in subagents (docs/rea/deep-docs-all.md). Prompt-macro
        // treatment (§5): the macro names the builtin agent; the model
        // dispatches the engine's subagent tool with that agent id. The
        // engine resolves "explore" out of the box (builtin); "browser"
        // resolves once a browser-capable agent is configured (see
        // builtinSubagents.ts HONEST-DIVERGENCE).
        const def = getBuiltinSubagent(lower);
        if (!def) {
          void vscode.window.showWarningMessage(`IDE Agent: unknown slash command /${name}.`);
          return {};
        }
        return { macro: buildSubagentInvokeMacro(def.name, args) };
      }
      case "in-cloud":
      case "autopilot":
      case "babysit":
        // Cloud-only by design — honest capability message, not a stub.
        void vscode.window.showInformationMessage(
          `IDE Agent: /${lower} needs the IDE Code cloud backend, which is not connected in this build. ` +
            `Local alternative: use /worktree + /best-of-n for parallel isolated runs.`,
          "OK",
        );
        return {};
      default:
        void vscode.window.showWarningMessage(`IDE Agent: unknown slash command /${name}.`);
        return {};
    }
  }

  /**
   * /best-of-n — run the same task in N parallel worktrees (§2.1).
   * Each run gets its own worktree; the user picks the winner and merges
   * with /apply-worktree. Compares only — does NOT merge back.
   */
  private async bestOfN(args: string): Promise<void> {
    const service = new WorktreeService();
    const repoRoot = await service.getRepoRoot();
    if (!repoRoot) {
      void vscode.window.showErrorMessage("IDE Agent: /best-of-n needs an open git repository.");
      return;
    }
    const task =
      args.trim() ||
      (await vscode.window.showInputBox({
        prompt: "/best-of-n — describe the task to run in parallel",
        placeHolder: "e.g. refactor the auth module to use sessions",
      }));
    if (!task) {
      return;
    }
    const nPick = await vscode.window.showQuickPick(["2", "3", "4", "5"], {
      placeHolder: "How many parallel runs?",
    });
    if (!nPick) {
      return;
    }
    const n = parseInt(nPick, 10);
    const slug = slugify(task);
    const created: string[] = [];
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `/best-of-n — creating ${n} worktrees…` },
      async () => {
        for (let i = 1; i <= n; i++) {
          const branch = `bestofn/${slug}-${i}`;
          try {
            const wt = await service.create(repoRoot, service.resolveWorktreePath(repoRoot, branch), branch);
            created.push(wt.path);
          } catch (err) {
            void vscode.window.showErrorMessage(
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
    await vscode.env.clipboard.writeText(task);
    const open = await vscode.window.showInformationMessage(
      `IDE Agent: /best-of-n created ${created.length} worktrees. Task copied to clipboard — ` +
        `open each worktree, paste the task into the agent, then pick the winner and /apply-worktree.`,
      "Open worktrees",
    );
    if (open === "Open worktrees") {
      for (const p of created) {
        await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(p), { forceNewWindow: true });
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
      void vscode.window.showErrorMessage("IDE Agent: /summarize — chat is not available.");
      return;
    }
    const bubbles = composer.bubbles.getAllInOrder();
    const transcript = bubbles
      .filter((b) => b.text && b.text.trim())
      .map((b) => `${b.role === "human" ? "User" : b.role === "assistant" ? "Assistant" : b.role}: ${b.text.trim()}`)
      .join("\n\n");
    if (!transcript) {
      void vscode.window.showInformationMessage("IDE Agent: /summarize — nothing to summarize yet.");
      return;
    }
    if (composer.isRunning) {
      void vscode.window.showWarningMessage("IDE Agent: /summarize — wait for the current turn to finish first.");
      return;
    }
    const confirm = await vscode.window.showInformationMessage(
      `IDE Agent: /summarize will condense ${bubbles.length} messages into a summary. Continue?`,
      "Summarize",
      "Cancel",
    );
    if (confirm !== "Summarize") {
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
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      void vscode.window.showErrorMessage("IDE Agent: /create-skill needs an open workspace folder.");
      return;
    }
    const name = await vscode.window.showInputBox({
      prompt: "/create-skill — skill name (lowercase, hyphens)",
      placeHolder: "e.g. review-pr",
      validateInput: (v) =>
        /^[a-z0-9][a-z0-9-]*$/.test(v.trim()) ? undefined : "Use lowercase letters, digits and hyphens.",
    });
    if (!name) {
      return;
    }
    const description = await vscode.window.showInputBox({
      prompt: "/create-skill — one-line description (when should the agent use this skill?)",
      placeHolder: "e.g. Review pull requests for security issues",
    });
    if (description === undefined) {
      return;
    }
    const content = await vscode.window.showInputBox({
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
      void vscode.window.showErrorMessage(
        `IDE Agent: failed to save skill — ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    const open = await vscode.window.showInformationMessage(`IDE Agent: skill "${name.trim()}" created.`, "Open SKILL.md");
    if (open === "Open SKILL.md") {
      const doc = await vscode.workspace.openTextDocument(file);
      await vscode.window.showTextDocument(doc);
    }
  }

  /**
   * /migrate-to-skills — convert eligible rules and commands to skills (§2.1).
   * Converts dynamic rules (alwaysApply: false, no globs) and user/workspace
   * slash commands, preserving explicit-invocation behavior.
   */
  private async migrateToSkills(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      void vscode.window.showErrorMessage("IDE Agent: /migrate-to-skills needs an open workspace folder.");
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
      void vscode.window.showInformationMessage(
        "IDE Agent: /migrate-to-skills — nothing eligible found (no workspace commands, dynamic rules, or .cursorrules).",
      );
      return;
    }
    const pick = await vscode.window.showQuickPick(
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
        void vscode.window.showErrorMessage(
          `IDE Agent: failed to migrate ${c.from} — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    void vscode.window.showInformationMessage(`IDE Agent: /migrate-to-skills converted ${done} item(s) to skills.`);
  }
}
