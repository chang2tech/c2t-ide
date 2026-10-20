/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `cursor.com/codebase` link commands (`cursorOrigin.copyCodeLink*`).
 *
 * Mirrors Cursor's workbench-core implementation (verified in the Cursor
 * 3.25.6/3.25.9 `workbench.desktop.main.js` bundles):
 *
 *  - two commands in the "Cursor Origin" category, both available from the
 *    command palette and gated on the `cursorOrigin.codeBrowseAllowed`
 *    context key:
 *      - `cursorOrigin.copyCodeLink` ("Copy cursor.com link (with selection)")
 *      - `cursorOrigin.copyCodeLinkWithoutRange` ("Copy cursor.com link (file only)")
 *  - share-menu entries (Editor/Explorer/EditorTitle "Share" submenus,
 *    group `0_cursor`, order 0) titled "Copy cursor.com link", plus an
 *    EditorLineNumberContext entry (group `1_cutcopypaste`, order 3); the
 *    menus are shown when `config.git.enabled` is set and the git extension
 *    is present (`git.missing` not set)
 *  - the link is `https://cursor.com/codebase/<owner>/<repo>/blob/<ref>/<path>`
 *    with an optional `#L<start>[-L<end>]` fragment; `<ref>` is the current
 *    history item ref name (falling back to its revision)
 *  - remote eligibility: host allowlist (`origin.cursor.com`,
 *    `origin-staging.cursor.com`, `github.com`) and owner allowlist
 *    (`anysphere`, `withgraphite`), refreshed from the SCM provider's
 *    `remotes` (synced over the extension API like Cursor does)
 *
 * HONEST DIVERGENCE:
 *  - Cursor's binary shows remotes synced from its built-in git extension
 *    into `SCMProvider.remotes`; this fork implements the same plumbing
 *    (extension API `SourceControl.remotes` -> `SCMProviderFeatures.remotes`
 *    -> `MainThreadSCMProvider.remotes`/`onDidChangeRemotes`), but keeps the
 *    extension API internal, exactly as Cursor's shipped `vscode.d.ts` does
 *    (no `remotes` declaration there).
 *  - The telemetry category inventory (`code_links`) that Cursor keeps for
 *    command-usage analytics is intentionally not replicated.
 */

