/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * GAPS-142 — `settings-terminal-hint` pure-logic tests.
 *
 * Expectations pinned to self-verified Cursor 3.25.9 binary evidence
 * (workbench.desktop.main.js; full slices in
 * docs/rea/work-notes-gaps142.md):
 * - registry @37340021: `hl("chat","terminal-hint",{label:"Terminal Hint",
 *   surface:"ide",description:"Show the Cmd/Ctrl+K hint in Terminal"})`
 * - settings selector @37443354: `hideTerminalTooltip===!1` (only the exact
 *   value `false` enables the toggle/hint; unset is OFF)
 * - consumer guard @36726703: hint hidden when the prompt bar is visible,
 *   when `hideTerminalTooltip !== false`, or when
 *   `shellLaunchConfig.hideFromUser`; hidden when no keybinding resolves
 *   for `cursorai.action.generateInTerminal` (@484110)
 * - hint text @36728545: `` `${keybinding.getLabel()} to generate command` ``
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
	GENERATE_IN_TERMINAL_COMMAND_ID,
	TERMINAL_PROMPT_BAR_HINT_HEIGHT,
	TerminalPromptBarHintSettingId,
	isTerminalHintEnabledFromCursorStorage,
	shouldShowTerminalPromptBarHint,
	terminalPromptBarHintText,
	type TerminalPromptBarHintState,
} from '../../common/terminalPromptBarHint.js';

const baseState: TerminalPromptBarHintState = {
	settingEnabled: true,
	promptBarVisible: false,
	hideFromUser: false,
	keybindingLabel: 'Ctrl+K',
};

describe('terminalPromptBarHint (GAPS-142, Cursor 3.25.9 parity)', () => {
	it('fork setting id + advertised command id + height', () => {
		assert.equal(TerminalPromptBarHintSettingId.ShowCmdkHint, 'ide.terminal.showCmdkHint');
		assert.equal(GENERATE_IN_TERMINAL_COMMAND_ID, 'cursorai.action.generateInTerminal');
		assert.equal(TERMINAL_PROMPT_BAR_HINT_HEIGHT, 20);
	});

	it('Cursor storage selector: only exact `false` enables the hint', () => {
		assert.equal(isTerminalHintEnabledFromCursorStorage(false), true);
		assert.equal(isTerminalHintEnabledFromCursorStorage(true), false);
		// Never touched by the user: storage is undefined → toggle OFF, hint hidden.
		assert.equal(isTerminalHintEnabledFromCursorStorage(undefined), false);
		assert.equal(isTerminalHintEnabledFromCursorStorage(null), false);
		assert.equal(isTerminalHintEnabledFromCursorStorage(0), false);
		assert.equal(isTerminalHintEnabledFromCursorStorage('false'), false);
	});

	it('hint text is the verbatim `${label} to generate command`', () => {
		assert.equal(terminalPromptBarHintText('Ctrl+K'), 'Ctrl+K to generate command');
		assert.equal(terminalPromptBarHintText('⌘K'), '⌘K to generate command');
		assert.equal(terminalPromptBarHintText(undefined), undefined);
		assert.equal(terminalPromptBarHintText(''), undefined);
	});

	it('shows only when enabled, no prompt bar, not hidden, keybinding bound', () => {
		assert.equal(shouldShowTerminalPromptBarHint(baseState), true);
	});

	it('setting off (or never enabled) hides the hint', () => {
		assert.equal(shouldShowTerminalPromptBarHint({ ...baseState, settingEnabled: false }), false);
	});

	it('prompt bar visible hides the hint (container is reused by the prompt bar)', () => {
		assert.equal(shouldShowTerminalPromptBarHint({ ...baseState, promptBarVisible: true }), false);
	});

	it('hideFromUser terminal hides the hint', () => {
		assert.equal(shouldShowTerminalPromptBarHint({ ...baseState, hideFromUser: true }), false);
	});

	it('no keybinding for generateInTerminal hides the hint', () => {
		assert.equal(shouldShowTerminalPromptBarHint({ ...baseState, keybindingLabel: undefined }), false);
		assert.equal(shouldShowTerminalPromptBarHint({ ...baseState, keybindingLabel: '' }), false);
	});
});
