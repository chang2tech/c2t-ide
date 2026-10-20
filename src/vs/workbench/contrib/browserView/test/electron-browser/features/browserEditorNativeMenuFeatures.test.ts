/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { DisposableStore, IDisposable } from '../../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { Action2 } from '../../../../../../platform/actions/common/actions.js';
import { IBrowserViewCDPService } from '../../../common/browserView.js';
import { CDPEvent, CDPRequest, CDPResponse } from '../../../../../../platform/browserView/common/cdp/types.js';
import { BROWSER_EDITOR_ACTIVE, BrowserActionCategory } from '../../../electron-browser/browserEditor.js';
import {
	IdeBrowserCaptureAreaAction,
	IdeBrowserClearCacheAction,
	IdeBrowserClearCookiesAction,
	IdeBrowserClearHistoryAction,
	IdeBrowserCopyUrlAction,
	IdeBrowserHardReloadAction,
	IdeBrowserMenuCommandIds,
	IdeBrowserResetZoomAction,
	IdeBrowserTakeScreenshotAction,
	IdeBrowserToggleBookmarkBarAction,
	IdeBrowserZoomInAction,
	IdeBrowserZoomOutAction,
	isCopyableBrowserUrl,
	sendCdpToBrowserView,
} from '../../../electron-browser/features/browserEditorNativeMenuFeatures.js';

/**
 * Fake IBrowserViewCDPService with programmable send behavior.
 * Response messages are delivered on the next microtask so the
 * awaiting helper's listener is always attached before the reply arrives.
 */
class FakeCdpService implements IBrowserViewCDPService {
	declare readonly _serviceBrand: undefined;

	private readonly groups = new Map<string, Emitter<CDPResponse | CDPEvent>>();
	readonly sent: Array<{ groupId: string; message: CDPRequest }> = [];
	readonly destroyedGroups: string[] = [];
	activeListeners = 0;
	/** 'ok' | 'error-response' | 'throw' */
	sendBehavior: 'ok' | 'error-response' | 'throw' = 'ok';
	errorMessage = 'boom';

	async createSessionGroup(browserId: string): Promise<string> {
		const groupId = `group-${browserId}`;
		this.groups.set(groupId, new Emitter<CDPResponse | CDPEvent>());
		return groupId;
	}

	async destroySessionGroup(groupId: string): Promise<void> {
		this.destroyedGroups.push(groupId);
		this.groups.get(groupId)?.dispose();
	}

	async sendCDPMessage(groupId: string, message: CDPRequest): Promise<void> {
		this.sent.push({ groupId, message });
		if (this.sendBehavior === 'throw') {
			throw new Error('send failed');
		}
		const emitter = this.groups.get(groupId);
		queueMicrotask(() => {
			if (this.sendBehavior === 'error-response') {
				emitter?.fire({ id: message.id, error: { code: -1, message: this.errorMessage } });
			} else {
				emitter?.fire({ id: message.id, result: {} });
			}
		});
	}

	onCDPMessage(groupId: string): Event<CDPResponse | CDPEvent> {
		const event = this.groups.get(groupId)!.event;
		return (listener, thisArgs, disposables) => {
			const d = event(listener, thisArgs, disposables);
			this.activeListeners++;
			return {
				dispose: () => {
					this.activeListeners--;
					d.dispose();
				}
			} satisfies IDisposable;
		};
	}

	onDidDestroy(_groupId: string): Event<void> {
		return Event.None;
	}
}

