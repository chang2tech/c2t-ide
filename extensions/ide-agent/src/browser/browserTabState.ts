/**
 * Browser tab state persistence — port of Cursor's BrowserAutomationService
 * storage layer.
 *
 * Binary evidence (Cursor 3.25.9,
 * squashfs-root/usr/share/cursor/resources/app/out/vs/workbench/workbench.desktop.main.js):
 * - getStorageKey(e,t) -> `browserAutomation.${e}.${t}` (or `browserAutomation.${t}`)
 * - getLastUrl(e)    -> storageService.get(getStorageKey(e,"lastUrl"),1)
 * - saveLastUrl(e,t) -> storageService.store(getStorageKey(t,"lastUrl"),e,1,1)
 * - getSavedZoomLevel / saveZoomLevel -> same shape with the "zoomLevel" field
 *   (storage scope 1 = PROFILE, target 1 = MACHINE)
 * - this.tabState = Qo("BrowserAutomationService.tabState", void 0)
 * BrowserEditor restore (same bundle): getTabState()?.url || getLastUrl(browserId) || "";
 * a tab state of "" / "about:blank" clears the saved URL.
 *
 * HONEST-DIVERGENCE (storage mapping): Cursor writes through the workbench
 * storageService with scope PROFILE + target MACHINE. An extension cannot
 * reach that service; the equivalent available to us is
 * ExtensionContext.globalState — machine-local, not Settings-Sync'd unless
 * setKeysForSync is called (we never call it), which matches PROFILE-scope +
 * MACHINE-target semantics on a single-machine desktop install.
 *
 * HONEST-DIVERGENCE (tab id): Cursor keys state per browser tab id (one
 * BrowserEditor per tab). Our BrowserTabManager is a singleton (one tab),
 * so state is keyed by the stable BROWSER_TAB_ID below.
 *
 * Kept vscode-type-only (import type) so it unit-tests under plain node
 * with the vscode stub (see src/browser/test/run-tests.ts).
 */
import type * as vscode from "vscode";
import { clampZoom } from "./tabView";

/** Cursor's storage key prefix, verbatim: `browserAutomation.<tabId>.<field>`. */
export const BROWSER_TAB_STATE_KEY_PREFIX = "browserAutomation";

/** Stable id for the singleton browser tab (see HONEST-DIVERGENCE above). */
export const BROWSER_TAB_ID = "browser-tab";

export type BrowserTabStateField = "lastUrl" | "zoomLevel";

/** Cursor-exact key format: `browserAutomation.${tabId}.${field}`. */
export function browserTabStorageKey(tabId: string, field: BrowserTabStateField): string {
  return `${BROWSER_TAB_STATE_KEY_PREFIX}.${tabId}.${field}`;
}

/**
 * Cursor only persists real page URLs: "" and "about:blank" are not saved —
 * the BrowserEditor clears lastUrl when the tab state reports either.
 */
export function isPersistableUrl(url: string | undefined | null): boolean {
  if (typeof url !== "string") return false;
  const u = url.trim();
  return u !== "" && u !== "about:blank";
}

/**
 * Per-tab last-URL + zoom persistence, mirroring Cursor's
 * BrowserAutomationService getLastUrl/saveLastUrl/getSavedZoomLevel/
 * saveZoomLevel surface.
 *
 * Fail-closed: when no memento is available (e.g. unit tests with a partial
 * context), reads return undefined and writes are dropped — persistence is
 * best-effort, never fatal.
 */
export class BrowserTabStateStore {
  constructor(private readonly memento: vscode.Memento | undefined) {}

  /** Cursor: getLastUrl(browserId). Restores "" when nothing usable was saved. */
  getLastUrl(tabId: string = BROWSER_TAB_ID): string | undefined {
    const v = this.memento?.get<string>(browserTabStorageKey(tabId, "lastUrl"));
    return isPersistableUrl(v) ? (v as string).trim() : undefined;
  }

  /**
   * Cursor: saveLastUrl — stores the URL, or clears the saved value when the
   * tab reports "" / "about:blank". No-op when the value is unchanged.
   */
  saveLastUrl(url: string | undefined | null, tabId: string = BROWSER_TAB_ID): void {
    if (!this.memento) return;
    const key = browserTabStorageKey(tabId, "lastUrl");
    if (!isPersistableUrl(url)) {
      if (this.memento.get<string>(key) !== undefined) {
        void this.memento.update(key, undefined);
      }
      return;
    }
    const trimmed = (url as string).trim();
    if (this.memento.get<string>(key) === trimmed) return;
    void this.memento.update(key, trimmed);
  }

  /** Cursor: getSavedZoomLevel(browserId) — undefined when never saved. */
  getSavedZoomLevel(tabId: string = BROWSER_TAB_ID): number | undefined {
    const v = this.memento?.get<number>(browserTabStorageKey(tabId, "zoomLevel"));
    return typeof v === "number" && Number.isFinite(v) ? clampZoom(v) : undefined;
  }

  /** Cursor: saveZoomLevel — clamped to the 25–500 zoom range. */
  saveZoomLevel(zoomPercent: number, tabId: string = BROWSER_TAB_ID): void {
    if (!this.memento) return;
    void this.memento.update(browserTabStorageKey(tabId, "zoomLevel"), clampZoom(zoomPercent));
  }
}
