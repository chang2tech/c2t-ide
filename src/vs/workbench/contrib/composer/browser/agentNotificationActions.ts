/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// GAPS-152 (`agent-notification-actions`): workbench bridge for Cursor's
// agent OS notifications. Binary layering (Cursor 3.25.9, see
// docs/rea/work-notes-gaps152.md): a renderer-side
// `systemNotificationRendererService` (desk@16932664) delegates over the
// `systemNotification` IPC channel to the main process, which shows an
// Electron Notification and reports the user's click / button press
// back; the workbench then executes the payload's `clickAction` /
// `actionCommands` (command handlers registered via CommandsRegistry
// `xi.registerCommand` @29946768 — NOT Action2, no palette titles).
//
// Fork mapping (same layers, existing transport): IHostService.showToast
// is this fork's per-window path to the same main-process Electron
// Notification (INativeHostService.showToast →
// nativeHostMainService.showToast, with click/actionIndex/dedupe), so
// this contribution plays the renderer-service role:
//   - registers the fork-internal bridge command
//     `composer.showAgentSystemNotification`, which the ide-agent
//     extension calls with the verbatim payload (common/agentNotifications.ts);
//     it shows the toast and routes the outcome back to the payload's
//     command, resolving to whether the notification was shown (the
//     binary's showNotification promise resolution drives its
//     `systemNotification.shown` analytics the same way);
//   - registers the three verbatim local command ids, delegating to the
//     extension runtime (`ide.*FromNotification`) — the fork's standing
//     core→extension delegation idiom for `composer.*` commands (cf.
//     ComposerAcceptComposerStepAction → ide.acceptComposerStep). The
//     binary handlers themselves live in the runtime that owns the
//     composer state; here that runtime is the extension.
// The cloud pair (approveCloud/denyCloudApprovalFromNotification) is
// intentionally NOT registered: separate matrix entry, no cloud-agent
// backend in the fork (HONEST-DIVERGENCE, work-notes §8).

import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IHostService } from '../../../services/host/browser/host.js';
import {
	ACCEPT_PENDING_FROM_NOTIFICATION_COMMAND_ID,
	IAgentSystemNotificationRequest,
	OPEN_COMPOSER_FROM_NOTIFICATION_COMMAND_ID,
	REJECT_PENDING_FROM_NOTIFICATION_COMMAND_ID,
	SHOW_AGENT_SYSTEM_NOTIFICATION_COMMAND_ID,
	resolveNotificationCommand,
} from '../common/agentNotifications.js';

/** Extension-runtime counterparts (registered by ide-agent's COMMANDS table). */
const IDE_OPEN_COMPOSER_FROM_NOTIFICATION = 'ide.openComposerFromNotification';
const IDE_ACCEPT_PENDING_FROM_NOTIFICATION = 'ide.acceptPendingFromNotification';
const IDE_REJECT_PENDING_FROM_NOTIFICATION = 'ide.rejectPendingFromNotification';

function isNotificationRequest(value: unknown): value is IAgentSystemNotificationRequest {
	if (value === null || typeof value !== 'object') {
		return false;
	}
	const request = value as { title?: unknown; body?: unknown };
	return typeof request.title === 'string' && typeof request.body === 'string';
}

export class AgentNotificationBridgeContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.composer.agentNotifications';

	constructor(
		@IHostService private readonly hostService: IHostService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();

		// Verbatim notification commands (binary: CommandsRegistry
		// @29946768, no title/f1). Each forwards its raw argument
		// (string | {composerId, source?} / {composerId}) untouched to
		// the extension runtime handler, like the binary handler reads
		// it off the notification payload.
		this._register(CommandsRegistry.registerCommand(OPEN_COMPOSER_FROM_NOTIFICATION_COMMAND_ID, async (_accessor, arg?: unknown) => {
			await this.commandService.executeCommand(IDE_OPEN_COMPOSER_FROM_NOTIFICATION, arg);
		}));
		this._register(CommandsRegistry.registerCommand(ACCEPT_PENDING_FROM_NOTIFICATION_COMMAND_ID, async (_accessor, arg?: unknown) => {
			await this.commandService.executeCommand(IDE_ACCEPT_PENDING_FROM_NOTIFICATION, arg);
		}));
		this._register(CommandsRegistry.registerCommand(REJECT_PENDING_FROM_NOTIFICATION_COMMAND_ID, async (_accessor, arg?: unknown) => {
			await this.commandService.executeCommand(IDE_REJECT_PENDING_FROM_NOTIFICATION, arg);
		}));

		// Fork-internal bridge: show the OS notification for a verbatim
		// payload and route the user's response to its command.
		this._register(CommandsRegistry.registerCommand(SHOW_AGENT_SYSTEM_NOTIFICATION_COMMAND_ID, async (_accessor, request?: unknown) => {
			return this.showAgentSystemNotification(request);
		}));
	}

	/**
	 * Show one agent OS notification. Returns whether it was shown
	 * (supported and not dedupe-suppressed), mirroring the binary's
	 * promise resolution. Never rejects: a failed toast or a failed
	 * routed command must not break the producing agent event.
	 */
	private async showAgentSystemNotification(request: unknown): Promise<boolean> {
		if (!isNotificationRequest(request)) {
			return false;
		}
		const cts = new CancellationTokenSource();
		try {
			const result = await this.hostService.showToast({
				title: request.title,
				body: request.body,
				silent: request.silent,
				actions: request.actions?.map(action => action.text),
				dedupeKey: request.dedupeKey,
			}, cts.token);
			const command = resolveNotificationCommand(request, result);
			if (command) {
				try {
					await this.commandService.executeCommand(command.commandId, command.args);
				} catch {
					// The routed command's owner may be gone (e.g. the
					// extension restarted); the notification itself was
					// still shown and answered.
				}
			}
			return result.supported && !result.suppressed;
		} catch {
			return false;
		} finally {
			cts.dispose();
		}
	}
}
