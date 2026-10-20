/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Usage-limit policy for the Agents window tray banner.
//
// Evidence (verbatim): `docs/rea/dig-loggedin-enum-2026-10-19.md` §1 — read-only
// CDP DOM enumeration of Cursor 3.25.9's "Cursor Agents" window:
//   `usage-limit-policy-tray` → `tray-banner` → `tray-banner-layout`/`tray-banner-content`:
//   title "Usage limit reached",
//   description "You've reached your limit. Responses may be slower. Upgrade for more usage.",
//   action button "Set new limit".
// The copy constants below are copied character-for-character from that capture
// (including the apostrophe in "You've"); do not reword them.

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';

/** Verbatim copy from the Cursor 3.25.9 agents-window capture (see file header). */
export const USAGE_LIMIT_TRAY_TITLE = 'Usage limit reached';
export const USAGE_LIMIT_TRAY_DESCRIPTION = "You've reached your limit. Responses may be slower. Upgrade for more usage.";
export const USAGE_LIMIT_TRAY_SET_LIMIT_LABEL = 'Set new limit';

/** data-component attributes from the same capture. */
export const USAGE_LIMIT_POLICY_TRAY_COMPONENT = 'usage-limit-policy-tray';
export const TRAY_BANNER_COMPONENT = 'tray-banner';
export const TRAY_BANNER_LAYOUT_COMPONENT = 'tray-banner-layout';
export const TRAY_BANNER_CONTENT_COMPONENT = 'tray-banner-content';
/** HONEST DIVERGENCE: the capture names only tray-banner-layout/tray-banner-content
    plus the "Set new limit" button; the actions-container/action attribute names
    below are our own consistent extension of the data-component convention. */
export const TRAY_BANNER_ACTIONS_COMPONENT = 'tray-banner-actions';
export const TRAY_BANNER_ACTION_COMPONENT = 'tray-banner-action';
export const TRAY_BANNER_TITLE_COMPONENT = 'tray-banner-title';
export const TRAY_BANNER_DESCRIPTION_COMPONENT = 'tray-banner-description';

/**
 * User setting holding the usage limit. Units are usage credits of the active
 * provider plan. `0` (default) means no policy is configured and the tray
 * never shows on its own.
 */
export const USAGE_LIMIT_POLICY_SETTING = 'chat.agentSessions.usageLimitPolicy.limit';

/**
 * Tracks whether the usage limit has been reached.
 *
 * Trigger sources:
 * - `reportUsage(usedCredits)`: engine-reported consumption, compared against
 *   the configured limit.
 * - `notifyLimitReached()`: the engine reported a usage-limit condition
 *   directly (e.g. a usage-limit error on the request path).
 * - Config change of {@link USAGE_LIMIT_POLICY_SETTING}: re-evaluates; raising
 *   the limit above current usage clears the reached state (tray hides).
 *
 * HONEST DIVERGENCE (2026-10-20): the sessions agent-host path does not yet
 * expose a sessions-side usage-limit event, so the engine hook is an explicit
 * call site (`notifyLimitReached`) rather than a subscription. Grep also found
 * no pre-existing usage/limit config in the agents-window code, so the setting
 * above is new — there was no DEV-AGENTS-WINDOW config to reuse.
 */
export class UsageLimitPolicy extends Disposable {

	private readonly _onDidChangeLimitReached = this._register(new Emitter<void>());
	readonly onDidChangeLimitReached: Event<void> = this._onDidChangeLimitReached.event;

	private _limitReached = false;
	private _lastReportedUsage = 0;

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(USAGE_LIMIT_POLICY_SETTING)) {
				this._reevaluate();
			}
		}));
	}

	/** The configured usage limit in credits; `0` = no policy. */
	get limit(): number {
		const value = this.configurationService.getValue<number>(USAGE_LIMIT_POLICY_SETTING);
		return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
	}

	get isLimitReached(): boolean {
		return this._limitReached;
	}

	/** Last usage figure the engine reported (credits). */
	get lastReportedUsage(): number {
		return this._lastReportedUsage;
	}

	/**
	 * Records engine-reported consumption. Shows the tray when it meets or
	 * exceeds the configured limit.
	 */
	reportUsage(usedCredits: number): void {
		if (typeof usedCredits !== 'number' || !Number.isFinite(usedCredits) || usedCredits < 0) {
			return;
		}
		this._lastReportedUsage = usedCredits;
		this._reevaluate();
	}

	/** The engine reported a usage-limit condition directly. Shows the tray. */
	notifyLimitReached(): void {
		this._setLimitReached(true);
	}

	/** The limit was raised or reset. Hides the tray. */
	clearLimitReached(): void {
		this._setLimitReached(false);
	}

	/** Persists a new limit (wired to the tray's "Set new limit" flow). */
	async setLimit(limit: number): Promise<void> {
		const sanitized = typeof limit === 'number' && Number.isFinite(limit) && limit >= 0 ? limit : 0;
		await this.configurationService.updateValue(USAGE_LIMIT_POLICY_SETTING, sanitized, ConfigurationTarget.USER);
		this._reevaluate();
	}

	private _reevaluate(): void {
		const limit = this.limit;
		if (limit > 0 && this._lastReportedUsage >= limit) {
			this._setLimitReached(true);
		} else if (this._limitReached && limit > this._lastReportedUsage) {
			// Limit raised above current usage (or removed) → hide the tray.
			this._setLimitReached(false);
		}
	}

	private _setLimitReached(value: boolean): void {
		if (this._limitReached === value) {
			return;
		}
		this._limitReached = value;
		this._onDidChangeLimitReached.fire();
	}
}
