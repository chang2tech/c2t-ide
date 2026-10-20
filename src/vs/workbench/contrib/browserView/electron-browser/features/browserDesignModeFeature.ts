/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Design Mode — the browser-tab pill that hosts the P2 design-mode tools.
 *
 * REA spec: Cursor's Design Mode is toggled from the command palette
 * ("Toggle Design Mode", keywords design/mode/browser/annotate, pen-nib icon)
 * and shows a pill in the browser tab (harvest-design-mode-annotations-ui-2026-10-20.md,
 * Finding 2/3/4). Toggle shortcut per docs evidence: Cmd/Ctrl+Shift+D
 * (deep-docs-all.md "Design Mode — complete").
 *
 * This contribution owns the pill container and the active state; the voice
 * (design-mode-voice) and drawing (design-mode-drawing) features mount their
 * tool buttons into {@link BrowserDesignModeContribution.pillTools}.
 */

import { $, addDisposableListener, EventType } from '../../../../../base/browser/dom.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ContextKeyExpr, IContextKey, IContextKeyService, RawContextKey } from '../../../../../platform/contextkey/common/contextkey.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { KeyMod, KeyCode } from '../../../../../base/common/keyCodes.js';
import { KeybindingWeight } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { BrowserEditor, BrowserEditorContribution, BrowserWidgetLocation, IBrowserEditorWidget, BrowserActionCategory } from '../browserEditor.js';
import { BrowserEditorInput } from '../../common/browserEditorInput.js';
import {
	BROWSER_DESIGN_MODE_ACTIVE_CONTEXT_KEY,
	DESIGN_MODE_TITLE,
	ENTER_DESIGN_MODE_ARIA_LABEL,
	EXIT_DESIGN_MODE_ARIA_LABEL,
	EXIT_DESIGN_MODE_TITLE,
	ToggleBrowserDesignModeCommandId,
	designModeToggleAffordance,
} from '../../common/browserDesignMode.js';

export const CONTEXT_BROWSER_DESIGN_MODE_ACTIVE = new RawContextKey<boolean>(
	BROWSER_DESIGN_MODE_ACTIVE_CONTEXT_KEY,
	false,
	localize('browser.designModeActive', "Whether Design Mode is active in the browser editor")
);

/** `activeEditor` is the browser editor (mirrors browserEditorChatFeatures' local const). */
const BROWSER_EDITOR_ACTIVE = ContextKeyExpr.equals('activeEditor', BrowserEditorInput.EDITOR_ID);

/**
 * Per-editor Design Mode state. The pill (label + tool mount point) is always
 * mounted at {@link BrowserWidgetLocation.PostUrl} and shown/hidden with the state.
 */
export class BrowserDesignModeContribution extends BrowserEditorContribution {
	private readonly _activeContext: IContextKey<boolean>;
	private readonly _onDidChangeActive = this._register(new Emitter<boolean>());
	/** Fires when Design Mode is toggled. */
	readonly onDidChangeActive: Event<boolean> = this._onDidChangeActive.event;

	private _isActive = false;
	/** Whether Design Mode is currently active for this editor. */
	get isActive(): boolean { return this._isActive; }

	private readonly _pill: HTMLElement;
	private readonly _pillTools: HTMLElement;
	/** Mount point for design-mode tool buttons (voice mic, drawing tools). */
	get pillTools(): HTMLElement { return this._pillTools; }

	/**
	 * Enter/exit toggle UI (design-mode-enter-exit; binary evidence in
	 * common/browserDesignMode.ts). Inactive: a standalone enter button
	 * (aria-label "Enter design mode", tooltip "Design Mode"). Active: the
	 * pill carries an exit button (aria-label "Exit design mode", tooltip
	 * "Exit Design Mode").
	 */
	private readonly _enterButton: HTMLButtonElement;

