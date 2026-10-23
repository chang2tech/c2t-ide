/**
 * Engine checkout path helpers.
 *
 * Split out of composerDataService so light-weight bridges (codebase index,
 * instant grep) can resolve the engine path without importing the whole
 * composer module graph. composerDataService re-exports this; existing
 * imports keep working.
 *
 * ENGINE PACKAGING (spec engine-packaging-spec-v1 §5, design W4 §1.2,
 * decisions D1/D2/D5; binary branch added for the alpha.40 compile
 * path (B)):
 * `resolveEnginePath` is the ONE resolution algorithm for every extension
 * call site. Priority (decision D2):
 *   1. the `ide.agent.enginePath` setting (machine scope), used verbatim;
 *   2. the engine bundled with the packaged app at `<appRoot>/engine`
 *      (resources/app/engine, decision D1) — in either on-disk layout:
 *        - "binary" (compile path B): a self-contained `opencode[.exe]`
 *          binary sits at the engine root, next to a real `rg[.exe]` file;
 *        - "tree" (original staging): the source closure with the serve
 *          entry at `packages/cli/src/index.ts`;
 *   3. the dev fallback `~/workspace/ide-code` — ONLY when no bundled
 *      directory exists on disk at all (dev builds).
 * A bundled directory that exists but carries NEITHER layout marker is a
 * broken package: resolution stops with source "none" (+ `bundledBroken`)
 * instead of silently falling through to a dev checkout on the user's
 * machine (fail-closed, same spirit as the adapters' existing
 * "Bundled engine is incomplete" guard).
 */
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

/** Best-effort default for the engine checkout: ~/workspace/ide-code. */
export function defaultEnginePath(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  return path.join(home, "workspace", "ide-code");
}

/** Serve entry of a tree-layout engine, relative to an engine root. This
 *  exact file is what IdeCodeEngineAdapter validates before spawning a
 *  tree engine (defense in depth must agree with resolution). */
export const ENGINE_CLI_ENTRY_REL = path.join("packages", "cli", "src", "index.ts");

/** One-shot indexing CLI entry, relative to a tree-layout engine root.
 *  Binary-layout engines have no such file: the indexing bridges degrade
 *  to "no data" for them (see codebaseIndexService/instantGrepService). */
export const ENGINE_INDEX_ENTRY_REL = path.join("packages", "core", "src", "indexing", "cli.ts");

/** Solid preload script inside a staged TREE engine closure, relative to
 *  an engine root. F-W4-1 delta (adjudication N1, w6-f-w4-1-experiment.md
 *  §6.1): Bun only loads bunfig.toml at the exact spawn cwd, so the
 *  relative preload in the engine root bunfig never fires for a bundled
 *  tree spawn whose cwd is the user-data dir (spec §4). The serve
 *  adapters pass this file to bun as an absolute `--preload` argument
 *  instead. The file is part of the production closure staged by
 *  stage-engine.sh (staging hard-fails if it is missing from the staged
 *  tree). Binary-layout engines never use it: the compiled binary is
 *  self-contained, so the binary spawn carries NO `--preload`. */
export const ENGINE_SOLID_PRELOAD_REL = path.join("packages", "cli", "node_modules", "@opentui", "solid", "scripts", "preload.js");

/** Absolute path of the Solid preload script for a tree engine root. */
export function bundledServePreloadPath(enginePath: string): string {
  return path.join(enginePath, ENGINE_SOLID_PRELOAD_REL);
}

/** Directory name of the bundled engine inside the app root
 *  (`resources/app/engine` in the packaged layout). MUST match the
 *  workbench constant of the same name in
 *  `workbench/contrib/composer/common/composerDataService.ts`. */
export const BUNDLED_ENGINE_DIR_NAME = "engine";

/** Bundled bun binary, relative to a resolved TREE engine root. */
export const BUNDLED_BUN_RELATIVE =
  process.platform === "win32" ? path.join("bin", "bun.exe") : path.join("bin", "bun");

/** Compiled engine binary file name at a binary-layout engine root
 *  (compile path B: `Bun.build({ compile: true })` outfile `opencode`).
 *  MUST match the workbench constant of the same name. */
export const BUNDLED_BINARY_FILE = process.platform === "win32" ? "opencode.exe" : "opencode";

/** Real ripgrep file staged next to the compiled binary (compile path B
 *  ships rg as a real file in resources/, it is NOT embedded in the
 *  binary). The engine finds rg through PATH (see the spawn-env handling
 *  in IdeCodeEngineAdapter), never relative to the binary. */
export const BUNDLED_RIPGREP_FILE = process.platform === "win32" ? "rg.exe" : "rg";

