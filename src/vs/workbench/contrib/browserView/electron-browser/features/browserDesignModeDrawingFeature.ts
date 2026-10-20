/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * design-mode-drawing — Design Mode browser pill: drawing/sketch input.
 *
 * REA spec (feature-matrix.json, P2): "Design Mode: draw regions on frozen frame" —
 * "Circle/box regions on frozen screenshot for spatial selection"
 * (evidence: deep-docs-all.md docs sweep 2026-10-18; dissect-browser-interaction.md
 * §3.4 — box/scribble annotations drawn on the frozen frame, then submitted as
 * a draft agent message).
 *
 * Flow: the user picks the circle or box tool in the Design Mode pill, a frozen
 * frame of the page is captured and shown in an overlay canvas, regions are
 * drawn with the pointer, and "Send" attaches the annotated frame plus the
 * region list to chat as a draft for the agent.
 */

import { $, addDisposableListener, EventType } from '../../../../../base/browser/dom.js';
import { decodeBase64, encodeBase64 } from '../../../../../base/common/buffer.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { localize } from '../../../../../nls.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IChatRequestVariableEntry } from '../../../chat/common/attachments/chatVariableEntries.js';
import { BrowserEditor, BrowserEditorContribution } from '../browserEditor.js';
import { BrowserDesignModeContribution } from './browserDesignModeFeature.js';
import { BrowserEditorChatIntegration } from './browserEditorChatFeatures.js';
import {
	DELETE_ANNOTATION_TITLE,
	DesignModeRegionKind,
	IDesignModePixelRect,
	IDesignModeRegion,
	NO_ANNOTATION_POINTS,
	OPEN_ANNOTATION_TITLE,
	SEND_ANNOTATIONS_GROUP_LABEL,
	SEND_DESIGN_ANNOTATIONS_TO_AGENT_TITLE,
	SHOW_PENDING_ANNOTATIONS_TITLE,
	clampRectToFrame,
	createDesignModeAnnotationsMessage,
	describeRegionBody,
	isDrawableRegion,
	normalizeRegionToFractions,
	pendingAnnotationsAriaLabel,
	regionToPixels,
	removeAnnotationAriaLabel,
	sendAnnotationsToAgentLabel,
} from '../../common/browserDesignMode.js';

/** Stroke color used for committed regions and the live preview. */
const REGION_STROKE = '#e5484d';
const REGION_FILL = 'rgba(229, 72, 77, 0.12)';

export class BrowserDesignModeDrawingContribution extends BrowserEditorContribution {

	private readonly _circleButton: Button;
	private readonly _boxButton: Button;
	private readonly _sendButton: Button;
	private readonly _pendingButton: Button;
	private readonly _clearButton: Button;

	private _tool: DesignModeRegionKind | undefined;
	private _regions: IDesignModeRegion[] = [];

	/**
	 * Pending-annotations list state (design-mode-annotation-actions): the
	 * drawn regions ARE the pending annotations until they are sent. The
	 * panel lists them; `_openedIndex` is the annotation whose detail
	 * (with the "Delete annotation" action) is expanded.
	 */
	private _pendingListOpen = false;
	private _openedIndex: number | undefined;
	private readonly _pendingPanel: HTMLElement;

	private readonly _overlay: HTMLElement;
	private readonly _frameImg: HTMLImageElement;
	private readonly _canvas: HTMLCanvasElement;
	private _frameNaturalWidth = 0;
	private _frameNaturalHeight = 0;
	private _dragStart: { x: number; y: number } | undefined;
	private _dragCurrent: IDesignModePixelRect | undefined;

