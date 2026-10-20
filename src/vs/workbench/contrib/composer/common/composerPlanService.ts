/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: core contract for the composer plan service — Cursor parity.
//
// Binary evidence (Cursor 3.25.9, `workbench.desktop.main.js` — W-REA CONFIRMED,
// all claims below verified against the binary, not inferred):
// - service id "composerPlanService", module `composerPlanService.js` @18677949
//   (`gz` in the `composer.acceptPlan` command body @29969972). It is a
//   SEPARATE service from the composer data service (`Qs` = "composerDataService").
// - `getPlanUriFromBubble(handle, bubbleId)` @18683492:
//   `getPlanBubbleData(handle, bubbleId)?.additionalData; if (i?.planUri) return parseURI(i.planUri)`
//   — a plan URI is returned ONLY when the bubble is a CREATE_PLAN tool bubble.
// - `acceptPlan(handle, planUri, bubbleId?, source?, opts?)` @18684727,
//   `opts = { unifiedMode, skipSubmission }`; the `composer.acceptPlan`
//   command passes only the first three arguments.
// - the real "Accept plan" UX calls the service directly: PlanReviewModel
//   APPROVE -> `composerPlanService.acceptPlan(n, s, bubbleId, "manual", { unifiedMode })`.
// - `composer.acceptPlan` itself has NO internal caller (the command string
//   occurs exactly once per bundle): it is a bare API command.

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';

export const IComposerPlanService = createDecorator<IComposerPlanService>('composerPlanService');

/** Mirrors the `opts` parameter of Cursor's `composerPlanService.acceptPlan`. */
export interface PlanAcceptOptions {
	unifiedMode?: boolean;
	skipSubmission?: boolean;
}

/**
 * GAPS-186: one plan todo, mirroring the frontmatter todo shape Cursor's
 * plan storage parses (`g$e`: `{ id, content, status, dependencies }`,
 * defaults id generated / status `"pending"`). See
 * `PlanExecutionData` below.
 */
export interface PlanTodo {
	readonly id: string;
	readonly content: string;
	readonly status: string;
	readonly dependencies?: readonly string[];
}

/**
 * GAPS-186: the fork port of Cursor's `_loadPlanExecutionData(uri)`
 * result (@18692365, binary-verbatim shape):
 * `{ fullPlanContent, nonCompletedTodos, planContent, planName, planTodos }`.
 * Cursor loads it from the plan file through `planStorageService.loadPlanByUri`:
 * `planName`/`planTodos` come from the file's YAML frontmatter
 * (`metadata.name` / `metadata.todos ?? []`), `planContent` is the body,
 * `nonCompletedTodos` filters out `completed`/`cancelled`, and
 * `fullPlanContent` re-serializes the frontmatter (`f$e` @18657010) in
 * front of the body for the `executePlanAction` payload.
 *
 * Fork adaptation (see `extractPlanExecutionData` in the browser service
 * for the full divergence notes): fork plan files carry no frontmatter
 * (the extension's `savePlanFile` writes `# Plan — <ISO>` + raw markdown),
 * so `planName` is `''` unless a Cursor-style frontmatter block is present,
 * and `planTodos` falls back to the markdown checkbox items in the body.
 * `planTitle` is the value Cursor's consumers actually use
 * (`e7e(planContent, planName)` @15901077: first body line without `#`,
 * else planName, else `"Untitled Plan"`); it is carried alongside the
 * verbatim fields so consumers do not each re-derive it.
 */
export interface PlanExecutionData {
	readonly planName: string;
	readonly planTitle: string;
	readonly planTodos: readonly PlanTodo[];
	readonly nonCompletedTodos: readonly PlanTodo[];
	readonly planContent: string;
}

/**
 * GAPS-186: analytics event Cursor's plan service tracks inside
 * `acceptPlan` (@18685640, after the plan data loads, before any submit —
 * so it also fires when `skipSubmission` is set):
 * `trackEvent("composer.plan_mode.plan_accepted", { composer_id, model,
 * plan_execution_model, plan_execution_max_mode, execution_target,
 * todos_selected, source ?? "manual", invocationID })`.
 * The fork emits it through `ITelemetryService.publicLog` (the standing
 * core precedent for `trackEvent`, cf. `composer.export_chat` in
 * composerActions.ts) with the properties the core plan service can
 * source truthfully; `model` / `plan_execution_*` / `invocationID` have
 * no source in this service and are omitted (see the browser service).
 */
