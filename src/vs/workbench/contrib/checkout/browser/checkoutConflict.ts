/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Core-side dirty-working-tree conflict UI for branch checkout.
 *
 * This is the workbench-core half of the checkout provider protocol: when the
 * extension's `checkoutBranch` detects a dirty tree it calls
 * `delegate.resolveConflict()`, which RPCs back to the main thread, where the
 * core-side delegate (this module) shows the stash / commit / discard / cancel
 * QuickPick.
 *
 * Verbatim from Cursor 3.25.9
 * (`resources/app/out/vs/workbench/workbench.desktop.main.js`, byte offset
 * 18991626 — composer `checkoutToBranch` flow):
 * ```js
 * const picks = [
 *   { label: "Stash Changes", description: "Save changes to a stash and restore them later", id: "stash" },
 *   { label: "Commit Changes", description: "Create a checkpoint commit with your current changes", id: "commit" },
 *   { label: "Discard Changes", description: "Permanently discard your current changes before switching branches", id: "discard" },
 *   { label: "Cancel", description: "Cancel the checkout operation", id: <abort> }
 * ];
 * return (await this._quickInputService.pick(picks,
 *   { placeHolder: `Local changes detected before checking out ${branch}.`, ignoreFocusLost: true }))?.id ?? <abort>
 * ```
 * Structure/behavior only; no proprietary code reproduced.
 */

import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { ICheckoutConflictDelegate, CheckoutConflictResolution } from '../../../services/checkout/common/checkoutProviderService.js';

/** Verbatim resolution ids from Cursor's conflict QuickPick. */
const enum CheckoutConflictPickId {
	Stash = 'stash',
	Commit = 'commit',
	Discard = 'discard',
	Abort = 'abort',
}

interface ICheckoutConflictPickItem extends IQuickPickItem {
	readonly id: CheckoutConflictResolution | 'abort';
}

/**
 * Shows Cursor's verbatim conflict QuickPick and resolves with the chosen
 * resolution. Dismissing the pick resolves `'abort'` (verbatim:
 * `?.id ?? <abort>`).
 */
export class CheckoutConflictQuickPickDelegate implements ICheckoutConflictDelegate {

	constructor(
		private readonly _branchName: string,
		@IQuickInputService private readonly _quickInputService: IQuickInputService,
	) { }

	async resolveConflict(): Promise<CheckoutConflictResolution | 'abort' | undefined> {
		const picks: ICheckoutConflictPickItem[] = [
			{
				label: 'Stash Changes',
				description: 'Save changes to a stash and restore them later',
				id: CheckoutConflictPickId.Stash,
			},
			{
				label: 'Commit Changes',
				description: 'Create a checkpoint commit with your current changes',
				id: CheckoutConflictPickId.Commit,
			},
			{
				label: 'Discard Changes',
				description: 'Permanently discard your current changes before switching branches',
				id: CheckoutConflictPickId.Discard,
			},
			{
				label: 'Cancel',
				description: 'Cancel the checkout operation',
				id: CheckoutConflictPickId.Abort,
			},
		];
		const pick = await this._quickInputService.pick(picks, {
			placeHolder: `Local changes detected before checking out ${this._branchName}.`,
			ignoreFocusLost: true,
		});
		return pick?.id ?? CheckoutConflictPickId.Abort;
	}

	onNoConflictDetected(): void {
		// The QuickPick delegate has no post-resolution work; the extension
		// proceeds with the checkout once `resolveConflict()` settles.
	}
}

/**
 * Factory for core callers (composer `checkoutToBranch`, agent branch tray):
 * `checkoutProviderService.checkout(createCheckoutConflictDelegate(instantiationService, branchName), branchName, options, token)`.
 */
export function createCheckoutConflictDelegate(quickInputService: IQuickInputService, branchName: string): ICheckoutConflictDelegate {
	return new CheckoutConflictQuickPickDelegate(branchName, quickInputService);
}
