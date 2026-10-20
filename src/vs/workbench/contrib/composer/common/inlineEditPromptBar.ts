/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Cursor-parity Cmd+K prompt bar contract (common layer — no DOM here).
//
// REA EVIDENCE (Cursor 3.25.9 glass bundle — docs/rea/dig-continuous-inline-edit-2026-10-19.md):
//   - The prompt bar widget is a Monaco VIEW ZONE (class `PromptBarViewZone`):
//     NOT an overlay widget, NOT a webview, NOT a quick-input box.
//   - Position: `afterLineNumber = startLineNumber - 1` → the zone sits
//     directly ABOVE the first line of the edit range; `ordinal = 1e5`;
//     `showInHiddenAreas: true`; `showEvenWhenNotInViewport: true`;
//     `afterColumnAffinity: 1` (= PositionAffinity.Right).
//   - Height: `Math.max(62, scrollHeight + 6)` px; if the container exceeds
//     5000px the bundle warns and clamps to maxHeight 5000px + scroll.
//   - Three modes from `lmb()`: edit_selection / quick_question / send_to_chat,
//     with the placeholders and shortcuts quoted verbatim below.
//   - Submit behaviour: `send_to_chat` → `composer.sendToAgent`; `quick_question`
//     → submit with `chatMode=true`; Alt+Enter outside quick_question switches
//     the mode to quick_question (no submit); Enter otherwise submits.
//   - While the bar is open the selection carries `inline-diff-pending`
//     decorations, and `editor.action.inlineSuggest.hide` runs on open.
//
// HONEST DEVIATIONS (documented, not silent):
//   H1 RESOLVED (WORKER-P3-FIXES 2026-10-20): `showEvenWhenNotInViewport`
//      was patched into this fork's core `IViewZone`
//      (vs/editor/browser/editorBrowser.ts) and is set on the prompt-bar
//      zone, matching the binary. Remaining gap: the view-zone renderer
//      (vs/editor/browser/viewParts/viewZones/viewZones.ts) does not read
//      the flag yet, so stock viewport culling still applies once the anchor
//      scrolls out of view — renderer wiring is a follow-up.
//   H2 IMPLEMENTED 2026-10-20 (WORKER W60C, queue feature_id
//      `cmdk-next-prompt-bar`): `aipopup.action.nextPromptBar` + its target
//      `aipopup.action.focusEdit` are registered in
//      browser/composerActions.ts and the cycling algorithm below
//      (`selectNextPromptBarId`) ports the binary's run body verbatim
//      (workbench.glass.main.js 3.25.9, class Yfy). Remaining divergence:
//      the binary's prompt-bar service can hold MULTIPLE bars per editor,
//      while our inline-edit sessions are single-instance per editor, so a
//      bar's editorId is always its live editor's id and cycling crosses
//      editors only. Focus plumbing: the binary receives the current bar id
//      as the command argument `n`; the fork additionally derives it from
//      DOM focus (`getFocusedPromptBarId`) when no argument is passed
//      (e.g. palette invocation from inside a bar).
//   H3 IMPLEMENTED 2026-10-20 (DEV-GAPS-68, queue feature_id
//      `cmdk-insert-edit-selection`): `aipopup.action.insertEditSelection`
//      (class Xfy, 3.25.9 @40742061) + shared builders below
//      (`createPromptBarDataSelection` = Mfh port @4286500,
//      `dedentPromptBarSelectionText` = myn port @4285903,
//      `selectNewestPromptBarIdForUri` = StartEditPrompt URI routing), the
//      StartEditPrompt "bar already open for this URI" branch (append on
//      non-empty selection, focus otherwise), and submit-time forwarding of
//      the bar's selections into the edit/question prompts. Remaining
//      divergence: the binary renders data selections as React chips in
//      the bar's context tray (`_onDataPropertyChanged` re-render); the
//      fork's native bar has no chip tray yet, so appended selections are
//      stored on the bar and forwarded into the request on submit without
//      a visible chip. `send_to_chat` mode does not forward selections
//      (the fork's escalate path is a plain-text chat prefill).

