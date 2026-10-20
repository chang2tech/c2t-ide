/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ContextKeyValue, IContext } from '../../../../../platform/contextkey/common/contextkey.js';
import { KeybindingWeight } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ComposerContextKeys } from '../../common/composerContextKeys.js';
import { CmdkTogglePromptBarModelAction, ComposerCycleModelParameterAction, ComposerOpenModelPickerAction } from '../../browser/composerActions.js';

function context(values: Record<string, ContextKeyValue>): IContext {
	return { getValue: <T extends ContextKeyValue>(key: string) => values[key] as T | undefined };
}

function kbOf(action: { desc: { keybinding: unknown } }) {
	const kb = action.desc.keybinding as { primary?: number; secondary?: number[]; weight?: number; when?: { evaluate(c: IContext): boolean } } | undefined;
	assert.ok(kb, 'keybinding is registered');
	return kb;
}

// WORKER-GAPS-20B: Ctrl+/ collision between `composer.openModelPicker` and
// `cmdk.togglePromptBarModel`. Binary evidence (Cursor 3.25.9,
// workbench.glass.main.js):
//   - @45366438 `glass.openModelPicker` ("Select Model"): weight yk=250,
//     primary CtrlCmd+Slash, NO secondary,
//     when !terminalFocusInAny && !editorTextFocus, f1 true.
//   - @40750679 `cmdk.togglePromptBarModel` ("Open model toggle"):
//     weight 200, primary CtrlCmd+Slash, secondary CtrlCmd+Alt+Slash,
//     when editorHasPromptBar && editorPromptBarFocused, f1 false.
// Cursor registers BOTH on Ctrl+/ and resolves the shared chord by WEIGHT
// (250 > 200). The fork's bug was weight 200 on both (ambiguous,
// registration-order-dependent dispatch). The fix mirrors the binary:
// SessionsContrib (250) vs WorkbenchContrib (200).
suite('Ctrl+/ keybinding collision (Cursor 3.25.9 parity)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('cmdk.togglePromptBarModel: binary-verbatim registration', () => {
		const action = new CmdkTogglePromptBarModelAction();
		assert.strictEqual(action.desc.id, 'cmdk.togglePromptBarModel');
		assert.strictEqual(action.desc.title.value, 'Open model toggle');
		// Binary f1:!1 — hidden from the palette (was f1:true in the fork).
		assert.strictEqual(action.desc.f1, false);

		const kb = kbOf(action);
		// Binary: primary CtrlCmd+Slash, secondary CtrlCmd+Alt+Slash, weight 200.
		assert.strictEqual(kb.primary, KeyMod.CtrlCmd | KeyCode.Slash);
		assert.deepStrictEqual(kb.secondary, [KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.Slash]);
		assert.strictEqual(kb.weight, KeybindingWeight.WorkbenchContrib);
		assert.strictEqual(kb.weight, 200);
		assert.ok(kb.when, 'when is defined');
	});

	test('composer.openModelPicker: binary-verbatim registration (glass.openModelPicker)', () => {
		const action = new ComposerOpenModelPickerAction();
		assert.strictEqual(action.desc.id, 'composer.openModelPicker');
		// Binary f1:!0 — visible in the palette.
		assert.strictEqual(action.desc.f1, true);

		const kb = kbOf(action);
		// Binary: primary CtrlCmd+Slash, NO secondary chord.
		assert.strictEqual(kb.primary, KeyMod.CtrlCmd | KeyCode.Slash);
		assert.ok(!kb.secondary || kb.secondary.length === 0, 'binary has no secondary chord');
		// Binary weight yk=250 = KeybindingWeight.SessionsContrib (was
		// WorkbenchContrib/200 in the fork — the actual collision).
		assert.strictEqual(kb.weight, KeybindingWeight.SessionsContrib);
		assert.strictEqual(kb.weight, 250);
		assert.ok(kb.when, 'when is defined');
	});

	test('shared Ctrl+/ resolves by weight (250 > 200), mirroring Cursor', () => {
		const toggle = new CmdkTogglePromptBarModelAction();
		const picker = new ComposerOpenModelPickerAction();
		const toggleKb = kbOf(toggle);
		const pickerKb = kbOf(picker);

		assert.strictEqual(toggleKb.primary, pickerKb.primary, 'both register CtrlCmd+/');
		// The regression: equal weights made dispatch ambiguous. The binary
		// disambiguates by weight (yk=250 vs 200).
		assert.ok((pickerKb.weight ?? 0) > (toggleKb.weight ?? 0),
			'model picker (250) outranks the prompt-bar toggle (200) — Cursor\'s own resolution');
		assert.notStrictEqual(pickerKb.weight, toggleKb.weight, 'weights must differ');
	});

	test('when-clauses: prompt-bar focus vs terminal/editor gating', () => {
		const toggle = new CmdkTogglePromptBarModelAction();
		const picker = new ComposerOpenModelPickerAction();
		const toggleKb = kbOf(toggle);
		const pickerKb = kbOf(picker);

		const promptBarFocused = context({
			[ComposerContextKeys.editorHasPromptBar.key]: true,
			[ComposerContextKeys.editorPromptBarFocused.key]: true,
			editorTextFocus: false,
			terminalFocusInAny: false,
		});
		// Both when-clauses hold here (prompt-bar input is a DOM input, not a
		// text editor) — exactly the state Cursor's weight resolution covers.
		assert.strictEqual(toggleKb.when!.evaluate(promptBarFocused), true, 'toggle fires with prompt bar focused');
		assert.strictEqual(pickerKb.when!.evaluate(promptBarFocused), true, 'picker when also holds — weight decides');

		// Terminal focus gates the picker off (binary: !terminalFocusInAny).
		const inTerminal = context({ editorTextFocus: false, terminalFocusInAny: true });
		assert.strictEqual(pickerKb.when!.evaluate(inTerminal), false, 'picker gated off in terminal');

		// Editor text focus gates the picker off (binary: !editorTextFocus).
		const inEditor = context({ editorTextFocus: true, terminalFocusInAny: false });
		assert.strictEqual(pickerKb.when!.evaluate(inEditor), false, 'picker gated off in a text editor');

		// No prompt bar: the toggle stays silent.
		const noBar = context({
			[ComposerContextKeys.editorHasPromptBar.key]: false,
			[ComposerContextKeys.editorPromptBarFocused.key]: false,
			editorTextFocus: false,
			terminalFocusInAny: false,
		});
		assert.strictEqual(toggleKb.when!.evaluate(noBar), false, 'toggle silent without a prompt bar');
		assert.strictEqual(pickerKb.when!.evaluate(noBar), true, 'picker fires with no prompt bar and no focus traps');
	});

	test('cycleModelParameter Slash chords untouched (no new collision)', () => {
		const cycle = new ComposerCycleModelParameterAction();
		const kb = kbOf(cycle);
		// Binary @45366468: primary:0, mac CtrlCmd+Shift+/, win CtrlCmd+Alt+/,
		// linux CtrlCmd+Shift+/, weight yk+1=251, f1 false.
		assert.strictEqual(kb.primary, 0, 'no generic Ctrl+/ primary');
		const mac = (cycle.desc.keybinding as { mac?: { primary?: number } }).mac;
		const win = (cycle.desc.keybinding as { win?: { primary?: number } }).win;
		assert.strictEqual(mac?.primary, KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Slash);
		assert.strictEqual(win?.primary, KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.Slash);
		assert.strictEqual(kb.weight, 251);
		assert.strictEqual(cycle.desc.f1, false);
		// NOTE: the win chord (CtrlCmd+Alt+/) intentionally equals the toggle's
		// secondary — that overlap is binary-verbatim (both ship in Cursor
		// 3.25.9) and resolves by weight 251 > 200. Do NOT "fix" it by
		// inventing a new chord.
	});
});
