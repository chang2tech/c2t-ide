/**
 * LocalScheduledTasksService tests (node:test, zero extra deps).
 *
 * Covers the LOCAL simplification only:
 * - initialize gating (featureGate stand-in), getOwnerAuthId stability
 * - cron matching incl. UTC evaluation, ranges/steps/lists, dom/dow OR,
 *   invalid cron never matching
 * - tick claims a due task with a claimToken and runs it via runTask
 * - disabled tasks are never claimed; invalid cron never fires
 * - superseded due times -> missed-run summary via onMissedSummary
 * - previous-run-still-active -> missed (not queued)
 * - claim/release token matching, cancelClaimIfIneligible, cancelActiveRun,
 *   handleClaimLoss, refresh
 * - failed runTask -> "failed", not "missed"
 *
 * Run after `tsc`:  node out/services/test/run-scheduled-tasks-tests.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import {
  LocalScheduledTasksService,
  mapRunStatusToOutcome,
  matchesCron,
  normalizeScheduledTaskModelConfig,
  parseCron,
  DEFAULT_SCHEDULED_TASK_MODEL_CONFIG,
  type MissedRunSummary,
  type RunClaim,
  type ScheduledTask,
} from "../localScheduledTasksService";

// Monday 2026-10-19 09:00:00 UTC (fixed, deterministic).
const T0 = Date.UTC(2026, 9, 19, 9, 0, 0);
// Sunday 2026-10-18 00:00:00 UTC.
const SUN = Date.UTC(2026, 9, 18, 0, 0, 0);

function deferred<T = void>() {
  let resolve!: (v: T | PromiseLike<T>) => void;
  let reject!: (e?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function task(over: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "t1",
    cron: "* * * * *",
    prompt: "do the thing",
    enabled: true,
    ...over,
  };
}

describe("matchesCron / parseCron (UTC, 5-field)", () => {
  it("every-minute matches any minute", () => {
    assert.ok(matchesCron("* * * * *", new Date(T0)));
    assert.ok(matchesCron("* * * * *", new Date(T0 + 61_000)));
  });

  it("fixed time matches exactly", () => {
    assert.ok(matchesCron("0 9 * * *", new Date(T0)));
    assert.ok(!matchesCron("0 9 * * *", new Date(T0 + 60_000)));
    assert.ok(!matchesCron("0 9 * * *", new Date(T0 - 60_000)));
  });

  it("steps, ranges and lists work", () => {
    assert.ok(matchesCron("*/15 * * * *", new Date(T0))); // :00
    assert.ok(matchesCron("*/15 * * * *", new Date(T0 + 15 * 60_000))); // :15
    assert.ok(!matchesCron("*/15 * * * *", new Date(T0 + 60_000))); // :01
    assert.ok(matchesCron("0-30/10 * * * *", new Date(T0 + 20 * 60_000))); // :20
    assert.ok(matchesCron("0,30 * * * *", new Date(T0 + 30 * 60_000))); // :30
  });

  it("day-of-week: 0 and 7 are both Sunday", () => {
    assert.ok(matchesCron("0 0 * * 0", new Date(SUN)));
    assert.ok(matchesCron("0 0 * * 7", new Date(SUN)));
    assert.ok(!matchesCron("0 0 * * 0", new Date(Date.UTC(2026, 9, 19, 0, 0, 0)))); // Monday
    assert.ok(!matchesCron("0 0 * * 1", new Date(SUN)));
  });

  it("dom/dow use OR when both are restricted", () => {
    // 19th (Monday) OR Sunday, at 00:00.
    assert.ok(matchesCron("0 0 19 * 0", new Date(Date.UTC(2026, 9, 19, 0, 0, 0))));
    assert.ok(matchesCron("0 0 19 * 0", new Date(SUN)));
    assert.ok(!matchesCron("0 0 19 * 0", new Date(Date.UTC(2026, 9, 20, 0, 0, 0)))); // 20th Tuesday
  });

  it("invalid cron never matches and parseCron returns null", () => {
    for (const bad of [
      "not a cron",
      "0 0 * *",
      "* * * * * *",
      "61 * * * *",
      "*/0 * * * *",
      "5-1 * * * *",
      "",
    ]) {
      assert.strictEqual(parseCron(bad), null, `parseCron(${JSON.stringify(bad)})`);
      assert.ok(!matchesCron(bad, new Date(T0)), `matchesCron(${JSON.stringify(bad)})`);
    }
  });
});

