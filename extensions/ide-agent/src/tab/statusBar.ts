/**
 * Status bar indicator — port of Cursor's `copilot-plus-plus-status-*` element.
 *
 * Three text states: `IDE Tab` (on), `IDE Tab (Snoozed)`, `IDE Tab (Ignored)`
 * (ignore-pattern match, the .cursorignore analog). Click opens the status
 * quick-pick; hover shows global + per-language toggles, the model picker and
 * snooze actions (Cursor's `cpp-status-bar-hover-element`).
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
    this.item.text = info.snoozed ? 'IDE Tab (Snoozed)' : info.ignored ? 'IDE Tab (Ignored)' : 'IDE Tab';

    const md = new vscode.MarkdownString('', true);
    md.isTrusted = true;
    md.supportHtml = false;
    const lines: string[] = ['**IDE Tab**', ''];
    if (!info.enabled) {
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
    this.item.backgroundColor = info.snoozed
      ? new vscode.ThemeColor('statusBarItem.warningBackground')
      : undefined;
  }

  dispose(): void {
    this.item.dispose();
  }
}
