/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Tab backend abstraction — moved verbatim from
// extensions/ide-agent/src/tab/backend.ts. Intentionally workbench-free:
// the engine is reached through the structural `TabCompletionEngine`
// interface (duck-typed), so this module never imports the adapter.
//
// NOTE (DEV-NO-FAKE): there is deliberately NO canned/fake/demo backend here.
// When the host resolves no real engine (stub engine mode), every method
// degrades honestly — `isEngineAvailable` is false, `fetchSuggestion` yields
// nothing, `availableModels` is empty — and the provider stays silent.
// There is nothing to migrate for the removed CannedTabBackend; it no longer
// exists in the source tree.

/**
 * Backend abstraction for Tab suggestions.
 *
 * The engine-backed `EngineTabBackend` below is the real implementation. It must:
 *   - fetchSuggestion: streaming completion RPC. Yields text deltas as they
 *     arrive; the final chunk has `done: true` and may carry `nextAction`
 *     (fused cursor prediction / next edit / chained follow-up) plus model
 *     identity for telemetry.
 *   - availableModels: model list for the status-bar model picker
 *     (Cursor: `cppServerBackendClient.availableModels()`).
 *   - fetchServerConfig: server-driven `cppConfig` (debounce millis,
 *     throttling thresholds, feature flags).
 *
 * This module is intentionally workbench-free. The engine is reached through the
 * structural `TabCompletionEngine` interface — duck-typed, so this module never
 * imports the adapter.
 */

import { NextAction, TabServerConfig, TriggerKind } from './types.js';

export interface TabRequestContext {
	uri: string;
	languageId: string;
	fileName: string;
	/** Text before the cursor (bounded by the caller). */
	prefix: string;
	/** Text after the cursor (bounded by the caller). */
	suffix: string;
	/** 0-based cursor position (vscode-convention wire shape; core callers convert). */
	position: { line: number; character: number };
	triggerKind: TriggerKind;
	/**
	 * M-09: model override from `ide.tab.model` (empty = server default).
	 * Stored as a "providerID/modelID" compound (or empty); the engine backend
	 * routes the request to this model.
	 */
	modelOverride?: string;
}

export interface TabSuggestionChunk {
	textDelta: string;
	done: boolean;
	nextAction?: NextAction;
	/** Chained follow-up id: a later suggestion with this id satisfies an
	 * earlier `nextAction: { action: 'followup', onAcceptDisplayId }`. */
	displayId?: string;
	modelId?: string;
	modelVersion?: string;
}

export interface TabModelInfo {
	id: string;
	displayName: string;
	isDefault?: boolean;
}

export interface TabBackend {
	fetchSuggestion(req: TabRequestContext, signal: AbortSignal): AsyncIterable<TabSuggestionChunk>;
	availableModels(): Promise<TabModelInfo[]>;
	fetchServerConfig(): Promise<Partial<TabServerConfig>>;
}

/**
 * The minimal engine surface the Tab backend needs. Satisfied structurally by
 * the ide-code engine adapter (which additionally spawns/owns the sidecar);
 * a stub adapter does NOT satisfy it (no `completeCode`), which is exactly
 * how stub mode is detected — no instanceof, no imports.
 */
export interface TabCompletionEngine {
	completeCode(
		prefix: string,
		suffix: string,
		modelId: string | undefined,
		signal: AbortSignal,
		context?: { languageId?: string; fileName?: string },
	): AsyncIterable<string>;
	listModels(): Promise<Array<{ id: string; providerID: string; name: string; variant?: string }>>;
	getDefaultModel(): Promise<{ id: string; providerID: string; name: string } | undefined>;
}

/** Feature-check: only a real engine adapter satisfies TabCompletionEngine. */
export function asTabEngine(value: unknown): TabCompletionEngine | undefined {
	if (!value || typeof value !== 'object') return undefined;
	const v = value as Record<string, unknown>;
	if (
		typeof v.completeCode !== 'function' ||
		typeof v.listModels !== 'function' ||
		typeof v.getDefaultModel !== 'function'
	) {
		return undefined;
	}
	return value as TabCompletionEngine;
}

/** A modelOverride is only honored when it looks like "providerID/modelID". */
function normalizeModelOverride(v: string | undefined): string | undefined {
	return v && /^[^/\s]+\/[^/\s]+$/.test(v) ? v : undefined;
}

const LEADING_FENCE_LINE_RE = /^```[A-Za-z0-9+#-]*\s*$/;
const TRAILING_FENCE_RE = /\s*```\s*$/;
/** Chars held back from the stream tail so a trailing fence can be detected. */
const TAIL_HOLD_CHARS = 8;

/**
 * The REAL Tab backend: completions come from the shared ide-code engine
 * sidecar (via the engine adapter's `completeCode`), reusing the already-
 * running process and a dedicated lightweight tab session. It never invents
 * suggestion text.
 *
 * When the host resolves no real engine (stub engine mode), every method
 * degrades honestly: `isEngineAvailable` is false, `fetchSuggestion` yields
 * nothing, `availableModels` is empty. The provider gate (not this class)
 * keeps Tab silent in that state — there is no demo/fake suggestion path.
 */
