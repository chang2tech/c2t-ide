/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE (GAPS-148, feature `onboarding-flow`): pure logic + verbatim copy
// for Cursor's first-run onboarding flow (the "onboarding-v2" popup bar),
// dissected from Cursor 3.25.9 `workbench.desktop.main.js` (glass bundle
// carries the identical flow). Full evidence: ide-code-mission
// `docs/rea/work-notes-gaps148.md`.
//
// Layer note (how Cursor does it): this is NOT the VS Code walkthrough /
// Getting Started API. Cursor registers an Action2 (`cursor.startOnboarding`)
// plus a workbench-core singleton service (`onboardingService`) that renders
// a Solid.js flow into `layoutService.mainContainer` as a full-screen
// overlay. This module holds the dependency-free logic (storage keys,
// startup decision, page validity, variant resolution, copy) so it can be
// unit-tested standalone; the DOM/service half lives in
// `browser/onboardingService.ts`, the command in
// `browser/onboardingActions.ts`.
//
// Pure module: ZERO imports (same convention as common/customModes.ts), so
// the standalone test harness can transpile it without the workbench graph.

// ---------------------------------------------------------------------------
// Command + contribution identity (binary-verbatim)
// ---------------------------------------------------------------------------

/** desk@39640508: `id:"cursor.startOnboarding"` (class Sig, LABEL below). */
export const START_ONBOARDING_COMMAND_ID = 'cursor.startOnboarding';

/** desk@39640515: `Sig.LABEL="Start Onboarding"`, title original verbatim. */
export const START_ONBOARDING_TITLE = 'Start Onboarding';

/** desk@39677400: `Fti.ID="workbench.contrib.onboarding.onStart.cursor"`. */
export const ONBOARDING_ON_START_CONTRIBUTION_ID = 'workbench.contrib.onboarding.onStart.cursor';

// ---------------------------------------------------------------------------
// Storage keys (binary-verbatim) + scope/target numerics
// ---------------------------------------------------------------------------

/**
 * Binary scope/target numerics, identical to this fork's enums
 * (`StorageScope.APPLICATION = -1`, `StorageTarget.USER = 0`,
 * `StorageTarget.MACHINE = 1` in platform/storage/common/storage.ts).
 * The binary passes them as raw numbers (`store(c9e,"true",-1,1)`), and
 * this pure module does the same; the browser service adapts the real
 * `IStorageService` (whose signatures take those enums) onto
 * {@link IOnboardingStorage}.
 */
export const ONBOARDING_STORAGE_SCOPE_APPLICATION = -1;
export const ONBOARDING_STORAGE_TARGET_USER = 0;
export const ONBOARDING_STORAGE_TARGET_MACHINE = 1;

/** `c9e` @478307 — the first-run flag. Missing value defaults to "true". */
export const ONBOARDING_FIRST_TIME_KEY = 'workbench.contrib.onboarding.browser.gettingStarted.contribution.ts.firsttime';

/** `v_n` @478521 — set to "true" when the flow completes. */
export const ONBOARDING_CHANGE_POPUP_SHOWN_KEY = 'workbench.contrib.onboarding.browser.changePopup.03292025.shown';

/** `Tis` @487389 — cached data-privacy onboarding variant. */
export const ONBOARDING_DATA_PRIVACY_VERSION_KEY = 'cursor.featureStatus.dataPrivacyOnboarding';

/** `NGm` @39671400 — config name passed to the onboarding config service. */
export const ONBOARDING_DATA_PRIVACY_CONFIG_NAME = 'dataPrivacyOnboarding';

/** `esw` @39671400 — set by the glass splash; suppresses the desktop flow. */
export const GLASS_FIRST_LAUNCH_SPLASH_SHOWN_KEY = 'cursor/glass.firstLaunchSplashShown';

/** `gqt` @16975291 — context key set while the flow is on screen. */
export const ONBOARDING_SHOWING_CONTEXT_KEY = 'cursor.onboarding.showing';

