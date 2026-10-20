/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Disposable, DisposableStore, IDisposable } from '../../../../../../base/common/lifecycle.js';
import { upcastPartial } from '../../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { CommandsRegistry } from '../../../../../../platform/commands/common/commands.js';
import { BrowserViewStorageScope, IBrowserViewEditorOpenOptions, IBrowserViewOwner } from '../../../../../../platform/browserView/common/browserView.js';
import { CDPRequest, CDPResponse } from '../../../../../../platform/browserView/common/cdp/types.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { EditorActivation } from '../../../../../../platform/editor/common/editor.js';
import { IEditorService, type PreferredGroup } from '../../../../../services/editor/common/editorService.js';
import { IEditorGroup, IEditorGroupsService } from '../../../../../services/editor/common/editorGroupsService.js';
import { workbenchInstantiationService } from '../../../../../test/browser/workbenchTestServices.js';
import { IBrowserViewCDPService, IBrowserViewModel, IBrowserViewWorkbenchCreateOptions, IBrowserViewWorkbenchService } from '../../../common/browserView.js';
import { BrowserEditorInput, IBrowserEditorInputData } from '../../../common/browserEditorInput.js';
import '../../../electron-browser/features/browserViewCommandSurface.js';
import { getLastInteractedViewId, normalizeArgs, noteLastInteracted, resolveBrowserViewOrThrow, resolveViewIdSoft } from '../../../electron-browser/features/browserViewCommandUtils.js';

type TestModel = IBrowserViewModel & { calls: string[] };

function createModel(owner: IBrowserViewOwner = { type: 'user' }, overrides: Record<string, unknown> = {}): TestModel {
	const calls: string[] = [];
	const model = upcastPartial<IBrowserViewModel>({
		url: 'https://example.com/',
		title: 'Example',
		loading: false,
		owner,
		onDidChangeLoadingState: Event.None,
		onDidNavigate: Event.None,
		loadURL: async (url: string) => { calls.push(`loadURL:${url}`); },
		goBack: async () => { calls.push('goBack'); },
		goForward: async () => { calls.push('goForward'); },
		reload: async (hard?: boolean) => { calls.push(`reload:${hard}`); },
		getConsoleLogs: async () => 'log line 1\nlog line 2',
		captureScreenshot: async () => VSBuffer.fromString('png-bytes'),
		setDevice: async () => { calls.push('setDevice'); },
		setVisible: async () => { calls.push('setVisible'); },
		focus: async () => { calls.push('focus'); },
		dispose: () => { calls.push('dispose'); },
		...overrides,
	});
	return Object.assign(model, { calls });
}

class TestCDPService implements IBrowserViewCDPService {
	declare readonly _serviceBrand: undefined;
	readonly sent: { groupId: string; message: CDPRequest }[] = [];
	readonly destroyed: string[] = [];
	readonly createdFor: string[] = [];
	respond: (message: CDPRequest) => CDPResponse | { method: string; params: unknown } = () => ({ id: 0, result: undefined });
	private _seq = 0;
	private readonly _emitters = new Map<string, Emitter<CDPResponse | { method: string; params: unknown }>>();

	async createSessionGroup(browserId: string): Promise<string> {
		const groupId = `group-${++this._seq}`;
		this.createdFor.push(browserId);
		this._emitters.set(groupId, new Emitter());
		return groupId;
	}

	async destroySessionGroup(groupId: string): Promise<void> {
		this.destroyed.push(groupId);
		this._emitters.get(groupId)?.dispose();
		this._emitters.delete(groupId);
	}

	async sendCDPMessage(groupId: string, message: CDPRequest): Promise<void> {
		this.sent.push({ groupId, message });
		const emitter = this._emitters.get(groupId);
		const response = this.respond(message);
		queueMicrotask(() => emitter?.fire(response as CDPResponse));
	}

	onCDPMessage(groupId: string): Event<CDPResponse | { method: string; params: unknown }> {
		return this._emitters.get(groupId)!.event;
	}

	onDidDestroy(_groupId: string): Event<void> {
		return Event.None;
	}
}

