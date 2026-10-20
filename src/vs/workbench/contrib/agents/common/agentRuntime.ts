// IDE-CODE: Migrated from extensions/ide-agent/src/services/agentRuntime.ts (CAT-A, pure logic).
/**
 * agentRuntime.ts — agent-loop runtime hardening (Cursor 3.25.9 parity).
 *
 * Pure, vscode-free implementations of the 10 P1 gaps from
 * `docs/rea/dig-deeper-agent-runtime-2026-10-19.md` (binary-verified against
 * cursor-agent-host/dist/main.js + cursor-agent-exec/dist/main.js, 3.25.9).
 * All constants below are OBSERVED values from the binary; the mechanism is
 * re-implemented in our layer, never copied.
 *
 * HONEST-DIVERGENCE notes (marked inline): Cursor is server-driven; our
 * engine (ide-code sidecar) owns the model loop server-side, so the
 * client-side pieces here are protocol-faithful mappings, not 1:1 copies.
 * Each divergence is documented at the code site.
 */

import { TurnInterruptedBy, TurnOutcome, TurnSettled, TurnStopReason } from "../../composer/common/model.js";
// Re-exported for consumers that import turn types via this module
// (ideCodeEngineAdapter imports TurnOutcome/TurnSettled/TurnInterruptedBy from here).
export type { TurnInterruptedBy, TurnOutcome, TurnSettled };

// ============================================================================
// DD-AR-10: shell/tool timeout constants (OBSERVED, exec main.js)
// ============================================================================
/** Shell foreground `block_until` default: 30s. */
export const SHELL_FOREGROUND_TIMEOUT_MS = 30_000;
/** Shell background agent timeout: 10 min (600_000). */
export const SHELL_BACKGROUND_TIMEOUT_MS = 600_000;
/** Shell background hard timeout: 24h (86_400_000). */
export const SHELL_HARD_TIMEOUT_MS = 86_400_000;
/** Shell `timeout` default (dsv3-1018): 5 min (300_000). */
export const SHELL_DEFAULT_TIMEOUT_MS = 300_000;

// ============================================================================
// DD-AR-1: stream stall detector
// ============================================================================

/**
 * Stall fail threshold: 30,000 ms default (OBSERVED, host 1698900-area).
 * In production (!isRunningInTest) clamped to >= 20,000 ms.
 */
export const STALL_FAIL_THRESHOLD_MS = 30_000;
/** Heartbeat-only stall threshold = 3 x fail threshold (OBSERVED, host 1700600). */
export const STALL_HEARTBEAT_ONLY_MULTIPLIER = 3;
/** Production floor for the fail threshold (OBSERVED). */
export const STALL_PROD_FLOOR_MS = 20_000;

/** Verbatim stall messages (OBSERVED, host 1706565-area). */
export const STALL_MESSAGE_NO_ACTIVITY =
  "Bidirectional stream stall detected - no activity for threshold period";
export const STALL_MESSAGE_HEARTBEAT_ONLY =
  "Stream receiving heartbeats only - no meaningful data for threshold period";
export const STALL_MESSAGE_RECOVERED = "Stream activity resumed after stall";

/**
 * The `IsStreamEvent` gate (OBSERVED, host offset 1709072): only these
 * interactionUpdate cases count as stream events for stall/timeout purposes.
 * Heartbeats and turn-management messages do NOT reset the stream-activity
 * timer the same way.
 */
const STREAM_EVENT_KINDS = new Set([
  "textDelta",
  "thinkingDelta",
  "thinkingCompleted",
  "partialToolCall",
  "toolCallDelta",
  "toolCallStarted",
  "toolCallCompleted",
  "tokenDelta",
]);

export function isStreamEventKind(kind: string): boolean {
  return STREAM_EVENT_KINDS.has(kind);
}

export type StallKind = "no_activity" | "heartbeat_only";

export interface StallInfo {
  kind: StallKind;
  stallDurationMs: number;
  thresholdMs: number;
  message: string;
}

export type StreamActivityKind = "stream" | "heartbeat" | "control";

export interface StreamStallDetectorOptions {
  thresholdMs?: number;
  advisoryThresholdMs?: number;
  heartbeatOnlyThresholdMs?: number;
  isTest?: boolean;
  now?: () => number;
  onStall?: (info: StallInfo) => void;
}

/**
 * Stream stall detector (OBSERVED mechanism, host 1700600-1709100).
 *
 * Tracks last stream-event / heartbeat / inbound activity. checkStall()
 * distinguishes "no_activity" (nothing at all for the threshold period) from
 * "heartbeat_only" (heartbeats keep arriving within 3x the threshold but no
 * meaningful stream events). Cursor aborts/retries at the fail threshold;
 * stall aborts count as transport errors with a 180s cumulative budget
 * (see RetryState).
 */
export class StreamStallDetector {
  private readonly thresholdMs: number;
  private readonly advisoryThresholdMs?: number;
  private readonly heartbeatOnlyThresholdMs: number;
  private readonly now: () => number;
  private readonly onStall?: (info: StallInfo) => void;

  private startedAt: number;
  private lastStreamAt: number;
  private lastHeartbeatAt = -Infinity;
  private lastInboundAt: number;
  private lastOutboundAt: number;
  private lastInboundKind = "none";
  private lastOutboundKind = "none";
  private streamEnded = false;
  private aborted = false;
  private stalled = false;

  constructor(opts: StreamStallDetectorOptions = {}) {
    const isTest = opts.isTest ?? false;
    let threshold = opts.thresholdMs ?? STALL_FAIL_THRESHOLD_MS;
    // Production floor: !isRunningInTest clamps to >= 20s (OBSERVED).
    if (!isTest && threshold < STALL_PROD_FLOOR_MS) {
      threshold = STALL_PROD_FLOOR_MS;
    }
    this.thresholdMs = threshold;
    this.advisoryThresholdMs = opts.advisoryThresholdMs;
    this.heartbeatOnlyThresholdMs =
      opts.heartbeatOnlyThresholdMs ?? STALL_HEARTBEAT_ONLY_MULTIPLIER * threshold;
    this.now = opts.now ?? Date.now;
    this.onStall = opts.onStall;
    const t = this.now();
    this.startedAt = t;
    this.lastStreamAt = t;
    this.lastInboundAt = t;
    this.lastOutboundAt = t;
  }