/**
 * Reactive-storage field @14327277 (`Jh(!1,-1,0)`: default false, scope
 * APPLICATION, target USER), read by the post-onboarding landing screen.
 * The binary reaches it through a storage bridge (`Rh`/`jF`) under this
 * plain key name; the fork stores it as a plain storage key with the same
 * name/scope/target (see HONEST-DIVERGENCE in browser/onboardingService.ts).
 */
export const IS_POST_ONBOARDING_FIRST_LANDING_KEY = 'isPostOnboardingFirstLanding';

/** `n$m` @38386593 — read by `pzk()` when the flow completes. */
export const LAYOUT_AUTO_OPEN_FLYOUT_KEY = 'cursor/layoutControl.autoOpenFlyoutOnFirstWorkspaceLaunch';

/** `aFa` @38386875 — set by `pzk()` when the flow completes. */
export const LAYOUT_ELIGIBLE_AFTER_ONBOARDING_KEY = 'cursor/layoutControl.eligibleAfterOnboarding';

/**
 * Reactive-storage fields written by the data-sharing screens. The fork has
 * no reactive storage service; the browser service persists them as plain
 * APPLICATION-scope storage keys under these verbatim field names.
 */
export const NO_STORAGE_MODE_KEY = 'noStorageMode';
export const SELECTED_PRIVACY_FOR_ONBOARDING_KEY = 'selectedPrivacyForOnboarding';
/** Reactive field mirroring the resolved data-privacy variant. */
export const ONBOARDING_DATA_PRIVACY_VERSION_FIELD = 'onboardingDataPrivacyVersion';

/** `ySi` — executed with 600_000 ms on show and 30_000 ms on completion. */
export const HIDE_NOTIFICATIONS_COMMAND_ID = 'cursorai.action.hideNotificationsForMs';
export const HIDE_NOTIFICATIONS_ON_SHOW_MS = 10 * 60_000;
export const HIDE_NOTIFICATIONS_ON_COMPLETE_MS = 30_000;

/** `x_n` — VS Code import, invoked by the post-onboarding import dialog. */
export const IMPORT_VSCODE_COMMAND_ID = 'cursorai.action.importvscode';

// ---------------------------------------------------------------------------
// Window / overlay geometry (binary-verbatim, desk@39631542)
// ---------------------------------------------------------------------------

export const ONBOARDING_MODAL_WIDTH = 1000; // Viw=1e3
export const ONBOARDING_MODAL_HEIGHT = 800; // qiw=800
export const ONBOARDING_RESTORE_WIDTH = 1150; // ziw=1150
export const ONBOARDING_RESTORE_HEIGHT = 701; // Kiw=701
export const ONBOARDING_FADE_MS = 200; // E5a=200

// ---------------------------------------------------------------------------
// Pages + validity (binary-verbatim)
// ---------------------------------------------------------------------------

export type OnboardingPageId = 'welcome' | 'marketplace' | 'data-sharing';

/** `LGm=["welcome","marketplace","data-sharing"]` @39667049. */
export const ONBOARDING_PAGES: readonly OnboardingPageId[] = ['welcome', 'marketplace', 'data-sharing'];

export type DataPrivacyOnboardingVariant = 'legacy' | 'new' | 'new2';

/**
 * Verbatim port of the binary page-validity predicate `x5a` @39667049:
 * ```
 * x5a=(e,t,n)=>{if(e==="welcome"&&t)return!1;
 *   if(e==="data-sharing"){if(n==="off"||n==="on_logged_in"&&!t)return!1;
 *     if(n==="on"||n===void 0)return!0}return!0}
 * ```
 * `t` is `isAuthenticated`, `n` is the
 * `privacy_mode_acknowledgement_onboarding` mode flag.
 */
