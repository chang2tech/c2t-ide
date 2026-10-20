/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ContextKeyValue, IContext } from '../../../../../platform/contextkey/common/contextkey.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { Event } from '../../../../../base/common/event.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import { KeybindingWeight } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IInlineEditService } from '../../common/inlineEditService.js';
import {
	InlineDiffContextKeys,
	EditorInlineDiffsAcceptAllAction,
	EditorInlineDiffsRejectAllAction,
	EditorInlineDiffsCancelEditsAction,
	EditorInlineDiffsAcceptPartialEditAction,
	EditorInlineDiffsRejectPartialEditAction,
	EditorInlineDiffsFocusEditorAction,
} from '../../browser/inlineDiffActions.js';

// WORKER-GAPS-34C (inline-edit-command-ids): Cursor 3.25.9 parity.
// Binary evidence (workbench.glass.main.js, re-verified by direct byte reads):
// - acceptAll  @22684828: id "editor.action.inlineDiffs.acceptAll",
//   label "Accept Edits", Ctrl/Cmd+Enter, weight 500,
//   precondition inlineDiffs.activeEditorWithDiffs (@22684218),
//   kbExpr editorTextFocus only.
// - rejectAll  @22686678: id "editor.action.inlineDiffs.rejectAll",
//   label "Undo Edits", Ctrl/Cmd+Shift+Backspace, weight 500, same
//   precondition, kbExpr editorTextFocus only.
// - cancelEdits: id "editor.action.inlineDiffs.cancelEdits",
//   label "Cancel Edits", Ctrl/Cmd+Shift+Backspace, weight 600,
//   precondition hasActivelyGeneratingDiff, kbExpr editorTextFocus only —
//   the SAME chord as rejectAll; weight 600 wins while generating.
// - acceptPartialEdit: "Accept Partial Edit", weight 500,
//   Win Ctrl+Shift+Y / mac Cmd+Y.
// - rejectPartialEdit: "Reject Partial Edit", weight 500, Ctrl/Cmd+N.

function context(values: Record<string, ContextKeyValue>): IContext {
	return { getValue: <T extends ContextKeyValue>(key: string) => values[key] as T | undefined };
}

interface RecordedCall { id: string; args: unknown[]; }

function accessorWithRecording(recorded: RecordedCall[], core?: Partial<IInlineEditService>): ServicesAccessor {
	const get = <T>(serviceId: unknown): T => {
		if (serviceId === ICommandService) {
			return {
				executeCommand: (id: string, ...args: unknown[]) => {
					recorded.push({ id, args });
					return Promise.resolve(undefined);
				},
			} as unknown as T;
		}
		if (serviceId === IInlineEditService) {
			// Production semantics: ServicesAccessor.get returns undefined
			// for an unregistered service (it only throws in strict/dev
			// mode) — the actions' `if (core)` live-path check relies on it.
			return (core ? core as unknown as T : undefined as unknown as T);
		}
		if (serviceId === IEditorService) {
			// No active editor in these tests — the partial actions then
			// resolve the hunk against the core service's fallback.
			return { activeTextEditorControl: undefined } as unknown as T;
		}
		throw new Error(`unexpected service requested in test: ${String(serviceId)}`);
	};
	return { get };
}

function fakeCore(calls: string[]): IInlineEditService {
	return {
		_serviceBrand: undefined,
		hasPendingEdit: true,
		isGenerating: false,
		openPrompt: async () => { calls.push('openPrompt'); },
		accept: () => { calls.push('accept'); },
		reject: async () => { calls.push('reject'); },
		cancelGeneration: () => { calls.push('cancelGeneration'); },
		// PARTIAL-DIFF-CORE (2026-10-20): the core service now owns
		// per-hunk accept/reject (Cursor's InlineDiffService mechanism).
		acceptPartial: async () => { calls.push('acceptPartial'); return false; },
		rejectPartial: async () => { calls.push('rejectPartial'); return false; },
		onDidAcceptPartialDiff: Event.None,
		onDidRejectPartialDiff: Event.None,
		// DEV-GAPS-53: suppression event (performance protection).
		onDidSuppressDiffDecorations: Event.None,
		escalateToAgent: async () => { calls.push('escalateToAgent'); },
	};
}

