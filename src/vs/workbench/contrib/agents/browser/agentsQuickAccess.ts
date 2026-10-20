/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Quick access providers for the `contrib/agents` workbench contribution.
//
// Binary evidence (Cursor 3.25.9 — byte offsets below are into
// `usr/share/cursor/resources/app/out/vs/workbench/workbench.desktop.main.js`;
// NLS key names from nls.keys.json module
// `vs/workbench/contrib/agents/browser/agentsQuickAccess`, English strings
// from nls.messages.json):
//
// - This module defines TWO quick access providers (the previous commit
//   wrongly merged them into one invented `'agents'` prefix — deleted in the
//   2026-10-20 rework):
//   1. Chat-history provider — prefix `"chat:"` VERBATIM (offset 32163838).
//      Registration (binary):
//      `registerQuickAccessProvider({ctor, prefix:"chat:",
//      placeholder:"Search chats and cloud agents",
//      helpEntries:[{description:"Search chat history"}]})`.
//      NLS keys (verbatim): 'agents.chatHistory.section.chats' -> 'Chats',
//      'agents.chatHistory.section.cloudAgents' -> 'Cloud agents',
//      'agents.chatHistory.noResults' -> 'No chats available',
//      'agents.chatHistory.noResults.filter' ->
//      'Try a different search query', 'agents.chatHistory.noResults.empty'
//      -> 'Start a new agent to see it here',
//      'agents.chatHistory.noResults.aria' -> 'No chats available',
//      'agents.chatHistory.composerAria' -> 'Chat {0}',
//      'agents.chatHistory.backgroundAria' -> 'Cloud agent {0}',
//      'agents.chatHistory.untitledChat' -> 'Untitled chat',
//      'agents.chatHistory.placeholder' -> 'Search chats and cloud agents',
//      'agents.chatHistory.help' -> 'Search chat history'.
//      Both providers pass `canAcceptInBackground:!0` to the picker options.
//      Empty state is a pick pushed by _getPicks (NOT noResultsPick):
//      `{label:"No chats available",
//      description:filter.trim()?"Try a different search query"
//                            :"Start a new agent to see it here",
//      ariaLabel:"No chats available",accept:()=>{}}`.
//   2. Agents-MRU provider — prefix `"agents mru "` VERBATIM
//      (offset 32167091; `static PREFIX` wired as `yKn.PREFIX=x_a`, offset
//      32171297, and used by the quick-open actions' run bodies).
//      Registration (binary):
//      `registerQuickAccessProvider({ctor, prefix:"agents mru ",
//      contextKey:"inAgentsMRUPicker",  // VERBATIM, offset 32171363
//      placeholder:"Switch between recently used agents",
//      helpEntries:[{description:"Switch between recently used agents"}]})`.
//      Picker options: `{canAcceptInBackground:!0,
//      noResultsPick:{label:"No recent agents",...}}` (the extra
//      composerId/composerType fields belong to Cursor's custom pick type —
//      no fork analog, honestly omitted).
//      NLS keys (verbatim): 'agents.mru.noResults' -> 'No recent agents',
//      'agents.mru.composerAria' -> 'Agent {0}',
//      'agents.mru.backgroundAria' -> 'Cloud agent {0}',
//      'agents.mru.placeholder' -> 'Switch between recently used agents',
//      'agents.mru.help' -> 'Switch between recently used agents'.
//      (Namespace `agents.mru.*` is wired end-to-end by this provider +
//      the 'inAgentsMRUPicker' context key in `agents.contribution.ts` +
//      the quick-open actions in `agentsActions.ts`.)
//   - 'agents.ctrlTab.draft' -> 'Draft' exists in the module's NLS keys but
//     has NO usage found in workbench.desktop.main.js — kept documented here
//     so the known key name is not lost; NOT invented into the UI.
//   - `agentNavigationMode` is NOT touched here: the binary defines it as a
//     boolean context key (default false) set by the composer
//     select-previous/next actions' hold-and-release navigation, not by the
//     quick access picker. The previous commit's keyboard/mouse string-enum
//     wiring in `provide()` was invented and is deleted.
//
// Data source (honest): core has no session store — the migrated
// `ChatTabService` is not registered as a workbench service and the live
// session tabs are owned by the ide-agent extension. The only agent sessions
// visible to core are the open composer chat editors
// (`ComposerChatEditorInput`), listed in MRU order via
// `IEditorService.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE)`.
// The binary's sections/picks come from `composerDataService` /
// `backgroundComposerDataService` / `agentLayoutEventService`, which do not
// exist in core; the pick CONTENT is the fork's honest analog while every
// prefix, NLS key name, NLS string, and registration option above is
// binary-verbatim. The 'cloudAgents' section is deliberately OMITTED (no
// cloud agents in this fork — not faked).

