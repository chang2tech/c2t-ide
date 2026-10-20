/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: TabCompletionProvider — rewritten from
// extensions/ide-agent/src/tab/provider.ts to implement the CORE
// `InlineCompletionsProvider` (vs/editor/common/languages) instead of
// `vscode.InlineCompletionItemProvider`. Registered via
// `ILanguageFeaturesService.inlineCompletionsProvider.register(...)` in
// tabContribution.ts (the workbench replacement for
// `vscode.languages.registerInlineCompletionItemProvider`).
//
// Interface mapping:
//   provideInlineCompletionItems(document, position, context, token)
//     → provideInlineCompletions(model: ITextModel, position, context, token)
//   vscode.TextDocument.getText()      → ITextModel.getValue()
//   document.getText(range)            → model.getValueInRange(range)
//   document.offsetAt(position)        → model.getOffsetAt(position)
//   document.version                   → model.getVersionId()
//   document.languageId                → model.getLanguageId()
//   vscode.InlineCompletionList        → InlineCompletions { items: [...] }
//   vscode.InlineCompletionItem        → InlineCompletion { insertText, range }
//   InlineCompletionTriggerKind.Invoke → InlineCompletionTriggerKind.Explicit
//   randomUUID() (node:crypto)         → generateUuid() (vs/base/common/uuid)
//   vscode.Position (0-based)          → core Position (1-based lineNumber/column)
//   workspace.asRelativePath          → hooks.getRelativePath (IWorkspaceContextService)

/**
 * TabCompletionProvider — port of Cursor's `fireCppSuggestionFromTrigger` pipeline
 * as a core `InlineCompletionsProvider`:
 *
 *   enablement gate → 5M-char file gate → visible-suggestion short-circuit →
 *   maxConcurrentRequests eviction (abort oldest) → debounce coalescing
 *   (requestIdsToCancel) → streamed backend fetch → bad-heuristics filter →
 *   InlineCompletions.
 *
 * Trigger kinds: the inline completions controller invokes us with Automatic
 * (typing) / Explicit (manual). Other kinds (lint_errors, editor_change,
 * cursor_prediction, ...) are queued by tabContribution.ts via
 * `setPendingTrigger` before calling `editor.action.inlineSuggest.trigger`.
 */

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { Position } from '../../../../../editor/common/core/position.js';
import { Range } from '../../../../../editor/common/core/range.js';
import {
	InlineCompletion,
	InlineCompletionContext,
	InlineCompletionEndOfLifeReason,
	InlineCompletions,
	InlineCompletionsDisposeReason,
	InlineCompletionsProvider,
	InlineCompletionTriggerKind,
	LifetimeSummary,
} from '../../../../../editor/common/languages.js';
import { TabBackend, TabRequestContext } from './backend.js';
import { TabDebounceService } from './debounce.js';
import { offsetToPosition, ShownSuggestion, TabSession } from './session.js';
import { ClearedSuggestionTracker, FateTracker, TabTelemetry } from './telemetry.js';
import { gateEditor } from './gates.js';
import { NextAction, TabClientConfig, TriggerKind } from './types.js';
import { TabAgentHooks } from './accept.js';

export interface TabProviderHooks {
	getClientConfig(): TabClientConfig;
	getPerLanguageState(): Record<string, 'disabled' | 'enabled' | undefined>;
	isSnoozed(): boolean;
	/**
	 * False when no model backend is wired (stub engine mode). The provider
	 * stays silent then — Tab never fakes a suggestion.
	 */
	isBackendAvailable(): boolean;
	/** Core replacement for `vscode.workspace.asRelativePath`. */
	getRelativePath(uri: URI): string;
	/** Called when a suggestion passes the filter and is shown. */
	onSuggestionShown(requestId: string, text: string, displayId?: string): void;
	/** First-use Copilot interplay hook. */
	onFirstSuggestion(): void;
}

interface ActiveRequest {
	requestId: string;
	abort: AbortController;
	startedAt: number;
}

/**
 * Trigger kinds for which an already-visible suggestion is replaced, not kept.
 *
 * NOTE: `lsp_suggestions` is intentionally NOT here. It remains in the
 * `TriggerKind` union (it is a real wire kind in the Cursor cpp spec), but the
 * workbench never fires it (see the wire-spec note in types.ts). P2 (QA-FILE-06).
 */
const REFIRE_TRIGGERS: ReadonlySet<TriggerKind> = new Set(['lint_errors', 'cursor_prediction']);

interface CollectedSuggestion {
	text: string;
	meta: { nextAction?: NextAction; displayId?: string; modelId?: string; modelVersion?: string };
}

export class TabCompletionProvider implements InlineCompletionsProvider {
	readonly session = new TabSession();
	readonly debounce = new TabDebounceService();
	readonly fate = new FateTracker();
	readonly cleared = new ClearedSuggestionTracker();

