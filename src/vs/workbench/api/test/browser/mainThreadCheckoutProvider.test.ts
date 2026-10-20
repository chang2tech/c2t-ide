/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import {
	ExtHostCheckoutProviderShape,
	ExtHostContext,
} from '../../common/extHost.protocol.js';
import { IExtHostContext } from '../../../services/extensions/common/extHostCustomers.js';
import {
	CheckoutProviderService,
	ICheckoutConflictDelegate,
	ICheckoutProviderService,
} from '../../../services/checkout/common/checkoutProviderService.js';
import { MainThreadCheckoutProvider } from '../../browser/mainThreadCheckoutProvider.js';

class FakeExtHost implements ExtHostCheckoutProviderShape {
	readonly calls: string[] = [];
	async $warmCheckoutBranch(branchName: string): Promise<void> {
		this.calls.push(`$warmCheckoutBranch:${branchName}`);
	}
	async $checkoutBranch(branchName: string, delegateId: string): Promise<void> {
		this.calls.push(`$checkoutBranch:${branchName}:${delegateId}`);
	}
	async $ensureCurrentBranchPushed(): Promise<void> { this.calls.push('$ensureCurrentBranchPushed'); }
	async $snapshotAndPushCurrentBranch(): Promise<string> { this.calls.push('$snapshotAndPushCurrentBranch'); return 'x'; }
	async $hasDirtyWorkingTree(): Promise<boolean> { this.calls.push('$hasDirtyWorkingTree'); return false; }
}

function fakeContext(extHost: FakeExtHost): IExtHostContext {
	return {
		getProxy: (id: unknown) => {
			assert.strictEqual(id, ExtHostContext.ExtHostCheckoutProvider);
			return extHost;
		},
	} as unknown as IExtHostContext;
}

function makeMainThread(extHost: FakeExtHost): { main: MainThreadCheckoutProvider; service: ICheckoutProviderService } {
	const service = new CheckoutProviderService();
	const main = new MainThreadCheckoutProvider(fakeContext(extHost), service);
	return { main, service };
}

suite('MainThreadCheckoutProvider', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('$registerCheckoutProvider installs the handler; checkoutBranch forwards (branchName, delegateId, options, token), verbatim', async () => {
		const extHost = new FakeExtHost();
		const { main, service } = makeMainThread(extHost);
		disposables.add(main);
		disposables.add(service);
		await main.$registerCheckoutProvider();

		const delegate: ICheckoutConflictDelegate = {
			resolveConflict: async () => 'stash',
			onNoConflictDetected: () => { },
		};
		await service.checkout(delegate, 'feature', { localOnly: true }, CancellationToken.None);

		assert.strictEqual(extHost.calls.length, 1);
		assert.ok(extHost.calls[0].startsWith('$checkoutBranch:feature:'), extHost.calls[0]);
		const delegateId = extHost.calls[0].split(':')[2];
		assert.ok(/^\d+$/.test(delegateId), `delegate id should be a numeric string, got ${delegateId}`);

		// The delegate id is cleaned up after the call (verbatim try/finally).
		assert.strictEqual(await main.$resolveCheckoutConflict(delegateId), 'abort');
	});

	test('$resolveCheckoutConflict runs the registered delegate; unknown id resolves "abort" (verbatim)', async () => {
		const extHost = new FakeExtHost();
		const { main, service } = makeMainThread(extHost);
		disposables.add(main);
		disposables.add(service);
		await main.$registerCheckoutProvider();

		// Unknown delegate id → 'abort' (verbatim fallback).
		assert.strictEqual(await main.$resolveCheckoutConflict('nope'), 'abort');

		// While a checkout is in flight, the delegate is reachable.
		let capturedId = '';
		let release!: () => void;
		const gate = new Promise<void>(resolve => { release = resolve; });
		const slowExtHost = new (class extends FakeExtHost {
			override async $checkoutBranch(branchName: string, delegateId: string): Promise<void> {
				capturedId = delegateId;
				await gate;
			}
		})();
		const main2 = new MainThreadCheckoutProvider(fakeContext(slowExtHost), service);
		disposables.add(main2);
		await main2.$registerCheckoutProvider();
		const delegate2: ICheckoutConflictDelegate = { resolveConflict: async () => 'discard' };
		const inFlight = service.checkout(delegate2, 'b', {}, CancellationToken.None);
		await new Promise(resolve => setTimeout(resolve, 10));
		assert.ok(capturedId.length > 0);
		assert.strictEqual(await main2.$resolveCheckoutConflict(capturedId), 'discard');
		release();
		await inFlight;
		// Cleaned up afterwards.
		assert.strictEqual(await main2.$resolveCheckoutConflict(capturedId), 'abort');
	});

	test('$notifyCheckoutNoConflict forwards to the delegate onNoConflictDetected (verbatim)', async () => {
		const extHost = new FakeExtHost();
		const { main, service } = makeMainThread(extHost);
		disposables.add(main);
		disposables.add(service);
		await main.$registerCheckoutProvider();

		let notified = 0;
		let capturedId = '';
		const slowExtHost = new (class extends FakeExtHost {
			override async $checkoutBranch(branchName: string, delegateId: string): Promise<void> {
				capturedId = delegateId;
				await new Promise<void>(resolve => setTimeout(resolve, 50));
			}
		})();
		const main2 = new MainThreadCheckoutProvider(fakeContext(slowExtHost), service);
		disposables.add(main2);
		await main2.$registerCheckoutProvider();
		const delegate: ICheckoutConflictDelegate = {
			resolveConflict: async () => 'stash',
			onNoConflictDetected: () => { notified++; },
		};
		const inFlight = service.checkout(delegate, 'b', {}, CancellationToken.None);
		await new Promise(resolve => setTimeout(resolve, 10));
		await main2.$notifyCheckoutNoConflict(capturedId);
		assert.strictEqual(notified, 1);
		await inFlight;
	});

	test('$unregisterCheckoutProvider clears the handler and delegates (verbatim)', async () => {
		const extHost = new FakeExtHost();
		const { main, service } = makeMainThread(extHost);
		disposables.add(main);
		disposables.add(service);
		await main.$registerCheckoutProvider();
		await main.$unregisterCheckoutProvider();

		await assert.rejects(
			() => service.checkout({ resolveConflict: async () => 'stash' }, 'b', {}, CancellationToken.None),
			/No checkout provider registered/,
		);
	});

	test('re-registering replaces the previous registration (single slot, verbatim)', async () => {
		const extHost = new FakeExtHost();
		const { main, service } = makeMainThread(extHost);
		disposables.add(main);
		disposables.add(service);
		await main.$registerCheckoutProvider();
		await main.$registerCheckoutProvider();

		await service.warmCheckoutBranch('b', CancellationToken.None);
		assert.deepStrictEqual(extHost.calls, ['$warmCheckoutBranch:b']);
	});
});
