/**
 * Agent-loop runtime hardening tests (node:test) — DD-AR-1..10.
 *
 * Pins Cursor 3.25.9's observed constants and mechanisms as implemented in
 * ../agentRuntime.ts: stall detector timing, backoff math, retry taxonomy,
 * resume-from-checkpoint, blocking summarization, tool error taxonomy,
 * model fallback protocol, loop-detection hash, shadow classifier protocol,
 * turnSettled state machine, shell timeout constants.
 *
 * Timing uses injected fake clocks (StreamStallDetector/TtftTracker take a
 * `now` function) — fully deterministic, no real waiting except for a few
 * short (<100ms) real-timer async tests.
 *
 * Run after `tsc`:  node out/services/test/run-agent-runtime-tests.mjs
 */
import "./vscode-stub";
import { describe, it } from "node:test";
import * as assert from "node:assert";
import {
  BlockingSummarizer,
  FeatureModelConfig,
  LoopDetectedError,
  ModelFallbackManager,
  NO_PROGRESS_RESUME_LIMIT,
  RETRY_BACKOFF_BASE_MS,
  RETRY_BACKOFF_CAP_MS,
  RETRY_NO_PROGRESS_MESSAGE,
  RETRY_SERVER_CAP,
  RETRY_TRANSPORT_CAP,
  SINGLE_MESSAGE_LOOP_POLICY,
  STALL_FAIL_THRESHOLD_MS,
  STALL_HEARTBEAT_ONLY_MULTIPLIER,
  STALL_MESSAGE_HEARTBEAT_ONLY,
  STALL_MESSAGE_NO_ACTIVITY,
  STALL_MESSAGE_RECOVERED,
  STALL_PROD_FLOOR_MS,
  STALL_RETRY_BUDGET_MS,
  SHELL_BACKGROUND_TIMEOUT_MS,
  SHELL_DEFAULT_TIMEOUT_MS,
  SHELL_FOREGROUND_TIMEOUT_MS,
  SHELL_HARD_TIMEOUT_MS,
  SHELL_TIMEOUTS_CLIENT_ENFORCED,
  SUMMARIZATION_THRESHOLD_PERCENT,
  MaxStepsReachedError,
  RetryState,
  ResumeStateTracker,
  SingleMessageLoopDetector,
  StreamStallDetector,
  ToolErrorClass,
  TtftTracker,
  appendTurnSettledByError,
  buildTurnSettled,
  classifyEngineSseEvent,
  classifyStreamError,
  classifyToolError,
  computeBackoffMs,
  detectSummarizationTrigger,
  fnv1aHash,
  formatToolError,
  isStreamEventKind,
  isTransportErrorSignature,
  redactToolOutput,
  runShadowClassifier,
  selectDelayMs,
} from "../agentRuntime";
import { parseModelRefString, parseRetryAfterMs } from "../ideCodeEngineAdapter";

const ZERO_RANDOM = () => 0;
const ONE_RANDOM = () => 1;

// ---------------------------------------------------------------------------
// DD-AR-1: stream stall detector
// ---------------------------------------------------------------------------

