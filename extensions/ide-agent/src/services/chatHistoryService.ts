/**
 * chatHistoryService — DEV-GAPS-106B (`chat-history-command-palette`):
 * the fork port of Cursor's composer history menu behind
 * `composer.showComposerHistory` / `composer.showComposerHistoryEditor`.
 *
 * BINARY EVIDENCE (workbench.desktop.main.js, Cursor 3.25.9 — all offsets
 * re-extracted by DEV-GAPS-106B 2026-10-20, not copied from the shortlist):
 *
 * Constants (@14000834 region):
 *   EYs = "Show Chat History", IYs = "Show Chat History (Editor)"
 *   xq  = "composer.showComposerHistory"
 *   zkt = "composer.showComposerHistoryEditor"
 *
 * Pane command (class Rgm, @29919589):
 *   super({ id: xq, title: {value: EYs, original: EYs}, f1: !0,
 *     icon: Oe.historyTwo,
 *     menu: { id: Le.ViewTitle, group: Bqn, order: 2,
 *             when: view =~ ^${gA} && unifiedSidebar NOT visible },
 *     keybinding: { primary: CtrlCmd|Alt|Quote, weight: 500 } })
 *   Bqn = "navigation" (@29893710). No `category` in the descriptor.
 *   run: string arg -> id; else the `view` context key matched against
 *   `^${gA}\.(.+)$`; else `composerDataService.selectedComposerId`;
 *   found -> `getComposerHandleById` -> `composerService.showComposerHistory`;
 *   none -> notificationService.info("No active composer found. Start a
 *   new chat to view history.") (verbatim, exported below).
 *
 * Editor command (class Mgm, @29920334):
 *   super({ id: zkt, title: {value: IYs, original: IYs}, f1: !0,
 *     icon: Oe.historyTwo })   // no menu / keybinding in the Action2
 *   EditorTitle menu (@29934403 region):
 *     { command: { id: zkt, title: "Show Chat History", icon: historyTwo },
 *       group: "navigation", order: 2,
 *       when: scheme == composer && unifiedSidebar NOT visible }
 *   run: arg (string, or object with `path`) -> active composer editor ->
 *   split-editor primary/secondary (last-focused wins) -> selectedComposerId;
 *   found -> `showComposerHistoryEditor`. NO info fallback (silent).
 *
 * Service (@31883226):
 *   showComposerHistory(handle)      -> updateComposer(handle,
 *     { shouldShowHistory: true,  shouldShowHistoryEditor: false })
 *   showComposerHistoryEditor(handle)-> updateComposer(handle,
 *     { shouldShowHistory: false, shouldShowHistoryEditor: true })
 *   hideComposerHistory(handle)      -> both false
 *   (all three no-op while the unified sidebar is visible). The flags make
 *   the composer pane render the history menu (component eLS -> JPS/QPS).
 *
 * History menu (eLS @29777557, QPS @29770163, JPS wrapper):
 *   container aria-label "Agent history", width 252,
 *   maxHeight min(48vh, 420px), class composer-history-hover-menu.
 *   Entries: allComposers minus spec/project/ephemeral/best-of-N
 *   subcomposers, split archived vs not, kept when
 *   `name || isDraft || (generating with a human bubble)`, sorted by
 *   lastUpdatedAt ?? createdAt DESC, pinned (storage "pinnedComposers")
 *   first. Label: draft -> `Draft: ${subtitle}` or "Draft"; otherwise
 *   `name || "New Agent"`. Search input placeholder "Search Agents..."
 *   (aria-label "Search agents"), filter on
 *   `(label + " " + subtitle).toLowerCase().includes(query)`.
 *   Date groups (ZPS @29769537): "Today" / "Yesterday" /
 *   "Previous 7 days" / "Older"; pinned form a separate unlabelled top
 *   group. Page size 20 + 20 per `Show ${min(remaining, 20)} more` item
 *   (GOe = Atn = 20 @29769523). Archived section header "Archived" or
 *   `Archived (${count})` while searching. Empty (both lists empty, no
 *   query) -> EmptyState "No matching agents". A "Find with Agent" row
 *   appears whenever the query is non-empty; choosing it creates a new
 *   composer { text: query, unifiedMode: "agent" } with autoSubmit.
 *   Per-entry buttons: "More actions" (context menu), Pin/Unpin
 *   (aria-labels "Pin"/"Unpin"), Archive/Restore ("Archive"/"Restore").
 *   Opening an entry: openComposer({ type: "local", id, openInNewTab:
 *   true, transient: true }). Archive = cancelChat + isArchived: true.
 *
 * FORK LAYERING (same layer as Cursor, adapted to the fork's split —
 * the same split as `composer.resumeCurrentChat` / `cursor.openBranchMenu`):
 * Cursor registers the commands in workbench core and hosts the menu in
 * the composer UI over the global composer-data registry. The fork's core
 * Action2 pair lives in
 * src/vs/workbench/contrib/composer/browser/composerActions.ts and
 * delegates to this extension runtime (`ide.showComposerHistory` /
 * `ide.showComposerHistoryEditor`), which owns the chat data
 * (ChatTabService) and the picker surface.
 *
 * HONEST DIVERGENCES:
 * - The binary menu lists EVERY persisted composer (allComposers). The
 *   fork has no persisted composer registry: ChatTabService holds the
 *   session's open tabs only, so the list is the open tabs. There is no
 *   archived section (the fork tab model has no isArchived), no cloud
 *   entries, no spec/project/ephemeral filtering (no such flags), and no
 *   draft label (no isDraft/subtitle; an untouched tab keeps the fork's
 *   own default title "New chat").
 * - Sort: the binary sorts by lastUpdatedAt ?? createdAt; the fork tab
 *   model carries createdAt only, so unpinned entries sort by createdAt
 *   DESC (pinned first, in pin order — the fork's existing pin parity).
 * - Surface: the binary menu is a React dropdown anchored to the
 *   auxiliary-bar title button (which toggles show/hide). The fork's chat
 *   has no such custom header; the picker surface is a VS Code QuickPick
 *   (extension-host analog, same precedent as BranchMenuService), and the
 *   commands always SHOW the picker (the toggle lives on Cursor's title
 *   button, which has no fork surface).
 * - Opening an entry activates its existing tab (switchTab + focus)
 *   instead of openComposer({ openInNewTab, transient }) — fork tabs are
 *   already editor tabs.
 * - "More actions" (per-entry context menu) is not ported: QuickPick
 *   items expose buttons only, so the port carries the Pin/Unpin button
 *   (verbatim tooltips). Archive has no fork model (see above).
 * - The editor variant differs from the pane variant in the binary only
 *   by resolution + which flag is set (menu anchor); the fork's single
 *   picker is identical for both, so `showComposerHistoryEditor` runs the
 *   same flow. Both return whether a composer was found, mirroring the
 *   binary's found/none branch; only the pane variant surfaces the
 *   verbatim info message (in core, like the binary's notification call).
 */

