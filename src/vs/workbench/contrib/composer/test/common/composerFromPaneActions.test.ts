/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * DEV-GAPS-96 — Cursor 3.25.9 parity tests for the two pane-variant secondary
 * command ids QA-91C found registered in the binary but missing in the fork:
 * `composer.copyRequestIdFromPane` and `composer.openPromptQualityFromPane`.
 *
 * Static wiring assertions on `browser/composerActions.ts` (same pattern as
 * chatTitleMenu.test.ts — the Action2 classes cannot be instantiated under
 * node:test, so the descriptors, delegates, registrations and menu entries
 * are pinned against the source).
 *
 * Binary grounding (all real, static extraction, verified verbatim by
 * DEV-GAPS-96; offsets are byte offsets into workbench.glass.main.js):
 *  - const sQp = "composer.copyRequestIdFromPane" (@15886732);
 *    class hrI: {id:sQp, title:"Copy Request ID", f1:!1,
 *    menu:{id:ViewTitle, group:"1_chatTools", order:3,
 *    when:view =~ /^<composer pane view id>/}};
 *    run: executeCommand(composer.copyRequestId, {kind:"pane"}).
 *    Desktop class c2S is identical (@29933377 region).
 *  - const grI = "composer.openPromptQualityFromPane" (@39844210);
 *    class MrI: {id:grI, title:"Open in Prompt Quality", f1:!1,
 *    precondition:or(ch,Sm), menu:{id:ViewTitle, group:"2_moreActions",
 *    order:99, when:view =~ /^<pane view id>/ && or(ch,Sm)}};
 *    run: executeCommand(composer.openPromptQuality, {kind:"pane"}).
 *  - REFUTED siblings (NOT commands, must never be registered):
 *    "composer.duplicate_tab" (@39828279) and "composer.export_chat"
 *    (@39835332) are trackEvent telemetry names inside the Fork/Export
 *    actions; renameComposer / deepCloneComposer are service methods
 *    (defs @20436221 / @24259185), and "composer.renameComposer" (@40390425)
 *    is an inline IAction literal in a composite-bar context menu.
 *
 * Run: node --loader ~/workspace/w66a-tests/ts-loader.mjs --test composerFromPaneActions.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BROWSER_DIR = resolve(HERE, '..', '..', 'browser');
const src = readFileSync(resolve(BROWSER_DIR, 'composerActions.ts'), 'utf8');

const count = (needle: string): number => src.split(needle).length - 1;

const classBlock = (className: string): string => {
	const start = src.indexOf(`export class ${className} extends Action2 {`);
	assert.ok(start >= 0, `${className} not found`);
	const rest = src.slice(start);
	const end = rest.indexOf('\n}\n');
	assert.ok(end > 0, `${className} block not terminated`);
	return rest.slice(0, end);
};

describe('DEV-GAPS-96 pane-variant actions (binary hrI/MrI parity)', () => {
	it('copyRequestIdFromPane: verbatim id, title, f1:false', () => {
		const block = classBlock('ComposerCopyRequestIdFromPaneAction');
		assert.ok(block.includes(`static readonly ID = 'composer.copyRequestIdFromPane'`));
		assert.ok(block.includes(`localize2('composer.copyRequestIdFromPane', 'Copy Request ID')`));
		assert.ok(block.includes('f1: false'));
	});

	it('copyRequestIdFromPane: run is the pure {kind:"pane"} delegate (binary hrI)', () => {
		const block = classBlock('ComposerCopyRequestIdFromPaneAction');
		assert.ok(block.includes(`executeCommand(ComposerCopyRequestIdAction.ID, { kind: 'pane' })`));
	});

	it('openPromptQualityFromPane: verbatim id, title, f1:false, internal-gate precondition', () => {
		const block = classBlock('ComposerOpenPromptQualityFromPaneAction');
		assert.ok(block.includes(`static readonly ID = 'composer.openPromptQualityFromPane'`));
		assert.ok(block.includes(`localize2('composer.openPromptQualityFromPane', 'Open in Prompt Quality')`));
		assert.ok(block.includes('f1: false'));
		// Binary precondition or(ch,Sm) = or(isDevelopment, isDevUser); the
		// fork maps the pair to IsDevelopmentContext (documented mapping).
		assert.ok(block.includes('precondition: IsDevelopmentContext'));
	});

	it('openPromptQualityFromPane: run is the pure {kind:"pane"} delegate (binary MrI)', () => {
		const block = classBlock('ComposerOpenPromptQualityFromPaneAction');
		assert.ok(block.includes(`executeCommand(ComposerOpenPromptQualityAction.ID, { kind: 'pane' })`));
	});

	it('both actions are registered exactly once via registerAction2', () => {
		assert.equal(count('registerAction2(ComposerCopyRequestIdFromPaneAction)'), 1);
		assert.equal(count('registerAction2(ComposerOpenPromptQualityFromPaneAction)'), 1);
	});

	it('ViewTitle menu entries carry the binary groups/orders and view gate', () => {
		// Search inside registerComposerMenus only — the class descriptors
		// also contain `id: <Class>.ID` and must not be matched here.
		const menusStart = src.indexOf('export function registerComposerMenus()');
		assert.ok(menusStart >= 0, 'registerComposerMenus not found');
		const menus = src.slice(menusStart);
		const copyIdx = menus.indexOf('id: ComposerCopyRequestIdFromPaneAction.ID');
		assert.ok(copyIdx >= 0, 'copyRequestIdFromPane menu entry missing');
		const copyMenu = menus.slice(Math.max(0, copyIdx - 200), copyIdx);
		assert.ok(copyMenu.includes(`group: '1_chatTools'`), 'copyRequestIdFromPane menu group');
		assert.ok(copyMenu.includes('order: 3'), 'copyRequestIdFromPane menu order');
		const pqIdx = menus.indexOf('id: ComposerOpenPromptQualityFromPaneAction.ID');
		assert.ok(pqIdx >= 0, 'openPromptQualityFromPane menu entry missing');
		const pqMenu = menus.slice(Math.max(0, pqIdx - 200), pqIdx);
		assert.ok(pqMenu.includes(`group: '2_moreActions'`), 'openPromptQualityFromPane menu group');
		assert.ok(pqMenu.includes('order: 99'), 'openPromptQualityFromPane menu order');
		assert.ok(pqMenu.includes('IsDevelopmentContext'), 'openPromptQualityFromPane menu internal gate');
	});

	it('REFUTED siblings are not registered as commands', () => {
		// duplicate_tab / export_chat are telemetry event names only; the
		// export action's publicLog of the event name is legitimate and is
		// not a registration, so assert on registration shapes instead.
		assert.ok(!src.includes(`ID = 'composer.duplicate_tab'`));
		assert.ok(!src.includes(`ID = 'composer.export_chat'`));
		assert.ok(!src.includes('registerAction2(ComposerDuplicateTab'));
		// renameComposer / deepCloneComposer are service methods in the
		// binary — no Action2 may claim those ids.
		assert.ok(!src.includes(`ID = 'composer.renameComposer'`));
		assert.ok(!src.includes(`ID = 'composer.deepCloneComposer'`));
	});
});
