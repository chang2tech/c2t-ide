/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Pure helpers for building remote file URLs ("permalinks").
 *
 * Behavior mirrors Cursor's glass permalink service (binary evidence in
 * `out/vs/workbench/workbench.glass.main.js`, Cursor 3.25.6, service id
 * `glassPermalinkService`):
 * - only GitHub hosts (including `*.ghe.com`) produce URLs; other hosts are
 *   rejected (`_isSupportedRemoteHostname`: `includes("github")` or
 *   `endsWith(".ghe.com")`),
 * - the revision segment is the upstream commit SHA (a permalink), placed at
 *   `/{owner}/{repo}/blob/{revision}/{path}`,
 * - line anchors are `#L{start}` for a single line and `#L{start}-L{end}` for
 *   a range.
 *
 * This module is intentionally dependency-free so the URL construction can be
 * unit tested in isolation.
 */

export interface IRemoteFileLineRange {
	readonly startLine: number;
	readonly endLine: number;
}

export interface IBuildRemoteFileUrlOptions {
	/** The git remote URL (https or scp-like ssh form), e.g. `git@github.com:owner/repo.git`. */
	readonly remoteUrl: string;
	/** The revision to link to. Cursor uses the upstream commit SHA (permalink). */
	readonly revision: string;
	/** File path relative to the repository root. */
	readonly relativeFilePath: string;
	readonly lineRange?: IRemoteFileLineRange;
}

/**
 * Expands scp-like git URLs (`[user@]host:path`) to a parseable URL string.
 * (Cursor: `oXa`)
 */
function expandScpLikeSyntax(value: string): string {
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
		return value;
	}
	const withScheme = `https://${value}`;
	try {
		new URL(withScheme);
		return withScheme;
	} catch {
		const scp = value.match(/^([^@/\s]+@)?([^:/\s]+):(.+)$/);
		if (scp) {
			const user = scp[1] ?? '';
			return `ssh://${user}${scp[2]}/${scp[3]}`;
		}
		return withScheme;
	}
}

/**
 * Normalizes a URL pathname: strips trailing slashes and a `.git` suffix,
 * guarantees a leading slash, returns `''` when nothing meaningful remains.
 * (Cursor: `Hes`)
 */
function normalizePathname(pathname: string): string {
	let end = pathname.length;
	while (end > 0 && pathname.charCodeAt(end - 1) === 47 /* Slash */) {
		end--;
	}
	const stripped = pathname.slice(0, end).replace(/\.git$/i, '');
	if (!stripped || stripped === '/') {
		return '';
	}
	return stripped.startsWith('/') ? stripped : `/${stripped}`;
}

/**
 * Fallback for remote URLs that fail `new URL(...)`: extracts
 * `host/path` (lowercased) from scp-like or scheme-prefixed values.
 * (Cursor: `V1k`)
 */
function parseToHostAndPath(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) {
		return '';
	}
	try {
		const url = new URL(expandScpLikeSyntax(trimmed));
		const path = normalizePathname(url.pathname);
		return path ? `${url.hostname}${path}`.toLowerCase() : '';
	} catch {
		const withoutScheme = trimmed.replace(/^(?:https?|ssh|git):\/\//i, '');
		const slash = withoutScheme.indexOf('/');
		const hostPart = slash === -1 ? withoutScheme : withoutScheme.slice(0, slash);
		const pathPart = slash === -1 ? '' : withoutScheme.slice(slash);
		const host = hostPart.includes('@') ? hostPart.slice(hostPart.lastIndexOf('@') + 1) : hostPart;
		const path = normalizePathname(pathPart);
		return path ? `${host}${path}`.toLowerCase() : '';
	}
}

/**
 * Normalizes a git remote URL to an `https://host/owner/repo` base URL
 * (no `.git` suffix, no credentials, no trailing slash).
 * (Cursor: `EO`)
 */
export function normalizeRemoteUrl(remoteUrl: string): string {
	const value = remoteUrl.trim();
	if (!value) {
		return '';
	}
	try {
		const url = new URL(expandScpLikeSyntax(value));
		const protocol = url.protocol === 'http:' || url.protocol === 'https:' ? url.protocol : 'https:';
		const host = url.host.toLowerCase();
		const path = normalizePathname(url.pathname);
		return path ? `${protocol}//${host}${path}` : '';
	} catch {
		const hostAndPath = parseToHostAndPath(value);
		return hostAndPath ? `https://${hostAndPath}` : '';
	}
}

/**
 * Parses a git remote URL (including scp-like ssh syntax) into a `URL`,
 * or `null` when it cannot be parsed. (Cursor: `N_0`)
 */
function parseGitUrl(value: string): URL | null {
	try {
		let normalized = value;
		if (value.includes('@') && !value.startsWith('http')) {
			normalized = value.startsWith('ssh://')
				? value
				: value.replace(/^([^@]+)@([^:]+):(.*)/, 'ssh://$1@$2/$3');
		}
		return new URL(normalized);
	} catch {
		return null;
	}
}

