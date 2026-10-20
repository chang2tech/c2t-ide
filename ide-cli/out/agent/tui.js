"use strict";
/**
 * tui.ts — interactive terminal loop for the agent CLI.
 *
 * All engine/permission policy lives in cli.ts; this module owns only the
 * readline loop, the in-memory turn log (for /rewind and /context), and
 * Ctrl+C semantics:
 *   - Ctrl+C during a turn aborts the turn (a second Ctrl+C exits)
 *   - Ctrl+C on an idle prompt exits immediately
 *   - Ctrl+D exits
 *
 * Slash commands themselves live in slash.ts; this module builds the
 * SlashRuntime from TuiDeps and delegates to handleSlashCommand.
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
exports.parseSlashCommand = exports.MODE_SWITCH_TIMEOUT_MS = void 0;
exports.timedConfirm = timedConfirm;
exports.startInteractiveTui = startInteractiveTui;
const readline = __importStar(require("readline"));
const engine_1 = require("./engine");
const slash_1 = require("./slash");
Object.defineProperty(exports, "parseSlashCommand", { enumerable: true, get: function () { return slash_1.parseSlashCommand; } });
/**
 * Yes/no prompt with a countdown: resolves true only on an explicit
 * "y"/"yes" before the timeout, otherwise false (auto-reject). Used for
 * mode-switch approvals — user-typed /plan|/ask and agent-requested
 * mode switches — matching Cursor's 15-second auto-reject.
 */