	private active = new Map<string, ActiveRequest>();
	private pendingTrigger: TriggerKind | undefined;
	private firstSuggestionFired = false;

	constructor(
		private backend: TabBackend,
		private telemetry: TabTelemetry,
		private hooks: TabProviderHooks,
		/**
		 * DEV-HOOKS: Cursor-style agent hooks for the two Tab events
		 * (beforeTabFileRead — blocking; afterTabFileEdit — informational).
		 * Optional; completions work without it.
		 */
		private agentHooks?: TabAgentHooks,
	) { }

	/** Queue a trigger kind for the next explicit `inlineSuggest.trigger` call. */
	setPendingTrigger(kind: TriggerKind): void {
		this.pendingTrigger = kind;
	}

	/** Late-bind agent hooks (wired by the hooks contrib via tabContribution.setAgentHooks). */
	setAgentHooks(hooks: TabAgentHooks | undefined): void {
		this.agentHooks = hooks;
	}

	/**
	 * Abort every in-flight request (user-invoked kill via `ide.abortTabRequests`
	 * / Alt+K, or internally on accept / editor close).
	 *
	 * P1 (QA-FILE-06): this is the port of Cursor's Alt-kill
	 * (`eventShouldKillPrevCpp`). The `option_hold` wire kind needs
	 * renderer-level modifier keydown events (Cursor reads
	 * `KeyboardEvent.altKey` in the workbench); in core the kill is exposed
	 * as a real, discoverable keybinding (Alt+K) instead.
	 */
	abortAllRequests(): void {
		for (const [, r] of this.active) r.abort.abort();
		this.active.clear();
	}

	private abortRequest(requestId: string): void {
		const r = this.active.get(requestId);
		if (r) {
			r.abort.abort();
			this.active.delete(requestId);
		}
		this.debounce.completeRequest(requestId);
	}

	/**
	 * Re-emit the un-typed remainder of the live suggestion so ghost text
	 * survives a re-trigger (typing over it, or a partial accept). Returns
	 * undefined when the remainder cannot be shown safely — falling back to
	 * the old dismiss behavior rather than rendering ghost text in the
	 * wrong place.
	 */
	private reemitRemainder(
		model: ITextModel,
		position: Position,
		cur: ShownSuggestion,
	): InlineCompletions | undefined {
		const remainder = cur.fullText.slice(cur.appliedLength);
		if (remainder.length === 0) {
			return undefined;
		}
		// Safety: the cursor must be exactly at the end of the applied prefix,
		// and the document must actually contain that prefix at insertPosition.
		// This guards against races with concurrent edits.
		const applied = cur.fullText.slice(0, cur.appliedLength);
		const expectedPos = offsetToPosition(cur.insertPosition, applied);
		if (!position.equals(expectedPos)) {
			return undefined;
		}
		let docStart: number;
		try {
			docStart = model.getOffsetAt(cur.insertPosition);
		} catch {
			return undefined;
		}
		if (model.getValue().slice(docStart, docStart + applied.length) !== applied) {
			return undefined;
		}
		const range = new Range(position.lineNumber, position.column, position.lineNumber, position.column);
		return { items: [{ insertText: remainder, range }] };
	}