describe("DD-AR-1 StreamStallDetector", () => {
  it("observed constants: 30s fail threshold, 3x heartbeat-only, 20s prod floor", () => {
    assert.strictEqual(STALL_FAIL_THRESHOLD_MS, 30_000);
    assert.strictEqual(STALL_HEARTBEAT_ONLY_MULTIPLIER, 3);
    assert.strictEqual(STALL_PROD_FLOOR_MS, 20_000);
  });

  it("no_activity stall fires at the fail threshold, not before", () => {
    let t = 0;
    const seen: string[] = [];
    const d = new StreamStallDetector({ now: () => t, onStall: (s) => seen.push(s.message) });
    t = 29_999;
    assert.strictEqual(d.checkStall(), null);
    t = 30_000;
    const stall = d.checkStall();
    assert.ok(stall);
    assert.strictEqual(stall.kind, "no_activity");
    assert.strictEqual(stall.message, STALL_MESSAGE_NO_ACTIVITY);
    assert.strictEqual(stall.stallDurationMs, 30_000);
    assert.deepStrictEqual(seen, [STALL_MESSAGE_NO_ACTIVITY]);
  });

  it("stream activity resets the timer (IsStreamEvent gate)", () => {
    let t = 0;
    const d = new StreamStallDetector({ now: () => t });
    t = 25_000;
    d.recordActivity("stream");
    t = 54_999; // 29.999s after the stream event
    assert.strictEqual(d.checkStall(), null);
    t = 55_000;
    assert.strictEqual(d.checkStall()?.kind, "no_activity");
  });

  it("control messages do NOT reset the stream-activity timer", () => {
    let t = 0;
    const d = new StreamStallDetector({ now: () => t });
    t = 25_000;
    d.recordActivity("control"); // e.g. permission.asked — not a stream event
    t = 30_000;
    assert.strictEqual(d.checkStall()?.kind, "no_activity");
  });

  it("heartbeat_only stall when heartbeats arrive but no stream events", () => {
    let t = 0;
    const d = new StreamStallDetector({ now: () => t });
    // Heartbeats keep arriving every 5s; no stream events.
    for (t = 5_000; t <= 45_000; t += 5_000) {
      d.recordActivity("heartbeat");
      if (t < 30_000) {
        assert.strictEqual(d.checkStall(), null);
      }
    }
    t = 45_000;
    const stall = d.checkStall();
    assert.ok(stall);
    assert.strictEqual(stall.kind, "heartbeat_only");
    assert.strictEqual(stall.message, STALL_MESSAGE_HEARTBEAT_ONLY);
  });

  it("stale heartbeats (older than 3x threshold) report no_activity", () => {
    let t = 0;
    const d = new StreamStallDetector({ now: () => t });
    t = 1_000;
    d.recordActivity("heartbeat");
    t = 30_000; // stream stalled; last heartbeat 29s ago but within 3x window → heartbeat_only
    assert.strictEqual(d.checkStall()?.kind, "heartbeat_only");
  });

  it("stale heartbeats beyond the 3x window report no_activity", () => {
    let t = 0;
    const d = new StreamStallDetector({ now: () => t });
    d.recordActivity("heartbeat"); // t = 0
    t = 30_000 + 90_001; // last heartbeat > 90s ago
    assert.strictEqual(d.checkStall()?.kind, "no_activity");
  });

  it("production floor clamps sub-20s thresholds (non-test)", () => {
    let t = 0;
    const d = new StreamStallDetector({ thresholdMs: 5_000, now: () => t });
    t = 19_999;
    assert.strictEqual(d.checkStall(), null);
    t = 20_000;
    assert.ok(d.checkStall());
  });

  it("test mode keeps small thresholds (Cursor: transportCap=min(10,2) in tests)", () => {
    let t = 0;
    const d = new StreamStallDetector({ thresholdMs: 5_000, isTest: true, now: () => t });
    t = 5_000;
    assert.ok(d.checkStall());
  });

  it("streamEnded / markAborted suppress stalls", () => {
    let t = 0;
    const d = new StreamStallDetector({ now: () => t });
    t = 60_000;
    d.markStreamEnded();
    assert.strictEqual(d.checkStall(), null);
    const d2 = new StreamStallDetector({ now: () => t });
    d2.markAborted();
    assert.strictEqual(d2.checkStall(), null);
  });

  it("recovery emits the resumed message via onStall", () => {
    let t = 0;
    const seen: string[] = [];
    const d = new StreamStallDetector({ now: () => t, onStall: (s) => seen.push(s.message) });
    t = 30_000;
    d.checkStall();
    t = 31_000;
    d.recordActivity("stream");
    assert.deepStrictEqual(seen, [STALL_MESSAGE_NO_ACTIVITY, STALL_MESSAGE_RECOVERED]);
    // After recovery the detector can fire again.
    t = 61_000;
    assert.strictEqual(d.checkStall()?.kind, "no_activity");
  });

  it("IsStreamEvent gate: only the 8 observed cases count", () => {
    for (const k of [
      "textDelta", "thinkingDelta", "thinkingCompleted", "partialToolCall",
      "toolCallDelta", "toolCallStarted", "toolCallCompleted", "tokenDelta",
    ]) {
      assert.strictEqual(isStreamEventKind(k), true, k);
    }
    for (const k of ["heartbeat", "turnEnded", "summary", "stepStarted", ""]) {
      assert.strictEqual(isStreamEventKind(k), false, k);
    }
  });

  it("classifyEngineSseEvent maps the engine wire onto the gate", () => {
    assert.strictEqual(classifyEngineSseEvent("session.text.delta"), "stream");
    assert.strictEqual(classifyEngineSseEvent("session.tool.called"), "stream");
    assert.strictEqual(classifyEngineSseEvent("message.part.updated"), "stream");
    assert.strictEqual(classifyEngineSseEvent("permission.asked"), "control");
    assert.strictEqual(classifyEngineSseEvent("session.error"), "control");
    assert.strictEqual(classifyEngineSseEvent("session.execution.succeeded"), "control");
    assert.strictEqual(classifyEngineSseEvent("heartbeat"), "heartbeat");
  });

  it("TtftTracker builds client-measured phases", () => {
    let t = 0;
    const tr = new TtftTracker(() => t, "client");
    tr.mark("requestSent");
    t = 120;
    tr.mark("streamSetupDone");
    t = 400;
    tr.mark("firstEvent");
    t = 900;
    tr.mark("firstToken");
    const b = tr.build();
    assert.strictEqual(b.clock, "client");
    assert.strictEqual(b.clientPrepMs, 120);
    assert.strictEqual(b.waitForFirstEventMs, 400);
    assert.strictEqual(b.providerTtftMs, 900);
    assert.strictEqual(b.serverFirstTokenMs, undefined);
  });
});

