/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Migrated from extensions/ide-agent/src/services/composerDataService.ts (CAT-B, vscode→DI)
//
// vscode API → core mapping used here (per docs/rea/ext-api-audit-2026-10-19.md §3):
//   vscode.EventEmitter                        → Emitter (vs/base/common/event)
//   vscode.ExtensionContext                    → DROPPED (same precedent as chatTabService):
//       context.subscriptions → this._register (extends Disposable)
//       context.workspaceState → IStorageService (StorageScope.WORKSPACE, JSON-serialized)
//       context.extensionPath  → FileAccess (composer contribution media dir)
//   window.showWarning/Error/InformationMessage → INotificationService
//   window.showWarningMessage(..., {modal:true}, "Send anyway")
//                                              → IDialogService.confirm
//   window.createOutputChannel("IDE Agent")    → IOutputService (getChannel('ide-agent');
//                                               console fallback until the channel is registered
//                                               by the composer workbench contribution)
//   workspace.getConfiguration("ide.*")        → IConfigurationService.getValue("ide.*.*")
//   workspace.saveAll()                        → IEditorService.saveAll()
//   DebugServerService                         → migrated to ./debugServerService.js (core);
//                                               constructed with optional DI-free opts
//                                               (storage dir / ndjson port / output-channel factory)
//
// The turn/queue/checkpoint/plan logic is UNCHANGED — only workbench access
// moved to DI. Per-tab instance (one per chat tab), constructed by the
// composer factory at the wiring site.
//
// PARITY EVIDENCE STATUS (rule: ~/AGENTS.md "KHÔNG BỊA ĐẶT", 2026-10-19):
//   VERIFIED (REA, docs/rea/cursor-agent-layers-2026-10-19.md §1): this file
//     lives at src/vs/workbench/contrib/composer/, matching Cursor's layer —
//     Cursor 3.25.9 keeps agent code in vs/workbench/contrib/composer/
//     bundled into workbench.desktop.main.js (renderer, workbench core — not
//     an extension). The name ComposerDataService occurs 36× in Cursor's
//     workbench bundle (NLS keys vs/workbench/contrib/composer/...).
//     Behavioral parity is NOT verified — name + layer only.
//   UNKNOWN: every other "Cursor parity" / "Cursor's X" claim in this file
//     was inherited from the original extension source with NO binary/docs
//     evidence. Specific identifiers presented as Cursor internals
//     (writeRulesEntry, onBeforeSubmitChat, queueMessageDefaultBehavior,
//     cursor-ndjson-ingest, ...) are marked UNKNOWN inline. Do not treat them
//     as verified Cursor internals.

import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import { HookService } from "./hooks/hookService.js";
import { buildSessionEndExtras } from "../common/hooks/hookEventSpecs.js";
import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { Emitter, Event } from "../../../../base/common/event.js";
import { FileAccess } from "../../../../base/common/network.js";
import { IConfigurationService } from "../../../../platform/configuration/common/configuration.js";
import { INotificationService } from "../../../../platform/notification/common/notification.js";
import { IDialogService } from "../../../../platform/dialogs/common/dialogs.js";
import { IOutputService } from "../../../../workbench/services/output/common/output.js";
import { IEditorService } from "../../../../workbench/services/editor/common/editorService.js";
import { IStorageService, StorageScope, StorageTarget } from "../../../../platform/storage/common/storage.js";
import { IWorkspaceContextService } from "../../../../platform/workspace/common/workspace.js";
import { IWorkspaceTrustManagementService } from "../../../../platform/workspace/common/workspaceTrust.js";
import { IFileService } from "../../../../platform/files/common/files.js";
import { IEnvironmentService, INativeEnvironmentService } from "../../../../platform/environment/common/environment.js";
import { ISearchService } from "../../../../workbench/services/search/common/search.js";
import { ModeName, TurnEvent } from "../common/model.js";
import { ComposerBubbleSetStore } from "../common/bubbleStore.js";
import { ModeService, MODES, wrapPlanPrompt, wrapDebugPrompt, wrapMultitaskPrompt, shouldSuggestDebugMode } from "../common/modeService.js";
import type { DebugModeConfig } from "../common/modeService.js";
import { DebugServerService } from "./debugServerService.js";
import { HumanReviewService } from "../common/humanReviewService.js";
import { CheckpointService } from "../common/checkpointService.js";
import { MessageQueueService, QueuedMessage } from "../common/messageQueueService.js";
import { EngineAdapter, StubEngineAdapter } from "../../agents/common/agentService.js";
import { FileAttachment } from "../common/mentionService.js";
import {
	IComposerDataService,
	PendingPlan,
	SubmitOptions,
	ComposerEvent,
} from "../common/composerDataService.js";
import {
	bundledIncompleteDiagnostic,
	resolveBunPath,
	resolveEnginePath,
	resolveEngineSpawnCwd,
} from "./enginePath.js";
import { IdeCodeEngineAdapter } from "./ideCodeEngineAdapter.js";
import type { IComposerOutputChannel } from "../common/ideCodeEngineAdapter.js";
import { ModelSelection, ModelSelectionStore, ModelService } from "../common/modelService.js";
import { ProjectRulesService } from "./projectRulesService.js";
import { playChime, defaultChimePath } from "./chime.js";
import { scanPromptForSecrets } from "../common/leakDetection.js";
import { IComposerPlanService } from "../common/composerPlanService.js";
import type { AcceptedPlan } from "../common/composerPlanService.js";

