/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Migrated — vscode API → DI (2026-10-19).
//
// vscode API → core mapping used here:
//   vscode.workspace.workspaceFolders     → IWorkspaceContextService.getWorkspace().folders
//   vscode.workspace.createFileSystemWatcher("**/*")
//       → IFileService.watch(root, { recursive: true }) + IFileService.onDidFilesChange
//         (core IFileSystemWatcher only reports onDidChange; creates arrive as
//         FileChangeType.ADDED in the same event — rawAdded/rawUpdated cover both)
//   vscode.workspace.fs.readFile/writeFile → IFileService.readFile/writeFile (URI + VSBuffer)
//   vscode.workspace.fs.delete            → IFileService.del
//   vscode.workspace.fs.createDirectory   → IFileService.createFolder
//   vscode.Uri.joinPath/file              → URI.joinPath / URI.file (vs/base/common/uri)
//   context.globalStorageUri (JSON file)  → JSON file under
//       IEnvironmentService.workspaceStorageHome via IFileService.
//       (Deliberate scoping change: checkpoints are workspace paths with chat-lifetime
//       retention, so workspace storage is the honest home; extension global storage
//       has no workbench-core equivalent.)
//   node:fs stat/readFile/rmdir           → IFileService.stat/readFile/del(recursive:false)
//   node:path                             → URI + extUri (vs/base/common/resources)
//   vscode.ExtensionContext               → DROPPED (no longer needed)
//
// FileSnapshot.uri is now the canonical URI string (was: absolute fs path).
// computeRestorePlan/checkpointPlan.ts treat it as an opaque string, so the
// restore-plan logic is unchanged. ToolCallViewModel comes from ./model.js
// (CAT-A, copied verbatim).

import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { extUri } from '../../../../base/common/resources.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { computeRestorePlan } from './checkpointPlan.js';
import type { FileSnapshot } from './checkpointPlan.js';
import type { ToolCallViewModel } from './model.js';

export type { FileSnapshot };

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
 *  - Disk-persisted (JSON under the workspace storage home), retention = chat lifetime.
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
	'edit_tool_call', // edit + write
	'apply_agent_diff_tool_call', // patch
	'delete_tool_call', // delete
]);
const SKIP_DIR_PARTS = new Set(['node_modules', '.git', 'dist', 'out', '.vscode-test']);

let checkpointSeq = 0;

function isAbsoluteFsPath(p: string): boolean {
	return p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\');
}

// ------------------------------------------------------------------ //
// Host-storage compare scheduling (Cursor parity: class `pw`)          //
// ------------------------------------------------------------------ //

