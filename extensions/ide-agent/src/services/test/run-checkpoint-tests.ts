/**
 * Checkpoint tests (node:test, zero extra deps).
 *
 * Unit: checkpointPlan (pure restore-plan logic) + bubbleStore.truncateAfter
 * (transcript rewind on restore).
 *
 * Run after `tsc`:  node out/services/test/run-checkpoint-tests.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import {
  areContentsEqual,
  validateSnapshot,
  computeRestorePlan,
  FileSnapshot,
} from "../checkpointPlan";
import { ComposerBubbleSetStore } from "../../stores/bubbleStore";
import { BubbleData } from "../../model";

function snap(uri: string, contents: string): FileSnapshot {
  return { uri, contents };
}

function current(...entries: Array<[string, string | undefined]>): Map<string, string | undefined> {
  return new Map(entries);
}

/* ---------- areContentsEqual / validateSnapshot ---------- */
describe("areContentsEqual", () => {
  it("equal strings match", () => {
    assert.ok(areContentsEqual("a\nb", "a\nb"));
  });
  it("whitespace differences do not match", () => {
    assert.ok(!areContentsEqual("a\nb", "a\nb\n"));
    assert.ok(!areContentsEqual("a", "a "));
  });
});

describe("validateSnapshot", () => {
  it("accepts well-formed snapshots", () => {
    assert.ok(validateSnapshot(snap("/w/f.ts", "x")));
  });
  it("rejects empty uri and non-string contents", () => {
    assert.ok(!validateSnapshot(snap("", "x")));
    assert.ok(!validateSnapshot({ uri: "/w/f.ts", contents: undefined as any }));
  });
});

/* ---------- computeRestorePlan ---------- */
describe("computeRestorePlan — snapshot+restore round-trip", () => {
  it("reverts files whose contents differ from the snapshot", () => {
    const plan = computeRestorePlan({
      targetFiles: [snap("/w/a.ts", "before")],
      laterFiles: [],
      newlyCreatedFiles: [],
      newlyCreatedFolders: [],
      existingFolders: new Set(),
      activeInlineDiffs: [],
      currentContents: current(["/w/a.ts", "after"]),
    });
    assert.strictEqual(plan.isSame, false);
    assert.deepStrictEqual(
      plan.filesToRevert.map((f) => f.uri),
      ["/w/a.ts"],
    );
    assert.strictEqual(plan.filesToRevert[0].contents, "before");
    assert.deepStrictEqual(plan.filesToDelete, []);
  });

  it("isSame when every snapshot matches and nothing was created", () => {
    const plan = computeRestorePlan({
      targetFiles: [snap("/w/a.ts", "same")],
      laterFiles: [],
      newlyCreatedFiles: [],
      newlyCreatedFolders: [],
      existingFolders: new Set(),
      activeInlineDiffs: [],
      currentContents: current(["/w/a.ts", "same"]),
    });
    assert.strictEqual(plan.isSame, true);
    assert.deepStrictEqual(plan.filesToRevert, []);
  });

  it("re-creates a snapshotted file that is missing on disk", () => {
    const plan = computeRestorePlan({
      targetFiles: [snap("/w/a.ts", "before")],
      laterFiles: [],
      newlyCreatedFiles: [],
      newlyCreatedFolders: [],
      existingFolders: new Set(),
      activeInlineDiffs: [],
      currentContents: current(["/w/a.ts", undefined]),
    });
    assert.strictEqual(plan.isSame, false);
    assert.deepStrictEqual(
      plan.filesToRevert.map((f) => f.uri),
      ["/w/a.ts"],
    );
  });
});

describe("computeRestorePlan — delete-new-files on restore", () => {
  it("deletes files created during the target turn too (they did not exist at checkpoint time)", () => {
    const plan = computeRestorePlan({
      targetFiles: [],
      laterFiles: [],
      newlyCreatedFiles: ["/w/new-during-target.ts", "/w/new-during-later.ts"],
      newlyCreatedFolders: [],
      existingFolders: new Set(),
      activeInlineDiffs: [],
      currentContents: current(
        ["/w/new-during-target.ts", "x"],
        ["/w/new-during-later.ts", "y"],
      ),
    });
    assert.strictEqual(plan.isSame, false);
    assert.deepStrictEqual(new Set(plan.filesToDelete), new Set([
      "/w/new-during-target.ts",
      "/w/new-during-later.ts",
    ]));
  });

  it("skips created files that are already gone", () => {
    const plan = computeRestorePlan({
      targetFiles: [],
      laterFiles: [],
      newlyCreatedFiles: ["/w/gone.ts"],
      newlyCreatedFolders: [],
      existingFolders: new Set(),
      activeInlineDiffs: [],
      currentContents: current(["/w/gone.ts", undefined]),
    });
    assert.deepStrictEqual(plan.filesToDelete, []);
    assert.strictEqual(plan.isSame, true);
  });

  it("snapshotted path wins: re-created later at a snapshotted path is reverted, not deleted", () => {
    const plan = computeRestorePlan({
      targetFiles: [snap("/w/f.ts", "original")],
      laterFiles: [],
      newlyCreatedFiles: ["/w/f.ts"],
      newlyCreatedFolders: [],
      existingFolders: new Set(),
      activeInlineDiffs: [],
      currentContents: current(["/w/f.ts", "recreated-later"]),
    });
    assert.deepStrictEqual(plan.filesToDelete, []);
    assert.deepStrictEqual(
      plan.filesToRevert.map((f) => f.uri),
      ["/w/f.ts"],
    );
    assert.strictEqual(plan.filesToRevert[0].contents, "original");
  });

  it("dedups folders and keeps them in the plan", () => {
    const plan = computeRestorePlan({
      targetFiles: [],
      laterFiles: [],
      newlyCreatedFiles: [],
      newlyCreatedFolders: ["/w/d1", "/w/d1", "/w/d2"],
      existingFolders: new Set(["/w/d1", "/w/d2"]),
      activeInlineDiffs: [],
      currentContents: current(),
    });
    assert.deepStrictEqual(new Set(plan.foldersToDelete), new Set(["/w/d1", "/w/d2"]));
    assert.strictEqual(plan.isSame, false);
  });
});

