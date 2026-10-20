/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tab-lifecycle slice of the Cursor-parity `cursor.browserView.*` command surface.
 *
 * BINARY EVIDENCE (Cursor 3.25.9, DEV-GAPS-54, verified in
 * workbench.{glass,desktop}.main.js): the tab commands below are registered via
 * registerCommand in the @40541183-40555886 region, with these handler semantics:
 *
 * - newTab(url?, options?): desktop path creates a BrowserEditorInput id=uuid,
 *   opens it pinned (+preserveFocus), sets owner (agentId ?? activeAgentId),
 *   navigates + awaits load when a url is given -> {success:true, browserId}.
 * - closeTab(viewId?, options?): closes the editor tab; if the view is headless,
 *   destroys it -> {success:true} / {success:false, error:'No browser tab to close' |
 *   'Browser tab not found'}.
 * - hideTab(viewId, options?): moves the view into a hidden container
 *   (zIndex -1), marks headless -> {success:true}.
 * - showHeadlessTab(viewId, options?): promotes a headless view to a visible
 *   editor tab -> {success:true} / 'Tab is not headless'.
 * - newHeadlessTab(url?, browserId?, agentId?): get-or-create headless view
 *   (max 6, LRU) -> {success:true, browserId}.
 * - isHeadless(viewId, options?): ownership-gated boolean.
 * - selectTab(viewId, options?): activates the matching editor tab pinned ->
 *   {success:true} / 'Browser tab not found'.
 * - focusOrShowTab(viewId, options?): opens/activates + focuses ->
 *   {success:true} / 'Browser view not found'.
 * - listTabs(options?): {tabs, activeTab, lastInteractedTab, headlessTabs} —
 *   ownership-filtered id arrays (GaI @40534580).
 * - setLocked(args, locked, options?) / isLocked(...): store lock flags ->
 *   {success:true, viewId, locked} / boolean.
 * - browserView.blur (bare id, no cursor. prefix): blurs the resolved view.
 *
 * HONEST-DIVERGENCE (fork has no glass shell / no browserViewStore):
 * - Headless = "view exists but has no editor tab": tracked in the surface's
 *   fork-local headless set (not persisted). newTab/newHeadlessTab/hideTab map to
 *   IBrowserViewWorkbenchService.createBrowserView with/without editorOpenOptions
 *   and model.setVisible(false) (no hidden-DOM-container API exists workbench-side).
 * - newHeadlessTab ignores a caller-supplied browserId: the fork's
 *   createBrowserView always generates the id.
 * - No 6-view LRU for headless views (binary-only store policy).
 * - position:'side' (side group) is not honored: placement is setting-driven via
 *   getPreferredGroup (workbench.browser.newTabPlacement).
 * - blur(): the fork's model/main service exposes no blur API; resolution still
 *   runs (so unknown ids are tolerated exactly like the binary) but the call is
 *   a no-op.
 * - Glass branches (glass.openBrowserTab / glass.activateBrowserTab) are skipped.
 */

import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { EditorActivation } from '../../../../../platform/editor/common/editor.js';
import { BrowserViewStorageScope, type IBrowserViewOwner } from '../../../../../platform/browserView/common/browserView.js';
import { IBrowserViewWorkbenchService } from '../../common/browserView.js';
import { BrowserEditorInput } from '../../common/browserEditorInput.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import {
	browserViewFailure,
	getHeadlessViewIds,
	getLastInteractedViewId,
	isViewHeadlessMarked,
	isViewLocked,
	isViewVisibleToAgent,
	markViewHeadless,
	normalizeArgs,
	noteLastInteracted,
	resolveBrowserView,
	resolveBrowserViewOrThrow,
	resolveViewIdSoft,
	setViewLocked,
	unmarkViewHeadless,
	type BrowserViewCommandArgs,
} from './browserViewCommandUtils.js';

interface NewTabOptions extends BrowserViewCommandArgs {
	preserveFocus?: boolean;
	agentId?: string;
	trackingId?: string;
	position?: string;
}

