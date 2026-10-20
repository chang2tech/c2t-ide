/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// GAPS-158 (`editor-find-in-file`, 2026-10-20): pane-level "Find in File"
// routing command — the fork port of Cursor 3.25.9 glass `showFileEditorFind`
// (registration @45498568, handler `g2x` @45460552; full dissection in
// docs/rea/work-notes-gaps158.md). The find engine and widget are the STOCK
// Monaco editor find in both products; this file is only the Cursor layer:
// the weight-256 Ctrl+F routing + seeding the stock controller from the
// per-agent shared find state (glassFileEditorFindStateService port in
// fileEditorFindStateService.ts). NO find bar/engine is built here.
//
// Binary registration (verbatim): id "showFileEditorFind", title
// "Find in File", icon "search", glassCategory "View", keywords
// ["find","search","file","editor","buffer"], f1:{when: active tab kind ==
// File}, scope AGENT_WORKSPACE, keybindingCategory FILE, keybinding
// {weight:256, primary:CtrlCmd|KeyF, when:xan([Ot.File])},
// run: t=>{g2x(t)}.
//
// HONEST-DIVERGENCES (fork ports, in the GAPS-134 style):
//   D1: glass tabs do not exist in the fork — the fork's file surface IS
//     the stock editor. g2x's "active tab kind === File" gate and its
//     `dh`/`m3e` tab-handle resolution are ported onto the ACTIVE EDITOR
//     PANE: bail unless the active pane's control resolves to a code
//     editor (f2x port below). The markdown-WYSIWYG branch
//     (`markdownPreviewFindRequested`) has no fork surface and is not
//     ported — markdown preview find is a separate family.
//   D2: `xan([Ot.File])` (glassEditorPanelFocused && !transcriptFocused &&
//     !promptInputFocused && !chatFindInputFocused && tabKind==File) is
//     ported as `EditorContextKeys.focus`: in the fork the chat surfaces
//     are webviews whose focus never coincides with a code editor's
//     editorFocus, and a focused code editor IS the file surface — the
//     three negated glass contexts have no co-occurring fork counterpart.
//   D3: binary `f1:{when: tabKind==File}` is ported as f1:true +
//     precondition (the GAPS-134 D3 precedent): the stock StartFindAction
//     precondition `editorFocus || editorIsOpen`, the nearest fork
//     equivalent of "a file editor is the active surface".
//   D4: glassCategory "View" -> Categories.View; keybindingCategory FILE
//     and scope AGENT_WORKSPACE have no Action2 counterpart in the fork
//     and are not ported (same as the sibling glass families).
//   D5: the binary resolves its editor through the glass tab handle and
//     calls handle.focus(); the fork calls activePane.focus() BEFORE
//     resolving its editor — the same order as the binary's o.focus() ->
//     f2x(t, r) — because the active pane already holds the surface.
//     (Wording corrected by GAPS-166: an earlier version of this note
//     claimed the fork "focuses the resolved code editor directly",
//     which never matched the code; QA-162 point 2.)
//   D6 (GAPS-166, fix for QA-162 NEEDS-FIX P2): the D2 when port
//     (EditorContextKeys.focus) also matches code editors EMBEDDED
//     outside any editor pane — SCM input, debug REPL input, comments
//     editors are plain CodeEditorWidgets whose scoped context sets
//     editorFocus — while the binary's xan([Ot.File]) can never fire
//     there. The handler therefore guards BEFORE focusing anything: if
//     the FOCUSED code editor is not the active pane's resolved editor,
//     it delegates to the stock `actions.find` instead of stealing focus
//     to the pane or returning silently while the weight-256 binding has
//     already shadowed the stock weight-100 binding. The delegate is
//     exact: EditorCommand.runEditorCommand (editorExtensions.ts)
//     resolves `actions.find` against getFocusedCodeEditor() first, so
//     stock find opens on the very editor the user is typing in. The
//     same delegate is the fallback whenever no pane editor resolves at
//     all, so this command never swallows Ctrl+F.
//   D7 (GAPS-166, QA-162 nit P3): the binary registration's
//     keywords:["find","search","file","editor","buffer"] have NO fork
//     counterpart — IAction2Options / ICommandAction expose no keywords
//     field — so they are documented in this header only, not ported.

import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { getCodeEditor, ICodeEditor, isCodeEditor, isDiffEditor } from '../../../../editor/browser/editorBrowser.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { EditorOption } from '../../../../editor/common/config/editorOptions.js';
import { EditorContextKeys } from '../../../../editor/common/editorContextKeys.js';
import { FIND_IDS } from '../../../../editor/contrib/find/browser/findModel.js';
import { CommonFindController, FindStartFocusAction } from '../../../../editor/contrib/find/browser/findController.js';
import { localize2 } from '../../../../nls.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import {
	FILE_EDITOR_FIND_KEYBINDING_WEIGHT,
	SHOW_FILE_EDITOR_FIND_ID,
	computeSeededSearchString,
} from '../common/fileEditorFindState.js';
import { IFileEditorFindStateService, getFindSelectionSearchString } from './fileEditorFindStateService.js';

/**
 * f2x @45460231 port: resolve the code editor the find should target for
 * the active editor pane. The FOCUSED code editor wins when it is the
 * pane's own editor control, or — for a diff editor — its original or
 * modified editor; otherwise fall back to the pane's control unwrapped
 * via getCodeEditor() (the binary's `hO`: diff -> modified editor).
 */
