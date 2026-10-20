/**
 * backgroundSummarizer.ts — Cursor 3.25.9 parity: BACKGROUND conversation summarization.
 *
 * Evidence (parent-verified 2026-10-19, not re-derived here):
 * - Binary telemetry (dig-ast-ext-2026-10-19): the event family
 *   `agent.background_summarization.{started,stashed,pending_adoption,persisted,discarded,time_saved_ms}`
 *   — lifecycle started → stashed → pending_adoption → persisted/discarded,
 *   measuring `time_saved_ms`.
 * - cursor.com/docs/agent/prompting: "When the window gets close to full,
 *   Cursor compresses older parts of the conversation into a summary to leave
 *   more room for new conversation." + the context-ring category
 *   "Summarized conversation: compressed summaries of earlier turns".
 *
 * This is the key difference from BlockingSummarizer (agentRuntime.ts DD-AR-4):
 * background summarization NEVER parks the turn. The blocking path is kept
 * for hard token_limit / image_limit errors (Cursor's
 * backgroundSummarizationMode: WaitForCompletion); this module handles the
 * proactive ≥70% threshold (SUMMARIZATION_THRESHOLD_PERCENT, observed) as a
 * fire-and-forget background job whose result is adopted at the turn boundary.
 *
 * HONEST-DIVERGENCE: Cursor's summarizer is server-side — its exact prompt,
 * adoption policy, and context-window accounting are UNKNOWN (marked below).
 * Ours runs client-side: the adapter observes the SSE transcript
 * (TranscriptTracker) and generates the summary through the engine's
 * tool-free, history-free `session.generate` endpoint
 * (POST /api/session/:id/generate — "Generate transient text from the current
 * session context without mutating session history", the same endpoint Tab
 * completion uses). The lifecycle states and verbatim telemetry event names
 * mirror the binary's telemetry family.
 *
 * Telemetry channel note (codebase convention, cf. inlineEditService.ts
 * INLINE_EDIT_TELEMETRY): this codebase has no telemetry backend, so the
 * verbatim event names are recorded into an in-memory log (getTelemetryLog)
 * and mirrored as structured lines on the injected log sink (the adapter
 * wires that to the extension's [ide-agent] output channel). The names are
 * kept verbatim so a future backend sends exactly what Cursor sends.
 */

import { SummarizationTrigger, SUMMARIZATION_THRESHOLD_PERCENT } from "./agentRuntime";

/** Verbatim Cursor telemetry event names (binary, dig-ast-ext-2026-10-19). */
export const BACKGROUND_SUMMARIZATION_TELEMETRY = {
  started: "agent.background_summarization.started",
  stashed: "agent.background_summarization.stashed",
  pending_adoption: "agent.background_summarization.pending_adoption",
  persisted: "agent.background_summarization.persisted",
  discarded: "agent.background_summarization.discarded",
} as const;

/** Verbatim telemetry field name (binary). Measured, never estimated. */
export const TIME_SAVED_MS_FIELD = "time_saved_ms";

/** Internal lifecycle states. The telemetry-visible ones are started / stashed / pending_adoption / persisted / discarded. */
export type BackgroundSummaryStatus =
  | "idle"
  | "generating"
  | "stashed"
  | "pending_adoption"
  | "persisted"
  | "discarded";

/** One entry of the in-memory verbatim-telemetry log. */
export interface BackgroundSummarizationTelemetryEntry {
  event: string;
  at: number;
  data: Record<string, unknown>;
}

/** Chars-per-token heuristic for the client-side context estimate. Local estimate, UNKNOWN vs Cursor. */
export const CHARS_PER_TOKEN = 4;

/**
 * Estimated context-window size (tokens) used for the 70% threshold when the
 * engine does not report the model's real context window on this wire.
 * Local estimate — UNKNOWN vs Cursor's exact accounting.
 */
export const DEFAULT_BACKGROUND_SUMMARY_CONTEXT_WINDOW_TOKENS = 200_000;

/** Cap on the transcript handed to the summarizer (chars). Local choice — Cursor's cap is UNKNOWN. */
export const MAX_TRANSCRIPT_CHARS = 48_000;

