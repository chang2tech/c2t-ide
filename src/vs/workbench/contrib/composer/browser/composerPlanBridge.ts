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
//
// GAPS-181 adds the consumer half in this same file/layer:
// `ComposerPlanAcceptConsumerContribution` (below) subscribes to the plan
// service's `onDidAcceptPlan` and forwards accepted plans to the extension
// build phase via `ide.acceptPlanFromCore` — closing W71B-F1, where the
// event previously had no live consumer.

import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { URI } from '../../../../base/common/uri.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { AcceptedPlan, IComposerPlanService } from '../common/composerPlanService.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';

/** Fork-side wire id: extension plan producer -> core plan registry. */
export const IDE_RECORD_COMPOSER_PLAN_COMMAND_ID = 'ide.recordComposerPlan';
/** Fork-side wire id: extension plan discard / new chat -> core plan registry. */
export const IDE_CLEAR_COMPOSER_PLAN_COMMAND_ID = 'ide.clearComposerPlan';
/** Fork-side wire id: core plan-accept event -> extension build phase (GAPS-181, consumer C2). */
export const IDE_ACCEPT_PLAN_FROM_CORE_COMMAND_ID = 'ide.acceptPlanFromCore';

function getPlanService(accessor: ServicesAccessor): IComposerPlanService | undefined {
	try {
		return accessor.get(IComposerPlanService);
	} catch {
		return undefined; // plan service not registered on this platform build
	}
}

function registerRecordCommand(): void {
	CommandsRegistry.registerCommand(
		IDE_RECORD_COMPOSER_PLAN_COMMAND_ID,
		(accessor: ServicesAccessor, tabId?: unknown, bubbleId?: unknown, planUri?: unknown, planText?: unknown): void => {
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
			let uri: URI;
			try {
				uri = URI.parse(planUri);
			} catch {
				return;
			}
			planService.recordPlan(tabId, bubbleId, uri, typeof planText === 'string' ? planText : '');
		});
}

function registerClearCommand(): void {
	CommandsRegistry.registerCommand(
		IDE_CLEAR_COMPOSER_PLAN_COMMAND_ID,
		(accessor: ServicesAccessor, tabId?: unknown): void => {
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

/**
 * GAPS-181 (CAT-B port, acceptPlan consumer C2 — the W71B-F1 follow-up):
 * live consumer of `IComposerPlanService.onDidAcceptPlan`.
 *
 * In Cursor the plan service submits the accepted plan to the composer's
 * engine itself (`acceptPlan` @18684727 ends in
 * `submitChatMaybeAbortCurrent(..., { isPlanExecution: true, planUri,
 * planTitle, bubbleId })`). In the fork the engine is owned by the
 * ide-agent extension's per-tab composer, which core DI cannot reach, so
 * the core plan service hands the accepted plan over through
 * `onDidAcceptPlan` — and until now the ONLY subscriber was the dead core
 * `electron-browser/composerDataService.ts` (`onCorePlanAccepted`, a
 * no-op in a class that is deliberately never instantiated), so a plan
 * accepted through the core `composer.acceptPlan` command path fired an
 * event nobody consumed and nothing was ever built.
 *
 * This contribution is that missing consumer: it forwards every accepted
 * plan to the extension runtime handler `ide.acceptPlanFromCore`
 * (registered by the ide-agent extension's COMMANDS table), which runs
 * the build phase on the tab that owns the plan. Forwarding goes through
 * `ICommandService.executeCommand` — the fork's standing core->extension
 * delegation idiom (cf. AgentNotificationBridgeContribution ->
 * `ide.*FromNotification`). Fire-and-forget with error logging: a missing
 * extension handler (extension disabled/restarting) must never break the
 * plan service or the caller of `composer.acceptPlan`.
 *
 * Instantiating this contribution eagerly instantiates the Delayed
 * `IComposerPlanService` singleton at Restored — deliberate (same
 * precedent as TooltipEventProducerContribution eagerly instantiating
 * the tooltip service): the subscription must exist before any accept.
 */
export class ComposerPlanAcceptConsumerContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.composer.planAcceptConsumer';

	constructor(
		@IComposerPlanService planService: IComposerPlanService,
		@ICommandService private readonly commandService: ICommandService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(planService.onDidAcceptPlan(accepted => {
			void this.forwardAcceptedPlan(accepted);
		}));
	}

	/** Forward one accepted plan to the extension build-phase handler. Never rejects. */
	async forwardAcceptedPlan(accepted: AcceptedPlan): Promise<void> {
		try {
			await this.commandService.executeCommand(
				IDE_ACCEPT_PLAN_FROM_CORE_COMMAND_ID,
				accepted.composerId,
				accepted.planText,
				accepted.planUri.toString(),
				// GAPS-186: the `_loadPlanExecutionData` extraction the core
				// plan service computed for this accept (binary consumers:
				// `planTitle` rides the execution submit, `planTodos` seeds
				// the composer's todo list). Trailing optional arg: older
				// extension builds ignore it. Plain JSON-safe copies — the
				// command crosses the extension-host boundary.
				{
					planName: accepted.planName,
					planTitle: accepted.planTitle,
					planTodos: accepted.planTodos.map(t => ({
						id: t.id,
						content: t.content,
						status: t.status,
						...(t.dependencies ? { dependencies: [...t.dependencies] } : {}),
					})),
				},
			);
		} catch (e) {
			this.logService.warn('[composer] acceptPlan: forwarding the accepted plan to the extension failed', e);
		}
	}
}