async function handleNewTab(accessor: ServicesAccessor, urlArg?: unknown, optionsArg?: unknown): Promise<{ success: true; browserId: string }> {
	const options = normalizeArgs(urlArg, optionsArg) as NewTabOptions;
	const url = typeof urlArg === 'string' ? urlArg : undefined;
	const agentId = typeof options.agentId === 'string' ? options.agentId : undefined;
	const owner: IBrowserViewOwner = agentId ? { type: 'agent', sessionId: agentId } : { type: 'user' };
	const service = accessor.get(IBrowserViewWorkbenchService);
	const input = await service.createBrowserView(
		{
			owner,
			session: { scope: BrowserViewStorageScope.Ephemeral },
			initialUrl: url,
			initialAudiences: [],
		},
		{
			pinned: true,
			preserveFocus: options.preserveFocus === true,
		}
	);
	noteLastInteracted(input.id);
	return { success: true, browserId: input.id };
}

async function handleCloseTab(accessor: ServicesAccessor, arg1?: unknown, optionsArg?: unknown): Promise<{ success: boolean; error?: string }> {
	const viewId = resolveViewIdSoft(accessor, normalizeArgs(arg1, optionsArg));
	if (!viewId) {
		return browserViewFailure('No browser tab to close');
	}
	const groupsService = accessor.get(IEditorGroupsService);
	for (const group of groupsService.groups) {
		for (const editor of group.editors) {
			if (editor instanceof BrowserEditorInput && editor.id === viewId) {
				await group.closeEditor(editor);
				return { success: true };
			}
		}
	}
	// Headless (no editor tab): destroy the view, mirroring the binary's destroyView.
	if (isViewHeadlessMarked(viewId)) {
		const input = accessor.get(IBrowserViewWorkbenchService).getKnownBrowserViews().get(viewId);
		input?.dispose();
		unmarkViewHeadless(viewId);
		return { success: true };
	}
	return browserViewFailure('Browser tab not found');
}

async function handleHideTab(accessor: ServicesAccessor, arg1?: unknown, optionsArg?: unknown): Promise<{ success: boolean; error?: string }> {
	// resolveBrowserViewOrThrow: explicit-missing -> 'Browser view not found'.
	const view = await resolveBrowserViewOrThrow(accessor, normalizeArgs(arg1, optionsArg));
	// Binary attaches the view to a hidden container at zIndex -1; the fork's
	// equivalent is hiding the view (no hidden-container API workbench-side).
	await view.model.setVisible(false);
	markViewHeadless(view.viewId);
	return { success: true };
}

async function handleShowHeadlessTab(accessor: ServicesAccessor, arg1?: unknown, optionsArg?: unknown): Promise<{ success: boolean; error?: string }> {
	const args = normalizeArgs(arg1, optionsArg);
	const viewId = args.viewId;
	const service = accessor.get(IBrowserViewWorkbenchService);
	const input = typeof viewId === 'string' ? service.getKnownBrowserViews().get(viewId) : undefined;
	if (!input || !isViewVisibleToAgent(input.model?.owner, args.ownerAgentId)) {
		return browserViewFailure('Browser view not found');
	}
	if (!isViewHeadlessMarked(viewId!)) {
		return browserViewFailure('Tab is not headless');
	}
	await accessor.get(IEditorService).openEditor(input, { pinned: true });
	unmarkViewHeadless(viewId!);
	const model = await input.resolve();
	await model.setVisible(true);
	return { success: true };
}

async function handleNewHeadlessTab(accessor: ServicesAccessor, urlArg?: unknown, browserIdArg?: unknown, agentIdArg?: unknown): Promise<{ success: true; browserId: string }> {
	const url = typeof urlArg === 'string' ? urlArg : undefined;
	let agentId: string | undefined;
	if (browserIdArg !== null && typeof browserIdArg === 'object') {
		const o = browserIdArg as { agentId?: unknown };
		if (typeof o.agentId === 'string') {
			agentId = o.agentId;
		}
	}
	if (typeof agentIdArg === 'string') {
		agentId = agentIdArg;
	}
	// HONEST-DIVERGENCE: a caller-supplied browserId is ignored — the fork's
	// createBrowserView always generates the id.
	const owner: IBrowserViewOwner = agentId ? { type: 'agent', sessionId: agentId } : { type: 'user' };
	const service = accessor.get(IBrowserViewWorkbenchService);
	// No editorOpenOptions -> no editor tab is opened: the fork's headless.
	const input = await service.createBrowserView({
		owner,
		session: { scope: BrowserViewStorageScope.Ephemeral },
		initialUrl: url,
		initialAudiences: [],
	});
	markViewHeadless(input.id);
	noteLastInteracted(input.id);
	return { success: true, browserId: input.id };
}

