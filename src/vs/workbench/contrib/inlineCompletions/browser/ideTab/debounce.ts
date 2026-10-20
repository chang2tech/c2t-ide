/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Tab debounce service — moved verbatim from
// extensions/ide-agent/src/tab/debounce.ts. Pure logic, no vscode imports.
// (Cursor analog: `cppDebouncingService`.)

/**
 * Port of Cursor's `cppDebouncingService` (cppDebouncingService.js).
 *
 * Two-stage debounce:
 *  - client stage: trailing-edge schedule of `clientDebounceMs` (default 25ms)
 *    before a trigger actually fires a request.
 *  - global stage: request coalescing — a new request cancels any request that
 *    started within `totalDebounceMs` (default 60ms) of now, returned as
 *    `requestIdsToCancel` so the caller can abort their AbortControllers.
 * Both durations are server-overridable
 * (`clientDebounceDurationMillis` / `globalDebounceDurationMillis`).
 */

export interface DebounceDurations {
	clientMs: number;
	totalMs: number;
}

export const DEFAULT_DEBOUNCE: DebounceDurations = { clientMs: 25, totalMs: 60 };

interface HistoryEntry {
	requestId: string;
	at: number;
}

export class TabDebounceService {
	private history: HistoryEntry[] = [];
	private timers = new Map<string, ReturnType<typeof setTimeout>>();
	/** First-schedule time per key — starvation guard for continuous rescheduling. */
	private firstScheduled = new Map<string, number>();

	constructor(
		private durations: DebounceDurations = { ...DEFAULT_DEBOUNCE },
		/** Prune history entries older than this (evictionDuration). */
		private evictionMs = 10_000,
		/**
		 * P2: max time a key may be continuously rescheduled before the pending
		 * callback is forced to fire. Prevents starvation under rapid typing.
		 */
		private maxWaitMs = 5_000,
	) { }

	setDurations(d: Partial<DebounceDurations>): void {
		this.durations = { ...this.durations, ...d };
	}

	getDurations(): DebounceDurations {
		return { ...this.durations };
	}

	/**
	 * Trailing-edge debounce for a trigger key (e.g. one per editor).
	 * Rapid successive calls collapse into a single `fn` invocation
	 * `clientMs` after the last call.
	 */
	schedule(key: string, fn: () => void, now: number = Date.now()): void {
		const existing = this.timers.get(key);
		if (existing) {
			clearTimeout(existing);
			// P2 starvation guard: a key rescheduled without pause for maxWaitMs
			// fires immediately instead of being deferred forever.
			const first = this.firstScheduled.get(key);
			if (first !== undefined && now - first >= this.maxWaitMs) {
				this.timers.delete(key);
				this.firstScheduled.delete(key);
				fn();
				return;
			}
		} else {
			this.firstScheduled.set(key, now);
		}
		this.timers.set(
			key,
			setTimeout(() => {
				this.timers.delete(key);
				this.firstScheduled.delete(key);
				fn();
			}, this.durations.clientMs),
		);
	}

	cancelScheduled(key: string): void {
		const existing = this.timers.get(key);
		if (existing) {
			clearTimeout(existing);
			this.timers.delete(key);
		}
		this.firstScheduled.delete(key);
	}

	/**
	 * Register a new request and compute which in-flight requests it coalesces
	 * (cancels): any request started within `totalMs` of `now`, excluding itself.
	 */
	runRequest(requestId: string, now: number = Date.now()): { requestIdsToCancel: string[] } {
		this.evict(now);
		const requestIdsToCancel = this.history
			.filter((e) => e.requestId !== requestId && now - e.at < this.durations.totalMs)
			.map((e) => e.requestId);
		this.history.push({ requestId, at: now });
		return { requestIdsToCancel };
	}

	/** Remove a finished request from history so it is never "cancelled" later. */
	completeRequest(requestId: string): void {
		this.history = this.history.filter((e) => e.requestId !== requestId);
	}

	private evict(now: number): void {
		const cutoff = now - this.evictionMs;
		this.history = this.history.filter((e) => e.at >= cutoff);
	}

	/** For tests/inspection. */
	historySize(): number {
		return this.history.length;
	}
}
