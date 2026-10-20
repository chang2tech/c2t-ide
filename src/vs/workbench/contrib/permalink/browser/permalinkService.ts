/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableMap, DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../base/common/event.js';
import { autorun } from '../../../../base/common/observable.js';
import { relativePath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IGitService } from '../../git/common/gitService.js';
import { ISCMRepository, ISCMService } from '../../scm/common/scm.js';
import { GlassRemoteFileLinkAvailable, IPermalinkService } from '../common/permalink.js';
import { buildRemoteFileUrl, IRemoteFileLineRange, isSupportedRemoteUrl } from '../common/permalinkUtils.js';

interface ICachedRepositoryLinkData {
	readonly remoteUrl: string;
	readonly revision: string;
}

/**
 * Workbench service backing "Copy Remote URL".
 *
 * Mirrors Cursor's `glassPermalinkService` (binary evidence in
 * `out/vs/workbench/workbench.glass.main.js`, Cursor 3.25.6):
 * - tracks git SCM repositories,
 * - caches `{ remoteUrl, revision }` per repository, where `remoteUrl` is the
 *   upstream remote's fetch URL and `revision` is the upstream commit SHA
 *   (Cursor reads `historyItemRemoteRef` = `{ id: 'refs/remotes/<remote>/<branch>',
 *   revision: <upstream commit> }`; the fork's workbench git service surfaces
 *   the identical values as `HEAD.upstream.{remote,commit}`),
 * - maintains the `glassRemoteFileLinkAvailable` context key (true when at
 *   least one repository has cached link data),
 * - `resolveRemoteFileUrl` is synchronous and cache-backed; on a cache miss it
 *   queues a refresh and returns `undefined` (the command waits for
 *   `onDidChange` and retries, like Cursor).
 *
 * Fork differences from Cursor (documented, not silent):
 * - Cursor registers the service `Delayed` and lets its glass editor UI
 *   instantiate it on file open; this fork has no glass editor UI, so the
 *   service is registered `Eager` (see permalink.contribution.ts) to keep the
 *   context key live from startup.
 * - Cursor waits on its internal git-context service before the first refresh;
 *   here `IGitService.openRepository` performs the equivalent wait for the git
 *   extension (up to its built-in barrier) and resolves the repository state.
 */
