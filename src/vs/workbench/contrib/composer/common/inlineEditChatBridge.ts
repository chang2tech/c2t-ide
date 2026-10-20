/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Chat-surface bridge for the core inline-edit flow (common layer).
//
// The workbench-core `IInlineEditService` (electron-browser/) owns the Cmd+K
// session, but the agent chat surface itself is owned by the ide-agent
// extension (its composer webview). This contract is the DI seam between them:
// the core service calls `prefillChat` to escalate an inline prompt ("Send to
// Chat" mode / `composer.sendToAgent`) into a full agent turn. The browser
// implementation (`browser/inlineEditChatBridge.ts`) routes through the
// extension command `ide.submitInlinePromptToChat`, which submits the text to
// the active composer and focuses the chat surface — identical behavior to the
// extension's own inline-edit `prefillChat`.

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export interface IInlineEditChatBridge {
	readonly _serviceBrand: undefined;

	/**
	 * Submit the prepared prompt to the agent chat as a full agent turn and
	 * focus the chat surface.
	 */
	prefillChat(text: string): Promise<void>;
}

export const IInlineEditChatBridge = createDecorator<IInlineEditChatBridge>('composerInlineEditChatBridge');