/**
 * Host-storage compare scheduling — mirrors the TIMING of Cursor's
 * host-storage compare service (`extensions/cursor-agent-host/dist/main.js`,
 * class `pw`).
 *
 * BINARY EVIDENCE (coordinator-verified via direct grep, 2026-10-20):
 *   3.25.6 — `extensions/cursor-agent-host/dist/main.js`
 *     - `activationDelayMs=e.activationDelayMs??15e3` @10572158
 *     - `intervalMs=e.intervalMs??6e5`               @10572207
 *     - `checkpointDebounceMs=e.checkpointDebounceMs??6e4` @10572241
 *   3.25.9 — same file, same 3 literals @10583638 / @10583687 / @10583721
 *   All three sit in the same constructor of the host-storage compare
 *   service class, adjacent to `noteCheckpoint` and the single-flight merge —
 *   matching docs/rea/deepdig-runtime-checkpoint-2026-10-19.md §1.4
 *   (AST identifier-slice extraction, run-21 confirmed) and the
 *   `checkpoint-debounce-60s` / `checkpoint-compare-interval-10min` /
 *   `checkpoint-activation-15s` feature-matrix entries.
 * Semantics (OBSERVED, §1.4):
 *   - noteCheckpoint(sessionId): adds to `pendingCheckpointSessions`, RESETS
 *     the 60 s debounce timer, then runs compare with trigger "checkpoint"
 *   - single-flight: concurrent compare requests are queued and MERGED; a
 *     "checkpoint" trigger wins over "interval" in the merge
 *   - cross-window catalog lease: interval compares require the catalog
 *     lease; when another window holds it the binary logs
 *     "catalog compares run in another window (pid X); this host compares
 *     only the sessions it checkpoints". Checkpoint-triggered compares
 *     BYPASS the lease (always run).
 *   - verdicts per session: pass | lag | warn | fail | busy
 *   - failure dedup with shape fingerprints (shapeFingerprintV2); caps:
 *     4 clusters, 3 samples per cluster, 10 events per run
 *
 * LAYER HONESTY: in Cursor these constants live in the AGENT-HOST process
 * (cursor-agent-host). This port keeps the identical values and scheduling
 * semantics but runs inside the workbench-core composer port
 * (CheckpointService owns one instance), because the fork's workbench side
 * is where the checkpoint JSON store lives. The sibling platform contract
 * for the real host side is
 * `src/vs/platform/agentHost/common/agentHostStorageCompareService.ts`
 * (IAgentHostStorageCompareService) — a different layer, not duplicated here.
 *
 * SCOPING (docs/rea/dig-continuous-checkpoint-ui-2026-10-19.md §3): these
 * constants govern the storage COMPARE loop only. File snapshots stay
 * event-driven (per-bubble before/after captures) — do NOT wire the
 * 60 s / 15 s / 10 min constants into snapshot cadence.
 *
 * HONEST DIVERGENCES (evidence gaps, not choices):
 *  1. What a "compare" checks: Cursor compares blob-store/host storage state
 *     with verdicts pass|lag|warn|fail|busy from heuristics NOT in our
 *     evidence. Our verifier only read-backs the JSON checkpoint store on
 *     disk (parses, records well-formed) and therefore emits pass|fail only.
 *  2. shapeFingerprintV2: the binary's failure-fingerprint algorithm is not
 *     verbatim in our evidence — clustering uses a coarse (verdict,
 *     detail-class) key. The 4 / 3 / 10 caps ARE evidenced and adopted exactly.
 *  3. Catalog lease: no real cross-window lease exists in this runtime yet;
 *     the default always acquires (single-window assumption). The
 *     checkpoint-triggered bypass is implemented exactly as observed.
 *     Inject a real lease (file lock / PID check) when one becomes available.
 *  4. Injectable clock: Cursor's host class uses real timers; the injectable
 *     ICheckpointStorageCompareTimer exists so unit tests can drive
 *     scheduling with virtual time. Default is real setTimeout/clearTimeout;
 *     the real-timer wrapper also unrefs the handle so background compare
 *     scheduling never keeps the host/test process alive on its own.
 */

/** Debounce after noteCheckpoint(sessionId) before running a compare. BINARY-VERIFIED (see above). */
export const checkpointDebounceMs = 60_000;
/** Periodic compare interval. BINARY-VERIFIED (see above). */
export const intervalMs = 600_000;
/** First periodic compare this long after start(). BINARY-VERIFIED (see above). */
export const activationDelayMs = 15_000;
/** Failure-dedup cap: at most 4 clusters. BINARY-VERIFIED (see above). */
export const failureClusterCap = 4;
/** Failure-dedup cap: at most 3 samples kept per cluster. BINARY-VERIFIED (see above). */
export const failureSamplesPerClusterCap = 3;
/** Failure-dedup cap: at most 10 failure events per run. BINARY-VERIFIED (see above). */
export const failureEventsPerRunCap = 10;

export type CheckpointCompareTrigger = 'checkpoint' | 'interval';
export type CheckpointCompareVerdict = 'pass' | 'lag' | 'warn' | 'fail' | 'busy';

/** Injectable clock so tests can drive scheduling with virtual time. OUR CHOICE (see §4 above). */
export interface ICheckpointStorageCompareTimer {
	setTimeout(handler: () => void, timeout: number): unknown;
	clearTimeout(id: unknown): void;
	now(): number;
}

