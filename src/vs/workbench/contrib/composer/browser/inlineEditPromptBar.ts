/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Cursor-parity Cmd+K prompt bar as a NATIVE MONACO VIEW ZONE.
//
// This is the workbench-core port of Cursor's `PromptBarViewZone` (REA:
// Cursor 3.25.9 glass bundle, docs/rea/dig-continuous-inline-edit-2026-10-19.md).
// It is deliberately NOT a quick-input box, NOT an overlay widget and NOT a
// webview — the previous quick-input implementation could not be cursor-
// anchored, which is exactly why Cursor put this in the workbench core.
//
// View-zone parameters (binary-verified, see ../common/inlineEditPromptBar.ts):
//   afterLineNumber = startLineNumber - 1   (zone sits directly ABOVE the first edit line)
//   ordinal = 1e5
//   showInHiddenAreas = true
//   showEvenWhenNotInViewport = true
//   afterColumnAffinity = PositionAffinity.Right  (binary: afterColumnAffinity: 1)
//   height = Math.max(62, scrollHeight + 6) px, clamp at 5000px + warn + scroll
//
// While the bar is open the target range carries an `inline-diff-pending`
// decoration (themed/unthemed via `ide.cmdk.useThemedDiffBackground`) and
// `editor.action.inlineSuggest.hide` is executed on open.

import './media/inlineEditPromptBar.css';
import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import * as dom from '../../../../base/browser/dom.js';
import { ICodeEditor, IViewZone } from '../../../../editor/browser/editorBrowser.js';
import { PositionAffinity } from '../../../../editor/common/model.js';
import { Range } from '../../../../editor/common/core/range.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextKeyService, IContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { localize } from '../../../../nls.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ITooltipService } from './tooltipService.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { IUndoRedoService, UndoRedoElementType } from '../../../../platform/undoRedo/common/undoRedo.js';
import { ComposerContextKeys } from '../common/composerContextKeys.js';
import {
	createPromptBarInputHistoryState,
	IPromptBarInputHistoryState,
	IPromptBarInputSnapshot,
	promptBarHistoryShortcut,
	recordPromptBarInputHistory,
	redoPromptBarInputHistory,
	undoPromptBarInputHistory,
} from '../common/promptBarInputHistory.js';
import {
	createPromptBarDataSelection,
	IInlineEditPromptBar,
	IInlineEditPromptBarOptions,
	IInlineEditPromptBarResult,
	IPromptBarDataSelection,
	IPromptBarDelegate,
	IPromptBarModelRef,
	IPromptBarRef,
	PROMPT_BAR_FOLLOWUP_PLACEHOLDER,
	PROMPT_BAR_MAX_HEIGHT_PX,
	PROMPT_BAR_MIN_HEIGHT_PX,
	PROMPT_BAR_MODES,
	PROMPT_BAR_PLACEHOLDERS,
	PROMPT_BAR_ZONE_ORDINAL,
	PromptBarMode,
} from '../common/inlineEditPromptBar.js';

/**
 * WORKER W60C (`cmdk-next-prompt-bar`): the binary's prompt-bar ids are
 * opaque minified identifiers (unrecoverable); the fork uses a local
 * monotonic counter. Only the `id` + `createdAt` contract on
 * `IPromptBarRef` is binary-parity (sort key for `nextPromptBar`).
 */
let promptBarIdCounter = 0;

/**
 * Identity comparison for prompt-bar model refs (provider + id + variant) —
 * used by the cmdk-model-eligibility fallback: a bar selection whose ref no
 * longer appears in the eligible list falls back to Auto.
 */
function promptBarModelRefEquals(a: IPromptBarModelRef | undefined, b: IPromptBarModelRef | undefined): boolean {
	if (!a || !b) {
		return !a && !b;
	}
	return a.providerID === b.providerID && a.id === b.id && (a.variant ?? '') === (b.variant ?? '');
}

/**
 * The view zone itself. Mirrors the binary's `PromptBarViewZone` (class `q9c`):
 * minHeight 62px, ordinal 1e5, above the edit range's first line.
 */
class PromptBarViewZone implements IViewZone {
	readonly domNode: HTMLElement;
	afterLineNumber: number;
	afterColumnAffinity = PositionAffinity.Right; // binary: afterColumnAffinity: 1
	showInHiddenAreas = true;
	// Binary-verified (Cursor 3.25.9): the prompt-bar zone sets
	// `showEvenWhenNotInViewport: true`. The field was patched into this
	// fork's core IViewZone (editorBrowser.ts) and is honored by the
	// view-zone renderer (viewParts/viewZones/viewZones.ts), which skips
	// viewport culling for flagged zones — a direct port of Cursor's render
	// loop (see the IDE-CODE comments there).
	showEvenWhenNotInViewport = true;
	readonly ordinal = PROMPT_BAR_ZONE_ORDINAL; // 1e5
	heightInPx = PROMPT_BAR_MIN_HEIGHT_PX;

