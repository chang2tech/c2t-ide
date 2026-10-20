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
import { TerminalContextKeys } from '../../../terminal/common/terminalContextKey.js';
import { COMPOSER_CHAT_VIEW_ID } from '../../browser/composerView.js';
import { ComposerCycleModeAction, ComposerOpenModeMenuAction } from '../../browser/composerActions.js';

function context(values: Record<string, ContextKeyValue>): IContext {
	return { getValue: <T extends ContextKeyValue>(key: string) => values[key] as T | undefined };
}

// Binary-verbatim when: (composerFocused || focusedView=~/^workbench.panel.aichat.view/
// || activeEditor==chatEditor || chatModeMenuFocused) && !editorTextFocus && !focusInAny.
//
// Fork port (documented in composerActions.ts):
// - composerFocused ≈ chatSurface (focusedView == 'composer.chat' ||
//   resourceScheme == 'ide-chat') || composer.chatInputFocused (bridged)
// - focusedView=~/^workbench.panel.aichat.view/ ≈ focusedView == 'composer.chat'
// - activeEditor==chatEditor ≈ resourceScheme == 'ide-chat'
// - chatModeMenuFocused: no fork equivalent (menu is a quickpick opened by this command)
// - focusInAny: NOT Cursor-only — the binary's `is.*` namespace is the terminal
//   context keys (`focusInAny=new pn("terminalFocusInAny",...)`), so the binary's
//   `!focusInAny` is `!terminalFocusInAny`, ported verbatim as
//   TerminalContextKeys.focusInAny.negate().
function modeMenuContext(values: Record<string, ContextKeyValue>): IContext {
	return context({ editorTextFocus: false, ...values });
}

