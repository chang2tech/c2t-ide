/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: inline-diff context-key strings (common layer — node-free, no DOM).
//
// These are the VERBATIM context-key strings Cursor registers for its inline
// diff (Cmd+K) controller, recovered from workbench.glass.main.js 3.25.9:
// - `inlineDiffs.activeEditorWithDiffs`  @22684218:
//   `new pn("inlineDiffs.activeEditorWithDiffs",!1,{type:"boolean",
//   description:D(1381,null)})` — the precondition (`precondition:ext`) on
//   `editor.action.inlineDiffs.acceptAll` ("Accept Edits", @22684828) and
//   `editor.action.inlineDiffs.rejectAll` ("Undo Edits", @22686678).
// - `hasActivelyGeneratingDiff`          (unprefixed, verbatim):
//   `pn("hasActivelyGeneratingDiff",!1,"Whether the editor is currently
//   generating an edit.")` — the precondition on
//   `editor.action.inlineDiffs.cancelEdits` ("Cancel Edits", weight 600,
//   same Ctrl/Cmd+Shift+Backspace chord as rejectAll; wins while generating).
//
// Both the workbench-core InlineEditService (electron-browser/) and the
// ide-agent extension (web/aux fallback) set these keys so the keybindings'
// preconditions hold on every build. See browser/inlineDiffActions.ts for the
// Action2 commands that consume them.

/** Verbatim Cursor context-key: a diff preview is pending in the active editor. */
export const INLINE_DIFFS_ACTIVE_EDITOR_WITH_DIFFS = 'inlineDiffs.activeEditorWithDiffs';

/** Verbatim Cursor context-key: an inline-diff generation is in flight. */
export const INLINE_DIFFS_HAS_ACTIVELY_GENERATING_DIFF = 'hasActivelyGeneratingDiff';
