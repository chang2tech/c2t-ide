/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * IDE-CODE (W69D, rules-create-from-selection): Cursor's 'Create Rule'
 * editor command, id `cursor.createRuleFromSelection`.
 *
 * Cursor evidence — self-verified 2026-10-20 on the reference binaries
 * (QA 2-step rule, step 1). Workbench bundle
 * `out/vs/workbench/workbench.desktop.main.js`:
 * - 3.25.9: EditorCommand class at byte 24829565 —
 *   { id: "cursor.createRuleFromSelection",
 *     title: { value: "Create Rule", original: "Create Rule" },
 *     precondition: hasNonEmptySelection,
 *     menu: [{ id: EditorContext, group: "navigation", order: 20 }],
 *     metadata: { description: "Create a cursor rule from the highlighted text" } };
 *   run body at byte 24830470; id also listed under the `editor_ai_actions`
 *   category at byte 32084375.
 * - 3.25.6: identical ('Created manual rule' at byte 24824677, id at 24825077).
 *
 * WHY CORE + EditorAction: Cursor registers this as an EditorCommand in its
 * workbench core (runEditorCommand receives the focused code editor), and
 * its rule service (createRule/getRuleUri) also lives in the workbench
 * bundle — so the fork does the same here, next to the other editor-context
 * AI actions in contrib/composer. The pure slug/uniqueness/content logic is
 * in common/createRuleFromSelection.ts; the rule-service createRule port
 * ({@link createRule}) is below.
 *
 * This replaces the DEV-GAPS-74 Action2 version, which diverged from the
 * binary in the slug algorithm (invented diacritic stripping, 50-char cap),
 * the collision suffix (started at -2; binary starts at -1), the file
 * content (empty frontmatter; binary writes `alwaysApply: true`), the
 * warn/error strings (invented; binary strings are in the common module),
 * and the toast action (wrong id, no tooltip, not pinned).
 */

