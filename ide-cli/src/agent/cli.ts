/**
 * cli.ts — the real `agent` command: interactive TUI + `-p/--print` headless.
 *
 * Cursor's desktop CLI ships `agent` as a STUB; we implement it for real
 * against the local ide-code engine sidecar (see engine.ts for the wire
 * protocol). Only flags with a real engine mapping are accepted — anything
 * else errors with an honest reason instead of being silently ignored.
 */

import * as readline from "readline";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import {
  EngineClient,
  EngineClientOptions,
  EngineModelInfo,
  EngineSessionInfo,
  EngineStartError,
  PermissionDecision,
  PermissionRequest,
  SseEvent,
  isReadOnlyAction,
  readOnlySessionPermissions,
  resolveEnginePath,
} from "./engine";
import {
  AgentMode,
  MODE_SWITCH_TIMEOUT_MS,
  timedConfirm,
  TurnEndKind,
  TurnRenderHooks,
  TurnResult,
  startInteractiveTui,
} from "./tui";
import {
  findSession,
  mostRecentSession,
  recordSession,
  removeSession,
  loadRegistry,
  touchSession,
  type PersistentSession,
} from "./sessions";
import {
  loadPluginRegistry,
  pluginAdd,
  pluginRemove,
  pluginUpdate,
  type GitSpawn,
} from "./plugins";
import {
  loadHooks,
  parseStopFollowUp,
  runHookEvent,
  type HookEnv,
  type HookEvent,
  type LoadedHooks,
} from "./hooks";
import { discoverSkills, readSkillContent } from "./skills";
import {
  loadAgentConfig,
  saveAgentConfig,
  type AgentConfig,
} from "./agent-config";

export type OutputFormat = "text" | "json" | "stream-json";

export interface AgentFlags {
  /** Print mode. undefined = interactive TUI; string = the prompt (may be ""). */
  print: string | undefined;
  outputFormat: OutputFormat;
  streamPartialOutput: boolean;
  force: boolean;
  approveMcps: boolean;
  /** Auto-approve allowlisted Shell/MCP/Fetch tools without prompting. */
  autoReview: boolean;
  /**
   * Tool allowlist (built-in tool names). undefined = no restriction;
   * [] = text-only (every tool permission request is denied).
   */
  toolAllowlist?: string[];
  /** Tool denylist — hard constraint, checked before any auto-approve. */
  toolDenylist?: string[];
  /** Accepted for Cursor compatibility; the local engine has no workspace-trust gate. */
  trust: boolean;
  model?: string;
  mode: AgentMode;
  headers: Record<string, string>;
  enginePath?: string;
  timeoutMs: number;
  help: boolean;
  version: boolean;
  /** --resume [id]: resume a persistent session (most recent, or by id). */
  resume: boolean;
  resumeId?: string;
  /** --list-models / `agent models`: list the engine's models and exit. */
  listModels: boolean;
  /** --format: output format for list commands (plugin/persist/ls). */
  pluginFormat: "text" | "json";
  /** --git-ref: only meaningful for `plugin marketplace add`. */
  gitRef?: string;
  subcommand?: "status" | "login" | "logout" | "update" | "persist" | "ls" | "plugin" | "models" | "resume";
  /** Positionals that followed the subcommand (e.g. persist attach <id>). */
  subcommandArgs: string[];
  positional: string[];
}

export type ParseResult = { flags: AgentFlags } | { error: string };

const DEFAULT_TIMEOUT_MS = 600_000; // 10 min — OUR choice; Cursor documents none.

/** ide-cli version, read from the package.json next to the compiled output. */
export function cliVersion(): string {
  try {
    // Compiled layout: out/agent/cli.js → <ide-cli>/package.json.
    const raw = fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8");
    const pkg = JSON.parse(raw) as { version?: unknown };
    return typeof pkg.version === "string" && pkg.version.length > 0
      ? pkg.version
      : "0.0.0-unknown";
  } catch {
    return "0.0.0-unknown";
  }
}

const UNSUPPORTED_FLAGS: Record<string, string> = {
  "--sandbox":
    "the local engine's session.create accepts no sandbox option (verified against packages/protocol/src/groups/session.ts)",
  "--api-key":
    "there is no cloud API to authenticate against — IDE Code is a local-first product",
  "-w": "the engine has no git-worktree support for agent sessions",
  "--worktree":
    "the engine has no git-worktree support for agent sessions",
  "--worktree-base":
    "the engine has no git-worktree support for agent sessions",
  "--skip-worktree-setup":
    "the engine has no git-worktree support for agent sessions",
};

