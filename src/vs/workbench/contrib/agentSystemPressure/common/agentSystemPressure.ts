/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Agent system pressure — Cursor parity (feature `glass-system-pressure-commands`,
// discovered by dig-root-team REDIG2-MISC, 2026-10-19).
//
// Binary evidence (Cursor 3.25.9, reference/cursor-3.25.9):
//  - workbench.glass.main.js @44593456/@44593559: notification-action factory Rzb(t,e)
//    registering `cursor.agentSystemPressure.manageProcesses` ("Manage Processes") and
//    `cursor.agentSystemPressure.dontShowAgain` ("Don't show again"); notification
//    {id:"glass.agent-heavy-load", severity:Warning, priority:URGENT, sticky,
//    closeNotificationOnToastDismiss, message:"Agent starting expensive processes",
//    toastDescription:"Manage the processes started by your agent to keep your computer
//    responsive."}.
//  - workbench.glass.main.js @25576950: lm.agentHeavyLoad="glass.agent-heavy-load",
//    lm.agentHeavyLoadProcessKilled="glass.agent-heavy-load-process-killed".
//  - workbench.glass.main.js @44593912: storage key "cursor.agentMemoryPressure.dontShowAgain"
//    (APPLICATION scope, MACHINE target). NOTE the naming inconsistency: command id uses
//    `agentSystemPressure` while the storage key uses `agentMemoryPressure` — kept verbatim.
//  - workbench.glass.main.js @30158635: "heavy-load" modal — title "Manage Processes",
//    subtitle "Several agent tasks are competing for system resources. Run fewer in parallel
//    to keep your system responsive.", kill flow via killAgentProcessTree(pid, name), and on
//    success a notification {severity:Success, message:"Process Killed",
//    id:"glass.agent-heavy-load-process-killed"}.
//  - workbench.glass.main.js @47480670: IPC channel "cursorProclist" (service id
//    "cursorProclistService"), event "onAgentMemoryPressureReport", method
//    "killAgentProcessTree".
//  - workbench.glass.main.js @44592100-44592960: monitor-config normalizer hux() and
//    equality pux() — defaults and clamp ranges transcribed below.
//  - The USER SURFACE is glass-only: `cursor.agentSystemPressure.manageProcesses`
//    / `cursor.agentSystemPressure.dontShowAgain`, the notification message
//    "Agent starting expensive processes", and the storage key
//    "cursor.agentMemoryPressure.dontShowAgain" all have 0 hits in
//    workbench.desktop.main.js. BUT the plumbing is NOT glass-only: the
//    notification ids `glass.agent-heavy-load` / `glass.agent-heavy-load-process-killed`
//    (1 hit each) and the full `cursorProclist` service/channel plumbing
//    (service id "cursorProclistService", channel "cursorProclist", listener
//    "onAgentMemoryPressureReport", method "killAgentProcessTree" —
//    workbench.desktop.main.js @39628937/@39630125) ARE present in desktop.
//    So only the notification/modal surface is glass-exclusive; the monitor +
//    IPC machinery ships in both bundles.
//
// Layer: Cursor keeps this in workbench core (glass bundle), not an extension. This module
// is the platform-free core of the same surface; the workbench wiring lives in
// electron-browser/ (desktop window = the glass-bundle analog in this fork).
//
// `cursor.cloudAgent.machinePressure.viewMachineInfo` ("View Machine Metrics", @44586115)
// belongs to the cloud-agent VM surface and is NOT part of this module (see HONEST-DIVERGENCE
// in the contribution file). `cursor.resetInAppAdViews` was triaged EXCLUDED (dev-only,
// isBuilt guard) by the same dig; DEV-GAPS-64 (W64A, follow-up of DEV-GAPS-62 W62D
// finding F3) registers it verbatim as a no-op command — see
// RESET_IN_APP_AD_VIEWS_* below and the contribution file.

// ---------------------------------------------------------------------------
// Verbatim identifiers & strings (offsets above)
// ---------------------------------------------------------------------------

/** Command id: "Manage Processes" notification action. */
export const MANAGE_PROCESSES_COMMAND_ID = 'cursor.agentSystemPressure.manageProcesses';
export const MANAGE_PROCESSES_ACTION_LABEL = 'Manage Processes';

/** Command id: "Don't show again" notification action. */
export const DONT_SHOW_AGAIN_COMMAND_ID = 'cursor.agentSystemPressure.dontShowAgain';
export const DONT_SHOW_AGAIN_ACTION_LABEL = "Don't show again";

/** Notification id for the heavy-load warning (lm.agentHeavyLoad). */
export const HEAVY_LOAD_NOTIFICATION_ID = 'glass.agent-heavy-load';

/** Notification id for the post-kill confirmation (lm.agentHeavyLoadProcessKilled). */
export const PROCESS_KILLED_NOTIFICATION_ID = 'glass.agent-heavy-load-process-killed';

/**
 * Storage key for the per-machine opt-out. NOTE the naming inconsistency in the
 * binary: the command namespace is `agentSystemPressure` but the storage key is
 * `agentMemoryPressure.dontShowAgain`. Kept verbatim.
 */
export const DONT_SHOW_AGAIN_STORAGE_KEY = 'cursor.agentMemoryPressure.dontShowAgain';

/** Modal id used by openModal/updateModalProps in the binary ("heavy-load"). */
export const HEAVY_LOAD_MODAL_ID = 'heavy-load';

/** IPC channel of the process-monitor service in the binary. */
export const PROCLIST_IPC_CHANNEL = 'cursorProclist';

/** Service id (Qn("cursorProclistService")) in the binary. */
export const PROCLIST_SERVICE_ID = 'cursorProclistService';

/** IPC event name carrying pressure reports. */
export const AGENT_MEMORY_PRESSURE_REPORT_EVENT = 'onAgentMemoryPressureReport';

/** IPC method name for killing an agent process tree. */
export const KILL_AGENT_PROCESS_TREE_METHOD = 'killAgentProcessTree';

/** IPC method name for applying monitor thresholds. */
export const APPLY_MONITOR_CONFIG_METHOD = 'applyConfig';

/** IPC method name for reading a fresh process-tree snapshot. */
export const GET_PROCESS_TREE_SNAPSHOT_METHOD = 'getProcessTreeSnapshot';

/** Developer command id that forces the heavy-load surface (binary: Iev="forceHeavyLoadToast"). */
export const FORCE_HEAVY_LOAD_TOAST_COMMAND_ID = 'forceHeavyLoadToast';
export const FORCE_HEAVY_LOAD_TOAST_TITLE = 'Force High CPU Usage Toast';

// ---------------------------------------------------------------------------
// `cursor.resetInAppAdViews` — DEV-GAPS-64 W64A (follow-up F3 of DEV-GAPS-62/W62D)
// ---------------------------------------------------------------------------
//
// Binary evidence (Cursor 3.25.9, reference/cursor-3.25.9,
// out/vs/workbench/workbench.glass.main.js @45359415):
//   Ir({id:"cursor.resetInAppAdViews", title:"Reset In-App Ad Views",
//     icon:"discard", glassCategory:"Developer",
//     keywords:["ads","in-app","reset","views","devtools"], f1:!0,
//     run:async t=>{ if(t.get(jC).isBuilt) return;
//       const n=t.get(el); // notification service
//       try{ await Zxx(t), n.info("Successfully reset in-app ad views. Ads will show again.") }
//       catch{ n.error("Error resetting in-app ad views.") } }})
//   Zxx @45329438: t.get(...) ad-service instance .resetUserAdViews(...),
//   maE(), then forceRefreshServerConfig() — Cursor-internal ad/proto
//   plumbing with NO counterpart in this fork.
// The title is a plain string literal in the binary (not an NLS k(n) lookup),
// so it is ported verbatim; the messages below are the binary's own
// notification strings, kept here for the day the fork grows an ad service.

/** Command id: "Reset In-App Ad Views" (glassCategory "Developer"). */
export const RESET_IN_APP_AD_VIEWS_COMMAND_ID = 'cursor.resetInAppAdViews';
export const RESET_IN_APP_AD_VIEWS_TITLE = 'Reset In-App Ad Views';
/** Binary keywords: ["ads","in-app","reset","views","devtools"]. */
export const RESET_IN_APP_AD_VIEWS_KEYWORDS: readonly string[] = ['ads', 'in-app', 'reset', 'views', 'devtools'];
/** Binary notification on success (never shown by this fork's no-op port). */
export const RESET_IN_APP_AD_VIEWS_SUCCESS_MESSAGE = 'Successfully reset in-app ad views. Ads will show again.';
/** Binary notification on failure (never shown by this fork's no-op port). */
export const RESET_IN_APP_AD_VIEWS_ERROR_MESSAGE = 'Error resetting in-app ad views.';

/**
 * Fork-local settings that feed the monitor config. Cursor receives these
 * values from its cloud dynamic config (extension_monitor_control); this fork
 * has no dynamic-config service, so the same fields are exposed as local
 * settings and normalized through normalizeAgentProcessMonitorConfig (Fcx).
 */
export const PRESSURE_SETTING_PREFIX = 'cursor.agentSystemPressure';
export const PRESSURE_SETTING_MONITOR_ENABLED = `${PRESSURE_SETTING_PREFIX}.monitorEnabled`;
export const PRESSURE_SETTING_SUBSAMPLE_POLLING_RATE_SEC = `${PRESSURE_SETTING_PREFIX}.subsamplePollingRateSec`;
export const PRESSURE_SETTING_LOW_MEMORY_SUSTAINED_SEC = `${PRESSURE_SETTING_PREFIX}.lowMemorySustainedSec`;
export const PRESSURE_SETTING_MIN_AGENT_PROCESS_AGE_SEC = `${PRESSURE_SETTING_PREFIX}.minAgentProcessAgeSec`;
export const PRESSURE_SETTING_LOW_MEMORY_AVAILABLE_PCT = `${PRESSURE_SETTING_PREFIX}.lowMemoryAvailablePct`;
export const PRESSURE_SETTING_LOW_MEMORY_AVAILABLE_ABS_GB = `${PRESSURE_SETTING_PREFIX}.lowMemoryAvailableAbsGb`;
export const PRESSURE_SETTING_CPU_HIGH_PCT = `${PRESSURE_SETTING_PREFIX}.cpuHighPct`;
export const PRESSURE_SETTING_CPU_HIGH_SUSTAINED_SEC = `${PRESSURE_SETTING_PREFIX}.cpuHighSustainedSec`;
export const PRESSURE_SETTING_MIN_REPORTED_CPU_PCT = `${PRESSURE_SETTING_PREFIX}.minReportedCpuPct`;

/**
 * applyConfig payload shape (binary main-side consumer reads localEnabled,
 * subsamplePollingRateSec and agentMemoryPressureMonitor off this object).
 */
export interface IAgentProclistApplyConfig {
	readonly localEnabled: boolean;
	readonly subsamplePollingRateSec: number;
	readonly agentMemoryPressureMonitor: IAgentProcessMonitorConfig;
}

export const HEAVY_LOAD_NOTIFICATION_MESSAGE = 'Agent starting expensive processes';
export const HEAVY_LOAD_NOTIFICATION_TOAST_DESCRIPTION =
	'Manage the processes started by your agent to keep your computer responsive.';

export const MANAGE_PROCESSES_MODAL_TITLE = 'Manage Processes';
export const MANAGE_PROCESSES_MODAL_SUBTITLE =
	'Several agent tasks are competing for system resources. Run fewer in parallel to keep your system responsive.';
export const KILL_PROCESS_BUTTON_LABEL = 'Kill Process';
export const PROCESS_KILLED_MESSAGE = 'Process Killed';

/** Telemetry event logged when the toast is shown (binary: s.trackEvent(...)). */
export const PRESSURE_TOAST_SHOWN_TELEMETRY_EVENT = 'glass.agent_system_pressure.toast_shown';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** One agent-owned process in a pressure report (binary fields). */
export interface IAgentProcessInfo {
	readonly pid: number;
	readonly name: string;
	readonly args?: string;
	/** Resident memory in megabytes. */
	readonly memoryMB: number;
	readonly cpuUtilPct: number;
	/** Owning agent; the binary prefixes the agent's display name before the process name. */
	readonly ownerAgentId?: string;
}

/** Payload of `onAgentMemoryPressureReport` in the binary. */
export interface IAgentMemoryPressureReport {
	readonly processes: readonly IAgentProcessInfo[];
	readonly isEpisodeStart: boolean;
}

/** Monitor thresholds; snake_case dynamic-config keys are normalized into this shape. */
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

/** Sortable columns of the "Manage Processes" modal (binary vwC keys). */
export type AgentProcessSortKey = 'process' | 'memory' | 'cpu';
export type SortDirection = 'asc' | 'desc';

// ---------------------------------------------------------------------------
// Config normalizer — verbatim transcription of hux() in the binary
// ---------------------------------------------------------------------------

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
	const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
	return Math.max(min, Math.min(max, n));
}

