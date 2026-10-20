/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { describe, it } from 'node:test';
import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import type { IFileService, IFileContent, IStat } from '../../../../../platform/files/common/files.js';
import type { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import type { IEnvironmentService } from '../../../../../platform/environment/common/environment.js';
import {
	CheckpointService,
	CheckpointStorageCompareService,
	CheckpointCompareSessionsFn,
	CheckpointSessionCompareResult,
	ICheckpointStorageCompareTimer,
	activationDelayMs,
	checkpointDebounceMs,
	failureClusterCap,
	failureEventsPerRunCap,
	failureSamplesPerClusterCap,
	intervalMs,
} from '../../common/checkpointService.js';

/**
 * WORKER-GAPS-30A — host-storage compare scheduling tests (node:test, zero
 * extra deps), mirroring DEV-GAPS-21 W21E's extension-side suite.
 *
 * Covers the Cursor-parity scheduling of the host-storage compare service.
 * Binary evidence (coordinator-verified 2026-10-20, direct grep):
 *   3.25.6 `extensions/cursor-agent-host/dist/main.js` —
 *     `activationDelayMs=e.activationDelayMs??15e3` @10572158,
 *     `intervalMs=e.intervalMs??6e5` @10572207,
 *     `checkpointDebounceMs=e.checkpointDebounceMs??6e4` @10572241;
 *   3.25.9 — same 3 literals @10583638 / @10583687 / @10583721,
 *   all in the same constructor of the host-storage compare service class
 *   (class `pw`), adjacent to `noteCheckpoint` and the single-flight merge.
 *   See docs/rea/deepdig-runtime-checkpoint-2026-10-19.md §1.4.
 *
 *   - the three timing constants together: 60 s debounce / 10 min interval /
 *     15 s activation delay
 *   - noteCheckpoint: pending set + 60 s debounce reset + trigger "checkpoint"
 *   - single-flight merge: checkpoint trigger wins over interval
 *   - cross-window catalog lease: interval compares need it, checkpoint
 *     compares bypass it
 *   - failure dedup caps: 4 clusters / 3 samples per cluster / 10 events per run
 *   - wiring: CheckpointService.persist() fires noteCheckpoint(composerId),
 *     and the injected verifier passes on a well-formed store / fails on a
 *     corrupt one
 *
 * Timing is driven by a virtual FakeTimer (no 60 s real waits).
 *
 * Run: transpile the closure to /tmp and run with node --test, e.g.
 *   npx tsc src/vs/workbench/contrib/composer/test/common/checkpointStorageCompare.test.ts \
 *     --outDir /tmp/ckpt-core-test --module commonjs --target es2022 \
 *     --moduleResolution node --esModuleInterop --skipLibCheck
 *   node --test /tmp/ckpt-core-test/src/vs/workbench/contrib/composer/test/common/checkpointStorageCompare.test.js
 */

/* ---------- virtual timer ---------- */

class FakeTimer implements ICheckpointStorageCompareTimer {
	private queue: Array<{ id: number; at: number; cb: () => void }> = [];
	private nextId = 1;
	nowMs = 0;

	now(): number {
		return this.nowMs;
	}
	setTimeout(cb: () => void, ms: number): unknown {
		const id = this.nextId++;
		this.queue.push({ id, at: this.nowMs + ms, cb });
		return id;
	}
	clearTimeout(id: unknown): void {
		this.queue = this.queue.filter((t) => t.id !== id);
	}
	armedCount(): number {
		return this.queue.length;
	}
	/** Advance virtual time, firing due timers in order; flush async work. */
	async advance(ms: number): Promise<void> {
		const end = this.nowMs + ms;
		for (;;) {
			this.queue.sort((a, b) => a.at - b.at);
			const next = this.queue[0];
			if (!next || next.at > end) {
				break;
			}
			this.queue.shift();
			this.nowMs = next.at;
			next.cb();
			await flush();
		}
		this.nowMs = end;
		await flush();
	}
}

async function flush(rounds = 8): Promise<void> {
	for (let i = 0; i < rounds; i++) {
		await new Promise((r) => setImmediate(r));
	}
}

function passAll(sessions: readonly string[]): CheckpointSessionCompareResult[] {
	return sessions.map((sessionId) => ({ sessionId, verdict: 'pass' as const }));
}

function makeService(
	timer: FakeTimer,
	extra: {
		compare?: CheckpointCompareSessionsFn;
		lease?: { tryAcquire(): boolean; holderPid?(): number | undefined };
	} = {},
): {
	svc: CheckpointStorageCompareService;
	logs: string[];
	compareCalls: string[][];
} {
	const logs: string[] = [];
	const compareCalls: string[][] = [];
	const svc = new CheckpointStorageCompareService({
		timer,
		lease: extra.lease,
		onLog: (m) => logs.push(m),
		compareSessions: async (sessionIds) => {
			compareCalls.push([...sessionIds]);
			return (extra.compare ?? passAll)(sessionIds);
		},
	});
	return { svc, logs, compareCalls };
}

/** Triggers of completed compares, parsed from the service's own log lines. */
function triggersOf(logs: string[]): string[] {
	return logs
		.map((l) => /compare done \(trigger=(\w+)/.exec(l)?.[1])
		.filter((t): t is string => !!t);
}

/* ---------- in-memory IFileService fake (for the wiring tests) ---------- */

class MemFileService {
	private files = new Map<string, Uint8Array>();
	private dirs = new Set<string>();

	private key(uri: URI): string {
		return uri.toString();
	}

	async stat(uri: URI): Promise<IStat> {
		const k = this.key(uri);
		const data = this.files.get(k);
		if (data) {
			return { resource: uri, isFile: true, isDirectory: false, size: data.length } as unknown as IStat;
		}
		if (this.dirs.has(k)) {
			return { resource: uri, isFile: false, isDirectory: true, size: 0 } as unknown as IStat;
		}
		throw new Error(`ENOENT: ${k}`);
	}

	async readFile(uri: URI): Promise<IFileContent> {
		const data = this.files.get(this.key(uri));
		if (!data) {
			throw new Error(`ENOENT: ${uri.toString()}`);
		}
		return { resource: uri, value: VSBuffer.wrap(data) } as IFileContent;
	}

	async writeFile(uri: URI, content: VSBuffer): Promise<void> {
		this.files.set(this.key(uri), content.buffer);
	}

	async del(uri: URI): Promise<void> {
		this.files.delete(this.key(uri));
		this.dirs.delete(this.key(uri));
	}

	async createFolder(uri: URI): Promise<void> {
		this.dirs.add(this.key(uri));
	}

	watch(): { dispose(): void } {
		return { dispose() { } };
	}

	onDidFilesChange(): { dispose(): void } {
		return { dispose() { } };
	}

	asService(): IFileService {
		return this as unknown as IFileService;
	}
}

describe('checkpoint storage compare scheduling (binary: cursor-agent-host/dist/main.js, class pw)', () => {

	it('timing constants match the binary-verified values', () => {
		assert.strictEqual(checkpointDebounceMs, 60_000, 'checkpointDebounceMs');
		assert.strictEqual(intervalMs, 600_000, 'intervalMs');
		assert.strictEqual(activationDelayMs, 15_000, 'activationDelayMs');
		assert.strictEqual(failureClusterCap, 4, 'failureClusterCap');
		assert.strictEqual(failureSamplesPerClusterCap, 3, 'failureSamplesPerClusterCap');
		assert.strictEqual(failureEventsPerRunCap, 10, 'failureEventsPerRunCap');
	});

	it('start(): first interval compare at 15s, then every 10min; idempotent', async () => {
		const timer = new FakeTimer();
		const { svc, compareCalls } = makeService(timer);
		svc.start();
		svc.start(); // idempotent — still a single activation timer
		assert.strictEqual(timer.armedCount(), 1);
		await timer.advance(activationDelayMs - 1);
		assert.strictEqual(compareCalls.length, 0);
		await timer.advance(1);
		assert.strictEqual(compareCalls.length, 1);
		assert.deepStrictEqual(compareCalls[0], [], 'no known sessions yet');
		await timer.advance(intervalMs);
		assert.strictEqual(compareCalls.length, 2);
		await timer.advance(intervalMs);
		assert.strictEqual(compareCalls.length, 3);
		svc.dispose();
	});

	it('noteCheckpoint: 60s debounce, then a checkpoint-triggered compare with the noted sessions', async () => {
		const timer = new FakeTimer();
		const { svc, logs, compareCalls } = makeService(timer);
		svc.noteCheckpoint('s1'); // no start(): isolate the debounce path
		assert.strictEqual(svc.getArmedTimerCount(), 1);
		await timer.advance(checkpointDebounceMs - 1);
		assert.strictEqual(compareCalls.length, 0);
		await timer.advance(1);
		assert.strictEqual(compareCalls.length, 1);
		assert.deepStrictEqual(compareCalls[0], ['s1']);
		assert.deepStrictEqual(triggersOf(logs), ['checkpoint']);
		svc.dispose();
	});

	it('noteCheckpoint resets the 60s debounce; pending sessions accumulate', async () => {
		const timer = new FakeTimer();
		const { svc, compareCalls } = makeService(timer);
		svc.noteCheckpoint('s1');
		await timer.advance(30_000);
		svc.noteCheckpoint('s2'); // resets the debounce
		await timer.advance(59_999);
		assert.strictEqual(compareCalls.length, 0, 'debounce was reset — no compare yet');
		await timer.advance(1);
		assert.strictEqual(compareCalls.length, 1, 'exactly one compare after the reset debounce');
		assert.deepStrictEqual([...compareCalls[0]!].sort(), ['s1', 's2']);
		svc.dispose();
	});

	it('single-flight: concurrent compares merge, checkpoint trigger wins over interval', async () => {
		const timer = new FakeTimer();
		const compareCalls: string[][] = [];
		const logs: string[] = [];
		let resolveFirst!: (r: CheckpointSessionCompareResult[]) => void;
		const svc = new CheckpointStorageCompareService({
			timer,
			onLog: (m) => logs.push(m),
			compareSessions: (ids) => {
				compareCalls.push([...ids]);
				if (compareCalls.length === 1) {
					// First compare hangs — everything else must merge behind it.
					return new Promise<CheckpointSessionCompareResult[]>((resolve) => {
						resolveFirst = resolve;
					});
				}
				return passAll(ids);
			},
		});
		svc.start(); // activation at 15s
		svc.noteCheckpoint('a'); // debounce at 60s
		await timer.advance(activationDelayMs); // t=15s: interval compare starts and hangs
		assert.strictEqual(compareCalls.length, 1);
		assert.deepStrictEqual(compareCalls[0], ['a'], 'interval sweep covers known sessions');
		await timer.advance(checkpointDebounceMs - activationDelayMs); // t=60s: debounce → queued behind running
		svc.noteCheckpoint('b'); // pending={b}, debounce re-armed
		await timer.advance(checkpointDebounceMs); // t=120s: second debounce → merges into the queued request
		assert.strictEqual(compareCalls.length, 1, 'still single-flight');
		resolveFirst(passAll(['a']));
		await flush();
		await flush();
		assert.strictEqual(compareCalls.length, 2, 'one merged follow-up compare ran');
		assert.deepStrictEqual([...compareCalls[1]!].sort(), ['a', 'b'], 'sessions unioned');
		assert.deepStrictEqual(triggersOf(logs), ['interval', 'checkpoint'], 'checkpoint trigger wins the merge');
		svc.dispose();
	});

	it('interval compares require the catalog lease; checkpoint-triggered compares bypass it', async () => {
		const timer = new FakeTimer();
		const { svc, logs, compareCalls } = makeService(timer, {
			lease: { tryAcquire: () => false, holderPid: () => 1234 },
		});
		svc.start();
		svc.noteCheckpoint('s1');
		await timer.advance(activationDelayMs); // interval due → lease denied → skipped
		assert.strictEqual(compareCalls.length, 0);
		assert.ok(
			logs.some((l) =>
				l.includes('catalog compares run in another window (pid 1234); this host compares only the sessions it checkpoints'),
			),
			'binary-verbatim skip log line',
		);
		await timer.advance(checkpointDebounceMs - activationDelayMs); // debounce due → bypasses lease
		assert.strictEqual(compareCalls.length, 1);
		assert.deepStrictEqual(compareCalls[0], ['s1']);
		assert.deepStrictEqual(triggersOf(logs), ['checkpoint']);
		svc.dispose();
	});

	it('failure dedup: at most 4 clusters', async () => {
		const timer = new FakeTimer();
		const { svc } = makeService(timer, {
			compare: (ids) => ids.map((sessionId) => ({
				sessionId,
				verdict: 'fail' as const,
				detail: `err-${sessionId}`, // 6 distinct details → 6 wanted clusters
			})),
		});
		for (let i = 0; i < 6; i++) {
			svc.noteCheckpoint(`s${i}`);
		}
		await timer.advance(checkpointDebounceMs);
		assert.strictEqual(svc.getFailureClusters().length, 4);
		svc.dispose();
	});

	it('failure dedup: at most 3 samples per cluster and 10 events per run', async () => {
		const timer = new FakeTimer();
		const { svc } = makeService(timer, {
			compare: (ids) => ids.map((sessionId, i) => ({
				sessionId,
				verdict: 'fail' as const,
				detail: `err-${i % 4}`, // 4 distinct details → 4 clusters, 12 events total
			})),
		});
		for (let i = 0; i < 12; i++) {
			svc.noteCheckpoint(`s${i}`);
		}
		await timer.advance(checkpointDebounceMs);
		const clusters = svc.getFailureClusters();
		const totalSamples = clusters.reduce((n, c) => n + c.samples.length, 0);
		assert.ok(clusters.every((c) => c.samples.length <= 3), 'at most 3 samples per cluster');
		// 4 clusters × 3 samples = 12 capacity, but the 10-events-per-run cap binds.
		assert.strictEqual(totalSamples, 10, `expected the 10/run cap to bind, got ${totalSamples}`);
		svc.dispose();
	});

	it('dispose() clears timers; start/noteCheckpoint after dispose are no-ops', async () => {
		const timer = new FakeTimer();
		const { svc, compareCalls } = makeService(timer);
		svc.start();
		svc.noteCheckpoint('s1');
		assert.strictEqual(svc.getArmedTimerCount(), 2);
		svc.dispose();
		assert.strictEqual(svc.getArmedTimerCount(), 0);
		assert.strictEqual(timer.armedCount(), 0);
		svc.start();
		svc.noteCheckpoint('s2');
		assert.strictEqual(timer.armedCount(), 0);
		await timer.advance(intervalMs * 2);
		assert.strictEqual(compareCalls.length, 0);
	});
});

describe('CheckpointService wiring: persist() -> noteCheckpoint -> storage compare', () => {

	function makeCheckpointService(timer: FakeTimer) {
		const logs: string[] = [];
		const compareResults: CheckpointSessionCompareResult[][] = [];
		const memfs = new MemFileService();
		let verifier!: (ids: readonly string[]) => Promise<CheckpointSessionCompareResult[]>;
		const storageCompare = new CheckpointStorageCompareService({
			timer,
			onLog: (m) => logs.push(m),
			compareSessions: async (ids) => {
				const results = await verifier(ids);
				compareResults.push(results);
				return results;
			},
		});
		const svc = new CheckpointService(
			{ getWorkspace: () => ({ folders: [{ uri: URI.file('/ws') }] }) } as unknown as IWorkspaceContextService,
			memfs.asService(),
			{ workspaceStorageHome: URI.file('/ws-storage') } as unknown as IEnvironmentService,
			{ storageCompare },
		);
		verifier = (ids) =>
			(svc as unknown as {
				verifyCheckpointStorage(ids: readonly string[]): Promise<CheckpointSessionCompareResult[]>;
			}).verifyCheckpointStorage(ids);
		return { svc, memfs, logs, compareResults, storageCompare };
	}

	it('a successful persist arms the 60s debounce; the compare passes on a well-formed store', async () => {
		const timer = new FakeTimer();
		const { svc, logs, compareResults } = makeCheckpointService(timer);
		await svc.captureBefore('b1', 'hello');
		// persist() fired noteCheckpoint('default'); ctor start() armed the activation timer.
		assert.strictEqual(timer.armedCount(), 2);
		await timer.advance(checkpointDebounceMs);
		// Two compares ran: the 15s activation sweep (interval trigger, known
		// sessions) and the 60s checkpoint-triggered compare. Both pass.
		assert.strictEqual(compareResults.length, 2);
		for (const results of compareResults) {
			assert.deepStrictEqual(
				results.map((r) => r.sessionId),
				['default'],
			);
			assert.deepStrictEqual(
				results.map((r) => r.verdict),
				['pass'],
			);
		}
		assert.deepStrictEqual(triggersOf(logs), ['interval', 'checkpoint']);
		svc.dispose();
	});

	it('a corrupt store yields a fail verdict with detail (feeds failure dedup)', async () => {
		const timer = new FakeTimer();
		const { svc, memfs, compareResults, storageCompare } = makeCheckpointService(timer);
		await svc.captureBefore('b1', 'hello');
		const storeUri = URI.joinPath(URI.file('/ws-storage'), 'ide-agent', 'checkpoints-default.json');
		await memfs.writeFile(storeUri, VSBuffer.fromString('{{{corrupt'));
		storageCompare.noteCheckpoint('default');
		await timer.advance(checkpointDebounceMs);
		// Activation sweep (15s) and checkpoint compare (60s) both fail.
		assert.strictEqual(compareResults.length, 2);
		for (const results of compareResults) {
			assert.strictEqual(results[0]!.verdict, 'fail');
			assert.ok(results[0]!.detail, 'fail carries a detail for dedup');
		}
		// Same (verdict, detail-class) → one cluster, two samples.
		const clusters = storageCompare.getFailureClusters();
		assert.strictEqual(clusters.length, 1);
		assert.strictEqual(clusters[0]!.samples.length, 2);
		svc.dispose();
	});

	it('sessions other than the composer pass through unverified', async () => {
		const timer = new FakeTimer();
		const { svc, compareResults } = makeCheckpointService(timer);
		const verifier = (
			svc as unknown as {
				verifyCheckpointStorage(ids: readonly string[]): Promise<CheckpointSessionCompareResult[]>;
			}
		).verifyCheckpointStorage.bind(svc);
		const results = await verifier(['some-other-session']);
		assert.deepStrictEqual(results, [{ sessionId: 'some-other-session', verdict: 'pass' }]);
		assert.strictEqual(compareResults.length, 0, 'no compare ran — direct verifier call');
		svc.dispose();
	});
});
