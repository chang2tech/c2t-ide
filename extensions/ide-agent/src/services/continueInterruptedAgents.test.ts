/**
 * continueInterruptedAgents tests (node:test, zero extra deps).
 *
 * Cursor parity: "Continue Interrupted Agents" — "Automatically resume
 * working on agents and their subagents after a reload or restart"
 * (detail-settings-2026-10-19.md:63, default ON). These tests pin the
 * fork-side mechanism: turn-start records survive a process death, settle
 * clears them, and the startup sweep resumes only what the setting allows.
 *
 * Run after `tsc`:  node --test out/services/continueInterruptedAgents.test.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import {
  CONTINUE_INTERRUPTED_KEY,
  CONTINUE_INTERRUPTED_SECTION,
  INTERRUPTED_TURNS_STORAGE_KEY,
  parseInterruptedTurnRecords,
  recordTurnSettled,
  recordTurnStarted,
  runInterruptedAgentsResume,
  selectTurnsToResume,
  type InterruptedTurnRecord,
  type InterruptedAgentsResumeDeps,
} from "./continueInterruptedAgents";

function record(partial: Partial<InterruptedTurnRecord> = {}): InterruptedTurnRecord {
  return {
    composerId: "composer-1",
    prompt: "implement the feature",
    startedAt: 1_700_000_000_000,
    ...partial,
  };
}

describe("continueInterruptedAgents — storage contract", () => {
  it("exports the Cursor-parity setting and storage keys", () => {
    assert.strictEqual(CONTINUE_INTERRUPTED_SECTION, "ide.agent");
    assert.strictEqual(CONTINUE_INTERRUPTED_KEY, "continueInterruptedAgents");
    assert.strictEqual(INTERRUPTED_TURNS_STORAGE_KEY, "ideAgent.interruptedTurns.v1");
  });

  it("parseInterruptedTurnRecords degrades malformed state to no records", () => {
    assert.deepStrictEqual(parseInterruptedTurnRecords(undefined), []);
    assert.deepStrictEqual(parseInterruptedTurnRecords("junk"), []);
    assert.deepStrictEqual(parseInterruptedTurnRecords({}), []);
    // Entries with blank prompts, bad timestamps or wrong types are dropped.
    assert.deepStrictEqual(
      parseInterruptedTurnRecords([
        { composerId: "c1", prompt: "", startedAt: 1 },
        { composerId: "c2", prompt: "x", startedAt: NaN },
        { composerId: "c3", prompt: "ok", startedAt: 5 },
        "nope",
      ]),
      [{ composerId: "c3", prompt: "ok", startedAt: 5 }],
    );
  });

  it("parseInterruptedTurnRecords dedupes by composerId keeping the first valid", () => {
    const parsed = parseInterruptedTurnRecords([
      { composerId: "c1", prompt: "first", startedAt: 1 },
      { composerId: "c1", prompt: "second", startedAt: 2 },
    ]);
    assert.strictEqual(parsed.length, 1);
    assert.strictEqual(parsed[0].prompt, "first");
  });
});

describe("continueInterruptedAgents — turn bookkeeping", () => {
  it("recordTurnStarted replaces the composer's previous record", () => {
    const after = recordTurnStarted(
      [record({ composerId: "c1", prompt: "old", startedAt: 1 })],
      record({ composerId: "c1", prompt: "new", startedAt: 2 }),
    );
    assert.strictEqual(after.length, 1);
    assert.strictEqual(after[0].prompt, "new");
  });

  it("recordTurnStarted keeps other composers' records", () => {
    const after = recordTurnStarted(
      [record({ composerId: "c1", prompt: "a", startedAt: 1 })],
      record({ composerId: "c2", prompt: "b", startedAt: 2 }),
    );
    assert.strictEqual(after.length, 2);
  });

  it("recordTurnSettled clears only the settled composer's record", () => {
    const after = recordTurnSettled(
      [record({ composerId: "c1" }), record({ composerId: "c2" })],
      "c1",
    );
    assert.deepStrictEqual(after.map((r) => r.composerId), ["c2"]);
  });
});

describe("continueInterruptedAgents — resume decision", () => {
  const records = [
    record({ composerId: "c2", startedAt: 200 }),
    record({ composerId: "c1", startedAt: 100 }),
  ];

  it("selectTurnsToResume returns survivors oldest-first when enabled", () => {
    const resumed = selectTurnsToResume(records, true);
    assert.deepStrictEqual(resumed.map((r) => r.composerId), ["c1", "c2"]);
  });

  it("selectTurnsToResume returns nothing when the setting is off", () => {
    assert.deepStrictEqual(selectTurnsToResume(records, false), []);
  });
});

describe("continueInterruptedAgents — startup sweep", () => {
  function deps(overrides: Partial<InterruptedAgentsResumeDeps> = {}): InterruptedAgentsResumeDeps & {
    resumed: InterruptedTurnRecord[];
    written: InterruptedTurnRecord[][];
    logs: string[];
  } {
    const resumed: InterruptedTurnRecord[] = [];
    const written: InterruptedTurnRecord[][] = [];
    const logs: string[] = [];
    return {
      resumed,
      written,
      logs,
      isEnabled: () => true,
      readRecords: () => [record({ composerId: "c1", prompt: "p1" }), record({ composerId: "c2", prompt: "p2" })],
      writeRecords: (r) => {
        written.push(r);
      },
      resume: (r) => {
        resumed.push(r);
      },
      log: (line) => {
        logs.push(line);
      },
      ...overrides,
    };
  }

  it("no-ops when no records survived", () => {
    const d = deps({ readRecords: () => [] });
    assert.deepStrictEqual(runInterruptedAgentsResume(d), []);
    assert.deepStrictEqual(d.resumed, []);
    assert.deepStrictEqual(d.written, []);
  });

  it("clears records before resuming, then resumes every record oldest-first", () => {
    const d = deps();
    const resumed = runInterruptedAgentsResume(d);
    // Cleared before any resume fired.
    assert.deepStrictEqual(d.written, [[]]);
    assert.deepStrictEqual(
      resumed.map((r) => r.composerId),
      ["c1", "c2"],
    );
    assert.deepStrictEqual(
      d.resumed.map((r) => r.composerId),
      ["c1", "c2"],
    );
    assert.ok(d.logs.some((l) => l.includes("resumed turn for composer c1")));
  });

  it("drops records without resuming when the setting is off", () => {
    const d = deps({ isEnabled: () => false });
    assert.deepStrictEqual(runInterruptedAgentsResume(d), []);
    assert.deepStrictEqual(d.resumed, []);
    assert.deepStrictEqual(d.written, [[]]);
    assert.ok(d.logs.some((l) => l.includes("is off")));
  });

  it("a failing resume does not stop the rest, and never throws", () => {
    const d = deps();
    const recordingResume = d.resume;
    d.resume = (r) => {
      if (r.composerId === "c1") {
        throw new Error("boom");
      }
      recordingResume(r);
    };
    const resumed = runInterruptedAgentsResume(d);
    assert.deepStrictEqual(
      resumed.map((r) => r.composerId),
      ["c1", "c2"],
    );
    assert.deepStrictEqual(
      d.resumed.map((r) => r.composerId),
      ["c2"],
    );
    assert.ok(d.logs.some((l) => l.includes("failed to resume")));
  });
});
