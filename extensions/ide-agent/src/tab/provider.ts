/**
 * TabCompletionProvider — port of Cursor's `fireCppSuggestionFromTrigger` pipeline
 * as a `vscode.InlineCompletionItemProvider`:
 *
 *   enablement gate → 5M-char file gate → visible-suggestion short-circuit →
 *   maxConcurrentRequests eviction (abort oldest) → debounce coalescing
 *   (requestIdsToCancel) → streamed backend fetch → bad-heuristics filter →
 *   InlineCompletionList.
 *
 * Trigger kinds: VS Code invokes us with Automatic (typing) / Explicit (manual).
 * Other kinds (lint_errors, editor_change, cursor_prediction, ...) are queued by
 * extension.ts via `setPendingTrigger` before calling
 * `editor.action.inlineSuggest.trigger`.
 */

import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { TabBackend, TabRequestContext } from './backend';
import { TabDebounceService } from './debounce';
import { offsetToPosition, ShownSuggestion, TabSession } from './session';
import { ClearedSuggestionTracker, FateTracker, TabTelemetry } from './telemetry';
import { gateEditor } from './gates';
import { TabClientConfig, TriggerKind } from './types';
import { HookService } from '../hooks/hookService';

export interface TabProviderHooks {
  getClientConfig(): TabClientConfig;
  getPerLanguageState(): Record<string, 'disabled' | 'enabled' | undefined>;
  isSnoozed(): boolean;
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
 * VS Code extension-host API exposes no event for third-party LSP suggestion
 * activity, so the client can never fire it. P2 (QA-FILE-06).
 */
const REFIRE_TRIGGERS: ReadonlySet<TriggerKind> = new Set(['lint_errors', 'cursor_prediction']);

export class TabCompletionProvider implements vscode.InlineCompletionItemProvider {
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
    private agentHooks?: HookService,
  ) {}

  /** Queue a trigger kind for the next explicit `inlineSuggest.trigger` call. */
  setPendingTrigger(kind: TriggerKind): void {
    this.pendingTrigger = kind;
  }

