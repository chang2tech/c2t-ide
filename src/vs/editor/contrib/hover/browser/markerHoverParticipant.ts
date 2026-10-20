/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { isNonEmptyArray } from '../../../../base/common/arrays.js';
import { CancelablePromise, createCancelablePromise, disposableTimeout } from '../../../../base/common/async.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Disposable, DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { basename } from '../../../../base/common/resources.js';
import { ICodeEditor } from '../../../browser/editorBrowser.js';
import { EditorOption } from '../../../common/config/editorOptions.js';
import { Range } from '../../../common/core/range.js';
import { CodeActionTriggerType } from '../../../common/languages.js';
import { IModelDecoration } from '../../../common/model.js';
import { ILanguageFeaturesService } from '../../../common/services/languageFeatures.js';
import { IMarkerDecorationsService } from '../../../common/services/markerDecorations.js';
import { ApplyCodeActionReason, getCodeActions, quickFixCommandId } from '../../codeAction/browser/codeAction.js';
import { CodeActionController } from '../../codeAction/browser/codeActionController.js';
import { CodeActionKind, CodeActionSet, CodeActionTrigger, CodeActionTriggerSource } from '../../codeAction/common/types.js';
import { MarkerController, NextMarkerAction } from '../../gotoError/browser/gotoError.js';
import { HoverAnchor, HoverAnchorType, IEditorHoverParticipant, IEditorHoverRenderContext, IHoverPart, IRenderedHoverPart, IRenderedHoverParts, RenderedHoverParts } from './hoverTypes.js';
import * as nls from '../../../../nls.js';
import { IMenuService, MenuId, MenuItemAction } from '../../../../platform/actions/common/actions.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { ITextEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IMarker, IMarkerData, MarkerSeverity } from '../../../../platform/markers/common/markers.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { Progress } from '../../../../platform/progress/common/progress.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';

const $ = dom.$;

export class MarkerHover implements IHoverPart {

	constructor(
		public readonly owner: IEditorHoverParticipant<MarkerHover>,
		public readonly range: Range,
		public readonly marker: IMarker,
	) { }

	public isValidForHoverAnchor(anchor: HoverAnchor): boolean {
		return (
			anchor.type === HoverAnchorType.Range
			&& this.range.startColumn <= anchor.range.startColumn
			&& this.range.endColumn >= anchor.range.endColumn
		);
	}
}

const markerCodeActionTrigger: CodeActionTrigger = {
	type: CodeActionTriggerType.Invoke,
	filter: { include: CodeActionKind.QuickFix },
	triggerAction: CodeActionTriggerSource.QuickFixHover
};

export class MarkerHoverParticipant implements IEditorHoverParticipant<MarkerHover> {

	public readonly hoverOrdinal: number = 1;

	private recentMarkerCodeActionsInfo: { marker: IMarker; hasCodeActions: boolean } | undefined = undefined;

	constructor(
		private readonly _editor: ICodeEditor,
		@IMarkerDecorationsService private readonly _markerDecorationsService: IMarkerDecorationsService,
		@IOpenerService private readonly _openerService: IOpenerService,
		@ILanguageFeaturesService private readonly _languageFeaturesService: ILanguageFeaturesService,
		@IMenuService private readonly _menuService: IMenuService,
		@IContextKeyService private readonly _contextKeyService: IContextKeyService,
		@IKeybindingService private readonly _keybindingService: IKeybindingService,
		@ICommandService private readonly _commandService: ICommandService,
	) { }

	public computeSync(anchor: HoverAnchor, lineDecorations: IModelDecoration[]): MarkerHover[] {
		if (!this._editor.hasModel() || anchor.type !== HoverAnchorType.Range && !anchor.supportsMarkerHover) {
			return [];
		}

		const model = this._editor.getModel();
		const anchorRange = anchor.range;
		if (!model.isValidRange(anchor.range)) {
			return [];
		}
		const lineNumber = anchorRange.startLineNumber;
		const maxColumn = model.getLineMaxColumn(lineNumber);
		const result: MarkerHover[] = [];
		for (const d of lineDecorations) {
			const startColumn = (d.range.startLineNumber === lineNumber) ? d.range.startColumn : 1;
			const endColumn = (d.range.endLineNumber === lineNumber) ? d.range.endColumn : maxColumn;

			const marker = this._markerDecorationsService.getMarker(model.uri, d);
			if (!marker) {
				continue;
			}

			const range = new Range(anchor.range.startLineNumber, startColumn, anchor.range.startLineNumber, endColumn);
			result.push(new MarkerHover(this, range, marker));
		}

		return result;
	}

