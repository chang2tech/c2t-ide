import * as vscode from "vscode";
import * as path from "path";
import { ModeName, TurnEvent, TurnSettled } from "../model";
import { ComposerBubbleSetStore } from "../stores/bubbleStore";
import { ModeService, MODES, wrapPlanPrompt, wrapDebugPrompt, wrapMultitaskPrompt, shouldSuggestDebugMode } from "./modeService";
import type {
  DebugModeConfig,
  CustomModeSession,
} from "./modeService";
import {
  createCustomModeSession,
  incrementCustomModeTurns,
  wrapCustomModePrompt,
  planCustomModeTurn,
  buildSkillMissingNotification,
  type CustomModeSkillSource,
} from "./modeService";
import { DebugServerService } from "./debugServerService";
import { HumanReviewService, ApprovalDetails } from "./humanReviewService";
import {
  TrackedGitRepoState,
  TRACKED_GIT_REPO_STATE_SECTION,
  TRACKED_GIT_REPO_STATE_KEY,
  ENHANCED_BRANCH_CHANGE_REMINDER_KEY,
  readTrackedBranches,
  checkPreviousBranchIsAncestor,
  type BranchChange,
} from "./gitBranchTracker";
import { CheckpointService } from "./checkpointService";
import { ChatResubmitService } from "./chatResubmitService";
import { MessageQueueService, QueuedMessage } from "./messageQueueService";
import { EngineAdapter, EngineModelInfo, StubEngineAdapter } from "./agentService";
import { FileAttachment } from "./mentionService";
import { IdeCodeEngineAdapter } from "./ideCodeEngineAdapter";
import { MultitaskService, type SubtaskResult, DECOMPOSE_INSTRUCTION, WORKER_INSTRUCTION } from "./multitaskService";
import {
  ModelSelection,
  ModelSelectionStore,
  ModelService,
  resolveActiveContextTokenLimit,
  selectionValue,
} from "./modelService";
import { ProjectRulesService } from "./projectRulesService";
import { UserRulesService } from "./userRulesService";
import { playChime, defaultChimePath } from "./chime";
import {
  INTERRUPTED_TURNS_STORAGE_KEY,
  parseInterruptedTurnRecords,
  recordTurnSettled,
  recordTurnStarted,
} from "./continueInterruptedAgents";
import {
  PlanFileTelemetryEvent,
  PlanFileResolveSource,
  resolvePlanFilePath,
} from "./planFileService";
import { scanPromptForSecrets } from "./leakDetection";
import {
  bundledIncompleteDiagnostic,
  defaultEnginePath,
  resolveBunPath,
  resolveEngineCwd,
  resolveEnginePath,
} from "./enginePath";
import { AsyncAskQuestionStepLog } from "./asyncAskSettle";
// Re-exported so existing `import { defaultEnginePath } from "./composerDataService"` sites keep working.
export { defaultEnginePath };
import { ruleAppliesToEnv, formatRuleEntry } from "./projectRules";
import { requestContextSkills } from "./skillStoreService";
import {
  FALLBACK_CONTEXT_WINDOW_TOKENS,
  computeContextUsageBreakdown,
  skillsListChars,
  mcpCatalogChars,
  type ContextUsageSource,
  type McpCatalogEntry,
} from "./contextUsageService";
import {
  buildContextUsageReport,
  conversationItemsFromSegments,
  type ContextUsageReportData,
} from "./contextUsageReport";

/** How a message submitted while a turn is running should be delivered. */
export type SubmitSendMode = "default" | "manual" | "queue" | "sendNow";

export interface SubmitOptions {
  /**
   * default: Enter key — follows `ide.composer.queueMessageDefaultBehavior`.
   * manual: Send button — follows `ide.composer.queueManualSendBehavior`.
   * queue: Alt+Enter — always queues (Cursor parity).
   * sendNow: Cmd/Ctrl+Enter or Enter-twice — bypasses the queue, delivered
   *   at the next opportune time without interrupting the turn (Cursor's
   *   "Send now" steer; docs/agent: "Cmd+Enter sends immediately bypassing
   *   the queue").
   */
  sendMode?: SubmitSendMode;
  /**
   * File attachments resolved from mention chips (browser-tab screenshots).
   * Threaded through the queue into the engine prompt's `files` field so the
   * agent receives the image bytes — never dropped silently.
   */
  attachments?: FileAttachment[];
}

/**
 * A plan produced by a plan-mode turn, awaiting user review.
 * Cursor parity: plans are saved in the home dir by default
 * (~/.ide-code/plans/); "Accept Plan" starts the build phase.
 */
export interface PendingPlan {
  /** The assistant bubble that produced the plan. */
  bubbleId: string;
  /** Plan markdown (the assistant's response text). */
  text: string;
  /** Absolute path of the saved plan file. */
  savedPath: string;
  createdAt: number;
}

/**
 * GAPS-186: plan execution data extracted by the CORE plan service's
 * `_loadPlanExecutionData` port (Cursor 3.25.9 @18692365) and forwarded
 * with a core-accepted plan (`ide.acceptPlanFromCore`, 4th arg). Mirrors
 * the binary's consumers: Cursor puts `planTitle` on the plan-execution
 * bubble / submit options and seeds the composer's todo list from the
 * extracted todos. This composer has no plan-execution bubble field and
 * no composer todo store, so the data is retained verbatim as the last
 * accepted plan's execution info (see `getLastAcceptedPlanExecution`) —
 * HONEST DIVERGENCE: recorded, not rendered; the build prompt keeps the
 * fork shape GAPS-181 QA'd.
 */
export interface AcceptedPlanExecution {
  /** Frontmatter plan name ("" when the plan file had no frontmatter). */
  planName: string;
  /** `e7e(planContent, planName)` title the core service derived. */
  planTitle: string;
  /** Extracted plan todos (frontmatter, else body checkbox items). */
  planTodos: Array<{
    id: string;
    content: string;
    status: string;
    dependencies?: string[];
  }>;
  acceptedAt: number;
}

/** Defensively normalize the untyped `ide.acceptPlanFromCore` 4th arg. */
function normalizeAcceptedPlanExecution(raw: unknown): AcceptedPlanExecution | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const r = raw as { planName?: unknown; planTitle?: unknown; planTodos?: unknown };
  const planTodos: AcceptedPlanExecution["planTodos"] = [];
  if (Array.isArray(r.planTodos)) {
    for (const item of r.planTodos) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const t = item as { id?: unknown; content?: unknown; status?: unknown; dependencies?: unknown };
      if (typeof t.content !== "string") {
        continue;
      }
      planTodos.push({
        id: typeof t.id === "string" && t.id ? t.id : `todo-${planTodos.length + 1}`,
        content: t.content,
        status: typeof t.status === "string" && t.status ? t.status : "pending",
        ...(Array.isArray(t.dependencies)
          ? { dependencies: t.dependencies.filter((d): d is string => typeof d === "string") }
          : {}),
      });
    }
  }
  return {
    planName: typeof r.planName === "string" ? r.planName : "",
    planTitle: typeof r.planTitle === "string" ? r.planTitle : "",
    planTodos,
    acceptedAt: Date.now(),
  };
}
import { HookService } from "../hooks/hookService";
import * as os from "node:os";
import * as fs from "node:fs/promises";

/**
 * Persist a plan to ~/.ide-code/plans/ (Cursor parity: plans are saved in
 * the home dir by default). Returns the absolute path. Never throws — a
 * failed save yields "" and the plan still works in-memory.
 */
async function savePlanFile(text: string): Promise<string> {
  try {
    const dir = path.join(os.homedir(), ".ide-code", "plans");
    await fs.mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const slug = text
      .split("\n")[0]
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
    const file = path.join(
      dir,
      // P3 (QA-PLANMODE-01): random suffix — two plans in the same ms with
      // the same first line would otherwise silently overwrite each other.
      `plan-${stamp}${slug ? `-${slug}` : ""}-${Math.random().toString(36).slice(2, 8)}.md`,
    );
    await fs.writeFile(file, `# Plan — ${new Date().toISOString()}\n\n${text}\n`, "utf-8");
    return file;
  } catch {
    return "";
  }
}

/** workspaceState key for the persisted model picker selection (per workspace). */
const MODEL_STATE_KEY = "ideAgent.selectedModel";

export type ComposerEvent =
  | { kind: "bubblesChanged"; ids: string[] }
  | { kind: "bubblesReset" }
  | { kind: "modeChanged"; mode: ModeName }
  // Queue list UI: the full items (id/text/mode/enqueuedAt) so the webview
  // can render the list with reorder/delete/send-now per message.
  | { kind: "queueChanged"; length: number; items: import("./messageQueueService").QueuedMessage[] }
  // P1 (CX1b): a new chat was started — the webview must reset all
  // composer-local state (chips, input draft, open menus, ctx usage).
  | { kind: "newChat" }
  // P1 (QA-FILE-01): turn lifecycle — drives the webview's Stop/Send toggle.
  | { kind: "turnState"; running: boolean }
  // GAPS-11B (agent-abort-restore-query): Cursor parity — the binary's
  // `glass.abortAgentAndRestoreQuery` command ("Abort Agent and Restore
  // Query", workbench.glass.main.js 3.25.6; REA doc
  // dig-continuous-composer-queue-2026-10-19.md §2) restores the aborted
  // turn's query. Cursor restores it into a NEW agent draft's pending
  // prompt (abandoned agent handed off); we have no drafts/multi-agent
  // model, so the faithful equivalent here is refilling THIS composer's
  // input (HONEST-DIVERGENCE, same user-visible outcome: the prompt is back
  // in the input, ready to edit and resubmit).
  // Fired only for the explicit user Stop path (abort({ restoreQuery:
  // true })), never for internal interrupt/steer aborts — those run a new
  // turn immediately, so refilling the input would clobber the handoff.
  | { kind: "restorePrompt"; text: string }
  // Checkpoint restored (files + transcript) — drives the webview's
  // "checked out" chip on the target human bubble (Cursor parity).
  | { kind: "checkpointRestored"; bubbleId: string }
  // Doc-gap A12: the agent asked a clarifying question mid-turn — drives the
  // webview's clickable question widget.
  | { kind: "questionAsked"; question: import("../model").ClarifyingQuestion }
  // Doc-gap A12: the user answered a clarifying question.
  | { kind: "questionAnswered"; questionId: string }
  // P2 (CX2b): engine connection state — drives the webview's engine-status
  // hint post-render, so a stale "not connected" hint is corrected live.
  | { kind: "engineStatus"; connected: boolean }
  // M-03 (model picker): the selected model changed — drives the webview's
  // model button label so it always shows the current model honestly.
  | { kind: "modelChanged"; selection: ModelSelection }
  // Plan mode: a plan-mode turn completed with a pending plan — drives the
  // webview's "Plan ready" tray (review → Accept / Discard).
  | { kind: "planReady"; plan: PendingPlan }
  | { kind: "planCleared" }
  /**
   * GAPS-46D (agent-custom-modes): custom-mode session changed. `active` is
   * the new active session (null when exited); `exitedLabel` names the mode
   * that was just exited (binary `pendingExitedCustomMode`), used by the
   * webview to clear the badge.
   */
  | { kind: "customModeChanged"; active: CustomModeSession | null; exitedLabel: string | null }
  // DD-AR-9 (turnSettled protocol): the adapter reported how the turn ended —
  // COMPLETED | FAILED | INTERRUPTED (+ interruptedBy / stopReason).
  | { kind: "turnSettled"; bubbleId: string; settled: TurnSettled }
  // Context ring (cursor.com/docs/agent/prompting): the real 8-category
  // token breakdown, recomputed after every settled turn — drives the
  // webview's {type:'ctxUsage'} tray with live data. GAPS-183:
  // contextWindowTokens is the denominator windowPct was computed against
  // (the active model's real contextTokenLimit, or the fork fallback).
  | {
      kind: "contextUsage";
      sources: ContextUsageSource[];
      totalTokens: number;
      windowPct: number;
      contextWindowTokens: number;
    };

/** Cursor tool-call card kind → hook tool name (for post-tool hook payloads). */
const KIND_TO_HOOK_TOOL: Record<string, string> = {
  read_tool_call: "read",
  edit_tool_call: "edit",
  apply_agent_diff_tool_call: "patch",
  shell_tool_call: "bash",
  glob_tool_call: "glob",
  grep_tool_call: "grep",
  ls_tool_call: "ls",
  update_todos_tool_call: "todowrite",
  read_todos_tool_call: "todoread",
  fetch_tool_call: "webfetch",
  web_search_tool_call: "websearch",
  task_tool_call: "task",
  ask_question_tool_call: "question",
};

/**
 * ComposerDataService — the central data hub (mirrors Cursor's
 * composerDataService). Owns the bubble store, mode, approvals, checkpoints
 * and the message queue; applies engine TurnEvents to the store and notifies
 * the webview through onDidChange. Swap the engine adapter to go live.
 */
