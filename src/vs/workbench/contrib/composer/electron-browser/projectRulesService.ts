/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Migrated from extensions/ide-agent/src/services/projectRulesService.ts (CAT-B, vscode→DI)
//
// vscode API → core mapping used here (per docs/rea/ext-api-audit-2026-10-19.md §3):
//   workspace.workspaceFolders              → IWorkspaceContextService.getWorkspace().folders
//   workspace.findFiles(RelativePattern)    → ISearchService.fileSearch
//                                             ({ type: QueryType.File, folderQueries, filePattern })
//   workspace.fs.readFile                   → IFileService.readFile (IFileContent.value)
//   workspace.createFileSystemWatcher       → IFileService.createWatcher + onDidFilesChange
//                                             filtering (core's IFileSystemWatcher has a single
//                                             onDidChange — create/change/delete all refresh)
//   window.activeTextEditor                 → IEditorService.activeTextEditorControl (+ isCodeEditor)
//   workspace.getWorkspaceFolder            → IWorkspaceContextService.getWorkspaceFolder
//   window.createOutputChannel              → IOutputService (channel registry; see below)
//   vscode.EventEmitter                     → Emitter (vs/base/common/event)
//   vscode.Disposable                       → Disposable (vs/base/common/lifecycle)
//   vscode.ExtensionContext (startWatching) → DROPPED: the service now extends Disposable and
//                                             owns its watchers via _register; no host context
//                                             is needed.
//
// Output channel: the original took an optional `vscode.OutputChannel` ctor
// param. The migrated service resolves the shared "IDE Agent" channel through
// IOutputService (getChannel('ide-agent')) and falls back to the console until
// the channel is registered by the composer workbench contribution.
//
// PARITY EVIDENCE STATUS (rule: ~/AGENTS.md "KHÔNG BỊA ĐẶT", 2026-10-19):
//   VERIFIED (official docs, https://cursor.com/docs/context/rules): project
//     rules live in .cursor/rules as .mdc files (version-controlled) with
//     frontmatter description/globs/alwaysApply; rule contents are included
//     in the model context. The .mdc discovery format in this file matches
//     that documented format.
//   UNKNOWN: injection timing and every internal identifier presented as
//     Cursor's (writeRulesEntry, onBeforeSubmitChat, getRulesForFiles) have
//     NO binary/docs evidence — marked UNKNOWN inline. Do not treat them as
//     verified Cursor internals.

