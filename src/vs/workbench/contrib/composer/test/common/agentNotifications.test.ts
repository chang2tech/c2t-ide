/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * GAPS-152 (`agent-notification-actions`) — pure-logic tests for
 * common/agentNotifications.ts, pinned to self-verified Cursor 3.25.9
 * binary evidence (workbench.desktop.main.js):
 *  - command id table @14002285 (verbatim ids);
 *  - completed payload @31367250, pending payload @31370281,
 *    pending-info copy @31367568 (140-char truncation);
 *  - click routing `jR_` @18585962 and suppression `YOh` @18586314;
 *  - outcome routing: actionCommands[actionIndex] beats clickAction;
 *    a dismiss runs nothing.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
	ACCEPT_PENDING_FROM_NOTIFICATION_COMMAND_ID,
	APPROVE_CLOUD_APPROVAL_FROM_NOTIFICATION_COMMAND_ID,
	DENY_CLOUD_APPROVAL_FROM_NOTIFICATION_COMMAND_ID,
	OPEN_COMPOSER_FROM_NOTIFICATION_COMMAND_ID,
	REJECT_PENDING_FROM_NOTIFICATION_COMMAND_ID,
	SHOW_AGENT_SYSTEM_NOTIFICATION_COMMAND_ID,
	buildCompletedNotification,
	buildPendingNotification,
	completedNotificationSuppression,
	getPendingActionNotificationInfo,
	parseNotificationComposerId,
	parseNotificationSource,
	resolveNotificationCommand,
	routeNotificationComposerId,
} from '../../common/agentNotifications.js';

