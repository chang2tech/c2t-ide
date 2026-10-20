/**
 * checkpointPlan.ts — PURE module (no vscode import).
 *
 * The restore-plan half of Cursor-style checkpoints, factored out of
 * CheckpointService so it is unit-testable under plain node (node:test).
 *
 * Mirrors Cursor 3.25.6 behavior (docs/rea/parity-checkpoints.md):
 *  - restore = filesToRevert (snapshot contents written back) +
 *    newly-created files/folders deleted,
 *  - per-record `isNewlyCreated` (Cursor record shape, OBSERVED) drives the
 *    delete-vs-revert decision for snapshots that carry it; records without
 *    the field fall back to the `newlyCreatedFiles[]` union list,
 *  - snapshots are read in BOTH formats: legacy full-file `contents` and
 *    diff-based `originalModelDiffWrtV0` (binary identifier, OBSERVED —
 *    resolved against the session base map via resolveSnapshotContents()),
 *  - URIs in activeInlineDiffs are EXCLUDED from the revert set,
 *  - a file snapshotted at the target wins over the delete set (a file
 *    re-created later at the same path is reverted, not deleted),
 *  - restore is a no-op (isSame) when the current state already matches
 *    the checkpoint — determined by CONTENT comparison, not by position.
 */

import {
  OriginalModelDiffWrtV0,
  isValidDiff,
  reconstructOriginalLines,
} from "./checkpointDiff";

export interface FileSnapshot {
  /** Absolute fs path. */
  uri: string;
  /**
   * Legacy full-file snapshot contents (the format written before
   * diff-based snapshots existed). Still READ for backward compatibility;
   * new captures never write it.
   */
  contents?: string;
  /**
   * Diff-based snapshot: the original (pre-edit) model's diff with respect
   * to v0. Identifier verbatim from the Cursor binary (OBSERVED). Written
   * by new captures; resolved against the session base map on read via
   * resolveSnapshotContents().
   */
  originalModelDiffWrtV0?: OriginalModelDiffWrtV0;
  /** Cursor record shape also carries isNewlyCreated per file (OBSERVED). */
  isNewlyCreated?: boolean;
}

export interface RestorePlanInput {
  /** Pre-edit snapshots attached to the target ("before") checkpoint. */
  targetFiles: FileSnapshot[];
  /**
   * Snapshots from every checkpoint AFTER the target, in record order
   * (before- and after-records interleaved as captured). Used to widen the
   * revert set: a file first touched by a LATER turn has its earliest known
   * state in a later record — that state is also its target-time state
   * (no turn between target and that snapshot touched it, and the file
   * watcher covers external edits). The delete set still takes precedence.
   */
  laterFiles: FileSnapshot[];
  /**
   * Union of newlyCreatedFiles over the target checkpoint AND every
   * checkpoint after it. Files created during the target turn did not exist
   * at checkpoint time, so they are deleted on restore (Cursor parity:
   * "resources created after the checkpoint are deleted").
   *
   * BACKWARD COMPAT: this list is the fallback for records that predate the
   * per-record `isNewlyCreated` flag (GAPS-20). When a later-record snapshot
   * carries `isNewlyCreated: true`, the flag drives the delete decision even
   * when the path is absent from this list.
   */
  newlyCreatedFiles: string[];
  /** Union of newlyCreatedFolders over the target checkpoint and later ones. */
  newlyCreatedFolders: string[];
  /**
   * Folders from newlyCreatedFolders that still exist on disk right now.
   * Non-existing folders are filtered out of the plan (they need no action
   * and must not defeat isSame on a repeated restore).
   */
  existingFolders: Set<string>;
  /** Inline-diff URIs excluded from the revert set (Cursor parity). */
  activeInlineDiffs: string[];
  /**
   * Session base (v0) contents keyed by absolute path, used to resolve
   * diff-based snapshots (originalModelDiffWrtV0). Snapshots in the legacy
   * full-file format don't need it.
   */
  baseContents?: Map<string, string>;
  /**
   * Current on-disk contents keyed by absolute path.
   * `undefined` = the file does not exist / could not be read right now.
   */
  currentContents: Map<string, string | undefined>;
}

export interface RestorePlan {
  /**
   * Resolved snapshots to write back: uri + the original (pre-edit)
   * contents, with both legacy and diff-based formats already resolved.
   */
  filesToRevert: Array<{ uri: string; contents: string }>;
  /** Absolute paths to delete. */
  filesToDelete: string[];
  /** Absolute folder paths to delete (recursive). */
  foldersToDelete: string[];
  /** True when the target checkpoint is already the current state. */
  isSame: boolean;
}

/** Cursor's ComposerCheckpointService.areContentsEqual equivalent. */
export function areContentsEqual(a: string, b: string): boolean {
  return a === b;
}

/**
 * ComposerCheckpointService.validateCheckpointContent equivalent:
 * a snapshot is usable only when it names a non-empty absolute path and
 * carries either legacy string contents or a structurally valid
 * originalModelDiffWrtV0.
 */
export function validateSnapshot(snap: FileSnapshot): boolean {
  if (!snap || typeof snap.uri !== "string" || snap.uri.length === 0) {
    return false;
  }
  if (typeof snap.contents === "string") {
    return true; // legacy full-file format
  }
  return isValidDiff(snap.originalModelDiffWrtV0);
}

