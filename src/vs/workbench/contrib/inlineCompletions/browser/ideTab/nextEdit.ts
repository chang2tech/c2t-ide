/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Next-edit prediction handling — moved verbatim from
// extensions/ide-agent/src/tab/nextEdit.ts. Pure; the workbench-specific
// application (opening editors, moving cursors, refiring) lives in
// tabContribution.ts so this stays testable.

/**
 * Next-edit prediction handling — port of Cursor's `displayNextActionIfAvailable`.
 *
 * After generation the server may attach `nextAction` to a suggestion:
 *  - fusedCursorPrediction: render a jump target (possibly in another file —
 *    multifile via cursorPredictionService) and optionally auto-fire a Tab
 *    request there (`shouldRetriggerCpp`).
 *  - nextEdit: the next edit arrives as a fresh suggestion (refire trigger).
 *  - followup (onAcceptDisplayId): display a chained follow-up suggestion
 *    immediately on accept.
 *
 * This module resolves a NextAction to a pure effect descriptor; the
 * workbench-specific application (opening editors, moving cursors, refiring)
 * lives in tabContribution.ts so this stays testable.
 */

import { NextAction } from './types.js';

export type NextActionEffect =
	| {
		kind: 'jump';
		uri: string;
		line: number;
		character: number;
		/** Auto-fire a Tab request at the jump target. */
		retrigger: boolean;
	}
	| { kind: 'refire' }
	| { kind: 'followup'; displayId: string }
	| { kind: 'none' };

/** Resolve a server-attached nextAction into an effect descriptor. Pure. */
export function resolveNextAction(action: NextAction | undefined): NextActionEffect {
	if (!action) return { kind: 'none' };
	switch (action.action) {
		case 'fusedCursorPrediction': {
			const p = action.fusedCursorPrediction;
			return {
				kind: 'jump',
				uri: p.uri,
				line: Math.max(0, p.lineNumber),
				character: Math.max(0, p.character ?? 0),
				retrigger: p.shouldRetrigger ?? false,
			};
		}
		case 'nextEdit':
			return { kind: 'refire' };
		case 'followup':
			return { kind: 'followup', displayId: action.onAcceptDisplayId };
	}
}

/**
 * Registry of chained follow-up suggestions keyed by display id
 * (Cursor: `followupSuggestions.getAndEvictMatchingSuggestion(id)`).
 */
export class FollowupRegistry<T> {
	private map = new Map<string, T>();

	set(displayId: string, value: T): void {
		this.map.set(displayId, value);
	}

	/** Get and evict — a follow-up is consumed exactly once. */
	getAndEvict(displayId: string): T | undefined {
		const v = this.map.get(displayId);
		if (v !== undefined) this.map.delete(displayId);
		return v;
	}

	size(): number {
		return this.map.size;
	}
}
