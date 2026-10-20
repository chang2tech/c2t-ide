/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Contribution entry point for the `contrib/agents` workbench contrib
// (agent sidebar, modes, sessions UI — Cursor keeps these here, separate from
// `contrib/composer` which owns the chat UI).
//
// Task history note: the previous version of this file was an unimplemented
// skeleton (4 TODOs, no registrations). This commit replaces it with the real
// Cursor-structured implementation:
//   - `browser/agentsActions.ts`      -> openAgentsView / MRU quick-open /
//     navigate-in-picker actions (binary-verbatim IDs, titles, keybindings)
//   - `browser/agentsQuickAccess.ts`  -> chat-history ("chat:") + agents-MRU
//     ("agents mru ") quick access providers
//   - `browser/components/AgentSidebarFooter.ts` + `AgentSidebarUpdateButton.ts`
//   - `common/agentsContextKeys.ts`   -> agentsPaneFocused / agentNavigationMode
//
// What is deliberately NOT registered here (honest gaps, not TODOs):
// - No view container / pane for "agent sessions". Cursor's agents contrib
//   owns the agent sidebar, but the binary evidence available to this task
//   (nls.keys.json module/key names) does not ground a separate agents view
//   container in this fork, and the agent chat UI already lives in
//   `contrib/composer` as the `composer.chat` view. Registering a second
//   container would duplicate the chat view.
// - `AgentSidebarFooter` / `AgentSidebarUpdateButton` are implemented as
//   mountable components with no mount site wired yet: which sidebar
//   container Cursor mounts them in is UNKNOWN, and the fork's agent sidebar
//   surface is owned by `contrib/composer` (not to be modified from here).

import { localize } from '../../../../nls.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IQuickAccessRegistry, Extensions as QuickAccessExtensions } from '../../../../platform/quickinput/common/quickAccess.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { ViewPane } from '../../../browser/parts/views/viewPane.js';
import { COMPOSER_CHAT_VIEW_ID } from '../../composer/browser/composerView.js';
import { AgentsContextKeys } from '../common/agentsContextKeys.js';

// Side-effect import (stock pattern): registers the agents actions
// (workbench.action.openAgentsView, workbench.action.quickOpen*, ...).
import './agentsActions.js';
import { AgentsMRUQuickAccessProvider, ChatHistoryQuickAccessProvider } from './agentsQuickAccess.js';

// ---- Quick access providers ------------------------------------------------
// Binary-verbatim registrations (offsets in workbench.desktop.main.js):
//   chat-history: prefix "chat:" (offset 32163838), placeholder
//   'agents.chatHistory.placeholder' -> 'Search chats and cloud agents',
//   help 'agents.chatHistory.help' -> 'Search chat history' (binary help
//   entries carry description ONLY — no commandId).
//   agents-MRU: prefix "agents mru " (offset 32167091), contextKey
//   'inAgentsMRUPicker' (verbatim, offset 32171363) — set automatically
//   while its picker is showing; the navigate-in-picker commands gate on it.
//   placeholder/help 'agents.mru.placeholder'/'agents.mru.help' ->
//   'Switch between recently used agents'.
Registry.as<IQuickAccessRegistry>(QuickAccessExtensions.Quickaccess).registerQuickAccessProvider({
	ctor: ChatHistoryQuickAccessProvider,
	prefix: ChatHistoryQuickAccessProvider.PREFIX,
	placeholder: localize('agents.chatHistory.placeholder', 'Search chats and cloud agents'),
	helpEntries: [{
		description: localize('agents.chatHistory.help', 'Search chat history'),
	}],
});

Registry.as<IQuickAccessRegistry>(QuickAccessExtensions.Quickaccess).registerQuickAccessProvider({
	ctor: AgentsMRUQuickAccessProvider,
	prefix: AgentsMRUQuickAccessProvider.PREFIX,
	contextKey: AgentsMRUQuickAccessProvider.PICKER_CONTEXT_KEY,
	placeholder: localize('agents.mru.placeholder', 'Switch between recently used agents'),
	helpEntries: [{
		description: localize('agents.mru.help', 'Switch between recently used agents'),
	}],
});

/**
 * Binds the `agentsPaneFocused` context key to the focus state of the agents
 * pane. In this fork the agent sidebar surface is the core `composer.chat`
 * view (`ComposerView extends ViewPane` in `contrib/composer`), so the key
 * tracks that view pane's onDidFocus/onDidBlur. Which pane Cursor binds the
 * key to is UNKNOWN (NLS keys only) — the mapping here is the fork's honest
 * analog.
 */
class AgentsWorkbenchContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.agents.workbench';

	private readonly viewFocusDisposables = this._register(new DisposableStore());

	constructor(
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IViewsService private readonly viewsService: IViewsService,
	) {
		super();

		const agentsPaneFocused = AgentsContextKeys.agentsPaneFocused.bindTo(this.contextKeyService);

		const syncFocusBinding = (): void => {
			this.viewFocusDisposables.clear();
			agentsPaneFocused.reset();
			const view = this.viewsService.getViewWithId<ViewPane>(COMPOSER_CHAT_VIEW_ID);
			if (view instanceof ViewPane) {
				this.viewFocusDisposables.add(view.onDidFocus(() => agentsPaneFocused.set(true)));
				this.viewFocusDisposables.add(view.onDidBlur(() => agentsPaneFocused.set(false)));
			}
		};

		// The chat view pane is created lazily — re-attach when its
		// visibility changes (a hidden view has no focus events to bind).
		this._register(this.viewsService.onDidChangeViewVisibility(e => {
			if (e.id === COMPOSER_CHAT_VIEW_ID) {
				syncFocusBinding();
			}
		}));
		syncFocusBinding();
	}
}

registerWorkbenchContribution2(
	AgentsWorkbenchContribution.ID,
	AgentsWorkbenchContribution,
	WorkbenchPhase.AfterRestored
);
