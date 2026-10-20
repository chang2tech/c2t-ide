/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { AcceptedPlan, PLAN_ACCEPTED_ANALYTICS_EVENT } from '../../common/composerPlanService.js';
import { ComposerPlanService, extractPlanExecutionData } from '../../browser/composerPlanService.js';
// W71B (DEV-GAPS-71): importing the bridge module registers the two fork-side
// wire commands as a side effect.
import {
	ComposerPlanAcceptConsumerContribution,
	IDE_ACCEPT_PLAN_FROM_CORE_COMMAND_ID,
	IDE_CLEAR_COMPOSER_PLAN_COMMAND_ID,
	IDE_RECORD_COMPOSER_PLAN_COMMAND_ID,
} from '../../browser/composerPlanBridge.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';

// W65B (composer-plan-accept follow-up): `composerPlanService` record/accept
// contract. Binary evidence (Cursor 3.25.9 `workbench.desktop.main.js`):
// - `getPlanUriFromBubble(handle, bubbleId)` @18683492 returns a URI ONLY for
//   the CREATE_PLAN tool bubble (`additionalData.planUri`); anything else
//   resolves nothing and `composer.acceptPlan` no-ops (@29969972).
// - `acceptPlan(handle, planUri, bubbleId?, source?, opts?)` @18684727 loads
//   the plan execution data (the plan file is the source of truth) and
//   submits it to the engine; the fork fires `onDidAcceptPlan` instead
//   (engine is data-service-owned — see `../common/composerPlanService.ts`).
// `recordPlan` has 0 hits in the 3.25.9 bundle: it is the fork-side producer
// API standing in for Cursor's CREATE_PLAN tool bubble.

// W77A-R2: deliberately NOT extending Partial<IFileService> — the stub only
// implements the readFile slice the service under test uses (returning a
// minimal shape, not IFileContent/VSBuffer). Extending the interface errors
// under the repo's strict settings (TS2430); the cast at the call site
// (`as unknown as IFileService`) is the intended seam.
interface StubFileService {
	fileText: string | undefined; // undefined => readFile throws
	readFile: (resource: URI) => Promise<{ value: { toString(): string } }>;
}

function createStubFileService(): StubFileService {
	const svc: StubFileService = {
		fileText: undefined,
		readFile: async (_resource: URI) => {
			if (svc.fileText === undefined) {
				throw new Error('ENOENT');
			}
			return { value: { toString: () => svc.fileText! } };
		},
	};
	return svc;
}

interface StubLogService extends Partial<ILogService> {
	warns: unknown[][];
}

function createStubLogService(): StubLogService {
	return {
		warns: [],
		warn: function (...args: unknown[]) {
			(this as StubLogService).warns.push(args);
			return undefined as never;
		},
	} as unknown as StubLogService;
}

interface StubTelemetryService {
	events: { eventName: string; data?: unknown }[];
	publicLog: (eventName: string, data?: unknown) => void;
}

function createStubTelemetryService(): StubTelemetryService {
	const svc: StubTelemetryService = {
		events: [],
		publicLog: (eventName: string, data?: unknown) => {
			svc.events.push({ eventName, data });
		},
	};
	return svc;
}

function createService(fileText?: string): { service: ComposerPlanService; files: StubFileService; log: StubLogService; telemetry: StubTelemetryService } {
	const files = createStubFileService();
	files.fileText = fileText;
	const log = createStubLogService();
	const telemetry = createStubTelemetryService();
	const service = new ComposerPlanService(
		files as unknown as IFileService,
		log as unknown as ILogService,
		telemetry as unknown as ITelemetryService,
	);
	return { service, files, log, telemetry };
}

const composerId = 'tab-1';
const bubbleId = 'bubble-9';
const planUri = URI.file('/tmp/plans/plan.md');

