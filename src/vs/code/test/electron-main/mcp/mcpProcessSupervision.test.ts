/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
	MCP_RESTART_BACKOFF_BASE_MS,
	MCP_RESTART_BUDGET_EXPIRED_LOG,
	MCP_RESTART_BUDGET_WINDOW_MS,
	McpProcessRestartBudget,
	isMcpRestartBudgetWindowExpired,
	mcpProcessSupervisionDefaults,
	planMcpProcessRestart,
} from '../../../electron-main/mcp/mcpProcessSupervision.js';

// Binary-verified Cursor 3.25.6 / 3.25.9 values (out/main.js):
//   Tf = { restartMaxPer10Min: 5, restartBackoffCapMs: 6e4, coldStartTimeoutMs: 6e4 }
//   kf = 600 * 1e3 (restart-budget window, 10 min)
suite('McpProcessSupervision (main-process supervisor constants & restart budget)', () => {

	suite('constants — verbatim Cursor values', () => {

		test('default config matches Cursor verbatim (5 restarts / 60s backoff cap / 60s cold start)', () => {
			assert.strictEqual(mcpProcessSupervisionDefaults.restartMaxPer10Min, 5);
			assert.strictEqual(mcpProcessSupervisionDefaults.restartBackoffCapMs, 60_000);
			assert.strictEqual(mcpProcessSupervisionDefaults.coldStartTimeoutMs, 60_000);
		});

		test('restart-budget window is 10 minutes (kf = 600 * 1e3)', () => {
			assert.strictEqual(MCP_RESTART_BUDGET_WINDOW_MS, 600_000);
		});

		test('backoff base step is 1s (exponential 2^(n-1) * 1e3)', () => {
			assert.strictEqual(MCP_RESTART_BACKOFF_BASE_MS, 1_000);
		});

		test('give-up expiry log line is verbatim Cursor', () => {
			assert.strictEqual(
				MCP_RESTART_BUDGET_EXPIRED_LOG,
				'[McpProcess] restart-budget window expired since give-up; allowing a fresh start attempt'
			);
		});
	});

	suite('planMcpProcessRestart — faithful port of Cursor Uet', () => {

		test('first restart backs off 1s', () => {
			const plan = planMcpProcessRestart([], 1_000_000);
			assert.strictEqual(plan.restartAfterMs, 1_000);
			assert.deepStrictEqual(plan.recentTimestampsMs, [1_000_000]);
		});

		test('exponential backoff 1s, 2s, 4s, 8s, 16s within the 10-min window', () => {
			const budget = new McpProcessRestartBudget();
			const expected = [1_000, 2_000, 4_000, 8_000, 16_000];
			for (let i = 0; i < expected.length; i++) {
				const plan = budget.planRestart(1_000_000 + i * 10_000);
				assert.strictEqual(plan.restartAfterMs, expected[i], `restart #${i + 1}`);
			}
		});

		test('6th restart within 10 minutes gives up (restartAfterMs: null)', () => {
			const budget = new McpProcessRestartBudget();
			for (let i = 0; i < 5; i++) {
				assert.notStrictEqual(budget.planRestart(1_000_000 + i * 10_000).restartAfterMs, null);
			}
			const plan = budget.planRestart(1_000_000 + 5 * 10_000);
			assert.strictEqual(plan.restartAfterMs, null);
			assert.strictEqual(budget.gaveUpAtMs, 1_000_000 + 5 * 10_000);
		});

		test('backoff is capped at restartBackoffCapMs (60s)', () => {
			const config = { restartMaxPer10Min: 10, restartBackoffCapMs: 60_000, coldStartTimeoutMs: 60_000 };
			// 7th restart: 2^6 * 1s = 64s -> capped to 60s
			let timestamps: number[] = [];
			for (let i = 0; i < 6; i++) {
				timestamps = planMcpProcessRestart(timestamps, 1_000_000 + i * 10_000, config).recentTimestampsMs;
			}
			const plan = planMcpProcessRestart(timestamps, 1_000_000 + 6 * 10_000, config);
			assert.strictEqual(plan.restartAfterMs, 60_000);
		});

		test('restart timestamps older than 10 minutes fall out of the budget', () => {
			const budget = new McpProcessRestartBudget();
			for (let i = 0; i < 5; i++) {
				budget.planRestart(i * 1_000); // 5 rapid restarts
			}
			// 6th restart, but 10+ minutes after the first: old timestamps evicted -> allowed again at 1s
			const plan = budget.planRestart(700_000);
			assert.strictEqual(plan.restartAfterMs, 1_000);
		});
	});

	suite('give-up expiry — faithful port of Cursor Let + maybeResetExpiredGiveUp', () => {

		test('window expires strictly after 10 minutes', () => {
			assert.strictEqual(isMcpRestartBudgetWindowExpired(0, 600_000), false);
			assert.strictEqual(isMcpRestartBudgetWindowExpired(0, 600_001), true);
		});

		test('no-op when the supervisor never gave up', () => {
			const budget = new McpProcessRestartBudget();
			let logged = '';
			assert.strictEqual(budget.maybeResetExpiredGiveUp(10_000_000, m => logged = m), false);
			assert.strictEqual(logged, '');
		});

		test('give-up persists until the 10-minute window expires', () => {
			const budget = new McpProcessRestartBudget();
			for (let i = 0; i < 6; i++) {
				budget.planRestart(1_000_000 + i * 10_000);
			}
			assert.notStrictEqual(budget.gaveUpAtMs, undefined);
			let logged = '';
			assert.strictEqual(budget.maybeResetExpiredGiveUp(1_050_000, m => logged = m), false);
			assert.notStrictEqual(budget.gaveUpAtMs, undefined);
			assert.strictEqual(logged, '');
		});

		test('give-up resets after the window expires, emitting the verbatim log line', () => {
			const budget = new McpProcessRestartBudget();
			for (let i = 0; i < 6; i++) {
				budget.planRestart(1_000_000 + i * 10_000);
			}
			const gaveUpAt = budget.gaveUpAtMs!;
			let logged = '';
			assert.strictEqual(budget.maybeResetExpiredGiveUp(gaveUpAt + 600_001, m => logged = m), true);
			assert.strictEqual(budget.gaveUpAtMs, undefined);
			assert.strictEqual(logged, '[McpProcess] restart-budget window expired since give-up; allowing a fresh start attempt');
			// a fresh start attempt is now allowed again
			assert.strictEqual(budget.planRestart(gaveUpAt + 600_002).restartAfterMs, 1_000);
		});
	});

	suite('layer rule — constants live ONLY in the main process', () => {

		/**
		 * Binary-verified layer rule (Cursor 3.25.6 + 3.25.9):
		 * `out/main.js` (main-process supervisor) defines
		 * `Tf={restartMaxPer10Min:5,restartBackoffCapMs:6e4,coldStartTimeoutMs:6e4}` and
		 * `kf=600*1e3`; `out/vs/code/electron-utility/mcpProcess/mcpProcessMain.js`
		 * (the mcpProcess utility process) has 0 hits for `restartMaxPer10Min` /
		 * `restartBackoffCapMs` — it only reads `runtimeConfig.coldStartTimeoutMs`
		 * passed in from main.
		 *
		 * This test is a regression guard: if a future change duplicates the
		 * supervision constants into the fork's electron-utility layer
		 * (the utility-process side), it fails.
		 */
		test('no supervision constants leak into the electron-utility layer (src or compiled out)', () => {
			const repoRoot = findVscodeRepoRoot();
			const violations: string[] = [];
			for (const tree of ['src/vs/code/electron-utility', 'out/vs/code/electron-utility']) {
				const dir = path.join(repoRoot, tree);
				if (!fs.existsSync(dir)) {
					continue;
				}
				for (const file of collectSourceFiles(dir)) {
					const text = fs.readFileSync(file, 'utf8');
					if (text.includes('restartMaxPer10Min') || text.includes('restartBackoffCapMs')) {
						violations.push(path.relative(repoRoot, file));
					}
				}
			}
			assert.deepStrictEqual(
				violations,
				[],
				'supervision constants (restartMaxPer10Min/restartBackoffCapMs) must live only in the main process, but were found in the utility-process layer'
			);
		});

		test('supervision module itself lives in the main-process tree (electron-main)', () => {
			const repoRoot = findVscodeRepoRoot();
			const modulePath = path.join(repoRoot, 'src/vs/code/electron-main/mcp/mcpProcessSupervision.ts');
			assert.ok(
				fs.existsSync(modulePath),
				`expected the supervision module at ${path.relative(repoRoot, modulePath)}`
			);
		});
	});
});

