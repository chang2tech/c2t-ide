/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Agent process monitor service — Cursor parity (r2m-001a / r2m-001b).
//
// Runs in the shared process behind the `cursorProclist` channel. Verbatim
// transcription of the CursorProclistService class in
// reference/cursor/.../out/main.js (Cursor 3.25.6, same identifiers in 3.25.9):
//   - constructor(@ILogService, @ILoggerService, @IEnvironmentService)
//   - loadNativeModule(): darwin/linux/win32 else disabled; failure -> trace and
//     nativeModule=undefined. Fork equivalent: no N-API module exists; scanning
//     is implemented in pure Node — see HONEST-DIVERGENCE below.
//   - applyConfig(e): unsupported platform or missing native -> trace,
//     currentConfig=e, return. `localEnabled===false` -> stopTimer. Otherwise
//     clamp subsample rate to [1,300] and startAsyncPolling(t*1000).
//   - scanTick(): skips when a scan is already in flight; awaits
//     cursor_proclist_scan_async(); then recordSubsample(t),
//     updateAgentProcessCandidates(t), evaluateMemoryPressure(t,n).
//   - readSystemMemory(): os totalmem/freemem; native override when available;
//     linux falls back to parsing /proc/meminfo MemAvailable.
//   - readSystemCpu()/readCpuTimes(): linux via /proc/stat (Out parser), else
//     the os.cpus() aggregate — both verbatim formulas from the binary.
//   - evaluateMemoryPressure(e,t): disabled -> reset episode state and return;
//     otherwise memory-low + cpu-high predicates, Lut episode machine,
//     emit {memory, processes, isEpisodeStart} through
//     _onAgentMemoryPressureReport. NOTE the binary drives the episode off the
//     CPU-high flag only (the Nut result is logged, not latched) — transcribed
//     faithfully in stepPressureEpisode().
//   - updateAgentProcessCandidates(e): seeds from the utility-process info
//     provider via Uut; per-pid observed-sample counters; drops pids that
//     vanished.
//   - signalProcess(e,t): process.kill wrapper returning
//     "signaled"|"exited"|"failed" (ESRCH -> "exited").
//   - killAgentProcessTree(e,t): refuses non-current candidates (returns
//     whether the pid already exited), SIGTERMs the descendant tree built from
//     the candidate ppid map, returns whether the root kill succeeded.
//   - getProcessTreeSnapshot(): fresh scan, top-50 by memory, [] while a scan
//     is in flight.
//
// HONEST-DIVERGENCE:
//   - Cursor scans processes through the proprietary `cursor-proclist` N-API
//     module (per-process CPU times, tagged agent owner ids). This fork has no
//     such module; scanning is pure Node: /proc on Linux (identical fields),
//     `ps -axo` on macOS, and disabled on win32 (matches Cursor's
//     "unsupported platform" branch). Owner agent ids cannot be tagged without
//     the native module, so ownerAgentId is always "" and the modal shows the
//     plain process names (the binary prefixes the agent display name when it
//     knows it).
//   - Cursor classifies agent processes as descendants of the agent extension
//     host utility process (Uut over Electron utility-process info). The
//     shared process cannot see utility-process titles, so seeds are detected
//     from /proc cmdlines containing `--type=extensionHost`; the same BFS +
//     xwe exclusions apply.
//   - The telemetry sample pipeline (createSample/writeSample/appendSampleToFile,
//     network volumes, pending-upload stashing) is Cursor-cloud bookkeeping and
//     is not reproduced; only the pressure-monitor path is implemented.
//   - Cursor hosts this in the main process; this fork hosts it in the shared
//     process because the existing workbench client
//     (workbench/contrib/agentSystemPressure) already targets the shared-process
//     `cursorProclist` channel — the wire contract is byte-identical either way.

