/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { KeyCode, KeyMod } from '../../../../../../base/common/keyCodes.js';
import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { upcastPartial } from '../../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { BrowserViewStorageScope, IBrowserViewEditorOpenOptions, IBrowserViewWorkbenchCreateOptions } from '../../../../../../platform/browserView/common/browserView.js';
import { MenuId, MenuRegistry, IMenuItem } from '../../../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { ContextKeyExpression, IContext } from '../../../../../../platform/contextkey/common/contextkey.js';
import { IEditorGroup, IEditorGroupsService } from '../../../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../../services/editor/common/editorService.js';
import { workbenchInstantiationService } from '../../../../../test/browser/workbenchTestServices.js';
import { IBrowserViewWorkbenchService } from '../../../common/browserView.js';
import { BrowserEditorInput, IBrowserEditorInputData } from '../../../common/browserEditorInput.js';
import {
	FocusBrowserLocationBarAction,
	NewBrowserTabAction,
	OpenBrowserEditorAction,
	OpenCursorWebsiteAction,
	ReloadBrowserTabAction,
} from '../../../electron-browser/features/browserTabPaletteCommands.js';

// DEV-GAPS-107 (`browser-tab-palette-commands`): Cursor 3.25.9 parity —
// the three View-category palette commands for the native browser tab.
// Binary evidence (workbench.desktop.main.js, re-extracted):
//   @21205469 workbench.action.newBrowserTab          "New Browser Tab"          f1:!0, CtrlCmd+T weight 500, when activeEditor==BrowserEditorID
//   @21206477 workbench.action.reloadBrowserTab       "Reload Browser Tab"       f1:!0, CtrlCmd+R weight 600, when activeEditor==BrowserEditorID
//   @21206895 workbench.action.focusBrowserLocationBar "Focus Browser Location Bar" f1:!0, CtrlCmd+L weight 600, when activeEditor==BrowserEditorID && !sideBarFocus && !panelFocus && !auxiliaryBarFocus
// The binary precondition (`cursor.browserTabEnabled == true` @19193643) is
// not copied: the fork has no such context key (see feature file header).
//
// DEV-GAPS-113 additions (same binary cluster, re-extracted):
//   @21203889 workbench.action.openBrowserEditor  "Open Browser"               f1:!1, menu MenubarAppearanceMenu 1_toggle_view order 4 (when = browserTabEnabled), no precondition/keybinding
//   @21207269 cursor.openCursorWebsite            "Open cursor.com in Browser" f1:!0, precondition browserTabEnabled; run delegates to openBrowserEditor with {url:"https://cursor.com"}

const BROWSER_EDITOR_ID = BrowserEditorInput.EDITOR_ID;

function contextWith(values: Record<string, unknown>): IContext {
	return { getValue: (key: string) => values[key] };
}

function keybindingOf(action: NewBrowserTabAction | ReloadBrowserTabAction | FocusBrowserLocationBarAction): { primary?: number; weight?: number; when?: ContextKeyExpression } {
	const keybinding = action.desc.keybinding;
	assert.ok(keybinding && !Array.isArray(keybinding), 'expected a single keybinding rule');
	return keybinding as { primary?: number; weight?: number; when?: ContextKeyExpression };
}

