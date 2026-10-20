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

import * as vscode from 'vscode';
import { TabModelInfo } from './backend';

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

export interface TabStatusActions {
  toggleGlobal(): Promise<void> | void;
  toggleLanguage(languageId: string): Promise<void> | void;
  snooze(durationMs: number): void;
  unsnooze(): void;
  pickModel(): Promise<TabModelInfo | undefined>;
}

export class TabStatusBar implements vscode.Disposable {
  private item: vscode.StatusBarItem;

  constructor(private actions: TabStatusActions) {
    this.item = vscode.window.createStatusBarItem('ide.tab.status', vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'ide.tabStatusClicked';
    this.item.show();
  }

  refresh(info: TabStatusInfo): void {
    this.item.text = info.noBackend
      ? 'IDE Tab (no model backend)'
      : info.snoozed
        ? 'IDE Tab (Snoozed)'
        : info.ignored
          ? 'IDE Tab (Ignored)'
          : 'IDE Tab';

    const md = new vscode.MarkdownString('', true);
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
    this.item.tooltip = md;
    this.item.backgroundColor =
      info.snoozed || info.noBackend ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
  }

  dispose(): void {
    this.item.dispose();
  }
}
