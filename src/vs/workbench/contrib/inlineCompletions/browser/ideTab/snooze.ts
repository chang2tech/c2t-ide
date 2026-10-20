/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Snooze management — moved verbatim from
// extensions/ide-agent/src/tab/snooze.ts. Pure logic; storage is injected so
// the workbench IStorageService adapter (in tabContribution.ts) can be swapped
// for an in-memory map in tests.

/**
 * Snooze management for Tab completion.
 * Port of Cursor's `editor.cpp.snooze` (quick-pick 1m–3h) +
 * `maybeReenableCppIfSnoozed()` auto re-enable on expiry.
 *
 * Storage is injected so the workbench storage adapter can be swapped for an
 * in-memory map in tests. The timer handle lets tests fast-forward expiry.
 */

export interface SnoozeStorage {
	get(key: string): number | undefined;
	set(key: string, value: number | undefined): void;
}

export const SNOOZE_UNTIL_KEY = 'ide.tab.snoozedUntil';

/**
 * IDE-CODE: port of Cursor's `formatSnoozedTimeRemaining` (binary evidence:
 * workbench.desktop.main.js, `r>0?`${r}h ${s}m`:`${s}m ${o}s``). Cursor calls
 * it with the snoozed-at timestamp plus the stored snooze duration; we store
 * `snoozedUntil` directly, which is the same arithmetic (`until - now`).
 * Pure — safe for unit tests.
 */
export function formatSnoozedTimeRemaining(until: number, now: number = Date.now()): string {
	const ms = Math.max(0, until - now);
	const h = Math.floor(ms / (1000 * 60 * 60));
	const m = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
	const s = Math.floor((ms % (1000 * 60)) / 1000);
	return h > 0 ? `${h}h ${m}m` : `${m}m ${s}s`;
}

export class SnoozeManager {
	private timer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		private storage: SnoozeStorage,
		private onExpire: () => void = () => { },
	) { }

	/** True while a snooze is active (and not yet expired). */
	isSnoozed(now: number = Date.now()): boolean {
		const until = this.storage.get(SNOOZE_UNTIL_KEY);
		if (until === undefined) return false;
		if (until <= now) {
			this.clear(now);
			return false;
		}
		return true;
	}

	/** Start a snooze for `durationMs`; auto re-enables on expiry. */
	snooze(durationMs: number, now: number = Date.now()): void {
		this.cancelTimer();
		const until = now + durationMs;
		this.storage.set(SNOOZE_UNTIL_KEY, until);
		this.timer = setTimeout(() => {
			this.clear();
			this.onExpire();
		}, durationMs);
		// Don't hold the process / window open for a 3h snooze.
		if (typeof this.timer === 'object' && 'unref' in this.timer) {
			(this.timer as unknown as { unref(): void }).unref();
		}
	}

	unsnooze(): void {
		this.clear();
	}

	/**
	 * Re-check expiry (call on activation — `maybeReenableCppIfSnoozed`).
	 * P2: fires onExpire when clearing an already-expired snooze so the status
	 * bar / notification stay consistent even when the timer never ran (e.g.
	 * the window reloaded mid-snooze).
	 */
	maybeReenable(now: number = Date.now()): boolean {
		const until = this.storage.get(SNOOZE_UNTIL_KEY);
		if (until !== undefined && until <= now) {
			this.clear(now);
			this.onExpire();
			return true;
		}
		if (until !== undefined && until > now) this.armTimer(until - now);
		return false;
	}

	snoozedUntil(): number | undefined {
		return this.storage.get(SNOOZE_UNTIL_KEY);
	}

	private armTimer(ms: number): void {
		this.cancelTimer();
		this.timer = setTimeout(() => {
			this.clear();
			this.onExpire();
		}, ms);
		if (typeof this.timer === 'object' && 'unref' in this.timer) {
			(this.timer as unknown as { unref(): void }).unref();
		}
	}

	private cancelTimer(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
	}

	private clear(_now?: number): void {
		this.cancelTimer();
		this.storage.set(SNOOZE_UNTIL_KEY, undefined);
	}
}