export function parseArgs(argv: string[]): ParseResult {
  const flags: AgentFlags = {
    print: undefined,
    outputFormat: "text",
    streamPartialOutput: false,
    force: false,
    approveMcps: false,
    autoReview: false,
    trust: false,
    mode: "agent",
    headers: {},
    timeoutMs: DEFAULT_TIMEOUT_MS,
    help: false,
    version: false,
    resume: false,
    listModels: false,
    pluginFormat: "text",
    subcommandArgs: [],
    positional: [],
  };

  const fail = (error: string): ParseResult => ({ error });

  let i = 0;
  let endOfFlags = false;
  let subcommandSeen = false;
  while (i < argv.length) {
    const arg = argv[i];

    if (!endOfFlags && arg === "--") {
      endOfFlags = true;
      i++;
      continue;
    }

    if (!endOfFlags && arg.startsWith("-") && arg.length > 1) {
      if (arg in UNSUPPORTED_FLAGS) {
        return fail(`${arg} is not supported: ${UNSUPPORTED_FLAGS[arg]}`);
      }
      // --flag=value form
      const eq = arg.indexOf("=");
      const name = eq >= 0 ? arg.slice(0, eq) : arg;
      const eqValue = eq >= 0 ? arg.slice(eq + 1) : undefined;
      if (eq >= 0 && name in UNSUPPORTED_FLAGS) {
        return fail(`${name} is not supported: ${UNSUPPORTED_FLAGS[name]}`);
      }
      // Admin/team-gated surface: Cursor gates several CLI behaviors behind
      // team administration. IDE Code is local-first with no admin plane, so
      // any --admin* flag is refused honestly instead of being ignored.
      if (name === "--admin" || name.startsWith("--admin-")) {
        return fail(
          `${name} is not supported: IDE Code has no team/admin management plane — ` +
            "there are no admin-gated flags in this local-first CLI",
        );
      }

      const takeValue = (): string | undefined => {
        if (eqValue !== undefined) {
          return eqValue;
        }
        const next = argv[i + 1];
        if (next === undefined || (next.startsWith("-") && next !== "-")) {
          return undefined;
        }
        i++;
        return next;
      };

      switch (name) {
        case "-h":
        case "--help":
          flags.help = true;
          break;
        case "-V":
        case "--version":
          flags.version = true;
          break;
        case "-p":
        case "--print": {
          const value = takeValue();
          if (value !== undefined) {
            flags.print = value;
          } else {
            flags.print = "";
          }
          break;
        }
        case "--output-format": {
          const v = takeValue();
          if (v !== "text" && v !== "json" && v !== "stream-json") {
            return fail(
              `--output-format must be one of text|json|stream-json (got ${JSON.stringify(v ?? "")})`,
            );
          }
          flags.outputFormat = v;
          break;
        }
        case "--stream-partial-output":
          flags.streamPartialOutput = true;
          break;
        case "--force":
        case "--yolo":
          flags.force = true;
          break;
        case "--trust":
          flags.trust = true;
          break;
        case "--approve-mcps":
          flags.approveMcps = true;
          break;
        case "--auto-review":
          flags.autoReview = true;
          break;
        case "--tools": {
          const v = takeValue();
          if (v === undefined) {
            return fail("--tools requires a value: comma-separated tool names, or [] for text-only");
          }
          const t = v.trim();
          if (t === "[]") {
            flags.toolAllowlist = [];
            break;
          }
          const names = t.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
          if (names.length === 0) {
            return fail("--tools requires a value: comma-separated tool names, or [] for text-only");
          }
          flags.toolAllowlist = names;
          break;
        }
        case "--disallowed-tools": {
          const v = takeValue();
          if (v === undefined) {
            return fail("--disallowed-tools requires a value: comma-separated tool names");
          }
          const names = v.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
          if (names.length === 0) {
            return fail("--disallowed-tools requires a value: comma-separated tool names");
          }
          flags.toolDenylist = names;
          break;
        }
        case "--resume": {
          const v = takeValue();
          flags.resume = true;
          if (v !== undefined) {
            flags.resumeId = v;
          }
          break;
        }
        case "--continue":
          // Cursor: "To resume the most recent conversation, use
          // `agent resume`, `--continue`, or the `/resume` slash command."
          // (cursor.com/docs/cli/using) — exactly --resume with no id.
          // Takes no value: a following token stays a positional prompt.
          flags.resume = true;
          break;
        case "--list-models":
          flags.listModels = true;
          break;
        case "--format": {
          const v = takeValue();
          if (v !== "text" && v !== "json") {
            return fail(`--format must be one of text|json (got ${JSON.stringify(v ?? "")})`);
          }
          flags.pluginFormat = v;
          break;
        }
        case "--git-ref": {
          const v = takeValue();
          if (v === undefined || v.length === 0) {
            return fail("--git-ref requires a value");
          }
          flags.gitRef = v;
          break;
        }
        case "--computer-use":
          return fail("computer-use is not available on this platform");
        case "--plan":
          flags.mode = "plan";
          break;
        case "--mode": {
          const v = takeValue();
          if (v !== "agent" && v !== "plan" && v !== "ask") {
            return fail(`--mode must be one of agent|plan|ask (got ${JSON.stringify(v ?? "")})`);
          }
          flags.mode = v;
          break;
        }
        case "--model": {
          const v = takeValue();
          if (v === undefined || v.length === 0) {
            return fail("--model requires a value");
          }
          flags.model = v;
          break;
        }
        case "-H":
        case "--header": {
          const v = takeValue();
          if (v === undefined) {
            return fail(`${name} requires a value like "Name: Value"`);
          }
          const colon = v.indexOf(":");
          if (colon < 0) {
            return fail(`${name} must look like "Name: Value" (got ${JSON.stringify(v)})`);
          }
          flags.headers[v.slice(0, colon).trim()] = v.slice(colon + 1).trim();
          break;
        }
        case "--engine-path": {
          const v = takeValue();
          if (v === undefined || v.length === 0) {
            return fail("--engine-path requires a value");
          }
          flags.enginePath = v;
          break;
        }
        case "--timeout": {
          const v = takeValue();
          const ms = v === undefined ? NaN : Number(v);
          if (!Number.isFinite(ms) || ms <= 0) {
            return fail(`--timeout must be a positive number of milliseconds (got ${JSON.stringify(v ?? "")})`);
          }
          flags.timeoutMs = Math.floor(ms);
          break;
        }
        default:
          return fail(`unknown flag ${JSON.stringify(name)} (see --help)`);
      }
      i++;
      continue;
    }

    // Positional or subcommand.
    if (
      !subcommandSeen &&
      !endOfFlags &&
      ["status", "login", "logout", "update", "persist", "ls", "plugin", "models", "resume"].includes(arg)
    ) {
      flags.subcommand = arg as AgentFlags["subcommand"];
      subcommandSeen = true;
    } else if (arg === "&" && !endOfFlags) {
      // Cursor's `agent &` hands the session to a cloud agent.
      return fail("cloud agents are not available — IDE Code is local-first");
    } else if (
      subcommandSeen &&
      (flags.subcommand === "persist" || flags.subcommand === "plugin" || flags.subcommand === "resume")
    ) {
      // persist/plugin/resume own their positional args (attach <id>,
      // marketplace add …, resume [id]).
      flags.subcommandArgs.push(arg);
    } else {
      flags.positional.push(arg);
    }
    i++;
  }

  if (flags.print !== undefined && flags.print === "") {
    flags.print = flags.positional.join(" ");
    flags.positional = [];
  }
  return { flags };
}

const HELP_TEXT = `ide-code agent — run the IDE Code AI agent in your terminal.

Usage:
  ide-code agent [options] [prompt...]        interactive TUI (prompt is the first turn)
  ide-code agent -p "<prompt>" [options]      headless: run one prompt, print the result
  ide-code agent status                       engine reachability + model list
  ide-code agent persist                      start a persistent session (/detach keeps it)
  ide-code agent persist attach <id>          reattach a persisted session
  ide-code agent persist list | stop <id>     manage persisted sessions
  ide-code agent persist --resume             continue the most recent session
  ide-code agent ls [--format json]           list persisted sessions (all workspaces)
  ide-code agent --resume [id]                resume a session (interactive, or with -p)
  ide-code agent --continue                   resume the most recent session (no id lookup)
  ide-code agent resume [id]                  same as --resume [id]
  ide-code agent models                       list the engine's models and exit
  ide-code agent --list-models                same as \`agent models\`
  ide-code agent plugin marketplace <add|list|update|remove> …

Options:
  -p, --print [prompt]        Headless mode. Prompt may also be given as
                              positional text: agent -p "fix the bug".
  --output-format <fmt>       text (default: final answer only) | json |
                              stream-json (SSE deltas as JSON lines).
  --stream-partial-output     Accepted for Cursor compatibility; stream-json
                              already emits partial output.
  --force, --yolo             Auto-approve file edits and commands (no prompt).
  --trust                     Accepted for compatibility; the local engine has
                              no workspace-trust gate, so this is a no-op.
  --approve-mcps              Auto-approve MCP tool calls (other tools still ask).
  --auto-review               Auto-approve allowlisted Shell/MCP/Fetch actions
                              without prompting (risky deletes still ask).
  --tools <list>              Restrict tool use to these tool names
                              (comma-separated; [] = text-only, deny all tools).
  --disallowed-tools <list>   Never allow these tools — hard constraint, wins
                              over every auto-approve flag.
  --resume [id]               Resume a persisted session (most recent, or by id
                              / id-prefix). Works with -p and interactively.
  --continue                  Resume the most recent session — the same as
                              --resume with no id (Cursor parity).
  --list-models               List the engine's models and exit. The list
                              matches what --model accepts.
  --model <name>              Model id, provider/model, or display name. Checked
                              against the engine's model list when reachable.
  --mode <agent|plan|ask>     plan/ask create the session with the engine's
                              read-only permission ruleset (same mapping as the
                              IDE's modeService). Default: agent.
  --plan                      Shortcut for --mode plan.
  --format <text|json>        Output format for ls / persist list / plugin.
  --git-ref <ref>             Pin plugin marketplace add to a branch/tag/commit.
  -H, --header "Name: Value"  Extra HTTP header for engine requests (repeatable).
  --engine-path <dir>         Engine repo dir (default: IDE_CODE_ENGINE_PATH
                              env, else <ide-cli>/../ide-code).
  --timeout <ms>              Turn timeout, default 600000 (10 min). Our choice;
                              Cursor documents no default.
  -h, --help                  This help.
  -V, --version               Print the CLI version.

Interactive slash commands: /plan /ask /model <name> /opus /composer /fast
  /btw <question> /context /fork /rewind /usage /resume /detach
  /summarize (aliases: /compact /compress — compact the session via the engine)
  /auto-review [on|off] /mcp /add-dir <path> /save-workspace <name>
  /load-workspace <name> /config /trust /skill <name> /skills
  /status /sandbox /help /exit
  (/plan and /ask confirm with a 15s countdown that auto-rejects.)

Permissions: the shared policy decides every tool request, in order:
  1. --disallowed-tools always rejects; --tools restricts to its allowlist.
  2. --force/--yolo approves everything; --approve-mcps approves MCP tools;
     --auto-review approves allowlisted Shell/MCP/Fetch (risky deletes ask).
  3. Otherwise it prompts [y]es/[n]o/[a]lways on a TTY; when stdin is NOT a
     TTY and no auto-approve flag is given, mutating actions are DENIED
     (fail-safe) and read-only actions are approved, so piped/headless use
     stays safe.
  Agent-requested mode switches always confirm with a 15s countdown that
  auto-rejects when left unattended.

Hooks (~/.ide-code/hooks.json merged with ./.ide-code/hooks.json):
  sessionStart / sessionEnd fire around the session; stop hooks run after
  every turn and may request one follow-up via {"followUp": "<text>"}
  (capped at 3); subagentStart / subagentEnd fire on subagent lifecycle.
  preCompaction fires when /summarize asks the engine to compact the
  session (before the compaction request is sent).

stream-json line format (our own; Cursor's is cloud-specific):
  {"type":"turn.start","sessionID":"..."}
  {"type":"text.delta","delta":"..."}
  {"type":"tool.call","id":"...","name":"...","status":"called|running|done|failed"}
  {"type":"subagent.start","id":"...","sessionID":"..."}
  {"type":"subagent.end","id":"...","sessionID":"..."}
  {"type":"permission.asked","id":"...","action":"...","decision":"once|always|reject"}
  {"type":"turn.end","sessionID":"...","endKind":"succeeded|failed|interrupted","result":"..."}

Deliberately not implemented (Cursor agent-CLI surface with no local mapping):
  --api-key        no cloud API exists; IDE Code is local-first
  --sandbox        engine session.create accepts no sandbox option
  -w/--worktree*   engine has no git-worktree support for agent sessions
  --computer-use   macOS-worker feature; not available in the local CLI
  --admin*         no team/admin management plane in this local-first CLI
  agent &          cloud agents are not available — IDE Code is local-first
  login / logout   no account system (local-first product)
  update           shipped from source; no release channel
`;