/**
 * Extracts the repository path from a git remote URL. For GitHub(-enterprise)
 * hosts this is `owner/repo`. (Cursor: `HPi`)
 */
export function extractRepositoryPath(remoteUrl: string): string | undefined {
	if (!remoteUrl) {
		return undefined;
	}
	const normalized = remoteUrl.replace('https///', 'https://').replace('http///', 'http://');
	if (normalized.startsWith('gitlab-remote://')) {
		try {
			const project = new URL(normalized).searchParams.get('project');
			if (project) {
				return project.includes('/') ? project : undefined;
			}
		} catch {
			// fall through to generic parsing
		}
	}
	const url = parseGitUrl(normalized);
	if (!url) {
		return undefined;
	}
	const hostname = url.hostname.toLowerCase();
	const segments = url.pathname.split('/').filter(segment => segment.length > 0);
	if (segments.length > 0 && segments[segments.length - 1].endsWith('.git')) {
		segments[segments.length - 1] = segments[segments.length - 1].slice(0, -4);
	}
	if (hostname === 'dev.azure.com' || hostname === 'ssh.dev.azure.com' || hostname.endsWith('.visualstudio.com')) {
		const parts = [...segments];
		if (hostname === 'ssh.dev.azure.com' && parts.length > 0 && parts[0].toLowerCase() === 'v3') {
			parts.shift();
		}
		const filtered = parts.filter(part => part.toLowerCase() !== '_git');
		return filtered.length >= 1 ? filtered.join('/') : undefined;
	}
	if (hostname.includes('github') || hostname.endsWith('.ghe.com')) {
		return segments.length >= 2 ? segments.slice(0, 2).join('/') : undefined;
	}
	if (hostname.includes('gitlab')) {
		return segments.length >= 1 ? segments.join('/') : undefined;
	}
	if (hostname.includes('bitbucket') || hostname.includes('stash')) {
		if (segments.length >= 3 && segments[0].toLowerCase() === 'scm') {
			return segments.slice(1, 3).join('/');
		}
		return segments.length >= 2 ? segments.slice(0, 2).join('/') : undefined;
	}
	const isGerrit = hostname.includes('gerrit');
	const hasGerritPrefix = segments.length > 0 && segments[0].toLowerCase() === 'gerrit';
	if (isGerrit || hasGerritPrefix) {
		const parts = [...segments];
		if (hasGerritPrefix) {
			parts.shift();
		}
		if (parts.length > 0 && parts[0].toLowerCase() === 'a') {
			parts.shift();
		}
		return parts.length >= 1 ? parts.join('/') : undefined;
	}
	return segments.length >= 2 ? segments.slice(0, 2).join('/') : undefined;
}

/** (Cursor: `mht._isSupportedRemoteHostname`) */
export function isSupportedRemoteHostname(hostname: string): boolean {
	const value = hostname.toLowerCase();
	return value.includes('github') || value.endsWith('.ghe.com');
}

/** (Cursor: `mht._isSupportedRemoteUrl`) */
export function isSupportedRemoteUrl(remoteUrl: string): boolean {
	const normalized = normalizeRemoteUrl(remoteUrl);
	if (!normalized) {
		return false;
	}
	try {
		return isSupportedRemoteHostname(new URL(normalized).hostname);
	} catch {
		return false;
	}
}

/** Percent-encodes each `/`-separated path segment. (Cursor: `mht._encodePathSegments`) */
export function encodePathSegments(path: string): string {
	return path.replace(/\\/g, '/').split('/').filter(Boolean).map(segment => encodeURIComponent(segment)).join('/');
}

/**
 * Builds the remote file URL, or `undefined` when it cannot be built.
 * (Cursor: `mht._buildRemoteFileUrl`)
 */
export function buildRemoteFileUrl(options: IBuildRemoteFileUrlOptions): string | undefined {
	const revision = options.revision?.trim();
	const relativeFilePath = options.relativeFilePath?.replace(/^\/+|\/+$/g, '');
	if (!options.remoteUrl || !revision || !relativeFilePath) {
		return undefined;
	}
	const repositoryPath = extractRepositoryPath(options.remoteUrl);
	if (!repositoryPath) {
		return undefined;
	}
	const normalized = normalizeRemoteUrl(options.remoteUrl);
	if (!normalized) {
		return undefined;
	}
	let url: URL;
	try {
		url = new URL(normalized);
	} catch {
		return undefined;
	}
	if (!isSupportedRemoteHostname(url.hostname)) {
		return undefined;
	}
	url.pathname = `/${repositoryPath}/blob/${encodeURIComponent(revision)}/${encodePathSegments(relativeFilePath)}`;
	url.search = '';
	url.hash = '';
	if (options.lineRange) {
		const { startLine, endLine } = options.lineRange;
		url.hash = startLine === endLine ? `L${startLine}` : `L${startLine}-L${endLine}`;
	}
	return url.toString();
}