suite('BrowserView command surface (cursor.browserView.*)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	let disposables: DisposableStore;
	let instantiationService: ReturnType<typeof workbenchInstantiationService>;
	let browserViews: TestBrowserViewService;
	let cdpService: TestCDPService;
	let warnings: string[];
	let infos: string[];
	let openedEditors: { editor: unknown; options: unknown }[];
	let closedEditors: unknown[];
	const activeEditorHolder: { current: BrowserEditorInput | undefined } = { current: undefined };

	class TestBrowserViewService implements IBrowserViewWorkbenchService {
		declare readonly _serviceBrand: undefined;
		readonly onDidChangeBrowserViews = Event.None;
		readonly onDidChangeSharingAvailable = Event.None;
		readonly isSharingAvailable = false;
		readonly known = new Map<string, BrowserEditorInput>();
		lastCreate: { options: IBrowserViewWorkbenchCreateOptions; editorOpenOptions: IBrowserViewEditorOpenOptions | undefined } | undefined;
		private _seq = 0;

		willUseRemoteProxy(): boolean { return false; }
		setRemoteProxyInfo(): void { }
		getKnownBrowserViews(): Map<string, BrowserEditorInput> { return this.known; }
		registerContextualFilter(): IDisposable { return Disposable.None; }
		getContextualBrowserViews(): Map<string, BrowserEditorInput> { return this.known; }
		async getPreferredGroup(preferredGroup?: PreferredGroup): Promise<PreferredGroup | undefined> { return preferredGroup; }
		registerOpenHandler(): IDisposable { return Disposable.None; }

		addInput(id: string, model: TestModel): BrowserEditorInput {
			const input = disposables.add(instantiationService.createInstance(BrowserEditorInput, { id } as IBrowserEditorInputData, async () => model));
			input.model = model;
			this.known.set(id, input);
			return input;
		}

		async createBrowserView(options: IBrowserViewWorkbenchCreateOptions, editorOpenOptions?: IBrowserViewEditorOpenOptions): Promise<BrowserEditorInput> {
			this.lastCreate = { options, editorOpenOptions };
			const model = createModel(options.owner);
			const input = this.addInput(`view-${++this._seq}`, model);
			if (options.initialUrl) {
				await model.loadURL(options.initialUrl);
			}
			return input;
		}

		async createExternalBrowserView(): Promise<IBrowserViewModel> { throw new Error('not implemented'); }
		getOrCreateLazy(data: IBrowserEditorInputData): BrowserEditorInput {
			const existing = this.known.get(data.id);
			if (existing) { return existing; }
			return this.addInput(data.id, createModel());
		}
		async clearGlobalStorage(): Promise<void> { }
		async clearWorkspaceStorage(): Promise<void> { }
	}

	function invoke(id: string, ...args: unknown[]): Promise<unknown> {
		const command = CommandsRegistry.getCommand(id);
		assert.ok(command, `command ${id} is registered`);
		return instantiationService.invokeFunction(command!.handler as (...a: unknown[]) => Promise<unknown>, ...args);
	}

	setup(() => {
		warnings = [];
		infos = [];
		openedEditors = [];
		closedEditors = [];
		activeEditorHolder.current = undefined;
		disposables = new DisposableStore();
		instantiationService = workbenchInstantiationService(undefined, disposables);
		browserViews = new TestBrowserViewService();
		cdpService = new TestCDPService();
		instantiationService.stub(IBrowserViewWorkbenchService, browserViews);
		instantiationService.stub(IBrowserViewCDPService, cdpService);
		instantiationService.stub(ILogService, upcastPartial<ILogService>({
			warn: (message: string) => { warnings.push(message); },
			info: (message: string) => { infos.push(message); },
		}));
		instantiationService.stub(IEditorService, upcastPartial<IEditorService>({
			get activeEditor() { return activeEditorHolder.current; },
			openEditor: async (editor: unknown, options?: unknown) => {
				openedEditors.push({ editor, options });
				return undefined as never;
			},
		}));
		instantiationService.stub(IEditorGroupsService, upcastPartial<IEditorGroupsService>({
			groups: [upcastPartial<IEditorGroup>({
				id: 1,
				get editors() { return [...browserViews.known.values()]; },
				closeEditor: async (editor: unknown) => { closedEditors.push(editor); return true; },
			})],
		}));
	});

	teardown(() => {
		disposables.dispose();
	});

	test('registers the full 34-command surface', () => {
		const ids = [
			'cursor.browserView.newTab', 'cursor.browserView.closeTab', 'cursor.browserView.hideTab',
			'cursor.browserView.showHeadlessTab', 'cursor.browserView.newHeadlessTab', 'cursor.browserView.isHeadless',
			'cursor.browserView.selectTab', 'cursor.browserView.focusOrShowTab', 'cursor.browserView.listTabs',
			'cursor.browserView.setLocked', 'cursor.browserView.isLocked', 'browserView.blur',
			'cursor.browserView.navigate', 'cursor.browserView.reload', 'cursor.browserView.goBack',
			'cursor.browserView.goForward', 'cursor.browserView.getURL', 'cursor.browserView.getTitle',
			'cursor.browserView.resize',
			'cursor.browserView.executeJavaScript', 'cursor.browserView.executeJavaScriptInIsolatedWorld',
			'cursor.browserView.takeScreenshot', 'cursor.browserView.updateScreenshot',
			'cursor.browserView.getConsoleLogs', 'cursor.browserView.getNetworkRequests',
			'cursor.browserView.sendCDPCommand',
			'cursor.browserView.setRecordingType', 'cursor.browserView.getRecordingType',
			'cursor.browserView.configureDialogHandling', 'cursor.browserView.clearAgentDeviceEmulation',
			'cursor.browserView.debug.crashRenderer', 'cursor.browserView.debug.orphanView',
			'cursor.browserOriginAllowlist.ensureNavigationAllowed',
			'cursor.browserOriginAllowlist.ensurePageOriginAllowed',
		];
		for (const id of ids) {
			assert.ok(CommandsRegistry.getCommand(id), `missing command ${id}`);
		}
	});

	// --- resolution (binary A8e) -------------------------------------------------

	test('resolveBrowserViewOrThrow: explicit missing id throws Browser view not found', async () => {
		await assert.rejects(
			instantiationService.invokeFunction(accessor => resolveBrowserViewOrThrow(accessor, { viewId: 'nope' })),
			/^Error: Browser view not found$/
		);
	});

	test('resolveBrowserViewOrThrow: no views at all throws No browser view available', async () => {
		await assert.rejects(
			instantiationService.invokeFunction(accessor => resolveBrowserViewOrThrow(accessor, {})),
			/^Error: No browser view available$/
		);
	});

	test('resolveViewIdSoft: lastInteracted is preferred over the active editor', async () => {
		const m1 = createModel();
		const m2 = createModel();
		browserViews.addInput('v1', m1);
		const input2 = browserViews.addInput('v2', m2);
		activeEditorHolder.current = input2;
		noteLastInteracted('v1');
		const id = instantiationService.invokeFunction(accessor => resolveViewIdSoft(accessor, {}));
		assert.strictEqual(id, 'v1');
	});

	test('resolveViewIdSoft: agent-owned view is hidden from another agent', async () => {
		browserViews.addInput('agent-view', createModel({ type: 'agent', sessionId: 'agent-A' }));
		const asB = instantiationService.invokeFunction(accessor => resolveViewIdSoft(accessor, { ownerAgentId: 'agent-B' }));
		assert.strictEqual(asB, undefined);
		const asA = instantiationService.invokeFunction(accessor => resolveViewIdSoft(accessor, { ownerAgentId: 'agent-A' }));
		assert.strictEqual(asA, 'agent-view');
	});

	test('normalizeArgs: string first arg is the viewId, last arg is the options bag', () => {
		assert.deepStrictEqual(normalizeArgs('v9', { ownerAgentId: 'a1' }), { viewId: 'v9', ownerAgentId: 'a1' });
		assert.deepStrictEqual(normalizeArgs({ viewId: 'v7', accept: true }), { viewId: 'v7', accept: true });
	});

	// --- navigation --------------------------------------------------------------

	test('navigate loads the URL on the resolved view and returns undefined', async () => {
		const model = createModel();
		browserViews.addInput('v1', model);
		const result = await invoke('cursor.browserView.navigate', 'https://example.com/docs', 'v1');
		assert.strictEqual(result, undefined);
		assert.deepStrictEqual(model.calls, ['loadURL:https://example.com/docs']);
	});

	test('navigate with an unknown viewId throws Browser view not found', async () => {
		await assert.rejects(invoke('cursor.browserView.navigate', 'https://example.com', 'missing'), /^Error: Browser view not found$/);
	});

	test('getURL / getTitle read the model state', async () => {
		browserViews.addInput('v1', createModel());
		assert.strictEqual(await invoke('cursor.browserView.getURL', 'v1'), 'https://example.com/');
		assert.strictEqual(await invoke('cursor.browserView.getTitle', 'v1'), 'Example');
		assert.strictEqual(await invoke('cursor.browserView.getTitle', { viewId: 'v1' }), 'Example');
	});

	test('reload is a hard reload and returns true', async () => {
		const model = createModel();
		browserViews.addInput('v1', model);
		assert.strictEqual(await invoke('cursor.browserView.reload', 'v1'), true);
		assert.deepStrictEqual(model.calls, ['reload:true']);
	});

	test('goBack / goForward delegate to the model', async () => {
		const model = createModel();
		browserViews.addInput('v1', model);
		await invoke('cursor.browserView.goBack', 'v1');
		await invoke('cursor.browserView.goForward', 'v1');
		assert.deepStrictEqual(model.calls, ['goBack', 'goForward']);
	});

	test('resize validates numbers and runs the viewport script via CDP', async () => {
		browserViews.addInput('v1', createModel());
		assert.deepStrictEqual(await invoke('cursor.browserView.resize', { width: 'abc', height: 10, viewId: 'v1' }), { success: false, error: 'Invalid width or height' });
		cdpService.respond = message => ({ id: message.id, result: { result: { value: { width: 800, height: 600 } } } });
		assert.deepStrictEqual(await invoke('cursor.browserView.resize', { width: 800, height: 600, viewId: 'v1' }), { success: true });
		assert.strictEqual(cdpService.sent.length, 1);
		assert.strictEqual(cdpService.sent[0].message.method, 'Runtime.evaluate');
		assert.ok((cdpService.sent[0].message.params as { expression: string }).expression.includes("maxWidth = '800px'"));
	});

	// --- capture -----------------------------------------------------------------

	test('executeJavaScript evaluates via CDP Runtime.evaluate and returns the value', async () => {
		browserViews.addInput('v1', createModel());
		cdpService.respond = message => ({ id: message.id, result: { result: { value: 42 } } });
		const value = await invoke('cursor.browserView.executeJavaScript', '1 + 41', 'v1');
		assert.strictEqual(value, 42);
		const params = cdpService.sent[0].message.params as { expression: string; returnByValue: boolean; awaitPromise: boolean; contextId?: number };
		assert.strictEqual(params.expression, '1 + 41');
		assert.strictEqual(params.returnByValue, true);
		assert.strictEqual(params.awaitPromise, true);
		assert.strictEqual(params.contextId, undefined);
	});

	test('executeJavaScriptInIsolatedWorld passes the isolated world context id', async () => {
		browserViews.addInput('v1', createModel());
		cdpService.respond = message => ({ id: message.id, result: { result: { value: 'ok' } } });
		assert.strictEqual(await invoke('cursor.browserView.executeJavaScriptInIsolatedWorld', 'document.title', 'v1'), 'ok');
		assert.strictEqual((cdpService.sent[0].message.params as { contextId?: number }).contextId, 999);
	});

	test('sendCDPCommand creates a group, sends, returns the result, destroys the group', async () => {
		browserViews.addInput('v1', createModel());
		cdpService.respond = message => ({ id: message.id, result: { ok: true } });
		const result = await invoke('cursor.browserView.sendCDPCommand', 'Page.enable', { foo: 1 }, 'v1');
		assert.deepStrictEqual(result, { ok: true });
		assert.deepStrictEqual(cdpService.createdFor, ['v1']);
		assert.strictEqual(cdpService.sent[0].message.method, 'Page.enable');
		assert.strictEqual(cdpService.destroyed.length, 1);
	});

	test('takeScreenshot returns a data URL envelope (png default)', async () => {
		browserViews.addInput('v1', createModel());
		const result = await invoke('cursor.browserView.takeScreenshot', { viewId: 'v1' }) as { success: boolean; dataUrl: string };
		assert.strictEqual(result.success, true);
		assert.ok(result.dataUrl.startsWith('data:image/png;base64,'));
	});

	test('getConsoleLogs returns [] with no views and the model logs otherwise', async () => {
		assert.deepStrictEqual(await invoke('cursor.browserView.getConsoleLogs'), []);
		browserViews.addInput('v1', createModel());
		assert.strictEqual(await invoke('cursor.browserView.getConsoleLogs', 'v1'), 'log line 1\nlog line 2');
	});

	test('getNetworkRequests returns [] (no fork network store)', async () => {
		browserViews.addInput('v1', createModel());
		assert.deepStrictEqual(await invoke('cursor.browserView.getNetworkRequests', 'v1'), []);
	});

	test('updateScreenshot validates the data URL', async () => {
		browserViews.addInput('v1', createModel());
		assert.deepStrictEqual(await invoke('cursor.browserView.updateScreenshot', 'v1', 'not-a-data-url'), { success: false, error: 'Invalid screenshot data URL' });
		assert.deepStrictEqual(await invoke('cursor.browserView.updateScreenshot', 'v1', 'data:image/png;base64,aGVsbG8='), { success: true });
		assert.deepStrictEqual(await invoke('cursor.browserView.updateScreenshot', 'missing', 'data:image/png;base64,aGVsbG8='), { success: false, error: 'No browser view available' });
	});

	// --- tab lifecycle -----------------------------------------------------------

	test('newTab creates a user-owned visible tab and returns its browserId', async () => {
		const result = await invoke('cursor.browserView.newTab', 'https://example.com') as { success: boolean; browserId: string };
		assert.strictEqual(result.success, true);
		assert.ok(browserViews.known.has(result.browserId));
		assert.deepStrictEqual(browserViews.lastCreate?.options.owner, { type: 'user' });
		assert.deepStrictEqual(browserViews.lastCreate?.editorOpenOptions, { pinned: true, preserveFocus: false });
	});

	test('newTab with agentId creates an agent-owned tab', async () => {
		await invoke('cursor.browserView.newTab', undefined, { agentId: 'agent-7' });
		assert.deepStrictEqual(browserViews.lastCreate?.options.owner, { type: 'agent', sessionId: 'agent-7' });
	});

	test('newHeadlessTab creates a headless view; showHeadlessTab promotes it', async () => {
		const result = await invoke('cursor.browserView.newHeadlessTab', 'https://example.com/headless') as { success: boolean; browserId: string };
		assert.strictEqual(browserViews.lastCreate?.editorOpenOptions, undefined);
		assert.strictEqual(await invoke('cursor.browserView.isHeadless', result.browserId), true);
		assert.deepStrictEqual(await invoke('cursor.browserView.showHeadlessTab', result.browserId), { success: true });
		assert.strictEqual(await invoke('cursor.browserView.isHeadless', result.browserId), false);
		assert.deepStrictEqual(await invoke('cursor.browserView.showHeadlessTab', result.browserId), { success: false, error: 'Tab is not headless' });
	});

	test('hideTab hides the model and marks the view headless', async () => {
		const model = createModel();
		browserViews.addInput('v1', model);
		assert.deepStrictEqual(await invoke('cursor.browserView.hideTab', 'v1'), { success: true });
		assert.deepStrictEqual(model.calls, ['setVisible']);
		assert.strictEqual(await invoke('cursor.browserView.isHeadless', 'v1'), true);
	});

	test('closeTab closes the editor tab; unknown id reports No browser tab to close', async () => {
		const input = browserViews.addInput('v1', createModel());
		assert.deepStrictEqual(await invoke('cursor.browserView.closeTab', 'v1'), { success: true });
		assert.deepStrictEqual(closedEditors, [input]);
		assert.deepStrictEqual(await invoke('cursor.browserView.closeTab', 'missing'), { success: false, error: 'No browser tab to close' });
	});

	test('selectTab opens the matching editor pinned', async () => {
		const input = browserViews.addInput('v1', createModel());
		assert.deepStrictEqual(await invoke('cursor.browserView.selectTab', 'v1'), { success: true });
		assert.deepStrictEqual(openedEditors, [{ editor: input, options: { pinned: true } }]);
		assert.deepStrictEqual(await invoke('cursor.browserView.selectTab', 'missing'), { success: false, error: 'Browser tab not found' });
	});

	test('focusOrShowTab activates the editor and focuses the model', async () => {
		const model = createModel();
		const input = browserViews.addInput('v1', model);
		assert.deepStrictEqual(await invoke('cursor.browserView.focusOrShowTab', 'v1'), { success: true });
		assert.deepStrictEqual(openedEditors, [{ editor: input, options: { pinned: true, activation: EditorActivation.ACTIVATE } }]);
		assert.deepStrictEqual(model.calls, ['setVisible', 'focus']);
		assert.deepStrictEqual(await invoke('cursor.browserView.focusOrShowTab', 'missing'), { success: false, error: 'Browser view not found' });
	});

	test('listTabs returns GaI shape: ownership-filtered id arrays', async () => {
		browserViews.addInput('v1', createModel());
		browserViews.addInput('agent-view', createModel({ type: 'agent', sessionId: 'agent-A' }));
		const tabs = await invoke('cursor.browserView.listTabs') as { tabs: string[]; activeTab: string | undefined; lastInteractedTab: string | undefined; headlessTabs: string[] };
		assert.deepStrictEqual(tabs.tabs, ['v1', 'agent-view']);
		assert.strictEqual(tabs.activeTab, undefined);
		assert.deepStrictEqual(tabs.headlessTabs, []);
		const asB = await invoke('cursor.browserView.listTabs', { ownerAgentId: 'agent-B' }) as { tabs: string[] };
		assert.deepStrictEqual(asB.tabs, ['v1']);
	});

	test('setLocked / isLocked round-trip', async () => {
		browserViews.addInput('v1', createModel());
		assert.strictEqual(await invoke('cursor.browserView.isLocked', 'v1'), false);
		assert.deepStrictEqual(await invoke('cursor.browserView.setLocked', 'v1', true), { success: true, viewId: 'v1', locked: true });
		assert.strictEqual(await invoke('cursor.browserView.isLocked', 'v1'), true);
		assert.deepStrictEqual(await invoke('cursor.browserView.setLocked', 'v1', false), { success: true, viewId: 'v1', locked: false });
		assert.deepStrictEqual(await invoke('cursor.browserView.setLocked', 'missing', true), { success: false, error: 'No browser view available' });
	});

	test('browserView.blur resolves quietly for known and unknown views', async () => {
		browserViews.addInput('v1', createModel());
		await invoke('browserView.blur', 'v1');
		await invoke('browserView.blur', 'missing');
	});

	// --- origin allowlist ------------------------------------------------------

	test('ensureNavigationAllowed accepts a string URL or a {url} bag', async () => {
		assert.strictEqual(await invoke('cursor.browserOriginAllowlist.ensureNavigationAllowed', 'https://example.com/docs'), undefined);
		assert.strictEqual(await invoke('cursor.browserOriginAllowlist.ensureNavigationAllowed', { url: 'https://example.com/docs' }), undefined);
	});

	test('ensureNavigationAllowed requires a non-empty URL', () => {
		assert.throws(() => invoke('cursor.browserOriginAllowlist.ensureNavigationAllowed'), /^Error: A URL must be provided to validate navigation\.$/);
		assert.throws(() => invoke('cursor.browserOriginAllowlist.ensureNavigationAllowed', ''), /^Error: A URL must be provided to validate navigation\.$/);
		assert.throws(() => invoke('cursor.browserOriginAllowlist.ensureNavigationAllowed', {}), /^Error: A URL must be provided to validate navigation\.$/);
	});

	test('ensureNavigationAllowed blocks file:// URLs unconditionally', () => {
		assert.throws(
			() => invoke('cursor.browserOriginAllowlist.ensureNavigationAllowed', 'file:///etc/passwd'),
			/^Error: Security restriction: file:\/\/ URLs are not allowed\. The browser navigation tool can only access web URLs \(http:\/\/ or https:\/\/\)\. If you need to view local files, use the file reading tools instead\.$/
		);
	});

	test('ensurePageOriginAllowed accepts string, bag, and missing args', async () => {
		assert.strictEqual(await invoke('cursor.browserOriginAllowlist.ensurePageOriginAllowed', 'https://example.com/'), undefined);
		assert.strictEqual(await invoke('cursor.browserOriginAllowlist.ensurePageOriginAllowed', { toolName: 'browser_navigate', url: 'https://example.com/' }), undefined);
		assert.strictEqual(await invoke('cursor.browserOriginAllowlist.ensurePageOriginAllowed', { origin: 'https://example.com' }), undefined);
		assert.strictEqual(await invoke('cursor.browserOriginAllowlist.ensurePageOriginAllowed'), undefined);
	});

	test('ensurePageOriginAllowed blocks file:// URLs and names the tool', () => {
		assert.throws(
			() => invoke('cursor.browserOriginAllowlist.ensurePageOriginAllowed', { toolName: 'browser_click', url: 'file:///etc/passwd' }),
			/^Error: Security restriction: Browser tool browser_click cannot be used on file:\/\/ URLs\. Only web URLs \(http:\/\/ or https:\/\/\) are allowed\.$/
		);
	});

	// --- agent-facing ------------------------------------------------------------

	test('setRecordingType / getRecordingType round-trip; unset is null', async () => {
		browserViews.addInput('v1', createModel());
		assert.strictEqual(await invoke('cursor.browserView.getRecordingType', 'v1'), null);
		assert.deepStrictEqual(await invoke('cursor.browserView.setRecordingType', 'v1', 'screen'), { success: true, viewId: 'v1', recordingType: 'screen' });
		assert.strictEqual(await invoke('cursor.browserView.getRecordingType', 'v1'), 'screen');
		assert.deepStrictEqual(await invoke('cursor.browserView.setRecordingType', 'missing', 'screen'), { success: false, error: 'No browser view available' });
	});

	test('configureDialogHandling returns the binary ack envelope', async () => {
		browserViews.addInput('v1', createModel());
		assert.deepStrictEqual(
			await invoke('cursor.browserView.configureDialogHandling', { viewId: 'v1', accept: true, promptText: 'Are you sure?' }),
			{ success: true, configured: true, action: 'accept', promptText: 'Are you sure?' }
		);
		assert.deepStrictEqual(
			await invoke('cursor.browserView.configureDialogHandling', { viewId: 'v1', accept: false }),
			{ success: true, configured: true, action: 'dismiss', promptText: undefined }
		);
	});

	test('clearAgentDeviceEmulation clears the device for the owner, rejects others', async () => {
		const ownModel = createModel({ type: 'agent', sessionId: 'agent-A' });
		browserViews.addInput('own', ownModel);
		assert.deepStrictEqual(await invoke('cursor.browserView.clearAgentDeviceEmulation', 'own', { ownerAgentId: 'agent-B' }), { success: false, error: 'Browser view is owned by another agent' });
		assert.deepStrictEqual(await invoke('cursor.browserView.clearAgentDeviceEmulation', 'own', { ownerAgentId: 'agent-A' }), { success: true });
		assert.deepStrictEqual(ownModel.calls, ['setDevice']);
		assert.deepStrictEqual(await invoke('cursor.browserView.clearAgentDeviceEmulation', 'missing'), { success: false, error: 'Browser view not found' });
	});

	test('debug actions warn when there is nothing to crash or orphan', async () => {
		await invoke('cursor.browserView.debug.crashRenderer');
		await invoke('cursor.browserView.debug.orphanView');
		assert.deepStrictEqual(warnings, [
			'No browser view available to crash. Open a browser tab first.',
			'No browser view available to orphan. Open a browser tab first.',
		]);
	});

	test('debug orphanView disposes the model but keeps the view listed', async () => {
		const model = createModel();
		browserViews.addInput('v1', model);
		noteLastInteracted('v1');
		await invoke('cursor.browserView.debug.orphanView');
		assert.deepStrictEqual(model.calls, ['dispose']);
		assert.ok(browserViews.known.has('v1'));
		assert.ok(infos.some(m => m.includes('Orphaned view entry(ies): v1')));
	});

	test('session scope of new tabs is ephemeral (binary-parity creation)', async () => {
		await invoke('cursor.browserView.newTab');
		assert.deepStrictEqual(browserViews.lastCreate?.options.session, { scope: BrowserViewStorageScope.Ephemeral });
		assert.strictEqual(getLastInteractedViewId(), 'view-1');
	});
});
