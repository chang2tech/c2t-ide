/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { upcastPartial } from '../../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../../platform/configuration/test/common/testConfigurationService.js';
import { INotificationService, INotification, NeverShowAgainScope, Severity } from '../../../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../../../platform/opener/common/opener.js';
import { IStorageService, StorageScope } from '../../../../../../platform/storage/common/storage.js';
import { IWorkbenchEnvironmentService } from '../../../../../services/environment/common/environmentService.js';
import { workbenchInstantiationService } from '../../../../../test/browser/workbenchTestServices.js';
import { OPEN_LOCAL_LINKS_CONFIG_KEY, URL_OPEN_TOAST_NEVER_SHOW_AGAIN_ID } from '../../../common/openLocalLinks.js';
import { OpenLocalLinksOpenerContribution } from '../../../electron-browser/features/openLocalLinksOpener.js';

// DEV-GAPS-147 (`settings-open-local-links`): the OpenerService consumer
// of Cursor's "Open Local Links in Cursor Browser". Binary evidence
// (Cursor 3.25.9, re-extracted): the first opener pushed into the
// OpenerService (workbench.desktop.main.js @32435883) routes a localhost
// URL to `workbench.action.openBrowserEditor` with
// `{url: pBn(url), preserveFocus: !options.fromUserGesture, …}` when the
// storage preference `autoOpenLocalhostUrls` (default true) is on, and
// falls through to the default external handling otherwise. The command
// service is faked here — no link is ever really opened.

