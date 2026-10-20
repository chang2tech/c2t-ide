"use strict";
/**
 * run-agent-cli-tests.ts — node:test suite for the agent CLI.
 *
 * Tests run against a MOCK engine HTTP server (plain node:http) that
 * implements the real wire protocol (same endpoints/auth/SSE format as the
 * production sidecar): no real `bun` is ever spawned. Spawn is dependency-
 * injected via runAgent's clientFactory.
 *
 * Run: npx tsc && node --test out/test/run-agent-cli-tests.js
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
const node_assert_1 = require("node:assert");
const node_stream_1 = require("node:stream");
const node_test_1 = require("node:test");
const http = __importStar(require("node:http"));
const fs = __importStar(require("node:fs"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const readline = __importStar(require("node:readline"));
const node_stream_2 = require("node:stream");
const engine_1 = require("../agent/engine");
const cli_1 = require("../agent/cli");
const sessions_1 = require("../agent/sessions");
const hooks_1 = require("../agent/hooks");
const plugins_1 = require("../agent/plugins");
const tui_1 = require("../agent/tui");
const slash_1 = require("../agent/slash");
const agent_config_1 = require("../agent/agent-config");
const workspaces_1 = require("../agent/workspaces");
function startMockEngine() {
    const replies = [];
    const sessionBodies = [];
    const promptSessionIDs = [];
    const deletedIDs = [];
    const compactedIDs = [];
    const mock = {
        port: 0,
        replies,
        sessionBodies,
        promptSessionIDs,
        deletedIDs,
        compactedIDs,
        lastAuthHeader: undefined,
        close: async () => { },
    };
    let emitSse;
    let replyWaiters = [];
    const frame = (type, data) => `data: ${JSON.stringify({ id: `e${Date.now()}${Math.random()}`, type, data })}\n\n`;
    const server = http.createServer((req, res) => {
        const url = req.url ?? "";
        mock.lastAuthHeader = req.headers.authorization;
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
            const json = (code, obj) => {
                res.writeHead(code, { "Content-Type": "application/json" });
                res.end(JSON.stringify(obj));
            };
            if (req.method === "GET" && url === "/api/config") {
                return json(200, {});
            }
            if (req.method === "GET" && url === "/api/model") {
                return json(200, {
                    data: [{ id: "m1", modelID: "m1", providerID: "p1", name: "Test Model 1" }],
                });
            }
            if (req.method === "POST" && url === "/api/session") {
                mock.sessionBodies.push(body ? JSON.parse(body) : {});
                return json(200, { data: { id: "ses_test" } });
            }
            const promptMatch = /^\/api\/session\/([^/]+)\/prompt$/.exec(url);
            if (req.method === "POST" && promptMatch) {
                const payload = body ? JSON.parse(body) : {};
                const text = payload.text ?? "";
                mock.promptSessionIDs.push(promptMatch[1]);
                // Emit the scripted turn after the event-stream subscriber is in place.
                setTimeout(() => {
                    const send = emitSse;
                    if (!send) {
                        return;
                    }
                    const sid = "ses_test";
                    const finish = () => {
                        send("session.text.delta", { sessionID: sid, delta: "hello " });
                        send("session.text.delta", { sessionID: sid, delta: "world" });
                        send("session.execution.succeeded", { sessionID: sid });
                    };
                    if (text.includes("SUBAGENT")) {
                        // A delegated subagent outlives the main execution: the drain
                        // must wait for session.subagent.ended before turn.end.
                        send("session.subagent.started", { sessionID: sid, id: "sub1" });
                        setTimeout(() => {
                            send("session.text.delta", { sessionID: sid, delta: "hello " });
                            send("session.text.delta", { sessionID: sid, delta: "world" });
                            send("session.execution.succeeded", { sessionID: sid });
                        }, 60);
                        setTimeout(() => {
                            send("session.subagent.ended", { sessionID: sid, id: "sub1" });
                        }, 250);
                        return;
                    }
                    if (text.includes("PERM")) {
                        send("permission.asked", {
                            id: "req1",
                            sessionID: sid,
                            action: text.includes("shell") ? "shell" : "mcp__x__write_file",
                            resources: ["/tmp/x"],
                            message: `run ${text.includes("shell") ? "shell" : "mcp tool"}`,
                        });
                        // Wait for the reply before finishing the turn (bounded).
                        const deadline = setTimeout(finish, 3000);
                        replyWaiters.push(() => {
                            clearTimeout(deadline);
                            setTimeout(finish, 20);
                        });
                    }
                    else {
                        setTimeout(finish, 20);
                    }
                }, 30);
                return json(200, { data: { id: "msg1" } });
            }
            const replyMatch = /^\/api\/session\/([^/]+)\/permission\/([^/]+)\/reply$/.exec(url);
            if (req.method === "POST" && replyMatch) {
                const payload = body ? JSON.parse(body) : {};
                replies.push({ reqID: replyMatch[2], decision: String(payload.decision ?? "") });
                for (const w of replyWaiters) {
                    w();
                }
                replyWaiters = [];
                return json(200, {});
            }
            const compactMatch = /^\/api\/session\/([^/]+)\/compact$/.exec(url);
            if (req.method === "POST" && compactMatch) {
                mock.compactedIDs.push(compactMatch[1]);
                return json(200, {});
            }
            const sessMatch = /^\/api\/session\/([^/]+)$/.exec(url);
            if (sessMatch && req.method === "GET") {
                // getSessionInfo — only the mock's known session exists.
                if (sessMatch[1] === "ses_test") {
                    return json(200, { data: { id: "ses_test", title: "Test session" } });
                }
                return json(404, { error: "session not found" });
            }
            if (sessMatch && req.method === "DELETE") {
                mock.deletedIDs.push(sessMatch[1]);
                return json(200, {});
            }
            if (req.method === "GET" && url === "/api/event") {
                res.writeHead(200, {
                    "Content-Type": "text/event-stream",
                    "Cache-Control": "no-cache",
                    Connection: "keep-alive",
                });
                res.write(": heartbeat\n\n");
                emitSse = (type, data) => {
                    try {
                        res.write(frame(type, data));
                    }
                    catch {
                        /* client gone */
                    }
                };
                return;
            }
            json(404, { error: "not found" });
        });
    });
    return new Promise((resolve, reject) => {
        server.listen(0, "127.0.0.1", () => {
            const addr = server.address();
            if (!addr || typeof addr !== "object") {
                reject(new Error("mock engine failed to listen"));
                return;
            }
            mock.port = addr.port;
            mock.close = () => new Promise((r) => {
                server.close(() => r());
            });
            resolve(mock);
        });
    });
}
function capture() {
    let text = "";
    const stream = new node_stream_1.Writable({
        write(chunk, _enc, cb) {
            text += chunk.toString();
            cb();
        },
    });
    return { stream, get text() { return text; } };
}
function clientFactoryFor(mock) {
    return (_opts) => Promise.resolve(engine_1.EngineClient.forConnection({ host: "127.0.0.1", port: mock.port, token: "t".repeat(64) }));
}
// ---------------------------------------------------------------------------
// Hermetic local state
// ---------------------------------------------------------------------------
// Registry/plugin/hook/config writes in these tests must never touch the
// real ~/.ide-code. One temp home per file is enough: individual tests
// reset the JSON files they use via resetLocalState().
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ide-cli-test-"));
process.env.IDE_CODE_HOME = TEST_HOME;
function resetLocalState() {
    for (const f of ["agent-sessions.json", "plugins.json", "hooks.json", "agent-config.json"]) {
        try {
            fs.rmSync(path.join(TEST_HOME, ".ide-code", f));
        }
        catch {
            /* already absent */
        }
    }
    try {
        fs.rmSync(path.join(TEST_HOME, ".ide-code", "plugins"), { recursive: true, force: true });
    }
    catch {
        /* already absent */
    }
}
function seedSession(id, extra = {}) {
    (0, sessions_1.recordSession)({
        id,
        title: `Test ${id}`,
        createdAt: Date.now() - 1000,
        lastUsedAt: Date.now() - 1000,
        cwd: "/tmp/work",
        mode: "agent",
        ...extra,
    });
}
function writeHooksFile(obj) {
    const dir = path.join(TEST_HOME, ".ide-code");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "hooks.json"), JSON.stringify(obj), "utf8");
}
/** Fake git spawn for plugin tests: canned exit code + stderr. */
function fakeGitSpawn(code, stderr = "") {
    return ((_cmd, _args, _opts) => {
        const { EventEmitter } = require("node:events");
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        setImmediate(() => {
            if (stderr) {
                child.stderr.emit("data", Buffer.from(stderr));
            }
            child.emit("close", code);
        });
        return child;
    });
}
// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------
(0, node_test_1.test)("parseArgs: -p with value and flags", () => {
    const r = (0, cli_1.parseArgs)(["-p", "hello", "--force", "--output-format", "json"]);
    node_assert_1.strict.ok("flags" in r);
    node_assert_1.strict.equal(r.flags.print, "hello");
    node_assert_1.strict.equal(r.flags.force, true);
    node_assert_1.strict.equal(r.flags.outputFormat, "json");
});
(0, node_test_1.test)("parseArgs: -p without value takes positional prompt", () => {
    const r = (0, cli_1.parseArgs)(["-p", "--yolo", "fix", "the", "bug"]);
    node_assert_1.strict.ok("flags" in r);
    node_assert_1.strict.equal(r.flags.print, "fix the bug");
    node_assert_1.strict.equal(r.flags.force, true);
    node_assert_1.strict.deepEqual(r.flags.positional, []);
});
(0, node_test_1.test)("parseArgs: --print=value form", () => {
    const r = (0, cli_1.parseArgs)(["--print=hi"]);
    node_assert_1.strict.ok("flags" in r);
    node_assert_1.strict.equal(r.flags.print, "hi");
});
(0, node_test_1.test)("parseArgs: all real flags", () => {
    const r = (0, cli_1.parseArgs)([
        "--stream-partial-output",
        "--trust",
        "--approve-mcps",
        "--plan",
        "--model",
        "p1/m1",
        "--mode",
        "ask",
        "-H",
        "X-A: 1",
        "-H",
        "X-B:2",
        "--engine-path",
        "/tmp/e",
        "--timeout",
        "5000",
    ]);
    node_assert_1.strict.ok("flags" in r);
    node_assert_1.strict.equal(r.flags.streamPartialOutput, true);
    node_assert_1.strict.equal(r.flags.trust, true);
    node_assert_1.strict.equal(r.flags.approveMcps, true);
    node_assert_1.strict.equal(r.flags.mode, "ask"); // --plan then --mode ask: last one wins
    node_assert_1.strict.equal(r.flags.model, "p1/m1");
    node_assert_1.strict.deepEqual(r.flags.headers, { "X-A": "1", "X-B": "2" });
    node_assert_1.strict.equal(r.flags.enginePath, "/tmp/e");
    node_assert_1.strict.equal(r.flags.timeoutMs, 5000);
});
(0, node_test_1.test)("parseArgs: invalid values are rejected", () => {
    node_assert_1.strict.ok("error" in (0, cli_1.parseArgs)(["--output-format", "yaml"]));
    node_assert_1.strict.ok("error" in (0, cli_1.parseArgs)(["--mode", "turbo"]));
    node_assert_1.strict.ok("error" in (0, cli_1.parseArgs)(["--timeout", "nope"]));
    node_assert_1.strict.ok("error" in (0, cli_1.parseArgs)(["-H"]));
    node_assert_1.strict.ok("error" in (0, cli_1.parseArgs)(["-H", "no-colon"]));
    node_assert_1.strict.ok("error" in (0, cli_1.parseArgs)(["--mystery"]));
});
(0, node_test_1.test)("parseArgs: unsupported Cursor flags fail honestly", () => {
    for (const argv of [
        ["--sandbox", "enabled"],
        ["--api-key", "k"],
        ["-w"],
        ["--worktree", "x"],
        ["--worktree-base", "main"],
        ["--skip-worktree-setup"],
    ]) {
        const r = (0, cli_1.parseArgs)(argv);
        node_assert_1.strict.ok("error" in r, `expected error for ${argv.join(" ")}`);
    }
});
(0, node_test_1.test)("parseArgs: subcommands", () => {
    const s = (0, cli_1.parseArgs)(["status"]);
    node_assert_1.strict.ok("flags" in s && s.flags.subcommand === "status");
    const l = (0, cli_1.parseArgs)(["login"]);
    node_assert_1.strict.ok("flags" in l && l.flags.subcommand === "login");
    // "--" terminator: status is positional, not a subcommand
    const t = (0, cli_1.parseArgs)(["--", "status"]);
    node_assert_1.strict.ok("flags" in t && t.flags.subcommand === undefined);
    node_assert_1.strict.deepEqual(t.flags.positional, ["status"]);
});
// ---------------------------------------------------------------------------
// Print mode
// ---------------------------------------------------------------------------
(0, node_test_1.test)("print mode: text output is the final answer only, exit 0", async () => {
    const mock = await startMockEngine();
    const out = capture();
    const err = capture();
    const code = await (0, cli_1.runAgent)(["-p", "hello"], {
        out: out.stream,
        err: err.stream,
        isTTY: false,
        clientFactory: clientFactoryFor(mock),
    });
    node_assert_1.strict.equal(code, 0);
    node_assert_1.strict.equal(out.text.trim(), "hello world");
    node_assert_1.strict.ok(mock.sessionBodies[0].title.includes("print"));
    await mock.close();
});
(0, node_test_1.test)("print mode: --output-format json envelope shape", async () => {
    const mock = await startMockEngine();
    const out = capture();
    const err = capture();
    const code = await (0, cli_1.runAgent)(["-p", "hello", "--output-format", "json", "--model", "p1/m1"], {
        out: out.stream,
        err: err.stream,
        isTTY: false,
        clientFactory: clientFactoryFor(mock),
    });
    node_assert_1.strict.equal(code, 0);
    const env = JSON.parse(out.text.trim());
    node_assert_1.strict.equal(env.result, "hello world");
    node_assert_1.strict.equal(env.sessionID, "ses_test");
    node_assert_1.strict.equal(env.model, "p1/m1");
    node_assert_1.strict.equal(env.endKind, "succeeded");
    await mock.close();
});
(0, node_test_1.test)("print mode: stream-json emits deltas and turn.end", async () => {
    const mock = await startMockEngine();
    const out = capture();
    const err = capture();
    const code = await (0, cli_1.runAgent)(["-p", "hello", "--output-format", "stream-json", "--stream-partial-output"], { out: out.stream, err: err.stream, isTTY: false, clientFactory: clientFactoryFor(mock) });
    node_assert_1.strict.equal(code, 0);
    const lines = out.text.trim().split("\n").map((l) => JSON.parse(l));
    const types = lines.map((l) => l.type);
    node_assert_1.strict.ok(types.includes("turn.start"));
    const deltas = lines.filter((l) => l.type === "text.delta");
    node_assert_1.strict.equal(deltas.map((d) => d.delta).join(""), "hello world");
    const end = lines.find((l) => l.type === "turn.end");
    node_assert_1.strict.equal(end.endKind, "succeeded");
    node_assert_1.strict.equal(end.result, "hello world");
    await mock.close();
});
(0, node_test_1.test)("print mode: --yolo auto-approves permission.asked", async () => {
    const mock = await startMockEngine();
    const out = capture();
    const err = capture();
    const code = await (0, cli_1.runAgent)(["-p", "--yolo", "PERM", "shell"], {
        out: out.stream,
        err: err.stream,
        isTTY: false,
        clientFactory: clientFactoryFor(mock),
    });
    node_assert_1.strict.equal(code, 0);
    node_assert_1.strict.equal(mock.replies.length, 1);
    node_assert_1.strict.equal(mock.replies[0].reqID, "req1");
    node_assert_1.strict.equal(mock.replies[0].decision, "once");
    await mock.close();
});
(0, node_test_1.test)("print mode: non-TTY without --force denies mutating actions (fail-safe)", async () => {
    const mock = await startMockEngine();
    const out = capture();
    const err = capture();
    const code = await (0, cli_1.runAgent)(["-p", "PERM shell"], {
        out: out.stream,
        err: err.stream,
        isTTY: false,
        clientFactory: clientFactoryFor(mock),
    });
    node_assert_1.strict.equal(code, 0);
    node_assert_1.strict.equal(mock.replies.length, 1);
    node_assert_1.strict.equal(mock.replies[0].decision, "reject");
    await mock.close();
});
(0, node_test_1.test)("print mode: --approve-mcps approves MCP tools", async () => {
    const mock = await startMockEngine();
    const out = capture();
    const err = capture();
    const code = await (0, cli_1.runAgent)(["-p", "--approve-mcps", "PERM", "mcp"], {
        out: out.stream,
        err: err.stream,
        isTTY: false,
        clientFactory: clientFactoryFor(mock),
    });
    node_assert_1.strict.equal(code, 0);
    node_assert_1.strict.equal(mock.replies.length, 1);
    node_assert_1.strict.equal(mock.replies[0].decision, "once");
    await mock.close();
});
(0, node_test_1.test)("print mode: plan mode sends the read-only permission ruleset", async () => {
    const mock = await startMockEngine();
    const out = capture();
    const err = capture();
    const code = await (0, cli_1.runAgent)(["-p", "hello", "--plan"], {
        out: out.stream,
        err: err.stream,
        isTTY: false,
        clientFactory: clientFactoryFor(mock),
    });
    node_assert_1.strict.equal(code, 0);
    const perms = mock.sessionBodies[0].permissions;
    node_assert_1.strict.ok(Array.isArray(perms), "plan mode must send permissions");
    node_assert_1.strict.ok(perms.some((p) => p.action === "edit" && p.effect === "deny"));
    node_assert_1.strict.ok(perms.some((p) => p.action === "shell" && p.effect === "deny"));
    node_assert_1.strict.ok(perms.some((p) => p.action === "mcp__*" && p.effect === "deny"));
    node_assert_1.strict.ok(perms.some((p) => p.action === "mcp__*__read_file" && p.effect === "allow"));
    await mock.close();
});
(0, node_test_1.test)("print mode: extra headers are sent", async () => {
    const mock = await startMockEngine();
    const out = capture();
    const err = capture();
    await (0, cli_1.runAgent)(["status", "-H", "X-Test: yes"], {
        out: out.stream,
        err: err.stream,
        isTTY: false,
        clientFactory: (opts) => {
            node_assert_1.strict.equal(opts.extraHeaders?.["X-Test"], "yes");
            return clientFactoryFor(mock)(opts);
        },
    });
    await mock.close();
});
// ---------------------------------------------------------------------------
// status / login / errors
// ---------------------------------------------------------------------------
(0, node_test_1.test)("status: engine reachability + model list", async () => {
    const mock = await startMockEngine();
    const out = capture();
    const err = capture();
    const code = await (0, cli_1.runAgent)(["status"], {
        out: out.stream,
        err: err.stream,
        isTTY: false,
        clientFactory: clientFactoryFor(mock),
    });
    node_assert_1.strict.equal(code, 0);
    node_assert_1.strict.ok(out.text.includes("engine: reachable"));
    node_assert_1.strict.ok(out.text.includes("models: 1 available"));
    node_assert_1.strict.ok(out.text.includes("p1/m1"));
    await mock.close();
});
(0, node_test_1.test)("login/logout/update are refused honestly", async () => {
    for (const sub of ["login", "logout", "update"]) {
        const mock = await startMockEngine();
        const out = capture();
        const err = capture();
        const code = await (0, cli_1.runAgent)([sub], {
            out: out.stream,
            err: err.stream,
            isTTY: false,
            clientFactory: clientFactoryFor(mock),
        });
        node_assert_1.strict.equal(code, 1, sub);
        node_assert_1.strict.ok(err.text.includes("not supported"), sub);
        await mock.close();
    }
});
(0, node_test_1.test)("engine start failure → stderr + exit 1 (no fake result)", async () => {
    const out = capture();
    const err = capture();
    const code = await (0, cli_1.runAgent)(["-p", "hello"], {
        out: out.stream,
        err: err.stream,
        isTTY: false,
        clientFactory: () => Promise.reject(new engine_1.EngineStartError("could not start IDE Code engine (invalid engine path /bogus)")),
    });
    node_assert_1.strict.equal(code, 1);
    node_assert_1.strict.ok(err.text.includes("could not start IDE Code engine"));
    node_assert_1.strict.equal(out.text, "");
});
(0, node_test_1.test)("--help lists only implemented flags", async () => {
    const out = capture();
    const err = capture();
    // --help returns before any engine contact; the factory must never run.
    const code = await (0, cli_1.runAgent)(["--help"], {
        out: out.stream,
        err: err.stream,
        isTTY: false,
        clientFactory: () => Promise.reject(new Error("must not start the engine for --help")),
    });
    node_assert_1.strict.equal(code, 0);
    const help = out.text;
    for (const flag of [
        "--print",
        "--output-format",
        "--stream-partial-output",
        "--force",
        "--yolo",
        "--trust",
        "--approve-mcps",
        "--model",
        "--mode",
        "--plan",
        "--header",
        "--engine-path",
        "--timeout",
        "status",
    ]) {
        node_assert_1.strict.ok(help.includes(flag), `help should list ${flag}`);
    }
    // Deliberate omissions must not be listed as SUPPORTED flags. They are
    // documented (with reasons) in the "Deliberately not implemented" epilogue,
    // so scope the check to the Options section above it.
    const optionsSection = help.split("Deliberately not implemented")[0];
    node_assert_1.strict.ok(!optionsSection.includes("--sandbox"), "options must not list --sandbox");
    node_assert_1.strict.ok(!optionsSection.includes("--api-key"), "options must not list --api-key");
    node_assert_1.strict.ok(!optionsSection.includes("--worktree"), "options must not list --worktree");
    node_assert_1.strict.ok(!optionsSection.includes("login"), "options must not list login");
});
// ---------------------------------------------------------------------------
// Engine path resolution / SSE parser / slash commands
// ---------------------------------------------------------------------------
(0, node_test_1.test)("resolveEnginePath: env beats heuristic", () => {
    const prev = process.env.IDE_CODE_ENGINE_PATH;
    process.env.IDE_CODE_ENGINE_PATH = "/tmp/custom-engine";
    try {
        node_assert_1.strict.equal((0, engine_1.resolveEnginePath)("/whatever"), "/tmp/custom-engine");
    }
    finally {
        if (prev === undefined) {
            delete process.env.IDE_CODE_ENGINE_PATH;
        }
        else {
            process.env.IDE_CODE_ENGINE_PATH = prev;
        }
    }
});
(0, node_test_1.test)("resolveEnginePath: heuristic is <ide-cli>/../ide-code", () => {
    const prev = process.env.IDE_CODE_ENGINE_PATH;
    delete process.env.IDE_CODE_ENGINE_PATH;
    try {
        node_assert_1.strict.equal((0, engine_1.resolveEnginePath)("/home/u/vscode/ide-cli"), "/home/u/vscode/ide-code");
    }
    finally {
        if (prev !== undefined) {
            process.env.IDE_CODE_ENGINE_PATH = prev;
        }
    }
});
(0, node_test_1.test)("parseSseFrame: engine frame without event: line", () => {
    const ev = (0, engine_1.parseSseFrame)('data: {"id":"e1","type":"session.text.delta","data":{"delta":"hi"}}\n');
    node_assert_1.strict.ok(ev);
    node_assert_1.strict.equal(ev.type, "session.text.delta");
    node_assert_1.strict.equal(ev.data.delta, "hi");
});
(0, node_test_1.test)("parseSseFrame: heartbeat → undefined", () => {
    node_assert_1.strict.equal((0, engine_1.parseSseFrame)(": heartbeat\n"), undefined);
    node_assert_1.strict.equal((0, engine_1.parseSseFrame)(""), undefined);
});
(0, node_test_1.test)("parseSlashCommand", () => {
    node_assert_1.strict.deepEqual((0, tui_1.parseSlashCommand)("/sandbox"), { cmd: "sandbox", arg: "" });
    node_assert_1.strict.deepEqual((0, tui_1.parseSlashCommand)("/model p1/m1"), { cmd: "model", arg: "p1/m1" });
    node_assert_1.strict.equal((0, tui_1.parseSlashCommand)("hello"), undefined);
    // the CLI's interactive loop uses the same helper
    node_assert_1.strict.deepEqual((0, tui_1.parseSlashCommand)("/plan"), { cmd: "plan", arg: "" });
});
// ---------------------------------------------------------------------------
// New slash commands: parsing
// ---------------------------------------------------------------------------
(0, node_test_1.test)("parseSlashCommand: all new commands, aliases, case-insensitive", () => {
    node_assert_1.strict.deepEqual((0, slash_1.parseSlashCommand)("/btw what is x"), { cmd: "btw", arg: "what is x" });
    node_assert_1.strict.deepEqual((0, slash_1.parseSlashCommand)("/fork"), { cmd: "fork", arg: "" });
    node_assert_1.strict.deepEqual((0, slash_1.parseSlashCommand)("/branch"), { cmd: "branch", arg: "" });
    node_assert_1.strict.deepEqual((0, slash_1.parseSlashCommand)("/duplicate"), { cmd: "duplicate", arg: "" });
    node_assert_1.strict.deepEqual((0, slash_1.parseSlashCommand)("/rewind 2"), { cmd: "rewind", arg: "2" });
    node_assert_1.strict.deepEqual((0, slash_1.parseSlashCommand)("/undo"), { cmd: "undo", arg: "" });
    node_assert_1.strict.deepEqual((0, slash_1.parseSlashCommand)("/restore"), { cmd: "restore", arg: "" });
    node_assert_1.strict.deepEqual((0, slash_1.parseSlashCommand)("/usage"), { cmd: "usage", arg: "" });
    node_assert_1.strict.deepEqual((0, slash_1.parseSlashCommand)("/resume abc123"), { cmd: "resume", arg: "abc123" });
    node_assert_1.strict.deepEqual((0, slash_1.parseSlashCommand)("/detach"), { cmd: "detach", arg: "" });
    node_assert_1.strict.deepEqual((0, slash_1.parseSlashCommand)("/auto-review off"), { cmd: "auto-review", arg: "off" });
    node_assert_1.strict.deepEqual((0, slash_1.parseSlashCommand)("/mcp"), { cmd: "mcp", arg: "" });
    node_assert_1.strict.deepEqual((0, slash_1.parseSlashCommand)("/add-dir /tmp/x"), { cmd: "add-dir", arg: "/tmp/x" });
    node_assert_1.strict.deepEqual((0, slash_1.parseSlashCommand)("/save-workspace w1"), { cmd: "save-workspace", arg: "w1" });
    node_assert_1.strict.deepEqual((0, slash_1.parseSlashCommand)("/load-workspace w1"), { cmd: "load-workspace", arg: "w1" });
    node_assert_1.strict.deepEqual((0, slash_1.parseSlashCommand)("/config set trust on"), { cmd: "config", arg: "set trust on" });
    node_assert_1.strict.deepEqual((0, slash_1.parseSlashCommand)("/trust"), { cmd: "trust", arg: "" });
    node_assert_1.strict.deepEqual((0, slash_1.parseSlashCommand)("/OPUS"), { cmd: "opus", arg: "" });
    node_assert_1.strict.deepEqual((0, slash_1.parseSlashCommand)("/Composer"), { cmd: "composer", arg: "" });
    node_assert_1.strict.deepEqual((0, slash_1.parseSlashCommand)("/FAST"), { cmd: "fast", arg: "" });
    node_assert_1.strict.deepEqual((0, slash_1.parseSlashCommand)("/skills"), { cmd: "skills", arg: "" });
    node_assert_1.strict.deepEqual((0, slash_1.parseSlashCommand)("/skill pdf"), { cmd: "skill", arg: "pdf" });
    // tui.ts re-exports the same parser
    node_assert_1.strict.deepEqual((0, tui_1.parseSlashCommand)("/btw hi"), { cmd: "btw", arg: "hi" });
});
// ---------------------------------------------------------------------------
// New slash commands: handlers driven by a fake SlashRuntime
// ---------------------------------------------------------------------------
/** Hermetic ~/.ide-code for one test; returns a cleanup function. */
function tempHome() {
    const prev = process.env.IDE_CODE_HOME;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ide-cli-slash-test-"));
    process.env.IDE_CODE_HOME = dir;
    return () => {
        if (prev === undefined) {
            delete process.env.IDE_CODE_HOME;
        }
        else {
            process.env.IDE_CODE_HOME = prev;
        }
        fs.rmSync(dir, { recursive: true, force: true });
    };
}
function fakeSlashRuntime(overrides = {}) {
    const out = capture();
    const err = capture();
    const calls = { setModel: [], compact: 0 };
    let autoReview = false;
    let trust = false;
    const rt = {
        out: out.stream,
        err: err.stream,
        getMode: () => "agent",
        setMode: async () => { },
        setModel: async (name) => {
            calls.setModel.push(name);
            return undefined;
        },
        statusLine: () => "session: ses_cur  mode: agent  model: (engine default)",
        autoDecidePermission: async () => undefined,
        promptPermission: async () => "reject",
        runTurnWith: async () => {
            throw new Error("runTurnWith must not be called by slash handlers");
        },
        runReadOnlyTurn: async (text, render) => {
            // Simulate the real streaming behavior: the answer arrives via deltas.
            const answer = `side answer to: ${text}`;
            render.onTextDelta(answer);
            return { text: answer, endKind: "succeeded" };
        },
        withTurnActive: async (fn) => fn(),
        currentSessionID: () => "ses_cur",
        forkCurrentSession: async () => ({ from: "ses_cur", to: "ses_fork" }),
        attachSession: async (id) => `title of ${id}`,
        detachCurrentSession: async () => ({ id: "ses_cur", title: "cur title" }),
        getEngineConfig: async () => ({}),
        listModels: async () => [],
        compactCurrentSession: async () => {
            calls.compact += 1;
            return "ses_cur";
        },
        getAutoReview: () => autoReview,
        setAutoReview: (on) => {
            autoReview = on;
        },
        getTrust: () => trust,
        setTrust: (on) => {
            trust = on;
        },
        listSkills: () => [],
        attachSkill: async () => ({ error: "no skill" }),
        setPendingSkill: (name, content) => {
            calls.pendingSkill = { name, content };
        },
        getTurnLog: () => [],
        ...overrides,
    };
    return {
        rt,
        calls,
        outText: () => out.text,
        errText: () => err.text,
        get autoReview() {
            return autoReview;
        },
        get trust() {
            return trust;
        },
    };
}
(0, node_test_1.test)("slash /help lists every new command", async () => {
    const f = fakeSlashRuntime();
    const action = await (0, slash_1.handleSlashCommand)({ cmd: "help", arg: "" }, f.rt);
    node_assert_1.strict.equal(action, "continue");
    for (const c of [
        "/btw", "/context", "/fork", "/rewind", "/usage", "/resume", "/detach",
        "/auto-review", "/mcp", "/add-dir", "/save-workspace", "/load-workspace",
        "/config", "/trust", "/opus", "/composer", "/fast", "/skills", "/skill",
        "/summarize",
    ]) {
        node_assert_1.strict.ok(f.outText().includes(c), `help should list ${c}`);
    }
});
(0, node_test_1.test)("slash /summarize compacts via the runtime; /compact and /compress aliases execute directly", async () => {
    for (const cmd of ["summarize", "compact", "compress"]) {
        const f = fakeSlashRuntime();
        const action = await (0, slash_1.handleSlashCommand)({ cmd, arg: "" }, f.rt);
        node_assert_1.strict.equal(action, "continue", cmd);
        node_assert_1.strict.equal(f.calls.compact, 1, `${cmd} must execute compaction directly`);
        node_assert_1.strict.ok(f.outText().includes("summarized session ses_cur"), f.outText());
        node_assert_1.strict.equal(f.errText(), "", f.errText());
    }
});
(0, node_test_1.test)("slash /summarize reports a compaction failure honestly", async () => {
    const f = fakeSlashRuntime({
        compactCurrentSession: async () => {
            throw new Error("no active session in this mode yet — send a message first, then /summarize");
        },
    });
    const action = await (0, slash_1.handleSlashCommand)({ cmd: "summarize", arg: "" }, f.rt);
    node_assert_1.strict.equal(action, "continue");
    node_assert_1.strict.ok(f.errText().includes("could not summarize the session"), f.errText());
    node_assert_1.strict.ok(f.errText().includes("no active session"), f.errText());
});
(0, node_test_1.test)("slash unknown command and /exit /quit", async () => {
    const f = fakeSlashRuntime();
    node_assert_1.strict.equal(await (0, slash_1.handleSlashCommand)({ cmd: "frobnicate", arg: "" }, f.rt), "continue");
    node_assert_1.strict.ok(f.errText().includes("unknown command"));
    node_assert_1.strict.equal(await (0, slash_1.handleSlashCommand)({ cmd: "exit", arg: "" }, f.rt), "exit");
    node_assert_1.strict.equal(await (0, slash_1.handleSlashCommand)({ cmd: "quit", arg: "" }, f.rt), "exit");
});
(0, node_test_1.test)("slash /btw runs a read-only side turn; main history untouched", async () => {
    const f = fakeSlashRuntime();
    const action = await (0, slash_1.handleSlashCommand)({ cmd: "btw", arg: "what is 2+2" }, f.rt);
    node_assert_1.strict.equal(action, "continue");
    node_assert_1.strict.ok(f.outText().includes("side answer to: what is 2+2"));
    node_assert_1.strict.ok(f.outText().includes("history untouched"));
});
(0, node_test_1.test)("slash /btw without a question prints usage and runs nothing", async () => {
    let readOnlyCalled = false;
    const f = fakeSlashRuntime({
        runReadOnlyTurn: async () => {
            readOnlyCalled = true;
            throw new Error("must not run");
        },
    });
    await (0, slash_1.handleSlashCommand)({ cmd: "btw", arg: "" }, f.rt);
    node_assert_1.strict.equal(readOnlyCalled, false);
    node_assert_1.strict.ok(f.errText().includes("usage: /btw"));
});
(0, node_test_1.test)("slash /context shows a local estimate and the honest limitation", async () => {
    const f = fakeSlashRuntime({
        getTurnLog: () => [
            { n: 1, promptPreview: "hello", at: Date.now(), endKind: "succeeded", toolCalls: 2 },
            { n: 2, promptPreview: "do it", at: Date.now(), endKind: "failed", toolCalls: 0 },
        ],
    });
    await (0, slash_1.handleSlashCommand)({ cmd: "context", arg: "" }, f.rt);
    const out = f.outText();
    node_assert_1.strict.ok(out.includes("turns:       2 (1 succeeded, 1 failed, 0 interrupted)"));
    node_assert_1.strict.ok(out.includes("tool calls:  2"));
    node_assert_1.strict.ok(out.includes("the engine exposes no usage API"));
    node_assert_1.strict.ok(out.includes("ses_cur"));
});
(0, node_test_1.test)("slash /rewind lists the timeline; restore is honestly unsupported", async () => {
    const f = fakeSlashRuntime({
        getTurnLog: () => [
            { n: 1, promptPreview: "hello", at: 1_700_000_000_000, endKind: "succeeded", toolCalls: 1 },
            { n: 2, promptPreview: "do the thing", at: 1_700_000_060_000, endKind: "interrupted", toolCalls: 0 },
        ],
    });
    await (0, slash_1.handleSlashCommand)({ cmd: "rewind", arg: "" }, f.rt);
    const out = f.outText();
    node_assert_1.strict.ok(out.includes("#1"));
    node_assert_1.strict.ok(out.includes("#2"));
    node_assert_1.strict.ok(out.includes("succeeded"));
    node_assert_1.strict.ok(out.includes("1 tool call"));
    node_assert_1.strict.ok(out.includes("no session-restore API"));
    // /rewind <n> (and the /undo alias) are refused honestly
    const f2 = fakeSlashRuntime();
    await (0, slash_1.handleSlashCommand)({ cmd: "rewind", arg: "1" }, f2.rt);
    node_assert_1.strict.ok(f2.errText().includes("no session-restore API"));
    const f3 = fakeSlashRuntime();
    await (0, slash_1.handleSlashCommand)({ cmd: "undo", arg: "" }, f3.rt);
    node_assert_1.strict.ok(f3.outText().includes("no turns yet"));
});
(0, node_test_1.test)("slash /fork branches the session (and aliases)", async () => {
    for (const cmd of ["fork", "branch", "duplicate"]) {
        const f = fakeSlashRuntime();
        node_assert_1.strict.equal(await (0, slash_1.handleSlashCommand)({ cmd, arg: "" }, f.rt), "continue");
        node_assert_1.strict.ok(f.outText().includes("ses_cur → ses_fork"), cmd);
        node_assert_1.strict.ok(f.outText().includes("parentID"), cmd);
    }
});
(0, node_test_1.test)("slash /fork with no active session errors honestly", async () => {
    const f = fakeSlashRuntime({
        forkCurrentSession: async () => {
            throw new Error("no active session in this mode yet");
        },
    });
    await (0, slash_1.handleSlashCommand)({ cmd: "fork", arg: "" }, f.rt);
    node_assert_1.strict.ok(f.errText().includes("no active session"));
});
(0, node_test_1.test)("slash /usage reports local stats with the no-cloud-billing note", async () => {
    const restore = tempHome();
    try {
        const f = fakeSlashRuntime();
        await (0, slash_1.handleSlashCommand)({ cmd: "usage", arg: "" }, f.rt);
        const out = f.outText();
        node_assert_1.strict.ok(out.includes("no cloud billing"));
        node_assert_1.strict.ok(out.includes("saved sessions:            0"));
        node_assert_1.strict.ok(out.includes("turns this TUI session:    0"));
    }
    finally {
        restore();
    }
});
(0, node_test_1.test)("slash /resume with an empty registry", async () => {
    const restore = tempHome();
    try {
        const f = fakeSlashRuntime();
        await (0, slash_1.handleSlashCommand)({ cmd: "resume", arg: "" }, f.rt);
        node_assert_1.strict.ok(f.outText().includes("no saved sessions yet"));
    }
    finally {
        restore();
    }
});
(0, node_test_1.test)("slash /resume lists, picks by number, and attaches", async () => {
    const restore = tempHome();
    try {
        (0, sessions_1.recordSession)({ id: "ses_aaa111", title: "first chat", createdAt: 1, lastUsedAt: 100, cwd: "/tmp", mode: "agent" });
        (0, sessions_1.recordSession)({ id: "ses_bbb222", title: "second chat", createdAt: 2, lastUsedAt: 200, cwd: "/tmp", mode: "plan" });
        const f = fakeSlashRuntime();
        await (0, slash_1.handleSlashCommand)({ cmd: "resume", arg: "" }, f.rt);
        const list = f.outText();
        node_assert_1.strict.ok(list.includes("ses_bbb222"), "most recent first");
        node_assert_1.strict.ok(list.indexOf("ses_bbb222") < list.indexOf("ses_aaa111"));
        let attached = "";
        f.rt.attachSession = async (id) => {
            attached = id;
            return "second chat";
        };
        await (0, slash_1.handleSlashCommand)({ cmd: "resume", arg: "1" }, f.rt);
        node_assert_1.strict.equal(attached, "ses_bbb222");
        node_assert_1.strict.ok(f.outText().includes("resumed session ses_bbb222"));
        // mode mismatch (plan session in agent view) is disclosed, not hidden
        node_assert_1.strict.ok(f.errText().includes("plan"));
        // id-prefix match
        const f2 = fakeSlashRuntime();
        let attached2 = "";
        f2.rt.attachSession = async (id) => {
            attached2 = id;
            return "first chat";
        };
        await (0, slash_1.handleSlashCommand)({ cmd: "resume", arg: "ses_aaa" }, f2.rt);
        node_assert_1.strict.equal(attached2, "ses_aaa111");
        // unknown id
        const f3 = fakeSlashRuntime();
        await (0, slash_1.handleSlashCommand)({ cmd: "resume", arg: "zzz" }, f3.rt);
        node_assert_1.strict.ok(f3.errText().includes("no saved session matches"));
    }
    finally {
        restore();
    }
});
(0, node_test_1.test)("slash /resume reports a stale engine session honestly", async () => {
    const restore = tempHome();
    try {
        (0, sessions_1.recordSession)({ id: "ses_gone", title: "gone", createdAt: 1, lastUsedAt: 1, cwd: "/tmp", mode: "agent" });
        const f = fakeSlashRuntime({
            attachSession: async () => {
                throw new Error('session "ses_gone" not found on the engine');
            },
        });
        await (0, slash_1.handleSlashCommand)({ cmd: "resume", arg: "ses_gone" }, f.rt);
        node_assert_1.strict.ok(f.errText().includes("no longer has session ses_gone"));
    }
    finally {
        restore();
    }
});
(0, node_test_1.test)("slash /detach saves the session and exits the loop", async () => {
    const f = fakeSlashRuntime();
    const action = await (0, slash_1.handleSlashCommand)({ cmd: "detach", arg: "" }, f.rt);
    node_assert_1.strict.equal(action, "exit");
    node_assert_1.strict.ok(f.outText().includes("ses_cur"));
    node_assert_1.strict.ok(f.outText().includes("/resume"));
});
(0, node_test_1.test)("slash /auto-review toggles, sets, and validates", async () => {
    const f = fakeSlashRuntime();
    await (0, slash_1.handleSlashCommand)({ cmd: "auto-review", arg: "" }, f.rt);
    node_assert_1.strict.equal(f.autoReview, true);
    node_assert_1.strict.ok(f.outText().includes("auto-review: on"));
    await (0, slash_1.handleSlashCommand)({ cmd: "auto-review", arg: "off" }, f.rt);
    node_assert_1.strict.equal(f.autoReview, false);
    node_assert_1.strict.ok(f.outText().includes("auto-review: off"));
    await (0, slash_1.handleSlashCommand)({ cmd: "auto-review", arg: "bogus" }, f.rt);
    node_assert_1.strict.ok(f.errText().includes("usage: /auto-review"));
});
(0, node_test_1.test)("slash /trust toggles with the honest no-gate note", async () => {
    const f = fakeSlashRuntime();
    await (0, slash_1.handleSlashCommand)({ cmd: "trust", arg: "" }, f.rt);
    node_assert_1.strict.equal(f.trust, true);
    node_assert_1.strict.ok(f.errText().includes("no workspace-trust gate"));
    await (0, slash_1.handleSlashCommand)({ cmd: "trust", arg: "off" }, f.rt);
    node_assert_1.strict.equal(f.trust, false);
});
(0, node_test_1.test)("slash /mcp is honest when the engine exposes no MCP list", async () => {
    const f = fakeSlashRuntime({ getEngineConfig: async () => ({}) });
    await (0, slash_1.handleSlashCommand)({ cmd: "mcp", arg: "" }, f.rt);
    node_assert_1.strict.ok(f.errText().includes("exposes no MCP server list"));
});
(0, node_test_1.test)("slash /mcp groups servers by scope when the engine reports them", async () => {
    const f = fakeSlashRuntime({
        getEngineConfig: async () => ({
            mcp: {
                filesystem: { type: "local" },
                github: { scope: "project", type: "remote" },
            },
        }),
    });
    await (0, slash_1.handleSlashCommand)({ cmd: "mcp", arg: "" }, f.rt);
    const out = f.outText();
    node_assert_1.strict.ok(out.includes("[local]"), out);
    node_assert_1.strict.ok(out.includes("[project]"), out);
    node_assert_1.strict.ok(out.includes("filesystem"), out);
    node_assert_1.strict.ok(out.includes("github"), out);
});
(0, node_test_1.test)("extractMcpServers: shapes and scope grouping", () => {
    node_assert_1.strict.equal((0, slash_1.extractMcpServers)(undefined), undefined);
    node_assert_1.strict.equal((0, slash_1.extractMcpServers)(null), undefined);
    node_assert_1.strict.equal((0, slash_1.extractMcpServers)({}), undefined);
    node_assert_1.strict.equal((0, slash_1.extractMcpServers)({ mcp: {} })?.length, 0);
    node_assert_1.strict.deepEqual((0, slash_1.extractMcpServers)({ mcp: { a: { type: "local" }, b: { scope: "user" } } }), [
        { name: "a", scope: "local" },
        { name: "b", scope: "user" },
    ]);
    node_assert_1.strict.deepEqual((0, slash_1.extractMcpServers)({ mcpServers: [{ name: "x" }, "y"] }), [
        { name: "x", scope: "default" },
        { name: "y", scope: "default" },
    ]);
});
(0, node_test_1.test)("slash /config show/get/set round-trip", async () => {
    const restore = tempHome();
    try {
        const f = fakeSlashRuntime();
        await (0, slash_1.handleSlashCommand)({ cmd: "config", arg: "" }, f.rt);
        node_assert_1.strict.ok(f.outText().includes("subagentModel"));
        node_assert_1.strict.ok(f.outText().includes("modelSlashCommands"));
        await (0, slash_1.handleSlashCommand)({ cmd: "config", arg: "set trust on" }, f.rt);
        node_assert_1.strict.equal((0, agent_config_1.loadAgentConfig)().trust, true);
        node_assert_1.strict.ok(f.outText().includes("set trust = on"));
        await (0, slash_1.handleSlashCommand)({ cmd: "config", arg: "get trust" }, f.rt);
        node_assert_1.strict.ok(f.outText().includes("trust = true"));
        await (0, slash_1.handleSlashCommand)({ cmd: "config", arg: "set subagentModel disabled" }, f.rt);
        node_assert_1.strict.equal((0, agent_config_1.loadAgentConfig)().subagentModel, "disabled");
        await (0, slash_1.handleSlashCommand)({ cmd: "config", arg: "set bogus on" }, f.rt);
        node_assert_1.strict.ok(f.errText().includes("unknown config key"));
        await (0, slash_1.handleSlashCommand)({ cmd: "config", arg: "set trust maybe" }, f.rt);
        node_assert_1.strict.ok(f.errText().includes("must be on|off"));
        await (0, slash_1.handleSlashCommand)({ cmd: "config", arg: "get" }, f.rt);
        node_assert_1.strict.ok(f.errText().includes("usage: /config get"));
    }
    finally {
        restore();
    }
});
(0, node_test_1.test)("slash /add-dir validates the path and records real directories", async () => {
    const restore = tempHome();
    try {
        const f = fakeSlashRuntime();
        await (0, slash_1.handleSlashCommand)({ cmd: "add-dir", arg: "/does/not/exist-xyz" }, f.rt);
        node_assert_1.strict.ok(f.errText().includes("directory not found"));
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-"));
        try {
            const f2 = fakeSlashRuntime();
            await (0, slash_1.handleSlashCommand)({ cmd: "add-dir", arg: dir }, f2.rt);
            node_assert_1.strict.ok(f2.outText().includes("added to workspace"));
            node_assert_1.strict.deepEqual((0, workspaces_1.workspaceDirs)(), [dir]);
            // no-arg form lists
            const f3 = fakeSlashRuntime();
            await (0, slash_1.handleSlashCommand)({ cmd: "add-dir", arg: "" }, f3.rt);
            node_assert_1.strict.ok(f3.outText().includes(dir));
        }
        finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }
    finally {
        restore();
    }
});
(0, node_test_1.test)("slash /save-workspace and /load-workspace round-trip", async () => {
    const restore = tempHome();
    const prevCwd = process.cwd();
    try {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-"));
        try {
            const f = fakeSlashRuntime();
            await (0, slash_1.handleSlashCommand)({ cmd: "add-dir", arg: dir }, f.rt);
            await (0, slash_1.handleSlashCommand)({ cmd: "save-workspace", arg: "proj" }, f.rt);
            node_assert_1.strict.ok((0, workspaces_1.listWorkspaceNames)().includes("proj"));
            node_assert_1.strict.ok(f.outText().includes('"proj"'));
            const f2 = fakeSlashRuntime();
            await (0, slash_1.handleSlashCommand)({ cmd: "load-workspace", arg: "proj" }, f2.rt);
            node_assert_1.strict.equal((0, workspaces_1.activeWorkspaceName)(), "proj");
            node_assert_1.strict.equal(process.cwd(), dir);
            node_assert_1.strict.ok(f2.outText().includes("cwd is now"));
            const f3 = fakeSlashRuntime();
            await (0, slash_1.handleSlashCommand)({ cmd: "load-workspace", arg: "nope" }, f3.rt);
            node_assert_1.strict.ok(f3.errText().includes("unknown workspace"));
            const f4 = fakeSlashRuntime();
            await (0, slash_1.handleSlashCommand)({ cmd: "save-workspace", arg: "" }, f4.rt);
            node_assert_1.strict.ok(f4.errText().includes("usage: /save-workspace"));
        }
        finally {
            process.chdir(prevCwd);
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }
    finally {
        restore();
    }
});
(0, node_test_1.test)("slash /opus /composer /fast map to the engine model list", async () => {
    const restore = tempHome();
    try {
        const models = [
            { id: "a", modelID: "claude-opus-4-1", providerID: "anthropic", name: "Claude Opus" },
            { id: "b", modelID: "gpt-5-mini", providerID: "openai", name: "GPT-5 mini" },
        ];
        const f = fakeSlashRuntime({ listModels: async () => models });
        await (0, slash_1.handleSlashCommand)({ cmd: "opus", arg: "" }, f.rt);
        node_assert_1.strict.deepEqual(f.calls.setModel, ["claude-opus-4-1"]);
        node_assert_1.strict.ok(f.outText().includes("via /opus"));
        const f2 = fakeSlashRuntime({ listModels: async () => models });
        await (0, slash_1.handleSlashCommand)({ cmd: "composer", arg: "" }, f2.rt);
        node_assert_1.strict.deepEqual(f2.calls.setModel, []);
        node_assert_1.strict.ok(f2.errText().includes('no model matching "composer"'));
        const f3 = fakeSlashRuntime({ listModels: async () => [models[0]] });
        await (0, slash_1.handleSlashCommand)({ cmd: "fast", arg: "" }, f3.rt);
        node_assert_1.strict.ok(f3.errText().includes("no model matching"));
        node_assert_1.strict.ok(f3.errText().includes("no speed or pricing metadata"));
        const f4 = fakeSlashRuntime({ listModels: async () => models });
        await (0, slash_1.handleSlashCommand)({ cmd: "fast", arg: "" }, f4.rt);
        node_assert_1.strict.deepEqual(f4.calls.setModel, ["gpt-5-mini"]);
    }
    finally {
        restore();
    }
});
(0, node_test_1.test)("slash model shortcuts respect /config modelSlashCommands=off", async () => {
    const restore = tempHome();
    try {
        (0, agent_config_1.saveAgentConfig)({ ...agent_config_1.DEFAULT_AGENT_CONFIG, modelSlashCommands: false });
        const f = fakeSlashRuntime({
            listModels: async () => [{ id: "a", modelID: "x-opus", providerID: "p", name: "Opus" }],
        });
        await (0, slash_1.handleSlashCommand)({ cmd: "opus", arg: "" }, f.rt);
        node_assert_1.strict.deepEqual(f.calls.setModel, []);
        node_assert_1.strict.ok(f.errText().includes("is disabled"));
    }
    finally {
        restore();
    }
});
(0, node_test_1.test)("slash /skills lists and /skill stages one-shot", async () => {
    const f = fakeSlashRuntime({
        listSkills: () => [{ name: "pdf", description: "read PDFs" }],
        attachSkill: async (name) => name === "pdf" ? { content: "# PDF skill" } : { error: `no skill named ${JSON.stringify(name)}` },
    });
    await (0, slash_1.handleSlashCommand)({ cmd: "skills", arg: "" }, f.rt);
    node_assert_1.strict.ok(f.outText().includes("pdf — read PDFs"));
    await (0, slash_1.handleSlashCommand)({ cmd: "skill", arg: "pdf" }, f.rt);
    node_assert_1.strict.deepEqual(f.calls.pendingSkill, { name: "pdf", content: "# PDF skill" });
    node_assert_1.strict.ok(f.outText().includes("one-shot"));
    const f2 = fakeSlashRuntime({
        listSkills: () => [],
        attachSkill: async () => ({ error: 'no skill named "nope"' }),
    });
    await (0, slash_1.handleSlashCommand)({ cmd: "skills", arg: "" }, f2.rt);
    node_assert_1.strict.ok(f2.outText().includes("no skills found"));
    await (0, slash_1.handleSlashCommand)({ cmd: "skill", arg: "nope" }, f2.rt);
    node_assert_1.strict.ok(f2.errText().includes("no skill named"));
});
// ---------------------------------------------------------------------------
// agent-config.ts
// ---------------------------------------------------------------------------
(0, node_test_1.test)("agent-config: defaults, validation, persistence", () => {
    const restore = tempHome();
    try {
        node_assert_1.strict.deepEqual((0, agent_config_1.loadAgentConfig)(), agent_config_1.DEFAULT_AGENT_CONFIG);
        node_assert_1.strict.equal((0, agent_config_1.setAgentConfigValue)("subagentModel", "disabled"), undefined);
        node_assert_1.strict.equal((0, agent_config_1.loadAgentConfig)().subagentModel, "disabled");
        node_assert_1.strict.equal((0, agent_config_1.setAgentConfigValue)("subagentModel", "anthropic/claude-opus-4-1"), undefined);
        node_assert_1.strict.equal((0, agent_config_1.loadAgentConfig)().subagentModel, "anthropic/claude-opus-4-1");
        node_assert_1.strict.equal((0, agent_config_1.setAgentConfigValue)("subagentModel", ""), "subagentModel must be default|disabled|inherit or a model id");
        node_assert_1.strict.equal((0, agent_config_1.setAgentConfigValue)("autoReview", "on"), undefined);
        node_assert_1.strict.equal((0, agent_config_1.loadAgentConfig)().autoReview, true);
        node_assert_1.strict.equal((0, agent_config_1.setAgentConfigValue)("autoReview", "off"), undefined);
        node_assert_1.strict.ok((0, agent_config_1.setAgentConfigValue)("autoReview", "maybe") !== undefined);
        node_assert_1.strict.ok((0, agent_config_1.setAgentConfigValue)("nope", "x") !== undefined);
        const shown = (0, agent_config_1.formatAgentConfig)();
        node_assert_1.strict.ok(shown.includes("subagentModel"));
        node_assert_1.strict.ok(shown.includes("modelSlashCommands  on"));
    }
    finally {
        restore();
    }
});
// ---------------------------------------------------------------------------
// workspaces.ts
// ---------------------------------------------------------------------------
(0, node_test_1.test)("workspaces: name validation and add/remove dir", () => {
    const restore = tempHome();
    try {
        node_assert_1.strict.equal((0, workspaces_1.validateWorkspaceName)(""), "workspace name must not be empty");
        node_assert_1.strict.ok((0, workspaces_1.validateWorkspaceName)("bad name!") !== undefined);
        node_assert_1.strict.equal((0, workspaces_1.validateWorkspaceName)("proj-1"), undefined);
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-"));
        try {
            node_assert_1.strict.equal((0, workspaces_1.addDirToWorkspace)(dir), undefined);
            node_assert_1.strict.deepEqual((0, workspaces_1.workspaceDirs)(), [dir]);
            // adding twice does not duplicate
            node_assert_1.strict.equal((0, workspaces_1.addDirToWorkspace)(dir), undefined);
            node_assert_1.strict.deepEqual((0, workspaces_1.workspaceDirs)(), [dir]);
            node_assert_1.strict.equal((0, workspaces_1.removeDirFromWorkspace)(dir), undefined);
            node_assert_1.strict.deepEqual((0, workspaces_1.workspaceDirs)(), []);
            node_assert_1.strict.ok((0, workspaces_1.removeDirFromWorkspace)(dir) !== undefined);
        }
        finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }
    finally {
        restore();
    }
});
// ---------------------------------------------------------------------------
// isAutoReviewable (cli.ts): /auto-review permission policy
// ---------------------------------------------------------------------------
(0, node_test_1.test)("isAutoReviewable: shell/mcp/fetch yes; edit no; lists respected", () => {
    const req = (action) => ({ id: "r", sessionID: "s", action, resources: [] });
    node_assert_1.strict.equal((0, cli_1.isAutoReviewable)(req("shell"), {}), true);
    node_assert_1.strict.equal((0, cli_1.isAutoReviewable)(req("mcp__fs__read"), {}), true);
    node_assert_1.strict.equal((0, cli_1.isAutoReviewable)(req("webfetch"), {}), true);
    node_assert_1.strict.equal((0, cli_1.isAutoReviewable)(req("websearch"), {}), true);
    node_assert_1.strict.equal((0, cli_1.isAutoReviewable)(req("edit"), {}), false);
    node_assert_1.strict.equal((0, cli_1.isAutoReviewable)(req("subagent"), {}), false);
    node_assert_1.strict.equal((0, cli_1.isAutoReviewable)(req("shell"), { toolDenylist: ["shell"] }), false);
    node_assert_1.strict.equal((0, cli_1.isAutoReviewable)(req("shell"), { toolDenylist: ["SHELL"] }), false);
    node_assert_1.strict.equal((0, cli_1.isAutoReviewable)(req("shell"), { toolAllowlist: ["webfetch"] }), false);
    node_assert_1.strict.equal((0, cli_1.isAutoReviewable)(req("webfetch"), { toolAllowlist: ["webfetch"] }), true);
    node_assert_1.strict.equal((0, cli_1.isAutoReviewable)(req("shell"), { toolAllowlist: [] }), false);
});
// ---------------------------------------------------------------------------
// Subcommand parsing: persist / ls / plugin / --resume / --version
// ---------------------------------------------------------------------------
(0, node_test_1.test)("parseArgs: persist/ls/plugin subcommands and their args", () => {
    const p = (0, cli_1.parseArgs)(["persist", "attach", "abc123"]);
    node_assert_1.strict.ok("flags" in p);
    node_assert_1.strict.equal(p.flags.subcommand, "persist");
    node_assert_1.strict.deepEqual(p.flags.subcommandArgs, ["attach", "abc123"]);
    const l = (0, cli_1.parseArgs)(["ls", "--format", "json"]);
    node_assert_1.strict.ok("flags" in l && l.flags.subcommand === "ls");
    node_assert_1.strict.equal(l.flags.pluginFormat, "json");
    const pl = (0, cli_1.parseArgs)(["plugin", "marketplace", "add", "https://example.com/m.git", "--git-ref", "v1"]);
    node_assert_1.strict.ok("flags" in pl && pl.flags.subcommand === "plugin");
    node_assert_1.strict.deepEqual(pl.flags.subcommandArgs, ["marketplace", "add", "https://example.com/m.git"]);
    node_assert_1.strict.equal(pl.flags.gitRef, "v1");
});
(0, node_test_1.test)("parseArgs: --resume with and without id", () => {
    const r1 = (0, cli_1.parseArgs)(["--resume"]);
    node_assert_1.strict.ok("flags" in r1 && r1.flags.resume === true);
    node_assert_1.strict.equal(r1.flags.resumeId, undefined);
    const r2 = (0, cli_1.parseArgs)(["--resume", "abc123"]);
    node_assert_1.strict.ok("flags" in r2 && r2.flags.resume === true);
    node_assert_1.strict.equal(r2.flags.resumeId, "abc123");
});
(0, node_test_1.test)("parseArgs: --continue is --resume with no id (and takes no value)", () => {
    const r = (0, cli_1.parseArgs)(["--continue"]);
    node_assert_1.strict.ok("flags" in r && r.flags.resume === true);
    node_assert_1.strict.equal(r.flags.resumeId, undefined);
    // A following token is NOT swallowed as an id — it stays a positional.
    const r2 = (0, cli_1.parseArgs)(["--continue", "fix the bug"]);
    node_assert_1.strict.ok("flags" in r2 && r2.flags.resume === true);
    node_assert_1.strict.equal(r2.flags.resumeId, undefined);
    node_assert_1.strict.deepEqual(r2.flags.positional, ["fix the bug"]);
});
(0, node_test_1.test)("parseArgs: models / resume subcommands and --list-models", () => {
    const m = (0, cli_1.parseArgs)(["models"]);
    node_assert_1.strict.ok("flags" in m && m.flags.subcommand === "models");
    const lm = (0, cli_1.parseArgs)(["--list-models"]);
    node_assert_1.strict.ok("flags" in lm && lm.flags.listModels === true);
    const r0 = (0, cli_1.parseArgs)(["resume"]);
    node_assert_1.strict.ok("flags" in r0 && r0.flags.subcommand === "resume");
    node_assert_1.strict.deepEqual(r0.flags.subcommandArgs, []);
    const r1 = (0, cli_1.parseArgs)(["resume", "abc123"]);
    node_assert_1.strict.ok("flags" in r1 && r1.flags.subcommand === "resume");
    node_assert_1.strict.deepEqual(r1.flags.subcommandArgs, ["abc123"]);
});
(0, node_test_1.test)("parseArgs: --auto-review, --tools, --disallowed-tools", () => {
    const r = (0, cli_1.parseArgs)(["--auto-review", "--tools", "shell,webfetch", "--disallowed-tools", "edit"]);
    node_assert_1.strict.ok("flags" in r);
    node_assert_1.strict.equal(r.flags.autoReview, true);
    node_assert_1.strict.deepEqual(r.flags.toolAllowlist, ["shell", "webfetch"]);
    node_assert_1.strict.deepEqual(r.flags.toolDenylist, ["edit"]);
    const t = (0, cli_1.parseArgs)(["--tools", "[]"]);
    node_assert_1.strict.ok("flags" in t);
    node_assert_1.strict.deepEqual(t.flags.toolAllowlist, []);
});
(0, node_test_1.test)("parseArgs: --version / -V", () => {
    for (const argv of [["--version"], ["-V"]]) {
        const r = (0, cli_1.parseArgs)(argv);
        node_assert_1.strict.ok("flags" in r && r.flags.version === true, argv.join(" "));
    }
});
(0, node_test_1.test)("parseArgs: honest errors for &, --computer-use, --admin*", () => {
    const amp = (0, cli_1.parseArgs)(["&"]);
    node_assert_1.strict.ok("error" in amp && amp.error.includes("cloud"));
    const cu = (0, cli_1.parseArgs)(["--computer-use"]);
    node_assert_1.strict.ok("error" in cu && cu.error.includes("computer-use"));
    for (const argv of [["--admin"], ["--admin-restrict"], ["--admin=x"]]) {
        const r = (0, cli_1.parseArgs)(argv);
        node_assert_1.strict.ok("error" in r, argv.join(" "));
        node_assert_1.strict.ok(r.error.includes("admin"), `expected an admin-gating message for ${argv.join(" ")}`);
    }
});
(0, node_test_1.test)("cliVersion: matches package.json", () => {
    node_assert_1.strict.equal((0, cli_1.cliVersion)(), "0.1.0");
});
(0, node_test_1.test)("--version prints without touching the engine", async () => {
    const out = capture();
    const err = capture();
    const code = await (0, cli_1.runAgent)(["--version"], {
        out: out.stream,
        err: err.stream,
        isTTY: false,
        clientFactory: () => Promise.reject(new Error("must not start the engine for --version")),
    });
    node_assert_1.strict.equal(code, 0);
    node_assert_1.strict.ok(out.text.includes("ide-code agent"), out.text);
    node_assert_1.strict.ok(out.text.includes("0.1.0"), out.text);
});
// ---------------------------------------------------------------------------
// Shared permission policy (autoDecidePermission)
// ---------------------------------------------------------------------------
(0, node_test_1.test)("policy: --disallowed-tools beats --force (hard constraint)", async () => {
    const req = { id: "r", sessionID: "s", action: "shell", resources: [], message: "rm x" };
    const d = await (0, cli_1.autoDecidePermission)(req, { force: true, toolDenylist: ["shell"] });
    node_assert_1.strict.equal(d, "reject");
});
(0, node_test_1.test)("policy: --tools [] denies every tool (text-only)", async () => {
    const req = { id: "r", sessionID: "s", action: "webfetch", resources: [] };
    const d = await (0, cli_1.autoDecidePermission)(req, { toolAllowlist: [] });
    node_assert_1.strict.equal(d, "reject");
});
(0, node_test_1.test)("policy: --tools restricts to its allowlist", async () => {
    const shell = { id: "r", sessionID: "s", action: "shell", resources: [] };
    const edit = { id: "r", sessionID: "s", action: "edit", resources: [] };
    node_assert_1.strict.equal(await (0, cli_1.autoDecidePermission)(shell, { toolAllowlist: ["shell"] }), undefined);
    node_assert_1.strict.equal(await (0, cli_1.autoDecidePermission)(edit, { toolAllowlist: ["shell"] }), "reject");
});
(0, node_test_1.test)("policy: --auto-review approves allowlisted actions in print mode", async () => {
    const shell = {
        id: "r",
        sessionID: "s",
        action: "shell",
        resources: [],
        message: "ls -la",
    };
    node_assert_1.strict.equal(await (0, cli_1.autoDecidePermission)(shell, { autoReview: true }), "once");
    const mcp = { id: "r", sessionID: "s", action: "mcp__fs__read_file", resources: [] };
    node_assert_1.strict.equal(await (0, cli_1.autoDecidePermission)(mcp, { autoReview: true }), "once");
    const edit = { id: "r", sessionID: "s", action: "edit", resources: [] };
    node_assert_1.strict.equal(await (0, cli_1.autoDecidePermission)(edit, { autoReview: true }), undefined);
});
(0, node_test_1.test)("matchesToolList: wildcards and case-insensitivity", () => {
    node_assert_1.strict.ok((0, cli_1.matchesToolList)("mcp__fs__read", ["mcp__*"]));
    node_assert_1.strict.ok((0, cli_1.matchesToolList)("SHELL", ["shell"]));
    node_assert_1.strict.ok(!(0, cli_1.matchesToolList)("edit", ["shell"]));
    node_assert_1.strict.ok((0, cli_1.matchesToolList)("webfetch", ["*fetch"]));
});
(0, node_test_1.test)("isRiskyShellCommand: recursive/force/wildcard deletes are risky", () => {
    node_assert_1.strict.ok((0, cli_1.isRiskyShellCommand)("rm -rf /tmp/x"));
    node_assert_1.strict.ok((0, cli_1.isRiskyShellCommand)("rm -r ./build"));
    node_assert_1.strict.ok((0, cli_1.isRiskyShellCommand)("rm *"));
    node_assert_1.strict.ok((0, cli_1.isRiskyShellCommand)("rm $OUT_DIR"));
    node_assert_1.strict.ok((0, cli_1.isRiskyShellCommand)("sudo rm x"));
    node_assert_1.strict.ok(!(0, cli_1.isRiskyShellCommand)("ls -la"));
    node_assert_1.strict.ok(!(0, cli_1.isRiskyShellCommand)("git status"));
});
(0, node_test_1.test)("isAutoReviewable: risky shell commands are not auto-approved", () => {
    const req = (message) => ({
        id: "r",
        sessionID: "s",
        action: "shell",
        resources: [],
        message,
    });
    node_assert_1.strict.equal((0, cli_1.isAutoReviewable)(req("rm -rf /tmp/x"), {}), false);
    node_assert_1.strict.equal((0, cli_1.isAutoReviewable)(req("ls -la"), {}), true);
});
(0, node_test_1.test)("print mode: --auto-review approves the mock's shell permission", async () => {
    const mock = await startMockEngine();
    const out = capture();
    const err = capture();
    const code = await (0, cli_1.runAgent)(["-p", "--auto-review", "PERM", "shell"], {
        out: out.stream,
        err: err.stream,
        isTTY: false,
        clientFactory: clientFactoryFor(mock),
    });
    await mock.close();
    node_assert_1.strict.equal(code, 0);
    node_assert_1.strict.equal(mock.replies.length, 1);
    node_assert_1.strict.equal(mock.replies[0].decision, "once");
});
(0, node_test_1.test)("print mode: --disallowed-tools beats --yolo", async () => {
    const mock = await startMockEngine();
    const out = capture();
    const err = capture();
    const code = await (0, cli_1.runAgent)(["-p", "--yolo", "--disallowed-tools", "shell", "PERM", "shell"], {
        out: out.stream,
        err: err.stream,
        isTTY: false,
        clientFactory: clientFactoryFor(mock),
    });
    await mock.close();
    node_assert_1.strict.equal(code, 0);
    node_assert_1.strict.equal(mock.replies.length, 1);
    node_assert_1.strict.equal(mock.replies[0].decision, "reject");
});
// ---------------------------------------------------------------------------
// agent ls / persist list
// ---------------------------------------------------------------------------
(0, node_test_1.test)("ls: empty registry", async () => {
    resetLocalState();
    const out = capture();
    const err = capture();
    const mock = await startMockEngine();
    const code = await (0, cli_1.runAgent)(["ls"], {
        out: out.stream,
        err: err.stream,
        isTTY: false,
        clientFactory: () => Promise.reject(new Error("ls must not start the engine")),
    });
    await mock.close();
    node_assert_1.strict.equal(code, 0);
    node_assert_1.strict.ok(out.text.includes("no persisted sessions"), out.text);
});
(0, node_test_1.test)("ls: lists seeded sessions across workspaces, --format json parses", async () => {
    resetLocalState();
    seedSession("ses_test", { cwd: "/tmp/work-a", mode: "agent" });
    seedSession("other123", { cwd: "/tmp/work-b", mode: "plan" });
    const out = capture();
    const err = capture();
    const mock = await startMockEngine();
    const code = await (0, cli_1.runAgent)(["ls"], {
        out: out.stream,
        err: err.stream,
        isTTY: false,
        clientFactory: () => Promise.reject(new Error("ls must not start the engine")),
    });
    await mock.close();
    node_assert_1.strict.equal(code, 0);
    node_assert_1.strict.ok(out.text.includes("/tmp/work-a"), out.text);
    node_assert_1.strict.ok(out.text.includes("/tmp/work-b"), out.text);
    const jout = capture();
    const jerr = capture();
    const mock2 = await startMockEngine();
    const code2 = await (0, cli_1.runAgent)(["ls", "--format", "json"], {
        out: jout.stream,
        err: jerr.stream,
        isTTY: false,
        clientFactory: () => Promise.reject(new Error("ls must not start the engine")),
    });
    await mock2.close();
    node_assert_1.strict.equal(code2, 0);
    const arr = JSON.parse(jout.text);
    node_assert_1.strict.equal(arr.length, 2);
    node_assert_1.strict.ok(arr.some((s) => s.id === "ses_test" && s.cwd === "/tmp/work-a"));
});
(0, node_test_1.test)("persist list mirrors ls", async () => {
    resetLocalState();
    seedSession("ses_test");
    const out = capture();
    const err = capture();
    const mock = await startMockEngine();
    const code = await (0, cli_1.runAgent)(["persist", "list"], {
        out: out.stream,
        err: err.stream,
        isTTY: false,
        clientFactory: () => Promise.reject(new Error("persist list must not start the engine")),
    });
    await mock.close();
    node_assert_1.strict.equal(code, 0);
    node_assert_1.strict.ok(out.text.includes("ses_test"), out.text);
});
// ---------------------------------------------------------------------------
// agent persist attach / stop / --resume
// ---------------------------------------------------------------------------
(0, node_test_1.test)("persist attach: unknown id fails honestly", async () => {
    resetLocalState();
    const out = capture();
    const err = capture();
    const mock = await startMockEngine();
    const code = await (0, cli_1.runAgent)(["persist", "attach", "bogus-id"], {
        out: out.stream,
        err: err.stream,
        isTTY: false,
        clientFactory: clientFactoryFor(mock),
    });
    await mock.close();
    node_assert_1.strict.equal(code, 1);
    node_assert_1.strict.ok(err.text.includes("no persisted session matches") || err.text.includes("no longer on the engine"), err.text);
});
(0, node_test_1.test)("persist attach: stale registry entry fails honestly", async () => {
    resetLocalState();
    seedSession("gone123");
    const out = capture();
    const err = capture();
    const mock = await startMockEngine();
    const code = await (0, cli_1.runAgent)(["persist", "attach", "gone123"], {
        out: out.stream,
        err: err.stream,
        isTTY: false,
        clientFactory: clientFactoryFor(mock),
    });
    await mock.close();
    node_assert_1.strict.equal(code, 1);
    node_assert_1.strict.ok(err.text.includes("no longer on the engine"), err.text);
});
(0, node_test_1.test)("persist attach: live session opens the TUI seeded (scripted /exit)", async () => {
    resetLocalState();
    seedSession("ses_test");
    const out = capture();
    const err = capture();
    const mock = await startMockEngine();
    const code = await (0, cli_1.runAgent)(["persist", "attach", "ses_test"], {
        out: out.stream,
        err: err.stream,
        isTTY: true,
        input: node_stream_2.Readable.from(["/exit\n"]),
        clientFactory: clientFactoryFor(mock),
    });
    await mock.close();
    node_assert_1.strict.equal(code, 0);
    // The seeded session was adopted, not recreated.
    node_assert_1.strict.equal(mock.sessionBodies.length, 0);
});
(0, node_test_1.test)("persist stop: stops on the engine and unregisters", async () => {
    resetLocalState();
    seedSession("ses_test");
    const out = capture();
    const err = capture();
    const mock = await startMockEngine();
    const code = await (0, cli_1.runAgent)(["persist", "stop", "ses_test"], {
        out: out.stream,
        err: err.stream,
        isTTY: false,
        clientFactory: clientFactoryFor(mock),
    });
    await mock.close();
    node_assert_1.strict.equal(code, 0);
    node_assert_1.strict.deepEqual(mock.deletedIDs, ["ses_test"]);
    node_assert_1.strict.equal((0, sessions_1.loadRegistry)().sessions.length, 0);
    node_assert_1.strict.ok(out.text.includes("stopped session"), out.text);
});
(0, node_test_1.test)("persist stop: unknown id fails honestly", async () => {
    resetLocalState();
    const out = capture();
    const err = capture();
    const mock = await startMockEngine();
    const code = await (0, cli_1.runAgent)(["persist", "stop", "nope"], {
        out: out.stream,
        err: err.stream,
        isTTY: false,
        clientFactory: clientFactoryFor(mock),
    });
    await mock.close();
    node_assert_1.strict.equal(code, 1);
    node_assert_1.strict.ok(err.text.includes("no persisted session matches"), err.text);
});
(0, node_test_1.test)("print --resume: continues the persisted session without creating one", async () => {
    resetLocalState();
    seedSession("ses_test");
    const out = capture();
    const err = capture();
    const mock = await startMockEngine();
    const code = await (0, cli_1.runAgent)(["--resume", "-p", "hello"], {
        out: out.stream,
        err: err.stream,
        isTTY: false,
        clientFactory: clientFactoryFor(mock),
    });
    await mock.close();
    node_assert_1.strict.equal(code, 0);
    node_assert_1.strict.equal(out.text.trim(), "hello world");
    node_assert_1.strict.equal(mock.sessionBodies.length, 0, "resume must not create a session");
    node_assert_1.strict.deepEqual(mock.promptSessionIDs, ["ses_test"]);
    node_assert_1.strict.ok(err.text.includes("resuming session"), err.text);
});
(0, node_test_1.test)("print --resume: empty registry fails honestly", async () => {
    resetLocalState();
    const out = capture();
    const err = capture();
    const mock = await startMockEngine();
    const code = await (0, cli_1.runAgent)(["--resume", "-p", "hello"], {
        out: out.stream,
        err: err.stream,
        isTTY: false,
        clientFactory: clientFactoryFor(mock),
    });
    await mock.close();
    node_assert_1.strict.equal(code, 1);
    node_assert_1.strict.ok(err.text.includes("no persisted session to resume"), err.text);
});
(0, node_test_1.test)("print --continue: resumes the most recent session, like --resume", async () => {
    resetLocalState();
    seedSession("ses_test");
    const out = capture();
    const err = capture();
    const mock = await startMockEngine();
    const code = await (0, cli_1.runAgent)(["--continue", "-p", "hello"], {
        out: out.stream,
        err: err.stream,
        isTTY: false,
        clientFactory: clientFactoryFor(mock),
    });
    await mock.close();
    node_assert_1.strict.equal(code, 0);
    node_assert_1.strict.equal(out.text.trim(), "hello world");
    node_assert_1.strict.equal(mock.sessionBodies.length, 0, "--continue must not create a session");
    node_assert_1.strict.deepEqual(mock.promptSessionIDs, ["ses_test"]);
});
(0, node_test_1.test)("print `agent resume [id]`: subcommand spelling of --resume", async () => {
    resetLocalState();
    seedSession("ses_test");
    const mock = await startMockEngine();
    // No id: most recent session.
    const out1 = capture();
    const err1 = capture();
    const code1 = await (0, cli_1.runAgent)(["resume", "-p", "hello"], {
        out: out1.stream,
        err: err1.stream,
        isTTY: false,
        clientFactory: clientFactoryFor(mock),
    });
    node_assert_1.strict.equal(code1, 0);
    node_assert_1.strict.deepEqual(mock.promptSessionIDs, ["ses_test"]);
    // Explicit id.
    const out2 = capture();
    const err2 = capture();
    const code2 = await (0, cli_1.runAgent)(["resume", "ses_test", "-p", "hello"], {
        out: out2.stream,
        err: err2.stream,
        isTTY: false,
        clientFactory: clientFactoryFor(mock),
    });
    await mock.close();
    node_assert_1.strict.equal(code2, 0);
    node_assert_1.strict.deepEqual(mock.promptSessionIDs, ["ses_test", "ses_test"]);
    node_assert_1.strict.equal(mock.sessionBodies.length, 0, "resume must not create a session");
});
(0, node_test_1.test)("`agent resume` with two ids fails before touching the engine", async () => {
    const out = capture();
    const err = capture();
    const code = await (0, cli_1.runAgent)(["resume", "a", "b"], {
        out: out.stream,
        err: err.stream,
        isTTY: false,
        clientFactory: () => Promise.reject(new Error("must not start the engine")),
    });
    node_assert_1.strict.equal(code, 1);
    node_assert_1.strict.ok(err.text.includes("at most one session id"), err.text);
});
(0, node_test_1.test)("`agent models` and --list-models list engine models and exit (no session)", async () => {
    for (const argv of [["models"], ["--list-models"]]) {
        resetLocalState();
        const out = capture();
        const err = capture();
        const mock = await startMockEngine();
        const code = await (0, cli_1.runAgent)(argv, {
            out: out.stream,
            err: err.stream,
            isTTY: false,
            clientFactory: clientFactoryFor(mock),
        });
        await mock.close();
        node_assert_1.strict.equal(code, 0, argv.join(" "));
        node_assert_1.strict.ok(out.text.includes("models: 1 available"), out.text);
        node_assert_1.strict.ok(out.text.includes("p1/m1"), out.text);
        node_assert_1.strict.ok(out.text.includes("Test Model 1"), out.text);
        node_assert_1.strict.equal(mock.sessionBodies.length, 0, "models must not create a session");
        node_assert_1.strict.deepEqual(mock.promptSessionIDs, []);
    }
});
(0, node_test_1.test)("interactive /summarize compacts the live session and fires preCompaction hooks", async () => {
    resetLocalState();
    const marker = path.join(TEST_HOME, "precompaction-fired");
    writeHooksFile({ preCompaction: [`touch ${marker}`] });
    const out = capture();
    const err = capture();
    const mock = await startMockEngine();
    const code = await (0, cli_1.runAgent)([], {
        out: out.stream,
        err: err.stream,
        isTTY: true,
        input: node_stream_2.Readable.from(["hello\n", "/summarize\n", "/exit\n"]),
        clientFactory: clientFactoryFor(mock),
    });
    await mock.close();
    node_assert_1.strict.equal(code, 0, err.text);
    node_assert_1.strict.deepEqual(mock.compactedIDs, ["ses_test"]);
    node_assert_1.strict.ok(out.text.includes("summarized session ses_test"), out.text);
    node_assert_1.strict.ok(fs.existsSync(marker), "preCompaction hook should have fired");
});
(0, node_test_1.test)("interactive /summarize before any turn fails honestly (no session yet)", async () => {
    resetLocalState();
    const out = capture();
    const err = capture();
    const mock = await startMockEngine();
    const code = await (0, cli_1.runAgent)([], {
        out: out.stream,
        err: err.stream,
        isTTY: true,
        input: node_stream_2.Readable.from(["/summarize\n", "/exit\n"]),
        clientFactory: clientFactoryFor(mock),
    });
    await mock.close();
    node_assert_1.strict.equal(code, 0, err.text);
    node_assert_1.strict.deepEqual(mock.compactedIDs, []);
    node_assert_1.strict.ok(err.text.includes("no active session"), err.text);
});
(0, node_test_1.test)("print mode records the session in the registry", async () => {
    resetLocalState();
    const out = capture();
    const err = capture();
    const mock = await startMockEngine();
    const code = await (0, cli_1.runAgent)(["-p", "hello"], {
        out: out.stream,
        err: err.stream,
        isTTY: false,
        clientFactory: clientFactoryFor(mock),
    });
    await mock.close();
    node_assert_1.strict.equal(code, 0);
    const reg = (0, sessions_1.loadRegistry)();
    node_assert_1.strict.equal(reg.sessions.length, 1);
    node_assert_1.strict.equal(reg.sessions[0].id, "ses_test");
});
(0, node_test_1.test)("resolveResumeTarget: id, prefix, ambiguity, missing", () => {
    resetLocalState();
    const now = Date.now();
    seedSession("abcdef123", { lastUsedAt: now - 3000 });
    seedSession("abcdef456", { lastUsedAt: now - 2000 });
    seedSession("xyz999", { lastUsedAt: now - 1000 });
    node_assert_1.strict.equal((0, cli_1.resolveResumeTarget)({ resumeId: "abcdef123" }).id, "abcdef123");
    node_assert_1.strict.equal((0, cli_1.resolveResumeTarget)({ resumeId: "xyz" }).id, "xyz999");
    node_assert_1.strict.throws(() => (0, cli_1.resolveResumeTarget)({ resumeId: "abcdef" }), /ambiguous/);
    node_assert_1.strict.throws(() => (0, cli_1.resolveResumeTarget)({ resumeId: "nope" }), /no persisted session matches/);
    node_assert_1.strict.equal((0, cli_1.resolveResumeTarget)({}).id, "xyz999"); // most recent
    resetLocalState();
    node_assert_1.strict.throws(() => (0, cli_1.resolveResumeTarget)({}), /no persisted session to resume/);
});
// ---------------------------------------------------------------------------
// agent plugin marketplace
// ---------------------------------------------------------------------------
(0, node_test_1.test)("plugin marketplace add/list/remove round-trip (fake git)", async () => {
    resetLocalState();
    const out = capture();
    const err = capture();
    const deps = { pluginSpawn: fakeGitSpawn(0) };
    const addCode = await (0, cli_1.runAgent)(["plugin", "marketplace", "add", "https://example.com/org/cool.git", "--git-ref", "v1"], { out: out.stream, err: err.stream, isTTY: false, ...deps });
    node_assert_1.strict.equal(addCode, 0);
    node_assert_1.strict.ok(out.text.includes('"cool"') || out.text.includes("cool"), out.text);
    const reg = (0, plugins_1.loadPluginRegistry)();
    node_assert_1.strict.equal(reg.marketplaces.length, 1);
    node_assert_1.strict.equal(reg.marketplaces[0].name, "cool");
    node_assert_1.strict.equal(reg.marketplaces[0].ref, "v1");
    const lout = capture();
    const listCode = await (0, cli_1.runAgent)(["plugin", "marketplace", "list"], {
        out: lout.stream,
        err: err.stream,
        isTTY: false,
        ...deps,
    });
    node_assert_1.strict.equal(listCode, 0);
    node_assert_1.strict.ok(lout.text.includes("cool"), lout.text);
    node_assert_1.strict.ok(lout.text.includes("https://example.com/org/cool.git"), lout.text);
    const jout = capture();
    const jsonCode = await (0, cli_1.runAgent)(["plugin", "marketplace", "list", "--format", "json"], {
        out: jout.stream,
        err: err.stream,
        isTTY: false,
        ...deps,
    });
    node_assert_1.strict.equal(jsonCode, 0);
    const arr = JSON.parse(jout.text);
    node_assert_1.strict.equal(arr[0].name, "cool");
    const rout = capture();
    const rmCode = await (0, cli_1.runAgent)(["plugin", "marketplace", "remove", "cool"], {
        out: rout.stream,
        err: err.stream,
        isTTY: false,
        ...deps,
    });
    node_assert_1.strict.equal(rmCode, 0);
    node_assert_1.strict.equal((0, plugins_1.loadPluginRegistry)().marketplaces.length, 0);
});
(0, node_test_1.test)("plugin marketplace add: git failure is reported honestly", async () => {
    resetLocalState();
    const out = capture();
    const err = capture();
    const code = await (0, cli_1.runAgent)(["plugin", "marketplace", "add", "https://example.com/org/nope.git"], {
        out: out.stream,
        err: err.stream,
        isTTY: false,
        pluginSpawn: fakeGitSpawn(128, "fatal: repository not found"),
    });
    node_assert_1.strict.equal(code, 1);
    node_assert_1.strict.ok(err.text.includes("git clone failed"), err.text);
    node_assert_1.strict.ok(err.text.includes("repository not found"), err.text);
    node_assert_1.strict.equal((0, plugins_1.loadPluginRegistry)().marketplaces.length, 0);
});
(0, node_test_1.test)("plugin marketplace add: duplicate is refused", async () => {
    resetLocalState();
    const err = capture();
    const deps = { pluginSpawn: fakeGitSpawn(0) };
    const out1 = capture();
    node_assert_1.strict.equal(await (0, cli_1.runAgent)(["plugin", "marketplace", "add", "https://example.com/org/dup.git"], {
        out: out1.stream,
        err: err.stream,
        isTTY: false,
        ...deps,
    }), 0);
    const out2 = capture();
    const code = await (0, cli_1.runAgent)(["plugin", "marketplace", "add", "https://example.com/org/dup.git"], {
        out: out2.stream,
        err: err.stream,
        isTTY: false,
        ...deps,
    });
    node_assert_1.strict.equal(code, 1);
    node_assert_1.strict.ok(err.text.includes("already registered"), err.text);
});
(0, node_test_1.test)("plugin marketplace update: ok and failing results", async () => {
    resetLocalState();
    const err = capture();
    const deps = { pluginSpawn: fakeGitSpawn(0) };
    const out1 = capture();
    await (0, cli_1.runAgent)(["plugin", "marketplace", "add", "https://example.com/org/up.git"], {
        out: out1.stream,
        err: err.stream,
        isTTY: false,
        ...deps,
    });
    // Make the clone dir look like a git checkout so update runs pull.
    fs.mkdirSync(path.join(TEST_HOME, ".ide-code", "plugins", "up", ".git"), { recursive: true });
    const uout = capture();
    const okCode = await (0, cli_1.runAgent)(["plugin", "marketplace", "update", "up"], {
        out: uout.stream,
        err: err.stream,
        isTTY: false,
        ...deps,
    });
    node_assert_1.strict.equal(okCode, 0);
    node_assert_1.strict.ok(uout.text.includes("ok"), uout.text);
    const uout2 = capture();
    const failCode = await (0, cli_1.runAgent)(["plugin", "marketplace", "update", "up", "--format", "json"], {
        out: uout2.stream,
        err: err.stream,
        isTTY: false,
        pluginSpawn: fakeGitSpawn(1, "fatal: no upstream"),
    });
    node_assert_1.strict.equal(failCode, 1);
    const results = JSON.parse(uout2.text);
    node_assert_1.strict.equal(results[0].ok, false);
});
(0, node_test_1.test)("plugin: usage errors", async () => {
    resetLocalState();
    for (const argv of [["plugin"], ["plugin", "marketplace"], ["plugin", "marketplace", "frobnicate"]]) {
        const out = capture();
        const err = capture();
        const code = await (0, cli_1.runAgent)(argv, { out: out.stream, err: err.stream, isTTY: false });
        node_assert_1.strict.equal(code, 1, argv.join(" "));
    }
    const out = capture();
    const err = capture();
    const code = await (0, cli_1.runAgent)(["plugin", "marketplace", "remove"], {
        out: out.stream,
        err: err.stream,
        isTTY: false,
    });
    node_assert_1.strict.equal(code, 1);
    node_assert_1.strict.ok(err.text.includes("requires a <name|url>"), err.text);
});
(0, node_test_1.test)("marketplaceNameFromUrl", () => {
    const { strict: eq } = node_assert_1.strict;
    void eq;
    node_assert_1.strict.equal((0, plugins_1.marketplaceNameFromUrl)("https://github.com/org/repo.git"), "repo");
    node_assert_1.strict.equal((0, plugins_1.marketplaceNameFromUrl)("git@github.com:org/repo"), "repo");
    node_assert_1.strict.equal((0, plugins_1.marketplaceNameFromUrl)("https://example.com/x/y/"), "y");
});
// ---------------------------------------------------------------------------
// Hooks: loading, env, stop follow-ups, lifecycle wiring
// ---------------------------------------------------------------------------
(0, node_test_1.test)("loadHooks: merges global + project, warns on junk", () => {
    resetLocalState();
    writeHooksFile({ sessionStart: ["echo hi"], bogus: ["x"], stop: "not-an-array-ok" });
    const loaded = (0, hooks_1.loadHooks)("/nonexistent-project-dir");
    node_assert_1.strict.deepEqual(loaded.commands.sessionStart, ["echo hi"]);
    node_assert_1.strict.ok(loaded.warnings.some((w) => w.includes("bogus")), loaded.warnings.join(";"));
});
(0, node_test_1.test)("runHookEvent: env vars and failure logging", async () => {
    resetLocalState();
    const seen = [];
    const spawn = ((cmd, args, opts) => {
        seen.push({ cmd, args, env: opts.env });
        const { EventEmitter } = require("node:events");
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        setImmediate(() => {
            child.stdout.emit("data", Buffer.from("out1\n"));
            child.emit("close", 0);
        });
        return child;
    });
    const logs = [];
    const stdouts = await (0, hooks_1.runHookEvent)({ commands: { sessionStart: [], sessionEnd: [], stop: ["true"], preCompaction: [], subagentStart: [], subagentEnd: [] }, warnings: [] }, "stop", { sessionID: "s1", mode: "agent", cwd: "/tmp/w" }, { spawn, log: (m) => logs.push(m) });
    node_assert_1.strict.deepEqual(stdouts, ["out1\n"]);
    node_assert_1.strict.equal(seen[0].env.IDE_CODE_HOOK_EVENT, "stop");
    node_assert_1.strict.equal(seen[0].env.IDE_CODE_SESSION_ID, "s1");
    node_assert_1.strict.equal(seen[0].env.IDE_CODE_MODE, "agent");
    node_assert_1.strict.equal(seen[0].env.IDE_CODE_CWD, "/tmp/w");
    node_assert_1.strict.deepEqual(logs, []);
});
(0, node_test_1.test)("parseStopFollowUp: extracts the follow-up text", () => {
    node_assert_1.strict.equal((0, hooks_1.parseStopFollowUp)(['noise\n{"followUp": "keep going"}\n']), "keep going");
    node_assert_1.strict.equal((0, hooks_1.parseStopFollowUp)(["nothing here"]), undefined);
    node_assert_1.strict.equal((0, hooks_1.parseStopFollowUp)(['{"followUp": "  "}']), undefined);
});
(0, node_test_1.test)("hooks wiring: sessionStart/sessionEnd run around a print turn", async () => {
    resetLocalState();
    const started = path.join(TEST_HOME, "hook-started");
    const ended = path.join(TEST_HOME, "hook-ended");
    writeHooksFile({
        sessionStart: [`touch ${started}`],
        sessionEnd: [`touch ${ended}`],
    });
    const out = capture();
    const err = capture();
    const mock = await startMockEngine();
    const code = await (0, cli_1.runAgent)(["-p", "hello"], {
        out: out.stream,
        err: err.stream,
        isTTY: false,
        clientFactory: clientFactoryFor(mock),
    });
    await mock.close();
    node_assert_1.strict.equal(code, 0);
    node_assert_1.strict.ok(fs.existsSync(started), "sessionStart hook should have run");
    node_assert_1.strict.ok(fs.existsSync(ended), "sessionEnd hook should have run");
    resetLocalState();
});
(0, node_test_1.test)("hooks wiring: stop hook follow-up runs a second turn (cap respected)", async () => {
    resetLocalState();
    // Every stop hook asks for exactly one follow-up; the cap is 3, so with a
    // hook that always answers we get 1 + 3 = 4 prompts.
    writeHooksFile({ stop: [`echo '{"followUp": "again"}'`] });
    const out = capture();
    const err = capture();
    const mock = await startMockEngine();
    const code = await (0, cli_1.runAgent)(["-p", "hello"], {
        out: out.stream,
        err: err.stream,
        isTTY: false,
        clientFactory: clientFactoryFor(mock),
    });
    await mock.close();
    node_assert_1.strict.equal(code, 0);
    node_assert_1.strict.equal(mock.promptSessionIDs.length, 4);
    node_assert_1.strict.ok(err.text.includes("follow-up turn (3/3)"), err.text);
    resetLocalState();
});
// ---------------------------------------------------------------------------
// Subagent drain (print mode waits for subagents before exiting)
// ---------------------------------------------------------------------------
(0, node_test_1.test)("print mode drains subagents: turn.end comes after subagent.end", async () => {
    resetLocalState();
    const out = capture();
    const err = capture();
    const mock = await startMockEngine();
    const code = await (0, cli_1.runAgent)(["-p", "SUBAGENT", "--output-format", "stream-json"], {
        out: out.stream,
        err: err.stream,
        isTTY: false,
        clientFactory: clientFactoryFor(mock),
    });
    await mock.close();
    node_assert_1.strict.equal(code, 0);
    const lines = out.text.trim().split("\n").map((l) => JSON.parse(l));
    const types = lines.map((l) => l.type);
    const startIdx = types.indexOf("subagent.start");
    const endIdx = types.indexOf("subagent.end");
    const turnEndIdx = types.indexOf("turn.end");
    node_assert_1.strict.ok(startIdx >= 0, "expected a subagent.start line");
    node_assert_1.strict.ok(endIdx > startIdx, "expected subagent.end after subagent.start");
    node_assert_1.strict.ok(turnEndIdx > endIdx, "turn.end must wait for the subagent drain");
});
// ---------------------------------------------------------------------------
// timedConfirm (mode-switch approvals)
// ---------------------------------------------------------------------------
(0, node_test_1.test)("timedConfirm: silence auto-rejects", async () => {
    const err = capture();
    const rl = readline.createInterface({
        input: node_stream_2.Readable.from([]),
        output: new node_stream_1.Writable({ write(_c, _e, cb) { cb(); } }),
    });
    const ok = await (0, tui_1.timedConfirm)(rl, "switch?", 60, err.stream);
    rl.close();
    node_assert_1.strict.equal(ok, false);
    node_assert_1.strict.ok(err.text.includes("auto-rejected"), err.text);
});
(0, node_test_1.test)("timedConfirm: explicit yes confirms", async () => {
    const err = capture();
    const rl = readline.createInterface({
        input: node_stream_2.Readable.from(["y\n"]),
        output: new node_stream_1.Writable({ write(_c, _e, cb) { cb(); } }),
    });
    const ok = await (0, tui_1.timedConfirm)(rl, "switch?", 5000, err.stream);
    rl.close();
    node_assert_1.strict.equal(ok, true);
});
// ---------------------------------------------------------------------------
// --help documents the new surface
// ---------------------------------------------------------------------------
(0, node_test_1.test)("--help lists the new flags and subcommands", async () => {
    resetLocalState();
    const out = capture();
    const err = capture();
    const code = await (0, cli_1.runAgent)(["--help"], {
        out: out.stream,
        err: err.stream,
        isTTY: false,
        clientFactory: () => Promise.reject(new Error("must not start the engine for --help")),
    });
    node_assert_1.strict.equal(code, 0);
    const help = out.text;
    for (const flag of [
        "--auto-review",
        "--tools",
        "--disallowed-tools",
        "--resume",
        "--version",
        "--format",
        "--git-ref",
        "persist",
        "plugin",
        "agent ls",
    ]) {
        node_assert_1.strict.ok(help.includes(flag), `help should mention ${flag}`);
    }
});
(0, node_test_1.test)("persist (bare): starts a persistent session and opens the TUI", async () => {
    resetLocalState();
    const out = capture();
    const err = capture();
    const mock = await startMockEngine();
    const code = await (0, cli_1.runAgent)(["persist"], {
        out: out.stream,
        err: err.stream,
        isTTY: true,
        input: node_stream_2.Readable.from(["/exit\n"]),
        clientFactory: clientFactoryFor(mock),
    });
    await mock.close();
    node_assert_1.strict.equal(code, 0);
    node_assert_1.strict.equal(mock.sessionBodies.length, 1);
    node_assert_1.strict.ok(out.text.includes("persistent session ses_test"), out.text);
    node_assert_1.strict.ok(out.text.includes("persist attach"), out.text);
    node_assert_1.strict.equal((0, sessions_1.loadRegistry)().sessions.length, 1);
    resetLocalState();
});
(0, node_test_1.test)("hooks wiring: subagentStart/subagentEnd fire on subagent lifecycle", async () => {
    resetLocalState();
    const started = path.join(TEST_HOME, "sub-started");
    const ended = path.join(TEST_HOME, "sub-ended");
    writeHooksFile({
        subagentStart: [`touch ${started}`],
        subagentEnd: [`touch ${ended}`],
    });
    const out = capture();
    const err = capture();
    const mock = await startMockEngine();
    const code = await (0, cli_1.runAgent)(["-p", "SUBAGENT"], {
        out: out.stream,
        err: err.stream,
        isTTY: false,
        clientFactory: clientFactoryFor(mock),
    });
    await mock.close();
    node_assert_1.strict.equal(code, 0);
    // Hook firing is fire-and-forget; poll briefly for the side effects.
    const deadline = Date.now() + 3000;
    while ((!fs.existsSync(started) || !fs.existsSync(ended)) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
    }
    node_assert_1.strict.ok(fs.existsSync(started), "subagentStart hook should have run");
    node_assert_1.strict.ok(fs.existsSync(ended), "subagentEnd hook should have run");
    resetLocalState();
});
(0, node_test_1.test)("subagentNestingDefaultEnv: injects Cursor-parity default when unset", () => {
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), "ide-xdg-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ide-cwd-"));
    const prevCwd = process.cwd();
    process.chdir(cwd);
    try {
        const out = (0, engine_1.subagentNestingDefaultEnv)({ XDG_CONFIG_HOME: xdg });
        node_assert_1.strict.deepEqual(out, {
            OPENCODE_CONFIG_CONTENT: JSON.stringify({ experimental: { subagent_depth: 2 } }),
        });
    }
    finally {
        process.chdir(prevCwd);
        fs.rmSync(xdg, { recursive: true, force: true });
        fs.rmSync(cwd, { recursive: true, force: true });
    }
});
(0, node_test_1.test)("subagentNestingDefaultEnv: skips when env already sets OPENCODE_CONFIG_CONTENT", () => {
    const out = (0, engine_1.subagentNestingDefaultEnv)({
        OPENCODE_CONFIG_CONTENT: '{"experimental":{"subagent_depth":5}}',
    });
    node_assert_1.strict.deepEqual(out, {});
});
(0, node_test_1.test)("subagentNestingDefaultEnv: skips when a config file sets subagent_depth", () => {
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), "ide-xdg-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ide-cwd-"));
    const prevCwd = process.cwd();
    process.chdir(cwd);
    try {
        fs.mkdirSync(path.join(xdg, "opencode"), { recursive: true });
        fs.writeFileSync(path.join(xdg, "opencode", "opencode.json"), '{ "experimental": { "subagent_depth": 3 } }', "utf8");
        // Note: global dir is <xdg>/opencode — the helper joins "opencode" itself.
        const out = (0, engine_1.subagentNestingDefaultEnv)({ XDG_CONFIG_HOME: xdg });
        node_assert_1.strict.deepEqual(out, {});
    }
    finally {
        process.chdir(prevCwd);
        fs.rmSync(xdg, { recursive: true, force: true });
        fs.rmSync(cwd, { recursive: true, force: true });
    }
});
(0, node_test_1.test)("subagentNestingDefaultEnv: skips when the project config sets subagent_depth", () => {
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), "ide-xdg-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ide-cwd-"));
    const prevCwd = process.cwd();
    process.chdir(cwd);
    try {
        fs.writeFileSync(cwd + "/opencode.jsonc", '// local\n{ "experimental": { "subagent_depth": 1 } }', "utf8");
        const out = (0, engine_1.subagentNestingDefaultEnv)({ XDG_CONFIG_HOME: xdg });
        node_assert_1.strict.deepEqual(out, {});
    }
    finally {
        process.chdir(prevCwd);
        fs.rmSync(xdg, { recursive: true, force: true });
        fs.rmSync(cwd, { recursive: true, force: true });
    }
});
