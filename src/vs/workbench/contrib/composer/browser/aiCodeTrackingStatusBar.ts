/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Migrated — vscode API → DI (2026-10-19).
//
// vscode API → core mapping used here:
//   vscode.window.createStatusBarItem(id, Right, priority) ×3
//       → IStatusbarService.addEntry(entry, id, StatusbarAlignment.RIGHT, priority) ×3
//         (each returns an IStatusbarEntryAccessor; refresh() calls update(),
//         dispose() disposes the accessors)
//   StatusBarItem.text / tooltip / accessibilityInformation
//       → IStatusbarEntry { text, tooltip, ariaLabel }
//   (display-only items: no command — same rendering as the original)
//
// TODO(composer): aiCodeTracking.ts (CAT-A, sibling agent) will be copied to
// ../common/aiCodeTracking.js. When it lands, delete the vendored format
// helpers below and import { AiCodeTrackingService, formatTabText, … } from
// '../common/aiCodeTracking.js' instead. IAiCodeTrackingStore is structurally
// satisfied by that AiCodeTrackingService.

/**
 * Status-bar surface for AI code tracking — port of Cursor's `aiCodeTracking`
 * workbench contribution (DIG-STATUSBAR-AI, 2026-10-19).
 *
 * Three display-only items on the right side, verbatim from Cursor's live DOM:
 *   - `aiCodeTracking.stats.tab`          priority 100  `$(keyboard-tab) Tab Stats: a/s (p%)`
 *   - `aiCodeTracking.stats.composer`     priority 99   `$(comment-discussion) Agent Stats: a/s (p%)`
 *   - `aiCodeTracking.stats.recentCommit` priority 98   `$(git-commit) No commit scored` /
 *                                                       `$(git-commit) {shortHash} {pct}% AI`
 * All items refresh live on every suggest/accept/score event via
 * `store.onDidChange` (Cursor calls `updateStatusBar()` on each analytics
 * event — same immediacy, no polling).
 *
 * Honest divergences from Cursor (extension-host API limits):
 *  1. Icons: Cursor renders `codicon-tab` — a glyph its bundle ships that does
 *     NOT exist in stock VS Code's codicon font. We use `$(keyboard-tab)`
 *     (the ⇥ Tab-key glyph), the closest stock equivalent.
 *  2. Disabled state: Cursor marks these labels with the `disabled` CSS class
 *     (not clickable). The VS Code extension-host API has no disabled flag for
 *     status-bar items — we simply assign no `command`, which renders the
 *     item display-only (hoverable, not clickable).
 *  3. aria-label: Cursor sets `aria-label` on the status-bar DOM node; the
 *     core equivalent is `IStatusbarEntry.ariaLabel`.
 *  4. Tooltips: Cursor's hover tooltips are plain text; we pass plain strings
 *     (not MarkdownString) for the same rendering.
 */

