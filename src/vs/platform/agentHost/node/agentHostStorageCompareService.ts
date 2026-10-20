/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { ILogService } from '../../log/common/log.js';
import { IAgentHostGitService } from '../common/agentHostGitService.js';
import { IAgentHostStorageCompareService, IStorageCompareRunSummary, StorageCompareTrigger, StorageCompareVerdict } from '../common/agentHostStorageCompareService.js';
import { ISessionDataService, SESSION_CHECKPOINT_REPOSITORIES_METADATA_KEY } from '../common/sessionDataService.js';
import { AgentSessionRegistry, IAgentSessionRegistry } from './agentSessionRegistry.js';
import { IAgentConfigurationService } from './agentConfigurationService.js';

/**
 * Debounce after `noteCheckpoint(session)` before running a compare.
 *
 * Cursor 3.25.6 `cursor-agent-host/dist/main.js`, host-storage compare
 * service (class `pw`) — OBSERVED via targeted grep:
 * `checkpointDebounceMs = e.checkpointDebounceMs ?? 6e4`.
 */
export const CHECKPOINT_COMPARE_DEBOUNCE_MS = 60_000;

/**
 * Periodic compare interval.
 *
 * Cursor 3.25.6 class `pw` — OBSERVED: `intervalMs = e.intervalMs ?? 6e5`.
 */
export const CHECKPOINT_COMPARE_INTERVAL_MS = 600_000;

/**
 * Delay after `start()` before the first periodic compare.
 *
 * Cursor 3.25.6 class `pw` — OBSERVED: `activationDelayMs = e.activationDelayMs ?? 15e3`.
 */
export const CHECKPOINT_COMPARE_ACTIVATION_DELAY_MS = 15_000;

/**
 * Failure-dedup caps, Cursor 3.25.6 class `pw` — OBSERVED
 * (`docs/rea/deepdig-runtime-checkpoint-2026-10-19.md` §1.4): failure
 * dedup with shape fingerprints, capped at 4 clusters, 3 samples per
 * cluster, 10 events per run.
 */
const MAX_FAILURE_CLUSTERS = 4;
const MAX_SAMPLES_PER_CLUSTER = 3;
const MAX_EVENTS_PER_RUN = 10;

/**
 * Cross-window catalog lease. Cursor 3.25.6 class `pw` — OBSERVED: interval
 * compares require the catalog lease; when another window holds it the host
 * logs "catalog compares run in another window (pid X); this host compares
 * only the sessions it checkpoints". Checkpoint-triggered compares bypass
 * the lease and always run.
 *
 * The agent host currently has no shared cross-window lease primitive, so
 * the default implementation always grants the lease to this process
 * (single-window behavior). When the host gains a real single-instance
 * lease, provide it here; the gating logic below already honors it.
 */
export interface ICatalogLease {
	/** Returns true when this host process holds the catalog lease. */
	tryAcquire(): boolean;
	/** PID of the current holder when another window holds the lease. */
	readonly holderPid: number | undefined;
}

class LocalCatalogLease implements ICatalogLease {
	tryAcquire(): boolean {
		return true;
	}
	readonly holderPid: number | undefined = undefined;
}

/**
 * Normalizes a failure message into a shape fingerprint for dedup, so
 * repeated identical failures collapse (Cursor's `shapeFingerprintV2`
 * analog): hex digests and ref paths are bucketed out.
 */
function shapeFingerprint(message: string): string {
	return message
		.replace(/[0-9a-f]{8,}/gi, '#')
		.replace(/refs\/[^\s]*/g, 'refs/#')
		.slice(0, 160);
}

/** Per-run failure dedup honoring Cursor's 4-cluster / 3-sample / 10-event caps. */
class FailureDedup {
	private readonly _clusters = new Map<string, string[]>();
	private _events = 0;

