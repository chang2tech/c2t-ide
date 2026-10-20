/**
 * CheckpointStorageCompareService — host-storage compare scheduling.
 *
 * Cursor parity (binary, Cursor 3.25.6 `extensions/cursor-agent-host/dist/main.js`,
 * class `pw`, "host-storage compare service" — deepdig-runtime-checkpoint-2026-10-19.md
 * §1.4, OBSERVED via AST identifier-slice extraction, run-21 confirmed):
 *
 *   - `checkpointDebounceMs` = 60_000 — debounce after noteCheckpoint(sessionId)
 *     before running a compare
 *   - `intervalMs` = 600_000 (10 min) — periodic compare interval
 *   - `activationDelayMs` = 15_000 (15 s) — first periodic compare 15 s after start
 *   - noteCheckpoint(sessionId): adds to `pendingCheckpointSessions`, RESETS the
 *     60 s debounce timer, then runs compare with trigger "checkpoint"
 *   - single-flight: concurrent compare requests are queued and MERGED; a
 *     "checkpoint" trigger wins over "interval" in the merge
 *   - cross-window catalog lease: interval compares require the catalog lease;
 *     when another window holds it the binary logs
 *     "catalog compares run in another window (pid X); this host compares only
 *     the sessions it checkpoints". Checkpoint-triggered compares BYPASS the
 *     lease (always run).
 *   - verdicts per session: pass | lag | warn | fail | busy
 *   - failure dedup with shape fingerprints (shapeFingerprintV2); caps:
 *     4 clusters, 3 samples per cluster, 10 events per run
 *
 * HONEST DIVERGENCES (evidence gaps, not choices):
 *  1. What a "compare" checks: Cursor compares blob-store/host storage state
 *     with verdicts pass|lag|warn|fail|busy computed from heuristics that are
 *     NOT in our evidence. Our default compare only verifies the JSON
 *     checkpoint store on disk (parses, records well-formed) and therefore
 *     emits pass|fail only. CheckpointService injects that verifier; other
 *     callers inject their own.
 *  2. shapeFingerprintV2: the binary's failure-fingerprint algorithm is not
 *     verbatim in our evidence, so clustering uses a coarse
 *     (verdict, detail-class) key. The 4 / 3 / 10 caps ARE evidenced and are
 *     adopted exactly.
 *  3. Catalog lease: Cursor's lease lives in the agent host with window-PID
 *     visibility. Our extension host has no cross-window lease yet, so the
 *     default lease always acquires (single-window assumption). The
 *     checkpoint-triggered bypass path is implemented exactly as observed;
 *     a real lease (file lock / PID check) is future work — see CatalogLease.
 */

// --- Cursor-verbatim constant names (binary, §1.4) ------------------------- //

/** Debounce after noteCheckpoint(sessionId) before running a compare. */
export const checkpointDebounceMs = 60_000;
/** Periodic compare interval. */
export const intervalMs = 600_000;
/** First periodic compare this long after start(). */
export const activationDelayMs = 15_000;

/** Failure-dedup caps (binary, §1.4): at most 4 clusters. */
export const failureClusterCap = 4;
/** Failure-dedup caps (binary, §1.4): at most 3 samples kept per cluster. */
export const failureSamplesPerClusterCap = 3;
/** Failure-dedup caps (binary, §1.4): at most 10 failure events per run. */
export const failureEventsPerRunCap = 10;

export type CompareTrigger = "checkpoint" | "interval";
export type CompareVerdict = "pass" | "lag" | "warn" | "fail" | "busy";

/** Injectable clock so tests can drive scheduling with virtual time. */
export interface StorageCompareTimer {
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
  now(): number;
}

const realTimer: StorageCompareTimer = {
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (id) => clearTimeout(id as NodeJS.Timeout),
  now: () => Date.now(),
};

/**
 * Cross-window catalog lease (binary §1.4: interval compares require it;
 * checkpoint-triggered compares bypass it).
 *
 * DIVERGENCE NOTE (3): no real cross-window lease exists in our runtime yet,
 * so the default always acquires. Inject a real implementation (file lock,
 * PID check) when one becomes available.
 */
export interface CatalogLease {
  /** True when THIS window holds the catalog compare lease. */
  tryAcquire(): boolean;
  /** PID of the window that currently holds the lease (for the log line). */
  holderPid?(): number | undefined;
}

const alwaysAcquireLease: CatalogLease = { tryAcquire: () => true };

export interface SessionCompareResult {
  sessionId: string;
  verdict: CompareVerdict;
  /** Short error description; present when verdict is fail/warn. */
  detail?: string;
}

