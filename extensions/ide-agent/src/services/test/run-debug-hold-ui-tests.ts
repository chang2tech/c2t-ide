/**
 * Debug hold + Debug Logs UI + proceed flow tests (DEV-DEBUG-HOLD-UI).
 *
 * Covers dig-debug-multitask-2026-10-19.md §3 D4 (dispatch hold) and D5
 * (Debug Logs UI + proceed/mark-fixed flow):
 *  - hold blocks dispatch: queued items resolve
 *    {shouldDispatch:false, heldForDebugRepro:true} and are NOT dispatched
 *  - release drains held items (Cursor's retryDispatchHeldForDebugRepro)
 *  - proceed()/markFixed() submit the VERBATIM instruction strings, clear
 *    the wait, and release the hold
 *  - any normal user submit clears the wait + releases the hold
 *  - onDebugTurnSettled arms the wait + hold and notifies the webview
 *    (debugState); leaving debug mode releases the hold
 *  - debugLogLine forwarding; forwarded history capped at 100 lines
 *
 * node:test, zero extra deps. `vscode` is stubbed via ./vscode-stub
 * (imported FIRST).
 *
 * Run after `tsc`:  node --test out/services/test/run-debug-hold-ui-tests.js
 */
import "./vscode-stub";
import { describe, it } from "node:test";
import * as assert from "node:assert";
import { MessageQueueService } from "../messageQueueService";
import {
  DebugModeController,
  DEBUG_PROCEED_INSTRUCTIONS,
  DEBUG_MARK_FIXED_INSTRUCTIONS,
  type DebugModeControllerDeps,
} from "../debugModeController";

/** Mock NDJSON ingest server (onLine + getRecentLines surface). */
class MockDebugServer {
  private listeners = new Set<(line: string) => void>();
  lines: string[] = [];
  onLine(listener: (line: string) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }
  getRecentLines(limit = 100): string[] {
    return this.lines.slice(-Math.max(0, limit));
  }
  emit(line: string): void {
    this.lines.push(line);
    for (const l of [...this.listeners]) {
      l(line);
    }
  }
}

interface Harness {
  queue: MessageQueueService;
  server: MockDebugServer;
  submitted: string[];
  webview: unknown[];
  controller: DebugModeController;
  deps: DebugModeControllerDeps;
}

function makeHarness(mode = "debug"): Harness {
  const queue = new MessageQueueService();
  const server = new MockDebugServer();
  const submitted: string[] = [];
  const webview: unknown[] = [];
  let currentMode = mode;
  const deps: DebugModeControllerDeps = {
    submit: (prompt: string) => {
      submitted.push(prompt);
    },
    queue,
    modes: { getMode: () => currentMode },
    getDebugServer: () => server,
  };
  const controller = new DebugModeController(deps, (m) => {
    webview.push(m);
  });
  return { queue, server, submitted, webview, controller, deps };
}

function lastOfType(webview: unknown[], type: string): Record<string, unknown> | undefined {
  const hits = webview.filter((m) => (m as { type: string }).type === type);
  return hits[hits.length - 1] as Record<string, unknown> | undefined;
}

describe("D4 — dispatch hold", () => {
  it("held queue items resolve {shouldDispatch:false, heldForDebugRepro:true} and are NOT dispatched", () => {
    const { queue } = makeHarness();
    queue.enqueue("first", "debug");
    queue.enqueue("second", "debug");
    queue.setDispatchHold(true);
    assert.equal(queue.isDispatchHeld(), true);
    const decision = queue.tryDispatchNextQueueItem();
    assert.deepEqual(decision, { shouldDispatch: false, heldForDebugRepro: true });
    // Nothing was dequeued while held.
    assert.equal(queue.length, 2);
  });

  it("unheld queue dispatches the head item", () => {
    const { queue } = makeHarness();
    queue.enqueue("first", "debug");
    const decision = queue.tryDispatchNextQueueItem();
    assert.equal(decision.shouldDispatch, true);
    assert.ok(decision.shouldDispatch && decision.item);
    assert.equal(decision.item!.text, "first");
    assert.equal(queue.length, 0);
  });

  it("releaseDispatchHold clears the hold and drains held items in FIFO order", () => {
    const { queue } = makeHarness();
    queue.enqueue("first", "debug");
    queue.enqueue("second", "debug");
    queue.setDispatchHold(true);
    const seen: string[] = [];
    const released = queue.releaseDispatchHold((item) => {
      seen.push(item.text);
    });
    assert.equal(queue.isDispatchHeld(), false);
    assert.deepEqual(seen, ["first", "second"]);
    assert.deepEqual(
      released.map((i) => i.text),
      ["first", "second"],
    );
    assert.equal(queue.length, 0);
  });

  it("releaseDispatchHold without a dispatcher just clears the hold", () => {
    const { queue } = makeHarness();
    queue.enqueue("kept", "debug");
    queue.setDispatchHold(true);
    const released = queue.releaseDispatchHold();
    assert.equal(queue.isDispatchHeld(), false);
    assert.deepEqual(released, []);
    assert.equal(queue.length, 1);
  });
});