import * as path from 'node:path';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../base/common/event.js';
import { extUri } from '../../../../base/common/resources.js';
import { match as globMatch } from '../../../../base/common/glob.js';
import { URI } from '../../../../base/common/uri.js';
import { ICodeEditor, isCodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService, IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';
import { IOutputService } from '../../../../workbench/services/output/common/output.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { ISearchService, QueryType } from '../../../../workbench/services/search/common/search.js';
import {
	ParsedRule,
	RulesBlock,
	buildRulesBlock,
	getRulesForFiles,
	normalizeRelPath,
	parseMdcFile,
	ruleAppliesToEnv,
	CURRENT_ENVIRONMENT,
} from '../common/projectRules.js';

import {
	IProjectRulesService,
	IComposerOutputChannel,
} from "../common/projectRulesService.js";

const RULES_GLOB = '**/.cursor/rules/**/*.mdc';

export class ProjectRulesService extends Disposable implements IProjectRulesService {

	declare readonly _serviceBrand: undefined;

	private rules: ParsedRule[] = [];
	private readonly changeEmitter = new Emitter<void>();
	readonly onDidChangeRules = this.changeEmitter.event;
	private readonly output: IComposerOutputChannel;
	/** Owned file watchers — cleared on every startWatching() call. */
	private readonly watcherStore = new DisposableStore();

	constructor(
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IFileService private readonly fileService: IFileService,
		@ISearchService private readonly searchService: ISearchService,
		@IEditorService private readonly editorService: IEditorService,
		@IOutputService outputService: IOutputService,
	) {
		super();
		const core = outputService.getChannel('ide-agent');
		if (core) {
			this.output = {
				append: (value: string) => core.append(value),
				appendLine: (value: string) => core.append(value + '\n'),
			};
		} else {
			// TODO(composer): register the `ide-agent` output channel in the composer
			// workbench contribution via OutputChannelRegistry (Extensions.OutputChannels)
			// so it shows in the Output panel. Until then, log to the console — the
			// append/appendLine behavior is preserved either way.
			this.output = {
				append: (value: string) => console.log(`[ide-agent][rules] ${value}`),
				appendLine: (value: string) => console.log(`[ide-agent][rules] ${value}`),
			};
		}
		this._register(this.changeEmitter);
		this._register(this.watcherStore);
	}

	/** (Re)discover all .mdc rules in every workspace folder. */
	async refresh(): Promise<void> {
		const folders = this.workspaceContextService.getWorkspace().folders;
		const found: ParsedRule[] = [];
		for (const folder of folders) {
			let uris: URI[];
			try {
				const complete = await this.searchService.fileSearch({
					type: QueryType.File,
					folderQueries: [{ folder: folder.uri }],
					filePattern: RULES_GLOB,
				});
				uris = complete.results.map((r) => r.resource);
			} catch {
				// Search unavailable for this folder — skip it.
				continue;
			}
			for (const uri of uris) {
				const rule = await this.loadRule(folder, uri);
				if (rule) {
					found.push(rule);
				}
			}
		}
		// Deterministic order: workspace root, then path.
		found.sort((a, b) =>
			a.workspaceRoot === b.workspaceRoot
				? a.fullPath.localeCompare(b.fullPath)
				: a.workspaceRoot.localeCompare(b.workspaceRoot),
		);
		this.rules = found;
		this.log(`discovered ${found.length} rule(s)`);
		this.changeEmitter.fire();
	}

	private async loadRule(
		folder: IWorkspaceFolder,
		uri: URI,
	): Promise<ParsedRule | null> {
		try {
			const content = await this.fileService.readFile(uri);
			const text = content.value.toString();
			const filename = path.basename(uri.fsPath);
			// Split "<root>/.cursor/rules/<internalPath>" for nested-rule scoping.
			const rel = normalizeRelPath(path.relative(folder.uri.fsPath, uri.fsPath));
			const marker = '.cursor/rules/';
			const idx = rel.toLowerCase().lastIndexOf(marker);
			const subdirPath = idx > 0 ? rel.slice(0, idx) : '';
			const internalPath = idx >= 0 ? rel.slice(idx + marker.length) : rel;
			return parseMdcFile(filename, uri.fsPath, folder.uri.fsPath, subdirPath, internalPath, text);
		} catch (err) {
			this.log(`failed to load ${uri.fsPath}: ${err instanceof Error ? err.message : err}`);
			return null;
		}
	}

	/** Start file watchers (call once at wiring time; re-call refreshes them). */
	startWatching(): void {
		this.watcherStore.clear();
		for (const folder of this.workspaceContextService.getWorkspace().folders) {
			// IFileService.createWatcher is non-recursive only; recursive
			// watching goes through watch() + the shared onDidFilesChange
			// event, filtered to the rules glob below.
			this.watcherStore.add(this.fileService.watch(folder.uri, {
				recursive: true,
				excludes: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/out/**'],
			}));
		}
		this.watcherStore.add(this.fileService.onDidFilesChange((e) => {
			const hit = [...e.rawAdded, ...e.rawUpdated, ...e.rawDeleted].some((resource) => {
				const folder = this.workspaceContextService.getWorkspaceFolder(resource);
				if (!folder) {
					return false;
				}
				const rel = extUri.relativePath(folder.uri, resource);
				return !!rel && globMatch(RULES_GLOB, rel);
			});
			if (hit) {
				void this.refresh().then(undefined, (err: unknown) => this.log(`refresh failed: ${String(err)}`));
			}
		}));
	}

	/** All discovered rules (a copy). */
	getRules(): ParsedRule[] {
		return [...this.rules];
	}

	/**
	 * Look up a single rule by file name or stem (e.g. "fastapi" or
	 * "fastapi.mdc"), case-insensitive. This is the on-demand fetch path for
	 * agent-requested rules listed in <available-rules>.
	 */
	getRuleByName(name: string): ParsedRule | undefined {
		const want = name.trim().toLowerCase().replace(/\.mdc$/i, '');
		return this.rules.find((r) => {
			const stem = r.filename.toLowerCase().replace(/\.mdc$/i, '');
			return stem === want;
		});
	}

	/**
	 * Rules whose globs match the given workspace-relative file paths
	 * (UNKNOWN: "getRulesForFiles" was presented as Cursor's name — no evidence.)
 * Exported for the read-path and future UI.
	 */
	getRulesForFiles(relPaths: string[]): ParsedRule[] {
		return getRulesForFiles(
			this.rules.filter((r) => ruleAppliesToEnv(r, CURRENT_ENVIRONMENT)),
			relPaths,
		);
	}

	/**
	 * Workspace-relative paths forming the current context for auto-attach:
	 * the active editor's file plus any workspace-relative paths that appear
	 * verbatim in the prompt.
	 */
	getContextFiles(prompt: string): string[] {
		const files = new Set<string>();
		const control = this.editorService.activeTextEditorControl;
		const editor: ICodeEditor | undefined = control && isCodeEditor(control) ? control : undefined;
		const active = editor?.getModel()?.uri;
		if (active && active.scheme === 'file') {
			const folder = this.workspaceContextService.getWorkspaceFolder(active);
			if (folder) {
				files.add(normalizeRelPath(path.relative(folder.uri.fsPath, active.fsPath)));
			}
		}
		// Paths mentioned in the prompt (e.g. pasted by the user).
		for (const folder of this.workspaceContextService.getWorkspace().folders) {
			const root = folder.uri.fsPath;
			const candidates = prompt.match(/[\w.\-@/]+(?:\/[\w.\-@]+)+/g) ?? [];
			for (const c of candidates) {
				const cleaned = c.replace(/^@/, '');
				try {
					const abs = path.resolve(root, cleaned);
					if (abs.startsWith(root + path.sep)) {
						files.add(normalizeRelPath(path.relative(root, abs)));
					}
				} catch {
					// Ignore unresolvable candidates.
				}
			}
		}
		return [...files];
	}

	/**
	 * Builds the rules block merged into the prompt. Called on EVERY agent-chat
	 * submit. (UNKNOWN: "writeRulesEntry"/"onBeforeSubmitChat" were presented
	 * as Cursor's names — no evidence.) The returned text is merged into the
	 * agent request. Never called from Cmd+K or Tab paths (our parity spec §A6 —
	 * internal, not a Cursor source).
	 */
	buildInjection(prompt: string, mode?: string): RulesBlock {
		return buildRulesBlock(this.rules, {
			contextFiles: this.getContextFiles(prompt),
			prompt,
			mode,
			env: CURRENT_ENVIRONMENT,
		});
	}

	private log(message: string): void {
		this.output.appendLine(`[ide-agent][rules] ${message}`);
	}
}
