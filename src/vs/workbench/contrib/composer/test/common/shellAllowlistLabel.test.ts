/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import {
	ALWAYS_RUN_BUTTON_LABEL_PREFIX,
	ALWAYS_RUN_SELECTED_BUTTON_LABEL,
	ALLOWLIST_ACTIONS_MENU_LABEL,
	ALWAYS_RUN_RADIO_LABEL,
	ALWAYS_ASK_RADIO_LABEL,
	buildShellAllowlistLabel,
	allowlistModeRadioLabel,
} from '../../common/shellAllowlistLabel.js';

/**
 * GAPS-22B (review-labels-always-run-construction) — Cursor parity for the
 * shell-approval "Always Run" button label.
 *
 * Binary evidence: workbench.glass.main.js (Cursor 3.25.9), module
 * "shell-allowlist-label-truncation.js":
 *   sEa = "Always Run '"
 *   function ycp(t){if(!t?.length)return null;const e=t[0],
 *     n=t.length===1?"'":`' + ${t.length-1}`;
 *     return{prefix:sEa,command:e,suffix:n,fullLabel:`${sEa}${e}${n}`,
 *     commandCount:t.length}}
 *
 * Case distinction (binary-verified):
 *   - BUTTON = title-case "Always Run" (the `sEa` prefix).
 *   - RADIO items = sentence-case "Always run" / "Always ask" (binary `XvS`).
 *   - Actions menu = sentence-case "Always run" (`{kind:"actions",
 *     label:"Always run"}` under USE_ALLOWLIST/SMART_AUTO).
 *   - Selection state = "Always Run Selected" (`Fe && qe ? "Always Run
 *     Selected" : it`).
 *
 * HONEST: `ycp` performs NO truncation despite the module name — no
 * truncation rule is pinned here. Per-option `Ev` nls strings are not
 * statically resolvable and are not fabricated.
 */
suite('shellAllowlistLabel (GAPS-22B)', () => {

	suite('buildShellAllowlistLabel — exact port of binary ycp(t)', () => {
		test('returns null for empty input (binary: if (!t?.length) return null)', () => {
			assert.strictEqual(buildShellAllowlistLabel([]), null);
			assert.strictEqual(buildShellAllowlistLabel(undefined), null);
			assert.strictEqual(buildShellAllowlistLabel(null), null);
		});

		test('single command → `Always Run \'<cmd>\'`', () => {
			const got = buildShellAllowlistLabel(['npm test']);
			assert.ok(got);
			assert.strictEqual(got.prefix, 'Always Run \'');
			assert.strictEqual(got.command, 'npm test');
			assert.strictEqual(got.suffix, '\'');
			assert.strictEqual(got.fullLabel, 'Always Run \'npm test\'');
			assert.strictEqual(got.commandCount, 1);
		});

		test('multiple commands → `Always Run \'<first>\' + N`', () => {
			const two = buildShellAllowlistLabel(['npm test', 'npm run build']);
			assert.ok(two);
			assert.strictEqual(two.suffix, '\' + 1');
			assert.strictEqual(two.fullLabel, 'Always Run \'npm test\' + 1');
			assert.strictEqual(two.commandCount, 2);

			const three = buildShellAllowlistLabel(['a', 'b', 'c']);
			assert.ok(three);
			assert.strictEqual(three.suffix, '\' + 2');
			assert.strictEqual(three.fullLabel, 'Always Run \'a\' + 2');
			assert.strictEqual(three.commandCount, 3);
		});

		test('label body uses only the first command', () => {
			const got = buildShellAllowlistLabel(['first-cmd', 'second-cmd']);
			assert.ok(got);
			assert.strictEqual(got.command, 'first-cmd');
			assert.ok(!got.fullLabel.includes('second-cmd'));
		});

		test('does not truncate the command text (binary ycp has no truncation)', () => {
			const long = 'x'.repeat(500);
			const got = buildShellAllowlistLabel([long]);
			assert.ok(got);
			assert.strictEqual(got.command, long);
			assert.strictEqual(got.fullLabel, `Always Run '${long}'`);
		});

		test('prefix is verbatim — char-by-char', () => {
			assert.strictEqual(ALWAYS_RUN_BUTTON_LABEL_PREFIX, 'Always Run \'');
			assert.strictEqual(ALWAYS_RUN_BUTTON_LABEL_PREFIX.length, 12);
		});
	});

	suite('case distinction: button (title-case) vs radio/menu (sentence-case)', () => {
		test('button prefix is title-case \'Always Run\'', () => {
			assert.ok(ALWAYS_RUN_BUTTON_LABEL_PREFIX.startsWith('Always Run'));
		});

		test('radio labels are sentence-case (binary XvS)', () => {
			assert.strictEqual(ALWAYS_RUN_RADIO_LABEL, 'Always run');
			assert.strictEqual(ALWAYS_ASK_RADIO_LABEL, 'Always ask');
			assert.strictEqual(allowlistModeRadioLabel('alwaysRun'), 'Always run');
			assert.strictEqual(allowlistModeRadioLabel('alwaysAsk'), 'Always ask');
		});

		test('unknown mode ids pass through untouched (binary default: return t)', () => {
			assert.strictEqual(allowlistModeRadioLabel('runEverything'), 'runEverything');
			assert.strictEqual(allowlistModeRadioLabel(''), '');
		});

		test('actions-menu label is sentence-case \'Always run\'', () => {
			assert.strictEqual(ALLOWLIST_ACTIONS_MENU_LABEL, 'Always run');
		});

		test('selection-state button label is verbatim \'Always Run Selected\'', () => {
			assert.strictEqual(ALWAYS_RUN_SELECTED_BUTTON_LABEL, 'Always Run Selected');
		});
	});
});
