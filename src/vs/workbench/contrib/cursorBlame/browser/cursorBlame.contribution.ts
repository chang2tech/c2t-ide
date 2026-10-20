/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/cursorBlame.css';
import * as DOM from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable, DisposableStore, IReference } from '../../../../base/common/lifecycle.js';
import { Range } from '../../../../editor/common/core/range.js';
import { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { CodeEditorWidget } from '../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { IResolvedTextEditorModel, ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { Schemas } from '../../../../base/common/network.js';
import { dirname, extUri } from '../../../../base/common/resources.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { EditorContextKeys } from '../../../../editor/common/editorContextKeys.js';
import { Action2, MenuId, MenuRegistry as RegistryMenu, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { EditorExtensions, IEditorFactoryRegistry } from '../../../common/editor.js';
import { EditorInputCapabilities, EditorResourceAccessor, IEditorSerializer, IUntypedEditorInput, SideBySideEditor, Verbosity } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorResolverService, RegisteredEditorPriority } from '../../../services/editor/common/editorResolverService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { ISCMHistoryItem } from '../../scm/common/history.js';
import { ResourceContextKey } from '../../../common/contextkeys.js';
import { ExplorerFolderContext, ExplorerRootContext } from '../../files/common/files.js';
import {
	CURSOR_BLAME_AI_DETAILS_OPENED_EVENT,
	CURSOR_BLAME_ENABLED_FOR_TEAM_SETTING,
	CURSOR_BLAME_FILE_BLAME_OPENED_EVENT,
	CURSOR_BLAME_GET_COMMIT_METADATA_COMMAND,
	CURSOR_BLAME_GET_FILE_CONTENT_AT_REVISION_COMMAND,
	CURSOR_BLAME_GET_FILE_LINE_BLAME_COMMAND,
	CURSOR_BLAME_GET_FULL_COMMIT_COMMAND,
	CURSOR_BLAME_GET_GIT_ROOT_COMMAND,
	CURSOR_BLAME_GET_LINE_BLAME_COMMAND,
	CURSOR_BLAME_HOVER_DELAY_SETTING,
	CURSOR_BLAME_SCHEME,
	CURSOR_FILE_BLAME_REVISION_SCHEME,
	CURSOR_FILE_BLAME_SCHEME,
	ICursorBlameCommit,
	ICursorBlameLineInfo,
	ICursorCommitMetadata,
	ICursorFileBlameData,
	ICursorFileLineBlameResult,
	ICursorFullCommit,
	ICursorLineBlameCommit,
	blameColorIndices,
	buildCursorBlameCommitFromLineBlame,
	buildCursorBlameCommitFromMetadata,
	buildCursorBlameUri,
	expandFileLineBlame,
	formatBlameTimeAgo,
	isCursorBlameEnabled,
	isNoCommit,
	parseCursorBlameResource,
	resolveCursorBlameHoverDelay,
} from '../common/cursorBlame.js';

/**
 * Cursor parity: the commit-addressable blame editor (`cursor.blame` scheme).
 *
 * Binary evidence (Cursor 3.25.9 `out/vs/workbench/workbench.desktop.main.js`):
 * - scheme enum `e.cursorBlame="cursor.blame"`, `e.cursorFileBlame="cursor.fileblame"`
 * - `registerEditor` for the `cursor.blame` scheme glob (`{id, label:"Cursor Blame", priority:builtin}`)
 * - `registerEditor` for the `cursor.fileblame` scheme glob (`{id, label:"Cursor File Blame", priority:builtin}`)
 * - `registerEditorPane(… "Cursor Blame Editor" …)` for the commit input class
 * - `registerEditorSerializer(cIe.ID, …)` for the commit input class
 * - `createEditorInput` for `cursor.blame` parses `n.path.replace(/^\/commit\//,"")`
 *   and `new URLSearchParams(n.query).get("repoRoot")`, then creates the input
 *   with `{commitId, subject:"", message:"", repoRoot}`
 * - `createEditorInput` for `cursor.fileblame` reads the file path from
 *   `resource.path` and the revision from `resource.query`, then creates the
 *   input with `{fileUri, filePath, revision}`
 *
 * DEV-GAPS-178 (R2): the ids below are now the VERBATIM binary ids
 * (3.25.9): descriptor ids `Cst="workbench.editor.cursorblame"` /
 * `Jfa="workbench.editor.cursorfileblame"`, input ids
 * `workbench.editor.cursorblame.input` /
 * `workbench.editor.cursorfileblame.input`, pane titles "Cursor Blame
 * Editor" and "Cursor File Blame Editor". Earlier fork revisions used
 * fork-only ids (`workbench.input.cursorBlame`, `cursorBlame.blameEditor`,
 * …) for persisted-editor compatibility; editors serialized under those
 * old typeIds will no longer deserialize (the serializer registry is keyed
 * by the input id) — accepted as the cost of verbatim parity.
 */
export class CursorBlameEditorInput extends EditorInput {

	static readonly ID = 'workbench.editor.cursorblame.input';

	readonly commit: ICursorBlameCommit;

	constructor(commit: ICursorBlameCommit) {
		super();
		this.commit = commit;
	}

	override get typeId(): string {
		return CursorBlameEditorInput.ID;
	}

	override get editorId(): string {
		return CursorBlameEditor.ID;
	}

	override get resource(): URI {
		return buildCursorBlameUri(this.commit.commitId, this.commit.repoRoot);
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		// Cursor parity (3.25.9, verbatim `QHo`/cIe `matches(t)`):
		// super.matches(t) → true; same class → commitId + repoRoot equal;
		// else non-EditorInput with a `resource` → scheme/path/query equal.
		if (super.matches(other)) {
			return true;
		}
		if (other instanceof CursorBlameEditorInput) {
			return this.commit.commitId === other.commit.commitId
				&& this.commit.repoRoot === other.commit.repoRoot;
		}
		if (!(other instanceof EditorInput) && other && typeof other === 'object' && 'resource' in other) {
			const resource = (other as { resource?: unknown }).resource;
			if (resource instanceof URI) {
				return resource.scheme === CURSOR_BLAME_SCHEME
					&& resource.path === `/commit/${this.commit.commitId}`
					&& resource.query === this.resource.query;
			}
		}
		return false;
	}

	override getName(): string {
		// Cursor parity (3.25.9 `workbench.desktop.main.js`, verbatim):
		// getName(){const t=this.options.displayId||this.options.commitId.substring(0,7),
		// n=this.options.subject,i=`${t}: ${n}`;return i.length<=50?i:i.substring(0,47)+"..."}
		const label = `${this.commit.displayId || this.commit.commitId.substring(0, 7)}: ${this.commit.subject}`;
		return label.length <= 50 ? label : label.substring(0, 47) + '...';
	}

	override getTitle(verbosity?: Verbosity): string {
		// Cursor parity (3.25.9, verbatim):
		// getTitle(t){const n=this.options.displayId||this.options.commitId.substring(0,7),
		// i=this.options.subject;if(t===2){const s=this.options.author?` by ${this.options.author}`:"";
		// return`${n}: ${i}${s}`}const r=`${n}: ${i}`;return r.length<=50?r:r.substring(0,47)+"..."}
		// (`t===2` is `Verbosity.LONG`: no truncation, author appended when present.)
		const label = `${this.commit.displayId || this.commit.commitId.substring(0, 7)}: ${this.commit.subject}`;
		if (verbosity === Verbosity.LONG) {
			return this.commit.author ? `${label} by ${this.commit.author}` : label;
		}
		return label.length <= 50 ? label : label.substring(0, 47) + '...';
	}

	override getIcon(): ThemeIcon | URI | undefined {
		// Cursor parity (3.25.9, verbatim): getIcon(){return Oe.gitCommit}
		// (`Oe` is the codicon namespace; `gitCommit` is the `git-commit` codicon).
		return Codicon.gitCommit;
	}

	override get capabilities(): EditorInputCapabilities {
		// Cursor parity (3.25.9, verbatim): get capabilities(){return 2}
		// (EditorInputCapabilities.Readonly — NO Singleton flag).
		return EditorInputCapabilities.Readonly;
	}

	// NOTE: binary class aWo defines toJSON(); this fork's EditorInput base
	// has no toJSON(), so this is a plain method (no `override`).
	toJSON(): { [key: string]: unknown } {
		// Cursor parity (3.25.9, verbatim aWo): toJSON(){return{options:this.options}}
		// (this fork's `commit` field is the binary's `options` payload).
		return { options: this.commit };
	}

	override toUntyped(): IUntypedEditorInput {
		// Cursor parity (3.25.9, verbatim aWo):
		// toUntyped(){return{resource:this.resource,options:{override:xri.ID,pinned:!0}}}
		return {
			resource: this.resource,
			options: { override: CursorBlameEditorInput.ID, pinned: true },
		};
	}

	override copy(): CursorBlameEditorInput {
		// Cursor parity (3.25.9, verbatim aWo): copy(){return new xri(this.options)}
		return new CursorBlameEditorInput(this.commit);
	}
}

export class CursorBlameEditorSerializer implements IEditorSerializer {

	canSerialize(editorInput: EditorInput): boolean {
		return editorInput instanceof CursorBlameEditorInput;
	}

	serialize(editorInput: EditorInput): string | undefined {
		if (!(editorInput instanceof CursorBlameEditorInput)) {
			return undefined;
		}
		// Cursor parity (3.25.9, verbatim a$n):
		// serialize(e){return JSON.stringify({options:e.options})}
		return JSON.stringify({ options: editorInput.commit });
	}

	deserialize(_instantiationService: IInstantiationService, serializedEditorInput: string): EditorInput | undefined {
		try {
			// Cursor parity (3.25.9, verbatim a$n):
			// deserialize(e,t){const{options:n}=JSON.parse(t);return e.createInstance(cIe,n)}
			const { options } = JSON.parse(serializedEditorInput) as { options?: Partial<ICursorBlameCommit> & { commitId?: unknown } };
			if (!options || typeof options.commitId !== 'string') {
				return undefined;
			}
			const { commitId, subject = '', message = '', ...rest } = options;
			return new CursorBlameEditorInput({ subject, message, ...rest, commitId });
		} catch {
			return undefined;
		}
	}
}

/**
 * Cursor parity: the per-file blame editor input (`cursor.fileblame`
 * scheme). Binary evidence (Cursor 3.25.9
 * `out/vs/workbench/workbench.desktop.main.js`, class `Fym`):
 * - fields: `this.options = t` — `{fileUri, filePath, revision,
 *   revisionMessage, revisionAuthor, revisionTimestamp}`
 * - `get resource() { return URI.from({scheme: ft.cursorFileBlame,
 *   path: this.options.fileUri.path, query: this.options.revision || ""}) }`
 * - `get capabilities() { return 2 }` (EditorInputCapabilities.Readonly —
 *   NO Singleton flag)
 * - `matches(t)`: `super.matches(t)` → true; else same class →
 *   fileUri.toString() + revision equal; else non-EditorInput with a
 *   `resource` → scheme cursor.fileblame, path + query equal
 * - `getName()`: `Blame: <basename>` (+ ` @ <7-char rev>` when revision
 *   && revision !== "HEAD"); `getTitle(2)`: `Git Blame: <filePath>`
 * - `toJSON`/`toUntyped` ({resource, options:{override, pinned:!0}})/
 *   `copy()`
 *
 * DEV-GAPS-178 (R2): the input id is the VERBATIM binary id
 * `workbench.editor.cursorfileblame.input` (binary `tSm.ID`); see the
 * {@link CursorBlameEditorInput} header for the migration note.
 */
export class CursorFileBlameEditorInput extends EditorInput {

	static readonly ID = 'workbench.editor.cursorfileblame.input';

	readonly options: ICursorFileBlameData;

	constructor(data: ICursorFileBlameData) {
		super();
		this.options = data;
	}

	override get typeId(): string {
		return CursorFileBlameEditorInput.ID;
	}

	override get editorId(): string {
		return CursorFileBlameEditor.ID;
	}

	override get resource(): URI {
		return URI.from({
			scheme: CURSOR_FILE_BLAME_SCHEME,
			path: this.options.fileUri.path,
			query: this.options.revision || '',
		});
	}

	override getName(): string {
		const basename = this.options.filePath.split('/').pop() || this.options.filePath;
		if (this.options.revision && this.options.revision !== 'HEAD') {
			return `Blame: ${basename} @ ${this.options.revision.substring(0, 7)}`;
		}
		return `Blame: ${basename}`;
	}

	override getTitle(verbosity?: number): string {
		// Binary verbatim: `getTitle(t){return t===2 ? "Git Blame: ..." : this.getName()}`
		// (2 is Verbosity.LONG in both Cursor's bundle and this fork's
		// Verbosity enum: SHORT=0, MEDIUM=1, LONG=2).
		return verbosity === Verbosity.LONG ? `Git Blame: ${this.options.filePath}` : this.getName();
	}

	override getIcon(): ThemeIcon | URI | undefined {
		// Cursor parity (3.25.9, verbatim class Fym): getIcon(){return Oe.gitCommit}
		return Codicon.gitCommit;
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (super.matches(other)) {
			return true;
		}
		if (other instanceof CursorFileBlameEditorInput) {
			return this.options.fileUri.toString() === other.options.fileUri.toString()
				&& this.options.revision === other.options.revision;
		}
		if (!(other instanceof EditorInput) && other && typeof other === 'object' && 'resource' in other) {
			const resource = (other as { resource?: unknown }).resource;
			if (resource instanceof URI) {
				return resource.scheme === CURSOR_FILE_BLAME_SCHEME
					&& resource.path === this.options.fileUri.path
					&& (resource.query || '') === (this.options.revision || '');
			}
		}
		return false;
	}

	// NOTE: binary class Fym defines toJSON(); this fork's EditorInput base
	// has no toJSON(), so this is a plain method (no `override`).
	toJSON(): { [key: string]: unknown } {
		return {
			fileUri: this.options.fileUri.toString(),
			filePath: this.options.filePath,
			revision: this.options.revision,
			revisionMessage: this.options.revisionMessage,
			revisionAuthor: this.options.revisionAuthor,
			revisionTimestamp: this.options.revisionTimestamp,
		};
	}

	override toUntyped(): IUntypedEditorInput {
		return {
			resource: this.resource,
			options: { override: CursorFileBlameEditorInput.ID, pinned: true },
		};
	}

	override copy(): CursorFileBlameEditorInput {
		return new CursorFileBlameEditorInput(this.options);
	}
}

/**
 * Cursor parity: the file-blame serializer (Cursor 3.25.9
 * `registerEditorSerializer(fRt.ID, Vfa)` — the binary registers BOTH
 * serializers: fileblame `Vfa` and commit `r$n`). Binary serializes
 * `{fileUri, filePath, revision, revisionMessage, revisionAuthor,
 * revisionTimestamp}` and deserializes via `createInstance(fRt, {...})`
 * with `URI.parse(fileUri)`.
 */
export class CursorFileBlameEditorSerializer implements IEditorSerializer {

	canSerialize(editorInput: EditorInput): boolean {
		return editorInput instanceof CursorFileBlameEditorInput;
	}

	serialize(editorInput: EditorInput): string | undefined {
		if (!(editorInput instanceof CursorFileBlameEditorInput)) {
			return undefined;
		}
		return JSON.stringify({
			fileUri: editorInput.options.fileUri.toString(),
			filePath: editorInput.options.filePath,
			revision: editorInput.options.revision,
			revisionMessage: editorInput.options.revisionMessage,
			revisionAuthor: editorInput.options.revisionAuthor,
			revisionTimestamp: editorInput.options.revisionTimestamp,
		});
	}

	deserialize(instantiationService: IInstantiationService, serializedEditorInput: string): EditorInput | undefined {
		try {
			const { fileUri, filePath, revision, revisionMessage, revisionAuthor, revisionTimestamp } = JSON.parse(serializedEditorInput);
			if (typeof fileUri !== 'string') {
				return undefined;
			}
			return instantiationService.createInstance(CursorFileBlameEditorInput, {
				fileUri: URI.parse(fileUri),
				filePath,
				revision,
				revisionMessage,
				revisionAuthor,
				revisionTimestamp,
			});
		} catch {
			return undefined;
		}
	}
}

/**
 * Renders the commit addressed by a {@link CursorBlameEditorInput}.
 *
 * Cursor's pane (`CursorBlamePane.js`, a Solid component mounted by
 * `renderCursorBlamePane.js`) loads the FULL commit through the git
 * provider facade (`getFullCommit(commitId, repoRoot)`) and renders the
 * commit header plus one diff resource per changed file in a smart-review
 * panel (DEV-GAPS-178/R1.1 re-sliced the component from 3.25.9; see
 * work-notes-gaps178.md). This fork's pane mirrors that data flow through
 * the provider seam (`ide.cursorBlame.getFullCommit`): header fields are
 * refreshed from the full commit (title = full commit's subject, body =
 * its description), and every changed file is listed with its status and
 * +/- line counts and an expandable unified patch.
 *
 * VERBATIM behaviors ported: the uncommitted error text
 * ("Cannot show details for uncommitted changes. This line has not been
 * committed yet."), the not-found error (`Could not find commit <id>`),
 * the large-commit banner ("Large commit (<n> files). Diffs load when
 * expanded.") shown when the provider fell back to metadata-only, files
 * starting collapsed when the commit touches >= 1000 lines, the
 * copy-commit-SHA action, and the `cursor_blame.ai_details_opened`
 * analytics event fired only when the pane (re)renders for a new
 * commitId/repoRoot (binary `Tst.setInput` condition).
 *
 * REMAINING DIVERGENCES (honest): (1) Cursor renders each file as an
 * inline diff EDITOR inside its smart-review panel and groups files under
 * "Agent conversations" / "Non-agent files" using SERVER AI metrics
 * (backend `getCommitMetrics` + KV cache) — that grouping data is
 * enterprise/server-side and not reproducible from git (see the
 * `cursor-blame-details` matrix entry); the fork renders a flat file list
 * with the unified patch text. (2) The "Open in GitHub" action (and its
 * `cursor_blame.open_commit_in_github_clicked` event) needs a
 * git-upstream-URL seam + GitHub connection service the fork does not
 * have yet; it is not rendered rather than rendered dead.
 */
export class CursorBlameEditor extends EditorPane {

	/** Binary verbatim: the pane id IS the editor descriptor id (`Tst.ID = Cst = "workbench.editor.cursorblame"`). */
	static readonly ID = 'workbench.editor.cursorblame';

	private container: HTMLElement | undefined;
	private currentCommitId: string | undefined;
	private currentRepoRoot: string | undefined;

	constructor(
		group: IEditorGroup,
		// Uses the base class's `protected readonly telemetryService`
		// (Composite) for the analytics emission — no redeclare.
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@ICommandService private readonly commandService: ICommandService,
		@IClipboardService private readonly clipboardService: IClipboardService,
	) {
		super(CursorBlameEditor.ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this.container = DOM.append(parent, DOM.$('.cursor-blame-editor'));
	}

	override async setInput(input: CursorBlameEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		if (!this.container) {
			return;
		}
		// Cursor parity (3.25.9 `Tst.setInput`, verbatim condition): the
		// pane only re-renders — and only then fires
		// `cursor_blame.ai_details_opened` — when there is no live render
		// or the commit id / repo root changed.
		const commitChanged = this.currentCommitId !== input.commit.commitId;
		const repoChanged = this.currentRepoRoot !== input.commit.repoRoot;
		if (!commitChanged && !repoChanged && this.container.childElementCount > 0) {
			return;
		}
		this.currentCommitId = input.commit.commitId;
		this.currentRepoRoot = input.commit.repoRoot;
		this.renderCommitHeader(input);
		// Binary: `_analyticsService.trackEvent("cursor_blame.ai_details_opened")`
		// (single argument, no properties). Fork mapping: ITelemetryService.publicLog.
		this.telemetryService.publicLog(CURSOR_BLAME_AI_DETAILS_OPENED_EVENT);
		void this.loadFullCommit(input, token);
	}

	private renderCommitHeader(input: CursorBlameEditorInput): void {
		if (!this.container) {
			return;
		}
		DOM.clearNode(this.container);
		const commit = input.commit;
		const header = DOM.append(this.container, DOM.$('h2.cursor-blame-title'));
		header.textContent = commit.subject || commit.commitId;
		const actions = DOM.append(this.container, DOM.$('.cursor-blame-actions'));
		const copyButton = DOM.append(actions, DOM.$('button.cursor-blame-copy-sha')) as HTMLButtonElement;
		copyButton.textContent = localize('cursorBlameEditor.copySha', 'Copy commit SHA');
		copyButton.title = localize('cursorBlameEditor.copyShaTitle', 'Click to copy: {0}', commit.commitId);
		this._register(DOM.addDisposableListener(copyButton, 'click', () => {
			void this.clipboardService.writeText(commit.commitId);
			copyButton.textContent = localize('cursorBlameEditor.copied', 'Copied');
		}));
		const dl = DOM.append(this.container, DOM.$('dl.cursor-blame-meta'));
		const rows: Array<[string, string]> = [
			[localize('cursorBlameEditor.commit', 'Commit'), commit.commitId],
		];
		if (commit.author) {
			rows.push([localize('cursorBlameEditor.author', 'Author'), commit.author]);
		}
		if (typeof commit.timestamp === 'number') {
			rows.push([localize('cursorBlameEditor.date', 'Date'), new Date(commit.timestamp).toLocaleString()]);
		}
		if (commit.repoRoot) {
			rows.push([localize('cursorBlameEditor.repoRoot', 'Repository'), commit.repoRoot]);
		}
		for (const [term, value] of rows) {
			const dt = DOM.append(dl, DOM.$('dt'));
			dt.textContent = term;
			const dd = DOM.append(dl, DOM.$('dd'));
			dd.textContent = value;
		}
		if (commit.message) {
			const message = DOM.append(this.container, DOM.$('pre.cursor-blame-message'));
			message.textContent = commit.message;
		}
	}

	/**
	 * Loads the full commit (metadata + parsed diff) through the provider
	 * seam and renders the changed-file list. Mirrors Cursor's
	 * `CursorBlamePane.pe()` state flow: uncommitted → verbatim error;
	 * provider miss → `Could not find commit <id>`; metadata-only result
	 * (`diffOmitted`) → large-commit mode with the verbatim banner.
	 */
	private async loadFullCommit(input: CursorBlameEditorInput, token: CancellationToken): Promise<void> {
		if (!this.container) {
			return;
		}
		const status = DOM.append(this.container, DOM.$('.cursor-blame-status'));
		if (isNoCommit(input.commit.commitId)) {
			// Cursor verbatim (CursorBlamePane.pe): shown for the zero-SHA sentinel.
			status.textContent = localize('cursorBlameEditor.uncommitted', 'Cannot show details for uncommitted changes. This line has not been committed yet.');
			return;
		}
		status.textContent = localize('cursorBlameEditor.loading', 'Loading commit…');
		let full: ICursorFullCommit | undefined;
		try {
			full = await this.commandService.executeCommand<ICursorFullCommit | undefined>(
				CURSOR_BLAME_GET_FULL_COMMIT_COMMAND,
				input.commit.commitId,
				input.commit.repoRoot,
			);
		} catch {
			full = undefined;
		}
		if (token.isCancellationRequested || !this.container || this.input !== input) {
			return;
		}
		status.remove();
		if (!full) {
			const error = DOM.append(this.container, DOM.$('.cursor-blame-status.cursor-blame-error'));
			// Cursor verbatim: `Could not find commit ${commitId}`.
			error.textContent = localize('cursorBlameEditor.notFound', 'Could not find commit {0}', input.commit.commitId);
			return;
		}
		// Refresh the header from the full commit, like Cursor (title =
		// full commit subject, summary = its description/body).
		const title = this.container.querySelector('.cursor-blame-title');
		if (title && full.message) {
			title.textContent = full.message.split(/\r?\n/)[0].trim() || title.textContent;
		}
		const totalLines = full.diff.reduce((sum, file) => sum + file.additions + file.deletions, 0);
		const isLargeCommit = !!full.diffOmitted;
		if (isLargeCommit) {
			const banner = DOM.append(this.container, DOM.$('.cursor-blame-large-commit-banner'));
			const fileCount = full.diff.length > 0 ? full.diff.length : (input.commit.statistics?.files ?? 0);
			// Cursor verbatim template: "Large commit (<!> files). Diffs load when expanded."
			banner.textContent = localize('cursorBlameEditor.largeCommit', 'Large commit ({0} files). Diffs load when expanded.', fileCount);
		}
		if (full.diff.length === 0) {
			return;
		}
		// Cursor: `defaultCollapsed` when the total changed lines reach 1000.
		const startCollapsed = totalLines >= 1000;
		const list = DOM.append(this.container, DOM.$('.cursor-blame-files'));
		for (const file of full.diff) {
			const section = DOM.append(list, DOM.$('.cursor-blame-file'));
			const fileHeader = DOM.append(section, DOM.$('.cursor-blame-file-header'));
			const pathLabel = DOM.append(fileHeader, DOM.$('span.cursor-blame-file-path'));
			pathLabel.textContent = file.to || file.from || '';
			const statusLabel = DOM.append(fileHeader, DOM.$('span.cursor-blame-file-status'));
			statusLabel.textContent = file.new ? localize('cursorBlameEditor.added', 'added') : file.deleted ? localize('cursorBlameEditor.deleted', 'deleted') : localize('cursorBlameEditor.modified', 'modified');
			const counts = DOM.append(fileHeader, DOM.$('span.cursor-blame-file-counts'));
			counts.textContent = `+${file.additions} -${file.deletions}`;
			if (file.chunks.length === 0) {
				continue;
			}
			const patch = DOM.append(section, DOM.$('pre.cursor-blame-file-patch')) as HTMLElement;
			patch.textContent = file.chunks.map(chunk => [chunk.content, ...chunk.changes.map(change => change.content)].join('\n')).join('\n');
			patch.style.display = startCollapsed || isLargeCommit ? 'none' : '';
			const toggle = DOM.append(fileHeader, DOM.$('button.cursor-blame-file-toggle')) as HTMLButtonElement;
			toggle.textContent = patch.style.display === 'none'
				? localize('cursorBlameEditor.expand', 'Expand')
				: localize('cursorBlameEditor.collapse', 'Collapse');
			this._register(DOM.addDisposableListener(toggle, 'click', () => {
				const hidden = patch.style.display === 'none';
				patch.style.display = hidden ? '' : 'none';
				toggle.textContent = hidden
					? localize('cursorBlameEditor.collapse', 'Collapse')
					: localize('cursorBlameEditor.expand', 'Expand');
			}));
		}
	}

	override clearInput(): void {
		if (this.container) {
			DOM.clearNode(this.container);
		}
		this.currentCommitId = undefined;
		this.currentRepoRoot = undefined;
		super.clearInput();
	}

	override layout(dimension: DOM.Dimension): void {
		// No-op: the DOM content flows naturally.
	}
}

/**
 * Pane for the file blame input. Cursor registers a pane with the
 * verbatim title "Cursor File Blame Editor" (3.25.9
 * `ZS.create(unn,unn.ID,"Cursor File Blame Editor")`) for the fileblame
 * input.
 *
 * DEV-GAPS-178 (R1.2 + R1.4): the pane now mirrors Cursor's file-blame
 * component (3.25.9, re-sliced; see work-notes-gaps178.md):
 * - It hosts a REAL read-only Monaco code editor (`CodeEditorWidget`,
 *   the same widget class Cursor's pane instantiates) with Cursor's
 *   verbatim editor options (readOnly, lineNumbers on,
 *   lineDecorationsWidth 16, minimap off, scrollBeyondLastLine off,
 *   automaticLayout, folding off, glyphMargin off, visible scrollbars,
 *   renderLineHighlight "all", contextmenu on).
 * - The model is the file's own text model; for a non-HEAD revision the
 *   content comes from the provider seam
 *   (`ide.cursorBlame.getFileContentAtRevision` → `git show rev:path`)
 *   in a synthetic model under the verbatim `cursor-file-blame-revision`
 *   scheme, falling back to the current file model on failure (Cursor's
 *   own fallback).
 * - Blame data comes from the GROUPED incremental seam
 *   `ide.cursorBlame.getFileLineBlame` (Cursor's
 *   `getGitFileLineBlameWithAbsolutePath`) — this pane is that seam's
 *   workbench consumer. Groups are expanded with the verbatim `d8S` port
 *   ({@link expandFileLineBlame}) and rendered as whole-line decorations
 *   colored by the verbatim `eSm` hash-color mapping
 *   ({@link blameColorIndices}), exactly Cursor's class names
 *   `cursor-file-blame-line-<i>` / `cursor-file-blame-opacity-<j>`.
 * - Clicking / moving the cursor / hovering (after the
 *   `cursor.blame.hoverDelay` delay, verbatim `USp` port) selects the
 *   line's blame group in the info bar (author, message truncated to 35
 *   chars + …, relative date via the verbatim `Qym` port, full date);
 *   "View commit" opens the commit pane for that group (Cursor's row
 *   link behavior), and "Open File" opens the file in the normal editor
 *   (Cursor's `openEditor({resource})` affordance).
 * - `cursor_blame.file_blame_opened` fires only when the pane (re)renders
 *   for a new fileUri/revision (binary `unn.setInput` condition).
 *
 * REMAINING DIVERGENCES (honest): Cursor renders a virtualized side list
 * of blame rows synchronized with the editor scroll, with a floating
 * hover popup; the fork shows the same per-line info in a fixed info bar
 * instead (no virtualized list, no popup). Cursor caches blame results
 * for 5 minutes (`a8S`) and dedupes in-flight provider promises; the fork
 * re-fetches per setInput. Decorations are applied to all lines at once
 * rather than only the visible window. AI attribution is NOT rendered: no
 * per-line AI field exists in the 3.25.9 provider output (see
 * gitBlameService.ts header note).
 */
export class CursorFileBlameEditor extends EditorPane {

	/** Binary verbatim: the pane id IS the editor descriptor id (`unn.ID = Jfa = "workbench.editor.cursorfileblame"`). */
	static readonly ID = 'workbench.editor.cursorfileblame';

	private container: HTMLElement | undefined;
	private headerElement: HTMLElement | undefined;
	private statusElement: HTMLElement | undefined;
	private infoElement: HTMLElement | undefined;
	private viewCommitButton: HTMLButtonElement | undefined;
	private editorContainer: HTMLElement | undefined;
	private codeEditor: ICodeEditor | undefined;
	private readonly editorDisposables = this._register(new DisposableStore());
	private modelReference: IReference<IResolvedTextEditorModel> | undefined;
	private syntheticModel: ITextModel | undefined;
	private decorationIds: string[] = [];
	private blameByLine = new Map<number, ICursorBlameLineInfo>();
	private activeInfo: ICursorBlameLineInfo | undefined;
	private currentFileUri: string | undefined;
	private currentRevision: string | undefined;
	private hoverTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		group: IEditorGroup,
		// Uses the base class's `protected readonly telemetryService`
		// (Composite) for the analytics emission — no redeclare.
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@ICommandService private readonly commandService: ICommandService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IEditorService private readonly editorService: IEditorService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ITextModelService private readonly textModelService: ITextModelService,
		@IModelService private readonly modelService: IModelService,
		@ILanguageService private readonly languageService: ILanguageService,
	) {
		super(CursorFileBlameEditor.ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this.container = DOM.append(parent, DOM.$('.cursor-file-blame-editor'));
		this.headerElement = DOM.append(this.container, DOM.$('.cursor-file-blame-header'));
		this.statusElement = DOM.append(this.container, DOM.$('.cursor-file-blame-status'));
		const infoBar = DOM.append(this.container, DOM.$('.cursor-file-blame-info'));
		this.infoElement = DOM.append(infoBar, DOM.$('span.cursor-file-blame-info-text'));
		this.viewCommitButton = DOM.append(infoBar, DOM.$('button.cursor-file-blame-view-commit')) as HTMLButtonElement;
		this.viewCommitButton.textContent = localize('cursorBlame.fileBlame.viewCommit', 'View commit');
		this.viewCommitButton.disabled = true;
		this.editorDisposables.add(DOM.addDisposableListener(this.viewCommitButton, 'click', () => {
			void this.openActiveCommit();
		}));
		const openFileButton = DOM.append(infoBar, DOM.$('button.cursor-file-blame-open-file')) as HTMLButtonElement;
		openFileButton.textContent = localize('cursorBlame.fileBlame.openFile', 'Open File');
		this.editorDisposables.add(DOM.addDisposableListener(openFileButton, 'click', () => {
			const input = this.input;
			if (input instanceof CursorFileBlameEditorInput) {
				void this.editorService.openEditor({ resource: input.options.fileUri });
			}
		}));
		this.editorContainer = DOM.append(this.container, DOM.$('.cursor-file-blame-editor-container'));
		const overflowWidgetsDomNode = DOM.append(this.container, DOM.$('.cursor-file-blame-overflow-widgets.monaco-editor'));
		// Cursor verbatim editor options (3.25.9 file-blame component).
		this.codeEditor = this.editorDisposables.add(this.instantiationService.createInstance(
			CodeEditorWidget,
			this.editorContainer,
			{
				readOnly: true,
				lineNumbers: 'on',
				lineDecorationsWidth: 16,
				minimap: { enabled: false },
				scrollBeyondLastLine: false,
				automaticLayout: true,
				folding: false,
				glyphMargin: false,
				scrollbar: { vertical: 'visible', horizontal: 'visible' },
				renderLineHighlight: 'all',
				contextmenu: true,
				overflowWidgetsDomNode,
			},
			{ isSimpleWidget: false },
		));
		this.editorDisposables.add(this.codeEditor.onMouseDown(e => {
			if (e.target.position) {
				this.setActiveLine(e.target.position.lineNumber);
			}
		}));
		this.editorDisposables.add(this.codeEditor.onDidChangeCursorPosition(e => {
			this.setActiveLine(e.position.lineNumber);
		}));
		// Hovering a line for the blame hover delay selects its group,
		// mirroring Cursor's hover popup trigger (delay = verbatim `USp`).
		this.editorDisposables.add(this.codeEditor.onMouseMove(e => {
			if (!e.target.position) {
				return;
			}
			const lineNumber = e.target.position.lineNumber;
			if (this.hoverTimer !== undefined) {
				clearTimeout(this.hoverTimer);
			}
			const delay = resolveCursorBlameHoverDelay(
				this.configurationService.inspect<number>(CURSOR_BLAME_HOVER_DELAY_SETTING),
				this.configurationService.getValue<number>('editor.hover.delay'),
			);
			this.hoverTimer = setTimeout(() => this.setActiveLine(lineNumber), delay);
		}));
	}

	override async setInput(input: CursorFileBlameEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		if (!this.container || !this.headerElement || !this.statusElement) {
			return;
		}
		// Cursor parity (3.25.9 `unn.setInput`, verbatim condition): the
		// pane only re-renders — and only then fires
		// `cursor_blame.file_blame_opened` — when there is no live render
		// or the file uri / revision changed.
		const fileUri = input.options.fileUri.toString();
		const revision = input.options.revision || '';
		if (this.currentFileUri === fileUri && this.currentRevision === revision && this.codeEditor?.getModel()) {
			return;
		}
		this.currentFileUri = fileUri;
		this.currentRevision = revision;
		DOM.clearNode(this.headerElement);
		this.headerElement.textContent = input.options.filePath;
		if (input.options.revision) {
			const rev = DOM.append(this.headerElement, DOM.$('span.cursor-file-blame-revision'));
			rev.textContent = ` @ ${input.options.revision}`;
		}
		this.statusElement.textContent = '';
		this.setActiveInfo(undefined);
		// Binary: `_analyticsService.trackEvent("cursor_blame.file_blame_opened")`
		// (single argument, no properties). Fork mapping: ITelemetryService.publicLog.
		this.telemetryService.publicLog(CURSOR_BLAME_FILE_BLAME_OPENED_EVENT);
		await this.loadModelAndBlame(input, token);
	}

	/**
	 * Loads the editor model (current file, or the revision content via
	 * the provider seam) and the grouped blame data via the
	 * `getFileLineBlame` seam, then applies the whole-line decorations.
	 * Error texts are Cursor's verbatim file-pane strings.
	 */
	private async loadModelAndBlame(input: CursorFileBlameEditorInput, token: CancellationToken): Promise<void> {
		if (!this.codeEditor || !this.statusElement) {
			return;
		}
		this.disposeModel();
		const { fileUri, revision } = input.options;
		const isRevision = !!revision && revision !== 'HEAD';
		let modelLoaded = false;
		if (isRevision) {
			// Cursor: read the current model's language first, then load
			// `git show <rev>:<path>` into a `cursor-file-blame-revision`
			// model; on failure fall back to the current file model.
			let languageId: string | undefined;
			try {
				const ref = await this.textModelService.createModelReference(fileUri);
				languageId = ref.object.textEditorModel?.getLanguageId();
				ref.dispose();
			} catch {
				languageId = undefined;
			}
			let content: string | undefined;
			try {
				content = await this.commandService.executeCommand<string | undefined>(
					CURSOR_BLAME_GET_FILE_CONTENT_AT_REVISION_COMMAND,
					fileUri.fsPath,
					revision,
				);
			} catch {
				content = undefined;
			}
			if (content !== undefined && !token.isCancellationRequested && this.input === input) {
				const languageSelection = languageId
					? this.languageService.createById(languageId)
					: this.languageService.createByFilepathOrFirstLine(fileUri, undefined);
				this.syntheticModel = this.modelService.createModel(
					content,
					languageSelection,
					URI.from({ scheme: CURSOR_FILE_BLAME_REVISION_SCHEME, path: fileUri.path, query: `${revision}:${input.options.filePath}` }),
				);
				this.codeEditor.setModel(this.syntheticModel);
				modelLoaded = true;
			}
		}
		if (!modelLoaded) {
			try {
				this.modelReference = await this.textModelService.createModelReference(fileUri);
				if (token.isCancellationRequested || this.input !== input) {
					return;
				}
				const textModel = this.modelReference.object.textEditorModel;
				if (textModel) {
					this.codeEditor.setModel(textModel);
					modelLoaded = true;
				}
			} catch {
				modelLoaded = false;
			}
		}
		if (!modelLoaded) {
			// Cursor verbatim: "Could not read file".
			this.statusElement.textContent = localize('cursorBlame.fileBlame.readError', 'Could not read file');
			return;
		}
		const model = this.codeEditor.getModel();
		if (!model) {
			return;
		}
		let result: ICursorFileLineBlameResult | undefined;
		try {
			result = await this.commandService.executeCommand<ICursorFileLineBlameResult | undefined>(
				CURSOR_BLAME_GET_FILE_LINE_BLAME_COMMAND,
				fileUri.fsPath,
				isRevision ? revision : undefined,
			);
		} catch {
			result = undefined;
		}
		if (token.isCancellationRequested || this.input !== input || !this.statusElement) {
			return;
		}
		if (!result || result.blameInformation.length === 0) {
			// Cursor verbatim: "No blame data available for this file".
			this.statusElement.textContent = localize('cursorBlame.fileBlame.noBlame', 'No blame data available for this file');
			this.blameByLine = new Map();
			return;
		}
		this.blameByLine = expandFileLineBlame(result, model.getLineCount());
		const decorations = [];
		for (const [lineNumber, info] of this.blameByLine) {
			const { baseColorIndex, opacityIndex } = blameColorIndices(info.commitHash);
			decorations.push({
				range: new Range(lineNumber, 1, lineNumber, 1),
				options: {
					isWholeLine: true,
					className: `cursor-file-blame-line-${baseColorIndex} cursor-file-blame-opacity-${opacityIndex}`,
					description: 'cursor-file-blame-line',
				},
			});
		}
		this.decorationIds = this.codeEditor.deltaDecorations(this.decorationIds, decorations);
		this.setActiveLine(this.codeEditor.getPosition()?.lineNumber ?? 1);
	}

	private setActiveLine(lineNumber: number): void {
		this.setActiveInfo(this.blameByLine.get(lineNumber));
	}

	private setActiveInfo(info: ICursorBlameLineInfo | undefined): void {
		this.activeInfo = info;
		if (!this.infoElement || !this.viewCommitButton) {
			return;
		}
		if (!info) {
			this.infoElement.textContent = '';
			this.viewCommitButton.disabled = true;
			return;
		}
		// Cursor row rendering: author, message truncated to 35 chars +
		// "…", relative date (verbatim `Qym` port), full locale date.
		const truncated = info.message.length > 35 ? info.message.substring(0, 35) + '…' : info.message;
		const when = info.authorDate ? `${formatBlameTimeAgo(info.authorDate)} (${new Date(info.authorDate).toLocaleString()})` : '';
		this.infoElement.textContent = [info.author, truncated, when].filter(part => part.length > 0).join(' — ');
		this.viewCommitButton.disabled = isNoCommit(info.commitHash);
	}

	/** Opens the commit pane for the active line's commit — Cursor's file-pane row link (`Re(commitHash, message, author)`). */
	private async openActiveCommit(): Promise<void> {
		const info = this.activeInfo;
		const input = this.input;
		if (!info || isNoCommit(info.commitHash) || !(input instanceof CursorFileBlameEditorInput)) {
			return;
		}
		let repoRoot: string | undefined;
		try {
			repoRoot = await this.commandService.executeCommand<string | undefined>(
				CURSOR_BLAME_GET_GIT_ROOT_COMMAND,
				dirname(input.options.fileUri).fsPath,
			);
		} catch {
			repoRoot = undefined;
		}
		const commitInput = this.instantiationService.createInstance(CursorBlameEditorInput, {
			commitId: info.commitHash,
			subject: (info.message ?? '').split(/\r?\n/)[0].trim(),
			message: info.message ?? '',
			author: info.author,
			timestamp: info.authorDate || undefined,
			repoRoot,
		});
		await this.editorService.openEditor(commitInput, { pinned: true, override: CURSOR_BLAME_EDITOR_DESCRIPTOR_ID });
	}

	private disposeModel(): void {
		if (this.codeEditor && this.decorationIds.length > 0) {
			this.decorationIds = this.codeEditor.deltaDecorations(this.decorationIds, []);
		}
		this.modelReference?.dispose();
		this.modelReference = undefined;
		if (this.syntheticModel) {
			this.syntheticModel.dispose();
			this.syntheticModel = undefined;
		}
		this.blameByLine = new Map();
	}

	override clearInput(): void {
		this.disposeModel();
		if (this.hoverTimer !== undefined) {
			clearTimeout(this.hoverTimer);
			this.hoverTimer = undefined;
		}
		this.currentFileUri = undefined;
		this.currentRevision = undefined;
		this.setActiveInfo(undefined);
		if (this.statusElement) {
			this.statusElement.textContent = '';
		}
		super.clearInput();
	}

	override layout(dimension: DOM.Dimension): void {
		this.codeEditor?.layout(dimension);
	}

	override dispose(): void {
		this.disposeModel();
		super.dispose();
	}
}

/** Editor descriptor ids for `openEditor(..., {override})` and `registerEditor`. DEV-GAPS-178 (R2): VERBATIM binary ids — `Cst="workbench.editor.cursorblame"` / `Jfa="workbench.editor.cursorfileblame"` (3.25.9); they are also the two pane ids (binary `Tst.ID = Cst`, `unn.ID = Jfa`). */
export const CURSOR_BLAME_EDITOR_DESCRIPTOR_ID = 'workbench.editor.cursorblame';
export const CURSOR_FILE_BLAME_EDITOR_DESCRIPTOR_ID = 'workbench.editor.cursorfileblame';

/**
 * Returns true when an editor input typeId belongs to a Cursor Blame
 * editor (the `cursor.blame` commit editor or the `cursor.fileblame`
 * file editor). `EditorContextCursorBlame` is a MenuId (verbatim binary
 * literal, Cursor 3.25.9), not a context key, so this helper is only used
 * in tests and for menu-surface assertions.
 */
export function isCursorBlameEditorType(typeId: string): boolean {
	return typeId === CursorBlameEditorInput.ID || typeId === CursorFileBlameEditorInput.ID;
}

/**
 * Core replacement for `vscode.workspace.asRelativePath` (this fork's
 * `IWorkspaceContextService` has no `asRelativePath`; other contributions
 * implement it via `getWorkspaceFolder` + `extUri.relativePath`).
 */
function asRelativePath(workspaceContextService: IWorkspaceContextService, uri: URI): string {
	const folder = workspaceContextService.getWorkspaceFolder(uri);
	if (folder) {
		const rel = extUri.relativePath(folder.uri, uri);
		if (rel) {
			return rel;
		}
	}
	return uri.fsPath;
}

/**
 * Resolves the target of `cursorBlame.openFileBlame`, mirroring Cursor's
 * run body (3.25.9): a `{scheme, path}` object is used as-is, an
 * `{fsPath}` object becomes `URI.file(fsPath)`; otherwise the active
 * editor's original URI (side-by-side PRIMARY) is used.
 */
export function resolveOpenFileBlameTarget(arg: unknown, activeEditorOriginalUri: URI | undefined): URI | undefined {
	let target: URI | undefined;
	if (arg && typeof arg === 'object') {
		if ('scheme' in arg && 'path' in arg) {
			target = arg as URI;
		} else if ('fsPath' in arg && typeof (arg as { fsPath: unknown }).fsPath === 'string') {
			target = URI.file((arg as { fsPath: string }).fsPath);
		}
	}
	return target ?? activeEditorOriginalUri;
}

/**
 * `cursorBlame.openFileBlame` — "Open File Blame", category "Cursor Blame",
 * `f1: !0` (3.25.9). Opens the `cursor.fileblame` editor for the given file
 * (or the active editor's file), pinned.
 */
export class OpenFileBlameAction extends Action2 {

	static readonly ID = 'cursorBlame.openFileBlame';

	constructor() {
		super({
			id: OpenFileBlameAction.ID,
			title: localize2('cursorBlame.openFileBlame', 'Open File Blame'),
			category: localize2('cursorBlame.category', 'Cursor Blame'),
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor, arg?: unknown): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const instantiationService = accessor.get(IInstantiationService);
		const workspaceContextService = accessor.get(IWorkspaceContextService);

		const activeEditorOriginalUri = editorService.activeEditor
			? EditorResourceAccessor.getOriginalUri(editorService.activeEditor, { supportSideBySide: SideBySideEditor.PRIMARY })
			: undefined;
		const target = resolveOpenFileBlameTarget(arg, activeEditorOriginalUri ?? undefined);
		if (!target) {
			return;
		}
		const filePath = asRelativePath(workspaceContextService, target) || target.fsPath;
		const input = instantiationService.createInstance(CursorFileBlameEditorInput, { fileUri: target, filePath });
		await editorService.openEditor(input, { pinned: true, override: CURSOR_FILE_BLAME_EDITOR_DESCRIPTOR_ID });
	}
}

/**
 * `cursorBlame.openCommit` — "View Commit", category "Cursor Blame",
 * `f1: !0` (3.25.9). Prompts for a commit id (defaulting to the clipboard
 * contents), then opens the `cursor.blame` editor for it, pinned.
 *
 * The quick-input prompt is verbatim from the binary's NLS table
 * (`out/nls.messages.json` index 5317, used by `n.input({prompt:k(5317)})`):
 * "Paste commit hash".
 *
 * DEV-GAPS-76 (W76B): Cursor resolves commit metadata via its internal git
 * context service (`getCommitMetadataOnly`) inside a try/catch — on
 * failure the input is created with empty subject/message. The fork now
 * resolves it for real through the ide-agent git provider bridge
 * (`ide.cursorBlame.getCommitMetadata`, Cursor's verbatim `git show`
 * argv); only the failure path (provider unavailable / unknown commit)
 * still yields empty subject/message, exactly like Cursor's `catch{}`.
 */
export class OpenCommitAction extends Action2 {

	static readonly ID = 'cursorBlame.openCommit';

	constructor() {
		super({
			id: OpenCommitAction.ID,
			title: localize2('cursorBlame.openCommit', 'View Commit'),
			category: localize2('cursorBlame.category', 'Cursor Blame'),
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const instantiationService = accessor.get(IInstantiationService);
		const clipboardService = accessor.get(IClipboardService);
		const quickInputService = accessor.get(IQuickInputService);
		const commandService = accessor.get(ICommandService);
		const workspaceContextService = accessor.get(IWorkspaceContextService);

		let clipboardText = '';
		try {
			clipboardText = (await clipboardService.readText())?.trim() ?? '';
		} catch {
			// Ignore clipboard failures, like Cursor's `catch{}`.
		}
		const commitId = (await quickInputService.input({
			// Cursor parity (3.25.9, verbatim NLS k(5317)): "Paste commit hash".
			prompt: localize('cursorBlame.openCommit.prompt', 'Paste commit hash'),
			value: clipboardText,
		}))?.trim();
		if (!commitId) {
			return;
		}
		// Cursor parity (3.25.9, verbatim): try{const f=await
		// t.getCommitMetadataOnly(c); f&&(subject=firstLine(f.message),
		// message=f.description??"", author=f.author, timestamp=...)}catch{}
		// — on failure the input keeps empty subject/message. DEV-GAPS-76
		// (W76B): the metadata now resolves for real through the ide-agent
		// git provider bridge (`git show -m --pretty=format:...`, Cursor's
		// verbatim provider argv); the catch fallback is Cursor's own.
		let commit: ICursorBlameCommit = { commitId, subject: '', message: '' };
		try {
			const metadata = await commandService.executeCommand<ICursorCommitMetadata | undefined>(
				CURSOR_BLAME_GET_COMMIT_METADATA_COMMAND,
				commitId,
				workspaceContextService.getWorkspace().folders[0]?.uri.fsPath,
			);
			if (metadata) {
				commit = buildCursorBlameCommitFromMetadata(commitId, metadata);
			}
		} catch {
			// Cursor's own failure path: empty subject/message.
		}
		const input = instantiationService.createInstance(CursorBlameEditorInput, commit);
		await editorService.openEditor(input, { pinned: true, override: CURSOR_BLAME_EDITOR_DESCRIPTOR_ID });
	}
}

/**
 * `cursorBlame.viewCommit` — "View commit", category "Cursor Blame",
 * `f1: !1` (3.25.9). Opens the `cursor.blame` editor for the commit that
 * blamed the current line, pinned.
 *
 * Binary behavior (3.25.9, verbatim run body): after the guards below,
 * `if(!n.hasGitContextProvider()){s.info(k(5320));return}`, else
 * `getGitLineBlameWithAbsolutePath(c.fsPath,u,1)` → if no commit or
 * `sWo(commit)` → `s.info(k(5321))`, else `createInstance(cIe,
 * {commitId, subject:firstLine(blame.message), message:"", author,
 * timestamp, repoRoot:getGitRoot(dirname(fsPath))})` and
 * `openEditor(w,{pinned:!0,override:Cst})` — the blame EDITOR, not a
 * quickpick.
 *
 * DEV-GAPS-76 (W76B): the git backend now EXISTS. This fork has no
 * workbench `gitContextService` facade, so the action reaches the
 * ide-agent extension's git provider through the command bridge
 * (`ide.cursorBlame.getLineBlame` / `ide.cursorBlame.getGitRoot`, the
 * provider runs Cursor's verbatim `git log -L` argv — see
 * `extensions/ide-agent/src/services/gitBlameService.ts`). The branch
 * structure is Cursor's own: provider unavailable or file outside any git
 * repository → `s.info(k(5320))`; provider present but no commit for the
 * line (or the zero-SHA sentinel) → `s.info(k(5321))`; otherwise the
 * blame editor opens with the verbatim-mapped payload
 * (`buildCursorBlameCommitFromLineBlame`). The NLS texts ARE recoverable
 * verbatim from the binary's `out/nls.messages.json`:
 * k(5320)="No git repository found", k(5321)="This line has not been
 * committed yet".
 */
export class ViewCommitAction extends Action2 {

	static readonly ID = 'cursorBlame.viewCommit';

	constructor() {
		super({
			id: ViewCommitAction.ID,
			title: localize2('cursorBlame.viewCommit', 'View commit'),
			category: localize2('cursorBlame.category', 'Cursor Blame'),
			f1: false,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const codeEditorService = accessor.get(ICodeEditorService);
		const notificationService = accessor.get(INotificationService);
		const commandService = accessor.get(ICommandService);
		const editorService = accessor.get(IEditorService);
		const instantiationService = accessor.get(IInstantiationService);

		// Cursor parity (3.25.9, verbatim guards):
		// const o=t.getFocusedCodeEditor()??t.getActiveCodeEditor();if(!o?.hasModel())return;
		// const a=o.getModel();if(!a)return;const c=a.uri;if(c.scheme!=="file")return;
		// const l=o.getPosition();if(!l)return;const u=l.lineNumber;
		const codeEditor = codeEditorService.getFocusedCodeEditor() ?? codeEditorService.getActiveCodeEditor();
		if (!codeEditor?.hasModel()) {
			return;
		}
		const model = codeEditor.getModel();
		if (!model) {
			return;
		}
		if (model.uri.scheme !== Schemas.file) {
			return;
		}
		const position = codeEditor.getPosition();
		if (!position) {
			return;
		}
		// Cursor parity (3.25.9, verbatim branch structure):
		// if(!n.hasGitContextProvider()){s.info(k(5320));return}
		// const p=(await n.getGitLineBlameWithAbsolutePath(c.fsPath,u,1))?.commits?.[0], g=p?.commit;
		// if(!g||sWo(g)){s.info(k(5321));return}
		// const y=await n.getGitRoot(WO(c.fsPath)).catch(()=>{});
		// openEditor(createInstance(cIe,{commitId:g,subject:firstLine(p.message),message:"",author:p.author,timestamp,b:repoRoot:y}),{pinned:!0,override:Cst})
		// Fork transport: the provider commands stand in for the facade; a
		// missing command (extension inactive) or an unresolvable repo both
		// take Cursor's k(5320) branch, exactly like "no provider".
		let lineBlame: { commits: ICursorLineBlameCommit[] } | undefined;
		let repoRoot: string | undefined;
		try {
			lineBlame = await commandService.executeCommand<{ commits: ICursorLineBlameCommit[] } | undefined>(
				CURSOR_BLAME_GET_LINE_BLAME_COMMAND,
				model.uri.fsPath,
				position.lineNumber,
			);
			repoRoot = await commandService.executeCommand<string | undefined>(
				CURSOR_BLAME_GET_GIT_ROOT_COMMAND,
				dirname(model.uri).fsPath,
			);
		} catch {
			lineBlame = undefined;
			repoRoot = undefined;
		}
		if (!lineBlame || !repoRoot) {
			// k(5320)="No git repository found" (out/nls.messages.json, verbatim).
			notificationService.info(localize('cursorBlame.viewCommit.noBlame', 'No git repository found'));
			return;
		}
		const entry = lineBlame.commits?.[0];
		if (!entry || isNoCommit(entry.commit)) {
			// k(5321)="This line has not been committed yet" (verbatim).
			notificationService.info(localize('cursorBlame.viewCommit.notCommitted', 'This line has not been committed yet'));
			return;
		}
		const input = instantiationService.createInstance(
			CursorBlameEditorInput,
			buildCursorBlameCommitFromLineBlame(entry, repoRoot),
		);
		await editorService.openEditor(input, { pinned: true, override: CURSOR_BLAME_EDITOR_DESCRIPTOR_ID });
	}
}

/**
 * Maps an SCM history item to the commit payload for the Cursor Blame
 * editor. Cursor parity (3.25.9, verbatim): binary `K2m(e,t)` —
 * `{commitId:e.id,commitParentId:e.parentIds[0],displayId:e.displayId,
 *  subject:e.subject,message:e.message,author:e.author,authorEmail:e.authorEmail,
 *  timestamp:e.timestamp,statistics:e.statistics,repoRoot:t}`.
 */
export function buildCursorBlameCommitFromHistoryItem(historyItem: ISCMHistoryItem, repoRoot: string | undefined): ICursorBlameCommit {
	return {
		commitId: historyItem.id,
		commitParentId: historyItem.parentIds[0],
		displayId: historyItem.displayId,
		subject: historyItem.subject,
		message: historyItem.message,
		author: historyItem.author,
		authorEmail: historyItem.authorEmail,
		timestamp: historyItem.timestamp,
		statistics: historyItem.statistics,
		repoRoot,
	};
}

/**
 * `workbench.scm.action.graph.openInCursorBlame` — SCM history-item context
 * menu, group "0_view", order 2, `f1: !1` (3.25.9). Re-checks the
 * `cursor_blame` gate + team setting in `run` (verbatim binary behavior)
 * and opens the `cursor.blame` editor for the history item's commit, pinned.
 * The commit payload is `buildCursorBlameCommitFromHistoryItem` — verbatim
 * binary `K2m(e,t)`.
 *
 * The command title IS recoverable verbatim from the binary's
 * `out/nls.messages.json` (k(9288)="Open in Cursor Blame") and matches the
 * fork title below.
 */
export class OpenInCursorBlameScmAction extends Action2 {

	static readonly ID = 'workbench.scm.action.graph.openInCursorBlame';

	constructor() {
		super({
			id: OpenInCursorBlameScmAction.ID,
			title: localize2('cursorBlame.scm.openInCursorBlame', 'Open in Cursor Blame'),
			f1: false,
			menu: [
				{
					id: MenuId.SCMHistoryItemContext,
					group: '0_view',
					order: 2,
				},
			],
		});
	}

	override async run(accessor: ServicesAccessor, provider?: { rootUri?: URI }, historyItem?: ISCMHistoryItem): Promise<void> {
		const configurationService = accessor.get(IConfigurationService);
		const editorService = accessor.get(IEditorService);
		const instantiationService = accessor.get(IInstantiationService);

		if (!isCursorBlameEnabled(
			configurationService.getValue<Record<string, boolean> | undefined>('ide.agent.featureGates'),
			configurationService.getValue<boolean | undefined>(CURSOR_BLAME_ENABLED_FOR_TEAM_SETTING),
		)) {
			return;
		}
		if (!provider || !historyItem) {
			return;
		}
		const commit = buildCursorBlameCommitFromHistoryItem(historyItem, provider.rootUri?.fsPath);
		if (isNoCommit(commit.commitId)) {
			return;
		}
		const input = instantiationService.createInstance(CursorBlameEditorInput, commit);
		await editorService.openEditor(input, { pinned: true });
	}
}

/**
 * Cursor parity: `workbench.contrib.cursorBlameCommand` (3.25.9, verbatim).
 * The `cursorBlame.*` commands only exist while
 * `checkFeatureGate("cursor_blame", {disableExposureLog:!1}) &&
 * isCursorBlameEnabledForTeam()` holds. The fork re-evaluates on
 * configuration changes and disposes/re-registers the commands, so the
 * palette surface matches Cursor exactly (commands vanish when gated off
 * instead of lingering disabled).
 */
class CursorBlameCommandContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.cursorBlameCommand';

	private readonly commandRegistrations = this._register(new DisposableStore());

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
		this.update();
		this._register(configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('ide.agent.featureGates') || e.affectsConfiguration(CURSOR_BLAME_ENABLED_FOR_TEAM_SETTING)) {
				this.update();
			}
		}));
	}

	private update(): void {
		this.commandRegistrations.clear();
		if (!isCursorBlameEnabled(
			this.configurationService.getValue<Record<string, boolean> | undefined>('ide.agent.featureGates'),
			this.configurationService.getValue<boolean | undefined>(CURSOR_BLAME_ENABLED_FOR_TEAM_SETTING),
		)) {
			return;
		}
		this.commandRegistrations.add(registerAction2(OpenFileBlameAction));
		this.commandRegistrations.add(registerAction2(OpenCommitAction));
		this.commandRegistrations.add(registerAction2(ViewCommitAction));
	}
}

// DEV-GAPS-178 (R3): binary registers this contribution at `hs.AfterRestored`
// (3.25.9: `ls(Bzn.ID, Bzn, hs.AfterRestored)`), not BlockStartup.
registerWorkbenchContribution2(CursorBlameCommandContribution.ID, CursorBlameCommandContribution, WorkbenchPhase.AfterRestored);

/**
 * Cursor parity: `workbench.contrib.cursorBlameMenu` (3.25.9, verbatim).
 *
 * Binary evidence (Cursor 3.25.9 `workbench.desktop.main.js`, class `Ozn`):
 * the contribution registers menus ONLY while
 * `checkFeatureGate("cursor_blame", {disableExposureLog:!1}) &&
 * isCursorBlameEnabledForTeam()` holds, removing them when the gate turns
 * off (re-evaluated via `onDidChangeGates` / admin settings `onDidChange`):
 * - `appendMenuItem(MenuId.ExplorerContext, {group:"12_cursor_blame",
 *   order:1, command:{id: cursorBlame.openFileBlame, title:
 *   nls[5322]="Cursor Blame"}, when: !explorerResourceIsFolder &&
 *   !explorerResourceIsRoot})`
 * - `appendMenuItem(MenuId.EditorContext, {submenu:
 *   MenuId.EditorContextCursorBlame, title: nls[5323]="Cursor Blame",
 *   group:"12_cursor_blame", order:1, when: editorTextFocus &&
 *   resourceSet && isFileSystemResource})`
 * - `appendMenuItem(MenuId.EditorContextCursorBlame,
 *   {group:"navigation", order:1, command:{id: cursorBlame.openFileBlame,
 *   title: nls[5324]="Toggle file blame"}})`
 * - `appendMenuItem(MenuId.EditorContextCursorBlame,
 *   {group:"navigation", order:2, command:{id: cursorBlame.viewCommit,
 *   title: nls[5325]="View commit"}})`
 *
 * `EditorContextCursorBlame` is a **MenuId** in the binary
 * (`MenuId.EditorContextCursorBlame = new MenuId("EditorContextCursorBlame")`,
 * recovered at the MenuId enum), NOT a context key: an earlier fork
 * revision invented a `RawContextKey('editorContextCursorBlame')` in
 * `editorContextKeys.ts` — that fabricated key was removed (gaps-62 F2).
 *
 * HONEST-DIVERGENCE: this fork re-evaluates the gate on configuration
 * changes (like `CursorBlameCommandContribution`) because it has no
 * server-driven experiment service or admin settings service.
 */
class CursorBlameMenuContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.cursorBlameMenu';

	private readonly menuRegistrations = this._register(new DisposableStore());

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
		this.update();
		this._register(configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('ide.agent.featureGates') || e.affectsConfiguration(CURSOR_BLAME_ENABLED_FOR_TEAM_SETTING)) {
				this.update();
			}
		}));
	}

	private update(): void {
		this.menuRegistrations.clear();
		if (!isCursorBlameEnabled(
			this.configurationService.getValue<Record<string, boolean> | undefined>('ide.agent.featureGates'),
			this.configurationService.getValue<boolean | undefined>(CURSOR_BLAME_ENABLED_FOR_TEAM_SETTING),
		)) {
			return;
		}
		this.menuRegistrations.add(RegistryMenu.appendMenuItem(MenuId.ExplorerContext, {
			group: '12_cursor_blame',
			order: 1,
			command: { id: OpenFileBlameAction.ID, title: localize('cursorBlame.explorer.toggle', 'Cursor Blame') },
			when: ContextKeyExpr.and(ExplorerFolderContext.toNegated(), ExplorerRootContext.toNegated()),
		}));
		this.menuRegistrations.add(RegistryMenu.appendMenuItem(MenuId.EditorContext, {
			submenu: MenuId.EditorContextCursorBlame,
			title: localize('cursorBlame.editor.submenu', 'Cursor Blame'),
			group: '12_cursor_blame',
			order: 1,
			when: ContextKeyExpr.and(EditorContextKeys.editorTextFocus, ResourceContextKey.HasResource, ResourceContextKey.IsFileSystemResource),
		}));
		this.menuRegistrations.add(RegistryMenu.appendMenuItem(MenuId.EditorContextCursorBlame, {
			group: 'navigation',
			order: 1,
			command: { id: OpenFileBlameAction.ID, title: localize('cursorBlame.editor.toggleFileBlame', 'Toggle file blame') },
		}));
		this.menuRegistrations.add(RegistryMenu.appendMenuItem(MenuId.EditorContextCursorBlame, {
			group: 'navigation',
			order: 2,
			command: { id: ViewCommitAction.ID, title: localize('cursorBlame.editor.viewCommit', 'View commit') },
		}));
	}
}

