/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Context keys owned by the `contrib/agents` workbench contribution.
//
// Task history note: the previous `browser/agents.contribution.ts` was an
// unimplemented skeleton (4 TODOs); this module is part of the commit that
// replaces it with the real Cursor-structured implementation.
//
// Binary evidence (Cursor 3.25.9, offsets into
// `usr/share/cursor/resources/app/out/vs/workbench/workbench.desktop.main.js`
// — verified 2026-10-20 by this task):
//   - `e.agentNavigationMode=new Mt("agentNavigationMode",!1,
//     {type:"boolean",description:k(4752,null)})` (offset 16975602) — a
//     BOOLEAN context key, default FALSE. A previous commit wrongly modeled
//     it as a 'keyboard'|'mouse' string enum with picker-driven wiring in
//     `browser/agentsQuickAccess.ts`; that invented wiring was deleted in
//     the 2026-10-20 rework. The binary sets it in the composer
//     select-previous/next chat actions' hold-and-release navigation
//     (`c.set(!0)` on enterNavigationMode, `c.set(!1)` on keyup-finalize —
//     see the `fgm` handler region): those actions live outside this module,
//     so this key is defined here but not SET anywhere in contrib/agents.
//   - `e.agentsPaneFocused=new Mt("agentsPaneFocused",!1,
//     {type:"boolean",description:k(4751,null)})` (offset 16975507) — boolean,
//     default false.
//   - Descriptions are binary-verbatim (nls.messages.json indices 4751/4752):
//     agentsPaneFocused -> 'Whether the Agents sidebar currently contains
//     keyboard focus.'; agentNavigationMode -> 'Whether currently in agent
//     navigation mode (hold-and-release to switch).'
// `when` clauses MUST compare agentNavigationMode as a boolean
// (`ContextKeyExpr.has('agentNavigationMode')` / `.negate()`), never as a
// string — the string-enum form broke `when` evaluation.

import { localize } from '../../../../nls.js';
import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';

export namespace AgentsContextKeys {

	/**
	 * Whether the agents pane currently has DOM focus.
	 *
	 * Binary-verbatim key name `agentsPaneFocused` and description
	 * ('Whether the Agents sidebar currently contains keyboard focus.').
	 * Fork mapping: the agents pane is the agent chat surface, which in this
	 * fork is the core `composer.chat` view (`ComposerView` in
	 * `contrib/composer`). Bound by `AgentsWorkbenchContribution` in
	 * `browser/agents.contribution.ts` via the view pane's onDidFocus/onDidBlur.
	 */
	export const agentsPaneFocused = new RawContextKey<boolean>(
		'agentsPaneFocused',
		false,
		localize('agentsPaneFocused', 'Whether the Agents sidebar currently contains keyboard focus.')
	);

	/**
	 * Whether the user is currently in agent navigation mode
	 * (hold-and-release to switch).
	 *
	 * Binary-verbatim key name `agentNavigationMode`, BOOLEAN type, default
	 * FALSE, verbatim description. The binary flips it in the composer
	 * select-previous/next chat actions' hold-and-release navigation
	 * (true on enter, false on keyup-finalize) — those actions are outside
	 * this module, so nothing in contrib/agents sets this key yet.
	 */
	export const agentNavigationMode = new RawContextKey<boolean>(
		'agentNavigationMode',
		false,
		localize('agentNavigationMode', 'Whether currently in agent navigation mode (hold-and-release to switch).')
	);
}
