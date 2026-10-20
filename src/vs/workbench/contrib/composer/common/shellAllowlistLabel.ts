/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Shell-allowlist label construction — Cursor parity (GAPS-22B, auditor run 30).
 *
 * Binary evidence: `workbench.glass.main.js` (Cursor 3.25.9), module
 * `"shell-allowlist-label-truncation.js"`:
 *
 *   sEa = "Always Run '"
 *   function ycp(t) {
 *     if (!t?.length) return null;
 *     const e = t[0],
 *       n = t.length === 1 ? "'" : `' + ${t.length - 1}`;
 *     return {
 *       prefix: sEa,
 *       command: e,
 *       suffix: n,
 *       fullLabel: `${sEa}${e}${n}`,
 *       commandCount: t.length,
 *     };
 *   }
 *
 * `ycp` consumes allowlist-candidate LABELS:
 *   `function ZpS(t){return t.label}` / `function JpS(t){return t.label}`
 * Consumption (terminal review UI):
 *   `const rt = Je, it = rt?.fullLabel ?? Pe ?? be,`
 *   `Ve = Fe && qe ? "Always Run Selected" : it;`
 *
 * Case distinction (binary-verified, do NOT normalize):
 *   - BUTTON label = title-case "Always Run" (the `sEa` prefix).
 *   - RADIO items = sentence-case, via
 *     `function XvS(t){switch(t){case"alwaysAsk":return"Always ask";
 *     case"alwaysRun":return"Always run";default:return t}}`.
 *   - Actions menu = sentence-case:
 *     `{kind:"actions",label:"Always run",items:b}` — only when
 *     `allowlistCandidates.length > 0 && (autorunMode === USE_ALLOWLIST ||
 *     autorunMode === SMART_AUTO)`, with
 *     `items: allowlistCandidates.map(k => ({id:"allowlist-"+k.id,
 *     label:k.label,description:k.description,...}))`.
 *
 * HONEST NOTES:
 *  1. Despite the module name ("…-truncation.js"), `ycp` itself performs NO
 *     truncation of the command text — 1 command yields
 *     `Always Run '<cmd>'`, N commands yield `Always Run '<first>' + N`
 *     (N = commands.length - 1), verbatim, untruncated. Any visual
 *     truncation is CSS-side; no truncation rule is invented here.
 *  2. The per-option fallbacks `Pe ?? be` resolve through Cursor's `Ev`
 *     nls enum client-side (e.g. `Ev.runButton`, `Ev.runButtonPrimary`,
 *     `Ev.skipButton` — enum keys observed, values NOT statically
 *     resolvable). They are NOT fabricated: callers keep their existing
 *     honest fallback labels when `buildShellAllowlistLabel` returns null.
 *
 * Pure module — no platform imports, unit-testable.
 */

/**
 * Verbatim prefix of the shell-approval "always run" BUTTON label
 * (binary `sEa`). Title-case — distinct from the sentence-case radio /
 * actions-menu strings below.
 */
export const ALWAYS_RUN_BUTTON_LABEL_PREFIX = 'Always Run \'';

/**
 * Verbatim button label when the review UI is in a selection state
 * (binary: `Fe && qe ? "Always Run Selected" : it`).
 */
export const ALWAYS_RUN_SELECTED_BUTTON_LABEL = 'Always Run Selected';

/**
 * Verbatim label of the actions menu (`{kind:"actions",label:"Always run"}`).
 * Sentence-case — NOT the same string as the button prefix.
 */
export const ALLOWLIST_ACTIONS_MENU_LABEL = 'Always run';

/** Verbatim radio-item label for the always-run mode (binary `XvS`). */
export const ALWAYS_RUN_RADIO_LABEL = 'Always run';

/** Verbatim radio-item label for the always-ask mode (binary `XvS`). */
export const ALWAYS_ASK_RADIO_LABEL = 'Always ask';

export interface ShellAllowlistLabel {
	/** Verbatim `Always Run '` prefix (binary `prefix: sEa`). */
	readonly prefix: string;
	/** First candidate label (binary `command: e`, where `e = t[0]`). */
	readonly command: string;
	/**
	 * `'` for a single command; `' + N` (N = remaining count) otherwise —
	 * binary `n = t.length === 1 ? "'" : `' + ${t.length - 1}``.
	 */
	readonly suffix: string;
	/** Full button label: `${prefix}${command}${suffix}`. */
	readonly fullLabel: string;
	/** Candidate count (binary `commandCount: t.length`). */
	readonly commandCount: number;
}

/**
 * Build the shell-approval "always run" button label from allowlist-candidate
 * LABELS (binary `ycp`). Exact port:
 *   - empty input → null (binary: `if (!t?.length) return null`)
 *   - 1 command → `Always Run '<command>'`
 *   - N commands → `Always Run '<first>' + ${N - 1}`
 */
export function buildShellAllowlistLabel(commands: readonly string[] | undefined | null): ShellAllowlistLabel | null {
	if (!commands?.length) {
		return null;
	}
	const command = commands[0];
	const suffix = commands.length === 1 ? '\'' : `' + ${commands.length - 1}`;
	return {
		prefix: ALWAYS_RUN_BUTTON_LABEL_PREFIX,
		command,
		suffix,
		fullLabel: `${ALWAYS_RUN_BUTTON_LABEL_PREFIX}${command}${suffix}`,
		commandCount: commands.length,
	};
}

/**
 * Radio-item label for an allowlist mode id — port of binary `XvS`:
 * `case"alwaysAsk":return"Always ask";case"alwaysRun":return"Always run";
 * default:return t`. Sentence-case; unknown ids pass through untouched
 * (binary `default: return t`), never fabricated.
 */
export function allowlistModeRadioLabel(mode: string): string {
	switch (mode) {
		case 'alwaysAsk':
			return ALWAYS_ASK_RADIO_LABEL;
		case 'alwaysRun':
			return ALWAYS_RUN_RADIO_LABEL;
		default:
			return mode;
	}
}
