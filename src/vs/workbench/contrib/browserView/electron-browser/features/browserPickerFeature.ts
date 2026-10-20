/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../../nls.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { Action2, registerAction2, MenuId } from '../../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { BrowserElementSelectionMode, IBrowserElementSelectionOptions } from '../../../../../platform/browserView/common/browserView.js';
import { ChatContextKeys } from '../../../chat/common/actions/chatContextKeys.js';
import { BrowserEditor, BROWSER_EDITOR_ACTIVE, BrowserActionCategory, CONTEXT_BROWSER_HAS_ERROR, CONTEXT_BROWSER_HAS_URL, BrowserActionGroup } from '../browserEditor.js';
import { CONTEXT_BROWSER_ELEMENT_SELECTION_MODE } from './browserEditorChatFeatures.js';

/**
 * DEV-GAPS-94B (`browser-tab-picker-toggle`): native-tab toolbar toggle
 * 'Select element' (Cursor 3.25.9 parity).
 *
 * Evidence (Tier-1 — live CDP + binary, re-verified 2026-10-20):
 *  - `docs/rea/detail-browser-2026-10-19.md:40`: `.browser-tools` button
 *    `title="Select element"`, `class="tool-button blue"` + `active` when
 *    picker ON (codicon-inspect); live click adds/removes `active`.
 *  - Binary `workbench.desktop.main.js` @21191350: template
 *    `<div class=browser-tools><button title="Select element"><i></i></button><button><i>`
 *    — the picker is the FIRST `.browser-tools` button, its icon an
 *    icon-font `<i>`; @21183867 its class is computed as
 *    `` `tool-button blue ${... ? "active" : ""}` `` and the `<i>` gets
 *    `asClassName(Oe.inspect)`; the console toggle is its sibling.
 *  - Click handler @21176331: when ON → `{type:"disable-element-selection"}`;
 *    when OFF → analytics `browser.selectElementClick` +
 *    `{type:"enable-element-selection", selectionType:"composer-chat"}`.
 *    Same template/handler in `workbench.glass.main.js` @22616132.
 *
 * Fork mapping (same layer as Cursor: the NATIVE browser tab's own
 * toolbar, NOT the legacy webview tab — the webview stopgap in
 * extensions/ide-agent/src/browser/tabView.ts only had its button title
 * aligned to the verbatim 'Select element'):
 *  - The button lives in `MenuId.BrowserActionsToolbar` (Tools group,
 *    order 0 — Cursor's picker precedes the console toggle at order 1),
 *    rendered by the shared workbench toolbar with
 *    `highlightToggledItems` — the fork's equivalent of Cursor's
 *    `blue active` React class (same mapping DEV-GAPS-73 used for the
 *    console toggle).
 *  - The toggled state is the exact context key the existing
 *    AddElementToChatAction uses: element-selection mode == Select.
 *  - Running it performs the same model call as AddElementToChatAction
 *    (`model.toggleElementSelection(<on>, { mode: Select })`) — the
 *    fork's equivalent of Cursor's enable/disable-element-selection
 *    messages; picked elements then flow to chat via
 *    BrowserEditorChatIntegration (selectionType "composer-chat").
 *
 * HONEST-DIVERGENCE: none for the toggle itself. The command is
 * toolbar-only (no `f1`): Cursor evidences no command-palette entry for
 * the picker — the palette-reachable entry stays AddElementToChatAction.
 */
export class SelectElementAction extends Action2 {
	static readonly ID = 'workbench.action.browser.selectElement';

	constructor() {
		super({
			id: SelectElementAction.ID,
			title: localize2('browser.selectElementAction', 'Select element'),
			tooltip: localize('browser.selectElementTooltip', 'Select element'),
			category: BrowserActionCategory,
			icon: Codicon.inspect,
			precondition: ContextKeyExpr.and(BROWSER_EDITOR_ACTIVE, CONTEXT_BROWSER_HAS_URL, CONTEXT_BROWSER_HAS_ERROR.negate(), ChatContextKeys.enabled),
			toggled: CONTEXT_BROWSER_ELEMENT_SELECTION_MODE.isEqualTo(BrowserElementSelectionMode.Select),
			menu: {
				id: MenuId.BrowserActionsToolbar,
				group: BrowserActionGroup.Tools,
				order: 0,
				when: ChatContextKeys.enabled
			},
		});
	}

	run(accessor: ServicesAccessor, argument?: IBrowserElementSelectionOptions | BrowserEditor): void {
		const browserEditor = argument instanceof BrowserEditor ? argument : accessor.get(IEditorService).activeEditorPane;
		if (browserEditor instanceof BrowserEditor) {
			browserEditor.ensureBrowserFocus();
			const model = browserEditor.model;
			if (model) {
				const options = argument instanceof BrowserEditor ? undefined : argument;
				const isActiveMode = model.elementSelectionState.active && model.elementSelectionState.options.mode !== BrowserElementSelectionMode.Comment;
				void model.toggleElementSelection(!isActiveMode, { ...options, continuous: false, mode: BrowserElementSelectionMode.Select });
			}
		}
	}
}

registerAction2(SelectElementAction);
