/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { EditorExtensions, IEditorFactoryRegistry } from '../../../common/editor.js';
import { BrowserEditor } from './browserEditor.js';
import { BrowserEditorInput, BrowserEditorSerializer } from '../common/browserEditorInput.js';
import { BrowserViewUri } from '../../../../platform/browserView/common/browserViewUri.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IEditorResolverService, RegisteredEditorPriority } from '../../../services/editor/common/editorResolverService.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { Schemas } from '../../../../base/common/network.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IBrowserViewCDPService, IBrowserViewWorkbenchService } from '../common/browserView.js';
import { BrowserViewWorkbenchService } from './browserViewWorkbenchService.js';
import { BrowserViewCDPService } from './browserViewCDPService.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { logBrowserOpen } from '../../../../platform/browserView/common/browserViewTelemetry.js';

// Register actions and browser features
import './features/webContentsViewRendererFeature.js';
import './features/browserNavigationFeatures.js';
import './features/browserWelcomeFeature.js';
import './features/browserFavoritesFeature.js';
import './features/browserHistoryFeature.js';
import './features/browserPermissionsFeature.js';
import './features/browserDataStorageFeatures.js';
import './features/browserBookmarkBarFeature.js';
import './features/browserDevToolsFeature.js';
import './features/browserConsoleFeature.js';
import './features/browserEditorChatFeatures.js';
import './features/browserPickerFeature.js';
import './features/browserDesignModeFeature.js';
import './features/browserDesignModeVoiceFeature.js';
import './features/browserDesignModeDrawingFeature.js';
import './features/browserEditorNativeMenuFeatures.js';
import './features/browserEditorErrorFeatures.js';
import './features/browserEditorZoomFeature.js';
import './features/browserEditorEmulationFeatures.js';
import './features/browserAutoReloadFeatures.js';
import './features/browserEditorFindFeature.js';
import './features/browserSearchFeatures.js';
import './features/browserTabManagementFeatures.js';
import './features/browserRemoteFeatures.js';
// DEV-GAPS-54 (2026-10-20): reimplemented Cursor-parity command surface.
// The 4 command groups (tab/nav/capture/agent) are real now; binary evidence:
// Cursor 3.25.9 registers 29 cursor.browserView.* + bare browserView.blur via
// registerCommand (workbench.{glass,desktop}.main.js @40541183-40555886) and
// the two cursor.browserView.debug.* actions via registerAction2
// (glass @48337991/@48338882).
import './features/browserViewCommandSurface.js';
// DEV-GAPS-107 (2026-10-20): Cursor-parity palette commands for the browser
// tab (workbench.action.newBrowserTab / reloadBrowserTab /
// focusBrowserLocationBar; binary evidence in the feature file).
import './features/browserTabPaletteCommands.js';
// DEV-GAPS-147 (2026-10-20): Cursor-parity localhost link routing — the
// OpenerService interceptor for "Open Local Links in Cursor Browser"
// (binary evidence in the feature file and common/openLocalLinks.ts).
import './features/openLocalLinksOpener.js';

function getBrowserViewStateUrl(viewState: object | undefined): string | undefined {
	const url = Object.entries(viewState ?? {}).find(([key]) => key === 'url')?.[1];
	return typeof url === 'string' ? url : undefined;
}

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		BrowserEditor,
		BrowserEditorInput.EDITOR_ID,
		localize('browser.editorLabel', "Browser")
	),
	[
		new SyncDescriptor(BrowserEditorInput)
	]
);

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(
	BrowserEditorInput.ID,
	BrowserEditorSerializer
);

class BrowserEditorResolverContribution implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.browserEditorResolver';

	constructor(
		@IEditorResolverService editorResolverService: IEditorResolverService,
		@IBrowserViewWorkbenchService browserViewWorkbenchService: IBrowserViewWorkbenchService,
		@ITelemetryService telemetryService: ITelemetryService,
	) {
		editorResolverService.registerEditor(
			`${Schemas.vscodeBrowser}:/**`,
			{
				id: BrowserEditorInput.EDITOR_ID,
				label: localize('browser.editorLabel', "Browser"),
				priority: RegisteredEditorPriority.exclusive
			},
			{
				canSupportResource: resource => resource.scheme === Schemas.vscodeBrowser,
				singlePerResource: true
			},
			{
				createEditorInput: ({ resource, options }) => {
					const parsed = BrowserViewUri.parse(resource);
					if (!parsed) {
						throw new Error(`Invalid browser view resource: ${resource.toString()}`);
					}

					const browserInput = browserViewWorkbenchService.getOrCreateLazy({
						id: parsed.id,
						...options?.viewState
					});

					// Start resolving the input right away. This will create the browser view.
					// This allows browser views to be loaded in the background.
					void browserInput.resolve();

					return {
						editor: browserInput,
						options: {
							pinned: !!browserInput.url, // pin if navigated
							...options
						}
					};
				}
			}
		);

		for (const extension of ['html', 'htm', 'mhtml', 'mht']) {
			editorResolverService.registerEditor(
				`${Schemas.file}:/**/*.${extension}`,
				{
					id: BrowserEditorInput.EDITOR_ID,
					label: localize('browser.htmlEditorLabel', "Integrated Browser"),
					priority: RegisteredEditorPriority.option
				},
				{
					canSupportResource: resource => resource.scheme === Schemas.file,
					singlePerResource: true
				},
				{
					createEditorInput: ({ resource, options }) => {
						logBrowserOpen(telemetryService, 'fileResource');

						const viewState = options?.viewState;
						const browserInput = browserViewWorkbenchService.getOrCreateLazy({
							id: generateUuid(),
							associatedResource: resource,
							...viewState,
							url: getBrowserViewStateUrl(viewState) ?? resource.toString()
						});
						void browserInput.resolve();

						return {
							editor: browserInput,
							options: {
								pinned: true,
								...options
							}
						};
					}
				}
			);
		}
	}
}

registerWorkbenchContribution2(BrowserEditorResolverContribution.ID, BrowserEditorResolverContribution, WorkbenchPhase.BlockStartup);

registerSingleton(IBrowserViewWorkbenchService, BrowserViewWorkbenchService, InstantiationType.Delayed);
registerSingleton(IBrowserViewCDPService, BrowserViewCDPService, InstantiationType.Delayed);
