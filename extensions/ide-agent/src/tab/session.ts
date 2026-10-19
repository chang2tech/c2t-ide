/**
 * In-flight suggestion state — port of Cursor's `cppSuggestionService`
 * (current/visible/hidden suggestion + green highlights bookkeeping).
 */

import * as vscode from 'vscode';
import { NextAction } from './types';

export interface ShownSuggestion {
  requestId: string;
  uri: vscode.Uri;
  /** Document version the suggestion was computed against. */
  version: number;
  /** Full suggestion text (inserted at insertPosition). */
  fullText: string;
  insertPosition: vscode.Position;
  /** Chars of fullText already applied via partial accepts. */
  appliedLength: number;
  nextAction?: NextAction;
  /** True while a partial accept left a remainder (ghosted). */
  partialRemainder: boolean;
  /** Pre-peek document state, saved for revert. */
  savedPreState?: { text: string; position: vscode.Position };
  shownAt: number;
  modelId?: string;
  modelVersion?: string;
}

export class TabSession {
  private _current: ShownSuggestion | undefined;

  get current(): ShownSuggestion | undefined {
    return this._current;
  }

  set(s: ShownSuggestion): void {
    this._current = s;
  }

  clear(): void {
    this._current = undefined;
  }

  /** True when the given document+version still matches the live suggestion. */
  isCurrentFor(uri: vscode.Uri, version: number): boolean {
    const c = this._current;
    return !!c && c.uri.toString() === uri.toString() && c.version === version;
  }
}

/** Advance a Position by `text` (handles multi-line). Exported for tests. */
export function offsetToPosition(start: vscode.Position, text: string): vscode.Position {
  const lines = text.split('\n');
  if (lines.length === 1) return start.translate(0, text.length);
  return new vscode.Position(start.line + lines.length - 1, lines[lines.length - 1]!.length);
}
