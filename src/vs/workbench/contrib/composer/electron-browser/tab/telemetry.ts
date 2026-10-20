// IDE-CODE: TabTelemetry — JSONL file logger for Tab (desktop-only).
//
// Layer split: this logger writes JSONL event files
// with node:fs/node:path, so it lives here in electron-browser/. The pure
// trackers (FateTracker, ClearedSuggestionTracker) and the
// GeneratedContentEntry shape live in the live tab tree,
// ../../../inlineCompletions/browser/ideTab/telemetry.js.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { GeneratedContentEntry } from '../../../inlineCompletions/browser/ideTab/telemetry.js';

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
