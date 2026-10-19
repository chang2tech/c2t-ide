/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Terminal as RawXtermTerminal } from '@xterm/xterm';
import * as dom from '../../../../../base/browser/dom.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import type { ITerminalContribution, ITerminalInstance, IXtermTerminal } from '../../../terminal/browser/terminal.js';
import type { ITerminalContributionContext } from '../../../terminal/browser/terminalExtensions.js';
import './media/terminalSelectionToolbar.css';

/**
 * Configuration key controlling the floating selection toolbar. The setting
 * itself is contributed by the ide-agent extension
 * (`ide.terminal.toolbarOnSelection`); when the extension contribution is
 * unavailable the toolbar defaults to enabled.
 */
const toolbarOnSelectionSettingId = 'ide.terminal.toolbarOnSelection';

/**
 * Command invoked when the toolbar's "Add to Chat" button is clicked.
 * Implemented by the ide-agent extension. The selection text is passed
 * directly as an argument so no clipboard round-trip is needed.
 */
const addToChatCommandId = 'ide.addToChat';

/**
 * A floating toolbar shown when the user selects text in the terminal,
 * mirroring Cursor's "Toolbar on Selection" ("Show Add to Chat and Quick
 * Edit buttons"). It currently hosts a single "Add to Chat" button that
 * sends the terminal selection to the agent chat input.
 *
 * Like Cursor, this is implemented in workbench-core (not via the extension
 * API) because extensions cannot render floating widgets inside the
 * terminal panel.
 */
export class TerminalSelectionToolbarContribution extends Disposable implements ITerminalContribution {
	static readonly ID = 'terminal.selectionToolbar';

	private _xterm: (IXtermTerminal & { raw: RawXtermTerminal }) | undefined;
	private _toolbar: HTMLElement | undefined;
	// IDE-CODE (Cursor parity): Cursor anchors its floating "Add to Chat"
	// button 25px above the START of the selection. For mouse selections the
	// mousedown point is the selection start, so we track it (not mouseup).
	// REVERIFY-P3-3: the anchor carries a timestamp — a mousedown from long
	// ago (e.g. a plain click before a keyboard selection) must not anchor
	// the toolbar; only a mousedown that plausibly started this selection.
	private _lastMouseDown: { x: number; y: number; at: number } | undefined;

