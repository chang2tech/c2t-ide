/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: ENGINE PACKAGING — tests for the workbench D2 engine-path
// resolver (electron-browser/enginePath.ts; spec engine-packaging-spec-v1
// §5). Pins: setting > bundled (serve entry must exist) > dev fallback,
// where the dev fallback is allowed ONLY when no bundled directory
// exists on disk — a bundled dir without its entry is "bundled
// incomplete" (source "none"), never a silent fall-through to the dev
// checkout. Also pins bunPath (bundled bin/bun > PATH), the BRANCH-B
// spawn cwd (bundled → <userDataPath>/engine-runtime), and the shared
// constants against the spec layout (`resources/app/engine`).

import assert from 'assert';
import * as path from 'node:path';
import { INativeEnvironmentService } from '../../../../../platform/environment/common/environment.js';
import {
	BUNDLED_BUN_RELATIVE,
	BUNDLED_ENGINE_DIR_NAME,
	bundledEnginePathFromAppRoot,
	defaultEnginePath,
} from '../../common/composerDataService.js';
import {
	ENGINE_CLI_ENTRY_REL,
	bundledIncompleteDiagnostic,
	resolveBunPath,
	resolveEnginePath,
	resolveEngineSpawnCwd,
} from '../../electron-browser/enginePath.js';

const APP_ROOT = path.join(path.sep, 'fake', 'resources', 'app');
const USER_DATA = path.join(path.sep, 'fake', 'userData');
const BUNDLED = path.join(APP_ROOT, 'engine');
const BUNDLED_ENTRY = path.join(BUNDLED, ENGINE_CLI_ENTRY_REL);
const BUNDLED_BUN = path.join(BUNDLED, BUNDLED_BUN_RELATIVE);

function fakeEnv(): INativeEnvironmentService {
	return { appRoot: APP_ROOT, userDataPath: USER_DATA } as unknown as INativeEnvironmentService;
}

function existsSet(...paths: string[]): (p: string) => boolean {
	const set = new Set(paths);
	return (p) => set.has(p);
}

suite('enginePath resolver (D2)', () => {

	test('spec layout constants: engine dir name + bundled path from appRoot', () => {
		assert.strictEqual(BUNDLED_ENGINE_DIR_NAME, 'engine');
		assert.strictEqual(bundledEnginePathFromAppRoot(APP_ROOT), BUNDLED);
		assert.strictEqual(bundledEnginePathFromAppRoot(''), '');
	});

	test('setting wins over a present bundled engine', () => {
		const resolved = resolveEnginePath('/custom/engine', fakeEnv(), existsSet(BUNDLED, BUNDLED_ENTRY));
		assert.strictEqual(resolved.source, 'setting');
		assert.strictEqual(resolved.enginePath, '/custom/engine');
	});

	test('bundled engine with serve entry resolves as bundled', () => {
		const resolved = resolveEnginePath('', fakeEnv(), existsSet(BUNDLED, BUNDLED_ENTRY));
		assert.strictEqual(resolved.source, 'bundled');
		assert.strictEqual(resolved.enginePath, BUNDLED);
	});

	test('bundled dir without entry is bundled-incomplete — NO dev fall-through', () => {
		const resolved = resolveEnginePath('', fakeEnv(), existsSet(BUNDLED));
		assert.strictEqual(resolved.source, 'none');
		assert.strictEqual(resolved.enginePath, '');
		assert.strictEqual(resolved.bundledBroken, BUNDLED);
		assert.match(bundledIncompleteDiagnostic(BUNDLED), /Bundled engine is incomplete/);
	});

	test('no bundled dir on disk falls back to the dev checkout', () => {
		const resolved = resolveEnginePath('', fakeEnv(), existsSet());
		assert.strictEqual(resolved.source, 'dev');
		assert.strictEqual(resolved.enginePath, defaultEnginePath());
	});

	test('bunPath: bundled bin/bun wins; missing bundled bun falls back to PATH with report', () => {
		const bundled = { enginePath: BUNDLED, source: 'bundled' as const };
		assert.strictEqual(resolveBunPath(bundled, existsSet(BUNDLED_BUN)), BUNDLED_BUN);
		let reported: string | undefined;
		assert.strictEqual(resolveBunPath(bundled, existsSet(), (c) => (reported = c)), 'bun');
		assert.strictEqual(reported, BUNDLED_BUN);
	});

	test('spawn cwd (BRANCH B): bundled → <userDataPath>/engine-runtime; dev/setting → undefined', () => {
		assert.strictEqual(
			resolveEngineSpawnCwd({ enginePath: BUNDLED, source: 'bundled' }, fakeEnv()),
			path.join(USER_DATA, 'engine-runtime'),
		);
		assert.strictEqual(
			resolveEngineSpawnCwd({ enginePath: '/x', source: 'dev' }, fakeEnv()),
			undefined,
		);
		assert.strictEqual(
			resolveEngineSpawnCwd({ enginePath: '/x', source: 'setting' }, fakeEnv()),
			undefined,
		);
	});
});