// ---------------------------------------------------------------------------
// Turn runner (shared by print mode and the TUI)
// ---------------------------------------------------------------------------

export interface RunTurnOptions {
  timeoutMs: number;
  err: NodeJS.WritableStream;
  force: boolean;
  approveMcps: boolean;
  /** Full permission decision: auto-approve flags + TTY/fail-safe policy. */
  decidePermission(req: PermissionRequest): Promise<PermissionDecision>;
  hooks: TurnRenderHooks;
  shouldAbort: () => boolean;
  /** stream-json line emitter (print mode only). */
  emitJson?: (obj: unknown) => void;
  /** Subagent lifecycle observer (backs the subagentStart/subagentEnd hooks). */
  onSubagentEvent?: (kind: "started" | "ended", id: string) => void;
  /**
   * When true, the turn does not resolve until every tracked subagent has
   * ended (or the drain timeout hits). Print/single-turn mode sets this —
   * "single-turn runs wait for their subagents" instead of exiting early.
   */
  drainSubagents?: boolean;
  /** Upper bound for the subagent drain wait. Default 60s. */
  drainTimeoutMs?: number;
}

const TERMINAL_EVENTS = new Set([
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
]);

/**
 * Send one turn and consume the global SSE stream until this session's
 * execution ends. Text deltas, tool calls, and permission requests for OUR
 * session are routed to the hooks; other sessions' events are ignored.
 */
export async function runTurn(
  client: EngineClient,
  sessionID: string,
  text: string,
  opts: RunTurnOptions,
): Promise<TurnResult> {
  let answer = "";
  let failure: unknown;
  let endKind: TurnEndKind | undefined;
  const pendingApprovals = new Set<string>();
  const knownTools = new Set<string>();
  /** Subagent ids started but not yet ended in this turn (for the drain). */
  const pendingSubagents = new Set<string>();

  const emit = (obj: unknown) => opts.emitJson?.(obj);

  const noteSubagentStarted = (id: string): void => {
    if (!id || pendingSubagents.has(id)) {
      return;
    }
    pendingSubagents.add(id);
    opts.hooks.onNotice(`subagent started: ${id}`);
    emit({ type: "subagent.start", id, sessionID });
    try {
      opts.onSubagentEvent?.("started", id);
    } catch {
      /* hook observers must never break the turn */
    }
  };

  const noteSubagentEnded = (id: string): void => {
    if (!id || !pendingSubagents.has(id)) {
      return;
    }
    pendingSubagents.delete(id);
    opts.hooks.onNotice(`subagent ended: ${id}`);
    emit({ type: "subagent.end", id, sessionID });
    try {
      opts.onSubagentEvent?.("ended", id);
    } catch {
      /* hook observers must never break the turn */
    }
  };
  emit({ type: "turn.start", sessionID });

  const handlePermission = async (d: any): Promise<void> => {
    const req: PermissionRequest = {
      id: String(d.id ?? ""),
      sessionID: String(d.sessionID ?? ""),
      action: String(d.action ?? "tool"),
      resources: Array.isArray(d.resources) ? d.resources : [],
      message: typeof d.message === "string" ? d.message : undefined,
    };
    if (!req.id || req.sessionID !== sessionID || pendingApprovals.has(req.id)) {
      return;
    }
    pendingApprovals.add(req.id);
    try {
      const target = req.message ?? [req.action, ...req.resources].filter(Boolean).join(" ");
      opts.hooks.onNotice(`permission requested: ${target}`);
      const decision = await opts.decidePermission(req);
      opts.hooks.onNotice(`permission ${decision === "reject" ? "denied" : "approved"} (${req.action})`);
      emit({ type: "permission.asked", id: req.id, action: req.action, decision });
      try {
        await client.replyPermission(sessionID, req.id, decision);
      } catch (err) {
        // Retry once, then fail the turn visibly instead of hanging — the
        // engine never received our reply, so no execution event will come.
        const msg = err instanceof Error ? err.message : String(err);
        opts.hooks.onNotice(`warning: permission reply failed (${msg}); retrying`);
        await client.replyPermission(sessionID, req.id, decision);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failure = new Error(`could not send approval decision to the engine: ${msg}`);
      endKind = "failed";
    } finally {
      pendingApprovals.delete(req.id);
    }
  };

  const onEvent = (ev: SseEvent): void => {
    const d = ev.data ?? {};
    // Filter to our session. (permission.asked is matched on its own
    // sessionID field, same as the event carries.)
    if (ev.type !== "permission.asked" && d.sessionID !== undefined && d.sessionID !== sessionID) {
      return;
    }
    switch (ev.type) {
      case "session.text.delta":
      case "message.part.delta": {
        const delta = typeof d.delta === "string" ? d.delta : "";
        if (delta) {
          answer += delta;
          opts.hooks.onTextDelta(delta);
          emit({ type: "text.delta", delta });
        }
        break;
      }
      case "session.tool.called":
      case "session.tool.progress":
      case "session.tool.success":
      case "session.tool.failed": {
        const id = typeof d.id === "string" && d.id.length > 0 ? d.id : "";
        const name = typeof d.name === "string" ? d.name : "tool";
        const status =
          ev.type === "session.tool.called"
            ? "called"
            : ev.type === "session.tool.progress"
              ? "running"
              : ev.type === "session.tool.success"
                ? "done"
                : "failed";
        if (id && !knownTools.has(id)) {
          knownTools.add(id);
          opts.hooks.onToolCall({ id, name, status });
          emit({ type: "tool.call", id, name, status });
        }
        // Fallback tracking: a tool literally named "subagent" is a
        // delegated subagent even without dedicated lifecycle events.
        if (id && name.toLowerCase() === "subagent") {
          if (status === "called") {
            noteSubagentStarted(id);
          } else if (status === "done" || status === "failed") {
            noteSubagentEnded(id);
          }
        }
        break;
      }
      case "session.subagent.started":
      case "subagent.started": {
        const id = typeof d.id === "string" ? d.id : typeof d.subagentID === "string" ? d.subagentID : "";
        noteSubagentStarted(id);
        break;
      }
      case "session.subagent.ended":
      case "subagent.ended": {
        const id = typeof d.id === "string" ? d.id : typeof d.subagentID === "string" ? d.subagentID : "";
        noteSubagentEnded(id);
        break;
      }
      case "permission.asked":
        void handlePermission(d);
        break;
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted":
        if (d.sessionID === sessionID) {
          if (ev.type === "session.execution.failed") {
            failure = d.error;
            endKind = "failed";
          } else if (ev.type === "session.execution.interrupted") {
            endKind = "interrupted";
          } else {
            endKind = "succeeded";
          }
        }
        break;
      case "cli.stream-error":
        failure = new Error(String(d.message ?? "event stream error"));
        endKind = "failed";
        break;
      default:
        break;
    }
  };

  const result = await new Promise<TurnResult>((resolve, reject) => {
    let settled = false;
    let draining = false;
    const unsub = client.subscribeEvents(onEvent);
    const cleanup = () => {
      clearTimeout(timer);
      clearInterval(abortPoll);
      unsub();
    };
    const finish = (r: TurnResult) => {
      settled = true;
      cleanup();
      emit({
        type: "turn.end",
        sessionID,
        endKind: r.endKind,
        result: r.text,
      });
      resolve(r);
    };
    const done = (r: TurnResult) => {
      if (settled || draining) {
        return;
      }
      // Single-turn/print mode waits for delegated subagents before
      // exiting, instead of cutting off while they still run.
      if (opts.drainSubagents && pendingSubagents.size > 0) {
        draining = true;
        const waitMs = opts.drainTimeoutMs ?? 60_000;
        const deadline = Date.now() + waitMs;
        opts.hooks.onNotice(
          `waiting for ${pendingSubagents.size} subagent(s) to finish…`,
        );
        const poll = setInterval(() => {
          if (pendingSubagents.size === 0 || Date.now() >= deadline) {
            clearInterval(poll);
            if (pendingSubagents.size > 0) {
              opts.hooks.onNotice(
                `warning: ${pendingSubagents.size} subagent(s) still running ` +
                  `after the ${Math.round(waitMs / 1000)}s drain timeout — exiting anyway`,
              );
            }
            finish(r);
          }
        }, 100);
        return;
      }
      finish(r);
    };
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(
          new Error(`engine did not complete the turn within ${opts.timeoutMs}ms`),
        );
      }
    }, opts.timeoutMs);
    const abortPoll = setInterval(() => {
      if (!settled && (opts.shouldAbort() || endKind !== undefined)) {
        done({ text: answer, endKind: endKind ?? "interrupted", failure });
      }
    }, 100);
    void client
      .prompt(sessionID, text)
      .catch((err: unknown) => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(err);
        }
      });
  });
  return result;
}

