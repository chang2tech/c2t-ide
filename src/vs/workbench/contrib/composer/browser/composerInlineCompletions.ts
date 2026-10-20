/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Core port of the ide-agent Tab completion registration (CAT-D).
//
// Sources:
//   - `vscode.languages.registerInlineCompletionItemProvider(...)` in
//     extensions/ide-agent/src/tab/extension.ts `activate()`.
//   - `tab/provider.ts` (implements `vscode.InlineCompletionItemProvider`).
// Core equivalent: `ILanguageFeaturesService.inlineCompletionsProvider.register`
// (audit §3 mapping table).
//
// The core `InlineCompletionsProvider` shape differs from vscode's
// `InlineCompletionItemProvider`:
//   vscode:  provideInlineCompletionItems(document, position, context, token)
//            -> InlineCompletionItem[] | InlineCompletionList
//   core:    provideInlineCompletions(model: ITextModel, position: Position,
//            context: InlineCompletionContext, token: CancellationToken)
//            -> ProviderResult<InlineCompletions>
// The debounce/session logic in tab/provider.ts ports 1-1; only the provider
// shell and the registration change.

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { Position } from '../../../../editor/common/core/position.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { InlineCompletionContext, InlineCompletions, InlineCompletionsDisposeReason, InlineCompletionsProvider, ProviderResult } from '../../../../editor/common/languages.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';

/**
 * Core inline-completions provider for IDE Tab.
 *
 * TODO(composer): adapt the ported `tab/provider.ts` logic here:
 *   - debounce + session lifecycle (tab/session.ts, tab/debounce.ts — CAT-A, port 1-1)
 *   - backend call via the ported tab backend (tab/backend.ts)
 *   - per-language enablement from `ide.tab` config (IConfigurationService)
 *   - `setContext("ideAgent.tabEnabled")` -> IContextKeyService RawContextKey
 *   - snooze state from SnoozeManager (tab/snooze.ts)
 *   Return `undefined` when disabled/snoozed/no-backend so the editor shows
 *   nothing instead of faking a suggestion.
 */
export class ComposerInlineCompletionsProvider extends Disposable implements InlineCompletionsProvider {

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
	) {
		super();
		void this.contextKeyService;
	}

	async provideInlineCompletions(
		_model: ITextModel,
		_position: Position,
		_context: InlineCompletionContext,
		_token: CancellationToken
	): Promise<ProviderResult<InlineCompletions>> {
		// TODO(composer): port tab/provider.ts here (see class doc).
		const enabled = this.configurationService.getValue<boolean>('ide.tab.enabled') ?? true;
		if (!enabled) {
			return undefined;
		}
		void _model; void _position; void _context; void _token;
		return undefined;
	}

	// TODO(composer): port accept.ts fate tracking (handleItemDidShow) and the
	// partial-accept path (handlePartialAccept) when tab/provider.ts lands.
	disposeInlineCompletions(_completions: InlineCompletions, _reason: InlineCompletionsDisposeReason): void {
		// Nothing cached yet — the ported provider will release sessions here.
	}
}

/**
 * Register the IDE Tab inline-completion provider for all languages.
 * Called from the composer workbench contribution.
 *
 * (The 14 `ide.*` Tab commands — trigger/accept/peek/revert/abort/toggle/
 * enable/disable/snooze/unsnooze/pickModel/toggleForLanguage/tabStatusClicked —
 * are registered as Action2 in composerActions.ts; their handlers are TODO in
 * IComposerService.executeLegacyCommand.)
 */
export function registerComposerInlineCompletions(
	languageFeaturesService: ILanguageFeaturesService,
	provider: ComposerInlineCompletionsProvider,
): IDisposable {
	return languageFeaturesService.inlineCompletionsProvider.register({ scheme: 'file' }, provider);
}