	public renderHoverParts(context: IEditorHoverRenderContext, hoverParts: MarkerHover[]): IRenderedHoverParts<MarkerHover> {
		if (!hoverParts.length) {
			return new RenderedHoverParts([]);
		}
		const renderedHoverParts: IRenderedHoverPart<MarkerHover>[] = [];
		hoverParts.forEach(hoverPart => {
			const renderedMarkerHover = this._renderMarkerHover(hoverPart);
			context.fragment.appendChild(renderedMarkerHover.hoverElement);
			renderedHoverParts.push(renderedMarkerHover);
		});
		const markerHoverForStatusbar = hoverParts.length === 1 ? hoverParts[0] : hoverParts.sort((a, b) => MarkerSeverity.compare(a.marker.severity, b.marker.severity))[0];
		const disposables = this._renderMarkerStatusbar(context, markerHoverForStatusbar);
		return new RenderedHoverParts(renderedHoverParts, disposables);
	}

	public getAccessibleContent(hoverPart: MarkerHover): string {
		const { marker } = hoverPart;
		const relatedInformation = isNonEmptyArray(marker.relatedInformation)
			? marker.relatedInformation.map(related => `${basename(related.resource)}(${related.startLineNumber}, ${related.startColumn}): ${related.message}`).join('\n')
			: undefined;
		return [marker.message, relatedInformation].filter(value => !!value).join('\n');
	}

	private _renderMarkerHover(markerHover: MarkerHover): IRenderedHoverPart<MarkerHover> {
		const disposables: DisposableStore = new DisposableStore();
		const hoverElement = $('div.hover-row');
		const markerElement = dom.append(hoverElement, $('div.marker.hover-contents'));
		const { source, message, code, relatedInformation } = markerHover.marker;

		this._editor.applyFontInfo(markerElement);
		const messageElement = dom.append(markerElement, $('span'));
		messageElement.style.whiteSpace = 'pre-wrap';
		messageElement.innerText = message;

		// IDE-CODE (DEV-GAPS-83, agent-fix-with-agent-error): Cursor's
		// patched MarkerHoverParticipant (3.25.9 glass bundle, class `K4c`,
		// byte ~36261109) renders a fix-buttons row under EVERY marker
		// hover message:
		//   div.fix-buttons-container > div.fix-buttons-row > button, plus
		//   div.fix-buttons-hint with `${mac ? "⌘" : "Ctrl"}+click to open in new tab`.
		// The primary button (factory `Mhb`, byte ~36258759) is labelled
		// `"Fix with Agent"` + the DYNAMIC KEYBINDING LABEL of the
		// "Investigate Error in Chat" command when one exists:
		// `"Fix with Agent" + (kb ? ` (${kb.getLabel()})` : "")`.
		// HONEST-DIVERGENCE: the binary looks up `composer.fixerrormessage`;
		// the fork registers that command as `composer.investigateError`
		// (pre-existing migration decision) with the same CtrlCmd+Shift+D
		// chord, so the fork id is looked up here.
		// Click semantics (binary onclick): plain click fixes in the
		// CURRENT chat (addToCurrent=true); Ctrl/Cmd+click fixes in a NEW
		// chat (addToCurrent=false). The binary also renders a secondary
		// "Fix in Cloud Agent" button, but only when a cloud-agent bcId
		// exists for the window — the fork has none, so it is omitted.
		// Binary telemetry (`hover_bar.submit_fix`) is emitted by the
		// extension-side handler (fork convention: `[telemetry]` log lines).
		const fixButtonsContainer = dom.append(hoverElement, $('div.fix-buttons-container'));
		const fixButtonsRow = dom.append(fixButtonsContainer, $('div.fix-buttons-row'));
		const investigateKeybinding = this._keybindingService.lookupKeybinding('composer.investigateError');
		const fixButton = this._createFixWithAgentButton(
			'Fix with Agent' + (investigateKeybinding ? ` (${investigateKeybinding.getLabel()})` : ''),
			markerHover,
			disposables
		);
		fixButtonsRow.appendChild(fixButton);
		const fixButtonsHint = dom.append(fixButtonsContainer, $('div.fix-buttons-hint'));
		fixButtonsHint.textContent = `${isMacintosh ? '⌘' : 'Ctrl'}+click to open in new tab`;

		if (source || code) {
			// Code has link
			if (code && typeof code !== 'string') {
				const sourceAndCodeElement = $('span');
				if (source) {
					const sourceElement = dom.append(sourceAndCodeElement, $('span'));
					sourceElement.innerText = source;
				}
				const codeLink = dom.append(sourceAndCodeElement, $('a.code-link'));
				codeLink.setAttribute('href', code.target.toString(true));

				disposables.add(dom.addDisposableListener(codeLink, 'click', (e) => {
					this._openerService.open(code.target);
					e.preventDefault();
					e.stopPropagation();
				}));

				const codeElement = dom.append(codeLink, $('span'));
				codeElement.innerText = code.value;

				const detailsElement = dom.append(markerElement, sourceAndCodeElement);
				detailsElement.style.opacity = '0.6';
				detailsElement.style.paddingLeft = '6px';
			} else {
				const detailsElement = dom.append(markerElement, $('span'));
				detailsElement.style.opacity = '0.6';
				detailsElement.style.paddingLeft = '6px';
				detailsElement.innerText = source && code ? `${source}(${code})` : source ? source : `(${code})`;
			}
		}

		if (isNonEmptyArray(relatedInformation)) {
			for (const { message, resource, startLineNumber, startColumn } of relatedInformation) {
				const relatedInfoContainer = dom.append(markerElement, $('div'));
				relatedInfoContainer.style.marginTop = '8px';
				const a = dom.append(relatedInfoContainer, $('a'));
				a.innerText = `${basename(resource)}(${startLineNumber}, ${startColumn}): `;
				a.style.cursor = 'pointer';
				disposables.add(dom.addDisposableListener(a, 'click', (e) => {
					e.stopPropagation();
					e.preventDefault();
					if (this._openerService) {
						const editorOptions: ITextEditorOptions = { selection: { startLineNumber, startColumn } };
						this._openerService.open(resource, {
							fromUserGesture: true,
							editorOptions
						}).catch(onUnexpectedError);
					}
				}));
				const messageElement = dom.append<HTMLAnchorElement>(relatedInfoContainer, $('span'));
				messageElement.innerText = message;
				this._editor.applyFontInfo(messageElement);
			}
		}

		const renderedHoverPart: IRenderedHoverPart<MarkerHover> = {
			hoverPart: markerHover,
			hoverElement,
			dispose: () => disposables.dispose()
		};
		return renderedHoverPart;
	}

