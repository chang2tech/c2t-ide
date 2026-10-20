/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import {
	buildCodeLink,
	CODE_LINK_BASE_URL,
	encodeCodeLinkPath,
	getCodeLinkSlug,
	getCodeLinkSlugFromRemoteUrl,
	isEligibleCodeLinkOwner,
} from '../../common/codeLinks.js';

suite('codeLinks', () => {

	suite('getCodeLinkSlugFromRemoteUrl', () => {

		test('parses an https github.com remote', () => {
			assert.deepStrictEqual(
				getCodeLinkSlugFromRemoteUrl('https://github.com/anysphere/cursor.git', 'github.com'),
				{ owner: 'anysphere', repo: 'cursor' }
			);
		});

		test('parses an scp-like git remote and strips the .git suffix', () => {
			assert.deepStrictEqual(
				getCodeLinkSlugFromRemoteUrl('git@github.com:anysphere/cursor.git', 'github.com'),
				{ owner: 'anysphere', repo: 'cursor' }
			);
		});

		test('parses an ssh:// remote', () => {
			assert.deepStrictEqual(
				getCodeLinkSlugFromRemoteUrl('ssh://git@github.com/withgraphite/graphite-cli.git', 'github.com'),
				{ owner: 'withgraphite', repo: 'graphite-cli' }
			);
		});

		test('parses an origin.cursor.com remote', () => {
			assert.deepStrictEqual(
				getCodeLinkSlugFromRemoteUrl('https://origin.cursor.com/anysphere/cursor', 'origin.cursor.com'),
				{ owner: 'anysphere', repo: 'cursor' }
			);
		});

		test('rejects remotes on ineligible hosts', () => {
			assert.strictEqual(getCodeLinkSlugFromRemoteUrl('https://gitlab.com/anysphere/cursor.git', 'github.com'), undefined);
			assert.strictEqual(getCodeLinkSlugFromRemoteUrl('git@gitlab.com:anysphere/cursor.git', 'github.com'), undefined);
			assert.strictEqual(getCodeLinkSlugFromRemoteUrl('https://github.com/anysphere/cursor.git', 'origin.cursor.com'), undefined);
		});

		test('supports multi-segment owners and drops a leading git segment', () => {
			assert.deepStrictEqual(
				getCodeLinkSlugFromRemoteUrl('https://github.com/org/team/repo', 'github.com'),
				{ owner: 'org/team', repo: 'repo' }
			);
			assert.deepStrictEqual(
				getCodeLinkSlugFromRemoteUrl('https://github.com/git/anysphere/cursor', 'github.com'),
				{ owner: 'anysphere', repo: 'cursor' }
			);
		});

		test('rejects empty and malformed urls', () => {
			assert.strictEqual(getCodeLinkSlugFromRemoteUrl(undefined, 'github.com'), undefined);
			assert.strictEqual(getCodeLinkSlugFromRemoteUrl('', 'github.com'), undefined);
			assert.strictEqual(getCodeLinkSlugFromRemoteUrl('https://github.com/onlyowner', 'github.com'), undefined);
			assert.strictEqual(getCodeLinkSlugFromRemoteUrl('not a url', 'github.com'), undefined);
		});
	});

	suite('getCodeLinkSlug', () => {

		test('skips remotes without a fetch url and finds the eligible one', () => {
			assert.deepStrictEqual(
				getCodeLinkSlug([
					{ name: 'upstream', fetchUrl: undefined },
					{ name: 'origin', fetchUrl: 'git@github.com:anysphere/cursor.git' },
				]),
				{ owner: 'anysphere', repo: 'cursor' }
			);
		});

		test('returns undefined when no remote matches any eligible host', () => {
			assert.strictEqual(getCodeLinkSlug([{ name: 'origin', fetchUrl: 'https://example.com/foo/bar.git' }]), undefined);
			assert.strictEqual(getCodeLinkSlug(undefined), undefined);
			assert.strictEqual(getCodeLinkSlug([]), undefined);
		});
	});

	suite('isEligibleCodeLinkOwner', () => {

		test('matches the allowlist case-insensitively and trims whitespace', () => {
			assert.strictEqual(isEligibleCodeLinkOwner('anysphere'), true);
			assert.strictEqual(isEligibleCodeLinkOwner('Anysphere'), true);
			assert.strictEqual(isEligibleCodeLinkOwner(' withgraphite '), true);
		});

		test('rejects other owners', () => {
			assert.strictEqual(isEligibleCodeLinkOwner('microsoft'), false);
			assert.strictEqual(isEligibleCodeLinkOwner(''), false);
		});
	});

	suite('buildCodeLink', () => {

		test('builds a file-only link', () => {
			assert.strictEqual(
				buildCodeLink({ owner: 'anysphere', repo: 'cursor' }, 'main', 'src/app.ts'),
				`${CODE_LINK_BASE_URL}/anysphere/cursor/blob/main/src/app.ts`
			);
		});

		test('appends a single line fragment', () => {
			assert.strictEqual(
				buildCodeLink({ owner: 'anysphere', repo: 'cursor' }, 'main', 'src/app.ts', { startLine: 12, endLine: 12 }),
				`${CODE_LINK_BASE_URL}/anysphere/cursor/blob/main/src/app.ts#L12`
			);
		});

		test('appends a line range fragment', () => {
			assert.strictEqual(
				buildCodeLink({ owner: 'anysphere', repo: 'cursor' }, 'main', 'src/app.ts', { startLine: 3, endLine: 9 }),
				`${CODE_LINK_BASE_URL}/anysphere/cursor/blob/main/src/app.ts#L3-L9`
			);
		});

		test('encodes ref and path segments individually', () => {
			assert.strictEqual(
				buildCodeLink({ owner: 'anysphere', repo: 'cursor' }, 'feature/my branch', 'src/my file#1.ts'),
				`${CODE_LINK_BASE_URL}/anysphere/cursor/blob/feature/my%20branch/src/my%20file%231.ts`
			);
		});
	});

	suite('encodeCodeLinkPath', () => {

		test('encodes segments but keeps slashes', () => {
			assert.strictEqual(encodeCodeLinkPath('/a b/c#d/e'), '/a%20b/c%23d/e');
		});
	});
});
