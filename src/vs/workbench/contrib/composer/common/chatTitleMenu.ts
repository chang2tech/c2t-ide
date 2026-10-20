/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Chat editor tab title-menu inventory — Cursor 3.25.9 parity
 * (WORKER-GAPS-66A, feature_id `chat-tab-title-menu-inventory`).
 *
 * Pure data + pure arg resolvers: NO vscode imports, erasable TS only
 * (node:test runs this under Node's built-in type stripping — no namespaces,
 * no enums, no parameter properties).
 *
 * BINARY EVIDENCE (all real, static extraction, verified verbatim):
 *  1. workbench.desktop.main.js @29968468 — `var Opa=[...]`:
 *     - `{command:{id:fWt,title:"Export Transcript",icon:Oe.saveAll},group:"1_chatTools",order:1,when:Ru.Scheme.isEqualTo(ft.composer)}`
 *     - `{command:{id:vWt,title:"Share Transcript",icon:Oe.link},group:"1_chatTools",order:2,when:he.and(Ru.Scheme.isEqualTo(ft.composer),MQt)}`
 *     - `{command:{id:NYs,title:"Copy Request ID"},group:"1_chatTools",order:3,when:Ru.Scheme.isEqualTo(ft.composer)}`
 *     - `{command:{id:Ugm.ID,title:"Give Feedback"},group:"1_chatTools",order:4,when:Ru.Scheme.isEqualTo(ft.composer)}`
 *     - `{command:{id:sfm.ID,title:"Agent Settings"},group:"2_moreActions",order:2,when:Ru.Scheme.isEqualTo(ft.composer)}`
 *     - `Fpa=he.and(Ru.Scheme.isEqualTo(ft.composer),he.or(wg,sy))` → push
 *       `{id:Lpa,title:"Open in Prompt Quality"},group:"2_moreActions",order:99,when:Fpa`
 *       and `{id:IWt,title:"Export Chat (Developer)"},group:"2_moreActions",order:100,when:Fpa`
 *     - `for(const e of Opa)Bn.appendMenuItem(Le.EditorTitleContext,e),Bn.appendMenuItem(Le.EditorTitle,e)`
 *     - then EditorTitleContext-only:
 *       `{command:{id:aHi,title:"Rename Chat",icon:Oe.edit,precondition:VXi},group:"1_chatTools",order:5}`
 *       `{command:{id:CWt,title:"Fork Chat",icon:Oe.clone},group:"1_chatTools",order:6,when:he.and(Ru.Scheme.isEqualTo(ft.composer),jXi.toNegated())}`
 *       `{command:{id:U8n,title:"Move into New Window"},group:"5z_new_window",order:10}`
 *  2. Alias resolutions (desktop): fWt="composer.exportChatAsMd" (@14001529),
 *     vWt="composer.shareChat" (@14001559), NYs="composer.copyRequestIdFromEditor"
 *     (@14001680), CWt="composer.duplicateChat" (@14003077), aHi="composer.renameChat"
 *     (@14003106), Lpa="composer.openPromptQuality" (@29933330, workbench.desktop.main.js — `var Lpa=` declaration @29933326),
 *     IWt="developer.exportChat" (@14004704), U8n="workbench.action.moveEditorToNewWindow"
 *     (@21485753), Bgm.ID=lLn="composer.reportFeedback" (@29935607), rfm.ID=IBu="chat.openCursorSettings"
 *     (@29958167).
 *  3. Context keys (desktop): MQt=new Mt("isSharedChatsEnabled",!1) (@24040852),
 *     VXi=new Mt("composerEditorTabCanRename",!1) (@16723081),
 *     jXi=new Mt("composerEditorTabIsCloudAgent",!1) (@16723034),
 *     wg=new Mt("isDevelopment",!1) (@2631047), sy=new Mt("isDevUser",!1) (@2631080).
 *  4. glass bundle @39879475 — `var BGc=[...]` — IDENTICAL structure (uEn=exportChatAsMd,
 *     JGt=shareChat, h8a=copyRequestIdFromEditor, sXr=renameChat, vEn=duplicateChat,
 *     OGc=openPromptQuality, yEn=developer.exportChat, kDi=moveEditorToNewWindow,
 *     wAb.ID=reportFeedback, WAb.ID=openCursorSettings, UGc=ch||Sm gate).
 *  5. Stock "Move into New Window" (@27384416): `group:"7_new_window",order:10,
 *     when:he.and(Ru.Scheme.isEqualTo(ft.composer).negate(),Ru.Scheme.isEqualTo("cursor-browser").negate())`
 *     — Cursor EXCLUDES its own chat scheme (and browser scheme) from the stock
 *     entry so the explicit `5z_new_window` contribution is the only one shown
 *     on chat tabs.
 *  6. Action descriptors (glass/desktop):
 *     - composer.shareChat: title "Share Transcript", f1:!1, icon yt.link,
 *       precondition isSharedChatsEnabled (@39835596, class vAb).
 *     - composer.copyRequestIdFromEditor: title "Copy Request ID", f1:!1 (@29931829,
 *       class l2S) — run: `t?.scheme===ft.composer?{kind:"composerId",composerId:t.path}:{kind:"editor"}`,
 *       then delegates to composer.copyRequestId.
 *     - composer.copyRequestId: title "Copy Request ID", f1:!1 (@29931829, class a2S) —
 *       run: `clipboard.writeText(Fgm(... )??"No request ID found")` where Fgm
 *       returns `composerData.latestChatGenerationUUID ?? createdFromBackgroundAgent.bcId`.
 *     - composer.reportFeedback: f1:!1 (@29935607, class Bgm/Jeg).
 *     - chat.openCursorSettings: f1:!1 (@29958167, class rfm/ntg) —
 *       run: `executeCommand("aiSettings.action.open","chat","cursor-settings-chat-composer")`.
 *     - composer.duplicateChat: title "Fork Chat", category Cursor, f1:!0 (@29915583, class xgm).
 *     - composer.renameChat: category Cursor, f1:!1 (@29918155-ish, class Agm).
 *
 * HONEST-DIVERGENCES in the fork mapping:
 *  - `composerEditorTabCanRename` in the binary is bound to the group's
 *    context-menu-scoped keys from loaded composer data
 *    (`a = isCloudAgent || hasConversationHeaders`); the fork has no composer
 *    data service in core, so the fork binds it true when the ACTIVE editor
 *    is a chat tab (ComposerWorkbenchContribution).
 *  - `composer.copyRequestId`'s binary resolution (`d2S`) distinguishes pane /
 *    editor locations across Cursor's composer service; the fork has no pane
 *    surface and no composer service, so editor/pane kinds both resolve to the
 *    active chat tab, and the request id is fetched from the ide-agent
 *    extension (chat-data owner) via the `ide.getChatRequestId` provider
 *    command — same provider-command seam as `composer.exportChatAsMd`
 *    (`ide.getChatExportTranscript`).
 *  - `sy` ("isDevUser") is Cursor-internal and has no fork analog; the Open in
 *    Prompt Quality gate uses `isDevelopment` only (the `wg` conjunct).
 *  - `chat.openCursorSettings` in the binary opens Cursor's AI Settings page
 *    (`aiSettings.action.open`); the fork delegates to the existing
 *    `ide.openAgentSettings` extension command.
 *  - `developer.exportChat` (order 100, dev-gated) is DELIBERATELY SKIPPED
 *    per audit-fix-queue triage (dev-gated infra).
 */

