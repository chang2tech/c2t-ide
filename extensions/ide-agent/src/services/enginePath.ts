/**
 * Engine checkout path helpers.
 *
 * Split out of composerDataService so light-weight bridges (codebase index,
 * instant grep) can resolve the engine path without importing the whole
 * composer module graph. composerDataService re-exports this; existing
 * imports keep working.
 *
 * ENGINE PACKAGING (spec engine-packaging-spec-v1 §5, design W4 §1.2):
 * `resolveEnginePath` is the ONE resolution algorithm for every extension
 * call site. Priority (decision D2):
 *   1. the `ide.agent.enginePath` setting (machine scope), used verbatim;
 *   2. the engine bundled with the packaged app at
 *      `<appRoot>/engine` — only when its serve entry exists;
 *   3. the dev fallback `~/workspace/ide-code` — ONLY when no bundled
 *      directory exists on disk at all.
 * A bundled directory that exists but lacks the serve entry is a broken
 * package: resolution stops with source "none" (+ `bundledBroken`) instead
 * of silently falling through to a dev checkout on the user's machine.
 */
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

/** Best-effort default for the engine checkout: ~/workspace/ide-code. */
export function defaultEnginePath(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  return path.join(home, "workspace", "ide-code");
}

/** Serve entry of the engine, relative to an engine root. This exact file
 *  is what IdeCodeEngineAdapter validates before spawning (defense in
 *  depth must agree with resolution). */
export const ENGINE_CLI_ENTRY_REL = path.join("packages", "cli", "src", "index.ts");

/** One-shot indexing CLI entry, relative to an engine root. */
export const ENGINE_INDEX_ENTRY_REL = path.join("packages", "core", "src", "indexing", "cli.ts");

/** Solid preload script inside a staged engine closure, relative to an
 *  engine root. F-W4-1 delta (adjudication N1, w6-f-w4-1-experiment.md
 *  §6.1): Bun only loads bunfig.toml at the exact spawn cwd, so the
 *  relative preload in the engine root bunfig never fires for a bundled
 *  spawn whose cwd is the user-data dir (spec §4). The serve adapters
 *  pass this file to bun as an absolute `--preload` argument instead.
 *  The file is part of the production closure staged by stage-engine.sh
 *  (staging hard-fails if it is missing from the staged tree). */
export const ENGINE_SOLID_PRELOAD_REL = path.join("packages", "cli", "node_modules", "@opentui", "solid", "scripts", "preload.js");

/** Absolute path of the Solid preload script for an engine root. */
export function bundledServePreloadPath(enginePath: string): string {
  return path.join(enginePath, ENGINE_SOLID_PRELOAD_REL);
}

/** Directory name of the bundled engine inside the app root
 *  (`resources/app/engine` in the packaged layout). MUST match the
 *  workbench constant of the same name in
 *  `workbench/contrib/composer/common/composerDataService.ts`. */
export const BUNDLED_ENGINE_DIR_NAME = "engine";

/** Bundled bun binary, relative to a resolved engine root. */
export const BUNDLED_BUN_RELATIVE =
  process.platform === "win32" ? path.join("bin", "bun.exe") : path.join("bin", "bun");

/**
 * Candidate bundled-engine path derived purely from the app root;
 * "" when there is no app root (web / unusual remote hosts).
 * Per the approved packaging spec §1 the bundled engine lives INSIDE
 * the app root: `path.join(appRoot, "engine")`.
 */
export function bundledEnginePath(appRoot: string): string {
  if (!appRoot) {
    return "";
  }
  return path.join(appRoot, BUNDLED_ENGINE_DIR_NAME);
}

export type EnginePathSource = "setting" | "bundled" | "dev" | "none";

export interface ResolvedEnginePath {
  enginePath: string;
  source: EnginePathSource;
  /** Set when source is "none" because a bundled engine directory exists
   *  on disk but its serve entry is missing (broken packaging). */
  bundledBroken?: string;
}

export interface ResolveEnginePathOptions {
  /** Defaults to `vscode.env.appRoot`. Injected by tests. */
  appRoot?: string;
  /** Defaults to `fs.existsSync`. Injected by tests. */
  exists?: (p: string) => boolean;
}

/**
 * The single D2 resolution algorithm (see module docstring). The
 * `configured` value is NOT validated here: for source "setting" the
 * adapter keeps its existing `Invalid enginePath` throw, and the
 * indexing bridges keep their degrade-to-[] behavior.
 */
export function resolveEnginePath(
  configured: string,
  opts: ResolveEnginePathOptions = {},
): ResolvedEnginePath {
  const trimmed = configured.trim();
  if (trimmed) {
    return { enginePath: trimmed, source: "setting" };
  }
  const exists = opts.exists ?? fs.existsSync;
  const candidate = bundledEnginePath(opts.appRoot ?? vscode.env.appRoot);
  if (candidate) {
    if (exists(path.join(candidate, ENGINE_CLI_ENTRY_REL))) {
      return { enginePath: candidate, source: "bundled" };
    }
    if (exists(candidate)) {
      // Bundled directory present but entry missing: broken package.
      // Do NOT fall through to the dev checkout (spec §5.1).
      return { enginePath: "", source: "none", bundledBroken: candidate };
    }
  }
  return { enginePath: defaultEnginePath(), source: "dev" };
}

/**
 * Resolve the bun binary for an already-resolved engine: the bun shipped
 * inside the engine root wins; otherwise fall back to `bun` on PATH
 * (today's behavior for dev/setting checkouts). Resolving bun FROM the
 * resolved engine path — never independently from the app root — keeps
 * engine and bun versions paired.
 *
 * `onBundledBunMissing` fires when a bundled engine's own bun is absent
 * so the caller can log the fallback instead of hiding it.
 */
export function resolveBunPath(
  resolved: ResolvedEnginePath,
  exists: (p: string) => boolean = fs.existsSync,
  onBundledBunMissing?: (candidate: string) => void,
): string {
  if (resolved.enginePath) {
    const candidate = path.join(resolved.enginePath, BUNDLED_BUN_RELATIVE);
    if (exists(candidate)) {
      return candidate;
    }
    if (resolved.source === "bundled") {
      onBundledBunMissing?.(candidate);
    }
  }
  return "bun";
}

/**
 * Spawn cwd for a bundled engine (spec §4, BRANCH B): the install tree
 * may be read-only (.deb under /usr, AppImage mount), and the engine's
 * location fallback would otherwise try to write its codebase index
 * into `<cwd>/.ide-code/index`. Bundled engines therefore spawn from a
 * writable user-data directory: `<globalStorage>/engine-runtime`.
 * Dev/setting engines keep cwd = enginePath (returns undefined).
 */
export function resolveEngineCwd(
  resolved: ResolvedEnginePath,
  globalStorageFsPath: string | undefined,
): string | undefined {
  if (resolved.source !== "bundled" || !globalStorageFsPath) {
    return undefined;
  }
  return path.join(globalStorageFsPath, "engine-runtime");
}

/** User-facing diagnostic for a broken bundled engine (spec §5.1). */
export function bundledIncompleteDiagnostic(candidate: string): string {
  return (
    `[ide-agent] Bundled engine is incomplete: ${candidate} exists but ` +
    `packages/cli/src/index.ts is missing. Reinstall the app, or set the ` +
    `ide.agent.enginePath setting (machine scope) to a valid engine checkout.`
  );
}
