/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Agent system pressure contribution — Cursor parity
// (feature `glass-system-pressure-commands`).
//
// Binary evidence (Cursor 3.25.9, reference/cursor-3.25.9), workbench.glass.main.js:
//   - @44593400-@44594800: the mux() hook. On onAgentMemoryPressureReport(y):
//       * u.current = y (store latest report)
//       * if modal "heavy-load" is open -> updateModalProps("heavy-load",
//         {processes, onKill: (pid,name) => killAgentProcessTree(pid,name)})
//       * else if !deferred && y.isEpisodeStart && !dontShowAgainEnabled():
//             window focused -> notify(Rzb(manage, dontShowAgain)) +
//                               trackEvent("glass.agent_system_pressure.toast_shown",
//                                 {processCount, topProcessCpuPct, deferredUntilFocus:false})
//             window unfocused -> deferred = true
//       * on focus regain while deferred -> deferred = false; if !dontShowAgainEnabled()
//             notify(...) + trackEvent(..., deferredUntilFocus: true)
//     The "Don't show again" run body stores
//       ("cursor.agentMemoryPressure.dontShowAgain", true, APPLICATION, MACHINE);
//     the gate reads getBoolean(same key, APPLICATION, false).
//   - Rzb notification: {id:"glass.agent-heavy-load", severity:Warning,
//     priority:URGENT, sticky, message:"Agent starting expensive processes",
//     toastDescription:"Manage the processes started by your agent to keep your
//     computer responsive.", actions:{primary:[manageProcesses, dontShowAgain]}}.
//
// Layer parity: Cursor registers this surface in workbench core (glass bundle), so
// this contribution lives in workbench core too — electron-browser/ because it is
// driven by the shared-process `cursorProclist` channel, which only exists in the
// desktop shell (the glass-bundle analog in this fork; the desktop workbench bundle
// of Cursor 3.25.9 has 0 hits for these identifiers by design).
//
// HONEST-DIVERGENCE:
//   - Glass-only fields `toastDescription` and `closeNotificationOnToastDismiss`
//     on Rzb's notification have no counterpart on this fork's INotification and
//     are not passed to notify(); severity/priority/sticky/message/id/actions are.
//   - The "Process Killed" confirmation uses Severity.Info here; Cursor's glass
//     layer has a distinct `Success` severity that this fork's Severity enum lacks.
//   - `cursor.cloudAgent.machinePressure.viewMachineInfo` ("View Machine Metrics",
//     glass @44586115) is intentionally NOT registered: its handler opens the
//     cloud-agent VM metrics view (Wcx over cloud-agent plumbing) that does not
//     exist in this fork; registering a dead command would be worse than none.
//     (The other command triaged in the same dig, `cursor.resetInAppAdViews`,
//     IS registered below — W64A: verbatim no-op, isBuilt early-return.)
//   - The producer side of the `cursorProclist` channel now lives in the shared
//     process (platform/agentProclist: pure-Node scanner + episode monitor,
//     DEV-GAPS-60). Cursor sources the monitor config from its cloud dynamic
//     config (extension_monitor_control); this fork sources the identical
//     fields from local `cursor.agentSystemPressure.*` settings and normalizes
//     them through the same Fcx normalizer before calling applyConfig.
//   - The binary gates `forceHeavyLoadToast` behind dev-only context keys
//     (isExtensionDevelopment || !isBuilt). This fork registers the command
//     unconditionally; it is harmless in production (it only reads a process
//     snapshot and opens the same notification/modal surface).

