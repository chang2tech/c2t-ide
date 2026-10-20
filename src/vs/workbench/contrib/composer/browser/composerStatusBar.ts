/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Core port of the ide-agent status bar items (CAT-D).
//
// Sources:
//   - `vscode.window.createStatusBarItem("ide.tab.status", Right, 100)` in
//     extensions/ide-agent/src/tab/statusBar.ts (TabStatusBar).
//   - `vscode.window.createStatusBarItem("aiCodeTracking.stats.*", Right, 100/99/98)` in
//     extensions/ide-agent/src/services/aiCodeTrackingStatusBar.ts (3 items).
//   - the anonymous model status bar item (`$(zap) <model>`, command
//     `ide.openModelPicker`) in extensions/ide-agent/src/extension.ts `activate()`.
// Core equivalent: `IStatusbarService.addEntry(entry, id, StatusbarAlignment.RIGHT, priority)`
// (audit §3 mapping table).
//
// New ids: `ide.tab.status` -> `composer.tab.status`,
// `aiCodeTracking.stats.tab|composer|recentCommit` -> `composer.aiCodeTracking.stats.*`,
// model item -> `composer.model.status`.

import { localize } from '../../../../nls.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IStatusbarService, StatusbarAlignment, IStatusbarEntryAccessor } from '../../../services/statusbar/browser/statusbar.js';
import { IComposerService } from '../common/composerService.js';

/**
 * Owns the Composer status bar entries and refreshes them from composer state.
 *
 * TODO(composer): wire the live refresh paths:
 *   - Tab entry: port `TabStatusBar.refresh(TabStatusInfo)` from tab/statusBar.ts
 *     (states: `IDE Tab` / `(Snoozed)` / `(Ignored)` / `(no model backend)`; markdown
 *     tooltip with `command:composer.*` links; warning kind when snoozed/no-backend).
 *     Source of truth: the ported tab service (CAT-D composerInlineCompletions.ts)
 *     via `IComposerService` events.
 *   - AI-code-tracking entries: port `services/aiCodeTracking.ts` (CAT-A, no vscode
 *     runtime imports) and call its `formatTabText/formatTabTooltip/...` formatters
 *     in `refreshAiCodeTracking()`; refresh on the store's `onDidChange`.
 *   - Model entry: refresh on the active tab's `modelChanged` event
 *     (`$(zap) <label>`, click -> `composer.openModelPicker`).
 */
export class ComposerStatusBar extends Disposable {

	private readonly tabEntry: IStatusbarEntryAccessor;
	private readonly modelEntry: IStatusbarEntryAccessor;
	private readonly aiTabEntry: IStatusbarEntryAccessor;
	private readonly aiComposerEntry: IStatusbarEntryAccessor;
	private readonly aiCommitEntry: IStatusbarEntryAccessor;

	constructor(
		@IStatusbarService statusbarService: IStatusbarService,
		@IComposerService private readonly composerService: IComposerService,
	) {
		super();

		// 1. IDE Tab indicator (port of TabStatusBar, tab/statusBar.ts).
		this.tabEntry = this._register(statusbarService.addEntry({
			name: localize('composer.tabStatus.name', "IDE Tab"),
			text: `$(keyboard-tab) ${localize('composer.tabStatus.text', "IDE Tab")}`,
			ariaLabel: localize('composer.tabStatus.aria', "IDE Tab completion status"),
			tooltip: localize('composer.tabStatus.tooltip', "IDE Tab — click for options"),
			command: 'composer.tabStatusClicked',
		}, 'composer.tab.status', StatusbarAlignment.RIGHT, 100));

		// 2. Active-model indicator (port of the anonymous model status bar item).
		this.modelEntry = this._register(statusbarService.addEntry({
			name: localize('composer.modelStatus.name', "Composer model"),
			text: `$(zap) ${localize('composer.modelStatus.unknown', "model")}`,
			ariaLabel: localize('composer.modelStatus.aria', "Active Composer model"),
			tooltip: localize('composer.modelStatus.tooltip', "Composer model — click to change"),
			command: 'composer.openModelPicker',
		}, 'composer.model.status', StatusbarAlignment.RIGHT, 101));

		// 3-5. AI code tracking (port of AiCodeTrackingStatusBar, 3 display-only items,
		// priorities 100/99/98 verbatim from Cursor's ordering; no command = display-only).
		// TODO(composer): fill text/tooltip/aria from the ported aiCodeTracking formatters.
		this.aiTabEntry = this._register(statusbarService.addEntry({
			name: localize('composer.aiTabStats.name', "Tab Stats"),
			text: `$(keyboard-tab) ${localize('composer.aiTabStats.text', "Tab Stats")}`,
			ariaLabel: localize('composer.aiTabStats.aria', "AI Tab statistics"),
			tooltip: localize('composer.aiTabStats.tooltip', "AI-generated Tab suggestion statistics"),
		}, 'composer.aiCodeTracking.stats.tab', StatusbarAlignment.RIGHT, 100));

		this.aiComposerEntry = this._register(statusbarService.addEntry({
			name: localize('composer.aiComposerStats.name', "Agent Stats"),
			text: `$(comment-discussion) ${localize('composer.aiComposerStats.text', "Agent Stats")}`,
			ariaLabel: localize('composer.aiComposerStats.aria', "AI Agent statistics"),
			tooltip: localize('composer.aiComposerStats.tooltip', "AI-generated Agent code statistics"),
		}, 'composer.aiCodeTracking.stats.composer', StatusbarAlignment.RIGHT, 99));

		this.aiCommitEntry = this._register(statusbarService.addEntry({
			name: localize('composer.aiCommitStats.name', "Recent Commit AI Score"),
			text: `$(git-commit) ${localize('composer.aiCommitStats.text', "No commit scored")}`,
			ariaLabel: localize('composer.aiCommitStats.aria', "Recent commit AI score"),
			tooltip: localize('composer.aiCommitStats.tooltip', "AI score of the most recent commit"),
		}, 'composer.aiCodeTracking.stats.recentCommit', StatusbarAlignment.RIGHT, 98));

		// TODO(composer): subscribe to IComposerService state events and call the
		// refresh*() methods below (see class doc). Kept static until then.
		void this.composerService;
	}

	/** TODO(composer): port TabStatusBar.refresh(info) here. */
	refreshTabStatus(): void {
		this.tabEntry.update({
			name: localize('composer.tabStatus.name', "IDE Tab"),
			text: `$(keyboard-tab) ${localize('composer.tabStatus.text', "IDE Tab")}`,
			ariaLabel: localize('composer.tabStatus.aria', "IDE Tab completion status"),
		});
	}

	/** TODO(composer): port the model label refresh here. */
	refreshModelStatus(_label: string): void {
		this.modelEntry.update({
			name: localize('composer.modelStatus.name', "Composer model"),
			text: `$(zap) ${localize('composer.modelStatus.unknown', "model")}`,
			ariaLabel: localize('composer.modelStatus.aria', "Active Composer model"),
		});
	}

	/** TODO(composer): port AiCodeTrackingStatusBar.refresh() here. */
	refreshAiCodeTracking(): void {
		for (const entry of [this.aiTabEntry, this.aiComposerEntry, this.aiCommitEntry]) {
			entry.update({
				name: localize('composer.aiStats.name', "AI Stats"),
				text: '',
				ariaLabel: localize('composer.aiStats.aria', "AI statistics"),
			});
		}
	}
}
