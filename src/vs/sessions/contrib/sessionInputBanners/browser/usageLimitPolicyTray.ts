/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/usageLimitPolicyTray.css';
import * as dom from '../../../../base/browser/dom.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import {
	TRAY_BANNER_ACTION_COMPONENT,
	TRAY_BANNER_ACTIONS_COMPONENT,
	TRAY_BANNER_COMPONENT,
	TRAY_BANNER_CONTENT_COMPONENT,
	TRAY_BANNER_DESCRIPTION_COMPONENT,
	TRAY_BANNER_LAYOUT_COMPONENT,
	TRAY_BANNER_TITLE_COMPONENT,
	UsageLimitPolicy,
	USAGE_LIMIT_POLICY_TRAY_COMPONENT,
	USAGE_LIMIT_TRAY_DESCRIPTION,
	USAGE_LIMIT_TRAY_SET_LIMIT_LABEL,
	USAGE_LIMIT_TRAY_TITLE,
} from './usageLimitPolicy.js';

/**
 * The usage-limit policy tray rendered directly above the Agents window's
 * prompt input (NOT a generic toast).
 *
 * Evidence: `docs/rea/dig-loggedin-enum-2026-10-19.md` §1 — Cursor 3.25.9's
 * "Cursor Agents" window renders
 * `[data-component=usage-limit-policy-tray] > [data-component=tray-banner]`
 * with title "Usage limit reached", description
 * "You've reached your limit. Responses may be slower. Upgrade for more usage."
 * and a "Set new limit" action button. Title/description/button copy is
 * verbatim (see usageLimitPolicy.ts); do not reword.
 *
 * Behavior: hidden unless the {@link UsageLimitPolicy} reports the limit is
 * reached. "Set new limit" opens a QuickPick to set a new limit, which is
 * persisted to the usage/limit config (`chat.agentSessions.usageLimitPolicy.limit`).
 */
export class UsageLimitPolicyTray extends Disposable {

	readonly domNode: HTMLElement;

	private readonly _setLimitButton: HTMLButtonElement;

	constructor(
		private readonly _policy: UsageLimitPolicy,
		@IQuickInputService private readonly _quickInputService: IQuickInputService,
	) {
		super();

		this.domNode = dom.$('div.usage-limit-policy-tray');
		this.domNode.setAttribute('data-component', USAGE_LIMIT_POLICY_TRAY_COMPONENT);

		const banner = dom.append(this.domNode, dom.$('div.tray-banner'));
		banner.setAttribute('data-component', TRAY_BANNER_COMPONENT);
		banner.setAttribute('role', 'status');

		const layout = dom.append(banner, dom.$('div.tray-banner-layout'));
		layout.setAttribute('data-component', TRAY_BANNER_LAYOUT_COMPONENT);

		const content = dom.append(layout, dom.$('div.tray-banner-content'));
		content.setAttribute('data-component', TRAY_BANNER_CONTENT_COMPONENT);

		const title = dom.append(content, dom.$('div.tray-banner-title'));
		title.setAttribute('data-component', TRAY_BANNER_TITLE_COMPONENT);
		title.textContent = USAGE_LIMIT_TRAY_TITLE;

		const description = dom.append(content, dom.$('div.tray-banner-description'));
		description.setAttribute('data-component', TRAY_BANNER_DESCRIPTION_COMPONENT);
		description.textContent = USAGE_LIMIT_TRAY_DESCRIPTION;

		const actions = dom.append(layout, dom.$('div.tray-banner-actions'));
		actions.setAttribute('data-component', TRAY_BANNER_ACTIONS_COMPONENT);

		this._setLimitButton = dom.append(actions, dom.$('button.tray-banner-action')) as HTMLButtonElement;
		this._setLimitButton.type = 'button';
		this._setLimitButton.setAttribute('data-component', TRAY_BANNER_ACTION_COMPONENT);
		this._setLimitButton.textContent = USAGE_LIMIT_TRAY_SET_LIMIT_LABEL;
		this._setLimitButton.setAttribute('aria-label', USAGE_LIMIT_TRAY_SET_LIMIT_LABEL);
		this._register(dom.addDisposableListener(this._setLimitButton, dom.EventType.CLICK, () => {
			void this._onSetNewLimit();
		}));

		this._register(this._policy.onDidChangeLimitReached(() => this._updateVisibility()));
		this._updateVisibility();
	}

	private _updateVisibility(): void {
		const reached = this._policy.isLimitReached;
		this.domNode.classList.toggle('visible', reached);
		this.domNode.toggleAttribute('hidden', !reached);
	}

	private async _onSetNewLimit(): Promise<void> {
		const current = this._policy.limit;
		interface ILimitPickItem extends IQuickPickItem { readonly id: 'custom' | 'remove'; }
		const items: ILimitPickItem[] = [
			{
				id: 'custom',
				label: localize('usageLimitTray.setCustomLimit', "Set custom limit…"),
				description: current > 0
					? localize('usageLimitTray.currentLimit', "Current: {0}", current)
					: localize('usageLimitTray.noLimit', "No limit set"),
			},
		];
		if (current > 0) {
			items.push({
				id: 'remove',
				label: localize('usageLimitTray.removeLimit', "Remove limit"),
			});
		}
		const choice = await this._quickInputService.pick(items, {
			placeHolder: localize('usageLimitTray.pickPlaceholder', "Set usage limit"),
		});
		if (!choice) {
			return;
		}
		if (choice.id === 'remove') {
			await this._policy.setLimit(0);
			return;
		}
		const raw = await this._quickInputService.input({
			prompt: localize('usageLimitTray.inputPrompt', "New usage limit (credits)"),
			value: current > 0 ? String(current) : '',
			validateInput: async value => {
				const n = Number(value.trim());
				return value.trim() !== '' && Number.isFinite(n) && n >= 0
					? null
					: localize('usageLimitTray.invalidLimit', "Enter a non-negative number");
			},
		});
		if (raw === undefined) {
			return;
		}
		await this._policy.setLimit(Number(raw.trim()));
	}
}
