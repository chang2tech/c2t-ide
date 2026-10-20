/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: DEV-GAPS-105B/105C — `airlock-container-attach` (audit-fix-queue P1, run 39).
//
// Browser/workbench layer for Cursor's "airlock" (SpaceX-mode container
// attach), at the SAME layer Cursor uses: workbench core, contrib/remote.
// The pure model (ids, verbatim strings, config validation, authority
// build/parse, failure-notification models) lives in `../common/airlock.ts`;
// see its header for the full binary evidence (Cursor 3.26.13, glass bundle
// `glass-airlock-service.js`, desktop bundle airlock contribution @40885k+;
// 3.25.9 has ZERO `airlock` hits — the feature is new in 3.26.13).
//
// What is ported here, following the binary's structure:
// - Configuration section `cursorAirlock` (order 21, title "SpaceX Airlock",
//   10 APPLICATION-scope properties from the model).
// - Context key `cursor.airlockCanConnect` (default false, description
//   "Whether this window can open the SpaceX airlock") + contribution
//   `workbench.contrib.airlock` (phase AfterRestored), which sets the key
//   from availability.
// - Action2 `cursor.airlock.connect` ("Connect to Airlock", `f1:!0` in the
//   binary = palette-visible, precondition = the context key). Its runner
//   mirrors desktop `QTu`: progress at ProgressLocation.Notification with
//   title "Connecting to the airlock" and NO progress delay — binary
//   `QTu.run()` calls its `withProgress` helper without a delay argument
//   (desktop @40888591/@40889173, re-verified by GAPS-124), so the delay is
//   undefined there. The 500 ms value (`w9w` desktop / `TNx` glass = 500)
//   belongs ONLY to the remote-authority resolver (`DVa`/`ZTu.run`, which
//   passes it into `prepareConnection`, desktop @40889807 / glass
//   @48773427); it is kept in the model as
//   `AIRLOCK_RESOLVER_PROGRESS_DELAY_MS` for that resolver path. (An
//   earlier version of this file wrongly passed 500 from `run()` and
//   described it as a "prepare delay" — corrected by GAPS-124 per QA
//   round 5, GAPS-116 ITEM 2 MINOR 1.) Then the desktop failure model
//   (`showFailure`: message verbatim, primary actions Open Log [only with
//   a logPath] + Reload Window [command path: not included, the binary
//   passes `false` there]).
// - CommandsRegistry `_cursor.airlock.prepare` and
//   `_cursor.airlock.configuredContainer` (binary `ENx`, registered at module
//   load in both bundles).
// - The prepare checker (binary `ppo`): availability must be `available`
//   (otherwise the verbatim availability error for step "inspect"), then the
//   Dev Containers extension `anysphere.remote-containers` must be installed
//   (local extension management server) and enabled, otherwise the verbatim
//   `devContainersMissing` error (step "attach").
// - The glass connect-status flow (binary GlassAirlockService): a sticky
//   Info notification `glass.airlock-connecting` ("Connecting to the
//   airlock", infinite progress) while connecting, and on failure a sticky
//   Error notification `glass.airlock-connect-failed` whose message is
//   "Couldn't connect to the airlock. <formatted failure>", with primary
//   action `glass.airlock.tryAgain` / "Try Again" (re-runs connect) and
//   secondary action `glass.airlock.openLog` / "Open Log" (opens the log
//   file) ONLY when the error carries a logPath.
//
// HONEST DIVERGENCES (do not claim full Cursor parity):
// - There is NO SpaceX mode service and NO main-process airlock backend
//   (docker/podman lifecycle, hook scripts, log file — Cursor's
//   `airlockMainService`) in this fork, and no `anysphere.remote-containers`
//   extension. Availability therefore gates on a hard `disabled` until a
//   SpaceX-mode equivalent exists: `getAvailability()` returns
//   `{ kind: 'disabled' }`, so the connect action stays hidden (precondition
//   false) and prepare fails with the verbatim SpaceX-mode error instead of
//   pretending a container was prepared. The policy-based resolution in the
//   model (`resolveAirlockAvailability`) is fully ported and unit-tested and
//   takes over the moment a SpaceX gate exists.
// - The fork's notification service has no `toastTitle` / `toastDescription`
//   / `closeNotificationOnToastDismiss` fields (those are Cursor's glass
//   toast patch); the failure notification carries the same text in
//   `message` and the same actions.
// - Error formatting in the glass catch path: the binary formats a caught
//   error with its shared formatter `fg(i)` (see the inline note in
//   `prepareAndOpen`). `fg` is `toErrorMessage` from
//   `vs/base/common/errorMessage.ts` — identified by GAPS-129 (QA round 7):
//   `function fg(` has a single definition in glass 3.26.13 @426690,
//   immediately before the `errorMessage.js` module marker, and its body
//   matches `toErrorMessage` branch for branch. The fork now calls
//   `toErrorMessage(err)` directly there, so this divergence is RESOLVED
//   (fixed by GAPS-133).
// - The fork has no core remote-authority-resolver registry (only the
//   extension API), so the resolver registration for the four authority
//   kinds in `AIRLOCK_REMOTE_AUTHORITY_KINDS` (binary `INx`, `lgy.register`)
//   is NOT wired; the authority build/parse/isAirlock logic is ported in
//   the model for when that registry exists.
// - The binary's `AirlockWindowState` (which also tracks remote-connection
//   reconnect state) is folded into the service's failure-notification
//   handle; the fork service does not own a remote connection.
// - The binary registers each config property with an old-style
//   device-management `policy: { name, minimumVersion: "1.99", defaultValue }`;
//   the fork's policy schema differs, so properties are registered without
//   the policy field (policy names are kept in the model, and the service
//   reads `policyValue` — section object first, then per property — when
//   resolving availability, exactly like the binary's `MiT`/`avt`).