	constructor(domNode: HTMLElement, afterLineNumber: number) {
		this.domNode = domNode;
		this.afterLineNumber = afterLineNumber;
	}
}

interface IActivePromptBar {
	/** Binary `id` (fork-local counter — see note above). */
	readonly id: string;
	/** Binary `createdAt` — the `aipopup.action.nextPromptBar` sort key. */
	readonly createdAt: number;
	readonly editor: ICodeEditor;
	readonly zone: PromptBarViewZone;
	readonly zoneId: string;
	readonly bigContainer: HTMLElement;
	readonly input: HTMLTextAreaElement;
	readonly modeButton: HTMLButtonElement;
	readonly menu: HTMLElement;
	readonly modelButton: HTMLButtonElement;
	/** Binary `uri` (bar's document); stored at creation from the editor model. */
	readonly uri?: string;
	/** First line of the edit/selection range — the `revealLineInCenterIfOutsideViewport` target. */
	readonly startLineNumber: number;
	decoIds: string[];
	mode: PromptBarMode;
	model?: IPromptBarModelRef;
	/** Binary `data.selections` — items appended via `aipopup.action.insertEditSelection`. */
	selections: IPromptBarDataSelection[];
	/**
	 * GAPS-139: this bar's own input history state (binary: the Lexical
	 * history state of the bar's editor, `ONp()` shape — see
	 * common/promptBarInputHistory.ts). Scoped to THIS bar only,
	 * independent of the editor's model undo stack; its pushes are
	 * mirrored onto the workbench undoRedoService as "Lexical
	 * Operation" elements, exactly like the binary's external history
	 * bundle.
	 */
	readonly lexicalInputHistory: IPromptBarInputHistoryState;
	hasDiff: boolean;
	readonly followUp: boolean;
	resolve: (result: IInlineEditPromptBarResult | undefined) => void;
	settled: boolean;
	readonly disposables: IDisposable[];
}

export class InlineEditPromptBarService extends Disposable implements IInlineEditPromptBar {

	declare readonly _serviceBrand: undefined;

	private readonly bars = new Map<ICodeEditor, IActivePromptBar>();
	private readonly editorHasPromptBarKey: IContextKey<boolean>;
	private readonly editorPromptBarFocusedKey: IContextKey<boolean>;
	private modelProvider?: () => Promise<readonly IPromptBarModelRef[]>;
	/** ↑/↓ input history (`useArrowsForHistory: true` in the binary). */
	private readonly inputHistory: string[] = [];
	private historyIndex = -1;
	private historyDraft = '';

	constructor(
		@ICommandService private readonly commandService: ICommandService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
		@IEditorService private readonly editorService: IEditorService,
		@IUndoRedoService private readonly undoRedoService: IUndoRedoService,
		@ITooltipService private readonly tooltipService: ITooltipService,
	) {
		super();
		// Verbatim Cursor context-key names (binary §4.2).
		this.editorHasPromptBarKey = ComposerContextKeys.editorHasPromptBar.bindTo(contextKeyService);
		this.editorPromptBarFocusedKey = ComposerContextKeys.editorPromptBarFocused.bindTo(contextKeyService);
	}

	// ------------------------------------------------------------------ //

