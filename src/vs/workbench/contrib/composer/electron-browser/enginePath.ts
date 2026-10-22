/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: ENGINE PACKAGING (spec engine-packaging-spec-v1 §5, design W4 §1.3).
//
// The workbench-side engine-path resolver. The pure helpers live in the
// node-free common layer (`../common/composerDataService.ts`); this
// electron-browser module adds the filesystem existence checks and the
// `INativeEnvironmentService` inputs (appRoot / userDataPath), which only
// exist on desktop.
//
// ONE algorithm, same semantics as the extension resolver
// (`extensions/ide-agent/src/services/enginePath.ts`). Priority (D2):
//   1. the `ide.agent.enginePath` setting (machine scope), used verbatim;
//   2. the engine bundled with the packaged app at `<appRoot>/engine` —
//      only when its serve entry exists;
//   3. the dev fallback `~/workspace/ide-code` — ONLY when no bundled
//      directory exists on disk at all.
// A bundled directory that exists but lacks the serve entry is a broken
// package: resolution stops with source "none" (+ `bundledBroken`) instead
// of silently falling through to a dev checkout on the user's machine.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import {
	BUNDLED_BUN_RELATIVE,
	bundledEnginePathFromAppRoot,
	defaultEnginePath,
} from '../common/composerDataService.js';

export type EnginePathSource = 'setting' | 'bundled' | 'dev' | 'none';

export interface ResolvedEnginePath {
	enginePath: string;
	source: EnginePathSource;
	/** Set when source is "none" because a bundled engine directory exists
	 *  on disk but its serve entry is missing (broken packaging). */
	bundledBroken?: string;
}

/** Serve entry of the engine, relative to an engine root. This exact file
 *  is what IdeCodeEngineAdapter validates before spawning. */
export const ENGINE_CLI_ENTRY_REL = path.join('packages', 'cli', 'src', 'index.ts');

/** One-shot indexing CLI entry, relative to an engine root. */
export const ENGINE_INDEX_ENTRY_REL = path.join('packages', 'core', 'src', 'indexing', 'cli.ts');

/** Solid preload script inside a staged engine closure, relative to an
 *  engine root. F-W4-1 delta (adjudication N1, w6-f-w4-1-experiment.md
 *  §6.1): Bun only loads bunfig.toml at the exact spawn cwd, so the
 *  relative preload in the engine root bunfig never fires for a bundled
 *  spawn whose cwd is the user-data dir (spec §4). The serve adapters
 *  pass this file to bun as an absolute `--preload` argument instead.
 *  MUST match the extension constant of the same name in
 *  `extensions/ide-agent/src/services/enginePath.ts`. */
export const ENGINE_SOLID_PRELOAD_REL = path.join('packages', 'cli', 'node_modules', '@opentui', 'solid', 'scripts', 'preload.js');

/** Absolute path of the Solid preload script for an engine root. */
export function bundledServePreloadPath(enginePath: string): string {
	return path.join(enginePath, ENGINE_SOLID_PRELOAD_REL);
}

/**
 * The single D2 resolution algorithm (see module docstring). The
 * `configured` value is NOT validated here: for source "setting" the
 * adapter keeps its existing `Invalid enginePath` throw, and the
 * indexing service keeps its degrade-to-[] behavior.
 */
export function resolveEnginePath(
	configured: string,
	environmentService: INativeEnvironmentService,
	exists: (p: string) => boolean = fs.existsSync,
): ResolvedEnginePath {
	const trimmed = configured.trim();
	if (trimmed) {
		return { enginePath: trimmed, source: 'setting' };
	}
	const candidate = bundledEnginePathFromAppRoot(environmentService.appRoot);
	if (candidate) {
		if (exists(path.join(candidate, ENGINE_CLI_ENTRY_REL))) {
			return { enginePath: candidate, source: 'bundled' };
		}
		if (exists(candidate)) {
			// Bundled directory present but entry missing: broken package.
			// Do NOT fall through to the dev checkout (spec §5.1).
			return { enginePath: '', source: 'none', bundledBroken: candidate };
		}
	}
	return { enginePath: defaultEnginePath(), source: 'dev' };
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
		if (resolved.source === 'bundled') {
			onBundledBunMissing?.(candidate);
		}
	}
	return 'bun';
}

/**
 * Spawn cwd for a bundled engine (spec §4, BRANCH B): the install tree
 * may be read-only (.deb under /usr, AppImage mount), and the engine's
 * location fallback would otherwise try to write its codebase index
 * into `<cwd>/.ide-code/index`. Bundled engines therefore spawn from a
 * writable user-data directory: `<userDataPath>/engine-runtime`.
 * Dev/setting engines keep cwd = enginePath (returns undefined).
 * The directory itself is created by the adapter immediately before
 * spawn, not here.
 */
export function resolveEngineSpawnCwd(
	resolved: ResolvedEnginePath,
	environmentService: INativeEnvironmentService,
): string | undefined {
	if (resolved.source !== 'bundled') {
		return undefined;
	}
	return path.join(environmentService.userDataPath, 'engine-runtime');
}

/** User-facing diagnostic for a broken bundled engine (spec §5.1). */
export function bundledIncompleteDiagnostic(candidate: string): string {
	return (
		`[ide-agent] Bundled engine is incomplete: ${candidate} exists but ` +
		`packages/cli/src/index.ts is missing. Reinstall the app, or set the ` +
		`ide.agent.enginePath setting (machine scope) to a valid engine checkout.`
	);
}
