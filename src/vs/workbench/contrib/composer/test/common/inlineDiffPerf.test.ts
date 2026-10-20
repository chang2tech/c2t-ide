/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import {
	INLINE_DIFF_PERF_PROTECTION_CONFIG_KEY,
	INLINE_DIFF_MAX_DECORATIONS_CONFIG_KEY,
	INLINE_DIFF_PERF_PROTECTION_DEFAULT,
	INLINE_DIFF_MAX_DECORATIONS_DEFAULT,
	INLINE_DIFF_SUPPRESSION_NOTIFICATION_ID,
	INLINE_DIFF_TOO_MANY_CHANGES_WARNING_ID,
	shouldSuppressInlineDiffDecorations,
} from '../../common/inlineDiffPerf.js';

/**
 * DEV-GAPS-53 — inline-diff performance protection (`inline-diff-performance-protection`)
 * and suppression warning (`inline-diff-suppression-warning`).
 *
 * Binary evidence (Cursor 3.25.9, workbench.glass.main.js):
 * - `cursor.inlineDiff.enablePerformanceProtection` (default true): "Enable
 *   performance protection for inline diffs. When enabled, inline diff
 *   decorations will be suppressed if there are too many changes to prevent
 *   editor unresponsiveness."
 * - `inline_diff_performance_config.maxDecorations` (default 100).
 * - Workbench contribution `workbench.contrib.composer.inlineDiffSuppressionNotification`
 *   with `{neverShowAgain: {id: "inlineDiff.tooManyChangesWarning"}}`.
 */
suite('inlineDiffPerf (DEV-GAPS-53)', () => {

	suite('binary-verbatim identifiers', () => {
		test('config keys mirror the Cursor binary config ids', () => {
			assert.strictEqual(INLINE_DIFF_PERF_PROTECTION_CONFIG_KEY, 'ide.inlineDiff.enablePerformanceProtection');
			assert.strictEqual(INLINE_DIFF_MAX_DECORATIONS_CONFIG_KEY, 'ide.inlineDiff.maxDecorations');
		});

		test('defaults match the binary (protection on, maxDecorations 100)', () => {
			assert.strictEqual(INLINE_DIFF_PERF_PROTECTION_DEFAULT, true);
			assert.strictEqual(INLINE_DIFF_MAX_DECORATIONS_DEFAULT, 100);
		});

		test('suppression contribution + warning ids are binary-verbatim', () => {
			assert.strictEqual(INLINE_DIFF_SUPPRESSION_NOTIFICATION_ID, 'workbench.contrib.composer.inlineDiffSuppressionNotification');
			assert.strictEqual(INLINE_DIFF_TOO_MANY_CHANGES_WARNING_ID, 'inlineDiff.tooManyChangesWarning');
		});
	});

	suite('shouldSuppressInlineDiffDecorations', () => {
		test('suppresses when changes exceed maxDecorations and protection is on', () => {
			assert.strictEqual(shouldSuppressInlineDiffDecorations(101, true, 100), true);
			assert.strictEqual(shouldSuppressInlineDiffDecorations(1000, true, 100), true);
		});

		test('does not suppress at or below the limit', () => {
			assert.strictEqual(shouldSuppressInlineDiffDecorations(0, true, 100), false);
			assert.strictEqual(shouldSuppressInlineDiffDecorations(99, true, 100), false);
			assert.strictEqual(shouldSuppressInlineDiffDecorations(100, true, 100), false,
				'binary uses changes.length > maxDecorations (strictly greater)');
		});

		test('protection off never suppresses', () => {
			assert.strictEqual(shouldSuppressInlineDiffDecorations(101, false, 100), false);
			assert.strictEqual(shouldSuppressInlineDiffDecorations(100000, false, 100), false);
		});

		test('invalid limit falls back to the binary default 100', () => {
			assert.strictEqual(shouldSuppressInlineDiffDecorations(101, true, 0), true);
			assert.strictEqual(shouldSuppressInlineDiffDecorations(101, true, -5), true);
			assert.strictEqual(shouldSuppressInlineDiffDecorations(101, true, Number.NaN), true);
			assert.strictEqual(shouldSuppressInlineDiffDecorations(100, true, Number.NaN), false);
		});
	});
});