function titleValue(action: { desc: { title: unknown } }): string {
	const title = action.desc.title;
	return typeof title === 'string' ? title : (title as { value: string }).value;
}

function singleKeybinding(action: { desc: { keybinding: unknown } }) {
	const kb = action.desc.keybinding;
	assert.ok(kb && !Array.isArray(kb), 'expected a single keybinding rule');
	return kb as { primary: number; mac?: { primary: number }; weight?: number; when?: { evaluate(c: IContext): boolean } };
}

suite('Inline-diff accept/reject/cancel family (Cursor 3.25.9 parity)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('command ids are the binary-verbatim editor.action.inlineDiffs.* ids', () => {
		assert.strictEqual(EditorInlineDiffsAcceptAllAction.ID, 'editor.action.inlineDiffs.acceptAll');
		assert.strictEqual(EditorInlineDiffsRejectAllAction.ID, 'editor.action.inlineDiffs.rejectAll');
		assert.strictEqual(EditorInlineDiffsCancelEditsAction.ID, 'editor.action.inlineDiffs.cancelEdits');
		assert.strictEqual(EditorInlineDiffsAcceptPartialEditAction.ID, 'editor.action.inlineDiffs.acceptPartialEdit');
		assert.strictEqual(EditorInlineDiffsRejectPartialEditAction.ID, 'editor.action.inlineDiffs.rejectPartialEdit');
	});

	test('titles, f1, and preconditions match the binary', () => {
		const cases = [
			{ action: new EditorInlineDiffsAcceptAllAction(), title: 'Accept Edits', precondition: InlineDiffContextKeys.activeEditorWithDiffs },
			{ action: new EditorInlineDiffsRejectAllAction(), title: 'Undo Edits', precondition: InlineDiffContextKeys.activeEditorWithDiffs },
			{ action: new EditorInlineDiffsCancelEditsAction(), title: 'Cancel Edits', precondition: InlineDiffContextKeys.hasActivelyGeneratingDiff },
			{ action: new EditorInlineDiffsAcceptPartialEditAction(), title: 'Accept Partial Edit', precondition: InlineDiffContextKeys.activeEditorWithDiffs },
			{ action: new EditorInlineDiffsRejectPartialEditAction(), title: 'Reject Partial Edit', precondition: InlineDiffContextKeys.activeEditorWithDiffs },
		] as const;
		for (const c of cases) {
			assert.strictEqual(c.action.desc.id, (c.action.constructor as { ID: string }).ID);
			assert.strictEqual(titleValue(c.action), c.title, `${c.action.desc.id} title`);
			assert.strictEqual(c.action.desc.f1, true, `${c.action.desc.id} palette-visible`);
			assert.strictEqual(c.action.desc.precondition, c.precondition, `${c.action.desc.id} precondition`);
			assert.strictEqual(c.action.desc.category, undefined, `${c.action.desc.id} has no category (binary has none)`);
		}
	});

	test('context-key strings are the binary-verbatim ones', () => {
		assert.strictEqual(InlineDiffContextKeys.activeEditorWithDiffs.key, 'inlineDiffs.activeEditorWithDiffs');
		assert.strictEqual(InlineDiffContextKeys.hasActivelyGeneratingDiff.key, 'hasActivelyGeneratingDiff');
	});

	test('acceptAll: Ctrl/Cmd+Enter @500, when = editorTextFocus only (binary kbExpr)', () => {
		const kb = singleKeybinding(new EditorInlineDiffsAcceptAllAction());
		assert.strictEqual(kb.weight, 500);
		assert.strictEqual(kb.primary, KeyMod.CtrlCmd | KeyCode.Enter);
		assert.ok(kb.when, 'when clause defined');
		// binary kbExpr is editorTextFocus ALONE — the diff-pending gate is the
		// action precondition, not the keybinding
		assert.strictEqual(kb.when!.evaluate(context({ editorTextFocus: true })), true);
		assert.strictEqual(kb.when!.evaluate(context({})), false);
		assert.strictEqual(kb.when!.evaluate(context({ editorTextFocus: true, 'inlineDiffs.activeEditorWithDiffs': false })), true,
			'keybinding fires on editorTextFocus regardless of the pending-diff key; the precondition gates the command');
	});

	test('rejectAll: Ctrl/Cmd+Shift+Backspace @500, when = editorTextFocus only', () => {
		const kb = singleKeybinding(new EditorInlineDiffsRejectAllAction());
		assert.strictEqual(kb.weight, 500);
		assert.strictEqual(kb.primary, KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Backspace);
		assert.strictEqual(kb.when!.evaluate(context({ editorTextFocus: true })), true);
		assert.strictEqual(kb.when!.evaluate(context({})), false);
	});

	test('cancelEdits: same chord as rejectAll @600 — wins while generating (binary)', () => {
		const cancelKb = singleKeybinding(new EditorInlineDiffsCancelEditsAction());
		const rejectKb = singleKeybinding(new EditorInlineDiffsRejectAllAction());
		assert.strictEqual(cancelKb.weight, 600);
		assert.strictEqual(cancelKb.primary, rejectKb.primary, 'same chord: Ctrl/Cmd+Shift+Backspace');
		assert.ok((cancelKb.weight as number) > (rejectKb.weight as number), 'cancelEdits outranks rejectAll');
		assert.strictEqual(cancelKb.when!.evaluate(context({ editorTextFocus: true })), true);
		assert.strictEqual(cancelKb.when!.evaluate(context({})), false);
	});

	test('acceptPartialEdit: Win Ctrl+Shift+Y / mac Cmd+Y @500', () => {
		const kb = singleKeybinding(new EditorInlineDiffsAcceptPartialEditAction());
		assert.strictEqual(kb.weight, 500);
		assert.strictEqual(kb.primary, KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyY);
		assert.ok(kb.mac, 'mac override defined');
		assert.strictEqual(kb.mac!.primary, KeyMod.CtrlCmd | KeyCode.KeyY);
		assert.strictEqual(kb.when!.evaluate(context({ editorTextFocus: true })), true);
	});

	test('rejectPartialEdit: Ctrl/Cmd+N @500', () => {
		const kb = singleKeybinding(new EditorInlineDiffsRejectPartialEditAction());
		assert.strictEqual(kb.weight, 500);
		assert.strictEqual(kb.primary, KeyMod.CtrlCmd | KeyCode.KeyN);
		assert.strictEqual(kb.when!.evaluate(context({ editorTextFocus: true })), true);
	});

	test('run(): live path calls the core service', async () => {
		const calls: string[] = [];
		const recorded: RecordedCall[] = [];
		const core = fakeCore(calls);
		const accessor = accessorWithRecording(recorded, core);

		await new EditorInlineDiffsAcceptAllAction().run(accessor);
		await new EditorInlineDiffsRejectAllAction().run(accessor);
		await new EditorInlineDiffsCancelEditsAction().run(accessor);
		await new EditorInlineDiffsAcceptPartialEditAction().run(accessor);
		await new EditorInlineDiffsRejectPartialEditAction().run(accessor);
		assert.deepStrictEqual(calls, ['accept', 'reject', 'cancelGeneration', 'acceptPartial', 'rejectPartial']);
		assert.deepStrictEqual(recorded, [], 'no extension fallback on the live path');
	});

	test('run(): web/aux fallback executes the ide.* runtime commands', async () => {
		const recorded: RecordedCall[] = [];
		const accessor = accessorWithRecording(recorded); // no core service
		await new EditorInlineDiffsAcceptAllAction().run(accessor);
		await new EditorInlineDiffsRejectAllAction().run(accessor);
		await new EditorInlineDiffsCancelEditsAction().run(accessor);
		await new EditorInlineDiffsAcceptPartialEditAction().run(accessor);
		await new EditorInlineDiffsRejectPartialEditAction().run(accessor);
		assert.deepStrictEqual(recorded.map(r => r.id), [
			'ide.acceptInlineEdit',
			'ide.rejectInlineEdit',
			'ide.cancelInlineEditGeneration',
			'ide.acceptPartialInlineEdit',
			'ide.rejectPartialInlineEdit',
		]);
	});

	test('precondition truth table: commands gated on the binary context keys', () => {
		const acceptPre = new EditorInlineDiffsAcceptAllAction().desc.precondition!;
		const cancelPre = new EditorInlineDiffsCancelEditsAction().desc.precondition!;
		assert.strictEqual(acceptPre.evaluate(context({ 'inlineDiffs.activeEditorWithDiffs': true })), true);
		assert.strictEqual(acceptPre.evaluate(context({ 'inlineDiffs.activeEditorWithDiffs': false })), false);
		assert.strictEqual(cancelPre.evaluate(context({ 'hasActivelyGeneratingDiff': true })), true);
		assert.strictEqual(cancelPre.evaluate(context({ 'hasActivelyGeneratingDiff': false })), false);
	});

	// GAPS-171 (STILL-OPEN #26 remainder): `editor.action.inlineDiffs.focusEditor`
	// — binary glass class `koo` (@~40746850, re-sliced by GAPS-171):
	// LABEL "Focus editor", f1:!1, keybinding {primary: CtrlCmd|KeyK,
	// secondary: [CtrlCmd|Shift|KeyK], weight: 1402, when:
	// editorHasPromptBar && editorPromptBarFocused}, run =
	// `activeEditorPane?.focus()`. Desktop class `ILr` @32243424 identical.
	test('focusEditor: id/title/f1 match the binary; no category, no precondition', () => {
		const action = new EditorInlineDiffsFocusEditorAction();
		assert.strictEqual(EditorInlineDiffsFocusEditorAction.ID, 'editor.action.inlineDiffs.focusEditor');
		assert.strictEqual(titleValue(action), 'Focus editor');
		assert.strictEqual(action.desc.f1, false, 'binary f1:!1 — hidden from the palette');
		assert.strictEqual(action.desc.category, undefined);
		assert.strictEqual(action.desc.precondition, undefined);
	});

	test('focusEditor: Ctrl+K primary + Shift+K secondary @1402, when = prompt bar open AND focused', () => {
		const kb = new EditorInlineDiffsFocusEditorAction().desc.keybinding as unknown as {
			primary: number; secondary?: number[]; weight?: number;
			when?: { evaluate(c: IContext): boolean };
		};
		assert.ok(kb, 'keybinding defined');
		assert.strictEqual(kb.weight, 1402, 'beats modal.generate (1401) for both chords while the bar is focused');
		assert.strictEqual(kb.primary, KeyMod.CtrlCmd | KeyCode.KeyK);
		assert.deepStrictEqual(kb.secondary, [KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyK]);
		assert.strictEqual(kb.when!.evaluate(context({ editorHasPromptBar: true, editorPromptBarFocused: true })), true);
		assert.strictEqual(kb.when!.evaluate(context({ editorHasPromptBar: true, editorPromptBarFocused: false })), false);
		assert.strictEqual(kb.when!.evaluate(context({ editorHasPromptBar: false, editorPromptBarFocused: true })), false);
		assert.strictEqual(kb.when!.evaluate(context({})), false);
	});

	test('focusEditor run(): focuses the active editor PANE (binary verbatim); no pane → no-op', () => {
		let focusCalls = 0;
		const withPane = {
			get: (id: unknown) => {
				if (id === IEditorService) {
					return { activeEditorPane: { focus: () => { focusCalls++; } } };
				}
				throw new Error(`unexpected service requested in test: ${String(id)}`);
			},
		} as unknown as ServicesAccessor;
		new EditorInlineDiffsFocusEditorAction().run(withPane);
		assert.strictEqual(focusCalls, 1);

		const withoutPane = {
			get: (id: unknown) => {
				if (id === IEditorService) {
					return { activeEditorPane: undefined };
				}
				throw new Error(`unexpected service requested in test: ${String(id)}`);
			},
		} as unknown as ServicesAccessor;
		new EditorInlineDiffsFocusEditorAction().run(withoutPane);
		assert.strictEqual(focusCalls, 1, 'no active pane → binary optional-chain no-op');
	});
});
