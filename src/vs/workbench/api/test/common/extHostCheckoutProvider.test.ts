/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import {
	ExtHostCheckoutProvider,
	IExtHostCheckoutProvider,
	MainThreadCheckoutProviderShape,
} from '../../common/extHostCheckoutProvider.js';
import { IExtHostRpcService } from '../../common/extHostRpcService.js';

class FakeMainThread implements MainThreadCheckoutProviderShape {
	readonly calls: string[] = [];
	dispose(): void { /* noop */ }
	async $registerCheckoutProvider(): Promise<void> { this.calls.push('$registerCheckoutProvider'); }
	async $unregisterCheckoutProvider(): Promise<void> { this.calls.push('$unregisterCheckoutProvider'); }
	async $resolveCheckoutConflict(delegateId: string): Promise<'stash' | 'commit' | 'discard' | 'abort' | undefined> {
		this.calls.push(`$resolveCheckoutConflict:${delegateId}`);
		return 'stash';
	}
	async $notifyCheckoutNoConflict(delegateId: string): Promise<void> {
		this.calls.push(`$notifyCheckoutNoConflict:${delegateId}`);
	}
}

function fakeRpc(main: FakeMainThread): IExtHostRpcService {
	return {
		getProxy: () => main,
		set: () => { throw new Error('not implemented'); },
	} as unknown as IExtHostRpcService;
}

function fakeProvider(): IExtHostCheckoutProvider & { seen: Array<{ delegate: unknown; branch: string }>; calls: string[] } {
	const seen: Array<{ delegate: unknown; branch: string }> = [];
	const calls: string[] = [];
	return {
		seen,
		calls,
		checkoutBranch: async (delegate, branchName) => { calls.push('checkoutBranch'); seen.push({ delegate, branch: branchName }); },
		warmCheckoutBranch: async () => { calls.push('warmCheckoutBranch'); },
		ensureCurrentBranchPushed: async () => { calls.push('ensureCurrentBranchPushed'); },
		snapshotAndPushCurrentBranch: async () => { calls.push('snapshotAndPushCurrentBranch'); return 'cursor/cloud-agent-1'; },
		hasDirtyWorkingTree: async () => { calls.push('hasDirtyWorkingTree'); return false; },
	};
}

suite('ExtHostCheckoutProvider', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('registerCheckoutProvider RPCs $registerCheckoutProvider; dispose RPCs $unregisterCheckoutProvider', () => {
		const main = new FakeMainThread();
		const extHost = disposables.add(new ExtHostCheckoutProvider(fakeRpc(main)));

		const reg = extHost.registerCheckoutProvider(fakeProvider());
		assert.deepStrictEqual(main.calls, ['$registerCheckoutProvider']);

		disposables.add(reg);
		reg.dispose();
		assert.deepStrictEqual(main.calls, ['$registerCheckoutProvider', '$unregisterCheckoutProvider']);

		// After unregistering, calls throw (verbatim single-slot semantics).
		await assert.rejects(
			() => extHost.$checkoutBranch('b', 'd1', {}, CancellationToken.None),
			/No checkout provider registered/,
		);
	});

	test('$checkoutBranch calls provider.checkoutBranch(delegate, branchName, options, token) — delegate first, verbatim', async () => {
		const main = new FakeMainThread();
		const extHost = disposables.add(new ExtHostCheckoutProvider(fakeRpc(main)));
		const provider = fakeProvider();
		disposables.add(extHost.registerCheckoutProvider(provider));

		await extHost.$checkoutBranch('feature', 'delegate-7', { localOnly: true }, CancellationToken.None);

		assert.strictEqual(provider.seen.length, 1);
		assert.strictEqual(provider.seen[0].branch, 'feature');
		const delegate = provider.seen[0].delegate as { resolveConflict(): Promise<string>; onNoConflictDetected(): void };
		assert.strictEqual(typeof delegate.resolveConflict, 'function');
		assert.strictEqual(typeof delegate.onNoConflictDetected, 'function');

		// The delegate RPCs back to the main thread with the delegate id (verbatim).
		const resolution = await delegate.resolveConflict();
		assert.strictEqual(resolution, 'stash');
		assert.ok(main.calls.includes('$resolveCheckoutConflict:delegate-7'));

		delegate.onNoConflictDetected();
		assert.ok(main.calls.includes('$notifyCheckoutNoConflict:delegate-7'));
	});

	test('$checkoutBranch throws when no provider is registered', async () => {
		const main = new FakeMainThread();
		const extHost = disposables.add(new ExtHostCheckoutProvider(fakeRpc(main)));
		await assert.rejects(
			() => extHost.$checkoutBranch('b', 'd1', {}, CancellationToken.None),
			/No checkout provider registered/,
		);
	});

	test('re-registering replaces the previous provider (single slot, verbatim)', async () => {
		const main = new FakeMainThread();
		const extHost = disposables.add(new ExtHostCheckoutProvider(fakeRpc(main)));
		const first = fakeProvider();
		const second = fakeProvider();
		disposables.add(extHost.registerCheckoutProvider(first));
		disposables.add(extHost.registerCheckoutProvider(second));

		await extHost.$warmCheckoutBranch('b', CancellationToken.None);
		await extHost.$hasDirtyWorkingTree(CancellationToken.None);
		assert.strictEqual(first.calls.length, 0);
		assert.deepStrictEqual(second.calls, ['warmCheckoutBranch', 'hasDirtyWorkingTree']);
	});
});
