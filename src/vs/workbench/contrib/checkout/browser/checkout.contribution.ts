/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Workbench contribution for branch-checkout conflict UI (`contrib/checkout`).
 *
 * The dirty-working-tree conflict QuickPick (stash / commit / discard /
 * cancel) lives in workbench core — not in the `ide-checkout` extension.
 * When the extension's `checkoutBranch` finds a dirty tree it calls
 * `delegate.resolveConflict()`; the delegate RPCs back to the main thread,
 * where the core-side delegate (`./checkoutConflict.js`) shows this QuickPick
 * via `IQuickInputService`.
 *
 * Like Cursor, core callers (composer `checkoutToBranch`, agent branch tray)
 * build the delegate at the call site:
 * ```ts
 * checkoutProviderService.checkout(
 *   createCheckoutConflictDelegate(quickInputService, branchName),
 *   branchName, options, token)
 * ```
 * This module is imported by `workbench.common.main.ts` so the core-side UI
 * ships in the workbench bundle.
 */

import './checkoutConflict.js';