/**
 * Normalizes a raw (snake_case, dynamic-config) payload into monitor thresholds.
 * Verbatim defaults/clamps from hux():
 *   monitor_enabled -> monitorEnabled === true
 *   low_memory_sustained_sec -> clamp(30, 1, 3600)
 *   min_agent_process_age_sec -> clamp(0, 0, 3600)
 *   low_memory_available_pct -> clamp(10, 0, 100)
 *   low_memory_available_abs_gb -> clamp(3, 0, 64)
 *   cpu_high_pct -> clamp(90, 0, 100)
 *   cpu_high_sustained_sec -> clamp(30, 1, 3600)
 *   min_reported_cpu_pct -> clamp(5, 0, 100)
 */
export function normalizeAgentProcessMonitorConfig(raw: Record<string, unknown> | undefined | null): IAgentProcessMonitorConfig {
	const e = raw ?? {};
	return {
		monitorEnabled: e['monitor_enabled'] === true,
		lowMemorySustainedSec: clampNumber(e['low_memory_sustained_sec'], 30, 1, 3600),
		minAgentProcessAgeSec: clampNumber(e['min_agent_process_age_sec'], 0, 0, 3600),
		lowMemoryAvailablePct: clampNumber(e['low_memory_available_pct'], 10, 0, 100),
		lowMemoryAvailableAbsGb: clampNumber(e['low_memory_available_abs_gb'], 3, 0, 64),
		cpuHighPct: clampNumber(e['cpu_high_pct'], 90, 0, 100),
		cpuHighSustainedSec: clampNumber(e['cpu_high_sustained_sec'], 30, 1, 3600),
		minReportedCpuPct: clampNumber(e['min_reported_cpu_pct'], 5, 0, 100),
	};
}

