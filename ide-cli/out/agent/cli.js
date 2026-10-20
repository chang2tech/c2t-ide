"use strict";
/**
 * cli.ts — the real `agent` command: interactive TUI + `-p/--print` headless.
 *
 * Cursor's desktop CLI ships `agent` as a STUB; we implement it for real
 * against the local ide-code engine sidecar (see engine.ts for the wire
 * protocol). Only flags with a real engine mapping are accepted — anything
 * else errors with an honest reason instead of being silently ignored.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.EngineStartError = void 0;
exports.cliVersion = cliVersion;
exports.parseArgs = parseArgs;
exports.runTurn = runTurn;
exports.matchesToolList = matchesToolList;
exports.autoDecidePermission = autoDecidePermission;
exports.shellCommandOf = shellCommandOf;
exports.isRiskyShellCommand = isRiskyShellCommand;
exports.isAutoReviewable = isAutoReviewable;
exports.decidePermissionPrint = decidePermissionPrint;
exports.createHookContext = createHookContext;
exports.runAgent = runAgent;
exports.resolveResumeTarget = resolveResumeTarget;
exports.runListSessionsCommand = runListSessionsCommand;
const readline = __importStar(require("readline"));
const os = __importStar(require("os"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const engine_1 = require("./engine");
Object.defineProperty(exports, "EngineStartError", { enumerable: true, get: function () { return engine_1.EngineStartError; } });
const tui_1 = require("./tui");
const sessions_1 = require("./sessions");
const plugins_1 = require("./plugins");
const hooks_1 = require("./hooks");
const skills_1 = require("./skills");
const agent_config_1 = require("./agent-config");
const DEFAULT_TIMEOUT_MS = 600_000; // 10 min — OUR choice; Cursor documents none.
/** ide-cli version, read from the package.json next to the compiled output. */
function cliVersion() {
    try {
        // Compiled layout: out/agent/cli.js → <ide-cli>/package.json.
        const raw = fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8");
        const pkg = JSON.parse(raw);
        return typeof pkg.version === "string" && pkg.version.length > 0
            ? pkg.version
            : "0.0.0-unknown";
    }
    catch {
        return "0.0.0-unknown";
    }
}
const UNSUPPORTED_FLAGS = {
    "--sandbox": "the local engine's session.create accepts no sandbox option (verified against packages/protocol/src/groups/session.ts)",
    "--api-key": "there is no cloud API to authenticate against — IDE Code is a local-first product",
    "-w": "the engine has no git-worktree support for agent sessions",
    "--worktree": "the engine has no git-worktree support for agent sessions",
    "--worktree-base": "the engine has no git-worktree support for agent sessions",
    "--skip-worktree-setup": "the engine has no git-worktree support for agent sessions",
};
function parseArgs(argv) {
    const flags = {
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
    const fail = (error) => ({ error });
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
                return fail(`${name} is not supported: IDE Code has no team/admin management plane — ` +
                    "there are no admin-gated flags in this local-first CLI");
            }
            const takeValue = () => {
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
                    }
                    else {
                        flags.print = "";
                    }
                    break;
                }
                case "--output-format": {
                    const v = takeValue();
                    if (v !== "text" && v !== "json" && v !== "stream-json") {
                        return fail(`--output-format must be one of text|json|stream-json (got ${JSON.stringify(v ?? "")})`);
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
        if (!subcommandSeen &&
            !endOfFlags &&
            ["status", "login", "logout", "update", "persist", "ls", "plugin", "models", "resume"].includes(arg)) {
            flags.subcommand = arg;
            subcommandSeen = true;
        }
        else if (arg === "&" && !endOfFlags) {
            // Cursor's `agent &` hands the session to a cloud agent.
            return fail("cloud agents are not available — IDE Code is local-first");
        }
        else if (subcommandSeen &&
            (flags.subcommand === "persist" || flags.subcommand === "plugin" || flags.subcommand === "resume")) {
            // persist/plugin/resume own their positional args (attach <id>,
            // marketplace add …, resume [id]).
            flags.subcommandArgs.push(arg);
        }
        else {
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
async function runTurn(client, sessionID, text, opts) {
    let answer = "";
    let failure;
    let endKind;
    const pendingApprovals = new Set();
    const knownTools = new Set();
    /** Subagent ids started but not yet ended in this turn (for the drain). */
    const pendingSubagents = new Set();
    const emit = (obj) => opts.emitJson?.(obj);
    const noteSubagentStarted = (id) => {
        if (!id || pendingSubagents.has(id)) {
            return;
        }
        pendingSubagents.add(id);
        opts.hooks.onNotice(`subagent started: ${id}`);
        emit({ type: "subagent.start", id, sessionID });
        try {
            opts.onSubagentEvent?.("started", id);
        }
        catch {
            /* hook observers must never break the turn */
        }
    };
    const noteSubagentEnded = (id) => {
        if (!id || !pendingSubagents.has(id)) {
            return;
        }
        pendingSubagents.delete(id);
        opts.hooks.onNotice(`subagent ended: ${id}`);
        emit({ type: "subagent.end", id, sessionID });
        try {
            opts.onSubagentEvent?.("ended", id);
        }
        catch {
            /* hook observers must never break the turn */
        }
    };
    emit({ type: "turn.start", sessionID });
    const handlePermission = async (d) => {
        const req = {
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
            }
            catch (err) {
                // Retry once, then fail the turn visibly instead of hanging — the
                // engine never received our reply, so no execution event will come.
                const msg = err instanceof Error ? err.message : String(err);
                opts.hooks.onNotice(`warning: permission reply failed (${msg}); retrying`);
                await client.replyPermission(sessionID, req.id, decision);
            }
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            failure = new Error(`could not send approval decision to the engine: ${msg}`);
            endKind = "failed";
        }
        finally {
            pendingApprovals.delete(req.id);
        }
    };
    const onEvent = (ev) => {
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
                const status = ev.type === "session.tool.called"
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
                    }
                    else if (status === "done" || status === "failed") {
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
                    }
                    else if (ev.type === "session.execution.interrupted") {
                        endKind = "interrupted";
                    }
                    else {
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
    const result = await new Promise((resolve, reject) => {
        let settled = false;
        let draining = false;
        const unsub = client.subscribeEvents(onEvent);
        const cleanup = () => {
            clearTimeout(timer);
            clearInterval(abortPoll);
            unsub();
        };
        const finish = (r) => {
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
        const done = (r) => {
            if (settled || draining) {
                return;
            }
            // Single-turn/print mode waits for delegated subagents before
            // exiting, instead of cutting off while they still run.
            if (opts.drainSubagents && pendingSubagents.size > 0) {
                draining = true;
                const waitMs = opts.drainTimeoutMs ?? 60_000;
                const deadline = Date.now() + waitMs;
                opts.hooks.onNotice(`waiting for ${pendingSubagents.size} subagent(s) to finish…`);
                const poll = setInterval(() => {
                    if (pendingSubagents.size === 0 || Date.now() >= deadline) {
                        clearInterval(poll);
                        if (pendingSubagents.size > 0) {
                            opts.hooks.onNotice(`warning: ${pendingSubagents.size} subagent(s) still running ` +
                                `after the ${Math.round(waitMs / 1000)}s drain timeout — exiting anyway`);
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
                reject(new Error(`engine did not complete the turn within ${opts.timeoutMs}ms`));
            }
        }, opts.timeoutMs);
        const abortPoll = setInterval(() => {
            if (!settled && (opts.shouldAbort() || endKind !== undefined)) {
                done({ text: answer, endKind: endKind ?? "interrupted", failure });
            }
        }, 100);
        void client
            .prompt(sessionID, text)
            .catch((err) => {
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
 * Match a tool action against a --tools/--disallowed-tools entry.
 * Case-insensitive; a trailing or leading `*` acts as a wildcard
 * ("mcp__*" matches every MCP tool).
 */
function matchesToolList(action, list) {
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
async function autoDecidePermission(req, flags) {
    if (flags.toolDenylist && matchesToolList(req.action, flags.toolDenylist)) {
        return "reject";
    }
    if (flags.toolAllowlist !== undefined &&
        !matchesToolList(req.action, flags.toolAllowlist)) {
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
const RISKY_SHELL_PATTERNS = [
    /(^|[;&|]\s*)rm\s+[^;&|]*(-[a-z]*r[a-z]*|-[a-z]*f[a-z]*)/i, // rm -r / rm -f
    /(^|[;&|]\s*)rm\s+[^;&|]*\*/, // rm with a wildcard target
    /(^|[;&|]\s*)rm\s+[^;&|]*\$[{]?[A-Za-z_]/, // rm with a variable target
    /:\(\)\s*\{/, // fork bomb
    /(^|[;&|]\s*)(mkfs\b|dd\s+[^;&|]*\bof=)/i, // disk wipes
    /(^|[;&|]\s*)sudo\b/i, // privilege escalation
    /(^|[;&|]\s*)(shutdown|reboot|halt|poweroff)\b/i,
];
/** The shell text behind a permission request (message preferred, then resources). */
function shellCommandOf(req) {
    if (req.message && req.message.trim().length > 0) {
        return req.message;
    }
    return req.resources.join(" ");
}
function isRiskyShellCommand(command) {
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
const AUTO_REVIEW_ACTION_NAMES = new Set([
    "shell",
    "webfetch",
    "websearch",
]);
function isAutoReviewable(req, flags) {
    const lower = req.action.toLowerCase();
    if (flags.toolDenylist && matchesToolList(req.action, flags.toolDenylist)) {
        return false;
    }
    if (flags.toolAllowlist !== undefined &&
        !matchesToolList(req.action, flags.toolAllowlist)) {
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
async function decidePermissionPrint(req, flags, isTTY, err) {
    const auto = await autoDecidePermission(req, flags);
    if (auto) {
        return auto;
    }
    if (req.action.toLowerCase() === "switchmode" && isTTY) {
        const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
        try {
            err.write(`\nThe agent requests a mode switch — ${req.message ?? req.action}\n`);
            const ok = await (0, tui_1.timedConfirm)(rl, "approve the mode switch?", tui_1.MODE_SWITCH_TIMEOUT_MS, err);
            return ok ? "once" : "reject";
        }
        finally {
            rl.close();
        }
    }
    if (isTTY) {
        return promptPermissionOnTerminal(req, err);
    }
    // Fail-safe: headless without auto-approve flags denies mutating actions
    // and continues read-only.
    return (0, engine_1.isReadOnlyAction)(req.action) ? "once" : "reject";
}
function promptPermissionOnTerminal(req, err) {
    const target = req.message ?? [req.action, ...req.resources].filter(Boolean).join(" ");
    err.write(`\nPermission requested — ${target}\n`);
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    return new Promise((resolve) => {
        const ask = () => {
            rl.question("[y]es / [n]o / [a]lways: ", (answer) => {
                const a = answer.trim().toLowerCase();
                if (a === "y" || a === "yes") {
                    rl.close();
                    resolve("once");
                }
                else if (a === "n" || a === "no") {
                    rl.close();
                    resolve("reject");
                }
                else if (a === "a" || a === "always") {
                    rl.close();
                    resolve("always");
                }
                else {
                    ask();
                }
            });
        };
        ask();
    });
}
function matchModel(models, name) {
    const n = name.toLowerCase();
    return models.find((m) => m.id.toLowerCase() === n ||
        m.modelID.toLowerCase() === n ||
        `${m.providerID}/${m.modelID}`.toLowerCase() === n ||
        `${m.providerID}/${m.id}`.toLowerCase() === n ||
        m.name.toLowerCase() === n);
}
function createHookContext(err, cwd = process.cwd()) {
    const hooks = (0, hooks_1.loadHooks)(cwd);
    for (const w of hooks.warnings) {
        err.write(`warning: ${w}\n`);
    }
    const log = (msg) => err.write(`${msg}\n`);
    const ctx = {
        hooks,
        cwd,
        err,
        noteSessionStart: async (sessionID, mode) => {
            if (ctx.sessionID === sessionID) {
                return;
            }
            ctx.sessionID = sessionID;
            ctx.mode = mode;
            await (0, hooks_1.runHookEvent)(hooks, "sessionStart", { sessionID, mode, cwd }, { log });
        },
        fireSubagent: (kind, id) => {
            const sessionID = ctx.sessionID;
            if (!sessionID) {
                return;
            }
            void (0, hooks_1.runHookEvent)(hooks, kind === "started" ? "subagentStart" : "subagentEnd", { sessionID, mode: ctx.mode, cwd }, { log });
        },
        runStopHooks: (sessionID, mode) => (0, hooks_1.runHookEvent)(hooks, "stop", { sessionID, mode, cwd }, { log }),
        firePreCompaction: async (sessionID, mode) => {
            await (0, hooks_1.runHookEvent)(hooks, "preCompaction", { sessionID, mode, cwd }, { log });
        },
    };
    return ctx;
}
/**
 * Entry point (called by the dispatcher). Returns the process exit code;
 * never throws past this boundary — every failure becomes stderr + exit 1.
 */
async function runAgent(argv, deps = {}) {
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
            err.write(`error: \`agent resume\` takes at most one session id (got ${f.subcommandArgs.length})\n`);
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
        err.write(`error: '${f.subcommand}' is not supported — IDE Code is a local-first product with no account system.\n`);
        return 1;
    }
    if (f.subcommand === "update") {
        err.write("error: 'update' is not supported — the CLI is built from source; pull the repo and rebuild instead.\n");
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
    const enginePath = f.enginePath ?? (0, engine_1.resolveEnginePath)();
    let client;
    try {
        client =
            deps.clientFactory !== undefined
                ? await deps.clientFactory({ enginePath, extraHeaders: f.headers })
                : await engine_1.EngineClient.start({ enginePath, extraHeaders: f.headers });
    }
    catch (e) {
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
        let seed;
        if (f.resume) {
            const target = resolveResumeTarget(f);
            await verifySessionOnEngine(client, target.id);
            (0, sessions_1.touchSession)(target.id);
            seed = { sessionID: target.id, mode: target.mode };
            out.write(`resuming session ${target.id} ("${target.title}")\n`);
        }
        return await runInteractiveMode(client, f, out, err, isTTY, deps, hookCtx, seed);
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        err.write(`error: ${msg}\n`);
        return 1;
    }
    finally {
        // sessionEnd hooks fire once per process when a session was used.
        // preCompaction fires from /summarize (see runInteractiveMode's
        // compactCurrentSession), not from here.
        if (hookCtx.sessionID) {
            try {
                await (0, hooks_1.runHookEvent)(hookCtx.hooks, "sessionEnd", { sessionID: hookCtx.sessionID, mode: hookCtx.mode, cwd: hookCtx.cwd }, { log: (m) => err.write(`${m}\n`) });
            }
            catch {
                /* hooks must never break shutdown */
            }
        }
        client.close();
    }
}
/** Resolve --resume [id]: most recent session, or the named one. */
function resolveResumeTarget(f) {
    if (f.resumeId) {
        const reg = (0, sessions_1.loadRegistry)();
        const exact = reg.sessions.find((s) => s.id === f.resumeId);
        if (exact) {
            return exact;
        }
        const prefixed = reg.sessions.filter((s) => s.id.startsWith(f.resumeId));
        if (prefixed.length === 1) {
            return prefixed[0];
        }
        if (prefixed.length > 1) {
            throw new Error(`ambiguous session id prefix ${JSON.stringify(f.resumeId)} — matches ${prefixed.length} sessions (see \`agent ls\`)`);
        }
        throw new Error(`no persisted session matches ${JSON.stringify(f.resumeId)} (see \`agent ls\`)`);
    }
    const recent = (0, sessions_1.mostRecentSession)();
    if (!recent) {
        throw new Error("no persisted session to resume (see `agent ls`)");
    }
    return recent;
}
/** Verify a persisted session still exists on the engine; throw honestly when stale. */
async function verifySessionOnEngine(client, id) {
    try {
        await client.getSessionInfo(id);
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`session ${id} is no longer on the engine (${msg}) — the sidecar may have restarted; start a new session instead`);
    }
}
function formatSessionList(sessions) {
    const lines = [`persisted sessions (${sessions.length}) — across all workspaces:`];
    for (const s of sessions) {
        const when = new Date(s.lastUsedAt).toISOString().replace("T", " ").slice(0, 19);
        lines.push(`  ${s.id.slice(0, 12)}  "${s.title}"  mode=${s.mode}  cwd=${s.cwd}  last used ${when}`);
    }
    return lines.join("\n") + "\n";
}
/** `agent ls` and `agent persist list` — the registry only, no engine needed. */
function runListSessionsCommand(f, out, err) {
    const sessions = [...(0, sessions_1.loadRegistry)().sessions].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
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
async function runPersistCommand(client, f, out, err, isTTY, deps, hookCtx) {
    const [action, target] = f.subcommandArgs;
    if (f.print !== undefined) {
        err.write("error: `agent persist` is interactive — drop -p, or use `-p --resume` for a headless turn on the most recent session.\n");
        return 1;
    }
    if (action !== undefined && action !== "attach" && action !== "stop") {
        err.write(`error: unknown persist action ${JSON.stringify(action)} (expected "attach <id>" or "stop <id>")\n`);
        return 1;
    }
    if ((action === "attach" || action === "stop") && !target) {
        err.write(`error: \`agent persist ${action}\` requires a session id (see \`agent ls\`)\n`);
        return 1;
    }
    if (action === "stop") {
        const sess = (0, sessions_1.findSession)(target);
        if (!sess) {
            err.write(`error: no persisted session matches ${JSON.stringify(target)} (see \`agent ls\`)\n`);
            return 1;
        }
        try {
            await client.removeSession(sess.id);
            out.write(`stopped session ${sess.id} ("${sess.title}")\n`);
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            err.write(`warning: the engine could not stop session ${sess.id} (${msg}) — removing the registry entry anyway\n`);
        }
        (0, sessions_1.removeSession)(sess.id);
        return 0;
    }
    // attach / --resume / bare: resolve the session, verify it on the engine,
    // then run the interactive TUI seeded with it.
    let seed;
    if (action === "attach") {
        const fromRegistry = (0, sessions_1.findSession)(target);
        if (fromRegistry) {
            seed = { sessionID: fromRegistry.id, mode: fromRegistry.mode };
        }
        else {
            // Not in our registry — it may still be a live engine session id.
            seed = { sessionID: target, mode: f.mode };
        }
        await verifySessionOnEngine(client, seed.sessionID);
        (0, sessions_1.touchSession)(seed.sessionID);
    }
    else if (f.resume) {
        const sess = resolveResumeTarget(f);
        await verifySessionOnEngine(client, sess.id);
        (0, sessions_1.touchSession)(sess.id);
        seed = { sessionID: sess.id, mode: sess.mode };
        out.write(`resuming session ${sess.id} ("${sess.title}")\n`);
    }
    else {
        const modelRef = await resolveModelRef(client, f.model, err);
        const id = await client.createSession({
            title: `IDE Code agent (persist)`,
            ...(modelRef ? { model: modelRef } : {}),
            ...(f.mode === "plan" || f.mode === "ask" ? { permissions: (0, engine_1.readOnlySessionPermissions)() } : {}),
        });
        (0, sessions_1.recordSession)({
            id,
            title: "IDE Code agent (persist)",
            createdAt: Date.now(),
            lastUsedAt: Date.now(),
            cwd: process.cwd(),
            mode: f.mode,
            ...(f.model ? { model: f.model } : {}),
        });
        seed = { sessionID: id, mode: f.mode };
        out.write(`persistent session ${id} — /detach leaves it running; reattach later with \`agent persist attach ${id.slice(0, 8)}\`.\n`);
    }
    return await runInteractiveMode(client, f, out, err, isTTY, deps, hookCtx, seed);
}
/**
 * `agent plugin marketplace <add|list|update|remove>` — scriptable,
 * no engine needed. `add` performs a real `git clone`; `update` pulls.
 */
async function runPluginCommand(f, out, err, deps) {
    const [scope, op, target] = f.subcommandArgs;
    const json = f.pluginFormat === "json";
    const emit = (value, text) => {
        out.write(json ? `${JSON.stringify(value, null, 2)}\n` : `${text}\n`);
    };
    if (scope !== "marketplace") {
        err.write("usage: agent plugin marketplace <add|list|update|remove> …\n" +
            "  add <git-url> [--git-ref <branch|tag|commit>] [--format json]\n" +
            "  list [--format json]\n" +
            "  update [name] [--format json]\n" +
            "  remove <name|url> [--format json]\n");
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
                const entry = await (0, plugins_1.pluginAdd)(target, f.gitRef, gitDeps);
                emit(entry, `added marketplace "${entry.name}" from ${entry.url} → ${entry.path}`);
                return 0;
            }
            catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                err.write(`error: ${msg}\n`);
                return 1;
            }
        }
        case "list": {
            const { marketplaces } = (0, plugins_1.loadPluginRegistry)();
            if (json) {
                out.write(`${JSON.stringify(marketplaces, null, 2)}\n`);
            }
            else if (marketplaces.length === 0) {
                out.write("no plugin marketplaces registered\n");
            }
            else {
                for (const m of marketplaces) {
                    out.write(`${m.name}  scope=user  ${m.url}${m.ref ? `  ref=${m.ref}` : ""}  → ${m.path}\n`);
                }
            }
            return 0;
        }
        case "update": {
            try {
                const results = await (0, plugins_1.pluginUpdate)(target, gitDeps);
                if (json) {
                    out.write(`${JSON.stringify(results, null, 2)}\n`);
                }
                else if (results.length === 0) {
                    out.write("no plugin marketplaces registered\n");
                }
                else {
                    for (const r of results) {
                        out.write(`${r.ok ? "ok  " : "FAIL"} ${r.name} — ${r.detail}\n`);
                    }
                }
                return results.some((r) => !r.ok) ? 1 : 0;
            }
            catch (e) {
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
                const removed = (0, plugins_1.pluginRemove)(target);
                emit(removed, `removed marketplace "${removed.name}"`);
                return 0;
            }
            catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                err.write(`error: ${msg}\n`);
                return 1;
            }
        }
        default:
            err.write(`error: unknown plugin action ${JSON.stringify(op ?? "")} (expected add|list|update|remove)\n`);
            return 1;
    }
}
async function resolveModelRef(client, modelName, err) {
    if (!modelName) {
        return undefined;
    }
    let models;
    try {
        models = await client.listModels();
    }
    catch {
        err.write(`warning: could not reach the engine's model list; passing --model through unchecked\n`);
        return undefined;
    }
    const match = matchModel(models, modelName);
    if (!match) {
        err.write(`warning: model ${JSON.stringify(modelName)} not found in the engine's model list — continuing anyway\n`);
        return undefined;
    }
    return { id: match.modelID, providerID: match.providerID };
}
/** Shared model-list rendering for `agent status` and `agent models`. */
function writeModelList(out, models) {
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
async function runModelsList(client, out, err) {
    let models;
    try {
        models = await client.listModels();
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        err.write(`error: could not list engine models: ${msg}\n`);
        return 1;
    }
    writeModelList(out, models);
    return 0;
}
async function runStatus(client, out, err) {
    let models;
    try {
        models = await client.listModels();
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        err.write(`error: engine reachable but model list failed: ${msg}\n`);
        return 1;
    }
    out.write(`engine: reachable (127.0.0.1:${client.serverPort})\n`);
    writeModelList(out, models);
    return 0;
}
async function runPrintMode(client, f, out, err, isTTY, hookCtx) {
    const prompt = f.print ?? "";
    if (prompt.trim().length === 0) {
        err.write("error: no prompt provided (use -p \"<prompt>\" or pass prompt text)\n");
        return 1;
    }
    const modelRef = await resolveModelRef(client, f.model, err);
    let sessionID;
    let resumedTitle;
    if (f.resume) {
        // Continue a persisted session instead of starting a new one.
        const target = resolveResumeTarget(f);
        await verifySessionOnEngine(client, target.id);
        (0, sessions_1.touchSession)(target.id);
        sessionID = target.id;
        resumedTitle = target.title;
        err.write(`resuming session ${sessionID} ("${target.title}")\n`);
    }
    else {
        sessionID = await client.createSession({
            title: `IDE Code agent (print, ${f.mode})`,
            ...(modelRef ? { model: modelRef } : {}),
            ...(f.mode === "plan" || f.mode === "ask" ? { permissions: (0, engine_1.readOnlySessionPermissions)() } : {}),
        });
        (0, sessions_1.recordSession)({
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
    const emitJson = f.outputFormat === "stream-json" ? (obj) => out.write(`${JSON.stringify(obj)}\n`) : undefined;
    const hooks = {
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
    const turnOpts = () => ({
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
    const runTurnWithStopHooks = async (text) => {
        let result = await runTurn(client, sessionID, text, turnOpts());
        let followUps = 0;
        for (;;) {
            const stdouts = await hookCtx.runStopHooks(sessionID, f.mode);
            const followUp = (0, hooks_1.parseStopFollowUp)(stdouts);
            if (!followUp || followUps >= 3) {
                break;
            }
            followUps++;
            err.write(`[stop hook requested a follow-up turn (${followUps}/3)]\n`);
            result = await runTurn(client, sessionID, followUp, turnOpts());
        }
        return result;
    };
    let result;
    try {
        result = await runTurnWithStopHooks(prompt);
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        err.write(`error: ${msg}\n`);
        return 1;
    }
    if (f.outputFormat === "text") {
        out.write("\n");
    }
    else if (f.outputFormat === "json") {
        out.write(`${JSON.stringify({
            result: result.text,
            sessionID,
            model: f.model ?? null,
            endKind: result.endKind,
        })}\n`);
    }
    // stream-json already emitted turn.end above.
    if (result.endKind === "failed") {
        const msg = result.failure instanceof Error
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
async function runInteractiveMode(client, f, out, err, isTTY, deps, hookCtx, seed) {
    if (!isTTY && !f.positional.length) {
        err.write("error: interactive mode needs a terminal; use -p \"<prompt>\" for headless runs\n");
        return 1;
    }
    const modelRef = await resolveModelRef(client, f.model, err);
    const sessions = new Map();
    let mode = f.mode;
    let abortRequested = false;
    let turnActive = false;
    // /auto-review and /trust toggle these at runtime; they start from the
    // CLI flags and fall back to the persisted agent-config.json.
    const persistedConfig = (0, agent_config_1.loadAgentConfig)();
    let autoReview = f.autoReview || persistedConfig.autoReview;
    let trust = f.trust || persistedConfig.trust;
    const persistPreference = () => {
        (0, agent_config_1.saveAgentConfig)({ ...(0, agent_config_1.loadAgentConfig)(), autoReview, trust });
    };
    const ensureSession = async (m) => {
        const cached = sessions.get(m);
        if (cached) {
            (0, sessions_1.touchSession)(cached);
            return cached;
        }
        const id = await client.createSession({
            title: `IDE Code agent (${m})`,
            ...(modelRef ? { model: modelRef } : {}),
            ...(m === "plan" || m === "ask" ? { permissions: (0, engine_1.readOnlySessionPermissions)() } : {}),
        });
        sessions.set(m, id);
        (0, sessions_1.recordSession)({
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
        (0, sessions_1.touchSession)(seed.sessionID);
        await hookCtx.noteSessionStart(seed.sessionID, seed.mode);
        mode = seed.mode;
    }
    /** Shared turn options for main-session and /btw side turns. */
    const turnOpts = (render, promptPermission) => ({
        timeoutMs: f.timeoutMs,
        err,
        force: f.force,
        approveMcps: f.approveMcps,
        decidePermission: promptPermission,
        hooks: render,
        shouldAbort: () => abortRequested,
        onSubagentEvent: (kind, id) => hookCtx.fireSubagent(kind, id),
    });
    const code = await (0, tui_1.startInteractiveTui)({
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
            const models = await client.listModels().catch(() => []);
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
                    const followUp = (0, hooks_1.parseStopFollowUp)(stdouts);
                    if (!followUp || followUps >= 3) {
                        break;
                    }
                    followUps++;
                    err.write(`[stop hook requested a follow-up turn (${followUps}/3)]\n`);
                    result = await runTurn(client, sessionID, followUp, turnOpts(render, promptPermission));
                }
                return result;
            }
            finally {
                turnActive = false;
            }
        },
        runReadOnlyTurn: async (text, render, promptPermission) => {
            // /btw: a throwaway read-only session — the main session's history
            // is never touched. Deleted when the turn settles.
            const tempID = await client.createSession({
                title: "IDE Code agent (btw — discarded)",
                ...(modelRef ? { model: modelRef } : {}),
                permissions: (0, engine_1.readOnlySessionPermissions)(),
            });
            abortRequested = false;
            turnActive = true;
            try {
                return await runTurn(client, tempID, text, turnOpts(render, promptPermission));
            }
            finally {
                turnActive = false;
                await client.removeSession(tempID).catch(() => {
                    /* best effort: the temp session must not linger */
                });
            }
        },
        currentSessionID: () => sessions.get(mode),
        listSkills: () => (0, skills_1.discoverSkills)(process.cwd(), os.homedir()).map((s) => ({
            name: s.name,
            description: s.description,
        })),
        attachSkill: async (name) => {
            const skills = (0, skills_1.discoverSkills)(process.cwd(), os.homedir());
            const found = skills.find((s) => s.name.toLowerCase() === name.toLowerCase());
            if (!found) {
                return { error: `no skill named ${JSON.stringify(name)}` };
            }
            const content = (0, skills_1.readSkillContent)(found);
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
                    ? { permissions: (0, engine_1.readOnlySessionPermissions)() }
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
            (0, sessions_1.touchSession)(id);
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
            }
            catch {
                /* keep the fallback title */
            }
            (0, sessions_1.recordSession)({
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
                throw new Error("no active session in this mode yet — send a message first, then /summarize");
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
