/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Contribution entry point for the Composer (AI chat) workbench contrib.
//
// Core port of the ide-agent extension `activate()` (CAT-C + CAT-D):
//   extension.ts `activate()`                          -> this file
//   vscode.commands.registerCommand (~102 commands)    -> composerActions.ts (registerAction2)
//   package.json contributes.keybindings (46)          -> composerActions.ts (KeybindingsRegistry)
//   package.json contributes.menus (4)                 -> composerActions.ts (MenuRegistry)
//   window.registerTreeDataProvider("ideAgent.sessionsView")
//                                                      -> composerSessionsView.ts (ViewsRegistry ITreeViewDescriptor)
//   window.registerWebviewViewProvider("ideAgent.chatView")
//                                                      -> composerView.ts (registered below; hosts getComposerChatHtml()
//                                                         in a core webview element, same HTML as the chat editor pane)
//   window.registerCustomEditorProvider("ideAgent.chatEditor")
//                                                      -> composerEditorInput.ts + composerEditor.ts (EditorInput/Pane)
//   window.registerCustomEditorProvider("ideAgent.customizeEditor")
//                                                      -> composerCustomizeEditor.ts (EditorInput/Pane)
//   chat.createChatParticipant("ide.agent")            -> REMOVED 2026-10-19 (QA-MIGRATION-VERIFY P1 wrong-layer):
//       the workbench-core port (composerChatAgent.ts) was a not-wired stub
//       built on stock IChatAgentService from contrib/chat, which Cursor
//       deleted outright (0 refs in 3.25.9 bundle — see docs/rea/
//       cursor-agent-layers-2026-10-19.md §2). The extension keeps its own
//       `vscode.chat.createChatParticipant("ide.agent")` until stock chat is
//       removed from the fork; the Composer sidebar view is the core surface.
//   window.createStatusBarItem x5 (tab, model, aiCodeTracking x3)
//                                                      -> composerStatusBar.ts (IStatusbarService.addEntry)
//   languages.registerInlineCompletionItemProvider     -> composerInlineCompletions.ts