	constructor(
		editor: BrowserEditor,
		@ILogService private readonly logService: ILogService,
	) {
		super(editor);

		const makeToolButton = (icon: string, title: string) => {
			const button = this._register(new Button($('.browser-design-mode-tool'), {
				supportIcons: true,
				title,
			}));
			button.element.classList.add('browser-design-mode-tool-button');
			button.label = icon;
			return button;
		};

		this._circleButton = makeToolButton('$(circle-large)', localize('browser.designModeCircle', "Draw circle region on frozen frame"));
		this._boxButton = makeToolButton('$(primitive-square)', localize('browser.designModeBox', "Draw box region on frozen frame"));
		// Send annotations to agent — binary-verbatim tooltip/label template
		// (Cursor 3.25.9 workbench.glass.main.js): the Send button carries the
		// "Send design annotations to agent" tooltip and the label
		// `Send ${count} annotation(s) to agent`.
		this._sendButton = this._register(new Button($('.browser-design-mode-send-button'), {
			title: localize('browser.designModeSend', SEND_DESIGN_ANNOTATIONS_TO_AGENT_TITLE),
		}));
		this._sendButton.element.classList.add('browser-design-mode-tool-button');
		// Pending-annotations chevron — binary-verbatim: tooltip "Show pending
		// annotations", aria-label `${count} annotation(s) pending; show
		// details`. Toggles the pending-annotations list panel.
		this._pendingButton = makeToolButton('$(chevron-down)', localize('browser.designModeShowPending', SHOW_PENDING_ANNOTATIONS_TITLE));
		this._clearButton = makeToolButton('$(trash)', localize('browser.designModeClear', "Clear drawn regions"));

		const designMode = editor.getContribution(BrowserDesignModeContribution);
		if (!designMode) {
			this.logService.warn('BrowserDesignModeDrawingContribution: no design-mode contribution found; tools not mounted.');
		} else {
			// Send group — binary-verbatim: the Send button and the pending
			// chevron live in one group labelled "Send annotations".
			const sendGroup = $('.browser-design-mode-send-group');
			sendGroup.setAttribute('role', 'group');
			sendGroup.setAttribute('aria-label', SEND_ANNOTATIONS_GROUP_LABEL);
			sendGroup.appendChild(this._sendButton.element);
			sendGroup.appendChild(this._pendingButton.element);
			designMode.pillTools.appendChild(this._circleButton.element);
			designMode.pillTools.appendChild(this._boxButton.element);
			designMode.pillTools.appendChild(sendGroup);
			designMode.pillTools.appendChild(this._clearButton.element);
			this._register(designMode.onDidChangeActive(active => {
				if (!active) {
					this._deactivateTool();
					this._closePendingPanel();
				}
			}));
		}

		this._register(this._circleButton.onDidClick(() => this._toggleTool(DesignModeRegionKind.Circle)));
		this._register(this._boxButton.onDidClick(() => this._toggleTool(DesignModeRegionKind.Box)));
		this._register(this._sendButton.onDidClick(() => void this._sendToAgent()));
		this._register(this._pendingButton.onDidClick(() => this._togglePendingPanel()));
		this._register(this._clearButton.onDidClick(() => this._clearRegions()));

		// Pending-annotations list panel. Rendered into the browser container
		// (like the frozen-frame overlay); one delegated click listener serves
		// every row so re-renders never leak listeners.
		this._pendingPanel = $('.browser-design-mode-pending-panel');
		this._register(addDisposableListener(this._pendingPanel, EventType.CLICK, e => this._onPendingPanelClick(e)));

		// Frozen-frame overlay. It is NOT a static widget: it is attached to the
		// browser container only while a draw tool is active, and detached
		// afterwards. The structural add/remove is observed by the
		// BrowserOverlayManager (the overlay is a tracked overlay type), which
		// hides the native browser view while drawing — a native
		// WebContentsView would otherwise paint above this DOM overlay.
		this._overlay = $('.browser-design-mode-overlay');
		this._frameImg = document.createElement('img');
		this._frameImg.className = 'browser-design-mode-frame';
		this._frameImg.draggable = false;
		this._canvas = document.createElement('canvas');
		this._canvas.className = 'browser-design-mode-canvas';
		this._overlay.appendChild(this._frameImg);
		this._overlay.appendChild(this._canvas);

		this._register(addDisposableListener(this._canvas, EventType.POINTER_DOWN, e => this._onPointerDown(e as PointerEvent)));
		this._register(addDisposableListener(this._canvas, EventType.POINTER_MOVE, e => this._onPointerMove(e as PointerEvent)));
		this._register(addDisposableListener(this._canvas, EventType.POINTER_UP, e => this._onPointerUp(e as PointerEvent)));
		// `pointercancel` has no EventType constant; the listener API accepts the raw event name.
		this._register(addDisposableListener(this._canvas, 'pointercancel', () => this._cancelDrag()));
		this._updateToolButtons();
	}

