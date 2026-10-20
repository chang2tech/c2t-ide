/**
 * Desktop bridge SERVER tests (node:test, vscode stubbed via ./vscode-stub).
 *
 * A fake ChatTabService (minimal BridgeChatTabSource interface) backs the
 * server; requests go over a REAL unix socket via node:http.
 *
 * Spec: ~/workspace/ide-code-mission/docs/rea/dig-cli-2026-10-19.md §3.1, §5 P2.
 *
 * Covers:
 *  - instance JSON schema validity (spec §5 P2-8 / §3.1 R1)
 *  - 401 on bad/missing token (spec §3.1 Bearer auth)
 *  - listThreads mapping (id/title/source/status/lastUpdatedAt/windowId)
 *  - sendMessage submitted / unknown-thread / queued / force-abort
 *  - socket + JSON cleanup on stop (best-effort, never throws)
 *
 * Run after `tsc`:  node --test out/services/test/run-desktop-bridge-tests.js
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert";
import "./vscode-stub";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DesktopBridgeServer,
  type BridgeChatTabSource,
} from "../desktopBridgeServer";

/** Fake composer: the minimal BridgeComposer surface. */
class FakeComposer {
  isRunning = false;
  aborts = 0;
  submits: Array<{ text: string; sendMode?: string }> = [];
  abort(): void {
    this.aborts++;
    this.isRunning = false;
  }
  submit(text: string, opts?: { sendMode?: "default" | "manual" | "queue" | "sendNow" }): void {
    this.submits.push({ text, sendMode: opts?.sendMode });
  }
}

interface FakeTab {
  id: string;
  title: string;
  createdAt: number;
  pinned: boolean;
  pinnedAt?: number;
  composer: FakeComposer;
}

class FakeTabs implements BridgeChatTabSource {
  constructor(readonly tabs: FakeTab[]) {}
  listTabs(): FakeTab[] {
    return this.tabs;
  }
}

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ide-bridge-server-test-"));

let bridgeDir: string;
let server: DesktopBridgeServer | undefined;
let idleComposer: FakeComposer;
let runningComposer: FakeComposer;

function makeTabs(): FakeTabs {
  idleComposer = new FakeComposer();
  runningComposer = new FakeComposer();
  runningComposer.isRunning = true;
  return new FakeTabs([
    { id: "tab-idle-1", title: "Idle chat", createdAt: 1111, pinned: false, composer: idleComposer },
    { id: "tab-run-2", title: "Busy chat", createdAt: 2222, pinned: false, composer: runningComposer },
  ]);
}

beforeEach(async () => {
  bridgeDir = fs.mkdtempSync(path.join(TEST_DIR, "bridge-"));
  server = new DesktopBridgeServer({
    chatTabs: makeTabs(),
    appVersion: "9.9.9-test",
    userDataDir: "/tmp/ide-user-test",
    bridgeDir,
  });
  await server.start();
});

afterEach(async () => {
  await server?.stop();
  server = undefined;
});

function readInstanceJson(): Record<string, unknown> {
  const p = path.join(bridgeDir, `instance-${process.pid}.json`);
  return JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
}

function post(
  body: unknown,
  token: string | undefined,
  method = "POST",
  rawBody?: string,
): Promise<{ code: number; json: unknown }> {
  const inst = readInstanceJson();
  const socketPath = inst.socketPath as string;
  return new Promise((resolve, reject) => {
    const payload = rawBody ?? JSON.stringify(body);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token !== undefined) {
      headers["Authorization"] = `Bearer ${token}`;
    }
    const req = http.request({ socketPath, path: "/", method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json: unknown;
        try {
          json = text ? JSON.parse(text) : undefined;
        } catch {
          json = undefined;
        }
        resolve({ code: res.statusCode ?? 0, json });
      });
    });
    req.on("error", reject);
    req.end(payload);
  });
}

describe("instance advertisement (spec §5 P2-8)", () => {
  it("writes a valid instance JSON + 0600 socket on start", () => {
    const inst = readInstanceJson();
    assert.equal(inst.protocolVersion, 1);
    assert.equal(inst.pid, process.pid);
    assert.ok(typeof inst.socketPath === "string" && (inst.socketPath as string).endsWith(`bridge-${process.pid}.sock`));
    assert.match(inst.token as string, /^[0-9a-f]{64}$/);
    assert.equal(inst.appName, "IDE Code");
    assert.equal(inst.appVersion, "9.9.9-test");
    assert.equal(inst.userDataDir, "/tmp/ide-user-test");
    assert.ok(typeof inst.createdAt === "number" && (inst.createdAt as number) > 0);
    assert.ok(fs.existsSync(inst.socketPath as string));
  });

  it("falls back to 0.1.0-alpha / empty userDataDir when unset", async () => {
    const s2 = new DesktopBridgeServer({
      chatTabs: makeTabs(),
      appVersion: "",
      userDataDir: "",
      bridgeDir: fs.mkdtempSync(path.join(TEST_DIR, "bridge2-")),
    });
    await s2.start();
    const inst = JSON.parse(
      fs.readFileSync(path.join(s2.instanceFilePath), "utf8"),
    ) as Record<string, unknown>;
    assert.equal(inst.appVersion, "0.1.0-alpha");
    assert.equal(inst.userDataDir, "");
    await s2.stop();
  });
});

