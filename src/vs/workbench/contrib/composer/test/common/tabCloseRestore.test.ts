/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import {
	COMPOSER_CHAT_EDITOR_ID,
	COMPOSER_CHANGES_EDITOR_ID,
	COMPOSER_REVIEW_CHANGES_EDITOR_ID,
	COMPOSER_CUSTOMIZE_EDITOR_ID,
	COMPOSER_CHAT_SCHEME,
	COMPOSER_CHANGES_SCHEME,
	COMPOSER_CUSTOMIZE_SCHEME,
	buildReopenUntypedInput,
	parseComposerChatTabRef,
	parseComposerChangesTabRef,
	parseComposerCustomizeTabRef,
} from '../../common/tabCloseRestore.js';
import type { ITabResourceParts } from '../../common/tabCloseRestore.js';

/**
 * WORKER-GAPS-66D (`tab-close-restore`) — Cursor parity for Cmd+Shift+T
 * reopening closed chat/app tabs (Cursor 3.25.9).
 *
 * Binary evidence (workbench.glass.main.js):
 *   HistoryService.recentlyClosedEditors + reopenLastClosedEditor @27652666
 *   workbench.action.reopenClosedEditor (CtrlCmd+Shift+T, weight 200) @38319944
 *   composer chat input toUntyped(){resource, options:{override}} @27634878
 *   review-changes input toUntyped(){resource, options:{override, pinned:!0}} @26562063
 * Docs evidence: cursor.com/docs/release-notes — Cmd+Shift+T reopens whatever
 * was closed most recently, chat or app tab (Agent, Environment, Changes,
 * Desktop, Machine, voice call transcript tabs).
 */

const CUSTOMIZE_SECTIONS = ['plugins', 'mcps', 'skills', 'subagents', 'rules', 'commands', 'hooks'] as const;

function parts(scheme: string, path: string, query = ''): ITabResourceParts {
	return { scheme, path, query };
}

suite('tabCloseRestore (GAPS-66D) — verbatim ids + schemes', () => {

	test('editor ids match the browser EditorInput static IDs', () => {
		assert.strictEqual(COMPOSER_CHAT_EDITOR_ID, 'composer.chatEditor');
		assert.strictEqual(COMPOSER_CHANGES_EDITOR_ID, 'composer.changesTab');
		assert.strictEqual(COMPOSER_REVIEW_CHANGES_EDITOR_ID, 'composer.reviewChangesTab');
		assert.strictEqual(COMPOSER_CUSTOMIZE_EDITOR_ID, 'composer.customizeEditor');
	});

	test('schemes match the browser document schemes', () => {
		assert.strictEqual(COMPOSER_CHAT_SCHEME, 'ide-chat');
		assert.strictEqual(COMPOSER_CHANGES_SCHEME, 'composer-changes');
		assert.strictEqual(COMPOSER_CUSTOMIZE_SCHEME, 'ide-customize');
	});
});

suite('tabCloseRestore (GAPS-66D) — buildReopenUntypedInput (binary shapes)', () => {

	test('chat shape: {resource, options:{override}} — no pinned key (binary @27634878)', () => {
		const resource = { scheme: 'ide-chat', path: '/abc123', query: '' };
		const untyped = buildReopenUntypedInput(resource, COMPOSER_CHAT_EDITOR_ID);
		assert.strictEqual(untyped.resource, resource);
		assert.strictEqual(untyped.options.override, 'composer.chatEditor');
		assert.strictEqual('pinned' in untyped.options, false);
	});

	test('review shape: {resource, options:{override, pinned:true}} (binary @26562063)', () => {
		const resource = { scheme: 'composer-changes', path: '/review/abc123', query: 'scope=branch' };
		const untyped = buildReopenUntypedInput(resource, COMPOSER_REVIEW_CHANGES_EDITOR_ID, true);
		assert.strictEqual(untyped.options.override, 'composer.reviewChangesTab');
		assert.strictEqual(untyped.options.pinned, true);
	});

	test('pinned=false behaves like omitted (no pinned key)', () => {
		const untyped = buildReopenUntypedInput('res', 'some.id', false);
		assert.strictEqual('pinned' in untyped.options, false);
	});
});

