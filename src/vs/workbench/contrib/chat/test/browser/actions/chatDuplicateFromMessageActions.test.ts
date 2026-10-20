/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../../base/common/uri.js';
import { upcastPartial } from '../../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { Context } from '../../../../../../platform/contextkey/browser/contextKeyService.js';
import { MenuId } from '../../../../../../platform/actions/common/actions.js';
import { TestInstantiationService } from '../../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { DuplicateChatFromMessageAction, DuplicateChatFromMessageActionId } from '../../../browser/actions/chatDuplicateFromMessageActions.js';
import { ForkConversationAction, IForkConversationOptions } from '../../../browser/actions/chatForkActions.js';
import { IChatWidget, IChatWidgetService } from '../../../browser/chat.js';
import { IChatModelReference, IChatService } from '../../../common/chatService/chatService.js';
import { IChatSessionsService } from '../../../common/chatSessionsService.js';
import { ChatAgentLocation } from '../../../common/constants.js';
import { IChatModel, IChatRequestModel, ISerializableChatData } from '../../../common/model/chatModel.js';
import { IChatRequestViewModel, IChatResponseViewModel, IChatViewModel } from '../../../common/model/chatViewModel.js';

function createServices(source: URI, fork: URI, requests: { requestId: string; message: string }[], item: IChatRequestViewModel | IChatResponseViewModel | undefined, widget: IChatWidget | undefined) {
	const instantiationService = new TestInstantiationService();
	const serializedData: ISerializableChatData = {
		version: 3,
		sessionId: 'source',
		creationDate: 0,
		customTitle: undefined,
		initialLocation: ChatAgentLocation.Chat,
		responderUsername: 'test',
		requests: requests.map(request => ({
			requestId: request.requestId,
			message: request.message,
			variableData: { variables: [] },
			response: [],
		})),
	};
	const model = upcastPartial<IChatModel>({
		sessionResource: source,
		title: 'Source',
		toJSON: () => serializedData,
		getRequests: () => requests.map(request => upcastPartial<IChatRequestModel>({ id: request.requestId })),
	});
	let loaded: ISerializableChatData | undefined;
	let disposed = false;
	let opened: { parent: URI; resource: URI; options: IForkConversationOptions | undefined } | undefined;
	instantiationService.stub(IChatService, upcastPartial<IChatService>({
		getSession: resource => resource.toString() === source.toString() ? model : undefined,
		loadSessionFromData: data => {
			loaded = data;
			return upcastPartial<IChatModelReference>({
				object: upcastPartial<IChatModel>({ sessionResource: fork }),
				dispose: () => disposed = true,
			});
		},
	}));
	instantiationService.stub(IChatSessionsService, upcastPartial<IChatSessionsService>({ getContentProviderSchemes: () => [] }));
	instantiationService.stub(IChatWidgetService, upcastPartial<IChatWidgetService>({
		getWidgetBySessionResource: resource => resource.toString() === source.toString() ? widget : undefined,
		lastFocusedWidget: undefined,
	}));
	const action = new class extends DuplicateChatFromMessageAction {
		protected override async _openForkedSession(_instantiationService: IInstantiationService, parent: URI, resource: URI, options?: IForkConversationOptions): Promise<void> {
			opened = { parent, resource, options };
		}
	};
	return {
		instantiationService,
		action,
		get loaded() { return loaded; },
		get disposed() { return disposed; },
		get opened() { return opened; },
		get sourceMessages() { return serializedData.requests.map(request => request.message); },
		async run() {
			await instantiationService.invokeFunction(accessor => action.run(accessor, item));
		},
	};
}

function requestVM(id: string, source: URI, message: string): IChatRequestViewModel {
	return upcastPartial<IChatRequestViewModel>({ id, sessionResource: source, message: { text: message, parts: [] } });
}

function responseVM(id: string, requestId: string, source: URI): IChatResponseViewModel {
	return upcastPartial<IChatResponseViewModel>({ id, requestId, sessionResource: source, setVote: () => { } });
}

function widgetWithItems(source: URI, items: (IChatRequestViewModel | IChatResponseViewModel)[]): IChatWidget {
	return upcastPartial<IChatWidget>({
		viewModel: upcastPartial<IChatViewModel>({ sessionResource: source, getItems: () => items }),
	});
}

const MESSAGES: [string, string][] = [['request-1', 'first'], ['request-2', 'second'], ['request-3', 'third']];

