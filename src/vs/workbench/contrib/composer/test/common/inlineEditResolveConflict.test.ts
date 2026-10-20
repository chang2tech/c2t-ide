/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { test } from 'node:test';
import type { IPromptBarDelegate } from '../../common/inlineEditPromptBar.js';
import { RESOLVE_CONFLICT_INIT_TEXT, setPromptBarTextAndSubmit } from '../../common/inlineEditPromptBar.js';

/**
 * GAPS-174 — `cmdK.resolveConflictInCmdK` (queue #33, feature_id
 * `inline-edit-resolve-conflict`).
 *
 * Evidence grounding (Cursor 3.25.9, re-sliced by GAPS-174):
 * - glass class `JcI` @40750760: id `OQp="cmdK.resolveConflictInCmdK"`
 *   (@15889598), title "Resolve Conflict in Cmd+K", f1:!1, no keybinding.
 * - run body: opens Cmd+K via `aipopup.action.modal.generate` with
 *   initText "Resolve this merge conflict", waits 50ms, looks the bar up,
 *   then:
 *     s.data.delegate.setText?.(o, o);
 *     let a = 0;
 *     do await sleep(150), a++;
 *     while ((delegate.numSubmitListeners?.() === 0
 *             || delegate.getText?.()?.trim() !== o) && a < 3);
 *     delegate.submit?.();
 *   `setPromptBarTextAndSubmit` is that sequence, ported verbatim (the
 *   50ms wait + bar lookup live in the action). These tests pin the poll
 *   arithmetic: setText first, at least one 150ms sleep, at most 3
 *   sleeps, and submit ALWAYS runs after the loop (even when the bar
 *   never became ready).
 */

class FakeDelegate implements IPromptBarDelegate {
	text = '';
	listeners = 1;
	/** When set, getText() returns this instead of the set text (simulates a bar whose input lags). */
	textOverride: string | undefined;
	/** Number of numSubmitListeners() calls before listeners becomes 1. */
	listenerDelayCalls = 0;
	readonly calls: string[] = [];
	private listenerCalls = 0;

	setText(text: string): void {
		this.calls.push(`setText:${text}`);
		this.text = text;
	}
	getText(): string {
		this.calls.push('getText');
		return this.textOverride ?? this.text;
	}
	numSubmitListeners(): number {
		this.calls.push('numSubmitListeners');
		this.listenerCalls++;
		return this.listenerCalls > this.listenerDelayCalls ? this.listeners : 0;
	}
	submit(): void {
		this.calls.push('submit');
	}
}

function sleepRecorder(): { sleeps: number[]; sleep: (ms: number) => Promise<void> } {
	const sleeps: number[] = [];
	return { sleeps, sleep: async (ms: number) => { sleeps.push(ms); } };
}

test('init text is the binary-verbatim literal', () => {
	assert.strictEqual(RESOLVE_CONFLICT_INIT_TEXT, 'Resolve this merge conflict');
});

test('ready bar: setText first, exactly one 150ms poll, then submit', async () => {
	const delegate = new FakeDelegate();
	const { sleeps, sleep } = sleepRecorder();
	await setPromptBarTextAndSubmit(delegate, RESOLVE_CONFLICT_INIT_TEXT, sleep);
	assert.deepStrictEqual(sleeps, [150]);
	assert.strictEqual(delegate.calls[0], `setText:${RESOLVE_CONFLICT_INIT_TEXT}`);
	assert.strictEqual(delegate.calls[delegate.calls.length - 1], 'submit');
	assert.strictEqual(delegate.calls.filter((c) => c === 'submit').length, 1);
});

test('submit listeners arriving on the 2nd poll → two 150ms sleeps, then submit', async () => {
	const delegate = new FakeDelegate();
	delegate.listenerDelayCalls = 1; // first numSubmitListeners() call returns 0
	const { sleeps, sleep } = sleepRecorder();
	await setPromptBarTextAndSubmit(delegate, RESOLVE_CONFLICT_INIT_TEXT, sleep);
	assert.deepStrictEqual(sleeps, [150, 150]);
	assert.strictEqual(delegate.calls[delegate.calls.length - 1], 'submit');
});

test('bar never ready: poll caps at 3 attempts and submit still runs (binary behavior)', async () => {
	const delegate = new FakeDelegate();
	delegate.listeners = 0;
	const { sleeps, sleep } = sleepRecorder();
	await setPromptBarTextAndSubmit(delegate, RESOLVE_CONFLICT_INIT_TEXT, sleep);
	assert.deepStrictEqual(sleeps, [150, 150, 150]);
	assert.strictEqual(delegate.calls.filter((c) => c === 'submit').length, 1);
});

test('text mismatch keeps polling (trimmed comparison) up to the cap', async () => {
	const delegate = new FakeDelegate();
	delegate.textOverride = 'something else';
	const { sleeps, sleep } = sleepRecorder();
	await setPromptBarTextAndSubmit(delegate, RESOLVE_CONFLICT_INIT_TEXT, sleep);
	assert.deepStrictEqual(sleeps, [150, 150, 150]);
	assert.strictEqual(delegate.calls[delegate.calls.length - 1], 'submit');
});

test('surrounding whitespace in the bar text still counts as ready (binary trims)', async () => {
	const delegate = new FakeDelegate();
	delegate.textOverride = `  ${RESOLVE_CONFLICT_INIT_TEXT}\n`;
	const { sleeps, sleep } = sleepRecorder();
	await setPromptBarTextAndSubmit(delegate, RESOLVE_CONFLICT_INIT_TEXT, sleep);
	assert.deepStrictEqual(sleeps, [150]);
	assert.strictEqual(delegate.calls[delegate.calls.length - 1], 'submit');
});
