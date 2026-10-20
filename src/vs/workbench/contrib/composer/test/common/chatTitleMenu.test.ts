/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * WORKER-GAPS-66A (`chat-tab-title-menu-inventory`) — Cursor 3.25.9 parity
 * tests for the chat editor tab title menu.
 *
 * Tests the REAL pure module `common/chatTitleMenu.ts` (inventory +
 * resolvers) under node:test with the repo's TS loader (no build needed),
 * plus STATIC wiring assertions on `browser/composerActions.ts` proving the
 * Action2 descriptors + `registerComposerMenus()` consume the inventory
 * verbatim.
 *
 * Binary grounding (all real, static extraction, verified verbatim):
 *  - workbench.desktop.main.js @29968468: `var Opa=[...]`
 *  - workbench.glass.main.js @39879475: `var BGc=[...]` (identical)
 *  - const aliases: composer.exportChatAsMd (@14001529), composer.shareChat
 *    (@14001559), composer.copyRequestIdFromEditor (@14001680),
 *    composer.duplicateChat (@14003077), composer.renameChat (@14003106),
 *    composer.openPromptQuality (@29785997), developer.exportChat
 *    (@14004704), workbench.action.moveEditorToNewWindow (@21485753),
 *    composer.reportFeedback (@29935607), chat.openCursorSettings (@29958167)
 *  - context keys: isSharedChatsEnabled (@24040852),
 *    composerEditorTabCanRename (@16723081), composerEditorTabIsCloudAgent
 *    (@16723034), isDevelopment (@2631047)
 *  - class l2S @29931829: `t?.scheme===ft.composer?{kind:"composerId",composerId:t.path}:{kind:"editor"}`
 *  - class a2S @29931829: `n.writeText(o??"No request ID found")`
 *
 * Run: node --loader ~/workspace/w66a-tests/ts-loader.mjs --test chatTitleMenu.test.ts
 * (the loader maps `.js` import specifiers to the real `.ts` sources).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	CHAT_TAB_TITLE_MENU_ITEMS,
	NO_REQUEST_ID_FALLBACK,
	resolveCopyRequestIdFromEditorTarget,
	resolveCopyRequestIdTabId,
	resolveCopyRequestIdTarget,
} from '../../common/chatTitleMenu.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const COMMON_DIR = resolve(HERE, '..', '..', 'common');
const BROWSER_DIR = resolve(HERE, '..', '..', 'browser');
const composerActionsSource = readFileSync(resolve(BROWSER_DIR, 'composerActions.ts'), 'utf8');
const composerContributionSource = readFileSync(resolve(BROWSER_DIR, 'composer.contribution.ts'), 'utf8');

// ---------------------------------------------------------------------------
// 1. Inventory — the complete binary Opa/BGc order, verbatim.
// ---------------------------------------------------------------------------

