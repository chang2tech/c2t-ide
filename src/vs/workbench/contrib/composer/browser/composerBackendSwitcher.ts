/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Backend server switcher — Cursor parity (feature
// `backend-server-switcher`, P1, DEEP-DIG-A 2026-10-19, from Cursor 3.25.6
// `workbench.desktop.main.js` / `workbench.glass.main.js`).
//
// Binary evidence (verbatim — kept character-for-character):
//   - Command `cursor.selectBackend` titled "Select Backend Server".
//   - Status bar item text `Server: ${name}` (name = current backend) with
//     tooltip "Click to switch backend server"; click opens the backend picker.
//
// LAYER NOTE: the binary shows the command id, title, status-bar text and
// tooltip, but not which workbench layer registers them, so the Cursor layer
// is UNKNOWN. This lives next to the other composer workbench contributions
// (browser/contrib/composer, see composerStatusBar.ts), the repo's
// Cursor-parity home for status-bar entries (CAT-D mapping).
//
// HONEST-DIVERGENCE: Cursor's canonical backend list is server-driven — the
// binary evidence covers the switcher UI only, so the list source is UNKNOWN.
// Our product is local-first (engine sidecar), so the list here is a local
// one: the built-in "Local Engine (sidecar)" first, then any backends
// configured in `ide.agent.backendServers` (default []). No parity is
// claimed for the list contents or for what "switching" does server-side;
// the selection is stored and the status bar updates immediately.

import { localize, localize2 } from '../../../../nls.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IStatusbarService, StatusbarAlignment, IStatusbarEntryAccessor } from '../../../services/statusbar/browser/statusbar.js';
import { ComposerActionCategory } from './composerActions.js';

/** Storage key for the selected backend server id. */
export const BACKEND_SERVER_STORAGE_KEY = 'composer.selectedBackendServerId';

/** Status bar entry id for the backend server switcher. */
export const BACKEND_STATUS_BAR_ENTRY_ID = 'composer.backend.status';

export interface BackendServer {
	/** Stable id used for the stored selection. */
	readonly id: string;
	/** Display name — rendered in the status bar via the verbatim `Server: ${name}` format. */
	readonly name: string;
	/** 'local' = the built-in sidecar engine; 'configured' = from `ide.agent.backendServers`. */
	readonly kind: 'local' | 'configured';
	/** Optional remote URL for configured backends. */
	readonly url?: string;
}

/** The built-in local engine backend (always present, first in the list). */
export const LOCAL_ENGINE_BACKEND: BackendServer = {
	id: 'local',
	name: 'Local Engine (sidecar)',
	kind: 'local',
};

/**
 * Normalizes one `ide.agent.backendServers` entry. Entries may be plain
 * strings (used as both id and name) or objects with name/id/url fields.
 */
function normalizeConfiguredBackend(entry: unknown, index: number): BackendServer | undefined {
	if (typeof entry === 'string') {
		const name = entry.trim();
		return name ? { id: name, name, kind: 'configured' } : undefined;
	}
	if (entry && typeof entry === 'object') {
		const obj = entry as { name?: unknown; id?: unknown; url?: unknown };
		const name = typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim() : undefined;
		const id = typeof obj.id === 'string' && obj.id.trim() ? obj.id.trim() : undefined;
		const url = typeof obj.url === 'string' && obj.url.trim() ? obj.url.trim() : undefined;
		const resolvedName = name ?? id ?? url;
		if (!resolvedName) {
			return undefined;
		}
		return { id: id ?? resolvedName, name: resolvedName, kind: 'configured', url };
	}
	return undefined;
}

/**
 * Full backend list: the built-in local engine first, then configured
 * backends (duplicates and blank entries dropped).
 */
export function getBackendServers(configurationService: IConfigurationService): BackendServer[] {
	const configured = configurationService.getValue<unknown[]>('ide.agent.backendServers') ?? [];
	const servers: BackendServer[] = [LOCAL_ENGINE_BACKEND];
	const seen = new Set<string>([LOCAL_ENGINE_BACKEND.id]);
	configured.forEach((entry, index) => {
		const server = normalizeConfiguredBackend(entry, index);
		if (server && !seen.has(server.id)) {
			seen.add(server.id);
			servers.push(server);
		}
	});
	return servers;
}

/** Currently selected backend id (falls back to the local engine). */
export function getSelectedBackendId(storageService: IStorageService, servers: BackendServer[]): string {
	const stored = storageService.get(BACKEND_SERVER_STORAGE_KEY, StorageScope.APPLICATION);
	if (stored && servers.some(s => s.id === stored)) {
		return stored;
	}
	return LOCAL_ENGINE_BACKEND.id;
}

/** Resolves the stored selection to its display entry. */
export function getSelectedBackend(storageService: IStorageService, configurationService: IConfigurationService): BackendServer {
	const servers = getBackendServers(configurationService);
	const id = getSelectedBackendId(storageService, servers);
	return servers.find(s => s.id === id) ?? LOCAL_ENGINE_BACKEND;
}

/** Persists the backend selection (user-level: all workspaces, this machine). */
export function storeSelectedBackendId(storageService: IStorageService, backendId: string): void {
	storageService.store(BACKEND_SERVER_STORAGE_KEY, backendId, StorageScope.APPLICATION, StorageTarget.MACHINE);
}

interface BackendQuickPickItem extends IQuickPickItem {
	readonly backendId: string;
}

/**
 * Command `cursor.selectBackend` — verbatim Cursor binary evidence:
 * 'Command cursor.selectBackend titled "Select Backend Server"'.
 * Opens a QuickPick over the local backend list and stores the selection;
 * the status bar refreshes via the storage change listener.
 */
export class SelectBackendServerAction extends Action2 {

	static readonly ID = 'cursor.selectBackend';

	constructor() {
		super({
			id: SelectBackendServerAction.ID,
			// Verbatim binary title.
			title: localize2('cursor.selectBackend', 'Select Backend Server'),
			category: ComposerActionCategory,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const configurationService = accessor.get(IConfigurationService);
		const storageService = accessor.get(IStorageService);

		const servers = getBackendServers(configurationService);
		const currentId = getSelectedBackendId(storageService, servers);

		const items: BackendQuickPickItem[] = servers.map(server => ({
			backendId: server.id,
			label: server.id === currentId ? `$(check) ${server.name}` : server.name,
			description: server.kind === 'local'
				? localize('composer.backend.local.description', 'Built-in local engine')
				: server.url,
		}));

		const picked = await quickInputService.pick(items, {
			placeHolder: localize('composer.backend.pick.placeholder', 'Select Backend Server'),
			matchOnDescription: true,
		});
		if (!picked) {
			return;
		}
		storeSelectedBackendId(storageService, picked.backendId);
	}
}

/**
 * Status-bar owner for the backend switcher. Text follows the verbatim
 * binary format `Server: ${name}`; tooltip is the verbatim
 * "Click to switch backend server"; click runs `cursor.selectBackend`.
 *
 * Priority 96 sits just right of the other composer status items (98–101);
 * placement has no binary evidence (UNKNOWN) and was chosen for adjacency.
 */
export class ComposerBackendStatusBar extends Disposable {

	private readonly entry: IStatusbarEntryAccessor;

	constructor(
		@IStatusbarService statusbarService: IStatusbarService,
		@IStorageService private readonly storageService: IStorageService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();

		this.entry = this._register(statusbarService.addEntry({
			name: localize('composer.backendStatus.name', 'Backend Server'),
			// Verbatim binary format: `Server: ${name}`.
			text: `Server: ${LOCAL_ENGINE_BACKEND.name}`,
			ariaLabel: localize('composer.backendStatus.aria', 'Active backend server'),
			// Verbatim binary tooltip: "Click to switch backend server".
			tooltip: localize('composer.backendStatus.tooltip', 'Click to switch backend server'),
			command: SelectBackendServerAction.ID,
		}, BACKEND_STATUS_BAR_ENTRY_ID, StatusbarAlignment.RIGHT, 96));

		this.refresh();

		// Refresh when the stored selection changes (picked from the QuickPick)…
		this._register(this.storageService.onDidChangeValue(StorageScope.APPLICATION, BACKEND_SERVER_STORAGE_KEY, this._register(new DisposableStore()))(e => {
			if (e.key === BACKEND_SERVER_STORAGE_KEY) {
				this.refresh();
			}
		}));
		// …or when the configured backend list changes.
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('ide.agent.backendServers')) {
				this.refresh();
			}
		}));
	}

	private refresh(): void {
		const backend = getSelectedBackend(this.storageService, this.configurationService);
		this.entry.update({
			name: localize('composer.backendStatus.name', 'Backend Server'),
			// Verbatim binary format: `Server: ${name}`.
			text: `Server: ${backend.name}`,
			ariaLabel: localize('composer.backendStatus.aria', 'Active backend server'),
			// Verbatim binary tooltip: "Click to switch backend server".
			tooltip: localize('composer.backendStatus.tooltip', 'Click to switch backend server'),
		});
	}
}

/** Registers the `cursor.selectBackend` command (called from composer.contribution.ts). */
export function registerBackendSwitcherAction(): void {
	registerAction2(SelectBackendServerAction);
}
