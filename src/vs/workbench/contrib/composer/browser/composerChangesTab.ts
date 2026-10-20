/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Changes tab — Cursor parity (feature `workbench-open-changes-tab`,
// OBSERVED, audit-fix-queue run 24).
//
// Binary evidence (verbatim — kept character-for-character):
//   - New-tab-model action {id:"changes", label:"Changes", keywords:["git"],
//     icon:"plus-minus", keybindingCommandId: `glass.${egl}`} where
//     egl="openChangesTab" (glassCommandIds.js), gated on `showChangesAction`.
//   - Invocation: commandService.executeCommand("glass.openChangesTab",
//     {scope:"lastTurn", agentId, filePath?}).
//   - Cloud-agent renderer: agent-changes-tab-state.js ->
//     AgentChangesTabContent via
//     tabPersistenceService.openAgentChangesTab({bcId, label,
//     initialFilterScope:"branch", ownerAgentId}).
//   - Review renderer files: reviewChangesTabIdentity.js +
//     reviewChangesEditor.js.
//   - UI strings: "Open Changes Menu" x1, "Changes Sidebar" x1,
//     "Review Changes" x5, "View Uncommitted Changes" x1.
//
// LAYER NOTE: the binary shows the command id, args shape and renderer file
// names, but not which workbench layer registers the command, so the Cursor
// layer is UNKNOWN. This lives in browser/contrib/composer next to the other
// composer workbench contributions, matching the repo's Cursor-parity layout.
//
// COMMAND-ID LAYOUT (repo convention `ide.*` -> `composer.*`, see
// composerActions.ts header):
//   - `composer.openChangesTab` — canonical core Action2, real implementation
//     (this file).
//   - `ide.openChangesTab`      — extension command (package.json +
//     ide-agent extension.ts) delegating to `composer.openChangesTab`.
//     It is the one registered in the extension's package.json per the
//     product's command surface.
//   - `glass.openChangesTab`    — verbatim binary command id, OWNED by
//     src/vs/sessions/contrib/changes/browser/openChangesTabCommand.ts
//     (registers it with the keyboard-enum evidence: title "Review Changes",
//     Ctrl+E). This file deliberately does NOT register it: CommandsRegistry
//     keeps a per-id list where the last registration wins, so a second
//     registration here would make behavior order-dependent. The verbatim id
//     is kept as DATA only in GLASS_CHANGES_TAB_ACTION.keybindingCommandId.
//
// HONEST-DIVERGENCE:
//   - `plus-minus` is NOT in this VS Code codicon set (verified by grep over
//     src/vs/base/common/codiconsLibrary.ts — zero matches), so the closest
//     available codicon (`diff`) is registered as the fallback default under
//     `glass-changes-tab-icon`. The new-tab-model action keeps the verbatim
//     icon id "plus-minus" as data only; it does not claim to render it.
//   - Cursor gates the action on a `showChangesAction` flag whose semantics
//     are UNKNOWN. Ours gates on `composer.changesTabEnabled` (a context key
//     synced from the new config `composer.changesTab.enabled`, default true).
//   - Cursor's tab content comes from its glass tab-persistence service
//     (UNKNOWN internals). Ours lists the last turn's changed files from the
//     real CheckpointService data when the per-tab composer data service is
//     registered, and shows an honest empty state otherwise — never fake data.
//   - Cursor's Review Changes editor internals (reviewChangesEditor.js) are
//     UNKNOWN. Our Review Changes editor tab lists the last turn's changed
//     files and opens a real diff editor per file: the "before" side is the
//     genuine pre-edit snapshot captured by CheckpointService, the "after"
//     side is the live file. That wiring is ours, marked as such below.
//
// AVAILABILITY POLICY (binary-observed names, semantics NOT verified):
//   The binary exposes `changesTabAvailable`, `_isChangesTabActivatable()`,
//   `preferChangesAsDefault` and `_panelReplacementAutoSeedPolicy`. Their
//   conditions were not recoverable from the evidence, so they are NOT
//   reimplemented — reimplementing them would be fabrication. They are listed
//   here (and asserted by tests) so a future dissection pass can wire them.
//   What IS verified: the new-tab-model action is gated on `showChangesAction`;
//   our explicit analog is `composer.changesTab.enabled` /
//   `composer.changesTabEnabled`, enforced both in the palette `when` clause
//   and at `run()` time by `ChangesTabAvailabilityPolicy.isAvailable`.

import { localize, localize2 } from '../../../../nls.js';
import { URI } from '../../../../base/common/uri.js';
import { extUri } from '../../../../base/common/resources.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ServicesAccessor, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { ITextModelService, ITextModelContentProvider } from '../../../../editor/common/services/resolverService.js';
import { EditorExtensions, IEditorOpenContext, IResourceDiffEditorInput } from '../../../common/editor.js';
import { EditorInput, EditorInputCapabilities, IUntypedEditorInput } from '../../../common/editor/editorInput.js';
import { IEditorGroup, IEditorOptions } from '../../../common/editor.js';
import { EditorPane, EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ComposerActionCategory } from './composerActions.js';
import { ComposerContextKeys } from '../common/composerContextKeys.js';
import { buildReopenUntypedInput } from '../common/tabCloseRestore.js';
import { IComposerDataService } from '../common/composerDataService.js';

/**
 * Icon for the Changes tab. HONEST-DIVERGENCE: Cursor's binary icon id is
 * "plus-minus", which does not exist in this codicon set, so `diff` is the
 * fallback default (see file header).
 */
export const changesTabIcon = registerIcon(
	'glass-changes-tab-icon',
	Codicon.diff,
	localize('glassChangesTabIcon', 'Icon for the Changes tab.')
);

/** One changed file listed in the Changes tab. */
export interface ChangedFileEntry {
	/** Canonical URI string (as stored by CheckpointService). */
	readonly uri: string;
	/** True for files the agent created (CheckpointService.newlyCreatedFiles). */
	readonly isNew: boolean;
}

/**
 * Arguments for `glass.openChangesTab` / `composer.openChangesTab` /
 * `ide.openChangesTab`.
 *
 * Binary-verbatim arg shapes:
 *   - local invocation: {scope:"lastTurn", agentId, filePath?}
 *   - cloud-agent renderer (tabPersistenceService.openAgentChangesTab):
 *     {bcId, label, initialFilterScope:"branch", ownerAgentId}
 * Both shapes are accepted; fields that are absent are simply unused.
 */
export interface OpenChangesTabArgs {
	/** Local invocation scope (binary: "lastTurn"). */
	scope?: string;
	/** Agent/composer id the changes belong to. */
	agentId?: string;
	/** Optional file to highlight/reveal in the tab. */
	filePath?: string;
	/** Cloud-agent run id (binary openAgentChangesTab arg). */
	bcId?: string;
	/** Cloud-agent run label, shown as the tab subtitle when present. */
	label?: string;
	/**
	 * Filter scope for the cloud-agent surface (binary default "branch").
	 * UNKNOWN what other values Cursor accepts — passed through verbatim.
	 */
	initialFilterScope?: string;
	/** Owner agent id for the cloud-agent surface (binary arg). */
	ownerAgentId?: string;
}

/** Normalized invocation args: verified defaults applied, extras dropped. */
export interface NormalizedOpenChangesTabArgs {
	readonly scope: string;
	readonly agentId: string;
	readonly initialFilterScope: string;
	readonly filePath?: string;
	readonly bcId?: string;
	readonly label?: string;
	readonly ownerAgentId?: string;
}

/**
 * Applies the binary-verified defaults (`scope: "lastTurn"`,
 * `initialFilterScope: "branch"`, agent id `"default"`) and drops anything
 * that is not part of the evidence-backed arg shape. Pure — unit tested via
 * the extension-side mirror (services/changesTab.ts) and via static source
 * assertions.
 */
export function normalizeOpenChangesTabArgs(raw: unknown): NormalizedOpenChangesTabArgs {
	const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
	const str = (v: unknown): string | undefined => typeof v === 'string' && v.length > 0 ? v : undefined;
	return {
		scope: str(o['scope']) ?? 'lastTurn',
		agentId: str(o['agentId']) ?? 'default',
		initialFilterScope: str(o['initialFilterScope']) ?? 'branch',
		filePath: str(o['filePath']),
		bcId: str(o['bcId']),
		label: str(o['label']),
		ownerAgentId: str(o['ownerAgentId']),
	};
}

/**
 * Availability policy for the Changes tab.
 *
 * Binary-observed names whose semantics are UNKNOWN (see file header):
 * `changesTabAvailable`, `_isChangesTabActivatable()`,
 * `preferChangesAsDefault`, `_panelReplacementAutoSeedPolicy`.
 * They are intentionally NOT reimplemented.
 *
 * VERIFIED: the new-tab-model "changes" action is gated on
 * `showChangesAction`; our explicit analog is the
 * `composer.changesTab.enabled` setting (context key
 * `composer.changesTabEnabled`), enforced here at run() time in addition to
 * the palette `when` clause.
 */
export namespace ChangesTabAvailabilityPolicy {
	export function isAvailable(configurationService: IConfigurationService): boolean {
		return configurationService.getValue<boolean>('composer.changesTab.enabled') ?? true;
	}
}

/**
 * Changed files of the agent's most recent turn, from the real
 * CheckpointService data. Returns [] when the composer data service is not
 * registered yet (per-tab composer not wired — see
 * electron-browser/composer.contribution.ts) or when no checkpoints exist;
 * the tab then shows an honest empty state. Never fakes data.
 */
export function getLastTurnChangedFiles(accessor: ServicesAccessor): ChangedFileEntry[] {
	let dataService: IComposerDataService;
	try {
		dataService = accessor.get(IComposerDataService);
	} catch {
		return [];
	}
	const records = dataService.checkpoints.list();
	if (!records.length) {
		return [];
	}
	// Latest "after" record = post-turn state of the most recent turn;
	// fall back to the newest record of any kind.
	const latest = [...records].reverse().find(r => r.isAfter) ?? records[records.length - 1];
	const seen = new Set<string>();
	const entries: ChangedFileEntry[] = [];
	for (const snap of latest.files) {
		if (!seen.has(snap.uri)) {
			seen.add(snap.uri);
			entries.push({ uri: snap.uri, isNew: false });
		}
	}
	for (const uri of latest.newlyCreatedFiles) {
		if (!seen.has(uri)) {
			seen.add(uri);
			entries.push({ uri, isNew: true });
		}
	}
	return entries;
}

/**
 * Pre-edit ("before") contents for the last turn's changed files, from the
 * real CheckpointService snapshots (FileSnapshot.contents — captured BEFORE
 * each mutating tool call ran). Used by the Review Changes editor as the
 * diff "original" side. Returns an empty map when the data service is not
 * registered or there are no snapshots — the review surface then shows an
 * honest empty state instead of fake diffs.
 */
export function getReviewBeforeContents(accessor: ServicesAccessor): Map<string, string> {
	const before = new Map<string, string>();
	let dataService: IComposerDataService;
	try {
		dataService = accessor.get(IComposerDataService);
	} catch {
		return before;
	}
	const records = dataService.checkpoints.list();
	if (!records.length) {
		return before;
	}
	const latest = [...records].reverse().find(r => r.isAfter) ?? records[records.length - 1];
	for (const snap of latest.files) {
		if (!before.has(snap.uri)) {
			before.set(snap.uri, snap.contents);
		}
	}
	return before;
}

/** URI scheme for Changes tab documents. */
export const COMPOSER_CHANGES_EDITOR_SCHEME = 'composer-changes';

/** URI scheme for the Review Changes "before" snapshot documents. */
export const COMPOSER_CHANGES_REVIEW_SCHEME = 'composer-changes-review';

/**
 * Editor input for the Changes tab. Carries the (scope, agentId) invocation
 * args and a snapshot of the changed-file list taken when the command ran.
 */
export class ComposerChangesEditorInput extends EditorInput {

	static readonly ID = 'composer.changesTab';

	constructor(
		readonly agentId: string,
		readonly scope: string,
		readonly changedFiles: readonly ChangedFileEntry[],
		readonly selectedFilePath?: string,
		/** Cloud-agent run label (binary openAgentChangesTab arg) — subtitle. */
		readonly label?: string,
		/** Cloud-agent run id (binary openAgentChangesTab arg). */
		readonly bcId?: string,
		/** Owner agent id (binary openAgentChangesTab arg). */
		readonly ownerAgentId?: string,
		/** Filter scope (binary default "branch"). UNKNOWN other values. */
		readonly initialFilterScope?: string,
	) {
		super();
	}

	override get typeId(): string {
		return ComposerChangesEditorInput.ID;
	}

	override get editorId(): string {
		return ComposerChangesEditorInput.ID;
	}

	override getName(): string {
		// Verbatim action label "Changes".
		return localize('composer.changesTab.name', 'Changes');
	}

	override getTitle(): string {
		return this.label ?? this.getName();
	}

	override getResource(): URI {
		return URI.from({
			scheme: COMPOSER_CHANGES_EDITOR_SCHEME,
			path: `/${this.agentId}`,
			query: `scope=${encodeURIComponent(this.scope)}`,
		});
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton;
	}

	/**
	 * WORKER-GAPS-66D (`tab-close-restore`): untyped form for HistoryService's
	 * recently-closed stack, so Cmd+Shift+T restores a closed Changes tab.
	 * Same mechanism as Cursor (binary plugs its composer inputs into the
	 * stock reopen flow via `toUntyped()`). Reopen recreates the tab; the
	 * changed-file snapshot is not carried over (honest divergence — the
	 * pane refreshes its list from current state).
	 */
	override toUntyped(): IUntypedEditorInput {
		return buildReopenUntypedInput(this.getResource(), ComposerChangesEditorInput.ID, true);
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (other instanceof ComposerChangesEditorInput) {
			return other.agentId === this.agentId && other.scope === this.scope;
		}
		return super.matches(other);
	}
}

/**
 * Tab identity for the Review Changes editor (workbench analog of Cursor's
 * binary `reviewChangesTabIdentity.js`). The renderer internals of Cursor's
 * review editor are UNKNOWN; this input only carries the identity + the file
 * list, same role as a tab-identity module.
 */
export class ComposerReviewChangesEditorInput extends EditorInput {

	static readonly ID = 'composer.reviewChangesTab';

	constructor(
		readonly agentId: string,
		readonly scope: string,
		readonly changedFiles: readonly ChangedFileEntry[],
		readonly label?: string,
	) {
		super();
	}

	override get typeId(): string {
		return ComposerReviewChangesEditorInput.ID;
	}

	override get editorId(): string {
		return ComposerReviewChangesEditorInput.ID;
	}

	override getName(): string {
		// Verbatim UI string "Review Changes" (binary: 5 occurrences).
		return localize('composer.reviewChangesTab.name', 'Review Changes');
	}

	override getTitle(): string {
		return this.label ?? this.getName();
	}

	override getResource(): URI {
		return URI.from({
			scheme: COMPOSER_CHANGES_EDITOR_SCHEME,
			path: `/review/${this.agentId}`,
			query: `scope=${encodeURIComponent(this.scope)}`,
		});
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton;
	}

	/**
	 * WORKER-GAPS-66D (`tab-close-restore`): untyped form for HistoryService's
	 * recently-closed stack, so Cmd+Shift+T restores a closed Review Changes
	 * tab. Verbatim shape from the binary (Cursor 3.25.9, workbench.glass.main.js
	 * @26562063): `toUntyped(){return{resource:this.resource,options:{override:ZV.ID,pinned:!0}}}`.
	 * Reopen recreates the tab; the file snapshot is not carried over
	 * (honest divergence).
	 */
	override toUntyped(): IUntypedEditorInput {
		return buildReopenUntypedInput(this.getResource(), ComposerReviewChangesEditorInput.ID, true);
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (other instanceof ComposerReviewChangesEditorInput) {
			return other.agentId === this.agentId && other.scope === this.scope;
		}
		return super.matches(other);
	}
}

/**
 * Module-level store of pre-edit ("before") file contents backing the review
 * diff's "original" side. Populated by the Review Changes pane at setInput
 * from real CheckpointService snapshots (see getReviewBeforeContents).
 * OUR wiring — Cursor's reviewChangesEditor.js internals are UNKNOWN.
 */
const reviewBeforeContents = new Map</* before-URI string */ string, /* file contents */ string>();

/**
 * Builds the "before" URI for a changed file. Deterministic: the same file
 * URI always maps to the same before-URI, so the pane and the content
 * provider agree on the store key.
 */
export function getReviewBeforeURI(fileUri: string): URI {
	let path = '/before';
	try {
		path = URI.parse(fileUri).path || '/before';
	} catch {
		// keep default
	}
	return URI.from({
		scheme: COMPOSER_CHANGES_REVIEW_SCHEME,
		path,
		query: `uri=${encodeURIComponent(fileUri)}`,
	});
}

/**
 * Registers the `composer-changes-review` text-model content provider. The
 * provider resolves "before" URIs (built by getReviewBeforeURI) to in-memory
 * models created from the genuine CheckpointService pre-edit snapshots —
 * no temp files, no fake content. Registered once from
 * composer.contribution.ts.
 */
export function registerChangesReviewContentProvider(
	textModelService: ITextModelService,
	modelService: IModelService,
): Disposable {
	const provider: ITextModelContentProvider = {
		provideTextContent(resource: URI): Promise<ITextModel | null> | null {
			const existing = modelService.getModel(resource);
			if (existing && !existing.isDisposed()) {
				return Promise.resolve(existing);
			}
			const contents = reviewBeforeContents.get(resource.toString());
			if (contents === undefined) {
				// Honest miss: no snapshot for this file (never fakes content).
				return Promise.resolve(null);
			}
			return Promise.resolve(modelService.createModel(contents, null, resource));
		}
	};
	return textModelService.registerTextModelContentProvider(COMPOSER_CHANGES_REVIEW_SCHEME, provider);
}

/** Populates the review "before" store (called by the review pane). */
function setReviewBeforeContents(before: Map<string, string>): void {
	reviewBeforeContents.clear();
	for (const [fileUri, contents] of before) {
		reviewBeforeContents.set(getReviewBeforeURI(fileUri).toString(), contents);
	}
}

/** Shared row styling for the change-list rows. */
function styleChangeRow(row: HTMLElement): void {
	row.setAttribute('role', 'listitem');
	row.tabIndex = 0;
	row.style.display = 'flex';
	row.style.alignItems = 'center';
	row.style.gap = '8px';
	row.style.padding = '6px 8px';
	row.style.borderRadius = '4px';
	row.style.cursor = 'pointer';
}

function appendFileRowCells(row: HTMLElement, file: ChangedFileEntry): void {
	const uri = URI.parse(file.uri);
	const icon = document.createElement('span');
	// Fallback codicon (see file header: "plus-minus" not in this set).
	icon.className = `codicon codicon-${file.isNew ? 'diff-added' : 'diff'}`;
	row.appendChild(icon);

	const name = document.createElement('span');
	name.textContent = extUri.basename(uri);
	name.style.fontWeight = '500';
	row.appendChild(name);

	const path = document.createElement('span');
	path.textContent = uri.fsPath || file.uri;
	path.style.color = 'var(--vscode-descriptionForeground)';
	path.style.fontSize = '12px';
	path.style.overflow = 'hidden';
	path.style.textOverflow = 'ellipsis';
	path.style.whiteSpace = 'nowrap';
	row.appendChild(path);
}

/**
 * Native-DOM editor pane for the Changes tab: lists the last turn's changed
 * files (click opens the file) or an honest empty state when there is no
 * data. This is the workbench analog of Cursor's AgentChangesTabContent.
 */
export class ComposerChangesEditorPane extends EditorPane {

	static readonly ID = 'composer.changesTab';

	private _container?: HTMLElement;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IEditorService private readonly editorService: IEditorService,
	) {
		super(ComposerChangesEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		const el = document.createElement('div');
		el.classList.add('composer-changes-tab');
		el.style.padding = '16px 20px';
		el.style.overflow = 'auto';
		el.style.height = '100%';
		el.style.boxSizing = 'border-box';
		parent.appendChild(el);
		this._container = el;
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		if (input instanceof ComposerChangesEditorInput) {
			this.render(input);
		}
	}

	override clearInput(): void {
		this._container?.replaceChildren();
		super.clearInput();
	}

	private openReviewEditor(input: ComposerChangesEditorInput): void {
		const reviewInput = new ComposerReviewChangesEditorInput(
			input.agentId,
			input.scope,
			input.changedFiles,
			input.label,
		);
		void this.editorService.openEditor(reviewInput);
	}

	private render(input: ComposerChangesEditorInput): void {
		const container = this._container;
		if (!container) {
			return;
		}
		container.replaceChildren();

		const header = document.createElement('div');
		header.style.display = 'flex';
		header.style.alignItems = 'center';
		header.style.justifyContent = 'space-between';
		header.style.marginBottom = '4px';
		container.appendChild(header);

		const title = document.createElement('h2');
		title.textContent = input.getName();
		title.style.margin = '0';
		title.style.fontSize = '18px';
		title.style.fontWeight = '600';
		header.appendChild(title);

		// Verbatim UI string "Review Changes" (binary: 5 occurrences).
		const reviewButton = document.createElement('button');
		reviewButton.textContent = localize('composer.changesTab.reviewChanges', 'Review Changes');
		reviewButton.style.cursor = 'pointer';
		reviewButton.addEventListener('click', () => this.openReviewEditor(input));
		header.appendChild(reviewButton);

		const subtitle = document.createElement('div');
		const labelPart = input.label ? `${input.label} · ` : '';
		subtitle.textContent = localize(
			'composer.changesTab.subtitle',
			'{0}Last turn · {1} file(s)',
			labelPart,
			input.changedFiles.length
		);
		subtitle.style.marginBottom = '12px';
		subtitle.style.color = 'var(--vscode-descriptionForeground)';
		container.appendChild(subtitle);

		if (!input.changedFiles.length) {
			// Honest empty state: no fake data.
			const empty = document.createElement('div');
			empty.textContent = localize('composer.changesTab.empty', 'No changes from the last turn.');
			empty.style.marginTop = '24px';
			empty.style.fontSize = '13px';
			container.appendChild(empty);

			const hint = document.createElement('div');
			hint.textContent = localize(
				'composer.changesTab.emptyHint',
				'The agent\u2019s last turn made no file changes, or no turn data is available yet.'
			);
			hint.style.marginTop = '6px';
			hint.style.fontSize = '12px';
			hint.style.color = 'var(--vscode-descriptionForeground)';
			container.appendChild(hint);
			return;
		}

		const list = document.createElement('div');
		list.setAttribute('role', 'list');
		for (const file of input.changedFiles) {
			const uri = URI.parse(file.uri);
			const row = document.createElement('div');
			styleChangeRow(row);
			appendFileRowCells(row, file);
			row.title = file.uri;

			const open = () => {
				void this.editorService.openEditor({ resource: uri });
			};
			row.addEventListener('click', open);
			row.addEventListener('keydown', (e) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					open();
				}
			});

			// Honor the optional filePath arg: highlight and reveal it.
			if (input.selectedFilePath && (file.uri === input.selectedFilePath || file.uri.endsWith(input.selectedFilePath))) {
				row.style.background = 'var(--vscode-list-activeSelectionBackground)';
				row.style.color = 'var(--vscode-list-activeSelectionForeground)';
				row.scrollIntoView({ block: 'nearest' });
			}

			list.appendChild(row);
		}
		container.appendChild(list);
	}
}

