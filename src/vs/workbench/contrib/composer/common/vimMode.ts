/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Cursor Vim mode toggle — Cursor parity (feature `vim-mode-toggle`,
// P2, category editor).
//
// Binary evidence (verbatim — kept character-for-character), from Cursor
// 3.25.6 `workbench.desktop.main.js` / `workbench.glass.main.js` (systematic
// ID extraction, DEEP-DIG-A 2026-10-19), mirrored in the feature matrix
// (docs/product/feature-matrix.json):
//   - `Command cursor.removevim titled "Cursor Vim: Remove Vim Mode"; related command editor.cpp.disableenabled.`
//   - Per dig-root-team/findings-root-matrix.json: `title 'Cursor Vim:
//     Remove Vim Mode', palette command (f1:true)` — the command IS in the
//     command palette.
//   - Cursor's command→category inventory (workbench.glass.main.js,
//     see docs/rea/audit-fix-queue.md §415) contains a `vim_mode` category,
//     consistent with the title's implied "Cursor Vim" grouping.
//
// Expected behavior (feature matrix, verbatim): "Cursor ships a Vim
// emulation mode that can be enabled/removed via command."
//
// QA NOTE (2-step): the "related command `editor.cpp.disableenabled`" is a
// scanner misassociation, NOT part of this feature — `editor.cpp.*` is the
// Cursor Tab command namespace (see docs/rea/deep-tab.md: `editor.cpp.toggle`,
// `editor.cpp.snooze`, "Whether Cursor Tab is currently enabled"; cpp =
// copilot++, not vim). It is deliberately NOT touched here. Likewise the
// "enable" direction has no binary evidence (no `cursor.installvim`-style
// command was found), so per the QA 2-step rule it is EXCLUDED — only the
// evidenced remove command is implemented.
//
// LAYER NOTE: the binary shows the command id, title and palette flag, but
// not which workbench layer registers it, so the Cursor layer is UNKNOWN.
// This lives next to the other composer workbench contributions
// (browser/contrib/composer), the repo's Cursor-parity home.
//
// HONEST-DIVERGENCE: what Cursor removes under the hood ("Cursor Vim", the
// bundled vim-emulation extension) is not visible in the dissected bundles.
// This fork ships no bundled vim extension, so "Remove Vim Mode" here
// uninstalls the installed Vim-emulation extension(s) matching the matcher
// below. Extension removal uses the stock IExtensionManagementService; no
// keybinding emulation of vim itself is claimed.

/** Command id — verbatim binary evidence. */
export const REMOVE_VIM_MODE_COMMAND_ID = 'cursor.removevim';

/** Command title — verbatim binary evidence. */
export const REMOVE_VIM_MODE_COMMAND_TITLE = 'Cursor Vim: Remove Vim Mode';

/**
 * Whether the command appears in the command palette.
 * Verbatim binary evidence: palette command (f1:true) → true.
 */
export const REMOVE_VIM_MODE_IN_COMMAND_PALETTE = true;

/** Palette category display name implied by the title's "Cursor Vim:" prefix. */
export const VIM_MODE_CATEGORY = 'Cursor Vim';

/**
 * Minimal shape of an installed extension used for vim-emulation detection
 * (structural subset of ILocalExtension so this stays node-testable).
 */
export interface IVimExtensionCandidate {
	readonly identifier: { readonly id: string };
	readonly manifest?: { readonly displayName?: string };
}

/**
 * Matches extension ids/display names that carry "vim" as a standalone
 * token: `vscodevim.vim`, `Cursor Vim`, `Vim Emulation` — but not
 * `neovim`, `revims`, `evilmode`.
 */
const VIM_TOKEN_PATTERN = /(^|[.\-_ ])vim([.\-_ ]|$)/i;

/** True when the extension id or display name identifies a Vim-emulation extension. */
export function isVimEmulationExtension<T extends IVimExtensionCandidate>(extension: T): extension is T {
	const id = extension.identifier?.id ?? '';
	const displayName = extension.manifest?.displayName ?? '';
	return VIM_TOKEN_PATTERN.test(id) || VIM_TOKEN_PATTERN.test(displayName);
}

/** Filters the installed extensions down to the Vim-emulation ones (preserves element type). */
export function findVimEmulationExtensions<T extends IVimExtensionCandidate>(installed: readonly T[]): T[] {
	return installed.filter(isVimEmulationExtension);
}
