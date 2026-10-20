/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Migrated — vscode API → DI (2026-10-19).
//
// vscode API → core mapping used here:
//   vscode.window.createStatusBarItem('ide.tab.status', Right, 100)
//       → IStatusbarService.addEntry(entry, 'ide.tab.status', StatusbarAlignment.RIGHT, 100)
//         (returns IStatusbarEntryAccessor — update()/dispose() replace the mutable item)
//   item.text / tooltip / command / backgroundColor
//       → IStatusbarEntry { text, tooltip, command, kind: 'warning' }
//         (backgroundColor is deprecated in core — kind drives themable hover styles)
//   vscode.MarkdownString → MarkdownString (vs/base/common/htmlContent)
//   vscode.ThemeColor     → ThemeColor (vs/platform/theme/common/themeService)
//   TabModelInfo (tab/backend.ts, CAT-A) → local structural ITabModelInfo
//     (same shape; the sibling agent copies backend.ts verbatim)

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

import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { IStatusbarService, IStatusbarEntry, IStatusbarEntryAccessor, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';

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

/** Structural copy of tab/backend.ts TabModelInfo (CAT-A, sibling agent). */
export interface ITabModelInfo {
	id: string;
	displayName: string;
	isDefault?: boolean;
}

export interface TabStatusActions {
	toggleGlobal(): Promise<void> | void;
	toggleLanguage(languageId: string): Promise<void> | void;
	snooze(durationMs: number): void;
	unsnooze(): void;
	pickModel(): Promise<ITabModelInfo | undefined>;
}

export class TabStatusBar {
	private accessor: IStatusbarEntryAccessor | undefined;

	constructor(
		private readonly statusbarService: IStatusbarService,
		private readonly actions: TabStatusActions,
	) {
		this.accessor = this.statusbarService.addEntry(
			{
				name: 'IDE Tab',
				text: 'IDE Tab',
				ariaLabel: 'IDE Tab',
				command: 'ide.tabStatusClicked',
			},
			'ide.tab.status',
			StatusbarAlignment.RIGHT,
			100,
		);
	}

	get statusActions(): TabStatusActions {
		return this.actions;
	}

	refresh(info: TabStatusInfo): void {
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
			const until = info.snoozedUntil ? new Date(info.snoozedUntil).toLocaleTimeString() : '';
			lines.push(`Snoozed${until ? ` until ${until}` : ''}.`, '');
			lines.push('[Unsnooze now](command:ide.unsnoozeTabCompletion)');
		} else {
			lines.push(`Model: ${info.modelName || 'default'} — [change](command:ide.pickTabModel)`, '');
			lines.push(
				info.languageDisabled
					? `Disabled for ${info.languageId}. [Enable for ${info.languageId}](command:ide.toggleTabForLanguage)`
					: `[Disable for ${info.languageId}](command:ide.toggleTabForLanguage)`,
			);
			lines.push('[Disable globally](command:ide.disableTabGlobally)');
			lines.push('[Snooze…](command:ide.snoozeTabCompletion)');
		}
		if (info.ignored) {
			lines.push('', '_Current file matches an ignore pattern._');
		}
		md.value = lines.join('\n\n');

		const entry: IStatusbarEntry = {
			name: 'IDE Tab',
			text,
			ariaLabel: text,
			tooltip: md,
			command: 'ide.tabStatusClicked',
			kind: info.snoozed || info.noBackend ? 'warning' : undefined,
		};
		if (this.accessor) {
			this.accessor.update(entry);
		} else {
			this.accessor = this.statusbarService.addEntry(
				entry,
				'ide.tab.status',
				StatusbarAlignment.RIGHT,
				100,
			);
		}
	}

	dispose(): void {
		this.accessor?.dispose();
		this.accessor = undefined;
	}
}
