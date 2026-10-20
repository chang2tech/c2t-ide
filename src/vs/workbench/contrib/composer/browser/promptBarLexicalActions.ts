/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: GAPS-139 — `editor.action.undoLexical` /
// `editor.action.redoLexical` (feature_id `lexical-undo-redo-prompt-bar`).
//
// REA EVIDENCE (Cursor 3.25.9 workbench.desktop.main.js @24818694,
// verbatim — docs/rea/work-notes-gaps139.md):
//   kBb=class extends Ka{constructor(){super({id:lis,label:"Undo Lexical",
//     alias:"Undo Lexical",precondition:void 0})}run(e,t,n){
//     nOe.get(t)?.undoLexical(n.historyState,n.promptBarId)}};vo(kBb);
//   wBb=class extends Ka{... id:uis "Redo Lexical" ... redoLexical(...)};vo(wBb);
// (`lis`="editor.action.undoLexical", `uis`="editor.action.redoLexical"
// from the id table @485385; `Ka` = EditorAction, `vo()` =
// registerEditorAction.)
//
// Same layer as the binary: real EditorActions registered via
// registerEditorAction, precondition undefined (no context key gates
// them), NO keybinding — in Cursor they are invoked programmatically
// by the "Lexical Operation" elements the prompt bar pushes onto the
// workbench undoRedoService (label "Lexical Operation", code
// "lexical-op"), whose undo/redo callbacks execute these commands with
// `{historyState, promptBarId}` args. The fork's prompt-bar service
// pushes the identical elements (see browser/inlineEditPromptBar.ts).
//
// HONEST-DIVERGENCE D2: the fork's history state lives inside the bar
// record (plain-text snapshots — the fork's prompt-bar input is a
// <textarea>, not a Lexical editor), so the run body forwards only
// `promptBarId`; a `historyState` arg, if present, is accepted and
// ignored exactly because the stack it would identify is the bar's own.

import { EditorAction, registerEditorAction } from '../../../../editor/browser/editorExtensions.js';
import { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IInlineEditPromptBar } from '../common/inlineEditPromptBar.js';

/** Args shape the binary's undo elements pass: `{historyState, promptBarId}`. */
export interface IPromptBarLexicalActionArgs {
	readonly promptBarId?: string;
	/** Binary-only (Lexical state object); ignored by the fork — see D2 above. */
	readonly historyState?: unknown;
}

export class UndoLexicalAction extends EditorAction {
	constructor() {
		super({
			id: 'editor.action.undoLexical',
			label: 'Undo Lexical',
			alias: 'Undo Lexical',
			precondition: undefined,
		});
	}

	run(accessor: ServicesAccessor, editor: ICodeEditor, args: unknown): void {
		const promptBarId = (args as IPromptBarLexicalActionArgs | undefined)?.promptBarId;
		accessor.get(IInlineEditPromptBar).undoLexical(editor, promptBarId);
	}
}

export class RedoLexicalAction extends EditorAction {
	constructor() {
		super({
			id: 'editor.action.redoLexical',
			label: 'Redo Lexical',
			alias: 'Redo Lexical',
			precondition: undefined,
		});
	}

	run(accessor: ServicesAccessor, editor: ICodeEditor, args: unknown): void {
		const promptBarId = (args as IPromptBarLexicalActionArgs | undefined)?.promptBarId;
		accessor.get(IInlineEditPromptBar).redoLexical(editor, promptBarId);
	}
}

registerEditorAction(UndoLexicalAction);
registerEditorAction(RedoLexicalAction);