	/** Active draw tool, if any. */
	get activeTool(): DesignModeRegionKind | undefined { return this._tool; }

	/** Committed regions (normalized to the frozen frame). */
	get regions(): readonly IDesignModeRegion[] { return this._regions; }

	/** Whether the frozen-frame overlay is currently attached. */
	get isOverlayAttached(): boolean { return this._overlay.isConnected; }

	/**
	 * Attach the overlay to the browser container. The BrowserOverlayManager
	 * observes the structural change and hides the native view while drawing.
	 */
	private _attachOverlay(): void {
		if (!this._overlay.isConnected) {
			this.editor.browserContainer.appendChild(this._overlay);
		}
	}

	/** Detach the overlay; the native view is reshown by the overlay manager. */
	private _detachOverlay(): void {
		this._overlay.remove();
	}

	private _toggleTool(kind: DesignModeRegionKind): void {
		if (this._tool === kind) {
			this._deactivateTool();
			return;
		}
		this._tool = kind;
		this._updateToolButtons();
		void this._captureFrozenFrame();
	}

	private _deactivateTool(): void {
		this._tool = undefined;
		this._cancelDrag();
		this._detachOverlay();
		this._updateToolButtons();
	}

	private _updateToolButtons(): void {
		this._circleButton.element.classList.toggle('active', this._tool === DesignModeRegionKind.Circle);
		this._boxButton.element.classList.toggle('active', this._tool === DesignModeRegionKind.Box);
		const count = this._regions.length;
		this._sendButton.element.classList.toggle('has-regions', count > 0);
		// Binary-verbatim label template: `Send ${count} annotation(s) to agent`.
		this._sendButton.label = sendAnnotationsToAgentLabel(count);
		this._sendButton.enabled = count > 0;
		// Binary-verbatim chevron aria-label template: `${count} annotation(s) pending; show details`.
		this._pendingButton.element.setAttribute('aria-label', pendingAnnotationsAriaLabel(count));
		this._renderPendingPanel();
	}

	/** Toggle the pending-annotations list panel. */
	private _togglePendingPanel(): void {
		this._pendingListOpen = !this._pendingListOpen;
		this._renderPendingPanel();
	}

	/** Close the pending-annotations list panel. */
	private _closePendingPanel(): void {
		this._pendingListOpen = false;
		this._openedIndex = undefined;
		this._renderPendingPanel();
	}

