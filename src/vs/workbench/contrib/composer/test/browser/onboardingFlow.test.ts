/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import {
	GLASS_FIRST_LAUNCH_SPLASH_SHOWN_KEY,
	HIDE_NOTIFICATIONS_COMMAND_ID,
	IOnboardingStorage,
	IS_POST_ONBOARDING_FIRST_LANDING_KEY,
	LAYOUT_AUTO_OPEN_FLYOUT_KEY,
	LAYOUT_ELIGIBLE_AFTER_ONBOARDING_KEY,
	NO_STORAGE_MODE_KEY,
	ONBOARDING_CHANGE_POPUP_SHOWN_KEY,
	ONBOARDING_COPY,
	ONBOARDING_DATA_PRIVACY_VERSION_KEY,
	ONBOARDING_FIRST_TIME_KEY,
	ONBOARDING_MODAL_HEIGHT,
	ONBOARDING_MODAL_WIDTH,
	ONBOARDING_PAGES,
	ONBOARDING_RESTORE_HEIGHT,
	ONBOARDING_RESTORE_WIDTH,
	ONBOARDING_SHOWING_CONTEXT_KEY,
	START_ONBOARDING_COMMAND_ID,
	START_ONBOARDING_TITLE,
	adjacentOnboardingPage,
	completeOnboardingStorageEffects,
	dataSharingChoiceName,
	hasVscodeFromChildCount,
	isLastOnboardingPage,
	isOnboardingPageValid,
	markOnboardingSuppressedBySplash,
	maybeOnboardDecision,
	modelProviderSuffixApplies,
	parseGlassSplashShown,
	prepareOnboardingRestart,
	resolveDataPrivacyVariant,
	visibleOnboardingPages,
	withModelProviderSuffix,
} from '../../common/onboardingFlow.js';

// GAPS-148 — `onboarding-flow`: Cursor 3.25.9 parity for
// `cursor.startOnboarding` + the onboarding-v2 flow. Binary evidence:
// ide-code-mission docs/rea/work-notes-gaps148.md.
// These tests cover the pure logic in common/onboardingFlow.ts:
//  A. verbatim constants (ids, storage keys, geometry);
//  B. maybeOnboard() startup decision (desk@39672320);
//  C. page validity `x5a` (desk@39667049) + navigation helpers;
//  D. command run() storage effects + completion effects (incl. pzk);
//  E. data-privacy variant resolution + copy suffix/choice rules.

class FakeStorage implements IOnboardingStorage {
	readonly values = new Map<string, string>();
	readonly writes: { key: string; value: string; scope: number; target: number }[] = [];
	get(key: string, scope: number, fallbackValue?: string): string | undefined {
		return this.values.has(key) ? this.values.get(key) : fallbackValue;
	}
	store(key: string, value: string, scope: number, target: number): void {
		this.values.set(key, value);
		this.writes.push({ key, value, scope, target });
	}
}

