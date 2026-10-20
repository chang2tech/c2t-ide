/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import {
	BROWSER_DESIGN_MODE_ACTIVE_CONTEXT_KEY,
	DELETE_ANNOTATION_TITLE,
	DESIGN_MODE_TITLE,
	ENTER_DESIGN_MODE_ARIA_LABEL,
	EXIT_DESIGN_MODE_ARIA_LABEL,
	EXIT_DESIGN_MODE_TITLE,
	designModeToggleAffordance,
	DESIGN_MODE_MIN_REGION_PX,
	DesignModeRegionKind,
	NO_ANNOTATION_POINTS,
	OPEN_ANNOTATION_TITLE,
	SEND_ANNOTATIONS_GROUP_LABEL,
	SEND_DESIGN_ANNOTATIONS_TO_AGENT_TITLE,
	SHOW_PENDING_ANNOTATIONS_TITLE,
	ToggleBrowserDesignModeCommandId,
	annotationCountLabel,
	clampRectToFrame,
	createDesignModeAnnotationsMessage,
	describeRegion,
	describeRegionBody,
	isDrawableRegion,
	normalizeRegionToFractions,
	pendingAnnotationRowLabel,
	pendingAnnotationsAriaLabel,
	regionToPixels,
	removeAnnotationAriaLabel,
	sendAnnotationsToAgentLabel,
} from '../../common/browserDesignMode.js';

