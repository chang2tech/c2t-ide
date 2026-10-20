/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: inline-diff suppression warning (Cursor parity).
//
// Binary evidence (Cursor 3.25.9, out/vs/workbench/workbench.glass.main.js):
// - Workbench contribution id:
//   `workbench.contrib.composer.inlineDiffSuppressionNotification`.
// - `{neverShowAgain: {id: "inlineDiff.tooManyChangesWarning"}}` — the "too
//   many changes" warning has a never-show-again toggle backed by
//   notification-service state.
// - Pairs with `cursor.inlineDiff.enablePerformanceProtection` ("Enable
//   performance protection for inline diffs. When enabled, inline diff
//   decorations will be suppressed if there are too many changes to prevent
//   editor unresponsiveness.").
//
// When the core `InlineEditService` suppresses inline-diff decorations
// (performance protection), this contribution shows the warning once per
// suppression; the user can silence it forever via the never-show-again
// toggle (persisted by the notification service).

import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import Severity from '../../../../base/common/severity.js';
import { INotificationService, NeverShowAgainScope } from '../../../../platform/notification/common/notification.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import type { IWorkbenchContribution } from '../../../common/contributions.js';
import { IInlineEditService, type IInlineEditSuppressionInfo } from '../common/inlineEditService.js';
import {
	INLINE_DIFF_SUPPRESSION_NOTIFICATION_ID,
	INLINE_DIFF_TOO_MANY_CHANGES_WARNING_ID,
	INLINE_DIFF_PERF_PROTECTION_CONFIG_KEY,
} from '../common/inlineDiffPerf.js';

export class InlineDiffSuppressionNotification extends Disposable implements IWorkbenchContribution {

	/** Binary-verbatim contribution id. */
	static readonly ID = INLINE_DIFF_SUPPRESSION_NOTIFICATION_ID;

	constructor(
		@INotificationService private readonly notificationService: INotificationService,
		@ICommandService private readonly commandService: ICommandService,
		// Registered from the electron-browser contribution (desktop-only),
		// where the core IInlineEditService is always registered — no
		// optional-service dance needed (this fork's DI has no `optional`).
		@IInlineEditService private readonly inlineEditService: IInlineEditService,
	) {
		super();
		this._register(this.inlineEditService.onDidSuppressDiffDecorations(info => this.onSuppressed(info)));
	}

	private onSuppressed(info: IInlineEditSuppressionInfo): void {
		this.notificationService.prompt(
			Severity.Warning,
			localize(
				'inlineDiffTooManyChanges',
				'Too many changes in the inline diff preview ({0} changes). Inline diff decorations were suppressed to keep the editor responsive.',
				info.changeCount,
			),
			[
				{
					label: localize('inlineDiffTooManyChanges.openSettings', 'Open Settings'),
					run: () => this.commandService.executeCommand(
						'workbench.action.openSettings',
						INLINE_DIFF_PERF_PROTECTION_CONFIG_KEY,
					),
				},
			],
			{
				neverShowAgain: {
					id: INLINE_DIFF_TOO_MANY_CHANGES_WARNING_ID,
					scope: NeverShowAgainScope.APPLICATION,
					isSecondary: true,
				},
			},
		);
	}
}