suite('composerPlanService (W65B) — record/getPlanUriFromBubble gate', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('no record -> getPlanUriFromBubble resolves nothing (Cursor no-op for non-plan bubble)', () => {
		const { service } = createService();
		assert.strictEqual(service.getPlanUriFromBubble(composerId, bubbleId), undefined);
		service.dispose();
	});

	test('recorded plan resolves only for the producing bubble id', () => {
		const { service } = createService();
		service.recordPlan(composerId, bubbleId, planUri, 'plan text');
		assert.strictEqual(service.getPlanUriFromBubble(composerId, bubbleId)?.toString(), planUri.toString());
		// A different bubble of the same composer is not a plan bubble.
		assert.strictEqual(service.getPlanUriFromBubble(composerId, 'other-bubble'), undefined);
		// A different composer never sees this record.
		assert.strictEqual(service.getPlanUriFromBubble('tab-2', bubbleId), undefined);
		service.dispose();
	});

	test('bubble id object shapes { id } / { bubbleId } resolve', () => {
		const { service } = createService();
		service.recordPlan(composerId, bubbleId, planUri, 'plan text');
		assert.strictEqual(service.getPlanUriFromBubble(composerId, { id: bubbleId })?.toString(), planUri.toString());
		assert.strictEqual(service.getPlanUriFromBubble(composerId, { bubbleId })?.toString(), planUri.toString());
		assert.strictEqual(service.getPlanUriFromBubble(composerId, { id: 'nope' }), undefined);
		assert.strictEqual(service.getPlanUriFromBubble(composerId, ''), undefined);
		assert.strictEqual(service.getPlanUriFromBubble(composerId, undefined), undefined);
		service.dispose();
	});

	test('re-record overwrites; clearPlan drops the record', () => {
		const { service } = createService();
		const uri2 = URI.file('/tmp/plans/plan2.md');
		service.recordPlan(composerId, bubbleId, planUri, 'v1');
		service.recordPlan(composerId, bubbleId, uri2, 'v2');
		assert.strictEqual(service.getPlanUriFromBubble(composerId, bubbleId)?.toString(), uri2.toString());
		service.clearPlan(composerId);
		assert.strictEqual(service.getPlanUriFromBubble(composerId, bubbleId), undefined);
		service.dispose();
	});
});

suite('composerPlanService (W65B) — acceptPlan', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('plan file is the source of truth; record cleared; event fired with payload', async () => {
		const { service } = createService('# Plan — 2026-10-20\n\n# Real plan from disk');
		const accepted: AcceptedPlan[] = [];
		const planSub = service.onDidAcceptPlan(e => accepted.push(e));
		service.recordPlan(composerId, bubbleId, planUri, 'stale recorded text');
		await service.acceptPlan(composerId, planUri, bubbleId, 'manual', { unifiedMode: true });
		assert.strictEqual(accepted.length, 1);
		assert.strictEqual(accepted[0].composerId, composerId);
		assert.strictEqual(accepted[0].planUri.toString(), planUri.toString());
		assert.strictEqual(accepted[0].bubbleId, bubbleId);
		assert.strictEqual(accepted[0].source, 'manual');
		assert.strictEqual(accepted[0].planText, '# Plan — 2026-10-20\n\n# Real plan from disk');
		// GAPS-186: extraction rides the event — fork header stripped for
		// the title, no frontmatter -> planName '', no checkboxes -> [].
		assert.strictEqual(accepted[0].planName, '');
		assert.strictEqual(accepted[0].planTitle, 'Real plan from disk');
		assert.deepStrictEqual(accepted[0].planTodos, []);
		// The consumed record is cleared: a second accept resolves nothing.
		assert.strictEqual(service.getPlanUriFromBubble(composerId, bubbleId), undefined);
		planSub.dispose();
		service.dispose();
	});

	test('falls back to the recorded text when the file cannot be read', async () => {
		const { service } = createService(); // fileText undefined -> readFile throws
		const accepted: AcceptedPlan[] = [];
		const planSub = service.onDidAcceptPlan(e => accepted.push(e));
		service.recordPlan(composerId, bubbleId, planUri, 'recorded plan text');
		await service.acceptPlan(composerId, planUri, { id: bubbleId }, 'manual');
		assert.strictEqual(accepted.length, 1);
		assert.strictEqual(accepted[0].planText, 'recorded plan text');
		assert.strictEqual(accepted[0].bubbleId, bubbleId, 'object bubble id is normalized in the event');
		planSub.dispose();
		service.dispose();
	});

	test('skipSubmission clears the record but fires no event', async () => {
		const { service } = createService('disk content');
		const accepted: AcceptedPlan[] = [];
		const planSub = service.onDidAcceptPlan(e => accepted.push(e));
		service.recordPlan(composerId, bubbleId, planUri, 'text');
		await service.acceptPlan(composerId, planUri, bubbleId, 'manual', { skipSubmission: true });
		assert.strictEqual(accepted.length, 0);
		assert.strictEqual(service.getPlanUriFromBubble(composerId, bubbleId), undefined);
		planSub.dispose();
		service.dispose();
	});

	test('no plan content anywhere -> warn, no event (record kept)', async () => {
		const { service, log } = createService(); // unreadable file + empty recorded text
		const accepted: AcceptedPlan[] = [];
		const planSub = service.onDidAcceptPlan(e => accepted.push(e));
		service.recordPlan(composerId, bubbleId, planUri, '');
		await service.acceptPlan(composerId, planUri, bubbleId);
		assert.strictEqual(accepted.length, 0);
		assert.ok(log.warns.length > 0, 'expected a warning about missing plan content');
		planSub.dispose();
		service.dispose();
	});
});

