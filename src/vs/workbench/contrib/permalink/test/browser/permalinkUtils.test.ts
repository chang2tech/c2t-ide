/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';

import { buildRemoteFileUrl, encodePathSegments, extractRepositoryPath, isSupportedRemoteHostname, isSupportedRemoteUrl, normalizeRemoteUrl } from '../../common/permalinkUtils.js';

suite('PermalinkUtils', () => {

	suite('buildRemoteFileUrl', () => {

		test('github https remote without line range', () => {
			assert.strictEqual(
				buildRemoteFileUrl({
					remoteUrl: 'https://github.com/acme/widgets.git',
					revision: 'abc123def456',
					relativeFilePath: 'src/index.ts',
				}),
				'https://github.com/acme/widgets/blob/abc123def456/src/index.ts'
			);
		});

		test('github ssh remote produces the same https url', () => {
			assert.strictEqual(
				buildRemoteFileUrl({
					remoteUrl: 'git@github.com:acme/widgets.git',
					revision: 'abc123def456',
					relativeFilePath: 'src/index.ts',
				}),
				'https://github.com/acme/widgets/blob/abc123def456/src/index.ts'
			);
		});

		test('single line selection produces #L{line} anchor', () => {
			assert.strictEqual(
				buildRemoteFileUrl({
					remoteUrl: 'https://github.com/acme/widgets.git',
					revision: 'abc123def456',
					relativeFilePath: 'src/index.ts',
					lineRange: { startLine: 10, endLine: 10 },
				}),
				'https://github.com/acme/widgets/blob/abc123def456/src/index.ts#L10'
			);
		});

		test('multi-line selection produces #L{start}-L{end} anchor', () => {
			assert.strictEqual(
				buildRemoteFileUrl({
					remoteUrl: 'git@github.com:acme/widgets.git',
					revision: 'abc123def456',
					relativeFilePath: 'src/index.ts',
					lineRange: { startLine: 10, endLine: 20 },
				}),
				'https://github.com/acme/widgets/blob/abc123def456/src/index.ts#L10-L20'
			);
		});

		test('no line range produces no hash', () => {
			const url = buildRemoteFileUrl({
				remoteUrl: 'https://github.com/acme/widgets.git',
				revision: 'abc123def456',
				relativeFilePath: 'src/index.ts',
			});
			assert.ok(url && !url.includes('#'), `expected no hash in ${url}`);
		});

		test('path segments are percent-encoded', () => {
			assert.strictEqual(
				buildRemoteFileUrl({
					remoteUrl: 'https://github.com/acme/widgets.git',
					revision: 'abc123def456',
					relativeFilePath: 'src/my file (1).ts',
				}),
				'https://github.com/acme/widgets/blob/abc123def456/src/my%20file%20(1).ts'
			);
		});

		test('leading/trailing slashes in the relative path are trimmed', () => {
			assert.strictEqual(
				buildRemoteFileUrl({
					remoteUrl: 'https://github.com/acme/widgets.git',
					revision: 'abc123def456',
					relativeFilePath: '/src/index.ts/',
				}),
				'https://github.com/acme/widgets/blob/abc123def456/src/index.ts'
			);
		});

		test('revision is trimmed', () => {
			assert.strictEqual(
				buildRemoteFileUrl({
					remoteUrl: 'https://github.com/acme/widgets.git',
					revision: '  abc123def456  ',
					relativeFilePath: 'src/index.ts',
				}),
				'https://github.com/acme/widgets/blob/abc123def456/src/index.ts'
			);
		});

		test('github enterprise (*.ghe.com) host is supported', () => {
			assert.strictEqual(
				buildRemoteFileUrl({
					remoteUrl: 'https://git.corp.ghe.com/acme/widgets.git',
					revision: 'abc123def456',
					relativeFilePath: 'src/index.ts',
				}),
				'https://git.corp.ghe.com/acme/widgets/blob/abc123def456/src/index.ts'
			);
		});

		test('unsupported host (gitlab) yields undefined', () => {
			assert.strictEqual(
				buildRemoteFileUrl({
					remoteUrl: 'https://gitlab.com/acme/widgets.git',
					revision: 'abc123def456',
					relativeFilePath: 'src/index.ts',
				}),
				undefined
			);
		});

		test('missing remote yields undefined (command disabled path)', () => {
			assert.strictEqual(
				buildRemoteFileUrl({ remoteUrl: '', revision: 'abc123def456', relativeFilePath: 'src/index.ts' }),
				undefined
			);
		});

		test('missing revision yields undefined', () => {
			assert.strictEqual(
				buildRemoteFileUrl({ remoteUrl: 'https://github.com/acme/widgets.git', revision: '  ', relativeFilePath: 'src/index.ts' }),
				undefined
			);
		});

		test('missing relative path yields undefined', () => {
			assert.strictEqual(
				buildRemoteFileUrl({ remoteUrl: 'https://github.com/acme/widgets.git', revision: 'abc123def456', relativeFilePath: '' }),
				undefined
			);
			assert.strictEqual(
				buildRemoteFileUrl({ remoteUrl: 'https://github.com/acme/widgets.git', revision: 'abc123def456', relativeFilePath: '///' }),
				undefined
			);
		});

		test('unparseable remote yields undefined', () => {
			assert.strictEqual(
				buildRemoteFileUrl({ remoteUrl: 'not a url at all !!!', revision: 'abc123def456', relativeFilePath: 'src/index.ts' }),
				undefined
			);
		});

		test('ssh:// remote form produces the same https url', () => {
			assert.strictEqual(
				buildRemoteFileUrl({
					remoteUrl: 'ssh://git@github.com/acme/widgets.git',
					revision: 'abc123def456',
					relativeFilePath: 'src/index.ts',
				}),
				'https://github.com/acme/widgets/blob/abc123def456/src/index.ts'
			);
		});

		test('full commit sha revision is embedded verbatim (permalink)', () => {
			assert.strictEqual(
				buildRemoteFileUrl({
					remoteUrl: 'git@github.com:acme/widgets.git',
					revision: 'da39a3ee5e6b4b0d3255bfef95601890afd80709',
					relativeFilePath: 'src/index.ts',
					lineRange: { startLine: 3, endLine: 3 },
				}),
				'https://github.com/acme/widgets/blob/da39a3ee5e6b4b0d3255bfef95601890afd80709/src/index.ts#L3'
			);
		});

		test('query string and fragment on the remote url are stripped', () => {
			assert.strictEqual(
				buildRemoteFileUrl({
					remoteUrl: 'https://github.com/acme/widgets.git?token=secret#frag',
					revision: 'abc123def456',
					relativeFilePath: 'src/index.ts',
				}),
				'https://github.com/acme/widgets/blob/abc123def456/src/index.ts'
			);
		});
	});

	suite('normalizeRemoteUrl', () => {

		test('scp-like ssh remote becomes https without .git', () => {
			assert.strictEqual(normalizeRemoteUrl('git@github.com:acme/widgets.git'), 'https://github.com/acme/widgets');
		});

		test('https remote keeps protocol and drops .git', () => {
			assert.strictEqual(normalizeRemoteUrl('https://github.com/acme/widgets.git'), 'https://github.com/acme/widgets');
		});

		test('http protocol is preserved', () => {
			assert.strictEqual(normalizeRemoteUrl('http://github.com/acme/widgets'), 'http://github.com/acme/widgets');
		});

		test('host is lowercased', () => {
			assert.strictEqual(normalizeRemoteUrl('git@GitHub.com:acme/widgets.git'), 'https://github.com/acme/widgets');
		});

		test('empty input yields empty string', () => {
			assert.strictEqual(normalizeRemoteUrl('  '), '');
		});
	});

	suite('extractRepositoryPath', () => {

		test('ssh remote', () => {
			assert.strictEqual(extractRepositoryPath('git@github.com:acme/widgets.git'), 'acme/widgets');
		});

		test('https remote', () => {
			assert.strictEqual(extractRepositoryPath('https://github.com/acme/widgets'), 'acme/widgets');
		});

		test('single path segment yields undefined', () => {
			assert.strictEqual(extractRepositoryPath('https://github.com/acme'), undefined);
		});

		test('empty input yields undefined', () => {
			assert.strictEqual(extractRepositoryPath(''), undefined);
		});

		test('triple-slash scheme typo is repaired (binary: HPi https/// fix)', () => {
			assert.strictEqual(extractRepositoryPath('https///github.com/acme/widgets.git'), 'acme/widgets');
		});

		test('ssh:// remote', () => {
			assert.strictEqual(extractRepositoryPath('ssh://git@github.com/acme/widgets.git'), 'acme/widgets');
		});

		test('github enterprise sub-path keeps only owner/repo', () => {
			assert.strictEqual(extractRepositoryPath('https://git.corp.ghe.com/acme/widgets.git'), 'acme/widgets');
		});
	});

	suite('isSupportedRemoteUrl', () => {

		test('github https remote is supported', () => {
			assert.strictEqual(isSupportedRemoteUrl('https://github.com/acme/widgets.git'), true);
		});

		test('github ssh remote is supported', () => {
			assert.strictEqual(isSupportedRemoteUrl('git@github.com:acme/widgets.git'), true);
		});

		test('github enterprise (*.ghe.com) remote is supported', () => {
			assert.strictEqual(isSupportedRemoteUrl('https://git.corp.ghe.com/acme/widgets.git'), true);
		});

		test('gitlab remote is not supported', () => {
			assert.strictEqual(isSupportedRemoteUrl('https://gitlab.com/acme/widgets.git'), false);
		});

		test('non-github host is not supported even with github-like path', () => {
			assert.strictEqual(isSupportedRemoteUrl('https://example.com/github.com/acme/widgets.git'), false);
		});

		test('empty remote is not supported', () => {
			assert.strictEqual(isSupportedRemoteUrl(''), false);
			assert.strictEqual(isSupportedRemoteUrl('   '), false);
		});
	});

	suite('isSupportedRemoteHostname', () => {

		test('github.com is supported', () => {
			assert.strictEqual(isSupportedRemoteHostname('github.com'), true);
		});

		test('*.ghe.com is supported', () => {
			assert.strictEqual(isSupportedRemoteHostname('git.corp.ghe.com'), true);
		});

		test('other hosts are not supported', () => {
			assert.strictEqual(isSupportedRemoteHostname('gitlab.com'), false);
			assert.strictEqual(isSupportedRemoteHostname('bitbucket.org'), false);
		});
	});

	suite('encodePathSegments', () => {

		test('backslashes become slashes', () => {
			assert.strictEqual(encodePathSegments('src\\sub\\file.ts'), 'src/sub/file.ts');
		});

		test('empty segments are dropped', () => {
			assert.strictEqual(encodePathSegments('src//file.ts'), 'src/file.ts');
		});
	});
});