function timedConfirm(rl, prompt, timeoutMs, err) {
    return new Promise((resolve) => {
        let settled = false;
        const done = (value) => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                resolve(value);
            }
        };
        const secs = Math.max(1, Math.round(timeoutMs / 1000));
        const timer = setTimeout(() => {
            err.write(`\n(auto-rejected: no answer within ${secs}s)\n`);
            done(false);
        }, timeoutMs);
        // Never keep the process alive just for the countdown.
        timer.unref?.();
        rl.question(`${prompt} [y/N] (auto-rejects in ${secs}s): `, (answer) => {
            const a = answer.trim().toLowerCase();
            done(a === "y" || a === "yes");
        });
    });
}
/** Timeout for mode-switch approvals (matches Cursor's 15s). */
exports.MODE_SWITCH_TIMEOUT_MS = 15_000;
async function startInteractiveTui(deps) {
    const rl = readline.createInterface({
        input: deps.input ?? process.stdin,
        output: deps.out,
        prompt: "ide-code> ",
        terminal: true,
    });
    let turnActive = false;
    let sigintDuringTurn = false;
    let exiting = false;
    const turnLog = [];
    /** Skill staged by /skill — prepended to the next main-session turn, one-shot. */
    let pendingSkill;
    const exit = (code) => {
        if (exiting) {
            return;
        }
        exiting = true;
        rl.close();
        deps.close();
        process.exitCode = code;
    };
    rl.on("SIGINT", () => {
        if (turnActive) {
            if (sigintDuringTurn) {
                deps.err.write("\nInterrupted.\n");
                exit(130);
                return;
            }
            sigintDuringTurn = true;
            deps.abortTurn();
            deps.err.write("\n[turn aborted — press Ctrl+C again to exit]\n");
            return;
        }
        deps.out.write("\n");
        exit(0);
    });
    // Line queue: 'line' events can fire before the consumer loop starts
    // (e.g. piped stdin arriving during the initial turn), so buffer them
    // from the moment the interface is created.
    const lineQueue = [];
    let lineResolve;
    let rlClosed = false;
    rl.on("line", (line) => {
        if (lineResolve) {
            const r = lineResolve;
            lineResolve = undefined;
            r(line);
        }
        else {
            lineQueue.push(line);
        }
    });
    rl.on("close", () => {
        rlClosed = true;
        if (lineResolve) {
            const r = lineResolve;
            lineResolve = undefined;
            r(undefined);
        }
        // EOF: never cut off lines that already arrived or a turn that is still
        // running — the main loop drains the queue first and then observes
        // rlClosed. Exiting here is only safe when there is nothing left to do.
        if (lineQueue.length === 0 && !turnActive) {
            exit(0);
        }
    });
    async function nextLine() {
        if (lineQueue.length > 0) {
            return lineQueue.shift();
        }
        if (rlClosed) {
            return undefined;
        }
        return new Promise((resolve) => {
            lineResolve = resolve;
        });
    }
    const render = {
        onTextDelta: (delta) => deps.out.write(delta),
        onToolCall: (info) => deps.err.write(`\n[tool ${info.name} — ${info.status}]\n`),
        onNotice: (msg) => deps.err.write(`${msg}\n`),
    };
    async function runOneTurn(text) {
        turnActive = true;
        sigintDuringTurn = false;
        let toolCalls = 0;
        const countingRender = {
            ...render,
            onToolCall: (info) => {
                toolCalls += 1;
                render.onToolCall(info);
            },
        };
        // A skill staged via /skill is attached one-shot to this turn only.
        let effectiveText = text;
        if (pendingSkill) {
            const { name, content } = pendingSkill;
            pendingSkill = undefined;
            const safeName = name.replace(/"/g, "&quot;");
            effectiveText = `<skill name="${safeName}">\n${content}\n</skill>\n\n${text}`;
            deps.err.write(`[skill "${name}" attached to this turn]\n`);
        }
        try {
            const result = await deps.runTurnWith(effectiveText, countingRender, (req) => promptPermissionOnRl(rl, req));
            turnLog.push({
                n: turnLog.length + 1,
                promptPreview: text.slice(0, 120),
                at: Date.now(),
                endKind: result.endKind,
                toolCalls,
            });
            deps.out.write("\n");
            if (result.endKind === "failed") {
                const msg = result.failure instanceof Error
                    ? result.failure.message
                    : typeof result.failure === "string"
                        ? result.failure
                        : "turn failed";
                deps.err.write(`error: turn failed: ${msg}\n`);
            }
            else if (result.endKind === "interrupted") {
                deps.err.write("error: turn interrupted\n");
            }
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            deps.err.write(`error: ${msg}\n`);
        }
        finally {
            turnActive = false;
        }
    }
    const runtime = {
        out: deps.out,
        err: deps.err,
        getMode: deps.getMode,
        setMode: deps.setMode,
        setModel: deps.setModel,
        statusLine: deps.statusLine,
        autoDecidePermission: deps.autoDecidePermission,
        promptPermission: (req) => promptPermissionOnRl(rl, req),
        runTurnWith: deps.runTurnWith,
        runReadOnlyTurn: deps.runReadOnlyTurn,
        withTurnActive: async (fn) => {
            turnActive = true;
            sigintDuringTurn = false;
            try {
                return await fn();
            }
            finally {
                turnActive = false;
            }
        },
        currentSessionID: deps.currentSessionID,
        forkCurrentSession: deps.forkCurrentSession,
        attachSession: deps.attachSession,
        detachCurrentSession: deps.detachCurrentSession,
        getEngineConfig: deps.getEngineConfig,
        listModels: deps.listModels,
        compactCurrentSession: deps.compactCurrentSession,
        getAutoReview: deps.getAutoReview,
        setAutoReview: deps.setAutoReview,
        getTrust: deps.getTrust,
        setTrust: deps.setTrust,
        listSkills: deps.listSkills,
        attachSkill: deps.attachSkill,
        setPendingSkill: (name, content) => {
            pendingSkill = { name, content };
        },
        getTurnLog: () => turnLog,
        confirmModeSwitch: async (mode) => timedConfirm(rl, `switch to ${mode} mode?`, exports.MODE_SWITCH_TIMEOUT_MS, deps.err),
    };
    async function handleSlash(sc) {
        const action = await (0, slash_1.handleSlashCommand)(sc, runtime);
        if (action === "exit") {
            exit(0);
        }
    }
    /**
     * Full permission decision for the TUI: auto-approve flags first, then a
     * prompt on the loop's own readline when it is a TTY, then the non-TTY
     * fail-safe (deny mutating actions, approve read-only ones).
     */
    async function promptPermissionOnRl(promptRl, req) {
        const auto = await deps.autoDecidePermission(req);
        if (auto) {
            return auto;
        }
        // Agent-requested mode switches get a 15-second countdown and
        // auto-reject when left unattended, matching Cursor ("Timed
        // mode-switch approvals"). Explicit auto-approve flags above still win.
        if (req.action.toLowerCase() === "switchmode" && deps.isTTY && !rlClosed) {
            const target = req.message ?? req.action;
            deps.err.write(`\nThe agent requests a mode switch — ${target}\n`);
            const ok = await timedConfirm(promptRl, "approve the mode switch?", exports.MODE_SWITCH_TIMEOUT_MS, deps.err);
            return ok ? "once" : "reject";
        }
        if (!deps.isTTY || rlClosed) {
            return (0, engine_1.isReadOnlyAction)(req.action) ? "once" : "reject";
        }
        const target = req.message ?? [req.action, ...req.resources].filter(Boolean).join(" ");
        deps.err.write(`\nPermission requested — ${target}\n`);
        return new Promise((resolve) => {
            const ask = () => {
                promptRl.question("[y]es / [n]o / [a]lways: ", (answer) => {
                    const a = answer.trim().toLowerCase();
                    if (a === "y" || a === "yes") {
                        resolve("once");
                    }
                    else if (a === "n" || a === "no") {
                        resolve("reject");
                    }
                    else if (a === "a" || a === "always") {
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
    if (deps.initialPrompt && deps.initialPrompt.length > 0) {
        await runOneTurn(deps.initialPrompt);
        if (exiting) {
            return Number(process.exitCode ?? 0);
        }
    }
    for (;;) {
        if (!rlClosed) {
            rl.prompt();
        }
        const line = await nextLine();
        if (line === undefined) {
            break;
        }
        const sc = (0, slash_1.parseSlashCommand)(line);
        if (sc) {
            await handleSlash(sc);
        }
        else if (line.trim().length > 0) {
            await runOneTurn(line.trim());
        }
        if (exiting) {
            break;
        }
    }
    return Number(process.exitCode ?? 0);
}
