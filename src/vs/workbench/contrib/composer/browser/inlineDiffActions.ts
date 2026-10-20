/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// WORKER-GAPS-34C (inline-edit-command-ids, P1): Cursor 3.25.9 parity for the
// inline-diff accept/reject/cancel command family.
//
// Binary evidence (workbench.glass.main.js 3.25.9, re-verified 2026-10-20 by
// direct byte reads at the stated offsets):
// - `IMi="editor.action.inlineDiffs.acceptAll"` @22684828:
//   `id:IMi,label:"Accept Edits",alias:"Accept Edits",precondition:ext,
//   kbOpts:{kbExpr:di.editorTextFocus,primary:dt.CtrlCmd|Xe.Enter,
//   weight:500}})}run(e,n,i){...J4.get(n)?.acceptSuggestion(i,"both")}})`
//   (`ext` = `inlineDiffs.activeEditorWithDiffs`, defined @22684218 as
//   `new pn("inlineDiffs.activeEditorWithDiffs",!1,{...})`.)
// - `IMn="editor.action.inlineDiffs.rejectAll"` @22686678:
//   `id:IMn,label:"Undo Edits",alias:"Undo Edits",precondition:ext,
//   kbOpts:{kbExpr:di.editorTextFocus,primary:dt.CtrlCmd|dt.Shift|Xe.Backspace,
//   weight:500}})}run(e,n,i){...J4.get(n)?.rejectSuggestion(i,"both");...}`
// - `xMi="editor.action.inlineDiffs.cancelEdits"`:
//   `id:xMi,label:"Cancel Edits",alias:"Cancel Edits",
//   precondition:di.hasActivelyGeneratingDiff,
//   kbOpts:{kbExpr:di.editorTextFocus,primary:dt.CtrlCmd|dt.Shift|Xe.Backspace,
//   weight:600}})}run(t,e,n){m9e(t,e)||(t.get(Ov).publicLogCapture("Cancelled
//   Diff"),J4.get(e)?.cancelGeneration(n,"both"))}}`
//   (`hasActivelyGeneratingDiff` = `pn("hasActivelyGeneratingDiff",!1,
//   "Whether the editor is currently generating an edit.")` — unprefixed,
//   verbatim.) The same Ctrl/Cmd+Shift+Backspace chord as rejectAll, but
//   weight 600 wins while a generation is in flight; once the preview lands,
//   rejectAll (500) owns the chord.
// - `editor.action.inlineDiffs.acceptPartialEdit` — "Accept Partial Edit",
//   weight 500, `primary:La?CtrlCmd|Shift|KeyY:CtrlCmd|KeyY` (the dig report
//   reads `La` as isWindows: Win Ctrl+Shift+Y, mac Cmd+Y — the ternary's
//   predicate is minified, flagged as a residual in
//   dig-continuous-inline-edit-2026-10-19.md §3.3; the fork follows the
//   existing platform-override convention used by every other action here).
// - `editor.action.inlineDiffs.rejectPartialEdit` — "Reject Partial Edit",
//   weight 500, `primary:dt.CtrlCmd|Xe.KeyN`.
//
// What the fork had before (replaced by this file):
// - `composer.acceptInlineEdit` ("Accept Inline Edit", f1) and
//   `composer.rejectInlineEdit` ("Reject Inline Edit", f1) — wrong command
//   family: Cursor registers these as `editor.action.inlineDiffs.*`
//   editor actions with different labels, weights 500/600, and the
//   `inlineDiffs.activeEditorWithDiffs` / `hasActivelyGeneratingDiff`
//   preconditions. The old actions had zero production callers (verified by
//   grep) and were removed; the extension's `ide.acceptInlineEdit` /
//   `ide.rejectInlineEdit` runtime commands stay as the web/aux fallback
//   targets and are hidden from the palette (package.json
//   `menus.commandPalette`, `when:false`) so there is exactly one visible
//   entry per action.
// - No `cancelEdits` at all.
//
// FAITHFUL-PORT NOTES:
// - Command ids are the binary-verbatim `editor.action.inlineDiffs.*` ids
//   (no `composer.` prefix — Cursor's own ids, like the binary has them).
// - No palette category: the binary registers these as editor actions with
//   no category (unlike the fork's usual "Composer" category).
// - Weights: the binary's 500/600 are cast verbatim (`500 as
//   KeybindingWeight`, `600 as KeybindingWeight`), the same pattern as the
//   600-weight `composer.openModeMenu` port — the fork's
//   KeybindingWeight enum tops out at 400 (ExternalExtension), so the named
//   members cannot express Cursor's resolution order. 600 > 500 preserves
//   cancelEdits winning the shared chord while generating.
// - Keybinding when-clause: the binary's `kbExpr` is `di.editorTextFocus`
//   ONLY — the diff-pending condition lives in the ACTION PRECONDITION
//   (`precondition:ext`), not in the keybinding. Ported exactly that way:
//   the palette entry is disabled when no diff is pending (Cursor's
//   editor-action precondition semantics), and the chord fires only with
//   editor text focus.
// - `mac` override on acceptPartialEdit: the existing fork convention for a
//   Win-vs-mac primary split (see ComposerAcceptInlineEditAction's mac
//   override, now removed). The binary ternary predicate is unrecovered;
//   Win Ctrl+Shift+Y / mac Cmd+Y is the dig report's best reading.
// - `run()` delegates to the workbench-core `IInlineEditService` (the live
//   path, like `ComposerOpenInlinePromptAction`), falling back to the
//   ide-agent extension's `ide.*` runtime commands on web/aux builds where
//   the electron-browser contribution is not loaded. Per-hunk accept/reject
//   is implemented in the core service (`acceptPartial`/`rejectPartial` —
//   Cursor's `InlineDiffService.acceptPartialDiff`/`rejectPartialDiff`
//   mechanism: closest-hunk search, undo elements, `inlineDiffAcceptPartial`
//   / `inlineDiffRejectPartial` telemetry, partial-diff events, prompt bar
//   closed when the last change resolves).
// - Ctrl/Cmd+N is ALSO bound to "New Agent Chat" (`ComposerNewAgentChatAction`,
//   no when clause). Like Cursor, the inline-diff binding wins while a diff
//   is pending because the command precondition disables the new-agent
//   variant's resolution path — Ctrl/Cmd+N creates a new agent chat again
//   once the preview closes (pre-existing fork note, carried over).