suite('Open Local Links Opener (DEV-GAPS-147)', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	interface IExecutedCommand { readonly id: string; readonly args: unknown[] }
	interface IConfigUpdate { readonly key: string; readonly value: unknown }

	function createOpener(configuration: Record<string, unknown>, remoteAuthority?: string, neverShowAgain = false): { opener: OpenLocalLinksOpenerContribution; executed: IExecutedCommand[]; notifications: INotification[]; configUpdates: IConfigUpdate[] } {
		const instantiationService = workbenchInstantiationService(undefined, store);
		const executed: IExecutedCommand[] = [];
		const notifications: INotification[] = [];
		const configUpdates: IConfigUpdate[] = [];
		instantiationService.stub(IOpenerService, { registerOpener: () => Disposable.None });
		const configurationService = new TestConfigurationService(configuration);
		const originalUpdateValue = configurationService.updateValue.bind(configurationService);
		configurationService.updateValue = async (key: string, value: unknown) => { configUpdates.push({ key, value }); return originalUpdateValue(key, value); };
		instantiationService.stub(IConfigurationService, configurationService);
		instantiationService.stub(ICommandService, {
			executeCommand: async (id: string, ...args: unknown[]): Promise<any> => { executed.push({ id, args }); }
		});
		// DEV-GAPS-159: the UrlOpenToast services — notifications are
		// recorded, never shown; the stored never-show-again boolean is
		// controlled per test.
		instantiationService.stub(INotificationService, upcastPartial<INotificationService>({
			notify: (notification: INotification) => { notifications.push(notification); return upcastPartial({}); }
		}));
		instantiationService.stub(IStorageService, upcastPartial<IStorageService>({
			getBoolean: ((key: string, _scope: StorageScope, fallbackValue?: boolean) => key === URL_OPEN_TOAST_NEVER_SHOW_AGAIN_ID ? neverShowAgain : fallbackValue) as IStorageService['getBoolean']
		}));
		if (remoteAuthority !== undefined) {
			instantiationService.stub(IWorkbenchEnvironmentService, upcastPartial<IWorkbenchEnvironmentService>({ remoteAuthority }));
		}
		const opener = store.add(instantiationService.createInstance(OpenLocalLinksOpenerContribution));
		return { opener, executed, notifications, configUpdates };
	}

	test('contribution id', () => {
		assert.strictEqual(OpenLocalLinksOpenerContribution.ID, 'workbench.contrib.openLocalLinksOpener');
	});

	test('setting unset (binary default ON): a user-gesture localhost click opens the Browser Tab, focus kept', async () => {
		const { opener, executed } = createOpener({});
		const handled = await opener.open('http://localhost:3000/dashboard', { fromUserGesture: true });
		assert.strictEqual(handled, true);
		assert.deepStrictEqual(executed, [{ id: 'workbench.action.openBrowserEditor', args: [{ url: 'http://localhost:3000/dashboard', preserveFocus: false }] }]);
	});

	test('setting ON: a programmatic open routes with preserveFocus true (binary !fromUserGesture)', async () => {
		const { opener, executed } = createOpener({ [OPEN_LOCAL_LINKS_CONFIG_KEY]: true });
		const handled = await opener.open('https://127.0.0.2:8443/preview');
		assert.strictEqual(handled, true);
		assert.deepStrictEqual(executed, [{ id: 'workbench.action.openBrowserEditor', args: [{ url: 'https://127.0.0.2:8443/preview', preserveFocus: true }] }]);
	});

	test('setting ON: an all-interfaces URL is normalized to localhost before opening (binary pBn)', async () => {
		const { opener, executed } = createOpener({ [OPEN_LOCAL_LINKS_CONFIG_KEY]: true });
		const handled = await opener.open('http://0.0.0.0:5173/', { fromUserGesture: true });
		assert.strictEqual(handled, true);
		assert.deepStrictEqual(executed, [{ id: 'workbench.action.openBrowserEditor', args: [{ url: 'http://localhost:5173/', preserveFocus: false }] }]);
	});

	test('setting OFF: localhost links fall through to the default handling, no command executed', async () => {
		const { opener, executed } = createOpener({ [OPEN_LOCAL_LINKS_CONFIG_KEY]: false });
		assert.strictEqual(await opener.open('http://localhost:3000/', { fromUserGesture: true }), false);
		assert.strictEqual(await opener.open('http://127.0.0.1:5173/'), false);
		assert.deepStrictEqual(executed, []);
	});

	test('setting ON: non-local links are not intercepted', async () => {
		const { opener, executed } = createOpener({ [OPEN_LOCAL_LINKS_CONFIG_KEY]: true });
		assert.strictEqual(await opener.open('https://example.com/', { fromUserGesture: true }), false);
		assert.strictEqual(await opener.open('http://192.168.1.10:3000/', { fromUserGesture: true }), false);
		assert.deepStrictEqual(executed, []);
	});

	test('setting ON: an explicit openExternal request is never intercepted', async () => {
		const { opener, executed } = createOpener({ [OPEN_LOCAL_LINKS_CONFIG_KEY]: true });
		assert.strictEqual(await opener.open('http://localhost:3000/', { openExternal: true, fromUserGesture: true }), false);
		assert.deepStrictEqual(executed, []);
	});

	test('setting ON: in an ssh-remote window localhost links are not intercepted', async () => {
		const { opener, executed } = createOpener({ [OPEN_LOCAL_LINKS_CONFIG_KEY]: true }, 'ssh-remote+myhost');
		assert.strictEqual(await opener.open('http://localhost:3000/', { fromUserGesture: true }), false);
		assert.deepStrictEqual(executed, []);
	});

	// DEV-GAPS-159 (QA-155 NF-2): the binary's UrlOpenToast
	// (urlOpenToastService, desk @20961744; texts nls 12224/12225 in
	// out/nls.messages.json — "Opening {0} in Cursor Browser" /
	// "Don't Open").
	test('toast: a routed open shows the verbatim UrlOpenToast before opening', async () => {
		const { opener, notifications } = createOpener({ [OPEN_LOCAL_LINKS_CONFIG_KEY]: true });
		assert.strictEqual(await opener.open('http://localhost:3000/dashboard', { fromUserGesture: true }), true);
		assert.strictEqual(notifications.length, 1);
		const notification = notifications[0];
		assert.strictEqual(notification.severity, Severity.Info);
		assert.strictEqual(notification.message, 'Opening http://localhost:3000/dashboard in Cursor Browser');
		assert.strictEqual(notification.actions?.primary?.length, 1);
		assert.strictEqual(notification.actions?.primary?.[0].id, 'urlOpenToast.dontOpen');
		assert.strictEqual(notification.actions?.primary?.[0].label, `Don't Open`);
		assert.deepStrictEqual(notification.neverShowAgain, { id: 'urlOpenToast.neverShowAgainv1', scope: NeverShowAgainScope.APPLICATION, isSecondary: false });
	});

	test('toast: deduped per origin within the session (binary _shownOrigins)', async () => {
		const { opener, notifications } = createOpener({ [OPEN_LOCAL_LINKS_CONFIG_KEY]: true });
		assert.strictEqual(await opener.open('http://localhost:3000/a', { fromUserGesture: true }), true);
		assert.strictEqual(await opener.open('http://localhost:3000/b', { fromUserGesture: true }), true);
		assert.strictEqual(notifications.length, 1);
		assert.strictEqual(await opener.open('http://localhost:3001/a', { fromUserGesture: true }), true);
		assert.strictEqual(notifications.length, 2);
	});

	test('toast: never-show-again stored → notify is still attempted (the platform suppresses it)', async () => {
		const { opener, notifications } = createOpener({ [OPEN_LOCAL_LINKS_CONFIG_KEY]: true }, undefined, true);
		assert.strictEqual(await opener.open('http://localhost:3000/a', { fromUserGesture: true }), true);
		assert.strictEqual(await opener.open('http://localhost:3000/a', { fromUserGesture: true }), true);
		assert.strictEqual(notifications.length, 2);
	});

	test('toast: "Don\'t Open" action turns the setting off (binary sets autoOpenLocalhostUrls=false)', async () => {
		const { opener, notifications, configUpdates } = createOpener({ [OPEN_LOCAL_LINKS_CONFIG_KEY]: true });
		assert.strictEqual(await opener.open('http://localhost:3000/', { fromUserGesture: true }), true);
		await notifications[0].actions?.primary?.[0].run();
		assert.deepStrictEqual(configUpdates, [{ key: OPEN_LOCAL_LINKS_CONFIG_KEY, value: false }]);
	});

	test('toast: no toast when the open is not routed (OFF / non-local / openExternal)', async () => {
		const off = createOpener({ [OPEN_LOCAL_LINKS_CONFIG_KEY]: false });
		assert.strictEqual(await off.opener.open('http://localhost:3000/', { fromUserGesture: true }), false);
		assert.strictEqual(off.notifications.length, 0);
		const on = createOpener({ [OPEN_LOCAL_LINKS_CONFIG_KEY]: true });
		assert.strictEqual(await on.opener.open('https://example.com/', { fromUserGesture: true }), false);
		assert.strictEqual(await on.opener.open('http://localhost:3000/', { openExternal: true, fromUserGesture: true }), false);
		assert.strictEqual(on.notifications.length, 0);
	});
});
