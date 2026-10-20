/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Tab telemetry + fate tracking.
//
// Node-free by design: this file lives in browser/ (nodeIntegration: false),
// so it never touches `fs`/`path`. Events go through the standard telemetry
// pipeline (ITelemetryService.publicLog) when the workbench service is wired,
// otherwise they are kept in a bounded in-memory ring buffer. Telemetry never
// throws — logging must not break typing.

/**
 * Telemetry + fate tracking + AI code tracking for Tab.
 *
 * - FateTracker: exactly-once fate per requestId (ACCEPT | PARTIAL_ACCEPT | REJECT),
 *   mirroring Cursor's `recordCppFate(requestId, voi.*, fileExtension, performance.now())`.
 * - ClearedSuggestionTracker: `numberOfClearedSuggestionsSinceLastAccept` counter;
 *   when it reaches the server-configured `maxNumberOfClearedSuggestionsSinceLastAccept`,
 *   suggestions are suppressed (rejection throttling) until an accept resets it.
 * - TabTelemetry: session events + `storeGeneratedContent(..., {source: TAB})`
 *   (aiCodeTrackingService analog) via the telemetry pipeline. Gated by a
 *   privacy flag (`canWeTrackTelem` analog) and never throws — logging must
 *   not break typing.
 */

import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { TabFate } from './types.js';

export class FateTracker {
	private recorded = new Map<string, { fate: TabFate; at: number; fileExtension: string }>();

	/**
	 * Record the fate of a request. Returns false if a fate was already recorded
	 * for this requestId (exactly-once semantics).
	 */
	record(requestId: string, fate: TabFate, fileExtension: string, now: number = Date.now()): boolean {
		if (this.recorded.has(requestId)) return false;
		// P2 (QA-FILE-06): bound the map — long editing sessions accumulated
		// thousands of entries with no eviction. Cap 1000 (oldest first; Map is
		// insertion-ordered) + sweep entries older than 30 minutes.
		this.evictStale(now);
		while (this.recorded.size >= FATE_MAX_ENTRIES) {
			const oldest = this.recorded.keys().next();
			if (oldest.done) break;
			this.recorded.delete(oldest.value);
		}
		this.recorded.set(requestId, { fate, at: now, fileExtension });
		return true;
	}

	/** Remove entries older than the TTL. Insertion-ordered: stops at the first fresh entry. */
	private evictStale(now: number): void {
		for (const [id, v] of this.recorded) {
			if (now - v.at > FATE_ENTRY_TTL_MS) this.recorded.delete(id);
			else break;
		}
	}

	get(requestId: string): TabFate | undefined {
		return this.recorded.get(requestId)?.fate;
	}

	size(): number {
		return this.recorded.size();
	}
}

/** Max fate entries kept (LRU by insertion order). */
const FATE_MAX_ENTRIES = 1000;
/** Fate entries older than this are swept on the next record. */
const FATE_ENTRY_TTL_MS = 30 * 60_000;

/** Rejection throttling: repeated clears suppress future suggestions. */
export class ClearedSuggestionTracker {
	private clearedSinceAccept = 0;

	constructor(private maxCleared: number = 5) { }

	setMax(max: number): void {
		this.maxCleared = max;
	}

	/** Call on clear/reject/type-away. Returns true while suggestions may continue. */
	increment(): boolean {
		this.clearedSinceAccept += 1;
		return !this.shouldSuppress();
	}

	shouldSuppress(): boolean {
		return this.clearedSinceAccept >= this.maxCleared;
	}

	/** Call on any accept — resets the counter (Cursor resets on accept). */
	resetOnAccept(): void {
		this.clearedSinceAccept = 0;
	}

	count(): number {
		return this.clearedSinceAccept;
	}
}

export interface GeneratedContentEntry {
	requestId: string;
	relPath: string;
	fileName: string;
	fileExtension: string;
	originalText: string;
	replacementText: string;
	source: 'TAB';
	fate: TabFate;
}

/** A buffered event kept when no telemetry service is wired. */
export interface BufferedTabTelemetryEvent {
	event: string;
	data: Record<string, unknown>;
}

/** Max events kept in the in-memory fallback buffer. */
const RING_BUFFER_MAX = 200;

export class TabTelemetry {
	private readonly ring: BufferedTabTelemetryEvent[] = [];

	/**
	 * @param isEnabled privacy gate (the `canWeTrackTelem` analog) — when
	 * false, events are dropped silently.
	 * @param telemetryService the workbench ITelemetryService; when absent
	 * (unit tests, partial hosts) events are kept in a bounded in-memory
	 * ring buffer instead. Never throws; the constructor always succeeds so
	 * the Tab contribution can never fail to load over telemetry.
	 */
	constructor(
		private readonly isEnabled: () => boolean,
		private readonly telemetryService?: ITelemetryService,
	) { }

	/** Session event (recordCppSessionEvent analog: suggestTab, tabTrigger, acceptTab, ...). */
	recordSessionEvent(event: string, payload: Record<string, unknown>): void {
		this.log(event, { ...payload, ts: new Date().toISOString() });
	}

	/** aiCodeTrackingService.storeGeneratedContent analog — every accept is logged. */
	storeGeneratedContent(entry: GeneratedContentEntry): void {
		this.log('storeGeneratedContent', { ...entry, ts: new Date().toISOString() });
	}

	/**
	 * Events buffered while no telemetry service was wired (diagnostic aid;
	 * newest last, oldest evicted past RING_BUFFER_MAX).
	 */
	getBufferedEvents(): ReadonlyArray<BufferedTabTelemetryEvent> {
		return this.ring;
	}

	private log(event: string, data: Record<string, unknown>): void {
		try {
			if (!this.isEnabled()) return;
			const name = `ideTab.${event}`;
			if (this.telemetryService) {
				this.telemetryService.publicLog(name, data);
				return;
			}
			// No pipeline wired: keep a bounded in-memory copy, never throw.
			this.ring.push({ event: name, data });
			while (this.ring.length > RING_BUFFER_MAX) this.ring.shift();
		} catch {
			// Telemetry must never break the editor.
		}
	}

	/** Clear the fallback buffer; the telemetry pipeline needs no flushing. */
	dispose(): void {
		try {
			this.ring.length = 0;
		} catch {
			// Never break shutdown.
		}
	}
}
