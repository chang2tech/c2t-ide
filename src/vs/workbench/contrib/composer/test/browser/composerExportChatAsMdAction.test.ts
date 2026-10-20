/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ServiceIdentifier, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IEnvironmentService } from '../../../../../platform/environment/common/environment.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { ComposerChatEditorInput } from '../../browser/composerEditorInput.js';
import { ComposerExportChatAsMdAction } from '../../browser/composerActions.js';
import {
	ChatExportMessage,
	buildChatExportMarkdown,
	composerExportFileName,
	renderAskQuestionMarkdown,
} from '../../common/chatExportMarkdown.js';

// WORKER-GAPS-38D (`agent-chat-export`): Cursor 3.25.6 + 3.25.9 parity for
// `composer.exportChatAsMd` (workbench.glass.main.js, static literal
// extraction, verified verbatim in both versions):
// - descriptor: id `composer.exportChatAsMd`, title "Export Transcript",
//   f1:false, icon saveAll (Cursor: ViewTitle menu group "1_chatTools"
//   order 1 when composer-view && !composerIsBackgroundMode; command-telemetry
//   category `chat_management`).
// - file name: binary slug algorithm (`cursor_<slug>.md`; fork branding uses
//   the `ide_code_` prefix — see chatExportMarkdown.ts).
// - Markdown: `# <name>` + `_Exported on <date> at <time> from <product>
//   (<version>)_` header; User/Cursor grouping with `**…**` headings and
//   `---` separators; fenced code blocks; DiI ASK_QUESTION rendering.
// - run: resolve chat id -> transcript via `ide.getChatExportTranscript` ->
//   save dialog {saveLabel:"Export",title:"Export Transcript"} -> write file
//   -> info `Chat exported to <path>` with primary "Open" action
//   (`open.exported.chat`) -> telemetry `composer.export_chat`.

/** Fake composer editor input without a real webview (no disposables). */
function fakeChatInput(tabId: string, title: string): ComposerChatEditorInput {
	const input = Object.create(ComposerChatEditorInput.prototype) as ComposerChatEditorInput;
	(input as unknown as Record<string, unknown>)['tabId'] = tabId;
	(input as unknown as Record<string, unknown>)['_title'] = title;
	return input;
}

interface StubNotifications {
	infos: string[];
	errors: string[];
	notified: { severity: Severity; message: string; primaryActionId?: string; primaryActionLabel?: string }[];
	service: INotificationService;
}

function stubNotifications(): StubNotifications {
	const infos: string[] = [];
	const errors: string[] = [];
	const notified: StubNotifications['notified'] = [];
	const service = {
		info: (message: string) => { infos.push(message); },
		error: (message: string) => { errors.push(message); },
		notify: (n: { severity: Severity; message: string; actions?: { primary?: readonly { id: string; label: string }[] } }) => {
			const primary = n.actions?.primary?.[0];
			notified.push({ severity: n.severity, message: n.message, primaryActionId: primary?.id, primaryActionLabel: primary?.label });
			return { close: () => { } };
		},
	} as unknown as INotificationService;
	return { infos, errors, notified, service };
}

interface StubDialog {
	calls: { saveLabel?: unknown; title?: unknown; defaultUri?: URI; filters?: unknown }[];
	scripted: URI | undefined;
	shouldThrow: boolean;
	service: IDialogService;
}

function stubDialog(scripted: URI | undefined, shouldThrow = false): StubDialog {
	const calls: StubDialog['calls'] = [];
	const service = {
		showSaveDialog: async (options: { saveLabel?: unknown; title?: unknown; defaultUri?: URI; filters?: unknown }) => {
			calls.push(options);
			if (shouldThrow) {
				throw new Error('dialog exploded');
			}
			return scripted;
		},
	} as unknown as IDialogService;
	return { calls, scripted, shouldThrow, service };
}

interface StubFiles {
	written: { resource: URI; content: string }[];
	shouldThrow: boolean;
	service: IFileService;
}

