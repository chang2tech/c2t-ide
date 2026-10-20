/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// GAPS-157 (`plan-find-in-plan`, 2026-10-20): pure spec + predicates for
// Cursor's pane-level Find in Plan family — the glass-layer sibling of
// `chatFindPane.ts` (GAPS-134). Kept free of vscode imports so the
// when-clause semantics are unit-testable standalone; `composerActions.ts`
// builds the real ContextKeyExpr from the same shape.
//
// Binary spec (Cursor 3.25.9, workbench.glass.main.js, verified first-hand
// by GAPS-153 entry 3 + re-verified/sliced by GAPS-157, see
// docs/rea/work-notes-gaps157.md slice 1):
//   ids (decl @25981307–25981426): showPlanFind / hidePlanFind /
//     nextPlanFindMatch / previousPlanFindMatch — bare, unprefixed, and
//     ALL FOUR have `glass.*` aliases (unlike chat, whose show has none):
//     the plan find bar's config (D2_ @32788864, module
//     "plan-find-bar.react.js") consumes glass.nextPlanFindMatch /
//     glass.previousPlanFindMatch / glass.hidePlanFind as command ids.
//   registrations (Ir @45501537–@45502700): titles "Find in Plan" /
//     "Close Plan Find" / "Find Next in Plan" / "Find Previous in Plan";
//     glassCategory "View", keybindingCategory Sa.PLAN, scope
//     AGENT_WORKSPACE; ALL keybindings weight gp+6 = 256 (gp=250
//     @45469684); registrations use plain `Ir`, so there are NO
//     `*WithoutAgentWorkspace` twins (unlike the QJi-registered chat
//     family).
//     show = CtrlCmd+F, f1:{when:cf.isEqualTo(Ot.Plan)}, when xan([Ot.Plan]),
//       run emits {type:"planFindRequested"} on the `ll` event bus.
//     hide = Escape, f1:!1 (NO hidden flag, unlike chat), when
//       and(cf.isEqualTo(Ot.Plan), glassPlanFindBarVisible), run emits
//       {type:"planFindCloseRequested"}.
//     next = Enter ONLY (NO F3 secondary, unlike chat), f1:!1, when
//       and(cf.isEqualTo(Ot.Plan), glassPlanFindBarVisible,
//       glassFindInputFocused), run emits
//       {type:"planFindNextMatchRequested"}.
//     previous = Shift+Enter, f1:!1, same when, run emits
//       {type:"planFindPreviousMatchRequested"}.
//   xan (@45444568): and(glassEditorPanelFocused,
//     !glassTranscriptFocused, !glassPromptInputFocused,
//     !glassChatFindInputFocused, or(cf.isEqualTo(kind))).
//   Context keys: glassPlanFindBarVisible (e3i @23559865, plan-specific),
//     glassFindInputFocused (MX @23559425 — the GENERIC glass find-input
//     key shared with the markdown-preview find bar; NOT the chat family's
//     glassChatFindInputFocused).

/** Command ids of the pane-level family (binary-verbatim, unprefixed). */
export const SHOW_PLAN_FIND_ID = 'showPlanFind';
export const HIDE_PLAN_FIND_ID = 'hidePlanFind';
export const NEXT_PLAN_FIND_MATCH_ID = 'nextPlanFindMatch';
export const PREVIOUS_PLAN_FIND_MATCH_ID = 'previousPlanFindMatch';

/** `glass.*` aliases — binary declares these for ALL FOUR commands. */
export const GLASS_SHOW_PLAN_FIND_ID = 'glass.showPlanFind';
export const GLASS_HIDE_PLAN_FIND_ID = 'glass.hidePlanFind';
export const GLASS_NEXT_PLAN_FIND_MATCH_ID = 'glass.nextPlanFindMatch';
export const GLASS_PREVIOUS_PLAN_FIND_MATCH_ID = 'glass.previousPlanFindMatch';

/** Command titles (binary-verbatim). */
export const SHOW_PLAN_FIND_TITLE = 'Find in Plan';
export const HIDE_PLAN_FIND_TITLE = 'Close Plan Find';
export const NEXT_PLAN_FIND_MATCH_TITLE = 'Find Next in Plan';
export const PREVIOUS_PLAN_FIND_MATCH_TITLE = 'Find Previous in Plan';