const realStorageCompareTimer: ICheckpointStorageCompareTimer = {
	setTimeout: (handler, timeout) => {
		const handle = setTimeout(handler, timeout);
		// Root-cause fix for the test-process hang (GAPS-36 follow-up): the
		// compare schedule is pure background housekeeping (15 s activation,
		// 60 s debounce, 10 min interval chain) and must never keep the
		// host/test process alive on its own. A Node timer handle is ref'd
		// by default, so unref it when the runtime provides unref — the
		// exact guarded idiom used in humanReviewService.ts (same layer):
		// browser timer handles are plain numbers with no unref, in which
		// case dispose() (which clears every armed timer) remains the
		// mechanism that releases them.
		if (typeof handle === 'object' && handle !== null && typeof (handle as unknown as { unref?: unknown }).unref === 'function') {
			(handle as unknown as { unref(): void }).unref();
		}
		return handle;
	},
	clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
	now: () => Date.now(),
};

/**
 * Cross-window catalog lease (binary §1.4: interval compares require it;
 * checkpoint-triggered compares bypass it).
 *
 * OUR CHOICE / HONEST DIVERGENCE (§3 above): no real cross-window lease
 * exists in this runtime yet, so the default always acquires.
 */
export interface ICheckpointCatalogLease {
	/** True when THIS window holds the catalog compare lease. */
	tryAcquire(): boolean;
	/** PID of the window currently holding the lease (for the log line). */
	holderPid?(): number | undefined;
}

const alwaysAcquireLease: ICheckpointCatalogLease = { tryAcquire: () => true };

export interface CheckpointSessionCompareResult {
	sessionId: string;
	verdict: CheckpointCompareVerdict;
	/** Short error description; present when verdict is fail/warn. */
	detail?: string;
}

/** Runs the actual per-session storage check. Sync or async. */
export type CheckpointCompareSessionsFn = (
	sessionIds: readonly string[],
) => Promise<CheckpointSessionCompareResult[]> | CheckpointSessionCompareResult[];

/** Default: nothing to verify, everything passes (CheckpointService injects a real verifier). */
const defaultCompareSessions: CheckpointCompareSessionsFn = (sessionIds) =>
	sessionIds.map((sessionId) => ({ sessionId, verdict: 'pass' as CheckpointCompareVerdict }));

export interface CheckpointStorageCompareOptions {
	timer?: ICheckpointStorageCompareTimer;
	lease?: ICheckpointCatalogLease;
	compareSessions?: CheckpointCompareSessionsFn;
	/** Receives diagnostic lines (compare runs, skips, failures). Defaults to no-op. OUR CHOICE. */
	onLog?: (message: string) => void;
}

interface QueuedCheckpointCompare {
	trigger: CheckpointCompareTrigger;
	sessions: Set<string>;
}

export class CheckpointStorageCompareService extends Disposable {
	private readonly timer: ICheckpointStorageCompareTimer;
	private readonly lease: ICheckpointCatalogLease;
	private readonly compareSessions: CheckpointCompareSessionsFn;
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
	private queued: QueuedCheckpointCompare | null = null;

	/** Failure dedup clusters (persist across runs; bounded by failureClusterCap). */
	private readonly failureClusters = new Map<string, { samples: string[]; lastSeen: number }>();
	private failureEventsThisRun = 0;

	private lastVerdicts: CheckpointSessionCompareResult[] = [];

