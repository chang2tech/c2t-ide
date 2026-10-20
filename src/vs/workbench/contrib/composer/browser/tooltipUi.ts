/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE (GAPS-170, queue entry #32 `inline-edit-onboarding-popups`):
// rendering half of Cursor's Cmd+K onboarding tooltips — the shared popup
// renderer `xNp`, the editor overlay widget, the editor contribution
// `editor.contrib.tooltipUiController`, and the three actions that drive
// them. Binary evidence (Cursor 3.25.9, workbench.desktop.main.js):
// ide-code-mission `docs/rea/work-notes-gaps170.md` Slice 1.
//
// Binary shape being ported:
// - `xNp(info, container, commandService, onDispose)` @24355710 renders
//   `div.tooltipTopOuter` (280px, sideBar background, 6px radius, shadow),
//   header + subheader `div.tooltipInner`s and a chevron-right affordance;
//   fade-in after 10ms, pulse every 10s while unhovered, click ->
//   `tooltip.close.register` + slide-out + dispose, auto-dispose 600s.
// - Editor anchor @24358219: overlay widget `tooltip.editorUiWidget`,
//   `allowEditorOverflow`, position preference 0 (= TOP_RIGHT_CORNER in
//   this fork's enum — same numeric value).
// - Controller `WIt`, ID `editor.contrib.tooltipUiController` @24359221,
//   registered with instantiation 3 (= Eventually in this fork's
//   EditorContributionInstantiation). `show("terminal", …)` delegates to
//   the terminal action `workbench.action.terminal.addTooltip`;
//   `show("editor", …)` creates the overlay widget on its editor.
// - Show action @24359337: `cursor.showTooltipActionId`, title
//   "Show Tooltip", `f1:!1`; run() takes the ACTIVE code editor and calls
//   its controller — including for terminal popups.
// - Terminal anchor @36736331: the terminal instance contribution's
//   `showTooltipHint` positions a `div.tooltip-hint` container at
//   `right:24px; top:32px; zIndex:100000` inside `.xterm-wrapper` and
//   renders with the same `xNp`.
//
// HONEST-DIVERGENCES:
// U1. The editor widget's binary `updateEditor` hides the popup when
//     editor options 63 or 96 are truthy. Those numeric ids index
//     Cursor's own (extended) EditorOption enum and do not map onto this
//     fork's upstream numbering (63/96 here are unrelated options), so
//     the hide check is not ported — names UNKNOWN, not guessed.
// U2. Event producers living on the editor (binary: text model +
//     clipboard controller emit `editor.type.*` / `editor.copy…` /
//     `editor.paste` / `editor.focus`): the fork emits them from this
//     editor contribution instead — focus via onDidFocusEditorText
//     (skipped for readonly editors, like the binary), typing via
//     onDidChangeModelContent (`editor.type.push_edit_operation`, the
//     binary's own event name for model edits), copy/paste via DOM
//     events on the editor node (skipped for simple widgets, like the
//     binary). Chat-codeblock editors are not distinguished locally
//     (the binary emits `chat.copy.codeblock.manual` there); the fork's
//     chat codeblocks are not core code editors, so the distinction
//     does not arise on this path.

import * as dom from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize2 } from '../../../../nls.js';
import { EditorOption } from '../../../../editor/common/config/editorOptions.js';
import { ICodeEditor, IOverlayWidget, IOverlayWidgetPosition, OverlayWidgetPositionPreference } from '../../../../editor/browser/editorBrowser.js';
import { IEditorContribution } from '../../../../editor/common/editorCommon.js';
import { EditorContributionInstantiation, registerEditorContribution } from '../../../../editor/browser/editorExtensions.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ITerminalService } from '../../../contrib/terminal/browser/terminal.js';
import { TerminalContextKeys } from '../../../contrib/terminal/common/terminalContextKey.js';
import {
	CLOSE_TOOLTIP_COMMAND_ID,
	CLOSE_TOOLTIP_CATEGORY,
	SHOW_TOOLTIP_COMMAND_ID,
	TERMINAL_ADD_TOOLTIP_COMMAND_ID,
	TOOLTIP_AUTO_DISMISS_MS,
	TOOLTIP_CLOSE_DISPOSE_DELAY_MS,
	TOOLTIP_EDITOR_WIDGET_ID,
	TOOLTIP_POPUP_WIDTH_PX,
	TOOLTIP_PULSE_INTERVAL_MS,
	TOOLTIP_UI_CONTROLLER_ID,
} from '../common/tooltipPipelines.js';
import { ITooltipService } from './tooltipService.js';

