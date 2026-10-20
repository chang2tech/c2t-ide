/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { IReference } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ILogService, NullLogService } from '../../../log/common/log.js';
import { mock } from '../../../../base/test/common/mock.js';
import { IAgentHostGitService } from '../../common/agentHostGitService.js';
import { SESSION_CHECKPOINT_REPOSITORIES_METADATA_KEY } from '../../common/sessionDataService.js';
import { IAgentConfigurationService } from '../../node/agentConfigurationService.js';
import { AgentSessionRegistry } from '../../node/agentSessionRegistry.js';import {
	AgentHostStorageCompareService,
	CHECKPOINT_COMPARE_ACTIVATION_DELAY_MS,
	CHECKPOINT_COMPARE_DEBOUNCE_MS,
	CHECKPOINT_COMPARE_INTERVAL_MS,
	ICatalogLease,
} from '../../node/agentHostStorageCompareService.js';
import { createNoopGitService, createNullSessionDataService, TestSessionDatabase } from '../common/sessionTestHelpers.js';
import { ISessionDataService } from '../../common/sessionDataService.js';

function createReference<T>(object: T): IReference<T> {
	return { object, dispose: () => { } };
}

/** Manual clock: the service under test uses the global setTimeout/clearTimeout. */
class FakeClock {
	private now = 0;
	private nextId = 1;
	private readonly timers = new Map<number, { at: number; callback: () => void }>();

	setTimeout(callback: () => void, ms: number): unknown {
		const id = this.nextId++;
		this.timers.set(id, { at: this.now + ms, callback });
		return id;
	}

	clearTimeout(id: unknown): void {
		this.timers.delete(id as number);
	}

	get pendingCount(): number {
		return this.timers.size;
	}

	/** Runs every timer due within `ms`, in time order, flushing async continuations between them. */
	async tick(ms: number): Promise<void> {
		const end = this.now + ms;
		for (;;) {
			let nextId: number | undefined;
			let nextAt = Infinity;
			for (const [id, timer] of this.timers) {
				if (timer.at <= end && timer.at < nextAt) {
					nextAt = timer.at;
					nextId = id;
				}
			}
			if (nextId === undefined) {
				break;
			}
			const timer = this.timers.get(nextId)!;
			this.timers.delete(nextId);
			this.now = nextAt;
			timer.callback();
			await flushAsync();
		}
		this.now = end;
		await flushAsync();
	}
}

async function flushAsync(rounds = 2000): Promise<void> {
	for (let i = 0; i < rounds; i++) {
		await Promise.resolve();
	}
}

class CapturingLogService extends NullLogService {
	declare readonly _serviceBrand: undefined;
	public readonly infos: string[] = [];
	public readonly warns: string[] = [];
	public readonly debugs: string[] = [];

	override info(message: string, ...args: unknown[]): void {
		this.infos.push([message, ...args.map(String)].join(' '));
	}
	override warn(message: string, ...args: unknown[]): void {
		this.warns.push([message, ...args.map(String)].join(' '));
	}
	override debug(message: string, ...args: unknown[]): void {
		this.debugs.push([message, ...args.map(String)].join(' '));
	}
}

class CompareTestDatabase extends TestSessionDatabase {
	constructor(refs: string[], repos: string[]) {
		super();
		void this.setMetadata(SESSION_CHECKPOINT_REPOSITORIES_METADATA_KEY, JSON.stringify(repos));
		this._refs = refs;
	}
	private readonly _refs: string[];

	override async getAllCheckpointRefs(): Promise<string[]> {
		return [...this._refs];
	}
}

function createDataService(databases: Map<string, CompareTestDatabase>): ISessionDataService {
	return {
		...createNullSessionDataService(),
		tryOpenDatabase: async (session: URI) => {
			const db = databases.get(session.toString());
			return db ? createReference(db) : undefined;
		},
	};
}

interface Harness {
	readonly service: AgentHostStorageCompareService;
	readonly log: CapturingLogService;
	readonly clock: FakeClock;
	readonly databases: Map<string, CompareTestDatabase>;
	readonly revParseCalls: { root: string; expr: string }[];
	releaseRevParse: () => void;
	holdRevParse: () => void;
}

const REPO = 'file:///repo';

function sessionUri(id: string): URI {
	return URI.parse(`ahp-session:/${id}`);
}