export function isOnboardingPageValid(page: OnboardingPageId, isAuthenticated: boolean, privacyAckMode: string | undefined): boolean {
	if (page === 'welcome' && isAuthenticated) {
		return false;
	}
	if (page === 'data-sharing') {
		if (privacyAckMode === 'off' || (privacyAckMode === 'on_logged_in' && !isAuthenticated)) {
			return false;
		}
		if (privacyAckMode === 'on' || privacyAckMode === undefined) {
			return true;
		}
	}
	return true;
}

/** The pages the flow actually visits, in binary order. */
export function visibleOnboardingPages(isAuthenticated: boolean, privacyAckMode: string | undefined): OnboardingPageId[] {
	return ONBOARDING_PAGES.filter(page => isOnboardingPageValid(page, isAuthenticated, privacyAckMode));
}

/** Next valid page in `visible` order, or undefined at the end. */
export function adjacentOnboardingPage(visible: readonly OnboardingPageId[], current: OnboardingPageId, direction: 1 | -1): OnboardingPageId | undefined {
	const index = visible.indexOf(current);
	if (index === -1) {
		return undefined;
	}
	return visible[index + direction];
}

export function isLastOnboardingPage(visible: readonly OnboardingPageId[], current: OnboardingPageId): boolean {
	return visible.length > 0 && visible[visible.length - 1] === current;
}

// ---------------------------------------------------------------------------
// Startup decision (maybeOnboard) + completion side effects
// ---------------------------------------------------------------------------

/** Minimal storage surface the pure logic needs (see scope note above). */
export interface IOnboardingStorage {
	get(key: string, scope: number, fallbackValue?: string): string | undefined;
	store(key: string, value: string, scope: number, target: number): void;
}

/** `glassWelcomeSplashShown()` @39672320: JSON.parse(value)===true, errors → false. */
export function parseGlassSplashShown(rawValue: string | undefined): boolean {
	if (rawValue === undefined) {
		return false;
	}
	try {
		return JSON.parse(rawValue) === true;
	} catch {
		return false;
	}
}

export type MaybeOnboardDecision = 'show' | 'suppress-by-splash' | 'skip';

/**
 * Verbatim decision of `maybeOnboard()` @39672320:
 * ```
 * if (alreadyRendering || isGlass || skipOnboarding
 *     || storage.get(c9e, -1, "true") !== "true") skip;
 * else if (glassWelcomeSplashShown()) suppress (caller stores "false");
 * else show;
 * ```
 * `firstTimeValue` is the result of `storage.get(FIRST_TIME_KEY, -1, "true")`.
 */
export function maybeOnboardDecision(input: {
	readonly alreadyRendering: boolean;
	readonly isGlass: boolean;
	readonly skipOnboarding: boolean;
	readonly firstTimeValue: string | undefined;
	readonly glassSplashShown: boolean;
}): MaybeOnboardDecision {
	if (input.alreadyRendering || input.isGlass || input.skipOnboarding || input.firstTimeValue !== 'true') {
		return 'skip';
	}
	if (input.glassSplashShown) {
		return 'suppress-by-splash';
	}
	return 'show';
}

/**
 * The `cursor.startOnboarding` run() storage effects @39640515, verbatim:
 * `store(c9e,"true",-1,1)` then `isPostOnboardingFirstLanding` set false.
 */
export function prepareOnboardingRestart(storage: IOnboardingStorage): void {
	storage.store(ONBOARDING_FIRST_TIME_KEY, 'true', ONBOARDING_STORAGE_SCOPE_APPLICATION, ONBOARDING_STORAGE_TARGET_MACHINE);
	storage.store(IS_POST_ONBOARDING_FIRST_LANDING_KEY, 'false', ONBOARDING_STORAGE_SCOPE_APPLICATION, ONBOARDING_STORAGE_TARGET_USER);
}

/** The splash-suppression store in `maybeOnboard()`: `store(c9e,"false",-1,1)`. */
export function markOnboardingSuppressedBySplash(storage: IOnboardingStorage): void {
	storage.store(ONBOARDING_FIRST_TIME_KEY, 'false', ONBOARDING_STORAGE_SCOPE_APPLICATION, ONBOARDING_STORAGE_TARGET_MACHINE);
}

