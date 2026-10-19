import * as vscode from "vscode";
import * as path from "path";
import { promises as fs } from "fs";
import { ToolCallViewModel } from "../model";
import {
  FileSnapshot,
  computeRestorePlan,
} from "./checkpointPlan";

export { FileSnapshot };

/**
 * CheckpointService — Cursor-style checkpoints with real file restore.
 *
 * Mirrors Cursor 3.25.6's ComposerCheckpointService (parity-checkpoints.md):
 *  - Per-bubble checkpoints: "before" captured on user-message send,
 *    "after" captured on generation end.
 *  - File snapshots: `files[]` (uri+contents), `newlyCreatedFiles[]`,
 *    `newlyCreatedFolders[]`.
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
}

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
  private watcher?: vscode.FileSystemWatcher;
  private loaded = false;
  private saveChain: Promise<void> = Promise.resolve();
  /** Serializes checkpoint captures (Cursor parity: _checkpointCommitSequencer). */
  private captureChain: Promise<void> = Promise.resolve();
  private readonly composerId = "default";

  constructor(private readonly context?: vscode.ExtensionContext) {
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
    // Snapshot current contents of all tracked files (bounded).
    let bytes = 0;
    for (const abs of this.trackedFiles) {
      const snap = await this.readSnapshot(abs);
      if (!snap) {
        continue;
      }
      bytes += snap.contents.length;
      if (bytes > MAX_CHECKPOINT_BYTES) {
        break;
      }
      record.files.push(snap);
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
   * PRODUCT DECISION 2026-10-19 (files-only): this deliberately does NOT
   * touch the conversation transcript — the transcript is left intact.
   * Do NOT re-add transcript rewinding here.
   *
   * The restore PLAN is computed by the pure computeRestorePlan()
   * (checkpointPlan.ts): content comparison decides what actually needs
   * reverting (Cursor: areContentsEqual), activeInlineDiffs URIs are
   * excluded from the revert set, and a path snapshotted at the target
   * wins over the delete set.
   */
  async checkoutToCheckpoint(bubbleId: string): Promise<RestoreResult> {
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
    });
    if (plan.isSame) {
      // Cursor parity: "[composer] Checkout to message is the same as current".
      return { reverted: [], deleted: [], isSame: true };
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
    return result;
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
   * checkoutToLatest: undo a restore by re-applying the latest "after"
   * checkpoint's contents (mirrors Cursor's checkoutToLatest).
   */
  async checkoutToLatest(): Promise<RestoreResult> {
    await this.ensureLoaded();
    const latest = [...this.records].reverse().find((r) => r.isAfter) ?? this.records[this.records.length - 1];
    if (!latest) {
      return { reverted: [], deleted: [], isSame: true };
    }
    const result: RestoreResult = { reverted: [], deleted: [], isSame: false };
    for (const snap of latest.files) {
      try {
        await fs.mkdir(path.dirname(snap.uri), { recursive: true });
        await vscode.workspace.fs.writeFile(
          vscode.Uri.file(snap.uri),
          Buffer.from(snap.contents, "utf8"),
        );
        result.reverted.push(snap.uri);
      } catch {
        // Best-effort per file.
      }
    }
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
      };
      if (Array.isArray(parsed.records)) {
        this.records = parsed.records.filter(
          (r) => r && typeof r.checkpointId === "string" && typeof r.bubbleId === "string",
        );
        for (const r of this.records) {
          for (const f of r.files ?? []) {
            this.trackedFiles.add(f.uri);
          }
          for (const f of r.newlyCreatedFiles ?? []) {
            this.trackedFiles.add(f);
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
          Buffer.from(JSON.stringify({ records: this.records }), "utf8"),
        );
      } catch {
        // Disk persistence is best-effort; in-memory records still work.
      }
    });
    return this.saveChain;
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
      return { uri: abs, contents: buf.toString("utf8") };
    } catch {
      return undefined;
    }
  }
}