	showPromptBar(editor: ICodeEditor, options: IInlineEditPromptBarOptions): Promise<IInlineEditPromptBarResult | undefined> {
		// GAPS-170: tooltip pipeline producer — the binary emits
		// `editor.cmdk.show` when the prompt bar mounts (desk@24794191).
		this.tooltipService.registerEvent('editor.cmdk.show');
		const existing = this.bars.get(editor);
		if (existing && !existing.settled) {
			// Cursor's StartEditPrompt "bar already open for this URI" branch
			// (3.25.9 @~40732800): a non-empty new selection is appended to
			// the open bar via `aipopup.action.insertEditSelection`; an empty
			// one just re-focuses (`aipopup.action.focusEdit`).
			const targetRange = options.targetRange;
			if (!targetRange.isEmpty()) {
				const model = editor.getModel();
				if (model) {
					this.appendDataSelection(
						existing.id,
						createPromptBarDataSelection(model, targetRange),
					);
				}
			}
			// Re-entrant open (binary: `aipopup.action.focusEdit`) — focus the
			// open bar and return its pending promise.
			existing.input.focus();
			return new Promise<IInlineEditPromptBarResult | undefined>((resolve) => {
				const prev = existing.resolve;
				existing.resolve = (result) => {
					prev(result);
					resolve(result);
				};
			});
		}

		let resolve!: (result: IInlineEditPromptBarResult | undefined) => void;
		const promise = new Promise<IInlineEditPromptBarResult | undefined>((r) => { resolve = r; });

		const built = this.buildDom(options);
		const zone = new PromptBarViewZone(
			built.bigContainer,
			// Binary: afterLineNumber = startLineNumber - 1 → directly ABOVE
			// the first line of the edit range (0 = before the first line).
			Math.max(0, options.startLineNumber - 1),
		);
		let zoneId = '';
		editor.changeViewZones((accessor) => {
			zoneId = accessor.addZone(zone);
		});

		const bar: IActivePromptBar = {
			// Binary bar record fields (id/createdAt/uri) — see IActivePromptBar.
			id: `ide-prompt-bar-${++promptBarIdCounter}`,
			createdAt: Date.now(),
			editor,
			zone,
			zoneId,
			bigContainer: built.bigContainer,
			input: built.input,
			modeButton: built.modeButton,
			menu: built.menu,
			modelButton: built.modelButton,
			uri: editor.getModel()?.uri.toString(),
			startLineNumber: options.startLineNumber,
			decoIds: [],
			mode: 'edit_selection',
			model: undefined,
			selections: [],
			lexicalInputHistory: createPromptBarInputHistoryState(),
			hasDiff: false,
			followUp: options.followUp,
			resolve,
			settled: false,
			disposables: built.disposables,
		};
		this.bars.set(editor, bar);

		// GAPS-139: seed this bar's input history with its opening
		// content (the history state's first `current` — the binary's
		// PUSH branch creates no undo step for it).
		recordPromptBarInputHistory(bar.lexicalInputHistory, this.inputSnapshot(bar), Date.now());

		// Binary: while the bar is open the selection carries
		// `inline-diff-pending` decorations (isWholeLine).
		const useThemedDiff = this.configurationService.getValue<boolean>('ide.cmdk.useThemedDiffBackground') ?? true;
		bar.decoIds = editor.deltaDecorations([], [{
			range: options.targetRange,
			options: {
				description: 'inline-diff-pending',
				className: useThemedDiff ? 'inline-diff-pending' : 'inline-diff-pending-unthemed',
				isWholeLine: true,
			},
		}]);

		this.updateHeight(bar);
		this.editorHasPromptBarKey.set(true);

		// Binary (StartEditPrompt.run step 8): hide the Tab ghost text.
		this.commandService.executeCommand('editor.action.inlineSuggest.hide').then(undefined, () => { /* best effort */ });

		this.wireEvents(bar, options);
		bar.input.focus();
		return promise;
	}

	closePromptBar(editor: ICodeEditor): void {
		const bar = this.bars.get(editor);
		if (bar) {
			this.closeBar(bar, undefined);
		}
	}

	closeActiveEditorPromptBars(editor: ICodeEditor): void {
		// Binary: only bars WITHOUT a diff (`diffId==null`).
		const bar = this.bars.get(editor);
		if (bar && !bar.hasDiff) {
			this.closeBar(bar, undefined);
		}
	}

	hasPromptBar(editor: ICodeEditor): boolean {
		const bar = this.bars.get(editor);
		return !!bar && !bar.settled;
	}

	getPromptBars(): readonly IPromptBarRef[] {
		const refs: IPromptBarRef[] = [];
		for (const bar of this.bars.values()) {
			if (!bar.settled) {
				refs.push({ id: bar.id, createdAt: bar.createdAt, uri: bar.uri });
			}
		}
		return refs;
	}

	getPromptBar(id: string): IPromptBarRef | undefined {
		for (const bar of this.bars.values()) {
			if (!bar.settled && bar.id === id) {
				return { id: bar.id, createdAt: bar.createdAt, uri: bar.uri };
			}
		}
		return undefined;
	}

	getPromptBarDelegate(id: string): IPromptBarDelegate | undefined {
		for (const bar of this.bars.values()) {
			if (!bar.settled && bar.id === id) {
				const target = bar;
				return {
					setText: (text: string) => {
						if (target.settled) {
							return;
						}
						target.input.value = text;
						this.autogrow(target);
						this.updateHeight(target);
					},
					getText: () => target.input.value,
					// The fork wires Enter/submit-button synchronously in
					// showPromptBar, so a live bar always has its submit
					// path attached (binary: Lexical submit listeners,
					// registered asynchronously — hence JcI's poll).
					numSubmitListeners: () => (target.settled ? 0 : 1),
					submit: () => {
						if (!target.settled) {
							this.submit(target);
						}
					},
				};
			}
		}
		return undefined;
	}

	appendDataSelection(barId: string, selection: IPromptBarDataSelection): boolean {
		for (const bar of this.bars.values()) {
			if (!bar.settled && bar.id === barId) {
				// Binary: `n.data.selections.push(e)` + `_onDataPropertyChanged`
				// (the fork's native bar has no chip tray — see H3 note in the
				// common contract; the item is forwarded into the request on
				// submit via the prompt bar result).
				bar.selections.push(selection);
				return true;
			}
		}
		return false; // binary: getPromptBar(id) → undefined → no-op
	}

	getFocusedPromptBarId(): string | undefined {
		const focused = dom.getActiveElement();
		if (!focused) {
			return undefined;
		}
		for (const bar of this.bars.values()) {
			if (!bar.settled && bar.bigContainer.contains(focused)) {
				return bar.id;
			}
		}
		return undefined;
	}

