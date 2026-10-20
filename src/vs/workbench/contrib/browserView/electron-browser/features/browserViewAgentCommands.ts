/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Agent-facing slice of the Cursor-parity `cursor.browserView.*` command surface.
 *
 * BINARY EVIDENCE (Cursor 3.25.9, DEV-GAPS-54):
 * - workbench.glass.main.js @40541183-40555886 (registerCommand region):
 *   - setRecordingType(args, recordingType, options?): A8e resolve -> store
 *     setRecordingType -> {success:true, viewId, recordingType} /
 *     {success:false, error:'No browser view available'}.
 *   - getRecordingType(args?, options?): resolve -> store value ?? null.
 *   - configureDialogHandling({viewId, accept, promptText}): view ? {success:true,
 *     configured:true, action: accept?'accept':'dismiss', promptText} :
 *     {success:false, error:'No browser view available'}.
 *   - clearAgentDeviceEmulation(viewId, options?): no view -> 'Browser view not
 *     found'; ownership check fails -> 'Browser view is owned by another agent';
 *     else view.clearAgentDeviceEmulation() -> {success:true}.
 * - Debug commands (glass @48337991 / @48338882, Action2 via registerAction2):
 *   - cursor.browserView.debug.crashRenderer: target = [lastInteracted ??
 *     active ?? first]; none -> log warn 'No browser view available to crash.
 *     Open a browser tab first.'; per view: view.forcefullyCrashRenderer() ->
 *     {viewId, ...result} | 'Manager missing'; report via ILogService.
 *   - cursor.browserView.debug.orphanView: same target resolution; per view
 *     view.destroyBrowserView(); report 'Orphaned view entry(ies): .... Still
 *     listed in store, webview is gone.'
 *   Both: title 'Developer: ...', category Developer, f1:true.
 *
 * HONEST-DIVERGENCE:
 * - Recording types / lock flags live in the surface's fork-local stores (the
 *   binary keeps them in browserViewStore).
 * - configureDialogHandling: the binary's handler resolves the view and returns
 *   the ack envelope without further wiring; the fork mirrors that exactly.
 * - clearAgentDeviceEmulation maps to IBrowserViewModel.setDevice(undefined) —
 *   the fork's native device-emulation clear API.
 * - crashRenderer: the fork's IBrowserViewService has no forcefullyCrashRenderer;
 *   the command is registered (Developer category, f1) and reports the
 *   unsupported error per target instead of pretending to crash.
 * - orphanView: disposing the resolved model destroys the main view while the
 *   workbench input stays in getKnownBrowserViews() — exactly the binary's
 *   "still listed in store, webview is gone" semantics.
 * - The binary's Action2 precondition (Aly) was not identifiable; the fork
 *   registers without a precondition.
 */

import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { localize2 } from '../../../../../nls.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { Categories } from '../../../../../platform/action/common/actionCommonCategories.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { getErrorMessage } from '../../../../../base/common/errors.js';
import { IBrowserViewWorkbenchService } from '../../common/browserView.js';
import {
	browserViewFailure,
	debugTargetViewIds,
	getViewRecordingType,
	isViewVisibleToAgent,
	normalizeArgs,
	resolveBrowserViewOrThrow,
	resolveViewIdSoft,
	setViewRecordingType,
} from './browserViewCommandUtils.js';

function handleSetRecordingType(accessor: ServicesAccessor, arg1?: unknown, recordingType?: unknown, optionsArg?: unknown): { success: boolean; viewId?: string; recordingType?: unknown; error?: string } {
	const viewId = resolveViewIdSoft(accessor, normalizeArgs(arg1, optionsArg));
	if (!viewId) {
		return browserViewFailure('No browser view available');
	}
	setViewRecordingType(viewId, recordingType);
	return { success: true, viewId, recordingType };
}

function handleGetRecordingType(accessor: ServicesAccessor, arg1?: unknown, optionsArg?: unknown): unknown {
	const viewId = resolveViewIdSoft(accessor, normalizeArgs(arg1, optionsArg));
	return viewId ? (getViewRecordingType(viewId) ?? null) : null;
}

async function handleConfigureDialogHandling(accessor: ServicesAccessor, argsArg?: unknown): Promise<{ success: boolean; configured?: boolean; action?: string; promptText?: unknown; error?: string }> {
	const args = normalizeArgs(argsArg);
	// Binary: resolve (get-or-create) then ack; missing -> failure envelope
	// 'No browser view available' (returned, not thrown).
	try {
		await resolveBrowserViewOrThrow(accessor, args);
	} catch {
		return browserViewFailure('No browser view available');
	}
	return {
		success: true,
		configured: true,
		action: args.accept ? 'accept' : 'dismiss',
		promptText: args.promptText,
	};
}