suite('DuplicateChatFromMessageAction', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('is registered in the message title overflow menu as "Duplicate Chat"', () => {
		const action = new DuplicateChatFromMessageAction();
		assert.strictEqual(action.desc.id, DuplicateChatFromMessageActionId);
		const title = action.desc.title;
		assert.strictEqual(typeof title === 'string' ? title : title.value, 'Duplicate Chat');
		assert.strictEqual(action.desc.f1, false);
		const menu = Array.isArray(action.desc.menu) ? action.desc.menu : [action.desc.menu];
		const entry = menu.find(item => item?.id === MenuId.ChatMessageTitle);
		assert.ok(entry, 'expected a ChatMessageTitle menu entry');
		// Non-'navigation' group: renders in the "..." overflow menu, not as an inline button.
		assert.notStrictEqual(entry.group, 'navigation');
	});

	test('menu entry is visible on requests and responses, hidden when chat is disabled', () => {
		const action = new DuplicateChatFromMessageAction();
		const menu = Array.isArray(action.desc.menu) ? action.desc.menu : [action.desc.menu];
		const entry = menu.find(item => item?.id === MenuId.ChatMessageTitle)!;
		// The menu system combines the action precondition with the menu item `when`.
		const visibleWhen = ContextKeyExpr.and(entry.when!, action.desc.precondition!);
		const cases: [boolean, boolean, boolean][] = [
			// [chatIsEnabled, chatRequest, chatResponse] -> visible
			[true, true, false],
			[true, false, true],
			[false, true, false],
			[true, false, false],
		];
		assert.deepStrictEqual(cases.map(([enabled, isRequest, isResponse]) => {
			const context = new Context(0, null);
			context.setValue('chatIsEnabled', enabled);
			context.setValue('chatRequest', isRequest);
			context.setValue('chatResponse', isResponse);
			context.setValue('chatIsReadonly', false);
			context.setValue('lockedToCodingAgent', false);
			return visibleWhen.evaluate(context);
		}), [true, true, false, false]);
	});

	test('duplicating from a request INCLUDES that request (fork would exclude it)', async () => {
		const source = URI.parse('test-chat:/source');
		const fork = URI.parse('test-chat:/fork');
		const services = createServices(source, fork, MESSAGES.map(([requestId, message]) => ({ requestId, message })), requestVM('request-2', source, 'second'), undefined);
		disposables.add(services.instantiationService);

		await services.run();

		assert.deepStrictEqual({
			opened: services.opened,
			messages: services.loaded?.requests.map(request => request.message),
			customTitle: services.loaded?.customTitle,
			sourceMessages: services.sourceMessages,
			disposed: services.disposed,
		}, {
			opened: { parent: source, resource: fork, options: undefined },
			// INCLUSIVE: 'second' is kept. ForkConversationAction would produce ['first'] here.
			messages: ['first', 'second'],
			customTitle: 'Forked: Source',
			sourceMessages: ['first', 'second', 'third'],
			disposed: true,
		});
	});

	test('duplicating from the first request keeps just that request', async () => {
		const source = URI.parse('test-chat:/source');
		const fork = URI.parse('test-chat:/fork');
		const services = createServices(source, fork, MESSAGES.map(([requestId, message]) => ({ requestId, message })), requestVM('request-1', source, 'first'), undefined);
		disposables.add(services.instantiationService);

		await services.run();

		assert.deepStrictEqual(services.loaded?.requests.map(request => request.message), ['first']);
		assert.deepStrictEqual(services.sourceMessages, ['first', 'second', 'third']);
	});

	test('duplicating from a response includes that response via the view model path', async () => {
		const source = URI.parse('test-chat:/source');
		const fork = URI.parse('test-chat:/fork');
		const items = [
			requestVM('request-1', source, 'first'), responseVM('response-1', 'request-1', source),
			requestVM('request-2', source, 'second'), responseVM('response-2', 'request-2', source),
			requestVM('request-3', source, 'third'), responseVM('response-3', 'request-3', source),
		];
		const services = createServices(source, fork, MESSAGES.map(([requestId, message]) => ({ requestId, message })), responseVM('response-2', 'request-2', source), widgetWithItems(source, items));
		disposables.add(services.instantiationService);

		await services.run();

		assert.deepStrictEqual({
			opened: services.opened,
			messages: services.loaded?.requests.map(request => request.message),
			sourceMessages: services.sourceMessages,
		}, {
			opened: { parent: source, resource: fork, options: undefined },
			messages: ['first', 'second'],
			sourceMessages: ['first', 'second', 'third'],
		});
	});

	test('duplicating from a request includes that request via the view model path', async () => {
		const source = URI.parse('test-chat:/source');
		const fork = URI.parse('test-chat:/fork');
		const items = [
			requestVM('request-1', source, 'first'), responseVM('response-1', 'request-1', source),
			requestVM('request-2', source, 'second'), responseVM('response-2', 'request-2', source),
			requestVM('request-3', source, 'third'), responseVM('response-3', 'request-3', source),
		];
		const services = createServices(source, fork, MESSAGES.map(([requestId, message]) => ({ requestId, message })), requestVM('request-2', source, 'second'), widgetWithItems(source, items));
		disposables.add(services.instantiationService);

		await services.run();

		// INCLUSIVE: 'second' is kept. ForkConversationAction would produce ['first'] here.
		assert.deepStrictEqual(services.loaded?.requests.map(request => request.message), ['first', 'second']);
	});

	test('forked requests get fresh ids, timestamps and completed model state', async () => {
		const source = URI.parse('test-chat:/source');
		const fork = URI.parse('test-chat:/fork');
		const services = createServices(source, fork, MESSAGES.map(([requestId, message]) => ({ requestId, message })), requestVM('request-2', source, 'second'), undefined);
		disposables.add(services.instantiationService);

		await services.run();

		const loaded = services.loaded!;
		assert.strictEqual(loaded.requests.length, 2);
		for (const [index, request] of loaded.requests.entries()) {
			assert.ok(!['request-1', 'request-2'].includes(request.requestId), 'request ids must be regenerated');
			assert.strictEqual(request.shouldBeRemovedOnSend, undefined);
			assert.strictEqual(request.isHidden, undefined);
			assert.ok(typeof request.timestamp === 'number');
			if (index > 0) {
				assert.ok(request.timestamp >= loaded.requests[index - 1].timestamp);
			}
		}
		assert.notStrictEqual(loaded.sessionId, 'source');
	});

	test('subclass does not change the base fork registration', () => {
		// The base ForkConversationAction keeps its own id/menu; only the subclass
		// carries the Duplicate Chat registration.
		const base = new ForkConversationAction();
		assert.strictEqual(base.desc.id, 'workbench.action.chat.forkConversation');
		const menu = Array.isArray(base.desc.menu) ? base.desc.menu : [base.desc.menu];
		assert.ok(!menu.some(item => item?.id === MenuId.ChatMessageTitle));
	});
});