suite('Browser Editor Native Menu Features (ide.browser.*)', () => {
	const disposables = new DisposableStore();

	teardown(() => disposables.clear());
	ensureNoDisposablesAreLeakedInTestSuite();

	test('declares exactly the 11 ide.browser.* command ids', () => {
		// 7 original + toggleBookmarkBar (GAPS-74) + zoom trio (DEV-GAPS-93C).
		assert.deepStrictEqual(Object.values(IdeBrowserMenuCommandIds), [
			'ide.browser.takeScreenshot',
			'ide.browser.captureArea',
			'ide.browser.hardReload',
			'ide.browser.copyUrl',
			'ide.browser.zoomOut',
			'ide.browser.zoomIn',
			'ide.browser.resetZoom',
			'ide.browser.clearHistory',
			'ide.browser.clearCookies',
			'ide.browser.clearCache',
			'ide.browser.toggleBookmarkBar',
		]);
	});

	const actionCases: Array<[new () => Action2, string, string]> = [
		[IdeBrowserTakeScreenshotAction, 'ide.browser.takeScreenshot', 'Take Screenshot'],
		[IdeBrowserCaptureAreaAction, 'ide.browser.captureArea', 'Capture Area Screenshot'],
		[IdeBrowserHardReloadAction, 'ide.browser.hardReload', 'Hard Reload'],
		[IdeBrowserCopyUrlAction, 'ide.browser.copyUrl', 'Copy Current URL'],
		[IdeBrowserZoomOutAction, 'ide.browser.zoomOut', 'Zoom Out'],
		[IdeBrowserZoomInAction, 'ide.browser.zoomIn', 'Zoom In'],
		[IdeBrowserResetZoomAction, 'ide.browser.resetZoom', 'Reset Zoom'],
		[IdeBrowserClearHistoryAction, 'ide.browser.clearHistory', 'Clear Browsing History'],
		[IdeBrowserClearCookiesAction, 'ide.browser.clearCookies', 'Clear Cookies'],
		[IdeBrowserClearCacheAction, 'ide.browser.clearCache', 'Clear Cache'],
		[IdeBrowserToggleBookmarkBarAction, 'ide.browser.toggleBookmarkBar', 'Show Bookmark Bar'],
	];

	for (const [Ctor, id, title] of actionCases) {
		test(`${id}: palette-visible, gated on the active native browser editor`, () => {
			// Construction needs no DI — only the registration metadata is asserted.
			const desc = new Ctor().desc;
			assert.strictEqual(desc.id, id);
			// f1:true keeps the command palette entry live — the dangling-entry
			// bug was "palette-visible but no registered handler".
			assert.strictEqual(desc.f1, true);
			assert.strictEqual(desc.precondition, BROWSER_EDITOR_ACTIVE);
			assert.strictEqual(desc.category, BrowserActionCategory);
			assert.strictEqual(desc.title.value, title);
			assert.ok(desc.icon, 'expected an icon');
		});
	}

	test('reset zoom uses the codicon-history icon (Cursor zoom row verbatim)', () => {
		// Cursor's reset button (BrowserMoreMenu zoom row): aria-label
		// "Reset zoom", title "Reset zoom to 100%", codicon-history icon —
		// NOT upstream VS Code's screenNormal reset-zoom icon.
		const desc = new IdeBrowserResetZoomAction().desc;
		assert.ok(desc.icon && 'id' in desc.icon, 'expected a ThemeIcon');
		assert.strictEqual((desc.icon as { id: string }).id, 'history');
	});

	test('isCopyableBrowserUrl refuses blank pages (mirrors the webview tab rule)', () => {
		assert.strictEqual(isCopyableBrowserUrl('https://example.com/'), true);
		assert.strictEqual(isCopyableBrowserUrl('  https://example.com/  '), true);
		assert.strictEqual(isCopyableBrowserUrl('about:blank'), false);
		assert.strictEqual(isCopyableBrowserUrl('  about:blank '), false);
		assert.strictEqual(isCopyableBrowserUrl(''), false);
		assert.strictEqual(isCopyableBrowserUrl('   '), false);
		assert.strictEqual(isCopyableBrowserUrl(undefined), false);
	});

	test('sendCdpToBrowserView sends one message and destroys the group', async () => {
		const fake = new FakeCdpService();
		await sendCdpToBrowserView(fake, 'browser-1', 'Network.clearBrowserCache', {});

		assert.strictEqual(fake.sent.length, 1);
		assert.strictEqual(fake.sent[0].groupId, 'group-browser-1');
		assert.strictEqual(fake.sent[0].message.method, 'Network.clearBrowserCache');
		assert.strictEqual(typeof fake.sent[0].message.id, 'number');
		assert.deepStrictEqual(fake.destroyedGroups, ['group-browser-1']);
		assert.strictEqual(fake.activeListeners, 0, 'response listener must be disposed');
	});

	test('sendCdpToBrowserView throws the CDP error message', async () => {
		const fake = new FakeCdpService();
		fake.sendBehavior = 'error-response';
		fake.errorMessage = 'Not allowed';

		await assert.rejects(
			sendCdpToBrowserView(fake, 'browser-1', 'Network.clearBrowserCookies'),
			/Not allowed/,
		);
		assert.deepStrictEqual(fake.destroyedGroups, ['group-browser-1'], 'group destroyed even on CDP error');
	});

	test('sendCdpToBrowserView rejects on timeout', async () => {
		const fake = new FakeCdpService();
		// Swallow the send: no response ever fires, so the helper must time out.
		fake.sendCDPMessage = async (groupId: string, message: CDPRequest) => {
			fake.sent.push({ groupId, message });
		};

		await assert.rejects(
			sendCdpToBrowserView(fake, 'browser-1', 'Network.clearBrowserCache', {}, 50),
			/timed out after 50ms/,
		);
		assert.deepStrictEqual(fake.destroyedGroups, ['group-browser-1'], 'group destroyed on timeout');
	});

	test('sendCdpToBrowserView disposes the listener when the send itself throws', async () => {
		const fake = new FakeCdpService();
		fake.sendBehavior = 'throw';

		await assert.rejects(
			sendCdpToBrowserView(fake, 'browser-1', 'Network.clearBrowserCache', {}, 50),
			/send failed/,
		);
		assert.strictEqual(fake.activeListeners, 0, 'pending response listener must be disposed');
		assert.deepStrictEqual(fake.destroyedGroups, ['group-browser-1']);
	});
});