suite('Composer open-mode-menu action (Cursor 3.25.9 parity)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('registration: id, title, keybinding, and f1:!1 (binary)', () => {
		const action = new ComposerOpenModeMenuAction();
		assert.strictEqual(action.desc.id, ComposerOpenModeMenuAction.ID);
		assert.strictEqual(action.desc.id, 'composer.openModeMenu');
		// Binary-verbatim title (workbench.glass.main.js 3.25.6 + 3.25.9,
		// class GAb: title:{value:"Open chat mode menu",...}); the core
		// action carries the Cursor title even though the extension bridge
		// command `ide.openModeMenu` is titled "Open Mode Menu".
		assert.strictEqual(action.desc.title.value, 'Open chat mode menu');
		// Binary f1:!1 — hidden from the command palette, like Cursor.
		assert.strictEqual(action.desc.f1, false);

		const kb = Array.isArray(action.desc.keybinding) ? action.desc.keybinding[0] : action.desc.keybinding;
		assert.ok(kb, 'keybinding is registered (was UNBOUND before the open-mode-menu fix)');
		assert.ok(kb.when, 'keybinding when is defined');
	});

	test('binary chord and weight 600', () => {
		const action = new ComposerOpenModeMenuAction();
		const kb = Array.isArray(action.desc.keybinding) ? action.desc.keybinding[0] : action.desc.keybinding;

		// binary: primary:dt.CtrlCmd|Xe.Period
		assert.strictEqual(kb?.primary, KeyMod.CtrlCmd | KeyCode.Period);
		// binary: secondary:[dt.CtrlCmd|dt.Alt|Xe.Period, dt.Shift|Xe.Tab]
		assert.deepStrictEqual(kb?.secondary, [
			KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.Period,
			KeyMod.Shift | KeyCode.Tab,
		]);
		// binary: weight:600 — above the KeybindingWeight enum (max 400), cast to the raw value
		assert.strictEqual(kb?.weight, 600);
	});

	test('when fires on the chat surface, blocked in text editors', () => {
		const action = new ComposerOpenModeMenuAction();
		const kb = Array.isArray(action.desc.keybinding) ? action.desc.keybinding[0] : action.desc.keybinding;
		assert.ok(kb?.when);

		// chat sidebar view focused ≈ focusedView=~/^workbench.panel.aichat.view/
		assert.strictEqual(
			kb.when!.evaluate(modeMenuContext({ focusedView: COMPOSER_CHAT_VIEW_ID })), true,
			'fires when the chat view is focused'
		);
		// chat editor tab active ≈ activeEditor==chatEditor
		assert.strictEqual(
			kb.when!.evaluate(modeMenuContext({ resourceScheme: 'ide-chat' })), true,
			'fires when a chat editor tab is active'
		);
		// bridged webview input focus ≈ composerFocused
		assert.strictEqual(
			kb.when!.evaluate(modeMenuContext({ [ComposerContextKeys.chatInputFocused.key]: true })), true,
			'fires when the chat input is focused'
		);
		// !editorTextFocus (binary)
		assert.strictEqual(
			kb.when!.evaluate(context({ editorTextFocus: true, focusedView: COMPOSER_CHAT_VIEW_ID })), false,
			'blocked while typing in a text editor'
		);
		// !terminalFocusInAny (binary `is.focusInAny.negate()` — the binary's
		// `is.*` namespace is the terminal context keys)
		assert.strictEqual(
			kb.when!.evaluate(modeMenuContext({ focusedView: COMPOSER_CHAT_VIEW_ID, terminalFocusInAny: true })), false,
			'blocked while any terminal is focused'
		);
		// no chat context at all (e.g. plain editor, terminal)
		assert.strictEqual(
			kb.when!.evaluate(modeMenuContext({})), false,
			'blocked outside chat contexts — Ctrl+. is left for other bindings there'
		);
	});

	test('Shift+Tab resolution vs cycleMode is weight/when, cycleMode not broken', () => {
		const modeMenu = new ComposerOpenModeMenuAction();
		const cycleMode = new ComposerCycleModeAction();
		const modeMenuKb = Array.isArray(modeMenu.desc.keybinding) ? modeMenu.desc.keybinding[0] : modeMenu.desc.keybinding;
		const cycleModeKb = Array.isArray(cycleMode.desc.keybinding) ? cycleMode.desc.keybinding[0] : cycleMode.desc.keybinding;

		// Both register Shift+Tab (binary resolves the shared chord by weight/when).
		assert.ok(modeMenuKb?.secondary?.includes(KeyMod.Shift | KeyCode.Tab), 'mode menu has the Shift+Tab secondary');
		assert.strictEqual(cycleModeKb?.primary, KeyMod.Shift | KeyCode.Tab, 'cycleMode keeps its Shift+Tab primary');

		// Weight decides when both when-clauses hold (chat surface, not in a text
		// input, no terminal focused): the mode menu wins — Cursor's own
		// resolution mechanism (Cursor's Cycle Mode @45451043 carries no
		// binding, so the binary has no conflict there; the fork's
		// cycleMode Shift+Tab is shadowed wherever both clauses hold).
		assert.ok((modeMenuKb?.weight ?? 0) > (cycleModeKb?.weight ?? 0),
			'mode menu (600) outranks cycleMode — mirrors Cursor\'s resolution');
		assert.strictEqual(modeMenuKb?.weight, 600);
		assert.strictEqual(cycleModeKb?.weight, KeybindingWeight.WorkbenchContrib);

		// Where the mode menu's when-clause does NOT hold (e.g. a terminal
		// focused), cycleMode's Shift+Tab still fires — the when-clause side
		// of the resolution.
		const inTerminal = modeMenuContext({
			[ComposerContextKeys.chatInputFocused.key]: true,
			terminalFocusInAny: true,
		});
		assert.strictEqual(cycleModeKb!.when!.evaluate(inTerminal), true,
			'cycleMode when still holds where the mode menu is gated off');
		assert.strictEqual(modeMenuKb!.when!.evaluate(inTerminal), false,
			'mode menu when is gated off while a terminal is focused');
	});
});