	/**
	 * Binary `aipopup.action.focusEdit` body (Cursor 3.25.9
	 * workbench.glass.main.js, class Kfy — LABEL "Focus Edit", f1:!0):
	 * find the bar by id; if it lives in another editor, `openCodeEditor`
	 * it with `preserveFocus` + the selection at the bar's range start
	 * (releasing the model reference after); focus the editor,
	 * `revealLineInCenterIfOutsideViewport` the range start line, focus
	 * the input (plus a 100ms refocus). The binary additionally executes
	 * an unresolvable command id (`z9c`) twice — skipped, documented.
	 *
	 * H2 divergence: the fork's sessions are single-instance per editor,
	 * so a bar is always attached to its live `bar.editor` instance — the
	 * binary's `listCodeEditors().find(h.getId() === c.editorId)` lookup
	 * reduces to an identity check against `activeTextEditorControl`.
	 */
	async focusPromptBar(id: string): Promise<void> {
		let found: IActivePromptBar | undefined;
		for (const bar of this.bars.values()) {
			if (!bar.settled && bar.id === id) {
				found = bar;
				break;
			}
		}
		if (!found) {
			return; // binary: `getPromptBar(n)` → `!c` → return
		}
		const target = found; // const for closure narrowing below
		const { editor, input, startLineNumber } = target;
		const model = editor.getModel();
		if (!model) {
			return;
		}
		const activeControl = this.editorService.activeTextEditorControl;
		const isSameEditor = activeControl !== undefined
			&& typeof (activeControl as Partial<ICodeEditor>).getId === 'function'
			&& (activeControl as ICodeEditor).getId() === editor.getId();
		if (!isSameEditor) {
			// Binary: openCodeEditor({resource, preserveFocus, selection})
			// for the bar's uri when it isn't in the active editor.
			const opened = await this.editorService.openEditor({
				resource: model.uri,
				options: {
					preserveFocus: true,
					selection: new Range(Math.max(1, startLineNumber), 1, Math.max(1, startLineNumber), 1),
				},
			}).catch(() => undefined);
			if (!opened) {
				return;
			}
		}
		// Binary: d.focus() + revealLineInCenterIfOutsideViewport(range start)
		// + inputBoxDelegate.focus() + setTimeout(refocus, 100).
		editor.focus();
		editor.revealLineInCenterIfOutsideViewport(Math.max(1, startLineNumber));
		input.focus();
		setTimeout(() => {
			if (!target.settled) {
				input.focus();
			}
		}, 100);
	}

	// ------------------------------------------------------------------ //
	// GAPS-139 — `editor.action.undoLexical` / `redoLexical` targets.
	//
	// Binary (desk @24823109): the prompt-bar service's
	// `undoLexical(e,t){const n=this.viewZoneCache[t];n?.editor&&Ifr(n.editor,e)}`
	// and the symmetric `redoLexical` with `Efr`. The fork's bars are
	// keyed by editor instance (the binary's `nOe.get(editor)` step)
	// and each bar carries its own history state, so the lookup is:
	// bar for this editor → id must match `promptBarId` when given →
	// pop the bar's stack → apply the snapshot. Missing bar = no-op,
	// exactly the binary's optional chain.

	undoLexical(editor: ICodeEditor, promptBarId?: string): boolean {
		const bar = this.lexicalBarFor(editor, promptBarId);
		if (!bar) {
			return false;
		}
		const snapshot = undoPromptBarInputHistory(bar.lexicalInputHistory);
		if (!snapshot) {
			return false;
		}
		this.applyInputSnapshot(bar, snapshot);
		return true;
	}

	redoLexical(editor: ICodeEditor, promptBarId?: string): boolean {
		const bar = this.lexicalBarFor(editor, promptBarId);
		if (!bar) {
			return false;
		}
		const snapshot = redoPromptBarInputHistory(bar.lexicalInputHistory);
		if (!snapshot) {
			return false;
		}
		this.applyInputSnapshot(bar, snapshot);
		return true;
	}

	private lexicalBarFor(editor: ICodeEditor, promptBarId?: string): IActivePromptBar | undefined {
		const bar = this.bars.get(editor);
		if (!bar || bar.settled) {
			return undefined;
		}
		if (promptBarId !== undefined && bar.id !== promptBarId) {
			return undefined;
		}
		return bar;
	}

	private inputSnapshot(bar: IActivePromptBar): IPromptBarInputSnapshot {
		const { input } = bar;
		return {
			value: input.value,
			selectionStart: input.selectionStart ?? input.value.length,
			selectionEnd: input.selectionEnd ?? input.value.length,
		};
	}

