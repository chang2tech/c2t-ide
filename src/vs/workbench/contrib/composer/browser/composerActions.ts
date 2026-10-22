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

import { ILocalizedString, localize, localize2 } from '../../../../nls.js';
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
import { CHAT_FIND_KEYBINDING_WEIGHT } from '../common/chatFindPane.js';
import { PLAN_FIND_KEYBINDING_WEIGHT } from '../common/planFindPane.js';
import {
	CHAT_TAB_TITLE_MENU_ITEMS,
	ChatTitleMenuGate,
	ChatTitleMenuItem,
	NO_REQUEST_ID_FALLBACK,
	resolveCopyRequestIdFromEditorTarget,
	resolveCopyRequestIdTabId,
	resolveCopyRequestIdTarget,
} from '../common/chatTitleMenu.js';
import { InputFocusedContext, IsDevelopmentContext } from '../../../../platform/contextkey/common/contextkeys.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { COMPOSER_MODE_COMMANDS, buildComposerModeCommandTitle } from '../common/composerModeCommands.js';
import { IInlineEditPromptBar, RESOLVE_CONFLICT_INIT_TEXT, createPromptBarDataSelection, resolveModalGenerateTarget, resolveSameUriOverrideTarget, selectNewestPromptBarIdForUri, selectNextPromptBarId, setPromptBarTextAndSubmit } from '../common/inlineEditPromptBar.js';
import { Range } from '../../../../editor/common/core/range.js';
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
import { AgentActionCategory, registerNewAgentActions } from './newAgentActions.js';
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
/**
 * Localized "Cursor" category for the command palette. Binary-verbatim
 * `Yn.Cursor` (workbench.desktop.main.js 3.25.9 @29915583) — commands like
 * `composer.duplicateChat` show as "Cursor: ..." in the palette, NOT
 * "Composer: ...".
 */
export const CursorActionCategory = localize2('composer.cursorCategory', 'Cursor');
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

/**
 * W69C (`changes-tab-base-branch-menu`): binary-verbatim keybinding
 * weight 600 for `cursor.openBranchMenu` ("Open Branch Menu",
 * workbench.glass.main.js 3.25.9 class JXl @27418510 —
 * `keybinding:{primary:dt.CtrlCmd|Xe.Quote,weight:600,
 * when:ft.has("composerFocused")}`). Same raw-600 cast pattern as the
 * accept family above. NOTE: the audit queue's run-34 entry omitted this
 * keybinding — the binary registration carries it verbatim (W69C
 * re-verified the class literal directly in the 3.25.9 bundle).
 */
const openBranchMenuKeybindingWeight = 600 as KeybindingWeight;

/**
 * DEV-GAPS-106B (`chat-history-command-palette`): binary-verbatim
 * keybinding weight 500 for `composer.showComposerHistory`
 * ("Show Chat History", workbench.desktop.main.js 3.25.9 class Rgm
 * @29919589 — `keybinding:{primary:Me.CtrlCmd|Me.Alt|ve.Quote,
 * weight:500}`). Same raw-value cast pattern as the weights above.
 */
const showComposerHistoryKeybindingWeight = 500 as KeybindingWeight;



/**
 * DEV-GAPS-81 (F3, QA GAPS-79C): binary-verbatim keybinding weight 410 for
 * `composer.newFollowup` ("Focus Chat Followup", binary id
 * `aichat.newfollowupaction`, workbench.glass.main.js 3.25.9 @39814626 —
 * `keybinding:{primary:JiI,weight:410}` with NO when-clause, where
 * `JiI = isMac ? CtrlCmd|Shift|KeyY : CtrlCmd|KeyY`). 410 sits just above
 * this fork's `KeybindingWeight` enum max (400 = ExternalExtension), so the
 * raw value is cast — the same pattern as `shellApprovalKeybindingWeight`
 * (DEV-GAPS-12). With no when-clause the chord is a candidate everywhere,
 * and 410 outranks the editor's Redo binding (CtrlCmd+KeyY at
 * KeybindingWeight.EditorCore = 0, editor/browser/editorExtensions.ts) —
 * so on win/linux Ctrl+Y focuses the chat follow-up instead of redoing,
 * exactly Cursor's resolution; Redo stays reachable via its secondary
 * chord CtrlCmd+Shift+KeyZ. On mac there is no collision at all (mac Redo
 * primary is CtrlCmd+Shift+KeyZ; the binary's mac chord is
 * CtrlCmd+Shift+KeyY).
 */
