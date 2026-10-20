/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE (GAPS-170, queue entry #32 `inline-edit-onboarding-popups`):
// Cursor's `tooltipService`, ported at Cursor's own layer (workbench core,
// browser). Binary evidence (Cursor 3.25.9, workbench.desktop.main.js;
// glass carries the identical service): ide-code-mission
// `docs/rea/work-notes-gaps170.md` Slice 1.
//
// Binary shape being ported:
// - DI token `EY = vn("tooltipService")` (desk@959279), impl class `fwi`,
//   registered Delayed (`un(EY, fwi, 1)`), ctor deps exactly
//   `(IStorageService, ICommandService)` (desk@959050).
// - State machine + pipeline configs: ported in common/tooltipPipelines.ts
//   (storage key "tooltipServicePipelines" scope -1/target 1, 14-day
//   initial-disabled period, 4-hour global cooldown, 30-day graces,
//   10-year user-close disable).
// - On trigger the service executes `cursor.showTooltipActionId` with
//   `{location, header, subheader, name}`; the rendering half lives in
//   browser/tooltipUi.ts (editor overlay widget + terminal hint), exactly
//   like the binary splits tooltipService.js from the tooltip UI
//   controller (`editor.contrib.tooltipUiController`).
//
// HONEST-DIVERGENCES:
// D1. Event delivery: the binary's `registerEvent` is fire-and-forget —
//     it races the (synchronous) processing against a 1 ms timeout as a
//     leak guard, so an event can be silently dropped. The fork processes
//     synchronously and drops nothing. User-visible outcome is the same
//     whenever the binary's race is won (the normal case).
// D2. Event producers: the binary emits events from inside the editor
//     text model, the clipboard controller, the xterm wrapper and its
//     in-core chat. The fork wires the producers that have a central
//     core hook at the same layer — editor focus/type/copy/paste via the
//     tooltip UI editor contribution (browser/tooltipUi.ts),
//     terminal show/focus/type via a workbench contribution in
//     browser/tooltipActions.ts, `editor.cmdk.show/submit` in the core
//     prompt-bar service, `terminal.cmdk.show` in
//     terminalCmdkActions.ts — plus a fork-local bridge command
//     `composer.tooltip.registerEvent` so the ide-agent extension (where
//     the fork's chat + terminal prompt bar live) can feed events the
//     core cannot observe. GAPS-176 wired the remaining chat producers
//     through that bridge: `chat.submit` (composerDataService),
//     `terminal.cmdk.submit` (terminal prompt bar), `chat.open` (chat
//     surface resolve in both extension hosts), and the webview-reported
//     `chat.type` / `chat.paste` / `chat.copy.codeblock.manual` /
//     `chat.insert_selection.*` (allowlist in the extension's
//     services/tooltipEvents.ts), plus `terminal.paste` (the terminal
//     pipeline's mandatory final step) via a DOM paste listener in the
//     producer contribution. Residual divergences (see
//     work-notes-gaps176.md): `chat.insert_selection.editor.empty` has
//     no fork counterpart (empty selections are never inserted), the
//     `empty`/`non_empty` qualifier semantics are UNKNOWN in the binary,
//     and `terminal.copy` is deliberately not wired — it appears in no
//     pipeline sequence, so it cannot gate any trigger (QA-177).
// D3. The binary service is constructed by the DI container when a
//     producer first injects it; the fork additionally instantiates it
//     from the producer contribution so the engine's `createdAt` clock
//     starts on first run, matching the binary's load-on-start state
//     initialization.

import { Disposable } from '../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import {
	ITooltipStorage,
	SHOW_TOOLTIP_COMMAND_ID,
	TooltipPipelineEngine,
} from '../common/tooltipPipelines.js';

export const ITooltipService = createDecorator<ITooltipService>('tooltipService');

export interface ITooltipService {
	readonly _serviceBrand: undefined;

	/** Feed one event (e.g. `editor.cmdk.submit`) into every pipeline. */
	registerEvent(event: string): void;
	/** Disable a pipeline for 10 years because the user clicked its popup. */
	registerUserCloseTooltip(name: string): void;
}

class TooltipStorageAdapter implements ITooltipStorage {
	constructor(private readonly _storageService: IStorageService) { }

	get(key: string, scope: number, fallbackValue?: string): string | undefined {
		return this._storageService.get(key, scope as StorageScope, fallbackValue);
	}

	store(key: string, value: string, scope: number, target: number): void {
		this._storageService.store(key, value, scope as StorageScope, target as StorageTarget);
	}
}

export class TooltipService extends Disposable implements ITooltipService {
	declare readonly _serviceBrand: undefined;

	private readonly _engine: TooltipPipelineEngine;

	constructor(
		@IStorageService storageService: IStorageService,
		@ICommandService private readonly _commandService: ICommandService,
	) {
		super();
		this._engine = new TooltipPipelineEngine({
			storage: new TooltipStorageAdapter(storageService),
			onShow: (request) => {
				void this._commandService.executeCommand(SHOW_TOOLTIP_COMMAND_ID, {
					location: request.location,
					header: request.header,
					subheader: request.subheader,
					name: request.name,
				});
			},
		}, isMacintosh);
	}

	registerEvent(event: string): void {
		this._engine.registerEvent(event);
	}

	registerUserCloseTooltip(name: string): void {
		this._engine.registerUserCloseTooltip(name);
	}
}