function handleIsHeadless(accessor: ServicesAccessor, viewIdArg?: unknown, optionsArg?: unknown): boolean {
	const args = normalizeArgs(viewIdArg, optionsArg);
	if (typeof args.viewId !== 'string') {
		return false;
	}
	const input = accessor.get(IBrowserViewWorkbenchService).getKnownBrowserViews().get(args.viewId);
	if (!input || !isViewVisibleToAgent(input.model?.owner, args.ownerAgentId)) {
		return false;
	}
	return isViewHeadlessMarked(args.viewId);
}

async function handleSelectTab(accessor: ServicesAccessor, arg1?: unknown, optionsArg?: unknown): Promise<{ success: boolean; error?: string }> {
	const viewId = resolveViewIdSoft(accessor, normalizeArgs(arg1, optionsArg));
	if (!viewId) {
		return browserViewFailure('Browser tab not found');
	}
	const groupsService = accessor.get(IEditorGroupsService);
	for (const group of groupsService.groups) {
		for (const editor of group.editors) {
			if (editor instanceof BrowserEditorInput && editor.id === viewId) {
				noteLastInteracted(viewId);
				await accessor.get(IEditorService).openEditor(editor, { pinned: true });
				return { success: true };
			}
		}
	}
	return browserViewFailure('Browser tab not found');
}

async function handleFocusOrShowTab(accessor: ServicesAccessor, viewIdArg?: unknown, optionsArg?: unknown): Promise<{ success: boolean; error?: string }> {
	const args = normalizeArgs(viewIdArg, optionsArg);
	const viewId = args.viewId;
	const service = accessor.get(IBrowserViewWorkbenchService);
	const input = typeof viewId === 'string' ? service.getKnownBrowserViews().get(viewId) : undefined;
	if (!input || !isViewVisibleToAgent(input.model?.owner, args.ownerAgentId)) {
		return browserViewFailure('Browser view not found');
	}
	// Promote: a formerly headless view becomes visible again.
	unmarkViewHeadless(viewId!);
	await accessor.get(IEditorService).openEditor(input, { pinned: true, activation: EditorActivation.ACTIVATE });
	const model = await input.resolve();
	await model.setVisible(true);
	await model.focus();
	noteLastInteracted(viewId!);
	return { success: true };
}

function handleListTabs(accessor: ServicesAccessor, optionsArg?: unknown): {
	tabs: string[];
	activeTab: string | undefined;
	lastInteractedTab: string | undefined;
	headlessTabs: string[];
} {
	// Binary (GaI @40534580): GaI({viewIds, activeViewId, lastInteractedViewId,
	// headlessViewIds, getBrowserOwner, requestingOwnerAgentId}) ->
	// {tabs, activeTab, lastInteractedTab, headlessTabs}, all ownership-filtered
	// via _jn/getBrowserOwner. (The older dissect doc's {viewIds, activeViewId,
	// lastInteractedViewId, headlessViewIds, owners} was GaI's INPUT, not its
	// return — corrected by w3-rea-spec.md and re-verified by DEV-GAPS-54.)
	const args = normalizeArgs(undefined, optionsArg);
	const known = accessor.get(IBrowserViewWorkbenchService).getKnownBrowserViews();
	const tabs: string[] = [];
	for (const [viewId, input] of known) {
		if (isViewVisibleToAgent(input.model?.owner, args.ownerAgentId)) {
			tabs.push(viewId);
		}
	}
	const activeEditor = accessor.get(IEditorService).activeEditor;
	const activeTab = activeEditor instanceof BrowserEditorInput && tabs.includes(activeEditor.id)
		? activeEditor.id
		: undefined;
	const last = getLastInteractedViewId();
	const lastInteractedTab = last !== undefined && tabs.includes(last) ? last : undefined;
	return {
		tabs,
		activeTab,
		lastInteractedTab,
		headlessTabs: getHeadlessViewIds().filter(id => tabs.includes(id)),
	};
}