import { Action } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import Severity from '../../../../base/common/severity.js';
import * as nls from '../../../../nls.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { INotificationService, NotificationPriority } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { IHostService } from '../../../services/host/browser/host.js';
import {
	AgentPressureToastCoordinator,
	createHeavyLoadNotificationDescriptor,
	DONT_SHOW_AGAIN_ACTION_LABEL,
	DONT_SHOW_AGAIN_COMMAND_ID,
	DONT_SHOW_AGAIN_STORAGE_KEY,
	FORCE_HEAVY_LOAD_TOAST_COMMAND_ID,
	IAgentMemoryPressureReport,
	IAgentProclistApplyConfig,
	MANAGE_PROCESSES_ACTION_LABEL,
	MANAGE_PROCESSES_COMMAND_ID,
	normalizeAgentProcessMonitorConfig,
	PRESSURE_SETTING_CPU_HIGH_PCT,
	PRESSURE_SETTING_CPU_HIGH_SUSTAINED_SEC,
	PRESSURE_SETTING_LOW_MEMORY_AVAILABLE_ABS_GB,
	PRESSURE_SETTING_LOW_MEMORY_AVAILABLE_PCT,
	PRESSURE_SETTING_LOW_MEMORY_SUSTAINED_SEC,
	PRESSURE_SETTING_MIN_AGENT_PROCESS_AGE_SEC,
	PRESSURE_SETTING_MIN_REPORTED_CPU_PCT,
	PRESSURE_SETTING_MONITOR_ENABLED,
	PRESSURE_SETTING_SUBSAMPLE_POLLING_RATE_SEC,
	PRESSURE_TOAST_SHOWN_TELEMETRY_EVENT,
	PROCESS_KILLED_MESSAGE,
	PROCESS_KILLED_NOTIFICATION_ID,
	RESET_IN_APP_AD_VIEWS_COMMAND_ID,
} from '../common/agentSystemPressure.js';
import { AgentSystemPressureService, IAgentSystemPressureService } from './agentSystemPressureService.js';
import { HeavyLoadModal } from './heavyLoadModal.js';

// --- Settings ---
// Fork-local source of the dynamic config Cursor reads from
// extension_monitor_control. The field names mirror the snake_case Fcx inputs;
// values are normalized through normalizeAgentProcessMonitorConfig exactly as
// the binary does before reaching applyConfig.
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'agentSystemPressure',
	title: nls.localize('agentSystemPressureConfigurationTitle', 'Agent System Pressure'),
	type: 'object',
	properties: {
		[PRESSURE_SETTING_MONITOR_ENABLED]: {
			type: 'boolean',
			description: nls.localize('agentSystemPressure.monitorEnabled', 'Monitor agent processes for resource pressure and warn with a Manage Processes notification (Cursor parity: monitor_enabled).'),
			default: false,
		},
		[PRESSURE_SETTING_SUBSAMPLE_POLLING_RATE_SEC]: {
			type: 'number',
			description: nls.localize('agentSystemPressure.subsamplePollingRateSec', 'How often the process monitor samples the system, in seconds (Cursor parity: subsample_polling_rate_sec, clamped to 1-300).'),
			default: 5,
		},
		[PRESSURE_SETTING_LOW_MEMORY_SUSTAINED_SEC]: {
			type: 'number',
			description: nls.localize('agentSystemPressure.lowMemorySustainedSec', 'Cursor parity: low_memory_sustained_sec (clamped 1-3600).'),
			default: 30,
		},
		[PRESSURE_SETTING_MIN_AGENT_PROCESS_AGE_SEC]: {
			type: 'number',
			description: nls.localize('agentSystemPressure.minAgentProcessAgeSec', 'Cursor parity: min_agent_process_age_sec (clamped 0-3600).'),
			default: 0,
		},
		[PRESSURE_SETTING_LOW_MEMORY_AVAILABLE_PCT]: {
			type: 'number',
			description: nls.localize('agentSystemPressure.lowMemoryAvailablePct', 'Cursor parity: low_memory_available_pct (clamped 0-100).'),
			default: 10,
		},
		[PRESSURE_SETTING_LOW_MEMORY_AVAILABLE_ABS_GB]: {
			type: 'number',
			description: nls.localize('agentSystemPressure.lowMemoryAvailableAbsGb', 'Cursor parity: low_memory_available_abs_gb (clamped 0-64).'),
			default: 3,
		},
		[PRESSURE_SETTING_CPU_HIGH_PCT]: {
			type: 'number',
			description: nls.localize('agentSystemPressure.cpuHighPct', 'Cursor parity: cpu_high_pct (clamped 0-100).'),
			default: 90,
		},
		[PRESSURE_SETTING_CPU_HIGH_SUSTAINED_SEC]: {
			type: 'number',
			description: nls.localize('agentSystemPressure.cpuHighSustainedSec', 'Cursor parity: cpu_high_sustained_sec (clamped 1-3600).'),
			default: 30,
		},
		[PRESSURE_SETTING_MIN_REPORTED_CPU_PCT]: {
			type: 'number',
			description: nls.localize('agentSystemPressure.minReportedCpuPct', 'Cursor parity: min_reported_cpu_pct (clamped 0-100).'),
			default: 5,
		},
	},
});

