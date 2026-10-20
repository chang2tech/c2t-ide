/**
 * DEV-GAPS-106B (`chat-history-command-palette`) tests (node:test, no
 * vscode needed — the QuickPick is a structural fake).
 *
 * Cursor parity (binary evidence, workbench.desktop.main.js 3.25.9,
 * re-extracted by DEV-GAPS-106B 2026-10-20):
 * - `composer.showComposerHistory` (class Rgm @29919589): f1:!0, icon
 *   historyTwo, ViewTitle menu group "navigation" order 2, keybinding
 *   CtrlCmd|Alt|Quote weight 500; fallback info verbatim
 *   "No active composer found. Start a new chat to view history."
 * - History menu (eLS @29777557 / QPS @29770163): search placeholder
 *   "Search Agents...", filter on lowered searchText, date groups ZPS
 *   @29769537 ("Today"/"Yesterday"/"Previous 7 days"/"Older"), page size
 *   20 (`GOe`/`Atn` @29769523) + `Show N more`, empty state
 *   "No matching agents", "Find with Agent" row on non-empty query,
 *   labels `name || "New Agent"`, pinned first.
 *
 * Run after `tsc`:  node --test out/services/test/run-chat-history-tests.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import {
  ChatHistoryService,
  buildHistoryEntries,
  buildHistoryPickItems,
  filterHistoryEntries,
  historyGroupLabel,
  showMoreLabel,
  FIND_WITH_AGENT_LABEL,
  HISTORY_PAGE_INCREMENT,
  HISTORY_PAGE_SIZE,
  HISTORY_SEARCH_PLACEHOLDER,
  NO_ACTIVE_COMPOSER_INFO,
  NO_MATCHING_AGENTS_LABEL,
  type ChatHistoryHost,
  type ChatHistoryPickItem,
  type ChatHistoryQuickPick,
  type ChatHistoryTabInfo,
} from "../chatHistoryService";

const NOW = new Date(2026, 9, 20, 15, 0, 0).getTime(); // 2026-10-20 15:00 local
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function tab(
  partial: Partial<ChatHistoryTabInfo> & { id: string },
): ChatHistoryTabInfo {
  return {
    title: "",
    createdAt: NOW,
    pinned: false,
    running: false,
    ...partial,
  };
}

describe("verbatim strings (binary QPS/Rgm)", () => {
  it("fallback info, placeholder, empty state match the binary", () => {
    assert.strictEqual(
      NO_ACTIVE_COMPOSER_INFO,
      "No active composer found. Start a new chat to view history.",
    );
    assert.strictEqual(HISTORY_SEARCH_PLACEHOLDER, "Search Agents...");
    assert.strictEqual(NO_MATCHING_AGENTS_LABEL, "No matching agents");
    assert.strictEqual(FIND_WITH_AGENT_LABEL, "Find with Agent");
    assert.strictEqual(HISTORY_PAGE_SIZE, 20);
    assert.strictEqual(HISTORY_PAGE_INCREMENT, 20);
  });
});

describe("historyGroupLabel — verbatim ZPS @29769537", () => {
  it("same day -> Today (incl. later same-day timestamps)", () => {
    assert.strictEqual(historyGroupLabel(NOW - HOUR, NOW), "Today");
    assert.strictEqual(historyGroupLabel(NOW + HOUR, NOW), "Today");
  });
  it("previous calendar day -> Yesterday", () => {
    assert.strictEqual(historyGroupLabel(NOW - DAY, NOW), "Yesterday");
  });
  it("2..6 days -> Previous 7 days; 7+ -> Older", () => {
    assert.strictEqual(historyGroupLabel(NOW - 2 * DAY, NOW), "Previous 7 days");
    assert.strictEqual(historyGroupLabel(NOW - 6 * DAY, NOW), "Previous 7 days");
    assert.strictEqual(historyGroupLabel(NOW - 7 * DAY, NOW), "Older");
    assert.strictEqual(historyGroupLabel(NOW - 90 * DAY, NOW), "Older");
  });
});

describe("buildHistoryEntries — eLS ordering + labels", () => {
  it("label falls back to 'New Agent' for untitled tabs", () => {
    const [e] = buildHistoryEntries([tab({ id: "tab-1", title: "" })], undefined);
    assert.strictEqual(e!.label, "New Agent");
    assert.strictEqual(e!.searchText, "new agent");
  });
  it("pinned first (pin order), then timestamp desc", () => {
    const entries = buildHistoryEntries(
      [
        tab({ id: "a", title: "A", createdAt: NOW - 5 * DAY }),
        tab({ id: "b", title: "B", createdAt: NOW - HOUR }),
        tab({ id: "c", title: "C", createdAt: NOW - 9 * DAY, pinned: true, pinnedAt: 200 }),
        tab({ id: "d", title: "D", createdAt: NOW - 8 * DAY, pinned: true, pinnedAt: 100 }),
      ],
      "b",
    );
    assert.deepStrictEqual(entries.map((e) => e.id), ["d", "c", "b", "a"]);
    assert.strictEqual(entries[2]!.isSelected, true);
    assert.strictEqual(entries[0]!.isSelected, false);
  });
  it("running tabs carry the spinner flag", () => {
    const [e] = buildHistoryEntries([tab({ id: "x", running: true })], undefined);
    assert.strictEqual(e!.showSpinner, true);
  });
});

describe("filterHistoryEntries + showMoreLabel", () => {
  it("case-insensitive substring on searchText; blank query returns all", () => {
    const entries = buildHistoryEntries(
      [tab({ id: "1", title: "Fix Login Bug" }), tab({ id: "2", title: "Write docs" })],
      undefined,
    );
    assert.strictEqual(filterHistoryEntries(entries, "").length, 2);
    assert.strictEqual(filterHistoryEntries(entries, "  ").length, 2);
    assert.deepStrictEqual(
      filterHistoryEntries(entries, "LOGIN").map((e) => e.id),
      ["1"],
    );
    assert.strictEqual(filterHistoryEntries(entries, "zzz").length, 0);
  });
  it("show-more label caps at the page increment", () => {
    assert.strictEqual(showMoreLabel(3), "Show 3 more");
    assert.strictEqual(showMoreLabel(57), "Show 20 more");
  });
});

describe("buildHistoryPickItems — QPS render port", () => {
  const icons = { pinIcon: "pin", pinnedIcon: "pinned", searchIcon: "search" };
  it("empty list + no query -> single 'No matching agents' row", () => {
    const items = buildHistoryPickItems({
      entries: [], query: "", visibleCount: 20, now: NOW, ...icons,
    });
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0]!.label, "No matching agents");
    assert.strictEqual(items[0]!.historyKind, "empty");
  });
  it("no matches + query -> only the Find with Agent row", () => {
    const items = buildHistoryPickItems({
      entries: buildHistoryEntries([tab({ id: "1", title: "Alpha" })], undefined),
      query: "beta", visibleCount: 20, now: NOW, ...icons,
    });
    assert.deepStrictEqual(items.map((i) => i.historyKind), ["findWithAgent"]);
  });
  it("pinned entries get no separator; date groups separate the rest", () => {
    const entries = buildHistoryEntries(
      [
        tab({ id: "p", title: "Pinned", createdAt: NOW - 30 * DAY, pinned: true, pinnedAt: 1 }),
        tab({ id: "t", title: "Today chat", createdAt: NOW - HOUR }),
        tab({ id: "o", title: "Old chat", createdAt: NOW - 30 * DAY }),
      ],
      undefined,
    );
    const items = buildHistoryPickItems({
      entries, query: "", visibleCount: 20, now: NOW, ...icons,
    });
    assert.deepStrictEqual(
      items.map((i) => `${i.historyKind}:${i.label}`),
      ["entry:Pinned", "separator:Today", "entry:Today chat", "separator:Older", "entry:Old chat"],
    );
    const pinnedItem = items[0]!;
    assert.strictEqual(pinnedItem.buttons?.[0]?.tooltip, "Unpin");
  });
  it("pagination: 25 entries -> 20 + 'Show 5 more'; query adds Find row last", () => {
    const tabs = Array.from({ length: 25 }, (_, i) =>
      tab({ id: `t${i}`, title: `Chat ${i}`, createdAt: NOW - i * HOUR }),
    );
    const entries = buildHistoryEntries(tabs, undefined);
    const page1 = buildHistoryPickItems({
      entries, query: "", visibleCount: 20, now: NOW, ...icons,
    });
    const entryCount = page1.filter((i) => i.historyKind === "entry").length;
    assert.strictEqual(entryCount, 20);
    assert.strictEqual(page1[page1.length - 1]!.label, "Show 5 more");
    const withQuery = buildHistoryPickItems({
      entries, query: "chat", visibleCount: 20, now: NOW, ...icons,
    });
    assert.strictEqual(withQuery[withQuery.length - 1]!.historyKind, "findWithAgent");
  });
});

/** Fake QuickPick recording the wiring (structural ChatHistoryQuickPick). */
class FakeQuickPick implements ChatHistoryQuickPick {
  placeholder = "";
  matchOnDescription = true;
  matchOnDetail = true;
  items: readonly ChatHistoryPickItem[] = [];
  activeItems: readonly ChatHistoryPickItem[] = [];
  value = "";
  shown = false;
  hidden = false;
  private valueListeners: Array<(v: string) => void> = [];
  private acceptListeners: Array<() => void> = [];
  private buttonListeners: Array<(e: { item: ChatHistoryPickItem }) => void> = [];
  private hideListeners: Array<() => void> = [];
  onDidChangeValue(l: (v: string) => void): { dispose(): void } {
    this.valueListeners.push(l);
    return { dispose: () => undefined };
  }
  onDidAccept(l: () => void): { dispose(): void } {
    this.acceptListeners.push(l);
    return { dispose: () => undefined };
  }
  onDidTriggerItemButton(l: (e: { item: ChatHistoryPickItem }) => void): { dispose(): void } {
    this.buttonListeners.push(l);
    return { dispose: () => undefined };
  }
  onDidHide(l: () => void): { dispose(): void } {
    this.hideListeners.push(l);
    return { dispose: () => undefined };
  }
  show(): void { this.shown = true; }
  hide(): void {
    this.hidden = true;
    for (const l of this.hideListeners) { l(); }
  }
  dispose(): void { /* noop */ }
  type(v: string): void {
    this.value = v;
    for (const l of this.valueListeners) { l(v); }
  }
  accept(item: ChatHistoryPickItem): void {
    this.activeItems = [item];
    for (const l of this.acceptListeners) { l(); }
  }
  pressButton(item: ChatHistoryPickItem): void {
    for (const l of this.buttonListeners) { l({ item }); }
  }
}

