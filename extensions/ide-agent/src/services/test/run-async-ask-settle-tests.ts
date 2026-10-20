/**
 * DEV-GAPS-19 — async ask-question step settling tests (node:test, zero extra deps).
 *
 * Locks in Cursor parity for feature-matrix `subagent-async-ask-settle`
 * (evidence: docs/rea/deepdig-runtime-subagent-2026-10-19.md §3 —
 * `settleAsyncAskQuestionSteps`: "async ask-question steps settled via
 * **backwards scan with a `stepReads` budget**", OBSERVED via AST
 * identifier-slice extraction; the identifier `stepReads` is verbatim).
 *
 * Covered:
 * - pending ask-question steps settle into the RIGHT step after the
 *   backwards scan (newest unsettled match wins; the answer is recorded
 *   on the step, not just routed to the turn);
 * - the `stepReads` budget caps how many steps the backwards scan reads
 *   (many mocked steps → never scans past the budget; out-of-budget
 *   steps stay pending);
 * - settling never loses pending questions (unanswered steps survive;
 *   answers for unknown questionIds settle nothing);
 * - duplicate asks of the same questionId settle newest-first, one per call.
 *
 * Run after `tsc`:  node --test out/services/test/run-async-ask-settle-tests.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import {
  AsyncAskQuestionStepLog,
  DEFAULT_STEP_READS_BUDGET,
} from "../asyncAskSettle";

function makeLog() {
  let clock = 1_700_000_000_000;
  return new AsyncAskQuestionStepLog(() => clock++);
}

describe("settleAsyncAskQuestionSteps (Cursor backwards scan + stepReads budget)", () => {
  it("settles the right (newest) pending ask-question step via backwards scan", () => {
    const log = makeLog();
    // A turn's steps: an older question, tool-call churn, then a newer question.
    const oldQ = log.recordStep({ kind: "ask-question", questionId: "q-1", toolCallId: "tc-1", bubbleId: "b-1" });
    log.recordStep({ kind: "other", toolCallId: "tc-2", bubbleId: "b-1" });
    log.recordStep({ kind: "other", toolCallId: "tc-3", bubbleId: "b-1" });
    const newQ = log.recordStep({ kind: "ask-question", questionId: "q-2", toolCallId: "tc-4", bubbleId: "b-1" });

    const res = log.settleAsyncAskQuestionSteps(new Map([["q-2", "answer two"]]));

    assert.strictEqual(res.settledCount, 1);
    assert.deepStrictEqual(res.settledQuestionIds, ["q-2"]);
    // The answer is recorded INTO the right step (not just routed).
    assert.strictEqual(newQ.settled, true);
    assert.strictEqual(newQ.answerText, "answer two");
    assert.ok(newQ.answeredAtMs !== undefined);
    // The other question is untouched and still pending.
    assert.strictEqual(oldQ.settled, false);
    assert.strictEqual(oldQ.answerText, undefined);
    assert.deepStrictEqual(log.pendingSteps().map((s) => s.questionId), ["q-1"]);
  });

  it("honors the stepReads budget: never scans past it, out-of-budget steps stay pending", () => {
    const log = makeLog();
    // 200 steps: the question sits at the very bottom, buried under churn.
    const buried = log.recordStep({ kind: "ask-question", questionId: "q-buried", toolCallId: "tc-0" });
    for (let i = 0; i < 199; i++) {
      log.recordStep({ kind: "other", toolCallId: `tc-churn-${i}` });
    }

    const res = log.settleAsyncAskQuestionSteps(new Map([["q-buried", "too deep"]]), { stepReads: 10 });

    assert.ok(res.stepsRead <= 10, `stepsRead=${res.stepsRead} exceeded the stepReads=10 budget`);
    assert.strictEqual(res.settledCount, 0);
    // The buried question is NOT lost — it is still pending.
    assert.strictEqual(buried.settled, false);
    assert.deepStrictEqual(log.pendingSteps().map((s) => s.questionId), ["q-buried"]);
  });

  it("a larger budget reaches deeper steps and reports exact steps read", () => {
    const log = makeLog();
    const target = log.recordStep({ kind: "ask-question", questionId: "q-deep", toolCallId: "tc-0" });
    for (let i = 0; i < 24; i++) {
      log.recordStep({ kind: "other", toolCallId: `tc-${i}` });
    }

    const res = log.settleAsyncAskQuestionSteps(new Map([["q-deep", "found it"]]), { stepReads: 25 });

    assert.strictEqual(res.settledCount, 1);
    assert.strictEqual(target.settled, true);
    assert.strictEqual(target.answerText, "found it");
    // 24 churn steps + the target step = 25 reads, all within budget.
    assert.strictEqual(res.stepsRead, 25);
    assert.deepStrictEqual(log.pendingSteps(), []);
  });

  it("never loses pending questions: settles only matching steps", () => {
    const log = makeLog();
    const q1 = log.recordStep({ kind: "ask-question", questionId: "q-1", toolCallId: "tc-1" });
    const q2 = log.recordStep({ kind: "ask-question", questionId: "q-2", toolCallId: "tc-2" });

    // Answer for a question that was never asked: a no-op, nothing is lost.
    const noop = log.settleAsyncAskQuestionSteps(new Map([["q-unknown", "x"]]));
    assert.strictEqual(noop.settledCount, 0);
    assert.strictEqual(noop.stepsRead, log.allSteps().length); // full backwards pass, budget not hit
    assert.deepStrictEqual(log.pendingSteps().map((s) => s.questionId), ["q-1", "q-2"]);

    // Settle one; the other stays pending.
    const res = log.settleAsyncAskQuestionSteps(new Map([["q-1", "one"]]));
    assert.strictEqual(res.settledCount, 1);
    assert.strictEqual(q1.settled, true);
    assert.strictEqual(q1.answerText, "one");
    assert.strictEqual(q2.settled, false);
    assert.deepStrictEqual(log.pendingSteps().map((s) => s.questionId), ["q-2"]);
  });

  it("duplicate asks of one questionId settle newest-first, one per call", () => {
    const log = makeLog();
    const first = log.recordStep({ kind: "ask-question", questionId: "q-dup", toolCallId: "tc-old" });
    const second = log.recordStep({ kind: "ask-question", questionId: "q-dup", toolCallId: "tc-new" });

    const r1 = log.settleAsyncAskQuestionSteps(new Map([["q-dup", "latest answer"]]));
    assert.strictEqual(r1.settledCount, 1);
    assert.strictEqual(second.settled, true); // newest unsettled step wins
    assert.strictEqual(first.settled, false); // older duplicate still pending

    const r2 = log.settleAsyncAskQuestionSteps(new Map([["q-dup", "earlier answer"]]));
    assert.strictEqual(r2.settledCount, 1);
    assert.strictEqual(first.settled, true);
    assert.strictEqual(first.answerText, "earlier answer");
    assert.deepStrictEqual(log.pendingSteps(), []);
  });

  it("is a no-op for empty answers, empty log, or non-positive budget", () => {
    const log = makeLog();
    log.recordStep({ kind: "ask-question", questionId: "q-1", toolCallId: "tc-1" });

    const empty = log.settleAsyncAskQuestionSteps(new Map());
    assert.strictEqual(empty.stepsRead, 0);
    assert.strictEqual(empty.settledCount, 0);

    const zeroBudget = log.settleAsyncAskQuestionSteps(new Map([["q-1", "x"]]), { stepReads: 0 });
    assert.strictEqual(zeroBudget.stepsRead, 0);
    assert.strictEqual(zeroBudget.settledCount, 0);

    const fresh = makeLog();
    const noSteps = fresh.settleAsyncAskQuestionSteps(new Map([["q-1", "x"]]));
    assert.strictEqual(noSteps.stepsRead, 0);
    assert.strictEqual(noSteps.settledCount, 0);

    assert.deepStrictEqual(log.pendingSteps().map((s) => s.questionId), ["q-1"]);
  });

  it("default budget is a documented conservative constant", () => {
    // HONEST DIVERGENCE: the binary slice shows the stepReads mechanism,
    // not its value — this only pins our own documented default in place.
    assert.strictEqual(DEFAULT_STEP_READS_BUDGET, 50);
  });

  it("clear() drops the whole log (dispose/newChat lifecycle)", () => {
    const log = makeLog();
    log.recordStep({ kind: "ask-question", questionId: "q-1", toolCallId: "tc-1" });
    log.clear();
    assert.strictEqual(log.allSteps().length, 0);
    assert.deepStrictEqual(log.pendingSteps(), []);
  });
});
