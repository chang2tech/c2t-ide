/**
 * Checkpoint diff-based snapshot tests (node:test, zero extra deps).
 *
 * Unit: checkpointDiff (computeLineDiff / applyDiffToLines /
 * reconstructOriginalLines round-trips, corruption handling) +
 * checkpointPlan dual-format support (validateSnapshot, resolveSnapshotContents,
 * computeRestorePlan with diff-form snapshots).
 *
 * Run after `tsc`:  node out/services/test/run-checkpoint-diff-tests.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import {
  computeLineDiff,
  applyDiffToLines,
  reconstructOriginalLines,
  isValidDiff,
  sha1Hex,
  OriginalModelDiffWrtV0,
} from "../checkpointDiff";
import {
  validateSnapshot,
  resolveSnapshotContents,
  computeRestorePlan,
  FileSnapshot,
} from "../checkpointPlan";

/** Round-trip helper: diff (base -> original), then reconstruct from base. */
function roundTrip(base: string, original: string): string | undefined {
  const diff = computeLineDiff(base, original);
  const lines = reconstructOriginalLines(diff, base.split("\n"));
  return lines?.join("\n");
}

function diffSnap(uri: string, base: string, original: string): FileSnapshot {
  return { uri, originalModelDiffWrtV0: computeLineDiff(base, original) };
}

/* ---------- computeLineDiff / reconstructOriginalLines round-trips ---------- */
describe("checkpointDiff — diff round-trips", () => {
  const cases: Array<[string, string, string]> = [
    ["identical", "a\nb\nc\n", "a\nb\nc\n"],
    ["single line changed", "a\nb\nc\n", "a\nB\nc\n"],
    ["insert at start", "b\nc\n", "a\nb\nc\n"],
    ["insert in middle", "a\nc\n", "a\nb\nc\n"],
    ["insert at end", "a\nb\n", "a\nb\nc\n"],
    ["delete line", "a\nb\nc\n", "a\nc\n"],
    ["multiple hunks", "1\n2\n3\n4\n5\n6\n", "1\nX\n3\n4\nY\nZ\n6\n"],
    ["whole rewrite", "aaa\nbbb\n", "xxx\nyyy\nzzz\n"],
    ["empty base", "", "hello\nworld\n"],
    ["empty original", "hello\nworld\n", ""],
    ["both empty", "", ""],
    ["no trailing newline", "a\nb", "a\nB"],
    ["trailing newline added", "a\nb", "a\nb\n"],
    ["crlf preserved", "a\r\nb\r\n", "a\r\nB\r\n"],
    ["repeated lines", "x\nx\nx\nx\n", "x\ny\nx\nx\n"],
    ["adjacent substitution", "ab\n", "aY\n"],
  ];
  for (const [name, base, original] of cases) {
    it(`round-trips: ${name}`, () => {
      assert.strictEqual(roundTrip(base, original), original);
    });
  }

  it("identical content produces an empty edit list", () => {
    const diff = computeLineDiff("a\nb\n", "a\nb\n");
    assert.deepStrictEqual(diff.edits, []);
    assert.strictEqual(diff.baseLineCount, 3); // "a\nb\n".split("\n")
    assert.ok(/^[0-9a-f]{40}$/.test(diff.baseHash));
    assert.strictEqual(diff.baseHash, sha1Hex("a\nb\n"));
  });

  it("small edits produce a compact diff (much smaller than full contents)", () => {
    const base = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n") + "\n";
    const original = base.replace("line 250", "line 250 CHANGED");
    const diff = computeLineDiff(base, original);
    assert.ok(diff.edits.length >= 1 && diff.edits.length <= 3);
    const json = JSON.stringify(diff);
    assert.ok(json.length < original.length / 10, `diff too big: ${json.length}`);
    assert.strictEqual(roundTrip(base, original), original);
  });

  it("edits are ascending and non-overlapping", () => {
    const base = "a\nb\nc\nd\ne\nf\ng\n";
    const original = "A\nb\nC\nd\nE\nf\nG\n";
    const diff = computeLineDiff(base, original);
    let prevEnd = 0;
    for (const e of diff.edits) {
      assert.ok(e.start >= prevEnd, "edits must be ascending/non-overlapping");
      assert.ok(e.start <= e.end && e.end <= diff.baseLineCount);
      prevEnd = e.end;
    }
    assert.strictEqual(roundTrip(base, original), original);
  });

  it("large rewritten middle falls back to whole-range replace and still round-trips", () => {
    const base = Array.from({ length: 1500 }, (_, i) => `base-${i}`).join("\n");
    const original = Array.from({ length: 1500 }, (_, i) => `orig-${i}`).join("\n");
    const diff = computeLineDiff(base, original);
    // 1500*1500 line-pairs > 1M threshold -> single fallback edit.
    assert.strictEqual(diff.edits.length, 1);
    assert.deepStrictEqual([diff.edits[0].start, diff.edits[0].end], [0, 1500]);
    assert.strictEqual(roundTrip(base, original), original);
  });

  it("deterministic randomized round-trips (seeded)", () => {
    // Simple LCG — deterministic, no flakiness.
    let seed = 0x12345678;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let trial = 0; trial < 60; trial++) {
      const n = 1 + Math.floor(rand() * 40);
      const baseLines = Array.from({ length: n }, () => `l${Math.floor(rand() * 8)}`);
      const origLines = baseLines.slice();
      const ops = Math.floor(rand() * 6);
      for (let k = 0; k < ops; k++) {
        const at = Math.floor(rand() * (origLines.length + 1));
        const kind = rand();
        if (kind < 0.4) {
          origLines.splice(at, 0, `ins${Math.floor(rand() * 100)}`);
        } else if (kind < 0.7 && origLines.length > 0) {
          origLines.splice(Math.min(at, origLines.length - 1), 1);
        } else if (origLines.length > 0) {
          origLines[Math.min(at, origLines.length - 1)] = `chg${Math.floor(rand() * 100)}`;
        }
      }
      const base = baseLines.join("\n");
      const original = origLines.join("\n");
      assert.strictEqual(roundTrip(base, original), original, `trial ${trial} failed`);
    }
  });
});