	async provideInlineCompletions(
		model: ITextModel,
		position: Position,
		context: InlineCompletionContext,
		token: CancellationToken,
	): Promise<InlineCompletions | undefined> {
		const cfg = this.hooks.getClientConfig();

		// 1. Enablement gates.
		if (!cfg.enabled) return undefined;
		if (this.hooks.isSnoozed()) return undefined;
		// 1b. No model backend (stub engine mode): stay silent. A fake
		// suggestion here would be worse than none — the status bar says why.
		if (!this.hooks.isBackendAvailable()) return undefined;
		const gate = gateEditor({
			charCount: model.getValueLength(),
			fsPath: model.uri.fsPath,
			relPath: this.hooks.getRelativePath(model.uri),
			languageId: model.getLanguageId(),
			disabledLanguages: cfg.disabledLanguages,
			perLanguageState: this.hooks.getPerLanguageState(),
			ignorePatterns: cfg.ignorePatterns,
			// SETTINGS-PARITY: `ide.tab.suggestionWhileCommenting`.
			suggestionWhileCommenting: cfg.suggestionWhileCommenting,
			cursorLinePrefix: model.getValueInRange(
				new Range(position.lineNumber, 1, position.lineNumber, position.column),
			),
		});
		if (!gate.allowed) return undefined;

		// 2. Rejection throttling (server-driven).
		if (this.cleared.shouldSuppress()) return undefined;

		const triggerKind: TriggerKind =
			this.pendingTrigger ?? (context.triggerKind === InlineCompletionTriggerKind.Explicit ? 'manual_trigger' : 'typing');
		this.pendingTrigger = undefined;

		// DEV-HOOKS: beforeTabFileRead (blocking, Cursor parity). Exit code 2
		// suppresses the suggestion for this trigger. Fast-path when unconfigured.
		if (this.agentHooks?.hasHooks('beforeTabFileRead')) {
			try {
				const hr = await this.agentHooks.runHooks('beforeTabFileRead', {
					file: model.uri.fsPath,
					relPath: this.hooks.getRelativePath(model.uri),
					languageId: model.getLanguageId(),
					triggerKind,
				});
				if (hr.blocked) {
					return undefined;
				}
			} catch {
				/* hooks never break completions */
			}
		}

		// 3. Visible suggestion short-circuit: keep it unless the trigger is one
		//    of the refire kinds.
		const cur = this.session.current;
		if (cur && cur.uri.toString() === model.uri.toString() && !REFIRE_TRIGGERS.has(triggerKind)) {
			// P1 (XQA-06): re-emit the un-typed remainder instead of returning
			// undefined (which clears the ghost text). The session only survives
			// when the user typed/accepted a matching prefix — type-away clears
			// it — so a live session here means "keep showing".
			return this.reemitRemainder(model, position, cur);
		}

		// 4. Concurrency cap: evict oldest streams.
		while (this.active.size >= Math.max(1, cfg.maxConcurrentRequests)) {
			let oldest: string | undefined;
			let oldestAt = Infinity;
			for (const [id, r] of this.active) {
				if (r.startedAt < oldestAt) {
					oldestAt = r.startedAt;
					oldest = id;
				}
			}
			if (oldest === undefined) break;
			this.abortRequest(oldest);
		}

		// 5. Debounce coalescing: cancel requests started within totalMs of now.
		const requestId = generateUuid();
		const { requestIdsToCancel } = this.debounce.runRequest(requestId);
		for (const id of requestIdsToCancel) this.abortRequest(id);

		const abort = new AbortController();
		token.onCancellationRequested(() => this.abortRequest(requestId));
		this.active.set(requestId, { requestId, abort, startedAt: Date.now() });

		this.telemetry.recordSessionEvent('tabTrigger', {
			requestId,
			triggerKind,
			line: position.lineNumber,
			character: position.column,
			languageId: model.getLanguageId(),
		});

		try {
			// P0: timeout the fetch so a hung backend can't permanently exhaust
			// concurrency slots (the finally below always releases the slot).
			const FETCH_TIMEOUT_MS = 15_000;
			let timeoutId: ReturnType<typeof setTimeout> | undefined;
			const timeoutPromise = new Promise<never>((_, reject) => {
				timeoutId = setTimeout(() => {
					abort.abort();
					reject(new Error(`Tab fetchSuggestion timed out after ${FETCH_TIMEOUT_MS}ms`));
				}, FETCH_TIMEOUT_MS);
			});
			let result: CollectedSuggestion;
			try {
				result = await Promise.race([
					this.collectStream(model, position, triggerKind, abort.signal),
					timeoutPromise,
				]);
			} catch (err) {
				// Backend failure (engine unreachable, timed out, aborted): record
				// honestly and show nothing — never synthesize a suggestion.
				this.telemetry.recordSessionEvent('tabBackendError', {
					requestId,
					triggerKind,
					error: err instanceof Error ? err.message : String(err),
				});
				return undefined;
			} finally {
				if (timeoutId) clearTimeout(timeoutId);
			}
			const { text, meta } = result;
			if (abort.signal.aborted) return undefined;

			// P2: defensive — the backend contract promises string/object, but a
			// misbehaving backend must not crash the provider or render garbage.
			if (typeof text !== 'string') {
				this.abortRequest(requestId);
				return undefined;
			}
			const safeMeta = meta && typeof meta === 'object' ? meta : {};
			const nextAction = isValidNextAction(safeMeta.nextAction) ? safeMeta.nextAction : undefined;

			// 6. Bad-heuristics filter: drop empty / whitespace-only / no-op.
			if (!isValidSuggestion(text)) {
				this.abortRequest(requestId);
				return undefined;
			}

			const range = new Range(position.lineNumber, position.column, position.lineNumber, position.column);
			const item: InlineCompletion = { insertText: text, range };
			this.session.set({
				requestId,
				uri: model.uri,
				version: model.getVersionId(),
				fullText: text,
				insertPosition: position,
				appliedLength: 0,
				partialRemainder: false,
				shownAt: Date.now(),
				nextAction,
				modelId: typeof safeMeta.modelId === 'string' ? safeMeta.modelId : undefined,
				modelVersion: typeof safeMeta.modelVersion === 'string' ? safeMeta.modelVersion : undefined,
			});

			if (!this.firstSuggestionFired) {
				this.firstSuggestionFired = true;
				this.hooks.onFirstSuggestion();
			}
			this.hooks.onSuggestionShown(requestId, text, meta.displayId);
			this.telemetry.recordSessionEvent('suggestTab', {
				requestId,
				triggerKind,
				languageId: model.getLanguageId(),
				suggestionLength: text.length,
			});
			return { items: [item] };
		} finally {
			this.abortRequest(requestId);
		}
	}