import { localize, localize2 } from '../../../../nls.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ViewContainer, IViewContainersRegistry, ViewContainerLocation, Extensions as ViewContainerExtensions, IViewsRegistry, WindowEnablement } from '../../../common/views.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { EditorExtensions, IEditorFactoryRegistry } from '../../../common/editor.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { IWorkbenchContribution, IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions, getWorkbenchContribution } from '../../../common/contributions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IOutputService } from '../../../services/output/common/output.js';
import { IComposerOutputChannel, IdeCodeEngineOptions, IIdeCodeEngineAdapter, IIdeCodeEngineAdapterFactory } from '../common/ideCodeEngineAdapter.js';
import { defaultEnginePath } from '../common/composerDataService.js';
// IDE-CODE: side-effect import — registers all `ide.*` configuration sections
// (7 sections, 40 properties) into the ConfigurationRegistry. Without this,
// `common/composerConfiguration.ts` is never loaded and every `config.ide.*`
// read returns undefined.
import '../common/composerConfiguration.js';
import { IdeTabContribution } from '../../inlineCompletions/browser/ideTab/tabContribution.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { IComposerService, ComposerService } from '../common/composerService.js';
import { IInlineEditPromptBar } from '../common/inlineEditPromptBar.js';
import { InlineEditPromptBarService } from './inlineEditPromptBar.js';
import { IInlineEditChatBridge } from '../common/inlineEditChatBridge.js';
import { InlineEditChatBridge } from './inlineEditChatBridge.js';
import { ComposerView } from './composerView.js';
import { registerComposerActions, registerComposerKeybindings, registerComposerMenus } from './composerActions.js';
// GAPS-139: side-effect import — registers the EditorActions
// `editor.action.undoLexical` / `editor.action.redoLexical` via
// registerEditorAction (the binary's `vo(kBb)` / `vo(wBb)`), NOT
// registerAction2: these are editor-layer actions in Cursor.
import './promptBarLexicalActions.js';
import { registerCreateRuleAction } from './createRuleActions.js';
// DEV-GAPS-109 (cursor-commands): Cursor's File-category creation commands
// `workbench.action.newProjectCursorCommand` /
// `workbench.action.newUserCursorCommand` (binary-verbatim ids/titles,
// helper IMm @34619208 in workbench.desktop.main.js).
import { registerNewCursorCommandActions } from './newCursorCommandActions.js';
// DEV-GAPS-117 (report-issue-feedback): Cursor's `aiFeedback.action.open`
// ("Report Issue", binary glass @1138493/@43205691; see feedbackActions.ts).
import { registerFeedbackActions } from './feedbackActions.js';
import { registerComposerSessionsView } from './composerSessionsView.js';
import { ComposerChatEditorInput, ComposerChatEditorSerializer, COMPOSER_CHAT_EDITOR_SCHEME } from './composerEditorInput.js';
import { ComposerChatEditorPane } from './composerEditor.js';
import { ComposerCustomizeEditorInput, ComposerCustomizeEditorSerializer, COMPOSER_CUSTOMIZE_SCHEME, COMPOSER_CUSTOMIZE_SECTIONS, COMPOSER_CUSTOMIZE_DEFAULT_SECTION } from './composerCustomizeEditor.js';
import { ComposerCustomizeEditorPane } from './composerCustomizeEditor.js';
import { ComposerStatusBar } from './composerStatusBar.js';
import { startComposerContextKeyBridge } from './composerContextKeysBridge.js';
// DEV-GAPS-9B: backend server switcher (`cursor.selectBackend`) + Changes tab
// (`glass.openChangesTab`).
import { ComposerBackendStatusBar, registerBackendSwitcherAction } from './composerBackendSwitcher.js';
// DEV-GAPS-47: `cursor.connectSlack` ("Connect Slack", hidden from palette)
// + `cursor.removevim` ("Cursor Vim: Remove Vim Mode").
import { registerSlackIntegrationActions } from './composerSlackIntegration.js';
import { registerVimModeActions } from './composerVimMode.js';
import { registerChangesTabActions, registerChangesReviewContentProvider, COMPOSER_CHANGES_EDITOR_SCHEME, ComposerChangesEditorInput, ComposerReviewChangesEditorInput } from './composerChangesTab.js';
import { IEditorResolverService, RegisteredEditorPriority } from '../../../services/editor/common/editorResolverService.js';
import { parseComposerChatTabRef, parseComposerChangesTabRef, parseComposerCustomizeTabRef } from '../common/tabCloseRestore.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { ComposerContextKeys } from '../common/composerContextKeys.js';
import { ComposerInlineCompletionsProvider, registerComposerInlineCompletions } from './composerInlineCompletions.js';
// DEV-GAPS-9C: terminal Cmd+K family (`cursorai.action.*` verbatim —
// audit-fix-queue.md run 19:07, terminal-ai-cmdk).
import { ITerminalGeneratePromptBar, TerminalGeneratePromptBar, registerTerminalCmdkActions } from './terminalCmdkActions.js';
// WORKER-GAPS-54C: composer voice dictation parity (agent-voice-dictation) —
// `voiceInputService` DI singleton + `composer.toggleVoiceDictation` /
// `composer.cancelVoiceDictation` actions (Cursor 3.25.9 binary-verbatim).
import { IVoiceInputService, VoiceInputService } from './voice/voiceInputService.js';
import { IVoiceInputTranscriptionBackend, NullVoiceInputTranscriptionBackend } from './voice/voiceInputService.js';
import { registerVoiceDictationActions } from './voiceDictationActions.js';
// P1 (composer-plan-accept): Cursor's separate plan service
// ("composerPlanService", binary 3.25.9 @18677949) — owns plan-URI resolution
// and plan acceptance for `composer.acceptPlan` (@29969972). Distinct from the
// composer data service by design, mirroring the binary's layering.
import { IComposerPlanService } from '../common/composerPlanService.js';
import { ComposerPlanService } from './composerPlanService.js';
// DEV-GAPS-83 (agent-fix-with-agent-error): Cursor's AI fix code-action
// contribution (binary id `workbench.contrib.aiFixCodeActions`).
import { AiFixCodeActionsContribution } from './aiFixCodeActions.js';
// DEV-GAPS-83 (settings-window-layout): applies the verbatim Cursor
// Window Layout presets when `ide.window.defaultLayout` changes.
import { WindowLayoutContribution } from './windowLayoutActions.js';
// DEV-GAPS-103 (settings-autohide-editor): hides the editor area and
// maximizes chat when all editors are closed (Cursor storage preference
// `cursor/autoHideEditorWhenEmpty`, fork config
// `ide.window.autoHideEditorWhenEmpty`).
import { AutoHideEditorContribution } from './autoHideEditorActions.js';
// GAPS-148 (onboarding-flow): Cursor's onboarding service (DI token
// "onboardingService" verbatim, binary class A5a) + the
// `cursor.startOnboarding` Action2 + the on-start contribution
// `workbench.contrib.onboarding.onStart.cursor`. See
// browser/onboardingService.ts / browser/onboardingActions.ts and
// common/onboardingFlow.ts for the binary evidence.
import { IOnboardingService, OnboardingService, OnboardingOnStartContribution } from './onboardingService.js';
import { registerOnboardingActions } from './onboardingActions.js';
// GAPS-170 (entry #32 `inline-edit-onboarding-popups`): Cursor's
// tooltipService (DI token "tooltipService" verbatim, binary class fwi) +
// the popup UI actions/editor contribution (`cursor.showTooltipActionId`,
// `tooltip.close.register`, `workbench.action.terminal.addTooltip`,
// `editor.contrib.tooltipUiController` — importing tooltipUi registers
// the editor contribution) + the terminal event producers / bridge
// command. See browser/tooltipService.ts, browser/tooltipUi.ts,
// browser/tooltipActions.ts and common/tooltipPipelines.ts.
import { ITooltipService, TooltipService } from './tooltipService.js';
import { registerTooltipActions } from './tooltipUi.js';
import { registerTooltipBridgeActions, TooltipEventProducerContribution } from './tooltipActions.js';
import { IFileEditorFindStateService, FileEditorFindStateService } from './fileEditorFindStateService.js';
import { registerFileEditorFindActions } from './fileEditorFindActions.js';
import { AgentNotificationBridgeContribution } from './agentNotificationActions.js';
import { ComposerPlanAcceptConsumerContribution } from './composerPlanBridge.js';

// Register Service
registerSingleton(IComposerService, ComposerService, InstantiationType.Delayed);
registerSingleton(IComposerPlanService, ComposerPlanService, InstantiationType.Delayed);

