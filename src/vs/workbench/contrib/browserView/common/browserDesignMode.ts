/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Shared, framework-free contract for the Integrated Browser's Design Mode.
 *
 * REA spec (feature-matrix.json, P2):
 * - `design-mode-voice`:   "Design Mode: voice input during runs" —
 *   "Mic stays available during agent runs; queue changes by voice"
 *   (evidence: deep-docs-all.md docs sweep 2026-10-18; changelog 3.1
 *   "upgraded voice input (hold Ctrl+M, batch STT, waveform UI)").
 * - `design-mode-drawing`: "Design Mode: draw regions on frozen frame" —
 *   "Circle/box regions on frozen screenshot for spatial selection"
 *   (evidence: deep-docs-all.md; dissect-browser-interaction.md §3.4 —
 *   box/scribble annotations drawn on the frozen frame, then submitted as a
 *   draft agent message).
 *
 * This module is intentionally dependency-free so its region math can be
 * unit-tested in plain node.
 */

// ---------------------------------------------------------------------------
// Enter/exit toggle UI (design-mode-enter-exit).
//
// Binary-verbatim (Cursor 3.25.9, workbench.glass.main.js, module
// "browser-design-mode-toggle.react.js"; byte offsets char==byte for the
// ASCII needles, verified by direct grep 2026-10-20):
// - Inactive toggle (component k1c): button
//   `{"aria-label":"Enter design mode",disabled,icon:"pen-nib",onClick:()=>onActiveChange(!0)}`
//   wrapped in a tooltip whose content title is `"Design Mode"`.
//   ("Enter design mode" at byte 31181920.)
// - Active pill: pen-nib icon + label span `children:"Design"`, plus a
//   close-icon exit button
//   `{"aria-label":"Exit design mode",disabled,onClick:<exit>,type:"button"}`
//   (same offset region, directly after the inactive branch).
// - The annotation toolbar (aoC) also renders an exit control whose
//   tooltip title is `"Exit Design Mode"` with button
//   `{"aria-label":"Exit design mode",icon:"x",onClick:onExit}`
//   ("Exit Design Mode" at byte 29333774).
//
// HONEST-DIVERGENCE: the binary icon name "pen-nib" is a Cursor glass
// icon-set name; the fork's codicon set has no pen-nib, so the palette
// action and the enter button use Codicon.pencil (closest fork icon),
// exactly as the existing "Toggle Design Mode" palette action does.
// The binary active pill's visible label is "Design"; the fork pill
// renders "Design Mode" (its pre-existing label) — only the toggle
// affordances below are new in this wave.
// ---------------------------------------------------------------------------

/** aria-label of the inactive state's enter button (binary-verbatim). */
export const ENTER_DESIGN_MODE_ARIA_LABEL = 'Enter design mode';

/** Tooltip title of the inactive state's toggle (binary-verbatim). */
export const DESIGN_MODE_TITLE = 'Design Mode';

/** aria-label of the active state's exit button (binary-verbatim). */
export const EXIT_DESIGN_MODE_ARIA_LABEL = 'Exit design mode';

/** Tooltip title of the active state's exit control (binary-verbatim). */
export const EXIT_DESIGN_MODE_TITLE = 'Exit Design Mode';

/** The two toggle affordances, keyed by the current active state. */
export interface IDesignModeToggleAffordance {
	/** Which button is shown: the enter button (inactive) or the pill with its exit button (active). */
	readonly showEnterButton: boolean;
	readonly showActivePill: boolean;
	/** aria-label of the state-appropriate toggle action. */
	readonly toggleAriaLabel: string;
	/** Tooltip title of the state-appropriate toggle action. */
	readonly toggleTitle: string;
}

/**
 * Pure state → affordance mapping for the enter/exit toggle UI:
 * inactive shows only the "Enter design mode" button; active shows only
 * the pill (which carries the "Exit design mode" button).
 */
export function designModeToggleAffordance(isActive: boolean): IDesignModeToggleAffordance {
	return isActive
		? { showEnterButton: false, showActivePill: true, toggleAriaLabel: EXIT_DESIGN_MODE_ARIA_LABEL, toggleTitle: EXIT_DESIGN_MODE_TITLE }
		: { showEnterButton: true, showActivePill: false, toggleAriaLabel: ENTER_DESIGN_MODE_ARIA_LABEL, toggleTitle: DESIGN_MODE_TITLE };
}

/** Context key set while Design Mode is active in the browser editor. */
export const BROWSER_DESIGN_MODE_ACTIVE_CONTEXT_KEY = 'browserDesignModeActive';

/** Command id: toggles Design Mode in the active browser editor. */
export const ToggleBrowserDesignModeCommandId = 'workbench.action.browser.toggleDesignMode';

/** Shape drawn on the frozen frame. Mirrors Cursor's box/scribble annotation kinds. */
export const enum DesignModeRegionKind {
	Box = 'box',
	Circle = 'circle',
}

