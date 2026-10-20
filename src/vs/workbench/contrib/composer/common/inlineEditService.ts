/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Cmd+K inline-edit service contract (common layer — node-free, no DOM).
//
// Layering (matches the workbench pattern "interface in common/, implementation
// in electron-browser/"): `IInlineEditService` is implemented by
// `electron-browser/inlineEditService.ts` (InlineEditService, the sidecar-backed
// generation + per-hunk preview flow) and consumed by browser actions
// (`composer.openInlinePrompt`, `editor.action.inlineDiffs.*` in
// browser/inlineDiffActions.ts, `composer.sendToAgent` in
// browser/composerActions.ts). Keeping the contract in common/ means the
// browser layer can reference the live path without importing node builtins
// (the electron-browser module imports `path`).

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import type { IPosition } from '../../../../editor/common/core/position.js';
import type { Range } from '../../../../editor/common/core/range.js';

/**
 * Payload of `onDidAcceptPartialDiff` / `onDidRejectPartialDiff`.
 *
 * Mirrors Cursor's `_onDidAcceptPartialDiff` event
 * (`{inlineDiff, requestId, file, previousContent, updatedContent, source,
 * range, diffInfo, isDone, change: {accepted, rejected}}`, Cursor 3.25.9
 * workbench.glass.main.js) — the workbench-meaningful subset. Cursor-internal
 * handles (`inlineDiff`, `diffInfo`, `source`) are omitted: the fork's session
 * owns the diff state directly.
 */
export interface IInlineEditPartialDiffEvent {
	/** Cursor's `generationUUID` for the inline diff session. */
	readonly requestId: string;
	/** `uri.toString()` of the edited file. */
	readonly file: string;
	/** Merged preview text before this partial operation (lines joined by `\n`). */
	readonly previousContent: string;
	/** Merged preview text after this partial operation. */
	readonly updatedContent: string;
	/** True when every change is now resolved (Cursor's `isDone`). */
	readonly isDone: boolean;
	/** The single change this operation resolved. */
	readonly change: {
		readonly accepted: string[];
		readonly rejected: string[];
	};
}

/**
 * Payload of `onDidSuppressDiffDecorations`.
 *
 * Fired when performance protection (`ide.inlineDiff.enablePerformanceProtection`,
 * mirroring Cursor's `cursor.inlineDiff.enablePerformanceProtection`)
 * suppresses the inline-diff decorations because the change count exceeds
 * `ide.inlineDiff.maxDecorations` (default 100, mirroring Cursor's
 * `inline_diff_performance_config.maxDecorations`).
 */
export interface IInlineEditSuppressionInfo {
	/** Number of pending changes that triggered the suppression. */
	readonly changeCount: number;
	/** The `maxDecorations` limit that was exceeded. */
	readonly maxDecorations: number;
	/** Cursor's `generationUUID` for the inline diff session. */
	readonly generationUUID: string;
}

/** Public surface of the Cmd+K inline edit service (for keybinding wiring). */
export interface IInlineEditService {
	readonly _serviceBrand: undefined;
	readonly hasPendingEdit: boolean;
	/** True while an inline-diff generation turn is in flight. */
	readonly isGenerating: boolean;
	/** Entry point for `composer.openInlinePrompt`. Re-entrant: follow-up while a preview is pending. */
	openPrompt(): Promise<void>;
	/**
	 * Programmatic Cmd+K open over an explicit range in an explicit file —
	 * the create path of `aipopup.action.modal.generate` when invoked with
	 * `overrideUri`/`overrideRange` (Cursor 3.25.9 StartEditPrompt: the bar
	 * is created for `n.overrideUri ?? active uri` over
	 * `n.overrideRange ?? selection`, with the column-1 trim applied, and
	 * run() returns the new bar's id @40739556). Used by
	 * `cmdK.resolveConflictInCmdK` (queue #33), which needs the bar id to
	 * set the init text and auto-submit through the bar's delegate.
	 *
	 * Resolves with the new prompt bar's id once the bar exists, or
	 * `undefined` when no bar could be created (no model for the uri, a
	 * preview session already pending, or — mirroring the binary's
	 * same-uri early return in StartEditPrompt — a bar is already open
	 * for that uri: the binary returns undefined there too, and the
	 * caller aborts). In the same-uri case the binary's side effect is
	 * mirrored (GAPS-189, QA-185 NF-1): `aipopup.action.insertEditSelection`
	 * is executed with the existing bar's id when the override range is
	 * non-empty (used as given — no column-1 trim on this branch), else
	 * `aipopup.action.focusEdit`. The generation flow itself continues
	 * asynchronously exactly like `openPrompt()`; it is NOT awaited here.
	 */
	openPromptForRange(uri: URI, range: Range): Promise<string | undefined>;
	/** `editor.action.inlineDiffs.acceptAll` — keep the previewed change. */
	accept(): void;
	/** `editor.action.inlineDiffs.rejectAll` — restore the original text. */
	reject(): Promise<void>;
	/**
	 * Cursor: `InlineDiffService.acceptPartialDiff(diffId, position)` —
	 * accept only the pending change nearest `position` (defaults to the
	 * cursor). The change's text is committed; remaining changes stay
	 * pending. Telemetry `inlineDiffAcceptPartial`; pushes an undo element
	 * ("Undo Accept Partial Diff"/"undo-accept-partial-diff"); fires
	 * `onDidAcceptPartialDiff`. When the last change resolves, the prompt
	 * bar closes (Cursor: diff removed with `{closePromptBar: true}`).
	 * Returns true when the diff is fully resolved (Cursor's `isDone`).
	 */
	acceptPartial(position?: IPosition): Promise<boolean>;
	/**
	 * Mirror of `acceptPartial` for rejection
	 * (Cursor: `InlineDiffService.rejectPartialDiff`, telemetry
	 * `inlineDiffRejectPartial`, undo "Undo Reject Partial Diff"/
	 * "undo-reject-partial-diff").
	 */
	rejectPartial(position?: IPosition): Promise<boolean>;
	/** Cursor's `_onDidAcceptPartialDiff`. */
	readonly onDidAcceptPartialDiff: Event<IInlineEditPartialDiffEvent>;
	/** Cursor's `_onDidRejectPartialDiff`. */
	readonly onDidRejectPartialDiff: Event<IInlineEditPartialDiffEvent>;
	/**
	 * Fired when performance protection suppresses the inline-diff
	 * decorations (too many changes). The suppression-warning contribution
	 * (`workbench.contrib.composer.inlineDiffSuppressionNotification`) shows
	 * the "too many changes" warning on this event.
	 */
	readonly onDidSuppressDiffDecorations: Event<IInlineEditSuppressionInfo>;
	/**
	 * `editor.action.inlineDiffs.cancelEdits` — abort the in-flight
	 * generation (Cursor's J4 `cancelGeneration(n,"both")`, weight 600,
	 * same chord as rejectAll; wins while generating).
	 */
	cancelGeneration(): void;
	/** `composer.sendToAgent` — escalate the inline task to a full agent turn. */
	escalateToAgent(): Promise<void>;
}

export const IInlineEditService = createDecorator<IInlineEditService>('composerInlineEditService');