	constructor(opts: CheckpointStorageCompareOptions = {}) {
		super();
		this.timer = opts.timer ?? realStorageCompareTimer;
		this.lease = opts.lease ?? alwaysAcquireLease;
		this.compareSessions = opts.compareSessions ?? defaultCompareSessions;
		this.onLog = opts.onLog ?? (() => { });
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

	override dispose(): void {
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
		super.dispose();
	}

	/**
	 * A checkpoint was written for sessionId (binary §1.4): record the
	 * session, add it to pendingCheckpointSessions, RESET the 60 s debounce
	 * timer, then run the compare with trigger "checkpoint" when the
	 * debounce elapses.
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
	getLastVerdicts(): CheckpointSessionCompareResult[] {
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
		this.requestCompare('checkpoint', sessions);
	}

	private onIntervalDue(): void {
		this.requestCompare('interval', new Set(this.knownSessions));
	}

	/**
	 * Single-flight (binary §1.4): concurrent compare requests are queued
	 * and MERGED — sessions union, and a "checkpoint" trigger wins over
	 * "interval" in the merge.
	 */
	private requestCompare(trigger: CheckpointCompareTrigger, sessions: Set<string>): void {
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
				if (trigger === 'checkpoint') {
					this.queued.trigger = 'checkpoint';
				}
			}
			return;
		}
		void this.executeCompare(trigger, sessions);
	}

	private async executeCompare(trigger: CheckpointCompareTrigger, sessions: Set<string>): Promise<void> {
		this.running = true;
		this.failureEventsThisRun = 0;
		try {
			if (trigger === 'interval' && !this.lease.tryAcquire()) {
				// Binary-verbatim log line (pid substituted when the lease names one).
				const pid = this.lease.holderPid?.();
				this.onLog(
					pid === undefined
						? 'catalog compares run in another window; this host compares only the sessions it checkpoints'
						: `catalog compares run in another window (pid ${pid}); this host compares only the sessions it checkpoints`,
				);
				return;
			}
			// Checkpoint-triggered compares bypass the lease — they always run.
			let results: CheckpointSessionCompareResult[];
			try {
				results = await this.compareSessions([...sessions]);
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				this.onLog(`[checkpoint-storage-compare] compare threw: ${detail}`);
				results = [...sessions].map((sessionId) => ({
					sessionId,
					verdict: 'fail' as CheckpointCompareVerdict,
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

	private recordResults(results: CheckpointSessionCompareResult[], trigger: CheckpointCompareTrigger): void {
		this.onLog(
			`[checkpoint-storage-compare] compare done (trigger=${trigger}, sessions=${results.length})`,
		);
		for (const r of results) {
			if (r.verdict === 'fail' || r.verdict === 'warn') {
				this.recordFailure(r);
			}
		}
	}

	/**
	 * Failure dedup (binary §1.4: shapeFingerprintV2; caps 4 clusters,
	 * 3 samples per cluster, 10 events per run).
	 *
	 * HONEST DIVERGENCE (§2 above): the binary's fingerprint algorithm is
	 * not verbatim in our evidence — we cluster on (verdict, detail-class).
	 * The caps are adopted exactly.
	 */
	private recordFailure(r: CheckpointSessionCompareResult): void {
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
			(r.detail ? ` — ${r.detail}` : ''),
		);
	}
}

/** Coarse stand-in for the binary's shapeFingerprintV2 (see HONEST DIVERGENCE §2). */
function failureClass(detail: string | undefined): string {
	if (!detail) {
		return 'unknown';
	}
	return detail.split(/[:\n]/)[0]!.trim().slice(0, 80) || 'unknown';
}

export class CheckpointService extends Disposable {
	private records: CheckpointRecord[] = [];
	/** Files the agent has touched (canonical URI strings), for snapshot-on-capture. */
	private trackedFiles = new Set<string>();
	private loaded = false;
	private saveChain: Promise<void> = Promise.resolve();
	/** Serializes checkpoint captures (Cursor parity: _checkpointCommitSequencer). */
	private captureChain: Promise<void> = Promise.resolve();
	private readonly composerId = 'default';
	/**
	 * Host-storage compare scheduling (Cursor parity: class `pw` — 60 s
	 * checkpoint debounce, 10 min compare interval, 15 s activation delay;
	 * see the section above for binary evidence). noteCheckpoint(composerId)
	 * is fired after every successful persist.
	 */
	private readonly storageCompare: CheckpointStorageCompareService;

	constructor(
		private readonly workspaceContextService: IWorkspaceContextService,
		private readonly fileService: IFileService,
		private readonly environmentService: IEnvironmentService,
		opts?: {
			storageCompare?: CheckpointStorageCompareService;
			/** Test hook: virtual timer for the internally built compare service. */
			storageCompareTimer?: ICheckpointStorageCompareTimer;
			/** Test hook: log sink for the internally built compare service. */
			storageCompareLog?: (message: string) => void;
		},
	) {
		super();
		this.storageCompare =
			opts?.storageCompare ??
			new CheckpointStorageCompareService({
				timer: opts?.storageCompareTimer,
				onLog: opts?.storageCompareLog,
				compareSessions: (sessionIds) => this.verifyCheckpointStorage(sessionIds),
			});
		this._register(this.storageCompare);
		this.storageCompare.start();
		// Safety net: track files changed outside tool events (user edits, other
		// extensions) so future checkpoints at least capture their contents.
		// Pre-edit contents can't be recovered here — only tool-driven snapshots
		// are pre-edit; this just keeps the tracked set complete.
		const root = this.workspaceRoot();
		if (root) {
			this._register(this.fileService.watch(root, {
				recursive: true,
				excludes: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/out/**'],
			}));
			this._register(this.fileService.onDidFilesChange((e) => {
				for (const resource of [...e.rawAdded, ...e.rawUpdated]) {
					if (this.isInsideWorkspace(resource)) {
						this.trackedFiles.add(resource.toString());
					}
				}
			}));
		}
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
			label: label.slice(0, 60) || 'message',
			isAfter,
			files: [],
			newlyCreatedFiles: [],
			newlyCreatedFolders: [],
			activeInlineDiffs: [],
		};
		// Snapshot current contents of all tracked files (bounded).
		let bytes = 0;
		for (const key of this.trackedFiles) {
			const snap = await this.readSnapshot(URI.parse(key));
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
		if (typeof raw !== 'string' || raw.length === 0) {
			return;
		}
		const uri = this.resolveInWorkspace(raw);
		if (!uri) {
			return;
		}
		await this.ensureLoaded();
		const key = uri.toString();
		const latest = this.records[this.records.length - 1];
		if (!latest) {
			// No checkpoint yet (shouldn't happen — captureBefore runs on send) —
			// still track the file so the next capture snapshots it.
			this.trackedFiles.add(key);
			return;
		}
		if (latest.newlyCreatedFiles.includes(key) || latest.files.some((f) => f.uri === key)) {
			this.trackedFiles.add(key);
			return;
		}
		let exists = false;
		try {
			const stat = await this.fileService.stat(uri);
			exists = stat.isFile;
		} catch {
			exists = false;
		}
		if (!exists) {
			// File doesn't exist yet at tool-pending time: the tool is about to
			// create it → restore must delete it.
			latest.newlyCreatedFiles.push(key);
			// Parent folders that don't exist yet either are about to be created
			// by the tool (write creates parents) → track them for folder cleanup
			// on restore (Cursor parity: newlyCreatedFolders).
			await this.trackMissingParents(uri);
		} else {
			const snap = await this.readSnapshot(uri);
			if (snap) {
				latest.files.push(snap);
			}
		}
		this.trackedFiles.add(key);
		latest.lastUpdatedAt = Date.now();
		await this.persist();
	}

	/**
	 * Record ancestor folders that don't exist at tool-pending time (bounded:
	 * 4 levels up to the workspace root). The tool is about to create them.
	 */
	private async trackMissingParents(uri: URI): Promise<void> {
		const root = this.workspaceRoot();
		if (!root) {
			return;
		}
		await this.ensureLoaded();
		const latest = this.records[this.records.length - 1];
		if (!latest) {
			return;
		}
		let dir = extUri.dirname(uri);
		for (let depth = 0; depth < 4; depth++) {
			if (extUri.isEqual(dir, root) || !this.isInsideWorkspace(dir)) {
				break;
			}
			let exists = false;
			try {
				const stat = await this.fileService.stat(dir);
				exists = stat.isDirectory;
			} catch {
				exists = false;
			}
			if (exists) {
				break; // an existing ancestor covers everything above it.
			}
			const key = dir.toString();
			if (!latest.newlyCreatedFolders.includes(key)) {
				latest.newlyCreatedFolders.push(key);
				latest.lastUpdatedAt = Date.now();
			}
			dir = extUri.dirname(dir);
		}
	}

	/** Record a folder the agent created (deleted on restore). */
	async noteFolderCreated(rawPath: string): Promise<void> {
		const uri = this.resolveInWorkspace(rawPath);
		if (!uri) {
			return;
		}
		await this.ensureLoaded();
		const latest = this.records[this.records.length - 1];
		const key = uri.toString();
		if (latest && !latest.newlyCreatedFolders.includes(key)) {
			latest.newlyCreatedFolders.push(key);
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
			newlyCreatedFiles.push(...this.records[i]!.newlyCreatedFiles);
			newlyCreatedFolders.push(...this.records[i]!.newlyCreatedFolders);
			if (i > targetIdx) {
				laterFiles.push(...this.records[i]!.files);
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
		for (const key of candidates) {
			currentContents.set(key, await this.readCurrentContents(URI.parse(key)));
		}
		const existingFolders = new Set<string>();
		for (const key of newlyCreatedFolders) {
			try {
				const stat = await this.fileService.stat(URI.parse(key));
				if (stat.isDirectory) {
					existingFolders.add(key);
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
				const uri = URI.parse(snap.uri);
				await this.ensureParentFolder(uri);
				await this.fileService.writeFile(uri, VSBuffer.fromString(snap.contents));
				result.reverted.push(snap.uri);
			} catch {
				// Best-effort per file; one failure must not abort the restore.
			}
		}
		// 2. Delete files created at/after the target checkpoint.
		for (const key of plan.filesToDelete) {
			try {
				await this.fileService.del(URI.parse(key));
				result.deleted.push(key);
			} catch {
				// File may already be gone — not an error.
			}
		}
		// 3. Delete folders created at/after the target checkpoint, deepest
		// first. Non-recursive delete on purpose: it only removes folders that
		// are now empty, so content the agent didn't create (user files,
		// untracked outputs) is never wiped. Intentional, documented deviation
		// from Cursor's recursive delete — a safety improvement.
		const byDepth = [...plan.foldersToDelete].sort(
			(a, b) => b.split('/').length - a.split('/').length,
		);
		for (const key of byDepth) {
			try {
				await this.fileService.del(URI.parse(key), { recursive: false });
				result.deleted.push(key);
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
	 * writes back the ≤100MB snapshot).
	 */
	private async readCurrentContents(uri: URI): Promise<string | undefined> {
		try {
			const stat = await this.fileService.stat(uri);
			if (!stat.isFile) {
				return undefined;
			}
			if (stat.size > 8_000_000) {
				return '\0OVERSIZE\0';
			}
			return (await this.fileService.readFile(uri)).value.toString();
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
				const uri = URI.parse(snap.uri);
				await this.ensureParentFolder(uri);
				await this.fileService.writeFile(uri, VSBuffer.fromString(snap.contents));
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

	private storageFile(): URI {
		return URI.joinPath(
			this.environmentService.workspaceStorageHome,
			'ide-agent',
			`checkpoints-${this.composerId}.json`,
		);
	}

	private async ensureLoaded(): Promise<void> {
		if (this.loaded) {
			return;
		}
		this.loaded = true;
		try {
			const raw = (await this.fileService.readFile(this.storageFile())).value;
			const parsed = JSON.parse(raw.toString()) as {
				records?: CheckpointRecord[];
			};
			if (Array.isArray(parsed.records)) {
				this.records = parsed.records.filter(
					(r) => r && typeof r.checkpointId === 'string' && typeof r.bubbleId === 'string',
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
			try {
				const file = this.storageFile();
				await this.ensureParentFolder(file);
				await this.fileService.writeFile(
					file,
					VSBuffer.fromString(JSON.stringify({ records: this.records })),
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
	 * Unreadable or malformed store → fail with the error as detail (feeds
	 * the compare service's failure dedup).
	 */
	private async verifyCheckpointStorage(
		sessionIds: readonly string[],
	): Promise<CheckpointSessionCompareResult[]> {
		const results: CheckpointSessionCompareResult[] = [];
		for (const sessionId of sessionIds) {
			if (sessionId !== this.composerId) {
				// Not our store — nothing to verify locally.
				results.push({ sessionId, verdict: 'pass' });
				continue;
			}
			try {
				const raw = (await this.fileService.readFile(this.storageFile())).value;
				const parsed = JSON.parse(raw.toString()) as {
					records?: unknown;
				};
				const ok =
					parsed !== null &&
					typeof parsed === 'object' &&
					Array.isArray(parsed.records) &&
					parsed.records.every(
						(r) =>
							r !== null &&
							typeof r === 'object' &&
							typeof (r as { checkpointId?: unknown }).checkpointId === 'string' &&
							typeof (r as { bubbleId?: unknown }).bubbleId === 'string',
					);
				results.push(
					ok
						? { sessionId, verdict: 'pass' }
						: {
							sessionId,
							verdict: 'fail',
							detail: 'checkpoint store records malformed',
						},
				);
			} catch (err) {
				results.push({
					sessionId,
					verdict: 'fail',
					detail: err instanceof Error ? err.message : String(err),
				});
			}
		}
		return results;
	}

	// ------------------------------------------------------------------ //
	// Helpers                                                             //
	// ------------------------------------------------------------------ //

	private workspaceRoot(): URI | undefined {
		return this.workspaceContextService.getWorkspace().folders[0]?.uri;
	}

	private isInsideWorkspace(uri: URI): boolean {
		const root = this.workspaceRoot();
		if (!root || uri.scheme !== root.scheme) {
			return false;
		}
		return extUri.isEqualOrParent(uri, root) && !extUri.isEqual(uri, root);
	}

	/** Resolve a tool-supplied path; undefined when outside the workspace. */
	private resolveInWorkspace(raw: string): URI | undefined {
		const root = this.workspaceRoot();
		if (!root) {
			return undefined;
		}
		const uri = isAbsoluteFsPath(raw) ? URI.file(raw) : URI.joinPath(root, raw);
		if (!this.isInsideWorkspace(uri)) {
			return undefined;
		}
		const parts = uri.path.split('/');
		if (parts.some((p) => SKIP_DIR_PARTS.has(p))) {
			return undefined;
		}
		return uri;
	}

	/** Create ancestor folders up to the workspace root (best-effort). */
	private async ensureParentFolder(file: URI): Promise<void> {
		const root = this.workspaceRoot();
		if (!root) {
			return;
		}
		const rel = extUri.relativePath(root, extUri.dirname(file));
		if (!rel) {
			return;
		}
		let cur = root;
		for (const part of rel.split('/')) {
			if (!part) {
				continue;
			}
			cur = URI.joinPath(cur, part);
			try {
				await this.fileService.createFolder(cur);
			} catch {
				// Already exists — move on.
			}
		}
	}

	/** Read a file for snapshotting; undefined when unreadable/too big/binary. */
	private async readSnapshot(uri: URI): Promise<FileSnapshot | undefined> {
		try {
			const stat = await this.fileService.stat(uri);
			if (!stat.isFile || stat.size > MAX_FILE_SNAPSHOT_BYTES) {
				return undefined;
			}
			const content = await this.fileService.readFile(uri);
			const buf = content.value;
			// Binary heuristic: NUL byte in the first 8KB.
			const head = buf.buffer.subarray(0, 8192);
			if (head.includes(0)) {
				return undefined;
			}
			return { uri: uri.toString(), contents: buf.toString() };
		} catch {
			return undefined;
		}
	}
}
