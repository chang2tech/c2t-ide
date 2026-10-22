/**
 * CodebaseIndexService — extension-side bridge to the engine's local-first
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

import * as vscode from "vscode";
import * as path from "path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ENGINE_INDEX_ENTRY_REL, resolveBunPath, resolveEnginePath } from "./enginePath";
import { filterGloballyIgnored } from "./globalIgnore";

const execFileAsync = promisify(execFile);

export interface CodebaseTextHit {
  kind: "text";
  path: string;
  line: number;
  text: string;
}

export interface CodebaseSymbolHit {
  kind: "symbol";
  path: string;
  name: string;
  symbolKind: string;
  line: number;
  signature: string;
}

export type CodebaseHit = CodebaseTextHit | CodebaseSymbolHit;

interface CliSearchResult {
  kind: "text" | "symbols";
  matches?: { path: string; line: number; text: string }[];
  hits?: { path: string; name: string; kind: string; line: number; signature: string }[];
}

interface EngineCliInvocation {
  entry: string;
  bunPath: string;
}

function engineCliInvocation(): EngineCliInvocation | undefined {
  const cfg = vscode.workspace.getConfiguration("ide.agent");
  const resolved = resolveEnginePath(cfg.get<string>("enginePath", ""));
  if (!resolved.enginePath || resolved.source === "none") {
    // "none" = broken bundled engine: degrade to [] like every other
    // unavailable-engine case (the adapter surfaces the diagnostic).
    return undefined;
  }
  // Slim one-shot indexing CLI (see module docstring): avoids the ~5s
  // import cost of the full packages/cli entry per query.
  return {
    entry: path.join(resolved.enginePath, ENGINE_INDEX_ENTRY_REL),
    bunPath: resolveBunPath(resolved),
  };
}

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
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
const resultCache = new Map<string, { at: number; hits: CodebaseHit[] }>();

function cacheKey(root: string, query: string, symbols: boolean, include: string | undefined): string {
  return `${root}::${query}::${symbols ? "s" : "t"}::${include ?? ""}`;
}

function cacheGet(key: string): CodebaseHit[] | undefined {
  const entry = resultCache.get(key);
  if (!entry) {
    return undefined;
  }
  if (Date.now() - entry.at > CACHE_TTL_MS) {
    resultCache.delete(key);
    return undefined;
  }
  return entry.hits;
}

function cacheSet(key: string, hits: CodebaseHit[]): void {
  if (resultCache.size >= CACHE_MAX_ENTRIES) {
    const oldest = resultCache.keys().next();
    if (!oldest.done) {
      resultCache.delete(oldest.value);
    }
  }
  resultCache.set(key, { at: Date.now(), hits });
}

async function runCli(args: string[], timeoutMs: number): Promise<string | undefined> {
  const invocation = engineCliInvocation();
  const root = workspaceRoot();
  if (!invocation || !root) {
    return undefined;
  }
  try {
    // --root must precede the `--` query separator or the parser would
    // swallow it into the query string.
    const { stdout } = await execFileAsync(invocation.bunPath, [invocation.entry, args[0], "--root", root, ...args.slice(1)], {
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, IDE_CODE_SPAWNED_BY: "indexing-cli" },
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
export async function searchCodebase(
  query: string,
  opts: { limit?: number; symbols?: boolean; include?: string } = {},
): Promise<CodebaseHit[]> {
  const root = workspaceRoot();
  const symbols = opts.symbols ?? false;
  // Fetch enough for both call sites (preview limit 5, submit limit 12)
  // so the second call per mention is served from cache.
  const fetchLimit = Math.max(opts.limit ?? 10, 12);
  if (root) {
    const cached = cacheGet(cacheKey(root, query, symbols, opts.include));
    if (cached) {
      // DEV-GAPS-14 `ext-global-ignore`: filter at read time (not at cache
      // time) so a config change applies immediately, before the TTL expires.
      return filterGloballyIgnored<CodebaseHit>(root, cached, (h) => h.path).slice(0, opts.limit ?? 10);
    }
  }
  const args = ["search", "--json", "--limit", String(fetchLimit)];
  if (symbols) {
    args.push("--symbols");
  }
  if (opts.include) {
    args.push("--include", opts.include);
  }
  args.push("--", query);
  const stdout = await runCli(args, 60_000);
  if (!stdout) {
    return [];
  }
  try {
    const parsed = JSON.parse(stdout) as CliSearchResult;
    const hits =
      parsed.kind === "symbols"
        ? (parsed.hits ?? []).map((h) => ({
            kind: "symbol" as const,
            path: h.path,
            name: h.name,
            symbolKind: h.kind,
            line: h.line,
            signature: h.signature,
          }))
        : (parsed.matches ?? []).map((m) => ({ kind: "text" as const, path: m.path, line: m.line, text: m.text }));
    if (root) {
      cacheSet(cacheKey(root, query, symbols, opts.include), hits);
      // ext-global-ignore: global ignore patterns
      // (`ide.general.globalCursorIgnoreList`) merged on top of .cursorignore —
      // ignored paths are dropped from retrieval even if the index has them.
      return filterGloballyIgnored<CodebaseHit>(root, hits, (h) => h.path).slice(0, opts.limit ?? 10);
    }
    return hits.slice(0, opts.limit ?? 10);
  } catch {
    return [];
  }
}

/** Index status for diagnostics; undefined when unavailable. */
export async function codebaseIndexStatus(): Promise<unknown | undefined> {
  const stdout = await runCli(["status", "--json"], 30_000);
  if (!stdout) {
    return undefined;
  }
  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    return undefined;
  }
}
