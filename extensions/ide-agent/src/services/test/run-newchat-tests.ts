/**
 * Functional tests for ide.newChat (P1 CX1b) — node:test, zero extra deps.
 *
 * Exercises ComposerDataService.newChat() in idle and running states. The
 * `vscode` module is stubbed via Module._load interception (no node_modules
 * stub needed, nothing ships).
 *
 * Run after `tsc`:  node --test out/services/test/run-newchat-tests.js
 */
import { after, describe, it } from "node:test";
import * as assert from "node:assert";
import Module from "node:module";

// ---- vscode API stub (test-only, never packaged) ----
const calls: { warnings: string[]; infos: string[] } = { warnings: [], infos: [] };
class StubEventEmitter<T> {
  private listeners: Array<(e: T) => void> = [];
  get event() {
    return (listener: (e: T) => void) => {
      this.listeners.push(listener);
      return { dispose: () => undefined };
    };
  }
  fire(e: T): void {
    for (const l of [...this.listeners]) l(e);
  }
  dispose(): void {
    this.listeners = [];
  }
}
const vscodeStub = {
  EventEmitter: StubEventEmitter,
  window: {
    showWarningMessage: (m: string) => {
      calls.warnings.push(m);
      return Promise.resolve(undefined);
    },
    showInformationMessage: (m: string) => {
      calls.infos.push(m);
      return Promise.resolve(undefined);
    },
    createOutputChannel: () => ({
      appendLine: () => undefined,
      dispose: () => undefined,
      show: () => undefined,
      clear: () => undefined,
    }),
  },
  workspace: {
    getConfiguration: () => ({
      get: (_k: string, d: string) => d,
      has: () => false,
      update: async () => undefined,
    }),
    workspaceFolders: undefined,
  },
  Uri: {
    file: (p: string) => ({ fsPath: p, scheme: "file", toString: () => p }),
    joinPath: (base: { fsPath: string }, ...parts: string[]) => ({
      fsPath: [base.fsPath, ...parts].join("/"),
    }),
  },
  commands: {
    executeCommand: async () => undefined,
    registerCommand: () => ({ dispose: () => undefined }),
  },
  calls,
};
const origLoad = (Module as unknown as { _load: Function })._load;
(Module as unknown as { _load: Function })._load = function (
  request: string,
  ...rest: unknown[]
) {
  if (request === "vscode") return vscodeStub;
  return origLoad.call(this, request, ...rest);
};

/**
 * DEV-GAPS-36: every ComposerDataService created below is tracked so the
 * file-level after() can dispose it. An undisposed composer leaks its
 * CheckpointStorageCompareService scheduler (15 s ref'd activation timer →
 * 10 min ref'd interval chain, per GAPS-25's root cause in
 * checkpointStorageCompare.ts) and its `bun serve` sidecar
 * (IdeCodeEngineAdapter — engineMode defaults to "sidecar"): the sidecar's
 * piped stdio keeps the event loop alive, so node:test hangs at file level
 * after all suites pass ("Promise resolution is still pending but the event
 * loop has already resolved"). dispose() is idempotent, stops the
 * checkpoint scheduler (via the GAPS-25 this.checkpoints.dispose()
 * cascade) and kills the sidecar (SIGTERM, escalated to SIGKILL).
 */
const trackedDisposables = new Set<{ dispose(): void }>();
function track<T extends { dispose(): void }>(d: T): T {
  trackedDisposables.add(d);
  return d;
}
after(() => {
  for (const d of trackedDisposables) {
    try {
      d.dispose();
    } catch {
      /* teardown must never fail the run */
    }
  }
  trackedDisposables.clear();
});

import { ComposerDataService } from "../composerDataService";
import { BubbleData } from "../../model";

function makeBubble(id: string, text: string): BubbleData {
  return {
    bubbleId: id,
    role: "human",
    mode: "agent",
    text,
    toolCalls: [],
    createdAt: Date.now(),
  };
}

function freshService(): ComposerDataService {
  calls.warnings.length = 0;
  calls.infos.length = 0;
  return track(new ComposerDataService(undefined));
}

describe("newChat (P1 CX1b)", () => {
  it("idle: returns true; clears bubbles, checkpoints, queue; fires reset events", async () => {
    const svc = freshService();
    const events: string[] = [];
    svc.onDidChange((e) => events.push(e.kind));

    // Seed state belonging to the "old" conversation.
    svc.bubbles.setBubbleData(makeBubble("b1", "hello"));
    svc.bubbles.setBubbleData(makeBubble("b2", "world"));
    svc.queue.enqueue("queued prompt 1", "agent");
    svc.queue.enqueue("queued prompt 2", "agent");
    (svc.checkpoints as unknown as { records: unknown[] }).records.push({
      checkpointId: "cp1",
      bubbleId: "b1",
      createdAt: Date.now(),
      label: "test",
      isAfter: false,
      files: [],
      newlyCreatedFiles: [],
      newlyCreatedFolders: [],
    });

    assert.strictEqual(svc.bubbles.getAllInOrder().length, 2);
    assert.strictEqual(svc.queue.length, 2);

    const ok = await svc.newChat();

    assert.strictEqual(ok, true, "idle newChat must succeed");
    assert.strictEqual(svc.bubbles.getAllInOrder().length, 0, "bubbles cleared");
    assert.strictEqual(svc.queue.length, 0, "queue drained");
    assert.strictEqual(
      (svc.checkpoints as unknown as { records: unknown[] }).records.length,
      0,
      "checkpoints cleared",
    );
    assert.ok(events.includes("bubblesReset"), "bubblesReset fired (webview re-renders empty)");
    assert.ok(events.includes("newChat"), "newChat fired (webview resets composer state)");
    assert.ok(events.includes("queueChanged"), "queueChanged fired (queue chip hides)");
    assert.strictEqual(calls.warnings.length, 0, "no warning on success");
  });

  it("running: returns false, warns, leaves state intact", async () => {
    const svc = freshService();
    svc.bubbles.setBubbleData(makeBubble("b1", "hello"));
    svc.queue.enqueue("queued prompt", "agent");
    // Simulate an in-flight turn (private field).
    (svc as unknown as { running: boolean }).running = true;

    const ok = await svc.newChat();

    assert.strictEqual(ok, false, "running newChat must refuse");
    assert.strictEqual(calls.warnings.length, 1, "warning shown");
    assert.match(calls.warnings[0], /still running/i);
    assert.strictEqual(svc.bubbles.getAllInOrder().length, 1, "bubbles NOT cleared");
    assert.strictEqual(svc.queue.length, 1, "queue NOT drained");
  });

  it("idle with empty state: still succeeds and fires reset events", async () => {
    const svc = freshService();
    const events: string[] = [];
    svc.onDidChange((e) => events.push(e.kind));
    const ok = await svc.newChat();
    assert.strictEqual(ok, true);
    assert.ok(events.includes("bubblesReset"));
    assert.ok(events.includes("newChat"));
  });
});
