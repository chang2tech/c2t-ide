/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import {
	CheckoutProviderService,
	ICheckoutConflictDelegate,
	ICheckoutProviderHandler,
} from '../../common/checkoutProviderService.js';

function fakeDelegate(): ICheckoutConflictDelegate & { calls: number } {
	const d = {
		calls: 0,
		resolveConflict: async () => { d.calls++; return 'stash' as const; },
	};
	return d;
}

function fakeHandler(): ICheckoutProviderHandler & { calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		checkoutBranch: async (delegate, branchName, options, token) => {
			calls.push(`checkoutBranch:${branchName}:${JSON.stringify(options)}:${token === CancellationToken.None}`);
			assert.ok(delegate, 'delegate must be passed first (verbatim protocol shape)');
		},
		warmCheckoutBranch: async (branchName) => { calls.push(`warm:${branchName}`); },
		ensureCurrentBranchPushed: async () => { calls.push('push'); },
		snapshotAndPushCurrentBranch: async () => { calls.push('snapshot'); return 'cursor/cloud-agent-1'; },
		hasDirtyWorkingTree: async () => { calls.push('dirty'); return false; },
	};
}

suite('CheckoutProviderService', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('checkout forwards (delegate, branchName, options, token) — delegate first, verbatim', async () => {
		const service = disposables.add(new CheckoutProviderService());
		const handler = fakeHandler();
		disposables.add(service.registerHandler(handler));

		const delegate = fakeDelegate();
		await service.checkout(delegate, 'feature', { localOnly: true }, CancellationToken.None);

		assert.strictEqual(handler.calls.length, 1);
		assert.ok(handler.calls[0].startsWith('checkoutBranch:feature:'), handler.calls[0]);
		assert.ok(handler.calls[0].includes('"localOnly":true'), handler.calls[0]);
	});

	test('re-registering replaces the previous handler (single slot, verbatim)', async () => {
		const service = disposables.add(new CheckoutProviderService());
		const first = fakeHandler();
		const second = fakeHandler();
		disposables.add(service.registerHandler(first));
		disposables.add(service.registerHandler(second));

		await service.warmCheckoutBranch('b', CancellationToken.None);
		assert.strictEqual(first.calls.length, 0);
		assert.deepStrictEqual(second.calls, ['warm:b']);
	});

	test('disposing the registration unregisters the handler', async () => {
		const service = disposables.add(new CheckoutProviderService());
		const handler = fakeHandler();
		const reg = service.registerHandler(handler);
		reg.dispose();

		await assert.rejects(
			() => service.hasDirtyWorkingTree(CancellationToken.None),
			/No checkout provider registered/,
		);
	});

	test('throws when no handler is registered', async () => {
		const service = disposables.add(new CheckoutProviderService());
		await assert.rejects(
			() => service.checkout(fakeDelegate(), 'b', {}, CancellationToken.None),
			/No checkout provider registered/,
		);
	});

	test('forwards ensureCurrentBranchPushed / snapshotAndPushCurrentBranch / hasDirtyWorkingTree', async () => {
		const service = disposables.add(new CheckoutProviderService());
		const handler = fakeHandler();
		disposables.add(service.registerHandler(handler));

		await service.ensureCurrentBranchPushed({}, CancellationToken.None);
		const branch = await service.snapshotAndPushCurrentBranch({}, CancellationToken.None);
		const dirty = await service.hasDirtyWorkingTree(CancellationToken.None);

		assert.deepStrictEqual(handler.calls, ['push', 'snapshot', 'dirty']);
		assert.strictEqual(branch, 'cursor/cloud-agent-1');
		assert.strictEqual(dirty, false);
	});
});
