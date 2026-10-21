/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { ensureNpmPackage, type EnsureNpmPackageOptions } from './npmPackage.ts';

/**
 * Packaging defence for the per-platform satellite packages of
 * `@anthropic-ai/claude-agent-sdk` and `@parcel/watcher`, following the same
 * three-layer model as Copilot (`build/lib/copilot.ts`) and os-proxy-resolver
 * (`build/lib/osProxyResolver.ts`):
 *
 * 1. `build/.moduleignore` strips every platform package of both families.
 * 2. `get<Family>PlatformFiles` re-adds only the target platform's package
 *    during packaging (see `build/gulpfile.vscode.ts`).
 * 3. `get<Family>ExcludeFilter` drops non-target packages from the merged
 *    stream, and `ensure<Family>PlatformPackage` fails the build when npm
 *    did not install the target package.
 *
 * Until now these families relied solely on npm only installing
 * host-compatible optional dependencies. That is not a packaging guarantee:
 * on a glibc host npm also installs `@parcel/watcher-linux-x64-musl`, which
 * then leaked into the Linux glibc package.
 */

// The musl variants are only selected for alpine targets, but must be listed
// so they are excluded from every other target's packaging.
export const claudeAgentSdkPlatforms = [
	'darwin-arm64', 'darwin-x64',
	'linux-arm64', 'linux-arm64-musl', 'linux-x64', 'linux-x64-musl',
	'win32-arm64', 'win32-x64',
];

/**
 * Maps a VS Code build platform/arch to the `@anthropic-ai/claude-agent-sdk-*`
 * package suffix. Mirrors `getSdkTargetForBuild(..., 'claude')` in
 * `build/agent-sdk/common.ts`: regular Linux uses the glibc `linux-*`
 * packages, alpine uses the `linux-*-musl` packages, and only x64/arm64
 * builds have an SDK package at all.
 */
function toClaudeAgentSdkPlatform(platform: string, arch: string): string | undefined {
	// Normalize the legacy Alpine x64 encoding into the modern one.
	if (platform === 'linux' && arch === 'alpine') {
		platform = 'alpine';
		arch = 'x64';
	}
	if (arch !== 'x64' && arch !== 'arm64') {
		return undefined;
	}
	switch (platform) {
		case 'darwin': return `darwin-${arch}`;
		case 'win32': return `win32-${arch}`;
		case 'linux': return `linux-${arch}`;
		case 'alpine': return `linux-${arch}-musl`;
	}
	return undefined;
}

export function getClaudeAgentSdkPlatformFiles(platform: string, arch: string, nodeModulesRoot = 'node_modules'): string[] {
	const target = toClaudeAgentSdkPlatform(platform, arch);
	return target ? [path.posix.join(nodeModulesRoot, '@anthropic-ai', `claude-agent-sdk-${target}`, '**')] : [];
}

export function getClaudeAgentSdkExcludeFilter(platform: string, arch: string): string[] {
	const target = toClaudeAgentSdkPlatform(platform, arch);
	return [
		'**',
		...claudeAgentSdkPlatforms
			.filter(candidate => candidate !== target)
			.map(candidate => `!**/node_modules/@anthropic-ai/claude-agent-sdk-${candidate}/**`),
	];
}

export function ensureClaudeAgentSdkPlatformPackage(platform: string, arch: string, nodeModulesRoot = 'node_modules', options: EnsureNpmPackageOptions = {}): void {
	const target = toClaudeAgentSdkPlatform(platform, arch);
	if (!target) {
		return;
	}

	const packageName = `@anthropic-ai/claude-agent-sdk-${target}`;
	ensureNpmPackage(packageName, nodeModulesRoot, options);

	// The platform package ships a single native binary at its root
	// (`claude` / `claude.exe`, see `build/agent-sdk/package.ts`). npm can
	// leave an empty directory behind for an optional dependency it did not
	// install, so existence of the directory alone is not proof.
	const packageDir = path.join(nodeModulesRoot, '@anthropic-ai', `claude-agent-sdk-${target}`);
	const binary = target.startsWith('win32') ? 'claude.exe' : 'claude';
	if (!fs.existsSync(path.join(packageDir, binary))) {
		throw new Error(`[ensureClaudeAgentSdkPlatformPackage] ${packageName} is missing its native binary '${binary}' in ${packageDir}.`);
	}
}