function stubFiles(shouldThrow = false): StubFiles {
	const written: StubFiles['written'] = [];
	const service = {
		writeFile: async (resource: URI, buffer: VSBuffer) => {
			if (shouldThrow) {
				throw new Error('disk exploded');
			}
			written.push({ resource, content: buffer.toString() });
			return {};
		},
	} as unknown as IFileService;
	return { written, shouldThrow, service };
}

interface StubCommands {
	providerResult: unknown;
	providerError?: Error;
	executed: { id: string; args: unknown[] }[];
	service: ICommandService;
}

function stubCommands(providerResult: unknown, providerError?: Error): StubCommands {
	const executed: StubCommands['executed'] = [];
	const service = {
		executeCommand: async (id: string, ...args: unknown[]) => {
			executed.push({ id, args });
			if (id === ComposerExportChatAsMdAction.TRANSCRIPT_PROVIDER_COMMAND) {
				if (providerError) {
					throw providerError;
				}
				return providerResult;
			}
			return undefined;
		},
	} as unknown as ICommandService;
	return { providerResult, providerError, executed, service };
}

interface StubTelemetry {
	events: { eventName: string; data?: unknown }[];
	service: ITelemetryService;
}

function stubTelemetry(): StubTelemetry {
	const events: StubTelemetry['events'] = [];
	const service = {
		publicLog: (eventName: string, data?: unknown) => { events.push({ eventName, data }); },
	} as unknown as ITelemetryService;
	return { events, service };
}

function stubLogService() {
	const errors: unknown[][] = [];
	const service = {
		error: (...args: unknown[]) => { errors.push(args); },
	} as unknown as ILogService;
	return { errors, service };
}

function accessorFor(stubs: Map<ServiceIdentifier<unknown>, unknown>): ServicesAccessor {
	return { get: <T>(id: ServiceIdentifier<T>): T => stubs.get(id) as T };
}

function msg(author: 'User' | 'Cursor', text: string, extra?: Partial<ChatExportMessage>): ChatExportMessage {
	return { author, text, codeBlocks: [], ...extra };
}

function runStubs(opts: {
	tabId?: string;
	title?: string;
	providerResult?: unknown;
	providerError?: Error;
	saveTarget?: URI | undefined;
	dialogThrows?: boolean;
	writeThrows?: boolean;
}) {
	const input = opts.tabId === undefined ? undefined : fakeChatInput(opts.tabId, opts.title ?? 'My chat');
	const editorService = { activeEditor: input, editors: input ? [input] : [] } as unknown as IEditorService;
	const notifications = stubNotifications();
	const dialog = stubDialog(opts.saveTarget, opts.dialogThrows);
	const files = stubFiles(opts.writeThrows);
	const commands = stubCommands(opts.providerResult, opts.providerError);
	const telemetry = stubTelemetry();
	const log = stubLogService();
	const stubs = new Map<ServiceIdentifier<unknown>, unknown>([
		[IEditorService as ServiceIdentifier<unknown>, editorService],
		[INotificationService as ServiceIdentifier<unknown>, notifications.service],
		[IDialogService as ServiceIdentifier<unknown>, dialog.service],
		[IFileService as ServiceIdentifier<unknown>, files.service],
		[ICommandService as ServiceIdentifier<unknown>, commands.service],
		[IEnvironmentService as ServiceIdentifier<unknown>, { userHome: URI.file('/home/tester') } as IEnvironmentService],
		[IProductService as ServiceIdentifier<unknown>, { nameShort: 'IDE Code', version: '9.9.9-test' } as IProductService],
		[ITelemetryService as ServiceIdentifier<unknown>, telemetry.service],
		[ILogService as ServiceIdentifier<unknown>, log.service],
	]);
	return { input, notifications, dialog, files, commands, telemetry, log, accessor: accessorFor(stubs) };
}

const FIXED_DATE = new Date(2026, 9, 20, 10, 30, 0);

