/**
 * Accept flows — port of Cursor's accept paths:
 *  - Full accept: Tab → `editor.action.inlineSuggest.commit`
 *    (`cursor.acceptcppsuggestion` programmatic), fate ACCEPT.
 *  - Partial (word) accept: Ctrl+Right convention (`cursor.acceptcppsuggestionpartial`,
 *    `acceptNextWordSuggestion`), `onlyAcceptFirstWord` semantics: apply the next
 *    word, keep the remainder as ghost text. Fate PARTIAL_ACCEPT.
 *  - Peek (`cursor.peekcppsuggestion`): partial accept + save pre-state for revert.
 *  - Revert (`cursor.revertcppsuggestion` → `revertSuggestion()`): restore the
 *    saved pre-state, fate REJECT.
 *
 * Every accept (full or partial) goes through `aiCodeTrackingService` equivalent
 * (`storeGeneratedContent(..., {source: TAB})`) and resets the cleared-suggestion
 * throttle counter.
 */

import * as vscode from 'vscode';
import { acceptNextWord } from './wordAccept';
import { NextActionEffect, resolveNextAction } from './nextEdit';
import { offsetToPosition, TabSession } from './session';
import { ClearedSuggestionTracker, FateTracker, TabTelemetry } from './telemetry';
import { TabFate } from './types';
import { HookService } from '../hooks/hookService';

export interface AcceptDeps {
  session: TabSession;
  editor: vscode.TextEditor;
  fate: FateTracker;
  cleared: ClearedSuggestionTracker;
  telemetry: TabTelemetry;
  /** Set while we apply our own edits so type-away detection ignores them. */
  setOwnEdit(active: boolean): void;
  /** DEV-HOOKS: optional agent hooks for afterTabFileEdit. */
  agentHooks?: HookService;
  /**
   * DD-SB-5: aiCodeTracking `tab.accept` hook — called with the accepted text
   * (full or partial portion) so the tracking service can count lines and
   * record attribution. Optional; accepts must never break when unwired.
   */
  onAiAccept?: (info: { text: string; uri: vscode.Uri }) => void;
}

/** DEV-HOOKS: fire afterTabFileEdit (informational, fire-and-forget). */
function fireAfterTabFileEdit(deps: AcceptDeps, acceptedText: string): void {
  const svc = deps.agentHooks;
  if (!svc?.hasHooks('afterTabFileEdit')) {
    return;
  }
  void svc
    .runHooks('afterTabFileEdit', {
      file: deps.editor.document.uri.fsPath,
      languageId: deps.editor.document.languageId,
      acceptedChars: acceptedText.length,
    })
    .catch(() => {});
}

function fileParts(uri: vscode.Uri): { fileName: string; fileExtension: string; relPath: string } {
  const fsPath = uri.fsPath;
  const fileName = fsPath.split(/[\\/]/).pop() ?? '';
  const dot = fileName.lastIndexOf('.');
  return {
    fileName,
    fileExtension: dot >= 0 ? fileName.slice(dot + 1) : '',
    relPath: vscode.workspace.asRelativePath(uri),
  };
}

function trackAccept(deps: AcceptDeps, fate: TabFate, originalText: string, replacementText: string): void {
  const s = deps.session.current;
  if (!s) return;
  const { fileName, fileExtension, relPath } = fileParts(s.uri);
  deps.fate.record(s.requestId, fate, fileExtension);
  deps.telemetry.storeGeneratedContent({
    requestId: s.requestId,
    relPath,
    fileName,
    fileExtension,
    originalText,
    replacementText,
    source: 'TAB',
    fate,
  });
  deps.telemetry.recordSessionEvent(fate === 'ACCEPT' ? 'acceptTab' : 'acceptTabPartial', {
    requestId: s.requestId,
    fate,
    fileExtension,
    modelId: s.modelId,
    modelVersion: s.modelVersion,
  });
  deps.cleared.resetOnAccept();
  // DD-SB-5: feed the aiCodeTracking `tab.accept` analog (lines + attribution).
  // Never let stats break the accept flow.
  try {
    deps.onAiAccept?.({ text: replacementText, uri: s.uri });
  } catch {
    /* stats are best-effort */
  }
}

