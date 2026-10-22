/**
 * InstantGrepService — extension-side bridge to the engine's Instant Grep.
 *
 * Instant Grep is Cursor's custom search engine (cursor.com/docs/context/codebase-indexing):
 * "a custom search engine that outperforms ripgrep on large codebases. It runs
 * automatically; no configuration needed", supporting "full regex and
 * word-boundary matching". This service exposes it to the sidebar manual
 * search and to agent flows running in the extension host.
 *
 * Like CodebaseIndexService, it shells out to the engine's slim one-shot
 * indexing CLI (only the indexing module graph is imported — not the ~5s
 * full `packages/cli` entry):
 *
 *   bun <enginePath>/packages/core/src/indexing/cli.ts grep --json ...
 *
 * All failures (engine not configured, CLI missing, timeout, bad JSON)
 * resolve to an honest empty result — never fabricated matches.
 */

import * as vscode from "vscode";
import * as path from "path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ENGINE_INDEX_ENTRY_REL, resolveBunPath, resolveEnginePath } from "./enginePath";
import { filterGloballyIgnored } from "./globalIgnore";

const execFileAsync = promisify(execFile);

export interface InstantGrepMatch {
  path: string;
  line: number;
  text: string;
}

export interface InstantGrepOptions {
  limit?: number;
  /** Treat the pattern as a regular expression (default true — grep semantics). */
  regex?: boolean;
  /** Match only on word boundaries: `PaymentFailedError` skips `PaymentFailedErrors`. */
  wordBoundary?: boolean;
  caseSensitive?: boolean;
  /** Glob filter on result paths, e.g. "*.ts". */
  include?: string;
  /** Glob exclusion on result paths, e.g. "*.test.ts". */
  exclude?: string;
}

interface CliGrepResult {
  kind: "grep";
  matches?: { path: string; line: number; text: string }[];
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
  return {
    entry: path.join(resolved.enginePath, ENGINE_INDEX_ENTRY_REL),
    bunPath: resolveBunPath(resolved),
  };
}

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/**
 * Short-lived result cache, mirroring CodebaseIndexService: sidebar search
 * re-issues the same query on keystrokes and agent flows resolve twice
 * (preview, then submit). TTL matches the index's own staleness contract (30s).
 */
const CACHE_TTL_MS = 30_000;
const CACHE_MAX_ENTRIES = 50;
const resultCache = new Map<string, { at: number; matches: InstantGrepMatch[] }>();

function cacheKey(root: string, pattern: string, opts: InstantGrepOptions): string {
  return [
    root,
    pattern,
    opts.regex === false ? "lit" : "re",
    opts.wordBoundary ? "wb" : "",
    opts.caseSensitive ? "cs" : "",
    opts.include ?? "",
    opts.exclude ?? "",
  ].join("::");
}

function cacheGet(key: string): InstantGrepMatch[] | undefined {
  const entry = resultCache.get(key);
  if (!entry) {
    return undefined;
  }
  if (Date.now() - entry.at > CACHE_TTL_MS) {
    resultCache.delete(key);
    return undefined;
  }
  return entry.matches;
}

function cacheSet(key: string, matches: InstantGrepMatch[]): void {
  if (resultCache.size >= CACHE_MAX_ENTRIES) {
    const oldest = resultCache.keys().next();
    if (!oldest.done) {
      resultCache.delete(oldest.value);
    }
  }
  resultCache.set(key, { at: Date.now(), matches });
}

/** Process runner, injectable for tests (default: real `bun` spawn). */
export type CliRunner = (args: string[], timeoutMs: number) => Promise<string | undefined>;

async function defaultRunner(args: string[], timeoutMs: number): Promise<string | undefined> {
  const invocation = engineCliInvocation();
  const root = workspaceRoot();
  if (!invocation || !root) {
    return undefined;
  }
  try {
    // --root must precede the `--` pattern separator or the parser would
    // swallow it into the pattern string.
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

let runner: CliRunner = defaultRunner;

/** Test seam: swap the CLI runner for a fake. Not for production use. */
export function __setInstantGrepRunnerForTests(next: CliRunner): void {
  runner = next;
}

export function __resetInstantGrepRunnerForTests(): void {
  runner = defaultRunner;
}

/** Test seam: clear the result cache between cases. */
export function __clearInstantGrepCacheForTests(): void {
  resultCache.clear();
}

function buildArgs(pattern: string, opts: InstantGrepOptions, fetchLimit: number): string[] {
  const args = ["grep", "--json", "--limit", String(fetchLimit)];
  if (opts.regex === false) {
    args.push("--literal");
  }
  if (opts.wordBoundary) {
    args.push("--word-boundary");
  }
  if (opts.caseSensitive) {
    args.push("--case-sensitive");
  }
  if (opts.include) {
    args.push("--include", opts.include);
  }
  if (opts.exclude) {
    args.push("--exclude", opts.exclude);
  }
  args.push("--", pattern);
  return args;
}

/**
 * Instant Grep over the local index. Returns ranked {path, line, text}
 * matches, or [] when the engine/CLI is unavailable — the caller treats
 * that as "no data", never as an error to surface.
 */
export async function instantGrep(
  pattern: string,
  opts: InstantGrepOptions = {},
): Promise<InstantGrepMatch[]> {
  if (!pattern) {
    return [];
  }
  const root = workspaceRoot();
  // Fetch a little extra so repeated calls with a smaller limit are served
  // from cache (same trick as CodebaseIndexService).
  const fetchLimit = Math.max(opts.limit ?? 25, 25);
  if (root) {
    const cached = cacheGet(cacheKey(root, pattern, opts));
    if (cached) {
      // DEV-GAPS-14 `ext-global-ignore`: filter at read time so a config
      // change applies immediately, before the TTL expires.
      return filterGloballyIgnored(root, cached, (m) => m.path).slice(0, opts.limit ?? 25);
    }
  }
  const stdout = await runner(buildArgs(pattern, opts, fetchLimit), 60_000);
  if (!stdout) {
    return [];
  }
  try {
    const parsed = JSON.parse(stdout) as CliGrepResult;
    if (parsed.kind !== "grep" || !Array.isArray(parsed.matches)) {
      return [];
    }
    const matches: InstantGrepMatch[] = [];
    for (const m of parsed.matches) {
      if (typeof m.path !== "string" || typeof m.line !== "number" || typeof m.text !== "string") {
        continue;
      }
      matches.push({ path: m.path, line: m.line, text: m.text });
    }
    if (root) {
      cacheSet(cacheKey(root, pattern, opts), matches);
      // ext-global-ignore: global ignore patterns
      // (`ide.general.globalCursorIgnoreList`) merged on top of .cursorignore.
      return filterGloballyIgnored(root, matches, (m) => m.path).slice(0, opts.limit ?? 25);
    }
    return matches.slice(0, opts.limit ?? 25);
  } catch {
    return [];
  }
}