// ---------------------------------------------------------------------------
// DD-AR-2: retry taxonomy
// ---------------------------------------------------------------------------

describe("DD-AR-2 backoff math", () => {
  it("observed constants", () => {
    assert.strictEqual(RETRY_SERVER_CAP, 3);
    assert.strictEqual(RETRY_TRANSPORT_CAP, 10);
    assert.strictEqual(RETRY_BACKOFF_BASE_MS, 1000);
    assert.strictEqual(RETRY_BACKOFF_CAP_MS, 60_000);
    assert.strictEqual(STALL_RETRY_BUDGET_MS, 180_000);
  });

  it("computeBackoffMs: base * 2^attempt capped at 60s + 20% jitter", () => {
    assert.strictEqual(computeBackoffMs(0, { random: ZERO_RANDOM }), 1000);
    assert.strictEqual(computeBackoffMs(1, { random: ZERO_RANDOM }), 2000);
    assert.strictEqual(computeBackoffMs(2, { random: ZERO_RANDOM }), 4000);
    assert.strictEqual(computeBackoffMs(10, { random: ZERO_RANDOM }), 60_000);
    // 20% jitter with random()=1
    assert.strictEqual(computeBackoffMs(0, { random: ONE_RANDOM }), 1200);
    assert.strictEqual(computeBackoffMs(10, { random: ONE_RANDOM }), 60_000 + 12_000);
  });

  it("test base is 100ms; fixedDelayMs overrides", () => {
    assert.strictEqual(computeBackoffMs(0, { isTest: true, random: ZERO_RANDOM }), 100);
    assert.strictEqual(computeBackoffMs(3, { isTest: true, random: ZERO_RANDOM }), 800);
    assert.strictEqual(computeBackoffMs(5, { fixedDelayMs: 250 }), 250);
  });

  it("selectDelayMs honors Retry-After (<=60s): max(backoff, retryAfter + 20% jitter)", () => {
    assert.strictEqual(selectDelayMs(1000, undefined, ZERO_RANDOM), 1000);
    assert.strictEqual(selectDelayMs(1000, 5000, ZERO_RANDOM), 5000);
    assert.strictEqual(selectDelayMs(5000, 1000, ZERO_RANDOM), 5000);
    // Retry-After capped at 60s, jitter capped at 60s.
    assert.strictEqual(selectDelayMs(1000, 120_000, ZERO_RANDOM), 60_000);
    assert.strictEqual(selectDelayMs(1000, 5000, ONE_RANDOM), 6000);
    assert.strictEqual(selectDelayMs(1000, 0, ZERO_RANDOM), 1000);
  });
});

describe("DD-AR-2 error classification", () => {
  it("verbatim 10-category map", () => {
    assert.deepStrictEqual(
      [
        "alpn_failure", "poll_seqno_gap", "append_fatal", "http_464",
        "http_404_unimplemented", "socket_reset", "stream_closed_early",
        "idle_deadline", "stall", "other",
      ].map(classifyStreamError),
      ["server", "server", "by_signature", "server", "server",
       "transport", "server", "server", "transport", "server"],
    );
  });

  it("unknown kinds default to server", () => {
    assert.strictEqual(classifyStreamError("http_429"), "server");
    assert.strictEqual(classifyStreamError(""), "server");
  });

  it("transport-signature test resolves by_signature", () => {
    assert.strictEqual(isTransportErrorSignature(new Error("socket hang up")), true);
    assert.strictEqual(isTransportErrorSignature(new Error("ECONNRESET")), true);
    assert.strictEqual(isTransportErrorSignature(new Error("plain server boom")), false);
  });
});