export interface ITooltipInfo {
	readonly header: string;
	readonly subheader: string;
	readonly name: string;
}

// ---------------------------------------------------------------------------
// xNp — the shared popup renderer (desk@24355710)
// ---------------------------------------------------------------------------

/**
 * Port of `xNp(tooltipInfo, container, commandService, onDispose)`.
 * All inline styles, timings and the click behavior are the binary's
 * (see the module header). Returns a disposable that owns the timers
 * and listeners; disposing it invokes `onDispose` exactly once.
 */
export function renderTooltipPopup(info: ITooltipInfo, container: HTMLElement, commandService: ICommandService, onDispose: () => void): IDisposable {
	const store = new DisposableStore();
	let disposed = false;
	const disposeSelf = () => {
		if (disposed) {
			return;
		}
		disposed = true;
		store.dispose();
		onDispose();
	};
	store.add(toDisposable(() => { /* placeholder so disposeSelf can run store.dispose() safely */ }));

	const outer = dom.append(container, dom.$('div.tooltipTopOuter'));
	outer.style.display = 'flex';
	outer.style.alignItems = 'center';
	outer.style.padding = '8px 12px';
	outer.style.backgroundColor = 'var(--vscode-sideBar-background)';
	outer.style.borderRadius = '6px';
	outer.style.width = `${TOOLTIP_POPUP_WIDTH_PX}px`;
	outer.style.justifyContent = 'space-between';
	outer.style.boxShadow = 'rgba(0, 0, 0, 0.22) 0px 0px 8px 2px';
	outer.style.transition = 'transform 0.1s ease, opacity 0.5s ease-out';
	outer.style.gap = '8px';
	outer.style.fontSize = '0.9em';
	outer.style.marginTop = '12px';
	outer.style.paddingRight = '4px';
	outer.style.opacity = '0';
	const fadeTimer = setTimeout(() => { outer.style.opacity = '1'; }, 10);
	store.add(toDisposable(() => clearTimeout(fadeTimer)));

	let pulseEnabled = true;
	outer.onmouseover = () => { pulseEnabled = false; };
	outer.onmouseleave = () => { pulseEnabled = true; };
	const pulseTimer = setInterval(() => {
		if (pulseEnabled) {
			outer.animate(
				[{ transform: 'scale(1)' }, { transform: 'scale(1.03)' }, { transform: 'scale(1)' }],
				{ duration: 800, iterations: 1, easing: 'ease-in-out' },
			);
		}
	}, TOOLTIP_PULSE_INTERVAL_MS);
	store.add(toDisposable(() => clearInterval(pulseTimer)));

	const body = dom.append(outer, dom.$('div.tooltipOuter'));
	body.style.display = 'flex';
	body.style.opacity = '100%';
	body.style.justifyContent = 'center';
	body.style.flexDirection = 'column';
	body.style.gap = '2px';

	const header = dom.append(body, dom.$('div.tooltipInner'));
	// The binary appends a `codicon codicon-lightbulb` child here and then
	// assigns textContent (which replaces it); the net rendered content is
	// the header text, which is what is ported.
	header.textContent = info.header;
	header.style.fontWeight = '500';
	header.style.fontSize = '1.1em';

	const subheader = dom.append(body, dom.$('div.tooltipInner'));
	subheader.textContent = info.subheader;
	subheader.style.opacity = '60%';

	const chevron = dom.append(outer, dom.$('div.tooltipInner'));
	chevron.style.color = 'var(--vscode-editor-foreground)';
	chevron.style.padding = '4px';
	chevron.style.cursor = 'pointer';
	chevron.className = 'codicon codicon-chevron-right';
	chevron.style.transition = 'transform 0.1s ease';
	chevron.onmouseover = () => { chevron.style.transform = 'translateX(4px)'; };
	chevron.onmouseleave = () => { chevron.style.transform = 'translateX(0)'; };

	let clicked = false;
	outer.onclick = () => {
		if (clicked) {
			return;
		}
		clicked = true;
		void commandService.executeCommand(CLOSE_TOOLTIP_COMMAND_ID, { tooltipName: info.name });
		container.style.transition = 'transform 0.75s';
		container.style.transform = 'translateX(400%)';
		store.add(dom.addDisposableListener(container, 'transitionend', (event: TransitionEvent) => {
			if (event.target === container && event.propertyName === 'transform') {
				const timer = setTimeout(() => disposeSelf(), TOOLTIP_CLOSE_DISPOSE_DELAY_MS);
				store.add(toDisposable(() => clearTimeout(timer)));
			}
		}));
	};

	const autoTimer = setTimeout(() => disposeSelf(), TOOLTIP_AUTO_DISMISS_MS);
	store.add(toDisposable(() => clearTimeout(autoTimer)));

	return store;
}

