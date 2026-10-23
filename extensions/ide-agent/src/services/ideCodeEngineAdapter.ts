import * as vscode from "vscode";
import * as fs from "fs";
import * as childProcess from "child_process";
import * as crypto from "crypto";
import * as http from "http";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { EngineAdapter, EngineModelInfo, ModelRef, TurnContext } from "./agentService";
import {
  BUNDLED_RIPGREP_FILE,
  bundledBinaryPath,
  bundledServePreloadPath,
  type EngineLayout,
  type EnginePathSource,
} from "./enginePath";
import { contextTokenLimitFromEngineModel } from "./modelService";
import { ApprovalResult, ApprovalDetails } from "./humanReviewService";
import { TERMINAL_ACTIONS } from "./permissionsFileService";
import { buildFileEditApprovalDetails } from "./unifiedDiff";
import { ModeName, ToolCallViewModel, TurnEvent, ClarifyingQuestion, TurnStopReason } from "../model";
import { isMutatingToolAction, isReadOnlyMode, sessionPermissionsForMode } from "./modeService";
import { parseSse, SseEvent } from "./sseParser";
import { HookService } from "../hooks/hookService";
import { requestContextSkills } from "./skillStoreService";
import {
  ATTRIBUTION_COMMITS_CONFIG_KEY,
  ATTRIBUTION_CONFIG_SECTION,
  ATTRIBUTION_PRS_CONFIG_KEY,
  resolveAttributionRequestContext,
  type AttributionRequestContext,
} from "./attribution";
import {
  engineConfigFilePaths,
  readConfigTexts,
  resolveSubagentDepthConfigContent,
} from "./subagentNesting";
import {
  BlockingSummarizer,
  FeatureModelConfig,
  LoopDetectedError,
  ModelFallbackManager,
  RATE_LIMITED_RECONNECT_MESSAGE,
  RETRY_NO_PROGRESS_DETAIL,
  RETRY_NO_PROGRESS_MESSAGE,
  RetryState,
  ResumeStateTracker,
  SINGLE_MESSAGE_LOOP_POLICY,
  ShadowVerdict,
  SingleMessageLoopDetector,
  StallInfo,
  StreamStallDetector,
  SummarizationTrigger,
  TurnInterruptedBy,
  TurnOutcome,
  TurnSettled,
  appendTurnSettledByError,
  buildTurnSettled,
  classifyEngineSseEvent,
  computeBackoffMs,
  detectSummarizationTrigger,
  formatToolError,
  runShadowClassifier,
} from "./agentRuntime";
import {
  BACKGROUND_SUMMARY_GENERATE_TIMEOUT_MS,
  BackgroundSummarizer,
  DEFAULT_BACKGROUND_SUMMARY_CONTEXT_WINDOW_TOKENS,
  SummaryGenerationInput,
  TranscriptTracker,
  buildBackgroundSummaryPrompt,
  meetsBackgroundSummaryThreshold,
} from "./backgroundSummarizer";

/**
 * IdeCodeEngineAdapter — the REAL engine adapter.
 *
 * Spawns the ide-code (OpenCode-derived) server as a sidecar process and
 * translates its HTTP/SSE wire protocol into TurnEvents for the chat UI:
 *
 *   spawn:  bun <enginePath>/packages/cli/src/index.ts serve --port <free> --hostname 127.0.0.1
 *           (binary-layout bundled engine, compile path B:
 *            <enginePath>/opencode[.exe] serve --port <free> --hostname 127.0.0.1
 *            spawned directly — no bun, no --preload; see startServer)
 *   wire:   POST /api/session            → create/reuse session
 *           POST /api/session/:id/prompt → send user turn { text }
 *           GET  /api/event              → SSE stream of session/message/permission events
 *           POST /api/session/:id/permission/:reqID/reply → approval decisions
 *
 * Event → TurnEvent mapping:
 *   message.part.delta (text)            → textDelta
 *   message.part.updated (reasoning)     → thinking
 *   message.part.updated (tool/pending)  → toolCall (new card)
 *   message.part.updated (tool/running)  → toolCallDelta {status: running}
 *   message.part.updated (tool/completed)→ toolCallDelta {status: done, outputPreview}
 *   message.part.updated (tool/error)    → toolCallDelta {status: failed}
 *   permission.asked                     → humanReviewService → permission.reply
 *   session.execution.succeeded|failed   → done
 *   session.error                        → textDelta(error) + done
 */
export interface IdeCodeEngineOptions {
  enginePath: string;
  output: vscode.OutputChannel;
  requestApproval: (
    toolCallId: string,
    title: string,
    reasons: string[],
    /** P1 (QA-CHATTABS-01): stable allowlist identity (action+resources). */
    allowlistIdentity?: string,
    /**
     * GAPS-12 (approval-card-diff): file-edit diff payload — the engine's
     * unified-diff patch trimmed to context 2, rendered verbatim by the
     * approval card. Omitted for non-file-edit approvals.
     */
    approvalDetails?: ApprovalDetails,
    /**
     * GAPS-22B: shell/terminal candidate command labels. When non-empty,
     * the approval card's allowlist button label is built Cursor-verbatim
     * (`Always Run '<cmd>'` / `Always Run '<cmd>' + N` — binary `ycp`).
     */
    allowlistCandidates?: readonly string[],
    /**
     * DEV-GAPS-66/W66A (`agent-accept-pending-decisions`): the engine tool
     * identity for the pending-decision group algorithm (the binary's
     * `clientSideTool`). The call site passes the engine `action`
     * verbatim (e.g. "bash", "edit", "mcp__srv__tool").
     */
    clientSideTool?: string,
  ) => Promise<ApprovalResult>;
  /**
   * P2 (QA-FILE-04): current chat mode, used by the read-only gate in
   * handleApproval. Optional so tests/callers without a mode service keep
   * working (no gate when absent).
   */
  getMode?: () => ModeName;
  /**
   * DEV-HOOKS: Cursor-style agent hooks. The approval path is the blocking
   * choke point: preToolUse + beforeShellExecution/beforeMCPExecution/
   * beforeReadFile run before the approval card; exit code 2 auto-rejects.
   * Optional — the adapter works without it.
   */
  hooks?: HookService;
  /**
   * P2-5 (QA-CHATTABS-01): the owning composer's hook scope — hook stdout
   * produced through this adapter is buffered per tab, never shared.
   */
  hookScope?: string;
  /**
   * DD-AR-3 (resume-from-checkpoint): latest checkpoint id for a bubble, so
   * a retried attempt can send `resumeAction` with the checkpoint state
   * instead of restarting the request. Wired by the composer to its
   * CheckpointService; undefined = no checkpoint resume.
   */
  getLatestCheckpointId?: (bubbleId: string) => string | undefined;
  /**
   * DD-AR-4 (blocking summarization): runs a blocking summarization for the
   * trigger and resolves when it completes (WaitForCompletion). Unbound =
   * the adapter logs and continues (documented divergence — the engine owns
   * compaction server-side).
   */
  requestBlockingSummarization?: (trigger: SummarizationTrigger) => Promise<void>;
  /**
   * BG-SUMMARIZATION (Cursor parity): estimated context-window size (tokens)
   * for the proactive 70% background-summarization threshold. The engine
   * does not report the model's real context window on this wire, so this is
   * a local estimate (UNKNOWN vs Cursor's exact accounting); the default is
   * DEFAULT_BACKGROUND_SUMMARY_CONTEXT_WINDOW_TOKENS.
   */
  backgroundSummaryContextWindowTokens?: number;
  /**
   * ENGINE PACKAGING (spec §5.3): absolute path to the bun binary resolved
   * by the caller from the resolved enginePath (bundled `bin/bun[.exe]`
   * first, `bun` on PATH as fallback). Default: "bun" (PATH lookup).
   */
  bunPath?: string;
  /** ENGINE PACKAGING: where enginePath came from (diagnostics + cwd/preload branches). */
  engineSource?: EnginePathSource;
  /**
   * ENGINE PACKAGING (compile path B): on-disk layout of enginePath as
   * detected by the resolver (services/enginePath.ts). "binary" spawns
   * the compiled `opencode[.exe]` at the engine root directly; "tree"
   * (the default when unset — every pre-packaging caller and test) keeps
   * the bun + entry spawn exactly as before.
   */
  engineLayout?: EngineLayout;
  /**
   * ENGINE PACKAGING (spec §4 / D5, BRANCH B): writable spawn-cwd
   * override for bundled engines (user-data `engine-runtime` dir).
   * Undefined = spawn with cwd = enginePath, as before.
   */
  engineCwd?: string;
  /**
   * ENGINE PACKAGING (spec §5.1): when set, startServer throws this
   * diagnostic instead of the generic Invalid enginePath error (broken
   * bundled engine — see services/enginePath.ts resolveEnginePath).
   */
  enginePathDiagnostic?: string;
}

/** Engine tool id → Cursor-style tool_call name for the UI cards. */
const TOOL_NAME_MAP: Record<string, string> = {
  read: "read_tool_call",
  edit: "edit_tool_call",
  write: "edit_tool_call",
  bash: "shell_tool_call",
  glob: "glob_tool_call",
  grep: "grep_tool_call",
  list: "ls_tool_call",
  todowrite: "update_todos_tool_call",
  todoread: "read_todos_tool_call",
  webfetch: "fetch_tool_call",
  websearch: "web_search_tool_call",
  task: "task_tool_call",
  patch: "apply_agent_diff_tool_call",
  question: "ask_question_tool_call",
};

function toCursorToolName(engineTool: string): string {
  if (engineTool.startsWith("mcp__")) return "mcp_tool_call";
  return TOOL_NAME_MAP[engineTool] ?? `${engineTool}_tool_call`;
}

/**
 * DD-AR-8: read-only tool actions (subset of Cursor's allowlist run mode).
 * Module scope so both handleApproval and the shadow classifier share it.
 */
const READ_ONLY_TOOL_ACTIONS: ReadonlySet<string> = new Set([
  "read",
  "glob",
  "grep",
  "list",
  "ls",
  "todoread",
  "webfetch",
  "websearch",
]);

/** Parse a "providerID/modelId" fallback model id (DD-AR-6). Pure; unit-tested. */
export function parseModelRefString(id: string): ModelRef | undefined {
  const slash = id.indexOf("/");
  if (slash <= 0 || slash === id.length - 1) {
    return undefined;
  }
  return { id: id.slice(slash + 1), providerID: id.slice(0, slash) };
}

/**
 * Parse a Cursor-style MCP tool action (mcp__<server>__<tool>).
 * Mirrors the core's McpNames.parseToolName.
 */
function parseMcpAction(action: string): { server: string; tool: string } | undefined {
  if (!action.startsWith("mcp__")) return undefined;
  const parts = action.split("__");
  if (parts.length < 3 || !parts[1]) return undefined;
  return { server: parts[1], tool: parts.slice(2).join("__") };
}

/** Approval-card title: MCP tools render as "MCP: <tool> (<server>)" (Cursor parity). */
function approvalTitle(action: string, resources: string[]): string {
  const mcp = parseMcpAction(action);
  if (mcp) return `MCP: ${mcp.tool} (${mcp.server})`;
  return `${action}${resources.length > 0 ? ` ${resources[0]}` : ""}`;
}

/**
 * Allowlist identity: the STABLE tool identity — action + sorted resources
 * (e.g. "edit::src/a.ts") — never the per-request toolCallId (`tc-<request-id>`
 * is unique per permission request, so keying on it made "Approve and
 * allowlist" a dead feature). Pure; unit-tested (RB-X3 lock-in).
 *
 * Resources are joined with NUL, not "," — a comma collides ["a,b"] with
 * ["a","b"], and shell resources are full command text where commas are
 * common. NUL cannot appear in a file path (forbidden by the OS on POSIX
 * and Windows) or in command text, so the key is unambiguous.
 */
export function buildAllowlistIdentity(action: string, resources: string[]): string {
  return `${action}::${[...new Set(resources)].sort().join("\u0000")}`;
}

// NOTE: SseEvent + parseSse live in ./sseParser.ts (vscode-free, unit-tested).
// The real engine emits frames as `data: ${JSON.stringify({id,type,data})}`
// with NO `event:` line — the old local parser required `event:` and dropped
// 100% of real server events (QA-FILE-03 P0).

// P2 (QA-04): per-process counter so synthetic toolCallIds can never collide
// within the same millisecond.
let toolCallSeq = 0;

/** HTTP error with the status code attached, so callers can branch on 404 etc. */
export interface HttpStatusError extends Error {
  statusCode: number;
  /** Parsed Retry-After (ms) when the response carried one — DD-AR-2. */
  retryAfterMs?: number;
}

function httpError(method: string, pathStr: string, statusCode: number, body: string, retryAfterMs?: number): HttpStatusError {
  const err = new Error(`${method} ${pathStr} → ${statusCode}: ${body}`) as HttpStatusError;
  err.statusCode = statusCode;
  if (retryAfterMs !== undefined) {
    err.retryAfterMs = retryAfterMs;
  }
  return err;
}

/**
 * Parse a Retry-After response header value into milliseconds.
 * Pure; unit-tested. Supports delay-seconds and HTTP-date forms.
 */
export function parseRetryAfterMs(value: string | string[] | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) {
    return undefined;
  }
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }
  return undefined;
}

/**
 * Extract the HTTP status code from an api() rejection, if present.
 * Pure; unit-tested.
 */
export function httpStatusCode(err: unknown): number | undefined {
  if (typeof err === "object" && err !== null && "statusCode" in err) {
    const code = (err as { statusCode: unknown }).statusCode;
    return typeof code === "number" ? code : undefined;
  }
  return undefined;
}

/**
 * Pull the session id out of a session-scoped API path
 * ("/api/session/<id>/...") — undefined for anything else.
 * Pure; unit-tested.
 */
export function sessionIdFromApiPath(pathStr: string): string | undefined {
  const m = /^\/api\/session\/([^/]+)\//.exec(pathStr);
  return m ? m[1] : undefined;
}

/**
 * Build the instruction prompt for one Tab completion. The code is sent
 * verbatim with a <CURSOR> marker; the model must return ONLY the text to
 * insert at the marker. Pure; unit-tested.
 */
export function buildTabCompletionPrompt(
  prefix: string,
  suffix: string,
  context?: { languageId?: string; fileName?: string },
): string {
  const header = [
    "Complete the following code.",
    "Output ONLY the completion text that should be inserted at <CURSOR>.",
    "No explanations, no markdown fences, no commentary.",
  ];
  if (context?.languageId) {
    header.push(`Language: ${context.languageId}`);
  }
  if (context?.fileName) {
    header.push(`File: ${context.fileName}`);
  }
  return `${header.join("\n")}\n\n${prefix}<CURSOR>${suffix}`;
}

/**
 * DD-AR-9: per-attempt context for runTurnAttempt.
 */
interface TurnAttemptContext {
  turnId: string;
  attempt: number;
  attemptRequestId: string;
  originalRequestId: string;
  stallDetector: StreamStallDetector;
  retry: RetryState;
  resume: ResumeStateTracker;
  summarizer: BlockingSummarizer;
  loopDetector: SingleMessageLoopDetector;
  timeoutPromise: Promise<{ timedOut: true }>;
}

/**
 * DD-AR-9: per-attempt result. The outer runTurn maps this onto the
 * turnSettled protocol event (COMPLETED | FAILED | INTERRUPTED).
 */
interface AttemptResult {
  sessionID: string;
  outcome: TurnOutcome;
  interruptedBy?: TurnInterruptedBy;
  stopReason?: TurnStopReason;
  failureMessage?: string;
  failure?: unknown;
  /** Retryable transport/server failure — the outer loop backs off and resumes. */
  retryableError?: { kind: string; retryAfterMs?: number; stallDurationMs?: number };
  /** DD-AR-7: single-message loop detected; the outer loop applies retry_once. */
  loopRetry?: boolean;
  /** IsStreamEvent-classified events observed during this attempt (no-progress guard). */
  progressEvents: number;
}

export class IdeCodeEngineAdapter implements EngineAdapter {
  private serverProc?: childProcess.ChildProcess;
  private port = 0;
  /** P1 (QA-03): random bearer token for sidecar auth; set at spawn. */
  private authToken?: string;
  private sessions = new Map<string, string>(); // mode → sessionID
  /**
   * DEV-MULTITASK: ids of live worker sessions (per-worktree subagents).
   * Worker approvals auto-run (multitask autoRun=true, spec
   * dig-debug-multitask §4 M4); the engine-exit handler includes them so a
   * dead sidecar fails worker turns fast instead of hanging them.
   */
  private readonly workerSessionIDs = new Set<string>();
  private workerApprovalListenerRegistered = false;
  private sseAbort?: AbortController;
  private readonly pendingApprovals = new Map<string, string>(); // requestID → toolCallId
  /**
   * M-03 (model picker): explicit model selection from the picker, or
   * undefined = "auto" (engine default). Passed to session.create for new
   * sessions; existing sessions are switched via POST /api/session/:id/model.
   */
  private selectedModel?: ModelRef;
  private starting: Promise<void> | undefined;
  /**
   * P2 (QA-CHATTABS Round B, R1): set when dispose() runs. ensureServer()
   * refuses to spawn a new sidecar for a dead tab — without this, a submit
   * whose beforeSubmitPrompt hooks resolved after closeTab disposed the
   * composer would respawn the bun process the P1-2 fix had just killed
   * (the leak returned through the back door).
   */
  private disposed = false;
  /**
   * P2 (XQA-03): approval serialization chain. `permission.asked` events are
   * consumed fire-and-forget, so two concurrent events used to orphan the
   * first approval card (HumanReviewService.current was overwritten and the
   * first promise hung until dispose/watchdog). Approvals now run strictly
   * one at a time; the chain can never break on a task failure.
   */
  private approvalChain: Promise<void> = Promise.resolve();

