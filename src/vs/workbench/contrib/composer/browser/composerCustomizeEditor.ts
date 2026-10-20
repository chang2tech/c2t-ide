/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Core port of the ide-agent Customize editor tab (CAT-C).
//
// Source: extensions/ide-agent/src/services/customizeView.ts —
// `window.registerCustomEditorProvider("ideAgent.customizeEditor", ...)` with
// document URIs `ide-customize:/<section>` (sections: plugins, mcps, skills,
// subagents, rules, commands, hooks; default "plugins"). Same rewrite strategy
// as the chat editor: `CustomEditorProvider` -> `EditorInput` + `EditorPane`
// hosted in a core overlay webview.
//
// Old identifiers:
//   - viewType `ideAgent.customizeEditor` -> editor id `composer.customizeEditor`
//   - scheme `ide-customize`              -> kept (`ide-customize:/<section>`)
//   - `workbench.action.openCustomizeEditor` / `workbench.action.customize.open{Plugins,
//     MCPs,Skills,Subagents,Rules,Commands,Hooks}` -> kept as action ids
//     (composerActions.ts); they open this editor with the section pre-selected.
//
// ARCHITECTURE DECISION (CAT-C): the Customize HTML/JS is KEPT AS-IS for now,
// hosted from the core webview. TODO(composer): rewrite as native DOM widgets.

