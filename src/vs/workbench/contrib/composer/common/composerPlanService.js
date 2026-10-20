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
export const IComposerPlanService = createDecorator('composerPlanService');
