/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { ContextKeyExpression, IContext } from '../../../../../../platform/contextkey/common/contextkey.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { MenuId, MenuRegistry } from '../../../../../../platform/actions/common/actions.js';
import { IMenuItem } from '../../../../../../platform/actions/common/actions.js';
import { BrowserElementSelectionMode } from '../../../../../../platform/browserView/common/browserView.js';
import {
	BrowserActionGroup,
} from '../../../electron-browser/browserEditor.js';
import {
	SelectElementAction,
} from '../../../electron-browser/features/browserPickerFeature.js';
import {
	CONTEXT_BROWSER_ELEMENT_SELECTION_MODE,
} from '../../../electron-browser/features/browserEditorChatFeatures.js';

// DEV-GAPS-94B (`browser-tab-picker-toggle`): Cursor 3.25.9 parity —
// toolbar 'Select element' toggle (codicon-inspect), `active` class when
// picker ON (live CDP detail-browser-2026-10-19.md:40; binary
// workbench.desktop.main.js @21191350 template, @21183867 class/icon,
// @21176331 enable/disable-element-selection handler).
//
// Fork mapping: the button lives in the native tab's
// BrowserActionsToolbar (Tools group, order 0 — before the console
// toggle at order 1, matching Cursor's `.browser-tools` DOM order) with
// the Action2 `toggled` descriptor keyed on the element-selection mode;
// the shared workbench toolbar's `highlightToggledItems` supplies the
// toggled affordance (the literal `tool-button blue active` class is
// Cursor's React chrome).

suite('Browser element picker toggle (DEV-GAPS-94B)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('command id is the fork-namespaced literal form', () => {
		assert.strictEqual(SelectElementAction.ID, 'workbench.action.browser.selectElement');
	});

	test('action descriptor carries verbatim title/tooltip and inspect icon', () => {
		const action = new SelectElementAction();
		assert.strictEqual(action.desc.title.value, 'Select element');
		assert.strictEqual(action.desc.tooltip, 'Select element');
		assert.strictEqual(action.desc.icon, Codicon.inspect);

		// Toolbar-only: Cursor evidences no command-palette entry for the
		// picker, so the action must not opt into f1.
		assert.ok(!action.desc.f1, 'picker toggle must not appear in the command palette');
	});

	test('toggled condition is exactly element-selection mode == Select', () => {
		const action = new SelectElementAction();
		const toggled = action.desc.toggled as ContextKeyExpression;
		assert.ok(toggled, 'expected a toggled condition');
		const fakeContext = (mode: BrowserElementSelectionMode | undefined): IContext => ({
			getValue: (key: string) => (key === 'browserElementSelectionMode' ? mode : undefined),
		});
		assert.strictEqual(toggled.evaluate(fakeContext(BrowserElementSelectionMode.Select)), true);
		assert.strictEqual(toggled.evaluate(fakeContext(BrowserElementSelectionMode.Comment)), false);
		assert.strictEqual(toggled.evaluate(fakeContext(undefined)), false);
		assert.strictEqual(CONTEXT_BROWSER_ELEMENT_SELECTION_MODE.key, 'browserElementSelectionMode');
	});

	test('toolbar menu entry is the first tools-group item (Cursor DOM order: picker, console, menu)', () => {
		const entry = MenuRegistry.getMenuItems(MenuId.BrowserActionsToolbar)
			.filter((i): i is IMenuItem => 'command' in i)
			.find(i => i.command.id === SelectElementAction.ID);
		assert.ok(entry, 'the toggle must be in the native browser actions toolbar');
		assert.strictEqual(entry!.group, BrowserActionGroup.Tools);
		assert.strictEqual(entry!.order, 0);
	});
});
