"use strict";
/**
 * hooks.ts — agent lifecycle hooks.
 *
 * Config: ~/.ide-code/hooks.json merged with ./.ide-code/hooks.json
 * (project file runs AFTER the global file). Format:
 *
 *   {
 *     "sessionStart":   ["notify-send 'agent started'"],
 *     "sessionEnd":     ["notify-send 'agent done'"],
 *     "stop":           ["my-stop-checker"],
 *     "preCompaction":  ["echo compacting >> log"],
 *     "subagentStart":  [],
 *     "subagentEnd":    []
 *   }
 *
 * Each command runs via `sh -c` with IDE_CODE_HOOK_EVENT,
 * IDE_CODE_SESSION_ID, IDE_CODE_MODE and IDE_CODE_CWD in the environment.
 * A `stop` hook may request exactly one follow-up turn by printing a line
 * of JSON: {"followUp": "<text>"} (follow-up loops are capped at 3).
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
exports.HOOK_EVENTS = void 0;
exports.loadHooks = loadHooks;
exports.runHookEvent = runHookEvent;
exports.parseStopFollowUp = parseStopFollowUp;
const childProcess = __importStar(require("child_process"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const store_1 = require("./store");
exports.HOOK_EVENTS = [
    "sessionStart",
    "sessionEnd",
    "stop",
    "preCompaction",
    "subagentStart",
    "subagentEnd",
];
function normalizeFile(raw, origin, warnings) {
    const out = {
        sessionStart: [],
        sessionEnd: [],
        stop: [],
        preCompaction: [],
        subagentStart: [],
        subagentEnd: [],
    };
    if (raw === undefined || raw === null) {
        return out;
    }
    if (typeof raw !== "object" || Array.isArray(raw)) {
        warnings.push(`${origin}: expected a JSON object, ignoring file`);
        return out;
    }
    for (const [key, value] of Object.entries(raw)) {
        if (!exports.HOOK_EVENTS.includes(key)) {
            warnings.push(`${origin}: unknown hook event ${JSON.stringify(key)} — ignored`);
            continue;
        }
        const event = key;
        if (typeof value === "string") {
            out[event].push(value);
        }
        else if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
            out[event].push(...value);
        }
        else {
            warnings.push(`${origin}: hook ${JSON.stringify(key)} must be a string or string[] — ignored`);
        }
    }
    return out;
}
/**
 * Load hooks: global ~/.ide-code/hooks.json, then <projectDir>/.ide-code/hooks.json.
 * Project commands run after global ones for the same event.
 */
function loadHooks(projectDir) {
    const warnings = [];
    const commands = {
        sessionStart: [],
        sessionEnd: [],
        stop: [],
        preCompaction: [],
        subagentStart: [],
        subagentEnd: [],
    };
    const globalFile = path.join((0, store_1.configDir)(), "hooks.json");
    if (fs.existsSync(globalFile)) {
        const parsed = (0, store_1.readJsonFile)(globalFile, undefined);
        const norm = normalizeFile(parsed, globalFile, warnings);
        for (const e of exports.HOOK_EVENTS) {
            commands[e].push(...norm[e]);
        }
    }
    const projectFile = path.join(projectDir, ".ide-code", "hooks.json");
    if (fs.existsSync(projectFile)) {
        const parsed = (0, store_1.readJsonFile)(projectFile, undefined);
        const norm = normalizeFile(parsed, projectFile, warnings);
        for (const e of exports.HOOK_EVENTS) {
            commands[e].push(...norm[e]);
        }
    }
    return { commands, warnings };
}
const DEFAULT_HOOK_TIMEOUT_MS = 30_000;
function runOne(spawnFn, command, env, timeoutMs) {
    return new Promise((resolve) => {
        const child = spawnFn("sh", ["-c", command], {
            stdio: ["ignore", "pipe", "pipe"],
            env,
        });
        let stdout = "";
        let stderr = "";
        let settled = false;
        const done = (code) => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                resolve({ stdout, stderr, code });
            }
        };
        const timer = setTimeout(() => {
            try {
                child.kill("SIGKILL");
            }
            catch {
                /* already dead */
            }
            done(124);
        }, timeoutMs);
        child.stdout?.on("data", (c) => {
            stdout += c.toString();
        });
        child.stderr?.on("data", (c) => {
            stderr += c.toString();
        });
        child.on("error", () => done(127));
        child.on("close", (code) => done(code ?? 1));
    });
}
/**
 * Run every command registered for `event`, in order. Returns the list of
 * stdout outputs (used by the stop hook's follow-up detection). A failing
 * command is reported via `log` but never throws — hooks must not break
 * the agent turn.
 */
async function runHookEvent(hooks, event, env, opts = {}) {
    const outputs = [];
    const list = hooks?.commands[event] ?? [];
    if (list.length === 0) {
        return outputs;
    }
    const spawnFn = opts.spawn ?? childProcess.spawn;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
    const hookEnv = {
        ...process.env,
        IDE_CODE_HOOK_EVENT: event,
        ...(env.sessionID ? { IDE_CODE_SESSION_ID: env.sessionID } : {}),
        ...(env.mode ? { IDE_CODE_MODE: env.mode } : {}),
        ...(env.cwd ? { IDE_CODE_CWD: env.cwd } : {}),
    };
    for (const command of list) {
        const res = await runOne(spawnFn, command, hookEnv, timeoutMs);
        outputs.push(res.stdout);
        if (res.code !== 0 && opts.log) {
            const tail = res.stderr.trim().split("\n").pop() ?? "";
            opts.log(`[hook ${event}] ${JSON.stringify(command)} exited ${res.code}${tail ? `: ${tail}` : ""}`);
        }
    }
    return outputs;
}
/**
 * A stop hook requests a follow-up turn by printing one JSON line:
 *   {"followUp": "<text>"}
 * Returns the text, or undefined when no hook asked for a follow-up.
 */
function parseStopFollowUp(stdouts) {
    for (const out of stdouts) {
        for (const line of out.split("\n")) {
            const t = line.trim();
            if (!t.startsWith("{")) {
                continue;
            }
            try {
                const obj = JSON.parse(t);
                if (obj && typeof obj.followUp === "string" && obj.followUp.trim().length > 0) {
                    return obj.followUp.trim();
                }
            }
            catch {
                /* not JSON — keep scanning */
            }
        }
    }
    return undefined;
}
