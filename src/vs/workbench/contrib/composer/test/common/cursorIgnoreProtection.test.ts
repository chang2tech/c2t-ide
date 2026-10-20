/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	CURSORIGNORE_FILENAME,
	CURSORIGNORE_WRITE_ACTIONS,
	baseNameLowerFsPath,
	isCursorIgnoreSelfWrite,
	isCursorIgnoreSelfWriteResolved,
} from '../../common/cursorIgnoreProtection.js';

/**
 * DEV-GAPS-71D (`approval-cursorignore-self-protect`) — the agent cannot
 * modify `.cursorignore` itself.
 *
 * Binary evidence (Cursor 3.25.9,
 * `resources/app/extensions/cursor-agent-exec/dist/main.js` —
 * `InteractivePermissionsService.shouldBlockWrite` def @6153119,
 * `.cursorignore` check @6153702, `dl` path resolver @6141160 —
 * byte-verified 2026-10-20 by slicing the reference binary):
 *   const l=i.originalPath.split(s.sep).pop()?.toLowerCase()??"",
 *         u=a.split(s.sep).pop()?.toLowerCase()??"";
 *   if(".cursorignore"===l||".cursorignore"===u)return{type:"permissionsConfig"};
 * i.e. lowercased basename of the requested AND the resolved path is compared;
 * a match hard-blocks the write as `{type:"permissionsConfig"}` (denied, no
 * approval prompt). The resolved path comes from `dl` = `fs.realpath` with an
 * `lstat`/`readlink` fallback for dangling symlinks. Enforced in the fork at
 * the `permission.asked` choke point (`handleApproval`,
 * electron-browser/ideCodeEngineAdapter.ts) by auto-denying without prompting.
 */

suite('cursorIgnoreProtection (GAPS-71D) — constants mirror the binary', () => {

	test('protected filename is verbatim ".cursorignore"', () => {
		assert.strictEqual(CURSORIGNORE_FILENAME, '.cursorignore');
	});

	test('write actions cover the binary shouldBlockWrite gate', () => {
		assert.ok(CURSORIGNORE_WRITE_ACTIONS.has('edit'));
		assert.ok(CURSORIGNORE_WRITE_ACTIONS.has('write'));
		assert.ok(CURSORIGNORE_WRITE_ACTIONS.has('patch'));
	});
});

suite('cursorIgnoreProtection (GAPS-71D) — baseNameLowerFsPath', () => {

	test('posix basename, lowercased', () => {
		assert.strictEqual(baseNameLowerFsPath('/repo/.cursorignore'), '.cursorignore');
		assert.strictEqual(baseNameLowerFsPath('/repo/.CURSORIGNORE'), '.cursorignore');
	});

	test('windows separators', () => {
		assert.strictEqual(baseNameLowerFsPath('C:\\repo\\.cursorignore'), '.cursorignore');
		assert.strictEqual(baseNameLowerFsPath('C:\\repo\\.CURSORIGNORE'), '.cursorignore');
	});

	test('bare filename and nested dirs', () => {
		assert.strictEqual(baseNameLowerFsPath('.cursorignore'), '.cursorignore');
		assert.strictEqual(baseNameLowerFsPath('/a/b/c/.cursorignore'), '.cursorignore');
	});

	test('non-matching basenames are untouched', () => {
		assert.strictEqual(baseNameLowerFsPath('/repo/.cursorignore.bak'), '.cursorignore.bak');
		assert.strictEqual(baseNameLowerFsPath('/repo/src/index.ts'), 'index.ts');
	});
});

suite('cursorIgnoreProtection (GAPS-71D) — isCursorIgnoreSelfWrite', () => {

	test('edit of .cursorignore is blocked (posix + windows + bare)', () => {
		assert.strictEqual(isCursorIgnoreSelfWrite('edit', ['/repo/.cursorignore']), true);
		assert.strictEqual(isCursorIgnoreSelfWrite('edit', ['C:\\repo\\.cursorignore']), true);
		assert.strictEqual(isCursorIgnoreSelfWrite('edit', ['.cursorignore']), true);
	});

	test('binary lowercases before comparing (".CURSORIGNORE")', () => {
		assert.strictEqual(isCursorIgnoreSelfWrite('edit', ['/repo/.CURSORIGNORE']), true);
		assert.strictEqual(isCursorIgnoreSelfWrite('EDIT', ['/repo/.cursorignore']), true);
	});

	test('write/patch actions are covered; other actions are not', () => {
		assert.strictEqual(isCursorIgnoreSelfWrite('write', ['/repo/.cursorignore']), true);
		assert.strictEqual(isCursorIgnoreSelfWrite('patch', ['/repo/.cursorignore']), true);
		assert.strictEqual(isCursorIgnoreSelfWrite('read', ['/repo/.cursorignore']), false);
		assert.strictEqual(isCursorIgnoreSelfWrite('shell', ['/repo/.cursorignore']), false);
		assert.strictEqual(isCursorIgnoreSelfWrite('delete', ['/repo/.cursorignore']), false);
	});

	test('ordinary files are not blocked', () => {
		assert.strictEqual(isCursorIgnoreSelfWrite('edit', ['/repo/src/index.ts']), false);
		assert.strictEqual(isCursorIgnoreSelfWrite('edit', ['/repo/.cursorignore.bak']), false);
		// directory named .cursorignore, but the target file is not
		assert.strictEqual(isCursorIgnoreSelfWrite('edit', ['/repo/.cursorignore/notes.txt']), false);
	});

	test('any matching resource blocks; empty resources do not', () => {
		assert.strictEqual(isCursorIgnoreSelfWrite('edit', ['/repo/a.ts', '/repo/.cursorignore']), true);
		assert.strictEqual(isCursorIgnoreSelfWrite('edit', []), false);
	});

	test('non-string resources are ignored safely', () => {
		assert.strictEqual(isCursorIgnoreSelfWrite('edit', [undefined as unknown as string]), false);
	});
});