/**
 * Resolve a snapshot to its original (pre-edit) contents.
 *
 * - Legacy `{contents}` snapshots: returned as-is (backward compat).
 * - Diff-based `{originalModelDiffWrtV0}` snapshots: reconstructed from the
 *   session base (v0) map via reconstructOriginalLines().
 *
 * Returns undefined when the snapshot cannot be resolved (no contents, no
 * valid diff, or no base content for the uri / base mismatch). Callers must
 * skip such files — the Cursor equivalent is the observed
 * "[composer] No original file state found" skip path.
 */
export function resolveSnapshotContents(
  snap: FileSnapshot,
  baseContents?: Map<string, string>,
): string | undefined {
  if (typeof snap.contents === "string") {
    return snap.contents;
  }
  const diff = snap.originalModelDiffWrtV0;
  if (!isValidDiff(diff)) {
    return undefined;
  }
  const base = baseContents?.get(snap.uri);
  if (typeof base !== "string") {
    return undefined;
  }
  const lines = reconstructOriginalLines(diff, base.split("\n"));
  return lines?.join("\n");
}

/**
 * getFilesToRevertForCheckpoint equivalent. Pure: no fs access — the caller
 * supplies currentContents (best-effort reads).
 */
export function computeRestorePlan(input: RestorePlanInput): RestorePlan {
  const excluded = new Set(input.activeInlineDiffs);
  // Earliest known state per path, scanning target first then later records
  // in order. A path snapshotted at the target carries the target-time
  // state; a path first snapshotted later carries its state at that later
  // point, which equals its target-time state (nothing between touched it).
  const earliest = new Map<string, string>();
  for (const snap of [...input.targetFiles, ...input.laterFiles]) {
    if (!validateSnapshot(snap)) {
      continue;
    }
    if (!earliest.has(snap.uri)) {
      // Resolve both formats to contents here; unresolvable snapshots
      // (e.g. diff without a known base) are skipped — the Cursor
      // equivalent of the "No original file state found" skip.
      const contents = resolveSnapshotContents(snap, input.baseContents);
      if (contents !== undefined) {
        earliest.set(snap.uri, contents);
      }
    }
  }
  // Only the target's own snapshots exempt a path from the delete set: a
  // path first snapshotted by a LATER record did not exist (or was not
  // tracked) at target time — if it was also marked newly created, it goes.
  const targetSnapshotted = new Set<string>();
  for (const snap of input.targetFiles) {
    if (validateSnapshot(snap)) {
      targetSnapshotted.add(snap.uri);
    }
  }

  // Per-record isNewlyCreated (Cursor record shape, OBSERVED —
  // deepdig-runtime-checkpoint-2026-10-19.md §2: per file, `isNewlyCreated`
  // → `deleteFile` (log "[composer] Deleted newly created file X"), else
  // revert via applyDiffToLines). A snapshot in a LATER record flagged
  // newly-created means the file did not exist at target time — it was
  // created during or after the target turn — so it is deleted on restore.
  // This covers files the per-record flag tracks but the legacy list missed.
  // Records WITHOUT the field (legacy / pre-GAPS-20) contribute nothing here
  // and fall back to the newlyCreatedFiles[] union list below.
  //
  // HONEST-DIVERGENCE: the docs record the per-file delete semantics but not
  // exactly WHICH records' flags getFilesToRevertForCheckpoint consults, nor
  // the flag's stickiness. The target-position rule below (a target's OWN
  // snapshots never cause deletion) is our conservative reading: it can only
  // turn a delete into a revert for a file the target proves existed at
  // checkpoint time.
  const flaggedNew = new Set<string>();
  for (const snap of input.laterFiles) {
    if (
      snap.isNewlyCreated === true &&
      typeof snap.uri === "string" &&
      snap.uri.length > 0
    ) {
      flaggedNew.add(snap.uri);
    }
  }

  // A path snapshotted at the target wins over the delete set: a file that
  // existed at checkpoint time, was deleted later and re-created later, is
  // reverted to its checkpoint contents — not deleted. The exemption applies
  // to BOTH the legacy list and the per-record flag: a later record
  // re-flagging a target-snapshotted path must not turn a revert into a
  // delete. (A target's OWN isNewlyCreated snapshots — a sticky session flag
  // for files created by an earlier turn — likewise revert, never delete.)
  const deleteSet = new Set<string>();
  for (const f of new Set(input.newlyCreatedFiles)) {
    if (targetSnapshotted.has(f)) {
      continue;
    }
    deleteSet.add(f);
  }
  for (const f of flaggedNew) {
    if (targetSnapshotted.has(f)) {
      continue;
    }
    deleteSet.add(f);
  }

  const filesToRevert: Array<{ uri: string; contents: string }> = [];
  for (const [uri, contents] of earliest) {
    if (excluded.has(uri)) {
      continue; // activeInlineDiffs are never reverted (Cursor parity).
    }
    if (deleteSet.has(uri)) {
      continue; // deleted, not reverted (handled below).
    }
    const current = input.currentContents.get(uri);
    if (current === undefined || !areContentsEqual(current, contents)) {
      filesToRevert.push({ uri, contents });
    }
  }

  const filesToDelete: string[] = [];
  for (const f of deleteSet) {
    if (input.currentContents.get(f) !== undefined) {
      filesToDelete.push(f);
    }
  }

  const foldersToDelete = [...new Set(input.newlyCreatedFolders)].filter((f) =>
    input.existingFolders.has(f),
  );

  const isSame =
    filesToRevert.length === 0 && filesToDelete.length === 0 && foldersToDelete.length === 0;

  return { filesToRevert, filesToDelete, foldersToDelete, isSame };
}