const PRESSURE_SETTING_KEYS = [
	PRESSURE_SETTING_MONITOR_ENABLED,
	PRESSURE_SETTING_SUBSAMPLE_POLLING_RATE_SEC,
	PRESSURE_SETTING_LOW_MEMORY_SUSTAINED_SEC,
	PRESSURE_SETTING_MIN_AGENT_PROCESS_AGE_SEC,
	PRESSURE_SETTING_LOW_MEMORY_AVAILABLE_PCT,
	PRESSURE_SETTING_LOW_MEMORY_AVAILABLE_ABS_GB,
	PRESSURE_SETTING_CPU_HIGH_PCT,
	PRESSURE_SETTING_CPU_HIGH_SUSTAINED_SEC,
	PRESSURE_SETTING_MIN_REPORTED_CPU_PCT,
];

export class AgentSystemPressureContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.agentSystemPressure';

	private readonly coordinator = new AgentPressureToastCoordinator();
	private modal: HeavyLoadModal | undefined;

	constructor(
		@INotificationService private readonly notificationService: INotificationService,
		@IStorageService private readonly storageService: IStorageService,
		@IHostService private readonly hostService: IHostService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IAgentSystemPressureService private readonly pressureService: IAgentSystemPressureService
	) {
		super();

		// Command surface (binary Rzb registers both ids as notification actions;
		// they are callable through the command service with the same ids).
		this._register(CommandsRegistry.registerCommand(MANAGE_PROCESSES_COMMAND_ID, () => {
			this.openHeavyLoadModal();
		}));
		this._register(CommandsRegistry.registerCommand(DONT_SHOW_AGAIN_COMMAND_ID, () => {
			this.storeDontShowAgain();
		}));
		// Developer command: "Force High CPU Usage Toast" (binary id
		// "forceHeavyLoadToast"). Reads a fresh snapshot and notifies the same
		// heavy-load surface with only the Manage Processes action.
		this._register(CommandsRegistry.registerCommand(FORCE_HEAVY_LOAD_TOAST_COMMAND_ID, () => {
			void this.forceHeavyLoadToast();
		}));

		this._register(this.pressureService.onAgentMemoryPressureReport(report => this.handleReport(report)));
		this._register(this.hostService.onDidChangeFocus(focused => this.handleFocusChanged(focused)));

		// Push the monitor config to the shared process; re-push on changes —
		// the binary does the same when its dynamic config changes
		// (handleDynamicConfigChange -> applyConfig).
		this.pushMonitorConfig();
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (PRESSURE_SETTING_KEYS.some(key => e.affectsConfiguration(key))) {
				this.pushMonitorConfig();
			}
		}));
	}

	private isDontShowAgain(): boolean {
		// Binary: n.getBoolean("cursor.agentMemoryPressure.dontShowAgain", APPLICATION, false)
		return this.storageService.getBoolean(DONT_SHOW_AGAIN_STORAGE_KEY, StorageScope.APPLICATION, false);
	}

	private storeDontShowAgain(): void {
		// Binary: n.store("cursor.agentMemoryPressure.dontShowAgain", true, APPLICATION, MACHINE)
		this.storageService.store(DONT_SHOW_AGAIN_STORAGE_KEY, true, StorageScope.APPLICATION, StorageTarget.MACHINE);
	}

	private handleReport(report: IAgentMemoryPressureReport): void {
		const decision = this.coordinator.onReport(report, {
			modalOpen: this.modal?.isOpen ?? false,
			windowFocused: this.hostService.hasFocus,
			dontShowAgain: this.isDontShowAgain(),
		});
		switch (decision.kind) {
			case 'updateModal':
				this.modal?.update(report);
				break;
			case 'showToast':
				this.showHeavyLoadToast(report, decision.deferredUntilFocus);
				break;
			case 'none':
			case 'deferUntilFocus':
				break;
		}
	}

	private handleFocusChanged(focused: boolean): void {
		const decision = this.coordinator.onFocusChanged(focused, this.isDontShowAgain());
		if (decision.kind === 'showToast') {
			const report = this.coordinator.getLatestReport();
			if (report) {
				this.showHeavyLoadToast(report, decision.deferredUntilFocus);
			}
		}
	}

	private showHeavyLoadToast(report: IAgentMemoryPressureReport, deferredUntilFocus: boolean): void {
		// Descriptor mirrors Rzb(t, e) field-for-field; the two glass-only fields
		// (toastDescription, closeNotificationOnToastDismiss) are omitted here —
		// see HONEST-DIVERGENCE above.
		const descriptor = createHeavyLoadNotificationDescriptor();
		const manageAction = new Action(
			MANAGE_PROCESSES_COMMAND_ID,
			MANAGE_PROCESSES_ACTION_LABEL,
			undefined,
			true,
			() => { this.openHeavyLoadModal(); }
		);
		const dontShowAgainAction = new Action(
			DONT_SHOW_AGAIN_COMMAND_ID,
			DONT_SHOW_AGAIN_ACTION_LABEL,
			undefined,
			true,
			() => { this.storeDontShowAgain(); }
		);
		this.notificationService.notify({
			id: descriptor.id,
			severity: Severity.Warning,
			priority: NotificationPriority.URGENT,
			sticky: descriptor.sticky,
			message: descriptor.message,
			actions: { primary: [manageAction, dontShowAgainAction] },
		});
		// Binary: trackEvent("glass.agent_system_pressure.toast_shown",
		//   {processCount, topProcessCpuPct: Math.round(processes[0]?.cpuUtilPct ?? 0),
		//    deferredUntilFocus})
		type PressureToastShownClassification = {
			owner: 'ide-code';
			comment: 'The agent heavy-load warning toast was shown (Cursor parity).';
			processCount: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; isMeasurement: true; comment: 'Number of heavy agent processes.' };
			topProcessCpuPct: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; isMeasurement: true; comment: 'CPU % of the heaviest process.' };
			deferredUntilFocus: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Whether the toast was deferred until the window gained focus.' };
		};
		this.telemetryService.publicLog2<
			{ processCount: number; topProcessCpuPct: number; deferredUntilFocus: boolean },
			PressureToastShownClassification
		>(PRESSURE_TOAST_SHOWN_TELEMETRY_EVENT, {
			processCount: report.processes.length,
			topProcessCpuPct: Math.round(report.processes[0]?.cpuUtilPct ?? 0),
			deferredUntilFocus,
		});
	}

	private openHeavyLoadModal(report?: IAgentMemoryPressureReport): void {
		const effectiveReport = report ?? this.coordinator.getLatestReport();
		if (this.modal?.isOpen) {
			if (effectiveReport) {
				this.modal.update(effectiveReport);
			}
			return;
		}
		if (!effectiveReport) {
			return;
		}
		this.modal?.dispose();
		this.modal = new HeavyLoadModal(effectiveReport, {
			onKill: (pid, name) => this.pressureService.killAgentProcessTree(pid, name),
			onProcessKilled: () => {
				// Binary: notify({severity:Success, message:"Process Killed",
				//   id:"glass.agent-heavy-load-process-killed",
				//   closeNotificationOnToastDismiss:true}); Success -> Info here
				//   (see HONEST-DIVERGENCE).
				this.notificationService.notify({
					id: PROCESS_KILLED_NOTIFICATION_ID,
					severity: Severity.Info,
					message: PROCESS_KILLED_MESSAGE,
				});
			},
			onClose: () => {
				this.modal?.dispose();
				this.modal = undefined;
			},
		});
		this.modal.open();
	}

	/**
	 * Builds the monitor config from the fork-local settings, normalizes it
	 * through the verbatim Fcx normalizer, and pushes it to the shared process
	 * (binary: loadStatsigConfig -> applyConfig on the cursorProclist service).
	 */
	private pushMonitorConfig(): void {
		const raw = {
			monitor_enabled: this.configurationService.getValue<boolean>(PRESSURE_SETTING_MONITOR_ENABLED),
			low_memory_sustained_sec: this.configurationService.getValue<number>(PRESSURE_SETTING_LOW_MEMORY_SUSTAINED_SEC),
			min_agent_process_age_sec: this.configurationService.getValue<number>(PRESSURE_SETTING_MIN_AGENT_PROCESS_AGE_SEC),
			low_memory_available_pct: this.configurationService.getValue<number>(PRESSURE_SETTING_LOW_MEMORY_AVAILABLE_PCT),
			low_memory_available_abs_gb: this.configurationService.getValue<number>(PRESSURE_SETTING_LOW_MEMORY_AVAILABLE_ABS_GB),
			cpu_high_pct: this.configurationService.getValue<number>(PRESSURE_SETTING_CPU_HIGH_PCT),
			cpu_high_sustained_sec: this.configurationService.getValue<number>(PRESSURE_SETTING_CPU_HIGH_SUSTAINED_SEC),
			min_reported_cpu_pct: this.configurationService.getValue<number>(PRESSURE_SETTING_MIN_REPORTED_CPU_PCT),
		};
		const config: IAgentProclistApplyConfig = {
			localEnabled: true,
			subsamplePollingRateSec: this.configurationService.getValue<number>(PRESSURE_SETTING_SUBSAMPLE_POLLING_RATE_SEC),
			agentMemoryPressureMonitor: normalizeAgentProcessMonitorConfig(raw),
		};
		void this.pressureService.applyConfig(config);
	}

	/**
	 * Developer command "Force High CPU Usage Toast" (binary id
	 * "forceHeavyLoadToast"). Mirrors the binary handler: snapshot the process
	 * tree, then notify the heavy-load descriptor with only the Manage
	 * Processes primary action (no "Don't show again"), which opens the
	 * heavy-load modal directly.
	 */
	private async forceHeavyLoadToast(): Promise<void> {
		const processes = await this.pressureService.getProcessTreeSnapshot();
		const descriptor = createHeavyLoadNotificationDescriptor();
		const manageAction = new Action(
			MANAGE_PROCESSES_COMMAND_ID,
			MANAGE_PROCESSES_ACTION_LABEL,
			undefined,
			true,
			() => { this.openHeavyLoadModal({ processes, isEpisodeStart: false }); }
		);
		this.notificationService.notify({
			id: descriptor.id,
			severity: Severity.Warning,
			priority: NotificationPriority.URGENT,
			sticky: descriptor.sticky,
			message: descriptor.message,
			actions: { primary: [manageAction] },
		});
	}
}