  /** Record inbound activity. "stream" = IsStreamEvent content; "heartbeat" = heartbeat; "control" = turn-management. */
  recordActivity(kind: StreamActivityKind): void {
    const t = this.now();
    this.lastInboundAt = t;
    this.lastInboundKind = kind;
    if (kind === "stream") {
      const wasStalled = this.stalled;
      this.lastStreamAt = t;
      this.stalled = false;
      if (wasStalled) {
        // On recovery Cursor emits "Stream activity resumed after stall" +
        // agent_client.stream.stall.duration_ms histogram (OBSERVED).
        this.onStall?.({
          kind: "no_activity",
          stallDurationMs: 0,
          thresholdMs: this.thresholdMs,
          message: STALL_MESSAGE_RECOVERED,
        });
      }
    } else if (kind === "heartbeat") {
      this.lastHeartbeatAt = t;
    }
  }

  /** Record an outbound message (Cursor also tracks client heartbeats). */
  recordOutbound(kind = "message"): void {
    this.lastOutboundAt = this.now();
    this.lastOutboundKind = kind;
  }

  /**
   * Returns stall info when the fail threshold is exceeded, else null.
   * "heartbeat_only" when heartbeats arrived within the 3x window but no
   * stream events; "no_activity" when nothing arrived at all.
   */
  checkStall(): StallInfo | null {
    if (this.streamEnded || this.aborted || this.stalled) {
      return null;
    }
    const now = this.now();
    const sinceStream = now - this.lastStreamAt;
    if (sinceStream < this.thresholdMs) {
      return null;
    }
    const sinceHeartbeat = now - this.lastHeartbeatAt;
    const kind: StallKind =
      sinceHeartbeat <= this.heartbeatOnlyThresholdMs ? "heartbeat_only" : "no_activity";
    const info: StallInfo = {
      kind,
      stallDurationMs: sinceStream,
      thresholdMs: this.thresholdMs,
      message: kind === "heartbeat_only" ? STALL_MESSAGE_HEARTBEAT_ONLY : STALL_MESSAGE_NO_ACTIVITY,
    };
    this.stalled = true;
    this.onStall?.(info);
    return info;
  }

  markStreamEnded(): void {
    this.streamEnded = true;
  }

  markAborted(): void {
    this.aborted = true;
  }

  /** Fresh per attempt: reset all activity timestamps (Cursor constructs one per stream). */
  reset(): void {
    const t = this.now();
    this.startedAt = t;
    this.lastStreamAt = t;
    this.lastInboundAt = t;
    this.lastOutboundAt = t;
    this.lastHeartbeatAt = -Infinity;
    this.streamEnded = false;
    this.aborted = false;
    this.stalled = false;
  }

  get lastActivitySummary(): {
    lastInboundKind: string;
    lastOutboundKind: string;
    lastStreamAgoMs: number;
    lastHeartbeatAgoMs: number;
  } {
    const now = this.now();
    return {
      lastInboundKind: this.lastInboundKind,
      lastOutboundKind: this.lastOutboundKind,
      lastStreamAgoMs: now - this.lastStreamAt,
      lastHeartbeatAgoMs: now - this.lastHeartbeatAt,
    };
  }
}

/**
 * Map our engine's SSE event names onto the stall detector's activity kinds.
 * Pure; unit-tested. Our wire has no heartbeat events today — the
 * "heartbeat" branch exists for protocol completeness.
 */
export function classifyEngineSseEvent(eventType: string): StreamActivityKind {
  switch (eventType) {
    case "session.text.delta":
    case "session.reasoning.delta":
    case "message.part.delta":
    case "message.part.updated":
    case "session.tool.called":
    case "session.tool.progress":
    case "session.tool.success":
    case "session.tool.failed":
      return "stream";
    case "heartbeat":
      return "heartbeat";
    default:
      return "control";
  }
}

/** ttftBreakdown (OBSERVED, host offset 1718771): 6 phases + clock source. */
export interface TtftBreakdown {
  serverFirstTokenMs?: number;
  preStreamSetupMs?: number;
  waitForFirstEventMs?: number;
  providerTtftMs?: number;
  slowPoolWaitMs?: number;
  clientPrepMs?: number;
  clock: "client" | "server";
}

/**
 * Client-measured ttftBreakdown builder.
 * HONEST-DIVERGENCE: Cursor's breakdown is measured across its server
 * (serverFirstTokenMs, slowPoolWaitMs are server-side phases). We measure
 * the client-observable phases with the client clock; server-side phases
 * are left undefined.
 */
export class TtftTracker {
  private readonly now: () => number;
  private readonly clock: "client" | "server";
  private marks = new Map<string, number>();

  constructor(now: () => number = Date.now, clock: "client" | "server" = "client") {
    this.now = now;
    this.clock = clock;
  }

  mark(name: "requestSent" | "streamSetupDone" | "firstEvent" | "firstToken"): void {
    if (!this.marks.has(name)) {
      this.marks.set(name, this.now());
    }
  }

  build(): TtftBreakdown {
    const t = (n: string): number | undefined => this.marks.get(n);
    const diff = (a: string, b: string): number | undefined => {
      const x = t(a);
      const y = t(b);
      return x !== undefined && y !== undefined ? y - x : undefined;
    };
    return {
      clientPrepMs: diff("requestSent", "streamSetupDone"),
      waitForFirstEventMs: diff("requestSent", "firstEvent"),
      providerTtftMs: diff("requestSent", "firstToken"),
      clock: this.clock,
    };
  }
}

// ============================================================================
// DD-AR-2: retry taxonomy — caps, backoff, Retry-After, stall budget
// ============================================================================

/** Default caps: tt = {serverCap: 3, transportCap: 10} (OBSERVED, host 1695054-area). */
export const RETRY_SERVER_CAP = 3;
export const RETRY_TRANSPORT_CAP = 10;
/** In tests transportCap = min(10, 2) (OBSERVED). */
export const RETRY_TRANSPORT_CAP_TEST = 2;
/** Backoff Et(): base = isTest ? 100 : 1000 ms; delay = min(base * 2^attempt, 60000) + 20% jitter. */
export const RETRY_BACKOFF_BASE_MS = 1000;
export const RETRY_BACKOFF_BASE_TEST_MS = 100;
export const RETRY_BACKOFF_CAP_MS = 60_000;
export const RETRY_JITTER_RATIO = 0.2;
/** Retry-After honored up to 60s: min(retryAfterMs, 60000) (OBSERVED). */
export const RETRY_AFTER_CAP_MS = 60_000;
/** One category caps at min(300000, 3x computed) (OBSERVED). */
export const RETRY_PER_CATEGORY_CAP_MS = 300_000;
/** Stall retries stop after 180,000 ms cumulative stall time (OBSERVED, host 1696341-area). */
export const STALL_RETRY_BUDGET_MS = 180_000;
/** Resume no-progress limit: noProgressResumeFailures >= 2 -> user-facing stop (OBSERVED, host 1712880-area). */
export const NO_PROGRESS_RESUME_LIMIT = 2;