import { IAction } from '../../../../base/common/actions.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator, IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationHandle, INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IProgressService, ProgressLocation } from '../../../../platform/progress/common/progress.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IExtensionManagementServerService, IWorkbenchExtensionEnablementService } from '../../../services/extensionManagement/common/extensionManagement.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import {
	AIRLOCK_CAN_CONNECT_CONTEXT_KEY, AIRLOCK_CAN_CONNECT_DESCRIPTION, AIRLOCK_CONFIGURATION_PROPERTIES,
	AIRLOCK_CONFIGURATION_SECTION, AIRLOCK_CONNECT_COMMAND_ID, AIRLOCK_CONNECT_TITLE,
	AIRLOCK_CONNECTING_MESSAGE, AIRLOCK_CONTRIBUTION_ID, AIRLOCK_CONFIGURED_CONTAINER_COMMAND_ID,
	AIRLOCK_DEV_CONTAINERS_EXTENSION_ID, AIRLOCK_DEV_CONTAINERS_MISSING_MESSAGE,
	AIRLOCK_OPEN_LOG_ACTION_ID, AIRLOCK_PREPARE_COMMAND_ID, AIRLOCK_PREPARE_FALLBACK_MESSAGE,
	GLASS_AIRLOCK_CONNECTING_NOTIFICATION_ID, GLASS_AIRLOCK_TRY_AGAIN_ACTION_ID,
	AirlockAvailability, AirlockPrepareResult, IAirlockError,
	airlockAttachError, airlockAvailabilityError, buildAttachedContainerUriString,
	desktopAirlockFailureActions, glassAirlockFailureNotification, resolveAirlockAvailability,
} from '../common/airlock.js';

/** Context key `cursor.airlockCanConnect` (binary `CNx`/`Mhg`). */
export const AirlockCanConnectContext = new RawContextKey<boolean>(AIRLOCK_CAN_CONNECT_CONTEXT_KEY, false, AIRLOCK_CAN_CONNECT_DESCRIPTION);

export const IAirlockService = createDecorator<IAirlockService>('airlockService');

export interface IAirlockService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeAvailability: Event<AirlockAvailability>;
	/** Binary main `airlockService.getAvailability` (via the workbench service). */
	getAvailability(): AirlockAvailability;
	/** Binary `airlockService.getConfiguredContainer` (`_cursor.airlock.configuredContainer` result). */
	getConfiguredContainer(): { readonly containerName: string } | undefined;
	/** Binary checker `ppo.prepare` (`_cursor.airlock.prepare` result). */
	prepare(): Promise<AirlockPrepareResult>;
	/** Binary GlassAirlockService.connect: connecting toast + failure toast (Try Again / Open Log). */
	connect(): Promise<void>;
	/** Binary desktop `QTu.showFailure` + `AirlockWindowState.showFailure/closeFailure`. */
	showDesktopFailure(error: IAirlockError, includeReloadWindow: boolean): void;
	closeDesktopFailure(): void;
}

