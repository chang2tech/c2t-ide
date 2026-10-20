/**
 * Native browser tab "..." menu contract tests (DEV-GAPS-5-BROWSERMENU).
 *
 * The native Integrated Browser tab (upstream WebContentsView) cannot be
 * driven from the extension host — the `ide.browser.*` command
 * implementations live in core
 * (browserEditorNativeMenuFeatures.ts) and the menu placement lives in
 * package.json. This file tests the pure, extension-side contract in
 * `../nativeMenu.ts`:
 *
 *  - the 11-item menu table mirrors the webview tab's "..." menu
 *    (tabView.ts: Take Screenshot, Capture Area Screenshot, Hard Reload,
 *    Copy Current URL, Clear Browsing History, Clear Cookies, Clear Cache)
 *    plus the conditional "Show Bookmark Bar" switch item (DEV-GAPS-74,
 *    reconciled into this contract by DEV-GAPS-94B) and the zoom row
 *    commands (DEV-GAPS-93C, synced by DEV-GAPS-94B);
 *  - the URL copyability rule refuses blank pages (same rule as core's
 *    isCopyableBrowserUrl — the two copies must stay in sync);
 *  - the clear-data confirm copy matches the webview CONFIRM table
 *    (browserTab.ts) where the scope is identical;
 *  - package.json `contributes.menus["editor/title/context"]` does not drift
 *    from `buildEditorTitleContextMenuEntries()`.
 *
 * Run after `tsc`: node --test out/browser/test/run-native-menu-tests.js
 * (also wired into run-tests.ts).
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  NATIVE_BROWSER_EDITOR_ID,
  NATIVE_BROWSER_MENU_ITEMS,
  NATIVE_BROWSER_MENU_WHEN,
  NATIVE_CLEAR_DATA_CONFIRM,
  buildEditorTitleContextMenuEntries,
  isCopyableBrowserUrl,
} from "../nativeMenu";

/* ---------- menu table ---------- */

describe("native browser menu — item table", () => {
  it("declares exactly the 11 ported items in webview-menu order", () => {
    const commands = NATIVE_BROWSER_MENU_ITEMS.map((i) => i.command);
    assert.deepStrictEqual(commands, [
      "ide.browser.takeScreenshot",
      "ide.browser.captureArea",
      "ide.browser.hardReload",
      "ide.browser.copyUrl",
      "ide.browser.zoomOut",
      "ide.browser.zoomIn",
      "ide.browser.resetZoom",
      "ide.browser.toggleBookmarkBar",
      "ide.browser.clearHistory",
      "ide.browser.clearCookies",
      "ide.browser.clearCache",
    ]);
  });

  it("uses the webview tab's labels verbatim", () => {
    const titles = NATIVE_BROWSER_MENU_ITEMS.map((i) => i.title);
    assert.deepStrictEqual(titles, [
      "Take Screenshot",
      "Capture Area Screenshot",
      "Hard Reload",
      "Copy Current URL",
      "Zoom Out",
      "Zoom In",
      "Reset Zoom",
      "Show Bookmark Bar",
      "Clear Browsing History",
      "Clear Cookies",
      "Clear Cache",
    ]);
  });

  it("has no duplicate command ids", () => {
    const ids = NATIVE_BROWSER_MENU_ITEMS.map((i) => i.command);
    assert.strictEqual(new Set(ids).size, ids.length);
  });

  it("groups into 4 separated sections (screenshots / actions / zoom / data)", () => {
    const groups = [...new Set(NATIVE_BROWSER_MENU_ITEMS.map((i) => i.group))];
    assert.deepStrictEqual(groups, ["8_ide_shot", "8_ide_actions", "8_ide_actions_zoom", "8_ide_data"]);
  });

  it("orders items sequentially within each group", () => {
    const byGroup = new Map<string, number[]>();
    for (const item of NATIVE_BROWSER_MENU_ITEMS) {
      const orders = byGroup.get(item.group) ?? [];
      orders.push(item.order);
      byGroup.set(item.group, orders);
    }
    for (const [group, orders] of byGroup) {
      assert.deepStrictEqual(orders, [...orders].sort((a, b) => a - b), `group ${group}`);
      assert.deepStrictEqual(orders, orders.map((_, i) => i + 1), `group ${group} contiguous`);
    }
  });

  it("gates on the upstream native browser editor id", () => {
    assert.strictEqual(NATIVE_BROWSER_EDITOR_ID, "workbench.editor.browser");
    assert.strictEqual(NATIVE_BROWSER_MENU_WHEN, "activeEditor == workbench.editor.browser");
  });
});

