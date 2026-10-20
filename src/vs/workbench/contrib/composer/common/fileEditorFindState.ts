/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// GAPS-158 (`editor-find-in-file`, 2026-10-20): pure spec + state store for
// Cursor's pane-level "Find in File" routing command and its ONE
// Cursor-specific service — the per-agent shared find-state seeder. The find
// engine/widget are stock Monaco in BOTH Cursor and this fork (handler `g2x`
// literally falls back to `actions.find` / the stock FindController.start());
// this module ports ONLY the Cursor layer on top. Kept free of vscode
// imports so the semantics are unit-testable standalone (see the GAPS-158
// pure tests); `browser/fileEditorFindStateService.ts` binds the store to
// real editors/controllers and `browser/fileEditorFindActions.ts` builds
// the real Action2 + start options from the same shapes.
//
// Binary spec (Cursor 3.25.9, workbench.glass.main.js, verified first-hand
// by GAPS-158; full extracts in docs/rea/work-notes-gaps158.md):
//   id decl: WJg="showFileEditorFind" @25980772 — bare id, NO `glass.*`
//     alias, NO hide/next/previous siblings.
//   registration @45498568: title "Find in File", icon "search",
//     glassCategory "View", keywords ["find","search","file","editor",
//     "buffer"], f1:{when:glassActiveTabKind==File},
//     scope AGENT_WORKSPACE, keybindingCategory FILE,
//     keybinding {weight:gp+6=256, primary:CtrlCmd|KeyF,
//     when:xan([Ot.File])} (editor panel focused, transcript/prompt/
//     chat-find-input NOT focused, active tab kind File),
//     run: t=>{g2x(t)}.
//   handler g2x @45460552: routing + seeding wrapper around the STOCK find
//     controller — see runShowFileEditorFind() in
//     browser/fileEditorFindActions.ts for the step-by-step port.
//   service: FZb=Qn("glassFileEditorFindStateService") @45459332, class Blu,
//     registerSingleton Delayed (Cn(FZb,Blu,1)), injected dependency
//     `glassActiveAgentService` (getActiveAgentId()).

/** Command id (binary-verbatim, bare/unprefixed). */
export const SHOW_FILE_EDITOR_FIND_ID = 'showFileEditorFind';

/** Command title (binary-verbatim). */
export const SHOW_FILE_EDITOR_FIND_TITLE = 'Find in File';

/** Binary keybinding weight: gp+6 with gp=250 (@45469675 region) = 256. */
export const FILE_EDITOR_FIND_KEYBINDING_WEIGHT = 256;

/** DI name of the binary service (Qn("glassFileEditorFindStateService")). */
export const FILE_EDITOR_FIND_STATE_SERVICE_ID = 'glassFileEditorFindStateService';

/**
 * Binary fallback agent key: `m2x=""` @45459332 — `_activeAgentKey()` is
 * `getActiveAgentId() ?? ""`, so with no active agent all state lands in
 * the empty-string bucket.
 */
export const DEFAULT_AGENT_KEY = '';

/**
 * The six fields Blu captures from a controller's FindReplaceState
 * (`_capture` @45460150 region) — field names verbatim; all optional
 * because `getSharedState()` returns `{}` for an agent with no bucket and
 * individual fields can be undefined in the start() seed spread.
 */
export interface FileEditorFindSharedState {
	readonly searchString?: string;
	readonly replaceString?: string;
	readonly isRegex?: boolean;
	readonly wholeWord?: boolean;
	readonly matchCase?: boolean;
	readonly preserveCase?: boolean;
}

/**
 * Shape of the stock FindReplaceStateChangedEvent as Blu reads it: boolean
 * flags naming which fields changed (fork findState.ts changeEvent has
 * exactly this shape).
 */
export interface FileEditorFindStateChangeFlags {
	readonly searchString?: boolean;
	readonly replaceString?: boolean;
	readonly isRegex?: boolean;
	readonly wholeWord?: boolean;
	readonly matchCase?: boolean;
	readonly preserveCase?: boolean;
}

/**
 * Blu's capture gate, verbatim: capture ONLY when the change event flags
 * at least one of the six tracked fields (searchString || replaceString ||
 * isRegex || wholeWord || matchCase || preserveCase). Reveal/scope/match
 * changes never capture.
 */