	/**
	 * Record the input's current content into the bar's history after a
	 * user edit. On a PUSH, mirror the step onto the workbench undo
	 * stack — verbatim port of the binary's `addToExternalUndoStack`
	 * (desk @24803750): one element per push, label "Lexical
	 * Operation", code "lexical-op", resource = the bar's file uri,
	 * whose undo/redo execute the two editor actions with the bar id.
	 */
	private recordInputHistory(bar: IActivePromptBar): void {
		const result = recordPromptBarInputHistory(bar.lexicalInputHistory, this.inputSnapshot(bar), Date.now());
		if (result !== 'push') {
			return;
		}
		const model = bar.editor.getModel();
		if (!model) {
			return;
		}
		const promptBarId = bar.id;
		this.undoRedoService.pushElement({
			type: UndoRedoElementType.Resource,
			resource: model.uri,
			label: 'Lexical Operation',
			code: 'lexical-op',
			undo: async () => {
				await this.commandService.executeCommand('editor.action.undoLexical', { promptBarId });
			},
			redo: async () => {
				await this.commandService.executeCommand('editor.action.redoLexical', { promptBarId });
			},
		});
	}

	/**
	 * Apply a history snapshot (the binary's
	 * `setEditorState(state, {tag:"historic"})`): set the text +
	 * selection WITHOUT recording — programmatic value sets fire no
	 * `input` event, so the apply cannot re-enter the history, matching
	 * the binary's "historic" tag discard.
	 */
	private applyInputSnapshot(bar: IActivePromptBar, snapshot: IPromptBarInputSnapshot): void {
		const { input } = bar;
		input.value = snapshot.value;
		const start = Math.min(snapshot.selectionStart, snapshot.value.length);
		const end = Math.min(snapshot.selectionEnd, snapshot.value.length);
		try {
			input.setSelectionRange(start, end);
		} catch {
			/* selection is best-effort on a detached input */
		}
		this.autogrow(bar);
		this.updateHeight(bar);
	}

	setHasDiff(editor: ICodeEditor, hasDiff: boolean): void {
		const bar = this.bars.get(editor);
		if (bar) {
			bar.hasDiff = hasDiff;
		}
	}

	setModelProvider(provider: () => Promise<readonly IPromptBarModelRef[]>): void {
		this.modelProvider = provider;
	}

	/**
	 * `cmdk.togglePromptBarModel` — "Open model toggle".
	 *
	 * cmdk-model-eligibility (Cursor parity): `models` is already the
	 * ELIGIBLE list (filtered by the inline-edit service per the staff
	 * criteria in forum 146433 + the binary `supportsCmdK` flag) — the
	 * picker simply never shows ineligible models, exactly like Cursor.
	 *
	 * FALLBACK DECISION (task point 3): no Cursor evidence was found for
	 * what happens when the previously selected model becomes ineligible
	 * (no documented warning toast or fallback model — the observable
	 * behavior is only that ineligible models are absent from the list and
	 * the picker defaults to "Auto"). The chosen behavior is a SILENT
	 * fallback to Auto (engine default) when the picker's eligible list no
	 * longer contains the bar's current selection. Silent, not a warning
	 * toast — inventing a warning would be unverified behavior. The
	 * fallback is logged (dev-facing) instead of shown (user-facing).
	 */
	async toggleModelPicker(editor: ICodeEditor): Promise<void> {
		const bar = this.bars.get(editor);
		const models = this.modelProvider ? await this.modelProvider() : [];
		if (bar && !bar.settled && bar.model && !models.some((m) => promptBarModelRefEquals(m, bar.model))) {
			// The bar's current selection is no longer Cmd+K-eligible (e.g.
			// the engine catalog changed since it was picked) — fall back to
			// Auto, mirroring Cursor's picker default ("Auto (engine default)").
			this.logService.trace(
				`[inline-edit] Cmd+K model ${bar.model.providerID}/${bar.model.id} no longer eligible — falling back to Auto`,
			);
			bar.model = undefined;
			bar.modelButton.textContent = 'Auto';
		}
		const picks: Array<{ label: string; description?: string; model?: IPromptBarModelRef }> = [
			{
				label: localize('promptBar.model.auto', 'Auto (engine default)'),
				description: models.length === 0
					? localize('promptBar.model.autoHint', 'The engine picks the model')
					: undefined,
				model: undefined,
			},
			...models.map((m) => ({
				label: m.name ?? `${m.providerID}/${m.id}`,
				description: m.name ? `${m.providerID}/${m.id}` : undefined,
				model: m,
			})),
		];
		const pick = await this.quickInputService.pick(picks, {
			placeHolder: localize('promptBar.model.pick', 'Select model for this inline edit'),
		});
		if (!pick) {
			return;
		}
		const current = this.bars.get(editor);
		if (current && !current.settled) {
			current.model = pick.model;
			current.modelButton.textContent = pick.model?.name ?? pick.model?.id ?? 'Auto';
			current.modelButton.title = localize('promptBar.model.toggle', 'Open model toggle');
		}
	}

	override dispose(): void {
		for (const bar of this.bars.values()) {
			this.closeBar(bar, undefined);
		}
		this.bars.clear();
		super.dispose();
	}