suite('AgentHostStorageCompareService', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let clock: FakeClock;
	let realSetTimeout: typeof setTimeout;
	let realClearTimeout: typeof clearTimeout;

	setup(() => {
		clock = new FakeClock();
		realSetTimeout = globalThis.setTimeout;
		realClearTimeout = globalThis.clearTimeout;
		globalThis.setTimeout = clock.setTimeout.bind(clock) as unknown as typeof setTimeout;
		globalThis.clearTimeout = clock.clearTimeout.bind(clock) as unknown as typeof clearTimeout;
	});

	teardown(() => {
		globalThis.setTimeout = realSetTimeout;
		globalThis.clearTimeout = realClearTimeout;
	});

	function createHarness(options?: {
		sessions?: URI[];
		databases?: Map<string, CompareTestDatabase>;
		unresolvableRefs?: Set<string>;
		lease?: ICatalogLease;
	}): Harness {
		const log = new CapturingLogService();
		const databases = options?.databases ?? new Map<string, CompareTestDatabase>();
		const unresolvableRefs = options?.unresolvableRefs ?? new Set<string>();
		const revParseCalls: { root: string; expr: string }[] = [];
		let revParseGate: Promise<void> | undefined;
		let releaseGate: (() => void) | undefined;

		const gitService: IAgentHostGitService = {
			...createNoopGitService(),
			getRepositoryRoot: async (dir: URI) => dir,
			revParse: async (root: URI, expr: string) => {
				revParseCalls.push({ root: root.toString(), expr });
				if (revParseGate) {
					await revParseGate;
				}
				return unresolvableRefs.has(expr) ? undefined : `oid-for-${expr}`;
			},
		};
		const configService = new (mock<IAgentConfigurationService>())();
		configService.getEffectiveWorkingDirectories = () => [];
		const registry = {
			_serviceBrand: undefined,
			list: async () => (options?.sessions ?? []).map(session => ({ session })),
		} as unknown as AgentSessionRegistry;

		const service = store.add(new AgentHostStorageCompareService(
			log as ILogService,
			createDataService(databases),
			gitService,
			configService,
			registry,
			options?.lease,
		));
		return {
			service, log, clock, databases, revParseCalls,
			holdRevParse: () => { revParseGate = new Promise<void>(resolve => { releaseGate = resolve; }); },
			releaseRevParse: () => { releaseGate?.(); revParseGate = undefined; releaseGate = undefined; },
		};
	}

	function addSession(harness: Harness, id: string, refs: string[], repos: string[] = [REPO]): URI {
		const session = sessionUri(id);
		harness.databases.set(session.toString(), new CompareTestDatabase(refs, repos));
		return session;
	}

	function finishedTriggers(harness: Harness): string[] {
		return harness.log.debugs
			.map(m => /compare finished/.test(m) ? m.match(/(\w+) compare finished/)?.[1] : undefined)
			.filter((t): t is string => !!t);
	}

	test('adopts Cursor 3.25.6 compare-service constants (60s debounce, 10min interval, 15s activation)', () => {
		// Re-verified against cursor-agent-host/dist/main.js 3.25.6 class `pw`:
		// checkpointDebounceMs ?? 6e4, intervalMs ?? 6e5, activationDelayMs ?? 15e3.
		assert.strictEqual(CHECKPOINT_COMPARE_DEBOUNCE_MS, 60_000);
		assert.strictEqual(CHECKPOINT_COMPARE_INTERVAL_MS, 600_000);
		assert.strictEqual(CHECKPOINT_COMPARE_ACTIVATION_DELAY_MS, 15_000);
	});

	test('start() runs the activation compare 15s after start, then a periodic compare every 10min', async () => {
		const a = sessionUri('a');
		const b = sessionUri('b');
		const harness = createHarness({ sessions: [a, b] });
		harness.service.start();

		await clock.tick(CHECKPOINT_COMPARE_ACTIVATION_DELAY_MS - 1);
		assert.strictEqual(harness.revParseCalls.length, 0);

		await clock.tick(1);
		assert.deepStrictEqual(finishedTriggers(harness), ['activation']);

		await clock.tick(CHECKPOINT_COMPARE_INTERVAL_MS - 1);
		assert.deepStrictEqual(finishedTriggers(harness), ['activation']);
		await clock.tick(1);
		assert.deepStrictEqual(finishedTriggers(harness), ['activation', 'interval']);
	});

	test('noteCheckpoint debounces 60s and merges noted sessions into one checkpoint compare', async () => {
		const harness = createHarness();
		const a = addSession(harness, 'a', []);
		const b = addSession(harness, 'b', []);
		// Note: start() is intentionally not called — the checkpoint debounce
		// timer is independent of the activation/periodic loop.

		harness.service.noteCheckpoint(a);
		await clock.tick(30_000);
		harness.service.noteCheckpoint(b); // resets the 60s debounce timer
		await clock.tick(59_999);
		assert.deepStrictEqual(finishedTriggers(harness), []);

		await clock.tick(1);
		assert.deepStrictEqual(finishedTriggers(harness), ['checkpoint']);
		const summary = await harness.service.runNow('checkpoint', [a, b]);
		assert.strictEqual(summary?.compared, 2);
	});

	test('interval compares require the catalog lease; checkpoint-triggered compares bypass it', async () => {
		const lease: ICatalogLease = { tryAcquire: () => false, holderPid: 1234 };
		const harness = createHarness({ lease });
		const a = addSession(harness, 'a', []);
		harness.service.start();

		await clock.tick(CHECKPOINT_COMPARE_ACTIVATION_DELAY_MS);
		assert.deepStrictEqual(finishedTriggers(harness), []);
		assert.ok(harness.log.infos.some(m => m.includes('catalog compares run in another window (pid 1234)')));

		harness.service.noteCheckpoint(a);
		await clock.tick(CHECKPOINT_COMPARE_DEBOUNCE_MS);
		assert.deepStrictEqual(finishedTriggers(harness), ['checkpoint']);
	});

	test('concurrent compare requests are single-flight merged; checkpoint wins over interval', async () => {
		const harness = createHarness();
		const a = addSession(harness, 'a', ['refs/agents/a/checkpoints/turn/1']);
		const b = addSession(harness, 'b', ['refs/agents/b/checkpoints/turn/1']);
		harness.holdRevParse();

		const first = harness.service.runNow('interval', [a]);
		await flushAsync();
		harness.service.noteCheckpoint(b);
		await clock.tick(CHECKPOINT_COMPARE_DEBOUNCE_MS); // debounce fires while the interval run is in flight
		await flushAsync();
		assert.deepStrictEqual(finishedTriggers(harness), []); // merged, not run yet

		harness.releaseRevParse();
		const summary = await first;
		assert.strictEqual(summary?.trigger, 'interval');
		assert.strictEqual(summary?.compared, 1);
		await flushAsync(5000);

		// The merged follow-up ran with the winning `checkpoint` trigger for the queued session.
		assert.deepStrictEqual(finishedTriggers(harness), ['interval', 'checkpoint']);
	});

	test('verdicts: pass when refs resolve, fail when a ref is unresolvable, warn when storage is missing', async () => {
		const harness = createHarness({ unresolvableRefs: new Set(['refs/agents/bad/checkpoints/turn/1']) });
		const good = addSession(harness, 'good', ['refs/agents/good/checkpoints/turn/1']);
		const bad = addSession(harness, 'bad', ['refs/agents/bad/checkpoints/turn/1']);
		const missing = sessionUri('missing');

		const summary = await harness.service.runNow('checkpoint', [good, bad, missing]);
		assert.strictEqual(summary?.compared, 3);
		assert.strictEqual(summary?.verdicts.pass, 1);
		assert.strictEqual(summary?.verdicts.fail, 1);
		assert.strictEqual(summary?.verdicts.warn, 1);
		assert.ok(harness.log.warns.some(m => m.includes('unresolvable checkpoint ref')));
	});

	test('session with recorded refs but no resolvable repository warns', async () => {
		const harness = createHarness();
		const session = addSession(harness, 'lonely', ['refs/agents/lonely/checkpoints/turn/1'], []);
		const summary = await harness.service.runNow('checkpoint', [session]);
		assert.strictEqual(summary?.verdicts.warn, 1);
	});

	test('failure dedup honors the 4-cluster / 3-sample / 10-event caps', async () => {
		// 5 shape groups x 4 sessions; sessions in a group differ only by a
		// hex suffix, which the shape fingerprint buckets out.
		const unresolvable = new Set<string>();
		const sessions: URI[] = [];
		const databases = new Map<string, CompareTestDatabase>();
		for (let g = 0; g < 5; g++) {
			for (let i = 0; i < 4; i++) {
				const hex = (g * 4 + i).toString(16).padStart(8, '0');
				const session = sessionUri(`g${g}-${hex}`);
				const ref = `refs/agents/g${g}-${hex}/checkpoints/turn/1`;
				unresolvable.add(ref);
				databases.set(session.toString(), new CompareTestDatabase([ref], [REPO]));
				sessions.push(session);
			}
		}
		const harness = createHarness({ databases, unresolvableRefs: unresolvable });

		const summary = await harness.service.runNow('checkpoint', sessions);
		assert.strictEqual(summary?.verdicts.fail, 20);
		// 4 clusters admitted x 3 samples each = 12, capped at 10 events per run.
		assert.strictEqual(harness.log.warns.length, 10);
	});

	test('dispose() clears pending timers: no compare runs afterwards', async () => {
		const harness = createHarness();
		const a = addSession(harness, 'a', []);
		harness.service.start();
		harness.service.noteCheckpoint(a);
		harness.service.dispose();

		await clock.tick(CHECKPOINT_COMPARE_ACTIVATION_DELAY_MS + CHECKPOINT_COMPARE_DEBOUNCE_MS + CHECKPOINT_COMPARE_INTERVAL_MS);
		assert.deepStrictEqual(finishedTriggers(harness), []);
		assert.strictEqual(harness.revParseCalls.length, 0);
	});
});