/** Where in the title chrome the item appears (binary: Opa -> both, the three trailing -> context only). */
export type ChatTitleMenuTarget = 'EditorTitleContext' | 'EditorTitle';

/**
 * Menu gate semantics (mapped to real context-key expressions in browser code).
 * The scheme conjunct is `resourceScheme == <chat-editor scheme>`, except
 * `'preconditionOnly'` which maps to NO `when` at all (binary rename item has
 * only a command precondition; `composerEditorTabCanRename` is only true when
 * the active editor is a chat tab).
 */
export type ChatTitleMenuGate =
	| 'scheme'
	| 'schemeAndSharedChats'
	| 'schemeAndCanRename'
	| 'schemeAndNotCloudAgent'
	| 'schemeAndInternal'
	| 'preconditionOnly';

export interface ChatTitleMenuItem {
	readonly commandId: string;
	readonly title: string;
	/** Codicon name (binary `icon` field: saveAll/link/edit/clone). */
	readonly iconCodicon?: string;
	/** Verbatim menu group from the binary. */
	readonly group: '1_chatTools' | '2_moreActions' | '5z_new_window';
	/** Verbatim menu order from the binary. */
	readonly order: number;
	readonly targets: ReadonlyArray<ChatTitleMenuTarget>;
	readonly gate: ChatTitleMenuGate;
	/** Verbatim precondition on the menu item (binary Rename Chat). */
	readonly precondition?: string;
	/** false = item exists in Cursor but is deliberately not wired in the fork. */
	readonly includeInFork: boolean;
}

