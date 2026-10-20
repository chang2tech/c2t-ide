/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Sidebar chat view (`composer.chat`).
//
// The chat HTML/JS (ported `components/composer.ts` in common/) is hosted in a
// core webview element reusing `getComposerChatHtml()` from composerEditor.ts —
// the exact same HTML the chat editor pane (`ComposerChatEditorPane`) hosts,
// and the same host<->webview message protocol (`ComposerChatMessage`) via the
// shared `ComposerChatEditorHost`. Interim step until the native-DOM rewrite
// lands (Cursor builds its chat UI with native DOM, not a webview).

import * as DOM from '../../../../base/browser/dom.js';
import { ViewPane, IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IWebviewService } from '../../webview/browser/webview.js';
import { IComposerService } from '../common/composerService.js';
import { ComposerChatEditorHost, getComposerChatHtml } from './composerEditor.js';
import './media/composer.css';

export const COMPOSER_CHAT_VIEW_ID = 'composer.chat';

export class ComposerView extends ViewPane {

	static readonly ID = COMPOSER_CHAT_VIEW_ID;

	private _host?: ComposerChatEditorHost;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IWebviewService private readonly webviewService: IWebviewService,
		@IComposerService private readonly composerService: IComposerService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		// P1 (migration-sidebar-chat-placeholder): host the chat UI in a core
		// webview element reusing the chat editor pane's HTML
		// (`getComposerChatHtml()`) instead of the "coming soon" placeholder.
		// The host<->webview message protocol is shared with
		// `ComposerChatEditorPane` via `ComposerChatEditorHost` so both
		// surfaces stay in lockstep until the native-DOM rewrite.
		const webview = this._register(this.webviewService.createWebviewElement({
			providedViewType: ComposerView.ID,
			title: undefined,
			options: { enableFindWidget: true, retainContextWhenHidden: true },
			contentOptions: { allowScripts: true },
			extension: undefined,
		}));
		webview.mountTo(container, DOM.getWindow(container));
		webview.setHtml(getComposerChatHtml());
		this._host = this._register(new ComposerChatEditorHost('sidebar', webview, this.composerService));
		this._host.postFullState();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		// The webview element is mounted inline in the body container and fills
		// it — no manual layout needed.
	}
}
