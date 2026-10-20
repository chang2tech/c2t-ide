/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { Event } from '../../../../base/common/event.js';
import { timeout } from '../../../../base/common/async.js';
import { isEqual } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { ISCMService } from '../../scm/common/scm.js';
import { GlassRemoteFileLinkAvailable, IPermalinkService } from '../common/permalink.js';
import { IRemoteFileLineRange } from '../common/permalinkUtils.js';
import { PermalinkService } from './permalinkService.js';

/**
 * Resolves the target file + line range for "Copy Remote URL".
 *
 * Mirrors Cursor's `i5v` helper (`contextmenuCommandTarget.js`, binary
 * evidence in `out/vs/workbench/workbench.glass.main.js`, Cursor 3.25.9
 * @28791132): the command argument may be a `URI` or a `{ uri, lineNumber? }`
 * object; otherwise the focused/active code editor is used, and a non-empty
 * selection becomes the line range.
 */
function getCopyRemoteFileLinkTarget(codeEditorService: ICodeEditorService, arg?: unknown): { resourceUri?: URI; lineRange?: IRemoteFileLineRange } {
	let uri: URI | undefined;
	let lineNumber: number | undefined;

	if (URI.isUri(arg)) {
		uri = arg;
	} else if (typeof arg === 'object' && arg !== null && 'uri' in arg && URI.isUri((arg as { uri: unknown }).uri)) {
		uri = (arg as { uri: URI }).uri;
		if ('lineNumber' in arg && typeof (arg as { lineNumber: unknown }).lineNumber === 'number') {
			lineNumber = (arg as { lineNumber: number }).lineNumber;
		}
	}

	const focusedEditor = codeEditorService.getFocusedCodeEditor();
	const activeEditor = codeEditorService.getActiveCodeEditor();
	const editors = [focusedEditor, activeEditor, ...codeEditorService.listCodeEditors()];
	const editor = uri
		? editors.find(candidate => !!candidate && isEqual(candidate.getModel()?.uri, uri)) ?? null
		: focusedEditor ?? activeEditor;

	const resourceUri = uri ?? editor?.getModel()?.uri;
	const selection = editor?.getSelection();

	let lineRange: IRemoteFileLineRange | undefined;
	if (selection && !selection.isEmpty()) {
		lineRange = { startLine: selection.startLineNumber, endLine: selection.endLineNumber };
	} else if (lineNumber !== undefined) {
		lineRange = { startLine: lineNumber, endLine: lineNumber };
	}

	return { resourceUri, lineRange };
}

export class CopyRemoteFileLinkAction extends Action2 {

	// Keep Cursor's command id so keybindings/menus referencing it keep working.
	static readonly ID = 'glass.editor.action.copyRemoteFileLink';

	constructor() {
		super({
			id: CopyRemoteFileLinkAction.ID,
			// Keep Cursor's localization key so strings stay aligned with upstream.
			title: localize2('glassCopyRemoteFileLink', 'Copy Remote URL'),
			// Fork note: Cursor's precondition is `and(isGlassFileTabEditor,
			// glassRemoteFileLinkAvailable)` (binary: `ft.and(Lxt,MRl)` with
			// `Lxt=isGlassFileTabEditor`, `MRl=glassRemoteFileLinkAvailable`,
			// workbench.glass.main.js 3.25.9 @45568527). `isGlassFileTabEditor`
			// is scoped to Cursor's glass file-tab editor UI, which this fork
			// does not have (the key is never true here); keeping it would
			// permanently disable the command, so the effective gate is the
			// availability key maintained by the permalink service.
			precondition: GlassRemoteFileLinkAvailable,
			// Cursor registers this command with `f1: !0` (binary @45568527):
			// it IS visible in the command palette.
			f1: true,
			menu: [
				{
					id: MenuId.EditorContextShare,
					group: '0_cursor',
					order: 1,
					when: GlassRemoteFileLinkAvailable,
				},
				{
					id: MenuId.EditorLineNumberContext,
					group: '1_cutcopypaste',
					order: 4,
					when: GlassRemoteFileLinkAvailable,
				},
			],
		});
	}

	override async run(accessor: ServicesAccessor, arg?: unknown): Promise<void> {
		const permalinkService = accessor.get(IPermalinkService);
		const clipboardService = accessor.get(IClipboardService);
		const notificationService = accessor.get(INotificationService);
		const scmService = accessor.get(ISCMService);
		const codeEditorService = accessor.get(ICodeEditorService);

		const { resourceUri, lineRange } = getCopyRemoteFileLinkTarget(codeEditorService, arg);
		if (!resourceUri) {
			return;
		}

		const resourceUriString = resourceUri.toString();
		let remoteUrl = permalinkService.resolveRemoteFileUrl(resourceUriString, lineRange);

		// The permalink service refreshes repository link data asynchronously. When
		// the file is inside a git repository but nothing is cached yet, wait
		// briefly for the refresh and retry once (mirrors Cursor: waits up to 2s
		// for `onDidChange`, then calls `resolveRemoteFileUrl` again).
		const repository = scmService.getRepository(resourceUri);
		if (!remoteUrl && repository && repository.provider.contextValue.get() === 'git') {
			const store = new DisposableStore();
			try {
				await Promise.race([
					Event.toPromise(permalinkService.onDidChange, store),
					timeout(2000),
				]);
			} finally {
				store.dispose();
			}
			remoteUrl = permalinkService.resolveRemoteFileUrl(resourceUriString, lineRange);
		}

		if (!remoteUrl) {
			notificationService.warn(localize('glassCopyRemoteFileLinkUnavailable', 'Could not resolve a remote URL for this file. It may be outside a git repository, or the repository may not have a pushed GitHub remote.'));
			return;
		}

		await clipboardService.writeText(remoteUrl);
		notificationService.notify({
			severity: Severity.Info,
			message: localize('glassCopiedRemoteFileLink', 'Copied remote URL to clipboard'),
			id: 'glass.copy-remote-url',
		});
	}
}

// Fork note: Cursor registers `glassPermalinkService` as Delayed and relies on
// its glass editor UI to instantiate it on file open. This fork has no glass
// editor UI, so the service is Eager: it must be alive from startup to keep
// `glassRemoteFileLinkAvailable` (which gates the command/menu) accurate.
registerSingleton(IPermalinkService, PermalinkService, InstantiationType.Eager);
registerAction2(CopyRemoteFileLinkAction);
