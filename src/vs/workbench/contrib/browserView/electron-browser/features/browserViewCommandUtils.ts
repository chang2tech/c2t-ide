/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Shared command surface for the Cursor-parity browser-view commands.
 *
 * BINARY EVIDENCE (Cursor 3.25.9, verified 2026-10-20 by DEV-GAPS-54):
 * - `registerCommand("cursor.browserView.*")` x29 + `registerCommand("browserView.blur")`
 *   in workbench.glass.main.js @40541183-40555886 AND workbench.desktop.main.js
 *   (29 cursor.browserView.* + 1 bare browserView.blur in each bundle).
 * - `cursor.browserView.debug.crashRenderer` / `cursor.browserView.debug.orphanView` are
 *   Action2 subclasses registered via registerAction2 (glass @48337991 / @48338882),
 *   titled "Developer: Crash Browser Webview Renderer" / "Developer: Orphan Browser View
 *   Entry", category Developer, f1:true.
 * - Load-wait `TQe(view, timeout=KaI)` with `KaI = 3e4` -> 30000ms
 *   (BROWSER_VIEW_LOAD_TIMEOUT_MS below).
 *
 * Layer attribution:
 * - Cursor: handlers resolve through browserViewStore (view registry/manager), the
 *   screenshot service, and an ownership service (viewId -> agentId); the view id
 *   resolves via `A8e(accessor, args, ownerAgentId)` = explicit viewId (ownership
 *   checked) else first visible of [lastInteracted, active, ...all].
 * - Fork: CommandsRegistry.registerCommand (headless-capable, matching the binary's
 *   registerCommand choice) inside contrib/browserView/electron-browser/features/,
 *   resolved via IBrowserViewWorkbenchService / IBrowserViewCDPService /
 *   IBrowserViewModel. Ownership is read from IBrowserViewModel.owner ({type:'user'}
 *   | {type:'agent'; sessionId}) — the fork's equivalent of Cursor's ownership
 *   service (the glassActiveAgentService / glassPanelResourceOwnershipService do not
 *   exist in the fork).
 *
 * HONEST-DIVERGENCE:
 * - The binary's browserViewStore keeps per-view state the fork has no equivalent
 *   for: headless containers (zIndex -1 hidden divs), lock flags, recording types.
 *   These are tracked in module-local state below (not persisted; lost on reload).
 * - The binary's `_Xs` headless get-or-create path (max 6 live headless views, LRU
 *   evicts unlocked non-loading) is not modeled; commands needing it use the
 *   "unlisted" view approximation (no editor tab opened).
 * - Glass-only paths (`isGlass` branches that drive `glass.openBrowserTab` /
 *   `glass.activateBrowserTab`) are skipped: the fork has no glass shell.
 * - `captureScreenshot()` default format is 'jpeg' (platform/browserView/common/browserView.ts:203-211);
 *   maybeAttachScreenshot forces 'png' so the returned mimeType is honest.
 * - awaitLoad approximates Cursor's onDidFinishLoad wait via
 *   onDidChangeLoadingState(loading=false); exact onDidFinishLoad semantics live
 *   main-process side and are not exposed.
 */

import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { encodeBase64, VSBuffer } from '../../../../../base/common/buffer.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import type { IBrowserViewOwner } from '../../../../../platform/browserView/common/browserView.js';
import { browserViewIsolatedWorldId } from '../../../../../platform/browserView/common/browserView.js';
import type { CDPResponse } from '../../../../../platform/browserView/common/cdp/types.js';
import { IBrowserViewCDPService, IBrowserViewModel, IBrowserViewWorkbenchService } from '../../common/browserView.js';
import { BrowserEditorInput } from '../../common/browserEditorInput.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';

/**
 * Common trailing-argument bag shared by all cursor.browserView.* commands.
 * Binary evidence (region @40541183-40555886): the options object is always the
 * LAST positional arg and carries ownerAgentId (and trackingId for some
 * commands). Extra per-command fields pass through via the index signature
 * (command-specific siblings read their own keys, mirroring Cursor's
 * loosely-typed arg shapes).
 */