async function handleClearAgentDeviceEmulation(accessor: ServicesAccessor, viewIdArg?: unknown, optionsArg?: unknown): Promise<{ success: boolean; error?: string }> {
	const args = normalizeArgs(viewIdArg, optionsArg);
	const viewId = args.viewId;
	const input = typeof viewId === 'string'
		? accessor.get(IBrowserViewWorkbenchService).getKnownBrowserViews().get(viewId)
		: undefined;
	if (!input) {
		return browserViewFailure('Browser view not found');
	}
	const model = await input.resolve();
	// Binary: ownership check (bjn) fails -> 'Browser view is owned by another agent'.
	if (!isViewVisibleToAgent(model.owner, args.ownerAgentId)) {
		return browserViewFailure('Browser view is owned by another agent');
	}
	await model.setDevice(undefined);
	return { success: true };
}

class CrashBrowserRendererAction extends Action2 {
	static readonly ID = 'cursor.browserView.debug.crashRenderer';

	constructor() {
		super({
			id: CrashBrowserRendererAction.ID,
			title: localize2('browserView.debug.crashRenderer', 'Developer: Crash Browser Webview Renderer'),
			category: Categories.Developer,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const logService = accessor.get(ILogService);
		const targets = debugTargetViewIds(accessor);
		if (targets.length === 0) {
			logService.warn('No browser view available to crash. Open a browser tab first.');
			return;
		}
		const succeeded: string[] = [];
		const failed: string[] = [];
		for (const viewId of targets) {
			const input = accessor.get(IBrowserViewWorkbenchService).getKnownBrowserViews().get(viewId);
			if (!input) {
				failed.push(`${viewId} (Manager missing)`);
				continue;
			}
			// HONEST-DIVERGENCE: no forcefullyCrashRenderer in the fork's
			// IBrowserViewService — report honestly instead of pretending.
			failed.push(`${viewId} (Renderer crash is not supported by the fork's browser service)`);
		}
		if (succeeded.length > 0) {
			logService.info(`Crashed browser view(s): ${succeeded.join(', ')}. Store entries were kept.`);
		}
		if (failed.length > 0) {
			logService.warn(`Failed to crash: ${failed.join(', ')}`);
		}
	}
}

class OrphanBrowserViewAction extends Action2 {
	static readonly ID = 'cursor.browserView.debug.orphanView';

	constructor() {
		super({
			id: OrphanBrowserViewAction.ID,
			title: localize2('browserView.debug.orphanView', 'Developer: Orphan Browser View Entry'),
			category: Categories.Developer,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const logService = accessor.get(ILogService);
		const targets = debugTargetViewIds(accessor);
		if (targets.length === 0) {
			logService.warn('No browser view available to orphan. Open a browser tab first.');
			return;
		}
		const succeeded: string[] = [];
		const failed: string[] = [];
		for (const viewId of targets) {
			const input = accessor.get(IBrowserViewWorkbenchService).getKnownBrowserViews().get(viewId);
			if (!input) {
				failed.push(`${viewId} (Manager missing)`);
				continue;
			}
			try {
				// BrowserViewModel.dispose() -> IBrowserViewService.destroyBrowserView:
				// main view destroyed, workbench input stays listed.
				const model = await input.resolve();
				model.dispose();
				succeeded.push(viewId);
			} catch (error) {
				failed.push(`${viewId} (${getErrorMessage(error)})`);
			}
		}
		if (succeeded.length > 0) {
			logService.info(`Orphaned view entry(ies): ${succeeded.join(', ')}. Still listed in store, webview is gone.`);
		}
		if (failed.length > 0) {
			logService.warn(`Failed to orphan: ${failed.join(', ')}`);
		}
	}
}

let _registered = false;

/** Registers the agent-facing command group. Idempotent. */
export function registerBrowserViewAgentCommands(): void {
	if (_registered) {
		return;
	}
	_registered = true;
	CommandsRegistry.registerCommand('cursor.browserView.setRecordingType', (accessor: ServicesAccessor, arg1?: unknown, recordingType?: unknown, options?: unknown) => handleSetRecordingType(accessor, arg1, recordingType, options));
	CommandsRegistry.registerCommand('cursor.browserView.getRecordingType', (accessor: ServicesAccessor, arg1?: unknown, options?: unknown) => handleGetRecordingType(accessor, arg1, options));
	CommandsRegistry.registerCommand('cursor.browserView.configureDialogHandling', (accessor: ServicesAccessor, args?: unknown) => handleConfigureDialogHandling(accessor, args));
	CommandsRegistry.registerCommand('cursor.browserView.clearAgentDeviceEmulation', (accessor: ServicesAccessor, viewId?: unknown, options?: unknown) => handleClearAgentDeviceEmulation(accessor, viewId, options));
	registerAction2(CrashBrowserRendererAction);
	registerAction2(OrphanBrowserViewAction);
}
