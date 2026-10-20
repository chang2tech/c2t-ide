/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CursorMcpNetworkMode, cursorMcpNetworkPolicyToSandbox, isMcpNetworkHostAllowed, parseCursorMcpNetworkMode, resolveCursorMcpNetworkPolicy } from '../../common/cursorMcpNetworkModes.js';

suite('MCP - Cursor network modes (mcp-network-modes)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('parseCursorMcpNetworkMode accepts the four documented modes', () => {
		assert.strictEqual(parseCursorMcpNetworkMode('allowAll'), CursorMcpNetworkMode.AllowAll);
		assert.strictEqual(parseCursorMcpNetworkMode('allowlist'), CursorMcpNetworkMode.Allowlist);
		assert.strictEqual(parseCursorMcpNetworkMode('denyAll'), CursorMcpNetworkMode.DenyAll);
		assert.strictEqual(parseCursorMcpNetworkMode('noSandbox'), CursorMcpNetworkMode.NoSandbox);
		// tolerant variants
		assert.strictEqual(parseCursorMcpNetworkMode('Allow All'), CursorMcpNetworkMode.AllowAll);
		assert.strictEqual(parseCursorMcpNetworkMode('deny-all'), CursorMcpNetworkMode.DenyAll);
		assert.strictEqual(parseCursorMcpNetworkMode('NO_SANDBOX'), undefined); // underscores not accepted
		// unknown / missing
		assert.strictEqual(parseCursorMcpNetworkMode('bogus'), undefined);
		assert.strictEqual(parseCursorMcpNetworkMode(undefined), undefined);
		assert.strictEqual(parseCursorMcpNetworkMode(42), undefined);
	});

	test('resolveCursorMcpNetworkPolicy honors explicit networkMode', () => {
		const policy = resolveCursorMcpNetworkPolicy({ networkMode: 'allowlist', allowedDomains: ['example.com'] });
		assert.strictEqual(policy.mode, CursorMcpNetworkMode.Allowlist);
		assert.deepStrictEqual(policy.allowedDomains, ['example.com']);
	});

	test('resolveCursorMcpNetworkPolicy derives allowlist from sandbox config', () => {
		const policy = resolveCursorMcpNetworkPolicy({ sandbox: { network: { allowedDomains: ['a.com'] } } });
		assert.strictEqual(policy.mode, CursorMcpNetworkMode.Allowlist);
		assert.deepStrictEqual(policy.allowedDomains, ['a.com']);
	});

	test('resolveCursorMcpNetworkPolicy defaults to allowAll when nothing configured', () => {
		const policy = resolveCursorMcpNetworkPolicy({});
		assert.strictEqual(policy.mode, CursorMcpNetworkMode.AllowAll);
		assert.strictEqual(policy.allowedDomains, undefined);
	});

	test('cursorMcpNetworkPolicyToSandbox maps the four modes', () => {
		assert.strictEqual(
			cursorMcpNetworkPolicyToSandbox({ mode: CursorMcpNetworkMode.NoSandbox, allowedDomains: undefined }),
			undefined,
		);
		assert.deepStrictEqual(
			cursorMcpNetworkPolicyToSandbox({ mode: CursorMcpNetworkMode.AllowAll, allowedDomains: undefined }),
			{},
		);
		assert.deepStrictEqual(
			cursorMcpNetworkPolicyToSandbox({ mode: CursorMcpNetworkMode.Allowlist, allowedDomains: ['example.com'] }),
			{ network: { allowedDomains: ['example.com'] } },
		);
		assert.deepStrictEqual(
			cursorMcpNetworkPolicyToSandbox({ mode: CursorMcpNetworkMode.DenyAll, allowedDomains: undefined }),
			{ network: { allowedDomains: [] } },
		);
	});

	test('isMcpNetworkHostAllowed enforces the policy', () => {
		const allowAll = { mode: CursorMcpNetworkMode.AllowAll, allowedDomains: undefined };
		const noSandbox = { mode: CursorMcpNetworkMode.NoSandbox, allowedDomains: undefined };
		const denyAll = { mode: CursorMcpNetworkMode.DenyAll, allowedDomains: undefined };
		const allowlist = { mode: CursorMcpNetworkMode.Allowlist, allowedDomains: ['example.com'] };

		assert.ok(isMcpNetworkHostAllowed(allowAll, 'anything.io'));
		assert.ok(isMcpNetworkHostAllowed(noSandbox, 'anything.io'));
		assert.ok(!isMcpNetworkHostAllowed(denyAll, 'example.com'));

		assert.ok(isMcpNetworkHostAllowed(allowlist, 'example.com'));
		assert.ok(isMcpNetworkHostAllowed(allowlist, 'sub.example.com'));
		assert.ok(isMcpNetworkHostAllowed(allowlist, 'EXAMPLE.com')); // case-insensitive
		assert.ok(!isMcpNetworkHostAllowed(allowlist, 'evil-example.com'));
		assert.ok(!isMcpNetworkHostAllowed(allowlist, 'other.io'));

		// empty allowlist allows nothing
		assert.ok(!isMcpNetworkHostAllowed({ mode: CursorMcpNetworkMode.Allowlist, allowedDomains: [] }, 'example.com'));
	});
});