export type StreamErrorCategory = "server" | "transport" | "by_signature";

/**
 * Error classification -> retry/throw (verbatim map, OBSERVED host 1695054-area).
 * `append_fatal -> by_signature`: re-checked via the transport-signature test.
 */
export const STREAM_ERROR_CATEGORY_MAP: Record<string, StreamErrorCategory> = {
  alpn_failure: "server",
  poll_seqno_gap: "server",
  append_fatal: "by_signature",
  http_464: "server",
  http_404_unimplemented: "server",
  socket_reset: "transport",
  stream_closed_early: "server",
  idle_deadline: "server",
  stall: "transport",
  other: "server",
};

export function classifyStreamError(kind: string): StreamErrorCategory {
  return STREAM_ERROR_CATEGORY_MAP[kind] ?? "server";
}

/**
 * Transport-signature test for the `by_signature` category (Cursor: `ve(t)`).
 * Our client-side approximation: known transport failure markers.
 */
export function isTransportErrorSignature(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /socket|econn|hang up|network|dns|enotfound|eai_again/i.test(msg);
}

export interface BackoffOptions {
  isTest?: boolean;
  fixedDelayMs?: number;
  random?: () => number;
}

/**
 * Backoff Et(attempt, isTest, fixedDelay) (OBSERVED, host 1709427-area):
 * base = isTest ? 100 : 1000; delay = min(base * 2^attempt, 60000) + 20% jitter.
 * `fixedRetryDelayMs` overrides. `attempt` is 0-based (first retry = attempt 0).
 */
export function computeBackoffMs(attempt: number, opts: BackoffOptions = {}): number {
  const random = opts.random ?? Math.random;
  if (opts.fixedDelayMs !== undefined) {
    return opts.fixedDelayMs;
  }
  const base = opts.isTest ? RETRY_BACKOFF_BASE_TEST_MS : RETRY_BACKOFF_BASE_MS;
  const capped = Math.min(base * 2 ** attempt, RETRY_BACKOFF_CAP_MS);
  return capped + capped * RETRY_JITTER_RATIO * random();
}

/**
 * Retry-After honoring (OBSERVED): selectedDelay =
 * max(computedBackoff, min(retryAfterMs, 60000) + 20% jitter), the jittered
 * Retry-After itself capped at 60s. Logged as "Waiting for Retry-After".
 */
export function selectDelayMs(
  computedBackoffMs: number,
  retryAfterMs?: number,
  random: () => number = Math.random,
): number {
  if (retryAfterMs === undefined || retryAfterMs <= 0) {
    return computedBackoffMs;
  }
  const honored = Math.min(retryAfterMs, RETRY_AFTER_CAP_MS);
  const withJitter = Math.min(honored + honored * RETRY_JITTER_RATIO * random(), RETRY_AFTER_CAP_MS);
  return Math.max(computedBackoffMs, withJitter);
}

export type RetryThrowKind = "exhausted" | "stall_budget" | "no_progress" | "terminal";

export type RetryDecision =
  | { action: "retry"; delayMs: number; category: "server" | "transport"; attempt: number; waitingForRetryAfter: boolean }
  | { action: "throw"; kind: RetryThrowKind; message: string; detail: string; isRetryable: boolean };

export interface RetryErrorInfo {
  /** Canonical kind key from STREAM_ERROR_CATEGORY_MAP (or "by_signature"). */
  kind: string;
  retryAfterMs?: number;
  /** "ineligible_terminal_turn" guard: complete without automatic resume (OBSERVED). */
  isTerminalCheckpoint?: boolean;
  /** Cumulative stall time to add (ms) for kind === "stall". */
  stallDurationMs?: number;
  /** Raw error, used only for the by_signature transport test. */
  rawError?: unknown;
}

/** Verbatim user-facing exhausted messages (OBSERVED, host 1712880-area). */
export const RETRY_EXHAUSTED_CONNECTION_MESSAGE = "Connection failed";
export const RETRY_EXHAUSTED_CONNECTION_DETAIL =
  "The connection failed N times. Please check your network connection and try again.";
export const RETRY_EXHAUSTED_SERVER_MESSAGE = "Server error";
export const RETRY_EXHAUSTED_SERVER_DETAIL = "The server failed N times.";
export const RETRY_NO_PROGRESS_MESSAGE = "Agent turn stopped after repeated resume attempts made no progress";
export const RETRY_NO_PROGRESS_DETAIL =
  "The connection was interrupted repeatedly without saving progress, so the agent stopped to avoid repeating the same work. Retry to continue from the last saved state.";

/**
 * Request-level retry state machine (OBSERVED mechanism, host 1694800-1715900).
 * Separate server/transport counters with distinct caps; stall budget;
 * no-progress guard; endless-retry mode; abortable backoff sleep.
 */
export class RetryState {
  private serverErrors = 0;
  private transportErrors = 0;
  private stallElapsedMs = 0;
  private noProgressResumeFailures = 0;
  private readonly serverCap: number;
  private readonly transportCap: number;
  private readonly isTest: boolean;
  private readonly endlessRetries: boolean;
  private readonly enableAgentRetries: boolean;
  private readonly fixedDelayMs?: number;
  private readonly random: () => number;
  private readonly log?: (msg: string) => void;

  constructor(
    opts: {
      isTest?: boolean;
      endlessRetries?: boolean;
      enableAgentRetries?: boolean;
      fixedDelayMs?: number;
      random?: () => number;
      log?: (msg: string) => void;
    } = {},
  ) {
    this.isTest = opts.isTest ?? false;
    this.endlessRetries = opts.endlessRetries ?? false;
    this.enableAgentRetries = opts.enableAgentRetries ?? true;
    this.fixedDelayMs = opts.fixedDelayMs;
    this.random = opts.random ?? Math.random;
    this.log = opts.log;
    this.serverCap = RETRY_SERVER_CAP;
    this.transportCap = this.isTest
      ? Math.min(RETRY_TRANSPORT_CAP, RETRY_TRANSPORT_CAP_TEST)
      : RETRY_TRANSPORT_CAP;
  }