/**
 * Field-wise config equality — verbatim transcription of pux() in the binary:
 * `t===e ? true : !t||!e ? false : <all 8 fields equal>`.
 */
export function agentProcessMonitorConfigsEqual(
	a: IAgentProcessMonitorConfig | undefined | null,
	b: IAgentProcessMonitorConfig | undefined | null
): boolean {
	if (a === b) {
		return true;
	}
	if (!a || !b) {
		return false;
	}
	return a.monitorEnabled === b.monitorEnabled
		&& a.lowMemorySustainedSec === b.lowMemorySustainedSec
		&& a.minAgentProcessAgeSec === b.minAgentProcessAgeSec
		&& a.lowMemoryAvailablePct === b.lowMemoryAvailablePct
		&& a.lowMemoryAvailableAbsGb === b.lowMemoryAvailableAbsGb
		&& a.cpuHighPct === b.cpuHighPct
		&& a.cpuHighSustainedSec === b.cpuHighSustainedSec
		&& a.minReportedCpuPct === b.minReportedCpuPct;
}

// ---------------------------------------------------------------------------
// Modal pure logic — verbatim transcription of fwC/gwC/vwC in the binary
// ---------------------------------------------------------------------------

/**
 * Formats megabytes as the binary does (fwC):
 * `t>=1024 ? `${(t/1024).toFixed(1)} GB` : `${Math.round(t)} MB``.
 */