	/**
	 * IDE-CODE (DEV-GAPS-83): port of the binary's fix-button factory `Mhb`
	 * (Cursor 3.25.9 glass bundle, byte ~36258759), primary variant:
	 * `button.fix-in-composer` with a `span.text`, 150px wide, primary
	 * button colors, `fix-in-composer-button-hover` class, title
	 * `${Cmd|Ctrl}+click to fix in new chat`. The click runs the verbatim
	 * command `editor.action.fixInAgent` with the binary's code-action
	 * argument shape plus the click-derived addToCurrent flag.
	 */
	private _createFixWithAgentButton(label: string, markerHover: MarkerHover, disposables: DisposableStore): HTMLButtonElement {
		const button = $('button.fix-in-composer') as HTMLButtonElement;
		const text = dom.append(button, $('span.text'));
		text.innerText = label;
		button.style.border = 'none';
		button.style.borderRadius = '2px';
		button.style.cursor = 'pointer';
		button.style.padding = '4px 8px';
		button.style.fontSize = '12px';
		button.style.display = 'inline-flex';
		button.style.alignItems = 'center';
		button.style.justifyContent = 'center';
		button.style.userSelect = 'none';
		button.style.width = '150px';
		button.style.backgroundColor = 'var(--vscode-button-background)';
		button.style.color = 'var(--vscode-button-foreground)';
		button.style.marginRight = '8px';
		button.classList.add('fix-in-composer-button-hover');
		button.title = `${isMacintosh ? 'Cmd' : 'Ctrl'}+click to fix in new chat`;
		disposables.add(dom.addDisposableListener(button, 'click', (e: MouseEvent) => {
			// Binary: `const p = !(h.ctrlKey || h.metaKey)` -> addToCurrent.
			const addToCurrent = !(e.ctrlKey || e.metaKey);
			const { marker } = markerHover;
			void this._commandService.executeCommand('editor.action.fixInAgent',
				marker.resource.toString(),
				marker.message,
				new Range(marker.startLineNumber, marker.startColumn, marker.endLineNumber, marker.endColumn),
				addToCurrent);
		}));
		return button;
	}