export class ComposerDataService {
  readonly bubbles = new ComposerBubbleSetStore();
  readonly modes = new ModeService();
  readonly reviews = new HumanReviewService();
  readonly checkpoints: CheckpointService;
  readonly queue = new MessageQueueService();
  /**
   * Cursor-style .mdc project rules. Injected into the agent request on every
   * submit (Cursor's writeRulesEntry / onBeforeSubmitChat). Agent Chat ONLY —
   * never consulted by Cmd+K or Tab paths (parity spec §A6).
   */
  readonly projectRules: ProjectRulesService;
  /**
   * GAPS-36D (rules-user): Cursor-style global User Rules. Stored in the
   * extension global storage so they apply across ALL projects (binary
   * string: "User Rules apply to all of your chats"); injected into the
   * agent request on every submit, AFTER the project-rules block (docs
   * precedence: Team Rules → Project Rules → User Rules). Agent Chat ONLY —
   * never consulted by Cmd+K or Tab paths (docs: "User Rules are not
   * applied to Inline Edit (Cmd/Ctrl+K). They are only used by Agent
   * (Chat)").
   */
  readonly userRules: UserRulesService;
  /**
   * M-03 (model picker): the chat model selection — persisted per workspace
   * (workspaceState), restored at startup, shown in the composer model button.
   */
  readonly models: ModelService;
  private engine: EngineAdapter;
  private running = false;
  /**
   * P2 (QA-CHATTABS-01): the drain window. Incremented in runTurn's finally
   * from `running = false` until the drain loop (interrupts + queue)
   * completes. While > 0, submit() must NOT start a second runTurn on this
   * composer — it routes into the queue/interrupt FIFO instead. Without
   * this, a submit landing in the await window started a concurrent runTurn
   * sharing one adapter (corrupt abort/timeout state, double billing).
   * A counter (not a boolean): the drain loop awaits follow-up runTurns,
   * whose own finally must not clear the outer drain window.
   */
  private drainDepth = 0;
  /**
   * P2 (QA-CHATTABS-01): stable per-composer id tagging this composer's hook
   * output in the shared HookService — each tab drains only its own scope,
   * so hook stdout never crosses tabs.
   */
  private static composerSeq = 0;
  private readonly hookScope: string = `composer-${++ComposerDataService.composerSeq}`;
  /**
   * DEV-GAPS-34 (hooks-21-events): sessionStart timestamp for the sessionEnd
   * hook payload (`duration_ms`). A composer IS the conversation here —
   * dispose() ends the session.
   */
  private readonly sessionStartMs: number = Date.now();
  /**
   * Stable per-composer id (also used as the `composerId` passed to MCP
   * providers' `callTool(name, args, { composerId })` — Cursor's browser
   * provider maps it to the tool call's `ownerAgentId`).
   */
  get composerId(): string {
    return this.hookScope;
  }
  /**
   * W71B (DEV-GAPS-71): the chat tab id owning this composer, set by
   * `ChatTabService.createTab` (the per-tab wiring site). The core
   * `IComposerPlanService` registry is keyed by tab id — the same id the
   * `composer.acceptPlan` command resolves from the open
   * `ComposerChatEditorInput`'s `tabId` — so the plan-producer bridge
   * (`capturePendingPlan` -> `ide.recordComposerPlan`, `clearPendingPlan` ->
   * `ide.clearComposerPlan`) records under this id. Unset in unit tests, where
   * the bridge is skipped.
   */
  tabId: string | undefined;
  /**
   * P3 (QA-CHATTABS-01 P3-2): the mode of the currently-running turn, so a
   * clarifying question asked mid-turn remembers which mode asked it.
   */
  private currentTurnMode: ModeName | undefined;
  /**
   * Sink for parity-rule logging (approval shadow mode). Wired in the
   * constructor to the shared "IDE Agent" output channel.
   */
  log?: (line: string) => void;
  /**
   * Doc-gap A12: clarifying questions asked by the agent mid-turn
   * (ask_question_tool_call), keyed by questionId. Answered questions are
   * removed; the answer is steered into the running turn.
   */
  private readonly pendingQuestions = new Map<string, import("../model").ClarifyingQuestion>();
  /**
   * DEV-GAPS-19 (subagent-async-ask-settle): the turn-builder step log for
   * async ask-question steps. Cursor's binary settles these via
   * `settleAsyncAskQuestionSteps` — a backwards scan of the turn's steps
   * capped by a `stepReads` budget (evidence:
   * docs/rea/deepdig-runtime-subagent-2026-10-19.md §3; `stepReads` is
   * verbatim from the identifier slice). Shares the pendingQuestions
   * lifecycle: cleared on dispose/newChat, NOT at turn end — an async
   * question may be answered after its (sub)agent turn finished.
   */
  private readonly askQuestionSteps = new AsyncAskQuestionStepLog();
  /**
   * Plan mode: the plan produced by the last plan-mode turn, awaiting user
   * review (Accept / Discard). Null when there is no pending plan.
   */
  private pendingPlan: PendingPlan | null = null;
  /**
   * GAPS-186: execution data (planName/planTitle/planTodos) of the last
   * plan accepted through the CORE path, forwarded by the core plan
   * service's extraction. Null until a core accept lands on this tab.
   */
  private lastAcceptedPlanExecution: AcceptedPlanExecution | null = null;
  /** P2 (QA-PLANMODE-01): reentrancy guard for acceptPlan's async resolve. */
  private acceptingPlan = false;
  /**
   * GAPS-46D (agent-custom-modes): the active custom-mode session — the
   * extension-tier mirror of the binary's composer-data fields
   * (`activeCustomMode`, `committedCustomMode`, `pendingExitedCustomMode`).
   * A custom mode rides as an overlay: unifiedMode is UNCHANGED, the skill
   * body is injected into the engine-bound prompt on every turn until the
   * user exits the mode (docs.cursor.com/agent/prompting).
   */
  private activeCustomMode: CustomModeSession | null = null;
  /**
   * Snapshot of the mode committed at the last submitted turn (binary
   * `committedCustomMode`). The turn carries the committed snapshot while
   * `activeCustomMode` keeps living for the next turn.
   */
  private committedCustomMode: CustomModeSession | null = null;
  /** Label of the mode just exited (binary `pendingExitedCustomMode`). */
  private pendingExitedCustomMode: { label: string } | null = null;
  /**
   * DEV-GAPS-16: in-memory plan-file telemetry log. HONEST DIVERGENCE: this
   * codebase has no telemetry backend, so plan-file resolve/recreate/failure
   * events are recorded here (and on the "IDE Agent" output channel) only.
   * Event names are our own (see planFileService.PLAN_FILE_TELEMETRY) — do
   * not claim Cursor uses these names.
   */
  private readonly planFileTelemetry: Array<{
    event: PlanFileTelemetryEvent;
    source: PlanFileResolveSource;
    reason?: string;
    at: number;
  }> = [];
  /**
   * P1-2 (QA-CHATTABS-01): dispose handle for the sidecar adapter, so
   * closing a chat tab kills its `bun serve` process instead of leaking it
   * until extension deactivate. (The context.subscriptions registration in
   * the constructor still covers extension deactivate.)
   */
  private engineDisposer: (() => void) | undefined;
  /** P1-2 (QA-CHATTABS-01): dispose() is idempotent. */
  private disposed = false;
  // P2 (CX2b): whether turns run against a real engine (sidecar) or the
  // scripted stub — drives the webview's engine-status hint.
  private readonly engineConnected: boolean;

  private readonly emitter = new vscode.EventEmitter<ComposerEvent>();
  readonly onDidChange = this.emitter.event;

