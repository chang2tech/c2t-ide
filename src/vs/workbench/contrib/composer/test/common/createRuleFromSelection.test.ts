/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * W69D — `rules-create-from-selection` pure-logic tests (node:test).
 *
 * Every expectation below is pinned to self-verified binary evidence from
 * the reference bundles (QA 2-step rule, step 1), Cursor 3.25.9
 * `out/vs/workbench/workbench.desktop.main.js`:
 *
 * - command id `cursor.createRuleFromSelection` @byte 24830877
 * - run body + toast 'Created manual rule' @byte 24830470
 * - slug derivation @byte 24830922 (12-char cap, 6-word cap, quotes deleted,
 *   no diacritic stripping, path fallback NOT lower-cased)
 * - uniqueness loop @byte 24831196 (suffix starts at -1)
 * - createRule frontmatter @byte 31044289 (`alwaysApply: true` default —
 *   yes, even though the toast says "manual rule"; binary wins)
 * - 3.25.6 cross-checked: 'Created manual rule' @byte 24824677,
 *   id @byte 24825077, identical code
 *
 * Run: node --loader <repo-tests .js->.ts resolve hook> --test \
 *        src/vs/workbench/contrib/composer/test/common/createRuleFromSelection.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
	CREATE_RULE_FROM_SELECTION_ID,
	OPEN_CREATED_RULE_ACTION_ID,
	WARN_EMPTY_SELECTION,
	WARN_NO_MODEL,
	WARN_NO_SELECTION,
	WARN_NO_WORKSPACE_FOLDER,
	buildRuleFileContent,
	createdRuleToastMessage,
	deriveRuleSlug,
	failedToCreateRuleMessage,
	uniqueRuleSlug,
} from '../../common/createRuleFromSelection.js';
import { parseMdcFile } from '../../common/projectRules.js';

describe('createRuleFromSelection: ids + warn strings (binary verbatim)', () => {
	it('uses the binary-verbatim command id', () => {
		assert.strictEqual(CREATE_RULE_FROM_SELECTION_ID, 'cursor.createRuleFromSelection');
	});

	it('uses the binary-verbatim toast action id', () => {
		assert.strictEqual(OPEN_CREATED_RULE_ACTION_ID, 'cursor.openCreatedRule');
	});

	it('warn strings match the binary verbatim', () => {
		assert.strictEqual(WARN_NO_MODEL, 'Open a file to create a cursor rule.');
		assert.strictEqual(WARN_NO_SELECTION, 'Select the text you want to turn into a rule.');
		assert.strictEqual(WARN_EMPTY_SELECTION, 'Highlight some text before creating a rule.');
		assert.strictEqual(WARN_NO_WORKSPACE_FOLDER, 'Open a workspace folder to store cursor rules.');
	});
});

describe('createRuleFromSelection: deriveRuleSlug (binary @24830922)', () => {
	it('lowercases, turns punctuation into dashes, caps the slug at 12 chars', () => {
		// 'always-use-tabs-never-spaces' -> .slice(0,12) cuts mid-word
		assert.strictEqual(deriveRuleSlug('Always Use Tabs, Never Spaces', 'src/a.ts'), 'always-use-t');
	});

	it('deletes quotes instead of turning them into separators', () => {
		assert.strictEqual(deriveRuleSlug(`Don't use "any" here`, 'src/a.ts'), 'dont-use-any');
	});

	it('splits on whitespace runs (incl. newlines) and caps at six words', () => {
		assert.strictEqual(
			deriveRuleSlug('Use `strict`\nmode for ALL files', 'src/a.ts'),
			'use-strict-m',
		);
	});

	it('does NOT strip diacritics (non-ASCII letters become spaces)', () => {
		// 'lu n d ng d u tab' -> join -> 'lu-n-d-ng-d-u' -> slice(0,12)
		assert.strictEqual(deriveRuleSlug('Luôn dùng dấu tab', 'src/a.ts'), 'lu-n-d-ng-d-');
	});

	it('collapses repeated dashes only at the very end', () => {
		assert.strictEqual(deriveRuleSlug('a - - b', 'src/a.ts'), 'a-b');
	});

	it('falls back to the first three path segments when the text yields nothing', () => {
		// 'src-components-Button.tsx' -> slice(0,12); NOT lower-cased
		assert.strictEqual(
			deriveRuleSlug('!!! ??? ###', 'src/components/Button.tsx'),
			'src-componen',
		);
	});

	it('falls back to "rule" with no path and no usable text', () => {
		assert.strictEqual(deriveRuleSlug('!!!', undefined), 'rule');
	});
});

describe('createRuleFromSelection: uniqueRuleSlug (binary @24831196)', () => {
	it('returns the base slug when free', async () => {
		assert.strictEqual(await uniqueRuleSlug('tabs', async () => false), 'tabs');
	});

	it('suffixes from -1 on collision (binary: let s=1)', async () => {
		assert.strictEqual(await uniqueRuleSlug('tabs', async s => s === 'tabs'), 'tabs-1');
		assert.strictEqual(
			await uniqueRuleSlug('tabs', async s => s === 'tabs' || s === 'tabs-1'),
			'tabs-2',
		);
	});

	it('treats an empty base as "rule"', async () => {
		assert.strictEqual(await uniqueRuleSlug('', async () => false), 'rule');
	});
});

describe('createRuleFromSelection: buildRuleFileContent (binary @31044289)', () => {
	it('writes the default frontmatter (alwaysApply: true) + trimEnd body', () => {
		// Binary: `${body.trimEnd()}` — only the end is trimmed.
		assert.strictEqual(
			buildRuleFileContent('Always use tabs.\n\n'),
			'---\nalwaysApply: true\n---\n\nAlways use tabs.\n',
		);
	});

	it('writes globs before alwaysApply when options carry globs', () => {
		assert.strictEqual(
			buildRuleFileContent('body', { globs: '**/*.ts' }),
			'---\nglobs: **/*.ts\nalwaysApply: true\n---\n\nbody\n',
		);
	});

	it('honours an explicit alwaysApply: false', () => {
		assert.strictEqual(
			buildRuleFileContent('body', { alwaysApply: false }),
			'---\nalwaysApply: false\n---\n\nbody\n',
		);
	});

	it('classifies as ALWAYS under the fork rules parser', () => {
		const parsed = parseMdcFile(
			'x.mdc', '/ws/.cursor/rules/x.mdc', '/ws', '',
			'x.mdc', buildRuleFileContent('Never commit secrets.'),
		);
		assert.strictEqual(parsed.alwaysApply, true);
		assert.strictEqual(parsed.kind, 'always');
		assert.strictEqual(parsed.body.trim(), 'Never commit secrets.');
	});
});

describe('createRuleFromSelection: toast + error strings (binary verbatim)', () => {
	it('matches the binary toast exactly', () => {
		assert.strictEqual(
			createdRuleToastMessage('always-use-t'),
			"Created manual rule 'always-use-t' in .cursor/rules. Attach it explicitly when you want it applied.",
		);
	});

	it('prefixes the error message verbatim', () => {
		assert.strictEqual(failedToCreateRuleMessage(new Error('boom')), 'Failed to create rule: boom');
		assert.strictEqual(failedToCreateRuleMessage('plain'), 'Failed to create rule: plain');
	});
});