/**
 * Flags that feed the shared permission policy (autoDecidePermission).
 * Callers pass the CLI flags, optionally overriding `autoReview` with the
 * runtime toggle (the TUI's /auto-review can flip it mid-session).
 */
export type ToolPolicyFlags = Pick<
  AgentFlags,
  "force" | "approveMcps" | "autoReview" | "toolAllowlist" | "toolDenylist"
>;

/**
 * Match a tool action against a --tools/--disallowed-tools entry.
 * Case-insensitive; a trailing or leading `*` acts as a wildcard
 * ("mcp__*" matches every MCP tool).
 */
export function matchesToolList(action: string, list: string[]): boolean {
  const a = action.toLowerCase();
  return list.some((raw) => {
    const p = raw.toLowerCase().trim();
    if (p.length === 0) {
      return false;
    }
    if (p.endsWith("*") && p.startsWith("*") && p.length > 1) {
      return a.includes(p.slice(1, -1));
    }
    if (p.endsWith("*")) {
      return a.startsWith(p.slice(0, -1));
    }
    if (p.startsWith("*")) {
      return a.endsWith(p.slice(1));
    }
    return a === p;
  });
}

/**
 * Shared auto-approve policy, used by print mode and the TUI alike.
 * Hard constraints come first and apply even under --force:
 *   1. --disallowed-tools always rejects,
 *   2. --tools (when set) restricts to its allowlist ([] = text-only: deny all),
 * then --force/--yolo, --approve-mcps, and --auto-review may approve.
 * Returns undefined when no rule fired — the caller prompts or fail-safes.
 */
export async function autoDecidePermission(
  req: PermissionRequest,
  flags: Partial<ToolPolicyFlags>,
): Promise<PermissionDecision | undefined> {
  if (flags.toolDenylist && matchesToolList(req.action, flags.toolDenylist)) {
    return "reject";
  }
  if (
    flags.toolAllowlist !== undefined &&
    !matchesToolList(req.action, flags.toolAllowlist)
  ) {
    return "reject";
  }
  if (flags.force) {
    return "once";
  }
  if (flags.approveMcps && req.action.toLowerCase().startsWith("mcp__")) {
    return "once";
  }
  if (flags.autoReview && isAutoReviewable(req, flags)) {
    return "once";
  }
  return undefined;
}

/**
 * Shell commands auto-review must NOT approve without asking: recursive /
 * force / wildcard deletes whose target could resolve differently than
 * written (unset variables, stray spaces), fork bombs, disk wipes, and
 * anything escalated via sudo. (Mirrors the Cursor changelog: "Auto-review
 * is stricter about risky deletes.") These fall through to the normal
 * prompt instead of being approved.
 */
