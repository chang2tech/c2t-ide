/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: DEV-GAPS-105B — `airlock-container-attach` (audit-fix-queue P1, run 39).
//
// Pure model for Cursor's "airlock" (SpaceX-mode container attach), ported at
// the SAME layer Cursor uses: workbench core (this file = the shared/pure part;
// services + contribution live in `../browser/airlock.ts`). This file has NO
// imports on purpose so the logic can be unit-tested standalone.
//
// Binary evidence (Cursor 3.26.13, self-verified 2026-10-20 by DEV-GAPS-105B;
// 3.25.9 has ZERO `airlock` hits in both bundles — the feature is new in 3.26.13):
//
// - `glass-airlock-service.js` (workbench.glass.main.js): GlassAirlockService
//   with `_notifyFailure()` creating the connect-failed notification:
//     cf({id:"glass.airlock.tryAgain",label:"Try Again",run:()=>this.connect()})
//       @31138102 (the `glass.airlock.tryAgain` id string)
//     cf({id:"glass.airlock.openLog",label:"Open Log",run:()=>this._openerService.open(st.file(n))})
//       @31138203, secondary, ONLY when the error carries a `logPath`.
//   These are notification ACTIONS (factory `cf`), not registered commands.
//   Constants in the same module: `"_cursor.airlock.prepare"`,
//   `"cursorAuth.xaiIdentity.airlock"`, `"Connecting to the airlock"`,
//   `"Couldn't connect to the airlock"`; notification ids (table `dp`):
//   `"glass.airlock-connecting"` / `"glass.airlock-connect-failed"`.
// - Workbench (desktop) surface (workbench.desktop.main.js @40885k-40891k,
//   mirrored in the glass bundle @48770k): contribution
//   `workbench.contrib.airlock` (AfterRestored), context key
//   `cursor.airlockCanConnect` (default false, nls 4823 "Whether this window
//   can open the SpaceX airlock"), Action2 `cursor.airlock.connect`
//   (title nls 4828 "Connect to Airlock", `f1:!0` = palette-visible,
//   precondition = the context key), commands `_cursor.airlock.prepare` and
//   `_cursor.airlock.configuredContainer`, failure actions
//   `airlock.openLog` (nls 4826 "Open Log") and `airlock.reloadWindow`
//   (nls 4827 "Reload Window"), progress title nls 4825
//   "Connecting to the airlock" at location 15 (Notification).
// - `airlockAttach.js`: `attached-container` authority kind; remote authority
//   kinds ["attached-container","dev-container","k8s-container","apple-container"];
//   Dev Containers extension id `"anysphere.remote-containers"`.
// - Config registry (both bundles @44032339 glass): section id `cursorAirlock`,
//   order 21, title nls 12415 "SpaceX Airlock", the 10 properties in
//   AIRLOCK_CONFIGURATION_PROPERTIES below (scope 1 = APPLICATION, each with a
//   device-management policy). Main-process `airlockConfig.js`/`airlockPolicy.js`
//   (out/main.js @2219k-2220k) holds the validation ported here.
//
// HONEST DIVERGENCES (do not claim full Cursor parity):
// - This file is only the model. The container lifecycle backend (docker/podman
//   engine + hook scripts + log file, Cursor's main-process `airlockMainService`)
//   does NOT exist in this fork, and neither does SpaceX mode — see
//   `../browser/airlock.ts` for the service-level divergences.

/** `_cursor.airlock.prepare` — CommandsRegistry id (binary `VS_`/`JS_`). */
export const AIRLOCK_PREPARE_COMMAND_ID = '_cursor.airlock.prepare';

/** `_cursor.airlock.configuredContainer` — CommandsRegistry id (binary `KS_`). */
export const AIRLOCK_CONFIGURED_CONTAINER_COMMAND_ID = '_cursor.airlock.configuredContainer';

/** `cursor.airlock.connect` — desktop Action2 id (binary `f9w`). */
export const AIRLOCK_CONNECT_COMMAND_ID = 'cursor.airlock.connect';

