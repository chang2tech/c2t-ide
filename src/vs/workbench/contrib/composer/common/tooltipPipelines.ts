/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE (GAPS-170, queue entry #32 `inline-edit-onboarding-popups`): pure
// logic for Cursor's two Cmd+K onboarding tooltips, dissected from Cursor
// 3.25.9 `workbench.desktop.main.js` (the glass bundle carries identical
// config/constants — glass offsets in the work notes). Full evidence:
// ide-code-mission `docs/rea/work-notes-gaps170.md` Slice 1.
//
// Layer note (how Cursor does it): this is NOT a first-use popup. Cursor
// ships a workbench-core `tooltipService` (DI `vn("tooltipService")`,
// module "tooltipService.js", desk@959050) driven by declarative
// event-sequence pipelines (module "tooltipPipelines.js", desk@957248):
// each pipeline watches a global event stream for the *manual workaround*
// that Cmd+K replaces (copy code -> ask chat -> copy the codeblock ->
// paste it back), and only then shows its popup via the command
// `cursor.showTooltipActionId`. Using Cmd+K for real (the `*.cmdk.submit`
// events) disables the pipeline for a 30-day grace period; clicking the
// popup disables it for 10 years (`registerUserCloseTooltip`).
//
// This module holds the dependency-free half (verbatim pipeline configs,
// storage keys, timing constants, the sequence matcher and the pipeline
// state engine) so it can be unit-tested standalone; the storage/command
// adapter + singleton lives in `browser/tooltipService.ts`, the popup DOM
// + editor/terminal anchors in `browser/tooltipUi.ts`.
//
// Pure module: ZERO imports (same convention as common/onboardingFlow.ts).

// ---------------------------------------------------------------------------
// Command + contribution identity (binary-verbatim)
// ---------------------------------------------------------------------------

/** `Yns` @478688 (constants.js) — executed by `_triggerPipeline` to show a popup. */
export const SHOW_TOOLTIP_COMMAND_ID = 'cursor.showTooltipActionId';

/** Binary title of the show command (action @24359337): "Show Tooltip", `f1:!1`. */
export const SHOW_TOOLTIP_TITLE = 'Show Tooltip';

/** `Xns` @478726 (constants.js) — executed by the popup when the user clicks it. */
export const CLOSE_TOOLTIP_COMMAND_ID = 'tooltip.close.register';

/** Binary title of the close command: "Register Close Tooltip", category "Tooltip", `f1:!1`. */
export const CLOSE_TOOLTIP_TITLE = 'Register Close Tooltip';
export const CLOSE_TOOLTIP_CATEGORY = 'Tooltip';

/**
 * Terminal action the binary's tooltip UI controller delegates to for
 * `location:"terminal"` popups (desk@21548617, `f1:!1`,
 * precondition terminalAvailable).
 */
export const TERMINAL_ADD_TOOLTIP_COMMAND_ID = 'workbench.action.terminal.addTooltip';

/** Editor contribution that renders popups (desk@24359221). */
export const TOOLTIP_UI_CONTROLLER_ID = 'editor.contrib.tooltipUiController';

/** Overlay widget id for the editor popup (UKo.getId(), desk@24358219). */
export const TOOLTIP_EDITOR_WIDGET_ID = 'tooltip.editorUiWidget';

/** DI token of the service: `EY = vn("tooltipService")` (desk@959279). */
export const TOOLTIP_SERVICE_ID = 'tooltipService';

// ---------------------------------------------------------------------------
// Storage keys + timing constants (binary-verbatim, module header @959140)
// ---------------------------------------------------------------------------

/** Binary scope/target numerics (fork enums match: APPLICATION=-1, MACHINE=1). */
export const TOOLTIP_STORAGE_SCOPE_APPLICATION = -1;
export const TOOLTIP_STORAGE_TARGET_MACHINE = 1;

/** `gwi = "tooltipServicePipelines"` — persisted pipeline state (JSON, scope -1, target 1). */
export const TOOLTIP_PIPELINES_STORAGE_KEY = 'tooltipServicePipelines';

/** `Nos = "lastShownTooltipTime"` — last popup time, epoch-ms string (scope -1, target 1). */
export const LAST_SHOWN_TOOLTIP_TIME_KEY = 'lastShownTooltipTime';

/** `tVc = 14400*1e3` — global cooldown between any two popups: 4 hours. */
export const TOOLTIP_GLOBAL_COOLDOWN_MS = 14400 * 1e3;

/** `nVc = 336*60*60*1e3` — default `initialDisabledPeriod_ms`: 14 days from `createdAt`. */
export const TOOLTIP_INITIAL_DISABLED_PERIOD_MS = 336 * 60 * 60 * 1e3;

/** `iVc = 3600*1e3` — `_maybeSavePipelineState` throttle: at most one save per hour. */
export const TOOLTIP_SAVE_THROTTLE_MS = 3600 * 1e3;

/** `720*60*6e4` in both pipelines' showOn/disableOn — 30 days. */
export const TOOLTIP_GRACE_PERIOD_MS = 720 * 60 * 6e4;

/** `12e4` — a showOn sequence must complete within 120 seconds. */
export const TOOLTIP_SEQUENCE_TIMEOUT_MS = 12e4;

/** `1/0` (Infinity) — the disableOn sequences never time out. */
export const TOOLTIP_DISABLE_SEQUENCE_TIMEOUT_MS = 1 / 0;

/** `10*365*24*60*60*1e3` in `registerUserCloseTooltip` — 10 years. */
export const TOOLTIP_USER_CLOSE_DISABLE_MS = 10 * 365 * 24 * 60 * 60 * 1e3;

// Popup render constants (`xNp`, desk@24355710): pulse every 10s, the
// popup auto-disposes after 600s, and disposes 1s after the click slide-out.
export const TOOLTIP_PULSE_INTERVAL_MS = 1e4; // tPb
export const TOOLTIP_AUTO_DISMISS_MS = 600 * 1e3; // nPb
export const TOOLTIP_CLOSE_DISPOSE_DELAY_MS = 1e3; // iPb
export const TOOLTIP_POPUP_WIDTH_PX = 280;

// ---------------------------------------------------------------------------
// Pipeline configs (tooltipPipelines.js, desk@957248 — verbatim)
// ---------------------------------------------------------------------------

/** One step of a sequence: a prefix string, or a wildcard/negation group. */
export type TooltipEventSpec = string | string[];

export interface ITooltipSequenceConfig {
	readonly events: readonly TooltipEventSpec[];
	readonly timeout_ms: number;
}

export interface ITooltipPipelineConfig {
	readonly name: string;
	readonly showOn: { readonly sequences: readonly ITooltipSequenceConfig[]; readonly gracePeriod_ms: number };
	readonly popup: { readonly header: string; readonly subheader: string; readonly location: string };
	readonly disableOn: { readonly sequences: readonly ITooltipSequenceConfig[]; readonly gracePeriod_ms: number };
	readonly initialDisabledPeriod_ms?: number;
}

/** `Jbn = Di ? "\u2318" : "Ctrl"` (Di = isMacintosh) at the top of tooltipPipelines.js. */
export function tooltipModifierLabel(isMacintosh: boolean): string {
	return isMacintosh ? '\u2318' : 'Ctrl';
}

/**
 * The two pipeline configs `eVc` (desk) / `peh` (glass), verbatim including
 * event order. The header/subheader are template literals over the modifier
 * label in the binary, so they are built per-platform here.
 */
export function createTooltipPipelineConfigs(isMacintosh: boolean): ITooltipPipelineConfig[] {
	const mod = tooltipModifierLabel(isMacintosh);
	return [
		{
			name: 'terminal.cmdk',
			showOn: {
				sequences: [{
					events: [
						['*', 'terminal.show', 'terminal.focus', 'terminal.type'],
						['*', 'chat.open', 'chat.input.focus', 'chat.insert_selection.terminal.empty'],
						['*', 'chat.type', 'chat.paste', '_'],
						'chat.submit',
						['*', '!', 'chat.submit', 'editor.paste', '_'],
						'chat.copy.codeblock',
						['*', '!', 'chat.submit', 'editor.type', 'editor.paste', '_'],
						['*', 'terminal.type', '_'],
						'terminal.paste',
					],
					timeout_ms: TOOLTIP_SEQUENCE_TIMEOUT_MS,
				}],
				gracePeriod_ms: TOOLTIP_GRACE_PERIOD_MS,
			},
			popup: {
				header: `Generate Terminal Command (${mod} + K)`,
				subheader: `You can use ${mod} + K to generate commands directly inside the terminal`,
				location: 'terminal',
			},
			disableOn: {
				sequences: [{ events: ['terminal.cmdk.submit'], timeout_ms: TOOLTIP_DISABLE_SEQUENCE_TIMEOUT_MS }],
				gracePeriod_ms: TOOLTIP_GRACE_PERIOD_MS,
			},
		},
		{
			name: 'editor.cmdk',
			showOn: {
				sequences: [
					{
						events: [
							'editor.copy',
							['*', 'chat.open', 'chat.input.focus', 'chat.insert_selection.editor.empty'],
							['*', 'chat.type', '_'],
							['*', 'chat.paste'],
							['*', 'chat.type', '_'],
							'chat.submit',
							['*', '!', 'chat.submit', 'editor.paste', '_'],
							'chat.copy.codeblock',
							['*', '!', 'chat.submit', 'terminal.paste', 'terminal.type', '_'],
							['*', 'editor.type', '_'],
							'editor.paste',
						],
						timeout_ms: TOOLTIP_SEQUENCE_TIMEOUT_MS,
					},
					{
						events: [
							'chat.open',
							'chat.insert_selection.editor.non_empty',
							['*', '_', 'chat.input.focus'],
							['*', 'chat.type', '_'],
							'chat.submit',
							['*', '!', 'chat.submit', 'terminal.paste', '_'],
							'chat.copy.codeblock',
							['*', '!', 'chat.submit', 'terminal.paste', 'terminal.type', '_'],
							['*', 'editor.type', '_'],
							'editor.paste',
						],
						timeout_ms: TOOLTIP_SEQUENCE_TIMEOUT_MS,
					},
				],
				gracePeriod_ms: TOOLTIP_GRACE_PERIOD_MS,
			},
			popup: {
				header: `Edit Code (${mod} + K)`,
				subheader: `You can select code and edit it in your editor using ${mod} + K`,
				location: 'editor',
			},
			disableOn: {
				sequences: [{ events: ['editor.cmdk.submit'], timeout_ms: TOOLTIP_DISABLE_SEQUENCE_TIMEOUT_MS }],
				gracePeriod_ms: TOOLTIP_GRACE_PERIOD_MS,
			},
		},
	];
}

// ---------------------------------------------------------------------------
// Sequence matcher (_processEventInSequenceEvent / _processEventInSequence)
// ---------------------------------------------------------------------------

export interface ITooltipEventMatch {
	readonly isEventAccepted: boolean;
	readonly shouldAllowMultipleOfCurrentEvent: boolean;
	readonly isSkippingAllowed: boolean;
}

/**
 * Verbatim port of `_processEventInSequenceEvent(event, spec)`:
 * - string spec: prefix match (`event.startsWith(spec)`), no multiple, no skipping;
 * - `["*","*"]`: accept anything, multiple allowed;
 * - 3 items with two `"*"` and one `"_"`: accept anything, multiple + skipping;
 * - `["*"]`: accept anything;
 * - 2 items with one `"*"` and one `"_"`: accept anything, skipping allowed;
 * - otherwise: `"!"` in the group negates (accepted when the event does NOT
 *   prefix-match any item), `"*"` allows multiple, `"_"` allows skipping.
 * (The `"*"`/`"_"`/`"!"` items themselves never prefix-match a real event,
 * exactly as in the binary's `t.some(o => e.startsWith(o))`.)
 */
export function processTooltipEventSpec(event: string, spec: TooltipEventSpec): ITooltipEventMatch {
	if (typeof spec === 'string') {
		return { isEventAccepted: event.startsWith(spec), shouldAllowMultipleOfCurrentEvent: false, isSkippingAllowed: false };
	}
	if (spec.length === 2 && spec[0] === '*' && spec[1] === '*') {
		return { isEventAccepted: true, shouldAllowMultipleOfCurrentEvent: true, isSkippingAllowed: false };
	}
	if (spec.length === 3 && spec.filter(o => o === '*').length === 2 && spec.filter(o => o === '_').length === 1) {
		return { isEventAccepted: true, shouldAllowMultipleOfCurrentEvent: true, isSkippingAllowed: true };
	}
	if (spec.length === 1 && spec[0] === '*') {
		return { isEventAccepted: true, shouldAllowMultipleOfCurrentEvent: false, isSkippingAllowed: false };
	}
	if (spec.length === 2 && spec.filter(o => o === '*').length === 1 && spec.filter(o => o === '_').length === 1) {
		return { isEventAccepted: true, shouldAllowMultipleOfCurrentEvent: false, isSkippingAllowed: true };
	}
	const negated = spec.includes('!');
	const multiple = spec.includes('*');
	const skipping = spec.includes('_');
	return {
		isEventAccepted: negated ? !spec.some(o => event.startsWith(o)) : spec.some(o => event.startsWith(o)),
		shouldAllowMultipleOfCurrentEvent: multiple,
		isSkippingAllowed: skipping,
	};
}

/** Non-persistent per-sequence progress (binary `_sequenceStates_nonPersistent`). */
export interface ITooltipSequenceState {
	activeEventIndices: number[];
	startTime: number | undefined;
	readonly sequenceKey: string;
}

export function createTooltipSequenceState(sequence: ITooltipSequenceConfig): ITooltipSequenceState {
	return { activeEventIndices: [], startTime: undefined, sequenceKey: tooltipSequenceKey(sequence) };
}

/**
 * The binary keys sequence states by `vC(JSON.stringify(config))` (a hash
 * whose algorithm is not recoverable from the bundle — UNKNOWN). The key
 * is only ever compared for equality inside the service, so the fork uses
 * the JSON string itself as the key; behavior is identical.
 */
export function tooltipSequenceKey(sequence: ITooltipSequenceConfig): string {
	return JSON.stringify(sequence);
}

/**
 * Verbatim port of `_processEventInSequence` (minus the debug-log array
 * `eyn`, which is empty in the shipped binary). Mutates `state`;
 * `onComplete` fires when the final step accepts the event, `onFail` when
 * the event was accepted by no active step (the caller resets the
 * sequence, exactly like the binary's fail callback).
 */
export function processTooltipEventInSequence(
	state: ITooltipSequenceState,
	sequence: ITooltipSequenceConfig,
	event: string,
	now: number,
	onComplete: () => void,
	onFail: () => void,
): void {
	if (state.activeEventIndices.length === 0) {
		state.activeEventIndices.push(0);
	}
	if (state.startTime !== undefined && now - state.startTime > sequence.timeout_ms) {
		// Binary quirk, verified by grepping every `startTime` site in
		// tooltipService.js: startTime is assigned exactly once (when a
		// step beyond the first accepts) and is NEVER cleared — so once a
		// sequence has timed out, this branch resets its indices on every
		// later event and the sequence stays dead for the rest of the
		// session (sequence states are non-persistent, so a restart
		// revives it). Ported as-is, not "fixed".
		state.activeEventIndices = [];
	}
	const active = state.activeEventIndices;
	let anyAccepted = false;
	let completed = false;
	const toAdd: number[] = [];
	const toRemovePositions: number[] = [];
	for (let h = 0; h < active.length; h++) {
		const p = active[h];
		const spec = sequence.events[p];
		const { shouldAllowMultipleOfCurrentEvent, isEventAccepted, isSkippingAllowed } = processTooltipEventSpec(event, spec);
		if (isSkippingAllowed) {
			if (p + 1 === sequence.events.length) {
				completed = true;
				onComplete();
				break;
			}
			if (!active.includes(p + 1)) {
				active.push(p + 1);
			}
		}
		if (isEventAccepted) {
			anyAccepted = true;
			if (state.startTime === undefined
				&& ((state.activeEventIndices.length === 1 && state.activeEventIndices[0] === 0 && !shouldAllowMultipleOfCurrentEvent)
					|| state.activeEventIndices.some(y => y > 0))) {
				state.startTime = now;
			}
			if (!state.activeEventIndices.includes(p + 1)) {
				toAdd.push(p + 1);
			}
			if (!shouldAllowMultipleOfCurrentEvent) {
				toRemovePositions.push(h);
			}
			if (p + 1 === sequence.events.length) {
				completed = true;
				onComplete();
				break;
			}
		}
	}
	if (!completed) {
		toRemovePositions.sort((a, b) => b - a);
		for (const h of toRemovePositions) {
			state.activeEventIndices.splice(h, 1);
		}
		for (const h of toAdd) {
			if (!state.activeEventIndices.includes(h)) {
				state.activeEventIndices.push(h);
			}
		}
		if (!anyAccepted) {
			onFail();
		}
	}
}

// ---------------------------------------------------------------------------
// Pipeline state engine (tooltipService class, desk@959050)
// ---------------------------------------------------------------------------

/** Minimal storage surface the engine needs (scope/target are the raw binary numbers). */
export interface ITooltipStorage {
	get(key: string, scope: number, fallbackValue?: string): string | undefined;
	store(key: string, value: string, scope: number, target: number): void;
}

export interface ITooltipPipelineStateEntry {
	name: string;
	disableStatus: { disabledUntil: number } | undefined;
	createdAt: number;
}

export interface ITooltipPipelinesState {
	state: ITooltipPipelineStateEntry[];
}

export interface ITooltipShowRequest {
	readonly location: string;
	readonly header: string;
	readonly subheader: string;
	readonly name: string;
}

export interface ITooltipEngineDeps {
	readonly storage: ITooltipStorage;
	/** Called for `_triggerPipeline`'s executeCommand(SHOW_TOOLTIP_COMMAND_ID, …). */
	readonly onShow: (request: ITooltipShowRequest) => void;
	/** Injectable clock for tests; defaults to Date.now. */
	readonly now?: () => number;
}

/**
 * Port of the binary `tooltipService` state machine. The four module
 * flags in the binary are all `!1` (false) in the shipped bundle —
 * `Oos` (skip cooldown), `IMe` (debug logs), `lft` (no persistence),
 * `rVc` (skip initial-disabled period) — so the fork ports the
 * false-branch behavior only, as noted per method.
 */
export class TooltipPipelineEngine {
	private readonly _storage: ITooltipStorage;
	private readonly _onShow: (request: ITooltipShowRequest) => void;
	private readonly _now: () => number;
	private readonly _pipelineConfigs: readonly ITooltipPipelineConfig[];
	private _pipelinesState: ITooltipPipelinesState | undefined;
	private readonly _sequenceStates: ITooltipSequenceState[] = [];
	private _lastStateSaveTime: number | undefined;
	private _initializedState = false;

	constructor(deps: ITooltipEngineDeps, isMacintosh: boolean) {
		this._storage = deps.storage;
		this._onShow = deps.onShow;
		this._now = deps.now ?? (() => Date.now());
		this._pipelineConfigs = createTooltipPipelineConfigs(isMacintosh);
		this._loadEventPipelineStates();
	}

	get pipelineConfigs(): readonly ITooltipPipelineConfig[] {
		return this._pipelineConfigs;
	}

	/** Test/debug snapshot of the persistent state (binary keeps it in `pipelinesState_persistent`). */
	get pipelinesState(): ITooltipPipelinesState | undefined {
		return this._pipelinesState;
	}

	// -- state loading / saving -------------------------------------------

	private _initializeEmptyStates(): void {
		const state: ITooltipPipelinesState = { state: [] };
		for (const config of this._pipelineConfigs) {
			state.state.push({ name: config.name, disableStatus: undefined, createdAt: this._now() });
		}
		this._pipelinesState = state;
		this._initializeEmptySequenceState();
	}

	private _initializeEmptySequenceState(): void {
		this._sequenceStates.length = 0;
		for (const config of this._pipelineConfigs) {
			for (const sequence of config.showOn.sequences) {
				this._sequenceStates.push(createTooltipSequenceState(sequence));
			}
			for (const sequence of config.disableOn.sequences) {
				this._sequenceStates.push(createTooltipSequenceState(sequence));
			}
		}
	}

	/** `_loadEventPipelineStates` — saved entries win by name; missing ones start fresh. */
	private _loadEventPipelineStates(): void {
		try {
			const raw = this._storage.get(TOOLTIP_PIPELINES_STORAGE_KEY, TOOLTIP_STORAGE_SCOPE_APPLICATION);
			if (!raw || raw === '') {
				this._initializeEmptyStates();
				return;
			}
			const parsed = JSON.parse(raw) as ITooltipPipelinesState;
			const state: ITooltipPipelinesState = { state: [] };
			for (const config of this._pipelineConfigs) {
				const saved = parsed.state.find(s => s.name === config.name);
				state.state.push(saved ?? { name: config.name, disableStatus: undefined, createdAt: this._now() });
			}
			this._pipelinesState = state;
		} catch {
			this._initializeEmptyStates();
		} finally {
			this._initializeEmptySequenceState();
			this._initializedState = true;
		}
	}

	private _getSavedEntryByName(name: string): ITooltipPipelineStateEntry | undefined {
		const raw = this._storage.get(TOOLTIP_PIPELINES_STORAGE_KEY, TOOLTIP_STORAGE_SCOPE_APPLICATION);
		if (!raw || raw === '') {
			this._initializeEmptyStates();
			return undefined;
		}
		return (JSON.parse(raw) as ITooltipPipelinesState).state.find(r => r.name === name);
	}

	/**
	 * `_updatePipelineStateIfDisabledInBackgroundIsHigher` — if the entry
	 * already persisted (e.g. by another window) has a later disabledUntil,
	 * it replaces the in-memory entry and is returned.
	 */
	private _entryWithHigherBackgroundDisable(name: string): ITooltipPipelineStateEntry | undefined {
		if (this._pipelinesState === undefined) {
			return undefined;
		}
		const index = this._pipelinesState.state.findIndex(s => s.name === name);
		if (index === -1) {
			return undefined;
		}
		const saved = this._getSavedEntryByName(name);
		const savedUntil = saved?.disableStatus?.disabledUntil;
		const localUntil = this._pipelinesState.state[index].disableStatus?.disabledUntil;
		if (saved === undefined || savedUntil === undefined) {
			return this._pipelinesState.state[index];
		}
		if (localUntil !== undefined && localUntil >= savedUntil) {
			return this._pipelinesState.state[index];
		}
		this._pipelinesState.state[index] = saved;
		return saved;
	}

	private _savePipelineState(): void {
		this._storage.store(TOOLTIP_PIPELINES_STORAGE_KEY, JSON.stringify(this._pipelinesState), TOOLTIP_STORAGE_SCOPE_APPLICATION, TOOLTIP_STORAGE_TARGET_MACHINE);
		this._lastStateSaveTime = this._now();
	}

	/** `_maybeSavePipelineState` — throttled to one save per hour. */
	private _maybeSavePipelineState(): void {
		if (this._lastStateSaveTime !== undefined && this._now() - this._lastStateSaveTime < TOOLTIP_SAVE_THROTTLE_MS) {
			return;
		}
		this._savePipelineState();
	}

	// -- sequence state -----------------------------------------------------

	private _getSequenceState(sequence: ITooltipSequenceConfig): ITooltipSequenceState | undefined {
		const key = tooltipSequenceKey(sequence);
		return this._sequenceStates.find(s => s.sequenceKey === key);
	}

	private _resetSequence(sequence: ITooltipSequenceConfig): void {
		const state = this._getSequenceState(sequence);
		if (state) {
			// Binary `_resetSequence` clears only activeEventIndices;
			// startTime deliberately survives (the timeout check in the
			// matcher re-arms from it on the next event).
			state.activeEventIndices = [];
		}
	}

	private _processSequence(
		sequence: ITooltipSequenceConfig,
		event: string,
		onComplete: () => void,
	): void {
		const state = this._getSequenceState(sequence);
		if (!state) {
			return;
		}
		processTooltipEventInSequence(state, sequence, event, this._now(), onComplete, () => this._resetSequence(sequence));
	}

	// -- trigger / disable ----------------------------------------------------

	/** `_triggerPipeline` — grace-disable 30d, show, record last-shown, save now. */
	private _triggerPipeline(config: ITooltipPipelineConfig): void {
		if (this._pipelinesState === undefined) {
			return;
		}
		for (const sequence of config.showOn.sequences) {
			this._resetSequence(sequence);
		}
		const entry = this._pipelinesState.state.find(n => n.name === config.name);
		if (entry) {
			entry.disableStatus = { disabledUntil: this._now() + config.showOn.gracePeriod_ms };
			this._onShow({ location: config.popup.location, header: config.popup.header, subheader: config.popup.subheader, name: config.name });
			this._storage.store(LAST_SHOWN_TOOLTIP_TIME_KEY, this._now().toString(), TOOLTIP_STORAGE_SCOPE_APPLICATION, TOOLTIP_STORAGE_TARGET_MACHINE);
			this._savePipelineState();
		}
	}

	/** `_disablePipeline` — 30d from the disableOn grace; only extends an existing disable. */
	private _disablePipeline(name: string): void {
		if (this._pipelinesState === undefined) {
			return;
		}
		const config = this._pipelineConfigs.find(r => r.name === name);
		let entry = this._pipelinesState.state.find(r => r.name === name);
		if (!config || !entry) {
			return;
		}
		entry = this._entryWithHigherBackgroundDisable(name);
		if (!entry) {
			return;
		}
		const newUntil = this._now() + config.disableOn.gracePeriod_ms;
		if (entry.disableStatus !== undefined && entry.disableStatus.disabledUntil > newUntil) {
			return;
		}
		for (const sequence of config.showOn.sequences) {
			this._resetSequence(sequence);
		}
		for (const sequence of config.disableOn.sequences) {
			this._resetSequence(sequence);
		}
		entry.disableStatus = { disabledUntil: newUntil };
		this._savePipelineState();
	}

	// -- public API (the binary service's two methods) ------------------------

	/**
	 * `registerEvent(event)` — the binary wraps this in a fire-and-forget
	 * promise raced against a 1 ms timeout (a leak guard that can drop
	 * events); the fork processes synchronously and drops nothing
	 * (divergence noted in browser/tooltipService.ts). Order per pipeline
	 * is the binary's: disableOn sequences first, then the disabled gate,
	 * then the 14-day initial-disabled gate, then showOn sequences with
	 * the 4-hour global cooldown checked at completion time.
	 */
	registerEvent(event: string): void {
		if (!this._initializedState || this._pipelinesState === undefined) {
			return;
		}
		for (const config of this._pipelineConfigs) {
			let entry = this._pipelinesState.state.find(s => s.name === config.name);
			if (entry === undefined) {
				continue;
			}
			for (const sequence of config.disableOn.sequences) {
				this._processSequence(sequence, event, () => this._disablePipeline(config.name));
			}
			if (entry.disableStatus) {
				if (entry.disableStatus.disabledUntil < this._now()) {
					entry.disableStatus = undefined;
					for (const sequence of config.showOn.sequences) {
						this._resetSequence(sequence);
					}
				} else {
					continue;
				}
			}
			const age = entry.createdAt ? this._now() - entry.createdAt : 0;
			const initialDisabledPeriod = config.initialDisabledPeriod_ms ?? TOOLTIP_INITIAL_DISABLED_PERIOD_MS;
			if (age <= initialDisabledPeriod) {
				continue;
			}
			for (const sequence of config.showOn.sequences) {
				this._processSequence(sequence, event, () => {
					const current = this._entryWithHigherBackgroundDisable(config.name);
					if (current?.disableStatus !== undefined && current.disableStatus.disabledUntil > this._now()) {
						return;
					}
					const lastShown = Number(this._storage.get(LAST_SHOWN_TOOLTIP_TIME_KEY, TOOLTIP_STORAGE_SCOPE_APPLICATION));
					const sinceLastShown = this._now() - lastShown;
					if (sinceLastShown > TOOLTIP_GLOBAL_COOLDOWN_MS || isNaN(sinceLastShown) || isNaN(lastShown)) {
						this._triggerPipeline(config);
					}
				});
			}
			entry = entry; // (entry identity is stable; kept for parity readability)
		}
		this._maybeSavePipelineState();
	}

	/** `registerUserCloseTooltip(name)` — clicking the popup disables it for 10 years. */
	registerUserCloseTooltip(name: string): void {
		if (this._pipelinesState === undefined) {
			return;
		}
		const entry = this._pipelinesState.state.find(n => n.name === name);
		if (entry !== undefined) {
			entry.disableStatus = { disabledUntil: this._now() + TOOLTIP_USER_CLOSE_DISABLE_MS };
			this._savePipelineState();
		}
	}
}