const RISKY_SHELL_PATTERNS: ReadonlyArray<RegExp> = [
  /(^|[;&|]\s*)rm\s+[^;&|]*(-[a-z]*r[a-z]*|-[a-z]*f[a-z]*)/i, // rm -r / rm -f
  /(^|[;&|]\s*)rm\s+[^;&|]*\*/, // rm with a wildcard target
  /(^|[;&|]\s*)rm\s+[^;&|]*\$[{]?[A-Za-z_]/, // rm with a variable target
  /:\(\)\s*\{/, // fork bomb
  /(^|[;&|]\s*)(mkfs\b|dd\s+[^;&|]*\bof=)/i, // disk wipes
  /(^|[;&|]\s*)sudo\b/i, // privilege escalation
  /(^|[;&|]\s*)(shutdown|reboot|halt|poweroff)\b/i,
];

/** The shell text behind a permission request (message preferred, then resources). */
export function shellCommandOf(req: PermissionRequest): string {
  if (req.message && req.message.trim().length > 0) {
    return req.message;
  }
  return req.resources.join(" ");
}

export function isRiskyShellCommand(command: string): boolean {
  return RISKY_SHELL_PATTERNS.some((re) => re.test(command));
}

/**
 * Actions /auto-review may approve without prompting: shell, MCP tools,
 * and web fetch/search. Everything else (edits, subagents, skills, …)
 * still prompts. The hard constraints apply first: --disallowed-tools
 * always blocks, and --tools (when set) restricts to its allowlist.
 * (Note: autoDecidePermission already enforces the hard constraints, so
 * the checks here only matter for direct callers.)
 */
const AUTO_REVIEW_ACTION_NAMES: ReadonlySet<string> = new Set([
  "shell",
  "webfetch",
  "websearch",
]);

export function isAutoReviewable(
  req: PermissionRequest,
  flags: Pick<AgentFlags, "toolAllowlist" | "toolDenylist">,
): boolean {
  const lower = req.action.toLowerCase();
  if (flags.toolDenylist && matchesToolList(req.action, flags.toolDenylist)) {
    return false;
  }
  if (
    flags.toolAllowlist !== undefined &&
    !matchesToolList(req.action, flags.toolAllowlist)
  ) {
    return false;
  }
  if (lower === "shell" && isRiskyShellCommand(shellCommandOf(req))) {
    return false;
  }
  if (lower.startsWith("mcp__")) {
    return true;
  }
  return AUTO_REVIEW_ACTION_NAMES.has(lower);
}

/**
 * Full permission decision for print mode: the shared policy
 * (denylist/allowlist, --force/--yolo, --approve-mcps, --auto-review),
 * then a timed approval for agent-requested mode switches (15s,
 * auto-reject), then a TTY prompt, then the non-TTY fail-safe (deny
 * mutating, approve read-only).
 */
export async function decidePermissionPrint(
  req: PermissionRequest,
  flags: ToolPolicyFlags,
  isTTY: boolean,
  err: NodeJS.WritableStream,
): Promise<PermissionDecision> {
  const auto = await autoDecidePermission(req, flags);
  if (auto) {
    return auto;
  }
  if (req.action.toLowerCase() === "switchmode" && isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    try {
      err.write(`\nThe agent requests a mode switch — ${req.message ?? req.action}\n`);
      const ok = await timedConfirm(rl, "approve the mode switch?", MODE_SWITCH_TIMEOUT_MS, err);
      return ok ? "once" : "reject";
    } finally {
      rl.close();
    }
  }
  if (isTTY) {
    return promptPermissionOnTerminal(req, err);
  }
  // Fail-safe: headless without auto-approve flags denies mutating actions
  // and continues read-only.
  return isReadOnlyAction(req.action) ? "once" : "reject";
}

function promptPermissionOnTerminal(
  req: PermissionRequest,
  err: NodeJS.WritableStream,
): Promise<PermissionDecision> {
  const target = req.message ?? [req.action, ...req.resources].filter(Boolean).join(" ");
  err.write(`\nPermission requested — ${target}\n`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    const ask = () => {
      rl.question("[y]es / [n]o / [a]lways: ", (answer: string) => {
        const a = answer.trim().toLowerCase();
        if (a === "y" || a === "yes") {
          rl.close();
          resolve("once");
        } else if (a === "n" || a === "no") {
          rl.close();
          resolve("reject");
        } else if (a === "a" || a === "always") {
          rl.close();
          resolve("always");
        } else {
          ask();
        }
      });
    };
    ask();
  });
}

function matchModel(models: EngineModelInfo[], name: string): EngineModelInfo | undefined {
  const n = name.toLowerCase();
  return models.find(
    (m) =>
      m.id.toLowerCase() === n ||
      m.modelID.toLowerCase() === n ||
      `${m.providerID}/${m.modelID}`.toLowerCase() === n ||
      `${m.providerID}/${m.id}`.toLowerCase() === n ||
      m.name.toLowerCase() === n,
  );
}

export interface RunAgentDeps {
  out?: NodeJS.WritableStream;
  err?: NodeJS.WritableStream;
  isTTY?: boolean;
  /** Stdin replacement for the interactive TUI (tests feed scripted input). */
  input?: NodeJS.ReadableStream;
  clientFactory?: (opts: EngineClientOptions) => Promise<EngineClient>;
  /** git spawn for `plugin marketplace` ops (tests inject a fake). */
  pluginSpawn?: GitSpawn;
}

/**
 * Lifecycle-hook context for one runAgent invocation. Hooks come from
 * ~/.ide-code/hooks.json merged with ./.ide-code/hooks.json (project file
 * runs after the global file). sessionStart fires when the first session
 * starts, sessionEnd fires once at exit when any session was used, and the
 * stop hooks run after every turn (a {"followUp": "..."} line requests one
 * more turn, capped at 3).
 */
export interface HookContext {
  hooks: LoadedHooks;
  cwd: string;
  err: NodeJS.WritableStream;
  sessionID?: string;
  mode?: string;
  noteSessionStart(sessionID: string, mode: string): Promise<void>;
  fireSubagent(kind: "started" | "ended", id: string): void;
  runStopHooks(sessionID: string, mode: string): Promise<string[]>;
  /** Fire preCompaction hooks (used by /summarize before compacting). */
  firePreCompaction(sessionID: string, mode: string): Promise<void>;
}

export function createHookContext(
  err: NodeJS.WritableStream,
  cwd: string = process.cwd(),
): HookContext {
  const hooks = loadHooks(cwd);
  for (const w of hooks.warnings) {
    err.write(`warning: ${w}\n`);
  }
  const log = (msg: string) => err.write(`${msg}\n`);
  const ctx: HookContext = {
    hooks,
    cwd,
    err,
    noteSessionStart: async (sessionID, mode) => {
      if (ctx.sessionID === sessionID) {
        return;
      }
      ctx.sessionID = sessionID;
      ctx.mode = mode;
      await runHookEvent(hooks, "sessionStart", { sessionID, mode, cwd }, { log });
    },
    fireSubagent: (kind, id) => {
      const sessionID = ctx.sessionID;
      if (!sessionID) {
        return;
      }
      void runHookEvent(
        hooks,
        kind === "started" ? "subagentStart" : "subagentEnd",
        { sessionID, mode: ctx.mode, cwd },
        { log },
      );
    },
    runStopHooks: (sessionID, mode) =>
      runHookEvent(hooks, "stop", { sessionID, mode, cwd }, { log }),
    firePreCompaction: async (sessionID, mode) => {
      await runHookEvent(hooks, "preCompaction", { sessionID, mode, cwd }, { log });
    },
  };
  return ctx;
}

/**
 * Entry point (called by the dispatcher). Returns the process exit code;
 * never throws past this boundary — every failure becomes stderr + exit 1.
 */
export async function runAgent(argv: string[], deps: RunAgentDeps = {}): Promise<number> {
  const out = deps.out ?? process.stdout;
  const err = deps.err ?? process.stderr;
  const isTTY = deps.isTTY ?? Boolean(process.stdin.isTTY);

  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    err.write(`error: ${parsed.error}\n`);
    return 1;
  }
  const f = parsed.flags;

  if (f.help) {
    out.write(HELP_TEXT);
    return 0;
  }

  if (f.version) {
    out.write(`ide-code agent ${cliVersion()}\n`);
    return 0;
  }

  // `agent resume [id]` is Cursor's subcommand spelling of --resume [id]
  // (cursor.com/docs/cli/using groups `agent resume`, `--continue`, and
  // `/resume` together). Translate it onto the --resume path so print mode
  // and the interactive TUI share one implementation.
  if (f.subcommand === "resume") {
    if (f.subcommandArgs.length > 1) {
      err.write(
        `error: \`agent resume\` takes at most one session id (got ${f.subcommandArgs.length})\n`,
      );
      return 1;
    }
    f.resume = true;
    if (f.subcommandArgs[0] !== undefined) {
      f.resumeId = f.subcommandArgs[0];
    }
    f.subcommand = undefined;
    f.subcommandArgs = [];
  }

  if (f.subcommand === "login" || f.subcommand === "logout") {
    err.write(
      `error: '${f.subcommand}' is not supported — IDE Code is a local-first product with no account system.\n`,
    );
    return 1;
  }
  if (f.subcommand === "update") {
    err.write(
      "error: 'update' is not supported — the CLI is built from source; pull the repo and rebuild instead.\n",
    );
    return 1;
  }

  // Subcommands that need no engine (local registry / git only).
  if (f.subcommand === "plugin") {
    return await runPluginCommand(f, out, err, deps);
  }
  if (f.subcommand === "ls" || (f.subcommand === "persist" && f.subcommandArgs[0] === "list")) {
    return runListSessionsCommand(f, out, err);
  }

  const hookCtx = createHookContext(err);

  const enginePath = f.enginePath ?? resolveEnginePath();
  let client: EngineClient;
  try {
    client =
      deps.clientFactory !== undefined
        ? await deps.clientFactory({ enginePath, extraHeaders: f.headers })
        : await EngineClient.start({ enginePath, extraHeaders: f.headers });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    err.write(`error: ${msg}\n`);
    return 1;
  }

  try {
    if (f.subcommand === "models" || f.listModels) {
      return await runModelsList(client, out, err);
    }
    if (f.subcommand === "status") {
      return await runStatus(client, out, err);
    }
    if (f.subcommand === "persist") {
      return await runPersistCommand(client, f, out, err, isTTY, deps, hookCtx);
    }
    if (f.print !== undefined) {
      return await runPrintMode(client, f, out, err, isTTY, hookCtx);
    }
    // `agent --resume [id]` (no subcommand): continue the persisted session
    // in the interactive TUI instead of starting a new one.
    let seed: { sessionID: string; mode: string } | undefined;
    if (f.resume) {
      const target = resolveResumeTarget(f);
      await verifySessionOnEngine(client, target.id);
      touchSession(target.id);
      seed = { sessionID: target.id, mode: target.mode };
      out.write(`resuming session ${target.id} ("${target.title}")\n`);
    }
    return await runInteractiveMode(client, f, out, err, isTTY, deps, hookCtx, seed);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    err.write(`error: ${msg}\n`);
    return 1;
  } finally {
    // sessionEnd hooks fire once per process when a session was used.
    // preCompaction fires from /summarize (see runInteractiveMode's
    // compactCurrentSession), not from here.
    if (hookCtx.sessionID) {
      try {
        await runHookEvent(
          hookCtx.hooks,
          "sessionEnd",
          { sessionID: hookCtx.sessionID, mode: hookCtx.mode, cwd: hookCtx.cwd },
          { log: (m) => err.write(`${m}\n`) },
        );
      } catch {
        /* hooks must never break shutdown */
      }
    }
    client.close();
  }
}

