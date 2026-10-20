/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * IDE-CODE (DEV-GAPS-83, settings-window-layout): applies Cursor's
 * "Window Layout" presets (Agent / Editor) to the workbench layout.
 *
 * Evidence and preset definitions: see common/windowLayout.ts. This file
 * is the fork equivalent of the binary's apply function `g2g`
 * (workbench.glass.main.js byte ~24324237):
 *   1. store the preset id under
 *      `cursor/agentLayout.quickMenu.lastSelectedLayoutId`
 *      (APPLICATION scope, USER target — binary `store(key, id, -1, 0)`);
 *   2. apply part visibility/location (`h20`), using toggle commands for
 *      the auxiliary bar / panel / primary sidebar exactly like the
 *      binary (`yQt` = Toggle Auxiliary Bar, `bQt` = Toggle Panel,
 *      `OX` = Toggle Primary Side Bar), `setPartHidden` for the editor
 *      area (see the divergence note in common/windowLayout.ts), and the
 *      `workbench.sideBar.location` configuration for the location.
 *
 * The settings entry itself is the configuration
 * `ide.window.defaultLayout` (registered in
 * common/composerConfiguration.ts, IDE Code › General — the fork's
 * settings surface for Cursor's General › Layout section). The
 * contribution below watches it: a user change applies the preset and
 * fires the binary's telemetry event `agent_layout.switch_layout`
 * (via the fork's `[telemetry]` convention — logged through the
 * notification-free output path used by other core parity features:
 * console is NOT used; the event is recorded in the storage-backed
 * application log through ILogService at info level).
 * Programmatic application (the configuration watcher) does not write
 * the configuration back, so there is no feedback loop.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchLayoutService, Parts, Position } from '../../../services/layout/browser/layoutService.js';
import {
	IWindowLayoutCurrentState,
	LAST_SELECTED_LAYOUT_STORAGE_KEY,
	WINDOW_LAYOUT_CONFIG_KEY,
	WINDOW_LAYOUT_TELEMETRY_EVENT,
	WindowLayoutId,
	planWindowLayoutOperations,
	windowLayoutFromSideBarPosition,
	windowLayoutPreset,
} from '../common/windowLayout.js';

/** Binary toggle command ids (yQt / bQt / OX equivalents in the fork). */
const TOGGLE_AUXILIARY_BAR_COMMAND = 'workbench.action.toggleAuxiliaryBar';
const TOGGLE_PANEL_COMMAND = 'workbench.action.togglePanel';
const TOGGLE_SIDEBAR_COMMAND = 'workbench.action.toggleSidebarVisibility';
const SIDEBAR_LOCATION_CONFIG = 'workbench.sideBar.location';

export class WindowLayoutContribution extends Disposable {
	static readonly ID = 'workbench.contrib.windowLayout';

	constructor(
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@ICommandService private readonly commandService: ICommandService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IStorageService private readonly storageService: IStorageService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(WINDOW_LAYOUT_CONFIG_KEY)) {
				const layout = this.configurationService.getValue<WindowLayoutId>(WINDOW_LAYOUT_CONFIG_KEY);
				if (layout === 'agent' || layout === 'editor') {
					void this.applyWindowLayout(layout, true);
				}
			}
		}));
	}

	/** The derived current value, exactly like the binary settings picker. */
	currentLayout(): WindowLayoutId {
		return windowLayoutFromSideBarPosition(this.layoutService.getSideBarPosition());
	}

	private currentState(): IWindowLayoutCurrentState {
		return {
			sidebarVisible: this.layoutService.isVisible(Parts.SIDEBAR_PART),
			chatVisible: this.layoutService.isVisible(Parts.AUXILIARYBAR_PART),
			panelVisible: this.layoutService.isVisible(Parts.PANEL_PART),
			editorsVisible: this.layoutService.isVisible(Parts.EDITOR_PART, mainWindow),
			sidebarLocation: this.layoutService.getSideBarPosition() === Position.RIGHT ? 'right' : 'left'
		};
	}

	/**
	 * Binary `g2g` equivalent: record the selection, then apply the
	 * preset. `fromSettings` fires the binary's settings-entry telemetry.
	 */
	async applyWindowLayout(layout: WindowLayoutId, fromSettings: boolean): Promise<void> {
		const preset = windowLayoutPreset(layout);
		// Binary: `i.store(wNi, c.id, -1, 0)` — APPLICATION scope, USER target.
		this.storageService.store(LAST_SELECTED_LAYOUT_STORAGE_KEY, preset.id, StorageScope.APPLICATION, StorageTarget.USER);
		if (fromSettings) {
			// Binary settings component: trackEvent("agent_layout.switch_layout",
			// { selectedLayout: Agent | Editor }). The fork has no analytics
			// backend in core; the event is logged for inspectability.
			this.logService.info(`[telemetry] ${WINDOW_LAYOUT_TELEMETRY_EVENT} selectedLayout=${preset.telemetryName}`);
		}
		const ops = planWindowLayoutOperations(preset.state, this.currentState());
		for (const op of ops) {
			switch (op.kind) {
				case 'chat':
					await this.commandService.executeCommand(TOGGLE_AUXILIARY_BAR_COMMAND);
					break;
				case 'panel':
					await this.commandService.executeCommand(TOGGLE_PANEL_COMMAND);
					break;
				case 'sidebar':
					await this.commandService.executeCommand(TOGGLE_SIDEBAR_COMMAND);
					break;
				case 'editors':
					this.layoutService.setPartHidden(!op.visible, Parts.EDITOR_PART);
					break;
				case 'sidebarLocation':
					await this.configurationService.updateValue(SIDEBAR_LOCATION_CONFIG, op.location);
					break;
			}
		}
	}
}
