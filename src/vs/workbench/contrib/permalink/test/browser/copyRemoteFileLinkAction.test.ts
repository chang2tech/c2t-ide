/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';

import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ContextKeyValue, IContext } from '../../../../../platform/contextkey/common/contextkey.js';
import { MenuId } from '../../../../../platform/actions/common/actions.js';
import { GlassRemoteFileLinkAvailable } from '../../common/permalink.js';
import { CopyRemoteFileLinkAction } from '../../browser/permalink.contribution.js';

function context(values: Record<string, ContextKeyValue>): IContext {
	return { getValue: <T extends ContextKeyValue>(key: string) => values[key] as T | undefined };
}

function menuEntry(action: CopyRemoteFileLinkAction, id: MenuId) {
	const menu = action.desc.menu;
	if (!menu) {
		throw new Error('menu is registered');
	}
	const entries = Array.isArray(menu) ? menu : [menu];
	const entry = entries.find(candidate => candidate.id === id);
	if (!entry) {
		throw new Error(`menu item for ${id.id} is registered`);
	}
	return entry;
}

function localizedTitle(action: CopyRemoteFileLinkAction) {
	const title = action.desc.title;
	if (typeof title === 'string') {
		throw new Error('title is a localized string (ICommandActionTitle)');
	}
	return title;
}

function precondition(action: CopyRemoteFileLinkAction) {
	const precondition = action.desc.precondition;
	if (!precondition) {
		throw new Error('precondition is set');
	}
	return precondition;
}

// Binary evidence (out/vs/workbench/workbench.glass.main.js, Cursor 3.25.6 and
// 3.25.9):
// {id:"glass.editor.action.copyRemoteFileLink",
//  title:xt("glassCopyRemoteFileLink","Copy Remote URL"),
//  precondition:ft.and(Lxt,MRl), f1:!0,
//  menu:[{id:Nt.EditorContextShare,group:"0_cursor",order:1,when:Jlu},
//        {id:Nt.EditorLineNumberContext,group:"1_cutcopypaste",order:4,when:Jlu}]}
// where Lxt=new pn("isGlassFileTabEditor",!1) (Cursor glass-editor scope — no
// fork equivalent, so the effective gate is MRl) and
// MRl=new pn("glassRemoteFileLinkAvailable",!1).
suite('CopyRemoteFileLinkAction (Cursor 3.25.6/3.25.9 parity)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('registration: verbatim command id', () => {
		const action = new CopyRemoteFileLinkAction();
		assert.strictEqual(action.desc.id, CopyRemoteFileLinkAction.ID);
		assert.strictEqual(action.desc.id, 'glass.editor.action.copyRemoteFileLink');
	});

	test('registration: verbatim title "Copy Remote URL"', () => {
		const action = new CopyRemoteFileLinkAction();
		// Binary title value verbatim; the source-level localize2 key is
		// "glassCopyRemoteFileLink" (matches binary xt key).
		const title = localizedTitle(action);
		assert.strictEqual(title.value, 'Copy Remote URL');
		assert.strictEqual(title.original, 'Copy Remote URL');
	});

	test('registration: f1:!0 — visible in the command palette', () => {
		const action = new CopyRemoteFileLinkAction();
		// Binary f1:!0, i.e. f1:true — the command IS shown in the palette
		// (in addition to the editor context menus).
		assert.strictEqual(action.desc.f1, true);
	});

	test('registration: precondition is the availability key', () => {
		const action = new CopyRemoteFileLinkAction();
		const key = precondition(action);
		assert.strictEqual(key, GlassRemoteFileLinkAvailable);
		assert.strictEqual(GlassRemoteFileLinkAvailable.key, 'glassRemoteFileLinkAvailable');
		assert.strictEqual(
			key.evaluate(context({ glassRemoteFileLinkAvailable: true })), true,
			'enabled when link data is cached for at least one repo'
		);
		assert.strictEqual(
			key.evaluate(context({ glassRemoteFileLinkAvailable: false })), false,
			'disabled when no repo has link data'
		);
		assert.strictEqual(
			key.evaluate(context({})), false,
			'disabled when the key is unset'
		);
	});

	test('registration: EditorContextShare menu (group 0_cursor, order 1)', () => {
		const action = new CopyRemoteFileLinkAction();
		const share = menuEntry(action, MenuId.EditorContextShare);
		assert.strictEqual(share.group, '0_cursor');
		assert.strictEqual(share.order, 1);
		assert.strictEqual(share.when, GlassRemoteFileLinkAvailable);
	});

	test('registration: EditorLineNumberContext menu (group 1_cutcopypaste, order 4)', () => {
		const action = new CopyRemoteFileLinkAction();
		const lineNumbers = menuEntry(action, MenuId.EditorLineNumberContext);
		assert.strictEqual(lineNumbers.group, '1_cutcopypaste');
		assert.strictEqual(lineNumbers.order, 4);
		assert.strictEqual(lineNumbers.when, GlassRemoteFileLinkAvailable);
	});

	test('registration: exactly two menu entries (binary list)', () => {
		const action = new CopyRemoteFileLinkAction();
		const menu = action.desc.menu;
		if (!menu) {
			throw new Error('menu is registered');
		}
		const entries = Array.isArray(menu) ? menu : [menu];
		assert.strictEqual(entries.length, 2,
			'matches the binary menu list: EditorContextShare + EditorLineNumberContext');
	});
});