	/**
	 * Render the pending-annotations list (each drawn region is a pending
	 * annotation until sent). Empty state is the binary-verbatim
	 * "No annotation points" string.
	 */
	private _renderPendingPanel(): void {
		if (!this._pendingListOpen) {
			this._pendingPanel.remove();
			return;
		}
		if (!this._pendingPanel.isConnected) {
			this.editor.browserContainer.appendChild(this._pendingPanel);
		}
		this._pendingPanel.innerHTML = '';
		if (this._regions.length === 0) {
			const empty = $('.browser-design-mode-pending-empty');
			empty.textContent = NO_ANNOTATION_POINTS;
			this._pendingPanel.appendChild(empty);
			return;
		}
		this._regions.forEach((region, index) => {
			const row = $('.browser-design-mode-pending-row');
			// Cursor's row renders the number in its own span beside the text
			// (binary: `${n.number}. ${n.comment}` split across spans).
			const openButton = document.createElement('button');
			openButton.className = 'browser-design-mode-pending-open';
			openButton.setAttribute('aria-label', OPEN_ANNOTATION_TITLE);
			openButton.title = OPEN_ANNOTATION_TITLE;
			openButton.dataset.action = 'open';
			openButton.dataset.index = String(index);
			const number = document.createElement('span');
			number.className = 'browser-design-mode-pending-number';
			number.textContent = `${index + 1}`;
			const label = document.createElement('span');
			label.className = 'browser-design-mode-pending-label';
			label.textContent = describeRegionBody(region);
			openButton.appendChild(number);
			openButton.appendChild(label);
			row.appendChild(openButton);
			// Binary-verbatim per-row remove aria-label template:
			// `Remove annotation ${number}`.
			const removeButton = document.createElement('button');
			removeButton.className = 'browser-design-mode-pending-remove';
			removeButton.setAttribute('aria-label', removeAnnotationAriaLabel(index + 1));
			removeButton.title = removeAnnotationAriaLabel(index + 1);
			removeButton.dataset.action = 'remove';
			removeButton.dataset.index = String(index);
			removeButton.innerHTML = '<span class="codicon codicon-close"></span>';
			row.appendChild(removeButton);
			// Expanded detail for the opened annotation: binary-verbatim
			// "Delete annotation" action (the note-card trash action in the
			// glass bundle).
			if (this._openedIndex === index) {
				const detail = $('.browser-design-mode-pending-detail');
				const deleteButton = document.createElement('button');
				deleteButton.className = 'browser-design-mode-pending-delete';
				deleteButton.setAttribute('aria-label', DELETE_ANNOTATION_TITLE);
				deleteButton.title = DELETE_ANNOTATION_TITLE;
				deleteButton.dataset.action = 'delete';
				deleteButton.dataset.index = String(index);
				deleteButton.innerHTML = '<span class="codicon codicon-trash"></span>';
				detail.appendChild(deleteButton);
				row.appendChild(detail);
			}
			this._pendingPanel.appendChild(row);
		});
	}

	/** Delegated clicks from the pending-annotations list panel. */
	private _onPendingPanelClick(e: MouseEvent): void {
		const target = (e.target as HTMLElement).closest('[data-action]') as HTMLElement | null;
		if (!target) {
			return;
		}
		const index = Number(target.dataset.index);
		if (!Number.isInteger(index) || index < 0 || index >= this._regions.length) {
			return;
		}
		switch (target.dataset.action) {
			case 'open':
				this._openAnnotation(index);
				break;
			case 'remove':
			case 'delete':
				this._removeRegion(index);
				break;
		}
	}

	/**
	 * "Open annotation": expand the annotation's detail in the list and
	 * highlight its region on the frozen frame.
	 */
	private _openAnnotation(index: number): void {
		this._openedIndex = this._openedIndex === index ? undefined : index;
		// Re-attach the frozen frame when it exists so the highlight is visible.
		if (this._frameNaturalWidth > 0 && !this._overlay.isConnected) {
			this._attachOverlay();
			this._layoutCanvas();
		}
		this._redraw();
		this._renderPendingPanel();
	}

	/** Remove one pending annotation; re-renders the list and the canvas. */
	private _removeRegion(index: number): void {
		if (index < 0 || index >= this._regions.length) {
			return;
		}
		this._regions.splice(index, 1);
		if (this._openedIndex !== undefined) {
			if (this._openedIndex === index) {
				this._openedIndex = undefined;
			} else if (this._openedIndex > index) {
				this._openedIndex -= 1;
			}
		}
		this._updateToolButtons();
		this._redraw();
	}

	private async _captureFrozenFrame(): Promise<void> {
		const model = this.editor.model;
		if (!model) {
			this.logService.warn('Design Mode drawing: no browser model to capture.');
			this._deactivateTool();
			return;
		}
		try {
			const buffer = await model.captureScreenshot({ format: 'png', quality: 90 });
			const dataUrl = `data:image/png;base64,${encodeBase64(buffer)}`;
			await new Promise<void>((resolve, reject) => {
				this._frameImg.onload = () => resolve();
				this._frameImg.onerror = () => reject(new Error('Failed to load frozen frame'));
				this._frameImg.src = dataUrl;
			});
			this._frameNaturalWidth = this._frameImg.naturalWidth;
			this._frameNaturalHeight = this._frameImg.naturalHeight;
			this._attachOverlay();
			this._layoutCanvas();
			this._redraw();
		} catch (error) {
			this.logService.error('Design Mode drawing: failed to capture frozen frame', error);
			this._deactivateTool();
		}
	}

