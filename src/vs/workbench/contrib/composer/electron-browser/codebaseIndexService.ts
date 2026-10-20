/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Migrated from extensions/ide-agent/services/codebaseIndexService.ts — vscode API → DI
// - `vscode.workspace.getConfiguration("ide.agent")` → injected
//   `IConfigurationService.getValue("ide.agent.enginePath")`
//   (config keys keep the `ide.` prefix — see common/composerConfiguration.ts)
// - `vscode.workspace.workspaceFolders` → injected `IWorkspaceContextService`
// - `defaultEnginePath()` was a 4-line pure helper on ComposerDataService
//   (not yet migrated) — inlined here with its origin noted.

import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import {
	CodebaseHit,
	ICodebaseIndexService,
} from '../common/codebaseIndexService.js';
import { GLOBAL_IGNORE_SETTING_KEY, syncGlobalIgnoreFile } from './globalIgnoreSync.js';

const execFileAsync = promisify(execFile);

interface CliSearchResult {
	kind: 'text' | 'symbols';
	matches?: { path: string; line: number; text: string }[];
	hits?: { path: string; name: string; kind: string; line: number; signature: string }[];
}

/**
 * Best-effort default for the engine checkout: ~/workspace/ide-code.
 * Inlined from ComposerDataService.defaultEnginePath (services/composerDataService.ts).
 */
function defaultEnginePath(): string {
	const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
	return path.join(home, 'workspace', 'ide-code');
}

/**
 * Short-lived result cache (P1, QA-INDEXING-01/X3-N2): @Codebase resolves
 * twice per mention — menu preview (limit 5) then submit-time resolve
 * (limit 12). Without a cache that's two ~2s spawns and a ~2min worst case
 * under the 60s timeouts; the cache collapses the second call to ~0ms.
 * TTL matches the index's own staleness contract (30s).
 */
const CACHE_TTL_MS = 30_000;
const CACHE_MAX_ENTRIES = 50;

/**
 * CodebaseIndexService — workbench-side bridge to the engine's local-first
 * codebase index.
 *
 * The index lives in the engine (bun sidecar): SQLite trigram + symbol DB
 * at `<workspace>/.ide-code/index/codebase.db`, maintained incrementally by
 * the sidecar's file watcher. This service shells out to the engine's slim
 * one-shot indexing CLI for @Codebase mention resolution:
 *
 *   bun <enginePath>/packages/core/src/indexing/cli.ts search --json ...
 *
 * The slim entry imports only the indexing module graph — the full
 * `packages/cli` entry pays ~5s importing the whole command graph per query
 * (P1, QA-INDEXING-01).
 *
 * All failures (engine not configured, CLI missing, timeout, bad JSON)
 * resolve to an honest empty result — never fabricated items.
 */
export class CodebaseIndexService extends Disposable implements ICodebaseIndexService {

	declare readonly _serviceBrand: undefined;