describe("computeRestorePlan — widened revert (file first touched by a later turn)", () => {
  it("reverts to the earliest known state, which equals the target-time state", () => {
    // x.ts existed at target time but was never tracked then; turn B edited
    // it, so the earliest snapshot lives in B's record. Restoring to the
    // target must still revert x.ts (it was "orig" at target time: turn A
    // never touched it).
    const plan = computeRestorePlan({
      targetFiles: [],
      laterFiles: [snap("/w/x.ts", "orig")],
      newlyCreatedFiles: [],
      newlyCreatedFolders: [],
      existingFolders: new Set(),
      activeInlineDiffs: [],
      currentContents: current(["/w/x.ts", "modified by B"]),
    });
    assert.strictEqual(plan.isSame, false);
    assert.deepStrictEqual(
      plan.filesToRevert.map((f) => f.uri),
      ["/w/x.ts"],
    );
    assert.strictEqual(plan.filesToRevert[0].contents, "orig");
  });

  it("target snapshot wins over a later snapshot of the same path", () => {
    const plan = computeRestorePlan({
      targetFiles: [snap("/w/x.ts", "pre-A")],
      laterFiles: [snap("/w/x.ts", "pre-B")],
      newlyCreatedFiles: [],
      newlyCreatedFolders: [],
      existingFolders: new Set(),
      activeInlineDiffs: [],
      currentContents: current(["/w/x.ts", "post-B"]),
    });
    assert.strictEqual(plan.filesToRevert[0].contents, "pre-A");
  });

  it("a path created after the target is deleted even when a later record snapshotted it", () => {
    // z.ts created during turn B (after target), snapshotted by B's "after"
    // capture loop. It did not exist at target time → delete, not revert.
    const plan = computeRestorePlan({
      targetFiles: [],
      laterFiles: [snap("/w/z.ts", "created contents")],
      newlyCreatedFiles: ["/w/z.ts"],
      newlyCreatedFolders: [],
      existingFolders: new Set(),
      activeInlineDiffs: [],
      currentContents: current(["/w/z.ts", "created contents"]),
    });
    assert.deepStrictEqual(plan.filesToRevert, []);
    assert.deepStrictEqual(plan.filesToDelete, ["/w/z.ts"]);
  });
});

describe("computeRestorePlan — non-existing folders are filtered", () => {
  it("a repeated restore is isSame when created folders are already gone", () => {
    const plan = computeRestorePlan({
      targetFiles: [],
      laterFiles: [],
      newlyCreatedFiles: [],
      newlyCreatedFolders: ["/w/gone-dir"],
      existingFolders: new Set(),
      activeInlineDiffs: [],
      currentContents: current(),
    });
    assert.deepStrictEqual(plan.foldersToDelete, []);
    assert.strictEqual(plan.isSame, true);
  });
});

describe("computeRestorePlan — activeInlineDiffs exclusion", () => {  it("never reverts URIs listed in activeInlineDiffs (Cursor parity)", () => {
    const plan = computeRestorePlan({
      targetFiles: [snap("/w/a.ts", "before"), snap("/w/b.ts", "before")],
      laterFiles: [],
      newlyCreatedFiles: [],
      newlyCreatedFolders: [],
      existingFolders: new Set(),
      activeInlineDiffs: ["/w/a.ts"],
      currentContents: current(["/w/a.ts", "changed"], ["/w/b.ts", "changed"]),
    });
    assert.deepStrictEqual(
      plan.filesToRevert.map((f) => f.uri),
      ["/w/b.ts"],
    );
  });
});