/** Verbatim fallback of the pane command (binary Rgm.run @29919589). */
export const NO_ACTIVE_COMPOSER_INFO =
  "No active composer found. Start a new chat to view history.";
/** Verbatim search input placeholder (binary QPS @29770163). */
export const HISTORY_SEARCH_PLACEHOLDER = "Search Agents...";
/** Verbatim empty-state text (binary QPS @29770163). */
export const NO_MATCHING_AGENTS_LABEL = "No matching agents";
/** Verbatim find-with-agent row label (binary QPS @29770163). */
export const FIND_WITH_AGENT_LABEL = "Find with Agent";
/** Verbatim untitled-composer label fallback (binary eLS @29777557). */
export const UNTITLED_COMPOSER_LABEL = "New Agent";
/** Binary page size (GOe @29769523). */
export const HISTORY_PAGE_SIZE = 20;
/** Binary page increment (Atn @29769523). */
export const HISTORY_PAGE_INCREMENT = 20;

/**
 * Verbatim port of the binary's date-group resolver `ZPS` @29769537:
 *   dayDiff <= 0 -> "Today"; === 1 -> "Yesterday"; < 7 ->
 *   "Previous 7 days"; otherwise "Older".
 * (The binary compares start-of-day dates: `n.setHours(0,0,0,0)`.)
 */
