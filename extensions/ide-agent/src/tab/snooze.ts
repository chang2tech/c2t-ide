/**
 * Snooze management for Tab completion.
 * Port of Cursor's `editor.cpp.snooze` (quick-pick 1m–3h) +
 * `maybeReenableCppIfSnoozed()` auto re-enable on expiry.
 *
 * Storage is injected so the vscode Memento can be swapped for an in-memory
 * map in tests. The timer handle lets tests fast-forward expiry.
 */

export interface SnoozeStorage {
  get(key: string): number | undefined;
  set(key: string, value: number | undefined): void;
}

export const SNOOZE_UNTIL_KEY = 'ide.tab.snoozedUntil';

export class SnoozeManager {
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private storage: SnoozeStorage,
    private onExpire: () => void = () => {},
  ) {}

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
    // Don't hold the process / extension host open for a 3h snooze.
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
   * the extension host restarted mid-snooze).
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