import { localize2 } from '../../../../nls.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { EditorContextKeys } from '../../../../editor/common/editorContextKeys.js';
import type { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IInlineEditService } from '../common/inlineEditService.js';
import { ComposerContextKeys } from '../common/composerContextKeys.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import {
	INLINE_DIFFS_ACTIVE_EDITOR_WITH_DIFFS,
	INLINE_DIFFS_HAS_ACTIVELY_GENERATING_DIFF,
} from '../common/inlineDiffContextKeys.js';

/** Binary-verbatim context keys consumed by the preconditions below. */
export namespace InlineDiffContextKeys {
	/** `inlineDiffs.activeEditorWithDiffs` (binary @22684218). */
	export const activeEditorWithDiffs = new RawContextKey<boolean>(INLINE_DIFFS_ACTIVE_EDITOR_WITH_DIFFS, false);
	/** `hasActivelyGeneratingDiff` (binary, unprefixed). */
	export const hasActivelyGeneratingDiff = new RawContextKey<boolean>(INLINE_DIFFS_HAS_ACTIVELY_GENERATING_DIFF, false);
}

/** Binary weight 500 for acceptAll/rejectAll/partials (cast — see file docblock). */
const inlineDiffsWeight500 = 500 as KeybindingWeight;

/** Binary weight 600 for cancelEdits (cast — wins the shared chord while generating). */
const inlineDiffsWeight600 = 600 as KeybindingWeight;

function getCoreInlineEditService(accessor: ServicesAccessor): IInlineEditService | undefined {
	return accessor.get(IInlineEditService) as IInlineEditService | undefined;
}

/**
 * The active code editor for the partial-edit actions (the hunk is resolved
 * relative to the cursor — Cursor's `acceptPartialDiff(diffId, position)`).
 * Local copy of composerActions' helper (importing it would cycle back into
 * this module via `registerInlineDiffActions`).
 */
function activeCodeEditorFromAction(accessor: ServicesAccessor): ICodeEditor | undefined {
	const control = accessor.get(IEditorService).activeTextEditorControl;
	if (!control) {
		return undefined;
	}
	const candidate = control as Partial<ICodeEditor>;
	return typeof candidate.getModel === 'function' && typeof candidate.getPosition === 'function'
		? (control as ICodeEditor)
		: undefined;
}

