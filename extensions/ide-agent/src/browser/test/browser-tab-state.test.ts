/**
 * Browser tab state persistence tests (node:test, zero extra deps).
 *
 * Covers the Cursor BrowserAutomationService storage-layer port
 * (see ../browserTabState.ts):
 * - Cursor-exact storage key format `browserAutomation.<tabId>.<field>`
 * - lastUrl save/restore round-trip; about:blank and "" clear (not saved)
 * - zoomLevel save/restore round-trip; clamped to the 25–500 range
 * - per-tab isolation via tabId
 *
 * Imported by run-tests.ts. Run after `tsc`: node out/browser/test/run-tests.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import type * as vscode from "vscode";
import {
  BROWSER_TAB_ID,
  BROWSER_TAB_STATE_KEY_PREFIX,
  BrowserTabStateStore,
  browserTabStorageKey,
  isPersistableUrl,
} from "../browserTabState";

/** Minimal in-memory vscode.Memento fake. */
function fakeMemento() {
  const map = new Map<string, unknown>();
  return {
    map,
    memento: {
      get: <T>(key: string, defaultValue?: T): T | undefined =>
        (map.has(key) ? (map.get(key) as T) : defaultValue),
      update: (key: string, value: unknown): Thenable<void> => {
        if (value === undefined) map.delete(key);
        else map.set(key, value);
        return Promise.resolve();
      },
      keys: (): readonly string[] => [...map.keys()],
    } as unknown as vscode.Memento,
  };
}

describe("browser tab state storage keys", () => {
  it("uses Cursor's exact key format browserAutomation.<tabId>.<field>", () => {
    assert.strictEqual(browserTabStorageKey("tab-1", "lastUrl"), "browserAutomation.tab-1.lastUrl");
    assert.strictEqual(browserTabStorageKey("tab-1", "zoomLevel"), "browserAutomation.tab-1.zoomLevel");
    assert.strictEqual(BROWSER_TAB_STATE_KEY_PREFIX, "browserAutomation");
  });
  it("singleton tab uses the stable browser-tab id", () => {
    assert.strictEqual(BROWSER_TAB_ID, "browser-tab");
  });
});

describe("isPersistableUrl (Cursor: about:blank/'' clear the saved URL)", () => {
  it("accepts real http(s) URLs", () => {
    assert.ok(isPersistableUrl("https://example.com/"));
    assert.ok(isPersistableUrl("http://localhost:3000/x"));
  });
  it("rejects blank sentinels", () => {
    assert.ok(!isPersistableUrl(""));
    assert.ok(!isPersistableUrl("   "));
    assert.ok(!isPersistableUrl("about:blank"));
    assert.ok(!isPersistableUrl(undefined));
    assert.ok(!isPersistableUrl(null));
  });
});

describe("BrowserTabStateStore lastUrl", () => {
  it("round-trips a saved URL", () => {
    const { memento } = fakeMemento();
    const store = new BrowserTabStateStore(memento);
    assert.strictEqual(store.getLastUrl(), undefined);
    store.saveLastUrl("https://example.com/docs");
    assert.strictEqual(store.getLastUrl(), "https://example.com/docs");
  });
  it("about:blank clears the saved URL (Cursor behavior)", () => {
    const { memento, map } = fakeMemento();
    const store = new BrowserTabStateStore(memento);
    store.saveLastUrl("https://example.com/");
    assert.strictEqual(store.getLastUrl(), "https://example.com/");
    store.saveLastUrl("about:blank");
    assert.strictEqual(store.getLastUrl(), undefined);
    assert.ok(!map.has("browserAutomation.browser-tab.lastUrl"));
  });
  it("empty string clears the saved URL", () => {
    const { memento } = fakeMemento();
    const store = new BrowserTabStateStore(memento);
    store.saveLastUrl("https://example.com/");
    store.saveLastUrl("");
    assert.strictEqual(store.getLastUrl(), undefined);
  });
  it("state is isolated per tab id", () => {
    const { memento } = fakeMemento();
    const store = new BrowserTabStateStore(memento);
    store.saveLastUrl("https://a.example/", "tab-a");
    store.saveLastUrl("https://b.example/", "tab-b");
    assert.strictEqual(store.getLastUrl("tab-a"), "https://a.example/");
    assert.strictEqual(store.getLastUrl("tab-b"), "https://b.example/");
    assert.strictEqual(store.getLastUrl(), undefined);
  });
});

describe("BrowserTabStateStore without a memento (fail-closed)", () => {
  it("reads undefined and drops writes instead of throwing", () => {
    const store = new BrowserTabStateStore(undefined);
    assert.strictEqual(store.getLastUrl(), undefined);
    assert.strictEqual(store.getSavedZoomLevel(), undefined);
    assert.doesNotThrow(() => {
      store.saveLastUrl("https://example.com/");
      store.saveZoomLevel(150);
    });
  });
});

describe("BrowserTabStateStore zoomLevel", () => {
  it("round-trips a saved zoom level", () => {
    const { memento } = fakeMemento();
    const store = new BrowserTabStateStore(memento);
    assert.strictEqual(store.getSavedZoomLevel(), undefined);
    store.saveZoomLevel(150);
    assert.strictEqual(store.getSavedZoomLevel(), 150);
  });
  it("clamps zoom to the 25–500 range on save and restore", () => {
    const { memento } = fakeMemento();
    const store = new BrowserTabStateStore(memento);
    store.saveZoomLevel(9999);
    assert.strictEqual(store.getSavedZoomLevel(), 500);
    store.saveZoomLevel(1);
    assert.strictEqual(store.getSavedZoomLevel(), 25);
    // Corrupt raw values are clamped on read too.
    memento.update("browserAutomation.browser-tab.zoomLevel", -50);
    assert.strictEqual(store.getSavedZoomLevel(), 25);
  });
  it("non-numeric stored values restore as undefined", () => {
    const { memento } = fakeMemento();
    const store = new BrowserTabStateStore(memento);
    memento.update("browserAutomation.browser-tab.zoomLevel", "150");
    assert.strictEqual(store.getSavedZoomLevel(), undefined);
  });
});
