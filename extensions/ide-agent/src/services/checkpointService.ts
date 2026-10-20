import * as vscode from "vscode";
import * as path from "path";
import { promises as fs } from "fs";
import { ToolCallViewModel } from "../model";
import {
  FileSnapshot,
  computeRestorePlan,
  resolveSnapshotContents,
} from "./checkpointPlan";
import { computeLineDiff } from "./checkpointDiff";
import {
  CheckpointStorageCompareService,
  SessionCompareResult,
  StorageCompareTimer,
} from "./checkpointStorageCompare";

export { FileSnapshot };

/**
 * CheckpointService — Cursor-style checkpoints with real file restore.
 *
 * Mirrors Cursor 3.25.6's ComposerCheckpointService (parity-checkpoints.md):
 *  - Per-bubble checkpoints: "before" captured on user-message send,
 *    "after" captured on generation end.
 *  - File snapshots are DIFF-BASED (binary evidence, Cursor 3.25.6/3.25.9 —
 *    see docs/rea/deepdig-runtime-checkpoint-2026-10-19.md §2): each file
 *    record carries `originalModelDiffWrtV0` (original model's diff wrt v0)
 *    instead of full contents; one base (v0) content per file is kept in a
 *    session base map. Restore reconstructs the original via
 *    applyDiffToLines and writes it back. Legacy full-file `contents`
 *    snapshots are still READ (backward compat) but never written.
 *  - `newlyCreatedFiles[]`, `newlyCreatedFolders[]` (deleted on restore),
 *    plus per-record `isNewlyCreated` on each file snapshot (Cursor record
 *    shape, OBSERVED): the restore plan prefers the per-record flag and falls
 *    back to the lists for legacy records without the field.
 *  - Restore reverts files to snapshot contents, deletes newly-created
 *    files/folders. PRODUCT DECISION 2026-10-19 (files-only): restoring does
 *    NOT rewind the conversation transcript — do NOT re-add transcript
 *    truncation here; cursor.com/docs/agent: "Restoring a checkpoint reverts
 *    files only; it does not remove messages from the conversation."
 *  - Disk-persisted (JSON under globalStorageUri), retention = chat lifetime.
 *
 * Capture strategy (honest, no git dependency): mutating tool-call events
 * (edit/write/patch/delete) arrive with a `filePath` while the tool is still
 * pending — i.e. BEFORE the edit runs. noteToolCall() snapshots the file's
 * current contents at that moment (pre-edit state). Files the agent never
 * touches are never snapshotted and are never reverted — restore only
 * touches what the agent changed, which is exactly what checkpoints mean.
 *
 * Safety: every path is resolved and required to live inside the workspace
 * root before any read or write. Snapshots are size-capped (100MB per file,
 * 1GB per checkpoint — raised 100x per user directive 2026-10-19, no
 * artificial limits); binary files are skipped.
 */

export interface CheckpointRecord {
  checkpointId: string;
  bubbleId: string;
  createdAt: number;
  /** Updated every time the record is mutated (snapshot added, folder noted). */
  lastUpdatedAt: number;
  label: string;
  /** false = "before" (on user send); true = "after" (on generation end). */
  isAfter: boolean;
  /** Pre-edit snapshots of files the agent touched up to this point. */
  files: FileSnapshot[];
  /** Files created by the agent up to this point (deleted on restore). */
  newlyCreatedFiles: string[];
  /** Folders created by the agent up to this point (deleted on restore). */
  newlyCreatedFolders: string[];
  /**
   * URIs excluded from the revert set on restore (Cursor parity:
   * activeInlineDiffs). Populated by inline-diff flows; empty otherwise.
   */
  activeInlineDiffs: string[];
}

export interface RestoreResult {
  reverted: string[];
  deleted: string[];
  /** True when the target checkpoint is already the current state. */
  isSame: boolean;
  /**
   * True when the user declined/dismissed the restore confirmation dialog —
   * the restore was aborted and NOTHING was reverted. Callers must treat a
   * cancelled restore as a no-op (do NOT fire checkpoint-restored events).
   */
  cancelled?: boolean;
}

// Cursor parity — restore confirmation dialog (binary-verified, Cursor 3.25.9,
// DIG-CONTINUOUS 2026-10-19: workbench.desktop.main.js
// `openDialog({title:"Discard all changes up to this checkpoint?", ...})`).
// Verbatim strings from the binary — do NOT paraphrase.
const CHECKOUT_DIALOG_TITLE = "Discard all changes up to this checkpoint?";
const CHECKOUT_DIALOG_MESSAGE = "You can always undo this later.";
const CHECKOUT_DIALOG_NOTEBOOK_NOTE =
  "\nNote: Notebook cells are not supported for reverting.";
/** dontAskAgain persistence key (Cursor: dialogKey "composer-checkout-to-message"). */
const CHECKOUT_DIALOG_KEY = "composer-checkout-to-message";

// NOTE (user directive 2026-10-19): our own system, no artificial caps.
// Raised 100x from 1MB/10MB — effectively unlimited for real usage; the only
// remaining bound is disk space.
const MAX_FILE_SNAPSHOT_BYTES = 100_000_000;
const MAX_CHECKPOINT_BYTES = 1_000_000_000;
// Cursor-style mutating tool kinds (Cursor names, from toCursorToolName).
const MUTATING_KINDS = new Set([
  "edit_tool_call", // edit + write
  "apply_agent_diff_tool_call", // patch
  "delete_tool_call", // delete
]);
const SKIP_DIR_PARTS = new Set(["node_modules", ".git", "dist", "out", ".vscode-test"]);

