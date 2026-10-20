/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Browser-layer `IInlineEditChatBridge`.
//
// The agent chat surface is owned by the ide-agent extension (composer
// webview), so the core inline-edit flow escalates through the extension
// command `ide.submitInlinePromptToChat` (registered in
// extensions/ide-agent/src/extension.ts): it submits the prepared prompt to
// the ACTIVE composer and focuses the chat surface — identical behavior to
// the extension's own inline-edit `prefillChat` before the core migration.

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IInlineEditChatBridge } from '../common/inlineEditChatBridge.js';

export class InlineEditChatBridge extends Disposable implements IInlineEditChatBridge {

	declare readonly _serviceBrand: undefined;

	constructor(
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();
	}

	async prefillChat(text: string): Promise<void> {
		await this.commandService.executeCommand('ide.submitInlinePromptToChat', text);
	}
}