export function shouldCaptureFindStateChange(change: FileEditorFindStateChangeFlags): boolean {
	return !!(change.searchString || change.replaceString || change.isRegex
		|| change.wholeWord || change.matchCase || change.preserveCase);
}

/**
 * The pure core of Blu: a Map of shared find state keyed by the CURRENT
 * active agent key. The key is evaluated at capture time AND at read time
 * (never bound to an editor or to the key at track time) — switching
 * agents between capture and read changes which bucket is read, exactly
 * like the binary. In-memory only: the binary class has no storage
 * service, no serialization — state does not survive a restart.
 *
 * The active-agent key provider is injected (binary: Blu's constructor
 * param is `glassActiveAgentService`). Keying semantics:
 * `provider() ?? ""`.
 */
export class FileEditorFindStateStore {
	private readonly _sharedByAgent = new Map<string, FileEditorFindSharedState>();

	constructor(private readonly _getActiveAgentId: () => string | undefined) { }

	/** `_activeAgentKey()`: active agent id, falling back to `""`. */
	activeAgentKey(): string {
		return this._getActiveAgentId() ?? DEFAULT_AGENT_KEY;
	}

	/** `getSharedState()`: the active agent's bucket, or `{}` when none. */
	getSharedState(): FileEditorFindSharedState {
		return this._sharedByAgent.get(this.activeAgentKey()) ?? {};
	}

	/**
	 * `_capture(state)`: snapshot the six fields into the bucket of the
	 * agent active AT CAPTURE TIME.
	 */
	capture(state: Required<FileEditorFindSharedState>): void {
		this._sharedByAgent.set(this.activeAgentKey(), {
			searchString: state.searchString,
			replaceString: state.replaceString,
			isRegex: state.isRegex,
			wholeWord: state.wholeWord,
			matchCase: state.matchCase,
			preserveCase: state.preserveCase,
		});
	}
}

/**
 * NI @287561 — the binary's escape-regexp helper, regex verbatim:
 * `t.replace(/[\\{\\}\\*\\+\\?\\|\\^\\$\\.\\[\\]\\(\\)]/g,"\\$&")`.
 * (Char-for-char identical to the fork's base escapeRegExpCharacters;
 * duplicated here so this module stays import-free and testable.)
 */
export function escapeRegExpCharacters(value: string): string {
	return value.replace(/[\\{}*+?|^$.[\]()]/g, '\\$&');
}

/** Verbatim type of the editor `find.seedSearchStringFromSelection` option. */
export type FindSeedSearchStringFromSelectionSetting = 'never' | 'always' | 'selection';

/**
 * g2x's seed search-string computation (@45460800 region), verbatim logic:
 *   u = shared searchString non-empty
 *   h = setting !== "never" ? "single" : "none"
 *   p = u ? true : setting === "selection"        (the g0i force flag)
 *   f = shared.isRegex ?? controllerState.isRegex (effective regex)
 *   g = h === "single" ? g0i(editor, "single", p) : null
 *   _ = g ? (f ? escapeRegExp(g) : g) : shared.searchString
 *
 * `getSelectionSearchString` is the g0i port (see
 * browser/fileEditorFindStateService.ts): it returns the selection text
 * for a non-empty selection, the word at cursor ONLY when the force flag
 * is false, else null. Note the consequence of `p`: when a shared string
 * exists, the word-at-cursor never overrides it, but a non-empty
 * selection still does.
 */
export function computeSeededSearchString(
	shared: FileEditorFindSharedState,
	controllerIsRegex: boolean,
	seedSetting: FindSeedSearchStringFromSelectionSetting,
	getSelectionSearchString: (force: boolean) => string | null,
): string | undefined {
	const hasSharedSearchString = (shared.searchString?.length ?? 0) > 0;
	const mode: 'single' | 'none' = seedSetting !== 'never' ? 'single' : 'none';
	const force = hasSharedSearchString ? true : seedSetting === 'selection';
	const effectiveIsRegex = shared.isRegex ?? controllerIsRegex;
	const selectionText = mode === 'single' ? getSelectionSearchString(force) : null;
	if (selectionText) {
		return effectiveIsRegex ? escapeRegExpCharacters(selectionText) : selectionText;
	}
	return shared.searchString;
}
