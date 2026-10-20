/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Migrated from extensions/ide-agent/services/codebaseIndexService.ts — vscode API → DI
//
// Layer split (P0 node-free common/): the `CodebaseIndexService`
// implementation shells out to the engine's indexing CLI via
// node:child_process, so it lives in `electron-browser/codebaseIndexService.ts`
// (desktop-only). This module keeps the node-free DI contract — the
// `ICodebaseIndexService` decorator, the service interface, and the hit
// shapes — so common/ and browser/ code can depend on the service without
// pulling node builtins into the web bundle.

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const ICodebaseIndexService = createDecorator<ICodebaseIndexService>('composerCodebaseIndexService');

export interface CodebaseTextHit {
	kind: 'text';
	path: string;
	line: number;
	text: string;
}

export interface CodebaseSymbolHit {
	kind: 'symbol';
	path: string;
	name: string;
	symbolKind: string;
	line: number;
	signature: string;
}

export type CodebaseHit = CodebaseTextHit | CodebaseSymbolHit;

export interface ICodebaseIndexService {
	readonly _serviceBrand: undefined;

	/**
	 * Instant Grep over the local index. Returns [] when the engine/CLI is
	 * unavailable — the caller treats that as "no data".
	 */
	searchCodebase(query: string, opts?: { limit?: number; symbols?: boolean; include?: string }): Promise<CodebaseHit[]>;

	/** Index status for diagnostics; undefined when unavailable. */
	codebaseIndexStatus(): Promise<unknown | undefined>;
}