export function formatProcessMemoryMB(memoryMB: number): string {
	return memoryMB >= 1024 ? `${(memoryMB / 1024).toFixed(1)} GB` : `${Math.round(memoryMB)} MB`;
}

/**
 * Command-line display of a process (gwC): `t.args ? `${t.name} ${t.args}` : t.name`.
 */
export function processCommandLine(process: IAgentProcessInfo): string {
	return process.args ? `${process.name} ${process.args}` : process.name;
}

/**
 * Display name of a row (binary de): `${agentName} - ${process.name}` when the
 * owner agent has a display name, otherwise the process name alone.
 */
export function resolveProcessDisplayName(process: IAgentProcessInfo, agentDisplayName?: string): string {
	const trimmed = agentDisplayName?.trim();
	return trimmed ? `${trimmed} - ${process.name}` : process.name;
}

/**
 * Row comparator — verbatim transcription of vwC(t,e,n,i,r):
 * "process" -> localeCompare with {sensitivity:"base"} on the display name,
 * "memory"  -> memoryMB difference,
 * "cpu"     -> cpuUtilPct difference,
 * multiplied by +1 for asc / -1 for desc.
 */
export function compareAgentProcesses(
	a: IAgentProcessInfo,
	b: IAgentProcessInfo,
	sortKey: AgentProcessSortKey,
	direction: SortDirection,
	displayNameOf: (p: IAgentProcessInfo) => string
): number {
	const s = direction === 'asc' ? 1 : -1;
	switch (sortKey) {
		case 'process':
			return s * displayNameOf(a).localeCompare(displayNameOf(b), undefined, { sensitivity: 'base' });
		case 'memory':
			return s * (a.memoryMB - b.memoryMB);
		case 'cpu':
			return s * (a.cpuUtilPct - b.cpuUtilPct);
	}
}

