/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IInlineEditService } from '../../common/inlineEditService.js';
import {
	IInlineEditPromptBar,
	IPromptBarDelegate,
	IPromptBarRef,
	RESOLVE_CONFLICT_INIT_TEXT,
} from '../../common/inlineEditPromptBar.js';
import {
	AipopupModalGenerateAction,
	CmdKResolveConflictInCmdKAction,
} from '../../browser/composerActions.js';

// GAPS-174 — `cmdK.resolveConflictInCmdK` (queue #33).
//
// Binary evidence (Cursor 3.25.9, re-sliced by GAPS-174):
// - glass class `JcI` @40750760: `OQp="cmdK.resolveConflictInCmdK"`
//   (@15889598), title "Resolve Conflict in Cmd+K", f1:!1, NO keybinding /
//   menu / category / precondition. Desktop class `SjS` @32247269 identical.
// - run(t, e): `r = await executeCommand("aipopup.action.modal.generate",
//   {initText:"Resolve this merge conflict", invocationType:"new",
//    overrideUri:URI.parse(e.uri),
//    overrideRange:new Range(e.startLine,1,e.endLine,1), visible:!0})`;
//   `if(!r) return`; wait 50ms; `s = getPromptBar(r)`; `if(!s) return`;
//   delegate.setText(o,o) → poll ≤3×150ms → delegate.submit().
// - StartEditPrompt returns the created bar's id (`return le.id`
//   @40739556); with a bar already open for the uri it returns undefined
//   and JcI aborts (the fork's openPromptForRange mirrors this).
// - Sole caller: the merge-conflict extension's "Resolve with AI"
//   CodeLens → `merge-conflict.resolve-in-chat` →
//   `{uri, startLine, endLine, text}` (text ignored by the handler).

function titleValue(action: { desc: { title: unknown } }): string {
	const title = action.desc.title;
	return typeof title === 'string' ? title : (title as { value: string }).value;
}

class FakeDelegate implements IPromptBarDelegate {
	text = '';
	submitted = 0;
	setText(text: string): void { this.text = text; }
	getText(): string { return this.text; }
	numSubmitListeners(): number { return 1; }
	submit(): void { this.submitted++; }
}

interface RecordedCommand { id: string; args: unknown[]; }

function accessorFor(opts: {
	commands: RecordedCommand[];
	generateResult?: string | undefined;
	delegate?: IPromptBarDelegate | undefined;
	bars?: readonly IPromptBarRef[];
	core?: { openPromptForRange: (uri: URI, range: Range) => Promise<string | undefined> };
}): ServicesAccessor {
	return {
		get: (id: unknown) => {
			if (id === ICommandService) {
				return {
					executeCommand: async (commandId: string, ...args: unknown[]) => {
						opts.commands.push({ id: commandId, args });
						return opts.generateResult;
					},
				};
			}
			if (id === IInlineEditPromptBar) {
				return {
					getPromptBars: () => opts.bars ?? [],
					getPromptBarDelegate: () => opts.delegate,
				};
			}
			if (id === IInlineEditService) {
				return opts.core;
			}
			throw new Error('unexpected service');
		},
	} as unknown as ServicesAccessor;
}

