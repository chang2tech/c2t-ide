/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * IDE-CODE (DEV-GAPS-103, settings-autohide-editor): layout behavior for
 * Cursor's "Auto-Hide Editor When Empty" (Settings › General › Layout).
 *
 * Evidence and the pure guard live in common/autoHideEditor.ts. This file
 * is the fork equivalent of the binary's layout `registerLayoutListeners`
 * block (workbench.desktop.main.js @38454971):
 *   - trigger 1: an editor closes in a main editor group (binary registers
 *     `onDidCloseEditor` per main-part group and defers with
 *     `queueMicrotask`) → re-evaluate the guard;
 *   - trigger 2: part visibility changes where the panel went from visible
 *     to hidden, or the auxiliary bar went from hidden to visible →
 *     re-evaluate the guard;
 *   - hide action: the binary calls
 *     `setUnifiedMaximizeState(true, { skipHideSidebar: true })`. The fork
 *     has no unified maximize state; the observable equivalent is hiding
 *     the editor part (`setPartHidden(true, Parts.EDITOR_PART)`), which
 *     leaves the auxiliary bar (chat) with the freed space and does not
 *     touch the sidebar — matching `skipHideSidebar: true`.
 *   - restore: the binary's sibling listener un-maximizes when editors
 *     exist while the editor area is hidden. The fork only restores a
 *     part that this contribution itself hid (see
 *     shouldRestoreAutoHiddenEditor in common/autoHideEditor.ts), so a
 *     manually chosen layout is never overridden.
 *
 * The preference is read through the configuration service: the fork's
 * settings surface for the binary's `cursor/autoHideEditorWhenEmpty`
 * storage preference is `ide.window.autoHideEditorWhenEmpty`
 * (registered in common/composerConfiguration.ts, default false — so the
 * behavior is fully opt-in and cannot disturb the default layout).
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import {
	AUTO_HIDE_EDITOR_CONFIG_KEY,
	IAutoHideEditorLayoutState,
	shouldAutoHideEditor,
	shouldRestoreAutoHiddenEditor,
} from '../common/autoHideEditor.js';

export class AutoHideEditorContribution extends Disposable {
	static readonly ID = 'workbench.contrib.autoHideEditor';

	/** True only while the editor part is hidden by this contribution. */
	private hiddenByAutoHide = false;
	/** Fork equivalent of the binary's `isTogglingUnifiedMaximization` guard. */
	private toggling = false;

	constructor(
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IEditorService editorService: IEditorService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();

		// Binary trigger 1: per-group onDidCloseEditor, deferred with
		// queueMicrotask so group counts are settled before the guard runs.
		// The fork's IEditorService.onDidCloseEditor is workbench-wide; the
		// guard below only reads MAIN-part groups, exactly like the binary
		// (`editorGroupService.mainPart.groups`), so closes in auxiliary
		// windows cannot trigger a main-window hide.
		this._register(editorService.onDidCloseEditor(() => {
			queueMicrotask(() => this.evaluate());
		}));

		// Restore trigger: an editor becomes active while we hid the part
		// (the binary's sibling listener likewise hooks
		// onDidActiveEditorChange / onDidActivateGroup / onWillOpenEditor).
		this._register(editorService.onDidActiveEditorChange(() => {
			queueMicrotask(() => this.evaluateRestore());
		}));

		// Binary trigger 2: panel transition visible -> hidden, or
		// auxiliary bar transition hidden -> visible.
		let panelVisible = this.layoutService.isVisible(Parts.PANEL_PART);
		let auxiliaryBarVisible = this.layoutService.isVisible(Parts.AUXILIARYBAR_PART);
		this._register(this.layoutService.onDidChangePartVisibility(() => {
			const nextPanelVisible = this.layoutService.isVisible(Parts.PANEL_PART);
			const panelWasHidden = panelVisible && !nextPanelVisible;
			panelVisible = nextPanelVisible;
			const nextAuxiliaryBarVisible = this.layoutService.isVisible(Parts.AUXILIARYBAR_PART);
			const auxiliaryBarWasShown = !auxiliaryBarVisible && nextAuxiliaryBarVisible;
			auxiliaryBarVisible = nextAuxiliaryBarVisible;
			if (panelWasHidden || auxiliaryBarWasShown) {
				queueMicrotask(() => this.evaluate());
			}
			// Our own hide/show flips the editor part's visibility; keep
			// the restore path responsive to config changes too.
			if (!this.configurationService.getValue<boolean>(AUTO_HIDE_EDITOR_CONFIG_KEY) && this.hiddenByAutoHide) {
				queueMicrotask(() => this.evaluateRestore());
			}
		}));

		// Turning the preference off while the editor is auto-hidden
		// restores it (fork-local nicety; the binary's toggle-off path is
		// not dissected, so this is not claimed as Cursor behavior).
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(AUTO_HIDE_EDITOR_CONFIG_KEY)
				&& !this.configurationService.getValue<boolean>(AUTO_HIDE_EDITOR_CONFIG_KEY)) {
				this.evaluateRestore();
			}
		}));
	}

	private layoutState(): IAutoHideEditorLayoutState {
		return {
			autoHideEditorWhenEmpty: this.configurationService.getValue<boolean>(AUTO_HIDE_EDITOR_CONFIG_KEY) ?? false,
			panelVisible: this.layoutService.isVisible(Parts.PANEL_PART),
			auxiliaryBarVisible: this.layoutService.isVisible(Parts.AUXILIARYBAR_PART),
			editorVisible: this.layoutService.isVisible(Parts.EDITOR_PART, mainWindow),
			anyMainEditorGroupHasEditors: this.editorGroupsService.mainPart.groups.some(group => group.count > 0),
			togglingMaximization: this.toggling,
		};
	}

	private evaluate(): void {
		if (this.toggling || !shouldAutoHideEditor(this.layoutState())) {
			return;
		}
		this.toggling = true;
		try {
			// Binary: setUnifiedMaximizeState(true, { skipHideSidebar: true }).
			// Fork equivalent: hide only the editor part; sidebar untouched.
			this.layoutService.setPartHidden(true, Parts.EDITOR_PART);
			this.hiddenByAutoHide = true;
		} finally {
			this.toggling = false;
		}
	}

	private evaluateRestore(): void {
		if (this.toggling) {
			return;
		}
		const state = this.layoutState();
		if (!shouldRestoreAutoHiddenEditor({
			anyMainEditorGroupHasEditors: state.anyMainEditorGroupHasEditors,
			editorVisible: state.editorVisible,
			hiddenByAutoHide: this.hiddenByAutoHide,
		})) {
			return;
		}
		this.toggling = true;
		try {
			this.layoutService.setPartHidden(false, Parts.EDITOR_PART);
			this.hiddenByAutoHide = false;
		} finally {
			this.toggling = false;
		}
	}
}
