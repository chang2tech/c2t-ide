/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Update button for the agent sidebar.
//
// Binary evidence (Cursor 3.25.9 nls.keys.json + nls.messages.json, module
// `vs/workbench/contrib/agents/browser/components/AgentSidebarUpdateButton`,
// verified 2026-10-20 by this task — every key name and English string below
// is VERBATIM, indices 4746-4750):
//   'agentSidebarUpdateButton.tooltip'            -> 'Restart Cursor to install the pending update.'
//   'agentSidebarUpdateButton.tooltipWithVersion' -> 'Restart Cursor to install the pending update to {0}.'
//   'agentSidebarUpdateButton.installingTooltip'  -> 'Installing update — Cursor will close and reopen automatically.'
//   'agentSidebarUpdateButton.label'              -> 'Update'
//   'agentSidebarUpdateButton.installingLabel'    -> 'Installing'
// The binary's exact state->string mapping is experiment-gated React; the
// mapping below follows the key names' intent with stock IUpdateService
// states (honest analog, marked). The {0} version comes from the update's
// productVersion/version.
// UNKNOWN: where Cursor mounts this button; like `AgentSidebarFooter` it is
// mountable via `render(parent)` with no mount site wired in this commit.
// GAP: the button queries stock `IUpdateService`; if the fork ships its own
// updater service later, re-point the constructor parameter.

import * as dom from '../../../../../base/browser/dom.js';
import { localize } from '../../../../../nls.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IUpdateService, StateType } from '../../../../../platform/update/common/update.js';

export class AgentSidebarUpdateButton extends Disposable {

	private button: HTMLButtonElement | undefined;

	constructor(
		@IUpdateService private readonly updateService: IUpdateService,
	) {
		super();
	}

	/** Build the button into the given container. Instantiate via IInstantiationService. */
	render(container: HTMLElement): void {
		const button = this.button = dom.$('button') as HTMLButtonElement;
		button.className = 'agent-sidebar-update-button';
		button.addEventListener('click', () => this.onClick());
		this._register(this.updateService.onStateChange(() => this.refresh()));
		container.append(button);
		this.refresh();
	}

	private refresh(): void {
		const button = this.button;
		if (!button) {
			return;
		}
		const state = this.updateService.state;
		switch (state.type) {
			case StateType.AvailableForDownload: {
				// Update is ready to install: binary-verbatim label + tooltip.
				const version = state.update.productVersion ?? state.update.version;
				button.title = version
					? localize('agentSidebarUpdateButton.tooltipWithVersion', 'Restart Cursor to install the pending update to {0}.', version)
					: localize('agentSidebarUpdateButton.tooltip', 'Restart Cursor to install the pending update.');
				button.textContent = localize('agentSidebarUpdateButton.label', 'Update');
				button.hidden = false;
				button.disabled = false;
				break;
			}
			case StateType.Ready:
			case StateType.Downloaded:
				button.title = localize('agentSidebarUpdateButton.tooltip', 'Restart Cursor to install the pending update.');
				button.textContent = localize('agentSidebarUpdateButton.label', 'Update');
				button.hidden = false;
				button.disabled = false;
				break;
			case StateType.Downloading:
			case StateType.Updating:
			case StateType.Overwriting:
				// Installing: binary-verbatim installing strings.
				button.title = localize('agentSidebarUpdateButton.installingTooltip', 'Installing update — Cursor will close and reopen automatically.');
				button.textContent = localize('agentSidebarUpdateButton.installingLabel', 'Installing');
				button.hidden = false;
				button.disabled = true;
				break;
			default:
				// Idle / Disabled / Uninitialized / CheckingForUpdates /
				// Cancelling / Restarting: nothing actionable — keep the
				// sidebar clean. Whether Cursor hides the button here is
				// UNKNOWN (no binary string covers these states).
				button.hidden = true;
				button.disabled = true;
				break;
		}
	}

	private onClick(): void {
		if (this.updateService.state.type === StateType.Ready) {
			this.updateService.quitAndInstall();
			return;
		}
		void this.updateService.checkForUpdates(true);
	}
}
