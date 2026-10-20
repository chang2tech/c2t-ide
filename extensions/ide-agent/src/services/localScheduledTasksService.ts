/**
 * LocalScheduledTasksService — a LOCAL, single-machine simplification of the
 * scheduled-tasks runner observed in Cursor's binary.
 *
 * Binary evidence (Cursor 3.25.6, workbench.glass.main.js, static literals):
 * `GlassLocalScheduledTasksService` with lifecycle
 * initialize -> getOwnerAuthId -> refresh -> tick;
 * `mainService.claimDueRuns` with claimToken-based distributed claims;
 * `showMissedRunSummary`; `cancelClaimIfIneligible`; `cancelActiveRun`;
 * `handleClaimLoss`; everything gated by `experimentService.checkFeatureGate`.
 *
 * LOCAL simplification; distributed-claim parity with Cursor UNKNOWN.
 *
 * What this file DOES:
 * - Tick loop over an in-memory ScheduledTask list, cron due matching,
 *   in-process claim/release keyed by claimToken, missed-run summary,
 *   cancel of claims and active runs.
 *
 * What this file does NOT do (deliberate local simplifications):
 * - Distributed claims: claims live in a per-instance Map. Two service
 *   instances in one process do NOT coordinate, and nothing coordinates across
 *   processes or machines. Whether Cursor's claimToken claims are
 *   cross-process / cross-machine and how conflicts resolve is UNKNOWN.
 * - Persistence: tasks are in-memory only. Cursor's storage for scheduled
 *   tasks (file? DB? cloud-synced?) is UNKNOWN — runs missed while the
 *   process is down are not recovered here.
 * - Execution: running a due task calls the injected `runTask` callback.
 *   How Cursor actually executes a scheduled prompt (new agent turn? which
 *   model? which context?) is UNKNOWN.
 * - Feature gate: a `featureGate` callback stands in for
 *   `experimentService.checkFeatureGate`. The real gate key and its rollout
 *   behavior are UNKNOWN.
 * - Owner identity: `getOwnerAuthId()` returns a stable per-instance local
 *   id. What Cursor's owner auth id is derived from is UNKNOWN.
 *
 * Cron is evaluated in UTC (Cursor's timezone handling UNKNOWN). Supported
 * syntax: 5 fields (minute hour day-of-month month day-of-week) with `*`,
 * numbers, `a-b` ranges, `*\/n` and `a-b/n` steps, comma lists, and `7`
 * == Sunday in day-of-week. Shorthands like `@daily` are NOT supported —
 * UNKNOWN whether Cursor accepts them.
 *
 * This module has zero `vscode` dependency so it can be unit-tested with
 * plain node. Wiring (for the parent orchestrator, one line): instantiate
 * `LocalScheduledTasksService` in extension.ts, pass `runTask` (real agent
 * turn runner) and `onMissedSummary` (notification UI), then call
 * `initialize()` + `start()`.
 */

export interface ScheduledTaskModelConfig {
  modelName: string;
  maxMode: boolean;
  selectedModels: string[];
}

/**
 * Default model config for scheduled tasks (Cursor binary-verbatim shape,
 * main.js `Dxe` parser defaults: `{modelName:"default", maxMode:false,
 * selectedModels:[...]}` — main.js @2631005, redig-processes.md D-06d).
 * Which models land in `selectedModels` by default is UNKNOWN; empty means
 * "inherit the user's default model at run time" in this fork.
 */
export const DEFAULT_SCHEDULED_TASK_MODEL_CONFIG: ScheduledTaskModelConfig = {
  modelName: "default",
  maxMode: false,
  selectedModels: [],
};

/**
 * Normalize a partial/stored model config to the full shape, filling
 * binary-verbatim defaults for missing fields. Never throws on malformed
 * input — the worst outcome is the default config.
 */
export function normalizeScheduledTaskModelConfig(
  raw: Partial<ScheduledTaskModelConfig> | null | undefined,
): ScheduledTaskModelConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...DEFAULT_SCHEDULED_TASK_MODEL_CONFIG, selectedModels: [] };
  }
  const modelName =
    typeof raw.modelName === "string" && raw.modelName.length > 0
      ? raw.modelName
      : DEFAULT_SCHEDULED_TASK_MODEL_CONFIG.modelName;
  const maxMode =
    typeof raw.maxMode === "boolean"
      ? raw.maxMode
      : DEFAULT_SCHEDULED_TASK_MODEL_CONFIG.maxMode;
  const selectedModels = Array.isArray(raw.selectedModels)
    ? raw.selectedModels.filter(
        (m): m is string => typeof m === "string" && m.length > 0,
      )
    : [...DEFAULT_SCHEDULED_TASK_MODEL_CONFIG.selectedModels];
  return { modelName, maxMode, selectedModels };
}