/**
 * The COMPLETE Cursor 3.25.9 chat-tab title menu (Opa/BGc arrays + the three
 * EditorTitleContext-only appends), in binary order. Fork consumers skip
 * entries with `includeInFork === false`.
 */
export const CHAT_TAB_TITLE_MENU_ITEMS: ReadonlyArray<ChatTitleMenuItem> = [
	{ commandId: 'composer.exportChatAsMd', title: 'Export Transcript', iconCodicon: 'saveAll', group: '1_chatTools', order: 1, targets: ['EditorTitleContext', 'EditorTitle'], gate: 'scheme', includeInFork: true },
	{ commandId: 'composer.shareChat', title: 'Share Transcript', iconCodicon: 'link', group: '1_chatTools', order: 2, targets: ['EditorTitleContext', 'EditorTitle'], gate: 'schemeAndSharedChats', includeInFork: true },
	{ commandId: 'composer.copyRequestIdFromEditor', title: 'Copy Request ID', group: '1_chatTools', order: 3, targets: ['EditorTitleContext', 'EditorTitle'], gate: 'scheme', includeInFork: true },
	{ commandId: 'composer.reportFeedback', title: 'Give Feedback', group: '1_chatTools', order: 4, targets: ['EditorTitleContext', 'EditorTitle'], gate: 'scheme', includeInFork: true },
	{ commandId: 'chat.openCursorSettings', title: 'Agent Settings', group: '2_moreActions', order: 2, targets: ['EditorTitleContext', 'EditorTitle'], gate: 'scheme', includeInFork: true },
	{ commandId: 'composer.openPromptQuality', title: 'Open in Prompt Quality', group: '2_moreActions', order: 99, targets: ['EditorTitleContext', 'EditorTitle'], gate: 'schemeAndInternal', includeInFork: true },
	{ commandId: 'developer.exportChat', title: 'Export Chat (Developer)', group: '2_moreActions', order: 100, targets: ['EditorTitleContext', 'EditorTitle'], gate: 'schemeAndInternal', includeInFork: false },
	{ commandId: 'composer.renameChat', title: 'Rename Chat', iconCodicon: 'edit', group: '1_chatTools', order: 5, targets: ['EditorTitleContext'], gate: 'preconditionOnly', precondition: 'composerEditorTabCanRename', includeInFork: true },
	{ commandId: 'composer.duplicateChat', title: 'Fork Chat', iconCodicon: 'clone', group: '1_chatTools', order: 6, targets: ['EditorTitleContext'], gate: 'schemeAndNotCloudAgent', includeInFork: true },
	{ commandId: 'workbench.action.moveEditorToNewWindow', title: 'Move into New Window', group: '5z_new_window', order: 10, targets: ['EditorTitleContext'], gate: 'scheme', includeInFork: true },
];

