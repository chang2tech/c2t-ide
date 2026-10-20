/**
 * CheckpointStorageCompareService tests (node:test, zero extra deps).
 *
 * Covers the Cursor-parity scheduling of the host-storage compare service
 * (binary, Cursor 3.25.6 cursor-agent-host class `pw` — evidence
 * deepdig-runtime-checkpoint-2026-10-19.md §1.4):
 *  - the three timing constants together: 60 s debounce / 10 min interval /
 *    15 s activation delay
 *  - noteCheckpoint: pending set + 60 s debounce reset + trigger "checkpoint"
 *  - single-flight merge: checkpoint trigger wins over interval
 *  - cross-window catalog lease: interval compares need it, checkpoint
 *    compares bypass it
 *  - failure dedup caps: 4 clusters / 3 samples per cluster / 10 events per run
 *  - wiring: CheckpointService.persist() fires noteCheckpoint(composerId)
 *
 * Timing is driven by a virtual FakeTimer (no 60 s real waits).
 *
 * Run after `tsc`:  node out/services/test/run-checkpoint-storage-compare-tests.js
 */
import { describe, it, before, after } from "node:test";
import * as assert from "node:assert";
import * as path from "node:path";
import * as os from "node:os";
import { promises as fsp } from "node:fs";
import { Module } from "node:module";
import {
  CheckpointStorageCompareService,
  CompareSessionsFn,
  SessionCompareResult,
  StorageCompareTimer,
  activationDelayMs,
  checkpointDebounceMs,
  failureClusterCap,
  failureEventsPerRunCap,
  failureSamplesPerClusterCap,
  intervalMs,
} from "../checkpointStorageCompare";

/* ---------- virtual timer ---------- */

class FakeTimer implements StorageCompareTimer {
  private queue: Array<{ id: number; at: number; cb: () => void }> = [];
  private nextId = 1;
  nowMs = 0;

  now(): number {
    return this.nowMs;
  }
  setTimeout(cb: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.queue.push({ id, at: this.nowMs + ms, cb });
    return id;
  }
  clearTimeout(id: unknown): void {
    this.queue = this.queue.filter((t) => t.id !== id);
  }
  armedCount(): number {
    return this.queue.length;
  }
  /** Advance virtual time, firing due timers in order; flush async work. */
  async advance(ms: number): Promise<void> {
    const end = this.nowMs + ms;
    for (;;) {
      this.queue.sort((a, b) => a.at - b.at);
      const next = this.queue[0];
      if (!next || next.at > end) {
        break;
      }
      this.queue.shift();
      this.nowMs = next.at;
      next.cb();
      await flush();
    }
    this.nowMs = end;
    await flush();
  }
}

async function flush(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((r) => setImmediate(r));
  }
  // Real-timer breath: on a loaded machine, threadpool/file I/O can lag
  // behind a burst of setImmediate rounds. Pure microtask work doesn't need
  // this; real I/O does.
  await new Promise((r) => setTimeout(r, 25));
}

