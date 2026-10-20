/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Slash-command service DI contract (node-free).
//
// Layer split (P0 node-free common/): the `SlashCommandService` implementation
// scans the filesystem for custom commands/skills (node:fs, node:os,
// node:path) and shells out to `git` via WorktreeService (node:child_process),
// so it lives in `electron-browser/slashCommandService.ts` (desktop-only).
// This module keeps the node-free contract — the `ISlashCommandService`
// decorator, the service interface, and the command/skill shapes — so
// common/ and browser/ code can depend on slash commands without pulling
// node builtins into the web bundle.

import { Event } from "../../../../base/common/event.js";
import { createDecorator } from "../../../../platform/instantiation/common/instantiation.js";
import {
	type SlashItem,
	type SlashItemType,
} from "./slashRegistry.js";

export interface SlashCommandDef {
	name: string;
	description: string;
	argumentHint?: string;
	source: "builtin" | "workspace" | "personal";
	keywords?: string[];
	aliases?: string[];
}

export interface CustomSlashCommand extends SlashCommandDef {
	source: "workspace" | "personal";
	filePath: string;
	content: string;
}

/** A skill surfaced as /<name> (spec §2.4). */
export interface SkillSlashItem {
	name: string;
	description: string;
	filePath: string;
	content: string;
	/** disable-model-invocation: menu-only, never auto-pulled by the model. */
	menuOnly: boolean;
}

export const ISlashCommandService = createDecorator<ISlashCommandService>('composerSlashCommandService');

/** Public surface of the slash-command service (for the composer webview host). */
export interface ISlashCommandService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeCommands: Event<void>;
	getBuiltins(): SlashCommandDef[];
	reloadCustomCommands(): Promise<void>;
	getCustomCommands(): CustomSlashCommand[];
	reloadSkills(): Promise<void>;
	getSkills(): SkillSlashItem[];
	getAll(): SlashCommandDef[];
	resolveType(name: string): SlashItemType | undefined;
	findCommand(name: string): SlashCommandDef | SkillSlashItem | undefined;
	parseLeadingCommand(text: string): { name: string; args: string; rest: string } | null;
	recordUse(name: string): void;
	serializeMru(): string;
	restoreMru(json: string | undefined): void;
	getPaletteItems(): SlashItem[];
	run(name: string, args: string): Promise<{ macro?: string }>;
	dispose(): void;
}