	// ------------------------------------------------------------------ //
	// DOM

	private buildDom(options: IInlineEditPromptBarOptions): {
		bigContainer: HTMLElement;
		input: HTMLTextAreaElement;
		modeButton: HTMLButtonElement;
		menu: HTMLElement;
		modelButton: HTMLButtonElement;
		disposables: IDisposable[];
	} {
		const disposables: IDisposable[] = [];
		const bigContainer = dom.$('.ide-prompt-bar');
		const row = dom.$('.ide-prompt-bar-row');
		const modeButton = dom.$('button.ide-prompt-bar-mode') as HTMLButtonElement;
		const menu = dom.$('.ide-prompt-bar-menu');
		menu.style.display = 'none';
		const input = dom.$('textarea.ide-prompt-bar-input') as HTMLTextAreaElement;
		input.setAttribute('rows', '1');
		input.setAttribute('spellcheck', 'false');
		input.placeholder = options.followUp
			? PROMPT_BAR_FOLLOWUP_PLACEHOLDER
			: PROMPT_BAR_PLACEHOLDERS['edit_selection'];
		if (options.previous) {
			input.value = options.previous;
		}
		const modelButton = dom.$('button.ide-prompt-bar-model') as HTMLButtonElement;
		modelButton.textContent = 'Auto';
		modelButton.title = localize('promptBar.model.toggle', 'Open model toggle');
		const submitButton = dom.$('button.ide-prompt-bar-submit') as HTMLButtonElement;
		submitButton.textContent = '\u23CE'; // ⏎ — submit affordance
		submitButton.title = localize('promptBar.submit', 'Submit (Enter)');

		for (const descriptor of PROMPT_BAR_MODES) {
			const item = dom.$('button.ide-prompt-bar-menu-item') as HTMLButtonElement;
			const label = dom.$('span.ide-prompt-bar-menu-label');
			label.textContent = descriptor.label;
			item.appendChild(label);
			if (descriptor.shortcut) {
				const shortcut = dom.$('span.ide-prompt-bar-menu-shortcut');
				shortcut.textContent = descriptor.shortcut;
				item.appendChild(shortcut);
			}
			item.dataset['mode'] = descriptor.id;
			menu.appendChild(item);
		}

		row.appendChild(modeButton);
		row.appendChild(input);
		row.appendChild(modelButton);
		row.appendChild(submitButton);
		bigContainer.appendChild(row);
		bigContainer.appendChild(menu);
		this.setModeUi({ modeButton, menu, input }, 'edit_selection', options.followUp);

		return { bigContainer, input, modeButton, menu, modelButton, disposables };
	}

	private setModeUi(bar: Pick<IActivePromptBar, 'modeButton' | 'menu' | 'input'>, mode: PromptBarMode, followUp: boolean): void {
		const descriptor = PROMPT_BAR_MODES.find((d) => d.id === mode)!;
		bar.modeButton.textContent = descriptor.label;
		bar.input.placeholder = followUp ? PROMPT_BAR_FOLLOWUP_PLACEHOLDER : PROMPT_BAR_PLACEHOLDERS[mode];
		for (const child of bar.menu.children) {
			const el = child as HTMLElement;
			el.classList.toggle('checked', el.dataset['mode'] === mode);
		}
	}