/**
 * `pzk(storage)` @38386875, verbatim:
 * `pMr(e) || e.store(aFa,"true",-1,1)` with `pMr(e)=e.get(n$m,-1)==="true"`.
 */
export function markLayoutEligibleAfterOnboarding(storage: IOnboardingStorage): void {
	if (storage.get(LAYOUT_AUTO_OPEN_FLYOUT_KEY, ONBOARDING_STORAGE_SCOPE_APPLICATION) !== 'true') {
		storage.store(LAYOUT_ELIGIBLE_AFTER_ONBOARDING_KEY, 'true', ONBOARDING_STORAGE_SCOPE_APPLICATION, ONBOARDING_STORAGE_TARGET_MACHINE);
	}
}

/**
 * The completion (`doDispose`) storage effects @39675938, verbatim order:
 * `store(c9e,"false",-1,1)`; `pzk(storage)`;
 * `isPostOnboardingFirstLanding` set true; `store(v_n,"true",-1,1)`.
 * (The binary also executes `hideNotificationsForMs(30_000)` afterwards;
 * that is a command, so the browser service performs it, not this module.)
 */
export function completeOnboardingStorageEffects(storage: IOnboardingStorage): void {
	storage.store(ONBOARDING_FIRST_TIME_KEY, 'false', ONBOARDING_STORAGE_SCOPE_APPLICATION, ONBOARDING_STORAGE_TARGET_MACHINE);
	markLayoutEligibleAfterOnboarding(storage);
	storage.store(IS_POST_ONBOARDING_FIRST_LANDING_KEY, 'true', ONBOARDING_STORAGE_SCOPE_APPLICATION, ONBOARDING_STORAGE_TARGET_USER);
	storage.store(ONBOARDING_CHANGE_POPUP_SHOWN_KEY, 'true', ONBOARDING_STORAGE_SCOPE_APPLICATION, ONBOARDING_STORAGE_TARGET_MACHINE);
}

// ---------------------------------------------------------------------------
// Data-privacy variant resolution (binary-verbatim)
// ---------------------------------------------------------------------------

/**
 * `getShouldUseNewDataPrivacyOnboarding` @39674148: a cached value in
 * {legacy,new,new2} wins; otherwise the (server) config number maps
 * `2 → "new"`, `3 → "new2"`, anything else (including fetch failure,
 * modelled here as `undefined`) → `"legacy"`, and the result is persisted.
 */
export function resolveDataPrivacyVariant(cachedRaw: string | undefined, configValue: number | undefined): { variant: DataPrivacyOnboardingVariant; fromCache: boolean } {
	if (cachedRaw === 'legacy' || cachedRaw === 'new' || cachedRaw === 'new2') {
		return { variant: cachedRaw, fromCache: true };
	}
	const variant: DataPrivacyOnboardingVariant = configValue === 2 ? 'new' : configValue === 3 ? 'new2' : 'legacy';
	return { variant, fromCache: false };
}

// ---------------------------------------------------------------------------
// hasVscode detection (EGm @39634436)
// ---------------------------------------------------------------------------

/**
 * `EGm`: true iff `<userHome>/.vscode` resolves with at least one child.
 * The browser service performs the file-service call and passes the child
 * count (undefined when the resolve failed, which the binary treats as
 * false via its try/catch).
 */
export function hasVscodeFromChildCount(childCount: number | undefined): boolean {
	return childCount !== undefined && childCount > 0;
}

// ---------------------------------------------------------------------------
// Analytics event names (binary-verbatim `trackEvent` names)
// ---------------------------------------------------------------------------

