/**
 * checkpointPlan.ts — PURE module (no vscode import).
 *
 * The restore-plan half of Cursor-style checkpoints, factored out of
 * CheckpointService so it is unit-testable under plain node (node:test).
 *
 * Mirrors Cursor 3.25.6 behavior (docs/rea/parity-checkpoints.md):
 *  - restore = filesToRevert (snapshot contents written back) +
 *    newly-created files/folders deleted,
 *  - URIs in activeInlineDiffs are EXCLUDED from the revert set,
 *  - a file snapshotted at the target wins over the delete set (a file
 *    re-created later at the same path is reverted, not deleted),
 *  - restore is a no-op (isSame) when the current state already matches
 *    the checkpoint — determined by CONTENT comparison, not by position.
 */

export interface FileSnapshot {
  /** Absolute fs path. */
  uri: string;
  contents: string;
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
   * Current on-disk contents keyed by absolute path.
   * `undefined` = the file does not exist / could not be read right now.
   */
  currentContents: Map<string, string | undefined>;
}

export interface RestorePlan {
  /** Snapshots to write back (uri+contents). */
  filesToRevert: FileSnapshot[];
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
 * carries string contents.
 */
export function validateSnapshot(snap: FileSnapshot): boolean {
  return (
    !!snap &&
    typeof snap.uri === "string" &&
    snap.uri.length > 0 &&
    typeof snap.contents === "string"
  );
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
      earliest.set(snap.uri, snap.contents);
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

  // A path snapshotted at the target wins over the delete set: a file that
  // existed at checkpoint time, was deleted later and re-created later, is
  // reverted to its checkpoint contents — not deleted.
  const deleteSet = new Set<string>();
  for (const f of new Set(input.newlyCreatedFiles)) {
    if (targetSnapshotted.has(f)) {
      continue;
    }
    deleteSet.add(f);
  }

  const filesToRevert: FileSnapshot[] = [];
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