registerSingleton(IAgentSystemPressureService, AgentSystemPressureService, InstantiationType.Delayed);

registerWorkbenchContribution2(
	AgentSystemPressureContribution.ID,
	AgentSystemPressureContribution,
	WorkbenchPhase.AfterRestored
);

// ---------------------------------------------------------------------------
// `cursor.resetInAppAdViews` — DEV-GAPS-64 W64A (follow-up F3 of DEV-GAPS-62/W62D)
// ---------------------------------------------------------------------------
//
// Binary-verbatim registration (Cursor 3.25.9, workbench.glass.main.js
// @45359415):
//   Ir({id:"cursor.resetInAppAdViews", title:"Reset In-App Ad Views",
//     icon:"discard", glassCategory:"Developer",
//     keywords:["ads","in-app","reset","views","devtools"], f1:!0,
//     run:async t=>{ if(t.get(jC).isBuilt) return; ... }})
// - `glassCategory:"Developer"` ports to `Categories.Developer` (this fork's
//   established mapping, e.g. ComposerToggleSandboxDebugLoggingAction).
// - `icon:"discard"` ports to Codicon.discard (registered at
//   src/vs/base/common/codiconsLibrary.ts:217).
// - The binary's `keywords` field has no IAction2Options counterpart (same
//   situation as `keybindingCategory` on the newAgent family); the verbatim
//   list is recorded on RESET_IN_APP_AD_VIEWS_KEYWORDS in common/.
// HONEST-DIVERGENCE: the binary's dev-build body (Zxx: ad-service
// resetUserAdViews + forceRefreshServerConfig, then a success/error
// notification) needs Cursor's ad/proto service, which this fork does not
// have — there are no in-app ads to reset. run() therefore returns early in
// built builds exactly like the binary and is otherwise a no-op; it never
// claims success for a reset that did not happen.
export class ResetInAppAdViewsAction extends Action2 {
	static readonly ID = RESET_IN_APP_AD_VIEWS_COMMAND_ID;
	constructor() {
		super({
			id: ResetInAppAdViewsAction.ID,
			title: nls.localize2('cursor.resetInAppAdViews', 'Reset In-App Ad Views'),
			category: Categories.Developer,
			icon: Codicon.discard,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const environmentService = accessor.get(IEnvironmentService);
		// Binary: `if(t.get(jC).isBuilt) return;` — jC.isBuilt is the build
		// flag; this fork's IEnvironmentService.isBuilt is the same signal.
		if (environmentService.isBuilt) {
			return;
		}
		// Dev builds: the binary resets ad views through its ad service and
		// notifies the verbatim success/error strings (kept in common/
		// next to RESET_IN_APP_AD_VIEWS_KEYWORDS). This fork has no ad
		// service and no in-app ads — nothing to reset.
	}
}

registerAction2(ResetInAppAdViewsAction);