export const ONBOARDING_ANALYTICS = {
	started: 'onboarding.started',
	completed: 'onboarding.completed',
	aborted: 'onboarding.aborted',
	backClicked: 'onboarding.navigation.back_clicked',
	welcomeViewed: 'onboarding.welcome.viewed',
	welcomeLoginClicked: 'onboarding.welcome.login_clicked',
	welcomeSignupClicked: 'onboarding.welcome.signup_clicked',
	welcomeContinueClicked: 'onboarding.welcome.continue_clicked',
	marketplaceViewed: 'onboarding.marketplace.viewed',
	marketplaceFetchFailed: 'onboarding.marketplace.fetch_failed',
	marketplacePluginAdded: 'onboarding.marketplace.plugin_added',
	marketplaceInstallFailed: 'onboarding.marketplace.install_failed',
	marketplaceContinueClicked: 'onboarding.marketplace.continue_clicked',
	marketplaceSkipClicked: 'onboarding.marketplace.skip_clicked',
	marketplaceLinkClicked: 'onboarding.marketplace.marketplace_link_clicked',
	dataSharingViewed: 'onboarding.data_sharing.viewed',
	dataSharingChoiceMade: 'onboarding.data_sharing.choice_made',
	dataSharingContinueClicked: 'onboarding.data_sharing.continue_clicked',
	dataSharingPrivacyPolicyClicked: 'onboarding.data_sharing.privacy_policy_clicked',
	dataSharingSecurityClicked: 'onboarding.data_sharing.security_clicked',
} as const;

/** Telemetry capture names (`publicLogCapture`) used by the privacy cards. */
export const ONBOARDING_TELEMETRY = {
	privacyNewAccepted: 'onboarding.card.privacy_new.accepted',
	privacyEnabled: 'onboarding.card.privacy.enabled',
	privacyDisabled: 'onboarding.card.privacy.disabled',
} as const;

// ---------------------------------------------------------------------------
// Copy (binary-verbatim strings; see work-notes-gaps148.md §1.5)
// ---------------------------------------------------------------------------

