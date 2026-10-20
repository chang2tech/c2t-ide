/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE (GAPS-148, feature `onboarding-flow`): the `cursor.startOnboarding`
// command, ported verbatim from Cursor 3.25.9 `workbench.desktop.main.js`
// @39640515 (glass @47491019 carries the identical class):
//
//   class Sig extends vt{constructor(){super({
//     id:"cursor.startOnboarding",
//     title:{value:Sig.LABEL,original:"Start Onboarding"},
//     category:Yn.Cursor, f1:!0
//   })}async run(t){
//     const n=t.get(_n), i=t.get(R_a);
//     n.store(c9e,"true",-1,1);
//     const r=Rh(n,"isPostOnboardingFirstLanding");
//     r.set(!1,void 0), r.dispose();
//     i.renderPopupBar();
//   }}; Sig.LABEL="Start Onboarding"
//
// - No keybinding, no menu, no precondition in the binary descriptor.
// - `c9e` = "workbench.contrib.onboarding.browser.gettingStarted.
//   contribution.ts.firsttime" (@478307); store scope -1 = APPLICATION,
//   target 1 = MACHINE (identical numerics in this fork's storage enums).
// - The two storage effects live in common/onboardingFlow.ts
//   (`prepareOnboardingRestart`) so they are unit-testable without the
//   workbench; `renderPopupBar()` is the onboarding service's method
//   (browser/onboardingService.ts; binary DI token "onboardingService" —
//   fork decorator id 'cursorOnboardingService', see divergence D9 there).

import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { localize2 } from '../../../../nls.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { CursorActionCategory } from './composerActions.js';
import { IOnboardingService } from './onboardingService.js';
import {
	IOnboardingStorage,
	START_ONBOARDING_COMMAND_ID,
	START_ONBOARDING_TITLE,
	prepareOnboardingRestart,
} from '../common/onboardingFlow.js';

export class StartOnboardingAction extends Action2 {

	static readonly ID = START_ONBOARDING_COMMAND_ID;

	constructor() {
		super({
			id: StartOnboardingAction.ID,
			// Binary: title {value: Sig.LABEL, original: "Start Onboarding"}.
			title: localize2('cursor.startOnboarding', START_ONBOARDING_TITLE),
			// Binary: category Yn.Cursor ("Cursor").
			category: CursorActionCategory,
			// Binary: f1:!0 — visible in the Command Palette.
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const storageService = accessor.get(IStorageService);
		const onboardingService = accessor.get(IOnboardingService);
		const storage: IOnboardingStorage = {
			get: (key, scope, fallbackValue) => storageService.get(key, scope as StorageScope, fallbackValue),
			store: (key, value, scope, target) => { storageService.store(key, value, scope as StorageScope, target as StorageTarget); },
		};
		// Binary order: store the first-time flag "true", reset
		// isPostOnboardingFirstLanding to false, then render the flow.
		prepareOnboardingRestart(storage);
		onboardingService.renderPopupBar();
	}
}

export function registerOnboardingActions(): void {
	registerAction2(StartOnboardingAction);
}