	/**
	 * Records a failure; invokes `log` with the raw message only when the
	 * failure is admitted under the caps. Returns true when admitted.
	 */
	note(message: string, log: (message: string) => void): boolean {
		const fingerprint = shapeFingerprint(message);
		let samples = this._clusters.get(fingerprint);
		if (!samples) {
			if (this._clusters.size >= MAX_FAILURE_CLUSTERS) {
				return false;
			}
			samples = [];
			this._clusters.set(fingerprint, samples);
		}
		if (samples.length >= MAX_SAMPLES_PER_CLUSTER || this._events >= MAX_EVENTS_PER_RUN) {
			return false;
		}
		samples.push(message);
		this._events++;
		log(message);
		return true;
	}
}

/**
 * Host-side compare of host-owned session storage.
 *
 * Mirrors Cursor 3.25.6's host-storage compare service (class `pw` in
 * `cursor-agent-host/dist/main.js`, OBSERVED — see
 * `docs/rea/deepdig-runtime-checkpoint-2026-10-19.md` §1.4): the same three
 * scheduling constants (15s activation delay, 10min interval, 60s
 * checkpoint debounce), single-flight merging with `checkpoint` winning
 * over `interval`, and the cross-window catalog lease gating interval
 * compares.
 *
 * The per-session compare is real: it opens the session's host-owned
 * database (`ISessionDataService.tryOpenDatabase`) and resolves every
 * checkpoint ref the database records against the repositories via
 * `IAgentHostGitService.revParse` — the direct analog of Cursor's
 * "hydrate throws if the root blob is missing" check. A ref the host
 * believes it committed but that is unresolvable on disk is a `fail`.
 */
export class AgentHostStorageCompareService extends Disposable implements IAgentHostStorageCompareService {
	declare readonly _serviceBrand: undefined;

	private readonly _catalogLease: ICatalogLease;
	/** Sessions noted since the last checkpoint-triggered compare, by session URI string. */
	private readonly _pendingCheckpointSessions = new Map<string, URI>();
	private _checkpointTimer: ReturnType<typeof setTimeout> | undefined;
	private _activationTimer: ReturnType<typeof setTimeout> | undefined;
	private _periodicTimer: ReturnType<typeof setTimeout> | undefined;
	/** The in-flight compare run; concurrent requests merge into it (single-flight). */
	private _activeRun: Promise<IStorageCompareRunSummary | undefined> | undefined;
	private readonly _queuedTriggers = new Set<StorageCompareTrigger>();
	private readonly _queuedSessions = new Map<string, URI>();
	private _started = false;
	private _disposed = false;

	constructor(
		@ILogService private readonly _logService: ILogService,
		@ISessionDataService private readonly _sessionDataService: ISessionDataService,
		@IAgentHostGitService private readonly _gitService: IAgentHostGitService,
		@IAgentConfigurationService private readonly _agentConfigService: IAgentConfigurationService,
		@IAgentSessionRegistry private readonly _sessionRegistry: AgentSessionRegistry,
		catalogLease?: ICatalogLease,
	) {
		super();
		// Undecorated trailing parameter: the DI container passes `undefined`
		// (service args are appended after static args); tests and future
		// wiring may supply a real cross-window lease.
		this._catalogLease = catalogLease ?? new LocalCatalogLease();
	}

	start(): void {
		if (this._started || this._disposed) {
			return;
		}
		this._started = true;
		this._logService.debug(`[AgentHostStorageCompare] Started: first periodic compare in ${CHECKPOINT_COMPARE_ACTIVATION_DELAY_MS}ms, then every ${CHECKPOINT_COMPARE_INTERVAL_MS}ms; checkpoint-noted compares debounce ${CHECKPOINT_COMPARE_DEBOUNCE_MS}ms.`);
		// Cursor class `pw`: setTimeout(() => { runGated("activation", periodicSessionIds); schedulePeriodic(); }, activationDelayMs)
		this._activationTimer = setTimeout(() => {
			this._activationTimer = undefined;
			void this._runGated('activation');
			this._schedulePeriodic();
		}, CHECKPOINT_COMPARE_ACTIVATION_DELAY_MS);
	}