/* ---------- URL copyability ---------- */

describe("native browser menu — isCopyableBrowserUrl", () => {
  it("accepts a real page URL", () => {
    assert.strictEqual(isCopyableBrowserUrl("https://example.com/"), true);
  });
  it("refuses about:blank (same rule as the webview tab, QA-BROWSERMENU P3-3)", () => {
    assert.strictEqual(isCopyableBrowserUrl("about:blank"), false);
  });
  it("refuses empty / whitespace / undefined", () => {
    assert.strictEqual(isCopyableBrowserUrl(""), false);
    assert.strictEqual(isCopyableBrowserUrl("   "), false);
    assert.strictEqual(isCopyableBrowserUrl(undefined), false);
  });
  it("trims before deciding", () => {
    assert.strictEqual(isCopyableBrowserUrl("  https://example.com/  "), true);
    assert.strictEqual(isCopyableBrowserUrl("  about:blank "), false);
  });
});

/* ---------- clear-data confirm copy ---------- */

describe("native browser menu — clear-data confirm copy", () => {
  it("covers history, cookies and cache with non-empty copy", () => {
    for (const kind of ["history", "cookies", "cache"] as const) {
      const c = NATIVE_CLEAR_DATA_CONFIRM[kind];
      assert.ok(c.title.length > 0, `${kind} title`);
      assert.ok(c.detail.length > 0, `${kind} detail`);
      assert.ok(c.toast.length > 0, `${kind} toast`);
    }
  });

  it("keeps cookies/cache copy verbatim from the webview CONFIRM table (browserTab.ts)", () => {
    assert.strictEqual(
      NATIVE_CLEAR_DATA_CONFIRM.cookies.detail,
      "This will remove all cookies. You may be signed out of websites.",
    );
    assert.strictEqual(NATIVE_CLEAR_DATA_CONFIRM.cookies.toast, "Cookies cleared");
    assert.strictEqual(NATIVE_CLEAR_DATA_CONFIRM.cache.detail, "This will clear the browser cache.");
    assert.strictEqual(NATIVE_CLEAR_DATA_CONFIRM.cache.toast, "Cache cleared");
  });

  it("rewords history scope honestly (native clears the session history store)", () => {
    // The webview tab can only reset the tab's back/forward entries; the
    // native tab clears the real upstream history store. The detail must not
    // promise the webview's narrower scope.
    assert.ok(
      NATIVE_CLEAR_DATA_CONFIRM.history.detail.includes("browser session"),
      `got: ${NATIVE_CLEAR_DATA_CONFIRM.history.detail}`,
    );
  });
});

/* ---------- package.json drift guard ---------- */

describe("native browser menu — package.json drift guard", () => {
  function readMenus(): Array<{ command: string; when?: string; group?: string }> {
    // __dirname is <root>/browser/test in BOTH layouts (src/ and compiled
    // out/), so three levels up always reaches the extension root.
    const pkgPath = path.join(__dirname, "..", "..", "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
      contributes: { menus: Record<string, Array<{ command: string; when?: string; group?: string }>> };
    };
    return pkg.contributes.menus["editor/title/context"] ?? [];
  }

  it("registers all 11 commands under editor/title/context, nothing extra", () => {
    const entries = readMenus().filter((e) => e.command.startsWith("ide.browser."));
    const expected = buildEditorTitleContextMenuEntries();
    assert.strictEqual(entries.length, expected.length, "no missing or extra ide.browser.* entries");
    const byCommand = new Map(entries.map((e) => [e.command, e]));
    for (const want of expected) {
      const got = byCommand.get(want.command);
      assert.ok(got, `missing menu entry for ${want.command}`);
      assert.deepStrictEqual(
        { command: got!.command, when: got!.when, group: got!.group },
        want,
        `drift for ${want.command}: package.json does not match nativeMenu.ts`,
      );
    }
  });

  it("gates every entry on the native browser editor", () => {
    for (const e of readMenus().filter((x) => x.command.startsWith("ide.browser."))) {
      assert.strictEqual(e.when, NATIVE_BROWSER_MENU_WHEN, e.command);
    }
  });
});
