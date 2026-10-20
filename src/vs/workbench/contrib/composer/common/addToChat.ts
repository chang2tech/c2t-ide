/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Migrated from extensions/ide-agent/services/addToChat.ts — vscode API → DI
//
// vscode API → core mapping used here (per docs/rea/ext-api-audit-2026-10-19.md §3):
//   window.activeTextEditor              → IEditorService.activeTextEditorControl (+ isCodeEditor)
//   window.activeTerminal                → ITerminalService.activeInstance
//   commands.executeCommand              → ICommandService.executeCommand
//     ("workbench.action.terminal.copySelection" is a stock workbench command — id unchanged)
//   env.clipboard                        → IClipboardService
//   window.showInformationMessage        → INotificationService.info
//   workspace.asRelativePath            → IWorkspaceContextService + extUri.relativePath
//
// The module keeps the original's seam design (`ComposerAddToChatSeam`, formerly
// `VscodeSeam`): all workbench access goes through the injected seam, so the
// pure flows (probe/add/post) stay unit-testable. `AddToChatService` is the
// DI-backed production seam (replaces `realVscodeSeam`).
//
// NOTE on layering: ITerminalService/ICodeEditor live in workbench/editor
// browser layers; this common/ service references their *interfaces* only.

import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { extUri } from '../../../../base/common/resources.js';
import { ICodeEditor, isCodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { Selection } from '../../../../editor/common/core/selection.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { ITerminalInstance, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';

export const IAddToChatService = createDecorator<IAddToChatService>('composerAddToChatService');

/**
 * Cursor parity: "Add to Chat" (Ctrl+L).
 *
 * Editor path: the active editor's selection becomes a context chip in the
 * chat input. Terminal path: there is no API to read the terminal selection
 * directly, so we run `workbench.action.terminal.copySelection` and read the
 * clipboard back — the text is attached as a `terminal selection` chip.
 *
 * The workbench-core terminal selection toolbar (a floating "Add to Chat"
 * button, Cursor's "Toolbar on Selection") invokes this command with
 * `{ source: 'terminal', text }` — the selection text is already resolved
 * in core, so no clipboard round-trip is needed on that path.
 *
 * Focus detection (P1-2/P2-6, QA-CHATEDITOR): there is NO public API for
 * "does the terminal have focus". So any `terminalHasFocus()` heuristic is
 * wrong in at least one direction. Instead:
 *  - keybindings pass an explicit `{ source: 'terminal' | 'editor' }` arg,
 *    which is deterministic;
 *  - the ambiguous palette path probes the terminal BEHAVIORALLY: if
 *    `copySelection` changes the clipboard, the terminal had a selection.
 */

export interface AddToChatHost {
	postToWebview(message: unknown): void;
	focusChatView(): Promise<void>;
}

/** Core-typed seam (was `VscodeSeam`). All workbench access goes through here. */
export interface ComposerAddToChatSeam {
	activeTextEditor: ICodeEditor | undefined;
	activeTerminal: ITerminalInstance | undefined;
	executeCommand(command: string, ...args: unknown[]): Promise<unknown>;
	readClipboardText(): Promise<string>;
	/** P3-13: restore the clipboard after the copySelection round-trip. */
	writeClipboardText(text: string): Promise<void>;
	showInformationMessage(message: string): void;
	asRelativePath(uri: URI): string;
}

export function buildEditorSelectionLabel(
	seam: ComposerAddToChatSeam,
	model: ITextModel,
	sel: Selection,
): { label: string; content: string } {
	const label = `selection:${seam.asRelativePath(model.uri)}:${sel.startLineNumber}`;
	const content = model.getValueInRange(sel);
	return { label, content };
}

/**
 * Optional arguments accepted by the `composer.addToChat` command
 * (was `ide.addToChat` — `ide.*` → `composer.*` rename for the new layer).
 * - Keybindings pass `{ source: 'terminal' }` / `{ source: 'editor' }`
 *   explicitly (deterministic, no focus guessing).
 * - The workbench-core terminal selection toolbar passes
 *   `{ source: 'terminal', text }` with the selection text already resolved.
 */
export interface AddToChatArgs {
	source?: string;
	text?: string;
	/**
	 * IDE-CODE (Cursor parity, DETAIL-TERMINAL): Ctrl/Cmd+click on the
	 * terminal floating "Add to Chat" button opens the selection in a NEW
	 * composer instead of the current one.
	 */
	newChat?: boolean;
}

/**
 * P3-12 (QA-CHATEDITOR): menu invocations can forward arbitrary model
 * objects (e.g. a Uri) as the first arg. Accept ONLY a plain object whose
 * keys are a subset of {source, text, newChat}; anything else is treated
 * as "no args" so the command falls back to the behavioral probe instead
 * of misreading a Uri as AddToChatArgs.
 */
export function sanitizeAddToChatArgs(raw: unknown): AddToChatArgs | undefined {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return undefined;
	}
	const record = raw as Record<string, unknown>;
	const keys = Object.keys(record);
	if (keys.length === 0 || !keys.every((k) => k === 'source' || k === 'text' || k === 'newChat')) {
		return undefined;
	}
	const out: AddToChatArgs = {};
	if (typeof record.source === 'string') {
		out.source = record.source;
	}
	if (typeof record.text === 'string') {
		out.text = record.text;
	}
	if (record.newChat === true) {
		out.newChat = true;
	}
	return out;
}