	constructor(
		editor: BrowserEditor,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super(editor);
		this._activeContext = CONTEXT_BROWSER_DESIGN_MODE_ACTIVE.bindTo(contextKeyService);

		// Enter button (inactive state). HONEST-DIVERGENCE: the binary icon
		// is "pen-nib" (Cursor glass icon set, absent from the fork's
		// codicons); Codicon.pencil is the fork's closest icon, the same
		// substitute the palette action below already uses.
		this._enterButton = document.createElement('button');
		this._enterButton.type = 'button';
		this._enterButton.className = 'browser-design-mode-enter-button';
		this._enterButton.setAttribute('aria-label', ENTER_DESIGN_MODE_ARIA_LABEL);
		this._enterButton.title = DESIGN_MODE_TITLE;
		const enterIcon = document.createElement('span');
		enterIcon.className = ThemeIcon.asClassName(Codicon.pencil);
		enterIcon.setAttribute('aria-hidden', 'true');
		this._enterButton.appendChild(enterIcon);
		this._register(addDisposableListener(this._enterButton, EventType.CLICK, () => this.setActive(true)));

		this._pill = $('.browser-design-mode-pill');
		const label = $('.browser-design-mode-pill-label');
		label.textContent = localize('browser.designModePill', "Design Mode");
		this._pillTools = $('.browser-design-mode-pill-tools');
		this._pill.appendChild(label);
		this._pill.appendChild(this._pillTools);

		// Exit button (active state, last item in the pill). The binary's
		// exit icon is "x"/close; Codicon.close is the fork's verbatim name.
		const exitButton = document.createElement('button');
		exitButton.type = 'button';
		exitButton.className = 'browser-design-mode-exit-button';
		exitButton.setAttribute('aria-label', EXIT_DESIGN_MODE_ARIA_LABEL);
		exitButton.title = EXIT_DESIGN_MODE_TITLE;
		const exitIcon = document.createElement('span');
		exitIcon.className = ThemeIcon.asClassName(Codicon.close);
		exitIcon.setAttribute('aria-hidden', 'true');
		exitButton.appendChild(exitIcon);
		this._register(addDisposableListener(exitButton, EventType.CLICK, () => this.setActive(false)));
		this._pill.appendChild(exitButton);

		this._applyAffordanceVisibility();
		// Clicking the pill label toggles design mode; tool-button clicks must not bubble here.
		this._register(addDisposableListener(this._pill, EventType.CLICK, e => {
			if ((e.target as HTMLElement).closest('button')) {
				return;
			}
			this.toggle();
		}));
	}

	/** Toggle Design Mode for this editor. */
	toggle(): void {
		this.setActive(!this._isActive);
	}

	/** Set Design Mode state for this editor. */
	setActive(active: boolean): void {
		if (this._isActive === active) {
			return;
		}
		this._isActive = active;
		this._activeContext.set(active);
		this._applyAffordanceVisibility();
		this._onDidChangeActive.fire(active);
	}

	/** Show exactly one toggle affordance for the current state (see designModeToggleAffordance). */
	private _applyAffordanceVisibility(): void {
		const affordance = designModeToggleAffordance(this._isActive);
		this._enterButton.classList.toggle('hidden', !affordance.showEnterButton);
		this._pill.classList.toggle('hidden', !affordance.showActivePill);
	}

	override get widgets(): readonly IBrowserEditorWidget[] {
		return [
			{ location: BrowserWidgetLocation.PostUrl, element: this._enterButton, order: 39 },
			{ location: BrowserWidgetLocation.PostUrl, element: this._pill, order: 40 },
		];
	}
}

BrowserEditor.registerContribution(BrowserDesignModeContribution);

/** Command palette toggle — mirrors Cursor's "Toggle Design Mode" command. */
class ToggleBrowserDesignModeAction extends Action2 {
	static readonly ID = ToggleBrowserDesignModeCommandId;

	constructor() {
		super({
			id: ToggleBrowserDesignModeAction.ID,
			title: localize2('browser.toggleDesignMode', "Toggle Design Mode"),
			category: BrowserActionCategory,
			icon: Codicon.pencil,
			f1: true,
			precondition: BROWSER_EDITOR_ACTIVE,
			toggled: CONTEXT_BROWSER_DESIGN_MODE_ACTIVE,
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyD,
				weight: KeybindingWeight.WorkbenchContrib,
				when: BROWSER_EDITOR_ACTIVE,
			},
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const editor = accessor.get(IEditorService).activeEditorPane;
		if (editor instanceof BrowserEditor) {
			editor.getContribution(BrowserDesignModeContribution)?.toggle();
		}
	}
}

registerAction2(ToggleBrowserDesignModeAction);