/**
 * Run-record → outcome mapping (Cursor binary-verbatim, main.js `Oxe`,
 * redig-processes.md D-06d):
 * `completed`→succeeded, `failed`/`interrupted`→failed, `canceled`→other,
 * everything else→active.
 */
export type RunOutcome = "succeeded" | "failed" | "other" | "active";

export function mapRunStatusToOutcome(status: string): RunOutcome {
  switch (status) {
    case "completed":
      return "succeeded";
    case "failed":
    case "interrupted":
      return "failed";
    case "canceled":
      return "other";
    default:
      return "active";
  }
}

/**
 * Run record (fields `{runId, at, claimedAt, outcome}` — binary-verbatim,
 * main.js `Oxe`; `taskId` added for lookup in this fork).
 */
export interface RunRecord {
  runId: string;
  taskId: string;
  at: number;
  claimedAt: number;
  outcome: RunOutcome;
}

export interface ScheduledTask {
  id: string;
  /** 5-field cron: "minute hour day-of-month month day-of-week". */
  cron: string;
  prompt: string;
  enabled: boolean;
  /** Model selection for the run; defaults via normalizeScheduledTaskModelConfig. */
  modelConfig?: ScheduledTaskModelConfig;
  /** Epoch ms of the due time last executed (not wall-clock completion). */
  lastRunAt?: number;
  lastStatus?: "ran" | "failed" | "cancelled" | "missed";
}

export interface RunClaim {
  taskId: string;
  claimToken: string;
  ownerId: string;
  claimedAt: number;
  /** The due time (epoch ms) this claim covers. */
  dueAt: number;
}

export interface ActiveRun {
  runId: string;
  taskId: string;
  claimToken: string;
  dueAt: number;
  startedAt: number;
}

export interface MissedRun {
  taskId: string;
  prompt: string;
  dueAt: number;
  reason:
    | "superseded-by-later-due-time"
    | "previous-run-still-active"
    | "ineligible-at-claim-time"
    | "claim-lost";
}

export interface MissedRunSummary {
  at: number;
  missed: MissedRun[];
}

export interface TickResult {
  at: number;
  ran: { taskId: string; runId: string; dueAt: number }[];
  failed: { taskId: string; runId: string; dueAt: number; error: string }[];
  missed: MissedRun[];
  skipped?: "not-initialized";
}

export interface ScheduledTasksDeps {
  now?: () => number;
  /**
   * Executes a claimed due task. May be sync or async. Throwing/rejecting
   * marks the run "failed" (it is NOT counted as missed).
   */
  runTask?: (task: ScheduledTask, claim: RunClaim) => void | Promise<void>;
  /** Called when `cancelActiveRun` tears down a run; best-effort. */
  cancelRun?: (runId: string, task: ScheduledTask) => void;
  /** Receives the missed-run summary after any tick that produced misses. */
  onMissedSummary?: (summary: MissedRunSummary) => void;
  /** Local stand-in for experimentService.checkFeatureGate. */
  featureGate?: () => boolean;
  makeId?: () => string;
}

export interface ScheduledTasksOptions {
  /**
   * How far back the FIRST tick looks for due times (there is no earlier
   * tick to bound the window). Default 60_000. Runs missed before process
   * start beyond this lookback are invisible to this local runner.
   */
  initialLookbackMs?: number;
}

const MINUTE_MS = 60_000;
const MAX_WINDOW_MS = 24 * 60 * MINUTE_MS; // bound the cron scan