/* ---------- applyDiffToLines ---------- */
describe("applyDiffToLines", () => {
  it("identity fast-path: returns the same array when already at checkpoint state", () => {
    const base = "a\nb\nc\n";
    const diff = computeLineDiff(base, base);
    const current = base.split("\n");
    const out = applyDiffToLines(current, diff, base.split("\n"));
    assert.strictEqual(out, current, "must return the identical array reference");
  });

  it("reconstructs the original even when current diverged arbitrarily", () => {
    const base = "v0-1\nv0-2\nv0-3\n";
    const original = "orig-1\nv0-2\norig-3\n";
    const diff = computeLineDiff(base, original);
    // Current content: turn edits shifted everything (insertions above).
    const current = ["zzz", "orig-1", "v0-2", "orig-3", "tail"].join("\n").split("\n");
    const out = applyDiffToLines(current, diff, base.split("\n"));
    assert.deepStrictEqual(out, original.split("\n"));
  });

  it("returns undefined for a corrupt diff (tampered hash)", () => {
    const base = "a\nb\n";
    const diff = computeLineDiff(base, "a\nB\n");
    const bad: OriginalModelDiffWrtV0 = { ...diff, baseHash: "0".repeat(40) };
    assert.strictEqual(applyDiffToLines(["a", "B", ""], bad, base.split("\n")), undefined);
  });

  it("returns undefined when the base line count mismatches", () => {
    const base = "a\nb\n";
    const diff = computeLineDiff(base, "a\nB\n");
    const bad: OriginalModelDiffWrtV0 = { ...diff, baseLineCount: 999 };
    assert.strictEqual(applyDiffToLines(["a", "B", ""], bad, base.split("\n")), undefined);
  });

  it("returns undefined for out-of-bounds edits", () => {
    const base = "a\nb\n";
    const diff = computeLineDiff(base, "a\nB\n");
    const bad: OriginalModelDiffWrtV0 = {
      ...diff,
      edits: [{ start: 0, end: 5000, text: ["x"] }],
    };
    assert.strictEqual(applyDiffToLines(["a", "B", ""], bad, base.split("\n")), undefined);
  });
});

/* ---------- isValidDiff ---------- */
describe("isValidDiff", () => {
  it("accepts a real diff, rejects garbage", () => {
    assert.ok(isValidDiff(computeLineDiff("a\n", "b\n")));
    assert.ok(!isValidDiff(undefined));
    assert.ok(!isValidDiff(null));
    assert.ok(!isValidDiff({}));
    assert.ok(!isValidDiff({ baseHash: "zz", baseLineCount: 1, edits: [] }));
    assert.ok(
      !isValidDiff({ baseHash: "0".repeat(40), baseLineCount: -1, edits: [] }),
    );
    assert.ok(
      !isValidDiff({
        baseHash: "0".repeat(40),
        baseLineCount: 1,
        edits: [{ start: 2, end: 1, text: [] }],
      }),
    );
  });
});

