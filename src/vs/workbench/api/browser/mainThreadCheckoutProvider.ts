/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Main-thread side of the checkout provider RPC (`MainThreadCheckoutProvider`).
 *
 * Mirrors Cursor 3.25.9 verbatim
 * (`resources/app/out/vs/workbench/workbench.desktop.main.js`, byte offset
 * 26610187):
 * ```js
 * async $registerCheckoutProvider() {
 *   const e = this.checkoutProviderService.registerHandler({
 *     warmCheckoutBranch: async (t, n) => this._proxy.$warmCheckoutBranch(t, n),
 *     checkoutBranch: async (t, n, i, r) => {
 *       const s = String(this._nextCheckoutDelegateId++);
 *       this._checkoutConflictDelegates.set(s, t);
 *       try { return await this._proxy.$checkoutBranch(n, s, i, r) }
 *       finally { this._checkoutConflictDelegates.delete(s) }
 *     },
 *     ensureCurrentBranchPushed: async (t, n) => this._proxy.$ensureCurrentBranchPushed(t, n),
 *     snapshotAndPushCurrentBranch: async (t, n) => this._proxy.$snapshotAndPushCurrentBranch(t, n),
 *     hasDirtyWorkingTree: async t => this._proxy.$hasDirtyWorkingTree(t)
 *   });
 *   this._checkoutProviderDisposables.clear(),
 *   this._checkoutProviderDisposables.add(e)
 * }
 * async $unregisterCheckoutProvider() { ... clear disposables + delegates ... }
 * async $resolveCheckoutConflict(e) {
 *   const t = this._checkoutConflictDelegates.get(e);
 *   return t ? t.resolveConflict() : "abort"
 * }
 * async $notifyCheckoutNoConflict(e) {
 *   await this._checkoutConflictDelegates.get(e)?.onNoConflictDetected?.()
 * }
 * ```
 * Structure/behavior only; no proprietary code reproduced.
 */

import { Disposable, DisposableStore } from '../../../base/common/lifecycle.js';
import { ExtHostContext, MainContext, ExtHostCheckoutProviderShape, MainThreadCheckoutProviderShape } from '../common/extHost.protocol.js';
import { extHostNamedCustomer, IExtHostContext } from '../../services/extensions/common/extHostCustomers.js';
import { ICheckoutConflictDelegate, ICheckoutProviderService } from '../../services/checkout/common/checkoutProviderService.js';

@extHostNamedCustomer(MainContext.MainThreadCheckoutProvider)
export class MainThreadCheckoutProvider extends Disposable implements MainThreadCheckoutProviderShape {

	private readonly _proxy: ExtHostCheckoutProviderShape;
	private readonly _checkoutProviderDisposables = this._register(new DisposableStore());
	private readonly _checkoutConflictDelegates = new Map<string, ICheckoutConflictDelegate>();
	private _nextCheckoutDelegateId = 0;

	constructor(
		context: IExtHostContext,
		@ICheckoutProviderService private readonly _checkoutProviderService: ICheckoutProviderService
	) {
		super();
		this._proxy = context.getProxy(ExtHostContext.ExtHostCheckoutProvider);
	}

	async $registerCheckoutProvider(): Promise<void> {
		const disposable = this._checkoutProviderService.registerHandler({
			warmCheckoutBranch: (branchName, token) => this._proxy.$warmCheckoutBranch(branchName, token),
			checkoutBranch: async (delegate, branchName, options, token) => {
				const delegateId = String(this._nextCheckoutDelegateId++);
				this._checkoutConflictDelegates.set(delegateId, delegate);
				try {
					return await this._proxy.$checkoutBranch(branchName, delegateId, options, token);
				} finally {
					this._checkoutConflictDelegates.delete(delegateId);
				}
			},
			ensureCurrentBranchPushed: (options, token) => this._proxy.$ensureCurrentBranchPushed(options, token),
			snapshotAndPushCurrentBranch: (options, token) => this._proxy.$snapshotAndPushCurrentBranch(options, token),
			hasDirtyWorkingTree: (token) => this._proxy.$hasDirtyWorkingTree(token),
		});
		// Single-slot semantics (verbatim): re-registering replaces the
		// previous registration.
		this._checkoutProviderDisposables.clear();
		this._checkoutProviderDisposables.add(disposable);
	}

	async $unregisterCheckoutProvider(): Promise<void> {
		this._checkoutProviderDisposables.clear();
		this._checkoutConflictDelegates.clear();
	}

	async $resolveCheckoutConflict(delegateId: string): Promise<'stash' | 'commit' | 'discard' | 'abort' | undefined> {
		const delegate = this._checkoutConflictDelegates.get(delegateId);
		return delegate ? delegate.resolveConflict() : 'abort';
	}

	async $notifyCheckoutNoConflict(delegateId: string): Promise<void> {
		await this._checkoutConflictDelegates.get(delegateId)?.onNoConflictDetected?.();
	}
}
