/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * MCP process supervision constants — main-process side.
 *
 * CURSOR PARITY (binary-verified, NOT docs-inferred):
 * Cursor 3.25.6 and 3.25.9 ship these constants verbatim in `out/main.js` (the
 * MAIN-process mcpProcess supervisor, adjacent to the RPC namespace map):
 *
 *   Tf = { restartMaxPer10Min: 5, restartBackoffCapMs: 6e4, coldStartTimeoutMs: 6e4 }
 *   kf = 600 * 1e3                      (restart-budget sliding window: 10 min)
 *
 * Restart-plan algorithm (verbatim from `out/main.js`, function `Uet`):
 *   const s = [...recentTimestamps.filter(t => now - t <= kf), now];
 *   if (s.length > config.restartMaxPer10Min) return { restartAfterMs: null, recentTimestampsMs: s };
 *   return { restartAfterMs: min(2^(s.length-1) * 1000, config.restartBackoffCapMs), recentTimestampsMs: s };
 *
 * Give-up reset (verbatim, function `Let` + supervisor method `maybeResetExpiredGiveUp`):
 *   windowExpired = now - gaveUpAtMs > kf
 *   on expiry: gaveUpAtMs = undefined; log
 *   "[McpProcess] restart-budget window expired since give-up; allowing a fresh start attempt"
 *
 * LAYER RULE (binary-verified, this is the entire point of the module's location):
 * `mcpProcessMain.js` (the mcpProcess ELECTRON-UTILITY process) contains ZERO hits
 * for `restartMaxPer10Min` / `restartBackoffCapMs` in both Cursor versions — the
 * utility process only reads `runtimeConfig.coldStartTimeoutMs` (passed in from
 * main). These supervision constants MUST live in the main process, never in the
 * utility process. Do NOT duplicate them there.
 *
 * Reference: ide-code-mission/docs/rea/dig-continuous-mcp-deep-2026-10-19.md §8
 * ("Server lifecycle"); audit queue item `mcp-supervision-constants-location`.
 */

/** Supervision knobs passed to the mcpProcess utility process via `runtimeConfig`. */
export interface IMcpProcessSupervisionConfig {
	/** Max restarts inside the 10-minute budget window before giving up (Cursor: 5). */
	readonly restartMaxPer10Min: number;
	/** Cap for the exponential restart backoff (Cursor: 60_000 ms). */
	readonly restartBackoffCapMs: number;
	/** How long the supervisor waits for the utility process to signal init (Cursor: 60_000 ms). */
	readonly coldStartTimeoutMs: number;
}

/**
 * Verbatim Cursor defaults (`Tf={restartMaxPer10Min:5,restartBackoffCapMs:6e4,coldStartTimeoutMs:6e4}`
 * in `out/main.js`). Used as the fallback when no `runtimeConfig` overrides are provided.
 */
export const mcpProcessSupervisionDefaults: IMcpProcessSupervisionConfig = {
	restartMaxPer10Min: 5,
	restartBackoffCapMs: 60_000,
	coldStartTimeoutMs: 60_000,
};

/**
 * Restart-budget sliding window (Cursor: `kf = 600 * 1e3` = 10 minutes).
 * Restart timestamps older than this are evicted from the budget; the give-up
 * state also resets once this much time has passed since giving up.
 */
export const MCP_RESTART_BUDGET_WINDOW_MS = 600 * 1_000;

/** Base step for the exponential restart backoff: 1s, 2s, 4s, 8s, 16s, ... (Cursor: `Math.pow(2, i-1) * 1e3`). */
export const MCP_RESTART_BACKOFF_BASE_MS = 1_000;

/** Verbatim log line the supervisor emits when the give-up state expires (see `maybeResetExpiredGiveUp`). */
export const MCP_RESTART_BUDGET_EXPIRED_LOG = '[McpProcess] restart-budget window expired since give-up; allowing a fresh start attempt';

/** Result of a restart-plan decision. `restartAfterMs: null` means the budget is exhausted: do NOT restart. */
export interface IMcpRestartPlan {
	readonly restartAfterMs: number | null;
	readonly recentTimestampsMs: number[];
}

/**
 * Faithful port of Cursor's `Uet` (out/main.js): decides whether the mcpProcess
 * utility process may be restarted and, if so, after how long.
 *
 * - Keeps only restart timestamps inside the 10-minute budget window, then appends `nowMs`.
 * - More than `restartMaxPer10Min` restarts inside the window → `restartAfterMs: null` (give up).
 * - Otherwise exponential backoff `2^(n-1) * 1s`, capped at `restartBackoffCapMs`.
 */
export function planMcpProcessRestart(
	recentTimestampsMs: number[],
	nowMs: number,
	config: IMcpProcessSupervisionConfig = mcpProcessSupervisionDefaults,
): IMcpRestartPlan {
	const recent = [...recentTimestampsMs.filter(t => nowMs - t <= MCP_RESTART_BUDGET_WINDOW_MS), nowMs];
	if (recent.length > config.restartMaxPer10Min) {
		return { restartAfterMs: null, recentTimestampsMs: recent };
	}
	const backoffMs = Math.pow(2, recent.length - 1) * MCP_RESTART_BACKOFF_BASE_MS;
	return { restartAfterMs: Math.min(backoffMs, config.restartBackoffCapMs), recentTimestampsMs: recent };
}

/**
 * Faithful port of Cursor's `Let` (out/main.js): the restart-budget window has
 * expired since the given timestamp.
 */
export function isMcpRestartBudgetWindowExpired(sinceMs: number, nowMs: number): boolean {
	return nowMs - sinceMs > MCP_RESTART_BUDGET_WINDOW_MS;
}

/**
 * Main-process restart-budget tracker for the mcpProcess utility process.
 * Faithful port of the supervisor logic in Cursor's `out/main.js`
 * (`recentRestartTimestampsMs`, `gaveUpAtMs`, `maybeResetExpiredGiveUp`).
 */
export class McpProcessRestartBudget {

	private _recentRestartTimestampsMs: number[] = [];
	private _gaveUpAtMs: number | undefined = undefined;

	public get gaveUpAtMs(): number | undefined {
		return this._gaveUpAtMs;
	}

	/**
	 * Records a restart request at `nowMs` and returns the restart plan.
	 * A `null` `restartAfterMs` marks the give-up time (budget exhausted).
	 */
	public planRestart(nowMs: number, config: IMcpProcessSupervisionConfig = mcpProcessSupervisionDefaults): IMcpRestartPlan {
		const plan = planMcpProcessRestart(this._recentRestartTimestampsMs, nowMs, config);
		this._recentRestartTimestampsMs = plan.recentTimestampsMs;
		if (plan.restartAfterMs === null) {
			this._gaveUpAtMs = nowMs;
		}
		return plan;
	}

	/**
	 * Faithful port of `maybeResetExpiredGiveUp`: once the 10-minute window has
	 * passed since giving up, the supervisor forgets the give-up state so a fresh
	 * start attempt is allowed again. Emits the verbatim Cursor log line.
	 */
	public maybeResetExpiredGiveUp(nowMs: number, onLog: (message: string) => void): boolean {
		if (this._gaveUpAtMs === undefined) {
			return false;
		}
		if (!isMcpRestartBudgetWindowExpired(this._gaveUpAtMs, nowMs)) {
			return false;
		}
		this._gaveUpAtMs = undefined;
		onLog(MCP_RESTART_BUDGET_EXPIRED_LOG);
		return true;
	}

	/** Test seam: exposes the tracked restart timestamps. */
	public getRecentRestartTimestampsMs(): number[] {
		return [...this._recentRestartTimestampsMs];
	}
}

/*
 * HONEST DIVERGENCE (architecture, 2026-10-20):
 * This fork does NOT yet have Cursor's dedicated `vs/code/electron-utility/mcpProcess`
 * utility process — stdio MCP servers are spawned from the extension host / workbench
 * via upstream VS Code's `McpServerConnection` (see
 * `src/vs/workbench/contrib/mcp/common/mcpServerConnection.ts`), which has no restart
 * budget at all. This module is the MAIN-process home for the supervision constants
 * and the restart-budget algorithm — the same layer as Cursor's supervisor — so the
 * wiring is already in the right place when the utility process is introduced
 * (separate, larger gap). The constants must NOT be duplicated into the utility
 * process: binary evidence shows 0 hits there in both Cursor versions.
 */