  /** Cursor: noProgressResumeFailures >= 2 -> throws the user-facing stop error. */
  recordNoProgressResume(): void {
    this.noProgressResumeFailures += 1;
  }

  recordProgress(): void {
    this.noProgressResumeFailures = 0;
  }

  get serverErrorCount(): number {
    return this.serverErrors;
  }
  get transportErrorCount(): number {
    return this.transportErrors;
  }
  get stallElapsed(): number {
    return this.stallElapsedMs;
  }

  decide(info: RetryErrorInfo): RetryDecision {
    // Terminal-checkpoint guard: "ineligible_terminal_turn" -> completes without automatic resume.
    if (info.isTerminalCheckpoint) {
      return {
        action: "throw",
        kind: "terminal",
        message: "Turn reached a terminal checkpoint; not resuming automatically.",
        detail: "ineligible_terminal_turn",
        isRetryable: false,
      };
    }
    // No-progress guard (OBSERVED): resume attempts streaming but not
    // producing checkpoints.
    if (this.noProgressResumeFailures >= NO_PROGRESS_RESUME_LIMIT) {
      return {
        action: "throw",
        kind: "no_progress",
        message: RETRY_NO_PROGRESS_MESSAGE,
        detail: RETRY_NO_PROGRESS_DETAIL,
        isRetryable: true,
      };
    }

    let category = classifyStreamError(info.kind);
    if (category === "by_signature") {
      category = isTransportErrorSignature(info.rawError) ? "transport" : "server";
    }

    // Stall aborts count as transport; stall retries stop after 180s cumulative.
    if (info.kind === "stall") {
      this.stallElapsedMs += info.stallDurationMs ?? 0;
      if (this.stallElapsedMs >= STALL_RETRY_BUDGET_MS) {
        return {
          action: "throw",
          kind: "stall_budget",
          message: "Stream stalled repeatedly; stall retry budget (180s) exhausted.",
          detail: `stallRetryElapsedMs=${this.stallElapsedMs} >= 180000`,
          isRetryable: true,
        };
      }
    }

    const count = category === "server" ? this.serverErrors : this.transportErrors;
    const cap = category === "server" ? this.serverCap : this.transportCap;
    if (!this.endlessRetries && this.enableAgentRetries && count >= cap) {
      const server = category === "server";
      return {
        action: "throw",
        kind: "exhausted",
        message: server ? RETRY_EXHAUSTED_SERVER_MESSAGE : RETRY_EXHAUSTED_CONNECTION_MESSAGE,
        detail: server
          ? RETRY_EXHAUSTED_SERVER_DETAIL.replace("N", String(count))
          : RETRY_EXHAUSTED_CONNECTION_DETAIL.replace("N", String(count)),
        isRetryable: true,
      };
    }

    if (category === "server") {
      this.serverErrors += 1;
    } else {
      this.transportErrors += 1;
    }
    const attempt = category === "server" ? this.serverErrors : this.transportErrors;
    let delay = computeBackoffMs(attempt - 1, {
      isTest: this.isTest,
      fixedDelayMs: this.fixedDelayMs,
      random: this.random,
    });
    // One category caps at min(300000, 3x computed) (OBSERVED).
    delay = Math.min(delay, RETRY_PER_CATEGORY_CAP_MS);
    const waitingForRetryAfter =
      info.retryAfterMs !== undefined && info.retryAfterMs > 0;
    delay = selectDelayMs(delay, info.retryAfterMs, this.random);
    if (this.endlessRetries) {
      this.log?.(`[retry] Endless retry delay selected (category=${category}, attempt=${attempt}, delayMs=${Math.round(delay)})`);
    }
    if (waitingForRetryAfter) {
      this.log?.(`[retry] Waiting for Retry-After (attempt=${attempt}, retryAfterMs=${info.retryAfterMs}, selectedDelayMs=${Math.round(delay)})`);
    }
    return { action: "retry", delayMs: delay, category, attempt, waitingForRetryAfter };
  }