/** Poll until cond() is true (for assertions over real async I/O). */
async function waitFor(cond: () => boolean, ms = 10000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) {
      throw new Error("waitFor timeout");
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

function passAll(sessions: readonly string[]): SessionCompareResult[] {
  return sessions.map((sessionId) => ({ sessionId, verdict: "pass" as const }));
}

function makeSvc(
  timer: FakeTimer,
  extra: {
    compare?: CompareSessionsFn;
    lease?: { tryAcquire(): boolean; holderPid?(): number | undefined };
    autostart?: boolean;
  } = {},
): { svc: CheckpointStorageCompareService; logs: string[]; calls: SessionCompareResult[][] } {
  const logs: string[] = [];
  const calls: SessionCompareResult[][] = [];
  const compare: CompareSessionsFn = (sessions) => {
    const results = (extra.compare ?? passAll)(sessions);
    return results instanceof Promise
      ? results.then((r) => {
          calls.push(r);
          return r;
        })
      : (calls.push(results), results);
  };
  const svc = new CheckpointStorageCompareService({
    timer,
    lease: extra.lease,
    compareSessions: compare,
    onLog: (m) => logs.push(m),
  });
  if (extra.autostart !== false) {
    svc.start();
  }
  return { svc, logs, calls };
}

/* ---------- constants: all three together, exact binary values ---------- */

describe("timing constants (binary §1.4)", () => {
  it("adopts the 60s / 10min / 15s constants together", () => {
    assert.strictEqual(checkpointDebounceMs, 60_000);
    assert.strictEqual(intervalMs, 600_000);
    assert.strictEqual(activationDelayMs, 15_000);
  });
  it("adopts the failure-dedup caps", () => {
    assert.strictEqual(failureClusterCap, 4);
    assert.strictEqual(failureSamplesPerClusterCap, 3);
    assert.strictEqual(failureEventsPerRunCap, 10);
  });
});

/* ---------- debounce ---------- */

describe("noteCheckpoint debounce (60 s)", () => {
  it("fires one compare at exactly 60 s with trigger=checkpoint", async () => {
    const timer = new FakeTimer();
    // autostart:false — isolate the debounce from the 15 s interval scheduling.
    const { svc, logs, calls } = makeSvc(timer, { autostart: false });
    svc.noteCheckpoint("s1");
    await timer.advance(59_999);
    assert.strictEqual(calls.length, 0, "no compare before the debounce elapses");
    await timer.advance(1);
    await waitFor(() => calls.length === 1);
    assert.deepStrictEqual(
      calls[0]!.map((r) => r.sessionId),
      ["s1"],
    );
    assert.ok(logs.some((l) => l.includes("trigger=checkpoint")));
    svc.dispose();
  });

  it("resets the 60 s debounce on every noteCheckpoint", async () => {
    const timer = new FakeTimer();
    const { svc, calls } = makeSvc(timer, { autostart: false });
    svc.noteCheckpoint("a"); // t=0 → due t=60
    await timer.advance(30_000);
    svc.noteCheckpoint("b"); // t=30 → due t=90
    await timer.advance(59_999); // t=89_999
    assert.strictEqual(calls.length, 0, "debounce was reset by the second note");
    await timer.advance(1); // t=90
    await waitFor(() => calls.length === 1);
    assert.deepStrictEqual(
      calls[0]!.map((r) => r.sessionId).sort(),
      ["a", "b"],
    );
    svc.dispose();
  });
});

/* ---------- activation delay + periodic interval ---------- */

describe("activation delay (15 s) + interval (10 min) + debounce (60 s) together", () => {
  it("runs interval@15s, checkpoint@60s, then interval every 10 min over the catalog", async () => {
    const timer = new FakeTimer();
    const { svc, logs, calls } = makeSvc(timer);
    svc.noteCheckpoint("s1");
    svc.noteCheckpoint("s2");
    await timer.advance(14_999);
    assert.strictEqual(calls.length, 0, "no compare before the activation delay");
    await timer.advance(1); // t=15 s — first interval compare
    await waitFor(() => calls.length === 1);
    // interval compares cover the catalog (all known sessions)
    assert.deepStrictEqual(
      calls[0]!.map((r) => r.sessionId).sort(),
      ["s1", "s2"],
    );
    await timer.advance(45_000); // t=60 s — debounce fires the checkpoint compare
    await waitFor(() => calls.length === 2);
    assert.deepStrictEqual(
      calls[1]!.map((r) => r.sessionId).sort(),
      ["s1", "s2"],
    );
    await timer.advance(555_000); // t=615 s — second periodic compare
    await waitFor(() => calls.length === 3);
    await timer.advance(600_000); // t=1215 s — third periodic compare
    await waitFor(() => calls.length === 4);
    const triggers = logs
      .filter((l) => l.includes("compare done"))
      .map((l) => l.match(/trigger=(\w+)/)![1]);
    assert.deepStrictEqual(triggers, ["interval", "checkpoint", "interval", "interval"]);
    svc.dispose();
  });
});

/* ---------- single-flight merge ---------- */

describe("single-flight: queued requests merge, checkpoint wins", () => {
  it("merges a checkpoint request arriving during a running interval compare", async () => {
    const timer = new FakeTimer();
    let release!: (results: SessionCompareResult[]) => void;
    const blocked: CompareSessionsFn = (sessions) =>
      new Promise<SessionCompareResult[]>((resolve) => {
        release = resolve;
      });
    const logs: string[] = [];
    const calls: string[][] = [];
    const svc = new CheckpointStorageCompareService({
      timer,
      compareSessions: (sessions) => {
        calls.push([...sessions]);
        return blocked(sessions);
      },
      onLog: (m) => logs.push(m),
    });
    svc.start();
    svc.noteCheckpoint("a"); // t=0 → debounce due t=60
    await timer.advance(15_000); // interval compare starts, blocks
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(calls[0], ["a"]);
    svc.noteCheckpoint("b"); // while running → debounce RESET, now due t=75
    await timer.advance(60_000); // t=75 s: debounce fires → queued + merged
    release(passAll(["a"]));
    await waitFor(() => calls.length === 2);
    assert.strictEqual(calls.length, 2, "merged request runs after the first finishes");
    // merged sessions = union; checkpoint trigger wins over interval in the merge
    assert.deepStrictEqual(calls[1]!.sort(), ["a", "b"]);
    release(passAll(["a", "b"])); // let the merged compare finish
    await waitFor(
      () => logs.filter((l) => l.includes("compare done")).length === 2,
    );
    const doneLines = logs.filter((l) => l.includes("compare done"));
    assert.ok(doneLines[0]!.includes("trigger=interval"));
    assert.ok(doneLines[1]!.includes("trigger=checkpoint"), "checkpoint wins the merge");
    await flush();
    svc.dispose();
  });
});

/* ---------- cross-window catalog lease ---------- */

describe("catalog lease (interval needs it, checkpoint bypasses it)", () => {
  it("skips interval compares when another window holds the lease, with the binary log line", async () => {
    const timer = new FakeTimer();
    const { svc, logs, calls } = makeSvc(timer, {
      lease: { tryAcquire: () => false, holderPid: () => 4242 },
    });
    svc.noteCheckpoint("x");
    await timer.advance(15_000); // interval due → lease denied
    assert.strictEqual(calls.length, 0, "interval compare skipped without the lease");
    assert.ok(
      logs.some((l) =>
        l.includes(
          "catalog compares run in another window (pid 4242); this host compares only the sessions it checkpoints",
        ),
      ),
      "binary-verbatim skip message",
    );
    svc.dispose();
  });

  it("checkpoint-triggered compares bypass the lease and always run", async () => {
    const timer = new FakeTimer();
    const { svc, calls } = makeSvc(timer, {
      lease: { tryAcquire: () => false, holderPid: () => 4242 },
    });
    svc.noteCheckpoint("x");
    await timer.advance(15_000); // interval skipped
    assert.strictEqual(calls.length, 0);
    await timer.advance(45_000); // t=60 s: debounce → checkpoint compare
    assert.strictEqual(calls.length, 1, "checkpoint compare runs despite the lease");
    assert.deepStrictEqual(
      calls[0]!.map((r) => r.sessionId),
      ["x"],
    );
    svc.dispose();
  });
});

/* ---------- failure dedup caps ---------- */

describe("failure dedup (4 clusters / 3 samples / 10 events per run)", () => {
  it("enforces the caps on one failing run", async () => {
    const timer = new FakeTimer();
    const shapes: Array<[string, string, number]> = [
      ["boom", "disk", 5],
      ["bang", "net", 4],
      ["crash", "mem", 5],
      ["oops", "io", 5],
      ["fifth", "cpu", 1], // 5th cluster — must be dropped (cap 4)
    ];
    const results: SessionCompareResult[] = [];
    for (const [cls, detail, n] of shapes) {
      for (let i = 0; i < n; i++) {
        // "class: sample" — the coarse fingerprint groups on the class part.
        results.push({ sessionId: `${cls}-${i}`, verdict: "fail", detail: `${cls}: ${detail} #${i}` });
      }
    }
    const { svc, logs } = makeSvc(timer, { compare: () => results, autostart: false });
    svc.noteCheckpoint("witness");
    await timer.advance(60_000);
    await waitFor(() => logs.some((l) => l.includes("compare done")));
    const clusters = svc.getFailureClusters();
    assert.strictEqual(clusters.length, 4, "at most 4 clusters");
    assert.ok(!clusters.some((c) => c.key.startsWith("fail::fifth")), "5th cluster dropped");
    for (const c of clusters) {
      assert.ok(c.samples.length <= 3, `cluster ${c.key}: at most 3 samples`);
    }
    const boom = clusters.find((c) => c.key.startsWith("fail::boom"))!;
    assert.strictEqual(boom.samples.length, 3);
    const failureLines = logs.filter((l) => l.includes("] session "));
    assert.strictEqual(failureLines.length, 10, "at most 10 failure events per run");
    svc.dispose();
  });
});

/* ---------- dispose ---------- */

describe("dispose", () => {
  it("clears all timers; noteCheckpoint afterwards is a no-op", async () => {
    const timer = new FakeTimer();
    const { svc, calls } = makeSvc(timer);
    svc.noteCheckpoint("a");
    svc.dispose();
    assert.strictEqual(timer.armedCount(), 0);
    svc.noteCheckpoint("b");
    await timer.advance(120_000);
    assert.strictEqual(calls.length, 0);
    assert.strictEqual(timer.armedCount(), 0);
  });
});

/* ---------- wiring: CheckpointService.persist() → noteCheckpoint ---------- */

let ROOT = "";

function makeUri(fsPath: string) {
  return { fsPath, scheme: "file", toString: () => fsPath };
}

const vscodeStub: any = {
  workspace: {
    get workspaceFolders() {
      return ROOT ? [{ uri: makeUri(ROOT), name: "test", index: 0 }] : undefined;
    },
    getConfiguration: () => ({ get: (_k: string, d: unknown) => d, update: async () => {} }),
    fs: {
      readFile: (uri: any) => fsp.readFile(uri.fsPath),
      writeFile: async (uri: any, content: Uint8Array) => {
        await fsp.mkdir(path.dirname(uri.fsPath), { recursive: true });
        await fsp.writeFile(uri.fsPath, content);
      },
      delete: (uri: any, opts?: any) =>
        fsp.rm(uri.fsPath, { recursive: !!(opts && opts.recursive), force: true }),
      createDirectory: (uri: any) => fsp.mkdir(uri.fsPath, { recursive: true }),
    },
    createFileSystemWatcher: () => ({
      onDidChange: () => {},
      onDidCreate: () => {},
      dispose: () => {},
    }),
  },
  Uri: {
    file: (p: string) => makeUri(p),
    joinPath: (base: any, ...parts: string[]) => makeUri(path.join(base.fsPath, ...parts)),
  },
  window: {
    showWarningMessage: () => Promise.resolve("Continue"),
    showInformationMessage: () => {},
    showErrorMessage: () => {},
  },
};

const origLoad = (Module as any)._load;
(Module as any)._load = function (request: string, parent: any, isMain: any) {
  if (request === "vscode") {
    return vscodeStub;
  }
  return origLoad.call(this, request, parent, isMain);
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { CheckpointService } = require("../checkpointService");

describe("CheckpointService → storage compare wiring", () => {
  let dir = "";
  let storageDir = "";

  before(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ckpt-compare-wire-"));
    storageDir = path.join(dir, ".storage");
    ROOT = dir;
  });

  after(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
    ROOT = "";
  });

  it("persist() arms the 60 s debounce and the real verifier passes on the store", async () => {
    const timer = new FakeTimer();
    const logs: string[] = [];
    const context: any = { globalStorageUri: makeUri(storageDir), subscriptions: [] };
    const svc: any = new CheckpointService(context, {
      storageCompareTimer: timer,
      storageCompareLog: (m: string) => logs.push(m),
    });
    try {
      await svc.captureBefore("bubble-1", "wired");
      // The persist above fired noteCheckpoint("default"): the 60 s debounce
      // is armed, and the service was started in the constructor (15 s
      // activation, then 10 min interval).
      await timer.advance(14_999);
      assert.ok(
        !logs.some((l) => l.includes("compare done")),
        "no compare before the 15 s activation delay",
      );
      await timer.advance(1); // t=15 s: interval compare, real verifier
      await waitFor(() => logs.some((l) => l.includes("trigger=interval")));
      assert.ok(
        !logs.some((l) => l.includes("trigger=checkpoint")),
        "no checkpoint compare before the 60 s debounce elapses",
      );
      await timer.advance(45_000); // t=60 s: debounce fires
      await waitFor(() => logs.some((l) => l.includes("trigger=checkpoint")));
      const done = logs.filter((l) => l.includes("compare done"));
      assert.strictEqual(done.length, 2);
      assert.ok(done.every((l) => l.includes("sessions=1")));
      assert.ok(
        !logs.some((l) => l.includes("] session ")),
        "verifier passed on the real store: no failure lines",
      );
    } finally {
      svc.dispose();
    }
  });

  it("verifyCheckpointStorage fails on a corrupt store", async () => {
    const timer = new FakeTimer();
    const context: any = { globalStorageUri: makeUri(storageDir), subscriptions: [] };
    const svc: any = new CheckpointService(context, { storageCompareTimer: timer });
    try {
      await svc.captureBefore("bubble-1", "wired");
      await fsp.writeFile(path.join(storageDir, "checkpoints-default.json"), "{not json");
      const results = await svc.verifyCheckpointStorage(["default", "other"]);
      const self = results.find((r: any) => r.sessionId === "default")!;
      assert.strictEqual(self.verdict, "fail");
      assert.ok(typeof self.detail === "string" && self.detail.length > 0);
      const other = results.find((r: any) => r.sessionId === "other")!;
      assert.strictEqual(other.verdict, "pass");
    } finally {
      svc.dispose();
    }
  });
});
