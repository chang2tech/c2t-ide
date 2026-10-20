/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: IDE Tab workbench contribution — rewritten from
// extensions/ide-agent/src/tab/extension.ts (the Tab entry point `activate()`).
// This is the workbench-core replacement for the extension activation:
//   vscode.languages.registerInlineCompletionItemProvider
//     → ILanguageFeaturesService.inlineCompletionsProvider.register(selector, provider)
//   vscode.commands.registerCommand ('ide.*') → CommandsRegistry.registerCommand
//   window.createStatusBarItem → IStatusbarService (TabStatusBar)
//   workspace.getConfiguration('ide.tab').get/update
//     → IConfigurationService.getValue('ide.tab') / updateValue('ide.tab.<key>')
//   workspace.onDidChangeConfiguration → IConfigurationService.onDidChangeConfiguration
//   executeCommand('setContext', k, v) → IContextKeyService (RawContextKey.bindTo)
//   window.showQuickPick / showInformationMessage
//     → IQuickInputService.pick / INotificationService
//   window.activeTextEditor / onDidChangeActiveTextEditor
//     → ICodeEditorService.getActiveCodeEditor() / IEditorService.onDidActiveEditorChange
//   workspace.onDidChangeTextDocument → ITextModel.onDidChangeContent (active editor)
//   window.onDidChangeTextEditorSelection → ICodeEditor.onDidChangeCursorSelection
//   languages.onDidChangeDiagnostics → IMarkerService.onMarkerChanged
//   executeCommand('editor.action.inlineSuggest.trigger' | '.commit')
//     → ICommandService (stock editor inline-suggest commands, unchanged)
//   Memento (globalState) → IStorageService (StorageScope.APPLICATION)
//   vscode.Uri.openTextDocument/showTextDocument → IEditorService.openEditor
//   extensions.getExtension('github.copilot') → IExtensionService.getExtension
//   context.globalStorageUri → IEnvironmentService.globalStorageHome
//
// (Cursor analog: the cppService client + status-bar element in the workbench
// inline-completions area.)

/**
 * Workbench entry point for the IDE Tab module.
 * Wires the TabCompletionProvider, accept commands, snooze, status bar and
 * triggers together as an `IWorkbenchContribution`.
 */

import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { extUri } from '../../../../../base/common/resources.js';
import Severity from '../../../../../base/common/severity.js';
import { Position } from '../../../../../editor/common/core/position.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { ICodeEditor } from '../../../../../editor/browser/editorBrowser.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { IModelContentChangedEvent } from '../../../../../editor/common/textModelEvents.js';
import { LanguageSelector } from '../../../../../editor/common/languageSelector.js';
import { ILanguageFeaturesService } from '../../../../../editor/common/services/languageFeatures.js';
import { IConfigurationService, ConfigurationTarget } from '../../../../../platform/configuration/common/configuration.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IStatusbarService } from '../../../../services/statusbar/browser/statusbar.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IContextKey, IContextKeyService, RawContextKey } from '../../../../../platform/contextkey/common/contextkey.js';
import { IQuickInputService, IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IMarkerService } from '../../../../../platform/markers/common/markers.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { IExtensionService } from '../../../../services/extensions/common/extensions.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { acceptFullSuggestion, acceptPartialSuggestion, peekSuggestion, revertSuggestion, AcceptDeps, TabAgentHooks } from './accept.js';
import { EngineTabBackend, TabBackend, TabModelInfo } from './backend.js';
import { NextActionEffect, FollowupRegistry } from './nextEdit.js';
import { TabCompletionProvider } from './provider.js';
import { typeOverText } from './wordAccept.js';
import { SnoozeManager, SnoozeStorage } from './snooze.js';
import { TabStatusBar } from './statusBar.js';
import { TabTelemetry } from './telemetry.js';
import { gateEditor } from './gates.js';
import {
	DEFAULT_CLIENT_CONFIG,
	SNOOZE_OPTIONS_MS,
	TabClientConfig,
	TabFate,
	TabServerConfig,
	TriggerKind,
} from './types.js';
import { DEFAULT_DEBOUNCE } from './debounce.js';

const PER_LANG_KEY = 'ide.tab.perLanguage';
const COPILOT_PROMPTED_KEY = 'ide.tab.copilotPrompted';

/**
 * GAPS-115 (tab-remap-accept): Cursor 3.25.9's remappable Tab-accept command
 * id — verbatim from workbench.desktop.main.js (dMe assignment @487120)
 * (`dMe="editor.action.acceptCursorTabSuggestion"`). The editor action itself
 * is registered in the editor layer (AcceptCursorTabSuggestion in
 * vs/editor/contrib/inlineCompletions); this contribution plays the role of
 * Cursor's cppService for it: it maintains the `cpp.shouldAcceptTab` context
 * key that is the action's precondition.
 */
