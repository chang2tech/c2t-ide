/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationError } from '../../../../base/common/errors.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { ensureRemoteAgentHostCliInstalled } from '../../node/remoteAgentHostCliInstaller.js';
import { ISshExec } from '../../node/sshRemoteAgentHostHelpers.js';

suite('Remote Agent Host CLI installer cache', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const commit = 'a'.repeat(40);
	const cliBin = `~/.vscode-server-insiders/code-insiders-${commit}`;
	const looseCliBin = `~/.vscode-server-insiders/code-insiders`;
	// IDE Code publishes no fork CLI artifact, so `buildCLIDownloadUrl`
	// throws this error before any cache or download command can be formed
	// (the pinned installer calls it before its cache/download `try` block).
	const pinnedDisabledError = new RegExp(`CLI download is disabled in IDE Code: no fork CLI artifact is published \\(requested cli-linux-arm64/insider, commit ${commit}\\)`);

	function fixture(cacheError?: Error, exists = false, pinned = true, shared = true) {
		const commands: string[] = [];
		const messages: string[] = [];
		const exec: ISshExec = async command => {
			commands.push(command);
			if (command.startsWith('test -x ')) {
				return { code: exists ? 0 : 1, stdout: '', stderr: '' };
			}
			if (command.includes('flock 9') && cacheError) {
				throw cacheError;
			}
			return { code: 0, stdout: '', stderr: '' };
		};
		return {
			commands,
			messages,
			run: () => ensureRemoteAgentHostCliInstalled(exec, { os: 'linux', arch: 'arm64' }, {
				serverDataFolderName: '.vscode-server-insiders',
				quality: 'insider',
				commit: pinned ? commit : undefined,
				cliCacheDir: shared ? '/vscode/vscode-server-insiders/cli/bin/linux-arm64' : undefined,
				reportCacheStatus: message => messages.push(message),
				reportInstalling: () => { },
				logService: store.add(new NullLogService()),
			}),
		};
	}

	test('fails closed instead of installing a private copy from the cache', async () => {
		const test = fixture();
		await assert.rejects(test.run(), pinnedDisabledError);
		assert.deepStrictEqual({
			commands: test.commands,
			cacheAttempts: test.commands.filter(command => command.includes('flock 9')).length,
			privateDownloads: test.commands.filter(command => command.includes('curl -fsSL') && !command.includes('flock 9')).length,
			microsoftDownloads: test.commands.filter(command => command.includes('update.code.visualstudio.com')).length,
			reportedCache: test.messages,
			validated: test.commands.includes(`${cliBin} --version`),
		}, { commands: [`test -x ${cliBin}`], cacheAttempts: 0, privateDownloads: 0, microsoftDownloads: 0, reportedCache: [], validated: false });
	});

	test('fails closed before the shared cache is tried, so a cache failure cannot fall back to a private download', async () => {
		const test = fixture(new Error('flock is unavailable'));
		await assert.rejects(test.run(), pinnedDisabledError);
		assert.deepStrictEqual({
			commands: test.commands,
			privateDownloads: test.commands.filter(command => command.includes('curl -fsSL') && !command.includes('flock 9')).length,
			microsoftDownloads: test.commands.filter(command => command.includes('update.code.visualstudio.com')).length,
			messages: test.messages,
		}, { commands: [`test -x ${cliBin}`], privateDownloads: 0, microsoftDownloads: 0, messages: [] });
	});

	test('fails closed before the cache runs, so cache cancellation is never reached and nothing downloads or falls back', async () => {
		const test = fixture(new CancellationError());
		await assert.rejects(test.run(), pinnedDisabledError);
		assert.deepStrictEqual({
			commands: test.commands,
			downloads: test.commands.filter(command => command.includes('curl')).length,
			messages: test.messages,
		}, { commands: [`test -x ${cliBin}`], downloads: 0, messages: [] });
	});

	test('preserves private reuse and unpinned updates, and fails closed for an installation without a shared cache', async () => {
		const existing = fixture(undefined, true);
		const unpinned = fixture(undefined, false, false);
		const privateOnly = fixture(undefined, false, true, false);
		const [existingResult, unpinnedResult] = await Promise.all([existing.run(), unpinned.run()]);
		await assert.rejects(privateOnly.run(), pinnedDisabledError);
		assert.deepStrictEqual({
			existingResult,
			unpinnedResult,
			cacheCommands: [...existing.commands, ...unpinned.commands, ...privateOnly.commands].filter(command => command.includes('flock 9')),
			existingDownloads: existing.commands.filter(command => command.includes('curl')),
			unpinnedUpdates: unpinned.commands.some(command => command.includes('code-insiders update')),
			privateOnlyCommands: privateOnly.commands,
			privateDownloads: privateOnly.commands.filter(command => command.includes('curl')).length,
			microsoftDownloads: [...existing.commands, ...unpinned.commands, ...privateOnly.commands].filter(command => command.includes('update.code.visualstudio.com')).length,
		}, { existingResult: { cliBin, installed: false }, unpinnedResult: { cliBin: looseCliBin, installed: false }, cacheCommands: [], existingDownloads: [], unpinnedUpdates: true, privateOnlyCommands: [`test -x ${cliBin}`], privateDownloads: 0, microsoftDownloads: 0 });
	});
});