/**
 * Native-DOM editor pane for the Review Changes tab (workbench analog of
 * Cursor's binary `reviewChangesEditor.js`; identity carried by
 * ComposerReviewChangesEditorInput, analog of `reviewChangesTabIdentity.js`).
 * Lists the last turn's changed files; activating a row opens a real diff
 * editor: "before" = the genuine CheckpointService pre-edit snapshot,
 * "after" = the live file. Newly created files open directly (no "before").
 * Cursor's review-editor internals are UNKNOWN — this surface and its wiring
 * are ours, built only from the verified data we have.
 */
export class ComposerReviewChangesEditorPane extends EditorPane {

	static readonly ID = 'composer.reviewChangesTab';

	private _container?: HTMLElement;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IEditorService private readonly editorService: IEditorService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super(ComposerReviewChangesEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		const el = document.createElement('div');
		el.classList.add('composer-review-changes-tab');
		el.style.padding = '16px 20px';
		el.style.overflow = 'auto';
		el.style.height = '100%';
		el.style.boxSizing = 'border-box';
		parent.appendChild(el);
		this._container = el;
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		if (input instanceof ComposerReviewChangesEditorInput) {
			// Populate the "before" store from real checkpoint snapshots.
			// IComposerDataService may not be registered yet — then the store
			// stays empty and the pane shows the honest empty state.
			try {
				const before = this.instantiationService.invokeFunction(getReviewBeforeContents);
				setReviewBeforeContents(before);
			} catch {
				setReviewBeforeContents(new Map());
			}
			this.render(input);
		}
	}

