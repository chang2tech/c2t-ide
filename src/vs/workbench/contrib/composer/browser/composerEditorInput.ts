/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Core port of the ide-agent chat editor tabs (CAT-C, hardest file).
//
// Source: extensions/ide-agent/src/services/chatEditorProvider.ts —
// `window.registerCustomEditorProvider("ideAgent.chatEditor", ...)` with document
// URIs `ide-chat:/<tabId>`. `CustomEditorProvider` only exists on the extension
// host, so there is no 1-1 port: this rewrites it as a native workbench editor
// (`EditorInput` + `EditorPane`, see composerEditor.ts), registered via
// `Registry.as<IEditorRegistry>(EditorExtensions.EditorPane)`.
//
// Old identifiers:
//   - viewType `ideAgent.chatEditor`  -> editor id `composer.chatEditor`
//   - scheme `ide-chat`               -> kept (`ide-chat:/<tabId>` URIs stay valid,
//                                        incl. the `resourceScheme == 'ide-chat'`
//                                        title-menu when-clauses)
//   - `vscode.openWith(uri, viewType)` -> `IEditorService.openEditor({ resource: uri })`

import { localize } from '../../../../nls.js';
import { URI } from '../../../../base/common/uri.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { CodeWindow } from '../../../../base/browser/window.js';
import { EditorInputCapabilities, IEditorSerializer, IUntypedEditorInput } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IOverlayWebview, IWebviewService } from '../../webview/browser/webview.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { buildReopenUntypedInput } from '../common/tabCloseRestore.js';

/** URI scheme for chat editor documents (unchanged from the extension). */
export const COMPOSER_CHAT_EDITOR_SCHEME = 'ide-chat';

/** Document URI for a chat tab (port of `chatEditorUriForTab`). */
export function composerChatEditorUriForTab(tabId: string): URI {
	return URI.from({ scheme: COMPOSER_CHAT_EDITOR_SCHEME, path: `/${tabId}` });
}

/**
 * Tab id from a chat editor document URI (undefined for foreign URIs).
 * Port of `tabIdFromUri` — keeps the fail-closed validation
 * (rejects `/../../..`, empty, `.`/`..`).
 */
