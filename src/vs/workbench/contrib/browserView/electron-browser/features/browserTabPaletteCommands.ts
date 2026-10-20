/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Cursor-parity palette commands for the native browser tab:
 * "New Browser Tab" / "Reload Browser Tab" / "Focus Browser Location Bar"
 * (DEV-GAPS-107), plus the two remaining actions of the same binary
 * registration cluster: "Open Browser" and "Open cursor.com in Browser"
 * (DEV-GAPS-113).
 *
 * BINARY EVIDENCE (Cursor 3.25.9, DEV-GAPS-107, re-extracted from
 * workbench.desktop.main.js; the three Action2 classes sit consecutively in
 * one registration cluster right after `workbench.action.openBrowserEditor`):
 *
 * - @21205469 NewBrowserTabAction:
 *   `{id:"workbench.action.newBrowserTab", title:"New Browser Tab",
 *     category:View, f1:!0, precondition:wTt,
 *     keybinding:{primary:CtrlCmd|KeyT, weight:500, when:activeEditor == BrowserEditorID}}`
 *   Desktop run(): if the arg's `sourceBrowserId` matches an open browser
 *   editor, the new input opens in that editor's group; otherwise the default
 *   group. Creates a fresh browser input (uuid) and opens it `{pinned:!0}`.
 *   (The glass branch — `glass.openBrowserTab` with focusOmnibar — and the
 *   `browser.editor.opened` analytics event have no fork equivalent; the fork
 *   has no glass shell. Creation itself goes through the same workbench
 *   service path as the fork's `cursor.browserView.newTab` command.)
 * - @21206477 ReloadBrowserTabAction:
 *   `{id:"workbench.action.reloadBrowserTab", title:"Reload Browser Tab",
 *     category:View, f1:!0, precondition:wTt,
 *     keybinding:{primary:CtrlCmd|KeyR, weight:600, when:activeEditor == BrowserEditorID}}`
 *   run(): `activeEditor instanceof BrowserEditorInput &&
 *     executeCommand("cursor.browserView.reload", activeEditor.browserId)`.
 * - @21206895 FocusBrowserLocationBarAction:
 *   `{id:"workbench.action.focusBrowserLocationBar",
 *     title:"Focus Browser Location Bar", category:View, f1:!0,
 *     precondition:wTt,
 *     keybinding:{primary:CtrlCmd|KeyL, weight:600,
 *       when:and(activeEditor == BrowserEditorID, !sideBarFocus, !panelFocus,
 *       !auxiliaryBarFocus)}}`
 *   run(): `browserViewStore.requestFocusUrlBar(activeEditor.browserId)`,
 *   which fires an event (@40732973); the editor pane's listener (@21172511)
 *   enters URL-edit mode and calls `focus()` + `select()` on the URL input.
 *
 * Symbol resolution (also re-extracted): `wTt` @19193643 is
 * `ContextKeyExpr.equals('cursor.browserTabEnabled', true)` (RawContextKey
 * default false); the binary's BrowserEditorID @21200867 is
 * `'workbench.editor.browserEditor'`.
 *
 * FORK MAPPING / HONEST DIVERGENCES:
 * - Editor id: the fork's browser editor id is `'workbench.editor.browser'`
 *   (BrowserViewEditorId); the `when` clauses use the existing
 *   BROWSER_EDITOR_ACTIVE expression (activeEditor == that id).
 * - Precondition: the fork has NO `cursor.browserTabEnabled` context key or
 *   setting (grep: 0 hits tree-wide) and its integrated browser is always
 *   available, so the binary precondition is intentionally NOT copied — with
 *   the key absent it would disable the commands forever. Gating therefore
 *   comes from the keybinding `when` clauses (verbatim) and from the handlers
 *   no-oping when the active editor is not a browser editor, which matches
 *   the binary's behavior whenever the feature is enabled.
 * - Weights 500/600 are the binary's raw keybinding weights, kept verbatim;
 *   they outrank the upstream browser actions' Ctrl+T/Ctrl+R/Ctrl+L bindings
 *   (WorkbenchContrib+50/+75/+0) while a browser editor is active — the same
 *   resolution the binary gets from these weights.
 * - New tab group placement: the binary resolves `sourceBrowserId` to the
 *   group containing that editor and falls back to the default group. The
 *   fork service's `parentViewId` places the tab in the parent's group but
 *   refuses to open when the parent is not open, so the action only passes
 *   `parentViewId` when a group actually contains the source editor —
 *   reproducing the binary's fallback.
 * - Focus: there is no browserViewStore event bus in the fork; the action
 *   calls the active BrowserEditor's navigation contribution directly
 *   (`focusUrlInput()` = focus + select-all on the URL display), which is
 *   exactly what the binary's pane listener does.
 * - The upstream fork actions `workbench.action.browser.newTab` /
 *   `.reload` / `.focusUrlInput` (titles "New Tab" / "Reload" /
 *   "Focus URL Input", Browser category) are separate upstream commands and
 *   are left untouched; these Cursor-id actions are additive, with distinct
 *   ids, titles and category, so no palette row is duplicated.
 *
 * DEV-GAPS-113 — the remaining two actions of the same binary cluster
 * (re-extracted from the same bundle):
 *
 * - @21203889 OpenBrowserEditorAction (class D9o/AZm):
 *   `{id:"workbench.action.openBrowserEditor", title:"Open Browser",
 *     category:View, f1:!1,
 *     menu:[{id:MenubarAppearanceMenu, group:"1_toggle_view", order:4,
 *       when:wTt}]}` (ID assignment @21205329).
 *   NO precondition, NO keybinding, NO icon — `wTt` appears only as the
 *   menu item's `when`. `f1:!1` = false: deliberately NOT in the palette;
 *   it is the programmatic open entry point other commands delegate to.
 *   Desktop run(accessor, options): `url` is taken only when
 *   `typeof options.url === "string"`; `inactive = options.inactive ?? false`;
 *   `preserveFocus = options.preserveFocus ?? inactive`;
 *   `browserId = options.browserId ?? uuid()`; when `inactive && url` the
 *   view is created eagerly and navigated before opening; the input
 *   `BrowserEditorInput(browserId, url, transient)` is then opened via
 *   `editorService.openEditor(input, {pinned:!0,
 *     revealIfOpened:!preserveFocus && !inactive,
 *     revealIfVisible:!preserveFocus && !inactive,
 *     preserveFocus:preserveFocus || inactive, inactive}, ACTIVE_GROUP)`
 *   (the binary's trailing group constant is -1 = ACTIVE_GROUP, @2880390).
 * - @21207269 OpenCursorWebsiteAction (class F9o/PZm):
 *   `{id:"cursor.openCursorWebsite", title:"Open cursor.com in Browser",
 *     category:View, f1:!0, precondition:wTt}` (ID assignment @21207692).
 *   run(): resolves
 *   `getDynamicConfigParam("browser_default_url_config", "defaultUrl")
 *     ?? "https://cursor.com"`, uses it only when its URL origin is
 *   `"https://cursor.com"` (otherwise falls back to `"https://cursor.com"`),
 *   then delegates: `executeCommand("workbench.action.openBrowserEditor",
 *   {url})`.
 *
 * FORK MAPPING / HONEST DIVERGENCES (GAPS-113):
 * - Precondition/menu-when: `openCursorWebsite` carries the same `wTt`
 *   precondition as the GAPS-107 three and `openBrowserEditor`'s menu item
 *   carries it as `when`; per the GAPS-107 decision the fork does NOT copy
 *   either (no `cursor.browserTabEnabled` key exists in the fork — the
 *   commands/menu would be dead forever). The menu item itself
 *   (MenubarAppearanceMenu / "1_toggle_view" / order 4) is kept verbatim.
 * - Open handler: the fork's `BrowserEditorInput` cannot be constructed
 *   directly the way the binary does (it takes an options object plus a
 *   model resolver), so the action goes through the same fork service path
 *   as NewBrowserTabAction above: `createBrowserView` with `initialUrl`,
 *   opened `{pinned:true, preserveFocus:preserveFocus || inactive,
 *   background:inactive}` (`background` is the service's spelling of the
 *   editor `inactive` flag). Caller-supplied `browserId` and the binary's
 *   `transient`, `designMode`, `reuseExistingUrlTab`, `trackingId`
 *   (analytics + URL-open toast) and glass-branch options have no fork
 *   equivalent and are not honored; `revealIfOpened`/`revealIfVisible`
 *   have no counterpart in the fork's editor-open options. The service
 *   always resolves the view model eagerly, where the binary only does so
 *   for `inactive && url`; the user-visible result is the same.
 * - Website URL: the fork has no dynamic-config service
 *   (`getDynamicConfigParam` / `browser_default_url_config`: 0 hits in the
 *   fork's browserView contrib and platform layers), so the action always
 *   uses the binary's verbatim fallback `"https://cursor.com"` and still
 *   delegates to `workbench.action.openBrowserEditor` exactly like the
 *   binary — it never opens an external browser itself.
 */

import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { localize2 } from '../../../../../nls.js';
import { Categories } from '../../../../../platform/action/common/actionCommonCategories.js';
import { Action2, MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { BrowserViewStorageScope } from '../../../../../platform/browserView/common/browserView.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IBrowserViewWorkbenchService } from '../../common/browserView.js';
import { BrowserEditorInput } from '../../common/browserEditorInput.js';
import { AuxiliaryBarFocusContext, PanelFocusContext, SidebarFocusContext } from '../../../../common/contextkeys.js';
import { IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { BROWSER_EDITOR_ACTIVE, BrowserEditor } from '../browserEditor.js';
import { BrowserNavigationFeatures } from './browserNavigationFeatures.js';

export class NewBrowserTabAction extends Action2 {
	static readonly ID = 'workbench.action.newBrowserTab';

	constructor() {
		super({
			id: NewBrowserTabAction.ID,
			title: localize2('browser.newBrowserTabAction', "New Browser Tab"),
			category: Categories.View,
			f1: true,
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyCode.KeyT,
				weight: 500,
				when: BROWSER_EDITOR_ACTIVE,
			}
		});
	}

	async run(accessor: ServicesAccessor, options?: { sourceBrowserId?: unknown }): Promise<void> {
		const browserViewService = accessor.get(IBrowserViewWorkbenchService);
		const editorGroupsService = accessor.get(IEditorGroupsService);

		// Binary: a `sourceBrowserId` arg selects the group that contains
		// that browser editor; no match -> default group. Only forward the
		// id as parentViewId when such a group exists (see header note).
		let parentViewId: string | undefined;
		if (typeof options?.sourceBrowserId === 'string') {
			const sourceBrowserId = options.sourceBrowserId;
			for (const group of editorGroupsService.groups) {
				if (group.editors.some(editor => editor instanceof BrowserEditorInput && editor.id === sourceBrowserId)) {
					parentViewId = sourceBrowserId;
					break;
				}
			}
		}

		await browserViewService.createBrowserView(
			{
				owner: { type: 'user' },
				session: { scope: BrowserViewStorageScope.Ephemeral },
				initialAudiences: [],
			},
			{
				pinned: true,
				parentViewId,
			}
		);
	}
}

export class ReloadBrowserTabAction extends Action2 {
	static readonly ID = 'workbench.action.reloadBrowserTab';

	constructor() {
		super({
			id: ReloadBrowserTabAction.ID,
			title: localize2('browser.reloadBrowserTabAction', "Reload Browser Tab"),
			category: Categories.View,
			f1: true,
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyCode.KeyR,
				weight: 600,
				when: BROWSER_EDITOR_ACTIVE,
			}
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const activeEditor = editorService.activeEditor;
		if (activeEditor instanceof BrowserEditorInput) {
			// Binary delegates verbatim to this command (registered by the
			// DEV-GAPS-54 command surface: hard reload + await load).
			await accessor.get(ICommandService).executeCommand('cursor.browserView.reload', activeEditor.id);
		}
	}
}

export class FocusBrowserLocationBarAction extends Action2 {
	static readonly ID = 'workbench.action.focusBrowserLocationBar';

	constructor() {
		super({
			id: FocusBrowserLocationBarAction.ID,
			title: localize2('browser.focusBrowserLocationBarAction', "Focus Browser Location Bar"),
			category: Categories.View,
			f1: true,
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyCode.KeyL,
				weight: 600,
				when: ContextKeyExpr.and(
					BROWSER_EDITOR_ACTIVE,
					SidebarFocusContext.negate(),
					PanelFocusContext.negate(),
					AuxiliaryBarFocusContext.negate(),
				),
			}
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const activeEditorPane = editorService.activeEditorPane;
		if (activeEditorPane instanceof BrowserEditor) {
			// Fork equivalent of the binary's requestFocusUrlBar event: the
			// navigation contribution focuses the URL display and selects
			// its contents (cf. the binary pane listener's focus()+select()).
			activeEditorPane.getContribution(BrowserNavigationFeatures)?.focusUrlInput();
		}
	}
}

export interface IOpenBrowserEditorOptions {
	readonly url?: unknown;
	readonly inactive?: boolean;
	readonly preserveFocus?: boolean;
}

export class OpenBrowserEditorAction extends Action2 {
	static readonly ID = 'workbench.action.openBrowserEditor';

	constructor() {
		super({
			id: OpenBrowserEditorAction.ID,
			title: localize2('browser.openBrowserEditorAction', "Open Browser"),
			category: Categories.View,
			// Binary: f1:!1 — the programmatic open entry point, not a
			// palette row. The MenubarAppearanceMenu item is verbatim
			// except its `when` (the binary's `cursor.browserTabEnabled`
			// context key does not exist in the fork; see header note).
			f1: false,
			menu: [{
				id: MenuId.MenubarAppearanceMenu,
				group: '1_toggle_view',
				order: 4,
			}]
		});
	}

	async run(accessor: ServicesAccessor, options?: IOpenBrowserEditorOptions): Promise<void> {
		const browserViewService = accessor.get(IBrowserViewWorkbenchService);

		// Binary option handling, verbatim: the url counts only when it is
		// a string, `inactive` defaults to false and `preserveFocus`
		// defaults to the resolved `inactive` value.
		const url = typeof options?.url === 'string' ? options.url : undefined;
		const inactive = options?.inactive ?? false;
		const preserveFocus = options?.preserveFocus ?? inactive;

		// Fork equivalent of the binary's create-input + openEditor: the
		// workbench service creates the input (fresh uuid), resolves its
		// model, opens it pinned in the active group and navigates to
		// `initialUrl` (see header note for the options the fork cannot
		// honor: browserId, transient, designMode, reuseExistingUrlTab,
		// trackingId, glass branch).
		await browserViewService.createBrowserView(
			{
				owner: { type: 'user' },
				session: { scope: BrowserViewStorageScope.Ephemeral },
				initialAudiences: [],
				initialUrl: url,
			},
			{
				pinned: true,
				preserveFocus: preserveFocus || inactive,
				background: inactive,
			}
		);
	}
}

export class OpenCursorWebsiteAction extends Action2 {
	static readonly ID = 'cursor.openCursorWebsite';

	constructor() {
		// Binary precondition `cursor.browserTabEnabled == true` is
		// intentionally not copied (see header note / GAPS-107).
		super({
			id: OpenCursorWebsiteAction.ID,
			title: localize2('browser.openCursorWebsiteAction', "Open cursor.com in Browser"),
			category: Categories.View,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		// Binary: the url comes from the dynamic config param
		// `browser_default_url_config`/`defaultUrl` when its origin is
		// https://cursor.com, else the verbatim fallback below. The fork
		// has no dynamic-config service, so the fallback always applies.
		// Like the binary, this delegates to OpenBrowserEditorAction
		// instead of opening anything itself.
		await accessor.get(ICommandService).executeCommand(OpenBrowserEditorAction.ID, { url: 'https://cursor.com' });
	}
}

registerAction2(NewBrowserTabAction);
registerAction2(ReloadBrowserTabAction);
registerAction2(FocusBrowserLocationBarAction);
registerAction2(OpenBrowserEditorAction);
registerAction2(OpenCursorWebsiteAction);