// DEV-GAPS-178 (R3): binary registers this contribution at `hs.AfterRestored`
// (3.25.9: `ls(Uzn.ID, Uzn, hs.AfterRestored)`), not BlockStartup.
registerWorkbenchContribution2(CursorBlameMenuContribution.ID, CursorBlameMenuContribution, WorkbenchPhase.AfterRestored);

/**
 * Registers the `cursor.blame` / `cursor.fileblame` editor panes and both
 * serializers. In the binary these registrations happen at module load
 * (3.25.9: `registerEditorPane(ZS.create(unn, …, "Cursor File Blame
 * Editor"))`, `registerEditorPane(ZS.create(Tst, …, "Cursor Blame
 * Editor"))`, `registerEditorSerializer` ×2, all top-level), i.e. as early
 * as the fork can manage — `BlockStartup`, so serializers exist before
 * editor restore. (DEV-GAPS-178/R3: this class previously also carried
 * the resolver registrations and sat at BlockStartup wholesale; the
 * resolver half now lives in {@link CursorBlameEditorResolverContribution}
 * at the binary's phase.)
 */
class CursorBlameEditorContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.cursorBlameEditor';

	constructor() {
		super();

		const editorPaneRegistry = Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane);
		this._register(editorPaneRegistry.registerEditorPane(
			EditorPaneDescriptor.create(CursorBlameEditor, CursorBlameEditor.ID, localize('cursorBlameEditor.label', 'Cursor Blame Editor')),
			[new SyncDescriptor(CursorBlameEditorInput)],
		));
		this._register(editorPaneRegistry.registerEditorPane(
			EditorPaneDescriptor.create(CursorFileBlameEditor, CursorFileBlameEditor.ID, localize('cursorFileBlameEditor.label', 'Cursor File Blame Editor')),
			[new SyncDescriptor(CursorFileBlameEditorInput)],
		));

		// Cursor registers BOTH serializers (3.25.9):
		// registerEditorSerializer(fRt.ID, Vfa) [fileblame] and
		// registerEditorSerializer(cIe.ID, r$n) [commit].
		Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(
			CursorBlameEditorInput.ID,
			CursorBlameEditorSerializer,
		);
		Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(
			CursorFileBlameEditorInput.ID,
			CursorFileBlameEditorSerializer,
		);
	}
}

