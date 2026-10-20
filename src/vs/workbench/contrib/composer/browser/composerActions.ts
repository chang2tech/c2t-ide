/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Core-registered actions for the Composer (AI chat) workbench contribution.
//
// Migrated from `extensions/ide-agent/package.json` -> `contributes.commands`
// (95 commands) + `contributes.keybindings` (46 entries).
// Full old->new mapping: `docs/rea/contributes-migration-map.md`.
//
// ID MAPPING TABLE (old extension id -> new core id):
//   ide.*                              -> composer.*
//   workbench.action.openCustomizeEditor -> (unchanged, core-namespaced already)
//   workbench.action.customize.*        -> (unchanged, core-namespaced already)
//   aiCodeTracking.resetDailyStats      -> (unchanged)
//
// RUNTIME NOTE: most action implementations still live in the ide-agent
// extension (it registers `vscode.commands.registerCommand("ide.*", ...)` at
// runtime). Each core action below delegates to the extension's command via
// ICommandService so behavior is unchanged while the contribution surface
// (titles, categories, keybindings, menus) is owned by core. As engine pieces
// move into core, individual `run()` bodies can be re-implemented natively.
//
// F2-A (2026-10-20): the inline-edit family (`composer.openInlinePrompt`,
// `editor.action.inlineDiffs.acceptAll` / `rejectAll` / `cancelEdits` /
// `acceptPartialEdit` / `rejectPartialEdit` (WORKER-GAPS-34C,
// binary-verbatim ids replacing the old `composer.acceptInlineEdit` /
// `composer.rejectInlineEdit` / `composer.acceptPartialInlineEdit` /
// `composer.rejectPartialInlineEdit`),
// `composer.sendToAgent`, `composer.focusEditorFromDiff`,
// `composer.addSelectionToInlinePrompt`) is now NATIVE: the `run()` bodies
// drive the workbench-core `IInlineEditService` (native Monaco view-zone
// prompt bar, Cursor's layer) directly, with the `ide.*` commands kept only
// as a fallback for builds without the electron-browser contribution (web).
// The extension's `ide.openInlinePrompt` quick-input flow remains for direct
// palette invocation only — it is no longer on the Cmd+K live path.
//
// KEYBINDINGS: 1:1 with the parity-fixed table in package.json (Cursor 3.25.9
// parity, see docs/rea/parity-keybindings.md). `when` clauses use core
// context keys; the extension-owned `ideAgent.*` keys are replaced by the
// `composer.*` keys in ../common/composerContextKeys.ts (extension must set
// the new keys — see that file's follow-up note).

import { localize, localize2 } from '../../../../nls.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { URI } from '../../../../base/common/uri.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { IAction } from '../../../../base/common/actions.js';
import { joinPath } from '../../../../base/common/resources.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { ServicesAccessor, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { KeybindingWeight, KeybindingsRegistry } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { EditorContextKeys } from '../../../../editor/common/editorContextKeys.js';
import { InlineCompletionContextKeys } from '../../../../editor/contrib/inlineCompletions/browser/controller/inlineCompletionContextKeys.js';
import { TerminalContextKeys } from '../../terminal/common/terminalContextKey.js';
import { ComposerContextKeys } from '../common/composerContextKeys.js';
import {
	CHAT_TAB_TITLE_MENU_ITEMS,
	ChatTitleMenuGate,
	ChatTitleMenuItem,
	NO_REQUEST_ID_FALLBACK,
	resolveCopyRequestIdFromEditorTarget,
	resolveCopyRequestIdTabId,
	resolveCopyRequestIdTarget,
} from '../common/chatTitleMenu.js';
import { IsDevelopmentContext } from '../../../../platform/contextkey/common/contextkeys.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { COMPOSER_MODE_COMMANDS, buildComposerModeCommandTitle, composerModeCommandTitleKey } from '../common/composerModeCommands.js';
import { IInlineEditPromptBar, createPromptBarDataSelection, selectNewestPromptBarIdForUri, selectNextPromptBarId } from '../common/inlineEditPromptBar.js';
import { IInlineEditService } from '../common/inlineEditService.js';
import { IInlinePromptSelectionService } from '../common/inlinePromptSelection.js';
import type { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IEditorGroupsService, IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { COMPOSER_CHAT_EDITOR_SCHEME, ComposerChatEditorInput, composerChatTabIdFromUri } from './composerEditorInput.js';
import { SideBySideEditorInput } from '../../../common/editor/sideBySideEditorInput.js';
import { IComposerPlanService } from '../common/composerPlanService.js';
import { COMPOSER_CHAT_VIEW_ID } from './composerView.js';
import { COMPOSER_SESSIONS_VIEW_ID } from './composerSessionsView.js';
// DEV-GAPS-18-W4 (`agent-worktree-chat-actions`): the three worktree chat-tab
// overflow commands (Cursor 3.25.9 parity, ids/labels verbatim).
import {
	ComposerCopyWorktreePathAction,
	ComposerOpenNewWindowInWorktreeAction,
	ComposerOpenTerminalInWorktreeAction,
	registerComposerWorktreeActions,
} from './composerWorktreeActions.js';
// WORKER-GAPS-22A (agent-new-agent-command-family): the New Agent command
// family (Cursor 3.25.9 parity, binary-verbatim ids/titles/icons/keybindings).
import { registerNewAgentActions } from './newAgentActions.js';
import { registerInlineDiffActions } from './inlineDiffActions.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import {
	ChatExportTranscript,
	buildChatExportMarkdown,
	composerExportFileName,
} from '../common/chatExportMarkdown.js';

/** Localized "Composer" category for the command palette. */
export const ComposerActionCategory = localize2('composer.category', 'Composer');
/** Localized "IDE Tab" category for the command palette (tab-completion commands). */
export const ComposerTabCategory = localize2('composer.tabCategory', 'IDE Tab');
/** Localized "AI Code Tracking" category for the command palette. */
export const ComposerAiCodeTrackingCategory = localize2('composer.aiCodeTrackingCategory', 'AI Code Tracking');

/**
 * IDE-CODE: The chat "surface" — the sidebar view OR a chat editor tab.
 *
 * P1-A fix (QA-VERIFY-DIGDEEPER): keybindings with
 * `when: focusedView == 'ideAgent.chatView'` alone never fire when
 * `ide.chat.openAsEditorTabs: true` (the default), because the sidebar view
 * is not focused in editor-tabs mode. The chat editor tabs use the `ide-chat`
 * URI scheme, so `resourceScheme == 'ide-chat'` covers the editor-tab surface.
 * All chat-scope keybindings must use this instead of the bare focusedView check.
 */
const chatSurface = ContextKeyExpr.or(
	ContextKeyExpr.equals('focusedView', COMPOSER_CHAT_VIEW_ID),
	ContextKeyExpr.equals('resourceScheme', 'ide-chat')
);

/**
 * DEV-GAPS-12 (agent-shell-approval-keyboard-flow): binary-verbatim
 * keybinding weight 600 for the four shell-tool approval commands
 * (workbench.glass.main.js 3.25.9 class registrations). Above
 * ExternalExtension (400), so Enter / Shift+Enter / Esc / Shift+Backspace
 * win over every other binding while a shell approval is pending — exactly
 * like Cursor.
 */
const shellApprovalKeybindingWeight = 600 as KeybindingWeight;

/**
 * WORKER-GAPS-17A (open-mode-menu-keybinding): binary-verbatim keybinding
 * weight 600 for `composer.openModeMenu` ("Open chat mode menu",
 * workbench.glass.main.js 3.25.9:
 * `keybinding:{primary:dt.CtrlCmd|Xe.Period,secondary:[dt.CtrlCmd|dt.Alt|Xe.Period,
 * dt.Shift|Xe.Tab],weight:600,...}`). Cursor's 600 sits above this fork's
 * `KeybindingWeight` enum (max 400 = ExternalExtension), so the raw value
 * is cast — the same pattern as `shellApprovalKeybindingWeight`
 * (DEV-GAPS-12). 600 > 200 means Ctrl+. / Shift+Tab win over same-chord
 * lower-weight bindings (e.g. `composer.cycleMode` Shift+Tab at
 * WorkbenchContrib=200) whenever this binding's when-clause holds —
 * exactly Cursor's weight/when resolution of the shared chords.
 */
const openModeMenuKeybindingWeight = 600 as KeybindingWeight;

/**
 * W65D (`chat-cancel-generation-shortcut`): binary-verbatim keybinding
 * weight 600 for `composer.cancelComposerStep` /
 * `composer.cancelComposerStepInputFocused` ("Cancel Chat",
 * workbench.glass.main.js 3.25.9 @39862622/@39865699 —
 * `keybinding:{primary:dt.CtrlCmd|dt.Shift|Xe.Backspace,weight:600,...}`).
 * Cursor's 600 sits above this fork's `KeybindingWeight` enum (max 400 =
 * ExternalExtension), so the raw value is cast — the same pattern as
 * `shellApprovalKeybindingWeight` (DEV-GAPS-12) and
 * `openModeMenuKeybindingWeight` (WORKER-GAPS-17A). The shared chord's
 * other owners keep their binary weights too
 * (`editor.action.inlineDiffs.cancelEdits` at 600 with the disjoint
 * `editorTextFocus` when; `editor.action.inlineDiffs.rejectAll` at 500) —
 * exactly Cursor's weight/when resolution of the chord.
 */
const cancelComposerStepKeybindingWeight = 600 as KeybindingWeight;

/**
 * FEATURE-1 (`agent-accept-pending-decisions`): binary-verbatim keybinding
 * weight 600 for `composer.acceptComposerStep` ("Accept pending agent pane
 * action", workbench.glass.main.js 3.25.9 @39863346, class LAb —
 * `keybinding:[{primary:dt.CtrlCmd|Xe.Enter,weight:600,...},
 * {primary:dt.CtrlCmd|dt.Alt|Xe.Enter,weight:600,...}]`). Cursor's 600 sits
 * above this fork's `KeybindingWeight` enum (max 400 = ExternalExtension),
 * so the raw value is cast — the same pattern as
 * `shellApprovalKeybindingWeight` (DEV-GAPS-12) and
 * `cancelComposerStepKeybindingWeight` (W65D).
 */
const acceptComposerStepKeybindingWeight = 600 as KeybindingWeight;



