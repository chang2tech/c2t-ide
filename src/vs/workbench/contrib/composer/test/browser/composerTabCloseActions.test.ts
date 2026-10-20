/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { MenuId, MenuRegistry, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { IMenuItem } from '../../../../../platform/actions/common/actions.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import {
	ComposerClearComposerTabsAction,
	ComposerCloseOtherComposerTabsAction,
	registerComposerMenus,
} from '../../browser/composerActions.js';

// DEV-GAPS-73 (`chat-tab-close-actions`): Cursor parity —
//   composer.clearComposerTabs title 'Close All Tabs', f1:!0 (= true),
//   menu ViewTitle group '0_chatManage' order 3;
//   composer.closeOtherComposerTabs title 'Close Other Tabs', f1:!0
//   (= true), ViewTitle menu order 2.
//   (glass bundle @39825552/@39862165, Cursor 3.25.9; `!0` is `true`
//   in minified JS — QA GAPS-79C correction of the original 3.25.6
//   static-grep reading, which had mapped Close Other to f1:false.)
// (matrix quote, static grep + title recovery; remeasure 2026-10-20
// MISSING — grep closeAllTabs/closeOtherTabs in the fork = 0 hits.)
//
// The run-behavior (bulk close with per-tab refusal) lives in the
// ide-agent extension's ChatTabService and is covered by node tests in
// extensions/ide-agent (run-chat-tab-close-actions-tests). This suite
// covers the CORE surface: verbatim ids/titles, f1 flags, the
// `composer.*` → `ide.*` delegate wiring and the ViewTitle
// '0_chatManage' menu wiring.
//
// The test env does not boot the workbench, so the actions are
// registered explicitly (registerAction2) rather than via the
// contribution.

registerAction2(ComposerClearComposerTabsAction);
registerAction2(ComposerCloseOtherComposerTabsAction);

function menuTitle(item: IMenuItem): string {
	const t = item.command.title;
	return typeof t === 'string' ? t : t.value;
}

suite('Composer tab-close actions (DEV-GAPS-73)', () => {

	test('ids are verbatim', () => {
		assert.strictEqual(ComposerClearComposerTabsAction.ID, 'composer.clearComposerTabs');
		assert.strictEqual(ComposerCloseOtherComposerTabsAction.ID, 'composer.closeOtherComposerTabs');
	});

	test('descriptors carry the verbatim titles and f1 flags', () => {
		const clearDesc = new ComposerClearComposerTabsAction().desc;
		assert.strictEqual(clearDesc.title.value, 'Close All Tabs');
		assert.strictEqual(clearDesc.f1, true);

		const otherDesc = new ComposerCloseOtherComposerTabsAction().desc;
		assert.strictEqual(otherDesc.title.value, 'Close Other Tabs');
		assert.strictEqual(otherDesc.f1, true);
	});

	test('palette: both Close All Tabs and Close Other Tabs visible (f1:!0 = true)', () => {
		const paletteIds = MenuRegistry.getMenuItems(MenuId.CommandPalette)
			.filter((i): i is IMenuItem => 'command' in i)
			.map(i => i.command.id);
		assert.ok(paletteIds.includes('composer.clearComposerTabs'), 'Close All Tabs must be palette-visible');
		assert.ok(paletteIds.includes('composer.closeOtherComposerTabs'), 'Close Other Tabs must be palette-visible (f1:!0)');
	});

	test('run() delegates to the extension runtime (ide.*)', async () => {
		const executed: string[] = [];
		const accessor = {
			get: (id: unknown) => {
				assert.strictEqual(id, ICommandService);
				return { executeCommand: async (cid: string) => { executed.push(cid); } };
			}
		} as unknown as ServicesAccessor;

		await new ComposerClearComposerTabsAction().run(accessor);
		await new ComposerCloseOtherComposerTabsAction().run(accessor);
		assert.deepStrictEqual(executed, ['ide.closeAllChatTabs', 'ide.closeOtherChatTabs']);
	});

	test('ViewTitle menu contains both in group 0_chatManage (binary-verbatim)', () => {
		registerComposerMenus();
		const items = MenuRegistry.getMenuItems(MenuId.ViewTitle)
			.filter((i): i is IMenuItem => 'command' in i)
			.filter(i => i.group === '0_chatManage');

		const ids = items.map(i => i.command.id);
		assert.ok(ids.includes('composer.clearComposerTabs'), `expected composer.clearComposerTabs in 0_chatManage, got [${ids.join(', ')}]`);
		assert.ok(ids.includes('composer.closeOtherComposerTabs'), `expected composer.closeOtherComposerTabs in 0_chatManage, got [${ids.join(', ')}]`);

		const clearItem = items.find(i => i.command.id === 'composer.clearComposerTabs')!;
		assert.strictEqual(menuTitle(clearItem), 'Close All Tabs');
		assert.strictEqual(clearItem.order, 3, 'Close All Tabs menu order must be 3 (binary @39825552)');
		const otherItem = items.find(i => i.command.id === 'composer.closeOtherComposerTabs')!;
		assert.strictEqual(menuTitle(otherItem), 'Close Other Tabs');
		assert.strictEqual(otherItem.order, 2, 'Close Other Tabs menu order must be 2 (binary @39862165)');

		// CommandsRegistry gets both handlers regardless of f1.
		assert.ok(CommandsRegistry.getCommand('composer.clearComposerTabs'));
		assert.ok(CommandsRegistry.getCommand('composer.closeOtherComposerTabs'));
	});
});
