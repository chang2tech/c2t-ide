/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * IDE-CODE: native browser tab "..." menu actions.
 *
 * Ports the IDE Agent webview browser tab's "..." menu items
 * (extensions/ide-agent/src/browser/tabView.ts — Take Screenshot, Capture Area
 * Screenshot, Hard Reload, Copy Current URL, Clear Browsing History, Clear
 * Cookies, Clear Cache) to the native Integrated Browser tab (WebContentsView).
 * Also adds the Zoom row commands (Zoom Out / Zoom In / Reset Zoom,
 * DEV-GAPS-93C — see the zoom section below).
 *
 * WHY THIS LIVES IN CORE (not the ide-agent extension host): the extension API
 * has no access to the active native browser editor's model or webContents.
 * extensions/ide-agent/src/browser/nativeDriver.ts only reaches the native tab
 * through the proposed `vscode.window.openBrowserTab` API, which creates NEW
 * tabs but cannot touch the currently open one. Following the existing
 * core<->extension bridge pattern in browserEditorChatFeatures.ts, the
 * commands are registered here as Action2 (callable from the extension host
 * via `vscode.commands.executeCommand('ide.browser.…')`), while the ide-agent
 * extension contributes the menu placement (`editor/title/context` with
 * `when: activeEditor == workbench.editor.browser`) in its package.json.
 *
 * NO UPSTREAM BEHAVIOR IS CHANGED: only new `ide.browser.*` commands are
 * added. No existing action, menu item, or keybinding is modified or removed.
 */

import { localize2 } from '../../../../../nls.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import type { CDPEvent, CDPResponse } from '../../../../../platform/browserView/common/cdp/types.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { BrowserEditor, BROWSER_EDITOR_ACTIVE, BrowserActionCategory } from '../browserEditor.js';
import { SHOW_BOOKMARK_BAR_SETTING_ID, SHOW_BOOKMARK_BAR_DEFAULT } from '../../common/browserBookmarkBar.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IBrowserViewCDPService, IBrowserViewModel } from '../../common/browserView.js';
import { BrowserEditorChatIntegration } from './browserEditorChatFeatures.js';
import { BrowserEditorZoomSupport } from './browserEditorZoomFeature.js';

/** Command ids for the native browser tab "..." menu (owned by IDE-CODE, not upstream). */
export const IdeBrowserMenuCommandIds = {
	takeScreenshot: 'ide.browser.takeScreenshot',
	captureArea: 'ide.browser.captureArea',
	hardReload: 'ide.browser.hardReload',
	copyUrl: 'ide.browser.copyUrl',
	zoomOut: 'ide.browser.zoomOut',
	zoomIn: 'ide.browser.zoomIn',
	resetZoom: 'ide.browser.resetZoom',
	clearHistory: 'ide.browser.clearHistory',
	clearCookies: 'ide.browser.clearCookies',
	clearCache: 'ide.browser.clearCache',
	toggleBookmarkBar: 'ide.browser.toggleBookmarkBar',
} as const;

function getActiveBrowserEditor(accessor: ServicesAccessor): BrowserEditor | undefined {
	const pane = accessor.get(IEditorService).activeEditorPane;
	return pane instanceof BrowserEditor ? pane : undefined;
}

function getActiveBrowserModel(accessor: ServicesAccessor): IBrowserViewModel | undefined {
	return getActiveBrowserEditor(accessor)?.model;
}

/**
 * URL copyability rule. Mirrors the webview browser tab rule
 * (BrowserTabManager.copyCurrentUrl refuses about:blank, QA-BROWSERMENU P3-3):
 * only copy when a real page is loaded.
 */
export function isCopyableBrowserUrl(url: string | undefined): boolean {
	if (!url) {
		return false;
	}
	const trimmed = url.trim();
	return trimmed.length > 0 && trimmed !== 'about:blank';
}

let nextCdpMessageId = 1;

