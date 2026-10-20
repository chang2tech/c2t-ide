/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Where a built-in extension is downloaded from at build time.
 *
 * This mirrors the branch order in `getExtensionDownloadStream`
 * (build/lib/builtInExtensions.ts). It is a pure function in a
 * zero-dependency module so it can be unit-tested without pulling in the
 * gulp/vinyl dependency graph of the build script.
 *
 * NOTE (XQA-05 P2 "builtInExtensions fetched from Microsoft repos" — REFUTED):
 * the `repo` field in product.json is NOT consulted on the marketplace path.
 * When `extensionsGallery.serviceUrl` is configured (ours: open-vsx.org),
 * entries download via `fromMarketplace`, which destructures only
 * `{ name, version, sha256, metadata }` — `repo` is ignored. `repo` is only a
 * fallback for gallery-less builds (the final `github` branch below).
 */
export type BuiltInExtensionDownloadSource = 'vsix' | 'github' | 'marketplace';

export interface BuiltInExtensionDownloadFlags {
	vsix?: string;
	platformSpecific?: { [target: string]: string };
}

export function getBuiltInExtensionDownloadSource(
	extension: BuiltInExtensionDownloadFlags,
	galleryServiceUrl: string | undefined
): BuiltInExtensionDownloadSource {
	if (extension.vsix) {
		return 'vsix';
	}
	if (extension.platformSpecific) {
		// Platform-specific extensions publish per-target VSIX assets on a
		// GitHub release; the marketplace does not serve those assets, so they
		// are always downloaded from GitHub even when a gallery is configured.
		return 'github';
	}
	if (galleryServiceUrl) {
		return 'marketplace';
	}
	return 'github';
}
