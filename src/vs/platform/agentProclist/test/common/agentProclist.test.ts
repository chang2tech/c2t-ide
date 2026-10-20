/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import type {
	IScannedProcessRow,
} from '../../common/agentProclist.js';
import {
	buildPressureReportProcesses,
	buildProcessTreeSnapshot,
	clampSubsamplePollingRateSec,
	collectAgentProcessCandidates,
	INITIAL_PRESSURE_EPISODE_STATE,
	isExtensionHostSeed,
	isHighCpu,
	isLowMemory,
	planKillAgentProcessTree,
	parseProcStatCpuTimes,
	PROCESS_TREE_SNAPSHOT_LIMIT,
	requiredSustainedSamples,
	stepPressureEpisode,
} from '../../common/agentProclist.js';

/**
 * DEV-GAPS-60 — `cursorProclist` shared-process monitor (Cursor 3.25.6 main
 * bundle). Every expectation below is transcribed from the reference binary
 * (reference/cursor/.../out/main.js, byte offsets re-verified):
 *  - episode machine Lut(): @2203074
 *  - Nut() / Dut() / Dwe(): @2202640 / @2202781 / @2203015
 *  - Uut() / xut() / xwe: @2203653 / @2203747 / @2204121
 *  - evaluateMemoryPressure() method: @2215376
 *  - killAgentProcessTree(): @2218043
 *  - getProcessTreeSnapshot(): @2218845
 *  - applyConfig() clamps: @2213226 (WL=1, zwe=300)
 *  - Out() /proc/stat parser: @2202822
 */