export interface BrowserViewCommandArgs {
	/** Explicit view id; falls back to [lastInteracted, active, ...all] when omitted. */
	viewId?: string;
	/** When true, attach a post-action screenshot (see maybeAttachScreenshot). */
	take_screenshot_afterwards?: boolean;
	/** Calling agent id; used for the ownership check (binary cross-cutting rules). */
	ownerAgentId?: string;
	[key: string]: unknown;
}

export interface ResolvedBrowserView {
	readonly viewId: string;
	readonly input: BrowserEditorInput;
	readonly model: IBrowserViewModel;
}

/**
 * Timeout Cursor uses while awaiting navigation/reload load completion.
 * Binary: `KaI = 3e4`, `function TQe(t, e = KaI)` in workbench.glass.main.js.
 */
export const BROWSER_VIEW_LOAD_TIMEOUT_MS = 30000;

/**
 * Tracks the most recently interacted-with browser view, mirroring Cursor's
 * lastInteractedViewId (set by getConsoleLogs/getNetworkRequests/selectTab in the
 * binary region).
 */
let _lastInteractedViewId: string | undefined;

export function noteLastInteracted(viewId: string): void {
	_lastInteractedViewId = viewId;
}

export function getLastInteractedViewId(): string | undefined {
	return _lastInteractedViewId;
}

/**
 * Fork-local per-view state the binary keeps in browserViewStore (no fork
 * equivalent; see HONEST-DIVERGENCE above).
 */
const _headlessViewIds = new Set<string>();
const _lockedViewIds = new Set<string>();
const _recordingTypes = new Map<string, unknown>();

export function markViewHeadless(viewId: string): void { _headlessViewIds.add(viewId); }
export function unmarkViewHeadless(viewId: string): void { _headlessViewIds.delete(viewId); }
export function isViewHeadlessMarked(viewId: string): boolean { return _headlessViewIds.has(viewId); }
export function getHeadlessViewIds(): string[] { return [..._headlessViewIds]; }
export function setViewLocked(viewId: string, locked: boolean): void {
	if (locked) { _lockedViewIds.add(viewId); } else { _lockedViewIds.delete(viewId); }
}
export function isViewLocked(viewId: string): boolean { return _lockedViewIds.has(viewId); }
export function setViewRecordingType(viewId: string, recordingType: unknown): void { _recordingTypes.set(viewId, recordingType); }
export function getViewRecordingType(viewId: string): unknown { return _recordingTypes.get(viewId); }

/**
 * Normalize a command's positional args into an args bag. The first arg is
 * either a bare view-id string or an args object; the trailing (last) arg is
 * the options object (binary: always the last positional arg).
 */
export function normalizeArgs(arg1?: unknown, optionsArg?: unknown): BrowserViewCommandArgs {
	const args: BrowserViewCommandArgs = {};
	if (typeof arg1 === 'string') {
		args.viewId = arg1;
	} else if (arg1 !== null && typeof arg1 === 'object') {
		Object.assign(args, arg1 as Record<string, unknown>);
	}
	if (optionsArg !== null && typeof optionsArg === 'object') {
		Object.assign(args, optionsArg as Record<string, unknown>);
	}
	return args;
}

/**
 * Ownership check mirroring the binary's visibility rule (cross-cutting):
 * unowned (user-owned) views are visible to everyone; agent-owned views only to
 * the owning agent.
 */
export function isViewVisibleToAgent(owner: IBrowserViewOwner | undefined, ownerAgentId: string | undefined): boolean {
	if (!owner || owner.type === 'user') {
		return true;
	}
	return ownerAgentId !== undefined && owner.sessionId === ownerAgentId;
}

function isVisibleToAgentOrUndefined(input: BrowserEditorInput, ownerAgentId: string | undefined): boolean {
	// Model not resolved yet: optimistically visible (binary resolves lazily too).
	return isViewVisibleToAgent(input.model?.owner, ownerAgentId);
}

/**
 * Soft view-id resolution following Cursor's order (binary `A8e`): explicit
 * viewId (ownership checked) else first visible of [lastInteracted, active,
 * ...all]. Returns undefined when nothing resolves (the binary's blur /
 * getConsoleLogs / getNetworkRequests handlers tolerate undefined).
 */