  /**
   * Abortable backoff sleep (OBSERVED: "Cancelled during backoff").
   * Rejects when the signal aborts.
   */
  abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("Cancelled during backoff"));
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      // A backoff timer must not keep the extension host alive on its own.
      (timer as unknown as { unref?: () => void }).unref?.();
      const onAbort = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(new Error("Cancelled during backoff"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

// ============================================================================
// DD-AR-3: resume-from-checkpoint on retry
// ============================================================================

/**
 * Cursor's resumeAction: the next attempt sends the checkpoint state instead
 * of restarting the request (OBSERVED, host 1689162/1711177).
 * originalRequestId is kept across attempts; each attempt gets a new
 * attemptRequestId (OBSERVED).
 */
export interface ResumeAction {
  type: "resume";
  checkpointId: string;
  originalRequestId: string;
  attemptRequestId: string;
}

export class ResumeStateTracker {
  private lastCheckpointId?: string;
  private failures = 0;

  /** Record the latest checkpoint received before the retryable error. */
  recordCheckpoint(checkpointId: string | undefined): void {
    if (checkpointId) {
      this.lastCheckpointId = checkpointId;
    }
  }

  get checkpointId(): string | undefined {
    return this.lastCheckpointId;
  }

  /**
   * Build the resumeAction for the next attempt. Returns undefined when no
   * checkpoint was received — the attempt then restarts the request.
   */
  buildResumeAction(originalRequestId: string, attemptRequestId: string): ResumeAction | undefined {
    if (!this.lastCheckpointId) {
      return undefined;
    }
    return {
      type: "resume",
      checkpointId: this.lastCheckpointId,
      originalRequestId,
      attemptRequestId,
    };
  }

  /** Cursor: "Resume attempts are streaming but not producing checkpoints". */
  recordResumeOutcome(hadProgress: boolean): void {
    if (hadProgress) {
      this.failures = 0;
    } else {
      this.failures += 1;
    }
  }

  get noProgressResumeFailures(): number {
    return this.failures;
  }

  shouldStopNoProgress(): boolean {
    return this.failures >= NO_PROGRESS_RESUME_LIMIT;
  }
}

// ============================================================================
// DD-AR-4: blocking summarization (3 triggers + WaitForCompletion + orphan hold)
// ============================================================================

export type SummarizationTrigger = "token_limit" | "image_limit" | "threshold";

/** Orphaned summary hold: 300,000 ms (5 min) default (OBSERVED, host `??3e5`). */
export const ORPHANED_SUMMARY_HOLD_MS = 300_000;
/** Proactive threshold config: tokenUsageThresholdPercentage = 70 (OBSERVED). */
export const SUMMARIZATION_THRESHOLD_PERCENT = 70;

export interface Summarizer {
  summarize(trigger: SummarizationTrigger): Promise<void>;
}

export interface BlockingSummarizerOptions {
  summarize?: (trigger: SummarizationTrigger) => Promise<void>;
  /** Override for tests; default ORPHANED_SUMMARY_HOLD_MS. */
  orphanHoldMs?: number;
  log?: (msg: string) => void;
}

/**
 * Blocking summarization coordinator (OBSERVED mechanism, host 1718771-area).
 *
 * Three triggers (token-limit error, image-limit error, configured
 * threshold) all run summarization BLOCKING with
 * backgroundSummarizationMode: WaitForCompletion — the turn parks until the
 * summary completes. If the turn ends while a summary is still in flight,
 * the attempt is parked for the orphaned-summary hold (5 min).
 *
 * HONEST-DIVERGENCE: our engine owns context compaction server-side; the
 * client-side summarizer callback is pluggable and unbound by default. The
 * trigger detection + WaitForCompletion parking + orphan hold are real.
 */
export class BlockingSummarizer {
  private inFlight:
    | { trigger: SummarizationTrigger; promise: Promise<void>; settled: boolean }
    | undefined;
  private orphanTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly orphanHoldMs: number;
  private readonly summarize?: (trigger: SummarizationTrigger) => Promise<void>;
  private readonly log?: (msg: string) => void;

  constructor(opts: BlockingSummarizerOptions = {}) {
    this.summarize = opts.summarize;
    this.orphanHoldMs = opts.orphanHoldMs ?? ORPHANED_SUMMARY_HOLD_MS;
    this.log = opts.log;
  }

  isSummarizing(): boolean {
    return !!this.inFlight && !this.inFlight.settled;
  }

  get currentTrigger(): SummarizationTrigger | undefined {
    return this.inFlight?.trigger;
  }

  /**
   * Request blocking summarization. Concurrent callers join the in-flight
   * summary (one summarization at a time). The returned promise resolves
   * only when the summary completes — WaitForCompletion parking.
   */
  request(trigger: SummarizationTrigger, onComplete?: () => void): Promise<void> {
    if (this.inFlight) {
      const existing = this.inFlight.promise;
      return onComplete ? existing.then(onComplete, onComplete) : existing;
    }
    let resolvePromise!: () => void;
    const promise = new Promise<void>((resolve) => {
      resolvePromise = resolve;
    });
    const current = { trigger, promise, settled: false };
    this.inFlight = current;
    this.log?.(`[summarization-trigger] running blocking summarization (${trigger}) — parking turn (WaitForCompletion)`);
    void (async () => {
      try {
        if (this.summarize) {
          await this.summarize(trigger);
        } else {
          this.log?.(
            `[summarization-trigger] no summarizer bound for "${trigger}" — continuing without compaction`,
          );
        }
      } catch (err) {
        // A failed summary must not wedge the turn; log and continue.
        this.log?.(
          `[summarization-trigger] summarization failed: ${err instanceof Error ? err.message : err} — continuing`,
        );
      } finally {
        current.settled = true;
        if (this.inFlight === current) {
          this.inFlight = undefined;
        }
        this.clearOrphanHold();
        try {
          onComplete?.();
        } catch {
          /* onComplete is informational */
        }
        resolvePromise();
      }
    })();
    return promise;
  }

  /**
   * Turn ended while a summary was in flight: park the orphan hold
   * (ORPHANED_SUMMARY_HOLD_MS). The hold is cleared when the summary
   * completes.
   */
  markTurnEnded(): void {
    if (this.isSummarizing() && !this.orphanTimer) {
      this.log?.(
        `[summarization-trigger] turn ended with summarization in flight — orphan hold ${this.orphanHoldMs}ms`,
      );
      this.orphanTimer = setTimeout(() => {
        this.orphanTimer = undefined;
      }, this.orphanHoldMs);
      (this.orphanTimer as unknown as { unref?: () => void }).unref?.();
    }
  }

  /** Resolves when the in-flight summary completes or the orphan hold expires, whichever first. */
  waitForOrphanHold(): Promise<void> {
    const current = this.inFlight;
    if (!current) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), this.orphanHoldMs);
      (timer as unknown as { unref?: () => void }).unref?.();
      const done = (): void => {
        clearTimeout(timer);
        resolve();
      };
      void current.promise.then(done, done);
    });
  }

  private clearOrphanHold(): void {
    if (this.orphanTimer) {
      clearTimeout(this.orphanTimer);
      this.orphanTimer = undefined;
    }
  }
}

/**
 * Detect a blocking-summarization trigger from an engine error message.
 * Pure; unit-tested. The proactive "threshold" trigger is engine-measured
 * (tokenUsageThresholdPercentage = 70, server-side) — not detectable here.
 */
export function detectSummarizationTrigger(message: string): SummarizationTrigger | undefined {
  const m = message.toLowerCase();
  if (/\bimages?\b/.test(m) && /\blimit\b|too many/.test(m)) {
    return "image_limit";
  }
  if (/\btoken\b|context window|context limit|too many|maximum context|context_length/.test(m)) {
    return "token_limit";
  }
  return undefined;
}

// ============================================================================
// DD-AR-5: tool error taxonomy + triple messages + redaction markers
// ============================================================================

/**
 * Tool error classification enum (exec main.js, 14 values, OBSERVED verbatim).
 */