function fakeHost(tabs: ChatHistoryTabInfo[]): {
  host: ChatHistoryHost;
  opened: string[];
  findQueries: string[];
  pinCalls: Array<{ id: string; pinned: boolean }>;
} {
  const opened: string[] = [];
  const findQueries: string[] = [];
  const pinCalls: Array<{ id: string; pinned: boolean }> = [];
  const state = new Map(tabs.map((t) => [t.id, { ...t }]));
  const host: ChatHistoryHost = {
    listTabs: () => [...state.values()],
    activeTabId: () => tabs[0]?.id,
    openTab: (id) => { opened.push(id); },
    setPinned: (id, pinned) => {
      pinCalls.push({ id, pinned });
      const t = state.get(id);
      if (t) { t.pinned = pinned; t.pinnedAt = pinned ? Date.now() : undefined; }
      return true;
    },
    findWithAgent: (q) => { findQueries.push(q); },
    icon: (name) => name,
  };
  return { host, opened, findQueries, pinCalls };
}

describe("ChatHistoryService flow", () => {
  it("no tabs -> returns false (binary info branch), no picker", async () => {
    const { host } = fakeHost([]);
    let created = 0;
    const svc = new ChatHistoryService(host, () => { created++; return new FakeQuickPick(); });
    assert.strictEqual(await svc.showComposerHistory(), false);
    assert.strictEqual(created, 0);
  });
  it("shows picker with verbatim placeholder and opens the accepted entry", async () => {
    const { host, opened } = fakeHost([
      tab({ id: "tab-1", title: "First" }),
      tab({ id: "tab-2", title: "Second", createdAt: NOW - HOUR }),
    ]);
    const qp = new FakeQuickPick();
    const svc = new ChatHistoryService(host, () => qp);
    assert.strictEqual(await svc.showComposerHistory("tab-1"), true);
    assert.strictEqual(qp.shown, true);
    assert.strictEqual(qp.placeholder, "Search Agents...");
    const entry = qp.items.find((i) => i.entryId === "tab-2");
    qp.accept(entry!);
    assert.strictEqual(qp.hidden, true);
    assert.deepStrictEqual(opened, ["tab-2"]);
  });
  it("pin button toggles pin and re-renders order (pinned first)", async () => {
    const { host, pinCalls } = fakeHost([
      tab({ id: "tab-1", title: "First" }),
      tab({ id: "tab-2", title: "Second", createdAt: NOW - HOUR }),
    ]);
    const qp = new FakeQuickPick();
    const svc = new ChatHistoryService(host, () => qp);
    await svc.showComposerHistoryEditor();
    const item = qp.items.find((i) => i.entryId === "tab-2")!;
    qp.pressButton(item);
    assert.deepStrictEqual(pinCalls, [{ id: "tab-2", pinned: true }]);
    assert.strictEqual(qp.items.find((i) => i.historyKind === "entry")!.entryId, "tab-2");
  });
  it("typing filters; Find with Agent submits the trimmed query", async () => {
    const { host, findQueries } = fakeHost([tab({ id: "tab-1", title: "Alpha" })]);
    const qp = new FakeQuickPick();
    const svc = new ChatHistoryService(host, () => qp);
    await svc.showComposerHistory();
    qp.type("  beta  ");
    const find = qp.items.find((i) => i.historyKind === "findWithAgent")!;
    qp.accept(find);
    assert.deepStrictEqual(findQueries, ["beta"]);
  });
  it("Show more expands the visible window without hiding", async () => {
    const tabs = Array.from({ length: 25 }, (_, i) =>
      tab({ id: `t${i}`, title: `Chat ${i}`, createdAt: NOW - i * HOUR }),
    );
    const { host } = fakeHost(tabs);
    const qp = new FakeQuickPick();
    const svc = new ChatHistoryService(host, () => qp);
    await svc.showComposerHistory();
    const more = qp.items.find((i) => i.historyKind === "showMore")!;
    assert.strictEqual(more.label, "Show 5 more");
    qp.accept(more);
    assert.strictEqual(qp.hidden, false);
    assert.strictEqual(qp.items.filter((i) => i.historyKind === "entry").length, 25);
  });
});
