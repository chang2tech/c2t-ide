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
 * `AiCodeTrackingService.onDidChange` (Cursor calls `updateStatusBar()` on
 * each analytics event — same immediacy, no polling).
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
 *     API equivalent is `StatusBarItem.accessibilityInformation.label`.
 *  4. Tooltips: Cursor's hover tooltips are plain text; we pass plain strings
 *     (not MarkdownString) for the same rendering.
 */

import * as vscode from 'vscode';
import {
  AiCodeTrackingService,
  formatComposerAria,
  formatComposerText,
  formatComposerTooltip,
  formatRecentCommitAria,
  formatRecentCommitText,
  formatRecentCommitTooltip,
  formatTabAria,
  formatTabText,
  formatTabTooltip,
} from './aiCodeTracking';

export class AiCodeTrackingStatusBar implements vscode.Disposable {
  private readonly tabItem: vscode.StatusBarItem;
  private readonly composerItem: vscode.StatusBarItem;
  private readonly commitItem: vscode.StatusBarItem;
  private readonly changeSub: { dispose(): void };

  constructor(private readonly store: AiCodeTrackingService) {
    // Priorities 100/99/98 — verbatim Cursor ordering (left→right).
    // Display-only: no command assigned (see module header note 2).
    this.tabItem = vscode.window.createStatusBarItem(
      'aiCodeTracking.stats.tab',
      vscode.StatusBarAlignment.Right,
      100,
    );
    this.composerItem = vscode.window.createStatusBarItem(
      'aiCodeTracking.stats.composer',
      vscode.StatusBarAlignment.Right,
      99,
    );
    this.commitItem = vscode.window.createStatusBarItem(
      'aiCodeTracking.stats.recentCommit',
      vscode.StatusBarAlignment.Right,
      98,
    );
    this.refresh();
    this.tabItem.show();
    this.composerItem.show();
    this.commitItem.show();
    // Live updates: Cursor calls updateStatusBar() on every analytics event.
    this.changeSub = this.store.onDidChange(() => this.refresh());
  }

  /** Re-render all three items from the current store snapshot. */
  refresh(): void {
    const stats = this.store.snapshot();
    const commit = this.store.getRecentCommit();

    this.tabItem.text = `$(keyboard-tab) ${formatTabText(stats)}`;
    this.tabItem.tooltip = formatTabTooltip(stats);
    this.tabItem.accessibilityInformation = { label: formatTabAria(stats) };

    this.composerItem.text = `$(comment-discussion) ${formatComposerText(stats)}`;
    this.composerItem.tooltip = formatComposerTooltip(stats);
    this.composerItem.accessibilityInformation = { label: formatComposerAria(stats) };

    this.commitItem.text = `$(git-commit) ${formatRecentCommitText(commit)}`;
    this.commitItem.tooltip = formatRecentCommitTooltip(commit);
    this.commitItem.accessibilityInformation = { label: formatRecentCommitAria(commit) };
  }

  dispose(): void {
    this.changeSub.dispose();
    this.tabItem.dispose();
    this.composerItem.dispose();
    this.commitItem.dispose();
  }
}