/** Resolve --resume [id]: most recent session, or the named one. */
export function resolveResumeTarget(f: Pick<AgentFlags, "resumeId">): PersistentSession {
  if (f.resumeId) {
    const reg = loadRegistry();
    const exact = reg.sessions.find((s) => s.id === f.resumeId);
    if (exact) {
      return exact;
    }
    const prefixed = reg.sessions.filter((s) => s.id.startsWith(f.resumeId as string));
    if (prefixed.length === 1) {
      return prefixed[0];
    }
    if (prefixed.length > 1) {
      throw new Error(
        `ambiguous session id prefix ${JSON.stringify(f.resumeId)} — matches ${prefixed.length} sessions (see \`agent ls\`)`,
      );
    }
    throw new Error(`no persisted session matches ${JSON.stringify(f.resumeId)} (see \`agent ls\`)`);
  }
  const recent = mostRecentSession();
  if (!recent) {
    throw new Error("no persisted session to resume (see `agent ls`)");
  }
  return recent;
}

/** Verify a persisted session still exists on the engine; throw honestly when stale. */
async function verifySessionOnEngine(client: EngineClient, id: string): Promise<void> {
  try {
    await client.getSessionInfo(id);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `session ${id} is no longer on the engine (${msg}) — the sidecar may have restarted; start a new session instead`,
    );
  }
}

function formatSessionList(sessions: PersistentSession[]): string {
  const lines = [`persisted sessions (${sessions.length}) — across all workspaces:`];
  for (const s of sessions) {
    const when = new Date(s.lastUsedAt).toISOString().replace("T", " ").slice(0, 19);
    lines.push(
      `  ${s.id.slice(0, 12)}  "${s.title}"  mode=${s.mode}  cwd=${s.cwd}  last used ${when}`,
    );
  }
  return lines.join("\n") + "\n";
}

/** `agent ls` and `agent persist list` — the registry only, no engine needed. */
export function runListSessionsCommand(
  f: Pick<AgentFlags, "pluginFormat">,
  out: NodeJS.WritableStream,
  err: NodeJS.WritableStream,
): number {
  const sessions = [...loadRegistry().sessions].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  if (f.pluginFormat === "json") {
    out.write(`${JSON.stringify(sessions, null, 2)}\n`);
    return 0;
  }
  if (sessions.length === 0) {
    out.write("no persisted sessions yet — start one with `agent persist`, then /detach.\n");
    return 0;
  }
  out.write(formatSessionList(sessions));
  void err;
  return 0;
}

/**
 * `agent persist [attach <id>|stop <id>] [--resume]`.
 * Bare `persist` starts a new persistent interactive session; `--resume`
 * continues the most recent one.
 */