describe("LocalScheduledTasksService lifecycle", () => {
  it("initialize() respects the feature gate; uninitialized ticks are skipped", async () => {
    let calls = 0;
    const svc = new LocalScheduledTasksService(
      {
        featureGate: () => false,
        runTask: () => {
          calls++;
        },
      },
      [task()],
    );
    assert.strictEqual(svc.initialize(), false);
    assert.strictEqual(svc.isInitialized(), false);
    const r = await svc.tick(T0, T0 - 60_000);
    assert.strictEqual(r.skipped, "not-initialized");
    assert.strictEqual(calls, 0);
    assert.strictEqual(r.ran.length, 0);
  });

  it("getOwnerAuthId() is stable and non-empty", () => {
    const svc = new LocalScheduledTasksService({}, [task()]);
    assert.strictEqual(svc.initialize(), true);
    const a = svc.getOwnerAuthId();
    const b = svc.getOwnerAuthId();
    assert.ok(a.length > 0);
    assert.strictEqual(a, b);
  });
});

describe("tick / claimDueRuns", () => {
  it("claims a due task with a claimToken and runs it once", async () => {
    const seen: { task: ScheduledTask; claim: RunClaim }[] = [];
    const summaries: MissedRunSummary[] = [];
    const svc = new LocalScheduledTasksService(
      {
        runTask: (t, c) => {
          seen.push({ task: t, claim: c });
        },
        onMissedSummary: (s) => summaries.push(s),
      },
      [task()],
    );
    assert.strictEqual(svc.initialize(), true);

    const r = await svc.tick(T0, T0 - 60_000);
    assert.strictEqual(r.ran.length, 1);
    assert.strictEqual(r.ran[0]!.taskId, "t1");
    assert.strictEqual(r.ran[0]!.dueAt, T0);
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0]!.task.id, "t1");
    assert.ok(seen[0]!.claim.claimToken.length > 0);
    assert.strictEqual(seen[0]!.claim.ownerId, svc.getOwnerAuthId());
    assert.strictEqual(seen[0]!.claim.dueAt, T0);

    // Claim released after the run; nothing left claimed or active.
    assert.strictEqual(svc.getClaims().length, 0);
    assert.strictEqual(svc.getActiveRuns().length, 0);

    const stored = svc.getTask("t1")!;
    assert.strictEqual(stored.lastRunAt, T0);
    assert.strictEqual(stored.lastStatus, "ran");

    // No misses in a clean single-due window -> no summary.
    assert.strictEqual(r.missed.length, 0);
    assert.strictEqual(summaries.length, 0);

    // A second tick over an already-covered window does not re-run.
    const r2 = await svc.tick(T0 + 30_000, T0);
    assert.strictEqual(r2.ran.length, 0);
    assert.strictEqual(seen.length, 1);
  });

  it("disabled tasks are never claimed or run", async () => {
    let calls = 0;
    const svc = new LocalScheduledTasksService(
      { runTask: () => { calls++; } },
      [task({ enabled: false })],
    );
    svc.initialize();
    const r = await svc.tick(T0, T0 - 60_000);
    assert.strictEqual(r.ran.length, 0);
    assert.strictEqual(calls, 0);
    assert.strictEqual(svc.getClaims().length, 0);
  });

  it("invalid cron never fires and never throws", async () => {
    let calls = 0;
    const svc = new LocalScheduledTasksService(
      { runTask: () => { calls++; } },
      [task({ cron: "bogus" })],
    );
    svc.initialize();
    const r = await svc.tick(T0, T0 - 3_600_000);
    assert.strictEqual(r.ran.length, 0);
    assert.strictEqual(calls, 0);
  });

  it("multiple due times in one window: latest runs, earlier ones are missed + summarized", async () => {
    let calls = 0;
    const summaries: MissedRunSummary[] = [];
    const svc = new LocalScheduledTasksService(
      {
        runTask: () => { calls++; },
        onMissedSummary: (s) => summaries.push(s),
      },
      [task()],
    );
    svc.initialize();
    // Window (T0-3min, T0] contains due minutes :58, :59 and :00.
    const r = await svc.tick(T0, T0 - 3 * 60_000);
    assert.strictEqual(calls, 1, "exactly one execution");
    assert.strictEqual(r.ran.length, 1);
    assert.strictEqual(r.ran[0]!.dueAt, T0, "latest due time is claimed");
    assert.strictEqual(r.missed.length, 2);
    assert.ok(
      r.missed.every((m) => m.reason === "superseded-by-later-due-time"),
    );
    assert.ok(r.missed.every((m) => m.taskId === "t1"));
    assert.strictEqual(summaries.length, 1);
    assert.strictEqual(summaries[0]!.missed.length, 2);
    assert.strictEqual(svc.getMissedRuns().length, 2);
  });

  it("due while a previous run is active -> missed, not queued", async () => {
    const gate = deferred();
    const svc = new LocalScheduledTasksService(
      { runTask: () => gate.promise },
      [task()],
    );
    svc.initialize();
    const p1 = svc.tick(T0, T0 - 60_000); // starts run, suspends at await
    assert.strictEqual(svc.getActiveRuns().length, 1);

    const r2 = await svc.tick(T0 + 60_000, T0); // :01 due while :00 run active
    assert.strictEqual(r2.ran.length, 0);
    assert.strictEqual(r2.missed.length, 1);
    assert.strictEqual(r2.missed[0]!.reason, "previous-run-still-active");
    assert.strictEqual(r2.missed[0]!.dueAt, T0 + 60_000);

    gate.resolve();
    const r1 = await p1;
    assert.strictEqual(r1.ran.length, 1);
    assert.strictEqual(svc.getActiveRuns().length, 0);
  });

  it("failed runTask -> 'failed', not 'missed', no summary", async () => {
    const summaries: MissedRunSummary[] = [];
    const svc = new LocalScheduledTasksService(
      {
        runTask: () => {
          throw new Error("boom");
        },
        onMissedSummary: (s) => summaries.push(s),
      },
      [task()],
    );
    svc.initialize();
    const r = await svc.tick(T0, T0 - 60_000);
    assert.strictEqual(r.ran.length, 0);
    assert.strictEqual(r.failed.length, 1);
    assert.strictEqual(r.failed[0]!.error, "boom");
    assert.strictEqual(r.missed.length, 0);
    assert.strictEqual(summaries.length, 0);
    assert.strictEqual(svc.getTask("t1")!.lastStatus, "failed");
    assert.strictEqual(svc.getActiveRuns().length, 0);
    assert.strictEqual(svc.getClaims().length, 0);
  });

  it("claim tokens are unique per task claim", () => {
    const svc = new LocalScheduledTasksService(
      {},
      [task({ id: "a" }), task({ id: "b" })],
    );
    svc.initialize();
    const claims = svc.claimDueRuns(T0, T0 - 60_000);
    assert.strictEqual(claims.length, 2);
    assert.notStrictEqual(claims[0]!.claimToken, claims[1]!.claimToken);
    assert.ok(claims[0]!.claimToken.length > 0);
  });
});

