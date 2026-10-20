/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Migrated — vscode API → DI (2026-10-19).
//
// Layer split (P0 node-free common/): the `WorktreeService` implementation
// shells out to `git` via node:child_process, so it lives in
// `electron-browser/worktreeService.ts` (desktop-only). This module keeps the
// node-free contract (the `Worktree` metadata shape) so common/ and browser/
// code can reference it without pulling node builtins into the web bundle.

/**
 * Metadata for one git worktree, parsed from `git worktree list --porcelain`.
 */
export interface Worktree {
	path: string;
	head: string;
	branch: string | undefined;
	bare: boolean;
	detached: boolean;
	locked: boolean;
	prunable: boolean;
	isMain: boolean;
}