import { isMacintosh } from '../../../../base/common/platform.js';
import { Range } from '../../../../editor/common/core/range.js';
import { URI } from '../../../../base/common/uri.js';
import type { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

/**
 * The three prompt-bar modes, verbatim ids from the binary (`lmb()` menu).
 */
export type PromptBarMode = 'edit_selection' | 'quick_question' | 'send_to_chat';

export interface IPromptBarModeDescriptor {
	readonly id: PromptBarMode;
	/** Verbatim label from the binary. */
	readonly label: string;
	/** Verbatim shortcut glyph ('' when the bundle was truncated for this entry). */
	readonly shortcut: string;
}

/**
 * Mode switcher entries — labels/shortcuts verbatim from the binary:
 *   {id:"edit_selection", label:"Edit Selection", shortcut:"⏎"} (\u23CE)
 *   {id:"quick_question", label:"Quick Question", shortcut:"⌥⏎"} (\u2325\u23CE, mac)
 *   {id:"send_to_chat", label:"Send to Chat", ...} (shortcut truncated in bundle)
 */
export const PROMPT_BAR_MODES: readonly IPromptBarModeDescriptor[] = [
	{ id: 'edit_selection', label: 'Edit Selection', shortcut: '\u23CE' },
	{ id: 'quick_question', label: 'Quick Question', shortcut: isMacintosh ? '\u2325\u23CE' : 'Alt+\u23CE' },
	{ id: 'send_to_chat', label: 'Send to Chat', shortcut: '' },
];

/**
 * Placeholders verbatim from the binary (`CyE` map + follow-up getter,
 * glass @25114763):
 *   edit_selection → "Edit selected code"
 *   quick_question → "Ask quick question"
 *   send_to_chat   → "Send to chat"
 *   hasFollowup    → "Add a follow-up"
 */
export const PROMPT_BAR_PLACEHOLDERS: Readonly<Record<PromptBarMode, string>> = {
	edit_selection: 'Edit selected code',
	quick_question: 'Ask quick question',
	send_to_chat: 'Send to chat',
};
export const PROMPT_BAR_FOLLOWUP_PLACEHOLDER = 'Add a follow-up';

/** Binary-verified view-zone parameters. */
export const PROMPT_BAR_ZONE_ORDINAL = 1e5;
export const PROMPT_BAR_MIN_HEIGHT_PX = 62;
export const PROMPT_BAR_MAX_HEIGHT_PX = 5000;

/** A model entry for the in-bar model picker ("Open model toggle"). */
export interface IPromptBarModelRef {
	readonly id: string;
	readonly providerID: string;
	readonly variant?: string;
	readonly name?: string;
}

export interface IInlineEditPromptBarOptions {
	/** First line of the edit/selection range; the zone goes above it. */
	readonly startLineNumber: number;
	/** The edit/selection range (receives the `inline-diff-pending` decoration). */
	readonly targetRange: Range;
	readonly previous?: string;
	readonly followUp: boolean;
}

export interface IInlineEditPromptBarResult {
	readonly mode: PromptBarMode;
	readonly text: string;
	/** undefined = "Auto" (engine default). Applied to the turn by the caller. */
	readonly model?: IPromptBarModelRef;
	/**
	 * Selections appended via `aipopup.action.insertEditSelection` while the
	 * bar was open (Cursor's `cmdKStateService.data.selections`; the binary
	 * appends the Mfh() item and includes the bar's selections in the outgoing
	 * Cmd+K request). Empty when nothing was appended.
	 */
	readonly selections: readonly IPromptBarDataSelection[];
}

/**
 * One open prompt bar as the binary's prompt-bar service sees it
 * (`getPromptBars()` entries carry at least `id` + `createdAt`; the
 * binary's entries also carry `editorId`/`uri`/`data.inputBoxDelegate`,
 * which in the fork stay internal to the browser implementation because a
 * bar is bound to its live editor instance).
 */
export interface IPromptBarRef {
	readonly id: string;
	/** Wall-clock creation time (binary: `createdAt`, sort key). */
	readonly createdAt: number;
	/**
	 * The bar's document uri, stringified (binary: prompt-bar entries carry
	 * `uri`). Optional in the fork because the `cmdk-next-prompt-bar` tests
	 * predate the field.
	 */
	readonly uri?: string;
}

/**
 * One "data selection" context item appended to a prompt bar, verbatim
 * shape of Cursor's `Mfh({model, inBoundsSelectionRange})` product
 * (workbench.glass.main.js 3.25.9 @4286500):
 *
 *   { text: "```" + languageId + "\n" + dedentedText + "\n```",
 *     rawText: model.getValueInRange(range),
 *     range: { selectionStartLineNumber, selectionStartColumn,
 *              positionLineNumber, positionColumn },
 *     uri: model.uri }
 *
 * The binary pushes these into the bar's `data.selections` and includes
 * them in the outgoing Cmd+K request.
 */
export interface IPromptBarDataSelection {
	readonly text: string;
	readonly rawText: string;
	readonly range: {
		readonly selectionStartLineNumber: number;
		readonly selectionStartColumn: number;
		readonly positionLineNumber: number;
		readonly positionColumn: number;
	};
	readonly uri: URI;
}

/**
 * Verbatim port of the binary's `myn(t)` dedent helper (3.25.9 @4285903):
 * finds the minimum indentation of the non-empty lines and strips it.
 */
export function dedentPromptBarSelectionText(value: string): string {
	const lines = value.split('\n');
	const nonEmpty = lines.filter((line) => line.trim().length > 0);
	const minIndent = Math.min(...nonEmpty.map((line) => line.search(/\S|$/)));
	return lines.map((line) => (line.trim().length === 0 ? line : line.slice(minIndent))).join('\n');
}

/**
 * Minimal text-model surface `createPromptBarDataSelection` needs —
 * structurally satisfied by the real `ITextModel`.
 */
export interface ITextModelSelectionSource {
	getValueInRange(range: Range): string;
	getLanguageIdAtPosition(lineNumber: number, column: number): string;
	readonly uri: URI;
}

/**
 * Verbatim port of the binary's `Mfh({model, inBoundsSelectionRange})`
 * (3.25.9 @4286500). Pure, unit-testable.
 */
export function createPromptBarDataSelection(
	model: ITextModelSelectionSource,
	selectionRange: Range,
): IPromptBarDataSelection {
	const rawText = model.getValueInRange(selectionRange);
	const text = `\`\`\`${model.getLanguageIdAtPosition(selectionRange.startLineNumber, selectionRange.startColumn)}\n${dedentPromptBarSelectionText(rawText)}\n\`\`\``;
	return {
		text,
		rawText,
		range: {
			selectionStartLineNumber: selectionRange.startLineNumber,
			selectionStartColumn: selectionRange.startColumn,
			positionLineNumber: selectionRange.endLineNumber,
			positionColumn: selectionRange.endColumn,
		},
		uri: model.uri,
	};
}

/**
 * Cursor's `StartEditPrompt.run` URI routing (3.25.9 @~40732800):
 *   const P = getPromptBars().filter(ce => ce.uri.toString() === A.toString());
 *   if (P.length > 0) { const ce = P[P.length-1]; ... }
 * i.e. the newest bar bound to the given document uri. Returns its id, or
 * `undefined` when no open bar is bound to that uri. HONEST-DIVERGENCE: the
 * binary takes the last entry in insertion order; the fork picks the max
 * `createdAt`, which coincides with insertion order for our service.
 */
export function selectNewestPromptBarIdForUri(
	bars: readonly IPromptBarRef[],
	uriString: string,
): string | undefined {
	let newest: IPromptBarRef | undefined;
	for (const bar of bars) {
		if (bar.uri !== uriString) {
			continue;
		}
		if (newest === undefined || bar.createdAt >= newest.createdAt) {
			newest = bar;
		}
	}
	return newest?.id;
}

/**
 * The cycling step of `aipopup.action.nextPromptBar` — a verbatim port of
 * the binary run body (Cursor 3.25.9 workbench.glass.main.js, class Yfy,
 * `Jqc.ID="aipopup.action.nextPromptBar"`, LABEL "Next Prompt Bar",
 * f1:!0, registered via `Ht(jcI)`; no keybinding registration for it
 * exists anywhere in the app — the command is palette-invoked):
 *
 *   const l = [...getPromptBars()].sort((u, d) => u.createdAt - d.createdAt),
 *         c = l.findIndex(u => u.id === n);
 *   if (c < l.length - 1 ? o = l[c + 1] : o = l[0], o && o.id !== n)
 *       executeCommand("aipopup.action.focusEdit", o.id);
 *   else focus the active code editor (when it has a model).
 *
 * Returns the id the caller must focus via `aipopup.action.focusEdit`,
 * or `undefined` when the binary takes its else-branch (no bars open, or
 * the resolved next bar IS the current one) and focuses the editor
 * instead. Pure: no service imports, unit-testable under node:test.
 */
export function selectNextPromptBarId(
	bars: readonly IPromptBarRef[],
	currentBarId: string | undefined,
): string | undefined {
	const sorted: readonly IPromptBarRef[] = [...bars].sort((u, d) => u.createdAt - d.createdAt);
	const c = sorted.findIndex((u) => u.id === currentBarId);
	const o = c < sorted.length - 1 ? sorted[c + 1] : sorted[0];
	return o !== undefined && o.id !== currentBarId ? o.id : undefined;
}

/**
 * Target resolution of `aipopup.action.modal.generate` (StartEditPrompt) —
 * a port of the binary run body's decision order (Cursor 3.25.9
 * workbench.glass.main.js, class `goo`, super @40731968; desktop class `SLr`
 * @32228473 — identical logic, re-sliced by GAPS-171):
 *
 *   1. Prompt bars bound to the ACTIVE editor's uri exist → the LAST one is
 *      the target, for EVERY invocationType: the caller executes
 *      `aipopup.action.insertEditSelection` with its id when the current
 *      selection is non-empty, else `aipopup.action.focusEdit`.
 *   2. `invocationType === "toggle"` with an explicit `promptBarId` arg →
 *      the caller executes `aipopup.action.nextPromptBar` with that id
 *      (binary: `c.executeCommand(d4o, n?.promptBarId); return`).
 *   3. Otherwise → create a new prompt bar in the active editor.
 *
 * The binary's step between 2 and 3 — toggle with no `promptBarId` jumps to
 * the most-recent bar overall when that bar is visible in the active editor
 * group (`$` group/editorId check) — is NOT ported: fork prompt-bar refs
 * carry no `editorId`/group-visibility signal (see `IPromptBarRef`), and a
 * same-uri bar is already caught by step 1. A most-recent bar in ANOTHER
 * file therefore falls through to "create", which is also what the binary
 * does when its visibility check fails (minus its `te = O?.id || xi()`
 * id-reuse quirk). Documented divergence (GAPS-171 D3), not silent.
 *
 * Pure: no service imports, unit-testable under node:test.
 */
export type ModalGenerateResolution =
	| { readonly kind: 'focusExistingBar'; readonly barId: string }
	| { readonly kind: 'cycleFromBar'; readonly barId: string }
	| { readonly kind: 'createPromptBar' };

export function resolveModalGenerateTarget(
	bars: readonly IPromptBarRef[],
	activeUriString: string | undefined,
	invocationType: string | undefined,
	promptBarId: string | undefined,
): ModalGenerateResolution {
	if (activeUriString !== undefined) {
		const sameUriBarId = selectNewestPromptBarIdForUri(bars, activeUriString);
		if (sameUriBarId !== undefined) {
			return { kind: 'focusExistingBar', barId: sameUriBarId };
		}
	}
	if (invocationType === 'toggle' && promptBarId !== undefined) {
		return { kind: 'cycleFromBar', barId: promptBarId };
	}
	return { kind: 'createPromptBar' };
}

/**
 * Same-uri resolution of the OVERRIDE path of `aipopup.action.modal.generate`
 * (binary StartEditPrompt `goo.run`, glass @40731968+, re-sliced by GAPS-189):
 *
 *   n?.overrideUri && (T = await openCodeEditor({resource: n.overrideUri, ...}))
 *   const A = n?.overrideUri ?? T.getModel().uri,
 *         P = getPromptBars().filter(ce => ce.uri.toString() === A.toString());
 *   if (P.length > 0) {
 *     const ce = P[P.length - 1], ae = n?.overrideRange ?? T.getSelection();
 *     ae && !ae.isEmpty() ? executeCommand("aipopup.action.insertEditSelection", ce.id)
 *                         : executeCommand("aipopup.action.focusEdit", ce.id);
 *     return; // undefined — no bar id, so a JcI-style caller aborts
 *   }
 *   // only THEN: blocked-check, column-1 trim of M, toggle, create…
 *
 * The decision uses the override range AS GIVEN — the binary's column-1
 * trim applies only to the create path's `M`, never to `ae` here. Both
 * commands take only the bar id (the insert action re-reads the active
 * editor's selection itself, in the binary and in the fork alike); the
 * range's role is purely the insert-vs-focus choice. GAPS-174 returned
 * `undefined` from this branch WITHOUT the insert/focus side effect;
 * QA-185 round 24 flagged that as NF-1 and GAPS-189 mirrors it via this
 * helper (used by both the modal.generate override branch and
 * `IInlineEditService.openPromptForRange`).
 *
 * Pure: no service imports, unit-testable under node:test.
 */
export type SameUriOverrideResolution =
	| { readonly kind: 'insertEditSelection'; readonly barId: string }
	| { readonly kind: 'focusEdit'; readonly barId: string }
	| { readonly kind: 'createPromptBar' };

export function resolveSameUriOverrideTarget(
	bars: readonly IPromptBarRef[],
	uriString: string,
	overrideRange: Range | undefined,
): SameUriOverrideResolution {
	const barId = selectNewestPromptBarIdForUri(bars, uriString);
	if (barId === undefined) {
		return { kind: 'createPromptBar' };
	}
	return overrideRange !== undefined && !overrideRange.isEmpty()
		? { kind: 'insertEditSelection', barId }
		: { kind: 'focusEdit', barId };
}

/**
 * The prompt-bar input delegate — the fork equivalent of the binary's
 * `promptBar.data.delegate` (Cursor 3.25.9 workbench.glass.main.js, class
 * `JcI` = `cmdK.resolveConflictInCmdK` @40750760): JcI drives a freshly
 * created bar through `delegate.setText(o, o)`, polls
 * `delegate.numSubmitListeners()` / `delegate.getText()` and finally calls
 * `delegate.submit()`. In the binary the delegate is a Lexical editor
 * facade (hence the doubled `setText(o, o)` argument — the second argument
 * is unrecoverable from the minified bundle and has no fork counterpart);
 * the fork's native bar exposes the same four operations over its
 * textarea input. `numSubmitListeners()` is 1 while the bar is live (its
 * submit wiring — Enter key + submit button — is attached synchronously
 * at creation) and 0 once the bar has settled/closed.
 */
export interface IPromptBarDelegate {
	/** Replace the bar's input text (binary: `delegate.setText(text, text)`). */
	setText(text: string): void;
	/** Current input text (binary: `delegate.getText()`). */
	getText(): string;
	/** Binary: `delegate.numSubmitListeners()` — see the note above. */
	numSubmitListeners(): number;
	/** Submit the bar with its current text (binary: `delegate.submit()`). */
	submit(): void;
}

/**
 * Verbatim init text of `cmdK.resolveConflictInCmdK` (Cursor 3.25.9,
 * glass @40750827 / desktop @32247336): the command opens Cmd+K with this
 * text and auto-submits it. (The chat sibling
 * `composer.resolveAllConflictsInChat` reuses the same literal for its
 * single-conflict prompt — implemented separately in the ide-agent
 * extension's chatConflictService.)
 */
export const RESOLVE_CONFLICT_INIT_TEXT = 'Resolve this merge conflict';

/**
 * The set-text → wait → submit sequence of `cmdK.resolveConflictInCmdK`
 * (binary `JcI.run`, glass @40750760) — a verbatim port:
 *
 *   s.data.delegate.setText?.(o, o);
 *   let a = 0;
 *   do await new Promise(l => setTimeout(l, 150)), a++;
 *   while ((s.data.delegate.numSubmitListeners?.() === 0
 *           || s.data.delegate.getText?.()?.trim() !== o) && a < 3);
 *   s.data.delegate.submit?.();
 *
 * (The caller waits 50ms after bar creation and looks the bar up first —
 * that part lives in the action, exactly as in the binary.) Pure apart
 * from the injected `sleep`, so the poll arithmetic is unit-testable.
 */
export async function setPromptBarTextAndSubmit(
	delegate: IPromptBarDelegate,
	text: string,
	sleep: (ms: number) => Promise<void> = (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
): Promise<void> {
	delegate.setText(text);
	let attempts = 0;
	do {
		await sleep(150);
		attempts++;
	} while ((delegate.numSubmitListeners() === 0 || delegate.getText().trim() !== text) && attempts < 3);
	delegate.submit();
}

export const IInlineEditPromptBar = createDecorator<IInlineEditPromptBar>('composerInlineEditPromptBar');

/**
 * Browser-implemented prompt bar (native Monaco view zone). The common
 * `InlineEditService` drives it; all DOM/view-zone work lives in the browser
 * implementation (`browser/inlineEditPromptBar.ts`).
 */
export interface IInlineEditPromptBar {
	readonly _serviceBrand: undefined;

	/**
	 * Show the prompt bar above `options.startLineNumber` in `editor`.
	 * Resolves with the submitted mode+text, or `undefined` when the user
	 * cancels (Esc / close command). Re-entrant: an already-open bar for the
	 * editor is focused and its pending promise is returned.
	 */
	showPromptBar(editor: ICodeEditor, options: IInlineEditPromptBarOptions): Promise<IInlineEditPromptBarResult | undefined>;

	/**
	 * Tier-1 Esc (`aipopup.action.closePromptBar`): close this editor's bar.
	 */
	closePromptBar(editor: ICodeEditor): void;

	/**
	 * Tier-2 Esc (`workbench.action.closeActiveEditorPromptBars`): close this
	 * editor's bar only when it has no diff yet (`setHasDiff` not called with
	 * true). Mirrors the binary's `diffId==null` guard.
	 */
	closeActiveEditorPromptBars(editor: ICodeEditor): void;

	/** Whether `editor` currently has an open prompt bar. */
	hasPromptBar(editor: ICodeEditor): boolean;

	/** `cmdk.togglePromptBarModel` ("Open model toggle"): model quick pick. */
	toggleModelPicker(editor: ICodeEditor): Promise<void>;

	/**
	 * Mark the bar as showing a diff (called when the preview is applied).
	 * Tier-2 Esc skips bars with a diff; cleared when the bar closes.
	 */
	setHasDiff(editor: ICodeEditor, hasDiff: boolean): void;

	/**
	 * Source of models for the in-bar picker. Registered by the inline-edit
	 * service once its engine adapter exists. Until then the picker only
	 * offers "Auto (engine default)".
	 */
	setModelProvider(provider: () => Promise<readonly IPromptBarModelRef[]>): void;

	/**
	 * All currently open prompt bars (`id` + `createdAt`).
	 * (binary: the prompt-bar service's `getPromptBars()`, source of the
	 * list `aipopup.action.nextPromptBar` sorts by `createdAt`).
	 */
	getPromptBars(): readonly IPromptBarRef[];

	/**
	 * Look up one open prompt bar by id (binary: the prompt-bar service's
	 * `getPromptBar(id)`, consumed by `cmdK.resolveConflictInCmdK` after
	 * `aipopup.action.modal.generate` returns the new bar's id).
	 * `undefined` when no live bar carries the id.
	 */
	getPromptBar(id: string): IPromptBarRef | undefined;

	/**
	 * The input delegate of the bar with the given id (binary:
	 * `getPromptBar(id).data.delegate`), or `undefined` when the bar is
	 * gone — the binary's `if (!s) return` guard in
	 * `cmdK.resolveConflictInCmdK`.
	 */
	getPromptBarDelegate(id: string): IPromptBarDelegate | undefined;

	/**
	 * Binary `cmdKStateService.appendDataSelection(promptBarId, item)`:
	 * pushes the item into the bar's `data.selections` (no-op when no bar
	 * with that id exists). Returns whether the bar existed — the command
	 * skips focusing when the bar is gone, exactly like the binary's
	 * `!r.getPromptBar(n)` guard.
	 */
	appendDataSelection(barId: string, selection: IPromptBarDataSelection): boolean;

	/**
	 * Id of the prompt bar whose input currently has DOM focus, or
	 * `undefined`. Fork-only plumbing: the binary's `nextPromptBar` takes
	 * the current bar id as its command argument `n`; when the command is
	 * invoked without an argument (e.g. from the command palette while
	 * typing in a bar) the fork derives `n` from focus instead.
	 */
	getFocusedPromptBarId(): string | undefined;

	/**
	 * Binary `aipopup.action.focusEdit` target: focus the prompt bar with
	 * the given id. When the bar lives in another editor that editor is
	 * opened/revealed first (the binary's `openCodeEditor` +
	 * `revealLineInCenterIfOutsideViewport` path); in the same editor the
	 * bar is focused in place. Returns false when no bar with the id
	 * exists (binary: `getPromptBar(n)` → `!c` → return). Async like the
	 * binary's run body (the cross-editor path opens the editor first).
	 */
	focusPromptBar(id: string): Promise<void>;

	/**
	 * Binary prompt-bar service methods `undoLexical(historyState,
	 * promptBarId)` / `redoLexical(historyState, promptBarId)`
	 * (Cursor 3.25.9 workbench.desktop.main.js @24823109), invoked ONLY
	 * by the editor actions `editor.action.undoLexical` /
	 * `editor.action.redoLexical` (feature_id
	 * `lexical-undo-redo-prompt-bar`, GAPS-139): look the bar up, pop
	 * its per-bar input history, and apply the snapshot to the bar's
	 * input. No-op (returns false) when the bar is gone — the binary's
	 * `viewZoneCache[t]?.editor && ...` optional chain.
	 *
	 * HONEST-DIVERGENCE D2 (work-notes-gaps139.md): the binary passes
	 * its Lexical `historyState` object through the command args; the
	 * fork keeps the (plain-text snapshot) history state inside the bar
	 * record, so `promptBarId` alone identifies the stack. `editor` is
	 * the editor the action ran on (the binary resolves the same bar
	 * via `nOe.get(editor)` first).
	 */
	undoLexical(editor: ICodeEditor, promptBarId?: string): boolean;
	redoLexical(editor: ICodeEditor, promptBarId?: string): boolean;
}
