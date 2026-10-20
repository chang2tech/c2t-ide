/**
 * slash.ts — TUI slash-command handlers for the agent CLI.
 *
 * Every Cursor CLI slash command with a local mapping is implemented here
 * with REAL behavior. Where the engine or the filesystem cannot support a
 * command, the handler prints an honest message instead of inventing data.
 *
 * The handlers are engine-agnostic: everything they need comes through
 * SlashRuntime, so tests can drive them with a fake runtime.
 */

import type { AgentMode, TurnRenderHooks, TurnResult } from "./tui";
import type {
  EngineModelInfo,
  PermissionDecision,
  PermissionRequest,
} from "./engine";
import { loadRegistry, findSession } from "./sessions";
import {
  addDirToWorkspace,
  activeWorkspaceName,
  listWorkspaceNames,
  loadWorkspace,
  saveWorkspaceAs,
  workspaceDirs,
} from "./workspaces";
import {
  CONFIG_KEYS,
  formatAgentConfig,
  loadAgentConfig,
  setAgentConfigValue,
} from "./agent-config";

/** One completed (or interrupted) main-session turn, for /rewind and /context. */
export interface TurnLogEntry {
  /** 1-based turn number within this TUI run. */
  n: number;
  /** First ~120 chars of the user prompt (preview only). */
  promptPreview: string;
  at: number;
  endKind: "succeeded" | "failed" | "interrupted";
  toolCalls: number;
}

export interface SlashCommand {
  cmd: string;
  arg: string;
}

/** What the main loop should do after a slash command. */
export type SlashAction = "continue" | "exit";

/**
 * Everything a slash-command handler needs. Implemented by the TUI layer
 * (tui.ts) on top of TuiDeps + the engine client.
 */
export interface SlashRuntime {
  out: NodeJS.WritableStream;
  err: NodeJS.WritableStream;
  getMode(): AgentMode;
  setMode(mode: AgentMode): Promise<void>;
  /**
   * Optional timed confirmation for user-typed /plan|/ask: resolves true on
   * an explicit "yes" within 15s, false on timeout (auto-reject). When
   * absent, the mode switch proceeds without confirmation.
   */
  confirmModeSwitch?(mode: "plan" | "ask"): Promise<boolean>;
  setModel(name: string): Promise<string | undefined>;
  statusLine(): string;
  autoDecidePermission(req: PermissionRequest): Promise<PermissionDecision | undefined>;
  promptPermission(req: PermissionRequest): Promise<PermissionDecision>;
  runTurnWith(
    text: string,
    render: TurnRenderHooks,
    promptPermission: (req: PermissionRequest) => Promise<PermissionDecision>,
  ): Promise<TurnResult>;
  /**
   * Run one turn on a throwaway read-only session, then delete it.
   * The main session's history is never touched.
   */
  runReadOnlyTurn(
    text: string,
    render: TurnRenderHooks,
    promptPermission: (req: PermissionRequest) => Promise<PermissionDecision>,
  ): Promise<TurnResult>;
  /** Run fn with the TUI's turn-active flag set (Ctrl+C aborts it). */
  withTurnActive<T>(fn: () => Promise<T>): Promise<T>;
  currentSessionID(): string | undefined;
  /** Branch the current session; attaches the new session to the current mode. */
  forkCurrentSession(): Promise<{ from: string; to: string }>;
  /**
   * Verify `id` against the engine and attach it to the current mode.
   * Throws when the engine no longer has the session.
   */
  attachSession(id: string): Promise<string>;
  /** Record the current session in the persistent registry. */
  detachCurrentSession(): Promise<{ id: string; title: string }>;
  /** Raw GET /api/config — used to probe for an MCP server list. */
  getEngineConfig(): Promise<unknown>;
  listModels(): Promise<EngineModelInfo[]>;
  /**
   * Compact the current session via the engine (POST /api/session/:id/compact).
   * Throws when there is no session yet or the engine call fails.
   * Returns the compacted session id.
   */
  compactCurrentSession(): Promise<string>;
  getAutoReview(): boolean;
  setAutoReview(on: boolean): void;
  getTrust(): boolean;
  setTrust(on: boolean): void;
  /** Skills discovered for this working directory (backs /skills and /skill). */
  listSkills(): Array<{ name: string; description: string }>;
  /** Resolve one skill by name; the caller stages its content one-shot. */
  attachSkill(name: string): Promise<{ content?: string; error?: string }>;
  /** Stage skill content to prepend to the next main-session turn (one-shot). */
  setPendingSkill(name: string, content: string): void;
  /** In-memory log of this TUI session's main-session turns. */
  getTurnLog(): TurnLogEntry[];
}