import { execFile } from 'child_process';
import { readFileSync } from 'fs';
import { freemem, totalmem, cpus } from 'os';
import { readFile, readdir } from 'fs/promises';
import { Disposable } from '../../../base/common/lifecycle.js';
import { Emitter } from '../../../base/common/event.js';
import { isLinux, isMacintosh, isWindows } from '../../../base/common/platform.js';
import { ILogService } from '../../log/common/log.js';
import {
	buildPressureReportProcesses,
	buildProcessTreeSnapshot,
	clampSubsamplePollingRateSec,
	IAgentMemoryPressureReportPayload,
	IAgentPressureProcess,
	IAgentProclistApplyConfig,
	IAgentProclistService,
	INITIAL_PRESSURE_EPISODE_STATE,
	IPressureEpisodeState,
	IScannedProcessRow,
	ISystemCpuTimes,
	ISystemMemorySample,
	isExtensionHostSeed,
	isHighCpu,
	isLowMemory,
	planKillAgentProcessTree,
	parseProcStatCpuTimes,
	requiredSustainedSamples,
	stepPressureEpisode,
	collectAgentProcessCandidates,
} from '../common/agentProclist.js';

/** Linux clock ticks per second (USER_HZ on x86/arm Linux). */
const LINUX_CLK_TCK = 100;

/** Default polling interval in seconds when the client does not provide one. */
const DEFAULT_SUBSAMPLE_POLLING_RATE_SEC = 5;

interface IProcessTracker {
	readonly pid: number;
	latestCpuUtilPct: number;
	cpuTimeMsBaseline?: number;
	lastCpuTimeMs?: number;
	lastSampleTimeMs?: number;
}

export class AgentProclistService extends Disposable implements IAgentProclistService {

	declare readonly _serviceBrand: undefined;

	private readonly _onAgentMemoryPressureReport = this._register(new Emitter<IAgentMemoryPressureReportPayload>());
	readonly onAgentMemoryPressureReport = this._onAgentMemoryPressureReport.event;

	private updateTimer: ReturnType<typeof setInterval> | undefined;
	private isScanning = false;
	private currentConfig: IAgentProclistApplyConfig | undefined;
	private subsampleRateSec = DEFAULT_SUBSAMPLE_POLLING_RATE_SEC;

	private readonly agentProcessObservedSamples = new Map<number, number>();
	private latestAgentProcessCandidates = new Map<number, IScannedProcessRow>();
	private episodeState: IPressureEpisodeState = INITIAL_PRESSURE_EPISODE_STATE;
	private episodeStartPending = false;

	private readonly processTrackers = new Map<number, IProcessTracker>();
	private previousCpuTimes: ISystemCpuTimes | undefined;
	private lastSampleStartMs: number | undefined;
	private lastScanRows: IScannedProcessRow[] = [];