/** Pixel rectangle in frozen-frame coordinates. */
export interface IDesignModePixelRect {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

/**
 * A user-drawn region on the frozen frame. Coordinates are normalized to
 * fractions of the frame (0..1) so regions survive frame resizes.
 */
export interface IDesignModeRegion {
	readonly kind: DesignModeRegionKind;
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

/**
 * Minimum drawable region size in pixels. Matches Cursor's area-select guard
 * (`area-screenshot-selected` requires bounds ≥ 5×5 — dissect-browser-interaction.md §3.4).
 */
export const DESIGN_MODE_MIN_REGION_PX = 5;

/** Clamp a pixel rect into the frame bounds, preserving direction. */
export function clampRectToFrame(rect: IDesignModePixelRect, frameWidth: number, frameHeight: number): IDesignModePixelRect {
	const x1 = Math.min(Math.max(rect.x, 0), frameWidth);
	const y1 = Math.min(Math.max(rect.y, 0), frameHeight);
	const x2 = Math.min(Math.max(rect.x + rect.width, 0), frameWidth);
	const y2 = Math.min(Math.max(rect.y + rect.height, 0), frameHeight);
	return { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
}

/** Whether the pixel rect is large enough to be a drawable region. */
export function isDrawableRegion(rect: IDesignModePixelRect): boolean {
	return rect.width >= DESIGN_MODE_MIN_REGION_PX && rect.height >= DESIGN_MODE_MIN_REGION_PX;
}

/** Convert a pixel rect on the frozen frame to a normalized region. */
export function normalizeRegionToFractions(kind: DesignModeRegionKind, rect: IDesignModePixelRect, frameWidth: number, frameHeight: number): IDesignModeRegion {
	const clamped = clampRectToFrame(rect, frameWidth, frameHeight);
	return {
		kind,
		x: frameWidth > 0 ? clamped.x / frameWidth : 0,
		y: frameHeight > 0 ? clamped.y / frameHeight : 0,
		width: frameWidth > 0 ? clamped.width / frameWidth : 0,
		height: frameHeight > 0 ? clamped.height / frameHeight : 0,
	};
}

/** Convert a normalized region back to pixel coordinates on a frame of the given size. */
export function regionToPixels(region: IDesignModeRegion, frameWidth: number, frameHeight: number): IDesignModePixelRect {
	return {
		x: region.x * frameWidth,
		y: region.y * frameHeight,
		width: region.width * frameWidth,
		height: region.height * frameHeight,
	};
}

function toPercent(value: number): string {
	return `${(value * 100).toFixed(1)}%`;
}

/** One-line human description of a region, e.g. for the agent prompt. */
export function describeRegion(region: IDesignModeRegion, index: number): string {
	return `Region ${index + 1} ${describeRegionBody(region)}`;
}

/**
 * The region description without its "Region N" prefix — the body shown as
 * the label of a pending-annotation row (Cursor's row renders the number in
 * its own span and the annotation text beside it).
 */
export function describeRegionBody(region: IDesignModeRegion): string {
	return `(${region.kind}): x=${toPercent(region.x)}, y=${toPercent(region.y)}, width=${toPercent(region.width)}, height=${toPercent(region.height)}`;
}

/**
 * The text body sent to the agent alongside the annotated frozen frame.
 * Keeps coordinates as percentages so the agent can reason spatially.
 */
export function createDesignModeAnnotationsMessage(regions: readonly IDesignModeRegion[]): string {
	const lines = [
		'Design Mode annotations on the frozen browser frame. Each region marks an area the user wants changed:',
	];
	regions.forEach((region, i) => lines.push(`- ${describeRegion(region, i)}`));
	lines.push('Apply the requested change to the marked regions.');
	return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Pending-annotations management UI (design-mode-annotation-actions).
//
// Binary-verbatim strings and templates (Cursor 3.25.9,
// workbench.glass.main.js — see docs/rea/harvest-design-mode-annotations-ui-
// 2026-10-20.md). The glass input bar groups a Send button and a pending
// chevron in one group; the pending list rows expose open/remove actions; a
// single annotation's note card exposes delete.
// ---------------------------------------------------------------------------

/**
 * Empty-state / guard string. In the binary it is thrown by the send
 * compositing path when there are no annotation points
 * (`if (points.length === 0) throw new Error("No annotation points")`);
 * the fork also renders it as the pending list's empty state.
 */
export const NO_ANNOTATION_POINTS = 'No annotation points';

/** Tooltip of the pending-count chevron in the send group. */
export const SHOW_PENDING_ANNOTATIONS_TITLE = 'Show pending annotations';

/** Tooltip of the Send button in the send group (when sending is not blocked). */
export const SEND_DESIGN_ANNOTATIONS_TO_AGENT_TITLE = 'Send design annotations to agent';

/** aria-label of the send button group (Send button + pending chevron). */
export const SEND_ANNOTATIONS_GROUP_LABEL = 'Send annotations';

/** Main action of a pending-annotation row (opens that annotation). */
export const OPEN_ANNOTATION_TITLE = 'Open annotation';

/** Trash action on a single annotation's detail (note-card actions in the binary). */
export const DELETE_ANNOTATION_TITLE = 'Delete annotation';

/**
 * Binary `EZv`: the count label used by the send group —
 * `${count} annotation` / `${count} annotations`.
 */
export function annotationCountLabel(count: number): string {
	return `${count} ${count === 1 ? 'annotation' : 'annotations'}`;
}

/** Send button label — binary template: `Send ${countLabel} to agent`. */
export function sendAnnotationsToAgentLabel(count: number): string {
	return `Send ${annotationCountLabel(count)} to agent`;
}

/** Pending chevron aria-label — binary template: `${countLabel} pending; show details`. */
export function pendingAnnotationsAriaLabel(count: number): string {
	return `${annotationCountLabel(count)} pending; show details`;
}

/** Per-row remove aria-label — binary template: `Remove annotation ${number}` (1-based). */
export function removeAnnotationAriaLabel(number: number): string {
	return `Remove annotation ${number}`;
}

/** Pending row label — binary template: `${number}. ${text}` (number span + text). */
export function pendingAnnotationRowLabel(region: IDesignModeRegion, index: number): string {
	return `${index + 1}. ${describeRegionBody(region)}`;
}