export class PermalinkService extends Disposable implements IPermalinkService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private readonly _cachedRepositoryLinkData = new Map<string, ICachedRepositoryLinkData>();
	private readonly _refreshingRepositoryIds = new Set<string>();
	private readonly _trackedRepositories = this._register(new DisposableMap<string>());

	private readonly _remoteFileLinkAvailableKey;

	constructor(
		@IGitService private readonly _gitService: IGitService,
		@ISCMService private readonly _scmService: ISCMService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();

		this._remoteFileLinkAvailableKey = GlassRemoteFileLinkAvailable.bindTo(contextKeyService);

		this._register(this._scmService.onDidAddRepository(repository => this._onRepositoryAdded(repository)));
		this._register(this._scmService.onDidRemoveRepository(repository => this._onRepositoryRemoved(repository)));

		for (const repository of this._scmService.repositories) {
			this._trackRepository(repository);
		}
		this._queueAllRepositoryRefreshes();
	}

	resolveRemoteFileUrl(resource: URI | string, lineRange?: IRemoteFileLineRange): string | undefined {
		let uri: URI;
		try {
			uri = typeof resource === 'string' ? URI.parse(resource) : resource;
		} catch {
			return undefined;
		}

		const repository = this._scmService.getRepository(uri);
		if (!repository || repository.provider.contextValue.get() !== 'git' || !repository.provider.rootUri) {
			return undefined;
		}

		const relativeFilePath = relativePath(repository.provider.rootUri, uri);
		if (!relativeFilePath) {
			return undefined;
		}

		const cached = this._cachedRepositoryLinkData.get(repository.id);
		if (!cached) {
			this._queueRepositoryRefresh(repository);
			return undefined;
		}

		return buildRemoteFileUrl({
			remoteUrl: cached.remoteUrl,
			revision: cached.revision,
			relativeFilePath,
			lineRange,
		});
	}

	override dispose(): void {
		this._cachedRepositoryLinkData.clear();
		this._refreshingRepositoryIds.clear();
		this._remoteFileLinkAvailableKey.set(false);
		super.dispose();
	}

	private _onRepositoryAdded(repository: ISCMRepository): void {
		if (repository.provider.contextValue.get() !== 'git') {
			return;
		}
		this._trackRepository(repository);
		this._queueRepositoryRefreshAndNotify(repository);
	}

	private _onRepositoryRemoved(repository: ISCMRepository): void {
		if (repository.provider.contextValue.get() !== 'git') {
			return;
		}
		this._untrackRepository(repository);
		this._deleteCachedRepositoryLinkData(repository.id);
	}

	private _trackRepository(repository: ISCMRepository): void {
		if (repository.provider.contextValue.get() !== 'git' || this._trackedRepositories.has(repository.id)) {
			return;
		}

		const store = new DisposableStore();
		// Re-resolve link data when the upstream tracking ref changes (branch,
		// upstream commit) — mirrors Cursor's `historyItemRemoteRef` watcher.
		store.add(autorun(reader => {
			const historyProvider = repository.provider.historyProvider.read(reader);
			historyProvider?.historyItemRemoteRef.read(reader);
			this._queueRepositoryRefresh(repository);
		}));
		// Re-resolve when the workbench git service reports a new repository
		// state (remotes added/removed/changed, HEAD upstream changed). The
		// fork's core `ISCMProvider` has no `onDidChangeRemotes` event (Cursor's
		// patched provider does), so the `IGitService` repository state — which
		// the git extension keeps up to date — is watched instead.
		store.add(this._watchGitRepositoryState(repository));

		this._trackedRepositories.set(repository.id, store);
	}

	private _untrackRepository(repository: ISCMRepository): void {
		this._trackedRepositories.deleteAndDispose(repository.id);
		this._refreshingRepositoryIds.delete(repository.id);
	}

	/**
	 * Watches the workbench git service's repository state for the given SCM
	 * repository and re-queues a link-data refresh when the parts that feed it
	 * (upstream remote/commit, remote fetch URLs) change.
	 *
	 * `IGitService.openRepository` reuses one handle per root URI and waits
	 * for the git extension to have repository state (HEAD) available, so this
	 * is safe to call for every tracked repository.
	 */
	private _watchGitRepositoryState(repository: ISCMRepository): IDisposable {
		const store = new DisposableStore();
		const rootUri = repository.provider.rootUri;
		if (rootUri) {
			this._gitService.openRepository(rootUri).then(gitRepository => {
				if (store.isDisposed || !gitRepository) {
					return;
				}
				store.add(autorun(reader => {
					const state = gitRepository.state.read(reader);
					// Read the fields that feed the cached link data so this
					// re-runs exactly when they change.
					state.HEAD?.upstream?.remote;
					state.HEAD?.upstream?.commit;
					state.remotes.map(remote => `${remote.name}=${remote.fetchUrl ?? ''}`).join('|');
					this._queueRepositoryRefresh(repository);
				}));
			}).catch(() => {
				// Git extension unavailable: the history-provider watcher in
				// `_trackRepository` still covers upstream changes.
			});
		}
		return store;
	}

	private _queueAllRepositoryRefreshes(): void {
		for (const repository of this._scmService.repositories) {
			this._queueRepositoryRefresh(repository);
		}
	}

	private _queueRepositoryRefreshAndNotify(repository: ISCMRepository): void {
		this._queueRepositoryRefresh(repository);
		this._onDidChange.fire();
	}

	private _queueRepositoryRefresh(repository: ISCMRepository): void {
		if (repository.provider.contextValue.get() !== 'git' || this._refreshingRepositoryIds.has(repository.id)) {
			return;
		}
		this._refreshingRepositoryIds.add(repository.id);
		this._refreshRepositoryLinkData(repository).finally(() => {
			this._refreshingRepositoryIds.delete(repository.id);
		});
	}

	private async _refreshRepositoryLinkData(repository: ISCMRepository): Promise<void> {
		const rootUri = repository.provider.rootUri;
		if (!rootUri) {
			// Cursor returns early here without touching the cache
			// (`_refreshRepositoryLinkData`, workbench.glass.main.js 3.25.9
			// @31583049: `if(...||!t.provider.rootUri)return;`).
			return;
		}

		let remoteUrl: string | undefined;
		let revision: string | undefined;
		try {
			// `IGitService.openRepository` waits for the git extension and for
			// repository state (HEAD) to be available.
			const gitRepository = await this._gitService.openRepository(rootUri);
			const state = gitRepository?.state.get();
			const upstream = state?.HEAD?.upstream;
			remoteUrl = upstream?.remote
				? state?.remotes.find(remote => remote.name === upstream.remote)?.fetchUrl
				: undefined;
			revision = upstream?.commit?.trim() || undefined;
		} catch {
			remoteUrl = undefined;
			revision = undefined;
		}

		if (!remoteUrl || !revision) {
			this._deleteCachedRepositoryLinkData(repository.id);
			return;
		}
		if (!isSupportedRemoteUrl(remoteUrl)) {
			this._deleteCachedRepositoryLinkData(repository.id);
			return;
		}

		const cached = this._cachedRepositoryLinkData.get(repository.id);
		if (cached?.remoteUrl !== remoteUrl || cached?.revision !== revision) {
			this._cachedRepositoryLinkData.set(repository.id, { remoteUrl, revision });
			this._updateRemoteFileLinkAvailableKey();
			this._onDidChange.fire();
		}
	}

	private _deleteCachedRepositoryLinkData(repositoryId: string): void {
		if (this._cachedRepositoryLinkData.delete(repositoryId)) {
			this._updateRemoteFileLinkAvailableKey();
			this._onDidChange.fire();
		}
	}

	private _updateRemoteFileLinkAvailableKey(): void {
		this._remoteFileLinkAvailableKey.set(this._cachedRepositoryLinkData.size > 0);
	}
}
