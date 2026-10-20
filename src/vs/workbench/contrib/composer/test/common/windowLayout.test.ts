/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * DEV-GAPS-83 — `settings-window-layout` pure-logic tests.
 *
 * Expectations pinned to self-verified Cursor 3.25.9 binary evidence
 * (workbench.glass.main.js):
 * - settings entry label/description/searchAliases @byte ~28560353
 * - segmented options Agent/Editor (layout-picker.react.js) @byte ~28557762
 * - presets `defaultLayoutPresets.js` @byte ~24309085 (VERBATIM states)
 * - derived value `getSideBarPosition() === 0 ? "editor" : "agent"`
 * - storage key `cursor/agentLayout.quickMenu.lastSelectedLayoutId`
 * - apply order + visibility-diff guards of `h20` @byte ~24324237
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
	LAST_SELECTED_LAYOUT_STORAGE_KEY,
	WINDOW_LAYOUT_DESCRIPTION,
	WINDOW_LAYOUT_LABEL,
	WINDOW_LAYOUT_PRESETS,
	WINDOW_LAYOUT_SEARCH_ALIASES,
	planWindowLayoutOperations,
	windowLayoutFromSideBarPosition,
	windowLayoutPreset,
} from '../../common/windowLayout.js';

describe('windowLayout (DEV-GAPS-83, Cursor 3.25.9 parity)', () => {
	it('verbatim settings entry strings', () => {
		assert.equal(WINDOW_LAYOUT_LABEL, 'Window Layout');
		assert.equal(WINDOW_LAYOUT_DESCRIPTION, 'Switch between Agent and Editor default layouts');
		assert.deepEqual([...WINDOW_LAYOUT_SEARCH_ALIASES], ['layout', 'agent', 'editor', 'window layout']);
		assert.equal(LAST_SELECTED_LAYOUT_STORAGE_KEY, 'cursor/agentLayout.quickMenu.lastSelectedLayoutId');
	});

	it('verbatim preset states from defaultLayoutPresets.js', () => {
		assert.deepEqual(windowLayoutPreset('agent').state, {
			agentsVisible: true,
			chatVisible: true,
			editorsVisible: true,
			panelVisible: false,
			sidebarVisible: false,
			sidebarLocation: 'left',
			panelMaximized: false
		});
		assert.deepEqual(windowLayoutPreset('editor').state, {
			agentsVisible: false,
			chatVisible: true,
			editorsVisible: true,
			panelVisible: false,
			sidebarVisible: true,
			sidebarLocation: 'right',
			panelMaximized: false
		});
		assert.equal(windowLayoutPreset('agent').id, 'default-agent');
		assert.equal(windowLayoutPreset('editor').id, 'default-editor');
		assert.equal(WINDOW_LAYOUT_PRESETS.length, 2);
	});

	it('derived value: sidebar position LEFT (0) is editor, RIGHT (1) is agent', () => {
		assert.equal(windowLayoutFromSideBarPosition(0), 'editor');
		assert.equal(windowLayoutFromSideBarPosition(1), 'agent');
	});

	it('applying Agent layout from a default editor layout only hides the sidebar and moves it left', () => {
		const ops = planWindowLayoutOperations(windowLayoutPreset('agent').state, {
			sidebarVisible: true,
			chatVisible: true,
			editorsVisible: true,
			panelVisible: false,
			sidebarLocation: 'left'
		});
		assert.deepEqual(ops, [
			{ kind: 'sidebar', visible: false },
			{ kind: 'sidebarLocation', location: 'left' }
		]);
	});

	it('applying Editor layout shows the sidebar and moves it right; chat/panel/editors already match', () => {
		const ops = planWindowLayoutOperations(windowLayoutPreset('editor').state, {
			sidebarVisible: false,
			chatVisible: true,
			editorsVisible: true,
			panelVisible: false,
			sidebarLocation: 'left'
		});
		assert.deepEqual(ops, [
			{ kind: 'sidebar', visible: true },
			{ kind: 'sidebarLocation', location: 'right' }
		]);
	});

	it('mismatched chat/panel produce toggle ops in binary h20 order (chat, editors, panel, sidebar, location)', () => {
		const ops = planWindowLayoutOperations(windowLayoutPreset('editor').state, {
			sidebarVisible: false,
			chatVisible: false,
			editorsVisible: false,
			panelVisible: true,
			sidebarLocation: 'right'
		});
		assert.deepEqual(ops, [
			{ kind: 'chat', visible: true },
			{ kind: 'editors', visible: true },
			{ kind: 'panel', visible: false },
			{ kind: 'sidebar', visible: true },
			{ kind: 'sidebarLocation', location: 'right' }
		]);
	});
});