	private _renderMarkerStatusbar(context: IEditorHoverRenderContext, markerHover: MarkerHover): IDisposable {
		const disposables = new DisposableStore();
		if (markerHover.marker.severity === MarkerSeverity.Error || markerHover.marker.severity === MarkerSeverity.Warning || markerHover.marker.severity === MarkerSeverity.Info) {
			const markerController = MarkerController.get(this._editor);
			if (markerController) {
				context.statusBar.addAction({
					label: nls.localize('view problem', "View Problem"),
					commandId: NextMarkerAction.ID,
					run: () => {
						context.hide();
						markerController.showAtMarker(markerHover.marker);
						this._editor.focus();
					}
				});
			}
		}

		// Menu-contributed actions (e.g. fix with inline chat)
		const menuActions: MenuItemAction[] = [];
		for (const [, actions] of this._menuService.getMenuActions(MenuId.MarkerHoverStatusBar, this._contextKeyService)) {
			for (const action of actions) {
				if (action instanceof MenuItemAction && action.enabled) {
					menuActions.push(action);
				}
			}
		}
		const renderMenuActions = () => {
			for (const action of menuActions) {
				context.statusBar.addAction({
					label: action.label,
					commandId: action.id,
					iconClass: action.class,
					run: () => {
						context.hide();
						this._editor.setSelection(Range.lift(markerHover.range));
						action.run();
					}
				});
			}
		};

		if (!this._editor.getOption(EditorOption.readOnly)) {
			const quickfixPlaceholderElement = context.statusBar.append($('div'));
			if (this.recentMarkerCodeActionsInfo) {
				if (IMarkerData.makeKey(this.recentMarkerCodeActionsInfo.marker) === IMarkerData.makeKey(markerHover.marker)) {
					if (!this.recentMarkerCodeActionsInfo.hasCodeActions) {
						if (menuActions.length === 0) {
							quickfixPlaceholderElement.textContent = nls.localize('noQuickFixes', "No quick fixes available");
						}
					}
				} else {
					this.recentMarkerCodeActionsInfo = undefined;
				}
			}
			const updatePlaceholderDisposable = this.recentMarkerCodeActionsInfo && !this.recentMarkerCodeActionsInfo.hasCodeActions ? Disposable.None : disposableTimeout(() => quickfixPlaceholderElement.textContent = nls.localize('checkingForQuickFixes', "Checking for quick fixes..."), 200, disposables);
			if (!quickfixPlaceholderElement.textContent) {
				// Have some content in here to avoid flickering
				quickfixPlaceholderElement.textContent = String.fromCharCode(0xA0); // &nbsp;
			}
			const codeActionsPromise = this.getCodeActions(markerHover.marker);
			disposables.add(toDisposable(() => codeActionsPromise.cancel()));
			codeActionsPromise.then(actions => {
				updatePlaceholderDisposable.dispose();
				this.recentMarkerCodeActionsInfo = { marker: markerHover.marker, hasCodeActions: actions.validActions.length > 0 };

				if (!this.recentMarkerCodeActionsInfo.hasCodeActions) {
					actions.dispose();
					if (menuActions.length === 0) {
						quickfixPlaceholderElement.textContent = nls.localize('noQuickFixes', "No quick fixes available");
					} else {
						quickfixPlaceholderElement.style.display = 'none';
					}
					renderMenuActions();
					return;
				}
				quickfixPlaceholderElement.style.display = 'none';

				let showing = false;
				disposables.add(toDisposable(() => {
					if (!showing) {
						actions.dispose();
					}
				}));

				context.statusBar.addAction({
					label: nls.localize('quick fixes', "Quick Fix..."),
					commandId: quickFixCommandId,
					run: (target) => {
						showing = true;
						const controller = CodeActionController.get(this._editor);
						const elementPosition = dom.getDomNodePagePosition(target);
						controller?.showCodeActions(markerCodeActionTrigger, actions, {
							x: elementPosition.left,
							y: elementPosition.top,
							width: elementPosition.width,
							height: elementPosition.height
						});
					}
				});

				const aiCodeAction = actions.validActions.find(action => action.action.isAI);
				if (aiCodeAction) {
					context.statusBar.addAction({
						label: aiCodeAction.action.title,
						commandId: aiCodeAction.action.command?.id ?? '',
						iconClass: ThemeIcon.asClassName(Codicon.sparkle),
						run: () => {
							const controller = CodeActionController.get(this._editor);
							controller?.applyCodeAction(aiCodeAction, false, false, ApplyCodeActionReason.FromProblemsHover);
						}
					});
				} else {
					// Only show menu-contributed actions (e.g. inline chat Fix) when there
					// is no AI code action, to avoid duplicate Fix entry points.
					renderMenuActions();
				}

				// Notify that the contents have changed given we added
				// actions to the hover
				// https://github.com/microsoft/vscode/issues/250424
				context.onContentsChanged();

			}, onUnexpectedError);
		} else {
			renderMenuActions();
		}

		return disposables;
	}

	private getCodeActions(marker: IMarker): CancelablePromise<CodeActionSet> {
		return createCancelablePromise(cancellationToken => {
			return getCodeActions(
				this._languageFeaturesService.codeActionProvider,
				this._editor.getModel()!,
				new Range(marker.startLineNumber, marker.startColumn, marker.endLineNumber, marker.endColumn),
				markerCodeActionTrigger,
				Progress.None,
				cancellationToken);
		});
	}
}