/**
 * Behavioral terminal-selection probe.
 *
 * Runs `copySelection` and compares the clipboard before/after:
 * - changed + non-empty + stable → the terminal had a selection; returns
 *   its text.
 * - unchanged/empty → no terminal selection; returns undefined and never
 *   attaches the (possibly secret) stale clipboard content (P1-1).
 *
 * The user's original clipboard content is restored afterwards (P3-13),
 * best-effort — a failed restore must not break the flow.
 *
 * REVERIFY-P2-2 (H1, clipboard race): the clipboard is shared mutable
 * state. If the user copies something ELSE in the millisecond window of
 * this probe, `after` would be their text (possibly a secret), not the
 * terminal selection. To narrow this, we read a THIRD time after a short
 * settle delay: if the clipboard is still changing (`after2 !== after`),
 * someone else is actively writing → abort (return undefined) WITHOUT
 * attaching and WITHOUT restoring (restoring would clobber their fresh
 * copy = data loss). Only a stable change is treated as our copySelection
 * result and restored.
 *
 * Known trade-off (documented, accepted): if the terminal selection happens
 * to be byte-identical to the previous clipboard content, the probe reports
 * "no selection". Privacy (never leaking stale clipboard as a chat chip)
 * wins over this rare false negative.
 *
 * RESIDUAL TOCTOU (documented, accepted risk — QA-REVERIFY-2-01): the clipboard
 * is shared mutable state and the API offers NO direct terminal-selection
 * reading except the copySelection→clipboard round-trip, so the probe is
 * inherently time-of-check/time-of-use. A SINGLE user copy that completes
 * ENTIRELY in the before→first-after window is stable through the settle
 * check and will still be misattributed as the terminal selection and
 * attached. The window is only a few milliseconds (one read + one command +
 * one read), so it requires the user to hit copy at exactly that instant —
 * accepted as residual, not fixable via this probe design. What we CAN bound
 * is the damage: see the re-read right before restore (REVERIFY2-P3-2) which
 * guarantees we never clobber a fresher copy even when misattribution
 * occurred.
 */
export async function probeTerminalSelection(seam: ComposerAddToChatSeam): Promise<string | undefined> {
	const before = await seam.readClipboardText();
	await seam.executeCommand('workbench.action.terminal.copySelection');
	const after = await seam.readClipboardText();
	if (!after || after === before) {
		return undefined;
	}
	// Stability check: give a concurrent writer a chance to reveal itself.
	await new Promise((resolve) => setTimeout(resolve, 50));
	const after2 = await seam.readClipboardText();
	if (after2 !== after) {
		// Someone else is writing to the clipboard right now — `after` is
		// their text, not the terminal selection. Abort: do NOT attach it
		// (privacy) and do NOT restore `before` over their fresh copy
		// (data loss). Leave their clipboard alone.
		return undefined;
	}
	// Stable change: our copySelection produced it. Restore the user's
	// original clipboard content (P3-13), best-effort.
	//
	// REVERIFY2-P3-2 (restore-clobber): the 50ms settle above only catches a
	// writer active DURING the window. Re-read right before restoring: if the
	// clipboard no longer equals `after`, someone copied something new AFTER
	// our last read → SKIP the restore (writing `before` now would clobber
	// their fresh copy = data loss). Only restore when the clipboard is still
	// the value we read.
	const beforeRestore = await seam.readClipboardText();
	if (beforeRestore === after) {
		try {
			await seam.writeClipboardText(before);
		} catch {
			/* best-effort restore */
		}
	}
	return after;
}