export enum ToolErrorClass {
  ABORTED = "ABORTED",
  BAD_USER_DEVICE_STATE = "BAD_USER_DEVICE_STATE",
  CONTENT_REFUSED = "CONTENT_REFUSED",
  EXEC_BACKEND_UNAVAILABLE = "EXEC_BACKEND_UNAVAILABLE",
  HOOK_DENIED = "HOOK_DENIED",
  INVALID_ARGS = "INVALID_ARGS",
  INVALID_OUTPUT_NOTIFICATION = "INVALID_OUTPUT_NOTIFICATION",
  MCP_AUTH_ERROR = "MCP_AUTH_ERROR",
  NOOP = "NOOP",
  OTHER_ERROR = "OTHER_ERROR",
  PROVIDER_ERROR = "PROVIDER_ERROR",
  TIMEOUT = "TIMEOUT",
  UNEXPECTED_ENVIRONMENT = "UNEXPECTED_ENVIRONMENT",
  USER_REJECTED = "USER_REJECTED",
}

/** Tool-output redaction markers in prompts (exec, offset 2410300-area, OBSERVED). */
export const REDACTED_TOOL_OUTPUT_BEGIN = "<|redacted_tool_output_begin|>";
export const REDACTED_TOOL_OUTPUT_END = "<|redacted_tool_output_end|>";
export const REDACTED_TOOL_SEP = "<|redacted_tool_sep|>";

/** Wrap tool output in Cursor's redaction markers. */
export function redactToolOutput(text: string): string {
  return `${REDACTED_TOOL_OUTPUT_BEGIN}${text}${REDACTED_TOOL_OUTPUT_END}`;
}

export function classifyToolError(err: unknown): ToolErrorClass {
  const name = err instanceof Error ? err.name : "";
  const code = (err as { code?: unknown } | null)?.code;
  const raw = err instanceof Error ? err.message : String(err ?? "");
  const m = raw.toLowerCase();
  if (name === "AbortError" || code === "ABORT_ERR" || m.includes("aborted")) {
    return ToolErrorClass.ABORTED;
  }
  if (
    name === "TimeoutError" ||
    code === "ETIMEDOUT" ||
    code === "ECONNABORTED" ||
    m.includes("timed out") ||
    m.includes("timeout")
  ) {
    return ToolErrorClass.TIMEOUT;
  }
  if (m.includes("hook denied") || m.includes("denied by hook") || m.includes("blocked by hook")) {
    return ToolErrorClass.HOOK_DENIED;
  }
  if (m.includes("rejected by user") || m.includes("user rejected") || m.includes("user denied")) {
    return ToolErrorClass.USER_REJECTED;
  }
  if (m.includes("invalid arg") || m.includes("validation failed") || m.includes("invalid input")) {
    return ToolErrorClass.INVALID_ARGS;
  }
  if (m.includes("mcp") && m.includes("auth")) {
    return ToolErrorClass.MCP_AUTH_ERROR;
  }
  if (m.includes("content refused") || m.includes("refusal")) {
    return ToolErrorClass.CONTENT_REFUSED;
  }
  if (m.includes("backend unavailable") || m.includes("exec backend")) {
    return ToolErrorClass.EXEC_BACKEND_UNAVAILABLE;
  }
  if (m.includes("provider error") || m.includes("providererror")) {
    return ToolErrorClass.PROVIDER_ERROR;
  }
  if (m.includes("noop") || m.includes("no-op")) {
    return ToolErrorClass.NOOP;
  }
  if (m.includes("invalid output")) {
    return ToolErrorClass.INVALID_OUTPUT_NOTIFICATION;
  }
  if (code === "ENOENT" || m.includes("unexpected environment") || m.includes("environment")) {
    return ToolErrorClass.UNEXPECTED_ENVIRONMENT;
  }
  if (m.includes("device state")) {
    return ToolErrorClass.BAD_USER_DEVICE_STATE;
  }
  return ToolErrorClass.OTHER_ERROR;
}

export interface ToolErrorMessages {
  /** Internal error text (logs). */
  error: string;
  /** Shown in the UI card. */
  clientVisibleErrorMessage: string;
  /** Sent to the model — sanitized, never raw output. */
  modelVisibleErrorMessage: string;
  /** Extra guidance appended for the model. */
  systemReminders: string[];
  classification: ToolErrorClass;
}

const TOOL_ERROR_CLIENT_MESSAGES: Record<ToolErrorClass, string> = {
  [ToolErrorClass.ABORTED]: "The tool call was aborted.",
  [ToolErrorClass.BAD_USER_DEVICE_STATE]: "The tool call failed because of device state.",
  [ToolErrorClass.CONTENT_REFUSED]: "The tool refused the content.",
  [ToolErrorClass.EXEC_BACKEND_UNAVAILABLE]: "The execution backend is unavailable.",
  [ToolErrorClass.HOOK_DENIED]: "Blocked by a hook.",
  [ToolErrorClass.INVALID_ARGS]: "The tool was called with invalid arguments.",
  [ToolErrorClass.INVALID_OUTPUT_NOTIFICATION]: "The tool produced an invalid output notification.",
  [ToolErrorClass.MCP_AUTH_ERROR]: "MCP authentication failed.",
  [ToolErrorClass.NOOP]: "The tool call was a no-op.",
  [ToolErrorClass.OTHER_ERROR]: "The tool call failed.",
  [ToolErrorClass.PROVIDER_ERROR]: "The model provider returned an error.",
  [ToolErrorClass.TIMEOUT]: "The tool call timed out.",
  [ToolErrorClass.UNEXPECTED_ENVIRONMENT]: "The tool failed because of an unexpected environment.",
  [ToolErrorClass.USER_REJECTED]: "Rejected.",
};

const TOOL_ERROR_MODEL_MESSAGES: Record<ToolErrorClass, string> = {
  [ToolErrorClass.ABORTED]: "The previous tool call was aborted. Do not retry it unless asked.",
  [ToolErrorClass.BAD_USER_DEVICE_STATE]: "The previous tool call failed because of device state.",
  [ToolErrorClass.CONTENT_REFUSED]: "The previous tool call refused the content. Reformulate the request.",
  [ToolErrorClass.EXEC_BACKEND_UNAVAILABLE]: "The execution backend is unavailable. Try again later.",
  [ToolErrorClass.HOOK_DENIED]: "The previous tool call was denied by a hook. Do not retry the identical call.",
  [ToolErrorClass.INVALID_ARGS]: "The previous tool call had invalid arguments. Fix the arguments before retrying.",
  [ToolErrorClass.INVALID_OUTPUT_NOTIFICATION]: "The previous tool call produced an invalid output notification.",
  [ToolErrorClass.MCP_AUTH_ERROR]: "MCP authentication failed. The user must re-authenticate before retrying.",
  [ToolErrorClass.NOOP]: "The previous tool call was a no-op. It did not change anything.",
  [ToolErrorClass.OTHER_ERROR]: "The previous tool call failed.",
  [ToolErrorClass.PROVIDER_ERROR]: "The model provider returned an error for the previous tool call.",
  [ToolErrorClass.TIMEOUT]: "The previous tool call timed out. Retry with a narrower scope; do not repeat the identical call.",
  [ToolErrorClass.UNEXPECTED_ENVIRONMENT]: "The previous tool call failed because of an unexpected environment.",
  [ToolErrorClass.USER_REJECTED]: "The user rejected the previous tool call. Do not retry it.",
};