/**
 * Sorts a copy of the list (the binary sorts `[...ce].sort(ue)`).
 */
export function sortAgentProcesses(
	processes: readonly IAgentProcessInfo[],
	sortKey: AgentProcessSortKey,
	direction: SortDirection,
	displayNameOf: (p: IAgentProcessInfo) => string
): IAgentProcessInfo[] {
	return [...processes].sort((a, b) => compareAgentProcesses(a, b, sortKey, direction, displayNameOf));
}

/**
 * Drops already-killed rows (binary: `const ce=i.filter(le)` where le excludes
 * pids present in the killed set `u`).
 */
export function filterKilledProcesses(
	processes: readonly IAgentProcessInfo[],
	killedPids: ReadonlySet<number>
): IAgentProcessInfo[] {
	return processes.filter(p => !killedPids.has(p.pid));
}

/**
 * Next sort state when a column header is clicked — verbatim transcription of the
 * binary header handler `me`: clicking the active column toggles direction;
 * clicking "process" resets to asc, other columns reset to desc.
 */
export function nextProcessSort(
	current: { readonly key: AgentProcessSortKey; readonly direction: SortDirection },
	clicked: AgentProcessSortKey
): { key: AgentProcessSortKey; direction: SortDirection } {
	if (clicked === current.key) {
		return { key: current.key, direction: current.direction === 'asc' ? 'desc' : 'asc' };
	}
	return { key: clicked, direction: clicked === 'process' ? 'asc' : 'desc' };
}

// ---------------------------------------------------------------------------
// Toast trigger state machine — verbatim transcription of the mux() hook logic
// ---------------------------------------------------------------------------

export interface IAgentPressureTriggerEnv {
	/** Whether the "heavy-load" modal is currently open (l("heavy-load")). */
	readonly modalOpen: boolean;
	/** Whether the window currently has focus (i.hasFocus). */
	readonly windowFocused: boolean;
	/** Whether the user opted out via "Don't show again" (f()). */
	readonly dontShowAgain: boolean;
}

