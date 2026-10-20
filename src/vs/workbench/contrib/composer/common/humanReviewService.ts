/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Migrated from extensions/ide-agent/services/humanReviewService.ts — vscode API → DI
// - `vscode.EventEmitter` → core `Emitter` (vs/base/common/event)
// - `vscode.workspace.getConfiguration("ide.agent").get("smart_mode_classifier_shadow_mode")`
//   → injected `IConfigurationService.getValue("ide.agent.smart_mode_classifier_shadow_mode")`
//   (config keys keep the `ide.` prefix — see common/composerConfiguration.ts)
//
// Per-composer instance: ComposerDataService creates one HumanReviewService
// per chat tab (`this.reviews = new HumanReviewService(...)`), matching the
// binary's per-composer `toolCallHumanReviewService` (workbench.glass.main.js
// 3.25.6, ×20 hits — workbench UI surface, not agent-host).
//
// PARITY EVIDENCE STATUS (rule: ~/AGENTS.md "KHÔNG BỊA ĐẶT", 2026-10-19):
//   OBSERVED (docs/rea/audit-fix-queue.md run 25, feature `approval-review-kinds`,
//     matrix #867; run 23 for the option enums):
//     - per-composer `toolCallHumanReviewService`
//     - per-bubble review models via `getTerminalReviewModelForBubble(handle, bubbleId)`
//       (kinds terminal|edit|mcp +configuration)
//     - review data shape {status,selectedOption,isShowingInput,highlightedOption,firstTimeReviewMode}
//     - `setSelectedOption(RUN)`; terminal tool RUN_TERMINAL_COMMAND_V2 auto-selects RUN
//     - HumanReviewOption enums, verbatim keys/values:
//         Terminal: {RUN:"run",SKIP:"skip",ALLOWLIST_COMMANDS:"allowlistCommands",
//                    REJECT_AND_TELL_WHAT_TO_DO_DIFFERENTLY:"rejectAndTellWhatToDoDifferently"}
//         MCP: {RUN:"run",SKIP:"skip",REJECT_AND_TELL_WHAT_TO_DO_DIFFERENTLY:"rejectAndTellWhatToDoDifferently",
//               ALLOWLIST_TOOL:"allowlistTool"}
//         Edit: {ACCEPT:"accept",REJECT_AND_TELL_WHAT_TO_DO_DIFFERENTLY:"rejectAndTellWhatToDoDifferently",
//                SKIP:"skip",SWITCH_TO_DEFAULT_AGENT_MODE:"switchToDefaultAgentMode",
//                ACCEPT_AND_ALLOW_FOLDER:"acceptAndAllowFolder"}
//         Plan: {NONE:"none",APPROVE:"approve",REJECT_AND_TELL_WHAT_TO_DO_DIFFERENTLY:"rejectAndTellWhatToDoDifferently",
//                EDIT:"edit"}
//         WebFetch: {RUN:"run",SKIP:"skip",ALLOWLIST_DOMAIN:"allowlistDomain"}
//   UNKNOWN (auditor residuals — NOT implemented, do not invent):
//     - exact per-option button label strings (the UI strings rendered on the
//       review card buttons were not captured by REA)
//     - threshold values (e.g. when the review card appears vs auto-approves)
//     - exact `ReviewStatus` literal values (shape key `status` is OBSERVED,
//       its value vocabulary was not captured)
//     - initial values of isShowingInput/highlightedOption/firstTimeReviewMode
//       (defaults below are ours, marked as such)
//     - per-bubble model lifecycle details + the `configuration` kind's review
//       flow (auditor: "needs deeper dissection")

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { buildShellAllowlistLabel } from './shellAllowlistLabel.js';

export const IHumanReviewService = createDecorator<IHumanReviewService>('composerHumanReviewService');

/**
 * HumanReviewService — tool-call approval cards.
 * Mirrors Cursor's HumanReviewService: option lists, reason strings,
 * approval ids. The UI renders the card; this service owns the
 * pending-approval promises the agent turn awaits on.
 */
export interface ApprovalOption {
	id: string;
	label: string;
}

export interface ApprovalRequest {
	approvalId: string;
	toolCallId: string;
	title: string;
	reasons: string[];
	options: ApprovalOption[];
}

export type ApprovalResult = { optionId: string } | undefined;

