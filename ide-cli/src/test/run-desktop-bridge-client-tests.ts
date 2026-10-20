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
import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import {
  runDesktopBridge,
  discoverInstances,
  validateInstance,
  resolveRef,
  stripAnsi,
  BRIDGE_DIR_ENV,
  USAGE,
  type BridgeOptions,
} from "../desktop/client.js";

const GOOD_TOKEN = "a".repeat(64);
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ide-bridge-client-test-"));
let seq = 0;

/** Injected output sink pair; pass as BridgeOptions. */
function makeOut() {
  let stdout = "";
  let stderr = "";
  const opts: BridgeOptions = {
    stdout: (line: string) => {
      stdout += line + "\n";
    },
    stderr: (line: string) => {
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

type Handler = (body: Record<string, unknown>) => { code: number; body: unknown } | "hang";

interface FakeBridge {
  socketPath: string;
  token: string;
  label: string;
  seen: Array<{ type: string; body: Record<string, unknown> }>;
  close: () => Promise<void>;
}

function writeInstanceJson(dir: string, overrides: Record<string, unknown> = {}): void {
  fs.writeFileSync(
    path.join(dir, `instance-${seq++}.json`),
    JSON.stringify({
      protocolVersion: 1,
      pid: process.pid,
      socketPath: path.join(dir, `bridge-${seq}.sock`),
      token: GOOD_TOKEN,
      appName: "IDE Code",
      appVersion: "0.1.0-test",
      userDataDir: "/tmp/ide-user",
      createdAt: Date.now(),
      ...overrides,
    }),
  );
}

/** Spin a real unix-socket HTTP bridge server + matching instance JSON. */
async function startFakeBridge(
  handler: Handler,
  opts: { appVersion?: string } = {},
): Promise<FakeBridge> {
  const dir = fs.mkdtempSync(path.join(TEST_DIR, "bridge-"));
  const socketPath = path.join(dir, `bridge-${seq++}.sock`);
  const token = GOOD_TOKEN;
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
      if (out === "hang") {
        return; // never respond — exercises the request timeout
      }
      res.writeHead(out.code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  // The instance JSON must land in the discovery dir the client reads
  // (IDE_CODE_DESKTOP_BRIDGE_DIR in tests).
  writeInstanceJson(process.env[BRIDGE_DIR_ENV] as string, {
    socketPath,
    token,
    appVersion: opts.appVersion ?? "0.1.0-test",
  });
  return {
    socketPath,
    token,
    label: `IDE Code ${opts.appVersion ?? "0.1.0-test"}`,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const f of fs.readdirSync(dir)) {
          try {
            fs.unlinkSync(path.join(dir, f));
          } catch {
            /* ignore */
          }
        }
      }),
  };
}

function threadsHandler(
  threads: Array<Record<string, unknown>>,
  sendResponse?: (body: Record<string, unknown>) => Record<string, unknown>,
): Handler {
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

describe("discovery validation (spec §3.1 R1)", () => {
  it("accepts a valid instance and skips invalid/stale files silently", () => {
    const d = process.env[BRIDGE_DIR_ENV] as string;
    writeInstanceJson(d); // valid
    writeInstanceJson(d, { token: "xyz" }); // bad token
    writeInstanceJson(d, { pid: 2147483647 }); // stale pid (kill(pid,0) fails)
    writeInstanceJson(d, { protocolVersion: 2 }); // wrong protocol
    writeInstanceJson(d, { appName: "" }); // empty appName
    fs.writeFileSync(path.join(d, "garbage.json"), "{not json");
    fs.writeFileSync(path.join(d, "notes.txt"), "hello");
    const found = discoverInstances();
    assert.equal(found.length, 1);
    assert.equal(found[0].label, "IDE Code 0.1.0-test");
    assert.equal(found[0].token, GOOD_TOKEN);
  });

  it("returns [] when the bridge dir does not exist", () => {
    assert.deepEqual(discoverInstances(path.join(TEST_DIR, "nope-not-here")), []);
  });

  it("validateInstance rejects each bad field", () => {
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
    assert.ok(validateInstance(base));
    assert.equal(validateInstance({ ...base, token: "A".repeat(64) }), undefined); // not lowercase hex
    assert.equal(validateInstance({ ...base, token: "a".repeat(63) }), undefined);
    assert.equal(validateInstance({ ...base, pid: 0 }), undefined);
    assert.equal(validateInstance({ ...base, pid: 1.5 }), undefined);
    assert.equal(validateInstance({ ...base, socketPath: "" }), undefined);
    assert.equal(validateInstance({ ...base, createdAt: -1 }), undefined);
    assert.equal(validateInstance(null), undefined);
  });
});

describe("ls (spec §3.1)", () => {
  it("prints the table with ANSI-stripped titles and footer", async () => {
    const bridge = await startFakeBridge(threadsHandler(THREADS));
    const out = makeOut();
    const code = await runDesktopBridge(["ls"], out.opts);
    await bridge.close();
    assert.equal(code, 0);
    assert.match(out.stdout, /THREAD ID\s+TITLE\s+SOURCE\s+STATUS\s+WHERE/);
    assert.ok(out.stdout.includes("Fix the bug"));
    assert.ok(out.stdout.includes("Refactor things")); // ANSI stripped
    assert.ok(!out.stdout.includes("\u001b[31m"));
    assert.ok(out.stdout.includes("2 thread(s) across 1 running IDE Code instance(s)"));
  });

  it("--json prints threads with instance info", async () => {
    const bridge = await startFakeBridge(threadsHandler(THREADS));
    const out = makeOut();
    const code = await runDesktopBridge(["ls", "--json"], out.opts);
    await bridge.close();
    assert.equal(code, 0);
    const parsed = JSON.parse(out.stdout) as Array<Record<string, unknown>>;
    assert.equal(parsed.length, 2);
    assert.equal((parsed[0].instance as Record<string, unknown>).label, "IDE Code 0.1.0-test");
    assert.equal((parsed[0].instance as Record<string, unknown>).userDataDir, "/tmp/ide-user");
  });

  it("uses (untitled) for blank titles", async () => {
    const bridge = await startFakeBridge(
      threadsHandler([{ id: "t1", title: "   ", source: "local", status: "idle", lastUpdatedAt: 1, windowId: "main" }]),
    );
    const out = makeOut();
    await runDesktopBridge(["ls"], out.opts);
    await bridge.close();
    assert.ok(out.stdout.includes("(untitled)"));
  });
});

describe("send statuses (spec §3.1)", () => {
  async function runSend(
    sendResponse: (body: Record<string, unknown>) => Record<string, unknown>,
    args: string[],
    extraOpts: BridgeOptions = {},
  ): Promise<{ code: number; stdout: string; stderr: string; seen: FakeBridge["seen"] }> {
    const bridge = await startFakeBridge(threadsHandler(THREADS, sendResponse));
    const out = makeOut();
    const code = await runDesktopBridge(args, { ...out.opts, ...extraOpts });
    const seen = bridge.seen;
    await bridge.close();
    return { code, stdout: out.stdout, stderr: out.stderr, seen };
  }

  it("submitted → stdout message, exit 0", async () => {
    const r = await runSend(
      (b) => ({ status: "submitted", threadId: b.threadId, windowId: "main", threadTitle: "Fix the bug" }),
      ["send", "abcdef-1111", "hello", "world"],
    );
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes('Submitted to "Fix the bug" (abcdef-1111)'));
    const send = r.seen.find((s) => s.type === "sendMessage");
    assert.equal(send?.body.text, "hello world"); // args joined with single spaces
    assert.equal(send?.body.force, false);
  });

  it("submitted with --force on a running thread appends (interrupted running turn)", async () => {
    const r = await runSend(
      (b) => ({ status: "submitted", threadId: b.threadId, windowId: "main", threadTitle: "Refactor" }),
      ["send", "abcxyz-2222", "--force", "go"],
    );
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes("(interrupted running turn)"));
    const send = r.seen.find((s) => s.type === "sendMessage");
    assert.equal(send?.body.force, true);
  });

  it("queued → stdout message, exit 0", async () => {
    const r = await runSend(
      (b) => ({ status: "queued", threadId: b.threadId, windowId: "main", threadTitle: "Refactor" }),
      ["send", "abcxyz-2222", "later"],
    );
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes('Queued in "Refactor" (agent is running; will submit when the current turn ends)'));
  });

  it("unknown-thread → stderr, exit 1 (UUID-shaped ref → pseudo-thread)", async () => {
    const uuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const r = await runSend((b) => ({ status: "unknown-thread", threadId: b.threadId }), ["send", uuid, "hi"]);
    assert.equal(r.code, 1);
    assert.ok(r.stderr.includes(`error: thread "${uuid}" is no longer available`));
    const send = r.seen.find((s) => s.type === "sendMessage");
    assert.equal(send?.body.threadId, uuid); // pseudo-thread send proceeded
  });

  it("timeout status → stderr, exit 1", async () => {
    const r = await runSend(() => ({ status: "timeout" }), ["send", "abcdef-1111", "hi"]);
    assert.equal(r.code, 1);
    assert.ok(r.stderr.includes("error: desktop did not confirm the message before timeout; it may have been submitted"));
  });

  it("not-sendable → stderr, exit 1", async () => {
    const r = await runSend(
      () => ({ status: "not-sendable", threadTitle: "Old", reason: "thread is archived" }),
      ["send", "abcdef-1111", "hi"],
    );
    assert.equal(r.code, 1);
    assert.ok(r.stderr.includes('error: thread "Old" is not sendable: thread is archived'));
  });

  it("error → stderr, exit 1", async () => {
    const r = await runSend(() => ({ status: "error", message: "kaput" }), ["send", "abcdef-1111", "hi"]);
    assert.equal(r.code, 1);
    assert.ok(r.stderr.includes("error: kaput"));
  });

  it("--json prints raw response JSON; exit 1 unless submitted/queued", async () => {
    const ok = await runSend(
      (b) => ({ status: "submitted", threadId: b.threadId, threadTitle: "X" }),
      ["send", "abcdef-1111", "--json", "hi"],
    );
    assert.equal(ok.code, 0);
    assert.deepEqual(JSON.parse(ok.stdout), { status: "submitted", threadId: "abcdef-1111", threadTitle: "X" });

    const bad = await runSend(() => ({ status: "error", message: "kaput" }), ["send", "abcdef-1111", "--json", "hi"]);
    assert.equal(bad.code, 1);
    assert.deepEqual(JSON.parse(bad.stdout), { status: "error", message: "kaput" });
    assert.ok(bad.stderr.includes("error: kaput"));
  });
});