/** `editor.action.inlineDiffs.acceptAll` — "Accept Edits" (binary @22684828). */
export class EditorInlineDiffsAcceptAllAction extends Action2 {
	static readonly ID = 'editor.action.inlineDiffs.acceptAll';
	constructor() {
		super({
			id: EditorInlineDiffsAcceptAllAction.ID,
			title: localize2('inlineDiffs.acceptAll', 'Accept Edits'),
			f1: true,
			precondition: InlineDiffContextKeys.activeEditorWithDiffs,
			keybinding: {
				weight: inlineDiffsWeight500,
				primary: KeyMod.CtrlCmd | KeyCode.Enter,
				when: EditorContextKeys.editorTextFocus,
			},
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// Live path — accept the core preview (Cursor's J4 controller layer).
		const core = getCoreInlineEditService(accessor);
		if (core) {
			core.accept();
			return;
		}
		// Web/aux builds: the electron-browser contribution is not loaded —
		// fall back to the extension runtime's inline-edit session.
		await accessor.get(ICommandService).executeCommand('ide.acceptInlineEdit', ...args);
	}
}

/** `editor.action.inlineDiffs.rejectAll` — "Undo Edits" (binary @22686678). */
export class EditorInlineDiffsRejectAllAction extends Action2 {
	static readonly ID = 'editor.action.inlineDiffs.rejectAll';
	constructor() {
		super({
			id: EditorInlineDiffsRejectAllAction.ID,
			title: localize2('inlineDiffs.rejectAll', 'Undo Edits'),
			f1: true,
			precondition: InlineDiffContextKeys.activeEditorWithDiffs,
			keybinding: {
				weight: inlineDiffsWeight500,
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Backspace,
				when: EditorContextKeys.editorTextFocus,
			},
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		const core = getCoreInlineEditService(accessor);
		if (core) {
			await core.reject();
			return;
		}
		await accessor.get(ICommandService).executeCommand('ide.rejectInlineEdit', ...args);
	}
}

/** `editor.action.inlineDiffs.cancelEdits` — "Cancel Edits" (binary, weight 600). */
export class EditorInlineDiffsCancelEditsAction extends Action2 {
	static readonly ID = 'editor.action.inlineDiffs.cancelEdits';
	constructor() {
		super({
			id: EditorInlineDiffsCancelEditsAction.ID,
			title: localize2('inlineDiffs.cancelEdits', 'Cancel Edits'),
			f1: true,
			precondition: InlineDiffContextKeys.hasActivelyGeneratingDiff,
			keybinding: {
				weight: inlineDiffsWeight600,
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Backspace,
				when: EditorContextKeys.editorTextFocus,
			},
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		const core = getCoreInlineEditService(accessor);
		if (core) {
			core.cancelGeneration();
			return;
		}
		await accessor.get(ICommandService).executeCommand('ide.cancelInlineEditGeneration', ...args);
	}
}

/** `editor.action.inlineDiffs.acceptPartialEdit` — "Accept Partial Edit". */
export class EditorInlineDiffsAcceptPartialEditAction extends Action2 {
	static readonly ID = 'editor.action.inlineDiffs.acceptPartialEdit';
	constructor() {
		super({
			id: EditorInlineDiffsAcceptPartialEditAction.ID,
			title: localize2('inlineDiffs.acceptPartialEdit', 'Accept Partial Edit'),
			f1: true,
			precondition: InlineDiffContextKeys.activeEditorWithDiffs,
			keybinding: {
				weight: inlineDiffsWeight500,
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyY,
				mac: { primary: KeyMod.CtrlCmd | KeyCode.KeyY },
				when: EditorContextKeys.editorTextFocus,
			},
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// PARTIAL-DIFF-CORE (2026-10-20): live path — the core
		// InlineEditService owns per-hunk accept, like Cursor's
		// `InlineDiffService.acceptPartialDiff` in workbench core. Falls back
		// to the extension runtime on web/aux builds where the
		// electron-browser contribution is not loaded.
		const core = getCoreInlineEditService(accessor);
		if (core) {
			const editor = activeCodeEditorFromAction(accessor);
			await core.acceptPartial(editor?.getPosition() ?? undefined);
			return;
		}
		await accessor.get(ICommandService).executeCommand('ide.acceptPartialInlineEdit', ...args);
	}
}

/** `editor.action.inlineDiffs.rejectPartialEdit` — "Reject Partial Edit". */
export class EditorInlineDiffsRejectPartialEditAction extends Action2 {
	static readonly ID = 'editor.action.inlineDiffs.rejectPartialEdit';
	constructor() {
		super({
			id: EditorInlineDiffsRejectPartialEditAction.ID,
			title: localize2('inlineDiffs.rejectPartialEdit', 'Reject Partial Edit'),
			f1: true,
			precondition: InlineDiffContextKeys.activeEditorWithDiffs,
			keybinding: {
				weight: inlineDiffsWeight500,
				primary: KeyMod.CtrlCmd | KeyCode.KeyN,
				when: EditorContextKeys.editorTextFocus,
			},
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// PARTIAL-DIFF-CORE (2026-10-20): live path — the core
		// InlineEditService owns per-hunk reject, like Cursor's
		// `InlineDiffService.rejectPartialDiff` in workbench core. Falls back
		// to the extension runtime on web/aux builds where the
		// electron-browser contribution is not loaded.
		const core = getCoreInlineEditService(accessor);
		if (core) {
			const editor = activeCodeEditorFromAction(accessor);
			await core.rejectPartial(editor?.getPosition() ?? undefined);
			return;
		}
		await accessor.get(ICommandService).executeCommand('ide.rejectPartialInlineEdit', ...args);
	}
}

/**
 * `editor.action.inlineDiffs.focusEditor` — "Focus editor" (GAPS-171,
 * STILL-OPEN #26 remainder). Binary evidence (Cursor 3.25.9, re-sliced by
 * GAPS-171 from BOTH bundles):
 * - glass class `koo`, super slice @~40746850, `.ID`/`LABEL` assigned right
 *   after the class:
 *   `super({id:koo.ID, title:{value:koo.LABEL, original:koo.LABEL}, f1:!1,
 *     keybinding:{primary:dt.CtrlCmd|Xe.KeyK, secondary:[tPb], weight:1402,
 *       when:ft.and(di.editorHasPromptBar.isEqualTo(!0),
 *                   di.editorPromptBarFocused.isEqualTo(!0))}})
 *    run(e){ e.get(mr).activeEditorPane?.focus() }`
 *   `koo.ID="editor.action.inlineDiffs.focusEditor"`, `koo.LABEL="Focus editor"`.
 * - desktop class `ILr` @32243424 is identical (`secondary:[Cwm]`).
 * - `tPb` (glass) / `Cwm` (desktop) = `CtrlCmd|Shift|KeyK` (glass: the last
 *   `tPb=` definition before the class, @40731457, same prompt-bar module;
 *   desktop: `Cwm=Me.CtrlCmd|Me.Shift|ve.KeyK` @32227962).
 * Weight 1402 (cast verbatim, same pattern as the 500/600 casts above) beats
 * `aipopup.action.modal.generate`'s 1401 for BOTH chords while the prompt bar
 * is focused: Ctrl+K / Ctrl+Shift+K then return focus to the editor pane
 * instead of generating. NO category in the binary (editor action).
 * run() is the binary's verbatim body: `activeEditorPane?.focus()` on
 * IEditorService — the editor PANE, not the code-editor widget (that is what
 * distinguishes this from the fork-local `composer.focusEditorFromDiff`,
 * which stays untouched).
 */
export class EditorInlineDiffsFocusEditorAction extends Action2 {
	static readonly ID = 'editor.action.inlineDiffs.focusEditor';
	constructor() {
		super({
			id: EditorInlineDiffsFocusEditorAction.ID,
			title: localize2('inlineDiffs.focusEditor', 'Focus editor'),
			f1: false,
			keybinding: {
				weight: 1402 as KeybindingWeight,
				primary: KeyMod.CtrlCmd | KeyCode.KeyK,
				secondary: [KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyK],
				when: ContextKeyExpr.and(ComposerContextKeys.editorHasPromptBar, ComposerContextKeys.editorPromptBarFocused),
			},
		});
	}

	run(accessor: ServicesAccessor): void {
		// Binary verbatim: `e.get(mr).activeEditorPane?.focus()`.
		accessor.get(IEditorService).activeEditorPane?.focus();
	}
}

/** Register the Cursor inline-diff accept/reject/cancel command family. */
export function registerInlineDiffActions(): void {
	registerAction2(EditorInlineDiffsAcceptAllAction);
	registerAction2(EditorInlineDiffsRejectAllAction);
	registerAction2(EditorInlineDiffsCancelEditsAction);
	registerAction2(EditorInlineDiffsAcceptPartialEditAction);
	registerAction2(EditorInlineDiffsRejectPartialEditAction);
	registerAction2(EditorInlineDiffsFocusEditorAction);
}
