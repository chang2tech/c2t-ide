import * as vscode from "vscode";
import { ComposerDataService, ComposerEvent } from "./composerDataService";
import { HookService } from "../hooks/hookService";
import type { ModeName } from "../model";

/**
 * ChatTabService — real chat tabs (doc-gap B8, Cursor parity).
 *
 * Each tab owns a full ComposerDataService: its own bubbles (history), mode,
 * message queue, checkpoints, approvals and engine session. Tabs run
 * independently — a turn in one tab does not block another.
 *
 * The webview shows one tab at a time (the active tab). The service forwards
 * composer events tagged with the originating tab id; hosts filter to the
 * active tab for transcript updates but listen to all tabs for tab-bar
 * state (running spinners) and tab-list changes.
 */

export interface ChatTab {
  id: string;
  title: string;
  composer: ComposerDataService;
  createdAt: number;
  /**
   * Cursor 2.1 parity (cursor.com/changelog/page/13): "In the agent sidebar,
   * pin chats at the top for future reference." A pinned chat stays fixed at
   * the top of the chat list, ordered by pin time.
   */
  pinned: boolean;
  /** When the chat was pinned (pin order). Undefined while unpinned. */
  pinnedAt?: number;
}

export interface ChatTabState {
  id: string;
  title: string;
  active: boolean;
  running: boolean;
  queuedCount: number;
  pinned: boolean;
  /**
   * Cursor parity (chat-orange-dot, cursor.com/changelog/0-48-x: "When a tab
   * is awaiting your input, you'll see an orange dot on that tab").
   * "Awaiting input" covers approval requests AND clarifying questions —
   * both block the agent's turn until the user responds. The webview's tab
   * bar renders the dot from these flags.
   */
  approvalPending: boolean;
  questionPending: boolean;
}

export type ChatTabEvent =
  | { kind: "tabsChanged" }
  | { kind: "composerEvent"; tabId: string; event: ComposerEvent };

/**
 * DEV-GAPS-81 (F1 phụ): verbatim strings of Cursor's running-tab confirm
 * dialog (workbench.glass.main.js 3.25.9 @39861810, `composer.closeComposerTab`
 * run): title, message and the primary button's label. The binary's
 * cancelButton label is "Cancel" — VS Code modals render their implicit
 * cancel affordance instead of a second item, so it has no constant here.
 */
export const CLOSE_RUNNING_TAB_TITLE = "Close Running Tab?";
export const CLOSE_RUNNING_TAB_MESSAGE =
  "The chat is currently running. Are you sure you want to close it?";
export const CLOSE_RUNNING_TAB_CONFIRM_LABEL = "Close Tab";

let tabSeq = 0;

/** globalState key for the persisted pin set ({id, pinnedAt}[]). */
const PINNED_CHATS_KEY = "ideAgent.pinnedChats";
/**
 * Cap on stored pin entries.
 * Cursor 3.25.9 parity — binary evidence (QA-ADVERSARIAL 2026-10-19 22:35,
 * Finding 2 pinned-chats-cap P3): `pinnedAgentsStorage.js` persists
 * `cursor/pinnedComposers` with max 75.
 */
const MAX_STORED_PINS = 75;

/** One persisted pin entry. */
interface SavedPin {
  id: string;
  pinnedAt: number;
}

/**
 * Minimal shape compareChatTabs needs — lets other chat-list surfaces
 * (e.g. the desktop bridge's listThreads) share the exact display order
 * without importing the full ChatTab (which carries a composer).
 */
export interface ChatTabSortKey {
  id: string;
  createdAt: number;
  pinned: boolean;
  pinnedAt?: number;
}

/**
 * Display order for chat lists (Cursor 2.1 pin parity): pinned chats first,
 * in pin order; everything else in time order (createdAt ascending — this
 * matches the service's natural insertion order, so unpinning a chat
 * returns it exactly to where it was).
 *
 * Note on "time order": ChatTab carries no last-activity signal, so time
 * order here is creation order. Cursor's exact unpinned tie-break beyond
 * evidence ("pin chats at the top … / unpin → back to time order") is
 * UNKNOWN; creation order is the honest, observable choice.
 */
