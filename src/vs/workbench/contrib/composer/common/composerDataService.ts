/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Composer data service DI contract (node-free).
//
// Layer split (P0 node-free common/): the `ComposerDataService` implementation
// touches the filesystem (node:fs), spawns processes and plays sounds, so it
// lives in `electron-browser/composerDataService.ts` (desktop-only). This
// module keeps the node-free contract — the `IComposerDataService` decorator,
// the service interface, the shared event/option shapes, and
// `defaultEnginePath()` (now implemented via the sandbox-safe
// `vs/base/common/process` shim instead of bare `process.env`) — so common/
// and browser/ code can depend on the composer without pulling node builtins
// into the web bundle.

import { Event } from "../../../../base/common/event.js";
import { env, platform } from "../../../../base/common/process.js";
import { createDecorator } from "../../../../platform/instantiation/common/instantiation.js";
import { ModeName, TurnSettled } from "./model.js";
import { ComposerBubbleSetStore } from "./bubbleStore.js";
import { ModeService } from "./modeService.js";
import { HumanReviewService } from "./humanReviewService.js";
import { CheckpointService } from "./checkpointService.js";
import { MessageQueueService } from "./messageQueueService.js";
import { EngineAdapter } from "../../agents/common/agentService.js";
import { ModelSelection, ModelService } from "./modelService.js";
import type { ProjectRulesService } from '../electron-browser/projectRulesService.js';
import type { FileAttachment } from "./mentionService.js";

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

/** workspaceState key for the persisted model picker selection (per workspace). */

export type ComposerEvent =
  | { kind: "bubblesChanged"; ids: string[] }
  | { kind: "bubblesReset" }
  | { kind: "modeChanged"; mode: ModeName }
  // Queue list UI: the full items (id/text/mode/enqueuedAt) so the webview
  // can render the list with reorder/delete/send-now per message.
  | { kind: "queueChanged"; length: number; items: import("./messageQueueService.js").QueuedMessage[] }
  // P1 (CX1b): a new chat was started — the webview must reset all
  // composer-local state (chips, input draft, open menus, ctx usage).
  | { kind: "newChat" }
  // P1 (QA-FILE-01): turn lifecycle — drives the webview's Stop/Send toggle.
  | { kind: "turnState"; running: boolean }
  // Checkpoint restored (files + transcript) — drives the webview's
  // "checked out" chip on the target human bubble (Cursor parity).
  | { kind: "checkpointRestored"; bubbleId: string }
  // Doc-gap A12: the agent asked a clarifying question mid-turn — drives the
  // webview's clickable question widget.
  | { kind: "questionAsked"; question: import("./model.js").ClarifyingQuestion }
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
  // DD-AR-9 (turnSettled protocol): the adapter reported how the turn ended —
  // COMPLETED | FAILED | INTERRUPTED (+ interruptedBy / stopReason).
  | { kind: "turnSettled"; bubbleId: string; settled: TurnSettled };

/** Tool-call card kind → hook tool name (for post-tool hook payloads).
 *  (DEV-HOOKS, our own mapping — Cursor's hook story is UNKNOWN.) */

export const IComposerDataService = createDecorator<IComposerDataService>('composerDataService');

/** Public surface of the per-tab composer data hub (for the chat view host). */
export interface IComposerDataService {
  readonly _serviceBrand: undefined;

  readonly bubbles: ComposerBubbleSetStore;
  readonly modes: ModeService;
  readonly reviews: HumanReviewService;
  readonly checkpoints: CheckpointService;
  readonly queue: MessageQueueService;
  readonly projectRules: ProjectRulesService;
  readonly models: ModelService;
  /** Sink for parity-rule logging (wired to the shared "IDE Agent" output channel). */
  log?: (line: string) => void;
  readonly onDidChange: Event<ComposerEvent>;

  /** True when turns run against the real engine sidecar; false for the stub. */
  readonly isEngineConnected: boolean;
  getEngineAdapter(): EngineAdapter;
  notifyEngineStatus(): void;

  /** Submit a user message. Queues while a turn runs; starts a turn otherwise. */
  submit(prompt: string, opts?: SubmitOptions): void;
  readonly isRunning: boolean;
  readonly isDraining: boolean;
  getPendingQuestions(): import("./model.js").ClarifyingQuestion[];
  dispose(): void;
  /** Abort the running turn, if any. */
  abort(): void;

  /** Start a fresh chat. Returns false when refused because a turn is running. */
  newChat(): Promise<boolean>;
  getPendingPlan(): PendingPlan | null;
  discardPlan(): void;
  acceptPlan(): Promise<void>;

  queueRemove(id: string): boolean;
  queueMove(id: string, direction: -1 | 1): boolean;
  queueSendNow(id: string): boolean;

  answerQuestion(questionId: string, optionId: string): boolean;
  answerQuestionMulti(questionId: string, optionIds: string[]): boolean;

  revertToCheckpoint(bubbleId: string): Promise<string[]>;
  readonly restoredFromBubbleId: string | undefined;
  undoRestore(): Promise<void>;

  postTerminalRun(command: string): string;
  updateTerminalOutput(bubbleId: string, output: string): void;
  finishTerminalRun(bubbleId: string, exitCode: number, elapsedMs: number, timedOut: boolean): void;
}

/**
 * Best-effort default for the engine checkout: ~/workspace/ide-code.
 *
 * Node-free (vs/base/common/process shim): in the desktop sandbox
 * `env` is the sanitized process env (HOME/USERPROFILE present); on web it
 * is `{}` and this returns "" — same honest "no data" contract as before
 * (the old bare `process.env` access would throw on web where `process`
 * is undefined).
 */
export function defaultEnginePath(): string {
	const home = env['HOME'] ?? env['USERPROFILE'] ?? '';
	if (!home) {
		return '';
	}
	const sep = platform === 'win32' ? '\\' : '/';
	return home + sep + ['workspace', 'ide-code'].join(sep);
}

/**
 * ENGINE PACKAGING (spec engine-packaging-spec-v1 §1/§5): directory name
 * of the engine bundled with the packaged app. The bundled engine lives
 * INSIDE the app root: `resources/app/engine`. MUST match the extension
 * constant of the same name in
 * `extensions/ide-agent/src/services/enginePath.ts`.
 */
export const BUNDLED_ENGINE_DIR_NAME = 'engine';

/** Bundled bun binary, relative to a resolved engine root. */
export const BUNDLED_BUN_RELATIVE = platform === 'win32' ? 'bin\\bun.exe' : 'bin/bun';

/**
 * Candidate bundled-engine path derived purely from the app root
 * (`path.join(appRoot, "engine")` per spec §1); '' when appRoot is ''.
 * Pure string work only — this module is node-free; the existence checks
 * live in `electron-browser/enginePath.ts` (`resolveEnginePath`).
 */
export function bundledEnginePathFromAppRoot(appRoot: string): string {
	if (!appRoot) {
		return '';
	}
	const sep = platform === 'win32' ? '\\' : '/';
	const trimmed = appRoot.endsWith(sep) ? appRoot.slice(0, -1) : appRoot;
	return trimmed + sep + BUNDLED_ENGINE_DIR_NAME;
}