export type AgentPressureDecision =
	| { readonly kind: 'none' }
	/** Modal is open: refresh its props with the latest report (a("heavy-load", p(y))). */
	| { readonly kind: 'updateModal' }
	/** Show the heavy-load toast now; deferredUntilFocus mirrors g(!1)/g(!0). */
	| { readonly kind: 'showToast'; readonly deferredUntilFocus: boolean }
	/** Window is not focused: set the deferred flag (c.current = true). */
	| { readonly kind: 'deferUntilFocus' };

/**
 * Mirrors the binary subscription exactly:
 *
 *   _=e.onAgentMemoryPressureReport(y=>{
 *     if(y.processes.length!==0){
 *       if(u.current=y,l("heavy-load")){a("heavy-load",p(y));return}
 *       c.current||!y.isEpisodeStart||f()||(i.hasFocus?g(!1):c.current=!0)}}),
 *   b=i.onDidChangeFocus(y=>{y&&c.current&&(c.current=!1,f()||g(!0))});
 *
 * - The latest report is stored only for non-empty reports: the binary sets
 *   u.current = y inside the `processes.length !== 0` branch, so an empty
 *   report leaves the previously stored report untouched.
 * - Empty reports are ignored.
 * - An open modal is updated, never re-toasted.
 * - A toast is shown only at episode start while the user has not opted out; if the
 *   window is unfocused the toast is deferred until focus returns.
 */
export class AgentPressureToastCoordinator {
	private deferredUntilFocus = false;
	private latestReport: IAgentMemoryPressureReport | null = null;

	getLatestReport(): IAgentMemoryPressureReport | null {
		return this.latestReport;
	}

	isDeferred(): boolean {
		return this.deferredUntilFocus;
	}

	onReport(report: IAgentMemoryPressureReport, env: IAgentPressureTriggerEnv): AgentPressureDecision {
		// Binary mux(): u.current = y happens inside the `y.processes.length !== 0`
		// branch — an empty report must NOT overwrite the stored report.
		if (report.processes.length === 0) {
			return { kind: 'none' };
		}
		this.latestReport = report;
		if (env.modalOpen) {
			return { kind: 'updateModal' };
		}
		if (this.deferredUntilFocus || !report.isEpisodeStart || env.dontShowAgain) {
			return { kind: 'none' };
		}
		if (env.windowFocused) {
			return { kind: 'showToast', deferredUntilFocus: false };
		}
		this.deferredUntilFocus = true;
		return { kind: 'deferUntilFocus' };
	}

	onFocusChanged(focused: boolean, dontShowAgain: boolean): AgentPressureDecision {
		if (focused && this.deferredUntilFocus) {
			this.deferredUntilFocus = false;
			if (!dontShowAgain) {
				return { kind: 'showToast', deferredUntilFocus: true };
			}
		}
		return { kind: 'none' };
	}
}

// ---------------------------------------------------------------------------
// Notification descriptor — mirrors Rzb(t,e) field-for-field
// ---------------------------------------------------------------------------

/**
 * The verbatim heavy-load notification from Rzb(t,e). The binary marks it
 * severity:Warning, priority:URGENT, sticky:true, closeNotificationOnToastDismiss:true
 * with message + toastDescription above and the two command actions as primary.
 * `toastDescription` / `closeNotificationOnToastDismiss` are glass-React-toast fields
 * with no counterpart on the fork's INotification; the browser layer passes only
 * the supported fields (see HONEST-DIVERGENCE there).
 */
export function createHeavyLoadNotificationDescriptor() {
	return {
		id: HEAVY_LOAD_NOTIFICATION_ID,
		severity: 'warning' as const,
		priority: 'urgent' as const,
		sticky: true,
		closeNotificationOnToastDismiss: true,
		message: HEAVY_LOAD_NOTIFICATION_MESSAGE,
		toastDescription: HEAVY_LOAD_NOTIFICATION_TOAST_DESCRIPTION,
		actions: {
			primary: [
				{ id: MANAGE_PROCESSES_COMMAND_ID, label: MANAGE_PROCESSES_ACTION_LABEL },
				{ id: DONT_SHOW_AGAIN_COMMAND_ID, label: DONT_SHOW_AGAIN_ACTION_LABEL },
			],
		},
	};
}