// ---------------------------------------------------------------------------
// approval-review-kinds (Cursor parity — see PARITY EVIDENCE STATUS above)
// ---------------------------------------------------------------------------

/**
 * Tool-call card kind. OBSERVED: terminal|edit|mcp (+configuration).
 * The per-bubble review-model getters below are keyed by (kind, handle, bubbleId).
 */
export type HumanReviewKind = 'terminal' | 'edit' | 'mcp' | 'configuration';

/**
 * Tool name whose terminal review card auto-selects RUN.
 * OBSERVED (audit-fix-queue.md run 25): "terminal RUN_TERMINAL_COMMAND_V2
 * auto-selects RUN".
 */
export const RUN_TERMINAL_COMMAND_V2 = 'RUN_TERMINAL_COMMAND_V2';

/** HumanReviewOption enums — verbatim keys/values from the binary (run 23). */
export const TerminalReviewOption = {
	RUN: 'run',
	SKIP: 'skip',
	ALLOWLIST_COMMANDS: 'allowlistCommands',
	REJECT_AND_TELL_WHAT_TO_DO_DIFFERENTLY: 'rejectAndTellWhatToDoDifferently',
} as const;
export type TerminalReviewOption = (typeof TerminalReviewOption)[keyof typeof TerminalReviewOption];

export const McpReviewOption = {
	RUN: 'run',
	SKIP: 'skip',
	REJECT_AND_TELL_WHAT_TO_DO_DIFFERENTLY: 'rejectAndTellWhatToDoDifferently',
	ALLOWLIST_TOOL: 'allowlistTool',
} as const;
export type McpReviewOption = (typeof McpReviewOption)[keyof typeof McpReviewOption];

export const EditReviewOption = {
	ACCEPT: 'accept',
	REJECT_AND_TELL_WHAT_TO_DO_DIFFERENTLY: 'rejectAndTellWhatToDoDifferently',
	SKIP: 'skip',
	SWITCH_TO_DEFAULT_AGENT_MODE: 'switchToDefaultAgentMode',
	ACCEPT_AND_ALLOW_FOLDER: 'acceptAndAllowFolder',
} as const;
export type EditReviewOption = (typeof EditReviewOption)[keyof typeof EditReviewOption];

export const PlanReviewOption = {
	NONE: 'none',
	APPROVE: 'approve',
	REJECT_AND_TELL_WHAT_TO_DO_DIFFERENTLY: 'rejectAndTellWhatToDoDifferently',
	EDIT: 'edit',
} as const;
export type PlanReviewOption = (typeof PlanReviewOption)[keyof typeof PlanReviewOption];

export const WebFetchReviewOption = {
	RUN: 'run',
	SKIP: 'skip',
	ALLOWLIST_DOMAIN: 'allowlistDomain',
} as const;
export type WebFetchReviewOption = (typeof WebFetchReviewOption)[keyof typeof WebFetchReviewOption];

/**
 * Review lifecycle status. UNKNOWN: the shape key `status` is OBSERVED but the
 * exact literal values in the Cursor binary were not captured by REA — typed
 * as string until dissection pins the vocabulary. Do not invent members.
 */
export type ReviewStatus = string;

/**
 * Per-bubble tool-call review model — the binary's review data shape, verbatim
 * keys: {status,selectedOption,isShowingInput,highlightedOption,firstTimeReviewMode}.
 * One instance per (handle, bubbleId); the service owns the map.
 */
export class ToolCallReviewModel {
	/** UNKNOWN: exact binary status literals not captured — see ReviewStatus. */
	status: ReviewStatus = '';
	/** The currently selected option value (e.g. TerminalReviewOption.RUN). */
	selectedOption: string | undefined = undefined;
	/**
	 * Whether the "tell the agent what to do differently" input is showing.
	 * Default false is OURS (binary initial value UNKNOWN).
	 */
	isShowingInput = false;
	/**
	 * Keyboard-highlighted option value. Default undefined is OURS (UNKNOWN).
	 */
	highlightedOption: string | undefined = undefined;
	/**
	 * Whether this bubble is in first-time review mode (extra hint UI).
	 * Default false is OURS (binary initial value UNKNOWN).
	 */
	firstTimeReviewMode = false;

	/** Binary API: `setSelectedOption(RUN)`. */
	setSelectedOption(option: string): void {
		this.selectedOption = option;
	}