	private wireEvents(bar: IActivePromptBar, options: IInlineEditPromptBarOptions): void {
		const { editor, input, modeButton, menu, modelButton } = bar;
		const d = bar.disposables;

		const setMode = (mode: PromptBarMode): void => {
			bar.mode = mode;
			this.setModeUi(bar, mode, options.followUp);
			menu.style.display = 'none';
		};

		d.push(dom.addDisposableListener(modeButton, dom.EventType.CLICK, () => {
			menu.style.display = menu.style.display === 'none' ? '' : 'none';
		}));
		d.push(dom.addDisposableListener(menu, dom.EventType.CLICK, (e) => {
			const target = (e.target as HTMLElement).closest('[data-mode]') as HTMLElement | null;
			const mode = target?.dataset['mode'] as PromptBarMode | undefined;
			if (mode) {
				setMode(mode);
				input.focus();
			}
		}));
		// Clicking anywhere outside the bar dismisses the mode menu. Focus moves
		// that stay inside the bar (input <-> mode button <-> menu items) must
		// NOT dismiss it — focusout fires before click, so a naive deferred
		// hide would immediately close the just-opened menu.
		d.push(dom.addDisposableListener(bar.bigContainer, dom.EventType.FOCUS_OUT, (e) => {
			const related = (e as FocusEvent).relatedTarget as Node | null;
			if (related && bar.bigContainer.contains(related)) {
				return;
			}
			// Defer one tick so a menu-item click still lands first.
			setTimeout(() => {
				if (!bar.settled) {
					menu.style.display = 'none';
				}
			}, 0);
		}));
		d.push(dom.addDisposableListener(modelButton, dom.EventType.CLICK, () => {
			this.commandService.executeCommand('cmdk.togglePromptBarModel');
		}));
		d.push(dom.addDisposableListener(input, dom.EventType.INPUT, () => {
			this.autogrow(bar);
			this.updateHeight(bar);
			// GAPS-139: record the edit in this bar's own history (and
			// mirror PUSH steps onto the workbench undo stack).
			this.recordInputHistory(bar);
		}));
		d.push(dom.addDisposableListener(input, dom.EventType.FOCUS, () => {
			this.editorPromptBarFocusedKey.set(true);
		}));
		d.push(dom.addDisposableListener(input, dom.EventType.BLUR, () => {
			this.editorPromptBarFocusedKey.set(false);
		}));
		d.push(dom.addDisposableListener(input, dom.EventType.KEY_DOWN, (e) => {
			const kev = e as KeyboardEvent;
			// GAPS-139: the binary's input owns its history
			// (`turnOffCmdZ` — the prompt bar always carries the
			// external history bundle): Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z
			// and non-mac Ctrl+Y are preventDefault'ed so the browser's
			// native textarea undo NEVER runs, and are routed to the
			// workbench undo stack for the bar's file uri — verbatim
			// the binary's runExternalUndo/runExternalRedo bodies
			// (`undoRedoService.undo(vi.uri)` / `.redo(vi.uri)`),
			// reached there via Lexical UNDO_COMMAND/REDO_COMMAND.
			const historyShortcut = promptBarHistoryShortcut(kev, isMacintosh);
			if (historyShortcut) {
				kev.preventDefault();
				kev.stopPropagation();
				const uri = editor.getModel()?.uri;
				if (uri) {
					if (historyShortcut === 'undo') {
						void this.undoRedoService.undo(uri);
					} else {
						void this.undoRedoService.redo(uri);
					}
				}
				return;
			}
			if (kev.key === 'Escape') {
				// Tier-1 Esc: prompt-bar-focused → closePromptBar.
				kev.preventDefault();
				kev.stopPropagation();
				this.closeBar(bar, undefined);
				editor.focus();
				return;
			}
			if (kev.key === 'Enter' && !kev.shiftKey && !kev.ctrlKey && !kev.metaKey) {
				kev.preventDefault();
				kev.stopPropagation();
				if (kev.altKey && bar.mode !== 'quick_question') {
					// Binary: Alt+Enter outside quick_question switches the
					// mode (stopPropagation, no submit yet).
					setMode('quick_question');
					return;
				}
				// Enter submits (chatMode is implied by quick_question mode).
				this.submit(bar);
				return;
			}
			if ((kev.key === 'ArrowUp' || kev.key === 'ArrowDown') && this.shouldUseHistory(input, kev.key === 'ArrowUp')) {
				kev.preventDefault();
				kev.stopPropagation();
				this.cycleHistory(bar, kev.key === 'ArrowUp' ? -1 : 1);
				return;
			}
			if ((kev.ctrlKey || kev.metaKey) && kev.key === '/') {
				// `cmdk.togglePromptBarModel` also has a keybinding; handle it
				// in-bar too so it works even if the binding is remapped.
				kev.preventDefault();
				kev.stopPropagation();
				void this.toggleModelPicker(editor);
			}
		}));

		const submitButton = bar.bigContainer.querySelector('.ide-prompt-bar-submit') as HTMLButtonElement;
		d.push(dom.addDisposableListener(submitButton, dom.EventType.CLICK, () => this.submit(bar)));
	}

	/** Enter submits; empty input is ignored (matches quick-input validation). */
	private submit(bar: IActivePromptBar): void {
		const text = bar.input.value.trim();
		if (!text) {
			return;
		}
		// GAPS-170: tooltip pipeline producer/disable — the binary emits
		// `editor.cmdk.submit` on prompt-bar submit (desk@24795152);
		// this is the disableOn event of the `editor.cmdk` pipeline.
		this.tooltipService.registerEvent('editor.cmdk.submit');
		this.pushHistory(text);
		this.closeBar(bar, { mode: bar.mode, text, model: bar.model, selections: [...bar.selections] });
	}

	private closeBar(bar: IActivePromptBar, result: IInlineEditPromptBarResult | undefined): void {
		if (bar.settled) {
			return;
		}
		bar.settled = true;
		this.bars.delete(bar.editor);
		try {
			bar.editor.changeViewZones((accessor) => accessor.removeZone(bar.zoneId));
		} catch {
			/* the editor may already be gone */
		}
		try {
			if (bar.decoIds.length > 0) {
				bar.editor.deltaDecorations(bar.decoIds, []);
			}
		} catch {
			/* the editor may already be gone */
		}
		for (const disposable of bar.disposables) {
			disposable.dispose();
		}
		bar.decoIds = [];
		if (this.bars.size === 0) {
			this.editorHasPromptBarKey.set(false);
		}
		this.editorPromptBarFocusedKey.set(false);
		bar.resolve(result);
	}