describe("thread-ref resolution (spec §3.1 Gl)", () => {
  function rows(threads: Array<Record<string, unknown>>) {
    return threads.map((t) => ({
      thread: {
        id: t.id as string,
        title: (t.title as string) ?? "",
        source: "local",
        status: (t.status as string) ?? "idle",
        lastUpdatedAt: (t.lastUpdatedAt as number) ?? 0,
        windowId: "main",
      },
      instance: { label: "L" } as never,
    }));
  }

  it("exact id match wins; most-recently-updated wins ties", () => {
    const r = resolveRef(
      "abc",
      rows([
        { id: "abc", lastUpdatedAt: 10 },
        { id: "abc", lastUpdatedAt: 30 },
        { id: "abcdef", lastUpdatedAt: 99 },
      ]),
      [],
    );
    assert.equal(r.kind, "resolved");
    if (r.kind === "resolved") {
      assert.equal(r.thread.lastUpdatedAt, 30);
    }
  });

  it("unique prefix match resolves", async () => {
    const bridge = await startFakeBridge(threadsHandler(THREADS));
    const out = makeOut();
    const code = await runDesktopBridge(["send", "abcdef-11", "hi"], out.opts);
    await bridge.close();
    assert.equal(code, 0);
    assert.ok(out.stdout.includes("(abcdef-1111)"));
  });

  it("ambiguous prefix → stderr, exit 1", async () => {
    const bridge = await startFakeBridge(threadsHandler(THREADS));
    const out = makeOut();
    const code = await runDesktopBridge(["send", "abc", "hi"], out.opts);
    await bridge.close();
    assert.equal(code, 1);
    assert.ok(out.stderr.includes('Desktop thread ref "abc" is ambiguous:'));
    assert.ok(out.stderr.includes('abcdef-1111 "Fix the bug"'));
  });

  it("UUID refs are lowercased before matching", () => {
    const id = "abcdef12-3456-7890-abcd-ef1234567890"; // UUID-shaped (36 chars)
    const r = resolveRef(id.toUpperCase(), rows([{ id }]), []);
    assert.equal(r.kind, "resolved");
    if (r.kind === "resolved") {
      assert.equal(r.thread.id, id);
    }
  });

  it("non-UUID unknown ref → Unknown desktop thread ref", async () => {
    const bridge = await startFakeBridge(threadsHandler(THREADS));
    const out = makeOut();
    const code = await runDesktopBridge(["send", "zzz-nope", "hi"], out.opts);
    await bridge.close();
    assert.equal(code, 1);
    assert.ok(out.stderr.includes('Unknown desktop thread ref "zzz-nope"'));
  });
});

