/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: MCP service DI contract (node-free).
//
// Layer split (P0 node-free common/): the `McpService` implementation wires
// together config discovery (node:fs), server lifecycle (node:child_process /
// node:events) and the HTTP transports (node:http/https), so it lives in
// `electron-browser/mcp/service.ts` (desktop-only). This module keeps the
// node-free contract — the `IMcpService` decorator, the service interface,
// and the event/result shapes — so common/ and browser/ code can depend on
// MCP without pulling node builtins into the web bundle.
//
// (Doc comment preserved from the original service.ts:)
// McpService — workbench MCP client facade.
// Wires together: config discovery (config.ts), server lifecycle
// (serverManager.ts), tool namespacing (names.ts) and the approval gate
// (allowlist.ts → HumanReviewService approval card, trigger reason
// `mcpToolsProtection`, card label `MCP:<tool>`).
//
// HONEST GAPS (not implemented, not faked):
// - OAuth flows incl. token storage (§B6)
// - Prompts, Resources, Elicitation, MCP Apps (§B9)
// - `vscode.cursor.mcp.registerServer()` extension API (§B5)

import { Event } from "../../../../../base/common/event.js";
import { createDecorator } from "../../../../../platform/instantiation/common/instantiation.js";
import {
	McpServerStatus,
	McpToolInfo,
} from "./types.js";
import { McpCallResult, normalizeResult } from "./results.js";

export type { McpCallResult };

export type McpServiceEvent =
	| { kind: "serversChanged" }
	| { kind: "toolsChanged" };

/** Re-exported for callers that only need the result shape. */
export { normalizeResult };

export const IMcpService = createDecorator<IMcpService>('composerMcpService');

/** Minimal output-channel surface the MCP service needs (was vscode.OutputChannel). */
export interface IMcpOutputChannel {
	appendLine(message: string): void;
	show(preserveFocus?: boolean): void;
	dispose(): void;
}

export interface IMcpService {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<McpServiceEvent>;
	start(): void;
	getServerStatuses(): McpServerStatus[];
	getTools(): McpToolInfo[];
	restartServer(id: string): void;
	showOutput(id: string): void;
	callTool(namespacedName: string, args: Record<string, unknown>, opts: { toolCallId: string; timeoutMs?: number }): Promise<McpCallResult>;
	dispose(): void;
}
