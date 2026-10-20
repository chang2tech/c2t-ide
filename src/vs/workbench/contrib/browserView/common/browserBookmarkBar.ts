/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * IDE-CODE (DEV-GAPS-74, browser-tab-menu-bookmark-bar): dependency-free
 * helpers behind Cursor's 'Show Bookmark Bar' switch. No vscode imports, so
 * this can be unit-tested with plain node.
 *
 * Cursor evidence (detail-browser-2026-10-19.md:59; dig-browser-menu-2026-10-19.md:13, gap
 * table :46; audit-fix-queue.md ~10202, re-verified vs bundle 3.25.9):
 * - the native browser tab "..." menu (BrowserMoreMenu) has a conditional
 *   SwitchItem "Show Bookmark Bar" (shown "only when bookmark-bar pref exists");
 * - the fork's native "..." menu (nativeMenu.ts:50-57) has 7 items, none of them
 *   bookmark-related; the fork has no bookmark bar in its chrome.
 *
 * HONEST-DIVERGENCE:
 * - Cursor's switch renders as a menu SwitchItem with an inline on/off state.
 *   The fork's menu is an extension-contributed `editor/title/context` menu
 *   (see browserEditorNativeMenuFeatures.ts header), which cannot host a
 *   SwitchItem — so it is a toggle command with the menu's `toggled`
 *   checkmark condition bound to the pref.
 * - "Bookmark" data in Cursor is the browser's bookmark store. The fork has
 *   no bookmark store; the closest local store is the browser tab favorites
 *   (BrowserFavoritesFeature: workspace-scoped, URL strings only). The bar
 *   shows favorites as quick links. A true bookmark store with titles/icons
 *   and import is out of scope (no REA evidence for its shape).
 * - Cursor's canonical default for the pref is UNKNOWN from the REA docs;
 *   the fork defaults it to OFF so existing users see no chrome change.
 */

/** Configuration key for the bookmark-bar visibility pref. */
export const SHOW_BOOKMARK_BAR_SETTING_ID = 'ide.browser.showBookmarkBar';

/** Default: off (Cursor's canonical default is UNKNOWN — see module header). */
export const SHOW_BOOKMARK_BAR_DEFAULT = false;

/** Max characters of a bookmark bar item label before truncation. */
export const BOOKMARK_BAR_ITEM_LABEL_MAX = 40;

/**
 * Human-readable label for a bookmarked URL: `host[/path]`, truncated.
 * Falls back to the raw URL (truncated) when it does not parse as a URL.
 */
export function bookmarkBarItemLabel(url: string): string {
	let label: string;
	try {
		const parsed = new URL(url);
		label = parsed.host + (parsed.pathname && parsed.pathname !== '/' ? parsed.pathname : '');
		if (!label) {
			label = url;
		}
	} catch {
		label = url;
	}
	if (label.length > BOOKMARK_BAR_ITEM_LABEL_MAX) {
		return label.slice(0, BOOKMARK_BAR_ITEM_LABEL_MAX - 1) + '…';
	}
	return label;
}