const newFollowupKeybindingWeight = 410 as KeybindingWeight;

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
			// DEV-GAPS-81 (F3): binary-verbatim binding — weight 410, NO
			// when-clause, mac primary CtrlCmd+Shift+KeyY (binary JiI is a
			// platform ternary on the single primary; the `mac:` override
			// is this fork's equivalent idiom, cf. line ~1001/1486).
			keybinding: {
				weight: newFollowupKeybindingWeight,
				primary: KeyMod.CtrlCmd | KeyCode.KeyY,
				mac: { primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyY }
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
// TEMP-GUARD (GAPS-663, biến thể B của lát cắt :161) + đính chính comment
// cũ: trên desktop workbench (instantiation strict, workbench.ts:192),
// `accessor.get` cho service chưa đăng ký NÉM (instantiationService.ts:104)
// thay vì trả undefined. try/catch dưới đây biến "service vắng" thành
// undefined đúng như các call-site giả định — cùng idiom với
// createRuleActions.ts:99-104 và getPlanService (composerPlanBridge.ts:55-61).
// Khi đó các action rơi về fallback legacy `ide.*` của extension như thiết
// kế web/aux. Bỏ try/catch khi IInlineEditService lại được đăng ký vô điều
// kiện (port IPC xong, khôi phục :161).
function getCoreInlineEditService(accessor: ServicesAccessor): IInlineEditService | undefined {
	try {
		return accessor.get(IInlineEditService);
	} catch {
		return undefined; // IInlineEditService not registered in this layer (electron-browser contribution not loaded)
	}
}

/** TEMP-GUARD (GAPS-663): như getCoreInlineEditService — IInlinePromptSelectionService
 *  (electron-browser/composer.contribution.ts:56) có thể vắng mặt độc lập với
 *  IInlineEditService trong giai đoạn port IPC từng phần; strict DI ném thay
 *  vì trả undefined như call-site của ComposerAddSelectionToInlinePromptAction
 *  giả định qua `?.`. */
function getInlinePromptSelectionService(accessor: ServicesAccessor): IInlinePromptSelectionService | undefined {
	try {
		return accessor.get(IInlinePromptSelectionService);
	} catch {
		return undefined; // IInlinePromptSelectionService not registered in this layer
	}
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
			// Binary parity: NO category, NO `f1`. Cursor 3.25.9 registers
			// `aipopup.action.closePromptBar` as {id, title, precondition,
			// keybinding:{when:editorTextFocus, primary:Escape, weight:2105}}
			// only — the super call carries NO `f1` field at all (glass
			// class Qfy super @40742729, desktop class ktg super
			// @32239238, re-sliced by W73C; glass and desktop agree).
			// `f1` is therefore OMITTED here (registerAction2 only adds a
			// Command Palette entry `if (f1)`), so the action stays out of
			// the palette exactly like the binary. Fork previously invented
			// ComposerActionCategory here (removed per W69B) and wrongly
			// set `f1: true` (removed per W73C).
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
	static readonly ID = 'workbench.action.closeActiveEditorPromptBars';
	constructor() {
		super({
			id: AipopupCloseActiveEditorPromptBarsAction.ID,
			title: localize2('workbench.action.closeActiveEditorPromptBars', 'Close Active Editor Prompt Bars'),
			// Binary parity: NO category. Cursor registers the tier-2 Esc as
			// `workbench.action.closeActiveEditorPromptBars` (not
			// `aipopup.action.*`) with {id, title, f1:!1,
			// keybinding:[{primary:Escape, weight:100,
			// when:editorHasPromptBar && !editorPromptBarFocused &&
			// editorTextFocus}]} only — no `category` (3.25.9 glass super
			// @40751517 with `.ID="workbench.action.closeActiveEditorPromptBars"`
			// @40752018, desktop super @32248026 with `.ID` @32248527,
			// re-sliced by W73C; glass and desktop agree on id and f1).
			// Fork previously invented ComposerActionCategory here
			// (removed per W69B), used the wrong `aipopup.action.*` id and
			// wrongly set `f1: true` (both fixed per W73C: id renamed to
			// the binary's `workbench.action.*`, f1:!1 = false — hidden
			// from the Command Palette).
			f1: false,
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

// ---- MODAL GENERATE / StartEditPrompt (Cursor 3.25.9 parity,
// feature_id `inline-edit-keybindings-gap` remainder, GAPS-171).
// Binary evidence (re-sliced by GAPS-171 from BOTH 3.25.9 bundles):
// - glass class `goo` (super @40731968): `vtt="aipopup.action.modal.generate"`
//   (const @1136848), `Y2b="Open Edit (Command K)"` (@40718363), f1:!0,
//   NO category, precondition `arf.negate()` with
//   `arf=new pn("composerBarIsVisible",!1)` (@17969685), keybinding:
//     [{when: nPb.isEqualTo(!0), primary: tPb, weight: 1401,
//       args: {invocationType: "toggle"}},
//      {when: nPb.isEqualTo(!0) || pil.isEqualTo(!0),
//       primary: dt.CtrlCmd|Xe.KeyK, weight: 1401,
//       args: {invocationType: "new"}}]
//   with `tPb=dt.CtrlCmd|dt.Shift|Xe.KeyK` (@40731457),
//   `nPb=new pn("editorFocus",!0)` (@40731489 — VS Code's own `editorFocus`
//   key = `EditorContextKeys.focus`, NOT editorTextFocus),
//   `pil=new pn("editcontextbarcursor",!1)` (@18093186).
// - desktop class `SLr` @32228473 is identical (vars `l9e`/`_wm`/`Twm`/`Cwm`/`bSo`/`mdh`).
// - registerAction2 ANDs the action precondition into each keybinding's
//   when (platform/actions), so the binary's precondition gates the chords
//   exactly like the binary's command precondition does.
// - Weight 1401 is cast verbatim (the inlineDiffActions 500/600 pattern —
//   the fork's KeybindingWeight enum tops out at 400). 1401 sits below
//   `editor.action.inlineDiffs.focusEditor`'s 1402, so while the prompt bar
//   is focused both chords return focus to the editor instead of generating.
// - CHORD REASSIGNMENT (per binary, GAPS-171): CtrlCmd+Shift+K previously
//   belonged to `composer.addSelectionToInlinePrompt` (fork-only id —
//   0 hits in both binary bundles). That action keeps its command, handler
//   and palette entry but loses the chord; upstream
//   `editor.action.deleteLines` (Ctrl+Shift+K, EditorContrib) is likewise
//   shadowed in the editor, exactly as in Cursor (1401 > 100).
//   `composer.openInlinePrompt`'s Ctrl+K (WorkbenchContrib, editorTextFocus)
//   is also shadowed by the 1401 "new" rule when the editor is focused —
//   the create path below delegates to the same `IInlineEditService.openPrompt()`,
//   so the user-visible behavior is unchanged.
// - Run body maps the binary's StartEditPrompt decision order onto fork
//   plumbing (the pure decision lives in common `resolveModalGenerateTarget`):
//   same-uri bar → insertEditSelection (selection non-empty) / focusEdit;
//   toggle + promptBarId arg → nextPromptBar; else create via the core
//   inline-edit service (fork's StartEditPrompt-create path), falling back
//   to the extension's `ide.openInlinePrompt` on web/aux builds.
//   NOT ported (documented divergences, work-notes-gaps171.md):
//   D1 fork has no `composerBarIsVisible`/`editcontextbarcursor` setters
//      (keys added with binary defaults !1 — precondition passes, "new"
//      rule reduces to `editorFocus`);
//   D3 binary toggle's most-recent-bar group-visibility jump + id-reuse
//      quirk (fork refs carry no editorId/group signal; same-uri bars are
//      already caught by the first branch);
//   D4 args `initText`/`overrideUri`/`overrideRange`/`visible` (used by
//      `cmdK.resolveConflictInCmdK`, queue entry #33) — since GAPS-174 the
//      override args ARE consumed: an invocation carrying a URI-typed
//      `overrideUri` + Range-typed `overrideRange` takes the programmatic
//      create path (`IInlineEditService.openPromptForRange`) and returns
//      the new prompt bar's id, exactly like the binary's StartEditPrompt
//      (`return le.id`) — UNLESS a prompt bar is already open for the
//      override uri: since GAPS-189 (QA-185 NF-1) that same-uri branch
//      mirrors the binary too, executing insertEditSelection (override
//      range non-empty, untrimmed) or focusEdit (empty) with the
//      existing bar's id and returning undefined. `initText` seeds the
//      binary's bar record
//      (`data: Z1E(initText)`); the fork's bar has no seeded-data slot, so
//      the consumer (`CmdKResolveConflictInCmdKAction`) sets the text via
//      the bar delegate instead — net user-visible behavior identical.
//      `visible` has no fork counterpart (bars are always visible).
//   Cursor-internal gates (localMode, cmdk availability, blocked-uri,
//   heuristicSelect/column-1 trim — the latter two belong to entry #28).

/** Args of `aipopup.action.modal.generate` (binary StartEditPrompt arg shape). */
export interface ModalGenerateArgs {
	readonly invocationType?: string;
	readonly promptBarId?: string;
	readonly initText?: string;
	readonly overrideUri?: unknown;
	readonly overrideRange?: unknown;
	readonly visible?: boolean;
}

export class AipopupModalGenerateAction extends Action2 {
	static readonly ID = 'aipopup.action.modal.generate';
	constructor() {
		super({
			id: AipopupModalGenerateAction.ID,
			title: localize2('aipopup.action.modal.generate', 'Open Edit (Command K)'),
			// Binary parity: NO category (glass @40731968 — the registration
			// is {id, title, f1:!0, precondition, keybinding} only).
			f1: true,
			precondition: ComposerContextKeys.composerBarIsVisible.toNegated(),
			keybinding: [
				{
					weight: 1401 as KeybindingWeight,
					primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyK,
					when: EditorContextKeys.focus,
					args: { invocationType: 'toggle' },
				},
				{
					weight: 1401 as KeybindingWeight,
					primary: KeyMod.CtrlCmd | KeyCode.KeyK,
					when: ContextKeyExpr.or(EditorContextKeys.focus, ComposerContextKeys.editcontextbarcursor),
					args: { invocationType: 'new' },
				},
			],
		});
	}

	async run(accessor: ServicesAccessor, args?: ModalGenerateArgs): Promise<string | undefined> {
		// GAPS-174 (#33): programmatic override invocation — the binary's
		// StartEditPrompt routes on `n.overrideUri ?? active uri` and
		// `n.overrideRange ?? selection` BEFORE any active-editor logic,
		// and returns the created bar's id. The only in-binary caller is
		// `cmdK.resolveConflictInCmdK`. Keyboard invocations never carry
		// override args, so their behavior below is unchanged.
		if (args && URI.isUri(args.overrideUri) && args.overrideRange instanceof Range) {
			// GAPS-189 (QA-185 NF-1): the binary's StartEditPrompt checks
			// the bars bound to `overrideUri ?? active uri` BEFORE its
			// create path (glass goo.run @40731968+, re-sliced by
			// GAPS-189): with a bar already open for the override uri it
			// executes insertEditSelection (override range NON-EMPTY,
			// used AS GIVEN — the column-1 trim belongs only to the
			// create path) or focusEdit (empty range) with that bar's
			// id, then returns undefined — so a JcI-style caller aborts
			// without setText/submit. GAPS-174 skipped this side effect
			// (silent undefined); the decision lives in common
			// `resolveSameUriOverrideTarget`, shared with
			// `IInlineEditService.openPromptForRange`'s own same-uri
			// backstop, and the commands are executed through the same
			// action ids the normal path below uses.
			const sameUri = resolveSameUriOverrideTarget(
				accessor.get(IInlineEditPromptBar).getPromptBars(),
				args.overrideUri.toString(),
				args.overrideRange,
			);
			if (sameUri.kind === 'insertEditSelection') {
				await accessor.get(ICommandService).executeCommand(AipopupInsertEditSelectionAction.ID, sameUri.barId);
				return undefined;
			}
			if (sameUri.kind === 'focusEdit') {
				await accessor.get(ICommandService).executeCommand(AipopupFocusEditAction.ID, sameUri.barId);
				return undefined;
			}
			const core = getCoreInlineEditService(accessor);
			if (!core) {
				return undefined;
			}
			return core.openPromptForRange(args.overrideUri, args.overrideRange);
		}
		const editor = asCodeEditorFromAction(accessor);
		// Binary guards: no active code editor / no model → return silently.
		if (!editor || !editor.hasModel()) {
			return undefined;
		}
		const model = editor.getModel();
		if (!model) {
			return undefined;
		}
		const service = accessor.get(IInlineEditPromptBar);
		const resolution = resolveModalGenerateTarget(
			service.getPromptBars(),
			model.uri.toString(),
			args?.invocationType,
			args?.promptBarId,
		);
		const commandService = accessor.get(ICommandService);
		if (resolution.kind === 'focusExistingBar') {
			// Binary: selection non-empty → insertEditSelection(barId),
			// empty → focusEdit(barId); return.
			const selection = editor.getSelection();
			if (selection && !selection.isEmpty()) {
				await commandService.executeCommand(AipopupInsertEditSelectionAction.ID, resolution.barId);
			} else {
				await commandService.executeCommand(AipopupFocusEditAction.ID, resolution.barId);
			}
			return undefined;
		}
		if (resolution.kind === 'cycleFromBar') {
			// Binary: executeCommand("aipopup.action.nextPromptBar", promptBarId).
			await commandService.executeCommand(AipopupNextPromptBarAction.ID, resolution.barId);
			return undefined;
		}
		// Create path — the fork's StartEditPrompt equivalent (native
		// view-zone prompt bar via the core inline-edit service).
		const core = getCoreInlineEditService(accessor);
		if (core) {
			await core.openPrompt();
			return undefined;
		}
		await commandService.executeCommand('ide.openInlinePrompt');
		return undefined;
	}
}

// ---- RESOLVE CONFLICT IN CMD+K (Cursor 3.25.9 parity, queue #33,
// GAPS-174). Binary evidence (re-sliced by GAPS-174 from BOTH bundles +
// the merge-conflict extension bundle):
// - glass class `JcI` @40750760: `super({id:OQp, title:{value:"Resolve
//   Conflict in Cmd+K", original:"Resolve Conflict in Cmd+K"}, f1:!1})`
//   with `OQp="cmdK.resolveConflictInCmdK"` (const @15889598); desktop
//   class `SjS` @32247269, const `i5u` @14004524 — identical. NO
//   keybinding, NO menu, NO category, NO precondition.
// - run(t, e): `executeCommand(vtt, {initText:"Resolve this merge
//   conflict", invocationType:"new", overrideUri:URI.parse(e.uri),
//   overrideRange:new Range(e.startLine,1,e.endLine,1), visible:!0})`
//   where `vtt="aipopup.action.modal.generate"` (const @1136848 glass /
//   `l9e` @484598 desktop); `if(!r) return`; wait 50ms;
//   `s=getPromptBar(r)`; `if(!s) return`; then delegate
//   setText/poll/submit (ported as `setPromptBarTextAndSubmit` in
//   common/inlineEditPromptBar.ts).
// - The sole in-app caller is Cursor's patch of the stock merge-conflict
//   extension: CodeLens "Resolve with AI" → `merge-conflict.resolve-in-chat`
//   → `resolveInChat` builds `{uri, startLine, endLine, text}` (the `text`
//   field is sent but IGNORED by JcI — only uri/startLine/endLine are
//   consumed). The fork ports that caller in
//   extensions/merge-conflict (same layer as the binary).
// - Category-registry grouping in the binary: `cmdk_extras` (with
//   cmdk.togglePromptBarModel / composer.resolveAllConflictsInChat) —
//   that registry is Cursor-internal bookkeeping, not a VS Code
//   Action2 category; like the neighboring cmdk.togglePromptBarModel
//   port, no category is set here.

/** Args of `cmdK.resolveConflictInCmdK` (binary merge-conflict caller shape). */
export interface CmdKResolveConflictArgs {
	readonly uri: string;
	readonly startLine: number;
	readonly endLine: number;
	/** Sent by the caller but ignored by the binary's handler. */
	readonly text?: string;
}

export class CmdKResolveConflictInCmdKAction extends Action2 {
	static readonly ID = 'cmdK.resolveConflictInCmdK';
	constructor() {
		super({
			id: CmdKResolveConflictInCmdKAction.ID,
			title: localize2('cmdK.resolveConflictInCmdK', 'Resolve Conflict in Cmd+K'),
			f1: false,
		});
	}

	async run(accessor: ServicesAccessor, arg?: CmdKResolveConflictArgs): Promise<void> {
		// The binary dereferences e.uri/e.startLine/e.endLine directly;
		// the fork bails on a malformed arg instead of throwing (the
		// command is f1:!1, so it can only be invoked programmatically —
		// in practice by merge-conflict.resolve-in-chat).
		if (!arg || typeof arg.uri !== 'string' || typeof arg.startLine !== 'number' || typeof arg.endLine !== 'number') {
			return;
		}
		const commandService = accessor.get(ICommandService);
		const promptBarService = accessor.get(IInlineEditPromptBar);
		const barId = await commandService.executeCommand<string | undefined>(AipopupModalGenerateAction.ID, {
			initText: RESOLVE_CONFLICT_INIT_TEXT,
			invocationType: 'new',
			overrideUri: URI.parse(arg.uri),
			overrideRange: new Range(arg.startLine, 1, arg.endLine, 1),
			visible: true,
		});
		if (!barId) {
			return; // binary: `if(!r)return`
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 50));
		const delegate = promptBarService.getPromptBarDelegate(barId);
		if (!delegate) {
			return; // binary: `const s=i.getPromptBar(r); if(!s)return`
		}
		await setPromptBarTextAndSubmit(delegate, RESOLVE_CONFLICT_INIT_TEXT);
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

// DEV-GAPS-80 (W80C-R3): binary-verbatim SubComposer-tab actions.
// Cursor 3.25.9 evidence (workbench.glass.main.js, extracted reference):
// - id constants in constants.js: `iQp="composer.selectPreviousSubComposerTab"`
//   @15886314, `rQp="composer.selectNextSubComposerTab"` @15886358.
// - action classes @~39818374: title "Select Previous/Next SubComposer Tab",
//   f1:!1 (NOT in the palette), keybinding primary Alt|CtrlCmd|LeftArrow /
//   Alt|CtrlCmd|RightArrow, weight 200, when ft.has("composerFocused");
//   run fires `fireDidRequestSwitchSubComposerTab({composerId:
//   selectedComposerId, direction:"previous"|"next"})` on the composer
//   event service — the child tabs are the selected composer's Best-of-N
//   subcomposers (subComposerIds[] + selectedSubComposerId).
// Fork ports:
// - weight 200 === KeybindingWeight.WorkbenchContrib (200) verbatim.
// - `composerFocused` has no fork writer (established HONEST-DIVERGENCE in
//   this file); `chatSurface` is the fork's composerFocused port.
// - The fork has no Best-of-N subcomposer child tabs, so the runtime
//   (ide.selectNext/PreviousSubComposerTab in ide-agent) cycles the real
//   chat tab ring — divergence documented in chatTabService.ts.
// - Chord sharing: Cursor's Select Next/Previous Chat pair uses the same
//   Alt+CtrlCmd+←/→ at weight 410 with a broader when; the fork's
//   ComposerSelectNext/PreviousChatAction carry NO keybinding, so no
//   same-chord conflict exists in the fork today.
export class ComposerSelectNextSubComposerTabAction extends Action2 {
	static readonly ID = 'composer.selectNextSubComposerTab';
	constructor() {
		super({
			id: ComposerSelectNextSubComposerTabAction.ID,
			title: localize2('composer.selectNextSubComposerTab', 'Select Next SubComposer Tab'),
			category: ComposerActionCategory,
			f1: false,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.RightArrow,
				when: chatSurface
			},
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.selectNextSubComposerTab', ...args);
	}
}

export class ComposerSelectPreviousSubComposerTabAction extends Action2 {
	static readonly ID = 'composer.selectPreviousSubComposerTab';
	constructor() {
		super({
			id: ComposerSelectPreviousSubComposerTabAction.ID,
			title: localize2('composer.selectPreviousSubComposerTab', 'Select Previous SubComposer Tab'),
			category: ComposerActionCategory,
			f1: false,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.LeftArrow,
				when: chatSurface
			},
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.selectPreviousSubComposerTab', ...args);
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
 * DEV-GAPS-73 (`chat-tab-close-actions`): Cursor 3.25.9 parity —
 * `composer.clearComposerTabs`, title **'Close All Tabs'**, menu
 * ViewTitle group **'0_chatManage'** order **3**, `f1:!0` (glass
 * @39825552; `!0` = true, palette-visible — the sibling
 * `closeOtherComposerTabs` is likewise `f1:!0` with menu order 2).
 * The run body delegates to the extension-owned runtime (the
 * established `composer.*` → `ide.*` architecture): ChatTabService
 * closes every tab, reusing per-tab closeTab semantics (a
 * running/draining turn refuses; the last chat is cleared, never
 * removed).
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
 * `f1:!0` (palette-VISIBLE — `!0` is `true` in minified JS; verified
 * against the glass bundle @39862165), ViewTitle menu (static grep,
 * title recovery; matrix + remeasure 2026-10-20 MISSING). Closes every
 * chat tab except the active one; same per-tab closeTab semantics as
 * Close All Tabs.
 */
export class ComposerCloseOtherComposerTabsAction extends Action2 {
	static readonly ID = 'composer.closeOtherComposerTabs';
	constructor() {
		super({
			id: ComposerCloseOtherComposerTabsAction.ID,
			title: localize2('composer.closeOtherComposerTabs', 'Close Other Tabs'),
			f1: true,
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
// workbench.glass.main.js 3.25.9, class CAb @39846912 — REA spec
// `rea-spec-accept-resume-2026-10-20.md`):
//   super({id:p8a,title:{value:"Resume Current Chat",original:"Resume Current Chat"}})
// — p8a="composer.resumeCurrentChat" @15886874. The binary registration carries NO
// f1, NO keybinding, NO precondition, NO menu, NO category. The registration
// helper Ht (@2274492) gates palette/menu registration on truthy f1
// (`{f1:i,...}=n.desc; if(i&&(...))`), so this command is PALETTE-HIDDEN —
// invocable programmatically only (executeCommand with args). CORRECTION vs
// the run-34 audit entry: the audit's `f1:!0` claim is BÁC BỎ by binary
// evidence (the class literal passes {id,title} ONLY; an omitted f1 is falsy,
// it does NOT default to palette-visible). The fork mirrors this with an
// explicit f1:false — the fork's registerAction2 also gates the
// CommandPalette entry on truthy f1.
// Run (binary, verbatim):
//   async run(t,e){const n=t.get(L0/*composerChatService @19930603*/),
//     i=t.get(no/*composerDataService @17974762*/),
//     r=t.get($r/*notificationService @2462592*/),s=i.selectedComposerId;
//     if(s){const o=i.getHandleIfLoaded(s);
//       if(!o){r.warn("Cannot resume: composer not loaded");return}
//       try{n.resumeChat(o,{isAutoResume:e?.isAutoResume===!0})}
//       catch(a){r.warn(a instanceof Error?a.message:"Cannot resume")}}}
// Fork mapping (binary services -> fork analogs):
// - L0 (ComposerChatService.resumeChat) -> the ide-agent extension runtime
//   `ide.resumeCurrentChat` (chat-data owner; its ComposerDataService.resumeChat
//   is the chatService port — it throws verbatim "Cannot resume: chat not
//   found" when the composer holds no conversation data, per the binary's
//   resumeChat guard @20423725).
// - no (global ComposerDataService: selectedComposerId/getHandleIfLoaded) ->
//   the fork has no global composer registry in core: the SELECTED composer
//   is the active composer chat editor (resolveRenameChatTabId — the same
//   selection mapping as ComposerRenameChatAction), and a LOADED handle is an
//   OPEN chat editor input (findOpenComposerChatInput — the same mapping the
//   composer.acceptPlan resolver documents for getHandleIfLoaded).
// - $r (notificationService) -> INotificationService.
// - No selection -> SILENT return (no warning), exactly like the binary.
// UNKNOWN (binary body truncated @20423725): the downstream effect of
// isAutoResume inside resumeChat — the fork passes the flag through to the
// runtime verbatim and invents no behavior for it.
export class ComposerResumeCurrentChatAction extends Action2 {
	static readonly ID = 'composer.resumeCurrentChat';
	/** Runtime half (chat-data owner) in the ide-agent extension. */
	static readonly RUNTIME_COMMAND = 'ide.resumeCurrentChat';
	constructor() {
		super({
			id: ComposerResumeCurrentChatAction.ID,
			title: localize2('composer.resumeCurrentChat', 'Resume Current Chat'),
			// Palette-hidden like the binary: no f1, no keybinding (see the
			// evidence note above).
			f1: false,
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const notificationService = accessor.get(INotificationService);
		const commandService = accessor.get(ICommandService);

		// Binary: `s = i.selectedComposerId; if (s) { ... }` — no selection
		// returns SILENTLY (no warning).
		const tabId = resolveRenameChatTabId(editorService, undefined);
		if (!tabId) {
			return;
		}
		// Binary: `o = i.getHandleIfLoaded(s); if (!o) { warn(...); return }`.
		if (!findOpenComposerChatInput(editorService, tabId)) {
			notificationService.warn('Cannot resume: composer not loaded');
			return;
		}
		// Binary: `n.resumeChat(o, { isAutoResume: e?.isAutoResume === true })`
		// with `catch(a){ r.warn(a instanceof Error ? a.message : "Cannot resume") }`.
		const opts = args[0] as { isAutoResume?: unknown } | undefined;
		try {
			await commandService.executeCommand(
				ComposerResumeCurrentChatAction.RUNTIME_COMMAND,
				{ isAutoResume: opts?.isAutoResume === true });
		} catch (err) {
			notificationService.warn(err instanceof Error ? err.message : 'Cannot resume');
		}
	}
}

// W69C (`changes-tab-base-branch-menu`): binary-verbatim
// `cursor.openBranchMenu` ("Open Branch Menu",
// workbench.glass.main.js 3.25.9 — id ZXl="cursor.openBranchMenu"
// @27418487, class JXl @27418510, Ht(Eyv) registered):
//   super({id:gpy.ID,title:{value:"Open Branch Menu",
//     original:"Open Branch Menu"},f1:!0,
//     keybinding:{primary:dt.CtrlCmd|Xe.Quote,weight:600,
//       when:ft.has("composerFocused")}})
// — f1:!0 (palette-visible), NO category, NO menu, NO precondition.
// Run (binary, verbatim):
//   async run(e){const n=e.get(no/*composerDataService*/),
//     i=e.get(ep/*composerService @4266368*/),
//     r=e.get(Xb/*composerEventService @17600371*/),
//     s=n.selectedComposerId;
//     !s||!n.getComposerDataIfLoaded(s)||!i.isComposerConversationEmpty(s)
//       ||r.fireDidRequestOpenBranchMenu({composerId:s})}
// — the event fires ONLY for a loaded composer whose conversation is
// still EMPTY (the base branch is a pre-chat choice); every guard failure
// is a SILENT no-op (unlike resumeCurrentChat, this command never warns).
// The handler lives in the branch-selector component (@27425412): on
// `onDidRequestOpenBranchMenu` for the selected composer it opens the
// selector popup, sets backgroundComposerDataService
// "isBranchSelectorOpen", and labels the trigger
// `Switch base branch (${base})` (template @27426629), backed by
// gitContextService.getGitDiff()/getCurrentBranch()/getDefaultBranch()/
// getAllBranchNames().
// Fork mapping (binary services -> fork analogs), same split as
// ComposerResumeCurrentChatAction:
// - no (selectedComposerId / getComposerDataIfLoaded) -> the active
//   composer chat editor (resolveRenameChatTabId /
//   findOpenComposerChatInput), resolved HERE in core; both guards are
//   silent, exactly like the binary's short-circuit.
// - ep (isComposerConversationEmpty) + Xb (fireDidRequestOpenBranchMenu)
//   + the selector handler -> the ide-agent extension runtime
//   `ide.openBranchMenu` (chat-data owner; BranchMenuService is the
//   composerEventService/backgroundComposerDataService port, and its
//   picker is the fork's QuickPick analog of the binary's React popup —
//   see branchMenuService.ts for the divergence notes).
// - when: the binary's `composerFocused` has no fork writer; `chatSurface`
//   is the established fork port (same as the accept family).
export class CursorOpenBranchMenuAction extends Action2 {
	static readonly ID = 'cursor.openBranchMenu';
	/** Runtime half (chat-data owner) in the ide-agent extension. */
	static readonly RUNTIME_COMMAND = 'ide.openBranchMenu';
	constructor() {
		super({
			id: CursorOpenBranchMenuAction.ID,
			title: localize2('cursor.openBranchMenu', 'Open Branch Menu'),
			f1: true,
			keybinding: {
				weight: openBranchMenuKeybindingWeight,
				primary: KeyMod.CtrlCmd | KeyCode.Quote,
				when: chatSurface,
			},
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const commandService = accessor.get(ICommandService);

		// Binary: `s = n.selectedComposerId; !s || ...` — no selection is a
		// SILENT no-op (this command never warns).
		const tabId = resolveRenameChatTabId(editorService, undefined);
		if (!tabId) {
			return;
		}
		// Binary: `!n.getComposerDataIfLoaded(s) || ...` — an unloaded
		// composer is likewise a silent no-op.
		if (!findOpenComposerChatInput(editorService, tabId)) {
			return;
		}
		// Binary: `!i.isComposerConversationEmpty(s) ||
		// r.fireDidRequestOpenBranchMenu({composerId:s})` — the
		// conversation-empty guard and the event fire live in the runtime.
		await commandService.executeCommand(
			CursorOpenBranchMenuAction.RUNTIME_COMMAND,
			{ composerId: tabId }, ...args);
	}
}

// DEV-GAPS-106B (`chat-history-command-palette`): binary-verbatim
// `composer.showComposerHistory` ("Show Chat History",
// workbench.desktop.main.js 3.25.9 — constants EYs/xq @14000834,
// class Rgm @29919589, re-extracted by DEV-GAPS-106B):
//   super({id:xq, title:{value:EYs,original:EYs}, f1:!0,
//     icon:Oe.historyTwo,
//     menu:{id:Le.ViewTitle, group:Bqn, order:2,
//       when:he.and(he.regex("view",new RegExp(`^${gA}`)),tko)},
//     keybinding:{primary:Me.CtrlCmd|Me.Alt|ve.Quote, weight:500}})
// — f1:!0 (palette-visible), NO category, Bqn="navigation" (@29893710),
// tko = the unified-sidebar-visible context key equals false. The
// ViewTitle entry is appended in `registerComposerMenus` below.
// Run (binary, verbatim):
//   let a=typeof t=="string"?t:void 0;
//   if(!a){const c=r.getContextKeyValue("view");
//     if(c){const l=c.match(new RegExp(`^${gA}\\.(.+)$`));l&&(a=l[1])}}
//   if(a||(a=i.selectedComposerId),a){
//     const c=await i.getComposerHandleById(a);c&&n.showComposerHistory(c)}
//   else s.info("No active composer found. Start a new chat to view history.")
// Fork mapping (binary services -> fork analogs), same split as
// ComposerResumeCurrentChatAction / CursorOpenBranchMenuAction:
// - Qs (global ComposerDataService: selectedComposerId /
//   getComposerHandleById) -> core resolves what it can see: a string
//   arg verbatim, an ide-chat URI arg, or the ACTIVE composer chat
//   editor (resolveRenameChatTabId — the established selection mapping).
//   The `view`-context-key resolution has no fork analog: Cursor has one
//   pane view PER composer (`workbench.panel.composerChatViewPane.<id>`),
//   the fork has a single chat view (`composer.chat`) — a ViewTitle
//   invocation therefore falls through to the runtime, whose active tab
//   is the selectedComposerId analog (the binary's own final fallback).
// - Hh (composerService.showComposerHistory — sets shouldShowHistory on
//   the composer, which renders the eLS/QPS history menu) -> the
//   ide-agent extension runtime `ide.showComposerHistory` (chat-data
//   owner; ChatHistoryService presents the menu — see
//   extensions/ide-agent/src/services/chatHistoryService.ts for the
//   evidence + divergence notes). The runtime returns false only when
//   no composer exists at all.
// - pi (notificationService) -> INotificationService; the verbatim info
//   fires exactly on the binary's none-found branch (runtime === false).
export class ComposerShowComposerHistoryAction extends Action2 {
	static readonly ID = 'composer.showComposerHistory';
	/** Runtime half (chat-data owner) in the ide-agent extension. */
	static readonly RUNTIME_COMMAND = 'ide.showComposerHistory';
	/** Verbatim fallback (binary Rgm.run @29919589). */
	static readonly NO_ACTIVE_COMPOSER_INFO = 'No active composer found. Start a new chat to view history.';
	constructor() {
		super({
			id: ComposerShowComposerHistoryAction.ID,
			title: localize2('composer.showComposerHistory', 'Show Chat History'),
			f1: true,
			icon: Codicon.history,
			keybinding: {
				weight: showComposerHistoryKeybindingWeight,
				primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.Quote,
			},
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const notificationService = accessor.get(INotificationService);
		const commandService = accessor.get(ICommandService);

		// Binary resolution order: string arg -> `view` context key (no
		// fork analog, see header) -> selectedComposerId (the runtime's
		// active tab when core cannot resolve one, exactly the binary's
		// final fallback).
		const composerId = resolveRenameChatTabId(editorService, args[0]);
		const found = await commandService.executeCommand(
			ComposerShowComposerHistoryAction.RUNTIME_COMMAND,
			{ composerId });
		// Binary: no composer at all -> the verbatim info message.
		if (found === false) {
			notificationService.info(ComposerShowComposerHistoryAction.NO_ACTIVE_COMPOSER_INFO);
		}
	}
}

// DEV-GAPS-106B (`chat-history-command-palette`): binary-verbatim
// `composer.showComposerHistoryEditor` ("Show Chat History (Editor)",
// workbench.desktop.main.js 3.25.9 — constants IYs/zkt @14000834,
// class Mgm @29920334, re-extracted by DEV-GAPS-106B):
//   super({id:zkt, title:{value:IYs,original:IYs}, f1:!0, icon:Oe.historyTwo})
// — f1:!0, NO category, NO keybinding, NO menu in the Action2. The menu
// entry is a separate appendMenuItem (@29934403 region):
//   Bn.appendMenuItem(Le.EditorTitle,
//     {command:{id:zkt, title:"Show Chat History", icon:Oe.historyTwo},
//      group:Bqn("navigation"), order:2,
//      when:he.and(Ru.Scheme.isEqualTo(ft.composer), Uph.negate())})
// (Uph = unified-sidebar-visible == true; the fork has no unified
// sidebar part, so the negated conjunct is vacuously true and omitted.)
// The EditorTitle entry is appended in `registerComposerMenus` below.
// Run (binary): arg (string, or object with `path`) -> activeEditor is
// a composer input -> its composerId; activeEditor is a split editor
// (wk): primary/secondary composer ids (single -> it; multiple ->
// getLastFocusedComposerIds match, else the first); fallback
// selectedComposerId; found -> getComposerHandleById ->
// showComposerHistoryEditor. NO info fallback — silent when nothing
// resolves (unlike the pane variant above).
// Fork mapping: the split-composer editor (`wk`) has no fork analog;
// resolution keeps string arg / {path} arg (composerChatTabIdFromPath)
// / active composer chat editor / selected fallback (runtime active
// tab). The runtime half is `ide.showComposerHistoryEditor`.
export class ComposerShowComposerHistoryEditorAction extends Action2 {
	static readonly ID = 'composer.showComposerHistoryEditor';
	/** Runtime half (chat-data owner) in the ide-agent extension. */
	static readonly RUNTIME_COMMAND = 'ide.showComposerHistoryEditor';
	constructor() {
		super({
			id: ComposerShowComposerHistoryEditorAction.ID,
			title: localize2('composer.showComposerHistoryEditor', 'Show Chat History (Editor)'),
			f1: true,
			icon: Codicon.history,
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const commandService = accessor.get(ICommandService);

		// Binary order (Mgm.run @29920334): a truthy arg wins over the
		// active editor; an object arg contributes its `path` verbatim
		// (`if (typeof s == "object" && "path" in s) s = s.path`) — in
		// Cursor the composer id IS the editor resource path, so the fork
		// translates the ide-chat path to its tab id. An untranslatable
		// path mirrors the binary's getComposerHandleById miss: a silent
		// no-op with NO selected-composer fallback (s stayed truthy).
		const arg = args[0];
		if (typeof arg === 'object' && arg !== null && !URI.isUri(arg) && 'path' in arg) {
			const path = (arg as { path?: unknown }).path;
			const composerId = typeof path === 'string' ? composerChatTabIdFromPath(path) : undefined;
			if (composerId === undefined) {
				return;
			}
			await commandService.executeCommand(
				ComposerShowComposerHistoryEditorAction.RUNTIME_COMMAND,
				{ composerId });
			return;
		}
		// Binary: active composer editor -> selectedComposerId fallback
		// (the runtime's active tab when core resolves nothing); nothing
		// is surfaced either way.
		const composerId = resolveRenameChatTabId(editorService, arg);
		await commandService.executeCommand(
			ComposerShowComposerHistoryEditorAction.RUNTIME_COMMAND,
			{ composerId });
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

// DEV-GAPS-119 (`chat-jump-messages-kbd`, 2026-10-20): jump between the
// user's own messages from the keyboard — CONFIRMED in Cursor 3.25.9
// (work-notes-gaps119; docs release-notes quote matches the binary 1-1).
// Binary spec (workbench.glass.main.js):
//   ids (id table @25984888): jumpToNextUserMessage /
//     jumpToPrevUserMessage / scrollAgentPanelToTop /
//     scrollAgentPanelToBottom — plain ids, NOT glass.-prefixed.
//   registrations (@45371395-45371863): titles "Jump to Next User
//     Message" / "Jump to Previous User Message" / "Scroll Agent Panel
//     to Top" / "Scroll Agent Panel to Bottom", glassCategory "Agent"
//     (= AgentActionCategory here), f1:!1 (palette-invisible), all
//     keybindings weight `yk=250` (@45343381) = WorkbenchContrib + 50.
//   chords (@45335715): GQb = [CtrlCmd|DownArrow, CtrlCmd|Shift|KeyY]
//     (next), WQb = [CtrlCmd|UpArrow, CtrlCmd|Shift|KeyU] (prev);
//     top/bottom = CtrlCmd|Shift|UpArrow / CtrlCmd|Shift|DownArrow.
//   when (@45335715): gno = and(glassEditorPanelFocused.negate(),
//     terminalFocusInAny.negate(), or(inputFocus.negate(),
//     glassPromptInputEmpty)) on the FIRST chord of each pair and on
//     top/bottom; the KeyU/KeyY chords carry NO when in the binary.
// Fork ports (documented divergences, same layer + shape):
//   - glassEditorPanelFocused has no fork key; its role (the code editor
//     beside the chat owns CtrlCmd+Up/Down for editor scrolling) is
//     ported as EditorContextKeys.editorTextFocus.negate() — the same
//     port other actions in this file use (e.g. line ~959).
//   - glassPromptInputEmpty -> ComposerContextKeys.chatInputEmpty
//     (core-owned, bridged from the extension's ideAgent.chatInputEmpty).
//   - inputFocus (uW in gno): the KEY NAME is verbatim from the binary,
//     but its stock semantics do NOT transfer to this fork (NF-136-1,
//     QA-GAPS-136). In Cursor the prompt is core DOM, so the platform
//     ContextKeyService (contextKeyService.ts updateInputContextKeys:
//     document.activeElement + isEditableElement) sets inputFocus=true
//     while typing in the prompt. Here the prompt lives in a webview
//     iframe, so the host document's activeElement is the IFRAME element
//     itself — not editable — and stock inputFocus is ALWAYS false while
//     the user types in the chat prompt. The original port
//     or(!inputFocus, chatInputEmpty) therefore degenerated to true and
//     the "only jump while the prompt is empty" guard never blocked the
//     main scenario (focused prompt + non-empty draft). Adapted formula
//     (GAPS-141): or(and(!inputFocus,
//     !ComposerContextKeys.chatInputFocused), chatInputEmpty) — the
//     webview reports prompt focus/blur first-hand ({type:'inputFocus'}
//     in components/composer.ts), both hosts setContext
//     ideAgent.chatInputFocused, and the bridge mirrors it to
//     composer.chatInputFocused, so the guard now covers BOTH host-DOM
//     inputs and the webview prompt.
//   - The KeyU/KeyY chords DO carry gno here: left when-less in this
//     shell they would shadow stock bindings globally (CtrlCmd+Shift+KeyU
//     is workbench.action.output.toggleOutput, output.contribution.ts).
//     Within the chat surface the behavior is unchanged.
//   - Runtime: the binary emits jumpToNextUserMessageRequested /
//     jumpToPrevUserMessageRequested / agentPanelScrollToEdgeRequested
//     on its event bus; here run() delegates to the ide.* runtime
//     commands, which post those exact events to the active chat
//     webview (services/chatJumpMessages.ts) — same delegation pattern
//     as the Find-in-Chat family above.
const chatJumpMessagesWhen = ContextKeyExpr.and(
	EditorContextKeys.editorTextFocus.negate(),
	TerminalContextKeys.focusInAny.negate(),
	// NF-136-1 / GAPS-141: NOT or(!inputFocus, chatInputEmpty) — stock
	// inputFocus is always false while the webview prompt is focused
	// (host activeElement is the iframe); see the header note above.
	ContextKeyExpr.or(
		ContextKeyExpr.and(InputFocusedContext.negate(), ComposerContextKeys.chatInputFocused.negate()),
		ComposerContextKeys.chatInputEmpty
	)
);
const CHAT_JUMP_KEYBINDING_WEIGHT = KeybindingWeight.WorkbenchContrib + 50; // binary: 250

export class JumpToNextUserMessageAction extends Action2 {
	static readonly ID = 'jumpToNextUserMessage';
	constructor() {
		super({
			id: JumpToNextUserMessageAction.ID,
			title: localize2('jumpToNextUserMessage', 'Jump to Next User Message'),
			category: AgentActionCategory,
			f1: false,
			keybinding: [
				{
					weight: CHAT_JUMP_KEYBINDING_WEIGHT,
					primary: KeyMod.CtrlCmd | KeyCode.DownArrow,
					when: chatJumpMessagesWhen
				},
				{
					weight: CHAT_JUMP_KEYBINDING_WEIGHT,
					primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyY,
					when: chatJumpMessagesWhen // binary: no when (see header note)
				}
			],
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.jumpToNextUserMessage', ...args);
	}
}

export class JumpToPrevUserMessageAction extends Action2 {
	static readonly ID = 'jumpToPrevUserMessage';
	constructor() {
		super({
			id: JumpToPrevUserMessageAction.ID,
			title: localize2('jumpToPrevUserMessage', 'Jump to Previous User Message'),
			category: AgentActionCategory,
			f1: false,
			keybinding: [
				{
					weight: CHAT_JUMP_KEYBINDING_WEIGHT,
					primary: KeyMod.CtrlCmd | KeyCode.UpArrow,
					when: chatJumpMessagesWhen
				},
				{
					weight: CHAT_JUMP_KEYBINDING_WEIGHT,
					primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyU,
					when: chatJumpMessagesWhen // binary: no when (see header note)
				}
			],
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.jumpToPrevUserMessage', ...args);
	}
}

export class ScrollAgentPanelToTopAction extends Action2 {
	static readonly ID = 'scrollAgentPanelToTop';
	constructor() {
		super({
			id: ScrollAgentPanelToTopAction.ID,
			title: localize2('scrollAgentPanelToTop', 'Scroll Agent Panel to Top'),
			category: AgentActionCategory,
			f1: false,
			keybinding: {
				weight: CHAT_JUMP_KEYBINDING_WEIGHT,
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.UpArrow,
				when: chatJumpMessagesWhen
			},
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.scrollAgentPanelToTop', ...args);
	}
}

export class ScrollAgentPanelToBottomAction extends Action2 {
	static readonly ID = 'scrollAgentPanelToBottom';
	constructor() {
		super({
			id: ScrollAgentPanelToBottomAction.ID,
			title: localize2('scrollAgentPanelToBottom', 'Scroll Agent Panel to Bottom'),
			category: AgentActionCategory,
			f1: false,
			keybinding: {
				weight: CHAT_JUMP_KEYBINDING_WEIGHT,
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.DownArrow,
				when: chatJumpMessagesWhen
			},
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime until the implementation migrates to core.
		await accessor.get(ICommandService).executeCommand('ide.scrollAgentPanelToBottom', ...args);
	}
}

// GAPS-131 (`mention-link-toolbar`, 2026-10-20): floating toolbar for a
// link @-mention in the composer input — CONFIRMED in Cursor 3.25.9
// (docs/rea/work-notes-gaps131.md). Binary spec:
//   registration (workbench.desktop.main.js @40072383, glass @47717752):
//     {id:"cursor.mentionLinkToolbar", title:"Mention Link Toolbar",
//      f1:!1} — palette-hidden, NO keybinding, NO category in the binary
//     descriptor; run(accessor, payload) awaits
//     uiOverlayService.showMentionLinkToolbar(payload), i.e. the command
//     promise resolves only when the toolbar closes.
//   payload (call site @24666605): {x: rect.left, y: rect.bottom + 2,
//     link, onRemove} — posted by the composer input renderer when a
//     link-type mention is clicked; the toolbar offers "Open"
//     (openerService.open(link)) and "Unlink" (onRemove()).
// Fork wiring (precedents DEV-GAPS-29 / DEV-GAPS-119): the fork has no
// core uiOverlayService and its chat surface is the ide-agent webview,
// so run() delegates to the `ide.mentionLinkToolbar` runtime command;
// the extension's MentionLinkToolbarController (services/
// mentionLinkToolbar.ts) mirrors the binary service's state + Promise
// semantics and the webview renders the verbatim toolbar DOM/CSS.
// HONEST-DIVERGENCE: the binary's `onRemove` closure cannot cross the
// extension-host boundary, so the delegated payload carries the chip
// `uuid` instead and the webview performs the unlink semantics.
export class CursorMentionLinkToolbarAction extends Action2 {
	static readonly ID = 'cursor.mentionLinkToolbar';
	static readonly RUNTIME_COMMAND = 'ide.mentionLinkToolbar';
	constructor() {
		super({
			id: CursorMentionLinkToolbarAction.ID,
			title: localize2('cursor.mentionLinkToolbar', 'Mention Link Toolbar'),
			f1: false,
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime, whose
		// controller promise resolves when the toolbar closes — the same
		// await-until-close semantics as the binary's run().
		await accessor.get(ICommandService).executeCommand(CursorMentionLinkToolbarAction.RUNTIME_COMMAND, ...args);
	}
}

// GAPS-134 (`chat-find-in-chat-pane-level`, 2026-10-20): pane-level Find
// in Chat family — CONFIRMED REAL-GAP in Cursor 3.25.9 glass
// (docs/rea/work-notes-gaps130.md entry 1; anchors re-verified first-hand
// by GAPS-134). This is the glass-layer sibling of the composer.find.*
// family above (which is Cursor's DESKTOP-mode family — the desktop bundle
// has 0 hits for these ids); both families coexist in the glass bundle and
// both delegate to the same find engine, so they coexist here too and the
// old family is untouched.
// Binary spec (workbench.glass.main.js 3.25.9):
//   ids (decl @25980630): showChatFind / hideChatFind / nextChatFindMatch /
//     previousChatFindMatch — bare, unprefixed. `glass.*` aliases exist
//     ONLY for hide/next/previous (the React find bar invokes them via
//     executeCommand, `Op()` @29163618).
//   registrations (QJi @45496556–45497364): titles "Find in Chat" /
//     "Close Find in Chat" / "Find Next in Chat" / "Find Previous in
//     Chat", glassCategory "Agent" (= AgentActionCategory here), icons
//     search/close/arrow-down/arrow-up, ALL keybindings weight gp+7 = 257
//     (gp=250 @45469675; CHAT_FIND_KEYBINDING_WEIGHT in
//     common/chatFindPane.ts).
//   show: f1:{when:isGlassAgentSelected} (palette-visible only when a
//     glass agent is selected), CtrlCmd+F, when YRx (@45444507):
//     or(glassTranscriptFocused, glassPromptInputFocused,
//        glassChatFindInputFocused,
//        and(glassEditorPanelFocused.negate(),
//            glassCustomizePanelActive.negate())).
//   hide: f1:!1 hidden:!0, Escape, when glassChatFindBarVisible (ADn).
//   next: f1:!1 hidden:!0, Enter primary / F3 secondary,
//     when ADn && RDn (glassChatFindInputFocused).
//   previous: f1:!1 hidden:!0, Shift+Enter / Shift+F3, when ADn && RDn.
//   Engine: glassChatFindService (@29160315, target-priority model +
//     analytics `glass.chat_find.opened`) — part of the glass React shell.
// Fork wiring (same delegation pattern as DEV-GAPS-29 / DEV-GAPS-119):
//   run() delegates to the EXISTING ide.findInChat / ide.hideFindInChat /
//   ide.findNextInChat / ide.findPreviousInChat runtime commands (the
//   ide-agent webview find bar is the find target; no find engine is
//   rewritten). The two verbatim context keys are maintained for real by
//   the extension from the webview's findBarState reports (see
//   ComposerContextKeys.glassChatFindBarVisible /
//   glassChatFindInputFocused and findBarContextUpdates() in
//   extensions/ide-agent/src/services/findInChat.ts).
// HONEST-DIVERGENCES:
//   D1: no `glassCustomizePanelActive` key exists in the fork, so that
//     negate arm of YRx is dropped.
//   D2: `glassEditorPanelFocused.negate()` is ported as
//     `editorTextFocus.negate()` (the GAPS-119 `gno` port) PLUS
//     `terminalFocusInAny.negate()`: fork terminals live in the bottom
//     panel, not inside the editor panel like glass tabs, so the single
//     negate would let this weight-257 binding shadow the stock terminal
//     find (weight 200) whenever a terminal has focus; in the binary the
//     one negate already covers its in-panel terminals. The pure mirror
//     of this clause is shouldShowChatFind() in common/chatFindPane.ts.
//   D3: `isGlassAgentSelected` has no fork key; the binary's
//     `f1:{when:...}` is ported as f1:true + `precondition: chatSurface`
//     (the fork precedent for f1:{when} ports, see the fullscreen actions
//     above) — the palette entry shows when the chat surface is the
//     active/focused surface, the nearest fork equivalent of a selected
//     glass agent.
//   D4: the binary's `glass.*` aliases are executeCommand targets of the
//     glass React shell (no shell here); they are registered via
//     CommandsRegistry exactly like registerFindInChatAliases() below —
//     same command ids and execution behavior, different registrar.
//   D5: QJi also registers a hidden `${id}WithoutAgentWorkspace` twin per
//     action (EMPTY_WORKSPACE scope); the fork has no agent-workspace
//     action scoping, so the twins are not ported.
//   D6: the glassChatFindService target-priority model and the
//     `glass.chat_find.opened` analytics event belong to the glass React
//     shell and are NOT recreated; the fork has exactly one chat find
//     target (the active chat surface's webview), resolved by the
//     extension's makeChatAttachHost() like the old family.
const chatFindShowWhen = ContextKeyExpr.or(
	chatSurface,
	ComposerContextKeys.glassChatFindInputFocused,
	ContextKeyExpr.and(
		EditorContextKeys.editorTextFocus.negate(),
		TerminalContextKeys.focusInAny.negate()
	)
);
const chatFindNavigateWhen = ContextKeyExpr.and(
	ComposerContextKeys.glassChatFindBarVisible,
	ComposerContextKeys.glassChatFindInputFocused
);

export class ShowChatFindAction extends Action2 {
	static readonly ID = 'showChatFind';
	constructor() {
		super({
			id: ShowChatFindAction.ID,
			title: localize2('showChatFind', 'Find in Chat'),
			category: AgentActionCategory,
			icon: Codicon.search,
			f1: true,
			// Binary f1:{when:isGlassAgentSelected} — ported via
			// precondition (divergence D3 in the header note).
			precondition: chatSurface,
			keybinding: {
				weight: CHAT_FIND_KEYBINDING_WEIGHT,
				primary: KeyMod.CtrlCmd | KeyCode.KeyF,
				when: chatFindShowWhen
			},
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime (existing
		// webview find engine), like the composer.find.* family.
		await accessor.get(ICommandService).executeCommand('ide.findInChat', ...args);
	}
}

export class HideChatFindAction extends Action2 {
	static readonly ID = 'hideChatFind';
	constructor() {
		super({
			id: HideChatFindAction.ID,
			title: localize2('hideChatFind', 'Close Find in Chat'),
			category: AgentActionCategory,
			icon: Codicon.close,
			f1: false,
			keybinding: {
				weight: CHAT_FIND_KEYBINDING_WEIGHT,
				primary: KeyCode.Escape,
				when: ComposerContextKeys.glassChatFindBarVisible
			},
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		await accessor.get(ICommandService).executeCommand('ide.hideFindInChat', ...args);
	}
}

export class NextChatFindMatchAction extends Action2 {
	static readonly ID = 'nextChatFindMatch';
	constructor() {
		super({
			id: NextChatFindMatchAction.ID,
			title: localize2('nextChatFindMatch', 'Find Next in Chat'),
			category: AgentActionCategory,
			icon: Codicon.arrowDown,
			f1: false,
			keybinding: {
				weight: CHAT_FIND_KEYBINDING_WEIGHT,
				// Binary: Enter is PRIMARY, F3 the secondary (the old
				// desktop family above has them the other way round).
				primary: KeyCode.Enter,
				secondary: [KeyCode.F3],
				when: chatFindNavigateWhen
			},
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		await accessor.get(ICommandService).executeCommand('ide.findNextInChat', ...args);
	}
}

export class PreviousChatFindMatchAction extends Action2 {
	static readonly ID = 'previousChatFindMatch';
	constructor() {
		super({
			id: PreviousChatFindMatchAction.ID,
			title: localize2('previousChatFindMatch', 'Find Previous in Chat'),
			category: AgentActionCategory,
			icon: Codicon.arrowUp,
			f1: false,
			keybinding: {
				weight: CHAT_FIND_KEYBINDING_WEIGHT,
				primary: KeyMod.Shift | KeyCode.Enter,
				secondary: [KeyMod.Shift | KeyCode.F3],
				when: chatFindNavigateWhen
			},
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		await accessor.get(ICommandService).executeCommand('ide.findPreviousInChat', ...args);
	}
}

/**
 * GAPS-134: `glass.*` aliases for the pane-level family (binary: only
 * hide/next/previous have them — there is NO `glass.showChatFind`).
 * CommandsRegistry registration (divergence D4) mirrors
 * registerFindInChatAliases() below: palette-invisible, resolvable via
 * executeCommand exactly as the binary's React find bar invokes them.
 */
function registerGlassChatFindAliases(): void {
	CommandsRegistry.registerCommand('glass.hideChatFind', (accessor, ...args: unknown[]) =>
		accessor.get(ICommandService).executeCommand('hideChatFind', ...args));
	CommandsRegistry.registerCommand('glass.nextChatFindMatch', (accessor, ...args: unknown[]) =>
		accessor.get(ICommandService).executeCommand('nextChatFindMatch', ...args));
	CommandsRegistry.registerCommand('glass.previousChatFindMatch', (accessor, ...args: unknown[]) =>
		accessor.get(ICommandService).executeCommand('previousChatFindMatch', ...args));
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

// GAPS-157 (`plan-find-in-plan`, 2026-10-20): pane-level Find in Plan
// family — CONFIRMED REAL-GAP in Cursor 3.25.9 glass (dissect:
// docs/rea/work-notes-gaps153.md entry 3; anchors re-verified + extended
// first-hand by GAPS-157, docs/rea/work-notes-gaps157.md slice 1). The
// glass-layer sibling of the GAPS-134 chat family above; the desktop
// bundle carries the ids decl-only (@28707826), so the family is
// glass-only, exactly like chat find.
// Binary spec (workbench.glass.main.js 3.25.9):
//   ids (decl @25981307–25981426): showPlanFind / hidePlanFind /
//     nextPlanFindMatch / previousPlanFindMatch — bare, unprefixed, and
//     ALL FOUR have `glass.*` aliases (chat's show has none): the plan
//     find bar config D2_ (@32788864, "plan-find-bar.react.js") consumes
//     glass.nextPlanFindMatch / glass.previousPlanFindMatch /
//     glass.hidePlanFind as its command ids.
//   registrations (Ir @45501537–@45502700): titles "Find in Plan" /
//     "Close Plan Find" / "Find Next in Plan" / "Find Previous in Plan",
//     glassCategory "View", icons search/close/arrow-down/arrow-up,
//     keywords ["plan","find",…], scope AGENT_WORKSPACE,
//     keybindingCategory Sa.PLAN, ALL keybindings weight gp+6 = 256
//     (gp=250 @45469684; PLAN_FIND_KEYBINDING_WEIGHT in
//     common/planFindPane.ts). Plain `Ir` registrations — NO
//     `*WithoutAgentWorkspace` twins (the chat family used QJi).
//   show: f1:{when:cf.isEqualTo(Ot.Plan)}, CtrlCmd+F, when xan([Ot.Plan])
//     (@45444568: glassEditorPanelFocused && !glassTranscriptFocused &&
//     !glassPromptInputFocused && !glassChatFindInputFocused &&
//     glassActiveTabKind==Plan), run emits {type:"planFindRequested"}
//     on the `ll` event bus; PlanTabContent opens the bar and
//     focus+selects its input (@32802787).
//   hide: f1:!1 (NO hidden flag — the chat family has hidden:!0, this
//     one does not), Escape, when and(cf.isEqualTo(Ot.Plan),
//     glassPlanFindBarVisible [e3i @23559865]), run emits
//     {type:"planFindCloseRequested"}.
//   next: f1:!1, Enter ONLY (NO F3 secondary — the chat family has one),
//     when and(cf.isEqualTo(Ot.Plan), e3i, MX) where MX =
//     glassFindInputFocused (@23559425, the GENERIC glass find-input
//     key shared with the markdown-preview bar — NOT the chat family's
//     glassChatFindInputFocused), run emits
//     {type:"planFindNextMatchRequested"}.
//   previous: f1:!1, Shift+Enter, same when, run emits
//     {type:"planFindPreviousMatchRequested"}.
//   Engine: the generic rich-text find bar (pS_) over the plan tab's
//     TipTap editor — case-insensitive substring search, current match
//     selected + scrolled into view, next/previous WRAP, and are hard
//     no-ops when there are no matches (SearchPlugin @15057975+; the
//     bar disables its nav buttons at total===0 and labels the count
//     "N of M" / "0 of 0").
// Fork wiring (same delegation pattern as GAPS-134):
//   run() delegates to the new ide.showPlanFind / ide.hidePlanFind /
//   ide.findNextInPlan / ide.findPreviousInPlan runtime commands; the
//   ide-agent webview owns the plan find bar (the fork's plan surface is
//   the chat webview's plan tray, planCopyService.ts:27-29 — there is no
//   plan tab). The two verbatim context keys are maintained for real by
//   the extension from the webview's planFindBarState reports, and the
//   fork-only `composerPlanTrayVisible` key from the planReady/
//   planCleared events (see ComposerContextKeys and
//   extensions/ide-agent/src/services/findInPlan.ts).
// HONEST-DIVERGENCES:
//   D-P1: `cf.isEqualTo(Ot.Plan)` (active glass tab kind) is ported as
//     the fork-only `composerPlanTrayVisible` key (a pending plan tray
//     is shown on the chat surface). The fork has no glassActiveTabKind
//     state for the tray; if a real plan tab/editor lands later, this
//     family should re-target it (the binary's command layer only emits
//     events, so the retarget is a when-clause + delegate change).
//   D-P2: xan's glassEditorPanelFocused arm and the tab-kind arm both
//     collapse into `chatSurface && composerPlanTrayVisible` (the tray
//     lives inside the chat surface), and the negated
//     glassTranscriptFocused / glassPromptInputFocused arms are folded
//     into that positive surface test — the same merge GAPS-134's YRx
//     port uses. The negated glassChatFindInputFocused arm IS kept
//     verbatim (the fork has that key). The pure mirror of the show
//     clause is shouldShowPlanFind() in common/planFindPane.ts.
//   D-P3: one fork-only arm, `glassChatFindBarVisible.negate()`, guards
//     the show binding: in glass the two bars live on different tabs
//     and can never coexist; on the fork's merged chat surface an open
//     chat find bar must keep Ctrl+F instead of stacking the plan bar.
//   D-P4: the binary's `f1:{when:...}` for show is ported as f1:true +
//     `precondition` (the GAPS-134 D3 precedent in this file).
//   D-P5: glassCategory "View" maps to Categories.View; the binary's
//     keybindingCategory Sa.PLAN and scope AGENT_WORKSPACE have no
//     Action2 equivalents in the fork and are not ported (same as the
//     chat family's Sa/keybindingCategory handling in GAPS-134).
//   D-P6: the glass React shell (PlanTabContent + generic find bar +
//     TipTap SearchPlugin) is NOT recreated. The fork's plan content is
//     the plan-mode assistant bubble in the chat transcript (the tray
//     itself holds only the review actions), identified exactly by the
//     host's PendingPlan.bubbleId; the webview plan find bar reuses the
//     chat find bar's TreeWalker/<mark> machinery scoped to that bubble
//     element, with the binary's count label format ("N of M" /
//     "0 of 0"), wrap-around navigation and no-op-on-no-match behavior.
//     GAPS-169 corrections (QA-164 NF-1/NF-2, binary re-sliced):
//     (i) NO tray fallback: if the bubble cannot be resolved the scope
//     is an empty no-match root (0 matches) — the tray DOES hold text
//     ("Plan ready — review it above, then:", "Accept Plan & Build",
//     "Discard", "Copy as Markdown") and must never be searched. (The
//     GAPS-157 wording here and in composer.ts claimed the opposite;
//     it was false.) (ii) The match scan ports the binary's ldk/Uqp/adk
//     (glass @15057542+): markdown-link syntax is segmented by adk
//     (JKr @15059682 — only capture group 1, the link text, is
//     searchable; the URL is excluded for EVERY text node, code
//     spans/blocks included), and Uqp advances s = o + 1, so
//     overlapping matches count ("aa" in "aaa" = 2). Overlapping
//     intervals cannot each be one <mark> in a DOM tree, so the
//     webview highlights atomic boundary segments and counts /
//     navigates per match group — the one representation difference
//     from the binary's overlapping ProseMirror decorations.
const planFindShowWhen = ContextKeyExpr.and(
	chatSurface,
	ComposerContextKeys.planTrayVisible,
	ComposerContextKeys.glassChatFindInputFocused.negate(),
	ComposerContextKeys.glassChatFindBarVisible.negate()
);
const planFindHideWhen = ContextKeyExpr.and(
	ComposerContextKeys.planTrayVisible,
	ComposerContextKeys.glassPlanFindBarVisible
);
const planFindNavigateWhen = ContextKeyExpr.and(
	ComposerContextKeys.planTrayVisible,
	ComposerContextKeys.glassPlanFindBarVisible,
	ComposerContextKeys.glassFindInputFocused
);

export class ShowPlanFindAction extends Action2 {
	static readonly ID = 'showPlanFind';
	constructor() {
		super({
			id: ShowPlanFindAction.ID,
			title: localize2('showPlanFind', 'Find in Plan'),
			category: Categories.View,
			icon: Codicon.search,
			f1: true,
			// Binary f1:{when:cf.isEqualTo(Ot.Plan)} — ported via
			// precondition (divergences D-P1/D-P4 in the header note).
			precondition: ContextKeyExpr.and(chatSurface, ComposerContextKeys.planTrayVisible),
			keybinding: {
				weight: PLAN_FIND_KEYBINDING_WEIGHT,
				primary: KeyMod.CtrlCmd | KeyCode.KeyF,
				when: planFindShowWhen
			},
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE: delegate to the ide-agent extension runtime (webview
		// plan find bar), like the pane-level chat family above.
		await accessor.get(ICommandService).executeCommand('ide.showPlanFind', ...args);
	}
}

export class HidePlanFindAction extends Action2 {
	static readonly ID = 'hidePlanFind';
	constructor() {
		super({
			id: HidePlanFindAction.ID,
			title: localize2('hidePlanFind', 'Close Plan Find'),
			category: Categories.View,
			icon: Codicon.close,
			f1: false,
			keybinding: {
				weight: PLAN_FIND_KEYBINDING_WEIGHT,
				primary: KeyCode.Escape,
				when: planFindHideWhen
			},
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		await accessor.get(ICommandService).executeCommand('ide.hidePlanFind', ...args);
	}
}

export class NextPlanFindMatchAction extends Action2 {
	static readonly ID = 'nextPlanFindMatch';
	constructor() {
		super({
			id: NextPlanFindMatchAction.ID,
			title: localize2('nextPlanFindMatch', 'Find Next in Plan'),
			category: Categories.View,
			icon: Codicon.arrowDown,
			f1: false,
			keybinding: {
				weight: PLAN_FIND_KEYBINDING_WEIGHT,
				// Binary: Enter is the ONLY chord — no F3 secondary
				// (the chat family has one; the plan family does not).
				primary: KeyCode.Enter,
				when: planFindNavigateWhen
			},
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		await accessor.get(ICommandService).executeCommand('ide.findNextInPlan', ...args);
	}
}

export class PreviousPlanFindMatchAction extends Action2 {
	static readonly ID = 'previousPlanFindMatch';
	constructor() {
		super({
			id: PreviousPlanFindMatchAction.ID,
			title: localize2('previousPlanFindMatch', 'Find Previous in Plan'),
			category: Categories.View,
			icon: Codicon.arrowUp,
			f1: false,
			keybinding: {
				weight: PLAN_FIND_KEYBINDING_WEIGHT,
				primary: KeyMod.Shift | KeyCode.Enter,
				when: planFindNavigateWhen
			},
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		await accessor.get(ICommandService).executeCommand('ide.findPreviousInPlan', ...args);
	}
}

/**
 * GAPS-157: `glass.*` aliases for the pane-level plan family (binary:
 * ALL FOUR commands have them — including show, unlike chat). The plan
 * find bar's config consumes the next/previous/close aliases as command
 * ids; show's alias is declared in the same decl block
 * (`oev=\`glass.${Q$l}\`` @25981326). CommandsRegistry registration
 * (divergence D4 of GAPS-134) mirrors registerGlassChatFindAliases()
 * above: palette-invisible, resolvable via executeCommand exactly as
 * the binary's find bar invokes them.
 */
function registerGlassPlanFindAliases(): void {
	CommandsRegistry.registerCommand('glass.showPlanFind', (accessor, ...args: unknown[]) =>
		accessor.get(ICommandService).executeCommand('showPlanFind', ...args));
	CommandsRegistry.registerCommand('glass.hidePlanFind', (accessor, ...args: unknown[]) =>
		accessor.get(ICommandService).executeCommand('hidePlanFind', ...args));
	CommandsRegistry.registerCommand('glass.nextPlanFindMatch', (accessor, ...args: unknown[]) =>
		accessor.get(ICommandService).executeCommand('nextPlanFindMatch', ...args));
	CommandsRegistry.registerCommand('glass.previousPlanFindMatch', (accessor, ...args: unknown[]) =>
		accessor.get(ICommandService).executeCommand('previousPlanFindMatch', ...args));
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
 *   GAPS-181 (consumer C1): extension chat tabs never open a core input, so
 *   a handle with no open input falls back to the plan registry — a
 *   (tabId, bubbleId) the registry resolves counts as loaded (only a live
 *   tab's producer records plans); no input AND no record still no-ops.
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
			// GAPS-181 (CAT-B port, acceptPlan consumer C1 — the W71B caveat):
			// the fork's LIVE chat tabs are extension custom editors
			// (`ideAgent.chatEditor`), which never create a
			// `ComposerChatEditorInput`, so the input-only resolution above
			// no-oped for every real tab. Fallback: a string / `ide-chat:`
			// URI handle whose (tabId, bubbleId) the plan registry resolves
			// is a loaded composer for this command's purposes — a record
			// exists only because that tab's live producer recorded a plan
			// into the registry (W71B bridge), and the registry's
			// bubble-id gate below is the same gate Cursor applies. This
			// preserves the binary's fail-closed shape: no open input AND
			// no recorded plan -> no-op.
			const tabId = input?.tabId
				?? (typeof composerHandle === 'string' && composerHandle ? composerHandle : undefined)
				?? (URI.isUri(composerHandle) && composerHandle.scheme === COMPOSER_CHAT_EDITOR_SCHEME
					? composerChatTabIdFromUri(composerHandle)
					: undefined);
			if (!tabId) {
				return;
			}
			// Cursor: `o = getPlanUriFromBubble(s, n); o && await acceptPlan(s, o, n)`
			const planUri = planService.getPlanUriFromBubble(tabId, bubbleId);
			if (planUri) {
				await planService.acceptPlan(tabId, planUri, bubbleId);
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
 * DEV-GAPS-96 (secondary ids left by QA-91C): `composer.copyRequestIdFromPane`,
 * Cursor 3.25.9 binary-verbatim (glass class `hrI`, desktop class `c2S`):
 * descriptor `{id:sQp, title:"Copy Request ID", f1:!1, menu:{id:ViewTitle,
 * group:"1_chatTools", order:3, when:view =~ /^<composer pane view id>/}}`
 * (sQp = "composer.copyRequestIdFromPane"); the ViewTitle contribution is
 * appended in `registerComposerMenus` below (fork convention), gated on the
 * fork's single chat view (`composer.chat`) instead of Cursor's per-composer
 * pane views (`workbench.panel.composerChatViewPane.<composerId>`).
 * The run is a pure delegate — binary: `executeCommand(composer.copyRequestId,
 * {kind:"pane"})`. The base command resolves the pane kind through
 * `resolveCopyRequestIdTabId` (fork mapping documented in
 * `../common/chatTitleMenu.ts`: no pane surface in core, so pane resolves to
 * the active chat tab, exactly like the editor kind).
 */
export class ComposerCopyRequestIdFromPaneAction extends Action2 {
	static readonly ID = 'composer.copyRequestIdFromPane';
	constructor() {
		super({
			id: ComposerCopyRequestIdFromPaneAction.ID,
			title: localize2('composer.copyRequestIdFromPane', 'Copy Request ID'),
			f1: false,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		// Binary hrI/c2S: delegate to the base command with {kind:"pane"}.
		await accessor.get(ICommandService).executeCommand(ComposerCopyRequestIdAction.ID, { kind: 'pane' });
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
 * DEV-GAPS-96 (secondary ids left by QA-91C): `composer.openPromptQualityFromPane`,
 * Cursor 3.25.9 binary-verbatim (glass class `MrI`; const
 * grI = "composer.openPromptQualityFromPane", desktop h2S): descriptor
 * `{id:grI, title:"Open in Prompt Quality", f1:!1, precondition:or(ch,Sm),
 * menu:{id:ViewTitle, group:"2_moreActions", order:99, when:view =~
 * /^<composer pane view id>/ && or(ch,Sm)}}`. ch/Sm are Cursor's internal
 * gate pair (isDevelopment || isDevUser); the fork maps that gate to
 * `isDevelopment` only — the same documented mapping the primary's title-menu
 * entry uses (`../common/chatTitleMenu.ts`). The ViewTitle contribution is
 * appended in `registerComposerMenus` below (fork convention).
 * The run is a pure delegate — binary: `executeCommand(composer.openPromptQuality,
 * {kind:"pane"})`. In the binary the primary then resolves the request id of
 * the pane-located composer (same `SAb` resolution as Copy Request ID); in the
 * fork the primary forwards its args to the `ide.openPromptQualityPanel`
 * provider (chat-data owner), so the {kind:"pane"} target travels the same
 * seam — the fork has no per-composer pane surface in core to resolve further.
 */
export class ComposerOpenPromptQualityFromPaneAction extends Action2 {
	static readonly ID = 'composer.openPromptQualityFromPane';
	constructor() {
		super({
			id: ComposerOpenPromptQualityFromPaneAction.ID,
			title: localize2('composer.openPromptQualityFromPane', 'Open in Prompt Quality'),
			f1: false,
			precondition: IsDevelopmentContext,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		// Binary MrI: delegate to the primary command with {kind:"pane"}.
		await accessor.get(ICommandService).executeCommand(ComposerOpenPromptQualityAction.ID, { kind: 'pane' });
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
 * both bundles). Binary extras carried over: palette-visible (f1:!0) with the Cursor
 * category (binary `category:Yn.Cursor`); the menu entry is `group:"1_chatTools",order:6,when:scheme==composer
 * && !composerEditorTabIsCloudAgent`. The run deep-forks the transcript —
 * still delegated to the ide-agent extension runtime (chat-data owner).
 */
export class ComposerForkChatAction extends Action2 {
	static readonly ID = 'composer.duplicateChat';
	constructor() {
		super({
			id: ComposerForkChatAction.ID,
			title: localize2('composer.duplicateChat', 'Fork Chat'),
			category: CursorActionCategory,
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
		// DEV-GAPS-74: delegate to the ide-agent extension's `ide.customize.openPlugins`
		// alias (registered in extensions/ide-agent/src/extension.ts), which opens
		// the real Customize editor on the Plugins tab. NEVER call our own ID
		// `workbench.action.customize.openPlugins`: it is shadowed by this core action and
		// would recurse into this run() forever.
		await accessor.get(ICommandService).executeCommand('ide.customize.openPlugins');
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
		// DEV-GAPS-74: delegate to the ide-agent extension's `ide.customize.openMCPs`
		// alias (registered in extensions/ide-agent/src/extension.ts), which opens
		// the real Customize editor on the MCPs tab. NEVER call our own ID
		// `workbench.action.customize.openMCPs`: it is shadowed by this core action and
		// would recurse into this run() forever.
		await accessor.get(ICommandService).executeCommand('ide.customize.openMCPs');
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
		// DEV-GAPS-74: delegate to the ide-agent extension's `ide.customize.openSkills`
		// alias (registered in extensions/ide-agent/src/extension.ts), which opens
		// the real Customize editor on the Skills tab. NEVER call our own ID
		// `workbench.action.customize.openSkills`: it is shadowed by this core action and
		// would recurse into this run() forever.
		await accessor.get(ICommandService).executeCommand('ide.customize.openSkills');
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
		// DEV-GAPS-74: delegate to the ide-agent extension's `ide.customize.openSubagents`
		// alias (registered in extensions/ide-agent/src/extension.ts), which opens
		// the real Customize editor on the Subagents tab. NEVER call our own ID
		// `workbench.action.customize.openSubagents`: it is shadowed by this core action and
		// would recurse into this run() forever.
		await accessor.get(ICommandService).executeCommand('ide.customize.openSubagents');
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
		// DEV-GAPS-74: delegate to the ide-agent extension's `ide.customize.openRules`
		// alias (registered in extensions/ide-agent/src/extension.ts), which opens
		// the real Customize editor on the Rules tab. NEVER call our own ID
		// `workbench.action.customize.openRules`: it is shadowed by this core action and
		// would recurse into this run() forever.
		await accessor.get(ICommandService).executeCommand('ide.customize.openRules');
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
		// DEV-GAPS-74: delegate to the ide-agent extension's `ide.customize.openCommands`
		// alias (registered in extensions/ide-agent/src/extension.ts), which opens
		// the real Customize editor on the Commands tab. NEVER call our own ID
		// `workbench.action.customize.openCommands`: it is shadowed by this core action and
		// would recurse into this run() forever.
		await accessor.get(ICommandService).executeCommand('ide.customize.openCommands');
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
		// DEV-GAPS-74: delegate to the ide-agent extension's `ide.customize.openHooks`
		// alias (registered in extensions/ide-agent/src/extension.ts), which opens
		// the real Customize editor on the Hooks tab. NEVER call our own ID
		// `workbench.action.customize.openHooks`: it is shadowed by this core action and
		// would recurse into this run() forever.
		await accessor.get(ICommandService).executeCommand('ide.customize.openHooks');
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
			// GAPS-171 CHORD REASSIGNMENT (per Cursor 3.25.9 binary): this
			// action previously owned CtrlCmd+Shift+K (when editorTextFocus).
			// The binary has NO `composer.addSelectionToInlinePrompt` id at
			// all (0 hits in glass + desktop bundles) and assigns
			// CtrlCmd+Shift+K to `aipopup.action.modal.generate`
			// ({invocationType:"toggle"}, weight 1401, when editorFocus) and
			// to `editor.action.inlineDiffs.focusEditor` as its secondary
			// (weight 1402, when prompt bar focused). Keeping the chord here
			// would leave it permanently shadowed (1401 > WorkbenchContrib,
			// editorFocus ⊇ editorTextFocus in the editor), so the keybinding
			// is REMOVED: the command, handler and palette entry stay —
			// only the keyboard chord changes hands, exactly as in Cursor.
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// F2-A: K-08 — attach the selection to the CORE pending-selection
		// slot, then open the core prompt (mirrors the extension's
		// `ide.addSelectionToInlinePrompt` on the core path). Like the
		// extension, the prompt only opens when a selection was attached.
		const core = getCoreInlineEditService(accessor);
		if (core) {
			const selectionService = getInlinePromptSelectionService(accessor);
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
	// BUILD-FIX-14 (F1): the NLS build plugin eval()s BOTH arguments of every
	// localize/localize2 call (build/lib/nls-analysis.ts,
	// parseLocalizeKeyOrValue), so a computed key or value throws
	// ReferenceError and fails the bundle. The five mode titles are therefore
	// spelled out as string literals here — one entry per
	// COMPOSER_MODE_COMMANDS def, keyed by its verbatim actionId. Each key is
	// exactly what composerModeCommandTitleKey(def) produced
	// (`composerMode.command.<modeId>`) and each value is exactly what
	// buildComposerModeCommandTitle(def.name) produced
	// (`Open Chat in <name> Mode`), so the palette titles are unchanged. The
	// loop below only looks the pre-localized title up; the `??` fallback
	// (plain ILocalizedString built from the same template, no localize2
	// call) only covers a hypothetical future def with no literal entry yet.
	const modeCommandTitles: Record<string, ILocalizedString> = {
		'composerMode.agent': localize2('composerMode.command.agent', 'Open Chat in Agent Mode'),
		'composerMode.plan': localize2('composerMode.command.plan', 'Open Chat in Plan Mode'),
		'composerMode.chat': localize2('composerMode.command.chat', 'Open Chat in Ask Mode'),
		'composerMode.debug': localize2('composerMode.command.debug', 'Open Chat in Debug Mode'),
		'composerMode.multitask': localize2('composerMode.command.multitask', 'Open Chat in Multitask Mode'),
	};
	for (const def of COMPOSER_MODE_COMMANDS) {
		registerAction2(class extends Action2 {
			constructor() {
				super({
					id: def.actionId,
					title: modeCommandTitles[def.actionId] ?? { value: buildComposerModeCommandTitle(def.name), original: buildComposerModeCommandTitle(def.name) },
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
	// GAPS-171 (`inline-edit-keybindings-gap` remainder): Cursor 3.25.9
	// StartEditPrompt — `aipopup.action.modal.generate` ("Open Edit
	// (Command K)", f1:!0, precondition !composerBarIsVisible, Ctrl+K
	// "new" + Ctrl+Shift+K "toggle", both weight 1401, when editorFocus).
	registerAction2(AipopupModalGenerateAction);
	// GAPS-174 (#33): `cmdK.resolveConflictInCmdK` ("Resolve Conflict in
	// Cmd+K", f1:!1, no keybinding) — JcI port; invoked by the
	// merge-conflict extension's "Resolve with AI" CodeLens chain.
	registerAction2(CmdKResolveConflictInCmdKAction);
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
	registerAction2(ComposerSelectNextSubComposerTabAction);
	registerAction2(ComposerSelectPreviousSubComposerTabAction);
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
	// DEV-GAPS-56 (`agent-resume-chat`): `composer.resumeCurrentChat`.
	registerAction2(ComposerResumeCurrentChatAction);
	// W69C (`changes-tab-base-branch-menu`): `cursor.openBranchMenu`.
	registerAction2(CursorOpenBranchMenuAction);
	// DEV-GAPS-106B (`chat-history-command-palette`):
	// `composer.showComposerHistory` + `composer.showComposerHistoryEditor`.
	registerAction2(ComposerShowComposerHistoryAction);
	registerAction2(ComposerShowComposerHistoryEditorAction);
	registerAction2(ComposerFindInChatAction);
	registerAction2(ComposerHideFindInChatAction);
	registerAction2(ComposerFindNextInChatAction);
	registerAction2(ComposerFindPreviousInChatAction);
	// DEV-GAPS-119 (`chat-jump-messages-kbd`): binary-verbatim
	// jumpToNextUserMessage / jumpToPrevUserMessage /
	// scrollAgentPanelToTop / scrollAgentPanelToBottom.
	registerAction2(JumpToNextUserMessageAction);
	registerAction2(JumpToPrevUserMessageAction);
	registerAction2(ScrollAgentPanelToTopAction);
	registerAction2(ScrollAgentPanelToBottomAction);
	// GAPS-131 (`mention-link-toolbar`): binary-verbatim
	// cursor.mentionLinkToolbar (f1:false, no keybinding).
	registerAction2(CursorMentionLinkToolbarAction);
	// GAPS-134 (`chat-find-in-chat-pane-level`): binary-verbatim pane-level
	// showChatFind / hideChatFind / nextChatFindMatch /
	// previousChatFindMatch (weight 257) + glass.* aliases.
	registerAction2(ShowChatFindAction);
	registerAction2(HideChatFindAction);
	registerAction2(NextChatFindMatchAction);
	registerAction2(PreviousChatFindMatchAction);
	registerGlassChatFindAliases();
	registerFindInChatAliases();
	// GAPS-157 (`plan-find-in-plan`): binary-verbatim pane-level
	// showPlanFind / hidePlanFind / nextPlanFindMatch /
	// previousPlanFindMatch (weight 256) + all four glass.* aliases.
	registerAction2(ShowPlanFindAction);
	registerAction2(HidePlanFindAction);
	registerAction2(NextPlanFindMatchAction);
	registerAction2(PreviousPlanFindMatchAction);
	registerGlassPlanFindAliases();
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
	// DEV-GAPS-96: pane variants (binary hrI/MrI) — pure {kind:"pane"}
	// delegates to the primaries, ViewTitle entries in registerComposerMenus.
	registerAction2(ComposerCopyRequestIdFromPaneAction);
	registerAction2(ComposerShareChatAction);
	registerAction2(ComposerOpenPromptQualityAction);
	registerAction2(ComposerOpenPromptQualityFromPaneAction);
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

	// DEV-GAPS-73 (`chat-tab-close-actions`): Cursor 3.25.9 parity (glass
	// @39825552 / @39862165): Close Other Tabs is menu order **2**, Close
	// All Tabs order **3**, both in the chat VIEW TITLE menu group
	// '0_chatManage'. ('f1:!0' in the bundle means palette-VISIBLE.)
	const chatManageWhen = ContextKeyExpr.equals('view', COMPOSER_CHAT_VIEW_ID);
	MenuRegistry.appendMenuItem(MenuId.ViewTitle, {
		group: '0_chatManage@3',
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

	// DEV-GAPS-96: Cursor 3.25.9 pane-variant ViewTitle entries (binary
	// declares them in the Action2 descriptors; glass hrI/MrI): Copy Request
	// ID group "1_chatTools" order 3 (when: composer pane view), Open in
	// Prompt Quality group "2_moreActions" order 99 (when: pane view &&
	// internal gate — fork maps or(isDevelopment, isDevUser) to isDevelopment,
	// same documented mapping as the primary's title-menu gate). The fork's
	// single chat view (`composer.chat`) stands in for Cursor's per-composer
	// pane views (`workbench.panel.composerChatViewPane.<composerId>`).
	MenuRegistry.appendMenuItem(MenuId.ViewTitle, {
		group: '1_chatTools',
		order: 3,
		when: chatManageWhen,
		command: {
			id: ComposerCopyRequestIdFromPaneAction.ID,
			title: localize('composer.menu.copyRequestId', "Copy Request ID"),
		}
	});
	MenuRegistry.appendMenuItem(MenuId.ViewTitle, {
		group: '2_moreActions',
		order: 99,
		when: ContextKeyExpr.and(chatManageWhen, IsDevelopmentContext),
		command: {
			id: ComposerOpenPromptQualityFromPaneAction.ID,
			title: localize('composer.menu.openPromptQuality', "Open in Prompt Quality"),
		}
	});

	// DEV-GAPS-106B (`chat-history-command-palette`): Cursor 3.25.9
	// parity (workbench.desktop.main.js, class Rgm @29919589): the pane
	// command's ViewTitle entry — group "navigation" (Bqn), order 2,
	// when: view is a composer pane view && unified sidebar NOT visible
	// (tko). The fork's single chat view (`composer.chat`) stands in for
	// Cursor's per-composer pane views, and the fork has no unified
	// sidebar part, so the tko conjunct is vacuously true and omitted.
	MenuRegistry.appendMenuItem(MenuId.ViewTitle, {
		group: 'navigation',
		order: 2,
		when: ContextKeyExpr.equals('view', COMPOSER_CHAT_VIEW_ID),
		command: {
			id: ComposerShowComposerHistoryAction.ID,
			title: localize('composer.menu.showComposerHistory', "Show Chat History"),
			icon: Codicon.history,
		}
	});
	// DEV-GAPS-106B: the editor variant's EditorTitle entry — binary
	// appendMenuItem @29934403 region: {command:{id:zkt,
	// title:"Show Chat History", icon:historyTwo}, group:"navigation",
	// order:2, when: scheme==composer && !unifiedSidebarVisible}.
	MenuRegistry.appendMenuItem(MenuId.EditorTitle, {
		group: 'navigation',
		order: 2,
		when: ContextKeyExpr.equals('resourceScheme', COMPOSER_CHAT_EDITOR_SCHEME),
		command: {
			id: ComposerShowComposerHistoryEditorAction.ID,
			title: localize('composer.menu.showComposerHistoryEditor', "Show Chat History"),
			icon: Codicon.history,
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
	// BUILD-FIX-14 (F1): titles are pre-localized HERE, at the definition
	// table, with literal key + value pairs — the NLS build plugin eval()s
	// both arguments of every localize call, so the old computed-key call
	// in appendChatTitleMenuItem threw ReferenceError and failed the
	// bundle. Each entry below is
	// exactly the call the old code computed for that commandId: the key is
	// the old titleMenuLocKeys value and the value is the item's verbatim
	// title in ../common/chatTitleMenu.ts, so the rendered menu titles are
	// unchanged. Every CHAT_TAB_TITLE_MENU_ITEMS entry that reaches the
	// append loop is listed here; the `?? item.title` fallback at the call
	// site only covers a future unlisted item (the old generated-key call
	// could never be extracted into an NLS bundle, so it always rendered
	// item.title — identical to the fallback).
	const titleMenuTitles: Record<string, string> = {
		'composer.exportChatAsMd': localize('composer.menu.exportTranscript', 'Export Transcript'),
		'composer.shareChat': localize('composer.menu.shareTranscript', 'Share Transcript'),
		'composer.copyRequestIdFromEditor': localize('composer.menu.copyRequestId', 'Copy Request ID'),
		'composer.reportFeedback': localize('composer.menu.giveFeedback', 'Give Feedback'),
		'chat.openCursorSettings': localize('composer.menu.openAgentSettings', 'Agent Settings'),
		'composer.openPromptQuality': localize('composer.menu.openPromptQuality', 'Open in Prompt Quality'),
		'composer.renameChat': localize('composer.menu.renameChat', 'Rename Chat'),
		'composer.duplicateChat': localize('composer.menu.forkChat', 'Fork Chat'),
		'workbench.action.moveEditorToNewWindow': localize('composer.menu.moveEditorToNewWindow', 'Move into New Window'),
	};
	const titleMenuGateWhen = (gate: ChatTitleMenuGate): ContextKeyExpr | undefined => {
		switch (gate) {
			case 'schemeAndSharedChats':
				return ContextKeyExpr.and(ideChatScheme, ComposerContextKeys.isSharedChatsEnabled);
			case 'schemeAndNotCloudAgent':
				return ContextKeyExpr.and(ideChatScheme, ComposerContextKeys.chatEditorTabIsCloudAgent.negate());
			case 'schemeAndInternal':
				// Binary: `scheme == composer && (isDevelopment || isDevUser)`;
				// `isDevUser` is Cursor-internal with no fork analog (documented).
				return ContextKeyExpr.and(ideChatScheme, IsDevelopmentContext);
			case 'preconditionOnly':
				// Binary Rename Chat item (desktop @29968468):
				// `{command:{id:aHi,...,precondition:VXi},group:"1_chatTools",order:5}` —
				// NO `when`. The can-rename precondition sits on the command
				// descriptor (appended below) and `composerEditorTabCanRename`
				// is only true when the active editor is a chat tab, so the
				// scheme conjunct the old `'scheme'` gate added was spurious.
				return undefined;
			default:
				return ideChatScheme;
		}
	};
	const appendChatTitleMenuItem = (item: ChatTitleMenuItem): void => {
		// `'preconditionOnly'` (binary Rename Chat) maps to NO `when` —
		// the gate lives on the command descriptor's precondition only.
		const when = titleMenuGateWhen(item.gate);
		for (const target of item.targets) {
			MenuRegistry.appendMenuItem(target === 'EditorTitle' ? MenuId.EditorTitle : MenuId.EditorTitleContext, {
				group: item.group,
				order: item.order,
				...(when ? { when } : {}),
				command: {
					id: item.commandId,
					title: titleMenuTitles[item.commandId] ?? item.title,
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
	// BUILD-FIX-14 (F1): each title is localized with a literal key + value
	// right here in the definition table (the old loop-end call passed
	// computed arguments — item.locKey / item.title — which the NLS build
	// plugin's eval() rejects with ReferenceError). Keys and
	// values are verbatim the old locKey/title pairs, so the rendered menu
	// titles are unchanged; the loop below passes the string through.
	const forkExtraMenuItems: Array<{ id: string; title: string; order: number; when?: ContextKeyExpr }> = [
		{ id: ComposerPinChatAction.ID, title: localize('composer.menu.pinChat', 'Pin Chat'), order: 7 },
		{ id: ComposerUnpinChatAction.ID, title: localize('composer.menu.unpinChat', 'Unpin Chat'), order: 8 },
		{ id: ComposerCopyWorktreePathAction.ID, title: localize('composer.menu.copyWorktreePath', 'Copy worktree path'), order: 9, when: worktreeMenuWhen },
		{ id: ComposerOpenTerminalInWorktreeAction.ID, title: localize('composer.menu.openTerminalInWorktree', 'Open terminal in worktree'), order: 10, when: worktreeMenuWhen },
		{ id: ComposerOpenNewWindowInWorktreeAction.ID, title: localize('composer.menu.openNewWindowInWorktree', 'Open new window in worktree'), order: 11, when: worktreeMenuWhen },
	];
	for (const item of forkExtraMenuItems) {
		MenuRegistry.appendMenuItem(MenuId.EditorTitleContext, {
			group: '1_chatTools',
			order: item.order,
			when: item.when ?? ideChatScheme,
			command: {
				id: item.id,
				title: item.title,
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