const TOOL_ERROR_SYSTEM_REMINDERS: Partial<Record<ToolErrorClass, string[]>> = {
  [ToolErrorClass.TIMEOUT]: ["Do not repeat the identical timed-out tool call without changing its parameters."],
  [ToolErrorClass.HOOK_DENIED]: ["A denied tool call must not be retried with the same arguments."],
  [ToolErrorClass.USER_REJECTED]: ["A user-rejected tool call must not be retried."],
  [ToolErrorClass.INVALID_ARGS]: ["Re-read the tool schema before retrying with corrected arguments."],
};

/**
 * Format a tool failure into Cursor's triple-message shape.
 *
 * HONEST-DIVERGENCE: our engine executes tools server-side and formats the
 * model-visible result itself — the extension cannot inject
 * modelVisibleErrorMessage into the model's context. The triple is produced
 * here for the UI card (clientVisibleErrorMessage), logs (error), and any
 * future engine protocol that accepts classified errors.
 */
export function formatToolError(err: unknown, toolName?: string): ToolErrorMessages {
  const classification = classifyToolError(err);
  const raw = err instanceof Error ? err.message : String(err ?? "tool failed");
  const error = toolName ? `${toolName}: ${raw}` : raw;
  const clientVisibleErrorMessage = TOOL_ERROR_CLIENT_MESSAGES[classification];
  const excerpt = raw.length > 500 ? `${raw.slice(0, 500)}…` : raw;
  const modelVisibleErrorMessage =
    `${TOOL_ERROR_MODEL_MESSAGES[classification]}` +
    (raw ? ` Tool output: ${redactToolOutput(excerpt)}` : "");
  return {
    error,
    clientVisibleErrorMessage,
    modelVisibleErrorMessage,
    systemReminders: TOOL_ERROR_SYSTEM_REMINDERS[classification] ?? [],
    classification,
  };
}

// ============================================================================
// DD-AR-6: server-driven model fallback
// ============================================================================

export type FallbackTrigger = "UNSPECIFIED" | "ON_SELECT" | "ON_ERROR";

/**
 * InferenceProviderWarning proto (OBSERVED): {message, affected_models*,
 * fallback_model?, trigger} where trigger ∈ UNSPECIFIED | ON_SELECT | ON_ERROR.
 */
export interface InferenceProviderWarning {
  message: string;
  affectedModels: string[];
  fallbackModel?: string;
  trigger: FallbackTrigger;
}

/**
 * AvailableModelsResponse.FeatureModelConfig (OBSERVED): {default_model,
 * fallback_models*, best_of_n_default_models*} — server-driven per-feature
 * fallback list.
 */
export interface FeatureModelConfig {
  defaultModel: string;
  fallbackModels: string[];
  bestOfNDefaultModels: string[];
}

/** Cursor's dynamic-config rate-limit message (OBSERVED verbatim). */
export const RATE_LIMITED_RECONNECT_MESSAGE = "Rate limited by model provider, retrying…";

export interface ModelFallbackManagerOptions {
  getFeatureConfig?: () => FeatureModelConfig | undefined;
  log?: (msg: string) => void;
}

/**
 * Client-side model-fallback protocol.
 *
 * HONEST-DIVERGENCE: in Cursor this is SERVER-driven — the server ships
 * FeatureModelConfig.fallback_models and InferenceProviderWarning messages.
 * Our engine declares no fallback_models, so the manager consumes the
 * client-configured list (`ide.agent.fallbackModels`) in the same shape
 * until the engine declares its own. The warning/trigger protocol is
 * implemented exactly; only the source of the list differs.
 */
export class ModelFallbackManager {
  private readonly getFeatureConfig?: () => FeatureModelConfig | undefined;
  private readonly log?: (msg: string) => void;
  private fallbackWarningsShown = 0;

  constructor(opts: ModelFallbackManagerOptions = {}) {
    this.getFeatureConfig = opts.getFeatureConfig;
    this.log = opts.log;
  }

  /** Build the ON_ERROR warning Cursor's server sends on rate-limit/provider error. */
  buildRateLimitWarning(modelId: string): InferenceProviderWarning {
    const cfg = this.getFeatureConfig?.();
    const fallbackModel = cfg?.fallbackModels?.[0];
    return {
      message: RATE_LIMITED_RECONNECT_MESSAGE,
      affectedModels: [modelId],
      ...(fallbackModel ? { fallbackModel } : {}),
      trigger: "ON_ERROR",
    };
  }

  /** Build the ON_SELECT warning shown at picker time. */
  buildSelectWarning(modelId: string): InferenceProviderWarning {
    const cfg = this.getFeatureConfig?.();
    const fallbackModel = cfg?.fallbackModels?.[0];
    return {
      message: `Model ${modelId} may be rate-limited; a fallback is configured.`,
      affectedModels: [modelId],
      ...(fallbackModel ? { fallbackModel } : {}),
      trigger: "ON_SELECT",
    };
  }

  /** Resolve the fallback model id from a warning (telemetry: number_of_times_shown_fallback_model_warning). */
  resolveFallback(warning: InferenceProviderWarning): string | undefined {
    if (warning.fallbackModel) {
      this.fallbackWarningsShown += 1;
      this.log?.(
        `[model-fallback] warning shown (${this.fallbackWarningsShown}x): trigger=${warning.trigger} fallback=${warning.fallbackModel}`,
      );
    }
    return warning.fallbackModel;
  }

  get warningsShown(): number {
    return this.fallbackWarningsShown;
  }
}

// ============================================================================
// DD-AR-7: single-message loop detection (retry_once policy)
// ============================================================================