suite('composerPlanBridge (W71B) — ide.recordComposerPlan / ide.clearComposerPlan', () => {
	/** Invoke a registered bridge command with a stub accessor. */
	function runBridgeCommand(id: string, service: ComposerPlanService, ...args: unknown[]): void {
		const cmd = CommandsRegistry.getCommand(id);
		assert.ok(cmd, `bridge command ${id} is registered`);
		const accessor = { get: () => service } as unknown as ServicesAccessor;
		cmd.handler(accessor, ...args);
	}

	test('record bridge populates the registry the acceptPlan path reads', () => {
		const { service } = createService();
		runBridgeCommand(IDE_RECORD_COMPOSER_PLAN_COMMAND_ID, service, composerId, bubbleId, planUri.toString(), 'plan text');
		assert.strictEqual(service.getPlanUriFromBubble(composerId, bubbleId)?.toString(), planUri.toString());
		service.dispose();
	});

	test('record bridge ignores malformed args without throwing or poisoning the registry', () => {
		const { service } = createService();
		const badArgSets: unknown[][] = [
			[],
			[composerId],
			['', bubbleId, planUri.toString(), 'text'],
			[composerId, '', planUri.toString(), 'text'],
			[composerId, bubbleId, '', 'text'],
			[123, bubbleId, planUri.toString(), 'text'],
			// NOTE: URI.parse is intentionally lenient — a weird-but-parseable
			// string is the producer's problem, not the bridge's; the bridge
			// only guards arg shape.
		];
		for (const args of badArgSets) {
			runBridgeCommand(IDE_RECORD_COMPOSER_PLAN_COMMAND_ID, service, ...args);
		}
		assert.strictEqual(service.getPlanUriFromBubble(composerId, bubbleId), undefined);
		service.dispose();
	});

	test('clear bridge drops the record', () => {
		const { service } = createService();
		runBridgeCommand(IDE_RECORD_COMPOSER_PLAN_COMMAND_ID, service, composerId, bubbleId, planUri.toString(), 'plan text');
		runBridgeCommand(IDE_CLEAR_COMPOSER_PLAN_COMMAND_ID, service, composerId);
		assert.strictEqual(service.getPlanUriFromBubble(composerId, bubbleId), undefined);
		// Clearing an unknown / malformed id is a no-op, never throws.
		runBridgeCommand(IDE_CLEAR_COMPOSER_PLAN_COMMAND_ID, service, 'tab-unknown');
		runBridgeCommand(IDE_CLEAR_COMPOSER_PLAN_COMMAND_ID, service);
		runBridgeCommand(IDE_CLEAR_COMPOSER_PLAN_COMMAND_ID, service, '');
		service.dispose();
	});
});