/** Action2 title, verbatim (nls 4828). */
export const AIRLOCK_CONNECT_TITLE = 'Connect to Airlock';

/** Glass project-selector footer label, verbatim (glass bundle `z2c`). */
export const AIRLOCK_CONNECT_FOOTER_LABEL = 'Connect to Airlock';

/** Context key id, verbatim (binary `CNx`/`Mhg`). */
export const AIRLOCK_CAN_CONNECT_CONTEXT_KEY = 'cursor.airlockCanConnect';

/** Context key description, verbatim (nls 4823). */
export const AIRLOCK_CAN_CONNECT_DESCRIPTION = 'Whether this window can open the SpaceX airlock';

/** Contribution id, verbatim (binary `workbench.contrib.airlock`). */
export const AIRLOCK_CONTRIBUTION_ID = 'workbench.contrib.airlock';

/** Dev Containers extension id checked by the prepare checker (binary `YS_`). */
export const AIRLOCK_DEV_CONTAINERS_EXTENSION_ID = 'anysphere.remote-containers';

/** Configuration section key (binary `Kxc`). */
export const AIRLOCK_CONFIGURATION_SECTION = 'cursorAuth.xaiIdentity.airlock';

/** Notification id of the in-progress toast (binary `dp.airlockConnecting`). */
export const GLASS_AIRLOCK_CONNECTING_NOTIFICATION_ID = 'glass.airlock-connecting';

/** Notification id of the failure toast (binary `dp.airlockConnectFailed`). */
export const GLASS_AIRLOCK_CONNECT_FAILED_NOTIFICATION_ID = 'glass.airlock-connect-failed';

/** Connecting toast message, verbatim (binary `e0_`; also nls 4825). */
export const AIRLOCK_CONNECTING_MESSAGE = 'Connecting to the airlock';

/** Failure toast title, verbatim (binary `Yxc`). */
export const AIRLOCK_CONNECT_FAILED_TITLE = "Couldn't connect to the airlock";

/** Glass failure-toast primary action (binary @31138102). */
export const GLASS_AIRLOCK_TRY_AGAIN_ACTION_ID = 'glass.airlock.tryAgain';
export const GLASS_AIRLOCK_TRY_AGAIN_LABEL = 'Try Again';

/** Glass failure-toast secondary action (binary @31138203). */
export const GLASS_AIRLOCK_OPEN_LOG_ACTION_ID = 'glass.airlock.openLog';

/** Desktop failure action (binary `QTu.showFailure`). */
export const AIRLOCK_OPEN_LOG_ACTION_ID = 'airlock.openLog';
export const AIRLOCK_RELOAD_WINDOW_ACTION_ID = 'airlock.reloadWindow';

/** "Open Log" label, verbatim (glass literal; desktop nls 4826). */
export const AIRLOCK_OPEN_LOG_LABEL = 'Open Log';

/** "Reload Window" label, verbatim (nls 4827). */
export const AIRLOCK_RELOAD_WINDOW_LABEL = 'Reload Window';

/** Fallback prepare error, verbatim (binary `AiT`). */
export const AIRLOCK_PREPARE_FALLBACK_MESSAGE = "Cursor couldn't get the airlock ready.";

/** Dev-Containers-missing error, verbatim (nls 4824). */
export const AIRLOCK_DEV_CONTAINERS_MISSING_MESSAGE = "Cursor opens the airlock with the Dev Containers extension, which isn't installed or is turned off.";

/** Attached-container authority kind (binary `THs`/`AVa`). */
export const ATTACHED_CONTAINER_AUTHORITY_KIND = 'attached-container';

/** Remote authority kinds the airlock resolver is registered for (binary `Gxc`/`Rhg`). */
export const AIRLOCK_REMOTE_AUTHORITY_KINDS: readonly string[] = ['attached-container', 'dev-container', 'k8s-container', 'apple-container'];

/** Container-id (prefix) pattern, verbatim (binary `TiT`/`y9w`, attachedContainerAuthority.js). */
export const AIRLOCK_CONTAINER_ID_PATTERN = /^[0-9a-f]{12,64}$/;