export function historyGroupLabel(
  timestamp: number,
  now: number,
): "Today" | "Yesterday" | "Previous 7 days" | "Older" {
  const startOfDay = (t: number): number => {
    const d = new Date(t);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const r = Math.floor(
    (startOfDay(now) - startOfDay(timestamp)) / (1000 * 60 * 60 * 24),
  );
  return r <= 0 ? "Today" : r === 1 ? "Yesterday" : r < 7 ? "Previous 7 days" : "Older";
}

/** One chat as the history list sees it (the fork's ChatTab projection). */
export interface ChatHistoryTabInfo {
  id: string;
  /** Tab title (the fork's composer name; "" when untitled). */
  title: string;
  createdAt: number;
  pinned: boolean;
  pinnedAt?: number;
  /** True while a turn is generating in this tab (spinner in the binary). */
  running: boolean;
}

/** A display-ready history entry (binary eLS `H()` mapping). */
export interface ChatHistoryEntry {
  id: string;
  /** `name || "New Agent"` (binary label rule). */
  label: string;
  /** Lowercased `label + " " + subtitle` search text (binary rule; the fork has no subtitle, so the label alone). */
  searchText: string;
  timestamp: number;
  isPinned: boolean;
  isSelected: boolean;
  showSpinner: boolean;
}

/**
 * Build the binary-ordered entry list (eLS @29777557): pinned first (pin
 * order), then timestamp DESC; labels per the binary rule; `isSelected`
 * marks the entry whose id equals the selected composer id.
 */
export function buildHistoryEntries(
  tabs: readonly ChatHistoryTabInfo[],
  selectedId: string | undefined,
): ChatHistoryEntry[] {
  const entries = tabs.map((t) => {
    const label = t.title || UNTITLED_COMPOSER_LABEL;
    return {
      id: t.id,
      label,
      searchText: label.toLowerCase(),
      timestamp: t.createdAt,
      isPinned: t.pinned,
      isSelected: selectedId !== undefined && t.id === selectedId,
      showSpinner: t.running,
      pinnedAt: t.pinnedAt ?? 0,
    };
  });
  entries.sort((a, b) => {
    if (a.isPinned !== b.isPinned) {
      return a.isPinned ? -1 : 1;
    }
    if (a.isPinned && b.isPinned && a.pinnedAt !== b.pinnedAt) {
      return a.pinnedAt - b.pinnedAt;
    }
    return b.timestamp - a.timestamp;
  });
  return entries.map(({ pinnedAt: _pinnedAt, ...rest }) => rest);
}

/** Binary filter rule (QPS @29770163): searchText includes the lowered query. */
export function filterHistoryEntries(
  entries: readonly ChatHistoryEntry[],
  query: string,
): ChatHistoryEntry[] {
  const w = query.trim().toLowerCase();
  if (w.length === 0) {
    return [...entries];
  }
  return entries.filter((e) => e.searchText.includes(w));
}

/** Verbatim `Show ${min(remaining, increment)} more` label (QPS @29770163). */
export function showMoreLabel(remaining: number): string {
  return `Show ${Math.min(remaining, HISTORY_PAGE_INCREMENT)} more`;
}

/** Structural QuickPick item (satisfied by vscode.QuickPickItem). */
export interface ChatHistoryPickItem {
  label: string;
  description?: string;
  iconPath?: unknown;
  buttons?: Array<{ iconPath: unknown; tooltip?: string }>;
  alwaysShow?: boolean;
  kind?: number;
  /** Internal discriminator (not a vscode field). */
  historyKind: "entry" | "separator" | "showMore" | "findWithAgent" | "empty";
  entryId?: string;
  isPinned?: boolean;
}

/** QuickPickItemKind.Separator value (mirrors vscode's -1 without importing vscode). */
export const HISTORY_SEPARATOR_KIND = -1;

/**
 * Build the QuickPick item list for one picker state — the QPS render
 * port: pinned entries first with NO group separator (the binary treats
 * pinned as a separate top group), then date-group separators for the
 * rest; at most `visibleCount` entries; a `Show N more` row while more
 * remain; the "No matching agents" row when nothing matches and the
 * query is empty (binary Q condition); a "Find with Agent" row whenever
 * the query is non-empty (binary H condition).
 */
export function buildHistoryPickItems(input: {
  entries: readonly ChatHistoryEntry[];
  query: string;
  visibleCount: number;
  now: number;
  pinIcon: unknown;
  pinnedIcon: unknown;
  searchIcon: unknown;
}): ChatHistoryPickItem[] {
  const query = input.query.trim();
  const filtered = filterHistoryEntries(input.entries, query);
  const items: ChatHistoryPickItem[] = [];

  if (filtered.length === 0) {
    if (query.length === 0) {
      items.push({
        label: NO_MATCHING_AGENTS_LABEL,
        historyKind: "empty",
        alwaysShow: true,
      });
    }
  } else {
    const visible = filtered.slice(0, input.visibleCount);
    let lastGroup: string | undefined;
    let pinnedBlockDone = false;
    for (const entry of visible) {
      if (entry.isPinned) {
        // Pinned = separate top group, no separator title (binary QPS).
      } else {
        if (!pinnedBlockDone) {
          pinnedBlockDone = true;
          lastGroup = undefined;
        }
        const group = historyGroupLabel(entry.timestamp, input.now);
        if (group !== lastGroup) {
          items.push({
            label: group,
            historyKind: "separator",
            kind: HISTORY_SEPARATOR_KIND,
          });
          lastGroup = group;
        }
      }
      items.push({
        label: entry.label,
        historyKind: "entry",
        entryId: entry.id,
        isPinned: entry.isPinned,
        iconPath: entry.isPinned ? input.pinnedIcon : undefined,
        buttons: [
          {
            iconPath: entry.isPinned ? input.pinnedIcon : input.pinIcon,
            tooltip: entry.isPinned ? "Unpin" : "Pin",
          },
        ],
      });
    }
    const remaining = filtered.length - visible.length;
    if (remaining > 0) {
      items.push({
        label: showMoreLabel(remaining),
        historyKind: "showMore",
        alwaysShow: true,
      });
    }
  }

  if (query.length > 0) {
    items.push({
      label: FIND_WITH_AGENT_LABEL,
      historyKind: "findWithAgent",
      iconPath: input.searchIcon,
      alwaysShow: true,
    });
  }
  return items;
}

/** Host seam: extension.ts binds this to ChatTabService + vscode UI. */
export interface ChatHistoryHost {
  listTabs(): ChatHistoryTabInfo[];
  activeTabId(): string | undefined;
  openTab(id: string): void | Promise<void>;
  setPinned(id: string, pinned: boolean): boolean;
  findWithAgent(query: string): void | Promise<void>;
  /** Icon factories (vscode.ThemeIcon in the real host). */
  icon(name: string): unknown;
}

/** Minimal structural QuickPick (satisfied by vscode.QuickPick). */
export interface ChatHistoryQuickPick {
  placeholder: string;
  matchOnDescription: boolean;
  matchOnDetail: boolean;
  items: readonly ChatHistoryPickItem[];
  activeItems: readonly ChatHistoryPickItem[];
  value: string;
  onDidChangeValue(listener: (value: string) => void): { dispose(): void };
  onDidAccept(listener: () => void): { dispose(): void };
  onDidTriggerItemButton(
    listener: (e: { item: ChatHistoryPickItem }) => void,
  ): { dispose(): void };
  onDidHide(listener: () => void): { dispose(): void };
  show(): void;
  hide(): void;
  dispose(): void;
}

/**
 * The history picker flow (QPS behavior port). The QuickPick factory is
 * injected so tests can drive the whole flow with a fake picker.
 */
export class ChatHistoryService {
  constructor(
    private readonly host: ChatHistoryHost,
    private readonly createQuickPick: () => ChatHistoryQuickPick,
  ) {}

  /**
   * Port of the pane command's show path: presents the history list for
   * the composer identified by `sourceComposerId` (falling back to the
   * active/selected tab — the binary's selectedComposerId fallback).
   * Returns false only when there is no composer at all (the binary's
   * info-message branch; unreachable while ChatTabService guarantees an
   * active tab, kept for contract parity).
   */
  async showComposerHistory(
    sourceComposerId?: string,
  ): Promise<boolean> {
    return this.presentHistory(sourceComposerId);
  }

  /** Editor variant — same list, editor-anchored in the binary (see header). */
  async showComposerHistoryEditor(
    sourceComposerId?: string,
  ): Promise<boolean> {
    return this.presentHistory(sourceComposerId);
  }

  private async presentHistory(
    sourceComposerId?: string,
  ): Promise<boolean> {
    const tabs = this.host.listTabs();
    if (tabs.length === 0) {
      return false;
    }
    const selectedId =
      sourceComposerId !== undefined &&
      tabs.some((t) => t.id === sourceComposerId)
        ? sourceComposerId
        : this.host.activeTabId();

    const qp = this.createQuickPick();
    qp.placeholder = HISTORY_SEARCH_PLACEHOLDER;
    // Filtering is manual (binary searchText rule), not the picker's.
    qp.matchOnDescription = false;
    qp.matchOnDetail = false;

    let visibleCount: number = HISTORY_PAGE_SIZE;
    let query = "";
    let disposed = false;
    const disposables: Array<{ dispose(): void }> = [];

    const render = (): void => {
      const entries = buildHistoryEntries(this.host.listTabs(), selectedId);
      const items = buildHistoryPickItems({
        entries,
        query,
        visibleCount,
        now: Date.now(),
        pinIcon: this.host.icon("pin"),
        pinnedIcon: this.host.icon("pinned"),
        searchIcon: this.host.icon("search"),
      });
      qp.items = items;
      const selected = items.find(
        (i) => i.historyKind === "entry" && i.entryId === selectedId,
      );
      if (selected) {
        qp.activeItems = [selected];
      }
    };

    disposables.push(
      qp.onDidChangeValue((value) => {
        query = value;
        visibleCount = HISTORY_PAGE_SIZE;
        render();
      }),
    );
    disposables.push(
      qp.onDidTriggerItemButton(({ item }) => {
        if (item.historyKind !== "entry" || !item.entryId) {
          return;
        }
        // Binary per-entry Pin/Unpin button (aria-labels verbatim).
        this.host.setPinned(item.entryId, !item.isPinned);
        render();
      }),
    );
    disposables.push(
      qp.onDidAccept(() => {
        const item = qp.activeItems[0];
        if (!item) {
          return;
        }
        if (item.historyKind === "showMore") {
          visibleCount += HISTORY_PAGE_INCREMENT;
          render();
          return;
        }
        qp.hide();
        if (item.historyKind === "entry" && item.entryId) {
          void this.host.openTab(item.entryId);
        } else if (item.historyKind === "findWithAgent") {
          const text = query.trim();
          if (text.length > 0) {
            void this.host.findWithAgent(text);
          }
        }
      }),
    );
    disposables.push(
      qp.onDidHide(() => {
        if (disposed) {
          return;
        }
        disposed = true;
        for (const d of disposables) {
          d.dispose();
        }
        qp.dispose();
      }),
    );

    render();
    qp.show();
    return true;
  }
}