export class EngineTabBackend implements TabBackend {
	/**
	 * @param resolveEngine resolves the host's current engine adapter on every
	 * call (the active chat tab's adapter — same sidecar process, never a new
	 * one). May return undefined or a non-engine (stub) — both mean
	 * "no model backend".
	 */
	constructor(private readonly resolveEngine: () => unknown) { }

	/** True when a real engine adapter is currently wired up. */
	get isEngineAvailable(): boolean {
		try {
			return asTabEngine(this.resolveEngine()) !== undefined;
		} catch {
			return false;
		}
	}

	private engine(): TabCompletionEngine | undefined {
		try {
			return asTabEngine(this.resolveEngine());
		} catch {
			return undefined;
		}
	}

	/** Cached engine-default model id ("providerID/modelID"); null = unknown. */
	private defaultModelId: string | undefined | null;

	private async resolveModelId(engine: TabCompletionEngine, modelOverride: string | undefined): Promise<string | undefined> {
		const override = normalizeModelOverride(modelOverride);
		if (override) return override;
		if (this.defaultModelId !== undefined) return this.defaultModelId ?? undefined;
		try {
			const d = await engine.getDefaultModel();
			this.defaultModelId = d ? `${d.providerID}/${d.id}` : null;
		} catch {
			this.defaultModelId = null;
		}
		return this.defaultModelId ?? undefined;
	}

	async *fetchSuggestion(
		req: TabRequestContext,
		signal: AbortSignal,
	): AsyncIterable<TabSuggestionChunk> {
		const engine = this.engine();
		// No engine, no suggestions — never fake them.
		if (!engine) return;
		const modelId = await this.resolveModelId(engine, req.modelOverride);
		if (signal.aborted) return;

		// Paired fence stripping: models sometimes wrap the completion in
		// ```lang ... ``` despite the "no fences" instruction. The head is
		// buffered until the first line is known; a short tail is held back
		// until the stream ends. A trailing fence is stripped ONLY when a
		// leading fence was seen (paired) — a lone trailing ``` is likely real
		// content (e.g. closing a code block the user is writing).
		let head = '';
		let headResolved = false;
		let leadingFence = false;
		let tail = '';

		const resolveHead = (): string => {
			headResolved = true;
			const captured = head;
			head = '';
			const nl = captured.indexOf('\n');
			const firstLine = nl === -1 ? captured : captured.slice(0, nl);
			if (LEADING_FENCE_LINE_RE.test(firstLine)) {
				leadingFence = true;
				return nl === -1 ? '' : captured.slice(nl + 1);
			}
			return captured;
		};

		const stream = engine.completeCode(
			req.prefix,
			req.suffix,
			normalizeModelOverride(req.modelOverride),
			signal,
			{ languageId: req.languageId, fileName: req.fileName },
		);
		for await (const delta of stream) {
			if (signal.aborted) break;
			if (typeof delta !== 'string' || delta.length === 0) continue;
			let piece: string;
			if (!headResolved) {
				head += delta;
				// Wait for the first full line (or a bounded head) before deciding
				// about a leading fence; the stream end resolves it regardless.
				if (head.indexOf('\n') === -1 && head.length < 128) continue;
				piece = resolveHead();
			} else {
				piece = delta;
			}
			const combined = tail + piece;
			if (combined.length <= TAIL_HOLD_CHARS) {
				tail = combined;
				continue;
			}
			const emit = combined.slice(0, combined.length - TAIL_HOLD_CHARS);
			tail = combined.slice(combined.length - TAIL_HOLD_CHARS);
			if (emit.length > 0) {
				yield { textDelta: emit, done: false, modelId };
			}
		}
		// Never emit after an abort — not even the "done" chunk. The provider
		// discards post-abort chunks, and a done chunk for a killed request
		// would confuse fate tracking. (The underlying stream may also have
		// ended early *because* of the abort, so check the signal, not just the
		// loop's own break.)
		if (signal.aborted) return;
		let finalText = (headResolved ? '' : resolveHead()) + tail;
		if (leadingFence) {
			finalText = finalText.replace(TRAILING_FENCE_RE, '');
		}
		yield { textDelta: finalText, done: true, modelId };
	}

	async availableModels(): Promise<TabModelInfo[]> {
		const engine = this.engine();
		if (!engine) return [];
		try {
			const models = await engine.listModels();
			return models.map((m) => ({
				// Compound id round-trips through ide.tab.model → completeCode.
				id: `${m.providerID}/${m.id}`,
				displayName: m.name && m.name.length > 0 ? m.name : m.id,
			}));
		} catch {
			// Engine unreachable: honest empty list, never a fake entry.
			return [];
		}
	}

	async fetchServerConfig(): Promise<Partial<TabServerConfig>> {
		// Honest: there is no Tab model server — client defaults stand.
		return { isOn: true, isGhostText: true };
	}
}