export function resolveViewIdSoft(accessor: ServicesAccessor, args: BrowserViewCommandArgs): string | undefined {
	const service = accessor.get(IBrowserViewWorkbenchService);
	const known = service.getKnownBrowserViews();
	const ownerAgentId = args.ownerAgentId;

	if (args.viewId) {
		const input = known.get(args.viewId);
		return input && isVisibleToAgentOrUndefined(input, ownerAgentId) ? args.viewId : undefined;
	}

	const candidates: string[] = [];
	const last = getLastInteractedViewId();
	if (last && known.has(last)) {
		candidates.push(last);
	}
	const activeEditor = accessor.get(IEditorService).activeEditor;
	if (activeEditor instanceof BrowserEditorInput && activeEditor.id !== last) {
		candidates.push(activeEditor.id);
	}
	for (const viewId of known.keys()) {
		if (!candidates.includes(viewId)) {
			candidates.push(viewId);
		}
	}

	for (const viewId of candidates) {
		const input = known.get(viewId);
		if (input && isVisibleToAgentOrUndefined(input, ownerAgentId)) {
			return viewId;
		}
	}
	return undefined;
}

/**
 * Strict resolution with the binary's error strings: explicit-but-missing (or
 * owned by another agent) -> 'Browser view not found'; nothing at all ->
 * 'No browser view available'.
 */
export async function resolveBrowserViewOrThrow(accessor: ServicesAccessor, args: BrowserViewCommandArgs): Promise<ResolvedBrowserView> {
	const service = accessor.get(IBrowserViewWorkbenchService);
	if (args.viewId) {
		const input = service.getKnownBrowserViews().get(args.viewId);
		if (!input || !isVisibleToAgentOrUndefined(input, args.ownerAgentId)) {
			throw new Error('Browser view not found');
		}
		const view = await toResolvedBrowserView(input, args.viewId);
		noteLastInteracted(view.viewId);
		return view;
	}
	const viewId = resolveViewIdSoft(accessor, args);
	if (!viewId) {
		throw new Error('No browser view available');
	}
	const input = service.getKnownBrowserViews().get(viewId);
	if (!input) {
		throw new Error('No browser view available');
	}
	const view = await toResolvedBrowserView(input, viewId);
	noteLastInteracted(view.viewId);
	return view;
}

/** Soft resolution: undefined when nothing resolves (binary blur/getConsoleLogs semantics). */
export async function resolveBrowserView(accessor: ServicesAccessor, args: BrowserViewCommandArgs): Promise<ResolvedBrowserView | undefined> {
	const viewId = resolveViewIdSoft(accessor, args);
	if (!viewId) {
		return undefined;
	}
	const input = accessor.get(IBrowserViewWorkbenchService).getKnownBrowserViews().get(viewId);
	if (!input) {
		return undefined;
	}
	const view = await toResolvedBrowserView(input, viewId);
	noteLastInteracted(view.viewId);
	return view;
}

/**
 * View-id targets for the debug commands, mirroring the binary's `Rly(store)`:
 * [lastInteractedViewId ?? activeViewId ?? firstViewId] (empty when none).
 */
export function debugTargetViewIds(accessor: ServicesAccessor): string[] {
	const service = accessor.get(IBrowserViewWorkbenchService);
	const known = service.getKnownBrowserViews();
	const last = getLastInteractedViewId();
	if (last && known.has(last)) {
		return [last];
	}
	const activeEditor = accessor.get(IEditorService).activeEditor;
	if (activeEditor instanceof BrowserEditorInput && known.has(activeEditor.id)) {
		return [activeEditor.id];
	}
	const first = known.keys().next();
	return first.done ? [] : [first.value];
}

async function toResolvedBrowserView(input: BrowserEditorInput, viewId: string): Promise<ResolvedBrowserView> {
	// BrowserEditorInput.resolve() creates/resolves the underlying model
	// (common/browserEditorInput.ts:194).
	const model = await input.resolve();
	return { viewId, input, model };
}

/** Standard failure envelope ({success:false,error}) used across the command surface. */
export function browserViewFailure(error: string): { success: false; error: string } {
	return { success: false, error };
}

/**
 * Attach a post-action screenshot when args.take_screenshot_afterwards is set.
 * Returns a data URL + mimeType pair.
 */
