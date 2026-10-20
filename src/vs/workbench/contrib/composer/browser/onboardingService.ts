/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE (GAPS-148, feature `onboarding-flow`): Cursor's onboarding
// service + onboarding-v2 popup flow, ported at Cursor's own layer
// (workbench core, browser). Binary evidence (Cursor 3.25.9,
// workbench.desktop.main.js; glass carries the identical flow):
// ide-code-mission `docs/rea/work-notes-gaps148.md`.
//
// Binary shape being ported:
// - DI token `R_a=vn("onboardingService")` @32182787; impl class `A5a`,
//   registered Delayed (`un(R_a, A5a, 1)`), ctor creates the context key
//   `gqt="cursor.onboarding.showing"` @16975291 (default false).
// - `maybeOnboard()` @39672320: auto-show on startup unless already
//   rendering / glass / `environmentService.skipOnboarding` / the
//   first-time flag `c9e` (storage key
//   "workbench.contrib.onboarding.browser.gettingStarted.contribution.ts.
//   firsttime" @478307) is not "true"; a shown glass splash suppresses the
//   flow and stores the flag "false".
// - On-start contribution `Fti`, ID
//   "workbench.contrib.onboarding.onStart.cursor" @39677400, whose ctor
//   only calls `maybeOnboard()`.
// - `renderPopupBar()` @39674148: full-screen Solid render into
//   `layoutService.mainContainer` (overlay class `onboarding-v2-overlay`),
//   pages `LGm=["welcome","marketplace","data-sharing"]` @39667049 with
//   validity predicate `x5a` (ported verbatim in common/onboardingFlow.ts).
// - Completion persists: first-time flag "false", layout-eligible flag
//   (`pzk`), `isPostOnboardingFirstLanding=true`, change-popup flag "true"
//   (ported in common/onboardingFlow.ts `completeOnboardingStorageEffects`).
//
// HONEST-DIVERGENCES (fork has no analog; nothing below is faked):
// D1. Auth: Cursor's welcome screen calls `cursorAuthenticationService`
//     (login/signup OAuth to cursor.com, login-link clipboard menu,
//     auto-continue on login, welcome skipped when authenticated). The
//     fork has no Cursor account service; locally `isAuthenticated` is
//     always false (so the welcome page is always valid, exactly per
//     `x5a`), and Log In / Sign Up open the fork's real accounts surface
//     (`workbench.action.manageAccounts`). The copy-link context menu,
//     the login-changed auto-continue listener, and the welcome screen's
//     `showLoginWarning` block (content not dissected — UNKNOWN) are not
//     ported. `submitNewOnboarding()` (server call in the data-sharing
//     continue handlers) and `acknowledgeGracePeriodDisclaimer()` (server
//     call in the "new" variant) are no-ops locally.
// D2. Privacy persistence: the binary writes `noStorageMode` /
//     `selectedPrivacyForOnboarding` / `onboardingDataPrivacyVersion` to
//     its reactive storage service. The fork has no reactive storage; the
//     same field names are persisted as plain APPLICATION-scope storage
//     keys. No local consumer gates data collection on them (the fork is
//     local-first; Cursor's flags gate Cursor-cloud collection).
// D3. Data-privacy variant config: the binary fetches the variant from
//     `onboardingConfigService` (server config "dataPrivacyOnboarding",
//     2→new / 3→new2 / else legacy). The fork has no config backend, so
//     the config value is always undefined → "legacy" unless a variant
//     was previously cached in storage (cache path is verbatim).
//     Membership is never ENTERPRISE locally, so the enterprise branches
//     (locked cards, admin copy) never activate; the non-enterprise copy
//     is rendered verbatim.
// D4. Glass/unified layout: `maybeOnboard`'s `isGlass` guard, the
//     `Vrw()` mount side effect (unifiedAppLayout=Agent +
//     enableUnificationMode + unified sidebar right), the unifiedsidebar
//     part toggling, and the `newUserData.toolUsageCount` /
//     `haveNotImportedFromVSC` reactive resets have no fork analog and
//     are skipped. The fork is a single desktop workbench, so the desktop
//     (desk bundle) path is the one ported.
// D5. Window modal sizing: the binary resizes the window to 1000×800 via
//     the native host (`prepareWindowForModal`) and restores 1150×701 on
//     dispose. Those host calls live in the electron-browser host service
//     which browser-layer contrib code does not inject in this fork; the
//     overlay covers the workbench without resizing the window. The
//     verbatim sizes are kept as constants in common/onboardingFlow.ts.
// D6. `cursorai.action.hideNotificationsForMs` (600_000 ms on show,
//     30_000 ms on completion) is a separate command the fork does not
//     have; the executions are attempted and failures ignored, exactly so
//     the flow works whether or not that command lands later. The
//     logged-out blocking gate (`logged-out-glass-screen`) is a glass
//     surface, not part of this desktop flow.
// D7. Marketplace: the plugin catalog is fetched from Cursor's
//     marketplace backend. The fork renders the screen (header, grid
//     container, caption + marketplace link, footer) with an empty
//     catalog — no plugin entries are invented. The binary's
//     `onboarding.marketplace.fetch_failed` event is NOT fired locally
//     (no fetch happens to fail).
// D9. DI token name: binary `vn("onboardingService")`; the fork registers
//     'cursorOnboardingService' because upstream's welcomeOnboarding
//     contrib already owns the 'onboardingService' decorator id in this
//     fork (see the note at the decorator below).
// D8. Rendering tech: the binary uses Solid.js with Tailwind utilities;
//     the fork renders plain DOM with the same class names
//     (media/onboarding.css). The welcome header's Cursor-logo decoration
//     (an SVG component in the binary) is omitted; title/subtitle copy
//     is verbatim. The on-start contribution registers at
//     LifecyclePhase.Restored (the fork has no BlockRestore phase; the
//     binary registers `hs.BlockRestore`).

