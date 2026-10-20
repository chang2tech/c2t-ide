/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * IDE-CODE (DEV-GAPS-109, cursor-commands): workbench-core Action2 pair
 * for Cursor's `workbench.action.newProjectCursorCommand` /
 * `workbench.action.newUserCursorCommand`.
 *
 * Cursor evidence — self-verified 2026-10-20 on the reference binary
 * (QA 2-step rule, step 1), Cursor 3.25.9
 * `out/vs/workbench/workbench.desktop.main.js`:
 * - Shared helper `async function IMm` @34619208 (full flow spec in
 *   common/newCursorCommand.ts); project class @34620186:
 *   `{id:"workbench.action.newProjectCursorCommand",
 *     title:{value:k(7705,null),original:"New Project Cursor Command"},
 *     category:Yn.File, f1:!0}`, run → `IMm(!1, accessor)`;
 *   user class @34620395: title k(7706) "New User Cursor Command",
 *   category File, `f1:!0`, run → `IMm(!0, accessor)`.
 * - No when-clause, keybinding or menu contribution exists for either id
 *   in the binary — none is invented here.
 * - The strings' nls module is
 *   `vs/workbench/contrib/mdceditor/browser/mdceditor.contribution` —
 *   Cursor registers these in workbench core. This fork has no mdceditor
 *   contrib, so the actions live in contrib/composer (the fork's
 *   Cursor-parity home) at the same workbench-core layer.
 *
 * The services below are the fork equivalents of the binary's IMm
 * accessor lookups, in the binary's own order of use: fileService,
 * workspaceContextService, quickInputService, editorService, pathService.
 * (The binary also reads environmentService.isGlass + commandService for
 * its glass branch; the fork has no glass surface and no
 * `glass.openFileInStableTab` command — 0 hits in the tree — so only the
 * binary's non-glass branch, `editorService.openEditor({ resource })`,
 * is implemented. See common/newCursorCommand.ts.)
 *
 * Files created here land in the directories the ide-agent
 * SlashCommandService already watches (the workspace and personal
 * `.cursor/commands` dirs, for .md/.txt files), so a new command is
 * usable via `/<name>` in chat immediately — exactly what the created
 * file's template line promises.
 */

import { localize, localize2 } from '../../../../nls.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { URI } from '../../../../base/common/uri.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import {
	INewCursorCommandEnv,
	INewCursorCommandPathLike,
	NEW_PROJECT_CURSOR_COMMAND_ID,
	NEW_USER_CURSOR_COMMAND_ID,
	runNewCursorCommand,
} from '../common/newCursorCommand.js';

/**
 * fsPath join built on URI.joinPath (browser-safe; the binary likewise
 * resolves every path with joinPath on URIs).
 */
const uriPathJoin: INewCursorCommandPathLike = {
	join: (...parts: string[]) => URI.joinPath(URI.file(parts[0]), ...parts.slice(1)).fsPath,
};

/** Shared run body of both actions — the binary's `IMm(isUser, accessor)`. */
async function createNewCursorCommand(accessor: ServicesAccessor, isUser: boolean): Promise<void> {
	const fileService = accessor.get(IFileService);
	const workspaceContextService = accessor.get(IWorkspaceContextService);
	const quickInputService = accessor.get(IQuickInputService);
	const editorService = accessor.get(IEditorService);
	const pathService = accessor.get(IPathService);

	const workspace = workspaceContextService.getWorkspace();
	const env: INewCursorCommandEnv = {
		// Binary: pathService.userHome({ preferLocal: true }).
		userHome: (await pathService.userHome({ preferLocal: true })).fsPath,
		workspaceFolderFsPath: workspace.folders.length ? workspace.folders[0].uri.fsPath : undefined,
		fileExists: fsPath => fileService.exists(URI.file(fsPath)),
		ensureFolder: async fsPath => { await fileService.createFolder(URI.file(fsPath)); },
		writeFileUtf8: async (fsPath, content) => { await fileService.writeFile(URI.file(fsPath), VSBuffer.fromString(content)); },
		promptForName: validate => quickInputService.input({
			// Verbatim binary strings (nls 7699/7700/7701; the constants in
			// common/newCursorCommand.ts carry the same values for tests).
			title: localize('newCommandName', "Enter Command Name"),
			placeHolder: localize('commandNamePlaceholder', "e.g., my-custom-command"),
			prompt: localize('commandNamePrompt', "Please enter a name for the new command"),
			validateInput: async value => validate(value),
		}),
		// Binary non-glass branch: editorService.openEditor({ resource }) — not pinned.
		openFile: async fsPath => { await editorService.openEditor({ resource: URI.file(fsPath) }); },
	};

	await runNewCursorCommand(env, isUser, uriPathJoin);
}

export class NewProjectCursorCommandAction extends Action2 {
	static readonly ID = NEW_PROJECT_CURSOR_COMMAND_ID;

	constructor() {
		super({
			id: NewProjectCursorCommandAction.ID,
			// Verbatim binary title (nls 7705).
			title: localize2('newProjectCursorCommand', "New Project Cursor Command"),
			category: Categories.File,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		// Binary: IMm(!1, accessor) — project command.
		await createNewCursorCommand(accessor, false);
	}
}

export class NewUserCursorCommandAction extends Action2 {
	static readonly ID = NEW_USER_CURSOR_COMMAND_ID;

	constructor() {
		super({
			id: NewUserCursorCommandAction.ID,
			// Verbatim binary title (nls 7706).
			title: localize2('newUserCursorCommand', "New User Cursor Command"),
			category: Categories.File,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		// Binary: IMm(!0, accessor) — user command.
		await createNewCursorCommand(accessor, true);
	}
}

/** Registers both creation commands (called from composer.contribution.ts). */
export function registerNewCursorCommandActions(): void {
	registerAction2(NewProjectCursorCommandAction);
	registerAction2(NewUserCursorCommandAction);
}
