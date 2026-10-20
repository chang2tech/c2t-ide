/**
 * DEV-GAPS-80 (W80C-R3) tests — SubComposer-tab switching surface.
 *
 * Binary evidence (Cursor 3.25.9, workbench.glass.main.js):
 *  - `composer.selectNextSubComposerTab` @15886358 /
 *    `composer.selectPreviousSubComposerTab` @15886314 (constants iQp/rQp);
 *    action classes @~39818374: f1:false, Alt+CtrlCmd+→/← weight 200,
 *    when composerFocused; run fires
 *    fireDidRequestSwitchSubComposerTab({composerId, direction}).
 *  - The binary's child-tab ring is the selected composer's Best-of-N
 *    subComposerIds[]; the fork has no such child tabs, so
 *    ChatTabService.selectNext/PreviousSubComposerTab cycles the real
 *    tab ring (documented divergence in chatTabService.ts). The binary's
 *    wrap-vs-clamp edge behaviour is UNKNOWN (no consumer of the event
 *    exists in the extracted workbench bundles) — these tests pin the
 *    FORK's established semantics (nextTab/previousTab wrap), not a
 *    fabricated Cursor behaviour.
 *
 * Run after `tsc`:  node --test out/services/test/run-subcomposer-tab-tests.js
 */
import { after, describe, it } from "node:test";
import * as assert from "node:assert";
import "./vscode-stub";
import { ChatTabService } from "../chatTabService";

const tracked = new Set<{ dispose(): void }>();
function track<T extends { dispose(): void }>(d: T): T {
  tracked.add(d);
  return d;
}
after(() => {
  for (const d of tracked) {
    try {
      d.dispose();
    } catch {
      /* teardown must never fail the run */
    }
  }
  tracked.clear();
});

const fakeContext = {
  subscriptions: [],
  globalState: { get: () => undefined, update: async () => undefined },
  workspaceState: { get: () => undefined, update: async () => undefined },
} as unknown as import("vscode").ExtensionContext;

describe("ChatTabService — SubComposer tab switch (DEV-GAPS-80)", () => {
  it("next moves selection forward through the tab ring and wraps", () => {
    const tabs = track(new ChatTabService(fakeContext));
    const t1 = tabs.activeTab;
    const t2 = tabs.createTab({ title: "two" });
    const t3 = tabs.createTab({ title: "three" });
    // createTab does not activate; ring starts at t1.
    assert.equal(tabs.activeTab.id, t1.id);
    assert.equal(tabs.selectNextSubComposerTab().id, t2.id);
    assert.equal(tabs.activeTab.id, t2.id);
    assert.equal(tabs.selectNextSubComposerTab().id, t3.id);
    // Wrap: last -> first (fork nextTab semantics; binary edge UNKNOWN).
    assert.equal(tabs.selectNextSubComposerTab().id, t1.id);
    assert.equal(tabs.activeTab.id, t1.id);
  });

  it("previous moves selection backward and wraps from first to last", () => {
    const tabs = track(new ChatTabService(fakeContext));
    const t1 = tabs.activeTab;
    const t2 = tabs.createTab({ title: "two" });
    const t3 = tabs.createTab({ title: "three" });
    assert.equal(tabs.activeTab.id, t1.id);
    // Wrap: first -> last.
    assert.equal(tabs.selectPreviousSubComposerTab().id, t3.id);
    assert.equal(tabs.selectPreviousSubComposerTab().id, t2.id);
    assert.equal(tabs.selectPreviousSubComposerTab().id, t1.id);
    assert.equal(tabs.activeTab.id, t1.id);
  });

  it("next/previous are inverses over the ring", () => {
    const tabs = track(new ChatTabService(fakeContext));
    tabs.createTab({ title: "two" });
    tabs.createTab({ title: "three" });
    const start = tabs.activeTab.id;
    tabs.selectNextSubComposerTab();
    tabs.selectPreviousSubComposerTab();
    assert.equal(tabs.activeTab.id, start);
    tabs.selectPreviousSubComposerTab();
    tabs.selectNextSubComposerTab();
    assert.equal(tabs.activeTab.id, start);
  });

  it("single tab: both directions are a stable no-op selection", () => {
    const tabs = track(new ChatTabService(fakeContext));
    const only = tabs.activeTab;
    assert.equal(tabs.selectNextSubComposerTab().id, only.id);
    assert.equal(tabs.selectPreviousSubComposerTab().id, only.id);
    assert.equal(tabs.activeTab.id, only.id);
    assert.equal(tabs.tabCount, 1);
  });

  it("fires tabsChanged so hosts re-render the newly selected tab", () => {
    const tabs = track(new ChatTabService(fakeContext));
    tabs.createTab({ title: "two" });
    let tabsChanged = 0;
    const sub = tabs.onDidChange((e) => {
      if (e.kind === "tabsChanged") tabsChanged += 1;
    });
    tabs.selectNextSubComposerTab();
    tabs.selectPreviousSubComposerTab();
    sub.dispose();
    assert.ok(tabsChanged >= 2, `expected >=2 tabsChanged, got ${tabsChanged}`);
    // getTabStates marks exactly one tab active, and it is the selection.
    const states = tabs.getTabStates();
    assert.equal(states.filter((s) => s.active).length, 1);
    assert.equal(states.find((s) => s.active)!.id, tabs.activeTab.id);
  });
});