import { localize, localize2 } from '../../../../nls.js';
import { Action } from '../../../../base/common/actions.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { extUri } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { EditorAction, registerEditorAction } from '../../../../editor/browser/editorExtensions.js';
import type { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { EditorContextKeys } from '../../../../editor/common/editorContextKeys.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IProjectRulesService } from '../common/projectRulesService.js';
import {
	CREATE_RULE_FROM_SELECTION_ID,
	NO_WORKSPACE_FOLDER_ERROR,
	OPEN_CREATED_RULE_ACTION_ID,
	RULE_FILE_EXTENSION,
	WARN_EMPTY_SELECTION,
	WARN_NO_MODEL,
	WARN_NO_SELECTION,
	WARN_NO_WORKSPACE_FOLDER,
	buildRuleFileContent,
	createdRuleToastMessage,
	deriveRuleSlug,
	failedToCreateRuleMessage,
	uniqueRuleSlug,
} from '../common/createRuleFromSelection.js';

/**
 * Port of the binary's rule-service getRuleTargetDirectory(isUser=false)
 * + getRuleUri (3.25.9 bytes 31043881/31044197 region): project rules live
 * in the FIRST workspace folder's `.cursor/rules` directory.
 */
function getProjectRuleUri(accessor: ServicesAccessor, slug: string): URI {
	const workspace = accessor.get(IWorkspaceContextService).getWorkspace();
	if (!workspace.folders.length) {
		throw new Error(NO_WORKSPACE_FOLDER_ERROR);
	}
	return URI.joinPath(workspace.folders[0].uri, '.cursor', 'rules', `${slug}${RULE_FILE_EXTENSION}`);
}

/**
 * Port of the binary's rule-service createRule(name, body, isUser=false)
 * (3.25.9 byte 31044289): ensures `.cursor/rules` exists (createFolder only
 * when missing), writes `<name>.mdc` with the frontmatter built by
 * {@link buildRuleFileContent}, refreshes the rules service, returns the URI.
 */
async function createRule(accessor: ServicesAccessor, slug: string, body: string): Promise<URI> {
	const fileService = accessor.get(IFileService);
	const uri = getProjectRuleUri(accessor, slug);
	const dir = URI.joinPath(uri, '..');
	if (!await fileService.exists(dir)) {
		await fileService.createFolder(dir);
	}
	await fileService.writeFile(uri, VSBuffer.fromString(buildRuleFileContent(body)));
	// Binary: createRule ends with `await this.refresh()`. The fork's rules
	// service is registered on desktop only; on other layers its file
	// watcher picks the new file up, so a missing service is not an error.
	try {
		await accessor.get(IProjectRulesService).refresh();
	} catch {
		// IProjectRulesService not registered in this layer — see note above.
	}
	return uri;
}

export class CreateRuleFromSelectionAction extends EditorAction {
	static readonly ID = CREATE_RULE_FROM_SELECTION_ID;

	constructor() {
		super({
			id: CreateRuleFromSelectionAction.ID,
			label: localize2('createRule.action', "Create Rule"),
			// Binary: precondition hasNonEmptySelection; the EditorContext
			// menu entry (group 'navigation', order 20) inherits it as its
			// when-clause via EditorAction's contextMenuOpts handling.
			precondition: EditorContextKeys.hasNonEmptySelection,
			contextMenuOpts: { group: 'navigation', order: 20 },
			metadata: {
				description: localize('createRule.description', "Create a cursor rule from the highlighted text"),
			},
		});
	}

	async run(accessor: ServicesAccessor, editor: ICodeEditor): Promise<void> {
		const notificationService = accessor.get(INotificationService);
		const workspaceContextService = accessor.get(IWorkspaceContextService);
		const fileService = accessor.get(IFileService);
		const editorService = accessor.get(IEditorService);

		// Binary run body (3.25.9 byte 24830470), step for step.
		const model = editor.getModel();
		if (!model) {
			notificationService.warn(WARN_NO_MODEL);
			return;
		}
		const selection = editor.getSelection();
		if (!selection || selection.isEmpty()) {
			notificationService.warn(WARN_NO_SELECTION);
			return;
		}
		const text = model.getValueInRange(selection).trim();
		if (text.length === 0) {
			notificationService.warn(WARN_EMPTY_SELECTION);
			return;
		}
		if (!workspaceContextService.getWorkspaceFolder(model.uri)) {
			notificationService.warn(WARN_NO_WORKSPACE_FOLDER);
			return;
		}

		// Binary: ctx.asRelativePath(model.uri). The fork's
		// IWorkspaceContextService has no asRelativePath; the established
		// fork equivalent (see common/addToChat.ts) is extUri.relativePath
		// against the containing folder — same result.
		const containingFolder = workspaceContextService.getWorkspaceFolder(model.uri)!;
		const relativePath = extUri.relativePath(containingFolder.uri, model.uri) ?? undefined;
		const slug = await uniqueRuleSlug(
			deriveRuleSlug(text, relativePath),
			async candidate => fileService.exists(getProjectRuleUri(accessor, candidate)),
		);

		try {
			const ruleUri = await createRule(accessor, slug, text);
			const openRuleAction = new Action(
				OPEN_CREATED_RULE_ACTION_ID,
				localize('createRule.openRule', "Open Rule"),
				undefined,
				true,
				async () => {
					await editorService.openEditor({ resource: ruleUri, options: { pinned: true } });
				},
			);
			// Binary action descriptor also carries tooltip "Open the
			// generated rule file"; VS Code's Action exposes it as a property.
			openRuleAction.tooltip = localize('createRule.openRuleTooltip', "Open the generated rule file");
			notificationService.notify({
				severity: Severity.Info,
				message: createdRuleToastMessage(slug),
				actions: { primary: [openRuleAction] },
			});
		} catch (error) {
			notificationService.error(failedToCreateRuleMessage(error));
		}
	}
}

export function registerCreateRuleAction(): void {
	registerEditorAction(CreateRuleFromSelectionAction);
}