	private _layoutCanvas(): void {
		const rect = this._overlay.getBoundingClientRect();
		const width = Math.max(1, Math.floor(rect.width));
		const height = Math.max(1, Math.floor(rect.height));
		this._canvas.width = this._frameNaturalWidth || width;
		this._canvas.height = this._frameNaturalHeight || height;
		this._canvas.style.width = `${width}px`;
		this._canvas.style.height = `${height}px`;
		this._frameImg.style.width = `${width}px`;
		this._frameImg.style.height = `${height}px`;
	}

	private _toFrameCoords(e: PointerEvent): { x: number; y: number } {
		const rect = this._canvas.getBoundingClientRect();
		const scaleX = this._canvas.width / Math.max(1, rect.width);
		const scaleY = this._canvas.height / Math.max(1, rect.height);
		return {
			x: (e.clientX - rect.left) * scaleX,
			y: (e.clientY - rect.top) * scaleY,
		};
	}

	private _onPointerDown(e: PointerEvent): void {
		if (!this._tool || e.button !== 0) {
			return;
		}
		e.preventDefault();
		this._canvas.setPointerCapture(e.pointerId);
		const { x, y } = this._toFrameCoords(e);
		this._dragStart = { x, y };
		this._dragCurrent = undefined;
	}

	private _onPointerMove(e: PointerEvent): void {
		if (!this._tool || !this._dragStart) {
			return;
		}
		const { x, y } = this._toFrameCoords(e);
		const raw: IDesignModePixelRect = {
			x: Math.min(this._dragStart.x, x),
			y: Math.min(this._dragStart.y, y),
			width: Math.abs(x - this._dragStart.x),
			height: Math.abs(y - this._dragStart.y),
		};
		this._dragCurrent = clampRectToFrame(raw, this._canvas.width, this._canvas.height);
		this._redraw();
	}

	private _onPointerUp(e: PointerEvent): void {
		if (!this._tool || !this._dragStart) {
			return;
		}
		const rect = this._dragCurrent;
		this._dragStart = undefined;
		this._dragCurrent = undefined;
		if (rect && isDrawableRegion(rect)) {
			this._regions.push(normalizeRegionToFractions(this._tool, rect, this._canvas.width, this._canvas.height));
			this._updateToolButtons();
		}
		this._redraw();
	}

	private _cancelDrag(): void {
		this._dragStart = undefined;
		this._dragCurrent = undefined;
		this._redraw();
	}

	private _redraw(): void {
		const ctx = this._canvas.getContext('2d');
		if (!ctx) {
			return;
		}
		ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
		this._regions.forEach((region, index) => {
			const rect = regionToPixels(region, this._canvas.width, this._canvas.height);
			if (index === this._openedIndex) {
				// The opened annotation is highlighted with a heavier stroke.
				ctx.save();
				ctx.lineWidth = 4;
				ctx.strokeStyle = REGION_STROKE;
				ctx.strokeRect(rect.x - 2, rect.y - 2, rect.width + 4, rect.height + 4);
				ctx.restore();
			}
			this._strokeRegion(ctx, rect, region.kind, false);
		});
		if (this._dragCurrent && this._tool) {
			this._strokeRegion(ctx, this._dragCurrent, this._tool, true);
		}
	}

	private _strokeRegion(ctx: CanvasRenderingContext2D, rect: IDesignModePixelRect, kind: DesignModeRegionKind, preview: boolean): void {
		ctx.save();
		ctx.strokeStyle = REGION_STROKE;
		ctx.fillStyle = REGION_FILL;
		ctx.lineWidth = preview ? 1 : 2;
		if (preview) {
			ctx.setLineDash([6, 4]);
		}
		if (kind === DesignModeRegionKind.Circle) {
			ctx.beginPath();
			ctx.ellipse(
				rect.x + rect.width / 2,
				rect.y + rect.height / 2,
				Math.max(1, rect.width / 2),
				Math.max(1, rect.height / 2),
				0, 0, Math.PI * 2
			);
			ctx.fill();
			ctx.stroke();
		} else {
			ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
			ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
		}
		ctx.restore();
	}