export const SLASH_HELP = [
  "Slash commands:",
  "  /plan                  switch to plan mode (15s confirm, auto-rejects)",
  "  /ask                   switch to ask mode (15s confirm, auto-rejects)",
  "  /model <name>          switch the session model",
  "  /opus /composer /fast  model shortcuts (matched against the engine model list)",
  "  /btw <question>        read-only side question; main history untouched",
  "  /context               context-window usage estimate (local; engine exposes no API)",
  "  /fork                  branch the conversation into a copy (aliases: /branch /duplicate)",
  "  /rewind [n]            list the turn timeline (aliases: /undo /restore; restore unsupported)",
  "  /usage                 local usage stats (no cloud billing — local engine)",
  "  /summarize             compact the session to free context (aliases: /compact /compress)",
  "  /resume [id]           list saved sessions and attach one",
  "  /detach                save the session to the registry and exit (keeps the session)",
  "  /auto-review [on|off]  toggle auto-approving reviewable tools",
  "  /mcp                   list MCP servers (if the engine exposes any)",
  "  /add-dir <path>        add a directory to the active workspace",
  "  /save-workspace <name> snapshot the active workspace's directories",
  "  /load-workspace <name> activate a workspace and cd into it",
  "  /config [get|set]      show/edit agent config (~/.ide-code/agent-config.json)",
  "  /trust [on|off]        toggle the workspace-trust marker (no local trust gate)",
  "  /skills                list discovered skills (.cursor/.claude/.agents/.codex)",
  "  /skill <name>          attach a skill's SKILL.md to your next message (one-shot)",
  "  /status                show session id, mode, and model",
  "  /sandbox               not supported by the local engine",
  "  /help                  this list",
  "  /exit                  quit (aliases: /quit)",
].join("\n");

/** Parse "/cmd arg" lines; returns undefined for non-slash input. */
export function parseSlashCommand(line: string): SlashCommand | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("/")) {
    return undefined;
  }
  const space = trimmed.indexOf(" ");
  if (space < 0) {
    return { cmd: trimmed.slice(1).toLowerCase(), arg: "" };
  }
  return {
    cmd: trimmed.slice(1, space).toLowerCase(),
    arg: trimmed.slice(space + 1).trim(),
  };
}

function formatAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) {
    return `${s}s ago`;
  }
  const m = Math.floor(s / 60);
  if (m < 60) {
    return `${m}m ago`;
  }
  const h = Math.floor(m / 60);
  if (h < 48) {
    return `${h}h ago`;
  }
  return `${Math.floor(h / 24)}d ago`;
}

