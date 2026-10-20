/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Core port of the ide-agent chat editor pane (CAT-C, hardest file).
//
// Source: `ChatEditorProvider.resolveCustomEditor` / `ChatEditorHost` in
// extensions/ide-agent/src/services/chatEditorProvider.ts.
// `CustomEditorProvider` has no core equivalent, so this is an `EditorPane`
// rewrite (not a custom-editor port): the pane hosts the chat UI in a core
// overlay webview (`IOverlayWebview` owned by `ComposerChatEditorInput`),
// mirroring `WebviewEditor` in contrib/webviewPanel/browser/webviewEditor.ts.
//
// ARCHITECTURE DECISION (CAT-C): the chat HTML/JS (`components/composer.ts`,
// `components/bubble.ts`) is KEPT AS-IS for now and hosted from the core
// webview below. TODO(composer): rewrite as native DOM widgets (Cursor builds
// its chat UI with native DOM, not a webview) — the postMessage protocol
// (`ComposerChatMessage`) is the seam: keep its shape stable so the HTML can
// be swapped for native widgets without touching the host.

import * as DOM from '../../../../base/browser/dom.js';
import { URI } from '../../../../base/common/uri.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IContextKeyService, IScopedContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IEditorGroup, IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IOverlayWebview, IWebview } from '../../webview/browser/webview.js';
import { IComposerService } from '../common/composerService.js';
import { ComposerChatEditorInput, composerChatTabIdFromUri } from './composerEditorInput.js';

/**
 * Host<->webview message protocol for the chat editor tab.
 * Port of `WebviewMessage` in chatEditorProvider.ts — the shape is kept stable
 * on purpose: the future native-DOM rewrite (see module doc) must speak the
 * same messages to the host.
 */
export type ComposerChatMessage =
	| { type: 'submit'; text: string; fullContext?: boolean; mentions?: unknown[]; sendMode?: 'default' | 'manual' | 'queue' | 'sendNow' }
	| { type: 'setMode'; mode: string }
	| { type: 'cycleMode' }
	| { type: 'acceptPlan' }
	| { type: 'discardPlan' }
	| { type: 'openModelPicker' }
	| { type: 'inputFocus'; focused: boolean }
	| { type: 'approvalResolve'; approvalId: string; optionId: string }
	| { type: 'webviewReady' }
	| { type: 'stopTurn' }
	| { type: 'restoreCheckpoint'; bubbleId: string }
	| { type: 'newTab' }
	| { type: 'switchTab'; tabId: string }
	| { type: 'closeTab'; tabId: string }
	| { type: 'renameTab'; tabId: string; title: string }
	| { type: 'queueRemove'; id: string }
	| { type: 'queueMove'; id: string; direction: -1 | 1 }
	| { type: 'queueSendNow'; id: string }
	| { type: 'answerQuestion'; questionId: string; optionId?: string; optionIds?: string[] }
	| { type: 'mentionQuery'; requestId: number; query: string }
	| { type: 'openMention'; chip: unknown };

/**
 * Webview host for ONE fixed chat surface: a chat editor tab
 * (`ComposerChatEditorPane`) or the sidebar chat view (`ComposerView`).
 * Port of `ChatEditorHost` (chatEditorProvider.ts): buffers outbound messages
 * until the webview signals `webviewReady` (bounded, 100, oldest-first —
 * REVERIFY-P3-1), and dispatches inbound messages to the composer service.
 *
 * TODO(composer): implement `handleMessage` against the ported services:
 *   - `submit` -> MentionService.composePromptWithMentions + ComposerDataService.submit
 *   - `mentionQuery` -> MentionService.getMentionItems -> post `mentionItems`
 *   - `openMention` -> openMentionTarget (IEditorService.openEditor / ITerminalService)
 *   - `approvalResolve` / `answerQuestion` / `stopTurn` / `restoreCheckpoint`
 *     -> ComposerDataService.reviews / abort / revertToCheckpoint
 *   - `newTab`/`switchTab`/`closeTab`/`renameTab` -> ported ChatTabService + openChatEditor()
 *   - `inputFocus` -> setContext `ideAgent.chatInputFocused` via IContextKeyService
 *   - mode/model/queue messages -> ComposerDataService modes/models/queue
 *   Until the CAT-A/CAT-B services are ported, the cases log-and-ignore so the
 *   pane opens without crashing.
 */
