"use strict";
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
/**
 * Desktop bridge CLIENT tests (node:test). A REAL unix-socket HTTP server
 * (net/http, socket file under os.tmpdir()) backs the discovery + wire
 * paths. Output is captured via the client's injectable stdout/stderr
 * options — never by patching process.stdout.write (that corrupts the
 * node:test TAP stream).
 *
 * Spec: ~/workspace/ide-code-mission/docs/rea/dig-cli-2026-10-19.md §3.1, §5 P2.
 *
 * Run after `tsc`:  node --test out/test/run-desktop-bridge-client-tests.js
 */
const node_test_1 = require("node:test");
const assert = __importStar(require("node:assert"));
const http = __importStar(require("node:http"));
const fs = __importStar(require("node:fs"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const node_child_process_1 = require("node:child_process");
const client_js_1 = require("../desktop/client.js");
const GOOD_TOKEN = "a".repeat(64);
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ide-bridge-client-test-"));
let seq = 0;
/** Injected output sink pair; pass as BridgeOptions. */
function makeOut() {
    let stdout = "";
    let stderr = "";
    const opts = {
        stdout: (line) => {
            stdout += line + "\n";
        },
        stderr: (line) => {
            stderr += line + "\n";
        },
    };
    return {
        opts,
        get stdout() {
            return stdout;
        },
        get stderr() {
            return stderr;
        },
    };
}
function writeInstanceJson(dir, overrides = {}) {
    fs.writeFileSync(path.join(dir, `instance-${seq++}.json`), JSON.stringify({
        protocolVersion: 1,
        pid: process.pid,
        socketPath: path.join(dir, `bridge-${seq}.sock`),
        token: GOOD_TOKEN,
        appName: "IDE Code",
        appVersion: "0.1.0-test",
        userDataDir: "/tmp/ide-user",
        createdAt: Date.now(),
        ...overrides,
    }));
}
/** Spin a real unix-socket HTTP bridge server + matching instance JSON. */
async function startFakeBridge(handler, opts = {}) {
    const dir = fs.mkdtempSync(path.join(TEST_DIR, "bridge-"));
    const socketPath = path.join(dir, `bridge-${seq++}.sock`);
    const token = GOOD_TOKEN;
    const seen = [];
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
            let body = {};
            try {
                body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            }
            catch {
                /* keep {} */
            }
            seen.push({ type: typeof body.type === "string" ? body.type : "", body });
            const out = handler(body);
            if (out === "hang") {
                return; // never respond — exercises the request timeout
            }
            res.writeHead(out.code, { "Content-Type": "application/json" });
            res.end(JSON.stringify(out.body));
        });
    });
    await new Promise((resolve) => server.listen(socketPath, resolve));
    // The instance JSON must land in the discovery dir the client reads
    // (IDE_CODE_DESKTOP_BRIDGE_DIR in tests).
    writeInstanceJson(process.env[client_js_1.BRIDGE_DIR_ENV], {
        socketPath,
        token,
        appVersion: opts.appVersion ?? "0.1.0-test",
    });
    return {
        socketPath,
        token,
        label: `IDE Code ${opts.appVersion ?? "0.1.0-test"}`,
        seen,
        close: () => new Promise((resolve) => {
            server.close(() => resolve());
            for (const f of fs.readdirSync(dir)) {
                try {
                    fs.unlinkSync(path.join(dir, f));
                }
                catch {
                    /* ignore */
                }
            }
        }),
    };
}
function threadsHandler(threads, sendResponse) {
    return (body) => {
        if (body.type === "listThreads") {
            return { code: 200, body: { threads } };
        }
        if (body.type === "sendMessage") {
            const resp = sendResponse
                ? sendResponse(body)
                : { status: "submitted", threadId: body.threadId, windowId: "main", threadTitle: "T" };
            return { code: 200, body: resp };
        }
        return { code: 400, body: { status: "error", message: "nope" } };
    };
}
const THREADS = [
    { id: "abcdef-1111", title: "Fix the bug", source: "local", status: "idle", lastUpdatedAt: 100, windowId: "main" },
    { id: "abcxyz-2222", title: "Refactor \u001b[31mthings\u001b[0m", source: "local", status: "running", lastUpdatedAt: 200, windowId: "main" },
];
const origBridgeDir = process.env[client_js_1.BRIDGE_DIR_ENV];
(0, node_test_1.beforeEach)(() => {
    process.env[client_js_1.BRIDGE_DIR_ENV] = fs.mkdtempSync(path.join(TEST_DIR, "discovery-"));
});
(0, node_test_1.afterEach)(() => {
    if (origBridgeDir === undefined) {
        delete process.env[client_js_1.BRIDGE_DIR_ENV];
    }
    else {
        process.env[client_js_1.BRIDGE_DIR_ENV] = origBridgeDir;
    }
});
(0, node_test_1.describe)("discovery validation (spec §3.1 R1)", () => {
    (0, node_test_1.it)("accepts a valid instance and skips invalid/stale files silently", () => {
        const d = process.env[client_js_1.BRIDGE_DIR_ENV];
        writeInstanceJson(d); // valid
        writeInstanceJson(d, { token: "xyz" }); // bad token
        writeInstanceJson(d, { pid: 2147483647 }); // stale pid (kill(pid,0) fails)
        writeInstanceJson(d, { protocolVersion: 2 }); // wrong protocol
        writeInstanceJson(d, { appName: "" }); // empty appName
        fs.writeFileSync(path.join(d, "garbage.json"), "{not json");
        fs.writeFileSync(path.join(d, "notes.txt"), "hello");
        const found = (0, client_js_1.discoverInstances)();
        assert.equal(found.length, 1);
        assert.equal(found[0].label, "IDE Code 0.1.0-test");
        assert.equal(found[0].token, GOOD_TOKEN);
    });
    (0, node_test_1.it)("returns [] when the bridge dir does not exist", () => {
        assert.deepEqual((0, client_js_1.discoverInstances)(path.join(TEST_DIR, "nope-not-here")), []);
    });
    (0, node_test_1.it)("validateInstance rejects each bad field", () => {
        const base = {
            protocolVersion: 1,
            pid: process.pid,
            socketPath: "/tmp/x.sock",
            token: GOOD_TOKEN,
            appName: "IDE Code",
            appVersion: "1.0",
            userDataDir: "/tmp/u",
            createdAt: 0,
        };
        assert.ok((0, client_js_1.validateInstance)(base));
        assert.equal((0, client_js_1.validateInstance)({ ...base, token: "A".repeat(64) }), undefined); // not lowercase hex
        assert.equal((0, client_js_1.validateInstance)({ ...base, token: "a".repeat(63) }), undefined);
        assert.equal((0, client_js_1.validateInstance)({ ...base, pid: 0 }), undefined);
        assert.equal((0, client_js_1.validateInstance)({ ...base, pid: 1.5 }), undefined);
        assert.equal((0, client_js_1.validateInstance)({ ...base, socketPath: "" }), undefined);
        assert.equal((0, client_js_1.validateInstance)({ ...base, createdAt: -1 }), undefined);
        assert.equal((0, client_js_1.validateInstance)(null), undefined);
    });
});
(0, node_test_1.describe)("ls (spec §3.1)", () => {
    (0, node_test_1.it)("prints the table with ANSI-stripped titles and footer", async () => {
        const bridge = await startFakeBridge(threadsHandler(THREADS));
        const out = makeOut();
        const code = await (0, client_js_1.runDesktopBridge)(["ls"], out.opts);
        await bridge.close();
        assert.equal(code, 0);
        assert.match(out.stdout, /THREAD ID\s+TITLE\s+SOURCE\s+STATUS\s+WHERE/);
        assert.ok(out.stdout.includes("Fix the bug"));
        assert.ok(out.stdout.includes("Refactor things")); // ANSI stripped
        assert.ok(!out.stdout.includes("\u001b[31m"));
        assert.ok(out.stdout.includes("2 thread(s) across 1 running IDE Code instance(s)"));
    });
    (0, node_test_1.it)("--json prints threads with instance info", async () => {
        const bridge = await startFakeBridge(threadsHandler(THREADS));
        const out = makeOut();
        const code = await (0, client_js_1.runDesktopBridge)(["ls", "--json"], out.opts);
        await bridge.close();
        assert.equal(code, 0);
        const parsed = JSON.parse(out.stdout);
        assert.equal(parsed.length, 2);
        assert.equal(parsed[0].instance.label, "IDE Code 0.1.0-test");
        assert.equal(parsed[0].instance.userDataDir, "/tmp/ide-user");
    });
    (0, node_test_1.it)("uses (untitled) for blank titles", async () => {
        const bridge = await startFakeBridge(threadsHandler([{ id: "t1", title: "   ", source: "local", status: "idle", lastUpdatedAt: 1, windowId: "main" }]));
        const out = makeOut();
        await (0, client_js_1.runDesktopBridge)(["ls"], out.opts);
        await bridge.close();
        assert.ok(out.stdout.includes("(untitled)"));
    });
});
(0, node_test_1.describe)("send statuses (spec §3.1)", () => {
    async function runSend(sendResponse, args, extraOpts = {}) {
        const bridge = await startFakeBridge(threadsHandler(THREADS, sendResponse));
        const out = makeOut();
        const code = await (0, client_js_1.runDesktopBridge)(args, { ...out.opts, ...extraOpts });
        const seen = bridge.seen;
        await bridge.close();
        return { code, stdout: out.stdout, stderr: out.stderr, seen };
    }
    (0, node_test_1.it)("submitted → stdout message, exit 0", async () => {
        const r = await runSend((b) => ({ status: "submitted", threadId: b.threadId, windowId: "main", threadTitle: "Fix the bug" }), ["send", "abcdef-1111", "hello", "world"]);
        assert.equal(r.code, 0);
        assert.ok(r.stdout.includes('Submitted to "Fix the bug" (abcdef-1111)'));
        const send = r.seen.find((s) => s.type === "sendMessage");
        assert.equal(send?.body.text, "hello world"); // args joined with single spaces
        assert.equal(send?.body.force, false);
    });
    (0, node_test_1.it)("submitted with --force on a running thread appends (interrupted running turn)", async () => {
        const r = await runSend((b) => ({ status: "submitted", threadId: b.threadId, windowId: "main", threadTitle: "Refactor" }), ["send", "abcxyz-2222", "--force", "go"]);
        assert.equal(r.code, 0);
        assert.ok(r.stdout.includes("(interrupted running turn)"));
        const send = r.seen.find((s) => s.type === "sendMessage");
        assert.equal(send?.body.force, true);
    });
    (0, node_test_1.it)("queued → stdout message, exit 0", async () => {
        const r = await runSend((b) => ({ status: "queued", threadId: b.threadId, windowId: "main", threadTitle: "Refactor" }), ["send", "abcxyz-2222", "later"]);
        assert.equal(r.code, 0);
        assert.ok(r.stdout.includes('Queued in "Refactor" (agent is running; will submit when the current turn ends)'));
    });
    (0, node_test_1.it)("unknown-thread → stderr, exit 1 (UUID-shaped ref → pseudo-thread)", async () => {
        const uuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
        const r = await runSend((b) => ({ status: "unknown-thread", threadId: b.threadId }), ["send", uuid, "hi"]);
        assert.equal(r.code, 1);
        assert.ok(r.stderr.includes(`error: thread "${uuid}" is no longer available`));
        const send = r.seen.find((s) => s.type === "sendMessage");
        assert.equal(send?.body.threadId, uuid); // pseudo-thread send proceeded
    });
    (0, node_test_1.it)("timeout status → stderr, exit 1", async () => {
        const r = await runSend(() => ({ status: "timeout" }), ["send", "abcdef-1111", "hi"]);
        assert.equal(r.code, 1);
        assert.ok(r.stderr.includes("error: desktop did not confirm the message before timeout; it may have been submitted"));
    });
    (0, node_test_1.it)("not-sendable → stderr, exit 1", async () => {
        const r = await runSend(() => ({ status: "not-sendable", threadTitle: "Old", reason: "thread is archived" }), ["send", "abcdef-1111", "hi"]);
        assert.equal(r.code, 1);
        assert.ok(r.stderr.includes('error: thread "Old" is not sendable: thread is archived'));
    });
    (0, node_test_1.it)("error → stderr, exit 1", async () => {
        const r = await runSend(() => ({ status: "error", message: "kaput" }), ["send", "abcdef-1111", "hi"]);
        assert.equal(r.code, 1);
        assert.ok(r.stderr.includes("error: kaput"));
    });
    (0, node_test_1.it)("--json prints raw response JSON; exit 1 unless submitted/queued", async () => {
        const ok = await runSend((b) => ({ status: "submitted", threadId: b.threadId, threadTitle: "X" }), ["send", "abcdef-1111", "--json", "hi"]);
        assert.equal(ok.code, 0);
        assert.deepEqual(JSON.parse(ok.stdout), { status: "submitted", threadId: "abcdef-1111", threadTitle: "X" });
        const bad = await runSend(() => ({ status: "error", message: "kaput" }), ["send", "abcdef-1111", "--json", "hi"]);
        assert.equal(bad.code, 1);
        assert.deepEqual(JSON.parse(bad.stdout), { status: "error", message: "kaput" });
        assert.ok(bad.stderr.includes("error: kaput"));
    });
});
(0, node_test_1.describe)("thread-ref resolution (spec §3.1 Gl)", () => {
    function rows(threads) {
        return threads.map((t) => ({
            thread: {
                id: t.id,
                title: t.title ?? "",
                source: "local",
                status: t.status ?? "idle",
                lastUpdatedAt: t.lastUpdatedAt ?? 0,
                windowId: "main",
            },
            instance: { label: "L" },
        }));
    }
    (0, node_test_1.it)("exact id match wins; most-recently-updated wins ties", () => {
        const r = (0, client_js_1.resolveRef)("abc", rows([
            { id: "abc", lastUpdatedAt: 10 },
            { id: "abc", lastUpdatedAt: 30 },
            { id: "abcdef", lastUpdatedAt: 99 },
        ]), []);
        assert.equal(r.kind, "resolved");
        if (r.kind === "resolved") {
            assert.equal(r.thread.lastUpdatedAt, 30);
        }
    });
    (0, node_test_1.it)("unique prefix match resolves", async () => {
        const bridge = await startFakeBridge(threadsHandler(THREADS));
        const out = makeOut();
        const code = await (0, client_js_1.runDesktopBridge)(["send", "abcdef-11", "hi"], out.opts);
        await bridge.close();
        assert.equal(code, 0);
        assert.ok(out.stdout.includes("(abcdef-1111)"));
    });
    (0, node_test_1.it)("ambiguous prefix → stderr, exit 1", async () => {
        const bridge = await startFakeBridge(threadsHandler(THREADS));
        const out = makeOut();
        const code = await (0, client_js_1.runDesktopBridge)(["send", "abc", "hi"], out.opts);
        await bridge.close();
        assert.equal(code, 1);
        assert.ok(out.stderr.includes('Desktop thread ref "abc" is ambiguous:'));
        assert.ok(out.stderr.includes('abcdef-1111 "Fix the bug"'));
    });
    (0, node_test_1.it)("UUID refs are lowercased before matching", () => {
        const id = "abcdef12-3456-7890-abcd-ef1234567890"; // UUID-shaped (36 chars)
        const r = (0, client_js_1.resolveRef)(id.toUpperCase(), rows([{ id }]), []);
        assert.equal(r.kind, "resolved");
        if (r.kind === "resolved") {
            assert.equal(r.thread.id, id);
        }
    });
    (0, node_test_1.it)("non-UUID unknown ref → Unknown desktop thread ref", async () => {
        const bridge = await startFakeBridge(threadsHandler(THREADS));
        const out = makeOut();
        const code = await (0, client_js_1.runDesktopBridge)(["send", "zzz-nope", "hi"], out.opts);
        await bridge.close();
        assert.equal(code, 1);
        assert.ok(out.stderr.includes('Unknown desktop thread ref "zzz-nope"'));
    });
});
(0, node_test_1.describe)("message text, errors, help", () => {
    (0, node_test_1.it)("empty message → stderr, exit 1", async () => {
        const bridge = await startFakeBridge(threadsHandler(THREADS));
        const out = makeOut();
        const code = await (0, client_js_1.runDesktopBridge)(["send", "abcdef-1111"], out.opts);
        await bridge.close();
        assert.equal(code, 1);
        assert.ok(out.stderr.includes("error: message text is empty (provide text or use --stdin)"));
    });
    (0, node_test_1.it)("--stdin reads the full stdin (child process)", async () => {
        const bridge = await startFakeBridge(threadsHandler(THREADS));
        const clientJs = path.join(__dirname, "..", "desktop", "client.js");
        const child = (0, node_child_process_1.spawn)(process.execPath, [
            "--input-type=module",
            "-e",
            `import(${JSON.stringify(clientJs)}).then((m) => m.runDesktopBridge(["send", "abcdef-1111", "--stdin"]).then((c) => process.exit(c)))`,
        ], {
            stdio: ["pipe", "pipe", "pipe"],
            env: { ...process.env, [client_js_1.BRIDGE_DIR_ENV]: process.env[client_js_1.BRIDGE_DIR_ENV] },
        });
        let stdout = "";
        child.stdout.on("data", (c) => (stdout += c.toString()));
        child.stdin.write("hello\nfrom\nstdin");
        child.stdin.end();
        const code = await new Promise((resolve) => child.on("close", resolve));
        const seen = bridge.seen;
        await bridge.close();
        assert.equal(code, 0);
        assert.ok(stdout.includes("Submitted to"));
        const send = seen.find((s) => s.type === "sendMessage");
        assert.equal(send?.body.text, "hello\nfrom\nstdin"); // full stdin, not space-joined
    });
    (0, node_test_1.it)("no live instance → error, exit 1 (no silent fallthrough — spec §5 P2-9)", async () => {
        const out = makeOut();
        const code = await (0, client_js_1.runDesktopBridge)(["ls"], out.opts);
        assert.equal(code, 1);
        assert.ok(out.stderr.includes("error: no running IDE Code desktop instance found"));
    });
    (0, node_test_1.it)("-h prints the usage block", async () => {
        const out = makeOut();
        const code = await (0, client_js_1.runDesktopBridge)(["--help"], out.opts);
        assert.equal(code, 0);
        assert.ok(out.stdout.includes("Usage: ide-code desktop <command>"));
        assert.ok(out.stdout.includes("ls                                List threads live in running desktop instances"));
        assert.ok(out.stdout.includes(client_js_1.USAGE));
    });
    (0, node_test_1.it)("request timeout (injected short timeout) → timed-out message, exit 1", async () => {
        const bridge = await startFakeBridge(() => "hang");
        const out = makeOut();
        const code = await (0, client_js_1.runDesktopBridge)(["ls"], { ...out.opts, requestTimeoutMs: 150 });
        await bridge.close();
        assert.equal(code, 1);
        assert.ok(out.stderr.includes("IDE Code 0.1.0-test desktop bridge request timed out"));
    });
    (0, node_test_1.it)("non-200 with {status:error} surfaces the message", async () => {
        // UUID-shaped ref → pseudo-thread, so resolution needs no listThreads
        // (the handler 500s every request including listThreads).
        const uuid = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
        const bridge = await startFakeBridge(() => ({ code: 500, body: { status: "error", message: "kaput" } }));
        const out = makeOut();
        const code = await (0, client_js_1.runDesktopBridge)(["send", uuid, "hi"], out.opts);
        await bridge.close();
        assert.equal(code, 1);
        assert.ok(out.stderr.includes("error: kaput"));
    });
    (0, node_test_1.it)("other non-200 → HTTP <code> message", async () => {
        const bridge = await startFakeBridge(() => ({ code: 503, body: { error: "busy" } }));
        const out = makeOut();
        const code = await (0, client_js_1.runDesktopBridge)(["ls"], out.opts);
        await bridge.close();
        assert.equal(code, 1);
        assert.ok(out.stderr.includes("IDE Code 0.1.0-test desktop bridge returned HTTP 503: busy"));
    });
    (0, node_test_1.it)("stripAnsi removes escape sequences", () => {
        assert.equal((0, client_js_1.stripAnsi)("\u001b[31mred\u001b[0m plain"), "red plain");
    });
});
