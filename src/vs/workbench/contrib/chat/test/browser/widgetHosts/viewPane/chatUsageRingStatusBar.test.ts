/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../../../base/common/event.js';
import { Disposable } from '../../../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { ICommandService } from '../../../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../../../platform/configuration/test/common/testConfigurationService.js';
import { TestInstantiationService } from '../../../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { ChatEntitlement, IChatEntitlementService } from '../../../../../../../workbench/services/chat/common/chatEntitlementService.js';
import { ChatConfiguration } from '../../../../common/constants.js';
import {
	ChatUsageRingStatusBar,
	computeUsagePercent,
	DEFAULT_USAGE_RING_DISPLAY_THRESHOLD,
	formatUsageRingPercent,
	formatUsageRingTooltip,
	shouldShowUsageRing,
	UsageRingDisplayMode,
	UsageRingIndicator,
} from '../../../../browser/widgetHosts/viewPane/chatUsageRingStatusBar.js';

suite('formatUsageRingPercent (Cursor J4l)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('rounds normally and clamps to 0-100', () => {
		assert.strictEqual(formatUsageRingPercent(0), 0);
		assert.strictEqual(formatUsageRingPercent(55.4), 55);
		assert.strictEqual(formatUsageRingPercent(55.5), 56);
		assert.strictEqual(formatUsageRingPercent(100), 100);
		assert.strictEqual(formatUsageRingPercent(137), 100);
		assert.strictEqual(formatUsageRingPercent(-3), 0);
	});

	test('tiny non-zero values render as 1%', () => {
		assert.strictEqual(formatUsageRingPercent(0.2), 1);
		assert.strictEqual(formatUsageRingPercent(0.99), 1);
	});

	test('binary-exact edge behavior', () => {
		// Matches Cursor's J4l verbatim: NaN propagates (callers only pass
		// finite values), Infinity clamps to 100.
		assert.ok(Number.isNaN(formatUsageRingPercent(NaN)));
		assert.strictEqual(formatUsageRingPercent(Infinity), 100);
	});
});

suite('formatUsageRingTooltip (Cursor HG_)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('produces the "Usage N%" tooltip text', () => {
		assert.strictEqual(formatUsageRingTooltip(55.4), 'Usage 55%');
		assert.strictEqual(formatUsageRingTooltip(55.5), 'Usage 56%');
		assert.strictEqual(formatUsageRingTooltip(0), 'Usage 0%');
	});
});

suite('computeUsagePercent (Cursor N90)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('computes used/limit clamped to 100', () => {
		assert.strictEqual(computeUsagePercent(50, 100), 50);
		assert.strictEqual(computeUsagePercent(150, 100), 100);
		assert.strictEqual(computeUsagePercent(0, 100), 0);
	});

	test('falls back to usedPercentage when there is no limit', () => {
		assert.strictEqual(computeUsagePercent(10, 0, 42), 42);
		assert.strictEqual(computeUsagePercent(10, 0), undefined);
	});
});

suite('shouldShowUsageRing (Cursor _8g)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('binary-verified default threshold is 50', () => {
		assert.strictEqual(DEFAULT_USAGE_RING_DISPLAY_THRESHOLD, 50);
	});

	test('never hides the ring', () => {
		assert.strictEqual(shouldShowUsageRing({ displayMode: 'never', usageDisplayEnabled: true, percent: 99 }), false);
	});

	test('usageDisplayEnabled false hides the ring', () => {
		assert.strictEqual(shouldShowUsageRing({ displayMode: 'auto', usageDisplayEnabled: false, percent: 99 }), false);
	});

	test('always shows whenever data is available', () => {
		assert.strictEqual(shouldShowUsageRing({ displayMode: 'always', usageDisplayEnabled: true, percent: 3 }), true);
		assert.strictEqual(shouldShowUsageRing({ displayMode: 'always', usageDisplayEnabled: true, percent: undefined }), false);
	});

	test('auto shows at or above the threshold', () => {
		const base = { displayMode: 'auto' as UsageRingDisplayMode, usageDisplayEnabled: true };
		assert.strictEqual(shouldShowUsageRing({ ...base, percent: undefined }), false);
		assert.strictEqual(shouldShowUsageRing({ ...base, percent: 49.9 }), false);
		assert.strictEqual(shouldShowUsageRing({ ...base, percent: 50 }), true);
		assert.strictEqual(shouldShowUsageRing({ ...base, percent: 87 }), true);
	});

	test('auto honors a custom threshold', () => {
		const base = { displayMode: 'auto' as UsageRingDisplayMode, usageDisplayEnabled: true, displayThreshold: 80 };
		assert.strictEqual(shouldShowUsageRing({ ...base, percent: 79 }), false);
		assert.strictEqual(shouldShowUsageRing({ ...base, percent: 80 }), true);
	});
});