	override clearInput(): void {
		this._container?.replaceChildren();
		super.clearInput();
	}

	private openFileDiff(file: ChangedFileEntry): void {
		const fileUri = URI.parse(file.uri);
		if (file.isNew || !reviewBeforeContents.has(getReviewBeforeURI(file.uri).toString())) {
			// New file, or no pre-edit snapshot: open the file itself.
			void this.editorService.openEditor({ resource: fileUri });
			return;
		}
		const diffInput: IResourceDiffEditorInput = {
			original: { resource: getReviewBeforeURI(file.uri) },
			modified: { resource: fileUri },
		};
		void this.editorService.openEditor(diffInput, { pinned: true });
	}

	private render(input: ComposerReviewChangesEditorInput): void {
		const container = this._container;
		if (!container) {
			return;
		}
		container.replaceChildren();

		const title = document.createElement('h2');
		title.textContent = input.getName();
		title.style.margin = '0 0 4px 0';
		title.style.fontSize = '18px';
		title.style.fontWeight = '600';
		container.appendChild(title);

		const subtitle = document.createElement('div');
		const labelPart = input.label ? `${input.label} · ` : '';
		subtitle.textContent = localize(
			'composer.reviewChangesTab.subtitle',
			'{0}Last turn · {1} file(s) · select a file to review its diff',
			labelPart,
			input.changedFiles.length
		);
		subtitle.style.marginBottom = '12px';
		subtitle.style.color = 'var(--vscode-descriptionForeground)';
		container.appendChild(subtitle);

		if (!input.changedFiles.length) {
			const empty = document.createElement('div');
			empty.textContent = localize('composer.reviewChangesTab.empty', 'Nothing to review — the last turn made no file changes.');
			empty.style.marginTop = '24px';
			empty.style.fontSize = '13px';
			container.appendChild(empty);
			return;
		}

		const list = document.createElement('div');
		list.setAttribute('role', 'list');
		for (const file of input.changedFiles) {
			const row = document.createElement('div');
			styleChangeRow(row);
			appendFileRowCells(row, file);
			const hasBefore = reviewBeforeContents.has(getReviewBeforeURI(file.uri).toString());
			row.title = file.isNew
				? localize('composer.reviewChangesTab.newFile', 'New file — opens directly (no previous version)')
				: hasBefore
					? localize('composer.reviewChangesTab.openDiff', 'Open diff: before (last turn start) vs now')
					: localize('composer.reviewChangesTab.noSnapshot', 'No pre-edit snapshot — opens the file directly');

			const badge = document.createElement('span');
			badge.textContent = file.isNew
				? localize('composer.reviewChangesTab.badgeNew', 'new')
				: localize('composer.reviewChangesTab.badgeModified', 'modified');
			badge.style.marginLeft = 'auto';
			badge.style.fontSize = '11px';
			badge.style.color = 'var(--vscode-descriptionForeground)';
			row.appendChild(badge);

			const open = () => this.openFileDiff(file);
			row.addEventListener('click', open);
			row.addEventListener('keydown', (e) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					open();
				}
			});
			list.appendChild(row);
		}
		container.appendChild(list);
	}
}