suite('Browser Design Mode (common contract)', () => {

	test('command id and context key are stable', () => {
		assert.strictEqual(ToggleBrowserDesignModeCommandId, 'workbench.action.browser.toggleDesignMode');
		assert.strictEqual(BROWSER_DESIGN_MODE_ACTIVE_CONTEXT_KEY, 'browserDesignModeActive');
	});

	test('minimum region size matches the area-select guard (5px)', () => {
		assert.strictEqual(DESIGN_MODE_MIN_REGION_PX, 5);
		assert.strictEqual(isDrawableRegion({ x: 0, y: 0, width: 5, height: 5 }), true);
		assert.strictEqual(isDrawableRegion({ x: 0, y: 0, width: 4, height: 5 }), false);
		assert.strictEqual(isDrawableRegion({ x: 0, y: 0, width: 5, height: 4 }), false);
		assert.strictEqual(isDrawableRegion({ x: 0, y: 0, width: 0, height: 0 }), false);
	});

	test('clampRectToFrame keeps rects inside the frame', () => {
		assert.deepStrictEqual(
			clampRectToFrame({ x: -10, y: -20, width: 50, height: 60 }, 100, 100),
			{ x: 0, y: 0, width: 40, height: 40 }
		);
		assert.deepStrictEqual(
			clampRectToFrame({ x: 80, y: 90, width: 50, height: 50 }, 100, 100),
			{ x: 80, y: 90, width: 20, height: 10 }
		);
		// Dragged backwards (negative width/height) normalizes direction.
		assert.deepStrictEqual(
			clampRectToFrame({ x: 60, y: 60, width: -20, height: -30 }, 100, 100),
			{ x: 40, y: 30, width: 20, height: 30 }
		);
	});

	test('normalizeRegionToFractions converts pixels to 0..1 fractions', () => {
		const region = normalizeRegionToFractions(DesignModeRegionKind.Box, { x: 10, y: 20, width: 30, height: 40 }, 100, 200);
		assert.strictEqual(region.kind, DesignModeRegionKind.Box);
		assert.strictEqual(region.x, 0.1);
		assert.strictEqual(region.y, 0.1);
		assert.strictEqual(region.width, 0.3);
		assert.strictEqual(region.height, 0.2);
	});

	test('normalizeRegionToFractions clamps out-of-frame drags', () => {
		const region = normalizeRegionToFractions(DesignModeRegionKind.Circle, { x: 90, y: 90, width: 50, height: 50 }, 100, 100);
		assert.strictEqual(region.x, 0.9);
		assert.strictEqual(region.width, 0.1);
		assert.strictEqual(region.y, 0.9);
		assert.strictEqual(region.height, 0.1);
	});

	test('regionToPixels round-trips normalizeRegionToFractions', () => {
		const original = { x: 12, y: 34, width: 56, height: 78 };
		const region = normalizeRegionToFractions(DesignModeRegionKind.Circle, original, 200, 400);
		const back = regionToPixels(region, 200, 400);
		assert.ok(Math.abs(back.x - original.x) < 1e-9);
		assert.ok(Math.abs(back.y - original.y) < 1e-9);
		assert.ok(Math.abs(back.width - original.width) < 1e-9);
		assert.ok(Math.abs(back.height - original.height) < 1e-9);
	});

	test('describeRegion formats a one-line spatial description', () => {
		const text = describeRegion({ kind: DesignModeRegionKind.Circle, x: 0.1, y: 0.2, width: 0.3, height: 0.4 }, 0);
		assert.strictEqual(text, 'Region 1 (circle): x=10.0%, y=20.0%, width=30.0%, height=40.0%');
	});

	test('createDesignModeAnnotationsMessage lists all regions for the agent', () => {
		const message = createDesignModeAnnotationsMessage([
			{ kind: DesignModeRegionKind.Box, x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
			{ kind: DesignModeRegionKind.Circle, x: 0.5, y: 0.5, width: 0.1, height: 0.1 },
		]);
		assert.ok(message.includes('Region 1 (box):'));
		assert.ok(message.includes('Region 2 (circle):'));
		assert.ok(message.includes('frozen browser frame'));
	});
});

/**
 * design-mode-annotation-actions: pending-annotations management strings.
 *
 * All strings are binary-verbatim from Cursor 3.25.9
 * (workbench.glass.main.js; see
 * docs/rea/harvest-design-mode-annotations-ui-2026-10-20.md):
 * - "No annotation points" — thrown when the send path finds no points.
 * - "Show pending annotations" — tooltip of the pending-count chevron.
 * - "Send design annotations to agent" — tooltip of the Send button.
 * - "Send annotations" — aria-label of the send button group.
 * - "Remove annotation ${number}" — per-row remove aria-label template.
 * - "Open annotation" — row main action.
 * - "Delete annotation" — trash action on the annotation detail (note card).
 * Count-label template `EZv`: `${count} annotation` / `${count} annotations`.
 */
suite('Browser Design Mode pending-annotations labels', () => {

	test('verbatim string constants', () => {
		assert.strictEqual(NO_ANNOTATION_POINTS, 'No annotation points');
		assert.strictEqual(SHOW_PENDING_ANNOTATIONS_TITLE, 'Show pending annotations');
		assert.strictEqual(SEND_DESIGN_ANNOTATIONS_TO_AGENT_TITLE, 'Send design annotations to agent');
		assert.strictEqual(SEND_ANNOTATIONS_GROUP_LABEL, 'Send annotations');
		assert.strictEqual(OPEN_ANNOTATION_TITLE, 'Open annotation');
		assert.strictEqual(DELETE_ANNOTATION_TITLE, 'Delete annotation');
	});

	test('annotationCountLabel pluralizes the binary EZv way', () => {
		assert.strictEqual(annotationCountLabel(0), '0 annotations');
		assert.strictEqual(annotationCountLabel(1), '1 annotation');
		assert.strictEqual(annotationCountLabel(2), '2 annotations');
	});

	test('sendAnnotationsToAgentLabel follows `Send ${p} to agent`', () => {
		assert.strictEqual(sendAnnotationsToAgentLabel(1), 'Send 1 annotation to agent');
		assert.strictEqual(sendAnnotationsToAgentLabel(3), 'Send 3 annotations to agent');
	});

	test('pendingAnnotationsAriaLabel follows `${p} pending; show details`', () => {
		assert.strictEqual(pendingAnnotationsAriaLabel(2), '2 annotations pending; show details');
	});

	test('removeAnnotationAriaLabel follows `Remove annotation ${number}`', () => {
		assert.strictEqual(removeAnnotationAriaLabel(1), 'Remove annotation 1');
		assert.strictEqual(removeAnnotationAriaLabel(4), 'Remove annotation 4');
	});

	test('pendingAnnotationRowLabel follows `${number}. ${body}`', () => {
		const text = pendingAnnotationRowLabel({ kind: DesignModeRegionKind.Box, x: 0.1, y: 0.2, width: 0.3, height: 0.4 }, 1);
		assert.strictEqual(text, '2. (box): x=10.0%, y=20.0%, width=30.0%, height=40.0%');
	});

	test('describeRegionBody strips the Region N prefix', () => {
		const body = describeRegionBody({ kind: DesignModeRegionKind.Circle, x: 0.1, y: 0.2, width: 0.3, height: 0.4 });
		assert.strictEqual(body, '(circle): x=10.0%, y=20.0%, width=30.0%, height=40.0%');
		assert.strictEqual(describeRegion({ kind: DesignModeRegionKind.Circle, x: 0.1, y: 0.2, width: 0.3, height: 0.4 }, 0), `Region 1 ${body}`);
	});
});

suite('Browser Design Mode enter/exit toggle UI (design-mode-enter-exit)', () => {

	test('toggle labels are the binary-verbatim strings', () => {
		// Cursor 3.25.9 workbench.glass.main.js, module
		// browser-design-mode-toggle.react.js (byte 31181920 region) and the
		// annotation toolbar's "Exit Design Mode" tooltip (byte 29333774).
		assert.strictEqual(ENTER_DESIGN_MODE_ARIA_LABEL, 'Enter design mode');
		assert.strictEqual(DESIGN_MODE_TITLE, 'Design Mode');
		assert.strictEqual(EXIT_DESIGN_MODE_ARIA_LABEL, 'Exit design mode');
		assert.strictEqual(EXIT_DESIGN_MODE_TITLE, 'Exit Design Mode');
	});

	test('inactive state shows only the enter button', () => {
		const affordance = designModeToggleAffordance(false);
		assert.strictEqual(affordance.showEnterButton, true);
		assert.strictEqual(affordance.showActivePill, false);
		assert.strictEqual(affordance.toggleAriaLabel, 'Enter design mode');
		assert.strictEqual(affordance.toggleTitle, 'Design Mode');
	});

	test('active state shows only the pill with the exit button', () => {
		const affordance = designModeToggleAffordance(true);
		assert.strictEqual(affordance.showEnterButton, false);
		assert.strictEqual(affordance.showActivePill, true);
		assert.strictEqual(affordance.toggleAriaLabel, 'Exit design mode');
		assert.strictEqual(affordance.toggleTitle, 'Exit Design Mode');
	});

	test('exactly one affordance is visible in each state', () => {
		for (const active of [false, true]) {
			const affordance = designModeToggleAffordance(active);
			assert.notStrictEqual(affordance.showEnterButton, affordance.showActivePill);
		}
	});
});