const ACCEPT_CURSOR_TAB_SUGGESTION_ID = 'editor.action.acceptCursorTabSuggestion';

/** IStorageService adapter for the (storage-injected) SnoozeManager. */
class StorageSnoozeStorage implements SnoozeStorage {
	constructor(private readonly storageService: IStorageService) { }
	get(key: string): number | undefined {
		const raw = this.storageService.get(key, StorageScope.APPLICATION);
		if (raw === undefined) return undefined;
		const n = Number(raw);
		return Number.isFinite(n) ? n : undefined;
	}
	set(key: string, value: number | undefined): void {
		if (value === undefined) this.storageService.remove(key, StorageScope.APPLICATION);
		else this.storageService.store(key, String(value), StorageScope.APPLICATION, StorageTarget.USER);
	}
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
	return typeof v === 'number' && Number.isFinite(v)
		? Math.min(max, Math.max(min, Math.floor(v)))
		: fallback;
}

export class IdeTabContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.ideTab';

	private clientConfig: TabClientConfig;
	private readonly snooze: SnoozeManager;
	private readonly telemetry: TabTelemetry;
	private readonly backend: TabBackend;
	private readonly engineBackend: EngineTabBackend;
	private readonly provider: TabCompletionProvider;
	private readonly statusBar: TabStatusBar;
	private readonly followups = new FollowupRegistry<{ requestId: string; text: string }>();
	private readonly snoozedKey: IContextKey<boolean>;
	private readonly enabledKey: IContextKey<boolean>;
	/**
	 * GAPS-115: Cursor's `cpp.shouldAcceptTab` context key (verbatim name,
	 * binary @39846160: `Y5a="cpp.shouldAcceptTab"`), created with default
	 * false like Cursor's `createKey(Y5a, !1)`. Precondition of
	 * `editor.action.acceptCursorTabSuggestion`.
	 */
	private readonly shouldAcceptTabKey: IContextKey<boolean>;
	/**
	 * GAPS-115: Cursor cppService's `boundToTab` — true while the accept
	 * command's resolved keybinding is still Tab. Recomputed on every
	 * keybinding change via `lookupKeybinding(...).getDispatchChords()`.
	 */
	private boundToTab = true;
	private readonly editorListeners = this._register(new MutableDisposable());
	/**
	 * TAB-SNOOZE: 1s live tick for the `(X remaining)` countdown in the status
	 * bar hover — the core-native analog of Cursor's `_renderSnoozeButtons`
	 * `setInterval(..., 1e3)`. Armed only while snoozed; cleared on unsnooze,
	 * expiry and disposal.
	 */
	private snoozeTickTimer: ReturnType<typeof setInterval> | undefined;
	private ownEdit = false;
	/** TAB-BACKEND: resolver for the active chat tab's engine adapter (same sidecar). */
	private engineResolver: (() => unknown) | undefined;
	/** DEV-HOOKS: wired by the hooks workbench contrib once it exists. */
	private agentHooks: TabAgentHooks | undefined;

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IStorageService private readonly storageService: IStorageService,
		@ILanguageFeaturesService private readonly languageFeaturesService: ILanguageFeaturesService,
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@ICommandService private readonly commandService: ICommandService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@INotificationService private readonly notificationService: INotificationService,
		@ICodeEditorService private readonly codeEditorService: ICodeEditorService,
		@IEditorService private readonly editorService: IEditorService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IMarkerService private readonly markerService: IMarkerService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@IExtensionService private readonly extensionService: IExtensionService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
	) {
		super();

		this.clientConfig = this.readClientConfig();

		this.snoozedKey = new RawContextKey<boolean>('ideTab.snoozed', false).bindTo(this.contextKeyService);
		this.enabledKey = new RawContextKey<boolean>('ideTab.enabled', true).bindTo(this.contextKeyService);
		this.shouldAcceptTabKey = new RawContextKey<boolean>('cpp.shouldAcceptTab', false).bindTo(this.contextKeyService);

		this.snooze = new SnoozeManager(new StorageSnoozeStorage(this.storageService), () => {
			this.notificationService.info('IDE Tab unsnoozed.');
			this.refreshStatusBar();
		});
		this.snooze.maybeReenable();
		// Never leave the 1s snooze tick running past disposal.
		this._register(toDisposable(() => this.clearSnoozeTick()));

		this.telemetry = new TabTelemetry(() => this.clientConfig.telemetryEnabled, this.telemetryService);
		// Drop the in-memory fallback buffer on shutdown (the telemetry
		// pipeline itself needs no flushing).
		this._register(toDisposable(() => this.telemetry.dispose()));

		// Backend: the real engine. Resolves the active chat tab's adapter live on
		// every call — same sidecar process, dedicated tab session, never a second
		// engine. In stub engine mode there is no model backend: the provider stays
		// silent and the status bar shows "no model backend" (never fake text).
		this.backend = new EngineTabBackend(() => {
			try {
				return this.engineResolver?.();
			} catch {
				return undefined;
			}
		});
		this.engineBackend = this.backend as EngineTabBackend;

		// P2 (QA-FILE-06): chained follow-up suggestions keyed by display id
		// (Cursor: followupSuggestions.getAndEvictMatchingSuggestion). Populated by
		// onSuggestionShown below; consumed by applyNextActionEffect on accept.
		this.provider = new TabCompletionProvider(this.backend, this.telemetry, {
			getClientConfig: () => this.clientConfig,
			getPerLanguageState: () => this.readPerLanguageState(),
			isSnoozed: () => this.snooze.isSnoozed(),
			// TAB-BACKEND: no model backend (stub engine mode) → provider silent.
			isBackendAvailable: () => this.engineBackend.isEngineAvailable,
			getRelativePath: (uri) => this.asRelativePath(uri),
			onSuggestionShown: (requestId, text, displayId) => {
				this.telemetry.recordSessionEvent('tabShown', { requestId, length: text.length });
				if (displayId) this.followups.set(displayId, { requestId, text });
				// DD-SB-5 TODO: wire `tab.suggestion` line counting to the
				// aiCodeTracking workbench contrib once it is migrated.
			},
			onFirstSuggestion: () => { void this.maybePromptDisableCopilot(); },
		}, this.agentHooks);

		this.statusBar = new TabStatusBar(this.statusbarService);
		this._register(this.statusBar);
		this.statusBar.show();

		// Core replacement for
		// `vscode.languages.registerInlineCompletionItemProvider([{scheme:'file'},{scheme:'untitled'}], provider)`.
		const selector: LanguageSelector = [{ scheme: 'file' }, { scheme: 'untitled' }];
		this._register(this.languageFeaturesService.inlineCompletionsProvider.register(selector, this.provider));

		// GAPS-115: maintain `cpp.shouldAcceptTab` like Cursor's cppService
		// (binary @39856233 area): recompute `boundToTab` from the resolved
		// keybinding of `editor.action.acceptCursorTabSuggestion` whenever
		// keybindings change, and recompute the context key whenever the
		// suggestion session changes (Cursor: `this.suggestion.event(...)`).
		this._register(this.keybindingService.onDidUpdateKeybindings(() => {
			this.boundToTab = this.computeBoundToTab();
			this.updateShouldAcceptTabContextKey();
		}));
		this.boundToTab = this.computeBoundToTab();
		this._register(this.provider.session.onDidChange(() => this.updateShouldAcceptTabContextKey()));
		this.updateShouldAcceptTabContextKey();

		// ---- trigger wiring ----
		this._register(this.editorService.onDidActiveEditorChange(() => this.onActiveCodeEditorChanged()));
		this.onActiveCodeEditorChanged();

		// Linter errors appearing → lint_errors trigger (refire kind).
		this._register(this.markerService.onMarkerChanged((resources) => {
			const model = this.codeEditorService.getActiveCodeEditor()?.getModel();
			if (!model) return;
			if (!resources.some((u) => u.toString() === model.uri.toString())) return;
			this.triggerDebounced('lint_errors');
		}));

		this._register(this.configurationService.onDidChangeConfiguration((e) => {
			// TAB-BACKEND: ide.agent.engineMode decides whether a model backend
			// exists at all — refresh the status bar when it changes.
			if (e.affectsConfiguration('ide.tab') || e.affectsConfiguration('ide.general') || e.affectsConfiguration('ide.agent')) {
				this.clientConfig = this.readClientConfig();
				this.applyDebounceConfig();
				this.refreshStatusBar();
				void this.refreshServerConfig();
			}
		}));

		this.registerCommands();

		this.applyDebounceConfig();
		this.refreshStatusBar();
		void this.refreshServerConfig();
	}

	/**
	 * TAB-BACKEND: host wiring for the real engine backend. The chat/composer
	 * workbench contrib calls this with a resolver for the active tab's engine
	 * adapter (the SAME sidecar process Tab completions run against — Tab never
	 * spawns its own engine). Until wired, `isEngineAvailable` is false and the
	 * provider stays silent (never faked).
	 */
	setEngineResolver(resolver: (() => unknown) | undefined): void {
		this.engineResolver = resolver;
		this.refreshStatusBar();
	}

	/** DEV-HOOKS wiring point for the future hooks workbench contrib. */
	setAgentHooks(hooks: TabAgentHooks | undefined): void {
		this.agentHooks = hooks;
		this.provider.setAgentHooks(hooks);
	}

	// ------------------------------------------------------------------ config

	private readClientConfig(): TabClientConfig {
		const tab = this.configurationService.getValue<Record<string, unknown>>('ide.tab') ?? {};
		const general = this.configurationService.getValue<Record<string, unknown>>('ide.general') ?? {};
		const get = <T>(obj: Record<string, unknown>, key: string, fallback: T): T => {
			const v = obj[key];
			return v === undefined ? fallback : (v as T);
		};
		// SETTINGS-PARITY: privacy mode forces telemetry off (local-first).
		const privacyMode = get<boolean>(general, 'privacyMode', true);
		// SETTINGS-PARITY: the global ignore list applies to Tab like a
		// workspace-wide .cursorignore (Cursor parity).
		const globalIgnore = get<string[]>(general, 'globalCursorIgnoreList', []);
		const delayRaw = get<number>(tab, 'suggestionDelayMs', DEFAULT_CLIENT_CONFIG.suggestionDelayMs);
		return {
			enabled: get<boolean>(tab, 'enabled', DEFAULT_CLIENT_CONFIG.enabled),
			enablePartialAccepts: get<boolean>(tab, 'enablePartialAccepts', DEFAULT_CLIENT_CONFIG.enablePartialAccepts),
			disabledLanguages: get<string[]>(tab, 'disabledLanguages', []),
			ignorePatterns: [...get<string[]>(tab, 'ignorePatterns', []), ...globalIgnore],
			model: get<string>(tab, 'model', ''),
			maxConcurrentRequests: get<number>(tab, 'maxConcurrentRequests', DEFAULT_CLIENT_CONFIG.maxConcurrentRequests),
			telemetryEnabled: get<boolean>(tab, 'telemetryEnabled', true) && !privacyMode,
			promptDisableCopilot: get<boolean>(tab, 'promptDisableCopilot', true),
			suggestionDelayMs: clampInt(delayRaw, 0, 1000, DEFAULT_CLIENT_CONFIG.suggestionDelayMs),
			suggestionWhileCommenting: get<boolean>(
				tab,
				'suggestionWhileCommenting',
				DEFAULT_CLIENT_CONFIG.suggestionWhileCommenting,
			),
		};
	}

	private readPerLanguageState(): Record<string, 'disabled' | 'enabled' | undefined> {
		const raw = this.storageService.get(PER_LANG_KEY, StorageScope.APPLICATION);
		if (!raw) return {};
		try {
			const parsed = JSON.parse(raw) as Record<string, 'disabled' | 'enabled'>;
			return typeof parsed === 'object' && parsed !== null ? parsed : {};
		} catch {
			return {};
		}
	}

	private writePerLanguageState(state: Record<string, 'disabled' | 'enabled' | undefined>): void {
		this.storageService.store(PER_LANG_KEY, JSON.stringify(state), StorageScope.APPLICATION, StorageTarget.USER);
	}

	/** Core replacement for `vscode.workspace.asRelativePath`. */
	private asRelativePath(uri: URI): string {
		const folder = this.workspaceContextService.getWorkspaceFolder(uri);
		if (folder) {
			const rel = extUri.relativePath(folder.uri, uri);
			if (rel) return rel;
		}
		return uri.fsPath;
	}

	/**
	 * SETTINGS-PARITY: `ide.tab.suggestionDelayMs` — the client debounce comes
	 * from config; a server-provided value (refreshServerConfig) still wins
	 * because it patches afterwards.
	 */
	private applyDebounceConfig(): void {
		this.provider.debounce.setDurations({ clientMs: this.clientConfig.suggestionDelayMs });
	}

	// -------------------------------------------- tab-remap-accept (GAPS-115)

	/**
	 * Cursor cppService verbatim: `boundToTab` is true iff the first dispatch
	 * chord of the accept command's resolved keybinding is Tab
	 * (`pe?.[0]==="Tab"||pe?.[0]==="[Tab]"`, binary @39856233 area).
	 */
	private computeBoundToTab(): boolean {
		const chords = this.keybindingService.lookupKeybinding(ACCEPT_CURSOR_TAB_SUGGESTION_ID)?.getDispatchChords();
		return chords?.[0] === 'Tab' || chords?.[0] === '[Tab]';
	}

	/** Cursor's `hasMultipleLinesSelection()` guard (fork: any selection spanning >1 line). */
	private hasMultipleLinesSelection(editor: ICodeEditor): boolean {
		const selections = editor.getSelections();
		if (!selections) return false;
		return selections.some((s) => s.startLineNumber !== s.endLineNumber);
	}

	/**
	 * Port of Cursor's `updateShouldAcceptTabContextKey()` (binary @39944636)
	 * with the signals the fork has:
	 *   - not bound to Tab (user remapped the accept key) → true. The accept
	 *     action's own handler no-ops when there is no suggestion, exactly
	 *     like Cursor's handleTabAction.
	 *   - no focused/active code editor, or editor without a model → false.
	 *   - multi-line selection → false.
	 *   - otherwise → a Tab suggestion is live (`session.current` set).
	 * Cursor's extra branches (suggest-widget focus, find-widget cppInCmdF,
	 * import predictions, cursor-prediction portal, shouldTabInsteadOfAccepting)
	 * have no fork equivalents — the editor action's kbExpr
	 * (editorTextFocus + inlineSuggestionVisible/inlineEditVisible) covers
	 * the focus/visibility side in the fork's architecture.
	 * Divergence: Cursor also mirrors the key into every editor's scoped
	 * context (`setShouldAcceptTab`); the fork sets the global key only,
	 * following this file's existing ideTab.snoozed/ideTab.enabled precedent.
	 */
	private updateShouldAcceptTabContextKey(): void {
		if (!this.boundToTab) {
			this.shouldAcceptTabKey.set(true);
			return;
		}
		const editor = this.codeEditorService.getFocusedCodeEditor() ?? this.codeEditorService.getActiveCodeEditor();
		if (!editor || !editor.getModel()) {
			this.shouldAcceptTabKey.set(false);
			return;
		}
		if (this.hasMultipleLinesSelection(editor)) {
			this.shouldAcceptTabKey.set(false);
			return;
		}
		this.shouldAcceptTabKey.set(this.provider.session.current !== undefined);
	}

	// ------------------------------------------------------------- status bar

	private refreshStatusBar(): void {
		const model = this.codeEditorService.getActiveCodeEditor()?.getModel();
		const languageId = model?.getLanguageId() ?? '';
		let ignored = false;
		if (model) {
			const gate = gateEditor({
				charCount: model.getValueLength(),
				fsPath: model.uri.fsPath,
				relPath: this.asRelativePath(model.uri),
				languageId,
				disabledLanguages: this.clientConfig.disabledLanguages,
				perLanguageState: this.readPerLanguageState(),
				ignorePatterns: this.clientConfig.ignorePatterns,
			});
			ignored = !gate.allowed && gate.reason === 'ignored';
		}
		const perLang = this.readPerLanguageState();
		const snoozed = this.snooze.isSnoozed();
		this.statusBar.refresh({
			enabled: this.clientConfig.enabled,
			snoozed,
			ignored,
			languageId,
			languageDisabled: perLang[languageId] === 'disabled' || this.clientConfig.disabledLanguages.includes(languageId),
			modelName: this.clientConfig.model || 'default',
			snoozedUntil: this.snooze.snoozedUntil(),
			// TAB-BACKEND: honest "no model backend" state in stub engine mode.
			noBackend: !this.engineBackend.isEngineAvailable,
		});
		// TAB-SNOOZE: live-tick the `(X remaining)` countdown every 1s while
		// snoozed (binary `_renderSnoozeButtons`). Stops on unsnooze/expiry.
		if (snoozed && this.snoozeTickTimer === undefined) {
			this.snoozeTickTimer = setInterval(() => this.refreshStatusBar(), 1000);
		} else if (!snoozed && this.snoozeTickTimer !== undefined) {
			this.clearSnoozeTick();
		}
		this.snoozedKey.set(snoozed);
		this.enabledKey.set(this.clientConfig.enabled);
	}

	private clearSnoozeTick(): void {
		if (this.snoozeTickTimer !== undefined) {
			clearInterval(this.snoozeTickTimer);
			this.snoozeTickTimer = undefined;
		}
	}

	// ---------------------------------------------------------------- triggers

	private triggerDebounced(kind: TriggerKind): void {
		const model = this.codeEditorService.getActiveCodeEditor()?.getModel();
		if (!model) return;
		this.provider.debounce.schedule(`trigger:${model.uri.toString()}`, () => {
			this.provider.setPendingTrigger(kind);
			void this.commandService.executeCommand('editor.action.inlineSuggest.trigger');
		});
	}

	/** Re-attach per-editor listeners (model content + selection) to the active code editor. */
	private onActiveCodeEditorChanged(): void {
		this.editorListeners.clear();
		const editor = this.codeEditorService.getActiveCodeEditor();
		if (editor) {
			const store = new DisposableStore();
			const model = editor.getModel();
			if (model) {
				// Typing / edits → suggestion trigger (own accept edits are excluded).
				store.add(model.onDidChangeContent((e) => this.onDidChangeModelContent(editor, e)));
			}
			// Cursor moves → editor_change trigger.
			store.add(editor.onDidChangeCursorSelection(() => {
				if (this.provider.session.current) return; // don't refire over a visible suggestion
				this.triggerDebounced('editor_change');
			}));
			this.editorListeners.value = store;
		}
		this.refreshStatusBar();
		// GAPS-115: focus/editor switches change the should-accept inputs
		// (focused editor, its selection) — recompute `cpp.shouldAcceptTab`.
		this.updateShouldAcceptTabContextKey();
	}

	private onDidChangeModelContent(editor: ICodeEditor, e: IModelContentChangedEvent): void {
		if (this.ownEdit) return;
		const model = editor.getModel();
		if (!model) return;
		const s = this.provider.session.current;
		if (s && s.uri.toString() === model.uri.toString()) {
			const ext = model.uri.fsPath.split('.').pop() ?? '';
			// P1 (QA-FILE-06): type-over partial accept must verify WHERE the user
			// typed. A bare `remaining.startsWith(typedText)` check records a
			// false PARTIAL_ACCEPT (and corrupts appliedLength) when the user
			// types a matching char elsewhere in the file. The position check
			// lives in the pure, unit-tested `typeOverText` (wordAccept.ts);
			// core positions are 1-based, typeOverText takes 0-based.
			const changes = e.changes;
			let typedText = '';
			if (changes.length === 1) {
				const c = changes[0]!;
				typedText = typeOverText(
					s.insertPosition.lineNumber - 1,
					s.insertPosition.column - 1,
					s.fullText,
					s.appliedLength,
					{
						rangeLength: c.rangeLength,
						startLine: c.range.startLineNumber - 1,
						startCharacter: c.range.startColumn - 1,
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
				// DD-SB-5 TODO: type-over accept line counting (aiCodeTracking contrib).
			}
			if (this.provider.fate.record(s.requestId, fate, ext)) {
				this.telemetry.recordSessionEvent(
					fate === 'PARTIAL_ACCEPT' ? 'acceptTabPartial' : 'rejectTab',
					{ requestId: s.requestId, via },
				);
			}
			if (fate === 'REJECT') {
				this.provider.cleared.increment();
				this.provider.session.clear();
			}
		}
		this.triggerDebounced(
			e.changes.length > 0 && e.changes.some((c) => c.text.includes('\n')) ? 'line_change' : 'typing',
		);
	}

	// --------------------------------------------------------------- commands

	private async setGlobalEnabled(enabled: boolean): Promise<void> {
		await this.configurationService.updateValue('ide.tab.enabled', enabled, ConfigurationTarget.USER);
	}

	private async toggleLanguage(languageId: string): Promise<void> {
		if (!languageId) return;
		const state = this.readPerLanguageState();
		state[languageId] = state[languageId] === 'disabled' ? 'enabled' : 'disabled';
		this.writePerLanguageState(state);
		this.refreshStatusBar();
	}

	/**
	 * M-09: dedicated Tab model picker. Lists the backend's available models
	 * plus "Server default" (empty = server picks). Persists to ide.tab.model;
	 * the status bar refresh and request routing pick the new value up live.
	 */
	private async pickTabModel(): Promise<TabModelInfo | undefined> {
		const models = await this.backend.availableModels();
		const current = this.clientConfig.model;
		interface TabModelPickItem extends IQuickPickItem {
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
		const pick = await this.quickInputService.pick(items, { placeHolder: 'Select IDE Tab model' });
		if (pick) {
			await this.configurationService.updateValue('ide.tab.model', pick.modelId, ConfigurationTarget.USER);
			this.refreshStatusBar();
		}
		return pick ? models.find((m) => m.id === pick.modelId) : undefined;
	}

	private registerCommands(): void {
		// P2 (QA-MODELPICKER): guard against duplicate command ids. The
		// CommandsRegistry is keyed by id, so a second registration of the
		// same id silently SHADOWS the first (this is how the full-featured
		// pickTabModel once became dead code). Warn loudly instead of failing
		// silently — do not break activation over it.
		const registeredCommandIds = new Set<string>();
		const register = (id: string, handler: (...args: unknown[]) => unknown) => {
			if (registeredCommandIds.has(id)) {
				// eslint-disable-next-line no-console
				console.warn(`[ide-tab] duplicate command registration: "${id}" — the earlier handler is now shadowed`);
			}
			registeredCommandIds.add(id);
			this._register(CommandsRegistry.registerCommand(id, handler));
		};

		register('ide.triggerTabSuggestion', () => this.triggerDebounced('manual_trigger'));
		register('ide.abortTabRequests', () => this.provider.abortAllRequests());
		register('ide.acceptTabSuggestionPartial', async () => {
			const editor = this.activeCodeEditorOrWarn();
			if (!editor) return;
			const effect = await acceptPartialSuggestion(this.acceptDeps(editor));
			await this.applyNextActionEffect(effect);
			this.refreshStatusBar();
		});
		register('ide.peekTabSuggestion', async () => {
			const editor = this.activeCodeEditorOrWarn();
			if (!editor) return;
			await peekSuggestion(this.acceptDeps(editor));
			this.refreshStatusBar();
		});
		register('ide.revertTabSuggestion', async () => {
			const editor = this.activeCodeEditorOrWarn();
			if (!editor) return;
			await revertSuggestion(this.acceptDeps(editor));
			this.refreshStatusBar();
		});
		// Full accept is the stock commit; we record fate + next-action around it.
		// GAPS-115: this handler is the fork's `handleTabAction` equivalent —
		// the editor action `editor.action.acceptCursorTabSuggestion`
		// (AcceptCursorTabSuggestion, editor layer) delegates here. Do NOT
		// register that id in this CommandsRegistry too: the registry is a
		// Map keyed by id and a second registration would shadow the editor
		// action (title + default Tab keybinding weight 500 live with it).
		register('ide.acceptTabSuggestionFull', async () => {
			const editor = this.activeCodeEditorOrWarn();
			if (!editor) return;
			const effect = await acceptFullSuggestion(this.acceptDeps(editor));
			await this.applyNextActionEffect(effect);
			this.refreshStatusBar();
		});
		register('ide.toggleTabCompletion', () => this.setGlobalEnabled(!this.clientConfig.enabled));
		register('ide.enableTabGlobally', () => this.setGlobalEnabled(true));
		register('ide.disableTabGlobally', () => this.setGlobalEnabled(false));
		register('ide.snoozeTabCompletion', async () => {
			const pick = await this.quickInputService.pick(
				SNOOZE_OPTIONS_MS.map((o) => ({ label: o.label, ms: o.ms })),
				{ placeHolder: 'Snooze IDE Tab for…' },
			);
			if (pick) {
				this.snooze.snooze(pick.ms);
				this.refreshStatusBar();
			}
		});
		register('ide.unsnoozeTabCompletion', () => {
			this.snooze.unsnooze();
			this.refreshStatusBar();
		});
		// M-09: palette-discoverable Tab model picker (same picker as the status bar).
		// P1 (QA-MODELPICKER-01): there must be exactly ONE registration of this id.
		register('ide.pickTabModel', () => this.pickTabModel());
		register('ide.toggleTabForLanguage', () => {
			const languageId = this.codeEditorService.getActiveCodeEditor()?.getModel()?.getLanguageId() ?? '';
			return this.toggleLanguage(languageId);
		});
		register('ide.tabStatusClicked', async () => {
			const languageId = this.codeEditorService.getActiveCodeEditor()?.getModel()?.getLanguageId() ?? '';
			interface StatusPickItem extends IQuickPickItem {
				action: 'toggleGlobal' | 'toggleLang' | 'snooze' | 'model';
			}
			const items: StatusPickItem[] = [
				{ label: this.clientConfig.enabled ? 'Disable IDE Tab globally' : 'Enable IDE Tab globally', action: 'toggleGlobal' },
				{ label: `Toggle for language: ${languageId || '(none)'}`, action: 'toggleLang' },
				{ label: this.snooze.isSnoozed() ? 'Unsnooze now' : 'Snooze…', action: 'snooze' },
				{ label: 'Pick model…', action: 'model' },
			];
			const pick = await this.quickInputService.pick(items, { placeHolder: 'IDE Tab status' });
			if (!pick) return;
			switch (pick.action) {
				case 'toggleGlobal':
					await this.setGlobalEnabled(!this.clientConfig.enabled);
					break;
				case 'toggleLang':
					await this.toggleLanguage(languageId);
					break;
				case 'snooze':
					if (this.snooze.isSnoozed()) {
						this.snooze.unsnooze();
						this.refreshStatusBar();
					} else {
						await this.commandService.executeCommand('ide.snoozeTabCompletion');
					}
					break;
				case 'model':
					await this.commandService.executeCommand('ide.pickTabModel');
					break;
			}
		});
	}

	// ------------------------------------------------------------ accept path

	private acceptDeps(editor: ICodeEditor): AcceptDeps {
		return {
			session: this.provider.session,
			editor,
			fate: this.provider.fate,
			cleared: this.provider.cleared,
			telemetry: this.telemetry,
			setOwnEdit: (v: boolean) => { this.ownEdit = v; },
			agentHooks: this.agentHooks,
			// DD-SB-5 TODO: wire `tab.accept` line counting + attribution to the
			// aiCodeTracking workbench contrib once it is migrated.
			onAiAccept: undefined,
			commitInlineSuggestion: () => this.commandService.executeCommand('editor.action.inlineSuggest.commit'),
			asRelativePath: (uri) => this.asRelativePath(uri),
		};
	}

	/** Apply a next-edit effect after an accept. */
	private async applyNextActionEffect(effect: NextActionEffect): Promise<void> {
		switch (effect.kind) {
			case 'jump': {
				try {
					// NextActionEffect line/character are 0-based (backend contract);
					// core Position is 1-based.
					const position = new Position(effect.line + 1, effect.character + 1);
					await this.editorService.openEditor({
						resource: URI.parse(effect.uri),
						options: { selection: Range.fromPositions(position) },
					});
					this.telemetry.recordSessionEvent('acceptCursorPrediction', { uri: effect.uri, line: effect.line });
					if (effect.retrigger) {
						this.provider.setPendingTrigger('cursor_prediction');
						await this.commandService.executeCommand('editor.action.inlineSuggest.trigger');
					}
				} catch {
					// Jump target may not exist (yet) — never break the accept flow.
				}
				break;
			}
			case 'refire': {
				this.provider.setPendingTrigger('unknown');
				await this.commandService.executeCommand('editor.action.inlineSuggest.trigger');
				break;
			}
			case 'followup': {
				const chained = this.followups.getAndEvict(effect.displayId);
				if (chained) {
					this.telemetry.recordSessionEvent('followupShown', { displayId: effect.displayId });
					this.provider.setPendingTrigger('unknown');
					await this.commandService.executeCommand('editor.action.inlineSuggest.trigger');
				}
				break;
			}
			case 'none':
				break;
		}
	}

	private activeCodeEditorOrWarn(): ICodeEditor | undefined {
		const editor = this.codeEditorService.getActiveCodeEditor();
		if (!editor) this.notificationService.warn('IDE Tab: no active editor.');
		return editor ?? undefined;
	}

	private async maybePromptDisableCopilot(): Promise<void> {
		if (!this.clientConfig.promptDisableCopilot) return;
		if (this.storageService.getBoolean(COPILOT_PROMPTED_KEY, StorageScope.APPLICATION, false)) return;
		this.storageService.store(COPILOT_PROMPTED_KEY, true, StorageScope.APPLICATION, StorageTarget.USER);
		const copilot = await this.extensionService.getExtension('github.copilot');
		if (!copilot) return;
		this.notificationService.prompt(
			Severity.Info,
			'IDE Tab is active. Disable GitHub Copilot to avoid duplicate inline suggestions?',
			[
				{
					label: 'Disable Copilot',
					run: () => {
						// Copilot command surface varies; the prompt itself is the deliverable.
						void this.commandService.executeCommand('github.copilot.toggleCopilot').then(undefined, () => { });
					},
				},
				{ label: 'Keep both', run: () => { } },
			],
		);
	}

	// ---------------------------------------------------------- server config

	// P2 (QA-04): clamp every server value to a sane range — a misconfigured or
	// malicious server must not be able to freeze Tab (huge debounce) or
	// exhaust resources (huge concurrency).
	private clampTabNumber(v: number, min: number, max: number, fallback: number): number {
		if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
		return Math.min(max, Math.max(min, Math.floor(v)));
	}

	private async refreshServerConfig(): Promise<void> {
		try {
			const sc: Partial<TabServerConfig> = await this.backend.fetchServerConfig();
			const patch: Partial<{ clientMs: number; totalMs: number }> = {};
			if (typeof sc.clientDebounceDurationMillis === 'number') {
				patch.clientMs = this.clampTabNumber(sc.clientDebounceDurationMillis, 0, 1000, DEFAULT_DEBOUNCE.clientMs);
			}
			if (typeof sc.globalDebounceDurationMillis === 'number') {
				patch.totalMs = this.clampTabNumber(sc.globalDebounceDurationMillis, 0, 1000, DEFAULT_DEBOUNCE.totalMs);
			}
			if (Object.keys(patch).length > 0) this.provider.debounce.setDurations(patch);
			if (typeof sc.maxNumberOfClearedSuggestionsSinceLastAccept === 'number') {
				this.provider.cleared.setMax(this.clampTabNumber(sc.maxNumberOfClearedSuggestionsSinceLastAccept, 0, 1000, 5));
			}
			if (typeof sc.maxConcurrentRequests === 'number') {
				this.clientConfig = {
					...this.clientConfig,
					maxConcurrentRequests: this.clampTabNumber(
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
}