/**
 * Command `composer.openChangesTab` — canonical core action (repo convention
 * `ide.*` -> `composer.*`). Opens the Changes tab for the normalized
 * invocation args. The command title reuses the verbatim action label
 * "Changes" (the binary gives no separate title).
 */
export class ComposerOpenChangesTabAction extends Action2 {

	static readonly ID = 'composer.openChangesTab';

	constructor() {
		super({
			id: ComposerOpenChangesTabAction.ID,
			title: localize2('composer.openChangesTab', 'Changes'),
			category: ComposerActionCategory,
			// QA-MIGRATION-C (P2 migration-double-commands, 2026-10-20): NO `f1: true`
			// here. `registerAction2` appends one CommandPalette item for `f1: true`
			// PLUS one for each explicit `menu` entry -- the two together rendered
			// this command twice in the palette, and the unconditional `f1` row
			// defeated the `composer.changesTabEnabled` gate. The single gated menu
			// entry below is the one and only palette row for the Changes tab action.
			// Cursor gates the new-tab-model action on `showChangesAction`;
			// ours on `composer.changesTabEnabled` (config
			// `composer.changesTab.enabled`) — see ChangesTabAvailabilityPolicy.
			menu: [{
				id: MenuId.CommandPalette,
				when: ComposerContextKeys.changesTabEnabled,
			}],
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// Run-time policy guard: the palette `when` clause covers interactive
		// use; programmatic invocations (like the binary's
		// commandService.executeCommand) go through this check too.
		if (!ChangesTabAvailabilityPolicy.isAvailable(accessor.get(IConfigurationService))) {
			accessor.get(INotificationService).info(
				localize('composer.openChangesTab.disabled', 'The Changes tab is disabled (composer.changesTab.enabled).')
			);
			return;
		}
		const normalized = normalizeOpenChangesTabArgs(args[0]);
		const editorService = accessor.get(IEditorService);
		const changedFiles = getLastTurnChangedFiles(accessor);
		const input = new ComposerChangesEditorInput(
			normalized.agentId,
			normalized.scope,
			changedFiles,
			normalized.filePath,
			normalized.label,
			normalized.bcId,
			normalized.ownerAgentId,
			normalized.initialFilterScope,
		);
		await editorService.openEditor(input);
	}
}

/**
 * Verbatim Cursor new-tab-model action (binary evidence, audit run 24):
 * {id:"changes", label:"Changes", keywords:["git"], icon:"plus-minus",
 *  keybindingCommandId:`glass.${"openChangesTab"}`}.
 * Kept as data for the glass new-tab model surface; the icon id is verbatim
 * even though this codicon set has no "plus-minus" (see HONEST-DIVERGENCE),
 * and `keybindingCommandId` is the verbatim binary command id (registered by
 * the sessions contrib — see the COMMAND-ID LAYOUT note in the file header).
 */
export interface GlassNewTabActionModel {
	readonly id: string;
	readonly label: string;
	readonly keywords: readonly string[];
	readonly icon: string;
	readonly keybindingCommandId: string;
}

export const GLASS_CHANGES_TAB_ACTION: GlassNewTabActionModel = {
	id: 'changes',
	label: 'Changes',
	keywords: ['git'],
	icon: 'plus-minus',
	keybindingCommandId: 'glass.openChangesTab', // verbatim binary id (binary: `glass.${egl}`, egl="openChangesTab")
};

/**
 * Registers the Changes tab commands and editor panes (called from
 * composer.contribution.ts):
 * - `composer.openChangesTab` (canonical)
 * - Changes editor tab (ComposerChangesEditorInput/Pane)
 * - Review Changes editor tab (ComposerReviewChangesEditorInput/Pane)
 * The `composer-changes-review` content provider is registered separately
 * via registerChangesReviewContentProvider (needs instantiated services).
 */
export function registerChangesTabActions(): void {
	registerAction2(ComposerOpenChangesTabAction);
	Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
		EditorPaneDescriptor.create(ComposerChangesEditorPane, ComposerChangesEditorPane.ID, localize('composerChangesEditor', 'Changes')),
		[new SyncDescriptor(ComposerChangesEditorInput)]
	);
	Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
		EditorPaneDescriptor.create(ComposerReviewChangesEditorPane, ComposerReviewChangesEditorPane.ID, localize('composerReviewChangesEditor', 'Review Changes')),
		[new SyncDescriptor(ComposerReviewChangesEditorInput)]
	);
}
