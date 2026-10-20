/**
 * chat-tab-close-actions tests (node:test, vscode stubbed via ./vscode-stub).
 *
 * DEV-GAPS-73 (`chat-tab-close-actions`, Cursor 3.25.6 parity): verifies
 * the service-layer semantics behind the core commands
 * `composer.clearComposerTabs` ("Close All Tabs", ViewTitle group
 * '0_chatManage') and `composer.closeOtherComposerTabs` ("Close Other
 * Tabs", f1:false, ViewTitle menu) — i.e. the extension commands
 * `ide.closeAllChatTabs` / `ide.closeOtherChatTabs`, which delegate to
 * `ChatTabService.closeAllChatTabs()` / `closeOtherTabs(keepId)`:
 *  - close-all closes every tab; the LAST surviving tab is cleared
 *    (newChat), never removed — Cursor always keeps one chat open;
 *  - close-other keeps exactly the given tab (its transcript intact);
 *  - a tab whose turn is running is reported `skipped` when the
 *    "Close Running Tab?" confirm dialog is dismissed/cancelled
 *    (DEV-GAPS-81: the dialog replaced the old refuse-with-warning;
 *    the vscode stub's default answer is "no choice" = cancel).
 *
 * Plus the DEV-GAPS-81 dialog suite below: verbatim title/message/
 * button, confirm closes (incl. the last-tab abort+clear path),
 * cancel keeps.
 *
 * Run after `tsc`:  node --test out/services/test/run-chat-tab-close-actions-tests.js
 */
import { after, describe, it } from "node:test";
import * as assert from "node:assert";
import { windowStub } from "./vscode-stub";
import {
  ChatTabService,
  CLOSE_RUNNING_TAB_CONFIRM_LABEL,
  CLOSE_RUNNING_TAB_MESSAGE,
  CLOSE_RUNNING_TAB_TITLE,
} from "../chatTabService";

const trackedDisposables = new Set<{ dispose(): void }>();
function track<T extends { dispose(): void }>(d: T): T {
  trackedDisposables.add(d);
  return d;
}
after(() => {
  for (const d of trackedDisposables) {
    try {
      d.dispose();
    } catch {
      /* teardown must never fail the run */
    }
  }
  trackedDisposables.clear();
});

const fakeContext = {
  subscriptions: [],
  globalState: { get: () => undefined, update: async () => undefined },
  workspaceState: { get: () => undefined, update: async () => undefined },
} as unknown as import("vscode").ExtensionContext;

function seedBubble(tabIdComposer: { composer: import("../composerDataService").ComposerDataService }, id: string, text: string): void {
  tabIdComposer.composer.bubbles.setBubbleData({
    bubbleId: id,
    role: "human",
    mode: "agent",
    text,
    toolCalls: [],
    createdAt: Date.now(),
  });
}

describe("ChatTabService bulk close — DEV-GAPS-73 (chat-tab-close-actions)", () => {
  it("closeAllChatTabs: closes all other tabs and clears the last one (one chat always stays open)", async () => {
    const tabs = track(new ChatTabService(fakeContext));
    const first = tabs.activeTab;
    const t2 = tabs.createTab({});
    const t3 = tabs.createTab({});
    seedBubble(t2, "b-t2", "second chat content");
    seedBubble(t3, "b-t3", "third chat content");

    const result = await tabs.closeAllChatTabs();

    assert.equal(result.skipped, 0);
    assert.equal(result.closed, 3);
    assert.equal(tabs.tabCount, 1);
    // The surviving tab is the last one processed and it was CLEARED, not kept.
    const survivor = tabs.listTabs()[0]!;
    assert.equal(survivor.composer.bubbles.getAllInOrder().length, 0);
    assert.notEqual(survivor.id, first.id);
    assert.notEqual(survivor.id, t2.id);
  });

  it("closeAllChatTabs: with a single tab, clears it in place", async () => {
    const tabs = track(new ChatTabService(fakeContext));
    const only = tabs.activeTab;
    seedBubble(only, "b-only", "solo content");

    const result = await tabs.closeAllChatTabs();

    assert.deepEqual(result, { closed: 1, skipped: 0 });
    assert.equal(tabs.tabCount, 1);
    assert.equal(tabs.activeTab.id, only.id);
    assert.equal(only.composer.bubbles.getAllInOrder().length, 0);
  });

  it("closeAllChatTabs: a running tab refuses and is skipped; the rest close", async () => {
    const tabs = track(new ChatTabService(fakeContext));
    const runningTab = tabs.activeTab;
    const t2 = tabs.createTab({});
    tabs.createTab({}); // t3 — closes down to the running tab
    Object.defineProperty(runningTab.composer, "isRunning", {
      get: () => true,
      configurable: true,
    });

    const result = await tabs.closeAllChatTabs();

    assert.equal(result.skipped, 1);
    assert.equal(result.closed, 2);
    assert.equal(tabs.tabCount, 1);
    assert.equal(tabs.listTabs()[0]!.id, runningTab.id);
    void t2;
  });

  it("closeOtherTabs: keeps exactly the given tab with its transcript intact", async () => {
    const tabs = track(new ChatTabService(fakeContext));
    const keep = tabs.activeTab;
    seedBubble(keep, "b-keep", "keep this message");
    tabs.createTab({});
    tabs.createTab({});

    const result = await tabs.closeOtherTabs(keep.id);

    assert.deepEqual(result, { closed: 2, skipped: 0 });
    assert.equal(tabs.tabCount, 1);
    assert.equal(tabs.activeTab.id, keep.id);
    const kept = keep.composer.bubbles.getAllInOrder();
    assert.equal(kept.length, 1);
    assert.equal(kept[0]!.text, "keep this message");
  });

  it("closeOtherTabs: skips running tabs and still closes the others", async () => {
    const tabs = track(new ChatTabService(fakeContext));
    const keep = tabs.activeTab;
    const running = tabs.createTab({});
    tabs.createTab({});
    Object.defineProperty(running.composer, "isRunning", {
      get: () => true,
      configurable: true,
    });

    const result = await tabs.closeOtherTabs(keep.id);

    assert.deepEqual(result, { closed: 1, skipped: 1 });
    assert.equal(tabs.tabCount, 2);
    assert.ok(tabs.listTabs().some((t) => t.id === running.id));
    assert.ok(tabs.listTabs().some((t) => t.id === keep.id));
  });

  it("closeOtherTabs: nothing to close when it is the only tab", async () => {
    const tabs = track(new ChatTabService(fakeContext));
    const only = tabs.activeTab;

    const result = await tabs.closeOtherTabs(only.id);

    assert.deepEqual(result, { closed: 0, skipped: 0 });
    assert.equal(tabs.tabCount, 1);
  });
});