// ---------------------------------------------------------------------------
// UKo — the editor overlay widget (desk@24358219)
// ---------------------------------------------------------------------------

class TooltipEditorUiWidget extends Disposable implements IOverlayWidget {
	readonly allowEditorOverflow = true;
	private _domNode: HTMLElement;
	private _disposed = false;

	constructor(
		private readonly _editor: ICodeEditor,
		tooltipInfo: ITooltipInfo,
		@ICommandService commandService: ICommandService,
	) {
		super();
		this._domNode = dom.$('div.tooltipEditorUiWidget');
		this._register(renderTooltipPopup(tooltipInfo, this._domNode, commandService, () => this.dispose()));
		this._editor.addOverlayWidget(this);
		this._editor.layoutOverlayWidget(this);
	}

	getId(): string {
		return TOOLTIP_EDITOR_WIDGET_ID;
	}

	getDomNode(): HTMLElement {
		return this._domNode;
	}

	getPosition(): IOverlayWidgetPosition {
		return { preference: OverlayWidgetPositionPreference.TOP_RIGHT_CORNER };
	}

	override dispose(): void {
		if (this._disposed) {
			return;
		}
		this._disposed = true;
		super.dispose();
		try {
			this._editor.removeOverlayWidget(this);
		} catch {
			/* the editor may already be gone */
		}
		this._domNode.remove();
	}
}

// ---------------------------------------------------------------------------
// WIt — editor.contrib.tooltipUiController (desk@24359221)
// ---------------------------------------------------------------------------

export class TooltipUiController extends Disposable implements IEditorContribution {
	static readonly ID = TOOLTIP_UI_CONTROLLER_ID;

	static get(editor: ICodeEditor): TooltipUiController | null {
		return editor.getContribution<TooltipUiController>(TooltipUiController.ID);
	}

	constructor(
		private readonly _editor: ICodeEditor,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@ICommandService private readonly _commandService: ICommandService,
		@ITooltipService tooltipService: ITooltipService,
	) {
		super();
		// Event producers (see divergence U2 in the module header). The
		// binary's two constructor debug flags are hardcoded false with a
		// different, never-shown text — dead code, not ported.
		this._register(this._editor.onDidFocusEditorText(() => {
			// Binary @1902472: only for non-readonly, non-chat-codeblock editors.
			if (this._editor.getOption(EditorOption.readOnly)) {
				return;
			}
			tooltipService.registerEvent('editor.focus');
		}));
		this._register(this._editor.onDidChangeModelContent(() => {
			tooltipService.registerEvent('editor.type.push_edit_operation');
		}));
		const domNode = this._editor.getDomNode();
		if (domNode) {
			this._register(dom.addDisposableListener(domNode, 'copy', () => {
				if (!this._editor.isSimpleWidget) {
					tooltipService.registerEvent('editor.copy.non_vim_mode');
				}
			}));
			this._register(dom.addDisposableListener(domNode, 'paste', () => {
				if (!this._editor.isSimpleWidget) {
					tooltipService.registerEvent('editor.paste');
				}
			}));
		}
	}

	/** Binary `show(location, name, header, subheader)`. */
	show(location: string, name: string, header: string, subheader: string): void {
		if (location === 'terminal') {
			void this._commandService.executeCommand(TERMINAL_ADD_TOOLTIP_COMMAND_ID, {
				tooltipInfo: { header, subheader, name } satisfies ITooltipInfo,
			});
		} else if (location === 'editor') {
			this._register(this._instantiationService.createInstance(TooltipEditorUiWidget, this._editor, { header, subheader, name } satisfies ITooltipInfo));
		}
	}
}

