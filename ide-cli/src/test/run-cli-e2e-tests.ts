/**
 * run-cli-e2e-tests.ts — E2E suite for the ide-code CLI (node:test).
 *
 * Unlike the unit suites (which call runDesktopBridge/runAgent directly),
 * this suite drives the REAL dispatch() entry point — the same function
 * src/cli.ts calls — against REAL mock transports:
 *
 *  - desktop ls/send: a real unix-socket HTTP bridge server (net/http,
 *    socket file under os.tmpdir()) plus a mock instance JSON file in a
 *    temp dir pointed at by IDE_CODE_DESKTOP_BRIDGE_DIR.
 *  - agent -p: a mock engine HTTP server implementing the real wire
 *    protocol (same endpoints/auth/SSE format as the production sidecar,
 *    copied from run-agent-cli-tests.ts). Injected through dispatch's
 *    runAgent dep — the only seam is the engine connection itself, which
 *    is exactly what the mock server replaces.
 *
 * Output is captured through dispatch's injectable stdout/stderr sinks —
 * never by patching process.stdout.write (that corrupts the node:test
 * TAP stream).
 *
 * Run after `tsc`:  node --test out/test/run-cli-e2e-tests.js
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Writable } from "node:stream";
import { dispatch, type DispatchDeps } from "../dispatch.js";
import { runAgent } from "../agent/cli.js";
import {
  EngineClient,
  type EngineClientOptions,
} from "../agent/engine.js";
import { runDesktopBridge, BRIDGE_DIR_ENV, type BridgeOptions } from "../desktop/client.js";

const GOOD_TOKEN = "a".repeat(64);
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ide-cli-e2e-"));
let seq = 0;

// ---------------------------------------------------------------------------
// capture
// ---------------------------------------------------------------------------

function makeCapture() {
  let text = "";
  const line = (s: string): void => {
    text += s + "\n";
  };
  const stream = new Writable({
    write(chunk, _enc, cb) {
      text += chunk.toString();
      cb();
    },
  });
  return { line, stream, get text() {
    return text;
  } };
}

// ---------------------------------------------------------------------------
// mock desktop bridge (unix-socket HTTP + instance JSON discovery file)
// ---------------------------------------------------------------------------

type BridgeHandler = (body: Record<string, unknown>) => { code: number; body: unknown };

interface FakeBridge {
  socketPath: string;
  seen: Array<{ type: string; body: Record<string, unknown> }>;
  close: () => Promise<void>;
}

function writeInstanceJson(dir: string, socketPath: string): void {
  fs.writeFileSync(
    path.join(dir, `instance-${seq++}.json`),
    JSON.stringify({
      protocolVersion: 1,
      pid: process.pid,
      socketPath,
      token: GOOD_TOKEN,
      appName: "IDE Code",
      appVersion: "0.1.0-e2e",
      userDataDir: "/tmp/ide-user",
      createdAt: Date.now(),
    }),
  );
}

async function startFakeBridge(handler: BridgeHandler): Promise<FakeBridge> {
  const dir = fs.mkdtempSync(path.join(TEST_DIR, "bridge-"));
  const socketPath = path.join(dir, `bridge-${seq++}.sock`);
  const seen: FakeBridge["seen"] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      } catch {
        /* keep {} */
      }
      seen.push({ type: typeof body.type === "string" ? body.type : "", body });
      const out = handler(body);
      res.writeHead(out.code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  writeInstanceJson(process.env[BRIDGE_DIR_ENV] as string, socketPath);
  return {
    socketPath,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function bridgeHandler(
  threads: Array<Record<string, unknown>>,
  sendResponse?: (body: Record<string, unknown>) => Record<string, unknown>,
): BridgeHandler {
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

const E2E_THREADS = [
  { id: "e2eaaa-1111", title: "E2E first thread", source: "local", status: "idle", lastUpdatedAt: 100, windowId: "main" },
  { id: "e2ebbb-2222", title: "E2E second thread", source: "local", status: "running", lastUpdatedAt: 200, windowId: "aux" },
];

// ---------------------------------------------------------------------------
// mock engine (same wire protocol as run-agent-cli-tests.ts)
// ---------------------------------------------------------------------------

interface MockEngine {
  port: number;
  replies: Array<{ reqID: string; decision: string }>;
  close(): Promise<void>;
}

function startMockEngine(): Promise<MockEngine> {
  const replies: MockEngine["replies"] = [];
  const mock: MockEngine = { port: 0, replies, close: async () => {} };
  let emitSse: ((type: string, data: unknown) => void) | undefined;
  let replyWaiters: Array<() => void> = [];

  const frame = (type: string, data: unknown): string =>
    `data: ${JSON.stringify({ id: `e${Date.now()}${Math.random()}`, type, data })}\n\n`;

  const server = http.createServer((req, res) => {
    const url = req.url ?? "";
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const json = (code: number, obj: unknown) => {
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      if (req.method === "GET" && url === "/api/config") {
        return json(200, {});
      }
      if (req.method === "GET" && url === "/api/model") {
        return json(200, { data: [{ id: "m1", modelID: "m1", providerID: "p1", name: "E2E Model" }] });
      }
      if (req.method === "POST" && url === "/api/session") {
        return json(200, { data: { id: "ses_e2e" } });
      }
      const promptMatch = /^\/api\/session\/([^/]+)\/prompt$/.exec(url);
      if (req.method === "POST" && promptMatch) {
        const payload = body ? (JSON.parse(body) as Record<string, unknown>) : {};
        const text = typeof payload.text === "string" ? payload.text : "";
        setTimeout(() => {
          const send = emitSse;
          if (!send) {
            return;
          }
          const sid = "ses_e2e";
          const finish = () => {
            send("session.text.delta", { sessionID: sid, delta: "e2e " });
            send("session.text.delta", { sessionID: sid, delta: "answer" });
            send("session.execution.succeeded", { sessionID: sid });
          };
          if (text.includes("PERM")) {
            send("permission.asked", {
              id: "req-e2e",
              sessionID: sid,
              action: "shell",
              resources: ["/tmp/x"],
              message: "run shell",
            });
            const deadline = setTimeout(finish, 3000);
            replyWaiters.push(() => {
              clearTimeout(deadline);
              setTimeout(finish, 20);
            });
          } else {
            setTimeout(finish, 20);
          }
        }, 30);
        return json(200, { data: { id: "msg1" } });
      }
      const replyMatch = /^\/api\/session\/([^/]+)\/permission\/([^/]+)\/reply$/.exec(url);
      if (req.method === "POST" && replyMatch) {
        const payload = body ? (JSON.parse(body) as Record<string, unknown>) : {};
        replies.push({ reqID: replyMatch[2], decision: String(payload.decision ?? "") });
        for (const w of replyWaiters) {
          w();
        }
        replyWaiters = [];
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
          } catch {
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
      mock.close = () =>
        new Promise<void>((r) => {
          server.close(() => r());
        });
      resolve(mock);
    });
  });
}

// ---------------------------------------------------------------------------
// runCli: the real dispatch() with captured sinks
// ---------------------------------------------------------------------------

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(mock: MockEngine | undefined, argv: string[]): Promise<CliResult> {
  const out = makeCapture();
  const err = makeCapture();
  const deps: DispatchDeps = {
    stdout: out.line,
    stderr: err.line,
    // Forward the captured sinks into the real bridge client. dispatch()
    // calls deps.runDesktopBridge(rest) with argv only, so the wrapper is
    // the seam — everything below it (discovery, wire, output) is real.
    runDesktopBridge: (a: string[]) =>
      runDesktopBridge(a, { stdout: out.line, stderr: err.line } satisfies BridgeOptions),
  };
  if (mock) {
    // The only seam: the engine connection. Everything above it
    // (dispatch -> agent arg parsing -> print-mode turn loop) is real.
    const clientFactory = (_opts: EngineClientOptions) =>
      Promise.resolve(EngineClient.forConnection({ host: "127.0.0.1", port: mock.port, token: "t".repeat(64) }));
    deps.runAgent = (a: string[]) =>
      runAgent(a, { out: out.stream, err: err.stream, isTTY: false, clientFactory });
  }
  const code = await dispatch(argv, deps);
  return { code, stdout: out.text, stderr: err.text };
}

// ---------------------------------------------------------------------------
// env setup
// ---------------------------------------------------------------------------

const origBridgeDir = process.env[BRIDGE_DIR_ENV];
beforeEach(() => {
  process.env[BRIDGE_DIR_ENV] = fs.mkdtempSync(path.join(TEST_DIR, "discovery-"));
});
afterEach(() => {
  if (origBridgeDir === undefined) {
    delete process.env[BRIDGE_DIR_ENV];
  } else {
    process.env[BRIDGE_DIR_ENV] = origBridgeDir;
  }
});

// ---------------------------------------------------------------------------
// E2E: desktop ls
// ---------------------------------------------------------------------------

describe("E2E: desktop ls (real dispatch + mock unix-socket bridge)", () => {
  it("prints the thread table with headers and the running-instance footer", async () => {
    const bridge = await startFakeBridge(bridgeHandler(E2E_THREADS));
    const r = await runCli(undefined, ["desktop", "ls"]);
    await bridge.close();
    assert.equal(r.code, 0);
    assert.match(r.stdout, /THREAD ID\s+TITLE\s+SOURCE\s+STATUS\s+WHERE/);
    assert.ok(r.stdout.includes("e2eaaa-1111"));
    assert.ok(r.stdout.includes("E2E first thread"));
    assert.ok(r.stdout.includes("aux")); // WHERE <- windowId
    assert.ok(r.stdout.includes("2 thread(s) across 1 running IDE Code instance(s)"));
  });

  it("--json prints threads with instance info", async () => {
    const bridge = await startFakeBridge(bridgeHandler(E2E_THREADS));
    const r = await runCli(undefined, ["desktop", "ls", "--json"]);
    await bridge.close();
    assert.equal(r.code, 0);
    const parsed = JSON.parse(r.stdout) as Array<Record<string, unknown>>;
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0].id, "e2eaaa-1111");
    assert.equal(parsed[0].title, "E2E first thread");
    const inst = parsed[0].instance as Record<string, unknown>;
    assert.equal(inst.label, "IDE Code 0.1.0-e2e");
    assert.equal(inst.appName, "IDE Code");
    assert.equal(inst.appVersion, "0.1.0-e2e");
    assert.equal(inst.userDataDir, "/tmp/ide-user");
  });

  it("no live instance -> stderr error, exit 1 (no silent fallthrough)", async () => {
    const r = await runCli(undefined, ["desktop", "ls"]);
    assert.equal(r.code, 1);
    assert.ok(r.stderr.includes("error: no running IDE Code desktop instance found"));
  });
});

// ---------------------------------------------------------------------------
// E2E: desktop send
// ---------------------------------------------------------------------------

describe("E2E: desktop send (real dispatch + mock unix-socket bridge)", () => {
  it("submitted: exact id, stdout message, exit 0, text space-joined", async () => {
    const bridge = await startFakeBridge(
      bridgeHandler(E2E_THREADS, (b) => ({ status: "submitted", threadId: b.threadId, windowId: "main", threadTitle: "E2E first thread" })),
    );
    const r = await runCli(undefined, ["desktop", "send", "e2eaaa-1111", "hello", "e2e"]);
    const seen = bridge.seen;
    await bridge.close();
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes('Submitted to "E2E first thread" (e2eaaa-1111)'));
    const send = seen.find((s) => s.type === "sendMessage");
    assert.equal(send?.body.threadId, "e2eaaa-1111");
    assert.equal(send?.body.text, "hello e2e");
  });

  it("unique prefix resolves to the thread", async () => {
    const bridge = await startFakeBridge(bridgeHandler(E2E_THREADS));
    const r = await runCli(undefined, ["desktop", "send", "e2ebbb-22", "hi"]);
    await bridge.close();
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes("(e2ebbb-2222)"));
  });

  it("ambiguous prefix -> stderr, exit 1", async () => {
    const bridge = await startFakeBridge(bridgeHandler(E2E_THREADS));
    const r = await runCli(undefined, ["desktop", "send", "e2e", "hi"]);
    await bridge.close();
    assert.equal(r.code, 1);
    assert.ok(r.stderr.includes('Desktop thread ref "e2e" is ambiguous:'));
  });

  it("UUID-shaped unknown ref: pseudo-thread send proceeds; unknown-thread -> stderr, exit 1", async () => {
    const uuid = "cccccccc-dddd-eeee-ffff-000000000000";
    const bridge = await startFakeBridge(
      bridgeHandler(E2E_THREADS, (b) => ({ status: "unknown-thread", threadId: b.threadId })),
    );
    const r = await runCli(undefined, ["desktop", "send", uuid, "hi"]);
    const seen = bridge.seen;
    await bridge.close();
    assert.equal(r.code, 1);
    assert.ok(r.stderr.includes(`error: thread "${uuid}" is no longer available`));
    const send = seen.find((s) => s.type === "sendMessage");
    assert.equal(send?.body.threadId, uuid); // pseudo-thread fallback reached the bridge
  });

  it("non-UUID unknown ref -> stderr, exit 1", async () => {
    const bridge = await startFakeBridge(bridgeHandler(E2E_THREADS));
    const r = await runCli(undefined, ["desktop", "send", "nope-not-here", "hi"]);
    await bridge.close();
    assert.equal(r.code, 1);
    assert.ok(r.stderr.includes('Unknown desktop thread ref "nope-not-here"'));
  });

  it("timeout status -> stderr, exit 1", async () => {
    const bridge = await startFakeBridge(bridgeHandler(E2E_THREADS, () => ({ status: "timeout" })));
    const r = await runCli(undefined, ["desktop", "send", "e2eaaa-1111", "hi"]);
    await bridge.close();
    assert.equal(r.code, 1);
    assert.ok(r.stderr.includes("error: desktop did not confirm the message before timeout"));
  });

  it("queued status -> stdout message, exit 0", async () => {
    const bridge = await startFakeBridge(
      bridgeHandler(E2E_THREADS, (b) => ({ status: "queued", threadId: b.threadId, threadTitle: "E2E second thread" })),
    );
    const r = await runCli(undefined, ["desktop", "send", "e2ebbb-2222", "later"]);
    await bridge.close();
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes('Queued in "E2E second thread" (agent is running; will submit when the current turn ends)'));
  });
});

