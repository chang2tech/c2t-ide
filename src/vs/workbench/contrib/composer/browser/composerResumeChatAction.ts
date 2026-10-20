/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize2 } from '../../../../nls.js';
import { URI } from '../../../../base/common/uri.js';
import { Action2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { EditorInput } from '../../../common/editor/editorInput.js';

/**
 * URI scheme of the fork's chat editor tabs.
 *
 * Mirrors the ide-agent extension's `CHAT_EDITOR_SCHEME` ("ide-chat") —
 * `extensions/ide-agent/src/services/chatEditorProvider.ts` opens one real
 * editor tab per chat with document URI `ide-chat:/<tabId>`. Core identifies
 * chat editors by this scheme (see HONEST-DIVERGENCE below).
 */
const COMPOSER_CHAT_EDITOR_SCHEME = 'ide-chat';

/**
 * Tab id from a chat editor URI — fail-closed port of the extension's
 * `tabIdFromUri` (`extensions/ide-agent/src/services/chatEditorProvider.ts`,
 * QA-CHATEDITOR P3-5): only exactly `/<tabId>` translates; empty ids, nested
 * paths, `.`/`..` and anything containing `..` are REJECTED (undefined)
 * instead of producing a garbage id that then misses every lookup.
 */
export function composerChatTabIdFromChatUri(uri: URI): string | undefined {
	const id = uri.path.replace(/^\//, '');
	if (!id || id.includes('/') || id === '.' || id === '..' || id.includes('..')) {
		return undefined;
	}
	return id;
}

/**
 * Chat editor input for a chat editor input-like object: the input is a chat
 * editor when its `resource` carries the `ide-chat` scheme; its tab id is the
 * fail-closed translation of the resource path.
 */
function chatTabIdFromEditorInput(input: EditorInput | undefined): string | undefined {
	const resource = input?.resource;
	if (resource?.scheme !== COMPOSER_CHAT_EDITOR_SCHEME) {
		return undefined;
	}
	return composerChatTabIdFromChatUri(resource);
}

/**
 * DEV-GAPS-56 (`agent-resume-chat`): selected-composer resolver, ported from
 * Cursor's MiI (the resolver `ComposerRenameChatAction` documents).
 *
 * - a string arg is the composer id VERBATIM (binary 3.25.6 and 3.25.9
 *   return it with NO length check; an empty string falls through to the
 *   `!tabId` silent return in `run`, NOT to the active editor).
 * - a composer-scheme (`ide-chat`) URI arg contributes its tab id from the
 *   path, fail-closed: a path that fails the tab-id translation (empty, `.`,
 *   `..`, nested) resolves to undefined and does NOT fall through to the
 *   active editor. A non-composer scheme DOES fall through (binary-identical).
 * - otherwise the ACTIVE editor, when it is a chat editor, contributes its id.
 *
 * HONEST-DIVERGENCE (fork mapping, no global composer registry in core):
 * the binary reads `composerDataService.selectedComposerId` / resolves the
 * handle via `getHandleIfLoaded`. The fork has no global composer registry
 * in core, so the SELECTED composer is the active composer chat editor and
 * a LOADED handle is an OPEN chat editor input (see
 * `findOpenComposerChatInput`). Identification is by `ide-chat` URI scheme
 * (the extension's `CHAT_EDITOR_SCHEME`) rather than an `instanceof`
 * `ComposerChatEditorInput` check — that class does not exist in this
 * branch.
 */
export function resolveRenameChatTabId(editorService: IEditorService, arg: unknown): string | undefined {
	if (typeof arg === 'string') {
		return arg;
	}
	if (URI.isUri(arg) && arg.scheme === COMPOSER_CHAT_EDITOR_SCHEME) {
		return composerChatTabIdFromChatUri(arg);
	}
	return chatTabIdFromEditorInput(editorService.activeEditor);
}

/** Open chat editor input for a chat tab id (undefined when not open). */
export function findOpenComposerChatInput(editorService: IEditorService, tabId: string): EditorInput | undefined {
	for (const editor of editorService.editors) {
		if (chatTabIdFromEditorInput(editor) === tabId) {
			return editor;
		}
	}
	return undefined;
}

// DEV-GAPS-56 (`agent-resume-chat`): binary-verbatim
// `composer.resumeCurrentChat` ("Resume Current Chat",
// workbench.glass.main.js 3.25.9, class CAb @39846912 — REA spec
// `rea-spec-accept-resume-2026-10-20.md`):
//   super({id:p8a,title:{value:"Resume Current Chat",original:"Resume Current Chat"}})
// — p8a="composer.resumeCurrentChat" @15886874. The binary registration carries NO
// f1, NO keybinding, NO precondition, NO menu, NO category. The registration
// helper Ht (@2274492) gates palette/menu registration on truthy f1
// (`{f1:i,...}=n.desc; if(i&&(...))`), so this command is PALETTE-HIDDEN —
// invocable programmatically only (executeCommand with args). CORRECTION vs
// the run-34 audit entry: the audit's `f1:!0` claim is BÁC BỎ by binary
// evidence (the class literal passes {id,title} ONLY; an omitted f1 is falsy,
// it does NOT default to palette-visible). The fork mirrors this with an
// explicit f1:false — the fork's registerAction2 also gates the
// CommandPalette entry on truthy f1.
// Run (binary, verbatim):
//   async run(t,e){const n=t.get(L0/*composerChatService @19930603*/),
//     i=t.get(no/*composerDataService @17974762*/),
//     r=t.get($r/*notificationService @2462592*/),s=i.selectedComposerId;
//     if(s){const o=i.getHandleIfLoaded(s);
//       if(!o){r.warn("Cannot resume: composer not loaded");return}
//       try{n.resumeChat(o,{isAutoResume:e?.isAutoResume===!0})}
//       catch(a){r.warn(a instanceof Error?a.message:"Cannot resume")}}}
// Fork mapping (binary services -> fork analogs):
// - L0 (ComposerChatService.resumeChat) -> the ide-agent extension runtime
//   `ide.resumeCurrentChat` (chat-data owner; its ComposerDataService.resumeChat
//   is the chatService port — it throws verbatim "Cannot resume: chat not
//   found" when the composer holds no conversation data, per the binary's
//   resumeChat guard @20423725).
// - no (global ComposerDataService: selectedComposerId/getHandleIfLoaded) ->
//   the fork has no global composer registry in core: the SELECTED composer
//   is the active composer chat editor (resolveRenameChatTabId — the same
//   selection mapping as ComposerRenameChatAction), and a LOADED handle is an
//   OPEN chat editor input (findOpenComposerChatInput — the same mapping the
//   composer.acceptPlan resolver documents for getHandleIfLoaded).
// - $r (notificationService) -> INotificationService.
// - No selection -> SILENT return (no warning), exactly like the binary.
// UNKNOWN (binary body truncated @20423725): the downstream effect of
// isAutoResume inside resumeChat — the fork passes the flag through to the
// runtime verbatim and invents no behavior for it.
export class ComposerResumeCurrentChatAction extends Action2 {
	static readonly ID = 'composer.resumeCurrentChat';
	/** Runtime half (chat-data owner) in the ide-agent extension. */
	static readonly RUNTIME_COMMAND = 'ide.resumeCurrentChat';
	constructor() {
		super({
			id: ComposerResumeCurrentChatAction.ID,
			title: localize2('composer.resumeCurrentChat', 'Resume Current Chat'),
			// Palette-hidden like the binary: no f1, no keybinding (see the
			// evidence note above).
			f1: false,
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const notificationService = accessor.get(INotificationService);
		const commandService = accessor.get(ICommandService);

		// Binary: `s = i.selectedComposerId; if (s) { ... }` — no selection
		// returns SILENTLY (no warning). The fork's "selected composer" is
		// the active chat editor; args play no role in selection (the
		// binary's `e` arg only carries `isAutoResume`).
		const tabId = resolveRenameChatTabId(editorService, undefined);
		if (!tabId) {
			return;
		}
		// Binary: `o = i.getHandleIfLoaded(s); if (!o) { warn(...); return }`.
		if (!findOpenComposerChatInput(editorService, tabId)) {
			notificationService.warn('Cannot resume: composer not loaded');
			return;
		}
		// Binary: `n.resumeChat(o, { isAutoResume: e?.isAutoResume === true })`
		// with `catch(a){ r.warn(a instanceof Error ? a.message : "Cannot resume") }`.
		const opts = args[0] as { isAutoResume?: unknown } | undefined;
		try {
			await commandService.executeCommand(
				ComposerResumeCurrentChatAction.RUNTIME_COMMAND,
				{ isAutoResume: opts?.isAutoResume === true });
		} catch (err) {
			notificationService.warn(err instanceof Error ? err.message : 'Cannot resume');
		}
	}
}
