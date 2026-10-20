/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// IDE-CODE: workbench-side bridge for the LIVE plan producer (W71B, DEV-GAPS-71).
//
// The fork's plan producer is the ide-agent extension's per-tab
// `ComposerDataService.capturePendingPlan`. The core
// `electron-browser/composerDataService.ts` is deliberately NOT instantiated
// (`IComposerDataService` is not registered — see
// `electron-browser/composer.contribution.ts`), so the `recordPlan` call
// wired there is dead code. The extension cannot reach core DI services, so
// it forwards produced plans through these two bare internal commands into
// the registered core `IComposerPlanService` registry. That is what makes
// the `composer.acceptPlan` command path (`getPlanUriFromBubble` ->
// `acceptPlan`, Cursor 3.25.9 @29969972) resolve fork plans.
//
// Wiring direction (chosen over instantiating the dead core data service per
// tab — that would run a second, parallel composer per tab next to the
// extension's live one):
//   extension capturePendingPlan -> `ide.recordComposerPlan` -> core registry
//   extension clearPendingPlan   -> `ide.clearComposerPlan`  -> core registry
// The registry key is the chat TAB id — the same id the `composer.acceptPlan`
// command resolves from the open `ComposerChatEditorInput`'s `tabId`.
//
// HONEST-DIVERGENCE: Cursor has NO such command — `recordPlan` has 0 hits in
// the 3.25.9 bundle (binary-verified); Cursor attaches the plan URI to the
// CREATE_PLAN tool bubble's `additionalData.planUri` (@18683492) instead.
// These `ide.*` ids are fork-side wire ids, deliberately NOT Cursor-verbatim.
// Raw `registerCommand`: no title, no category, no palette entry, no
// keybinding — internal wiring only, like `composer.acceptPlan` itself.
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { URI } from '../../../../base/common/uri.js';
import { IComposerPlanService } from '../common/composerPlanService.js';
/** Fork-side wire id: extension plan producer -> core plan registry. */
export const IDE_RECORD_COMPOSER_PLAN_COMMAND_ID = 'ide.recordComposerPlan';
/** Fork-side wire id: extension plan discard / new chat -> core plan registry. */
export const IDE_CLEAR_COMPOSER_PLAN_COMMAND_ID = 'ide.clearComposerPlan';
function getPlanService(accessor) {
    try {
        return accessor.get(IComposerPlanService);
    }
    catch {
        return undefined; // plan service not registered on this platform build
    }
}
function registerRecordCommand() {
    CommandsRegistry.registerCommand(IDE_RECORD_COMPOSER_PLAN_COMMAND_ID, (accessor, tabId, bubbleId, planUri, planText) => {
        const planService = getPlanService(accessor);
        if (!planService) {
            return;
        }
        // Defensive: the extension host is an untrusted arg source — a
        // malformed record must not poison the registry.
        if (typeof tabId !== 'string' || !tabId
            || typeof bubbleId !== 'string' || !bubbleId
            || typeof planUri !== 'string' || !planUri) {
            return;
        }
        let uri;
        try {
            uri = URI.parse(planUri);
        }
        catch {
            return;
        }
        planService.recordPlan(tabId, bubbleId, uri, typeof planText === 'string' ? planText : '');
    });
}
function registerClearCommand() {
    CommandsRegistry.registerCommand(IDE_CLEAR_COMPOSER_PLAN_COMMAND_ID, (accessor, tabId) => {
        const planService = getPlanService(accessor);
        if (!planService) {
            return;
        }
        if (typeof tabId !== 'string' || !tabId) {
            return;
        }
        planService.clearPlan(tabId);
    });
}
registerRecordCommand();
registerClearCommand();
