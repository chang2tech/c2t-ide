/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Agent process monitor (Cursor parity, r2m-001a / r2m-001b /
// glass-system-pressure-commands).
//
// This is the platform/node layer for the shared-process `cursorProclist` monitor.
// Binary evidence (Cursor 3.25.6, reference/cursor/.../out/main.js — the same build
// family as 3.25.9 which the matrix cites; identifiers verified byte-identical):
//   - @2203468-2203576: DI id Q("cursorProclistService") @2203520, channel
//     name Owe="cursorProclist" @2203468, episode state
//     GE={episodeActive:false, consecutiveLowSamples:0,
//     consecutiveHealthySamples:0} @2203576.
//   - Nut() @2202640: low-memory predicate `e.pressureLevel!==void 0 ?
//     e.pressureLevel>=2 : e.availPct<t.lowMemoryAvailablePct ||
//     e.availGb<t.lowMemoryAvailableAbsGb`.
//   - Dut() @2202781: high-cpu predicate `e>=t.cpuHighPct`.
//   - Out() @2202822: /proc/stat parser `/^cpu\s+(.+)$/m`, idle=4th field,
//     total=user+nice+sys+idle+6th field.
//   - Dwe() @2203015: sustained-sample math `t<=0?1:Math.max(1,Math.ceil(e/t))`.
//   - Lut() @2203074: episode state machine (verbatim semantics transcribed in
//     stepPressureEpisode()).
//   - Uut() @2203653: `e.name.startsWith("extensionHost") &&
//     !e.processTitle.includes("(user)")`.
//   - xut() @2203747: BFS descendant collection over the ppid map, skipping
//     xwe matches (transcribed in collectAgentProcessCandidates()).
//   - xwe @2204121: /(cursor|electron)[^/\\]* helper|^(cursor( dev| nightly| lab)?|
//     code( - insiders)?|electron)(\.exe)?$|(^|[/\\])(cursor( dev| nightly| lab)?|
//     code( - insiders)?|electron)\.app[/\\]contents[/\\]|[/\\]\.build[/\\]electron[/\\]/i
//   - applyConfig() @2213226: platform must be darwin/linux/win32, config ignored
//     otherwise; `localEnabled===false` stops polling; subsample rate clamped
//     Math.max(WL, Math.min(zwe, e.subsamplePollingRateSec)) with WL=1, zwe=300.
//   - evaluateMemoryPressure() @2215376: resets the episode when disabled;
//     reports fire {memory, processes, isEpisodeStart} through
//     _onAgentMemoryPressureReport (listen name "onAgentMemoryPressureReport"
//     @2207808; also served @2228025 in the IPC class).
//   - killAgentProcessTree() @2218043: refuses non-current candidates
//     (returns whether the pid already exited), SIGTERMs the whole descendant
//     tree, returns whether the root signal succeeded.
//   - getProcessTreeSnapshot() @2218845: top 50 rows (Ywe=50 @2207551) by memoryMB.
//   - Jwe (cursorProclistIpc.js) @2228172: channel switch — listen
//     "onAgentMemoryPressureReport"; call "applyConfig" / "createSample" /
//     "writeSample" / "readProcessMonitorData" / "getLiveNetworkBytesPerSec" /
//     "killAgentProcessTree" / "getProcessTreeSnapshot" /
//     "getCpuProcessTreeSnapshot" / "getSystemProcessList" / stash+take pending
//     uploads. This fork implements the three pressure methods plus the event;
//     the sample/telemetry pipeline (createSample/writeSample/...) belongs to
//     Cursor's backend reporting and is intentionally not reproduced — see
//     HONEST-DIVERGENCE in agentProclistChannel.ts.
//   - Glass client (workbench.glass.main.js @47480648, 3.25.9): the channel
//     client registers under "cursorProclist" with methods applyConfig,
//     killAgentProcessTree({pid, name}), getProcessTreeSnapshot — the renderer
//     side of this fork (workbench/contrib/agentSystemPressure) mirrors that.
//
// Layer: Cursor hosts this in the main process behind the native
// `cursor-proclist` N-API module. This fork hosts it in the shared process
// (where the existing workbench client service looks for it) with a pure-Node
// scanner — the native module is Cursor-proprietary and is not reproduced.
// The pure functions below are intentionally node-free so they can be unit
// tested without Electron.

import type { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

/** IPC channel name (binary: Owe="cursorProclist"). */
export const PROCLIST_CHANNEL_NAME = 'cursorProclist';

/** Service id (binary: xL=Q("cursorProclistService")). */
export const PROCLIST_SERVICE_ID = 'cursorProclistService';

/** IPC event name carrying pressure reports. */
export const AGENT_MEMORY_PRESSURE_REPORT_EVENT = 'onAgentMemoryPressureReport';

/** IPC method names (binary: Jwe call switch). */
export const APPLY_MONITOR_CONFIG_METHOD = 'applyConfig';
export const KILL_AGENT_PROCESS_TREE_METHOD = 'killAgentProcessTree';
export const GET_PROCESS_TREE_SNAPSHOT_METHOD = 'getProcessTreeSnapshot';

/** Min/max subsample polling rate in seconds (binary: WL=1, zwe=300). */
export const MIN_SUBSAMPLE_POLLING_RATE_SEC = 1;
export const MAX_SUBSAMPLE_POLLING_RATE_SEC = 300;

/** Process-tree snapshot row cap (binary: Ywe=50). */
export const PROCESS_TREE_SNAPSHOT_LIMIT = 50;

export const IAgentProclistService = createDecorator<IAgentProclistService>(PROCLIST_SERVICE_ID);

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** Monitor thresholds; identical fields to the renderer's IAgentProcessMonitorConfig. */
export interface IAgentProcessMonitorConfig {
	readonly monitorEnabled: boolean;
	readonly lowMemorySustainedSec: number;
	readonly minAgentProcessAgeSec: number;
	readonly lowMemoryAvailablePct: number;
	readonly lowMemoryAvailableAbsGb: number;
	readonly cpuHighPct: number;
	readonly cpuHighSustainedSec: number;
	readonly minReportedCpuPct: number;
}

/**
 * applyConfig payload. The binary main-side consumer reads localEnabled,
 * subsamplePollingRateSec and agentMemoryPressureMonitor off this object
 * (the extra sample/network fields are handled by Cursor's telemetry
 * pipeline and are optional here).
 */
export interface IAgentProclistApplyConfig {
	readonly localEnabled: boolean;
	readonly subsamplePollingRateSec: number;
	readonly agentMemoryPressureMonitor?: IAgentProcessMonitorConfig;
	readonly networkDiagnosticsReportingEnabled?: boolean;
}

/** One scanned OS process row (binary: numeric tuple array). */
export interface IScannedProcessRow {
	readonly pid: number;
	readonly ppid: number;
	readonly name: string;
	readonly argv: readonly string[];
	/** Resident memory in megabytes. */
	readonly memoryMB: number;
	/** Cumulative CPU time in milliseconds (utime+stime). */
	readonly cpuTimeMs: number;
}

/** System memory sample (binary: readSystemMemory()). */
export interface ISystemMemorySample {
	/** Available memory as a percentage of total. */
	readonly availPct: number;
	/** Available memory in GiB. */
	readonly availGb: number;
	/** Total memory in GiB. */
	readonly totalGb: number;
	/** Native-module pressure level; undefined when unknown. */
	readonly pressureLevel?: number;
}

/** System CPU sample (binary: readCpuTimes() -> {idle, total}). */
export interface ISystemCpuTimes {
	readonly idle: number;
	readonly total: number;
}

/** Agent-owned process in a pressure report (binary fields). */
export interface IAgentPressureProcess {
	readonly pid: number;
	readonly name: string;
	readonly memoryMB: number;
	readonly cpuUtilPct: number;
	readonly observedSamples: number;
	readonly args: string;
	readonly ownerAgentId: string;
}

/** Payload of `onAgentMemoryPressureReport` (binary: {memory, processes, isEpisodeStart}). */
export interface IAgentMemoryPressureReportPayload {
	readonly memory: ISystemMemorySample;
	readonly processes: readonly IAgentPressureProcess[];
	readonly isEpisodeStart: boolean;
}

export interface IAgentProclistService {
	readonly _serviceBrand: undefined;

	/** Fires whenever the monitor reports agent system pressure. */
	readonly onAgentMemoryPressureReport: Event<IAgentMemoryPressureReportPayload>;

	/** Applies monitor thresholds (binary: `applyConfig`). */
	applyConfig(config: IAgentProclistApplyConfig): Promise<void>;

	/**
	 * Kills an agent process tree (binary: `killAgentProcessTree({pid, name})`).
	 * Resolves to true when the tree was killed, false otherwise.
	 */
	killAgentProcessTree(pid: number, name: string): Promise<boolean>;

	/** Returns the top-50 process rows by memory (binary: `getProcessTreeSnapshot`). */
	getProcessTreeSnapshot(): Promise<readonly IAgentPressureProcess[]>;
}

// ---------------------------------------------------------------------------
// Verbatim binary helpers
// ---------------------------------------------------------------------------

/**
 * Sustained-sample math — Dwe(e,t): `t<=0?1:Math.max(1,Math.ceil(e/t))`.
 * Converts a "sustained for X seconds" threshold into a required consecutive
 * sample count given the subsample polling rate.
 */
export function requiredSustainedSamples(durationSec: number, subsampleRateSec: number): number {
	return subsampleRateSec <= 0 ? 1 : Math.max(1, Math.ceil(durationSec / subsampleRateSec));
}

/**
 * Clamps the subsample polling rate (binary: Math.max(WL, Math.min(zwe, e.subsamplePollingRateSec))).
 *
 * Fork divergence (deliberate, safe): the binary passes `undefined`/NaN
 * straight through (Math.min(300, undefined) = NaN), which would schedule a
 * NaN-interval timer. The fork clamps non-numbers to WL=1 instead — Cursor's
 * client always sends a real number, so this path only protects the fork
 * against malformed config.
 */
export function clampSubsamplePollingRateSec(rateSec: unknown): number {
	const n = typeof rateSec === 'number' && Number.isFinite(rateSec) ? rateSec : MIN_SUBSAMPLE_POLLING_RATE_SEC;
	return Math.max(MIN_SUBSAMPLE_POLLING_RATE_SEC, Math.min(MAX_SUBSAMPLE_POLLING_RATE_SEC, n));
}

/**
 * Low-memory predicate — Nut(e,t):
 * `e.pressureLevel!==void 0 ? e.pressureLevel>=2 :
 *  e.availPct<t.lowMemoryAvailablePct || e.availGb<t.lowMemoryAvailableAbsGb`.
 */
export function isLowMemory(sample: ISystemMemorySample, config: IAgentProcessMonitorConfig): boolean {
	if (sample.pressureLevel !== undefined) {
		return sample.pressureLevel >= 2;
	}
	return sample.availPct < config.lowMemoryAvailablePct || sample.availGb < config.lowMemoryAvailableAbsGb;
}

/**
 * High-CPU predicate — Dut(e,t): `e>=t.cpuHighPct`.
 */
export function isHighCpu(systemCpuUtilPct: number, config: IAgentProcessMonitorConfig): boolean {
	return systemCpuUtilPct >= config.cpuHighPct;
}

// ---------------------------------------------------------------------------
// Episode state machine — verbatim transcription of Lut(e,t,n)
// ---------------------------------------------------------------------------

export interface IPressureEpisodeState {
	readonly episodeActive: boolean;
	readonly consecutiveLowSamples: number;
	readonly consecutiveHealthySamples: number;
}

/** Initial episode state (binary: GE={episodeActive:!1, consecutiveLowSamples:0, consecutiveHealthySamples:0}). */
export const INITIAL_PRESSURE_EPISODE_STATE: IPressureEpisodeState = {
	episodeActive: false,
	consecutiveLowSamples: 0,
	consecutiveHealthySamples: 0,
};

export interface IPressureEpisodeStep {
	readonly state: IPressureEpisodeState;
	readonly emitReport: boolean;
	readonly isEpisodeStart: boolean;
}

/**
 * Verbatim transcription of Lut(e,t,n):
 *
 *   const r = t ? e.consecutiveLowSamples+1 : 0,
 *         s = t ? 0 : e.consecutiveHealthySamples+1;
 *   if (e.episodeActive) {
 *     const a = s < n;
 *     return { state: { episodeActive: a, consecutiveLowSamples: r, consecutiveHealthySamples: s },
 *              emitReport: a, isEpisodeStart: !1 };
 *   }
 *   const i = r >= n;
 *   return { state: { episodeActive: i, consecutiveLowSamples: r, consecutiveHealthySamples: s },
 *            emitReport: i, isEpisodeStart: i };
 *
 * NOTE: in the binary the pressure flag `t` is the *CPU-high* flag (Dut) and `n`
 * is the sustained sample count for cpuHighSustainedSec — the memory-low flag
 * (Nut) is computed and logged but does not drive the episode in this build.
 */
export function stepPressureEpisode(
	state: IPressureEpisodeState,
	pressure: boolean,
	requiredConsecutiveSamples: number
): IPressureEpisodeStep {
	const consecutiveLowSamples = pressure ? state.consecutiveLowSamples + 1 : 0;
	const consecutiveHealthySamples = pressure ? 0 : state.consecutiveHealthySamples + 1;
	if (state.episodeActive) {
		const stillActive = consecutiveHealthySamples < requiredConsecutiveSamples;
		return {
			state: {
				episodeActive: stillActive,
				consecutiveLowSamples,
				consecutiveHealthySamples,
			},
			emitReport: stillActive,
			isEpisodeStart: false,
		};
	}
	const becomesActive = consecutiveLowSamples >= requiredConsecutiveSamples;
	return {
		state: {
			episodeActive: becomesActive,
			consecutiveLowSamples,
			consecutiveHealthySamples,
		},
		emitReport: becomesActive,
		isEpisodeStart: becomesActive,
	};
}

// ---------------------------------------------------------------------------
// Agent process classification — verbatim transcription of xwe / Uut / xut
// ---------------------------------------------------------------------------

/**
 * Application-process name regex (binary: xwe) — such rows are never agent
 * candidates: the host/electron helpers and the app bundle itself.
 */
export const APP_PROCESS_NAME_REGEX =
	/(cursor|electron)[^/\\]* helper|^(cursor( dev| nightly| lab)?|code( - insiders)?|electron)(\.exe)?$|(^|[/\\])(cursor( dev| nightly| lab)?|code( - insiders)?|electron)\.app[/\\]contents[/\\]|[/\\]\.build[/\\]electron[/\\]/i;

/**
 * Extension-host utility-process seed predicate — Uut(e):
 * `e.name.startsWith("extensionHost") && !e.processTitle.includes("(user)")`.
 */
export function isExtensionHostSeed(candidate: { readonly name: string; readonly processTitle: string }): boolean {
	return candidate.name.startsWith('extensionHost') && !candidate.processTitle.includes('(user)');
}

/**
 * Agent-process candidate collection — xut(e,t):
 *
 *   const n=new Map; for(const i of e){ let a=n.get(i.ppid); a||(a=[],n.set(i.ppid,a)); a.push(i) }
 *   const r=new Map, s=[]; for(const i of t) s.push(...n.get(i)??[]);
 *   for(;s.length>0;){ const i=s.pop();
 *     if(r.has(i.pid)||xwe.test(i.name)) continue;
 *     r.set(i.pid,i); const a=n.get(i.pid); a&&s.push(...a) }
 *   return r
 *
 * BFS over the ppid->children map from the seed pids, skipping rows whose name
 * matches the app-process regex, de-duplicating by pid.
 */
export function collectAgentProcessCandidates(
	processes: readonly IScannedProcessRow[],
	seedPids: ReadonlySet<number>
): Map<number, IScannedProcessRow> {
	const byParent = new Map<number, IScannedProcessRow[]>();
	for (const row of processes) {
		let children = byParent.get(row.ppid);
		if (!children) {
			children = [];
			byParent.set(row.ppid, children);
		}
		children.push(row);
	}
	const result = new Map<number, IScannedProcessRow>();
	const stack: IScannedProcessRow[] = [];
	for (const seedPid of seedPids) {
		stack.push(...(byParent.get(seedPid) ?? []));
	}
	while (stack.length > 0) {
		const row = stack.pop()!;
		if (result.has(row.pid) || APP_PROCESS_NAME_REGEX.test(row.name)) {
			continue;
		}
		result.set(row.pid, row);
		const children = byParent.get(row.pid);
		if (children) {
			stack.push(...children);
		}
	}
	return result;
}

// ---------------------------------------------------------------------------
// Report assembly — verbatim transcription of the emit branch in
// evaluateMemoryPressure()
// ---------------------------------------------------------------------------

/**
 * Builds the report process list exactly as the binary does:
 *
 *   const u=Dwe(n.minAgentProcessAgeSec,o), m=new Map, f=new Map, v=new Map;
 *   for(const k of e){ m.set(k[0],k[5]); v.set(k[0],k[7]||"");
 *     const y=k[6]; f.set(k[0], Array.isArray(y)?y.slice(1).join(" "):"") }
 *   const T=[];
 *   for(const [k,y] of t){
 *     const b=this.agentProcessObservedSamples.get(k)??0;
 *     if(b<u) continue;
 *     const I=m.get(k)??0, B=this.processTrackers.get(k)?.latestCpuUtilPct??0;
 *     B<n.minReportedCpuPct || T.push({pid:k,name:y.name,memoryMB:I,cpuUtilPct:B,
 *        observedSamples:b,args:f.get(k)??"",ownerAgentId:v.get(k)??""}) }
 *   T.sort((k,y)=>y.cpuUtilPct-k.cpuUtilPct);
 */
export function buildPressureReportProcesses(
	candidates: ReadonlyMap<number, IScannedProcessRow>,
	memoryByPid: ReadonlyMap<number, number>,
	cpuByPid: ReadonlyMap<number, number>,
	observedSamplesByPid: ReadonlyMap<number, number>,
	minObservedSamples: number,
	minReportedCpuPct: number
): IAgentPressureProcess[] {
	const processes: IAgentPressureProcess[] = [];
	for (const [pid, row] of candidates) {
		const observedSamples = observedSamplesByPid.get(pid) ?? 0;
		if (observedSamples < minObservedSamples) {
			continue;
		}
		const cpuUtilPct = cpuByPid.get(pid) ?? 0;
		if (cpuUtilPct >= minReportedCpuPct) {
			processes.push({
				pid,
				name: row.name,
				memoryMB: memoryByPid.get(pid) ?? 0,
				cpuUtilPct,
				observedSamples,
				args: row.argv.length > 1 ? row.argv.slice(1).join(' ') : '',
				ownerAgentId: '',
			});
		}
	}
	processes.sort((a, b) => b.cpuUtilPct - a.cpuUtilPct);
	return processes;
}

/**
 * Process-tree snapshot — getProcessTreeSnapshot():
 * rows {pid,name,memoryMB,cpuUtilPct,observedSamples:0,args,ownerAgentId:""},
 * sorted by memoryMB desc, capped at 50.
 */
export function buildProcessTreeSnapshot(
	rows: readonly IScannedProcessRow[],
	cpuByPid: ReadonlyMap<number, number>,
	limit: number = PROCESS_TREE_SNAPSHOT_LIMIT
): IAgentPressureProcess[] {
	const snapshot = rows.map(row => ({
		pid: row.pid,
		name: row.name,
		memoryMB: row.memoryMB,
		cpuUtilPct: cpuByPid.get(row.pid) ?? 0,
		observedSamples: 0,
		args: row.argv.length > 1 ? row.argv.slice(1).join(' ') : '',
		ownerAgentId: '',
	}));
	snapshot.sort((a, b) => b.memoryMB - a.memoryMB);
	return snapshot.slice(0, limit);
}

/**
 * Kill-plan — the descendant traversal in killAgentProcessTree():
 *
 *   const r=new Map;
 *   for(const u of this.latestAgentProcessCandidates.values()){
 *     let m=r.get(u.ppid); m||(m=[],r.set(u.ppid,m)); m.push(u.pid) }
 *   const s=[], i=[e];
 *   for(;i.length>0;){ const u=i.pop(); s.push(u); i.push(...r.get(u)??[]) }
 *
 * Returns the pids in SIGTERM order (root first, then descendants DFS),
 * or undefined when the root pid is not a current candidate.
 */
export function planKillAgentProcessTree(
	candidates: ReadonlyMap<number, IScannedProcessRow>,
	rootPid: number
): readonly number[] | undefined {
	if (!candidates.has(rootPid)) {
		return undefined;
	}
	const childrenByParent = new Map<number, number[]>();
	for (const row of candidates.values()) {
		let children = childrenByParent.get(row.ppid);
		if (!children) {
			children = [];
			childrenByParent.set(row.ppid, children);
		}
		children.push(row.pid);
	}
	const ordered: number[] = [];
	const stack: number[] = [rootPid];
	while (stack.length > 0) {
		const pid = stack.pop()!;
		ordered.push(pid);
		stack.push(...(childrenByParent.get(pid) ?? []));
	}
	return ordered;
}

/**
 * /proc/stat CPU line parser — Out(e):
 * `/^cpu\s+(.+)$/m.exec(e)?.[1].trim().split(/\s+/).map(Number)`;
 * idle=4th, total=user+nice+sys+idle+6th. Returns undefined on malformed input.
 */
export function parseProcStatCpuTimes(statContent: string): ISystemCpuTimes | undefined {
	const match = /^cpu\s+(.+)$/m.exec(statContent);
	const fields = match?.[1].trim().split(/\s+/).map(Number);
	if (!fields || fields.length < 6 || fields.some(v => !Number.isFinite(v))) {
		return undefined;
	}
	const [user, nice, sys, idle, , irq] = fields;
	return { idle, total: user + nice + sys + idle + irq };
}
