/**
 * globalIgnore — ext-global-ignore (P1).
 *
 * Evidence (Cursor): `cursor.general.globalCursorIgnoreList`
 * (DIG-AST-EXT 2026-10-19 — AST extraction of the cursor-agent-host bundle;
 * deep-env-config.md "Global ignore patterns"; parity-settings.md;
 * contributes-migration-source.json) — "Global ignore list setting applied
 * to Cursor indexing/retrieval, separate from .cursorignore."
 *
 * Backed by the `ide.general.globalCursorIgnoreList` setting (array of glob
 * patterns, default []) — the same setting Tab completion consumes
 * (`tab/extension.ts` merges it into `ignorePatterns`), and the same key
 * the workbench syncs to `<workspace>/.ide-code/global-ignore` for the
 * engine's indexer (`electron-browser/globalIgnoreSync.ts`).
 *
 * NOTE (WORKER-GAPS-22E 2026-10-20): this module previously read a
 * fabricated `ide.indexing.globalIgnore` key (DEV-GAPS-14). The REA evidence
 * above identifies the canonical key, so this now reads the real setting;
 * the duplicate `ide.indexing.globalIgnore` registration in
 * `composerConfiguration.ts` was removed.
 *
 * This list is SEPARATE from `.cursorignore`: the pipeline checks
 * `.cursorignore` (engine-side, at index time) FIRST, then these global
 * patterns are merged on top at retrieval time — ignored paths are dropped
 * from results even if the index contains them. (The engine additionally
 * filters at query time via the synced `.ide-code/global-ignore` file; this
 * extension-side filter is defense in depth for the legacy chat path.)
 */

import * as vscode from "vscode";
import * as path from "path";
import { matchesAnyPattern } from "../tab/gates";

/** Config section/key backing this feature. */
export const GLOBAL_IGNORE_CONFIG_SECTION = "ide.general";
export const GLOBAL_IGNORE_CONFIG_KEY = "globalCursorIgnoreList";

/**
 * Read the configured global ignore patterns. Never throws — returns []
 * when the configuration is unavailable.
 */
export function readGlobalIgnorePatterns(): string[] {
  try {
    const patterns = vscode.workspace
      .getConfiguration(GLOBAL_IGNORE_CONFIG_SECTION)
      .get<string[]>(GLOBAL_IGNORE_CONFIG_KEY, []);
    return Array.isArray(patterns) ? patterns.filter((p) => typeof p === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Pure: true when `relPath` (workspace-relative, `/`-separated) matches any
 * of `patterns`. Gitignore-style matchBase semantics (`*.secret` matches
 * `sub/dir/a.secret`) via the shared `matchesAnyPattern` helper.
 */
export function isIgnoredByGlobalPatterns(relPath: string, patterns: readonly string[]): boolean {
  if (patterns.length === 0) {
    return false;
  }
  return matchesAnyPattern(relPath, [...patterns]);
}

/** Normalize a hit path to workspace-relative `/`-separated form. */
export function toWorkspaceRelative(root: string, p: string): string {
  const rel = path.isAbsolute(p) ? path.relative(root, p) : p;
  return rel.split(path.sep).join("/");
}

/**
 * Drop retrieval items whose workspace-relative path matches the global
 * ignore patterns. `patterns` defaults to the live setting. Returns the
 * input array untouched when no patterns are configured (zero-cost path).
 */
export function filterGloballyIgnored<T>(
  root: string,
  items: readonly T[],
  relPathOf: (item: T) => string,
  patterns?: readonly string[],
): T[] {
  const pats = patterns ?? readGlobalIgnorePatterns();
  if (pats.length === 0) {
    return [...items];
  }
  return items.filter((item) => !isIgnoredByGlobalPatterns(toWorkspaceRelative(root, relPathOf(item)), pats));
}