// IDE-CODE: the Cmd+K prompt bar (native Monaco view zone, PromptBarViewZone).
// Browser-layer service backing the IInlineEditPromptBar contract; the common
// InlineEditService drives it for the prompt step of the inline-edit flow.
registerSingleton(IInlineEditPromptBar, InlineEditPromptBarService, InstantiationType.Delayed);

// F2-A (2026-10-20): chat-surface bridge for the core inline-edit flow.
// `IInlineEditService.escalateToAgent()` ("Send to Chat") submits the prepared
// prompt through the extension-owned composer via `ide.submitInlinePromptToChat`.
registerSingleton(IInlineEditChatBridge, InlineEditChatBridge, InstantiationType.Delayed);

// DEV-GAPS-9C: workbench-scoped state for the terminal Cmd+K prompt bar
// (owns the `promptBarVisible` / `promptBarCanCancelGeneration` /
// `promptBarCanRejectGeneration` context keys + the generation state machine).
registerSingleton(ITerminalGeneratePromptBar, TerminalGeneratePromptBar, InstantiationType.Delayed);

// WORKER-GAPS-54C: composer voice dictation (`voiceInputService`, DI name
// verbatim from the binary). Delayed — constructed on first resolution.
registerSingleton(IVoiceInputService, VoiceInputService, InstantiationType.Delayed);

// WORKER-GAPS-54C: null STT backend (isAvailable=false). A real backend
// overrides this registration. The fork's DI has no `optional`, so the seam
// is a capability flag rather than an absent service.
registerSingleton(IVoiceInputTranscriptionBackend, NullVoiceInputTranscriptionBackend, InstantiationType.Delayed);

// GAPS-148 (onboarding-flow): the onboarding service — binary registration
// is `un(R_a, A5a, 1)` (registerSingleton Delayed) with
// `R_a=vn("onboardingService")` (fork decorator id
// 'cursorOnboardingService' — see divergence D9 in onboardingService.ts).
registerSingleton(IOnboardingService, OnboardingService, InstantiationType.Delayed);

// GAPS-170 (entry #32): the tooltip service — binary registration is
// `un(EY, fwi, 1)` (registerSingleton Delayed) with
// `EY=vn("tooltipService")`; the fork's decorator id is the verbatim
// 'tooltipService' (no collision in this tree — checked in the work notes).
registerSingleton(ITooltipService, TooltipService, InstantiationType.Delayed);

// GAPS-158 (`editor-find-in-file`): the per-agent shared find-state service
// — binary registration is `Cn(FZb, Blu, 1)` (registerSingleton Delayed)
// with FZb=Qn("glassFileEditorFindStateService") @45459332.
registerSingleton(IFileEditorFindStateService, FileEditorFindStateService, InstantiationType.Delayed);

// Register view container
export const COMPOSER_VIEW_CONTAINER_ID = 'composer';
const composerViewIcon = registerIcon('composer-view-icon', Codicon.sparkle, localize('composerViewIcon', 'View icon of the Composer view.'));

export const COMPOSER_VIEW_CONTAINER: ViewContainer = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry).registerViewContainer({
	id: COMPOSER_VIEW_CONTAINER_ID,
	title: localize2('composer', "Composer"),
	icon: composerViewIcon,
	order: 5,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [COMPOSER_VIEW_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: COMPOSER_VIEW_CONTAINER_ID,
	hideIfEmpty: true,
	windowEnablement: WindowEnablement.Both
}, ViewContainerLocation.Sidebar);

// Register the chat view inside the container.
// NOTE (P1 migration-keybinding-shadow, 2026-10-19): the view open command
// deliberately has NO keybinding. Cursor 3.25.9 binds Ctrl/Cmd+Shift+I to
// `workbench.action.toggleDevTools` (binary: workbench.glass.main.js,
// `keybinding:{weight:250,primary:dt.CtrlCmd|dt.Shift|Xe.KeyI,
// mac:{primary:dt.CtrlCmd|dt.Alt|Xe.KeyI}}`; mac Ctrl+Alt+I) and ships NO
// "Toggle AI Pane" keybinding at all (0 hits in the binary). The previous
// chord here (CtrlCmd+Shift+I) never fired: KeybindingResolver._findCommand
// iterates matches from the end with no weight consideration, and
// _addKeyPress evicts the earlier when-less rule when the later one entirely
// includes it — `workbench.action.toggleDevTools` (registered later, same
// weight, also when-less) always won. Revealing chat is covered by Ctrl+I
// "Focus Chat Input" (composerActions.ts), which is Cursor's chord (@45366917).
Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry).registerViews([{
	id: ComposerView.ID,
	name: localize2('composerChat', "Agent Chat"),
	containerIcon: composerViewIcon,
	canMoveView: true,
	canToggleVisibility: true,
	ctorDescriptor: new SyncDescriptor(ComposerView),
	openCommandActionDescriptor: {
		id: 'composer.chat.open',
		mnemonicTitle: localize({ key: 'miComposerChatOpen', comment: ['&& denotes a mnemonic'] }, "Composer: Focus &&Chat"),
	}
}], COMPOSER_VIEW_CONTAINER);