describe("Close Running Tab? confirm dialog — DEV-GAPS-81 (F1 phụ, binary @39861810)", () => {
  function makeRunning(composer: import("../composerDataService").ComposerDataService): void {
    Object.defineProperty(composer, "isRunning", {
      get: () => true,
      configurable: true,
    });
  }

  it("dialog strings are the binary's verbatim title/message/button", () => {
    assert.equal(CLOSE_RUNNING_TAB_TITLE, "Close Running Tab?");
    assert.equal(
      CLOSE_RUNNING_TAB_MESSAGE,
      "The chat is currently running. Are you sure you want to close it?",
    );
    assert.equal(CLOSE_RUNNING_TAB_CONFIRM_LABEL, "Close Tab");
  });

  it("closeTab: running tab + confirm 'Close Tab' closes it, with the verbatim dialog shown", async () => {
    const tabs = track(new ChatTabService(fakeContext));
    const running = tabs.createTab({});
    makeRunning(running.composer);
    windowStub.nextWarningChoice = "Close Tab";

    const closed = await tabs.closeTab(running.id);

    assert.equal(closed, true);
    assert.equal(tabs.tabCount, 1);
    assert.equal(windowStub.consumeWarning(), "Close Running Tab?");
    const items = windowStub.consumeWarningItems();
    // Stub records (options, ...items): modal detail carries the binary
    // message; the single affirmative item is the verbatim button label.
    assert.equal((items[0] as { detail?: string }).detail, CLOSE_RUNNING_TAB_MESSAGE);
    assert.equal((items[0] as { modal?: boolean }).modal, true);
    assert.equal(items[1], "Close Tab");
  });

  it("closeTab: running tab + dialog dismissed (cancel) keeps it", async () => {
    const tabs = track(new ChatTabService(fakeContext));
    const running = tabs.createTab({});
    makeRunning(running.composer);
    windowStub.nextWarningChoice = undefined; // modal dismissed = binary cancelButton

    const closed = await tabs.closeTab(running.id);

    assert.equal(closed, false);
    assert.equal(tabs.tabCount, 2);
    assert.equal(windowStub.consumeWarning(), "Close Running Tab?");
    windowStub.consumeWarningItems();
  });

  it("closeAllChatTabs: running tab confirmed via dialog closes like the rest", async () => {
    const tabs = track(new ChatTabService(fakeContext));
    const running = tabs.activeTab;
    tabs.createTab({});
    tabs.createTab({});
    makeRunning(running.composer);
    windowStub.nextWarningChoice = "Close Tab";

    const result = await tabs.closeAllChatTabs();

    assert.deepEqual(result, { closed: 3, skipped: 0 });
    assert.equal(tabs.tabCount, 1);
    windowStub.consumeWarning();
    windowStub.consumeWarningItems();
  });

  it("closeOtherTabs: running tab cancelled in dialog is skipped, others close", async () => {
    const tabs = track(new ChatTabService(fakeContext));
    const keep = tabs.activeTab;
    const running = tabs.createTab({});
    tabs.createTab({});
    makeRunning(running.composer);
    windowStub.nextWarningChoice = undefined;

    const result = await tabs.closeOtherTabs(keep.id);

    assert.deepEqual(result, { closed: 1, skipped: 1 });
    assert.ok(tabs.listTabs().some((t) => t.id === running.id));
    windowStub.consumeWarning();
    windowStub.consumeWarningItems();
  });

  it("closeTab: LAST running tab + confirm aborts the turn and clears in place", async () => {
    const tabs = track(new ChatTabService(fakeContext));
    const only = tabs.activeTab;
    seedBubble(only, "b-last", "running last chat");
    let running = true;
    Object.defineProperty(only.composer, "isRunning", {
      get: () => running,
      configurable: true,
    });
    only.composer.abort = () => {
      running = false;
    };
    windowStub.nextWarningChoice = "Close Tab";

    const closed = await tabs.closeTab(only.id);

    assert.equal(closed, true);
    assert.equal(tabs.tabCount, 1);
    assert.equal(tabs.activeTab.id, only.id);
    assert.equal(only.composer.bubbles.getAllInOrder().length, 0);
    windowStub.consumeWarning();
    windowStub.consumeWarningItems();
  });
});