	/**
	 * Binary API: `setIsShowingInput(true)` — REJECT_AND_TELL_WHAT_TO_DO_DIFFERENTLY
	 * opens the feedback input (OBSERVED, §5.1). Cancelling the current composer
	 * run on REJECT is observed behavior but the exact service/UI call path was
	 * not captured — wiring that call is UNKNOWN and lives outside this model.
	 */
	setIsShowingInput(show: boolean): void {
		this.isShowingInput = show;
	}
}

export interface IHumanReviewService {
	readonly _serviceBrand: undefined;

	/** Fires with the request when one opens, undefined when it resolves. */
	readonly onDidChangeApproval: Event<ApprovalRequest | undefined>;

	/** The currently-open approval request, if any. */
	readonly currentApproval: ApprovalRequest | undefined;

	/** True when a fresh (unexpired) allowlist entry covers this tool identity. */
	isAllowlisted(allowlistIdentity: string, now?: number): boolean;

	requestApproval(
		toolCallId: string,
		title: string,
		reasons: string[],
		timeoutMs?: number,
		customOptions?: ApprovalOption[],
		allowlistIdentity?: string,
		/**
		 * GAPS-22B (review-labels-always-run-construction): shell/terminal
		 * approval candidate command labels. When non-empty, the default
		 * "approve-allowlist" option label is built Cursor-verbatim via
		 * buildShellAllowlistLabel (binary `ycp`): `Always Run '<first>'`
		 * for one command, `Always Run '<first>' + N` for several. Mirrors
		 * `ycp(l?.allowlistCandidates?.map(ZpS))` where `ZpS(t) => t.label`.
		 * Non-shell approvals pass nothing and keep the generic labels —
		 * their per-option strings resolve via Cursor's `Ev` nls enum
		 * client-side, which is not statically resolvable and is not
		 * fabricated here.
		 */
		allowlistCandidates?: readonly string[],
	): Promise<ApprovalResult>;

	resolveApproval(approvalId: string, result: ApprovalResult): void;
	resolveApprovalForToolCall(toolCallId: string, result: ApprovalResult): void;

	/**
	 * Settle all pending approvals as undefined (skip). Used when the chat
	 * view is disposed so turns don't hang forever.
	 */
	settleAllPending(): void;
	pendingCount(): number;

	// ---- per-bubble review models (approval-review-kinds parity) ----

	/**
	 * Get (creating on first call) the terminal review model for one chat
	 * bubble. `handle` is the owning composer's handle (this service instance
	 * is already per-composer; the handle is accepted for binary API parity).
	 * OBSERVED: when `toolName` is RUN_TERMINAL_COMMAND_V2 the model is
	 * created with RUN auto-selected.
	 */
	getTerminalReviewModelForBubble(handle: string, bubbleId: string, toolName?: string): ToolCallReviewModel;
	/** Edit-kind review model for one chat bubble. */
	getEditReviewModelForBubble(handle: string, bubbleId: string): ToolCallReviewModel;
	/** MCP-kind review model for one chat bubble. */
	getMcpReviewModelForBubble(handle: string, bubbleId: string): ToolCallReviewModel;
	/**
	 * Binary-verbatim casing alias: the binary registers
	 * `getMCPReviewModelForBubble` (workbench.glass.main.js 3.25.6:
	 * `toolCallHumanReviewService.getMCPReviewModelForBubble(t.handle,n)`).
	 * Same model, same map entry as getMcpReviewModelForBubble.
	 */
	getMCPReviewModelForBubble(handle: string, bubbleId: string): ToolCallReviewModel;
	/** Generic per-bubble review-model accessor (kinds: terminal|edit|mcp|configuration). */
	getReviewModelForBubble(kind: HumanReviewKind, handle: string, bubbleId: string, toolName?: string): ToolCallReviewModel;
	/** Set the selected option on a bubble's review model (no-op when absent). */
	setSelectedOptionForBubble(handle: string, bubbleId: string, option: string): void;
	/**
	 * Terminal-specific select with status side-effects (RUN/SKIP/ALLOWLIST_COMMANDS
	 * → status "done"; REJECT → shows the feedback input). OBSERVED (§5.1).
	 */
	selectTerminalOptionForBubble(handle: string, bubbleId: string, option: TerminalReviewOption): void;
	/** Options the review card currently displays for a kind. */
	getCurrentlyDisplayedOptions(kind: HumanReviewKind): string[];
	/** Remove one bubble's review model (bubble unmount lifecycle). */
	disposeReviewModelForBubble(handle: string, bubbleId: string): void;
	/** Open/close the REJECT feedback input on a bubble's review model. */
	setIsShowingInputForBubble(handle: string, bubbleId: string, show: boolean): void;
}

