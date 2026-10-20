/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../../nls.js';
import { $, addDisposableListener, EventType } from '../../../../../base/browser/dom.js';
import { IntervalTimer } from '../../../../../base/common/async.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { RawContextKey, IContextKey, IContextKeyService, ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { Action2, registerAction2, MenuId } from '../../../../../platform/actions/common/actions.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { BrowserViewCommandId } from '../../../../../platform/browserView/common/browserView.js';
import { IBrowserViewModel } from '../../common/browserView.js';
import { BrowserEditor, BrowserEditorContribution, BrowserWidgetLocation, BROWSER_EDITOR_ACTIVE, BrowserActionCategory, CONTEXT_BROWSER_HAS_ERROR, CONTEXT_BROWSER_HAS_URL, BrowserActionGroup, IBrowserEditorWidget } from '../browserEditor.js';

/**
 * DEV-GAPS-73 (`browser-tab-console-toggle`): native-tab toolbar toggle
 *  'Show Console' ⇄ 'Hide Console' (Cursor 3.25.9 parity).
 *
 * Evidence (Tier-1 — live CDP + binary, verified 2026-10-19):
 *  - `docs/rea/detail-browser-2026-10-19.md:41`: `.browser-tools` button
 *    `title="Show Console"` ⇄ `"Hide Console"` on toggle, codicon-terminal;
 *    "Class becomes `blue active` when open."
 *  - `docs/rea/dig-browser-menu-2026-10-19.md:31`: the console toggle is a
 *    toolbar sibling of the inspect/element-picker toggle and the "..."
 *    menu (distinct from the docked-DevTools toggle, whose parity slot in
 *    this fork is `ToggleDevToolsAction` in browserDevToolsFeature.ts).
 *
 * Fork mapping (same layer as Cursor: the NATIVE browser tab's own chrome,
 * NOT the legacy webview tab):
 *  - The button lives in `MenuId.BrowserActionsToolbar` (the navbar's
 *    tools group), rendered by the shared workbench toolbar with
 *    `highlightToggledItems` — the fork's equivalent of Cursor's
 *    `blue active` React class: the toggled highlight is the `.checked`
 *    state every other fork browser toggle (DevTools, picker) uses.
 *  - The tooltip switch (Show ⇄ Hide) is driven by the Action2 `toggled`
 *     descriptor (MenuItem2Action swaps `action.tooltip` when the
 *     `browserConsoleOpen` context key holds) — verbatim strings.
 *  - Opening shows an in-tab console panel (a browser-editor contribution
 *     widget stacked under the navbar, same widget location the find /
 *     emulation toolbars use) listing the page's captured console
 *     messages. The capture is real: the main process records
 *     `webContents` `console-message` events per view (capped at 1000,
 *     cleared per page) and `model.getConsoleLogs()` returns them — the
 *     same data the agent-facing `getConsoleLogs` backend command uses.
 *  - Panel details beyond the toolbar button (header, refresh, close)
 *     are fork chrome; Cursor does not evidence a custom header for its
 *     console — the panel body is kept to a plain log list.
 *
 * HONEST-DIVERGENCES:
 *  - The panel docks UNDER the navbar (fork Toolbar widget location);
 *     Cursor's exact console anchoring is not in the REA evidence, so
 *     no position claim is made.
 *  - Log refresh is a 2s poll while open (the model exposes no
 *     onDidChange event for console messages) plus an immediate fetch on
 *     open and on every navigation.
 */
export const CONTEXT_BROWSER_CONSOLE_OPEN = new RawContextKey<boolean>('browserConsoleOpen', false, localize('browser.consoleOpen', "Whether the console panel is open for the current browser view"));

export class BrowserEditorConsoleContribution extends BrowserEditorContribution {
	private readonly _consoleOpenContext: IContextKey<boolean>;
	private readonly _element = $('.browser-console-panel');
	private readonly _logElement = $('.browser-console-log');
	private readonly _widget: IBrowserEditorWidget;
	private readonly _pollTimer = new IntervalTimer();
	private _open = false;

