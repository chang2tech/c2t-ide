"use strict";
/**
 * engine.ts — sidecar spawn + HTTP/SSE protocol client for the ide-code engine.
 *
 * Speaks the EXACT wire protocol used by the IDE Agent extension
 * (extensions/ide-agent/src/services/ideCodeEngineAdapter.ts), which is
 * grounded in the engine source (~/workspace/ide-code):
 *
 *   spawn:  bun <enginePath>/packages/cli/src/index.ts serve --port <free> --hostname 127.0.0.1
 *   auth:   HTTP Basic "opencode:<32-byte-hex-token>" via OPENCODE_PASSWORD env
 *   wire:   POST /api/session                              → create session
 *           POST /api/session/:id/prompt                   → send turn { text }
 *           GET  /api/event                                → SSE stream
 *           POST /api/session/:id/permission/:reqID/reply   → { decision }
 *           GET  /api/model                                → model catalog
 *           GET  /api/config                               → readiness probe
 *
 * Engine path resolution order (documented, never hardcoded to one machine):
 *   1. --engine-path flag
 *   2. IDE_CODE_ENGINE_PATH env
 *   3. <ide-cli package dir>/../ide-code heuristic
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
exports.EngineClient = exports.EngineStartError = void 0;
exports.parseSseFrame = parseSseFrame;
exports.resolveEnginePath = resolveEnginePath;
exports.subagentNestingDefaultEnv = subagentNestingDefaultEnv;
exports.readOnlySessionPermissions = readOnlySessionPermissions;
exports.isReadOnlyAction = isReadOnlyAction;
const childProcess = __importStar(require("child_process"));
const crypto = __importStar(require("crypto"));
const fs = __importStar(require("fs"));
const http = __importStar(require("http"));
const net = __importStar(require("net"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
class EngineStartError extends Error {
    constructor(message) {
        super(message);
        this.name = "EngineStartError";
    }
}
exports.EngineStartError = EngineStartError;
/**
 * SSE frame parser. Mirrors extensions/ide-agent/src/services/sseParser.ts
 * (duplicated here because ide-cli must stay vscode-free):
 * wire format is `data: {"id","type","data"}\n\n` — there is NO `event:` line,
 * the event type lives inside the JSON envelope. Heartbeat frames
 * (": heartbeat") parse to undefined.
 */
function parseSseFrame(raw) {
    let type = "";
    const dataLines = [];
    for (const line of raw.split("\n")) {
        if (line.startsWith("event:")) {
            type = line.slice(6).trim();
        }
        else if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).trim());
        }
    }
    if (dataLines.length === 0) {
        return undefined;
    }
    let data;
    try {
        data = JSON.parse(dataLines.join("\n"));
    }
    catch {
        return undefined;
    }
    if (type) {
        return { type, data };
    }
    if (data && typeof data === "object" && typeof data.type === "string") {
        return { type: data.type, data: data.data };
    }
    return undefined;
}
/**
 * Engine path resolution order:
 *   1. --engine-path flag (applied by the caller before this is consulted)
 *   2. IDE_CODE_ENGINE_PATH environment variable
 *   3. <ide-cli package dir>/../ide-code heuristic
 */