import { localize } from '../../../../nls.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { IPickerQuickAccessItem, PickerQuickAccessProvider, Picks } from '../../../../platform/quickinput/browser/pickerQuickAccess.js';
import { IQuickPickSeparator } from '../../../../platform/quickinput/common/quickInput.js';
import { IQuickAccessProviderRunOptions } from '../../../../platform/quickinput/common/quickAccess.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { EditorsOrder } from '../../../common/editor.js';
import { ComposerChatEditorInput } from '../../composer/browser/composerEditorInput.js';

/** Open composer chat editors, most-recently-active first. */
function getAgentSessionEditors(editorService: IEditorService): Array<{ editor: ComposerChatEditorInput; groupId: number }> {
	const result: Array<{ editor: ComposerChatEditorInput; groupId: number }> = [];
	for (const { editor, groupId } of editorService.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE)) {
		if (editor instanceof ComposerChatEditorInput) {
			result.push({ editor, groupId });
		}
	}
	return result;
}

/**
 * Chat-history quick access provider — binary-verbatim prefix `"chat:"`.
 *
 * Sections: 'Chats' (binary section key
 * 'agents.chatHistory.section.chats'). The 'cloudAgents' section is omitted
 * (no cloud agents in this fork). Empty state mirrors the binary's
 * pushed no-results pick ('agents.chatHistory.noResults[.filter|.empty]',
 * aria 'agents.chatHistory.noResults.aria').
 */
export class ChatHistoryQuickAccessProvider extends PickerQuickAccessProvider<IPickerQuickAccessItem> {

	/** Binary-verbatim prefix (offset 32163838). */
	static readonly PREFIX = 'chat:';

	constructor(
		@IEditorService private readonly editorService: IEditorService,
		@IEditorGroupsService private readonly editorGroupService: IEditorGroupsService,
	) {
		// Binary passes `{canAcceptInBackground:!0}` and NO noResultsPick —
		// the empty state is a pick pushed by _getPicks.
		super(ChatHistoryQuickAccessProvider.PREFIX, { canAcceptInBackground: true });
	}