registerWorkbenchContribution2(CursorBlameEditorContribution.ID, CursorBlameEditorContribution, WorkbenchPhase.BlockStartup);

/**
 * Registers the `cursor.blame:**​/**` and `cursor.fileblame:**​/**` editor
 * resolvers. Binary: two separate contributions (tva/nva) registered with
 * `registerWorkbenchContribution(<ctor>, 3)` (3.25.9) — numeric
 * LifecyclePhase 3 is `Eventually`. The fork folds both resolver
 * registrations into one contribution at the same phase
 * (DEV-GAPS-178/R3); the binary contributions carry no contribution id,
 * so this fork id is fork-chosen.
 */
class CursorBlameEditorResolverContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.cursorBlameEditorResolver';

	constructor(
		@IEditorResolverService private readonly editorResolverService: IEditorResolverService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) {
		super();

		this._register(this.editorResolverService.registerEditor(
			`${CURSOR_BLAME_SCHEME}:**/**`,
			{
				id: CURSOR_BLAME_EDITOR_DESCRIPTOR_ID,
				label: localize('cursorBlame.editorLabel', 'Cursor Blame'),
				priority: RegisteredEditorPriority.builtin,
			},
			{
				canSupportResource: resource => resource.scheme === CURSOR_BLAME_SCHEME,
			},
			{
				createEditorInput: ({ resource }) => {
					const { commitId, repoRoot } = parseCursorBlameResource(resource);
					return {
						editor: this.instantiationService.createInstance(CursorBlameEditorInput, {
							commitId,
							subject: '',
							message: '',
							repoRoot,
						}),
					};
				},
			},
		));

		this._register(this.editorResolverService.registerEditor(
			`${CURSOR_FILE_BLAME_SCHEME}:**/**`,
			{
				id: CURSOR_FILE_BLAME_EDITOR_DESCRIPTOR_ID,
				label: localize('cursorFileBlame.editorLabel', 'Cursor File Blame'),
				priority: RegisteredEditorPriority.builtin,
			},
			{
				canSupportResource: resource => resource.scheme === CURSOR_FILE_BLAME_SCHEME,
			},
			{
				createEditorInput: ({ resource }) => {
					const fileUri = URI.file(resource.path);
					const filePath = asRelativePath(this.workspaceContextService, fileUri) || fileUri.fsPath;
					const revision = resource.query || undefined;
					return {
						editor: this.instantiationService.createInstance(CursorFileBlameEditorInput, {
							fileUri,
							filePath,
							revision,
						}),
					};
				},
			},
		));
	}
}

