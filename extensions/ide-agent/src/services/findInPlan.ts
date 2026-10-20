/**
 * Find in Plan — host-side glue for the pane-level plan find family
 * (GAPS-157, `plan-find-in-plan`).
 *
 * Cursor 3.25.9 glass registers the binary-verbatim family
 * `showPlanFind` / `hidePlanFind` / `nextPlanFindMatch` /
 * `previousPlanFindMatch` (workbench core — composerActions.ts; decls
 * @25981307–25981426, registrations @45501537–@45502700, weight 256) and
 * emits `planFindRequested` / `planFindCloseRequested` /
 * `planFindNextMatchRequested` / `planFindPreviousMatchRequested` on the
 * glass event bus; the glass plan TAB's React find bar
 * ("plan-find-bar.react.js", config D2_ @32788864) consumes them.
 *
 * The fork has no plan tab — plan review happens in the chat webview's
 * plan tray (planCopyService.ts:27-29) and the plan's content is the
 * plan-mode assistant bubble in the transcript, identified exactly by
 * the host's PendingPlan.bubbleId. So the core actions delegate to the
 * ide.* commands registered in extension.ts, and this host glue tells
 * the ACTIVE chat surface's webview what to do:
 *   { type: "showFindInPlan" }     → plan find bar appears, scoped to the
 *                                    plan bubble, input focus+selected.
 *   { type: "hideFindInPlan" }     → bar hides, highlights clear, DOM
 *                                    focus returns to the composer input.
 *   { type: "findNextInPlan" }     → advance to the next match (wrap).
 *   { type: "findPreviousInPlan" } → go back to the previous match (wrap).
 *
 * The webview reports the bar's state back ({type:'planFindBarState',
 * open, inputFocused}), which the host maps to the VERBATIM context keys
 * `glassPlanFindBarVisible` (@23559865) and `glassFindInputFocused`
 * (@23559425 — the GENERIC glass find-input key, not the chat family's
 * glassChatFindInputFocused) so the core hide/next/previous keybindings
 * fire only while the plan find bar is open and its input is focused
 * (binary when-clauses). The host also maintains the fork-only
 * `composerPlanTrayVisible` key — the port of the binary's
 * `glassActiveTabKind == Plan` when-arm — from the ComposerDataService
 * planReady/planCleared events (the same events that show/hide the tray).
 */

/** Webview message types understood by the composer's plan find bar. */
export const SHOW_FIND_IN_PLAN = "showFindInPlan";
export const HIDE_FIND_IN_PLAN = "hideFindInPlan";
export const FIND_NEXT_IN_PLAN = "findNextInPlan";
export const FIND_PREVIOUS_IN_PLAN = "findPreviousInPlan";
/** Webview → host message reporting the plan find bar's state. */
export const PLAN_FIND_BAR_STATE = "planFindBarState";

/**
 * GAPS-157: context keys maintained from the planFindBarState report —
 * the VERBATIM Cursor 3.25.9 keys (workbench.glass.main.js @23559865 /
 * @23559425) gating the pane-level `hidePlanFind` / `nextPlanFindMatch` /
 * `previousPlanFindMatch` keybindings in workbench core.
 */
export const GLASS_PLAN_FIND_BAR_VISIBLE_KEY = "glassPlanFindBarVisible";
export const GLASS_FIND_INPUT_FOCUSED_KEY = "glassFindInputFocused";
/**
 * Fork-only key carrying the binary's `glassActiveTabKind == Plan`
 * when-arm: a pending plan tray is shown on the chat surface. The fork
 * has no glass plan tab, so the tray's presence is the plan surface.
 */
export const COMPOSER_PLAN_TRAY_VISIBLE_KEY = "composerPlanTrayVisible";

/** Shape of the webview → host plan find-bar state report. */
export interface PlanFindBarStateReport {
  open: boolean;
  inputFocused?: boolean;
}

/**
 * Pure mapping from a planFindBarState report to the context-key updates
 * the host must apply via `setContext` — one source of truth so BOTH
 * chat surfaces (sidebar view + chat editor tab) keep both keys in
 * sync. `glassFindInputFocused` can only be true while the bar is open
 * (a closed bar's input cannot hold focus; the webview also reports
 * inputFocused:false on hide, this clamp keeps the keys truthful even
 * for a stale/racing report). Mirrors findBarContextUpdates() for the
 * chat family (services/findInChat.ts).
 */
export function planFindBarContextUpdates(report: PlanFindBarStateReport): Array<readonly [string, boolean]> {
  const open = report.open === true;
  const inputFocused = open && report.inputFocused === true;
  return [
    [GLASS_PLAN_FIND_BAR_VISIBLE_KEY, open],
    [GLASS_FIND_INPUT_FOCUSED_KEY, inputFocused],
  ];
}

/**
 * Pure mapping for the plan-surface key: the host applies this from the
 * ComposerDataService planReady (pending = true) / planCleared
 * (pending = false) events — the same events that show/hide the webview
 * tray, so the key can never claim a plan surface the tray doesn't show.
 */
export function planTrayContextUpdates(planPending: boolean): Array<readonly [string, boolean]> {
  return [[COMPOSER_PLAN_TRAY_VISIBLE_KEY, planPending === true]];
}

/** Minimal host surface — anything that can post to the chat webview. */
export interface FindInPlanHost {
  postToWebview(message: unknown): void;
}

/**
 * Show the plan find bar in the active chat surface's webview.
 * The caller (extension.ts) resolves the host to the active surface —
 * sidebar view or chat editor tab — via makeChatAttachHost().
 */
export function showFindInPlan(host: FindInPlanHost): void {
  host.postToWebview({ type: SHOW_FIND_IN_PLAN });
}

/** Hide the plan find bar; the webview returns focus to the composer input. */
export function hideFindInPlan(host: FindInPlanHost): void {
  host.postToWebview({ type: HIDE_FIND_IN_PLAN });
}

/**
 * Advance the plan find bar to the next match (binary
 * `nextPlanFindMatch`, Enter). The host only forwards the intent — the
 * webview owns the <mark> highlights. No-op in the webview when the bar
 * is closed or there are no matches (the binary's SearchPlugin likewise
 * returns false when `!query || matches.length===0`, SearchPlugin.js
 * @15060037 region).
 */
export function findNextInPlan(host: FindInPlanHost): void {
  host.postToWebview({ type: FIND_NEXT_IN_PLAN });
}

/**
 * Go back to the previous match (binary `previousPlanFindMatch`,
 * Shift+Enter). Same no-op semantics as findNextInPlan.
 */
export function findPreviousInPlan(host: FindInPlanHost): void {
  host.postToWebview({ type: FIND_PREVIOUS_IN_PLAN });
}