	protected override _getPicks(
		filter: string,
		disposables: DisposableStore,
		token: CancellationToken,
		runOptions?: IQuickAccessProviderRunOptions
	): Picks<IPickerQuickAccessItem> {
		const normalizedFilter = filter.trim().toLowerCase();
		const activeEditor = this.editorService.activeEditor;
		const items: IPickerQuickAccessItem[] = [];

		for (const { editor, groupId } of getAgentSessionEditors(this.editorService)) {
			const label = editor.getName() || localize('agents.chatHistory.untitledChat', 'Untitled chat');
			if (normalizedFilter && !label.toLowerCase().includes(normalizedFilter)) {
				continue;
			}
			items.push({
				label,
				// OURS nicety (not a binary string): marks the active session.
				// The binary's pick content comes from composerDataService,
				// which has no fork analog — see the header comment.
				description: editor === activeEditor
					? localize('agents.chatHistory.active', 'active')
					: undefined,
				// Binary-verbatim: 'agents.chatHistory.composerAria' -> 'Chat {0}'.
				ariaLabel: localize('agents.chatHistory.composerAria', 'Chat {0}', label),
				accept: (keyMods, event) => {
					this.editorGroupService.getGroup(groupId)?.openEditor(editor, { preserveFocus: event.inBackground });
				},
			});
		}

		if (items.length === 0) {
			// Binary-verbatim empty-state pick (binary pushes this into the
			// picks when the list is empty, with a no-op accept):
			// label 'agents.chatHistory.noResults', description
			// 'agents.chatHistory.noResults.filter' when a filter is typed
			// else 'agents.chatHistory.noResults.empty', ariaLabel
			// 'agents.chatHistory.noResults.aria'.
			return [{
				label: localize('agents.chatHistory.noResults', 'No chats available'),
				description: normalizedFilter
					? localize('agents.chatHistory.noResults.filter', 'Try a different search query')
					: localize('agents.chatHistory.noResults.empty', 'Start a new agent to see it here'),
				ariaLabel: localize('agents.chatHistory.noResults.aria', 'No chats available'),
				accept: () => { /* no-op, like the binary */ },
			}];
		}

		const picks: Array<IPickerQuickAccessItem | IQuickPickSeparator> = [
			// Binary-verbatim section label 'agents.chatHistory.section.chats'.
			{ type: 'separator', label: localize('agents.chatHistory.section.chats', 'Chats') },
			...items,
		];
		return picks;
	}
}

/**
 * Agents-MRU quick access provider — binary-verbatim prefix `"agents mru "`.
 *
 * Wires the `agents.mru.*` NLS namespace end-to-end: placeholder/help
 * ('agents.mru.placeholder' / 'agents.mru.help') are registered in
 * `agents.contribution.ts`, noResults ('agents.mru.noResults') is the
 * `noResultsPick` label, and picks use 'agents.mru.composerAria'.
 * While this picker is open the registration's contextKey
 * 'inAgentsMRUPicker' is set (binary-verbatim) — the navigate-in-picker
 * commands in `agentsActions.ts` gate on it.
 */
export class AgentsMRUQuickAccessProvider extends PickerQuickAccessProvider<IPickerQuickAccessItem> {

	/** Binary-verbatim prefix (offset 32167091; `yKn.PREFIX=x_a`, offset 32171297). */
	static readonly PREFIX = 'agents mru ';

	/**
	 * Binary-verbatim picker context key (offset 32171363): set while this
	 * provider's picker is showing, via the registration descriptor.
	 */
	static readonly PICKER_CONTEXT_KEY = 'inAgentsMRUPicker';

	constructor(
		@IEditorService private readonly editorService: IEditorService,
		@IEditorGroupsService private readonly editorGroupService: IEditorGroupsService,
	) {
		super(AgentsMRUQuickAccessProvider.PREFIX, {
			canAcceptInBackground: true,
			// Binary-verbatim: noResultsPick label 'agents.mru.noResults'.
			// (Cursor's extra composerId/composerType fields belong to its
			// custom pick type — no fork analog, omitted.)
			noResultsPick: {
				label: localize('agents.mru.noResults', 'No recent agents'),
			},
		});
	}

	protected override _getPicks(
		filter: string,
		disposables: DisposableStore,
		token: CancellationToken,
		runOptions?: IQuickAccessProviderRunOptions
	): Picks<IPickerQuickAccessItem> {
		const normalizedFilter = filter.trim().toLowerCase();
		const items: IPickerQuickAccessItem[] = [];

		for (const { editor, groupId } of getAgentSessionEditors(this.editorService)) {
			const label = editor.getName() || localize('agents.chatHistory.untitledChat', 'Untitled chat');
			if (normalizedFilter && !label.toLowerCase().includes(normalizedFilter)) {
				continue;
			}
			items.push({
				label,
				// Binary-verbatim: 'agents.mru.composerAria' -> 'Agent {0}'.
				ariaLabel: localize('agents.mru.composerAria', 'Agent {0}', label),
				accept: (keyMods, event) => {
					this.editorGroupService.getGroup(groupId)?.openEditor(editor, { preserveFocus: event.inBackground });
				},
			});
		}

		return items;
	}
}