function resolveEnginePath(cliPackageDir) {
    const fromEnv = process.env.IDE_CODE_ENGINE_PATH;
    if (fromEnv && fromEnv.length > 0) {
        return fromEnv;
    }
    let pkgDir = cliPackageDir;
    if (!pkgDir) {
        // Walk up from this module looking for the ide-cli package.
        let dir = __dirname;
        for (let i = 0; i < 8; i++) {
            const pkg = path.join(dir, "package.json");
            try {
                const raw = fs.readFileSync(pkg, "utf8");
                if (/"name"\s*:\s*"ide-cli"/.test(raw)) {
                    pkgDir = dir;
                    break;
                }
            }
            catch {
                /* keep walking */
            }
            const parent = path.dirname(dir);
            if (parent === dir) {
                break;
            }
            dir = parent;
        }
    }
    if (pkgDir) {
        return path.resolve(pkgDir, "..", "ide-code");
    }
    return undefined;
}
function freePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.on("error", reject);
        srv.listen(0, "127.0.0.1", () => {
            const addr = srv.address();
            srv.close(() => {
                if (addr && typeof addr === "object") {
                    resolve(addr.port);
                }
                else {
                    reject(new Error("could not allocate a free port"));
                }
            });
        });
    });
}
/** Defensive normalization of the engine's Session.Info shape. */
function normalizeSessionInfo(s) {
    const time = s?.time && typeof s.time === "object" ? s.time : {};
    const num = (v) => typeof v === "number" && Number.isFinite(v) ? v : undefined;
    return {
        id: typeof s?.id === "string" ? s.id : "",
        title: typeof s?.title === "string" ? s.title : "",
        createdAt: num(time.created),
        updatedAt: num(time.updated),
    };
}
class EngineClient {
    enginePath;
    proc;
    token;
    port = 0;
    host = "127.0.0.1";
    extraHeaders;
    spawnFn;
    readyTimeoutMs;
    injected;
    constructor(enginePath, opts) {
        this.enginePath = enginePath;
        this.extraHeaders = opts.extraHeaders ?? {};
        this.spawnFn = opts.spawn ?? childProcess.spawn;
        this.readyTimeoutMs = opts.readyTimeoutMs ?? 30_000;
        this.injected = opts.connection;
        if (this.injected) {
            this.port = this.injected.port;
            this.token = this.injected.token;
        }
    }
    /** Spawn the sidecar (or validate the injected connection) and wait for readiness. */
    static async start(opts) {
        const client = new EngineClient(opts.enginePath, opts);
        await client.startServer();
        return client;
    }
    /** Wrap an already-running engine — used by tests against a mock server. */
    static forConnection(conn, extraHeaders) {
        const client = new EngineClient(undefined, { connection: conn, extraHeaders });
        return client;
    }
    get serverPort() {
        return this.port;
    }
    authHeaders() {
        if (!this.token) {
            return {};
        }
        const credentials = Buffer.from(`opencode:${this.token}`).toString("base64");
        return { Authorization: `Basic ${credentials}` };
    }
    async startServer() {
        if (this.injected) {
            // Validate the injected connection the same way the real path validates spawn.
            await this.probeReady();
            return;
        }
        const enginePath = this.enginePath;
        if (!enginePath) {
            throw new EngineStartError("could not start IDE Code engine (no engine path: pass --engine-path, " +
                "set IDE_CODE_ENGINE_PATH, or place the ide-code repo next to ide-cli)");
        }
        const entry = path.join(enginePath, "packages", "cli", "src", "index.ts");
        if (!fs.existsSync(entry)) {
            throw new EngineStartError(`could not start IDE Code engine (invalid engine path ${enginePath}: ` +
                `missing packages/cli/src/index.ts)`);
        }
        this.port = await freePort();
        this.token = crypto.randomBytes(32).toString("hex");
        const args = [entry, "serve", "--port", String(this.port), "--hostname", "127.0.0.1"];
        let proc;
        try {
            proc = this.spawnFn("bun", args, {
                cwd: enginePath,
                stdio: ["ignore", "pipe", "pipe"],
                env: {
                    ...process.env,
                    NO_COLOR: "1",
                    OPENCODE_PASSWORD: this.token,
                    ...subagentNestingDefaultEnv(),
                },
            });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            throw new EngineStartError(`could not start IDE Code engine (spawn failed: ${msg})`);
        }
        this.proc = proc;
        let spawnFailed;
        proc.on("error", (err) => {
            spawnFailed = err.message;
        });
        proc.on("exit", (code) => {
            if (!spawnFailed && code !== 0 && code !== null) {
                spawnFailed = `exited with code ${code} before becoming ready`;
            }
        });
        proc.stdout?.resume();
        proc.stderr?.resume();
        const deadline = Date.now() + this.readyTimeoutMs;
        for (;;) {
            if (spawnFailed) {
                this.killProc();
                throw new EngineStartError(`could not start IDE Code engine (${spawnFailed}; is 'bun' installed and the engine path valid?)`);
            }
            try {
                await this.probeReady();
                return;
            }
            catch {
                if (Date.now() > deadline) {
                    this.killProc();
                    throw new EngineStartError("could not start IDE Code engine (did not become ready within 30s — " +
                        "check that 'bun' runs and the engine source is intact)");
                }
                await sleep(400);
            }
        }
    }
    async probeReady() {
        const res = await this.rawApi("GET", "/api/config", undefined);
        if (res.statusCode < 200 || res.statusCode >= 300) {
            throw new Error(`readiness probe returned HTTP ${res.statusCode}`);
        }
    }
    killProc() {
        try {
            this.proc?.kill("SIGKILL");
        }
        catch {
            /* already dead */
        }
        this.proc = undefined;
    }
    /** Stop the sidecar. Safe to call when the client was injected (no-op). */
    close() {
        this.killProc();
    }
    rawApi(method, pathStr, body) {
        return new Promise((resolve, reject) => {
            const payload = body === undefined ? undefined : JSON.stringify(body);
            const req = http.request({
                host: this.host,
                port: this.port,
                path: pathStr,
                method,
                headers: {
                    "Content-Type": "application/json",
                    ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
                    ...this.authHeaders(),
                    ...this.extraHeaders,
                },
            }, (res) => {
                let data = "";
                const MAX_BODY = 10 * 1024 * 1024;
                res.on("data", (c) => {
                    data += c.toString();
                    if (data.length > MAX_BODY) {
                        req.destroy(new Error("response body exceeded 10MB cap"));
                        reject(new Error(`${method} ${pathStr} → response body exceeded 10MB cap`));
                    }
                });
                res.on("end", () => resolve({ statusCode: res.statusCode ?? 0, body: data }));
                res.on("error", reject);
            });
            req.on("error", reject);
            req.setTimeout(60_000, () => {
                req.destroy(new Error(`${method} ${pathStr} timed out`));
                reject(new Error(`${method} ${pathStr} timed out`));
            });
            if (payload) {
                req.write(payload);
            }
            req.end();
        });
    }
    async api(method, pathStr, body) {
        const { statusCode, body: raw } = await this.rawApi(method, pathStr, body);
        if (statusCode < 200 || statusCode >= 300) {
            throw new Error(`${method} ${pathStr} → HTTP ${statusCode}: ${raw.slice(0, 300)}`);
        }
        if (!raw) {
            return undefined;
        }
        try {
            return JSON.parse(raw);
        }
        catch {
            throw new Error(`${method} ${pathStr} → invalid JSON response`);
        }
    }
    /**
     * POST /api/session. Accepts the same fields the extension passes
     * (protocol/src/groups/session.ts: id?, parentID?, title?, agent?, model?,
     * location?, metadata?, permissions?). Returns the session id.
     *
     * parentID is passed through verbatim: when the engine honors it the new
     * session branches from that session's history; when it doesn't, the
     * session simply starts fresh (the field is part of the documented
     * protocol, so sending it is never wrong).
     */
    async createSession(input) {
        const res = await this.api("POST", "/api/session", {
            title: input.title,
            ...(input.model ? { model: input.model } : {}),
            ...(input.permissions ? { permissions: input.permissions } : {}),
            ...(input.parentID ? { parentID: input.parentID } : {}),
        });
        const sessionID = res?.data?.id;
        if (typeof sessionID !== "string" || sessionID.length === 0) {
            throw new Error(`engine returned an invalid session id: ${JSON.stringify(res?.data).slice(0, 200)}`);
        }
        return sessionID;
    }
    /** POST /api/session/:id/prompt { text }. */
    async prompt(sessionID, text) {
        await this.api("POST", `/api/session/${sessionID}/prompt`, { text });
    }
    /** POST /api/session/:id/model { model } — switch model mid-session. */
    async switchModel(sessionID, model) {
        await this.api("POST", `/api/session/${sessionID}/model`, { model });
    }
    /** DELETE /api/session/:id — delete a session and its children. */
    async removeSession(sessionID) {
        await this.api("DELETE", `/api/session/${sessionID}`);
    }
    /** POST /api/session/:id/compact — request session compaction. */
    async compactSession(sessionID) {
        return this.api("POST", `/api/session/${sessionID}/compact`, {});
    }
    /** POST /api/session/:id/permission/:reqID/reply { decision }. */
    async replyPermission(sessionID, requestID, decision) {
        await this.api("POST", `/api/session/${sessionID}/permission/${requestID}/reply`, {
            decision,
        });
    }
    /**
     * GET /api/session?limit=N → { data: Session.Info[] }. Normalized
     * defensively: the CLI only needs id/title/timestamps.
     */
    async listSessions(limit = 100) {
        const res = await this.api("GET", `/api/session?limit=${limit}`);
        const raw = Array.isArray(res?.data) ? res.data : [];
        return raw
            .filter((s) => !!s && typeof s === "object")
            .map((s) => normalizeSessionInfo(s))
            .filter((s) => s.id.length > 0);
    }
    /**
     * GET /api/config → the engine's raw config document. The CLI only uses
     * this as a readiness probe today; /mcp additionally scans it for an MCP
     * server section (defensively — the engine documents no MCP endpoint).
     */
    async getConfig() {
        return this.api("GET", "/api/config", undefined);
    }
    /**
     * GET /api/session/:id → { data: Session.Info }. Throws when the engine
     * answers 404 — used by `persist attach` to fail fast on stale ids.
     */
    async getSessionInfo(sessionID) {
        const res = await this.api("GET", `/api/session/${sessionID}`);
        const info = normalizeSessionInfo(res?.data);
        if (!info.id) {
            throw new Error(`session ${JSON.stringify(sessionID)} not found on the engine`);
        }
        return info;
    }
    /**
     * GET /api/model → { data: Model.Info[] } (the adapter also tolerates a
     * bare array). Normalized to { id, modelID, providerID, name }.
     */
    async listModels() {
        const res = await this.api("GET", "/api/model");
        const raw = Array.isArray(res) ? res : Array.isArray(res?.data) ? res.data : [];
        return raw
            .filter((m) => !!m && typeof m === "object")
            .map((m) => ({
            id: String(m.id ?? m.modelID ?? ""),
            modelID: String(m.modelID ?? m.id ?? ""),
            providerID: String(m.providerID ?? ""),
            name: String(m.name ?? m.id ?? ""),
        }))
            .filter((m) => m.id.length > 0);
    }
    /**
     * GET /api/event — the global SSE stream. Frames are `data: {...}\n\n`
     * (no `event:` line); heartbeats (": heartbeat") are skipped.
     * Returns an unsubscribe function.
     */
    subscribeEvents(onEvent) {
        const req = http.request({
            host: this.host,
            port: this.port,
            path: "/api/event",
            method: "GET",
            headers: { ...this.authHeaders(), ...this.extraHeaders },
        }, (res) => {
            if (res.statusCode !== 200) {
                onEvent({
                    type: "cli.stream-error",
                    data: { message: `GET /api/event → HTTP ${res.statusCode}` },
                });
                return;
            }
            let buffer = "";
            res.on("data", (chunk) => {
                buffer += chunk.toString();
                for (;;) {
                    const idx = buffer.indexOf("\n\n");
                    if (idx < 0) {
                        break;
                    }
                    const frame = buffer.slice(0, idx);
                    buffer = buffer.slice(idx + 2);
                    const ev = parseSseFrame(frame);
                    if (ev) {
                        onEvent(ev);
                    }
                }
            });
        });
        req.on("error", (err) => {
            onEvent({ type: "cli.stream-error", data: { message: err.message } });
        });
        req.end();
        let closed = false;
        return () => {
            if (!closed) {
                closed = true;
                req.destroy();
            }
        };
    }
}
exports.EngineClient = EngineClient;
/**
 * DEV-GAPS-40 (subagent-nested): Cursor allows one nested subagent level
 * (main → subagent → sub-subagent); the engine's default
 * (`experimental.subagent_depth = 1`) forbids it. Returns
 * `{ OPENCODE_CONFIG_CONTENT: '{"experimental":{"subagent_depth":2}}' }`
 * as the IDE default — ONLY when the user has not configured the key
 * themselves (in any opencode.json[c] or via the env var). Otherwise
 * returns {} so explicit user configuration always wins.
 *
 * Mirror of extensions/ide-agent/src/services/subagentNesting.ts
 * (duplicated here because ide-cli must stay vscode-free — same pattern
 * as parseSseFrame above). Keep the two in sync.
 */