/** Cursor's single-message loop policy name (OBSERVED, host 2592170). */
export const SINGLE_MESSAGE_LOOP_POLICY = "retry_once" as const;
/** Consecutive identical fingerprints before the detector fires (our calibration — the binary only names the policy). */
export const LOOP_REPETITIONS_THRESHOLD = 3;

export type LoopKind = "single_message_multi_line" | "single_message_reasoning_single_line";

/**
 * LoopDetectedError (OBSERVED shape, host 2651077):
 * {loopType: "singleMessage", loopKind, repetitions, period, evidenceFingerprint}.
 */
export class LoopDetectedError extends Error {
  readonly loopType = "singleMessage" as const;
  readonly loopKind: LoopKind;
  readonly repetitions: number;
  readonly evidenceFingerprint: string;

  constructor(loopKind: LoopKind, repetitions: number, evidenceFingerprint: string) {
    super(
      `Single-message loop detected (${loopKind}): identical input repeated ${repetitions}x (fingerprint ${evidenceFingerprint}).`,
    );
    this.name = "LoopDetectedError";
    this.loopKind = loopKind;
    this.repetitions = repetitions;
    this.evidenceFingerprint = evidenceFingerprint;
  }
}

/** FNV-1a 32-bit rolling hash. */
export function fnv1aHash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export type LoopObserveKind = "tool_args" | "reasoning";

/**
 * Single-message loop detector (OBSERVED mechanism, host 2592170/2651077).
 * Runs on outbound tool-call args and the reasoning channel; with the
 * `retry_once` policy the turn is retried once, then the LoopDetectedError
 * surfaces.
 */
export class SingleMessageLoopDetector {
  private lastFingerprint?: number;
  private consecutive = 0;
  private readonly repetitions: number;

  constructor(repetitions: number = LOOP_REPETITIONS_THRESHOLD) {
    this.repetitions = repetitions;
  }

  /**
   * Observe one message. Throws LoopDetectedError when the same fingerprint
   * repeats `repetitions` times consecutively. A different message resets
   * the counter (rolling detection).
   */
  observe(kind: LoopObserveKind, text: string): void {
    const fingerprint = fnv1aHash(text);
    if (fingerprint === this.lastFingerprint) {
      this.consecutive += 1;
    } else {
      this.lastFingerprint = fingerprint;
      this.consecutive = 1;
    }
    if (this.consecutive >= this.repetitions) {
      const loopKind: LoopKind =
        kind === "tool_args" ? "single_message_multi_line" : "single_message_reasoning_single_line";
      throw new LoopDetectedError(
        loopKind,
        this.consecutive,
        fingerprint.toString(16).padStart(8, "0"),
      );
    }
  }

  reset(): void {
    this.lastFingerprint = undefined;
    this.consecutive = 0;
  }
}

// ============================================================================
// DD-AR-8: shadow-mode approval protocol
// ============================================================================

export interface ShadowClassifierInput {
  action: string;
  resources: string[];
}

export type ShadowClassifierMode = "shadow" | "enforce";
export type ShadowVerdict = "allow" | "block";

export interface ShadowClassifierResult {
  decision: ShadowVerdict;
  latencyMs: number;
  error?: string;
}

/**
 * Shadow-mode approval protocol (OBSERVED mechanism, exec 3933528/3940935).
 *
 * When approval is not enforced but shadow mode is on, Cursor runs the SAME
 * classifier invocation with the mode flag "shadow" instead of "enforce" —
 * fire-and-forget: the verdict is logged via telemetry
 * (trackSmartModeClassifierCall) but NEVER blocks; errors are swallowed and
 * the result is always allow.
 *
 * HONEST-DIVERGENCE: Cursor's classifier is a server-side model; ours is a
 * client-side heuristic (see the adapter's evaluateShadowVerdict) run for
 * eval/telemetry until a server classifier exists. The fire-and-forget
 * "shadow"-vs-"enforce" protocol shape is implemented exactly.
 */
export function runShadowClassifier(
  input: ShadowClassifierInput,
  classify: (mode: ShadowClassifierMode) => Promise<ShadowVerdict> | ShadowVerdict,
  log: (result: ShadowClassifierResult, input: ShadowClassifierInput) => void,
): void {
  const started = Date.now();
  // Fire-and-forget async IIFE: result discarded except for telemetry;
  // errors swallowed; the turn always proceeds (allow).
  void (async () => {
    try {
      const decision = await classify("shadow");
      log({ decision, latencyMs: Date.now() - started }, input);
    } catch (err) {
      log(
        {
          decision: "allow",
          latencyMs: Date.now() - started,
          error: err instanceof Error ? err.message : String(err),
        },
        input,
      );
    }
  })();
}

// ============================================================================
// DD-AR-9: turnSettled protocol
// ============================================================================

export class MaxStepsReachedError extends Error {
  constructor() {
    super("Max steps reached");
    this.name = "MaxStepsReachedError";
  }
}

/**
 * Build a turnSettled mailbox event (OBSERVED shape, host 2402900-area):
 * turnSettled{turnId, outcome, detail?, interruptedBy?, stopReason?, error?}
 * where outcome ∈ COMPLETED | FAILED | INTERRUPTED.
 */
export function buildTurnSettled(
  turnId: string,
  outcome: TurnOutcome,
  opts: { bubbleId: string; interruptedBy?: TurnInterruptedBy; stopReason?: TurnStopReason; error?: string } = {
    bubbleId: "",
  },
): TurnSettled {
  return {
    type: "turnSettled",
    turnId,
    bubbleId: opts.bubbleId,
    outcome,
    ...(opts.interruptedBy ? { interruptedBy: opts.interruptedBy } : {}),
    ...(opts.stopReason ? { stopReason: opts.stopReason } : {}),
    ...(opts.error ? { error: opts.error } : {}),
  };
}

/**
 * appendTurnSettledByError (OBSERVED): MaxStepsReachedError -> INTERRUPTED +
 * stopReason MAX_STEPS_REACHED; other errors -> FAILED.
 */
export function appendTurnSettledByError(
  turnId: string,
  bubbleId: string,
  err: unknown,
): TurnSettled {
  if (err instanceof MaxStepsReachedError) {
    return buildTurnSettled(turnId, "INTERRUPTED", {
      bubbleId,
      stopReason: "MAX_STEPS_REACHED",
      error: err.message,
    });
  }
  return buildTurnSettled(turnId, "FAILED", {
    bubbleId,
    error: err instanceof Error ? err.message : String(err),
  });
}