	noteCheckpoint(session: URI): void {
		if (this._disposed) {
			return;
		}
		// Cursor class `pw`: noteCheckpoint(e) { pendingCheckpointSessions.add(e);
		// clearTimeout(checkpointTimer); checkpointTimer = setTimeout(compare, checkpointDebounceMs) }
		const key = session.toString();
		this._pendingCheckpointSessions.set(key, session);
		if (this._checkpointTimer !== undefined) {
			clearTimeout(this._checkpointTimer);
		}
		this._checkpointTimer = setTimeout(() => {
			this._checkpointTimer = undefined;
			const sessions = [...this._pendingCheckpointSessions.values()];
			this._pendingCheckpointSessions.clear();
			void this._runGated('checkpoint', sessions);
		}, CHECKPOINT_COMPARE_DEBOUNCE_MS);
	}

	runNow(trigger: StorageCompareTrigger, sessions: readonly URI[]): Promise<IStorageCompareRunSummary | undefined> {
		if (this._disposed) {
			return Promise.resolve(undefined);
		}
		return this._runGated(trigger, sessions);
	}

	/**
	 * Single-flight entry: concurrent compare requests are queued and
	 * merged; a `checkpoint` trigger wins over `interval`/`activation`
	 * (Cursor class `pw`, OBSERVED).
	 */
	private _runGated(trigger: StorageCompareTrigger, sessions?: readonly URI[]): Promise<IStorageCompareRunSummary | undefined> {
		if (this._activeRun) {
			this._queuedTriggers.add(trigger);
			if (sessions) {
				for (const session of sessions) {
					this._queuedSessions.set(session.toString(), session);
				}
			}
			return this._activeRun;
		}
		return this._startRun(trigger, sessions);
	}

	private async _startRun(trigger: StorageCompareTrigger, sessions?: readonly URI[]): Promise<IStorageCompareRunSummary | undefined> {
		// Cursor class `pw`: interval compares require the catalog lease;
		// checkpoint-triggered compares bypass it and always run.
		if ((trigger === 'interval' || trigger === 'activation') && !this._catalogLease.tryAcquire()) {
			const pid = this._catalogLease.holderPid ?? '?';
			this._logService.info(`[hostStorage] catalog compares run in another window (pid ${pid}); this host compares only the sessions it checkpoints`);
			return undefined;
		}
		let targets = sessions;
		if (!targets) {
			targets = await this._listPeriodicSessionIds();
		}
		const run = this._runCompare(trigger, targets);
		this._activeRun = run;
		try {
			return await run;
		} finally {
			this._activeRun = undefined;
			// Drain merged requests: `checkpoint` wins over `interval`/`activation`.
			if (this._queuedTriggers.size > 0 && !this._disposed) {
				const triggers = [...this._queuedTriggers];
				this._queuedTriggers.clear();
				const queuedSessions = [...this._queuedSessions.values()];
				this._queuedSessions.clear();
				const nextTrigger: StorageCompareTrigger = triggers.includes('checkpoint') ? 'checkpoint' : triggers[0];
				void this._startRun(nextTrigger, queuedSessions);
			}
		}
	}

	private async _listPeriodicSessionIds(): Promise<URI[]> {
		try {
			const registered = await this._sessionRegistry.list();
			return registered.map(r => r.session);
		} catch (err) {
			this._logService.warn('[AgentHostStorageCompare] Failed to list registered sessions for periodic compare', err);
			return [];
		}
	}

	private _schedulePeriodic(): void {
		if (this._disposed) {
			return;
		}
		if (this._periodicTimer !== undefined) {
			clearTimeout(this._periodicTimer);
		}
		this._periodicTimer = setTimeout(() => {
			this._periodicTimer = undefined;
			void this._runGated('interval');
			this._schedulePeriodic();
		}, CHECKPOINT_COMPARE_INTERVAL_MS);
	}