function subagentNestingDefaultEnv(env = process.env) {
    const existing = env.OPENCODE_CONFIG_CONTENT;
    if (existing !== undefined && existing !== "") {
        return {};
    }
    const globalDir = env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME)
        ? path.join(env.XDG_CONFIG_HOME, "opencode")
        : path.join(os.homedir(), ".config", "opencode");
    const candidates = [];
    for (const name of ["opencode.json", "opencode.jsonc"]) {
        candidates.push(path.join(globalDir, name));
        candidates.push(path.join(process.cwd(), name));
    }
    if (env.OPENCODE_CONFIG) {
        candidates.push(env.OPENCODE_CONFIG);
    }
    for (const file of candidates) {
        let text;
        try {
            text = fs.readFileSync(file, "utf8");
        }
        catch {
            continue;
        }
        // Defensive: a commented-out key also counts (fail-safe — skipping
        // the injection keeps the engine's stricter default).
        if (/"subagent_depth"\s*:/.test(text)) {
            return {};
        }
    }
    return {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ experimental: { subagent_depth: 2 } }),
    };
}
/**
 * Session-level permission ruleset for read-only modes (plan/ask).
 * Mirrors extensions/ide-agent/src/services/modeService.ts
 * `sessionPermissionsForMode` — the same ruleset the extension posts in
 * session.create, so plan/ask in the CLI behaves like plan/ask in the IDE.
 * The engine's Permission.evaluate uses findLast, so session rules override
 * agent rules; denied() hard-blocks with NO permission.asked event.
 */