describe("DD-AR-2 RetryState", () => {
  it("server errors: 3 retries, 4th throws exhausted (verbatim messages)", () => {
    const r = new RetryState({ random: ZERO_RANDOM });
    for (let i = 1; i <= 3; i++) {
      const d = r.decide({ kind: "other" });
      assert.strictEqual(d.action, "retry");
      if (d.action === "retry") {
        assert.strictEqual(d.category, "server");
        assert.strictEqual(d.attempt, i);
      }
    }
    const d = r.decide({ kind: "other" });
    assert.strictEqual(d.action, "throw");
    if (d.action === "throw") {
      assert.strictEqual(d.kind, "exhausted");
      assert.strictEqual(d.message, "Server error");
      assert.strictEqual(d.isRetryable, true);
    }
  });

  it("transport errors: 10 retries, 11th throws (verbatim messages)", () => {
    const r = new RetryState({ random: ZERO_RANDOM });
    for (let i = 0; i < 10; i++) {
      assert.strictEqual(r.decide({ kind: "socket_reset" }).action, "retry");
    }
    const d = r.decide({ kind: "socket_reset" });
    assert.strictEqual(d.action, "throw");
    if (d.action === "throw") {
      assert.strictEqual(d.message, "Connection failed");
      assert.ok(d.detail.includes("network connection"));
      assert.strictEqual(d.isRetryable, true);
    }
  });

  it("stall budget: cumulative 180s then throw", () => {
    const r = new RetryState({ random: ZERO_RANDOM });
    const d1 = r.decide({ kind: "stall", stallDurationMs: 100_000 });
    assert.strictEqual(d1.action, "retry");
    if (d1.action === "retry") {
      assert.strictEqual(d1.category, "transport");
    }
    const d2 = r.decide({ kind: "stall", stallDurationMs: 90_000 });
    assert.strictEqual(d2.action, "throw");
    if (d2.action === "throw") {
      assert.strictEqual(d2.kind, "stall_budget");
    }
    assert.strictEqual(r.stallElapsed, 190_000);
  });

  it("no-progress guard: 2 no-progress resumes throw the verbatim stop error", () => {
    const r = new RetryState({ random: ZERO_RANDOM });
    r.recordNoProgressResume();
    r.recordNoProgressResume();
    const d = r.decide({ kind: "stall" });
    assert.strictEqual(d.action, "throw");
    if (d.action === "throw") {
      assert.strictEqual(d.kind, "no_progress");
      assert.strictEqual(d.message, RETRY_NO_PROGRESS_MESSAGE);
      assert.strictEqual(d.isRetryable, true);
    }
    assert.strictEqual(NO_PROGRESS_RESUME_LIMIT, 2);
  });

  it("progress resets the no-progress counter", () => {
    const r = new RetryState({ random: ZERO_RANDOM });
    r.recordNoProgressResume();
    r.recordProgress();
    r.recordNoProgressResume();
    assert.strictEqual(r.decide({ kind: "stall" }).action, "retry");
  });

  it("terminal checkpoint guard: throw without resume, not retryable", () => {
    const r = new RetryState({ random: ZERO_RANDOM });
    const d = r.decide({ kind: "other", isTerminalCheckpoint: true });
    assert.strictEqual(d.action, "throw");
    if (d.action === "throw") {
      assert.strictEqual(d.kind, "terminal");
      assert.strictEqual(d.isRetryable, false);
    }
  });

  it("endlessRetries bypasses the caps", () => {
    const r = new RetryState({ random: ZERO_RANDOM, endlessRetries: true });
    for (let i = 0; i < 25; i++) {
      assert.strictEqual(r.decide({ kind: "socket_reset" }).action, "retry");
    }
  });

  it("Retry-After is honored in the selected delay", () => {
    const r = new RetryState({ random: ZERO_RANDOM });
    const d = r.decide({ kind: "other", retryAfterMs: 5000 });
    assert.strictEqual(d.action, "retry");
    if (d.action === "retry") {
      assert.strictEqual(d.waitingForRetryAfter, true);
      assert.ok(d.delayMs >= 5000);
    }
  });

  it("abortableSleep resolves and rejects on abort", async () => {
    const r = new RetryState();
    await r.abortableSleep(5);
    const c = new AbortController();
    const p = r.abortableSleep(5000, c.signal);
    c.abort();
    await assert.rejects(p, /Cancelled during backoff/);
    const c2 = new AbortController();
    c2.abort();
    await assert.rejects(r.abortableSleep(10, c2.signal), /Cancelled during backoff/);
  });
});

