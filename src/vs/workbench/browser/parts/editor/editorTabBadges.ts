/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { EditorInput } from '../../../common/editor/editorInput.js';

/**
 * IDE-CODE (DEV-GAPS-12): a badge drawn on a native editor tab.
 *
 * Cursor parity — cursor.com/changelog/0-48-x: "When a tab is awaiting your
 * input, you'll see an orange dot on that tab." Cursor draws this on its own
 * native tab DOM. VS Code's extension API exposes no per-tab
 * badge/decoration API (`TabInputCustom` has no badge, `tab.dirty` is
 * read-only, `FileDecorationProvider` does not render on editor tabs), so
 * this fork adds a workbench-core channel instead of faking it.
 *
 * Today the only badge kind is `'awaiting-input'` (chat tab waiting on the
 * user: approval request or clarifying question). The interface is a small
 * union so future badges (spinner, count) can be added without changing the
 * service contract.
 *
 * State flow (extension -> core): the `ide-agent` extension owns the
 * awaiting-input state and pushes diffs across the extension-host boundary
 * via the `ide.chat.setEditorTabBadge` bridge command below (see
 * `ChatTabBadgeSync` in extensions/ide-agent/src/services/chatTabBadgeSync.ts).
 * The tab controls (`MultiEditorTabsControl`, `SingleEditorTabsControl`)
 * read the badge in `redrawTab` and listen to `onDidChangeTabBadge` to
 * re-render just the affected tab; CSS shows the 6px dot.
 */

//#region Service

export interface IEditorTabBadge {
	readonly kind: 'awaiting-input';
}

/** Workbench-internal channel for per-tab badges (see file header). */
export interface IEditorTabBadgeService {
	readonly _serviceBrand: undefined;

	setTabBadge(editor: EditorInput, badge: IEditorTabBadge): void;
	clearTabBadge(editor: EditorInput): void;
	getTabBadge(editor: EditorInput): IEditorTabBadge | undefined;

	readonly onDidChangeTabBadge: Event<EditorInput>;
}

export const IEditorTabBadgeService = createDecorator<IEditorTabBadgeService>('editorTabBadgeService');

class EditorTabBadgeService extends Disposable implements IEditorTabBadgeService {

	declare readonly _serviceBrand: undefined;

	private readonly badges = new Map<EditorInput, IEditorTabBadge>();

	private readonly _onDidChangeTabBadge = this._register(new Emitter<EditorInput>());
	readonly onDidChangeTabBadge: Event<EditorInput> = this._onDidChangeTabBadge.event;

	setTabBadge(editor: EditorInput, badge: IEditorTabBadge): void {
		if (this.badges.get(editor)?.kind === badge.kind) {
			return; // already showing this badge — no re-render
		}
		this.badges.set(editor, badge);
		// Never keep a stale entry for a disposed input. The once-listener
		// removes itself when it fires, so this cannot accumulate.
		Event.once(editor.onWillDispose)(() => {
			if (this.badges.get(editor)?.kind === badge.kind) {
				this.badges.delete(editor);
			}
		});
		this._onDidChangeTabBadge.fire(editor);
	}

	clearTabBadge(editor: EditorInput): void {
		if (this.badges.delete(editor)) {
			this._onDidChangeTabBadge.fire(editor);
		}
	}

	getTabBadge(editor: EditorInput): IEditorTabBadge | undefined {
		return this.badges.get(editor);
	}
}

registerSingleton(IEditorTabBadgeService, EditorTabBadgeService, InstantiationType.Delayed);

//#endregion

//#region ide-chat tab-id lookup

/**
 * Document URI scheme of the ide-agent chat editor tabs (`ide-chat:/<tabId>`).
 * Must stay in sync with `CHAT_EDITOR_SCHEME` in
 * `extensions/ide-agent/src/services/chatEditorProvider.ts`.
 */
export const IDE_CHAT_EDITOR_SCHEME = 'ide-chat';

/**
 * Fail-closed validation for a tab id arriving over the command boundary.
 * Mirrors the extension-side `tabIdFromUri` (`ide-chat:/../../..` and friends
 * must never match a real tab).
 * Exported for unit tests (see editorTabBadges.test.ts).
 */
export function isValidIdeChatTabId(tabId: unknown): tabId is string {
	return typeof tabId === 'string'
		&& tabId.length > 0
		&& !tabId.includes('/')
		&& !tabId.includes('..')
		&& tabId !== '.';
}

/** Whether a document URI is exactly `ide-chat:/<tabId>` for this tab id. */
function isIdeChatUriForTabId(resource: URI, tabId: string): boolean {
	return resource.scheme === IDE_CHAT_EDITOR_SCHEME
		&& resource.path === `/${tabId}`;
}

/** Find the open editor input for a chat tab id across all editor groups. */
export function findChatEditorInput(groupsService: IEditorGroupsService, tabId: string): EditorInput | undefined {
	for (const group of groupsService.groups) {
		for (let index = 0; index < group.count; index++) {
			const editor = group.getEditorByIndex(index);
			const resource = editor?.resource;
			if (resource && isIdeChatUriForTabId(resource, tabId)) {
				return editor;
			}
		}
	}
	return undefined;
}

//#endregion

//#region Extension bridge command

/**
 * Bridge command the ide-agent extension host calls to mirror a chat tab's
 * awaiting-input state onto its native editor tab. Args are JSON-safe for
 * the extension-host RPC boundary — same bridge pattern as
 * `composer.terminalPromptBar.setVisible`.
 */
export const IDE_CHAT_SET_TAB_BADGE_COMMAND_ID = 'ide.chat.setEditorTabBadge';

export interface IChatTabBadgeCommandArgs {
	tabId?: string;
	awaitingInput?: boolean;
}

CommandsRegistry.registerCommand(IDE_CHAT_SET_TAB_BADGE_COMMAND_ID, (accessor: ServicesAccessor, args: IChatTabBadgeCommandArgs) => {
	const tabId = isValidIdeChatTabId(args?.tabId) ? args.tabId : undefined;
	if (!tabId) {
		accessor.get(ILogService).debug('[ideChatTabBadge] ignoring invalid tab id');
		return;
	}
	const editor = findChatEditorInput(accessor.get(IEditorGroupsService), tabId);
	if (!editor) {
		// The chat tab is not open as an editor (e.g. closed already) —
		// nothing to badge. Not an error.
		accessor.get(ILogService).debug(`[ideChatTabBadge] no open editor for tab ${tabId}`);
		return;
	}
	if (args?.awaitingInput === true) {
		accessor.get(IEditorTabBadgeService).setTabBadge(editor, { kind: 'awaiting-input' });
	} else {
		accessor.get(IEditorTabBadgeService).clearTabBadge(editor);
	}
});

//#endregion