// DEV-GAPS-178 (R3): phase 3 in the binary = `WorkbenchPhase.Eventually` here.
registerWorkbenchContribution2(CursorBlameEditorResolverContribution.ID, CursorBlameEditorResolverContribution, WorkbenchPhase.Eventually);

// The SCM graph action is registered statically; its run body re-checks the
// gate exactly like the binary (`if(!checkFeatureGate(...) ||
// !isCursorBlameEnabledForTeam())return`).
registerAction2(OpenInCursorBlameScmAction);

/**
 * Cursor parity: `workbench.contrib.cursorBlameConfiguration` (3.25.9 `$zn`,
 * verbatim): registers `cursor.blame.hoverDelay` once at `BlockStartup` with
 * `{type:"number",default:void 0,minimum:0,maximum:1e4,scope:1,included:r,
 *  markdownDescription:k(5327)}` where
 * `r=checkFeatureGate("cursor_blame",{disableExposureLog:!1}) &&
 *  isCursorBlameEnabledForTeam()`.
 *
 * HONEST-DIVERGENCE: the NLS texts ARE recoverable verbatim from the
 * binary's `out/nls.messages.json`: title k(5326)="Cursor Blame" and
 * markdownDescription k(5327)="Controls the delay in milliseconds before
 * hovers in the Cursor Blame panes appear. If not set, uses
 * `#editor.hover.delay#` with a minimum of 500ms." (the `#...#` is VS Code's
 * markdown setting-link syntax). `cursor.blame.enabledForTeam` is
 * fork-only (Cursor reads the team gate from admin settings, which this fork
 * has no analog of); it stays registered unconditionally so the fork can
 * model the gate at all.
 */
class CursorBlameConfigurationContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.cursorBlameConfiguration';

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
		const included = isCursorBlameEnabled(
			this.configurationService.getValue<Record<string, boolean> | undefined>('ide.agent.featureGates'),
			this.configurationService.getValue<boolean | undefined>(CURSOR_BLAME_ENABLED_FOR_TEAM_SETTING),
		);
		Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
			id: 'cursorBlame',
			order: 121,
			title: localize('cursorBlame.configurationTitle', 'Cursor Blame'),
			type: 'object',
			properties: {
				[CURSOR_BLAME_HOVER_DELAY_SETTING]: {
					type: 'number',
					default: undefined,
					minimum: 0,
					maximum: 10000,
					scope: 1,
					included,
					// Cursor parity (3.25.9, verbatim NLS k(5327)).
					markdownDescription: localize('cursorBlame.hoverDelay', 'Controls the delay in milliseconds before hovers in the Cursor Blame panes appear. If not set, uses `#editor.hover.delay#` with a minimum of 500ms.'),
				},
				[CURSOR_BLAME_ENABLED_FOR_TEAM_SETTING]: {
					// FORK-ONLY: models Cursor's admin `cursorBlameSettings.enabled`; not registered by Cursor.
					type: 'boolean',
					default: false,
					description: localize('cursorBlame.enabledForTeam', 'Whether Cursor Blame is enabled for the current team. Mirrors Cursor\'s admin-gated cursorBlameSettings.enabled.'),
				},
			},
		});
	}
}

// DEV-GAPS-178 (R3): BlockStartup is CORRECT here — the binary registers
// $zn at `hs.BlockStartup` (3.25.9); unchanged.
registerWorkbenchContribution2(CursorBlameConfigurationContribution.ID, CursorBlameConfigurationContribution, WorkbenchPhase.BlockStartup);