import { Disposable, DisposableMap } from '../../../../base/common/lifecycle.js';
import { relativePath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ContextKeyExpr, IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { EditorResourceAccessor, SideBySideEditor } from '../../../common/editor.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ISCMRepository, ISCMService } from '../common/scm.js';
import {
	buildCodeLink,
	getCodeLinkSlug,
	ICodeLinkLineRange,
	isEligibleCodeLinkOwner,
} from '../common/codeLinks.js';

export const CODE_BROWSE_ALLOWED_CONTEXT_KEY = new RawContextKey<boolean>('cursorOrigin.codeBrowseAllowed', false);

const CODE_LINK_CATEGORY = localize2('cursorOrigin', 'Cursor Origin');
const CODE_LINK_MENU_TITLE = localize('codeLink.copy', 'Copy cursor.com link');

interface IResolvedCodeLinkTarget {
	readonly resourceUri: URI | undefined;
	readonly lineRange: ICodeLinkLineRange | undefined;
}

function isCodeLinkArg(value: unknown): value is { uri: URI; lineNumber?: number } {
	return !!value && typeof value === 'object' && 'uri' in value && URI.isUri((value as { uri: unknown }).uri);
}

function resolveCodeLinkTarget(
	codeEditorService: ICodeEditorService,
	uriIdentityService: IUriIdentityService,
	arg: unknown,
	activeEditorUri: URI | undefined
): IResolvedCodeLinkTarget {
	let uri: URI | undefined;
	let lineNumber: number | undefined;
	if (URI.isUri(arg)) {
		uri = arg;
	} else if (isCodeLinkArg(arg)) {
		uri = arg.uri;
		if (typeof arg.lineNumber === 'number') {
			lineNumber = arg.lineNumber;
		}
	}

	const focusedEditor = codeEditorService.getFocusedCodeEditor();
	const activeEditor = codeEditorService.getActiveCodeEditor();
	const targetUri = uri ?? activeEditorUri;
	const editors = [focusedEditor, activeEditor, ...codeEditorService.listCodeEditors()];
	const editor = targetUri
		? editors.find(candidate => candidate && uriIdentityService.extUri.isEqual(candidate.getModel()?.uri, targetUri)) ?? null
		: focusedEditor ?? activeEditor;
	const resourceUri = targetUri ?? editor?.getModel()?.uri;

	const selection = editor?.getSelection();
	let resolvedLineRange: ICodeLinkLineRange | undefined;
	if (selection && !selection.isEmpty()) {
		resolvedLineRange = { startLine: selection.startLineNumber, endLine: selection.endLineNumber };
	} else if (lineNumber !== undefined) {
		resolvedLineRange = { startLine: lineNumber, endLine: lineNumber };
	}
	return { resourceUri, lineRange: resolvedLineRange };
}

interface ICodeLinkInfo {
	readonly slug: { owner: string; repo: string };
	readonly refKey: string;
	readonly relativePath: string;
}

function getCodeLinkInfo(fileUri: URI, scmService: ISCMService): ICodeLinkInfo | undefined {
	const repository = scmService.getRepository(fileUri);
	if (!repository || repository.provider.contextValue.get() !== 'git' || !repository.provider.rootUri) {
		return undefined;
	}
	const slug = getCodeLinkSlug(repository.provider.remotes);
	if (!slug || !isEligibleCodeLinkOwner(slug.owner)) {
		return undefined;
	}
	const historyItemRef = repository.provider.historyProvider.get()?.historyItemRef.get();
	const refKey = historyItemRef?.name || historyItemRef?.revision;
	if (!refKey) {
		return undefined;
	}
	const path = relativePath(repository.provider.rootUri, fileUri);
	if (!path) {
		return undefined;
	}
	return { slug, refKey, relativePath: path };
}

function isCodeBrowseAllowed(scmService: ISCMService): boolean {
	for (const repository of scmService.repositories) {
		if (repository.provider.contextValue.get() !== 'git') {
			continue;
		}
		const slug = getCodeLinkSlug(repository.provider.remotes);
		if (slug && isEligibleCodeLinkOwner(slug.owner)) {
			return true;
		}
	}
	return false;
}

async function copyCodeLink(accessor: ServicesAccessor, arg: unknown, includeSelectionRange: boolean): Promise<void> {
	const scmService = accessor.get(ISCMService);
	const clipboardService = accessor.get(IClipboardService);
	const notificationService = accessor.get(INotificationService);
	const editorService = accessor.get(IEditorService);
	const codeEditorService = accessor.get(ICodeEditorService);
	const uriIdentityService = accessor.get(IUriIdentityService);

	const activeEditorUri = editorService.activeEditor
		? EditorResourceAccessor.getOriginalUri(editorService.activeEditor, { supportSideBySide: SideBySideEditor.PRIMARY })
		: undefined;
	const { resourceUri, lineRange } = resolveCodeLinkTarget(codeEditorService, uriIdentityService, arg, activeEditorUri);
	if (!resourceUri) {
		notificationService.warn(localize('codeLink.noFileOpen', 'No file is currently open.'));
		return;
	}
	const info = getCodeLinkInfo(resourceUri, scmService);
	if (info) {
		await clipboardService.writeText(buildCodeLink(info.slug, info.refKey, info.relativePath, includeSelectionRange ? lineRange : undefined));
		return;
	}
	notificationService.warn(localize('codeLink.cannotBuild', 'Could not build a cursor.com link. Open a file in a git repository with an eligible remote.'));
}

const codeBrowseWhen = ContextKeyExpr.and(
	CODE_BROWSE_ALLOWED_CONTEXT_KEY,
	ContextKeyExpr.has('config.git.enabled'),
	ContextKeyExpr.not('git.missing')
);

class CopyCodeLinkAction extends Action2 {
	static readonly ID = 'cursorOrigin.copyCodeLink';

	constructor() {
		super({
			id: CopyCodeLinkAction.ID,
			title: localize2('codeLink.copyWithSelection', 'Copy cursor.com link (with selection)'),
			category: CODE_LINK_CATEGORY,
			f1: true,
			precondition: CODE_BROWSE_ALLOWED_CONTEXT_KEY,
		});
	}

	override async run(accessor: ServicesAccessor, arg?: unknown): Promise<void> {
		return copyCodeLink(accessor, arg, true);
	}
}

class CopyCodeLinkWithoutRangeAction extends Action2 {
	static readonly ID = 'cursorOrigin.copyCodeLinkWithoutRange';

	constructor() {
		super({
			id: CopyCodeLinkWithoutRangeAction.ID,
			title: localize2('codeLink.copyFileOnly', 'Copy cursor.com link (file only)'),
			category: CODE_LINK_CATEGORY,
			f1: true,
			precondition: CODE_BROWSE_ALLOWED_CONTEXT_KEY,
		});
	}

	override async run(accessor: ServicesAccessor, arg?: unknown): Promise<void> {
		return copyCodeLink(accessor, arg, false);
	}
}

export class CodeBrowseWorkbenchContribution extends Disposable {
	static readonly ID = 'workbench.contrib.codeBrowse';

	private readonly _codeBrowseAllowedKey: IContextKey<boolean>;
	private readonly _repoRemoteListeners = new DisposableMap<string>();

	constructor(
		@ISCMService private readonly scmService: ISCMService,
		@IContextKeyService contextKeyService: IContextKeyService
	) {
		super();

		this._codeBrowseAllowedKey = CODE_BROWSE_ALLOWED_CONTEXT_KEY.bindTo(contextKeyService);
		this._register(this._repoRemoteListeners);
		this._register(this.scmService.onDidAddRepository(repository => {
			this._trackRepository(repository);
			this._refreshContext();
		}));
		this._register(this.scmService.onDidRemoveRepository(repository => {
			this._repoRemoteListeners.deleteAndDispose(repository.id);
			this._refreshContext();
		}));

		for (const repository of this.scmService.repositories) {
			this._trackRepository(repository);
		}
		this._refreshContext();
	}

	private _trackRepository(repository: ISCMRepository): void {
		if (this._repoRemoteListeners.has(repository.id)) {
			return;
		}
		const listener = repository.provider.onDidChangeRemotes?.(() => this._refreshContext());
		if (listener) {
			this._repoRemoteListeners.set(repository.id, listener);
		}
	}

	private _refreshContext(): void {
		this._codeBrowseAllowedKey.set(isCodeBrowseAllowed(this.scmService));
	}
}

registerAction2(CopyCodeLinkAction);
registerAction2(CopyCodeLinkWithoutRangeAction);

MenuRegistry.appendMenuItem(MenuId.EditorContextShare, {
	command: { id: CopyCodeLinkAction.ID, title: CODE_LINK_MENU_TITLE },
	when: codeBrowseWhen,
	group: '0_cursor',
	order: 0,
});
MenuRegistry.appendMenuItem(MenuId.ExplorerContextShare, {
	command: { id: CopyCodeLinkWithoutRangeAction.ID, title: CODE_LINK_MENU_TITLE },
	when: codeBrowseWhen,
	group: '0_cursor',
	order: 0,
});
MenuRegistry.appendMenuItem(MenuId.EditorTitleContextShare, {
	command: { id: CopyCodeLinkWithoutRangeAction.ID, title: CODE_LINK_MENU_TITLE },
	when: codeBrowseWhen,
	group: '0_cursor',
	order: 0,
});
MenuRegistry.appendMenuItem(MenuId.EditorLineNumberContext, {
	command: { id: CopyCodeLinkAction.ID, title: CODE_LINK_MENU_TITLE },
	when: codeBrowseWhen,
	group: '1_cutcopypaste',
	order: 3,
});

registerWorkbenchContribution2(CodeBrowseWorkbenchContribution.ID, CodeBrowseWorkbenchContribution, WorkbenchPhase.AfterRestored);
