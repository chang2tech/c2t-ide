/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Core port of the ide-agent sessions tree view (CAT-D).
//
// Source: `vscode.window.registerTreeDataProvider("ideAgent.sessionsView", ...)` in
// extensions/ide-agent/src/extension.ts `activate()`.
// Core equivalent: `ViewsRegistry.registerView` with an `ITreeViewDescriptor`
// whose `treeView` is a `TreeView` backed by our `ITreeViewDataProvider`
// (pattern: contrib/userDataSync/browser/userDataSyncViews.ts).
//
// Old view id `ideAgent.sessionsView` -> new view id `composer.sessions`
// (lives in the `composer` activity-bar container).

import { localize2 } from '../../../../nls.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { TreeView, TreeViewPane } from '../../../browser/parts/views/treeView.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IViewDescriptorService, ITreeViewDataProvider, ITreeItem, ITreeViewDescriptor, IViewsRegistry, Extensions as ViewExtensions, ViewContainer } from '../../../common/views.js';
import { IViewletViewOptions } from '../../../browser/parts/views/viewsViewlet.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IAccessibleViewInformationService } from '../../../services/accessibility/common/accessibleViewInformationService.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { IComposerService } from '../common/composerService.js';

export const COMPOSER_SESSIONS_VIEW_ID = 'composer.sessions';

/**
 * Tree data for the sessions view.
 *
 * TODO(composer): back this with real session rows once the engine bridge lands:
 *   - `getChildren()` should return one `ITreeItem` per chat session from
 *     `IComposerService` (title, mode icon, updated-at description, command
 *     `composer.session.open` with the session id as arg).
 *   - Port the extension's `SessionsTreeDataProvider` (selection context menu:
 *     rename / fork / delete / export transcript) as `TreeCommand`s on each item.
 *   - Fire refresh on `IComposerService.onDidChangeActiveSession` (and the
 *     session-list change event the real service will expose).
 */
export class ComposerSessionsDataProvider implements ITreeViewDataProvider {

	constructor(
		@IComposerService private readonly composerService: IComposerService,
		@INotificationService private readonly notificationService: INotificationService,
	) { }

	get isTreeEmpty(): boolean {
		return true;
	}

	async getChildren(_element?: ITreeItem): Promise<readonly ITreeItem[] | undefined> {
		// TODO(composer): return session rows (see class doc).
		void this.composerService;
		void this.notificationService;
		return [];
	}
}

/**
 * The sessions view pane. `TreeViewPane` pulls its `TreeView` from the view
 * descriptor registered in `registerComposerSessionsView` below.
 */
export class ComposerSessionsView extends TreeViewPane {

	static readonly ID = COMPOSER_SESSIONS_VIEW_ID;

	constructor(
		options: IViewletViewOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@INotificationService notificationService: INotificationService,
		@IHoverService hoverService: IHoverService,
		@IAccessibleViewInformationService accessibleViewService: IAccessibleViewInformationService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, notificationService, hoverService, accessibleViewService);
	}

	protected override renderTreeView(container: HTMLElement): void {
		super.renderTreeView(container);
		this.treeView.message = localize2('composerSessions.explanation', "Chat sessions live here.").value;
	}
}

/**
 * Register the `composer.sessions` tree view in the composer container.
 * Called from the composer workbench contribution (needs IInstantiationService).
 */
export function registerComposerSessionsView(container: ViewContainer, instantiationService: IInstantiationService): void {
	const id = COMPOSER_SESSIONS_VIEW_ID;
	const name = localize2('composerSessions', "Sessions");
	const treeView = instantiationService.createInstance(TreeView, id, name.value);
	treeView.dataProvider = instantiationService.createInstance(ComposerSessionsDataProvider);
	treeView.showRefreshAction = true;

	const descriptor: ITreeViewDescriptor = {
		id,
		name,
		ctorDescriptor: new SyncDescriptor(ComposerSessionsView),
		canToggleVisibility: true,
		canMoveView: true,
		collapsed: false,
		order: 1,
		treeView,
	};
	Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([descriptor], container);

	// Port of package.json `contributes.viewsWelcome`:
	// "No agent sessions yet.\nRun [New Chat](command:ide.newChat) to start."
	Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViewWelcomeContent(id, {
		content: localize2(
			'composerSessions.welcome',
			"No agent sessions yet.\nRun [New Chat](command:composer.newChat) to start."
		).value,
	});
}

/** Theme icon used for individual session rows (TODO: per-mode icons). */
export const composerSessionThemeIcon = Codicon.commentDiscussion;
