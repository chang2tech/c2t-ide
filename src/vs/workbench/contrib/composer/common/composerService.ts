/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Service contract for the Composer (AI chat) workbench contribution.
// Skeleton only — real engine wiring (ide-agent extension backend) lands later.

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';

export const IComposerService = createDecorator<IComposerService>('composerService');

/**
 * High-level service exposing the Composer (AI chat) capabilities to the
 * workbench: session lifecycle, focus helpers, and composer events.
 * TODO(composer): flesh out the contract as the engine bridge lands.
 */
export interface IComposerService {
	readonly _serviceBrand: undefined;

	/** Fires when the active composer session changes. */
	readonly onDidChangeActiveSession: Event<string | undefined>;

	/** TODO(composer): start a new composer session. */
	startSession(): Promise<string>;

	/** TODO(composer): focus the composer chat view. */
	focusChat(): Promise<void>;

	/**
	 * Dispatch a legacy `ide.*` command id to its ported handler.
	 *
	 * Called by the Action2 registrations in `browser/composerActions.ts`
	 * (one action per legacy command; see LEGACY_COMMAND_MAP there for the
	 * full old-id -> new-id table).
	 *
	 * TODO(composer): implement the dispatch. The handler bodies live in
	 * `extensions/ide-agent/src/extension.ts`'s registration switch (chat
	 * commands), `tab/extension.ts` (tab.* commands), and `mcp/service.ts`
	 * (mcp.* commands). Port each group into dedicated methods on this
	 * service (or into focused services injected here) and route by id.
	 * Until then every composer.* action throws a "not implemented" error.
	 */
	executeLegacyCommand(legacyId: string, ...args: unknown[]): Promise<unknown>;
}

/**
 * Skeleton implementation. Registered with InstantiationType.Delayed so it is
 * only constructed when first resolved.
 * TODO(composer): replace with the real engine-backed implementation.
 */
export class ComposerService extends Disposable implements IComposerService {

	declare readonly _serviceBrand: undefined;

	// TODO(composer): real session tracking.
	readonly onDidChangeActiveSession: Event<string | undefined> = Event.None;

	async startSession(): Promise<string> {
		// TODO(composer): create a session through the ide-agent extension backend.
		throw new Error('IComposerService.startSession is not implemented yet');
	}

	async focusChat(): Promise<void> {
		// TODO(composer): open/focus the composer.chat view.
		throw new Error('IComposerService.focusChat is not implemented yet');
	}

	async executeLegacyCommand(legacyId: string, ...args: unknown[]): Promise<unknown> {
		// TODO(composer): dispatch to the ported handler for `legacyId`
		// (see the interface doc). Kept throwing until the engine bridge lands.
		void args;
		throw new Error(`IComposerService.executeLegacyCommand(${legacyId}) is not implemented yet`);
	}
}
