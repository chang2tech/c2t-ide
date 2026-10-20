/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// GAPS-152 (`agent-notification-actions`): pure payload / routing logic for
// Cursor's agent OS notifications — the canonical copy. The ide-agent
// extension carries a mirrored copy in `services/agentNotifications.ts`
// (the two compile units cannot import each other; same precedent as
// chime.ts, which exists in both core and the extension).
//
// Binary evidence (Cursor 3.25.9, workbench.desktop.main.js, self-sliced
// in GAPS-152; full dissect in docs/rea/work-notes-gaps152.md):
//  - Command id table @14002285:
//      RBu="composer.openComposerFromNotification",
//      FYs="composer.acceptPendingFromNotification",
//      BYs="composer.rejectPendingFromNotification",
//      MBu="composer.approveCloudApprovalFromNotification",
//      DBu="composer.denyCloudApprovalFromNotification"
//  - Completed producer (capability class `ik`, fs.NOTIFICATIONS)
//    `onChatStreamFinished` @31367250 and pending producer
//    `onAddPendingAction` + `getPendingActionNotificationInfo` @31367568:
//    verbatim showNotification payloads ported below.
//  - Subagent click routing `jR_` @18585962 and suppression helper `YOh`
//    @18586314.
//  - The cloud pair (MBu/DBu) is declared here for id parity only: its
//    producers/handlers belong to the separate matrix entry
//    `agent-cloud-approval-notification` and the fork has no cloud-agent
//    backend, so no handler is registered for them (HONEST-DIVERGENCE,
//    see work-notes-gaps152.md §8).

/** Verbatim binary command ids (desk@14002285). */
export const OPEN_COMPOSER_FROM_NOTIFICATION_COMMAND_ID = 'composer.openComposerFromNotification';
export const ACCEPT_PENDING_FROM_NOTIFICATION_COMMAND_ID = 'composer.acceptPendingFromNotification';
export const REJECT_PENDING_FROM_NOTIFICATION_COMMAND_ID = 'composer.rejectPendingFromNotification';
export const APPROVE_CLOUD_APPROVAL_FROM_NOTIFICATION_COMMAND_ID = 'composer.approveCloudApprovalFromNotification';
export const DENY_CLOUD_APPROVAL_FROM_NOTIFICATION_COMMAND_ID = 'composer.denyCloudApprovalFromNotification';

/**
 * Fork-internal bridge command (NOT a Cursor id): the ide-agent extension
 * calls it with an {@link IAgentSystemNotificationRequest}; the workbench
 * bridge (browser/agentNotificationActions.ts) shows the OS notification
 * through IHostService.showToast (Electron Notification in the main
 * process — the fork's existing analog of Cursor's `systemNotification`
 * IPC channel) and routes the user's click / button press back to
 * `clickAction` / `actionCommands`, exactly like Cursor's main-process
 * service does. Resolves to whether the notification was shown.
 */
export const SHOW_AGENT_SYSTEM_NOTIFICATION_COMMAND_ID = 'composer.showAgentSystemNotification';

/** A command invocation carried by a notification (binary `{commandId, args}`). */
export interface IAgentNotificationCommandAction {
	readonly commandId: string;
	readonly args?: unknown;
}

/** One action button (binary `{type:"button", text}`). */
export interface IAgentNotificationAction {
	readonly type: 'button';
	readonly text: string;
}

/**
 * The binary `systemNotificationService.showNotification(...)` payload
 * shape (desk@31367250/@31370281), minus `windowId` (the fork's
 * IHostService is already per-window) — see the bridge for the mapping.
 */
export interface IAgentSystemNotificationRequest {
	readonly title: string;
	readonly body: string;
	readonly silent?: boolean;
	readonly urgency?: string;
	readonly timeoutType?: string;
	readonly clickAction?: IAgentNotificationCommandAction;
	readonly actions?: readonly IAgentNotificationAction[];
	/** Keyed by action index, as in the binary (`{0:{...},1:{...}}`). */
	readonly actionCommands?: Readonly<Record<number, IAgentNotificationCommandAction>>;
	readonly dedupeKey?: string;
}

/**
 * Binary `jR_` @18585962 — the composer id a notification CLICK opens:
 * for a subagent composer (subagentInfo present, not a Best-of-N
 * subcomposer) the click routes to the PARENT composer; anything else
 * routes to the composer itself. (Accept/Reject actionCommands keep the
 * RAW id — the asymmetry is the binary's, see buildPendingNotification.)
 */
export function routeNotificationComposerId(composerId: string, subagentParentComposerId?: string): string {
	const parent = subagentParentComposerId?.trim();
	return parent ? parent : composerId;
}