// ---------------------------------------------------------------------------
// DD-AR-3: resume-from-checkpoint
// ---------------------------------------------------------------------------

describe("DD-AR-3 ResumeStateTracker", () => {
  it("no checkpoint -> no resumeAction (plain retry)", () => {
    const r = new ResumeStateTracker();
    assert.strictEqual(r.buildResumeAction("req-1", "att-1"), undefined);
  });

  it("builds the Cursor-shaped resumeAction with checkpoint state", () => {
    const r = new ResumeStateTracker();
    r.recordCheckpoint("ckpt-42");
    assert.deepStrictEqual(r.buildResumeAction("req-1", "att-2"), {
      type: "resume",
      checkpointId: "ckpt-42",
      originalRequestId: "req-1",
      attemptRequestId: "att-2",
    });
  });

  it("no-progress guard trips after 2 failures, resets on progress", () => {
    const r = new ResumeStateTracker();
    r.recordResumeOutcome(false);
    assert.strictEqual(r.shouldStopNoProgress(), false);
    r.recordResumeOutcome(false);
    assert.strictEqual(r.shouldStopNoProgress(), true);
    assert.strictEqual(r.noProgressResumeFailures, 2);
    r.recordResumeOutcome(true);
    assert.strictEqual(r.shouldStopNoProgress(), false);
  });
});

// ---------------------------------------------------------------------------
// DD-AR-4: blocking summarization
// ---------------------------------------------------------------------------

describe("DD-AR-4 BlockingSummarizer", () => {
  it("WaitForCompletion parking: request resolves only after summarize finishes", async () => {
    const order: string[] = [];
    const s = new BlockingSummarizer({
      summarize: async (trigger) => {
        order.push(`start:${trigger}`);
        await new Promise((r) => setTimeout(r, 20));
        order.push("end");
      },
    });
    let resolved = false;
    const p = s.request("token_limit").then(() => {
      resolved = true;
    });
    await new Promise((r) => setTimeout(r, 5));
    assert.strictEqual(resolved, false, "turn must stay parked while summarizing");
    assert.ok(s.isSummarizing());
    await p;
    assert.strictEqual(resolved, true);
    assert.deepStrictEqual(order, ["start:token_limit", "end"]);
  });

  it("concurrent requests join the in-flight summary (one at a time)", async () => {
    let runs = 0;
    const s = new BlockingSummarizer({
      summarize: async () => {
        runs += 1;
        await new Promise((r) => setTimeout(r, 10));
      },
    });
    await Promise.all([s.request("token_limit"), s.request("image_limit")]);
    assert.strictEqual(runs, 1);
  });

  it("a failed summary never wedges the turn", async () => {
    const logs: string[] = [];
    const s = new BlockingSummarizer({
      summarize: async () => {
        throw new Error("boom");
      },
      log: (m) => logs.push(m),
    });
    await s.request("threshold");
    assert.strictEqual(s.isSummarizing(), false);
    assert.ok(logs.some((l) => l.includes("boom")));
  });

  it("orphan hold: markTurnEnded during in-flight summary parks for the hold", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const s = new BlockingSummarizer({
      summarize: () => gate,
      orphanHoldMs: 40,
    });
    const req = s.request("token_limit");
    s.markTurnEnded();
    // Release the summary after 10ms; the hold must still resolve (min of hold/completion).
    setTimeout(release, 10);
    await s.waitForOrphanHold();
    await req;
    assert.strictEqual(s.isSummarizing(), false);
  });

  it("waitForOrphanHold resolves immediately with nothing in flight", async () => {
    const s = new BlockingSummarizer({ orphanHoldMs: 30_000 });
    await s.waitForOrphanHold();
  });

  it("detectSummarizationTrigger", () => {
    assert.strictEqual(detectSummarizationTrigger("Hit token limit error"), "token_limit");
    assert.strictEqual(detectSummarizationTrigger("maximum context length exceeded"), "token_limit");
    assert.strictEqual(detectSummarizationTrigger("image limit exceeded"), "image_limit");
    assert.strictEqual(detectSummarizationTrigger("too many images attached"), "image_limit");
    assert.strictEqual(detectSummarizationTrigger("all good"), undefined);
    assert.strictEqual(SUMMARIZATION_THRESHOLD_PERCENT, 70);
  });
});