  constructor(
    private readonly context?: vscode.ExtensionContext,
    /**
     * DEV-HOOKS: Cursor-style agent hooks. Optional — the composer works
     * without it (all hook call sites fast-path on hasHooks()).
     */
    readonly hookService?: HookService,
  ) {
    // P1-scope init: field initializers can't see the constructor param.
    this.checkpoints = new CheckpointService(context);
    const requestApproval = (
      toolCallId: string,
      title: string,
      reasons: string[],
      allowlistIdentity?: string,
      // GAPS-12 (approval-card-diff): forwarded to the review service so the
      // approval card can render the file-edit unified diff (context 2).
      approvalDetails?: ApprovalDetails,
      // GAPS-22B: shell/terminal candidate command labels — forwarded so the
      // allowlist button label is built Cursor-verbatim (binary `ycp`).
      allowlistCandidates?: readonly string[],
      // DEV-GAPS-66/W66A (`agent-accept-pending-decisions`): the engine
      // tool identity for this approval — forwarded so the pending-decision
      // group algorithm can classify by `clientSideTool` (binary
      // @27756684).
      clientSideTool?: string,
    ) => this.reviews.requestApproval(toolCallId, title, reasons, undefined, undefined, allowlistIdentity, approvalDetails, allowlistCandidates, clientSideTool);
    const cfg = vscode.workspace.getConfiguration("ide.agent");
    const rawMode = cfg.get<string>("engineMode", "sidecar");
    // P1 (QA-04-VERIFY): validate — an invalid value used to silently run the
    // demo StubEngineAdapter with no warning.
    const mode = rawMode === "sidecar" || rawMode === "stub" ? rawMode : null;
    if (mode === null) {
      void vscode.window.showWarningMessage(
        `IDE Agent: unrecognized ide.agent.engineMode "${rawMode}" — expected "stub" or "sidecar". Falling back to "sidecar".`,
      );
    }
    if (mode === "sidecar") {
      const resolvedEngine = resolveEnginePath(cfg.get<string>("enginePath", ""));
      const output = vscode.window.createOutputChannel("IDE Agent");
      const adapter = new IdeCodeEngineAdapter({
        enginePath: resolvedEngine.enginePath,
        bunPath: resolveBunPath(resolvedEngine, undefined, (candidate) =>
          output.appendLine(
            `[ide-agent] bundled bun missing at ${candidate}; falling back to bun on PATH`,
          ),
        ),
        engineSource: resolvedEngine.source,
        engineCwd: resolveEngineCwd(resolvedEngine, context?.globalStorageUri?.fsPath),
        enginePathDiagnostic: resolvedEngine.bundledBroken
          ? bundledIncompleteDiagnostic(resolvedEngine.bundledBroken)
          : undefined,
        output,
        requestApproval,
        // P2 (QA-FILE-04): feeds the chat-mode read-only gate in handleApproval.
        getMode: () => this.modes.getMode(),
        // DEV-HOOKS: the approval path is the blocking tool-hook choke point.
        hooks: this.hookService,
        // P2-5 (QA-CHATTABS-01): tag this composer's hook output so the
        // shared HookService buffers it per tab.
        hookScope: this.hookScope,
        // DD-AR-3 (resume-from-checkpoint): the "before" checkpoint is
        // captured on the human bubble — the adapter reads it when a
        // retried attempt builds its resumeAction.
        getLatestCheckpointId: (bubbleId) => this.checkpoints.getByBubble(bubbleId)?.checkpointId,
      });
      this.engine = adapter;
      this.engineDisposer = () => adapter.dispose();
      context?.subscriptions.push({ dispose: () => adapter.dispose() });
    } else {
      this.engine = new StubEngineAdapter(requestApproval);
    }
    this.engineConnected = mode === "sidecar";
    // M-03 (model picker): restore the persisted selection and apply it to
    // the engine. At startup no sessions exist yet, so setModel only records
    // the selection for session creation — the sidecar is NOT spawned here.
    const modelStore: ModelSelectionStore = {
      load: () => context?.workspaceState.get<ModelSelection>(MODEL_STATE_KEY),
      save: (selection) => {
        void context?.workspaceState.update(MODEL_STATE_KEY, selection);
      },
    };
    this.models = new ModelService(modelStore);
    this.models.onDidChangeModel((selection) => {
      // GAPS-183: the context ring/report denominator belongs to the ACTIVE
      // model — a selection change invalidates the cached limit and the
      // attempted-refresh marker so the next compute re-resolves against
      // the new model (the cache is also keyed by selection, so a stale
      // limit could never be served even without this reset).
      this.contextLimitCache = undefined;
      this.contextLimitAttemptedKey = undefined;
      this.emitter.fire({ kind: "modelChanged", selection });
    });
    const persistedModel = this.models.getSelection();
    const engine = this.engine;
    if (persistedModel.ref && typeof engine.setModel === "function") {
      void engine.setModel(persistedModel.ref).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        void vscode.window.showWarningMessage(
          `IDE Agent: could not restore the saved model "${persistedModel.label}" — ${message}`,
        );
      });
    }
    this.modes.onDidChangeMode((mode) => this.emitter.fire({ kind: "modeChanged", mode }));
    // Context ring (live): recompute the breakdown whenever the transcript,
    // mode, or rules change — throttled + deduped so per-chunk streaming
    // updates don't spam the webview. turnSettled/newChat force a final emit.
    this.emitter.event((event) => {
      if (event.kind === "newChat") {
        // A fresh chat resets every figure — force the push through the throttle.
        this.emitContextUsage(true);
      } else if (event.kind === "bubblesChanged" || event.kind === "modeChanged") {
        this.emitContextUsage(false);
      }
    });
    this.queue.onDidChangeQueue((items) =>
      this.emitter.fire({ kind: "queueChanged", length: items.length, items: [...items] }),
    );
    // Parity-rule logging (approval shadow mode) goes to the
    // shared output channel; also forwarded into the approval service so its
    // shadow-mode decisions are logged in the same place.
    const parityLog = vscode.window.createOutputChannel("IDE Agent");
    this.log = (line: string) => parityLog.appendLine(line);
    this.reviews.log = (line: string) => parityLog.appendLine(line);
    // Cursor-style .mdc project rules — discovered once at startup, watched live.
    this.projectRules = new ProjectRulesService(vscode.window.createOutputChannel("IDE Agent"));
    void this.projectRules.refresh();
    // Context ring (live): rule set changes alter the Rules category figure.
    this.projectRules.onDidChangeRules(() => this.emitContextUsage(false));
    // GAPS-36D (rules-user): global User Rules — same output channel, stored
    // in the extension global storage (applies to all projects). When the
    // extension context is unavailable the store path is empty and the
    // service degrades to an in-memory empty rule set.
    this.userRules = new UserRulesService({
      globalStorageDir: context?.globalStorageUri?.fsPath ?? "",
      output: vscode.window.createOutputChannel("IDE Agent"),
    });
    this.userRules.onDidChangeRules(() => this.emitContextUsage(false));
    if (context) {
      this.projectRules.startWatching(context);
      context.subscriptions.push(this.projectRules);
    }
  }

  /**
   * True when turns run against the real engine sidecar; false when they run
   * against the scripted stub. P2 (CX2b): the webview bakes its engine-status
   * hint from this at render time.
   */
  get isEngineConnected(): boolean {
    return this.engineConnected;
  }

  /**
   * M-03 (model picker): the engine behind this composer. Callers must
   * feature-check the optional model methods (listModels/setModel) —
   * the scripted stub has no model catalog.
   */
  getEngineAdapter(): EngineAdapter {
    return this.engine;
  }

  /**
   * Context ring: provider for the connected-MCP tool catalog, wired by
   * extension.ts after activateMcp (composers are created before
   * McpService). Undefined → the MCP category honestly reports 0.
   */
  private mcpToolsProvider?: () => McpCatalogEntry[];
  setMcpToolsProvider(provider: () => McpCatalogEntry[]): void {
    this.mcpToolsProvider = provider;
  }

  /**
   * Context ring (cursor.com/docs/agent/prompting): compute the 8-category
   * breakdown from REAL host-observed data. Called after every settled turn.
   *
   * HONESTY (hard rule):
   * - Token figures are chars/4 ESTIMATES — the engine owns authoritative
   *   accounting server-side and reports no usage over the wire.
   * - "System prompt" and "Tools" (built-in) are UNKNOWN to the host: the
   *   engine (OpenCode sidecar) assembles the system prompt and owns the
   *   built-in tool definitions server-side; the host's prompt POST carries
   *   only {text, files, skills}. They measure 0 here — NEVER a guess.
   *   TODO: wire engine-side usage reporting when the sidecar exposes it.
   * - "Rules": always-inject .mdc rules only (kind "always", env-eligible) —
   *   the exact <rule> entry text buildInjection() merges into every agent
   *   request. Auto-attached/manual rules enter the prompt on demand, so
   *   they are not counted (counting them would overstate the typical turn).
   * - "Skills": the real request-context name+description list
   *   (RequestContextSkillsPart) the adapter attaches to the turn.
   * - "MCP": the real connected-servers catalog (namespaced names +
   *   descriptions + input schemas).
   * - "Subagents": the real instruction text sent when launching subagents
   *   (multitask decomposer + worker framing) — the documentation the agent
   *   sees for the subagent types it can launch.
   * - "Summarized conversation": the adopted background-summary text; 0
   *   until the summarizer adopts its first summary (no fabrication).
   * - "Conversation": the SSE-observed transcript (TranscriptTracker).
   */
  /**
   * GAPS-183: cached real context limit for the active model, keyed by
   * `selectionValue(selection)` ("auto" | "cursor-default" | the ref wire
   * form). Keying by selection is the correctness guard: a limit resolved
   * for one model is NEVER served for another — when the selection moves,
   * the key stops matching and the denominator falls back until the new
   * model's limit resolves.
   */
  private contextLimitCache: { key: string; limit: number } | undefined;
  /** Selection key a catalog refresh was already attempted for (success or failure) — stops per-chunk refresh hammering; reset on model change. */
  private contextLimitAttemptedKey: string | undefined;
  /** Selection key with a catalog refresh currently in flight. */
  private contextLimitRefreshKey: string | undefined;

  /**
   * GAPS-183: the denominator for the context ring AND the context usage
   * report — the active model's REAL `contextTokenLimit` from the engine
   * model catalog (see resolveActiveContextTokenLimit in modelService.ts).
   * Until it resolves (and whenever it cannot), this returns the fork's
   * FALLBACK_CONTEXT_WINDOW_TOKENS (200k) — a fork-local fallback, NOT a
   * Cursor behavior (the binary's limit comes from the server). The lookup
   * is synchronous (computeContextUsage runs on a throttled hot path), so
   * the catalog fetch happens in a fire-and-forget refresh; when it lands
   * with a different limit, the ring is re-emitted with the real percent.
   */
  private activeContextWindowTokens(): number {
    const key = selectionValue(this.models.getSelection());
    if (this.contextLimitCache && this.contextLimitCache.key === key) {
      return this.contextLimitCache.limit;
    }
    this.maybeRefreshContextTokenLimit(key);
    return FALLBACK_CONTEXT_WINDOW_TOKENS;
  }

  /**
   * GAPS-183: fire-and-forget catalog refresh for one selection key.
   * Guards, in order:
   * - one attempt per key until the model changes (no hammering on every
   *   streamed chunk; a failed/stub resolution keeps the fallback);
   * - stub engine (no listModels) → no catalog exists, stay on fallback;
   * - sidecar not started yet → do NOT call listModels: it would spawn the
   *   engine process just to read a denominator. The refresh is retried by
   *   later computes once a turn has started the server.
   */
  private maybeRefreshContextTokenLimit(key: string): void {
    if (this.contextLimitAttemptedKey === key || this.contextLimitRefreshKey === key) {
      return;
    }
    const engine = this.engine;
    if (typeof engine.listModels !== "function") {
      return;
    }
    if (engine instanceof IdeCodeEngineAdapter && !engine.hasStartedServer) {
      return;
    }
    this.contextLimitAttemptedKey = key;
    this.contextLimitRefreshKey = key;
    void (async () => {
      try {
        const catalog = await engine.listModels!();
        const selection = this.models.getSelection();
        let defaultModel: EngineModelInfo | undefined;
        if (!selection.ref && typeof engine.getDefaultModel === "function") {
          defaultModel = await engine.getDefaultModel().catch(() => undefined);
        }
        const limit = resolveActiveContextTokenLimit({ selection, catalog, defaultModel });
        if (limit === undefined) {
          return; // unresolved for this key — fallback stays (attempted key stops retries)
        }
        if (selectionValue(this.models.getSelection()) !== key) {
          return; // the selection moved on mid-flight — never cache another model's limit
        }
        const changed =
          this.contextLimitCache?.key !== key || this.contextLimitCache.limit !== limit;
        this.contextLimitCache = { key, limit };
        if (changed) {
          this.emitContextUsage(true);
        }
      } catch {
        // Fail-closed: the fallback denominator stays; the attempted key
        // prevents a retry loop until the model changes.
      } finally {
        if (this.contextLimitRefreshKey === key) {
          this.contextLimitRefreshKey = undefined;
        }
      }
    })();
  }

  private computeContextUsage(): {
    sources: ContextUsageSource[];
    totalTokens: number;
    windowPct: number;
    contextWindowTokens: number;
  } {
    const mode = this.currentTurnMode ?? this.modes.getMode();

    // Rules: exact injected <rule>…</rule> entry text for always-inject rules.
    let rulesTextChars = 0;
    try {
      const rules = this.projectRules
        .getRules()
        .filter((r) => r.kind === "always" && ruleAppliesToEnv(r) && !r.parseError);
      rulesTextChars = rules.reduce((a, r) => a + formatRuleEntry(r).length, 0);
    } catch {
      // Fail-closed: unmeasurable → 0, never a guess.
    }

    // Skills: real request-context part (name + description per skill).
    let skillsTextChars = 0;
    try {
      skillsTextChars = skillsListChars(requestContextSkills().skills);
    } catch {
      // Fail-closed.
    }

    // MCP: real connected-servers tool catalog.
    let mcpTools: McpCatalogEntry[] = [];
    try {
      mcpTools = this.mcpToolsProvider?.() ?? [];
    } catch {
      mcpTools = [];
    }
    const mcpTextChars = mcpCatalogChars(mcpTools);

    // Subagents: the real instruction docs for launchable subagent types.
    const subagentDocChars = DECOMPOSE_INSTRUCTION.length + WORKER_INSTRUCTION.length;

    // Summarized conversation + Conversation: engine-adapter observed state.
    let conversationTokens = 0;
    let summarizedChars = 0;
    const engine = this.engine;
    if (engine instanceof IdeCodeEngineAdapter) {
      conversationTokens = engine.getConversationEstimatedTokens(mode);
      summarizedChars = engine.getAdoptedSummaryText(mode)?.length ?? 0;
    }

    const breakdown = computeContextUsageBreakdown({
      // UNKNOWN (engine-owned, server-side): honestly 0 — see method docs.
      systemPromptChars: 0,
      toolDefChars: 0,
      rulesTextChars,
      skillsTextChars,
      mcpTextChars,
      subagentDocChars,
      summarizedChars,
      conversationTokens,
      // GAPS-183: denominator = the active model's real contextTokenLimit
      // (fork fallback 200k only while/when it cannot be resolved).
      contextWindowTokens: this.activeContextWindowTokens(),
    });
    return {
      sources: breakdown.sources,
      totalTokens: breakdown.totalTokens,
      windowPct: breakdown.windowPct,
      contextWindowTokens: breakdown.contextWindowTokens,
    };
  }

  /**
   * Context ring (live): recompute the breakdown from real data and fire the
   * `contextUsage` composer event when the payload changed. Streaming fires
   * bubblesChanged per chunk — the 500ms throttle + JSON dedupe keep the
   * webview from re-rendering on identical payloads. force=true bypasses
   * both (turnSettled / newChat must always push a fresh figure).
   */
  private lastContextUsageJson = "";
  private lastContextUsageEmitAt = 0;
  private static readonly CONTEXT_USAGE_THROTTLE_MS = 500;

  private emitContextUsage(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastContextUsageEmitAt < ComposerDataService.CONTEXT_USAGE_THROTTLE_MS) {
      return;
    }
    const usage = this.computeContextUsage();
    const json = JSON.stringify(usage);
    if (!force && json === this.lastContextUsageJson) {
      return;
    }
    this.lastContextUsageJson = json;
    this.lastContextUsageEmitAt = now;
    this.emitter.fire({
      kind: "contextUsage",
      sources: usage.sources,
      totalTokens: usage.totalTokens,
      windowPct: usage.windowPct,
      contextWindowTokens: usage.contextWindowTokens,
    });
  }

  /**
   * Context ring: full-sync snapshot for hosts. The live `contextUsage`
   * composer event covers later deltas; hosts post this once when a webview
   * (re)resolves so the ring never starts empty while data exists.
   */
  getContextUsageSnapshot(): {
    sources: ContextUsageSource[];
    totalTokens: number;
    windowPct: number;
    contextWindowTokens: number;
  } {
    const usage = this.computeContextUsage();
    return {
      sources: usage.sources,
      totalTokens: usage.totalTokens,
      windowPct: usage.windowPct,
      contextWindowTokens: usage.contextWindowTokens,
    };
  }

  /**
   * GAPS-167 (canvas context usage report): full report data for the
   * webview report panel — the fork-surface equivalent of Cursor's canvas
   * report (see contextUsageReport.ts for binary evidence + divergences).
   *
   * HONESTY: every item text below is the SAME real text computeContextUsage
   * measures for the category totals (injected rule entries, the request-
   * context skill list, the MCP catalog, the subagent instruction docs,
   * the adopted summary, the SSE-observed transcript segments). Categories
   * the host cannot observe (System prompt / Tools) stay 0 and drop out of
   * the report — never estimated. All gathering is fail-closed: an
   * unmeasurable source contributes no items rather than a guess.
   */
  getContextUsageReport(opts?: { chatName?: string; repository?: string }): ContextUsageReportData {
    const mode = this.currentTurnMode ?? this.modes.getMode();
    const itemsByCategory = new Map<string, { label: string; text: string }[]>();

    // Rules: the exact injected <rule>…</rule> entry per always-inject rule.
    try {
      const rules = this.projectRules
        .getRules()
        .filter((r) => r.kind === "always" && ruleAppliesToEnv(r) && !r.parseError);
      if (rules.length > 0) {
        itemsByCategory.set(
          "rules",
          rules.map((r) => ({ label: r.filename, text: formatRuleEntry(r) })),
        );
      }
    } catch {
      // Fail-closed: no items, totals already report 0/measured elsewhere.
    }

    // Skills: the real request-context entries (name + description — the
    // text whose length skillsListChars measures for the total).
    try {
      const skills = requestContextSkills().skills;
      if (skills.length > 0) {
        itemsByCategory.set(
          "skills",
          skills.map((s) => ({ label: s.name, text: `${s.name}\n${s.description}` })),
        );
      }
    } catch {
      // Fail-closed.
    }

    // MCP: the real connected-servers catalog entries.
    try {
      const tools = this.mcpToolsProvider?.() ?? [];
      if (tools.length > 0) {
        itemsByCategory.set(
          "mcp",
          tools.map((t) => ({
            label: t.namespacedName,
            text: `${t.namespacedName}\n${t.description}\n${t.inputSchemaJson}`,
          })),
        );
      }
    } catch {
      // Fail-closed.
    }

    // Subagents: the two real instruction docs the agent sees.
    itemsByCategory.set("subagents", [
      { label: "Multitask decomposer instructions", text: DECOMPOSE_INSTRUCTION },
      { label: "Subagent worker instructions", text: WORKER_INSTRUCTION },
    ]);

    // Summarized conversation + Conversation: engine-adapter observed state.
    let incompleteReport = false;
    const engine = this.engine;
    if (engine instanceof IdeCodeEngineAdapter) {
      const summary = engine.getAdoptedSummaryText(mode);
      if (summary) {
        itemsByCategory.set("summarized_conversation", [
          { label: "Conversation summary", text: summary },
        ]);
      }
      const { segments, truncated } = engine.getConversationSegments(mode);
      incompleteReport = truncated;
      if (segments.length > 0) {
        const conv = conversationItemsFromSegments(segments);
        if (conv.items.length > 0) {
          itemsByCategory.set("conversation", conv.items);
          const usage = this.computeContextUsage();
          return buildContextUsageReport({
            sources: usage.sources,
            // GAPS-183: same real denominator as the ring (usage is
            // computed by computeContextUsage, the single source).
            contextWindowTokens: usage.contextWindowTokens,
            itemsByCategory,
            conversationTurns: conv.turns,
            composerChatName: opts?.chatName,
            repository: opts?.repository,
            incompleteReport,
          });
        }
      }
    }

    const usage = this.computeContextUsage();
    return buildContextUsageReport({
      sources: usage.sources,
      // GAPS-183: same real denominator as the ring.
      contextWindowTokens: usage.contextWindowTokens,
      itemsByCategory,
      composerChatName: opts?.chatName,
      repository: opts?.repository,
      incompleteReport,
    });
  }

  /**
   * P2 (CX2b): re-announce the engine connection state to the webview so its
   * engine-status hint never goes stale. Call after (re)resolving the view
   * and from any future path that changes the engine's health.
   */
  notifyEngineStatus(): void {
    this.emitter.fire({ kind: "engineStatus", connected: this.engineConnected });
  }

  /** Submit a user message. Queues while a turn runs; starts a turn otherwise.
   *
   * Cursor parity (queueMessageDefaultBehavior / queueManualSendBehavior):
   * while a turn is running, Enter follows the default behavior, the Send
   * button / Cmd+Enter follows the manual behavior, and Alt+Enter always
   * queues. "send" delivers at the next opportune time, "stop-and-send"
   * stops the turn immediately and sends, "queue" waits for the turn.
   *
   * `ide.general.leakDetectionEnabled`: prompts that look like they contain
   * a secret get a modal Send-anyway/Cancel choice before anything is sent.
   */
  submit(prompt: string, opts?: SubmitOptions): void {
    const text = prompt.trim();
    if (!text) {
      return;
    }
    // GAPS-170: tooltip pipeline producer — the binary's in-core chat
    // emits `chat.submit` on chat submit; this data service is the fork
    // chat's central submit path, so the event is forwarded to the core
    // tooltipService through the fork-local bridge command
    // `composer.tooltip.registerEvent` (see work-notes-gaps170.md D2).
    void vscode.commands.executeCommand(
      "composer.tooltip.registerEvent",
      "chat.submit",
    );
    if (
      vscode.workspace.getConfiguration("ide.general").get<boolean>("leakDetectionEnabled", true)
    ) {
      const findings = scanPromptForSecrets(text);
      if (findings.length > 0) {
        void vscode.window
          .showWarningMessage(
            `IDE Agent: your message looks like it contains a secret (${findings.map((f) => f.label).join(", ")}). ` +
              `Sending it would share the secret with the AI engine.`,
            { modal: true },
            "Send anyway",
          )
          .then((choice) => {
            if (choice === "Send anyway") {
              void this.submitWithHooks(text, opts);
            }
          });
        return;
      }
    }
    void this.submitWithHooks(text, opts);
  }

  /**
   * DEV-GAPS-10 (agent-git-branch-reminder): post a REAL system-role bubble
   * into the transcript — visible in chat as a "System" message, part of the
   * conversation (the webview renders role "system" generically). Used for
   * branch-change reminders and similar agent-loop notices. This is a normal
   * data-service mutation: the store updates and a bubblesChanged event
   * fires so the webview syncs — never a console.log.
   *
   * Returns the new bubble id.
   */
  postSystemMessage(text: string): string {
    const bubbleId = this.bubbles.newClientBubbleId();
    this.bubbles.setBubbleData({
      bubbleId,
      role: "system",
      mode: this.modes.getMode(),
      text,
      toolCalls: [],
      createdAt: Date.now(),
    });
    this.emitter.fire({ kind: "bubblesChanged", ids: [bubbleId] });
    return bubbleId;
  }

  /**
   * DEV-HOOKS: `beforeSubmitPrompt` gate (Cursor parity, matcher "UserPromptSubmit").
   * Exit code 2 blocks the submission — the turn never starts. Hook stdout
   * flows into the turn's context via drainContextAdditions().
   */
  private async submitWithHooks(text: string, opts?: SubmitOptions): Promise<void> {
    // A follow-up chain from stop hooks counts against the stop loop_limit.
    this.stopChainDepth = 0;
    const svc = this.hookService;
    if (svc?.hasHooks("beforeSubmitPrompt")) {
      let r;
      try {
        r = await svc.runHooks("beforeSubmitPrompt", {
          submitKind: "UserPromptSubmit",
          prompt: text,
          mode: this.modes.getMode(),
        }, this.hookScope);
      } catch (err) {
        // Hook infra failure must never kill a submit — log and continue.
        void vscode.window.showWarningMessage(
          `IDE Agent: hook error on submit — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (r?.blocked) {
        void vscode.window.showErrorMessage(
          `IDE Agent: submission blocked by hook — ${r.blockReason ?? "no reason given"}`,
        );
        return;
      }
    }
    if (this.running || this.isDraining) {
      try {
        this.routeSubmit(text, opts);
      } catch (err) {
        // routeSubmit no longer throws for oversize messages (the fabricated
        // queue caps are gone — enqueue()/enqueueFront() are unbounded), but
        // keep the catch so a synchronous throw can never escape as an
        // unhandled promise rejection through `void submitWithHooks(...)`.
        void err;
      }
      return;
    }
    void this.runTurn(text, undefined, opts?.attachments);
  }

  /**
   * Route a hook-approved message submitted while a turn is running.
   * (Cursor parity: queueMessageDefaultBehavior / queueManualSendBehavior,
   * plus the docs "Send now" steer: Cmd/Ctrl+Enter or Enter-twice bypasses
   * the queue and is delivered at the next opportune time without stopping
   * the turn.)
   */
  private routeSubmit(prompt: string, opts?: SubmitOptions): void {
    const sendMode = opts?.sendMode ?? "default";
    const attachments = opts?.attachments;
    if (sendMode === "queue") {
      this.queue.enqueue(prompt, this.modes.getMode(), attachments);
      return;
    }
    if (sendMode === "sendNow") {
      // Bypass the queue entirely — delivered at the next opportune time
      // (next engine-event boundary), turn uninterrupted.
      this.stageInterruptSend({ text: prompt, attachments }, { interrupt: false });
      return;
    }
    const composerCfg = vscode.workspace.getConfiguration("ide.composer");
    const key = sendMode === "manual" ? "queueManualSendBehavior" : "queueMessageDefaultBehavior";
    const behavior = composerCfg.get<string>(key, sendMode === "manual" ? "stop-and-send" : "send");
    if (behavior === "queue") {
      this.queue.enqueue(prompt, this.modes.getMode(), attachments);
    } else if (behavior === "stop-and-send") {
      // Cursor parity (binary-verified: stop-and-send never queues —
      // {shouldStop:!1, reason:"Stop and send"}): abort the current turn and
      // submit the message as a new turn. It is NOT merged into the message
      // queue — it runs as soon as the aborted turn winds down, ahead of any
      // queued messages. A second interrupt supersedes the first.
      this.stageInterruptSend({ text: prompt, attachments }, { interrupt: true });
    } else {
      // "send": deliver at the next opportune time — the runTurn loop breaks
      // after the current engine event, then the staged message runs as its
      // own turn. (Deliberate divergence from Cursor's steer injection: we
      // can't inject into the engine's in-flight context.)
      this.stageInterruptSend({ text: prompt, attachments }, { interrupt: false });
    }
  }

  /**
   * DIG-CONTINUOUS (2026-10-19, binary-verified): Cursor has NO
   * interrupt-sends queue (0 hits, concept absent). Stop-and-send never
   * queues — the capability returns `{shouldStop:!1, reason:"Stop and send"}`
   * and the submit proceeds normally, aborting the current turn and starting
   * a new one with the message.
   *
   * Our cooperative-abort equivalent is a SINGLE slot (not a FIFO, not
   * capped): an interrupt aborts the running turn now and the message runs
   * as its own turn as soon as the aborted turn winds down — ahead of the
   * message queue, never merged into it. A second interrupt supersedes the
   * first (latest wins), matching Cursor where each interrupt is an
   * immediate fresh submit.
   *
   * Steers ("send" behavior / sendNow / clarifying-question answers) share
   * the slot WITHOUT aborting: the runTurn loop breaks after the current
   * engine event and the staged message runs as the next turn. Deliberate
   * divergence from Cursor's steer (queue + promoteQueueItemToSteer into the
   * running turn's context via the daemon injectionLedger): we cannot inject
   * into the engine's in-flight context, so a steer becomes an early turn
   * break plus a follow-up turn. If the slot is already occupied, the
   * newcomer overflows into the (unbounded) message queue so it is never
   * silently lost — it drains after the staged message, preserving order.
   */
  private pendingInterruptSend: { text: string; attachments?: FileAttachment[] } | undefined;

  /**
   * Stage a message to run as the next turn at the next opportune time.
   * `interrupt: true` (stop-and-send) aborts the current turn first and the
   * message supersedes any staged steer; `interrupt: false` (steer) leaves
   * the turn running and overflows to the queue when the slot is taken.
   */
  private stageInterruptSend(
    entry: { text: string; attachments?: FileAttachment[] },
    opts: { interrupt: boolean },
  ): void {
    if (opts.interrupt) {
      // Interrupt supersedes any staged steer: the aborted turn's pending
      // steer dies with it (in Cursor the interrupt is an immediate submit).
      this.abort();
      this.pendingInterruptSend = entry;
      return;
    }
    if (this.pendingInterruptSend === undefined) {
      this.pendingInterruptSend = entry;
    } else {
      // Slot taken: overflow into the unbounded queue — never silently drop
      // a steer (the QA-CHATTABS-01 P2 silent-overwrite case).
      this.queue.enqueue(entry.text, this.modes.getMode(), entry.attachments);
    }
  }

  /**
   * GAPS-152 (`agent-notification-actions`): clean-turn-completion
   * listener — the fork seam for the binary NOTIFICATIONS capability's
   * `onChatStreamFinished` (workbench.desktop.main.js 3.25.9 @31367250).
   * Set by ChatTabService per tab; invoked from afterTurnCompleted(),
   * which only runs on a clean finish (the binary's
   * `status==="completed"` evidence). The listener owns all further
   * gating (enabled / window focus / YOh suppression).
   */
  turnCompletedListener?: () => void;

  /** Post-turn hooks: chime + autosave (Cursor parity settings). */
  private afterTurnCompleted(): void {
    const cfg = vscode.workspace.getConfiguration("ide.composer");
    if (cfg.get<boolean>("shouldChimeAfterChatFinishes", false)) {
      const customPath = cfg.get<string>("customChimeSoundPath", "");
      const defaultPath = this.context ? defaultChimePath(this.context.extensionPath) : undefined;
      void playChime({ customPath, defaultPath });
    }
    if (cfg.get<boolean>("shouldAutoSaveNonAgent", true)) {
      void vscode.workspace.saveAll().then(
        () => undefined,
        () => undefined,
      );
    }
    // GAPS-152: OS "Done" notification producer (see turnCompletedListener).
    try {
      this.turnCompletedListener?.();
    } catch {
      /* a notification listener must never break the post-turn path */
    }
  }
  /** Depth of the current stop-hook follow-up chain (bounded by loop_limit). */
  private stopChainDepth = 0;

  get isRunning(): boolean {
    return this.running;
  }

  /**
   * P2-6 (QA-CHATTABS-01): true while runTurn's finally is draining
   * follow-up turns. closeTab/newChat must treat this like a running turn —
   * closing/clearing mid-drain would orphan ghost turns on dead state.
   */
  get isDraining(): boolean {
    return this.drainDepth > 0;
  }

  /**
   * P3-13 (QA-CHATTABS-X3): the currently-pending clarifying questions.
   * Used to re-post question cards after a tab switch / webview re-resolve
   * (the webview clears its cards on `state`, and the host re-posts live
   * state right after — pending questions are part of that live state).
   */
  getPendingQuestions(): import("../model").ClarifyingQuestion[] {
    return [...this.pendingQuestions.values()];
  }

  /**
   * DEV-GAPS-66/W66A (`agent-accept-pending-decisions`): the pending user
   * decision GROUP for `composer.acceptComposerStep`. Binary-verbatim
   * delegation (`ComposerDataService.getPendingUserDecisionGroup(handle)`
   * @39965884 delegates to the tool-former capability's
   * `getPendingUserDecisionGroup()()`): the fork's review service is the
   * tool-former analog (it owns the pending-decision store), so this
   * delegates to `reviews.getPendingUserDecisionGroup()`.
   */
  getPendingUserDecisionGroup(): import("./humanReviewService").PendingUserDecision[] {
    return this.reviews.getPendingUserDecisionGroup();
  }

  /**
   * DEV-GAPS-66/W66A (`agent-accept-pending-decisions`): the
   * `composerNotificationService.acceptNotification()` fallback of
   * `composer.acceptComposerStep` (binary @17538502:
   * `acceptNotification(){ this.notification_reactive()!==void 0 &&
   * this._onAcceptNotification.fire() }` — fires the accept event only
   * when a composer notification is currently showing; no-op otherwise).
   *
   * HONEST-DIVERGENCE: the fork has no host-side composer-notification
   * service — the only composer-notification analog (the webview's plan
   * nudge banner, modeled on the binary `mode_nudge` notification) is
   * owned and accepted inside the chat webview, which the extension host
   * cannot reach. So with no pending decisions this is a documented no-op
   * — identical to the binary's behavior when no notification is showing.
   * When a host-owned composer notification surface lands, this is the
   * seam it plugs into (fire the binary-equivalent accept event here).
   */
  acceptNotification(): void {
    // Intentionally no-op: no host-owned composer notification service
    // exists yet (see doc comment). Not a silent drop — the binary is
    // also silent when no notification is showing.
  }

  /**
   * P1-2 (QA-CHATTABS-01): dispose this composer — kill the sidecar `bun`
   * process (no more zombie servers on tab close) and settle any pending
   * approvals so no turn hangs. Idempotent: safe to call twice (tab close +
   * extension deactivate both dispose).
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    // DEV-GAPS-34 (hooks-21-events): sessionEnd — "Called when a composer
    // conversation ends" (cursor.com/docs/hooks). Fire-and-forget; dispose
    // is sync and hooks must never break teardown. reason mapping is
    // best-effort: a disposed mid-turn composer counts as "aborted",
    // otherwise the tab was closed by the user ("user_close").
    const hookSvc = this.hookService;
    if (hookSvc?.hasHooks("sessionEnd")) {
      const aborted = this.running || this.abortRequested;
      void hookSvc
        .runHooks(
          "sessionEnd",
          {
            session_id: this.hookScope,
            reason: aborted ? "aborted" : "user_close",
            duration_ms: Date.now() - this.sessionStartMs,
            is_background_agent: false,
            final_status: aborted ? "aborted" : "closed",
          },
          this.hookScope,
        )
        .catch(() => {});
    }
    try {
      this.engineDisposer?.();
    } catch {
      /* dispose must never throw */
    }
    this.engineDisposer = undefined;
    this.reviews.settleAllPending();
    this.pendingQuestions.clear();
    this.askQuestionSteps.clear();
    this.pendingInterruptSend = undefined;
    // DEV-GAPS-25: stop the checkpoint storage-compare scheduler — its 15 s
    // activation timer (then a 10 min interval chain) is ref'd and would keep
    // the event loop alive forever after the tab is gone.
    try {
      this.checkpoints.dispose();
    } catch {
      /* dispose must never throw */
    }
    // DEV-DEBUG-MULTITASK: stop the debug ingest server with the tab.
    this.debugServerSvc?.dispose();
    this.debugServerSvc = undefined;
  }

  /**
   * Abort the running turn, if any. The runTurn loop checks the flag between
   * engine events and stops consuming; the turn ends with a "stopped" note.
   * P1 (QA-FILE-01): wired to the webview's Stop button — also kills the
   * engine's in-flight network/streaming work via engine.abortTurn() so Stop
   * is prompt even when the engine would otherwise wait for more events.
   *
   * GAPS-11B (agent-abort-restore-query): `opts.restoreQuery` implements
   * Cursor's `glass.abortAgentAndRestoreQuery` behavior — the aborted turn's
   * original prompt is fired back as a `restorePrompt` event so the host can
   * refill the composer input for editing (binary evidence: "Abort Agent and
   * Restore Query", workbench.glass.main.js 3.25.6). Only the explicit user
   * Stop path passes restoreQuery: true; internal interrupt/steer aborts
   * (stageInterruptSend) call abort() without it — a new turn follows
   * immediately there, and restoring would fight the handoff.
   */
  abort(opts?: { restoreQuery?: boolean }): void {
    if (this.running) {
      this.abortRequested = true;
      this.engine.abortTurn();
      if (opts?.restoreQuery === true && this.abortedTurnPrompt) {
        this.emitter.fire({ kind: "restorePrompt", text: this.abortedTurnPrompt });
      }
    }
  }
  private abortRequested = false;

  /**
   * DEV-GAPS-56 (agent-resume-chat): resume a paused/ended chat — the
   * runtime behind the binary-verbatim `composer.resumeCurrentChat`
   * ("Resume Current Chat", workbench.glass.main.js 3.25.9, class CAb).
   * Binary port (chatService.resumeChat, recovered verbatim):
   *   resumeChat(handle, opts){
   *     if (!composerDataService.getComposerData(handle))
   *       throw new Error("Cannot resume: chat not found");
   *     submitChatMaybeAbortCurrent(composerId, "",
   *       { ...opts, isResume: true, bubbleId: undefined, ignoreQueuing: true });
   *   }
   * — i.e. it re-enters generation with an EMPTY prompt (no new human
   * message); the model continues the interrupted turn.
   *
   * HONEST FORK PORT: the fork's engine loop can only start a turn from a
   * prompt (runTurn always opens a human bubble; there is no empty-prompt
   * continuation path), so resume here re-submits the interrupted turn's
   * prompt — the same resume primitive as the fork's
   * Continue-Interrupted-Agents sweep (re-submit the survivor's prompt).
   * Only an ABORTED turn is resumable (see `resumablePrompt`): a cleanly
   * settled chat has nothing to continue and resumeChat() returns false.
   * A turn in flight (running/draining) is likewise a no-op — the binary
   * delegates that case to submitChatMaybeAbortCurrent, whose
   * resume-while-running behavior is not statically recoverable.
   *
   * @returns true when a turn was actually resumed.
   * @throws Error("Cannot resume: chat not found") — verbatim — when this
   *   composer holds no conversation data (the binary's guard).
   */
  resumeChat(opts?: { isAutoResume?: boolean }): boolean {
    if (this.disposed || this.bubbles.getAllInOrder().length === 0) {
      throw new Error("Cannot resume: chat not found");
    }
    if (this.isRunning || this.isDraining) {
      return false;
    }
    const prompt = this.resumablePrompt;
    if (!prompt) {
      return false;
    }
    this.resumablePrompt = undefined;
    this.log?.(
      `[ide-agent] resumeChat: resuming interrupted turn (isAutoResume=${opts?.isAutoResume === true})`,
    );
    this.submit(prompt);
    return true;
  }

  /** Whether an aborted turn is waiting to be resumed (resumeChat input). */
  get hasResumableTurn(): boolean {
    return this.resumablePrompt !== undefined;
  }

  /**
   * W69C (`changes-tab-base-branch-menu`): the fork port of the binary's
   * `composerService.isComposerConversationEmpty(composerId)` — the guard
   * inside `cursor.openBranchMenu`'s run() (workbench.glass.main.js
   * 3.25.9 @27418510):
   *   `!s || !n.getComposerDataIfLoaded(s) ||
   *      !i.isComposerConversationEmpty(s) ||
   *      r.fireDidRequestOpenBranchMenu({composerId:s})`
   * i.e. the base-branch menu may only open while the conversation is
   * still EMPTY (no bubbles yet — the base branch is a pre-chat choice).
   * The binary's service is global and takes a composerId; the fork's
   * ComposerDataService is per-composer, so the id is implicit.
   */
  isComposerConversationEmpty(): boolean {
    return this.bubbles.getAllInOrder().length === 0;
  }

  /**
   * GAPS-11B (agent-abort-restore-query): the prompt of the currently
   * running turn, stored at runTurn start so a user Stop can restore it into
   * the composer input (Cursor's abortAgentAndRestoreQuery). Cleared when the
   * turn settles so a stale prompt can never be restored later.
   */
  private abortedTurnPrompt: string | undefined;

  /**
   * DEV-GAPS-56 (agent-resume-chat): the prompt of the most recent ABORTED
   * turn — the only resumable state in this composer. Set in runTurn's
   * settle path when the turn ended via abort(); consumed (cleared) by a
   * successful resumeChat(). A new turn start also supersedes it (the new
   * turn's own outcome decides the next resumable state).
   */
  private resumablePrompt: string | undefined;

  /**
   * GAPS-11B (agent-git-branch-reminder): per-composer tracked git-repo
   * branch state — mirrors Cursor's `this.trackedGitRepoBranches`
   * (extensions/cursor-agent-exec/dist/main.js). Diffed at every pre-turn
   * check; on change a <system_reminder> is injected into the turn's user
   * content.
   */
  private readonly trackedGitRepoState = new TrackedGitRepoState(
    () =>
      readTrackedBranches(
        (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
      ),
    (change: BranchChange) =>
      checkPreviousBranchIsAncestor(change.repoPath, change.from, change.to),
  );

  /**
   * GAPS-11B (agent-git-branch-reminder): pre-turn tracked git-repo branch
   * change detection (Cursor parity — binary-verified, see gitBranchTracker.ts
   * header). Returns the <system_reminder> block to inject into the turn's
   * user content, or "" when disabled / no change / on the first turn.
   * Never throws: a failed probe degrades to no reminder.
   */
  private async checkBranchChangeReminder(): Promise<string> {
    let enabled = true;
    let enhanced = true;
    try {
      const cfg = vscode.workspace.getConfiguration(TRACKED_GIT_REPO_STATE_SECTION);
      enabled = cfg.get<boolean>(TRACKED_GIT_REPO_STATE_KEY, true) !== false;
      // The enhanced-variant default is our choice (Cursor's flag rollout
      // state was not observable); the flag name itself is verbatim.
      enhanced = cfg.get<boolean>(ENHANCED_BRANCH_CHANGE_REMINDER_KEY, true) !== false;
    } catch {
      // keep defaults
    }
    if (!enabled) {
      return "";
    }
    try {
      return await this.trackedGitRepoState.checkForReminder(enhanced);
    } catch (err) {
      this.log?.(
        `[ide-agent] branch-change reminder check failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return "";
    }
  }

  /**
   * DEV-DEBUG-MULTITASK: lazy NDJSON ingest server for Debug mode — one per
   * chat tab, started on the first debug turn, stopped on dispose.
   */
  private debugServerSvc: DebugServerService | undefined;

  private debugServer(): DebugServerService {
    if (!this.debugServerSvc) {
      this.debugServerSvc = new DebugServerService(this.context);
      this.context?.subscriptions.push(this.debugServerSvc);
    }
    return this.debugServerSvc;
  }

  /**
   * DEV-DEBUG-HOLD-UI: public accessor for the per-chat NDJSON ingest
   * server — the DebugModeController subscribes to its `onLine` feed to
   * render the live "Debug Logs" block. Additive only; the server still
   * starts lazily on the first debug turn like the private accessor.
   */
  getDebugServer(): DebugServerService {
    return this.debugServer();
  }

  /**
   * CONTINUE-INTERRUPTED-AGENTS: write this composer's in-flight turn record
   * to workspaceState so a reload/restart that kills the turn leaves a
   * survivor record the next activation can resume. Best-effort: storage
   * writes must never break a turn.
   */
  private markTurnInFlight(prompt: string): void {
    const context = this.context;
    if (!context) {
      return;
    }
    try {
      const records = parseInterruptedTurnRecords(
        context.workspaceState.get<unknown>(INTERRUPTED_TURNS_STORAGE_KEY),
      );
      void context.workspaceState.update(
        INTERRUPTED_TURNS_STORAGE_KEY,
        recordTurnStarted(records, {
          composerId: this.hookScope,
          prompt,
          startedAt: Date.now(),
        }),
      );
    } catch {
      /* bookkeeping must never break a turn */
    }
  }

  /**
   * CONTINUE-INTERRUPTED-AGENTS: the turn settled, so it can no longer be
   * "interrupted by a restart" — drop its record.
   */
  private clearTurnInFlight(): void {
    const context = this.context;
    if (!context) {
      return;
    }
    try {
      const records = parseInterruptedTurnRecords(
        context.workspaceState.get<unknown>(INTERRUPTED_TURNS_STORAGE_KEY),
      );
      void context.workspaceState.update(
        INTERRUPTED_TURNS_STORAGE_KEY,
        recordTurnSettled(records, this.hookScope),
      );
    } catch {
      /* bookkeeping must never break a turn */
    }
  }

  private async runTurn(prompt: string, mode?: ModeName, attachments?: FileAttachment[]): Promise<void> {
    // P2 (QA-CHATTABS Round B, R1): belt-and-braces — never start a turn on
    // a disposed composer (see the check in submitWithHooks). The adapter's
    // ensureServer() also refuses to spawn for a dead tab.
    if (this.disposed) {
      return;
    }
    this.running = true;
    this.abortRequested = false;
    // CONTINUE-INTERRUPTED-AGENTS (Cursor "Continue Interrupted Agents"
    // parity): persist the in-flight turn record BEFORE any await so a
    // reload/restart mid-turn leaves a survivor record behind (its settle
    // path never runs, so nothing clears it). The startup sweep in
    // extension.ts re-submits survivors when the setting is on.
    this.markTurnInFlight(prompt);
    // GAPS-11B (agent-abort-restore-query): remember the turn's prompt so a
    // user Stop can restore it into the composer input (Cursor's
    // abortAgentAndRestoreQuery). Stored before any await so it is visible
    // even if abort() lands during the first async gap.
    this.abortedTurnPrompt = prompt;
    // DEV-GAPS-56: a fresh turn supersedes any older resumable state — the
    // new turn's own outcome (abort vs settle) decides what is resumable next.
    this.resumablePrompt = undefined;
    this.emitter.fire({ kind: "turnState", running: true });
    // The turn's mode: explicitly passed for queued messages (preserving the
    // mode each was queued with), otherwise the current UI mode.
    let turnMode = mode ?? this.modes.getMode();
    // DEV-DEBUG-MULTITASK: Cursor auto-switches to Debug when the submitted
    // text mentions debug/bug/debugging (spec §3.6/§5 [BIN]). Fresh submits
    // only — queued messages keep the mode they were queued with. (The
    // binary's >1-model guard is vacuous here: our model picker is
    // single-select.)
    if (mode === undefined && turnMode === "agent" && shouldSuggestDebugMode(prompt)) {
      this.modes.setMode("debug");
      turnMode = "debug";
      this.log?.("[ide-agent] debug mode auto-suggested (message mentions debugging)");
    }
    // P3-2 (QA-CHATTABS-01): remember the asking turn's mode so a clarifying
    // question answered while idle steers with the right mode.
    this.currentTurnMode = turnMode;
    // P1 (QA-04-VERIFY): declared outside try so the catch can append the
    // error to the assistant bubble.
    let assistantId = "";
    // SETTINGS-PARITY: tracks whether the turn threw, so post-turn hooks
    // (chime/autosave) only run on clean completion.
    let turnFailed = false;
    // P2 (QA-04-VERIFY2): declared outside try so the catch can also surface
    // errors thrown in step 1 (human bubble / checkpoint snapshot), when the
    // assistant bubble does not exist yet.
    let humanId = "";
    try {
      // 1. Optimistic human bubble (client id; server id reconciled later).
      humanId = this.bubbles.newClientBubbleId();
      this.bubbles.setBubbleData({
        bubbleId: humanId,
        role: "human",
        mode: turnMode,
        text: prompt,
        toolCalls: [],
        createdAt: Date.now(),
      });
      const checkpoint = await this.checkpoints.captureBefore(humanId, prompt);
      this.bubbles.updateBubble(humanId, { checkpointId: checkpoint.checkpointId });
      this.emitter.fire({ kind: "bubblesChanged", ids: [humanId] });

      // 2. Optimistic assistant bubble; the engine streams into it.
      assistantId = this.bubbles.newClientBubbleId();
      this.bubbles.setBubbleData({
        bubbleId: assistantId,
        role: "assistant",
        mode: turnMode,
        text: "",
        toolCalls: [],
        createdAt: Date.now(),
      });
      this.emitter.fire({ kind: "bubblesChanged", ids: [assistantId] });

      // 3. Apply engine events as fine-grained store updates.
      // P1 (QA-FILE-01): break out when the user hits Stop (abort()).
      // Cursor's writeRulesEntry()/onBeforeSubmitChat: project rules are merged
      // into the AGENT REQUEST, not into the displayed human bubble. Agent Chat
      // ONLY — this path is never used by Cmd+K or Tab (parity spec §A6).
      const rulesBlock = this.projectRules.buildInjection(prompt, turnMode);
      // GAPS-36D (rules-user): global User Rules. Merged into the AGENT
      // REQUEST after the project-rules block (docs precedence: Team Rules →
      // Project Rules → User Rules; team rules do not exist in this build).
      // Agent Chat ONLY — this path is never used by Cmd+K or Tab.
      const userRulesText = this.userRules.buildInjection();
      const userRulesBlock = userRulesText ? `\n\n${userRulesText}` : "";
      // DEV-HOOKS: hook stdout accumulated during the previous turn (post-tool
      // hooks, etc.) flows into the agent's context, like Cursor.
      // P2-5 (QA-CHATTABS-01): scoped drain — only this tab's hook output…
      const hookSvc = this.hookService;
      const hookCtx = [
        ...(hookSvc?.drainContextAdditions(this.hookScope) ?? []),
        // …plus unhomed output (workspace/session/tab hooks share the default
        // scope), which flowed into the next turn before scoping existed.
        // Only per-tab composer output is isolated; this preserves the old
        // behavior for everything else.
        ...(hookSvc?.drainContextAdditions() ?? []),
      ];
      const hookBlock = hookCtx.length > 0 ? `\n\n[Hook output]\n${hookCtx.join("\n")}` : "";
      // GAPS-11B (agent-git-branch-reminder): Cursor's pre-turn tracked
      // git-repo branch-change detection injects a <system_reminder> into the
      // turn's user content (binary-verified). Injected into the
      // engine-bound prompt only — never the displayed human bubble.
      const branchReminder = await this.checkBranchChangeReminder();
      const branchBlock = branchReminder ? `\n\n${branchReminder}` : "";
      const enginePrompt =
        rulesBlock.text || userRulesBlock || hookBlock || branchBlock
          ? `${prompt}\n\n${rulesBlock.text}${userRulesBlock}${hookBlock}${branchBlock}`
          : prompt;
      // DEV-DEBUG-MULTITASK: start the NDJSON ingest server for debug turns
      // (Cursor's cursor-ndjson-ingest equivalent). The config flows into
      // the debug system instruction so the agent knows where to POST
      // instrumentation logs. A failed start degrades gracefully — the
      // instruction then tells the agent to log to a workspace file instead.
      let debugConfig: DebugModeConfig | undefined;
      if (turnMode === "debug") {
        try {
          debugConfig = await this.debugServer().ensureStarted(`debug-${this.hookScope}`);
        } catch (err) {
          this.log?.(
            `[ide-agent] debug ingest server failed to start: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      // Plan mode: the agent researches and produces an editable checklist —
      // never implements. Mutating tools are additionally blocked at the
      // approval choke point (plan ∈ READ_ONLY_MODES).
      // Debug mode: the 6-step debug loop (hypotheses → instrumentation →
      // repro → analyze → targeted fix → cleanup) with the live ingest
      // config; shell/MCP ask for approval via the debug session ruleset.
      // Multitask mode: real orchestration (DEV-MULTITASK) — the extension
      // decomposes the request, creates one git worktree per subtask,
      // dispatches parallel engine worker sessions (capped at
      // MULTITASK_MAX_RUNNING), then runs a synthesis turn over the
      // workers' report-backs.
      const enginePromptWithModeWrappers =
        turnMode === "plan"
          ? wrapPlanPrompt(enginePrompt)
          : turnMode === "debug"
            ? wrapDebugPrompt(enginePrompt, debugConfig)
            : enginePrompt;
      // GAPS-46D (agent-custom-modes): a custom mode rides as an overlay on
      // ANY unified mode — the skill body is injected into the engine-bound
      // prompt on every turn until the user exits the mode.
      const finalPrompt = await this.applyCustomModeToTurn(enginePromptWithModeWrappers);
      if (turnMode === "multitask") {
        await this.runMultitaskTurn(enginePrompt, assistantId, humanId, attachments);
      } else {
        await this.streamEngineTurn(finalPrompt, turnMode, assistantId, humanId, attachments);
      }
      // Cursor parity: "after" checkpoint on generation end (skipped when the
      // user aborted the turn — there is no completed generation to capture).
      if (!this.abortRequested) {
        await this.checkpoints.captureAfter(humanId, `after: ${prompt}`);
      }
      if (this.abortRequested && assistantId) {
        const existing = this.bubbles.getBubbleData(assistantId);
        this.bubbles.updateBubble(assistantId, {
          text: (existing?.text ?? "") + "\n\n*Turn stopped by user.*",
        });
        this.emitter.fire({ kind: "bubblesChanged", ids: [assistantId] });
      }
    } catch (err) {
      turnFailed = true;
      // P1 (QA-04-VERIFY): a throw from applyEvent or the engine used to
      // become an unhandled rejection (via `void this.runTurn(text)` in
      // submit) — the turn stopped with no error shown to the user.
      const message = err instanceof Error ? err.message : String(err);
      if (assistantId) {
        const existing = this.bubbles.getBubbleData(assistantId);
        this.bubbles.updateBubble(assistantId, {
          text: (existing?.text ?? "") + `\n\n**Engine error:** ${message}`,
        });
        this.emitter.fire({ kind: "bubblesChanged", ids: [assistantId] });
      } else if (humanId) {
        // P2 (QA-04-VERIFY2): the throw happened in step 1 (human bubble
        // creation or checkpoint snapshot), before the assistant bubble
        // existed — surface it on the human bubble so the turn never dies
        // silently.
        const existing = this.bubbles.getBubbleData(humanId);
        this.bubbles.updateBubble(humanId, {
          text: (existing?.text ?? "") + `\n\n**Engine error:** ${message}`,
        });
        this.emitter.fire({ kind: "bubblesChanged", ids: [humanId] });
      } else {
        // Thrown before even the human bubble was created — fall back to a
        // host notification so the user still sees the failure.
        void vscode.window.showErrorMessage(`IDE Agent: turn failed: ${message}`);
      }
    } finally {
      this.running = false;
      // CONTINUE-INTERRUPTED-AGENTS: the turn settled — clear its in-flight
      // record so the next activation does not resume a finished turn. (On a
      // real reload/restart this finally never runs, which is exactly what
      // makes the surviving record mean "interrupted".)
      this.clearTurnInFlight();
      // GAPS-11B (agent-abort-restore-query): the turn settled — the stored
      // prompt must not leak into a later abort. (The Stop path's restore
      // already fired synchronously from abort() before the turn wound down.)
      // DEV-GAPS-56 (agent-resume-chat): an ABORTED turn is resumable — keep
      // its prompt for resumeChat() (Cursor's composer.resumeCurrentChat
      // continues a paused/ended chat). A cleanly settled turn is NOT
      // resumable: there is nothing left to continue.
      if (this.abortRequested && this.abortedTurnPrompt) {
        this.resumablePrompt = this.abortedTurnPrompt;
      }
      this.abortedTurnPrompt = undefined;
      // P2-1 (QA-CHATTABS-01): the drain window (see `drainDepth` field
      // comment). The loop awaits each follow-up turn instead of
      // fire-and-forget, so the window is fully covered; a submit landing
      // mid-drain is picked up by the next loop iteration instead of being
      // stranded or racing.
      this.drainDepth += 1;
      try {
        // P1 (QA-FILE-01): report turn end so the webview swaps Stop back to Send.
        // Fired before the queued drain so a follow-up turn re-reports running.
        this.emitter.fire({ kind: "turnState", running: false });
        // P2 (CX4b): approvals still pending here belong to the dead turn — the
        // engine only ends a turn when it is done, timed out, or aborted, so no
        // live card can be open at this point. Settle them as skip so they don't
        // leak into (and block) the next turn's serialized approval chain.
        this.reviews.settleAllPending();
        // SETTINGS-PARITY: post-turn hooks (chime/autosave) on clean completion.
        const cleanFinish = !this.abortRequested && !turnFailed;
        if (cleanFinish) {
          this.afterTurnCompleted();
        }
        // Plan mode: a clean plan-mode turn produces a pending plan — save it
        // to ~/.ide-code/plans/ (Cursor saves plans in the home dir by default)
        // and notify the webview's plan tray.
        if (cleanFinish && turnMode === "plan" && assistantId) {
          await this.capturePendingPlan(assistantId);
        }
        // DEV-HOOKS: stop hooks (Cursor parity). A deny blocks the stop — the
        // turn continues with the hook's followup_message, bounded by the
        // hooks' loop_limit. afterAgentResponse fires alongside (informational).
        await this.runStopHooks(assistantId);
        // SETTINGS-PARITY: Cursor "Send" — steered messages run first (FIFO),
        // then the regular queue drains. Loop while new work arrives during
        // teardown: each drained message runs as its own turn below.
        for (;;) {
          // Staged interrupt/steer (single slot, never queued): runs as its
          // own turn before the queue drains. The slot is cleared before the
          // turn starts so a submit landing mid-turn stages fresh.
          const interrupt = this.pendingInterruptSend;
          this.pendingInterruptSend = undefined;
          if (interrupt !== undefined) {
            await this.runTurn(interrupt.text, undefined, interrupt.attachments);
            continue;
          }
          const queued = this.queue.drain();
          if (queued.length === 0) {
            break;
          }
          // P3 (XQA-06): preserve the mode each message was queued with — a
          // mode switch between enqueue and drain must not silently misroute
          // messages. Group by mode and run each group as its own turn.
          await this.runQueuedTurns(queued);
        }
      } finally {
        this.drainDepth -= 1;
        this.currentTurnMode = undefined;
      }
    }
  }

  /**
   * DEV-MULTITASK: the normal engine event loop, extracted so the multitask
   * fallback and synthesis turns reuse the exact same streaming/abort/queue
   * semantics as every other turn (staged interrupt/steer break at engine-
   * event boundaries; the loop itself checks abortRequested).
   */
  private async streamEngineTurn(
    prompt: string,
    turnMode: ModeName,
    assistantId: string,
    humanId: string,
    attachments?: FileAttachment[],
  ): Promise<void> {
    for await (const event of this.engine.runTurn({
      prompt,
      mode: turnMode,
      bubbleId: assistantId,
      // DD-AR-3 (resume-from-checkpoint): the "before" checkpoint lives on
      // the human bubble — the adapter reads it for resumeAction.
      humanBubbleId: humanId,
      attachments,
    })) {
      if (this.abortRequested) {
        break;
      }
      this.applyEvent(event);
      // Staged interrupt/steer: deliver at the next opportune time — break
      // after the current engine event so the staged message runs as the
      // next turn (interrupts abort via abortRequested at the top of the
      // loop; steers just stop here without aborting).
      if (this.pendingInterruptSend !== undefined) {
        break;
      }
    }
  }

  /**
   * DEV-MULTITASK: real Multitask orchestration (spec §4 M2) — the
   * extension-side equivalent of Cursor's server-side fan-out.
   *
   *   decompose (silent worker turn) → one git worktree per subtask →
   *   parallel worker sessions (capped at MULTITASK_MAX_RUNNING) →
   *   workers report branch + summary → synthesis turn presents the
   *   combined result.
   *
   * Progress is posted to the assistant bubble via the existing bubble/event
   * plumbing (appendAssistantText). On `{ok:false}` the turn falls back to
   * the previous behavior (a normal turn wrapped in wrapMultitaskPrompt) —
   * orchestration is never faked.
   */
  private async runMultitaskTurn(
    enginePrompt: string,
    assistantId: string,
    humanId: string,
    attachments?: FileAttachment[],
  ): Promise<void> {
    // The worker surface lives on the real adapter only; the scripted stub
    // has no engine, so orchestration is impossible there — fall back to the
    // prompt-wrapped turn (honest, never fake).
    const engine = this.engine;
    if (!(engine instanceof IdeCodeEngineAdapter)) {
      this.appendAssistantText(
        assistantId,
        "\n\n*Multitask orchestration needs the real ide-code engine; falling back to a single-agent turn.*\n",
      );
      await this.streamEngineTurn(wrapMultitaskPrompt(enginePrompt), "multitask", assistantId, humanId, attachments);
      return;
    }
    const service = new MultitaskService(engine);
    this.appendAssistantText(assistantId, "*Multitask mode: orchestrating parallel subtasks…*\n");
    const result = await service.orchestrate(enginePrompt, {
      onProgress: (text) => this.appendAssistantText(assistantId, text),
      isAborted: () => this.abortRequested,
    });
    if (this.abortRequested) {
      return;
    }
    if (!result.ok) {
      // Orchestration could not start — fall back to the previous behavior.
      this.appendAssistantText(
        assistantId,
        `\n\n*Multitask orchestration could not start (${result.reason}); falling back to a single-agent turn.*\n`,
      );
      await this.streamEngineTurn(wrapMultitaskPrompt(enginePrompt), "multitask", assistantId, humanId, attachments);
      return;
    }
    // Synthesis: run a normal engine turn over the workers' report-backs so
    // the model presents the combined result (Cursor: the parent dispatches
    // subagents and each "reports branch + summary to parent").
    const synthesisPrompt = this.buildMultitaskSynthesisPrompt(enginePrompt, result.subtasks);
    await this.streamEngineTurn(synthesisPrompt, "multitask", assistantId, humanId, attachments);
  }

  /**
   * DEV-MULTITASK: synthesis-turn prompt — the workers' branch + summary +
   * files-changed report-backs, so the model presents the combined result.
   * Pure; unit-testable.
   */
  private buildMultitaskSynthesisPrompt(request: string, subtasks: SubtaskResult[]): string {
    const reports = subtasks
      .map((s, i) => {
        const files =
          s.filesChanged.length > 0
            ? s.filesChanged.map((f) => `  - ${f}`).join("\n")
            : "  (no files listed)";
        return [
          `### Worker ${i + 1}: ${s.title}`,
          `- Branch: \`${s.branch}\``,
          `- Worktree: \`${s.worktreePath}\``,
          `- Status: ${s.ok ? "succeeded" : `FAILED — ${s.error ?? "unknown error"}`}`,
          `- Summary: ${s.summary}`,
          `- Files changed:\n${files}`,
        ].join("\n");
      })
      .join("\n\n");
    return [
      "You are in Multitask Mode (synthesis step). The parallel workers have finished. Present the combined result to the user.",
      "",
      `Original request:\n${request}`,
      "",
      "Worker report-backs:",
      reports,
      "",
      "Rules:",
      "- Synthesize: resolve conflicts between workers, wire the pieces together, and describe the combined result.",
      "- List each worker's branch + worktree path so the user can review and merge them (worktrees are NOT auto-deleted).",
      "- If a worker failed, say what failed and suggest the next step — do not silently drop it.",
    ].join("\n");
  }

  /**
   * DEV-MULTITASK: append progress text to the assistant bubble using the
   * existing bubble/event plumbing (same pattern as the turn's error path).
   */
  private appendAssistantText(assistantId: string, text: string): void {
    const existing = this.bubbles.getBubbleData(assistantId);
    if (!existing) {
      return;
    }
    this.bubbles.updateBubble(assistantId, { text: (existing.text ?? "") + text });
    this.emitter.fire({ kind: "bubblesChanged", ids: [assistantId] });
  }

  /**
   * Run drained queue messages, preserving each message's queued mode.
   * Consecutive same-mode messages are joined into a single turn.
   */
  private async runQueuedTurns(queued: QueuedMessage[]): Promise<void> {
    const groups: { mode: ModeName; texts: string[]; attachments: FileAttachment[] }[] = [];
    for (const q of queued) {
      const match = MODES.find((m) => m.id === q.mode);
      const mode: ModeName = match ? match.id : this.modes.getMode();
      const last = groups[groups.length - 1];
      if (last && last.mode === mode) {
        last.texts.push(q.text);
        if (q.attachments) last.attachments.push(...q.attachments);
      } else {
        groups.push({ mode, texts: [q.text], attachments: q.attachments ? [...q.attachments] : [] });
      }
    }
    for (const g of groups) {
      await this.runTurn(g.texts.join("\n\n"), g.mode, g.attachments.length > 0 ? g.attachments : undefined);
    }
  }

  /**
   * DEV-HOOKS: `stop` + `afterAgentResponse` at turn end (Cursor parity).
   * A deny from a stop hook blocks the stop itself: the hook's
   * followup_message (last-wins) is queued as a follow-up turn, bounded by
   * the hooks' loop_limit (default 5, null = unlimited). Never throws —
   * hooks must not break turn teardown.
   */
  private async runStopHooks(assistantId: string): Promise<void> {
    const svc = this.hookService;
    if (!svc) {
      return;
    }
    try {
      const bubble = assistantId ? this.bubbles.getBubbleData(assistantId) : undefined;
      const lastResponse = (bubble?.text ?? "").slice(-2000);
      if (svc.hasHooks("afterAgentResponse")) {
        void svc
          .runHooks("afterAgentResponse", { response: lastResponse, mode: this.modes.getMode() }, this.hookScope)
          .catch(() => {});
      }
      if (!svc.hasHooks("stop")) {
        return;
      }
      const r = await svc.runHooks("stop", {
        stopKind: "Stop",
        lastResponse,
        aborted: this.abortRequested,
      }, this.hookScope);
      if (this.abortRequested) {
        return; // user stopped the turn — never auto-continue
      }
      const limit = svc.getLoopLimit("stop");
      for (const f of r.followupMessages) {
        if (this.stopChainDepth >= limit) {
          break;
        }
        this.stopChainDepth++;
        this.queue.enqueue(f, this.modes.getMode());
      }
    } catch {
      /* hooks must never break turn teardown */
    }
  }

  /**
   * DEV-HOOKS: post-tool hooks when a tool card reaches a terminal status
   * (Cursor parity): postToolUse/postToolUseFailure always, plus the
   * specialized afterShellExecution / afterFileEdit / afterMCPExecution /
   * subagentStop for the tool kind. Fire-and-forget; stdout flows into the
   * next turn's context via the service's pending buffer.
   */
  private firePostToolHooks(
    card: { kind?: string; title?: string; description?: string; outputPreview?: string },
    status: "done" | "failed",
  ): void {
    const svc = this.hookService;
    if (!svc) {
      return;
    }
    const kind = card.kind ?? "";
    const tool = KIND_TO_HOOK_TOOL[kind] ?? kind;
    const extras: Record<string, unknown> = {
      tool,
      kind,
      status,
      description: card.description ?? "",
      output: (card.outputPreview ?? "").slice(0, 2000),
    };
    void (async () => {
      try {
        await svc.runHooks(status === "failed" ? "postToolUseFailure" : "postToolUse", extras, this.hookScope);
        if (/shell/.test(kind)) {
          await svc.runHooks("afterShellExecution", extras, this.hookScope);
        } else if (/edit|diff/.test(kind)) {
          await svc.runHooks("afterFileEdit", extras, this.hookScope);
        } else if (/^mcp/i.test(kind) || (card.title ?? "").startsWith("MCP:")) {
          await svc.runHooks("afterMCPExecution", extras, this.hookScope);
        }
        if (tool === "task") {
          // The engine's task tool dispatches subagents — the real
          // subagentStop trigger in this extension.
          await svc.runHooks("subagentStop", extras, this.hookScope);
        }
      } catch {
        /* post hooks are informational — never break the UI */
      }
    })();
  }

  private applyEvent(event: TurnEvent): void {
    switch (event.type) {
      case "thinking": {
        this.bubbles.updateBubble(event.bubbleId, {
          thinking: { text: event.text, durationMs: event.durationMs, done: false },
        });
        // DEV-HOOKS: afterAgentThought (informational, fire-and-forget).
        const thoughtSvc = this.hookService;
        if (thoughtSvc?.hasHooks("afterAgentThought")) {
          void thoughtSvc
            .runHooks("afterAgentThought", { thought: event.text, bubbleId: event.bubbleId }, this.hookScope)
            .catch(() => {});
        }
        this.emitter.fire({ kind: "bubblesChanged", ids: [event.bubbleId] });
        break;
      }
      case "textDelta": {
        const bubble = this.bubbles.getBubbleData(event.bubbleId);
        if (bubble) {
          bubble.text += event.delta;
          if (bubble.thinking) {
            bubble.thinking.done = true;
          }
        }
        this.emitter.fire({ kind: "bubblesChanged", ids: [event.bubbleId] });
        break;
      }
      case "toolCall": {
        const bubble = this.bubbles.getBubbleData(event.bubbleId);
        if (bubble) {
          bubble.toolCalls.push(event.toolCall);
          // Re-index the toolCallId → bubbleId mapping.
          this.bubbles.setBubbleData(bubble);
        }
        // Checkpoint file tracking: the toolCall event arrives while the
        // tool is still pending — before the edit runs — so noteToolCall can
        // snapshot the pre-edit file state (Cursor parity).
        void this.checkpoints.noteToolCall(event.toolCall);
        // Doc-gap A12: clarifying question — track it and surface the
        // clickable question widget in the webview.
        if (event.toolCall.question) {
          const q = event.toolCall.question;
          // P3-2 (QA-CHATTABS-01): remember which mode's turn asked, so an
          // answer submitted while idle steers with the asking turn's mode,
          // not the live UI mode the user may have switched to meanwhile.
          q.mode = this.currentTurnMode ?? this.modes.getMode();
          // P2-4 rework (QA-CHATTABS Round B): the approval-card link is NOT
          // wired here. The engine publishes Tool.Called BEFORE the tool's
          // execute fiber runs, and the question tool only raises its
          // approval card inside execute (permission.assert) — so no card
          // can exist yet at this point (the old wiring that grabbed
          // reviews.currentApproval here was dead code in production, and
          // could link the WRONG card with two questions pending). The
          // adapter emits a `questionApproval` event when it actually
          // creates the card; that handler sets q.approvalToolCallId.
          // P3-3 (QA-CHATTABS-01): surface the widget only for a NEW
          // question — a re-emitted/reconciled tool call must not render a
          // duplicate card. (Map.set is idempotent; the event is not.)
          if (!this.pendingQuestions.has(q.questionId)) {
            this.pendingQuestions.set(q.questionId, q);
            // DEV-GAPS-19 (subagent-async-ask-settle): log the async
            // ask-question step in the turn-builder step log, so a later
            // (async) answer settles into the right step via the backwards
            // scan — one step per real ask, not per re-emitted tool call.
            this.askQuestionSteps.recordStep({
              kind: "ask-question",
              questionId: q.questionId,
              toolCallId: q.toolCallId,
              bubbleId: event.bubbleId,
            });
            this.emitter.fire({ kind: "questionAsked", question: q });
          }
        }
        this.emitter.fire({ kind: "bubblesChanged", ids: [event.bubbleId] });
        break;
      }
      case "toolCallDelta": {
        const bubbleId = this.bubbles.getBubbleIdByToolCallId(event.toolCallId);
        if (bubbleId) {
          const bubble = this.bubbles.getBubbleData(bubbleId);
          const card = bubble?.toolCalls.find((t) => t.toolCallId === event.toolCallId);
          if (card) {
            // P2 (QA-FILE-04): never let a delta rewrite the card's identity.
            // toolCallId is the index key for toolCallToBubble — one bad event
            // would desync the card from the index, misrouting later deltas.
            const safeDelta = { ...event.delta };
            delete safeDelta.toolCallId;
            Object.assign(card, safeDelta);
            // DEV-HOOKS: post-tool hooks when the card reaches a terminal status.
            const terminalStatus = (event.delta as { status?: string }).status;
            if (terminalStatus === "done" || terminalStatus === "failed") {
              this.firePostToolHooks(card, terminalStatus);
            }
          }
          this.emitter.fire({ kind: "bubblesChanged", ids: [bubbleId] });
        }
        break;
      }
      case "reconcile": {
        this.bubbles.reconcileServerId(event.clientBubbleId, event.serverBubbleId);
        this.emitter.fire({ kind: "bubblesChanged", ids: [event.clientBubbleId] });
        break;
      }
      // DD-AR-9 (turnSettled protocol): record how the turn ended on the
      // bubble instead of inferring it; the webview can render the outcome.
      case "turnSettled": {
        const bubble = this.bubbles.getBubbleData(event.bubbleId);
        if (bubble) {
          bubble.turnOutcome = event.outcome;
          this.bubbles.setBubbleData(bubble);
        }
        this.emitter.fire({ kind: "turnSettled", bubbleId: event.bubbleId, settled: event });
        // Context ring: every settled turn pushes a fresh real-data breakdown
        // so the tray is live, never stale.
        this.emitContextUsage(true);
        break;
      }
      case "questionApproval": {
        // P2-4 rework (QA-CHATTABS Round B): the adapter created an approval
        // card for a question tool call — record the card's toolCallId on the
        // pending question so answering the widget resolves the card as
        // approve-once (no 5-minute hang). The link is exact: the adapter
        // keys it by the permission request's source.id, which IS the
        // question's toolCallId.
        for (const q of this.pendingQuestions.values()) {
          if (q.toolCallId === event.toolCallId && !q.approvalToolCallId) {
            q.approvalToolCallId = event.approvalToolCallId;
            break;
          }
        }
        break;
      }
      case "done": {
        break;
      }
    }
  }

  /**
   * Start a fresh chat (P1 CX1b — previously a scaffold that only focused
   * the view and toasted).
   *
   * Refuses while a turn is running: clearing mid-turn would orphan the
   * engine stream, pending approval cards and the queued follow-up turns.
   * The user must stop the turn first.
   *
   * On success clears, in order:
   *  1. bubbles — store cleared, webview re-rendered empty via bubblesReset
   *  2. checkpoints — retention = chat lifetime, a new chat drops them
   *  3. message queue — queued prompts belonged to the old conversation
   *  4. composer state (chips, input draft, open menus, ctx usage) — the
   *     webview resets itself on the `newChat` event
   *
   * Returns true when the chat was reset (the caller should then focus the
   * view), false when refused because a turn is running.
   */
  async newChat(): Promise<boolean> {
    // P2-6 (QA-CHATTABS-01): same guard as closeTab — clearing mid-drain
    // would orphan the drain's follow-up turns (ghost turns on cleared state).
    if (this.running || this.isDraining) {
      void vscode.window.showWarningMessage(
        "IDE Agent: a turn is still running — stop it before starting a new chat.",
      );
      return false;
    }
    // 1. Bubbles.
    this.bubbles.clear();
    this.emitter.fire({ kind: "bubblesReset" });
    // 2. Checkpoints (disk + memory).
    await this.checkpoints.clearComposerCheckpoints();
    // 3. Queued messages — drain() fires onDidChangeQueue when non-empty,
    // which the queueChanged relay turns into a webview chip update.
    this.queue.drain();
    // 3b. P2-3 (QA-CHATTABS-01): a stale clarifying question must not survive
    // into the new conversation — answering it would steer a dead answer
    // into the fresh chat. Same for steered messages queued for the old turn.
    // (The webview resets its widgets on the `newChat` event below.)
    this.pendingQuestions.clear();
    this.askQuestionSteps.clear();
    this.pendingInterruptSend = undefined;
    // Context ring: a fresh chat restarts the window — drop the observed
    // transcript + adopted summaries BEFORE firing newChat, so the forced
    // contextUsage emit pushes true reset figures (not the cleared chat's
    // stale history over the webview's own reset).
    const engine = this.engine;
    if (engine instanceof IdeCodeEngineAdapter) {
      engine.resetConversationTracking();
    }
    // 4. Webview-local composer state.
    this.emitter.fire({ kind: "newChat" });
    // 5. Plan mode (Cursor parity, parity-chat-modes §3.6): a new chat starts
    // in the default mode (agent) and drops any pending plan.
    this.clearPendingPlan();
    // GAPS-46D (agent-custom-modes): the binary clears active/pending/
    // committed custom modes on draft change — a new chat drops the mode.
    if (this.activeCustomMode || this.committedCustomMode) {
      this.activeCustomMode = null;
      this.committedCustomMode = null;
      this.pendingExitedCustomMode = null;
      this.emitter.fire({ kind: "customModeChanged", active: null, exitedLabel: null });
    }
    this.modes.reset();
    return true;
  }

  /**
   * GAPS-186: the execution data of the last core-accepted plan on this
   * tab (planName/planTitle/planTodos from the core `_loadPlanExecutionData`
   * port), or null when no plan was accepted through the core path.
   */
  getLastAcceptedPlanExecution(): AcceptedPlanExecution | null {
    return this.lastAcceptedPlanExecution;
  }

  /** The plan awaiting user review, if a plan-mode turn produced one. */
  getPendingPlan(): PendingPlan | null {
    return this.pendingPlan;
  }

  private clearPendingPlan(): void {
    if (this.pendingPlan) {
      this.pendingPlan = null;
      this.emitter.fire({ kind: "planCleared" });
    }
    // W71B (DEV-GAPS-71): keep the core plan registry in sync — a discarded
    // plan (or a fresh chat) must not stay resolvable via
    // `getPlanUriFromBubble`, or `composer.acceptPlan` would accept a plan
    // the user already dropped. Best-effort: never break the local flow.
    const tabId = this.tabId;
    if (tabId) {
      try {
        void vscode.commands
          .executeCommand("ide.clearComposerPlan", tabId)
          .then(undefined, () => {});
      } catch {
        // vscode API unavailable (unit tests) — the local pendingPlan clear
        // above is what matters there.
      }
    }
  }

  /**
   * Capture the assistant's response of a completed plan-mode turn as a
   * pending plan: persist it to ~/.ide-code/plans/ and fire `planReady`.
   * A turn that produced no text (aborted/errored/empty) yields no plan.
   */
  private async capturePendingPlan(assistantBubbleId: string): Promise<void> {
    const bubble = this.bubbles.getBubbleData(assistantBubbleId);
    const text = bubble?.text?.trim() ?? "";
    if (!text) {
      return;
    }
    const savedPath = await savePlanFile(text);
    this.pendingPlan = { bubbleId: assistantBubbleId, text, savedPath, createdAt: Date.now() };
    // W71B (DEV-GAPS-71): bridge the live plan into the core plan service —
    // this is what makes the `composer.acceptPlan` command path
    // (`getPlanUriFromBubble` -> `acceptPlan`) resolve the plan. Skipped when
    // the plan file could not be persisted (nothing for core to resolve) or
    // when no tab id is set (unit tests). Best-effort: a bridge failure must
    // never break plan capture.
    const tabId = this.tabId;
    if (tabId && savedPath) {
      try {
        void vscode.commands
          .executeCommand(
            "ide.recordComposerPlan",
            tabId,
            assistantBubbleId,
            vscode.Uri.file(savedPath).toString(),
            text,
          )
          .then(undefined, () => {});
      } catch {
        // vscode API unavailable (unit tests).
      }
    }
    this.emitter.fire({ kind: "planReady", plan: this.pendingPlan });
  }

  /** Discard the pending plan without implementing it. */
  discardPlan(): void {
    this.clearPendingPlan();
  }

  // -----------------------------------------------------------------------
  // Custom modes (GAPS-46D — agent-custom-modes).
  // -----------------------------------------------------------------------

  /** The currently active custom-mode session, if any. */
  getActiveCustomMode(): CustomModeSession | null {
    return this.activeCustomMode;
  }

  /** The label of the mode most recently exited, if any. */
  getPendingExitedCustomMode(): { label: string } | null {
    return this.pendingExitedCustomMode;
  }

  /**
   * Enter a custom mode from a skill (Alt+Enter / "Use as Mode" on a `/`
   * menu skill entry). Requires a valid frontmatter block with a name
   * (docs: "Any skill with a valid frontmatter block can back a mode").
   * Replaces any currently active mode; no-op with a notice when the skill
   * has no name.
   */
  enterCustomMode(skill: CustomModeSkillSource): void {
    const session = createCustomModeSession(skill);
    if (!session) {
      void vscode.window.showWarningMessage(
        "IDE Agent: that skill has no name in its frontmatter, so it can't back a custom mode.",
      );
      return;
    }
    this.activeCustomMode = session;
    this.committedCustomMode = null;
    this.pendingExitedCustomMode = null;
    this.log?.(`[ide-agent] entered custom mode '${session.label}' (session ${session.sessionId})`);
    this.emitter.fire({ kind: "customModeChanged", active: this.activeCustomMode, exitedLabel: null });
  }

  /**
   * Exit the active custom mode. The mode stops being injected on the next
   * turn; `pendingExitedCustomMode` records the label (binary parity).
   */
  exitCustomMode(): void {
    if (!this.activeCustomMode && !this.committedCustomMode) {
      return;
    }
    const label = this.activeCustomMode?.label ?? this.committedCustomMode?.label ?? "";
    this.activeCustomMode = null;
    this.committedCustomMode = null;
    this.pendingExitedCustomMode = label ? { label } : null;
    this.log?.(`[ide-agent] exited custom mode '${label}'`);
    this.emitter.fire({
      kind: "customModeChanged",
      active: null,
      exitedLabel: this.pendingExitedCustomMode?.label ?? null,
    });
  }

  /**
   * Per-turn custom-mode preflight, run from runTurn before the prompt is
   * finalized. When a mode is active:
   *  - the skill file must still exist — if it was renamed/removed, the
   *    binary shows `'${label}' mode couldn't be applied — its skill file
   *    may have been renamed or removed. Message sent without it.` and the
   *    turn is sent WITHOUT the mode;
   *  - otherwise the session is committed for this turn, `turnsInMode` is
   *    incremented, and the skill body is injected into the engine-bound
   *    prompt (docs: "the skill stays in context on every turn").
   * Returns the engine-bound prompt (possibly wrapped).
   */
  private async applyCustomModeToTurn(enginePrompt: string): Promise<string> {
    const session = this.activeCustomMode;
    if (!session) {
      return enginePrompt;
    }
    let exists = false;
    try {
      await fs.stat(session.skillFilePath);
      exists = true;
    } catch {
      exists = false;
    }
    const plan = planCustomModeTurn(session, exists);
    if (plan.dropped) {
      // Binary behavior: notify, drop the mode, send the message without it.
      void vscode.window.showInformationMessage(buildSkillMissingNotification(session.label));
      this.exitCustomMode();
      return enginePrompt;
    }
    this.committedCustomMode = { ...session };
    this.activeCustomMode = incrementCustomModeTurns(session);
    return wrapCustomModePrompt(session, enginePrompt);
  }

  /**
   * Accept the pending plan and start the build phase (Cursor's "Accept Plan"
   * / click-to-build). Switches to agent mode and submits the approved plan
   * as an implementation request. No-op (with a notice) when there is no
   * pending plan.
   */
  async acceptPlan(): Promise<void> {
    const plan = this.pendingPlan;
    if (!plan) {
      void vscode.window.showInformationMessage("IDE Agent: no pending plan to accept.");
      return;
    }
    // P2 (QA-PLANMODE-01): reentrancy guard — a second "Accept Plan & Build"
    // click during the resolve await must not submit a second build turn.
    if (this.acceptingPlan) {
      return;
    }
    this.acceptingPlan = true;
    try {
      // Cursor parity (agent.execute_plan.*): the persisted plan file is the
      // source of truth for the build phase. Resolve it — recreating from the
      // in-memory text when the file is missing — before implementing.
      const resolvedPath = await this.resolvePlanFile(plan);
      if (!resolvedPath) {
        return;
      }
      this.clearPendingPlan();
      this.modes.setMode("agent");
      // P2 (QA-PLANMODE-01): build from the RESOLVED FILE content, not the
      // in-memory text — the user may have edited the plan file on disk
      // after it was generated. Fall back to plan.text only if the read fails.
      let buildText = plan.text;
      try {
        const fileContent = await fs.readFile(resolvedPath, "utf-8");
        // savePlanFile writes a "# Plan — <ISO>" header; strip it so the
        // build prompt carries just the plan body.
        buildText = fileContent.replace(/^# Plan — .*\n\n/, "").trim() || plan.text;
      } catch {
        // fall back to the in-memory text
      }
      this.submit(
        `Implement the following approved plan. Follow the steps in order.\n\n---\n\n${buildText}`,
      );
    } finally {
      this.acceptingPlan = false;
    }
  }

  /**
   * GAPS-181 (CAT-B port, acceptPlan consumer C2 — the W71B-F1 follow-up):
   * build phase for a plan accepted through the CORE plan service — the
   * `composer.acceptPlan` command path (`composerPlanService.acceptPlan`,
   * Cursor 3.25.9 @18684727), whose `onDidAcceptPlan` event the core
   * `ComposerPlanAcceptConsumerContribution` forwards here via the
   * `ide.acceptPlanFromCore` command. Core already resolved the plan text
   * from the plan file (the file is the source of truth there too) and
   * cleared the core registry record, so this entry point must NOT
   * re-resolve the file or depend on `pendingPlan` still being set: it
   * drops the local pending plan (which also fires `planCleared` and
   * re-clears the — already empty — core registry, a harmless no-op),
   * switches to agent mode and submits the same build prompt shape as
   * `acceptPlan()`. The "# Plan — <ISO>" header `savePlanFile` writes is
   * stripped exactly like `acceptPlan()` strips it after reading the file
   * (core forwards the raw disk content). Shares the reentrancy guard: a
   * core accept racing a local "Accept Plan & Build" click builds once.
   * Empty/blank text (no plan content) submits nothing.
   *
   * GAPS-186: the optional `execution` arg is the core plan service's
   * `_loadPlanExecutionData` extraction (planName/planTitle/planTodos)
   * for this plan. It is normalized defensively (the arg crosses the
   * command boundary untyped; an older core build may not send it) and
   * retained on the composer (`getLastAcceptedPlanExecution`) at the
   * moment the build starts — only when a build actually starts: a
   * dropped (empty text) or reentrancy-blocked call records nothing,
   * mirroring the analytics rule that a non-accept emits nothing. The
   * `composer.plan_mode.plan_accepted` analytics event itself is tracked
   * by the CORE plan service (the binary tracks it inside
   * `composerPlanService.acceptPlan`, and the fork's extension host has
   * no telemetry backend — see the planFileTelemetry divergence), so
   * this entry point deliberately does NOT track it again.
   */
  async acceptPlanFromCore(planText: string, execution?: unknown): Promise<void> {
    const text =
      typeof planText === "string"
        ? planText.replace(/^# Plan — .*\n\n/, "").trim()
        : "";
    if (!text) {
      return;
    }
    if (this.acceptingPlan) {
      return;
    }
    this.acceptingPlan = true;
    try {
      this.clearPendingPlan();
      this.lastAcceptedPlanExecution = normalizeAcceptedPlanExecution(execution);
      this.modes.setMode("agent");
      this.submit(
        `Implement the following approved plan. Follow the steps in order.\n\n---\n\n${text}`,
      );
    } finally {
      this.acceptingPlan = false;
    }
  }

  /**
   * Resolve the persisted plan file via planFileService.resolvePlanFilePath
   * (Cursor's agent.execute_plan.* semantics, DIG-AST-EXT 2026-10-19):
   * explicit path → workspace .ide-code/plans/ → global ~/.ide-code/plans/
   * → recreate from the in-memory plan text → telemetry failure (no build).
   * Never throws; never loses the in-memory plan. Telemetry is recorded in
   * this.planFileTelemetry (see getPlanFileTelemetry) — our own event names,
   * not Cursor's (HONEST DIVERGENCE).
   */
  private async resolvePlanFile(plan: PendingPlan): Promise<string | null> {
    const output = vscode.window.createOutputChannel("IDE Agent");
    const usable = async (p: string): Promise<boolean> => {
      try {
        const content = await fs.readFile(p, "utf-8");
        // A zero-byte file is "corrupt" — treat like missing and recreate.
        return content.trim().length > 0;
      } catch {
        return false;
      }
    };
    const outcome = await resolvePlanFilePath(
      { savedPath: plan.savedPath, text: plan.text },
      {
        fileUsable: usable,
        homedir: os.homedir,
        workspaceRoots: () => (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
        recreate: (text) => savePlanFile(text),
        emit: (event, source, reason) => {
          this.planFileTelemetry.push({ event, source, reason, at: Date.now() });
          output.appendLine(
            `[ide-agent] ${event} source=${source}${reason ? ` reason=${reason}` : ""}`,
          );
        },
      },
    );
    if (outcome.path) {
      plan.savedPath = outcome.path;
      return outcome.path;
    }
    void vscode.window.showErrorMessage(
      "IDE Agent: could not resolve the plan file for the accepted plan — nothing was implemented.",
    );
    return null;
  }

  /** In-memory log of plan-file resolve/recreate/failure telemetry events. */
  getPlanFileTelemetry(): ReadonlyArray<{
    event: PlanFileTelemetryEvent;
    source: PlanFileResolveSource;
    reason?: string;
    at: number;
  }> {
    return this.planFileTelemetry;
  }

  /**
   * Remove one queued message (queue list UI).
   */
  queueRemove(id: string): boolean {
    return this.queue.remove(id);
  }

  /**
   * Reorder the queue: move one message up (-1) or down (+1).
   */
  queueMove(id: string, direction: -1 | 1): boolean {
    return this.queue.move(id, direction);
  }

  /**
   * "Send now" for one queued message (Cursor's follow-up steering): pull it
   * out of the queue and deliver it at the next opportune time without
   * interrupting the running turn. No-op when no turn is running (the
   * message just runs next).
   */
  queueSendNow(id: string): boolean {
    const item = this.queue.getItems().find((m) => m.id === id);
    if (!item) {
      return false;
    }
    this.queue.remove(id);
    if (this.running || this.isDraining) {
      // Steer: delivered at the next opportune time without interrupting the
      // running turn.
      this.stageInterruptSend({ text: item.text, attachments: item.attachments }, { interrupt: false });
    } else {
      void this.runTurn(item.text, undefined, item.attachments);
    }
    return true;
  }

  /**
   * Doc-gap A12: answer the agent's clarifying question (single-select).
   * Exactly-once: the question is removed on the first valid answer.
   */
  answerQuestion(questionId: string, optionId: string): boolean {
    return this.answerQuestionWithOptions(questionId, [optionId]);
  }

  /**
   * P2 (QA-CHATTABS-X2): multi-select clarifying questions. The webview lets
   * the user toggle several options and submit them together ("Done") — the
   * question is only removed after the COMBINED answer is steered, so a
   * multi-option question is never silently downgraded to a partial single
   * answer.
   */
  answerQuestionMulti(questionId: string, optionIds: string[]): boolean {
    return this.answerQuestionWithOptions(questionId, optionIds);
  }

  private answerQuestionWithOptions(questionId: string, optionIds: string[]): boolean {
    const question = this.pendingQuestions.get(questionId);
    if (!question || optionIds.length === 0) {
      return false;
    }
    const picked = optionIds.map((id) => question.options.find((o) => o.id === id));
    if (picked.some((o) => !o)) {
      return false;
    }
    this.pendingQuestions.delete(questionId);
    // P2-4 rework (QA-CHATTABS Round B): answering the widget resolves the
    // question's approval card as approve-once (linked via the
    // questionApproval event) instead of letting it hang to the 5-minute
    // timeout. Resolved by the card's toolCallId — the reviews service's
    // internal approval-N ids are never exposed to the turn events.
    if (question.approvalToolCallId) {
      this.reviews.resolveApprovalForToolCall(question.approvalToolCallId, { optionId: "approve-once" });
    }
    const labels = (picked as { label: string; description?: string }[])
      .map((o) => `${o.label}${o.description ? ` — ${o.description}` : ""}`)
      .join("; ");
    const answerText =
      `User answered your question "${question.question}"` +
      `${picked.length > 1 ? ` (selected ${picked.length} options)` : ""}: ` +
      `${labels}. ` +
      `Continue with this answer in mind.`;
    // DEV-GAPS-19 (subagent-async-ask-settle): Cursor's `settleAsyncAskQuestionSteps`
    // — backwards scan with a `stepReads` budget — records the answer into the
    // right (newest unsettled) ask-question step. Applies on both the steer
    // and run-as-own-turn paths below; unsettled steps stay pending, so no
    // pending question is ever lost by settling.
    this.askQuestionSteps.settleAsyncAskQuestionSteps(new Map([[questionId, answerText]]));
    if (this.running || this.isDraining) {
      // Steer: delivered at the next opportune time (next engine-event
      // boundary), then run as its own turn.
      this.stageInterruptSend({ text: answerText }, { interrupt: false });
    } else {
      // P3-2 (QA-CHATTABS-01): an idle answer steers with the ASKING turn's
      // mode, not the live UI mode the user may have switched to meanwhile.
      void this.runTurn(answerText, question.mode ?? this.modes.getMode());
    }
    this.emitter.fire({ kind: "questionAnswered", questionId });
    return true;
  }

  /**
   * Restore = checkout_to_message (Cursor parity, PRODUCT DECISION 2026-10-19:
   * files-only — restoring reverts workspace files and deletes files/folders
   * created after the checkpoint, but does NOT rewind the conversation
   * transcript; cursor.com/docs/agent: "Restoring a checkpoint reverts files
   * only; it does not remove messages from the conversation.").
   *
   * A confirmation dialog ("Discard all changes up to this checkpoint?", Cursor
   * parity — verbatim strings, binary-verified) is shown before the restore
   * executes, with a don't-ask-again opt-out. If the user cancels/dismisses
   * it, the restore is a no-op: no files change, no event fires.
   *
   * Refuses while a turn is running
   * (P1 QA-FILE-04): in-flight applyEvent calls would hit truncated bubbles
   * and silently drop the turn's output.
   */
  async revertToCheckpoint(bubbleId: string): Promise<string[]> {
    // P4/low (QA-CHATTABS Round B, R4): guard isDraining like closeTab and
    // newChat do — restoring files mid-drain would corrupt the follow-up
    // turns the drain loop is about to run.
    if (this.running || this.isDraining) {
      void vscode.window.showWarningMessage(
        "IDE Agent: cannot restore a checkpoint while a turn is running — wait for the turn to finish first.",
      );
      return [];
    }
    const checkpoint = this.checkpoints.getByBubble(bubbleId);
    if (!checkpoint) {
      void vscode.window.showWarningMessage(
        "IDE Agent: no checkpoint found for that message.",
      );
      return [];
    }
    // Files-only restore (product decision 2026-10-19): writes back
    // snapshots, deletes created files — the transcript is left intact.
    const restored = await this.checkpoints.checkoutToCheckpoint(bubbleId);
    if (restored.cancelled) {
      // User declined/dismissed the restore confirmation dialog — the
      // restore was aborted and nothing was reverted. Treat as a no-op: do
      // NOT latch restoredFromBubbleId or fire checkpointRestored.
      return [];
    }
    if (restored.isSame) {
      void vscode.window.showInformationMessage(
        "IDE Agent: already at this checkpoint — nothing to restore.",
      );
      return [];
    }
    this.latchedRestoredFromBubbleId = bubbleId;
    this.emitter.fire({ kind: "checkpointRestored", bubbleId });
    const parts: string[] = [];
    if (restored.reverted.length > 0) {
      parts.push(`${restored.reverted.length} file(s) reverted`);
    }
    if (restored.deleted.length > 0) {
      parts.push(`${restored.deleted.length} created file(s) deleted`);
    }
    void vscode.window.showInformationMessage(
      `IDE Agent: restored checkpoint` +
        (parts.length > 0 ? ` — ${parts.join(", ")}` : " — files already match") +
        ".",
    );
    // P3-1 (QA-CHATTABS-01): return what was actually restored — the
    // signature promises string[] and callers (and future UI) need it.
    return [...restored.reverted, ...restored.deleted];
  }

  /**
   * Edit-resubmit: the user edited a sent (human) message and wants to
   * resubmit it (Cursor parity — forum.cursor.com staff, 2026-03-23).
   *
   * A modal dialog offers "Continue and revert" (files-only restore of the
   * message's checkpoint, via ChatResubmitService) or "Continue without
   * reverting" (keep current files). BOTH options truncate every message
   * after the edited one — truncation always happens on resubmit. Cancel
   * does nothing.
   *
   * The edited bubble itself is dropped along with the later messages and
   * the new text is submitted as a fresh turn (runTurn creates the new
   * human bubble + assistant bubble), so the edited message never appears
   * twice in the transcript.
   *
   * Refuses while a turn is running (P1 QA-FILE-04: in-flight applyEvent
   * calls would hit truncated bubbles and silently drop the turn's output).
   */
  async resubmitEditedMessage(bubbleId: string, newText: string): Promise<boolean> {
    // Same busy guard as revertToCheckpoint — resubmitting mid-turn would
    // corrupt the in-flight turn's bubbles.
    if (this.running || this.isDraining) {
      void vscode.window.showWarningMessage(
        "IDE Agent: cannot edit and resubmit while a turn is running — wait for the turn to finish first.",
      );
      return false;
    }
    const bubble = this.bubbles.getBubbleData(bubbleId);
    if (!bubble || bubble.role !== "human") {
      void vscode.window.showWarningMessage(
        "IDE Agent: only a sent message can be edited and resubmitted.",
      );
      return false;
    }
    if (!newText.trim()) {
      void vscode.window.showWarningMessage(
        "IDE Agent: the edited message is empty — nothing to resubmit.",
      );
      return false;
    }
    return new ChatResubmitService().handleResubmit(bubbleId, newText.trim(), {
      // Files-only restore; the resubmit dialog is the confirmation, so the
      // checkpoint dialog is skipped (Cursor: `fromSubmitChat` skips it).
      restoreCheckpoint: async (id: string) => {
        await this.checkpoints.checkoutToCheckpoint(id, { skipConfirm: true });
      },
      truncateFrom: (id: string): string[] => {
        // Drop the edited bubble itself plus everything after it: the new
        // turn re-creates the human bubble with the edited text.
        const ids = this.bubbles.getOrderedIds();
        const idx = ids.indexOf(id);
        let removed: string[];
        if (idx < 0) {
          removed = [];
        } else if (idx === 0) {
          removed = [...ids];
          this.bubbles.clear();
        } else {
          removed = this.bubbles.truncateAfter(ids[idx - 1]);
        }
        if (removed.length > 0) {
          // Drop checkpoint records for bubbles that no longer exist so a
          // later restore can't resurrect the truncated timeline.
          this.checkpoints.prune(new Set(this.bubbles.getOrderedIds()));
          // Full transcript resync — the provider re-posts getAllInOrder().
          this.emitter.fire({ kind: "bubblesReset" });
        }
        return removed;
      },
      resubmit: (text: string) => {
        void this.runTurn(text, this.modes.getMode());
      },
    });
  }

  /** Bubble the last restore targeted (drives the webview "checked out" chip). */
  get restoredFromBubbleId(): string | undefined {
    return this.latchedRestoredFromBubbleId;
  }
  private latchedRestoredFromBubbleId?: string;

  /**
   * Undo the last restore: re-apply the "latest" snapshot captured at
   * restore time — the exact pre-restore workspace state, including user
   * edits made after generation end (mirrors Cursor's checkoutToLatest;
   * DEV-GAPS-66/W66B).
   */
  async undoRestore(): Promise<void> {
    // P4/low (QA-CHATTABS Round B, R4): same guard as revertToCheckpoint —
    // re-applying files mid-drain corrupts the follow-up turns.
    if (this.running || this.isDraining) {
      void vscode.window.showWarningMessage(
        "IDE Agent: cannot undo a restore while a turn is running.",
      );
      return;
    }
    const restored = await this.checkpoints.checkoutToLatest();
    this.latchedRestoredFromBubbleId = undefined;
    if (restored.reverted.length > 0) {
      void vscode.window.showInformationMessage(
        `IDE Agent: undone restore — ${restored.reverted.length} file(s) re-applied.`,
      );
    } else {
      void vscode.window.showInformationMessage("IDE Agent: nothing to undo.");
    }
  }

  // ---- terminal integration (TerminalService) ------------------------------

  /**
   * Post a background terminal command run as chat bubbles: a human bubble
   * with the command and an empty assistant bubble that streams the output.
   * Returns the assistant bubble id for updateTerminalOutput/finishTerminalRun.
   */
  postTerminalRun(command: string): string {
    const humanId = this.bubbles.newClientBubbleId();
    this.bubbles.setBubbleData({
      bubbleId: humanId,
      role: "human",
      mode: this.modes.getMode(),
      text: `$ ${command}`,
      toolCalls: [],
      createdAt: Date.now(),
    });
    const assistantId = this.bubbles.newClientBubbleId();
    this.bubbles.setBubbleData({
      bubbleId: assistantId,
      role: "assistant",
      mode: this.modes.getMode(),
      text: "_Running…_",
      toolCalls: [],
      createdAt: Date.now(),
    });
    this.emitter.fire({ kind: "bubblesChanged", ids: [humanId, assistantId] });
    return assistantId;
  }

  /** Replace the streaming output text of a terminal-run bubble. */
  updateTerminalOutput(bubbleId: string, output: string): void {
    // Curation restored (user directive 2026-10-19 refined): the chat bubble
    // shows a focused 60k-char window of terminal output so the transcript
    // fed back to the model stays sharp.
    const capped =
      output.length > 60000
        ? output.slice(0, 60000) + "\n…(output truncated)"
        : output;
    this.bubbles.updateBubble(bubbleId, { text: capped || "_Running…_" });
    this.emitter.fire({ kind: "bubblesChanged", ids: [bubbleId] });
  }

  /** Finish a terminal run: append the exit-code / timeout / cancel status line. */
  finishTerminalRun(
    bubbleId: string,
    exitCode: number,
    elapsedMs: number,
    timedOut: boolean,
    /**
     * GAPS-14 (agent-shell-approval-keyboard-flow): user-cancelled via
     * `composer.cancelTerminalToolCall` (Shift+Backspace) — rendered as
     * "cancelled by user", not as a timeout.
     */
    cancelled: boolean = false,
  ): void {
    const existing = this.bubbles.getBubbleData(bubbleId);
    const base =
      existing?.text && existing.text !== "_Running…_"
        ? existing.text
        : "(no output)";
    const status = cancelled
      ? `cancelled by user after ${Math.round(elapsedMs / 1000)}s (sent Ctrl+C)`
      : timedOut
        ? `timed out after ${Math.round(elapsedMs / 1000)}s (sent Ctrl+C)`
        : `exit code ${exitCode} in ${(elapsedMs / 1000).toFixed(1)}s`;
    this.bubbles.updateBubble(bubbleId, { text: `${base}\n\n— ${status}` });
    this.emitter.fire({ kind: "bubblesChanged", ids: [bubbleId] });
  }
}