describe("claim management", () => {
  it("releaseClaim requires the matching token", () => {
    const svc = new LocalScheduledTasksService({}, [task()]);
    svc.initialize();
    const [claim] = svc.claimDueRuns(T0, T0 - 60_000);
    assert.ok(claim);
    assert.strictEqual(svc.releaseClaim("t1", "wrong-token"), false);
    assert.strictEqual(svc.getClaims().length, 1);
    assert.strictEqual(svc.releaseClaim("t1", claim!.claimToken), true);
    assert.strictEqual(svc.getClaims().length, 0);
  });

  it("cancelClaimIfIneligible drops the claim of a disabled task", () => {
    const svc = new LocalScheduledTasksService({}, [task()]);
    svc.initialize();
    svc.claimDueRuns(T0, T0 - 60_000);
    assert.strictEqual(svc.getClaims().length, 1);
    // Still eligible -> no-op.
    assert.strictEqual(svc.cancelClaimIfIneligible("t1"), false);
    // Disable -> cancelled.
    svc.setTasks([task({ enabled: false })]);
    assert.strictEqual(svc.cancelClaimIfIneligible("t1"), true);
    assert.strictEqual(svc.getClaims().length, 0);
    // Unknown task id -> false.
    assert.strictEqual(svc.cancelClaimIfIneligible("nope"), false);
  });

  it("refresh() releases claims for removed tasks", () => {
    const svc = new LocalScheduledTasksService({}, [task()]);
    svc.initialize();
    svc.claimDueRuns(T0, T0 - 60_000);
    assert.strictEqual(svc.getClaims().length, 1);
    svc.setTasks([]);
    assert.strictEqual(svc.refresh(), 1);
    assert.strictEqual(svc.getClaims().length, 0);
    assert.strictEqual(svc.refresh(), 0);
  });

  it("cancelActiveRun tears down a running task and notifies", async () => {
    const gate = deferred();
    const cancelled: string[] = [];
    const svc = new LocalScheduledTasksService(
      {
        runTask: () => gate.promise,
        cancelRun: (runId) => cancelled.push(runId),
      },
      [task()],
    );
    svc.initialize();
    const p = svc.tick(T0, T0 - 60_000);
    const [run] = svc.getActiveRuns();
    assert.ok(run);
    assert.strictEqual(svc.cancelActiveRun(run!.runId), true);
    assert.deepStrictEqual(cancelled, [run!.runId]);
    assert.strictEqual(svc.getActiveRuns().length, 0);
    assert.strictEqual(svc.getClaims().length, 0);
    assert.strictEqual(svc.getTask("t1")!.lastStatus, "cancelled");
    assert.strictEqual(svc.cancelActiveRun(run!.runId), false, "second cancel is a no-op");
    assert.strictEqual(svc.cancelActiveRun("run-unknown"), false);
    gate.resolve();
    await p;
  });

  it("handleClaimLoss clears the claim and records a miss", () => {
    const svc = new LocalScheduledTasksService({}, [task()]);
    svc.initialize();
    const [claim] = svc.claimDueRuns(T0, T0 - 60_000);
    assert.ok(claim);
    assert.strictEqual(svc.handleClaimLoss("t1", "wrong"), false);
    assert.strictEqual(svc.handleClaimLoss("t1", claim!.claimToken), true);
    assert.strictEqual(svc.getClaims().length, 0);
    const missed = svc.getMissedRuns();
    assert.strictEqual(missed.length, 1);
    assert.strictEqual(missed[0]!.reason, "claim-lost");
    assert.strictEqual(missed[0]!.dueAt, T0);
  });

  it("start/stop/dispose manage the loop without throwing", async () => {
    const svc = new LocalScheduledTasksService({}, []);
    svc.initialize();
    svc.start(60_000);
    svc.start(60_000); // idempotent
    svc.stop();
    svc.dispose();
  });
});

