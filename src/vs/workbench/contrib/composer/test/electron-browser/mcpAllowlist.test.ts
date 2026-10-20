/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { McpAllowlist, matchAllowlistPattern, normalizeGrantEntry } from '../../electron-browser/mcp/allowlist.js';
import { InMemoryMcpGrantStore, MCP_ALLOWED_TOOLS_GLOBAL_KEY } from '../../electron-browser/mcp/grantStore.js';
import type { McpGrantStore } from '../../common/mcp/types.js';

/**
 * WORKER-GAPS-30D (mcp-approval-persistence) — Cursor 3.25.9 parity for the
 * MCP approval grant storage.
 *
 * Binary evidence (workbench.glass.main.js 3.25.9, self-verified 2026-10-20):
 * - `mcp-approvals.json` = 0 hits (glass + desktop) — no project-level
 *   approvals file; legacy files must be ignored.
 * - `setApplicationUserPersistentStorage("composerState","mcpAllowedTools",…)`
 *   ×6 — "Always allow" → user-global persistent array, normalized
 *   `server:tool`, no TTL.
 * - `mcpAllowedToolsForChat` ×5 — one-shot RUN →
 *   `updateComposerDataSetStore(handle, z=>z("mcpAllowedToolsForChat",
 *   K=>K?.includes(W)?K:[...K??[],W]))` (case-sensitive dedupe on write).
 * - Consult `[...effectiveAllowlist, ...mcpAllowedToolsForChat??[]]`
 *   case-insensitive.
 *
 * CAT-A mirror of the extension suite
 * (extensions/ide-agent/src/mcp/test/run-tests.ts §precheck/approval
 * persistence) — both layers must stay in sync.
 */

const silentLogger = { appendLine: (_m: string) => undefined };

function makeTempRoot(withApprovalsFile: boolean): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'core-mcp-al-'));
	fs.mkdirSync(path.join(root, '.cursor'), { recursive: true });
	fs.writeFileSync(
		path.join(root, '.cursor', 'permissions.json'),
		JSON.stringify({ mcpAllowlist: ['fs:read', 'git:*'] }),
	);
	if (withApprovalsFile) {
		// Legacy fabricated file — must be IGNORED.
		fs.writeFileSync(
			path.join(root, '.cursor', 'mcp-approvals.json'),
			JSON.stringify({ approvals: { 'fs:write': 'deny', 'net:fetch': 'allow' } }),
		);
	}
	return root;
}

suite('core McpAllowlist (mcp-approval-persistence parity)', () => {

	test('permissions.json allowlist allows; legacy mcp-approvals.json is ignored', () => {
		const root = makeTempRoot(true);
		try {
			const al = new McpAllowlist([root], silentLogger, new InMemoryMcpGrantStore());
			assert.strictEqual(al.precheck('fs', 'write').decision, 'ask'); // legacy deny ignored
			assert.strictEqual(al.precheck('net', 'fetch').decision, 'ask'); // legacy allow ignored
			assert.strictEqual(al.precheck('fs', 'read').decision, 'allow');
			assert.strictEqual(al.precheck('git', 'push').decision, 'allow');
			assert.strictEqual(al.precheck('fs', 'exec').decision, 'ask');
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('global grants allow every composer (case-insensitive consult)', () => {
		const store: McpGrantStore = new InMemoryMcpGrantStore();
		const al = new McpAllowlist([], silentLogger, store);
		assert.strictEqual(al.precheck('srv', 'tool', 'chat-1').decision, 'ask');
		al.rememberAlwaysAllow('srv', 'tool');
		assert.deepStrictEqual(store.getGlobalGrants(), ['srv:tool']);
		assert.strictEqual(al.precheck('srv', 'tool', 'chat-1').decision, 'allow');
		assert.strictEqual(al.precheck('srv', 'tool', 'chat-2').decision, 'allow');
		assert.strictEqual(al.precheck('SRV', 'TOOL').decision, 'allow');
	});

	test('chat grants are scoped to one composer', () => {
		const store: McpGrantStore = new InMemoryMcpGrantStore();
		const al = new McpAllowlist([], silentLogger, store);
		al.rememberChatGrant('chat-1', 'srv', 'tool');
		assert.strictEqual(al.precheck('srv', 'tool', 'chat-1').decision, 'allow');
		assert.strictEqual(al.precheck('srv', 'tool', 'chat-2').decision, 'ask');
		assert.strictEqual(al.precheck('srv', 'tool').decision, 'ask');
	});

	test('global grant key is the verbatim Cursor storage key', () => {
		assert.strictEqual(MCP_ALLOWED_TOOLS_GLOBAL_KEY, 'composerState.mcpAllowedTools');
	});

	test('write-dedupe is case-sensitive, like the binary', () => {
		const store = new InMemoryMcpGrantStore();
		const al = new McpAllowlist([], silentLogger, store);
		al.rememberAlwaysAllow('srv', 'tool');
		al.rememberAlwaysAllow('srv', 'tool');
		assert.deepStrictEqual(store.getGlobalGrants(), ['srv:tool']);
	});

	test('normalizeGrantEntry trims to server:tool', () => {
		assert.strictEqual(normalizeGrantEntry(' srv ', ' tool '), 'srv:tool');
	});

	test('matchAllowlistPattern keeps the documented wildcard forms', () => {
		assert.ok(matchAllowlistPattern('fs:read', 'fs', 'read'));
		assert.ok(!matchAllowlistPattern('fs:read', 'fs', 'write'));
		assert.ok(matchAllowlistPattern('fs:*', 'fs', 'anything'));
		assert.ok(matchAllowlistPattern('*:read', 'fs', 'read'));
		assert.ok(!matchAllowlistPattern('no-colon', 'fs', 'read'));
	});

	test('works with no grant store (permissions.json only)', () => {
		const root = makeTempRoot(false);
		try {
			const al = new McpAllowlist([root], silentLogger);
			assert.strictEqual(al.precheck('fs', 'read').decision, 'allow');
			assert.strictEqual(al.precheck('srv', 'tool').decision, 'ask');
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
