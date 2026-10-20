/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import type {
	IAgentMemoryPressureReport,
	IAgentProcessInfo,
} from '../../common/agentSystemPressure.js';
import {
	AgentPressureToastCoordinator,
	agentProcessMonitorConfigsEqual,
	compareAgentProcesses,
	createHeavyLoadNotificationDescriptor,
	filterKilledProcesses,
	formatProcessMemoryMB,
	nextProcessSort,
	normalizeAgentProcessMonitorConfig,
	processCommandLine,
	resolveProcessDisplayName,
	RESET_IN_APP_AD_VIEWS_COMMAND_ID,
	RESET_IN_APP_AD_VIEWS_ERROR_MESSAGE,
	RESET_IN_APP_AD_VIEWS_KEYWORDS,
	RESET_IN_APP_AD_VIEWS_SUCCESS_MESSAGE,
	RESET_IN_APP_AD_VIEWS_TITLE,
	sortAgentProcesses,
} from '../../common/agentSystemPressure.js';

/**
 * DEV-GAPS-58 — `glass-system-pressure-commands` (Cursor 3.25.9 glass bundle).
 *
 * Every expectation below is transcribed from the reference binary
 * (reference/cursor-3.25.9/.../workbench.glass.main.js):
 *  - command ids/labels + notification shape: Rzb() @44593400
 *  - notification ids: lm table @25576950
 *  - storage key: @44593912
 *  - config normalizer hux() + equality pux(): @44592100-44592960
 *  - modal formatters fwC()/gwC() + comparator vwC() + header/sort rules +
 *    trigger hook mux(): @30157000-@30163100, @44593000-@44594800
 */