describe("model config normalization (Cursor binary-verbatim, main.js Dxe)", () => {
  it("defaults are verbatim: {modelName:'default', maxMode:false, selectedModels:[]}", () => {
    assert.deepStrictEqual(DEFAULT_SCHEDULED_TASK_MODEL_CONFIG, {
      modelName: "default",
      maxMode: false,
      selectedModels: [],
    });
    assert.deepStrictEqual(normalizeScheduledTaskModelConfig(undefined), {
      modelName: "default",
      maxMode: false,
      selectedModels: [],
    });
    assert.deepStrictEqual(normalizeScheduledTaskModelConfig(null), {
      modelName: "default",
      maxMode: false,
      selectedModels: [],
    });
    assert.deepStrictEqual(normalizeScheduledTaskModelConfig({}), {
      modelName: "default",
      maxMode: false,
      selectedModels: [],
    });
  });

  it("partial config fills missing fields with defaults and filters junk", () => {
    assert.deepStrictEqual(
      normalizeScheduledTaskModelConfig({ modelName: "gpt-5", maxMode: true } as never),
      { modelName: "gpt-5", maxMode: true, selectedModels: [] },
    );
    assert.deepStrictEqual(
      normalizeScheduledTaskModelConfig({
        modelName: "",
        selectedModels: ["a", "", "b", 42 as unknown as string],
      }),
      { modelName: "default", maxMode: false, selectedModels: ["a", "b"] },
    );
  });

  it("setTasks/addTask normalize modelConfig onto stored tasks", () => {
    const svc = new LocalScheduledTasksService({}, [task()]);
    assert.deepStrictEqual(svc.getTask("t1")!.modelConfig, {
      modelName: "default",
      maxMode: false,
      selectedModels: [],
    });
    svc.addTask({ ...task(), id: "t2", modelConfig: { modelName: "m", maxMode: true, selectedModels: ["m"] } });
    assert.deepStrictEqual(svc.getTask("t2")!.modelConfig, {
      modelName: "m",
      maxMode: true,
      selectedModels: ["m"],
    });
  });
});