	private readonly resultCache = new Map<string, { at: number; hits: CodebaseHit[] }>();

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) {
		super();
		// ext-global-ignore: mirror `ide.general.globalCursorIgnoreList` into
		// `<workspace>/.ide-code/global-ignore` for the engine's indexer.
		// Sync once now (the indexer may already be running) and on every
		// subsequent settings change.
		this.syncGlobalIgnoreLists();
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(GLOBAL_IGNORE_SETTING_KEY)) {
				this.syncGlobalIgnoreLists();
			}
		}));
	}

	/**
	 * ext-global-ignore: write the user's global ignore patterns to the
	 * per-workspace sync file the engine's local-first index reads
	 * (`indexing/ignore.ts`). The engine merges them with the highest
	 * precedence at index time and filters them at query time, separate
	 * from the per-project `.cursorignore`.
	 */
	private syncGlobalIgnoreLists(): void {
		const configured = this.configurationService.getValue<readonly string[]>(GLOBAL_IGNORE_SETTING_KEY);
		const patterns = Array.isArray(configured) ? configured : [];
		for (const folder of this.workspaceContextService.getWorkspace().folders) {
			syncGlobalIgnoreFile(folder.uri.fsPath, patterns);
		}
	}

	private engineCliEntry(): string | undefined {
		const enginePath = this.configurationService.getValue<string>('ide.agent.enginePath') || defaultEnginePath();
		if (!enginePath) {
			return undefined;
		}
		// Slim one-shot indexing CLI (see class docstring): avoids the ~5s
		// import cost of the full packages/cli entry per query.
		return path.join(enginePath, 'packages', 'core', 'src', 'indexing', 'cli.ts');
	}

	private workspaceRoot(): string | undefined {
		return this.workspaceContextService.getWorkspace().folders[0]?.uri.fsPath;
	}

	private cacheKey(root: string, query: string, symbols: boolean, include: string | undefined): string {
		return `${root}::${query}::${symbols ? 's' : 't'}::${include ?? ''}`;
	}

	private cacheGet(key: string): CodebaseHit[] | undefined {
		const entry = this.resultCache.get(key);
		if (!entry) {
			return undefined;
		}
		if (Date.now() - entry.at > CACHE_TTL_MS) {
			this.resultCache.delete(key);
			return undefined;
		}
		return entry.hits;
	}

	private cacheSet(key: string, hits: CodebaseHit[]): void {
		if (this.resultCache.size >= CACHE_MAX_ENTRIES) {
			const oldest = this.resultCache.keys().next();
			if (!oldest.done) {
				this.resultCache.delete(oldest.value);
			}
		}
		this.resultCache.set(key, { at: Date.now(), hits });
	}

	private async runCli(args: string[], timeoutMs: number): Promise<string | undefined> {
		const entry = this.engineCliEntry();
		const root = this.workspaceRoot();
		if (!entry || !root) {
			return undefined;
		}
		try {
			// --root must precede the `--` query separator or the parser would
			// swallow it into the query string.
			const { stdout } = await execFileAsync('bun', [entry, args[0], '--root', root, ...args.slice(1)], {
				timeout: timeoutMs,
				maxBuffer: 8 * 1024 * 1024,
				env: { ...process.env, IDE_CODE_SPAWNED_BY: 'indexing-cli' },
			});
			return stdout;
		} catch {
			return undefined;
		}
	}

	/**
	 * Instant Grep over the local index: <100ms warm in-process; this shell-out
	 * path pays bun startup + module import (~1-3s, down from ~5-20s via the
	 * full CLI entry — P1, QA-INDEXING-01). Returns [] when the engine/CLI is
	 * unavailable — the caller treats that as "no data".
	 */
	async searchCodebase(
		query: string,
		opts: { limit?: number; symbols?: boolean; include?: string } = {},
	): Promise<CodebaseHit[]> {
		const root = this.workspaceRoot();
		const symbols = opts.symbols ?? false;
		// Fetch enough for both call sites (preview limit 5, submit limit 12)
		// so the second call per mention is served from cache.
		const fetchLimit = Math.max(opts.limit ?? 10, 12);
		if (root) {
			const cached = this.cacheGet(this.cacheKey(root, query, symbols, opts.include));
			if (cached) {
				return cached.slice(0, opts.limit ?? 10);
			}
		}
		const args = ['search', '--json', '--limit', String(fetchLimit)];
		if (symbols) {
			args.push('--symbols');
		}
		if (opts.include) {
			args.push('--include', opts.include);
		}
		args.push('--', query);
		const stdout = await this.runCli(args, 60_000);
		if (!stdout) {
			return [];
		}
		try {
			const parsed = JSON.parse(stdout) as CliSearchResult;
			const hits =
				parsed.kind === 'symbols'
					? (parsed.hits ?? []).map((h) => ({
						kind: 'symbol' as const,
						path: h.path,
						name: h.name,
						symbolKind: h.kind,
						line: h.line,
						signature: h.signature,
					}))
					: (parsed.matches ?? []).map((m) => ({ kind: 'text' as const, path: m.path, line: m.line, text: m.text }));
			if (root) {
				this.cacheSet(this.cacheKey(root, query, symbols, opts.include), hits);
			}
			return hits.slice(0, opts.limit ?? 10);
		} catch {
			return [];
		}
	}

	/** Index status for diagnostics; undefined when unavailable. */
	async codebaseIndexStatus(): Promise<unknown | undefined> {
		const stdout = await this.runCli(['status', '--json'], 30_000);
		if (!stdout) {
			return undefined;
		}
		try {
			return JSON.parse(stdout) as unknown;
		} catch {
			return undefined;
		}
	}
}
