/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Action registrations for the `contrib/agents` workbench contribution.
//
// Binary evidence (Cursor 3.25.9 — byte offsets below are into
// `usr/share/cursor/resources/app/out/vs/workbench/workbench.desktop.main.js`):
//
// - This module registers EXACTLY THREE actions. nls.keys.json
//   (`vs/workbench/contrib/agents/browser/agentsActions`) contains exactly
//   the keys 'all-agents', 'quickOpenPreviousRecentlyUsedAgent' and
//   'quickOpenLeastRecentlyUsedAgent' (nls.messages.json indices
//   4724/4725/4726, English strings 'All Agents',
//   'Quick Open Previous Recently Used Agent' and
//   'Quick Open Least Recently Used Agent' — all verbatim). Seven actions a
//   previous commit registered here (`agents.session.new`,
//   `agents.session.focus`, `agents.session.delete`,
//   `agents.mode.setAgent/Ask/Plan/Debug`) have NO binary evidence — they
//   were deleted in the 2026-10-20 rework. Command IDs and titles below are
//   binary-verbatim; keybindings are binary-verbatim.
// - IDs (verbatim): 'workbench.action.openAgentsView' (offset 32172402),
//   'workbench.action.quickOpenPreviousRecentlyUsedAgent' (offset 32173043),
//   'workbench.action.quickOpenLeastRecentlyUsedAgent' (offset 32173447).
// - Category: View (binary `category:Yn.View`).
// - openAgentsView keybinding: weight 200, when
//   `has('isInBackgroundComposerWindow').negate()`; mac WinCtrl|Shift+KeyS,
//   win/linux CtrlCmd|Shift+Slash.
// - quickOpen prev/least keybindings: weight 200;
//   previous: CtrlCmd|Tab (mac WinCtrl|Tab);
//   least: CtrlCmd|Shift|Tab (mac WinCtrl|Shift|Tab);
//   when: or(agentsPaneFocused, has('composerFocused'))
//         && notEquals('cursor.chatEditorGroup.enabled', true)
//         && has('isInBackgroundComposerWindow').negate()
//   (binary: `he.and(he.or(iNe.agentsPaneFocused,he.has("composerFocused")),
//   he.notEquals("cursor.chatEditorGroup.enabled",!0),uGe.negate())` where
//   `uGe=new Mt("isInBackgroundComposerWindow",!1)`).
//   Cursor keeps 'composerFocused'/'isInBackgroundComposerWindow' as
//   STRING-key expressions; neither has a core-owned writer in this fork,
//   and unset keys evaluate false — same net effect as the binary here.
// - Run bodies (binary):
//   - openAgentsView: if the agents pane is focused and the unified sidebar
//     is visible, hide it (persisting `workbench.unifiedSidebar.hidden`);
//     otherwise show it, focus `.agent-sidebar`, and run
//     `workbench.action.quickOpen` with the "chat:" prefix. This fork has no
//     `workbench.parts.unifiedsidebar` part (Cursor-only), so the honest
//     analog opens the core `composer.chat` view (the fork's agent sidebar
//     surface) and then the chat-history quick access.
//   - quickOpen prev/least: shared `dwm` base —
//     `quickAccess.show('agents mru ',
//     {quickNavigateConfiguration:{keybindings:lookupKeybindings(id)},
//     itemActivation})` with itemActivation undefined (previous) / LAST
//     (least).
// - Related navigate-in-picker commands, also binary-verbatim
//   (offset 32173570): 'workbench.action.quickOpenNavigateNextInAgentsPicker'
//   / 'workbench.action.quickOpenNavigatePreviousInAgentsPicker', handler
//   `quickInputService.navigate(next, {keybindings:lookupKeybindings(id)})`,
//   when inQuickOpen && has('inAgentsMRUPicker') (weight 250, CtrlCmd|Tab /
//   CtrlCmd|Shift|Tab, mac WinCtrl variants). 'inAgentsMRUPicker' is the
//   contextKey the agents-MRU quick access registration sets while its
//   picker is open (offset 32171363).

import { localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { KeybindingsRegistry, KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { ItemActivation, IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { AgentsContextKeys } from '../common/agentsContextKeys.js';
import { COMPOSER_CHAT_VIEW_ID } from '../../composer/browser/composerView.js';
import { AgentsMRUQuickAccessProvider, ChatHistoryQuickAccessProvider } from './agentsQuickAccess.js';

/** Localized "View" category (binary `category:Yn.View`). */
const ViewCategory = Categories.View;

/**
 * Binary-verbatim `when` for the Ctrl+Tab quick-open actions:
 * or(agentsPaneFocused, composerFocused)
 *   && cursor.chatEditorGroup.enabled != true
 *   && !isInBackgroundComposerWindow.
 */
const quickOpenWhen = ContextKeyExpr.and(
	ContextKeyExpr.or(
		AgentsContextKeys.agentsPaneFocused,
		ContextKeyExpr.has('composerFocused'),
	),
	ContextKeyExpr.notEquals('cursor.chatEditorGroup.enabled', true),
	ContextKeyExpr.has('isInBackgroundComposerWindow').negate(),
);

/**
 * `workbench.action.openAgentsView` — "All Agents".
 *
 * Binary title key 'all-agents' -> 'All Agents' (verbatim). Toggles the
 * agents sidebar and opens the chat-history ("chat:") quick access, per the
 * binary run body. Fork analog (no unifiedsidebar part here): open the core
 * `composer.chat` view, then quickOpen with the chat-history prefix.
 */
class OpenAgentsViewAction extends Action2 {
	static readonly ID = 'workbench.action.openAgentsView';

	constructor() {
		super({
			id: OpenAgentsViewAction.ID,
			title: localize2('all-agents', 'All Agents'),
			category: ViewCategory,
			f1: true,
			keybinding: [{
				weight: KeybindingWeight.WorkbenchContrib,
				when: ContextKeyExpr.has('isInBackgroundComposerWindow').negate(),
				mac: { primary: KeyMod.WinCtrl | KeyMod.Shift | KeyCode.KeyS },
				win: { primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Slash },
				linux: { primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Slash },
			}],
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IViewsService).openView(COMPOSER_CHAT_VIEW_ID, true);
		await accessor.get(ICommandService).executeCommand(
			'workbench.action.quickOpen',
			ChatHistoryQuickAccessProvider.PREFIX,
		);
	}
}

/**
 * Shared base for the two MRU quick-open actions (binary `dwm` class):
 * looks up the action's own keybindings for quick-navigate, then shows the
 * "agents mru " picker with the given item activation.
 */
class QuickOpenRecentlyUsedAgentAction extends Action2 {

	constructor(descriptor: ConstructorParameters<typeof Action2>[0], private readonly itemActivation: ItemActivation | undefined) {
		super(descriptor);
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const keybindingService = accessor.get(IKeybindingService);
		const quickInputService = accessor.get(IQuickInputService);
		const keys = keybindingService.lookupKeybindings(this.desc.id);
		quickInputService.quickAccess.show(AgentsMRUQuickAccessProvider.PREFIX, {
			quickNavigateConfiguration: { keybindings: keys },
			itemActivation: this.itemActivation,
		});
	}
}

/**
 * `workbench.action.quickOpenPreviousRecentlyUsedAgent` —
 * 'Quick Open Previous Recently Used Agent' (binary-verbatim title key
 * 'quickOpenPreviousRecentlyUsedAgent'). itemActivation: default (binary
 * passes `void 0`).
 */
class QuickOpenPreviousRecentlyUsedAgentAction extends QuickOpenRecentlyUsedAgentAction {
	static readonly ID = 'workbench.action.quickOpenPreviousRecentlyUsedAgent';

	constructor() {
		super({
			id: QuickOpenPreviousRecentlyUsedAgentAction.ID,
			title: localize2('quickOpenPreviousRecentlyUsedAgent', 'Quick Open Previous Recently Used Agent'),
			category: ViewCategory,
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyCode.Tab,
				mac: { primary: KeyMod.WinCtrl | KeyCode.Tab },
				when: quickOpenWhen,
			},
		}, undefined);
	}
}

/**
 * `workbench.action.quickOpenLeastRecentlyUsedAgent` —
 * 'Quick Open Least Recently Used Agent' (binary-verbatim title key
 * 'quickOpenLeastRecentlyUsedAgent'). itemActivation: LAST (binary `rG.LAST`).
 */
class QuickOpenLeastRecentlyUsedAgentAction extends QuickOpenRecentlyUsedAgentAction {
	static readonly ID = 'workbench.action.quickOpenLeastRecentlyUsedAgent';

	constructor() {
		super({
			id: QuickOpenLeastRecentlyUsedAgentAction.ID,
			title: localize2('quickOpenLeastRecentlyUsedAgent', 'Quick Open Least Recently Used Agent'),
			category: ViewCategory,
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Tab,
				mac: { primary: KeyMod.WinCtrl | KeyMod.Shift | KeyCode.Tab },
				when: quickOpenWhen,
			},
		}, ItemActivation.LAST);
	}
}

/**
 * Binary-verbatim navigate-in-picker commands (offset 32173570), registered
 * via `registerCommandAndKeybindingRule` exactly like the binary
 * (`ss.registerCommandAndKeybindingRule`). Handler: `tye` —
 * `quickInputService.navigate(next, {keybindings:lookupKeybindings(id)})`.
 * `when`: inQuickOpen && inAgentsMRUPicker (the latter is the contextKey the
 * agents-MRU quick access registration sets while its picker is open).
 * Weight 250 (= KeybindingWeight.SessionsContrib), chords CtrlCmd|Tab and
 * CtrlCmd|Shift|Tab (mac: WinCtrl variants).
 */
function registerQuickOpenNavigateInAgentsPickerCommand(id: string, next: boolean): void {
	KeybindingsRegistry.registerCommandAndKeybindingRule({
		id,
		weight: KeybindingWeight.SessionsContrib,
		primary: next ? KeyMod.CtrlCmd | KeyCode.Tab : KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Tab,
		mac: { primary: next ? KeyMod.WinCtrl | KeyCode.Tab : KeyMod.WinCtrl | KeyMod.Shift | KeyCode.Tab },
		when: ContextKeyExpr.and(
			ContextKeyExpr.has('inQuickOpen'),
			ContextKeyExpr.has(AgentsMRUQuickAccessProvider.PICKER_CONTEXT_KEY),
		),
		handler: (accessor: ServicesAccessor) => {
			const keybindingService = accessor.get(IKeybindingService);
			const quickInputService = accessor.get(IQuickInputService);
			quickInputService.navigate(next, {
				keybindings: keybindingService.lookupKeybindings(id),
			});
		},
	});
}

// Self-registering on import (stock side-effect pattern — see
// `import './agentsActions.js'` in `agents.contribution.ts`).
registerAction2(OpenAgentsViewAction);
registerAction2(QuickOpenPreviousRecentlyUsedAgentAction);
registerAction2(QuickOpenLeastRecentlyUsedAgentAction);
registerQuickOpenNavigateInAgentsPickerCommand('workbench.action.quickOpenNavigateNextInAgentsPicker', true);
registerQuickOpenNavigateInAgentsPickerCommand('workbench.action.quickOpenNavigatePreviousInAgentsPicker', false);
