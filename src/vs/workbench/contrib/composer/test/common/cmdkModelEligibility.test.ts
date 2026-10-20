/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { test } from 'node:test';
import {
	filterModelsEligibleForCmdK,
	isModelEligibleForCmdK,
} from '../../common/cmdkModelEligibility.js';

/**
 * WORKER-GAPS-24E — cmdk-model-eligibility tests (Cursor parity, feature_id
 * `cmdk-model-eligibility`).
 *
 * Evidence grounding (see common/cmdkModelEligibility.ts):
 *  - Staff (Colin, forum.cursor.com/t/146433, 2025-12-16): "Cmd+K is designed
 *    for fast, non-reasoning models ... only non-thinking models are available
 *    ... models that require max mode aren't available."
 *  - Binary 3.25.9 (cursor-agent-exec/dist/main.js): per-model capability
 *    flags `supportsAgent/supportsPlanMode/supportsSandboxing/supportsNonMaxMode/
 *    supportsCmdK` (OBSERVED).
 */

test('supportsCmdK=false excludes the model — binary flag is authoritative', () => {
	assert.strictEqual(isModelEligibleForCmdK({ supportsCmdK: false }), false);
	// Even a fast non-thinking model is excluded when the registry says no.
	assert.strictEqual(
		isModelEligibleForCmdK({ supportsCmdK: false, thinking: false, requiresMaxMode: false }),
		false,
	);
});

test('supportsCmdK=true includes the model — binary flag wins over heuristics', () => {
	assert.strictEqual(isModelEligibleForCmdK({ supportsCmdK: true }), true);
	assert.strictEqual(
		isModelEligibleForCmdK({ supportsCmdK: true, thinking: true, requiresMaxMode: true }),
		true,
	);
});

test('thinking=true excludes the model (staff criterion 1: non-thinking only)', () => {
	assert.strictEqual(isModelEligibleForCmdK({ thinking: true }), false);
});

test('requiresMaxMode=true excludes the model (staff criterion 2: no max-mode models)', () => {
	assert.strictEqual(isModelEligibleForCmdK({ requiresMaxMode: true }), false);
});

test('model with neither flag set stays eligible (fail-open without metadata)', () => {
	// Cursor computes the flags in its own registry; the engine catalog may
	// not carry them. Hiding all unflagged models would be a worse bug.
	assert.strictEqual(isModelEligibleForCmdK({}), true);
	assert.strictEqual(
		isModelEligibleForCmdK({ thinking: false, requiresMaxMode: false }),
		true,
	);
});

test('only strict booleans gate eligibility — messy wire values fail open', () => {
	// The adapter maps only real booleans; anything else must not exclude.
	assert.strictEqual(isModelEligibleForCmdK({ thinking: 'yes' as unknown as boolean }), true);
	assert.strictEqual(
		isModelEligibleForCmdK({ requiresMaxMode: 1 as unknown as boolean }),
		true,
	);
});

test('filterModelsEligibleForCmdK removes ineligible models and preserves order', () => {
	const models = [
		{ id: 'fast-a', providerID: 'p', name: 'Fast A' },
		{ id: 'thinker', providerID: 'p', name: 'Thinker', thinking: true },
		{ id: 'maxer', providerID: 'p', name: 'Maxer', requiresMaxMode: true },
		{ id: 'blocked', providerID: 'p', name: 'Blocked', supportsCmdK: false },
		{ id: 'fast-b', providerID: 'p', name: 'Fast B', supportsCmdK: true, thinking: true },
	];
	const eligible = filterModelsEligibleForCmdK(models);
	assert.deepStrictEqual(
		eligible.map((m) => m.id),
		['fast-a', 'fast-b'],
	);
	// Input is not mutated.
	assert.strictEqual(models.length, 5);
});

test('filterModelsEligibleForCmdK keeps everything when no metadata is present', () => {
	const models = [
		{ id: 'a', providerID: 'p', name: 'A' },
		{ id: 'b', providerID: 'p', name: 'B' },
	];
	assert.deepStrictEqual(
		filterModelsEligibleForCmdK(models).map((m) => m.id),
		['a', 'b'],
	);
});
