/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { resolveStartupWindowRouting } from '../../electron-main/startupWindowIntent.js';
import { NativeParsedArgs } from '../../../platform/environment/common/argv.js';

// P0 cli-glass-classic-chat-flags (rea-dissection-auditor run 30,
// 2026-10-20; corrected per QA W38E2 adversarial verification): precedence
// for the Cursor-parity CLI flags --classic / --agents / --chat / --glass
// at startup.
//
// Binary evidence (Cursor 3.25.9 out/main.js): NO app-side dev-gating —
// get isGlass, resolveIsGlass, openGlassWindow and cursorFocusOrOpenEditorWindow
// (the --classic flow, wired into the production menubar handler) all fire
// in production builds. "(dev-only)" is NLS help text only. "Exactly as
// Cursor does" = the flags take effect, so there is NO VSCODE_DEV parameter
// and NO production no-op cases below.
suite('StartupWindowRouting (cli --classic/--agents/--chat/--glass)', () => {

	function args(overrides: Partial<NativeParsedArgs>): NativeParsedArgs {
		return { _: [], ...overrides } as NativeParsedArgs;
	}

	test('no flags -> default flow, nothing forced', () => {
		assert.deepStrictEqual(resolveStartupWindowRouting(args({})), { forceClassic: false, intent: 'none' });
	});

	test('--classic forces the classic window and suppresses every dedicated intent', () => {
		assert.deepStrictEqual(
			resolveStartupWindowRouting(args({ 'classic': true })),
			{ forceClassic: true, intent: 'none' }
		);
		// classic wins over agents/glass/chat combined
		assert.deepStrictEqual(
			resolveStartupWindowRouting(args({ 'classic': true, 'agents': true, 'glass': true, chat: true })),
			{ forceClassic: true, intent: 'none' }
		);
	});

	test('--agents keeps its pre-existing dedicated window', () => {
		assert.deepStrictEqual(
			resolveStartupWindowRouting(args({ 'agents': true })),
			{ forceClassic: false, intent: 'agents' }
		);
	});

	test('--chat (bool flag form) routes to the standalone chat window', () => {
		assert.deepStrictEqual(
			resolveStartupWindowRouting(args({ chat: true })),
			{ forceClassic: false, intent: 'chat' }
		);
	});

	test('the positional `chat` subcommand (object form) is NOT a chat-window intent', () => {
		// The subcommand shape keeps its stock behavior (handled elsewhere);
		// only the bool flag form means "standalone chat window".
		assert.deepStrictEqual(
			resolveStartupWindowRouting(args({ chat: { _: ['hello'], mode: 'ask' } })),
			{ forceClassic: false, intent: 'none' }
		);
	});

	test('--glass routes to the dedicated Agents (glass) window (effective, not dev-gated)', () => {
		assert.deepStrictEqual(
			resolveStartupWindowRouting(args({ 'glass': true })),
			{ forceClassic: false, intent: 'glass' }
		);
	});

	test('precedence: classic > agents > chat > glass', () => {
		assert.deepStrictEqual(
			resolveStartupWindowRouting(args({ 'classic': true, 'glass': true })),
			{ forceClassic: true, intent: 'none' }
		);
		assert.strictEqual(resolveStartupWindowRouting(args({ 'agents': true, chat: true })).intent, 'agents');
		assert.strictEqual(resolveStartupWindowRouting(args({ chat: true, 'glass': true })).intent, 'chat');
		assert.strictEqual(resolveStartupWindowRouting(args({ 'agents': true, 'glass': true })).intent, 'agents');
	});

	test('--glass does not override --chat/--agents', () => {
		assert.strictEqual(
			resolveStartupWindowRouting(args({ 'glass': true, chat: true })).intent,
			'chat'
		);
		assert.strictEqual(
			resolveStartupWindowRouting(args({ 'glass': true, 'agents': true })).intent,
			'agents'
		);
	});

	test('--classic does not let --chat or --agents through (force wins)', () => {
		assert.deepStrictEqual(
			resolveStartupWindowRouting(args({ 'classic': true, chat: true })),
			{ forceClassic: true, intent: 'none' }
		);
		assert.deepStrictEqual(
			resolveStartupWindowRouting(args({ 'classic': true, 'agents': true })),
			{ forceClassic: true, intent: 'none' }
		);
	});
});