suite('agentSystemPressure (DEV-GAPS-58)', () => {

	const proc = (over: Partial<IAgentProcessInfo>): IAgentProcessInfo => ({
		pid: 1, name: 'node', memoryMB: 100, cpuUtilPct: 10, ...over,
	});

	suite('normalizeAgentProcessMonitorConfig (hux)', () => {
		test('empty payload yields the verbatim defaults, monitor disabled', () => {
			const cfg = normalizeAgentProcessMonitorConfig(undefined);
			assert.deepStrictEqual(cfg, {
				monitorEnabled: false,
				lowMemorySustainedSec: 30,
				minAgentProcessAgeSec: 0,
				lowMemoryAvailablePct: 10,
				lowMemoryAvailableAbsGb: 3,
				cpuHighPct: 90,
				cpuHighSustainedSec: 30,
				minReportedCpuPct: 5,
			});
		});

		test('monitor_enabled is true only for literal true', () => {
			assert.strictEqual(normalizeAgentProcessMonitorConfig({ monitor_enabled: true }).monitorEnabled, true);
			assert.strictEqual(normalizeAgentProcessMonitorConfig({ monitor_enabled: 1 }).monitorEnabled, false);
			assert.strictEqual(normalizeAgentProcessMonitorConfig({ monitor_enabled: 'true' }).monitorEnabled, false);
		});

		test('values are clamped to the binary ranges', () => {
			const cfg = normalizeAgentProcessMonitorConfig({
				low_memory_sustained_sec: 99999,
				min_agent_process_age_sec: -5,
				low_memory_available_pct: 250,
				low_memory_available_abs_gb: 100,
				cpu_high_pct: -1,
				cpu_high_sustained_sec: 0,
				min_reported_cpu_pct: 55,
			});
			assert.strictEqual(cfg.lowMemorySustainedSec, 3600);
			assert.strictEqual(cfg.minAgentProcessAgeSec, 0);
			assert.strictEqual(cfg.lowMemoryAvailablePct, 100);
			assert.strictEqual(cfg.lowMemoryAvailableAbsGb, 64);
			assert.strictEqual(cfg.cpuHighPct, 0);
			assert.strictEqual(cfg.cpuHighSustainedSec, 1);
			assert.strictEqual(cfg.minReportedCpuPct, 55);
		});

		test('non-finite / non-number values fall back to defaults', () => {
			const cfg = normalizeAgentProcessMonitorConfig({
				low_memory_sustained_sec: '15',
				cpu_high_pct: Number.NaN,
				cpu_high_sustained_sec: Number.POSITIVE_INFINITY,
			});
			assert.strictEqual(cfg.lowMemorySustainedSec, 30);
			assert.strictEqual(cfg.cpuHighPct, 90);
			assert.strictEqual(cfg.cpuHighSustainedSec, 30);
		});
	});

	suite('agentProcessMonitorConfigsEqual (pux)', () => {
		test('same reference and equal fields are equal; missing side is not', () => {
			const a = normalizeAgentProcessMonitorConfig({});
			assert.strictEqual(agentProcessMonitorConfigsEqual(a, a), true);
			assert.strictEqual(agentProcessMonitorConfigsEqual(a, { ...a }), true);
			assert.strictEqual(agentProcessMonitorConfigsEqual(a, undefined), false);
			assert.strictEqual(agentProcessMonitorConfigsEqual(undefined, a), false);
			assert.strictEqual(agentProcessMonitorConfigsEqual(undefined, undefined), true);
		});

		test('any single field difference breaks equality', () => {
			const a = normalizeAgentProcessMonitorConfig({});
			for (const key of Object.keys(a) as (keyof typeof a)[]) {
				const b = { ...a, [key]: typeof a[key] === 'boolean' ? !a[key] : (a[key] as number) + 1 };
				assert.strictEqual(agentProcessMonitorConfigsEqual(a, b), false, `field ${key}`);
			}
		});
	});

	suite('modal formatters (fwC / gwC / de)', () => {
		test('formatProcessMemoryMB', () => {
			assert.strictEqual(formatProcessMemoryMB(0), '0 MB');
			assert.strictEqual(formatProcessMemoryMB(512.4), '512 MB');
			assert.strictEqual(formatProcessMemoryMB(1023.9), '1024 MB');
			assert.strictEqual(formatProcessMemoryMB(1024), '1.0 GB');
			assert.strictEqual(formatProcessMemoryMB(1536), '1.5 GB');
		});

		test('processCommandLine appends args only when present', () => {
			assert.strictEqual(processCommandLine(proc({ name: 'node' })), 'node');
			assert.strictEqual(processCommandLine(proc({ name: 'node', args: 'server.js --watch' })), 'node server.js --watch');
		});

		test('resolveProcessDisplayName prefixes the trimmed agent name', () => {
			assert.strictEqual(resolveProcessDisplayName(proc({ name: 'build' }), 'Agent A'), 'Agent A - build');
			assert.strictEqual(resolveProcessDisplayName(proc({ name: 'build' }), '  Agent A  '), 'Agent A - build');
			assert.strictEqual(resolveProcessDisplayName(proc({ name: 'build' }), undefined), 'build');
			assert.strictEqual(resolveProcessDisplayName(proc({ name: 'build' }), ''), 'build');
		});
	});

	suite('compareAgentProcesses / sortAgentProcesses (vwC)', () => {
		const nameOf = (p: IAgentProcessInfo) => p.name;

		test('process sorts case-insensitively by display name', () => {
			const a = proc({ pid: 1, name: 'beta' });
			const b = proc({ pid: 2, name: 'Alpha' });
			assert.ok(compareAgentProcesses(a, b, 'process', 'asc', nameOf) > 0);
			assert.ok(compareAgentProcesses(a, b, 'process', 'desc', nameOf) < 0);
		});

		test('memory and cpu sort numerically, direction flips the sign', () => {
			const a = proc({ pid: 1, memoryMB: 200, cpuUtilPct: 5 });
			const b = proc({ pid: 2, memoryMB: 50, cpuUtilPct: 80 });
			assert.ok(compareAgentProcesses(a, b, 'memory', 'desc', nameOf) < 0);
			assert.ok(compareAgentProcesses(a, b, 'memory', 'asc', nameOf) > 0);
			assert.ok(compareAgentProcesses(a, b, 'cpu', 'asc', nameOf) < 0);
			assert.ok(compareAgentProcesses(a, b, 'cpu', 'desc', nameOf) > 0);
		});

		test('sortAgentProcesses returns a sorted copy, input untouched', () => {
			const input = [proc({ pid: 1, memoryMB: 10 }), proc({ pid: 2, memoryMB: 900 }), proc({ pid: 3, memoryMB: 40 })];
			const sorted = sortAgentProcesses(input, 'memory', 'desc', nameOf);
			assert.deepStrictEqual(sorted.map(p => p.pid), [2, 3, 1]);
			assert.deepStrictEqual(input.map(p => p.pid), [1, 2, 3]);
		});
	});

	suite('nextProcessSort (header handler)', () => {
		test('clicking the active column toggles direction', () => {
			assert.deepStrictEqual(
				nextProcessSort({ key: 'memory', direction: 'desc' }, 'memory'),
				{ key: 'memory', direction: 'asc' });
			assert.deepStrictEqual(
				nextProcessSort({ key: 'memory', direction: 'asc' }, 'memory'),
				{ key: 'memory', direction: 'desc' });
		});

		test('switching columns: process resets to asc, others to desc', () => {
			assert.deepStrictEqual(
				nextProcessSort({ key: 'cpu', direction: 'desc' }, 'process'),
				{ key: 'process', direction: 'asc' });
			assert.deepStrictEqual(
				nextProcessSort({ key: 'process', direction: 'asc' }, 'cpu'),
				{ key: 'cpu', direction: 'desc' });
		});
	});

	suite('filterKilledProcesses', () => {
		test('killed pids are dropped', () => {
			const rows = [proc({ pid: 1 }), proc({ pid: 2 }), proc({ pid: 3 })];
			assert.deepStrictEqual(filterKilledProcesses(rows, new Set([2])).map(p => p.pid), [1, 3]);
			assert.deepStrictEqual(filterKilledProcesses(rows, new Set()).map(p => p.pid), [1, 2, 3]);
		});
	});

	suite('AgentPressureToastCoordinator (mux trigger hook)', () => {
		const report = (over: Partial<IAgentMemoryPressureReport> = {}): IAgentMemoryPressureReport => ({
			processes: [proc({})],
			isEpisodeStart: true,
			...over,
		});
		const env = (over: Partial<{ modalOpen: boolean; windowFocused: boolean; dontShowAgain: boolean }> = {}) => ({
			modalOpen: false, windowFocused: true, dontShowAgain: false, ...over,
		});

		test('episode start + focused + not opted out shows the toast immediately', () => {
			const c = new AgentPressureToastCoordinator();
			assert.deepStrictEqual(c.onReport(report(), env()), { kind: 'showToast', deferredUntilFocus: false });
		});

		test('empty report never shows and never updates the modal', () => {
			const c = new AgentPressureToastCoordinator();
			assert.deepStrictEqual(c.onReport(report({ processes: [] }), env()), { kind: 'none' });
			assert.deepStrictEqual(c.onReport(report({ processes: [] }), env({ modalOpen: true })), { kind: 'none' });
		});

		test('open modal is updated instead of toasted, even mid-episode', () => {
			const c = new AgentPressureToastCoordinator();
			assert.deepStrictEqual(c.onReport(report({ isEpisodeStart: false }), env({ modalOpen: true })), { kind: 'updateModal' });
		});

		test('non-episode-start report without an open modal does nothing', () => {
			const c = new AgentPressureToastCoordinator();
			assert.deepStrictEqual(c.onReport(report({ isEpisodeStart: false }), env()), { kind: 'none' });
		});

		test('dontShowAgain suppresses the toast', () => {
			const c = new AgentPressureToastCoordinator();
			assert.deepStrictEqual(c.onReport(report(), env({ dontShowAgain: true })), { kind: 'none' });
		});

		test('unfocused window defers; focus regain shows with deferredUntilFocus=true', () => {
			const c = new AgentPressureToastCoordinator();
			assert.deepStrictEqual(c.onReport(report(), env({ windowFocused: false })), { kind: 'deferUntilFocus' });
			assert.strictEqual(c.isDeferred(), true);
			// A second report while deferred is swallowed (c.current is set).
			assert.deepStrictEqual(c.onReport(report(), env({ windowFocused: false })), { kind: 'none' });
			assert.deepStrictEqual(c.onFocusChanged(false, false), { kind: 'none' });
			assert.deepStrictEqual(c.onFocusChanged(true, false), { kind: 'showToast', deferredUntilFocus: true });
			assert.strictEqual(c.isDeferred(), false);
		});

		test('opting out while deferred suppresses the deferred toast', () => {
			const c = new AgentPressureToastCoordinator();
			c.onReport(report(), env({ windowFocused: false }));
			assert.deepStrictEqual(c.onFocusChanged(true, true), { kind: 'none' });
			assert.strictEqual(c.isDeferred(), false);
		});

		test('latest report is always stored for the modal', () => {
			const c = new AgentPressureToastCoordinator();
			const r = report();
			c.onReport(r, env());
			assert.strictEqual(c.getLatestReport(), r);
		});

		test('an empty report does not overwrite the stored latest report (binary stores u.current inside the non-empty branch)', () => {
			const c = new AgentPressureToastCoordinator();
			const r = report();
			c.onReport(r, env());
			c.onReport(report({ processes: [] }), env());
			assert.strictEqual(c.getLatestReport(), r);
		});
	});

	suite('createHeavyLoadNotificationDescriptor (Rzb)', () => {
		test('matches the verbatim binary notification', () => {
			const d = createHeavyLoadNotificationDescriptor();
			assert.strictEqual(d.id, 'glass.agent-heavy-load');
			assert.strictEqual(d.severity, 'warning');
			assert.strictEqual(d.priority, 'urgent');
			assert.strictEqual(d.sticky, true);
			assert.strictEqual(d.closeNotificationOnToastDismiss, true);
			assert.strictEqual(d.message, 'Agent starting expensive processes');
			assert.strictEqual(d.toastDescription, 'Manage the processes started by your agent to keep your computer responsive.');
			assert.deepStrictEqual(d.actions.primary, [
				{ id: 'cursor.agentSystemPressure.manageProcesses', label: 'Manage Processes' },
				{ id: 'cursor.agentSystemPressure.dontShowAgain', label: "Don't show again" },
			]);
		});
	});

	suite('cursor.resetInAppAdViews (DEV-GAPS-64/W64A)', () => {
		// Binary (workbench.glass.main.js 3.25.9 @45359415):
		//   Ir({id:"cursor.resetInAppAdViews",title:"Reset In-App Ad Views",
		//     icon:"discard",glassCategory:"Developer",
		//     keywords:["ads","in-app","reset","views","devtools"],f1:!0, ...})
		test('command id, title and keywords are verbatim', () => {
			assert.strictEqual(RESET_IN_APP_AD_VIEWS_COMMAND_ID, 'cursor.resetInAppAdViews');
			assert.strictEqual(RESET_IN_APP_AD_VIEWS_TITLE, 'Reset In-App Ad Views');
			assert.deepStrictEqual([...RESET_IN_APP_AD_VIEWS_KEYWORDS], ['ads', 'in-app', 'reset', 'views', 'devtools']);
		});

		test('notification strings are the binary verbatim messages', () => {
			assert.strictEqual(RESET_IN_APP_AD_VIEWS_SUCCESS_MESSAGE, 'Successfully reset in-app ad views. Ads will show again.');
			assert.strictEqual(RESET_IN_APP_AD_VIEWS_ERROR_MESSAGE, 'Error resetting in-app ad views.');
		});
	});
});
