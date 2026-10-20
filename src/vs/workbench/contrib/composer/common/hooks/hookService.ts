/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Hook service DI contract (node-free).
//
// Layer split (P0 node-free common/): the `HookService` implementation loads
// hook configs from disk (node:fs) and spawns hook processes
// (node:child_process via hookLoader/hookRunner), so it lives in
// `electron-browser/hooks/hookService.ts` (desktop-only). This module keeps
// the node-free contract — the option/result shapes and the `IHookService`
// interface — so common/ and browser/ code can depend on hooks without
// pulling node builtins into the web bundle.

import {
	ExecutionLogEntry,
	HookEventName,
	HookResult,
} from "./hookTypes.js";

/** Evaluates prompt-type hooks. Injected; the default skips honestly. */
export type PromptEvaluator = (
	prompt: string,
	model?: string,
) => Promise<{ ok: boolean; reason?: string }>;

export interface HookServiceOptions {
	workspaceRoots: string[];
	appVersion: string;
	/** Line sink for the execution log (e.g. an OutputChannel). */
	log: (line: string) => void;
	extraEnv?: Record<string, string>;
	promptEvaluator?: PromptEvaluator;
	userEmail?: string;
	transcriptPath?: string;
	conversationId?: string;
}

export interface ToolGateContext {
	sessionID?: string;
	/** Raw shell command text (for beforeShellExecution matcher). */
	command?: string;
}

export interface ToolGateResult {
	blocked: boolean;
	reason?: string;
	/** Follow-up context the hooks produced (appended to the turn). */
	contextAdditions: string[];
	/**
	 * IDE-CODE (hooks-deny-message-routing): concatenated `user_message`
	 * values from every hook that ran in the gate. Cursor parity — binary
	 * (cursor-agent-exec/dist/main.js, 3.25.6): on deny the agent-facing
	 * denial embeds it, e.g. `${tool} blocked by preToolUse hook:
	 * ${userMessage}`, delivered as a rejected tool result; official docs
	 * (cursor.com/docs/agent/hooks): "Message shown to the user when the
	 * action is denied". The adapter routes these into the engine request
	 * context (permission reply `message`) and the user-facing tool card.
	 */
	userMessages: string[];
	/**
	 * IDE-CODE (hooks-deny-message-routing): concatenated `agent_message`
	 * values from every hook that ran in the gate. Cursor official docs:
	 * "Message fed back to the agent when the action is denied". The adapter
	 * routes these into the engine request context (permission reply
	 * `message`) on deny.
	 */
	agentMessages: string[];
}

/**
 * Node-free surface of the hook service. The implementation
 * (`electron-browser/hooks/hookService.ts`) is constructed with
 * `HookServiceOptions`.
 */
export interface IHookService {
	refresh(): void;
	getConfigErrors(): string[];
	getLoadedHookCount(): number;
	hasHooks(event: HookEventName): boolean;
	getLoopLimit(event: HookEventName): number;
	getExecutionLog(): ExecutionLogEntry[];
	clearExecutionLog(): void;
	drainContextAdditions(scope?: string): string[];
	runHooks(event: HookEventName, extras?: Record<string, unknown>, scope?: string): Promise<HookResult>;
	checkToolGate(action: string, resources: string[], ctx?: ToolGateContext, scope?: string): Promise<ToolGateResult>;
}
