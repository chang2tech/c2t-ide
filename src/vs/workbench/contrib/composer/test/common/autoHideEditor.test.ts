/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * DEV-GAPS-103 — `settings-autohide-editor` pure-logic tests.
 *
 * Expectations pinned to self-verified Cursor 3.25.9 binary evidence
 * (workbench.desktop.main.js):
 * - storage descriptor `autoHideEditorWhenEmpty:Jh(!1,-1,0)` @14325017
 *   (boolean, default false, scope -1 APPLICATION, target 0 USER)
 * - storage key `"cursor/" + name` (`uGt` @14321085)
 * - settings registry `hl("general","auto-hide-editor",{label:
 *   "Auto-Hide Editor When Empty",surface:"ide"})` @37325620
 * - settings control @37533928: description "When all editors are closed,
 *   hide the editor area and maximize chat", searchAliases
 *   ["editor","hide","empty","maximize chat"]
 * - layout guard @38454971: hide only when pref on, not toggling
 *   maximization, panel hidden, auxiliary bar visible, editor visible,
 *   and no main editor group has editors.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
	AUTO_HIDE_EDITOR_CONFIG_KEY,
	AUTO_HIDE_EDITOR_DEFAULT,
	AUTO_HIDE_EDITOR_DESCRIPTION,
	AUTO_HIDE_EDITOR_LABEL,
	AUTO_HIDE_EDITOR_SEARCH_ALIASES,
	AUTO_HIDE_EDITOR_STORAGE_KEY,
	IAutoHideEditorLayoutState,
	shouldAutoHideEditor,
	shouldRestoreAutoHiddenEditor,
} from '../../common/autoHideEditor.js';

const baseState: IAutoHideEditorLayoutState = {
	autoHideEditorWhenEmpty: true,
	panelVisible: false,
	auxiliaryBarVisible: true,
	editorVisible: true,
	anyMainEditorGroupHasEditors: false,
	togglingMaximization: false,
};

describe('autoHideEditor (DEV-GAPS-103, Cursor 3.25.9 parity)', () => {
	it('verbatim settings entry strings and storage facts', () => {
		assert.equal(AUTO_HIDE_EDITOR_LABEL, 'Auto-Hide Editor When Empty');
		assert.equal(AUTO_HIDE_EDITOR_DESCRIPTION, 'When all editors are closed, hide the editor area and maximize chat');
		assert.deepEqual([...AUTO_HIDE_EDITOR_SEARCH_ALIASES], ['editor', 'hide', 'empty', 'maximize chat']);
		assert.equal(AUTO_HIDE_EDITOR_STORAGE_KEY, 'cursor/autoHideEditorWhenEmpty');
		assert.equal(AUTO_HIDE_EDITOR_DEFAULT, false);
		assert.equal(AUTO_HIDE_EDITOR_CONFIG_KEY, 'ide.window.autoHideEditorWhenEmpty');
	});

	it('hides when every binary guard condition holds', () => {
		assert.equal(shouldAutoHideEditor(baseState), true);
	});

	it('does not hide when the preference is off (binary default)', () => {
		assert.equal(shouldAutoHideEditor({ ...baseState, autoHideEditorWhenEmpty: false }), false);
	});

	it('does not hide while the panel is visible', () => {
		assert.equal(shouldAutoHideEditor({ ...baseState, panelVisible: true }), false);
	});

	it('does not hide when the auxiliary bar (chat) is hidden', () => {
		assert.equal(shouldAutoHideEditor({ ...baseState, auxiliaryBarVisible: false }), false);
	});

	it('does not hide when the editor part is already hidden', () => {
		assert.equal(shouldAutoHideEditor({ ...baseState, editorVisible: false }), false);
	});

	it('does not hide while any main editor group still has editors', () => {
		assert.equal(shouldAutoHideEditor({ ...baseState, anyMainEditorGroupHasEditors: true }), false);
	});

	it('does not hide while a maximization toggle is in flight', () => {
		assert.equal(shouldAutoHideEditor({ ...baseState, togglingMaximization: true }), false);
	});

	it('restores only a self-hidden editor part once editors exist again', () => {
		assert.equal(shouldRestoreAutoHiddenEditor({ hiddenByAutoHide: true, editorVisible: false, anyMainEditorGroupHasEditors: true }), true);
		assert.equal(shouldRestoreAutoHiddenEditor({ hiddenByAutoHide: false, editorVisible: false, anyMainEditorGroupHasEditors: true }), false);
		assert.equal(shouldRestoreAutoHiddenEditor({ hiddenByAutoHide: true, editorVisible: true, anyMainEditorGroupHasEditors: true }), false);
		assert.equal(shouldRestoreAutoHiddenEditor({ hiddenByAutoHide: true, editorVisible: false, anyMainEditorGroupHasEditors: false }), false);
	});
});