describe('agentNotifications (GAPS-152, Cursor 3.25.9 parity)', () => {
	it('verbatim command ids from the binary id table @14002285', () => {
		assert.equal(OPEN_COMPOSER_FROM_NOTIFICATION_COMMAND_ID, 'composer.openComposerFromNotification');
		assert.equal(ACCEPT_PENDING_FROM_NOTIFICATION_COMMAND_ID, 'composer.acceptPendingFromNotification');
		assert.equal(REJECT_PENDING_FROM_NOTIFICATION_COMMAND_ID, 'composer.rejectPendingFromNotification');
		assert.equal(APPROVE_CLOUD_APPROVAL_FROM_NOTIFICATION_COMMAND_ID, 'composer.approveCloudApprovalFromNotification');
		assert.equal(DENY_CLOUD_APPROVAL_FROM_NOTIFICATION_COMMAND_ID, 'composer.denyCloudApprovalFromNotification');
		// Fork-internal bridge id (not a Cursor id).
		assert.equal(SHOW_AGENT_SYSTEM_NOTIFICATION_COMMAND_ID, 'composer.showAgentSystemNotification');
	});

	it('completed payload is verbatim (title/body/silent/clickAction only)', () => {
		const named = buildCompletedNotification({ composerId: 'c1', name: 'Refactor auth' });
		assert.equal(named.title, 'Done \u2022 Refactor auth');
		assert.equal(named.body, "Open Cursor to view the agent's output.");
		assert.equal(named.silent, true);
		assert.deepEqual(named.clickAction, { commandId: 'composer.openComposerFromNotification', args: { composerId: 'c1' } });
		assert.equal(named.actions, undefined);
		assert.equal(named.actionCommands, undefined);
		const unnamed = buildCompletedNotification({ composerId: 'c1', name: '   ' });
		assert.equal(unnamed.title, 'Agent complete');
		const stopped = buildCompletedNotification({ composerId: 'c1', source: 'composer.notifications.extensionHostExited' });
		assert.deepEqual(stopped.clickAction?.args, { composerId: 'c1', source: 'composer.notifications.extensionHostExited' });
	});

	it('pending payload: critical + Accept/Reject + raw-id actions, routed-id click', () => {
		const info = getPendingActionNotificationInfo({ kind: 'other', groupCount: 1 });
		const pending = buildPendingNotification({ composerId: 'raw', clickComposerId: 'parent', info, silent: false });
		assert.equal(pending.urgency, 'critical');
		assert.deepEqual(pending.actions, [{ type: 'button', text: 'Accept' }, { type: 'button', text: 'Reject' }]);
		assert.deepEqual(pending.clickAction?.args, { composerId: 'parent' });
		assert.deepEqual(pending.actionCommands?.[0], { commandId: 'composer.acceptPendingFromNotification', args: { composerId: 'raw' } });
		assert.deepEqual(pending.actionCommands?.[1], { commandId: 'composer.rejectPendingFromNotification', args: { composerId: 'raw' } });
	});

	it('pending info copy per tool family (desk@31367568)', () => {
		assert.deepEqual(getPendingActionNotificationInfo({ kind: 'other', groupCount: 1 }), {
			title: 'Approve pending action',
			body: 'Return to Cursor to review and approve.',
			toolType: undefined,
		});
		const term = getPendingActionNotificationInfo({ kind: 'terminal', groupCount: 1, command: 'npm run build' });
		assert.equal(term.title, 'Approve terminal command');
		assert.equal(term.body, 'Approval required to run: npm run build');
		const long = getPendingActionNotificationInfo({ kind: 'terminal', groupCount: 1, command: 'y'.repeat(141) });
		assert.equal(long.body, `Approval required to run: ${'y'.repeat(140)}...`);
		const editOne = getPendingActionNotificationInfo({ kind: 'edit', groupCount: 1, relativePath: 'src/x/y.ts' });
		assert.equal(editOne.body, 'Approval required to edit: y.ts');
		// Binary quirk, pinned verbatim (GAPS-165, QA-160 P3): the
		// basename is `l.split("/").pop() || l.split("\\").pop() || l` —
		// for a backslash path the first pop() already returns the whole
		// (truthy) string, so the binary shows the FULL path.
		const editWin = getPendingActionNotificationInfo({ kind: 'edit', groupCount: 1, relativePath: 'src\\deep\\file.ts' });
		assert.equal(editWin.body, 'Approval required to edit: src\\deep\\file.ts');
		const editMany = getPendingActionNotificationInfo({ kind: 'edit', groupCount: 2 });
		assert.equal(editMany.title, 'Approve 2 file edits');
		const del = getPendingActionNotificationInfo({ kind: 'delete', groupCount: 1 });
		assert.equal(del.body, 'Return to Cursor to review and approve file deletion.');
		const mcp = getPendingActionNotificationInfo({ kind: 'mcp', groupCount: 1, mcpToolName: 'fetch' });
		assert.equal(mcp.body, 'Approval required for MCP tool: fetch');
		const question = getPendingActionNotificationInfo({ kind: 'question', groupCount: 1, questionPrompt: 'Pick one' });
		assert.equal(question.title, 'Input needed \u2022 Pick one');
	});

	it('routeNotificationComposerId ports jR_ (parent wins for subagents)', () => {
		assert.equal(routeNotificationComposerId('sub', 'parent'), 'parent');
		assert.equal(routeNotificationComposerId('sub', ' '), 'sub');
		assert.equal(routeNotificationComposerId('sub'), 'sub');
	});

	it('resolveNotificationCommand: action beats click; dismiss runs nothing', () => {
		const info = getPendingActionNotificationInfo({ kind: 'other', groupCount: 1 });
		const pending = buildPendingNotification({ composerId: 'raw', info, silent: false });
		assert.equal(resolveNotificationCommand(pending, { clicked: true, actionIndex: 1 })?.commandId, 'composer.rejectPendingFromNotification');
		assert.equal(resolveNotificationCommand(pending, { clicked: true, actionIndex: 0 })?.commandId, 'composer.acceptPendingFromNotification');
		assert.equal(resolveNotificationCommand(pending, { clicked: true })?.commandId, 'composer.openComposerFromNotification');
		assert.equal(resolveNotificationCommand(pending, { clicked: false }), undefined);
		assert.equal(resolveNotificationCommand(pending, { clicked: false, actionIndex: 9 }), undefined);
	});

	it('completedNotificationSuppression ports YOh check order (desk@18586314)', () => {
		const base = {
			statusCompleted: true,
			isSubagentTurn: false,
			isArchived: false,
			queuedCount: 0,
			foregroundToolsRunning: false,
			backgroundSubagentsRunning: false,
			goalContinuing: false,
		};
		assert.equal(completedNotificationSuppression(base), undefined);
		assert.equal(completedNotificationSuppression({ ...base, statusCompleted: false }), 'turn-not-completed');
		assert.equal(completedNotificationSuppression({ ...base, isSubagentTurn: true }), 'subagent-turn');
		assert.equal(completedNotificationSuppression({ ...base, isArchived: true }), 'composer-archived');
		assert.equal(completedNotificationSuppression({ ...base, queuedCount: 1 }), 'queued-messages');
		assert.equal(completedNotificationSuppression({ ...base, foregroundToolsRunning: true }), 'foreground-tools-running');
		assert.equal(completedNotificationSuppression({ ...base, backgroundSubagentsRunning: true }), 'background-subagents-running');
		assert.equal(completedNotificationSuppression({ ...base, goalContinuing: true }), 'goal-continuing');
	});

	it('arg parsing ports the binary handler rule (string | {composerId, source})', () => {
		assert.equal(parseNotificationComposerId('c1'), 'c1');
		assert.equal(parseNotificationComposerId({ composerId: 'c1' }), 'c1');
		assert.equal(parseNotificationComposerId({ composerId: 7 }), undefined);
		assert.equal(parseNotificationComposerId(undefined), undefined);
		assert.equal(parseNotificationSource({ source: 'composer.notifications.pendingAction' }), 'composer.notifications.pendingAction');
		assert.equal(parseNotificationSource('c1'), undefined);
	});
});