  /**
   * DEV-GAPS-5-SKILLS: cached engine skill inventory (GET /api/skill →
   * Skill.Info[] {id, name, ...}).
   */
  private engineSkillInventory: { at: number; items: Array<{ id: string; name: string }> } | undefined;

  /**
   * DEV-GAPS-5-SKILLS — skills in the agent request context (Cursor's
   * RequestContextSkillsPart equivalent, see
   * docs/rea/dig-ast-ext-findings.md §1).
   *
   * The engine's PromptInput.Prompt.skills is SkillAttachment[] = {id, name}
   * and the server REJECTS unknown ids (Session.SkillNotFoundError → 400
   * InvalidRequestError), so only store skills the engine inventory actually
   * resolves are attached. Fail-closed: an unreadable inventory means no
   * injection this turn — never a broken prompt.
   */
  private async resolveRequestSkillAttachments(): Promise<Array<{ id: string; name: string }>> {
    const part = requestContextSkills();
    if (part.skills.length === 0) {
      return [];
    }
    const now = Date.now();
    let inventory = this.engineSkillInventory;
    if (!inventory || now - inventory.at > 60_000) {
      let items: Array<{ id: string; name: string }> = [];
      try {
        const list: unknown = await this.api("GET", "/api/skill");
        if (Array.isArray(list)) {
          items = list
            .filter(
              (s): s is { id: string; name: string } =>
                !!s &&
                typeof s === "object" &&
                typeof (s as { id?: unknown }).id === "string" &&
                typeof (s as { name?: unknown }).name === "string",
            )
            .map((s) => ({ id: s.id, name: s.name }));
        }
      } catch {
        // Fail-closed: inventory unreadable → no skill injection this turn.
        return [];
      }
      inventory = { at: now, items };
      this.engineSkillInventory = inventory;
    }
    const known = new Map(inventory.items.map((s) => [s.name.toLowerCase(), s]));
    const out: Array<{ id: string; name: string }> = [];
    for (const skill of part.skills) {
      const hit = known.get(skill.name.toLowerCase());
      if (hit && !out.some((o) => o.id === hit.id)) {
        out.push({ id: hit.id, name: hit.name });
      }
    }
    return out;
  }

  /** Enqueue an approval task behind any in-flight approval. */
  private enqueueApproval(task: () => Promise<void>): void {    const run = () =>
      task().catch((err) => {
        this.opts.output.appendLine(
          `[ide-agent] approval task failed: ${err instanceof Error ? err.message : err}`,
        );
      });
    this.approvalChain = this.approvalChain.then(run, run);
  }

  constructor(private readonly opts: IdeCodeEngineOptions) {}

  /**
   * Run one turn with Cursor-style runtime hardening (DD-AR-1/2/3/7/9):
   * stream-stall detection, retry taxonomy (serverCap 3 / transportCap 10,
   * 1s→60s backoff + 20% jitter, Retry-After ≤60s, 180s stall budget),
   * resume-from-checkpoint on retry, single-message loop retry_once, and
   * the turnSettled protocol event.
   */
  async *runTurn(ctx: TurnContext): AsyncIterable<TurnEvent> {
    // ---- per-turn runtime hardening state ----
    const turnId = `turn-${Date.now().toString(36)}-${(toolCallSeq++).toString(36)}`;
    // DD-AR-3: originalRequestId is kept across attempts; each attempt gets a
    // new attemptRequestId (OBSERVED).
    const originalRequestId = `req-${turnId}`;
    // DD-AR-1: per-turn stall detector (30s fail, 3x heartbeat-only).
    const stallDetector = new StreamStallDetector({
      onStall: (info) => this.onStreamStall(info),
    });
    this.turnStallDetector = stallDetector;
    // DD-AR-2: request-level retry taxonomy.
    const retry = new RetryState({
      log: (m) => this.opts.output.appendLine(`[ide-agent] ${m}`),
    });
    // DD-AR-3: resume-from-checkpoint state.
    const resume = new ResumeStateTracker();
    // DD-AR-4: blocking summarization (WaitForCompletion parking + orphan hold).
    const summarizer = new BlockingSummarizer({
      summarize: (t) => this.runBlockingSummarization(t),
      log: (m) => this.opts.output.appendLine(`[ide-agent] ${m}`),
    });
    this.turnSummarizer = summarizer;
    // DD-AR-7: single-message loop detector.
    const loopDetector = new SingleMessageLoopDetector();
    this.turnLoopDetector = loopDetector;
    // DD-AR-6: server-driven model fallback (client-side fallback list).
    this.modelFallback = new ModelFallbackManager({
      getFeatureConfig: () => this.readFallbackConfig(),
      log: (m) => this.opts.output.appendLine(`[ide-agent] ${m}`),
    });

    // P0: turn-level watchdog — 10 minutes TOTAL for the turn, across retry
    // attempts. A hung SSE/engine can never wedge the chat forever.
    // P3 (XQA-03): a single timer drives both the boolean (post-loop error
    // message) and the promise (breaks mergeStreams). It is cleared in the
    // finally block, so no dangling 10-min timer survives a finished turn.
    const TURN_TIMEOUT_MS = 10 * 60 * 1000;
    let watchdogId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<{ timedOut: true }>((resolve) => {
      watchdogId = setTimeout(() => {
        this.turnTimedOut = true;
        resolve({ timedOut: true });
      }, TURN_TIMEOUT_MS);
    });

    this.turnActive = true;
    // P1 (QA-FILE-01): fresh abort state per turn — abortTurn() sets the flag
    // + resolves abortResolve, finally clears both.
    this.turnAbortRequested = false;
    this.turnTimedOut = false;
    this.backoffAborter = new AbortController();

    let settled: TurnSettled | undefined;
    let loopRetriesLeft = 1; // DD-AR-7: retry_once policy — one turn retry, then the error surfaces.
    let lastSessionID: string | undefined;

    try {
      await this.ensureServer();
      yield { type: "thinking", bubbleId: ctx.bubbleId, text: "Connecting to ide-code engine…", durationMs: 0 };

      // BG-SUMMARIZATION (Cursor parity): background summarization NEVER
      // parks the turn. The adapter observes the SSE transcript per session
      // and starts a fire-and-forget summary at the 70% threshold; adoption
      // happens at the turn boundary (finally below). Hard token_limit /
      // image_limit errors keep the existing BlockingSummarizer path
      // (WaitForCompletion) — see the session.error handler in consumeEvents.
      this.turnTranscriptTracker = this.transcriptTrackerFor(ctx.mode);
      this.turnBgSummarizer = this.bgSummarizerFor(ctx.mode);
      this.turnTranscriptTracker.recordUserPrompt(ctx.prompt);
      this.turnTranscriptTracker.recordTurnBoundary(turnId);
      this.turnEstimatedTokenChars = ctx.prompt.length;
      this.bgSummaryStartedThisTurn = false;

      // DD-AR-3: record the latest checkpoint so a retried attempt can send
      // resumeAction with the checkpoint state instead of restarting.
      resume.recordCheckpoint(this.opts.getLatestCheckpointId?.(ctx.humanBubbleId ?? ctx.bubbleId));

      let attempt = 0;
      for (;;) {
        attempt += 1;
        // P2-A fix (QA-VERIFY-DIGDEEPER): refresh the resume checkpoint at the
        // start of every attempt, not just once before the loop. A checkpoint
        // created mid-turn (during a previous attempt) must be fed back into
        // the resume state, otherwise a retry replays tool calls that already ran.
        resume.recordCheckpoint(this.opts.getLatestCheckpointId?.(ctx.humanBubbleId ?? ctx.bubbleId));
        const attemptRequestId = `${originalRequestId}-a${attempt}`;
        const result: AttemptResult = yield* this.runTurnAttempt(ctx, {
          turnId,
          attempt,
          attemptRequestId,
          originalRequestId,
          stallDetector,
          retry,
          resume,
          summarizer,
          loopDetector,
          timeoutPromise,
        });
        lastSessionID = result.sessionID;

        // DD-AR-7: retry_once — one retry of the whole turn, then fail.
        if (result.loopRetry) {
          if (loopRetriesLeft > 0) {
            loopRetriesLeft -= 1;
            this.opts.output.appendLine(
              `[ide-agent] single-message loop detected — policy ${SINGLE_MESSAGE_LOOP_POLICY}: retrying the turn once`,
            );
            yield {
              type: "textDelta",
              bubbleId: ctx.bubbleId,
              delta: "\n\n*Detected a repeated tool-call loop — retrying the turn once…*",
            };
            continue;
          }
          settled = appendTurnSettledByError(turnId, ctx.bubbleId, result.failure);
          yield {
            type: "textDelta",
            bubbleId: ctx.bubbleId,
            delta: `\n\n**Engine error:** ${result.failureMessage ?? "repeated tool-call loop detected."}`,
          };
          break;
        }

        // DD-AR-2/3: retryable transport/server failure → backoff, then resume.
        if (result.retryableError) {
          // DD-AR-3 no-progress guard: applies to stall-resume attempts —
          // "resume attempts are streaming but not producing checkpoints".
          // (Prompt-POST failures are plain retries, not resumes.)
          if (result.retryableError.kind === "stall") {
            resume.recordResumeOutcome(result.progressEvents > 0);
            if (resume.shouldStopNoProgress()) {
              settled = buildTurnSettled(turnId, "FAILED", {
                bubbleId: ctx.bubbleId,
                error: `${RETRY_NO_PROGRESS_MESSAGE}. ${RETRY_NO_PROGRESS_DETAIL}`,
              });
              yield {
                type: "textDelta",
                bubbleId: ctx.bubbleId,
                delta: `\n\n**Engine error:** ${RETRY_NO_PROGRESS_MESSAGE}. ${RETRY_NO_PROGRESS_DETAIL}`,
              };
              break;
            }
          }
          const decision = retry.decide({
            kind: result.retryableError.kind,
            retryAfterMs: result.retryableError.retryAfterMs,
            stallDurationMs: result.retryableError.stallDurationMs,
          });
          if (decision.action === "throw") {
            settled = buildTurnSettled(turnId, "FAILED", {
              bubbleId: ctx.bubbleId,
              error: decision.message,
            });
            yield {
              type: "textDelta",
              bubbleId: ctx.bubbleId,
              delta: `\n\n**Engine error:** ${decision.message}${decision.detail ? ` ${decision.detail}` : ""}`,
            };
            break;
          }
          // Diagnostics log (OBSERVED shape: [AGENT_ERROR_DIAGNOSTICS] ... decision=RETRY ...).
          this.opts.output.appendLine(
            `[AGENT_ERROR_DIAGNOSTICS] requestId=${originalRequestId} attemptRequestId=${attemptRequestId} ` +
              `decision=RETRY (category=${decision.category}, attempt=${decision.attempt}, ` +
              `delayMs=${Math.round(decision.delayMs)}${decision.waitingForRetryAfter ? ", waitingForRetryAfter" : ""})`,
          );
          yield {
            type: "textDelta",
            bubbleId: ctx.bubbleId,
            delta: `\n\n*Connection interrupted — retrying (attempt ${attempt + 1})…*`,
          };
          try {
            // DD-AR-2: abortable backoff ("Cancelled during backoff").
            await retry.abortableSleep(decision.delayMs, this.backoffAborter?.signal);
          } catch {
            // Stopped during backoff — a user stop, not an engine error.
            settled = buildTurnSettled(turnId, "INTERRUPTED", {
              bubbleId: ctx.bubbleId,
              interruptedBy: "USER",
            });
            break;
          }
          continue;
        }

        // Terminal attempt result → turnSettled protocol event (DD-AR-9).
        settled = buildTurnSettled(turnId, result.outcome, {
          bubbleId: ctx.bubbleId,
          interruptedBy: result.interruptedBy,
          stopReason: result.stopReason,
          error: result.failureMessage,
        });
        // P1 (QA-04-VERIFY): surface the failure visibly (was unreachable on
        // the timeout path when the check sat inside the event loop).
        // A user-initiated stop must NOT surface as an "Engine error" — the
        // composer appends "Turn stopped by user" itself.
        if (result.failureMessage && result.outcome !== "COMPLETED" && !this.turnAbortRequested) {
          yield {
            type: "textDelta",
            bubbleId: ctx.bubbleId,
            delta: `\n\n**Engine error:** ${result.failureMessage}`,
          };
        }
        break;
      }

      // DD-AR-9: the turn always settles with an outcome before done.
      if (settled) {
        yield settled;
      }
      // P2 (QA-04): use a per-turn synthetic server id, NOT the sessionID.
      // The engine wire provides no per-message id; reusing the session id
      // would make every turn's bubble overwrite the same serverToClient index.
      yield {
        type: "reconcile",
        clientBubbleId: ctx.bubbleId,
        serverBubbleId: `srv-${lastSessionID ?? "nosession"}-${(toolCallSeq++).toString(36)}`,
      };
      yield { type: "done" };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // P1 (QA-FILE-01): a user-initiated stop must NOT surface as an
      // "Engine error" — the composer appends "Turn stopped by user" itself.
      if (!this.turnAbortRequested) {
        yield { type: "textDelta", bubbleId: ctx.bubbleId, delta: `\n\n**Engine error:** ${message}` };
      }
      yield appendTurnSettledByError(turnId, ctx.bubbleId, err);
      yield { type: "done" };
    } finally {
      // BG-SUMMARIZATION: turn boundary — adopt a stashed background summary
      // (pending_adoption → preCompact hooks (observational) → persisted).
      // Fire-and-forget: teardown must not wait on hooks or the engine.
      // On adoption, tell the transcript tracker which turns are now covered
      // so future summaries don't re-claim them (getUncompactedTurnIds would
      // otherwise grow unbounded across turns).
      {
        const bg = this.turnBgSummarizer;
        const tracker = this.turnTranscriptTracker;
        const previouslyAdopted = bg?.getLastAdoptedSummary();
        void bg?.onTurnBoundary().then(() => {
          const adopted = bg.getLastAdoptedSummary();
          if (tracker && adopted && adopted !== previouslyAdopted) {
            tracker.markCompacted(adopted.turnIds);
          }
        }).catch((err) => {
          this.opts.output.appendLine(
            `[ide-agent] background summary adoption failed: ${err instanceof Error ? err.message : err}`,
          );
        });
      }
      // P3 (XQA-03): clear the single watchdog timer — no dangling timer.
      if (watchdogId !== undefined) {
        clearTimeout(watchdogId);
        watchdogId = undefined;
      }
      this.turnActive = false;
      // P1 (QA-FILE-01): clear abort state so the next turn starts clean.
      this.turnAbortRequested = false;
      this.turnTimedOut = false;
      this.abortResolve = undefined;
      this.attemptAbortResolve = undefined;
      this.backoffAborter = undefined;
      this.turnStallDetector = undefined;
      this.turnSummarizer = undefined;
      this.turnLoopDetector = undefined;
      // BG-SUMMARIZATION: clear per-turn observation state (the per-session
      // tracker/summarizer maps above persist across turns).
      this.turnTranscriptTracker = undefined;
      this.turnBgSummarizer = undefined;
      this.turnEstimatedTokenChars = 0;
      this.bgSummaryStartedThisTurn = false;
      this.modelFallback = undefined;
      this.stallAbortRequested = false;
      this.turnLoopError = undefined;
      this.sseDropExpected = false;
      if (this.sseReconnectTimer) {
        clearTimeout(this.sseReconnectTimer);
        this.sseReconnectTimer = undefined;
      }
      // DD-AR-4: orphaned-summary hold — the turn ended with a summary still
      // in flight; park it for 5 min without blocking teardown.
      summarizer.markTurnEnded();
      void summarizer.waitForOrphanHold().catch(() => {});
    }
  }

