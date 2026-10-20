/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: DEV-GAPS-18-W4 — `agent-worktree-chat-actions`
// (audit-fix-queue.md 2026-10-20 run 28, INFO, evidence enriched in place).
//
// Binary evidence (Cursor 3.25.9, workbench.glass.main.js — chat-tab overflow
// menu builder `sSv`; re-verified by the REA auditor AND independently
// re-confirmed from the reference bundle during implementation):
//   Cf({id:"composer.copyWorktreePath",label:"Copy worktree path",enabled:!0,
//      run:async()=>{u("composer.copyWorktreePath");const d=n.gitWorktree.worktreePath;
//                    await e.clipboardService.writeText(d)}})
//   Cf({id:"composer.openTerminalInWorktree",label:"Open terminal in worktree",enabled:!0,
//      run:()=>c("composer.openTerminalInWorktree")})   // menu item re-dispatches
//      // the registered command, whose real implementation is VERBATIM:
//      //   a=(...)?.gitWorktree?.worktreePath;
//      //   a&&await n.executeCommand("workbench.action.terminal.newWithCwd",{cwd:a})
//   Cf({id:"composer.openNewWindowInWorktree",label:"Open new window in worktree",enabled:!0,
//      run:()=>{u("composer.openNewWindowInWorktree");const d=n.gitWorktree.worktreePath;
//                return e.hostService.openWindow([{folderUri:st.file(d)}],{forceNewWindow:!0})}})
// The menu array is spread as `...r?[...]` — the three items only exist when the
// chat's `gitWorktree.worktreePath` is truthy. The same menu hosts Export
// Transcript / Share Transcript / Copy Request ID / Give Feedback /
// Open in Prompt Quality.
//
// ID MAPPING (documented per the gap brief — no remap was needed):
//   Cursor `composer.copyWorktreePath`        -> ComposerCopyWorktreePathAction        (id VERBATIM)
//   Cursor `composer.openTerminalInWorktree`  -> ComposerOpenTerminalInWorktreeAction  (id VERBATIM)
//   Cursor `composer.openNewWindowInWorktree` -> ComposerOpenNewWindowInWorktreeAction (id VERBATIM)
// The fork's composer command namespace is already `composer.*`, so Cursor's
// ids are kept 1:1 and the labels below are Cursor-VERBATIM.
//
// Fork model notes:
// - Cursor's `gitWorktree.worktreePath` (chat-tab model) maps to
//   `ComposerChatEditorInput.worktreePath` (composerEditorInput.ts).
// - The menu gate maps to the `composer.chatHasWorktree` context key
//   (ComposerContextKeys), synced from the active chat tab by
//   ComposerWorkbenchContribution (composer.contribution.ts). The overflow
//   menu items are registered in `registerComposerMenus()`
//   (composerActions.ts) with `when: resourceScheme == 'ide-chat' &&
//   composer.chatHasWorktree` — the same builder Cursor's `sSv` is.
// - "Open terminal in worktree": Cursor `executeCommand(d, i)` executes its
//   terminal command with the worktree path; the fork equivalent is the
//   stock `workbench.action.terminal.newWithCwd` command with `{ cwd }`.
// - "Open new window in worktree": `hostService.openWindow(
//   [{ folderUri: URI.file(path) }], { forceNewWindow: true })` — verbatim
//   per the binary. (Same call as WorktreeService.openInNewWindow; kept
//   inline here so this module owns the Cursor-parity behavior end to end.)
//
// HONEST DIVERGENCES (do not claim Cursor parity on these):
// - Telemetry: Cursor's run wrappers call
//   analyticsService.trackEvent("feature_usage.ui_action_invoked",
//   {feature:"worktrees",actionId}) — NOT ported (the fork has no such
//   event); behavior is otherwise identical.
// - Exact intra-menu ORDER of the three items relative to the other overflow
//   items: evidence confirms the menu, not the order. Placed as a trailing
//   worktree group (orders 8/9/10) in `registerComposerMenus()`.
// - Palette visibility: the binary only shows menu-builder registration, so
//   all three are menu-only (`f1: false`), like the sibling overflow items.
// - Gating granularity: Cursor gates per chat tab (`gitWorktree` on the tab
//   model); the fork key follows the ACTIVE chat tab (same granularity as
//   the existing `resourceScheme == 'ide-chat'` when-clause). `run()`
//   re-resolves the path and fails closed with a notification when missing.

