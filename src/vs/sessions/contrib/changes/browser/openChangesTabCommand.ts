/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Cursor parity: `glass.openChangesTab` ("Review Changes", Ctrl+E).
 *
 * Evidence (verbatim identifiers from workbench.glass.main.js 3.25.6 via the REA
 * audit-fix-queue run 24 "workbench-open-changes-tab", and the keyboard enum doc
 * dig-deeper-keyboard-2026-10-19.md line 112):
 *   - command id `glass.openChangesTab` (from `egl="openChangesTab"`, `Uus=`glass.${egl}``)
 *   - call site `commandService.executeCommand(Uus, {scope:"lastTurn", agentId, filePath?})`
 *   - new-tab-model action `{id:"changes", label:"Changes", keywords:["git"], icon:"plus-minus", keybindingCommandId:Uus}`,
 *     shown when `showChangesAction` is true
 *   - availability policy identifiers: `changesTabAvailable`, `_isChangesTabActivatable()`,
 *     `preferChangesAsDefault`, `_panelReplacementAutoSeedPolicy`
 *   - keyboard enum 3.25.9 (live): `openChangesTab` "Review Changes" Ctrl+E
 *   - glass Ir registration 3.25.9 (workbench.glass.main.js @45508387):
 *     `Ir({id:ogl,title:"Review Changes",...,f1:!0,...})` — palette-VISIBLE
 *     (`!0` = true; DEV-GAPS-82 correction, see the action's f1 comment)
 *
 * Fork-local mappings are marked [fork-local] below. Everything Cursor does that
 * we could not observe (Open Changes Menu contents, `_panelReplacementAutoSeedPolicy`
 * semantics, Review Changes editor renderer internals beyond the observed
 * input props) is documented in-code and NOT claimed here. The
 * `_isChangesTabActivatable()` conditions and the `workbench.editor.reviewchanges`
 * input props/serialized shape were RESOLVED by a later dissection pass
 * (audit-fix-queue "Deepening closed") and are implemented below.
 */

import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { autorun, IReader } from '../../../../base/common/observable.js';
import { Schemas } from '../../../../base/common/network.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ContextKeyExpr, IContextKey, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { inQuickPickContext } from '../../../../workbench/browser/quickaccess.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { SessionsCategories } from '../../../common/categories.js';
import { ChangesTabAvailableContext } from '../../../common/contextkeys.js';
import { getSessionWorkspaceKind, ISession, SessionWorkspaceKind } from '../../../services/sessions/common/session.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { IReviewChangesProps } from '../common/sessionChangesService.js';
import { ISessionChangesService } from './sessionChangesService.js';

/** Verbatim Cursor command id (glassCommandIds.js: `Uus=`glass.${egl}``, egl="openChangesTab"). */
export const OPEN_CHANGES_TAB_COMMAND_ID = 'glass.openChangesTab';

/** Verbatim Cursor config identifier `preferChangesAsDefault`, namespaced for the fork. */
export const PREFER_CHANGES_AS_DEFAULT_SETTING = 'ide.changes.preferChangesAsDefault';

/**
 * Verbatim Cursor executeCommand args, both observed shapes:
 *   - local invocation: `{scope:"lastTurn", agentId, filePath?}`
 *   - cloud-agent renderer (`tabPersistenceService.openAgentChangesTab`):
 *     `{bcId, label, initialFilterScope:"branch", ownerAgentId}`
 * Both shapes are accepted; fields that are absent are simply unused.
 * `agentId` identifies a completed agent run; `filePath` targets one file for
 * the review-changes editor.
 */
export interface IOpenChangesTabArgs {
	readonly scope?: 'lastTurn';
	readonly agentId?: string;
	readonly filePath?: string;
	/** Cloud-agent run id (binary openAgentChangesTab arg). */
	readonly bcId?: string;
	/** Cloud-agent run label (binary openAgentChangesTab arg). */
	readonly label?: string;
	/**
	 * Filter scope for the agent-changes view (binary default "branch").
	 * UNKNOWN what other values Cursor accepts — passed through verbatim.
	 */
	readonly initialFilterScope?: string;
	/** Owner agent id (binary openAgentChangesTab arg). */
	readonly ownerAgentId?: string;
}

function asNonEmptyString(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Normalizes the raw `executeCommand` argument into {@link IOpenChangesTabArgs}.
 * Pure — unit tested. Unknown/garbage input yields `{}` (the default invocation).
 */
export function parseOpenChangesTabArgs(arg: unknown): IOpenChangesTabArgs {
	if (arg && typeof arg === 'object') {
		const a = arg as Record<string, unknown>;
		return {
			scope: a.scope === 'lastTurn' ? 'lastTurn' : undefined,
			agentId: asNonEmptyString(a.agentId),
			filePath: asNonEmptyString(a.filePath),
			bcId: asNonEmptyString(a.bcId),
			label: asNonEmptyString(a.label),
			initialFilterScope: asNonEmptyString(a.initialFilterScope),
			ownerAgentId: asNonEmptyString(a.ownerAgentId),
		};
	}
	return {};
}

// --- New-tab-model action registry (minimal, fork-local) ----------------------
//
// Cursor's new-tab model holds entries like
// `{id:"changes", label:"Changes", keywords:["git"], icon:"plus-minus",
//   keybindingCommandId:"glass.openChangesTab"}` and shows the entry when
// `showChangesAction` is true. The fork has no glass new-tab model yet, so this
// registry is kept as the fork-local data model for a future new-tab surface.
// Visibility follows Cursor: the entry is shown when `showChangesAction` is
// true — fork-locally, when the verbatim `changesTabAvailable` policy holds
// (see isNewTabModelActionShown/getVisibleNewTabModelActions).
// NOTE (honest): the current add-tab "Changes" entry (NewChangesTabAction in
// contrib/editor/browser/addTabActions.ts) opens the session Changes editor
// directly and does NOT consume this registry. `openNewTabModelAction()` is the
// entry point a future menu will call.

export interface INewTabModelAction {
	/** Verbatim Cursor entry id. */
	readonly id: string;
	/** Verbatim Cursor entry label. */
	readonly label: string;
	/** Verbatim Cursor entry keywords. */
	readonly keywords: readonly string[];
	/**
	 * Cursor uses the icon name "plus-minus"; the fork's codicon set has no such
	 * icon (verified: only `plus` exists in codiconsLibrary.ts), so this maps
	 * fork-local to Codicon.diffMultiple — the fork's Changes-tab icon.
	 */
	readonly icon: ThemeIcon;
	/** Verbatim Cursor: the command the entry invokes. */
	readonly keybindingCommandId: string;
}

const _newTabModelActions = new Map<string, INewTabModelAction>();

export function registerNewTabModelAction(action: INewTabModelAction): void {
	_newTabModelActions.set(action.id, action);
}

export function getNewTabModelAction(id: string): INewTabModelAction | undefined {
	return _newTabModelActions.get(id);
}

export const CHANGES_NEW_TAB_MODEL_ACTION_ID = 'changes';

registerNewTabModelAction({
	id: CHANGES_NEW_TAB_MODEL_ACTION_ID,
	label: 'Changes',
	keywords: ['git'],
	icon: Codicon.diffMultiple,
	keybindingCommandId: OPEN_CHANGES_TAB_COMMAND_ID,
});

export async function openNewTabModelAction(accessor: ServicesAccessor, id: string, args?: IOpenChangesTabArgs): Promise<void> {
	const entry = getNewTabModelAction(id);
	if (!entry) {
		accessor.get(ILogService).warn(`[openChangesTab] unknown new-tab-model action '${id}'`);
		return;
	}
	// Run-time `showChangesAction`-style gate: the new-tab surface only shows
	// the entry when it is available; programmatic invocations (like the
	// binary's commandService.executeCommand) go through this check too.
	if (!isNewTabModelActionShown(id, accessor.get(IContextKeyService))) {
		accessor.get(ILogService).warn(`[openChangesTab] new-tab-model action '${id}' is not shown (changesTabAvailable is false)`);
		return;
	}
	await accessor.get(ICommandService).executeCommand(entry.keybindingCommandId, args ?? {});
}

/**
 * `showChangesAction`-style gate for the new-tab-model action registry.
 *
 * Cursor shows its new-tab-model "changes" action when `showChangesAction` is
 * true. The fork has no glass new-tab model yet, so the fork-local equivalent
 * of `showChangesAction` is the verbatim availability policy
 * `changesTabAvailable` ({@link ChangesTabAvailableContext}), set by
 * {@link ChangesTabAvailabilityContribution} from `_isChangesTabActivatable()`.
 */
export function isNewTabModelActionShown(id: string, contextKeyService: IContextKeyService): boolean {
	if (!getNewTabModelAction(id)) {
		return false;
	}
	return contextKeyService.getContextKeyValue<boolean>(ChangesTabAvailableContext.key) ?? false;
}

/** The new-tab-model actions currently shown (i.e. passing the `showChangesAction`-style gate). */
export function getVisibleNewTabModelActions(contextKeyService: IContextKeyService): INewTabModelAction[] {
	const result: INewTabModelAction[] = [];
	for (const action of _newTabModelActions.values()) {
		if (isNewTabModelActionShown(action.id, contextKeyService)) {
			result.push(action);
		}
	}
	return result;
}

// --- `glass.openChangesTab` ---------------------------------------------------

/**
 * Opens the Changes surface for an agent run.
 *
 * Routing (binary-verified arg shapes):
 * - `scope: "lastTurn"` + `agentId` (or the cloud-shape `bcId`/`ownerAgentId`)
 *   → the agent-changes view for that agent run.
 *   [fork-local] The fork has no per-turn changeset granularity; this opens
 *   the session's Changes editor (branch-scoped diffs, matching Cursor's
 *   `initialFilterScope:"branch"` default). Cursor's exact last-turn filtering
 *   is UNKNOWN. `label` is accepted for arg-shape parity; the fork's editor
 *   titles itself from the session, so the label has no fork surface and is
 *   not faked onto the UI.
 * - `filePath` → the review-changes editor for one file
 *   (`SessionReviewChangesEditorInput`, the `workbench.editor.reviewchanges`
 *   analog; `scrollToFile` carries the file, revealed via the multi-diff
 *   source resolver). Cursor's reviewChangesEditor.js renderer internals are
 *   UNKNOWN.
 * - no args → "View Uncommitted Changes" (the session's uncommitted diff).
 */
export async function openChangesTab(accessor: ServicesAccessor, args: IOpenChangesTabArgs): Promise<void> {
	const sessionsService = accessor.get(ISessionsService);
	const sessionsManagementService = accessor.get(ISessionsManagementService);
	const sessionChangesService = accessor.get(ISessionChangesService);
	const configurationService = accessor.get(IConfigurationService);
	const notificationService = accessor.get(INotificationService);
	const logService = accessor.get(ILogService);

	// `preferChangesAsDefault` (binary-observed policy name; exact Cursor
	// semantics UNKNOWN): fork-local meaning — when the command is invoked
	// with NO args (the "default" invocation), the Changes editor is the
	// default surface only while the setting is true. When false, the
	// default invocation does not auto-open Changes; explicit invocations
	// (scope/agentId/filePath/bcId/…) are unaffected.
	const hasArgs = args.scope !== undefined || args.agentId !== undefined || args.filePath !== undefined
		|| args.bcId !== undefined || args.label !== undefined || args.initialFilterScope !== undefined
		|| args.ownerAgentId !== undefined;
	if (!hasArgs && configurationService.getValue<boolean>(PREFER_CHANGES_AS_DEFAULT_SETTING) === false) {
		notificationService.info(localize2('openChangesTab.notDefault', "The Changes tab is not the default (ide.changes.preferChangesAsDefault).").value);
		return;
	}

	// Resolve the agent: `agentId` (local invocation) → `bcId`/`ownerAgentId`
	// (verbatim `openAgentChangesTab` cloud args) → the active session.
	const agentId = args.agentId ?? args.bcId ?? args.ownerAgentId;
	let sessionResource: URI | undefined;
	if (agentId) {
		const session = sessionsManagementService.getSessions().find(s => s.sessionId === agentId);
		if (session) {
			sessionResource = session.resource;
		} else {
			logService.warn(`[openChangesTab] no session found for agent id '${agentId}'; falling back to the active session`);
		}
	}
	sessionResource ??= sessionsService.activeSession.get()?.resource;
	if (!sessionResource) {
		logService.warn('[openChangesTab] no session available to open the Changes tab for');
		return;
	}

	if (args.filePath) {
		// → review-changes editor for one file.
		// `filePath` may be an absolute fs path or a URI string (Cursor's exact
		// shape is UNKNOWN); accept both.
		const fileUri = args.filePath.includes('://') ? URI.parse(args.filePath) : URI.file(args.filePath);
		const reviewProps: IReviewChangesProps = {
			composerId: agentId,
			scrollToFile: args.filePath,
		};
		await sessionChangesService.openReviewChangesEditor(sessionResource, reviewProps, {
			pinned: true,
			viewState: {
				revealData: { resource: { original: fileUri, modified: fileUri } },
			},
		});
		return;
	}

	// → agent-changes view for the agent run. `initialFilterScope` defaults to
	// "branch" (verbatim binary default of `openAgentChangesTab`); the fork's
	// session changes surface is branch-scoped, so no further mapping applies.
	await sessionChangesService.openChangesEditor(sessionResource, { pinned: true });
}

class OpenChangesTabAction extends Action2 {

	static readonly ID = OPEN_CHANGES_TAB_COMMAND_ID;

	constructor() {
		super({
			id: OpenChangesTabAction.ID,
			// Verbatim Cursor title (keyboard enum 3.25.9, line 112: `openChangesTab` "Review Changes" Ctrl+E).
			title: localize2('openChangesTab', "Review Changes"),
			category: SessionsCategories.Sessions,
			// DEV-GAPS-82 CORRECTION (2026-10-20, supersedes the QA-MIGRATION-C
			// palette-hiding below): the Cursor 3.25.9 binary registers this
			// command PALETTE-VISIBLE — workbench.glass.main.js @45508387:
			// `Ir({id:ogl,title:"Review Changes",icon:"plus-minus",
			// glassCategory:"View",keywords:["changes","diff","review","panel",
			// "tab"],f1:!0,scope:wl.AGENT_WORKSPACE,keybindingCategory:Sa.DIFF,
			// keybinding:[{weight:gp,primary:dt.CtrlCmd|Xe.KeyE,...}]})`
			// (`ogl="openChangesTab"`, id = `glass.${ogl}`). In minified JS
			// `f1:!0` is `f1: true`. The earlier false value came from the
			// QA-MIGRATION-C dedupe decision (hide this row because the fork's
			// canonical `composer.openChangesTab` already adds a gated
			// CommandPalette menu row titled "Changes"); that dedupe hid a
			// command the binary shows. Kept divergence, flagged: the palette
			// now shows BOTH the binary-verbatim "Review Changes" row (this
			// command, Sessions category) and the fork-canonical gated
			// "Changes" row (`composer.openChangesTab`, Composer category) —
			// distinct ids/titles/categories; removing the fork row is a
			// separate migration decision, not an f1 correction.
			f1: true,
			precondition: ChangesTabAvailableContext,
			keybinding: {
				weight: KeybindingWeight.SessionsContrib,
				// `workbench.action.quickOpenNavigateNextInFilePicker` owns a secondary
				// CtrlCmd+E binding inside quick pick at a lower weight; keep ours out
				// of quick pick so quick-access navigation keeps working.
				when: ContextKeyExpr.and(ChangesTabAvailableContext, inQuickPickContext.negate()),
				primary: KeyMod.CtrlCmd | KeyCode.KeyE, // ⌘E on mac
			},
		});
	}

	override async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		await openChangesTab(accessor, parseOpenChangesTabArgs(args[0]));
	}
}
registerAction2(OpenChangesTabAction);

// --- Availability policy ------------------------------------------------------
//
// Cursor evidence (RESOLVED, audit-fix-queue "Deepening closed",
// workbench.glass.main.js 3.25.6): `_isChangesTabActivatable()` returns true
// with no current agent id; else `!bA(env)` where
// `bA(t)=typeof t?.id=="string"&&!Kl(t)&&!Eh(t)` (Kl = local folder workspace
// w/ uri; Eh = configPath env) → Changes tab NOT activatable for
// remote-environment agents; activatable for local/no-agent.
// `_panelReplacementAutoSeedPolicy` semantics are UNKNOWN and not implemented.

/**
 * Binary `bA(t)` predicate: true when the session's environment is a
 * *remote* environment agent host. Fork-local mapping:
 *   - `typeof t?.id=="string"` ⟺ `ISession.environment` is a non-empty string
 *     (always true in the fork: "local", "cloud", or a remote host identifier).
 *   - `Kl(t)` (local folder workspace w/ uri) ⟺ `environment === 'local'` or
 *     the session workspace is a folder/worktree with a `file:` URI.
 *   - `Eh(t)` (configPath env) ⟺ no fork equivalent — the fork's environments
 *     are "local", "cloud", or a remote host identifier, so this is always
 *     false here (documented, not faked).
 *
 * Note: `environment === 'cloud'` is NOT a local folder workspace, so cloud
 * sessions are not activatable through this policy — matching the binary,
 * where cloud-agent runs get their changes surface through
 * `tabPersistenceService.openAgentChangesTab` (a separate renderer), not the
 * new-tab "changes" action.
 */
export function isRemoteEnvironmentSession(session: ISession): boolean {
	const envId = session.environment;
	if (typeof envId !== 'string' || envId.length === 0) {
		return false;
	}
	if (isLocalFolderWorkspaceWithUri(session)) {
		return false;
	}
	return true;
}

function isLocalFolderWorkspaceWithUri(session: ISession): boolean {
	if (session.environment === 'local') {
		return true;
	}
	const workspace = session.workspace.get();
	if (!workspace) {
		return false;
	}
	const kind = getSessionWorkspaceKind(workspace, session.worktreePending?.get() ?? false);
	return (kind === SessionWorkspaceKind.Folder || kind === SessionWorkspaceKind.Worktree)
		&& workspace.uri.scheme === Schemas.file;
}

class ChangesTabAvailabilityContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.sessions.changesTabAvailability';

	private readonly _changesTabAvailable: IContextKey<boolean>;

	constructor(
		@IContextKeyService contextKeyService: IContextKeyService,
		@ISessionsService private readonly _sessionsService: ISessionsService,
	) {
		super();

		this._changesTabAvailable = ChangesTabAvailableContext.bindTo(contextKeyService);

		this._register(autorun(reader => {
			this._changesTabAvailable.set(this._isChangesTabActivatable(reader));
		}));
	}

	/**
	 * Verbatim Cursor `_isChangesTabActivatable()` semantics (RESOLVED):
	 * true with no current agent id; else false for remote-environment agents.
	 */
	private _isChangesTabActivatable(reader: IReader): boolean {
		const activeSession = this._sessionsService.activeSession.read(reader);
		if (!activeSession) {
			return true;
		}
		return !isRemoteEnvironmentSession(activeSession);
	}
}
registerWorkbenchContribution2(ChangesTabAvailabilityContribution.ID, ChangesTabAvailabilityContribution, WorkbenchPhase.AfterRestored);
