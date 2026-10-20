/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Cursor composer voice-dictation command parity (feature matrix: agent-voice-dictation).
//
// Binary registration (Cursor 3.25.9, verified against workbench.desktop.main.js,
// @29975718 / @29976011) — two Action2 subclasses:
//
//   class gfm extends vt {                          // "composer.toggleVoiceDictation"
//     constructor(){super({
//       id:"composer.toggleVoiceDictation",
//       title:{value:"Toggle Voice Mode",original:"Toggle Voice Mode"},
//       category:Yn.Cursor, f1:!0, precondition:isGlass.negate(),
//       keybinding:{primary:CtrlCmd|Shift|Space, weight:201,
//         when:isGlass.negate() && !terminalFocus}})}
//     async run(t){
//       if(t.get(Tn).getContextKeyValue("isGlass"))return;
//       const i=t.get(vLe),r=t.get(v_),s=t.get(Qs),o=i.getState();
//       if(o.status==="idle"||o.status==="error"){
//         const a=s.selectedComposerId;
//         r.isShowing(a)||await r.showAndFocus(a,{skipFocus:!0}),
//         await i.start(GKp({composerId:a,
//           bubbleId:s.getComposerDataIfLoaded(a)?.lastFocusedBubbleId}))
//       }else o.status==="recording"&&await i.stop()}}
//
//   class ffm extends vt {                          // "composer.cancelVoiceDictation"
//     constructor(){super({
//       id:"composer.cancelVoiceDictation",
//       title:{value:"Cancel Voice Mode",original:"Cancel Voice Mode"},
//       category:Yn.Cursor, f1:!1,
//       keybinding:{primary:Escape, weight:201,
//         when:(activeEditor=="workbench.editor.composer" ||
//               (view=="workbench.panel.aichat.view" && composerIsVisible)) &&
//              voiceInputRecording}})}
//     async run(t){
//       const n=t.get(vLe),i=n.getState().status;
//       (i==="recording"||i==="processing")&&await n.cancel()}}
//
// DIVERGENCES (documented, per ~/AGENTS.md honesty rule):
//   - `isGlass.negate()` precondition/keybinding conjuncts are DROPPED: the
//     feature is registered in Cursor's desktop bundle only, and the fork is
//     desktop-only — the conjunct is trivially true here.
//   - Category: binary `Yn.Cursor` ("Cursor"); the fork's composer surface
//     uses `ComposerActionCategory` ("Composer") — same role, fork naming.
//   - Editor/view ids in the cancel when-clause are the fork's:
//     "workbench.editor.composer" -> "composer.chatEditor"
//     "workbench.panel.aichat.view" -> "composer.chat"
//   - `composerIsVisible` has no fork equivalent; the `view ==` check already
//     scopes to the visible chat surface.
//   - The composer visibility/composerId/bubbleId plumbing (`v_`, `Qs`) is
//     the fork's `composer.focusComposer` command (binary-verbatim "Focus
//     Agent", delegates to the extension-owned composer until it migrates to
//     core); core does not know chat tabs, so the start options carry the
//     'composer' ownerId fallback unless the caller passes
//     {composerId, bubbleId} (e.g. the future mic button).

import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { localize2 } from '../../../../nls.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ComposerActionCategory } from './composerActions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IVoiceInputService, VoiceInputToggleKeybindingWhen } from './voice/voiceInputService.js';
import {
	TOGGLE_VOICE_DICTATION_COMMAND_ID,
	CANCEL_VOICE_DICTATION_COMMAND_ID,
	VOICE_DICTATION_KEYBINDING_WEIGHT,
	VOICE_DICTATION_COMPOSER_EDITOR_ID,
	VOICE_DICTATION_COMPOSER_VIEW_ID,
	buildVoiceInputStartOptions,
} from '../common/voiceInput.js';

const VOICE_DICTATION_WEIGHT = KeybindingWeight.WorkbenchContrib + (VOICE_DICTATION_KEYBINDING_WEIGHT - KeybindingWeight.WorkbenchContrib);

/** Optional mic-button args: `{ composerId?: string; bubbleId?: string }`. */
interface IVoiceDictationActionArgs {
	composerId?: string;
	bubbleId?: string;
}

function asVoiceDictationArgs(args: unknown[]): IVoiceDictationActionArgs {
	const first = args[0];
	if (first && typeof first === 'object') {
		const { composerId, bubbleId } = first as { composerId?: unknown; bubbleId?: unknown };
		return {
			composerId: typeof composerId === 'string' ? composerId : undefined,
			bubbleId: typeof bubbleId === 'string' ? bubbleId : undefined,
		};
	}
	return {};
}

/**
 * Binary `gfm`: `composer.toggleVoiceDictation` — "Toggle Voice Mode".
 */
class ToggleVoiceDictationAction extends Action2 {
	constructor() {
		super({
			id: TOGGLE_VOICE_DICTATION_COMMAND_ID,
			// Binary verbatim title: "Toggle Voice Mode" (title says "Voice Mode"
			// while the id says "VoiceDictation" — kept verbatim).
			title: localize2('composer.toggleVoiceDictation', 'Toggle Voice Mode'),
			category: ComposerActionCategory, // binary: Yn.Cursor; see header note
			f1: true,
			keybinding: {
				weight: VOICE_DICTATION_WEIGHT, // binary verbatim: 201
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Space,
				when: VoiceInputToggleKeybindingWhen, // binary: he.not("terminalFocus")
			},
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		const voiceService = accessor.get(IVoiceInputService);
		const status = voiceService.getState().status;
		if (status === 'idle' || status === 'error') {
			// Binary: ensure the composer is shown & focused before recording
			// (binary `r.isShowing(a)||await r.showAndFocus(a,{skipFocus:!0})`).
			// IDE-CODE: the composer UI is extension-owned until the native-DOM
			// rewrite, so this goes through the binary-verbatim `composer.focusComposer`
			// ("Focus Agent") command which the extension implements.
			await accessor.get(ICommandService).executeCommand('composer.focusComposer');
			const { composerId, bubbleId } = asVoiceDictationArgs(args);
			await voiceService.start(buildVoiceInputStartOptions(composerId, bubbleId));
		} else if (status === 'recording') {
			await voiceService.stop();
		}
	}
}

/**
 * Binary `ffm`: `composer.cancelVoiceDictation` — "Cancel Voice Mode".
 */
class CancelVoiceDictationAction extends Action2 {
	constructor() {
		super({
			id: CANCEL_VOICE_DICTATION_COMMAND_ID,
			title: localize2('composer.cancelVoiceDictation', 'Cancel Voice Mode'),
			category: ComposerActionCategory, // binary: Yn.Cursor; see header note
			f1: false,
			keybinding: {
				weight: VOICE_DICTATION_WEIGHT, // binary verbatim: 201
				primary: KeyCode.Escape,
				when: ContextKeyExpr.and(
					ContextKeyExpr.or(
						ContextKeyExpr.equals('activeEditor', VOICE_DICTATION_COMPOSER_EDITOR_ID),
						ContextKeyExpr.equals('view', VOICE_DICTATION_COMPOSER_VIEW_ID),
					),
					ContextKeyExpr.has('voiceInputRecording'), // binary verbatim context key
				),
			},
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const voiceService = accessor.get(IVoiceInputService);
		const status = voiceService.getState().status;
		if (status === 'recording' || status === 'processing') {
			await voiceService.cancel();
		}
	}
}

export function registerVoiceDictationActions(): void {
	registerAction2(ToggleVoiceDictationAction);
	registerAction2(CancelVoiceDictationAction);
}