describe("message text, errors, help", () => {
  it("empty message → stderr, exit 1", async () => {
    const bridge = await startFakeBridge(threadsHandler(THREADS));
    const out = makeOut();
    const code = await runDesktopBridge(["send", "abcdef-1111"], out.opts);
    await bridge.close();
    assert.equal(code, 1);
    assert.ok(out.stderr.includes("error: message text is empty (provide text or use --stdin)"));
  });

  it("--stdin reads the full stdin (child process)", async () => {
    const bridge = await startFakeBridge(threadsHandler(THREADS));
    const clientJs = path.join(__dirname, "..", "desktop", "client.js");
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import(${JSON.stringify(clientJs)}).then((m) => m.runDesktopBridge(["send", "abcdef-1111", "--stdin"]).then((c) => process.exit(c)))`,
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, [BRIDGE_DIR_ENV]: process.env[BRIDGE_DIR_ENV] },
      },
    );
    let stdout = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stdin.write("hello\nfrom\nstdin");
    child.stdin.end();
    const code: number = await new Promise((resolve) => child.on("close", resolve));
    const seen = bridge.seen;
    await bridge.close();
    assert.equal(code, 0);
    assert.ok(stdout.includes("Submitted to"));
    const send = seen.find((s) => s.type === "sendMessage");
    assert.equal(send?.body.text, "hello\nfrom\nstdin"); // full stdin, not space-joined
  });

  it("no live instance → error, exit 1 (no silent fallthrough — spec §5 P2-9)", async () => {
    const out = makeOut();
    const code = await runDesktopBridge(["ls"], out.opts);
    assert.equal(code, 1);
    assert.ok(out.stderr.includes("error: no running IDE Code desktop instance found"));
  });

  it("-h prints the usage block", async () => {
    const out = makeOut();
    const code = await runDesktopBridge(["--help"], out.opts);
    assert.equal(code, 0);
    assert.ok(out.stdout.includes("Usage: ide-code desktop <command>"));
    assert.ok(out.stdout.includes("ls                                List threads live in running desktop instances"));
    assert.ok(out.stdout.includes(USAGE));
  });

  it("request timeout (injected short timeout) → timed-out message, exit 1", async () => {
    const bridge = await startFakeBridge(() => "hang");
    const out = makeOut();
    const code = await runDesktopBridge(["ls"], { ...out.opts, requestTimeoutMs: 150 });
    await bridge.close();
    assert.equal(code, 1);
    assert.ok(out.stderr.includes("IDE Code 0.1.0-test desktop bridge request timed out"));
  });

  it("non-200 with {status:error} surfaces the message", async () => {
    // UUID-shaped ref → pseudo-thread, so resolution needs no listThreads
    // (the handler 500s every request including listThreads).
    const uuid = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
    const bridge = await startFakeBridge(() => ({ code: 500, body: { status: "error", message: "kaput" } }));
    const out = makeOut();
    const code = await runDesktopBridge(["send", uuid, "hi"], out.opts);
    await bridge.close();
    assert.equal(code, 1);
    assert.ok(out.stderr.includes("error: kaput"));
  });

  it("other non-200 → HTTP <code> message", async () => {
    const bridge = await startFakeBridge(() => ({ code: 503, body: { error: "busy" } }));
    const out = makeOut();
    const code = await runDesktopBridge(["ls"], out.opts);
    await bridge.close();
    assert.equal(code, 1);
    assert.ok(out.stderr.includes("IDE Code 0.1.0-test desktop bridge returned HTTP 503: busy"));
  });

  it("stripAnsi removes escape sequences", () => {
    assert.equal(stripAnsi("\u001b[31mred\u001b[0m plain"), "red plain");
  });
});
