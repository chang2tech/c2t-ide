/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import {
	CLOSE_TOOLTIP_COMMAND_ID,
	ITooltipShowRequest,
	ITooltipStorage,
	LAST_SHOWN_TOOLTIP_TIME_KEY,
	SHOW_TOOLTIP_COMMAND_ID,
	TERMINAL_ADD_TOOLTIP_COMMAND_ID,
	TOOLTIP_GLOBAL_COOLDOWN_MS,
	TOOLTIP_GRACE_PERIOD_MS,
	TOOLTIP_INITIAL_DISABLED_PERIOD_MS,
	TOOLTIP_PIPELINES_STORAGE_KEY,
	TOOLTIP_SEQUENCE_TIMEOUT_MS,
	TOOLTIP_USER_CLOSE_DISABLE_MS,
	TooltipPipelineEngine,
	createTooltipPipelineConfigs,
	processTooltipEventSpec,
	tooltipModifierLabel,
} from '../../common/tooltipPipelines.js';

// GAPS-170 — entry #32 `inline-edit-onboarding-popups`: Cursor 3.25.9
// parity for the two Cmd+K onboarding tooltips. Binary evidence:
// ide-code-mission docs/rea/work-notes-gaps170.md Slice 1.
// These tests cover the pure logic in common/tooltipPipelines.ts:
//  A. verbatim constants (ids, storage keys, timings);
//  B. verbatim pipeline configs (events, popup copy, both platforms);
//  C. sequence-spec matcher semantics (_processEventInSequenceEvent);
//  D. the pipeline engine: trigger, gates (14d / cooldown / disabled),
//     disableOn, user-close, persistence.

class FakeStorage implements ITooltipStorage {
	readonly values = new Map<string, string>();
	get(key: string, _scope: number, fallbackValue?: string): string | undefined {
		return this.values.has(key) ? this.values.get(key) : fallbackValue;
	}
	store(key: string, value: string, _scope: number, _target: number): void {
		this.values.set(key, value);
	}
}

const DAY_MS = 24 * 60 * 60 * 1e3;

class Harness {
	readonly storage = new FakeStorage();
	readonly shown: ITooltipShowRequest[] = [];
	now = 1_700_000_000_000;
	readonly engine: TooltipPipelineEngine;
	constructor(isMacintosh = true) {
		this.engine = new TooltipPipelineEngine({
			storage: this.storage,
			onShow: (request) => { this.shown.push(request); },
			now: () => this.now,
		}, isMacintosh);
	}
	/** Feed events 1s apart (well inside the 120s sequence window). */
	feed(events: readonly string[]): void {
		for (const event of events) {
			this.now += 1000;
			this.engine.registerEvent(event);
		}
	}
	agePastInitialDisable(): void {
		this.now += TOOLTIP_INITIAL_DISABLED_PERIOD_MS + DAY_MS;
	}
	entry(name: string) {
		return this.engine.pipelinesState!.state.find(s => s.name === name)!;
	}
}

/** The editor workaround sequence (pipeline `editor.cmdk`, sequence 1). */
const EDITOR_WORKAROUND: readonly string[] = [
	'editor.copy.non_vim_mode',
	'chat.open',
	'chat.type',
	'chat.paste',
	'chat.type',
	'chat.submit',
	'editor.type.push_edit_operation',
	'chat.copy.codeblock.manual',
	'terminal.type',
	'editor.type.push_edit_operation',
	'editor.paste',
];

/** The terminal workaround sequence (pipeline `terminal.cmdk`). */
const TERMINAL_WORKAROUND: readonly string[] = [
	'terminal.focus',
	'chat.insert_selection.terminal.empty',
	'chat.type',
	'chat.submit',
	'editor.type.push_edit_operation',
	'chat.copy.codeblock.manual',
	'editor.type.push_edit_operation',
	'terminal.type',
	'terminal.paste',
];

