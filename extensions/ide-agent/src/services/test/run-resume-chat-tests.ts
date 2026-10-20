/**
 * DEV-GAPS-56 (agent-resume-chat) tests (node:test, vscode stubbed).
 *
 * Cursor parity (binary evidence: `composer.resumeCurrentChat` —
 * "Resume Current Chat", workbench.glass.main.js 3.25.9, class CAb):
 * the palette command forwards {isAutoResume} to
 * chatService.resumeChat(handle, opts), which throws
 * "Cannot resume: chat not found" when the composer holds no data and
 * otherwise re-enters generation with an EMPTY prompt
 * (submitChatMaybeAbortCurrent(composerId, "", {isResume:true,
 * ignoreQueuing:true})). The fork's engine loop has no empty-prompt
 * continuation path, so ComposerDataService.resumeChat() re-submits the
 * interrupted (aborted) turn's prompt — see the method's doc comment.
 *
 * - no conversation data   → throws "Cannot resume: chat not found"
 * - cleanly settled chat   → returns false (nothing to continue)
 * - turn in flight         → returns false
 * - aborted turn           → resumable; resumeChat() restarts the turn
 *   with the same prompt and consumes the resumable state
 *
 * The engine is swapped for StubEngineAdapter so no sidecar process spawns.
 * Run after `tsc`:  node --test out/services/test/run-resume-chat-tests.js
 */
import { after, describe, it } from "node:test";
import * as assert from "node:assert";
import "./vscode-stub";
import { ComposerDataService } from "../composerDataService";
import { StubEngineAdapter } from "../agentService";

/**
 * W52C test-hygiene pattern: every ComposerDataService created below is
 * tracked so the file-level after() disposes it (an undisposed composer
 * leaks its checkpoint scheduler + sidecar and hangs node:test at exit).
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

describe("ComposerDataService.resumeChat — DEV-GAPS-56 agent-resume-chat", () => {
  it("throws the verbatim binary error when the composer has no data", () => {
    const composer = makeComposer();
    assert.throws(
      () => composer.resumeChat(),
      (err: unknown) => err instanceof Error && err.message === "Cannot resume: chat not found",
    );
    composer.dispose();
  });

  it("returns false for a cleanly settled chat (nothing to continue)", async () => {
    const composer = makeComposer();
    composer.submit("a short turn");
    await waitFor(() => !composer.isRunning, 15000);
    assert.strictEqual(composer.hasResumableTurn, false);
    assert.strictEqual(composer.resumeChat(), false);
    assert.strictEqual(composer.resumeChat({ isAutoResume: true }), false);
    composer.dispose();
  });

  it("returns false while a turn is in flight", async () => {
    const composer = makeComposer();
    composer.submit("a long turn");
    assert.ok(composer.isRunning, "turn should be running right after submit");
    assert.strictEqual(composer.resumeChat(), false);
    composer.abort();
    await waitFor(() => !composer.isRunning, 8000);
    composer.dispose();
  });

  it("resumes an aborted turn by re-submitting its prompt, exactly once", async () => {
    const composer = makeComposer();
    composer.submit("resume me please");
    assert.ok(composer.isRunning, "turn should be running right after submit");
    composer.abort();
    await waitFor(() => !composer.isRunning, 8000);

    assert.strictEqual(composer.hasResumableTurn, true, "aborted turn must be resumable");
    assert.strictEqual(composer.resumeChat(), true, "resumeChat must report the resume");
    assert.strictEqual(composer.hasResumableTurn, false, "resume consumes the resumable state");

    // The resumed turn runs (same prompt) and settles cleanly.
    await waitFor(() => composer.isRunning, 5000);
    await waitFor(() => !composer.isRunning, 15000);
    assert.strictEqual(composer.hasResumableTurn, false, "a clean settle is not resumable");
    assert.strictEqual(composer.resumeChat(), false);
    composer.dispose();
  });

  it("a fresh submit supersedes the resumable state", async () => {
    const composer = makeComposer();
    composer.submit("first turn gets aborted");
    composer.abort();
    await waitFor(() => !composer.isRunning, 8000);
    assert.strictEqual(composer.hasResumableTurn, true);

    composer.submit("different second turn");
    await waitFor(() => !composer.isRunning, 15000);
    // The second turn settled cleanly — the first turn's prompt must not
    // come back as resumable.
    assert.strictEqual(composer.hasResumableTurn, false);
    assert.strictEqual(composer.resumeChat(), false);
    composer.dispose();
  });
});