	/**
	 * Core lifecycle hook: an inline completion item is no longer being used.
	 * Safety-net fate recording — the manual type-over/type-away machinery in
	 * tabContribution.ts normally records the fate first; the exactly-once
	 * FateTracker makes the order between the two irrelevant.
	 */
	handleEndOfLifetime(
		_completions: InlineCompletions,
		_item: InlineCompletion,
		_reason: InlineCompletionEndOfLifeReason<InlineCompletion>,
		_lifetimeSummary: LifetimeSummary,
	): void {
		const s = this.session.current;
		if (!s) return;
		if (this.fate.get(s.requestId) !== undefined) return;
		const ext = s.uri.fsPath.split('.').pop() ?? '';
		this.fate.record(s.requestId, 'REJECT', ext);
		this.cleared.increment();
		this.telemetry.recordSessionEvent('rejectTab', { requestId: s.requestId, via: 'endOfLifetime' });
		this.session.clear();
	}

	disposeInlineCompletions(
		_completions: InlineCompletions,
		_reason: InlineCompletionsDisposeReason,
	): void {
		// No per-completion resources to release; the session is the owner.
	}

	private async collectStream(
		model: ITextModel,
		position: Position,
		triggerKind: TriggerKind,
		signal: AbortSignal,
	): Promise<CollectedSuggestion> {
		// Bounded context window for the request (real backends page this themselves).
		const full = model.getValue();
		const offset = model.getOffsetAt(position);
		const PREFIX_CHARS = 8000;
		const SUFFIX_CHARS = 2000;
		// M-09: route to the user's chosen Tab model (empty = server default).
		const tabCfg = this.hooks.getClientConfig();
		const req: TabRequestContext = {
			uri: model.uri.toString(),
			languageId: model.getLanguageId(),
			fileName: model.uri.fsPath.split(/[\\/]/).pop() ?? '',
			prefix: full.slice(Math.max(0, offset - PREFIX_CHARS), offset),
			suffix: full.slice(offset, offset + SUFFIX_CHARS),
			// 0-based wire shape (backend contract unchanged); core positions are 1-based.
			position: { line: position.lineNumber - 1, character: position.column - 1 },
			triggerKind,
			...(tabCfg.model ? { modelOverride: tabCfg.model } : {}),
		};
		let text = '';
		const meta: CollectedSuggestion['meta'] = {};
		// P2: cap the accumulator — a runaway backend streaming megabytes must not
		// freeze the editor when we build the InlineCompletion.
		const MAX_SUGGESTION_CHARS = 16_000;
		// Server metadata (nextAction, model identity) arrives on the final chunk.
		for await (const chunk of this.backend.fetchSuggestion(req, signal)) {
			if (signal.aborted) break;
			if (typeof chunk.textDelta === 'string') text += chunk.textDelta;
			if (text.length > MAX_SUGGESTION_CHARS) {
				text = text.slice(0, MAX_SUGGESTION_CHARS);
				break;
			}
			if (chunk.done) {
				meta.nextAction = chunk.nextAction;
				// P2 (QA-FILE-06): populate the follow-up chain — a suggestion that
				// carries a displayId satisfies an earlier followup nextAction.
				meta.displayId =
					typeof chunk.displayId === 'string' && chunk.displayId.length > 0 ? chunk.displayId : undefined;
				meta.modelId = chunk.modelId;
				meta.modelVersion = chunk.modelVersion;
			}
		}
		return { text, meta };
	}
}

/** Bad-heuristics filter (`_cppBadHeuristics.isValidCppCase` analog). */
export function isValidSuggestion(suggestionText: string, originalAtRange: string = ''): boolean {
	if (suggestionText.length === 0) return false; // empty generation
	if (suggestionText.trim().length === 0) return false; // whitespace-only
	if (originalAtRange !== '' && suggestionText === originalAtRange) return false; // no-op
	return true;
}

/** P2: runtime-shape guard for server-supplied next actions. */
function isValidNextAction(v: unknown): v is NextAction {
	if (!v || typeof v !== 'object') return false;
	const action = (v as { action?: unknown }).action;
	return action === 'fusedCursorPrediction' || action === 'nextEdit' || action === 'followup';
}