import * as DOM from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { URI } from '../../../../base/common/uri.js';
import { IContextKeyService, IScopedContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { CodeWindow } from '../../../../base/browser/window.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IEditorGroup, IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext, EditorInputCapabilities, IEditorSerializer, IUntypedEditorInput } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IOverlayWebview, IWebviewService } from '../../webview/browser/webview.js';
import { IComposerService } from '../common/composerService.js';
import { buildReopenUntypedInput } from '../common/tabCloseRestore.js';

/** URI scheme for the Customize editor (unchanged from the extension). */
export const COMPOSER_CUSTOMIZE_SCHEME = 'ide-customize';

/** Customize sections (port of CustomizeSectionId). */
export const COMPOSER_CUSTOMIZE_SECTIONS = ['plugins', 'mcps', 'skills', 'subagents', 'rules', 'commands', 'hooks'] as const;
export type ComposerCustomizeSection = typeof COMPOSER_CUSTOMIZE_SECTIONS[number];
export const COMPOSER_CUSTOMIZE_DEFAULT_SECTION: ComposerCustomizeSection = 'plugins';

export function composerCustomizeUriForSection(section: string): URI {
	return URI.from({ scheme: COMPOSER_CUSTOMIZE_SCHEME, path: `/${section}` });
}

export function composerCustomizeSectionFromUri(uri: URI): ComposerCustomizeSection | undefined {
	if (uri.scheme !== COMPOSER_CUSTOMIZE_SCHEME) {
		return undefined;
	}
	const id = uri.path.replace(/^\//, '');
	if (!id || id.includes('/') || id === '.' || id === '..' || id.includes('..')) {
		return undefined;
	}
	return (COMPOSER_CUSTOMIZE_SECTIONS as readonly string[]).includes(id)
		? id as ComposerCustomizeSection
		: undefined;
}

/** Editor input for the Customize tab (singleton — any section URI resolves here). */
export class ComposerCustomizeEditorInput extends EditorInput {

	static readonly ID = 'composer.customizeEditor';

	override get typeId(): string {
		return ComposerCustomizeEditorInput.ID;
	}

	override get editorId(): string {
		return ComposerCustomizeEditorInput.ID;
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton;
	}

	private readonly _webview: IOverlayWebview;

	constructor(
		readonly section: ComposerCustomizeSection,
		@IWebviewService webviewService: IWebviewService,
		@IThemeService private readonly themeService: IThemeService,
	) {
		super();
		this._webview = webviewService.createWebviewOverlay({
			providedViewType: ComposerCustomizeEditorInput.ID,
			title: undefined,
			options: { enableFindWidget: true, retainContextWhenHidden: true },
			contentOptions: { allowScripts: true },
			extension: undefined,
		});
		this._register(this._webview);
		this._register(this.themeService.onDidColorThemeChange(() => this._onDidChangeLabel.fire()));
	}

	get resource(): URI {
		return composerCustomizeUriForSection(this.section);
	}

	/**
	 * WORKER-GAPS-66D (`tab-close-restore`): untyped form for HistoryService's
	 * recently-closed stack, so Cmd+Shift+T restores a closed Customize tab
	 * on its section. Same mechanism as Cursor's composer inputs.
	 */
	override toUntyped(): IUntypedEditorInput {
		return buildReopenUntypedInput(this.resource, ComposerCustomizeEditorInput.ID, true);
	}

	get webview(): IOverlayWebview {
		return this._webview;
	}

	claim(claimant: unknown, targetWindow: CodeWindow, scopedContextKeyService: IContextKeyService | undefined): void {
		this._webview.claim(claimant, targetWindow, scopedContextKeyService);
	}

	override getName(): string {
		return localize('composerCustomize.title', "Customize");
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
		if (other instanceof ComposerCustomizeEditorInput) {
			return true; // singleton: every customize URI is this input
		}
		const uri = (other as { resource?: URI }).resource;
		return !!uri && composerCustomizeSectionFromUri(uri) !== undefined;
	}

	override dispose(): void {
		this._webview.dispose();
		super.dispose();
	}
}

export class ComposerCustomizeEditorSerializer implements IEditorSerializer {

	private static readonly PREFIX = 'composer.customizeEditor:';

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) { }

	canSerialize(editor: EditorInput): boolean {
		return editor instanceof ComposerCustomizeEditorInput;
	}

	serialize(editor: EditorInput): string | undefined {
		if (!(editor instanceof ComposerCustomizeEditorInput)) {
			return undefined;
		}
		return ComposerCustomizeEditorSerializer.PREFIX + editor.section;
	}

	deserialize(_instantiationService: IInstantiationService, serializedEditorInput: string): EditorInput | undefined {
		if (!serializedEditorInput.startsWith(ComposerCustomizeEditorSerializer.PREFIX)) {
			return undefined;
		}
		const section = serializedEditorInput.slice(ComposerCustomizeEditorSerializer.PREFIX.length);
		const valid = (COMPOSER_CUSTOMIZE_SECTIONS as readonly string[]).includes(section)
			? section as ComposerCustomizeSection
			: COMPOSER_CUSTOMIZE_DEFAULT_SECTION;
		return this.instantiationService.createInstance(ComposerCustomizeEditorInput, valid);
	}
}

/**
 * TODO(composer): return the ported customize HTML here.
 * `services/customizeView.ts` builds the whole Customize UI as an HTML string
 * (plugins / MCPs / skills / subagents / rules / commands / hooks). Port it
 * 1-1 (it only uses the `vscode.Webview` *type*) and inline the result.
 * Until then this shell keeps the pane functional.
 */
function getComposerCustomizeHtml(section: ComposerCustomizeSection): string {
	return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:24px}
</style></head><body>
<h2>${localize('composerCustomize.placeholder', "Customize")}</h2>
<p>${localize('composerCustomize.placeholderBody', "Section: {0}. The Customize UI (ported customizeView.ts HTML) loads here.", section)}</p>
<script>
const vscode = acquireVsCodeApi();
vscode.postMessage({ type: 'webviewReady', section: '${section}' });
window.addEventListener('message', () => { /* TODO(composer): render section data */ });
</script>
</body></html>`;
}

export class ComposerCustomizeEditorPane extends EditorPane {

	static readonly ID = 'composer.customizeEditor';

	private _element?: HTMLElement;
	private _visible = false;
	private readonly _webviewVisibleDisposables = this._register(new DisposableStore());
	private readonly _onFocusWindowHandler = this._register(new MutableDisposable());
	private readonly _scopedContextKeyService = this._register(new MutableDisposable<IScopedContextKeyService>());

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IEditorService private readonly editorService: IEditorService,
		@IWorkbenchLayoutService private readonly workbenchLayoutService: IWorkbenchLayoutService,
		@IHostService private readonly hostService: IHostService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IComposerService private readonly composerService: IComposerService,
	) {
		super(ComposerCustomizeEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	private get webview(): IOverlayWebview | undefined {
		return this.input instanceof ComposerCustomizeEditorInput ? this.input.webview : undefined;
	}

	override get scopedContextKeyService(): IContextKeyService | undefined {
		return this._scopedContextKeyService.value;
	}

	protected createEditor(parent: HTMLElement): void {
		const element = document.createElement('div');
		this._element = element;
		parent.appendChild(element);
		this._scopedContextKeyService.value = this._register(this.contextKeyService.createScoped(element));
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		if (input instanceof ComposerCustomizeEditorInput) {
			this.claimWebview(input);
		}
	}

	override clearInput(): void {
		this.webview?.release(this);
		this._webviewVisibleDisposables.clear();
		super.clearInput();
	}

	private claimWebview(input: ComposerCustomizeEditorInput): void {
		input.claim(this, this.window, this.scopedContextKeyService);
		const webview = input.webview;
		if (this._element) {
			this._element.setAttribute('aria-flowto', webview.container.id);
			DOM.setParentFlowTo(webview.container, this._element);
		}
		// CAT-C decision: keep the Customize HTML/JS for now; TODO native-DOM rewrite.
		webview.setHtml(getComposerCustomizeHtml(input.section));
		this._webviewVisibleDisposables.add(webview.onMessage(({ message }) => {
			this.handleMessage(message as { type?: string });
		}));
	}

	/**
	 * TODO(composer): dispatch the Customize webview protocol here (port of
	 * `CustomizeWebviewMessage` handling in customizeView.ts ~905):
	 * section data requests (plugins/MCPs/skills/subagents/rules/commands/hooks),
	 * hook log clear, plugin enable/disable/uninstall, subagent file write, etc.
	 */
	private handleMessage(message: { type?: string }): void {
		if (!message || typeof message.type !== 'string') {
			return;
		}
		void this.composerService;
		void this.editorGroupsService;
		// TODO(composer): implement per message type.
	}

	override layout(dimension: DOM.Dimension): void {
		this.setEditorVisible(dimension.width > 0 && dimension.height > 0);
	}

	protected override setEditorVisible(visible: boolean): void {
		if (visible === this._visible) {
			return;
		}
		this._visible = visible;
		if (this.input instanceof ComposerCustomizeEditorInput && this.webview) {
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
		this._element?.remove();
		this._element = undefined;
		super.dispose();
	}
}

/**
 * Open the Customize editor tab (port of the `ide.openCustomize` /
 * `workbench.action.openCustomizeEditor` handlers), optionally pre-selecting
 * a section (`workbench.action.customize.open{Plugins,...}`).
 */
export async function openComposerCustomizeEditor(
	editorService: IEditorService,
	instantiationService: IInstantiationService,
	section: ComposerCustomizeSection = COMPOSER_CUSTOMIZE_DEFAULT_SECTION,
): Promise<void> {
	const input = instantiationService.createInstance(ComposerCustomizeEditorInput, section);
	await editorService.openEditor(input, { pinned: true });
}