// ---- CAT-D: commands -> registerAction2 (see composerActions.ts) --------------
registerComposerActions();
registerComposerKeybindings();
registerComposerMenus();
// W71B (DEV-GAPS-71): fork-side plan-producer bridge commands
// (`ide.recordComposerPlan` / `ide.clearComposerPlan`) — the extension's live
// plan producer forwards plans into the core `IComposerPlanService` registry
// through these; imported for the side effect (raw registerCommand).
import './composerPlanBridge.js';
// DEV-GAPS-74: Cursor's 'Create Rule' editor-context command
// (cursor.createRuleFromSelection, see createRuleActions.ts).
registerCreateRuleAction();
// DEV-GAPS-109: Cursor's 'New Project Cursor Command' /
// 'New User Cursor Command' File actions (see newCursorCommandActions.ts).
registerNewCursorCommandActions();
// DEV-GAPS-117: Cursor's 'Report Issue' feedback action
// (`aiFeedback.action.open`, see feedbackActions.ts).
registerFeedbackActions();
// GAPS-148 (onboarding-flow): Cursor's 'Start Onboarding' action
// (`cursor.startOnboarding`, see onboardingActions.ts).
registerOnboardingActions();
// GAPS-170 (entry #32): the tooltip popup actions
// (`cursor.showTooltipActionId`, `tooltip.close.register`,
// `workbench.action.terminal.addTooltip`) + the fork-local event bridge
// (`composer.tooltip.registerEvent`, see tooltipActions.ts).
registerTooltipActions();
registerTooltipBridgeActions();
// GAPS-158 (`editor-find-in-file`): Cursor's pane-level `showFileEditorFind`
// routing command (weight 256, CtrlCmd+F) seeding the stock editor find
// from IFileEditorFindStateService (see fileEditorFindActions.ts).
registerFileEditorFindActions();
// DEV-GAPS-9C: verbatim Cursor terminal Cmd+K family (see terminalCmdkActions.ts).
registerTerminalCmdkActions();

// WORKER-GAPS-54C: verbatim Cursor composer voice dictation commands
// (`composer.toggleVoiceDictation` / `composer.cancelVoiceDictation`).
registerVoiceDictationActions();

// ---- DEV-GAPS-9B: backend server switcher + Changes tab ----------------------
// `cursor.selectBackend` ("Select Backend Server") and `glass.openChangesTab`
// (new-tab-model action {id:"changes", ...}), both native Action2 commands.
registerBackendSwitcherAction();
registerChangesTabActions();

// ---- DEV-GAPS-47: integrations + vim mode -------------------------------
// `cursor.connectSlack` ("Connect Slack", not in palette — verbatim) and
// `cursor.removevim` ("Cursor Vim: Remove Vim Mode", palette — verbatim).
registerSlackIntegrationActions();
registerVimModeActions();

// ---- CAT-C: chat editor tabs -> EditorInput + EditorPane ------------------------
// Old: window.registerCustomEditorProvider("ideAgent.chatEditor", ...) with
// document URIs `ide-chat:/<tabId>`. New: native editor registration.
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(ComposerChatEditorPane, ComposerChatEditorPane.ID, localize('composerChatEditor', "Composer Chat")),
	[new SyncDescriptor(ComposerChatEditorInput)]
);
Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(
	ComposerChatEditorInput.ID,
	ComposerChatEditorSerializer
);

// ---- CAT-C: customize editor tab -> EditorInput + EditorPane -------------------
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(ComposerCustomizeEditorPane, ComposerCustomizeEditorPane.ID, localize('composerCustomizeEditor', "Customize")),
	[new SyncDescriptor(ComposerCustomizeEditorInput)]
);
Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(
	ComposerCustomizeEditorInput.ID,
	ComposerCustomizeEditorSerializer
);

/**
 * Workbench contribution for the registrations that need instantiated services:
 * the sessions tree view, the status bar entries, and the inline-completion
 * provider.
 */
class ComposerWorkbenchContribution extends Disposable implements IWorkbenchContribution {

	/**
	 * TAB-BACKEND: the single shared engine adapter Tab completions run
	 * against. Lazily created on the first sidecar-mode resolve — constructing
	 * it spawns nothing (the sidecar starts on first use via ensureServer),
	 * and stub engine mode never creates it at all.
	 *
	 * Same-sidecar note: no per-chat-tab composer instance exists in the
	 * workbench yet (ComposerDataService/ChatTabService are migrated but not
	 * wired), so this one adapter IS the sidecar Tab uses — Tab never
	 * constructs (and therefore never spawns) its own engine. When the
	 * per-tab chat machinery lands, resolveTabEngineAdapter() should return
	 * the active tab's adapter instead; the setEngineResolver seam already
	 * supports swapping the source without touching the Tab contrib.
	 */
	private tabEngineAdapter: IIdeCodeEngineAdapter | undefined;