class AirlockService extends Disposable implements IAirlockService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeAvailability = this._register(new Emitter<AirlockAvailability>());
	readonly onDidChangeAvailability: Event<AirlockAvailability> = this._onDidChangeAvailability.event;

	private _failureToast: INotificationHandle | undefined;
	private _desktopFailure: INotificationHandle | undefined;
	private _connecting = false;

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@INotificationService private readonly notificationService: INotificationService,
		@IOpenerService private readonly openerService: IOpenerService,
		@ILogService private readonly logService: ILogService,
		@IExtensionManagementServerService private readonly extensionManagementServerService: IExtensionManagementServerService,
		@IWorkbenchExtensionEnablementService private readonly extensionEnablementService: IWorkbenchExtensionEnablementService,
		@IHostService private readonly hostService: IHostService,
	) {
		super();
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(AIRLOCK_CONFIGURATION_SECTION)) {
				this._onDidChangeAvailability.fire(this.getAvailability());
			}
		}));
	}

	getAvailability(): AirlockAvailability {
		// HONEST DIVERGENCE: Cursor's main service returns `disabled` when
		// SpaceX mode is off. This fork has no SpaceX mode service at all, so
		// the gate is permanently off (see header). The policy resolution
		// below is the binary's `avt`/`toAvailability`, ready to take over.
		const spaceXModeEnabled = false;
		if (!spaceXModeEnabled) {
			return { kind: 'disabled' };
		}
		return resolveAirlockAvailability(name => this.readPolicyValue(name), { isWindows: false });
	}

	/**
	 * Binary `MiT`/`avt` policy reader: Cursor reads
	 * `inspect("cursorAuth.xaiIdentity.airlock").policyValue` as an object
	 * keyed by property; the fork exposes policy values per property too, so
	 * fall back to the per-property `policyValue`.
	 */
	private readPolicyValue(policyName: string): unknown {
		const sectionPolicy = this.configurationService.inspect(AIRLOCK_CONFIGURATION_SECTION).policyValue;
		const property = AIRLOCK_CONFIGURATION_PROPERTIES.find(p => p.policyName === policyName);
		if (sectionPolicy !== null && typeof sectionPolicy === 'object' && property) {
			const byKey = (sectionPolicy as Record<string, unknown>)[property.key];
			if (byKey !== undefined) {
				return byKey;
			}
			const byPolicyName = (sectionPolicy as Record<string, unknown>)[policyName];
			if (byPolicyName !== undefined) {
				return byPolicyName;
			}
		}
		return property ? this.configurationService.inspect(property.key).policyValue : undefined;
	}

	getConfiguredContainer(): { readonly containerName: string } | undefined {
		const availability = this.getAvailability();
		// Binary also returns `containerId` when the backend knows it; the
		// fork has no container backend, so it is omitted (UNKNOWN there).
		return availability.kind === 'available' ? { containerName: availability.containerName } : undefined;
	}

	async prepare(): Promise<AirlockPrepareResult> {
		const failed = await this.check();
		if (failed) {
			return failed;
		}
		// HONEST DIVERGENCE: the binary now calls the main-process airlock
		// backend (`airlockService.prepare()`), which does not exist in this
		// fork; report the binary's verbatim fallback error instead of
		// fabricating a prepared container.
		return { ok: false, error: { message: AIRLOCK_PREPARE_FALLBACK_MESSAGE } };
	}

	/** Binary checker `ppo.check` + `ppo.isDevContainersEnabled`. */
	private async check(): Promise<AirlockPrepareResult | undefined> {
		const availability = this.getAvailability();
		if (availability.kind !== 'available') {
			const error = airlockAvailabilityError(availability, 'inspect');
			return error ? { ok: false, error } : undefined;
		}
		if (!await this.isDevContainersEnabled()) {
			return airlockAttachError('devContainersMissing', AIRLOCK_DEV_CONTAINERS_MISSING_MESSAGE);
		}
		return undefined;
	}

	private async isDevContainersEnabled(): Promise<boolean> {
		const server = this.extensionManagementServerService.localExtensionManagementServer;
		const installed = server ? await server.extensionManagementService.getInstalled() : [];
		return installed.some(e => e.identifier.id.toLowerCase() === AIRLOCK_DEV_CONTAINERS_EXTENSION_ID && this.extensionEnablementService.isEnabled(e));
	}

	// -- Glass connect-status flow (binary GlassAirlockService) --------------

	async connect(): Promise<void> {
		if (this._connecting) {
			return;
		}
		this._connecting = true;
		try {
			await this.prepareAndOpen();
		} finally {
			this._connecting = false;
		}
	}

	private async prepareAndOpen(): Promise<void> {
		this._failureToast?.close();
		this._failureToast = undefined;

		const connecting = this.notificationService.notify({
			id: GLASS_AIRLOCK_CONNECTING_NOTIFICATION_ID,
			severity: Severity.Info,
			message: AIRLOCK_CONNECTING_MESSAGE,
			progress: { infinite: true },
			sticky: true,
		});

		let error: IAirlockError | undefined;
		try {
			const result = await this.prepare();
			if (result.ok) {
				error = await this.openPrepared(result.uriString);
			} else {
				error = result.error;
			}
		} catch (err) {
			this.logService.error('[GlassAirlock] Connecting to the airlock failed:', err);
			// Binary GlassAirlockService catch: `Cursor couldn't open the
			// airlock: ${fg(i)}` (glass 3.26.13, ~@31136172). `fg` is
			// `toErrorMessage` (`vs/base/common/errorMessage.ts`):
			// its single definition in the glass bundle is @426690,
			// immediately before the `errorMessage.js` module marker,
			// matching `toErrorMessage` branch for branch (identified
			// by GAPS-129, QA round 7; fixed by GAPS-133 — this path
			// previously used `err.message` / `String(err)`, which
			// differed for null, arrays and detail/stack objects).
			// In the fork's current disabled state this catch is not
			// reached with such values: `prepare()` fails earlier at
			// `check()` with a structured result instead of throwing.
			error = { message: `Cursor couldn't open the airlock: ${toErrorMessage(err)}` };
		} finally {
			connecting.close();
		}

		if (error) {
			this.notifyFailure(error);
		}
	}

	/** Binary GlassAirlockService._openPrepared (workspace-open part diverges: see header). */
	private async openPrepared(uriString: string): Promise<IAirlockError | undefined> {
		const availability = this.getAvailability();
		if (availability.kind !== 'available') {
			const availabilityError = airlockAvailabilityError(availability, 'inspect');
			return availabilityError ? { message: availabilityError.message } : undefined;
		}
		const expected = buildAttachedContainerUriString(availability.containerName, availability.defaultWorkspace);
		if (URI.parse(uriString).toString() !== URI.parse(expected).toString()) {
			this.logService.warn(`[GlassAirlock] Didn't open ${uriString}, which isn't the airlock's workspace ${expected}`);
			return { message: "Cursor didn't open the folder it was given, because it isn't the airlock's workspace." };
		}
		await this.hostService.openWindow([{ folderUri: URI.parse(uriString) }], { forceNewWindow: false });
		return undefined;
	}

	/** Binary GlassAirlockService._notifyFailure — Try Again / Open Log actions, verbatim. */
	private notifyFailure(error: IAirlockError): void {
		const model = glassAirlockFailureNotification(error);
		const toAction = (actionModel: { readonly id: string; readonly label: string }): IAction => ({
			id: actionModel.id,
			label: actionModel.label,
			tooltip: '',
			class: undefined,
			enabled: true,
			run: () => actionModel.id === GLASS_AIRLOCK_TRY_AGAIN_ACTION_ID
				? this.connect()
				: this.openerService.open(URI.file(error.logPath!)),
		});
		this._failureToast = this.notificationService.notify({
			id: model.id,
			severity: Severity.Error,
			message: model.message,
			sticky: true,
			actions: {
				primary: model.primary.map(toAction),
				secondary: model.secondary.map(toAction),
			},
		});
	}

	// -- Desktop failure surface (binary `QTu.showFailure`/`AirlockWindowState`) --

	showDesktopFailure(error: IAirlockError, includeReloadWindow: boolean): void {
		this.closeDesktopFailure();
		const actions: IAction[] = desktopAirlockFailureActions(error, includeReloadWindow).map(actionModel => ({
			id: actionModel.id,
			label: actionModel.label,
			tooltip: '',
			class: undefined,
			enabled: true,
			run: () => actionModel.id === AIRLOCK_OPEN_LOG_ACTION_ID
				? this.openerService.open(URI.file(error.logPath!))
				: this.hostService.reload(),
		}));
		this._desktopFailure = this.notificationService.notify({
			severity: Severity.Error,
			message: error.message,
			actions: actions.length === 0 ? undefined : { primary: actions },
		});
		const handle = this._desktopFailure;
		handle.onDidClose(() => {
			if (this._desktopFailure === handle) {
				this._desktopFailure = undefined;
			}
		});
	}

	closeDesktopFailure(): void {
		this._desktopFailure?.close();
		this._desktopFailure = undefined;
	}
}

