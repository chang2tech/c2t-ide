/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Extension-host side of the checkout provider RPC (`ExtHostCheckoutProvider`).
 *
 * Mirrors Cursor 3.25.9 verbatim
 * (`resources/app/out/vs/workbench/api/node/extensionHostProcess.js`, byte
 * offset ~1425610):
 * ```js
 * registerCheckoutProvider(e) {
 *   const n = this._checkoutProvider.set(e);
 *   return this._proxy.$registerCheckoutProvider(),
 *     de(() => { n.dispose(), this._proxy.$unregisterCheckoutProvider() })
 * }
 * async $warmCheckoutBranch(e, n) {
 *   await (await nn(this._checkoutProvider)).warmCheckoutBranch(e, n)
 * }
 * async $checkoutBranch(e, n, a, r) {
 *   const s = await nn(this._checkoutProvider),
 *     o = {
 *       resolveConflict: () => this._proxy.$resolveCheckoutConflict(n),
 *       onNoConflictDetected: () => this._proxy.$notifyCheckoutNoConflict(n)
 *     };
 *   await s.checkoutBranch(o, e, a, r)
 * }
 * async $ensureCurrentBranchPushed(e, n) {
 *   await (await nn(this._checkoutProvider)).ensureCurrentBranchPushed(e, n)
 * }
 * async $snapshotAndPushCurrentBranch(e, n) {
 *   return (await nn(this._checkoutProvider)).snapshotAndPushCurrentBranch(e, n)
 * }
 * async $hasDirtyWorkingTree(e) {
 *   return (await nn(this._checkoutProvider)).hasDirtyWorkingTree(e)
 * }
 * ```
 * Structure/behavior only; no proprietary code reproduced.
 *
 * Note the verbatim provider-first call: `$checkoutBranch` builds the
 * conflict delegate `{ resolveConflict, onNoConflictDetected }` (which RPC
 * back to the main thread) and invokes
 * `provider.checkoutBranch(delegate, branchName, options, token)`.
 */

import type * as vscode from 'vscode';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import { IExtHostRpcService } from './extHostRpcService.js';
import { ExtHostCheckoutProviderShape, ExtHostContext, MainContext, MainThreadCheckoutProviderShape } from './extHost.protocol.js';

/** Verbatim conflict resolutions from Cursor's core conflict UI. */
export type ExtHostCheckoutConflictResolution = 'stash' | 'commit' | 'discard';

/**
 * The conflict delegate handed to the extension provider as the first
 * argument of `checkoutBranch`. `resolveConflict()` RPCs back to the main
 * thread, where the core-side delegate shows the stash/commit/discard/cancel
 * QuickPick.
 */
export interface IExtHostCheckoutConflictDelegate {
	resolveConflict(): Promise<ExtHostCheckoutConflictResolution | 'abort' | undefined>;
	onNoConflictDetected(): void;
}

export interface IExtHostCheckoutBranchOptions {
	readonly commitSha?: string;
	readonly localOnly?: boolean;
}

export interface IExtHostEnsureBranchPushedOptions {
	readonly cwd?: string;
	readonly remoteName?: string;
	readonly branchName?: string;
	readonly forcePush?: boolean;
}

export interface IExtHostSnapshotPushOptions {
	readonly cwd?: string;
	readonly remoteName?: string;
	readonly commitMessage?: string;
	readonly branchPrefix?: string;
	readonly stashLocalChangesAfterPush?: boolean;
	readonly stashMessage?: string;
}

/**
 * The extension-side checkout provider, as implemented by the `ide-checkout`
 * built-in extension. `checkoutBranch` takes the conflict delegate first —
 * verbatim from the decompiled `cursor-checkout` extension (Cursor 3.25.9):
 * `checkoutBranch(delegate, branchName, { commitSha?, localOnly? }, token)`.
 */
export interface IExtHostCheckoutProvider {
	checkoutBranch(delegate: IExtHostCheckoutConflictDelegate, branchName: string, options: IExtHostCheckoutBranchOptions, token: CancellationToken): Promise<void>;
	warmCheckoutBranch(branchName: string, token: CancellationToken): Promise<void>;
	ensureCurrentBranchPushed(options: IExtHostEnsureBranchPushedOptions, token: CancellationToken): Promise<void>;
	snapshotAndPushCurrentBranch(options: IExtHostSnapshotPushOptions, token: CancellationToken): Promise<string>;
	hasDirtyWorkingTree(token: CancellationToken): Promise<boolean>;
}

export const IExtHostCheckoutProviderService = createDecorator<IExtHostCheckoutProviderService>('extHostCheckoutProvider');

export interface IExtHostCheckoutProviderService extends ExtHostCheckoutProviderShape {
	readonly _serviceBrand: undefined;
	registerCheckoutProvider(provider: IExtHostCheckoutProvider): vscode.Disposable;
}

export class ExtHostCheckoutProvider extends Disposable implements IExtHostCheckoutProviderService {

	declare readonly _serviceBrand: undefined;

	private readonly _proxy: MainThreadCheckoutProviderShape;
	/** Single provider slot — re-registering replaces the previous provider (verbatim). */
	private _checkoutProvider: IExtHostCheckoutProvider | undefined;

	constructor(
		@IExtHostRpcService extHostRpc: IExtHostRpcService
	) {
		super();
		this._proxy = extHostRpc.getProxy(MainContext.MainThreadCheckoutProvider);
	}

	registerCheckoutProvider(provider: IExtHostCheckoutProvider): vscode.Disposable {
		this._checkoutProvider = provider;
		this._proxy.$registerCheckoutProvider();
		return toDisposable(() => {
			if (this._checkoutProvider === provider) {
				this._checkoutProvider = undefined;
			}
			this._proxy.$unregisterCheckoutProvider();
		});
	}

	private _getProvider(): IExtHostCheckoutProvider {
		const provider = this._checkoutProvider;
		if (!provider) {
			throw new Error('No checkout provider registered (ExtHostCheckoutProvider).');
		}
		return provider;
	}

	async $warmCheckoutBranch(branchName: string, token: CancellationToken): Promise<void> {
		await this._getProvider().warmCheckoutBranch(branchName, token);
	}

	async $checkoutBranch(branchName: string, delegateId: string, options: IExtHostCheckoutBranchOptions, token: CancellationToken): Promise<void> {
		const provider = this._getProvider();
		const delegate: IExtHostCheckoutConflictDelegate = {
			resolveConflict: () => this._proxy.$resolveCheckoutConflict(delegateId),
			onNoConflictDetected: () => { this._proxy.$notifyCheckoutNoConflict(delegateId); },
		};
		await provider.checkoutBranch(delegate, branchName, options, token);
	}

	async $ensureCurrentBranchPushed(options: IExtHostEnsureBranchPushedOptions, token: CancellationToken): Promise<void> {
		await this._getProvider().ensureCurrentBranchPushed(options, token);
	}

	async $snapshotAndPushCurrentBranch(options: IExtHostSnapshotPushOptions, token: CancellationToken): Promise<string> {
		return this._getProvider().snapshotAndPushCurrentBranch(options, token);
	}

	async $hasDirtyWorkingTree(token: CancellationToken): Promise<boolean> {
		return this._getProvider().hasDirtyWorkingTree(token);
	}
}
