// IDE-CODE: Migrated from extensions/ide-agent/src/mcp/allowlist.ts (CAT-A, pure logic).
/**
 * MCP approval integration — Cursor 3.25.9 parity (WORKER-GAPS-30D,
 * audit items `mcp-approval-persistence` + `mcp-chat-scoped-grant-on-run`).
 * CAT-A port of extensions/ide-agent/src/mcp/allowlist.ts — keep the two
 * in sync.
 *
 * Binary evidence (workbench.glass.main.js 3.25.9, self-verified 2026-10-20):
 * - `mcp-approvals.json` = 0 hits in the glass AND desktop bundles — Cursor
 *   has NO project-level approvals file. The old `<project>/.cursor/
 *   mcp-approvals.json` persistence (allow|deny|ask per-tool decisions) was
 *   our invention and is REMOVED here. Legacy files on disk are never read
 *   again (left untouched, not deleted).
 * - "Always allow" → user-global reactive storage
 *   `composerState.mcpAllowedTools` (6
 *   `setApplicationUserPersistentStorage("composerState","mcpAllowedTools",…)`
 *   sites; normalized `server:tool`; no TTL — see P0
 *   `mcp-approval-ttl-claim-debunked`). Core mapping: `IStorageService`
 *   (`StorageScope.APPLICATION`, `StorageTarget.USER`).
 * - One-shot RUN → per-composer memory `mcpAllowedToolsForChat`:
 *   `case DJ.RUN: if(A&&!A.allowOnce){…z("mcpAllowedToolsForChat",
 *   K=>K?.includes(W)?K:[...K??[],W])}`.
 * - Consult = `[...getEffectiveMcpAllowlist(),
 *   ...mcpAllowedToolsForChat??[]]`, case-insensitive. The effective
 *   allowlist here = `.cursor/permissions.json` `mcpAllowlist` patterns
 *   (real Cursor surface, kept) + the global grant array.
 * - No client-side persistent-deny store (no `mcpDeniedTools`-like key).
 *
 * Merge order: allow (any source) → ask. The old deny>ask>allow ordering
 * existed only because the invented approvals file could record denies.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { McpGrantStore, McpLogger, McpPrecheckResult } from '../../common/mcp/types.js';

interface PermissionsFile {
	mcpAllowlist?: string[];
}

function readJson<T>(filePath: string, logger: McpLogger): T | undefined {
	let raw: string;
	try {
		raw = fs.readFileSync(filePath, 'utf8');
	} catch {
		return undefined;
	}
	try {
		return JSON.parse(raw) as T;
	} catch (err) {
		logger.appendLine(
			`[mcp] ${filePath}: invalid JSON (${err instanceof Error ? err.message : String(err)}) — ignoring`,
		);
		return undefined;
	}
}

/**
 * Match an allowlist pattern against server/tool.
 * Patterns: `server:tool`, `server:*`, `*:tool`, `*:*`.
 * Matching is case-sensitive on the server and tool names as configured.
 *
 * IDE-CODE EXTENSION of the concept (not verbatim Cursor): Cursor's
 * permissions-file allowlist entries are exact `server:tool` strings; the
 * wildcard forms are our documented convenience.
 */
export function matchAllowlistPattern(pattern: string, server: string, tool: string): boolean {
	const colon = pattern.indexOf(':');
	if (colon < 0) {
		return false;
	}
	const pServer = pattern.slice(0, colon).trim();
	const pTool = pattern.slice(colon + 1).trim();
	const serverOk = pServer === '*' || pServer === server;
	const toolOk = pTool === '*' || pTool === tool;
	return serverOk && toolOk;
}

/**
 * Normalize one grant entry to `server:tool`.
 *
 * The binary's normalizer (`I2i(N,O)`) is minified and unrecovered; the
 * audit records entries as normalized `server:tool` strings. Trimming is
 * our best-effort normalization — case is PRESERVED (the binary dedupes
 * case-sensitively on write: `K?.includes(W)`).
 */
export function normalizeGrantEntry(serverDisplayName: string, tool: string): string {
	return `${serverDisplayName.trim()}:${tool.trim()}`;
}