/** Progress delay (ms) used by the resolver's prepareConnection (binary `TNx`/`w9w` = 500). */
export const AIRLOCK_RESOLVER_PROGRESS_DELAY_MS = 500;

// ---------------------------------------------------------------------------
// Errors / availability (binary `airlock.js` + `zqf`/`rvt` + main `airlockMainService`)
// ---------------------------------------------------------------------------

export type AirlockStep = 'inspect' | 'create' | 'start' | 'wait' | 'preAttach' | 'serverCheck' | 'attach' | 'restart' | 'status' | string;

export interface IAirlockError {
	readonly code?: string;
	readonly step?: AirlockStep;
	readonly message: string;
	readonly logPath?: string;
}

export type AirlockAvailability =
	| { readonly kind: 'disabled' }
	| { readonly kind: 'unconfigured' }
	| { readonly kind: 'invalid'; readonly reason: string }
	| { readonly kind: 'signedOut' }
	| { readonly kind: 'available'; readonly containerName: string; readonly defaultWorkspace: string };

/**
 * Binary `zqf`/`rvt`: map an availability failure to the error shown for a step.
 * Messages verbatim from nls 1802-1805.
 */
export function airlockAvailabilityError(availability: AirlockAvailability, step: AirlockStep): IAirlockError | undefined {
	switch (availability.kind) {
		case 'disabled':
			return { code: 'disabled', step, message: 'The airlock is only available in SpaceX mode.' };
		case 'unconfigured':
			return { code: 'notConfigured', step, message: "IT hasn't set up the airlock on this computer." };
		case 'invalid':
			return { code: 'notConfigured', step, message: `IT's airlock settings on this computer can't be used: ${availability.reason}` };
		case 'signedOut':
			return { code: 'signedOut', step, message: 'Sign in with your SpaceX account to use the airlock.' };
		case 'available':
			return undefined;
	}
}

/** Binary step labels (`xiT` in glass-airlock-service.js), verbatim. */
export function airlockStepLabel(step: AirlockStep): string {
	switch (step) {
		case 'inspect': return 'Looking for the container';
		case 'create': return 'Creating the container';
		case 'start': return 'Starting the container';
		case 'wait': return 'Waiting for the container to start';
		case 'preAttach': return 'Preparing the container';
		case 'serverCheck': return 'Checking for the Cursor server';
		case 'attach': return 'Getting Dev Containers ready';
		case 'restart': return 'Restarting the container';
		case 'status': return 'Checking the container';
		default: return step;
	}
}

/** Binary `RiT`: format an error for the failure toast description. */
export function formatAirlockFailure(error: IAirlockError): string {
	return error.step === undefined ? error.message : `${airlockStepLabel(error.step)}: ${error.message}`;
}

// ---------------------------------------------------------------------------
// Configuration (binary config registry + main `airlockPolicy.js`/`airlockConfig.js`)
// ---------------------------------------------------------------------------

export interface IAirlockConfigurationProperty {
	readonly key: string;
	readonly policyName: string;
	readonly type: 'string' | 'number';
	readonly defaultValue: string | number;
	readonly minimum?: number;
	/** Verbatim description (nls 12416-12425). */
	readonly description: string;
}

/**
 * The 10 airlock properties, in binary registration order. Keys are
 * `cursorAuth.xaiIdentity.airlock.*`; policy names are the device-management
 * policy names (also what validation messages interpolate as `{0}`).
 */