export const ONBOARDING_COPY = {
	// Welcome (Grw @39663216 / jrw @39664470)
	welcomeTitle: 'Cursor',
	welcomeSubtitle: 'The best way to code with AI',
	logIn: 'Log In',
	signUp: 'Sign Up',
	skipForNow: 'Skip For Now',
	skipHint: 'Skip this step',
	signInLinkCopied: 'Sign in link copied to clipboard',
	signUpLinkCopied: 'Sign up link copied to clipboard',
	failedToCopyLink: 'Failed to copy link to clipboard',
	copySignInLink: 'Copy sign in link',
	copySignUpLink: 'Copy sign up link',

	// Shared chrome / buttons
	continue: 'Continue',
	finish: 'Finish',
	// NF-2 (QA-156): marketplace primary button when it is the last screen
	// (binary Brw: `e.isLastScreen?"Start Building":"Continue"`, the only
	// "Start Building" occurrence in desk). Data-sharing screens keep
	// `finish` above — theirs is binary-verbatim "Finish".
	startBuilding: 'Start Building',
	skip: 'Skip',
	learnMore: 'Learn More',
	loading: 'Loading...',

	// Marketplace (Brw)
	marketplaceTitle: 'Plugins give your agents important context',
	marketplaceCaptionBeforeLink: 'You can always add these plugins and dozens more from the ',
	marketplaceLinkText: 'Cursor Marketplace',
	marketplaceUrl: 'https://www.cursor.com/marketplace',
	added: 'Added',
	add: 'Add',

	// Data sharing — shared
	dataSharingTitle: 'Data Sharing',
	privacyPolicyUrl: 'https://cursor.com/privacy',
	privacyPolicyUrlWww: 'https://www.cursor.com/privacy',
	securityUrl: 'https://www.cursor.com/security',
	modifySettingsCaption: 'You can modify these settings at any time',
	modelProviderSuffix: ' Prompts and limited telemetry may also be shared with model providers when you explicitly select their models.',

	// Data sharing — new2 (krw @39649804)
	new2Subtitle: 'You\u2019re in control of how your data is used',
	helpImproveTitle: 'Help Improve Cursor',
	new2AcceptSubtitle: 'I am fine with Cursor learning from my code!',
	new2AcceptDescription: 'After one day of use, Cursor stores and learns from your prompts, codebase, edit history, and other usage data to improve the product.',
	privacyModeTitle: 'Privacy Mode',
	new2PrivacySubtitle: 'I do not want to enable data sharing.',
	new2PrivacyDescription: 'With Privacy Mode enabled, none of your questions or code will ever be stored or learned from by us or any third-party.',

	// Data sharing — legacy (Irw @39654720)
	legacySubtitle: 'Choose how you\u2019d like to share data with Cursor',
	legacySubtitleEnterprise: 'Your team settings determine data sharing with Cursor',
	legacyAcceptDescription: 'To make Cursor better, this option lets us collect usage data. This includes questions in chat, code snippets, edits, and editor actions.',
	legacyPrivacyDescription: 'If you enable Privacy Mode, none of your questions or code will ever be stored by us or any third-party.',
	recommended: 'Recommended',

	// Data sharing — new (MGm @39643762)
	newSubtitle: 'Help improve Cursor for everyone',
	newIntro: 'By default, Cursor learns from code to help you get the best experience possible.',
	newIntroEnterprise: 'When data sharing is enabled, Cursor learns from code to help your team get the best experience possible.',
	// NF-1 (QA-156): the binary HTML templates of the "new" variant use ASCII
	// apostrophes (vrw @39643586, mrw @39642386), unlike the \u2019 JS-string
	// subtitles above (new2Subtitle/legacySubtitle keep \u2019 — do not change).
	newBullet1Lead: 'You\'re in control. ',
	newBullet1: 'Turn off anytime in Settings \u2192 Privacy.',
	newBullet1LeadEnterprise: 'Your team admin is in control. ',
	newBullet1EnterpriseBeforeState: 'Data sharing is',
	newBullet1EnterpriseEnabled: ' enabled ',
	newBullet1EnterpriseDisabled: ' disabled ',
	newBullet1EnterpriseAfterState: 'for your team. You are on a Business plan, so your team admin can turn off or on data collection for your device.',
	newBullet2Lead: 'Data sharing is off the first day.',
	newBullet2: ' After one day of use, Cursor stores and learns from your prompts, codebase, edit history, and other usage data to improve the product.',
	newBullet2Enterprise: ' If your team admin has enabled data sharing, after one day of use, Cursor stores and learns from your prompts, codebase, edit history, and other usage data to improve the product.',
	newMoreOn: 'More on ',
	newPrivacyPolicy: 'Privacy Policy',
	newAnd: ' and ',
	newSecurity: 'Security',
	newCheckboxLabel: 'I\'m fine with Cursor learning from my code or I\'ll turn it off in Settings',
	newCheckboxLabelEnterprise: 'I understand that my team admin controls data collection settings',
	mustClickCheckboxError: 'Must click checkbox to continue',
} as const;

/**
 * The model-provider suffix rule shared by all three data-sharing
 * variants: appended when `!isAuthenticated || partnerDataShare`
 * (binary: `!t.cursorAuthenticationService.isAuthenticated() ||
 * t.cursorAuthenticationService.partnerDataShare()`).
 */
export function modelProviderSuffixApplies(isAuthenticated: boolean, partnerDataShare: boolean): boolean {
	return !isAuthenticated || partnerDataShare;
}

/** Base description + the verbatim suffix when the rule applies. */
export function withModelProviderSuffix(base: string, applies: boolean): string {
	return applies ? base + ONBOARDING_COPY.modelProviderSuffix : base;
}

/**
 * The data-sharing screens' initial selection in the binary is
 * `noStorageMode` (privacy mode): choosing the "Help Improve Cursor" card
 * is recorded as choice `"accept"`, the "Privacy Mode" card as `"decline"`
 * (choice_made mapping in krw/Irw: `l ? "decline" : "accept"` where `l` is
 * the noStorageMode value being set).
 */
export function dataSharingChoiceName(privacyMode: boolean): 'accept' | 'decline' {
	return privacyMode ? 'decline' : 'accept';
}