/** Full accept via the stock inline-suggest commit. Returns the next-edit effect. */
export async function acceptFullSuggestion(deps: AcceptDeps): Promise<NextActionEffect> {
  const s = deps.session.current;
  if (!s) return { kind: 'none' };
  await vscode.commands.executeCommand('editor.action.inlineSuggest.commit');
  const effect = resolveNextAction(s.nextAction);
  // P2-B fix (QA-VERIFY-DIGDEEPER): the user may have typed over part of the
  // suggestion before hitting Tab (type-over). That typed portion was already
  // counted via trackTabAccept(typedText) in extension.ts. Pass only the
  // not-yet-counted remainder to avoid double-counting accepted lines.
  trackAccept(deps, 'ACCEPT', '', s.fullText.slice(s.appliedLength));
  fireAfterTabFileEdit(deps, s.fullText);
  deps.session.clear();
  return effect;
}

/**
 * Partial accept: apply exactly the next word of the suggestion, keep the
 * remainder. Returns the next-edit effect (applied when fully consumed).
 */
export async function acceptPartialSuggestion(deps: AcceptDeps): Promise<NextActionEffect> {
  const { session, editor } = deps;
  const s = session.current;
  if (!s) return { kind: 'none' };

  const step = acceptNextWord(s.fullText, s.appliedLength);
  if (step.applied.length === 0) {
    session.clear();
    return { kind: 'none' };
  }

  const start = s.insertPosition;
  const end = offsetToPosition(start, s.fullText.slice(0, s.appliedLength));
  const newText = s.fullText.slice(0, step.newOffset);

  deps.setOwnEdit(true);
  try {
    await editor.edit((eb) => eb.replace(new vscode.Range(start, end), newText));
  } finally {
    deps.setOwnEdit(false);
  }

  const fullyConsumed = step.fullyConsumed;
  s.appliedLength = step.newOffset;
  s.partialRemainder = !fullyConsumed;

  trackAccept(deps, 'PARTIAL_ACCEPT', '', newText);
  fireAfterTabFileEdit(deps, newText);

  if (fullyConsumed) {
    const effect = resolveNextAction(s.nextAction);
    session.clear();
    return effect;
  }
  // Remainder stays: VS Code keeps rendering the inline suggestion's leftover
  // ghost text until the next trigger replaces it.
  return { kind: 'none' };
}

/** Peek = partial accept with the pre-state saved so revert can restore it. */
export async function peekSuggestion(deps: AcceptDeps): Promise<NextActionEffect> {
  const s = deps.session.current;
  if (!s) return { kind: 'none' };
  if (!s.savedPreState) {
    // P2 (XQA-06): save the actually-applied prefix, not ''. If the user
    // typed over part of the suggestion before peeking (appliedLength > 0),
    // revert must restore their typed text instead of wiping it.
    s.savedPreState = {
      text: s.fullText.slice(0, s.appliedLength),
      position: deps.editor.selection.active,
    };
  }
  return acceptPartialSuggestion(deps);
}

/** Revert a peeked suggestion: restore pre-state, fate REJECT. */
export async function revertSuggestion(deps: AcceptDeps): Promise<void> {
  const { session, editor } = deps;
  const s = session.current;
  if (!s || !s.savedPreState) return;

  const start = s.insertPosition;
  const end = offsetToPosition(start, s.fullText.slice(0, s.appliedLength));
  const saved = s.savedPreState;

  deps.setOwnEdit(true);
  try {
    await editor.edit((eb) => eb.replace(new vscode.Range(start, end), saved.text));
    editor.selection = new vscode.Selection(saved.position, saved.position);
  } finally {
    deps.setOwnEdit(false);
  }

  const { fileExtension } = fileParts(s.uri);
  deps.fate.record(s.requestId, 'REJECT', fileExtension);
  deps.telemetry.recordSessionEvent('rejectTab', { requestId: s.requestId, via: 'revert' });
  session.clear();
}
