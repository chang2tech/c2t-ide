/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ComposerPlanService } from '../../browser/composerPlanService.js';
// W71B (DEV-GAPS-71): importing the bridge module registers the two fork-side
// wire commands as a side effect.
import { IDE_CLEAR_COMPOSER_PLAN_COMMAND_ID, IDE_RECORD_COMPOSER_PLAN_COMMAND_ID, } from '../../browser/composerPlanBridge.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
function createStubFileService() {
    const svc = {
        fileText: undefined,
        readFile: async (_resource) => {
            if (svc.fileText === undefined) {
                throw new Error('ENOENT');
            }
            return { value: { toString: () => svc.fileText } };
        },
    };
    return svc;
}
function createStubLogService() {
    return {
        warns: [],
        warn: function (...args) {
            this.warns.push(args);
            return undefined;
        },
    };
}
function createService(fileText) {
    const files = createStubFileService();
    files.fileText = fileText;
    const log = createStubLogService();
    const service = new ComposerPlanService(files, log);
    return { service, files, log };
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
        const accepted = [];
        const planSub = service.onDidAcceptPlan(e => accepted.push(e));
        service.recordPlan(composerId, bubbleId, planUri, 'stale recorded text');
        await service.acceptPlan(composerId, planUri, bubbleId, 'manual', { unifiedMode: true });
        assert.strictEqual(accepted.length, 1);
        assert.strictEqual(accepted[0].composerId, composerId);
        assert.strictEqual(accepted[0].planUri.toString(), planUri.toString());
        assert.strictEqual(accepted[0].bubbleId, bubbleId);
        assert.strictEqual(accepted[0].source, 'manual');
        assert.strictEqual(accepted[0].planText, '# Plan — 2026-10-20\n\n# Real plan from disk');
        // The consumed record is cleared: a second accept resolves nothing.
        assert.strictEqual(service.getPlanUriFromBubble(composerId, bubbleId), undefined);
        planSub.dispose();
        service.dispose();
    });
    test('falls back to the recorded text when the file cannot be read', async () => {
        const { service } = createService(); // fileText undefined -> readFile throws
        const accepted = [];
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
        const accepted = [];
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
        const accepted = [];
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
    function runBridgeCommand(id, service, ...args) {
        const cmd = CommandsRegistry.getCommand(id);
        assert.ok(cmd, `bridge command ${id} is registered`);
        const accessor = { get: () => service };
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
        const badArgSets = [
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