registerEditorContribution(TooltipUiController.ID, TooltipUiController, EditorContributionInstantiation.Eventually);

// ---------------------------------------------------------------------------
// Actions: cursor.showTooltipActionId + tooltip.close.register +
// workbench.action.terminal.addTooltip (the terminal anchor)
// ---------------------------------------------------------------------------

/** Live terminal hint containers, by terminal instance id (binary keeps one `div.tooltip-hint` per instance). */
const terminalHintDisposables = new Map<number, IDisposable>();

export function registerTooltipActions(): void {
	// `cursor.showTooltipActionId` — "Show Tooltip", f1:!1 (desk@24359337).
	registerAction2(class extends Action2 {
		constructor() {
			super({ id: SHOW_TOOLTIP_COMMAND_ID, title: localize2('cursor.showTooltipActionId', 'Show Tooltip'), f1: false });
		}
		async run(accessor: ServicesAccessor, args?: { location: string; name: string; header: string; subheader: string }): Promise<void> {
			if (!args) {
				return;
			}
			const editor = accessor.get(ICodeEditorService).getActiveCodeEditor();
			editor && TooltipUiController.get(editor)?.show(args.location, args.name, args.header, args.subheader);
		}
	});

	// `tooltip.close.register` — "Register Close Tooltip", category
	// "Tooltip", f1:!1 (registered at the end of tooltipService.js).
	registerAction2(class extends Action2 {
		constructor() {
			super({ id: CLOSE_TOOLTIP_COMMAND_ID, title: localize2('tooltip.close.register', 'Register Close Tooltip'), category: { value: CLOSE_TOOLTIP_CATEGORY, original: CLOSE_TOOLTIP_CATEGORY }, f1: false });
		}
		async run(accessor: ServicesAccessor, args?: { tooltipName: string }): Promise<void> {
			if (args?.tooltipName) {
				accessor.get(ITooltipService).registerUserCloseTooltip(args.tooltipName);
			}
		}
	});

	// `workbench.action.terminal.addTooltip` — title verbatim from the
	// binary's nls table (desk@21548617, `title: k(10219, null)`;
	// `nls.messages.json[10219]` = "Add Tooltip" in the 3.25.9 reference
	// tree, neighbors 10215–10223 all terminal strings — verified
	// GAPS-179). f1:!1. Precondition is the binary's
	// `Kv.terminalAvailable`; this fork's `TerminalContextKeys` has no
	// `available` member, so the fork's own `terminalAvailable`
	// expression is used (terminalActions.ts:75):
	// `processSupported || terminalHasBeenCreated`.
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: TERMINAL_ADD_TOOLTIP_COMMAND_ID,
				title: localize2('workbench.action.terminal.addTooltip', 'Add Tooltip'),
				precondition: ContextKeyExpr.or(TerminalContextKeys.processSupported, TerminalContextKeys.terminalHasBeenCreated),
				f1: false,
			});
		}
		async run(accessor: ServicesAccessor, arg1?: unknown, arg2?: unknown, arg3?: unknown): Promise<void> {
			// Binary signature: run(accessor, a, b, tooltipArg) where
			// tooltipArg.tooltipInfo carries {header, subheader, name};
			// the controller in this fork passes it as the first arg, so
			// accept both positions.
			const candidate = [arg1, arg2, arg3].find((a): a is { tooltipInfo: ITooltipInfo } =>
				typeof a === 'object' && a !== null && 'tooltipInfo' in a);
			if (!candidate) {
				return;
			}
			const info = candidate.tooltipInfo;
			const terminalService = accessor.get(ITerminalService);
			const instance = terminalService.activeInstance;
			if (!instance) {
				return;
			}
			const wrapper = instance.domElement.querySelector('.xterm-wrapper') ?? instance.domElement;
			terminalHintDisposables.get(instance.instanceId)?.dispose();
			const hint = dom.$('div.tooltip-hint');
			hint.style.position = 'absolute';
			hint.style.right = '24px';
			hint.style.top = '32px';
			hint.style.zIndex = '100000';
			wrapper.appendChild(hint);
			const disposable = renderTooltipPopup(info, hint, accessor.get(ICommandService), () => {
				hint.remove();
				terminalHintDisposables.delete(instance.instanceId);
			});
			terminalHintDisposables.set(instance.instanceId, disposable);
		}
	});
}