suite('agentProclist (DEV-GAPS-60)', () => {

	const row = (over: Partial<IScannedProcessRow>): IScannedProcessRow => ({
		pid: 1, ppid: 0, name: 'node', argv: ['node'], memoryMB: 100, cpuTimeMs: 0, ...over,
	});

	suite('requiredSustainedSamples (Dwe)', () => {
		test('t<=0 yields 1; otherwise ceil(duration/rate), min 1', () => {
			assert.strictEqual(requiredSustainedSamples(30, 1), 30);
			assert.strictEqual(requiredSustainedSamples(30, 5), 6);
			assert.strictEqual(requiredSustainedSamples(1, 30), 1);
			assert.strictEqual(requiredSustainedSamples(0, 5), 1);
			assert.strictEqual(requiredSustainedSamples(30, 0), 1);
			assert.strictEqual(requiredSustainedSamples(30, -2), 1);
		});
	});

	suite('clampSubsamplePollingRateSec (WL=1, zwe=300)', () => {
		test('clamps to [1,300], non-numbers fall back to 1', () => {
			assert.strictEqual(clampSubsamplePollingRateSec(5), 5);
			assert.strictEqual(clampSubsamplePollingRateSec(0), 1);
			assert.strictEqual(clampSubsamplePollingRateSec(9999), 300);
			assert.strictEqual(clampSubsamplePollingRateSec(undefined), 1);
			assert.strictEqual(clampSubsamplePollingRateSec(Number.NaN), 1);
		});
	});

	suite('isLowMemory (Nut)', () => {
		const cfg = {
			monitorEnabled: true, lowMemorySustainedSec: 30, minAgentProcessAgeSec: 0,
			lowMemoryAvailablePct: 10, lowMemoryAvailableAbsGb: 3, cpuHighPct: 90,
			cpuHighSustainedSec: 30, minReportedCpuPct: 5,
		};
		test('pressureLevel branch wins when present', () => {
			assert.strictEqual(isLowMemory({ availPct: 50, availGb: 20, totalGb: 40, pressureLevel: 2 }, cfg), true);
			assert.strictEqual(isLowMemory({ availPct: 50, availGb: 20, totalGb: 40, pressureLevel: 1 }, cfg), false);
		});
		test('pct or gb below threshold', () => {
			assert.strictEqual(isLowMemory({ availPct: 9, availGb: 10, totalGb: 40 }, cfg), true);
			assert.strictEqual(isLowMemory({ availPct: 50, availGb: 2.9, totalGb: 40 }, cfg), true);
			assert.strictEqual(isLowMemory({ availPct: 50, availGb: 10, totalGb: 40 }, cfg), false);
			// boundary is exclusive: `e.availPct<t.lowMemoryAvailablePct`
			assert.strictEqual(isLowMemory({ availPct: 10, availGb: 10, totalGb: 40 }, cfg), false);
		});
	});

	suite('isHighCpu (Dut)', () => {
		test('e>=t.cpuHighPct', () => {
			assert.strictEqual(isHighCpu(90, { cpuHighPct: 90 } as never), true);
			assert.strictEqual(isHighCpu(89.9, { cpuHighPct: 90 } as never), false);
		});
	});

	suite('stepPressureEpisode (Lut)', () => {
		test('episode starts after the required consecutive pressure samples', () => {
			let s = INITIAL_PRESSURE_EPISODE_STATE;
			let step = stepPressureEpisode(s, true, 3);
			assert.deepStrictEqual(step, { state: { episodeActive: false, consecutiveLowSamples: 1, consecutiveHealthySamples: 0 }, emitReport: false, isEpisodeStart: false });
			step = stepPressureEpisode(step.state, true, 3);
			assert.strictEqual(step.emitReport, false);
			step = stepPressureEpisode(step.state, true, 3);
			assert.deepStrictEqual(step, { state: { episodeActive: true, consecutiveLowSamples: 3, consecutiveHealthySamples: 0 }, emitReport: true, isEpisodeStart: true });
		});

		test('healthy sample resets the low streak before activation', () => {
			const step = stepPressureEpisode({ episodeActive: false, consecutiveLowSamples: 2, consecutiveHealthySamples: 0 }, false, 3);
			assert.deepStrictEqual(step.state, { episodeActive: false, consecutiveLowSamples: 0, consecutiveHealthySamples: 1 });
			assert.strictEqual(step.emitReport, false);
		});

		test('episode keeps emitting until enough consecutive healthy samples', () => {
			let step = stepPressureEpisode({ episodeActive: true, consecutiveLowSamples: 0, consecutiveHealthySamples: 0 }, false, 2);
			assert.strictEqual(step.state.episodeActive, true);
			assert.strictEqual(step.emitReport, true);
			assert.strictEqual(step.isEpisodeStart, false);
			step = stepPressureEpisode(step.state, false, 2);
			assert.strictEqual(step.state.episodeActive, false);
			assert.strictEqual(step.emitReport, false);
		});

		test('a pressure sample mid-episode keeps the streak but is not an episode start', () => {
			const step = stepPressureEpisode({ episodeActive: true, consecutiveLowSamples: 0, consecutiveHealthySamples: 1 }, true, 2);
			assert.deepStrictEqual(step.state, { episodeActive: true, consecutiveLowSamples: 1, consecutiveHealthySamples: 0 });
			assert.strictEqual(step.emitReport, true);
			assert.strictEqual(step.isEpisodeStart, false);
		});
	});

	suite('parseProcStatCpuTimes (Out)', () => {
		test('parses idle=4th, total=user+nice+sys+idle+6th', () => {
			const t = parseProcStatCpuTimes('cpu  100 20 30 400 50 60 70\n');
			assert.deepStrictEqual(t, { idle: 400, total: 100 + 20 + 30 + 400 + 60 });
		});
		test('malformed input yields undefined', () => {
			assert.strictEqual(parseProcStatCpuTimes(''), undefined);
			assert.strictEqual(parseProcStatCpuTimes('cpu\n'), undefined);
			assert.strictEqual(parseProcStatCpuTimes('cpu 1 2 3 4 5\n'), undefined);
			assert.strictEqual(parseProcStatCpuTimes('cpu a b c d e f\n'), undefined);
		});
	});

	suite('isExtensionHostSeed (Uut)', () => {
		test('name starts with extensionHost and title lacks (user)', () => {
			assert.strictEqual(isExtensionHostSeed({ name: 'extensionHost', processTitle: '' }), true);
			assert.strictEqual(isExtensionHostSeed({ name: 'extensionHost', processTitle: 'extensionHost (user)' }), false);
			assert.strictEqual(isExtensionHostSeed({ name: 'node', processTitle: '' }), false);
		});
	});

	suite('collectAgentProcessCandidates (xut)', () => {
		test('collects BFS descendants of seeds, skipping xwe names, deduped', () => {
			const rows = [
				row({ pid: 10, ppid: 1, name: 'extensionHost' }),
				row({ pid: 11, ppid: 10, name: 'node' }),
				row({ pid: 12, ppid: 11, name: 'bash' }),
				row({ pid: 13, ppid: 1, name: 'code' }),            // sibling subtree, no seed
				row({ pid: 14, ppid: 10, name: 'Cursor Helper' }),  // matches xwe -> skipped; its subtree is NOT traversed (continue before push)
				row({ pid: 15, ppid: 14, name: 'node' }),
			];
			const c = collectAgentProcessCandidates(rows, new Set([10]));
			// Binary xut pushes only the seed's CHILDREN (seeds themselves are
			// not re-added): 14 'Cursor Helper' matches xwe and its subtree
			// (15) is not traversed; 13 is in an unseeded subtree.
			const pids = [...c.keys()].sort((a, b) => a - b);
			assert.deepStrictEqual(pids, [11, 12]);
			assert.strictEqual(c.get(11)?.name, 'node');
		});

		test('empty seeds yield nothing', () => {
			const c = collectAgentProcessCandidates([row({ pid: 10, ppid: 1, name: 'node' })], new Set());
			assert.strictEqual(c.size, 0);
		});
	});

	suite('buildPressureReportProcesses (evaluateMemoryPressure emit branch)', () => {
		const monitored = {
			monitorEnabled: true, lowMemorySustainedSec: 30, minAgentProcessAgeSec: 0,
			lowMemoryAvailablePct: 10, lowMemoryAvailableAbsGb: 3, cpuHighPct: 90,
			cpuHighSustainedSec: 30, minReportedCpuPct: 5,
		};
		const candidates = new Map<number, IScannedProcessRow>([
			[101, row({ pid: 101, name: 'node', argv: ['node', 'server.js', '--watch'] })],
			[102, row({ pid: 102, name: 'bash', argv: ['bash'] })],
			[103, row({ pid: 103, name: 'idle', argv: [] })],
			[104, row({ pid: 104, name: 'young', argv: ['young'] })],
		]);
		const memoryByPid = new Map([[101, 900], [102, 100], [103, 50], [104, 80]]);
		const cpuByPid = new Map([[101, 80], [102, 60], [103, 1], [104, 70]]);
		const observed = new Map([[101, 5], [102, 5], [103, 5], [104, 1]]);
		test('age and min-cpu filters apply; sorted desc by cpu', () => {
			const procs = buildPressureReportProcesses(candidates, memoryByPid, cpuByPid, observed, 3, monitored.minReportedCpuPct);
			assert.deepStrictEqual(procs.map(p => p.pid), [101, 102]);
			assert.deepStrictEqual(procs[0], {
				pid: 101, name: 'node', memoryMB: 900, cpuUtilPct: 80,
				observedSamples: 5, args: 'server.js --watch', ownerAgentId: '',
			});
			assert.strictEqual(procs[1].args, '');
		});
		test('unobserved processes are always dropped', () => {
			const procs = buildPressureReportProcesses(candidates, memoryByPid, cpuByPid, new Map(), 1, monitored.minReportedCpuPct);
			assert.strictEqual(procs.length, 0);
		});
	});

	suite('buildProcessTreeSnapshot', () => {
		test('sorts by memory desc and caps at the limit', () => {
			const rows = [1, 2, 3].map(i => row({ pid: i, name: `p${i}`, memoryMB: i * 100 }));
			const snapshot = buildProcessTreeSnapshot(rows, new Map(), 2);
			assert.deepStrictEqual(snapshot.map(p => p.pid), [3, 2]);
			assert.strictEqual(PROCESS_TREE_SNAPSHOT_LIMIT, 50);
		});
		test('defaults to the 50-row binary cap', () => {
			const rows = Array.from({ length: 70 }, (_, i) => row({ pid: i + 1, memoryMB: i }));
			assert.strictEqual(buildProcessTreeSnapshot(rows, new Map()).length, 50);
		});
	});

	suite('planKillAgentProcessTree', () => {
		test('returns root-first DFS order; undefined for non-candidates', () => {
			const candidates = new Map<number, IScannedProcessRow>([
				[1, row({ pid: 1, ppid: 0, name: 'root' })],
				[2, row({ pid: 2, ppid: 1, name: 'child-a' })],
				[3, row({ pid: 3, ppid: 1, name: 'child-b' })],
				[4, row({ pid: 4, ppid: 2, name: 'grandchild' })],
				[9, row({ pid: 9, ppid: 0, name: 'other' })],
			]);
			const ordered = planKillAgentProcessTree(candidates, 1)!;
			assert.strictEqual(ordered[0], 1);
			assert.deepStrictEqual(new Set(ordered), new Set([1, 2, 3, 4]));
			// child-a (2) is visited before its subtree completes in stack order
			assert.ok(ordered.indexOf(2) < ordered.indexOf(4));
			assert.strictEqual(planKillAgentProcessTree(candidates, 999), undefined);
		});
	});
});