/** Absolute path of the compiled engine binary for an engine root. */
export function bundledBinaryPath(enginePath: string): string {
  return path.join(enginePath, BUNDLED_BINARY_FILE);
}

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

/**
 * On-disk layout of a resolved engine root:
 *  - "binary": self-contained compiled binary (`opencode[.exe]` at the
 *    root) — spawned directly, no bun, no `--preload`;
 *  - "tree": source checkout / staged closure (`packages/cli/src/index.ts`)
 *    — spawned through bun, exactly as before this branch existed.
 */
export type EngineLayout = "binary" | "tree";

export interface ResolvedEnginePath {
  enginePath: string;
  source: EnginePathSource;
  layout: EngineLayout;
  /** Set when source is "none" because a bundled engine directory exists
   *  on disk but carries neither layout marker (broken packaging). */
  bundledBroken?: string;
}

export interface ResolveEnginePathOptions {
  /** Defaults to `vscode.env.appRoot`. Injected by tests. */
  appRoot?: string;
  /** Defaults to `fs.existsSync`. Injected by tests. */
  exists?: (p: string) => boolean;
}

/**
 * Layout detection for one engine root, purely from what is on disk:
 * the compiled binary wins when both markers exist (the compile path is
 * the shipping layout for alpha.40+; a stray source tree next to it must
 * not shadow the binary), then the tree serve entry; `undefined` when
 * neither marker exists.
 */
export function detectEngineLayout(
  enginePath: string,
  exists: (p: string) => boolean = fs.existsSync,
): EngineLayout | undefined {
  if (!enginePath) {
    return undefined;
  }
  if (exists(bundledBinaryPath(enginePath))) {
    return "binary";
  }
  if (exists(path.join(enginePath, ENGINE_CLI_ENTRY_REL))) {
    return "tree";
  }
  return undefined;
}

/**
 * The single D2 resolution algorithm (see module docstring). The
 * `configured` value is NOT validated here: for source "setting" the
 * adapter keeps its existing `Invalid enginePath` throw when the root
 * carries no layout marker (layout then reports "tree" so the legacy
 * validation path — and its error text — runs unchanged), and the
 * indexing bridges keep their degrade-to-[] behavior.
 */
export function resolveEnginePath(
  configured: string,
  opts: ResolveEnginePathOptions = {},
): ResolvedEnginePath {
  const exists = opts.exists ?? fs.existsSync;
  const trimmed = configured.trim();
  if (trimmed) {
    return { enginePath: trimmed, source: "setting", layout: detectEngineLayout(trimmed, exists) ?? "tree" };
  }
  const candidate = bundledEnginePath(opts.appRoot ?? vscode.env?.appRoot);
  if (candidate) {
    const layout = detectEngineLayout(candidate, exists);
    if (layout) {
      return { enginePath: candidate, source: "bundled", layout };
    }
    if (exists(candidate)) {
      // Bundled directory present but neither marker: broken package.
      // Do NOT fall through to the dev checkout (spec §5.1).
      return { enginePath: "", source: "none", layout: "tree", bundledBroken: candidate };
    }
  }
  return { enginePath: defaultEnginePath(), source: "dev", layout: "tree" };
}

/**
 * Resolve the bun binary for an already-resolved TREE engine: the bun
 * shipped inside the engine root wins; otherwise fall back to `bun` on
 * PATH (today's behavior for dev/setting checkouts). Resolving bun FROM
 * the resolved engine path — never independently from the app root —
 * keeps engine and bun versions paired. Binary-layout engines never
 * spawn bun; callers pass this value through and the adapters ignore it
 * on the binary branch.
 *
 * `onBundledBunMissing` fires when a bundled tree engine's own bun is
 * absent so the caller can log the fallback instead of hiding it.
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
    if (resolved.source === "bundled" && resolved.layout === "tree") {
      onBundledBunMissing?.(candidate);
    }
  }
  return "bun";
}

/**
 * Spawn cwd for a bundled engine (spec §4 / decision D5, BRANCH B): the
 * install tree may be read-only (.deb under /usr, AppImage mount), and
 * the engine's location fallback would otherwise try to write its
 * codebase index into `<cwd>/.ide-code/index` inside the tree.
 * Bundled engines (BOTH layouts) therefore spawn from a writable
 * user-data directory: `<globalStorage>/engine-runtime`. Dev/setting
 * engines keep cwd = enginePath (returns undefined).
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
    `[ide-agent] Bundled engine is incomplete: ${candidate} exists but contains neither ` +
    `the compiled engine binary (${BUNDLED_BINARY_FILE}) nor packages/cli/src/index.ts. ` +
    `Reinstall the app, or set the ide.agent.enginePath setting (machine scope) to a valid engine checkout.`
  );
}