describe("D4/D5 — controller state machine", () => {
  it("onDebugTurnSettled arms the wait + hold and posts debugState", () => {
    const { controller, queue, webview } = makeHarness();
    controller.onDebugTurnSettled();
    assert.equal(controller.isWaitingForUser(), true);
    assert.equal(queue.isDispatchHeld(), true);
    const state = lastOfType(webview, "debugState");
    assert.ok(state, "expected a debugState message");
    assert.equal(state!.active, true);
    assert.equal(state!.waitingForUser, true);
  });

  it("proceed() submits the VERBATIM proceed string, clears the wait, releases the hold", () => {
    const { controller, queue, submitted, webview } = makeHarness();
    controller.onDebugTurnSettled();
    controller.proceed();
    assert.deepEqual(submitted, ["Issue reproduced, please proceed"]);
    assert.equal(DEBUG_PROCEED_INSTRUCTIONS, "Issue reproduced, please proceed");
    assert.equal(controller.isWaitingForUser(), false);
    assert.equal(queue.isDispatchHeld(), false);
    const state = lastOfType(webview, "debugState");
    assert.equal(state!.waitingForUser, false);
  });

  it("markFixed() submits the VERBATIM cleanup string, clears the wait, releases the hold", () => {
    const { controller, queue, submitted } = makeHarness();
    controller.onDebugTurnSettled();
    controller.markFixed();
    assert.deepEqual(submitted, ["The issue has been fixed. Please clean up the instrumentation."]);
    assert.equal(
      DEBUG_MARK_FIXED_INSTRUCTIONS,
      "The issue has been fixed. Please clean up the instrumentation.",
    );
    assert.equal(controller.isWaitingForUser(), false);
    assert.equal(queue.isDispatchHeld(), false);
  });

  it("any normal user submit clears the wait + releases the hold without submitting anything", () => {
    const { controller, queue, submitted } = makeHarness();
    controller.onDebugTurnSettled();
    controller.onUserSubmit();
    assert.equal(controller.isWaitingForUser(), false);
    assert.equal(queue.isDispatchHeld(), false);
    assert.deepEqual(submitted, []);
  });

  it("leaving debug mode releases the hold and clears the wait", () => {
    const { controller, queue } = makeHarness();
    controller.onDebugTurnSettled();
    controller.onModeChanged(false);
    assert.equal(queue.isDispatchHeld(), false);
    assert.equal(controller.isWaitingForUser(), false);
  });

  it("entering debug mode replays buffered history to the webview", () => {
    const { controller, server, webview } = makeHarness();
    server.lines.push('{"msg":"early line"}');
    controller.onModeChanged(true);
    const history = lastOfType(webview, "debugLogHistory");
    assert.ok(history, "expected a debugLogHistory message");
    assert.deepEqual(history!.lines, ['{"msg":"early line"}']);
  });

  it("proceed() while a queue was held leaves the held items for the next drain", () => {
    const { controller, queue, submitted } = makeHarness();
    queue.enqueue("held follow-up", "debug");
    controller.onDebugTurnSettled();
    // The held item is not dispatched while the wait is armed.
    assert.deepEqual(queue.tryDispatchNextQueueItem(), {
      shouldDispatch: false,
      heldForDebugRepro: true,
    });
    controller.proceed();
    assert.deepEqual(submitted, ["Issue reproduced, please proceed"]);
    // Hold released: the item is now dispatchable again.
    const decision = queue.tryDispatchNextQueueItem();
    assert.equal(decision.shouldDispatch, true);
    assert.ok(decision.shouldDispatch && decision.item);
    assert.equal(decision.item!.text, "held follow-up");
  });
});

describe("D5 — Debug Logs feed", () => {
  it("ingested lines are forwarded to the webview as debugLogLine", () => {
    const { server, webview } = makeHarness();
    server.emit('{"ts":1729330000000,"msg":"hit breakpoint"}');
    const line = lastOfType(webview, "debugLogLine");
    assert.ok(line, "expected a debugLogLine message");
    assert.equal(line!.line, '{"ts":1729330000000,"msg":"hit breakpoint"}');
  });

  it("forwarded history is capped at 100 lines", () => {
    const { controller, server, webview } = makeHarness();
    for (let i = 0; i < 150; i++) {
      server.lines.push(`line-${i}`);
    }
    controller.syncInitialState();
    const history = lastOfType(webview, "debugLogHistory");
    assert.ok(history, "expected a debugLogHistory message");
    const lines = history!.lines as string[];
    assert.equal(lines.length, 100);
    assert.equal(lines[0], "line-50");
    assert.equal(lines[99], "line-149");
  });

  it("dispose() unsubscribes from the ingest server", () => {
    const { controller, server, webview } = makeHarness();
    controller.dispose();
    server.emit('{"msg":"after dispose"}');
    assert.equal(
      webview.filter((m) => (m as { type: string }).type === "debugLogLine").length,
      0,
    );
  });
});