export class ComposerChatEditorHost extends Disposable {

	private readonly pendingOutbound: unknown[] = [];
	private static readonly MAX_PENDING_OUTBOUND = 100;
	private webviewReady = false;
	private disposed = false;

	constructor(
		private readonly tabId: string,
		private readonly webview: IWebview,
		@IComposerService private readonly composerService: IComposerService,
	) {
		super();
		this._register(this.webview.onMessage(({ message }) => {
			if (!this.disposed) {
				this.handleMessage(message as ComposerChatMessage);
			}
		}));
	}

	/** Post a host->webview message (buffers until `webviewReady`). */
	postToWebview(message: unknown): void {
		if (this.disposed) {
			return;
		}
		if (this.webviewReady) {
			this.webview.postMessage(message);
		} else {
			if (this.pendingOutbound.length >= ComposerChatEditorHost.MAX_PENDING_OUTBOUND) {
				this.pendingOutbound.shift();
			}
			this.pendingOutbound.push(message);
		}
	}

	/** Full transcript sync on (re-)resolve. TODO(composer): real state from ChatTabService. */
	postFullState(): void {
		this.postToWebview({ type: 'state', bubbles: [] });
		this.postToWebview({ type: 'queue', length: 0, items: [] });
		this.postToWebview({ type: 'turnState', running: false });
		this.postToWebview({ type: 'tabs', tabs: [] });
	}

	private handleMessage(message: ComposerChatMessage): void {
		if (!message || typeof message.type !== 'string') {
			return;
		}
		// TODO(composer): dispatch per the class doc. Kept explicit per-case so the
		// port of ChatEditorHost.handleMessage has a 1-1 checklist.
		switch (message.type) {
			case 'webviewReady':
				this.webviewReady = true;
				for (const pending of this.pendingOutbound.splice(0)) {
					this.webview.postMessage(pending);
				}
				break;
			case 'submit':
			case 'setMode':
			case 'cycleMode':
			case 'acceptPlan':
			case 'discardPlan':
			case 'openModelPicker':
			case 'inputFocus':
			case 'approvalResolve':
			case 'stopTurn':
			case 'restoreCheckpoint':
			case 'newTab':
			case 'switchTab':
			case 'closeTab':
			case 'renameTab':
			case 'queueRemove':
			case 'queueMove':
			case 'queueSendNow':
			case 'answerQuestion':
			case 'mentionQuery':
			case 'openMention':
				// TODO(composer): implement (see class doc).
				break;
		}
		void this.composerService;
		void this.tabId;
	}

	override dispose(): void {
		this.disposed = true;
		super.dispose();
	}
}

/**
 * TODO(composer): return the ported `createComposer()` HTML here.
 * `components/composer.ts` is a CAT-A file (only the `vscode.Webview` *type* is
 * used) — the port is: swap the param type for `{ postMessage }` and inline the
 * produced HTML string. Until then this shell keeps the pane functional: it
 * signals `webviewReady` so the host flushes, and renders a placeholder.
 *
 * Exported: the sidebar `ComposerView` reuses this exact HTML in a core
 * webview element (interim step until the native-DOM rewrite lands).
 */
export function getComposerChatHtml(): string {
	return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:24px}