	// ------------------------------------------------------------------ //
	// Sizing — binary: Math.max(62, scrollHeight + 6); >5000px → warn + clamp.

	private autogrow(bar: IActivePromptBar): void {
		const input = bar.input;
		input.style.height = 'auto';
		input.style.height = `${input.scrollHeight}px`;
	}

	private updateHeight(bar: IActivePromptBar): void {
		const scrollHeight = bar.bigContainer.scrollHeight;
		// Binary V9c(t): Math.max(62, (bigContainer?.scrollHeight ?? 0) + 6).
		let height = Math.max(PROMPT_BAR_MIN_HEIGHT_PX, scrollHeight + 6);
		if (scrollHeight > PROMPT_BAR_MAX_HEIGHT_PX) {
			this.logService.warn(
				`[composer] prompt bar content height ${scrollHeight}px exceeds ${PROMPT_BAR_MAX_HEIGHT_PX}px — clamping with scroll.`
			);
			bar.bigContainer.style.maxHeight = `${PROMPT_BAR_MAX_HEIGHT_PX}px`;
			bar.bigContainer.style.overflowY = 'auto';
			height = PROMPT_BAR_MAX_HEIGHT_PX;
		}
		bar.zone.heightInPx = height;
		bar.editor.changeViewZones((accessor) => accessor.layoutZone(bar.zoneId));
	}

	// ------------------------------------------------------------------ //
	// ↑/↓ input history (`useArrowsForHistory: true` in the binary).

	private pushHistory(text: string): void {
		const last = this.inputHistory[this.inputHistory.length - 1];
		if (last !== text) {
			this.inputHistory.push(text);
		}
		this.historyIndex = -1;
		this.historyDraft = '';
	}

	/** Intercept ↑/↓ only when the caret can't move within multiline text. */
	private shouldUseHistory(input: HTMLTextAreaElement, up: boolean): boolean {
		if (this.inputHistory.length === 0) {
			return false;
		}
		const value = input.value;
		const caret = input.selectionStart ?? value.length;
		if (!value.includes('\n')) {
			return true;
		}
		if (up) {
			return caret <= value.indexOf('\n');
		}
		return caret > value.lastIndexOf('\n');
	}

	/**
	 * GAPS-151 (fixes NF-146-1, QA round 12 on GAPS-139): ↑/↓ prompt-
	 * history navigation IS recorded in this bar's input history.
	 *
	 * Binary evidence (Cursor 3.25.9, re-sliced by QA-146 and spot-
	 * checked by GAPS-151): the prompt bar's props carry
	 * `useArrowsForHistory:!0` together with its `externalHistoryBundle`
	 * (desk @24802531 / @24803750), and the ↑/↓ plugin `s3b` @24716506
	 * navigates via `t.update(...)` replacing the root's paragraph —
	 * WITHOUT the `"historic"` tag. The history update listener
	 * (`wPb`/`NNp` @24366344/@24364484) therefore classifies every
	 * navigation as a PUSH (the replacement node has a new key, so it
	 * can never be a MERGE continuation): each ↑/↓ is one real undo
	 * step on the bar's internal stack AND one mirrored "Lexical
	 * Operation" element on the workbench stack.
	 *
	 * (This corrects the GAPS-139 D5 note, which claimed navigation
	 * stayed out of this history; that was true of the fork's code at
	 * the time, not of the binary.)
	 *
	 * Implementation: after the value is set (including the draft-
	 * restore branches), record through the same path as a typed edit
	 * (`recordInputHistory`). The merge burst is broken on both sides
	 * of the record (`lastEdit = null`) because the binary's full-node
	 * replacement is never a merge continuation of the preceding edit
	 * and never absorbs the following one — a navigation is always
	 * its own step. A navigation landing on text identical to the
	 * current snapshot records 'discard', matching the binary's
	 * same-text classification.
	 */
	private cycleHistory(bar: IActivePromptBar, direction: -1 | 1): void {
		if (this.historyIndex === -1) {
			if (direction === 1) {
				return; // nothing newer than the current draft
			}
			this.historyDraft = bar.input.value;
			this.historyIndex = this.inputHistory.length - 1;
		} else {
			this.historyIndex += direction;
		}
		if (this.historyIndex < 0) {
			this.historyIndex = -1;
			bar.input.value = this.historyDraft;
		} else if (this.historyIndex >= this.inputHistory.length) {
			this.historyIndex = -1;
			bar.input.value = this.historyDraft;
		} else {
			bar.input.value = this.inputHistory[this.historyIndex] ?? '';
		}
		// NF-146-1: the navigation step enters the bar's input history
		// (PUSH + workbench mirror), exactly like a typed edit.
		bar.lexicalInputHistory.lastEdit = null;
		this.recordInputHistory(bar);
		bar.lexicalInputHistory.lastEdit = null;
		this.autogrow(bar);
		this.updateHeight(bar);
	}
}