/** How a message submitted while a turn is running should be delivered. */
const MODEL_STATE_KEY = "ideAgent.selectedModel";

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

export class ComposerDataService extends Disposable implements IComposerDataService {

  declare readonly _serviceBrand: undefined;
  readonly bubbles = new ComposerBubbleSetStore();
  readonly modes = new ModeService();
  readonly reviews: HumanReviewService;
  readonly checkpoints: CheckpointService;
  readonly queue: MessageQueueService;
  /**
   * Cursor-style .mdc project rules. Injected into the agent request on every
   * submit. Agent Chat ONLY — (UNKNOWN: "writeRulesEntry"/"onBeforeSubmitChat"
   * were presented as Cursor's names — no evidence.)
   * never consulted by Cmd+K or Tab paths (parity spec §A6).
   */
  readonly projectRules: ProjectRulesService;
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
   * P3 (QA-CHATTABS-01 P3-2): the mode of the currently-running turn, so a
   * clarifying question asked mid-turn remembers which mode asked it.
   */
  private currentTurnMode: ModeName | undefined;
  /**
   * Sink for parity-rule logging (overdue steer, approval shadow mode).
   * Wired in the constructor to the shared "IDE Agent" output channel.
   */
  log?: (line: string) => void;
  /**
   * Doc-gap A12: clarifying questions asked by the agent mid-turn
   * (ask_question_tool_call), keyed by questionId. Answered questions are
   * removed; the answer is steered into the running turn.
   */
  private readonly pendingQuestions = new Map<string, import("../common/model.js").ClarifyingQuestion>();
  /**
   * Plan mode: the plan produced by the last plan-mode turn, awaiting user
   * review (Accept / Discard). Null when there is no pending plan.
   */
  private pendingPlan: PendingPlan | null = null;
  /** P2 (QA-PLANMODE-01): reentrancy guard for acceptPlan's async resolve. */
  private acceptingPlan = false;
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

  private readonly emitter = new Emitter<ComposerEvent>();
  readonly onDidChange: Event<ComposerEvent> = this.emitter.event;
  /** Shared "IDE Agent" output channel (was vscode.window.createOutputChannel). */
  private readonly outputChannel: IComposerOutputChannel;

