/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Navigation slice of the Cursor-parity `cursor.browserView.*` command surface.
 *
 * BINARY EVIDENCE (Cursor 3.25.9, DEV-GAPS-54, verified in
 * workbench.{glass,desktop}.main.js @40541183-40555886):
 *
 * - navigate(url, viewId?, options?): desktop path resolves the view (missing ->
 *   throw 'Browser view not found'), navigates, awaits load (TQe, 30s), returns
 *   undefined. Glass/preserveFocus branches are glass-only and skipped.
 * - reload(viewId?, options?): manager.reloadIgnoringCache() then TQe ->
 *   returns true.
 * - goBack / goForward(viewId?, options?): delegate to the manager, return its
 *   result.
 * - getURL(viewId?, options?): manager.getURL(). getTitle: tabState.pageTitle ?? ''.
 * - resize({width, height, viewId}): Number(width/height); NaN -> {success:false,
 *   error:'Invalid width or height'}; get-or-create view; executes the exact
 *   inline script setting documentElement maxWidth/maxHeight/overflow ->
 *   {success:true}.
 *
 * Fork mapping: IBrowserViewModel.loadURL / reload(hard=true) / goBack /
 * goForward / url / title; resize runs the binary's script verbatim via CDP
 * Runtime.evaluate (evaluateJavaScriptInView in the surface module).
 */

import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import {
	awaitLoad,
	browserViewFailure,
	evaluateJavaScriptInView,
	normalizeArgs,
	resolveBrowserViewOrThrow,
	type ResolvedBrowserView,
} from './browserViewCommandUtils.js';

async function handleNavigate(accessor: ServicesAccessor, urlArg?: unknown, viewIdArg?: unknown, optionsArg?: unknown): Promise<void> {
	// Cursor resolves with XaI(accessor, viewId, ownerAgentId) and throws
	// 'Browser view not found' when the getView lookup misses (desktop path).
	const view = await resolveBrowserViewOrThrow(accessor, normalizeArgs(viewIdArg, optionsArg));
	await view.model.loadURL(typeof urlArg === 'string' ? urlArg : '');
	await awaitLoad(view);
}

async function handleReload(accessor: ServicesAccessor, arg1?: unknown, optionsArg?: unknown): Promise<boolean> {
	const view = await resolveBrowserViewOrThrow(accessor, normalizeArgs(arg1, optionsArg));
	// Binary: reloadIgnoringCache() — the fork's hard reload.
	await view.model.reload(true);
	await awaitLoad(view);
	return true;
}

async function handleGoBack(accessor: ServicesAccessor, arg1?: unknown, optionsArg?: unknown): Promise<void> {
	const view = await resolveBrowserViewOrThrow(accessor, normalizeArgs(arg1, optionsArg));
	await view.model.goBack();
}

async function handleGoForward(accessor: ServicesAccessor, arg1?: unknown, optionsArg?: unknown): Promise<void> {
	const view = await resolveBrowserViewOrThrow(accessor, normalizeArgs(arg1, optionsArg));
	await view.model.goForward();
}

async function handleGetURL(accessor: ServicesAccessor, arg1?: unknown, optionsArg?: unknown): Promise<string> {
	const view = await resolveBrowserViewOrThrow(accessor, normalizeArgs(arg1, optionsArg));
	return view.model.url;
}

async function handleGetTitle(accessor: ServicesAccessor, arg1?: unknown, optionsArg?: unknown): Promise<string> {
	const view = await resolveBrowserViewOrThrow(accessor, normalizeArgs(arg1, optionsArg));
	return view.model.title ?? '';
}

async function handleResize(accessor: ServicesAccessor, argsArg?: unknown): Promise<{ success: boolean; error?: string }> {
	const args = normalizeArgs(argsArg);
	const width = Number(args.width);
	const height = Number(args.height);
	if (isNaN(width) || isNaN(height)) {
		return browserViewFailure('Invalid width or height');
	}
	// Binary: _Xs get-or-create; missing -> failure envelope 'No browser view available'
	// (returned, not thrown).
	let view: ResolvedBrowserView;
	try {
		view = await resolveBrowserViewOrThrow(accessor, args);
	} catch {
		return browserViewFailure('No browser view available');
	}
	// Script verbatim from the binary (numbers validated above before interpolation).
	const script = `
			(function() {
				document.documentElement.style.maxWidth = '${width}px';
				document.documentElement.style.maxHeight = '${height}px';
				document.documentElement.style.overflow = 'auto';
				return { width: ${width}, height: ${height} };
			})();
		`;
	await evaluateJavaScriptInView(accessor, view.viewId, script);
	return { success: true };
}

let _registered = false;

/** Registers the navigation command group. Idempotent. */
export function registerBrowserViewNavCommands(): void {
	if (_registered) {
		return;
	}
	_registered = true;
	CommandsRegistry.registerCommand('cursor.browserView.navigate', (accessor: ServicesAccessor, url?: unknown, viewId?: unknown, options?: unknown) => handleNavigate(accessor, url, viewId, options));
	CommandsRegistry.registerCommand('cursor.browserView.reload', (accessor: ServicesAccessor, arg1?: unknown, options?: unknown) => handleReload(accessor, arg1, options));
	CommandsRegistry.registerCommand('cursor.browserView.goBack', (accessor: ServicesAccessor, arg1?: unknown, options?: unknown) => handleGoBack(accessor, arg1, options));
	CommandsRegistry.registerCommand('cursor.browserView.goForward', (accessor: ServicesAccessor, arg1?: unknown, options?: unknown) => handleGoForward(accessor, arg1, options));
	CommandsRegistry.registerCommand('cursor.browserView.getURL', (accessor: ServicesAccessor, arg1?: unknown, options?: unknown) => handleGetURL(accessor, arg1, options));
	CommandsRegistry.registerCommand('cursor.browserView.getTitle', (accessor: ServicesAccessor, arg1?: unknown, options?: unknown) => handleGetTitle(accessor, arg1, options));
	CommandsRegistry.registerCommand('cursor.browserView.resize', (accessor: ServicesAccessor, args?: unknown) => handleResize(accessor, args));
}