function defaultMakeId(): string {
  // Not cryptographically strong — fine for a local, single-machine runner.
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/**
 * Parse one cron field into the set of allowed values, or null if invalid.
 * Supports `*`, numbers, `a-b`, `*\/n`, `a-b/n`, comma lists.
 */
export function parseCronField(
  field: string,
  min: number,
  max: number,
): Set<number> | null {
  const values = new Set<number>();
  const addRange = (lo: number, hi: number, step: number): boolean => {
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || !Number.isFinite(step)) {
      return false;
    }
    if (step <= 0 || lo < min || hi > max || lo > hi) {
      return false;
    }
    for (let v = lo; v <= hi; v += step) {
      values.add(v);
    }
    return true;
  };

  if (field === "*") {
    return addRange(min, max, 1) ? values : null;
  }
  for (const rawPart of field.split(",")) {
    const part = rawPart.trim();
    if (!part) {
      return null;
    }
    let range = part;
    let step = 1;
    const slash = part.indexOf("/");
    if (slash >= 0) {
      range = part.slice(0, slash);
      step = parseInt(part.slice(slash + 1), 10);
    }
    let lo: number;
    let hi: number;
    if (range === "*" || range === "") {
      lo = min;
      hi = max;
    } else {
      const dash = range.indexOf("-");
      if (dash >= 0) {
        lo = parseInt(range.slice(0, dash), 10);
        hi = parseInt(range.slice(dash + 1), 10);
      } else {
        lo = parseInt(range, 10);
        hi = lo;
      }
    }
    // Cron convention: day-of-week 7 == Sunday (0).
    if (min === 0 && max === 6) {
      if (lo === 7) {
        lo = 0;
      }
      if (hi === 7) {
        hi = 0;
      }
    }
    if (!addRange(lo, hi, step)) {
      return null;
    }
  }
  return values;
}

export interface ParsedCron {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
  /** True when the field was a bare `*` (matters for dom/dow OR semantics). */
  dayOfMonthStar: boolean;
  dayOfWeekStar: boolean;
}

export function parseCron(cron: string): ParsedCron | null {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) {
    return null;
  }
  const [minF, hourF, domF, monF, dowF] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];
  const minute = parseCronField(minF, 0, 59);
  const hour = parseCronField(hourF, 0, 23);
  const dayOfMonth = parseCronField(domF, 1, 31);
  const month = parseCronField(monF, 1, 12);
  const dayOfWeek = parseCronField(dowF, 0, 6);
  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) {
    return null;
  }
  return {
    minute,
    hour,
    dayOfMonth,
    month,
    dayOfWeek,
    dayOfMonthStar: domF === "*",
    dayOfWeekStar: dowF === "*",
  };
}

/** True when `cron` fires at `at` (evaluated in UTC). Invalid cron => false. */
export function matchesCron(cron: string, at: Date): boolean {
  const p = parseCron(cron);
  if (!p) {
    return false;
  }
  const minute = at.getUTCMinutes();
  const hour = at.getUTCHours();
  const dom = at.getUTCDate();
  const month = at.getUTCMonth() + 1;
  const dow = at.getUTCDay();
  if (!p.minute.has(minute) || !p.hour.has(hour) || !p.month.has(month)) {
    return false;
  }
  // Standard cron dom/dow semantics: if both are restricted, either matching
  // is enough; otherwise the restricted one (or both when both are `*`) must
  // match.
  const domMatch = p.dayOfMonth.has(dom);
  const dowMatch = p.dayOfWeek.has(dow);
  if (!p.dayOfMonthStar && !p.dayOfWeekStar) {
    return domMatch || dowMatch;
  }
  return domMatch && dowMatch;
}

/**
 * Minute-aligned due times with fromMs < t <= toMs, scanning at most 24h
 * back (a local bound; UNKNOWN how far back Cursor scans for missed runs).
 */
export function cronDueTimes(
  cron: string,
  fromMs: number,
  toMs: number,
): number[] {
  if (!(toMs > fromMs)) {
    return [];
  }
  const start = Math.max(fromMs, toMs - MAX_WINDOW_MS);
  const out: number[] = [];
  // First minute boundary strictly after `start`.
  let cursor = start - (start % MINUTE_MS) + MINUTE_MS;
  for (; cursor <= toMs; cursor += MINUTE_MS) {
    if (matchesCron(cron, new Date(cursor))) {
      out.push(cursor);
    }
  }
  return out;
}

export class LocalScheduledTasksService {
  private tasks = new Map<string, ScheduledTask>();
  /** In-process claim table: taskId -> claim. NOT shared across processes. */
  private claims = new Map<string, RunClaim>();
  private activeRuns = new Map<string, ActiveRun>();
  /** Completed/finished run records with binary-verbatim outcomes (Oxe). */
  private runRecords: RunRecord[] = [];
  private missed: MissedRun[] = [];
  private initialized = false;
  private ownerId = "";
  private lastTickAt: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pendingTickMissed: MissedRun[] = [];