export async function maybeAttachScreenshot(
	_accessor: ServicesAccessor,
	view: ResolvedBrowserView,
	args: BrowserViewCommandArgs
): Promise<{ dataUrl: string; mimeType: string } | undefined> {
	if (!args.take_screenshot_afterwards) {
		return undefined;
	}
	// Force PNG so the declared mimeType matches the bytes (default format is 'jpeg').
	const buf: VSBuffer = await view.model.captureScreenshot({ format: 'png' });
	return {
		dataUrl: `data:image/png;base64,${encodeBase64(buf)}`,
		mimeType: 'image/png',
	};
}

/**
 * Wait for a view's load to settle: first of onDidNavigate or
 * onDidChangeLoadingState(loading=false), with a timeout (default
 * BROWSER_VIEW_LOAD_TIMEOUT_MS = binary TQe 30s).
 */
export async function awaitLoad(view: ResolvedBrowserView, timeoutMs: number = BROWSER_VIEW_LOAD_TIMEOUT_MS): Promise<void> {
	const model = view.model;
	if (!model.loading) {
		return;
	}
	await new Promise<void>(resolve => {
		const store = new DisposableStore();
		const done = () => {
			store.dispose();
			resolve();
		};
		store.add(model.onDidChangeLoadingState(e => {
			if (!e.loading) {
				done();
			}
		}));
		store.add(model.onDidNavigate(() => done()));
		const timer = setTimeout(done, timeoutMs);
		store.add({ dispose: () => clearTimeout(timer) });
	});
}

let _cdpRequestId = 0;

/**
 * Send one CDP command to a view and await its response.
 *
 * Binary: `manager.sendCDPCommand(method, params)` — one call on the view's
 * manager (webContents.debugger). Fork: the workbench CDP surface is
 * group-based (IBrowserViewCDPService): create a session group for the view,
 * send the message, await the response event with the matching id, destroy
 * the group. Same semantics, different plumbing.
 */
export async function sendCDPCommandToView(
	accessor: ServicesAccessor,
	viewId: string,
	method: string,
	params?: unknown,
	timeoutMs: number = BROWSER_VIEW_LOAD_TIMEOUT_MS
): Promise<unknown> {
	const cdp = accessor.get(IBrowserViewCDPService);
	const groupId = await cdp.createSessionGroup(viewId);
	try {
		const id = ++_cdpRequestId;
		const responsePromise = new Promise<CDPResponse>((resolve, reject) => {
			const timer = setTimeout(() => {
				listener.dispose();
				reject(new Error(`CDP command ${method} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			const listener = cdp.onCDPMessage(groupId)(msg => {
				if ('id' in msg && msg.id === id) {
					clearTimeout(timer);
					listener.dispose();
					resolve(msg as CDPResponse);
				}
			});
		});
		await cdp.sendCDPMessage(groupId, { id, method, params });
		const response = await responsePromise;
		if (response.error) {
			throw new Error(response.error.message || `CDP command ${method} failed`);
		}
		return response.result;
	} finally {
		await cdp.destroySessionGroup(groupId).catch(() => { /* best effort */ });
	}
}

/**
 * Evaluate JavaScript in a view via CDP `Runtime.evaluate` (returnByValue +
 * awaitPromise). The binary's manager.executeJavaScript wraps
 * webContents.executeJavaScript; the fork's workbench model exposes no such
 * proxy — CDP is the fork-native path.
 */
export async function evaluateJavaScriptInView(
	accessor: ServicesAccessor,
	viewId: string,
	expression: string,
	options?: { isolatedWorld?: boolean }
): Promise<unknown> {
	const result = await sendCDPCommandToView(accessor, viewId, 'Runtime.evaluate', {
		expression,
		returnByValue: true,
		awaitPromise: true,
		...(options?.isolatedWorld ? { contextId: browserViewIsolatedWorldId } : {}),
	}) as { result?: { value?: unknown }; exceptionDetails?: { text?: string } } | undefined;
	if (result?.exceptionDetails) {
		throw new Error(result.exceptionDetails.text || 'JavaScript evaluation failed');
	}
	return result?.result?.value;
}