// The android/freebsd variants are never selected as a target (VS Code does
// not build for them), but must be listed so they are excluded from packaging.
export const parcelWatcherPlatforms = [
	'android-arm64',
	'darwin-arm64', 'darwin-x64',
	'freebsd-x64',
	'linux-arm-glibc', 'linux-arm-musl', 'linux-arm64-glibc', 'linux-arm64-musl', 'linux-x64-glibc', 'linux-x64-musl',
	'win32-arm64', 'win32-ia32', 'win32-x64',
];

/**
 * Maps a VS Code build platform/arch to the `@parcel/watcher-*` package
 * suffix. Unlike the Claude Agent SDK, the watcher packages encode the libc
 * in the suffix for every Linux target: `linux-<arch>-glibc` for regular
 * Linux builds and `linux-<arch>-musl` for alpine. This matches the name
 * `@parcel/watcher` itself resolves at runtime
 * (`@parcel/watcher-<platform>-<arch>[-<libc>]`).
 */
function toParcelWatcherPlatform(platform: string, arch: string): string | undefined {
	// Normalize the legacy Alpine x64 encoding into the modern one.
	if (platform === 'linux' && arch === 'alpine') {
		platform = 'alpine';
		arch = 'x64';
	}
	// VS Code build uses 'armhf'; the watcher packages use Node's 'arm'.
	const nodeArch = arch === 'armhf' ? 'arm' : arch;
	switch (platform) {
		case 'darwin':
			return nodeArch === 'arm64' || nodeArch === 'x64' ? `darwin-${nodeArch}` : undefined;
		case 'win32':
			return nodeArch === 'arm64' || nodeArch === 'ia32' || nodeArch === 'x64' ? `win32-${nodeArch}` : undefined;
		case 'linux':
			return nodeArch === 'arm' || nodeArch === 'arm64' || nodeArch === 'x64' ? `linux-${nodeArch}-glibc` : undefined;
		case 'alpine':
			return nodeArch === 'arm' || nodeArch === 'arm64' || nodeArch === 'x64' ? `linux-${nodeArch}-musl` : undefined;
	}
	return undefined;
}

export function getParcelWatcherPlatformFiles(platform: string, arch: string, nodeModulesRoot = 'node_modules'): string[] {
	const target = toParcelWatcherPlatform(platform, arch);
	return target ? [path.posix.join(nodeModulesRoot, '@parcel', `watcher-${target}`, '**')] : [];
}

export function getParcelWatcherExcludeFilter(platform: string, arch: string): string[] {
	const target = toParcelWatcherPlatform(platform, arch);
	return [
		'**',
		...parcelWatcherPlatforms
			.filter(candidate => candidate !== target)
			.map(candidate => `!**/node_modules/@parcel/watcher-${candidate}/**`),
	];
}

export function ensureParcelWatcherPlatformPackage(platform: string, arch: string, nodeModulesRoot = 'node_modules', options: EnsureNpmPackageOptions = {}): void {
	const target = toParcelWatcherPlatform(platform, arch);
	if (!target) {
		return;
	}

	const packageName = `@parcel/watcher-${target}`;
	ensureNpmPackage(packageName, nodeModulesRoot, options);

	// npm can leave an empty directory behind for an optional dependency it
	// did not install, so existence of the directory alone is not proof.
	const packageDir = path.join(nodeModulesRoot, '@parcel', `watcher-${target}`);
	const requiredFiles = ['package.json', 'watcher.node'];
	const missingFiles = requiredFiles.filter(file => !fs.existsSync(path.join(packageDir, file)));
	if (missingFiles.length > 0) {
		throw new Error(`[ensureParcelWatcherPlatformPackage] ${packageName} is missing files in ${packageDir}: ${missingFiles.join(', ')}.`);
	}
}
