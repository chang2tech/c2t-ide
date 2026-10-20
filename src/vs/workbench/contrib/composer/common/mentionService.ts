/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Mention service DI contract (node-free).
//
// Layer split (P0 node-free common/): the `MentionService` implementation
// reads the filesystem (node:fs), shells out to `git` (node:child_process)
// and captures browser-tab screenshots, so it lives in
// `electron-browser/mentionService.ts` (desktop-only). This module keeps the
// node-free contract — the `IMentionService` decorator, the service
// interface, the `FileAttachment` shape, and the shared mention-model
// re-exports — so common/ and browser/ code can depend on mentions without
// pulling node builtins into the web bundle.

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import {
	MentionChip,
	MentionItem,
	MentionKind,
	MentionPayload,
	MENTION_ITEM_CAP,
	MENTION_QUERY_CAP,
	isMentionChip,
	matchesMentionQuery,
	normalizeMentionQuery,
	parseMentionScope,
} from "../../agents/common/mentionMatch.js";
// Re-export the shared mention model for consumers (workbench wiring).
export {
	MentionChip,
	MentionItem,
	MentionKind,
	MentionPayload,
	MENTION_ITEM_CAP,
	MENTION_QUERY_CAP,
	isMentionChip,
	matchesMentionQuery,
	normalizeMentionQuery,
	parseMentionScope,
};

export const IMentionService = createDecorator<IMentionService>('composerMentionService');

/**
 * A file attachment for the engine prompt (mirrors PromptInput.FileAttachment:
 * {uri, name, description}). Used for browser-tab screenshots — the engine
 * reads the PNG as an image part.
 */
export interface FileAttachment {
	uri: string;
	name: string;
	description?: string;
}

export interface IMentionService {
	readonly _serviceBrand: undefined;

	/** All 15 provider kinds this service covers (for parity audits). */
	coveredKinds(): MentionKind[];

	/** Resolve mention menu items for a raw `@` query. */
	getMentionItems(rawQuery: string): Promise<MentionItem[]>;

	/** Resolve a chip to its model-visible context block. */
	resolveMentionContext(chip: MentionChip): Promise<string>;

	/** Build the engine prompt: user text + one context block per mention chip. */
	composePromptWithMentions(text: string, chips: MentionChip[]): Promise<string>;

	/** Extract real file attachments from image chips (browser-tab screenshots). */
	extractFileAttachments(chips: MentionChip[]): FileAttachment[];
}