  /**
   * One attempt of a turn. Returns (never throws for retryable failures) an
   * AttemptResult the outer runTurn maps onto retry/backoff or turnSettled.
   * Non-retryable failures throw and are surfaced by the outer catch.
   */
  private async *runTurnAttempt(
    ctx: TurnContext,
    ac: TurnAttemptContext,
  ): AsyncGenerator<TurnEvent, AttemptResult, unknown> {
    // P1 (QA-FILE-01): fresh abort state per attempt.
    let resolveAbort: () => void = () => {};
    const abortPromise = new Promise<void>((resolve) => {
      resolveAbort = resolve;
    });
    this.abortResolve = resolveAbort;
    this.attemptAbortResolve = resolveAbort;
    // Fresh per-attempt runtime state.
    ac.stallDetector.reset();
    ac.loopDetector.reset();
    this.turnStreamEvents = 0;
    this.turnLoopError = undefined;
    this.stallAbortRequested = false;
    let stallDurationMs = 0;

    let turnEnd:
      | {
          done: Promise<void>;
          cancel: () => void;
          getFailure: () => unknown;
          getEndKind: () => "succeeded" | "failed" | "interrupted" | undefined;
        }
      | undefined;
    let stallCheckTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const sessionID = await this.ensureSession(ctx.mode);

      // DEV-GAPS-5-SKILLS: skills in the agent request context (Cursor's
      // RequestContextSkillsPart). Only store skills the engine inventory
      // resolves are attached — the server 400s unknown skill ids
      // (Session.SkillNotFoundError), so unknown store skills are left out
      // rather than breaking the turn.
      const requestSkills = await this.resolveRequestSkillAttachments();

      // Start the SSE consumer (shared across turns; resolves per-turn via execution events).
      turnEnd = this.waitForTurnEnd(sessionID);
      const turnDone = turnEnd.done;
      let stream = this.consumeEvents(sessionID, ctx);

      // DD-AR-1: periodic stall check while the attempt consumes the stream.
      // On stall the detector aborts the stream; the attempt returns a
      // transport-classified retryable error (180s cumulative budget).
      stallCheckTimer = setInterval(() => {
        const stall = ac.stallDetector.checkStall();
        if (stall) {
          stallDurationMs = stall.stallDurationMs;
          this.onStreamStall(stall);
        }
      }, 5_000);

      // Send the prompt.
      // P2 (CX4b): the engine may have dropped our session (internal restart /
      // session TTL) — the cached id then 404s. api() already invalidated the
      // stale cache entry, so retry once on a fresh session before failing the
      // turn. Only 404 is retried; anything else (auth, timeout, 500) throws
      // immediately.
      const postPrompt = () => {
        // DD-AR-3: resumeAction with the checkpoint state — the turn resumes
        // mid-stream instead of restarting the request. Omitted when no
        // checkpoint was received (plain retry). Our engine ignores unknown
        // body fields today; the protocol shape is Cursor's verbatim.
        const resumeAction = ac.resume.buildResumeAction(ac.originalRequestId, ac.attemptRequestId);
        return this.api(`POST`, `/api/session/${sessionID}/prompt`, {
          text: ctx.prompt,
          // Browser-tab screenshots: the engine's PromptInput.files accepts
          // {uri, name, description} — the engine reads the PNG as an image
          // part, so the agent literally sees the screenshot.
          ...(ctx.attachments && ctx.attachments.length > 0 ? { files: ctx.attachments } : {}),
          ...(resumeAction ? { resumeAction } : {}),
          // DEV-GAPS-5-SKILLS: agent skills store — the RequestContextSkillsPart
          // equivalent. Store skills the engine inventory resolves ride as
          // SkillAttachment[] {id, name} (engine schema:
          // PromptInput.Prompt.skills). Empty when the store is empty or the
          // engine knows none of them.
          ...(requestSkills.length > 0 ? { skills: requestSkills } : {}),
          // DEV-GAPS-145 `settings-attribution`: the RequestContext
          // attribution flags, Cursor-verbatim shape — each field present
          // as "enabled" only when its toggle is effective, omitted when
          // off (see readAttributionRequestContext). Like resumeAction
          // above, the engine ignores unknown body fields today; the
          // trailer insertion they gate lives agent-side in Cursor (its
          // backend/agent host) and is the documented divergence in
          // services/attribution.ts.
          ...this.readAttributionRequestContext(),
          // P1 (QA-PLANMODE Round B, P1-2(b) CORRECTION): the engine's
          // PromptInput.Prompt schema is {text, files, agents, skills} —
          // there is no per-prompt mode/readonly wire field, but the
          // SESSION already carries enforcement: ensureSession passes a
          // deny `permissions` ruleset at session.create for plan/ask
          // modes (session.create natively accepts
          // `permissions: Permission.Ruleset`), and the engine's
          // Permission.evaluate/denied hard-blocks mutating tools with
          // no approval card. The extension-side gate in handleApproval
          // (turn-mode based) remains as a second, belt-and-braces layer
          // for permission.asked flows the ruleset deliberately leaves
          // open (effect "ask").
        });
      };
      try {
        await postPrompt();
      } catch (err) {
        const status = httpStatusCode(err);
        if (status === 404) {
          this.opts.output.appendLine(
            `[ide-agent] session ${sessionID} gone (404) — retrying the prompt on a fresh session`,
          );
          // Rebind the per-turn listeners to the new session id. waitForTurnEnd's
          // listener was attached synchronously (cancel removes it); the
          // consumeEvents generator body hasn't started yet (iteration begins in
          // mergeStreams below), so its listener was never attached — re-create
          // it for symmetry.
          turnEnd.cancel();
          // P1 (QA-FILE-01): consumeEvents is declared AsyncIterable, but the
          // value is always an AsyncGenerator — cast for the .return() unwind.
          await (stream as unknown as AsyncGenerator<TurnEvent>).return?.(undefined);
          const freshSessionID = await this.ensureSession(ctx.mode);
          turnEnd = this.waitForTurnEnd(freshSessionID);
          stream = this.consumeEvents(freshSessionID, ctx);
          await postPrompt();
          return yield* this.finishAttempt(ctx, ac, turnEnd, stream, abortPromise, freshSessionID, stallDurationMs);
        }
        // DD-AR-6: 429 → InferenceProviderWarning (ON_ERROR) + fallback model.
        if (status === 429) {
          const fallbackId = await this.maybeFallbackOnRateLimit(err);
          if (fallbackId) {
            yield {
              type: "textDelta",
              bubbleId: ctx.bubbleId,
              delta: `\n\n*${RATE_LIMITED_RECONNECT_MESSAGE} Switched to fallback model ${fallbackId}.*`,
            };
            await postPrompt();
          } else {
            const classified = this.classifyPromptPostError(err);
            if (classified.retryable) {
              return {
                sessionID,
                outcome: "FAILED",
                retryableError: classified,
                progressEvents: 0,
              };
            }
            throw err;
          }
        } else {
          const classified = this.classifyPromptPostError(err);
          if (classified.retryable) {
            return {
              sessionID,
              outcome: "FAILED",
              retryableError: classified,
              progressEvents: 0,
            };
          }
          throw err;
        }
      }

      return yield* this.finishAttempt(ctx, ac, turnEnd, stream, abortPromise, sessionID, stallDurationMs);
    } finally {
      if (stallCheckTimer !== undefined) {
        clearInterval(stallCheckTimer);
      }
      // P2 (QA-04): remove the turn-end listener if the attempt finished by
      // timeout/abort/stall rather than an SSE execution event.
      turnEnd?.cancel();
      if (this.attemptAbortResolve === resolveAbort) {
        this.attemptAbortResolve = undefined;
      }
      if (this.abortResolve === resolveAbort) {
        this.abortResolve = undefined;
      }
    }
  }

  /**
   * Consume the event stream until the attempt ends (turn end, timeout,
   * abort, stall, or loop detection) and map the ending onto AttemptResult.
   */
  private async *finishAttempt(
    ctx: TurnContext,
    ac: TurnAttemptContext,
    turnEnd: {
      done: Promise<void>;
      cancel: () => void;
      getFailure: () => unknown;
      getEndKind: () => "succeeded" | "failed" | "interrupted" | undefined;
    },
    stream: AsyncIterable<TurnEvent>,
    abortPromise: Promise<void>,
    sessionID: string,
    stallDurationMs: number,
  ): AsyncGenerator<TurnEvent, AttemptResult, unknown> {
    // Yield mapped events until the attempt completes, times out, or is aborted.
    for await (const event of this.mergeStreams(stream, turnEnd.done, ac.timeoutPromise, abortPromise)) {
      // P1 (QA-FILE-01): Stop pressed — drop out promptly; the abort promise
      // in mergeStreams' race guarantees this loop terminates even with no
      // further engine events.
      if (this.turnAbortRequested) {
        break;
      }
      yield event;
    }

    // DD-AR-7: loop detected mid-stream — the outer loop applies retry_once.
    if (this.turnLoopError) {
      const err = this.turnLoopError;
      this.turnLoopError = undefined;
      return {
        sessionID,
        outcome: "FAILED",
        loopRetry: true,
        failure: err,
        failureMessage: err.message,
        progressEvents: this.turnStreamEvents,
      };
    }
    // DD-AR-1: stall abort — transport-classified, 180s cumulative budget.
    if (this.stallAbortRequested) {
      return {
        sessionID,
        outcome: "FAILED",
        retryableError: { kind: "stall", stallDurationMs },
        progressEvents: this.turnStreamEvents,
      };
    }
    if (this.turnTimedOut) {
      return {
        sessionID,
        outcome: "INTERRUPTED",
        interruptedBy: "HOST",
        failureMessage: "turn timed out after 10 minutes with no response.",
        progressEvents: this.turnStreamEvents,
      };
    }
    if (this.turnAbortRequested) {
      return {
        sessionID,
        outcome: "INTERRUPTED",
        interruptedBy: "USER",
        progressEvents: this.turnStreamEvents,
      };
    }
    const endKind = turnEnd.getEndKind();
    if (endKind === "failed") {
      // QA-FILE-03 follow-up: a failed execution used to end the turn
      // silently. Report the engine's own error.
      const failure = turnEnd.getFailure();
      const raw = (failure as { message?: unknown })?.message ?? failure;
      const msg = typeof raw === "string" ? raw : JSON.stringify(raw);
      return {
        sessionID,
        outcome: "FAILED",
        failure,
        failureMessage: msg,
        progressEvents: this.turnStreamEvents,
      };
    }
    if (endKind === "interrupted") {
      return {
        sessionID,
        outcome: "INTERRUPTED",
        interruptedBy: this.turnAbortRequested ? "USER" : "HOST",
        progressEvents: this.turnStreamEvents,
      };
    }
    return { sessionID, outcome: "COMPLETED", progressEvents: this.turnStreamEvents };
  }

  /**
   * DD-AR-1: the stall detector fired mid-turn. Abort the attempt's stream
   * WITHOUT setting turnAbortRequested (this is not a user stop): the
   * attempt returns a transport-classified retryable error and the outer
   * loop resumes after RetryState backoff (180s cumulative stall budget).
   */
  private onStreamStall(stall: StallInfo): void {
    if (!this.turnActive || this.turnAbortRequested || this.stallAbortRequested) {
      return;
    }
    this.opts.output.appendLine(
      `[ide-agent] ${stall.message} (stalled ${Math.round(stall.stallDurationMs)}ms, threshold ${stall.thresholdMs}ms) — aborting stream for transport retry`,
    );
    this.stallAbortRequested = true;
    // Suppress handleSseDrop's ad-hoc reconnect — the outer retry loop
    // re-establishes the stream after backoff.
    this.sseDropExpected = true;
    this.sseAbort?.abort();
    this.sseStarted = false;
    this.attemptAbortResolve?.();
    this.attemptAbortResolve = undefined;
  }

  /**
   * DD-AR-7: single-message loop detected on tool-call args. Abort the
   * attempt; the outer loop applies the retry_once policy.
   */
  private onLoopDetected(err: LoopDetectedError): void {
    if (!this.turnActive || this.turnAbortRequested) {
      return;
    }
    this.opts.output.appendLine(`[ide-agent] ${err.message} — policy ${SINGLE_MESSAGE_LOOP_POLICY}`);
    this.turnLoopError = err;
    this.attemptAbortResolve?.();
    this.attemptAbortResolve = undefined;
  }

  /**
   * DD-AR-2: classify a prompt-POST failure into Cursor's canonical kinds.
   * Retryable: server errors (5xx), rate-limit (429, Retry-After honored),
   * transport blips (socket_reset), request timeouts (idle_deadline).
   */
  private classifyPromptPostError(err: unknown): {
    kind: string;
    retryAfterMs?: number;
    retryable: boolean;
  } {
    const status = httpStatusCode(err);
    const retryAfterMs = (err as { retryAfterMs?: number })?.retryAfterMs;
    if (status === 429 || status === 503 || (status !== undefined && status >= 500)) {
      return { kind: "other", retryAfterMs, retryable: true };
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (/request timed out/i.test(msg)) {
      return { kind: "idle_deadline", retryAfterMs, retryable: true };
    }
    if (/socket|econn|hang up|network|fetch failed/i.test(msg)) {
      return { kind: "socket_reset", retryAfterMs, retryable: true };
    }
    return { kind: "other", retryAfterMs, retryable: false };
  }

  /**
   * DD-AR-6: on a 429 from the engine, build the InferenceProviderWarning
   * (trigger ON_ERROR) and switch to the fallback model when one resolves.
   * Returns the fallback model id, or undefined when no fallback applies.
   */
  private async maybeFallbackOnRateLimit(err: unknown): Promise<string | undefined> {
    if (httpStatusCode(err) !== 429 || !this.modelFallback) {
      return undefined;
    }
    const current = this.selectedModel
      ? `${this.selectedModel.providerID}/${this.selectedModel.id}`
      : "engine default";
    const warning = this.modelFallback.buildRateLimitWarning(current);
    const fallbackId = this.modelFallback.resolveFallback(warning);
    if (!fallbackId) {
      this.opts.output.appendLine(
        `[ide-agent] ${warning.message} (model ${current}; no fallback model configured — see ide.agent.fallbackModels)`,
      );
      return undefined;
    }
    const ref = parseModelRefString(fallbackId);
    if (!ref) {
      this.opts.output.appendLine(
        `[ide-agent] ignoring malformed fallback model id "${fallbackId}" (want "providerID/modelId")`,
      );
      return undefined;
    }
    try {
      await this.setModel(ref);
    } catch (setErr) {
      this.opts.output.appendLine(
        `[ide-agent] fallback model switch failed: ${setErr instanceof Error ? setErr.message : setErr}`,
      );
      return undefined;
    }
    return fallbackId;
  }

  /**
   * DD-AR-6: client-side feature config.
   * HONEST-DIVERGENCE: Cursor's fallback_models list is server-driven
   * (AvailableModelsResponse.FeatureModelConfig); our engine declares none,
   * so the list comes from `ide.agent.fallbackModels` until the engine
   * declares its own.
   */
  private readFallbackConfig(): FeatureModelConfig | undefined {
    try {
      const list = vscode.workspace.getConfiguration("ide.agent").get<string[]>("fallbackModels", []);
      if (!list || list.length === 0) {
        return undefined;
      }
      return { defaultModel: "", fallbackModels: list, bestOfNDefaultModels: [] };
    } catch {
      return undefined;
    }
  }

  /**
   * DEV-GAPS-145 `settings-attribution`: Cursor's request-context consumer
   * (workbench.desktop.main.js 3.25.9 @19591501 / @31614933) computes
   *   !isAttributionDisabledByAdmin() && (storage "attributeCommitsToAgent" ?? !0)
   * and puts `commitAttributionMessage:"enabled"` / `prAttributionMessage:"enabled"`
   * into the agent RequestContext, OMITTING each field when off. This fork's
   * settings surface is the `ide.git.*` configuration pair (package.json
   * "IDE Git & PRs", defaults true — the binary's `Jh(!0,-1,0)` descriptor);
   * there is no team-admin service locally, so the admin lock is false here
   * (HONEST-DIVERGENCE, see services/attribution.ts). Read per turn so a
   * settings change takes effect on the next turn, like Cursor reading
   * storage at request-build time. Config read failure → both unset →
   * binary fallback (enabled), never a fabricated off.
   */
  private readAttributionRequestContext(): AttributionRequestContext {
    let attributeCommitsToAgent: boolean | undefined;
    let attributePRsToAgent: boolean | undefined;
    try {
      const cfg = vscode.workspace.getConfiguration(ATTRIBUTION_CONFIG_SECTION);
      attributeCommitsToAgent = cfg.get<boolean>(ATTRIBUTION_COMMITS_CONFIG_KEY);
      attributePRsToAgent = cfg.get<boolean>(ATTRIBUTION_PRS_CONFIG_KEY);
    } catch {
      attributeCommitsToAgent = undefined;
      attributePRsToAgent = undefined;
    }
    return resolveAttributionRequestContext({
      adminDisabledByAdmin: false,
      attributeCommitsToAgent,
      attributePRsToAgent,
    });
  }

  /**
   * DD-AR-4: the blocking-summarization callback. Unbound by default —
   * HONEST-DIVERGENCE: the engine owns compaction server-side; the trigger
   * was detected and the turn parked through the real protocol path, there
   * is just no client summarizer to run yet. The composer can bind one via
   * IdeCodeEngineOptions.requestBlockingSummarization.
   */
  private runBlockingSummarization(trigger: SummarizationTrigger): Promise<void> {
    if (this.opts.requestBlockingSummarization) {
      return this.opts.requestBlockingSummarization(trigger);
    }
    this.opts.output.appendLine(
      `[ide-agent] blocking summarization triggered (${trigger}) but no summarizer is bound — continuing without compaction`,
    );
    return Promise.resolve();
  }

  // ---- BG-SUMMARIZATION (Cursor parity: background, never parks the turn) ----

  /**
   * Per-session transcript tracker, observed from SSE events (text deltas +
   * tool calls/results). Persists across turns; the summary input is built
   * from it when the 70% threshold fires.
   */
  private transcriptTrackerFor(mode: ModeName): TranscriptTracker {
    let tracker = this.transcriptTrackers.get(mode);
    if (!tracker) {
      tracker = new TranscriptTracker();
      this.transcriptTrackers.set(mode, tracker);
    }
    return tracker;
  }

  /**
   * Context ring (host-side live data): estimated tokens of the SSE-observed
   * conversation transcript for a mode. HONEST: chars/4 heuristic over the
   * client's observed transcript — the engine owns the authoritative history
   * server-side and reports no usage over the wire.
   */
  getConversationEstimatedTokens(mode: ModeName): number {
    return this.transcriptTrackerFor(mode).estimatedTokens();
  }

  /**
   * Context ring: the adopted background-summary text for a mode, if the
   * BackgroundSummarizer has adopted one. Undefined when no summary exists
   * (the ring then honestly reports 0 for "Summarized conversation" —
   * TODO: wire this when the summarizer adopts its first summary).
   */
  getAdoptedSummaryText(mode: ModeName): string | undefined {
    return this.bgSummarizerFor(mode).getLastAdoptedSummary()?.text;
  }

  /**
   * GAPS-167 (context usage report): the SSE-observed transcript segments
   * for a mode, for the report's Conversation category items. Returns
   * `truncated: true` when older segments were dropped at the tracker cap
   * (the report then honestly flags `incompleteReport`).
   */
  getConversationSegments(mode: ModeName): { segments: readonly string[]; truncated: boolean } {
    return this.transcriptTrackerFor(mode).getSegments();
  }

  /**
   * Context ring: the UI started a fresh chat — drop all SSE-observed
   * transcript state and adopted summaries so the ring reflects the new
   * window instead of the cleared chat's history.
   * HONEST-DIVERGENCE: the engine-side session ids are reused per mode (not
   * recreated on newChat), so the server may still hold older history until
   * its own compaction; the ring reports what this client can observe.
   */
  resetConversationTracking(): void {
    for (const t of this.transcriptTrackers.values()) {
      t.clear();
    }
    for (const b of this.bgSummarizers.values()) {
      b.reset();
    }
  }

  /**
   * Per-session background summarizer. Summary generation is REAL: the
   * engine's tool-free, history-free `session.generate` endpoint
   * (POST /api/session/:id/generate) — one LLM call, no tools, no session
   * history mutation. Rejects when the engine is unreachable; the
   * summarizer then drops the generation and NEVER fabricates text.
   * preCompact hooks run observationally before adoption (gap
   * hooks-precompact-observational: runHooks('preCompact') is finally called).
   */
  private bgSummarizerFor(mode: ModeName): BackgroundSummarizer {
    let bg = this.bgSummarizers.get(mode);
    if (!bg) {
      bg = new BackgroundSummarizer({
        generate: (input) => this.generateBackgroundSummary(mode, input),
        preCompact: async (extras) => {
          if (this.opts.hooks?.hasHooks("preCompact")) {
            return this.opts.hooks.runHooks(
              "preCompact",
              { sessionID: this.sessions.get(mode), ...extras },
              this.opts.hookScope ?? "",
            );
          }
          return undefined;
        },
        log: (m) => this.opts.output.appendLine(`[ide-agent] ${m}`),
      });
      this.bgSummarizers.set(mode, bg);
    }
    return bg;
  }

  /** Estimated context-window size (tokens) for the 70% background threshold. */
  private backgroundSummaryContextWindowTokens(): number {
    return (
      this.opts.backgroundSummaryContextWindowTokens ??
      DEFAULT_BACKGROUND_SUMMARY_CONTEXT_WINDOW_TOKENS
    );
  }

  /**
   * Accumulate observed stream chars into this turn's token estimate and
   * start the background summary (fire-and-forget, at most once per turn)
   * when the estimate reaches the 70% threshold.
   */
  private observeBgSummaryChars(chars: number): void {
    if (!this.turnActive || chars <= 0) {
      return;
    }
    this.turnEstimatedTokenChars += chars;
    if (this.bgSummaryStartedThisTurn) {
      return;
    }
    const bg = this.turnBgSummarizer;
    const tracker = this.turnTranscriptTracker;
    if (!bg || !tracker) {
      return;
    }
    const estimatedTokens = Math.ceil(this.turnEstimatedTokenChars / 4);
    if (
      meetsBackgroundSummaryThreshold(estimatedTokens, this.backgroundSummaryContextWindowTokens())
    ) {
      this.bgSummaryStartedThisTurn = true;
      bg.start(tracker.buildSummaryInput("threshold"));
    }
  }

  /**
   * REAL summary generation via the engine's session.generate endpoint.
   * Rejects when the engine is unreachable or returns no text — the caller
   * (BackgroundSummarizer) drops the generation instead of fabricating one.
   */
  private async generateBackgroundSummary(
    mode: ModeName,
    input: SummaryGenerationInput,
  ): Promise<string> {
    const sessionID = this.sessions.get(mode);
    if (!sessionID) {
      throw new Error("no live engine session for background summarization");
    }
    const prompt = buildBackgroundSummaryPrompt(input);
    const res = await this.api(
      "POST",
      `/api/session/${encodeURIComponent(sessionID)}/generate`,
      { prompt },
      undefined,
      BACKGROUND_SUMMARY_GENERATE_TIMEOUT_MS,
    );
    const text = res?.data?.text;
    if (typeof text !== "string" || text.length === 0) {
      throw new Error("engine session.generate returned no text — refusing to fabricate a summary");
    }
    return text;
  }

  /** DD-AR-8: whether the approval shadow-mode protocol is active. */
  private isApprovalShadowMode(): boolean {
    try {
      return (
        vscode.workspace.getConfiguration("ide.agent").get<boolean>("smart_mode_classifier_shadow_mode", false) === true
      );
    } catch {
      return false;
    }
  }

  /**
   * DD-AR-8: client-side heuristic standing in for Cursor's server-side
   * smart-mode classifier (HONEST-DIVERGENCE — see runShadowClassifier).
   * Predicts what the ENFORCE path would do: "block" = would prompt or
   * deny, "allow" = would auto-approve. Runs only in shadow mode; never blocks.
   */
  private evaluateShadowVerdict(
    action: string,
    ctx: { blockedByMode: boolean; blockedByHook: boolean; autoApprovedByRunMode: boolean },
  ): ShadowVerdict {
    if (ctx.blockedByMode || ctx.blockedByHook) {
      return "block";
    }
    if (ctx.autoApprovedByRunMode) {
      return "allow";
    }
    // Heuristic: read-only tools would auto-approve; mutating tools would prompt.
    if (READ_ONLY_TOOL_ACTIONS.has(action.toLowerCase())) {
      return "allow";
    }
    return "block";
  }

  /** Spawn the sidecar server on a free loopback port; wait for readiness. */
  private ensureServer(): Promise<void> {
    // P2 (QA-CHATTABS Round B, R1): never spawn for a disposed tab.
    if (this.disposed) {
      return Promise.reject(new Error("engine disposed — refusing to spawn a sidecar for a dead tab"));
    }
    if (this.port) {
      return Promise.resolve();
    }
    if (!this.starting) {
      this.starting = this.startServer();
    }
    return this.starting;
  }

  private async startServer(): Promise<void> {
    // ENGINE PACKAGING: a broken bundled engine gets its specific
    // diagnostic, not the generic setting-oriented message below.
    if (this.opts.enginePathDiagnostic) {
      throw new Error(this.opts.enginePathDiagnostic);
    }
    const enginePath = this.opts.enginePath;
    // ENGINE PACKAGING (compile path B): the spawn branch is chosen by
    // the layout the resolver detected on disk. Unset layout (every
    // pre-packaging caller/test) means "tree" — behavior unchanged.
    const engineLayout: EngineLayout = this.opts.engineLayout ?? "tree";
    // P0 (QA-03): validate enginePath before spawning — must exist and contain
    // the expected engine entry point. Defense in depth alongside machine-scoped config.
    // Tree layout validates the serve entry; binary layout validates the
    // compiled binary file instead (fail-closed, same bundled-incomplete
    // family as the resolver diagnostic).
    let entry = "";
    let binaryPath = "";
    if (engineLayout === "binary") {
      binaryPath = bundledBinaryPath(enginePath);
      if (!fs.existsSync(binaryPath)) {
        throw new Error(
          `[ide-agent] Bundled engine is incomplete: ${enginePath} does not contain the compiled engine binary ${binaryPath}. ` +
          `Reinstall the app, or set the ide.agent.enginePath setting (machine scope) to a valid engine checkout.`
        );
      }
    } else {
      entry = path.join(enginePath, "packages", "cli", "src", "index.ts");
      if (!fs.existsSync(entry)) {
        throw new Error(
          `[ide-agent] Invalid enginePath: ${enginePath} does not contain packages/cli/src/index.ts. ` +
          `Check the ide.agent.enginePath setting (machine scope).`
        );
      }
    }
    this.port = await freePort();

    // DEV-GAPS-25: dispose() may have run while we awaited a free port (the
    // composer can be disposed before the first turn's spawn completes — e.g.
    // a test's file-level teardown, or a tab closed mid-boot in production).
    // Never spawn a sidecar for a dead tab: without this check the orphaned
    // `bun serve` (piped stdio) keeps the event loop alive forever.
    if (this.disposed) {
      this.port = 0;
      this.starting = undefined;
      throw new Error("engine disposed — aborting sidecar spawn");
    }

    // P1 (QA-03): generate a random token; the sidecar requires it via
    // OPENCODE_PASSWORD (HTTP Basic auth, username "opencode").
    this.authToken = crypto.randomBytes(32).toString("hex");
    if (engineLayout === "binary") {
      this.opts.output.appendLine(`[ide-agent] starting engine: ${binaryPath} serve --port ${this.port}`);
    } else {
      this.opts.output.appendLine(`[ide-agent] starting engine: ${this.opts.bunPath ?? "bun"} ${entry} serve --port ${this.port}`);
    }
    // DEV-GAPS-40 (subagent-nested): Cursor allows one nested subagent
    // level (main → subagent → sub-subagent); the engine's default
    // (experimental.subagent_depth = 1) forbids it. Inject the Cursor-parity
    // default via OPENCODE_CONFIG_CONTENT (the engine's serve path reads
    // it — packages/cli/src/server-process.ts) ONLY when the user has not
    // configured the key themselves (see subagentNesting.ts).
    const spawnEnv: Record<string, string | undefined> = {
      ...process.env,
      NO_COLOR: "1",
      OPENCODE_PASSWORD: this.authToken,
    };
    const nestingContent = resolveSubagentDepthConfigContent({
      existingEnvContent: process.env.OPENCODE_CONFIG_CONTENT,
      userConfigTexts: readConfigTexts(
        engineConfigFilePaths({
          globalConfigDir:
            process.env.XDG_CONFIG_HOME && path.isAbsolute(process.env.XDG_CONFIG_HOME)
              ? path.join(process.env.XDG_CONFIG_HOME, "opencode")
              : path.join(os.homedir(), ".config", "opencode"),
          workspaceRoots: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
          explicitConfigPath: process.env.OPENCODE_CONFIG,
        }),
      ),
    });
    if (nestingContent !== undefined) {
      spawnEnv.OPENCODE_CONFIG_CONTENT = nestingContent;
      this.opts.output.appendLine(
        `[ide-agent] engine default: experimental.subagent_depth=2 (Cursor one-level nesting)`,
      );
    }
    // ENGINE PACKAGING (spec §4 / D5, BRANCH B): bundled engines spawn
    // from a writable user-data dir (install tree may be read-only); the
    // dir is created here, immediately before spawn.
    if (this.opts.engineCwd) {
      fs.mkdirSync(this.opts.engineCwd, { recursive: true });
    }
    const spawnCwd = this.opts.engineCwd ?? enginePath;
    if (engineLayout === "binary") {
      // ENGINE PACKAGING — binary branch (compile path B): spawn the
      // compiled binary DIRECTLY with the same serve argv the tree
      // branch hands to bun. No bun (the binary is self-contained) and
      // NO `--preload` (adjudication N1 scopes the Solid preload to
      // bun/tree spawns; the compiled binary already embeds it).
      // The engine locates ripgrep by searching PATH (engine
      // packages/core/src/ripgrep/binary.ts: `which(rg, …, global.bin)`),
      // and the staged `rg[.exe]` sits NEXT TO the binary — so the
      // engine root is prepended to the child's PATH, or the engine
      // would fall back to downloading rg from GitHub at runtime.
      const pathKey = Object.keys(spawnEnv).find((k) => k.toLowerCase() === "path") ?? "PATH";
      const existingPath = spawnEnv[pathKey];
      spawnEnv[pathKey] = existingPath ? enginePath + path.delimiter + existingPath : enginePath;
      if (!fs.existsSync(path.join(enginePath, BUNDLED_RIPGREP_FILE))) {
        this.opts.output.appendLine(
          `[ide-agent] bundled binary engine: no ${BUNDLED_RIPGREP_FILE} next to ${binaryPath}; the engine will use a system rg if one is on PATH, else try to download it`,
        );
      }
      if (!this.opts.engineCwd) {
        this.opts.output.appendLine(
          `[ide-agent] bundled binary engine: no writable runtime cwd was provided; spawning with cwd = engine dir (install tree may be read-only)`,
        );
      }
      this.serverProc = childProcess.spawn(binaryPath, ["serve", "--port", String(this.port), "--hostname", "127.0.0.1"], {
        cwd: spawnCwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: spawnEnv,
      });
    } else {
      // ENGINE PACKAGING — F-W4-1 delta (adjudication N1,
      // w6-f-w4-1-experiment.md §6.1): Bun only loads bunfig.toml at the
      // exact spawn cwd, so the relative Solid preload in the engine
      // root bunfig never fires when a bundled TREE engine spawns from
      // the user-data cwd above — serve dies with "Cannot find module
      // 'react/jsx-dev-runtime'". Bundled tree spawns therefore pass
      // the closure's preload script as an absolute `--preload`
      // argument BEFORE the entry. Dev/setting spawns keep the plain
      // argv (they run inside the monorepo, where bunfig/hoisting
      // applies). A bundled tree without the preload file is a broken
      // package: throw the bundled-incomplete diagnostic instead of
      // spawning blind.
      const serveArgs = [entry, "serve", "--port", String(this.port), "--hostname", "127.0.0.1"];
      if (this.opts.engineSource === "bundled") {
        const preloadPath = bundledServePreloadPath(enginePath);
        if (!fs.existsSync(preloadPath)) {
          throw new Error(
            `[ide-agent] Bundled engine is incomplete: ${enginePath} exists but ` +
              `packages/cli/node_modules/@opentui/solid/scripts/preload.js is missing. ` +
              `Reinstall the app, or set the ide.agent.enginePath setting (machine scope) to a valid engine checkout.`,
          );
        }
        serveArgs.unshift("--preload", preloadPath);
        this.opts.output.appendLine(`[ide-agent] bundled engine: bun --preload ${preloadPath} (F-W4-1/N1)`);
      }
      this.serverProc = childProcess.spawn(this.opts.bunPath ?? "bun", serveArgs, {
        cwd: spawnCwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: spawnEnv,
      });
    }
    this.serverProc.on("error", (err) => {
      const bunPath = this.opts.bunPath ?? "bun";
      this.opts.output.appendLine(
        path.isAbsolute(bunPath)
          ? `[ide-agent] failed to spawn bundled bun at ${bunPath}: ${err.message}`
          : `[ide-agent] failed to spawn bun (${err.message}) — check that bun is installed and on PATH`,
      );
    });
    this.serverProc.stdout?.on("data", (d: Buffer) => this.opts.output.append(`[engine] ${d.toString()}`));
    this.serverProc.stderr?.on("data", (d: Buffer) => this.opts.output.append(`[engine:err] ${d.toString()}`));
    this.serverProc.on("exit", (code) => {
      this.opts.output.appendLine(`[ide-agent] engine exited (code ${code}); will respawn on next turn`);
      // P2 (QA-FILE-03): the sidecar dying mid-turn used to leave the turn
      // hanging until the 10-min watchdog — the SSE drop alone never wakes
      // consumeEvents (its notify only fires on parsed events). Push a visible
      // error AND synthesize session.execution.failed for every live session
      // so waitForTurnEnd resolves and the turn ends promptly with the error
      // shown (mergeStreams' drain flushes the queued error before exiting).
      const wasActive = this.turnActive;
      // DEV-MULTITASK: include worker sessions so a dead sidecar fails
      // silent worker turns fast (their waitForTurnEnd listeners resolve via
      // the synthesized session.execution.failed below) instead of hanging
      // them until the worker timeout. Workers don't set turnActive, so
      // check for live worker sessions too.
      const liveSessions = [...this.sessions.values(), ...this.workerSessionIDs];
      const hadWorkers = this.workerSessionIDs.size > 0;
      this.port = 0;
      this.authToken = undefined;
      this.starting = undefined;
      this.sessions.clear();
      // Worker ids belong to the dead sidecar too.
      this.workerSessionIDs.clear();
      if (wasActive || hadWorkers) {
        this.turnFail?.(`engine exited unexpectedly (code ${code})`);
        for (const sid of liveSessions) {
          for (const fn of [...this.listeners]) {
            try {
              fn({ type: "session.execution.failed", data: { sessionID: sid } });
            } catch {
              /* listener errors must not kill the exit handler */
            }
          }
        }
      }
    });

    // Wait for readiness: poll /api/config until 200 (30s cap).
    const deadline = Date.now() + 30_000;
    for (;;) {
      // DEV-GAPS-25: abort promptly when disposed mid-boot. dispose() kills
      // the sidecar, but without this check the loop would spin on a dead
      // port until the 30s deadline, holding the event loop with its timers.
      if (this.disposed) {
        this.serverProc = undefined;
        this.port = 0;
        this.authToken = undefined;
        this.starting = undefined;
        throw new Error("engine disposed — aborting sidecar boot wait");
      }
      try {
        await this.api("GET", "/api/config");
        this.opts.output.appendLine(`[ide-agent] engine ready on 127.0.0.1:${this.port}`);
        return;
      } catch {
        if (Date.now() > deadline) {
          // P0 fix: reset all spawn state so the next turn retries cleanly
          // instead of trusting a dead port forever.
          this.serverProc?.kill("SIGKILL");
          this.serverProc = undefined;
          this.port = 0;
          this.authToken = undefined;
          this.starting = undefined;
          this.sessions.clear();
          throw new Error("ide-code engine did not become ready within 30s — check the IDE Agent output channel");
        }
        await sleep(400);
      }
    }
  }

  private async ensureSession(mode: ModeName): Promise<string> {
    const cached = this.sessions.get(mode);
    if (cached) {
      return cached;
    }
    // M-03: pass the picker's explicit model selection at creation so the
    // first turn of a new session already runs on the chosen model. Omitted
    // when the selection is "auto" (engine default).
    // P1 (QA-PLANMODE Round B, P1-2(b)): read-only modes (plan/ask) pass a
    // session-level deny ruleset here. session.create natively accepts
    // `permissions: Permission.Ruleset` (protocol/src/groups/session.ts),
    // so this is pure extension-lane: the engine enforces it via
    // Permission.evaluate (findLast — session rules override agent rules)
    // and denied() raises BlockedError with NO Permission.Event.Asked,
    // i.e. mutating tools are hard-blocked with no approval card. This is
    // also the durable fix for the MCP mutating-tool residual bypass:
    // mcp__* is deny-by-default at the engine layer, with a read-only
    // allowlist. Agent mode (and other non-read-only modes) send no
    // permissions — behavior unchanged.
    const permissions = sessionPermissionsForMode(mode);
    const res = await this.api("POST", "/api/session", {
      title: `IDE Agent (${mode})`,
      ...(this.selectedModel ? { model: toWireModelRef(this.selectedModel) } : {}),
      ...(permissions ? { permissions } : {}),
    });
    const sessionID = res.data.id as string;
    // P2 (QA-FILE-03): a missing/non-string id would put "undefined" in every
    // URL, and waitForTurnEnd(undefined) would then match ANY event with no
    // sessionID — cross-session turn-end confusion. Fail fast instead.
    if (typeof sessionID !== "string" || sessionID.length === 0) {
      throw new Error(
        `[ide-agent] engine returned an invalid session id: ${JSON.stringify(res.data).slice(0, 200)}`,
      );
    }
    this.sessions.set(mode, sessionID);
    this.opts.output.appendLine(`[ide-agent] session ${sessionID} (mode ${mode})`);
    // DEV-GAPS-34 (hooks-21-events): sessionStart — fire-and-forget.
    // DEV-GAPS-112 (hooks-sessionstart-payload): payload verbatim per
    // Cursor 3.25.9 createComposerImpl (desk@31874628):
    //   { conversation_id: g, generation_id: "", model: L, ...modelFields,
    //     is_background_agent: x, composer_mode: E.unifiedMode }
    // g is the COMPOSER id — the fork's composer id is its hookScope
    // (ComposerDataService.composerId === hookScope; sessionEnd already
    // keys on it), NOT the engine session id used before. session_id is
    // synthesized by HookService as session_id ?? conversation_id (Cursor
    // executeHookForStep, desk@32523436), so session_id === conversation_id
    // here, as the docs require. L = getHookModelString(f) || "unknown"
    // (legacy slug; the fork has no legacy-slug table, so the selected
    // model's id is the model string — divergence noted in work-notes
    // gaps112) and modelFields = { model_id } (getHookModelFields,
    // desk@18807159; model_params omitted — the fork has no model-parameter
    // resolution, and Cursor only sends it when params resolve).
    // x = !!createdFromBackgroundAgent — adapter sessions are interactive
    // composer sessions, never background-agent creations, so false.
    // The hook's `env` / `additional_context` outputs are applied by
    // HookService (sessionEnvironments + scoped context drain).
    if (this.opts.hooks?.hasHooks("sessionStart")) {
      const conversationId = this.opts.hookScope ?? sessionID;
      void this.opts.hooks.runHooks("sessionStart", {
        conversation_id: conversationId,
        generation_id: "",
        model: this.selectedModel?.id ?? "unknown",
        ...(this.selectedModel ? { model_id: this.selectedModel.id } : {}),
        is_background_agent: false,
        composer_mode: mode,
      }, this.opts.hookScope ?? "").catch(() => {});
    }
    return sessionID;
  }

  /**
   * DEV-MULTITASK: create a silent worker session scoped to one directory
   * (a git worktree). The session is NOT registered in the per-mode
   * `sessions` map — worker ids live in `workerSessionIDs` and never touch
   * chat bubbles or mode sessions.
   *
   * Wire note (verified against packages/protocol/src/groups/session.ts +
   * packages/server/src/handlers/session.ts): session.create takes
   * `location: Location.PublicRef` (`{ directory }`), not a bare
   * `directory` field — the method signature keeps `directory` and maps it
   * to `location.directory` here.
   */
  public async createWorkerSession(directory: string, title: string): Promise<string> {
    await this.ensureServer();
    const res = await this.api("POST", "/api/session", {
      title,
      location: { directory },
    });
    const sessionID = res?.data?.id;
    // Same fail-fast as ensureSession: a missing/non-string id would put
    // "undefined" in every URL and match ANY event in waitForTurnEnd.
    if (typeof sessionID !== "string" || sessionID.length === 0) {
      throw new Error(
        `[ide-agent] engine returned an invalid session id for the worker session: ${JSON.stringify(res?.data).slice(0, 200)}`,
      );
    }
    this.opts.output.appendLine(`[ide-agent] worker session ${sessionID} (${directory})`);
    return sessionID;
  }

  /**
   * DEV-MULTITASK: run one silent worker turn on a worker session.
   * POSTs the prompt, then reuses the existing SSE/turn-wait machinery
   * (waitForTurnEnd + the shared listener set) filtered to that sessionID —
   * no new transport. Text deltas for the session are accumulated and the
   * worker's final text output is returned. No chat bubbles, no mode
   * sessions, no UI events.
   *
   * Worker approvals auto-run: multitask mode has autoRun=true (spec §4 M4),
   * so `permission.asked` for worker sessions is replied "once" without
   * prompting the user (the main turn's approval path never sees worker
   * sessions — it filters on the turn's session id).
   *
   * Rejects on: prompt POST failure (404 → one fresh-session retry, mirroring
   * runTurnAttempt), engine-reported turn failure, interruption, and the
   * timeout (opts.timeoutMs, default 10 min). The rejection message carries
   * the partial output so the orchestrator can report it honestly.
   */
  public async runWorkerTurn(sessionID: string, prompt: string, opts?: { timeoutMs?: number }): Promise<string> {
    await this.ensureServer();
    this.workerSessionIDs.add(sessionID);
    this.ensureWorkerApprovalListener();
    let text = "";
    const onEvent = (ev: SseEvent): void => {
      if (ev.data?.sessionID !== sessionID) {
        return;
      }
      // Current engine stream (session.text.delta) + the V1-compat stream
      // (message.part.delta) both carry final text.
      if (
        (ev.type === "session.text.delta" || ev.type === "message.part.delta") &&
        typeof ev.data?.delta === "string" &&
        ev.data.delta.length > 0
      ) {
        text += ev.data.delta;
      }
    };
    this.addListener(onEvent);
    const turnEnd = this.waitForTurnEnd(sessionID);
    const timeoutMs = opts?.timeoutMs ?? 10 * 60 * 1000;
    try {
      try {
        await this.api("POST", `/api/session/${encodeURIComponent(sessionID)}/prompt`, { text: prompt });
      } catch (err) {
        // The engine dropped our worker session (restart/TTL). Unlike chat
        // turns there is no mode-keyed cache to recreate from, and the old
        // session's directory is not recoverable from the id alone — fail
        // the worker honestly so the orchestrator reports it (it does NOT
        // silently recreate a session in the wrong directory).
        if (httpStatusCode(err) === 404) {
          this.opts.output.appendLine(`[ide-agent] worker session ${sessionID} gone (404) — worker failed`);
        }
        throw err;
      }
      let timedOut = false;
      await Promise.race([
        turnEnd.done,
        sleep(timeoutMs).then(() => {
          timedOut = true;
        }),
      ]);
      if (timedOut) {
        throw new Error(
          `[ide-agent] worker turn timed out after ${timeoutMs}ms (partial output: ${text.slice(0, 500)})`,
        );
      }
      const endKind = turnEnd.getEndKind();
      if (endKind === "failed") {
        const failure = turnEnd.getFailure();
        const raw = (failure as { message?: unknown })?.message ?? failure;
        const msg = typeof raw === "string" ? raw : JSON.stringify(raw);
        throw new Error(`[ide-agent] worker turn failed: ${msg} (partial output: ${text.slice(0, 500)})`);
      }
      if (endKind === "interrupted") {
        throw new Error(
          `[ide-agent] worker turn was interrupted (partial output: ${text.slice(0, 500)})`,
        );
      }
      return text;
    } finally {
      turnEnd.cancel();
      this.removeListener(onEvent);
      this.workerSessionIDs.delete(sessionID);
    }
  }

  /**
   * DEV-MULTITASK: register (once) the auto-approve listener for worker
   * sessions. Multitask workers run with autoRun=true (spec §4 M4) — the
   * engine's permission.asked is answered "once" directly, so silent worker
   * turns can never wedge waiting for an approval card nobody sees.
   */
  private ensureWorkerApprovalListener(): void {
    if (this.workerApprovalListenerRegistered) {
      return;
    }
    this.workerApprovalListenerRegistered = true;
    const onEvent = (ev: SseEvent): void => {
      if (ev.type !== "permission.asked") {
        return;
      }
      const sid = ev.data?.sessionID;
      const requestID = ev.data?.id;
      if (typeof sid !== "string" || !this.workerSessionIDs.has(sid)) {
        return;
      }
      if (typeof requestID !== "string" || requestID.length === 0) {
        return;
      }
      this.opts.output.appendLine(
        `[ide-agent] multitask worker ${sid}: auto-approving permission ${requestID} (${ev.data?.action ?? "tool"})`,
      );
      void this.api("POST", `/api/session/${sid}/permission/${requestID}/reply`, { decision: "once" }).catch(
        (err) => {
          this.opts.output.appendLine(
            `[ide-agent] worker permission reply failed: ${err instanceof Error ? err.message : err}`,
          );
        },
      );
    };
    this.addListener(onEvent);
  }

  /**
   * P2 (CX4b): drop a cached session id the engine has 404'd (internal
   * restart / session TTL). The next ensureSession() creates a fresh one, so
   * one dead session can't fail every subsequent turn until reload.
   */
  private invalidateSession(sessionID: string): void {
    for (const [mode, id] of this.sessions) {
      if (id === sessionID) {
        this.sessions.delete(mode);
        this.opts.output.appendLine(`[ide-agent] dropped stale session ${sessionID} (mode ${mode})`);
      }
    }
  }

  /**
   * GAPS-183: whether the sidecar server has actually been started by this
   * adapter. `listModels()`/`getDefaultModel()` call `ensureServer()`,
   * which SPAWNS the sidecar — callers that only need the model catalog
   * opportunistically (e.g. the context ring's denominator refresh) must
   * check this first so they never spawn a process just to read metadata.
   */
  get hasStartedServer(): boolean {
    return this.port !== 0;
  }

  /**
   * M-03 (model picker): list the engine's model catalog.
   * GET /api/model → { data: Model.Info[], location } (Location.response).
   */
  async listModels(): Promise<EngineModelInfo[]> {
    await this.ensureServer();
    const res = await this.api("GET", "/api/model");
    const raw = Array.isArray(res) ? res : Array.isArray(res?.data) ? res.data : [];
    return raw
      .filter((m: any): m is Record<string, unknown> => {
        const r = m as Record<string, unknown>;
        return !!r && typeof r.id === "string" && typeof r.providerID === "string";
      })
      .map((m: Record<string, unknown>) => {
        const id = String(m.id);
        const providerID = String(m.providerID);
        const name = typeof m.name === "string" && m.name.trim().length > 0 ? m.name : id;
        const variant = typeof m.variant === "string" && m.variant.length > 0 ? m.variant : undefined;
        // DEV-GAPS-88: context window from the engine's Model.Info
        // `limit.context` (Cursor AvailableModel `contextTokenLimit`).
        // The engine wire has no max-mode limit, so
        // contextTokenLimitForMaxMode stays undefined (not fabricated).
        const contextTokenLimit = contextTokenLimitFromEngineModel(m);
        return {
          id,
          providerID,
          name,
          ...(variant ? { variant } : {}),
          ...(contextTokenLimit !== undefined ? { contextTokenLimit } : {}),
        };
      });
  }

  /**
   * M-03 (model picker): the engine's default model — "the model used when a
   * session has no explicit model selection" (protocol: model.default).
   */
  async getDefaultModel(): Promise<EngineModelInfo | undefined> {
    await this.ensureServer();
    const res = await this.api("GET", "/api/model/default");
    const m = res?.data as Record<string, unknown> | undefined;
    if (!m || typeof m.id !== "string" || typeof m.providerID !== "string") {
      return undefined;
    }
    const id = String(m.id);
    const providerID = String(m.providerID);
    const name = typeof m.name === "string" && m.name.trim().length > 0 ? m.name : id;
    // DEV-GAPS-88: same Model.Info wire shape as listModels — carry the
    // context window (`limit.context`) when the engine reports one.
    const contextTokenLimit = contextTokenLimitFromEngineModel(m);
    return { id, providerID, name, ...(contextTokenLimit !== undefined ? { contextTokenLimit } : {}) };
  }

  /**
   * M-03 (model picker): switch the model for every live engine session via
   * POST /api/session/:sessionID/model, and record the selection so future
   * sessions are created with it. `ref` undefined = "auto": future sessions
   * are created without an explicit model (engine default); live sessions are
   * switched to the engine default when one is known, otherwise left alone
   * (the wire has no "unset model" — only explicit Model.Ref switches).
   */
  async setModel(ref: ModelRef | undefined): Promise<void> {
    let effective = ref;
    if (!effective) {
      try {
        const def = await this.getDefaultModel();
        effective = def ? { id: def.id, providerID: def.providerID, variant: def.variant } : undefined;
      } catch (err) {
        // Best effort: a failed default lookup must not block the "auto"
        // selection itself (future sessions still get the engine default).
        this.opts.output.appendLine(
          `[ide-agent] model.default lookup failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    this.selectedModel = ref;
    const failures: string[] = [];
    for (const sessionID of this.sessions.values()) {
      if (!effective) {
        continue;
      }
      try {
        await this.api("POST", `/api/session/${encodeURIComponent(sessionID)}/model`, {
          model: toWireModelRef(effective),
        });
        this.opts.output.appendLine(`[ide-agent] session ${sessionID} model → ${effective.providerID}/${effective.id}`);
      } catch (err) {
        failures.push(`${sessionID}: ${err instanceof Error ? err.message : err}`);
      }
    }
    if (failures.length > 0) {
      throw new Error(`model switch failed for ${failures.length} session(s): ${failures.join("; ")}`);
    }
    this.opts.output.appendLine(
      `[ide-agent] model selection: ${ref ? `${ref.providerID}/${ref.id}` : "auto (engine default)"}`,
    );
  }

  // ---- IDE Tab completion -------------------------------------------------
  // The Tab backend's lightweight completion path. Uses the engine's
  // purpose-built `session.generate` endpoint
  // (POST /api/session/:sessionID/generate — "Generate transient text from
  // the current session context without mutating session history") instead of
  // the agentic prompt+SSE turn pipeline, because a completion must be:
  //   - tool-free: `generate` is a single LLM call, so there is no
  //     permission.asked round-trip that could deadlock (the adapter drops
  //     approvals when no chat turn is active, which would hang every
  //     completion whose model tried a tool until the client's timeout);
  //   - history-free: each call is transient — per-keystroke completions must
  //     not append to a session transcript (unbounded context growth);
  //   - abortable: unary HTTP, destroyed client-side on signal abort.
  // The SAME sidecar process is reused (ensureServer is idempotent); only a
  // dedicated lightweight "tab" session is created once and reused.

  /** Dedicated tab-completion session id (separate from the per-mode chat sessions). */
  private tabSessionID?: string;
  /**
   * Compound "providerID/modelID" the tab session currently runs on, or
   * undefined = engine default. Compared against the requested modelOverride
   * so a model switch reuses the session via POST /:id/model instead of
   * recreating it.
   */
  private tabSessionModelID?: string;

  /**
   * Fail-closed permissions for the tab session: a completion must never run
   * tools. (Belt-and-braces — `session.generate` performs no tool calls
   * anyway; this guards against future engine behavior changes.) Shape is the
   * engine's own deny-all convention (core/src/permission.ts
   * missingAgentPermissions).
   */
  private static readonly TAB_SESSION_PERMISSIONS = [{ action: "*", resource: "*", effect: "deny" }];

  /**
   * Stream one code completion from the engine. Yields the generated text
   * (currently a single chunk — `session.generate` is unary). Rejects when
   * the engine is unreachable; the caller must never substitute fake text.
   */
  async *completeCode(
    prefix: string,
    suffix: string,
    modelId: string | undefined,
    signal: AbortSignal,
    context?: { languageId?: string; fileName?: string },
  ): AsyncIterable<string> {
    await this.ensureServer();
    const prompt = buildTabCompletionPrompt(prefix, suffix, context);
    const postGenerate = (sessionID: string) =>
      this.api("POST", `/api/session/${encodeURIComponent(sessionID)}/generate`, { prompt }, signal);
    let sessionID = await this.ensureTabSession(modelId);
    let res: any;
    try {
      res = await postGenerate(sessionID);
    } catch (err) {
      // The engine dropped our tab session (restart/TTL) — recreate once and
      // retry, mirroring the 404-retry in runTurnAttempt.
      if (httpStatusCode(err) === 404) {
        this.opts.output.appendLine(`[ide-agent] tab session ${sessionID} gone (404) — recreating`);
        this.tabSessionID = undefined;
        sessionID = await this.ensureTabSession(modelId);
        res = await postGenerate(sessionID);
      } else {
        throw err;
      }
    }
    const text = res?.data?.text;
    if (typeof text !== "string") {
      throw new Error("[ide-agent] engine session.generate returned no text");
    }
    yield text;
  }

  /**
   * Create (once) and return the dedicated tab-completion session. When the
   * requested model differs from the session's current one, switch it via
   * POST /:id/model; a failed switch falls through to recreation. A malformed
   * modelId is logged and ignored (engine default) — never fatal.
   */
  private async ensureTabSession(modelId: string | undefined): Promise<string> {
    const want = modelId && modelId.length > 0 ? modelId : undefined;
    if (this.tabSessionID && this.tabSessionModelID === want) {
      return this.tabSessionID;
    }
    if (this.tabSessionID && this.tabSessionModelID !== want) {
      const ref = want ? parseModelRefString(want) : undefined;
      if (ref) {
        try {
          await this.api("POST", `/api/session/${encodeURIComponent(this.tabSessionID)}/model`, {
            model: toWireModelRef(ref),
          });
          this.opts.output.appendLine(`[ide-agent] tab session ${this.tabSessionID} model → ${want}`);
          this.tabSessionModelID = want;
          return this.tabSessionID;
        } catch (err) {
          // Switch failed (stale session, unknown model) — recreate below.
          this.opts.output.appendLine(
            `[ide-agent] tab session model switch failed: ${err instanceof Error ? err.message : err} — recreating`,
          );
          this.tabSessionID = undefined;
        }
      } else {
        // Back to engine default (or malformed id) — the session carries an
        // explicit model, so recreate without one.
        this.tabSessionID = undefined;
      }
    }
    const ref = want ? parseModelRefString(want) : undefined;
    if (want && !ref) {
      this.opts.output.appendLine(
        `[ide-agent] ignoring malformed tab model id "${want}" (want "providerID/modelID") — using engine default`,
      );
    }
    if (ref) {
      // Fail fast on a stale override (model removed from the catalog):
      // without this, every completion would hang until the client's fetch
      // timeout instead of surfacing the real problem. A catalog lookup
      // failure itself is non-fatal — skip validation then.
      try {
        const catalog = await this.listModels();
        const known = catalog.some((m) => m.providerID === ref.providerID && m.id === ref.id);
        if (!known) {
          throw new Error(
            `[ide-agent] tab model "${want}" is not in the engine's model catalog — re-pick via "IDE Tab: Pick model…"`,
          );
        }
      } catch (err) {
        if (err instanceof Error && err.message.includes("is not in the engine's model catalog")) {
          throw err;
        }
        this.opts.output.appendLine(
          `[ide-agent] tab model catalog lookup failed (${err instanceof Error ? err.message : err}) — skipping validation`,
        );
      }
    }
    const res = await this.api("POST", "/api/session", {
      title: "IDE Tab completion",
      ...(ref ? { model: toWireModelRef(ref) } : {}),
      permissions: IdeCodeEngineAdapter.TAB_SESSION_PERMISSIONS,
    });
    const sessionID = res?.data?.id;
    if (typeof sessionID !== "string" || sessionID.length === 0) {
      throw new Error(
        `[ide-agent] engine returned an invalid session id for the tab session: ${JSON.stringify(res?.data).slice(0, 200)}`,
      );
    }
    this.opts.output.appendLine(`[ide-agent] tab session ${sessionID}${ref ? ` (model ${want})` : ""}`);
    this.tabSessionID = sessionID;
    this.tabSessionModelID = ref ? want : undefined;
    return sessionID;
  }

  /**
   * Resolves when this session's execution ends (succeeded/failed/interrupted).
   * Returns a cancel function — call it if the turn ends by timeout instead of
   * an SSE event, otherwise the listener leaks (P2 QA-04).
   * getFailure() returns the engine's error payload when the turn failed, so
   * runTurn can show WHY instead of ending silently (QA-FILE-03 follow-up).
   * getEndKind() reports which terminal event ended the turn (DD-AR-9:
   * feeds the turnSettled outcome mapping).
   */
  private waitForTurnEnd(sessionID: string): {
    done: Promise<void>;
    cancel: () => void;
    getFailure: () => unknown;
    getEndKind: () => "succeeded" | "failed" | "interrupted" | undefined;
  } {
    let check: ((ev: SseEvent) => void) | undefined;
    let failure: unknown;
    let endKind: "succeeded" | "failed" | "interrupted" | undefined;
    const done = new Promise<void>((resolve) => {
      check = (ev: SseEvent) => {
        if (
          ev.data?.sessionID === sessionID &&
          (ev.type === "session.execution.succeeded" ||
            ev.type === "session.execution.failed" ||
            ev.type === "session.execution.interrupted")
        ) {
          if (ev.type === "session.execution.failed") {
            failure = ev.data?.error;
            endKind = "failed";
          } else if (ev.type === "session.execution.interrupted") {
            endKind = "interrupted";
          } else {
            endKind = "succeeded";
          }
          if (check) {
            this.removeListener(check);
          }
          resolve();
        }
      };
      this.addListener(check);
    });
    return {
      done,
      cancel: () => {
        if (check) {
          this.removeListener(check);
          check = undefined;
        }
      },
      getFailure: () => failure,
      getEndKind: () => endKind,
    };
  }

  // ---- SSE plumbing -------------------------------------------------------

  private listeners = new Set<(ev: SseEvent) => void>();
  private addListener(fn: (ev: SseEvent) => void): void {
    this.listeners.add(fn);
    // P2 (QA-04): ensureSse is async — a synchronous throw (e.g. aborted
    // signal) would otherwise surface as an unhandled rejection.
    void this.ensureSse().catch((err) => {
      this.sseStarted = false;
      this.opts.output.appendLine(
        `[ide-agent] SSE start failed: ${err instanceof Error ? err.message : err}`,
      );
    });
  }
  private removeListener(fn: (ev: SseEvent) => void): void {
    this.listeners.delete(fn);
  }

  private sseStarted = false;
  private sseReconnectTimer?: NodeJS.Timeout;
  /** Set to true while a turn is actively consuming events. */
  private turnActive = false;
  /**
   * P2 (QA-FILE-03): set while a turn is consuming events. The server-exit
   * handler uses it to push a visible "engine exited" error into the turn
   * instead of letting it hang until the 10-min watchdog. Cleared in
   * consumeEvents' finally.
   */
  private turnFail?: (message: string) => void;
  /**
   * P3 (QA-FILE-03): ids that already have a UI card. A tool part arriving
   * directly as running/completed (no pending first) gets a synthesized card
   * instead of an orphan delta. Cleared at the start of every turn.
   */
  private readonly knownToolCalls = new Set<string>();
  /**
   * P1 (QA-FILE-01): Stop button. Set by abortTurn(); resolved so the
   * mergeStreams race exits promptly even when no more engine events arrive
   * (consumeEvents would otherwise block forever on its notify promise).
   * Cleared in runTurn's finally.
   */
  private turnAbortRequested = false;
  private abortResolve?: () => void;
  // ---- DD-AR runtime hardening fields (per-turn; cleared in runTurn's finally) ----
  /** DD-AR-1: active turn's stall detector (undefined between turns). */
  private turnStallDetector?: StreamStallDetector;
  /** DD-AR-4: active turn's blocking summarizer. */
  private turnSummarizer?: BlockingSummarizer;
  /** DD-AR-7: active turn's single-message loop detector. */
  private turnLoopDetector?: SingleMessageLoopDetector;
  /** DD-AR-6: model fallback manager (per turn). */
  private modelFallback?: ModelFallbackManager;
  /** DD-AR-1: IsStreamEvent-classified events seen in the current attempt. */
  private turnStreamEvents = 0;
  /** DD-AR-1: set when the stall detector aborted the attempt's stream. */
  private stallAbortRequested = false;
  /** DD-AR-7: loop error captured from the SSE listener (thrown state). */
  private turnLoopError?: LoopDetectedError;
  /** Resolver for the current attempt's abort promise. */
  private attemptAbortResolve?: () => void;
  /** DD-AR-1: suppress handleSseDrop's ad-hoc reconnect after a stall abort. */
  private sseDropExpected = false;
  /** DD-AR-4: in-flight summarization gate parking consumeEvents. */
  private summarizationGate?: Promise<void>;
  /** DD-AR-2: SSE reconnect attempt counter for the backoff schedule. */
  private sseReconnectAttempts = 0;
  /** Set by the turn watchdog; read by attempts. */
  private turnTimedOut = false;
  /** DD-AR-2: aborts retry backoff sleeps ("Cancelled during backoff"). */
  private backoffAborter?: AbortController;
  // ---- BG-SUMMARIZATION fields (Cursor parity: background summarization never parks the turn) ----
  /** Per-session (mode-keyed) transcript trackers — persist across turns. */
  private readonly transcriptTrackers = new Map<string, TranscriptTracker>();
  /** Per-session (mode-keyed) background summarizers — persist across turns. */
  private readonly bgSummarizers = new Map<string, BackgroundSummarizer>();
  /** Active turn's transcript tracker / summarizer (undefined between turns). */
  private turnTranscriptTracker?: TranscriptTracker;
  private turnBgSummarizer?: BackgroundSummarizer;
  /** Estimated token chars observed this turn (chars/4 heuristic → tokens). Reset per turn. */
  private turnEstimatedTokenChars = 0;
  /** The 70% threshold already fired this turn (start at most once per turn). */
  private bgSummaryStartedThisTurn = false;

  private async ensureSse(): Promise<void> {
    if (this.sseStarted || !this.port) {
      return;
    }
    this.sseStarted = true;
    // DD-AR-2: a successful (re)connect resets the backoff attempt counter.
    this.sseReconnectAttempts = 0;
    this.sseAbort = new AbortController();
    const req = http.request(
      {
        host: "127.0.0.1",
        port: this.port,
        path: "/api/event",
        method: "GET",
        headers: { Accept: "text/event-stream", ...this.authHeaders() },
        signal: this.sseAbort.signal,
      },
      (res) => {
        let buf = "";
        // P2 (QA-04): cap the raw SSE buffer — a stream without event
        // terminators would otherwise grow it without bound.
        const MAX_SSE_BUF = 1 * 1024 * 1024;
        res.on("data", (chunk: Buffer) => {
          buf += chunk.toString();
          if (buf.length > MAX_SSE_BUF) {
            this.opts.output.appendLine(
              `[ide-agent] SSE buffer overflow (${buf.length} bytes, no event terminator) — dropping malformed data`,
            );
            buf = "";
          }
          let idx: number;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const raw = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const ev = parseSse(raw);
            if (ev) {
              // DD-AR-1: feed the stall detector. Only IsStreamEvent content
              // resets the stream-activity timer — heartbeats and
              // turn-management messages do not (classifyEngineSseEvent).
              const detector = this.turnStallDetector;
              if (detector) {
                const activity = classifyEngineSseEvent(ev.type);
                detector.recordActivity(activity);
                if (activity === "stream") {
                  this.turnStreamEvents += 1;
                }
              }
              for (const fn of this.listeners) {
                try {
                  fn(ev);
                } catch {
                  /* listener errors must not kill the stream */
                }
              }
            }
          }
        });
        res.on("end", () => {
          this.handleSseDrop("stream ended");
        });
      },
    );
    req.on("error", (err) => {
      this.handleSseDrop(`request error: ${err instanceof Error ? err.message : err}`);
    });
    // P0: stall detection — if no response headers within 30s, destroy and reconnect.
    req.setTimeout(30_000, () => {
      req.destroy(new Error("SSE connection timed out"));
    });
    req.end();
  }

  /** Called when the SSE stream drops. Reconnects with backoff if a turn is active. */
  private handleSseDrop(reason: string): void {
    this.sseStarted = false;
    this.opts.output.appendLine(`[ide-agent] SSE dropped (${reason})`);
    // DD-AR-1: a stall-triggered abort suppresses the ad-hoc reconnect — the
    // outer retry loop re-establishes the stream after RetryState backoff.
    if (this.sseDropExpected) {
      this.sseDropExpected = false;
      return;
    }
    // Wake any consumers blocked in consumeEvents so they don't hang forever.
    // (The turn timeout in runTurn will surface an error if the stream stays down.)
    // P1 (QA-FILE-01): no reconnect when the drop was caused by the user
    // hitting Stop — the next turn restarts SSE through ensureSse anyway.
    if (this.turnActive && !this.turnAbortRequested && this.port) {
      // DD-AR-2: Cursor's backoff math (1s base → 60s cap + 20% jitter)
      // replaces the old 1s-doubling/30s-cap schedule. A subsequent stall
      // (no stream events during the outage) is caught by the stall
      // detector, which applies the full retry taxonomy + 180s budget.
      const delay = computeBackoffMs(this.sseReconnectAttempts);
      this.sseReconnectAttempts += 1;
      this.opts.output.appendLine(`[ide-agent] reconnecting SSE in ${Math.round(delay)}ms…`);
      // P3 (QA-FILE-03): clear any pending timer first — error+end double-fire
      // used to schedule two reconnects. The handle is cleared inside the
      // callback so it never goes stale.
      if (this.sseReconnectTimer) {
        clearTimeout(this.sseReconnectTimer);
      }
      this.sseReconnectTimer = setTimeout(() => {
        this.sseReconnectTimer = undefined;
        void this.ensureSse().catch(() => {
          this.sseStarted = false;
        });
      }, delay);
    }
  }

  /**
   * P1 (QA-FILE-01): Stop button — abort the in-flight turn promptly.
   * Resolves the abort promise so mergeStreams exits even with no further
   * engine events, destroys the SSE stream (reconnect is suppressed via
   * turnAbortRequested — the next turn restarts it through ensureSse), and
   * sets the flag runTurn checks between yields. The composer posts the
   * "Turn stopped by user" note itself; the adapter must NOT yield an
   * "Engine error" for a user-initiated stop (see runTurn's catch).
   */
  abortTurn(): void {
    this.turnAbortRequested = true;
    this.abortResolve?.();
    this.abortResolve = undefined;
    this.attemptAbortResolve?.();
    this.attemptAbortResolve = undefined;
    // DD-AR-2: abort an in-flight retry backoff ("Cancelled during backoff").
    this.backoffAborter?.abort();
    if (this.sseReconnectTimer) {
      clearTimeout(this.sseReconnectTimer);
      this.sseReconnectTimer = undefined;
    }
    this.sseAbort?.abort();
    this.sseStarted = false;
  }
  /**
   * Map raw SSE events for one session into TurnEvents.
   * Runs until the turn-end promise resolves.
   */
  private async *consumeEvents(sessionID: string, ctx: TurnContext): AsyncGenerator<TurnEvent, void, unknown> {
    const queue: TurnEvent[] = [];
    // P2 (QA-04): bound the queue — a fast-producing engine must not grow it
    // without bound during a long turn. Drop oldest, count drops.
    const MAX_QUEUE = 1000;
    let droppedEvents = 0;
    const pushEvent = (e: TurnEvent): void => {
      if (queue.length >= MAX_QUEUE) {
        queue.shift();
        droppedEvents++;
        if (droppedEvents === 1 || droppedEvents % 100 === 0) {
          this.opts.output.appendLine(
            `[ide-agent] event queue full (${MAX_QUEUE}) — dropped ${droppedEvents} event(s) so far`,
          );
        }
      }
      queue.push(e);
    };
    let notify: (() => void) | undefined;
    const wake = () => notify?.();
    // P2 (QA-FILE-03): the server-exit handler pushes through here — the
    // visible "engine exited" error must reach the UI even though no SSE
    // event arrives.
    this.turnFail = (message: string) => {
      pushEvent({ type: "textDelta", bubbleId: ctx.bubbleId, delta: `\n\n**Engine error:** ${message}` });
      wake();
    };
    // P3 (QA-FILE-03): fresh per-turn card registry (see knownToolCalls).
    this.knownToolCalls.clear();
    // DD-AR-4: fresh per-turn summarization gate (see the generator loop below).
    this.summarizationGate = undefined;

    const onEvent = (ev: SseEvent) => {
      const d = ev.data ?? {};
      if (d.sessionID !== sessionID && ev.type !== "permission.asked") {
        return;
      }
      switch (ev.type) {
        // --- Current engine stream (packages/schema/src/session-event.ts) ---
        case "session.text.delta": {
          if (typeof d.delta === "string" && d.delta.length > 0) {
            pushEvent({ type: "textDelta", bubbleId: ctx.bubbleId, delta: d.delta });
            wake();
            // BG-SUMMARIZATION: transcript + token-estimate observation.
            this.turnTranscriptTracker?.recordTextDelta(d.delta);
            this.observeBgSummaryChars(d.delta.length);
          }
          break;
        }
        case "session.reasoning.delta": {
          if (typeof d.delta === "string" && d.delta.length > 0) {
            pushEvent({ type: "thinking", bubbleId: ctx.bubbleId, text: d.delta.slice(0, 200), durationMs: 0 });
            wake();
            // BG-SUMMARIZATION: transcript + token-estimate observation.
            this.turnTranscriptTracker?.recordReasoningDelta(d.delta);
            this.observeBgSummaryChars(d.delta.length);
          }
          break;
        }
        case "session.tool.called": {
          // DD-AR-7: single-message loop detection on outbound tool-call args.
          // The listener is sync; the detector throws LoopDetectedError, which
          // aborts the attempt — the outer loop applies the retry_once policy.
          try {
            this.turnLoopDetector?.observe("tool_args", JSON.stringify(d.input ?? null));
          } catch (err) {
            if (err instanceof LoopDetectedError) {
              this.onLoopDetected(err);
              break;
            }
            throw err;
          }
          // Current schema: { sessionID, assistantMessageID, id, name, input, executed }.
          const toolId = typeof d.id === "string" && d.id.length > 0 ? d.id : `tc-${Date.now().toString(36)}-${(toolCallSeq++).toString(36)}`;
          const name = typeof d.name === "string" ? d.name : "tool";
          // BG-SUMMARIZATION: transcript + token-estimate observation.
          const bgToolInputJson = JSON.stringify(d.input ?? null);
          this.turnTranscriptTracker?.recordToolCall(name, bgToolInputJson);
          this.observeBgSummaryChars(bgToolInputJson.length);
          if (!this.knownToolCalls.has(toolId)) {
            this.knownToolCalls.add(toolId);
            pushEvent({
              type: "toolCall",
              bubbleId: ctx.bubbleId,
              toolCall: {
                toolCallId: toolId,
                kind: toCursorToolName(name),
                title: summarizeTool(name, d.input),
                status: "pending",
                description: "Waiting for approval",
                outputPreview: "",
                expanded: false,
                filePath: toolInputPath(d.input),
                // Doc-gap A12: clarifying-question widget data.
                question: parseQuestionPayload(name, d.input, toolId),
              },
            });
            wake();
          }
          break;
        }
        case "session.tool.progress": {
          if (typeof d.id === "string" && d.id.length > 0) {
            this.toolDelta(ctx.bubbleId, d.id, typeof d.name === "string" ? d.name : "tool", undefined, {
              status: "running",
              description: "Running…",
            }, pushEvent, wake);
          }
          break;
        }
        case "session.tool.success": {
          if (typeof d.id === "string" && d.id.length > 0) {
            const content = Array.isArray(d.content) ? d.content : [];
            const preview = content
              .map((c: unknown) => (typeof c === "string" ? c : JSON.stringify(c)))
              .join("\n")
              .slice(0, 2000);
            this.toolDelta(ctx.bubbleId, d.id, typeof d.name === "string" ? d.name : "tool", undefined, {
              status: "done",
              description: "Completed",
              outputPreview: preview,
            }, pushEvent, wake);
            // BG-SUMMARIZATION: transcript + token-estimate observation.
            this.turnTranscriptTracker?.recordToolResult(d.id, preview);
            this.observeBgSummaryChars(preview.length);
          }
          break;
        }
        case "session.tool.failed": {
          if (typeof d.id === "string" && d.id.length > 0) {
            const raw = d.error?.message ?? d.error ?? "tool failed";
            const toolName = typeof d.name === "string" ? d.name : "tool";
            // DD-AR-5: classified triple-message — the card shows the
            // client-visible message, never the raw error; the internal
            // error + classification go to the output channel.
            const formatted = formatToolError(raw, toolName);
            this.opts.output.appendLine(
              `[ide-agent] tool ${toolName} failed [${formatted.classification}]: ${formatted.error}`,
            );
            this.toolDelta(ctx.bubbleId, d.id, toolName, undefined, {
              status: "failed",
              description: formatted.clientVisibleErrorMessage,
            }, pushEvent, wake);
            // BG-SUMMARIZATION: transcript + token-estimate observation.
            this.turnTranscriptTracker?.recordToolResult(d.id, formatted.clientVisibleErrorMessage);
            this.observeBgSummaryChars(formatted.clientVisibleErrorMessage.length);
          }
          break;
        }
        // --- V1-compat stream (kept for older engines; not emitted by the
        // current engine, which uses the session.* events above) ---
        case "message.part.delta": {
          if (typeof d.delta === "string" && d.delta.length > 0) {
            pushEvent({ type: "textDelta", bubbleId: ctx.bubbleId, delta: d.delta });
            wake();
            // BG-SUMMARIZATION: transcript + token-estimate observation.
            this.turnTranscriptTracker?.recordTextDelta(d.delta);
            this.observeBgSummaryChars(d.delta.length);
          }
          break;
        }
        case "message.part.updated": {
          const part = d.part;
          if (!part) {
            break;
          }
          if (part.type === "reasoning" && typeof part.text === "string") {
            pushEvent({ type: "thinking", bubbleId: ctx.bubbleId, text: part.text.slice(0, 200), durationMs: 0 });
            wake();
          } else if (part.type === "tool") {
            // DD-AR-7: single-message loop detection on tool-call args
            // (v1-compat path mirrors session.tool.called above).
            try {
              this.turnLoopDetector?.observe("tool_args", JSON.stringify(part.state?.input ?? null));
            } catch (err) {
              if (err instanceof LoopDetectedError) {
                this.onLoopDetected(err);
                break;
              }
              throw err;
            }
            // BG-SUMMARIZATION: transcript + token-estimate observation.
            const bgPartInputJson = JSON.stringify(part.state?.input ?? null);
            this.turnTranscriptTracker?.recordToolCall(String(part.tool ?? "tool"), bgPartInputJson);
            this.observeBgSummaryChars(bgPartInputJson.length);
            for (const e of this.toolPartToEvents(part, ctx.bubbleId)) {
              pushEvent(e);
            }
            wake();
          }
          break;
        }
        case "permission.asked": {
          if (d.sessionID !== sessionID) {
            break;
          }
          // P2 (XQA-03): serialize — concurrent permission.asked events must
          // not orphan the first approval card. Each approval completes
          // (card resolved + reply sent) before the next one shows.
          // P3 (QA-FILE-03): failures are caught+logged inside enqueueApproval
          // itself, so this fire-and-forget call cannot produce an unhandled
          // rejection.
          this.enqueueApproval(() => this.handleApproval(d, ctx.bubbleId, pushEvent, wake, ctx.mode));
          break;
        }
        case "session.error": {
          // P3 (QA-FILE-03): error variants without .message used to render
          // as "[object Object]" in the UI.
          const raw = d.error?.message ?? d.error ?? "unknown engine error";
          const msg = typeof raw === "string" ? raw : JSON.stringify(raw);
          // DD-AR-4: blocking-summarization triggers (token/image limit) —
          // park the turn (WaitForCompletion) while the summary runs.
          const trigger = detectSummarizationTrigger(msg);
          if (trigger && this.turnSummarizer && !this.summarizationGate) {
            pushEvent({
              type: "textDelta",
              bubbleId: ctx.bubbleId,
              delta: `\n\n*Context limit reached (${trigger}) — running blocking summarization…*`,
            });
            this.summarizationGate = this.turnSummarizer.request(trigger, () => {
              pushEvent({
                type: "textDelta",
                bubbleId: ctx.bubbleId,
                delta: `\n\n*Summarization complete — resuming.*`,
              });
              wake();
            });
            wake();
          }
          pushEvent({ type: "textDelta", bubbleId: ctx.bubbleId, delta: `\n\n**Engine error:** ${msg}` });
          wake();
          break;
        }
      }
    };

    this.addListener(onEvent);
    try {
      for (;;) {
        // DD-AR-4: WaitForCompletion parking — no further events are yielded
        // until the in-flight blocking summarization completes.
        if (this.summarizationGate) {
          const gate = this.summarizationGate;
          this.summarizationGate = undefined;
          await gate;
        }
        while (queue.length > 0) {
          yield queue.shift()!;
        }
        // Wait for more events or turn end (signalled by the outer merge).
        await new Promise<void>((resolve) => {
          notify = resolve;
          if (queue.length > 0) {
            resolve();
          }
        });
        notify = undefined;
      }
    } finally {
      this.removeListener(onEvent);
      this.turnFail = undefined;
    }
  }

  /**
   * P3 (QA-FILE-03): queue a delta for a current-engine tool id, synthesizing
   * the card first when no `session.tool.called` was seen for it, so the
   * delta always has a card to attach to.
   */
  private toolDelta(
    bubbleId: string,
    toolCallId: string,
    name: string,
    input: unknown,
    delta: Partial<ToolCallViewModel>,
    pushEvent: (e: TurnEvent) => void,
    wake: () => void,
  ): void {
    if (!this.knownToolCalls.has(toolCallId)) {
      this.knownToolCalls.add(toolCallId);
      pushEvent({
        type: "toolCall",
        bubbleId,
        toolCall: {
          toolCallId,
          kind: toCursorToolName(name),
          title: summarizeTool(name, input),
          status: "running",
          description: `Running ${name}…`,
          outputPreview: "",
          expanded: false,
          filePath: toolInputPath(input),
        },
      });
    }
    pushEvent({ type: "toolCallDelta", toolCallId, delta });
    wake();
  }

  /** Merge the event stream with the turn-end signal (or turn timeout). */
  private async *mergeStreams(
    stream: AsyncIterable<TurnEvent>,
    turnDone: Promise<void>,
    timeoutPromise?: Promise<{ timedOut: true }>,
    abortPromise?: Promise<void>,
  ): AsyncIterable<TurnEvent> {
    let done = false;
    void turnDone.then(() => {
      done = true;
    });
    if (timeoutPromise) {
      void timeoutPromise.then(() => {
        done = true;
      });
    }
    // P1 (QA-FILE-01): Stop button — abortPromise resolves when abortTurn()
    // is called, so the loop exits promptly even mid-stream.
    if (abortPromise) {
      void abortPromise.then(() => {
        done = true;
      });
    }
    // P0 (QA-FILE-03): type the iterator explicitly — AsyncIterator lacks the
    // `return` member in this lib, which made cleanup a compile error.
    const it = stream[Symbol.asyncIterator]() as AsyncIterableIterator<TurnEvent>;
    for (;;) {
      if (done) {
        // Drain any events already queued (bounded: 250ms), then stop.
        const deadline = Date.now() + 250;
        for (;;) {
          const remaining = deadline - Date.now();
          if (remaining <= 0) {
            break;
          }
          const next = await Promise.race([
            it.next(),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), remaining)),
          ]);
          if (!next || next.done) {
            break;
          }
          yield next.value;
        }
        break;
      }
      const next = await Promise.race([
        it.next().then((r) => ({ ...r, fromStream: true as const })),
        turnDone.then(() => ({ done: true as const, fromStream: false as const })),
        ...(timeoutPromise
          ? [timeoutPromise.then(() => ({ done: true as const, fromStream: false as const, timedOut: true as const }))]
          : []),
        // DEV-GAPS-21D: the abort promise MUST race here, not just flip the
        // `done` flag via .then(). Without this, a dispose()/Stop while the
        // generator is suspended in this race never wakes it: it.next() waits
        // on consumeEvents' notify promise (only resolved by SSE events),
        // turnDone waits on a turn-end SSE event, and the watchdog is 10
        // minutes away. The result was a permanently pending turn promise —
        // node:test hung at file level ("Promise resolution is still pending
        // but the event loop has already resolved").
        ...(abortPromise
          ? [abortPromise.then(() => ({ done: true as const, fromStream: false as const }))]
          : []),
      ]);
      if (!next.fromStream || next.done) {
        break;
      }
      yield (next as { value: TurnEvent }).value;
    }
    if (typeof it.return === "function") {
      await it.return();
    }
  }

  /** Translate one engine ToolPart into toolCall / toolCallDelta events. */
  private *toolPartToEvents(part: any, bubbleId: string): Iterable<TurnEvent> {
    // P2 (QA-04): counter disambiguates the Date.now() fallback so two parts
    // arriving in the same millisecond never share an id.
    const toolCallId: string =
      part.callID ?? part.id ?? `tc-${Date.now().toString(36)}-${(toolCallSeq++).toString(36)}`;
    const cursorName = toCursorToolName(String(part.tool ?? "tool"));
    const state = part.state ?? {};
    const status = state.status as string;

    if (status === "pending") {
      this.knownToolCalls.add(toolCallId);
      const title = summarizeTool(part.tool, state.input);
      const toolCall: ToolCallViewModel = {
        toolCallId,
        kind: cursorName,
        title,
        status: "pending",
        description: "Waiting for approval",
        outputPreview: "",
        expanded: false,
        // Checkpoint file tracking: the tool's target path, so the
        // CheckpointService can snapshot pre-edit state before the tool runs.
        filePath: toolInputPath(state.input),
        // Doc-gap A12: clarifying-question widget data.
        question: parseQuestionPayload(String(part.tool ?? ""), state.input, toolCallId),
      };
      yield { type: "toolCall", bubbleId, toolCall };
    } else if (status === "running" || status === "completed" || status === "error") {
      // P3 (QA-FILE-03): the part skipped `pending` — synthesize the card
      // first so the delta below has something to attach to.
      if (!this.knownToolCalls.has(toolCallId)) {
        this.knownToolCalls.add(toolCallId);
        yield {
          type: "toolCall",
          bubbleId,
          toolCall: {
            toolCallId,
            kind: cursorName,
            title: summarizeTool(part.tool, state.input),
            status: "running",
            description: `Running ${part.tool}…`,
            outputPreview: "",
            expanded: false,
            filePath: toolInputPath(state.input),
          },
        };
      }
      if (status === "running") {
        yield {
          type: "toolCallDelta",
          toolCallId,
          delta: { status: "running", description: state.title ?? `Running ${part.tool}…` },
        };
      } else if (status === "completed") {
        const output = typeof state.output === "string" ? state.output : JSON.stringify(state.output ?? "");
        yield {
          type: "toolCallDelta",
          toolCallId,
          delta: {
            status: "done",
            description: state.title ?? `${part.tool} completed`,
            outputPreview: output.slice(0, 2000),
          },
        };
      } else if (status === "error") {
        // DD-AR-5: classified triple-message — the card shows the
        // client-visible message, never the raw error.
        const formatted = formatToolError(state.error ?? "tool failed", String(part.tool ?? "tool"));
        yield {
          type: "toolCallDelta",
          toolCallId,
          delta: { status: "failed", description: formatted.clientVisibleErrorMessage },
        };
      }
    }
  }

  /** permission.asked → approval card → reply to the engine. */
  private async handleApproval(
    d: any,
    bubbleId: string,
    pushEvent: (e: TurnEvent) => void,
    wake: () => void,
    turnMode?: ModeName,
  ): Promise<void> {
    // P3 (QA-FILE-03): validate the request id — a missing id would poison the
    // dedup map and put "undefined" in the reply URL.
    //
    // NOTE — QA-FILE-03's P1 ("handleApproval reads wrong fields") is a FALSE
    // POSITIVE, verified 2026-10-19 against the real sources. The suggested
    // fields d.permission/d.patterns exist ONLY in the LEGACY V1 schema
    // (packages/schema/src/v1/permission.ts); packages/schema/AGENTS.md says
    // new/current code must NOT depend on that subtree. The live event
    // manifest (event-manifest.ts → Permission.Event.Definitions from
    // ./permission.ts) emits Permission.Request =
    // { id, sessionID, action, resources, save?, metadata?, source?, message? },
    // built by core/src/permission.ts request(). So d.action / d.resources /
    // d.message are the CORRECT reads. Do NOT "fix" them to permission/patterns.
    const requestID = d.id as unknown;
    if (typeof requestID !== "string" || requestID.length === 0) {
      this.opts.output.appendLine(`[ide-agent] permission.asked with invalid id — skipping approval`);
      return;
    }
    const action: string = d.action ?? "tool";
    const resources: string[] = Array.isArray(d.resources) ? d.resources : [];
    const toolCallId = `tc-${requestID}`;

    // Dedup: skip if this request is already being handled.
    if (this.pendingApprovals.has(requestID)) {
      return;
    }
    this.pendingApprovals.set(requestID, toolCallId);

    // P2 (CX4b-NEW1): the turn may have ended (abort/timeout) while this task
    // waited in the serialized approval chain — never surface an approval card
    // for a dead turn. Drop it so the chain keeps moving and the next turn's
    // approvals don't queue behind a stale card. (Approvals that START while
    // the turn is live but outlive it are settled by the composer's turn-end
    // settleAllPending instead.)
    if (!this.turnActive) {
      this.pendingApprovals.delete(requestID);
      this.opts.output.appendLine(
        `[ide-agent] dropping approval ${requestID} — its turn already ended`,
      );
      return;
    }

    // P2 (QA-FILE-04): chat-mode read-only gate. Cursor's Ask mode advertises
    // "Answer questions without making edits" and enforces it via an allowlist
    // + UI blocks; our "Chat" hint said "read-only" with zero enforcement.
    // This approval handler is the choke point: the engine asked permission,
    // so auto-rejecting here is honored. Mutating tools in read-only modes
    // are rejected without prompting the user.
    // P1 (QA-PLANMODE-01): gate on the TURN's mode, not the live UI mode.
    // The turn captured its mode at submit time; if the user flips the mode
    // mid-turn, in-flight approvals must still be gated by the mode the turn
    // started with. Falls back to the live mode for callers without a turn.
    const mode = turnMode ?? this.opts.getMode?.();
    const blockedByMode = !!mode && isReadOnlyMode(mode) && isMutatingToolAction(action);
    // DEV-HOOKS: blocking tool hooks at the approval choke point (Cursor
    // parity: preToolUse + beforeShellExecution/beforeMCPExecution/
    // beforeReadFile run BEFORE the approval card; exit code 2 auto-rejects
    // the tool call without prompting the user).
    let blockedByHook = false;
    let hookBlockReason: string | undefined;
    let hookUserMessages: string[] = [];
    let hookAgentMessages: string[] = [];
    if (this.opts.hooks) {
      try {
        const gate = await this.opts.hooks.checkToolGate(action, resources, { sessionID: d.sessionID }, this.opts.hookScope ?? "");
        blockedByHook = gate.blocked;
        hookBlockReason = gate.reason;
        // IDE-CODE (hooks-deny-message-routing): never silently drop the
        // hook messages — they are routed to the agent (permission reply
        // `message` → engine's permission.rejected session error) and to the
        // user (tool card description) below.
        hookUserMessages = gate.userMessages;
        hookAgentMessages = gate.agentMessages;
      } catch (err) {
        // Hook infra failure must never hang an approval — fail open, log.
        this.opts.output.appendLine(
          `[ide-agent] hook gate error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const blocked = blockedByMode || blockedByHook;
    // IDE-CODE (hooks-deny-message-routing): Cursor parity — on deny, the
    // hook's user_message is embedded in the agent-facing denial, binary-
    // verified as `${tool} blocked by preToolUse hook: ${userMessage}`
    // (cursor-agent-exec/dist/main.js, 3.25.6); agent_message is "fed back to
    // the agent when the action is denied" (cursor.com/docs/agent/hooks).
    // This becomes the engine's model-visible permission.rejected message via
    // the sidecar's CorrectedError.feedback (reply `message` field).
    let hookDenialForAgent: string | undefined;
    if (blockedByHook) {
      const userPart = hookUserMessages.map((m) => m.trim()).filter((m) => m.length > 0).join("\n");
      const agentPart = hookAgentMessages.map((m) => m.trim()).filter((m) => m.length > 0).join("\n");
      hookDenialForAgent = `${approvalTitle(action, resources)} blocked by hook${userPart ? `: ${userPart}` : ""}${agentPart ? `\n${agentPart}` : ""}`;
    }
    // MCP tools surface their server in the approval card (Cursor parity).
    const mcpAction = parseMcpAction(action);

    // SETTINGS-PARITY: `ide.composer.runMode` (Cursor's Run Modes).
    // autoReview (default): ask before each tool call. allowlist: safe
    // read-only tools auto-run, everything else asks. runEverything: all
    // tools auto-run without asking. Never overrides a block (read-only
    // mode or hook denial always win).
    const runMode = vscode.workspace
      .getConfiguration("ide.composer")
      .get<string>("runMode", "autoReview");
    const autoApprovedByRunMode =
      !blocked &&
      (runMode === "runEverything" ||
        (runMode === "allowlist" && READ_ONLY_TOOL_ACTIONS.has(action.toLowerCase())));

    // DD-AR-8: shadow-mode approval protocol — fire-and-forget "shadow"
    // classifier invocation; always allows; errors swallowed; the verdict is
    // only logged (telemetry/eval), never blocks the turn.
    if (this.isApprovalShadowMode()) {
      runShadowClassifier(
        { action, resources },
        () => this.evaluateShadowVerdict(action, { blockedByMode, blockedByHook, autoApprovedByRunMode }),
        (result, input) => {
          this.opts.output.appendLine(
            `[ide-agent] approval SHADOW verdict: "${approvalTitle(input.action, input.resources)}" → ${result.decision} (${result.latencyMs}ms)` +
              (result.error ? ` [classifier error swallowed: ${result.error}]` : ""),
          );
        },
      );
    }

    try {
      // Surface a tool-call card in pending state so the approval has context.
      pushEvent({
        type: "toolCall",
        bubbleId,
        toolCall: {
          toolCallId,
          kind: toCursorToolName(action),
          title: approvalTitle(action, resources),
          status: blocked ? "failed" : "pending",
          description: blockedByMode
            ? `Blocked: "${mode}" mode is read-only — mutating tools are disabled. Switch to Agent mode to allow edits.`
            : blockedByHook
              // IDE-CODE (hooks-deny-message-routing): Cursor docs —
              // user_message is "Message shown to the user when the action
              // is denied" (cursor.com/docs/agent/hooks).
              ? `Blocked by hook: ${hookUserMessages.length > 0 ? hookUserMessages.join(" ") : hookBlockReason ?? "no reason given"}`
              : autoApprovedByRunMode
                ? `Auto-approved — run mode "${runMode}".`
                : (d.message ?? "The engine requests permission"),
          outputPreview: "",
          expanded: false,
          // Checkpoint file tracking: approval resources usually carry the
          // target path as the first resource.
          filePath:
            typeof resources[0] === "string" && resources[0].length > 0 ? resources[0] : undefined,
        },
      });
      wake();

      let decision: ApprovalResult;
      if (blocked) {
        // Auto-reject without prompting: maps to "reject" in the reply
        // mapping below, so the engine is told the tool call was denied.
        // (blockedByMode = read-only mode gate; blockedByHook = exit-2 hook.)
        decision = { optionId: "skip" };
      } else if (autoApprovedByRunMode) {
        // SETTINGS-PARITY: run mode auto-approves — no card prompt.
        decision = { optionId: "approve-once" };
      } else {
        try {
          // P2-4 rework (QA-CHATTABS Round B): link a question tool's
          // approval card to its question widget. The permission request's
          // source.id is the tool call id (Tool.CallID.make(input.call.id)
          // — the same id published in session.tool.called and used as the
          // widget's toolCallId), so this link is exact even with several
          // questions pending at once. Emitted only when a real card is
          // created (not for auto-approved / blocked / dropped requests —
          // there is no card to link then).
          if (
            action === "question" &&
            typeof d.source?.id === "string" &&
            d.source.id.length > 0
          ) {
            pushEvent({
              type: "questionApproval",
              toolCallId: d.source.id,
              approvalToolCallId: toolCallId,
            });
            wake();
          }
          // P1 (QA-CHATTABS-01): the allowlist identity is the STABLE tool
          // identity — action + sorted resources (e.g. "edit::src/a.ts") —
          // never the per-request toolCallId (`tc-<request-id>` is unique per
          // permission request, so keying on it made "Approve and allowlist"
          // a dead feature). Resources are joined with NUL, not "," — a comma
          // collides ["a,b"] with ["a","b"], and shell resources are full
          // command text where commas are common. NUL cannot appear in a
          // file path (forbidden by the OS on POSIX and Windows) or in
          // command text, so the key is unambiguous.
          const allowlistIdentity = buildAllowlistIdentity(action, resources);
          // GAPS-12 (approval-card-diff): the engine's edit/write tools
          // compute a unified-diff preview and attach it to the permission
          // request as metadata.files[0] (packages/core/src/tool/plugin/
          // edit.ts, write.ts). Cursor's file-edit approval card shows that
          // diff at context 2 (deepdig-runtime-approval §3.11:
          // approvalDetails { type: "fileEdit", isNewFile, diffString }).
          // buildFileEditApprovalDetails trims the engine's context-3 patch
          // to context 2; undefined when there is no usable file diff, in
          // which case the card renders without a diff block. Nothing here
          // is invented — the -/+ lines come verbatim from the engine.
          const approvalDetails = buildFileEditApprovalDetails(d.metadata);
          // GAPS-22B: shell/terminal approvals pass the command candidates
          // so the allowlist button label is built Cursor-verbatim
          // (`Always Run '<cmd>'` / `Always Run '<cmd>' + N`, binary `ycp`
          // over `allowlistCandidates.map(k => k.label)`). Resources for
          // terminal actions are full command texts — the fork's candidate
          // labels. Non-empty only; empty input keeps the generic labels.
          const shellAllowlistCandidates = TERMINAL_ACTIONS.has(action)
            ? resources.filter((r) => typeof r === "string" && r.length > 0)
            : undefined;
          decision = await this.opts.requestApproval(toolCallId, action, [
            d.message ?? `Permission requested: ${approvalTitle(action, resources)}`,
            ...(mcpAction ? [`MCP server: ${mcpAction.server}`] : []),
            ...resources.slice(0, 3),
          ], allowlistIdentity, approvalDetails, shellAllowlistCandidates, action);
        } catch (err) {
          // Approval UI failed — fail the tool call visibly instead of hanging.
          const message = err instanceof Error ? err.message : String(err);
          pushEvent({
            type: "toolCallDelta",
            toolCallId,
            delta: { status: "failed", description: `Approval failed: ${message}` },
          });
          wake();
          return;
        }
      }

      // Map UI options → engine replies: approve-once → "once", approve-allowlist → "always", skip → "reject".
      const reply = !decision || decision.optionId === "skip" ? "reject" : decision.optionId === "approve-allowlist" ? "always" : "once";

      pushEvent({
        type: "toolCallDelta",
        toolCallId,
        delta:
          reply === "reject"
            ? { status: "failed", description: "Rejected by user" }
            : { status: "running", description: "Approved — running…" },
      });
      wake();

      try {
        // IDE-CODE (hooks-deny-message-routing): on hook deny the reply
        // carries `message` so the engine turns the denial into a
        // model-visible permission.rejected session error containing the
        // hook's user_message/agent_message (fail-closed: the messages are
        // never silently dropped on this path — a reply transport failure
        // below logs an explicit warning naming them).
        await this.api("POST", `/api/session/${d.sessionID}/permission/${requestID}/reply`, {
          decision: reply,
          ...(hookDenialForAgent ? { message: hookDenialForAgent } : {}),
        });
      } catch (err) {
        // P1: retry once, then fail the turn visibly instead of hanging.
        this.opts.output.appendLine(`[ide-agent] permission reply failed (retrying): ${err instanceof Error ? err.message : err}`);
        try {
          await this.api("POST", `/api/session/${d.sessionID}/permission/${requestID}/reply`, {
            decision: reply,
            ...(hookDenialForAgent ? { message: hookDenialForAgent } : {}),
          });
        } catch (retryErr) {
          const message = retryErr instanceof Error ? retryErr.message : String(retryErr);
          this.opts.output.appendLine(`[ide-agent] permission reply failed twice: ${message}`);
          if (hookDenialForAgent) {
            // Fail-closed: the hook's deny messages could NOT be routed to
            // the agent — warn loudly instead of silently dropping them.
            this.opts.output.appendLine(
              `[ide-agent] WARNING: hook deny messages were NOT delivered to the agent: ${hookDenialForAgent}`,
            );
          }
          pushEvent({
            type: "toolCallDelta",
            toolCallId,
            delta: { status: "failed", description: `Permission reply failed: ${message}` },
          });
          pushEvent({
            type: "textDelta",
            bubbleId,
            delta: "\n\n**Engine error:** could not send approval decision to the engine. The turn cannot continue.",
          });
          wake();
          // P3 (CX4b-NEW2): fail the turn fast. The engine never received our
          // reply, so it will never emit session.execution.* — without this
          // the turn idles until the 10-minute watchdog. wake() flushes the
          // queued error events through the stream; resolving the abort
          // promise breaks the merge loop right after. turnAbortRequested is
          // deliberately NOT set, so this is not misreported as a
          // user-initiated stop.
          this.abortResolve?.();
        }
      }
    } finally {
      this.pendingApprovals.delete(requestID);
    }
  }

  // ---- HTTP helper ----------------------------------------------------------

  /** Authorization headers for sidecar requests (Basic auth with the spawn token). */
  private authHeaders(): Record<string, string> {
    if (!this.authToken) {
      return {};
    }
    const credentials = Buffer.from(`opencode:${this.authToken}`).toString("base64");
    return { Authorization: `Basic ${credentials}` };
  }

  private api(
    method: "GET" | "POST",
    pathStr: string,
    body?: unknown,
    signal?: AbortSignal,
    /** Per-request timeout (ms). Default 30s; the background summary generation uses a longer one. */
    timeoutMs = 30_000,
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason instanceof Error ? signal.reason : new Error(`${method} ${pathStr} aborted`));
        return;
      }
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request(
        {
          host: "127.0.0.1",
          port: this.port,
          path: pathStr,
          method,
          headers: {
            "Content-Type": "application/json",
            ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
            ...this.authHeaders(),
          },
        },
        (res) => {
          let data = "";
          // P2 (QA-FILE-03): cap the response body — the SSE path has a 1MB
          // cap but api() accumulated unboundedly; a misbehaving server could
          // OOM the extension host.
          const MAX_API_BODY = 10 * 1024 * 1024;
          let bodyOverflowed = false;
          // TAB: detach the abort listener once the request settles so
          // per-keystroke completion calls can't leak listeners.
          const detachAbort = () => signal?.removeEventListener("abort", onAbort);
          res.on("data", (c: Buffer) => {
            if (bodyOverflowed) {
              return;
            }
            data += c.toString();
            if (data.length > MAX_API_BODY) {
              bodyOverflowed = true;
              detachAbort();
              req.destroy(new Error("response body exceeded 10MB cap"));
              reject(new Error(`${method} ${pathStr} → response body exceeded 10MB cap`));
            }
          });
          res.on("end", () => {
            detachAbort();
            if (bodyOverflowed) {
              return;
            }
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              try {
                resolve(data ? JSON.parse(data) : {});
              } catch (parseErr) {
                // P2 (QA-04): don't swallow malformed JSON into {} — callers
                // then fail with confusing TypeErrors. Log the raw body and
                // reject with a descriptive error instead.
                this.opts.output.appendLine(
                  `[ide-agent] ${method} ${pathStr} returned invalid JSON: ${data.slice(0, 500)}`,
                );
                reject(
                  new Error(
                    `${method} ${pathStr} returned invalid JSON: ${parseErr instanceof Error ? parseErr.message : parseErr}`,
                  ),
                );
              }
            } else {
              // P2 (CX4b): a 404 on a session-scoped path means the engine lost
              // our session (internal restart / session TTL). Drop the stale
              // cache entry now so ensureSession() creates a fresh one instead
              // of failing every subsequent turn until the extension reloads.
              const goneSessionId = sessionIdFromApiPath(pathStr);
              if (res.statusCode === 404 && goneSessionId !== undefined) {
                this.invalidateSession(goneSessionId);
              }
              // DD-AR-2: surface Retry-After (≤60s honored by selectDelayMs).
              const retryAfterMs = parseRetryAfterMs(res.headers["retry-after"]);
              reject(httpError(method, pathStr, res.statusCode ?? 0, data.slice(0, 300), retryAfterMs));
            }
          });
        },
      );
      const onAbort = () => {
        req.destroy(signal?.reason instanceof Error ? signal.reason : new Error(`${method} ${pathStr} aborted`));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      req.on("error", (err) => {
        signal?.removeEventListener("abort", onAbort);
        reject(err);
      });
      req.setTimeout(timeoutMs, () => req.destroy(new Error("request timed out")));
      if (payload) {
        req.write(payload);
      }
      req.end();
    });
  }

  /** Stop the sidecar (call on extension deactivate). */
  dispose(): void {
    this.disposed = true;
    // DEV-GAPS-21D: abort the in-flight turn FIRST — abortTurn() resolves the
    // mergeStreams abort promise and aborts the retry backoff sleep. Without
    // this, a dispose during a running turn (e.g. a unit test's file-level
    // after() while answerQuestion started a real turn) leaves the turn's
    // promise pending forever: node:test then hangs at file level with
    // "Promise resolution is still pending but the event loop has already
    // resolved". Killing the sidecar process alone does not settle the
    // promises awaiting its events.
    this.abortTurn();
    this.sseAbort?.abort();
    // P2 (QA-04): drop all SSE listeners and cancel any pending reconnect so
    // nothing survives disposal.
    this.listeners.clear();
    if (this.sseReconnectTimer) {
      clearTimeout(this.sseReconnectTimer);
      this.sseReconnectTimer = undefined;
    }
    this.sseStarted = false;
    // P2 (QA-04-VERIFY): escalate to SIGKILL if the sidecar ignores SIGTERM —
    // otherwise a zombie bun survives deactivation holding its port.
    const proc = this.serverProc;
    if (proc) {
      proc.kill("SIGTERM");
      // DEV-GAPS-21D: destroy the stdio pipes NOW — a killed sidecar does not
      // reliably close its end (bun may take seconds to die or leave the
      // pipe write-end inherited), and the parent's open pipe handles keep
      // the event loop alive forever (node:test file-level hang: "Promise
      // resolution is still pending but the event loop has already
      // resolved"). Destroying our ends drops the handles immediately; the
      // exit listener below still reaps the process.
      try {
        proc.stdout?.destroy();
      } catch {
        /* ignore */
      }
      try {
        proc.stderr?.destroy();
      } catch {
        /* ignore */
      }
      try {
        (proc.stdin as unknown as { destroy?: () => void })?.destroy?.();
      } catch {
        /* ignore */
      }
      const killTimer = setTimeout(() => {
        if (proc.exitCode === null && !proc.killed) {
          this.opts.output.appendLine("[ide-agent] engine ignored SIGTERM; sending SIGKILL");
          proc.kill("SIGKILL");
        }
      }, 3000);
      // Don't let the timer keep the extension host alive.
      killTimer.unref?.();
      proc.once("exit", () => clearTimeout(killTimer));
    }
    this.serverProc = undefined;
    this.port = 0;
    this.authToken = undefined;
    // P2 (QA-FILE-03): drop the in-flight start promise — a dispose during
    // startup used to leave `starting` pointing at a promise that rejects
    // after a 30s poll against port 0, so the next ensureServer() trusted a
    // dead promise instead of starting fresh.
    this.starting = undefined;
    this.turnActive = false;
    this.turnFail = undefined;
    this.sessions.clear();
    // DEV-MULTITASK: drop live worker session ids — they belong to the dead sidecar.
    this.workerSessionIDs.clear();
    // BG-SUMMARIZATION: drop per-session transcript/summarizer state with the dead sidecar.
    this.transcriptTrackers.clear();
    this.bgSummarizers.clear();
    this.turnTranscriptTracker = undefined;
    this.turnBgSummarizer = undefined;
    // TAB: drop the dedicated completion session too — it belongs to the dead sidecar.
    this.tabSessionID = undefined;
    this.tabSessionModelID = undefined;
  }
}

/**
 * M-03 (model picker): serialize a ModelRef to the wire's Model.Ref shape —
 * { id, providerID, variant? } (variant omitted when absent).
 */
function toWireModelRef(ref: ModelRef): { id: string; providerID: string; variant?: string } {
  return {
    id: ref.id,
    providerID: ref.providerID,
    ...(ref.variant ? { variant: ref.variant } : {}),
  };
}

/**
 * Extract the tool's target file path from its input (path/file field).
 * Used for checkpoint file tracking. Returns undefined for non-file tools.
 */
function toolInputPath(input: any): string | undefined {
  const inp = input as Record<string, unknown> | undefined;
  const p = inp?.["path"];
  if (typeof p === "string" && p.length > 0) {
    return p;
  }
  const f = inp?.["file"];
  if (typeof f === "string" && f.length > 0) {
    return f;
  }
  return undefined;
}

/**
 * Parse the `question` tool's input into a clarifying-question payload
 * (doc-gap A12 — Cursor's clickable question widget). Input shape (from
 * @opencode/schema Question.Prompt): { questions: [{ header, question,
 * options: [{label, description}], multiple? }] }. Returns undefined when the
 * tool isn't `question` or the payload is malformed.
 */
function parseQuestionPayload(
  tool: string,
  input: any,
  toolCallId: string,
): ClarifyingQuestion | undefined {
  if (tool !== "question") {
    return undefined;
  }
  const questions = (input as Record<string, unknown> | undefined)?.["questions"];
  if (!Array.isArray(questions) || questions.length === 0) {
    return undefined;
  }
  const q = questions[0] as Record<string, unknown>;
  if (typeof q["question"] !== "string") {
    return undefined;
  }
  const rawOptions = Array.isArray(q["options"]) ? q["options"] : [];
  const options = rawOptions
    .filter(
      (o): o is Record<string, unknown> => typeof o === "object" && o !== null && typeof o["label"] === "string",
    )
    .map((o, i) => ({
      id: `opt-${i}`,
      label: String(o["label"]),
      description: typeof o["description"] === "string" ? String(o["description"]) : undefined,
    }));
  if (options.length === 0) {
    return undefined;
  }
  return {
    questionId: `q-${toolCallId}`,
    header: typeof q["header"] === "string" ? String(q["header"]) : "Question",
    question: String(q["question"]),
    options,
    multiple: q["multiple"] === true,
    toolCallId,
  };
}

function summarizeTool(tool: string, input: any): string {
  const inp = input as Record<string, unknown> | undefined;
  const target =
    (typeof inp?.["path"] === "string" && inp["path"]) ||
    (typeof inp?.["file"] === "string" && inp["file"]) ||
    (typeof inp?.["pattern"] === "string" && inp["pattern"]) ||
    (typeof inp?.["command"] === "string" && String(inp["command"]).slice(0, 60)) ||
    "";
  return target ? `${tool} ${target}` : tool;
}

function freePort(): Promise<number> {  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      srv.close(() => resolve(typeof addr === "object" && addr ? addr.port : 0));
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
