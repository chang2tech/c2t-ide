/**
 * MCP approval grant storage — vscode-side implementation.
 *
 * Cursor 3.25.9 parity (WORKER-GAPS-30D, audit item `mcp-approval-persistence`).
 *
 * Binary evidence (workbench.glass.main.js 3.25.9, self-verified 2026-10-20):
 * - `setApplicationUserPersistentStorage("composerState","mcpAllowedTools",…)`
 *   ×6 — "Always allow" grants are USER-GLOBAL, persistent, normalized
 *   `server:tool` strings, no TTL.
 * - `mcpAllowedToolsForChat` ×5 — one-shot RUN grants are PER-COMPOSER,
 *   in-memory (`updateComposerDataSetStore(handle,
 *   z=>z("mcpAllowedToolsForChat",K=>K?.includes(W)?K:[...K??[],W]))`).
 * - `mcp-approvals.json` = 0 hits — Cursor has no project-level approvals file.
 *
 * Fork mapping: Cursor's `applicationUserPersistentStorage` ≡ vscode
 * `ExtensionContext.globalState` (user-global, survives restarts, works with
 * no workspace folder open — the old code warned "no workspace folder" when
 * persisting; that warning is gone because there is nowhere that can fail).
 * Per-composer grants are an in-memory Map keyed by `ComposerDataService.composerId`.
 *
 * Write-dedupe is case-SENSITIVE (`K?.includes(W)` in the binary); consult
 * is case-INSENSITIVE (the binary's `WFf` compare). Both are mirrored here.
 */
import type { McpGrantStore } from "./types";

/**
 * Cursor's storage key, verbatim: `composerState` → `mcpAllowedTools`.
 * Kept as the literal dotted key so the parity mapping is greppable.
 */
export const MCP_ALLOWED_TOOLS_GLOBAL_KEY = "composerState.mcpAllowedTools";

/** Structural subset of `vscode.Memento` we actually use (keeps this testable). */
export interface GlobalStateLike {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

/** Case-sensitive append-dedupe, mirroring the binary's `K?.includes(W)`. */
function appendUnique(list: readonly string[], entry: string): string[] {
  return list.includes(entry) ? [...list] : [...list, entry];
}

function readStringArray(state: GlobalStateLike, key: string): string[] {
  const raw = state.get<unknown>(key, []);
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === "string");
}

/**
 * Live implementation: global grants in `ExtensionContext.globalState`,
 * chat grants in memory.
 */
export class ExtensionMcpGrantStore implements McpGrantStore {
  private readonly chatGrants = new Map<string, Set<string>>();
  /**
   * Serializes read-modify-write cycles so two rapid "Always allow" clicks
   * can't clobber each other (both read the same array, second write wins).
   */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly globalState: GlobalStateLike) {}

  getGlobalGrants(): readonly string[] {
    return readStringArray(this.globalState, MCP_ALLOWED_TOOLS_GLOBAL_KEY);
  }

  addGlobalGrant(entry: string): void {
    this.writeChain = this.writeChain.then(() =>
      this.globalState.update(
        MCP_ALLOWED_TOOLS_GLOBAL_KEY,
        appendUnique(this.getGlobalGrants(), entry),
      ),
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
 * Pure in-memory implementation — for unit tests and hosts without a
 * persistent memento. Global grants live in a plain array (still no TTL).
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
