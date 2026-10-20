/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/chatUsageRingStatusBar.css';
import * as dom from '../../../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../../../base/browser/keyboardEvent.js';
import { KeyCode } from '../../../../../../base/common/keyCodes.js';
import { safeIntl } from '../../../../../../base/common/date.js';
import { Disposable, DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { localize } from '../../../../../../nls.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { ChatConfiguration } from '../../../common/constants.js';
import { getChatPlanName, getQuotaReset, getQuotaUsage, IChatEntitlementService, QuotaUsageKind } from '../../../../../../workbench/services/chat/common/chatEntitlementService.js';

// IDE-CODE: Usage ring in the chat status bar (monthly usage), mirroring Cursor.
//
// REA evidence (cursor 3.25.9, out/vs/workbench/workbench.glass.main.js):
// - Module "glass-chat-status-bar-usage-metric.react.js": a ghost button
//   (`data-glass-chat-status-bar-usage`) whose aria-label AND title are
//   `Usage ${Math.round(p)}%` (function HG_), wrapped in a top-placed tooltip
//   (Ts). The ring itself is VV_({percent, variant:"prominent"}) from
//   "context-utilization-ring.react.js": an SVG 14x14 (KV_=14), strokeWidth 2
//   (kHs=2), background circle strokeOpacity 0.28 (XV_), foreground arc with
//   stroke-dasharray `${pct/100*C} ${C}` rotated -90deg about the center,
//   aria-hidden. "prominent" clamps the arc at 100 (zV_(n,100)).
// - The metric's percent is J4l(...): `t>0 && t<1 ? 1 : Math.round(clamp(t,0,100))`.
// - Visibility ("composerUsageStatusBarUtils", function _8g):
//     displayMode "never" -> false
//     usageDisplayEnabled === false -> false
//     displayMode "always" -> planUsage !== null
//     else (effectivePercent ?? 0) >= (displayThreshold ?? 50)
//   where displayThreshold comes from the server (aiserver.v1.
//   GetCurrentPeriodUsageResponse.display_threshold, field 5) and defaults to 50.
// - Click: handleUsageCardOpen = () => trayController.toggle("usage-details")
//   (Wre); the tray registers presentation {anchor:()=>null, autoOpen:false,
//   trigger:"external", type:"anchored"} — i.e. a floating panel, not a page.
// - Escape: trayController.handleEscape, wired as handleManagedTrayEscape (Hfe).
// - Panel "glass-usage-details-tray.react.js" (PBT/RBT):
//     header: `Usage · Resets ${xBT(billingCycleEnd)}` where xBT =
//       new Date(t).toLocaleDateString(undefined,{month:"short",day:"numeric"}),
//       falling back to "Usage" when no reset date is known;
//     body: "Included in {planName} Plan" (or "Included"), a usage bar, and
//       `$used / $limit` (aDe formats dollars);
//     footer: a "View Plan and Limits" button whose handler (rf) opens
//       `${settingsUrl}/usage` externally.
// - NO command ID was found in the binary for the ring or the tray: opening is
//   an internal tray-controller toggle, not a registered command.
//
// DIVERGENCES (this fork has no Cursor cloud billing):
// - Data source is a LOCAL estimate from IChatEntitlementService: the
//   premium-chat quota's usedPercentage (100 - percentRemaining via
//   getQuotaUsage), the reset date via getQuotaReset, and the plan label via
//   getChatPlanName. This is NOT Cursor's aiserver GetCurrentPeriodUsage API
//   (no cent-denominated planUsage/spendLimitUsage, no auto/API bucket split).
// - No dollar figures exist locally, so the panel shows a percent-based
//   readout ("N% used") instead of Cursor's `$used / $limit`.
// - "View Plan and Limits" opens the in-product chat settings
//   (workbench.action.openSettings) instead of cursor.com/usage.
// - usageDisplayEnabled is always true (no server flag); displayMode "never"
//   in settings is the supported off-switch.

/**
 * Default display threshold in percent. Evidence: cursor 3.25.9 normalizes the
 * server payload with `displayThreshold: t.displayThreshold ?? 50` and the
 * visibility check uses `i.displayThreshold ?? 50`.
 */
export const DEFAULT_USAGE_RING_DISPLAY_THRESHOLD = 50;

/** Mirrors Cursor's usage-summary displayMode setting (RPt(Pfn, "auto")). */
export type UsageRingDisplayMode = 'auto' | 'always' | 'never';

export interface IUsageRingData {
	/** Monthly usage as a 0-100 percent. */
	readonly percent: number;
	/** Localised plan display name, e.g. "Copilot Pro". */
	readonly planName: string;
	/** Billing-cycle reset timestamp in ms, when known. */
	readonly resetTime?: number;
}

/**
 * Cursor's J4l, verbatim: `t>0 && t<1 ? 1 : Math.round(Math.min(Math.max(t,0),100))`.
 * Tiny non-zero percents render as 1% on the ring, everything else is rounded
 * and clamped to 0-100. (NaN propagates as NaN, exactly like Cursor; callers
 * only pass finite values — see readData.)
 */
export function formatUsageRingPercent(percent: number): number {
	if (percent > 0 && percent < 1) {
		return 1;
	}
	return Math.round(Math.min(Math.max(percent, 0), 100));
}

/**
 * Cursor's HG_ with the "Usage " prefix: the exact tooltip/aria-label text of
 * the ring button ("Usage N%").
 */
export function formatUsageRingTooltip(percent: number): string {
	return localize('usageRingTooltip', "Usage {0}%", Math.round(percent));
}

/**
 * Cursor's N90: percentage from used/limit clamped to 100, falling back to the
 * precomputed usedPercentage when there is no limit.
 */
export function computeUsagePercent(used: number, limit: number, usedPercentage?: number): number | undefined {
	if (limit > 0) {
		return Math.min((used / limit) * 100, 100);
	}
	return usedPercentage;
}

/**
 * Cursor's _8g visibility rule for the usage ring.
 */
export function shouldShowUsageRing(options: {
	readonly displayMode: UsageRingDisplayMode;
	readonly usageDisplayEnabled: boolean;
	readonly percent: number | undefined;
	readonly displayThreshold?: number;
}): boolean {
	if (options.displayMode === 'never') {
		return false;
	}
	if (options.usageDisplayEnabled === false) {
		return false;
	}
	if (options.displayMode === 'always') {
		return options.percent !== undefined;
	}
	if (options.percent === undefined) {
		return false;
	}
	const threshold = options.displayThreshold ?? DEFAULT_USAGE_RING_DISPLAY_THRESHOLD;
	return options.percent >= threshold;
}

/**
 * SVG usage ring matching Cursor's context-utilization-ring.react.js:
 * 14x14, 2px stroke, 0.28-opacity background circle, progress arc drawn from
 * the top via a -90deg rotation, aria-hidden.
 */
export class UsageRingIndicator {

	readonly domNode: SVGSVGElement;

	private readonly progressCircle: SVGCircleElement;
	private readonly circumference: number;

	private static readonly SIZE = 14;
	private static readonly STROKE_WIDTH = 2;
	private static readonly BACKGROUND_OPACITY = 0.28;

	constructor() {
		const size = UsageRingIndicator.SIZE;
		const strokeWidth = UsageRingIndicator.STROKE_WIDTH;
		// Cursor: l = (s - kHs) / 2 - 1
		const radius = (size - strokeWidth) / 2 - 1;
		this.circumference = 2 * Math.PI * radius;
		const center = size / 2;

		const svgNS = 'http://www.w3.org/2000/svg';
		this.domNode = document.createElementNS(svgNS, 'svg');
		this.domNode.setAttribute('viewBox', `0 0 ${size} ${size}`);
		this.domNode.setAttribute('width', String(size));
		this.domNode.setAttribute('height', String(size));
		this.domNode.setAttribute('aria-hidden', 'true');
		this.domNode.classList.add('usage-ring');

		const group = document.createElementNS(svgNS, 'g');
		group.setAttribute('transform', `rotate(-90 ${center} ${center})`);
		this.domNode.appendChild(group);

		const bgCircle = document.createElementNS(svgNS, 'circle');
		bgCircle.setAttribute('cx', String(center));
		bgCircle.setAttribute('cy', String(center));
		bgCircle.setAttribute('r', String(radius));
		bgCircle.setAttribute('fill', 'none');
		bgCircle.setAttribute('stroke-width', String(strokeWidth));
		bgCircle.setAttribute('stroke-opacity', String(UsageRingIndicator.BACKGROUND_OPACITY));
		bgCircle.classList.add('usage-ring-bg');
		group.appendChild(bgCircle);

		this.progressCircle = document.createElementNS(svgNS, 'circle');
		this.progressCircle.setAttribute('cx', String(center));
		this.progressCircle.setAttribute('cy', String(center));
		this.progressCircle.setAttribute('r', String(radius));
		this.progressCircle.setAttribute('fill', 'none');
		this.progressCircle.setAttribute('stroke-width', String(strokeWidth));
		this.progressCircle.setAttribute('stroke-dasharray', `0 ${this.circumference}`);
		this.progressCircle.classList.add('usage-ring-arc');
		group.appendChild(this.progressCircle);
	}

	/**
	 * Updates the ring fill. Cursor's "prominent" variant clamps at 100.
	 */
	setPercent(percent: number): void {
		const clamped = Number.isFinite(percent) ? Math.min(Math.max(percent, 0), 100) : 0;
		const arc = (clamped / 100) * this.circumference;
		this.progressCircle.setAttribute('stroke-dasharray', `${arc} ${this.circumference}`);
	}
}

/**
 * Bottom strip of the chat surface (the "chat status bar") holding the monthly
 * usage ring on its trailing edge. Clicking the ring toggles a floating usage
 * details panel anchored over the conversation; Escape closes it.
 */
export class ChatUsageRingStatusBar extends Disposable {

	/** Fixed strip height. Keep in sync with media/chatUsageRingStatusBar.css. */
	static readonly STRIP_HEIGHT = 28;

	readonly domNode: HTMLElement;

	private readonly ringButton: HTMLElement;
	private readonly ring: UsageRingIndicator;

	private panel: HTMLElement | undefined;
	private readonly panelDisposables = this._register(new DisposableStore());

	private readonly _onDidChangeVisibility = this._register(new Emitter<void>());
	/** Fires when the strip shows or hides so the host can re-layout. */
	readonly onDidChangeVisibility: Event<void> = this._onDidChangeVisibility.event;

	private currentData: IUsageRingData | undefined;
	private anchorContainer: HTMLElement | undefined;

	private readonly resetDateFormatter = safeIntl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });

	constructor(
		@IChatEntitlementService private readonly chatEntitlementService: IChatEntitlementService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();

		this.domNode = dom.$('.chat-usage-ring-status-bar');
		this.domNode.style.display = 'none';

		const slot = this.domNode.appendChild(dom.$('.chat-usage-ring-slot'));
		this.ring = new UsageRingIndicator();
		this.ringButton = slot.appendChild(dom.$('.chat-usage-ring-button', {
			tabindex: '0',
			role: 'button',
			'aria-expanded': 'false',
		}));
		this.ringButton.appendChild(this.ring.domNode);

		this._register(dom.addDisposableListener(this.ringButton, dom.EventType.CLICK, e => {
			e.stopPropagation();
			this.togglePanel();
		}));
		this._register(dom.addDisposableListener(this.ringButton, dom.EventType.KEY_DOWN, e => {
			const keyboardEvent = new StandardKeyboardEvent(e);
			if (keyboardEvent.equals(KeyCode.Enter) || keyboardEvent.equals(KeyCode.Space)) {
				e.preventDefault();
				this.togglePanel();
			}
		}));

		this._register(this.chatEntitlementService.onDidChangeQuotaRemaining(() => this.refresh()));
		this._register(this.chatEntitlementService.onDidChangeQuotaExceeded(() => this.refresh()));
		this._register(this.chatEntitlementService.onDidChangeEntitlement(() => this.refresh()));
		this._register(this.chatEntitlementService.onDidChangeSentiment(() => this.refresh()));
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(ChatConfiguration.UsageRingDisplayMode)
				|| e.affectsConfiguration(ChatConfiguration.UsageRingDisplayThreshold)) {
				this.refresh();
			}
		}));

		this.refresh();
	}

	/**
	 * The chat widget container the floating panel is absolutely positioned in.
	 */
	setAnchorContainer(container: HTMLElement): void {
		this.anchorContainer = container;
	}

	/**
	 * Height this strip consumes in the parent flex layout (0 when hidden).
	 */
	get layoutHeight(): number {
		return this.domNode.style.display === 'none' ? 0 : ChatUsageRingStatusBar.STRIP_HEIGHT;
	}

	private readData(): IUsageRingData | undefined {
		const quotas = this.chatEntitlementService.quotas;
		const quota = quotas.premiumChat;
		if (!quota) {
			return undefined;
		}
		const usage = getQuotaUsage(quota);
		if (!usage || usage.kind !== QuotaUsageKind.Percentage || !Number.isFinite(usage.usedPercentage)) {
			return undefined;
		}
		const reset = getQuotaReset(quota, quotas);
		return {
			percent: usage.usedPercentage,
			planName: getChatPlanName(this.chatEntitlementService.entitlement),
			resetTime: reset?.date.getTime(),
		};
	}

	private refresh(): void {
		this.currentData = this.readData();
		const displayMode = this.configurationService.getValue<UsageRingDisplayMode>(ChatConfiguration.UsageRingDisplayMode) ?? 'auto';
		const displayThreshold = this.configurationService.getValue<number>(ChatConfiguration.UsageRingDisplayThreshold)
			?? DEFAULT_USAGE_RING_DISPLAY_THRESHOLD;

		const show = shouldShowUsageRing({
			displayMode,
			usageDisplayEnabled: true,
			percent: this.currentData?.percent,
			displayThreshold,
		});

		if (!show || !this.currentData) {
			this.closePanel();
			if (this.domNode.style.display !== 'none') {
				this.domNode.style.display = 'none';
				this._onDidChangeVisibility.fire();
			}
			return;
		}

		this.ring.setPercent(formatUsageRingPercent(this.currentData.percent));
		const tooltip = formatUsageRingTooltip(this.currentData.percent);
		this.ringButton.title = tooltip;
		this.ringButton.setAttribute('aria-label', tooltip);
		if (this.domNode.style.display === 'none') {
			this.domNode.style.display = '';
			this._onDidChangeVisibility.fire();
		}

		if (this.panel) {
			this.updatePanelData(this.panel, this.currentData);
		}
	}

	private togglePanel(): void {
		if (this.panel) {
			this.closePanel();
		} else {
			this.openPanel();
		}
	}

	private openPanel(): void {
		const container = this.anchorContainer;
		const data = this.currentData;
		if (!container || !data) {
			return;
		}
		this.closePanel();

		const panel = dom.$('.chat-usage-details-panel');
		panel.setAttribute('tabindex', '-1');
		panel.setAttribute('role', 'dialog');
		panel.setAttribute('aria-label', localize('usageDetailsPanel', "Usage details"));

		const header = panel.appendChild(dom.$('.chat-usage-details-header'));
		header.appendChild(dom.$('.chat-usage-details-title'));
		const body = panel.appendChild(dom.$('.chat-usage-details-body'));
		body.appendChild(dom.$('.chat-usage-details-plan'));
		const bar = body.appendChild(dom.$('.chat-usage-details-bar'));
		bar.appendChild(dom.$('.chat-usage-details-bar-fill'));
		body.appendChild(dom.$('.chat-usage-details-readout'));

		const footer = panel.appendChild(dom.$('.chat-usage-details-footer'));
		const button = footer.appendChild(dom.$('button.chat-usage-details-footer-button', undefined,
			localize('viewPlanAndLimits', "View Plan and Limits")));
		// DIVERGENCE: Cursor opens `${settingsUrl}/usage` externally. The
		// in-product equivalent here is the chat settings page.
		this.panelDisposables.add(dom.addDisposableListener(button, dom.EventType.CLICK, () => {
			this.commandService.executeCommand('workbench.action.openSettings', 'chat');
		}));

		this.updatePanelData(panel, data);
		container.appendChild(panel);
		this.panel = panel;
		this.ringButton.setAttribute('aria-expanded', 'true');

		// Cursor focuses the tray root on open (tabIndex -1, preventScroll).
		panel.focus({ preventScroll: true });

		// Escape closes the panel, mirroring trayController.handleEscape.
		this.panelDisposables.add(dom.addDisposableListener(panel, dom.EventType.KEY_DOWN, e => {
			if (new StandardKeyboardEvent(e).equals(KeyCode.Escape)) {
				e.stopPropagation();
				this.closePanel();
				this.ringButton.focus();
			}
		}));
		// Also close on Escape when focus is elsewhere in the window (e.g. the
		// chat input). Bubble phase so other Escape handlers still run.
		this.panelDisposables.add(dom.addDisposableListener(
			dom.getWindow(container).document, dom.EventType.KEY_DOWN, e => {
				if (new StandardKeyboardEvent(e).equals(KeyCode.Escape)) {
					this.closePanel();
				}
			}));
	}

	private closePanel(): void {
		this.panelDisposables.clear();
		this.panel?.remove();
		this.panel = undefined;
		this.ringButton.setAttribute('aria-expanded', 'false');
	}

	private updatePanelData(panel: HTMLElement, data: IUsageRingData): void {
		const title = panel.querySelector('.chat-usage-details-title');
		if (title) {
			title.textContent = data.resetTime !== undefined
				? localize('usageDetailsTitle', "Usage · Resets {0}", this.resetDateFormatter.value.format(new Date(data.resetTime)))
				: localize('usageDetailsTitleNoReset', "Usage");
		}

		const plan = panel.querySelector('.chat-usage-details-plan');
		if (plan) {
			plan.textContent = data.planName
				? localize('usageDetailsIncludedInPlan', "Included in {0} Plan", data.planName)
				: localize('usageDetailsIncluded', "Included");
		}

		const fill = panel.querySelector('.chat-usage-details-bar-fill') as HTMLElement | null;
		if (fill) {
			fill.style.width = `${Math.min(Math.max(data.percent, 0), 100)}%`;
		}

		// DIVERGENCE: Cursor shows `$used / $limit` (dollar billing). This fork
		// has no dollar figures, so the readout is percent-based.
		const readout = panel.querySelector('.chat-usage-details-readout');
		if (readout) {
			readout.textContent = localize('usageDetailsReadout', "{0}% used", Math.round(data.percent));
		}
	}
}
