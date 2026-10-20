/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { toAction } from '../../../../../base/common/actions.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { INotificationService, NeverShowAgainScope, Severity } from '../../../../../platform/notification/common/notification.js';
import { IOpenerService, OpenOptions } from '../../../../../platform/opener/common/opener.js';
import { IStorageService, StorageScope } from '../../../../../platform/storage/common/storage.js';
import { IWorkbenchEnvironmentService } from '../../../../services/environment/common/environmentService.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { OPEN_LOCAL_LINKS_CONFIG_KEY, OPEN_LOCAL_LINKS_DEFAULT, URL_OPEN_TOAST_DONT_OPEN_ACTION_ID, URL_OPEN_TOAST_NEVER_SHOW_AGAIN_ID, UrlOpenToastTracker, resolveLocalLinkBrowserOpen } from '../../common/openLocalLinks.js';

/**
 * IDE-CODE (DEV-GAPS-147, settings-open-local-links): workbench consumer
 * for Cursor's "Open Local Links in Cursor Browser" setting.
 *
 * Binary evidence (Cursor 3.25.9, self-verified — full slices in
 * docs/rea/work-notes-gaps147.md §1.5/C1): Cursor pushes a localhost
 * interceptor as the FIRST opener of its OpenerService
 * (workbench.desktop.main.js @32435883, glass @40939356 — identical):
 *
 *   if (!options?.openExternal && ph(storage, "autoOpenLocalhostUrls") && lqt(uri)) {
 *     const url = pBn(target.toString());
 *     if (!gph(url, cursorCredsService.getBackendUrl()) && !isSshRemote(remoteAuthority)) {
 *       showUrlOpenToast(url) unless suppressLocalhostAutoOpenToast;
 *       return executeCommand("workbench.action.openBrowserEditor",
 *         { url, preserveFocus: !options?.fromUserGesture, trackingId: "opener_service", transient }), true;
 *     }
 *   }
 *   // otherwise fall through to the default external handling
 *
 * wrapped in a try/catch that swallows any error and falls through.
 *
 * Fork wiring at the equivalent point: this contribution registers an
 * `IOpener` through `IOpenerService.registerOpener`, which unshifts it
 * ahead of the workbench's external-resource opener (and after the
 * validators, exactly like the binary's open() loop). The decision —
 * including the verbatim `lqt` classifier, `pBn` normalization and the
 * backend/ssh-remote exclusions — lives in
 * common/openLocalLinks.ts (`resolveLocalLinkBrowserOpen`); this class
 * only supplies the live services and executes the same command the
 * binary executes.
 *
 * Known divergences (recorded in common/openLocalLinks.ts header): the
 * fork's `workbench.action.openBrowserEditor` does not honor
 * `trackingId`/`transient`; the fork has no Cursor backend-URL service,
 * so no backend URL is passed and that exclusion is vacuous here.
 *
 * UrlOpenToast (DEV-GAPS-159, QA-155 NF-2): the binary's toast service
 * (`urlOpenToastService`, desk @20961744) is ported in
 * {@link OpenLocalLinksOpenerContribution.showUrlOpenToast} below — the
 * 147 note that its texts "live outside the JS bundle and cannot be
 * quoted verbatim" was wrong: they are nls ids 12224/12225 in
 * `out/nls.messages.json` ("Opening {0} in Cursor Browser" /
 * "Don't Open", alignment cross-verified). The toast is shown right
 * before the open command, exactly like the binary; its "Don't Open"
 * action does NOT cancel the current open — it turns the setting off
 * (binary: reactive storage set false; fork: this configuration key set
 * to false — recorded divergence 2 in common/openLocalLinks.ts). The
 * binary's `suppressLocalhostAutoOpenToast` option has no fork
 * equivalent (no fork consumer C2 exists to set it), so the toast is
 * unconditional on this path.
 *
 * The upstream `workbench.browser.openLocalhostLinks` external opener
 * (LocalhostLinkOpenerContribution) is gated since DEV-GAPS-159 so it
 * can no longer pre-empt this interceptor (see
 * `resolveLegacyLocalhostLinkOpenerDecision` in common/openLocalLinks.ts).
 */
export class OpenLocalLinksOpenerContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.openLocalLinksOpener';

	private readonly urlOpenToastTracker = new UrlOpenToastTracker();

	constructor(
		@IOpenerService openerService: IOpenerService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ICommandService private readonly commandService: ICommandService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
		@INotificationService private readonly notificationService: INotificationService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();

		this._register(openerService.registerOpener(this));
	}

	/**
	 * The binary interceptor, as an `IOpener`: returns true only when the
	 * open was routed to the Browser Tab; false lets the workbench's
	 * remaining openers (external, command, editor) handle it — the
	 * binary's fall-through.
	 */
	async open(target: URI | string, options?: OpenOptions): Promise<boolean> {
		try {
			const url = resolveLocalLinkBrowserOpen(target, {
				openExternal: options?.openExternal,
				autoOpenLocalhostUrls: this.configurationService.getValue<boolean>(OPEN_LOCAL_LINKS_CONFIG_KEY) ?? OPEN_LOCAL_LINKS_DEFAULT,
				remoteAuthority: this.environmentService.remoteAuthority,
			});
			if (url === undefined) {
				return false;
			}
			this.showUrlOpenToast(url);
			await this.commandService.executeCommand('workbench.action.openBrowserEditor', {
				url,
				preserveFocus: !options?.fromUserGesture,
			});
			return true;
		} catch {
			// Binary: the interceptor body is wrapped in try/catch and any
			// failure falls through to the default handling.
			return false;
		}
	}

	/**
	 * The binary's `urlOpenToastService.showUrlOpenToast` (desk @20961744),
	 * verbatim: an Info notification "Opening {0} in Cursor Browser"
	 * (nls 12224) whose primary action "Don't Open" (nls 12225, id
	 * `urlOpenToast.dontOpen`) disables the setting, with a platform
	 * never-show-again option (id `urlOpenToast.neverShowAgainv1`,
	 * APPLICATION scope, primary). Per-origin dedupe lives in
	 * {@link UrlOpenToastTracker}; the never-show-again suppression
	 * itself is the notification service's job, exactly as in the binary
	 * (its service only reads the stored boolean to gate the dedupe).
	 */
	private showUrlOpenToast(url: string): void {
		const neverShowAgain = this.storageService.getBoolean(URL_OPEN_TOAST_NEVER_SHOW_AGAIN_ID, StorageScope.APPLICATION, false);
		if (!this.urlOpenToastTracker.shouldShow(url, neverShowAgain)) {
			return;
		}
		this.notificationService.notify({
			severity: Severity.Info,
			message: localize('urlOpenToast.opening', 'Opening {0} in Cursor Browser', url),
			actions: {
				primary: [toAction({
					id: URL_OPEN_TOAST_DONT_OPEN_ACTION_ID,
					label: localize('urlOpenToast.dontOpen', "Don't Open"),
					run: () => this.configurationService.updateValue(OPEN_LOCAL_LINKS_CONFIG_KEY, false),
				})],
			},
			neverShowAgain: { id: URL_OPEN_TOAST_NEVER_SHOW_AGAIN_ID, scope: NeverShowAgainScope.APPLICATION, isSecondary: false },
		});
	}
}

registerWorkbenchContribution2(OpenLocalLinksOpenerContribution.ID, OpenLocalLinksOpenerContribution, WorkbenchPhase.BlockStartup);