function readOnlySessionPermissions() {
    const rules = [
        { action: "edit", resource: "*", effect: "deny" },
        { action: "shell", resource: "*", effect: "deny" },
        { action: "subagent", resource: "*", effect: "deny" },
        { action: "skill", resource: "*", effect: "deny" },
        // MCP tools: deny-by-default (real MCP names are compound like
        // mcp__filesystem__write_file); the read-only allowlist is appended
        // AFTER the blanket deny so findLast re-allows observation tools.
        { action: "mcp__*", resource: "*", effect: "deny" },
    ];
    for (const tool of READ_ONLY_MCP_TOOL_NAMES) {
        rules.push({ action: `mcp__*__${tool}`, resource: "*", effect: "allow" });
    }
    for (const prefix of READ_ONLY_MCP_TOOL_PREFIXES) {
        rules.push({ action: `mcp__*__${prefix}*`, resource: "*", effect: "allow" });
    }
    return rules;
}
/** Read-only MCP tool names — copied from modeService.ts (same product). */
const READ_ONLY_MCP_TOOL_NAMES = new Set([
    "read",
    "read_file",
    "read_text_file",
    "read_media_file",
    "read_multiple_files",
    "read_resource",
    "list_directory",
    "list_directory_with_sizes",
    "list_allowed_directories",
    "list_resources",
    "list_resource_templates",
    "directory_tree",
    "search",
    "search_files",
    "get_file_info",
    "read_graph",
    "search_nodes",
    "open_nodes",
    "screenshot",
    "snapshot",
    "browser_screenshot",
    "browser_snapshot",
    "fetch",
    "git_status",
    "git_log",
    "git_diff",
    "git_diff_unstaged",
    "git_diff_staged",
    "git_show",
]);
const READ_ONLY_MCP_TOOL_PREFIXES = ["get_"];
/**
 * Fail-safe classifier for the non-TTY permission rule: an action is
 * considered read-only only when it is observation-shaped. Anything else
 * (edit/shell/subagent/skill, mutating MCP tools) is treated as mutating.
 * Mirrors modeService.ts isMutatingToolAction, inverted.
 */
function isReadOnlyAction(action) {
    const lower = action.toLowerCase();
    if (MUTATING_TOOL_ACTIONS.has(lower)) {
        return false;
    }
    if (lower.startsWith("mcp__")) {
        const parts = lower.split("__");
        if (parts.length < 3) {
            return false;
        }
        const tool = parts.slice(2).join("__");
        if (READ_ONLY_MCP_TOOL_NAMES.has(tool)) {
            return true;
        }
        if (READ_ONLY_MCP_TOOL_PREFIXES.some((p) => tool.startsWith(p))) {
            return true;
        }
        return false;
    }
    return READ_ONLY_ACTIONS.has(lower);
}
const MUTATING_TOOL_ACTIONS = new Set([
    "edit",
    "write",
    "delete",
    "patch",
    "opencode",
    "plan-create",
    "shell",
    "subagent",
    "skill",
]);
const READ_ONLY_ACTIONS = new Set([
    "read",
    "glob",
    "grep",
    "ls",
    "webfetch",
    "websearch",
    "question",
    "todo",
    "communicate",
    "await",
    "switchmode",
    "summary",
]);
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