async function runPersistCommand(
  client: EngineClient,
  f: AgentFlags,
  out: NodeJS.WritableStream,
  err: NodeJS.WritableStream,
  isTTY: boolean,
  deps: RunAgentDeps,
  hookCtx: HookContext,
): Promise<number> {
  const [action, target] = f.subcommandArgs;
  if (f.print !== undefined) {
    err.write("error: `agent persist` is interactive — drop -p, or use `-p --resume` for a headless turn on the most recent session.\n");
    return 1;
  }
  if (action !== undefined && action !== "attach" && action !== "stop") {
    err.write(
      `error: unknown persist action ${JSON.stringify(action)} (expected "attach <id>" or "stop <id>")\n`,
    );
    return 1;
  }
  if ((action === "attach" || action === "stop") && !target) {
    err.write(`error: \`agent persist ${action}\` requires a session id (see \`agent ls\`)\n`);
    return 1;
  }

  if (action === "stop") {
    const sess = findSession(target as string);
    if (!sess) {
      err.write(`error: no persisted session matches ${JSON.stringify(target)} (see \`agent ls\`)\n`);
      return 1;
    }
    try {
      await client.removeSession(sess.id);
      out.write(`stopped session ${sess.id} ("${sess.title}")\n`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      err.write(`warning: the engine could not stop session ${sess.id} (${msg}) — removing the registry entry anyway\n`);
    }
    removeSession(sess.id);
    return 0;
  }

  // attach / --resume / bare: resolve the session, verify it on the engine,
  // then run the interactive TUI seeded with it.
  let seed: { sessionID: string; mode: string };
  if (action === "attach") {
    const fromRegistry = findSession(target as string);
    if (fromRegistry) {
      seed = { sessionID: fromRegistry.id, mode: fromRegistry.mode };
    } else {
      // Not in our registry — it may still be a live engine session id.
      seed = { sessionID: target as string, mode: f.mode };
    }
    await verifySessionOnEngine(client, seed.sessionID);
    touchSession(seed.sessionID);
  } else if (f.resume) {
    const sess = resolveResumeTarget(f);
    await verifySessionOnEngine(client, sess.id);
    touchSession(sess.id);
    seed = { sessionID: sess.id, mode: sess.mode };
    out.write(`resuming session ${sess.id} ("${sess.title}")\n`);
  } else {
    const modelRef = await resolveModelRef(client, f.model, err);
    const id = await client.createSession({
      title: `IDE Code agent (persist)`,
      ...(modelRef ? { model: modelRef } : {}),
      ...(f.mode === "plan" || f.mode === "ask" ? { permissions: readOnlySessionPermissions() } : {}),
    });
    recordSession({
      id,
      title: "IDE Code agent (persist)",
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      cwd: process.cwd(),
      mode: f.mode,
      ...(f.model ? { model: f.model } : {}),
    });
    seed = { sessionID: id, mode: f.mode };
    out.write(
      `persistent session ${id} — /detach leaves it running; reattach later with \`agent persist attach ${id.slice(0, 8)}\`.\n`,
    );
  }
  return await runInteractiveMode(client, f, out, err, isTTY, deps, hookCtx, seed);
}

/**
 * `agent plugin marketplace <add|list|update|remove>` — scriptable,
 * no engine needed. `add` performs a real `git clone`; `update` pulls.
 */
async function runPluginCommand(
  f: AgentFlags,
  out: NodeJS.WritableStream,
  err: NodeJS.WritableStream,
  deps: RunAgentDeps,
): Promise<number> {
  const [scope, op, target] = f.subcommandArgs;
  const json = f.pluginFormat === "json";
  const emit = (value: unknown, text: string) => {
    out.write(json ? `${JSON.stringify(value, null, 2)}\n` : `${text}\n`);
  };
  if (scope !== "marketplace") {
    err.write(
      "usage: agent plugin marketplace <add|list|update|remove> …\n" +
        "  add <git-url> [--git-ref <branch|tag|commit>] [--format json]\n" +
        "  list [--format json]\n" +
        "  update [name] [--format json]\n" +
        "  remove <name|url> [--format json]\n",
    );
    return 1;
  }
  const gitDeps = deps.pluginSpawn ? { spawn: deps.pluginSpawn } : {};
  switch (op) {
    case "add": {
      if (!target) {
        err.write("error: `agent plugin marketplace add` requires a <git-url>\n");
        return 1;
      }
      try {
        const entry = await pluginAdd(target, f.gitRef, gitDeps);
        emit(entry, `added marketplace "${entry.name}" from ${entry.url} → ${entry.path}`);
        return 0;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        err.write(`error: ${msg}\n`);
        return 1;
      }
    }
    case "list": {
      const { marketplaces } = loadPluginRegistry();
      if (json) {
        out.write(`${JSON.stringify(marketplaces, null, 2)}\n`);
      } else if (marketplaces.length === 0) {
        out.write("no plugin marketplaces registered\n");
      } else {
        for (const m of marketplaces) {
          out.write(
            `${m.name}  scope=user  ${m.url}${m.ref ? `  ref=${m.ref}` : ""}  → ${m.path}\n`,
          );
        }
      }
      return 0;
    }
    case "update": {
      try {
        const results = await pluginUpdate(target, gitDeps);
        if (json) {
          out.write(`${JSON.stringify(results, null, 2)}\n`);
        } else if (results.length === 0) {
          out.write("no plugin marketplaces registered\n");
        } else {
          for (const r of results) {
            out.write(`${r.ok ? "ok  " : "FAIL"} ${r.name} — ${r.detail}\n`);
          }
        }
        return results.some((r) => !r.ok) ? 1 : 0;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        err.write(`error: ${msg}\n`);
        return 1;
      }
    }
    case "remove": {
      if (!target) {
        err.write("error: `agent plugin marketplace remove` requires a <name|url>\n");
        return 1;
      }
      try {
        const removed = pluginRemove(target);
        emit(removed, `removed marketplace "${removed.name}"`);
        return 0;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        err.write(`error: ${msg}\n`);
        return 1;
      }
    }
    default:
      err.write(
        `error: unknown plugin action ${JSON.stringify(op ?? "")} (expected add|list|update|remove)\n`,
      );
      return 1;
  }
}

async function resolveModelRef(
  client: EngineClient,
  modelName: string | undefined,
  err: NodeJS.WritableStream,
): Promise<{ id: string; providerID: string } | undefined> {
  if (!modelName) {
    return undefined;
  }
  let models: EngineModelInfo[];
  try {
    models = await client.listModels();
  } catch {
    err.write(`warning: could not reach the engine's model list; passing --model through unchecked\n`);
    return undefined;
  }
  const match = matchModel(models, modelName);
  if (!match) {
    err.write(
      `warning: model ${JSON.stringify(modelName)} not found in the engine's model list — continuing anyway\n`,
    );
    return undefined;
  }
  return { id: match.modelID, providerID: match.providerID };
}

/** Shared model-list rendering for `agent status` and `agent models`. */
function writeModelList(out: NodeJS.WritableStream, models: EngineModelInfo[]): void {
  out.write(`models: ${models.length} available\n`);
  const shown = models.slice(0, 50);
  for (const m of shown) {
    const ref = m.providerID ? `${m.providerID}/${m.modelID}` : m.modelID;
    out.write(`  ${ref}${m.name && m.name !== m.modelID ? ` — ${m.name}` : ""}\n`);
  }
  if (models.length > shown.length) {
    out.write(`  …and ${models.length - shown.length} more\n`);
  }
}

/**
 * `agent models` / `--list-models` — Cursor: "`agent models` and
 * `--list-models` now show the Bedrock models for your region… The list
 * matches what `--model` accepts" (cursor.com/docs/cli/changelog). Locally
 * the list is the engine's model list — the same list --model is checked
 * against (see resolveModelRef/matchModel). Lists and exits: no session
 * is created and no prompt runs.
 */
async function runModelsList(
  client: EngineClient,
  out: NodeJS.WritableStream,
  err: NodeJS.WritableStream,
): Promise<number> {
  let models: EngineModelInfo[];
  try {
    models = await client.listModels();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    err.write(`error: could not list engine models: ${msg}\n`);
    return 1;
  }
  writeModelList(out, models);
  return 0;
}

async function runStatus(
  client: EngineClient,
  out: NodeJS.WritableStream,
  err: NodeJS.WritableStream,
): Promise<number> {
  let models: EngineModelInfo[];
  try {
    models = await client.listModels();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    err.write(`error: engine reachable but model list failed: ${msg}\n`);
    return 1;
  }
  out.write(`engine: reachable (127.0.0.1:${client.serverPort})\n`);
  writeModelList(out, models);
  return 0;
}

async function runPrintMode(
  client: EngineClient,
  f: AgentFlags,
  out: NodeJS.WritableStream,
  err: NodeJS.WritableStream,
  isTTY: boolean,
  hookCtx: HookContext,
): Promise<number> {
  const prompt = f.print ?? "";
  if (prompt.trim().length === 0) {
    err.write("error: no prompt provided (use -p \"<prompt>\" or pass prompt text)\n");
    return 1;
  }
  const modelRef = await resolveModelRef(client, f.model, err);
  let sessionID: string;
  let resumedTitle: string | undefined;
  if (f.resume) {
    // Continue a persisted session instead of starting a new one.
    const target = resolveResumeTarget(f);
    await verifySessionOnEngine(client, target.id);
    touchSession(target.id);
    sessionID = target.id;
    resumedTitle = target.title;
    err.write(`resuming session ${sessionID} ("${target.title}")\n`);
  } else {
    sessionID = await client.createSession({
      title: `IDE Code agent (print, ${f.mode})`,
      ...(modelRef ? { model: modelRef } : {}),
      ...(f.mode === "plan" || f.mode === "ask" ? { permissions: readOnlySessionPermissions() } : {}),
    });
    recordSession({
      id: sessionID,
      title: resumedTitle ?? `IDE Code agent (print, ${f.mode})`,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      cwd: process.cwd(),
      mode: f.mode,
      ...(f.model ? { model: f.model } : {}),
    });
  }
  await hookCtx.noteSessionStart(sessionID, f.mode);

  const emitJson =
    f.outputFormat === "stream-json" ? (obj: unknown) => out.write(`${JSON.stringify(obj)}\n`) : undefined;

  const hooks: TurnRenderHooks = {
    onTextDelta: (delta) => {
      if (f.outputFormat === "text") {
        out.write(delta);
      }
    },
    onToolCall: (info) => {
      err.write(`[tool ${info.name} — ${info.status}]\n`);
    },
    onNotice: (msg) => {
      err.write(`${msg}\n`);
    },
  };

  const turnOpts = (): Parameters<typeof runTurn>[3] => ({
    timeoutMs: f.timeoutMs,
    err,
    force: f.force,
    approveMcps: f.approveMcps,
    decidePermission: (req) => decidePermissionPrint(req, f, isTTY, err),
    hooks,
    shouldAbort: () => false,
    emitJson,
    // Single-turn runs wait for their subagents before exiting.
    drainSubagents: true,
    onSubagentEvent: (kind, id) => hookCtx.fireSubagent(kind, id),
  });

  /** One turn plus the stop-hook follow-up loop (capped at 3). */
  const runTurnWithStopHooks = async (text: string): Promise<TurnResult> => {
    let result = await runTurn(client, sessionID, text, turnOpts());
    let followUps = 0;
    for (;;) {
      const stdouts = await hookCtx.runStopHooks(sessionID, f.mode);
      const followUp = parseStopFollowUp(stdouts);
      if (!followUp || followUps >= 3) {
        break;
      }
      followUps++;
      err.write(`[stop hook requested a follow-up turn (${followUps}/3)]\n`);
      result = await runTurn(client, sessionID, followUp, turnOpts());
    }
    return result;
  };

  let result: TurnResult;
  try {
    result = await runTurnWithStopHooks(prompt);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    err.write(`error: ${msg}\n`);
    return 1;
  }

  if (f.outputFormat === "text") {
    out.write("\n");
  } else if (f.outputFormat === "json") {
    out.write(
      `${JSON.stringify({
        result: result.text,
        sessionID,
        model: f.model ?? null,
        endKind: result.endKind,
      })}\n`,
    );
  }
  // stream-json already emitted turn.end above.

  if (result.endKind === "failed") {
    const msg =
      result.failure instanceof Error
        ? result.failure.message
        : typeof result.failure === "string"
          ? result.failure
          : "turn failed";
    err.write(`error: turn failed: ${msg}\n`);
    return 1;
  }
  if (result.endKind === "interrupted") {
    err.write("error: turn interrupted\n");
    return 1;
  }
  return 0;
}

async function runInteractiveMode(
  client: EngineClient,
  f: AgentFlags,
  out: NodeJS.WritableStream,
  err: NodeJS.WritableStream,
  isTTY: boolean,
  deps: RunAgentDeps,
  hookCtx: HookContext,
  seed?: { sessionID: string; mode: string },
): Promise<number> {
  if (!isTTY && !f.positional.length) {
    err.write(
      "error: interactive mode needs a terminal; use -p \"<prompt>\" for headless runs\n",
    );
    return 1;
  }
  const modelRef = await resolveModelRef(client, f.model, err);
  const sessions = new Map<AgentMode, string>();
  let mode: AgentMode = f.mode;
  let abortRequested = false;
  let turnActive = false;

  // /auto-review and /trust toggle these at runtime; they start from the
  // CLI flags and fall back to the persisted agent-config.json.
  const persistedConfig: AgentConfig = loadAgentConfig();
  let autoReview = f.autoReview || persistedConfig.autoReview;
  let trust = f.trust || persistedConfig.trust;
  const persistPreference = () => {
    saveAgentConfig({ ...loadAgentConfig(), autoReview, trust });
  };

  const ensureSession = async (m: AgentMode): Promise<string> => {
    const cached = sessions.get(m);
    if (cached) {
      touchSession(cached);
      return cached;
    }
    const id = await client.createSession({
      title: `IDE Code agent (${m})`,
      ...(modelRef ? { model: modelRef } : {}),
      ...(m === "plan" || m === "ask" ? { permissions: readOnlySessionPermissions() } : {}),
    });
    sessions.set(m, id);
    recordSession({
      id,
      title: `IDE Code agent (${m})`,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      cwd: process.cwd(),
      mode: m,
      ...(f.model ? { model: f.model } : {}),
    });
    await hookCtx.noteSessionStart(id, m);
    return id;
  };

  // persist attach / --resume seed the TUI with a verified live session.
  if (seed && (seed.mode === "agent" || seed.mode === "plan" || seed.mode === "ask")) {
    sessions.set(seed.mode, seed.sessionID);
    touchSession(seed.sessionID);
    await hookCtx.noteSessionStart(seed.sessionID, seed.mode);
    mode = seed.mode;
  }

  /** Shared turn options for main-session and /btw side turns. */
  const turnOpts = (
    render: TurnRenderHooks,
    promptPermission: (req: PermissionRequest) => Promise<PermissionDecision>,
  ) => ({
    timeoutMs: f.timeoutMs,
    err,
    force: f.force,
    approveMcps: f.approveMcps,
    decidePermission: promptPermission,
    hooks: render,
    shouldAbort: () => abortRequested,
    onSubagentEvent: (kind: "started" | "ended", id: string) =>
      hookCtx.fireSubagent(kind, id),
  });

  const code = await startInteractiveTui({
    out,
    err,
    isTTY,
    input: deps.input,
    initialPrompt: f.positional.length > 0 ? f.positional.join(" ") : undefined,
    getMode: () => mode,
    setMode: async (m) => {
      mode = m;
      await ensureSession(m);
    },
    setModel: async (name) => {
      const models = await client.listModels().catch(() => [] as EngineModelInfo[]);
      const match = matchModel(models, name);
      if (!match) {
        return `model ${JSON.stringify(name)} not found in the engine's model list`;
      }
      const ref = { id: match.modelID, providerID: match.providerID };
      const sid = sessions.get(mode);
      if (sid) {
        await client.switchModel(sid, ref);
      }
      return undefined;
    },
    statusLine: () => {
      const sid = sessions.get(mode);
      return `session: ${sid ?? "(not created yet)"}  mode: ${mode}  model: ${f.model ?? "(engine default)"}`;
    },
    autoDecidePermission: (req) =>
      // One shared policy (denylist/allowlist hard constraints, then
      // --force/--approve-mcps/--auto-review); the runtime toggle from
      // /auto-review overrides the CLI flag.
      autoDecidePermission(req, { ...f, autoReview }),
    runTurnWith: async (text, render, promptPermission) => {
      const sessionID = await ensureSession(mode);
      abortRequested = false;
      turnActive = true;
      try {
        let result = await runTurn(client, sessionID, text, turnOpts(render, promptPermission));
        // stop hooks may request one follow-up turn (capped at 3).
        let followUps = 0;
        for (;;) {
          const stdouts = await hookCtx.runStopHooks(sessionID, mode);
          const followUp = parseStopFollowUp(stdouts);
          if (!followUp || followUps >= 3) {
            break;
          }
          followUps++;
          err.write(`[stop hook requested a follow-up turn (${followUps}/3)]\n`);
          result = await runTurn(client, sessionID, followUp, turnOpts(render, promptPermission));
        }
        return result;
      } finally {
        turnActive = false;
      }
    },
    runReadOnlyTurn: async (text, render, promptPermission) => {
      // /btw: a throwaway read-only session — the main session's history
      // is never touched. Deleted when the turn settles.
      const tempID = await client.createSession({
        title: "IDE Code agent (btw — discarded)",
        ...(modelRef ? { model: modelRef } : {}),
        permissions: readOnlySessionPermissions(),
      });
      abortRequested = false;
      turnActive = true;
      try {
        return await runTurn(client, tempID, text, turnOpts(render, promptPermission));
      } finally {
        turnActive = false;
        await client.removeSession(tempID).catch(() => {
          /* best effort: the temp session must not linger */
        });
      }
    },
    currentSessionID: () => sessions.get(mode),
    listSkills: () =>
      discoverSkills(process.cwd(), os.homedir()).map((s) => ({
        name: s.name,
        description: s.description,
      })),
    attachSkill: async (name) => {
      const skills = discoverSkills(process.cwd(), os.homedir());
      const found = skills.find((s) => s.name.toLowerCase() === name.toLowerCase());
      if (!found) {
        return { error: `no skill named ${JSON.stringify(name)}` };
      }
      const content = readSkillContent(found);
      if (!content) {
        return { error: `could not read SKILL.md for ${JSON.stringify(found.name)}` };
      }
      return { content };
    },
    forkCurrentSession: async () => {
      const from = sessions.get(mode);
      if (!from) {
        throw new Error("no active session in this mode yet — send a message first, then /fork");
      }
      const to = await client.createSession({
        title: `fork of ${from.slice(0, 8)}`,
        ...(modelRef ? { model: modelRef } : {}),
        ...(mode === "plan" || mode === "ask"
          ? { permissions: readOnlySessionPermissions() }
          : {}),
        parentID: from,
      });
      sessions.set(mode, to);
      return { from, to };
    },
    attachSession: async (id) => {
      // Throws when the engine answers 404 — the handler reports it honestly.
      const info = await client.getSessionInfo(id);
      sessions.set(mode, id);
      touchSession(id);
      return info.title;
    },
    detachCurrentSession: async () => {
      const sid = sessions.get(mode);
      if (!sid) {
        throw new Error("no active session in this mode yet — nothing to detach");
      }
      let title = `IDE Code agent (${mode})`;
      try {
        title = (await client.getSessionInfo(sid)).title || title;
      } catch {
        /* keep the fallback title */
      }
      recordSession({
        id: sid,
        title,
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        cwd: process.cwd(),
        mode,
        ...(f.model ? { model: f.model } : {}),
      });
      return { id: sid, title };
    },
    getEngineConfig: () => client.getConfig(),
    listModels: () => client.listModels(),
    compactCurrentSession: async () => {
      // /summarize: fire preCompaction hooks first (their first real
      // trigger), then ask the engine to compact the current session.
      const sid = sessions.get(mode);
      if (!sid) {
        throw new Error(
          "no active session in this mode yet — send a message first, then /summarize",
        );
      }
      await hookCtx.firePreCompaction(sid, mode);
      await client.compactSession(sid);
      return sid;
    },
    getAutoReview: () => autoReview,
    setAutoReview: (on) => {
      autoReview = on;
      persistPreference();
    },
    getTrust: () => trust,
    setTrust: (on) => {
      trust = on;
      persistPreference();
    },
    abortTurn: () => {
      abortRequested = true;
    },
    isTurnActive: () => turnActive,
    close: () => {
      /* client closed by runAgent's finally */
    },
  });
  return code;
}

export { EngineStartError };
