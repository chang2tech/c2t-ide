/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// GAPS-158 (`editor-find-in-file`, 2026-10-20): workbench service port of
// Cursor's `glassFileEditorFindStateService` (class Blu, Cursor 3.25.9
// glass @45459332; full dissection in docs/rea/work-notes-gaps158.md).
// Registered as a Delayed singleton in composer.contribution.ts — the
// binary registration is `Cn(FZb, Blu, 1)` (InstantiationType 1 = Delayed).
//
// What it does (Blu semantics, verbatim): track() subscribes to a file
// editor's stock FindReplaceState changes; whenever one of the six tracked
// fields changes, the editor's current {searchString, replaceString,
// isRegex, wholeWord, matchCase, preserveCase} is snapshotted into a map
// keyed by the CURRENT active agent id. getSharedState() returns the
// active agent's snapshot ({} when none) so the `showFileEditorFind`
// handler can seed a newly opened find widget with it. In-memory only —
// Blu has no storage; nothing persists across restarts.
//
// HONEST-DIVERGENCE (agent key source): Blu injects
// `glassActiveAgentService` and reads `getActiveAgentId()` live. The fork
// core has NO such service (chat/agent tabs live in the ide-agent
// extension; there is no core selectedComposerId — see the divergence
// notes in composerActions.ts). The store's key provider therefore reads
// this service's own active-agent holder, which defaults to undefined —
// i.e. the binary's own `?? ""` fallback bucket — and is settable through
// setActiveAgentId(), the single seam where a future core active-agent
// service plugs in exactly where Blu's injected dependency sits. Per-agent
// isolation semantics are the store's (common/fileEditorFindState.ts)
// and are unit-tested through this seam; no bridge mechanism was invented
// for this wave.

import { Disposable, DisposableMap, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { CommonFindController } from '../../../../editor/contrib/find/browser/findController.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import {
	FileEditorFindSharedState,
	FileEditorFindStateStore,
	FILE_EDITOR_FIND_STATE_SERVICE_ID,
	shouldCaptureFindStateChange,
} from '../common/fileEditorFindState.js';

export const IFileEditorFindStateService = createDecorator<IFileEditorFindStateService>(FILE_EDITOR_FIND_STATE_SERVICE_ID);

export interface IFileEditorFindStateService {
	readonly _serviceBrand: undefined;

	/** Blu `getSharedState()`: shared find state for the active agent ({} when none). */
	getSharedState(): FileEditorFindSharedState;

	/**
	 * Blu `track(editor, controller)`: start capturing the controller's
	 * find-state changes into the per-agent map. Idempotent per editor;
	 * unregisters when the editor is disposed.
	 */
	track(editor: ICodeEditor, controller: CommonFindController): void;

	/**
	 * Fork seam for Blu's injected `glassActiveAgentService` (see header):
	 * sets the agent id used as the shared-state key from now on.
	 */
	setActiveAgentId(id: string | undefined): void;

	/** The current key source value (undefined = the `""` fallback bucket). */
	getActiveAgentId(): string | undefined;
}

export class FileEditorFindStateService extends Disposable implements IFileEditorFindStateService {
	declare readonly _serviceBrand: undefined;

	private _activeAgentId: string | undefined = undefined;
	private readonly _store = new FileEditorFindStateStore(() => this._activeAgentId);
	private readonly _tracked = this._register(new DisposableMap<ICodeEditor, DisposableStore>());

	getSharedState(): FileEditorFindSharedState {
		return this._store.getSharedState();
	}

	setActiveAgentId(id: string | undefined): void {
		this._activeAgentId = id;
	}

	getActiveAgentId(): string | undefined {
		return this._activeAgentId;
	}

	track(editor: ICodeEditor, controller: CommonFindController): void {
		// Blu: `if(this._tracked.has(t))return;`
		if (this._tracked.has(editor)) {
			return;
		}
		const disposables = new DisposableStore();
		const state = controller.getState();
		disposables.add(state.onFindReplaceStateChange(change => {
			// Blu: capture only when one of the six tracked fields changed.
			if (shouldCaptureFindStateChange(change)) {
				this._store.capture({
					searchString: state.searchString,
					replaceString: state.replaceString,
					isRegex: state.isRegex,
					wholeWord: state.wholeWord,
					matchCase: state.matchCase,
					preserveCase: state.preserveCase,
				});
			}
		}));
		disposables.add(editor.onDidDispose(() => this._tracked.deleteAndDispose(editor)));
		this._tracked.set(editor, disposables);
	}
}

/** UZp @16033237 — g0i's max selection length for seeding (512 KiB chars). */
export const FIND_SELECTION_SEED_MAX_LENGTH = 524288;

/**
 * g0i @16033237 port — the selection search-string helper g2x seeds from
 * (it lives in the binary's findController.js module). Verbatim logic:
 *   if (!editor.hasModel()) return null;
 *   selection is single-line (mode "single") or mode "multiple":
 *     empty selection -> configured word at cursor, returned ONLY when
 *       force === false (note: when the word exists and force is true,
 *       the result is null — the word never seeds in that case);
 *     non-empty selection with length < 524288 -> selection text;
 *   otherwise null.
 */
export function getFindSelectionSearchString(editor: ICodeEditor, mode: 'single' | 'multiple', force: boolean): string | null {
	if (!editor.hasModel()) {
		return null;
	}
	const selection = editor.getSelection();
	if (!selection) {
		return null;
	}
	if ((mode === 'single' && selection.startLineNumber === selection.endLineNumber) || mode === 'multiple') {
		if (selection.isEmpty()) {
			const word = editor.getConfiguredWordAtPosition(selection.getStartPosition());
			if (word && force === false) {
				return word.word;
			}
		} else if (editor.getModel().getValueLengthInRange(selection) < FIND_SELECTION_SEED_MAX_LENGTH) {
			return editor.getModel().getValueInRange(selection);
		}
	}
	return null;
}