/** Timeout for the background summary `session.generate` call (ms). Local choice; api() defaults to 30s. */
export const BACKGROUND_SUMMARY_GENERATE_TIMEOUT_MS = 120_000;

/** Estimate tokens from observed chars. Heuristic (chars/4); the engine reports no token counts on this wire. */
export function estimateTokensFromChars(chars: number): number {
  return Math.ceil(Math.max(0, chars) / CHARS_PER_TOKEN);
}

/**
 * The proactive 70% trigger check. Pure; unit-tested.
 * threshold = contextWindowTokens * SUMMARIZATION_THRESHOLD_PERCENT / 100 (observed = 70).
 */
export function meetsBackgroundSummaryThreshold(
  estimatedTokens: number,
  contextWindowTokens: number,
): boolean {
  if (!(contextWindowTokens > 0)) {
    return false;
  }
  return estimatedTokens >= (contextWindowTokens * SUMMARIZATION_THRESHOLD_PERCENT) / 100;
}

/** Input to one background summary generation. */
export interface SummaryGenerationInput {
  /** Observed transcript (capped at MAX_TRANSCRIPT_CHARS, oldest dropped first). */
  transcript: string;
  trigger: SummarizationTrigger;
  /** Turn ids covered by this transcript (marked compacted on adoption). */
  turnIds: string[];
  estimatedTokens: number;
  /** True when the transcript was truncated to the cap. */
  truncated: boolean;
}

/** The adopted (persisted) summary record. */
export interface BackgroundSummaryResult {
  text: string;
  trigger: SummarizationTrigger;
  startedAt: number;
  stashedAt: number;
  /** Real measured wall-clock the turn kept running while the summary generated in background. */
  timeSavedMs: number;
  transcriptChars: number;
  turnIds: string[];
}

export interface BackgroundSummarizerOptions {
  /**
   * REAL summary generation. Must perform the actual LLM call (the adapter
   * wires the engine's session.generate endpoint) and REJECT when the engine
   * is unreachable. It must NEVER resolve with fabricated text — the
   * summarizer drops the generation on rejection instead of inventing one.
   */
  generate: (input: SummaryGenerationInput) => Promise<string>;
  /**
   * Observational pre-compact hook. Called (awaited, errors swallowed)
   * between pending_adoption and persisted; it can observe but NEVER blocks
   * or redirects adoption. The adapter wires runHooks('preCompact', ...).
   */
  preCompact?: (extras: Record<string, unknown>) => Promise<unknown>;
  /** Line sink for structured telemetry lines (adapter: [ide-agent] output channel). */
  log?: (msg: string) => void;
  /** Clock override for tests. */
  now?: () => number;
}

/**
 * Background summarization coordinator — the non-parking counterpart to
 * BlockingSummarizer.
 *
 * Lifecycle (mirrors the binary telemetry family):
 *   start()            → emits `started`, runs generate() WITHOUT parking the turn
 *   generate resolves  → `stashed` (+ time_saved_ms, measured)
 *   onTurnBoundary()   → `pending_adoption`, preCompact hooks (observational), `persisted`
 *   superseded         → `discarded` (a newer start() replaces an in-flight /
 *                        stashed / pending_adoption record; only the latest
 *                        generation can be adopted)
 *   generate rejects   → back to `idle`, logged, never fabricated
 */
export class BackgroundSummarizer {
  private readonly generate: (input: SummaryGenerationInput) => Promise<string>;
  private readonly preCompact?: (extras: Record<string, unknown>) => Promise<unknown>;
  private readonly log?: (msg: string) => void;
  private readonly now: () => number;

  private status: BackgroundSummaryStatus = "idle";
  /** Monotonic generation counter; only the latest generation may be adopted (supersede guard). */
  private generation = 0;
  private activeGeneration = 0;
  private startedAt = 0;
  private stashed?: BackgroundSummaryResult;
  private lastAdopted?: BackgroundSummaryResult;
  private readonly compactedTurnIds: string[] = [];
  private readonly telemetryLog: BackgroundSummarizationTelemetryEntry[] = [];