	private _clearRegions(): void {
		this._regions = [];
		this._openedIndex = undefined;
		this._updateToolButtons();
		this._redraw();
	}

	/**
	 * Composite the committed regions over the frozen frame and attach the
	 * annotated image plus the region list to chat as a draft for the agent.
	 *
	 * The receiver is the GAPS-55 `designAnnotation` path: entries are sent
	 * through BrowserEditorChatIntegration.attachToChat →
	 * `ide.browserAttachToChat` → the ide-agent native browser chat receiver.
	 */
	private async _sendToAgent(): Promise<void> {
		if (this._regions.length === 0) {
			// Binary-verbatim guard: the glass bundle throws
			// `new Error("No annotation points")` when the send path finds no
			// annotation points. The fork surfaces it as a warning.
			this.logService.warn(`Design Mode drawing: ${NO_ANNOTATION_POINTS}`);
			return;
		}
		const chatIntegration = this.editor.getContribution(BrowserEditorChatIntegration);
		if (!chatIntegration) {
			this.logService.warn('Design Mode drawing: no chat integration found; annotations dropped.');
			return;
		}
		let annotated: Uint8Array;
		try {
			annotated = await this._renderAnnotatedFrame();
		} catch (error) {
			this.logService.error('Design Mode drawing: failed to render annotated frame', error);
			return;
		}
		const timestamp = Date.now();
		const entries: IChatRequestVariableEntry[] = [
			{
				id: 'browser-design-annotation-' + timestamp,
				name: localize('browserDesignAnnotation', "Design annotations"),
				fullName: localize('browserDesignAnnotation', "Design annotations"),
				kind: 'image',
				value: annotated,
				mimeType: 'image/png',
				modelDescription: 'Frozen browser frame annotated by the user in Design Mode.',
			},
			{
				id: 'browser-design-annotation-text-' + timestamp,
				name: localize('browserDesignAnnotationRegions', "Design annotation regions"),
				fullName: localize('browserDesignAnnotationRegions', "Design annotation regions"),
				kind: 'generic',
				value: createDesignModeAnnotationsMessage(this._regions),
				modelDescription: 'Spatial region list for the Design Mode annotated frame.',
			},
		];
		const attached = await chatIntegration.attachToChat(entries);
		if (attached) {
			this._regions = [];
			this._openedIndex = undefined;
			this._updateToolButtons();
			this._deactivateTool();
		} else {
			this.logService.warn('Design Mode drawing: failed to attach annotations to chat.');
		}
	}

	/** Draw the frozen frame + committed regions into a PNG buffer. */
	private async _renderAnnotatedFrame(): Promise<Uint8Array> {
		const width = this._frameNaturalWidth || this._canvas.width;
		const height = this._frameNaturalHeight || this._canvas.height;
		const offscreen = document.createElement('canvas');
		offscreen.width = Math.max(1, width);
		offscreen.height = Math.max(1, height);
		const ctx = offscreen.getContext('2d');
		if (!ctx) {
			throw new Error('2d canvas context unavailable');
		}
		await new Promise<void>((resolve, reject) => {
			const img = new Image();
			img.onload = () => {
				ctx.drawImage(img, 0, 0, offscreen.width, offscreen.height);
				resolve();
			};
			img.onerror = () => reject(new Error('Failed to reload frozen frame'));
			img.src = this._frameImg.src;
		});
		for (const region of this._regions) {
			this._strokeRegion(ctx, regionToPixels(region, offscreen.width, offscreen.height), region.kind, false);
		}
		const dataUrl = offscreen.toDataURL('image/png');
		const base64 = dataUrl.split(',', 2)[1];
		if (!base64) {
			throw new Error('Failed to encode annotated frame');
		}
		return decodeBase64(base64);
	}
}

BrowserEditor.registerContribution(BrowserDesignModeDrawingContribution);