suite('UsageRingIndicator (Cursor VV_ / context-utilization-ring)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('renders the binary-verified SVG geometry', () => {
		const indicator = new UsageRingIndicator();
		try {
			const svg = indicator.domNode;
			assert.strictEqual(svg.tagName.toLowerCase(), 'svg');
			assert.strictEqual(svg.getAttribute('viewBox'), '0 0 14 14');
			assert.strictEqual(svg.getAttribute('width'), '14');
			assert.strictEqual(svg.getAttribute('height'), '14');
			assert.strictEqual(svg.getAttribute('aria-hidden'), 'true');

			const group = svg.querySelector('g');
			assert.ok(group);
			assert.strictEqual(group!.getAttribute('transform'), 'rotate(-90 7 7)');

			const circles = svg.querySelectorAll('circle');
			assert.strictEqual(circles.length, 2);
			for (const circle of circles) {
				// Cursor: l = (s - kHs) / 2 - 1 = (14 - 2) / 2 - 1 = 5
				assert.strictEqual(circle.getAttribute('r'), '5');
				assert.strictEqual(circle.getAttribute('stroke-width'), '2');
				assert.strictEqual(circle.getAttribute('fill'), 'none');
			}
			// Cursor: background circle strokeOpacity XV_ = 0.28
			assert.strictEqual(circles[0].getAttribute('stroke-opacity'), '0.28');
		} finally {
			indicator.domNode.remove();
		}
	});

	test('setPercent draws the arc proportionally, clamped at 100', () => {
		const indicator = new UsageRingIndicator();
		try {
			const circumference = 2 * Math.PI * 5;
			const arc = indicator.domNode.querySelectorAll('circle')[1];

			indicator.setPercent(50);
			const [dash50, gap50] = arc.getAttribute('stroke-dasharray')!.split(' ').map(Number);
			assert.ok(Math.abs(dash50 - circumference / 2) < 1e-6);
			assert.ok(Math.abs(gap50 - circumference) < 1e-6);

			indicator.setPercent(150);
			const [dashClamped] = arc.getAttribute('stroke-dasharray')!.split(' ').map(Number);
			assert.ok(Math.abs(dashClamped - circumference) < 1e-6);

			indicator.setPercent(-10);
			const [dashZero] = arc.getAttribute('stroke-dasharray')!.split(' ').map(Number);
			assert.strictEqual(dashZero, 0);
		} finally {
			indicator.domNode.remove();
		}
	});
});

class TestChatEntitlementService extends Disposable {
	private readonly _onDidChangeQuotaRemaining = this._register(new Emitter<void>());
	readonly onDidChangeQuotaRemaining = this._onDidChangeQuotaRemaining.event;
	private readonly _onDidChangeQuotaExceeded = this._register(new Emitter<void>());
	readonly onDidChangeQuotaExceeded = this._onDidChangeQuotaExceeded.event;
	private readonly _onDidChangeEntitlement = this._register(new Emitter<void>());
	readonly onDidChangeEntitlement = this._onDidChangeEntitlement.event;
	private readonly _onDidChangeSentiment = this._register(new Emitter<void>());
	readonly onDidChangeSentiment = this._onDidChangeSentiment.event;

	constructor(
		public quotasValue: IChatEntitlementService['quotas'],
		public entitlementValue: ChatEntitlement,
	) {
		super();
	}

	get quotas(): IChatEntitlementService['quotas'] {
		return this.quotasValue;
	}

	get entitlement(): ChatEntitlement {
		return this.entitlementValue;
	}

	fireQuotaChanged(): void {
		this._onDidChangeQuotaRemaining.fire();
	}
}