suite('composerPlanAcceptConsumer (GAPS-181) — onDidAcceptPlan consumer bridge', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	interface StubCommandService {
		calls: unknown[][];
		fail: boolean;
		executeCommand: (id: string, ...args: unknown[]) => Promise<unknown>;
	}

	function createStubCommandService(): StubCommandService {
		const svc: StubCommandService = {
			calls: [],
			fail: false,
			executeCommand: async (id: string, ...args: unknown[]) => {
				svc.calls.push([id, ...args]);
				if (svc.fail) {
					throw new Error('unknown command');
				}
				return undefined;
			},
		};
		return svc;
	}

	test('an accepted plan is forwarded to the extension build phase', async () => {
		const { service } = createService('disk plan content');
		const commands = createStubCommandService();
		const log = createStubLogService();
		const contribution = new ComposerPlanAcceptConsumerContribution(
			service,
			commands as unknown as ICommandService,
			log as unknown as ILogService,
		);
		service.recordPlan(composerId, bubbleId, planUri, 'recorded text');
		await service.acceptPlan(composerId, planUri, bubbleId, 'manual');
		assert.strictEqual(commands.calls.length, 1);
		assert.deepStrictEqual(commands.calls[0], [
			IDE_ACCEPT_PLAN_FROM_CORE_COMMAND_ID,
			composerId,
			'disk plan content',
			planUri.toString(),
			// GAPS-186: extraction forwarded as the trailing arg.
			{ planName: '', planTitle: 'disk plan content', planTodos: [] },
		]);
		contribution.dispose();
		service.dispose();
	});

	test('skipSubmission forwards nothing (no event fires)', async () => {
		const { service } = createService('disk plan content');
		const commands = createStubCommandService();
		const log = createStubLogService();
		const contribution = new ComposerPlanAcceptConsumerContribution(
			service,
			commands as unknown as ICommandService,
			log as unknown as ILogService,
		);
		service.recordPlan(composerId, bubbleId, planUri, 'recorded text');
		await service.acceptPlan(composerId, planUri, bubbleId, 'manual', { skipSubmission: true });
		assert.strictEqual(commands.calls.length, 0);
		contribution.dispose();
		service.dispose();
	});

	test('a failing extension handler is swallowed and logged, never rejects', async () => {
		const { service } = createService('disk plan content');
		const commands = createStubCommandService();
		commands.fail = true;
		const log = createStubLogService();
		const contribution = new ComposerPlanAcceptConsumerContribution(
			service,
			commands as unknown as ICommandService,
			log as unknown as ILogService,
		);
		service.recordPlan(composerId, bubbleId, planUri, 'recorded text');
		// acceptPlan itself must complete even though the forward fails.
		await service.acceptPlan(composerId, planUri, bubbleId, 'manual');
		assert.strictEqual(commands.calls.length, 1);
		assert.ok(log.warns.length > 0, 'expected the failed forward to be logged');
		contribution.dispose();
		service.dispose();
	});

	test('after dispose the consumer forwards nothing', async () => {
		const { service } = createService('disk plan content');
		const commands = createStubCommandService();
		const log = createStubLogService();
		const contribution = new ComposerPlanAcceptConsumerContribution(
			service,
			commands as unknown as ICommandService,
			log as unknown as ILogService,
		);
		contribution.dispose();
		service.recordPlan(composerId, bubbleId, planUri, 'recorded text');
		await service.acceptPlan(composerId, planUri, bubbleId, 'manual');
		assert.strictEqual(commands.calls.length, 0);
		service.dispose();
	});
});

suite('composerPlanService (GAPS-186) — plan_accepted analytics', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('accept tracks composer.plan_mode.plan_accepted exactly once with the sourced properties', async () => {
		const { service, telemetry } = createService('# My Plan\n\n- [ ] first step\n- [x] done step\n- [ ] last step');
		service.recordPlan(composerId, bubbleId, planUri, 'recorded text');
		await service.acceptPlan(composerId, planUri, bubbleId);
		assert.strictEqual(telemetry.events.length, 1);
		assert.strictEqual(telemetry.events[0].eventName, PLAN_ACCEPTED_ANALYTICS_EVENT);
		assert.strictEqual(telemetry.events[0].eventName, 'composer.plan_mode.plan_accepted');
		assert.deepStrictEqual(telemetry.events[0].data, {
			composer_id: composerId,
			execution_target: 'local',
			todos_selected: 3,
			source: 'manual', // binary: source ?? "manual"
		});
		service.dispose();
	});

	test('an explicit source is tracked verbatim', async () => {
		const { service, telemetry } = createService('plan body');
		service.recordPlan(composerId, bubbleId, planUri, 'recorded text');
		await service.acceptPlan(composerId, planUri, bubbleId, 'deeplink');
		assert.strictEqual(telemetry.events.length, 1);
		assert.strictEqual((telemetry.events[0].data as { source?: string }).source, 'deeplink');
		service.dispose();
	});

	test('no plan content (load fails everywhere) -> NO analytics, no event', async () => {
		const { service, telemetry } = createService(); // unreadable file
		const accepted: AcceptedPlan[] = [];
		const planSub = service.onDidAcceptPlan(e => accepted.push(e));
		service.recordPlan(composerId, bubbleId, planUri, '');
		await service.acceptPlan(composerId, planUri, bubbleId);
		assert.strictEqual(telemetry.events.length, 0);
		assert.strictEqual(accepted.length, 0);
		planSub.dispose();
		service.dispose();
	});

	test('skipSubmission still tracks (binary ordering) but fires no accept event', async () => {
		const { service, telemetry } = createService('plan body');
		const accepted: AcceptedPlan[] = [];
		const planSub = service.onDidAcceptPlan(e => accepted.push(e));
		service.recordPlan(composerId, bubbleId, planUri, 'text');
		await service.acceptPlan(composerId, planUri, bubbleId, 'manual', { skipSubmission: true });
		assert.strictEqual(telemetry.events.length, 1, 'binary tracks before its late skipSubmission return');
		assert.strictEqual(accepted.length, 0);
		planSub.dispose();
		service.dispose();
	});
});