	private async _runCompare(trigger: StorageCompareTrigger, sessions: readonly URI[]): Promise<IStorageCompareRunSummary> {
		const dedup = new FailureDedup();
		const verdicts: Record<StorageCompareVerdict, number> = { pass: 0, lag: 0, warn: 0, fail: 0, busy: 0 };
		for (const session of sessions) {
			let verdict: StorageCompareVerdict;
			let detail: string | undefined;
			try {
				({ verdict, detail } = await this._compareSession(session));
			} catch (err) {
				verdict = 'fail';
				detail = `compare threw: ${err instanceof Error ? err.message : String(err)}`;
			}
			verdicts[verdict]++;
			if ((verdict === 'fail' || verdict === 'warn') && detail) {
				dedup.note(`[${session.toString()}] ${detail}`, message =>
					this._logService.warn(`[AgentHostStorageCompare] ${trigger} compare ${verdict}: ${message}`));
			}
		}
		const summary: IStorageCompareRunSummary = { trigger, compared: sessions.length, verdicts };
		this._logService.debug(`[AgentHostStorageCompare] ${trigger} compare finished: ${sessions.length} sessions (pass=${verdicts.pass}, warn=${verdicts.warn}, fail=${verdicts.fail}).`);
		return summary;
	}

	/**
	 * The actual durability check for one session: the host-owned database
	 * must open, and every checkpoint ref it records must resolve in the
	 * repositories — the analog of Cursor's "hydrate throws if the root
	 * blob is missing".
	 */
	private async _compareSession(session: URI): Promise<{ verdict: StorageCompareVerdict; detail?: string }> {
		const ref = await this._sessionDataService.tryOpenDatabase(session);
		if (!ref) {
			return { verdict: 'warn', detail: 'no session database on disk yet' };
		}
		try {
			const checkpointRefs = await ref.object.getAllCheckpointRefs();
			if (checkpointRefs.length === 0) {
				return { verdict: 'pass' };
			}
			const repositories = await this._resolveCheckpointRepositories(ref.object, session);
			if (repositories.length === 0) {
				return { verdict: 'warn', detail: `${checkpointRefs.length} checkpoint ref(s) recorded but no repository to resolve them against` };
			}
			const missing: string[] = [];
			for (const repository of repositories) {
				for (const checkpointRef of checkpointRefs) {
					let oid: string | undefined;
					try {
						oid = await this._gitService.revParse(repository, checkpointRef);
					} catch {
						oid = undefined;
					}
					if (!oid) {
						missing.push(`${checkpointRef} in ${repository.toString()}`);
					}
				}
			}
			if (missing.length > 0) {
				return { verdict: 'fail', detail: `unresolvable checkpoint ref(s): ${missing.join('; ')}` };
			}
			return { verdict: 'pass' };
		} finally {
			ref.dispose();
		}
	}

	private async _resolveCheckpointRepositories(db: { getMetadata(key: string): Promise<string | undefined> }, session: URI): Promise<URI[]> {
		const recorded = this._parseCheckpointRepositories(await db.getMetadata(SESSION_CHECKPOINT_REPOSITORIES_METADATA_KEY));
		if (recorded.length > 0) {
			return recorded.map(root => URI.parse(root));
		}
		const roots = new Map<string, URI>();
		for (const workingDirectory of this._agentConfigService.getEffectiveWorkingDirectories(session.toString()) ?? []) {
			try {
				const root = await this._gitService.getRepositoryRoot(URI.parse(workingDirectory));
				if (root) {
					roots.set(root.toString(), root);
				}
			} catch {
				// Unresolvable working directory: skip, the caller reports the gap.
			}
		}
		return [...roots.values()];
	}

	private _parseCheckpointRepositories(raw: string | undefined): string[] {
		if (!raw) {
			return [];
		}
		try {
			const parsed: unknown = JSON.parse(raw);
			return Array.isArray(parsed) ? parsed.filter((root): root is string => typeof root === 'string' && root.length > 0) : [];
		} catch {
			return [];
		}
	}

	override dispose(): void {
		this._disposed = true;
		if (this._checkpointTimer !== undefined) {
			clearTimeout(this._checkpointTimer);
			this._checkpointTimer = undefined;
		}
		if (this._activationTimer !== undefined) {
			clearTimeout(this._activationTimer);
			this._activationTimer = undefined;
		}
		if (this._periodicTimer !== undefined) {
			clearTimeout(this._periodicTimer);
			this._periodicTimer = undefined;
		}
		this._pendingCheckpointSessions.clear();
		this._queuedTriggers.clear();
		this._queuedSessions.clear();
		super.dispose();
	}
}
