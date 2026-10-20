/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../base/common/uri.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

export const IAgentHostStorageCompareService = createDecorator<IAgentHostStorageCompareService>('agentHostStorageCompareService');

/**
 * What kicked off a storage compare run.
 * Mirrors the triggers of Cursor 3.25.6's host-storage compare service
 * (`cursor-agent-host/dist/main.js`, class `pw`, OBSERVED): the activation
 * sweep shortly after start, the periodic interval sweep, and the
 * checkpoint-noted sweep.
 */
export type StorageCompareTrigger = 'activation' | 'interval' | 'checkpoint';

/**
 * Per-session verdict of a host-owned storage compare.
 * Mirrors Cursor 3.25.6 class `pw`'s verdict set
 * (`pass | lag | warn | fail | busy`, OBSERVED).
 *
 * This implementation emits `pass | warn | fail` from the per-session
 * compare. `lag` and `busy` are reserved: Cursor emits `lag` when its
 * in-memory checkpoint root trails the committed root — our git-ref
 * captures are serialized per session (`SequencerByKey` in
 * `AgentHostCheckpointService`), so that trailing window does not exist
 * here — and `busy` when a compare is already running, which we handle
 * with single-flight merging instead of a verdict.
 */
export type StorageCompareVerdict = 'pass' | 'lag' | 'warn' | 'fail' | 'busy';

export interface IStorageCompareRunSummary {
	readonly trigger: StorageCompareTrigger;
	readonly compared: number;
	readonly verdicts: Record<StorageCompareVerdict, number>;
}

/**
 * Host-side compare of host-owned session storage, mirroring Cursor 3.25.6's
 * host-storage compare service (class `pw` in `cursor-agent-host/dist/main.js`,
 * OBSERVED — see `docs/rea/deepdig-runtime-checkpoint-2026-10-19.md` §1.4).
 *
 * Cursor's service periodically verifies that what the host wrote to its
 * local session store is actually durable and consistent (its analog of
 * "hydrate throws if the root blob is missing"), with:
 * - a 15s activation delay before the first periodic compare,
 * - a 10min periodic compare interval,
 * - a 60s debounce after `noteCheckpoint(sessionId)` before a
 *   checkpoint-triggered compare,
 * - single-flight merging of concurrent compare requests (a `checkpoint`
 *   trigger wins over `interval`),
 * - a cross-window catalog lease gating interval compares
 *   (checkpoint-triggered compares bypass the lease and always run).
 *
 * Our analog of "host-owned storage" is the per-session SQLite database
 * (`ISessionDataService`) plus the checkpoint refs it records, resolved
 * against the repositories via `IAgentHostGitService` — the direct
 * equivalent of Cursor's "root blob missing" check.
 */
export interface IAgentHostStorageCompareService {
	readonly _serviceBrand: undefined;

	/**
	 * Starts the compare loop: first periodic compare
	 * `CHECKPOINT_COMPARE_ACTIVATION_DELAY_MS` after start, then every
	 * `CHECKPOINT_COMPARE_INTERVAL_MS`. Idempotent; safe to call once the
	 * host has settled (mirrors Cursor starting the service at host boot).
	 */
	start(): void;

	/**
	 * Notes that `session` just committed a checkpoint. Adds it to the
	 * pending set, resets the `CHECKPOINT_COMPARE_DEBOUNCE_MS` debounce
	 * timer, then runs a compare with trigger `"checkpoint"`.
	 * (Cursor 3.25.6: `noteCheckpoint(e)`.)
	 */
	noteCheckpoint(session: URI): void;

	/**
	 * Runs one compare pass immediately for `sessions`, bypassing the
	 * debounce. Interval/activation triggers still honor the catalog lease;
	 * `checkpoint` always runs. Concurrent calls are single-flight merged.
	 */
	runNow(trigger: StorageCompareTrigger, sessions: readonly URI[]): Promise<IStorageCompareRunSummary | undefined>;
}
