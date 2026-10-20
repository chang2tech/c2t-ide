/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Tab completion shared types — moved verbatim from
// extensions/ide-agent/src/tab/types.ts. No vscode imports here — pure types.
// (Cursor analog: the `cpp.*` wire types in the cppService client.)

/** Trigger kinds that can fire a Tab suggestion request (enum YI in Cursor). */
export type TriggerKind =
	| 'unknown'
	| 'line_change'
	| 'typing'
	// Wire-spec kind only: Cursor fires this while Alt/Option is held
	// (`eventShouldKillPrevCpp`). The extension host cannot observe a bare
	// modifier keydown, so the client never fires it; the kill half of the
	// behavior is exposed as `ide.abortTabRequests` (Alt+K). P1 (QA-FILE-06).
	| 'option_hold'
	| 'lint_errors'
	| 'parameter_hints'
	| 'cursor_prediction'
	| 'editor_change'
	// Wire-spec kind only: the workbench never fires this (see REFIRE_TRIGGERS
	// note in provider.ts).
	| 'lsp_suggestions'
	| 'manual_trigger';

/** Exactly three fates per request, tracked by requestId (voi.* in Cursor). */
export type TabFate = 'ACCEPT' | 'PARTIAL_ACCEPT' | 'REJECT';

/** Suggestion renderer selection. */
export type TabRenderMode = 'ghostText' | 'previewBox';

/** Server-attached next action delivered with a suggestion. */
export type NextAction =
	| {
		action: 'fusedCursorPrediction';
		fusedCursorPrediction: {
			/** File URI of the predicted jump target (may differ from current file — multifile). */
			uri: string;
			lineNumber: number;
			character?: number;
			/** When true, auto-fire a Tab request at the jump target after accept. */
			shouldRetrigger?: boolean;
		};
	}
	| { action: 'nextEdit' }
	| { action: 'followup'; onAcceptDisplayId: string };

/** A fully-collected suggestion from the backend. */
export interface TabSuggestion {
	requestId: string;
	/** Full replacement/insert text of the suggestion. */
	text: string;
	modelId?: string;
	modelVersion?: string;
	nextAction?: NextAction;
	/** Chained follow-up display id (matches onAcceptDisplayId of a prior suggestion). */
	displayId?: string;
}

/** Server-driven cpp config (subset we honour client-side). */
export interface TabServerConfig {
	isOn: boolean;
	isGhostText: boolean;
	clientDebounceDurationMillis?: number;
	globalDebounceDurationMillis?: number;
	maxConcurrentRequests?: number;
	recentlyRejectedEditThresholds?: number[];
	maxNumberOfClearedSuggestionsSinceLastAccept?: number;
	enableRvfTracking?: boolean;
}

/** Client-side config read from workbench settings (ide.tab.*). */
export interface TabClientConfig {
	enabled: boolean;
	enablePartialAccepts: boolean;
	disabledLanguages: string[];
	ignorePatterns: string[];
	model: string;
	maxConcurrentRequests: number;
	telemetryEnabled: boolean;
	promptDisableCopilot: boolean;
	/** Delay (ms) before requesting a suggestion after typing stops. */
	suggestionDelayMs: number;
	/** Offer suggestions inside comments. */
	suggestionWhileCommenting: boolean;
}

export const DEFAULT_CLIENT_CONFIG: TabClientConfig = {
	enabled: true,
	enablePartialAccepts: true,
	disabledLanguages: [],
	ignorePatterns: [],
	model: '',
	maxConcurrentRequests: 4,
	telemetryEnabled: true,
	promptDisableCopilot: true,
	suggestionDelayMs: 25,
	suggestionWhileCommenting: true,
};

/** 5M-char file-size gate (quu=5e6 in Cursor). */
export const MAX_FILE_CHARS = 5_000_000;

/** Snooze durations offered by `ide.snoozeTabCompletion` (1m–3h). */
export const SNOOZE_OPTIONS_MS: Array<{ label: string; ms: number }> = [
	{ label: '1 minute', ms: 60_000 },
	{ label: '5 minutes', ms: 5 * 60_000 },
	{ label: '15 minutes', ms: 15 * 60_000 },
	{ label: '30 minutes', ms: 30 * 60_000 },
	{ label: '1 hour', ms: 60 * 60_000 },
	{ label: '3 hours', ms: 3 * 60 * 60_000 },
];
