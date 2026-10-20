/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Tab status bar indicator — rewritten from
// extensions/ide-agent/src/tab/statusBar.ts for the workbench core.
// Interface mapping:
//   window.createStatusBarItem('ide.tab.status', Right, 100) →
//     IStatusbarService.addEntry(entry, 'ide.tab.status', StatusbarAlignment.RIGHT, 100)
//   vscode.MarkdownString → MarkdownString (vs/base/common/htmlContent)
//   vscode.ThemeColor('statusBarItem.warningBackground') → kind: 'warning'
//     (StatusbarEntryKind; the deprecated backgroundColor field is avoided)
//   vscode.Disposable → Disposable (vs/base/common/lifecycle)
// Click runs `ide.tabStatusClicked` via the entry's `command` field.

/**
 * Status bar indicator — port of Cursor's `copilot-plus-plus-status-*` element.
 *
 * Three text states: `IDE Tab` (on), `IDE Tab (Snoozed)`, `IDE Tab (Ignored)`
 * (ignore-pattern match, the .cursorignore analog). Click opens the status
 * quick-pick; hover shows global + per-language toggles, the model picker and
 * snooze actions (Cursor's `cpp-status-bar-hover-element`).
 *
 * DD-SB-4 / honest divergence: Cursor's `Cursor Tab` item has a LOGGED-OUT
 * state — text `Cursor Tab`, tooltip `Please log in`, click runs
 * `editor.cpp.login`. We have no login/auth system, so there is no logged-out
 * branch here: the item always reflects the real local state (enabled /
 * snoozed via `ide.tab` config + SnoozeManager / ignored via ignore
 * patterns). If an auth layer is ever added, the logged-out branch belongs
 * here (tooltip `Please log in`, click → login command).
 */

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { formatSnoozedTimeRemaining } from './snooze.js';
import {
	IStatusbarEntryAccessor,
	IStatusbarService,
	StatusbarAlignment,
} from '../../../../services/statusbar/browser/statusbar.js';

export interface TabStatusInfo {
	enabled: boolean;
	snoozed: boolean;
	ignored: boolean;
	languageId: string;
	languageDisabled: boolean;
	modelName: string;
	snoozedUntil?: number;
	/**
	 * True when no model backend is wired (stub engine mode). Tab is silent in
	 * this state — the item says so instead of pretending to work.
	 */
	noBackend: boolean;
}

export class TabStatusBar extends Disposable {
	private accessor: IStatusbarEntryAccessor | undefined;

	constructor(private readonly statusbarService: IStatusbarService) {
		super();
	}

	/** Create the entry. Call once after construction (wired by tabContribution.ts). */
	show(): void {
		if (this.accessor) return;
		this.accessor = this.statusbarService.addEntry(
			{
				name: 'IDE Tab',
				text: 'IDE Tab',
				ariaLabel: 'IDE Tab status',
				command: 'ide.tabStatusClicked',
			},
			'ide.tab.status',
			StatusbarAlignment.RIGHT,
			100,
		);
	}

	refresh(info: TabStatusInfo): void {
		if (!this.accessor) return;
		const text = info.noBackend
			? 'IDE Tab (no model backend)'
			: info.snoozed
				? 'IDE Tab (Snoozed)'
				: info.ignored
					? 'IDE Tab (Ignored)'
					: 'IDE Tab';

		const md = new MarkdownString('', true);
		md.isTrusted = true;
		md.supportHtml = false;
		const lines: string[] = ['**IDE Tab**', ''];
		if (info.noBackend) {
			lines.push(
				'No model backend connected — suggestions are off (nothing is faked).',
				'',
				'Set `ide.agent.engineMode` to `sidecar` and reload to enable real Tab completions.',
				'',
			);
		} else if (!info.enabled) {
			lines.push('Tab completion is disabled globally.', '');
			lines.push('[Enable IDE Tab](command:ide.enableTabGlobally)');
		} else if (info.snoozed) {
			// TAB-SNOOZE: Cursor's status-bar hover shows a live `(${y} remaining)`
			// countdown (`_renderSnoozeButtons`, ticking every 1s) rather than a
			// wall-clock time — the countdown is formatted by
			// `formatSnoozedTimeRemaining` and refreshed by the contribution's
			// snooze tick (see tabContribution.ts).
			const remaining = info.snoozedUntil !== undefined
				? formatSnoozedTimeRemaining(info.snoozedUntil)
				: '';
			lines.push(`Snoozed${remaining ? ` (${remaining} remaining)` : ''}.`, '');
			lines.push('[Unsnooze now](command:ide.unsnoozeTabCompletion)');
		} else {
			lines.push(`Model: ${info.modelName || 'default'} — [change](command:ide.pickTabModel)`, '');
			lines.push(
				info.languageDisabled
					? `Disabled for ${info.languageId}. [Enable for ${info.languageId}](command:ide.toggleTabForLanguage)`
					: `[Disable for ${info.languageId}](command:ide.toggleTabForLanguage)`,
			);
			lines.push('[Disable globally](command:ide.disableTabGlobally)');
			// TAB-SNOOZE: binary copy from Cursor's snooze tooltip icon
			// (`_createTooltipIcon("Temporarily disable Cursor Tab suggestions for
			// a specified duration. You can unsnooze at any time.")`).
			lines.push('');
			lines.push('_Temporarily disable IDE Tab suggestions for a chosen duration. You can unsnooze at any time._', '');
			lines.push('[Snooze…](command:ide.snoozeTabCompletion)');
		}
		if (info.ignored) {
			lines.push('', '_Current file matches an ignore pattern._');
		}
		md.value = lines.join('\n\n');

		this.accessor.update({
			name: 'IDE Tab',
			text,
			ariaLabel: `IDE Tab: ${text}`,
			tooltip: md,
			command: 'ide.tabStatusClicked',
			// Core-native equivalent of the old warning-background highlight.
			kind: info.snoozed || info.noBackend ? 'warning' : 'standard',
		});
	}

	override dispose(): void {
		this.accessor?.dispose();
		this.accessor = undefined;
		super.dispose();
	}
}
