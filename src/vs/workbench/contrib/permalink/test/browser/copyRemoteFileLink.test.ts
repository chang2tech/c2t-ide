/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';

import { IMenuItem, MenuId } from '../../../../../platform/actions/common/actions.js';
import { ILocalizedString } from '../../../../../nls.js';
import { GlassRemoteFileLinkAvailable } from '../../common/permalink.js';
import { CopyRemoteFileLinkAction } from '../../browser/permalink.contribution.js';

/**
 * Registration assertions for `glass.editor.action.copyRemoteFileLink`
 * ("Copy Remote URL").
 *
 * Binary evidence (Cursor 3.25.9, out/vs/workbench/workbench.glass.main.js
 * @45568527): `{id:"glass.editor.action.copyRemoteFileLink",
 * title:xt("glassCopyRemoteFileLink","Copy Remote URL"),
 * precondition:and(isGlassFileTabEditor,glassRemoteFileLinkAvailable), f1:!0,
 * menu:[{id:EditorContextShare,group:"0_cursor",order:1,when:pre},
 *        {id:EditorLineNumberContext,group:"1_cutcopypaste",order:4,when:pre}]}`.
 *
 * Fork adaptation (documented in permalink.contribution.ts): the
 * `isGlassFileTabEditor` term is dropped because this fork has no glass
 * file-tab editor UI (the key could never be true here), so the effective
 * precondition — and the menu `when` clauses — is
 * `glassRemoteFileLinkAvailable` alone.
 */
suite('CopyRemoteFileLinkAction registration', () => {

	function createAction(): CopyRemoteFileLinkAction {
		return new CopyRemoteFileLinkAction();
	}

	function menuItems(action: CopyRemoteFileLinkAction): ({ id: MenuId; precondition?: null } & Omit<IMenuItem, 'command'>)[] {
		const menu = action.desc.menu;
		if (!menu) {
			return [];
		}
		return Array.isArray(menu) ? menu : [menu];
	}

	test('command id matches Cursor', () => {
		assert.strictEqual(createAction().desc.id, 'glass.editor.action.copyRemoteFileLink');
		assert.strictEqual(CopyRemoteFileLinkAction.ID, 'glass.editor.action.copyRemoteFileLink');
	});

	test('title is verbatim "Copy Remote URL"', () => {
		const title = createAction().desc.title as ILocalizedString;
		assert.strictEqual(title.value, 'Copy Remote URL');
		assert.strictEqual(title.original, 'Copy Remote URL');
	});

	test('command is visible in the command palette (Cursor: f1:!0)', () => {
		assert.strictEqual(createAction().desc.f1, true);
	});

	test('precondition gate is glassRemoteFileLinkAvailable', () => {
		assert.strictEqual(createAction().desc.precondition, GlassRemoteFileLinkAvailable);
	});

	test('menu: EditorContextShare group 0_cursor order 1', () => {
		const item = menuItems(createAction()).find(entry => entry.id === MenuId.EditorContextShare);
		if (!item) {
			throw new Error('expected an EditorContextShare menu entry');
		}
		assert.strictEqual(item.group, '0_cursor');
		assert.strictEqual(item.order, 1);
		assert.strictEqual(item.when, GlassRemoteFileLinkAvailable);
	});

	test('menu: EditorLineNumberContext group 1_cutcopypaste order 4', () => {
		const item = menuItems(createAction()).find(entry => entry.id === MenuId.EditorLineNumberContext);
		if (!item) {
			throw new Error('expected an EditorLineNumberContext menu entry');
		}
		assert.strictEqual(item.group, '1_cutcopypaste');
		assert.strictEqual(item.order, 4);
		assert.strictEqual(item.when, GlassRemoteFileLinkAvailable);
	});

	test('no other menu entries', () => {
		assert.strictEqual(menuItems(createAction()).length, 2);
	});
});
