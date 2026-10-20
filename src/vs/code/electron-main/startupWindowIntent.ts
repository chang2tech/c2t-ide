/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: startup window routing for the Cursor-parity CLI flags
// `--chat` / `--glass` / `--classic` (P0 cli-glass-classic-chat-flags,
// rea-dissection-auditor run 30, 2026-10-20).
//
// Binary evidence (Cursor 3.25.9 `out/main.js`, QA W38E2 adversarial
// verification): there is NO app-side suppression of `--glass`/`--classic`.
// `get isGlass(){return!!this.args.glass}`, `resolveIsGlass(e)`,
// `openGlassWindow` and `cursorFocusOrOpenEditorWindow` (the `--classic`
// flow, wired into the production menubar handler) carry no dev-gating at
// all; the ONLY "(dev-only)" string in main.js is `"harness-dev-only-1"`,
// which is unrelated. The "(dev-only)" marker exists solely in the NLS help
// text of the CLI flags — all three are registered PUBLIC bool flags in
// `out/cli.js` (cat "o") and are EFFECTIVE in production builds.
// "Exactly as Cursor does" = the flags take effect; no VSCODE_DEV gating.
//
// Kept as a pure, unit-testable function so the precedence rules below can
// be verified without booting the app.

import { NativeParsedArgs } from '../../platform/environment/common/argv.js';

/** Which dedicated window (if any) the startup CLI args request. */
export type StartupWindowIntent = 'agents' | 'chat' | 'glass' | 'none';

export interface StartupWindowRouting {
	/**
	 * Explicit `--classic`: force a classic (normal) window, suppressing
	 * every glass/agents routing — including the `--agents` flag, the
	 * `--glass` flag, and the `ide.window.openAgentsWindowOnStartup`
	 * preference. Mirrors Cursor's "Disable glass mode and force classic
	 * windows".
	 */
	forceClassic: boolean;
	/** The dedicated window requested by the CLI args (ignored when forceClassic). */
	intent: StartupWindowIntent;
}

/**
 * Resolves the startup window routing from parsed CLI args.
 *
 * No dev-gating: per binary evidence (Cursor 3.25.9 `out/main.js`,
 * QA W38E2), `--glass` and `--classic` are effective in production builds —
 * "(dev-only)" is NLS help text only, with no app-side suppression.
 *
 * Precedence (highest first):
 *   1. `--classic` — forces the classic window; everything else is ignored.
 *   2. `--agents`  — the dedicated agents window (pre-existing fork
 *      behavior, kept first among the dedicated intents so existing flows
 *      don't move).
 *   3. `--chat`    — the standalone chat window (bool flag form,
 *      `args.chat === true`; the positional `chat <prompt>` subcommand keeps
 *      its stock object shape and never reaches this as `true`).
 *   4. `--glass`   — open (or focus) the dedicated Agents ("glass") window.
 *   5. none        — normal startup flow (the glass-on-startup preference
 *      still applies afterwards unless `--classic` was given).
 */
export function resolveStartupWindowRouting(args: NativeParsedArgs): StartupWindowRouting {
	const classic = args['classic'] === true;
	const glass = args['glass'] === true;

	if (classic) {
		return { forceClassic: true, intent: 'none' };
	}
	if (args['agents'] === true) {
		return { forceClassic: false, intent: 'agents' };
	}
	if (args.chat === true) {
		return { forceClassic: false, intent: 'chat' };
	}
	if (glass) {
		return { forceClassic: false, intent: 'glass' };
	}
	return { forceClassic: false, intent: 'none' };
}
