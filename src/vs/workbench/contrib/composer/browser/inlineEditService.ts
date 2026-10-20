/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Migrated — vscode API → DI (2026-10-19).
//
// vscode API → core mapping used here:
//   vscode.window.activeTextEditor / onDidChangeActiveTextEditor
//       → IEditorService.activeTextEditorControl / onDidActiveEditorChange (isCodeEditor guard)
//   vscode.TextEditor / TextDocument → ICodeEditor (vs/editor/browser/editorBrowser) /
//                                      ITextModel (vs/editor/common/model)
//   editor.edit(b => b.replace(range, text)) → ICodeEditor.executeEdits
//   vscode.window.createInputBox (+buttons)  → IQuickInputService.createInputBox
//       (buttons use iconClass: ThemeIcon.asClassName — core IQuickInputButton
//       has no ThemeIcon iconPath)
//   vscode.window.showErrorMessage / showWarningMessage / showInformationMessage
//       → INotificationService.error / warn / info
//   modal showWarningMessage ("Reject anyway"/"Keep") and the "Apply as inline
//   edit?" choice → IDialogService.confirm (audit mapping: modal confirm → IDialogService)
//   "Open Settings" action on the engineMode warning → INotificationService.prompt
//       with an IPromptChoice (core warn()/info() take no actions)
//   vscode.workspace.getConfiguration("ide.agent" / "ide.cmdk")
//       → IConfigurationService.getValue
//   vscode.workspace.fs.readDirectory/readFile → IFileService.readDirectory/readFile
//   vscode.workspace.textDocuments → IModelService.getModels()
//   vscode.workspace.asRelativePath → extUri.relativePath over workspace folders
//       (IWorkspaceContextService has no asRelativePath)
//   vscode.workspace.openTextDocument + window.showTextDocument(Beside)
//       → IUntitledTextEditorService.create + IEditorService.openEditor(resource, SIDE_GROUP)
//   vscode.commands.executeCommand("setContext", KEY, v)
//       → IContextKeyService.createKey(KEY, false).set(v) (audit mapping)
//   vscode.commands.executeCommand("workbench.action.openSettings", …)
//       → ICommandService.executeCommand
//   vscode.window.withProgress({ location: ProgressLocation.Notification })
//       → IProgressService.withProgress (cancellation via CancellationTokenSource
//         wired to onDidCancel — core withProgress tasks receive no token)
//   vscode.window.createStatusBarItem(Right, 101)
//       → IStatusbarService.addEntry (accessor.update/dispose)
//   vscode.window.createTextEditorDecorationType + editor.setDecorations
//       → ICodeEditor.deltaDecorations with IModelDecorationOptions
//         (added lines: className 'ide-inline-edit-added', isWholeLine;
//          removed lines: per-line `before` injected text with inlineClassName
//          'ide-inline-edit-removed' — InjectedTextOptions.content must be single-line.
//          Style these classes in composer.css; the `ide.cmdk.useThemedDiffBackground`
//          setting switches the added-lines class between themed/plain variants.)
//   vscode.ThemeColor → ThemeColor (vs/platform/theme/common/themeService)
//   vscode.ThemeIcon  → ThemeIcon (vs/base/common/themables) — interface, not a class
//   vscode.Uri / Range / Position → URI / Range / Position (core)
//
// Collaborators not yet migrated (structural interfaces below; satisfied by the
// sibling agents' files):
//   IdeCodeEngineAdapter → IInlineEditEngine / IInlineEditEngineFactory. The factory
//     is implemented by the contribution wiring site, which also supplies the output
//     channel (via IOutputService) and enginePath resolution (was: vscode.window
//     .createOutputChannel + defaultEnginePath() from composerDataService).
//   tryGetAiCodeTracking() → optional IInlineEditAiTracking (CAT-A aiCodeTracking.ts,
//     copied verbatim by a sibling agent).
//   takePendingSelection() → InlinePromptSelectionService (same migration batch).