let checkpointSeq = 0;

export class CheckpointService {
  private records: CheckpointRecord[] = [];
  /** Files the agent has touched (absolute paths), for snapshot-on-capture. */
  private trackedFiles = new Set<string>();
  /**
   * Session base (v0) contents per file: the content at the file's FIRST
   * snapshot in this session. Diff-based snapshots
   * (`originalModelDiffWrtV0`) are computed against this base and resolved
   * through it on restore. Persisted alongside records; cleared with them.
   */
  private bases = new Map<string, string>();
  /**
   * Absolute paths of files created during this session. Populated by
   * noteToolCall() when the tool is still pending and the file doesn't exist
   * yet; rebuilt from persisted records on load. Backs the per-record
   * `isNewlyCreated` flag on file snapshots (Cursor record shape, OBSERVED —
   * deepdig-runtime-checkpoint-2026-10-19.md §2: per file, `isNewlyCreated`
   * → `deleteFile`, else revert): a snapshot is flagged iff the file was
   * created during this session. Sticky for the session — a path created
   * once stays flagged even when later snapshots capture its post-creation
   * state (the target-position rule in computeRestorePlan decides delete vs
   * revert, not the flag alone).
   *
   * HONEST-DIVERGENCE: the docs record the per-file delete semantics but not
   * the flag's exact stickiness; session-sticky is our reading of "newly
   * created".
   */
  private sessionNewlyCreated = new Set<string>();
  /**
   * DEV-GAPS-66/W66B (`checkpoint-latest-snapshot-on-first-restore`): the
   * "latest" snapshot — the current on-disk contents of every tracked
   * file, captured on a user-initiated checkout BEFORE any file is
   * mutated (binary `createCheckoutCallback`'s capture closure `l()`,
   * workbench.desktop.main.js 3.25.9 @18862565, stored under
   * `latestCheckpointId`). `checkoutToLatest()` restores THIS snapshot
   * (binary @18869413: retrieve `latestCheckpointId` → checkout to it),
   * so user edits made after generation end — which no "after" record
   * ever captured — survive the undo. (The previous behavior re-applied
   * the latest "after" record and silently dropped those edits.)
   * Value `null` = the file did not exist at capture time (redo deletes
   * it). Persisted alongside records/bases.
   */
  private latestSnapshot: { capturedAt: number; files: Record<string, string | null> } | undefined;
  /**
   * True between a successful checkout and its undo (or the next turn's
   * capture) — the fork analog of the binary's `currentBubbleId !==
   * undefined` guard: the latest snapshot is captured only while NOT
   * checked out, so restoring from one checkpoint to another never
   * overwrites the redo target with an already-restored state.
   */
  private checkedOut = false;
  private watcher?: vscode.FileSystemWatcher;
  private loaded = false;
  private saveChain: Promise<void> = Promise.resolve();
  /** Serializes checkpoint captures (Cursor parity: _checkpointCommitSequencer). */
  private captureChain: Promise<void> = Promise.resolve();
  private readonly composerId = "default";
  /**
   * Host-storage compare scheduling (Cursor parity: cursor-agent-host
   * class `pw` — 60 s checkpoint debounce, 10 min compare interval, 15 s
   * activation delay; see checkpointStorageCompare.ts for evidence).
   * noteCheckpoint(composerId) is fired after every successful persist.
   */
  private readonly storageCompare: CheckpointStorageCompareService;

  constructor(
    private readonly context?: vscode.ExtensionContext,
    opts?: {
      storageCompare?: CheckpointStorageCompareService;
      /** Test hook: virtual timer for the internally built compare service. */
      storageCompareTimer?: StorageCompareTimer;
      /** Test hook: log sink for the internally built compare service. */
      storageCompareLog?: (message: string) => void;
    },
  ) {
    this.storageCompare =
      opts?.storageCompare ??
      new CheckpointStorageCompareService({
        timer: opts?.storageCompareTimer,
        onLog: opts?.storageCompareLog,
        compareSessions: (sessionIds) => this.verifyCheckpointStorage(sessionIds),
      });
    this.storageCompare.start();
    // Safety net: track files changed outside tool events (user edits, other
    // extensions) so future checkpoints at least capture their contents.
    // Pre-edit contents can't be recovered here — only tool-driven snapshots
    // are pre-edit; this just keeps the tracked set complete.
    if (vscode.workspace.workspaceFolders?.length) {
      this.watcher = vscode.workspace.createFileSystemWatcher("**/*");
      const track = (uri: vscode.Uri) => {
        const abs = path.normalize(uri.fsPath);
        if (this.isInsideWorkspace(abs)) {
          this.trackedFiles.add(abs);
        }
      };
      this.watcher.onDidChange(track);
      this.watcher.onDidCreate(track);
      context?.subscriptions.push(this.watcher);
    }
  }

  dispose(): void {
    this.watcher?.dispose();
    this.storageCompare.dispose();
  }

  // ------------------------------------------------------------------ //
  // Capture                                                             //
  // ------------------------------------------------------------------ //