import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { joinPath } from '../../../../base/common/resources.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IContextKeyService, IContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { IPaneCompositePartService } from '../../../services/panecomposite/browser/panecomposite.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { ViewContainerLocation } from '../../../common/views.js';
import { VIEWLET_ID as EXPLORER_VIEWLET_ID } from '../../files/common/files.js';
import {
	DataPrivacyOnboardingVariant,
	GLASS_FIRST_LAUNCH_SPLASH_SHOWN_KEY,
	HIDE_NOTIFICATIONS_COMMAND_ID,
	HIDE_NOTIFICATIONS_ON_COMPLETE_MS,
	HIDE_NOTIFICATIONS_ON_SHOW_MS,
	IOnboardingStorage,
	NO_STORAGE_MODE_KEY,
	ONBOARDING_ANALYTICS,
	ONBOARDING_COPY,
	ONBOARDING_DATA_PRIVACY_VERSION_FIELD,
	ONBOARDING_DATA_PRIVACY_VERSION_KEY,
	ONBOARDING_FIRST_TIME_KEY,
	ONBOARDING_ON_START_CONTRIBUTION_ID,
	ONBOARDING_PAGES,
	ONBOARDING_SHOWING_CONTEXT_KEY,
	ONBOARDING_TELEMETRY,
	OnboardingPageId,
	SELECTED_PRIVACY_FOR_ONBOARDING_KEY,
	adjacentOnboardingPage,
	completeOnboardingStorageEffects,
	dataSharingChoiceName,
	hasVscodeFromChildCount,
	isLastOnboardingPage,
	markOnboardingSuppressedBySplash,
	maybeOnboardDecision,
	modelProviderSuffixApplies,
	parseGlassSplashShown,
	resolveDataPrivacyVariant,
	visibleOnboardingPages,
	withModelProviderSuffix,
} from '../common/onboardingFlow.js';
import './media/onboarding.css';

/**
 * Binary DI token: `R_a=vn("onboardingService")` @32182787.
 * FORK-FORCED DIVERGENCE (D9): the fork still ships upstream's
 * welcomeOnboarding contrib, whose own `IOnboardingService` already owns
 * the decorator id 'onboardingService' (a different service: an A/B
 * welcome modal with `show()`). `createDecorator` caches by id string, so
 * reusing 'onboardingService' would alias the two services and break
 * both. Cursor could use the plain name because it deleted the stock
 * contrib. Following the fork's composer precedent for stock-colliding
 * names (`composerDataService`, `composerAddToChatService`, …), the
 * decorator id here is 'cursorOnboardingService'.
 */
export const IOnboardingService = createDecorator<IOnboardingService>('cursorOnboardingService');

export interface IOnboardingService {
	readonly _serviceBrand: undefined;
	/** Whether the onboarding overlay is currently rendered. */
	readonly isShowing: boolean;
	/** Binary `setOnboardingShowing(bool)` — drives `cursor.onboarding.showing`. */
	setOnboardingShowing(showing: boolean): void;
	/** Binary `maybeOnboard()` — startup auto-show decision. */
	maybeOnboard(): void;
	/** Binary `renderPopupBar()` — render the flow (no-op if showing). */
	renderPopupBar(): void;
}

export class OnboardingService extends Disposable implements IOnboardingService {

	declare readonly _serviceBrand: undefined;

	private readonly _onboardingShowingContextKey: IContextKey<boolean>;
	private _overlay: HTMLElement | undefined;
	private _hideSidebarStyle: HTMLStyleElement | undefined;
	private _startedAt = 0;
	private _stepsCompleted = 0;
	private _completed = false;
	private _currentPage: OnboardingPageId = 'welcome';
	private _visiblePages: OnboardingPageId[] = [...ONBOARDING_PAGES];
	private _hasVscode = false;
	/** Local auth state: the fork has no Cursor account service (D1). */
	private readonly _isAuthenticated = false;
	/** The fork has no privacy-ack flag service; undefined per `x5a`. */
	private readonly _privacyAckMode: string | undefined = undefined;
	/** The fork has no partner data-share program (D1/D3). */
	private readonly _partnerDataShare = false;