suite('Browser tab palette commands (DEV-GAPS-107)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('ids are the verbatim Cursor workbench.action ids', () => {
		assert.strictEqual(NewBrowserTabAction.ID, 'workbench.action.newBrowserTab');
		assert.strictEqual(ReloadBrowserTabAction.ID, 'workbench.action.reloadBrowserTab');
		assert.strictEqual(FocusBrowserLocationBarAction.ID, 'workbench.action.focusBrowserLocationBar');
	});

	test('titles are verbatim, category is View, all three are palette-visible (f1)', () => {
		const cases = [
			{ action: new NewBrowserTabAction(), title: 'New Browser Tab' },
			{ action: new ReloadBrowserTabAction(), title: 'Reload Browser Tab' },
			{ action: new FocusBrowserLocationBarAction(), title: 'Focus Browser Location Bar' },
		];
		for (const { action, title } of cases) {
			assert.strictEqual(action.desc.title.value, title);
			assert.strictEqual(action.desc.category?.value, 'View');
			assert.strictEqual(action.desc.f1, true);
			// No precondition: the binary's `cursor.browserTabEnabled`
			// context key does not exist in the fork (feature file header).
			assert.strictEqual(action.desc.precondition, undefined);
		}
	});

	test('each command appears exactly once in the Command Palette (no duplicate rows)', () => {
		const paletteItems = MenuRegistry.getMenuItems(MenuId.CommandPalette)
			.filter((i): i is IMenuItem => 'command' in i);
		for (const id of [NewBrowserTabAction.ID, ReloadBrowserTabAction.ID, FocusBrowserLocationBarAction.ID]) {
			assert.strictEqual(paletteItems.filter(i => i.command.id === id).length, 1, `expected exactly one palette row for ${id}`);
		}
		for (const title of ['New Browser Tab', 'Reload Browser Tab', 'Focus Browser Location Bar']) {
			assert.strictEqual(paletteItems.filter(i => i.command.title.value === title).length, 1, `expected exactly one palette row titled "${title}"`);
		}
	});

	test('GAPS-113 ids are the verbatim Cursor ids', () => {
		assert.strictEqual(OpenBrowserEditorAction.ID, 'workbench.action.openBrowserEditor');
		assert.strictEqual(OpenCursorWebsiteAction.ID, 'cursor.openCursorWebsite');
	});

	test('GAPS-113 Open Browser: verbatim title, View category, f1 false, no precondition/keybinding, Appearance menu item', () => {
		const action = new OpenBrowserEditorAction();
		assert.strictEqual(action.desc.title.value, 'Open Browser');
		assert.strictEqual(action.desc.category?.value, 'View');
		// Binary f1:!1 — deliberately NOT palette-visible.
		assert.strictEqual(action.desc.f1, false);
		assert.strictEqual(action.desc.precondition, undefined);
		assert.strictEqual(action.desc.keybinding, undefined);
		const menu = action.desc.menu;
		assert.ok(Array.isArray(menu) && menu.length === 1, 'expected exactly one menu item');
		assert.strictEqual(menu[0].id, MenuId.MenubarAppearanceMenu);
		assert.strictEqual(menu[0].group, '1_toggle_view');
		assert.strictEqual(menu[0].order, 4);
		// The binary menu `when` (cursor.browserTabEnabled) is not copied:
		// the fork has no such context key (see feature file header).
		assert.strictEqual(menu[0].when, undefined);
	});

	test('GAPS-113 Open cursor.com in Browser: verbatim title, View category, f1 true, no precondition/keybinding', () => {
		const action = new OpenCursorWebsiteAction();
		assert.strictEqual(action.desc.title.value, 'Open cursor.com in Browser');
		assert.strictEqual(action.desc.category?.value, 'View');
		assert.strictEqual(action.desc.f1, true);
		// Binary precondition `cursor.browserTabEnabled == true` not copied.
		assert.strictEqual(action.desc.precondition, undefined);
		assert.strictEqual(action.desc.keybinding, undefined);
	});

	test('GAPS-113 palette rows: Open cursor.com in Browser appears once; Open Browser stays out of the palette', () => {
		const paletteItems = MenuRegistry.getMenuItems(MenuId.CommandPalette)
			.filter((i): i is IMenuItem => 'command' in i);
		assert.strictEqual(paletteItems.filter(i => i.command.id === OpenCursorWebsiteAction.ID).length, 1);
		assert.strictEqual(paletteItems.filter(i => i.command.title.value === 'Open cursor.com in Browser').length, 1);
		assert.strictEqual(paletteItems.filter(i => i.command.id === OpenBrowserEditorAction.ID).length, 0);
	});

	test('New Browser Tab keybinding: CtrlCmd+T, weight 500, when browser editor active', () => {
		const keybinding = keybindingOf(new NewBrowserTabAction());
		assert.strictEqual(keybinding.primary, KeyMod.CtrlCmd | KeyCode.KeyT);
		assert.strictEqual(keybinding.weight, 500);
		assert.strictEqual(keybinding.when?.evaluate(contextWith({ activeEditor: BROWSER_EDITOR_ID })), true);
		assert.strictEqual(keybinding.when?.evaluate(contextWith({ activeEditor: 'workbench.editors.textEditor' })), false);
		assert.strictEqual(keybinding.when?.evaluate(contextWith({})), false);
	});

	test('Reload Browser Tab keybinding: CtrlCmd+R, weight 600, when browser editor active', () => {
		const keybinding = keybindingOf(new ReloadBrowserTabAction());
		assert.strictEqual(keybinding.primary, KeyMod.CtrlCmd | KeyCode.KeyR);
		assert.strictEqual(keybinding.weight, 600);
		assert.strictEqual(keybinding.when?.evaluate(contextWith({ activeEditor: BROWSER_EDITOR_ID })), true);
		assert.strictEqual(keybinding.when?.evaluate(contextWith({ activeEditor: 'workbench.editors.textEditor' })), false);
	});

	test('Focus Browser Location Bar keybinding: CtrlCmd+L, weight 600, gated on editor + no side/panel/aux focus', () => {
		const keybinding = keybindingOf(new FocusBrowserLocationBarAction());
		assert.strictEqual(keybinding.primary, KeyMod.CtrlCmd | KeyCode.KeyL);
		assert.strictEqual(keybinding.weight, 600);
		const when = keybinding.when!;
		assert.strictEqual(when.evaluate(contextWith({ activeEditor: BROWSER_EDITOR_ID })), true);
		assert.strictEqual(when.evaluate(contextWith({ activeEditor: BROWSER_EDITOR_ID, sideBarFocus: false, panelFocus: false, auxiliaryBarFocus: false })), true);
		assert.strictEqual(when.evaluate(contextWith({ activeEditor: BROWSER_EDITOR_ID, sideBarFocus: true })), false);
		assert.strictEqual(when.evaluate(contextWith({ activeEditor: BROWSER_EDITOR_ID, panelFocus: true })), false);
		assert.strictEqual(when.evaluate(contextWith({ activeEditor: BROWSER_EDITOR_ID, auxiliaryBarFocus: true })), false);
		assert.strictEqual(when.evaluate(contextWith({ activeEditor: 'workbench.editors.textEditor' })), false);
	});

	suite('handlers', () => {
		let disposables: DisposableStore;
		let instantiationService: ReturnType<typeof workbenchInstantiationService>;
		const activeEditorHolder: { current: BrowserEditorInput | undefined } = { current: undefined };
		let createdViews: { options: IBrowserViewWorkbenchCreateOptions; editorOpenOptions: IBrowserViewEditorOpenOptions | undefined }[];
		let executedCommands: { id: string; args: unknown[] }[];
		let inputs: BrowserEditorInput[];

		setup(() => {
			disposables = new DisposableStore();
			instantiationService = workbenchInstantiationService(undefined, disposables);
			activeEditorHolder.current = undefined;
			createdViews = [];
			executedCommands = [];
			inputs = [];

			const known = new Map<string, BrowserEditorInput>();
			const makeInput = (id: string): BrowserEditorInput => {
				const input = disposables.add(instantiationService.createInstance(BrowserEditorInput, { id } as IBrowserEditorInputData, async () => { throw new Error('no model in test'); }));
				inputs.push(input);
				known.set(id, input);
				return input;
			};

			// Stubbed before any BrowserEditorInput is created: its
			// constructor injects IBrowserViewWorkbenchService.
			instantiationService.stub(IBrowserViewWorkbenchService, upcastPartial<IBrowserViewWorkbenchService>({
				getKnownBrowserViews: () => known,
				createBrowserView: async (options: IBrowserViewWorkbenchCreateOptions, editorOpenOptions?: IBrowserViewEditorOpenOptions) => {
					createdViews.push({ options, editorOpenOptions });
					return known.get('source-view')!;
				},
			}));
			makeInput('source-view');
			instantiationService.stub(IEditorService, upcastPartial<IEditorService>({
				get activeEditor() { return activeEditorHolder.current; },
				get activeEditorPane() { return undefined; },
			}));
			instantiationService.stub(IEditorGroupsService, upcastPartial<IEditorGroupsService>({
				groups: [upcastPartial<IEditorGroup>({
					id: 7,
					get editors() { return [...known.values()]; },
				})],
			}));
			instantiationService.stub(ICommandService, upcastPartial<ICommandService>({
				executeCommand: async (id: string, ...args: unknown[]) => {
					executedCommands.push({ id, args });
					return undefined;
				},
			}));
		});

		teardown(() => {
			disposables.dispose();
		});

		test('New Browser Tab creates a user-owned ephemeral view, opened pinned', async () => {
			await instantiationService.invokeFunction(accessor => new NewBrowserTabAction().run(accessor));
			assert.strictEqual(createdViews.length, 1);
			assert.deepStrictEqual(createdViews[0].options.owner, { type: 'user' });
			assert.deepStrictEqual(createdViews[0].options.session, { scope: BrowserViewStorageScope.Ephemeral });
			assert.strictEqual(createdViews[0].options.initialUrl, undefined);
			assert.deepStrictEqual(createdViews[0].editorOpenOptions, { pinned: true, parentViewId: undefined });
		});

		test('New Browser Tab passes parentViewId only when the source editor is open in a group', async () => {
			await instantiationService.invokeFunction(accessor => new NewBrowserTabAction().run(accessor, { sourceBrowserId: 'source-view' }));
			assert.deepStrictEqual(createdViews[0].editorOpenOptions, { pinned: true, parentViewId: 'source-view' });

			await instantiationService.invokeFunction(accessor => new NewBrowserTabAction().run(accessor, { sourceBrowserId: 'not-open' }));
			assert.deepStrictEqual(createdViews[1].editorOpenOptions, { pinned: true, parentViewId: undefined });
		});

		test('Reload Browser Tab delegates to cursor.browserView.reload with the active browser id', async () => {
			activeEditorHolder.current = inputs[0];
			await instantiationService.invokeFunction(accessor => new ReloadBrowserTabAction().run(accessor));
			assert.deepStrictEqual(executedCommands, [{ id: 'cursor.browserView.reload', args: ['source-view'] }]);
		});

		test('Reload Browser Tab is a no-op when the active editor is not a browser editor', async () => {
			activeEditorHolder.current = undefined;
			await instantiationService.invokeFunction(accessor => new ReloadBrowserTabAction().run(accessor));
			assert.deepStrictEqual(executedCommands, []);
		});

		test('GAPS-113 Open Browser with no options opens a blank pinned tab in the foreground', async () => {
			await instantiationService.invokeFunction(accessor => new OpenBrowserEditorAction().run(accessor));
			assert.strictEqual(createdViews.length, 1);
			assert.deepStrictEqual(createdViews[0].options.owner, { type: 'user' });
			assert.deepStrictEqual(createdViews[0].options.session, { scope: BrowserViewStorageScope.Ephemeral });
			assert.strictEqual(createdViews[0].options.initialUrl, undefined);
			assert.deepStrictEqual(createdViews[0].editorOpenOptions, { pinned: true, preserveFocus: false, background: false });
		});

		test('GAPS-113 Open Browser passes a string url through as initialUrl and ignores non-string urls', async () => {
			await instantiationService.invokeFunction(accessor => new OpenBrowserEditorAction().run(accessor, { url: 'https://example.com/page' }));
			assert.strictEqual(createdViews[0].options.initialUrl, 'https://example.com/page');

			await instantiationService.invokeFunction(accessor => new OpenBrowserEditorAction().run(accessor, { url: 42 }));
			assert.strictEqual(createdViews[1].options.initialUrl, undefined);
		});

		test('GAPS-113 Open Browser maps inactive to background and defaults preserveFocus to inactive', async () => {
			await instantiationService.invokeFunction(accessor => new OpenBrowserEditorAction().run(accessor, { url: 'https://example.com/', inactive: true }));
			assert.deepStrictEqual(createdViews[0].editorOpenOptions, { pinned: true, preserveFocus: true, background: true });

			await instantiationService.invokeFunction(accessor => new OpenBrowserEditorAction().run(accessor, { preserveFocus: true }));
			assert.deepStrictEqual(createdViews[1].editorOpenOptions, { pinned: true, preserveFocus: true, background: false });
		});

		test('GAPS-113 Open cursor.com in Browser delegates to openBrowserEditor with the verbatim fallback url', async () => {
			await instantiationService.invokeFunction(accessor => new OpenCursorWebsiteAction().run(accessor));
			assert.deepStrictEqual(executedCommands, [{ id: 'workbench.action.openBrowserEditor', args: [{ url: 'https://cursor.com' }] }]);
			// The delegation must not itself create a view in this action.
			assert.strictEqual(createdViews.length, 0);
		});

		test('Focus Browser Location Bar is a no-op without an active browser editor pane', async () => {
			// activeEditorPane stub returns undefined; run must not throw.
			await instantiationService.invokeFunction(accessor => new FocusBrowserLocationBarAction().run(accessor));
		});
	});
});
