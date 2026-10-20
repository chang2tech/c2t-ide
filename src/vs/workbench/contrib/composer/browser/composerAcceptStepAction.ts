/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize2 } from '../../../../nls.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { Action2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';

/**
 * Binary-verbatim keybinding weight for `composer.acceptComposerStep`
 * (workbench.glass.main.js 3.25.9 @39863346, class LAb:
 * `keybinding:[{primary:dt.CtrlCmd|Xe.Enter,weight:600,...},
 * {primary:dt.CtrlCmd|dt.Alt|Xe.Enter,weight:600,...}]`).
 * Cursor's 600 sits above this fork's `KeybindingWeight` enum
 * (max 400 = ExternalExtension), so the raw value is cast.
 */
const acceptComposerStepKeybindingWeight = 600 as KeybindingWeight;

/**
 * Chat-surface condition — port of the binary's
 * `ft.or(ft.has("composerFocused"), ft.regex("focusedView", /^workbench.panel.aichat.view/))`
 * (class LAb keybinding when-clauses).
 *
 * `composerFocused` is kept VERBATIM — it is the binary's own focus term.
 *
 * HONEST-DIVERGENCE (fork view-id map): the binary's `workbench.panel.aichat.view`
 * is Cursor's AI-chat panel view id. The fork's chat panel views are
 * `composer.chat` (core ComposerChatView) and `ideAgent.chatView` (the
 * ide-agent extension's chat webview), so the focusedView regex maps to
 * those two ids. (The fork sets no `composerFocused` writer yet — until one
 * lands, the focusedView arm carries the condition; keeping the verbatim
 * term means the binding lights up automatically once the writer exists.)
 */
const composerChatSurface = ContextKeyExpr.or(
	ContextKeyExpr.has('composerFocused'),
	ContextKeyExpr.regex('focusedView', /^(composer\.chat|ideAgent\.chatView)/)
);

/**
 * Binary context key `composerSubmitOnCmdEnterEnabled`
 * (`new pn("composerSubmitOnCmdEnterEnabled", !1)` @17969880 — default false).
 * Referenced by key NAME here: the owning RawContextKey is defined by the
 * composer contrib's context-keys module. Until it is bound, the key is
 * unset → falsy → the plain CtrlCmd+Enter binding is the live one, which is
 * exactly the binary's default-false behavior (only one binding active).
 */
const submitOnCmdEnterEnabled = ContextKeyExpr.has('composerSubmitOnCmdEnterEnabled');

/**
 * FEATURE-1 (`agent-accept-pending-decisions`): binary-verbatim
 * `composer.acceptComposerStep` ("Accept pending agent pane action",
 * workbench.glass.main.js 3.25.9 @39863346, class LAb):
 *
 *   super({id:gEn,title:{value:"Accept pending agent pane action",
 *     original:"Accept pending agent pane action"},f1:!0,
 *     keybinding:[{primary:dt.CtrlCmd|Xe.Enter,weight:600,
 *       when:ft.and(ft.or(ft.has("composerFocused"),
 *       ft.regex("focusedView",new RegExp(`^${pD}`))),Jis.negate())},
 *       {primary:dt.CtrlCmd|dt.Alt|Xe.Enter,weight:600,
 *       when:ft.and(ft.or(ft.has("composerFocused"),
 *       ft.regex("focusedView",new RegExp(`^${pD}`))),ft.has(Jis.key))}]})
 *
 * — NO category (the binary registers none), f1:!0 (palette-visible).
 * `pD` = `"workbench.panel.aichat.view"` (the focusedView regex);
 * `Jis` = `composerSubmitOnCmdEnterEnabled` (default false): plain
 * CtrlCmd+Enter accepts while the submit-on-cmd-enter setting is OFF; when
 * it is ON the accept binding moves to CtrlCmd+Alt+Enter so it never
 * collides with chat submit.
 *
 * Run (binary): raw selectedComposerId -> getHandleIfLoaded -> the
 * tool-former's getPendingUserDecisionGroup(handle); a non-empty group ->
 * accept() EVERY item unconditionally; otherwise
 * composerNotificationService.acceptNotification() (fires
 * _onAcceptNotification only while a notification is showing; no warning on
 * empty group / no selection / not loaded). Distinct from the shell-tool
 * approve/skip flow (Enter/Shift+Enter/Escape act on ONE picked item with
 * run/skip/allowlist; this command accepts ALL with no skip path).
 */
export class ComposerAcceptComposerStepAction extends Action2 {
	static readonly ID = 'composer.acceptComposerStep';
	constructor() {
		super({
			id: ComposerAcceptComposerStepAction.ID,
			title: localize2('composer.acceptComposerStep', 'Accept pending agent pane action'),
			f1: true,
			keybinding: [
				{
					weight: acceptComposerStepKeybindingWeight,
					primary: KeyMod.CtrlCmd | KeyCode.Enter,
					when: ContextKeyExpr.and(composerChatSurface, submitOnCmdEnterEnabled.negate()),
				},
				{
					weight: acceptComposerStepKeybindingWeight,
					primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.Enter,
					when: ContextKeyExpr.and(composerChatSurface, submitOnCmdEnterEnabled),
				},
			],
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// IDE-CODE architecture: the composer engine lives in the ide-agent
		// extension; core workbench actions delegate to its `ide.*` runtime
		// commands. `ide.acceptComposerStep` implements the binary run()
		// verbatim: the active composer's pending user-decision group is
		// accepted item-by-item (unconditional accept loop); when the group
		// is empty it falls back to acceptNotification().
		await accessor.get(ICommandService).executeCommand('ide.acceptComposerStep', ...args);
	}
}