suite('tabCloseRestore (GAPS-66D) — parseComposerChatTabRef', () => {

	test('parses a valid ide-chat resource', () => {
		assert.strictEqual(parseComposerChatTabRef(parts('ide-chat', '/tab-42')), 'tab-42');
	});

	test('rejects foreign schemes, empty ids and path escapes (fail-closed)', () => {
		assert.strictEqual(parseComposerChatTabRef(parts('file', '/tab-42')), undefined);
		assert.strictEqual(parseComposerChatTabRef(parts('ide-chat', '/')), undefined);
		assert.strictEqual(parseComposerChatTabRef(parts('ide-chat', '')), undefined);
		assert.strictEqual(parseComposerChatTabRef(parts('ide-chat', '/a/b')), undefined);
		assert.strictEqual(parseComposerChatTabRef(parts('ide-chat', '/..')), undefined);
		assert.strictEqual(parseComposerChatTabRef(parts('ide-chat', '/.')), undefined);
		assert.strictEqual(parseComposerChatTabRef(parts('ide-chat', '/a..b')), undefined);
	});
});

suite('tabCloseRestore (GAPS-66D) — parseComposerChangesTabRef', () => {

	test('parses a Changes resource with scope query', () => {
		const ref = parseComposerChangesTabRef(parts('composer-changes', '/agent-1', 'scope=branch'));
		assert.deepStrictEqual(ref, { kind: 'changes', agentId: 'agent-1', scope: 'branch' });
	});

	test('parses a Review Changes resource', () => {
		const ref = parseComposerChangesTabRef(parts('composer-changes', '/review/agent-1', 'scope=branch'));
		assert.deepStrictEqual(ref, { kind: 'review', agentId: 'agent-1', scope: 'branch' });
	});

	test('decodes an encoded scope', () => {
		const ref = parseComposerChangesTabRef(parts('composer-changes', '/agent-1', 'scope=last%20turn'));
		assert.strictEqual(ref?.scope, 'last turn');
	});

	test('missing scope defaults to empty string', () => {
		const ref = parseComposerChangesTabRef(parts('composer-changes', '/agent-1'));
		assert.strictEqual(ref?.scope, '');
	});

	test('rejects malformed resources', () => {
		assert.strictEqual(parseComposerChangesTabRef(parts('file', '/agent-1')), undefined);
		assert.strictEqual(parseComposerChangesTabRef(parts('composer-changes', '/')), undefined);
		assert.strictEqual(parseComposerChangesTabRef(parts('composer-changes', '/review/')), undefined);
		assert.strictEqual(parseComposerChangesTabRef(parts('composer-changes', '/review/..')), undefined);
		assert.strictEqual(parseComposerChangesTabRef(parts('composer-changes', '/a/b/c')), undefined);
	});
});

suite('tabCloseRestore (GAPS-66D) — parseComposerCustomizeTabRef', () => {

	test('parses a valid customize section', () => {
		assert.strictEqual(parseComposerCustomizeTabRef(parts('ide-customize', '/skills'), CUSTOMIZE_SECTIONS), 'skills');
		assert.strictEqual(parseComposerCustomizeTabRef(parts('ide-customize', '/plugins'), CUSTOMIZE_SECTIONS), 'plugins');
	});

	test('rejects unknown sections and malformed resources', () => {
		assert.strictEqual(parseComposerCustomizeTabRef(parts('ide-customize', '/nope'), CUSTOMIZE_SECTIONS), undefined);
		assert.strictEqual(parseComposerCustomizeTabRef(parts('ide-customize', '/'), CUSTOMIZE_SECTIONS), undefined);
		assert.strictEqual(parseComposerCustomizeTabRef(parts('ide-chat', '/skills'), CUSTOMIZE_SECTIONS), undefined);
	});
});