export const AIRLOCK_CONFIGURATION_PROPERTIES: readonly IAirlockConfigurationProperty[] = [
	{ key: 'cursorAuth.xaiIdentity.airlock.containerName', policyName: 'AirlockContainerName', type: 'string', defaultValue: '', description: 'Name of the local Docker or Podman container that Cursor prepares and opens while SpaceX mode is on (set via device management). Required for the airlock.' },
	{ key: 'cursorAuth.xaiIdentity.airlock.defaultWorkspace', policyName: 'AirlockDefaultWorkspace', type: 'string', defaultValue: '', description: 'Absolute path of the folder inside the airlock container that Cursor opens (set via device management). Required for the airlock.' },
	{ key: 'cursorAuth.xaiIdentity.airlock.containerUser', policyName: 'AirlockContainerUser', type: 'string', defaultValue: '', description: "User that Cursor runs as inside the airlock container (set via device management). When empty, Cursor uses the container's default user." },
	{ key: 'cursorAuth.xaiIdentity.airlock.engine', policyName: 'AirlockEngine', type: 'string', defaultValue: '', description: 'Container engine command for the airlock (set via device management): docker, podman, the absolute path of either, or the absolute path of a wrapper script that runs every engine command. When empty, Cursor uses docker.' },
	{ key: 'cursorAuth.xaiIdentity.airlock.createContainerHook', policyName: 'AirlockCreateContainerHook', type: 'string', defaultValue: '', description: "Absolute path of the script that creates the airlock container when it doesn't exist (set via device management)." },
	{ key: 'cursorAuth.xaiIdentity.airlock.startContainerHook', policyName: 'AirlockStartContainerHook', type: 'string', defaultValue: '', description: "Absolute path of the script that starts the airlock container when it isn't running (set via device management). When empty, Cursor runs the engine's own start command." },
	{ key: 'cursorAuth.xaiIdentity.airlock.preAttachContainerHook', policyName: 'AirlockPreAttachContainerHook', type: 'string', defaultValue: '', description: 'Absolute path of the script that Cursor runs each time, just before it opens the airlock container (set via device management).' },
	{ key: 'cursorAuth.xaiIdentity.airlock.restartContainerHook', policyName: 'AirlockRestartContainerHook', type: 'string', defaultValue: '', description: "Absolute path of the script that restarts the airlock container (set via device management). When empty, Cursor runs the engine's own restart command." },
	{ key: 'cursorAuth.xaiIdentity.airlock.containerStatusHook', policyName: 'AirlockContainerStatusHook', type: 'string', defaultValue: '', description: "Absolute path of the script that reports the airlock container's status as JSON (set via device management)." },
	{ key: 'cursorAuth.xaiIdentity.airlock.hookTimeoutSeconds', policyName: 'AirlockHookTimeoutSeconds', type: 'number', defaultValue: 120, minimum: 1, description: 'How long, in seconds, Cursor lets each airlock hook script run, and waits for the container to start, before it gives up (set via device management).' },
];

/** Policy name -> configuration key, in registration order. */
export const AIRLOCK_POLICY_NAMES: readonly string[] = AIRLOCK_CONFIGURATION_PROPERTIES.map(p => p.policyName);

export type AirlockHookEvent = 'create_container' | 'start_container' | 'pre_attach_container' | 'restart_container' | 'container_status';

/** Binary `DRe`: hook event -> policy name, in binary order. */
export const AIRLOCK_HOOK_POLICIES: readonly { readonly event: AirlockHookEvent; readonly policyName: string }[] = [
	{ event: 'create_container', policyName: 'AirlockCreateContainerHook' },
	{ event: 'start_container', policyName: 'AirlockStartContainerHook' },
	{ event: 'pre_attach_container', policyName: 'AirlockPreAttachContainerHook' },
	{ event: 'restart_container', policyName: 'AirlockRestartContainerHook' },
	{ event: 'container_status', policyName: 'AirlockContainerStatusHook' },
];

export interface IAirlockEngine {
	readonly kind: 'docker' | 'podman' | 'wrapper';
	readonly command: string;
}

export interface IResolvedAirlockConfig {
	readonly containerName: string;
	readonly defaultWorkspace: string;
	readonly containerUser?: string;
	readonly engine: IAirlockEngine;
	readonly hooks: Readonly<Partial<Record<AirlockHookEvent, string>>>;
	readonly hookTimeoutMs: number;
}

export type AirlockConfigResolution =
	| { readonly kind: 'unconfigured' }
	| { readonly kind: 'invalid'; readonly reason: string }
	| { readonly kind: 'ready'; readonly config: IResolvedAirlockConfig };

