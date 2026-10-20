/**
 * Native browser tab "..." menu contract (IDE-CODE).
 *
 * The native Integrated Browser tab (upstream VS Code WebContentsView,
 * `src/vs/workbench/contrib/browserView/`) cannot be driven from the
 * extension host: there is no API to reach the active browser editor's
 * model or webContents (`nativeDriver.ts` only creates NEW tabs via the
 * proposed `vscode.window.openBrowserTab` API). The actual implementations
 * therefore live in core —
 * `src/vs/workbench/contrib/browserView/electron-browser/features/browserEditorNativeMenuFeatures.ts`
 * registers the `ide.browser.*` commands as Action2.
 *
 * This module owns the extension-side contract:
 *  - the menu item table (id / title / group / order), mirrored from the
 *    webview browser tab's "..." menu (`tabView.ts`: Take Screenshot,
 *    Capture Area Screenshot, Hard Reload, Copy Current URL, Clear Browsing
 *    History, Clear Cookies, Clear Cache) plus the conditional
 *    "Show Bookmark Bar" switch item (DEV-GAPS-74, reconciled
 *    DEV-GAPS-94B — see the item table below);
 *  - the `when` clause gating the items to the native browser editor;
 *  - the pure rules both sides implement (URL copyability, clear-data
 *    confirm copy);
 *  - a builder producing the exact `package.json` menus JSON, so
 *    `run-native-menu-tests.ts` can fail the build if package.json drifts
 *    from this contract.
 *
 * Ported from our own webview path — NOT a Cursor parity claim.
 */

/** Upstream editor id for the native Integrated Browser tab. */
export const NATIVE_BROWSER_EDITOR_ID = "workbench.editor.browser";

/** When-clause used by every native browser menu contribution. */
export const NATIVE_BROWSER_MENU_WHEN = `activeEditor == ${NATIVE_BROWSER_EDITOR_ID}`;

export interface NativeBrowserMenuItem {
  /** Command id — registered in CORE (browserEditorNativeMenuFeatures.ts). */
  command: string;
  /** Label shown in the "..." overflow menu (mirrors the webview tabView.ts labels). */
  title: string;
  /** editor/title/context group; distinct groups render with separators. */
  group: string;
  /** Order inside the group. */
  order: number;
}

/**
 * The 11 "..." menu items (8 core + 3 zoom), in Cursor menu order:
 * screenshots, actions, zoom, bookmark switch, clear-data (groups render
 * separated).
 *
 * DEV-GAPS-94B reconcile (`browser-tab-menu-bookmark-bar`): the 8th item,
 * `ide.browser.toggleBookmarkBar` ("Show Bookmark Bar"), was implemented by
 * DEV-GAPS-74 in core (`IdeBrowserToggleBookmarkBarAction`,
 * browserEditorNativeMenuFeatures.ts — flips `ide.browser.showBookmarkBar`,
 * rendered by BrowserBookmarkBarFeature) and contributed in package.json
 * (commands + `editor/title/context` entry `8_ide_actions@3` carrying a
 * `toggled` checkmark bound to `config.ide.browser.showBookmarkBar`), but
 * this contract table was never updated — the drift guard in
 * run-native-menu-tests.ts therefore (correctly) failed 8-vs-7
 * (first flagged by DEV-GAPS-88). Cursor evidence: BrowserMoreMenu
 * SwitchItem "Show Bookmark Bar", conditional on the bookmark-bar pref
 * existing (binary 3.25.9 workbench.desktop.main.js @21136241;
 * detail-browser-2026-10-19.md:59). Placement here mirrors package.json:
 * the actions group, after Copy Current URL. The package.json entry's
 * extra `toggled` field is menu-rendering state, not part of this
 * command/when/group contract (the drift guard compares exactly those
 * three fields).
 */
export const NATIVE_BROWSER_MENU_ITEMS: readonly NativeBrowserMenuItem[] = [
  { command: "ide.browser.takeScreenshot", title: "Take Screenshot", group: "8_ide_shot", order: 1 },
  { command: "ide.browser.captureArea", title: "Capture Area Screenshot", group: "8_ide_shot", order: 2 },
  { command: "ide.browser.hardReload", title: "Hard Reload", group: "8_ide_actions", order: 1 },
  { command: "ide.browser.copyUrl", title: "Copy Current URL", group: "8_ide_actions", order: 2 },
  // Zoom row (DEV-GAPS-93C, `browser-tab-menu-zoom`): 3 commands in their
  // own group, mirroring package.json. Synced into this contract by
  // DEV-GAPS-94B only so the drift guard covers the whole menu; the zoom
  // implementation itself is 93C's (browserEditorNativeMenuFeatures.ts).
  { command: "ide.browser.zoomOut", title: "Zoom Out", group: "8_ide_actions_zoom", order: 1 },
  { command: "ide.browser.zoomIn", title: "Zoom In", group: "8_ide_actions_zoom", order: 2 },
  { command: "ide.browser.resetZoom", title: "Reset Zoom", group: "8_ide_actions_zoom", order: 3 },
  { command: "ide.browser.toggleBookmarkBar", title: "Show Bookmark Bar", group: "8_ide_actions", order: 3 },
  { command: "ide.browser.clearHistory", title: "Clear Browsing History", group: "8_ide_data", order: 1 },
  { command: "ide.browser.clearCookies", title: "Clear Cookies", group: "8_ide_data", order: 2 },
  { command: "ide.browser.clearCache", title: "Clear Cache", group: "8_ide_data", order: 3 },
];

export type NativeClearDataKind = "history" | "cookies" | "cache";

/**
 * Confirm-dialog copy for the three clear-data commands. Cookies/cache copy
 * is verbatim the webview tab's CONFIRM table (browserTab.ts); history is
 * intentionally reworded — the native tab clears the real upstream history
 * store (session scope), while the webview tab can only reset the tab's
 * back/forward entries.
 */
export const NATIVE_CLEAR_DATA_CONFIRM: Record<
  NativeClearDataKind,
  { title: string; detail: string; toast: string }
> = {
  history: {
    title: "Clear Browsing History",
    detail: "This will clear the browsing history for this browser session.",
    toast: "Browsing history cleared",
  },
  cookies: {
    title: "Clear Cookies",
    detail: "This will remove all cookies. You may be signed out of websites.",
    toast: "Cookies cleared",
  },
  cache: {
    title: "Clear Cache",
    detail: "This will clear the browser cache.",
    toast: "Cache cleared",
  },
};

/**
 * URL copyability rule — must stay in sync with `isCopyableBrowserUrl` in
 * core's browserEditorNativeMenuFeatures.ts (the two cannot share code:
 * core is workbench TS, this is the extension host). Mirrors the webview
 * rule (BrowserTabManager.copyCurrentUrl refuses about:blank, QA-BROWSERMENU
 * P3-3): only copy when a real page is loaded.
 */
export function isCopyableBrowserUrl(url: string | undefined): boolean {
  if (!url) {
    return false;
  }
  const trimmed = url.trim();
  return trimmed.length > 0 && trimmed !== "about:blank";
}

export interface PackageJsonMenuEntry {
  command: string;
  when: string;
  group: string;
}

/**
 * Builds the exact objects expected under
 * `contributes.menus["editor/title/context"]` in package.json.
 */
export function buildEditorTitleContextMenuEntries(): PackageJsonMenuEntry[] {
  return NATIVE_BROWSER_MENU_ITEMS.map((item) => ({
    command: item.command,
    when: NATIVE_BROWSER_MENU_WHEN,
    group: `${item.group}@${item.order}`,
  }));
}