  /**
   * Abort every in-flight request (user-invoked kill via `ide.abortTabRequests`
   * / Alt+K, or internally on accept / editor close).
   *
   * P1 (QA-FILE-06): this is the port of Cursor's Alt-kill
   * (`eventShouldKillPrevCpp`). True Alt-*hold* detection needs renderer-level
   * keydown events (Cursor reads `KeyboardEvent.altKey` in the workbench);
   * the extension host cannot observe a bare modifier keydown, so the kill
   * is exposed as a real, discoverable keybinding (Alt+K) instead of a
   * modifier-only binding (which VS Code cannot fire).
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
    document: vscode.TextDocument,
    position: vscode.Position,
    cur: ShownSuggestion,
  ): vscode.InlineCompletionList | undefined {
    const remainder = cur.fullText.slice(cur.appliedLength);
    if (remainder.length === 0) {
      return undefined;
    }
    // Safety: the cursor must be exactly at the end of the applied prefix,
    // and the document must actually contain that prefix at insertPosition.
    // This guards against races with concurrent edits.
    const applied = cur.fullText.slice(0, cur.appliedLength);
    const expectedPos = offsetToPosition(cur.insertPosition, applied);
    if (!position.isEqual(expectedPos)) {
      return undefined;
    }
    let docStart: number;
    try {
      docStart = document.offsetAt(cur.insertPosition);
    } catch {
      return undefined;
    }
    if (document.getText().slice(docStart, docStart + applied.length) !== applied) {
      return undefined;
    }
    return new vscode.InlineCompletionList([
      new vscode.InlineCompletionItem(remainder, new vscode.Range(position, position)),
    ]);
  }

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionList | undefined> {
    const cfg = this.hooks.getClientConfig();

    // 1. Enablement gates.
    if (!cfg.enabled) return undefined;
    if (this.hooks.isSnoozed()) return undefined;
    const gate = gateEditor({
      charCount: document.getText().length,
      fsPath: document.uri.fsPath,
      relPath: vscode.workspace.asRelativePath(document.uri),
      languageId: document.languageId,
      disabledLanguages: cfg.disabledLanguages,
      perLanguageState: this.hooks.getPerLanguageState(),
      ignorePatterns: cfg.ignorePatterns,
      // SETTINGS-PARITY: `ide.tab.suggestionWhileCommenting`.
      suggestionWhileCommenting: cfg.suggestionWhileCommenting,
      cursorLinePrefix: document.getText(
        new vscode.Range(position.line, 0, position.line, position.character),
      ),
    });
    if (!gate.allowed) return undefined;

    // 2. Rejection throttling (server-driven).
    if (this.cleared.shouldSuppress()) return undefined;

    const triggerKind: TriggerKind =
      this.pendingTrigger ?? (context.triggerKind === vscode.InlineCompletionTriggerKind.Invoke ? 'manual_trigger' : 'typing');
    this.pendingTrigger = undefined;

    // DEV-HOOKS: beforeTabFileRead (blocking, Cursor parity). Exit code 2
    // suppresses the suggestion for this trigger. Fast-path when unconfigured.
    if (this.agentHooks?.hasHooks('beforeTabFileRead')) {
      try {
        const hr = await this.agentHooks.runHooks('beforeTabFileRead', {
          file: document.uri.fsPath,
          relPath: vscode.workspace.asRelativePath(document.uri),
          languageId: document.languageId,
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
    if (cur && cur.uri.toString() === document.uri.toString() && !REFIRE_TRIGGERS.has(triggerKind)) {
      // P1 (XQA-06): re-emit the un-typed remainder instead of returning
      // undefined (which clears the ghost text). The session only survives
      // when the user typed/accepted a matching prefix — type-away clears
      // it — so a live session here means "keep showing".
      return this.reemitRemainder(document, position, cur);
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
    const requestId = randomUUID();
    const { requestIdsToCancel } = this.debounce.runRequest(requestId);
    for (const id of requestIdsToCancel) this.abortRequest(id);

    const abort = new AbortController();
    token.onCancellationRequested(() => this.abortRequest(requestId));
    this.active.set(requestId, { requestId, abort, startedAt: Date.now() });

    this.telemetry.recordSessionEvent('tabTrigger', {
      requestId,
      triggerKind,
      line: position.line,
      character: position.character,
      languageId: document.languageId,
    });

    try {
      // P0: timeout the fetch so a hung backend can't permanently exhaust
      // concurrency slots (the finally below always releases the slot).
      const FETCH_TIMEOUT_MS = 15_000;
      let timeoutId: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          abort.abort();
          reject(new Error(`Tab fetchSuggestion timed out after ${FETCH_TIMEOUT_MS}ms`));
        }, FETCH_TIMEOUT_MS);
      });
      let result: { text: string; meta: { nextAction?: import('./types').NextAction; displayId?: string; modelId?: string; modelVersion?: string } };
      try {
        result = await Promise.race([
          this.collectStream(document, position, requestId, triggerKind, abort.signal),
          timeoutPromise,
        ]);
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

      const item = new vscode.InlineCompletionItem(text, new vscode.Range(position, position));
      this.session.set({
        requestId,
        uri: document.uri,
        version: document.version,
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
        languageId: document.languageId,
        suggestionLength: text.length,
      });
      return new vscode.InlineCompletionList([item]);
    } finally {
      this.abortRequest(requestId);
    }
  }

  private async collectStream(
    document: vscode.TextDocument,
    position: vscode.Position,
    requestId: string,
    triggerKind: TriggerKind,
    signal: AbortSignal,
  ): Promise<{
    text: string;
    meta: { nextAction?: import('./types').NextAction; displayId?: string; modelId?: string; modelVersion?: string };
  }> {
    // Bounded context window for the request (real backends page this themselves).
    const full = document.getText();
    const offset = document.offsetAt(position);
    const PREFIX_CHARS = 8000;
    const SUFFIX_CHARS = 2000;
    // M-09: route to the user's chosen Tab model (empty = server default).
    const tabCfg = this.hooks.getClientConfig();
    const req: TabRequestContext = {
      uri: document.uri.toString(),
      languageId: document.languageId,
      fileName: document.uri.fsPath.split(/[\\/]/).pop() ?? '',
      prefix: full.slice(Math.max(0, offset - PREFIX_CHARS), offset),
      suffix: full.slice(offset, offset + SUFFIX_CHARS),
      position: { line: position.line, character: position.character },
      triggerKind,
      ...(tabCfg.model ? { modelOverride: tabCfg.model } : {}),
    };
    void requestId;
    let text = '';
    const meta: {
      nextAction?: import('./types').NextAction;
      displayId?: string;
      modelId?: string;
      modelVersion?: string;
    } = {};
    // P2: cap the accumulator — a runaway backend streaming megabytes must not
    // freeze the editor when we build the InlineCompletionItem.
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
function isValidNextAction(v: unknown): v is import('./types').NextAction {
  if (!v || typeof v !== 'object') return false;
  const action = (v as { action?: unknown }).action;
  return action === 'fusedCursorPrediction' || action === 'nextEdit' || action === 'followup';
}