/**
 * Locates the vscode repo root so the layer test works on the source tree
 * (`src/...`) and on the compiled tree (`out/...`, as used by scripts/test.sh).
 * Honours VSCODE_REPO_ROOT when set.
 */
function findVscodeRepoRoot(): string {
	const markers = [
		'src/vs/code/electron-main/mcp/mcpProcessSupervision.ts',
		'out/vs/code/electron-main/mcp/mcpProcessSupervision.js',
	];
	const override = process.env['VSCODE_REPO_ROOT'];
	if (override) {
		for (const marker of markers) {
			if (fs.existsSync(path.join(override, marker))) {
				return override;
			}
		}
	}
	for (const start of [__dirname, process.cwd()]) {
		let dir = start;
		for (let i = 0; i < 12; i++) {
			if (markers.some(marker => fs.existsSync(path.join(dir, marker)))) {
				return dir;
			}
			const parent = path.dirname(dir);
			if (parent === dir) {
				break;
			}
			dir = parent;
		}
	}
	throw new Error('layer test: could not locate the vscode repo root (set VSCODE_REPO_ROOT)');
}

function collectSourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...collectSourceFiles(full));
		} else if (entry.isFile() && /\.(ts|js|mjs|cjs)$/.test(entry.name)) {
			out.push(full);
		}
	}
	return out;
}