/** Args of the open-composer notification command (binary: string | object). */
export interface IOpenComposerFromNotificationArgs {
	readonly composerId: string;
	readonly source?: string;
}

/** Normalize the binary handler's `typeof t=="string" ? t : t?.composerId` arg rule (desk@29946768). */
export function parseNotificationComposerId(arg: unknown): string | undefined {
	if (typeof arg === 'string') {
		return arg ? arg : undefined;
	}
	if (arg !== null && typeof arg === 'object') {
		const composerId = (arg as { composerId?: unknown }).composerId;
		return typeof composerId === 'string' && composerId ? composerId : undefined;
	}
	return undefined;
}

/** The optional `source` of an open-composer arg object (binary: `t?.source`). */
export function parseNotificationSource(arg: unknown): string | undefined {
	if (arg !== null && typeof arg === 'object') {
		const source = (arg as { source?: unknown }).source;
		return typeof source === 'string' && source ? source : undefined;
	}
	return undefined;
}

/**
 * Verbatim completed-turn payload (desk@31367250):
 *   title = name ? `Done \u2022 ${name}` : "Agent complete"
 *   body  = "Open Cursor to view the agent's output."
 *   silent:!0, clickAction open {composerId} — no actions.
 * `source` is set only by the extension-host-exited producer
 * (desk@31941598, args {composerId, source:"composer.notifications.extensionHostExited"}).
 */
export function buildCompletedNotification(input: {
	readonly composerId: string;
	readonly name?: string;
	readonly source?: string;
}): IAgentSystemNotificationRequest {
	const name = input.name?.trim() ? input.name : undefined;
	return {
		title: name ? `Done \u2022 ${name}` : 'Agent complete',
		body: "Open Cursor to view the agent's output.",
		silent: true,
		clickAction: {
			commandId: OPEN_COMPOSER_FROM_NOTIFICATION_COMMAND_ID,
			args: input.source !== undefined
				? { composerId: input.composerId, source: input.source }
				: { composerId: input.composerId },
		},
	};
}

/** Tool families of `getPendingActionNotificationInfo` (binary `toolType`). */
export type PendingNotificationToolKind = 'terminal' | 'edit' | 'delete' | 'mcp' | 'question' | 'other';

export interface IPendingActionNotificationInfoInput {
	readonly kind: PendingNotificationToolKind;
	/** Number of decisions in the pending group (binary: group length). */
	readonly groupCount: number;
	/** Terminal: the full command text (binary truncates it). */
	readonly command?: string;
	/** Edit/delete: workspace-relative path (binary shows its basename). */
	readonly relativePath?: string;
	/** MCP: the tool name. */
	readonly mcpToolName?: string;
	/** Question: the first question's prompt. */
	readonly questionPrompt?: string;
}

export interface IPendingActionNotificationInfo {
	readonly title: string;
	readonly body: string;
	readonly toolType: PendingNotificationToolKind | undefined;
}

/** Binary basename: `l.split("/").pop() || l.split("\\").pop() || l`. */
function pendingBasename(path: string): string {
	return path.split('/').pop() || path.split('\\').pop() || path;
}

/**
 * Verbatim port of `getPendingActionNotificationInfo()` (desk@31367568),
 * driven by the FIRST decision of the pending group. All strings —
 * including the 140-char terminal-command truncation — are the binary's.
 */
export function getPendingActionNotificationInfo(input: IPendingActionNotificationInfoInput): IPendingActionNotificationInfo {
	let title = 'Approve pending action';
	let body = 'Return to Cursor to review and approve.';
	let toolType: PendingNotificationToolKind | undefined = undefined;
	switch (input.kind) {
		case 'terminal': {
			const command = input.command;
			if (command) {
				const trimmed = command.trim().slice(0, 140);
				title = 'Approve terminal command';
				body = `Approval required to run: ${trimmed}${command.length > 140 ? '...' : ''}`;
				toolType = 'terminal';
			}
			break;
		}
		case 'edit': {
			toolType = 'edit';
			if (input.groupCount === 1) {
				title = 'Approve file edit';
				if (input.relativePath) {
					body = `Approval required to edit: ${pendingBasename(input.relativePath)}`;
				} else {
					body = 'Return to Cursor to review and approve file changes.';
				}
			} else {
				title = `Approve ${input.groupCount} file edits`;
				body = `Return to Cursor to review and approve ${input.groupCount} file changes.`;
			}
			break;
		}
		case 'delete': {
			toolType = 'delete';
			title = 'Approve file deletion';
			if (input.relativePath) {
				body = `Approval required to delete: ${pendingBasename(input.relativePath)}`;
			} else {
				body = 'Return to Cursor to review and approve file deletion.';
			}
			break;
		}
		case 'mcp': {
			toolType = 'mcp';
			title = 'Approve MCP tool';
			body = input.mcpToolName
				? `Approval required for MCP tool: ${input.mcpToolName}`
				: 'Return to Cursor to review and approve the MCP tool execution.';
			break;
		}
		case 'question': {
			toolType = 'question';
			const prompt = input.questionPrompt?.trim() ? input.questionPrompt.trim() : '';
			title = prompt ? `Input needed \u2022 ${prompt}` : 'Input needed';
			body = "Open Cursor to answer the agent's questions.";
			break;
		}
		default:
			break;
	}
	return { title, body, toolType };
}

