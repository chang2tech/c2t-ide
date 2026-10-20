/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Capture/inspection slice of the Cursor-parity `cursor.browserView.*` command
 * surface.
 *
 * BINARY EVIDENCE (Cursor 3.25.9, DEV-GAPS-54, verified in
 * workbench.{glass,desktop}.main.js @40541183-40555886):
 *
 * - executeJavaScript(script, viewId?, options?, trackingId?) /
 *   executeJavaScriptInIsolatedWorld(...): manager.executeJavaScript(e) /
 *   manager.executeJavaScriptInIsolatedWorld(e); returns the evaluation result.
 * - takeScreenshot({type, fullPage, viewId, ref|element, filename}): resolves (or
 *   creates) the view -> 'No browser view available'; screenshotType =
 *   fullPage|'element'|'viewport'; element bounds via an inline querySelector +
 *   getBoundingClientRect script; then delegates to
 *   `cursor.browserAutomation.captureWebviewScreenshot`(webContentsId,
 *   {screenshotType, bounds, filename, format: e.type || 'png'}).
 * - updateScreenshot(viewId, dataUrl, ?): sync pass-through to the screenshot
 *   service (live thumb in Cursor's UI service).
 * - getConsoleLogs / getNetworkRequests(args?, options?): resolve via A8e,
 *   setLastInteractedViewId, return view logs or [] when unresolved.
 * - sendCDPCommand(method, params, viewId?, options?): manager.sendCDPCommand(e, n).
 *
 * HONEST-DIVERGENCE:
 * - executeJavaScript goes through CDP Runtime.evaluate (evaluateJavaScriptInView);
 *   the fork's workbench model exposes no executeJavaScript proxy.
 *   Isolated-world evaluation uses browserViewIsolatedWorldId (999), which
 *   matches the fork's preload isolated world
 *   (platform/browserView/common/browserView.ts:521-523).
 * - takeScreenshot is single-stage via IBrowserViewModel.captureScreenshot
 *   ({format, fullPage, screenRect}); Cursor's 2-stage
 *   cursor.browserAutomation.captureWebviewScreenshot pipeline does not exist in
 *   the fork. `filename` is ignored (fork capture has no filename option).
 * - updateScreenshot: the fork has no browserScreenshotService / live-thumb write
 *   API; the call validates the args and resolves the view, then returns
 *   {success:true} as a no-op.
 * - getNetworkRequests: the fork captures console logs main-side but has no
 *   per-view network-request store; always returns [] (like the binary's
 *   no-view branch) when a view resolves.
 */

import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { encodeBase64 } from '../../../../../base/common/buffer.js';
import { getErrorMessage } from '../../../../../base/common/errors.js';
import { IBrowserViewWorkbenchService } from '../../common/browserView.js';
import {
	browserViewFailure,
	evaluateJavaScriptInView,
	normalizeArgs,
	noteLastInteracted,
	resolveBrowserView,
	resolveBrowserViewOrThrow,
	resolveViewIdSoft,
	sendCDPCommandToView,
} from './browserViewCommandUtils.js';

async function handleExecuteJavaScript(accessor: ServicesAccessor, script?: unknown, viewIdArg?: unknown, optionsArg?: unknown, isolatedWorld = false): Promise<unknown> {
	const view = await resolveBrowserViewOrThrow(accessor, normalizeArgs(viewIdArg, optionsArg));
	return evaluateJavaScriptInView(accessor, view.viewId, typeof script === 'string' ? script : '', isolatedWorld ? { isolatedWorld: true } : undefined);
}

async function handleTakeScreenshot(accessor: ServicesAccessor, argsArg?: unknown): Promise<{ success: boolean; dataUrl?: string; mimeType?: string }> {
	// Binary: the whole handler is wrapped in try/catch -> {success:false, error}
	// envelope on any failure (incl. no view: 'No browser view available').
	try {
		return await takeScreenshotInner(accessor, argsArg);
	} catch (error) {
		return browserViewFailure(getErrorMessage(error));
	}
}

async function takeScreenshotInner(accessor: ServicesAccessor, argsArg?: unknown): Promise<{ success: true; dataUrl: string; mimeType: string }> {
	const args = normalizeArgs(argsArg);
	// Binary: _Xs get-or-create; missing -> 'No browser view available'.
	const view = await resolveBrowserViewOrThrow(accessor, args);
	const selector = typeof args.ref === 'string' ? args.ref : (typeof args.element === 'string' ? args.element : undefined);
	const fullPage = args.fullPage === true;
	const elementMode = !fullPage && !!selector;

	let bounds: { x: number; y: number; width: number; height: number } | undefined;
	if (elementMode && selector) {
		// Inline script verbatim from the binary.
		const rect = await evaluateJavaScriptInView(accessor, view.viewId, `
					(function() {
						const el = document.querySelector(${JSON.stringify(selector)});
						if (!el) return null;
						const rect = el.getBoundingClientRect();
						return {
							x: Math.round(rect.x),
							y: Math.round(rect.y),
							width: Math.round(rect.width),
							height: Math.round(rect.height)
						};
					})();
				`) as { x?: unknown; y?: unknown; width?: unknown; height?: unknown } | null;
		if (rect && typeof rect === 'object'
			&& typeof rect.x === 'number' && typeof rect.y === 'number'
			&& typeof rect.width === 'number' && typeof rect.height === 'number'
			&& rect.width > 0 && rect.height > 0) {
			bounds = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
		}
	}

	const format = args.type === 'jpeg' ? 'jpeg' : 'png';
	const buf = await view.model.captureScreenshot({
		format,
		fullPage,
		screenRect: bounds,
	});
	return {
		success: true,
		dataUrl: `data:image/${format};base64,${encodeBase64(buf)}`,
		mimeType: `image/${format}`,
	};
}

async function handleUpdateScreenshot(accessor: ServicesAccessor, viewIdArg?: unknown, dataUrlArg?: unknown, optionsArg?: unknown): Promise<{ success: boolean; error?: string }> {
	const args = normalizeArgs(viewIdArg, optionsArg);
	if (dataUrlArg !== undefined) {
		args.dataUrl = dataUrlArg;
	}
	const view = await resolveBrowserView(accessor, args);
	if (!view) {
		return browserViewFailure('No browser view available');
	}
	if (typeof args.dataUrl !== 'string' || !/^data:image\/(png|jpeg);base64,/.test(args.dataUrl)) {
		return browserViewFailure('Invalid screenshot data URL');
	}
	// HONEST-DIVERGENCE: no browserScreenshotService in the fork; live thumbs
	// are main-driven (IBrowserViewState.lastScreenshot). Documented no-op.
	return { success: true };
}

async function handleGetConsoleLogs(accessor: ServicesAccessor, arg1?: unknown, optionsArg?: unknown): Promise<string | never[]> {
	const args = normalizeArgs(arg1, optionsArg);
	const viewId = resolveViewIdSoft(accessor, args);
	if (!viewId) {
		return [];
	}
	noteLastInteracted(viewId);
	// Binary: store.getView(viewId)?.getConsoleLogs() ?? []
	const input = accessor.get(IBrowserViewWorkbenchService).getKnownBrowserViews().get(viewId);
	if (!input) {
		return [];
	}
	const model = await input.resolve();
	return model.getConsoleLogs();
}

async function handleGetNetworkRequests(accessor: ServicesAccessor, arg1?: unknown, optionsArg?: unknown): Promise<never[]> {
	const args = normalizeArgs(arg1, optionsArg);
	const viewId = resolveViewIdSoft(accessor, args);
	if (viewId) {
		noteLastInteracted(viewId);
	}
	// HONEST-DIVERGENCE: the fork has no per-view network-request store.
	return [];
}

async function handleSendCDPCommand(accessor: ServicesAccessor, methodArg?: unknown, paramsArg?: unknown, viewIdArg?: unknown, optionsArg?: unknown): Promise<unknown> {
	const view = await resolveBrowserViewOrThrow(accessor, normalizeArgs(viewIdArg, optionsArg));
	return sendCDPCommandToView(accessor, view.viewId, typeof methodArg === 'string' ? methodArg : '', paramsArg);
}

let _registered = false;

/** Registers the capture/inspection command group. Idempotent. */
export function registerBrowserViewCaptureCommands(): void {
	if (_registered) {
		return;
	}
	_registered = true;
	CommandsRegistry.registerCommand('cursor.browserView.executeJavaScript', (accessor: ServicesAccessor, script?: unknown, viewId?: unknown, options?: unknown) => handleExecuteJavaScript(accessor, script, viewId, options, false));
	CommandsRegistry.registerCommand('cursor.browserView.executeJavaScriptInIsolatedWorld', (accessor: ServicesAccessor, script?: unknown, viewId?: unknown, options?: unknown) => handleExecuteJavaScript(accessor, script, viewId, options, true));
	CommandsRegistry.registerCommand('cursor.browserView.takeScreenshot', (accessor: ServicesAccessor, args?: unknown) => handleTakeScreenshot(accessor, args));
	CommandsRegistry.registerCommand('cursor.browserView.updateScreenshot', (accessor: ServicesAccessor, viewId?: unknown, dataUrl?: unknown, options?: unknown) => handleUpdateScreenshot(accessor, viewId, dataUrl, options));
	CommandsRegistry.registerCommand('cursor.browserView.getConsoleLogs', (accessor: ServicesAccessor, arg1?: unknown, options?: unknown) => handleGetConsoleLogs(accessor, arg1, options));
	CommandsRegistry.registerCommand('cursor.browserView.getNetworkRequests', (accessor: ServicesAccessor, arg1?: unknown, options?: unknown) => handleGetNetworkRequests(accessor, arg1, options));
	CommandsRegistry.registerCommand('cursor.browserView.sendCDPCommand', (accessor: ServicesAccessor, method?: unknown, params?: unknown, viewId?: unknown, options?: unknown) => handleSendCDPCommand(accessor, method, params, viewId, options));
}