function formatClock(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function estimateTokens(chars: number): number {
  return Math.round(chars / 4);
}

/** "842" -> "~842 chars (~210 tokens)" */
export function formatContextEstimate(chars: number): string {
  return `~${chars.toLocaleString("en-US")} chars (~${estimateTokens(chars).toLocaleString("en-US")} tokens)`;
}

function parseOnOff(arg: string): boolean | undefined | "toggle" {
  const a = arg.trim().toLowerCase();
  if (a === "") {
    return "toggle";
  }
  if (["on", "1", "true", "yes", "enable", "enabled"].includes(a)) {
    return true;
  }
  if (["off", "0", "false", "no", "disable", "disabled"].includes(a)) {
    return false;
  }
  return undefined;
}

/**
 * Pull an MCP server list out of the engine's /api/config response.
 * The engine documents no MCP endpoint; this defensively recognizes the
 * common shapes ({ mcp: {...} }, { mcpServers: [...] / {...} }) and groups
 * entries by their `scope` (falling back to `type`, then "default").
 * Returns undefined when nothing recognizable is present.
 */
export function extractMcpServers(
  cfg: unknown,
): Array<{ name: string; scope: string }> | undefined {
  if (!cfg || typeof cfg !== "object") {
    return undefined;
  }
  const obj = cfg as Record<string, unknown>;
  const section = obj.mcp ?? obj.mcpServers ?? obj.servers;
  if (!section || typeof section !== "object") {
    return undefined;
  }
  const entries: Array<{ name: string; scope: string }> = [];
  const push = (name: string, def: unknown) => {
    let scope = "default";
    if (def && typeof def === "object") {
      const d = def as Record<string, unknown>;
      if (typeof d.scope === "string" && d.scope.length > 0) {
        scope = d.scope;
      } else if (typeof d.type === "string" && d.type.length > 0) {
        scope = d.type;
      }
    }
    entries.push({ name, scope });
  };
  if (Array.isArray(section)) {
    for (const item of section) {
      if (item && typeof item === "object") {
        const d = item as Record<string, unknown>;
        push(
          typeof d.name === "string" && d.name.length > 0 ? d.name : "(unnamed)",
          item,
        );
      } else if (typeof item === "string") {
        push(item, undefined);
      }
    }
  } else {
    for (const [name, def] of Object.entries(section as Record<string, unknown>)) {
      push(name, def);
    }
  }
  return entries;
}

async function handleBtw(sc: SlashCommand, rt: SlashRuntime): Promise<void> {
  if (!sc.arg) {
    rt.err.write("usage: /btw <question> — ask a read-only side question\n");
    return;
  }
  rt.out.write("(asking on a throwaway read-only session — main history untouched)\n");
  const render: TurnRenderHooks = {
    onTextDelta: (delta) => rt.out.write(delta),
    onToolCall: (info) => rt.err.write(`\n[tool ${info.name} — ${info.status}]\n`),
    onNotice: (msg) => rt.err.write(`${msg}\n`),
  };
  const result = await rt.withTurnActive(() =>
    rt.runReadOnlyTurn(sc.arg, render, (req) => rt.promptPermission(req)),
  );
  rt.out.write("\n");
  if (result.endKind === "failed") {
    const msg =
      result.failure instanceof Error
        ? result.failure.message
        : typeof result.failure === "string"
          ? result.failure
          : "turn failed";
    rt.err.write(`error: side question failed: ${msg}\n`);
  } else if (result.endKind === "interrupted") {
    rt.err.write("error: side question interrupted\n");
  }
}

function handleContext(rt: SlashRuntime): void {
  const log = rt.getTurnLog();
  const sid = rt.currentSessionID() ?? "(no session yet)";
  const succeeded = log.filter((t) => t.endKind === "succeeded").length;
  const failed = log.filter((t) => t.endKind === "failed").length;
  const interrupted = log.filter((t) => t.endKind === "interrupted").length;
  const toolCalls = log.reduce((n, t) => n + t.toolCalls, 0);
  const inputChars = log.reduce((n, t) => n + t.promptPreview.length, 0);
  rt.out.write(
    [
      "context window — local estimate (the engine exposes no usage API):",
      `  session:     ${sid}`,
      `  turns:       ${log.length} (${succeeded} succeeded, ${failed} failed, ${interrupted} interrupted)`,
      `  tool calls:  ${toolCalls}`,
      `  user input:  ${formatContextEstimate(inputChars)} at ~4 chars/token`,
      "  /btw side questions are excluded — they run on a discarded read-only session.",
    ].join("\n") + "\n",
  );
}

function handleRewind(sc: SlashCommand, rt: SlashRuntime): void {
  const log = rt.getTurnLog();
  const sid = rt.currentSessionID() ?? "(no session yet)";
  if (sc.arg) {
    rt.err.write(
      `cannot restore to turn ${JSON.stringify(sc.arg)}: the engine exposes no session-restore API.\n`,
    );
    return;
  }
  if (log.length === 0) {
    rt.out.write("no turns yet in this session — nothing to rewind.\n");
    return;
  }
  const lines = [`turn timeline for session ${sid}:`];
  for (const t of log) {
    const tools = t.toolCalls === 1 ? "1 tool call" : `${t.toolCalls} tool calls`;
    lines.push(`  #${t.n}  ${formatClock(t.at)}  ${t.endKind}  ${tools}  "${t.promptPreview}"`);
  }
  lines.push(
    "restore is not supported: the engine exposes no session-restore API, so this timeline is informational only.",
  );
  rt.out.write(lines.join("\n") + "\n");
}

/**
 * /summarize — Cursor: "Free up space in the context window by running
 * `/summarize`. `/compress` remains an alias" (cursor.com/docs/cli/using);
 * the CLI changelog adds: "Renamed from `/compress` to match the IDE;
 * `/compact` and `/compress` remain as aliases, and aliases execute
 * directly." All three spellings dispatch here and execute immediately —
 * the runtime asks the engine to compact the current session.
 */
async function handleSummarize(rt: SlashRuntime): Promise<void> {
  try {
    const sid = await rt.compactCurrentSession();
    rt.out.write(
      `summarized session ${sid} — the engine compacted the conversation to free up context space.\n`,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    rt.err.write(`error: could not summarize the session: ${msg}\n`);
  }
}

function handleUsage(rt: SlashRuntime): void {
  const reg = loadRegistry();
  const log = rt.getTurnLog();
  const toolCalls = log.reduce((n, t) => n + t.toolCalls, 0);
  rt.out.write(
    [
      "usage — local only (no cloud billing; the engine runs on this machine):",
      `  saved sessions:            ${reg.sessions.length} (see /resume)`,
      `  turns this TUI session:    ${log.length}`,
      `  tool calls this TUI run:   ${toolCalls}`,
    ].join("\n") + "\n",
  );
}

function sortedRegistry() {
  return [...loadRegistry().sessions].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
}

async function handleResume(sc: SlashCommand, rt: SlashRuntime): Promise<void> {
  const list = sortedRegistry();
  if (list.length === 0) {
    rt.out.write("no saved sessions yet — save one with /detach (or `agent persist`).\n");
    return;
  }
  let picked = undefined as (typeof list)[number] | undefined;
  if (sc.arg) {
    const byIndex = /^\d+$/.test(sc.arg) ? list[Number(sc.arg) - 1] : undefined;
    picked = byIndex ?? findSession(sc.arg);
    if (!picked) {
      rt.err.write(
        `no saved session matches ${JSON.stringify(sc.arg)} — /resume with no argument lists them.\n`,
      );
      return;
    }
  } else {
    const lines = [`saved sessions (${list.length}):`];
    list.slice(0, 20).forEach((s, i) => {
      const age = formatAge(Date.now() - s.lastUsedAt);
      lines.push(
        `  [${i + 1}] ${s.id.slice(0, 12)}  "${s.title}"  ${s.mode}  used ${age}`,
      );
    });
    if (list.length > 20) {
      lines.push(`  …and ${list.length - 20} more`);
    }
    lines.push("/resume <number|id|id-prefix> to attach one");
    rt.out.write(lines.join("\n") + "\n");
    return;
  }
  try {
    const title = await rt.attachSession(picked.id);
    rt.out.write(`resumed session ${picked.id} ("${title}")\n`);
    if (picked.mode && picked.mode !== rt.getMode()) {
      rt.err.write(
        `note: that session was created in ${JSON.stringify(picked.mode)} mode — ` +
          `its server-side permissions still apply in this ${rt.getMode()} view.\n`,
      );
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/not found/i.test(msg)) {
      rt.err.write(
        `the engine no longer has session ${picked.id} (sidecar restarted?) — ` +
          `the registry entry is kept. Error: ${msg}\n`,
      );
    } else {
      rt.err.write(`error: could not resume session: ${msg}\n`);
    }
  }
}

async function handleDetach(rt: SlashRuntime): Promise<SlashAction> {
  try {
    const { id, title } = await rt.detachCurrentSession();
    rt.out.write(
      `session ${id} ("${title}") saved — detached. Reattach later with /resume ${id.slice(0, 8)}.\n`,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    rt.err.write(`error: ${msg}\n`);
    return "continue";
  }
  return "exit";
}

function handleAutoReview(sc: SlashCommand, rt: SlashRuntime): void {
  const want = parseOnOff(sc.arg);
  if (want === undefined) {
    rt.err.write(`usage: /auto-review [on|off] (got ${JSON.stringify(sc.arg)})\n`);
    return;
  }
  const on = want === "toggle" ? !rt.getAutoReview() : want;
  rt.setAutoReview(on);
  rt.out.write(
    `auto-review: ${on ? "on" : "off"} (persisted to ~/.ide-code/agent-config.json; ` +
      `reviewable shell/MCP/fetch tools are ${on ? "auto-approved" : "prompted as usual"})\n`,
  );
}

function handleTrust(sc: SlashCommand, rt: SlashRuntime): void {
  const want = parseOnOff(sc.arg);
  if (want === undefined) {
    rt.err.write(`usage: /trust [on|off] (got ${JSON.stringify(sc.arg)})\n`);
    return;
  }
  const on = want === "toggle" ? !rt.getTrust() : want;
  rt.setTrust(on);
  rt.err.write(
    `trust: ${on ? "on" : "off"} — the local engine has no workspace-trust gate, ` +
      `so this is a recorded preference only (kept for Cursor compatibility).\n`,
  );
}

async function handleMcp(rt: SlashRuntime): Promise<void> {
  let cfg: unknown;
  try {
    cfg = await rt.getEngineConfig();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    rt.err.write(`error: could not read the engine config: ${msg}\n`);
    return;
  }
  const servers = extractMcpServers(cfg);
  if (!servers || servers.length === 0) {
    rt.err.write(
      "no MCP servers listed: the engine's /api/config exposes no MCP server list. " +
        "MCP servers are configured in the engine's own config file, not through this CLI.\n",
    );
    return;
  }
  const byScope = new Map<string, string[]>();
  for (const s of servers) {
    const names = byScope.get(s.scope) ?? [];
    names.push(s.name);
    byScope.set(s.scope, names);
  }
  const lines = [`MCP servers (${servers.length}, from the engine's /api/config):`];
  for (const [scope, names] of [...byScope.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`  [${scope}]`);
    for (const n of names.sort((a, b) => a.localeCompare(b))) {
      lines.push(`    ${n}`);
    }
  }
  rt.out.write(lines.join("\n") + "\n");
}

function handleAddDir(sc: SlashCommand, rt: SlashRuntime): void {
  if (!sc.arg) {
    const dirs = workspaceDirs();
    const lines = [`active workspace: ${activeWorkspaceName()} (${dirs.length} director${dirs.length === 1 ? "y" : "ies"})`];
    for (const d of dirs) {
      lines.push(`  ${d}`);
    }
    lines.push("usage: /add-dir <path>");
    rt.out.write(lines.join("\n") + "\n");
    return;
  }
  const problem = addDirToWorkspace(sc.arg);
  if (problem) {
    rt.err.write(`error: ${problem}\n`);
    return;
  }
  rt.out.write(`added to workspace ${JSON.stringify(activeWorkspaceName())}: ${sc.arg}\n`);
}

function handleSaveWorkspace(sc: SlashCommand, rt: SlashRuntime): void {
  if (!sc.arg) {
    rt.err.write("usage: /save-workspace <name>\n");
    return;
  }
  const problem = saveWorkspaceAs(sc.arg);
  if (problem) {
    rt.err.write(`error: ${problem}\n`);
    return;
  }
  rt.out.write(`workspace ${JSON.stringify(sc.arg)} saved (${workspaceDirs(sc.arg).length} directories).\n`);
}

function handleLoadWorkspace(sc: SlashCommand, rt: SlashRuntime): void {
  if (!sc.arg) {
    const names = listWorkspaceNames();
    rt.out.write(`workspaces: ${names.join(", ")}\nusage: /load-workspace <name>\n`);
    return;
  }
  const res = loadWorkspace(sc.arg);
  if ("error" in res) {
    rt.err.write(`error: ${res.error}\n`);
    return;
  }
  const lines = [`workspace ${JSON.stringify(sc.arg)} active (${res.dirs.length} directories).`];
  if (res.chdirTo) {
    lines.push(`cwd is now ${res.chdirTo}`);
  } else if (res.dirs.length > 0) {
    lines.push(`note: could not cd into ${res.dirs[0]} (missing?) — workspace still active`);
  } else {
    lines.push("note: this workspace has no directories yet — add some with /add-dir <path>");
  }
  rt.out.write(lines.join("\n") + "\n");
}

function handleConfig(sc: SlashCommand, rt: SlashRuntime): void {
  const parts = sc.arg.split(/\s+/).filter((p) => p.length > 0);
  const sub = (parts[0] ?? "").toLowerCase();
  if (sub === "" || sub === "show") {
    rt.out.write(
      formatAgentConfig() +
        "\n\n/config get <key> | /config set <key> <value>\n" +
        `keys: ${CONFIG_KEYS.join(", ")}\n` +
        "note: subagentModel is a recorded preference — the local engine exposes no subagent-model knob today.\n",
    );
    return;
  }
  if (sub === "get") {
    if (!parts[1]) {
      rt.err.write("usage: /config get <key>\n");
      return;
    }
    if (!(CONFIG_KEYS as readonly string[]).includes(parts[1])) {
      rt.err.write(`unknown config key ${JSON.stringify(parts[1])} (known: ${CONFIG_KEYS.join(", ")})\n`);
      return;
    }
    const cfg = loadAgentConfig();
    rt.out.write(`${parts[1]} = ${String(cfg[parts[1] as keyof typeof cfg])}\n`);
    return;
  }
  if (sub === "set") {
    if (!parts[1] || parts.length < 3) {
      rt.err.write("usage: /config set <key> <value>\n");
      return;
    }
    const value = parts.slice(2).join(" ");
    const problem = setAgentConfigValue(parts[1], value);
    if (problem) {
      rt.err.write(`error: ${problem}\n`);
      return;
    }
    rt.out.write(`set ${parts[1]} = ${value} (saved to ~/.ide-code/agent-config.json)\n`);
    return;
  }
  rt.err.write(`usage: /config [show|get <key>|set <key> <value>] (got ${JSON.stringify(sc.arg)})\n`);
}

async function handleModelShortcut(
  sc: SlashCommand,
  rt: SlashRuntime,
  keywords: string[],
  label: string,
): Promise<void> {
  if (!loadAgentConfig().modelSlashCommands) {
    rt.err.write(`/${sc.cmd} is disabled — enable model shortcuts with /config set modelSlashCommands on\n`);
    return;
  }
  let models: EngineModelInfo[];
  try {
    models = await rt.listModels();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    rt.err.write(`error: could not list engine models: ${msg}\n`);
    return;
  }
  const hay = (m: EngineModelInfo) =>
    `${m.id} ${m.modelID} ${m.name} ${m.providerID}`.toLowerCase();
  const match = models.find((m) => keywords.some((k) => hay(m).includes(k)));
  if (!match) {
    const extra =
      label === "fast"
        ? " (the engine exposes no speed or pricing metadata)"
        : "";
    rt.err.write(
      `no model matching ${JSON.stringify(label)} in the engine's model list (${models.length} models)${extra} — use /model <name>\n`,
    );
    return;
  }
  const problem = await rt.setModel(match.modelID);
  if (problem) {
    rt.err.write(`error: ${problem}\n`);
  } else {
    rt.out.write(`model: ${match.modelID} (via /${sc.cmd})\n`);
  }
}

function handleSkillsList(rt: SlashRuntime): void {
  const skills = rt.listSkills();
  if (skills.length === 0) {
    rt.out.write(
      "no skills found (looked in .cursor/skills, .claude/skills, .agents/skills, " +
        ".codex/skills under the project and home directories).\n",
    );
    return;
  }
  const lines = [`skills (${skills.length}):`];
  for (const s of skills) {
    lines.push(`  ${s.name}${s.description ? ` — ${s.description}` : ""}`);
  }
  lines.push("use /skill <name> to attach one to your next message");
  rt.out.write(lines.join("\n") + "\n");
}

async function handleSkill(sc: SlashCommand, rt: SlashRuntime): Promise<void> {
  if (!sc.arg) {
    handleSkillsList(rt);
    return;
  }
  const res = await rt.attachSkill(sc.arg);
  if (res.error || !res.content) {
    rt.err.write(`error: ${res.error ?? "could not resolve that skill"}\n`);
    return;
  }
  const canonical =
    rt.listSkills().find((s) => s.name.toLowerCase() === sc.arg.toLowerCase())?.name ?? sc.arg;
  rt.setPendingSkill(canonical, res.content);
  rt.out.write(`skill "${canonical}" will be attached to your next message (one-shot).\n`);
}

/** Dispatch one parsed slash command. Returns whether the TUI loop should exit. */
export async function handleSlashCommand(
  sc: SlashCommand,
  rt: SlashRuntime,
): Promise<SlashAction> {
  switch (sc.cmd) {
    case "plan":
    case "ask": {
      // Timed mode-switch approval: 15s countdown, auto-rejects when left
      // unattended (matches Cursor).
      if (rt.confirmModeSwitch) {
        const ok = await rt.confirmModeSwitch(sc.cmd);
        if (!ok) {
          rt.err.write(`mode switch to ${sc.cmd} not confirmed — staying in ${rt.getMode()} mode.\n`);
          return "continue";
        }
      }
      await rt.setMode(sc.cmd);
      rt.out.write(`mode: ${sc.cmd} (read-only, enforced by the engine)\n`);
      return "continue";
    }
    case "model":
      if (!sc.arg) {
        rt.err.write("usage: /model <name>\n");
        return "continue";
      }
      {
        const problem = await rt.setModel(sc.arg);
        if (problem) {
          rt.err.write(`error: ${problem}\n`);
        } else {
          rt.out.write(`model: ${sc.arg}\n`);
        }
      }
      return "continue";
    case "opus":
      await handleModelShortcut(sc, rt, ["opus"], "opus");
      return "continue";
    case "composer":
      await handleModelShortcut(sc, rt, ["composer"], "composer");
      return "continue";
    case "fast":
      await handleModelShortcut(sc, rt, ["fast", "flash", "mini", "haiku", "turbo", "nano"], "fast");
      return "continue";
    case "btw":
      await handleBtw(sc, rt);
      return "continue";
    case "context":
      handleContext(rt);
      return "continue";
    case "fork":
    case "branch":
    case "duplicate":
      try {
        const { from, to } = await rt.forkCurrentSession();
        rt.out.write(
          `forked session ${from} → ${to} ("fork of ${from.slice(0, 8)}"; branch point recorded as parentID)\n`,
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        rt.err.write(`error: ${msg}\n`);
      }
      return "continue";
    case "rewind":
    case "undo":
    case "restore":
      handleRewind(sc, rt);
      return "continue";
    case "usage":
      handleUsage(rt);
      return "continue";
    case "summarize":
    case "compact":
    case "compress":
      // Aliases execute directly (no confirmation, no extra step).
      await handleSummarize(rt);
      return "continue";
    case "resume":
      await handleResume(sc, rt);
      return "continue";
    case "detach":
      return handleDetach(rt);
    case "auto-review":
      handleAutoReview(sc, rt);
      return "continue";
    case "mcp":
      await handleMcp(rt);
      return "continue";
    case "add-dir":
      handleAddDir(sc, rt);
      return "continue";
    case "save-workspace":
      handleSaveWorkspace(sc, rt);
      return "continue";
    case "load-workspace":
      handleLoadWorkspace(sc, rt);
      return "continue";
    case "config":
      handleConfig(sc, rt);
      return "continue";
    case "trust":
      handleTrust(sc, rt);
      return "continue";
    case "skills":
      handleSkillsList(rt);
      return "continue";
    case "skill":
      await handleSkill(sc, rt);
      return "continue";
    case "status":
      rt.out.write(`${rt.statusLine()}\n`);
      return "continue";
    case "sandbox":
      // Honest: the engine's session.create accepts no sandbox option
      // (verified against packages/protocol/src/groups/session.ts), so
      // there is nothing to toggle.
      rt.err.write(
        "sandbox is not supported: the local engine's session.create accepts no sandbox option.\n",
      );
      return "continue";
    case "help":
      rt.out.write(`${SLASH_HELP}\n`);
      return "continue";
    case "exit":
    case "quit":
      return "exit";
    default:
      rt.err.write(`unknown command /${sc.cmd} — try /help\n`);
      return "continue";
  }
}
