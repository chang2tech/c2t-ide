/**
 * GAPS-11B (agent-abort-restore-query) tests (node:test, vscode stubbed).
 *
 * Cursor parity (binary evidence: `glass.abortAgentAndRestoreQuery` —
 * "Abort Agent and Restore Query", workbench.glass.main.js 3.25.6; REA doc
 * docs/rea/dig-continuous-composer-queue-2026-10-19.md §2): aborting a turn
 * restores the original query. In our single-composer model the faithful
 * equivalent is a `restorePrompt` composer event carrying the turn's prompt,
 * which the host forwards to the webview as `{type:'restoreInput'}` to
 * refill the input box.
 *
 * - The explicit user Stop path (abort({ restoreQuery: true })) fires
 *   `restorePrompt` with the turn's exact prompt text.
 * - The internal interrupt/steer path (plain abort(), used by
 *   stageInterruptSend) does NOT restore — a new turn follows immediately.
 * - abort() while idle fires nothing.
 * - A settled turn clears the stored prompt: a later abort restores nothing.
 *
 * The engine is swapped for StubEngineAdapter so no sidecar process spawns.
 * runTurn stores the prompt synchronously at turn start (before its first
 * await), so submit() → abort() needs no artificial delay.
 *
 * Run after `tsc`:  node out/services/test/run-abort-restore-query-tests.js
 */
import { after, describe, it } from "node:test";
import * as assert from "node:assert";
import "./vscode-stub";
import { ComposerDataService, ComposerEvent } from "../composerDataService";
import { StubEngineAdapter } from "../agentService";

/**
 * DEV-GAPS-56 (W56A, follow-up W52C): every ComposerDataService created
 * below is tracked so the file-level after() can dispose it. This file
 * previously disposed only at the end of each test body — an assertion
 * throw before that line leaked the composer (checkpoint scheduler +
 * `bun serve` sidecar stdio keep the event loop alive, so node:test
 * hangs at file level after all suites pass — the exact failure mode
 * documented in run-newchat-tests.ts / run-roundb-lockin-tests.ts).
 * dispose() is idempotent, so the per-test dispose() calls below stay as
 * the fast path and this after() is the safety net.
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

function makeComposer(): ComposerDataService {
  const composer = track(new ComposerDataService(undefined, undefined));
  // Swap the sidecar adapter for the scripted stub — no engine process.
  (composer as unknown as { engine: unknown }).engine = new StubEngineAdapter(
    async () => ({ optionId: "approve" }),
  );
  return composer;
}

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (cond()) {
      return;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("abort({ restoreQuery: true }) — GAPS-11B agent-abort-restore-query", () => {
  it("user Stop restores the turn's prompt via restorePrompt", async () => {
    const composer = makeComposer();
    const seen: ComposerEvent[] = [];
    composer.onDidChange((e) => seen.push(e));

    composer.submit("restore me please");
    assert.ok(composer.isRunning, "turn should be running right after submit");

    composer.abort({ restoreQuery: true });

    const restore = seen.find((e) => e.kind === "restorePrompt");
    assert.ok(restore, "expected a restorePrompt event on user Stop");
    assert.strictEqual(
      (restore as { kind: "restorePrompt"; text: string }).text,
      "restore me please",
      "the restored text must be the turn's exact prompt",
    );
    // The turn winds down promptly after the abort (stub is interruptible).
    await waitFor(() => !composer.isRunning, 8000);
    composer.dispose();
  });

  it("plain abort() (interrupt/steer path) does NOT fire restorePrompt", async () => {
    const composer = makeComposer();
    const seen: ComposerEvent[] = [];
    composer.onDidChange((e) => seen.push(e));

    composer.submit("do not restore me");
    assert.ok(composer.isRunning, "turn should be running right after submit");

    // stageInterruptSend calls abort() without opts — restore must not fire.
    composer.abort();

    assert.ok(
      !seen.some((e) => e.kind === "restorePrompt"),
      "plain abort() must not restore the prompt",
    );
    await waitFor(() => !composer.isRunning, 8000);
    composer.dispose();
  });

  it("abort() while idle fires nothing", () => {
    const composer = makeComposer();
    const seen: ComposerEvent[] = [];
    composer.onDidChange((e) => seen.push(e));

    assert.ok(!composer.isRunning, "precondition: idle");
    composer.abort({ restoreQuery: true });

    assert.deepStrictEqual(
      seen.filter((e) => e.kind === "restorePrompt"),
      [],
      "no restorePrompt when no turn is running",
    );
    composer.dispose();
  });

  it("a settled turn clears the stored prompt — later abort restores nothing", async () => {
    const composer = makeComposer();
    const seen: ComposerEvent[] = [];
    composer.onDidChange((e) => seen.push(e));

    composer.submit("a short turn");
    // Let the stub turn run to natural completion (~2.5s scripted).
    await waitFor(() => !composer.isRunning, 15000);
    seen.length = 0;

    composer.abort({ restoreQuery: true });

    assert.ok(
      !seen.some((e) => e.kind === "restorePrompt"),
      "settled turn must not leave a restorable prompt",
    );
    composer.dispose();
  });
});
