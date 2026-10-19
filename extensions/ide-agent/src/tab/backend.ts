/**
 * Backend abstraction for Tab suggestions.
 *
 * The real model server plugs in here later. It must provide:
 *   - fetchSuggestion: streaming completion RPC. Yields text deltas as they
 *     arrive; the final chunk has `done: true` and may carry `nextAction`
 *     (fused cursor prediction / next edit / chained follow-up) plus model
 *     identity for telemetry.
 *   - availableModels: model list for the status-bar model picker
 *     (Cursor: `cppServerBackendClient.availableModels()`).
 *   - fetchServerConfig: server-driven `cppConfig` (debounce millis,
 *     throttling thresholds, feature flags).
 *
 * The bundled `CannedTabBackend` returns a clearly-labeled canned suggestion
 * so every mechanic (debounce, accept, fate, next-edit) is exercisable without
 * a model server. It never pretends to be a real model.
 */

import { NextAction, TabServerConfig, TriggerKind } from './types';

export interface TabRequestContext {
  uri: string;
  languageId: string;
  fileName: string;
  /** Text before the cursor (bounded by the caller). */
  prefix: string;
  /** Text after the cursor (bounded by the caller). */
  suffix: string;
  position: { line: number; character: number };
  triggerKind: TriggerKind;
  /**
   * M-09: model override from `ide.tab.model` (empty = server default).
   * Real backends route the request to this model; the canned backend ignores
   * it (it has exactly one demo model).
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

const CANNED_LABEL = '[IDE Tab demo] no model backend connected — canned suggestion.';

/**
 * Visibly-labeled stub backend. Streams a small demo suggestion in chunks so
 * the whole client pipeline (streaming, coalescing, accept, fate) is real.
 */
export class CannedTabBackend implements TabBackend {
  async *fetchSuggestion(
    req: TabRequestContext,
    signal: AbortSignal,
  ): AsyncIterable<TabSuggestionChunk> {
    const chunks = [
      `// ${CANNED_LABEL}\n`,
      `// trigger: ${req.triggerKind} · lang: ${req.languageId}\n`,
      `function ideTabDemo() {\n  return 'connect a model backend';\n}\n`,
    ];
    for (let i = 0; i < chunks.length; i++) {
      if (signal.aborted) return;
      // Small async gap so streaming/abort paths are genuinely exercised.
      await new Promise((r) => setTimeout(r, 15));
      if (signal.aborted) return;
      yield {
        textDelta: chunks[i]!,
        done: i === chunks.length - 1,
        modelId: 'canned-demo',
        modelVersion: '0.1.0',
      };
    }
  }

  async availableModels(): Promise<TabModelInfo[]> {
    return [{ id: 'canned-demo', displayName: 'Demo (no backend)', isDefault: true }];
  }

  async fetchServerConfig(): Promise<Partial<TabServerConfig>> {
    // Server-overridable debounce defaults; canned backend keeps client defaults.
    return { isOn: true, isGhostText: true };
  }
}