/**
 * Fork-only additions already shipped in the title menu (NOT in Cursor's Opa —
 * kept at non-colliding orders so the binary orders 1-6 stay verbatim).
 */
export const CHAT_TITLE_MENU_FORK_EXTRA_GATES = ['scheme', 'schemeAndWorktree'] as const;

/** Binary-verbatim clipboard fallback (desktop @29931829, class a2S: `n.writeText(o??"No request ID found")`). */
export const NO_REQUEST_ID_FALLBACK = 'No request ID found';

/** Duck-typed URI shape the resolvers consume (avoids importing URI into common). */
export interface ChatTabUriLike {
	readonly scheme: string;
	readonly path: string;
}

function asUriLike(arg: unknown): ChatTabUriLike | undefined {
	if (arg && typeof arg === 'object') {
		const scheme = (arg as { scheme?: unknown }).scheme;
		const path = (arg as { path?: unknown }).path;
		if (typeof scheme === 'string' && typeof path === 'string') {
			return { scheme, path };
		}
	}
	return undefined;
}

export interface CopyRequestIdResolution {
	readonly chatScheme: string;
	/** Tab id from a URI path; undefined when the path does not translate. */
	readonly tabIdFromPath: (path: string) => string | undefined;
}

/**
 * Mirrors binary `l2S` (`composer.copyRequestIdFromEditor` run, desktop):
 * `t?.scheme===ft.composer ? {kind:"composerId",composerId:t.path} : {kind:"editor"}`.
 * The fork translates the path to a tab id (falling back to the verbatim path
 * like `resolveRenameChatTabId` does) and delegates to `composer.copyRequestId`.
 */
export function resolveCopyRequestIdFromEditorTarget(
	arg: unknown,
	opts: CopyRequestIdResolution,
): { kind: 'composerId'; composerId: string } | { kind: 'editor' } {
	const uri = asUriLike(arg);
	if (uri && uri.scheme === opts.chatScheme) {
		return { kind: 'composerId', composerId: opts.tabIdFromPath(uri.path) ?? uri.path };
	}
	return { kind: 'editor' };
}

export type CopyRequestIdTarget =
	| { kind: 'composerId'; composerId: string }
	| { kind: 'editor' }
	| { kind: 'pane' };

/**
 * Mirrors binary `u2S` (desktop): string -> {kind:"composerId"}; chat-scheme URI ->
 * {kind:"composerId"} with the path verbatim; foreign URI -> undefined (falls
 * through); {kind} structs pass through for the base command's resolution.
 */
export function resolveCopyRequestIdTarget(
	arg: unknown,
	opts: CopyRequestIdResolution,
): CopyRequestIdTarget | undefined {
	if (typeof arg === 'string') {
		return { kind: 'composerId', composerId: arg };
	}
	const uri = asUriLike(arg);
	if (uri) {
		if (uri.scheme === opts.chatScheme) {
			return { kind: 'composerId', composerId: opts.tabIdFromPath(uri.path) ?? uri.path };
		}
		return undefined;
	}
	if (arg && typeof arg === 'object') {
		const kind = (arg as { kind?: unknown }).kind;
		if (kind === 'composerId' || kind === 'editor' || kind === 'pane') {
			return arg as CopyRequestIdTarget;
		}
	}
	return undefined;
}

/**
 * Fork mapping of binary `d2S`'s composer-id selection. Cursor resolves
 * pane/editor locations across its composer service; the fork has neither a
 * pane surface nor a core composer service, so both editor and pane kinds
 * resolve to the active chat tab's id.
 */
export function resolveCopyRequestIdTabId(
	target: CopyRequestIdTarget | undefined,
	activeChatTabId: string | undefined,
): string | undefined {
	if (!target) {
		return undefined;
	}
	if (target.kind === 'composerId') {
		return target.composerId;
	}
	return activeChatTabId;
}