let approvalSeq = 0;

export class HumanReviewService extends Disposable implements IHumanReviewService {

	declare readonly _serviceBrand: undefined;

	private readonly emitter = this._register(new Emitter<ApprovalRequest | undefined>());
	/** Fires with the request when one opens, undefined when it resolves. */
	readonly onDidChangeApproval = this.emitter.event;
	private pending = new Map<string, { request: ApprovalRequest; resolve: (result: ApprovalResult) => void; allowlistKey: string }>();
	private timers = new Map<string, ReturnType<typeof setTimeout>>();
	private current: ApprovalRequest | undefined;
	/**
	 * Per-bubble review models — approval-review-kinds parity. Keyed by
	 * `${handle}:${bubbleId}` so two bubbles never share a model (each bubble
	 * has its own {status,selectedOption,isShowingInput,highlightedOption,
	 * firstTimeReviewMode}). This service instance is already per-composer
	 * (one per chat tab), so the handle segment is for binary API parity.
	 */
	private readonly reviewModels = new Map<string, ToolCallReviewModel>();
	/** Optional sink for shadow-mode decision logging (wired by the host). */
	log?: (line: string) => void;

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
	}

	/** The currently-open approval request, if any. */
	get currentApproval(): ApprovalRequest | undefined {
		return this.current;
	}

	/**
	 * P2 (CX4b): per-approval timeout. An approval the user never answers used
	 * to stay pending forever, and the serialized approval chain (XQA-03)
	 * queued every later approval behind it — turn 2's approval hung behind
	 * turn 1's stale card indefinitely. After `timeoutMs` the approval
	 * auto-resolves as undefined (skip): the tool is rejected and the chain
	 * unblocks. The card is cleared via the same emitter the manual path uses.
	 */
	static readonly DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

	/**
	 * Allowlist approval TTL — UNKNOWN parity (WORKER-GAPS-15B adversarial
	 * re-check 2026-10-20). The earlier claim citing
	 * `SMART_MODE_MCP_APPROVAL_TTL_SECONDS = 86400` /
	 * `SMART_MODE_SHELL_APPROVAL_TTL_SECONDS = 86400` ("deepdig-runtime-approval
	 * §1.4") is FALSE: neither string has any hit in workbench.glass.main.js
	 * 3.25.6 or 3.25.9 (0/0), and `approval_ttl`/`86400000` are likewise absent.
	 * (The extension-side sibling claim was already debunked — see
	 * services/humanReviewService.ts `allowlistStore` comment: Cursor's
	 * `mcpAllowedTools` entries carry no timestamps and there is no expiry
	 * sweep.) An "Approve and allowlist" decision is remembered for 24 hours
	 * here as an internal guard: the same tool call does not re-prompt within
	 * the TTL. Expired entries are swept on read. Kept as local logic, not
	 * claimed as Cursor parity.
	 */
	static readonly APPROVAL_TTL_MS = 86_400_000;

	/**
	 * Shadow mode (Cursor's `smart_mode_classifier_shadow_mode` — binary evidence:
	 * workbench.glass.main.js 3.25.9 offsets 984622 (client feature-flag
	 * registry `smart_mode_classifier_shadow_mode:{client:!0,default:!1}`) and
	 * 37516979 (aiserver.v1.RunInferencePostToolReminder bool field); same
	 * contexts in 3.25.6 at offsets 984579 and 37507686. The earlier camelCase
	 * spelling `smartModeClassifierShadowMode` had ZERO hits in either binary
	 * — corrected 2026-10-20). HONEST-DIVERGENCE: in Cursor this is a
	 * server-controlled feature flag plus an aiserver protocol field, not a
	 * local config key; here it is a local eval toggle. The approval
	 * evaluation runs but does not enforce — decisions are logged for eval
	 * instead of blocking the turn. Enabled via the
	 * `ide.agent.smart_mode_classifier_shadow_mode` setting. In shadow mode
	 * every approval auto-resolves as approve-once and the would-be card is
	 * recorded to the output channel instead of shown.
	 */
	private allowlistStore = new Map<string, { approvedAt: number }>();

	/**
	 * P1 (QA-CHATTABS-01): the allowlist key MUST be a stable tool identity —
	 * action + resources (e.g. "edit::src/a.ts") — NEVER the per-request
	 * toolCallId (`tc-<permission-request-id>`, unique per request). Keying on
	 * the request id made "Approve and allowlist" a dead feature: the second
	 * identical tool call (new request id) could never match the stored entry.
	 * Callers that know the action/resources pass an explicit identity;
	 * otherwise the title is used as the (stable) identity.
	 */
	private allowlistKey(identity: string): string {
		return identity;
	}

	private sweepAllowlist(now: number): void {
		for (const [key, entry] of this.allowlistStore) {
			if (now - entry.approvedAt >= HumanReviewService.APPROVAL_TTL_MS) {
				this.allowlistStore.delete(key);
			}
		}
	}

	/** True when a fresh (unexpired) allowlist entry covers this tool identity. */
	isAllowlisted(allowlistIdentity: string, now: number = Date.now()): boolean {
		this.sweepAllowlist(now);
		return this.allowlistStore.has(this.allowlistKey(allowlistIdentity));
	}

	/** Whether shadow mode is on (read live so tests can flip the setting). */
	private isShadowMode(): boolean {
		try {
			return (this.configurationService.getValue<boolean>('ide.agent.smart_mode_classifier_shadow_mode') ?? false) === true;
		} catch {
			return false;
		}
	}

	requestApproval(
		toolCallId: string,
		title: string,
		reasons: string[],
		timeoutMs: number = HumanReviewService.DEFAULT_APPROVAL_TIMEOUT_MS,
		customOptions?: ApprovalOption[],
		/**
		 * P1 (QA-CHATTABS-01): stable allowlist identity for this approval
		 * (action + resources, e.g. "edit::src/a.ts"). When omitted the title is
		 * used — still stable across requests, unlike the per-request toolCallId.
		 */
		allowlistIdentity?: string,
		/**
		 * GAPS-22B (review-labels-always-run-construction): shell/terminal
		 * approval candidate command labels — see the interface JSDoc.
		 */
		allowlistCandidates?: readonly string[],
	): Promise<ApprovalResult> {
		approvalSeq += 1;
		const approvalId = `approval-${approvalSeq}`;
		// The allowlist key is fixed at request time so the resolve path stores
		// exactly the identity that was checked here.
		const identityKey = this.allowlistKey(allowlistIdentity ?? title);
		// GAPS-22B: shell approvals label the allowlist button Cursor-verbatim
		// (binary `ycp` → `rt?.fullLabel`). The honest fallback stays
		// "Approve and allowlist" — Cursor's per-option button strings resolve
		// via the `Ev` nls enum client-side and are not statically resolvable.
		const allowlistOptionLabel =
			buildShellAllowlistLabel(allowlistCandidates)?.fullLabel ?? 'Approve and allowlist';
		const request: ApprovalRequest = {
			approvalId,
			toolCallId,
			title,
			reasons,
			options: customOptions ?? [
				{ id: 'approve-once', label: 'Approve once' },
				{ id: 'approve-allowlist', label: allowlistOptionLabel },
				{ id: 'skip', label: 'Skip' },
			],
		};
		// 24h allowlist TTL: a fresh "Approve and allowlist" decision for the
		// same tool identity auto-resolves without re-showing the card.
		if (this.isAllowlisted(identityKey)) {
			return Promise.resolve({ optionId: 'approve-once' });
		}
		// Shadow mode: evaluate (log the would-be card) but do not enforce —
		// auto-approve-once so the turn is never blocked.
		if (this.isShadowMode()) {
			this.log?.(
				`[ide-agent] approval SHADOW (not enforced): "${title}" ` +
				`reasons=[${reasons.join('; ')}] → auto approve-once`,
			);
			return Promise.resolve({ optionId: 'approve-once' });
		}
		this.current = request;
		this.emitter.fire(request);
		return new Promise<ApprovalResult>((resolve) => {
			this.pending.set(approvalId, { request, resolve, allowlistKey: identityKey });
			const timer = setTimeout(() => {
				this.timers.delete(approvalId);
				this.resolveApproval(approvalId, undefined);
			}, timeoutMs);
			// A 5-minute timer must not keep the workbench alive on its own.
			if (typeof timer === 'object' && timer !== null && typeof (timer as unknown as { unref?: unknown }).unref === 'function') {
				(timer as unknown as { unref(): void }).unref();
			}
			this.timers.set(approvalId, timer);
		});
	}

	resolveApproval(approvalId: string, result: ApprovalResult): void {
		const entry = this.pending.get(approvalId);
		if (!entry) {
			return;
		}
		this.resolveEntry(approvalId, entry, result);
	}

	/**
	 * P2-4 rework (QA-CHATTABS Round B): resolve a pending approval by the
	 * card's toolCallId (`tc-<permission-request-id>`) instead of the
	 * internal `approval-N` id. Used when answering a clarifying-question
	 * widget: the turn events only carry the card's toolCallId (linked via
	 * the questionApproval event), never the approval-N id. No-op when no
	 * pending approval matches (card already resolved / timed out).
	 */
	resolveApprovalForToolCall(toolCallId: string, result: ApprovalResult): void {
		for (const [approvalId, entry] of this.pending) {
			if (entry.request.toolCallId === toolCallId) {
				this.resolveEntry(approvalId, entry, result);
				return;
			}
		}
	}

	private resolveEntry(
		approvalId: string,
		entry: { request: ApprovalRequest; resolve: (result: ApprovalResult) => void; allowlistKey: string },
		result: ApprovalResult,
	): void {
		// 24h TTL: an "Approve and allowlist" decision is remembered so the
		// same tool identity does not re-prompt within the TTL.
		if (result?.optionId === 'approve-allowlist') {
			this.allowlistStore.set(entry.allowlistKey, { approvedAt: Date.now() });
		}
		const timer = this.timers.get(approvalId);
		if (timer !== undefined) {
			clearTimeout(timer);
			this.timers.delete(approvalId);
		}
		this.pending.delete(approvalId);
		if (this.current?.approvalId === approvalId) {
			this.current = undefined;
		}
		this.emitter.fire(undefined);
		entry.resolve(result);
	}

	/**
	 * Settle all pending approvals as undefined (skip). Used when the chat
	 * view is disposed so turns don't hang forever.
	 */
	settleAllPending(): void {
		const ids = [...this.pending.keys()];
		for (const id of ids) {
			this.resolveApproval(id, undefined);
		}
	}

	pendingCount(): number {
		return this.pending.size;
	}

	// ---- per-bubble review models (approval-review-kinds parity) ----

	private reviewModelKey(handle: string, bubbleId: string): string {
		return `${handle}:${bubbleId}`;
	}

	/**
	 * Get (creating on first call) the review model for one bubble of the
	 * given kind. OBSERVED (binary): terminal tool RUN_TERMINAL_COMMAND_V2
	 * auto-selects RUN at model creation; EDIT default-selected = ACCEPT
	 * (OBSERVED, §5.1). The auto-select applies once, at creation — a later
	 * user choice is never overwritten.
	 */
	getReviewModelForBubble(kind: HumanReviewKind, handle: string, bubbleId: string, toolName?: string): ToolCallReviewModel {
		const key = this.reviewModelKey(handle, bubbleId);
		let model = this.reviewModels.get(key);
		if (!model) {
			model = new ToolCallReviewModel();
			if (kind === 'terminal' && toolName === RUN_TERMINAL_COMMAND_V2) {
				model.setSelectedOption(TerminalReviewOption.RUN);
			} else if (kind === 'edit') {
				model.setSelectedOption(EditReviewOption.ACCEPT);
			}
			this.reviewModels.set(key, model);
		}
		return model;
	}

	/**
	 * The options the review card currently displays for a kind.
	 * OBSERVED (binary, §5.1) for edit:
	 *   [ACCEPT, REJECT_AND_TELL_WHAT_TO_DO_DIFFERENTLY, SWITCH_TO_DEFAULT_AGENT_MODE]
	 * UNKNOWN for terminal|mcp|configuration (the auditor captured their
	 * enums but not the displayed subset) — those kinds fall back to the full
	 * enum list so nothing invented is hidden as observed.
	 */
	getCurrentlyDisplayedOptions(kind: HumanReviewKind): string[] {
		switch (kind) {
			case 'edit':
				return [
					EditReviewOption.ACCEPT,
					EditReviewOption.REJECT_AND_TELL_WHAT_TO_DO_DIFFERENTLY,
					EditReviewOption.SWITCH_TO_DEFAULT_AGENT_MODE,
				];
			case 'terminal':
				return [
					TerminalReviewOption.RUN,
					TerminalReviewOption.SKIP,
					TerminalReviewOption.ALLOWLIST_COMMANDS,
					TerminalReviewOption.REJECT_AND_TELL_WHAT_TO_DO_DIFFERENTLY,
				];
			case 'mcp':
				return [
					McpReviewOption.RUN,
					McpReviewOption.SKIP,
					McpReviewOption.REJECT_AND_TELL_WHAT_TO_DO_DIFFERENTLY,
					McpReviewOption.ALLOWLIST_TOOL,
				];
			case 'configuration':
				return [];
		}
	}

	/**
	 * Select an option on a bubble's terminal review model with Cursor's
	 * status side-effect: RUN/ALLOWLIST_COMMANDS/SKIP set the review status
	 * DONE (OBSERVED, §5.1). Status literal "done" is observed here; the
	 * full status vocabulary remains UNKNOWN. REJECT opens the feedback
	 * input instead of finishing the review.
	 */
	selectTerminalOptionForBubble(handle: string, bubbleId: string, option: TerminalReviewOption): void {
		const model = this.reviewModels.get(this.reviewModelKey(handle, bubbleId));
		if (!model) {
			return;
		}
		model.setSelectedOption(option);
		if (
			option === TerminalReviewOption.RUN ||
			option === TerminalReviewOption.ALLOWLIST_COMMANDS ||
			option === TerminalReviewOption.SKIP
		) {
			model.status = 'done';
		} else if (option === TerminalReviewOption.REJECT_AND_TELL_WHAT_TO_DO_DIFFERENTLY) {
			model.setIsShowingInput(true);
		}
	}

	/**
	 * Per-bubble model lifecycle.
	 * OURS (binary lifecycle not deeply dissected — auditor: "needs deeper
	 * dissection"). Removes one bubble's review model; call when the bubble
	 * is unmounted so models do not leak. Full `dispose()` also clears all
	 * models when the composer is disposed.
	 */
	disposeReviewModelForBubble(handle: string, bubbleId: string): void {
		this.reviewModels.delete(this.reviewModelKey(handle, bubbleId));
	}

	/** Open the REJECT feedback input on a bubble's review model (no-op when absent). */
	setIsShowingInputForBubble(handle: string, bubbleId: string, show: boolean): void {
		this.reviewModels.get(this.reviewModelKey(handle, bubbleId))?.setIsShowingInput(show);
	}

	getTerminalReviewModelForBubble(handle: string, bubbleId: string, toolName?: string): ToolCallReviewModel {
		return this.getReviewModelForBubble('terminal', handle, bubbleId, toolName);
	}

	getEditReviewModelForBubble(handle: string, bubbleId: string): ToolCallReviewModel {
		return this.getReviewModelForBubble('edit', handle, bubbleId);
	}

	getMcpReviewModelForBubble(handle: string, bubbleId: string): ToolCallReviewModel {
		return this.getReviewModelForBubble('mcp', handle, bubbleId);
	}

	/** Binary-verbatim casing alias for getMcpReviewModelForBubble (see interface). */
	getMCPReviewModelForBubble(handle: string, bubbleId: string): ToolCallReviewModel {
		return this.getMcpReviewModelForBubble(handle, bubbleId);
	}

	/** Binary API shape: `setSelectedOption(...)` on a bubble's review model. */
	setSelectedOptionForBubble(handle: string, bubbleId: string, option: string): void {
		this.reviewModels.get(this.reviewModelKey(handle, bubbleId))?.setSelectedOption(option);
	}

	override dispose(): void {
		for (const timer of this.timers.values()) {
			clearTimeout(timer);
		}
		this.timers.clear();
		this.pending.clear();
		this.reviewModels.clear();
		super.dispose();
	}
}

/**
 * Binary-parity alias: Cursor's `toolCallHumanReviewService`
 * (workbench.glass.main.js 3.25.6, ×20 hits). Same per-composer class, same
 * per-bubble models — the name mirrors the binary's registration.
 */
export const ToolCallHumanReviewService = HumanReviewService;
export type IToolCallHumanReviewService = IHumanReviewService;