export const PLAN_ACCEPTED_ANALYTICS_EVENT = 'composer.plan_mode.plan_accepted';

/** Payload of `IComposerPlanService.onDidAcceptPlan`. */
export interface AcceptedPlan {
	readonly composerId: string;
	readonly planUri: URI;
	readonly bubbleId?: string;
	readonly planText: string;
	readonly source?: string;
	/** GAPS-186: `_loadPlanExecutionData` extraction over `planText`. */
	readonly planName: string;
	/** GAPS-186: `e7e(planContent, planName)` — the title Cursor submits with. */
	readonly planTitle: string;
	/** GAPS-186: extracted plan todos (frontmatter, else body checkboxes). */
	readonly planTodos: readonly PlanTodo[];
}

export interface IComposerPlanService {
	readonly _serviceBrand: undefined;

	/**
	 * Fires when a plan is accepted in core (after the plan file is resolved
	 * and the record is cleared). Cursor's plan service submits the plan to
	 * the composer's engine internally; the fork's engine is owned by the
	 * ide-agent extension and per-tab composers are not reachable from core
	 * DI (`IComposerDataService` is deliberately unregistered — see
	 * `electron-browser/composer.contribution.ts`), so core hands the accepted
	 * plan to the plan owner through this event. `skipSubmission` suppresses it.
	 */
	readonly onDidAcceptPlan: Event<AcceptedPlan>;

	/**
	 * Cursor parity (`getPlanUriFromBubble(handle, bubbleId)` @18683492):
	 * resolve the plan URI for a bubble of the given composer.
	 *
	 * HONEST-DIVERGENCE: Cursor reads `additionalData.planUri` off the
	 * CREATE_PLAN tool bubble (`getPlanBubbleData`). The fork has no plan
	 * bubbles (`../common/bubble.ts` has no plan concept), so the gate is
	 * implemented over the fork's per-composer plan registry: a URI is
	 * returned only when `bubbleId` matches the bubble that produced the
	 * recorded plan — the same "only plan bubbles carry a plan URI" gate,
	 * keyed differently. Records are populated via `recordPlan` by the plan
	 * producer.
	 */
	getPlanUriFromBubble(composerId: string, bubbleId: unknown): URI | undefined;

	/**
	 * Cursor parity (`acceptPlan(handle, planUri, bubbleId?, source?, opts?)`
	 * @18684727): accept the plan at `planUri` for the given composer.
	 * Resolves the plan file (the file is the source of truth; falls back to
	 * the recorded text), extracts the plan execution data
	 * (`_loadPlanExecutionData` port, GAPS-186), tracks
	 * `composer.plan_mode.plan_accepted` (GAPS-186; fires even when
	 * `skipSubmission` is set, exactly like the binary's ordering, and
	 * never when there is no plan content), clears the consumed plan
	 * record, then fires `onDidAcceptPlan` — carrying the extraction —
	 * unless `opts.skipSubmission` is set.
	 */
	acceptPlan(composerId: string, planUri: URI, bubbleId?: unknown, source?: string, opts?: PlanAcceptOptions): Promise<void>;

	/**
	 * Fork-side producer API: record a plan produced for a composer
	 * (Cursor reads this off the CREATE_PLAN tool bubble instead, so it has
	 * no producer API — 0 `recordPlan` hits in the 3.25.9 bundle,
	 * binary-verified). Wired in the fork's LIVE plan producer (W71B): the
	 * ide-agent extension's per-tab `ComposerDataService.capturePendingPlan`
	 * persists the plan and forwards it through the `ide.recordComposerPlan`
	 * command (`browser/composerPlanBridge.ts`) into this registry —
	 * `ide.*` ids are fork-side wire ids, deliberately NOT Cursor-verbatim.
	 * The core `electron-browser/composerDataService.ts` producer call is
	 * dead (that class is deliberately not instantiated). Until recorded,
	 * `getPlanUriFromBubble` resolves nothing and `composer.acceptPlan`
	 * no-ops, exactly like Cursor for a non-plan bubble.
	 */
	recordPlan(composerId: string, bubbleId: string, planUri: URI, planText: string): void;

	/** Drop the recorded plan for a composer without accepting it. */
	clearPlan(composerId: string): void;
}