// ---------------------------------------------------------------------------
// E2E: agent -p
// ---------------------------------------------------------------------------

describe("E2E: agent -p (real dispatch + mock engine HTTP server)", () => {
  it("text output is the final answer only, exit 0", async () => {
    const mock = await startMockEngine();
    const r = await runCli(mock, ["agent", "-p", "hello"]);
    await mock.close();
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), "e2e answer");
  });

  it("--output-format json prints the result envelope", async () => {
    const mock = await startMockEngine();
    const r = await runCli(mock, ["agent", "-p", "hello", "--output-format", "json"]);
    await mock.close();
    assert.equal(r.code, 0);
    const env = JSON.parse(r.stdout.trim()) as Record<string, unknown>;
    assert.equal(env.result, "e2e answer");
    assert.equal(env.sessionID, "ses_e2e");
    assert.equal(env.endKind, "succeeded");
  });

  it("--output-format stream-json emits deltas and turn.end", async () => {
    const mock = await startMockEngine();
    const r = await runCli(mock, ["agent", "-p", "hello", "--output-format", "stream-json"]);
    await mock.close();
    assert.equal(r.code, 0);
    const lines = r.stdout
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const types = lines.map((l) => l.type);
    assert.ok(types.includes("turn.start"));
    const deltas = lines.filter((l) => l.type === "text.delta");
    assert.equal(
      deltas.map((d) => d.delta).join(""),
      "e2e answer",
    );
    const end = lines.find((l) => l.type === "turn.end");
    assert.equal(end?.endKind, "succeeded");
    assert.equal(end?.result, "e2e answer");
  });

  it("--force auto-approves permission.asked (decision: once), exit 0", async () => {
    const mock = await startMockEngine();
    const r = await runCli(mock, ["agent", "-p", "--force", "PERM", "shell"]);
    await mock.close();
    assert.equal(r.code, 0);
    assert.equal(mock.replies.length, 1);
    assert.equal(mock.replies[0].reqID, "req-e2e");
    assert.equal(mock.replies[0].decision, "once");
  });
});
