/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IRemoteFileLineRange } from './permalinkUtils.js';

/**
 * Permalink service ("Copy Remote URL").
 *
 * Mirrors Cursor's `glassPermalinkService` (binary evidence in
 * `out/vs/workbench/workbench.glass.main.js`, Cursor 3.25.6): it keeps a
 * per-repository cache of `{ remoteUrl, revision }` (the upstream remote's
 * fetch URL and the upstream commit SHA — a permalink, not a branch name) and
 * resolves `https://github.com/{owner}/{repo}/blob/{sha}/{path}#L{line}`
 * URLs for files inside git repositories with a supported (GitHub) remote.
 */
export const IPermalinkService = createDecorator<IPermalinkService>('glassPermalinkService');

export interface IPermalinkService {
	readonly _serviceBrand: undefined;

	/**
	 * Fires when cached repository link data changes (repositories added,
	 * removed, or their remote/upstream info refreshed).
	 */
	readonly onDidChange: Event<void>;

	/**
	 * Builds the remote file URL for `resource`, or `undefined` when it cannot
	 * be resolved (not in a git repo, no supported remote, or link data not
	 * cached yet — in which case a refresh is queued and `onDidChange` fires
	 * when it completes).
	 */
	resolveRemoteFileUrl(resource: URI | string, lineRange?: IRemoteFileLineRange): string | undefined;
}

/**
 * True when at least one git repository has resolvable remote file link data.
 * The permalink service maintains this; it gates the "Copy Remote URL" command.
 * (Cursor context key: `glassRemoteFileLinkAvailable`)
 */
export const GlassRemoteFileLinkAvailable = new RawContextKey<boolean>('glassRemoteFileLinkAvailable', false);
