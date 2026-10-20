/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { test } from 'node:test';
import type { IPromptBarRef } from '../../common/inlineEditPromptBar.js';
import { resolveModalGenerateTarget } from '../../common/inlineEditPromptBar.js';

/**
 * GAPS-171 — `aipopup.action.modal.generate` target resolution
 * (STILL-OPEN #26 remainder, feature_id `inline-edit-keybindings-gap`).
 *
 * Evidence grounding (Cursor 3.25.9, re-sliced by GAPS-171 from
 * workbench.glass.main.js class `goo` @40731968; desktop class `SLr`
 * @32228473 identical): StartEditPrompt's run body FIRST checks
 * `getPromptBars().filter(uri === activeUri)` — a non-empty result focuses
 * the LAST such bar (insertEditSelection when the selection is non-empty,
 * else focusEdit) for EVERY invocationType. Only afterwards does the
 * toggle branch run: `invocationType === "toggle"` with a `promptBarId`
 * arg executes `aipopup.action.nextPromptBar` with that id. Anything else
 * creates a new prompt bar. The binary's most-recent-bar group-visibility
 * jump is not ported (fork refs carry no editorId/group signal — see the
 * docblock on `resolveModalGenerateTarget`).
 */

const URI_A = 'file:///src/a.ts';
const URI_B = 'file:///src/b.ts';

const A_OLD: IPromptBarRef = { id: 'bar-a-old', createdAt: 100, uri: URI_A };
const A_NEW: IPromptBarRef = { id: 'bar-a-new', createdAt: 300, uri: URI_A };
const B_BAR: IPromptBarRef = { id: 'bar-b', createdAt: 200, uri: URI_B };
const NO_URI: IPromptBarRef = { id: 'bar-nouri', createdAt: 400 };

test('no bars open → create (both invocation types)', () => {
	assert.deepStrictEqual(resolveModalGenerateTarget([], URI_A, 'new', undefined), { kind: 'createPromptBar' });
	assert.deepStrictEqual(resolveModalGenerateTarget([], URI_A, 'toggle', undefined), { kind: 'createPromptBar' });
	assert.deepStrictEqual(resolveModalGenerateTarget([], URI_A, undefined, undefined), { kind: 'createPromptBar' });
});

test('bar on the active uri → focus the newest one (invocationType irrelevant)', () => {
	assert.deepStrictEqual(resolveModalGenerateTarget([A_OLD], URI_A, 'new', undefined), { kind: 'focusExistingBar', barId: 'bar-a-old' });
	assert.deepStrictEqual(resolveModalGenerateTarget([A_OLD, A_NEW], URI_A, 'toggle', undefined), { kind: 'focusExistingBar', barId: 'bar-a-new' });
	// Even a toggle WITH a promptBarId loses to the same-uri branch —
	// the binary checks same-uri bars before the toggle branch.
	assert.deepStrictEqual(resolveModalGenerateTarget([A_OLD], URI_A, 'toggle', 'bar-b'), { kind: 'focusExistingBar', barId: 'bar-a-old' });
});

test('toggle + promptBarId, no same-uri bar → cycle from that bar (nextPromptBar)', () => {
	assert.deepStrictEqual(resolveModalGenerateTarget([B_BAR], URI_A, 'toggle', 'bar-b'), { kind: 'cycleFromBar', barId: 'bar-b' });
	assert.deepStrictEqual(resolveModalGenerateTarget([], URI_A, 'toggle', 'bar-x'), { kind: 'cycleFromBar', barId: 'bar-x' });
});

test('toggle without promptBarId and only foreign-uri bars → create (documented D3 divergence)', () => {
	assert.deepStrictEqual(resolveModalGenerateTarget([B_BAR], URI_A, 'toggle', undefined), { kind: 'createPromptBar' });
	assert.deepStrictEqual(resolveModalGenerateTarget([B_BAR], URI_A, 'new', undefined), { kind: 'createPromptBar' });
});

test('bars without a uri never match the same-uri branch', () => {
	assert.deepStrictEqual(resolveModalGenerateTarget([NO_URI], URI_A, 'new', undefined), { kind: 'createPromptBar' });
	assert.deepStrictEqual(resolveModalGenerateTarget([NO_URI], undefined, 'new', undefined), { kind: 'createPromptBar' });
});

test('no active uri (no model) → same-uri branch skipped', () => {
	assert.deepStrictEqual(resolveModalGenerateTarget([A_OLD], undefined, 'toggle', 'bar-a-old'), { kind: 'cycleFromBar', barId: 'bar-a-old' });
	assert.deepStrictEqual(resolveModalGenerateTarget([A_OLD], undefined, 'new', undefined), { kind: 'createPromptBar' });
});
