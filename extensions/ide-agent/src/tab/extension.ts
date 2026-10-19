/**
 * Extension entry point for the IDE Tab module.
 * Wires the TabCompletionProvider, accept commands, snooze, status bar and
 * triggers together. Designed to merge into ide-agent's extension.ts
 * (see package.fragment.json for the mechanical merge).
 */

import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { acceptFullSuggestion, acceptPartialSuggestion, peekSuggestion, revertSuggestion } from './accept';
import { CannedTabBackend, TabBackend, TabModelInfo } from './backend';
import { NextActionEffect, FollowupRegistry, resolveNextAction } from './nextEdit';
import { TabCompletionProvider } from './provider';
import { typeOverText } from './wordAccept';
import { SnoozeManager, SnoozeStorage } from './snooze';
import { TabStatusBar } from './statusBar';
import { ClearedSuggestionTracker, TabTelemetry } from './telemetry';
import { gateEditor } from './gates';
import {
  DEFAULT_CLIENT_CONFIG,
  SNOOZE_OPTIONS_MS,
  TabClientConfig,
  TabFate,
  TabServerConfig,
  TriggerKind,
} from './types';
import { DEFAULT_DEBOUNCE } from './debounce';
import { HookService } from '../hooks/hookService';

const PER_LANG_KEY = 'ide.tab.perLanguage';
const COPILOT_PROMPTED_KEY = 'ide.tab.copilotPrompted';

function readClientConfig(): TabClientConfig {
  const c = vscode.workspace.getConfiguration('ide.tab');
  const general = vscode.workspace.getConfiguration('ide.general');
  // SETTINGS-PARITY: privacy mode forces telemetry off (local-first).
  const privacyMode = general.get<boolean>('privacyMode', true);
  // SETTINGS-PARITY: the global ignore list applies to Tab like a
  // workspace-wide .cursorignore (Cursor parity).
  const globalIgnore = general.get<string[]>('globalCursorIgnoreList', []);
  const delayRaw = c.get<number>('suggestionDelayMs', DEFAULT_CLIENT_CONFIG.suggestionDelayMs);
  return {
    enabled: c.get<boolean>('enabled', DEFAULT_CLIENT_CONFIG.enabled),
    enablePartialAccepts: c.get<boolean>('enablePartialAccepts', DEFAULT_CLIENT_CONFIG.enablePartialAccepts),
    disabledLanguages: c.get<string[]>('disabledLanguages', []),
    ignorePatterns: [...c.get<string[]>('ignorePatterns', []), ...globalIgnore],
    model: c.get<string>('model', ''),
    maxConcurrentRequests: c.get<number>('maxConcurrentRequests', DEFAULT_CLIENT_CONFIG.maxConcurrentRequests),
    telemetryEnabled: c.get<boolean>('telemetryEnabled', true) && !privacyMode,
    promptDisableCopilot: c.get<boolean>('promptDisableCopilot', true),
    suggestionDelayMs: clampInt(delayRaw, 0, 1000, DEFAULT_CLIENT_CONFIG.suggestionDelayMs),
    suggestionWhileCommenting: c.get<boolean>(
      'suggestionWhileCommenting',
      DEFAULT_CLIENT_CONFIG.suggestionWhileCommenting,
    ),
  };
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v)
    ? Math.min(max, Math.max(min, Math.floor(v)))
    : fallback;
}

class MementoSnoozeStorage implements SnoozeStorage {
  constructor(private memento: vscode.Memento) {}
  get(key: string): number | undefined {
    return this.memento.get<number>(key);
  }
  set(key: string, value: number | undefined): void {
    void this.memento.update(key, value);
  }
}

