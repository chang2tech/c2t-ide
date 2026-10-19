/**
 * Telemetry + fate tracking + AI code tracking for Tab.
 *
 * - FateTracker: exactly-once fate per requestId (ACCEPT | PARTIAL_ACCEPT | REJECT),
 *   mirroring Cursor's `recordCppFate(requestId, voi.*, fileExtension, performance.now())`.
 * - ClearedSuggestionTracker: `numberOfClearedSuggestionsSinceLastAccept` counter;
 *   when it reaches the server-configured `maxNumberOfClearedSuggestionsSinceLastAccept`,
 *   suggestions are suppressed (rejection throttling) until an accept resets it.
 * - TabTelemetry: JSONL event log (session events, aiCodeTrackingService equivalent
 *   `storeGeneratedContent(..., {source: TAB})`). Gated by a privacy flag
 *   (`canWeTrackTelem` analog) and never throws — logging must not break typing.
 */

import * as fs from 'fs';
import * as path from 'path';
import { TabFate } from './types';

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
    return this.recorded.size;
  }
}

/** Max fate entries kept (LRU by insertion order). */
const FATE_MAX_ENTRIES = 1000;
/** Fate entries older than this are swept on the next record. */
const FATE_ENTRY_TTL_MS = 30 * 60_000;

/** Rejection throttling: repeated clears suppress future suggestions. */
export class ClearedSuggestionTracker {
  private clearedSinceAccept = 0;

  constructor(private maxCleared: number = 5) {}

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

export class TabTelemetry {
  private buffer: Array<{ kind: string; line: string }> = [];
  private flushTimer: NodeJS.Timeout | undefined;
  private mkdirDone = false;

  constructor(
    private logDir: string,
    private isEnabled: () => boolean,
  ) {}

  /** Session event (recordCppSessionEvent analog: suggestTab, tabTrigger, acceptTab, ...). */
  recordSessionEvent(event: string, payload: Record<string, unknown>): void {
    this.append('session', { event, ...payload, ts: new Date().toISOString() });
  }

  /** aiCodeTrackingService.storeGeneratedContent analog — every accept is logged. */
  storeGeneratedContent(entry: GeneratedContentEntry): void {
    this.append('aicode', { ...entry, ts: new Date().toISOString() });
  }

  /**
   * P2 (QA-FILE-06): batch writes instead of `mkdirSync` + `appendFileSync` on
   * the extension host thread per keystroke (input jank under rapid typing).
   * Events accumulate in memory and flush every 2s / 100 events, fire-and-forget.
   */
  private append(kind: string, obj: Record<string, unknown>): void {
    if (!this.isEnabled()) return;
    try {
      this.buffer.push({ kind, line: JSON.stringify(obj) + '\n' });
    } catch {
      return; // unserializable payload — drop it, never break the editor.
    }
    if (this.buffer.length >= 100) {
      void this.flush();
    } else {
      this.scheduleFlush();
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flush();
    }, 2000);
    // Telemetry must not keep the extension host alive.
    if (typeof this.flushTimer.unref === 'function') this.flushTimer.unref();
  }

  /** Write buffered events to disk. Safe to call any time; never throws. */
  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    try {
      if (!this.mkdirDone) {
        await fs.promises.mkdir(this.logDir, { recursive: true });
        this.mkdirDone = true;
      }
      const byKind = new Map<string, string[]>();
      for (const e of batch) {
        const arr = byKind.get(e.kind);
        if (arr) arr.push(e.line);
        else byKind.set(e.kind, [e.line]);
      }
      await Promise.all(
        [...byKind].map(([kind, lines]) =>
          fs.promises.appendFile(path.join(this.logDir, `tab-${kind}.jsonl`), lines.join(''), 'utf8'),
        ),
      );
    } catch {
      // Telemetry must never break the editor.
    }
  }

  /** Flush pending events; call on extension deactivate. */
  dispose(): void {
    void this.flush();
  }
}