  private readonly now: () => number;
  private readonly runTask: (
    task: ScheduledTask,
    claim: RunClaim,
  ) => void | Promise<void>;
  private readonly cancelRun: ((runId: string, task: ScheduledTask) => void) | undefined;
  private readonly onMissedSummary:
    | ((summary: MissedRunSummary) => void)
    | undefined;
  private readonly featureGate: () => boolean;
  private readonly makeId: () => string;
  private readonly initialLookbackMs: number;

  constructor(
    deps: ScheduledTasksDeps = {},
    initialTasks: ScheduledTask[] = [],
    options: ScheduledTasksOptions = {},
  ) {
    this.now = deps.now ?? Date.now;
    this.runTask = deps.runTask ?? (() => {});
    this.cancelRun = deps.cancelRun;
    this.onMissedSummary = deps.onMissedSummary;
    this.featureGate = deps.featureGate ?? (() => true);
    this.makeId = deps.makeId ?? defaultMakeId;
    this.initialLookbackMs = options.initialLookbackMs ?? MINUTE_MS;
    this.setTasks(initialTasks);
  }

  // -- lifecycle (mirrors GlassLocalScheduledTasksService) -----------------

  /**
   * Local stand-in for the experiment gate. Returns false (and leaves the
   * service uninitialized) when the gate is off — mirroring the binary's
   * gating, though the real gate key/behavior is UNKNOWN.
   */
  initialize(): boolean {
    const allowed = this.featureGate();
    this.initialized = allowed;
    if (allowed && !this.ownerId) {
      this.ownerId = this.getOwnerAuthId();
    }
    return allowed;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Stable per-instance owner id used on claims. What Cursor derives its
   * owner auth id from is UNKNOWN; this is a local placeholder.
   */
  getOwnerAuthId(): string {
    if (!this.ownerId) {
      this.ownerId = `local-owner-${this.makeId()}`;
    }
    return this.ownerId;
  }

  /**
   * Re-sync internal state against the current task list: release claims
   * held for tasks that disappeared or were disabled.
   */
  refresh(): number {
    let released = 0;
    for (const taskId of [...this.claims.keys()]) {
      if (this.cancelClaimIfIneligible(taskId)) {
        released++;
      }
    }
    return released;
  }

  /**
   * Run one tick: claim due runs, execute them, collect misses, and surface
   * a missed-run summary when there is anything to report.
   *
   * `windowFromMs` overrides the window start (defaults to the previous
   * tick, or `initialLookbackMs` before now on the first tick). It exists
   * mainly for tests; callers normally pass only `nowMs`.
   */
  async tick(nowMs: number = this.now(), windowFromMs?: number): Promise<TickResult> {
    const result: TickResult = { at: nowMs, ran: [], failed: [], missed: [] };
    if (!this.initialized) {
      result.skipped = "not-initialized";
      return result;
    }

    const fromMs = windowFromMs ?? this.lastTickAt ?? nowMs - this.initialLookbackMs;
    const claims = this.claimDueRuns(nowMs, fromMs);

    for (const claim of claims) {
      const task = this.tasks.get(claim.taskId);
      if (!task || !task.enabled) {
        // Became ineligible between claim and execution (e.g. claimDueRuns
        // was called directly, then the task list changed before tick).
        this.cancelClaimIfIneligible(claim.taskId);
        this.recordMissed(
          task ?? { id: claim.taskId, cron: "", prompt: "", enabled: false },
          claim.dueAt,
          "ineligible-at-claim-time",
        );
        continue;
      }
      const runId = `run-${this.makeId()}`;
      const run: ActiveRun = {
        runId,
        taskId: task.id,
        claimToken: claim.claimToken,
        dueAt: claim.dueAt,
        startedAt: nowMs,
      };
      this.activeRuns.set(runId, run);
      try {
        await this.runTask(task, claim);
        task.lastRunAt = claim.dueAt;
        task.lastStatus = "ran";
        this.recordRunOutcome(runId, task.id, claim, "completed");
        result.ran.push({ taskId: task.id, runId, dueAt: claim.dueAt });
      } catch (err) {
        task.lastStatus = "failed";
        this.recordRunOutcome(runId, task.id, claim, "failed");
        result.failed.push({
          taskId: task.id,
          runId,
          dueAt: claim.dueAt,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        this.activeRuns.delete(runId);
        this.releaseClaim(task.id, claim.claimToken);
      }
    }

    result.missed = this.drainTickMissed();
    if (result.missed.length > 0) {
      this.showMissedRunSummary({ at: nowMs, missed: result.missed });
    }
    this.lastTickAt = nowMs;
    return result;
  }

  /**
   * Claim every enabled task that is due in (fromMs, nowMs] and not already
   * claimed or running. Earlier due times in the window for the same task are
   * recorded as superseded misses; only the latest due time is claimed.
   * Claims are in-process only — distributed-claim parity with Cursor UNKNOWN.
   */
  claimDueRuns(nowMs: number = this.now(), fromMs?: number): RunClaim[] {
    const from = fromMs ?? this.lastTickAt ?? nowMs - this.initialLookbackMs;
    const out: RunClaim[] = [];
    for (const task of this.tasks.values()) {
      if (!task.enabled) {
        continue;
      }
      const due = cronDueTimes(task.cron, from, nowMs).filter(
        (t) => t > (task.lastRunAt ?? -1),
      );
      if (due.length === 0) {
        continue;
      }
      if (this.hasActiveRun(task.id)) {
        // A previous run is still in flight: newly due times are missed,
        // not queued behind the running one. Due times already covered by
        // an in-flight run are not misses.
        const covered = new Set(
          [...this.activeRuns.values()]
            .filter((r) => r.taskId === task.id)
            .map((r) => r.dueAt),
        );
        for (const t of due) {
          if (!covered.has(t)) {
            this.recordMissed(task, t, "previous-run-still-active");
          }
        }
        continue;
      }
      if (this.claims.has(task.id)) {
        continue;
      }
      const dueAt = due[due.length - 1]!;
      const claim: RunClaim = {
        taskId: task.id,
        claimToken: this.makeId(),
        ownerId: this.getOwnerAuthId(),
        claimedAt: nowMs,
        dueAt,
      };
      this.claims.set(task.id, claim);
      out.push(claim);
      for (const t of due.slice(0, -1)) {
        this.recordMissed(task, t, "superseded-by-later-due-time");
      }
    }
    return out;
  }

  /** Release a claim; the token must match (prevents releasing others'). */
  releaseClaim(taskId: string, claimToken: string): boolean {
    const claim = this.claims.get(taskId);
    if (!claim || claim.claimToken !== claimToken) {
      return false;
    }
    this.claims.delete(taskId);
    return true;
  }

  /**
   * If the held claim's task is gone or disabled, drop the claim.
   * Returns true when a claim was cancelled.
   */
  cancelClaimIfIneligible(taskId: string): boolean {
    const claim = this.claims.get(taskId);
    if (!claim) {
      return false;
    }
    const task = this.tasks.get(taskId);
    if (!task || !task.enabled) {
      this.claims.delete(taskId);
      return true;
    }
    return false;
  }

  /**
   * Tear down an active run: best-effort `cancelRun` callback, claim release,
   * task marked "cancelled". Returns false when the run id is unknown.
   */
  cancelActiveRun(runId: string): boolean {
    const run = this.activeRuns.get(runId);
    if (!run) {
      return false;
    }
    this.activeRuns.delete(runId);
    const claimedAt = this.claims.get(run.taskId)?.claimedAt ?? run.startedAt;
    this.releaseClaim(run.taskId, run.claimToken);
    this.runRecords.push({
      runId,
      taskId: run.taskId,
      at: this.now(),
      claimedAt,
      outcome: mapRunStatusToOutcome("canceled"),
    });
    const task = this.tasks.get(run.taskId);
    if (task) {
      task.lastStatus = "cancelled";
      try {
        this.cancelRun?.(runId, task);
      } catch {
        // Best-effort teardown; never let a cancel callback break the tick.
      }
    }
    return true;
  }

  /**
   * Local handling for a lost claim. In a single-process runner a claim can
   * only be "lost" if the caller says so (e.g. an external store revoked
   * it) — real distributed claim-loss semantics in Cursor are UNKNOWN.
   */
  handleClaimLoss(taskId: string, claimToken: string): boolean {
    const claim = this.claims.get(taskId);
    if (!claim || claim.claimToken !== claimToken) {
      return false;
    }
    this.claims.delete(taskId);
    for (const [runId, run] of [...this.activeRuns]) {
      if (run.taskId === taskId && run.claimToken === claimToken) {
        this.activeRuns.delete(runId);
        // A run killed by losing its claim is "interrupted" → failed (Oxe).
        this.recordRunOutcome(runId, taskId, claim, "interrupted");
      }
    }
    const task = this.tasks.get(taskId);
    this.recordMissed(
      task ?? { id: taskId, cron: "", prompt: "", enabled: false },
      claim.dueAt,
      "claim-lost",
    );
    return true;
  }

  /** Surface the missed-run summary (wired to UI by the caller). */
  showMissedRunSummary(summary: MissedRunSummary): void {
    try {
      this.onMissedSummary?.(summary);
    } catch {
      // A failing UI callback must not break the scheduler.
    }
  }

  // -- periodic loop -------------------------------------------------------

  /** Start the periodic tick loop (fires an immediate tick, then intervals). */
  start(intervalMs: number = MINUTE_MS): void {
    if (this.timer) {
      return;
    }
    void this.tick().catch(() => {
      // Tick errors are captured per-run in TickResult.failed; the loop
      // itself must keep going.
    });
    this.timer = setInterval(() => {
      void this.tick().catch(() => {});
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  dispose(): void {
    this.stop();
    this.claims.clear();
    this.activeRuns.clear();
    this.runRecords = [];
  }

  // -- task list / introspection -------------------------------------------

  setTasks(tasks: ScheduledTask[]): void {
    this.tasks = new Map(
      tasks.map((t) => [
        t.id,
        { ...t, modelConfig: normalizeScheduledTaskModelConfig(t.modelConfig) },
      ]),
    );
  }

  addTask(task: ScheduledTask): void {
    this.tasks.set(task.id, {
      ...task,
      modelConfig: normalizeScheduledTaskModelConfig(task.modelConfig),
    });
  }

  removeTask(taskId: string): boolean {
    this.cancelClaimIfIneligible(taskId);
    return this.tasks.delete(taskId);
  }

  getTasks(): ScheduledTask[] {
    return [...this.tasks.values()].map((t) => ({ ...t }));
  }

  getTask(taskId: string): ScheduledTask | undefined {
    const t = this.tasks.get(taskId);
    return t ? { ...t } : undefined;
  }

  getClaims(): RunClaim[] {
    return [...this.claims.values()].map((c) => ({ ...c }));
  }

  getActiveRuns(): ActiveRun[] {
    return [...this.activeRuns.values()].map((r) => ({ ...r }));
  }

  hasActiveRun(taskId: string): boolean {
    for (const run of this.activeRuns.values()) {
      if (run.taskId === taskId) {
        return true;
      }
    }
    return false;
  }

  /** Cumulative missed runs since the last `clearMissedRuns()`. */
  getMissedRuns(): MissedRun[] {
    return this.missed.map((m) => ({ ...m }));
  }

  /**
   * Finished run records (binary-verbatim outcome mapping). Most recent
   * last; kept in memory only, same scope as claims/activeRuns.
   */
  getRunRecords(): RunRecord[] {
    return this.runRecords.map((r) => ({ ...r }));
  }

  clearMissedRuns(): void {
    this.missed = [];
  }

  // -- internals -----------------------------------------------------------

  /**
   * Append a finished-run record. The raw status is mapped through the
   * binary-verbatim outcome mapper (Oxe): see mapRunStatusToOutcome.
   */
  private recordRunOutcome(
    runId: string,
    taskId: string,
    claim: RunClaim,
    rawStatus: "completed" | "failed" | "canceled" | "interrupted",
  ): void {
    this.runRecords.push({
      runId,
      taskId,
      at: this.now(),
      claimedAt: claim.claimedAt,
      outcome: mapRunStatusToOutcome(rawStatus),
    });
  }

  private recordMissed(task: ScheduledTask, dueAt: number, reason: MissedRun["reason"]): void {
    const entry: MissedRun = { taskId: task.id, prompt: task.prompt, dueAt, reason };
    this.missed.push(entry);
    if (task.enabled && this.tasks.has(task.id)) {
      const stored = this.tasks.get(task.id)!;
      stored.lastStatus = "missed";
    }
    this.pendingTickMissed.push(entry);
  }

  private drainTickMissed(): MissedRun[] {
    const out = this.pendingTickMissed;
    this.pendingTickMissed = [];
    return out;
  }
}
