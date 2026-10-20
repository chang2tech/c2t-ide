/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: `ide.openOrFocusGlassWindow` — Cursor `cursor.openOrFocusGlassWindow`
// analog (finding F7, 2026-10-20).
//
// Binary evidence (Cursor 3.25.x, ~/workspace/ide-code-mission/reference/cursor):
//   out/vs/workbench/workbench.desktop.main.js — Action2
//   `cursor.openOrFocusGlassWindow` ("Open or Focus Agents Window (Glass)",
//   category View, f1:!1 i.e. NOT in the command palette, keybinding
//   CtrlCmd|Alt|N, args `{ agentsWindowOpenSource, deeplinkUrl,
//   startupHandoff, handoffAgentComposerId }`) → shared helper `t4a` →
//   `nativeHostService.openGlassWindow({ glassLaunchIntent })` /
//   `getWindows()` + `isGlassWindow` check / `focusWindow({ force: true })`.
//   (Cursor exposes "New Agents Window" / "Switch to {0}" in the palette via
//   separate dynamic menu registrations, not via this command's f1 flag.)
//   out/main.js — `openOrFocusGlassWindowForMenu` /
//   `doOpenGlassWindowForMenu`: finds the window with `config.glass === true`
//   and focuses it via `openExistingWindow`; otherwise
//   `windowsMainService.open({ context, cli: { ...args, glass: true,
//   'new-window': true }, forceNewWindow: true, forceEmpty: true })`.
//
// Deliberate deviation: this analog uses f1:true (palette-visible) because
// we do not (yet) have Cursor's dynamic "New/Switch to Agents Window"
// palette entries; hiding it (f1:false) would make the command
// undiscoverable. No keybinding: Cursor's CtrlCmd|Alt|N chord is already
// taken in this fork (see note below).
//
// This command is the core target of the `ide.openAgentsWindow` extension
// command. It must NEVER route through the stock
// `workbench.action.openAgentsWindow` (the VS Code Copilot-style
// agent-sessions window, `INativeHostService.openAgentsWindow` — that wrong
// delegation was finding F7).
//
// Desktop-only layer (electron-browser/): opening/focusing a native window
// goes through `INativeHostService`, which is a main-process proxy and only
// meaningful on desktop — the same layer the stock
// `workbench.action.openAgentsWindow` registration lives in
// (`vs/sessions/contrib/openAgentsWindow/electron-browser/`).
//
// Note: no keybinding here. Cursor binds CtrlCmd|Alt|N, but in this fork
// that chord is already taken by `composer.newAgentChat` ("New Agent Chat")
// and by "File: New Untitled File" on web. The existing
// `composer.openAgentsWindow` (CtrlCmd|Alt|O) still reaches this command via
// the `ide.openAgentsWindow` extension command.

import { localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';

export class OpenOrFocusGlassWindowAction extends Action2 {
	static readonly ID = 'ide.openOrFocusGlassWindow';

	constructor() {
		super({
			id: OpenOrFocusGlassWindowAction.ID,
			title: localize2('composer.openOrFocusGlassWindow', 'Open or Focus Agents Window'),
			category: Categories.View,
			// QA-MIGRATION-C (P2 migration-double-commands, 2026-10-20): palette-hidden.
			// The canonical palette entry for this user action is
			// `composer.openAgentsWindow` ("Open Agents Window"); this command is the
			// underlying mechanism (analog of Cursor's `cursor.openOrFocusGlassWindow`),
			// reachable via `composer.openAgentsWindow` -> `ide.openAgentsWindow` ->
			// this command. Keeping it palette-visible produced 3 entries for one action.
			f1: false,
			metadata: {
				description: 'Open or focus the dedicated Agents window (analog of Cursor\'s cursor.openOrFocusGlassWindow).',
			},
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// Mirror Cursor's `{ agentsWindowOpenSource }` argument; the source
		// is forwarded to the main process for telemetry/debugging.
		const rawArgs = args[0] as { agentsWindowOpenSource?: unknown } | undefined;
		const agentsWindowOpenSource = typeof rawArgs?.agentsWindowOpenSource === 'string'
			? rawArgs.agentsWindowOpenSource
			: 'ide_open_or_focus_glass_window';
		await accessor.get(INativeHostService).openGlassWindow({ source: agentsWindowOpenSource });
	}
}

registerAction2(OpenOrFocusGlassWindowAction);
