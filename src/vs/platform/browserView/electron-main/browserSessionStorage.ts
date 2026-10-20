/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'crypto';
import { joinPath } from '../../../base/common/resources.js';
import { URI } from '../../../base/common/uri.js';
import { BrowserViewStorageScope, IBrowserViewSessionOptions } from '../common/browserView.js';

/**
 * Pure (Electron-free) description of where a {@link BrowserSession}'s data lives.
 *
 * REA spec (feature-matrix.json, P2 `browser-state-persist`):
 * "Browser: state persistence per workspace" —
 * "Cookies, localStorage, IndexedDB persisted per workspace"
 * (evidence: deep-docs-all.md docs sweep 2026-10-18; dissect-browser-tab.md —
 * "`partition` passed to BrowserView webPreferences (persisted session per partition)",
 * OBSERVED).
 *
 * The mapping below is the single source of truth for the persistence contract:
 * - `Global`    → `persist:vscode-browser` partition (persisted, shared).
 * - `Workspace` → `<workspaceStorage>/<workspaceId>/browserStorage` via
 *   `session.fromPath` (persisted per workspace); falls back to an ephemeral
 *   in-memory session when no workspace is open.
 * - `Ephemeral` → `vscode-browser-<type><viewId>` partition without the
 *   `persist:` prefix (in-memory, cleaned up on close).
 * - `Agent`     → `vscode-browser-agent-<identityHash>` partition without the
 *   `persist:` prefix (in-memory).
 *
 * Kept free of the `electron` import so the persistence contract is unit-testable
 * in plain node.
 */
export interface IBrowserSessionStorageTarget {
	/** The `BrowserSession` id (also the CDP browserContextId). */
	readonly id: string;
	/** Argument for `session.fromPartition(...)`, when the session is partition-based. */
	readonly partition: string | undefined;
	/** Filesystem path for `session.fromPath(...)`, when the session is path-based. */
	readonly path: string | undefined;
	/**
	 * Whether cookies, localStorage, and IndexedDB survive app restarts for this
	 * target. `true` for `persist:` partitions and `fromPath` sessions, `false`
	 * for in-memory partitions.
	 */
	readonly persisted: boolean;
}

export interface IResolveBrowserSessionStorageTargetArgs {
	readonly scope: BrowserViewStorageScope;
	readonly sessionOptions?: IBrowserViewSessionOptions;
	readonly viewId?: string;
	readonly workspaceId?: string;
	readonly workspaceStorageHome?: URI;
	readonly ephemeralType?: string;
	readonly windowId?: number;
}

function ephemeralTarget(viewId: string, type?: string): IBrowserSessionStorageTarget {
	if (type === 'workspace' || type === 'ephemeral' || type === 'agent') {
		throw new Error(`Cannot create session with reserved type '${type}'`);
	}
	// The partition must never contain the literal string "undefined": normalize
	// the omitted type to 'ephemeral' (previously `vscode-browser-${type}…`
	// interpolated "undefined" here, while the session id already used 'ephemeral').
	const resolvedType = type ?? 'ephemeral';
	return {
		id: `${resolvedType}:${viewId}`,
		partition: `vscode-browser-${resolvedType}${viewId}`,
		path: undefined,
		persisted: false,
	};
}

function agentTarget(options: IBrowserViewSessionOptions | undefined, workspaceId: string | undefined, windowId: number | undefined): IBrowserSessionStorageTarget {
	const affinity = options?.scope === BrowserViewStorageScope.Agent ? options.affinity : undefined;
	let identity: string;
	if (affinity !== undefined) {
		identity = `affinity:${affinity}`;
	} else if (workspaceId !== undefined) {
		identity = `workspace:${workspaceId}`;
	} else if (windowId !== undefined) {
		identity = `window:${windowId}`;
	} else {
		throw new Error('Agent browser sessions require an affinity, workspace, or window');
	}
	const identityHash = createHash('sha256').update(identity).digest('hex');
	return {
		id: `agent:${identityHash}`,
		partition: `vscode-browser-agent-${identityHash}`,
		path: undefined,
		persisted: false,
	};
}

/**
 * Resolve the storage target for a browser session without touching Electron.
 * Behavior is identical to the previous inline logic in `BrowserSession`'s
 * static factories, except the ephemeral partition no longer interpolates a
 * literal "undefined" type (see {@link ephemeralTarget}).
 */
export function resolveBrowserSessionStorageTarget(args: IResolveBrowserSessionStorageTargetArgs): IBrowserSessionStorageTarget {
	const { scope, sessionOptions, viewId = '', workspaceId, workspaceStorageHome, ephemeralType, windowId } = args;
	switch (scope) {
		case BrowserViewStorageScope.Global:
			return {
				id: 'global',
				partition: 'persist:vscode-browser',
				path: undefined,
				persisted: true,
			};
		case BrowserViewStorageScope.Workspace:
			if (workspaceId) {
				if (!workspaceStorageHome) {
					throw new Error('Workspace browser sessions require a workspace storage home');
				}
				return {
					id: `workspace:${workspaceId}`,
					partition: undefined,
					path: joinPath(workspaceStorageHome, workspaceId, 'browserStorage').fsPath,
					persisted: true,
				};
			}
			return ephemeralTarget(viewId, ephemeralType);
		case BrowserViewStorageScope.Ephemeral:
			return ephemeralTarget(viewId, ephemeralType);
		case BrowserViewStorageScope.Agent:
			return agentTarget(sessionOptions, workspaceId, windowId);
	}
}
