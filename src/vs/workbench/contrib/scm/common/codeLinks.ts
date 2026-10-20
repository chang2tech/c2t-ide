/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Pure helpers for building `cursor.com/codebase` links, mirroring the logic
 * shipped with Cursor's `cursorOrigin.copyCodeLink*` commands (verified in the
 * Cursor 3.25.6/3.25.9 `workbench.desktop.main.js` bundle):
 *
 *  - remotes are scanned against a fixed host allowlist
 *    (`origin.cursor.com`, `origin-staging.cursor.com`, `github.com`),
 *  - the slug is only usable when its owner is in the eligible-owner
 *    allowlist (`anysphere`, `withgraphite`),
 *  - the resulting URL is
 *    `https://cursor.com/codebase/<owner>/<repo>/blob/<ref>/<path>[#L<start>[-L<end>]]`
 *    with every path segment passed through `encodeURIComponent`.
 *
 * This module intentionally has no workbench imports so it can be unit tested
 * in isolation.
 */

export interface ICodeLinkRemote {
	readonly name?: string;
	readonly fetchUrl?: string;
}

export interface ICodeLinkSlug {
	readonly owner: string;
	readonly repo: string;
}

export interface ICodeLinkLineRange {
	readonly startLine: number;
	readonly endLine: number;
}

/** Base URL of every generated code link. */
export const CODE_LINK_BASE_URL = 'https://cursor.com/codebase';

/** Hosts whose remotes are eligible for code links, in priority order. */
export const CODE_LINK_HOSTS: readonly string[] = [
	'origin.cursor.com',
	'origin-staging.cursor.com',
	'github.com'
];

const ELIGIBLE_OWNERS = new Set(['anysphere', 'withgraphite'].map(owner => owner.trim().toLowerCase()).filter(Boolean));

function stripGitSuffix(segment: string): string {
	return segment.replace(/\.git$/i, '');
}

function slugFromPathSegments(segments: string[]): ICodeLinkSlug | undefined {
	const cleaned = segments.map(stripGitSuffix).filter(segment => segment.length > 0);
	if (cleaned.length > 0 && cleaned[0].toLowerCase() === 'git') {
		cleaned.shift();
	}
	if (cleaned.length < 2) {
		return undefined;
	}
	const repo = cleaned[cleaned.length - 1];
	return { owner: cleaned.slice(0, -1).join('/'), repo };
}

/**
 * Extracts the `{ owner, repo }` slug from a single remote fetch URL when it
 * points at the given host. Supports `https://`, `ssh://` and scp-like
 * (`user@host:path`) remote URL forms, exactly like Cursor does.
 */
export function getCodeLinkSlugFromRemoteUrl(fetchUrl: string | undefined, host: string): ICodeLinkSlug | undefined {
	const trimmed = fetchUrl?.trim();
	if (!trimmed) {
		return undefined;
	}

	const expectedHost = host.toLowerCase();
	if (/^https:\/\//i.test(trimmed)) {
		let url: URL;
		try {
			url = new URL(trimmed);
		} catch {
			return undefined;
		}
		if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== expectedHost) {
			return undefined;
		}
		return slugFromPathSegments(url.pathname.split('/').filter(Boolean));
	}
	if (/^ssh:\/\//i.test(trimmed)) {
		let url: URL;
		try {
			url = new URL(trimmed);
		} catch {
			return undefined;
		}
		if (url.protocol !== 'ssh:' || url.hostname.toLowerCase() !== expectedHost) {
			return undefined;
		}
		return slugFromPathSegments(url.pathname.split('/').filter(Boolean));
	}

	const escapedHost = expectedHost.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const scpLike = new RegExp(`^[^@\\s]+@${escapedHost}:([^\\s]+)$`, 'i').exec(trimmed);
	if (scpLike?.[1]) {
		return slugFromPathSegments(scpLike[1].split('/'));
	}
	return undefined;
}

/**
 * Finds the first eligible slug for a repository's remotes. Hosts are tried
 * in {@link CODE_LINK_HOSTS} order and, within a host, remotes in list order.
 */
export function getCodeLinkSlug(remotes: readonly ICodeLinkRemote[] | undefined): ICodeLinkSlug | undefined {
	if (!remotes) {
		return undefined;
	}
	for (const host of CODE_LINK_HOSTS) {
		for (const remote of remotes) {
			if (!remote.fetchUrl) {
				continue;
			}
			const slug = getCodeLinkSlugFromRemoteUrl(remote.fetchUrl, host);
			if (slug) {
				return slug;
			}
		}
	}
	return undefined;
}

/** Whether a slug owner is eligible for code links (case-insensitive). */
export function isEligibleCodeLinkOwner(owner: string): boolean {
	return ELIGIBLE_OWNERS.has(owner.trim().toLowerCase());
}

/** Encodes each `/`-separated path segment with `encodeURIComponent`. */
export function encodeCodeLinkPath(path: string): string {
	return path.split('/').map(segment => encodeURIComponent(segment)).join('/');
}

/** Builds the final `cursor.com/codebase` link for a repository file. */
export function buildCodeLink(slug: ICodeLinkSlug, refKey: string, relativePath: string, lineRange?: ICodeLinkLineRange): string {
	const refSegment = `/${encodeCodeLinkPath(refKey)}`;
	const fileSegment = encodeCodeLinkPath(`/${relativePath}`);
	let hash = '';
	if (lineRange) {
		hash = `#L${lineRange.startLine}`;
		if (lineRange.startLine !== lineRange.endLine) {
			hash += `-L${lineRange.endLine}`;
		}
	}
	return `${CODE_LINK_BASE_URL}/${slug.owner}/${slug.repo}/blob${refSegment}${fileSegment}${hash}`;
}
