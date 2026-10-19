/**
 * abortTurn tests (node:test, zero extra deps).
 *
 * P1 (QA-FILE-01): the webview's Stop button must terminate a running turn
 * PROMPTLY — the generator must complete (not hang), and no events should be
 * required from the engine after the abort.
 *
 * Run after `tsc`:  node out/services/test/run-abort-tests.mjs
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import { StubEngineAdapter } from "../agentService";

const Ctx = { prompt: "hello", mode: "agent" as const, bubbleId: "b-test" };

describe("StubEngineAdapter.abortTurn (P1 QA-FILE-01)", () => {
  it("terminates a streaming turn promptly after abort", async () => {
    const stub = new StubEngineAdapter(async () => ({ optionId: "approve" }));
    const gen = stub.runTurn(Ctx)[Symbol.asyncIterator]();
    const first = await gen.next();
    assert.ok(!first.done, "expected the turn to start");

    stub.abortTurn();

    const start = Date.now();
    let eventsAfterAbort = 0;
    for (;;) {
      const r = await Promise.race([
        gen.next(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("abort did not terminate the turn promptly (5s)")), 5000),
        ),
      ]);
      if (r.done) break;
      eventsAfterAbort++;
      if (Date.now() - start > 5000) {
        throw new Error("abort did not terminate the turn promptly (5s)");
      }
    }
    // The turn must end quickly once aborted: worst case is the remainder of
    // the stub's current sleep (900ms), well under the 5s guard.
    assert.ok(Date.now() - start < 5000, `turn ended ${Date.now() - start}ms after abort`);
    void eventsAfterAbort;
  });

  it("a full turn without abort still completes", async () => {
    const stub = new StubEngineAdapter(async () => ({ optionId: "approve" }));
    let seen = 0;
    let doneType = "";
    for await (const ev of stub.runTurn(Ctx)) {
      seen++;
      doneType = ev.type;
    }
    assert.ok(seen > 3, `expected several events, got ${seen}`);
    assert.strictEqual(doneType, "done", "turn ends with a done event");
  });
});