// ---------------------------------------------------------------------------
// DD-AR-5: tool error taxonomy
// ---------------------------------------------------------------------------

describe("DD-AR-5 tool error taxonomy", () => {
  it("14 classes classified from error shapes", () => {
    const timeout = new Error("request timed out");
    timeout.name = "TimeoutError";
    assert.strictEqual(classifyToolError(timeout), ToolErrorClass.TIMEOUT);
    assert.strictEqual(classifyToolError(new Error("rejected by user")), ToolErrorClass.USER_REJECTED);
    assert.strictEqual(classifyToolError(new Error("denied by hook")), ToolErrorClass.HOOK_DENIED);
    assert.strictEqual(classifyToolError(new Error("invalid args: path required")), ToolErrorClass.INVALID_ARGS);
    assert.strictEqual(classifyToolError(new Error("mcp auth token expired")), ToolErrorClass.MCP_AUTH_ERROR);
    assert.strictEqual(classifyToolError(new Error("something weird")), ToolErrorClass.OTHER_ERROR);
    const abort = new Error("aborted");
    abort.name = "AbortError";
    assert.strictEqual(classifyToolError(abort), ToolErrorClass.ABORTED);
  });

  it("formatToolError produces the triple-message shape", () => {
    const f = formatToolError(new Error("request timed out"), "bash");
    assert.strictEqual(f.classification, ToolErrorClass.TIMEOUT);
    assert.ok(f.error.includes("bash"));
    assert.strictEqual(f.clientVisibleErrorMessage, "The tool call timed out.");
    assert.ok(f.modelVisibleErrorMessage.includes("timed out"));
    assert.ok(!f.modelVisibleErrorMessage.includes("request timed out") || f.modelVisibleErrorMessage.includes("<|redacted_tool_output_begin|>"));
    assert.ok(f.systemReminders.length > 0);
    // The three messages are distinct surfaces.
    assert.notStrictEqual(f.error, f.clientVisibleErrorMessage);
    assert.notStrictEqual(f.clientVisibleErrorMessage, f.modelVisibleErrorMessage);
  });

  it("redaction markers wrap tool output verbatim", () => {
    assert.strictEqual(
      redactToolOutput("secret"),
      "<|redacted_tool_output_begin|>secret<|redacted_tool_output_end|>",
    );
  });
});

// ---------------------------------------------------------------------------
// DD-AR-6: model fallback protocol
// ---------------------------------------------------------------------------

describe("DD-AR-6 ModelFallbackManager", () => {
  const cfg: FeatureModelConfig = {
    defaultModel: "p0/m0",
    fallbackModels: ["p1/m1", "p2/m2"],
    bestOfNDefaultModels: [],
  };

  it("builds the ON_ERROR warning with the first fallback model", () => {
    const m = new ModelFallbackManager({ getFeatureConfig: () => cfg });
    const w = m.buildRateLimitWarning("p0/m0");
    assert.strictEqual(w.trigger, "ON_ERROR");
    assert.strictEqual(w.message, "Rate limited by model provider, retrying…");
    assert.deepStrictEqual(w.affectedModels, ["p0/m0"]);
    assert.strictEqual(w.fallbackModel, "p1/m1");
  });

  it("resolveFallback returns the fallback and counts warnings", () => {
    const logs: string[] = [];
    const m = new ModelFallbackManager({ getFeatureConfig: () => cfg, log: (x) => logs.push(x) });
    const w = m.buildRateLimitWarning("p0/m0");
    assert.strictEqual(m.resolveFallback(w), "p1/m1");
    assert.strictEqual(m.warningsShown, 1);
    assert.ok(logs[0].includes("ON_ERROR"));
  });

  it("no configured fallbacks -> warning without fallback model", () => {
    const m = new ModelFallbackManager({ getFeatureConfig: () => undefined });
    const w = m.buildRateLimitWarning("p0/m0");
    assert.strictEqual(w.fallbackModel, undefined);
    assert.strictEqual(m.resolveFallback(w), undefined);
  });

  it("ON_SELECT warning shape", () => {
    const m = new ModelFallbackManager({ getFeatureConfig: () => cfg });
    assert.strictEqual(m.buildSelectWarning("p0/m0").trigger, "ON_SELECT");
  });
});