suite('cmdK.resolveConflictInCmdK (Cursor 3.25.9 parity, GAPS-174)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('id, title, f1, keybinding and category match the binary', () => {
		const action = new CmdKResolveConflictInCmdKAction();
		assert.strictEqual(CmdKResolveConflictInCmdKAction.ID, 'cmdK.resolveConflictInCmdK');
		assert.strictEqual(action.desc.id, 'cmdK.resolveConflictInCmdK');
		assert.strictEqual(titleValue(action), 'Resolve Conflict in Cmd+K');
		assert.strictEqual(action.desc.f1, false);
		assert.strictEqual(action.desc.keybinding, undefined, 'binary registers no keybinding');
		assert.strictEqual(action.desc.category, undefined, 'binary registers no category');
	});

	test('run(): opens modal.generate with the verbatim binary args, then sets text and auto-submits', async () => {
		const commands: RecordedCommand[] = [];
		const delegate = new FakeDelegate();
		await new CmdKResolveConflictInCmdKAction().run(
			accessorFor({ commands, generateResult: 'bar-1', delegate }),
			{ uri: 'file:///src/conflicted.ts', startLine: 5, endLine: 11, text: '<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> branch' },
		);
		assert.strictEqual(commands.length, 1);
		assert.strictEqual(commands[0].id, 'aipopup.action.modal.generate');
		const arg = commands[0].args[0] as {
			initText: string; invocationType: string;
			overrideUri: URI; overrideRange: Range; visible: boolean;
		};
		assert.strictEqual(arg.initText, 'Resolve this merge conflict');
		assert.strictEqual(arg.invocationType, 'new');
		assert.strictEqual(arg.overrideUri.toString(), 'file:///src/conflicted.ts');
		assert.deepStrictEqual(
			[arg.overrideRange.startLineNumber, arg.overrideRange.startColumn, arg.overrideRange.endLineNumber, arg.overrideRange.endColumn],
			[5, 1, 11, 1],
		);
		assert.strictEqual(arg.visible, true);
		assert.strictEqual(delegate.text, RESOLVE_CONFLICT_INIT_TEXT);
		assert.strictEqual(delegate.submitted, 1);
	});

	test('run(): modal.generate returning no bar id aborts before touching any delegate', async () => {
		const commands: RecordedCommand[] = [];
		const delegate = new FakeDelegate();
		await new CmdKResolveConflictInCmdKAction().run(
			accessorFor({ commands, generateResult: undefined, delegate }),
			{ uri: 'file:///src/conflicted.ts', startLine: 1, endLine: 3 },
		);
		assert.strictEqual(commands.length, 1);
		assert.strictEqual(delegate.submitted, 0);
		assert.strictEqual(delegate.text, '');
	});

	test('run(): bar gone by lookup time → no submit, no throw', async () => {
		const commands: RecordedCommand[] = [];
		await new CmdKResolveConflictInCmdKAction().run(
			accessorFor({ commands, generateResult: 'bar-gone', delegate: undefined }),
			{ uri: 'file:///src/conflicted.ts', startLine: 1, endLine: 3 },
		);
		assert.strictEqual(commands.length, 1);
	});

	test('run(): malformed args are a silent no-op', async () => {
		const commands: RecordedCommand[] = [];
		const action = new CmdKResolveConflictInCmdKAction();
		await action.run(accessorFor({ commands }));
		await action.run(accessorFor({ commands }), { uri: 42 as unknown as string, startLine: 1, endLine: 2 });
		assert.deepStrictEqual(commands, []);
	});

	test('modal.generate: override invocation delegates to openPromptForRange and returns its bar id', async () => {
		const commands: RecordedCommand[] = [];
		const seen: { uri?: URI; range?: Range } = {};
		const core = {
			openPromptForRange: async (uri: URI, range: Range) => {
				seen.uri = uri;
				seen.range = range;
				return 'bar-9';
			},
		};
		const uri = URI.parse('file:///src/conflicted.ts');
		const range = new Range(5, 1, 11, 1);
		const result = await new AipopupModalGenerateAction().run(
			accessorFor({ commands, core }),
			{ invocationType: 'new', initText: RESOLVE_CONFLICT_INIT_TEXT, overrideUri: uri, overrideRange: range, visible: true },
		);
		assert.strictEqual(result, 'bar-9');
		assert.strictEqual(seen.uri, uri);
		assert.strictEqual(seen.range, range);
	});

	test('modal.generate: override invocation without the core service returns undefined', async () => {
		const commands: RecordedCommand[] = [];
		const result = await new AipopupModalGenerateAction().run(
			accessorFor({ commands }),
			{ invocationType: 'new', overrideUri: URI.parse('file:///src/x.ts'), overrideRange: new Range(1, 1, 2, 1), visible: true },
		);
		assert.strictEqual(result, undefined);
	});
});