  constructor(opts: BackgroundSummarizerOptions) {
    this.generate = opts.generate;
    this.preCompact = opts.preCompact;
    this.log = opts.log;
    this.now = opts.now ?? Date.now;
  }

  get currentStatus(): BackgroundSummaryStatus {
    return this.status;
  }

  /** In-memory log of verbatim Cursor telemetry event names (+ payloads). */
  getTelemetryLog(): ReadonlyArray<BackgroundSummarizationTelemetryEntry> {
    return [...this.telemetryLog];
  }

  /** The currently stashed (not yet adopted) summary, if any. */
  getStashedSummary(): BackgroundSummaryResult | undefined {
    return this.stashed;
  }

  /** The most recently adopted summary, if any. */
  getLastAdoptedSummary(): BackgroundSummaryResult | undefined {
    return this.lastAdopted;
  }

  /**
   * Fresh chat: drop stashed/adopted summaries and return to idle so the
   * context ring's "Summarized conversation" category restarts at honest 0.
   * The telemetry log is kept (diagnostic history, not user-facing figures).
   */
  reset(): void {
    this.status = "idle";
    this.stashed = undefined;
    this.lastAdopted = undefined;
    this.compactedTurnIds.length = 0;
    this.generation = 0;
    this.activeGeneration = 0;
    this.startedAt = 0;
  }

  /** Turn ids whose transcript has been compacted by an adopted summary. */
  getCompactedTurnIds(): string[] {
    return [...this.compactedTurnIds];
  }

  private emit(event: string, data: Record<string, unknown> = {}): void {
    const entry: BackgroundSummarizationTelemetryEntry = { event, at: this.now(), data };
    this.telemetryLog.push(entry);
    try {
      this.log?.(`[bg-summarization] ${event} ${JSON.stringify(data)}`);
    } catch {
      /* logging must never break summarization */
    }
  }

  /**
   * Start a background summary. Fire-and-forget: returns immediately, the
   * turn is NEVER parked. A newer start() supersedes any in-flight, stashed,
   * or pending-adoption record (which is then `discarded`).
   */
  start(input: SummaryGenerationInput): void {
    if (!input.transcript || input.transcript.trim().length === 0) {
      this.log?.("[bg-summarization] start() with an empty transcript — skipping");
      return;
    }
    const gen = ++this.generation;
    if (
      this.status === "generating" ||
      this.status === "stashed" ||
      this.status === "pending_adoption"
    ) {
      this.emit(BACKGROUND_SUMMARIZATION_TELEMETRY.discarded, {
        generation: this.activeGeneration,
        supersededBy: gen,
        reason: "superseded",
      });
      this.status = "discarded";
      this.stashed = undefined;
    }
    this.activeGeneration = gen;
    this.status = "generating";
    this.startedAt = this.now();
    this.emit(BACKGROUND_SUMMARIZATION_TELEMETRY.started, {
      generation: gen,
      trigger: input.trigger,
      transcriptChars: input.transcript.length,
      estimatedTokens: input.estimatedTokens,
      truncated: input.truncated,
    });
    void (async () => {
      try {
        const text = await this.generate(input);
        if (gen !== this.activeGeneration) {
          return; // superseded while generating — discarded was already emitted
        }
        if (typeof text !== "string" || text.trim().length === 0) {
          throw new Error("summary generation returned empty text");
        }
        const stashedAt = this.now();
        const timeSavedMs = stashedAt - this.startedAt;
        this.stashed = {
          text,
          trigger: input.trigger,
          startedAt: this.startedAt,
          stashedAt,
          timeSavedMs,
          transcriptChars: input.transcript.length,
          turnIds: [...input.turnIds],
        };
        this.status = "stashed";
        this.emit(BACKGROUND_SUMMARIZATION_TELEMETRY.stashed, {
          generation: gen,
          trigger: input.trigger,
          [TIME_SAVED_MS_FIELD]: timeSavedMs,
          summaryChars: text.length,
          turnsCovered: input.turnIds.length,
        });
      } catch (err) {
        if (gen !== this.activeGeneration) {
          return; // superseded while generating
        }
        // Engine unreachable (or any failure): NEVER fabricate a summary.
        // Drop the generation; the turn continues unparked. There is no
        // `failed` event in Cursor's family — the gap is logged, not invented.
        this.status = "idle";
        this.log?.(
          `[bg-summarization] generation failed (${
            err instanceof Error ? err.message : String(err)
          }) — dropping; no summary fabricated`,
        );
      }
    })();
  }