registerSingleton(IAirlockService, AirlockService, InstantiationType.Delayed);

/** Binary desktop runner `QTu` (created per invocation via the instantiation service). */
class AirlockConnectRunner {

	constructor(
		@IAirlockService private readonly airlockService: IAirlockService,
		@IProgressService private readonly progressService: IProgressService,
	) { }

	/**
	 * Binary `QTu.run`: progress-wrapped connect; failure shown WITHOUT the
	 * reload action. NO progress delay is passed: binary `QTu.run()` calls
	 * `withProgress(connect)` with no delay argument (delay stays
	 * undefined). The 500 ms `AIRLOCK_RESOLVER_PROGRESS_DELAY_MS` belongs
	 * to the resolver's `prepareConnection` call, not to `run()` — see the
	 * header note (corrected by GAPS-124, QA round 5 MINOR 1).
	 */
	async run(): Promise<void> {
		const result = await this.progressService.withProgress(
			{ location: ProgressLocation.Notification, title: AIRLOCK_CONNECTING_MESSAGE },
			async () => this.airlockService.prepare(),
		);
		if (!result.ok) {
			this.airlockService.showDesktopFailure(result.error, false);
			return;
		}
		this.airlockService.closeDesktopFailure();
	}
}

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: AIRLOCK_CONNECT_COMMAND_ID,
			title: { value: AIRLOCK_CONNECT_TITLE, original: AIRLOCK_CONNECT_TITLE },
			f1: true, // binary `f1:!0` — palette-visible
			precondition: AirlockCanConnectContext,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const instantiationService = accessor.get(IInstantiationService);
		await instantiationService.createInstance(AirlockConnectRunner).run();
	}
});