	private readonly _storage: IOnboardingStorage;

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
		@ICommandService private readonly commandService: ICommandService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@IFileService private readonly fileService: IFileService,
		@IPathService private readonly pathService: IPathService,
		@IPaneCompositePartService private readonly paneCompositePartService: IPaneCompositePartService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IOpenerService private readonly openerService: IOpenerService,
	) {
		super();
		this._onboardingShowingContextKey = contextKeyService.createKey<boolean>(ONBOARDING_SHOWING_CONTEXT_KEY, false);
		this._storage = {
			get: (key, scope, fallbackValue) => this.storageService.get(key, scope as StorageScope, fallbackValue),
			store: (key, value, scope, target) => { this.storageService.store(key, value, scope as StorageScope, target as StorageTarget); },
		};
	}

	get isShowing(): boolean {
		return this._overlay !== undefined;
	}

	setOnboardingShowing(showing: boolean): void {
		this._onboardingShowingContextKey.set(showing);
	}

	maybeOnboard(): void {
		const decision = maybeOnboardDecision({
			alreadyRendering: this.isShowing,
			isGlass: false, // D4: single desktop workbench — desk-bundle path.
			skipOnboarding: this.environmentService.skipOnboarding,
			firstTimeValue: this.storageService.get(ONBOARDING_FIRST_TIME_KEY, StorageScope.APPLICATION, 'true'),
			glassSplashShown: parseGlassSplashShown(this.storageService.get(GLASS_FIRST_LAUNCH_SPLASH_SHOWN_KEY, StorageScope.APPLICATION)),
		});
		if (decision === 'suppress-by-splash') {
			markOnboardingSuppressedBySplash(this._storage);
			return;
		}
		if (decision === 'show') {
			this.renderPopupBar();
		}
	}

	renderPopupBar(): void {
		if (this._overlay) {
			return; // binary: `this._solidRenderDisposable.value || (...)`
		}
		this.setOnboardingShowing(true);
		this._startedAt = Date.now();
		this._stepsCompleted = 0;
		this._completed = false;

		// Binary: hide the sidebar + inject the hide-sidebar style.
		if (this.layoutService.isVisible(Parts.SIDEBAR_PART)) {
			this.layoutService.setPartHidden(true, Parts.SIDEBAR_PART);
		}
		const style = document.createElement('style');
		style.id = 'hide-sidebar-during-onboarding';
		style.textContent = '.part.sidebar { display: none !important; } .monaco-workbench .part.sidebar { display: none !important; }';
		document.head.appendChild(style);
		this._hideSidebarStyle = style;

		// Binary: hide notifications for 10 minutes (D6 — command may not exist).
		void this.commandService.executeCommand(HIDE_NOTIFICATIONS_COMMAND_ID, HIDE_NOTIFICATIONS_ON_SHOW_MS).then(undefined, () => undefined);

		// Binary: resolve the data-privacy variant (cached wins; otherwise
		// the server config, which the fork does not have → legacy, D3).
		const { variant, fromCache } = resolveDataPrivacyVariant(
			this.storageService.get(ONBOARDING_DATA_PRIVACY_VERSION_KEY, StorageScope.APPLICATION),
			undefined,
		);
		if (!fromCache) {
			this.storageService.store(ONBOARDING_DATA_PRIVACY_VERSION_KEY, variant, StorageScope.APPLICATION, StorageTarget.MACHINE);
			this.storageService.store(ONBOARDING_DATA_PRIVACY_VERSION_FIELD, variant, StorageScope.APPLICATION, StorageTarget.USER);
		}

		this._visiblePages = visibleOnboardingPages(this._isAuthenticated, this._privacyAckMode);
		this._currentPage = this._visiblePages[0] ?? 'welcome';

		const overlay = document.createElement('div');
		this._overlay = overlay;
		this.layoutService.mainContainer.appendChild(overlay);

		// Binary: `onboarding.started` fires once the hasVscode check (EGm)
		// resolves; the flow renders its chrome immediately with a loading
		// state until then.
		void this._detectHasVscode().then(hasVscode => {
			this._hasVscode = hasVscode;
			if (this._overlay !== overlay) {
				return;
			}
			this._track(ONBOARDING_ANALYTICS.started, { has_vscode: hasVscode, is_authenticated: this._isAuthenticated });
			this._renderCurrentPage(variant);
		});
		this._renderChrome(overlay, variant, true);
	}

	override dispose(): void {
		if (this._overlay && !this._completed) {
			this._trackAborted();
		}
		this._teardownOverlay();
		this.setOnboardingShowing(false);
		super.dispose();
	}

	// -- internals -----------------------------------------------------------

	private _track(eventName: string, data?: Record<string, unknown>): void {
		// Binary: `analyticsService.trackEvent(name, data)`. Fork precedent
		// (composerActions.ts, `composer.export_chat`): ITelemetryService.publicLog.
		this.telemetryService.publicLog(eventName, data);
	}

	private async _detectHasVscode(): Promise<boolean> {
		// `EGm(fileService, env)` @39634436: ~/.vscode exists with children.
		try {
			const userHome = await this.pathService.userHome();
			const stat = await this.fileService.resolve(joinPath(userHome, '.vscode'));
			return hasVscodeFromChildCount(stat.children?.length);
		} catch {
			return false;
		}
	}

	private _renderChrome(overlay: HTMLElement, variant: DataPrivacyOnboardingVariant, loading: boolean): void {
		overlay.className = 'onboarding-v2-overlay';
		overlay.replaceChildren();

		const navBar = document.createElement('div');
		navBar.className = 'onboarding-v2-nav-bar';

		const back = document.createElement('button');
		back.className = 'onboarding-v2-nav-button';
		back.disabled = adjacentOnboardingPage(this._visiblePages, this._currentPage, -1) === undefined;
		const backIcon = document.createElement('span');
		backIcon.className = `codicon ${Codicon.arrowUp.id}`;
		backIcon.style.transform = 'rotate(-90deg)';
		back.appendChild(backIcon);
		back.addEventListener('click', () => this._navigateBack());

		const forward = document.createElement('button');
		forward.className = 'onboarding-v2-nav-button';
		forward.disabled = adjacentOnboardingPage(this._visiblePages, this._currentPage, 1) === undefined;
		const forwardIcon = document.createElement('span');
		forwardIcon.className = `codicon ${Codicon.arrowUp.id}`;
		forwardIcon.style.transform = 'rotate(90deg)';
		forward.appendChild(forwardIcon);
		forward.addEventListener('click', () => this._navigateForward(variant));

		navBar.append(back, forward);
		overlay.appendChild(navBar);

		const scroll = document.createElement('div');
		scroll.className = 'onboarding-v2-scroll';
		overlay.appendChild(scroll);

		if (loading) {
			const container = document.createElement('div');
			container.className = 'onboarding-v2-container';
			const spinner = document.createElement('div');
			spinner.className = 'onboarding-v2-spinner';
			const loadingText = document.createElement('span');
			loadingText.textContent = ONBOARDING_COPY.loading;
			container.append(spinner, loadingText);
			scroll.appendChild(container);
			return;
		}

		const page = this._currentPage === 'welcome'
			? this._renderWelcome()
			: this._currentPage === 'marketplace'
				? this._renderMarketplace(variant)
				: this._renderDataSharing(variant);
		scroll.appendChild(page);
	}

	private _renderCurrentPage(variant: DataPrivacyOnboardingVariant): void {
		if (this._overlay) {
			this._renderChrome(this._overlay, variant, false);
		}
	}

	private _variantForRender(): DataPrivacyOnboardingVariant {
		const cached = this.storageService.get(ONBOARDING_DATA_PRIVACY_VERSION_KEY, StorageScope.APPLICATION);
		return resolveDataPrivacyVariant(cached, undefined).variant;
	}

	private _navigateBack(): void {
		const from = this._currentPage;
		const prev = adjacentOnboardingPage(this._visiblePages, from, -1);
		if (!prev) {
			return;
		}
		this._currentPage = prev;
		if (from !== prev) {
			this._track(ONBOARDING_ANALYTICS.backClicked, { from_step: from, to_step: prev });
		}
		this._renderCurrentPage(this._variantForRender());
	}

	private _navigateForward(variant: DataPrivacyOnboardingVariant): void {
		const next = adjacentOnboardingPage(this._visiblePages, this._currentPage, 1);
		if (!next) {
			return;
		}
		this._currentPage = next;
		this._renderCurrentPage(variant);
	}

	/** Binary `G()`: count the step; last page completes, else forward. */
	private _onContinue(variant: DataPrivacyOnboardingVariant): void {
		this._stepsCompleted++;
		if (isLastOnboardingPage(this._visiblePages, this._currentPage)) {
			this._finish();
			return;
		}
		this._navigateForward(variant);
	}

	/**
	 * Binary `B()` @39669277: track `onboarding.completed`, then await
	 * `aboutToDispose()` (layout restore), then enable the fade
	 * (opacity-0), then `setTimeout(doDispose, E5a=200)` — doDispose is
	 * only the storage effects + hideNotifications 30_000 below.
	 * NF-3 (QA-156): the layout restore runs BEFORE the fade here; the
	 * overlay element itself is removed inside the timeout, so the fade
	 * still renders on a live element.
	 */
	private _finish(): void {
		if (this._completed) {
			return;
		}
		this._completed = true;
		this._track(ONBOARDING_ANALYTICS.completed, {
			duration_ms: Date.now() - this._startedAt,
			steps_completed: this._stepsCompleted,
		});
		this._restoreLayout();
		const overlay = this._overlay;
		if (overlay) {
			overlay.style.transition = 'opacity 0.2s ease-out';
			overlay.style.opacity = '0';
		}
		setTimeout(() => {
			this._teardownOverlay();
			this.setOnboardingShowing(false);
			completeOnboardingStorageEffects(this._storage);
			void this.commandService.executeCommand(HIDE_NOTIFICATIONS_COMMAND_ID, HIDE_NOTIFICATIONS_ON_COMPLETE_MS).then(undefined, () => undefined);
		}, 200);
	}

	private _trackAborted(): void {
		this._track(ONBOARDING_ANALYTICS.aborted, {
			last_step: this._currentPage,
			duration_ms: Date.now() - this._startedAt,
		});
	}

	/**
	 * The layout-restore half of the binary `aboutToDispose()` @39676108
	 * (minus the window restore, D5): drop the hide-sidebar style and put
	 * the workbench parts back. Idempotent: `_finish()` runs it before
	 * the fade (NF-3, mirroring the binary order) and `_teardownOverlay()`
	 * runs it again when the overlay is disposed.
	 */
	private _restoreLayout(): void {
		if (this._hideSidebarStyle) {
			this._hideSidebarStyle.remove();
			this._hideSidebarStyle = undefined;
		}
		this.layoutService.setPartHidden(false, Parts.EDITOR_PART);
		this.layoutService.setPartHidden(true, Parts.PANEL_PART);
		void this.paneCompositePartService.openPaneComposite(EXPLORER_VIEWLET_ID, ViewContainerLocation.Sidebar, false);
		const emptyWorkspace = this.workspaceContextService.getWorkbenchState() === WorkbenchState.EMPTY;
		this.layoutService.setPartHidden(emptyWorkspace, Parts.SIDEBAR_PART);
		this.layoutService.setPartHidden(true, Parts.AUXILIARYBAR_PART);
	}

	/** Binary `aboutToDispose()` + DOM dispose: restore layout, drop the overlay element. */
	private _teardownOverlay(): void {
		this._restoreLayout();
		if (this._overlay) {
			this._overlay.remove();
			this._overlay = undefined;
		}
	}

	// -- welcome screen (jrw/Grw) ---------------------------------------------

	private _renderWelcome(): HTMLElement {
		this._track(ONBOARDING_ANALYTICS.welcomeViewed, { is_authenticated: this._isAuthenticated, has_vscode: this._hasVscode });
		const container = document.createElement('div');
		container.className = 'onboarding-v2-container no-min-height';

		const header = document.createElement('div');
		header.className = 'onboarding-v2-welcome-header';
		const headerContent = document.createElement('div');
		headerContent.className = 'onboarding-v2-welcome-header-content';
		const title = document.createElement('span');
		title.className = 'onboarding-v2-welcome-title';
		title.textContent = ONBOARDING_COPY.welcomeTitle;
		const br = document.createElement('br');
		const subtitle = document.createElement('span');
		subtitle.className = 'onboarding-v2-welcome-subtitle';
		subtitle.textContent = ONBOARDING_COPY.welcomeSubtitle;
		headerContent.append(title, br, subtitle);
		header.appendChild(headerContent);
		container.appendChild(header);

		const buttons = document.createElement('div');
		buttons.className = 'onboarding-v2-welcome-buttons';

		const logIn = document.createElement('button');
		logIn.className = 'onboarding-v2-welcome-button';
		logIn.textContent = ONBOARDING_COPY.logIn;
		logIn.addEventListener('click', () => {
			this._track(ONBOARDING_ANALYTICS.welcomeLoginClicked, { is_authenticated: this._isAuthenticated });
			if (this._isAuthenticated) {
				this._continueFromWelcome();
			} else {
				// D1: binary calls cursorAuthenticationService.login(); the
				// fork's account surface is Manage Accounts.
				void this.commandService.executeCommand('workbench.action.manageAccounts');
			}
		});

		const signUp = document.createElement('button');
		signUp.className = 'onboarding-v2-welcome-button secondary';
		signUp.textContent = ONBOARDING_COPY.signUp;
		signUp.addEventListener('click', () => {
			this._track(ONBOARDING_ANALYTICS.welcomeSignupClicked, { is_authenticated: this._isAuthenticated });
			if (this._isAuthenticated) {
				this._continueFromWelcome();
			} else {
				void this.commandService.executeCommand('workbench.action.manageAccounts');
			}
		});

		buttons.append(logIn, signUp);
		container.appendChild(buttons);
		return container;
	}

	private _continueFromWelcome(): void {
		this._track(ONBOARDING_ANALYTICS.welcomeContinueClicked, { is_authenticated: this._isAuthenticated });
		this._onContinue(this._variantForRender());
	}

	// -- marketplace screen (Brw) ----------------------------------------------

	private _renderMarketplace(variant: DataPrivacyOnboardingVariant): HTMLElement {
		this._track(ONBOARDING_ANALYTICS.marketplaceViewed, {});
		const container = document.createElement('div');
		container.className = 'onboarding-v2-container';

		const header = document.createElement('div');
		header.className = 'onboarding-v2-welcome-header';
		const title = document.createElement('span');
		title.className = 'onboarding-v2-welcome-title';
		title.textContent = ONBOARDING_COPY.marketplaceTitle;
		header.appendChild(title);
		container.appendChild(header);

		// D7: no marketplace backend locally — the grid renders empty
		// (the binary renders the same grid + caption once its fetch
		// settles; no entries are invented here).
		const grid = document.createElement('div');
		grid.className = 'onboarding-v2-marketplace-grid';
		container.appendChild(grid);

		const caption = document.createElement('div');
		caption.className = 'onboarding-v2-caption';
		caption.textContent = ONBOARDING_COPY.marketplaceCaptionBeforeLink;
		const link = document.createElement('span');
		link.textContent = ONBOARDING_COPY.marketplaceLinkText;
		link.style.textDecoration = 'underline';
		link.style.cursor = 'pointer';
		link.addEventListener('click', () => {
			this._track(ONBOARDING_ANALYTICS.marketplaceLinkClicked, {});
			void this.openerService.open(URI.parse(ONBOARDING_COPY.marketplaceUrl), { openExternal: true });
		});
		caption.appendChild(link);
		container.appendChild(caption);

		const isLast = isLastOnboardingPage(this._visiblePages, 'marketplace');
		const footer = document.createElement('div');
		footer.className = 'onboarding-v2-footer';
		const primary = document.createElement('button');
		primary.className = 'onboarding-v2-welcome-button';
		// NF-2 (QA-156): binary Brw uses "Start Building" (not "Finish")
		// when the marketplace screen is the last screen — reachable when
		// data-sharing is invalidated by x5a (privacyAckMode "off").
		primary.textContent = isLast ? ONBOARDING_COPY.startBuilding : ONBOARDING_COPY.continue;
		primary.addEventListener('click', () => {
			this._track(ONBOARDING_ANALYTICS.marketplaceContinueClicked, {});
			this._onContinue(variant);
		});
		footer.appendChild(primary);
		if (!isLast) {
			const skip = document.createElement('button');
			skip.className = 'onboarding-v2-welcome-button text';
			skip.textContent = ONBOARDING_COPY.skip;
			skip.addEventListener('click', () => {
				this._track(ONBOARDING_ANALYTICS.marketplaceSkipClicked, {});
				this._onContinue(variant);
			});
			footer.appendChild(skip);
		}
		container.appendChild(footer);
		return container;
	}

	// -- data-sharing screens ----------------------------------------------------

	private _renderDataSharing(variant: DataPrivacyOnboardingVariant): HTMLElement {
		switch (variant) {
			case 'new': return this._renderDataSharingNew();
			case 'new2': return this._renderDataSharingNew2();
			default: return this._renderDataSharingLegacy();
		}
	}

	private _dataSharingHeader(subtitleText: string): HTMLElement {
		const header = document.createElement('div');
		header.className = 'onboarding-v2-welcome-header';
		const title = document.createElement('span');
		title.className = 'onboarding-v2-welcome-title';
		title.textContent = ONBOARDING_COPY.dataSharingTitle;
		const br = document.createElement('br');
		const subtitle = document.createElement('span');
		subtitle.className = 'onboarding-v2-welcome-subtitle';
		subtitle.textContent = subtitleText;
		header.append(title, br, subtitle);
		return header;
	}

	private _learnMoreButton(variant: DataPrivacyOnboardingVariant): HTMLButtonElement {
		const button = document.createElement('button');
		button.className = 'onboarding-v2-welcome-button text';
		button.textContent = ONBOARDING_COPY.learnMore;
		button.addEventListener('click', () => {
			this._track(ONBOARDING_ANALYTICS.dataSharingPrivacyPolicyClicked, { variant });
			void this.openerService.open(URI.parse(ONBOARDING_COPY.privacyPolicyUrl), { openExternal: true });
		});
		return button;
	}

	private _choiceCard(options: {
		readonly styleClass: 'legacy' | 'new2';
		readonly title: string;
		readonly subtitle?: string;
		readonly description: string;
		readonly recommended?: boolean;
		readonly selected: boolean;
		readonly disabled: boolean;
		readonly onSelect: () => void;
	}): HTMLElement {
		const card = document.createElement('div');
		card.className = `onboarding-v2-choice-card ${options.styleClass}${options.selected ? ' selected' : ''}${options.disabled ? ' disabled' : ''}`;
		const title = document.createElement('div');
		title.className = 'card-title';
		title.textContent = options.title;
		card.appendChild(title);
		if (options.subtitle) {
			const subtitle = document.createElement('div');
			subtitle.className = 'card-subtitle';
			subtitle.textContent = options.subtitle;
			card.appendChild(subtitle);
		}
		const description = document.createElement('div');
		description.className = 'card-description';
		description.textContent = options.description;
		card.appendChild(description);
		if (options.recommended) {
			const recommended = document.createElement('div');
			recommended.className = 'card-recommended';
			recommended.textContent = ONBOARDING_COPY.recommended;
			card.appendChild(recommended);
		}
		if (!options.disabled) {
			card.addEventListener('click', options.onSelect);
		}
		return card;
	}

	/** Legacy variant (Irw @39654720). */
	private _renderDataSharingLegacy(): HTMLElement {
		const variant: DataPrivacyOnboardingVariant = 'legacy';
		this._track(ONBOARDING_ANALYTICS.dataSharingViewed, { is_authenticated: this._isAuthenticated, has_vscode: this._hasVscode, variant });
		const container = document.createElement('div');
		container.className = 'onboarding-v2-container';
		container.appendChild(this._dataSharingHeader(ONBOARDING_COPY.legacySubtitle));

		const stored = this.storageService.get(NO_STORAGE_MODE_KEY, StorageScope.APPLICATION);
		let privacy: boolean | undefined = stored === undefined ? undefined : stored === 'true';
		const suffixApplies = modelProviderSuffixApplies(this._isAuthenticated, this._partnerDataShare);

		const row = document.createElement('div');
		row.className = 'onboarding-v2-card-row';
		const renderCards = (): void => {
			row.replaceChildren(
				this._choiceCard({
					styleClass: 'legacy',
					title: ONBOARDING_COPY.helpImproveTitle,
					description: withModelProviderSuffix(ONBOARDING_COPY.legacyAcceptDescription, suffixApplies),
					recommended: true,
					selected: !privacy,
					disabled: false,
					onSelect: () => { select(false); },
				}),
				this._choiceCard({
					styleClass: 'legacy',
					title: ONBOARDING_COPY.privacyModeTitle,
					description: ONBOARDING_COPY.legacyPrivacyDescription,
					selected: !!privacy,
					disabled: false,
					onSelect: () => { select(true); },
				}),
			);
		};
		const select = (value: boolean): void => {
			privacy = value;
			// Binary `s(l)`: choice analytics + reactive noStorageMode write.
			this._track(ONBOARDING_ANALYTICS.dataSharingChoiceMade, { choice: dataSharingChoiceName(value), variant });
			this.storageService.store(NO_STORAGE_MODE_KEY, String(value), StorageScope.APPLICATION, StorageTarget.USER);
			renderCards();
		};
		renderCards();
		container.appendChild(row);

		const footer = document.createElement('div');
		footer.className = 'onboarding-v2-footer';
		const primary = document.createElement('button');
		primary.className = 'onboarding-v2-welcome-button';
		primary.textContent = isLastOnboardingPage(this._visiblePages, 'data-sharing') ? ONBOARDING_COPY.finish : ONBOARDING_COPY.continue;
		primary.addEventListener('click', () => {
			this._track(ONBOARDING_ANALYTICS.dataSharingContinueClicked, { variant });
			try {
				if (privacy === undefined) {
					select(false); // binary: default accept when unset
				}
				if (privacy) {
					this.telemetryService.publicLog(ONBOARDING_TELEMETRY.privacyEnabled);
					this.storageService.store(SELECTED_PRIVACY_FOR_ONBOARDING_KEY, 'true', StorageScope.APPLICATION, StorageTarget.USER);
				} else {
					this.telemetryService.publicLog(ONBOARDING_TELEMETRY.privacyDisabled);
					this.storageService.store(SELECTED_PRIVACY_FOR_ONBOARDING_KEY, 'false', StorageScope.APPLICATION, StorageTarget.USER);
				}
			} catch {
				// Binary wraps this block in try/catch with console.error.
			}
			this._onContinue(variant);
		});
		footer.append(primary, this._learnMoreButton(variant));
		container.appendChild(footer);
		return container;
	}

	/** New2 variant (krw @39649804). */
	private _renderDataSharingNew2(): HTMLElement {
		const variant: DataPrivacyOnboardingVariant = 'new2';
		this._track(ONBOARDING_ANALYTICS.dataSharingViewed, { is_authenticated: this._isAuthenticated, has_vscode: this._hasVscode, variant });
		const container = document.createElement('div');
		container.className = 'onboarding-v2-container';
		container.appendChild(this._dataSharingHeader(ONBOARDING_COPY.new2Subtitle));

		let choice: boolean | undefined = undefined; // true = Privacy Mode
		const suffixApplies = modelProviderSuffixApplies(this._isAuthenticated, this._partnerDataShare);

		const row = document.createElement('div');
		row.className = 'onboarding-v2-card-row';
		const primary = document.createElement('button');
		primary.className = 'onboarding-v2-welcome-button';
		primary.textContent = isLastOnboardingPage(this._visiblePages, 'data-sharing') ? ONBOARDING_COPY.finish : ONBOARDING_COPY.continue;

		const renderCards = (): void => {
			row.replaceChildren(
				this._choiceCard({
					styleClass: 'new2',
					title: ONBOARDING_COPY.helpImproveTitle,
					subtitle: ONBOARDING_COPY.new2AcceptSubtitle,
					description: withModelProviderSuffix(ONBOARDING_COPY.new2AcceptDescription, suffixApplies),
					selected: choice === false,
					disabled: false,
					onSelect: () => { select(false); },
				}),
				this._choiceCard({
					styleClass: 'new2',
					title: ONBOARDING_COPY.privacyModeTitle,
					subtitle: ONBOARDING_COPY.new2PrivacySubtitle,
					description: ONBOARDING_COPY.new2PrivacyDescription,
					selected: choice === true,
					disabled: false,
					onSelect: () => { select(true); },
				}),
			);
			primary.disabled = choice === undefined;
		};
		const select = (value: boolean): void => {
			choice = value;
			this._track(ONBOARDING_ANALYTICS.dataSharingChoiceMade, { choice: dataSharingChoiceName(value), variant });
			renderCards();
		};
		renderCards();
		container.appendChild(row);

		const caption = document.createElement('div');
		caption.className = 'onboarding-v2-caption';
		caption.textContent = ONBOARDING_COPY.modifySettingsCaption;
		container.appendChild(caption);

		const footer = document.createElement('div');
		footer.className = 'onboarding-v2-footer';
		primary.addEventListener('click', () => {
			this._track(ONBOARDING_ANALYTICS.dataSharingContinueClicked, { variant });
			if (choice !== undefined) {
				if (choice === true) {
					this.storageService.store(NO_STORAGE_MODE_KEY, 'true', StorageScope.APPLICATION, StorageTarget.USER);
					this.storageService.store(SELECTED_PRIVACY_FOR_ONBOARDING_KEY, 'true', StorageScope.APPLICATION, StorageTarget.USER);
				} else {
					this.storageService.store(SELECTED_PRIVACY_FOR_ONBOARDING_KEY, 'false', StorageScope.APPLICATION, StorageTarget.USER);
				}
				// Binary: cursorAuthenticationService.submitNewOnboarding() — D1 no-op.
				this.telemetryService.publicLog(ONBOARDING_TELEMETRY.privacyNewAccepted);
			}
			this._onContinue(variant);
		});
		footer.append(primary, this._learnMoreButton(variant));
		container.appendChild(footer);
		return container;
	}

	/** New variant (MGm @39643762) — checkbox acknowledgement. */
	private _renderDataSharingNew(): HTMLElement {
		const variant: DataPrivacyOnboardingVariant = 'new';
		this._track(ONBOARDING_ANALYTICS.dataSharingViewed, { is_authenticated: this._isAuthenticated, has_vscode: this._hasVscode, variant });
		const container = document.createElement('div');
		container.className = 'onboarding-v2-container';
		container.appendChild(this._dataSharingHeader(ONBOARDING_COPY.newSubtitle));

		const suffixApplies = modelProviderSuffixApplies(this._isAuthenticated, this._partnerDataShare);
		const box = document.createElement('div');
		box.className = 'onboarding-v2-privacy-box';

		const intro = document.createElement('div');
		intro.className = 'privacy-intro';
		intro.textContent = ONBOARDING_COPY.newIntro;
		box.appendChild(intro);

		const list = document.createElement('ul');
		const bullet1 = document.createElement('li');
		const bullet1Lead = document.createElement('b');
		bullet1Lead.textContent = ONBOARDING_COPY.newBullet1Lead;
		bullet1.append(bullet1Lead, document.createTextNode(ONBOARDING_COPY.newBullet1));
		const bullet2 = document.createElement('li');
		const bullet2Lead = document.createElement('b');
		bullet2Lead.textContent = ONBOARDING_COPY.newBullet2Lead;
		bullet2.append(bullet2Lead, document.createTextNode(withModelProviderSuffix(ONBOARDING_COPY.newBullet2, suffixApplies)));
		list.append(bullet1, bullet2);
		box.appendChild(list);

		const more = document.createElement('div');
		more.style.marginTop = '16px';
		more.style.opacity = '0.6';
		more.append(document.createTextNode(ONBOARDING_COPY.newMoreOn));
		const privacyLink = document.createElement('a');
		privacyLink.href = ONBOARDING_COPY.privacyPolicyUrlWww;
		privacyLink.target = '_blank';
		privacyLink.rel = 'noopener noreferrer';
		privacyLink.textContent = ONBOARDING_COPY.newPrivacyPolicy;
		privacyLink.addEventListener('click', () => {
			this._track(ONBOARDING_ANALYTICS.dataSharingPrivacyPolicyClicked, { variant });
		});
		const securityLink = document.createElement('a');
		securityLink.href = ONBOARDING_COPY.securityUrl;
		securityLink.target = '_blank';
		securityLink.rel = 'noopener noreferrer';
		securityLink.textContent = ONBOARDING_COPY.newSecurity;
		securityLink.addEventListener('click', () => {
			this._track(ONBOARDING_ANALYTICS.dataSharingSecurityClicked, { variant });
		});
		more.append(privacyLink, document.createTextNode(ONBOARDING_COPY.newAnd), securityLink);
		box.appendChild(more);
		container.appendChild(box);

		let checked = false;
		const checkboxRow = document.createElement('div');
		checkboxRow.className = 'onboarding-v2-checkbox-row';
		const checkbox = document.createElement('input');
		checkbox.type = 'checkbox';
		checkbox.id = 'understand-checkbox';
		const label = document.createElement('label');
		label.htmlFor = 'understand-checkbox';
		label.textContent = ONBOARDING_COPY.newCheckboxLabel;
		checkboxRow.append(checkbox, label);
		container.appendChild(checkboxRow);

		const footer = document.createElement('div');
		footer.className = 'onboarding-v2-footer';
		const primary = document.createElement('button');
		primary.className = 'onboarding-v2-welcome-button';
		primary.textContent = ONBOARDING_COPY.continue;
		primary.disabled = true;
		checkbox.addEventListener('change', () => {
			checked = checkbox.checked;
			if (checked) {
				this._track(ONBOARDING_ANALYTICS.dataSharingChoiceMade, { choice: 'accept', variant });
			}
			primary.disabled = !checked;
		});
		primary.addEventListener('click', () => {
			if (!checked) {
				// Binary handler throws this verbatim error when the
				// checkbox gate is bypassed.
				throw new Error(ONBOARDING_COPY.mustClickCheckboxError);
			}
			this._track(ONBOARDING_ANALYTICS.dataSharingContinueClicked, { variant });
			// Binary: submitNewOnboarding() +
			// aiClient().acknowledgeGracePeriodDisclaimer({}) — D1 server
			// calls, no local analog.
			this.telemetryService.publicLog(ONBOARDING_TELEMETRY.privacyNewAccepted);
			this._onContinue(variant);
		});
		footer.appendChild(primary);
		container.appendChild(footer);
		return container;
	}
}

/**
 * Binary on-start contribution `Fti` @39677400: constructing it calls
 * `maybeOnboard()` on the onboarding service. Registered from
 * composer.contribution.ts (the fork's Cursor-layer contribution module)
 * at LifecyclePhase.Restored (D8).
 */
export class OnboardingOnStartContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = ONBOARDING_ON_START_CONTRIBUTION_ID;

	constructor(@IOnboardingService onboardingService: IOnboardingService) {
		super();
		onboardingService.maybeOnboard();
	}
}