export interface IAirlockPathSemantics {
	readonly isWindows: boolean;
	/** Environment for Windows `%VAR%` expansion (binary `uvt`); ignored elsewhere. */
	readonly env?: Readonly<Record<string, string | undefined>>;
}

const CONTAINER_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/; // binary `LRe`
const CONTAINER_USER_PATTERN = /^[^\s:-][^\s:]*(:[^\s:]+)?$/; // binary `URe`

function isNonEmptyValue(value: unknown): boolean { // binary `dvt`/`PiT`
	return value !== undefined && !(typeof value === 'string' && value.trim() === '');
}

/** Binary `MiT`: is the airlock configured at all (any policy value non-empty)? */
export function isAirlockConfigured(readPolicy: (policyName: string) => unknown): boolean {
	return AIRLOCK_POLICY_NAMES.some(name => isNonEmptyValue(readPolicy(name)));
}

function isAbsolutePath(path: string, isWindows: boolean): boolean {
	if (isWindows) {
		return /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('\\\\') || path.startsWith('\\');
	}
	return path.startsWith('/');
}

function pathBasename(path: string, isWindows: boolean): string {
	const parts = path.split(isWindows ? /[\\/]/ : /\//);
	return parts[parts.length - 1] ?? '';
}

function expandWindowsEnv(value: string, env: Readonly<Record<string, string | undefined>>): string { // binary `uvt`
	return value.replace(/%([^%]+)%/g, (match, name: string) => {
		const key = Object.keys(env).find(k => k.toLowerCase() === name.toLowerCase());
		return (key === undefined ? undefined : env[key]) ?? match;
	});
}

class AirlockConfigError extends Error { } // binary `Pi`

function readStringValue(readPolicy: (policyName: string) => unknown, policyName: string): string | undefined { // binary `z_`
	const value = readPolicy(policyName);
	if (value !== undefined) {
		if (typeof value !== 'string') {
			throw new AirlockConfigError(`${policyName} must be a string.`); // nls 1813
		}
		return value.trim() || undefined;
	}
	return undefined;
}

function readHookTimeoutMs(readPolicy: (policyName: string) => unknown): number { // binary `lvt` * 1000
	const policyName = 'AirlockHookTimeoutSeconds';
	const value = readPolicy(policyName);
	if (value === undefined || value === '') {
		return 120 * 1000;
	}
	const seconds = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : NaN;
	if (!Number.isFinite(seconds) || seconds <= 0) {
		throw new AirlockConfigError(`${policyName} must be a positive number of seconds.`); // nls 1814
	}
	return seconds * 1000;
}

function classifyEngine(command: string, isWindows: boolean): IAirlockEngine { // binary `ovt`
	const name = pathBasename(command, isWindows).toLowerCase().replace(/\.exe$/, '');
	return { kind: name === 'docker' || name === 'podman' ? name : 'wrapper', command };
}

function resolveConfigOrThrow(readPolicy: (policyName: string) => unknown, paths: IAirlockPathSemantics): IResolvedAirlockConfig { // binary `cvt`
	const expand = (value: string) => paths.isWindows ? expandWindowsEnv(value, paths.env ?? {}) : value;

	const containerName = readStringValue(readPolicy, 'AirlockContainerName');
	if (containerName === undefined) {
		throw new AirlockConfigError(`AirlockContainerName isn't set.`); // nls 1806
	}
	if (!CONTAINER_NAME_PATTERN.test(containerName)) {
		throw new AirlockConfigError(`AirlockContainerName must be a container name: letters, digits, '_', '.' and '-', starting with a letter or digit.`); // nls 1807
	}

	const defaultWorkspace = readStringValue(readPolicy, 'AirlockDefaultWorkspace');
	if (defaultWorkspace === undefined) {
		throw new AirlockConfigError(`AirlockDefaultWorkspace isn't set.`); // nls 1808
	}
	if (!isAbsolutePath(defaultWorkspace, paths.isWindows)) {
		throw new AirlockConfigError(`AirlockDefaultWorkspace must be an absolute path inside the container.`); // nls 1809
	}

	const containerUser = readStringValue(readPolicy, 'AirlockContainerUser');
	if (containerUser !== undefined && !CONTAINER_USER_PATTERN.test(containerUser)) {
		throw new AirlockConfigError(`AirlockContainerUser must be a user name or id, optionally followed by ':' and a group.`); // nls 1810
	}

	const rawEngine = readStringValue(readPolicy, 'AirlockEngine');
	const engineCommand = rawEngine === undefined ? 'docker' : expand(rawEngine);
	const isBareName = pathBasename(engineCommand, paths.isWindows) === engineCommand;
	if (engineCommand.startsWith('-') || (!isBareName && !isAbsolutePath(engineCommand, paths.isWindows))) {
		throw new AirlockConfigError(`AirlockEngine must be docker, podman, or an absolute path.`); // nls 1811
	}

	const hooks: Partial<Record<AirlockHookEvent, string>> = {};
	for (const { event, policyName } of AIRLOCK_HOOK_POLICIES) {
		const raw = readStringValue(readPolicy, policyName);
		if (raw === undefined) {
			continue;
		}
		const hookPath = expand(raw);
		if (!isAbsolutePath(hookPath, paths.isWindows)) {
			throw new AirlockConfigError(`${policyName} must be an absolute path.`); // nls 1812
		}
		hooks[event] = hookPath;
	}

	return {
		containerName,
		defaultWorkspace,
		containerUser,
		engine: classifyEngine(engineCommand, paths.isWindows),
		hooks,
		hookTimeoutMs: readHookTimeoutMs(readPolicy),
	};
}

/**
 * Binary `avt` + main `toAvailability`/`getAvailability` (minus the SpaceX-mode
 * gate, which the caller applies): no non-empty policy value -> `unconfigured`;
 * first validation error -> `invalid` with the verbatim reason; otherwise
 * `available` with the container target.
 */
export function resolveAirlockAvailability(readPolicy: (policyName: string) => unknown, paths: IAirlockPathSemantics): AirlockAvailability {
	if (!AIRLOCK_POLICY_NAMES.some(name => isNonEmptyValue(readPolicy(name)))) {
		return { kind: 'unconfigured' };
	}
	try {
		const config = resolveConfigOrThrow(readPolicy, paths);
		return { kind: 'available', containerName: config.containerName, defaultWorkspace: config.defaultWorkspace };
	} catch (err) {
		if (err instanceof AirlockConfigError) {
			return { kind: 'invalid', reason: err.message };
		}
		throw err;
	}
}

/** Full resolved config (binary `cvt` result), or undefined when not ready. */
export function resolveAirlockConfig(readPolicy: (policyName: string) => unknown, paths: IAirlockPathSemantics): IResolvedAirlockConfig | undefined {
	try {
		if (!AIRLOCK_POLICY_NAMES.some(name => isNonEmptyValue(readPolicy(name)))) {
			return undefined;
		}
		return resolveConfigOrThrow(readPolicy, paths);
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// Attached-container authority (binary `airlockAttach.js` + `attachedContainerAuthority.js`)
// ---------------------------------------------------------------------------

function utf8Encode(text: string): number[] {
	const bytes: number[] = [];
	for (let i = 0; i < text.length; i++) {
		let code = text.charCodeAt(i);
		if (code < 0x80) {
			bytes.push(code);
		} else if (code < 0x800) {
			bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
		} else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
			const next = text.charCodeAt(i + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				code = 0x10000 + ((code - 0xd800) * 0x400) + (next - 0xdc00);
				i++;
				bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
			} else {
				bytes.push(0xef, 0xbf, 0xbd);
			}
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			bytes.push(0xef, 0xbf, 0xbd);
		} else {
			bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
		}
	}
	return bytes;
}

function utf8Decode(bytes: readonly number[]): string {
	let result = '';
	let i = 0;
	while (i < bytes.length) {
		const first = bytes[i];
		if (first < 0x80) {
			result += String.fromCharCode(first);
			i += 1;
		} else if ((first & 0xe0) === 0xc0 && i + 1 < bytes.length) {
			result += String.fromCharCode(((first & 0x1f) << 6) | (bytes[i + 1] & 0x3f));
			i += 2;
		} else if ((first & 0xf0) === 0xe0 && i + 2 < bytes.length) {
			result += String.fromCharCode(((first & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f));
			i += 3;
		} else if ((first & 0xf8) === 0xf0 && i + 3 < bytes.length) {
			const code = ((first & 0x07) << 18) | ((bytes[i + 1] & 0x3f) << 12) | ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f);
			const adjusted = code - 0x10000;
			result += String.fromCharCode(0xd800 + (adjusted >> 10), 0xdc00 + (adjusted & 0x3ff));
			i += 4;
		} else {
			result += '\ufffd';
			i += 1;
		}
	}
	return result;
}

/**
 * Binary `zS_`/`svt`: the vscode-remote authority + path for the airlock
 * container. Authority = `attached-container+<hex(utf8(JSON{containerName}))>`.
 */
export function buildAttachedContainerAuthority(containerName: string): string {
	const hex = utf8Encode(JSON.stringify({ containerName }))
		.map(b => b.toString(16).padStart(2, '0'))
		.join('');
	return `${ATTACHED_CONTAINER_AUTHORITY_KIND}+${hex}`;
}

/** Full URI string for the airlock workspace (scheme `vscode-remote`). */
export function buildAttachedContainerUriString(containerName: string, defaultWorkspace: string): string {
	return `vscode-remote://${buildAttachedContainerAuthority(containerName)}${defaultWorkspace}`;
}

function hexDecodeIdentifier(hex: string): string { // binary `EiT`/`S9w`
	const bytes: number[] = [];
	for (let n = 0; n + 2 <= hex.length; n += 2) {
		const pair = hex.slice(n, n + 2);
		if (!/^[0-9a-f]{2}$/i.test(pair)) {
			break;
		}
		bytes.push(parseInt(pair, 16));
	}
	return utf8Decode(bytes);
}

function extractContainerIdentifier(decoded: string, isAttachedContainer: boolean): string | undefined { // binary `IiT`/`k9w`
	let parsed: unknown;
	try {
		parsed = JSON.parse(decoded);
	} catch {
		return isAttachedContainer ? decoded : undefined;
	}
	if (parsed === null) {
		return isAttachedContainer ? decoded : undefined;
	}
	if (typeof parsed !== 'object') {
		return undefined;
	}
	const record = parsed as Record<string, unknown>;
	if ('containerId' in record && record.containerId) {
		return String(record.containerId);
	}
	if ('containerName' in record && record.containerName) {
		return String(record.containerName);
	}
	return undefined;
}

/**
 * Binary `CiT`/`b9w`: extract the container name/id encoded in a remote
 * authority of one of the airlock kinds; undefined for other authorities.
 * The result has leading `/` characters stripped, as in the binary.
 */
export function parseAirlockAuthority(authority: string): string | undefined {
	const plus = authority.indexOf('+');
	if (plus === -1) {
		return undefined;
	}
	const kind = authority.slice(0, plus);
	if (!AIRLOCK_REMOTE_AUTHORITY_KINDS.includes(kind)) {
		return undefined;
	}
	const [encoded] = authority.slice(plus + 1).split('@', 1);
	return extractContainerIdentifier(hexDecodeIdentifier(encoded), kind === ATTACHED_CONTAINER_AUTHORITY_KIND)?.replace(/^\/+/, '');
}

/** Binary `TiT`/`y9w`: is this a container-id (prefix)? */
export function isContainerId(value: string): boolean {
	return AIRLOCK_CONTAINER_ID_PATTERN.test(value);
}

/**
 * Binary resolver `isAirlock`: the authority's container is the airlock when
 * it equals the configured container name, or when it is a container-id prefix
 * of the running container's id.
 */
export function isAirlockContainer(identifier: string, containerName: string, runningContainerId: string | undefined): boolean {
	if (identifier === containerName) {
		return true;
	}
	if (isContainerId(identifier)) {
		return runningContainerId !== undefined && runningContainerId.startsWith(identifier);
	}
	return false;
}

// ---------------------------------------------------------------------------
// Prepare result + failure notification models
// ---------------------------------------------------------------------------

export type AirlockPrepareResult =
	| { readonly ok: true; readonly uriString: string }
	| { readonly ok: false; readonly error: IAirlockError };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

/**
 * Binary `AiT`: normalize the raw `_cursor.airlock.prepare` result. `uriToString`
 * extracts the URI string from a raw result's `uri` field (the binary checks
 * `st.isUri(t.uri)`); return undefined when it is not a URI.
 */
export function normalizePrepareResult(raw: unknown, uriToString: (value: unknown) => string | undefined): AirlockPrepareResult {
	if (isRecord(raw) && raw.ok === true) {
		const uriString = uriToString(raw.uri);
		if (uriString !== undefined) {
			return { ok: true, uriString };
		}
	}
	const error = isRecord(raw) && raw.ok === false ? raw.error : undefined;
	if (isRecord(error) && typeof error.message === 'string') {
		return {
			ok: false,
			error: {
				message: error.message,
				step: typeof error.step === 'string' ? error.step : undefined,
				logPath: typeof error.logPath === 'string' ? error.logPath : undefined,
			},
		};
	}
	return { ok: false, error: { message: AIRLOCK_PREPARE_FALLBACK_MESSAGE } };
}

/** Binary `ANx`/`E9w`: build a failed result with code + step "attach". */
export function airlockAttachError(code: string, message: string): AirlockPrepareResult {
	return { ok: false, error: { code, step: 'attach', message } };
}

export interface IAirlockActionModel {
	readonly id: string;
	readonly label: string;
}

export interface IGlassAirlockFailureNotification {
	readonly id: string;
	readonly severity: 'Error';
	readonly message: string;
	/** Binary `toastTitle` (fork notification service has no toast fields — see browser layer). */
	readonly toastTitle: string;
	/** Binary `toastDescription`. */
	readonly toastDescription: string;
	readonly sticky: true;
	readonly primary: readonly IAirlockActionModel[];
	readonly secondary: readonly IAirlockActionModel[];
}

/**
 * Binary GlassAirlockService._notifyFailure: message is
 * `"Couldn't connect to the airlock. <stepLabel>: <message>"` (or without the
 * step prefix), primary is always Try Again, secondary Open Log only when the
 * error carries a logPath.
 */
export function glassAirlockFailureNotification(error: IAirlockError): IGlassAirlockFailureNotification {
	const description = formatAirlockFailure(error);
	return {
		id: GLASS_AIRLOCK_CONNECT_FAILED_NOTIFICATION_ID,
		severity: 'Error',
		message: `${AIRLOCK_CONNECT_FAILED_TITLE}. ${description}`,
		toastTitle: AIRLOCK_CONNECT_FAILED_TITLE,
		toastDescription: description,
		sticky: true,
		primary: [{ id: GLASS_AIRLOCK_TRY_AGAIN_ACTION_ID, label: GLASS_AIRLOCK_TRY_AGAIN_LABEL }],
		secondary: error.logPath === undefined ? [] : [{ id: GLASS_AIRLOCK_OPEN_LOG_ACTION_ID, label: AIRLOCK_OPEN_LOG_LABEL }],
	};
}

/**
 * Binary `QTu.showFailure` (desktop): primary actions are Open Log (only with
 * a logPath) followed by Reload Window (only when `includeReloadWindow`,
 * which the binary sets to `!environmentService.isGlass` on the resolver path
 * and to false on the palette-command path).
 */
export function desktopAirlockFailureActions(error: IAirlockError, includeReloadWindow: boolean): IAirlockActionModel[] {
	const actions: IAirlockActionModel[] = [];
	if (error.logPath !== undefined) {
		actions.push({ id: AIRLOCK_OPEN_LOG_ACTION_ID, label: AIRLOCK_OPEN_LOG_LABEL });
	}
	if (includeReloadWindow) {
		actions.push({ id: AIRLOCK_RELOAD_WINDOW_ACTION_ID, label: AIRLOCK_RELOAD_WINDOW_LABEL });
	}
	return actions;
}