export class ComposerNewChatAction extends Action2 {
	static readonly ID = 'composer.newChat';
	constructor() {
		super({
			id: ComposerNewChatAction.ID,
			title: localize2('composer.newChat', 'New Chat'),
			category: ComposerActionCategory,
			f1: true,
			// WORKER-GAPS-40B (glass.newProjectSubagent, auditor run 30):
			// NO keybinding here. Cursor 3.25.9 has no Ctrl+T "clear chat"
			// binding — its Ctrl+T is `glass.newProjectSubagent`
			// (workbench.glass.main.js @45345673, "New Agent",
			// when JDi && !GMe && !focusInAny, f1:!1), now ported in
			// newAgentActions.ts. The old Ctrl+T-on-chatSurface binding was a
			// fork invention (dig-deeper-keyboard §3b flagged it PARTIAL:
			// "Mình thiếu binding global"). The command itself stays for the
			// palette, the sessions-view welcome link and the view-title
			// "+" button — only the chord moves to its Cursor-verbatim owner.
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.newChat', ...args);
	}
}

export class ComposerNewFollowupAction extends Action2 {
	static readonly ID = 'composer.newFollowup';
	constructor() {
		super({
			id: ComposerNewFollowupAction.ID,
			title: localize2('composer.newFollowup', 'Focus Chat Followup'),
			category: ComposerActionCategory,
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyCode.KeyY,
				when: ComposerContextKeys.chatInputFocused
			},
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.newFollowup', ...args);
	}
}

export class ComposerNewAgentChatAction extends Action2 {
	static readonly ID = 'composer.newAgentChat';
	constructor() {
		super({
			id: ComposerNewAgentChatAction.ID,
			title: localize2('composer.newAgentChat', 'New Agent Chat'),
			category: ComposerActionCategory,
			f1: true,
			keybinding: [
				{
					weight: KeybindingWeight.WorkbenchContrib,
					primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyL
				},
				{
					weight: KeybindingWeight.WorkbenchContrib,
					primary: KeyMod.CtrlCmd | KeyCode.KeyN
				},
				{
					weight: KeybindingWeight.WorkbenchContrib,
					primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyN
				}
			],
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.newAgentChat', ...args);
	}
}

// ---- F2-A (2026-10-20): Cmd+K inline-edit live path — core first, extension fallback.
//
// The inline-edit flow now lives in workbench core (`IInlineEditService`,
// electron-browser/): native Monaco view-zone prompt bar (Cursor's
// PromptBarViewZone layer), sidecar generation, per-hunk preview,
// accept/reject/follow-up/escalate. The `composer.*` actions below drive it
// directly instead of delegating to the extension's `ide.*` quick-input flow.
//
// `accessor.get` returns undefined (no throw) when the electron-browser
// contribution is not loaded (web/aux builds); only then do we fall back to
// the extension runtime's legacy `ide.*` commands.
function getCoreInlineEditService(accessor: ServicesAccessor): IInlineEditService | undefined {
	return accessor.get(IInlineEditService) as IInlineEditService | undefined;
}

export class ComposerOpenInlinePromptAction extends Action2 {
	static readonly ID = 'composer.openInlinePrompt';
	constructor() {
		super({
			id: ComposerOpenInlinePromptAction.ID,
			title: localize2('composer.openInlinePrompt', 'Open Inline Prompt'),
			category: ComposerActionCategory,
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyCode.KeyK,
				when: EditorContextKeys.editorTextFocus
			},
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// F2-A (2026-10-20): live path — the native view-zone prompt bar
		// (Cursor's workbench-core layer), driven by `IInlineEditService`.
		// No more delegation to the extension's quick-input box.
		const core = getCoreInlineEditService(accessor);
		if (core) {
			await core.openPrompt();
			return;
		}
		// Web/aux builds: the electron-browser contribution is not loaded —
		// fall back to the extension runtime's legacy quick-input flow.
		await accessor.get(ICommandService).executeCommand('ide.openInlinePrompt', ...args);
	}
}

export class ComposerSendToAgentAction extends Action2 {
	static readonly ID = 'composer.sendToAgent';
	constructor() {
		super({
			id: ComposerSendToAgentAction.ID,
			title: localize2('composer.sendToAgent', 'Send Inline Prompt to Agent'),
			category: ComposerActionCategory,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// F2-A: live path — escalate the core session to a full agent turn.
		const core = getCoreInlineEditService(accessor);
		if (core) {
			await core.escalateToAgent();
			return;
		}
		await accessor.get(ICommandService).executeCommand('ide.sendToAgent', ...args);
	}
}

// ---- PROMPT BAR VIEW ZONE (Cursor 3.25.9 parity, dig-continuous-inline-edit-2026-10-19 §2–§3)
// The Cmd+K prompt bar is a native Monaco view zone (PromptBarViewZone,
// browser/inlineEditPromptBar.ts) driven by the core IInlineEditPromptBar
// service — these actions call core directly (no extension delegation).
//
// Structural ICodeEditor guard for IEditorService.activeTextEditorControl.
function asCodeEditorFromAction(accessor: ServicesAccessor): ICodeEditor | undefined {
	const control = accessor.get(IEditorService).activeTextEditorControl;
	if (!control) {
		return undefined;
	}
	const candidate = control as Partial<ICodeEditor>;
	return typeof candidate.getModel === 'function' && typeof candidate.changeViewZones === 'function'
		? (control as ICodeEditor)
		: undefined;
}

export class AipopupClosePromptBarAction extends Action2 {
	static readonly ID = 'aipopup.action.closePromptBar';
	constructor() {
		super({
			id: AipopupClosePromptBarAction.ID,
			title: localize2('aipopup.action.closePromptBar', 'Close Prompt Bar'),
			// Binary parity: NO category. Cursor 3.25.9/3.25.6 register
			// `aipopup.action.closePromptBar` as {id, title, precondition,
			// keybinding:{when:editorTextFocus, primary:Escape, weight:2105}}
			// only — no `category`, no `f1` (glass class Qfy/Ify
			// super @40742694/@40733079; desktop ktg/ntg super
			// @32239203/@32232724). Fork previously invented
			// ComposerActionCategory here; removed per W69B.
			f1: true,
			keybinding: {
				// Binary: Esc, weight 2105, when editorTextFocus with
				// precondition editorHasPromptBar && editorPromptBarFocused
				// (tier-1 Esc). Core KeybindingWeight maxes at 400; the two
				// tiers are mutually exclusive via editorPromptBarFocused, so
				// the exact weight only matters against unrelated Esc
				// handlers — WorkbenchContrib keeps it above EditorContrib.
				// NOTE: our when omits editorTextFocus — the bar's input is a
				// native textarea inside the view zone, not the editor's text
				// input, so editorTextFocus is false while typing. Tier-1 is
				// additionally handled directly in the bar's keydown handler.
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyCode.Escape,
				when: ContextKeyExpr.and(ComposerContextKeys.editorHasPromptBar, ComposerContextKeys.editorPromptBarFocused)
			},
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const editor = asCodeEditorFromAction(accessor);
		if (editor) {
			accessor.get(IInlineEditPromptBar).closePromptBar(editor);
			editor.focus();
		}
	}
}

export class AipopupCloseActiveEditorPromptBarsAction extends Action2 {
	static readonly ID = 'aipopup.action.closeActiveEditorPromptBars';
	constructor() {
		super({
			id: AipopupCloseActiveEditorPromptBarsAction.ID,
			title: localize2('aipopup.action.closeActiveEditorPromptBars', 'Close Active Editor Prompt Bars'),
			// Binary parity: NO category. Cursor registers the tier-2 Esc as
			// `workbench.action.closeActiveEditorPromptBars` (not
			// `aipopup.action.*`) with {id, title, f1:!1,
			// keybinding:[{primary:Escape, weight:100,
			// when:editorHasPromptBar && !editorPromptBarFocused &&
			// editorTextFocus}]} only — no `category` (3.25.9 glass super
			// @40751517, desktop @32248026; 3.25.6 glass @40741902, desktop
			// @32241547). Fork previously invented ComposerActionCategory
			// here; removed per W69B. NOTE: the fork's `aipopup.action.*` id
			// diverges from the binary's `workbench.action.*` id (renaming
			// is out of scope for this palette-category fix).
			f1: true,
			keybinding: {
				// Binary: Esc, weight 100, when editorHasPromptBar &&
				// !editorPromptBarFocused && editorTextFocus (tier-2 Esc).
				// Only bars WITHOUT a diff are closed (the service checks
				// the hasDiff flag — the binary's `diffId==null` guard).
				weight: KeybindingWeight.EditorContrib,
				primary: KeyCode.Escape,
				when: ContextKeyExpr.and(
					ComposerContextKeys.editorHasPromptBar,
					ComposerContextKeys.editorPromptBarFocused.toNegated(),
					EditorContextKeys.editorTextFocus
				)
			},
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const editor = asCodeEditorFromAction(accessor);
		if (editor) {
			accessor.get(IInlineEditPromptBar).closeActiveEditorPromptBars(editor);
		}
	}
}

export class CmdkTogglePromptBarModelAction extends Action2 {
	static readonly ID = 'cmdk.togglePromptBarModel';
	constructor() {
		super({
			id: CmdkTogglePromptBarModelAction.ID,
			title: localize2('cmdk.togglePromptBarModel', 'Open model toggle'),
			// Binary parity: NO category. Cursor 3.25.9/3.25.6 register
			// `cmdk.togglePromptBarModel` as {id, title, f1:!1,
			// keybinding:[...]} only — no `category` (3.25.9 glass class
			// hzc super @40750368, desktop @32246877; 3.25.6 glass
			// @40740753, desktop @32240398). Fork previously invented
			// ComposerActionCategory here; removed per W69B.
			// WORKER-GAPS-20B (Cursor 3.25.9 binary evidence, workbench.glass.main.js
			// @40750679): `cmdk.togglePromptBarModel` IS a real Cursor command —
			// this refutes the "fork-only ID" premise of the collision report:
			//   hzc.ID="cmdk.togglePromptBarModel", LABEL="Open model toggle",
			//   f1:!1,
			//   keybinding:[{primary:dt.CtrlCmd|Xe.Slash,
			//     secondary:[dt.CtrlCmd|dt.Alt|Xe.Slash], weight:200,
			//     when:editorHasPromptBar && editorPromptBarFocused}].
			// Ctrl+/ is SHARED with glass.openModelPicker ("Select Model",
			// weight 250=yk, when !terminalFocusInAny && !editorTextFocus);
			// Cursor resolves the shared chord by WEIGHT (250 > 200), not by
			// removing either chord. Do NOT unbind Ctrl+/ here and do NOT
			// invent a replacement chord. f1:!1 in the binary — hidden from
			// the command palette (was incorrectly f1:true in the fork).
			f1: false,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyCode.Slash,
				secondary: [KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.Slash],
				when: ContextKeyExpr.and(ComposerContextKeys.editorHasPromptBar, ComposerContextKeys.editorPromptBarFocused)
			},
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const editor = asCodeEditorFromAction(accessor);
		if (editor) {
			await accessor.get(IInlineEditPromptBar).toggleModelPicker(editor);
		}
	}
}

// ---- NEXT PROMPT BAR + FOCUS EDIT (Cursor 3.25.9 parity,
// feature_id `cmdk-next-prompt-bar`, audit-fix-queue run 33).
// The run-33 `aipopup.*` sweep found 6 commands; `nextPromptBar` is one of
// the two registered user-facing ones. `focusEdit` is
// `nextPromptBar`'s executeCommand target (one of the four programmatic
// plumbing commands the audit triaged out of the matrix — it is
// implemented here anyway because nextPromptBar cannot work without it,
// with the binary's f1:!0). Binary (workbench.glass.main.js 3.25.9):
//   Jqc.ID = "aipopup.action.nextPromptBar", Jqc.LABEL = "Next Prompt Bar",
//   f1:!0, registered via Ht(jcI);
//   Zqc.ID = "aipopup.action.focusEdit", Zqc.LABEL = "Focus Edit", f1:!0.
// Both registrations carry NO `category` (verified WORKER-GAPS-66C against
// glass @40741636/@40740291 and desktop @32238118/@32236800) — the fork
// previously invented a "Composer" category; it was removed.
// NO keybinding registration for `nextPromptBar` or `focusEdit` exists
// anywhere in the shipped app (glass, desktop, extensions) — both are
// palette/programmatic-only.
//
// nextPromptBar run body (verbatim port — the sorting and wrap logic are
// in common `selectNextPromptBarId` so they are unit-testable):
//   const l = [...getPromptBars()].sort((u,d)=>u.createdAt-d.createdAt),
//         c = l.findIndex(u=>u.id===n);
//   if (c<l.length-1 ? o=l[c+1] : o=l[0], o&&o.id!==n)
//       s.executeCommand("aipopup.action.focusEdit", o.id);
//   else { const u=i.getActiveCodeEditor(); if(!u||!u.hasModel())return; u.focus(); }
//
// FOCUS PLUMBING (honest fork divergence, documented not silent): the
// binary's focusEdit receives the target bar id as its argument and the
// binary's nextPromptBar receives the CURRENT bar id as argument `n`. When
// no argument is supplied (e.g. palette invocation) the fork derives the
// current id from DOM focus via `getFocusedPromptBarId()`.

export class AipopupNextPromptBarAction extends Action2 {
	static readonly ID = 'aipopup.action.nextPromptBar';
	constructor() {
		super({
			id: AipopupNextPromptBarAction.ID,
			title: localize2('aipopup.action.nextPromptBar', 'Next Prompt Bar'),
			// Binary parity: NO category (glass @40741636, desktop @32238118 —
			// the registration is {id, title, f1:!0} only). Fork previously
			// invented ComposerActionCategory here; removed per WORKER-GAPS-66C.
			f1: true,
			// No keybinding — the shipped 3.25.9 bundles register none.
		});
	}

	async run(accessor: ServicesAccessor, currentBarId?: string): Promise<void> {
		const service = accessor.get(IInlineEditPromptBar);
		const current = currentBarId ?? service.getFocusedPromptBarId();
		const nextId = selectNextPromptBarId(service.getPromptBars(), current);
		if (nextId !== undefined) {
			// Binary: s.executeCommand(C$e, o.id) — C$e = aipopup.action.focusEdit.
			await accessor.get(ICommandService).executeCommand(AipopupFocusEditAction.ID, nextId);
			return;
		}
		// Binary else-branch: focus the active code editor when it has a model.
		const editor = asCodeEditorFromAction(accessor);
		if (editor && editor.hasModel()) {
			editor.focus();
		}
	}
}

export class AipopupFocusEditAction extends Action2 {
	static readonly ID = 'aipopup.action.focusEdit';
	constructor() {
		super({
			id: AipopupFocusEditAction.ID,
			title: localize2('aipopup.action.focusEdit', 'Focus Edit'),
			// Binary parity: NO category (glass @40740291, desktop @32236800 —
			// the registration is {id, title, f1:!0} only). Fork previously
			// invented ComposerActionCategory here; removed per WORKER-GAPS-66C.
			f1: true,
			// No keybinding in the shipped 3.25.9 bundles — programmatic
			// executeCommand target of `aipopup.action.nextPromptBar`.
		});
	}

	async run(accessor: ServicesAccessor, barId?: string): Promise<void> {
		// Binary guard order: active editor must exist and have a model
		// ("No model found, cannot edit." otherwise).
		const editor = asCodeEditorFromAction(accessor);
		if (!editor) {
			return;
		}
		if (!editor.hasModel()) {
			accessor.get(ILogService).error('No model found, cannot edit.');
			return;
		}
		if (barId === undefined) {
			return; // binary: getPromptBar(n) → !c → return
		}
		await accessor.get(IInlineEditPromptBar).focusPromptBar(barId);
	}
}

// ---- INSERT EDIT SELECTION (Cursor 3.25.9 parity,
// feature_id `cmdk-insert-edit-selection`, audit-fix-queue run 33).
// Binary (workbench.glass.main.js 3.25.9 @40742061, class Xfy):
//   ezc="aipopup.action.insertEditSelection", f1:!0,
//   title {value:"Insert Edit Selection", original:"Insert Edit Selection"};
// NO keybinding registration for it exists anywhere in the shipped app —
// palette/programmatic-only.
//
// Run body (verbatim port — the item construction lives in common
// `createPromptBarDataSelection` so it is unit-testable):
//   async run(e,n){
//     const i=e.get(Xu), r=e.get(aU), s=i.getActiveCodeEditor(), o=e.get(sr);
//     if(!s) return;
//     if(!s.hasModel()){ console.error("No model found, cannot edit."); return }
//     const a=s.getModel(), l=s.getSelection();
//     if(!l){ console.error("No selection found, cannot edit."); return }
//     const c=await Mfh({model:a, inBoundsSelectionRange:l});
//     !c || (r.appendDataSelection(n,c), !r.getPromptBar(n))
//           || o.executeCommand(C$e,n)   // C$e = "aipopup.action.focusEdit"
//   }
// i.e. append the current selection (as a Mfh data-selection item) to the
// target bar; when the bar still exists, focus it via focusEdit.
//
// FOCUS/FALLBACK PLUMBING (honest fork divergence, documented not silent):
// the binary receives the target bar id as the command argument `n` (wired
// from StartEditPrompt's "bar already open for this URI" branch). When the
// command is invoked without an argument (e.g. the command palette), the
// fork resolves `n` exactly the way StartEditPrompt finds its target: the
// newest open bar bound to the active editor's document uri
// (`selectNewestPromptBarIdForUri` — same semantics as the binary's
// `getPromptBars().filter(uri).last`), falling back to the DOM-focused bar
// first (the W60C convention used by nextPromptBar). With no open bar the
// command no-ops, exactly like the binary (append → bar lookup fails → no
// focus).

export class AipopupInsertEditSelectionAction extends Action2 {
	static readonly ID = 'aipopup.action.insertEditSelection';
	constructor() {
		super({
			id: AipopupInsertEditSelectionAction.ID,
			title: localize2('aipopup.action.insertEditSelection', 'Insert Edit Selection'),
			// Binary parity: NO category (glass @40742061 — the registration
			// is {id, title, f1:!0} only; removed by DEV-GAPS-64/W64C per the
			// same precedent as nextPromptBar/focusEdit).
			f1: true,
			// No keybinding — the shipped 3.25.9 bundles register none.
		});
	}

	async run(accessor: ServicesAccessor, barId?: string): Promise<void> {
		// Binary guard order: active editor must exist...
		const editor = asCodeEditorFromAction(accessor);
		if (!editor) {
			return;
		}
		if (!editor.hasModel()) {
			// Binary: console.error — no user-facing feedback, verbatim.
			console.error('No model found, cannot edit.');
			return;
		}
		const model = editor.getModel();
		const selection = editor.getSelection();
		// Binary: `if(!l){console.error("No selection found, cannot edit.");return}`.
		if (!model || !selection) {
			console.error('No selection found, cannot edit.');
			return;
		}
		const service = accessor.get(IInlineEditPromptBar);
		const item = createPromptBarDataSelection(model, selection);
		// Binary receives the bar id as `n`; resolve fork-side when absent.
		const targetId = barId
			?? service.getFocusedPromptBarId()
			?? selectNewestPromptBarIdForUri(service.getPromptBars(), model.uri.toString());
		if (targetId === undefined) {
			return; // binary: append no-ops, `!r.getPromptBar(n)` → no focus
		}
		service.appendDataSelection(targetId, item);
		// Binary: `(r.appendDataSelection(n,c), !r.getPromptBar(n)) || o.executeCommand(C$e,n)`.
		if (service.getPromptBars().some((b) => b.id === targetId)) {
			await accessor.get(ICommandService).executeCommand(AipopupFocusEditAction.ID, targetId);
		}
	}
}

// ---- PARTIAL-DIFF NAVIGATION (Cursor 3.25.9 parity,
// dig-continuous-inline-edit-2026-10-19 §3.3)
// Cursor: `editor.action.inlineDiffs.nextChange` / `previousChange`
// (Alt+J / Alt+K, weight 100) and `nextDiffFile` / `previousDiffFile`
// (Alt+L / Alt+H, weight 1100). The accept/reject partial actions now live
// in browser/inlineDiffActions.ts with the binary-verbatim
// `editor.action.inlineDiffs.*` ids (WORKER-GAPS-34C).
//
// Weight mapping to this fork's KeybindingWeight enum (max 400):
// Cursor 100 -> EditorContrib; Cursor 1100 (above the enum) ->
// ExternalExtension (the fork's top tier).

export class ComposerNextInlineChangeAction extends Action2 {
	static readonly ID = 'composer.nextInlineChange';
	constructor() {
		super({
			id: ComposerNextInlineChangeAction.ID,
			title: localize2('composer.nextInlineChange', 'Go to Next Inline Change'),
			category: ComposerActionCategory,
			f1: true,
			keybinding: {
				weight: KeybindingWeight.EditorContrib,
				primary: KeyMod.Alt | KeyCode.KeyJ,
				when: ContextKeyExpr.and(ComposerContextKeys.inlineEditPending, EditorContextKeys.editorTextFocus)
			},
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.nextInlineChange', ...args);
	}
}

export class ComposerPreviousInlineChangeAction extends Action2 {
	static readonly ID = 'composer.previousInlineChange';
	constructor() {
		super({
			id: ComposerPreviousInlineChangeAction.ID,
			title: localize2('composer.previousInlineChange', 'Go to Previous Inline Change'),
			category: ComposerActionCategory,
			f1: true,
			keybinding: {
				weight: KeybindingWeight.EditorContrib,
				primary: KeyMod.Alt | KeyCode.KeyK,
				when: ContextKeyExpr.and(ComposerContextKeys.inlineEditPending, EditorContextKeys.editorTextFocus)
			},
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.previousInlineChange', ...args);
	}
}

export class ComposerNextInlineDiffFileAction extends Action2 {
	static readonly ID = 'composer.nextInlineDiffFile';
	constructor() {
		super({
			id: ComposerNextInlineDiffFileAction.ID,
			title: localize2('composer.nextInlineDiffFile', 'Go to Next Inline Diff File'),
			category: ComposerActionCategory,
			f1: true,
			keybinding: {
				weight: KeybindingWeight.ExternalExtension,
				primary: KeyMod.Alt | KeyCode.KeyL,
				when: ContextKeyExpr.and(ComposerContextKeys.inlineEditPending, EditorContextKeys.editorTextFocus)
			},
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.nextInlineDiffFile', ...args);
	}
}

export class ComposerPreviousInlineDiffFileAction extends Action2 {
	static readonly ID = 'composer.previousInlineDiffFile';
	constructor() {
		super({
			id: ComposerPreviousInlineDiffFileAction.ID,
			title: localize2('composer.previousInlineDiffFile', 'Go to Previous Inline Diff File'),
			category: ComposerActionCategory,
			f1: true,
			keybinding: {
				weight: KeybindingWeight.ExternalExtension,
				primary: KeyMod.Alt | KeyCode.KeyH,
				when: ContextKeyExpr.and(ComposerContextKeys.inlineEditPending, EditorContextKeys.editorTextFocus)
			},
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.previousInlineDiffFile', ...args);
	}
}

export class ComposerOpenModeMenuAction extends Action2 {
	static readonly ID = 'composer.openModeMenu';
	constructor() {
		super({
			id: ComposerOpenModeMenuAction.ID,
			// DEV-GAPS-18-W2 (2026-10-20): binary-verbatim title
			// "Open chat mode menu" (workbench.glass.main.js 3.25.6 + 3.25.9,
			// class GAb: `title:{value:"Open chat mode menu",original:"Open
			// chat mode menu"},f1:!1`). The prior GAPS-16A reading used the
			// extension bridge command's title ("Open Mode Menu"); the core
			// action with the Cursor-verbatim id carries the Cursor-verbatim
			// title instead — the title surfaces in Keyboard Shortcuts even
			// though f1:!1 hides it from the palette.
			title: localize2('composer.openModeMenu', 'Open chat mode menu'),
			category: ComposerActionCategory,
			// Binary f1:!1 — hidden from the command palette, like Cursor.
			// (The extension's `ide.openModeMenu` is registered
			// programmatically with no contributes.commands entry, so it
			// never appears in the palette either.)
			f1: false,
			keybinding: {
				// WORKER-GAPS-16A (open-mode-menu-keybinding): Cursor 3.25.9
				// binary evidence, re-verified 2026-10-20 against
				// workbench.glass.main.js (class GAb, id
				// `composer.openModeMenu`):
				// `title:{value:"Open chat mode menu",original:"Open chat mode
				// menu"},f1:!1,keybinding:{primary:dt.CtrlCmd|Xe.Period,
				// secondary:[dt.CtrlCmd|dt.Alt|Xe.Period,dt.Shift|Xe.Tab],
				// weight:600,
				// when:ft.and(ft.or(ft.has("composerFocused"),
				//   ft.regex("focusedView",/^workbench.panel.aichat.view/),
				//   ft.equals("activeEditor",chatEditor),
				//   ft.has("chatModeMenuFocused")),
				//   di.editorTextFocus.negate(),is.focusInAny.negate())}`.
				//
				// When-clause port (CORRECTION of the GAPS-17A reading, which
				// claimed `focusInAny` was Cursor-only and omitted it):
				// - `is.focusInAny` is the TERMINAL context keys namespace in
				//   the binary: `focusInAny=new pn("terminalFocusInAny",...)`,
				//   also used as `is.focusInAny.bindTo(u)` in the xterm focus
				//   tracker and in terminal keybindings
				//   (`when:ft.and(is.focusInAny,is.textSelected,...)`).
				//   So `is.focusInAny.negate()` is `!terminalFocusInAny` —
				//   ported VERBATIM as
				//   `TerminalContextKeys.focusInAny.negate()` (same key
				//   string 'terminalFocusInAny' in the fork).
				// - `focusedView =~ /^workbench.panel.aichat.view/` ≈ the
				//   `focusedView == 'composer.chat'` arm of `chatSurface`
				//   (the fork's chat view id).
				// - `activeEditor == chatEditor` ≈ the
				//   `resourceScheme == 'ide-chat'` arm of `chatSurface`.
				// - `composerFocused` has no fork equivalent (established
				//   HONEST-DIVERGENCE in this file); the OR's ported terms
				//   plus the bridged `composer.chatInputFocused` cover the
				//   chat surface instead.
				// - `chatModeMenuFocused` has no fork equivalent — the menu
				//   is a quickpick opened BY this command. While it is open
				//   the quick input does not clear `focusedView` and
				//   `editorTextFocus` stays false, so the binding stays live
				//   and the menu can be re-triggered, as in Cursor.
				//
				// Ctrl+. is a SHARED chord with the future "Open Workspace"
				// project selector (binary: `openProjectSelectorRequested`,
				// primary CtrlCmd|Period, lower weight, NO when clause): the
				// 600 weight + chat when-clause resolves it — do NOT register
				// the project-selector chord until that command exists.
				// Shift+Tab ALSO resolves by weight/when against
				// `composer.cycleMode` (Shift+Tab primary, weight
				// WorkbenchContrib=200). The mechanism is the fork's own
				// keybinding resolution, verbatim VS Code semantics:
				// `KeybindingsRegistryImpl` sorts default keybindings
				// ASCENDING by weight1 (`sorter` in
				// platform/keybinding/common/keybindingsRegistry.ts), the
				// resolver appends same-chord entries in that order
				// (`_addKeyPress`), and `KeybindingResolver._findCommand`
				// scans the candidate list from the END backwards, returning
				// the first entry whose when-clause holds. So on the shared
				// Shift+Tab chord the 600 entry is consulted first: where
				// both when-clauses hold, the mode menu wins; where the
				// menu's when is false (e.g. terminal focused,
				// `!terminalFocusInAny` fails), cycleMode's still fires.
				// The resolver's overwrite-removal does NOT delete cycleMode
				// here: `whenIsEntirelyIncluded` requires the menu's when to
				// syntactically imply cycleMode's, which fails on the
				// `!editorTextFocus` / `!terminalFocusInAny` negations — both
				// entries stay live, exactly Cursor's weight/when resolution
				// of the shared chord. (Cursor's own Cycle Mode @45451043
				// carries no binding, so the binary has no conflict there.)
				weight: openModeMenuKeybindingWeight,
				primary: KeyMod.CtrlCmd | KeyCode.Period,
				secondary: [KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.Period, KeyMod.Shift | KeyCode.Tab],
				when: ContextKeyExpr.and(
					ContextKeyExpr.or(
						ComposerContextKeys.chatInputFocused,
						chatSurface
					),
					EditorContextKeys.editorTextFocus.negate(),
					TerminalContextKeys.focusInAny.negate()
				),
			},
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.openModeMenu', ...args);
	}
}

export class ComposerOpenModelPickerAction extends Action2 {
	static readonly ID = 'composer.openModelPicker';
	constructor() {
		super({
			id: ComposerOpenModelPickerAction.ID,
			title: localize2('composer.openModelPicker', 'Open Model Picker'),
			category: ComposerActionCategory,
			f1: true,
			keybinding: {
				// WORKER-GAPS-20B (Cursor 3.25.9 binary evidence, workbench.glass.main.js
				// @45366438): the binary's model-picker command is
				// `glass.openModelPicker` (DHl="openModelPicker", NHl="glass.openModelPicker",
				// title "Select Model", icon "sparkle", keywords ["model","switch","change"],
				// f1:!0) —
				//   keybinding:{weight:yk, primary:dt.CtrlCmd|Xe.Slash,
				//     NO secondary chord,
				//     when:ft.and(is.focusInAny.negate(), di.editorTextFocus.negate())}.
				// yk=250 (single def @45343380) = KeybindingWeight.SessionsContrib.
				// CtrlCmd+/ is SHARED with cmdk.togglePromptBarModel (weight 200,
				// when editorHasPromptBar && editorPromptBarFocused); Cursor
				// disambiguates the shared chord by WEIGHT (250 > 200) through
				// the normal keybinding resolver — the fork's old weight 200 made
				// the dispatch ambiguous (registration-order-dependent). Do NOT
				// re-add a secondary chord: the binary has none. Do NOT invent a
				// new chord for either command.
				weight: KeybindingWeight.SessionsContrib,
				primary: KeyMod.CtrlCmd | KeyCode.Slash,
				when: ContextKeyExpr.and(TerminalContextKeys.focusInAny.negate(), EditorContextKeys.editorTextFocus.negate())
			},
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.openModelPicker', ...args);
	}
}

export class ComposerCycleModelAction extends Action2 {
	static readonly ID = 'composer.cycleModel';
	constructor() {
		super({
			id: ComposerCycleModelAction.ID,
			title: localize2('composer.cycleModel', 'Cycle Model'),
			category: ComposerActionCategory,
			f1: true,
			// DEV-GAPS-3-HOTKEYS (Cursor 3.25.9 binary evidence): composer.cycleModel
			// (lQp) has NO keybinding registration in the binary — it appears
			// only in the model dropdown menu. The CtrlCmd+Alt/Shift+/ keybinding
			// that was here belonged to composer.cycleModelParameter (mis-mapping
			// from DEV-KEYBOARD-FIX) and now lives on
			// ComposerCycleModelParameterAction below. Do NOT re-add a Slash
			// keybinding here.
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.cycleModel', ...args);
	}
}

/**
 * DEV-GAPS-3-HOTKEYS (Cursor 3.25.9 binary evidence): "Cycle Model Parameter",
 * keywords ["cycle","model","parameter","effort","thinking"], glassCategory "Agent".
 * Binary registration (workbench.glass.main.js @45366468, verified 2026-10-20):
 *   Ir({id:LHl,title:"Cycle Model Parameter",icon:"refresh",glassCategory:"Agent",
 *   keywords:["cycle","model","parameter","effort","thinking"],f1:!1,
 *   keybindingCategory:Sa.GENERAL,
 *   keybinding:{weight:yk+1,primary:0,
 *     mac:{primary:dt.CtrlCmd|dt.Shift|Xe.Slash},
 *     win:{primary:dt.CtrlCmd|dt.Alt|Xe.Slash},
 *     linux:{primary:dt.CtrlCmd|dt.Shift|Xe.Slash},
 *     when:ft.and(is.focusInAny.negate(),di.editorTextFocus.negate())},...})
 * Decoded: f1:!1 (hidden from palette), primary:0 (no generic chord),
 *   mac: CtrlCmd+Shift+/, win: CtrlCmd+Alt+/ (NO secondary chord in binary),
 *   linux: CtrlCmd+Shift+/, weight 251 (yk=250 single def @45343380, yk+1),
 *   when: !terminalFocusInAny && !editorTextFocus
 *   (`is` = terminalContextKey.js exports → is.focusInAny = "terminalFocusInAny";
 *   `di` = editor context keys → editorTextFocus).
 * CORRECTION 2026-10-20 (WORKER-GAPS-16C, adversarial re-verify): an earlier
 * pass claimed weight 201 (=WorkbenchContrib+1), a win secondary CtrlCmd+Shift+/,
 * and when=composerFocused&&!editorTextFocus — all three refuted by the binary
 * above. The binary does NOT use composerFocused here. Do NOT re-add the
 * secondary chord or flip f1 back to true.
 * Run: try cycling the focused model-parameter target in the window first,
 * else fall back to composer.cycleModel.
 */
export class ComposerCycleModelParameterAction extends Action2 {
	static readonly ID = 'composer.cycleModelParameter';
	constructor() {
		super({
			id: ComposerCycleModelParameterAction.ID,
			title: localize2('composer.cycleModelParameter', 'Cycle Model Parameter'),
			category: ComposerActionCategory,
			f1: false,
			// WORKER-GAPS-16C (cycle-model-parameter-minors, corrected 2026-10-20):
			// Cursor 3.25.9 binary `composer.cycleModelParameter` has f1:!1 — hidden
			// from the command palette, reachable only via its keybinding.
			// Binary keybinding (workbench.glass.main.js @45366468): primary:0,
			// mac CtrlCmd+Shift+/, win CtrlCmd+Alt+/ (NO secondary chord),
			// linux CtrlCmd+Shift+/, weight 251 (yk=250, yk+1),
			// when !terminalFocusInAny && !editorTextFocus.
			// Do NOT flip f1 back to true. Do NOT re-add a win secondary chord.
			keybinding: {
				weight: 251, // binary: yk+1, yk=250 (NOT KeybindingWeight.WorkbenchContrib+1)
				primary: 0,
				mac: { primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Slash },
				win: { primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.Slash },
				linux: { primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Slash },
				when: ContextKeyExpr.and(TerminalContextKeys.focusInAny.negate(), EditorContextKeys.editorTextFocus.negate())
			},
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.cycleModelParameter', ...args);
	}
}

/**
 * DEV-GAPS-29 (chat-focus-agent-hotkey fix, 2026-10-20): Cursor 3.25.9 binary
 * registration (workbench.glass.main.js @HAb.ID=oQp): id `composer.focusComposer`,
 * title "Focus Agent", category Cursor, f1:!0 — the constructor has NO
 * keybinding field, and no keybinding rule references this id anywhere in the
 * bundles (keybindings-inventory.md row 26; CORRECTION in feature-matrix.json
 * 2026-10-20 REFUTES the earlier "CtrlCmd+." claim: in 3.25.6/3.25.9
 * CtrlCmd+. / CtrlCmd+Alt+. / Shift+Tab at weight 600 are bound to
 * `composer.openModeMenu` ("Open chat mode menu"), so binding Ctrl+. here
 * would shadow a binary-verbatim chord). Run: `handleOpenComposer(e,
 * {focusMainInputBox:!0})` — open the composer and focus the main input box.
 * The fork registers the BINARY-VERBATIM id as canonical; the migration-
 * convention alias `composer.focusAgent` stays palette-invisible below for
 * existing callers.
 */
export class ComposerFocusAgentAction extends Action2 {
	static readonly ID = 'composer.focusComposer';
	constructor() {
		super({
			id: ComposerFocusAgentAction.ID,
			title: localize2('composer.focusComposer', 'Focus Agent'),
			category: ComposerActionCategory,
			f1: true,
			// No keybinding — matches the binary constructor (verified
			// 2026-10-20: no keybinding rule references this id; Ctrl+.
			// is binary-bound to composer.openModeMenu at weight 600).
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.focusAgent', ...args);
	}
}

/**
 * DEV-GAPS-29: palette-invisible alias for the pre-fix fork id
 * `composer.focusAgent` (ide.* -> composer.* migration convention). Keeps
 * existing callers working; the binary-verbatim `composer.focusComposer` is
 * canonical. CommandsRegistry registration = no palette entry.
 */
function registerFocusAgentAlias(): void {
	CommandsRegistry.registerCommand('composer.focusAgent', (accessor, ...args: unknown[]) =>
		accessor.get(ICommandService).executeCommand('composer.focusComposer', ...args));
}

export class ComposerManageModelsAction extends Action2 {
	static readonly ID = 'composer.manageModels';
	constructor() {
		super({
			id: ComposerManageModelsAction.ID,
			title: localize2('composer.manageModels', 'Manage Models…'),
			category: ComposerActionCategory,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.manageModels', ...args);
	}
}

export class ComposerToggleChatAsEditorAction extends Action2 {
	static readonly ID = 'composer.toggleChatAsEditor';
	constructor() {
		super({
			id: ComposerToggleChatAsEditorAction.ID,
			title: localize2('composer.toggleChatAsEditor', 'Toggle Chat as Editor'),
			category: ComposerActionCategory,
			f1: true,
			keybinding: [
				{
					weight: KeybindingWeight.WorkbenchContrib,
					primary: KeyMod.CtrlCmd | KeyCode.KeyD,
					when: chatSurface
				},
				{
					weight: KeybindingWeight.WorkbenchContrib,
					primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyE,
					when: chatSurface
				}
			],
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.toggleChatAsEditor', ...args);
	}
}

/**
 * IDE-CODE: Fullscreen composer — Cursor 3.25.9 parity (WORKER-GAPS-20C redo,
 * 2026-10-20; supersedes the WORKER-P3-FIXES / WORKER-GAPS-17E partial port).
 *
 * Binary evidence (workbench.glass.main.js 3.25.9, rea audit run 27):
 * - `glass.enterEditorPanelFullscreen` — title "Enter Full Screen",
 *   `primary: dt.CtrlCmd|dt.Shift|Xe.KeyM`, `weight: gp` (verbatim `,gp=250`
 *   top-level @45469674; referenced @45518648),
 *   `keybindingCategory: Sa.EDITOR_PANEL`,
 *   `when: Wlu` / `availableWhen: Wlu` where `Wlu=ft.and(YDi,VXt.negate())`,
 *   `f1: {when: Wlu}`,
 *   `run: setEditorPanelFullscreen(true, {entrypoint:"command"})`.
 * - `glass.exitEditorPanelFullscreen` — title "Exit Full Screen", same chord,
 *   `weight: gp` (@45519057), `keybindingCategory: Sa.EDITOR_PANEL`,
 *   `when: Glu` / `availableWhen: Glu` where `Glu=ft.and(u7,VXt)`,
 *   `f1: {when: Glu}`,
 *   `run: setEditorPanelFullscreen(false, {entrypoint:"command"})`.
 *   (`YDi` = `glassEditorPanelFullscreenAvailable`, `VXt` =
 *   `glassEditorPanelFullscreen`, `u7` = `glassEditorPanelVisible`.)
 * - Ctrl/Cmd+Shift+I is "Toggle Developer Tools" (workbench.action.toggleDevTools),
 *   NOT fullscreen — the dotcursorrules.com cheat sheet is wrong per binary.
 * - SEPARATE SURFACE (keep distinct): "Toggle Fullscreen" (TILE fullscreen,
 *   `id:_$l`) on CtrlCmd+Shift+KeyM at weight 1602, tiled-mode only — NOT
 *   this editor-panel fullscreen. This fork does not port tile fullscreen.
 *
 * FAITHFUL-PORT NOTES (verified against this fork's sources):
 * - Weight: `KeybindingWeight.SessionsContrib` === 250 (keybindingsRegistry.ts:66)
 *   — exact binary parity. Conflict resolution: `workbench.actions.view.problems`
 *   registers at WorkbenchContrib (200) on the same Ctrl/Cmd+Shift+M chord with
 *   no `when` (markers.contribution.ts:153); our binding (250) wins exactly when
 *   our `when` matches, Problems keeps the chord otherwise — same as Cursor.
 * - Conditional f1: binary `f1:{when:Wlu}` / `f1:{when:Glu}`. VS Code has no
 *   conditional-f1 primitive; `registerAction2` registers the CommandPalette
 *   item with `when: command.precondition` (actions.ts), so `f1: true` +
 *   `precondition` (same expression as the keybinding `when`) IS the faithful
 *   port — the palette entry shows iff the precondition matches. NOT an
 *   unconditional `f1:true`.
 * - `availableWhen` (binary keybinding field): VS Code's `IKeybindingRule` has
 *   no such field; `registerAction2` ANDs `command.precondition` into the
 *   keybinding `when` (idempotent here — same expression), which covers the
 *   enablement gating `availableWhen` provides in Cursor.
 * - `keybindingCategory: Sa.EDITOR_PANEL`: Cursor-specific keybinding
 *   categorization; VS Code's `IKeybindingRule`/`IAction2Options` have NO
 *   `keybindingCategory` field (verified: only occurrence in this fork's src
 *   is this comment). No code port possible — recorded here for honesty.
 * - Palette category: kept as the fork-wide `ComposerActionCategory`
 *   ("Composer: …"); the binary quote shows no `category`/`glassCategory`
 *   field for these two registrations, but the quote is truncated ("...") —
 *   UNVERIFIED, fork convention kept.
 * - `glassEditorPanelFullscreenAvailable`: VERBATIM Cursor context key
 *   (`YDi=new pn("glassEditorPanelFullscreenAvailable",!1)`), bound `true` by
 *   the composer workbench contribution. Cursor derives it from
 *   `_isEditorPanelFullscreenAvailable()` (= `!this._settingsActive`); this
 *   fork has no settings-overlay state for the composer panel, so `true` is
 *   the honest port (same as Cursor whenever settings are not open).
 * - `glassEditorPanelVisible`: VERBATIM Cursor context key, bound `true` by
 *   the composer workbench contribution. A fullscreen (maximized) editor group
 *   is visible by construction, so the binary's exit-when conjunct is
 *   behaviorally implied here; binding it keeps the when-clause structure
 *   verbatim (`ft.and(glassEditorPanelVisible, glassEditorPanelFullscreen)`).
 * - `run`: binary calls `setEditorPanelFullscreen(v,{entrypoint:"command"})`
 *   on the glass composer service. This fork has no glass service — the
 *   ide-agent extension owns the chat tabs and performs the real maximize /
 *   restore via `workbench.action.maximizeEditorHideSidebar` /
 *   `workbench.action.toggleMaximizeEditorGroup` (never a CSS/DOM fake), so
 *   `run` delegates to the extension's `ide.openFullscreenComposer` /
 *   `ide.exitFullscreenComposer` — the fork's `setEditorPanelFullscreen`
 *   analog, same as every other action in this file.
 */
export class GlassEnterEditorPanelFullscreenAction extends Action2 {
	static readonly ID = 'glass.enterEditorPanelFullscreen';
	constructor() {
		super({
			id: GlassEnterEditorPanelFullscreenAction.ID,
			title: localize2('glass.enterEditorPanelFullscreen', 'Enter Full Screen'),
			category: ComposerActionCategory,
			f1: true,
			// Binary `f1:{when:Wlu}` — ported via `precondition` (see docblock).
			// Wlu = ft.and(glassEditorPanelFullscreenAvailable,
			//              glassEditorPanelFullscreen.negate())
			precondition: ContextKeyExpr.and(ComposerContextKeys.glassEditorPanelFullscreenAvailable, ComposerContextKeys.glassEditorPanelFullscreen.negate()),
			keybinding: {
				weight: KeybindingWeight.SessionsContrib, // binary `weight:gp`, verbatim `,gp=250`
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyM,
				when: ContextKeyExpr.and(ComposerContextKeys.glassEditorPanelFullscreenAvailable, ComposerContextKeys.glassEditorPanelFullscreen.negate())
			},
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: fork analog of binary `setEditorPanelFullscreen(true, {entrypoint:"command"})`
		// — the ide-agent extension owns the chat tabs (see docblock).
		await accessor.get(ICommandService).executeCommand('ide.openFullscreenComposer', ...args);
	}
}

export class GlassExitEditorPanelFullscreenAction extends Action2 {
	static readonly ID = 'glass.exitEditorPanelFullscreen';
	constructor() {
		super({
			id: GlassExitEditorPanelFullscreenAction.ID,
			title: localize2('glass.exitEditorPanelFullscreen', 'Exit Full Screen'),
			category: ComposerActionCategory,
			f1: true,
			// Binary `f1:{when:Glu}` — ported via `precondition` (see docblock).
			// Glu = ft.and(glassEditorPanelVisible, glassEditorPanelFullscreen)
			precondition: ContextKeyExpr.and(ComposerContextKeys.glassEditorPanelVisible, ComposerContextKeys.glassEditorPanelFullscreen),
			keybinding: {
				weight: KeybindingWeight.SessionsContrib, // binary `weight:gp`, verbatim `,gp=250`
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyM,
				when: ContextKeyExpr.and(ComposerContextKeys.glassEditorPanelVisible, ComposerContextKeys.glassEditorPanelFullscreen)
			},
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: fork analog of binary `setEditorPanelFullscreen(false, {entrypoint:"command"})`
		// — the ide-agent extension owns the chat tabs (see docblock).
		await accessor.get(ICommandService).executeCommand('ide.exitFullscreenComposer', ...args);
	}
}

export class ComposerNextChatTabAction extends Action2 {
	static readonly ID = 'composer.nextChatTab';
	constructor() {
		super({
			id: ComposerNextChatTabAction.ID,
			title: localize2('composer.nextChatTab', 'Next Chat Tab'),
			category: ComposerActionCategory,
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyCode.BracketRight,
				when: chatSurface
			},
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.nextChatTab', ...args);
	}
}

export class ComposerPreviousChatTabAction extends Action2 {
	static readonly ID = 'composer.previousChatTab';
	constructor() {
		super({
			id: ComposerPreviousChatTabAction.ID,
			title: localize2('composer.previousChatTab', 'Previous Chat Tab'),
			category: ComposerActionCategory,
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyCode.BracketLeft,
				when: chatSurface
			},
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.previousChatTab', ...args);
	}
}

export class ComposerSelectNextChatAction extends Action2 {
	static readonly ID = 'composer.selectNextChat';
	constructor() {
		super({
			id: ComposerSelectNextChatAction.ID,
			title: localize2('composer.selectNextChat', 'Select Next Chat'),
			category: ComposerActionCategory,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.selectNextChat', ...args);
	}
}

export class ComposerSelectPreviousChatAction extends Action2 {
	static readonly ID = 'composer.selectPreviousChat';
	constructor() {
		super({
			id: ComposerSelectPreviousChatAction.ID,
			title: localize2('composer.selectPreviousChat', 'Select Previous Chat'),
			category: ComposerActionCategory,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.selectPreviousChat', ...args);
	}
}

export class ComposerSelectNextSubagentTabAction extends Action2 {
	static readonly ID = 'composer.selectNextSubagentTab';
	constructor() {
		super({
			id: ComposerSelectNextSubagentTabAction.ID,
			title: localize2('composer.selectNextSubagentTab', 'Select Next Subagent Tab'),
			category: ComposerActionCategory,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.selectNextSubagentTab', ...args);
	}
}

export class ComposerSelectPreviousSubagentTabAction extends Action2 {
	static readonly ID = 'composer.selectPreviousSubagentTab';
	constructor() {
		super({
			id: ComposerSelectPreviousSubagentTabAction.ID,
			title: localize2('composer.selectPreviousSubagentTab', 'Select Previous Subagent Tab'),
			category: ComposerActionCategory,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.selectPreviousSubagentTab', ...args);
	}
}

export class ComposerCloseChatTabAction extends Action2 {
	static readonly ID = 'composer.closeChatTab';
	constructor() {
		super({
			id: ComposerCloseChatTabAction.ID,
			title: localize2('composer.closeChatTab', 'Close Chat Tab'),
			category: ComposerActionCategory,
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyCode.KeyW,
				when: chatSurface
			},
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.closeChatTab', ...args);
	}
}

/**
 * DEV-GAPS-73 (`chat-tab-close-actions`): Cursor 3.25.6 parity —
 * `composer.clearComposerTabs`, title **'Close All Tabs'**, menu
 * ViewTitle group **'0_chatManage'** (static grep, title recovery; matrix
 * + remeasure 2026-10-20 MISSING). Binary evidence does not say whether
 * it is in the command palette — it is kept f1:true (the only sibling
 * with explicit `f1:!0` is `closeOtherComposerTabs`). The run body
 * delegates to the extension-owned runtime (the established
 * `composer.*` → `ide.*` architecture): ChatTabService closes every
 * tab, reusing per-tab closeTab semantics (a running/draining turn
 * refuses; the last chat is cleared, never removed).
 */
export class ComposerClearComposerTabsAction extends Action2 {
	static readonly ID = 'composer.clearComposerTabs';
	constructor() {
		super({
			id: ComposerClearComposerTabsAction.ID,
			title: localize2('composer.clearComposerTabs', 'Close All Tabs'),
			category: ComposerActionCategory,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.closeAllChatTabs', ...args);
	}
}

/**
 * DEV-GAPS-73 (`chat-tab-close-actions`): Cursor 3.25.6 parity —
 * `composer.closeOtherComposerTabs`, title **'Close Other Tabs'**,
 * `f1:!0` (palette-hidden), ViewTitle menu (static grep, title recovery;
 * matrix + remeasure 2026-10-20 MISSING). Closes every chat tab except
 * the active one; same per-tab closeTab semantics as Close All Tabs.
 */
export class ComposerCloseOtherComposerTabsAction extends Action2 {
	static readonly ID = 'composer.closeOtherComposerTabs';
	constructor() {
		super({
			id: ComposerCloseOtherComposerTabsAction.ID,
			title: localize2('composer.closeOtherComposerTabs', 'Close Other Tabs'),
			f1: false,
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.closeOtherChatTabs', ...args);
	}
}

// W65D (`chat-cancel-generation-shortcut`): binary-verbatim
// `composer.cancelComposerStep` ("Cancel Chat", workbench.glass.main.js
// 3.25.9 @39862622):
//   super({id:eqt,title:{value:"Cancel Chat",original:"Cancel Chat"},f1:!0,
//     keybinding:{primary:dt.CtrlCmd|dt.Shift|Xe.Backspace,weight:600,
//     when:ft.and(ft.or(ft.has("composerFocused"),
//     ft.regex("focusedView",new RegExp(`^${pD}`))))}})
// — NO category (the binary registers none). `chatSurface` is this fork's
// composerFocused port (focusedView == 'composer.chat' || resourceScheme ==
// 'ide-chat'); `pD` = "workbench.panel.aichat.view" (glass bundle:
// `,pD=b4o` @1139151, `b4o="workbench.panel.aichat.view"` @1138783).
// Run (binary): resolve the selected composer; if the tab service would
// show the cancel affordance (shouldShowCancel) -> trackEvent
// ("composer.cancel_chat",{composerId,source:"cmd_backspace"}) +
// cancelCurrentStep; else if the view would show accept/reject-all ->
// rejectAll. This delegates to `ide.cancelAgentStep`, whose extension
// runtime implements the cancel branch; the rejectAll branch has no fork
// analog (the fork's engine applies file edits directly) and stays a
// documented no-op.
// This REPLACES the fork-invented `composer.cancelAgentStep` ("Cancel
// Agent Step") — the binary has no such command id; keeping it would
// double-bind the chord under a wrong id/title.
export class ComposerCancelComposerStepAction extends Action2 {
	static readonly ID = 'composer.cancelComposerStep';
	constructor() {
		super({
			id: ComposerCancelComposerStepAction.ID,
			title: localize2('composer.cancelComposerStep', 'Cancel Chat'),
			f1: true,
			keybinding: {
				weight: cancelComposerStepKeybindingWeight,
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Backspace,
				when: chatSurface
			},
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		// DEV-GAPS-64/W64E: the binary tracks source "cmd_backspace" for this
		// command only ("winctrl_c" for the InputFocused variant); forward the
		// source so the runtime logs the verbatim payload per command.
		await accessor.get(ICommandService).executeCommand('ide.cancelAgentStep', { telemetrySource: 'cmd_backspace' }, ...args);
	}
}

// W65D (`chat-cancel-generation-shortcut`): binary-verbatim
// `composer.cancelComposerStepInputFocused` ("Cancel Chat (Input
// Focused)", workbench.glass.main.js 3.25.9 @39865699):
//   super({id:mot,title:{value:"Cancel Chat (Input Focused)",
//   original:"Cancel Chat (Input Focused)"},f1:!0,
//   keybinding:{primary:dt.CtrlCmd|dt.Shift|Xe.Backspace,weight:600,
//   when:ft.and(ft.or(ft.has("composerFocused"),
//   ft.regex("focusedView",new RegExp(`^${pD}`)))),
//   mac:{primary:dt.WinCtrl|Xe.KeyC}}}})
// — the same binding as `composer.cancelComposerStep` plus a mac-only
// Ctrl+C override. Registered AFTER `composer.cancelComposerStep`
// (binary class order NAb @39862622 then LAb @39865699) so it wins ties
// on platforms where both chords match.
export class ComposerCancelComposerStepInputFocusedAction extends Action2 {
	static readonly ID = 'composer.cancelComposerStepInputFocused';
	constructor() {
		super({
			id: ComposerCancelComposerStepInputFocusedAction.ID,
			title: localize2('composer.cancelComposerStepInputFocused', 'Cancel Chat (Input Focused)'),
			f1: true,
			keybinding: {
				weight: cancelComposerStepKeybindingWeight,
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Backspace,
				mac: { primary: KeyMod.WinCtrl | KeyCode.KeyC },
				when: chatSurface
			},
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		// DEV-GAPS-64/W64E: binary tracks source "winctrl_c" for this command.
		await accessor.get(ICommandService).executeCommand('ide.cancelAgentStep', { telemetrySource: 'winctrl_c' }, ...args);
	}
}

// DEV-GAPS-64 (W64D, `chat-cancel-generation-shortcut`): binary-verbatim
// `composer.cancelChat` ("Cancel Chat", workbench.glass.main.js 3.25.9
// @39820510, class iAb):
//   super({id:Kki,title:{value:"Cancel Chat",original:"Cancel Chat"},f1:!1})
//   run(t,e,...n){ t.get(ep).cancelChat(e) }   // ep = composer service
// — NO category, NO keybinding, NOT in the command palette (f1:!1 — the
// programmatic member of the trio; the binary invokes it from menu surfaces
// like the chat-history close button, e.g. glass @40267294 archive flows).
// Binary `composerService.cancelChat(composerId)` aborts the composer's active
// generation (and, for unknown ids, tries stopSubagent) — the fork's runtime
// half is the same `ide.cancelAgentStep` handler that serves the two
// Ctrl+Shift+Backspace palette commands above. NOTE: unlike its siblings the
// binary emits NO composer.cancel_chat telemetry from this command, so no
// telemetrySource is forwarded (DEV-GAPS-64/W64E).
export class ComposerCancelChatAction extends Action2 {
	static readonly ID = 'composer.cancelChat';
	constructor() {
		super({
			id: ComposerCancelChatAction.ID,
			title: localize2('composer.cancelChat', 'Cancel Chat'),
			// Binary f1:!1 — never in the palette; see the Find in Chat fix
			// (DEV-GAPS-29) precedent for palette-invisibility enforcement.
			f1: false,
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.cancelAgentStep', { telemetrySource: undefined }, ...args);
	}
}

// FEATURE-1 (`agent-accept-pending-decisions`): binary-verbatim
// `composer.acceptComposerStep` ("Accept pending agent pane action",
// workbench.glass.main.js 3.25.9 @39863346, class LAb):
//   super({id:gEn,title:{value:"Accept pending agent pane action",
//     original:"Accept pending agent pane action"},f1:!0,
//     keybinding:[{primary:dt.CtrlCmd|Xe.Enter,weight:600,
//       when:ft.and(ft.or(ft.has("composerFocused"),
//       ft.regex("focusedView",new RegExp(`^${pD}`))),Jis.negate())},
//       {primary:dt.CtrlCmd|dt.Alt|Xe.Enter,weight:600,
//       when:ft.and(ft.or(ft.has("composerFocused"),
//       ft.regex("focusedView",new RegExp(`^${pD}`))),ft.has(Jis.key))}]})
// — NO category (the binary registers none), f1:!0 (palette-visible).
// `Jis` = `composerSubmitOnCmdEnterEnabled` (default false): plain
// CtrlCmd+Enter accepts while the submit-on-cmd-enter setting is OFF; when
// it is ON the accept binding moves to CtrlCmd+Alt+Enter so it never
// collides with chat submit. `chatSurface` is this fork's port of the
// binary's `composerFocused || focusedView =~ /^workbench.panel.aichat.view/`
// (established HONEST-DIVERGENCE: `composerFocused` has no fork writer; the
// OR's ported terms `focusedView == 'composer.chat'` / `resourceScheme ==
// 'ide-chat'` cover the chat surface — same port as
// `composer.cancelTerminalToolCall`'s identical binary when-clause).
// Run (binary): raw selectedComposerId -> getHandleIfLoaded -> the
// tool-former's getPendingUserDecisionGroup(handle); a non-empty group ->
// accept() EVERY item unconditionally; otherwise
// composerNotificationService.acceptNotification() (fires
// _onAcceptNotification only while a notification is showing; no warning on
// empty group / no selection / not loaded). Distinct from the shell-tool
// approve/skip flow (Enter/Shift+Enter/Escape act on ONE picked item with
// run/skip/allowlist; this command accepts ALL with no skip path).
// Delegates to `ide.acceptComposerStep`, whose extension runtime implements
// the group-accept + notification branches against the fork's
// HumanReviewService approval cards.
export class ComposerAcceptComposerStepAction extends Action2 {
	static readonly ID = 'composer.acceptComposerStep';
	constructor() {
		super({
			id: ComposerAcceptComposerStepAction.ID,
			title: localize2('composer.acceptComposerStep', 'Accept pending agent pane action'),
			f1: true,
			keybinding: [
				{
					weight: acceptComposerStepKeybindingWeight,
					primary: KeyMod.CtrlCmd | KeyCode.Enter,
					when: ContextKeyExpr.and(chatSurface, ComposerContextKeys.submitOnCmdEnterEnabled.toNegated()),
				},
				{
					weight: acceptComposerStepKeybindingWeight,
					primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.Enter,
					when: ContextKeyExpr.and(chatSurface, ComposerContextKeys.submitOnCmdEnterEnabled),
				},
			],
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.acceptComposerStep', ...args);
	}
}

// DEV-GAPS-56 (`agent-resume-chat`): binary-verbatim
// `composer.resumeCurrentChat` ("Resume Current Chat",
// workbench.glass.main.js 3.25.9, class CAb):
//   super({id:p8a,title:{value:"Resume Current Chat",original:"Resume Current Chat"}})
// — p8a="composer.resumeCurrentChat". The binary registration carries NO
// f1 field, NO category and NO keybinding (an omitted f1 defaults to
// palette-visible in both frameworks, so the command shows in the palette
// exactly like Cursor's; the run-34 audit note's "f1:!0" was an extraction
// normalization, not a shipped field). Run (binary):
//   async run(t,e){const n=t.get(L0/*chatService*/),i=t.get(no/*composerDataService*/),
//     r=t.get($r/*log*/),s=i.selectedComposerId;
//     if(s){const o=i.getHandleIfLoaded(s);
//       if(!o){r.warn("Cannot resume: composer not loaded");return}
//       try{n.resumeChat(o,{isAutoResume:e?.isAutoResume===!0})}
//       catch(a){r.warn(a instanceof Error?a.message:"Cannot resume")}}}
export class ComposerResumeCurrentChatAction extends Action2 {
	static readonly ID = 'composer.resumeCurrentChat';
	constructor() {
		super({
			id: ComposerResumeCurrentChatAction.ID,
			title: localize2('composer.resumeCurrentChat', 'Resume Current Chat'),
			// No f1 / category / keybinding — binary registers none of them.
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.resumeCurrentChat', ...args);
	}
}

// DEV-GAPS-29 (chat-find-in-chat fix, 2026-10-20): binary-verbatim Find in
// Chat family (workbench.glass.main.js 3.25.6/3.25.9 — keybindings-inventory.md
// rows 36-39, feature-matrix.json "Find in Chat (composer.find.*)"): four
// actions, ALL f1:!1, weight 200 (= KeybindingWeight.WorkbenchContrib), gated
// by the verbatim context key `composerFindWidgetFocused`
// (ComposerContextKeys.findWidgetFocused — set by the ide-agent extension
// from the chat webview's find-bar open/close messages):
//   composer.find.focus    "Find in Chat"        CtrlCmd+F   when composerFocused && !composerFindWidgetFocused
//   composer.find.hide     "Close Find in Chat"  Escape      when composerFindWidgetFocused
//   composer.find.next     "Find Next in Chat"   F3 / Enter  when composerFindWidgetFocused
//   composer.find.previous "Find Previous in Chat" Shift+F3 / Shift+Enter when composerFindWidgetFocused
// The fork's composerFocused port is `chatSurface` (focusedView ==
// 'composer.chat' || resourceScheme == 'ide-chat'); see the P1-A note above.
// NOTE: f1:!1 is binary-verbatim — the palette must NOT gain these entries
// (an earlier pass had f1:true; refuted 2026-10-20). The legacy fork ids
// `composer.findInChat` / `composer.hideFindInChat` stay registered as
// palette-invisible aliases below (registerFindInChatAliases) so existing
// callers keep working.
export class ComposerFindInChatAction extends Action2 {
	static readonly ID = 'composer.find.focus';
	constructor() {
		super({
			id: ComposerFindInChatAction.ID,
			title: localize2('composer.find.focus', 'Find in Chat'),
			category: ComposerActionCategory,
			f1: false,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyCode.KeyF,
				when: ContextKeyExpr.and(chatSurface, ComposerContextKeys.findWidgetFocused.negate())
			},
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.findInChat', ...args);
	}
}

export class ComposerHideFindInChatAction extends Action2 {
	static readonly ID = 'composer.find.hide';
	constructor() {
		super({
			id: ComposerHideFindInChatAction.ID,
			title: localize2('composer.find.hide', 'Close Find in Chat'),
			category: ComposerActionCategory,
			f1: false,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyCode.Escape,
				// Binary when is composerFindWidgetFocused alone. The shell
				// tool approval's Escape (weight 600) outranks this 200
				// entry while an approval is pending, so no extra
				// !toolApprovalVisible conjunct is needed — the earlier
				// conjunct was fork-invented, not binary.
				when: ComposerContextKeys.findWidgetFocused
			},
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.hideFindInChat', ...args);
	}
}

// DEV-GAPS-29: binary-verbatim `composer.find.next` ("Find Next in Chat",
// F3 / Enter, f1:!1, weight 200, when composerFindWidgetFocused). Missing
// entirely before this fix (feature-matrix.json 2026-10-20). Enter as the
// secondary chord matches the binary ("F3 (2nd: Enter)"). Fires when the
// find bar is open; the webview advances its <mark> highlights. No conflict:
// the editor's F3 (editor.action.nextMatch) requires findWidgetVisible, a
// disjoint context key.
export class ComposerFindNextInChatAction extends Action2 {
	static readonly ID = 'composer.find.next';
	constructor() {
		super({
			id: ComposerFindNextInChatAction.ID,
			title: localize2('composer.find.next', 'Find Next in Chat'),
			category: ComposerActionCategory,
			f1: false,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyCode.F3,
				secondary: [KeyCode.Enter],
				when: ComposerContextKeys.findWidgetFocused
			},
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.findNextInChat', ...args);
	}
}

// DEV-GAPS-29: binary-verbatim `composer.find.previous` ("Find Previous in
// Chat", Shift+F3 / Shift+Enter, f1:!1, weight 200, when
// composerFindWidgetFocused). Missing entirely before this fix.
export class ComposerFindPreviousInChatAction extends Action2 {
	static readonly ID = 'composer.find.previous';
	constructor() {
		super({
			id: ComposerFindPreviousInChatAction.ID,
			title: localize2('composer.find.previous', 'Find Previous in Chat'),
			category: ComposerActionCategory,
			f1: false,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.Shift | KeyCode.F3,
				secondary: [KeyMod.Shift | KeyCode.Enter],
				when: ComposerContextKeys.findWidgetFocused
			},
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.findPreviousInChat', ...args);
	}
}

/**
 * DEV-GAPS-29: palette-invisible legacy aliases for the pre-fix fork ids
 * (`composer.findInChat`, `composer.hideFindInChat`). CommandsRegistry
 * (not Action2) registration keeps them OUT of the command palette while
 * existing callers (keybinding tests, docs, user keybindings.json) keep
 * working. The binary-verbatim ids are the canonical commands.
 */
function registerFindInChatAliases(): void {
	CommandsRegistry.registerCommand('composer.findInChat', (accessor, ...args: unknown[]) =>
		accessor.get(ICommandService).executeCommand('composer.find.focus', ...args));
	CommandsRegistry.registerCommand('composer.hideFindInChat', (accessor, ...args: unknown[]) =>
		accessor.get(ICommandService).executeCommand('composer.find.hide', ...args));
}

export class ComposerOpenAddContextMenuAction extends Action2 {
	static readonly ID = 'composer.openAddContextMenu';
	constructor() {
		super({
			id: ComposerOpenAddContextMenuAction.ID,
			title: localize2('composer.openAddContextMenu', 'Add Context…'),
			category: ComposerActionCategory,
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyP,
				when: chatSurface
			},
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.openAddContextMenu', ...args);
	}
}

// DEV-GAPS-12 (agent-shell-approval-keyboard-flow): binary-verbatim Cursor
// 3.25.9 command — `composer.approvePendingShellToolDecision`,
// "Approve pending shell tool (run)", f1, Enter, weight 600,
// when `!isGlass && composerShellToolPendingKeybindingsActive` (glass bundle
// class registration; the Enter match is dispatched through
// keybindingService.softDispatch when the shell tool-call notification card
// has focus). The `!isGlass` term has no meaning in this fork (single chat
// surface — no glass/legacy split) and is omitted. Delegates to the
// extension runtime, which resolves the pending approval and refocuses the
// composer (Cursor's rXs "run" path).
export class ComposerApprovePendingShellToolDecisionAction extends Action2 {
	static readonly ID = 'composer.approvePendingShellToolDecision';
	constructor() {
		super({
			id: ComposerApprovePendingShellToolDecisionAction.ID,
			title: localize2('composer.approvePendingShellToolDecision', 'Approve pending shell tool (run)'),
			category: ComposerActionCategory,
			f1: true,
			keybinding: {
				weight: shellApprovalKeybindingWeight,
				primary: KeyCode.Enter,
				when: ComposerContextKeys.shellToolPendingKeybindingsActive
			},
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.approveShellTool', ...args);
	}
}

// DEV-GAPS-12: binary-verbatim `composer.approvePendingShellToolDecisionAllowlist`,
// "Approve pending shell tool and allowlist", f1, Shift+Enter, weight 600,
// when `!isGlass && composerShellToolAllowlistShortcutActive` (glass bundle
// 3.25.9). Allowlist semantics (binary + dissect-ai-agent.md §5): per-command
// — the allowlisted identity is the approved shell command itself
// (`candidatesForAllowlist`), remembered indefinitely (no TTL).
export class ComposerApprovePendingShellToolDecisionAllowlistAction extends Action2 {
	static readonly ID = 'composer.approvePendingShellToolDecisionAllowlist';
	constructor() {
		super({
			id: ComposerApprovePendingShellToolDecisionAllowlistAction.ID,
			title: localize2('composer.approvePendingShellToolDecisionAllowlist', 'Approve pending shell tool and allowlist'),
			category: ComposerActionCategory,
			f1: true,
			keybinding: {
				weight: shellApprovalKeybindingWeight,
				primary: KeyMod.Shift | KeyCode.Enter,
				when: ComposerContextKeys.shellToolAllowlistShortcutActive
			},
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.approveShellToolAllowlist', ...args);
	}
}

// DEV-GAPS-12: binary-verbatim `composer.skipPendingShellToolDecision`,
// "Skip pending shell tool", f1, Escape, weight 600,
// when `!isGlass && composerShellToolPendingKeybindingsActive` (glass bundle
// 3.25.9). Skip does NOT refocus the composer (Cursor's rXs "skip" path).
export class ComposerSkipPendingShellToolDecisionAction extends Action2 {
	static readonly ID = 'composer.skipPendingShellToolDecision';
	constructor() {
		super({
			id: ComposerSkipPendingShellToolDecisionAction.ID,
			title: localize2('composer.skipPendingShellToolDecision', 'Skip pending shell tool'),
			category: ComposerActionCategory,
			f1: true,
			keybinding: {
				weight: shellApprovalKeybindingWeight,
				primary: KeyCode.Escape,
				when: ComposerContextKeys.shellToolPendingKeybindingsActive
			},
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.skipShellTool', ...args);
	}
}

// DEV-GAPS-12: binary-verbatim `composer.cancelTerminalToolCall`,
// "Cancel Terminal Tool Call", Shift+Backspace, weight 600,
// when `composerFocused || focusedView =~ /^workbench.panel.aichat.view/`
// (glass bundle 3.25.9 class registration — CORRECTION of the GAPS-14 note:
// the binary DOES pin a when-clause; the earlier "no when-clause" claim is
// refuted). `chatSurface` is this fork's equivalent: the chat sidebar view
// focused OR a chat editor tab (`ide-chat` scheme) focused. Run body
// (binary): reject pending RUN_TERMINAL_COMMAND_V2 decisions first, else
// cancel the running terminal stream (cancelStream + bubble "cancelled").
// GAPS-14 re-verification (2026-10-20, glass bundle 3.25.6, direct
// extraction): the class registration carries NO `f1` field — the three
// approval commands have explicit `f1:!0`, cancel does not — so cancel is
// NOT in the command palette (keybinding-only). `f1: true` here would
// contradict the binary.
export class ComposerCancelTerminalToolCallAction extends Action2 {
	static readonly ID = 'composer.cancelTerminalToolCall';
	constructor() {
		super({
			id: ComposerCancelTerminalToolCallAction.ID,
			title: localize2('composer.cancelTerminalToolCall', 'Cancel Terminal Tool Call'),
			keybinding: {
				weight: shellApprovalKeybindingWeight,
				primary: KeyMod.Shift | KeyCode.Backspace,
				when: chatSurface
			},
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.cancelTerminalToolCall', ...args);
	}
}

export class ComposerWorktreeCommandAction extends Action2 {
	static readonly ID = 'composer.worktreeCommand';
	constructor() {
		super({
			id: ComposerWorktreeCommandAction.ID,
			title: localize2('composer.worktreeCommand', 'Worktree Command (/worktree)'),
			category: ComposerActionCategory,
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Enter,
				when: ComposerContextKeys.chatInputFocused
			},
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.worktreeCommand', ...args);
	}
}

export class ComposerDeleteWorktreeAction extends Action2 {
	static readonly ID = 'composer.deleteWorktree';
	constructor() {
		super({
			id: ComposerDeleteWorktreeAction.ID,
			title: localize2('composer.deleteWorktree', 'Delete Worktree…'),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.deleteWorktree', ...args);
	}
}

export class ComposerListWorktreesAction extends Action2 {
	static readonly ID = 'composer.listWorktrees';
	constructor() {
		super({
			id: ComposerListWorktreesAction.ID,
			title: localize2('composer.listWorktrees', 'List Worktrees'),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.listWorktrees', ...args);
	}
}

export class ComposerFocusEditorFromDiffAction extends Action2 {
	static readonly ID = 'composer.focusEditorFromDiff';
	constructor() {
		super({
			id: ComposerFocusEditorFromDiffAction.ID,
			title: localize2('composer.focusEditorFromDiff', 'Focus Editor from Inline Diff'),
			category: ComposerActionCategory,
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyCode.KeyK,
				when: ContextKeyExpr.and(ComposerContextKeys.inlineEditPending, EditorContextKeys.editorTextFocus.negate(), TerminalContextKeys.focus.negate())
			},
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		// F2-A: Cursor parity (dig §3.1) — Cmd+K while the prompt bar is
		// focused moves focus back to the editor. Pure workbench, no
		// extension involved.
		const editor = asCodeEditorFromAction(accessor);
		if (editor) {
			editor.focus();
		}
	}
}

/**
 * IDE-CODE: `composer.acceptPlan` — Cursor parity (RAW registerCommand, NO Action2).
 *
 * Binary evidence (Cursor 3.25.9, `workbench.desktop.main.js` @29969972;
 * glass bundle identical — W-REA CONFIRMED, verbatim):
 * ```js
 * xi.registerCommand("composer.acceptPlan", async (e, t, n) => {
 *   const i = e.get(gz),                     // gz = IComposerPlanService ("composerPlanService")
 *         s = e.get(Qs).getHandleIfLoaded(t); // Qs = IComposerDataService; t = composer handle
 *   if (s) {
 *     const o = i.getPlanUriFromBubble(s, n); // n = bubble id; plan URI only for CREATE_PLAN tool bubbles
 *     o && await i.acceptPlan(s, o, n);       // acceptPlan(handle, planUri, bubbleId)
 *   }
 * });
 * ```
 * - RAW `registerCommand`: NO title, NO category, NO palette entry, NO
 *   keybinding — the string `composer.acceptPlan` occurs exactly once per
 *   bundle, so it is a bare API command with NO internal caller in Cursor.
 *   (Cursor's real "Accept plan" UX calls the plan service directly:
 *   PlanReviewModel APPROVE -> `composerPlanService.acceptPlan(n, s, bubbleId,
 *   "manual", { unifiedMode })`.)
 * - Fork choice: the command is kept bare like Cursor (the fork has no
 *   PlanReviewModel). The fork's existing "Accept Plan & Build" UX
 *   (chat webview -> postMessage -> ide-agent extension) is a separate path
 *   and is left untouched.
 *
 * Fork mapping:
 * - `Qs.getHandleIfLoaded(t)` -> `resolveComposerHandleInput`: the open
 *   `ComposerChatEditorInput` for the handle. The handle arg accepts a tab id
 *   string (verbatim), a `ComposerChatEditorInput`, or an `ide-chat:` URI —
 *   the same handle shapes other composer commands in this file resolve.
 *   Unloaded/absent handles no-op, exactly like the binary's `if (s)`.
 * - `gz` (IComposerPlanService) -> the new core `IComposerPlanService`
 *   (`../common/composerPlanService.js`); binary offsets are documented
 *   there. NOTE: this is a SEPARATE service from the composer data service —
 *   the original fork implementation wrongly delegated to the `ide.acceptPlan`
 *   extension command from an f1 Action2.
 * - `getPlanUriFromBubble` gate: Cursor returns a URI only for CREATE_PLAN
 *   tool bubbles (`additionalData.planUri`). The fork has no plan bubbles,
 *   so the gate runs over the fork's per-composer plan registry (see the
 *   service docs for the HONEST-DIVERGENCE). No plan URI -> no-op, mirroring
 *   the binary's `o && ...`.
 */
export const COMPOSER_ACCEPT_PLAN_COMMAND_ID = 'composer.acceptPlan';

/** Resolve a `composer.acceptPlan` handle arg to its open composer editor input. */
function resolveComposerHandleInput(editorService: IEditorService, handle: unknown): ComposerChatEditorInput | undefined {
	if (handle instanceof ComposerChatEditorInput) {
		return handle;
	}
	if (typeof handle === 'string' && handle) {
		return findOpenComposerChatInput(editorService, handle);
	}
	if (URI.isUri(handle) && handle.scheme === COMPOSER_CHAT_EDITOR_SCHEME) {
		const tabId = composerChatTabIdFromUri(handle);
		return tabId ? findOpenComposerChatInput(editorService, tabId) : undefined;
	}
	return undefined;
}

function registerComposerAcceptPlanCommand(): void {
	CommandsRegistry.registerCommand(COMPOSER_ACCEPT_PLAN_COMMAND_ID,
		async (accessor: ServicesAccessor, composerHandle?: unknown, bubbleId?: unknown): Promise<void> => {
			const editorService = accessor.get(IEditorService);
			let planService: IComposerPlanService;
			try {
				planService = accessor.get(IComposerPlanService);
			} catch {
				return; // plan service not registered on this platform build
			}
			// Cursor: `s = getHandleIfLoaded(t); if (s) { ... }`
			const input = resolveComposerHandleInput(editorService, composerHandle);
			if (!input) {
				return;
			}
			// Cursor: `o = getPlanUriFromBubble(s, n); o && await acceptPlan(s, o, n)`
			const planUri = planService.getPlanUriFromBubble(input.tabId, bubbleId);
			if (planUri) {
				await planService.acceptPlan(input.tabId, planUri, bubbleId);
			}
		});
}

/**
 * IDE-CODE: `composer.splitEditorWithNewComposer` — Cursor parity (RAW registerCommand, NO Action2).
 *
 * Binary evidence (Cursor 3.25.9, `workbench.desktop.main.js` @29933821;
 * glass bundle identical — W-REA CONFIRMED, verbatim):
 * ```js
 * xi.registerCommand("composer.splitEditorWithNewComposer", async (e, t, n) => {
 *   const i = e.get(Hh),   // Hh = IComposerService ("composerService")
 *         r = e.get(wt);    // IInstantiationService
 *   if (!(t instanceof eS)) return;  // eS = Cursor's ComposerEditorInput (scheme "cursor.composer")
 *   const s = await i.createComposer({ openInNewTab: false });  // -> { composerId, weakHandle }
 *   if (!s) return;
 *   const o = r.createInstance(eS, s.composerId);
 *   await n.replaceEditors([{        // n = the editor GROUP
 *     editor: t,
 *     replacement: r.createInstance(wk, void 0, void 0, t, o),  // wk = SideBySideEditorInput (core)
 *     forceReplaceDirty: true
 *   }]);
 * });
 * ```
 * - RAW `registerCommand`: NO title/palette. Signature `(accessor, editorInput, group?)`.
 * - The caller is `workbench.action.splitEditorInGroup` ("Split Editor in
 *   Group"): when the editor being split is a composer it executes this
 *   command instead of duplicating the editor, with a try/catch fallback to
 *   the stock duplicate-split (see `workbench/browser/parts/editor/editorCommands.ts`).
 *
 * Fork mapping:
 * - `t instanceof eS` -> `instanceof ComposerChatEditorInput` (fork scheme
 *   `ide-chat`, not Cursor's `cursor.composer`).
 * - `Hh.createComposer({ openInNewTab: false })` -> the fork has NO composer
 *   service exposing `createComposer` (its `IComposerService` is an unrelated
 *   skeleton); the fork's composer identity IS the chat tab id, so minting a
 *   fresh id without opening anything carries the exact `openInNewTab: false`
 *   semantics. (The previous implementation wrongly opened the new composer
 *   in a NEW group via `addGroup(RIGHT)`.)
 * - `wk` = VS Code core `SideBySideEditorInput`, constructor-verified as
 *   `(preferredName, preferredDescription, secondary, primary, editorService)`
 *   — used directly with the binary's arg order `(void 0, void 0, t, o)`:
 *   secondary = old composer input, primary = new composer input.
 * - `n.replaceEditors` -> the editor group: the passed group when it contains
 *   the input, otherwise the group resolved from `IEditorGroupsService`.
 *   (The earlier brief misread `n` as the groups service; `replaceEditors`
 *   lives on `IEditorGroup`.)
 */
export const COMPOSER_SPLIT_EDITOR_WITH_NEW_COMPOSER_COMMAND_ID = 'composer.splitEditorWithNewComposer';

function registerComposerSplitEditorWithNewComposerCommand(): void {
	CommandsRegistry.registerCommand(COMPOSER_SPLIT_EDITOR_WITH_NEW_COMPOSER_COMMAND_ID,
		async (accessor: ServicesAccessor, editorInput?: unknown, group?: unknown): Promise<void> => {
			const instantiationService = accessor.get(IInstantiationService);
			const editorGroupsService = accessor.get(IEditorGroupsService);
			// Cursor: `if (!(t instanceof eS)) return;`
			if (!(editorInput instanceof ComposerChatEditorInput)) {
				return;
			}
			const candidate = group as IEditorGroup | undefined;
			const targetGroup = (candidate && typeof candidate.contains === 'function' && candidate.contains(editorInput))
				? candidate
				: editorGroupsService.groups.find(g => g.contains(editorInput));
			if (!targetGroup) {
				return;
			}
			// Cursor: `s = await createComposer({ openInNewTab: false })` -> { composerId }.
			// Fork: no createComposer service — mint the tab id (the fork's
			// composer identity) without opening anything.
			const newComposerInput = instantiationService.createInstance(ComposerChatEditorInput, generateUuid());
			// Cursor: `replaceEditors([{ editor: t,
			//   replacement: createInstance(SideBySideEditorInput, void 0, void 0, t, o),
			//   forceReplaceDirty: true }])`
			await targetGroup.replaceEditors([{
				editor: editorInput,
				replacement: instantiationService.createInstance(SideBySideEditorInput, undefined, undefined, editorInput, newComposerInput),
				forceReplaceDirty: true,
			}]);
		});
}

/**
 * IDE-CODE: toggle sandbox debug logging — ported from the Cursor binary.
 *
 * Binary evidence (Cursor 3.25.9):
 * `resources/app/out/vs/workbench/workbench.desktop.main.js` @offset 29974171,
 * class `D2S extends Action2`: id `composer.toggleSandboxDebugLogging`,
 * title VERBATIM "Toggle Sandbox Debug Logging", category `Developer`
 * (the stock `Categories.Developer`), `f1: true`, NO keybinding.
 *
 * Cursor's layer/architecture: PURE CORE — the run() body touches only
 * platform services, no extension involvement at all:
 *   - IStorageService: get/set the key `sandboxDebugOutputDir` (a storage
 *     key, NOT a configuration key — Cursor has no `composer.sandbox.*`
 *     config). Scope APPLICATION (W-REA: binary descriptor `pbe("",-1,0)`,
 *     scope -1 = APPLICATION, claim CONFIRMED 100%). Set to the empty string
 *     to disable.
 *   - INotificationService (binary `pi` = notificationService — W-REA
 *     correction: `.info`/`.notify`/`.error` are ALL on this service, not
 *     ILogService as first guessed): `.info("Sandbox debug logging
 *     disabled")` on the disable path; `.error(`Failed to create debug
 *     directory: ...`)` VERBATIM when the folder cannot be created;
 *     `.notify({...})` on the enable path.
 *   - IEnvironmentService + IFileService: on the enable path, resolve
 *     `joinPath(logsHome, "cursor-sandbox-debug")`, create the folder if it
 *     does not exist, and store its `fsPath` under the storage key.
 *   - The enable notification (severity Info) reads "Sandbox debug logging
 *     enabled" with a primary action "Open Debug Directory" that opens the
 *     folder externally and resolves.
 *
 * Glass bundle parity 100% (W-REA): the same class exists verbatim in
 * workbench.glass.main.js — this single core implementation covers both
 * (no separate glass registration needed in the fork).
 *
 * UNKNOWN from the binary: none. The storage TARGET is VERIFIED from the
 * descriptor registry in Cursor 3.25.9's `workbench.desktop.main.js`:
 * `sandboxDebugOutputDir:pbe("",-1,0)` with the helper signature
 * `Jh(e,t=-1,n=0)` = `{defaultValue:e, storageScope:t, storageTarget:n}` and
 * the enum `dwi=(e=>(e[e.USER=0]="USER",e[e.MACHINE=1]="MACHINE",e))`
 * -> scope APPLICATION, target USER (not MACHINE: the stored debug-dir path
 * is user-scoped/synced in Cursor, surprising but verbatim).
 */
// HONEST-DIVERGENCE (fork architecture): the sandbox runtime still lives in
// the ide-agent extension (`extensions/ide-agent/src/sandbox/sandboxService.ts`),
// which cannot read core's APPLICATION+USER storage key through the
// extension API. After replicating Cursor's core behavior above, we ALSO
// notify it via the existing `ide.toggleSandboxDebugLogging` bridge with the
// new enabled flag. Cursor has no such step. The extension's flag starts
// `false` per window and only syncs when this command runs (Cursor's in-core
// sandbox reads the storage key directly, so it never drifts).
export class ComposerToggleSandboxDebugLoggingAction extends Action2 {
	static readonly ID = 'composer.toggleSandboxDebugLogging';
	constructor() {
		super({
			id: ComposerToggleSandboxDebugLoggingAction.ID,
			title: localize2('composer.toggleSandboxDebugLogging', 'Toggle Sandbox Debug Logging'),
			category: Categories.Developer,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const storageService = accessor.get(IStorageService);
		const notificationService = accessor.get(INotificationService);
		const openerService = accessor.get(IOpenerService);
		const fileService = accessor.get(IFileService);
		const environmentService = accessor.get(IEnvironmentService);

		const previousDir = storageService.get(SANDBOX_DEBUG_OUTPUT_DIR_STORAGE_KEY, StorageScope.APPLICATION, '');
		const wasEnabled = !!previousDir;

		if (wasEnabled) {
			// Cursor clears by storing the empty string (not remove()).
			storageService.store(SANDBOX_DEBUG_OUTPUT_DIR_STORAGE_KEY, '', StorageScope.APPLICATION, StorageTarget.USER);
			notificationService.info('Sandbox debug logging disabled');
		} else {
			const debugDirUri = joinPath(environmentService.logsHome, 'cursor-sandbox-debug');
			try {
				if (!(await fileService.exists(debugDirUri))) {
					await fileService.createFolder(debugDirUri);
				}
			} catch (error) {
				// Cursor strips the "Error:" prefix (binary verbatim).
				notificationService.error(`Failed to create debug directory: ${error instanceof Error ? error.message : String(error)}`);
				return;
			}
			const debugDirFsPath = debugDirUri.fsPath;
			storageService.store(SANDBOX_DEBUG_OUTPUT_DIR_STORAGE_KEY, debugDirFsPath, StorageScope.APPLICATION, StorageTarget.USER);
			const openDebugDirAction: IAction = {
				id: 'open-debug-dir',
				label: 'Open Debug Directory',
				tooltip: 'Open Debug Directory',
				class: undefined,
				enabled: true,
				run: () => {
					void openerService.open(URI.file(debugDirFsPath), { openExternal: true });
					return Promise.resolve();
				},
			};
			notificationService.notify({
				severity: Severity.Info,
				message: 'Sandbox debug logging enabled',
				actions: { primary: [openDebugDirAction] },
			});
		}

		// IDE-CODE bridge (NOT in Cursor — see class comment): sync the
		// extension-host sandbox runtime with the new state.
		await accessor.get(ICommandService).executeCommand('ide.toggleSandboxDebugLogging', !wasEnabled);
	}
}

/**
 * Storage key Cursor uses for the sandbox debug output directory
 * (Cursor 3.25.9, workbench.desktop.main.js @29974171). Scope/target choice
 * documented on ComposerToggleSandboxDebugLoggingAction.
 */
const SANDBOX_DEBUG_OUTPUT_DIR_STORAGE_KEY = 'sandboxDebugOutputDir';

export class ComposerRestoreCheckpointAction extends Action2 {
	static readonly ID = 'composer.restoreCheckpoint';
	constructor() {
		super({
			id: ComposerRestoreCheckpointAction.ID,
			title: localize2('composer.restoreCheckpoint', 'Restore Checkpoint…'),
			category: ComposerActionCategory,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.restoreCheckpoint', ...args);
	}
}

export class ComposerToggleTabCompletionAction extends Action2 {
	static readonly ID = 'composer.toggleTabCompletion';
	constructor() {
		super({
			id: ComposerToggleTabCompletionAction.ID,
			title: localize2('composer.toggleTabCompletion', 'Toggle Tab Completion'),
			category: ComposerActionCategory,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.toggleTabCompletion', ...args);
	}
}

export class ComposerSnoozeTabCompletionAction extends Action2 {
	static readonly ID = 'composer.snoozeTabCompletion';
	constructor() {
		super({
			id: ComposerSnoozeTabCompletionAction.ID,
			title: localize2('composer.snoozeTabCompletion', 'Snooze Tab Completion'),
			category: ComposerActionCategory,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.snoozeTabCompletion', ...args);
	}
}

export class ComposerUnsnoozeTabCompletionAction extends Action2 {
	static readonly ID = 'composer.unsnoozeTabCompletion';
	constructor() {
		super({
			id: ComposerUnsnoozeTabCompletionAction.ID,
			title: localize2('composer.unsnoozeTabCompletion', 'Unsnooze Tab Completion'),
			category: ComposerActionCategory,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.unsnoozeTabCompletion', ...args);
	}
}

export class ComposerOpenBrowserAction extends Action2 {
	static readonly ID = 'composer.openBrowser';
	constructor() {
		super({
			id: ComposerOpenBrowserAction.ID,
			title: localize2('composer.openBrowser', 'Open Browser for Agent'),
			category: ComposerActionCategory,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.openBrowser', ...args);
	}
}

export class ComposerOpenBrowserTabAction extends Action2 {
	static readonly ID = 'composer.openBrowserTab';
	constructor() {
		super({
			id: ComposerOpenBrowserTabAction.ID,
			title: localize2('composer.openBrowserTab', 'Open Browser Tab'),
			category: ComposerActionCategory,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.openBrowserTab', ...args);
	}
}

export class ComposerBrowserTabNewTabAction extends Action2 {
	static readonly ID = 'composer.browserTab.newTab';
	constructor() {
		super({
			id: ComposerBrowserTabNewTabAction.ID,
			title: localize2('composer.browserTab.newTab', 'Browser Tab: New Tab'),
			category: ComposerActionCategory,
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyCode.KeyT,
				when: ContextKeyExpr.equals('activeEditor', 'workbench.editor.browser') /* BrowserViewEditorId; IDE-CODE: native browser replaced the ideAgent.browserTab webview */
			},
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.browserTab.newTab', ...args);
	}
}

export class ComposerBrowserTabReloadTabAction extends Action2 {
	static readonly ID = 'composer.browserTab.reloadTab';
	constructor() {
		super({
			id: ComposerBrowserTabReloadTabAction.ID,
			title: localize2('composer.browserTab.reloadTab', 'Browser Tab: Reload'),
			category: ComposerActionCategory,
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyCode.KeyR,
				when: ContextKeyExpr.equals('activeEditor', 'workbench.editor.browser') /* BrowserViewEditorId; IDE-CODE: native browser replaced the ideAgent.browserTab webview */
			},
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.browserTab.reloadTab', ...args);
	}
}

export class ComposerBrowserTabFocusOmnibarAction extends Action2 {
	static readonly ID = 'composer.browserTab.focusOmnibar';
	constructor() {
		super({
			id: ComposerBrowserTabFocusOmnibarAction.ID,
			title: localize2('composer.browserTab.focusOmnibar', 'Browser Tab: Focus Address Bar'),
			category: ComposerActionCategory,
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyCode.KeyL,
				when: ContextKeyExpr.equals('activeEditor', 'workbench.editor.browser') /* BrowserViewEditorId; IDE-CODE: native browser replaced the ideAgent.browserTab webview */
			},
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.browserTab.focusOmnibar', ...args);
	}
}

export class ComposerBrowserTabScreenshotToChatAction extends Action2 {
	static readonly ID = 'composer.browserTab.screenshotToChat';
	constructor() {
		super({
			id: ComposerBrowserTabScreenshotToChatAction.ID,
			title: localize2('composer.browserTab.screenshotToChat', 'Browser Tab: Screenshot to Chat'),
			category: ComposerActionCategory,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.browserTab.screenshotToChat', ...args);
	}
}

export class ComposerBrowserTabTogglePickerAction extends Action2 {
	static readonly ID = 'composer.browserTab.togglePicker';
	constructor() {
		super({
			id: ComposerBrowserTabTogglePickerAction.ID,
			title: localize2('composer.browserTab.togglePicker', 'Browser Tab: Toggle Element Picker'),
			category: ComposerActionCategory,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.browserTab.togglePicker', ...args);
	}
}

export class ComposerBrowserTabCaptureAreaScreenshotAction extends Action2 {
	static readonly ID = 'composer.browserTab.captureAreaScreenshot';
	constructor() {
		super({
			id: ComposerBrowserTabCaptureAreaScreenshotAction.ID,
			title: localize2('composer.browserTab.captureAreaScreenshot', 'Browser Tab: Capture Area Screenshot'),
			category: ComposerActionCategory,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.browserTab.captureAreaScreenshot', ...args);
	}
}

export class ComposerBrowserTabHardReloadAction extends Action2 {
	static readonly ID = 'composer.browserTab.hardReload';
	constructor() {
		super({
			id: ComposerBrowserTabHardReloadAction.ID,
			title: localize2('composer.browserTab.hardReload', 'Browser Tab: Hard Reload'),
			category: ComposerActionCategory,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.browserTab.hardReload', ...args);
	}
}

export class ComposerBrowserTabCopyCurrentUrlAction extends Action2 {
	static readonly ID = 'composer.browserTab.copyCurrentUrl';
	constructor() {
		super({
			id: ComposerBrowserTabCopyCurrentUrlAction.ID,
			title: localize2('composer.browserTab.copyCurrentUrl', 'Browser Tab: Copy Current URL'),
			category: ComposerActionCategory,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.browserTab.copyCurrentUrl', ...args);
	}
}

export class ComposerBrowserTabZoomInAction extends Action2 {
	static readonly ID = 'composer.browserTab.zoomIn';
	constructor() {
		super({
			id: ComposerBrowserTabZoomInAction.ID,
			title: localize2('composer.browserTab.zoomIn', 'Browser Tab: Zoom In'),
			category: ComposerActionCategory,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.browserTab.zoomIn', ...args);
	}
}

export class ComposerBrowserTabZoomOutAction extends Action2 {
	static readonly ID = 'composer.browserTab.zoomOut';
	constructor() {
		super({
			id: ComposerBrowserTabZoomOutAction.ID,
			title: localize2('composer.browserTab.zoomOut', 'Browser Tab: Zoom Out'),
			category: ComposerActionCategory,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.browserTab.zoomOut', ...args);
	}
}

export class ComposerBrowserTabZoomResetAction extends Action2 {
	static readonly ID = 'composer.browserTab.zoomReset';
	constructor() {
		super({
			id: ComposerBrowserTabZoomResetAction.ID,
			title: localize2('composer.browserTab.zoomReset', 'Browser Tab: Reset Zoom'),
			category: ComposerActionCategory,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.browserTab.zoomReset', ...args);
	}
}

export class ComposerBrowserTabClearBrowsingDataAction extends Action2 {
	static readonly ID = 'composer.browserTab.clearBrowsingData';
	constructor() {
		super({
			id: ComposerBrowserTabClearBrowsingDataAction.ID,
			title: localize2('composer.browserTab.clearBrowsingData', 'Browser Tab: Clear Browsing Data'),
			category: ComposerActionCategory,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.browserTab.clearBrowsingData', ...args);
	}
}

export class ComposerBrowserTabOpenDevToolsAction extends Action2 {
	static readonly ID = 'composer.browserTab.openDevTools';
	constructor() {
		super({
			id: ComposerBrowserTabOpenDevToolsAction.ID,
			title: localize2('composer.browserTab.openDevTools', 'Browser Tab: Open DevTools'),
			category: ComposerActionCategory,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.browserTab.openDevTools', ...args);
	}
}

export class ComposerReviewChangesAction extends Action2 {
	static readonly ID = 'composer.reviewChanges';
	constructor() {
		super({
			id: ComposerReviewChangesAction.ID,
			title: localize2('composer.reviewChanges', 'Review Changes with Agent'),
			category: ComposerActionCategory,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.reviewChanges', ...args);
	}
}

export class ComposerFixWithAIAction extends Action2 {
	static readonly ID = 'composer.fixWithAI';
	constructor() {
		super({
			id: ComposerFixWithAIAction.ID,
			title: localize2('composer.fixWithAI', 'Fix with AI'),
			category: ComposerActionCategory,
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyQ,
				when: EditorContextKeys.editorTextFocus
			},
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.fixWithAI', ...args);
	}
}

export class ComposerAddToChatAction extends Action2 {
	static readonly ID = 'composer.addToChat';
	constructor() {
		super({
			id: ComposerAddToChatAction.ID,
			title: localize2('composer.addToChat', 'Add to Chat'),
			category: ComposerActionCategory,
			f1: true,
			keybinding: [
				{
					weight: KeybindingWeight.WorkbenchContrib,
					primary: KeyMod.CtrlCmd | KeyCode.KeyL,
					when: TerminalContextKeys.focus
				},
				{
					weight: KeybindingWeight.WorkbenchContrib,
					primary: KeyMod.CtrlCmd | KeyCode.KeyL,
					when: EditorContextKeys.editorTextFocus
				}
			],
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.addToChat', ...args);
	}
}

/**
 * WORKER-GAPS-38D (`agent-chat-export`): real Cursor-parity chat export — the
 * old delegate stub (`composer.exportTranscript` -> `ide.exportTranscript`) is
 * replaced by the binary's own flow under the binary-verbatim command id
 * `composer.exportChatAsMd`.
 *
 * Binary evidence (Cursor 3.25.6 AND 3.25.9, workbench.glass.main.js, static
 * literal extraction, verified verbatim in both versions):
 * - 3.25.6: descriptor `{id:"composer.exportChatAsMd",
 *   title:{value:"Export Transcript",original:"Export Transcript"},f1:!1,
 *   icon:saveAll,menu:{ViewTitle,group:"1_chatTools",order:1,
 *   when:view-regex(composer) && !composerIsBackgroundMode}}` (class `zxb`,
 *   offset 0x25fa681); run body at offset 0x25fb22d; first id occurrence at
 *   offset 0xf26790.
 * - 3.25.9: `composer.exportChatAsMd` at offset 0xf2690b; the chat title
 *   overflow menu registers `{id:"composer.exportChatAsMd",
 *   label:"Export Transcript"}` (offset 0x1a437fe).
 * - command-telemetry mapping: `["composer.exportChatAsMd","chat_management"]`;
 *   the run body calls `trackEvent("composer.export_chat")`.
 * - run: resolve the composer id (string arg verbatim; active composer
 *   editor's id; Cursor falls back to `selectedComposerId`), then
 *   `resolveComposerIdToSelected` + `getHandleIfLoaded` (unloaded chats
 *   return silently); `"Export is not available for Cloud Agent chats."`
 *   when `createdFromBackgroundAgent?.bcId`; load the conversation from the
 *   first `fullConversationHeadersOnly` bubble with fallback to the loaded
 *   conversation; `"No chat content to export."` when nothing resolves.
 * - Markdown: `# <name>` + `_Exported on <date> at <time> from Cursor
 *   (<version>)_` + `---`; HUMAN bubbles render as `User`, everything else
 *   as `Cursor`; consecutive same-author bubbles group under one
 *   `**User**`/`**Cursor**` heading with `---` separators on author switch;
 *   code blocks render as fenced blocks; ASK_QUESTION tool calls render via
 *   `DiI` (ported verbatim as `renderAskQuestionMarkdown`).
 * - file name: `` `cursor_<slug>.md` `` with the binary's slug algorithm;
 *   default save location `~/Downloads/<file>`; save dialog
 *   `{saveLabel:"Export",title:"Export Transcript",filters:[Markdown/.md]}`;
 *   success notification `Chat exported to <path>` with a primary `Open`
 *   action (`open.exported.chat`, runs `vscode.open`); failures
 *   `Failed to export chat: <message>` / `Could not open save dialog`.
 *
 * Fork mapping:
 * - chat-id resolution reuses `resolveRenameChatTabId` (string arg verbatim,
 *   `ide-chat` URI -> tab id, active `ComposerChatEditorInput` -> tab id).
 * - `getHandleIfLoaded` -> `findOpenComposerChatInput` (only open chats).
 * - the composer data service has no wired fork analog in core, so the
 *   transcript is fetched from the ide-agent extension that owns the chat
 *   data (`ide.getChatExportTranscript`); the binary's Markdown algorithm
 *   itself runs in core, verbatim (`../common/chatExportMarkdown.js`).
 * - HONEST-DIVERGENCES: (1) no `selectedComposerId` fallback (no composer
 *   service in core); (2) no Cloud-Agent guard (no background-agent chats in
 *   the fork); (3) the model-request capture branch (`nxb`, behind an
 *   experiment flag) has no fork analog and is omitted; (4) `cursor_` file
 *   prefix and `from Cursor` header use this fork's product branding
 *   (`ide_code_`, `from IDE Code`); (5) non-human roles (`tool`/`system`)
 *   map to `Cursor` like the binary's non-HUMAN branch; (6) the fork's
 *   bubble text is already Markdown, so `codeBlocks` is empty and selected
 *   ASK_QUESTION answers (which arrive as separate human bubbles) are not
 *   re-rendered with check marks.
 */
export class ComposerExportChatAsMdAction extends Action2 {
	static readonly ID = 'composer.exportChatAsMd';
	/** Transcript provider owned by the ide-agent extension (chat-data owner). */
	static readonly TRANSCRIPT_PROVIDER_COMMAND = 'ide.getChatExportTranscript';
	constructor() {
		super({
			id: ComposerExportChatAsMdAction.ID,
			title: localize2('composer.exportChatAsMd', 'Export Transcript'),
			f1: false,
			icon: Codicon.saveAll,
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const notificationService = accessor.get(INotificationService);
		const dialogService = accessor.get(IDialogService);
		const fileService = accessor.get(IFileService);
		const commandService = accessor.get(ICommandService);
		const environmentService = accessor.get(IEnvironmentService);
		const productService = accessor.get(IProductService);
		const telemetryService = accessor.get(ITelemetryService);
		const logService = accessor.get(ILogService);

		// Binary: string arg verbatim, else the active chat editor's id.
		const tabId = resolveRenameChatTabId(editorService, args[0]);
		if (!tabId) {
			// Verbatim from the binary (3.25.6 and 3.25.9).
			notificationService.info('No chat content to export.');
			return;
		}
		// Binary: `getHandleIfLoaded` — only a loaded chat can be exported.
		const input = findOpenComposerChatInput(editorService, tabId);
		if (!input) {
			return;
		}

		let transcript: ChatExportTranscript | undefined;
		try {
			transcript = await commandService.executeCommand<ChatExportTranscript | undefined>(
				ComposerExportChatAsMdAction.TRANSCRIPT_PROVIDER_COMMAND, tabId);
		} catch (e) {
			logService.error('[composer] Failed to load chat transcript for export', e);
		}
		const messages = transcript?.messages ?? [];
		if (messages.length === 0) {
			notificationService.info('No chat content to export.');
			return;
		}
		const chatName = transcript?.name || input.getName() || 'Untitled Chat';

		const fileName = composerExportFileName(chatName);
		const defaultUri = URI.joinPath(environmentService.userHome, 'Downloads', fileName);
		let target: URI | undefined;
		try {
			target = await dialogService.showSaveDialog({
				saveLabel: 'Export',
				title: 'Export Transcript',
				defaultUri,
				filters: [{ name: 'Markdown', extensions: ['md'] }],
			});
		} catch (e) {
			logService.error('Error in export dialog:', e);
			notificationService.error('Could not open save dialog');
			return;
		}
		if (!target) {
			return; // user cancelled
		}

		const markdown = buildChatExportMarkdown({
			chatName,
			productName: productService.nameShort,
			appVersion: productService.version,
			exportedAt: new Date(),
			messages,
		});
		try {
			await fileService.writeFile(target, VSBuffer.fromString(markdown));
		} catch (e) {
			const detail = e instanceof Error ? e.message : String(e);
			logService.error('[composer] Failed to export chat', e);
			notificationService.error(`Failed to export chat: ${detail}`);
			return;
		}

		// Verbatim notification from the binary, with the primary "Open" action.
		const savedTarget = target;
		notificationService.notify({
			severity: Severity.Info,
			message: `Chat exported to ${savedTarget.fsPath}`,
			actions: {
				primary: [{
					id: 'open.exported.chat',
					label: 'Open',
					tooltip: 'Open exported chat',
					class: undefined,
					enabled: true,
					run: () => commandService.executeCommand('vscode.open', savedTarget),
				}],
			},
		});
		// Binary: `trackEvent("composer.export_chat")`; telemetry category `chat_management`.
		telemetryService.publicLog('composer.export_chat', { commandId: ComposerExportChatAsMdAction.ID });
	}
}

/**
 * WORKER-GAPS-66A (`chat-tab-title-menu-inventory`): the Copy Request ID
 * family, Cursor 3.25.9 binary-verbatim (workbench.desktop.main.js @29931829):
 * - `composer.copyRequestId` (class a2S, title "Copy Request ID", f1:!1) —
 *   resolves the target composer (binary `d2S`/`u2S`), reads
 *   `composerData.latestChatGenerationUUID ?? createdFromBackgroundAgent.bcId`
 *   (binary `Fgm`), then `clipboard.writeText(id ?? "No request ID found")`.
 * - `composer.copyRequestIdFromEditor` (class l2S, f1:!1) — the TITLE-MENU
 *   command: a chat-scheme URI arg becomes `{kind:"composerId",composerId:t.path}`,
 *   anything else becomes `{kind:"editor"}`; both delegate to the base command.
 * Fork mapping: the chat data lives in the ide-agent extension (chat-data
 * owner), so the base command fetches the request id via the provider command
 * `ide.getChatRequestId` — same provider seam as `composer.exportChatAsMd`
 * (`ide.getChatExportTranscript`). The pure resolvers live in
 * `../common/chatTitleMenu.js` (honest d2S simplification noted there).
 */
export class ComposerCopyRequestIdAction extends Action2 {
	static readonly ID = 'composer.copyRequestId';
	/** Request-id provider owned by the ide-agent extension (chat-data owner). */
	static readonly REQUEST_ID_PROVIDER_COMMAND = 'ide.getChatRequestId';
	constructor() {
		super({
			id: ComposerCopyRequestIdAction.ID,
			title: localize2('composer.copyRequestId', 'Copy Request ID'),
			f1: false,
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const commandService = accessor.get(ICommandService);
		const clipboardService = accessor.get(IClipboardService);
		const logService = accessor.get(ILogService);

		const target = resolveCopyRequestIdTarget(args[0], { chatScheme: COMPOSER_CHAT_EDITOR_SCHEME, tabIdFromPath: composerChatTabIdFromPath });
		const active = editorService.activeEditor;
		const tabId = resolveCopyRequestIdTabId(target, active instanceof ComposerChatEditorInput ? active.tabId : undefined);

		let requestId: string | undefined;
		if (tabId) {
			try {
				requestId = await commandService.executeCommand<string | undefined>(
					ComposerCopyRequestIdAction.REQUEST_ID_PROVIDER_COMMAND, tabId);
			} catch (e) {
				logService.error('[composer] Failed to load request id', e);
			}
		}
		// Binary-verbatim (class a2S): `n.writeText(o??"No request ID found")`.
		await clipboardService.writeText(requestId ?? NO_REQUEST_ID_FALLBACK);
	}
}

export class ComposerCopyRequestIdFromEditorAction extends Action2 {
	static readonly ID = 'composer.copyRequestIdFromEditor';
	constructor() {
		super({
			id: ComposerCopyRequestIdFromEditorAction.ID,
			title: localize2('composer.copyRequestIdFromEditor', 'Copy Request ID'),
			f1: false,
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// Binary l2S: URI with the chat scheme -> {kind:"composerId"}, else
		// {kind:"editor"}; then delegate to the base command.
		const target = resolveCopyRequestIdFromEditorTarget(args[0], { chatScheme: COMPOSER_CHAT_EDITOR_SCHEME, tabIdFromPath: composerChatTabIdFromPath });
		await accessor.get(ICommandService).executeCommand(ComposerCopyRequestIdAction.ID, target);
	}
}

/**
 * WORKER-GAPS-66A (`chat-tab-title-menu-inventory`): "Share Transcript",
 * Cursor 3.25.9 binary-verbatim (glass @39835596, class vAb): id
 * `composer.shareChat`, title "Share Transcript", f1:!1, icon link,
 * precondition `isSharedChatsEnabled`. The binary run shares the conversation
 * through Cursor's server (shareConversation + manage-sharing modal); the fork
 * has no share backend, so the run delegates to the ide-agent extension
 * runtime (`ide.shareChat`, which honestly reports unavailability) and the
 * `isSharedChatsEnabled` precondition keeps the menu item hidden until a
 * share backend flips the key — exactly Cursor's unavailable state.
 */
export class ComposerShareChatAction extends Action2 {
	static readonly ID = 'composer.shareChat';
	constructor() {
		super({
			id: ComposerShareChatAction.ID,
			title: localize2('composer.shareChat', 'Share Transcript'),
			f1: false,
			icon: Codicon.link,
			precondition: ComposerContextKeys.isSharedChatsEnabled,
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime (share backend owner).
		await accessor.get(ICommandService).executeCommand('ide.shareChat', ...args);
	}
}

/**
 * WORKER-GAPS-66A (`chat-tab-title-menu-inventory`): "Open in Prompt Quality",
 * Cursor 3.25.9 binary-verbatim id `composer.openPromptQuality`
 * (glass `Lpa`, desktop @29785997): the title-menu entry is INTERNAL-GATED —
 * it is only contributed when `scheme == composer && (isDevelopment || isDevUser)`
 * (desktop `Fpa` @29968468; glass `UGc`). The fork gates the menu item on
 * `isDevelopment` (the `wg` conjunct; `isDevUser` is Cursor-internal with no
 * fork analog). The run delegates to the ide-agent extension's prompt-quality
 * panel (`ide.openPromptQualityPanel` -> services/promptQualityService.ts).
 */
export class ComposerOpenPromptQualityAction extends Action2 {
	static readonly ID = 'composer.openPromptQuality';
	constructor() {
		super({
			id: ComposerOpenPromptQualityAction.ID,
			title: localize2('composer.openPromptQuality', 'Open in Prompt Quality'),
			f1: false,
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime (prompt-quality panel owner).
		await accessor.get(ICommandService).executeCommand('ide.openPromptQualityPanel', ...args);
	}
}

/**
 * WORKER-GAPS-66A (`chat-tab-title-menu-inventory`): the title-menu command is
 * `composer.reportFeedback` — Cursor 3.25.9 binary-verbatim
 * (workbench.desktop.main.js @29935607: `var Bgm=class Jeg extends vt{...id:Jeg.ID,
 * title:"Give Feedback", f1:!1...}; Bgm.ID=lLn`, `lLn="composer.reportFeedback"`).
 * The old fork id `composer.giveFeedback` does NOT exist in the binary
 * (0 hits in both bundles). The binary run resolves the composer, then shows
 * the report-feedback modal with its `latestChatGenerationUUID` (popup
 * fallback); the fork delegates to the ide-agent extension runtime, which
 * persists feedback to ~/.ide-code/feedback/ (its chat-data/feedback owner).
 */
export class ComposerGiveFeedbackAction extends Action2 {
	static readonly ID = 'composer.reportFeedback';
	constructor() {
		super({
			id: ComposerGiveFeedbackAction.ID,
			title: localize2('composer.reportFeedback', 'Give Feedback'),
			f1: false,
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.giveFeedback', ...args);
	}
}

/**
 * WORKER-GAPS-32D (`agent-chat-rename`): real Cursor-parity rename — the old
 * delegate stub (`ide.renameChat`) is replaced by the binary's own flow.
 *
 * Binary evidence (Cursor 3.25.6 AND 3.25.9, workbench.glass.main.js, static
 * literal extraction, verified verbatim in both versions):
 * - `composer.renameChat`: `{id, title:{value:"Rename Chat"},
 *   category: Cursor, f1:!1}`; command-telemetry category `chat_management`.
 * - run: resolve the composer id from (a) a string arg (verbatim), (b) a
 *   `composer`-scheme URI arg (its path, verbatim — no path validation;
 *   a foreign scheme falls through), (c) the active composer editor; warn
 *   `"No chat tab selected to rename."` when none resolves.
 * - current name: `allComposersData.allComposers.find(composerId)?.name ??
 *   getComposerDataIfLoaded(composerId)?.name ?? ""`.
 * - prompt: `quickInput.input({prompt:"Enter new chat name",
 *   placeHolder:"Chat name", value:currentName, ignoreFocusLost:!0}) ?? ""`,
 *   then `.trim()`; no-op when the result is empty or unchanged.
 * - apply: `createdFromBackgroundAgent?.bcId` → `renameBackgroundComposer`;
 *   otherwise `composerService.renameComposer(composerId, name)`.
 * - EditorTitleContext menu: `{id, title:"Rename Chat", icon: edit,
 *   group:"1_chatTools", order:5, when: composer scheme}` (registered in
 *   `registerComposerMenus` below with this fork's group naming).
 *
 * Fork mapping:
 * - `composer` URI scheme        → `ide-chat` scheme (`composerChatTabIdFromUri`).
 * - composer data service        → the open `ComposerChatEditorInput` (the
 *   visible chat identity; `getName()`), fallback `""`. ChatTabService is
 *   migrated but not wired into the workbench, so core has no second source.
 * - `composerService.renameComposer` → `ComposerChatEditorInput.setTitle()`
 *   (updates the editor label + webview title, fires `_onDidChangeLabel`).
 * - HONEST-DIVERGENCE: the `createdFromBackgroundAgent` →
 *   `renameBackgroundComposer` branch has no fork analog (no background-agent
 *   service in core) and is deliberately omitted.
 */
export function resolveRenameChatTabId(editorService: IEditorService, arg: unknown): string | undefined {
	// Cursor's MiI: a string arg is the composer id verbatim (binary 3.25.6 and
	// 3.25.9 return it with NO length check; an empty string falls through to
	// the `!tabId` warn-and-return in `run`, NOT to the active editor).
	if (typeof arg === 'string') {
		return arg;
	}
	// Cursor's MiI: a composer-scheme URI arg contributes its path VERBATIM.
	// Binary 3.25.6 (function `ONS`, workbench.desktop.main.js @~29911960)
	// and 3.25.9 (function `i2S` @~29918155) both do
	// `if (isUri(t) && t.scheme === composerScheme) return t.path;`
	// with NO path validation — so an ide-chat URI whose path fails the
	// fork's tab-id translation (empty, `.`, `..`, nested) must NOT fall
	// through to the active editor. A non-composer scheme DOES fall through
	// (binary-identical).
	if (URI.isUri(arg) && arg.scheme === COMPOSER_CHAT_EDITOR_SCHEME) {
		return composerChatTabIdFromUri(arg) ?? arg.path;
	}
	// Cursor's MiI: the active editor is the composer editor -> its id.
	const active = editorService.activeEditor;
	if (active instanceof ComposerChatEditorInput) {
		return active.tabId;
	}
	return undefined;
}

/**
 * WORKER-GAPS-66A: path -> tab id bridge for the pure common resolvers in
 * `../common/chatTitleMenu.js` (they consume a bare URI path, not a URI).
 */
export function composerChatTabIdFromPath(path: string): string | undefined {
	return composerChatTabIdFromUri(URI.from({ scheme: COMPOSER_CHAT_EDITOR_SCHEME, path }));
}

/** Open composer editor input for a chat tab id (undefined when not open). */
export function findOpenComposerChatInput(editorService: IEditorService, tabId: string): ComposerChatEditorInput | undefined {
	for (const editor of editorService.editors) {
		if (editor instanceof ComposerChatEditorInput && editor.tabId === tabId) {
			return editor;
		}
	}
	return undefined;
}

export class ComposerRenameChatAction extends Action2 {
	static readonly ID = 'composer.renameChat';
	constructor() {
		super({
			id: ComposerRenameChatAction.ID,
			title: localize2('composer.renameChat', 'Rename Chat'),
			f1: false,
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const quickInputService = accessor.get(IQuickInputService);
		const logService = accessor.get(ILogService);

		const tabId = resolveRenameChatTabId(editorService, args[0]);
		if (!tabId) {
			// Verbatim from the binary (3.25.6 and 3.25.9).
			logService.warn('No chat tab selected to rename.');
			return;
		}

		const currentName = findOpenComposerChatInput(editorService, tabId)?.getName() ?? '';
		const renamed = (await quickInputService.input({
			prompt: localize('composer.renameChat.prompt', 'Enter new chat name'),
			placeHolder: localize('composer.renameChat.placeHolder', 'Chat name'),
			value: currentName,
			ignoreFocusLost: true,
		}) ?? '').trim();

		// Cursor: no-op when the input is empty or the name did not change.
		if (!renamed || renamed === currentName) {
			return;
		}

		findOpenComposerChatInput(editorService, tabId)?.setTitle(renamed);
	}
}

/**
 * WORKER-GAPS-66A (`chat-tab-title-menu-inventory`): the title-menu command is
 * `composer.duplicateChat` — Cursor 3.25.9 binary-verbatim
 * (workbench.desktop.main.js @29915583: `var xgm=class extends vt{...id:CWt,
 * title:{value:"Fork Chat"},category:Yn.Cursor,f1:!0...}`, `CWt="composer.duplicateChat"`).
 * The old fork id `composer.forkChat` does NOT exist in the binary (0 hits in
 * both bundles). Binary extras carried over: palette-visible (f1:!0) with the
 * Composer category; the menu entry is `group:"1_chatTools",order:6,when:scheme==composer
 * && !composerEditorTabIsCloudAgent`. The run deep-forks the transcript —
 * still delegated to the ide-agent extension runtime (chat-data owner).
 */
export class ComposerForkChatAction extends Action2 {
	static readonly ID = 'composer.duplicateChat';
	constructor() {
		super({
			id: ComposerForkChatAction.ID,
			title: localize2('composer.duplicateChat', 'Fork Chat'),
			category: ComposerActionCategory,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime (chat-data owner).
		await accessor.get(ICommandService).executeCommand('ide.forkChat', ...args);
	}
}

/**
 * WORKER-GAPS-66A (`chat-tab-title-menu-inventory`): the title-menu command is
 * `chat.openCursorSettings` — Cursor 3.25.9 binary-verbatim
 * (workbench.desktop.main.js @29958167: `var rfm=class ntg extends vt{...id:ntg.ID,
 * title:{value:"Agent Settings"},f1:!1...}; rfm.ID=IBu`, `IBu="chat.openCursorSettings"`).
 * The old fork id `composer.openAgentSettings` does NOT exist in the binary
 * (0 hits in both bundles). The binary run opens Cursor's AI Settings page:
 * `executeCommand("aiSettings.action.open","chat","cursor-settings-chat-composer")`
 * (`cR="aiSettings.action.open"` @478750). The fork has no aiSettings surface,
 * so the run stays delegated to the ide-agent extension runtime, which opens
 * the IDE Agent settings query — documented HONEST-DIVERGENCE.
 */
export class ComposerOpenAgentSettingsAction extends Action2 {
	static readonly ID = 'chat.openCursorSettings';
	constructor() {
		super({
			id: ComposerOpenAgentSettingsAction.ID,
			title: localize2('chat.openCursorSettings', 'Agent Settings'),
			f1: false,
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.openAgentSettings', ...args);
	}
}

export class ComposerPinChatAction extends Action2 {
	static readonly ID = 'composer.pinChat';
	constructor() {
		super({
			id: ComposerPinChatAction.ID,
			title: localize2('composer.pinChat', 'Pin Chat'),
			f1: false,
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		// Cursor 2.1 parity (cursor.com/changelog/page/13): "In the agent
		// sidebar, pin chats at the top for future reference."
		await accessor.get(ICommandService).executeCommand('ide.pinChat', ...args);
	}
}

export class ComposerUnpinChatAction extends Action2 {
	static readonly ID = 'composer.unpinChat';
	constructor() {
		super({
			id: ComposerUnpinChatAction.ID,
			title: localize2('composer.unpinChat', 'Unpin Chat'),
			f1: false,
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.unpinChat', ...args);
	}
}

export class ComposerOpenCustomizeAction extends Action2 {
	static readonly ID = 'composer.openCustomize';
	constructor() {
		super({
			id: ComposerOpenCustomizeAction.ID,
			title: localize2('composer.openCustomize', 'Open Customize'),
			category: ComposerActionCategory,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.openCustomize', ...args);
	}
}

export class WorkbenchOpenCustomizeEditorAction extends Action2 {
	static readonly ID = 'workbench.action.openCustomizeEditor';
	constructor() {
		super({
			id: WorkbenchOpenCustomizeEditorAction.ID,
			title: localize2('workbench.action.openCustomizeEditor', 'Open Customize Editor'),
			category: ComposerActionCategory,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the extension's own alias `ide.openCustomize` (registered
		// programmatically by the ide-agent extension). NEVER call our own ID here —
		// CommandsRegistry shadows the extension's `workbench.action.openCustomizeEditor`
		// registration, so executing our own ID would recurse into this run() forever.
		await accessor.get(ICommandService).executeCommand('ide.openCustomize', ...args);
	}
}

export class WorkbenchCustomizeOpenPluginsAction extends Action2 {
	static readonly ID = 'workbench.action.customize.openPlugins';
	constructor() {
		super({
			id: WorkbenchCustomizeOpenPluginsAction.ID,
			title: localize2('workbench.action.customize.openPlugins', 'Open Plugins'),
			category: ComposerActionCategory,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		// TODO(IDE-CODE): the ide-agent extension does not register an `ide.customize.openPlugins`
		// alias yet — register one there and delegate to it here. NEVER call our own ID
		// `workbench.action.customize.openPlugins`: it is shadowed by this core action and
		// would recurse into this run() forever.
		accessor.get(INotificationService).notify({
			severity: Severity.Error,
			message: localize('workbench.action.customize.openPlugins.notMigrated', 'Open Plugins is not yet migrated to the core runtime.')
		});
	}
}

export class WorkbenchCustomizeOpenMCPsAction extends Action2 {
	static readonly ID = 'workbench.action.customize.openMCPs';
	constructor() {
		super({
			id: WorkbenchCustomizeOpenMCPsAction.ID,
			title: localize2('workbench.action.customize.openMCPs', 'Open MCPs'),
			category: ComposerActionCategory,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		// TODO(IDE-CODE): the ide-agent extension does not register an `ide.customize.openMCPs`
		// alias yet — register one there and delegate to it here. NEVER call our own ID
		// `workbench.action.customize.openMCPs`: it is shadowed by this core action and
		// would recurse into this run() forever.
		accessor.get(INotificationService).notify({
			severity: Severity.Error,
			message: localize('workbench.action.customize.openMCPs.notMigrated', 'Open MCPs is not yet migrated to the core runtime.')
		});
	}
}

export class WorkbenchCustomizeOpenSkillsAction extends Action2 {
	static readonly ID = 'workbench.action.customize.openSkills';
	constructor() {
		super({
			id: WorkbenchCustomizeOpenSkillsAction.ID,
			title: localize2('workbench.action.customize.openSkills', 'Open Skills'),
			category: ComposerActionCategory,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		// TODO(IDE-CODE): the ide-agent extension does not register an `ide.customize.openSkills`
		// alias yet — register one there and delegate to it here. NEVER call our own ID
		// `workbench.action.customize.openSkills`: it is shadowed by this core action and
		// would recurse into this run() forever.
		accessor.get(INotificationService).notify({
			severity: Severity.Error,
			message: localize('workbench.action.customize.openSkills.notMigrated', 'Open Skills is not yet migrated to the core runtime.')
		});
	}
}

export class WorkbenchCustomizeOpenSubagentsAction extends Action2 {
	static readonly ID = 'workbench.action.customize.openSubagents';
	constructor() {
		super({
			id: WorkbenchCustomizeOpenSubagentsAction.ID,
			title: localize2('workbench.action.customize.openSubagents', 'Open Subagents'),
			category: ComposerActionCategory,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		// TODO(IDE-CODE): the ide-agent extension does not register an `ide.customize.openSubagents`
		// alias yet — register one there and delegate to it here. NEVER call our own ID
		// `workbench.action.customize.openSubagents`: it is shadowed by this core action and
		// would recurse into this run() forever.
		accessor.get(INotificationService).notify({
			severity: Severity.Error,
			message: localize('workbench.action.customize.openSubagents.notMigrated', 'Open Subagents is not yet migrated to the core runtime.')
		});
	}
}

export class WorkbenchCustomizeOpenRulesAction extends Action2 {
	static readonly ID = 'workbench.action.customize.openRules';
	constructor() {
		super({
			id: WorkbenchCustomizeOpenRulesAction.ID,
			title: localize2('workbench.action.customize.openRules', 'Open Rules'),
			category: ComposerActionCategory,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		// TODO(IDE-CODE): the ide-agent extension does not register an `ide.customize.openRules`
		// alias yet — register one there and delegate to it here. NEVER call our own ID
		// `workbench.action.customize.openRules`: it is shadowed by this core action and
		// would recurse into this run() forever.
		accessor.get(INotificationService).notify({
			severity: Severity.Error,
			message: localize('workbench.action.customize.openRules.notMigrated', 'Open Rules is not yet migrated to the core runtime.')
		});
	}
}

export class WorkbenchCustomizeOpenCommandsAction extends Action2 {
	static readonly ID = 'workbench.action.customize.openCommands';
	constructor() {
		super({
			id: WorkbenchCustomizeOpenCommandsAction.ID,
			title: localize2('workbench.action.customize.openCommands', 'Open Commands'),
			category: ComposerActionCategory,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		// TODO(IDE-CODE): the ide-agent extension does not register an `ide.customize.openCommands`
		// alias yet — register one there and delegate to it here. NEVER call our own ID
		// `workbench.action.customize.openCommands`: it is shadowed by this core action and
		// would recurse into this run() forever.
		accessor.get(INotificationService).notify({
			severity: Severity.Error,
			message: localize('workbench.action.customize.openCommands.notMigrated', 'Open Commands is not yet migrated to the core runtime.')
		});
	}
}

export class WorkbenchCustomizeOpenHooksAction extends Action2 {
	static readonly ID = 'workbench.action.customize.openHooks';
	constructor() {
		super({
			id: WorkbenchCustomizeOpenHooksAction.ID,
			title: localize2('workbench.action.customize.openHooks', 'Open Hooks'),
			category: ComposerActionCategory,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		// TODO(IDE-CODE): the ide-agent extension does not register an `ide.customize.openHooks`
		// alias yet — register one there and delegate to it here. NEVER call our own ID
		// `workbench.action.customize.openHooks`: it is shadowed by this core action and
		// would recurse into this run() forever.
		accessor.get(INotificationService).notify({
			severity: Severity.Error,
			message: localize('workbench.action.customize.openHooks.notMigrated', 'Open Hooks is not yet migrated to the core runtime.')
		});
	}
}

// DEV-GAPS-9C (2026-10-19): `composer.terminalAiCommand` ("Generate Terminal
// Command with AI", CtrlCmd+Shift+K) is REMOVED — replaced by the verbatim
// Cursor terminal Cmd+K family in browser/terminalCmdkActions.ts
// (`cursorai.action.generateInTerminal` "Generate in Terminal", CtrlCmd+K,
// weight 10200, + hide/cancel/accept/acceptAndRun/reject + model switcher).
// Binary evidence: docs/rea/audit-fix-queue.md run 19:07 (terminal-ai-cmdk).
// Do not re-add a `composer.terminalAiCommand` duplicate.

export class ComposerTerminalRunBackgroundAction extends Action2 {
	static readonly ID = 'composer.terminalRunBackground';
	constructor() {
		super({
			id: ComposerTerminalRunBackgroundAction.ID,
			title: localize2('composer.terminalRunBackground', 'Run Command in Background'),
			category: ComposerActionCategory,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.terminalRunBackground', ...args);
	}
}

export class AiCodeTrackingResetDailyStatsAction extends Action2 {
	static readonly ID = 'aiCodeTracking.resetDailyStats';
	constructor() {
		super({
			id: AiCodeTrackingResetDailyStatsAction.ID,
			title: localize2('aiCodeTracking.resetDailyStats', 'Reset AI Code Tracking Stats'),
			category: ComposerAiCodeTrackingCategory,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('aiCodeTracking.resetDailyStats', ...args);
	}
}

export class ComposerSearchConversationsAction extends Action2 {
	static readonly ID = 'composer.searchConversations';
	constructor() {
		super({
			id: ComposerSearchConversationsAction.ID,
			title: localize2('composer.searchConversations', 'Search Conversations'),
			category: ComposerActionCategory,
			f1: true,
			// DEV-GAPS-45 (chat-conversation-search): REA binary/docs evidence —
			// "Cmd/Ctrl+K in Agents Window searches past chats (3.11+, local
			// index, thousands of conversations)" (deep-docs-all.md:59).
			// The fork's Agents Window equivalent is the chat surface
			// (`chatSurface` = focusedView 'composer.chat' || resourceScheme
			// 'ide-chat'). No conflict with the inline prompt's CtrlCmd+K:
			// that one requires editorTextFocus (disjoint from chatSurface).
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyCode.KeyK,
				when: chatSurface
			},
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.searchConversations', ...args);
	}
}

export class ComposerOpenSettingsAction extends Action2 {
	static readonly ID = 'composer.openSettings';
	constructor() {
		super({
			id: ComposerOpenSettingsAction.ID,
			title: localize2('composer.openSettings', 'Open IDE Agent Settings'),
			category: ComposerActionCategory,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.openSettings', ...args);
	}
}

export class ComposerTriggerTabSuggestionAction extends Action2 {
	static readonly ID = 'composer.triggerTabSuggestion';
	constructor() {
		super({
			id: ComposerTriggerTabSuggestionAction.ID,
			title: localize2('composer.triggerTabSuggestion', 'Trigger Tab Suggestion'),
			category: ComposerTabCategory,
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.Space,
				when: EditorContextKeys.editorTextFocus
			},
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.triggerTabSuggestion', ...args);
	}
}

export class ComposerAcceptTabSuggestionFullAction extends Action2 {
	static readonly ID = 'composer.acceptTabSuggestionFull';
	constructor() {
		super({
			id: ComposerAcceptTabSuggestionFullAction.ID,
			title: localize2('composer.acceptTabSuggestionFull', 'Accept Tab Suggestion'),
			category: ComposerTabCategory,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.acceptTabSuggestionFull', ...args);
	}
}

export class ComposerAcceptTabSuggestionPartialAction extends Action2 {
	static readonly ID = 'composer.acceptTabSuggestionPartial';
	constructor() {
		super({
			id: ComposerAcceptTabSuggestionPartialAction.ID,
			title: localize2('composer.acceptTabSuggestionPartial', 'Accept Next Word of Tab Suggestion'),
			category: ComposerTabCategory,
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyCode.RightArrow,
				mac: { primary: KeyMod.WinCtrl | KeyCode.RightArrow },
				when: ContextKeyExpr.and(InlineCompletionContextKeys.inlineSuggestionVisible, ContextKeyExpr.equals('config.ide.tab.enablePartialAccepts', true))
			},
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.acceptTabSuggestionPartial', ...args);
	}
}

export class ComposerPeekTabSuggestionAction extends Action2 {
	static readonly ID = 'composer.peekTabSuggestion';
	constructor() {
		super({
			id: ComposerPeekTabSuggestionAction.ID,
			title: localize2('composer.peekTabSuggestion', 'Peek Tab Suggestion'),
			category: ComposerTabCategory,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.peekTabSuggestion', ...args);
	}
}

export class ComposerRevertTabSuggestionAction extends Action2 {
	static readonly ID = 'composer.revertTabSuggestion';
	constructor() {
		super({
			id: ComposerRevertTabSuggestionAction.ID,
			title: localize2('composer.revertTabSuggestion', 'Revert Tab Suggestion'),
			category: ComposerTabCategory,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.revertTabSuggestion', ...args);
	}
}

export class ComposerAbortTabRequestsAction extends Action2 {
	static readonly ID = 'composer.abortTabRequests';
	constructor() {
		super({
			id: ComposerAbortTabRequestsAction.ID,
			title: localize2('composer.abortTabRequests', 'Abort Tab Requests'),
			category: ComposerTabCategory,
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.Alt | KeyCode.KeyK,
				when: EditorContextKeys.editorTextFocus
			},
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.abortTabRequests', ...args);
	}
}

export class ComposerEnableTabGloballyAction extends Action2 {
	static readonly ID = 'composer.enableTabGlobally';
	constructor() {
		super({
			id: ComposerEnableTabGloballyAction.ID,
			title: localize2('composer.enableTabGlobally', 'Enable Tab Completion'),
			category: ComposerTabCategory,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.enableTabGlobally', ...args);
	}
}

export class ComposerDisableTabGloballyAction extends Action2 {
	static readonly ID = 'composer.disableTabGlobally';
	constructor() {
		super({
			id: ComposerDisableTabGloballyAction.ID,
			title: localize2('composer.disableTabGlobally', 'Disable Tab Completion'),
			category: ComposerTabCategory,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.disableTabGlobally', ...args);
	}
}

export class ComposerPickTabModelAction extends Action2 {
	static readonly ID = 'composer.pickTabModel';
	constructor() {
		super({
			id: ComposerPickTabModelAction.ID,
			title: localize2('composer.pickTabModel', 'Pick Tab Model…'),
			category: ComposerTabCategory,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.pickTabModel', ...args);
	}
}

export class ComposerToggleTabForLanguageAction extends Action2 {
	static readonly ID = 'composer.toggleTabForLanguage';
	constructor() {
		super({
			id: ComposerToggleTabForLanguageAction.ID,
			title: localize2('composer.toggleTabForLanguage', 'Toggle Tab for Current Language'),
			category: ComposerTabCategory,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.toggleTabForLanguage', ...args);
	}
}

export class ComposerTabStatusClickedAction extends Action2 {
	static readonly ID = 'composer.tabStatusClicked';
	constructor() {
		super({
			id: ComposerTabStatusClickedAction.ID,
			title: localize2('composer.tabStatusClicked', 'IDE Tab Status'),
			category: ComposerTabCategory,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.tabStatusClicked', ...args);
	}
}

export class ComposerOpenAgentsWindowAction extends Action2 {
	static readonly ID = 'composer.openAgentsWindow';
	constructor() {
		super({
			id: ComposerOpenAgentsWindowAction.ID,
			title: localize2('composer.openAgentsWindow', 'Open Agents Window'),
			category: ComposerActionCategory,
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyO,
				when: ContextKeyExpr.and(EditorContextKeys.editorTextFocus.negate(), TerminalContextKeys.focus.negate())
			},
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.openAgentsWindow', ...args);
	}
}

export class ComposerAddSelectionToInlinePromptAction extends Action2 {
	static readonly ID = 'composer.addSelectionToInlinePrompt';
	constructor() {
		super({
			id: ComposerAddSelectionToInlinePromptAction.ID,
			title: localize2('composer.addSelectionToInlinePrompt', 'Add Selection to Inline Prompt'),
			category: ComposerActionCategory,
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyK,
				when: EditorContextKeys.editorTextFocus
			},
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// F2-A: K-08 — attach the selection to the CORE pending-selection
		// slot, then open the core prompt (mirrors the extension's
		// `ide.addSelectionToInlinePrompt` on the core path). Like the
		// extension, the prompt only opens when a selection was attached.
		const core = getCoreInlineEditService(accessor);
		if (core) {
			const selectionService = accessor.get(IInlinePromptSelectionService) as IInlinePromptSelectionService | undefined;
			if (selectionService?.attachPendingSelection()) {
				await core.openPrompt();
			}
			return;
		}
		await accessor.get(ICommandService).executeCommand('ide.addSelectionToInlinePrompt', ...args);
	}
}

// ---------------------------------------------------------------------------
// "Open Chat in X Mode" palette commands — Cursor parity.
// Binary (3.25.9): registerExistingModeActions() registers ONE command per
// getAllModes() entry that has an actionId. getAllModes() filters out
// "spec" and "triage" before the loop, so exactly FIVE commands exist at
// startup. Ids are verbatim (composerMode.agent/plan/chat/debug/multitask;
// note the "chat" mode's display name is "Ask"), title template is
// `Open Chat in ${name} Mode`, f1:!0, NO category. This loop mirrors that
// mechanism in core instead of hand-writing one class per mode. There is no
// "Open Chat in Triage Mode" / "Open Chat in Spec Mode" in Cursor — do not
// add them (see common/composerModeCommands.ts for the adversarial evidence).
// ---------------------------------------------------------------------------
export function registerComposerModeActions(): void {
	for (const def of COMPOSER_MODE_COMMANDS) {
		registerAction2(class extends Action2 {
			constructor() {
				super({
					id: def.actionId,
					title: localize2(composerModeCommandTitleKey(def), buildComposerModeCommandTitle(def.name)),
					f1: true,
				});
			}

			async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
				// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
				await accessor.get(ICommandService).executeCommand(def.extensionCommand, ...args);
			}
		});
	}
}

export class ComposerOpenDocsAction extends Action2 {
	static readonly ID = 'composer.openDocs';
	constructor() {
		super({
			id: ComposerOpenDocsAction.ID,
			title: localize2('composer.openDocs', 'Open IDE Code Documentation'),
			category: ComposerActionCategory,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.openDocs', ...args);
	}
}

export class ComposerFocusChatInputAction extends Action2 {
	static readonly ID = 'composer.focusChatInput';
	constructor() {
		super({
			id: ComposerFocusChatInputAction.ID,
			title: localize2('composer.focusChatInput', 'Focus Chat Input'),
			category: ComposerActionCategory,
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyCode.KeyI,
				when: ComposerContextKeys.chatInputFocused.negate()
			},
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.focusChatInput', ...args);
	}
}

export class ComposerInvestigateErrorAction extends Action2 {
	static readonly ID = 'composer.investigateError';
	constructor() {
		super({
			id: ComposerInvestigateErrorAction.ID,
			title: localize2('composer.investigateError', 'Investigate Error in Chat'),
			category: ComposerActionCategory,
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyD,
				when: EditorContextKeys.editorTextFocus
			},
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.investigateError', ...args);
	}
}

export class ComposerReopenChatTabAction extends Action2 {
	static readonly ID = 'composer.reopenChatTab';
	constructor() {
		super({
			id: ComposerReopenChatTabAction.ID,
			title: localize2('composer.reopenChatTab', 'Reopen Last Closed Chat Tab'),
			category: ComposerActionCategory,
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyT,
				when: ContextKeyExpr.or(chatSurface, ComposerContextKeys.chatInputFocused)
			},
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.reopenChatTab', ...args);
	}
}

// ---------------------------------------------------------------------------
// Commands that had keybindings but no `contributes.commands` entry
// (ide.cycleMode), plus keybindings for commands owned by other core
// contributions (registerAction2 would throw on duplicate ids).
// ---------------------------------------------------------------------------

export class ComposerCycleModeAction extends Action2 {
	static readonly ID = 'composer.cycleMode';
	constructor() {
		super({
			id: ComposerCycleModeAction.ID,
			title: localize2('composer.cycleMode', 'Cycle Mode'),
			category: ComposerActionCategory,
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.Shift | KeyCode.Tab,
				when: ContextKeyExpr.or(chatSurface, ComposerContextKeys.chatInputFocused)
			},
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.cycleMode', ...args);
	}
}

// workbench.action.focusActiveEditorGroup: owned by core already — keybinding only.

// workbench.action.terminal.focus: owned by core already — keybinding only.

// workbench.action.toggleDevTools: owned by core already — keybinding only.

// ---------------------------------------------------------------------------
// Commands registered in code but missing from package.json contributes
// (CAT-D audit): extension.ts COMMANDS-array-only entries (ide.applyWorktree,
// ide.generateGitCommitMessage), the native-browser bridge command
// (ide.browserAttachToChat, extension.ts:821), and the MCP service commands
// (ide.mcp.*, mcp/service.ts). Same delegation pattern as above.
// ---------------------------------------------------------------------------

export class ComposerApplyWorktreeAction extends Action2 {
	static readonly ID = 'composer.applyWorktree';
	constructor() {
		super({
			id: ComposerApplyWorktreeAction.ID,
			title: localize2('composer.applyWorktree', 'Apply Worktree…'),
			category: ComposerActionCategory,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.applyWorktree', ...args);
	}
}

export class ComposerGenerateGitCommitMessageAction extends Action2 {
	static readonly ID = 'composer.generateGitCommitMessage';
	constructor() {
		super({
			id: ComposerGenerateGitCommitMessageAction.ID,
			// DEV-GAPS-54 (ai-commit-message-generation): Cursor's verbatim title
			// "Generate Commit Message" (cursor.generateGitCommitMessage, f1 palette,
			// sparkle icon). Delegates to the ide-agent runtime `ide.generateGitCommitMessage`.
			title: localize2('composer.generateGitCommitMessage', 'Generate Commit Message'),
			category: ComposerActionCategory,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.generateGitCommitMessage', ...args);
	}
}

export class ComposerBrowserAttachToChatAction extends Action2 {
	static readonly ID = 'composer.browserAttachToChat';
	constructor() {
		super({
			id: ComposerBrowserAttachToChatAction.ID,
			title: localize2('composer.browserAttachToChat', 'Attach Native Browser Payload to Chat'),
			category: ComposerActionCategory,
			f1: false,
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		// Internal command: the fork's native Integrated Browser routes chat attachments
		// through this (bridge in browserEditorChatFeatures.ts).
		await accessor.get(ICommandService).executeCommand('ide.browserAttachToChat', ...args);
	}
}

export class ComposerMcpRestartServerAction extends Action2 {
	static readonly ID = 'composer.mcp.restartServer';
	constructor() {
		super({
			id: ComposerMcpRestartServerAction.ID,
			title: localize2('composer.mcp.restartServer', 'Restart MCP Server'),
			category: ComposerActionCategory,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.mcp.restartServer', ...args);
	}
}

export class ComposerMcpShowOutputAction extends Action2 {
	static readonly ID = 'composer.mcp.showOutput';
	constructor() {
		super({
			id: ComposerMcpShowOutputAction.ID,
			title: localize2('composer.mcp.showOutput', 'Show MCP Output'),
			category: ComposerActionCategory,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.mcp.showOutput', ...args);
	}
}

export class ComposerMcpRefreshServersAction extends Action2 {
	static readonly ID = 'composer.mcp.refreshServers';
	constructor() {
		super({
			id: ComposerMcpRefreshServersAction.ID,
			title: localize2('composer.mcp.refreshServers', 'Refresh MCP Servers'),
			category: ComposerActionCategory,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.mcp.refreshServers', ...args);
	}
}

// ---------------------------------------------------------------------------
// Registration entry points (called from composer.contribution.ts).
// ---------------------------------------------------------------------------

/** Register all composer Action2 commands (migrated from package.json contributes.commands). */
export function registerComposerActions(): void {
	// WORKER-GAPS-22A: the New Agent command family first (binary-verbatim
	// `glass.newAgent*` ids) — kept separate from the "New Chat Tab" surface.
	registerNewAgentActions();
	// WORKER-GAPS-34C (inline-edit-command-ids): the Cursor inline-diff
	// accept/reject/cancel family with binary-verbatim
	// `editor.action.inlineDiffs.*` ids (replaces the old
	// `composer.acceptInlineEdit` / `composer.rejectInlineEdit` /
	// `composer.acceptPartialInlineEdit` / `composer.rejectPartialInlineEdit`
	// actions, which used the wrong command family).
	registerInlineDiffActions();
	registerAction2(ComposerNewChatAction);
	registerAction2(ComposerNewFollowupAction);
	registerAction2(ComposerNewAgentChatAction);
	registerAction2(ComposerOpenInlinePromptAction);
	registerAction2(ComposerSendToAgentAction);
	registerAction2(AipopupClosePromptBarAction);
	registerAction2(AipopupCloseActiveEditorPromptBarsAction);
	registerAction2(CmdkTogglePromptBarModelAction);
	// WORKER W60C (`cmdk-next-prompt-bar`): Cursor 3.25.9 glass parity —
	// `aipopup.action.nextPromptBar` (cycles focus between open Cmd+K
	// prompt bars) and its executeCommand target
	// `aipopup.action.focusEdit`.
	registerAction2(AipopupNextPromptBarAction);
	registerAction2(AipopupFocusEditAction);
	// DEV-GAPS-68 (`cmdk-insert-edit-selection`): Cursor 3.25.9 glass parity —
	// `aipopup.action.insertEditSelection` ("Insert Edit Selection", f1:!0,
	// no keybinding, @40742061) — appends the current selection to the open
	// prompt bar and focuses it.
	registerAction2(AipopupInsertEditSelectionAction);
	registerAction2(ComposerNextInlineChangeAction);
	registerAction2(ComposerPreviousInlineChangeAction);
	registerAction2(ComposerNextInlineDiffFileAction);
	registerAction2(ComposerPreviousInlineDiffFileAction);
	registerAction2(ComposerOpenModeMenuAction);
	registerAction2(ComposerOpenModelPickerAction);
	registerAction2(ComposerCycleModelAction);
	registerAction2(ComposerCycleModelParameterAction);
	registerAction2(ComposerFocusAgentAction);
	registerFocusAgentAlias();
	registerAction2(ComposerManageModelsAction);
	registerAction2(ComposerToggleChatAsEditorAction);
	registerAction2(GlassEnterEditorPanelFullscreenAction);
	registerAction2(GlassExitEditorPanelFullscreenAction);
	registerAction2(ComposerNextChatTabAction);
	registerAction2(ComposerPreviousChatTabAction);
	registerAction2(ComposerSelectNextChatAction);
	registerAction2(ComposerSelectPreviousChatAction);
	registerAction2(ComposerSelectNextSubagentTabAction);
	registerAction2(ComposerSelectPreviousSubagentTabAction);
	registerAction2(ComposerCloseChatTabAction);
	registerAction2(ComposerClearComposerTabsAction);
	registerAction2(ComposerCloseOtherComposerTabsAction);
	registerAction2(ComposerCancelComposerStepAction);
	registerAction2(ComposerCancelComposerStepInputFocusedAction);
	registerAction2(ComposerCancelChatAction);
	// FEATURE-1 (`agent-accept-pending-decisions`): `composer.acceptComposerStep`
	// ("Accept pending agent pane action", 3.25.9 @39863346) — registered
	// right after the cancel family (binary class order NAb/LAb region).
	registerAction2(ComposerAcceptComposerStepAction);
	registerAction2(ComposerFindInChatAction);
	registerAction2(ComposerHideFindInChatAction);
	registerAction2(ComposerFindNextInChatAction);
	registerAction2(ComposerFindPreviousInChatAction);
	registerFindInChatAliases();
	registerAction2(ComposerOpenAddContextMenuAction);
	registerAction2(ComposerApprovePendingShellToolDecisionAction);
	registerAction2(ComposerApprovePendingShellToolDecisionAllowlistAction);
	registerAction2(ComposerSkipPendingShellToolDecisionAction);
	registerAction2(ComposerCancelTerminalToolCallAction);
	registerAction2(ComposerWorktreeCommandAction);
	registerAction2(ComposerDeleteWorktreeAction);
	registerAction2(ComposerListWorktreesAction);
	registerAction2(ComposerFocusEditorFromDiffAction);
	registerComposerAcceptPlanCommand();
	registerComposerSplitEditorWithNewComposerCommand();
	registerAction2(ComposerToggleSandboxDebugLoggingAction);
	registerAction2(ComposerRestoreCheckpointAction);
	registerAction2(ComposerToggleTabCompletionAction);
	registerAction2(ComposerSnoozeTabCompletionAction);
	registerAction2(ComposerUnsnoozeTabCompletionAction);
	registerAction2(ComposerOpenBrowserAction);
	registerAction2(ComposerOpenBrowserTabAction);
	registerAction2(ComposerBrowserTabNewTabAction);
	registerAction2(ComposerBrowserTabReloadTabAction);
	registerAction2(ComposerBrowserTabFocusOmnibarAction);
	registerAction2(ComposerBrowserTabScreenshotToChatAction);
	registerAction2(ComposerBrowserTabTogglePickerAction);
	registerAction2(ComposerBrowserTabCaptureAreaScreenshotAction);
	registerAction2(ComposerBrowserTabHardReloadAction);
	registerAction2(ComposerBrowserTabCopyCurrentUrlAction);
	registerAction2(ComposerBrowserTabZoomInAction);
	registerAction2(ComposerBrowserTabZoomOutAction);
	registerAction2(ComposerBrowserTabZoomResetAction);
	registerAction2(ComposerBrowserTabClearBrowsingDataAction);
	registerAction2(ComposerBrowserTabOpenDevToolsAction);
	registerAction2(ComposerReviewChangesAction);
	registerAction2(ComposerFixWithAIAction);
	registerAction2(ComposerAddToChatAction);
	registerAction2(ComposerExportChatAsMdAction);
	// WORKER-GAPS-66A (`chat-tab-title-menu-inventory`): Cursor 3.25.9
	// title-menu commands — `composer.copyRequestIdFromEditor` (the menu's
	// Copy Request ID), `composer.shareChat` ("Share Transcript"),
	// `composer.openPromptQuality` (internal-gated).
	registerAction2(ComposerCopyRequestIdFromEditorAction);
	registerAction2(ComposerShareChatAction);
	registerAction2(ComposerOpenPromptQualityAction);
	registerAction2(ComposerCopyRequestIdAction);
	registerAction2(ComposerGiveFeedbackAction);
	registerAction2(ComposerRenameChatAction);
	registerAction2(ComposerForkChatAction);
	registerAction2(ComposerOpenAgentSettingsAction);
	registerAction2(ComposerPinChatAction);
	registerAction2(ComposerUnpinChatAction);
	registerAction2(ComposerOpenCustomizeAction);
	registerAction2(WorkbenchOpenCustomizeEditorAction);
	registerAction2(WorkbenchCustomizeOpenPluginsAction);
	registerAction2(WorkbenchCustomizeOpenMCPsAction);
	registerAction2(WorkbenchCustomizeOpenSkillsAction);
	registerAction2(WorkbenchCustomizeOpenSubagentsAction);
	registerAction2(WorkbenchCustomizeOpenRulesAction);
	registerAction2(WorkbenchCustomizeOpenCommandsAction);
	registerAction2(WorkbenchCustomizeOpenHooksAction);
	// DEV-GAPS-9C: ComposerTerminalAiCommandAction removed — replaced by the
	// verbatim `cursorai.action.*` terminal Cmd+K family (registerTerminalCmdkActions).
	registerAction2(ComposerTerminalRunBackgroundAction);
	registerAction2(AiCodeTrackingResetDailyStatsAction);
	registerAction2(ComposerSearchConversationsAction);
	registerAction2(ComposerOpenSettingsAction);
	registerAction2(ComposerTriggerTabSuggestionAction);
	registerAction2(ComposerAcceptTabSuggestionFullAction);
	registerAction2(ComposerAcceptTabSuggestionPartialAction);
	registerAction2(ComposerPeekTabSuggestionAction);
	registerAction2(ComposerRevertTabSuggestionAction);
	registerAction2(ComposerAbortTabRequestsAction);
	registerAction2(ComposerEnableTabGloballyAction);
	registerAction2(ComposerDisableTabGloballyAction);
	registerAction2(ComposerPickTabModelAction);
	registerAction2(ComposerToggleTabForLanguageAction);
	registerAction2(ComposerTabStatusClickedAction);
	registerAction2(ComposerOpenAgentsWindowAction);
	registerAction2(ComposerAddSelectionToInlinePromptAction);
	// IDE-CODE: Cursor parity — "Open Chat in X Mode" palette commands are
	// registered by a loop mirroring the binary's registerExistingModeActions()
	// (exactly 5: agent/plan/chat/debug/multitask; NO triage/spec).
	registerComposerModeActions();
	registerAction2(ComposerOpenDocsAction);
	registerAction2(ComposerFocusChatInputAction);
	registerAction2(ComposerInvestigateErrorAction);
	registerAction2(ComposerReopenChatTabAction);
	registerAction2(ComposerCycleModeAction);
	registerAction2(ComposerApplyWorktreeAction);
	registerAction2(ComposerGenerateGitCommitMessageAction);
	registerAction2(ComposerBrowserAttachToChatAction);
	registerAction2(ComposerMcpRestartServerAction);
	registerAction2(ComposerMcpShowOutputAction);
	registerAction2(ComposerMcpRefreshServersAction);
	// DEV-GAPS-18-W4 (`agent-worktree-chat-actions`): the three worktree
	// chat-tab overflow commands (Cursor 3.25.9 ids/labels verbatim).
	registerComposerWorktreeActions();
}

/** Register keybindings for commands owned by other core contributions. */
export function registerComposerKeybindings(): void {
	KeybindingsRegistry.registerKeybindingRule({
		id: 'workbench.action.focusActiveEditorGroup',
		weight: KeybindingWeight.WorkbenchContrib,
		primary: KeyMod.Alt | KeyCode.KeyI
	});
	KeybindingsRegistry.registerKeybindingRule({
		id: 'workbench.action.terminal.focus',
		weight: KeybindingWeight.WorkbenchContrib,
		primary: KeyMod.Alt | KeyCode.KeyL,
		when: TerminalContextKeys.focus.negate()
	});
	KeybindingsRegistry.registerKeybindingRule({
		id: 'workbench.action.toggleDevTools',
		weight: KeybindingWeight.WorkbenchContrib,
		primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyI,
		mac: { primary: KeyMod.WinCtrl | KeyMod.Alt | KeyCode.KeyI }
	});
}

/**
 * Register composer menus (migrated from package.json contributes.menus).
 *
 * - `view/title`: New Chat on the sessions view, Open Customize on the chat view.
 * - chat editor tab title menu for the `ide-chat` scheme (WORKER-GAPS-66A):
 *   data-driven from the Cursor 3.25.9 `Opa` inventory in
 *   `../common/chatTitleMenu.js` — appended to BOTH `editor/title/context`
 *   and `editor/title` (rename/fork/move-into-new-window to `editor/title/context`
 *   only), groups `1_chatTools`/`2_moreActions`/`5z_new_window`, verbatim orders.
 * - `editor/context`: Add to Chat on editor selection.
 * - `editor/context`: Add to Chat on editor selection.
 * - `commandPalette` + `when: never` entries are covered by `f1: false` on the
 *   Action2 descriptors instead of a menu registration.
 */
export function registerComposerMenus(): void {
	MenuRegistry.appendMenuItem(MenuId.ViewTitle, {
		group: 'navigation',
		when: ContextKeyExpr.equals('view', COMPOSER_SESSIONS_VIEW_ID),
		command: {
			id: ComposerNewChatAction.ID,
			title: localize('composer.menu.newChat', "New Chat"),
			icon: Codicon.plus,
		}
	});
	MenuRegistry.appendMenuItem(MenuId.ViewTitle, {
		group: 'navigation',
		when: ContextKeyExpr.equals('view', COMPOSER_CHAT_VIEW_ID),
		command: {
			id: ComposerOpenCustomizeAction.ID,
			title: localize('composer.menu.openCustomize', "Open Customize"),
			icon: Codicon.settingsGear,
		}
	});

	// DEV-GAPS-73 (`chat-tab-close-actions`): Cursor 3.25.6 verbatim menu
	// wiring — both commands in the chat VIEW TITLE menu, group
	// '0_chatManage' (binary grep + title recovery; this is the group the
	// ViewTitle more-actions ("...") overflow renders before 'navigation').
	const chatManageWhen = ContextKeyExpr.equals('view', COMPOSER_CHAT_VIEW_ID);
	MenuRegistry.appendMenuItem(MenuId.ViewTitle, {
		group: '0_chatManage@1',
		when: chatManageWhen,
		command: {
			id: ComposerClearComposerTabsAction.ID,
			title: localize('composer.menu.clearComposerTabs', "Close All Tabs"),
		}
	});
	MenuRegistry.appendMenuItem(MenuId.ViewTitle, {
		group: '0_chatManage@2',
		when: chatManageWhen,
		command: {
			id: ComposerCloseOtherComposerTabsAction.ID,
			title: localize('composer.menu.closeOtherComposerTabs', "Close Other Tabs"),
		}
	});

	const ideChatScheme = ContextKeyExpr.equals('resourceScheme', COMPOSER_CHAT_EDITOR_SCHEME);
	// WORKER-GAPS-66A (`chat-tab-title-menu-inventory`): the chat editor tab
	// title menu is data-driven from the COMPLETE Cursor 3.25.9 inventory in
	// `../common/chatTitleMenu.js` (binary `var Opa=[...]` @29968468 desktop /
	// `var BGc=[...]` @39879475 glass — verbatim ids, titles, icons, groups
	// `1_chatTools`/`2_moreActions`/`5z_new_window`, orders). The binary
	// appends the Opa items to BOTH EditorTitleContext and EditorTitle; the
	// rename/fork/move trio goes to EditorTitleContext only. The previous fork
	// wiring (groups `1_chat`/`2_settings`, EditorTitleContext only, wrong
	// orders and wrong command ids) is replaced wholesale.
	const titleMenuIcons: Record<string, Codicon> = {
		saveAll: Codicon.saveAll,
		link: Codicon.link,
		edit: Codicon.edit,
		clone: Codicon.clone,
	};
	const titleMenuLocKeys: Record<string, string> = {
		'composer.exportChatAsMd': 'composer.menu.exportTranscript',
		'composer.shareChat': 'composer.menu.shareTranscript',
		'composer.copyRequestIdFromEditor': 'composer.menu.copyRequestId',
		'composer.reportFeedback': 'composer.menu.giveFeedback',
		'chat.openCursorSettings': 'composer.menu.openAgentSettings',
		'composer.openPromptQuality': 'composer.menu.openPromptQuality',
		'composer.renameChat': 'composer.menu.renameChat',
		'composer.duplicateChat': 'composer.menu.forkChat',
		'workbench.action.moveEditorToNewWindow': 'composer.menu.moveEditorToNewWindow',
	};
	const titleMenuGateWhen = (gate: ChatTitleMenuGate): ContextKeyExpr => {
		switch (gate) {
			case 'schemeAndSharedChats':
				return ContextKeyExpr.and(ideChatScheme, ComposerContextKeys.isSharedChatsEnabled);
			case 'schemeAndNotCloudAgent':
				return ContextKeyExpr.and(ideChatScheme, ComposerContextKeys.chatEditorTabIsCloudAgent.negate());
			case 'schemeAndInternal':
				// Binary: `scheme == composer && (isDevelopment || isDevUser)`;
				// `isDevUser` is Cursor-internal with no fork analog (documented).
				return ContextKeyExpr.and(ideChatScheme, IsDevelopmentContext);
			default:
				return ideChatScheme;
		}
	};
	const appendChatTitleMenuItem = (item: ChatTitleMenuItem): void => {
		for (const target of item.targets) {
			MenuRegistry.appendMenuItem(target === 'EditorTitle' ? MenuId.EditorTitle : MenuId.EditorTitleContext, {
				group: item.group,
				order: item.order,
				when: titleMenuGateWhen(item.gate),
				command: {
					id: item.commandId,
					title: localize(titleMenuLocKeys[item.commandId] ?? `composer.menu.${item.commandId}`, item.title),
					...(item.iconCodicon && titleMenuIcons[item.iconCodicon] ? { icon: titleMenuIcons[item.iconCodicon] } : {}),
					// Binary puts the can-rename gate on the COMMAND descriptor
					// (`{command:{id:aHi,...,precondition:VXi}}`), not the item.
					...(item.precondition === 'composerEditorTabCanRename' ? { precondition: ComposerContextKeys.chatEditorTabCanRename } : {}),
				}
			});
		}
	};
	for (const item of CHAT_TAB_TITLE_MENU_ITEMS) {
		if (!item.includeInFork) {
			// `developer.exportChat` — dev-gated, skipped per audit-fix-queue triage.
			continue;
		}
		appendChatTitleMenuItem(item);
	}

	// Fork-only additions (NOT in Cursor's Opa): Pin/Unpin Chat (Cursor 2.1
	// parity, sidebar feature) and the three worktree items (Cursor gates them
	// in its chat-tab overflow builder `sSv`; the fork shows them here). Kept
	// at trailing orders so the binary orders 1-6 stay verbatim.
	const worktreeMenuWhen = ContextKeyExpr.and(ideChatScheme, ComposerContextKeys.chatHasWorktree);
	const forkExtraMenuItems: Array<{ id: string; title: string; locKey: string; order: number; when?: ContextKeyExpr }> = [
		{ id: ComposerPinChatAction.ID, title: 'Pin Chat', locKey: 'composer.menu.pinChat', order: 7 },
		{ id: ComposerUnpinChatAction.ID, title: 'Unpin Chat', locKey: 'composer.menu.unpinChat', order: 8 },
		{ id: ComposerCopyWorktreePathAction.ID, title: 'Copy worktree path', locKey: 'composer.menu.copyWorktreePath', order: 9, when: worktreeMenuWhen },
		{ id: ComposerOpenTerminalInWorktreeAction.ID, title: 'Open terminal in worktree', locKey: 'composer.menu.openTerminalInWorktree', order: 10, when: worktreeMenuWhen },
		{ id: ComposerOpenNewWindowInWorktreeAction.ID, title: 'Open new window in worktree', locKey: 'composer.menu.openNewWindowInWorktree', order: 11, when: worktreeMenuWhen },
	];
	for (const item of forkExtraMenuItems) {
		MenuRegistry.appendMenuItem(MenuId.EditorTitleContext, {
			group: '1_chatTools',
			order: item.order,
			when: item.when ?? ideChatScheme,
			command: {
				id: item.id,
				title: localize(item.locKey, item.title),
			}
		});
	}

	MenuRegistry.appendMenuItem(MenuId.EditorContext, {
		group: 'ideAgent@1',
		when: EditorContextKeys.hasNonEmptySelection,
		command: {
			id: ComposerAddToChatAction.ID,
			title: localize('composer.menu.addToChat', "Add to Chat"),
		}
	});
}
