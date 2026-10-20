/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Migrated from extensions/ide-agent/src/services/ideCodeEngineAdapter.ts (CAT-B, vscode→DI)
//
// vscode API → core mapping used here (per docs/rea/ext-api-audit-2026-10-19.md §3):
//   vscode.OutputChannel (IdeCodeEngineOptions.output)
//       → IComposerOutputChannel below (append/appendLine surface). The wiring
//         site resolves it from IOutputService (getChannel('ide-agent')) or a
//         console-backed fallback — see ProjectRulesService for the pattern.
//   workspace.getConfiguration("ide.agent").get("fallbackModels")
//       → IConfigurationService.getValue("ide.agent.fallbackModels")
//   workspace.getConfiguration("ide.agent").get("smart_mode_classifier_shadow_mode")
//       → IConfigurationService.getValue("ide.agent.smart_mode_classifier_shadow_mode")
//   workspace.getConfiguration("ide.composer").get("runMode")
//       → IConfigurationService.getValue("ide.composer.runMode")
//   NodeJS.Timeout → ReturnType<typeof setTimeout>
//
// The HTTP/SSE engine wire protocol (spawn, /api/*, SSE parsing, approval
// flow, retry taxonomy, turnSettled) is UNCHANGED — only the config and
// logging sources moved to DI.
//
// Sibling imports: EngineAdapter/ModelRef/TurnContext now come from the
// migrated agents contrib (../../agents/common/agentService.js); agentRuntime
// (DD-AR runtime classes) now also comes from the migrated agents contrib
// (../../agents/common/agentRuntime.js).
//
// NOTE: per-composer instance (one per chat tab) — constructed with `new`
// (opts carry the per-tab callbacks), NOT a singleton workbench service.
//
// PARITY EVIDENCE STATUS (rule: ~/AGENTS.md "KHÔNG BỊA ĐẶT", 2026-10-19):
//   UNKNOWN: every "Cursor's X" claim in this file (protocol shape, backoff
//     math, "canonical kinds", Ask mode, Run Modes, allowlist run mode,
//     clickable question widget, fallback_models server-driven) has NO
//     REA/binary/docs evidence — inherited from the original source. The
//     HTTP/SSE wire protocol below is OUR engine-sidecar protocol, not a
//     verified Cursor protocol. "Cursor-style" tool naming is OUR naming
//     convention. Do not treat any of it as verified Cursor behavior.

import { EngineAdapter } from "../../agents/common/agentService.js";
import { IDisposable } from "../../../../base/common/lifecycle.js";
import { createDecorator } from "../../../../platform/instantiation/common/instantiation.js";
import { ApprovalResult } from "./humanReviewService.js";
import { ModeName } from "./model.js";
import type { IHookService } from "./hooks/hookService.js";
import {
  SummarizationTrigger,
} from "../../agents/common/agentRuntime.js";

/**
 * Minimal output-channel surface the engine adapter needs (was
 * vscode.OutputChannel). The wiring site adapts IOutputService's channel
 * (or a console fallback) to this shape.
 */
export interface IComposerOutputChannel {
  append(value: string): void;
  appendLine(value: string): void;
}

/**
 * IdeCodeEngineAdapter — the REAL engine adapter.
 *
 * Spawns the ide-code (OpenCode-derived) server as a sidecar process and
 * translates its HTTP/SSE wire protocol into TurnEvents for the chat UI:
 *
 *   spawn:  bun <enginePath>/packages/cli/src/index.ts serve --port <free> --hostname 127.0.0.1
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
  output: IComposerOutputChannel;
  requestApproval: (
    toolCallId: string,
    title: string,
    reasons: string[],
    /** P1 (QA-CHATTABS-01): stable allowlist identity (action+resources). */
    allowlistIdentity?: string,
    /**
     * GAPS-22B: shell/terminal candidate command labels. When non-empty,
     * the approval card's allowlist button label is built Cursor-verbatim
     * (`Always Run '<cmd>'` / `Always Run '<cmd>' + N` — binary `ycp`).
     */
    allowlistCandidates?: readonly string[],
  ) => Promise<ApprovalResult>;
  /**
   * P2 (QA-FILE-04): current chat mode, used by the read-only gate in
   * handleApproval. Optional so tests/callers without a mode service keep
   * working (no gate when absent).
   */
  getMode?: () => ModeName;
  /**
   * DEV-HOOKS: agent hooks (OUR design — Cursor's hooks story is UNKNOWN).
   * The approval path is the blocking
   * choke point: preToolUse + beforeShellExecution/beforeMCPExecution/
   * beforeReadFile run before the approval card; exit code 2 auto-rejects.
   * Optional — the adapter works without it.
   */
  hooks?: IHookService;
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
}

/**
 * Engine actions that represent terminal/shell execution.
 * HONEST-DIVERGENCE: the exact action strings are engine-defined (the
 * sidecar sends `bash`); this set covers the known variants. Mirrors the
 * extension's `permissionsFileService.TERMINAL_ACTIONS`.
 */
export const TERMINAL_ACTIONS: ReadonlySet<string> = new Set(['bash', 'shell', 'shell_tool_call']);


/**
 * DI contract for the engine adapter (node-free).
 *
 * The `IdeCodeEngineAdapter` implementation spawns the engine sidecar
 * (node:child_process), serves HTTP (node:http) and opens a port probe
 * (node:net), so it lives in `electron-browser/ideCodeEngineAdapter.ts`
 * (desktop-only). This interface extends the shared `EngineAdapter`
 * contract so common/ and browser/ code can drive the engine without
 * pulling node builtins into the web bundle.
 */
export const IIdeCodeEngineAdapter = createDecorator<IIdeCodeEngineAdapter>('ideCodeEngineAdapter');

export interface IIdeCodeEngineAdapter extends EngineAdapter, IDisposable {
	/**
	 * Single-shot code completion for the inline-edit / tab path.
	 */
	completeCode(
		prefix: string,
		suffix: string,
		modelId: string | undefined,
		signal: AbortSignal,
		context?: { languageId?: string; fileName?: string },
	): AsyncIterable<string>;
}

/**
 * Factory for per-site configured adapter instances. Each call site
 * (composer tab, inline edit, chat tab) supplies its own
 * `IdeCodeEngineOptions`; the factory is the DI seam that lets
 * node-free layers create the desktop-only implementation.
 */
export const IIdeCodeEngineAdapterFactory = createDecorator<IIdeCodeEngineAdapterFactory>('ideCodeEngineAdapterFactory');

export interface IIdeCodeEngineAdapterFactory {
	readonly _serviceBrand: undefined;
	create(options: IdeCodeEngineOptions): IIdeCodeEngineAdapter;
}