describe('chat tab title menu inventory (binary Opa/BGc parity)', () => {
	it('has exactly the 10 binary items in binary order', () => {
		const ids = CHAT_TAB_TITLE_MENU_ITEMS.map((i) => i.commandId);
		assert.deepEqual(ids, [
			'composer.exportChatAsMd',
			'composer.shareChat',
			'composer.copyRequestIdFromEditor',
			'composer.reportFeedback',
			'chat.openCursorSettings',
			'composer.openPromptQuality',
			'developer.exportChat',
			'composer.renameChat',
			'composer.duplicateChat',
			'workbench.action.moveEditorToNewWindow',
		]);
	});

	it('groups and orders are binary-verbatim', () => {
		const byId = new Map(CHAT_TAB_TITLE_MENU_ITEMS.map((i) => [i.commandId, i]));
		const expect = (id: string, group: string, order: number) => {
			const item = byId.get(id);
			assert.ok(item, `missing item ${id}`);
			assert.equal(item.group, group, `${id} group`);
			assert.equal(item.order, order, `${id} order`);
		};
		expect('composer.exportChatAsMd', '1_chatTools', 1);
		expect('composer.shareChat', '1_chatTools', 2);
		expect('composer.copyRequestIdFromEditor', '1_chatTools', 3);
		expect('composer.reportFeedback', '1_chatTools', 4);
		expect('chat.openCursorSettings', '2_moreActions', 2);
		expect('composer.openPromptQuality', '2_moreActions', 99);
		expect('developer.exportChat', '2_moreActions', 100);
		expect('composer.renameChat', '1_chatTools', 5);
		expect('composer.duplicateChat', '1_chatTools', 6);
		expect('workbench.action.moveEditorToNewWindow', '5z_new_window', 10);
	});

	it('titles are binary-verbatim', () => {
		const byId = new Map(CHAT_TAB_TITLE_MENU_ITEMS.map((i) => [i.commandId, i]));
		assert.equal(byId.get('composer.exportChatAsMd')!.title, 'Export Transcript');
		assert.equal(byId.get('composer.shareChat')!.title, 'Share Transcript');
		assert.equal(byId.get('composer.copyRequestIdFromEditor')!.title, 'Copy Request ID');
		assert.equal(byId.get('composer.reportFeedback')!.title, 'Give Feedback');
		assert.equal(byId.get('chat.openCursorSettings')!.title, 'Agent Settings');
		assert.equal(byId.get('composer.openPromptQuality')!.title, 'Open in Prompt Quality');
		assert.equal(byId.get('developer.exportChat')!.title, 'Export Chat (Developer)');
		assert.equal(byId.get('composer.renameChat')!.title, 'Rename Chat');
		assert.equal(byId.get('composer.duplicateChat')!.title, 'Fork Chat');
		assert.equal(byId.get('workbench.action.moveEditorToNewWindow')!.title, 'Move into New Window');
	});

	it('menu targets: Opa items on both EditorTitleContext and EditorTitle; the trailing trio on context only', () => {
		const byId = new Map(CHAT_TAB_TITLE_MENU_ITEMS.map((i) => [i.commandId, i]));
		for (const id of ['composer.exportChatAsMd', 'composer.shareChat', 'composer.copyRequestIdFromEditor', 'composer.reportFeedback', 'chat.openCursorSettings', 'composer.openPromptQuality', 'developer.exportChat']) {
			assert.deepEqual(byId.get(id)!.targets, ['EditorTitleContext', 'EditorTitle'], id);
		}
		for (const id of ['composer.renameChat', 'composer.duplicateChat', 'workbench.action.moveEditorToNewWindow']) {
			assert.deepEqual(byId.get(id)!.targets, ['EditorTitleContext'], id);
		}
	});

	it('menu icons: export=saveAll, share=link, rename=edit, fork=clone; others have none', () => {
		const byId = new Map(CHAT_TAB_TITLE_MENU_ITEMS.map((i) => [i.commandId, i]));
		assert.equal(byId.get('composer.exportChatAsMd')!.iconCodicon, 'saveAll');
		assert.equal(byId.get('composer.shareChat')!.iconCodicon, 'link');
		assert.equal(byId.get('composer.renameChat')!.iconCodicon, 'edit');
		assert.equal(byId.get('composer.duplicateChat')!.iconCodicon, 'clone');
		assert.equal(byId.get('composer.copyRequestIdFromEditor')!.iconCodicon, undefined);
		assert.equal(byId.get('composer.reportFeedback')!.iconCodicon, undefined);
		assert.equal(byId.get('chat.openCursorSettings')!.iconCodicon, undefined);
	});

	it('gates: share needs isSharedChatsEnabled; rename has the can-rename precondition; fork excludes cloud agents; prompt-quality is internal', () => {
		const byId = new Map(CHAT_TAB_TITLE_MENU_ITEMS.map((i) => [i.commandId, i]));
		assert.equal(byId.get('composer.shareChat')!.gate, 'schemeAndSharedChats');
		assert.equal(byId.get('composer.renameChat')!.precondition, 'composerEditorTabCanRename');
		assert.equal(byId.get('composer.renameChat')!.gate, 'preconditionOnly');
		assert.equal(byId.get('composer.duplicateChat')!.gate, 'schemeAndNotCloudAgent');
		assert.equal(byId.get('composer.openPromptQuality')!.gate, 'schemeAndInternal');
		assert.equal(byId.get('developer.exportChat')!.gate, 'schemeAndInternal');
		assert.equal(byId.get('composer.exportChatAsMd')!.gate, 'scheme');
		assert.equal(byId.get('workbench.action.moveEditorToNewWindow')!.gate, 'scheme');
	});

	it('preconditionOnly gate: rename menu item has no scheme conjunct in when (binary: no `when`)', () => {
		const byId = new Map(CHAT_TAB_TITLE_MENU_ITEMS.map((i) => [i.commandId, i]));
		assert.equal(byId.get('composer.renameChat')!.gate, 'preconditionOnly');
		assert.equal(byId.get('composer.renameChat')!.precondition, 'composerEditorTabCanRename');
		// Static wiring: 'preconditionOnly' must map to NO `when`
		// (binary: `{command:{id:aHi,...,precondition:VXi},group:"1_chatTools",order:5}`),
		// all other binary gates keep their scheme conjunct via titleMenuGateWhen.
		assert.ok(/case 'preconditionOnly':[\s\S]{0,500}?return undefined/.test(composerActionsSource), 'titleMenuGateWhen must return undefined for preconditionOnly');
		assert.ok(composerActionsSource.includes('...(when ? { when } : {})'), 'appendChatTitleMenuItem must omit `when` when the gate maps to undefined');
		assert.ok(/export type ChatTitleMenuGate =[\s\S]{0,400}?'preconditionOnly'/.test(composerActionsSource) || readFileSync(resolve(COMMON_DIR, 'chatTitleMenu.ts'), 'utf8').includes("'preconditionOnly'"), 'preconditionOnly must be in the ChatTitleMenuGate union');
	});

	it('developer.exportChat is inventoried but explicitly skipped in the fork', () => {
		const item = CHAT_TAB_TITLE_MENU_ITEMS.find((i) => i.commandId === 'developer.exportChat')!;
		assert.equal(item.includeInFork, false);
		for (const other of CHAT_TAB_TITLE_MENU_ITEMS) {
			if (other.commandId !== 'developer.exportChat') {
				assert.equal(other.includeInFork, true, other.commandId);
			}
		}
	});
});