/* ---------- transcript rewind ---------- */
describe("bubbleStore.truncateAfter — transcript rewind on restore", () => {
  function makeStore(): { store: ComposerBubbleSetStore; ids: string[] } {
    const store = new ComposerBubbleSetStore();
    const ids: string[] = [];
    const roles = ["human", "assistant", "human", "assistant"] as const;
    for (let i = 0; i < roles.length; i++) {
      const id = `b${i + 1}`;
      const bubble: BubbleData = {
        bubbleId: id,
        role: roles[i],
        mode: "agent",
        text: `message ${i + 1}`,
        toolCalls: [],
        createdAt: Date.now() + i,
      };
      store.setBubbleData(bubble);
      ids.push(id);
    }
    return { store, ids };
  }

  it("drops every bubble after the target and returns the removed ids", () => {
    const { store } = makeStore();
    const removed = store.truncateAfter("b2");
    assert.deepStrictEqual(removed, ["b3", "b4"]);
    assert.deepStrictEqual(store.getOrderedIds(), ["b1", "b2"]);
    assert.strictEqual(store.getBubbleData("b3"), undefined);
  });

  it("is a no-op for an unknown bubble id", () => {
    const { store } = makeStore();
    const removed = store.truncateAfter("nope");
    assert.deepStrictEqual(removed, []);
    assert.strictEqual(store.getOrderedIds().length, 4);
  });

  it("keeps everything when truncating after the last bubble", () => {
    const { store } = makeStore();
    const removed = store.truncateAfter("b4");
    assert.deepStrictEqual(removed, []);
    assert.strictEqual(store.getOrderedIds().length, 4);
  });
});

/* ---------- per-record isNewlyCreated (Cursor record shape, OBSERVED) ---------- */
describe("computeRestorePlan — per-record isNewlyCreated", () => {
  function newSnap(uri: string, contents: string): FileSnapshot {
    return { uri, contents, isNewlyCreated: true };
  }

  function planInput(
    overrides: Partial<Parameters<typeof computeRestorePlan>[0]>,
  ): Parameters<typeof computeRestorePlan>[0] {
    return {
      targetFiles: [],
      laterFiles: [],
      newlyCreatedFiles: [],
      newlyCreatedFolders: [],
      existingFolders: new Set<string>(),
      activeInlineDiffs: [],
      currentContents: current(),
      ...overrides,
    };
  }

  it("deletes a later-record file flagged isNewlyCreated even when the legacy list is empty", () => {
    // The per-record flag drives the delete decision on its own.
    const plan = computeRestorePlan(
      planInput({
        laterFiles: [newSnap("/w/flagged.ts", "created")],
        currentContents: current(["/w/flagged.ts", "created"]),
      }),
    );
    assert.strictEqual(plan.isSame, false);
    assert.deepStrictEqual(plan.filesToDelete, ["/w/flagged.ts"]);
    assert.deepStrictEqual(plan.filesToRevert, []);
  });

  it("a target-snapshotted path wins over a later record's isNewlyCreated flag (revert, not delete)", () => {
    // f.ts existed at target time (target snapshot, not flagged), was deleted
    // and re-created later; the later record flags it newly created. Restore
    // must revert to the target contents, not delete.
    const plan = computeRestorePlan(
      planInput({
        targetFiles: [snap("/w/f.ts", "original")],
        laterFiles: [newSnap("/w/f.ts", "recreated")],
        currentContents: current(["/w/f.ts", "recreated"]),
      }),
    );
    assert.deepStrictEqual(plan.filesToDelete, []);
    assert.deepStrictEqual(
      plan.filesToRevert.map((f) => f.uri),
      ["/w/f.ts"],
    );
    assert.strictEqual(plan.filesToRevert[0].contents, "original");
  });

  it("reverts (never deletes) a target snapshot flagged isNewlyCreated (created by an earlier turn)", () => {
    // Sticky session flag: the file was created in an earlier turn but
    // existed at target time — the target's own flag must not cause deletion.
    const plan = computeRestorePlan(
      planInput({
        targetFiles: [newSnap("/w/early.ts", "at-target")],
        currentContents: current(["/w/early.ts", "modified-later"]),
      }),
    );
    assert.deepStrictEqual(plan.filesToDelete, []);
    assert.deepStrictEqual(
      plan.filesToRevert.map((f) => f.uri),
      ["/w/early.ts"],
    );
    assert.strictEqual(plan.filesToRevert[0].contents, "at-target");
  });

  it("legacy records without the field fall back to the newlyCreatedFiles[] list", () => {
    const legacySnap: FileSnapshot = { uri: "/w/z.ts", contents: "created contents" };
    assert.strictEqual("isNewlyCreated" in legacySnap, false, "legacy shape has no field");
    const plan = computeRestorePlan(
      planInput({
        laterFiles: [legacySnap],
        newlyCreatedFiles: ["/w/z.ts"],
        currentContents: current(["/w/z.ts", "created contents"]),
      }),
    );
    assert.deepStrictEqual(plan.filesToRevert, []);
    assert.deepStrictEqual(plan.filesToDelete, ["/w/z.ts"]);
  });

  it("isSame when a flagged file is already gone and nothing else changed", () => {
    const plan = computeRestorePlan(
      planInput({
        laterFiles: [newSnap("/w/gone.ts", "x")],
        currentContents: current(["/w/gone.ts", undefined]),
      }),
    );
    assert.deepStrictEqual(plan.filesToDelete, []);
    assert.strictEqual(plan.isSame, true);
  });
});