/** Binary contribution `Car` (`workbench.contrib.airlock`, AfterRestored). */
class AirlockContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = AIRLOCK_CONTRIBUTION_ID;

	constructor(
		@IAirlockService airlockService: IAirlockService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();
		const canConnect = AirlockCanConnectContext.bindTo(contextKeyService);
		// Binary: `available && spaceXModeService.state.kind === "active"`.
		// The fork's availability already includes the SpaceX gate (see
		// AirlockService.getAvailability), so `available` is the whole check.
		const update = () => canConnect.set(airlockService.getAvailability().kind === 'available');
		update();
		this._register(airlockService.onDidChangeAvailability(() => update()));
	}
}

registerWorkbenchContribution2(AirlockContribution.ID, AirlockContribution, WorkbenchPhase.AfterRestored);

// Binary `ENx`: the two internal commands, registered at module load in both bundles.
CommandsRegistry.registerCommand(AIRLOCK_PREPARE_COMMAND_ID, accessor => accessor.get(IAirlockService).prepare());
CommandsRegistry.registerCommand(AIRLOCK_CONFIGURED_CONTAINER_COMMAND_ID, accessor => accessor.get(IAirlockService).getConfiguredContainer());

// Binary config registry: section `cursorAirlock`, order 21 (policy field
// omitted — see header divergence).
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration)
	.registerConfiguration({
		id: 'cursorAirlock',
		order: 21,
		title: localize('airlockConfigurationTitle', "SpaceX Airlock"),
		type: 'object',
		properties: Object.fromEntries(AIRLOCK_CONFIGURATION_PROPERTIES.map(property => [property.key, {
			type: property.type,
			default: property.defaultValue,
			...(property.minimum !== undefined ? { minimum: property.minimum } : {}),
			scope: ConfigurationScope.APPLICATION,
			description: property.description,
		}])),
	});