	constructor(
		private readonly _ctx: ITerminalContributionContext,
		@ICommandService private readonly _commandService: ICommandService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) {
		super();
		this._register(this._ctx.instance.onDidChangeSelection(() => this._updateToolbar()));
		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(toolbarOnSelectionSettingId)) {
				this._updateToolbar();
			}
		}));
	}

	xtermOpen(xterm: IXtermTerminal & { raw: RawXtermTerminal }): void {
		this._xterm = xterm;
		const element = xterm.raw.element;
		if (!element) {
			return;
		}
		// Remember where the mouse went down — for a mouse selection this is
		// the selection START, which is where Cursor anchors its toolbar
		// (25px above the start line).
		this._register(dom.addDisposableListener(element, 'mousedown', (e: MouseEvent) => {
			// REVERIFY-P3-3: only left-button drags start selections.
			if (e.button === 0) {
				this._lastMouseDown = { x: e.clientX, y: e.clientY, at: Date.now() };
			}
		}));
		// Dismiss on Escape.
		this._register(dom.addDisposableListener(element, 'keydown', (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				this._hideToolbar();
			}
		}));
		// Dismiss when the terminal loses focus. Clicking the toolbar button
		// itself doesn't blur the terminal (its mousedown is default-prevented).
		this._register(xterm.onDidChangeFocus(focused => {
			if (!focused) {
				this._hideToolbar();
			}
		}));
	}

	layout(): void {
		// Toolbar positions go stale when the terminal is resized.
		this._hideToolbar();
	}

	override dispose(): void {
		this._hideToolbar();
		this._xterm = undefined;
		super.dispose();
	}

	private _isEnabled(): boolean {
		return this._configurationService.getValue<boolean>(toolbarOnSelectionSettingId) ?? true;
	}

	private _updateToolbar(): void {
		const xterm = this._xterm;
		if (!xterm || !xterm.raw.element || !this._isEnabled()) {
			this._hideToolbar();
			return;
		}
		const text = xterm.raw.getSelection();
		if (!text || text.trim().length === 0) {
			// REVERIFY-P3-3: clear the stale mousedown anchor when there is
			// no selection — otherwise a later keyboard-driven selection
			// would anchor the toolbar at an old click point instead of
			// docking top-center.
			this._lastMouseDown = undefined;
			this._hideToolbar();
			return;
		}
		this._showToolbar();
	}

	private _showToolbar(): void {
		const instance: ITerminalInstance = this._ctx.instance;
		const wrapper = instance.domElement;
		if (!wrapper.isConnected) {
			return;
		}
		if (!this._toolbar) {
			this._createToolbar(wrapper);
		}
		const toolbar = this._toolbar!;
		toolbar.style.display = 'block';
		// Measure while visible, then place 25px above the selection start
		// (Cursor parity). Falls back below the start point when there is
		// not enough room above.
		//
		// REVERIFY-P3-4 (accepted divergence): on a REVERSE drag (bottom-to-
		// top) the mousedown is at the visual END of the selection, so the
		// toolbar may overlap the selected text's lower edge. xterm.js does
		// not expose the selection's visual bounds through the public API
		// available here (getSelectionPosition is not in our type surface),
		// so we cannot reliably detect drag direction. Forward drags (the
		// common case) position correctly.
		const toolbarWidth = toolbar.offsetWidth;
		const toolbarHeight = toolbar.offsetHeight;
		const wrapperRect = wrapper.getBoundingClientRect();
		// REVERIFY-P3-3: only use the mousedown anchor if it's fresh (within
		// 2s) — an old click before a keyboard selection must dock top-center.
		const anchor = this._lastMouseDown && Date.now() - this._lastMouseDown.at < 2000
			? this._lastMouseDown
			: undefined;
		let left: number;
		let top: number;
		if (anchor) {
			const x = anchor.x - wrapperRect.left;
			const y = anchor.y - wrapperRect.top;
			left = x - toolbarWidth / 2;
			top = y - toolbarHeight - 25;
			if (top < 0) {
				top = y + 5;
			}
		} else {
			// Keyboard-driven selection: dock at the top center.
			left = (wrapperRect.width - toolbarWidth) / 2;
			top = 8;
		}
		left = Math.max(4, Math.min(left, wrapperRect.width - toolbarWidth - 4));
		top = Math.max(4, Math.min(top, wrapperRect.height - toolbarHeight - 4));
		toolbar.style.left = `${Math.round(left)}px`;
		toolbar.style.top = `${Math.round(top)}px`;
	}

	private _createToolbar(wrapper: HTMLElement): void {
		// The toolbar is absolutely positioned; make sure the wrapper
		// establishes a positioning context.
		if (dom.getComputedStyle(wrapper).position === 'static') {
			wrapper.style.position = 'relative';
		}
		const toolbar = document.createElement('div');
		toolbar.classList.add('terminal-selection-toolbar');
		toolbar.setAttribute('role', 'toolbar');
		const button = document.createElement('button');
		button.classList.add('terminal-selection-toolbar-button');
		button.textContent = localize('terminal.selectionToolbar.addToChat', "Add to Chat");
		button.title = localize('terminal.selectionToolbar.addToChat.tooltip', "Add the terminal selection to chat");
		// Keep focus inside the terminal so clicking the button doesn't
		// dismiss the toolbar via the focus-loss handler before click fires.
		button.addEventListener('mousedown', e => e.preventDefault());
		button.addEventListener('click', (e: MouseEvent) => this._onAddToChat(e.ctrlKey || e.metaKey));
		toolbar.appendChild(button);
		toolbar.style.display = 'none';
		wrapper.appendChild(toolbar);
		this._toolbar = toolbar;
		this._register(toDisposable(() => {
			toolbar.remove();
			if (this._toolbar === toolbar) {
				this._toolbar = undefined;
			}
		}));
	}

	private _hideToolbar(): void {
		if (this._toolbar) {
			this._toolbar.style.display = 'none';
		}
	}

	private _onAddToChat(newChat: boolean): void {
		const text = this._xterm?.raw.getSelection();
		this._hideToolbar();
		if (!text || text.trim().length === 0) {
			return;
		}
		// Executing the command activates the ide-agent extension on demand,
		// so it doesn't need to be active yet. Ctrl/Cmd+click opens the
		// selection in a NEW composer (Cursor parity).
		this._commandService.executeCommand(addToChatCommandId, { source: 'terminal', text, ...(newChat ? { newChat: true } : {}) });
	}
}