export async function addToChat(
	host: AddToChatHost,
	seam: ComposerAddToChatSeam,
	args?: AddToChatArgs,
): Promise<void> {
	// Core toolbar path: the selection text arrives pre-resolved — attach it
	// directly as a terminal selection chip (backward compatible: no args
	// keeps the previous editor/clipboard behavior).
	if (args?.source === 'terminal' && typeof args.text === 'string' && args.text.length > 0) {
		await postSelectionContextToChat(host, 'terminal selection', args.text);
		return;
	}
	// Explicit source from the keybinding args — deterministic, no focus
	// guessing (P1-2/P2-6).
	if (args?.source === 'terminal') {
		await addTerminalSelectionToChat(host, seam);
		return;
	}
	if (args?.source === 'editor') {
		await addEditorSelectionToChat(host, seam);
		return;
	}
	// Ambiguous invocation (command palette): probe the terminal
	// behaviorally. If it has a selection, use it; otherwise fall back to
	// the editor path.
	const probed = await probeTerminalSelection(seam);
	if (probed !== undefined) {
		await postSelectionContextToChat(host, 'terminal selection', probed);
		return;
	}
	await addEditorSelectionToChat(host, seam);
}

export async function addEditorSelectionToChat(
	host: AddToChatHost,
	seam: ComposerAddToChatSeam,
): Promise<void> {
	const editor = seam.activeTextEditor;
	const model = editor?.getModel() ?? null;
	const selection = editor?.getSelection() ?? null;
	if (!editor || !model || !selection || selection.isEmpty()) {
		seam.showInformationMessage('IDE Agent: select code in the editor first.');
		return;
	}
	const { label, content } = buildEditorSelectionLabel(seam, model, selection);
	await postSelectionContextToChat(host, label, content);
}

export async function addTerminalSelectionToChat(
	host: AddToChatHost,
	seam: ComposerAddToChatSeam,
): Promise<void> {
	const text = await probeTerminalSelection(seam);
	if (text === undefined) {
		seam.showInformationMessage('IDE Agent: select text in the terminal first.');
		return;
	}
	await postSelectionContextToChat(host, 'terminal selection', text);
}

export async function postSelectionContextToChat(
	host: AddToChatHost,
	label: string,
	content: string,
): Promise<void> {
	await host.focusChatView();
	host.postToWebview({ type: 'addSelectionContext', label, content });
}

export interface IAddToChatService {
	readonly _serviceBrand: undefined;

	addToChat(host: AddToChatHost, args?: AddToChatArgs): Promise<void>;
	addEditorSelectionToChat(host: AddToChatHost): Promise<void>;
	addTerminalSelectionToChat(host: AddToChatHost): Promise<void>;
}

/**
 * DI-backed production seam (replaces the extension's `realVscodeSeam`).
 * Resolved per use — `activeTextEditor`/`activeTerminal` are getters so they
 * always reflect the current workbench state.
 */
export class AddToChatService extends Disposable implements IAddToChatService {

	declare readonly _serviceBrand: undefined;

	constructor(
		@IEditorService private readonly editorService: IEditorService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@ICommandService private readonly commandService: ICommandService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@INotificationService private readonly notificationService: INotificationService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) {
		super();
	}

	/** The live DI seam. */
	private get seam(): ComposerAddToChatSeam {
		const editorService = this.editorService;
		const terminalService = this.terminalService;
		const commandService = this.commandService;
		const clipboardService = this.clipboardService;
		const notificationService = this.notificationService;
		const workspaceContextService = this.workspaceContextService;
		return {
			get activeTextEditor() {
				const control = editorService.activeTextEditorControl;
				return control && isCodeEditor(control) ? control : undefined;
			},
			get activeTerminal() {
				return terminalService.activeInstance;
			},
			executeCommand: (command, ...args) => commandService.executeCommand(command, ...args),
			readClipboardText: () => clipboardService.readText(),
			writeClipboardText: (text) => clipboardService.writeText(text),
			showInformationMessage: (m) => { notificationService.info(m); },
			asRelativePath: (uri) => {
				const folder = workspaceContextService.getWorkspaceFolder(uri);
				if (folder) {
					return extUri.relativePath(folder.uri, uri) ?? uri.fsPath;
				}
				return uri.fsPath;
			},
		};
	}

	addToChat(host: AddToChatHost, args?: AddToChatArgs): Promise<void> {
		return addToChat(host, this.seam, args);
	}

	addEditorSelectionToChat(host: AddToChatHost): Promise<void> {
		return addEditorSelectionToChat(host, this.seam);
	}

	addTerminalSelectionToChat(host: AddToChatHost): Promise<void> {
		return addTerminalSelectionToChat(host, this.seam);
	}
}
