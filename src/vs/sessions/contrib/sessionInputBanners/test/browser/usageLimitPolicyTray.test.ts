/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { IConfigurationChangeEvent, IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IQuickInputService, IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import {
	TRAY_BANNER_ACTION_COMPONENT,
	TRAY_BANNER_ACTIONS_COMPONENT,
	TRAY_BANNER_COMPONENT,
	TRAY_BANNER_CONTENT_COMPONENT,
	TRAY_BANNER_DESCRIPTION_COMPONENT,
	TRAY_BANNER_LAYOUT_COMPONENT,
	TRAY_BANNER_TITLE_COMPONENT,
	USAGE_LIMIT_POLICY_SETTING,
	USAGE_LIMIT_POLICY_TRAY_COMPONENT,
	USAGE_LIMIT_TRAY_DESCRIPTION,
	USAGE_LIMIT_TRAY_SET_LIMIT_LABEL,
	USAGE_LIMIT_TRAY_TITLE,
	UsageLimitPolicy,
} from '../../browser/usageLimitPolicy.js';
import { UsageLimitPolicyTray } from '../../browser/usageLimitPolicyTray.js';

function changeEvent(key: string): IConfigurationChangeEvent {
	return upcastPartial<IConfigurationChangeEvent>({
		affectsConfiguration: (configuration: string) => configuration === key,
	});
}

interface IFakeConfig {
	readonly service: IConfigurationService;
	readonly get: (key: string) => unknown;
	readonly set: (key: string, value: unknown) => void;
}

function createFakeConfigService(store: DisposableStore, initial: Record<string, unknown> = {}): IFakeConfig {
	const values = new Map<string, unknown>(Object.entries(initial));
	const emitter = store.add(new Emitter<IConfigurationChangeEvent>());
	const service = upcastPartial<IConfigurationService>({
		onDidChangeConfiguration: emitter.event,
		getValue: (<T>(key?: string): T | undefined => values.get(key as string) as T | undefined),
		updateValue: async (key: string, value: unknown): Promise<void> => {
			values.set(key, value);
			emitter.fire(changeEvent(key));
		},
	});
	return {
		service,
		get: (key: string) => values.get(key),
		set: (key: string, value: unknown) => {
			values.set(key, value);
			emitter.fire(changeEvent(key));
		},
	};
}

suite('UsageLimitPolicyTray', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function setup(config: IFakeConfig, quickInput?: Partial<IQuickInputService>) {
		const policy = disposables.add(new UsageLimitPolicy(config.service));
		const quickInputService = upcastPartial<IQuickInputService>({
			pick: async () => undefined,
			input: async () => undefined,
			...quickInput,
		});
		const tray = disposables.add(new UsageLimitPolicyTray(policy, quickInputService));
		return { policy, tray };
	}

	test('renders the verbatim data-component structure and copy', () => {
		const config = createFakeConfigService(disposables.add(new DisposableStore()));
		const { tray } = setup(config);

		const root = tray.domNode;
		assert.strictEqual(root.getAttribute('data-component'), USAGE_LIMIT_POLICY_TRAY_COMPONENT);
		assert.strictEqual(root.getAttribute('data-component'), 'usage-limit-policy-tray');

		const banner = root.querySelector<HTMLElement>(`[data-component="${TRAY_BANNER_COMPONENT}"]`);
		assert.ok(banner, 'tray-banner exists');
		assert.strictEqual(banner, root.firstElementChild, 'tray-banner is a direct child of usage-limit-policy-tray');

		const layout = banner.querySelector(`[data-component="${TRAY_BANNER_LAYOUT_COMPONENT}"]`);
		const content = banner.querySelector(`[data-component="${TRAY_BANNER_CONTENT_COMPONENT}"]`);
		assert.ok(layout, 'tray-banner-layout exists');
		assert.ok(content, 'tray-banner-content exists');

		const title = content.querySelector(`[data-component="${TRAY_BANNER_TITLE_COMPONENT}"]`);
		const description = content.querySelector(`[data-component="${TRAY_BANNER_DESCRIPTION_COMPONENT}"]`);
		assert.strictEqual(title?.textContent, 'Usage limit reached');
		assert.strictEqual(title?.textContent, USAGE_LIMIT_TRAY_TITLE);
		assert.strictEqual(description?.textContent, "You've reached your limit. Responses may be slower. Upgrade for more usage.");
		assert.strictEqual(description?.textContent, USAGE_LIMIT_TRAY_DESCRIPTION);

		const actions = banner.querySelector(`[data-component="${TRAY_BANNER_ACTIONS_COMPONENT}"]`);
		const button = actions?.querySelector<HTMLButtonElement>(`[data-component="${TRAY_BANNER_ACTION_COMPONENT}"]`);
		assert.ok(button, 'Set new limit button exists');
		assert.strictEqual(button?.textContent, 'Set new limit');
		assert.strictEqual(button?.textContent, USAGE_LIMIT_TRAY_SET_LIMIT_LABEL);
	});

	test('hidden until the limit is reached; shows on notifyLimitReached, hides on clear', () => {
		const config = createFakeConfigService(disposables.add(new DisposableStore()));
		const { policy, tray } = setup(config);

		assert.strictEqual(tray.domNode.hidden, true, 'hidden initially');

		policy.notifyLimitReached();
		assert.strictEqual(tray.domNode.hidden, false, 'shown after notifyLimitReached');

		policy.clearLimitReached();
		assert.strictEqual(tray.domNode.hidden, true, 'hidden after clearLimitReached');
	});

	test('reportUsage against the configured limit drives show/hide', () => {
		const config = createFakeConfigService(disposables.add(new DisposableStore()));
		const { policy, tray } = setup(config);
		config.set(USAGE_LIMIT_POLICY_SETTING, 100);

		policy.reportUsage(60);
		assert.strictEqual(tray.domNode.hidden, true, 'below the limit: hidden');

		policy.reportUsage(100);
		assert.strictEqual(tray.domNode.hidden, false, 'at the limit: shown');

		// Raising the limit above current usage hides the tray again.
		return policy.setLimit(200).then(() => {
			assert.strictEqual(tray.domNode.hidden, true, 'limit raised above usage: hidden');
			assert.strictEqual(config.get(USAGE_LIMIT_POLICY_SETTING), 200);
		});
	});

	test('Set new limit button persists the new limit via QuickPick', async () => {
		const config = createFakeConfigService(disposables.add(new DisposableStore()));
		interface ILimitPickItem extends IQuickPickItem { readonly id: 'custom' | 'remove'; }
		const quickInput = upcastPartial<IQuickInputService>({
			pick: (async <T extends IQuickPickItem>(picks: T[]): Promise<T | undefined> =>
				picks.find(item => (item as unknown as ILimitPickItem).id === 'custom')) as IQuickInputService['pick'],
			input: (async () => '250') as IQuickInputService['input'],
		});
		const { tray } = setup(config, quickInput);

		const button = tray.domNode.querySelector<HTMLButtonElement>(`[data-component="${TRAY_BANNER_ACTION_COMPONENT}"]`);
		assert.ok(button);
		button.click();
		await timeout(0);
		await timeout(0);

		assert.strictEqual(config.get(USAGE_LIMIT_POLICY_SETTING), 250, 'new limit persisted to the usage/limit config');
	});
});
