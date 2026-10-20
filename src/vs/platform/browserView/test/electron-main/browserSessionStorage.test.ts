/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { createHash } from 'crypto';
import { URI } from '../../../../base/common/uri.js';
import { BrowserViewStorageScope } from '../../common/browserView.js';
import { resolveBrowserSessionStorageTarget } from '../../electron-main/browserSessionStorage.js';

/**
 * browser-state-persist (P2): "Cookies, localStorage, IndexedDB persisted per
 * workspace". These tests lock in the storage-target contract — which scopes
 * get a persisted Electron session (cookies/localStorage/IndexedDB survive
 * restarts) and which get an in-memory one.
 */
suite('BrowserSessionStorage (state persistence contract)', () => {

	const storageHome = URI.file('/tmp/vscode-test-workspace-storage');

	test('global scope resolves to the persisted global partition', () => {
		const target = resolveBrowserSessionStorageTarget({ scope: BrowserViewStorageScope.Global });
		assert.strictEqual(target.id, 'global');
		assert.strictEqual(target.partition, 'persist:vscode-browser');
		assert.strictEqual(target.path, undefined);
		assert.strictEqual(target.persisted, true);
	});

	test('workspace scope resolves to a persisted per-workspace path', () => {
		const target = resolveBrowserSessionStorageTarget({
			scope: BrowserViewStorageScope.Workspace,
			sessionOptions: { scope: BrowserViewStorageScope.Workspace },
			workspaceId: 'abc123',
			workspaceStorageHome: storageHome,
		});
		assert.strictEqual(target.id, 'workspace:abc123');
		assert.strictEqual(target.partition, undefined);
		assert.ok(target.path!.endsWith('/abc123/browserStorage'), `unexpected path: ${target.path}`);
		assert.ok(target.path!.startsWith(storageHome.fsPath));
		assert.strictEqual(target.persisted, true);
	});

	test('different workspaces resolve to different persisted paths', () => {
		const a = resolveBrowserSessionStorageTarget({
			scope: BrowserViewStorageScope.Workspace,
			sessionOptions: { scope: BrowserViewStorageScope.Workspace },
			workspaceId: 'ws-a',
			workspaceStorageHome: storageHome,
		});
		const b = resolveBrowserSessionStorageTarget({
			scope: BrowserViewStorageScope.Workspace,
			sessionOptions: { scope: BrowserViewStorageScope.Workspace },
			workspaceId: 'ws-b',
			workspaceStorageHome: storageHome,
		});
		assert.notStrictEqual(a.path, b.path);
		assert.strictEqual(a.persisted, true);
		assert.strictEqual(b.persisted, true);
	});

	test('workspace scope without a workspace falls back to an in-memory session', () => {
		const target = resolveBrowserSessionStorageTarget({
			scope: BrowserViewStorageScope.Workspace,
			sessionOptions: { scope: BrowserViewStorageScope.Workspace },
			viewId: 'view-1',
			workspaceStorageHome: storageHome,
		});
		assert.strictEqual(target.persisted, false);
		assert.ok(target.partition);
		assert.ok(!target.partition!.startsWith('persist:'));
	});

	test('ephemeral scope resolves to an in-memory per-view partition', () => {
		const target = resolveBrowserSessionStorageTarget({
			scope: BrowserViewStorageScope.Ephemeral,
			sessionOptions: { scope: BrowserViewStorageScope.Ephemeral },
			viewId: 'view-1',
		});
		assert.strictEqual(target.id, 'ephemeral:view-1');
		assert.strictEqual(target.persisted, false);
		assert.ok(target.partition);
		assert.ok(!target.partition!.startsWith('persist:'), 'ephemeral partitions must not persist');
		assert.ok(!target.partition!.includes('undefined'), 'partition must not contain a literal "undefined"');
	});

	test('ephemeral scope keeps an explicit type and rejects reserved types', () => {
		const typed = resolveBrowserSessionStorageTarget({
			scope: BrowserViewStorageScope.Ephemeral,
			sessionOptions: { scope: BrowserViewStorageScope.Ephemeral },
			viewId: 'ctx-9',
			ephemeralType: 'cdp-created',
		});
		assert.strictEqual(typed.id, 'cdp-created:ctx-9');
		assert.strictEqual(typed.persisted, false);

		assert.throws(() => resolveBrowserSessionStorageTarget({
			scope: BrowserViewStorageScope.Ephemeral,
			sessionOptions: { scope: BrowserViewStorageScope.Ephemeral },
			viewId: 'view-1',
			ephemeralType: 'workspace',
		}), /reserved type/);
	});

	test('agent scope resolves to an in-memory hashed partition', () => {
		const target = resolveBrowserSessionStorageTarget({
			scope: BrowserViewStorageScope.Agent,
			sessionOptions: { scope: BrowserViewStorageScope.Agent, affinity: 'agent-1' },
			workspaceId: 'ws-a',
		});
		const expectedHash = createHash('sha256').update('affinity:agent-1').digest('hex');
		assert.strictEqual(target.id, `agent:${expectedHash}`);
		assert.strictEqual(target.partition, `vscode-browser-agent-${expectedHash}`);
		assert.strictEqual(target.persisted, false);
	});

	test('agent scope prefers affinity over workspace over window identity', () => {
		const byWorkspace = resolveBrowserSessionStorageTarget({
			scope: BrowserViewStorageScope.Agent,
			sessionOptions: { scope: BrowserViewStorageScope.Agent },
			workspaceId: 'ws-a',
			windowId: 7,
		});
		const expectedHash = createHash('sha256').update('workspace:ws-a').digest('hex');
		assert.strictEqual(byWorkspace.id, `agent:${expectedHash}`);

		const byWindow = resolveBrowserSessionStorageTarget({
			scope: BrowserViewStorageScope.Agent,
			sessionOptions: { scope: BrowserViewStorageScope.Agent },
			windowId: 7,
		});
		const windowHash = createHash('sha256').update('window:7').digest('hex');
		assert.strictEqual(byWindow.id, `agent:${windowHash}`);
	});

	test('agent scope without any identity throws', () => {
		assert.throws(() => resolveBrowserSessionStorageTarget({
			scope: BrowserViewStorageScope.Agent,
			sessionOptions: { scope: BrowserViewStorageScope.Agent },
		}), /affinity, workspace, or window/);
	});
});