suite('ComposerExportChatAsMdAction (agent-chat-export, Cursor 3.25.6/3.25.9 parity)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('descriptor matches the binary: id, title, f1:false, saveAll icon', () => {
		const action = new ComposerExportChatAsMdAction();
		assert.strictEqual(ComposerExportChatAsMdAction.ID, 'composer.exportChatAsMd');
		assert.strictEqual(action.desc.id, 'composer.exportChatAsMd');
		assert.strictEqual(action.desc.title.value, 'Export Transcript');
		assert.strictEqual(action.desc.f1, false);
		assert.strictEqual(action.desc.icon, Codicon.saveAll);
	});

	test('composerExportFileName: binary slug algorithm with the fork prefix', () => {
		assert.strictEqual(composerExportFileName('Hello World'), 'ide_code_hello_world.md');
		assert.strictEqual(composerExportFileName('My Chat!'), 'ide_code_my_chat.md');
		assert.strictEqual(composerExportFileName('  A  B  '), 'ide_code_a_b.md');
		assert.strictEqual(composerExportFileName(''), 'ide_code_.md');
		// 32-char slug truncation (binary `.substring(0,32)`).
		assert.strictEqual(composerExportFileName('x'.repeat(50)), `ide_code_${'x'.repeat(32)}.md`);
	});

	test('buildChatExportMarkdown: header, grouping and separators', () => {
		const md = buildChatExportMarkdown({
			chatName: 'T',
			productName: 'IDE Code',
			appVersion: '1.2.3',
			exportedAt: FIXED_DATE,
			messages: [msg('User', 'hi'), msg('User', 'there'), msg('Cursor', 'hello')],
		});
		const dateStr = FIXED_DATE.toLocaleDateString();
		const timeStr = FIXED_DATE.toLocaleTimeString(undefined, { hour12: false, timeZoneName: 'short' });
		const expected =
			`# T\n_Exported on ${dateStr} at ${timeStr} from IDE Code (1.2.3)_\n\n---\n\n` +
			`**User**\n\nhi\n\nthere\n\n` +
			`---\n\n` +
			`**Cursor**\n\nhello\n\n`;
		assert.strictEqual(md, expected);
	});

	test('buildChatExportMarkdown: empty bubbles are skipped', () => {
		const md = buildChatExportMarkdown({
			chatName: 'T',
			productName: 'IDE Code',
			appVersion: '1.2.3',
			exportedAt: FIXED_DATE,
			messages: [msg('User', '   '), msg('Cursor', 'x')],
		});
		assert.ok(!md.includes('**User**'), 'empty User bubble must not render a heading');
		assert.ok(md.includes('**Cursor**\n\nx\n\n'));
	});

	test('buildChatExportMarkdown: code blocks render as fenced blocks', () => {
		const md = buildChatExportMarkdown({
			chatName: 'T',
			productName: 'IDE Code',
			appVersion: '1.2.3',
			exportedAt: FIXED_DATE,
			messages: [msg('Cursor', '', { codeBlocks: [{ content: 'const a = 1;', languageId: 'ts' }] })],
		});
		assert.ok(md.includes('**Cursor**\n\n```ts\nconst a = 1;\n```\n\n'));
	});

	test('renderAskQuestionMarkdown: binary DiI renderer with selected check', () => {
		const md = renderAskQuestionMarkdown(
			{
				title: 'Pick one',
				questions: [{ id: 'q1', prompt: 'Which?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }],
			},
			{ answers: [{ questionId: 'q1', selectedOptionIds: ['b'], freeformText: 'maybe' }] },
		);
		assert.strictEqual(
			md,
			'**Pick one**\n\n> **Which?**\n> - A\n> - B ✔\n>\n> Answer: maybe\n\n',
		);
	});

	test('renderAskQuestionMarkdown: zero-options question keeps freeform answer + trailing blank (binary DiI gate)', () => {
		// Binary-verbatim: in DiI the freeform `> Answer:` block and the
		// trailing `\n` sit OUTSIDE the `options.length > 0` gate.
		const md = renderAskQuestionMarkdown(
			{
				questions: [
					{ id: 'q1', prompt: 'Anything else?', options: [] },
					{ id: 'q2', prompt: 'Unanswered', options: [] },
				],
			},
			{ answers: [{ questionId: 'q1', freeformText: 'plain text only' }] },
		);
		assert.strictEqual(
			md,
			'> **Anything else?**\n>\n> Answer: plain text only\n\n> **Unanswered**\n\n',
		);
	});

	test('run: no chat id resolves -> "No chat content to export."', async () => {
		const s = runStubs({ providerResult: undefined });
		await new ComposerExportChatAsMdAction().run(s.accessor);
		assert.deepStrictEqual(s.notifications.infos, ['No chat content to export.']);
		assert.strictEqual(s.dialog.calls.length, 0);
	});

	test('run: transcript provider throws or is empty -> "No chat content to export."', async () => {
		const s = runStubs({ tabId: 'tab-1', providerError: new Error('nope') });
		await new ComposerExportChatAsMdAction().run(s.accessor);
		assert.deepStrictEqual(s.notifications.infos, ['No chat content to export.']);
		assert.strictEqual(s.dialog.calls.length, 0);
	});

	test('run: happy path uses the binary save-dialog labels, writes the file, notifies with Open, tracks telemetry', async () => {
		const target = URI.file('/home/tester/Downloads/ide_code_my_chat.md');
		const s = runStubs({
			tabId: 'tab-1',
			title: 'My chat',
			providerResult: { name: 'My chat', messages: [msg('User', 'hi'), msg('Cursor', 'hello')] },
			saveTarget: target,
		});
		await new ComposerExportChatAsMdAction().run(s.accessor);

		// Transcript provider asked for the resolved tab id.
		assert.deepStrictEqual(
			s.commands.executed.filter(e => e.id === 'ide.getChatExportTranscript').map(e => e.args),
			[['tab-1']],
		);
		// Save dialog: verbatim binary labels, ~/Downloads default.
		assert.strictEqual(s.dialog.calls.length, 1);
		const call = s.dialog.calls[0];
		assert.strictEqual(call.saveLabel, 'Export');
		assert.strictEqual(call.title, 'Export Transcript');
		assert.strictEqual(call.defaultUri?.toString(), URI.file('/home/tester/Downloads/ide_code_my_chat.md').toString());
		// File written with the exported Markdown.
		assert.strictEqual(s.files.written.length, 1);
		assert.strictEqual(s.files.written[0].resource.toString(), target.toString());
		assert.ok(s.files.written[0].content.startsWith('# My chat\n_Exported on '));
		assert.ok(s.files.written[0].content.includes('**User**\n\nhi\n\n'));
		// Notification: verbatim binary message + primary "Open" action.
		assert.strictEqual(s.notifications.notified.length, 1);
		const n = s.notifications.notified[0];
		assert.strictEqual(n.severity, Severity.Info);
		assert.strictEqual(n.message, `Chat exported to ${target.fsPath}`);
		assert.strictEqual(n.primaryActionId, 'open.exported.chat');
		assert.strictEqual(n.primaryActionLabel, 'Open');
		// Telemetry: binary `trackEvent("composer.export_chat")`.
		assert.deepStrictEqual(s.telemetry.events.map(e => e.eventName), ['composer.export_chat']);
	});

	test('run: dialog failure -> "Could not open save dialog"', async () => {
		const s = runStubs({
			tabId: 'tab-1',
			providerResult: { name: 'My chat', messages: [msg('User', 'hi')] },
			dialogThrows: true,
		});
		await new ComposerExportChatAsMdAction().run(s.accessor);
		assert.deepStrictEqual(s.notifications.errors, ['Could not open save dialog']);
		assert.strictEqual(s.files.written.length, 0);
	});

	test('run: write failure -> "Failed to export chat: ..."', async () => {
		const s = runStubs({
			tabId: 'tab-1',
			providerResult: { name: 'My chat', messages: [msg('User', 'hi')] },
			saveTarget: URI.file('/home/tester/Downloads/ide_code_my_chat.md'),
			writeThrows: true,
		});
		await new ComposerExportChatAsMdAction().run(s.accessor);
		assert.deepStrictEqual(s.notifications.errors, ['Failed to export chat: disk exploded']);
		assert.strictEqual(s.notifications.notified.length, 0);
	});
});