export function compareChatTabs(a: ChatTabSortKey, b: ChatTabSortKey): number {
  if (a.pinned !== b.pinned) {
    return a.pinned ? -1 : 1;
  }
  if (a.pinned && b.pinned) {
    const pa = a.pinnedAt ?? 0;
    const pb = b.pinnedAt ?? 0;
    if (pa !== pb) {
      return pa - pb;
    }
  }
  if (a.createdAt !== b.createdAt) {
    return a.createdAt - b.createdAt;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Auto-title from the first user message (Cursor shows a summary-ish title). */
function titleFromText(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= 28) {
    return oneLine || "New chat";
  }
  return `${oneLine.slice(0, 28)}…`;
}

export class ChatTabService implements vscode.Disposable {
  private readonly tabs = new Map<string, ChatTab>();
  private activeId: string | undefined;
  private readonly emitter = new vscode.EventEmitter<ChatTabEvent>();
  readonly onDidChange = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [];
  /**
   * P2 (QA-CHATTABS-X1): per-tab relay disposables. createTab used to push
   * every tab's composer.onDidChange relay into the shared `disposables`
   * array and closeTab never removed it — a closed tab's composer (and its
   * whole bubble store) was never GC'd. Now each tab's relay is tracked by
   * tab id and disposed on close.
   */
  private readonly tabRelays = new Map<string, vscode.Disposable>();
  /**
   * DEV-KEYBOARD-FIX: stack of recently closed tabs (Cursor "Reopen Last
   * Closed Chat Tab", Ctrl+Shift+T parity). Only the mode + title survive —
   * closeTab disposes the composer, so the transcript cannot be restored.
   */
  private readonly closedStack: Array<{ mode: ModeName; title: string }> = [];

  /**
   * DEV-KEYBOARD-FIX: pop the most recently closed tab descriptor, if any.
   * The caller recreates the tab (mode + title); the transcript is gone.
   */
  popClosedTab(): { mode: ModeName; title: string } | undefined {
    return this.closedStack.pop();
  }

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly hookService?: HookService,
  ) {
    const first = this.createTab({ title: "New chat" });
    this.activeId = first.id;
    this.restorePins();
  }

  /**
   * Context ring: provider for the connected-MCP tool catalog. Set once by
   * extension.ts after activateMcp (McpService is created after the tab
   * service); applied to existing tabs and every tab created later.
   */
  private mcpToolsProvider?: () => import("./contextUsageService").McpCatalogEntry[];
  setMcpToolsProvider(provider: () => import("./contextUsageService").McpCatalogEntry[]): void {
    this.mcpToolsProvider = provider;
    for (const tab of this.listTabs()) {
      tab.composer.setMcpToolsProvider(provider);
    }
  }

  /**
   * GAPS-152 (`agent-notification-actions`): clean-turn-completion hook —
   * the extension's AgentNotificationService subscribes here to fire the
   * binary's OS "Done" notification (capability `onChatStreamFinished`,
   * workbench.desktop.main.js 3.25.9 @31367250). Wired per composer in
   * createTab (the listener resolves the tab at call time, so the hook
   * may be set before or after tabs exist).
   */
  private turnCompletedHook?: (tab: ChatTab) => void;
  setTurnCompletedHook(hook: (tab: ChatTab) => void): void {
    this.turnCompletedHook = hook;
  }

  /**
   * DEV-GAPS-10 (rex-004): `.cursor/permissions.json` policy — applied to
   * every tab's approval choke point (HumanReviewService) and remembered for
   * tabs created later. Same fan-out pattern as setMcpToolsProvider.
   */
  private filePermissions?: import("./permissionsFileService").CursorPermissionsPolicy;
  setFilePermissions(
    policy: import("./permissionsFileService").CursorPermissionsPolicy | undefined,
  ): void {
    this.filePermissions = policy;
    for (const tab of this.listTabs()) {
      tab.composer.reviews.setFilePermissions(policy);
    }
  }

  /** The currently active tab. */
  get activeTab(): ChatTab {
    const tab = this.activeId ? this.tabs.get(this.activeId) : undefined;
    if (tab) {
      return tab;
    }
    // Defensive: never leave the UI without an active tab.
    const first = this.tabs.values().next().value as ChatTab | undefined;
    if (first) {
      this.activeId = first.id;
      return first;
    }
    const created = this.createTab({ title: "New chat" });
    this.activeId = created.id;
    return created;
  }

  /** Shortcut for the active tab's composer (the transcript the UI shows). */
  get activeComposer(): ComposerDataService {
    return this.activeTab.composer;
  }

  get tabCount(): number {
    return this.tabs.size;
  }

  listTabs(): ChatTab[] {
    return [...this.tabs.values()];
  }

  /** Chat lists for display: pinned first (pin order), then time order. */
  getTabStates(): ChatTabState[] {
    return [...this.tabs.values()].sort(compareChatTabs).map((t) => ({
      id: t.id,
      title: t.title,
      active: t.id === this.activeId,
      running: t.composer.isRunning,
      queuedCount: t.composer.queue.length,
      pinned: t.pinned,
      // DEV-ORANGE-DOT: previously the tab-bar payload never carried these
      // flags, so the webview's `t.approvalPending` check was dead code and
      // the dot could never show. Now populated from the real per-tab
      // approval/question state; flags clear when the user resolves them
      // (onDidChangeApproval fires undefined / questionAnswered removes the
      // question — both re-push the tab list via postTabs).
      approvalPending: t.composer.reviews.currentApproval !== undefined,
      questionPending: t.composer.getPendingQuestions().length > 0,
    }));
  }

  createTab(opts?: { title?: string; mode?: ModeName }): ChatTab {
    tabSeq += 1;
    const id = `tab-${tabSeq}`;
    const composer = new ComposerDataService(this.context, this.hookService);
    // W71B (DEV-GAPS-71): tag the composer with its tab id — the per-tab
    // wiring site. The plan-producer bridge (`capturePendingPlan` ->
    // `ide.recordComposerPlan`) records under this id, which is the same id
    // the core `composer.acceptPlan` command resolves (`ComposerChatEditorInput.tabId`).
    composer.tabId = id;
    // GAPS-152: forward clean turn completions to the notification hook
    // (resolves the tab at call time — the tab enters the map below).
    composer.turnCompletedListener = () => {
      const completedTab = this.tabs.get(id);
      if (completedTab) {
        this.turnCompletedHook?.(completedTab);
      }
    };
    if (this.mcpToolsProvider) {
      composer.setMcpToolsProvider(this.mcpToolsProvider);
    }
    // DEV-GAPS-10 (rex-004): new tabs inherit the current file permissions policy.
    composer.reviews.setFilePermissions(this.filePermissions);
    if (opts?.mode) {
      composer.modes.setMode(opts.mode);
    }
    const tab: ChatTab = {
      id,
      title: opts?.title ?? "New chat",
      composer,
      createdAt: Date.now(),
      pinned: false,
    };
    // Forward this tab's composer events, tagged with the tab id.
    // P2 (QA-CHATTABS-X1): tracked per tab so closeTab can dispose it.
    const relay = composer.onDidChange((event) => {
      // Auto-title: first human message sets the tab title.
      if (event.kind === "bubblesChanged" && tab.title === "New chat") {
        const humans = composer.bubbles
          .getAllInOrder()
          .filter((b) => b.role === "human");
        const firstText = humans[0]?.text?.trim();
        if (firstText) {
          tab.title = titleFromText(firstText);
          this.emitter.fire({ kind: "tabsChanged" });
        }
      }
      // P3 (QA-CHATTABS-X1): a cleared chat gets a fresh title — otherwise
      // the first message after newChat never re-titles the tab because the
      // auto-title above only fires when title === "New chat".
      if (event.kind === "newChat" && tab.title !== "New chat") {
        tab.title = "New chat";
        this.emitter.fire({ kind: "tabsChanged" });
      }
      this.emitter.fire({ kind: "composerEvent", tabId: id, event });
    });
    this.tabRelays.set(id, relay);
    this.disposables.push(relay);
    this.tabs.set(id, tab);
    this.emitter.fire({ kind: "tabsChanged" });
    return tab;
  }

  /** Create a tab and make it active (the "New Agent Chat" command). */
  createAndActivate(opts?: { title?: string; mode?: ModeName }): ChatTab {
    const tab = this.createTab(opts);
    this.activeId = tab.id;
    this.emitter.fire({ kind: "tabsChanged" });
    return tab;
  }

  switchTab(id: string): boolean {
    if (!this.tabs.has(id) || id === this.activeId) {
      return false;
    }
    this.activeId = id;
    this.emitter.fire({ kind: "tabsChanged" });
    return true;
  }

  nextTab(): ChatTab {
    const list = this.listTabs();
    const idx = list.findIndex((t) => t.id === this.activeId);
    const next = list[(idx + 1) % list.length]!;
    this.activeId = next.id;
    this.emitter.fire({ kind: "tabsChanged" });
    return next;
  }

  previousTab(): ChatTab {
    const list = this.listTabs();
    const idx = list.findIndex((t) => t.id === this.activeId);
    const prev = list[(idx - 1 + list.length) % list.length]!;
    this.activeId = prev.id;
    this.emitter.fire({ kind: "tabsChanged" });
    return prev;
  }

  /**
   * DEV-GAPS-80 (W80C-R3): fork port of Cursor's SubComposer-tab switch —
   * binary-verbatim commands `composer.selectNextSubComposerTab` /
   * `composer.selectPreviousSubComposerTab` ("Select Next/Previous
   * SubComposer Tab", workbench.glass.main.js 3.25.9: id constants
   * iQp/rQp @15886314/@15886358; action classes @~39818374: f1:false,
   * keybinding Alt+CtrlCmd+RightArrow/LeftArrow, weight 200, when
   * composerFocused). The binary actions do not switch anything
   * themselves: they fire `fireDidRequestSwitchSubComposerTab({
   * composerId: selectedComposerId, direction: "next"|"previous"})` on
   * the composer event service (emitter @17604655-17608065), and the
   * composer's child tabs are its Best-of-N subcomposers
   * (`subComposerIds[]` + `selectedSubComposerId` on the parent, e.g.
   * the tab-selection effect @20318922).
   *
   * HONEST DIVERGENCES (fork has no Best-of-N subcomposer child tabs —
   * subagents run inside the parent tab's composer, see closeTab):
   *  - The selectable ring here is the service's real tab list
   *    (`listTabs()`, insertion order) — the only tab surface the fork
   *    actually renders (ide-chat:/<tabId> editor tabs + sidebar list).
   *    Selecting moves `activeId` and fires `tabsChanged`, exactly like
   *    switchTab/nextTab, so the webview/editor reveal follows.
   *  - Wrap vs clamp at the edges: NO consumer of
   *    `onDidRequestSwitchSubComposerTab` exists in the extracted glass
   *    or desktop main bundles (the string occurs only as the emitter
   *    definition + the two action runs), so the binary's edge
   *    behaviour is UNKNOWN. The fork reuses its own established tab
   *    cycling semantics — nextTab()/previousTab() WRAP around — rather
   *    than inventing a clamp. The only binary-verified edge behaviour
   *    is on delete: selectedSubComposerId falls back to the first
   *    remaining subcomposer (@39962209 region), which has no fork
   *    analog here (closeTab already reassigns activeId to the first
   *    surviving tab).
   *  - With a single tab both methods are a stable no-op selection
   *    (nextTab/previousTab return that same tab).
   */
  selectNextSubComposerTab(): ChatTab {
    return this.nextTab();
  }

  /** DEV-GAPS-80: previous-direction counterpart — see selectNextSubComposerTab. */
  selectPreviousSubComposerTab(): ChatTab {
    return this.previousTab();
  }

  renameTab(id: string, title: string): boolean {
    const tab = this.tabs.get(id);
    const clean = title.replace(/\s+/g, " ").trim().slice(0, 60);
    if (!tab || clean.length === 0) {
      return false;
    }
    tab.title = clean;
    this.emitter.fire({ kind: "tabsChanged" });
    return true;
  }

  /**
   * Pin a chat: it stays fixed at the top of every chat list, ordered by
   * pin time (Cursor 2.1 parity). Re-pinning an already-pinned chat keeps
   * its original pin position.
   */
  pinChat(id: string): boolean {
    const tab = this.tabs.get(id);
    if (!tab || tab.pinned) {
      return false;
    }
    tab.pinned = true;
    tab.pinnedAt = Date.now();
    this.persistPins();
    this.emitter.fire({ kind: "tabsChanged" });
    return true;
  }

  /** Unpin a chat: it returns to time order in every chat list. */
  unpinChat(id: string): boolean {
    const tab = this.tabs.get(id);
    if (!tab || !tab.pinned) {
      return false;
    }
    tab.pinned = false;
    tab.pinnedAt = undefined;
    this.persistPins();
    this.emitter.fire({ kind: "tabsChanged" });
    return true;
  }

  /**
   * Write the current pin set to globalState (fire-and-forget; persistence
   * must never break tab operations). Capped so the stored value can't
   * grow without bound.
   */
  private persistPins(): void {
    try {
      const pins: SavedPin[] = [...this.tabs.values()]
        .filter((t) => t.pinned)
        .sort(compareChatTabs)
        .slice(0, MAX_STORED_PINS)
        .map((t) => ({ id: t.id, pinnedAt: t.pinnedAt ?? Date.now() }));
      void Promise.resolve(this.context.globalState.update(PINNED_CHATS_KEY, pins)).catch(() => {
        /* persist must never throw */
      });
    } catch {
      /* persist must never throw */
    }
  }

  /**
   * Best-effort restore of pinned flags from the previous session.
   *
   * LIMITATION — Cursor's cross-restart pin semantics are UNKNOWN (the only
   * evidence is the 2.1 changelog line). Tab ids are regenerated every
   * session (`tab-N`), so an id from a previous session cannot reliably
   * denote the same chat. We apply whatever entries match live ids and
   * closeTab drops the id from the stored map, which keeps stale entries
   * from accumulating. A future stable-session-id layer should key pins by
   * that id instead.
   */
  private restorePins(): void {
    try {
      const saved = this.context.globalState.get<SavedPin[]>(PINNED_CHATS_KEY);
      if (!Array.isArray(saved)) {
        return;
      }
      for (const entry of saved) {
        const tab = typeof entry?.id === "string" ? this.tabs.get(entry.id) : undefined;
        if (tab && !tab.pinned) {
          tab.pinned = true;
          tab.pinnedAt = typeof entry.pinnedAt === "number" ? entry.pinnedAt : Date.now();
        }
      }
    } catch {
      /* restore must never break startup */
    }
  }

  /** Remove one tab's entry from the persisted pin set (called on close). */
  private forgetPin(id: string): void {
    try {
      const saved = this.context.globalState.get<SavedPin[]>(PINNED_CHATS_KEY);
      if (!Array.isArray(saved) || !saved.some((e) => e?.id === id)) {
        return;
      }
      void Promise.resolve(
        this.context.globalState.update(
          PINNED_CHATS_KEY,
          saved.filter((e) => e?.id !== id),
        ),
      ).catch(() => {
        /* persist must never throw */
      });
    } catch {
      /* persist must never throw */
    }
  }

  /**
   * Close a tab. While that tab's turn is running OR draining, the user
   * is asked first with Cursor's verbatim confirm dialog (DEV-GAPS-81,
   * F1 phụ — QA GAPS-79C): confirm closes, cancel/dismiss keeps the tab.
   * Closing the last tab clears it instead (Cursor always keeps one chat open).
   *
   * Binary evidence (workbench.glass.main.js 3.25.9, re-read directly
   * by DEV-GAPS-81): the dialog lives in the `composer.closeComposerTab`
   * action (class MAb, byte offset 39861810):
   *   if (isComposerRunning(handle)) {
   *     if (!isBackgroundAgentChat && !isSubcomposer(data) &&
   *         await openDialog({
   *           title: "Close Running Tab?",
   *           message: "The chat is currently running. Are you sure you want to close it?",
   *           primaryButton: { id: "close", label: "Close Tab" },
   *           cancelButton: { id: "cancel", label: "Cancel" },
   *           dialogIcon: warning }) !== "close") return;
   *   }
   *   await closeComposer(id)
   * Fork mapping + honest divergences:
   *  - VS Code's modal warning is the dialog host: title as the message,
   *    the binary message as `detail`, "Close Tab" as the affirmative
   *    item; "Cancel" is the modal's implicit cancel (returns
   *    undefined), matching the binary's cancelButton.
   *  - The binary's two skip conditions have no fork counterpart —
   *    background-agent chats and subcomposer/subagent chats are not
   *    tabs here (subagents run inside the parent tab's composer) — so
   *    every running tab asks.
   *  - In the binary the dialog sits in the single Close Tab action;
   *    Close All / Close Other call closeComposer directly (no prompt —
   *    running composers close silently). The fork deliberately puts
   *    the confirm in closeTab itself (DEV-GAPS-81 task spec), so ALL
   *    wired close paths share it — single close, editor/sidebar tab X,
   *    closeAllChatTabs and closeOtherTabs; in bulk closes a cancelled
   *    prompt keeps that tab and counts it `skipped`, preserving the
   *    established DEV-GAPS-73 accounting. This is a conscious
   *    divergence from the binary's silent bulk close, chosen over
   *    destroying running turns without asking.
   *  - `isDraining` (P2-6, QA-CHATTABS-01) is a fork-only state — the
   *    drain window has running === false while follow-up turns are
   *    about to start — and is treated as running for the prompt.
   *
   * P1-2 (QA-CHATTABS-01): the tab's composer is disposed — its sidecar
   * `bun serve` is killed, no zombie processes. Disposing a mid-turn
   * composer is a supported path (dispose settles the turn as aborted),
   * which is what makes a confirmed running close safe.
   */
  async closeTab(id: string): Promise<boolean> {
    const tab = this.tabs.get(id);
    if (!tab) {
      return false;
    }
    let confirmedRunningClose = false;
    if (tab.composer.isRunning || tab.composer.isDraining) {
      const choice = await vscode.window.showWarningMessage(
        CLOSE_RUNNING_TAB_TITLE,
        { modal: true, detail: CLOSE_RUNNING_TAB_MESSAGE },
        CLOSE_RUNNING_TAB_CONFIRM_LABEL,
      );
      if (choice !== CLOSE_RUNNING_TAB_CONFIRM_LABEL) {
        return false;
      }
      confirmedRunningClose = true;
    }
    if (this.tabs.size === 1) {
      if (confirmedRunningClose) {
        // Last tab + running: newChat() refuses mid-turn by design, so
        // stop the turn first and wait (bounded) for it to settle —
        // the binary's closeComposer resets the last composer outright.
        tab.composer.abort();
        if (!(await this.waitForTurnToSettle(tab.composer))) {
          return false;
        }
      }
      // Last tab: clear it instead of closing (verified newChat semantics).
      return tab.composer.newChat();
    }
    // DEV-KEYBOARD-FIX: remember mode + title for ide.reopenChatTab
    // (Ctrl+Shift+T). Capped so the stack can't grow without bound.
    this.closedStack.push({ mode: tab.composer.modes.getMode(), title: tab.title });
    if (this.closedStack.length > 10) {
      this.closedStack.shift();
    }
    this.disposeTabRelay(id);
    tab.composer.dispose();
    this.tabs.delete(id);
    // A closed tab takes its pin with it — keeps the persisted pin set
    // from accumulating ids that no longer exist.
    this.forgetPin(id);
    if (this.activeId === id) {
      this.activeId = this.listTabs()[0]!.id;
    }
    this.emitter.fire({ kind: "tabsChanged" });
    return true;
  }

  /**
   * DEV-GAPS-73 (`chat-tab-close-actions`, Cursor 3.25.6 parity):
   * bulk-close backing for `composer.clearComposerTabs` ("Close All Tabs")
   * and `composer.closeOtherComposerTabs` ("Close Other Tabs"). These
   * methods reuse the established `closeTab` semantics verbatim instead
   * of inventing new ones:
   *  - a tab whose turn is running or draining triggers `closeTab`'s
   *    "Close Running Tab?" confirm dialog (DEV-GAPS-81 — the binary's
   *    dialog, which the binary itself only shows for the single Close
   *    Tab action; see the closeTab doc for the divergence note) —
   *    confirming closes it, cancelling keeps it and it is reported
   *    as `skipped`;
   *  - the LAST surviving tab is cleared via `newChat()` rather than
   *    removed ("Cursor always keeps one chat open"), so clearing ALL
   *    chats leaves exactly one fresh chat, matching `closeTab`.
   *
   * Returns the count of tabs actually closed (for `closeAllChatTabs`
   * the final cleared tab counts as closed — its transcript is gone)
   * and the count of tabs skipped because a turn refused the close.
   */
  async closeAllChatTabs(): Promise<{ closed: number; skipped: number }> {
    let closed = 0;
    let skipped = 0;
    // listTabs() is a snapshot — closeTab mutates the map as we iterate.
    for (const tab of this.listTabs()) {
      if (await this.closeTab(tab.id)) {
        closed += 1;
      } else {
        skipped += 1;
      }
    }
    return { closed, skipped };
  }

  /**
   * DEV-GAPS-73: close every tab EXCEPT `keepId` (the active tab, whose
   * unsent draft the user is looking at). Same per-tab `closeTab`
   * semantics and reporting as `closeAllChatTabs`.
   */
  async closeOtherTabs(keepId: string): Promise<{ closed: number; skipped: number }> {
    let closed = 0;
    let skipped = 0;
    for (const tab of this.listTabs()) {
      if (tab.id === keepId) {
        continue;
      }
      if (await this.closeTab(tab.id)) {
        closed += 1;
      } else {
        skipped += 1;
      }
    }
    return { closed, skipped };
  }

  /**
   * DEV-GAPS-81: bounded wait for a turn to wind down after abort() —
   * polls the composer's running/draining flags (the engine settles
   * asynchronously once its stream notices the abort). Returns false on
   * timeout so the caller can keep the tab instead of clearing under a
   * live turn.
   */
  private async waitForTurnToSettle(
    composer: ComposerDataService,
    timeoutMs = 2000,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (composer.isRunning || composer.isDraining) {
      if (Date.now() >= deadline) {
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return true;
  }

  /** P2 (QA-CHATTABS-X1): dispose a tab's event relay so it can be GC'd. */
  private disposeTabRelay(id: string): void {
    const relay = this.tabRelays.get(id);
    if (relay) {
      this.tabRelays.delete(id);
      const idx = this.disposables.indexOf(relay);
      if (idx >= 0) {
        this.disposables.splice(idx, 1);
      }
      relay.dispose();
    }
  }

  dispose(): void {
    // P1-2 (QA-CHATTABS-01): dispose every tab's composer (kills sidecars).
    for (const tab of this.tabs.values()) {
      this.disposeTabRelay(tab.id);
      try {
        tab.composer.dispose();
      } catch {
        /* dispose must never throw */
      }
    }
    this.tabs.clear();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