	constructor(
		// NOTE (F2-A cleanup): plain parameter, not a property — the service
		// is only used inside the constructor body (parameter properties
		// unused via `this.` trip TS6138 under noUnusedLocals).
		@IInstantiationService instantiationService: IInstantiationService,
		@ILanguageFeaturesService languageFeaturesService: ILanguageFeaturesService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IEditorService private readonly editorService: IEditorService,
		@IEditorResolverService private readonly editorResolverService: IEditorResolverService,
		@IOutputService private readonly outputService: IOutputService,
		@IIdeCodeEngineAdapterFactory private readonly engineAdapterFactory: IIdeCodeEngineAdapterFactory,
		@ITextModelService textModelService: ITextModelService,
		@IModelService modelService: IModelService,
	) {
		super();

		// WORKER-GAPS-66D (`tab-close-restore`): editor-resolver entries so the
		// untyped records produced by the composer inputs' `toUntyped()` can be
		// resolved back into real inputs when HistoryService reopens a closed
		// chat/app tab (Cmd+Shift+T) — the "override" path of
		// `reopenLastClosedEditor()`. Same layering as the cursorBlame contrib.
		this.registerTabCloseRestoreResolvers(instantiationService);

		// DEV-GAPS-10: Review Changes "before"-snapshot text-model provider
		// (`composer-changes-review:`) — backs the per-file diff editors'
		// "original" side with the genuine CheckpointService pre-edit
		// snapshots. Registered once here (needs instantiated services).
		this._register(registerChangesReviewContentProvider(textModelService, modelService));

		// CAT-D: registerTreeDataProvider("ideAgent.sessionsView") -> tree view `composer.sessions`.
		registerComposerSessionsView(COMPOSER_VIEW_CONTAINER, instantiationService);

		// CAT-D: window.createStatusBarItem x5 -> IStatusbarService.addEntry.
		this._register(instantiationService.createInstance(ComposerStatusBar));

		// DEV-GAPS-9B: backend server status bar entry (`Server: ${name}`,
		// click -> `cursor.selectBackend`).
		this._register(instantiationService.createInstance(ComposerBackendStatusBar));

		// DEV-GAPS-9B: sync `composer.changesTabEnabled` from the
		// `composer.changesTab.enabled` setting (Cursor `showChangesAction`
		// gate analog).
		this.syncChangesTabEnabled();

		// DEV-GAPS-18-W4 (`agent-worktree-chat-actions`): keep the
		// `composer.chatHasWorktree` context key in sync with the active chat
		// tab's `worktreePath` — the fork analog of Cursor's
		// `gitWorktree.worktreePath` gate for the worktree overflow items.
		this.syncChatHasWorktreeKey();

		// WORKER-GAPS-66A (`chat-tab-title-menu-inventory`): keep the verbatim
		// Cursor 3.25.9 title-menu context keys in sync —
		// `composerEditorTabCanRename` (VXi, precondition of the Rename Chat
		// title-menu item) follows the active editor: true when it is a
		// ComposerChatEditorInput (the fork has no core composer data service
		// to derive Cursor's `isCloudAgent || hasConversationHeaders` rule, so
		// "active editor is a loaded chat tab" is the fork analog — see
		// common/chatTitleMenu.ts HONEST-DIVERGENCES);
		// `composerEditorTabIsCloudAgent` (jXi, negated gate of Fork Chat)
		// stays false — the fork has no cloud-agent chats;
		// `isSharedChatsEnabled` (MQt, gate + precondition of Share
		// Transcript) stays false until a share backend flips it (the
		// extension flips it via setContext, same writer pattern as
		// `glassEditorPanelFullscreen`).
		this.syncChatTitleMenuContextKeys();

		// WORKER-GAPS-17E (fullscreen-composer-minors): bind the VERBATIM
		// Cursor 3.25.9 `glassEditorPanelFullscreenAvailable` capability key
		// (binary workbench.glass.main.js:
		// `YDi=new pn("glassEditorPanelFullscreenAvailable",!1)`, required by
		// the `glass.enterEditorPanelFullscreen` when clause
		// `Wlu=ft.and(YDi,VXt.negate())`). Cursor derives it from
		// `_isEditorPanelFullscreenAvailable()` (= `!this._settingsActive`)
		// via `setContext(YDi.key, ...)`; this fork has no settings-overlay
		// state for the composer panel, so it is unconditionally true here
		// (same as Cursor whenever settings are not open). The fullscreen
		// commands are registered unconditionally.
		const fullscreenAvailableKey = ComposerContextKeys.glassEditorPanelFullscreenAvailable.bindTo(this.contextKeyService);
		fullscreenAvailableKey.set(true);
		this._register(toDisposable(() => fullscreenAvailableKey.reset()));

		// WORKER-GAPS-20C (fullscreen-composer-minors redo): bind the VERBATIM
		// Cursor 3.25.9 `glassEditorPanelVisible` key (binary `u7`, required by
		// the `glass.exitEditorPanelFullscreen` when clause
		// `Glu=ft.and(u7,VXt)`). A fullscreen (maximized) editor group is
		// visible by construction, so the conjunct is behaviorally implied;
		// binding it keeps the when-clause structure verbatim. The commands
		// are registered unconditionally.
		const editorPanelVisibleKey = ComposerContextKeys.glassEditorPanelVisible.bindTo(this.contextKeyService);
		editorPanelVisibleKey.set(true);
		this._register(toDisposable(() => editorPanelVisibleKey.reset()));

		// DEV-GAPS-66/W66A (`agent-accept-pending-decisions`): bind the
		// VERBATIM Cursor 3.25.9 `composerSubmitOnCmdEnterEnabled` key
		// (binary workbench.glass.main.js:
		// `Jis=new pn("composerSubmitOnCmdEnterEnabled",!1)` @17969880).
		// Cursor derives it from the `chatSubmitOnCmdEnter` storage key
		// (`_bindComposerSubmitOnCmdEnterKey`, default false when unset);
		// the fork has no such setting, so this stays at the binary
		// default (false): the `composer.acceptComposerStep` plain
		// Cmd/Ctrl+Enter binding is live, the Cmd/Ctrl+Alt+Enter one dormant
		// until the setting exists.
		const submitOnCmdEnterEnabledKey = ComposerContextKeys.submitOnCmdEnterEnabled.bindTo(this.contextKeyService);
		submitOnCmdEnterEnabledKey.set(false);
		this._register(toDisposable(() => submitOnCmdEnterEnabledKey.reset()));

		// P1 migration-dead-context-keys: derive the core-owned `composer.*`
		// context keys from the extension's legacy `ideAgent.*` signals
		// (see composerContextKeysBridge.ts).
		this._register(startComposerContextKeyBridge(this.contextKeyService));

		// CAT-D: languages.registerInlineCompletionItemProvider -> LanguageFeaturesService.
		const inlineCompletionsProvider = instantiationService.createInstance(ComposerInlineCompletionsProvider);
		this._register(inlineCompletionsProvider);
		this._register(registerComposerInlineCompletions(languageFeaturesService, inlineCompletionsProvider));

		// TAB-BACKEND: wire the Tab completion backend to the engine (the
		// chat/composer side of the IdeTabContribution.setEngineResolver
		// contract). The adapter is disposed with this contribution.
		this.wireTabEngineBackend();
		this._register(toDisposable(() => this.tabEngineAdapter?.dispose()));
	}

