/**
 * Background conversation summarization tests (node:test) — Cursor 3.25.9 parity.
 *
 * Pins the implementation in ../backgroundSummarizer.ts against the
 * parent-verified evidence (binary telemetry family
 * agent.background_summarization.{started,stashed,pending_adoption,persisted,discarded,time_saved_ms},
 * dig-ast-ext-2026-10-19; cursor.com/docs/agent/prompting):
 *
 *  - lifecycle: started → stashed → pending_adoption → persisted, with the
 *    VERBATIM event names and a REALLY measured time_saved_ms (fake clock);
 *  - start() is fire-and-forget: the turn is never parked;
 *  - supersede: a newer start() discards the older generation (in-flight,
 *    stashed, or pending_adoption); late resolutions of the old generation
 *    are ignored;
 *  - engine unreachable: the generation is dropped, NEVER fabricated;
 *  - the 70% proactive threshold (SUMMARIZATION_THRESHOLD_PERCENT = 70);
 *  - preCompact hooks are observational: a throwing hook never blocks adoption;
 *  - TranscriptTracker: user/assistant/tool recording, cap, token estimate.
 *
 * Timing uses injected fake clocks / deferred promises — deterministic, no
 * real waiting except short (<50ms) macrotask ticks for the fire-and-forget
 * async IIFE inside start().
 *
 * Run after `tsc`:  node out/services/test/run-bg-summarization-tests.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import {
  BACKGROUND_SUMMARIZATION_TELEMETRY,
  BackgroundSummarizer,
  MAX_TRANSCRIPT_CHARS,
  TIME_SAVED_MS_FIELD,
  TranscriptTracker,
  buildBackgroundSummaryPrompt,
  estimateTokensFromChars,
  meetsBackgroundSummaryThreshold,
  SummaryGenerationInput,
} from "../backgroundSummarizer";
import { SUMMARIZATION_THRESHOLD_PERCENT } from "../agentRuntime";

function tick(ms = 10): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeInput(over: Partial<SummaryGenerationInput> = {}): SummaryGenerationInput {
  return {
    transcript: "## User\nfix the bug\n## Assistant\non it\n",
    trigger: "threshold",
    turnIds: ["turn-1"],
    estimatedTokens: 140_000,
    truncated: false,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Verbatim telemetry names
// ---------------------------------------------------------------------------

describe("background summarization telemetry names", () => {
  it("uses Cursor's verbatim agent.background_summarization.* event names", () => {
    assert.strictEqual(
      BACKGROUND_SUMMARIZATION_TELEMETRY.started,
      "agent.background_summarization.started",
    );
    assert.strictEqual(
      BACKGROUND_SUMMARIZATION_TELEMETRY.stashed,
      "agent.background_summarization.stashed",
    );
    assert.strictEqual(
      BACKGROUND_SUMMARIZATION_TELEMETRY.pending_adoption,
      "agent.background_summarization.pending_adoption",
    );
    assert.strictEqual(
      BACKGROUND_SUMMARIZATION_TELEMETRY.persisted,
      "agent.background_summarization.persisted",
    );
    assert.strictEqual(
      BACKGROUND_SUMMARIZATION_TELEMETRY.discarded,
      "agent.background_summarization.discarded",
    );
    assert.strictEqual(TIME_SAVED_MS_FIELD, "time_saved_ms");
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe("BackgroundSummarizer lifecycle", () => {
  it("started → stashed → pending_adoption → persisted, with measured time_saved_ms", async () => {
    let t = 1000;
    const order: string[] = [];
    const hookCalls: unknown[] = [];
    const s = new BackgroundSummarizer({
      generate: async () => {
        t = 2500; // the fake clock advances only inside the real generation
        return "the summary";
      },
      preCompact: async (extras) => {
        hookCalls.push(extras);
        order.push("preCompact");
        return { ok: true };
      },
      now: () => t,
      log: (m) => order.push(m),
    });

    s.start(makeInput());
    // Fire-and-forget: start() returned synchronously; the turn is not parked.
    assert.strictEqual(s.currentStatus, "generating");

    await tick();
    assert.strictEqual(s.currentStatus, "stashed");
    const stashed = s.getStashedSummary();
    assert.ok(stashed);
    assert.strictEqual(stashed.text, "the summary");
    // time_saved_ms is MEASURED (2500 - 1000), not estimated.
    assert.strictEqual(stashed.timeSavedMs, 1500);

    await s.onTurnBoundary();
    assert.strictEqual(s.currentStatus, "persisted");
    assert.deepStrictEqual(s.getCompactedTurnIds(), ["turn-1"]);
    assert.strictEqual(hookCalls.length, 1);
    assert.strictEqual(s.getLastAdoptedSummary()?.text, "the summary");

    const events = s.getTelemetryLog().map((e) => e.event);
    assert.deepStrictEqual(events, [
      "agent.background_summarization.started",
      "agent.background_summarization.stashed",
      "agent.background_summarization.pending_adoption",
      "agent.background_summarization.persisted",
    ]);
    const stashedEntry = s
      .getTelemetryLog()
      .find((e) => e.event === "agent.background_summarization.stashed")!;
    assert.strictEqual(stashedEntry.data["time_saved_ms"], 1500);
    const persistedEntry = s
      .getTelemetryLog()
      .find((e) => e.event === "agent.background_summarization.persisted")!;
    assert.strictEqual(persistedEntry.data["time_saved_ms"], 1500);

    // preCompact ran BEFORE the persisted event (observational, pre-adoption).
    const preCompactIdx = order.indexOf("preCompact");
    const persistedIdx = order.findIndex((m) =>
      m.includes("agent.background_summarization.persisted"),
    );
    assert.ok(preCompactIdx >= 0 && persistedIdx >= 0 && preCompactIdx < persistedIdx);
  });

  it("onTurnBoundary is a no-op without a stashed summary", async () => {
    const s = new BackgroundSummarizer({ generate: async () => "x", log: () => {} });
    await s.onTurnBoundary();
    assert.strictEqual(s.currentStatus, "idle");
    assert.deepStrictEqual(s.getTelemetryLog(), []);
  });

  it("start() with an empty transcript is skipped, not fabricated", () => {
    const s = new BackgroundSummarizer({ generate: async () => "x", log: () => {} });
    s.start(makeInput({ transcript: "   " }));
    assert.strictEqual(s.currentStatus, "idle");
    assert.deepStrictEqual(s.getTelemetryLog(), []);
  });

  it("an empty generation result is treated as a failure, never stashed", async () => {
    const s = new BackgroundSummarizer({ generate: async () => "   ", log: () => {} });
    s.start(makeInput());
    await tick();
    assert.strictEqual(s.currentStatus, "idle");
    assert.strictEqual(s.getStashedSummary(), undefined);
    const events = s.getTelemetryLog().map((e) => e.event);
    assert.deepStrictEqual(events, ["agent.background_summarization.started"]);
  });
});

// ---------------------------------------------------------------------------
// Supersede → discarded
// ---------------------------------------------------------------------------

describe("BackgroundSummarizer supersede", () => {
  it("a newer start() discards the older in-flight generation; its late resolution is ignored", async () => {
    const gens = [deferred<string>(), deferred<string>()];
    let calls = 0;
    const s = new BackgroundSummarizer({
      generate: () => gens[calls++].promise,
      log: () => {},
    });
    s.start(makeInput({ turnIds: ["turn-1"] }));
    assert.strictEqual(s.currentStatus, "generating");

    s.start(makeInput({ turnIds: ["turn-2"] })); // supersedes generation 1
    const eventsAfterSupersede = s.getTelemetryLog().map((e) => e.event);
    assert.deepStrictEqual(eventsAfterSupersede, [
      "agent.background_summarization.started",
      "agent.background_summarization.discarded",
      "agent.background_summarization.started", // the new generation's own started
    ]);
    const discarded = s
      .getTelemetryLog()
      .find((e) => e.event === "agent.background_summarization.discarded")!;
    assert.deepStrictEqual(
      { generation: discarded.data["generation"], supersededBy: discarded.data["supersededBy"], reason: discarded.data["reason"] },
      { generation: 1, supersededBy: 2, reason: "superseded" },
    );

    // The old generation resolves late — it must NOT be stashed.
    gens[0].resolve("old summary");
    await tick();
    assert.strictEqual(s.currentStatus, "generating");
    assert.strictEqual(s.getStashedSummary(), undefined);

    // The new generation resolves — it is stashed normally.
    gens[1].resolve("new summary");
    await tick();
    assert.strictEqual(s.currentStatus, "stashed");
    assert.strictEqual(s.getStashedSummary()?.text, "new summary");
    assert.deepStrictEqual(s.getStashedSummary()?.turnIds, ["turn-2"]);

    // Adoption covers only the newest generation's turns.
    await s.onTurnBoundary();
    assert.strictEqual(s.currentStatus, "persisted");
    assert.deepStrictEqual(s.getCompactedTurnIds(), ["turn-2"]);
  });

  it("a newer start() discards a stashed-but-unadopted summary", async () => {
    const s = new BackgroundSummarizer({
      generate: async () => "summary",
      log: () => {},
    });
    s.start(makeInput({ turnIds: ["turn-1"] }));
    await tick();
    assert.strictEqual(s.currentStatus, "stashed");

    s.start(makeInput({ turnIds: ["turn-2"] })); // turn boundary never adopted gen 1
    assert.strictEqual(s.currentStatus, "generating");
    assert.strictEqual(s.getStashedSummary(), undefined);
    const events = s.getTelemetryLog().map((e) => e.event);
    assert.ok(events.includes("agent.background_summarization.discarded"));
  });

  it("a completed (persisted) cycle is NOT discarded by the next start()", async () => {
    const s = new BackgroundSummarizer({
      generate: async () => "summary",
      log: () => {},
    });
    s.start(makeInput({ turnIds: ["turn-1"] }));
    await tick();
    await s.onTurnBoundary();
    assert.strictEqual(s.currentStatus, "persisted");

    s.start(makeInput({ turnIds: ["turn-2"] }));
    const discardedCount = s
      .getTelemetryLog()
      .filter((e) => e.event === "agent.background_summarization.discarded").length;
    assert.strictEqual(discardedCount, 0);
    assert.strictEqual(s.currentStatus, "generating");
  });
});

// ---------------------------------------------------------------------------
// Engine unreachable → no fake summary
// ---------------------------------------------------------------------------

describe("BackgroundSummarizer engine failure", () => {
  it("a rejected generation is dropped; nothing is fabricated, the turn is never parked", async () => {
    const logs: string[] = [];
    const s = new BackgroundSummarizer({
      generate: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:9999");
      },
      log: (m) => logs.push(m),
    });
    // start() must not throw — the turn continues unparked.
    s.start(makeInput());
    assert.strictEqual(s.currentStatus, "generating");
    await tick();
    assert.strictEqual(s.currentStatus, "idle");
    assert.strictEqual(s.getStashedSummary(), undefined);
    assert.strictEqual(s.getLastAdoptedSummary(), undefined);
    const events = s.getTelemetryLog().map((e) => e.event);
    // started was emitted; nothing was stashed — no fake summary exists.
    assert.deepStrictEqual(events, ["agent.background_summarization.started"]);
    assert.ok(logs.some((m) => m.includes("no summary fabricated")));
  });
});

// ---------------------------------------------------------------------------
// preCompact is observational
// ---------------------------------------------------------------------------

describe("BackgroundSummarizer preCompact", () => {
  it("a throwing preCompact hook never blocks adoption", async () => {
    const s = new BackgroundSummarizer({
      generate: async () => "summary",
      preCompact: async () => {
        throw new Error("hook exploded");
      },
      log: () => {},
    });
    s.start(makeInput());
    await tick();
    await s.onTurnBoundary(); // must not throw
    assert.strictEqual(s.currentStatus, "persisted");
    const events = s.getTelemetryLog().map((e) => e.event);
    assert.deepStrictEqual(events, [
      "agent.background_summarization.started",
      "agent.background_summarization.stashed",
      "agent.background_summarization.pending_adoption",
      "agent.background_summarization.persisted",
    ]);
  });

  it("preCompact extras carry the summary facts", async () => {
    let extras: Record<string, unknown> | undefined;
    const s = new BackgroundSummarizer({
      generate: async () => "summary text",
      preCompact: async (e) => {
        extras = e;
        return undefined;
      },
      log: () => {},
    });
    s.start(makeInput({ turnIds: ["t1", "t2"] }));
    await tick();
    await s.onTurnBoundary();
    assert.ok(extras);
    assert.strictEqual(extras!["summaryChars"], "summary text".length);
    assert.strictEqual(extras!["trigger"], "threshold");
    assert.strictEqual(extras!["turnsCovered"], 2);
    assert.ok(typeof extras!["time_saved_ms"] === "number");
  });
});

// ---------------------------------------------------------------------------
// 70% threshold helper
// ---------------------------------------------------------------------------

describe("background summary threshold", () => {
  it("SUMMARIZATION_THRESHOLD_PERCENT is pinned at the observed 70", () => {
    assert.strictEqual(SUMMARIZATION_THRESHOLD_PERCENT, 70);
  });

  it("fires at ≥70% of the context window, not below", () => {
    assert.strictEqual(meetsBackgroundSummaryThreshold(140_000, 200_000), true);
    assert.strictEqual(meetsBackgroundSummaryThreshold(200_000, 200_000), true);
    assert.strictEqual(meetsBackgroundSummaryThreshold(139_999, 200_000), false);
    assert.strictEqual(meetsBackgroundSummaryThreshold(0, 200_000), false);
    assert.strictEqual(meetsBackgroundSummaryThreshold(1, 0), false);
    assert.strictEqual(meetsBackgroundSummaryThreshold(1, -5), false);
  });

  it("estimateTokensFromChars uses the chars/4 heuristic", () => {
    assert.strictEqual(estimateTokensFromChars(0), 0);
    assert.strictEqual(estimateTokensFromChars(4), 1);
    assert.strictEqual(estimateTokensFromChars(5), 2);
    assert.strictEqual(estimateTokensFromChars(400), 100);
    assert.strictEqual(estimateTokensFromChars(-10), 0);
  });
});

// ---------------------------------------------------------------------------
// TranscriptTracker
// ---------------------------------------------------------------------------

describe("TranscriptTracker", () => {
  it("records user prompts, assistant deltas, tool calls and results", () => {
    const tr = new TranscriptTracker();
    tr.recordUserPrompt("fix the bug");
    tr.recordTextDelta("on it, ");
    tr.recordTextDelta("reading the file");
    tr.recordToolCall("read", JSON.stringify({ path: "a.ts" }));
    tr.recordToolResult("tc-1", "file contents here");
    tr.recordTurnBoundary("turn-1");

    const input = tr.buildSummaryInput("threshold");
    assert.ok(input.transcript.includes("fix the bug"));
    assert.ok(input.transcript.includes("on it, reading the file"));
    assert.ok(input.transcript.includes("## Tool: read"));
    assert.ok(input.transcript.includes("a.ts"));
    assert.ok(input.transcript.includes("file contents here"));
    assert.deepStrictEqual(input.turnIds, ["turn-1"]);
    assert.strictEqual(input.trigger, "threshold");
    assert.strictEqual(input.estimatedTokens, estimateTokensFromChars(input.transcript.length));
    assert.strictEqual(input.truncated, false);
    assert.ok(tr.estimatedTokens() > 0);

    assert.deepStrictEqual(tr.getUncompactedTurnIds(), ["turn-1"]);
    tr.markCompacted(["turn-1"]);
    assert.deepStrictEqual(tr.getUncompactedTurnIds(), []);
  });

  it("caps the transcript at MAX_TRANSCRIPT_CHARS, dropping the oldest first", () => {
    const tr = new TranscriptTracker();
    tr.recordUserPrompt("first — this is the oldest segment");
    tr.recordTextDelta("x".repeat(MAX_TRANSCRIPT_CHARS));
    tr.recordTurnBoundary("t2");

    const input = tr.buildSummaryInput("threshold");
    assert.ok(input.transcript.length <= MAX_TRANSCRIPT_CHARS + 64);
    assert.strictEqual(input.truncated, true);
    // Oldest segment was dropped to make room.
    assert.ok(!input.transcript.includes("first — this is the oldest segment"));
  });

  it("reasoning deltas are truncated (verbose, low signal)", () => {
    const tr = new TranscriptTracker();
    tr.recordReasoningDelta("r".repeat(10_000));
    tr.recordTurnBoundary("t1");
    const input = tr.buildSummaryInput("threshold");
    assert.ok(input.transcript.length < 10_000);
  });

  it("clear() resets everything", () => {
    const tr = new TranscriptTracker();
    tr.recordUserPrompt("hello");
    tr.recordTurnBoundary("t1");
    tr.clear();
    assert.strictEqual(tr.getTranscriptChars(), 0);
    assert.deepStrictEqual(tr.getUncompactedTurnIds(), []);
    const input = tr.buildSummaryInput("threshold");
    assert.strictEqual(input.transcript, "");
  });
});

// ---------------------------------------------------------------------------
// Summary prompt
// ---------------------------------------------------------------------------

describe("buildBackgroundSummaryPrompt", () => {
  it("embeds the transcript and asks for a handoff summary, not a new turn", () => {
    const prompt = buildBackgroundSummaryPrompt(makeInput({ transcript: "TRANSCRIPT-BODY" }));
    assert.ok(prompt.includes("TRANSCRIPT-BODY"));
    assert.ok(prompt.includes("handoff summary"));
    assert.ok(prompt.includes("not a new turn"));
    assert.ok(!prompt.includes("```"));
  });

  it("notes truncation when the transcript was cut", () => {
    const prompt = buildBackgroundSummaryPrompt(makeInput({ truncated: true }));
    assert.ok(prompt.toLowerCase().includes("truncated"));
    const plain = buildBackgroundSummaryPrompt(makeInput({ truncated: false }));
    assert.ok(!plain.toLowerCase().includes("truncated"));
  });
});
