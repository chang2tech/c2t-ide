import * as vscode from "vscode";
import { ChatTabService } from "./chatTabService";

/**
 * DEV-GAPS-14 (orange-dot-native-tabs): pushes per-chat-tab awaiting-input
 * state to workbench core so NATIVE editor tabs render the orange dot.
 *
 * Cursor parity — cursor.com/changelog/0-48-x verbatim: "When a tab is
 * awaiting your input, you'll see an orange dot on that tab." VS Code's
 * extension API exposes no per-tab badge/decoration API (`TabInputCustom`
 * has no badge, `tab.dirty` is read-only, `FileDecorationProvider` does not
 * render on editor tabs), so the dot is drawn by a workbench-core patch
 * (native DOM in the tab strip — the way Cursor does it), fed from here.
 *
 * Core side: `IEditorTabBadgeService` + the `ide.chat.setEditorTabBadge`
 * bridge command in
 * src/vs/workbench/browser/parts/editor/editorTabBadges.ts; the tab strip
 * controls toggle the `awaiting-input` class and CSS draws the dot
 * (color: `tab.awaitingInputDot` theme color, #e8a13c fallback — the exact
 * Cursor orange hex is UNKNOWN, see the HONEST-COLOR note in
 * src/vs/workbench/common/theme.ts).
 *
 * The webview tab bar's own dot (composer.ts `.qdot`) is unchanged — this
 * sync only drives the NATIVE editor tabs.
 */

/**
 * Bridge command id registered by workbench core
 * (src/vs/workbench/browser/parts/editor/editorTabBadges.ts).
 * Takes a single JSON-safe args object `{ tabId, awaitingInput }`.
 */
export const SET_EDITOR_TAB_BADGE_COMMAND_ID = "ide.chat.setEditorTabBadge";

export interface TabBadgePush {
  tabId: string;
  awaitingInput: boolean;
}

/**
 * Pure diff of desired vs last-pushed awaiting-input states.
 *
 * Returns the minimal push list:
 * - a push for every tab whose state changed (including brand-new tabs),
 * - a clearing push (`awaitingInput: false`) for a vanished (closed) tab
 *   only if its dot was on — a tab that was never awaiting needs no
 *   clearing push (the core bridge is a no-op for editors that are not
 *   open).
 */
export function diffTabBadgePushes(
  current: ReadonlyMap<string, boolean>,
  lastPushed: ReadonlyMap<string, boolean>,
): TabBadgePush[] {
  const pushes: TabBadgePush[] = [];
  for (const [tabId, awaiting] of current) {
    if (lastPushed.get(tabId) !== awaiting) {
      pushes.push({ tabId, awaitingInput: awaiting });
    }
  }
  for (const [tabId, wasAwaiting] of lastPushed) {
    if (!current.has(tabId) && wasAwaiting) {
      pushes.push({ tabId, awaitingInput: false });
    }
  }
  return pushes;
}

/** Default transport: the core bridge command. Never rejects the host. */
function defaultPushCommand(push: TabBadgePush): void {
  try {
    const result = vscode.commands.executeCommand(SET_EDITOR_TAB_BADGE_COMMAND_ID, {
      tabId: push.tabId,
      awaitingInput: push.awaitingInput,
    });
    // The bridge command lives in the renderer; if it is unavailable (or the
    // workbench is not ready yet) swallow the rejection — the dot is a
    // progressive enhancement and the next sync re-pushes.
    void Promise.resolve(result).catch(() => undefined);
  } catch {
    // ignore — see above
  }
}

/**
 * Keeps the native-tab badge state in core in sync with ChatTabService.
 * Subscribes to `ChatTabService.onDidChange` (fires on tab changes and on
 * every composer event — this covers clarifying questions, which go
 * through `questionAsked`/`questionAnswered` composer events) plus each
 * tab's `reviews.onDidChangeApproval` (approval request/resolve does NOT
 * go through the composer event relay, so `tabs.onDidChange` alone would
 * miss it). Only the diff crosses the extension-host boundary.
 */
export class ChatTabBadgeSync implements vscode.Disposable {
  private readonly lastPushed = new Map<string, boolean>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly composerSubs = new Map<string, vscode.Disposable>();

  constructor(
    private readonly tabs: ChatTabService,
    private readonly pushCommand: (push: TabBadgePush) => void = defaultPushCommand,
  ) {
    this.disposables.push(this.tabs.onDidChange(() => this.sync()));
    this.sync();
  }

  /**
   * Push one tab's current state unconditionally (bypasses the diff).
   * Called when a chat editor (re)opens: core drops badge state for
   * editors that were never open (or whose input was disposed on close),
   * so a reopened tab that is still awaiting input needs a fresh push even
   * when the diff is empty.
   */
  pushTab(tabId: string): void {
    const state = this.tabs.getTabStates().find((s) => s.id === tabId);
    const awaiting = state ? state.approvalPending || state.questionPending : false;
    this.lastPushed.set(tabId, awaiting);
    this.pushCommand({ tabId, awaitingInput: awaiting });
  }

  /** Recompute from the live tab states and push the diff. */
  sync(): void {
    this.rescanComposerSubs();
    const current = new Map<string, boolean>();
    for (const state of this.tabs.getTabStates()) {
      current.set(state.id, state.approvalPending || state.questionPending);
    }
    for (const push of diffTabBadgePushes(current, this.lastPushed)) {
      this.lastPushed.set(push.tabId, push.awaitingInput);
      this.pushCommand(push);
    }
    // Forget closed tabs outright (a clearing push for a tab whose dot was
    // on is already in the diff above) so the map cannot grow unboundedly
    // across a long session.
    for (const tabId of [...this.lastPushed.keys()]) {
      if (!current.has(tabId)) {
        this.lastPushed.delete(tabId);
      }
    }
  }

  /**
   * (Re)subscribe to per-tab approval events. Tabs are created dynamically,
   * so subscriptions are reconciled on every sync; closed tabs are
   * unsubscribed to avoid leaks.
   */
  private rescanComposerSubs(): void {
    const seen = new Set<string>();
    for (const tab of this.tabs.listTabs()) {
      seen.add(tab.id);
      if (!this.composerSubs.has(tab.id)) {
        this.composerSubs.set(
          tab.id,
          tab.composer.reviews.onDidChangeApproval(() => this.sync()),
        );
      }
    }
    for (const id of [...this.composerSubs.keys()]) {
      if (!seen.has(id)) {
        this.composerSubs.get(id)?.dispose();
        this.composerSubs.delete(id);
      }
    }
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    for (const d of this.composerSubs.values()) {
      d.dispose();
    }
    this.composerSubs.clear();
  }
}