  constructor(
    @IConfigurationService private readonly configurationService: IConfigurationService,
    @INotificationService private readonly notificationService: INotificationService,
    @IDialogService private readonly dialogService: IDialogService,
    @IOutputService private readonly outputService: IOutputService,
    @IEditorService private readonly editorService: IEditorService,
    @IStorageService private readonly storageService: IStorageService,
    @IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
    @IWorkspaceTrustManagementService
    private readonly workspaceTrustManagementService: IWorkspaceTrustManagementService,
    @IFileService private readonly fileService: IFileService,
    @IEnvironmentService private readonly environmentService: IEnvironmentService,
    @INativeEnvironmentService
    private readonly nativeEnvironmentService: INativeEnvironmentService,
    @ISearchService private readonly searchService: ISearchService,
    /**
     * W65B (composer-plan-accept follow-up): the core plan service
     * (`composerPlanService`, registered in browser/composer.contribution.ts).
     * The plan producer (`capturePendingPlan`) records finished plans here so
     * the `composer.acceptPlan` command path (`getPlanUriFromBubble` ->
     * `acceptPlan`) resolves them; the accepted-plan event drives the build
     * phase below — the fork's analog of Cursor submitting the plan to the
     * engine internally inside `acceptPlan`
     * (`submitChatMaybeAbortCurrent(..., { isPlanExecution: true, ... })`,
     * binary @18684727, Cursor 3.25.9 `workbench.desktop.main.js`).
     */
    @IComposerPlanService private readonly planService: IComposerPlanService,
    /**
     * DEV-HOOKS: agent hooks (OUR design, inspired by the idea of agent
     * hooks — Cursor's hooks story is UNKNOWN). Optional — the composer works
     * without it (all hook call sites fast-path on hasHooks()).
     *
     * IDE-CODE: the ExtensionContext param of the original is DROPPED
     * (vscode.ExtensionContext → internal wiring):
     *   context.subscriptions → this._register (the service extends Disposable)
     *   context.workspaceState → IStorageService (StorageScope.WORKSPACE)
     *   context.extensionPath  → FileAccess (composer contribution media dir)
     * (same precedent as the migrated chatTabService).
     */
    readonly hookService?: HookService,
  ) {
    super();
    // The migrated sibling services take their own DI services — construct
    // them here from this composer's injected services.
    this.reviews = new HumanReviewService(this.configurationService);
    this.queue = new MessageQueueService(this.notificationService);
    // Shared "IDE Agent" output channel (was vscode.window.createOutputChannel).
    const coreChannel = this.outputService.getChannel('ide-agent');
    const outputChannel: IComposerOutputChannel = coreChannel
      ? {
        append: (value: string) => coreChannel.append(value),
        appendLine: (value: string) => coreChannel.append(value + '\n'),
      }
      : {
        // TODO(composer): register the `ide-agent` output channel in the composer
        // workbench contribution via OutputChannelRegistry (Extensions.OutputChannels).
        append: (value: string) => console.log(`[ide-agent] ${value}`),
        appendLine: (value: string) => console.log(`[ide-agent] ${value}`),
      };
    this.outputChannel = outputChannel;
    const output = outputChannel;
    // P1-scope init: field initializers can't see the constructor param.
    this.checkpoints = new CheckpointService(
      this.workspaceContextService,
      this.fileService,
      this.environmentService,
    );
    const requestApproval = (
      toolCallId: string,
      title: string,
      reasons: string[],
      allowlistIdentity?: string,
      // GAPS-22B: shell/terminal candidate command labels — forwarded so the
      // allowlist button label is built Cursor-verbatim (binary `ycp`).
      allowlistCandidates?: readonly string[],
    ) => this.reviews.requestApproval(toolCallId, title, reasons, undefined, undefined, allowlistIdentity, allowlistCandidates);
    const rawMode = this.configurationService.getValue<string>("ide.agent.engineMode") ?? "sidecar";
    // P1 (QA-04-VERIFY): validate — an invalid value used to silently run the
    // demo StubEngineAdapter with no warning.
    const mode = rawMode === "sidecar" || rawMode === "stub" ? rawMode : null;
    if (mode === null) {
      this.notificationService.warn(
        `IDE Agent: unrecognized ide.agent.engineMode "${rawMode}" — expected "stub" or "sidecar". Falling back to "sidecar".`,
      );
    }
    if (mode === "sidecar") {
      const resolvedEngine = resolveEnginePath(
        configurationService.getValue<string>("ide.agent.enginePath") ?? "",
        this.nativeEnvironmentService,
      );
      const adapter = new IdeCodeEngineAdapter(
        {
          enginePath: resolvedEngine.enginePath,
          bunPath: resolveBunPath(resolvedEngine, undefined, (candidate) =>
            output.appendLine(
              `[ide-agent] bundled bun missing at ${candidate}; falling back to bun on PATH`,
            ),
          ),
          engineSource: resolvedEngine.source,
          engineCwd: resolveEngineSpawnCwd(resolvedEngine, this.nativeEnvironmentService),
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
        },
        this.configurationService,
      );
      this.engine = adapter;
      this.engineDisposer = () => adapter.dispose();
      this._register(toDisposable(() => adapter.dispose()));
    } else {
      this.engine = new StubEngineAdapter(requestApproval);
    }
    this.engineConnected = mode === "sidecar";
    // M-03 (model picker): restore the persisted selection and apply it to
    // the engine. At startup no sessions exist yet, so setModel only records
    // the selection for session creation — the sidecar is NOT spawned here.
    // (IDE-CODE: workspaceState → IStorageService, StorageScope.WORKSPACE.)
    const modelStore: ModelSelectionStore = {
      load: () => {
        try {
          const raw = this.storageService.get(MODEL_STATE_KEY, StorageScope.WORKSPACE);
          return raw ? (JSON.parse(raw) as ModelSelection) : undefined;
        } catch {
          return undefined;
        }
      },
      save: (selection) => {
        try {
          this.storageService.store(MODEL_STATE_KEY, JSON.stringify(selection), StorageScope.WORKSPACE, StorageTarget.USER);
        } catch {
          /* persistence must never break the composer */
        }
      },
    };
    this.models = new ModelService(modelStore);
    this.models.onDidChangeModel((selection) =>
      this.emitter.fire({ kind: "modelChanged", selection }),
    );
    const persistedModel = this.models.getSelection();
    const engine = this.engine;
    if (persistedModel.ref && typeof engine.setModel === "function") {
      void engine.setModel(persistedModel.ref).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        void this.notificationService.warn(
          `IDE Agent: could not restore the saved model "${persistedModel.label}" — ${message}`,
        );
      });
    }
    this.modes.onDidChangeMode((mode) => this.emitter.fire({ kind: "modeChanged", mode }));
    this.queue.onDidChangeQueue((items) =>
      this.emitter.fire({ kind: "queueChanged", length: items.length, items: [...items] }),
    );
    // Parity-rule logging (overdue steer, approval shadow mode) goes to the
    // shared output channel; also forwarded into the approval service so its
    // shadow-mode decisions are logged in the same place.
    this.log = (line: string) => output.appendLine(line);
    this.reviews.log = (line: string) => output.appendLine(line);
    // Cursor-style .mdc project rules — discovered once at startup, watched live.
    this.projectRules = new ProjectRulesService(
      this.workspaceContextService,
      this.fileService,
      this.searchService,
      this.editorService,
      this.outputService,
    );
    void this.projectRules.refresh();
    this.projectRules.startWatching();
    this._register(this.projectRules);
    // W65B: Cursor's `ComposerPlanService.acceptPlan` submits the accepted
    // plan to the composer's engine internally; the fork's engine is
    // extension-owned (see `../common/composerPlanService.ts`). W77B
    // (W71B-F2): this subscription is kept as the designated hook point but
    // is UNREACHABLE — this core class is deliberately not instantiated and
    // the live accept path runs in the ide-agent extension. The build phase
    // no longer runs here; consumer-side wiring was follow-up W71B-F1,
    // landed by GAPS-181 in browser/composerPlanBridge.ts (the live consumer
    // forwards to the extension's `ide.acceptPlanFromCore`).
    this._register(
      this.planService.onDidAcceptPlan((accepted) => this.onCorePlanAccepted(accepted)),
    );
    this._register(this.emitter);
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
   * P2 (CX2b): re-announce the engine connection state to the webview so its
   * engine-status hint never goes stale. Call after (re)resolving the view
   * and from any future path that changes the engine's health.
   */
  notifyEngineStatus(): void {
    this.emitter.fire({ kind: "engineStatus", connected: this.engineConnected });
  }

  /** Submit a user message. Queues while a turn runs; starts a turn otherwise.
   *
   * Queue send behavior. (UNKNOWN: "queueMessageDefaultBehavior" /
   * "queueManualSendBehavior" were presented as Cursor's setting names — no
   * evidence.)
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
    if (
      this.configurationService.getValue<boolean>("ide.general.leakDetectionEnabled") ?? true
    ) {
      const findings = scanPromptForSecrets(text);
      if (findings.length > 0) {
        void this.dialogService
          .confirm({
            message:
              `IDE Agent: your message looks like it contains a secret (${findings.map((f) => f.label).join(", ")}). ` +
              `Sending it would share the secret with the AI engine.`,
            primaryButton: "Send anyway",
          })
          .then(({ confirmed }) => {
            if (confirmed) {
              void this.submitWithHooks(text, opts);
            }
          });
        return;
      }
    }
    void this.submitWithHooks(text, opts);
  }

  /**
   * DEV-GAPS-34 (hooks-21-events): `beforeSubmitPrompt` gate. Docs
   * (cursor.com/docs/hooks): "Called right after user hits send but before
   * backend request. Can prevent submission." and "Matched against the
   * value `UserPromptSubmit`".
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
        void this.notificationService.warn(
          `IDE Agent: hook error on submit — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (r?.blocked) {
        void this.notificationService.error(
          `IDE Agent: submission blocked by hook — ${r.blockReason ?? "no reason given"}`,
        );
        return;
      }
    }
    if (this.running || this.isDraining) {
      try {
        this.routeSubmit(text, opts);
      } catch (err) {
        // REVERIFY2-P3-3: routeSubmit can throw synchronously (H4 oversize
        // reject in enqueue()/enqueueFront() — the user already got a
        // warning toast at the throw site). Catch it here so the deliberate
        // throw never escapes as an unhandled promise rejection through the
        // `void submitWithHooks(...)` call sites. No second toast: the
        // enqueue site already warned the user.
        void err;
      }
      return;
    }
    void this.runTurn(text, undefined, opts?.attachments);
  }

  /**
   * Route a hook-approved message submitted while a turn is running.
   * (UNKNOWN: queueMessageDefaultBehavior / queueManualSendBehavior were
   * presented as Cursor's names — no evidence.
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
      // (next tool-call boundary), turn uninterrupted. FIFO: never overwrites
      // a pending steer/answer (P2 QA-CHATTABS-01).
      this.pushInterruptSend({ text: prompt, attachments });
      return;
    }
    const key = sendMode === "manual" ? "queueManualSendBehavior" : "queueMessageDefaultBehavior";
    const behavior =
      this.configurationService.getValue<string>(`ide.composer.${key}`) ??
      (sendMode === "manual" ? "stop-and-send" : "send");
    if (behavior === "queue") {
      this.queue.enqueue(prompt, this.modes.getMode(), attachments);
    } else if (behavior === "stop-and-send") {
      // Stop the turn now; the message jumps to the front of the queue so it
      // runs as soon as the aborted turn winds down.
      this.abort();
      this.queue.enqueueFront(prompt, this.modes.getMode(), attachments);
    } else {
      // "send": deliver at the next opportune time — the runTurn loop breaks
      // after the current engine event. FIFO (P2 QA-CHATTABS-01): queued
      // behind any earlier steer/answer, never overwriting it.
      this.pushInterruptSend({ text: prompt, attachments });
    }
  }

  /**
   * P2 (QA-CHATTABS-01): pending Cursor-"Send" messages — a FIFO, delivered
   * in order at the next turn boundary. Was a single slot: answering a
   * clarifying question and then hitting Cmd+Enter overwrote (silently lost)
   * the first payload. Writers: routeSubmit (sendNow / "send" behavior),
   * queueSendNow, answerQuestion. Drained by runTurn's finally loop.
   */
  private pendingInterruptSends: { text: string; attachments?: FileAttachment[] }[] = [];

  /**
   * P3 (QA-CHATTABS Round B, R2): cap the interrupt-sends array. Four
   * writers push into it while a turn runs and nothing bounded it — a
   * paste storm (or a runaway script driving the API) could grow it
   * without limit, and every entry becomes a full follow-up turn on drain.
   * Cap: 10 entries / 60k chars total — mirrors the message queue's
   * 10-message cap (MessageQueueService), with a larger char budget because
   * interrupt sends bypass the queue and each one spawns a whole turn.
   * Overflow drops the OLDEST (FIFO, same as the queue) with a warning.
   */
  private static readonly MAX_INTERRUPT_SENDS = 10;
  private static readonly MAX_INTERRUPT_SEND_CHARS = 60_000;

  private pushInterruptSend(entry: { text: string; attachments?: FileAttachment[] }): void {
    this.pendingInterruptSends.push(entry);
    let dropped = 0;
    let chars = 0;
    for (const m of this.pendingInterruptSends) {
      chars += m.text.length;
    }
    while (
      this.pendingInterruptSends.length > ComposerDataService.MAX_INTERRUPT_SENDS ||
      chars > ComposerDataService.MAX_INTERRUPT_SEND_CHARS
    ) {
      const oldest = this.pendingInterruptSends.shift();
      if (oldest) {
        chars -= oldest.text.length;
        dropped += 1;
      } else {
        break;
      }
    }
    if (dropped > 0) {
      void this.notificationService.warn(
        `IDE Agent: too many pending steer messages — dropped ${dropped} oldest. ` +
          `At most ${ComposerDataService.MAX_INTERRUPT_SENDS} pending sends are kept.`,
      );
    }
  }

  /** Post-turn hooks: chime + autosave (Cursor parity settings). */
  private afterTurnCompleted(): void {
    if (this.configurationService.getValue<boolean>("ide.composer.shouldChimeAfterChatFinishes") === true) {
      const customPath = this.configurationService.getValue<string>("ide.composer.customChimeSoundPath") ?? "";
      // IDE-CODE: no extension host path in core — the chime asset ships with
      // the composer contribution (TODO: add vs/workbench/contrib/composer/media/chime.wav).
      const defaultPath = defaultChimePath(FileAccess.asFileUri("vs/workbench/contrib/composer").fsPath);
      void playChime({ customPath, defaultPath });
    }
    if (this.configurationService.getValue<boolean>("ide.composer.shouldAutoSaveNonAgent") ?? true) {
      void this.editorService.saveAll().then(
        () => undefined,
        () => undefined,
      );
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
  getPendingQuestions(): import("../common/model.js").ClarifyingQuestion[] {
    return [...this.pendingQuestions.values()];
  }

  /**
   * P1-2 (QA-CHATTABS-01): dispose this composer — kill the sidecar `bun`
   * process (no more zombie servers on tab close) and settle any pending
   * approvals so no turn hangs. Idempotent: safe to call twice (tab close +
   * extension deactivate both dispose).
   */
  override dispose(): void {
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
          buildSessionEndExtras({
            sessionId: this.hookScope,
            reason: aborted ? "aborted" : "user_close",
            durationMs: Date.now() - this.sessionStartMs,
            finalStatus: aborted ? "aborted" : "closed",
          }),
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
    this.pendingInterruptSends.length = 0;
    // DEV-DEBUG-MULTITASK: stop the debug ingest server with the tab.
    this.debugServerSvc?.dispose();
    this.debugServerSvc = undefined;
    super.dispose();
  }

  /**
   * Abort the running turn, if any. The runTurn loop checks the flag between
   * engine events and stops consuming; the turn ends with a "stopped" note.
   * P1 (QA-FILE-01): wired to the webview's Stop button — also kills the
   * engine's in-flight network/streaming work via engine.abortTurn() so Stop
   * is prompt even when the engine would otherwise wait for more events.
   */
  abort(): void {
    if (this.running) {
      this.abortRequested = true;
      this.engine.abortTurn();
    }
  }
  private abortRequested = false;

  /**
   * DEV-DEBUG-MULTITASK: lazy NDJSON ingest server for Debug mode — one per
   * chat tab, started on the first debug turn, stopped on dispose.
   */
  private debugServerSvc: DebugServerService | undefined;

  private debugServer(): DebugServerService {
    if (!this.debugServerSvc) {
      // IDE-CODE: migrated DebugServerService (core, DI-free ctor opts) —
      // the binary resolves the log dir as <workspace>/.cursor (else
      // ~/.cursor/debug-logs) and refuses untrusted workspaces, so the
      // real workspace state is injected here.
      this.debugServerSvc = new DebugServerService({
        workspaceFolderPath: this.workspaceContextService.getWorkspace().folders[0]?.uri.fsPath,
        workspaceTrusted: this.workspaceTrustManagementService.isWorkspaceTrusted(),
        ndjsonPort: this.configurationService.getValue<number>("ide.debug.ndjsonPort") ?? 0,
      });
      this._register(this.debugServerSvc);
    }
    return this.debugServerSvc;
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
      // Project rules are merged into the AGENT REQUEST, not into the
      // displayed human bubble. Agent Chat ONLY — never Cmd+K or Tab.
      // (UNKNOWN: "writeRulesEntry"/"onBeforeSubmitChat" as Cursor's — no
      // evidence; §A6 is OUR internal spec.)
      const rulesBlock = this.projectRules.buildInjection(prompt, turnMode);
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
      const enginePrompt =
        rulesBlock.text || hookBlock ? `${prompt}\n\n${rulesBlock.text}${hookBlock}` : prompt;
      // DEV-DEBUG-MULTITASK: start the NDJSON ingest server for debug turns
      // (UNKNOWN: "cursor-ndjson-ingest" was presented as Cursor's — no
      // evidence.) The config flows into
      // the debug system instruction so the agent knows where to POST
      // instrumentation logs. A failed start degrades gracefully — the
      // instruction then tells the agent to log to a workspace file instead.
      let debugConfig: DebugModeConfig | undefined;
      if (turnMode === "debug") {
        try {
          debugConfig = await this.debugServer().ensureStarted(`debug-${this.hookScope}`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.log?.(`[ide-agent] debug ingest server failed to start: ${message}`);
          // The binary's start command shows a warning on trust refusal
          // ([BIN] "debug mode disabled in untrusted workspace.").
          if (message === "debug mode disabled in untrusted workspace.") {
            this.notificationService.warn(message);
          }
        }
      }
      // Plan mode: the agent researches and produces an editable checklist —
      // never implements. Mutating tools are additionally blocked at the
      // approval choke point (plan ∈ READ_ONLY_MODES).
      // Debug mode: the 6-step debug loop (hypotheses → instrumentation →
      // repro → analyze → targeted fix → cleanup) with the live ingest
      // config; shell/MCP ask for approval via the debug session ruleset.
      // Multitask mode: orchestration posture — decompose and dispatch via
      // the engine's `subagent` tool (background:true), capped at
      // MULTITASK_MAX_RUNNING parallel workers.
      const finalPrompt =
        turnMode === "plan"
          ? wrapPlanPrompt(enginePrompt)
          : turnMode === "debug"
            ? wrapDebugPrompt(enginePrompt, debugConfig)
            : turnMode === "multitask"
              ? wrapMultitaskPrompt(enginePrompt)
              : enginePrompt;
      for await (const event of this.engine.runTurn({
        prompt: finalPrompt,
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
        // Cursor "Send" queue behavior: deliver the pending message at the
        // next opportune time — break after the current engine event.
        // P2-2 (QA-CHATTABS-01): FIFO — break when ANY steer/answer is queued.
        if (this.pendingInterruptSends.length > 0) {
          break;
        }
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
        void this.notificationService.error(`IDE Agent: turn failed: ${message}`);
      }
    } finally {
      this.running = false;
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
          // P2-2 (QA-CHATTABS-01): FIFO — every queued steer/answer is
          // delivered in order; nothing is overwritten or lost.
          const interrupt = this.pendingInterruptSends.shift();
          if (interrupt !== undefined) {
            await this.runTurn(interrupt.text, undefined, interrupt.attachments);
            continue;
          }
          const queued = this.queue.drain();
          if (queued.length === 0) {
            break;
          }
          // Overdue-steer rule (deepdig-runtime-agent-loop §3 is OUR internal
          // doc, not a Cursor source — parity UNKNOWN:
          // resyncOverduePendingSteerFallback). Messages admitted while the
          // turn ran but undelivered after 5 minutes are retagged to the next
          // turn as queued follow-ups (they are NOT merged into the turn that
          // just ended). Each drained message already runs as its own turn
          // below, so overdue items naturally become follow-ups; log it.
          const now = Date.now();
          const overdue = queued.filter((q) => this.queue.isOverdue(q, now));
          if (overdue.length > 0) {
            this.log?.(
              `[ide-agent] Overdue pending context injections converted to queued follow-ups: ` +
                `${overdue.length}/${queued.length} message(s) waited >5min`,
            );
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
      void this.notificationService.warn(
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
    this.pendingInterruptSends.length = 0;
    // 4. Webview-local composer state.
    this.emitter.fire({ kind: "newChat" });
    // 5. Plan mode (parity-chat-modes §3.6 is OUR internal doc, not a Cursor
    // source — parity UNKNOWN): a new chat starts
    // in the default mode (agent) and drops any pending plan.
    this.clearPendingPlan();
    this.modes.reset();
    return true;
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
    // W77B (W71B-F2): the W65B core-registry `clearPlan` sync was removed
    // with the dead `recordPlan` path (this core class is deliberately not
    // instantiated — see `browser/composerPlanBridge.ts`). The live clear
    // path is the ide-agent extension's `clearPendingPlan` ->
    // `ide.clearComposerPlan` command, which clears the registry record the
    // extension itself produced.
  }

  /**
   * Capture the assistant's response of a completed plan-mode turn as a
   * pending plan: persist it to ~/.ide-code/plans/ and fire `planReady`.
   * A turn that produced no text (aborted/errored/empty) yields no plan.
   *
   * W77B (W71B-F2): this core class is deliberately NOT instantiated
   * (`IComposerDataService` is unregistered — see
   * `browser/composerPlanBridge.ts`), so this producer is dormant. The LIVE
   * plan producer is the ide-agent extension's per-tab
   * `ComposerDataService.capturePendingPlan`, which persists the plan and
   * forwards it through the `ide.recordComposerPlan` command into the core
   * `IComposerPlanService` registry (`recordPlan` — a fork-side producer
   * API; Cursor has no `recordPlan`: 0 hits in the 3.25.9 bundle,
   * binary-verified — the fork's analog of Cursor attaching the plan URI to
   * the CREATE_PLAN tool bubble's `additionalData.planUri` @18683492).
   */
  private async capturePendingPlan(assistantBubbleId: string): Promise<void> {
    const bubble = this.bubbles.getBubbleData(assistantBubbleId);
    const text = bubble?.text?.trim() ?? "";
    if (!text) {
      return;
    }
    const savedPath = await savePlanFile(text);
    this.pendingPlan = { bubbleId: assistantBubbleId, text, savedPath, createdAt: Date.now() };
    this.emitter.fire({ kind: "planReady", plan: this.pendingPlan });
  }

  /** Discard the pending plan without implementing it. */
  discardPlan(): void {
    this.clearPendingPlan();
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
      void this.notificationService.info("IDE Agent: no pending plan to accept.");
      return;
    }
    await this.runBuildPhase(plan);
  }

  /**
   * W65B: handler for a plan accepted through the CORE plan service
   * (`composerPlanService.acceptPlan` — the `composer.acceptPlan` command
   * path, Cursor's PlanReviewModel-APPROVE analog). Cursor submits the
   * accepted plan to the composer's engine inside `acceptPlan`
   * (`submitChatMaybeAbortCurrent(..., { isPlanExecution: true, planUri,
   * planTitle, bubbleId, ... })`, binary @18684727).
   *
   * W77B (W71B-F2): UNREACHABLE in production — this core class is
   * deliberately not instantiated (see `browser/composerPlanBridge.ts`), so
   * the subscription above never fires and the removed `composerId` filter
   * (dead with the W65B `recordPlan` path — `setComposerId` had 0 call
   * sites) has no id to compare against. Doc-drift fix: the old NOTE said
   * the webview "must route through the `composer.acceptPlan` command" —
   * that is stale. The live accept path is the ide-agent EXTENSION's
   * `acceptPlan()` called directly (the webview's `{ type: 'acceptPlan' }`
   * message is handled in the extension's chatEditorProvider), bypassing
   * core entirely. Consumer-side wiring of `composer.acceptPlan` /
   * `onDidAcceptPlan` was the separate follow-up W71B-F1 — landed by
   * GAPS-181: the live consumer is the core
   * `ComposerPlanAcceptConsumerContribution` (browser/composerPlanBridge.ts),
   * which forwards accepted plans to the extension's
   * `ide.acceptPlanFromCore` build phase. This dead class's hook stays a
   * no-op; nothing builds here.
   */
  private onCorePlanAccepted(accepted: AcceptedPlan): void {
    void accepted;
  }

  /**
   * Build phase for the `acceptPlan()` entry point: resolve the plan file,
   * drop the pending plan, switch to agent mode and submit the implementation
   * request. (W77B: the former second entry point — the core
   * `onDidAcceptPlan` event — is now a no-op; see `onCorePlanAccepted`.)
   */
  private async runBuildPhase(plan: PendingPlan): Promise<void> {
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
   * Resolve the persisted plan file (Cursor's agent.execute_plan.* semantics):
   *  - plan file exists and is readable → use it (resolution ok),
   *  - missing (deleted/moved) → recreate from the in-memory plan text
   *    (plan_file_recreated),
   *  - recreate fails → error shown (plan_file_recreate_failed), no build.
   * Returns the readable plan file path, or null when resolution failed.
   */
  private async resolvePlanFile(plan: PendingPlan): Promise<string | null> {
    const output = this.outputChannel;
    const readable = async (p: string): Promise<boolean> => {
      try {
        await fs.access(p);
        return true;
      } catch {
        return false;
      }
    };
    if (plan.savedPath && (await readable(plan.savedPath))) {
      return plan.savedPath;
    }
    output.appendLine(
      `[ide-agent] agent.execute_plan.plan_file_resolution_failed for ${plan.savedPath || "(no path)"} — recreating`,
    );
    try {
      const recreated = await savePlanFile(plan.text);
      if (recreated && (await readable(recreated))) {
        output.appendLine(`[ide-agent] agent.execute_plan.plan_file_recreated: ${recreated}`);
        plan.savedPath = recreated;
        return recreated;
      }
    } catch {
      // fall through to the failure notice below
    }
    output.appendLine(`[ide-agent] agent.execute_plan.plan_file_recreate_failed`);
    void this.notificationService.error(
      "IDE Agent: could not resolve the plan file for the accepted plan — nothing was implemented.",
    );
    return null;
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
      // P2-2 (QA-CHATTABS-01): FIFO — queued behind any earlier steer/answer.
      this.pushInterruptSend({ text: item.text, attachments: item.attachments });
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
    if (this.running || this.isDraining) {
      // Steer: FIFO, delivered at the next opportune time.
      this.pushInterruptSend({ text: answerText });
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
   * No confirmation dialog (matches Cursor). Refuses while a turn is running
   * (P1 QA-FILE-04): in-flight applyEvent calls would hit truncated bubbles
   * and silently drop the turn's output.
   */
  async revertToCheckpoint(bubbleId: string): Promise<string[]> {
    // P4/low (QA-CHATTABS Round B, R4): guard isDraining like closeTab and
    // newChat do — restoring files mid-drain would corrupt the follow-up
    // turns the drain loop is about to run.
    if (this.running || this.isDraining) {
      void this.notificationService.warn(
        "IDE Agent: cannot restore a checkpoint while a turn is running — wait for the turn to finish first.",
      );
      return [];
    }
    const checkpoint = this.checkpoints.getByBubble(bubbleId);
    if (!checkpoint) {
      void this.notificationService.warn(
        "IDE Agent: no checkpoint found for that message.",
      );
      return [];
    }
    // Files-only restore (product decision 2026-10-19): writes back
    // snapshots, deletes created files — the transcript is left intact.
    const restored = await this.checkpoints.checkoutToCheckpoint(bubbleId);
    if (restored.isSame) {
      void this.notificationService.info(
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
    void this.notificationService.info(
      `IDE Agent: restored checkpoint` +
        (parts.length > 0 ? ` — ${parts.join(", ")}` : " — files already match") +
        ".",
    );
    // P3-1 (QA-CHATTABS-01): return what was actually restored — the
    // signature promises string[] and callers (and future UI) need it.
    return [...restored.reverted, ...restored.deleted];
  }

  /** Bubble the last restore targeted (drives the webview "checked out" chip). */
  get restoredFromBubbleId(): string | undefined {
    return this.latchedRestoredFromBubbleId;
  }
  private latchedRestoredFromBubbleId?: string;

  /**
   * Undo the last restore: re-apply the latest "after" checkpoint's file
   * contents. (UNKNOWN: "checkoutToLatest" was presented as Cursor's name —
 * no evidence.)
   */
  async undoRestore(): Promise<void> {
    // P4/low (QA-CHATTABS Round B, R4): same guard as revertToCheckpoint —
    // re-applying files mid-drain corrupts the follow-up turns.
    if (this.running || this.isDraining) {
      void this.notificationService.warn(
        "IDE Agent: cannot undo a restore while a turn is running.",
      );
      return;
    }
    const restored = await this.checkpoints.checkoutToLatest();
    this.latchedRestoredFromBubbleId = undefined;
    if (restored.reverted.length > 0) {
      void this.notificationService.info(
        `IDE Agent: undone restore — ${restored.reverted.length} file(s) re-applied.`,
      );
    } else {
      void this.notificationService.info("IDE Agent: nothing to undo.");
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

  /** Finish a terminal run: append the exit-code / timeout status line. */
  finishTerminalRun(
    bubbleId: string,
    exitCode: number,
    elapsedMs: number,
    timedOut: boolean,
  ): void {
    const existing = this.bubbles.getBubbleData(bubbleId);
    const base =
      existing?.text && existing.text !== "_Running…_"
        ? existing.text
        : "(no output)";
    const status = timedOut
      ? `timed out after ${Math.round(elapsedMs / 1000)}s (sent Ctrl+C)`
      : `exit code ${exitCode} in ${(elapsedMs / 1000).toFixed(1)}s`;
    this.bubbles.updateBubble(bubbleId, { text: `${base}\n\n— ${status}` });
    this.emitter.fire({ kind: "bubblesChanged", ids: [bubbleId] });
  }
}