export function composerChatTabIdFromUri(uri: URI): string | undefined {
	if (uri.scheme !== COMPOSER_CHAT_EDITOR_SCHEME) {
		return undefined;
	}
	const id = uri.path.replace(/^\//, '');
	if (!id || id.includes('/') || id === '.' || id === '..' || id.includes('..')) {
		return undefined;
	}
	return id;
}

/**
 * Editor input for one chat tab. Owns the `IOverlayWebview` (core webview host)
 * the same way `WebviewInput` does: the pane claims/releases it on visibility
 * changes so moving the tab between groups does not destroy webview state.
 *
 * TODO(composer): the tab lifetime is owned by the ported ChatTabService
 * (CAT-B). Until that lands, `getName()` returns a placeholder title — sync it
 * with the tab title via `setTitle()` + `_onDidChangeLabel` when the service
 * lands. `openComposerChatEditor()` in composerEditor.ts opens by tab id once
 * the service exists.
 */
export class ComposerChatEditorInput extends EditorInput {

	static readonly ID = 'composer.chatEditor';

	override get typeId(): string {
		return ComposerChatEditorInput.ID;
	}

	override get editorId(): string {
		return ComposerChatEditorInput.ID;
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton;
	}

	private readonly _webview: IOverlayWebview;
	private _title: string;

	/**
	 * Absolute fs path of the git worktree this chat tab is attached to
	 * (undefined = not attached). DEV-GAPS-18-W4
	 * (`agent-worktree-chat-actions`): fork equivalent of Cursor's chat-tab
	 * `gitWorktree.worktreePath` (workbench.glass.main.js 3.25.9) — the
	 * chat-tab overflow menu builder gates the worktree trio
	 * ("Copy worktree path" / "Open terminal in worktree" /
	 * "Open new window in worktree") on this value. Set by the worktree-attach
	 * flow (/worktree slash command); ordinary tabs leave it undefined.
	 */
	private _worktreePath: string | undefined;
	private readonly _onDidChangeWorktreePath = this._register(new Emitter<void>());
	/** Fires when {@link worktreePath} changes. */
	readonly onDidChangeWorktreePath: Event<void> = this._onDidChangeWorktreePath.event;

	constructor(
		readonly tabId: string,
		@IWebviewService webviewService: IWebviewService,
		@IThemeService private readonly themeService: IThemeService,
	) {
		super();
		this._title = localize('composerChatEditor.title', "Chat");
		this._webview = webviewService.createWebviewOverlay({
			providedViewType: ComposerChatEditorInput.ID,
			title: undefined,
			options: { enableFindWidget: true, retainContextWhenHidden: true },
			contentOptions: { allowScripts: true },
			extension: undefined,
		});
		this._register(this._webview);
		this._register(this.themeService.onDidColorThemeChange(() => this._onDidChangeLabel.fire()));
	}

	get resource(): URI {
		return composerChatEditorUriForTab(this.tabId);
	}

	/**
	 * WORKER-GAPS-66D (`tab-close-restore`): untyped form for HistoryService's
	 * recently-closed stack, so Cmd+Shift+T (`workbench.action.reopenClosedEditor`)
	 * restores a closed chat tab. Verbatim shape from the binary (Cursor 3.25.9,
	 * workbench.glass.main.js @27634878):
	 * `toUntyped(){return{resource:this.resource,options:{override:<chat editor id>}}}`.
	 * Without it the base EditorInput returns undefined and HistoryService
	 * drops the close event. Reopen restores the tab shell only — the
	 * transcript is intentionally not restored (product decision: checkpoint
	 * restore = files-only).
	 */
	override toUntyped(): IUntypedEditorInput {
		return buildReopenUntypedInput(this.resource, ComposerChatEditorInput.ID);
	}

	get webview(): IOverlayWebview {
		return this._webview;
	}

	/** Claim the overlay webview for a pane (mirrors WebviewInput.claim). */
	claim(claimant: unknown, targetWindow: CodeWindow, scopedContextKeyService: IContextKeyService | undefined): void {
		this._webview.claim(claimant, targetWindow, scopedContextKeyService);
	}

	/** TODO(composer): sync with the real tab title from ChatTabService. */
	setTitle(title: string): void {
		if (this._title !== title) {
			this._title = title;
			this._webview.setTitle(title);
			this._onDidChangeLabel.fire();
		}
	}

	/**
	 * The git worktree this chat tab is attached to (undefined = none).
	 * Drives the `composer.chatHasWorktree` context key and the worktree
	 * overflow-menu actions.
	 */
	get worktreePath(): string | undefined {
		return this._worktreePath;
	}

	/** Attach this chat tab to (or detach from) a git worktree. Fires {@link onDidChangeWorktreePath}. */
	setWorktreePath(worktreePath: string | undefined): void {
		if (this._worktreePath !== worktreePath) {
			this._worktreePath = worktreePath;
			this._onDidChangeWorktreePath.fire();
		}
	}

	override getName(): string {
		return this._title;
	}

	override getTitle(): string {
		return this.getName();
	}

	override getDescription(): string | undefined {
		return undefined;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (other === this) {
			return true;
		}
		if (other instanceof ComposerChatEditorInput) {
			return other.tabId === this.tabId;
		}
		const uri = (other as { resource?: URI }).resource;
		return !!uri && composerChatTabIdFromUri(uri) === this.tabId;
	}

	override dispose(): void {
		this._webview.dispose();
		super.dispose();
	}
}

/**
 * Serializer so `ide-chat:/<tabId>` editors survive window reload
 * (port of `backupCustomDocument`/`openCustomDocument`).
 *
 * TODO(composer): restore the tab through the ported ChatTabService when it
 * lands (today the tab model itself is not serialized — Cursor parity decision
 * "checkpoint restore = files-only, transcript NOT restored" applies here too).
 */
export class ComposerChatEditorSerializer implements IEditorSerializer {

	private static readonly PREFIX = 'composer.chatEditor:';

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) { }

	canSerialize(editor: EditorInput): boolean {
		return editor instanceof ComposerChatEditorInput;
	}

	serialize(editor: EditorInput): string | undefined {
		if (!(editor instanceof ComposerChatEditorInput)) {
			return undefined;
		}
		return ComposerChatEditorSerializer.PREFIX + editor.tabId;
	}

	deserialize(_instantiationService: IInstantiationService, serializedEditorInput: string): EditorInput | undefined {
		if (!serializedEditorInput.startsWith(ComposerChatEditorSerializer.PREFIX)) {
			return undefined;
		}
		const tabId = serializedEditorInput.slice(ComposerChatEditorSerializer.PREFIX.length);
		if (!composerChatTabIdFromUri(composerChatEditorUriForTab(tabId))) {
			return undefined;
		}
		// TODO(composer): re-attach to the existing tab via the ported ChatTabService
		// instead of creating a bare input (transcript is intentionally NOT restored —
		// product decision "checkpoint restore = files-only").
		return this.instantiationService.createInstance(ComposerChatEditorInput, tabId);
	}
}