import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { extUri } from '../../../../base/common/resources.js';
import { Range } from '../../../../editor/common/core/range.js';
import { Position } from '../../../../editor/common/core/position.js';
import { ICodeEditor, isCodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { ITextModel, IModelDecorationOptions } from '../../../../editor/common/model.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import Severity from '../../../../base/common/severity.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickInputButton } from '../../../../platform/quickinput/common/quickInput.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IContextKeyService, IContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IProgressService, ProgressLocation } from '../../../../platform/progress/common/progress.js';
import { IStatusbarService, IStatusbarEntryAccessor, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { IEditorService, SIDE_GROUP } from '../../../services/editor/common/editorService.js';
import { IUntitledTextEditorService } from '../../../services/untitled/common/untitledTextEditorService.js';
import { InlinePromptSelectionService, IPendingSelection } from './inlinePromptSelection.js';
import { heuristicSelect, trimSelectionEndingAtColumn1 } from '../common/autoSelect.js';

/**
 * InlineEditService — Cursor-style Cmd+K inline edit.
 *
 * Flow: prompt (quick input) → engine generates replacement code →
 * inline diff preview (applied + decorated) → accept (Ctrl+Enter) /
 * reject (Esc) → optional follow-up refinement.
 *
 * How Cursor does it (docs/inline-edit, deep-docs-all.md):
 *   C1 prompt bar at cursor · C2 inline generation (no selection) ·
 *   C3 inline edits on selection · C4 follow-up refines the edit ·
 *   C5 question mode (ask without editing) · C6 "do it" applies the
 *   suggested change · C7 default context gathering · C8 escalate to Agent.
 *
 * Two honest deviations from Cursor, forced by the VS Code extension API:
 *  - The prompt is a native quick-input box, not a cursor-anchored widget
 *    (the public API exposes no cursor-anchored input surface).
 *  - The default keybinding is Ctrl+I / Cmd+I. Cursor's Ctrl+K / Cmd+K are
 *    chord-prefix keys in stock VS Code; hijacking them would break every
 *    Ctrl+K / Cmd+K chord (comment, fold, …). Cursor's question-mode
 *    Alt+Enter and in-bar Cmd+L are exposed as explicit buttons on the
 *    input box — same behavior, since keys can't be intercepted inside a
 *    quick-input.
 */

export const INLINE_EDIT_CONTEXT_KEY = 'ideAgent.inlineEditPending';
const INLINE_EDIT_STATUS_ID = 'ideAgent.inlineEdit.status';

// NOTE (user directive 2026-10-19, refined same day): keep the curation caps
// that shape MODEL INPUT — focused context is a big part of why the agent
// feels smart (user: "không chừng nhờ cắt vậy mà chat cursor mới thông minh").
// Removed only the hostile refusal (MAX_TARGET_CHARS): the user's selection
// is the edit target, the model must see it whole — never refuse it.
const CONTEXT_LINES = 40;
const CONTEXT_CHARS = 4_000;
const MAX_FOLLOWUP_HISTORY_CHARS = 6_000;

/** One contiguous changed region between the original and proposed text. */
export interface DiffHunk {
	/** 0-based line range in the ORIGINAL text (end exclusive). */
	origStart: number;
	origEnd: number;
	/** 0-based line range in the PROPOSED text (end exclusive). */
	newStart: number;
	newEnd: number;
}

function getV(v: Map<number, number>, k: number): number {
	const val = v.get(k);
	// Unset diagonals are never read by the forward pass (only k±1 of visited
	// diagonals are ever queried); -1 is a safe fallback, not a live value.
	return val === undefined ? -1 : val;
}

type DiffOp =
	| { t: 0; a: number; b: number }
	| { t: 1; a: number; b: number }
	| { t: 2; a: number; b: number };

/**
 * Myers O(ND) line diff. Pure function — no VS Code dependency.
 * Returns hunks in document order.
 */
export function lineDiff(a: string[], b: string[]): DiffHunk[] {
	const n = a.length;
	const m = b.length;
	if (n === 0 && m === 0) {
		return [];
	}
	const max = n + m;
	let v = new Map<number, number>();
	v.set(1, 0);
	const trace: Array<Map<number, number>> = [];
	let done = false;
	for (let d = 0; d <= max && !done; d++) {
		const prev = v;
		const cur = new Map<number, number>();
		for (let k = -d; k <= d; k += 2) {
			let x: number;
			if (k === -d || (k !== d && getV(prev, k - 1) < getV(prev, k + 1))) {
				x = getV(prev, k + 1); // down: line inserted in b
			} else {
				x = getV(prev, k - 1) + 1; // right: line deleted from a
			}
			let y = x - k;
			while (x < n && y < m && a[x] === b[y]) {
				x++;
				y++;
			}
			cur.set(k, x);
			if (x >= n && y >= m) {
				done = true;
				break;
			}
		}
		trace.push(cur);
		v = cur;
	}

	// Backtrack from (n, m) to build the edit script (reversed).
	const ops: DiffOp[] = [];
	let x = n;
	let y = m;
	for (let d = trace.length - 1; d >= 1; d--) {
		const prev = trace[d - 1]!;
		const k = x - y;
		let prevK: number;
		if (k === -d || (k !== d && getV(prev, k - 1) < getV(prev, k + 1))) {
			prevK = k + 1; // came down: insertion
		} else {
			prevK = k - 1; // came right: deletion
		}
		const prevX = getV(prev, prevK);
		const prevY = prevX - prevK;
		while (x > prevX && y > prevY) {
			x--;
			y--;
			ops.push({ t: 0, a: x, b: y });
		}
		if (x === prevX) {
			// Insertion of b[prevY].
			ops.push({ t: 2, a: prevX, b: prevY });
			y = prevY;
		} else {
			// Deletion of a[prevX].
			ops.push({ t: 1, a: prevX, b: prevY });
			x = prevX;
		}
		x = prevX;
		y = prevY;
	}
	// d = 0: remaining common prefix.
	while (x > 0 && y > 0) {
		x--;
		y--;
		ops.push({ t: 0, a: x, b: y });
	}
	ops.reverse();

	// Group consecutive non-equal ops into hunks.
	const hunks: DiffHunk[] = [];
	let i = 0;
	while (i < ops.length) {
		if (ops[i]!.t === 0) {
			i++;
			continue;
		}
		let origStart = -1;
		let origEnd = -1;
		let newStart = -1;
		let newEnd = -1;
		while (i < ops.length && ops[i]!.t !== 0) {
			const o = ops[i]!;
			if (o.t === 1) {
				if (origStart < 0) {
					origStart = o.a;
				}
				origEnd = o.a + 1;
				if (newStart < 0) {
					newStart = o.b;
					newEnd = o.b;
				}
			} else {
				if (newStart < 0) {
					newStart = o.b;
				}
				newEnd = o.b + 1;
				if (origStart < 0) {
					origStart = o.a;
					origEnd = o.a;
				}
			}
			i++;
		}
		hunks.push({ origStart, origEnd, newStart, newEnd });
	}
	return hunks;
}

const FENCE_ALIASES: Record<string, string> = {
	typescript: 'ts',
	javascript: 'js',
	python: 'py',
	csharp: 'cs',
	shellscript: 'sh',
};

/**
 * Extract the generated code from an engine response. Prefers a fenced block
 * matching the document language, else the first fenced block, else the whole
 * trimmed response (the prompt instructs code-only output).
 */
export function extractCodeBlock(text: string, languageId: string): string | undefined {
	const blocks: Array<{ lang: string; code: string }> = [];
	const re = /```([^\s`]*)\s*\n([\s\S]*?)```/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(text)) !== null) {
		blocks.push({ lang: match[1]!.toLowerCase(), code: match[2]! });
	}
	if (blocks.length === 0) {
		const trimmed = text.trim();
		return trimmed ? trimmed : undefined;
	}
	const lang = languageId.toLowerCase();
	const wanted = new Set([lang, FENCE_ALIASES[lang] ?? ''].filter(Boolean));
	const hit = blocks.find((blk) => wanted.has(blk.lang)) ?? blocks[0]!;
	return hit.code.replace(/\n+$/, '');
}

/** Engine event stream surface (structural subset of IdeCodeEngineAdapter.runTurn). */
export interface IInlineEditEngineEvent {
	readonly type: 'textDelta' | 'done';
	readonly delta?: string;
}

export interface IInlineEditEngine extends Disposable {
	runTurn(opts: { prompt: string; mode: string; bubbleId: string }): AsyncIterable<IInlineEditEngineEvent>;
}

/**
 * Builds the single-shot code-rewrite engine. Implemented by the contribution
 * wiring site: it resolves enginePath, attaches an output channel (via
 * IOutputService), and wires requestApproval/getMode — the pieces that lived
 * in ensureAdapter()'s vscode.* calls.
 */
export interface IInlineEditEngineFactory {
	createInlineEditEngine(): IInlineEditEngine | undefined;
}

/** Structural subset of AiCodeTrackingService used here (CAT-A, sibling agent). */
export interface IInlineEditAiTracking {
	recordAccept(source: 'COMPOSER', lines: number): void;
	recordAcceptedLines(source: 'COMPOSER', fileKey: string, text: string): void;
	recordSuggest(source: 'COMPOSER', lines: number): void;
}

interface InlineTarget {
	document: ITextModel;
	/** Range in the document that will be replaced (zero-width when inserting). */
	range: Range;
	originalText: string;
	/** Document version when the target was captured (stale-edit guard). */
	version: number;
	languageId: string;
	fileLabel: string;
	/** Surrounding code, read-only reference for the model. */
	contextBefore: string;
	contextAfter: string;
	insertMode: boolean;
}

interface InlineSession {
	target: InlineTarget;
	editor: ICodeEditor;
	instruction: string;
	history: string[];
	proposedText: string;
	/** Document version right after the preview was applied. */
	previewVersion: number;
	/**
	 * DD-SB-5: `linesAdded + linesRemoved` of the proposed diff (Cursor's
	 * per-event unit for `composer.diff_summary` / `composer.accept_diff`),
	 * computed from the preview hunks in showPreview.
	 */
	suggestLines: number;
}

export class InlineEditService extends Disposable {
	private session?: InlineSession;
	private engine?: IInlineEditEngine;
	private addedDecoIds: string[] = [];
	private removedDecoIds: string[] = [];
	private statusBarAccessor?: IStatusbarEntryAccessor;
	private readonly inlineEditContextKey: IContextKey<boolean>;
	/** C7 — LRU of recently active file paths for default context gathering. */
	private readonly recentFiles: string[] = [];

	constructor(
		private readonly editorService: IEditorService,
		private readonly notificationService: INotificationService,
		private readonly quickInputService: IQuickInputService,
		private readonly dialogService: IDialogService,
		private readonly commandService: ICommandService,
		private readonly configurationService: IConfigurationService,
		private readonly fileService: IFileService,
		private readonly workspaceContextService: IWorkspaceContextService,
		private readonly modelService: IModelService,
		private readonly untitledTextEditorService: IUntitledTextEditorService,
		private readonly contextKeyService: IContextKeyService,
		private readonly progressService: IProgressService,
		private readonly statusbarService: IStatusbarService,
		private readonly selectionService: InlinePromptSelectionService,
		private readonly engineFactory: IInlineEditEngineFactory,
		private readonly opts: {
			prefillChat: (text: string) => Promise<void>;
			aiCodeTracking?: IInlineEditAiTracking;
		},
	) {
		super();
		this.inlineEditContextKey = this.contextKeyService.createKey(INLINE_EDIT_CONTEXT_KEY, false);
		this._register(this.editorService.onDidActiveEditorChange(() => {
			const control = this.editorService.activeTextEditorControl;
			if (!control || !isCodeEditor(control)) {
				return;
			}
			const model = control.getModel();
			if (!model || model.uri.scheme !== 'file') {
				return;
			}
			const key = model.uri.fsPath;
			const at = this.recentFiles.indexOf(key);
			if (at >= 0) {
				this.recentFiles.splice(at, 1);
			}
			this.recentFiles.unshift(key);
			if (this.recentFiles.length > 8) {
				this.recentFiles.length = 8;
			}
		}));
	}

	get hasPendingEdit(): boolean {
		return this.session !== undefined;
	}

	private activeCodeEditor(): ICodeEditor | undefined {
		const control = this.editorService.activeTextEditorControl;
		return control && isCodeEditor(control) ? control : undefined;
	}

	/** Workspace-relative path when possible, else the absolute fs path. */
	private relativePath(uri: URI): string {
		for (const folder of this.workspaceContextService.getWorkspace().folders) {
			try {
				const rel = extUri.relativePath(folder.uri, uri);
				if (rel) {
					return rel;
				}
			} catch {
				// fall through to fsPath
			}
		}
		return uri.fsPath;
	}

	/**
	 * DD-SB-5: file key for aiCodeTracking attribution — workspace-relative when
	 * possible (matches repo-relative paths at score time for the common
	 * workspace-root repo layout), else the absolute path.
	 */
	private trackingFileKey(uri: URI): string {
		return this.relativePath(uri);
	}

	/** Entry point for `ide.openInlinePrompt`. Re-entrant: acts as follow-up while a preview is pending. */
	async openPrompt(): Promise<void> {
		if (this.session) {
			await this.followUp();
			return;
		}
		const editor = this.activeCodeEditor();
		if (!editor) {
			this.notificationService.error(
				'IDE Agent: open a file first — inline edit needs an active editor.',
			);
			return;
		}
		// KEYBOARD-PARITY (K-08): a selection attached via
		// `ide.addSelectionToInlinePrompt` wins over the live
		// cursor selection. Stale or foreign-document attachments are discarded.
		// (GAPS-171: the Ctrl/Cmd+Shift+K chord was reassigned to
		// `aipopup.action.modal.generate` per the Cursor 3.25.9 binary —
		// the attach command itself is now palette/programmatic-only.)
		const pendingSel = this.selectionService.takePendingSelection();
		const model = editor.getModel();
		const target =
			pendingSel &&
			model &&
			!model.isDisposed() &&
			pendingSel.uri.toString() === model.uri.toString() &&
			pendingSel.version === model.getVersionId()
				? await this.captureTarget(editor, pendingSel)
				: await this.captureTarget(editor);
		if (!target) {
			return;
		}
		const answer = await this.promptForInstruction(target, undefined, false);
		if (!answer) {
			return; // user cancelled
		}
		if (answer.kind === 'question') {
			await this.askQuestion(editor, target, answer.text);
			return;
		}
		if (answer.kind === 'escalate') {
			await this.escalateWithInstruction(answer.text, target);
			return;
		}
		await this.runGeneration(editor, target, answer.text, []);
	}

	/** `ide.acceptInlineEdit` — keep the previewed change. */
	accept(): void {
		if (!this.session) {
			return;
		}
		// DD-SB-5: aiCodeTracking `composer.accept_diff` analog — the accepted
		// diff's lines plus per-file attribution for commit scoring.
		const s = this.session;
		try {
			const t = this.opts.aiCodeTracking;
			if (t) {
				t.recordAccept('COMPOSER', s.suggestLines);
				t.recordAcceptedLines('COMPOSER', this.trackingFileKey(s.target.document.uri), s.proposedText);
			}
		} catch {
			/* stats must never break the accept flow */
		}
		this.clearSession();
	}

	/** Compute the exact range the preview now occupies: original start + proposed-text extent. */
	private previewRange(s: InlineSession): Range {
		const start = s.target.range.getStartPosition();
		const lines = s.proposedText.split('\n');
		const end =
			lines.length === 1
				? new Position(start.lineNumber, start.column + lines[0]!.length)
				: new Position(
					start.lineNumber + lines.length - 1,
					lines[lines.length - 1]!.length + 1,
				);
		return new Range(start.lineNumber, start.column, end.lineNumber, end.column);
	}

	/** `ide.rejectInlineEdit` — restore the original text. */
	async reject(): Promise<void> {
		const s = this.session;
		if (!s) {
			return;
		}
		const document = s.target.document;
		if (document.getVersionId() !== s.previewVersion) {
			const { confirmed } = await this.dialogService.confirm({
				type: Severity.Warning,
				message: 'IDE Agent: the file changed during the preview. Rejecting will overwrite those changes.',
				primaryButton: 'Reject anyway',
				cancelButton: 'Keep',
			});
			if (!confirmed) {
				return;
			}
		}
		try {
			const ok = s.editor.executeEdits('ide-agent-inline-edit', [
				{ range: this.previewRange(s), text: s.target.originalText },
			]);
			if (!ok) {
				throw new Error('edit was not applied');
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.notificationService.error(`IDE Agent: could not revert the inline edit — ${message}`);
		}
		this.clearSession();
	}

	/** `ide.sendToAgent` — escalate the inline task to a full agent turn (C8). */
	async escalateToAgent(): Promise<void> {
		const s = this.session;
		if (s) {
			await this.escalateWithInstruction(s.instruction, s.target);
			return;
		}
		const editor = this.activeCodeEditor();
		if (!editor) {
			this.notificationService.error(
				'IDE Agent: open a file first — there is nothing to send to the agent.',
			);
			return;
		}
		const target = await this.captureTarget(editor);
		if (!target) {
			return;
		}
		const answer = await this.promptForInstruction(target, undefined, false);
		if (!answer) {
			return;
		}
		if (answer.kind === 'question') {
			await this.askQuestion(editor, target, answer.text);
			return;
		}
		// "edit" and "escalate" both land in the agent with the typed text.
		await this.escalateWithInstruction(answer.text, target);
	}

	/**
	 * Build the agent-turn prompt from an inline instruction + target, then
	 * hand it to chat. Cursor opens Agent with the selected code as context
	 * (Cmd/Ctrl+L); ours prefills the real chat composer and focuses it.
	 */
	private async escalateWithInstruction(instruction: string, target: InlineTarget): Promise<void> {
		const startLine = target.range.startLineNumber;
		const endLine = target.insertMode
			? startLine
			: target.range.endLineNumber;
		// Curation restored (user directive 2026-10-19 refined): the escalated
		// chat prompt carries a focused slice of the code, not the whole file.
		const code =
			target.originalText.length > 4000
				? target.originalText.slice(0, 4000) + '\n…(truncated)'
				: target.originalText;
		const fence = FENCE_ALIASES[target.languageId.toLowerCase()] ?? target.languageId;
		const text = [
			instruction,
			'',
			`Context — ${target.fileLabel} (${target.languageId}), line${startLine === endLine ? '' : 's'} ${startLine}${startLine === endLine ? '' : `–${endLine}`}:`,
			`\`\`\`${fence}`,
			code,
			'```',
		].join('\n');
		await this.opts.prefillChat(text);
	}

	// ------------------------------------------------------------------ //

	/** GAPS-172: folding region at `lineNumber`, structural (see electron-browser twin). */
	private async resolveFoldingRegion(editor: ICodeEditor, lineNumber: number): Promise<{ startLineNumber: number; endLineNumber: number } | null | undefined> {
		try {
			const controller = editor.getContribution('editor.contrib.folding') as unknown as { getFoldingModel(): Promise<{ getRegionAtLine(line: number): { startLineNumber: number; endLineNumber: number } | null } | null> | null } | null;
			if (!controller) {
				return undefined;
			}
			const foldingModel = await controller.getFoldingModel();
			if (!foldingModel) {
				return undefined;
			}
			const region = foldingModel.getRegionAtLine(lineNumber);
			return region ? { startLineNumber: region.startLineNumber, endLineNumber: region.endLineNumber } : null;
		} catch {
			return undefined;
		}
	}

	private async captureTarget(editor: ICodeEditor, pendingSel?: IPendingSelection): Promise<InlineTarget | undefined> {
		const document = editor.getModel();
		if (!document || document.isDisposed()) {
			return undefined;
		}
		const selection = editor.getSelection();
		// GAPS-172 (#28): StartEditPrompt selection normalization — column-1
		// trim for non-empty multi-line selections (pending/override range
		// included, as in the binary) + `heuristicSelect` expansion of an
		// empty selection on a non-empty line (see ../common/autoSelect.ts).
		let insertMode = !pendingSel && (!selection || selection.isEmpty());
		let range: Range;
		if (pendingSel) {
			const trimmed = trimSelectionEndingAtColumn1(document, pendingSel.range);
			range = document.validateRange(new Range(trimmed.startLineNumber, trimmed.startColumn, trimmed.endLineNumber, trimmed.endColumn));
		} else if (insertMode && selection && document.getLineContent(selection.startLineNumber).trim() !== '') {
			const suggestions = await heuristicSelect(document, { lineNumber: selection.startLineNumber, column: selection.startColumn }, { foldingRegion: await this.resolveFoldingRegion(editor, selection.startLineNumber) });
			if (suggestions.length > 0) {
				const top = suggestions[0]!.initialSelectionRange;
				range = document.validateRange(new Range(top.startLineNumber, top.startColumn, top.endLineNumber, top.endColumn));
				insertMode = false;
			} else {
				const pos = selection.getPosition();
				range = new Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column);
			}
		} else if (insertMode) {
			const pos = selection!.getPosition();
			range = new Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column);
		} else {
			const trimmed = trimSelectionEndingAtColumn1(document, selection!);
			range = document.validateRange(new Range(
				trimmed.startLineNumber, trimmed.startColumn,
				trimmed.endLineNumber, trimmed.endColumn,
			));
		}
		const originalText = document.getValueInRange(range);
		// NOTE (user directive 2026-10-19): no artificial size cap on the
		// selection. This is our own system — the user edits whatever they
		// select; the engine/model context window is the only real bound.
		const startLine = range.startLineNumber;
		const endLine = insertMode ? startLine : range.endLineNumber;
		const lineCount = document.getLineCount();
		const beforeStart = Math.max(1, startLine - CONTEXT_LINES);
		const afterEnd = Math.min(lineCount, endLine + CONTEXT_LINES);
		// Curation cap restored (user directive 2026-10-19 refined): surrounding
		// context is auto-attached — keep it focused so the model stays sharp.
		const cap = (text: string): string =>
			text.length > CONTEXT_CHARS ? text.slice(0, CONTEXT_CHARS) + '\n…(truncated)' : text;
		const contextBefore =
			beforeStart < startLine
				? cap(document.getValueInRange(new Range(beforeStart, 1, startLine, 1)))
				: '';
		const contextAfter =
			afterEnd > endLine
				? cap(
					document.getValueInRange(
						new Range(endLine + 1, 1, afterEnd, document.getLineMaxColumn(afterEnd)),
					),
				)
				: '';
		const fileLabel = this.relativePath(document.uri);
		return {
			document,
			range,
			originalText,
			version: document.getVersionId(),
			languageId: document.getLanguageId(),
			fileLabel,
			contextBefore,
			contextAfter,
			insertMode,
		};
	}

	private promptForInstruction(
		target: InlineTarget,
		previous: string | undefined,
		followUp: boolean,
	): Promise<{ kind: 'edit' | 'question' | 'escalate'; text: string } | undefined> {
		return new Promise((resolve) => {
			const input = this.quickInputService.createInputBox();
			const startLine = target.range.startLineNumber;
			const loc = target.insertMode
				? `line ${startLine}`
				: `lines ${startLine}–${target.range.endLineNumber}`;
			// Cursor's Alt+Enter question mode is not capturable in a quick-input
			// box, so it is exposed as an explicit button — same behavior.
			const askButton: IQuickInputButton = {
				iconClass: ThemeIcon.asClassName({ id: 'comment-discussion' }),
				tooltip: 'Ask about this code instead (no edit)',
			};
			// Cursor's Cmd+L in the prompt bar escalates to Agent. Keys can't be
			// intercepted inside a quick-input, so this is an explicit button.
			const escalateButton: IQuickInputButton = {
				iconClass: ThemeIcon.asClassName({ id: 'rocket' }),
				tooltip: 'Send to Agent (multi-file / complex change)',
			};
			input.title = followUp ? 'IDE Agent inline edit — follow-up' : 'IDE Agent inline edit';
			input.prompt =
				(followUp ? 'Refine the proposed edit' : 'Describe the change') +
				` — ${target.fileLabel}:${loc} (${target.languageId})`;
			input.placeholder = 'e.g. convert to async/await and add error handling';
			if (previous) {
				input.value = previous;
			}
			input.buttons = [askButton, escalateButton];
			let settled = false;
			const finish = (value: { kind: 'edit' | 'question' | 'escalate'; text: string } | undefined): void => {
				if (settled) {
					return;
				}
				settled = true;
				input.dispose();
				resolve(value);
			};
			input.onDidTriggerButton((button) => {
				if (button === askButton) {
					const q = input.value.trim();
					if (!q) {
						input.validationMessage = 'Type a question first, or press Esc to cancel.';
						return;
					}
					finish({ kind: 'question', text: q });
				} else if (button === escalateButton) {
					const t = input.value.trim();
					if (!t) {
						input.validationMessage = 'Type the task first, or press Esc to cancel.';
						return;
					}
					finish({ kind: 'escalate', text: t });
				}
			});
			input.onDidAccept(() => {
				const value = input.value.trim();
				if (!value) {
					input.validationMessage = 'Describe the change first, or press Esc to cancel.';
					return;
				}
				finish({ kind: 'edit', text: value });
			});
			input.onDidHide(() => finish(undefined));
			input.show();
		});
	}

	private ensureAdapter(): IInlineEditEngine | undefined {
		if (this.engine) {
			return this.engine;
		}
		const cfg = this.configurationService.getValue<{ engineMode?: string }>('ide.agent') ?? {};
		if ((cfg.engineMode ?? 'sidecar') !== 'sidecar') {
			// Honest precondition, not a scaffold: the whole extension (chat
			// included) needs the sidecar engine + a configured model to generate.
			this.notificationService.prompt(
				Severity.Warning,
				'IDE Agent: inline edit needs the ide-code engine. Set "ide.agent.engineMode" to "sidecar" and configure a model, then try again.',
				[{
					label: 'Open Settings',
					run: () => {
						void this.commandService.executeCommand(
							'workbench.action.openSettings',
							'ide.agent.engineMode',
						);
					},
				}],
			);
			return undefined;
		}
		const engine = this.engineFactory.createInlineEditEngine();
		if (engine) {
			this.engine = engine;
			this._register(engine);
		}
		return this.engine;
	}

	private async buildEditPrompt(target: InlineTarget, instruction: string, history: string[]): Promise<string> {
		const lines: string[] = [
			'You are an expert code editor performing a Cursor-style inline edit.',
			'',
			'Rules:',
			'- Output ONLY the rewritten code inside a single fenced code block.',
			'- Rewrite ONLY the <target> section below. <context> and <related-files> are read-only reference — never include them in your output.',
		];
		if (target.insertMode) {
			lines.push('- The <target> section is EMPTY: write the new code to insert at the cursor.');
		} else {
			lines.push(
				'- Replace the ENTIRE <target> section with the improved version: output the full new text, not a diff.',
			);
		}
		lines.push(
			'- Preserve code style, indentation, and everything unrelated to the instruction.',
			'- No explanations, no apologies, no text outside the code block. Do not use tools.',
			'',
		);
		if (history.length > 0) {
			lines.push(
				'Earlier attempts in this session (the newest instruction takes precedence):',
				...history.map((h, i) => `${i + 1}. ${h}`),
				'',
			);
		}
		lines.push(
			`Instruction: ${instruction}`,
			'',
			`File: ${target.fileLabel} (${target.languageId})`,
			'',
		);
		if (target.contextBefore) {
			lines.push('<context> (read-only, above the target):', target.contextBefore, '</context>', '');
		}
		lines.push('<target>', target.originalText, '</target>', '');
		if (target.contextAfter) {
			lines.push('<context> (read-only, below the target):', target.contextAfter, '</context>', '');
		}
		const related = await this.relatedFilesContext(target.document.uri);
		if (related) {
			lines.push('<related-files> (read-only reference — recent and neighboring files):', related, '</related-files>', '');
		}
		return lines.join('\n');
	}

	/**
	 * C7 — default context gathering. Cursor feeds related and recent files
	 * into inline edit automatically; this approximates it with:
	 *   (a) the 3 most recently active files (excluding the current one), and
	 *   (b) up to 2 same-directory files with the same extension.
	 * Bounded (≤5 files, heads only) and labeled; unreadable files are skipped.
	 */
	private async relatedFilesContext(current: URI): Promise<string> {
		const MAX_FILES = 5;
		const MAX_LINES = 40;
		const MAX_CHARS = 2_000;
		const seen = new Set<string>([current.fsPath]);
		const sections: string[] = [];

		const addFile = async (uri: URI, tag: string): Promise<void> => {
			if (sections.length >= MAX_FILES || seen.has(uri.fsPath)) {
				return;
			}
			seen.add(uri.fsPath);
			const head = await this.readFileHead(uri, MAX_LINES, MAX_CHARS);
			if (!head || !head.trim()) {
				return;
			}
			const label = this.relativePath(uri);
			sections.push(`--- ${label} (${tag}) ---\n${head}`);
		};

		// (a) recent files, most recent first.
		for (const fsPath of this.recentFiles) {
			if (sections.length >= 3) {
				break;
			}
			await addFile(URI.file(fsPath), 'recent');
		}
		// (b) neighboring files with the same extension.
		if (sections.length < MAX_FILES) {
			const ext = extUri.extname(current);
			if (ext) {
				try {
					const dirUri = extUri.dirname(current);
					const dirStat = await this.fileService.resolve(dirUri);
					const base = extUri.basename(current);
					for (const child of dirStat.children ?? []) {
						if (sections.length >= MAX_FILES) {
							break;
						}
						const name = extUri.basename(child.resource);
						if (!child.isFile || name === base || !name.endsWith(ext)) {
							continue;
						}
						await addFile(child.resource, 'neighbor');
					}
				} catch {
					// No directory access — neighbors are best-effort.
				}
			}
		}
		return sections.join('\n\n');
	}

	/** Read the head of a file: prefer the open document (has unsaved edits), else disk. */
	private async readFileHead(uri: URI, maxLines: number, maxChars: number): Promise<string | undefined> {
		try {
			const open = this.modelService.getModels().find(
				(d) => d.uri.toString() === uri.toString(),
			);
			if (open) {
				const end = Math.min(maxLines, open.getLineCount());
				const text = open.getValueInRange(new Range(1, 1, end, 1));
				return text.length > maxChars ? text.slice(0, maxChars) : text;
			}
			const content = await this.fileService.readFile(uri);
			const text = content.value.toString().slice(0, maxChars);
			return text.split('\n').slice(0, maxLines).join('\n');
		} catch {
			return undefined; // binary, deleted, or unreadable — skip silently
		}
	}

	/** Run one generation turn against the engine and return the raw text. */
	private async runEngineTurn(prompt: string, title: string): Promise<string | undefined> {
		const adapter = this.ensureAdapter();
		if (!adapter) {
			return undefined;
		}
		// Core withProgress tasks receive no cancellation token — wire our own.
		const cts = new CancellationTokenSource();
		try {
			const raw = await this.progressService.withProgress<string | undefined>(
				{ location: ProgressLocation.Notification, title, cancellable: true },
				async () => {
					let text = '';
					for await (const ev of adapter.runTurn({
						prompt,
						mode: 'edit',
						bubbleId: `inline-${Date.now().toString(36)}`,
					})) {
						if (cts.token.isCancellationRequested) {
							break;
						}
						if (ev.type === 'textDelta' && ev.delta) {
							text += ev.delta;
						} else if (ev.type === 'done') {
							break;
						}
					}
					return cts.token.isCancellationRequested ? undefined : text;
				},
				() => cts.cancel(),
			);
			return raw;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.notificationService.error(`IDE Agent: inline edit failed — ${message}`);
			return undefined;
		} finally {
			cts.dispose();
		}
	}

	private async runGeneration(
		editor: ICodeEditor,
		target: InlineTarget,
		instruction: string,
		history: string[],
	): Promise<void> {
		const raw = await this.runEngineTurn(
			await this.buildEditPrompt(target, instruction, history),
			'IDE Agent: generating inline edit…',
		);
		if (raw === undefined) {
			return; // cancelled, engine missing, or error (already reported)
		}
		const code = extractCodeBlock(raw, target.languageId);
		if (!code) {
			this.notificationService.error(
				'IDE Agent: the engine returned no usable code. Try rephrasing the instruction.',
			);
			return;
		}
		await this.showPreview(editor, target, instruction, history, code);
	}

	private async showPreview(
		editor: ICodeEditor,
		target: InlineTarget,
		instruction: string,
		history: string[],
		proposedText: string,
	): Promise<void> {
		const document = target.document;
		if (document.getVersionId() !== target.version) {
			this.notificationService.warn(
				'IDE Agent: the file changed while generating — inline edit cancelled to avoid conflicts.',
			);
			return;
		}
		const hunks = lineDiff(target.originalText.split('\n'), proposedText.split('\n'));
		if (hunks.length === 0) {
			this.notificationService.info(
				'IDE Agent: the engine returned the code unchanged — nothing to preview.',
			);
			return;
		}
		let applied = false;
		try {
			applied = editor.executeEdits('ide-agent-inline-edit', [
				{ range: target.range, text: proposedText },
			]);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.notificationService.error(`IDE Agent: could not apply the preview — ${message}`);
			return;
		}
		if (!applied) {
			this.notificationService.error('IDE Agent: could not apply the preview edit.');
			return;
		}

		// SETTINGS-PARITY: `ide.cmdk.useThemedDiffBackground` (mirrors
		// cursor.cmdk.useThemedDiffBackground2). Off = plain (non-themed) class.
		const useThemedDiff = (this.configurationService.getValue<{ useThemedDiffBackground?: boolean }>('ide.cmdk') ?? {})
			.useThemedDiffBackground ?? true;
		const baseLine = target.range.startLineNumber;
		const oldLines = target.originalText.split('\n');
		// 1-based line math (core Range/Position are 1-based; the original
		// vscode.Range math was 0-based).
		const addedRanges: Range[] = [];
		const removedAnchors: Array<{ range: Range; text: string }> = [];
		for (const hunk of hunks) {
			if (hunk.newEnd > hunk.newStart) {
				addedRanges.push(new Range(baseLine + hunk.newStart, 1, baseLine + hunk.newEnd - 1, 1));
			}
			if (hunk.origEnd > hunk.origStart) {
				// Injected text must be single-line — one decoration per removed line,
				// anchored at the corresponding position in the new text.
				const anchorLine = Math.min(baseLine + hunk.newStart, document.getLineCount());
				for (let l = hunk.origStart; l < hunk.origEnd; l++) {
					removedAnchors.push({
						range: new Range(anchorLine, 1, anchorLine, 1),
						text: `- ${oldLines[l] ?? ''}`,
					});
				}
			}
		}
		const addedClassName = useThemedDiff ? 'ide-inline-edit-added' : 'ide-inline-edit-added-plain';
		this.addedDecoIds = editor.deltaDecorations(
			[],
			addedRanges.map((range) => ({
				range,
				options: {
					description: 'ide-inline-edit-added',
					className: addedClassName,
					isWholeLine: true,
				} satisfies IModelDecorationOptions,
			})),
		);
		this.removedDecoIds = editor.deltaDecorations(
			[],
			removedAnchors.map((a) => ({
				range: a.range,
				options: {
					description: 'ide-inline-edit-removed',
					before: { content: a.text, inlineClassName: 'ide-inline-edit-removed' },
				} satisfies IModelDecorationOptions,
			})),
		);

		this.statusBarAccessor = this.statusbarService.addEntry(
			{
				name: 'Inline Edit',
				text: '$(diff) Inline edit — Ctrl+Enter: accept · Esc: reject',
				ariaLabel: 'IDE Agent inline edit preview',
				tooltip: 'IDE Agent inline edit preview',
			},
			INLINE_EDIT_STATUS_ID,
			StatusbarAlignment.RIGHT,
			101,
		);

		// DD-SB-5: aiCodeTracking `composer.diff_summary` analog — the proposed
		// diff's linesAdded + linesRemoved (Cursor diffs previous vs updated
		// content per event; the preview hunks are exactly that diff).
		let suggestLines = 0;
		for (const hunk of hunks) {
			suggestLines += hunk.newEnd - hunk.newStart + (hunk.origEnd - hunk.origStart);
		}
		try {
			this.opts.aiCodeTracking?.recordSuggest('COMPOSER', suggestLines);
		} catch {
			/* stats must never break the preview */
		}

		this.session = {
			target,
			editor,
			instruction,
			history,
			proposedText,
			previewVersion: document.getVersionId(),
			suggestLines,
		};
		this.inlineEditContextKey.set(true);
	}

	private async followUp(): Promise<void> {
		const s = this.session;
		if (!s) {
			return;
		}
		const answer = await this.promptForInstruction(s.target, s.instruction, true);
		if (!answer) {
			return; // cancelled — keep the current preview
		}
		if (answer.kind === 'question') {
			await this.askQuestion(s.editor, s.target, answer.text);
			return;
		}
		if (answer.kind === 'escalate') {
			// Cursor's Cmd+L opens Agent with the selected code as context: drop
			// the preview silently and hand the refined instruction to chat.
			const { target } = s;
			if (!(await this.revertSessionText(s))) {
				return;
			}
			this.clearSession();
			await this.escalateWithInstruction(answer.text, target);
			return;
		}
		// Revert the current preview silently, then regenerate from the original
		// with the previous attempt recorded in history.
		// Follow-up history curation restored (user directive 2026-10-19 refined):
		// the model gets the gist of the previous attempt, not megabytes of it.
		const cappedPrev =
			s.proposedText.length > MAX_FOLLOWUP_HISTORY_CHARS
				? s.proposedText.slice(0, MAX_FOLLOWUP_HISTORY_CHARS) + '\n…(truncated)'
				: s.proposedText;
		const historyEntry =
			`Previous instruction: "${s.instruction}". ` +
			`Previous result (refine it, do not repeat its mistakes):\n${cappedPrev}`;
		const newHistory = [...s.history, historyEntry];
		const { editor, target } = s;
		if (!(await this.revertSessionText(s))) {
			return; // must land before regenerating
		}
		this.clearSession();
		// The revert changed the document; refresh the captured version.
		target.version = target.document.getVersionId();
		await this.runGeneration(editor, target, answer.text, newHistory);
	}

	/** Restore the original text without user prompts (follow-up path). */
	private async revertSessionText(s: InlineSession): Promise<boolean> {
		const ok = s.editor.executeEdits('ide-agent-inline-edit', [
			{ range: this.previewRange(s), text: s.target.originalText },
		]);
		if (!ok) {
			this.notificationService.error(
				'IDE Agent: could not revert the inline edit preview — follow-up cancelled.',
			);
		}
		return ok;
	}

	/** Question mode (C5): answer about the code without editing. */
	private async askQuestion(
		editor: ICodeEditor,
		target: InlineTarget,
		question: string,
	): Promise<void> {
		// Curation restored (user directive 2026-10-19 refined).
		const code =
			target.originalText.length > 8000
				? target.originalText.slice(0, 8000) + '\n…(truncated)'
				: target.originalText;
		const fence = FENCE_ALIASES[target.languageId.toLowerCase()] ?? target.languageId;
		const prompt = [
			'You are an expert programming assistant. Answer the question about the code below.',
			'',
			'Rules:',
			'- Be concise. Use markdown.',
			'- Do not edit anything. Do not use tools.',
			'- If you suggest a code change, include it in a single fenced code block.',
			'',
			`Question: ${question}`,
			'',
			`File: ${target.fileLabel} (${target.languageId})`,
			`\`\`\`${fence}`,
			code,
			'```',
		].join('\n');
		const raw = await this.runEngineTurn(prompt, 'IDE Agent: answering question…');
		if (raw === undefined) {
			return;
		}
		const answer = raw.trim() || '(the engine returned an empty answer)';
		const untitled = this.untitledTextEditorService.create({
			languageId: 'markdown',
			initialValue: `# IDE Agent — question\n\n**Q:** ${question}\n\n**File:** ${target.fileLabel}\n\n---\n\n${answer}\n`,
		});
		await this.editorService.openEditor({ resource: untitled.resource }, SIDE_GROUP);
		// C6 "do it": offer to apply the suggested change as an inline edit.
		const suggested = extractCodeBlock(raw, target.languageId);
		if (suggested && suggested.trim() && suggested.trim() !== target.originalText.trim()) {
			const { confirmed } = await this.dialogService.confirm({
				message: 'IDE Agent: the answer suggests a code change. Apply it as an inline edit?',
				primaryButton: 'Apply as inline edit',
				cancelButton: 'Dismiss',
			});
			if (confirmed) {
				await this.showPreview(editor, target, `Apply suggested fix for: ${question}`, [], suggested);
			}
		}
	}

	private clearSession(): void {
		const s = this.session;
		this.session = undefined;
		if (s) {
			s.editor.deltaDecorations(this.addedDecoIds, []);
			s.editor.deltaDecorations(this.removedDecoIds, []);
		}
		this.addedDecoIds = [];
		this.removedDecoIds = [];
		if (this.statusBarAccessor) {
			this.statusBarAccessor.dispose();
			this.statusBarAccessor = undefined;
		}
		this.inlineEditContextKey.set(false);
	}

	override dispose(): void {
		this.clearSession();
		super.dispose();
	}
}