	/**
	 * TAB-BACKEND: resolves the engine adapter Tab completions run against,
	 * live on every call (EngineTabBackend invokes the resolver per request,
	 * so a runtime `ide.agent.engineMode` switch is honored without reload).
	 * Returns undefined in stub engine mode — the stub adapter has no
	 * `completeCode`, so there is no model backend and the Tab provider stays
	 * honestly silent (never faked).
	 */
	private resolveTabEngineAdapter(): unknown {
		const mode = this.configurationService.getValue<string>('ide.agent.engineMode') ?? 'sidecar';
		if (mode !== 'sidecar') {
			return undefined;
		}
		if (!this.tabEngineAdapter) {
			// Layer split (P0 node-free common/): the adapter implementation
			// lives in electron-browser/ (node:child_process); this browser/
			// contribution creates it through the DI factory seam so the web
			// bundle never imports node builtins. Same options as before.
			this.tabEngineAdapter = this.engineAdapterFactory.create(
				this.createTabEngineOptions(),
			);
		}
		return this.tabEngineAdapter;
	}

	private createTabEngineOptions(): IdeCodeEngineOptions {
		// Same output-channel adaptation as the per-tab composer
		// (composerDataService): the shared 'ide-agent' channel, or a console
		// fallback when the channel is not registered.
		const coreChannel = this.outputService.getChannel('ide-agent');
		const output: IComposerOutputChannel = coreChannel
			? {
				append: (value: string) => coreChannel.append(value),
				appendLine: (value: string) => coreChannel.append(value + '\n'),
			}
			: {
				append: (value: string) => console.log(`[ide-agent] ${value}`),
				appendLine: (value: string) => console.log(`[ide-agent] ${value}`),
			};
		const enginePath = this.configurationService.getValue<string>('ide.agent.enginePath') || defaultEnginePath();
		return {
			enginePath,
			output,
			// Tab completions are tool-free (session.generate is a single LLM
			// call); approvals can never legitimately arise on this path.
			// Deny defensively rather than prompting from a ghost-text flow.
			requestApproval: async () => undefined,
		};
	}

	/**
	 * TAB-BACKEND: the chat/composer side of the setEngineResolver contract
	 * (see IdeTabContribution.setEngineResolver). This contribution runs at
	 * LifecyclePhase.Restored, so getWorkbenchContribution may instantiate the
	 * Eventually-phase Tab contribution on demand — supported by the registry
	 * with no phase warning at Restored.
	 */
	private wireTabEngineBackend(): void {
		try {
			const ideTab = getWorkbenchContribution<IdeTabContribution>(IdeTabContribution.ID);
			ideTab.setEngineResolver(() => this.resolveTabEngineAdapter());
		} catch (err) {
			// The Tab backend stays silent (isEngineAvailable === false) —
			// never break composer activation over Tab wiring.
			console.error(`[composer] failed to wire Tab engine backend: ${err instanceof Error ? err.message : err}`);
		}
	}