  /**
   * "Before" checkpoint, called on user-message send. Snapshots the current
   * contents of every tracked file (post-previous-turn state).
   */
  async captureBefore(bubbleId: string, label: string): Promise<CheckpointRecord> {
    return this.capture(bubbleId, label, false);
  }

  /** "After" checkpoint, called when generation completes. */
  async captureAfter(bubbleId: string, label: string): Promise<CheckpointRecord> {
    return this.capture(bubbleId, label, true);
  }

  /**
   * Back-compat alias (composerDataService.runTurn): a "before" checkpoint.
   */
  snapshot(bubbleId: string, label: string): Promise<CheckpointRecord> {
    return this.captureBefore(bubbleId, label);
  }

  private capture(
    bubbleId: string,
    label: string,
    isAfter: boolean,
  ): Promise<CheckpointRecord> {
    // Serialize captures so concurrent turns can't interleave snapshot reads
    // and record appends (Cursor parity: _checkpointCommitSequencer).
    const run = this.captureChain.then(() => this.captureOnce(bubbleId, label, isAfter));
    // Keep the chain alive even when one capture fails.
    this.captureChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Cursor parity: capture retries once on workspace failure before throwing
   * ("Checkpoint capture failed; waiting for workspace recovery before retry").
   */
  private async captureOnce(
    bubbleId: string,
    label: string,
    isAfter: boolean,
  ): Promise<CheckpointRecord> {
    await this.ensureLoaded();
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.captureBody(bubbleId, label, isAfter);
      } catch (err) {
        lastError = err;
        if (attempt === 0) {
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
    }
    throw lastError;
  }

  private async captureBody(
    bubbleId: string,
    label: string,
    isAfter: boolean,
  ): Promise<CheckpointRecord> {
    // DEV-GAPS-66/W66B: a new generation's capture ends the checked-out
    // state (binary: submitting moves the composer off the restored
    // bubble), so the NEXT user-initiated checkout captures a fresh
    // pre-restore "latest" snapshot instead of keeping the stale one.
    this.checkedOut = false;
    checkpointSeq += 1;
    const record: CheckpointRecord = {
      checkpointId: `ckpt-${Date.now().toString(36)}-${checkpointSeq}`,
      bubbleId,
      createdAt: Date.now(),
      lastUpdatedAt: Date.now(),
      label: label.slice(0, 60) || "message",
      isAfter,
      files: [],
      newlyCreatedFiles: [],
      newlyCreatedFolders: [],
      activeInlineDiffs: [],
    };
    // Snapshot current contents of all tracked files (bounded), as diffs
    // against the session base (v0).
    let bytes = 0;
    for (const abs of this.trackedFiles) {
      const r = await this.snapshotFile(abs);
      if (!r) {
        continue;
      }
      bytes += r.bytes;
      if (bytes > MAX_CHECKPOINT_BYTES) {
        break;
      }
      record.files.push(r.snap);
    }
    this.records.push(record);
    await this.persist();
    return record;
  }

  /**
   * Called for every toolCall event while it is still pending — i.e. BEFORE
   * the tool runs. Records the pre-edit file state into the latest
   * checkpoint, or marks the path as newly created when it doesn't exist.
   */
  async noteToolCall(toolCall: ToolCallViewModel): Promise<void> {
    if (!MUTATING_KINDS.has(toolCall.kind)) {
      return;
    }
    const raw = toolCall.filePath;
    if (typeof raw !== "string" || raw.length === 0) {
      return;
    }
    const abs = this.resolveInWorkspace(raw);
    if (!abs) {
      return;
    }
    await this.ensureLoaded();
    const latest = this.records[this.records.length - 1];
    if (!latest) {
      // No checkpoint yet (shouldn't happen — captureBefore runs on send) —
      // still track the file so the next capture snapshots it.
      this.trackedFiles.add(abs);
      return;
    }
    if (latest.newlyCreatedFiles.includes(abs) || latest.files.some((f) => f.uri === abs)) {
      this.trackedFiles.add(abs);
      return;
    }
    let exists = false;
    try {
      const stat = await fs.stat(abs);
      exists = stat.isFile();
    } catch {
      exists = false;
    }
    if (!exists) {
      // File doesn't exist yet at tool-pending time: the tool is about to
      // create it → restore must delete it.
      latest.newlyCreatedFiles.push(abs);
      // Also record it in the session set backing the per-record
      // isNewlyCreated flag (Cursor record shape): any snapshot of this
      // path taken later in the session carries isNewlyCreated: true.
      this.sessionNewlyCreated.add(abs);
      // Parent folders that don't exist yet either are about to be created
      // by the tool (write creates parents) → track them for folder cleanup
      // on restore (Cursor parity: newlyCreatedFolders).
      await this.trackMissingParents(abs);
    } else {
      const snap = await this.readSnapshot(abs);
      if (snap) {
        latest.files.push(snap);
      }
    }
    this.trackedFiles.add(abs);
    latest.lastUpdatedAt = Date.now();
    await this.persist();
  }

  /**
   * Record ancestor folders that don't exist at tool-pending time (bounded:
   * 4 levels up to the workspace root). The tool is about to create them.
   */
  private async trackMissingParents(abs: string): Promise<void> {
    const root = this.workspaceRoot();
    if (!root) {
      return;
    }
    await this.ensureLoaded();
    const latest = this.records[this.records.length - 1];
    if (!latest) {
      return;
    }
    let dir = path.dirname(abs);
    for (let depth = 0; depth < 4; depth++) {
      if (dir === root || !this.isInsideWorkspace(dir)) {
        break;
      }
      let exists = false;
      try {
        const stat = await fs.stat(dir);
        exists = stat.isDirectory();
      } catch {
        exists = false;
      }
      if (exists) {
        break; // an existing ancestor covers everything above it.
      }
      if (!latest.newlyCreatedFolders.includes(dir)) {
        latest.newlyCreatedFolders.push(dir);
        latest.lastUpdatedAt = Date.now();
      }
      dir = path.dirname(dir);
    }
  }

  /** Record a folder the agent created (deleted on restore). */
  async noteFolderCreated(rawPath: string): Promise<void> {
    const abs = this.resolveInWorkspace(rawPath);
    if (!abs) {
      return;
    }
    await this.ensureLoaded();
    const latest = this.records[this.records.length - 1];
    if (latest && !latest.newlyCreatedFolders.includes(abs)) {
      latest.newlyCreatedFolders.push(abs);
      latest.lastUpdatedAt = Date.now();
      await this.persist();
    }
  }

  // ------------------------------------------------------------------ //
  // Restore                                                             //
  // ------------------------------------------------------------------ //

  /**
   * checkout_to_message: restore files to the checkpoint attached to the
   * given bubble ("before" record), delete files/folders created at or after
   * it.
   *
   * Cursor parity: a confirmation dialog (confirmCheckoutToCheckpoint)
   * is shown before the restore executes — "Discard all changes up to this
   * checkpoint?" — with a don't-ask-again opt-out persisted under the
   * "composer-checkout-to-message" dialog key. Cancel/dismiss aborts the
   * restore (returned with `cancelled: true`).
   *
   * PRODUCT DECISION 2026-10-19 (files-only): this deliberately does NOT
   * touch the conversation transcript — the transcript is left intact.
   * Do NOT re-add transcript rewinding here.
   *
   * The restore PLAN is computed by the pure computeRestorePlan()
   * (checkpointPlan.ts): content comparison decides what actually needs
   * reverting (Cursor: areContentsEqual), activeInlineDiffs URIs are
   * excluded from the revert set, and a path snapshotted at the target
   * wins over the delete set.
   *
   * @param opts.skipConfirm — skip the "Discard all changes up to this
   * checkpoint?" confirmation dialog. Used ONLY by the edit-resubmit flow
   * (chatResubmitService): the resubmit dialog ("Continue and revert" /
   * "Continue without reverting") is itself the confirmation, and Cursor
   * skips the checkout dialog on the submit-chat path (binary `fromSubmitChat`
   * note). The user-initiated revertToCheckpoint path always shows it.
   */
  async checkoutToCheckpoint(
    bubbleId: string,
    opts?: { skipConfirm?: boolean },
  ): Promise<RestoreResult> {
    await this.ensureLoaded();
    const target = this.beforeRecordFor(bubbleId);
    if (!target) {
      return { reverted: [], deleted: [], isSame: false };
    }
    const targetIdx = this.records.indexOf(target);

    // Union of newly-created files/folders over the target checkpoint and
    // every checkpoint after it. Files created DURING the target turn did
    // not exist at checkpoint time, so they are deleted too (Cursor parity:
    // "resources created after the checkpoint are deleted").
    const newlyCreatedFiles: string[] = [];
    const newlyCreatedFolders: string[] = [];
    const laterFiles: FileSnapshot[] = [];
    for (let i = targetIdx; i < this.records.length; i++) {
      newlyCreatedFiles.push(...this.records[i].newlyCreatedFiles);
      newlyCreatedFolders.push(...this.records[i].newlyCreatedFolders);
      if (i > targetIdx) {
        laterFiles.push(...this.records[i].files);
      }
    }

    // Best-effort read of current on-disk contents for every candidate path
    // so the plan can compare by content instead of blindly rewriting.
    const candidates = new Set<string>([
      ...target.files.map((f) => f.uri),
      ...laterFiles.map((f) => f.uri),
      ...newlyCreatedFiles,
    ]);
    const currentContents = new Map<string, string | undefined>();
    for (const abs of candidates) {
      currentContents.set(abs, await this.readCurrentContents(abs));
    }
    const existingFolders = new Set<string>();
    for (const d of newlyCreatedFolders) {
      try {
        const stat = await fs.stat(d);
        if (stat.isDirectory()) {
          existingFolders.add(d);
        }
      } catch {
        // Gone already — no action needed.
      }
    }

    const plan = computeRestorePlan({
      targetFiles: target.files,
      laterFiles,
      newlyCreatedFiles,
      newlyCreatedFolders,
      existingFolders,
      activeInlineDiffs: target.activeInlineDiffs,
      currentContents,
      // Resolves diff-based snapshots (originalModelDiffWrtV0) against the
      // session base (v0); legacy full-file snapshots don't need it.
      baseContents: this.bases,
    });
    if (plan.isSame) {
      // Cursor parity: "[composer] Checkout to message is the same as current".
      return { reverted: [], deleted: [], isSame: true };
    }

    // Cursor parity: confirmation dialog before the restore executes. The
    // plan is computed FIRST so the dialog can tell whether notebooks are in
    // the revert set (drives the notebook note in the dialog message).
    // The edit-resubmit flow passes skipConfirm: the resubmit dialog is the
    // confirmation (Cursor skips the checkout dialog on submit-chat).
    const confirmed =
      opts?.skipConfirm === true ||
      (await this.confirmCheckoutToCheckpoint(plan.filesToRevert.map((s) => s.uri)));
    if (!confirmed) {
      // User pressed Cancel or dismissed the dialog — abort, do NOT restore.
      return { reverted: [], deleted: [], isSame: false, cancelled: true };
    }

    // DEV-GAPS-66/W66B (`checkpoint-latest-snapshot-on-first-restore`):
    // capture the pre-restore workspace state as the "latest" snapshot
    // BEFORE mutating any file (binary createCheckoutCallback's `l()`
    // closure, workbench.desktop.main.js 3.25.9 @18862565 — invoked after
    // the dialog, before the checkout). Guards mirror the binary:
    // skipped on the submit-chat path (fork: skipConfirm) and skipped
    // while already checked out (`currentBubbleId !== undefined`), so a
    // checkpoint-to-checkpoint restore never clobbers the redo target.
    if (opts?.skipConfirm !== true && !this.checkedOut) {
      await this.captureLatestSnapshot();
    }

    const result: RestoreResult = { reverted: [], deleted: [], isSame: false };
    // 1. Revert snapshotted files to their checkpoint contents.
    for (const snap of plan.filesToRevert) {
      try {
        await fs.mkdir(path.dirname(snap.uri), { recursive: true });
        await vscode.workspace.fs.writeFile(
          vscode.Uri.file(snap.uri),
          Buffer.from(snap.contents, "utf8"),
        );
        result.reverted.push(snap.uri);
      } catch {
        // Best-effort per file; one failure must not abort the restore.
      }
    }
    // 2. Delete files created at/after the target checkpoint.
    for (const f of plan.filesToDelete) {
      try {
        await vscode.workspace.fs.delete(vscode.Uri.file(f));
        result.deleted.push(f);
      } catch {
        // File may already be gone — not an error.
      }
    }
    // 3. Delete folders created at/after the target checkpoint, deepest
    // first. Non-recursive rmdir on purpose: it only removes folders that
    // are now empty, so content the agent didn't create (user files,
    // untracked outputs) is never wiped. Intentional, documented deviation
    // from Cursor's recursive delete — a safety improvement.
    const byDepth = [...plan.foldersToDelete].sort(
      (a, b) => b.split(path.sep).length - a.split(path.sep).length,
    );
    for (const d of byDepth) {
      try {
        await fs.rmdir(d);
        result.deleted.push(d);
      } catch {
        // Non-empty, already gone, or not ours — leave it alone.
      }
    }
    // DEV-GAPS-66/W66B: the composer is now in the checked-out state
    // (binary: currentBubbleId = target bubble) until undo/new capture.
    this.checkedOut = true;
    return result;
  }

  /**
   * DEV-GAPS-66/W66B: capture the CURRENT on-disk contents of every
   * tracked file into the "latest" snapshot (binary
   * `createCurrentCheckpoint`/`captureCurrentCheckpoint`,
   * workbench.desktop.main.js 3.25.9 @18870047/@18869447: iterates
   * `getUrisForCheckpoints(composerData)` — every file the conversation
   * has touched — and stores each file's current contents;
   * non-existent files are recorded as absent). The binary create-or-
   * updates the checkpoint stored under `latestCheckpointId`; the fork
   * keeps a single snapshot object, replaced wholesale.
   */
  private async captureLatestSnapshot(): Promise<void> {
    const uris = new Set<string>(this.trackedFiles);
    for (const r of this.records) {
      for (const f of r.files ?? []) {
        uris.add(f.uri);
      }
      for (const f of r.newlyCreatedFiles ?? []) {
        uris.add(f);
      }
    }
    const files: Record<string, string | null> = {};
    for (const uri of uris) {
      const contents = await this.readCurrentContents(uri);
      files[uri] = contents === undefined ? null : contents;
    }
    this.latestSnapshot = { capturedAt: Date.now(), files };
    await this.persist();
  }

  /**
   * Cursor-parity restore confirmation dialog ("checkout to message").
   *
   * Binary (Cursor 3.25.9, workbench.desktop.main.js):
   *   await this._prettyDialogService.openDialog({
   *     title: "Discard all changes up to this checkpoint?",
   *     message: g,  // "You can always undo this later." (+ notebook note)
   *     cancelButton: { id: "cancel", label: "Cancel" },
   *     primaryButton: { id: "continue", label: "Continue" },
   *     shouldShowDontAskAgain: true,
   *     dialogKey: "composer-checkout-to-message",
   *   }) !== "continue" → return (abort the restore).
   *
   * The notebook note ("\nNote: Notebook cells are not supported for
   * reverting.") is appended when the revert set contains .ipynb files.
   *
   * HONEST DIVERGENCES (VS Code API limits, not choices):
   *  1. VS Code's `showWarningMessage` has no native don't-ask-again checkbox
   *     (Cursor uses its own _prettyDialogService with shouldShowDontAskAgain),
   *     so the checkbox is approximated with a third "Don't ask again"
   *     button: choosing it proceeds with the restore AND records the
   *     preference (Cursor's checkbox only suppresses the dialog on the next
   *     restore — this is the common VS Code convention instead).
   *  2. The preference is persisted in the `ide.agent` workspace
   *     configuration under Cursor's dialogKey "composer-checkout-to-message"
   *     (true = skip the dialog). globalState was considered but
   *     getConfiguration works even when no ExtensionContext is available.
   *  3. Cursor's dialog has a separate title field; VS Code's API takes a
   *     single message string, so the title is prepended with "\n\n".
   *
   * UNKNOWN (RESOLVED 2026-10-20): the binary skips this dialog for
   * `fromSubmitChat`. That path now exists — the edit-resubmit flow
   * (chatResubmitService → composerDataService.resubmitEditedMessage) calls
   * checkoutToCheckpoint with skipConfirm: true, because the resubmit dialog
   * ("Continue and revert" / "Continue without reverting") is itself the
   * confirmation. The dialog is still always shown on the user-initiated
   * revertToCheckpoint path; no other caller passes skipConfirm.
   *
   * Returns true when the restore may proceed, false when the user pressed
   * Cancel or dismissed the dialog (restore must be aborted).
   */
  private async confirmCheckoutToCheckpoint(revertUris: string[]): Promise<boolean> {
    const config = vscode.workspace.getConfiguration("ide.agent");
    try {
      if (config.get<boolean>(CHECKOUT_DIALOG_KEY, false) === true) {
        return true; // don't-ask-again was recorded earlier — skip the dialog.
      }
    } catch {
      // Config read failure: fall through and show the dialog (safe default).
    }
    const hasNotebooks = revertUris.some((u) => u.toLowerCase().endsWith(".ipynb"));
    const message =
      CHECKOUT_DIALOG_TITLE +
      "\n\n" +
      CHECKOUT_DIALOG_MESSAGE +
      (hasNotebooks ? CHECKOUT_DIALOG_NOTEBOOK_NOTE : "");
    const CONTINUE = "Continue";
    const CANCEL = "Cancel";
    const DONT_ASK_AGAIN = "Don't ask again";
    let choice: string | undefined;
    try {
      choice = await vscode.window.showWarningMessage(
        message,
        { modal: true },
        CONTINUE,
        CANCEL,
        DONT_ASK_AGAIN,
      );
    } catch {
      // Dialog failure (headless/test env) — fail closed: never restore blind.
      return false;
    }
    if (choice === DONT_ASK_AGAIN) {
      try {
        await config.update(CHECKOUT_DIALOG_KEY, true, vscode.ConfigurationTarget.Global);
      } catch {
        // Persistence is best-effort; the restore still proceeds.
      }
      return true;
    }
    return choice === CONTINUE;
  }

  /**
   * Best-effort current file contents for plan comparison; undefined when
   * the file is missing or unreadable. Files larger than 8MB are treated as
   * "differs" without reading them into memory (bounded memory; the revert
   * writes back the ≤1MB snapshot).
   */
  private async readCurrentContents(abs: string): Promise<string | undefined> {
    try {
      const stat = await fs.stat(abs);
      if (!stat.isFile()) {
        return undefined;
      }
      if (stat.size > 8_000_000) {
        return "\0OVERSIZE\0";
      }
      return (await fs.readFile(abs)).toString("utf8");
    } catch {
      return undefined;
    }
  }

  /**
   * checkoutToLatest: undo a restore by re-applying the "latest" snapshot
   * captured at restore time — the exact pre-restore workspace state
   * (binary `checkoutToLatest`, workbench.desktop.main.js 3.25.9
   * @18869413: retrieve the checkpoint stored under `latestCheckpointId`
   * and check out to it; "[composer] No latest checkpoint found for the
   * composer" + no-op when none exists).
   *
   * DEV-GAPS-66/W66B: this used to re-apply the latest "after" record,
   * which silently dropped user edits made after generation end (no
   * "after" record ever contains them). Files absent at capture time
   * (null) are deleted; files the snapshot doesn't know are untouched —
   * the same file-set discipline as the binary's checkout.
   */
  async checkoutToLatest(): Promise<RestoreResult> {
    await this.ensureLoaded();
    const snapshot = this.latestSnapshot;
    if (!snapshot) {
      return { reverted: [], deleted: [], isSame: true };
    }
    const result: RestoreResult = { reverted: [], deleted: [], isSame: false };
    for (const [uri, contents] of Object.entries(snapshot.files)) {
      if (contents === null) {
        try {
          await vscode.workspace.fs.delete(vscode.Uri.file(uri));
          result.deleted.push(uri);
        } catch {
          // Already gone — not an error.
        }
        continue;
      }
      try {
        await fs.mkdir(path.dirname(uri), { recursive: true });
        await vscode.workspace.fs.writeFile(
          vscode.Uri.file(uri),
          Buffer.from(contents, "utf8"),
        );
        result.reverted.push(uri);
      } catch {
        // Best-effort per file.
      }
    }
    // Back at the latest state (binary: the redo checkout clears
    // currentBubbleId), so the next restore captures fresh.
    this.checkedOut = false;
    return result;
  }

  // ------------------------------------------------------------------ //
  // Queries                                                             //
  // ------------------------------------------------------------------ //

  list(): CheckpointRecord[] {
    return [...this.records];
  }

  get(checkpointId: string): CheckpointRecord | undefined {
    return this.records.find((r) => r.checkpointId === checkpointId);
  }

  /** The "before" checkpoint for a bubble (what restore targets). */
  getByBubble(bubbleId: string): CheckpointRecord | undefined {
    return this.beforeRecordFor(bubbleId);
  }

  private beforeRecordFor(bubbleId: string): CheckpointRecord | undefined {
    return this.records.find((r) => r.bubbleId === bubbleId && !r.isAfter);
  }

  /** Drop checkpoints whose bubbles no longer exist (after a restore). */
  prune(keepBubbleIds: Set<string>): void {
    this.records = this.records.filter((r) => keepBubbleIds.has(r.bubbleId));
    void this.persist();
  }

  /**
   * Retention = chat lifetime. Clears all checkpoints for this composer
   * (disk + memory) — called when a new chat starts.
   */
  async clearComposerCheckpoints(): Promise<void> {
    this.records = [];
    this.trackedFiles.clear();
    this.bases.clear();
    this.sessionNewlyCreated.clear();
    await this.persist();
  }

  // ------------------------------------------------------------------ //
  // Disk persistence                                                    //
  // ------------------------------------------------------------------ //

  private storageFile(): vscode.Uri | undefined {
    const dir = this.context?.globalStorageUri;
    if (!dir) {
      return undefined;
    }
    return vscode.Uri.joinPath(dir, `checkpoints-${this.composerId}.json`);
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    const file = this.storageFile();
    if (!file) {
      return;
    }
    try {
      const raw = await vscode.workspace.fs.readFile(file);
      const parsed = JSON.parse(Buffer.from(raw).toString("utf8")) as {
        records?: CheckpointRecord[];
        bases?: Record<string, string>;
        latestSnapshot?: { capturedAt?: number; files?: Record<string, string | null> };
      };
      if (
        parsed.latestSnapshot &&
        typeof parsed.latestSnapshot === "object" &&
        parsed.latestSnapshot.files &&
        typeof parsed.latestSnapshot.files === "object"
      ) {
        // DEV-GAPS-66/W66B: the "latest" snapshot (pre-restore capture).
        // Values are file contents or null (absent at capture); anything
        // else is dropped defensively.
        const files: Record<string, string | null> = {};
        for (const [uri, contents] of Object.entries(parsed.latestSnapshot.files)) {
          if (typeof contents === "string" || contents === null) {
            files[uri] = contents;
          }
        }
        this.latestSnapshot = {
          capturedAt:
            typeof parsed.latestSnapshot.capturedAt === "number" ? parsed.latestSnapshot.capturedAt : 0,
          files,
        };
      }
      if (parsed.bases && typeof parsed.bases === "object") {
        for (const [uri, contents] of Object.entries(parsed.bases)) {
          if (typeof uri === "string" && typeof contents === "string") {
            this.bases.set(uri, contents);
          }
        }
      }
      if (Array.isArray(parsed.records)) {
        this.records = parsed.records.filter(
          (r) => r && typeof r.checkpointId === "string" && typeof r.bubbleId === "string",
        );
        for (const r of this.records) {
          for (const f of r.files ?? []) {
            this.trackedFiles.add(f.uri);
            // Rebuild the session-created set so re-snapshots after a reload
            // keep the per-record isNewlyCreated flag (the flag persists on
            // records, but snapshotFile reads the in-memory set).
            if (f.isNewlyCreated === true) {
              this.sessionNewlyCreated.add(f.uri);
            }
          }
          for (const f of r.newlyCreatedFiles ?? []) {
            this.trackedFiles.add(f);
            this.sessionNewlyCreated.add(f);
          }
        }
      }
    } catch {
      // No stored checkpoints yet, or corrupt file — start fresh.
      this.records = [];
    }
  }

  /** Serialized writes: concurrent capture/note calls can't interleave. */
  private persist(): Promise<void> {
    this.saveChain = this.saveChain.then(async () => {
      const file = this.storageFile();
      if (!file) {
        return;
      }
      try {
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(file, ".."));
        await vscode.workspace.fs.writeFile(
          file,
          // Records carry diff-based snapshots; the session base (v0) map
          // travels alongside so diffs stay resolvable after reload.
          // Legacy full-file snapshots (if any) are preserved verbatim.
          Buffer.from(
            JSON.stringify({
              records: this.records,
              bases: Object.fromEntries(this.bases),
              // DEV-GAPS-66/W66B: the "latest" snapshot rides along so an
              // undo still works after an extension-host restart.
              ...(this.latestSnapshot ? { latestSnapshot: this.latestSnapshot } : {}),
            }),
            "utf8",
          ),
        );
        // Host-storage compare scheduling (Cursor parity: noteCheckpoint):
        // the write above is a checkpoint-storage write, so it arms/resets
        // the 60 s debounce before a storage compare runs.
        this.storageCompare.noteCheckpoint(this.composerId);
      } catch {
        // Disk persistence is best-effort; in-memory records still work.
      }
    });
    return this.saveChain;
  }

