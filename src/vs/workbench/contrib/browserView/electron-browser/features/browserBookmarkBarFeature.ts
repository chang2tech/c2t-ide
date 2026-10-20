/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * IDE-CODE (DEV-GAPS-74, browser-tab-menu-bookmark-bar): Cursor's 'Show
 * Bookmark Bar' switch — a toggleable strip under the navbar of the native
 * browser tab.
 *
 * Cursor evidence (detail-browser-2026-10-19.md:59; dig-browser-menu-2026-10-19.md:13, gap
 * table :46; audit-fix-queue.md ~10202, re-verified vs bundle 3.25.9):
 * - the native browser tab "..." menu (BrowserMoreMenu) has a conditional
 *   SwitchItem "Show Bookmark Bar" (shown "only when bookmark-bar pref exists");
 * - the fork's native "..." menu had 7 items, none bookmark-related; the fork
 *   had no bookmark bar in its chrome.
 *
 * Shape: the bar is a `BrowserWidgetLocation.Toolbar` widget (order 1, right
 * under the navbar) that renders the tab's favorites as quick-link buttons
 * (clicking navigates via the model). Visibility is driven by the
 * `ide.browser.showBookmarkBar` pref. The toggle command lives in
 * browserEditorNativeMenuFeatures.ts (`ide.browser.toggleBookmarkBar`).
 *
 * HONEST-DIVERGENCE: "Bookmark" data in Cursor is the browser's bookmark
 * store. The fork has no bookmark store; the closest local store is the
 * workspace-scoped browser tab favorites (BrowserFavoritesFeature, URL
 * strings only). The bar therefore shows favorites as quick links. A real
 * bookmark store (titles/icons, folders, import) is out of scope — no REA
 * evidence describes its shape. Cursor's canonical default for the pref is
 * UNKNOWN; the fork defaults it to OFF (common/browserBookmarkBar.ts).
 */

import { localize } from '../../../../../nls.js';
import { $ } from '../../../../../base/browser/dom.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions, ConfigurationScope } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import {
	BrowserEditor,
	BrowserEditorContribution,
	BrowserWidgetLocation,
	IBrowserEditorWidget,
} from '../browserEditor.js';
import { SHOW_BOOKMARK_BAR_SETTING_ID, SHOW_BOOKMARK_BAR_DEFAULT, bookmarkBarItemLabel } from '../../common/browserBookmarkBar.js';
import { BrowserFavoritesFeature } from './browserFavoritesFeature.js';

export class BrowserBookmarkBarFeature extends BrowserEditorContribution {

	private readonly _bar: HTMLElement;
	private _favoritesSubscribed = false;

	constructor(
		editor: BrowserEditor,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) {
		super(editor);

		this._bar = $('.browser-bookmark-bar');
		this._bar.setAttribute('role', 'toolbar');
		this._bar.setAttribute('aria-label', localize('browser.bookmarkBar', "Bookmark bar"));
		this._applyVisibility();
		this._render();

		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(SHOW_BOOKMARK_BAR_SETTING_ID)) {
				this._applyVisibility();
			}
		}));
	}

	override get widgets(): readonly IBrowserEditorWidget[] {
		// Order 1: directly under the navbar (order 0).
		return [{ location: BrowserWidgetLocation.Toolbar, element: this._bar, order: 1 }];
	}

	protected override onModelAttached(): void {
		this._render();
	}

	private _applyVisibility(): void {
		const show = this._configurationService.getValue<boolean>(SHOW_BOOKMARK_BAR_SETTING_ID)
			?? SHOW_BOOKMARK_BAR_DEFAULT;
		this._bar.style.display = show ? '' : 'none';
	}

	private _subscribeFavorites(favorites: BrowserFavoritesFeature): void {
		if (this._favoritesSubscribed) {
			return;
		}
		this._favoritesSubscribed = true;
		this._register(favorites.onDidChangeState(() => this._render()));
	}

	private _render(): void {
		this._bar.textContent = '';
		const favorites = this.editor.getContribution(BrowserFavoritesFeature);
		if (!favorites) {
			return;
		}
		// Lazily subscribe: contributions instantiate in registration order, so
		// the favorites feature may not exist yet during our constructor.
		this._subscribeFavorites(favorites);
		for (const url of favorites.getFavorites()) {
			const item = document.createElement('button');
			item.className = 'browser-bookmark-bar-item';
			item.textContent = bookmarkBarItemLabel(url);
			item.title = url;
			item.setAttribute('aria-label', url);
			item.addEventListener('click', () => {
				void this.editor.model?.loadURL(url);
			});
			this._bar.appendChild(item);
		}
	}
}

BrowserEditor.registerContribution(BrowserBookmarkBarFeature);

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	type: 'object',
	properties: {
		[SHOW_BOOKMARK_BAR_SETTING_ID]: {
			type: 'boolean',
			default: SHOW_BOOKMARK_BAR_DEFAULT,
			scope: ConfigurationScope.APPLICATION,
			description: localize('browser.showBookmarkBar', "Show the bookmark bar in browser tabs, with your favorites as quick links. Mirrors Cursor's 'Show Bookmark Bar' switch (browser tab '...' menu). Default: our choice; Cursor's canonical default is UNKNOWN from the REA evidence."),
		}
	}
});