// ---------------------------------------------------------------------------
// 2. Resolvers — binary l2S/u2S/d2S truth tables.
// ---------------------------------------------------------------------------

const OPTS = { chatScheme: 'ide-chat', tabIdFromPath: (p: string) => p.replace(/^\//, '') || undefined };

describe('resolveCopyRequestIdFromEditorTarget (binary l2S)', () => {
	it('chat-scheme URI -> {kind:composerId} with the translated tab id', () => {
		assert.deepEqual(
			resolveCopyRequestIdFromEditorTarget({ scheme: 'ide-chat', path: '/tab-9' }, OPTS),
			{ kind: 'composerId', composerId: 'tab-9' },
		);
	});
	it('chat-scheme URI with an untranslatable path keeps the path verbatim (binary `t.path`)', () => {
		const noTranslate = { chatScheme: 'ide-chat', tabIdFromPath: () => undefined };
		assert.deepEqual(
			resolveCopyRequestIdFromEditorTarget({ scheme: 'ide-chat', path: '/weird' }, noTranslate),
			{ kind: 'composerId', composerId: '/weird' },
		);
	});
	it('foreign URI -> {kind:editor}', () => {
		assert.deepEqual(
			resolveCopyRequestIdFromEditorTarget({ scheme: 'file', path: '/x.ts' }, OPTS),
			{ kind: 'editor' },
		);
	});
	it('no arg -> {kind:editor} (palette invocation)', () => {
		assert.deepEqual(resolveCopyRequestIdFromEditorTarget(undefined, OPTS), { kind: 'editor' });
	});
});

describe('resolveCopyRequestIdTarget (binary u2S)', () => {
	it('string arg -> {kind:composerId} verbatim', () => {
		assert.deepEqual(resolveCopyRequestIdTarget('tab-1', OPTS), { kind: 'composerId', composerId: 'tab-1' });
	});
	it('chat-scheme URI -> {kind:composerId}', () => {
		assert.deepEqual(
			resolveCopyRequestIdTarget({ scheme: 'ide-chat', path: '/tab-2' }, OPTS),
			{ kind: 'composerId', composerId: 'tab-2' },
		);
	});
	it('foreign URI -> undefined (falls through)', () => {
		assert.equal(resolveCopyRequestIdTarget({ scheme: 'file', path: '/x' }, OPTS), undefined);
	});
	it('{kind} structs pass through', () => {
		assert.deepEqual(resolveCopyRequestIdTarget({ kind: 'editor' }, OPTS), { kind: 'editor' });
		assert.deepEqual(resolveCopyRequestIdTarget({ kind: 'pane' }, OPTS), { kind: 'pane' });
		assert.deepEqual(
			resolveCopyRequestIdTarget({ kind: 'composerId', composerId: 'tab-3' }, OPTS),
			{ kind: 'composerId', composerId: 'tab-3' },
		);
	});
});

describe('resolveCopyRequestIdTabId (binary d2S, fork mapping)', () => {
	it('composerId kind -> the id verbatim', () => {
		assert.equal(resolveCopyRequestIdTabId({ kind: 'composerId', composerId: 'tab-7' }, 'tab-0'), 'tab-7');
	});
	it('editor/pane kinds -> the active chat tab (fork has no pane/editor split)', () => {
		assert.equal(resolveCopyRequestIdTabId({ kind: 'editor' }, 'tab-0'), 'tab-0');
		assert.equal(resolveCopyRequestIdTabId({ kind: 'pane' }, 'tab-0'), 'tab-0');
	});
	it('no active chat tab -> undefined (caller writes the binary fallback text)', () => {
		assert.equal(resolveCopyRequestIdTabId({ kind: 'editor' }, undefined), undefined);
		assert.equal(resolveCopyRequestIdTabId(undefined, 'tab-0'), undefined);
	});
	it('the clipboard fallback is the binary-verbatim string', () => {
		assert.equal(NO_REQUEST_ID_FALLBACK, 'No request ID found');
	});
});

// ---------------------------------------------------------------------------
// 3. Static wiring — composerActions.ts really consumes the inventory with
//    the verbatim descriptors Cursor registers.
// ---------------------------------------------------------------------------

describe('browser wiring (composerActions.ts consumes the inventory)', () => {
	const actionId = (className: string): string => {
		const m = composerActionsSource.match(new RegExp(`export class ${className} extends Action2 \\{[\\s\\S]{0,400}?static readonly ID = '([^']+)'`));
		assert.ok(m, `could not find ${className}.ID`);
		return m![1];
	};

	it('action ids are binary-verbatim (renamed off the fork-invented ids)', () => {
		assert.equal(actionId('ComposerGiveFeedbackAction'), 'composer.reportFeedback');
		assert.equal(actionId('ComposerOpenAgentSettingsAction'), 'chat.openCursorSettings');
		assert.equal(actionId('ComposerForkChatAction'), 'composer.duplicateChat');
		assert.equal(actionId('ComposerCopyRequestIdFromEditorAction'), 'composer.copyRequestIdFromEditor');
		assert.equal(actionId('ComposerShareChatAction'), 'composer.shareChat');
		assert.equal(actionId('ComposerOpenPromptQualityAction'), 'composer.openPromptQuality');
		assert.equal(actionId('ComposerCopyRequestIdAction'), 'composer.copyRequestId');
		assert.equal(actionId('ComposerExportChatAsMdAction'), 'composer.exportChatAsMd');
		assert.equal(actionId('ComposerRenameChatAction'), 'composer.renameChat');
	});

	it('the fork-invented ids are gone from core', () => {
		for (const dead of ['composer.giveFeedback', 'composer.openAgentSettings', 'composer.forkChat']) {
			assert.ok(!composerActionsSource.includes(`'${dead}'`), `${dead} still present`);
		}
	});

	it('duplicateChat is palette-visible like the binary (f1:!0, category Cursor)', () => {
		const m = composerActionsSource.match(/export class ComposerForkChatAction[\s\S]{0,500}?f1: (true|false)/);
		assert.ok(m);
		assert.equal(m![1], 'true');
		assert.ok(/export class ComposerForkChatAction[\s\S]{0,500}?category: CursorActionCategory/.test(composerActionsSource));
		assert.ok(/export const CursorActionCategory = localize2\('composer\.cursorCategory', 'Cursor'\)/.test(composerActionsSource), 'CursorActionCategory must localize to "Cursor" (binary Yn.Cursor)');
	});

	it('shareChat carries the isSharedChatsEnabled precondition (binary class vAb)', () => {
		assert.ok(/export class ComposerShareChatAction[\s\S]{0,500}?precondition: ComposerContextKeys\.isSharedChatsEnabled/.test(composerActionsSource));
	});

	it('copyRequestId writes the binary-verbatim fallback via the provider command', () => {
		assert.ok(composerActionsSource.includes('ide.getChatRequestId'));
		assert.ok(composerActionsSource.includes('NO_REQUEST_ID_FALLBACK'));
		assert.ok(composerActionsSource.includes('resolveCopyRequestIdTarget'));
		assert.ok(composerActionsSource.includes('resolveCopyRequestIdTabId'));
		assert.ok(composerActionsSource.includes('resolveCopyRequestIdFromEditorTarget'));
	});

	it('registerComposerMenus is data-driven from CHAT_TAB_TITLE_MENU_ITEMS', () => {
		assert.ok(composerActionsSource.includes('for (const item of CHAT_TAB_TITLE_MENU_ITEMS)'));
		assert.ok(composerActionsSource.includes('MenuId.EditorTitle'));
		assert.ok(composerActionsSource.includes('MenuId.EditorTitleContext'));
		assert.ok(composerActionsSource.includes('appendChatTitleMenuItem(item)'));
		assert.ok(composerActionsSource.includes('developer.exportChat') && composerActionsSource.includes('includeInFork'));
	});

	it('the rename precondition sits on the command descriptor (binary shape)', () => {
		assert.ok(composerActionsSource.includes(`precondition: ComposerContextKeys.chatEditorTabCanRename`));
	});

	it('contribution syncs the verbatim context keys', () => {
		for (const key of ['chatEditorTabCanRename', 'chatEditorTabIsCloudAgent', 'isSharedChatsEnabled']) {
			assert.ok(composerContributionSource.includes(key), `contribution missing ${key}`);
		}
		assert.ok(composerContributionSource.includes('syncChatTitleMenuContextKeys'));
	});

	it('fork-only extras do not collide with the binary orders 1-6', () => {
		const extras = composerActionsSource.match(/const forkExtraMenuItems[\s\S]*?\n\t\];/);
		assert.ok(extras);
		const orders = [...extras![0].matchAll(/order: (\d+)/g)].map((m) => Number(m[1]));
		assert.ok(orders.length >= 4);
		for (const order of orders) {
			assert.ok(order >= 7, `fork extra order ${order} collides with binary orders 1-6`);
		}
	});
});