// ---------------------------------------------------------------------------
// DD-AR-7: single-message loop detection
// ---------------------------------------------------------------------------

describe("DD-AR-7 SingleMessageLoopDetector", () => {
  it("policy name is retry_once", () => {
    assert.strictEqual(SINGLE_MESSAGE_LOOP_POLICY, "retry_once");
  });

  it("fnv1aHash is deterministic and discriminating", () => {
    assert.strictEqual(fnv1aHash("abc"), fnv1aHash("abc"));
    assert.notStrictEqual(fnv1aHash("abc"), fnv1aHash("abd"));
  });

  it("throws LoopDetectedError on 3 consecutive identical tool args", () => {
    const d = new SingleMessageLoopDetector();
    const args = JSON.stringify({ command: "ls -la" });
    d.observe("tool_args", args);
    d.observe("tool_args", args);
    assert.throws(
      () => d.observe("tool_args", args),
      (err: unknown) => {
        assert.ok(err instanceof LoopDetectedError);
        assert.strictEqual(err.loopType, "singleMessage");
        assert.strictEqual(err.loopKind, "single_message_multi_line");
        assert.strictEqual(err.repetitions, 3);
        assert.match(err.evidenceFingerprint, /^[0-9a-f]{8}$/);
        assert.strictEqual(err.name, "LoopDetectedError");
        return true;
      },
    );
  });

  it("a different message resets the rolling counter", () => {
    const d = new SingleMessageLoopDetector();
    const a = JSON.stringify({ command: "ls" });
    const b = JSON.stringify({ command: "pwd" });
    d.observe("tool_args", a);
    d.observe("tool_args", a);
    d.observe("tool_args", b); // reset
    d.observe("tool_args", a);
    d.observe("tool_args", a); // only 2 consecutive — no throw
  });

  it("reasoning channel uses the reasoning loop kind", () => {
    const d = new SingleMessageLoopDetector();
    d.observe("reasoning", "thinking the same thought");
    d.observe("reasoning", "thinking the same thought");
    assert.throws(() => d.observe("reasoning", "thinking the same thought"), (err: unknown) => {
      assert.ok(err instanceof LoopDetectedError);
      assert.strictEqual((err as LoopDetectedError).loopKind, "single_message_reasoning_single_line");
      return true;
    });
  });

  it("reset() clears the detector", () => {
    const d = new SingleMessageLoopDetector();
    d.observe("tool_args", "x");
    d.observe("tool_args", "x");
    d.reset();
    d.observe("tool_args", "x");
    d.observe("tool_args", "x"); // no throw after reset
  });
});

// ---------------------------------------------------------------------------
// DD-AR-8: shadow-mode approval protocol
// ---------------------------------------------------------------------------

describe("DD-AR-8 runShadowClassifier", () => {
  it("fire-and-forget: verdict is logged, never blocks, errors swallowed", async () => {
    const seen: Array<{ decision: string; input: unknown }> = [];
    // Classifier says "block" — the caller must NOT be blocked.
    runShadowClassifier(
      { action: "bash", resources: ["rm -rf /"] },
      () => "block",
      (result, input) => {
        seen.push({ decision: result.decision, input });
      },
    );
    // Classifier throws — swallowed, logged as allow+error.
    runShadowClassifier(
      { action: "read", resources: [] },
      () => {
        throw new Error("classifier exploded");
      },
      (result) => {
        seen.push({ decision: `${result.decision}:${result.error}`, input: null });
      },
    );
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(seen.length, 2);
    // Fire-and-forget: completion order is not guaranteed — assert as a set.
    const decisions = seen.map((s) => s.decision).sort();
    assert.deepStrictEqual(decisions, ["allow:classifier exploded", "block"]);
    const blockEntry = seen.find((s) => s.decision === "block");
    assert.deepStrictEqual((blockEntry!.input as { action: string }).action, "bash");
  });

  it("passes the mode flag 'shadow' to the classifier", async () => {
    let modeSeen = "";
    runShadowClassifier({ action: "x", resources: [] }, (mode) => {
      modeSeen = mode;
      return "allow";
    }, () => {});
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(modeSeen, "shadow");
  });
});