/** Case-insensitive membership — the binary's `WFf` consult compare. */
function grantsInclude(grants: readonly string[], entry: string): boolean {
	const want = entry.toLowerCase();
	return grants.some((g) => g.toLowerCase() === want);
}

export class McpAllowlist {
	private permissions = new Map<string, string[]>(); // root -> patterns

	/**
	 * @param grants approval grant storage. Optional for back-compat:
	 *   without it the precheck consults only `.cursor/permissions.json`
	 *   and the remember* methods log + no-op.
	 */
	constructor(
		private readonly workspaceFolders: string[],
		private readonly logger: McpLogger,
		private readonly grants?: McpGrantStore,
	) {
		this.reload();
	}

	/** Re-read `.cursor/permissions.json` from every workspace folder. */
	reload(): void {
		this.permissions.clear();
		for (const root of this.workspaceFolders) {
			const perms = readJson<PermissionsFile>(path.join(root, '.cursor', 'permissions.json'), this.logger);
			if (Array.isArray(perms?.mcpAllowlist)) {
				this.permissions.set(root, perms.mcpAllowlist.filter((p) => typeof p === 'string'));
			}
		}
	}

	/**
	 * The precheck the agent loop must call before executing an MCP tool.
	 *
	 * Consult order (Cursor: `[...getEffectiveMcpAllowlist(),
	 * ...mcpAllowedToolsForChat??[]]`, case-insensitive):
	 *   1. `.cursor/permissions.json` `mcpAllowlist` patterns → allow
	 *   2. user-global grants (`composerState.mcpAllowedTools`) → allow
	 *   3. per-composer chat grants (`mcpAllowedToolsForChat`) → allow
	 *   4. otherwise → ask (approval card)
	 */
	precheck(serverDisplayName: string, tool: string, composerId?: string): McpPrecheckResult {
		const entry = normalizeGrantEntry(serverDisplayName, tool);
		for (const [, patterns] of this.permissions) {
			const hit = patterns.find((p) => matchAllowlistPattern(p, serverDisplayName, tool));
			if (hit) {
				return {
					decision: 'allow',
					reason: `Allowlisted by .cursor/permissions.json pattern "${hit}"`,
					matchedRule: hit,
				};
			}
		}
		if (this.grants) {
			if (grantsInclude(this.grants.getGlobalGrants(), entry)) {
				return {
					decision: 'allow',
					reason: 'Allowed by user-global MCP allowlist (composerState.mcpAllowedTools)',
					matchedRule: entry,
				};
			}
			if (composerId && grantsInclude(this.grants.getChatGrants(composerId), entry)) {
				return {
					decision: 'allow',
					reason: 'Allowed for this chat (mcpAllowedToolsForChat)',
					matchedRule: entry,
				};
			}
		}
		return {
			decision: 'ask',
			reason: `mcpToolsProtection — "${serverDisplayName}" / ${tool} is not allowlisted`,
		};
	}

	/**
	 * "Always allow" — append to the user-global persistent grant array
	 * (`composerState.mcpAllowedTools`). No TTL, like the binary.
	 */
	rememberAlwaysAllow(serverDisplayName: string, tool: string): void {
		if (!this.grants) {
			this.logger.appendLine(
				`[mcp] rememberAlwaysAllow(${serverDisplayName}:${tool}): no grant store configured — choice not persisted`,
			);
			return;
		}
		this.grants.addGlobalGrant(normalizeGrantEntry(serverDisplayName, tool));
	}

	/**
	 * One-shot RUN — append to the per-composer in-memory grant set
	 * (`mcpAllowedToolsForChat`). Dies with the chat; never persisted.
	 */
	rememberChatGrant(composerId: string, serverDisplayName: string, tool: string): void {
		if (!this.grants) {
			this.logger.appendLine(
				`[mcp] rememberChatGrant(${composerId}, ${serverDisplayName}:${tool}): no grant store configured`,
			);
			return;
		}
		this.grants.addChatGrant(composerId, normalizeGrantEntry(serverDisplayName, tool));
	}
}