suite('cursorIgnoreProtection (GAPS-83) — isCursorIgnoreSelfWriteResolved (real symlinks)', () => {

	// Mirror of the fork's production resolver (electron-browser/
	// ideCodeEngineAdapter.ts `resolveCursorIgnoreTargetPath`), which mirrors
	// the binary's `dl` @6141160: fs.realpath, ENOENT → lstat + readlink for
	// dangling symlinks.
	async function testResolver(fsPath: string): Promise<string> {
		try {
			return await fsp.realpath(fsPath);
		} catch (err: any) {
			if (err?.code === 'ENOENT') {
				const st = await fsp.lstat(fsPath);
				if (st.isSymbolicLink()) {
					return await fsp.readlink(fsPath);
				}
			}
			throw err;
		}
	}

	let tmpDir: string;
	let realIgnore: string;

	suiteSetup(async () => {
		tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cursorignore-w83b-'));
		realIgnore = path.join(tmpDir, '.cursorignore');
		await fsp.writeFile(realIgnore, '# test\n');
		await fsp.writeFile(path.join(tmpDir, 'normal.txt'), 'x');
	});

	suiteTeardown(async () => {
		await fsp.rm(tmpDir, { recursive: true, force: true });
	});

	test('symlink pointing at .cursorignore is blocked via resolved basename', async () => {
		const link = path.join(tmpDir, 'innocent-link');
		await fsp.symlink(realIgnore, link);
		try {
			assert.strictEqual(
				await isCursorIgnoreSelfWriteResolved('edit', [link], testResolver),
				true,
			);
		} finally {
			await fsp.unlink(link);
		}
	});

	test('symlink pointing at an ordinary file is not blocked', async () => {
		const link = path.join(tmpDir, 'link-to-normal');
		await fsp.symlink(path.join(tmpDir, 'normal.txt'), link);
		try {
			assert.strictEqual(
				await isCursorIgnoreSelfWriteResolved('edit', [link], testResolver),
				false,
			);
		} finally {
			await fsp.unlink(link);
		}
	});

	test('dangling symlink whose target basename is .cursorignore is blocked (readlink fallback)', async () => {
		const link = path.join(tmpDir, 'dangling-link');
		await fsp.symlink(path.join(tmpDir, '.cursorignore'), link);
		// target does not exist yet → realpath ENOENT → readlink fallback
		await fsp.unlink(realIgnore);
		try {
			assert.strictEqual(
				await isCursorIgnoreSelfWriteResolved('edit', [link], testResolver),
				true,
			);
		} finally {
			await fsp.unlink(link);
			await fsp.writeFile(realIgnore, '# test\n');
		}
	});

	test('dangling symlink to an ordinary name is not blocked', async () => {
		const link = path.join(tmpDir, 'dangling-normal');
		await fsp.symlink(path.join(tmpDir, 'missing.txt'), link);
		try {
			assert.strictEqual(
				await isCursorIgnoreSelfWriteResolved('edit', [link], testResolver),
				false,
			);
		} finally {
			await fsp.unlink(link);
		}
	});

	test('not-yet-created file fails open on the resolved half (new files stay creatable)', async () => {
		const missing = path.join(tmpDir, 'brand-new.ts');
		assert.strictEqual(
			await isCursorIgnoreSelfWriteResolved('edit', [missing], testResolver),
			false,
		);
	});

	test('requested path still blocks without needing resolution', async () => {
		const throwing = async (_p: string): Promise<string> => {
			throw new Error('resolver must not be consulted for direct hits');
		};
		assert.strictEqual(
			await isCursorIgnoreSelfWriteResolved('edit', [realIgnore], throwing),
			true,
		);
	});

	test('non-write actions stay unblocked even through a symlink', async () => {
		const link = path.join(tmpDir, 'read-link');
		await fsp.symlink(realIgnore, link);
		try {
			assert.strictEqual(
				await isCursorIgnoreSelfWriteResolved('read', [link], testResolver),
				false,
			);
		} finally {
			await fsp.unlink(link);
		}
	});
});
