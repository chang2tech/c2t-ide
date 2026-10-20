/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Project-rules service DI contract (node-free).
//
// Layer split (P0 node-free common/): the `ProjectRulesService`
// implementation resolves paths with node:path, so it lives in
// `electron-browser/projectRulesService.ts` (desktop-only). This module keeps
// the node-free contract — the `IProjectRulesService` decorator and the
// service interface — so common/ and browser/ code can depend on project
// rules without pulling node builtins into the web bundle.

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import {
	ParsedRule,
	RulesBlock,
} from './projectRules.js';

export const IProjectRulesService = createDecorator<IProjectRulesService>('composerProjectRulesService');

/** Minimal output-channel surface the rules service needs (was vscode.OutputChannel). */
export interface IComposerOutputChannel {
	append(value: string): void;
	appendLine(value: string): void;
}

/**
 * Cursor-style .mdc project rules for the agent chat.
 *
 * Parity spec: docs/rea/parity-rules-mcp.md §A.
 *
 * - Discovers `**\/.cursor/rules/**\/*.mdc` in every workspace folder (nested
 *   .cursor/rules dirs supported for monorepos).
 * - Watches for changes and refreshes live.
 * - On every agent-chat submit, buildInjection() produces the rules block
 *   that is merged into the prompt. (UNKNOWN: the names onBeforeSubmitChat /
 *   writeRulesEntry were presented as Cursor's — no REA evidence.)
 *   merged into the agent request.
 *
 * SCOPE (parity spec §A6): rules apply to Agent Chat ONLY. They are NOT
 * applied to the Cmd+K inline prompt and do NOT affect Tab completion.
 * This service is only ever consulted from ComposerDataService (agent chat);
 * no other submit path exists.
 */
export interface IProjectRulesService {
	readonly _serviceBrand: undefined;

	/** Fires whenever the discovered rule set changes. */
	readonly onDidChangeRules: Event<void>;

	/** (Re)discover all .mdc rules in every workspace folder. */
	refresh(): Promise<void>;

	/** Start file watchers (call once at wiring time). */
	startWatching(): void;

	/** All discovered rules (a copy). */
	getRules(): ParsedRule[];

	/** Look up a single rule by file name or stem (case-insensitive). */
	getRuleByName(name: string): ParsedRule | undefined;

	/** Rules whose globs match the given workspace-relative file paths. */
	getRulesForFiles(relPaths: string[]): ParsedRule[];

	/** Workspace-relative paths forming the current context for auto-attach. */
	getContextFiles(prompt: string): string[];

	/** Builds the rules block merged into the prompt on every agent-chat submit.
	 *  (UNKNOWN: "writeRulesEntry" was presented as Cursor's name — no evidence.) */
	buildInjection(prompt: string, mode?: string): RulesBlock;

	dispose(): void;
}