/**
 * Verbatim pending-decision payload (desk@31370281):
 *   urgency:"critical", actions [Accept, Reject],
 *   clickAction args {composerId: ROUTED id} (jR_),
 *   actionCommands 0→accept / 1→reject with args {composerId: RAW id}.
 * `silent` is the binary's `createdFromLocalScheduledTask !== void 0`
 * result, computed by the caller (the fork has no scheduled-task
 * composers, so callers pass false).
 */
export function buildPendingNotification(input: {
	readonly composerId: string;
	/** jR_-routed id for the click (defaults to composerId). */
	readonly clickComposerId?: string;
	readonly info: IPendingActionNotificationInfo;
	readonly silent: boolean;
}): IAgentSystemNotificationRequest {
	return {
		title: input.info.title,
		body: input.info.body,
		urgency: 'critical',
		silent: input.silent,
		clickAction: {
			commandId: OPEN_COMPOSER_FROM_NOTIFICATION_COMMAND_ID,
			args: { composerId: input.clickComposerId ?? input.composerId },
		},
		actions: [
			{ type: 'button', text: 'Accept' },
			{ type: 'button', text: 'Reject' },
		],
		actionCommands: {
			0: { commandId: ACCEPT_PENDING_FROM_NOTIFICATION_COMMAND_ID, args: { composerId: input.composerId } },
			1: { commandId: REJECT_PENDING_FROM_NOTIFICATION_COMMAND_ID, args: { composerId: input.composerId } },
		},
	};
}

/** The subset of the host toast result the routing decision needs. */
export interface INotificationToastOutcome {
	readonly clicked: boolean;
	readonly actionIndex?: number;
}

/**
 * Cursor's main-process routing, as observed from the payload contract:
 * a button press runs `actionCommands[actionIndex]`; a plain click runs
 * `clickAction`; a dismiss/close runs nothing. Returns the command to
 * execute, or undefined when the user dismissed the notification.
 */
export function resolveNotificationCommand(
	request: IAgentSystemNotificationRequest,
	outcome: INotificationToastOutcome,
): IAgentNotificationCommandAction | undefined {
	if (outcome.actionIndex !== undefined) {
		return request.actionCommands?.[outcome.actionIndex];
	}
	if (outcome.clicked) {
		return request.clickAction;
	}
	return undefined;
}

/**
 * Verbatim suppression helper `YOh` @18586314 for the completed
 * notification: returns the reason a "Done" notification must NOT fire,
 * or undefined when it may. Check order is the binary's. The fork's
 * callers pass the signals they honestly have (see the extension copy
 * for which YOh branches have no fork analog).
 */
export type CompletedNotificationSuppression =
	| 'turn-not-completed'
	| 'subagent-turn'
	| 'composer-archived'
	| 'queued-messages'
	| 'foreground-tools-running'
	| 'background-subagents-running'
	| 'goal-continuing';

export function completedNotificationSuppression(input: {
	readonly statusCompleted: boolean;
	readonly isSubagentTurn: boolean;
	readonly isArchived: boolean;
	readonly queuedCount: number;
	readonly foregroundToolsRunning: boolean;
	readonly backgroundSubagentsRunning: boolean;
	readonly goalContinuing: boolean;
}): CompletedNotificationSuppression | undefined {
	if (!input.statusCompleted) {
		return 'turn-not-completed';
	}
	if (input.isSubagentTurn) {
		return 'subagent-turn';
	}
	if (input.isArchived) {
		return 'composer-archived';
	}
	if (input.queuedCount > 0) {
		return 'queued-messages';
	}
	if (input.foregroundToolsRunning) {
		return 'foreground-tools-running';
	}
	if (input.backgroundSubagentsRunning) {
		return 'background-subagents-running';
	}
	if (input.goalContinuing) {
		return 'goal-continuing';
	}
	return undefined;
}