	constructor(
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	// ------------------------------------------------------------------
	// IAgentProclistService
	// ------------------------------------------------------------------

	applyConfig(config: IAgentProclistApplyConfig): Promise<void> {
		if (!this.isScanSupported()) {
			this.logService.trace('[AgentProclistService] Config ignored: feature unavailable on this platform');
			this.currentConfig = config;
			return Promise.resolve();
		}
		this.currentConfig = config;
		if (!config.localEnabled) {
			this.logService.info('[AgentProclistService] Config disabled local collection');
			this.stopTimer();
			return Promise.resolve();
		}
		const rateSec = clampSubsamplePollingRateSec(config.subsamplePollingRateSec ?? DEFAULT_SUBSAMPLE_POLLING_RATE_SEC);
		const monitorEnabled = config.agentMemoryPressureMonitor?.monitorEnabled === true;
		this.logService.info(`[AgentProclistService] Config enabled feature (subsample every ${rateSec}s; memoryPressureMonitorEnabled=${monitorEnabled})`);
		this.stopTimer();
		this.subsampleRateSec = rateSec;
		this.startAsyncPolling(rateSec * 1000);
		return Promise.resolve();
	}

	killAgentProcessTree(pid: number, name: string): Promise<boolean> {
		return Promise.resolve(this.killAgentProcessTreeSync(pid, name));
	}

	/** Returns the top-50 process rows by memory (binary: `getProcessTreeSnapshot`). */
	async getProcessTreeSnapshot(): Promise<readonly IAgentPressureProcess[]> {
		if (!this.isScanSupported()) {
			return [];
		}
		if (this.isScanning) {
			return [];
		}
		this.isScanning = true;
		try {
			const rows = await this.scanProcesses();
			const cpuByPid = new Map<number, number>();
			for (const tracker of this.processTrackers.values()) {
				cpuByPid.set(tracker.pid, tracker.latestCpuUtilPct);
			}
			return buildProcessTreeSnapshot(rows, cpuByPid);
		} catch (error) {
			this.logService.warn('[AgentProclistService] Process tree snapshot failed:', error);
			return [];
		} finally {
			this.isScanning = false;
		}
	}

	override dispose(): void {
		this.stopTimer();
		super.dispose();
	}

	// ------------------------------------------------------------------
	// Polling
	// ------------------------------------------------------------------

	private isScanSupported(): boolean {
		// Binary: native module only on darwin/linux/win32. The pure-Node scanner
		// below only covers linux (/proc) and macOS (ps); win32 logs the
		// unsupported-platform branch like the binary.
		return isLinux || isMacintosh;
	}

	private startAsyncPolling(intervalMs: number): void {
		void this.scanTick();
		this.updateTimer = setInterval(() => void this.scanTick(), intervalMs);
	}

	private stopTimer(): void {
		if (this.updateTimer !== undefined) {
			clearInterval(this.updateTimer);
			this.updateTimer = undefined;
		}
		this.processTrackers.clear();
		this.agentProcessObservedSamples.clear();
		this.latestAgentProcessCandidates = new Map();
		this.episodeState = INITIAL_PRESSURE_EPISODE_STATE;
		this.episodeStartPending = false;
		this.previousCpuTimes = undefined;
		this.lastSampleStartMs = undefined;
	}

	private async scanTick(): Promise<void> {
		if (this.isScanning || !this.isScanSupported()) {
			return;
		}
		this.isScanning = true;
		try {
			const rows = await this.scanProcesses();
			this.lastScanRows = rows;
			this.recordSubsample(rows);
			const candidates = this.updateAgentProcessCandidates(rows);
			this.evaluateMemoryPressure(rows, candidates);
		} catch (error) {
			this.logService.error('[AgentProclistService] Async scan failed:', error);
		} finally {
			this.isScanning = false;
		}
	}

	/**
	 * Transcription of recordSubsample(): maintains per-pid CPU-util trackers.
	 * CPU util = delta(cumulative cpu time) / delta(wall time) * 100, matching
	 * the binary formula `Math.max(0,u-I.lastCpuMsForUtil)/x*100`.
	 */
	private recordSubsample(rows: readonly IScannedProcessRow[]): void {
		const now = Date.now();
		for (const row of rows) {
			let tracker = this.processTrackers.get(row.pid);
			if (!tracker) {
				tracker = { pid: row.pid, latestCpuUtilPct: 0 };
				this.processTrackers.set(row.pid, tracker);
			}
			let util = 0;
			if (tracker.lastSampleTimeMs !== undefined && tracker.lastCpuTimeMs !== undefined) {
				const elapsed = now - tracker.lastSampleTimeMs;
				if (elapsed > 0) {
					util = Math.max(0, row.cpuTimeMs - tracker.lastCpuTimeMs) / elapsed * 100;
				}
			}
			tracker.latestCpuUtilPct = util;
			tracker.lastSampleTimeMs = now;
			tracker.lastCpuTimeMs = row.cpuTimeMs;
			tracker.cpuTimeMsBaseline ??= row.cpuTimeMs;
		}
	}

	// ------------------------------------------------------------------
	// Memory-pressure evaluation — verbatim transcription of
	// evaluateMemoryPressure(e,t)
	// ------------------------------------------------------------------

	private updateAgentProcessCandidates(rows: readonly IScannedProcessRow[]): Map<number, IScannedProcessRow> {
		if (this.currentConfig?.localEnabled !== true
			|| this.currentConfig.agentMemoryPressureMonitor?.monitorEnabled !== true) {
			this.agentProcessObservedSamples.clear();
			this.latestAgentProcessCandidates = new Map();
			return new Map();
		}
		try {
			const seedPids = new Set<number>();
			for (const row of rows) {
				// Fork divergence (see header): seeds are detected from /proc
				// cmdlines containing `--type=extensionHost` and fed through the
				// verbatim Uut predicate with an empty process title.
				const seedName = row.argv.some(arg => arg === '--type=extensionHost') ? 'extensionHost' : row.name;
				if (isExtensionHostSeed({ name: seedName, processTitle: '' })) {
					seedPids.add(row.pid);
				}
			}
			const candidates = collectAgentProcessCandidates(rows, seedPids);
			for (const pid of Array.from(this.agentProcessObservedSamples.keys())) {
				if (!candidates.has(pid)) {
					this.agentProcessObservedSamples.delete(pid);
				}
			}
			for (const pid of candidates.keys()) {
				this.agentProcessObservedSamples.set(pid, (this.agentProcessObservedSamples.get(pid) ?? 0) + 1);
			}
			this.latestAgentProcessCandidates = candidates;
			return candidates;
		} catch (error) {
			this.logService.warn('[AgentProclistService] Agent process classification failed:', error);
			return new Map();
		}
	}

	private evaluateMemoryPressure(
		rows: readonly IScannedProcessRow[],
		candidates: ReadonlyMap<number, IScannedProcessRow>
	): void {
		const monitor = this.currentConfig?.agentMemoryPressureMonitor;
		if (this.currentConfig?.localEnabled !== true || monitor?.monitorEnabled !== true) {
			this.episodeState = INITIAL_PRESSURE_EPISODE_STATE;
			this.episodeStartPending = false;
			this.previousCpuTimes = undefined;
			return;
		}
		try {
			const memory = this.readSystemMemory();
			const memLow = isLowMemory(memory, monitor);
			const systemCpuPct = this.readSystemCpu();
			const cpuHigh = isHighCpu(systemCpuPct, monitor);
			const rateSec = this.subsampleRateSec;
			const required = requiredSustainedSamples(monitor.cpuHighSustainedSec, rateSec);
			const step = stepPressureEpisode(this.episodeState, cpuHigh, required);
			this.episodeState = step.state;
			if (step.isEpisodeStart) {
				this.episodeStartPending = true;
			} else if (!step.state.episodeActive) {
				this.episodeStartPending = false;
			}
			this.logService.trace(
				`[AgentProclistService] System sample: cpu=${systemCpuPct.toFixed(1)}% high=${cpuHigh} ` +
				`mem=${memory.availPct.toFixed(1)}% memLow=${memLow} ` +
				`episodeActive=${step.state.episodeActive} ` +
				`cpuStreak=${step.state.consecutiveLowSamples}/${required}`);
			if (!step.emitReport) {
				return;
			}
			const minObserved = requiredSustainedSamples(monitor.minAgentProcessAgeSec, rateSec);
			const memoryByPid = new Map<number, number>();
			const cpuByPid = new Map<number, number>();
			for (const row of rows) {
				memoryByPid.set(row.pid, row.memoryMB);
			}
			for (const tracker of this.processTrackers.values()) {
				cpuByPid.set(tracker.pid, tracker.latestCpuUtilPct);
			}
			const processes = buildPressureReportProcesses(
				candidates, memoryByPid, cpuByPid, this.agentProcessObservedSamples, minObserved, monitor.minReportedCpuPct);
			const isEpisodeStart = this.episodeStartPending && processes.length > 0;
			if (isEpisodeStart) {
				this.episodeStartPending = false;
			}
			this.logService.trace(
				`[AgentProclistService] Agent memory pressure report (episodeStart=${isEpisodeStart}): ${processes.length} processes`);
			this._onAgentMemoryPressureReport.fire({ memory, processes, isEpisodeStart });
		} catch (error) {
			this.logService.warn('[AgentProclistService] Memory sampling failed:', error);
		}
	}

	// ------------------------------------------------------------------
	// System sensors — verbatim transcription of readSystemMemory(),
	// readSystemCpu() and readCpuTimes()
	// ------------------------------------------------------------------

	private readSystemMemory(): ISystemMemorySample {
		let total = totalmem();
		let available = freemem();
		try {
			if (isLinux) {
				const match = /MemAvailable:\s+(\d+) kB/.exec(readFileSync('/proc/meminfo', 'utf8'));
				if (match) {
					available = parseInt(match[1], 10) * 1024;
				}
			}
		} catch (error) {
			this.logService.trace('[AgentProclistService] System memory read failed:', error);
		}
		const GiB = 1024 * 1024 * 1024;
		return {
			availPct: total > 0 ? available / total * 100 : 0,
			availGb: available / GiB,
			totalGb: total / GiB,
			pressureLevel: undefined,
		};
	}

	private readSystemCpu(): number {
		const times = this.readCpuTimes();
		if (!times) {
			return 0;
		}
		const previous = this.previousCpuTimes;
		this.previousCpuTimes = times;
		if (!previous) {
			return 0;
		}
		const idleDelta = times.idle - previous.idle;
		const totalDelta = times.total - previous.total;
		if (totalDelta <= 0) {
			return 0;
		}
		return Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100));
	}

	private readCpuTimes(): ISystemCpuTimes | undefined {
		if (isLinux) {
			try {
				return parseProcStatCpuTimes(readFileSync('/proc/stat', 'utf8'));
			} catch (error) {
				this.logService.trace('[AgentProclistService] /proc/stat read failed:', error);
				return undefined;
			}
		}
		let idle = 0;
		let total = 0;
		for (const cpu of cpus()) {
			const t = cpu.times;
			idle += t.idle;
			total += t.user + t.nice + t.sys + t.idle + t.irq;
		}
		return { idle, total };
	}

	// ------------------------------------------------------------------
	// Kill — verbatim transcription of signalProcess() / killAgentProcessTree()
	// ------------------------------------------------------------------

	private signalProcess(pid: number, signal: NodeJS.Signals | 0): 'signaled' | 'exited' | 'failed' {
		try {
			process.kill(pid, signal);
			return 'signaled';
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			return code === 'ESRCH' ? 'exited' : 'failed';
		}
	}

	private killAgentProcessTreeSync(pid: number, name: string): boolean {
		const root = this.latestAgentProcessCandidates.get(pid);
		if (!root || root.name !== name) {
			const alreadyExited = this.signalProcess(pid, 0) === 'exited';
			this.logService.info(
				`[AgentProclistService] Kill refused for pid ${pid}: not a current agent-process candidate (alreadyExited=${alreadyExited})`);
			return alreadyExited;
		}
		const ordered = planKillAgentProcessTree(this.latestAgentProcessCandidates, pid) ?? [];
		let signaled = 0;
		let alreadyExited = 0;
		let failed = 0;
		let rootFailed = false;
		for (const target of ordered) {
			const result = this.signalProcess(target, 'SIGTERM');
			if (result === 'signaled') {
				signaled++;
			} else if (result === 'exited') {
				alreadyExited++;
			} else {
				failed++;
				if (target === pid) {
					rootFailed = true;
				}
			}
		}
		this.logService.info(
			`[AgentProclistService] Killed agent process tree rooted at ${pid} ` +
			`(signaled=${signaled} alreadyExited=${alreadyExited} failed=${failed} of ${ordered.length})`);
		return !rootFailed;
	}

	// ------------------------------------------------------------------
	// Process scanning (pure-Node replacement for cursor-proclist)
	// ------------------------------------------------------------------

	private async scanProcesses(): Promise<IScannedProcessRow[]> {
		if (isLinux) {
			return this.scanProc();
		}
		if (isMacintosh) {
			return this.scanPs();
		}
		return [];
	}

	private async scanProc(): Promise<IScannedProcessRow[]> {
		const entries = await readdir('/proc');
		const rows: IScannedProcessRow[] = [];
		for (const entry of entries) {
			if (!/^\d+$/.test(entry)) {
				continue;
			}
			const pid = Number(entry);
			try {
				const row = await this.readProcEntry(pid);
				if (row) {
					rows.push(row);
				}
			} catch {
				// Process exited while reading — skip, exactly as the binary does.
			}
		}
		return rows;
	}

	private async readProcEntry(pid: number): Promise<IScannedProcessRow | undefined> {
		const [stat, status, cmdline] = await Promise.all([
			readFile(`/proc/${pid}/stat`, 'utf8'),
			readFile(`/proc/${pid}/status`, 'utf8'),
			readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => ''),
		]);
		const commEnd = stat.lastIndexOf(')');
		if (commEnd < 0) {
			return undefined;
		}
		const name = stat.slice(stat.indexOf('(') + 1, commEnd);
		const rest = stat.slice(commEnd + 2).split(' ');
		const ppid = Number(rest[1]);
		if (!Number.isFinite(ppid)) {
			return undefined;
		}
		const utime = Number(rest[11]);
		const stime = Number(rest[12]);
		const rssPages = Number(rest[21]);
		const cpuTimeMs = ((Number.isFinite(utime) ? utime : 0) + (Number.isFinite(stime) ? stime : 0)) * 1000 / LINUX_CLK_TCK;
		let memoryMB: number | undefined;
		const vmRss = /VmRSS:\s+(\d+)\s+kB/.exec(status);
		if (vmRss) {
			memoryMB = Number(vmRss[1]) / 1024;
		} else if (Number.isFinite(rssPages)) {
			memoryMB = rssPages * 4096 / (1024 * 1024);
		} else {
			memoryMB = 0;
		}
		const argv = cmdline.split('\0').filter(arg => arg.length > 0);
		return { pid, ppid, name, argv, memoryMB, cpuTimeMs };
	}

	private scanPs(): Promise<IScannedProcessRow[]> {
		return new Promise(resolve => {
			execFile('/bin/ps', ['-axo', 'pid=,ppid=,rss=,etime=,command='], { encoding: 'utf8', timeout: 15000 }, (error, stdout) => {
				if (error) {
					this.logService.warn('[AgentProclistService] ps scan failed:', error);
					resolve([]);
					return;
				}
				const rows: IScannedProcessRow[] = [];
				for (const line of stdout.split('\n')) {
					const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
					if (!match) {
						continue;
					}
					const [, pidS, ppidS, rssKbS, , command] = match;
					const pid = Number(pidS);
					const ppid = Number(ppidS);
					const argv = splitCommandLine(command.trim());
					const name = argv.length > 0 ? argv[0].split('/').pop() ?? '' : '';
					rows.push({
						pid,
						ppid,
						name,
						argv,
						memoryMB: Number(rssKbS) / 1024,
						cpuTimeMs: 0,
					});
				}
				resolve(rows);
			});
		});
	}
}

/** Naive argv splitter for `ps` output (divergence: quoted shells are approximated). */
function splitCommandLine(command: string): string[] {
	return command.split(/\s+/).filter(arg => arg.length > 0);
}
