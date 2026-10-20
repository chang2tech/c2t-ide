/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `checkoutProviderService` — the main-thread workbench service behind branch
 * migration / local↔cloud handoff (Agents Window "move to cloud", composer
 * `checkoutToBranch`, agent branch tray).
 *
 * Mirrors Cursor 3.25.9 verbatim (`vn("checkoutProviderService")` in
 * `resources/app/out/vs/workbench/workbench.desktop.main.js`, module
 * `checkoutProviderService.js`):
 *  - single handler slot (`registerHandler` replaces the previous handler,
 *    like Cursor's `this.handler.set(e)`);
 *  - `checkout(delegate, branchName, options, token)` forwards to
 *    `handler.checkoutBranch(delegate, branchName, options, token)` —
 *    **delegate first**, verbatim;
 *  - `warmCheckoutBranch`, `ensureCurrentBranchPushed`,
 *    `snapshotAndPushCurrentBranch`, `hasDirtyWorkingTree` forward with the
 *    caller's cancellation token.
 *
 * The handler is installed by `MainThreadCheckoutProvider` (the extHost↔
 * mainThread RPC bridge) when the `ide-checkout` built-in extension registers
 * its provider via `vscode.cursor.registerCheckoutProvider`.
 */

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';

/** Verbatim conflict resolutions from Cursor's core conflict UI. */
export type CheckoutConflictResolution = 'stash' | 'commit' | 'discard';

/**
 * The core-side conflict delegate passed as the first argument of
 * `checkoutBranch`. In Cursor this object is constructed by the *caller* in
 * workbench core (composer / agent tray), and its `resolveConflict()` shows
 * the stash/commit/discard/cancel QuickPick via `IQuickInputService`.
 */
export interface ICheckoutConflictDelegate {
	resolveConflict(): Promise<CheckoutConflictResolution | 'abort' | undefined>;
	onNoConflictDetected?(): void | Promise<void>;
}

export interface ICheckoutBranchOptions {
	readonly commitSha?: string;
	readonly localOnly?: boolean;
}

export interface IEnsureBranchPushedOptions {
	readonly cwd?: string;
	readonly remoteName?: string;
	readonly branchName?: string;
	readonly forcePush?: boolean;
}

export interface ISnapshotPushOptions {
	readonly cwd?: string;
	readonly remoteName?: string;
	readonly commitMessage?: string;
	readonly branchPrefix?: string;
	readonly stashLocalChangesAfterPush?: boolean;
	readonly stashMessage?: string;
}

/**
 * The main-thread handler registered with the service. `MainThreadCheckoutProvider`
 * installs the RPC-backed handler; `checkoutBranch` keeps the verbatim
 * provider-first shape.
 */
export interface ICheckoutProviderHandler {
	checkoutBranch(delegate: ICheckoutConflictDelegate, branchName: string, options: ICheckoutBranchOptions, token: CancellationToken): Promise<void>;
	warmCheckoutBranch(branchName: string, token: CancellationToken): Promise<void>;
	ensureCurrentBranchPushed(options: IEnsureBranchPushedOptions, token: CancellationToken): Promise<void>;
	snapshotAndPushCurrentBranch(options: ISnapshotPushOptions, token: CancellationToken): Promise<string>;
	hasDirtyWorkingTree(token: CancellationToken): Promise<boolean>;
}

export const ICheckoutProviderService = createDecorator<ICheckoutProviderService>('checkoutProviderService');

export interface ICheckoutProviderService {
	readonly _serviceBrand: undefined;
	registerHandler(handler: ICheckoutProviderHandler): IDisposable;
	/** Verbatim: `checkout(e, t, n, i)` → `handler.checkoutBranch(e, t, n, token)`. */
	checkout(delegate: ICheckoutConflictDelegate, branchName: string, options: ICheckoutBranchOptions, token: CancellationToken): Promise<void>;
	warmCheckoutBranch(branchName: string, token: CancellationToken): Promise<void>;
	ensureCurrentBranchPushed(options: IEnsureBranchPushedOptions, token: CancellationToken): Promise<void>;
	snapshotAndPushCurrentBranch(options: ISnapshotPushOptions, token: CancellationToken): Promise<string>;
	hasDirtyWorkingTree(token: CancellationToken): Promise<boolean>;
}

export class CheckoutProviderService extends Disposable implements ICheckoutProviderService {

	declare readonly _serviceBrand: undefined;

	/** Single handler slot — re-registering replaces the previous handler (verbatim). */
	private _handler: ICheckoutProviderHandler | undefined;

	registerHandler(handler: ICheckoutProviderHandler): IDisposable {
		this._handler = handler;
		return toDisposable(() => {
			if (this._handler === handler) {
				this._handler = undefined;
			}
		});
	}

	private _getHandler(): ICheckoutProviderHandler {
		const handler = this._handler;
		if (!handler) {
			throw new Error('No checkout provider registered (checkoutProviderService).');
		}
		return handler;
	}

	async checkout(delegate: ICheckoutConflictDelegate, branchName: string, options: ICheckoutBranchOptions, token: CancellationToken): Promise<void> {
		return this._getHandler().checkoutBranch(delegate, branchName, options, token);
	}

	async warmCheckoutBranch(branchName: string, token: CancellationToken): Promise<void> {
		return this._getHandler().warmCheckoutBranch(branchName, token);
	}

	async ensureCurrentBranchPushed(options: IEnsureBranchPushedOptions, token: CancellationToken): Promise<void> {
		return this._getHandler().ensureCurrentBranchPushed(options, token);
	}

	async snapshotAndPushCurrentBranch(options: ISnapshotPushOptions, token: CancellationToken): Promise<string> {
		return this._getHandler().snapshotAndPushCurrentBranch(options, token);
	}

	async hasDirtyWorkingTree(token: CancellationToken): Promise<boolean> {
		return this._getHandler().hasDirtyWorkingTree(token);
	}
}

registerSingleton(ICheckoutProviderService, CheckoutProviderService, InstantiationType.Delayed);
