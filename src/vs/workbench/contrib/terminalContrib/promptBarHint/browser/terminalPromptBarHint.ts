/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Terminal as RawXtermTerminal } from '@xterm/xterm';
import * as dom from '../../../../../base/browser/dom.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import type { ITerminalContribution, IXtermTerminal } from '../../../terminal/browser/terminal.js';
import type { ITerminalContributionContext } from '../../../terminal/browser/terminalExtensions.js';
import {
	GENERATE_IN_TERMINAL_COMMAND_ID,
	TERMINAL_PROMPT_BAR_VISIBLE_CONTEXT_KEY,
	TerminalPromptBarHintSettingId,
	shouldShowTerminalPromptBarHint,
	terminalPromptBarHintText,
} from '../common/terminalPromptBarHint.js';
import './media/terminalPromptBarHint.css';

const promptBarVisibleContextKeys = new Set([TERMINAL_PROMPT_BAR_VISIBLE_CONTEXT_KEY]);

/**
 * The "Terminal Hint" consumer (GAPS-142, `settings-terminal-hint`).
 *
 * Cursor 3.25.9 renders the Cmd/Ctrl+K hint from the same per-instance
 * workbench contribution that owns the terminal prompt bar (class `qme`,
 * ID "terminal.promptBar", desk@36723159): a `div.prompt-bar-container`
 * appended to the terminal instance's domElement, holding a
 * `div.prompt-bar-hint` whose text is
 * `${keybindingLabel} to generate command`. This fork contribution is the
 * equivalent surface: workbench core, one instance per terminal, reading
 * the fork setting `ide.terminal.showCmdkHint` (registered in
 * contrib/composer/common/composerConfiguration.ts; Cursor's own storage
 * semantics are `hideTerminalTooltip === false` — see
 * ../common/terminalPromptBarHint.ts for the full evidence and the
 * divergences: no per-instance enablePromptBar gate, overlay instead of
 * setTopUiContributionHeight, global prompt-bar visibility).
 *
 * Re-render triggers mirror Cursor's: contribution creation (xtermOpen),
 * setting change, keybinding change, and prompt-bar visibility change
 * (Cursor re-renders when its prompt bar hides/shows and skips rendering
 * while it is visible).
 */
export class TerminalPromptBarHintContribution extends Disposable implements ITerminalContribution {
	static readonly ID = 'terminal.promptBarHint';

	private _container: HTMLElement | undefined;
	private _hint: HTMLElement | undefined;

	constructor(
		private readonly _ctx: ITerminalContributionContext,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IKeybindingService private readonly _keybindingService: IKeybindingService,
		@IContextKeyService private readonly _contextKeyService: IContextKeyService,
	) {
		super();
		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(TerminalPromptBarHintSettingId.ShowCmdkHint)) {
				this._renderHint();
			}
		}));
		this._register(this._keybindingService.onDidUpdateKeybindings(() => {
			this._renderHint();
		}));
		this._register(this._contextKeyService.onDidChangeContext(e => {
			if (e.affectsSome(promptBarVisibleContextKeys)) {
				this._renderHint();
			}
		}));
	}

	xtermOpen(_xterm: IXtermTerminal & { raw: RawXtermTerminal }): void {
		this._renderHint();
	}

	override dispose(): void {
		this._container?.remove();
		this._container = undefined;
		this._hint = undefined;
		super.dispose();
	}

	private _renderHint(): void {
		const keybinding = this._keybindingService.lookupKeybinding(GENERATE_IN_TERMINAL_COMMAND_ID);
		const show = shouldShowTerminalPromptBarHint({
			settingEnabled: this._configurationService.getValue<boolean>(TerminalPromptBarHintSettingId.ShowCmdkHint) ?? false,
			promptBarVisible: this._contextKeyService.getContextKeyValue<boolean>(TERMINAL_PROMPT_BAR_VISIBLE_CONTEXT_KEY) ?? false,
			hideFromUser: this._ctx.instance.shellLaunchConfig.hideFromUser ?? false,
			keybindingLabel: keybinding?.getLabel() ?? undefined,
		});
		if (!show) {
			if (this._container) {
				this._container.style.display = 'none';
			}
			return;
		}
		const container = this._ensureContainer();
		if (!container || !this._hint) {
			return;
		}
		this._hint.textContent = terminalPromptBarHintText(keybinding?.getLabel() ?? undefined) ?? '';
		container.style.display = 'block';
	}

	private _ensureContainer(): HTMLElement | undefined {
		if (this._container) {
			return this._container;
		}
		const wrapper = this._ctx.instance.domElement;
		if (!wrapper) {
			return undefined;
		}
		// The container is positioned absolutely over the top of the
		// terminal instance (the fork has no setTopUiContributionHeight —
		// see the divergence note in ../common/terminalPromptBarHint.ts);
		// make sure the wrapper establishes a positioning context.
		if (dom.getComputedStyle(wrapper).position === 'static') {
			wrapper.style.position = 'relative';
		}
		const container = document.createElement('div');
		container.classList.add('prompt-bar-container');
		container.style.display = 'none';
		const hint = document.createElement('div');
		hint.classList.add('prompt-bar-hint');
		container.appendChild(hint);
		wrapper.appendChild(container);
		this._container = container;
		this._hint = hint;
		this._register(toDisposable(() => {
			container.remove();
			if (this._container === container) {
				this._container = undefined;
				this._hint = undefined;
			}
		}));
		return container;
	}
}