	/**
	 * WORKER-GAPS-66D (`tab-close-restore`): editor-resolver registrations for
	 * the composer tab schemes. When a chat/app tab is closed, HistoryService
	 * records its `toUntyped()` form; `reopenLastClosedEditor()` then reopens
	 * it via `editorService.openEditor({resource, options: {override}})` —
	 * these factories are what turn that untyped record back into a real
	 * EditorInput (the binary wires its inputs the same way: `toUntyped()`
	 * @27634878/@26562063 + the stock history service @27652666).
	 *
	 * Honest divergences vs. a live Cursor tab restore:
	 * - Chat tabs reopen as a fresh tab shell for the same tab id; the
	 *   transcript is not restored (product decision: checkpoint restore =
	 *   files-only, transcripts are not rewound).
	 * - Changes / Review Changes tabs reopen with the agent id + scope from
	 *   the resource URI; the changed-file snapshot taken at open time is
	 *   not part of the resource, so it starts empty and refreshes.
	 */
	private registerTabCloseRestoreResolvers(instantiationService: IInstantiationService): void {
		// Chat (Agent) tab: `ide-chat:/<tabId>`.
		this._register(this.editorResolverService.registerEditor(
			`${COMPOSER_CHAT_EDITOR_SCHEME}:**/**`,
			{
				id: ComposerChatEditorInput.ID,
				label: localize('tabCloseRestore.chatEditorLabel', 'Composer Chat'),
				priority: RegisteredEditorPriority.builtin,
			},
			{
				canSupportResource: resource => resource.scheme === COMPOSER_CHAT_EDITOR_SCHEME,
			},
			{
				createEditorInput: ({ resource }) => {
					const tabId = parseComposerChatTabRef({ scheme: resource.scheme, path: resource.path, query: resource.query });
					if (!tabId) {
						throw new Error(`tab-close-restore: cannot parse chat tab id from resource ${resource.toString()}`);
					}
					return { editor: instantiationService.createInstance(ComposerChatEditorInput, tabId) };
				},
			},
		));

		// Changes tab: `composer-changes:/<agentId>?scope=<scope>`.
		this._register(this.editorResolverService.registerEditor(
			`${COMPOSER_CHANGES_EDITOR_SCHEME}:**/**`,
			{
				id: ComposerChangesEditorInput.ID,
				label: localize('tabCloseRestore.changesEditorLabel', 'Changes'),
				priority: RegisteredEditorPriority.builtin,
			},
			{
				canSupportResource: resource => resource.scheme === COMPOSER_CHANGES_EDITOR_SCHEME
					&& parseComposerChangesTabRef({ scheme: resource.scheme, path: resource.path, query: resource.query })?.kind === 'changes',
			},
			{
				createEditorInput: ({ resource }) => {
					const ref = parseComposerChangesTabRef({ scheme: resource.scheme, path: resource.path, query: resource.query });
					if (!ref || ref.kind !== 'changes') {
						throw new Error(`tab-close-restore: cannot parse Changes tab from resource ${resource.toString()}`);
					}
					return { editor: new ComposerChangesEditorInput(ref.agentId, ref.scope, []) };
				},
			},
		));

		// Review Changes tab: `composer-changes:/review/<agentId>?scope=<scope>`.
		this._register(this.editorResolverService.registerEditor(
			`${COMPOSER_CHANGES_EDITOR_SCHEME}:**/**`,
			{
				id: ComposerReviewChangesEditorInput.ID,
				label: localize('tabCloseRestore.reviewChangesEditorLabel', 'Review Changes'),
				priority: RegisteredEditorPriority.builtin,
			},
			{
				canSupportResource: resource => resource.scheme === COMPOSER_CHANGES_EDITOR_SCHEME
					&& parseComposerChangesTabRef({ scheme: resource.scheme, path: resource.path, query: resource.query })?.kind === 'review',
			},
			{
				createEditorInput: ({ resource }) => {
					const ref = parseComposerChangesTabRef({ scheme: resource.scheme, path: resource.path, query: resource.query });
					if (!ref || ref.kind !== 'review') {
						throw new Error(`tab-close-restore: cannot parse Review Changes tab from resource ${resource.toString()}`);
					}
					return { editor: new ComposerReviewChangesEditorInput(ref.agentId, ref.scope, []) };
				},
			},
		));

		// Customize tab: `ide-customize:/<section>` (singleton; reopens on the
		// section the tab had when it was closed).
		this._register(this.editorResolverService.registerEditor(
			`${COMPOSER_CUSTOMIZE_SCHEME}:**/**`,
			{
				id: ComposerCustomizeEditorInput.ID,
				label: localize('tabCloseRestore.customizeEditorLabel', 'Customize'),
				priority: RegisteredEditorPriority.builtin,
			},
			{
				canSupportResource: resource => resource.scheme === COMPOSER_CUSTOMIZE_SCHEME,
			},
			{
				createEditorInput: ({ resource }) => {
					const section = parseComposerCustomizeTabRef(
						{ scheme: resource.scheme, path: resource.path, query: resource.query },
						COMPOSER_CUSTOMIZE_SECTIONS,
					) ?? COMPOSER_CUSTOMIZE_DEFAULT_SECTION;
					return { editor: instantiationService.createInstance(ComposerCustomizeEditorInput, section) };
				},
			},
		));
	}

