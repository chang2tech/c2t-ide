/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE (GAPS-132 `worktrees-json-config`): pure-logic tests for the
// `.cursor/worktrees.json` setup port (common/worktreeSetup.ts). Binary
// evidence: Cursor 3.25.9 workbench.glass.main.js — runtime `eiy`
// @46710083, schema @43381934, builders `c4x`/`u4x`/`d4x`/`h4x`, flatten
// `p4x`, timeout `Edu=300*1e3`, output tail `qZg=2048` @25950961.
// The execution side (electron-browser/worktreeSetupRunner.ts) is covered
// by real-execution tests in the ide-agent extension
// (extensions/ide-agent/src/services/worktreeSetup.test.ts).

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	WORKTREE_SETUP_OUTPUT_TAIL_CHARS,
	WORKTREE_SETUP_TIMEOUT_MS,
	buildUnixCommandsScript,
	buildUnixScriptFileScript,
	buildWindowsCommandsScript,
	buildWindowsScriptFileScript,
	escapeSetupSingleQuotes,
	escapeSetupWindows,
	flattenSetupCommands,
	isAbsoluteSetupScriptPath,
	selectSetupSpec,
} from '../../common/worktreeSetup.js';

suite('WorktreeSetup (GAPS-132 worktrees-json-config)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('constants match the binary: timeout 300s, output tail 2048', () => {
		assert.strictEqual(WORKTREE_SETUP_TIMEOUT_MS, 300000);
		assert.strictEqual(WORKTREE_SETUP_OUTPUT_TAIL_CHARS, 2048);
	});

	test('flattenSetupCommands keeps strings, recurses arrays, drops the rest (p4x)', () => {
		assert.deepStrictEqual(flattenSetupCommands('npm ci'), ['npm ci']);
		assert.deepStrictEqual(flattenSetupCommands(['a', ['b', ['c']], 'd']), ['a', 'b', 'c', 'd']);
		assert.deepStrictEqual(flattenSetupCommands(['a', 42, null, { x: 1 }, true, 'b']), ['a', 'b']);
		assert.deepStrictEqual(flattenSetupCommands(42), []);
		assert.deepStrictEqual(flattenSetupCommands(undefined), []);
	});

	test('selectSetupSpec: OS-specific key wins, generic is the fallback', () => {
		const cfg = { 'setup-worktree': ['generic'], 'setup-worktree-unix': ['unix'], 'setup-worktree-windows': ['win'] };
		assert.deepStrictEqual(selectSetupSpec(cfg, false), { key: 'setup-worktree-unix', commands: ['unix'] });
		assert.deepStrictEqual(selectSetupSpec(cfg, true), { key: 'setup-worktree-windows', commands: ['win'] });
		assert.deepStrictEqual(selectSetupSpec({ 'setup-worktree': ['generic'] }, false), { key: 'setup-worktree', commands: ['generic'] });
		assert.deepStrictEqual(selectSetupSpec({ 'setup-worktree-unix': ['unix'] }, true), {});
		assert.deepStrictEqual(selectSetupSpec({}, false), {});
	});

	test('selectSetupSpec: string value is a script file', () => {
		assert.deepStrictEqual(selectSetupSpec({ 'setup-worktree-unix': './setup.sh' }, false), { key: 'setup-worktree-unix', scriptValue: './setup.sh' });
	});

	test('isAbsoluteSetupScriptPath matches the binary per-OS tests', () => {
		assert.strictEqual(isAbsoluteSetupScriptPath('/x/y.sh', false), true);
		assert.strictEqual(isAbsoluteSetupScriptPath('rel/y.sh', false), false);
		assert.strictEqual(isAbsoluteSetupScriptPath('C:\\x\\y.ps1', true), true);
		assert.strictEqual(isAbsoluteSetupScriptPath('C:/x/y.ps1', true), true);
		assert.strictEqual(isAbsoluteSetupScriptPath('\\\\server\\share\\y.ps1', true), true);
		assert.strictEqual(isAbsoluteSetupScriptPath('rel\\y.ps1', true), false);
	});

	test('escaping matches FWn / BWn', () => {
		assert.strictEqual(escapeSetupSingleQuotes('a\'b'), 'a\'\\\'\'b');
		assert.strictEqual(escapeSetupWindows('a`b"c'), 'a``b`"c');
	});

	test('buildUnixCommandsScript is the verbatim c4x template', () => {
		const got = buildUnixCommandsScript('/wt', '/root', ['npm ci']);
		const expected =
			'cd \'/wt\' || { printf \'%s\\n\' \'[worktree-setup] ERROR: Failed to cd to worktree directory\'; exit 1; } && ' +
			'export ROOT_WORKTREE_PATH=\'/root\' && set -- \'/wt\' && printf \'%s\\n\' \'[worktree-setup] Working directory: \'$(pwd) && ' +
			'printf \'%s\\n\' \'[worktree-setup] [0] $ npm ci\' && npm ci && printf \'%s\\n\' \'[worktree-setup] [0] done\'';
		assert.strictEqual(got, expected);
	});

	test('buildWindowsCommandsScript is the verbatim u4x template', () => {
		const got = buildWindowsCommandsScript('C:\\wt', 'C:\\root', ['npm ci']);
		const expected =
			`$ErrorActionPreference = 'Stop'; Set-Location -LiteralPath "C:\\wt"; $env:ROOT_WORKTREE_PATH = "C:\\root"; ` +
			`Write-Host '[worktree-setup] Working directory: ' (Get-Location); ` +
			`Write-Host "[worktree-setup] [0] $ npm ci"; npm ci; if ($LASTEXITCODE -ne $null -and $LASTEXITCODE -ne 0) { Write-Host "[worktree-setup] [0] failed with exit code $LASTEXITCODE"; exit $LASTEXITCODE } else { Write-Host "[worktree-setup] [0] done" }`;
		assert.strictEqual(got, expected);
	});

	test('buildUnixScriptFileScript is the verbatim d4x template', () => {
		const got = buildUnixScriptFileScript('/wt', '/root', '/root/.cursor/setup.sh');
		const expected =
			'cd \'/wt\' || { printf \'%s\\n\' \'[worktree-setup] ERROR: Failed to cd to worktree directory\'; exit 1; } && ' +
			'export ROOT_WORKTREE_PATH=\'/root\' && printf \'%s\\n\' \'[worktree-setup] Executing setup script: /root/.cursor/setup.sh\' && ' +
			'bash \'/root/.cursor/setup.sh\' \'/wt\'';
		assert.strictEqual(got, expected);
	});

	test('buildWindowsScriptFileScript is the verbatim h4x template', () => {
		const got = buildWindowsScriptFileScript('C:\\wt', 'C:\\root', 'C:\\root\\.cursor\\setup.ps1');
		const expected = `$ErrorActionPreference = 'Stop'; Set-Location -LiteralPath "C:\\wt"; $env:ROOT_WORKTREE_PATH = "C:\\root"; & "C:\\root\\.cursor\\setup.ps1" "C:\\wt"`;
		assert.strictEqual(got, expected);
	});
});
