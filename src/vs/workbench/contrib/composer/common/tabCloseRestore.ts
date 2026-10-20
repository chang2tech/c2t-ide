/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Pure (zero-dependency) helpers for "Cmd+Shift+T reopens the last
// closed chat/app tab" (WORKER-GAPS-66D, `tab-close-restore`).
//
// Binary evidence (Cursor 3.25.9):
//   - workbench.glass.main.js @27652666: HistoryService keeps
//     `recentlyClosedEditors` (MAX_RECENTLY_CLOSED_EDITORS) and exposes
//     `reopenLastClosedEditor()` — the same stock mechanism VS Code uses.
//   - workbench.glass.main.js @38319944: Action2
//     `workbench.action.reopenClosedEditor` ("Reopen Closed Editor", f1:!0,
//     keybinding CtrlCmd|Shift|KeyT, weight 200 = WorkbenchContrib).
//   - workbench.glass.main.js @27634878: the composer chat EditorInput has
//     `get resource(){return jng(this.composerId)}` and
//     `toUntyped(){return t={resource:this.resource,options:{override:LJt}}}`.
//   - workbench.glass.main.js @26562063: the review-changes EditorInput has
//     `toUntyped(){return{resource:this.resource,options:{override:ZV.ID,pinned:!0}}}`.
// Docs evidence: cursor.com/docs/release-notes — "Cmd+Shift+T reopens whatever
// you closed most recently, chat or app tab, including Agent, Environment,
// Changes, Desktop, Machine, and voice call transcript tabs."
//
// What was missing in the fork: none of the composer EditorInputs implemented
// `toUntyped()` — the base EditorInput returns `undefined`, and
// HistoryService.handleEditorCloseEventInReopen drops such editors before they
// reach the recently-closed stack, so `reopenLastClosedEditor()` could never
// restore them. Implementing `toUntyped()` on the input classes (exactly what
// Cursor does) plugs them into the stock reopen flow — no history-service
// changes needed.

/**
 * Editor ids (verbatim in the binary: composerId -> "ide-chat" resources).
 * Mirrors the static ID fields of the browser EditorInput classes; defined
 * here so the reopen factories can reference them without a common -> browser
 * dependency.
 */
export const COMPOSER_CHAT_EDITOR_ID = 'composer.chatEditor';
export const COMPOSER_CHANGES_EDITOR_ID = 'composer.changesTab';
export const COMPOSER_REVIEW_CHANGES_EDITOR_ID = 'composer.reviewChangesTab';
export const COMPOSER_CUSTOMIZE_EDITOR_ID = 'composer.customizeEditor';

/** URI schemes of the composer editor documents (verbatim). */
export const COMPOSER_CHAT_SCHEME = 'ide-chat';
export const COMPOSER_CHANGES_SCHEME = 'composer-changes';
export const COMPOSER_CUSTOMIZE_SCHEME = 'ide-customize';

/**
 * Minimal structural view of a URI — the module stays dependency-free, so the
 * browser callers pass `{ scheme, path, query }` taken from a real URI.
 */
export interface ITabResourceParts {
	readonly scheme: string;
	readonly path: string;
	readonly query: string;
}

/**
 * The untyped shape HistoryService records for a closed editor. Uses a generic
 * resource type so browser callers pass real URIs while unit tests stay
 * dependency-free.
 */
export interface IReopenUntypedInput<TResource> {
	readonly resource: TResource;
	readonly options: {
		/** The editor id — the resolver uses it to pick the input factory. */
		readonly override: string;
		readonly pinned?: boolean;
	};
}

/**
 * Builds the untyped reopen record for a composer editor input.
 *
 * Cursor parity: the chat input builds `{resource, options: {override}}`
 * (binary @27634878); the review-changes input builds
 * `{resource, options: {override, pinned: true}}` (binary @26562063).
 */
export function buildReopenUntypedInput<TResource>(
	resource: TResource,
	editorId: string,
	pinned?: boolean,
): IReopenUntypedInput<TResource> {
	return pinned
		? { resource, options: { override: editorId, pinned: true } }
		: { resource, options: { override: editorId } };
}

/**
 * Parses a `ide-chat:/<tabId>` resource (fail-closed, same rules as the
 * browser-side `composerChatTabIdFromUri`).
 */
export function parseComposerChatTabRef(parts: ITabResourceParts): string | undefined {
	if (parts.scheme !== COMPOSER_CHAT_SCHEME) {
		return undefined;
	}
	const id = parts.path.replace(/^\//, '');
	if (!id || id.includes('/') || id === '.' || id === '..' || id.includes('..')) {
		return undefined;
	}
	return id;
}

/** A parsed `composer-changes:` tab resource. */
export interface IComposerChangesTabRef {
	/** `changes` = Changes tab (`/<agentId>`), `review` = Review Changes tab (`/review/<agentId>`). */
	readonly kind: 'changes' | 'review';
	readonly agentId: string;
	/** From the `?scope=` query (may be empty on old serializations). */
	readonly scope: string;
}

function isSafePathSegment(segment: string): boolean {
	return !!segment && !segment.includes('/') && segment !== '.' && segment !== '..';
}

/**
 * Parses `composer-changes:/<agentId>?scope=<scope>` and
 * `composer-changes:/review/<agentId>?scope=<scope>` resources.
 */
export function parseComposerChangesTabRef(parts: ITabResourceParts): IComposerChangesTabRef | undefined {
	if (parts.scheme !== COMPOSER_CHANGES_SCHEME) {
		return undefined;
	}
	const segments = parts.path.replace(/^\//, '').split('/');
	let kind: 'changes' | 'review';
	let agentId: string;
	if (segments.length === 1 && isSafePathSegment(segments[0])) {
		kind = 'changes';
		agentId = segments[0];
	} else if (segments.length === 2 && segments[0] === 'review' && isSafePathSegment(segments[1])) {
		kind = 'review';
		agentId = segments[1];
	} else {
		return undefined;
	}
	let scope = '';
	try {
		scope = new URLSearchParams(parts.query).get('scope') ?? '';
	} catch {
		scope = '';
	}
	return { kind, agentId, scope };
}

/**
 * Parses an `ide-customize:/<section>` resource. The set of valid sections
 * comes from the browser-side list (passed in to keep this module
 * dependency-free). Generic over the section union so callers keep their
 * section type without a cast.
 */
export function parseComposerCustomizeTabRef<T extends string>(
	parts: ITabResourceParts,
	validSections: readonly T[],
): T | undefined {
	if (parts.scheme !== COMPOSER_CUSTOMIZE_SCHEME) {
		return undefined;
	}
	const section = parts.path.replace(/^\//, '');
	if (!section || section.includes('/') || section === '.' || section === '..') {
		return undefined;
	}
	return validSections.find(candidate => candidate === section);
}
