/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: inline-diff performance protection + suppression warning (Cursor parity).
//
// Binary evidence (Cursor 3.25.9, out/vs/workbench/workbench.glass.main.js,
// re-verified by direct byte reads):
// - Config `cursor.inlineDiff.enablePerformanceProtection` (default true),
//   section `general`: "Enable performance protection for inline diffs. When
//   enabled, inline diff decorations will be suppressed if there are too many
//   changes to prevent editor unresponsiveness."
// - `inline_diff_performance_config.maxDecorations` (default 100): when the
//   inline diff's change count exceeds it, decorations are suppressed.
// - Workbench contribution id:
//   `workbench.contrib.composer.inlineDiffSuppressionNotification` with
//   `{neverShowAgain: {id: "inlineDiff.tooManyChangesWarning"}}` — the "too
//   many changes" warning's never-show-again toggle is backed by
//   notification-service state.
//
// This module is pure (no workbench imports) so the suppression decision is
// unit-testable without the editor. The stateful wiring lives in
// `electron-browser/inlineEditService.ts` (suppression check) and
// `browser/inlineDiffSuppressionNotification.ts` (the warning).

/** Fork config key mirroring `cursor.inlineDiff.enablePerformanceProtection`. */
export const INLINE_DIFF_PERF_PROTECTION_CONFIG_KEY = 'ide.inlineDiff.enablePerformanceProtection';

/** Fork config key mirroring Cursor's `inline_diff_performance_config.maxDecorations`. */
export const INLINE_DIFF_MAX_DECORATIONS_CONFIG_KEY = 'ide.inlineDiff.maxDecorations';

/** Verbatim from the Cursor 3.25.9 binary (`Rni=!0`). */
export const INLINE_DIFF_PERF_PROTECTION_DEFAULT = true;

/** Verbatim from the Cursor 3.25.9 binary (`inline_diff_performance_config.maxDecorations`). */
export const INLINE_DIFF_MAX_DECORATIONS_DEFAULT = 100;

/**
 * Workbench contribution id, verbatim from the Cursor 3.25.9 binary
 * (`workbench.contrib.composer.inlineDiffSuppressionNotification`).
 */
export const INLINE_DIFF_SUPPRESSION_NOTIFICATION_ID =
	'workbench.contrib.composer.inlineDiffSuppressionNotification';

/**
 * Never-show-again notification id, verbatim from the Cursor 3.25.9 binary
 * (`{neverShowAgain: {id: "inlineDiff.tooManyChangesWarning"}}`).
 */
export const INLINE_DIFF_TOO_MANY_CHANGES_WARNING_ID = 'inlineDiff.tooManyChangesWarning';

/**
 * Cursor's suppression decision: when performance protection is enabled and
 * the inline diff's change count exceeds `maxDecorations`, inline-diff
 * decorations are suppressed (binary: `changes.length > maxDecorations`).
 */
export function shouldSuppressInlineDiffDecorations(
	changeCount: number,
	protectionEnabled: boolean,
	maxDecorations: number,
): boolean {
	if (!protectionEnabled) {
		return false;
	}
	const limit = Number.isFinite(maxDecorations) && maxDecorations > 0
		? Math.floor(maxDecorations)
		: INLINE_DIFF_MAX_DECORATIONS_DEFAULT;
	return changeCount > limit;
}