suite('gaps170: tooltipPipelines (inline-edit-onboarding-popups parity)', () => {

	test('A: command + storage constants are binary-verbatim', () => {
		assert.strictEqual(SHOW_TOOLTIP_COMMAND_ID, 'cursor.showTooltipActionId');
		assert.strictEqual(CLOSE_TOOLTIP_COMMAND_ID, 'tooltip.close.register');
		assert.strictEqual(TERMINAL_ADD_TOOLTIP_COMMAND_ID, 'workbench.action.terminal.addTooltip');
		assert.strictEqual(TOOLTIP_PIPELINES_STORAGE_KEY, 'tooltipServicePipelines');
		assert.strictEqual(LAST_SHOWN_TOOLTIP_TIME_KEY, 'lastShownTooltipTime');
	});

	test('A: timing constants match the binary arithmetic', () => {
		assert.strictEqual(TOOLTIP_GLOBAL_COOLDOWN_MS, 14400 * 1e3); // 4h
		assert.strictEqual(TOOLTIP_INITIAL_DISABLED_PERIOD_MS, 336 * 60 * 60 * 1e3); // 14d
		assert.strictEqual(TOOLTIP_GRACE_PERIOD_MS, 720 * 60 * 6e4); // 30d
		assert.strictEqual(TOOLTIP_SEQUENCE_TIMEOUT_MS, 12e4); // 120s
		assert.strictEqual(TOOLTIP_USER_CLOSE_DISABLE_MS, 10 * 365 * 24 * 60 * 60 * 1e3); // 10y
	});

	test('B: popup copy is verbatim on mac and non-mac', () => {
		assert.strictEqual(tooltipModifierLabel(true), '\u2318');
		assert.strictEqual(tooltipModifierLabel(false), 'Ctrl');
		const mac = createTooltipPipelineConfigs(true);
		assert.strictEqual(mac[1].popup.header, 'Edit Code (\u2318 + K)');
		assert.strictEqual(mac[1].popup.subheader, 'You can select code and edit it in your editor using \u2318 + K');
		assert.strictEqual(mac[1].popup.location, 'editor');
		assert.strictEqual(mac[0].popup.header, 'Generate Terminal Command (\u2318 + K)');
		assert.strictEqual(mac[0].popup.subheader, 'You can use \u2318 + K to generate commands directly inside the terminal');
		assert.strictEqual(mac[0].popup.location, 'terminal');
		const win = createTooltipPipelineConfigs(false);
		assert.strictEqual(win[1].popup.header, 'Edit Code (Ctrl + K)');
		assert.strictEqual(win[0].popup.header, 'Generate Terminal Command (Ctrl + K)');
	});

	test('B: pipeline names, disableOn events and sequence shapes are verbatim', () => {
		const configs = createTooltipPipelineConfigs(true);
		assert.deepStrictEqual(configs.map(c => c.name), ['terminal.cmdk', 'editor.cmdk']);
		assert.deepStrictEqual(configs[0].disableOn.sequences[0].events, ['terminal.cmdk.submit']);
		assert.deepStrictEqual(configs[1].disableOn.sequences[0].events, ['editor.cmdk.submit']);
		assert.strictEqual(configs[0].disableOn.sequences[0].timeout_ms, 1 / 0);
		assert.strictEqual(configs[1].showOn.sequences.length, 2);
		assert.strictEqual(configs[1].showOn.sequences[0].events[0], 'editor.copy');
		assert.strictEqual(configs[1].showOn.sequences[1].events[0], 'chat.open');
		assert.strictEqual(configs[1].showOn.sequences[1].events[1], 'chat.insert_selection.editor.non_empty');
		assert.strictEqual(configs[0].showOn.sequences[0].events[8], 'terminal.paste');
	});

	test('C: string specs are prefix matches without multiple/skipping', () => {
		const m = processTooltipEventSpec('editor.copy.non_vim_mode', 'editor.copy');
		assert.deepStrictEqual(m, { isEventAccepted: true, shouldAllowMultipleOfCurrentEvent: false, isSkippingAllowed: false });
		assert.strictEqual(processTooltipEventSpec('editor.paste', 'editor.copy').isEventAccepted, false);
	});

	test('C: wildcard shapes accept anything with the binary flags', () => {
		assert.deepStrictEqual(processTooltipEventSpec('anything', ['*', '*']),
			{ isEventAccepted: true, shouldAllowMultipleOfCurrentEvent: true, isSkippingAllowed: false });
		assert.deepStrictEqual(processTooltipEventSpec('anything', ['*']),
			{ isEventAccepted: true, shouldAllowMultipleOfCurrentEvent: false, isSkippingAllowed: false });
		assert.deepStrictEqual(processTooltipEventSpec('anything', ['*', '_']),
			{ isEventAccepted: true, shouldAllowMultipleOfCurrentEvent: false, isSkippingAllowed: true });
		// The 3-item shape in editor.cmdk sequence 2 (`["*","_",
		// "chat.input.focus"]`) has only ONE "*", so the binary does NOT
		// take the accept-anything branch: it falls through to the group
		// rule — accepted only on a real prefix match, with the multiple
		// ("*") and skipping ("_") flags set.
		assert.deepStrictEqual(processTooltipEventSpec('chat.input.focus', ['*', '_', 'chat.input.focus']),
			{ isEventAccepted: true, shouldAllowMultipleOfCurrentEvent: true, isSkippingAllowed: true });
		assert.deepStrictEqual(processTooltipEventSpec('anything', ['*', '_', 'chat.input.focus']),
			{ isEventAccepted: false, shouldAllowMultipleOfCurrentEvent: true, isSkippingAllowed: true });
		// A genuine two-"*" 3-item shape does accept anything.
		assert.deepStrictEqual(processTooltipEventSpec('anything', ['*', '*', '_']),
			{ isEventAccepted: true, shouldAllowMultipleOfCurrentEvent: true, isSkippingAllowed: true });
	});

	test('C: group specs match by prefix; "!" negates; "*" multiple; "_" skipping', () => {
		const group = ['*', 'chat.type', 'chat.paste', '_'];
		assert.deepStrictEqual(processTooltipEventSpec('chat.type', group),
			{ isEventAccepted: true, shouldAllowMultipleOfCurrentEvent: true, isSkippingAllowed: true });
		assert.strictEqual(processTooltipEventSpec('editor.type', group).isEventAccepted, false);
		const negation = ['*', '!', 'chat.submit', 'editor.paste', '_'];
		assert.strictEqual(processTooltipEventSpec('editor.type.push_edit_operation', negation).isEventAccepted, true);
		assert.strictEqual(processTooltipEventSpec('chat.submit', negation).isEventAccepted, false);
		assert.strictEqual(processTooltipEventSpec('editor.paste', negation).isEventAccepted, false);
	});

	test('D: a fresh (<14d) pipeline never triggers', () => {
		const h = new Harness();
		h.feed(EDITOR_WORKAROUND);
		assert.strictEqual(h.shown.length, 0);
	});

	test('D: the editor workaround triggers the Edit Code popup after 14 days', () => {
		const h = new Harness();
		h.agePastInitialDisable();
		h.feed(EDITOR_WORKAROUND);
		assert.strictEqual(h.shown.length, 1);
		assert.deepStrictEqual(h.shown[0], {
			location: 'editor',
			header: 'Edit Code (\u2318 + K)',
			subheader: 'You can select code and edit it in your editor using \u2318 + K',
			name: 'editor.cmdk',
		});
		// Trigger side effects: 30d grace disable + lastShown recorded.
		assert.strictEqual(h.entry('editor.cmdk').disableStatus?.disabledUntil, h.now + TOOLTIP_GRACE_PERIOD_MS);
		assert.strictEqual(h.storage.values.get(LAST_SHOWN_TOOLTIP_TIME_KEY), String(h.now));
	});

	test('D: the terminal workaround triggers the Generate Terminal Command popup', () => {
		const h = new Harness();
		h.agePastInitialDisable();
		h.feed(TERMINAL_WORKAROUND);
		assert.strictEqual(h.shown.length, 1);
		assert.strictEqual(h.shown[0].name, 'terminal.cmdk');
		assert.strictEqual(h.shown[0].location, 'terminal');
		assert.strictEqual(h.shown[0].header, 'Generate Terminal Command (\u2318 + K)');
	});

	test('D: the 4h global cooldown gates on lastShownTooltipTime (seeded)', () => {
		// Seed persisted state the way a previous session would have left
		// it: pipelines 15 days old, a popup shown 1h ago.
		const seed = (lastShownAgoMs: number) => {
			const h = new Harness();
			const t0 = h.now;
			h.storage.values.set(TOOLTIP_PIPELINES_STORAGE_KEY, JSON.stringify({
				state: [
					{ name: 'terminal.cmdk', createdAt: t0 - 15 * DAY_MS },
					{ name: 'editor.cmdk', createdAt: t0 - 15 * DAY_MS },
				],
			}));
			h.storage.values.set(LAST_SHOWN_TOOLTIP_TIME_KEY, String(t0 - lastShownAgoMs));
			const engine = new TooltipPipelineEngine({
				storage: h.storage,
				onShow: (request) => { h.shown.push(request); },
				now: () => h.now,
			}, true);
			return { h, engine };
		};
		// 1h since the last popup (< 4h cooldown): suppressed.
		{
			const { h, engine } = seed(60 * 60 * 1e3);
			for (const event of TERMINAL_WORKAROUND) { h.now += 1000; engine.registerEvent(event); }
			assert.strictEqual(h.shown.length, 0);
		}
		// 5h since the last popup (> 4h cooldown): allowed.
		{
			const { h, engine } = seed(5 * 60 * 60 * 1e3);
			for (const event of TERMINAL_WORKAROUND) { h.now += 1000; engine.registerEvent(event); }
			assert.strictEqual(h.shown.length, 1);
			assert.strictEqual(h.shown[0].name, 'terminal.cmdk');
		}
		// And in one live engine: after the editor popup fires, a second
		// pipeline completing inside the same 4h window is suppressed.
		const h = new Harness();
		h.agePastInitialDisable();
		h.feed(EDITOR_WORKAROUND);
		assert.strictEqual(h.shown.length, 1);
		h.feed(TERMINAL_WORKAROUND);
		assert.strictEqual(h.shown.length, 1);
	});

	test('D: a sequence that stalls past 120s does not trigger', () => {
		const h = new Harness();
		h.agePastInitialDisable();
		h.feed(EDITOR_WORKAROUND.slice(0, 3));
		h.now += TOOLTIP_SEQUENCE_TIMEOUT_MS + 10_000;
		h.feed(EDITOR_WORKAROUND.slice(3));
		assert.strictEqual(h.shown.length, 0);
	});

	test('D: editor.cmdk.submit disables the editor pipeline for 30 days', () => {
		const h = new Harness();
		h.agePastInitialDisable();
		h.now += 1000;
		h.engine.registerEvent('editor.cmdk.submit');
		assert.strictEqual(h.entry('editor.cmdk').disableStatus?.disabledUntil, h.now + TOOLTIP_GRACE_PERIOD_MS);
		h.feed(EDITOR_WORKAROUND);
		assert.strictEqual(h.shown.length, 0);
	});

	test('D: clicking the popup (registerUserCloseTooltip) disables it for 10 years', () => {
		const h = new Harness();
		h.agePastInitialDisable();
		h.engine.registerUserCloseTooltip('editor.cmdk');
		assert.strictEqual(h.entry('editor.cmdk').disableStatus?.disabledUntil, h.now + TOOLTIP_USER_CLOSE_DISABLE_MS);
		h.feed(EDITOR_WORKAROUND);
		assert.strictEqual(h.shown.length, 0);
	});

	test('D: pipeline state persists across engine instances (storage round-trip)', () => {
		const h = new Harness();
		const createdAt = h.entry('terminal.cmdk').createdAt;
		h.engine.registerUserCloseTooltip('terminal.cmdk');
		const h2 = new Harness();
		h2.storage.values.set(TOOLTIP_PIPELINES_STORAGE_KEY, h.storage.values.get(TOOLTIP_PIPELINES_STORAGE_KEY)!);
		// Rebuild an engine over the persisted state.
		const engine2 = new TooltipPipelineEngine({
			storage: h2.storage,
			onShow: (request) => { h2.shown.push(request); },
			now: () => h2.now,
		}, true);
		const entry = engine2.pipelinesState!.state.find(s => s.name === 'terminal.cmdk')!;
		assert.strictEqual(entry.createdAt, createdAt);
		assert.strictEqual(entry.disableStatus?.disabledUntil, h.now + TOOLTIP_USER_CLOSE_DISABLE_MS);
	});
});