/** Runs the actual per-session storage check. Sync or async. */
export type CompareSessionsFn = (
  sessionIds: readonly string[],
) => Promise<SessionCompareResult[]> | SessionCompareResult[];

/** Default: nothing to verify, everything passes (CheckpointService injects a real verifier). */
const defaultCompare: CompareSessionsFn = (sessionIds) =>
  sessionIds.map((sessionId) => ({ sessionId, verdict: "pass" as CompareVerdict }));

export interface CheckpointStorageCompareOptions {
  timer?: StorageCompareTimer;
  lease?: CatalogLease;
  compareSessions?: CompareSessionsFn;
  /** Receives diagnostic lines (compare runs, skips, failures). Defaults to no-op. */
  onLog?: (message: string) => void;
}

interface QueuedCompare {
  trigger: CompareTrigger;
  sessions: Set<string>;
}

export class CheckpointStorageCompareService {
  private readonly timer: StorageCompareTimer;
  private readonly lease: CatalogLease;
  private readonly compareSessions: CompareSessionsFn;
  private readonly onLog: (message: string) => void;

  /** Every session this service has ever seen (the "catalog" for interval compares). */
  private readonly knownSessions = new Set<string>();
  /** Sessions noted since the last checkpoint-triggered compare ran. */
  private readonly pendingCheckpointSessions = new Set<string>();

  private debounceTimer: unknown = undefined;
  private activationTimer: unknown = undefined;
  private intervalTimer: unknown = undefined;
  private started = false;
  private disposed = false;

  /** Single-flight: at most one compare runs at a time; the rest merge here. */
  private running = false;
  private queued: QueuedCompare | null = null;

  /** Failure dedup clusters (persist across runs; bounded by failureClusterCap). */
  private readonly failureClusters = new Map<string, { samples: string[]; lastSeen: number }>();
  private failureEventsThisRun = 0;

  private lastVerdicts: SessionCompareResult[] = [];

  constructor(opts: CheckpointStorageCompareOptions = {}) {
    this.timer = opts.timer ?? realTimer;
    this.lease = opts.lease ?? alwaysAcquireLease;
    this.compareSessions = opts.compareSessions ?? defaultCompare;
    this.onLog = opts.onLog ?? (() => {});
  }

  /**
   * Begin periodic scheduling: first interval compare at activationDelayMs
   * (15 s), then every intervalMs (10 min). Idempotent.
   */
  start(): void {
    if (this.started || this.disposed) {
      return;
    }
    this.started = true;
    this.activationTimer = this.timer.setTimeout(() => {
      this.activationTimer = undefined;
      if (this.disposed) {
        return;
      }
      this.onIntervalDue();
      this.scheduleNextInterval();
    }, activationDelayMs);
  }