function handleSetLocked(accessor: ServicesAccessor, arg1?: unknown, lockedArg?: unknown, optionsArg?: unknown): { success: boolean; viewId?: string; locked?: boolean; error?: string } {
	const viewId = resolveViewIdSoft(accessor, normalizeArgs(arg1, optionsArg));
	if (!viewId) {
		return browserViewFailure('No browser view available');
	}
	const locked = lockedArg === true;
	setViewLocked(viewId, locked);
	return { success: true, viewId, locked };
}

function handleIsLocked(accessor: ServicesAccessor, arg1?: unknown, optionsArg?: unknown): boolean {
	const viewId = resolveViewIdSoft(accessor, normalizeArgs(arg1, optionsArg));
	return viewId ? isViewLocked(viewId) : false;
}

async function handleBlur(accessor: ServicesAccessor, arg1?: unknown, optionsArg?: unknown): Promise<void> {
	// Binary: resolves (tolerates undefined), then view.blur(). The fork's
	// model/main service exposes no blur API — resolution runs for parity,
	// the blur itself is a documented no-op.
	await resolveBrowserView(accessor, normalizeArgs(arg1, optionsArg));
}

let _registered = false;

/** Registers the tab-lifecycle command group. Idempotent. */
export function registerBrowserViewTabCommands(): void {
	if (_registered) {
		return;
	}
	_registered = true;
	CommandsRegistry.registerCommand('cursor.browserView.newTab', (accessor: ServicesAccessor, url?: unknown, options?: unknown) => handleNewTab(accessor, url, options));
	CommandsRegistry.registerCommand('cursor.browserView.closeTab', (accessor: ServicesAccessor, arg1?: unknown, options?: unknown) => handleCloseTab(accessor, arg1, options));
	CommandsRegistry.registerCommand('cursor.browserView.hideTab', (accessor: ServicesAccessor, arg1?: unknown, options?: unknown) => handleHideTab(accessor, arg1, options));
	CommandsRegistry.registerCommand('cursor.browserView.showHeadlessTab', (accessor: ServicesAccessor, arg1?: unknown, options?: unknown) => handleShowHeadlessTab(accessor, arg1, options));
	CommandsRegistry.registerCommand('cursor.browserView.newHeadlessTab', (accessor: ServicesAccessor, url?: unknown, browserId?: unknown, agentId?: unknown) => handleNewHeadlessTab(accessor, url, browserId, agentId));
	CommandsRegistry.registerCommand('cursor.browserView.isHeadless', (accessor: ServicesAccessor, viewId?: unknown, options?: unknown) => handleIsHeadless(accessor, viewId, options));
	CommandsRegistry.registerCommand('cursor.browserView.selectTab', (accessor: ServicesAccessor, arg1?: unknown, options?: unknown) => handleSelectTab(accessor, arg1, options));
	CommandsRegistry.registerCommand('cursor.browserView.focusOrShowTab', (accessor: ServicesAccessor, viewId?: unknown, options?: unknown) => handleFocusOrShowTab(accessor, viewId, options));
	CommandsRegistry.registerCommand('cursor.browserView.listTabs', (accessor: ServicesAccessor, options?: unknown) => handleListTabs(accessor, options));
	CommandsRegistry.registerCommand('cursor.browserView.setLocked', (accessor: ServicesAccessor, arg1?: unknown, locked?: unknown, options?: unknown) => handleSetLocked(accessor, arg1, locked, options));
	CommandsRegistry.registerCommand('cursor.browserView.isLocked', (accessor: ServicesAccessor, arg1?: unknown, options?: unknown) => handleIsLocked(accessor, arg1, options));
	// Bare id — the binary registers it without the cursor. prefix (@40545348).
	CommandsRegistry.registerCommand('browserView.blur', (accessor: ServicesAccessor, arg1?: unknown, options?: unknown) => handleBlur(accessor, arg1, options));
}