suite('ChatUsageRingStatusBar', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let instantiationService: TestInstantiationService;
	let configurationService: TestConfigurationService;
	let entitlementService: TestChatEntitlementService;
	let anchor: HTMLElement;

	setup(() => {
		instantiationService = store.add(new TestInstantiationService());
		configurationService = new TestConfigurationService();
		instantiationService.stub(ICommandService, { executeCommand: () => Promise.resolve(undefined) });
		anchor = document.createElement('div');
		anchor.style.position = 'relative';
		document.body.appendChild(anchor);
		store.add(new Disposable(() => anchor.remove()));
	});

	function createBar(percentRemaining: number | undefined, mode: UsageRingDisplayMode = 'auto'): ChatUsageRingStatusBar {
		entitlementService = store.add(new TestChatEntitlementService(
			percentRemaining === undefined ? {} : { premiumChat: { percentRemaining, unlimited: false } },
			ChatEntitlement.Pro,
		));
		configurationService.setUserConfiguration(ChatConfiguration.UsageRingDisplayMode, mode);
		configurationService.setUserConfiguration(ChatConfiguration.UsageRingDisplayThreshold, 50);
		instantiationService.stub(IChatEntitlementService, entitlementService as unknown as IChatEntitlementService);
		instantiationService.stub(IConfigurationService, configurationService);
		const bar = store.add(instantiationService.createInstance(ChatUsageRingStatusBar));
		bar.setAnchorContainer(anchor);
		return bar;
	}

	test('hidden when no usage data is available', () => {
		const bar = createBar(undefined);
		assert.strictEqual(bar.domNode.style.display, 'none');
		assert.strictEqual(bar.layoutHeight, 0);
	});

	test('hidden below the display threshold, shown at/above it', () => {
		const below = createBar(51); // 49% used
		assert.strictEqual(below.domNode.style.display, 'none');

		const at = createBar(50); // 50% used
		assert.strictEqual(at.domNode.style.display, '');
		assert.strictEqual(at.layoutHeight, ChatUsageRingStatusBar.STRIP_HEIGHT);

		const above = createBar(10); // 90% used
		assert.strictEqual(above.domNode.style.display, '');
	});

	test('ring button carries the "Usage N%" tooltip and aria label', () => {
		const bar = createBar(25); // 75% used
		const button = bar.domNode.querySelector('.chat-usage-ring-button') as HTMLElement;
		assert.ok(button);
		assert.strictEqual(button.title, 'Usage 75%');
		assert.strictEqual(button.getAttribute('aria-label'), 'Usage 75%');
		assert.strictEqual(button.getAttribute('aria-expanded'), 'false');
		assert.ok(button.querySelector('svg.usage-ring'));
	});

	test('never mode hides the ring even above threshold', () => {
		const bar = createBar(1, 'never'); // 99% used
		assert.strictEqual(bar.domNode.style.display, 'none');
	});

	test('always mode shows the ring even below threshold', () => {
		const bar = createBar(90, 'always'); // 10% used
		assert.strictEqual(bar.domNode.style.display, '');
	});

	test('click toggles the floating panel; Escape closes it', () => {
		const bar = createBar(20); // 80% used
		const button = bar.domNode.querySelector('.chat-usage-ring-button') as HTMLElement;

		button.click();
		let panel = anchor.querySelector('.chat-usage-details-panel') as HTMLElement;
		assert.ok(panel, 'panel opens on click');
		assert.strictEqual(button.getAttribute('aria-expanded'), 'true');
		assert.ok(panel.querySelector('.chat-usage-details-header'), 'has header');
		assert.ok(panel.querySelector('.chat-usage-details-body'), 'has body');
		assert.ok(panel.querySelector('.chat-usage-details-footer-button'), 'has footer button');

		button.click();
		panel = anchor.querySelector('.chat-usage-details-panel') as HTMLElement;
		assert.strictEqual(panel, null, 'second click closes the panel');
		assert.strictEqual(button.getAttribute('aria-expanded'), 'false');

		button.click();
		panel = anchor.querySelector('.chat-usage-details-panel') as HTMLElement;
		assert.ok(panel, 'panel reopens');
		panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
		assert.strictEqual(anchor.querySelector('.chat-usage-details-panel'), null, 'Escape closes the panel');
	});

	test('panel header shows reset date when known', () => {
		const resetAt = Math.floor(new Date(2026, 9, 22, 18, 18).getTime() / 1000);
		entitlementService = store.add(new TestChatEntitlementService(
			{ premiumChat: { percentRemaining: 20, resetAt, unlimited: false } },
			ChatEntitlement.Pro,
		));
		configurationService.setUserConfiguration(ChatConfiguration.UsageRingDisplayMode, 'auto');
		instantiationService.stub(IChatEntitlementService, entitlementService as unknown as IChatEntitlementService);
		instantiationService.stub(IConfigurationService, configurationService);
		const bar = store.add(instantiationService.createInstance(ChatUsageRingStatusBar));
		bar.setAnchorContainer(anchor);

		(bar.domNode.querySelector('.chat-usage-ring-button') as HTMLElement).click();
		const title = anchor.querySelector('.chat-usage-details-title')!.textContent;
		assert.ok(title!.startsWith('Usage · Resets '), `unexpected title: ${title}`);
	});

	test('refreshes when quota changes', () => {
		const bar = createBar(60); // 40% used -> hidden
		assert.strictEqual(bar.domNode.style.display, 'none');
		entitlementService.quotasValue = { premiumChat: { percentRemaining: 30, unlimited: false } }; // 70% used
		entitlementService.fireQuotaChanged();
		assert.strictEqual(bar.domNode.style.display, '');
	});
});