describe("run outcome mapping (Cursor binary-verbatim, main.js Oxe)", () => {
  it("maps raw statuses verbatim", () => {
    assert.strictEqual(mapRunStatusToOutcome("completed"), "succeeded");
    assert.strictEqual(mapRunStatusToOutcome("failed"), "failed");
    assert.strictEqual(mapRunStatusToOutcome("interrupted"), "failed");
    assert.strictEqual(mapRunStatusToOutcome("canceled"), "other");
    // everything else → active
    assert.strictEqual(mapRunStatusToOutcome("running"), "active");
    assert.strictEqual(mapRunStatusToOutcome("claimed"), "active");
    assert.strictEqual(mapRunStatusToOutcome(""), "active");
  });

  it("tick records {runId, at, claimedAt, outcome} for ran and failed runs", async () => {
    const ranSvc = new LocalScheduledTasksService({}, [task()]);
    ranSvc.initialize();
    const res = await ranSvc.tick(T0, T0 - 60_000);
    assert.strictEqual(res.ran.length, 1);
    const [rec] = ranSvc.getRunRecords();
    assert.ok(rec);
    assert.strictEqual(rec!.runId, res.ran[0]!.runId);
    assert.strictEqual(rec!.taskId, "t1");
    assert.strictEqual(rec!.outcome, "succeeded");
    assert.strictEqual(typeof rec!.at, "number");
    assert.strictEqual(rec!.claimedAt, T0);

    const failSvc = new LocalScheduledTasksService(
      {
        runTask: () => {
          throw new Error("boom");
        },
      },
      [task()],
    );
    failSvc.initialize();
    const fres = await failSvc.tick(T0, T0 - 60_000);
    assert.strictEqual(fres.failed.length, 1);
    const [frec] = failSvc.getRunRecords();
    assert.ok(frec);
    assert.strictEqual(frec!.outcome, "failed");
    assert.strictEqual(frec!.runId, fres.failed[0]!.runId);
  });

  it("cancelActiveRun records canceled → outcome 'other'", async () => {
    const gate = deferred();
    const svc = new LocalScheduledTasksService({ runTask: () => gate.promise }, [task()]);
    svc.initialize();
    const p = svc.tick(T0, T0 - 60_000);
    const [run] = svc.getActiveRuns();
    assert.ok(run);
    assert.strictEqual(svc.cancelActiveRun(run!.runId), true);
    const recs = svc.getRunRecords().filter((r) => r.runId === run!.runId);
    assert.strictEqual(recs.length, 1);
    assert.strictEqual(recs[0]!.outcome, "other");
    gate.resolve();
    await p;
  });

  it("handleClaimLoss on a running task records interrupted → outcome 'failed'", async () => {
    const gate = deferred();
    const svc = new LocalScheduledTasksService({ runTask: () => gate.promise }, [task()]);
    svc.initialize();
    const p = svc.tick(T0, T0 - 60_000);
    const [run] = svc.getActiveRuns();
    assert.ok(run);
    assert.strictEqual(svc.handleClaimLoss("t1", run!.claimToken), true);
    const recs = svc.getRunRecords().filter((r) => r.runId === run!.runId);
    assert.strictEqual(recs.length, 1);
    assert.strictEqual(recs[0]!.outcome, "failed");
    gate.resolve();
    await p;
  });
});
