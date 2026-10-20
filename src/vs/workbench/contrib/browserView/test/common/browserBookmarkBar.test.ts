/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * DEV-GAPS-74 — `browser-tab-menu-bookmark-bar` tests (node:test).
 *
 * Cursor evidence (detail-browser-2026-10-19.md:59; dig-browser-menu-2026-10-19.md:13, gap
 * table :46): the native browser tab "..." menu has a conditional SwitchItem
 * "Show Bookmark Bar". These tests pin the fork-side contracts: the pref key
 * + default (Cursor's canonical default is UNKNOWN from the REA docs, so the
 * fork defaults OFF), and the bookmark-bar item label derivation.
 *
 * The widget/command/menu wiring (browserBookmarkBarFeature.ts,
 * IdeBrowserToggleBookmarkBarAction, extensions/ide-agent/package.json
 * `editor/title/context` entry with `toggled: {condition: config.ide.browser.showBookmarkBar}`)
 * needs the workbench runtime and is verified by inspection only.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
	SHOW_BOOKMARK_BAR_SETTING_ID,
	SHOW_BOOKMARK_BAR_DEFAULT,
	BOOKMARK_BAR_ITEM_LABEL_MAX,
	bookmarkBarItemLabel,
} from '../../common/browserBookmarkBar.js';

describe('browser-tab-menu-bookmark-bar: pref contract', () => {
	it('uses the ide.browser.showBookmarkBar key', () => {
		assert.strictEqual(SHOW_BOOKMARK_BAR_SETTING_ID, 'ide.browser.showBookmarkBar');
	});

	it('defaults OFF (Cursor canonical default is UNKNOWN from the REA docs)', () => {
		assert.strictEqual(SHOW_BOOKMARK_BAR_DEFAULT, false);
	});
});

describe('browser-tab-menu-bookmark-bar: bookmarkBarItemLabel', () => {
	it('shows host + path for full URLs', () => {
		assert.strictEqual(
			bookmarkBarItemLabel('https://example.com/docs/guide?x=1#frag'),
			'example.com/docs/guide',
		);
	});

	it('drops the root slash', () => {
		assert.strictEqual(bookmarkBarItemLabel('https://example.com/'), 'example.com');
	});

	it('keeps host-only when there is no path', () => {
		assert.strictEqual(bookmarkBarItemLabel('https://example.com'), 'example.com');
	});

	it('falls back to the raw string for non-URLs', () => {
		assert.strictEqual(bookmarkBarItemLabel('not a url at all'), 'not a url at all');
	});

	it('truncates long labels with an ellipsis', () => {
		const label = bookmarkBarItemLabel('https://example.com/' + 'a'.repeat(200));
		assert.strictEqual(label.length, BOOKMARK_BAR_ITEM_LABEL_MAX);
		assert.ok(label.endsWith('…'), `expected ellipsis, got: ${label}`);
	});
});