	constructor(
		editor: BrowserEditor,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super(editor);
		this._consoleOpenContext = CONTEXT_BROWSER_CONSOLE_OPEN.bindTo(contextKeyService);
		this._register(this._pollTimer);

		this._element.style.display = 'none';

		// Header: label + refresh/close affordances (fork chrome, kept
		// minimal — the evidence only pins the toolbar button itself).
		const header = $('.browser-console-header');
		const title = $('.browser-console-title');
		title.appendChild(renderIcon(Codicon.terminal));
		const titleText = document.createElement('span');
		titleText.textContent = localize('browser.consoleTitle', "Console");
		title.appendChild(titleText);
		header.appendChild(title);

		const actions = $('.browser-console-actions');
		const refreshButton = document.createElement('button');
		refreshButton.className = 'browser-console-button';
		refreshButton.title = localize('browser.consoleRefresh', "Refresh");
		refreshButton.setAttribute('aria-label', localize('browser.consoleRefreshLabel', "Refresh console logs"));
		refreshButton.appendChild(renderIcon(Codicon.refresh));
		this._register(addDisposableListener(refreshButton, EventType.CLICK, () => void this.refreshLogs()));
		actions.appendChild(refreshButton);

		const closeButton = document.createElement('button');
		closeButton.className = 'browser-console-button';
		closeButton.title = localize('browser.consoleHideLabel', "Hide Console");
		closeButton.setAttribute('aria-label', localize('browser.consoleHideLabel', "Hide Console"));
		closeButton.appendChild(renderIcon(Codicon.close));
		this._register(addDisposableListener(closeButton, EventType.CLICK, () => this.hideConsole()));
		actions.appendChild(closeButton);
		header.appendChild(actions);

		this._element.appendChild(header);
		this._element.appendChild(this._logElement);
		this._widget = { location: BrowserWidgetLocation.Toolbar, element: this._element, order: 1 };
	}

	override get widgets(): readonly IBrowserEditorWidget[] {
		return [this._widget];
	}

	get isOpen(): boolean {
		return this._open;
	}

	protected override onModelAttached(model: IBrowserViewModel, store: DisposableStore): void {
		// The main process clears captured logs on every navigation —
		// refetch so the open panel never shows the previous page's log.
		store.add(model.onDidNavigate(() => {
			if (this._open) {
				void this.refreshLogs();
			}
		}));
		if (this._open) {
			void this.refreshLogs();
		}
	}

	override onModelDetached(): void {
		this._pollTimer.cancel();
	}

	/** Open the panel, fetch the current page's logs and start polling. */
	async showConsole(): Promise<void> {
		if (this._open) {
			return;
		}
		this._open = true;
		this._consoleOpenContext.set(true);
		this._element.style.display = '';
		// The panel takes vertical space above the WebContentsView — the
		// editor sizes that view from DOM bounds, so re-layout (find does
		// the same on height change).
		this.editor.layoutBrowserContainer();
		await this.refreshLogs();
		this._pollTimer.cancelAndSet(() => void this.refreshLogs(), 2000);
	}

	/** Hide the panel and stop polling. */
	hideConsole(): void {
		if (!this._open) {
			return;
		}
		this._open = false;
		this._consoleOpenContext.reset();
		this._pollTimer.cancel();
		this._element.style.display = 'none';
		this.editor.layoutBrowserContainer();
	}

	async toggleConsole(): Promise<void> {
		if (this._open) {
			this.hideConsole();
		} else {
			await this.showConsole();
		}
	}

	/** Re-render the log body from the model's captured console logs. */
	async refreshLogs(): Promise<void> {
		const model = this.editor.model;
		if (!model) {
			this._logElement.textContent = '';
			return;
		}
		const logs = await model.getConsoleLogs();
		const wasAtBottom = this._logElement.scrollTop + this._logElement.clientHeight >= this._logElement.scrollHeight - 4;
		this._logElement.textContent = logs;
		if (wasAtBottom) {
			this._logElement.scrollTop = this._logElement.scrollHeight;
		}
	}
}

BrowserEditor.registerContribution(BrowserEditorConsoleContribution);

export class ToggleBrowserConsoleAction extends Action2 {
	static readonly ID = BrowserViewCommandId.ToggleConsole;

	constructor() {
		super({
			id: ToggleBrowserConsoleAction.ID,
			title: localize2('browser.toggleConsoleAction', 'Show Console'),
			tooltip: localize('browser.toggleConsoleTooltip', 'Show Console'),
			category: BrowserActionCategory,
			icon: Codicon.terminal,
			f1: true,
			precondition: ContextKeyExpr.and(BROWSER_EDITOR_ACTIVE, CONTEXT_BROWSER_HAS_URL, CONTEXT_BROWSER_HAS_ERROR.negate()),
			toggled: {
				condition: ContextKeyExpr.equals(CONTEXT_BROWSER_CONSOLE_OPEN.key, true),
				// ICommandActionToggleInfo.title is a plain string (the
				// registry unwraps .value at runtime when present).
				title: localize('browser.toggleConsoleActionToggled', 'Hide Console'),
				tooltip: localize('browser.toggleConsoleTooltipToggled', 'Hide Console'),
			},
			menu: {
				id: MenuId.BrowserActionsToolbar,
				group: BrowserActionGroup.Tools,
				order: 1,
			},
		});
	}

	async run(accessor: ServicesAccessor, browserEditor = accessor.get(IEditorService).activeEditorPane): Promise<void> {
		if (browserEditor instanceof BrowserEditor) {
			await browserEditor.getContribution(BrowserEditorConsoleContribution)?.toggleConsole();
		}
	}
}

registerAction2(ToggleBrowserConsoleAction);
