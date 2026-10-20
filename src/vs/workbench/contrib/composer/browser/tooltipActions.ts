/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE (GAPS-170, queue entry #32 `inline-edit-onboarding-popups`):
// workbench-side glue for the tooltip pipelines that does not belong to
// the service or the popup UI:
//  1. a fork-local bridge command `composer.tooltip.registerEvent` so
//     extension-host code (the fork's chat webview + terminal prompt bar
//     live in extensions/ide-agent, where the binary's in-core producers
//     cannot be mirrored) can feed events into ITooltipService. This
//     command is NOT a Cursor command — the binary has no such command
//     because its producers are all in-core. It follows this fork's
//     existing bridge precedent (`composer.terminalPromptBar.setVisible`).
//  2. a workbench contribution feeding the terminal producers that do
//     have central core hooks: `terminal.focus` (binary: xterm textarea
//     focus, desk@21689151), `terminal.type` (binary: xterm onData /
//     sendText, desk@21727434/@21736648), `terminal.show` (binary:
//     terminalService.showPanel, desk@36436399 — the fork observes the
//     terminal panel view becoming visible instead, the closest central
//     signal available; the binary's other step-1 alternatives
//     focus/type start the same sequence, so the pipeline is not gated
//     on this one producer), `terminal.paste` (GAPS-176: the mandatory
//     final step of the `terminal.cmdk` pipeline — a DOM `paste`
//     listener on the instance's wrapper element, the same layer the
//     binary uses for its xterm-wrapper DOM listeners, e.g.
//     `terminal.copy` on the wrapper at glass@42402351; the binary's own
//     `terminal.paste` producer was not located by GAPS-170, UNKNOWN).
//     `terminal.copy` is deliberately NOT wired: it appears in no
//     pipeline sequence (QA-177), so it cannot gate any trigger.
// The contribution also touches ITooltipService once so the Delayed
// singleton is instantiated at startup and its persisted `createdAt`
// clock (the binary's 14-day initial-disabled period) starts on first
// run, as in the binary where producers inject the service from load.

import * as dom from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { localize2 } from '../../../../nls.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { ITerminalInstance, ITerminalService } from '../../terminal/browser/terminal.js';
import { ITooltipService } from './tooltipService.js';

/** Fork-local bridge (NOT in the binary) — see the module header. */
export const TOOLTIP_REGISTER_EVENT_BRIDGE_COMMAND_ID = 'composer.tooltip.registerEvent';

/** Panel view id whose visibility the binary's showPanel drives. */
const TERMINAL_PANEL_VIEW_ID = 'workbench.panel.terminal';

export class TooltipEventProducerContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.composer.tooltipEventProducers';

	private readonly _wiredInstances = new Set<number>();

	constructor(
		@ITooltipService private readonly _tooltipService: ITooltipService,
		@ITerminalService terminalService: ITerminalService,
		@IViewsService viewsService: IViewsService,
	) {
		super();
		for (const instance of terminalService.instances) {
			this._wireInstance(instance);
		}
		this._register(terminalService.onDidCreateInstance(instance => this._wireInstance(instance)));
		this._register(terminalService.onDidFocusInstance(() => {
			this._tooltipService.registerEvent('terminal.focus');
		}));
		this._register(viewsService.onDidChangeViewVisibility(({ id, visible }) => {
			if (visible && id === TERMINAL_PANEL_VIEW_ID) {
				this._tooltipService.registerEvent('terminal.show');
			}
		}));
	}

	private _wireInstance(instance: ITerminalInstance): void {
		if (this._wiredInstances.has(instance.instanceId)) {
			return;
		}
		this._wiredInstances.add(instance.instanceId);
		// GAPS-187 (NEEDS-FIX-182-1): every registration tied to this one
		// instance lives in a per-instance DisposableStore — the same
		// pattern as terminalService._initInstanceListeners and the
		// binary's per-instance `this._register(...)` on the xterm wrapper
		// (glass@42402357) — instead of the contribution's session-long
		// store, where dead instances' listeners (and the closures
		// capturing the instance/domElement) accumulated for the whole
		// session. The store is disposed from `onWillDispose`, and the
		// `onWillDispose` listener itself is the only per-instance entry
		// in the contribution store; it removes itself there, so after an
		// instance dies the contribution holds no reference to it at all.
		const instanceDisposables = new DisposableStore();
		instanceDisposables.add(instance.onData(() => {
			this._tooltipService.registerEvent('terminal.type');
		}));
		// GAPS-176: `terminal.paste` — paste events from the xterm textarea
		// bubble to the instance's wrapper element (domElement exists from
		// construction; the textarea is appended into it on attach).
		instanceDisposables.add(dom.addDisposableListener(instance.domElement, 'paste', () => {
			this._tooltipService.registerEvent('terminal.paste');
		}));
		const willDisposeListener = this._register(instance.onWillDispose(() => {
			this._wiredInstances.delete(instance.instanceId);
			instanceDisposables.dispose();
			this._store.delete(willDisposeListener);
		}));
	}
}

export function registerTooltipBridgeActions(): void {
	registerAction2(class extends Action2 {
		constructor() {
			super({ id: TOOLTIP_REGISTER_EVENT_BRIDGE_COMMAND_ID, title: localize2('composer.tooltip.registerEvent', 'Register Tooltip Event (internal bridge)'), f1: false });
		}
		async run(accessor: ServicesAccessor, event?: unknown): Promise<void> {
			if (typeof event === 'string' && event.length > 0) {
				accessor.get(ITooltipService).registerEvent(event);
			}
		}
	});
}