/**
 * Send one CDP command to a browser view and await its response, then tear
 * the group down. Used for the clear-cookies / clear-cache menu items, which
 * use the same CDP methods as the webview browser tab
 * (Network.clearBrowserCookies / Network.clearBrowserCache in
 * extensions/ide-agent/src/browser/browserTab.ts). Cookies/cache are
 * session-scoped in Chromium, so — exactly like the webview path — this
 * clears them for the whole browser session, not just the tab.
 */
export async function sendCdpToBrowserView(
	cdpService: IBrowserViewCDPService,
	browserId: string,
	method: string,
	params: unknown = {},
	timeoutMs = 10000,
): Promise<void> {
	const groupId = await cdpService.createSessionGroup(browserId);
	try {
		const id = nextCdpMessageId++;
		let sub: Disposable | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const response = new Promise<CDPResponse | CDPEvent>((resolve, reject) => {
			timer = setTimeout(() => {
				sub?.dispose();
				reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			sub = cdpService.onCDPMessage(groupId)(msg => {
				if ('id' in msg && msg.id === id) {
					if (timer) {
						clearTimeout(timer);
					}
					sub?.dispose();
					resolve(msg);
				}
			});
		});
		try {
			await cdpService.sendCDPMessage(groupId, { id, method, params });
		} catch (sendError) {
			// Cancel the pending response listener: without this the timer
			// would reject an unobserved promise (unhandled rejection) and
			// the subscription would linger until the timeout fires.
			if (timer) {
				clearTimeout(timer);
			}
			sub?.dispose();
			throw sendError;
		}
		const result = await response;
		if ('error' in result && result.error) {
			throw new Error(result.error.message);
		}
	} finally {
		await cdpService.destroySessionGroup(groupId).catch(() => { /* best effort */ });
	}
}

async function confirmClearData(
	dialogService: IDialogService,
	title: string,
	detail: string,
): Promise<boolean> {
	const { confirmed } = await dialogService.confirm({
		type: Severity.Warning,
		message: title,
		detail,
		primaryButton: localize2('ide.browser.clearDataConfirm', "Clear").value,
	});
	return confirmed;
}

// -- Take Screenshot --------------------------------------------------------

export class IdeBrowserTakeScreenshotAction extends Action2 {
	static readonly ID = IdeBrowserMenuCommandIds.takeScreenshot;

	constructor() {
		super({
			id: IdeBrowserTakeScreenshotAction.ID,
			title: localize2('ide.browser.takeScreenshotAction', "Take Screenshot"),
			category: BrowserActionCategory,
			icon: Codicon.deviceCamera,
			f1: true,
			precondition: BROWSER_EDITOR_ACTIVE,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		// Ports the webview "..." menu's "Take Screenshot" (screenshotToChat):
		// the native equivalent routes through the existing chat integration,
		// which honors the `ide.browser.chatTarget` setting.
		await getActiveBrowserEditor(accessor)
			?.getContribution(BrowserEditorChatIntegration)
			?.addScreenshotToChat();
	}
}

// -- Capture Area Screenshot -------------------------------------------------

export class IdeBrowserCaptureAreaAction extends Action2 {
	static readonly ID = IdeBrowserMenuCommandIds.captureArea;

	constructor() {
		super({
			id: IdeBrowserCaptureAreaAction.ID,
			title: localize2('ide.browser.captureAreaAction', "Capture Area Screenshot"),
			category: BrowserActionCategory,
			icon: Codicon.screenFull,
			f1: true,
			precondition: BROWSER_EDITOR_ACTIVE,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		// Ports the webview "..." menu's "Capture Area Screenshot"
		// (captureAreaToChat / startAreaSelect): the native equivalent starts
		// the in-editor area picker and attaches the result to chat.
		await getActiveBrowserEditor(accessor)
			?.getContribution(BrowserEditorChatIntegration)
			?.addAreaScreenshotToChat();
	}
}

// -- Hard Reload --------------------------------------------------------------

export class IdeBrowserHardReloadAction extends Action2 {
	static readonly ID = IdeBrowserMenuCommandIds.hardReload;

	constructor() {
		super({
			id: IdeBrowserHardReloadAction.ID,
			title: localize2('ide.browser.hardReloadAction', "Hard Reload"),
			category: BrowserActionCategory,
			icon: Codicon.refresh,
			f1: true,
			precondition: BROWSER_EDITOR_ACTIVE,
			// Note: no keybinding here — upstream already binds Ctrl/Cmd+Shift+R
			// to workbench.action.browser.hardReload. Same behavior, no dup.
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		// Same behavior as upstream HardReloadAction (model.reload(true));
		// separate `ide.browser.*` id so the extension's "..." menu has a
		// product-owned command to target.
		await getActiveBrowserModel(accessor)?.reload(true);
	}
}

// -- Copy Current URL ----------------------------------------------------------

export class IdeBrowserCopyUrlAction extends Action2 {
	static readonly ID = IdeBrowserMenuCommandIds.copyUrl;

	constructor() {
		super({
			id: IdeBrowserCopyUrlAction.ID,
			title: localize2('ide.browser.copyUrlAction', "Copy Current URL"),
			category: BrowserActionCategory,
			icon: Codicon.copy,
			f1: true,
			precondition: BROWSER_EDITOR_ACTIVE,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const notificationService = accessor.get(INotificationService);
		const url = getActiveBrowserModel(accessor)?.url;
		if (!isCopyableBrowserUrl(url)) {
			notificationService.info(localize2('ide.browser.copyUrlNoPage', "No page loaded in the browser tab.").value);
			return;
		}
		await accessor.get(IClipboardService).writeText(url!.trim());
		notificationService.info(localize2('ide.browser.copyUrlDone', "Browser URL copied to clipboard.").value);
	}
}

// -- Zoom row (Zoom Out / percent / Zoom In / Reset Zoom) ----------------------
//
// Cursor parity (DEV-GAPS-93C, browser-tab-menu-zoom): Cursor's native
// "..." menu section 4 is ONE composite row (BrowserMoreMenu.react.js
// zoom row `yj_`, workbench.desktop.main.js byte ~21133709, Cursor 3.25.9):
// label "Zoom", a "−" button (aria-label "Zoom out", disabled at <=25%),
// a live "{percent}%" span, a "+" button (aria-label "Zoom in", disabled
// at >=500%), and a reset button (aria-label "Reset zoom",
// title "Reset zoom to 100%", codicon-history, disabled at exactly 100%);
// the row's menu item is closeOnSelect:false and clamps zoom to
// Zep=25..Qep=500 (@21136979/@21136986).
//
// HONEST DIVERGENCE: the extension-contributed `editor/title/context`
// menu (package.json) can only host flat command entries — it cannot
// render a composite row, a live percent label, closeOnSelect:false, or
// per-percent disabled states. The row is therefore decomposed into
// three commands (Zoom Out / Zoom In / Reset Zoom) that delegate to the
// SAME native zoom machinery Cursor drives (the browser view model's
// zoomIn/zoomOut/resetZoom via BrowserEditorZoomSupport, which also
// shows the transient percent pill in the URL bar and announces the new
// level — the percent readout Cursor puts inside the row). The percent
// bounds (25–500) and the reset-to-100% semantics come from the model's
// zoom ladder, identical to upstream workbench.action.browser.* — these
// ide.browser.* ids exist so the "..." menu has product-owned commands
// to target, exactly like the other sections of this file.

export class IdeBrowserZoomOutAction extends Action2 {
	static readonly ID = IdeBrowserMenuCommandIds.zoomOut;

	constructor() {
		super({
			id: IdeBrowserZoomOutAction.ID,
			title: localize2('ide.browser.zoomOutAction', "Zoom Out"),
			category: BrowserActionCategory,
			icon: Codicon.zoomOut,
			f1: true,
			precondition: BROWSER_EDITOR_ACTIVE,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await getActiveBrowserEditor(accessor)
			?.getContribution(BrowserEditorZoomSupport)
			?.zoomOut();
	}
}

export class IdeBrowserZoomInAction extends Action2 {
	static readonly ID = IdeBrowserMenuCommandIds.zoomIn;

	constructor() {
		super({
			id: IdeBrowserZoomInAction.ID,
			title: localize2('ide.browser.zoomInAction', "Zoom In"),
			category: BrowserActionCategory,
			icon: Codicon.zoomIn,
			f1: true,
			precondition: BROWSER_EDITOR_ACTIVE,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await getActiveBrowserEditor(accessor)
			?.getContribution(BrowserEditorZoomSupport)
			?.zoomIn();
	}
}

export class IdeBrowserResetZoomAction extends Action2 {
	static readonly ID = IdeBrowserMenuCommandIds.resetZoom;

	constructor() {
		super({
			id: IdeBrowserResetZoomAction.ID,
			// Cursor's reset button: aria-label "Reset zoom",
			// title "Reset zoom to 100%", codicon-history icon.
			title: localize2('ide.browser.resetZoomAction', "Reset Zoom"),
			category: BrowserActionCategory,
			icon: Codicon.history,
			f1: true,
			precondition: BROWSER_EDITOR_ACTIVE,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await getActiveBrowserEditor(accessor)
			?.getContribution(BrowserEditorZoomSupport)
			?.resetZoom();
	}
}

// -- Clear Browsing History ----------------------------------------------------

export class IdeBrowserClearHistoryAction extends Action2 {
	static readonly ID = IdeBrowserMenuCommandIds.clearHistory;

	constructor() {
		super({
			id: IdeBrowserClearHistoryAction.ID,
			title: localize2('ide.browser.clearHistoryAction', "Clear Browsing History"),
			category: BrowserActionCategory,
			icon: Codicon.history,
			f1: true,
			precondition: BROWSER_EDITOR_ACTIVE,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const model = getActiveBrowserModel(accessor);
		if (!model) {
			return;
		}
		const confirmed = await confirmClearData(
			accessor.get(IDialogService),
			localize2('ide.browser.clearHistoryTitle', "Clear Browsing History").value,
			// Honest scope: the native tab keeps a real history store
			// (upstream session history), unlike the webview tab which can
			// only reset back/forward entries.
			localize2('ide.browser.clearHistoryDetail', "This will clear the browsing history for this browser session.").value,
		);
		if (!confirmed) {
			return;
		}
		const notificationService = accessor.get(INotificationService);
		try {
			await model.deleteHistory();
			notificationService.info(localize2('ide.browser.clearHistoryDone', "Browsing history cleared.").value);
		} catch (error) {
			notificationService.error(localize2('ide.browser.clearHistoryFailed', "Failed to clear browsing history: {0}", String(error)).value);
		}
	}
}

// -- Clear Cookies --------------------------------------------------------------

export class IdeBrowserClearCookiesAction extends Action2 {
	static readonly ID = IdeBrowserMenuCommandIds.clearCookies;

	constructor() {
		super({
			id: IdeBrowserClearCookiesAction.ID,
			title: localize2('ide.browser.clearCookiesAction', "Clear Cookies"),
			category: BrowserActionCategory,
			icon: Codicon.clearAll,
			f1: true,
			precondition: BROWSER_EDITOR_ACTIVE,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const model = getActiveBrowserModel(accessor);
		if (!model) {
			return;
		}
		const confirmed = await confirmClearData(
			accessor.get(IDialogService),
			localize2('ide.browser.clearCookiesTitle', "Clear Cookies").value,
			localize2('ide.browser.clearCookiesDetail', "This will remove all cookies. You may be signed out of websites.").value,
		);
		if (!confirmed) {
			return;
		}
		const notificationService = accessor.get(INotificationService);
		try {
			await sendCdpToBrowserView(accessor.get(IBrowserViewCDPService), model.id, 'Network.clearBrowserCookies');
			notificationService.info(localize2('ide.browser.clearCookiesDone', "Cookies cleared.").value);
		} catch (error) {
			notificationService.error(localize2('ide.browser.clearCookiesFailed', "Failed to clear cookies: {0}", String(error)).value);
		}
	}
}

// -- Clear Cache -----------------------------------------------------------------

export class IdeBrowserClearCacheAction extends Action2 {
	static readonly ID = IdeBrowserMenuCommandIds.clearCache;

	constructor() {
		super({
			id: IdeBrowserClearCacheAction.ID,
			title: localize2('ide.browser.clearCacheAction', "Clear Cache"),
			category: BrowserActionCategory,
			icon: Codicon.clearAll,
			f1: true,
			precondition: BROWSER_EDITOR_ACTIVE,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const model = getActiveBrowserModel(accessor);
		if (!model) {
			return;
		}
		const confirmed = await confirmClearData(
			accessor.get(IDialogService),
			localize2('ide.browser.clearCacheTitle', "Clear Cache").value,
			localize2('ide.browser.clearCacheDetail', "This will clear the browser cache.").value,
		);
		if (!confirmed) {
			return;
		}
		const notificationService = accessor.get(INotificationService);
		try {
			await sendCdpToBrowserView(accessor.get(IBrowserViewCDPService), model.id, 'Network.clearBrowserCache');
			notificationService.info(localize2('ide.browser.clearCacheDone', "Cache cleared.").value);
		} catch (error) {
			notificationService.error(localize2('ide.browser.clearCacheFailed', "Failed to clear cache: {0}", String(error)).value);
		}
	}
}

// -- Toggle Bookmark Bar -------------------------------------------------------
//
// Cursor parity (IDE-CODE DEV-GAPS-74, browser-tab-menu-bookmark-bar): the
// native browser tab "..." menu item 5 is a conditional SwitchItem
// "Show Bookmark Bar" (detail-browser-2026-10-19.md:59; dig-browser-menu:13).
// The extension-contributed `editor/title/context` menu cannot host a
// SwitchItem, so this is a toggle command whose menu entry carries a
// `toggled` checkmark bound to `config.ide.browser.showBookmarkBar`
// (extensions/ide-agent/package.json). Toggling flips the pref; the bar
// itself is rendered by BrowserBookmarkBarFeature.

export class IdeBrowserToggleBookmarkBarAction extends Action2 {
	static readonly ID = IdeBrowserMenuCommandIds.toggleBookmarkBar;

	constructor() {
		super({
			id: IdeBrowserToggleBookmarkBarAction.ID,
			title: localize2('ide.browser.toggleBookmarkBarAction', "Show Bookmark Bar"),
			category: BrowserActionCategory,
			icon: Codicon.bookmark,
			f1: true,
			precondition: BROWSER_EDITOR_ACTIVE,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const configurationService = accessor.get(IConfigurationService);
		const current = configurationService.getValue<boolean>(SHOW_BOOKMARK_BAR_SETTING_ID)
			?? SHOW_BOOKMARK_BAR_DEFAULT;
		await configurationService.updateValue(SHOW_BOOKMARK_BAR_SETTING_ID, !current);
	}
}

registerAction2(IdeBrowserTakeScreenshotAction);
registerAction2(IdeBrowserCaptureAreaAction);
registerAction2(IdeBrowserHardReloadAction);
registerAction2(IdeBrowserCopyUrlAction);
registerAction2(IdeBrowserZoomOutAction);
registerAction2(IdeBrowserZoomInAction);
registerAction2(IdeBrowserResetZoomAction);
registerAction2(IdeBrowserClearHistoryAction);
registerAction2(IdeBrowserClearCookiesAction);
registerAction2(IdeBrowserClearCacheAction);
registerAction2(IdeBrowserToggleBookmarkBarAction);