export async function activate(
  context: vscode.ExtensionContext,
  /**
   * DEV-HOOKS: Cursor-style agent hooks for the two Tab events
   * (beforeTabFileRead / afterTabFileEdit). Optional.
   */
  agentHooks?: HookService,
): Promise<void> {
  let clientConfig = readClientConfig();

  const snooze = new SnoozeManager(new MementoSnoozeStorage(context.globalState), () => {
    void vscode.window.showInformationMessage('IDE Tab unsnoozed.');
    refreshStatusBar();
  });
  snooze.maybeReenable();

  let logDir: string;
  try {
    logDir = path.join(context.globalStorageUri.fsPath, 'tab-logs');
  } catch {
    logDir = path.join(os.tmpdir(), 'ide-tab-logs');
  }
  const telemetry = new TabTelemetry(logDir, () => clientConfig.telemetryEnabled);

  // Backend: canned until a model server is configured (see README).
  const backend: TabBackend = new CannedTabBackend();

  // P2 (QA-FILE-06): chained follow-up suggestions keyed by display id
  // (Cursor: followupSuggestions.getAndEvictMatchingSuggestion). Populated by
  // onSuggestionShown below; consumed by applyNextActionEffect on accept.
  const followups = new FollowupRegistry<{ requestId: string; text: string }>();

  let ownEdit = false;
  const provider = new TabCompletionProvider(backend, telemetry, {
    getClientConfig: () => clientConfig,
    getPerLanguageState: () => context.globalState.get<Record<string, 'disabled' | 'enabled'>>(PER_LANG_KEY, {}),
    isSnoozed: () => snooze.isSnoozed(),
    onSuggestionShown: (requestId, text, displayId) => {
      telemetry.recordSessionEvent('tabShown', { requestId, length: text.length });
      if (displayId) followups.set(displayId, { requestId, text });
    },
    onFirstSuggestion: () => void maybePromptDisableCopilot(),
  }, agentHooks);

  const cleared: ClearedSuggestionTracker = provider.cleared;

  /**
   * SETTINGS-PARITY: `ide.tab.suggestionDelayMs` — the client debounce comes
   * from config; a server-provided value (refreshServerConfig) still wins
   * because it patches afterwards.
   */
  function applyDebounceConfig(): void {
    provider.debounce.setDurations({ clientMs: clientConfig.suggestionDelayMs });
  }
  applyDebounceConfig();

  /**
   * M-09: dedicated Tab model picker. Lists the backend's available models
   * plus "Server default" (empty = server picks). Persists to ide.tab.model;
   * the status bar refresh and request routing pick the new value up live.
   */
  async function pickTabModel(): Promise<TabModelInfo | undefined> {
    const models = await backend.availableModels();
    const current = vscode.workspace.getConfiguration('ide.tab').get<string>('model', '');
    interface TabModelPickItem extends vscode.QuickPickItem {
      modelId: string;
    }
    const items: TabModelPickItem[] = [
      {
        label: 'Server default',
        description: current === '' ? '(current)' : 'let the server choose',
        modelId: '',
      },
      ...models.map((m) => ({
        label: m.displayName,
        description: m.id === current ? `${m.id} (current)` : m.id,
        modelId: m.id,
      })),
    ];
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select IDE Tab model',
    });
    if (pick) {
      await vscode.workspace.getConfiguration('ide.tab').update('model', pick.modelId, true);
      refreshStatusBar();
    }
    return pick ? models.find((m) => m.id === pick.modelId) : undefined;
  }

  const statusBar = new TabStatusBar({
    toggleGlobal: async () => {
      await vscode.workspace.getConfiguration('ide.tab').update('enabled', !clientConfig.enabled, true);
    },
    toggleLanguage: async (languageId: string) => {
      const state = context.globalState.get<Record<string, 'disabled' | 'enabled'>>(PER_LANG_KEY, {});
      const cur = state[languageId];
      state[languageId] = cur === 'disabled' ? 'enabled' : 'disabled';
      await context.globalState.update(PER_LANG_KEY, state);
      refreshStatusBar();
    },
    snooze: (ms: number) => {
      snooze.snooze(ms);
      refreshStatusBar();
    },
    unsnooze: () => {
      snooze.unsnooze();
      refreshStatusBar();
    },
    pickModel: () => pickTabModel(),
  });

  function refreshStatusBar(): void {
    const editor = vscode.window.activeTextEditor;
    const languageId = editor?.document.languageId ?? '';
    let ignored = false;
    if (editor) {
      const gate = gateEditor({
        charCount: editor.document.getText().length,
        fsPath: editor.document.uri.fsPath,
        relPath: vscode.workspace.asRelativePath(editor.document.uri),
        languageId,
        disabledLanguages: clientConfig.disabledLanguages,
        perLanguageState: context.globalState.get(PER_LANG_KEY, {}),
        ignorePatterns: clientConfig.ignorePatterns,
      });
      ignored = !gate.allowed && gate.reason === 'ignored';
    }
    const perLang = context.globalState.get<Record<string, 'disabled' | 'enabled'>>(PER_LANG_KEY, {});
    statusBar.refresh({
      enabled: clientConfig.enabled,
      snoozed: snooze.isSnoozed(),
      ignored,
      languageId,
      languageDisabled: perLang[languageId] === 'disabled' || clientConfig.disabledLanguages.includes(languageId),
      modelName: clientConfig.model || 'default',
      snoozedUntil: snooze.snoozedUntil(),
    });
    void vscode.commands.executeCommand('setContext', 'ideTab.snoozed', snooze.isSnoozed());
    void vscode.commands.executeCommand('setContext', 'ideTab.enabled', clientConfig.enabled);
  }

  /** Apply a next-edit effect after an accept. */
  async function applyNextActionEffect(effect: NextActionEffect): Promise<void> {
    switch (effect.kind) {
      case 'jump': {
        try {
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(effect.uri));
          const editor = await vscode.window.showTextDocument(doc);
          const pos = new vscode.Position(
            Math.min(effect.line, doc.lineCount - 1),
            effect.character,
          );
          editor.selection = new vscode.Selection(pos, pos);
          editor.revealRange(new vscode.Range(pos, pos));
          telemetry.recordSessionEvent('acceptCursorPrediction', { uri: effect.uri, line: effect.line });
          if (effect.retrigger) {
            provider.setPendingTrigger('cursor_prediction');
            await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
          }
        } catch {
          // Jump target may not exist (yet) — never break the accept flow.
        }
        break;
      }
      case 'refire': {
        provider.setPendingTrigger('unknown');
        await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
        break;
      }
      case 'followup': {
        const chained = followups.getAndEvict(effect.displayId);
        if (chained) {
          telemetry.recordSessionEvent('followupShown', { displayId: effect.displayId });
          provider.setPendingTrigger('unknown');
          await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
        }
        break;
      }
      case 'none':
        break;
    }
  }

  function acceptDeps(editor: vscode.TextEditor) {
    return {
      session: provider.session,
      editor,
      fate: provider.fate,
      cleared,
      telemetry,
      setOwnEdit: (v: boolean) => {
        ownEdit = v;
      },
      agentHooks,
    };
  }

  function activeEditorOrWarn(): vscode.TextEditor | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor) void vscode.window.showWarningMessage('IDE Tab: no active editor.');
    return editor;
  }

  async function maybePromptDisableCopilot(): Promise<void> {
    if (!clientConfig.promptDisableCopilot) return;
    if (context.globalState.get<boolean>(COPILOT_PROMPTED_KEY, false)) return;
    await context.globalState.update(COPILOT_PROMPTED_KEY, true);
    const copilot = vscode.extensions.getExtension('github.copilot');
    if (!copilot) return;
    const choice = await vscode.window.showInformationMessage(
      'IDE Tab is active. Disable GitHub Copilot to avoid duplicate inline suggestions?',
      'Disable Copilot',
      'Keep both',
    );
    if (choice === 'Disable Copilot') {
      try {
        await vscode.commands.executeCommand('github.copilot.toggleCopilot');
      } catch {
        // Copilot command surface varies; the prompt itself is the deliverable.
      }
    }
  }

  // ---- server-driven config (debounce overrides, throttles, models) ----
  // P2 (QA-04): clamp every server value to a sane range — a misconfigured or
  // malicious server must not be able to freeze Tab (huge debounce) or
  // exhaust resources (huge concurrency).
  function clampTabNumber(v: number, min: number, max: number, fallback: number): number {
    if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(v)));
  }

  async function refreshServerConfig(): Promise<void> {
    try {
      const sc: Partial<TabServerConfig> = await backend.fetchServerConfig();
      const patch: Partial<{ clientMs: number; totalMs: number }> = {};
      if (typeof sc.clientDebounceDurationMillis === 'number') {
        patch.clientMs = clampTabNumber(sc.clientDebounceDurationMillis, 0, 1000, DEFAULT_DEBOUNCE.clientMs);
      }
      if (typeof sc.globalDebounceDurationMillis === 'number') {
        patch.totalMs = clampTabNumber(sc.globalDebounceDurationMillis, 0, 1000, DEFAULT_DEBOUNCE.totalMs);
      }
      if (Object.keys(patch).length > 0) provider.debounce.setDurations(patch);
      if (typeof sc.maxNumberOfClearedSuggestionsSinceLastAccept === 'number') {
        cleared.setMax(clampTabNumber(sc.maxNumberOfClearedSuggestionsSinceLastAccept, 0, 1000, 5));
      }
      if (typeof sc.maxConcurrentRequests === 'number') {
        clientConfig = {
          ...clientConfig,
          maxConcurrentRequests: clampTabNumber(
            sc.maxConcurrentRequests,
            1,
            8,
            DEFAULT_CLIENT_CONFIG.maxConcurrentRequests,
          ),
        };
      }
    } catch {
      // Offline / no server: keep client defaults.
    }
  }

  // ---- trigger wiring ----
  const triggerDebounced = (kind: TriggerKind) => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    provider.debounce.schedule(`trigger:${editor.document.uri.toString()}`, () => {
      provider.setPendingTrigger(kind);
      void vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
    });
  };

  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider([{ scheme: 'file' }, { scheme: 'untitled' }], provider),
    statusBar,
    // P2 (QA-FILE-06): flush batched telemetry on deactivate.
    { dispose: () => telemetry.dispose() },

    // Typing / edits → suggestion trigger (own accept edits are excluded).
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (ownEdit) return;
      const editor = vscode.window.activeTextEditor;
      if (!editor || e.document.uri.toString() !== editor.document.uri.toString()) return;
      const s = provider.session.current;
      if (s) {
        const { fileExtension } = (() => {
          const f = e.document.fileName.split('.').pop() ?? '';
          return { fileExtension: f };
        })();
        // P1 (QA-FILE-06): type-over partial accept must verify WHERE the user
        // typed. A bare `remaining.startsWith(typedText)` check records a
        // false PARTIAL_ACCEPT (and corrupts appliedLength) when the user
        // types a matching char elsewhere in the file. The position check
        // lives in the pure, unit-tested `typeOverText` (wordAccept.ts).
        const changes = e.contentChanges;
        let typedText = '';
        if (changes.length === 1) {
          const c = changes[0]!;
          typedText = typeOverText(
            s.insertPosition.line,
            s.insertPosition.character,
            s.fullText,
            s.appliedLength,
            {
              rangeLength: c.rangeLength,
              startLine: c.range.start.line,
              startCharacter: c.range.start.character,
              text: c.text,
            },
          );
        }
        // P2: if the user typed a prefix of the live suggestion, that's a
        // partial accept by typing — not a rejection. Advance the applied
        // offset and keep the session so the remainder stays tracked.
        const remaining = s.fullText.slice(s.appliedLength);
        let fate: TabFate = 'REJECT';
        let via = 'type_away';
        if (typedText.length > 0 && remaining.startsWith(typedText)) {
          fate = 'PARTIAL_ACCEPT';
          via = 'type_over';
          s.appliedLength += typedText.length;
        }
        if (provider.fate.record(s.requestId, fate, fileExtension)) {
          telemetry.recordSessionEvent(
            fate === 'PARTIAL_ACCEPT' ? 'acceptTabPartial' : 'rejectTab',
            { requestId: s.requestId, via },
          );
        }
        if (fate === 'REJECT') {
          cleared.increment();
          provider.session.clear();
        }
      }
      triggerDebounced(e.contentChanges.length > 0 && e.contentChanges.some((c) => c.text.includes('\n')) ? 'line_change' : 'typing');
    }),

    // Cursor moves → editor_change trigger.
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (e.selections.length === 0) return;
      if (provider.session.current) return; // don't refire over a visible suggestion
      triggerDebounced('editor_change');
    }),

    // Linter errors appearing → lint_errors trigger (refire kind).
    vscode.languages.onDidChangeDiagnostics((e) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      if (!e.uris.some((u) => u.toString() === editor.document.uri.toString())) return;
      triggerDebounced('lint_errors');
    }),

    vscode.window.onDidChangeActiveTextEditor(() => refreshStatusBar()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('ide.tab') || e.affectsConfiguration('ide.general')) {
        clientConfig = readClientConfig();
        applyDebounceConfig();
        refreshStatusBar();
        void refreshServerConfig();
      }
    }),
  );

  // ---- commands ----
  // P2 (QA-MODELPICKER): guard against duplicate command ids. VS Code's
  // CommandsRegistry is a Map keyed by id, so a second registration of the
  // same id silently SHADOWS the first (this is how the full-featured
  // ide.pickTabModel became dead code). Warn loudly instead of failing
  // silently — do not break activation over it.
  const registeredCommandIds = new Set<string>();
  const register = (id: string, fn: (...args: unknown[]) => unknown) => {
    if (registeredCommandIds.has(id)) {
      // eslint-disable-next-line no-console
      console.warn(`[ide-tab] duplicate command registration: "${id}" — the earlier handler is now shadowed`);
    }
    registeredCommandIds.add(id);
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  };

  register('ide.triggerTabSuggestion', () => triggerDebounced('manual_trigger'));
  register('ide.abortTabRequests', () => provider.abortAllRequests());
  register('ide.acceptTabSuggestionPartial', async () => {
    const editor = activeEditorOrWarn();
    if (!editor) return;
    const effect = await acceptPartialSuggestion(acceptDeps(editor));
    await applyNextActionEffect(effect);
    refreshStatusBar();
  });
  register('ide.peekTabSuggestion', async () => {
    const editor = activeEditorOrWarn();
    if (!editor) return;
    await peekSuggestion(acceptDeps(editor));
    refreshStatusBar();
  });
  register('ide.revertTabSuggestion', async () => {
    const editor = activeEditorOrWarn();
    if (!editor) return;
    await revertSuggestion(acceptDeps(editor));
    refreshStatusBar();
  });
  // Full accept is the stock commit; we record fate + next-action around it.
  register('ide.acceptTabSuggestionFull', async () => {
    const editor = activeEditorOrWarn();
    if (!editor) return;
    const effect = await acceptFullSuggestion(acceptDeps(editor));
    await applyNextActionEffect(effect);
    refreshStatusBar();
  });
  register('ide.toggleTabCompletion', async () => {
    await vscode.workspace.getConfiguration('ide.tab').update('enabled', !clientConfig.enabled, true);
  });
  register('ide.enableTabGlobally', async () => {
    await vscode.workspace.getConfiguration('ide.tab').update('enabled', true, true);
  });
  register('ide.disableTabGlobally', async () => {
    await vscode.workspace.getConfiguration('ide.tab').update('enabled', false, true);
  });
  register('ide.snoozeTabCompletion', async () => {
    const pick = await vscode.window.showQuickPick(
      SNOOZE_OPTIONS_MS.map((o) => ({ label: o.label, ms: o.ms })),
      { placeHolder: 'Snooze IDE Tab for…' },
    );
    if (pick) {
      snooze.snooze(pick.ms);
      refreshStatusBar();
    }
  });
  register('ide.unsnoozeTabCompletion', () => {
    snooze.unsnooze();
    refreshStatusBar();
  });
  // M-09: palette-discoverable Tab model picker (same picker as the status bar).
  // P1 (QA-MODELPICKER-01): there must be exactly ONE registration of this id —
  // CommandsRegistry is a Map keyed by id, so a second registration silently
  // shadows the first (the full-featured pickTabModel() with "Server default"
  // was dead code). The guard in `register` below warns loudly if this ever
  // regresses.
  register('ide.pickTabModel', () => pickTabModel());
  register('ide.toggleTabForLanguage', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const lang = editor.document.languageId;
    const state = context.globalState.get<Record<string, 'disabled' | 'enabled'>>(PER_LANG_KEY, {});
    state[lang] = state[lang] === 'disabled' ? 'enabled' : 'disabled';
    await context.globalState.update(PER_LANG_KEY, state);
    refreshStatusBar();
  });
  register('ide.tabStatusClicked', async () => {
    const editor = vscode.window.activeTextEditor;
    const lang = editor?.document.languageId ?? '';
    const items = [
      { label: clientConfig.enabled ? 'Disable IDE Tab globally' : 'Enable IDE Tab globally', action: 'toggleGlobal' },
      { label: `Toggle for language: ${lang || '(none)'}`, action: 'toggleLang' },
      { label: snooze.isSnoozed() ? 'Unsnooze now' : 'Snooze…', action: 'snooze' },
      { label: 'Pick model…', action: 'model' },
    ];
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'IDE Tab status' });
    if (!pick) return;
    switch (pick.action) {
      case 'toggleGlobal':
        await vscode.commands.executeCommand(clientConfig.enabled ? 'ide.disableTabGlobally' : 'ide.enableTabGlobally');
        break;
      case 'toggleLang':
        await vscode.commands.executeCommand('ide.toggleTabForLanguage');
        break;
      case 'snooze':
        await vscode.commands.executeCommand(snooze.isSnoozed() ? 'ide.unsnoozeTabCompletion' : 'ide.snoozeTabCompletion');
        break;
      case 'model':
        await vscode.commands.executeCommand('ide.pickTabModel');
        break;
    }
  });

  // Keep resolveNextAction referenced for future accept-path wiring audits.
  void resolveNextAction;

  refreshStatusBar();
  await refreshServerConfig();
}

export function deactivate(): void {
  // Disposables (provider timers, status bar) are in context.subscriptions.
}