import { localize2 } from '../../../../nls.js';
import { URI } from '../../../../base/common/uri.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { TerminalCommandId } from '../../terminal/common/terminal.js';
import { ComposerChatEditorInput } from './composerEditorInput.js';

/**
 * Resolve the worktree path of the active chat tab (undefined when the
 * active editor is not a chat tab, or the tab has no worktree attached).
 * Fork equivalent of reading Cursor's chat-tab `gitWorktree.worktreePath`.
 */
export function resolveActiveChatWorktreePath(editorService: IEditorService): string | undefined {
	const input = editorService.activeEditor;
	if (input instanceof ComposerChatEditorInput) {
		return input.worktreePath;
	}
	return undefined;
}

/** Fail-closed helper: notify when the command is invoked outside a worktree-backed chat. */
function notifyNoWorktree(notificationService: INotificationService): void {
	notificationService.info(localize2('composer.worktree.noWorktree', "This chat is not attached to a git worktree.").value);
}

/**
 * Cursor `composer.copyWorktreePath` — label VERBATIM "Copy worktree path".
 * Binary: `clipboardService.writeText(d)` with d = worktree path.
 */
export class ComposerCopyWorktreePathAction extends Action2 {
	static readonly ID = 'composer.copyWorktreePath';

	constructor() {
		super({
			id: ComposerCopyWorktreePathAction.ID,
			title: localize2('composer.copyWorktreePath', 'Copy worktree path'),
			f1: false,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const clipboardService = accessor.get(IClipboardService);
		const worktreePath = resolveActiveChatWorktreePath(editorService);
		if (!worktreePath) {
			notifyNoWorktree(accessor.get(INotificationService));
			return;
		}
		await clipboardService.writeText(worktreePath);
	}
}

/**
 * Cursor `composer.openTerminalInWorktree` — label VERBATIM
 * "Open terminal in worktree".
 * Binary-VERBATIM implementation:
 *   a=(...)?.gitWorktree?.worktreePath;
 *   a&&await n.executeCommand("workbench.action.terminal.newWithCwd",{cwd:a})
 */
export class ComposerOpenTerminalInWorktreeAction extends Action2 {
	static readonly ID = 'composer.openTerminalInWorktree';

	constructor() {
		super({
			id: ComposerOpenTerminalInWorktreeAction.ID,
			title: localize2('composer.openTerminalInWorktree', 'Open terminal in worktree'),
			f1: false,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const commandService = accessor.get(ICommandService);
		const worktreePath = resolveActiveChatWorktreePath(editorService);
		if (!worktreePath) {
			notifyNoWorktree(accessor.get(INotificationService));
			return;
		}
		await commandService.executeCommand(TerminalCommandId.NewWithCwd, { cwd: worktreePath });
	}
}

/**
 * Cursor `composer.openNewWindowInWorktree` — label VERBATIM
 * "Open new window in worktree".
 * Binary: `hostService.openWindow([{folderUri:st.file(d)}],{forceNewWindow:!0})`.
 */
export class ComposerOpenNewWindowInWorktreeAction extends Action2 {
	static readonly ID = 'composer.openNewWindowInWorktree';

	constructor() {
		super({
			id: ComposerOpenNewWindowInWorktreeAction.ID,
			title: localize2('composer.openNewWindowInWorktree', 'Open new window in worktree'),
			f1: false,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const hostService = accessor.get(IHostService);
		const worktreePath = resolveActiveChatWorktreePath(editorService);
		if (!worktreePath) {
			notifyNoWorktree(accessor.get(INotificationService));
			return;
		}
		hostService.openWindow([{ folderUri: URI.file(worktreePath) }], { forceNewWindow: true });
	}
}

/** Register the three worktree chat-tab overflow commands. */
export function registerComposerWorktreeActions(): void {
	registerAction2(ComposerCopyWorktreePathAction);
	registerAction2(ComposerOpenTerminalInWorktreeAction);
	registerAction2(ComposerOpenNewWindowInWorktreeAction);
}