  /**
   * Turn boundary: adopt a stashed summary. pending_adoption → preCompact
   * hooks (observational) → persisted. No-op unless a summary is stashed.
   */
  async onTurnBoundary(): Promise<void> {
    if (this.status !== "stashed" || !this.stashed) {
      return;
    }
    const gen = this.activeGeneration;
    const result = this.stashed;
    this.status = "pending_adoption";
    this.emit(BACKGROUND_SUMMARIZATION_TELEMETRY.pending_adoption, {
      generation: gen,
      trigger: result.trigger,
      summaryChars: result.text.length,
    });
    if (this.preCompact) {
      try {
        const hookResult = await this.preCompact({
          summaryChars: result.text.length,
          trigger: result.trigger,
          turnsCovered: result.turnIds.length,
          [TIME_SAVED_MS_FIELD]: result.timeSavedMs,
        });
        this.log?.(
          `[bg-summarization] preCompact hooks ran (observational): ${JSON.stringify(hookResult)?.slice(0, 300) ?? "ok"}`,
        );
      } catch (err) {
        // Observational only — a hook failure must never block adoption.
        this.log?.(
          `[bg-summarization] preCompact hook error (ignored, observational): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    if (gen !== this.activeGeneration || this.status !== "pending_adoption") {
      return; // superseded during the hook window — discarded was already emitted
    }
    this.compactedTurnIds.push(...result.turnIds);
    this.lastAdopted = result;
    this.stashed = undefined;
    this.status = "persisted";
    this.emit(BACKGROUND_SUMMARIZATION_TELEMETRY.persisted, {
      generation: gen,
      trigger: result.trigger,
      [TIME_SAVED_MS_FIELD]: result.timeSavedMs,
      turnsCompacted: result.turnIds.length,
      summaryChars: result.text.length,
    });
  }
}

/**
 * Build the summarization prompt for the engine's session.generate endpoint.
 * The transcript is the adapter-observed SSE text (user prompts, assistant
 * deltas, tool calls/results), capped by TranscriptTracker.
 */
export function buildBackgroundSummaryPrompt(input: SummaryGenerationInput): string {
  const lines = [
    "Summarize the following AI coding-assistant conversation transcript into a compact handoff summary.",
    "Capture: the user's goals and requests, key decisions made, files touched, tool actions taken and their outcomes,",
    "unresolved issues, and the current state of the work.",
    "Write plain prose, no markdown fences, no tool calls — this is a summary, not a new turn.",
    input.truncated
      ? "(Note: the oldest part of the transcript was truncated to fit; summarize what remains.)"
      : "",
    "",
    "--- TRANSCRIPT ---",
    input.transcript,
  ];
  return lines.filter((l) => l.length > 0 || l === "").join("\n");
}

/**
 * Lightweight per-session transcript observed from SSE events (text deltas +
 * tool calls/results). Bounded at MAX_TRANSCRIPT_CHARS (oldest segments
 * dropped first). Feeds SummaryGenerationInput when the threshold fires.
 *
 * HONEST-DIVERGENCE: this is the client's observed transcript — the engine
 * owns the authoritative session history server-side, so token counts here
 * are estimates (chars/4), not the engine's real accounting.
 */
export class TranscriptTracker {
  private segments: string[] = [];
  private assistantBuf = "";
  private turnIds: string[] = [];
  private readonly compactedTurnIds = new Set<string>();
  private truncated = false;
  private totalChars = 0;

  private pushSegment(segment: string): void {
    if (!segment) {
      return;
    }
    this.segments.push(segment);
    this.totalChars += segment.length;
    while (this.totalChars > MAX_TRANSCRIPT_CHARS && this.segments.length > 1) {
      const dropped = this.segments.shift()!;
      this.totalChars -= dropped.length;
      this.truncated = true;
    }
  }

  private flushAssistantBuf(): void {
    if (this.assistantBuf.length > 0) {
      // A single turn's deltas can exceed the cap alone — keep the tail.
      const buf =
        this.assistantBuf.length > MAX_TRANSCRIPT_CHARS
          ? this.assistantBuf.slice(-MAX_TRANSCRIPT_CHARS)
          : this.assistantBuf;
      if (buf.length < this.assistantBuf.length) {
        this.truncated = true;
      }
      this.pushSegment(`## Assistant\n${buf}\n`);
      this.assistantBuf = "";
    }
  }

  /** Record the user's turn prompt (truncated to 4000 chars — the full prompt already lives server-side). */
  recordUserPrompt(text: string): void {
    this.flushAssistantBuf();
    const t = typeof text === "string" ? text : String(text ?? "");
    this.pushSegment(`## User\n${t.slice(0, 4000)}\n`);
  }

  /** Record one assistant text delta (accumulated; flushed on the next structural event). */
  recordTextDelta(delta: string): void {
    if (typeof delta === "string" && delta.length > 0) {
      this.assistantBuf += delta;
    }
  }

  /** Record one reasoning delta (truncated — reasoning is verbose and low-signal for summaries). */
  recordReasoningDelta(delta: string): void {
    if (typeof delta === "string" && delta.length > 0) {
      this.assistantBuf += delta.slice(0, 400);
    }
  }

  /** Record a tool call (name + input preview). */
  recordToolCall(name: string, inputJson: string): void {
    this.flushAssistantBuf();
    const input = typeof inputJson === "string" ? inputJson.slice(0, 1000) : "";
    this.pushSegment(`## Tool: ${name}\nInput: ${input}\n`);
  }

  /** Record a tool result (output preview or error, truncated). */
  recordToolResult(toolId: string, preview: string): void {
    const p = typeof preview === "string" ? preview.slice(0, 1500) : "";
    this.pushSegment(`Result (${toolId}): ${p}\n`);
  }

  /** Mark a turn boundary (turn ids are compacted on summary adoption). */
  recordTurnBoundary(turnId: string): void {
    this.flushAssistantBuf();
    if (turnId && !this.turnIds.includes(turnId)) {
      this.turnIds.push(turnId);
    }
  }

  /** Turn ids not yet covered by an adopted summary. */
  getUncompactedTurnIds(): string[] {
    return this.turnIds.filter((id) => !this.compactedTurnIds.has(id));
  }

  /** Mark turn ids as compacted (called by the adapter after a summary is adopted). */
  markCompacted(turnIds: string[]): void {
    for (const id of turnIds) {
      this.compactedTurnIds.add(id);
    }
  }

  /** Estimated tokens of the tracked transcript (chars/4 heuristic). */
  estimatedTokens(): number {
    return estimateTokensFromChars(this.totalChars + this.assistantBuf.length);
  }

  /** Build the summarizer input for a trigger. */
  buildSummaryInput(trigger: SummarizationTrigger): SummaryGenerationInput {
    this.flushAssistantBuf();
    const transcript = this.segments.join("");
    return {
      transcript,
      trigger,
      turnIds: this.getUncompactedTurnIds(),
      estimatedTokens: estimateTokensFromChars(transcript.length),
      truncated: this.truncated,
    };
  }

  /**
   * GAPS-167 (context usage report): the observed transcript segments, in
   * order, plus whether the transcript was truncated to the cap (older
   * segments dropped — the report's honest `incompleteReport` signal).
   */
  getSegments(): { segments: readonly string[]; truncated: boolean } {
    this.flushAssistantBuf();
    return { segments: [...this.segments], truncated: this.truncated };
  }

  /** For tests/inspection. */
  getTranscriptChars(): number {
    return this.totalChars + this.assistantBuf.length;
  }

  clear(): void {
    this.segments = [];
    this.assistantBuf = "";
    this.turnIds = [];
    this.compactedTurnIds.clear();
    this.truncated = false;
    this.totalChars = 0;
  }
}
