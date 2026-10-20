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
import { BrowserViewCommandId } from '../../../../../../platform/browserView/common/browserView.js';
import {
	BrowserActionGroup,
} from '../../../electron-browser/browserEditor.js';
import {
	CONTEXT_BROWSER_CONSOLE_OPEN,
	ToggleBrowserConsoleAction,
} from '../../../electron-browser/features/browserConsoleFeature.js';

// DEV-GAPS-73 (`browser-tab-console-toggle`): Cursor 3.25.9 parity —
// toolbar 'Show Console' ⇄ 'Hide Console' (codicon-terminal), toggled
// class `blue active` when open (live CDP + binary,
// detail-browser-2026-10-19.md:41; dig-browser-menu-2026-10-19.md:31).
//
// Fork mapping: the button lives in the native tab's BrowserActionsToolbar
// (tools group) with the Action2 `toggled` descriptor swapping the tooltip
// verbatim; the shared workbench toolbar's `highlightToggledItems` supplies
// the toggled affordance (same as every other fork browser toggle — the
// literal `blue active` class is Cursor's React chrome).

suite('Browser console toggle (DEV-GAPS-73)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('command id is the fork-namespaced verbatim form', () => {
		assert.strictEqual(BrowserViewCommandId.ToggleConsole, 'workbench.action.browser.toggleConsole');
	});

	test('action descriptor carries verbatim title/tooltip, terminal icon, f1:true', () => {
		const action = new ToggleBrowserConsoleAction();
		assert.strictEqual(ToggleBrowserConsoleAction.ID, BrowserViewCommandId.ToggleConsole);
		assert.strictEqual(action.desc.title.value, 'Show Console');
		assert.strictEqual(action.desc.tooltip, 'Show Console');
		assert.strictEqual(action.desc.icon, Codicon.terminal);
		assert.strictEqual(action.desc.f1, true);

		// The toggled descriptor swaps the tooltip verbatim ('Show Console'
		// ⇄ 'Hide Console' — the exact strings in the REA evidence).
		const toggled = action.desc.toggled as { condition: ContextKeyExpression; title: string; tooltip: string };
		assert.ok(toggled, 'expected a toggled descriptor');
		assert.strictEqual(toggled.title, 'Hide Console');
		assert.strictEqual(toggled.tooltip, 'Hide Console');

		// The toggled condition is exactly the browserConsoleOpen key.
		const fakeContext = (open: boolean): IContext => ({
			getValue: (key: string) => (key === 'browserConsoleOpen' ? open : undefined),
		});
		assert.strictEqual(toggled.condition.evaluate(fakeContext(true)), true);
		assert.strictEqual(toggled.condition.evaluate(fakeContext(false)), false);
	});

	test('context key id matches the evidence-layer name', () => {
		assert.strictEqual(CONTEXT_BROWSER_CONSOLE_OPEN.key, 'browserConsoleOpen');
	});

	test('toolbar menu entry is in the tools group (Cursor: sibling of the picker)', () => {
		const entry = MenuRegistry.getMenuItems(MenuId.BrowserActionsToolbar)
			.filter((i): i is IMenuItem => 'command' in i)
			.find(i => i.command.id === ToggleBrowserConsoleAction.ID);
		assert.ok(entry, 'the toggle must be in the native browser actions toolbar');
		assert.strictEqual(entry!.group, BrowserActionGroup.Tools);
	});
});