suite('gaps148: onboardingFlow (cursor.startOnboarding parity)', () => {

	test('A: command identity is binary-verbatim', () => {
		assert.strictEqual(START_ONBOARDING_COMMAND_ID, 'cursor.startOnboarding');
		assert.strictEqual(START_ONBOARDING_TITLE, 'Start Onboarding');
		assert.strictEqual(ONBOARDING_SHOWING_CONTEXT_KEY, 'cursor.onboarding.showing');
		assert.strictEqual(HIDE_NOTIFICATIONS_COMMAND_ID, 'cursorai.action.hideNotificationsForMs');
	});

	test('A: storage keys are binary-verbatim', () => {
		assert.strictEqual(ONBOARDING_FIRST_TIME_KEY, 'workbench.contrib.onboarding.browser.gettingStarted.contribution.ts.firsttime');
		assert.strictEqual(ONBOARDING_CHANGE_POPUP_SHOWN_KEY, 'workbench.contrib.onboarding.browser.changePopup.03292025.shown');
		assert.strictEqual(ONBOARDING_DATA_PRIVACY_VERSION_KEY, 'cursor.featureStatus.dataPrivacyOnboarding');
		assert.strictEqual(GLASS_FIRST_LAUNCH_SPLASH_SHOWN_KEY, 'cursor/glass.firstLaunchSplashShown');
		assert.strictEqual(IS_POST_ONBOARDING_FIRST_LANDING_KEY, 'isPostOnboardingFirstLanding');
		assert.strictEqual(LAYOUT_AUTO_OPEN_FLYOUT_KEY, 'cursor/layoutControl.autoOpenFlyoutOnFirstWorkspaceLaunch');
		assert.strictEqual(LAYOUT_ELIGIBLE_AFTER_ONBOARDING_KEY, 'cursor/layoutControl.eligibleAfterOnboarding');
	});

	test('A: pages + modal geometry are binary-verbatim', () => {
		assert.deepStrictEqual([...ONBOARDING_PAGES], ['welcome', 'marketplace', 'data-sharing']);
		assert.strictEqual(ONBOARDING_MODAL_WIDTH, 1000);
		assert.strictEqual(ONBOARDING_MODAL_HEIGHT, 800);
		assert.strictEqual(ONBOARDING_RESTORE_WIDTH, 1150);
		assert.strictEqual(ONBOARDING_RESTORE_HEIGHT, 701);
	});

	test('B: maybeOnboard shows on first run', () => {
		assert.strictEqual(maybeOnboardDecision({
			alreadyRendering: false, isGlass: false, skipOnboarding: false,
			firstTimeValue: 'true', glassSplashShown: false,
		}), 'show');
	});

	test('B: maybeOnboard skips when already rendering / glass / skip flag / flag not "true"', () => {
		const base = { alreadyRendering: false, isGlass: false, skipOnboarding: false, firstTimeValue: 'true', glassSplashShown: false };
		assert.strictEqual(maybeOnboardDecision({ ...base, alreadyRendering: true }), 'skip');
		assert.strictEqual(maybeOnboardDecision({ ...base, isGlass: true }), 'skip');
		assert.strictEqual(maybeOnboardDecision({ ...base, skipOnboarding: true }), 'skip');
		assert.strictEqual(maybeOnboardDecision({ ...base, firstTimeValue: 'false' }), 'skip');
		assert.strictEqual(maybeOnboardDecision({ ...base, firstTimeValue: undefined }), 'skip');
	});

	test('B: glass splash suppresses and stores "false"', () => {
		assert.strictEqual(maybeOnboardDecision({
			alreadyRendering: false, isGlass: false, skipOnboarding: false,
			firstTimeValue: 'true', glassSplashShown: true,
		}), 'suppress-by-splash');
		const storage = new FakeStorage();
		markOnboardingSuppressedBySplash(storage);
		assert.deepStrictEqual(storage.writes, [
			{ key: ONBOARDING_FIRST_TIME_KEY, value: 'false', scope: -1, target: 1 },
		]);
		// splash parse: JSON true only; garbage/undefined → false
		assert.strictEqual(parseGlassSplashShown('true'), true);
		assert.strictEqual(parseGlassSplashShown('false'), false);
		assert.strictEqual(parseGlassSplashShown('not json'), false);
		assert.strictEqual(parseGlassSplashShown(undefined), false);
	});

	test('C: x5a page validity — welcome skipped when authenticated', () => {
		assert.strictEqual(isOnboardingPageValid('welcome', true, undefined), false);
		assert.strictEqual(isOnboardingPageValid('welcome', false, undefined), true);
		assert.strictEqual(isOnboardingPageValid('marketplace', true, undefined), true);
		assert.strictEqual(isOnboardingPageValid('marketplace', false, 'off'), true);
	});

	test('C: x5a page validity — data-sharing modes', () => {
		assert.strictEqual(isOnboardingPageValid('data-sharing', false, 'off'), false);
		assert.strictEqual(isOnboardingPageValid('data-sharing', true, 'off'), false);
		assert.strictEqual(isOnboardingPageValid('data-sharing', false, 'on_logged_in'), false);
		assert.strictEqual(isOnboardingPageValid('data-sharing', true, 'on_logged_in'), true);
		assert.strictEqual(isOnboardingPageValid('data-sharing', false, 'on'), true);
		assert.strictEqual(isOnboardingPageValid('data-sharing', false, undefined), true);
		assert.strictEqual(isOnboardingPageValid('data-sharing', false, 'something-else'), true);
	});

	test('C: visible pages + navigation + last-page', () => {
		assert.deepStrictEqual(visibleOnboardingPages(false, undefined), ['welcome', 'marketplace', 'data-sharing']);
		assert.deepStrictEqual(visibleOnboardingPages(true, undefined), ['marketplace', 'data-sharing']);
		assert.deepStrictEqual(visibleOnboardingPages(false, 'off'), ['welcome', 'marketplace']);
		const visible = visibleOnboardingPages(false, undefined);
		assert.strictEqual(adjacentOnboardingPage(visible, 'welcome', 1), 'marketplace');
		assert.strictEqual(adjacentOnboardingPage(visible, 'marketplace', -1), 'welcome');
		assert.strictEqual(adjacentOnboardingPage(visible, 'data-sharing', 1), undefined);
		assert.strictEqual(adjacentOnboardingPage(visible, 'welcome', -1), undefined);
		assert.strictEqual(isLastOnboardingPage(visible, 'data-sharing'), true);
		assert.strictEqual(isLastOnboardingPage(visible, 'welcome'), false);
	});

	test('D: prepareOnboardingRestart writes flag "true" (APP/MACHINE) + landing false', () => {
		const storage = new FakeStorage();
		prepareOnboardingRestart(storage);
		assert.deepStrictEqual(storage.writes, [
			{ key: ONBOARDING_FIRST_TIME_KEY, value: 'true', scope: -1, target: 1 },
			{ key: IS_POST_ONBOARDING_FIRST_LANDING_KEY, value: 'false', scope: -1, target: 0 },
		]);
	});

	test('D: completion effects — flag false, pzk eligible, landing true, change popup true', () => {
		const storage = new FakeStorage();
		completeOnboardingStorageEffects(storage);
		assert.deepStrictEqual(storage.writes, [
			{ key: ONBOARDING_FIRST_TIME_KEY, value: 'false', scope: -1, target: 1 },
			{ key: LAYOUT_ELIGIBLE_AFTER_ONBOARDING_KEY, value: 'true', scope: -1, target: 1 },
			{ key: IS_POST_ONBOARDING_FIRST_LANDING_KEY, value: 'true', scope: -1, target: 0 },
			{ key: ONBOARDING_CHANGE_POPUP_SHOWN_KEY, value: 'true', scope: -1, target: 1 },
		]);
	});

	test('D: completion effects — pzk skipped when flyout already auto-opened', () => {
		const storage = new FakeStorage();
		storage.values.set(LAYOUT_AUTO_OPEN_FLYOUT_KEY, 'true');
		completeOnboardingStorageEffects(storage);
		assert.strictEqual(storage.values.has(LAYOUT_ELIGIBLE_AFTER_ONBOARDING_KEY), false);
		assert.strictEqual(storage.values.get(ONBOARDING_FIRST_TIME_KEY), 'false');
	});

	test('E: data-privacy variant — cache wins, config maps 2/3, else legacy', () => {
		assert.deepStrictEqual(resolveDataPrivacyVariant('new2', undefined), { variant: 'new2', fromCache: true });
		assert.deepStrictEqual(resolveDataPrivacyVariant('legacy', 3), { variant: 'legacy', fromCache: true });
		assert.deepStrictEqual(resolveDataPrivacyVariant('bogus', 2), { variant: 'new', fromCache: false });
		assert.deepStrictEqual(resolveDataPrivacyVariant(undefined, 3), { variant: 'new2', fromCache: false });
		assert.deepStrictEqual(resolveDataPrivacyVariant(undefined, 2), { variant: 'new', fromCache: false });
		assert.deepStrictEqual(resolveDataPrivacyVariant(undefined, 1), { variant: 'legacy', fromCache: false });
		assert.deepStrictEqual(resolveDataPrivacyVariant(undefined, undefined), { variant: 'legacy', fromCache: false });
	});

	test('E: model-provider suffix rule + choice naming + hasVscode', () => {
		assert.strictEqual(modelProviderSuffixApplies(false, false), true);
		assert.strictEqual(modelProviderSuffixApplies(true, false), false);
		assert.strictEqual(modelProviderSuffixApplies(true, true), true);
		assert.strictEqual(withModelProviderSuffix('Base.', true), 'Base. Prompts and limited telemetry may also be shared with model providers when you explicitly select their models.');
		assert.strictEqual(withModelProviderSuffix('Base.', false), 'Base.');
		assert.strictEqual(dataSharingChoiceName(true), 'decline');
		assert.strictEqual(dataSharingChoiceName(false), 'accept');
		assert.strictEqual(hasVscodeFromChildCount(3), true);
		assert.strictEqual(hasVscodeFromChildCount(0), false);
		assert.strictEqual(hasVscodeFromChildCount(undefined), false);
		assert.strictEqual(NO_STORAGE_MODE_KEY, 'noStorageMode');
	});

	test('F: GAPS-163/QA-156 NF-1+NF-2 — template copy ASCII apostrophes; marketplace last label', () => {
		// Binary HTML templates (vrw @39643586 / mrw @39642386) use ASCII
		// apostrophes (U+0027); the JS-string subtitles use U+2019. The
		// binary is inconsistent on purpose — both halves are locked here.
		assert.strictEqual(ONBOARDING_COPY.newBullet1Lead, 'You\'re in control. ');
		assert.strictEqual(ONBOARDING_COPY.newCheckboxLabel, 'I\'m fine with Cursor learning from my code or I\'ll turn it off in Settings');
		assert.ok(!ONBOARDING_COPY.newBullet1Lead.includes('\u2019'));
		assert.ok(!ONBOARDING_COPY.newCheckboxLabel.includes('\u2019'));
		assert.ok(ONBOARDING_COPY.new2Subtitle.includes('\u2019'));
		assert.ok(ONBOARDING_COPY.legacySubtitle.includes('\u2019'));
		// Brw @39661676: marketplace last-screen primary label.
		assert.strictEqual(ONBOARDING_COPY.startBuilding, 'Start Building');
		assert.strictEqual(ONBOARDING_COPY.finish, 'Finish');
	});
});
