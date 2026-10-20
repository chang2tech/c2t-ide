/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IMcpSandboxConfiguration } from '../../../../platform/mcp/common/mcpPlatformTypes.js';

/**
 * Per-server MCP network modes (cursor.com/docs, "MCP" section).
 *
 * REA evidence (verbatim): "Network modes: Allow all / Allowlist / Deny all /
 * No sandbox (per-server)" (docs/rea/deep-docs-all.md, docs sweep
 * 2026-10-18). The exact config-field spelling and enforcement internals were
 * not recoverable from the reference (`mcp.networkControls` /
 * `mcp.networkResume` channel semantics are UNKNOWN per
 * docs/rea/deep-mcp.md §10), so this module defines the mode model, maps it
 * onto this fork's existing sandbox configuration
 * (`IMcpSandboxConfiguration`), and provides the enforcement predicate used
 * at connection time.
 *
 * Feature: `mcp-network-modes` (P2).
 */

/**
 * The four per-server network modes. String values are this fork's
 * serialization; they are also accepted (case-insensitively, with `-`/space
 * variants) when parsing `mcp.json`.
 */
export const enum CursorMcpNetworkMode {
	/** The server may reach any network host. Filesystem sandboxing may still apply. */
	AllowAll = 'allowAll',
	/** The server may only reach the configured `allowedDomains`. */
	Allowlist = 'allowlist',
	/** The server may not reach any network host. */
	DenyAll = 'denyAll',
	/** No sandbox is applied to the server at all. */
	NoSandbox = 'noSandbox',
}

export interface ICursorMcpNetworkPolicy {
	readonly mode: CursorMcpNetworkMode;
	/** Domains the server may reach. Only meaningful for {@link CursorMcpNetworkMode.Allowlist}. */
	readonly allowedDomains: readonly string[] | undefined;
}

const _modeByNormalizedName = new Map<string, CursorMcpNetworkMode>([
	['allowall', CursorMcpNetworkMode.AllowAll],
	['allow-all', CursorMcpNetworkMode.AllowAll],
	['allow all', CursorMcpNetworkMode.AllowAll],
	['allowlist', CursorMcpNetworkMode.Allowlist],
	['allow-list', CursorMcpNetworkMode.Allowlist],
	['allow list', CursorMcpNetworkMode.Allowlist],
	['whitelist', CursorMcpNetworkMode.Allowlist],
	['denyall', CursorMcpNetworkMode.DenyAll],
	['deny-all', CursorMcpNetworkMode.DenyAll],
	['deny all', CursorMcpNetworkMode.DenyAll],
	['blacklist', CursorMcpNetworkMode.DenyAll],
	['nosandbox', CursorMcpNetworkMode.NoSandbox],
	['no-sandbox', CursorMcpNetworkMode.NoSandbox],
	['no sandbox', CursorMcpNetworkMode.NoSandbox],
	['disabled', CursorMcpNetworkMode.NoSandbox],
	['off', CursorMcpNetworkMode.NoSandbox],
]);

/**
 * Parses a per-server `networkMode` value from `mcp.json`. Returns
 * `undefined` for missing/unrecognized values (callers fall back to deriving
 * the policy from the sandbox configuration).
 */
export function parseCursorMcpNetworkMode(value: unknown): CursorMcpNetworkMode | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}
	return _modeByNormalizedName.get(value.trim().toLowerCase());
}

function toDomainList(value: unknown): readonly string[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const domains = value.filter((d): d is string => typeof d === 'string' && d.length > 0).map(d => d.toLowerCase());
	return domains.length > 0 ? domains : undefined;
}

/**
 * Resolves the effective per-server network policy. An explicit `networkMode`
 * wins; otherwise the policy is derived from an existing sandbox
 * configuration (a configured network allowlist implies `allowlist`); with
 * neither configured the policy is `allowAll` (no restrictions configured =
 * no restrictions enforced).
 */
export function resolveCursorMcpNetworkPolicy(input: {
	readonly networkMode?: unknown;
	readonly allowedDomains?: unknown;
	readonly sandbox?: IMcpSandboxConfiguration;
}): ICursorMcpNetworkPolicy {
	const mode = parseCursorMcpNetworkMode(input.networkMode);
	const allowedDomains = toDomainList(input.allowedDomains) ?? toDomainList(input.sandbox?.network?.allowedDomains);
	if (mode !== undefined) {
		return { mode, allowedDomains: mode === CursorMcpNetworkMode.Allowlist ? allowedDomains : undefined };
	}
	if (input.sandbox?.network && (input.sandbox.network.allowedDomains !== undefined || input.sandbox.network.deniedDomains !== undefined)) {
		return { mode: CursorMcpNetworkMode.Allowlist, allowedDomains };
	}
	return { mode: CursorMcpNetworkMode.AllowAll, allowedDomains: undefined };
}

/**
 * Maps a network policy onto the fork's sandbox configuration consumed by
 * `IMcpSandboxService.launchInSandboxIfEnabled`:
 * - `noSandbox` → `undefined` (no sandbox applied at all)
 * - `allowAll` → empty sandbox config (sandbox may apply, no network restriction)
 * - `allowlist` → sandbox with `network.allowedDomains`
 * - `denyAll` → sandbox with an empty network allowlist (no host allowed)
 */
export function cursorMcpNetworkPolicyToSandbox(policy: ICursorMcpNetworkPolicy): IMcpSandboxConfiguration | undefined {
	switch (policy.mode) {
		case CursorMcpNetworkMode.NoSandbox:
			return undefined;
		case CursorMcpNetworkMode.AllowAll:
			return {};
		case CursorMcpNetworkMode.Allowlist:
			return { network: { allowedDomains: [...(policy.allowedDomains ?? [])] } };
		case CursorMcpNetworkMode.DenyAll:
			return { network: { allowedDomains: [] } };
	}
}

function hostMatchesDomain(host: string, domain: string): boolean {
	const h = host.toLowerCase();
	const d = domain.toLowerCase().replace(/^\*\./, '');
	return h === d || h.endsWith(`.${d}`);
}

/**
 * Enforcement predicate: whether `host` (a bare hostname, no port) may be
 * reached under `policy`. Used at connection time for HTTP(S) MCP servers and
 * anywhere else per-server egress is gated.
 */
export function isMcpNetworkHostAllowed(policy: ICursorMcpNetworkPolicy, host: string): boolean {
	switch (policy.mode) {
		case CursorMcpNetworkMode.AllowAll:
		case CursorMcpNetworkMode.NoSandbox:
			return true;
		case CursorMcpNetworkMode.DenyAll:
			return false;
		case CursorMcpNetworkMode.Allowlist:
			return (policy.allowedDomains ?? []).some(domain => hostMatchesDomain(host, domain));
	}
}