/** Binary keybinding weight: gp+6 with gp=250 (@45469684) = 256. */
export const PLAN_FIND_KEYBINDING_WEIGHT = 256;

/** Verbatim context key names (binary @23559865 / @23559425). */
export const GLASS_PLAN_FIND_BAR_VISIBLE_KEY = 'glassPlanFindBarVisible';
export const GLASS_FIND_INPUT_FOCUSED_KEY = 'glassFindInputFocused';

/**
 * Fork-only context key carrying the plan-surface arm of the binary
 * when-clauses (`cf.isEqualTo(Ot.Plan)` — the active glass tab kind is
 * Plan). The fork has no glass plan tab; its plan surface is the pending
 * plan tray in the chat webview, so the ide-agent extension maintains
 * this key from the same ComposerDataService planReady/planCleared
 * events that show/hide the tray (see services/findInPlan.ts).
 */
export const COMPOSER_PLAN_TRAY_VISIBLE_KEY = 'composerPlanTrayVisible';

/**
 * Focus snapshot the fork's `xan([Ot.Plan])` port is evaluated against.
 * Field names map 1:1 onto the context keys the when-clauses in
 * composerActions.ts are built from:
 *   chatSurface            <- fork merge of glassEditorPanelFocused (the
 *                             plan tray lives inside the chat surface —
 *                             sidebar view `composer.chat` or an `ide-chat`
 *                             editor tab; the same surface test every
 *                             chat-scope binding here uses).
 *   planTrayVisible        <- port of cf.isEqualTo(Ot.Plan) (see
 *                             COMPOSER_PLAN_TRAY_VISIBLE_KEY above).
 *   chatFindInputFocused   <- glassChatFindInputFocused (verbatim key,
 *                             negated arm of xan via AZb).
 *   chatFindBarVisible     <- glassChatFindBarVisible (fork-only arm,
 *                             see shouldShowPlanFind).
 */
export interface PlanFindShowFocusState {
	readonly chatSurface: boolean;
	readonly planTrayVisible: boolean;
	readonly chatFindInputFocused: boolean;
	readonly chatFindBarVisible: boolean;
}

/**
 * The fork port of the binary `showPlanFind` when-clause `xan([Ot.Plan])`:
 *   binary: glassEditorPanelFocused && !glassTranscriptFocused &&
 *           !glassPromptInputFocused && !glassChatFindInputFocused &&
 *           glassActiveTabKind == Plan
 *   fork:   chatSurface && planTrayVisible && !chatFindInputFocused &&
 *           !chatFindBarVisible
 *
 * Documented divergences (also in composerActions.ts):
 * - glassTranscriptFocused / glassPromptInputFocused have no fork keys:
 *   in the fork the transcript and the prompt live in the one chat
 *   surface, so those negated arms are folded into the positive
 *   `chatSurface` arm — the same merge GAPS-134 used for the chat
 *   family's YRx port.
 * - `!chatFindBarVisible` is a fork-only arm: in glass the chat find bar
 *   and the plan find bar can never coexist (different tabs), but the
 *   fork's merged chat surface hosts both bars, so an open chat find bar
 *   must win Ctrl+F (it is the transcript's bar) instead of stacking the
 *   plan bar on top of it.
 */
export function shouldShowPlanFind(state: PlanFindShowFocusState): boolean {
	return state.chatSurface
		&& state.planTrayVisible
		&& !state.chatFindInputFocused
		&& !state.chatFindBarVisible;
}

/**
 * Binary when for hidePlanFind: `and(cf.isEqualTo(Ot.Plan),
 * glassPlanFindBarVisible)` — planTrayVisible is the fork port of the
 * tab-kind arm.
 */
export function shouldHidePlanFind(planTrayVisible: boolean, barVisible: boolean): boolean {
	return planTrayVisible && barVisible;
}

/**
 * Binary when for next/previousPlanFindMatch: `and(cf.isEqualTo(Ot.Plan),
 * glassPlanFindBarVisible, glassFindInputFocused)`.
 */
export function shouldNavigatePlanFind(planTrayVisible: boolean, barVisible: boolean, inputFocused: boolean): boolean {
	return planTrayVisible && barVisible && inputFocused;
}