  dispose(): void {
    this.disposed = true;
    if (this.debounceTimer !== undefined) {
      this.timer.clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    if (this.activationTimer !== undefined) {
      this.timer.clearTimeout(this.activationTimer);
      this.activationTimer = undefined;
    }
    if (this.intervalTimer !== undefined) {
      this.timer.clearTimeout(this.intervalTimer);
      this.intervalTimer = undefined;
    }
    this.queued = null;
  }

  /**
   * A checkpoint was written for sessionId (binary §1.4): record the session,
   * add it to pendingCheckpointSessions, RESET the 60 s debounce timer, then
   * run the compare with trigger "checkpoint" when the debounce elapses.
   */
  noteCheckpoint(sessionId: string): void {
    if (this.disposed) {
      return;
    }
    this.knownSessions.add(sessionId);
    this.pendingCheckpointSessions.add(sessionId);
    if (this.debounceTimer !== undefined) {
      this.timer.clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = this.timer.setTimeout(() => {
      this.debounceTimer = undefined;
      this.onDebounceDue();
    }, checkpointDebounceMs);
  }

  // --- test/observer accessors ------------------------------------------- //

  /** Verdicts from the most recent completed compare. */
  getLastVerdicts(): SessionCompareResult[] {
    return [...this.lastVerdicts];
  }

  /** Currently armed debounce/activation/interval timer count (scheduling state). */
  getArmedTimerCount(): number {
    let n = 0;
    if (this.debounceTimer !== undefined) {
      n += 1;
    }
    if (this.activationTimer !== undefined) {
      n += 1;
    }
    if (this.intervalTimer !== undefined) {
      n += 1;
    }
    return n;
  }

  getFailureClusters(): Array<{ key: string; samples: string[] }> {
    return [...this.failureClusters.entries()].map(([key, c]) => ({
      key,
      samples: [...c.samples],
    }));
  }

  // --- internals ----------------------------------------------------------- //

  private scheduleNextInterval(): void {
    this.intervalTimer = this.timer.setTimeout(() => {
      this.intervalTimer = undefined;
      if (this.disposed) {
        return;
      }
      this.onIntervalDue();
      this.scheduleNextInterval();
    }, intervalMs);
  }

  private onDebounceDue(): void {
    if (this.pendingCheckpointSessions.size === 0) {
      return;
    }
    const sessions = new Set(this.pendingCheckpointSessions);
    this.pendingCheckpointSessions.clear();
    this.requestCompare("checkpoint", sessions);
  }

  private onIntervalDue(): void {
    this.requestCompare("interval", new Set(this.knownSessions));
  }

  /**
   * Single-flight (binary §1.4): concurrent compare requests are queued and
   * MERGED — sessions union, and a "checkpoint" trigger wins over "interval"
   * in the merge.
   */
  private requestCompare(trigger: CompareTrigger, sessions: Set<string>): void {
    if (this.disposed) {
      return;
    }
    if (this.running) {
      if (this.queued === null) {
        this.queued = { trigger, sessions: new Set(sessions) };
      } else {
        for (const s of sessions) {
          this.queued.sessions.add(s);
        }
        if (trigger === "checkpoint") {
          this.queued.trigger = "checkpoint";
        }
      }
      return;
    }
    void this.executeCompare(trigger, sessions);
  }

  private async executeCompare(trigger: CompareTrigger, sessions: Set<string>): Promise<void> {
    this.running = true;
    this.failureEventsThisRun = 0;
    try {
      if (trigger === "interval" && !this.lease.tryAcquire()) {
        // Binary-verbatim log line (pid substituted when the lease names one).
        const pid = this.lease.holderPid?.();
        this.onLog(
          pid === undefined
            ? "catalog compares run in another window; this host compares only the sessions it checkpoints"
            : `catalog compares run in another window (pid ${pid}); this host compares only the sessions it checkpoints`,
        );
        return;
      }
      // Checkpoint-triggered compares bypass the lease — they always run.
      let results: SessionCompareResult[];
      try {
        results = await this.compareSessions([...sessions]);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        this.onLog(`[checkpoint-storage-compare] compare threw: ${detail}`);
        results = [...sessions].map((sessionId) => ({
          sessionId,
          verdict: "fail" as CompareVerdict,
          detail,
        }));
      }
      this.lastVerdicts = results;
      this.recordResults(results, trigger);
    } finally {
      this.running = false;
      const next = this.queued;
      this.queued = null;
      if (next !== null && !this.disposed) {
        void this.executeCompare(next.trigger, next.sessions);
      }
    }
  }

  private recordResults(results: SessionCompareResult[], trigger: CompareTrigger): void {
    this.onLog(
      `[checkpoint-storage-compare] compare done (trigger=${trigger}, sessions=${results.length})`,
    );
    for (const r of results) {
      if (r.verdict === "fail" || r.verdict === "warn") {
        this.recordFailure(r);
      }
    }
  }

  /**
   * Failure dedup (binary §1.4: shapeFingerprintV2; caps 4 clusters,
   * 3 samples per cluster, 10 events per run).
   *
   * DIVERGENCE NOTE (2): the binary's fingerprint algorithm is not verbatim
   * in our evidence — we cluster on (verdict, detail-class). The caps are
   * adopted exactly.
   */
  private recordFailure(r: SessionCompareResult): void {
    if (this.failureEventsThisRun >= failureEventsPerRunCap) {
      return;
    }
    const key = `${r.verdict}::${failureClass(r.detail)}`;
    let cluster = this.failureClusters.get(key);
    if (!cluster) {
      if (this.failureClusters.size >= failureClusterCap) {
        return;
      }
      cluster = { samples: [], lastSeen: this.timer.now() };
      this.failureClusters.set(key, cluster);
    }
    if (cluster.samples.length >= failureSamplesPerClusterCap) {
      return;
    }
    cluster.samples.push(r.detail ?? r.verdict);
    cluster.lastSeen = this.timer.now();
    this.failureEventsThisRun += 1;
    this.onLog(
      `[checkpoint-storage-compare] session ${r.sessionId}: ${r.verdict}` +
        (r.detail ? ` — ${r.detail}` : ""),
    );
  }
}

/** Coarse stand-in for the binary's shapeFingerprintV2 (see DIVERGENCE NOTE 2). */
function failureClass(detail: string | undefined): string {
  if (!detail) {
    return "unknown";
  }
  return detail.split(/[:\n]/)[0]!.trim().slice(0, 80) || "unknown";
}
