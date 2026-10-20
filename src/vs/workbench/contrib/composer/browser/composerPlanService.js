/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
// IDE-CODE: browser-layer implementation of `IComposerPlanService`
// (see `../common/composerPlanService.js` for the binary evidence and the
// Cursor-parity contract). Platform-agnostic: plan files are read through
// `IFileService`, so the service also registers on web builds (where no plan
// producer exists and the plan registry simply stays empty).
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../base/common/event.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
/** Normalize the `bubbleId` command arg: string verbatim, or `{ id | bubbleId }`. */
function normalizeBubbleId(bubbleId) {
    if (typeof bubbleId === 'string') {
        return bubbleId || undefined;
    }
    if (bubbleId && typeof bubbleId === 'object') {
        const id = bubbleId.id ?? bubbleId.bubbleId;
        return typeof id === 'string' && id ? id : undefined;
    }
    return undefined;
}
let ComposerPlanService = class ComposerPlanService extends Disposable {
    constructor(fileService, logService) {
        super();
        this.fileService = fileService;
        this.logService = logService;
        this._onDidAcceptPlan = this._register(new Emitter());
        this.onDidAcceptPlan = this._onDidAcceptPlan.event;
        /** composerId -> the plan currently awaiting review for that composer. */
        this.plans = new Map();
    }
    recordPlan(composerId, bubbleId, planUri, planText) {
        this.plans.set(composerId, { bubbleId, planUri, planText });
    }
    clearPlan(composerId) {
        this.plans.delete(composerId);
    }
    getPlanUriFromBubble(composerId, bubbleId) {
        const record = this.plans.get(composerId);
        if (!record) {
            return undefined;
        }
        // Same gate as Cursor's CREATE_PLAN-bubble check: only the bubble
        // that produced the plan resolves to a plan URI.
        const id = normalizeBubbleId(bubbleId);
        if (!id || id !== record.bubbleId) {
            return undefined;
        }
        return record.planUri;
    }
    async acceptPlan(composerId, planUri, bubbleId, source, opts) {
        const record = this.plans.get(composerId);
        const recorded = record && record.planUri.toString() === planUri.toString() ? record : undefined;
        // The plan file is the source of truth (mirrors the fork data
        // service's execute_plan semantics: the user may have edited the plan
        // on disk after it was generated). Fall back to the recorded text
        // when the file cannot be read.
        let planText = recorded?.planText ?? '';
        try {
            const content = await this.fileService.readFile(planUri);
            const diskText = content.value.toString().trim();
            if (diskText) {
                planText = diskText;
            }
        }
        catch (e) {
            this.logService.warn('[composer] acceptPlan: cannot read plan file, using recorded text', planUri.toString(), e);
        }
        if (!planText) {
            this.logService.warn('[composer] acceptPlan: no plan content for', planUri.toString());
            return;
        }
        this.clearPlan(composerId);
        if (opts?.skipSubmission) {
            return;
        }
        // Cursor submits the plan to the composer's engine here. The fork's
        // engine is extension-owned (see the interface docs); the accepted
        // plan is handed to the plan owner through this event.
        this._onDidAcceptPlan.fire({
            composerId,
            planUri,
            bubbleId: normalizeBubbleId(bubbleId),
            planText,
            source,
        });
    }
};
ComposerPlanService = __decorate([
    __param(0, IFileService),
    __param(1, ILogService)
], ComposerPlanService);
export { ComposerPlanService };