	/**
	 * DEV-GAPS-9B: keeps the `composer.changesTabEnabled` context key in sync
	 * with the `composer.changesTab.enabled` setting (default true). The
	 * `composer.openChangesTab` command's palette entry is gated on this key —
	 * our explicit analog of Cursor's binary `showChangesAction` gate.
	 * (QA-MIGRATION-C: `glass.openChangesTab` keeps its CtrlCmd+E keybinding but is
	 * palette-hidden; `composer.openChangesTab` is the single palette entry.)
	 */
	private syncChangesTabEnabled(): void {
		const key = ComposerContextKeys.changesTabEnabled.bindTo(this.contextKeyService);
		const apply = () => key.set(this.configurationService.getValue<boolean>('composer.changesTab.enabled') ?? true);
		apply();
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('composer.changesTab.enabled')) {
				apply();
			}
		}));
		// IContextKey is not IDisposable in this fork — reset on dispose.
		this._register(toDisposable(() => key.reset()));
	}

	/**
	 * DEV-GAPS-18-W4 (`agent-worktree-chat-actions`): keeps the
	 * `composer.chatHasWorktree` context key in sync with the active chat
	 * tab's `worktreePath` — the fork analog of Cursor's
	 * `gitWorktree.worktreePath` gate for the worktree overflow-menu items
	 * ("Copy worktree path" / "Open terminal in worktree" /
	 * "Open new window in worktree"). Re-syncs on active-editor change and on
	 * the active tab's `onDidChangeWorktreePath`.
	 */
	private syncChatHasWorktreeKey(): void {
		const key = ComposerContextKeys.chatHasWorktree.bindTo(this.contextKeyService);
		const inputListener = new MutableDisposable();
		this._register(inputListener);
		const update = () => {
			const input = this.editorService.activeEditor;
			const worktreePath = input instanceof ComposerChatEditorInput ? input.worktreePath : undefined;
			key.set(!!worktreePath);
			inputListener.clear();
			if (input instanceof ComposerChatEditorInput) {
				inputListener.value = input.onDidChangeWorktreePath(() => update());
			}
		};
		update();
		this._register(this.editorService.onDidActiveEditorChange(() => update()));
		// IContextKey is not IDisposable in this fork — reset on dispose.
		this._register(toDisposable(() => key.reset()));
	}

	/**
	 * WORKER-GAPS-66A (`chat-tab-title-menu-inventory`): syncs the verbatim
	 * Cursor 3.25.9 chat-tab title-menu context keys (see
	 * common/chatTitleMenu.ts for the binary evidence):
	 * - `composerEditorTabCanRename` = the active editor is a chat tab.
	 * - `composerEditorTabIsCloudAgent` = false (no cloud-agent chats).
	 * - `isSharedChatsEnabled` = false until a share backend lands (the
	 *   extension flips it, following the `glassEditorPanelFullscreen`
	 *   writer pattern).
	 */
	private syncChatTitleMenuContextKeys(): void {
		const canRenameKey = ComposerContextKeys.chatEditorTabCanRename.bindTo(this.contextKeyService);
		const isCloudAgentKey = ComposerContextKeys.chatEditorTabIsCloudAgent.bindTo(this.contextKeyService);
		const sharedChatsKey = ComposerContextKeys.isSharedChatsEnabled.bindTo(this.contextKeyService);
		isCloudAgentKey.set(false);
		sharedChatsKey.set(false);
		const update = () => {
			canRenameKey.set(this.editorService.activeEditor instanceof ComposerChatEditorInput);
		};
		update();
		this._register(this.editorService.onDidActiveEditorChange(() => update()));
		// IContextKey is not IDisposable in this fork — reset on dispose.
		this._register(toDisposable(() => {
			canRenameKey.reset();
			isCloudAgentKey.reset();
			sharedChatsKey.reset();
		}));
	}
}

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench)
	.registerWorkbenchContribution(ComposerWorkbenchContribution, LifecyclePhase.Restored);

// DEV-GAPS-83 (agent-fix-with-agent-error): Cursor's AI fix code-action
// contribution — verbatim binary contribution id
// `workbench.contrib.aiFixCodeActions` (Cursor 3.25.9 glass bundle,
// byte ~42717352): registers `editor.action.fixInAgent` + the "Fix in
// Agent" QuickFix CodeActionProvider + the `composer.isCursorOnLint`
// context-key tracker. See browser/aiFixCodeActions.ts.
Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench)
	.registerWorkbenchContribution(AiFixCodeActionsContribution, LifecyclePhase.Restored);

// DEV-GAPS-83 (settings-window-layout): Window Layout preset applier —
// watches `ide.window.defaultLayout` and applies the verbatim Cursor
// Agent/Editor layout presets. See browser/windowLayoutActions.ts.
Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench)
	.registerWorkbenchContribution(WindowLayoutContribution, LifecyclePhase.Restored);

// DEV-GAPS-103 (settings-autohide-editor): Auto-Hide Editor When Empty —
// watches editor closes / part visibility and hides the editor part when
// every main editor group is empty (binary layout guard @38454971 in
// workbench.desktop.main.js). See browser/autoHideEditorActions.ts.
Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench)
	.registerWorkbenchContribution(AutoHideEditorContribution, LifecyclePhase.Restored);

// GAPS-148 (onboarding-flow): on-start contribution — binary registers
// `workbench.contrib.onboarding.onStart.cursor` (class Fti) whose ctor
// calls `onboardingService.maybeOnboard()`; the binary phase is
// `hs.BlockRestore`, the fork's equivalent on-start phase is Restored.
Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench)
	.registerWorkbenchContribution(OnboardingOnStartContribution, LifecyclePhase.Restored);

// GAPS-170 (entry #32): terminal event producers for the tooltip
// pipelines (terminal.focus/type/show) + eager instantiation of the
// tooltip service so its persisted pipeline `createdAt` clock starts
// on first run (see tooltipActions.ts).
Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench)
	.registerWorkbenchContribution(TooltipEventProducerContribution, LifecyclePhase.Restored);

// GAPS-152 (agent-notification-actions): OS-notification bridge — registers
// the verbatim `composer.*FromNotification` commands (binary: CommandsRegistry
// @29946768 in workbench.desktop.main.js 3.25.9) and the fork-internal
// `composer.showAgentSystemNotification` bridge that shows agent OS
// notifications via IHostService.showToast and routes clicks/actions back to
// the payload's commands. See browser/agentNotificationActions.ts.
Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench)
	.registerWorkbenchContribution(AgentNotificationBridgeContribution, LifecyclePhase.Restored);

// GAPS-181 (CAT-B port, acceptPlan consumer C2 / W71B-F1): live consumer of
// `IComposerPlanService.onDidAcceptPlan` — forwards plans accepted through
// the core `composer.acceptPlan` command path to the ide-agent extension's
// build phase (`ide.acceptPlanFromCore`). Before this, the event's only
// subscriber was the never-instantiated core composer data service, so a
// core-side accept built nothing. See browser/composerPlanBridge.ts.
Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench)
	.registerWorkbenchContribution(ComposerPlanAcceptConsumerContribution, LifecyclePhase.Restored);
