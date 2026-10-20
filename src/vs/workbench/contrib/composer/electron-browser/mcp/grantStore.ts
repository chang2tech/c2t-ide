// IDE-CODE: Migrated from extensions/ide-agent/src/mcp/grantStore.ts (CAT-A, pure logic).
/**
 * MCP approval grant storage — workbench-side implementation.
 *
 * Cursor 3.25.9 parity (WORKER-GAPS-30D, audit item `mcp-approval-persistence`).
 * vscode API → core mapping (per composerDataService.ts header):
 *   `ExtensionContext.globalState` (user-global) →
 *   `IStorageService` with `StorageScope.APPLICATION` + `StorageTarget.USER`
 *   (user-global, survives restarts — Cursor's `applicationUserPersistentStorage`).
 *
 * The storage key is the verbatim Cursor key `composerState.mcpAllowedTools`.
 * Write-dedupe is case-SENSITIVE (binary `K?.includes(W)`); consult is
 * case-INSENSITIVE (binary `WFf`).
 */
import { StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import type { IStorageService } from '../../../../../platform/storage/common/storage.js';
import type { McpGrantStore } from '../../common/mcp/types.js';

/** Cursor's storage key, verbatim: `composerState` → `mcpAllowedTools`. */
export const MCP_ALLOWED_TOOLS_GLOBAL_KEY = 'composerState.mcpAllowedTools';

/** Case-sensitive append-dedupe, mirroring the binary's `K?.includes(W)`. */
function appendUnique(list: readonly string[], entry: string): string[] {
	return list.includes(entry) ? [...list] : [...list, entry];
}

function readStringArray(storageService: IStorageService, key: string): string[] {
	const raw = storageService.get(key, StorageScope.APPLICATION);
	if (!raw) {
		return [];
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
	} catch {
		return [];
	}
}

function writeStringArray(storageService: IStorageService, key: string, value: string[]): void {
	storageService.store(key, JSON.stringify(value), StorageScope.APPLICATION, StorageTarget.USER);
}

/**
 * Live implementation: global grants in `IStorageService` (APPLICATION
 * scope), chat grants in memory.
 *
 * NOTE (HONEST): the core `McpService` is deliberately NOT registered yet
 * (composer.contribution.ts — the per-tab composer hasn't landed), so this
 * store currently has no live callers. It exists so the CAT-A port stays
 * behaviorally identical to the extension when the service is wired up.
 */
export class WorkbenchMcpGrantStore implements McpGrantStore {
	private readonly chatGrants = new Map<string, Set<string>>();

	constructor(private readonly storageService: IStorageService) { }

	getGlobalGrants(): readonly string[] {
		return readStringArray(this.storageService, MCP_ALLOWED_TOOLS_GLOBAL_KEY);
	}

	addGlobalGrant(entry: string): void {
		writeStringArray(
			this.storageService,
			MCP_ALLOWED_TOOLS_GLOBAL_KEY,
			appendUnique(this.getGlobalGrants(), entry),
		);
	}

	getChatGrants(composerId: string): readonly string[] {
		return [...(this.chatGrants.get(composerId) ?? [])];
	}

	addChatGrant(composerId: string, entry: string): void {
		let set = this.chatGrants.get(composerId);
		if (!set) {
			set = new Set<string>();
			this.chatGrants.set(composerId, set);
		}
		set.add(entry);
	}
}

/**
 * Pure in-memory implementation — for unit tests and hosts without an
 * `IStorageService`. Global grants live in a plain array (still no TTL).
 */
export class InMemoryMcpGrantStore implements McpGrantStore {
	private globalGrants: string[] = [];
	private readonly chatGrants = new Map<string, Set<string>>();

	getGlobalGrants(): readonly string[] {
		return [...this.globalGrants];
	}

	addGlobalGrant(entry: string): void {
		this.globalGrants = appendUnique(this.globalGrants, entry);
	}

	getChatGrants(composerId: string): readonly string[] {
		return [...(this.chatGrants.get(composerId) ?? [])];
	}

	addChatGrant(composerId: string, entry: string): void {
		let set = this.chatGrants.get(composerId);
		if (!set) {
			set = new Set<string>();
			this.chatGrants.set(composerId, set);
		}
		set.add(entry);
	}
}
