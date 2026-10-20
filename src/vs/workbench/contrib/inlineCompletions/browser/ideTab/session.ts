/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: In-flight Tab suggestion state — rewritten from
// extensions/ide-agent/src/tab/session.ts. vscode API types replaced with
// core: `Position` (vs/editor/common/core, 1-based lineNumber/column) and
// `URI` (vs/base/common/uri). (Cursor analog: `cppSuggestionService`.)

/**
 * In-flight suggestion state — port of Cursor's `cppSuggestionService`
 * (current/visible/hidden suggestion + green highlights bookkeeping).
 */

import { Position } from '../../../../../editor/common/core/position.js';
import { URI } from '../../../../../base/common/uri.js';
import { IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { NextAction } from './types.js';

export interface ShownSuggestion {
	requestId: string;
	uri: URI;
	/** Document version the suggestion was computed against (ITextModel.getVersionId()). */
	version: number;
	/** Full suggestion text (inserted at insertPosition). */
	fullText: string;
	/** Core Position (1-based lineNumber/column). */
	insertPosition: Position;
	/** Chars of fullText already applied via partial accepts. */
	appliedLength: number;
	nextAction?: NextAction;
	/** True while a partial accept left a remainder (ghosted). */
	partialRemainder: boolean;
	/** Pre-peek document state, saved for revert. */
	savedPreState?: { text: string; position: Position };
	shownAt: number;
	modelId?: string;
	modelVersion?: string;
}

export class TabSession {
	private _current: ShownSuggestion | undefined;
	private readonly changeListeners = new Set<() => void>();

	get current(): ShownSuggestion | undefined {
		return this._current;
	}

	/**
	 * GAPS-115: fires after every set()/clear(). The workbench contribution
	 * uses it to recompute the `cpp.shouldAcceptTab` context key — the analog
	 * of Cursor cppService's `this.suggestion.event(() =>
	 * this.updateShouldAcceptTabContextKey())` subscription
	 * (workbench.desktop.main.js 3.25.9, @39856233 area).
	 */
	onDidChange(listener: () => void): IDisposable {
		this.changeListeners.add(listener);
		return toDisposable(() => this.changeListeners.delete(listener));
	}

	private fireDidChange(): void {
		for (const listener of [...this.changeListeners]) listener();
	}

	set(s: ShownSuggestion): void {
		this._current = s;
		this.fireDidChange();
	}

	clear(): void {
		this._current = undefined;
		this.fireDidChange();
	}

	/** True when the given document+version still matches the live suggestion. */
	isCurrentFor(uri: URI, version: number): boolean {
		const c = this._current;
		return !!c && c.uri.toString() === uri.toString() && c.version === version;
	}
}

/**
 * Advance a core Position by `text` (handles multi-line). Exported for tests.
 * Core positions are 1-based (lineNumber/column); single-line advance uses
 * `Position.delta`, which preserves 1-based semantics.
 */
export function offsetToPosition(start: Position, text: string): Position {
	const lines = text.split('\n');
	if (lines.length === 1) return start.delta(0, text.length);
	return new Position(start.lineNumber + lines.length - 1, lines[lines.length - 1]!.length + 1);
}
