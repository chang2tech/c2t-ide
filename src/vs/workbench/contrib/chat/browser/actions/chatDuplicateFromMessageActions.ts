/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize2 } from '../../../../../nls.js';
import { MenuId } from '../../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { ChatContextKeyExprs, ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { CHAT_CATEGORY } from './chatActions.js';
import { ForkConversationAction } from './chatForkActions.js';

export const DuplicateChatFromMessageActionId = 'workbench.action.chat.duplicateChatFromMessage';

/**
 * "Duplicate Chat" — shown in the message hover "..." overflow menu.
 *
 * Mirrors Cursor's per-message "Duplicate Chat" (Cursor staff: "three dots on the
 * message → Duplicate Chat. This creates a branch from that point without losing
 * context."). It creates a new chat tab containing the conversation history up to
 * AND INCLUDING the selected message, then continues from there.
 *
 * Label source: Cursor staff post on forum.cursor.com
 * (t/reverting-changes-does-not-reset-the-context/148549, deanrie, 2026-01-11).
 * The Cursor 3.25.9 bundles were checked for a verbatim label: the command id
 * `composer.duplicateChat` exists (category `chat_management`) and its
 * implementation forks from a bubble retaining transcript history, but no
 * verbatim menu-label string was found in the searchable bundles, so the staff
 * post's wording is used verbatim here.
 */
export class DuplicateChatFromMessageAction extends ForkConversationAction {
	constructor() {
		super({
			id: DuplicateChatFromMessageActionId,
			title: localize2('chat.duplicateChatFromMessage.label', "Duplicate Chat"),
			tooltip: localize2('chat.duplicateChatFromMessage.tooltip', "Duplicate chat from this message"),
			f1: false,
			category: CHAT_CATEGORY,
			precondition: ContextKeyExpr.and(ChatContextKeys.enabled, ChatContextKeys.readOnly.negate()),
			menu: [
				{
					id: MenuId.ChatMessageTitle,
					// Non-'navigation' group: renders in the message hover "..." overflow
					// menu instead of as an inline icon button.
					group: 'duplicate',
					order: 1,
					when: ContextKeyExpr.and(
						ContextKeyExpr.or(ChatContextKeys.isRequest, ChatContextKeys.isResponse),
						ContextKeyExpr.or(
							ContextKeyExpr.or(ChatContextKeys.lockedToCodingAgent.negate(), ChatContextKeyExprs.isAgentHostSession),
							ChatContextKeys.chatSessionSupportsFork
						),
						ChatContextKeys.readOnly.negate()
					)
				}
			]
		});
	}

	protected override _getForkTargetRequestIndex(_isRequestItem: boolean, requestIndex: number): number {
		// Unlike the checkpoint fork (which branches from the checkpoint BEFORE the
		// selected request), Duplicate Chat keeps the conversation up to AND
		// INCLUDING the selected message.
		return requestIndex;
	}
}