/* ---------- checkpointPlan dual-format support ---------- */
describe("validateSnapshot — dual format", () => {
  it("accepts diff-form snapshots", () => {
    assert.ok(validateSnapshot(diffSnap("/w/f.ts", "a\n", "b\n")));
  });
  it("still accepts legacy contents snapshots", () => {
    assert.ok(validateSnapshot({ uri: "/w/f.ts", contents: "x" }));
  });
  it("rejects empty uri, missing payload, and garbage diffs", () => {
    assert.ok(!validateSnapshot({ uri: "", originalModelDiffWrtV0: computeLineDiff("a", "b") }));
    assert.ok(!validateSnapshot({ uri: "/w/f.ts", contents: undefined as any }));
    assert.ok(
      !validateSnapshot({ uri: "/w/f.ts", originalModelDiffWrtV0: {} as any }),
    );
  });
});

describe("resolveSnapshotContents", () => {
  it("passes legacy contents through untouched", () => {
    assert.strictEqual(
      resolveSnapshotContents({ uri: "/w/f.ts", contents: "old" }),
      "old",
    );
  });
  it("reconstructs diff-form snapshots from the base map", () => {
    const base = "one\ntwo\nthree\n";
    const snap = diffSnap("/w/f.ts", base, "one\nTWO\nthree\n");
    assert.strictEqual(
      resolveSnapshotContents(snap, new Map([["/w/f.ts", base]])),
      "one\nTWO\nthree\n",
    );
  });
  it("returns undefined when the base is missing or mismatched", () => {
    const snap = diffSnap("/w/f.ts", "a\n", "b\n");
    assert.strictEqual(resolveSnapshotContents(snap, new Map()), undefined);
    assert.strictEqual(resolveSnapshotContents(snap), undefined);
    assert.strictEqual(
      resolveSnapshotContents(snap, new Map([["/w/f.ts", "DIFFERENT\n"]])),
      undefined,
    );
  });
});

describe("computeRestorePlan — diff-form snapshots", () => {
  const base = "v1\n";
  const bases = new Map([["/w/a.ts", base]]);

  function current(...entries: Array<[string, string | undefined]>): Map<string, string | undefined> {
    return new Map(entries);
  }

  it("reverts via reconstructed diff contents", () => {
    const plan = computeRestorePlan({
      targetFiles: [diffSnap("/w/a.ts", base, "v1")],
      laterFiles: [],
      newlyCreatedFiles: [],
      newlyCreatedFolders: [],
      existingFolders: new Set(),
      activeInlineDiffs: [],
      currentContents: current(["/w/a.ts", "v2"]),
      baseContents: bases,
    });
    assert.strictEqual(plan.isSame, false);
    assert.deepStrictEqual(
      plan.filesToRevert.map((f) => f.uri),
      ["/w/a.ts"],
    );
    assert.strictEqual(plan.filesToRevert[0].contents, "v1");
  });

  it("isSame when current matches the reconstructed original", () => {
    const plan = computeRestorePlan({
      targetFiles: [diffSnap("/w/a.ts", base, "v1")],
      laterFiles: [],
      newlyCreatedFiles: [],
      newlyCreatedFolders: [],
      existingFolders: new Set(),
      activeInlineDiffs: [],
      currentContents: current(["/w/a.ts", "v1"]),
      baseContents: bases,
    });
    assert.strictEqual(plan.isSame, true);
  });

  it("mixes legacy and diff-form snapshots in one plan", () => {
    const plan = computeRestorePlan({
      targetFiles: [
        { uri: "/w/legacy.ts", contents: "old" },
        diffSnap("/w/a.ts", base, "v1"),
      ],
      laterFiles: [],
      newlyCreatedFiles: [],
      newlyCreatedFolders: [],
      existingFolders: new Set(),
      activeInlineDiffs: [],
      currentContents: current(["/w/legacy.ts", "new"], ["/w/a.ts", "v2"]),
      baseContents: bases,
    });
    assert.strictEqual(plan.isSame, false);
    const byUri = new Map(plan.filesToRevert.map((f) => [f.uri, f.contents]));
    assert.strictEqual(byUri.get("/w/legacy.ts"), "old");
    assert.strictEqual(byUri.get("/w/a.ts"), "v1");
  });

  it("skips diff snapshots whose base is unknown (no revert, no crash)", () => {
    const plan = computeRestorePlan({
      targetFiles: [diffSnap("/w/a.ts", base, "v1")],
      laterFiles: [],
      newlyCreatedFiles: [],
      newlyCreatedFolders: [],
      existingFolders: new Set(),
      activeInlineDiffs: [],
      currentContents: current(["/w/a.ts", "v2"]),
      // no baseContents at all
    });
    assert.deepStrictEqual(plan.filesToRevert, []);
    assert.strictEqual(plan.isSame, true);
  });
});