suite('extractPlanExecutionData (GAPS-186) — _loadPlanExecutionData port', () => {

	test('Cursor-style frontmatter: planName/planTodos extracted, body is planContent', () => {
		const text = [
			'---',
			'name: "Ship the thing"',
			'overview: "Do it well"',
			'todos:',
			'  - id: t1',
			'    content: "Write code"',
			'    status: pending',
			'  - id: t2',
			'    content: "Ship it"',
			'    status: completed',
			'    dependencies: [t1]',
			'isProject: false',
			'---',
			'',
			'# Ship the thing',
			'',
			'Body text.',
		].join('\n');
		const data = extractPlanExecutionData(text);
		assert.strictEqual(data.planName, 'Ship the thing');
		assert.strictEqual(data.planTitle, 'Ship the thing', 'e7e: first body line wins over planName');
		assert.strictEqual(data.planTodos.length, 2);
		assert.deepStrictEqual(data.planTodos[0], { id: 't1', content: 'Write code', status: 'pending' });
		assert.deepStrictEqual(data.planTodos[1], { id: 't2', content: 'Ship it', status: 'completed', dependencies: ['t1'] });
		assert.deepStrictEqual(data.nonCompletedTodos.map(t => t.id), ['t1'], 'completed filtered out (binary filter)');
		assert.ok(data.planContent.startsWith('# Ship the thing'));
	});

	test('planTitle falls back to planName when the body first line is an empty heading', () => {
		const text = '---\nname: Fallback Name\ntodos: []\n---\n\n#\n\nBody.';
		const data = extractPlanExecutionData(text);
		assert.strictEqual(data.planName, 'Fallback Name');
		assert.strictEqual(data.planTitle, 'Fallback Name');
		assert.deepStrictEqual(data.planTodos, []);
	});

	test('fork format: header stripped for the title, checkbox items become todos', () => {
		const text = '# Plan — 2026-10-20T00:00:00.000Z\n\n# Build a widget\n\n- [ ] step one\n- [x] step two\n1. numbered step (not a todo)\nplain prose';
		const data = extractPlanExecutionData(text);
		assert.strictEqual(data.planName, '', 'no frontmatter -> binary planName default');
		assert.strictEqual(data.planTitle, 'Build a widget');
		assert.deepStrictEqual(data.planTodos, [
			{ id: 'todo-1', content: 'step one', status: 'pending' },
			{ id: 'todo-2', content: 'step two', status: 'completed' },
		]);
		assert.deepStrictEqual(data.nonCompletedTodos.map(t => t.id), ['todo-1']);
	});

	test('no heading and no name -> "Untitled Plan" (e7e final fallback)', () => {
		const data = extractPlanExecutionData('#\n\n');
		assert.strictEqual(data.planTitle, 'Untitled Plan');
		assert.strictEqual(data.planName, '');
		assert.deepStrictEqual(data.planTodos, []);
	});

	test('accepted event carries the frontmatter extraction end-to-end', async () => {
		const text = '---\nname: E2E Plan\ntodos:\n  - id: a\n    content: "Only step"\n    status: pending\n---\n\n# E2E Plan\n\nBody.';
		const { service, telemetry } = createService(text);
		const accepted: AcceptedPlan[] = [];
		const planSub = service.onDidAcceptPlan(e => accepted.push(e));
		service.recordPlan(composerId, bubbleId, planUri, 'recorded');
		await service.acceptPlan(composerId, planUri, bubbleId, 'manual');
		assert.strictEqual(accepted.length, 1);
		assert.strictEqual(accepted[0].planName, 'E2E Plan');
		assert.strictEqual(accepted[0].planTitle, 'E2E Plan');
		assert.strictEqual(accepted[0].planTodos.length, 1);
		assert.strictEqual((telemetry.events[0].data as { todos_selected?: number }).todos_selected, 1);
		planSub.dispose();
		service.dispose();
	});
});