  // ------------------------------------------------------------------ //
  // Host-storage compare (Cursor parity: class `pw`)                     //
  // ------------------------------------------------------------------ //

  /**
   * The per-session storage check run by CheckpointStorageCompareService.
   *
   * HONEST DIVERGENCE: Cursor compares blob-store/host storage state with
   * verdicts pass|lag|warn|fail|busy from heuristics that are NOT in our
   * evidence, so we emit pass|fail only — a read-back consistency check of
   * the JSON checkpoint store on disk (parses + records well-formed).
   * Unreadable or malformed store → fail with the error as detail (feeds the
   * compare service's failure dedup).
   */
  private async verifyCheckpointStorage(
    sessionIds: readonly string[],
  ): Promise<SessionCompareResult[]> {
    const results: SessionCompareResult[] = [];
    for (const sessionId of sessionIds) {
      if (sessionId !== this.composerId) {
        // Not our store — nothing to verify locally.
        results.push({ sessionId, verdict: "pass" });
        continue;
      }
      const file = this.storageFile();
      if (!file) {
        results.push({ sessionId, verdict: "pass" });
        continue;
      }
      try {
        const raw = await vscode.workspace.fs.readFile(file);
        const parsed = JSON.parse(Buffer.from(raw).toString("utf8")) as {
          records?: unknown;
        };
        const ok =
          parsed !== null &&
          typeof parsed === "object" &&
          Array.isArray(parsed.records) &&
          parsed.records.every(
            (r) =>
              r !== null &&
              typeof r === "object" &&
              typeof (r as { checkpointId?: unknown }).checkpointId === "string" &&
              typeof (r as { bubbleId?: unknown }).bubbleId === "string",
          );
        results.push(
          ok
            ? { sessionId, verdict: "pass" }
            : {
                sessionId,
                verdict: "fail",
                detail: "checkpoint store records malformed",
              },
        );
      } catch (err) {
        results.push({
          sessionId,
          verdict: "fail",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return results;
  }

  // ------------------------------------------------------------------ //
  // Helpers                                                             //
  // ------------------------------------------------------------------ //

  private workspaceRoot(): string | undefined {
    const folder = vscode.workspace.workspaceFolders?.[0];
    return folder ? path.normalize(folder.uri.fsPath) : undefined;
  }

  private isInsideWorkspace(abs: string): boolean {
    const root = this.workspaceRoot();
    if (!root) {
      return false;
    }
    const rel = path.relative(root, abs);
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  }

  /** Resolve a tool-supplied path; undefined when outside the workspace. */
  private resolveInWorkspace(raw: string): string | undefined {
    const root = this.workspaceRoot();
    if (!root) {
      return undefined;
    }
    const abs = path.normalize(path.isAbsolute(raw) ? raw : path.join(root, raw));
    if (!this.isInsideWorkspace(abs)) {
      return undefined;
    }
    const parts = abs.split(path.sep);
    if (parts.some((p) => SKIP_DIR_PARTS.has(p))) {
      return undefined;
    }
    return abs;
  }

  /** Read a file for snapshotting; undefined when unreadable/too big/binary. */
  private async readSnapshot(abs: string): Promise<FileSnapshot | undefined> {
    return (await this.snapshotFile(abs))?.snap;
  }

  /**
   * Snapshot one file as a DIFF against the session base (v0).
   *
   * The base is the file's content at its first-ever snapshot in this
   * session and is never mutated afterwards. noteToolCall() runs pre-edit,
   * so agent-touched files get their pre-agent-edit state as v0; files only
   * seen by the capture loop (e.g. user edits via the watcher) get whatever
   * they contained at first sight — still a valid base, diffs stay exact.
   *
   * Returns the snapshot plus its approximate serialized byte size (for the
   * per-checkpoint budget). `bytes` measures the diff JSON, which is what
   * actually gets persisted now.
   *
   * Populates the per-record `isNewlyCreated` flag (Cursor record shape,
   * OBSERVED): `true` when the file was created during this session (tracked
   * via noteToolCall); the field is omitted (falsy) for pre-existing files.
   * Dual-format is untouched — the diff payload is computed exactly as
   * before, legacy `contents` is never written here.
   */
  private async snapshotFile(
    abs: string,
  ): Promise<{ snap: FileSnapshot; bytes: number } | undefined> {
    try {
      const stat = await fs.stat(abs);
      if (!stat.isFile() || stat.size > MAX_FILE_SNAPSHOT_BYTES) {
        return undefined;
      }
      const buf = await fs.readFile(abs);
      // Binary heuristic: NUL byte in the first 8KB.
      const head = buf.subarray(0, 8192);
      if (head.includes(0)) {
        return undefined;
      }
      const content = buf.toString("utf8");
      let base = this.bases.get(abs);
      if (base === undefined) {
        base = content;
        this.bases.set(abs, content);
      }
      const snap: FileSnapshot = {
        uri: abs,
        originalModelDiffWrtV0: computeLineDiff(base, content),
      };
      // Cursor record shape (OBSERVED): per-file isNewlyCreated. Only
      // session-created files carry `true`; pre-existing files omit the
      // field (falsy) — restore falls back to newlyCreatedFiles[] for
      // records without it.
      if (this.sessionNewlyCreated.has(abs)) {
        snap.isNewlyCreated = true;
      }
      return {
        snap,
        bytes: Buffer.byteLength(JSON.stringify(snap.originalModelDiffWrtV0), "utf8"),
      };
    } catch {
      return undefined;
    }
  }
}