import { Event } from '../../../../base/common/event.js';
import { IStatusbarService, IStatusbarEntryAccessor, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';

/** Structural copy of aiCodeTracking.ts DailyStats (CAT-A, sibling agent). */
export interface IDailyStats {
	date: string;
	tabSuggested: number;
	tabAccepted: number;
	composerSuggested: number;
	composerAccepted: number;
}

/** Structural copy of aiCodeTracking.ts ScoredCommit (CAT-A, sibling agent). */
export interface IScoredCommit {
	commitHash: string;
	shortHash: string;
	commitMessage: string;
	commitDate: string;
	repoName?: string;
	branchName?: string;
	aiPercentage: number;
	tabLinesAdded: number;
	tabLinesDeleted: number;
	composerLinesAdded: number;
	composerLinesDeleted: number;
	linesAdded: number;
	linesDeleted: number;
	timestamp: number;
}

/**
 * Structural surface needed from the tracking store.
 * Satisfied by AiCodeTrackingService (CAT-A, sibling agent).
 */
export interface IAiCodeTrackingStore {
	readonly onDidChange: Event<void>;
	snapshot(): IDailyStats;
	getRecentCommit(): IScoredCommit | undefined;
}

// --- Vendored format helpers (see TODO at the top of this file) ---

function acceptanceRate(accepted: number, suggested: number): number {
	if (suggested <= 0) {
		return 0;
	}
	return Math.round((accepted / suggested) * 100);
}

function formatTabText(stats: IDailyStats): string {
	return `Tab Stats: ${stats.tabAccepted}/${stats.tabSuggested} (${acceptanceRate(stats.tabAccepted, stats.tabSuggested)}%)`;
}

function formatTabAria(stats: IDailyStats): string {
	const p = acceptanceRate(stats.tabAccepted, stats.tabSuggested);
	return `Tab AI Stats: ${stats.tabAccepted} accepted out of ${stats.tabSuggested} suggested, ${p} percent acceptance rate`;
}

function formatTabTooltip(stats: IDailyStats): string {
	const p = acceptanceRate(stats.tabAccepted, stats.tabSuggested);
	return `Tab AI Stats (Today): ${stats.tabAccepted}/${stats.tabSuggested} lines (${p}%)`;
}

function formatComposerText(stats: IDailyStats): string {
	return `Agent Stats: ${stats.composerAccepted}/${stats.composerSuggested} (${acceptanceRate(stats.composerAccepted, stats.composerSuggested)}%)`;
}

function formatComposerAria(stats: IDailyStats): string {
	const p = acceptanceRate(stats.composerAccepted, stats.composerSuggested);
	return `Agent AI Stats: ${stats.composerAccepted} accepted out of ${stats.composerSuggested} suggested, ${p} percent acceptance rate`;
}

function formatComposerTooltip(stats: IDailyStats): string {
	const p = acceptanceRate(stats.composerAccepted, stats.composerSuggested);
	return `Agent AI Stats (Today): ${stats.composerAccepted}/${stats.composerSuggested} lines (${p}%)`;
}

function formatRecentCommitText(commit: IScoredCommit | undefined): string {
	if (!commit) {
		return 'No commit scored';
	}
	return `${commit.shortHash} ${commit.aiPercentage}% AI`;
}

function formatRecentCommitAria(commit: IScoredCommit | undefined): string {
	if (!commit) {
		return 'No commit has been scored yet';
	}
	return `Most recent commit scored: ${commit.shortHash}, ${commit.aiPercentage} percent AI-generated`;
}

function formatRecentCommitTooltip(commit: IScoredCommit | undefined): string {
	if (!commit) {
		return 'No commit has been scored yet';
	}
	const tabLines = commit.tabLinesAdded + commit.tabLinesDeleted;
	const composerLines = commit.composerLinesAdded + commit.composerLinesDeleted;
	return [
		`Most recent commit scored: ${commit.shortHash} — ${commit.aiPercentage}% AI-generated`,
		`Tab: ${tabLines} lines · Agent: ${composerLines} lines`,
		commit.commitMessage,
	].join('\n');
}

// --- Status bar contribution ---

export class AiCodeTrackingStatusBar {
	private tabAccessor: IStatusbarEntryAccessor | undefined;
	private composerAccessor: IStatusbarEntryAccessor | undefined;
	private commitAccessor: IStatusbarEntryAccessor | undefined;
	private readonly changeSub: { dispose(): void };

	constructor(
		private readonly statusbarService: IStatusbarService,
		private readonly store: IAiCodeTrackingStore,
	) {
		// Priorities 100/99/98 — verbatim Cursor ordering (left→right).
		// Display-only: no command assigned (see module header note 2).
		this.tabAccessor = this.statusbarService.addEntry(
			{ name: 'AI Code Tracking (Tab)', text: '', ariaLabel: '' },
			'aiCodeTracking.stats.tab',
			StatusbarAlignment.RIGHT,
			100,
		);
		this.composerAccessor = this.statusbarService.addEntry(
			{ name: 'AI Code Tracking (Agent)', text: '', ariaLabel: '' },
			'aiCodeTracking.stats.composer',
			StatusbarAlignment.RIGHT,
			99,
		);
		this.commitAccessor = this.statusbarService.addEntry(
			{ name: 'AI Code Tracking (Recent Commit)', text: '', ariaLabel: '' },
			'aiCodeTracking.stats.recentCommit',
			StatusbarAlignment.RIGHT,
			98,
		);
		this.refresh();
		// Live updates: Cursor calls updateStatusBar() on every analytics event.
		this.changeSub = this.store.onDidChange(() => this.refresh());
	}

	/** Re-render all three items from the current store snapshot. */
	refresh(): void {
		const stats = this.store.snapshot();
		const commit = this.store.getRecentCommit();

		this.tabAccessor?.update({
			name: 'AI Code Tracking (Tab)',
			text: `$(keyboard-tab) ${formatTabText(stats)}`,
			ariaLabel: formatTabAria(stats),
			tooltip: formatTabTooltip(stats),
		});
		this.composerAccessor?.update({
			name: 'AI Code Tracking (Agent)',
			text: `$(comment-discussion) ${formatComposerText(stats)}`,
			ariaLabel: formatComposerAria(stats),
			tooltip: formatComposerTooltip(stats),
		});
		this.commitAccessor?.update({
			name: 'AI Code Tracking (Recent Commit)',
			text: `$(git-commit) ${formatRecentCommitText(commit)}`,
			ariaLabel: formatRecentCommitAria(commit),
			tooltip: formatRecentCommitTooltip(commit),
		});
	}

	dispose(): void {
		this.changeSub.dispose();
		this.tabAccessor?.dispose();
		this.composerAccessor?.dispose();
		this.commitAccessor?.dispose();
		this.tabAccessor = this.composerAccessor = this.commitAccessor = undefined;
	}
}