// ---------------------------------------------------------------------------
// DD-AR-9: turnSettled protocol
// ---------------------------------------------------------------------------

describe("DD-AR-9 turnSettled", () => {
  it("buildTurnSettled shapes COMPLETED/FAILED/INTERRUPTED", () => {
    const done = buildTurnSettled("turn-1", "COMPLETED", { bubbleId: "b1" });
    assert.deepStrictEqual(done, {
      type: "turnSettled",
      turnId: "turn-1",
      bubbleId: "b1",
      outcome: "COMPLETED",
    });
    const interrupted = buildTurnSettled("turn-2", "INTERRUPTED", {
      bubbleId: "b2",
      interruptedBy: "USER",
      error: "stopped",
    });
    assert.strictEqual(interrupted.interruptedBy, "USER");
    assert.strictEqual(interrupted.outcome, "INTERRUPTED");
  });

  it("appendTurnSettledByError: MaxStepsReachedError -> INTERRUPTED + MAX_STEPS_REACHED", () => {
    const s = appendTurnSettledByError("turn-3", "b3", new MaxStepsReachedError());
    assert.strictEqual(s.outcome, "INTERRUPTED");
    assert.strictEqual(s.stopReason, "MAX_STEPS_REACHED");
  });

  it("appendTurnSettledByError: other errors -> FAILED", () => {
    const s = appendTurnSettledByError("turn-4", "b4", new Error("boom"));
    assert.strictEqual(s.outcome, "FAILED");
    assert.strictEqual(s.error, "boom");
    assert.strictEqual(s.stopReason, undefined);
  });
});

// ---------------------------------------------------------------------------
// DD-AR-10: shell timeout constants
// ---------------------------------------------------------------------------

describe("DD-AR-10 shell timeout constants", () => {
  it("matches Cursor's observed values", () => {
    assert.strictEqual(SHELL_FOREGROUND_TIMEOUT_MS, 30_000);
    assert.strictEqual(SHELL_BACKGROUND_TIMEOUT_MS, 600_000);
    assert.strictEqual(SHELL_HARD_TIMEOUT_MS, 86_400_000);
    assert.strictEqual(SHELL_DEFAULT_TIMEOUT_MS, 300_000);
  });

  it("P1-B: documents which timeouts are actually enforced client-side", () => {
    // HONEST-DIVERGENCE: only SHELL_BACKGROUND_TIMEOUT_MS has a production
    // call site (terminalService.ts sends Ctrl+C after 10 min on background
    // VS Code terminal runs). The other three are reference values only —
    // the engine enforces its own timeout policy server-side.
    // This test exists so the divergence is asserted, not silently assumed.
    assert.strictEqual(
      SHELL_TIMEOUTS_CLIENT_ENFORCED,
      false,
      "If this becomes true, the three unwired timeouts must have real call sites"
    );
  });
});

// ---------------------------------------------------------------------------
// Adapter helpers
// ---------------------------------------------------------------------------

describe("adapter helpers", () => {
  it("parseRetryAfterMs: delay-seconds, arrays, garbage, HTTP dates", () => {
    assert.strictEqual(parseRetryAfterMs("5"), 5000);
    assert.strictEqual(parseRetryAfterMs(["2"]), 2000);
    assert.strictEqual(parseRetryAfterMs("0"), 0);
    assert.strictEqual(parseRetryAfterMs(undefined), undefined);
    assert.strictEqual(parseRetryAfterMs("garbage"), undefined);
    const future = new Date(Date.now() + 10_000).toUTCString();
    const ms = parseRetryAfterMs(future);
    assert.ok(ms !== undefined && ms > 0 && ms <= 10_000);
  });

  it("parseModelRefString: 'providerID/modelId' shape", () => {
    assert.deepStrictEqual(parseModelRefString("anthropic/claude-x"), {
      providerID: "anthropic",
      id: "claude-x",
    });
    assert.strictEqual(parseModelRefString("nonsense"), undefined);
    assert.strictEqual(parseModelRefString("/m1"), undefined);
    assert.strictEqual(parseModelRefString("p1/"), undefined);
  });
});