function resolveFindTargetEditor(codeEditorService: ICodeEditorService, control: unknown): ICodeEditor | undefined {
	const focused = codeEditorService.getFocusedCodeEditor();
	if (focused) {
		if (isCodeEditor(control) && focused === control) {
			return focused;
		}
		if (isDiffEditor(control) && (focused === control.getOriginalEditor() || focused === control.getModifiedEditor())) {
			return focused;
		}
	}
	return getCodeEditor(control) ?? undefined;
}

/**
 * g2x @45460552 port — step order follows the binary exactly:
 *   gate on the file surface -> focus -> resolve editor -> controller?
 *   (no: execute stock `actions.find`, return) -> track -> read shared
 *   state -> compute seed -> layout() -> controller.start(stockOptions,
 *   {...sharedState, searchString: seed}).
 *
 * GAPS-166 guard (divergence D6 in the header): one step runs BEFORE the
 * binary's order — the focused-editor membership test. It changes
 * nothing when the focused editor IS the pane's editor (or when no code
 * editor is focused, e.g. command-palette invocation): the binary order
 * below then runs verbatim.
 */
export async function runShowFileEditorFind(accessor: ServicesAccessor): Promise<void> {
	const editorService = accessor.get(IEditorService);
	const commandService = accessor.get(ICommandService);
	const findStateService = accessor.get(IFileEditorFindStateService);
	const codeEditorService = accessor.get(ICodeEditorService);

	const activePane = editorService.activeEditorPane;
	const control = activePane?.getControl();

	// GAPS-166 guard (D6): the D2 when port fires on ANY focused code
	// editor, including ones embedded outside the editor pane (SCM input,
	// REPL input, comments editors). If the focused editor is not the
	// active pane's resolved editor, this handler does not serve it:
	// delegate to stock `actions.find`, which resolves the FOCUSED editor
	// (EditorCommand.runEditorCommand) — never focus the pane (no focus
	// steal), never return silently (no dead Ctrl+F).
	const focusedEditor = codeEditorService.getFocusedCodeEditor();
	const paneEditor = control ? resolveFindTargetEditor(codeEditorService, control) : undefined;
	if (focusedEditor && focusedEditor !== paneEditor) {
		await commandService.executeCommand(FIND_IDS.StartFindAction);
		return;
	}

	// Binary: bail unless the active tab exists, kind===Ot.File, and it has
	// an editor handle. Fork port (D1): the active editor pane's control.
	// GAPS-166: the bail now delegates instead of returning silently — no
	// focused editor exists on this path (the guard above handled it) and
	// stock find resolves the focused-or-active editor itself, no-op'ing
	// exactly like the old return when there is none.
	if (!activePane || !control || !paneEditor) {
		await commandService.executeCommand(FIND_IDS.StartFindAction);
		return;
	}

	// Binary: markdown-WYSIWYG preview branch — no fork surface (D1).

	// Binary: o.focus() then f2x resolution.
	activePane.focus();
	const editor = resolveFindTargetEditor(codeEditorService, control);
	if (!editor) {
		// Unreachable in practice (paneEditor resolved above from the
		// same control); delegate rather than swallow the keystroke.
		await commandService.executeCommand(FIND_IDS.StartFindAction);
		return;
	}

	const controller = CommonFindController.get(editor);
	if (!controller) {
		// Binary: `n.executeCommand(NC.StartFindAction)` — the stock
		// `actions.find`, verbatim; no seeding on this path.
		await commandService.executeCommand(FIND_IDS.StartFindAction);
		return;
	}

	findStateService.track(editor, controller);
	const sharedState = findStateService.getSharedState();
	const findOptions = editor.getOption(EditorOption.find);
	const seededSearchString = computeSeededSearchString(
		sharedState,
		controller.getState().isRegex,
		findOptions.seedSearchStringFromSelection,
		force => getFindSelectionSearchString(editor, 'single', force),
	);

	editor.layout();
	await controller.start({
		forceRevealReplace: false,
		seedSearchStringFromSelection: 'none',
		seedSearchStringFromNonEmptySelection: false,
		seedSearchStringFromGlobalClipboard: findOptions.globalFindClipboard,
		shouldFocus: FindStartFocusAction.FocusFindInput,
		shouldAnimate: true,
		updateSearchScope: false,
		loop: findOptions.loop,
	}, { ...sharedState, searchString: seededSearchString });
}

export class ShowFileEditorFindAction extends Action2 {
	static readonly ID = SHOW_FILE_EDITOR_FIND_ID;

	constructor() {
		super({
			id: ShowFileEditorFindAction.ID,
			title: localize2('showFileEditorFind', 'Find in File'),
			category: Categories.View,
			icon: Codicon.search,
			f1: true,
			// Binary f1:{when: active tab kind == File} — ported via
			// precondition (divergence D3 in the header note).
			precondition: ContextKeyExpr.or(EditorContextKeys.focus, ContextKeyExpr.has('editorIsOpen')),
			keybinding: {
				weight: FILE_EDITOR_FIND_KEYBINDING_WEIGHT,
				primary: KeyMod.CtrlCmd | KeyCode.KeyF,
				// Binary when: xan([Ot.File]) — ported (divergence D2).
				when: EditorContextKeys.focus,
			},
		});
	}

	async run(accessor: ServicesAccessor, ..._args: unknown[]): Promise<void> {
		await runShowFileEditorFind(accessor);
	}
}

export function registerFileEditorFindActions(): void {
	registerAction2(ShowFileEditorFindAction);
}