describe("auth + HTTP handling (spec §3.1)", () => {
  it("401s with {status:error} on missing token", async () => {
    const r = await post({ type: "listThreads" }, undefined);
    assert.equal(r.code, 401);
    assert.deepEqual(r.json, { status: "error", message: "unauthorized" });
  });

  it("401s on wrong token", async () => {
    const r = await post({ type: "listThreads" }, "b".repeat(64));
    assert.equal(r.code, 401);
    assert.deepEqual((r.json as Record<string, unknown>).status, "error");
  });

  it("400s on malformed JSON body", async () => {
    const inst = readInstanceJson();
    const r = await post({}, inst.token as string, "POST", "{nope");
    assert.equal(r.code, 400);
    assert.equal((r.json as Record<string, unknown>).status, "error");
  });

  it("404s on non-POST / wrong path", async () => {
    const inst = readInstanceJson();
    const r = await post({ type: "listThreads" }, inst.token as string, "GET");
    assert.equal(r.code, 404);
  });
});

describe("listThreads (spec §3.1)", () => {
  it("maps tabs with the real running-turn signal", async () => {
    const inst = readInstanceJson();
    const r = await post({ type: "listThreads" }, inst.token as string);
    assert.equal(r.code, 200);
    const threads = (r.json as Record<string, unknown>).threads as Array<Record<string, unknown>>;
    assert.equal(threads.length, 2);
    assert.deepEqual(threads[0], {
      id: "tab-idle-1",
      title: "Idle chat",
      source: "local",
      status: "idle", // composer.isRunning === false
      lastUpdatedAt: 1111, // = tab.createdAt (no separate updated-at signal)
      windowId: "main",
    });
    assert.equal(threads[1].status, "running"); // composer.isRunning === true
  });
});

describe("sendMessage (spec §3.1)", () => {
  it("submits to an idle tab via the composer submit path → submitted", async () => {
    const inst = readInstanceJson();
    const r = await post(
      { type: "sendMessage", threadId: "tab-idle-1", text: "hello bridge", force: false },
      inst.token as string,
    );
    assert.equal(r.code, 200);
    assert.deepEqual(r.json, {
      status: "submitted",
      threadId: "tab-idle-1",
      windowId: "main",
      threadTitle: "Idle chat",
    });
    assert.deepEqual(idleComposer.submits, [{ text: "hello bridge", sendMode: undefined }]);
  });

  it("unknown thread id → unknown-thread", async () => {
    const inst = readInstanceJson();
    const r = await post(
      { type: "sendMessage", threadId: "nope", text: "hi", force: false },
      inst.token as string,
    );
    assert.equal(r.code, 200);
    assert.deepEqual(r.json, { status: "unknown-thread", threadId: "nope" });
  });

  it("running tab without force → queued via sendMode:'queue' (real queue)", async () => {
    const inst = readInstanceJson();
    const r = await post(
      { type: "sendMessage", threadId: "tab-run-2", text: "wait your turn", force: false },
      inst.token as string,
    );
    assert.equal(r.code, 200);
    assert.deepEqual(r.json, {
      status: "queued",
      threadId: "tab-run-2",
      windowId: "main",
      threadTitle: "Busy chat",
    });
    assert.equal(runningComposer.aborts, 0); // no abort without force
    assert.deepEqual(runningComposer.submits, [{ text: "wait your turn", sendMode: "queue" }]);
  });

  it("force + running turn → abort() first, then submit → submitted", async () => {
    const inst = readInstanceJson();
    const r = await post(
      { type: "sendMessage", threadId: "tab-run-2", text: "stop and do this", force: true },
      inst.token as string,
    );
    assert.equal(r.code, 200);
    assert.equal((r.json as Record<string, unknown>).status, "submitted");
    assert.equal(runningComposer.aborts, 1); // the extension's abort path was reused
    assert.equal(runningComposer.submits.length, 1);
    assert.equal(runningComposer.submits[0].text, "stop and do this");
  });

  it("empty text → error", async () => {
    const inst = readInstanceJson();
    const r = await post(
      { type: "sendMessage", threadId: "tab-idle-1", text: "   ", force: false },
      inst.token as string,
    );
    assert.equal((r.json as Record<string, unknown>).status, "error");
    assert.equal(idleComposer.submits.length, 0);
  });
});

describe("stop()", () => {
  it("removes the instance JSON + socket and never throws", async () => {
    const inst = readInstanceJson();
    const socketPath = inst.socketPath as string;
    const jsonPath = path.join(bridgeDir, `instance-${process.pid}.json`);
    await server!.stop();
    assert.ok(!fs.existsSync(jsonPath));
    assert.ok(!fs.existsSync(socketPath));
    await server!.stop(); // double-stop is safe
    server = undefined; // afterEach must not stop twice (harmless anyway)
  });
});