</style></head><body>
<h2>${localize('composerChatEditor.placeholder', "Composer Chat")}</h2>
<p>${localize('composerChatEditor.placeholderBody', "The chat UI (ported composer.html) loads here once components/composer.ts is ported. The host protocol is ready.")}</p>
<script>
const vscode = acquireVsCodeApi();
vscode.postMessage({ type: 'webviewReady' });
window.addEventListener('message', () => { /* TODO(composer): render state/bubbles/queue */ });
</script>
</body></html>`;
}

export class ComposerChatEditorPane extends EditorPane {

	static readonly ID = 'composer.chatEditor';

	private _element?: HTMLElement;
	private _visible = false;
	private readonly _webviewVisibleDisposables = this._register(new DisposableStore());
	private readonly _onFocusWindowHandler = this._register(new MutableDisposable());
	private readonly _scopedContextKeyService = this._register(new MutableDisposable<IScopedContextKeyService>());
	private _host?: ComposerChatEditorHost;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IEditorService private readonly editorService: IEditorService,
		@IWorkbenchLayoutService private readonly workbenchLayoutService: IWorkbenchLayoutService,
		@IHostService private readonly hostService: IHostService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IComposerService private readonly composerService: IComposerService,
	) {
		super(ComposerChatEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	private get webview(): IOverlayWebview | undefined {
		return this.input instanceof ComposerChatEditorInput ? this.input.webview : undefined;
	}

	override get scopedContextKeyService(): IContextKeyService | undefined {
		return this._scopedContextKeyService.value;
	}

	protected createEditor(parent: HTMLElement): void {
		const element = document.createElement('div');
		this._element = element;
		this._element.id = `composer-chat-editor-${Math.random().toString(36).slice(2)}`;
		parent.appendChild(element);
		this._scopedContextKeyService.value = this._register(this.contextKeyService.createScoped(element));
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		if (input instanceof ComposerChatEditorInput) {
			this.claimWebview(input);
		}
	}

	override clearInput(): void {
		this._host?.dispose();
		this._host = undefined;
		this.webview?.release(this);
		this._webviewVisibleDisposables.clear();
		super.clearInput();
	}

	private claimWebview(input: ComposerChatEditorInput): void {
		input.claim(this, this.window, this.scopedContextKeyService);
		const webview = input.webview;
		if (this._element) {
			this._element.setAttribute('aria-flowto', webview.container.id);
			DOM.setParentFlowTo(webview.container, this._element);
		}
		// Host the chat UI in the core webview (CAT-C decision: keep the
		// composer HTML/JS for now; TODO native-DOM rewrite later).
		webview.setHtml(getComposerChatHtml());
		this._host?.dispose();
		this._host = new ComposerChatEditorHost(input.tabId, webview, this.composerService);
		this._webviewVisibleDisposables.add(this._host);
		this._host.postFullState();
	}

	override layout(dimension: DOM.Dimension): void {
		// TODO(composer): anchor the overlay webview to the pane element like
		// WebviewEditor.setWebviewAnchorElement does (clipping container etc.).
		this.setEditorVisible(dimension.width > 0 && dimension.height > 0);
	}

	protected override setEditorVisible(visible: boolean): void {
		if (visible === this._visible) {
			return;
		}
		this._visible = visible;
		if (this.input instanceof ComposerChatEditorInput && this.webview) {
			if (visible) {
				this.claimWebview(this.input);
			} else {
				this.webview.release(this);
			}
		}
		super.setEditorVisible(visible);
	}

	override focus(): void {
		super.focus();
		if (!this._onFocusWindowHandler.value) {
			this._onFocusWindowHandler.value = this.hostService.onDidChangeFocus(focused => {
				if (focused && this.editorService.activeEditorPane === this && this.workbenchLayoutService.hasFocus(Parts.EDITOR_PART)) {
					this.focus();
				}
			});
		}
		this.webview?.focus();
	}

	override dispose(): void {
		this._host?.dispose();
		this._element?.remove();
		this._element = undefined;
		super.dispose();
	}
}

/**
 * Open a chat tab as a real editor tab (port of `openChatEditor`).
 * TODO(composer): create/activate the tab through the ported ChatTabService when
 * it lands (today the tab model is not ported, so this opens a bare input).
 */
export async function openComposerChatEditor(
	editorService: IEditorService,
	instantiationService: IInstantiationService,
	tabId: string,
): Promise<void> {
	const input = instantiationService.createInstance(ComposerChatEditorInput, tabId);
	await editorService.openEditor(input, { pinned: true });
}

/** Port of `resolveChatEditorTab`: find the chat tab for a title-menu command. */
export function resolveComposerChatTabId(editorGroupsService: IEditorGroupsService, resource?: URI): string | undefined {
	if (resource) {
		const tabId = composerChatTabIdFromUri(resource);
		if (tabId) {
			return tabId;
		}
	}
	const active = editorGroupsService.activeGroup.activeEditor;
	if (active instanceof ComposerChatEditorInput) {
		return active.tabId;
	}
	return undefined;
}
