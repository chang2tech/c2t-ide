import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import * as childProcess from "node:child_process";
import { ModeName } from "./model";
import { ComposerDataService, ComposerEvent, defaultEnginePath } from "./services/composerDataService";
import { buildPromptQualityPanelHtml, scorePrompt } from "./services/promptQualityService";
import { forkInfoMessage, forkTabFromBubble } from "./services/chatForkFromBubble";
import {
  copyBubbleMessageToClipboard,
  makeCopyMessageSeam,
} from "./services/chatCopyMessageService";
import { normalizeChatWidth } from "./services/chatWidthService";
import {
  fixErrorWithAgent,
  type FixRange as FixWithAgentRange,
} from "./services/fixWithAgentService";
import {
  dispatchNativeBrowserChatAttachment,
  NativeBrowserChatAttachment,
} from "./services/nativeBrowserChatReceiver";
import { ChatTabService, ChatTab } from "./services/chatTabService";
import { ChatTabBadgeSync } from "./services/chatTabBadgeSync";
import { QueuedMessage, MessageQueueService } from "./services/messageQueueService";
import {
  CHAT_EDITOR_VIEW_TYPE,
  ChatEditorProvider,
  chatEditorUriForTab,
  openChatAsEditorTabs,
  openChatEditor,
  resolveChatEditorTab,
  type ChatEditorDeps,
} from "./services/chatEditorProvider";
import {
  addToChat as addToChatService,
  buildEditorSelectionLabel,
  realVscodeSeam,
  sanitizeAddToChatArgs,
  type AddToChatArgs,
  type AddToChatHost,
} from "./services/addToChat";
import {
  CUSTOMIZE_EDITOR_VIEW_TYPE,
  CUSTOMIZE_OPEN_TAB_COMMANDS,
  CustomizeEditorProvider,
  openCustomizeEditor,
  type CustomizeHostDeps,
  type CustomizeSectionId,
  type CustomizeSnapshot,
  type CustomizeSubagent,
} from "./services/customizeView";
import { mergeBuiltinSubagents } from "./services/builtinSubagents";
import {
  LocalScheduledTasksService,
  normalizeScheduledTaskModelConfig,
  type ScheduledTask,
  type ScheduledTaskModelConfig,
} from "./services/localScheduledTasksService";

/**
 * Serialize queue items for the webview.
 */
function serializeQueue(items: QueuedMessage[]): Array<{
  id: string;
  text: string;
  mode: string;
  enqueuedAt: number;
}> {
  return items.map((m) => ({
    id: m.id,
    text: m.text,
    mode: m.mode,
    enqueuedAt: m.enqueuedAt,
  }));
}

/**
 * GAPS-46D (agent-custom-modes): serialize the active custom mode for the
 * webview badge (label + badge styling).
 */
function serializeCustomMode(session: CustomModeSession | null): {
  label: string;
  icon: string;
  colorId: string;
  turnsInMode: number;
} | null {
  if (!session) {
    return null;
  }
  const badge = customModeBadgeAppearance(session);
  return {
    label: session.label,
    icon: badge.icon,
    colorId: badge.colorId,
    turnsInMode: session.turnsInMode,
  };
}
import { MODES, DROPDOWN_MODES, modeDef, cycleMode, customModeBadgeAppearance } from "./services/modeService";
import type { CustomModeSession } from "./services/modeService";
import { ApprovalRequest } from "./services/humanReviewService";
import { BranchMenuService } from "./services/branchMenuService";
import { isShellToolApproval, decideCancelTerminalTarget } from "./services/shellApprovalKeyboard";
import { ChatInboxService } from "./services/chatInboxService";
import { ChatInboxTreeProvider } from "./services/chatInboxTreeProvider";
import {
  GET_CHAT_EXPORT_TRANSCRIPT_COMMAND,
  chatTabToExportTranscript,
  type ChatExportTranscript,
} from "./services/chatExportService";
// DEV-GAPS-77F (handler-less trap audit): the four services below shipped
// with complete register functions + tests but no call site in activate() —
// their commands silently did not exist at runtime. Wired below, right
// after `tabs` is created.
import { SideChatService, registerSideChatCommands } from "./services/sideChatService";
import { registerChatGotoDefinition } from "./services/chatGotoDefinitionService";
import { registerBrowserSplitCommands } from "./services/browserSplitService";
import { registerChatDownloadFileCommand } from "./services/chatDownloadFileService";
// WORKER-GAPS-11D (agent-subagent-preview-tray): Cursor
// `glass.openSubagentPreviewInAgentsTray` parity.
import {
  OPEN_SUBAGENT_PREVIEW_IN_AGENTS_TRAY_COMMAND,
  SubagentPreviewService,
} from "./services/subagentPreviewService";
// DEV-GAPS-10 (rex-004): `.cursor/permissions.json` loader.
import { CursorPermissionsFileService } from "./services/permissionsFileService";
// GAPS-11B (agent-git-branch-reminder): the pre-turn branch-change check now
// lives inside ComposerDataService (per-composer TrackedGitRepoState,
// binary-verified mechanism) — no extension-level watcher wiring needed.
// DEV-GAPS-10 (bugbot-editor-review-cta): Cursor 3.25.9 `cursor.runEditorBugbot` parity.
// DEV-GAPS-15 (bugbot-remaining-commands): + `cursor.openBugbotPane`,
// `cursor.reviewBugbotFromAd`, `cursor.enableAutoReviewOnCommit` (DEEP-DIG-A,
// Cursor 3.25.6 binary-verbatim ids).
// WORKER-GAPS-42D (bugbot-auto-review): the auto-review mechanism corrected to
// the binary-verbatim `cursor-commits` trigger (`bugbotCommitTrigger.ts`) and
// the storage-backed `autoRunBugbotOnCommit` gate.
import {
  BUGBOT_RUN_EDITOR_REVIEW_COMMAND_ID,
  BUGBOT_RUN_EDITOR_REVIEW_TITLE,
  registerBugbotReviewCommand,
  BUGBOT_OPEN_PANE_COMMAND_ID,
  BUGBOT_OPEN_PANE_TITLE,
  BUGBOT_REVIEW_FROM_AD_COMMAND_ID,
  BUGBOT_REVIEW_FROM_AD_TITLE,
  BUGBOT_ENABLE_AUTO_REVIEW_COMMAND_ID,
  BUGBOT_ENABLE_AUTO_REVIEW_TITLE,
  BUGBOT_AUTO_RUN_STORAGE_KEY,
  BUGBOT_AUTO_REVIEW_CONFIG_SECTION,
  BUGBOT_AUTO_REVIEW_CONFIG_KEY,
  BugbotReviewHistory,
  setBugbotAutoRunOnCommit,
  registerBugbotAutoReviewEnableCommand,
  registerBugbotFromAdCommand,
  registerOpenBugbotPaneCommand,
} from "./services/bugbotReviewService";
import {
  createBugbotGitRunner,
  watchBugbotCommits,
} from "./services/bugbotCommitTrigger";
// DEV-GAPS-65 (cursor-install-cli): binary-verbatim `cursor.installCli`
// ("Install Cursor CLI", workbench.desktop.main.js @36708706, Cursor 3.25.9)
// — CLI detection + Panel-terminal install flow.
import {
  ALREADY_INSTALLED_MESSAGE,
  CLI_DETECTION_STATUS_STORAGE_KEY,
  INSTALL_CLI_COMMAND_ID,
  buildCliDetectionStatus,
  parseCliDetectionStatus,
  probeCliExecutables,
  runInstallCliFlow,
  type CliDetectionStatus,
  type CliProbeDeps,
} from "./cli-install";
import { OnboardingChecklistService } from "./services/onboardingChecklistService";
import { OnboardingChecklistTreeProvider } from "./services/onboardingChecklistTreeProvider";
import type { OnboardingTreeNode } from "./services/onboardingChecklistTreeProvider";
import { WorktreeService, WorktreeCleanupScheduler } from "./services/worktreeService";
import { gitExecFile } from "./services/gitExec";
import {
  buildCommitMessagePrompt,
  cleanCommitMessage,
  parseRecentCommitMessages,
  COMMIT_MESSAGE_RECENT_COUNT,
  type CommitDiffSource,
} from "./commit-message";
import { createComposer } from "./components/composer";
import { activate as activateTab } from "./tab/extension";
import { activateBrowserViewCommands } from "./services/browser/browserViewCommands";
import { TerminalService } from "./services/terminalService";
import { InlineEditService } from "./services/inlineEditService";
import { activateMcp, createCursorApi } from "./mcp";
import type { CursorApi } from "./mcp";
import { SlashCommandService } from "./services/slashCommandService";
import { attachPendingSelection } from "./services/inlinePromptSelection";
import { showFindInChat, hideFindInChat, findNextInChat, findPreviousInChat } from "./services/findInChat";
import { playChime, defaultChimePath } from "./services/chime";
import {
  CONTINUE_INTERRUPTED_KEY,
  CONTINUE_INTERRUPTED_SECTION,
  INTERRUPTED_TURNS_STORAGE_KEY,
  parseInterruptedTurnRecords,
  runInterruptedAgentsResume,
} from "./services/continueInterruptedAgents";
import {
  searchConversations as searchConversationIndex,
  type SearchableSession,
} from "./services/conversationSearch";
import {
  buildModelParameterDefinitions,
  findCycleableParameters,
  nextParameterOption,
} from "./services/modelParameterService";
import { MentionService, MentionChip, isMentionChip, FileAttachment } from "./services/mentionService";
import { SubmitSendMode } from "./services/composerDataService";
import { EngineModelInfo, ModelRef } from "./services/agentService";
import { IdeCodeEngineAdapter } from "./services/ideCodeEngineAdapter";
import { initAiCodeTracking } from "./services/aiCodeTracking";
import { AiCodeTrackingStatusBar } from "./services/aiCodeTrackingStatusBar";
import { watchCommitsForScoring } from "./services/commitScoreWatcher";
import { setSandboxDebugLogging, isSandboxDebugLogging } from "./sandbox/sandboxService";
import {
  AUTO_MODEL_VALUE,
  CURSOR_DEFAULT_VALUE,
  ModelSelection,
  ModelService,
  autoSelection,
  buildModelPickerEntries,
  cursorDefaultSelection,
  filterEnabledModels,
  isModelEnabled,
  nextEnabledModel,
  selectionKind,
  selectionValue,
} from "./services/modelService";
import { HookService } from "./hooks/hookService";
import { DesktopBridgeServer } from "./services/desktopBridgeServer";
import {
  CHANGES_TAB_COMMAND_IDS,
  normalizeOpenChangesTabArgs,
} from "./services/changesTab";
import { BrowserTabManager } from "./browser/browserTab";
import { browserCaptureDir, screenshotFilename } from "./browser/chromium";
import {
  confirmStoreSkillsSynced,
  defaultSkillStoreDir,
  installSkill,
  installedFromDir,
  listInstalledSkills,
  packSkillPlugin,
  reloadAndConfirmResync,
  reloadConfirmAndDeleteLocalSkill,
  removePluginCache,
  restoreLocalSkill,
} from "./services/skillStoreService";
import {
  SkillMigrationController,
  copySkillsFromStore,
  copySkillsToStore,
  cursorHomeSkillsDir,
  migrateSkills,
  moveSkillOutOfStore,
  moveSkillToStore,
  trashMigratedHomeSkills,
  trashMigratedStoreSkills,
} from "./services/skillMigrationService";

/** Module-level hook service ref so deactivate() can fire sessionEnd hooks. */
let hookServiceRef: HookService | undefined;

/** Module-level browser tab manager ref so deactivate() can stop Chromium. */
let browserTabsRef: BrowserTabManager | undefined;

/** Module-level desktop bridge server ref so deactivate() can stop it (spec §5 P2). */
let desktopBridgeServerRef: DesktopBridgeServer | undefined;

/**
 * ide-agent — built-in AI agent extension for the ide-code VS Code fork.
 *
 * Architecture (mirrors Cursor 3.25.6's composer stack, deep-composer-ui.md):
 *   services/  — ComposerDataService (central hub), ModeService,
 *                HumanReviewService, CheckpointService, MessageQueueService,
 *                EngineAdapter (the ide-code core seam)
 *   stores/    — ComposerBubbleSetStore: fine-grained Map keyed by bubbleId,
 *                dual client/server identity, toolCallId → bubbleId index.
 *                No single immutable transcript array.
 *   components/— createComposer factory (webview) + bubble view-model helpers.
 *
 * SCAFFOLD STATUS: every command, view, keybinding and the chat participant
 * are real and registered. Behaviors needing the engine run against
 * StubEngineAdapter and are visibly labeled "engine wiring pending" —
 * except the @ide chat participant, which runs the real sidecar engine
 * (IdeCodeEngineAdapter) directly.
 */

interface ScaffoldCommand {
  id: string;
  title: string;
  /** One-line description of what this command will do once the engine lands. */
  does: string;
}

const COMMANDS: ScaffoldCommand[] = [
  { id: "ide.newChat", title: "New Chat", does: "focus the IDE Agent chat view and start a fresh conversation" },
  // WORKER-GAPS-22A (agent-new-agent-command-family, Cursor 3.25.9 parity):
  // runtime targets of the workbench-core `glass.newAgent*` family. "New
  // Agent" (palette, Ctrl+N) vs "New Agent Chat" (ide.newAgentChat) are
  // distinct binary commands — do NOT merge them.
  { id: "ide.newAgent", title: "New Agent", does: "open a new agent session (Cursor glass.newAgent parity: palette Ctrl+N / Ctrl+Alt+N variants, cloud-repo and folder target branches)" },
  { id: "ide.newAgentWithModel", title: "New Agent with Model", does: "open a new agent session seeded with the given model id (Cursor glass.newAgentWithModel parity)" },
  // WORKER-GAPS-40B (keybindings-inventory-newAgent-family, auditor run 30,
  // Cursor 3.25.9 parity): runtime target of the workbench-core
  // `glass.newProjectSubagent` (workbench.glass.main.js @45345673, title
  // "New Agent", Ctrl+T, when JDi && !GMe && !focusInAny, f1:!1). The binary
  // emits `newProjectSubagentRequested` (distinct from `newAgentRequested`);
  // the fork has no separate project-subagent target (no project selector /
  // workspace-target service), so the runtime creates a new agent session via
  // the shared newAgent() path — the distinct emission name is preserved in
  // the telemetry log for future divergence.
  { id: "ide.newProjectSubagent", title: "New Agent", does: "open a new agent session (Cursor glass.newProjectSubagent parity: Ctrl+T, emits newProjectSubagentRequested)" },
  { id: "ide.focusChatInput", title: "Focus Chat Input", does: "focus the chat composer input from anywhere (Cursor Ctrl+I parity)" },
  // DEV-GAPS-3-HOTKEYS: "Focus Agent" (Cursor 3.25.9 composer.focusComposer
  // parity) — reveals the chat surface and focuses the main input box. The
  // binary constructor registers NO keybinding (Ctrl+. is Cursor's Open
  // Workspace, not Focus Agent), so none is contributed here either.
  { id: "ide.focusAgent", title: "Focus Agent", does: "reveal the agent chat surface and focus the main input box (Cursor composer.focusComposer parity; no default keybinding)" },
  { id: "ide.investigateError", title: "Investigate Error in Chat", does: "send the current file/selection plus diagnostics to the agent (Cursor Ctrl+Shift+D parity)" },
  // DEV-GAPS-83 (agent-fix-with-agent-error): runtime half of the core
  // `editor.action.fixInAgent` command (Cursor 3.25.9
  // workbench.contrib.aiFixCodeActions) — the "Fix in Agent" QuickFix code
  // action and the marker-hover "Fix with Agent" button funnel here.
  { id: "ide.fixWithAgent", title: "Fix with Agent", does: "send a diagnostic error to the agent with the verbatim Cursor fix prompt (editor.action.fixInAgent runtime)" },
  { id: "ide.reopenChatTab", title: "Reopen Last Closed Chat Tab", does: "reopen the most recently closed chat tab (Cursor Ctrl+Shift+T parity; the transcript is not restored)" },
  { id: "ide.newFollowup", title: "Focus Chat Followup", does: "focus the follow-up input of the active chat" },
  { id: "ide.newAgentChat", title: "New Agent Chat", does: "open a new agent-mode chat tab" },
  { id: "ide.openInlinePrompt", title: "Open Inline Prompt", does: "open the Cmd+K-style inline prompt bar at the cursor" },
  { id: "ide.acceptInlineEdit", title: "Accept Inline Edit", does: "accept the pending inline edit preview (Ctrl+Enter) — web/aux fallback for the core editor.action.inlineDiffs.acceptAll" },
  { id: "ide.rejectInlineEdit", title: "Reject Inline Edit", does: "revert the pending inline edit preview (Esc) — web/aux fallback for the core editor.action.inlineDiffs.rejectAll" },
  { id: "ide.cancelInlineEditGeneration", title: "Cancel Inline Edit Generation", does: "abort the in-flight inline edit generation — web/aux fallback for the core editor.action.inlineDiffs.cancelEdits (Ctrl/Cmd+Shift+Backspace, weight 600)" },
  { id: "ide.acceptPartialInlineEdit", title: "Accept Partial Inline Edit", does: "accept only the current change in the pending inline edit preview (Ctrl+Shift+Y / Cmd+Y)" },
  { id: "ide.rejectPartialInlineEdit", title: "Reject Partial Inline Edit", does: "reject only the current change in the pending inline edit preview (Ctrl+N)" },
  { id: "ide.nextInlineChange", title: "Go to Next Inline Change", does: "jump to the next pending change in the inline edit preview (Alt+J)" },
  { id: "ide.previousInlineChange", title: "Go to Previous Inline Change", does: "jump to the previous pending change in the inline edit preview (Alt+K)" },
  { id: "ide.nextInlineDiffFile", title: "Go to Next Inline Diff File", does: "jump to the next file with a pending inline diff (Alt+L)" },
  { id: "ide.previousInlineDiffFile", title: "Go to Previous Inline Diff File", does: "jump to the previous file with a pending inline diff (Alt+H)" },
  { id: "ide.sendToAgent", title: "Send Inline Prompt to Agent", does: "escalate the inline prompt into a full agent turn" },
  // F2-A (2026-10-20): bridge for the workbench-core inline-edit flow — the
  // core IInlineEditService escalates through this command (same behavior as
  // the extension's own inline-edit prefillChat: submit to the ACTIVE
  // composer + focus the chat surface).
  { id: "ide.submitInlinePromptToChat", title: "Submit Inline Prompt to Chat", does: "submit an escalated inline-edit prompt to the active chat composer (core inline-edit bridge)" },
  { id: "ide.openModeMenu", title: "Open Mode Menu", does: "open the Plan/Debug/Multitask/Ask mode picker (Agent is the implicit default)" },
  { id: "ide.openModelPicker", title: "Open Model Picker", does: "open the model picker quickpick" },
  { id: "ide.manageModels", title: "Manage Models…", does: "enable or disable individual engine models (ide.agent.enabledModels)" },
  // DEV-GAPS-54 (ai-commit-message-generation, Cursor 3.25.9 parity):
  // cursor.generateGitCommitMessage ("Generate Commit Message", f1 palette,
  // sparkle icon, menus.scm/inputBox when scmProvider==git). Collects staged
  // (index-group) or working-tree files, fetches diffs + recent commit
  // messages via the git provider, builds explicit context, generates an AI
  // commit message, and writes it into the SCM input box.
  { id: "ide.generateGitCommitMessage", title: "Generate Commit Message", does: "generate a commit message from the staged (or working-tree) diff plus recent commit style and fill the SCM input" },
  { id: "ide.cycleModel", title: "Cycle Model", does: "cycle to the next enabled model (skips models disabled in ide.agent.enabledModels)" },
  // DEV-GAPS-29: separate command from ide.cycleModel (Cursor 3.25.9
  // composer.cycleModelParameter parity): cycles the current model's
  // cycleable parameter (isCycleableByHotkey && >1 option — the engine
  // catalog's model variant) first, falls back to cycling the model.
  { id: "ide.cycleModelParameter", title: "Cycle Model Parameter", does: "cycle the current model's cycleable parameter (model variant) or fall back to cycling the model" },
  { id: "ide.toggleChatAsEditor", title: "Toggle Chat as Editor", does: "toggle the chat between side view and editor tab" },
  // DEV-FULLSCREEN-COMPOSER (Cursor 3.25.9 parity): binary-verified
  // `glass.enterEditorPanelFullscreen` ("Enter Full Screen") /
  // `glass.exitEditorPanelFullscreen` ("Exit Full Screen"), both on
  // Ctrl/Cmd+Shift+M (Ctrl/Cmd+Shift+I is DevTools in Cursor — the
  // dotcursorrules.com cheat sheet is wrong). Real implementations below.
  { id: "ide.openFullscreenComposer", title: "Enter Full Screen", does: "open the chat composer maximized in the editor area (Cursor Ctrl/Cmd+Shift+M parity)" },
  { id: "ide.exitFullscreenComposer", title: "Exit Full Screen", does: "restore the workbench layout after fullscreen composer" },
  { id: "ide.nextChatTab", title: "Next Chat Tab", does: "switch to the next chat tab" },
  { id: "ide.previousChatTab", title: "Previous Chat Tab", does: "switch to the previous chat tab" },
  { id: "ide.selectNextChat", title: "Select Next Chat", does: "select the next chat in the chat list" },
  { id: "ide.selectPreviousChat", title: "Select Previous Chat", does: "select the previous chat in the chat list" },
  { id: "ide.selectNextSubagentTab", title: "Select Next Subagent Tab", does: "switch to the next subagent tab" },
  { id: "ide.selectPreviousSubagentTab", title: "Select Previous Subagent Tab", does: "switch to the previous subagent tab" },
  { id: "ide.closeChatTab", title: "Close Chat Tab", does: "close the active chat tab" },
  // DEV-GAPS-73 (chat-tab-close-actions, Cursor 3.25.9 parity): runtime
  // targets of the workbench-core `composer.clearComposerTabs` ("Close
  // All Tabs", ViewTitle group '0_chatManage' order 3, f1:true) and
  // `composer.closeOtherComposerTabs` ("Close Other Tabs", f1:true,
  // ViewTitle menu order 2). Per-tab closeTab semantics are reused (a running or
  // draining turn asks first with the "Close Running Tab?" confirm dialog —
  // DEV-GAPS-81; cancelling keeps the tab; the last chat stays open, cleared).
  { id: "ide.closeAllChatTabs", title: "Close All Chat Tabs", does: "close every chat tab; a tab with a running turn asks for confirmation first (\"Close Running Tab?\"), and the last remaining chat is cleared instead of closed (Cursor always keeps one chat open)" },
  { id: "ide.closeOtherChatTabs", title: "Close Other Chat Tabs", does: "close every chat tab except the active one; a tab with a running turn asks for confirmation first (\"Close Running Tab?\")" },
  // W65D (chat-cancel-generation-shortcut, Cursor 3.25.9 parity): runtime
  // for the binary-verbatim `composer.cancelComposerStep` /
  // `composer.cancelComposerStepInputFocused` ("Cancel Chat",
  // workbench.glass.main.js @39862622/@39865699). Cancels the active
  // composer's running turn (the fork's cancelCurrentStep); the binary's
  // accept/reject-all branch has no fork analog (the engine applies file
  // edits directly), so it stays a documented no-op.
  { id: "ide.cancelAgentStep", title: "Cancel Agent Step", does: "cancel the currently running agent step (Cursor composer.cancelComposerStep parity)" },
  // DEV-GAPS-66/W66A (agent-accept-pending-decisions): runtime for the
  // binary-verbatim `composer.acceptComposerStep` ("Accept pending agent
  // pane action", workbench.glass.main.js 3.25.9 class LAb @39863346).
  // Accepts EVERY item of the active composer's pending user-decision
  // group (ComposerDataService.getPendingUserDecisionGroup — terminal
  // decisions first, else the leading run of similar tools); when the
  // group is empty it falls back to acceptNotification() (documented
  // no-op in the fork — no host-owned composer notification service).
  { id: "ide.acceptComposerStep", title: "Accept Pending Agent Pane Action", does: "accept every pending user decision of the active composer (Cursor composer.acceptComposerStep parity)" },
  // DEV-GAPS-56 (agent-resume-chat, Cursor 3.25.9 parity): runtime for the
  // binary-verbatim `composer.resumeCurrentChat` ("Resume Current Chat",
  // workbench.glass.main.js 3.25.9, class CAb): selected composer → handle
  // must be loaded (else log-warn "Cannot resume: composer not loaded") →
  // chatService.resumeChat(handle, {isAutoResume}) with failures caught and
  // log-warned. ComposerDataService.resumeChat is the chatService port.
  { id: "ide.resumeCurrentChat", title: "Resume Current Chat", does: "resume the active composer's interrupted turn (Cursor composer.resumeCurrentChat parity)" },
  // W69C (changes-tab-base-branch-menu, Cursor 3.25.9 parity): runtime for
  // the binary-verbatim `cursor.openBranchMenu` ("Open Branch Menu",
  // workbench.glass.main.js 3.25.9 class JXl @27418580: f1:!0, keybinding
  // CtrlCmd+Quote weight 600 when composerFocused). Fires the branch-menu
  // request event for the active composer ONLY while its conversation is
  // still empty (binary guard `isComposerConversationEmpty`); the
  // BranchMenuService handler then opens the "Switch base branch (X)"
  // picker. All guard failures are silent, exactly like the binary.
  { id: "ide.openBranchMenu", title: "Open Branch Menu", does: "open the base-branch selector for the active (still-empty) composer (Cursor cursor.openBranchMenu parity)" },
  // DEV-GAPS-56 (deeplink-prompt-prefill, Cursor 3.25.9 parity): the
  // internal command the cursor-deeplink extension fires after validating
  // an `ide-code://anysphere.ide-code-deeplink/prompt?text=…[&workspace=…]
  // [&mode=…]` URL — the binary's verbatim id `deeplink.prompt.prefill`,
  // registered inside Cursor's workbench; the fork registers it here (the
  // chat webview's host) and ide-deeplink executes it. Prefill only: the
  // user reviews and sends (same contract as the webview `prefill`
  // message); the optional mode is applied first.
  { id: "deeplink.prompt.prefill", title: "Prefill Chat Prompt (Deeplink)", does: "prefill the chat input from a validated deeplink prompt (Cursor deeplink.prompt.prefill parity)" },
  { id: "ide.findInChat", title: "Find in Chat", does: "focus the find widget inside the chat view" },
  { id: "ide.hideFindInChat", title: "Hide Find in Chat", does: "hide the find widget inside the chat view" },
  { id: "ide.findNextInChat", title: "Find Next in Chat", does: "advance to the next match in the chat find widget (Cursor composer.find.next parity)" },
  { id: "ide.findPreviousInChat", title: "Find Previous in Chat", does: "go back to the previous match in the chat find widget (Cursor composer.find.previous parity)" },
  { id: "ide.openAddContextMenu", title: "Add Context…", does: "open the @-mention context picker (files, symbols, browser, images)" },
  { id: "ide.approveShellTool", title: "Approve Pending Shell Command", does: "approve the pending shell tool call once" },
  { id: "ide.approveShellToolAllowlist", title: "Approve Pending Shell Command and Allowlist It", does: "approve the pending shell tool call and add it to the allowlist" },
  { id: "ide.skipShellTool", title: "Skip Pending Shell Command", does: "skip the pending shell tool call" },
  // GAPS-14 (agent-shell-approval-keyboard-flow): runtime half of Cursor's
  // binary-verbatim `composer.cancelTerminalToolCall` ("Cancel Terminal
  // Tool Call", Shift+Backspace) — cancels the RUNNING terminal tool call
  // (Ctrl+C via TerminalService.cancelActiveRun).
  { id: "ide.cancelTerminalToolCall", title: "Cancel Terminal Tool Call", does: "cancel the currently running terminal tool call (Cursor composer.cancelTerminalToolCall parity)" },
  { id: "ide.worktreeCommand", title: "Worktree Command (/worktree)", does: "create an isolated git worktree for the current task (Cursor /worktree parity)" },
  { id: "ide.listWorktrees", title: "List Worktrees", does: "show all git worktrees for the current repo" },
  { id: "ide.deleteWorktree", title: "Delete Worktree…", does: "remove a git worktree (Cursor /delete-worktree parity)" },
  { id: "ide.applyWorktree", title: "Apply Worktree…", does: "bring worktree changes into the main checkout (Cursor /apply-worktree parity)" },
  { id: "ide.focusEditorFromDiff", title: "Focus Editor from Inline Diff", does: "return focus to the editor while the inline prompt bar is open" },
  { id: "ide.addSelectionToInlinePrompt", title: "Add Selection to Inline Prompt", does: "attach the current editor selection to the next inline edit prompt (Cursor K-08 parity)" },
  { id: "ide.acceptPlan", title: "Accept Plan", does: "accept the authored plan and start the build phase" },
  { id: "ide.toggleSandboxDebugLogging", title: "Toggle Sandbox Debug Logging", does: "toggle verbose debug logging for the agent sandbox service (bridge for core composer.toggleSandboxDebugLogging)" },
  { id: "ide.cycleMode", title: "Cycle Mode", does: "cycle the chat mode Agent → Plan → Debug → Multitask → Ask (Shift+Tab)" },
  { id: "ide.setAgentMode", title: "Open Chat in Agent Mode", does: "switch the chat to Agent mode" },
  { id: "ide.setPlanMode", title: "Open Chat in Plan Mode", does: "switch the chat to Plan mode" },
  { id: "ide.setAskMode", title: "Open Chat in Ask Mode", does: "switch the chat to Ask mode" },
  { id: "ide.setDebugMode", title: "Open Chat in Debug Mode", does: "switch the chat to Debug mode" },
  { id: "ide.setMultitaskMode", title: "Open Chat in Multitask Mode", does: "switch the chat to Multitask mode" },
  { id: "ide.startMultitasking", title: "Start Multitasking", does: "switch the chat to Multitask mode and start the parallel orchestration flow (queue-tray entrypoint)" },
  { id: "ide.restoreCheckpoint", title: "Restore Checkpoint…", does: "restore the conversation to a checkpointed message (checkout_to_message)" },
  // P2 (QA-FILE-07): ide.toggleTabCompletion / ide.snoozeTabCompletion /
  // ide.unsnoozeTabCompletion are registered with their real implementations
  // in tab/extension.ts — they must NOT appear here, or the scaffold loop
  // would race the real handlers on duplicate command IDs.
  { id: "ide.openBrowser", title: "Open Browser for Agent", does: "open a browser tab the agent can see and drive" },
  { id: "ide.openBrowserTab", title: "Open Browser Tab", does: "open the in-IDE browser tab with omnibar, screenshot and element picker (Cursor browser tab parity)" },
  { id: "ide.browserTab.newTab", title: "Browser Tab: New Tab", does: "open a fresh browser tab (Cursor workbench.action.newBrowserTab)" },
  { id: "ide.browserTab.reloadTab", title: "Browser Tab: Reload", does: "reload the browser tab page (Cursor workbench.action.reloadBrowserTab)" },
  { id: "ide.browserTab.focusOmnibar", title: "Browser Tab: Focus Address Bar", does: "focus the browser tab location bar (Cursor workbench.action.focusBrowserLocationBar)" },
  { id: "ide.browserTab.screenshotToChat", title: "Browser Tab: Screenshot to Chat", does: "capture the browser tab and attach the screenshot to the chat" },
  { id: "ide.browserTab.togglePicker", title: "Browser Tab: Toggle Element Picker", does: "toggle the element picker — click an element to send it to chat" },
  { id: "ide.browserTab.captureAreaScreenshot", title: "Browser Tab: Capture Area Screenshot", does: "drag a region on the page and capture it to chat (Cursor: Capture Area Screenshot)" },
  { id: "ide.browserTab.hardReload", title: "Browser Tab: Hard Reload", does: "reload the page bypassing cache (Cursor: Hard Reload / reloadIgnoringCache)" },
  { id: "ide.browserTab.copyCurrentUrl", title: "Browser Tab: Copy Current URL", does: "copy the browser tab URL to the clipboard (Cursor: Copy Current URL)" },
  { id: "ide.browserTab.zoomIn", title: "Browser Tab: Zoom In", does: "zoom the browser tab page in (Cursor: BrowserMoreMenu zoom)" },
  { id: "ide.browserTab.zoomOut", title: "Browser Tab: Zoom Out", does: "zoom the browser tab page out" },
  { id: "ide.browserTab.zoomReset", title: "Browser Tab: Reset Zoom", does: "reset the browser tab page zoom to 100%" },
  { id: "ide.browserTab.clearBrowsingData", title: "Browser Tab: Clear Browsing Data", does: "clear history / cookies / cache with confirmation (Cursor: Clear Browsing History / Clear Cookies / Clear Cache)" },
  { id: "ide.browserTab.openDevTools", title: "Browser Tab: Open DevTools", does: "open the Chrome DevTools frontend for the tab in a side panel" },
  { id: "ide.reviewChanges", title: "Review Changes with Agent", does: "ask the agent to review the working-tree changes" },
  // DEV-GAPS-10 (bugbot-editor-review-cta): binary-verbatim command id
  // `cursor.runEditorBugbot` (Cursor 3.25.9). HONEST-DIVERGENCE: the title is
  // INFERRED — the binary evidence only shows the command id + the
  // `bug_bot.editor_review_cta_route` telemetry event. Real implementation
  // registered below in the switch (runs an agent review on the active file).
  { id: BUGBOT_RUN_EDITOR_REVIEW_COMMAND_ID, title: BUGBOT_RUN_EDITOR_REVIEW_TITLE, does: "run the bugbot auto-review entry on the latest commit (Cursor cursor.runEditorBugbot parity: storage+killswitch gate, branch review)" },
  // DEV-GAPS-15 (bugbot-remaining-commands): binary-verbatim command ids
  // from DEEP-DIG-A (Cursor 3.25.6). HONEST-DIVERGENCE: the titles are
  // INFERRED — the binary evidence only shows the command ids. Real
  // implementations are registered below in the switch.
  { id: BUGBOT_OPEN_PANE_COMMAND_ID, title: BUGBOT_OPEN_PANE_TITLE, does: "open the Bugbot pane listing recent bugbot review runs (Cursor cursor.openBugbotPane parity)" },
  { id: BUGBOT_REVIEW_FROM_AD_COMMAND_ID, title: BUGBOT_REVIEW_FROM_AD_TITLE, does: "start a bugbot review from an ad/CTA surface — same real review flow as cursor.runEditorBugbot (Cursor cursor.reviewBugbotFromAd parity)" },
  { id: BUGBOT_ENABLE_AUTO_REVIEW_COMMAND_ID, title: BUGBOT_ENABLE_AUTO_REVIEW_TITLE, does: "enable bugbot auto-review on every git commit (sets the autoRunBugbotOnCommit storage flag; Cursor cursor.enableAutoReviewOnCommit parity)" },
  // DEV-GAPS-65 (cursor-install-cli): binary-verbatim `cursor.installCli`
  // ("Install Cursor CLI", @36708706) — detects the CLI via PATH +
  // ~/.local/bin (keyed off the `agent` binary) and either toasts that it
  // is already installed or opens a Panel terminal running the install
  // command. HONEST-DIVERGENCE: the already-installed toast text is a
  // placeholder (binary nls 10693 text UNKNOWN); detection persists in
  // globalState (Cursor uses applicationUserPersistentStorage).
  { id: INSTALL_CLI_COMMAND_ID, title: "Install Cursor CLI", does: "install the IDE Code CLI: detect the agent CLI binary (PATH + ~/.local/bin) and, unless already installed, open a Panel terminal running the verbatim install command (Cursor cursor.installCli parity)" },
  // DEV-GAPS-10: Changes tab (Cursor `glass.openChangesTab` parity,
  // audit-fix-queue run 24). Registered for real below — delegates to the
  // canonical core action `composer.openChangesTab`.
  { id: "ide.openChangesTab", title: "Changes", does: "open the Changes tab showing the agent's last turn changed files (Cursor glass.openChangesTab parity)" },
  { id: "ide.fixWithAI", title: "Fix with AI", does: "send the current selection (or file) plus diagnostics to the agent to fix" },
  { id: "ide.addToChat", title: "Add to Chat", does: "attach the current editor or terminal selection as context to the chat input (Cursor Ctrl+L parity)" },
  { id: "ide.copyRequestId", title: "Copy Request ID", does: "copy the last turn's request id to the clipboard (Cursor chat title menu parity)" },
  { id: "ide.giveFeedback", title: "Give Feedback", does: "send feedback about the chat (Cursor chat title menu parity)" },
  { id: "ide.renameChat", title: "Rename Chat", does: "rename the chat tab (Cursor chat title menu parity)" },
  { id: "ide.forkChat", title: "Fork Chat", does: "open a new chat tab seeded from the current transcript (Cursor chat title menu parity)" },
  { id: "ide.pinChat", title: "Pin Chat", does: "pin the chat to the top of the chat list (Cursor 2.1 parity)" },
  { id: "ide.unpinChat", title: "Unpin Chat", does: "unpin the chat — it returns to time order in the chat list (Cursor 2.1 parity)" },
  { id: "ide.openAgentSettings", title: "Agent Settings", does: "open the IDE Agent settings (Cursor chat title menu parity)" },
  // WORKER-GAPS-66A (chat-tab-title-menu-inventory): runtime target of the
  // core action `composer.shareChat` ("Share Transcript", Cursor 3.25.9
  // binary-verbatim @39835596 glass). The fork has no share backend, so the
  // handler honestly reports unavailability; the core menu item is gated on
  // `isSharedChatsEnabled` (stays false until a backend lands).
  { id: "ide.shareChat", title: "Share Transcript", does: "share the chat transcript via a link (Cursor composer.shareChat parity — no share backend in this build yet)" },
  { id: "ide.openCustomize", title: "Open Customize", does: "open the Customize editor tab — plugins, MCPs, skills, subagents, rules, commands, hooks (Cursor parity)" },
  { id: "workbench.action.openCustomizeEditor", title: "Open Customize Editor", does: "open the Customize editor tab (Cursor workbench.action.openCustomizeEditor parity)" },
  { id: "workbench.action.customize.openPlugins", title: "Open Plugins", does: "open the Customize editor on the Plugins tab" },
  { id: "workbench.action.customize.openMCPs", title: "Open MCPs", does: "open the Customize editor on the MCPs tab" },
  { id: "workbench.action.customize.openSkills", title: "Open Skills", does: "open the Customize editor on the Skills tab" },
  { id: "workbench.action.customize.openSubagents", title: "Open Subagents", does: "open the Customize editor on the Subagents tab" },
  { id: "workbench.action.customize.openRules", title: "Open Rules", does: "open the Customize editor on the Rules tab" },
  { id: "workbench.action.customize.openCommands", title: "Open Commands", does: "open the Customize editor on the Commands tab" },
  { id: "workbench.action.customize.openHooks", title: "Open Hooks", does: "open the Customize editor on the Hooks tab" },
  { id: "ide.terminalAiCommand", title: "Generate Terminal Command with AI", does: "describe a task and prefill the chat to generate a terminal command" },
  { id: "ide.searchConversations", title: "Search Conversations", does: "search across agent conversations" },
  { id: "ide.openSettings", title: "Open IDE Agent Settings", does: "open the IDE Agent settings UI" },
  { id: "ide.openDocs", title: "Open IDE Code Documentation", does: "open the IDE Code docs in the external browser (Cursor Docs-nav parity)" },
  { id: "ide.terminalRunBackground", title: "Run Command in Background", does: "run a shell command in the background IDE Agent terminal with output streaming to chat" },
  // DD-SB-7: real implementation — registered below in the switch, NOT a scaffold.
  { id: "aiCodeTracking.resetDailyStats", title: "Reset AI Code Tracking Stats", does: "reset today's AI code tracking counters (Tab + Agent stats)" },
  // WORKER-GAPS-36D (rules-user): Cursor knowledge-base commands,
  // binary-verified in 3.25.9 (editor.action.knowledgeBase.add = "Add User
  // Rule", editor.action.knowledgeBase.list = "View User Rules", category
  // "knowledge_base"). Real implementations registered below in the switch.
  { id: "editor.action.knowledgeBase.add", title: "Add User Rule", does: "add a global User Rule — applies to all Agent chats (Cursor knowledgeBase parity)" },
  { id: "editor.action.knowledgeBase.list", title: "View User Rules", does: "view, edit, and delete global User Rules (Cursor knowledgeBase parity)" },
];

const PENDING = "engine wiring pending";

/** The live chat webview provider, when the chat view has been created. */
let activeChatView: ChatViewProvider | undefined;

/** The chat editor provider, for posting to open chat editor tabs (P2-3). */
let chatEditorProviderRef: ChatEditorProvider | undefined;
/** The Customize editor provider (singleton view; per-tab open commands). */
let customizeEditorProviderRef: CustomizeEditorProvider | undefined;

function notifyScaffold(cmd: ScaffoldCommand): void {
  void vscode.window.showInformationMessage(
    `IDE Agent (scaffold): "${cmd.title}" — ${PENDING}. This will ${cmd.does}.`,
    "OK",
  );
}

import type { McpService } from "./mcp";

/**
 * Build the Customize view's host dependencies from the real extension
 * services (DD-CV-1: wire real data where we have it).
 *
 * REAL: MCP servers (mcp.json via McpService), hook execution log
 * (HookService), rules (.mdc via ProjectRulesService), skills
 * (.cursor/skills via SlashCommandService), commands (.cursor/commands),
 * plugins (installed extensions via vscode.extensions.all — the extension
 * editor handles enable/disable/uninstall), subagents (engine agent
 * markdown dirs {agent,agents}/**\/*.md — the engine's own store).
 * PLACEHOLDER (labeled in the UI): installing a plugin from a GitHub
 * repository URL — no vsix-packaging backend exists for that yet.
 */
function buildCustomizeHostDeps(
  context: vscode.ExtensionContext,
  tabs: ChatTabService,
  slash: SlashCommandService,
  hookService: HookService,
  mcpService: McpService,
): CustomizeHostDeps {
  const homeDir = os.homedir();
  const isUserPath = (p: string): boolean =>
    p === homeDir || p.startsWith(homeDir + path.sep);
  const firstWorkspaceRoot = (): string | undefined =>
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  const ensureDir = (dir: string): void => {
    fs.mkdirSync(dir, { recursive: true });
  };

  const openPath = async (filePath: string): Promise<void> => {
    const doc = await vscode.workspace.openTextDocument(filePath);
    await vscode.window.showTextDocument(doc, { preview: false });
  };

  const promptName = async (
    title: string,
    placeHolder: string,
  ): Promise<string | undefined> => {
    const raw = await vscode.window.showInputBox({
      title,
      placeHolder,
      validateInput: (v) =>
        /^[a-z0-9][a-z0-9-_]*$/i.test(v.trim())
          ? undefined
          : "Use letters, numbers, dashes and underscores, starting with a letter or number.",
    });
    return raw?.trim() || undefined;
  };

  // Subagent store: the ide-code engine discovers custom agents from markdown
  // files in {agent,agents}/**/*.md under its config entries
  // (packages/core/src/config/plugin/agent.ts). Mirror that discovery so the
  // Subagents section lists exactly what the engine loads — creating a file
  // here is picked up by the live engine (it watches config entries).
  const ENGINE_CONFIG_DIR =
    process.env.XDG_CONFIG_HOME && path.isAbsolute(process.env.XDG_CONFIG_HOME)
      ? path.join(process.env.XDG_CONFIG_HOME, "opencode")
      : path.join(homeDir, ".config", "opencode");

  const readAgentDescription = (filePath: string): string => {
    try {
      const text = fs.readFileSync(filePath, "utf8");
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
      if (!frontmatter) {
        return "";
      }
      const desc = /^description\s*:\s*(.+)$/m.exec(frontmatter[1]);
      if (!desc) {
        return "";
      }
      return desc[1].trim().replace(/^["']|["']$/g, "");
    } catch {
      return "";
    }
  };

  const discoverSubagents = (): CustomizeSubagent[] => {
    const out: CustomizeSubagent[] = [];
    const seen = new Set<string>();
    const scanDir = (dir: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scanDir(full);
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
          if (seen.has(full)) {
            continue;
          }
          seen.add(full);
          out.push({
            name: entry.name.replace(/\.md$/i, ""),
            description: readAgentDescription(full),
            filePath: full,
            scope: isUserPath(full) ? "user" : "workspace",
          });
        }
      }
    };
    for (const sub of ["agent", "agents"]) {
      scanDir(path.join(ENGINE_CONFIG_DIR, sub));
    }
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      for (const sub of ["agent", "agents"]) {
        scanDir(path.join(folder.uri.fsPath, ".opencode", sub));
      }
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  };

  return {
    getSnapshot(): CustomizeSnapshot {
      const rules = tabs.activeComposer.projectRules.getRules();
      const userRules = tabs.activeComposer.userRules.getRules();
      return {
        // Plugins ARE extensions in this IDE — the real installed set.
        plugins: vscode.extensions.all.map((e) => ({
          id: e.id,
          displayName:
            (e.packageJSON?.displayName as string | undefined) ?? e.id,
          version: (e.packageJSON?.version as string | undefined) ?? "",
          description: (e.packageJSON?.description as string | undefined) ?? "",
        })),
        mcps: mcpService.getServerStatuses().map((s) => ({
          id: s.id,
          name: s.displayName,
          scope: s.scope === "user" || s.scope === "vscode" ? "user" : "workspace",
          state: s.state,
          toolCount: s.toolCount,
          lastError: s.lastError,
        })),
        skills: slash.getSkills().map((s) => ({
          name: s.name,
          description: s.description,
          filePath: s.filePath,
          scope: isUserPath(s.filePath) ? "user" : "workspace",
        })),
        rules: [
          ...rules.map((r) => ({
            name: r.filename,
            description: r.description,
            filePath: r.fullPath,
            workspaceRoot: r.workspaceRoot,
            kind: "mdc" as const,
          })),
          // GAPS-36D (rules-user): global User Rules live in Customize →
          // Rules alongside the .mdc project rules (docs:
          // https://cursor.com/docs/rules). They have no file or workspace
          // scope — clicking one opens the management flow.
          ...userRules.map((r) => ({
            name: r.title,
            description:
              r.content.length > 120 ? `${r.content.slice(0, 120)}…` : r.content,
            filePath: "",
            workspaceRoot: "",
            kind: "user" as const,
            userRuleId: r.id,
          })),
        ],
        commands: slash.getCustomCommands().map((c) => ({
          name: c.name,
          description: c.description ?? "",
          source: c.source,
          filePath: c.filePath,
        })),
        // Subagents: the engine's real agent-markdown store (see
        // discoverSubagents above) — exactly what the engine loads —
        // PLUS Cursor's built-in subagents (DEV-GAPS-40, subagent-builtin:
        // docs/rea/deep-docs-all.md "Built-in: explore (codebase search),
        // browser (browser automation via MCP)"). Builtins come first and
        // are marked builtin (no file, non-deletable); a user-defined
        // agent with the same name overrides the builtin, matching the
        // engine's own rule ("A user-configured agent named \"explore\"
        // overrides the builtin" — packages/core/src/tool/plugin/subagent.ts).
        agents: mergeBuiltinSubagents(discoverSubagents()),
        hookLog: hookService.getExecutionLog().map((e) => ({
          at: e.at,
          event: e.event,
          source: e.source,
          command: e.command,
          exitCode: e.exitCode,
          durationMs: e.durationMs,
          decision: e.decision,
        })),
        hookConfiguredCount: hookService.getLoadedHookCount(),
        workspaces: (vscode.workspace.workspaceFolders ?? []).map((f) => ({
          fsPath: f.uri.fsPath,
          name: f.name,
        })),
        dataSource: {
          plugins: "real",
          mcps: "real",
          skills: "real",
          agents: "real",
          rules: "real",
          commands: "real",
          hooks: "real",
        },
      };
    },

    refreshSources(): void {
      hookService.refresh();
      void slash.reloadCustomCommands();
      void slash.reloadSkills();
    },

    clearHookLog(): void {
      hookService.clearExecutionLog();
    },

    openDocumentation(_section: CustomizeSectionId): void {
      // IDE Code has no docs site yet; Cursor's Documentation buttons open
      // Cursor's docs, so this is the parity reference until ours exists.
      void vscode.env.openExternal(vscode.Uri.parse("https://cursor.com/docs"));
    },

    browseMarketplace(): void {
      // This IDE's plugins ARE extensions — the Extensions view is the real
      // marketplace surface for browsing and installing them.
      void vscode.commands.executeCommand("workbench.view.extensions");
    },

    openPlugin(id: string): void {
      // The platform's extension editor is the real plugin manager:
      // Enable / Disable / Uninstall all work from there.
      void vscode.commands.executeCommand("extension.open", id);
    },

    addPluginFrom(source: "marketplace" | "github" | "local"): void {
      if (source === "marketplace") {
        void vscode.commands.executeCommand("workbench.view.extensions");
        return;
      }
      if (source === "github") {
        // Honest gap: cloning a repo and packaging it as an installable
        // plugin needs a vsix-packaging backend that does not exist yet.
        void vscode.window.showInformationMessage(
          "IDE Agent: installing plugins from GitHub is not available in this build yet.",
        );
        return;
      }
      // A local plugin is a packaged .vsix — the platform installs it for real.
      void vscode.commands.executeCommand(
        "workbench.extensions.action.installVSIX",
      );
    },

    createMcp(): void {
      // "New" on the MCPs tab: open .cursor/mcp.json for editing (creates a
      // starter file when missing) — the real config surface for our servers.
      const root = firstWorkspaceRoot();
      if (!root) {
        void vscode.window.showWarningMessage(
          "IDE Agent: open a workspace folder first to configure MCP servers.",
        );
        return;
      }
      const file = path.join(root, ".cursor", "mcp.json");
      try {
        if (!fs.existsSync(file)) {
          ensureDir(path.dirname(file));
          fs.writeFileSync(
            file,
            JSON.stringify({ mcpServers: {} }, null, 2) + "\n",
            "utf8",
          );
        }
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`IDE Agent: could not create mcp.json — ${m}`);
        return;
      }
      void openPath(file).then(
        () => undefined,
        () => undefined,
      );
    },

    createSkill(): void {
      const root = firstWorkspaceRoot();
      if (!root) {
        void vscode.window.showWarningMessage(
          "IDE Agent: open a workspace folder first to create a skill.",
        );
        return;
      }
      void promptName("New skill", "my-skill").then((name) => {
        if (!name) {
          return;
        }
        const dir = path.join(root, ".cursor", "skills", name);
        const file = path.join(dir, "SKILL.md");
        try {
          ensureDir(dir);
          if (!fs.existsSync(file)) {
            fs.writeFileSync(
              file,
              `---\nname: ${name}\ndescription: TODO — when Agent should use this skill\n---\n\n# ${name}\n\nTeach the agent domain-specific knowledge and workflows here.\n`,
              "utf8",
            );
          }
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err);
          void vscode.window.showErrorMessage(`IDE Agent: could not create skill — ${m}`);
          return;
        }
        void openPath(file);
      });
    },

    createSubagent(): void {
      // Real subagent store: a markdown agent definition in the engine's
      // {agent,agents}/ discovery dirs (see discoverSubagents above). The
      // live engine watches these dirs and loads the new agent.
      const root = firstWorkspaceRoot();
      const dir = root
        ? path.join(root, ".opencode", "agent")
        : path.join(ENGINE_CONFIG_DIR, "agent");
      void promptName("New subagent", "my-subagent").then((name) => {
        if (!name) {
          return;
        }
        const file = path.join(dir, `${name}.md`);
        try {
          ensureDir(dir);
          if (!fs.existsSync(file)) {
            fs.writeFileSync(
              file,
              `---\ndescription: TODO — when Agent should use this subagent\nmode: subagent\n---\n\n# ${name}\n\nYou are a specialized subagent. Describe when to use you, then define your behavior here.\n`,
              "utf8",
            );
          }
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err);
          void vscode.window.showErrorMessage(`IDE Agent: could not create subagent — ${m}`);
          return;
        }
        void openPath(file);
      });
    },

    createRule(): void {
      const root = firstWorkspaceRoot();
      if (!root) {
        void vscode.window.showWarningMessage(
          "IDE Agent: open a workspace folder first to create a rule.",
        );
        return;
      }
      void promptName("New rule", "my-rule").then((name) => {
        if (!name) {
          return;
        }
        const file = path.join(root, ".cursor", "rules", `${name}.mdc`);
        try {
          ensureDir(path.dirname(file));
          if (!fs.existsSync(file)) {
            fs.writeFileSync(
              file,
              `---\ndescription: TODO — what this rule is for\nglobs:\nalwaysApply: false\n---\n\n# ${name}\n\nPersistent, system-level instructions for the agent.\n`,
              "utf8",
            );
          }
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err);
          void vscode.window.showErrorMessage(`IDE Agent: could not create rule — ${m}`);
          return;
        }
        void openPath(file);
      });
    },

    createCommand(): void {
      const root = firstWorkspaceRoot();
      if (!root) {
        void vscode.window.showWarningMessage(
          "IDE Agent: open a workspace folder first to create a command.",
        );
        return;
      }
      void promptName("New command", "my-command").then((name) => {
        if (!name) {
          return;
        }
        const file = path.join(root, ".cursor", "commands", `${name}.md`);
        try {
          ensureDir(path.dirname(file));
          if (!fs.existsSync(file)) {
            fs.writeFileSync(
              file,
              `---\ndescription: TODO — what /${name} does\n---\n\n# /${name}\n\nReusable prompt: describe the workflow the agent should run.\n`,
              "utf8",
            );
          }
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err);
          void vscode.window.showErrorMessage(`IDE Agent: could not create command — ${m}`);
          return;
        }
        void openPath(file);
      });
    },

    openItem(_kind, filePath: string): void {
      void openPath(filePath).then(
        () => undefined,
        () => undefined,
      );
    },
    // GAPS-36D (rules-user): user rules have no file — open the "View User
    // Rules" management flow (editor.action.knowledgeBase.list).
    openUserRule(): void {
      void vscode.commands.executeCommand("editor.action.knowledgeBase.list");
    },
  };
}

export function activate(context: vscode.ExtensionContext): { cursor: CursorApi } {
  // DEV-HOOKS: Cursor-style agent hooks (21 verified events). Config sources:
  // /etc/ide-code/hooks.json → ~/.ide-code/hooks.json → .ide-code/hooks.json
  // (per workspace) → ~/.cursor + .cursor compat → .claude/settings*.json.
  // The execution log lives in the "IDE Agent Hooks" output channel.
  const hooksOutput = vscode.window.createOutputChannel("IDE Agent Hooks");
  const hookService = new HookService({
    workspaceRoots: vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [],
    appVersion: context.extension.packageJSON?.version ?? "0.0.0",
    log: (line) => hooksOutput.appendLine(line),
  });
  hookServiceRef = hookService;
  context.subscriptions.push(hooksOutput);
  if (hookService.getConfigErrors().length > 0) {
    void vscode.window.showWarningMessage(
      `IDE Agent: ${hookService.getConfigErrors().length} hook config problem(s) — see the "IDE Agent Hooks" output channel.`,
    );
  }

  // ---- AI code tracking (Cursor aiCodeTracking parity, DD-SB-1..7) --------
  // Daily Tab/Agent suggestion-vs-accept line stats + commit scoring, with
  // three display-only status-bar items. Initialized BEFORE the Tab engine
  // and the command loop so both can use the shared singleton.
  // Persistence: `aiCodeTracking.dailyStats.v1.5.{date}` in workspaceState
  // (Cursor's WORKSPACE scope) and `aiCodeTracking.recentCommit` in
  // globalState (Cursor's PROFILE scope) — verbatim key names.
  const tracking = initAiCodeTracking(context.workspaceState, context.globalState);
  const trackingStatusBar = new AiCodeTrackingStatusBar(tracking);
  context.subscriptions.push(trackingStatusBar);
  // Commit scoring (DD-SB-6): score HEAD commits made after activation via
  // the built-in git extension; never throws, no-ops without git.
  void watchCommitsForScoring(tracking)
    .then((watcher) => context.subscriptions.push(watcher))
    .catch(() => undefined);

  // ---- Chat tabs (doc-gap B8): each tab owns a full ComposerDataService —
  // its own bubbles/mode/queue/checkpoints/engine session. `tabs` is the
  // single owner; everything below resolves the active tab live.
  const tabs = new ChatTabService(context, hookService);
  context.subscriptions.push(tabs);
  // ---- DEV-GAPS-77F: wire the orphaned register functions (impl + tests
  // existed, no activate() call site — the commands were dead at runtime).
  // Side chat: the parent transcript comes from the owning tab's composer
  // bubbles (same accessor chatExportService uses); reveal focuses the
  // parent chat editor — there is no dedicated side-chat webview surface
  // yet (Cursor's rendering is UNKNOWN, see sideChatService.ts header).
  const sideChatService = new SideChatService({
    getParentTranscript: (parentChatId) =>
      tabs
        .listTabs()
        .find((t) => t.id === parentChatId)
        ?.composer.bubbles.getAllInOrder()
        .map((b) => ({ role: b.role, text: b.text ?? "" })) ?? [],
    revealSideChat: (chat) => {
      void openChatEditor(tabs, undefined, chat.parentChatId);
    },
    getActiveChatId: () => tabs.activeTab.id,
  });
  context.subscriptions.push(sideChatService);
  registerSideChatCommands({ service: sideChatService, context });
  registerChatGotoDefinition(context);
  registerBrowserSplitCommands(context);
  registerChatDownloadFileCommand(context);
  // ---- DEV-GAPS-10: workspace agent policy + git branch tracking ---------
  // Shared "IDE Agent" output channel for the services wired below.
  const ideOutput = vscode.window.createOutputChannel("IDE Agent");
  context.subscriptions.push(ideOutput);
  // ---- W69C (changes-tab-base-branch-menu) --------------------------------
  // BranchMenuService = the fork's composerEventService +
  // backgroundComposerDataService port for the base-branch selector. The
  // listener below is the fork's branch-selector component handler
  // (binary @27425412: on `onDidRequestOpenBranchMenu` for the selected
  // composer, set "isBranchSelectorOpen" and show the selector labeled
  // `Switch base branch (${base})`). The fork's selected composer is the
  // active chat tab (the established selection mapping — the runtime only
  // ever fires for the active composer). The binary's React popup is a
  // QuickPick here (see branchMenuService.ts divergence notes).
  const branchMenu = new BranchMenuService();
  const branchMenuSubscription = branchMenu.onDidRequestOpenBranchMenu(
    ({ composerId }) => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) {
        return;
      }
      void branchMenu
        .handleOpenRequest({
          composerId,
          selectedComposerId: tabs.activeTab.id,
          cwd: folder.uri.fsPath,
          pick: async (items, snapshot) => {
            const picked = await vscode.window.showQuickPick(
              items.map((item) => ({
                label: item.branch,
                description: [
                  item.isCurrent ? "current" : undefined,
                  item.isDefault ? "default" : undefined,
                  item.description,
                ]
                  .filter((s): s is string => typeof s === "string")
                  .join(" · "),
                branch: item.branch,
              })),
              {
                title: snapshot.label,
                placeHolder: snapshot.label,
                canPickMany: false,
              },
            );
            return picked
              ? items.find((i) => i.branch === picked.branch)
              : undefined;
          },
        })
        .catch(() => undefined);
    },
  );
  context.subscriptions.push({
    dispose: () => branchMenuSubscription.dispose(),
  });
  // ---- CONTINUE-INTERRUPTED-AGENTS (Cursor "Continue Interrupted Agents"
  // parity, `ide.agent.continueInterruptedAgents`, default ON) ---------------
  // Any turn that was in flight when the last process died left a survivor
  // record (see markTurnInFlight/clearTurnInFlight in ComposerDataService).
  // When the setting is on, re-submit each survivor's prompt into the
  // active composer so agents resume working after a reload/restart.
  // Records are cleared before resuming so a crash mid-sweep cannot
  // double-resume. Runs synchronously at activation: submit() is pure data
  // service work (no webview needed) and later prompts queue behind the
  // first turn per the normal queue rules. Never throws.
  try {
    runInterruptedAgentsResume({
      isEnabled: () =>
        vscode.workspace
          .getConfiguration(CONTINUE_INTERRUPTED_SECTION)
          .get<boolean>(CONTINUE_INTERRUPTED_KEY, true),
      readRecords: () =>
        parseInterruptedTurnRecords(
          context.workspaceState.get<unknown>(INTERRUPTED_TURNS_STORAGE_KEY),
        ),
      writeRecords: (records) => {
        void context.workspaceState.update(INTERRUPTED_TURNS_STORAGE_KEY, records);
      },
      resume: (record) => {
        tabs.activeComposer.submit(record.prompt);
      },
      log: (line) => ideOutput.appendLine(line),
    });
  } catch (err) {
    ideOutput.appendLine(
      `[ide-agent] Continue Interrupted Agents sweep failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  // ---- DEV-GAPS-41: periodic worktree cleanup (Cursor parity) --------------
  // Every `ide.worktreeCleanupIntervalHours` (default 6) hours, enforce
  // `ide.worktreeMaxCount` + `ide.worktreesGlobalMaxSizeGb` machine-wide:
  // the oldest worktrees are removed first (locked/dirty worktrees are
  // deferred, never force-removed).
  const worktreeCleanup = new WorktreeCleanupScheduler();
  context.subscriptions.push(worktreeCleanup);
  // WORKER-GAPS-42D (bugbot-auto-review): verbatim port of Cursor's
  // `cursor-commits` extension trigger (Cursor 3.25.9
  // `extensions/cursor-commits/dist/main.js`): every git repository's
  // `state.onDidChange` is debounced 5s, then `shouldRunBugbot` decides
  // (HEAD changed on the same branch, not a merge, authored by me within
  // 30s, not pushed, not just rebased) and dispatches
  // `cursor.runEditorBugbot` via `commands.executeCommand`. The command
  // handler itself re-checks the binary-verbatim gate (storage flag
  // `autoRunBugbotOnCommit` + `bugbot_autorun_killswitch`).
  // Shared in-memory store of bugbot review runs — `cursor.runEditorBugbot`,
  // `cursor.reviewBugbotFromAd` and the commit auto-review all record here;
  // `cursor.openBugbotPane` lists it. No fabricated findings: only real
  // submitted runs are stored.
  const bugbotReviewHistory = new BugbotReviewHistory();
  const bugbotLog = (line: string) => ideOutput.appendLine(line);
  context.subscriptions.push(
    watchBugbotCommits({
      getGitApi: () => {
        try {
          const gitExt = vscode.extensions.getExtension("vscode.git");
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const api = gitExt?.exports as any;
          return typeof api?.getAPI === "function" ? api.getAPI(1) : undefined;
        } catch {
          return undefined;
        }
      },
      git: createBugbotGitRunner(),
      executeCommand: (command, ...args) =>
        vscode.commands.executeCommand(command, ...args),
      notifyGitCommitWasRun: (rootFsPath) => {
        // Cursor-internal API (`t.scm.gitCommitWasRun`); best-effort only.
        try {
          (
            vscode.scm as unknown as {
              gitCommitWasRun?: (p: string) => void;
            }
          ).gitCommitWasRun?.(rootFsPath);
        } catch (err) {
          bugbotLog(`[bugbot] Failed to notify git commit: ${String(err)}`);
        }
      },
      now: () => Date.now(),
      log: {
        debug: (m) => bugbotLog(`[bugbot] ${m}`),
        trace: (m) => bugbotLog(`[bugbot] ${m}`),
        info: (m) => bugbotLog(`[bugbot] ${m}`),
        error: (m, err) =>
          bugbotLog(`[bugbot] ${m}${err ? `: ${String(err)}` : ""}`),
      },
    }),
  );
  // The `ide.bugbot.autoReviewOnCommit` configuration is this fork's
  // Settings-UI surface for the binary-verbatim `autoRunBugbotOnCommit`
  // storage flag (Cursor's own toggle lives in its React Settings UI under
  // the label "Start Agent Review on Commit"). The gate only ever reads the
  // storage flag; the setting is synced into it here.
  // One-time migration: an explicitly-set config wins on first activation
  // (a bare default must NOT clobber a flag enabled via
  // `cursor.enableAutoReviewOnCommit` in an earlier session).
  try {
    const inspected = vscode.workspace
      .getConfiguration(BUGBOT_AUTO_REVIEW_CONFIG_SECTION)
      .inspect<boolean>(BUGBOT_AUTO_REVIEW_CONFIG_KEY);
    const explicit =
      inspected?.globalValue ??
      inspected?.workspaceValue ??
      inspected?.workspaceFolderValue;
    if (explicit !== undefined) {
      void setBugbotAutoRunOnCommit(context.globalState, explicit);
    }
  } catch {
    /* ignore */
  }
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      try {
        if (
          e.affectsConfiguration(
            `${BUGBOT_AUTO_REVIEW_CONFIG_SECTION}.${BUGBOT_AUTO_REVIEW_CONFIG_KEY}`,
          )
        ) {
          const v = vscode.workspace
            .getConfiguration(BUGBOT_AUTO_REVIEW_CONFIG_SECTION)
            .get<boolean>(BUGBOT_AUTO_REVIEW_CONFIG_KEY, false);
          void setBugbotAutoRunOnCommit(context.globalState, v === true);
        }
      } catch {
        /* ignore */
      }
    }),
  );
  // rex-004: `.cursor/permissions.json` — read at startup, re-read on change,
  // applied to every tab's approval choke point (HumanReviewService). Invalid
  // JSON/schema → warning, current policy kept (never crashes).
  const permissionsService = new CursorPermissionsFileService({
    workspaceFolders: () => vscode.workspace.workspaceFolders,
    applyPolicy: (policy) => tabs.setFilePermissions(policy),
    logWarning: (m) => {
      void vscode.window.showWarningMessage(m);
    },
    logInfo: (m) => ideOutput.appendLine(m),
  });
  context.subscriptions.push(permissionsService.start());
  // GAPS-11B (agent-git-branch-reminder): the branch-change reminder is now
  // a pre-turn check inside each ComposerDataService (TrackedGitRepoState),
  // matching Cursor's verified mechanism (turn-build injection into user
  // content). The old mid-turn HEAD-watcher + visible-transcript message
  // did not match the binary evidence and was removed.
  // P1 (QA-MODELPICKER-01): keep the model selection honest when
  // ide.agent.enabledModels changes outside the Manage Models quickpick
  // (hand-edited settings.json), and re-validate once at startup in case the
  // persisted selection was disabled while the extension was off (covers the
  // composerDataService restore path without touching that file).
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("ide.agent.enabledModels")) {
        // P1 (QA-MODELPICKER Round-B): reconcile ALL tabs — each tab owns its
        // own engine adapter with an independent selectedModel, so reconciling
        // only the active tab would leave background tabs burning a model the
        // user just disabled (real money).
        void reconcileAllTabsWithAllowlist(tabs);
      }
    }),
  );
  void reconcileAllTabsWithAllowlist(tabs);
  const terminal = new TerminalService(() => tabs.activeComposer);
  terminal.activate(context);

  // ---- cursor.browserView.* workbench commands (P0 browser-tab-workbench-commands)
  // 30 verified command IDs (REA dissect-browser-tab.md §5); each wires to the
  // native WebContentsView tab via the proposed `browser` API + CDP.
  // Registers even without the native API and fails fast on invoke.
  activateBrowserViewCommands(context);

  // ---- DEV-GAPS-63: local scheduled tasks runner -------------------------
  // Cursor parity (`local-scheduled-tasks-runner`, GlassLocalScheduledTasksService;
  // evidence: docs/rea/dig-root-team/redig-processes.md D-06d,
  // docs/rea/harvest-workbench-glass-main.js-2026-10-18.md §5).
  // Feature-gated via `ide.agent.scheduledTasksEnabled` (mirrors Cursor's
  // experiment-service gate). When enabled, tasks from
  // `ide.agent.scheduledTasks` are claimed by cron schedule; each due task
  // opens a NEW agent chat and submits its prompt there (the fork's local
  // equivalent of Cursor's run execution — how Cursor's runner dispatches a
  // run beyond "prompt + model config" is UNKNOWN).
  const scheduledTasksService = new LocalScheduledTasksService({
    runTask: (task) => {
      // HONEST-DIVERGENCE: the run dispatches the prompt into a fresh agent
      // tab via submit(); tracking the engine turn to completion (as Cursor's
      // main-process runner records run outcomes) is not possible from the
      // extension API — the RunRecord outcome is recorded at dispatch time.
      const tab = tabs.createAndActivate({
        title: `Scheduled: ${task.id}`,
        mode: "agent",
      });
      tab.composer.submit(task.prompt);
    },
    onMissedSummary: (summary) => {
      const lines = summary.missed
        .map((m) => `  • ${m.taskId} due ${new Date(m.dueAt).toISOString()} (${m.reason})`)
        .join("\n");
      ideOutput.appendLine(
        `[scheduled-tasks] ${summary.missed.length} run(s) missed:\n${lines}`,
      );
      void vscode.window.showInformationMessage(
        `IDE Agent: ${summary.missed.length} scheduled task run(s) were missed — see the "IDE Agent" output channel.`,
      );
    },
    featureGate: () =>
      vscode.workspace
        .getConfiguration("ide.agent")
        .get<boolean>("scheduledTasksEnabled", false),
  });
  const loadScheduledTasksConfig = () => {
    const raw = vscode.workspace
      .getConfiguration("ide.agent")
      .get<unknown[]>("scheduledTasks", []);
    const tasks: ScheduledTask[] = [];
    for (const entry of raw) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }
      const rec = entry as Record<string, unknown>;
      if (
        typeof rec.id !== "string" ||
        rec.id.length === 0 ||
        typeof rec.cron !== "string" ||
        rec.cron.length === 0 ||
        typeof rec.prompt !== "string" ||
        rec.prompt.length === 0
      ) {
        ideOutput.appendLine(
          "[scheduled-tasks] Ignoring invalid task entry (needs id/cron/prompt strings).",
        );
        continue;
      }
      tasks.push({
        id: rec.id,
        cron: rec.cron,
        prompt: rec.prompt,
        enabled: rec.enabled !== false,
        modelConfig: normalizeScheduledTaskModelConfig(
          rec.modelConfig as Partial<ScheduledTaskModelConfig> | undefined,
        ),
      });
    }
    scheduledTasksService.setTasks(tasks);
  };
  loadScheduledTasksConfig();
  if (scheduledTasksService.initialize()) {
    scheduledTasksService.start();
    ideOutput.appendLine("[scheduled-tasks] Local scheduled-tasks runner started.");
  }
  context.subscriptions.push({ dispose: () => scheduledTasksService.dispose() });
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration("ide.agent.scheduledTasks") ||
        e.affectsConfiguration("ide.agent.scheduledTasksEnabled")
      ) {
        loadScheduledTasksConfig();
      }
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("ide.scheduledTasks.tickNow", async () => {
      const result = await scheduledTasksService.tick();
      if (result.skipped === "not-initialized") {
        void vscode.window.showWarningMessage(
          'IDE Agent: scheduled tasks are disabled (enable "ide.agent.scheduledTasksEnabled").',
        );
        return;
      }
      void vscode.window.showInformationMessage(
        `IDE Agent: scheduled-tasks tick — ${result.ran.length} ran, ${result.failed.length} failed, ${result.missed.length} missed.`,
      );
    }),
  );

  // ---- MCP (Cursor parity, docs/rea/parity-rules-mcp.md §B) ----------------
  // Extension-host MCP client: .cursor/mcp.json discovery, stdio lifecycle,
  // mcp__<server>__<tool> namespacing, allowlist + HumanReview approval gate.
  // W50D (mcp-symbolic-file-args): thread the hook-interplay signal — Cursor
  // refuses `$file:` symbolic arguments when hooks that inspect MCP calls are
  // configured (binary string: "hooks that inspect MCP calls are configured
  // here, and they would not see the file's contents").
  const mcpService = activateMcp(context, () => tabs.activeComposer, {
    hooksInspectMcpCalls: () =>
      hookService.hasHooks("beforeMCPExecution") || hookService.hasHooks("afterMCPExecution"),
  });

  // ---- cursor.* extension API (Cursor parity: cursor.registerMcpProvider) --
  // In Cursor's app the `cursor` namespace is attached to the `vscode` module
  // by workbench-core's extension host (proposed API). Stock VS Code hands
  // each extension its own `vscode` API object, so an extension cannot
  // publish there for others — the identical contract is published on this
  // extension's exports instead:
  //   const { cursor } = vscode.extensions.getExtension("ide-code.ide-agent")!.exports;
  //   const d = cursor.registerMcpProvider(provider); // → vscode.Disposable
  // Returned from activate() (VS Code exposes it as `exports`); the Desktop
  // bridge / other in-host consumers can also grab it from here.
  const cursorApi: CursorApi = createCursorApi(mcpService);

  // Context ring: feed the real connected-MCP tool catalog (namespaced names
  // + descriptions + input schemas) into every composer so the MCP category
  // measures live data. Extension.ts owns both services; the provider keeps
  // composerDataService free of an mcp/ import cycle.
  tabs.setMcpToolsProvider(() =>
    mcpService.getTools().map((t) => ({
      namespacedName: t.namespacedName,
      description: t.description,
      inputSchemaJson: JSON.stringify(t.inputSchema ?? { type: "object", properties: {} }),
    })),
  );

  // ---- Slash commands (Cursor / palette parity, parity-slash-commands.md) --
  const slash = new SlashCommandService(context, () => tabs.activeComposer);
  slash.restoreMru(context.globalState.get<string>("ideAgent.slashMru"));
  void slash.reloadCustomCommands();
  void slash.reloadSkills();
  context.subscriptions.push(slash);

  // ---- Agent Skills Store (Cursor skill-store parity, local-first) ---------
  // Binary evidence: docs/rea/dig-ast-ext-findings.md §1 — cursor-agent-host
  // registers 14 dynamic skill commands (installSkills.runSkillsCliAdd,
  // publishSkill.packSkillPlugin / reloadConfirmAndDeleteLocalSkill,
  // resyncSkill.packInstalledSkillPlugin / reloadAndConfirmResync,
  // skillStore.confirmStoreSkillsSynced / copySkillsFromStore /
  // copySkillsToStore / moveSkillOutOfStore / moveSkillToStore /
  // trashMigratedHomeSkills / trashMigratedStoreSkills / confirmOverwrite /
  // isMigrationCancelled / reportMigrationProgress,
  // unpublishSkill.removePluginCache / restoreLocalSkill).
  // NAMESPACE-DIVERGENCE (DEV-GAPS-17): Cursor's binary registers these under
  // the `cursor.` namespace; this fork registers them as `ide.` to match the
  // extension-wide command convention (every command in this host is `ide.*`,
  // and menus/keybindings/internal dispatch all reference `ide.*`). The
  // suffix after the namespace is verbatim-identical to the binary.
  // DIVERGENCE: Cursor's store is cloud/account-backed; ours is a LOCAL
  // store at ~/.ide-code/skills/ (no cloud sync, no account). Publish packs
  // a local .tar.gz instead of uploading; installSkills opens a folder
  // picker instead of running Cursor's `skills` CLI.
  const skillStoreDir = defaultSkillStoreDir();
  const skillMigration = new SkillMigrationController();
  const pickInstalledSkill = async (placeHolder: string): Promise<string | undefined> => {
    const skills = listInstalledSkills(skillStoreDir);
    if (skills.length === 0) {
      void vscode.window.showInformationMessage("IDE Agent: no skills installed in the store yet.");
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      skills.map((s) => ({
        label: s.name,
        description: s.published ? `v${s.version} · published` : `v${s.version}`,
        detail: s.description,
      })),
      { placeHolder },
    );
    return picked?.label;
  };
  const pickFolder = async (openLabel: string): Promise<string | undefined> => {
    const folders = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel,
    });
    return folders?.[0]?.fsPath;
  };
  const skillErr = (action: string, err: unknown): void => {
    void vscode.window.showErrorMessage(
      `IDE Agent: could not ${action} — ${err instanceof Error ? err.message : String(err)}`,
    );
  };
  // Full ~/.cursor/skills → store migration with vscode-driven confirm +
  // progress (backs the Customize view's "Migrate" button).
  const runSkillMigration = async (): Promise<void> => {
    skillMigration.reset();
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Migrating skills to the store", cancellable: true },
        async (progress, token) => {
          token.onCancellationRequested(() => skillMigration.cancel());
          const result = await migrateSkills({
            storeDir: skillStoreDir,
            controller: skillMigration,
            onProgress: (p) => {
              progress.report({
                message: p.current ?? p.phase,
                increment: p.total > 0 ? 100 / p.total : undefined,
              });
            },
            confirmOverwrite: async (name) => {
              const choice = await vscode.window.showWarningMessage(
                `Skill "${name}" already exists in the store. Overwrite it with the migrated copy?`,
                { modal: true },
                "Overwrite",
                "Skip",
              );
              return choice === "Overwrite";
            },
          });
          if (result.cancelled) {
            void vscode.window.showWarningMessage("IDE Agent: skill migration cancelled.");
          } else {
            void vscode.window.showInformationMessage(
              `IDE Agent: migrated ${result.migrated.length} skill(s)` +
                (result.skipped.length > 0 ? `, skipped ${result.skipped.length}` : "") +
                (result.overwritten.length > 0 ? `, overwrote ${result.overwritten.length}` : "") +
                ".",
            );
          }
        },
      );
    } catch (err) {
      skillErr("migrate skills", err);
    }
  };
  context.subscriptions.push(
    // Cursor: installSkills.runSkillsCliAdd runs the `skills` CLI to add a
    // skill. DIVERGENCE: no CLI here — pick a skill folder to install.
    vscode.commands.registerCommand("ide.installSkills.runSkillsCliAdd", async () => {
      const dir = await pickFolder("Install Skill");
      if (!dir) {
        return;
      }
      try {
        const installed = installSkill(skillStoreDir, dir);
        void vscode.window.showInformationMessage(
          `IDE Agent: installed skill "${installed.name}" into the store.`,
        );
      } catch (err) {
        skillErr("install skill", err);
      }
    }),
    vscode.commands.registerCommand("ide.publishSkill.packSkillPlugin", async () => {
      const id = await pickInstalledSkill("Publish a skill (pack into the local store)");
      if (!id) {
        return;
      }
      try {
        const archive = packSkillPlugin(skillStoreDir, id);
        void vscode.window.showInformationMessage(
          `IDE Agent: published "${id}" → ${archive}.`,
        );
      } catch (err) {
        skillErr("publish skill", err);
      }
    }),
    vscode.commands.registerCommand("ide.publishSkill.reloadConfirmAndDeleteLocalSkill", async () => {
      const id = await pickInstalledSkill("Delete the local copy of a published skill");
      if (!id) {
        return;
      }
      const localDir =
        (await vscode.window.showInputBox({
          prompt: `Local directory of "${id}" to delete after confirming it is published`,
          value: installedFromDir(skillStoreDir, id) ?? "",
        }))?.trim() || undefined;
      if (!localDir) {
        return;
      }
      try {
        const deleted = await reloadConfirmAndDeleteLocalSkill(
          skillStoreDir,
          id,
          localDir,
          async (skillId, dir) =>
            (await vscode.window.showWarningMessage(
              `Delete the local skill directory?\n${dir}\n"${skillId}" is published in the store, so this cannot be undone from here.`,
              { modal: true },
              "Delete",
            )) === "Delete",
        );
        if (deleted) {
          void vscode.window.showInformationMessage(`IDE Agent: deleted local skill "${id}".`);
        } else {
          void vscode.window.showInformationMessage("IDE Agent: local skill kept (not published or declined).");
        }
      } catch (err) {
        skillErr("delete local skill", err);
      }
    }),
    vscode.commands.registerCommand("ide.resyncSkill.packInstalledSkillPlugin", async () => {
      const id = await pickInstalledSkill("Re-pack an installed skill");
      if (!id) {
        return;
      }
      try {
        const archive = packSkillPlugin(skillStoreDir, id);
        void vscode.window.showInformationMessage(`IDE Agent: re-packed "${id}" → ${archive}.`);
      } catch (err) {
        skillErr("re-pack skill", err);
      }
    }),
    vscode.commands.registerCommand("ide.resyncSkill.reloadAndConfirmResync", async () => {
      const id = await pickInstalledSkill("Resync a skill from the store to a working directory");
      if (!id) {
        return;
      }
      const target =
        (await vscode.window.showInputBox({
          prompt: `Working directory to overwrite with the store copy of "${id}"`,
          value: installedFromDir(skillStoreDir, id) ?? "",
        }))?.trim() || undefined;
      if (!target) {
        return;
      }
      try {
        const done = await reloadAndConfirmResync(
          skillStoreDir,
          id,
          target,
          async (skillId, dir) =>
            (await vscode.window.showWarningMessage(
              `Overwrite "${dir}" with the store copy of "${skillId}"?`,
              { modal: true },
              "Overwrite",
            )) === "Overwrite",
        );
        void vscode.window.showInformationMessage(
          done ? `IDE Agent: resynced "${id}".` : "IDE Agent: resync declined — target untouched.",
        );
      } catch (err) {
        skillErr("resync skill", err);
      }
    }),
    vscode.commands.registerCommand("ide.skillStore.confirmStoreSkillsSynced", async () => {
      const gate = confirmStoreSkillsSynced(skillStoreDir);
      if (gate.synced) {
        void vscode.window.showInformationMessage("IDE Agent: all store skills are in sync.");
      } else {
        void vscode.window.showWarningMessage(
          `IDE Agent: store out of sync — ${gate.problems.join("; ")}`,
        );
      }
    }),
    vscode.commands.registerCommand("ide.skillStore.copySkillsFromStore", async () => {
      const skills = listInstalledSkills(skillStoreDir);
      if (skills.length === 0) {
        void vscode.window.showInformationMessage("IDE Agent: no skills installed in the store yet.");
        return;
      }
      const picked = await vscode.window.showQuickPick(
        skills.map((s) => ({ label: s.name, detail: s.description })),
        { placeHolder: "Copy skills out of the store", canPickMany: true },
      );
      if (!picked || picked.length === 0) {
        return;
      }
      const target = await pickFolder("Copy Skills To");
      if (!target) {
        return;
      }
      try {
        const copied = copySkillsFromStore(skillStoreDir, target, picked.map((p) => p.label));
        void vscode.window.showInformationMessage(`IDE Agent: copied ${copied.length} skill(s) out of the store.`);
      } catch (err) {
        skillErr("copy skills from store", err);
      }
    }),
    vscode.commands.registerCommand("ide.skillStore.copySkillsToStore", async () => {
      const folders = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: true,
        openLabel: "Copy Skill(s) To Store",
      });
      if (!folders || folders.length === 0) {
        return;
      }
      try {
        const ids = copySkillsToStore(skillStoreDir, folders.map((f) => f.fsPath));
        void vscode.window.showInformationMessage(`IDE Agent: copied ${ids.length} skill(s) into the store.`);
      } catch (err) {
        skillErr("copy skills to store", err);
      }
    }),
    vscode.commands.registerCommand("ide.skillStore.moveSkillOutOfStore", async () => {
      const id = await pickInstalledSkill("Move a skill out of the store (removes the store copy)");
      if (!id) {
        return;
      }
      const target = await pickFolder("Move Skill To");
      if (!target) {
        return;
      }
      const go =
        (await vscode.window.showWarningMessage(
          `Move "${id}" out of the skill store into "${target}"? The store copy will be removed.`,
          { modal: true },
          "Move",
        )) === "Move";
      if (!go) {
        return;
      }
      try {
        moveSkillOutOfStore(skillStoreDir, id, target);
        void vscode.window.showInformationMessage(`IDE Agent: moved "${id}" out of the store.`);
      } catch (err) {
        skillErr("move skill out of store", err);
      }
    }),
    vscode.commands.registerCommand("ide.skillStore.moveSkillToStore", async () => {
      const dir = await pickFolder("Move Skill Into Store (source is deleted)");
      if (!dir) {
        return;
      }
      const go =
        (await vscode.window.showWarningMessage(
          `Move "${dir}" into the skill store? The source directory will be deleted.`,
          { modal: true },
          "Move",
        )) === "Move";
      if (!go) {
        return;
      }
      try {
        const id = moveSkillToStore(skillStoreDir, dir);
        void vscode.window.showInformationMessage(`IDE Agent: moved "${id}" into the store.`);
      } catch (err) {
        skillErr("move skill to store", err);
      }
    }),
    vscode.commands.registerCommand("ide.skillStore.trashMigratedHomeSkills", async () => {
      const go =
        (await vscode.window.showWarningMessage(
          `Move ~/.cursor/skills to the recoverable trash (~/.ide-code/trash)?`,
          { modal: true },
          "Move to Trash",
        )) === "Move to Trash";
      if (!go) {
        return;
      }
      try {
        const trashed = trashMigratedHomeSkills();
        void vscode.window.showInformationMessage(
          trashed ? `IDE Agent: moved ~/.cursor/skills to trash.` : "IDE Agent: nothing to trash.",
        );
      } catch (err) {
        skillErr("trash migrated home skills", err);
      }
    }),
    vscode.commands.registerCommand("ide.skillStore.trashMigratedStoreSkills", async () => {
      const go =
        (await vscode.window.showWarningMessage(
          "Move migrated legacy store sources (from the last migration) to the recoverable trash?",
          { modal: true },
          "Move to Trash",
        )) === "Move to Trash";
      if (!go) {
        return;
      }
      try {
        const trashed = trashMigratedStoreSkills(skillStoreDir);
        void vscode.window.showInformationMessage(
          trashed.length > 0
            ? `IDE Agent: moved ${trashed.length} legacy source(s) to trash.`
            : "IDE Agent: nothing to trash (no legacy sources recorded).",
        );
      } catch (err) {
        skillErr("trash migrated store skills", err);
      }
    }),
    // --- Dynamic helper commands (Cursor registers these dynamically; we also
    // declare the 16 task-listed ones in package.json so they are
    // discoverable/triggerable by id) ----------------------------------------
    vscode.commands.registerCommand("ide.skillStore.confirmOverwrite", async (name?: unknown) => {
      const choice = await vscode.window.showWarningMessage(
        typeof name === "string" && name
          ? `Overwrite the existing skill "${name}" in the store?`
          : "Overwrite the existing skill in the store?",
        { modal: true },
        "Overwrite",
        "Skip",
      );
      return choice === "Overwrite";
    }),
    vscode.commands.registerCommand("ide.skillStore.isMigrationCancelled", () => skillMigration.isCancelled()),
    vscode.commands.registerCommand("ide.skillStore.reportMigrationProgress", () => {
      const last = skillMigration.getLastProgress();
      if (last) {
        void vscode.window.showInformationMessage(
          `IDE Agent: migration ${last.phase} — ${last.done}/${last.total}${last.current ? ` (${last.current})` : ""}.`,
        );
      } else {
        void vscode.window.showInformationMessage("IDE Agent: no skill migration has run yet.");
      }
    }),
    vscode.commands.registerCommand("ide.unpublishSkill.removePluginCache", async () => {
      const id = await pickInstalledSkill("Unpublish a skill (remove its pack cache)");
      if (!id) {
        return;
      }
      try {
        const removed = removePluginCache(skillStoreDir, id);
        void vscode.window.showInformationMessage(
          removed > 0 ? `IDE Agent: unpublished "${id}".` : `IDE Agent: "${id}" was not published.`,
        );
      } catch (err) {
        skillErr("unpublish skill", err);
      }
    }),
    vscode.commands.registerCommand("ide.unpublishSkill.restoreLocalSkill", async () => {
      const id = await pickInstalledSkill("Restore a local working copy from the store");
      if (!id) {
        return;
      }
      const target =
        (await vscode.window.showInputBox({
          prompt: `Directory to restore the store copy of "${id}" into`,
          value: installedFromDir(skillStoreDir, id) ?? "",
        }))?.trim() || undefined;
      if (!target) {
        return;
      }
      const go =
        (await vscode.window.showWarningMessage(
          `Restore the store copy of "${id}" into "${target}"? The directory's current contents will be overwritten.`,
          { modal: true },
          "Restore",
        )) === "Restore";
      if (!go) {
        return;
      }
      try {
        restoreLocalSkill(skillStoreDir, id, target);
        void vscode.window.showInformationMessage(`IDE Agent: restored "${id}" to ${target}.`);
      } catch (err) {
        skillErr("restore local skill", err);
      }
    }),
  );

  /** Label for the trash root used in the trash confirmations. */
  function skillTrashRootLabel(): string {
    return "~/.ide-code/trash";
  }

  // ---- Chat editor tabs (Cursor "Chat Editors" parity) ---------------------
  // Register the custom editor provider so chat tabs open as REAL editor
  // tabs (ide-chat:/<tabId>) with the native editor title context menu
  // (Close/Split/Pin/Move into New Window/…) instead of a self-drawn tab
  // bar inside one webview.
  const chatEditorDeps: ChatEditorDeps = {
    terminal,
    slash,
    pickModel,
    readChatUiConfig,
  };
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      CHAT_EDITOR_VIEW_TYPE,
      (chatEditorProviderRef = new ChatEditorProvider(context, tabs, chatEditorDeps)),
      { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false },
    ),
  );

  // ---- Native editor tab orange dot (Cursor parity: cursor.com/changelog/0-48-x —
  // "When a tab is awaiting your input, you'll see an orange dot on that tab") --
  // VS Code's extension API exposes no per-tab badge, so the awaiting-input
  // state (approval / clarifying question) is pushed to a workbench-core
  // bridge command (`ide.chat.setEditorTabBadge`, registered by
  // src/vs/workbench/browser/parts/editor/editorTabBadges.ts) which draws
  // the dot on the NATIVE tab DOM. The webview tab bar's own dot
  // (composer.ts `.qdot`) is unchanged.
  const chatTabBadgeSync = new ChatTabBadgeSync(tabs);
  context.subscriptions.push(chatTabBadgeSync);
  // Re-push badge state when a chat editor (re)opens: core drops badge state
  // for editors that were never open, so the diff-based sync alone would
  // leave a reopened awaiting tab without its dot.
  if (chatEditorProviderRef) {
    chatEditorProviderRef.badgeSync = chatTabBadgeSync;
  }

  // ---- Customize editor tab (Cursor "Customize" parity) --------------------
  // Cursor's Customize is a REAL editor tab (ui-customize-view), not a
  // settings section: 7 pill tabs (Plugins/MCPs/Skills/Subagents/Rules/
  // Commands/Hooks). Same custom-editor pattern as the chat editor tabs.
  // Data wiring: MCPs (mcp.json), hooks (hooks.json execution log), rules
  // (.mdc), skills (.cursor/skills), commands (.cursor/commands), plugins
  // (installed extensions), subagents (engine agent markdown dirs) are REAL;
  // only GitHub-URL plugin install stays a labeled placeholder.
  const customizeDeps: CustomizeHostDeps = buildCustomizeHostDeps(
    context,
    tabs,
    slash,
    hookService,
    mcpService,
  );
  // DEV-GAPS-5-SKILLS: wire the Customize view's Skills-section store buttons
  // (Install/Publish/Resync/Unpublish/Migrate) to the ide.* skill command
  // surface registered in the "Agent Skills Store" section above. The
  // "migrate" action runs the ~/.cursor/skills → store migration flow
  // (Cursor skillStore migration), which has no standalone dynamic command.
  customizeDeps.skillStoreAction = (
    action: "install" | "publish" | "resync" | "unpublish" | "migrate",
  ): void => {
    const command =
      action === "install"
        ? "ide.installSkills.runSkillsCliAdd"
        : action === "publish"
          ? "ide.publishSkill.packSkillPlugin"
          : action === "resync"
            ? "ide.resyncSkill.reloadAndConfirmResync"
            : action === "unpublish"
              ? "ide.unpublishSkill.removePluginCache"
              : undefined;
    if (command) {
      void vscode.commands.executeCommand(command);
    } else {
      void runSkillMigration();
    }
  };
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      CUSTOMIZE_EDITOR_VIEW_TYPE,
      (customizeEditorProviderRef = new CustomizeEditorProvider(customizeDeps)),
      { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false },
    ),
  );

  // ---- Inline edit (Cursor Cmd+K flow, parity C1–C8) -----------------------
  // prefillChat escalates to a full agent turn: submit the prepared prompt to
  // the chat composer and focus it (same pattern as ide.fixWithAI).
  const inlineEdit = new InlineEditService(context, {
    prefillChat: async (text: string) => {
      tabs.activeComposer.submit(text);
      await focusChatSurface(tabs);
    },
  });
  context.subscriptions.push(inlineEdit);

  // ---- Browser tab (Cursor browser-tab parity, parity-browser-checklist.md Part B)
  // User-visible browser tab in the editor area: omnibar chrome, CDP
  // screencast of the agent's BrowserService session, screenshot → chat and
  // element picker → chat. Chromium launches lazily on first open.
  const browserOutput = vscode.window.createOutputChannel("IDE Agent Browser");
  context.subscriptions.push(browserOutput);
  const browserTabs = new BrowserTabManager(
    context,
    {
      output: browserOutput,
      // REVERIFY-P2-3 (H2): route through the editor-tab-aware host so
      // chips land in the open chat editor tab, not the hidden sidebar.
      postImageToChat: (filePath, label, dataUrl) => {
        const host = makeChatAttachHost(tabs);
        host.postToWebview({ type: "addImageContext", filePath, label, dataUrl });
        void host.focusChatView();
      },
      postElementToChat: (label, content) => {
        const host = makeChatAttachHost(tabs);
        host.postToWebview({ type: "addSelectionContext", label, content });
        void host.focusChatView();
      },
    },
    () => vscode.workspace.getConfiguration("ide.browser").get<string>("chromiumPath", ""),
  );
  browserTabsRef = browserTabs;
  context.subscriptions.push({ dispose: () => void browserTabs.dispose() });

  // ---- Native browser → IDE Agent chat bridge (Cursor parity) -------------
  // The fork's native Integrated Browser (WebContentsView tab) routes its
  // chat attachments here when `ide.browser.chatTarget` is `ideAgent`
  // (see workbench core patch in browserEditorChatFeatures.ts). Payloads are
  // plain JSON; images arrive base64-encoded and are written to the captures
  // dir so they resolve as real file attachments on submit, like the
  // webview-tab screenshot flow.
  // DEV-GAPS-55: dispatch lives in services/nativeBrowserChatReceiver.ts
  // (vscode-free, unit-tested) — including the two new kinds from GAPS-46:
  // `voiceInput` (Design Mode mic transcript → submit on the active composer,
  // queued while a turn runs per the "queue changes by voice" REA spec) and
  // `designAnnotation` (annotated PNG → image chip; its region list arrives
  // as a companion 'element' payload → text context).
  function attachNativeBrowserImage(imageBase64: string, label: string): void {
    try {
      const dir = browserCaptureDir();
      fs.mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, screenshotFilename());
      fs.writeFileSync(filePath, Buffer.from(imageBase64, "base64"));
      const dataUrl = `data:image/png;base64,${imageBase64}`;
      // REVERIFY-P2-3 (H2): editor-tab-aware host, not the sidebar.
      makeChatAttachHost(tabs).postToWebview({ type: "addImageContext", filePath, label, dataUrl });
    } catch (err) {
      void vscode.window.showWarningMessage(`IDE Agent: could not save browser image (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  context.subscriptions.push(
    vscode.commands.registerCommand("ide.browserAttachToChat", (payloads: NativeBrowserChatAttachment[]) => {
      if (!Array.isArray(payloads) || payloads.length === 0) {
        return;
      }
      // REVERIFY-P2-3 (H2): route all attachments through the editor-tab-aware host.
      const host = makeChatAttachHost(tabs);
      for (const p of payloads) {
        dispatchNativeBrowserChatAttachment(
          {
            postSelectionContext: (label, content) =>
              host.postToWebview({ type: "addSelectionContext", label, content }),
            saveBrowserImage: (imageBase64, label) => attachNativeBrowserImage(imageBase64, label),
            isAgentTurnActive: () => {
              const composer = tabs.activeComposer;
              return composer.isRunning || composer.isDraining;
            },
            submitPrompt: (text, { queue }) =>
              tabs.activeComposer.submit(text, { sendMode: queue ? "queue" : "default" }),
          },
          p,
        );
      }
      // DEV-GAPS-55: voiceInput carries `preserveFocus` semantics (the user is
      // mid-dictation in the browser — the mic must stay usable while the
      // agent runs). Focusing the chat surface here would yank focus out of
      // the browser; skip it for voice batches.
      const hasVoiceInput = payloads.some((p) => p != null && p.kind === "voiceInput");
      if (!hasVoiceInput) {
        void host.focusChatView();
      }
    }),
  );

  // ---- 1. Commands -------------------------------------------------------
  for (const cmd of COMMANDS) {
    switch (cmd.id) {
      case "ide.terminalRunBackground":
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, () => void terminal.runBackgroundCommand()),
        );
        break;
      case "ide.openSettings":
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, () => {
            void vscode.commands.executeCommand("workbench.action.openSettings", "@ext:ide-code.ide-agent");
          }),
        );
        break;
      case "ide.openDocs":
        // IDE-CODE: Settings IA parity (Cursor "Docs" nav item opens
        // cursor.com/docs externally — it is a nav link, not a section).
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, () => {
            void vscode.env.openExternal(
              vscode.Uri.parse("https://github.com/chang2tech/c2t-ide"),
            );
          }),
        );
        break;
      // DEV-KEYBOARD-FIX (Cursor 3.25.9 parity):
      // - ide.focusChatInput: "Focus Chat Input" = Ctrl+I (binary C2_ weight 650 @45366917).
      //   Reveals the chat surface (sidebar view or editor tab), then moves DOM
      //   focus into the composer input via the focusInput webview message.
      case "ide.focusChatInput":
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, () => {
            void focusChatSurface(tabs).then(() => {
              makeChatAttachHost(tabs).postToWebview({ type: "focusInput" });
            });
          }),
        );
        break;
      // DEV-GAPS-3-HOTKEYS: "Focus Agent" (Cursor 3.25.9
      // composer.focusComposer parity): handleOpenComposer with
      // focusMainInputBox — reveal the chat surface, then move DOM focus into
      // the main composer input. No default keybinding, per the binary.
      case "ide.focusAgent":
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, () => {
            void focusChatSurface(tabs).then(() => {
              makeChatAttachHost(tabs).postToWebview({ type: "focusInput" });
            });
          }),
        );
        break;
      // - ide.investigateError: "Investigate Error in Chat" = Ctrl+Shift+D
      //   (binary c8a kbOpts.primary EQp @39845595). Reuses the fixWithAI flow:
      //   current file/selection + diagnostics -> agent as a fix request.
      case "ide.investigateError":
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, () => void fixWithAI(tabs, tabs.activeComposer)),
        );
        break;
      // DEV-GAPS-83 (agent-fix-with-agent-error): core
      // `editor.action.fixInAgent` (registered by the workbench
      // contribution `workbench.contrib.aiFixCodeActions`) forwards
      // (uriString, errorMessage, range, addToCurrent) here; the service
      // performs Cursor's fixLinterErrorWithAI flow against the live
      // composer (verbatim prompt, ±1/+2-line context chip, generating
      // dedupe). See services/fixWithAgentService.ts for the evidence.
      case "ide.fixWithAgent":
        context.subscriptions.push(
          vscode.commands.registerCommand(
            cmd.id,
            (uriString?: unknown, errorMessage?: unknown, range?: unknown, addToCurrent?: unknown) =>
              fixWithAgentFromCore(tabs, uriString, errorMessage, range, addToCurrent),
          ),
        );
        break;
      // - ide.reopenChatTab: "Reopen Last Closed Chat Tab" = Ctrl+Shift+T
      //   (binary @45480214). Restores the closed tab's mode + title as a new
      //   tab; the transcript is NOT restored (closeTab disposes the composer).
      case "ide.reopenChatTab":
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, () => {
            const closed = tabs.popClosedTab();
            if (!closed) {
              void vscode.window.showInformationMessage("IDE Agent: no recently closed chat tab to reopen.");
              return;
            }
            tabs.createAndActivate({ title: closed.title, mode: closed.mode });
            void focusChatSurface(tabs);
          }),
        );
        break;
      case "ide.newChat":
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, () => {
            // P1 (CX1b): real new chat — clears bubbles, checkpoints, the
            // message queue and composer state of the ACTIVE tab. Refuses
            // while a turn runs.
            // P2-2/P2-5 (QA-CHATEDITOR): this destructive clear has NO
            // keybinding (see package.json) — Ctrl+Shift+L is the
            // non-destructive "New Agent Chat" (Cursor parity). A chord must
            // never mean "destroy" in one focus and "create" in another.
            void tabs.activeComposer.newChat().then((ok) => {
              if (ok) {
                // QA-REVERIFY-2-02: reveal the chat editor tab when editor
                // tabs are ON, not the hidden sidebar.
                void focusChatSurface(tabs);
              }
            });
          }),
        );
        break;
      // DEV-GAPS-73 (chat-focus-followup, Cursor binary parity): handler
      // for the core `composer.newFollowup` ("Focus Chat Followup",
      // workbench.glass.main.js `aichat.newfollowupaction` @39814626,
      // f1:true, keybinding primary CtrlCmd+KeyY (mac: CtrlCmd+Shift+
      // KeyY) weight 410, no when-clause — i.e. focus the follow-up
      // input of the active chat). DEV-GAPS-81: the core binding now
      // matches the binary verbatim (weight 410, no when, mac chord —
      // see `newFollowupKeybindingWeight` in composerActions.ts; at 410
      // with no when it outranks editor Redo's CtrlCmd+KeyY at
      // EditorCore weight, exactly Cursor's resolution).
      // This command previously fell into the
      // default branch and only showed the dead `notifyScaffold` popup
      // (remeasure: "handler-less trap"). The fork's composer has ONE
      // input — the same element Cursor's follow-up input designates —
      // and the webview's `focusInput` message is exactly the mechanism
      // `ide.focusChatInput` / `ide.focusAgent` already use to move DOM
      // focus into it, after revealing the configured chat surface.
      //
      // Binary run (@39814626, DEV-GAPS-81 re-verified by direct binary
      // read): resolve selected composer (skip worktree) →
      // updateComposerData {editingBubbleId: undefined,
      // selectedBubbleId: undefined} → handleOpenComposer
      // ({insertSelection: true, focusMainInputBox: true}).
      // Fork mapping of the two extra behaviors:
      //  - clear editing/selected bubble: NO fork counterpart — the fork
      //    composer has no bubble-editing state (no editingBubbleId /
      //    selectedBubbleId anywhere in ComposerDataService or the
      //    webview), so there is nothing to clear; not invented.
      //  - insertSelection: the fork's selection-context chip
      //    (`addSelectionContext`, the K-07 mechanism) — a non-empty
      //    active-editor selection is attached before focusing, quietly
      //    (no "select code first" nag: the binary inserts only when a
      //    selection exists). The binary checks terminal focus first
      //    and inserts the terminal selection in that case; the fork
      //    has no reliable terminal-focus API (see addToChat.ts P1-2),
      //    so the terminal origin is a documented gap, not guessed.
      //  - worktree skip: the fork has no worktree chat tabs; the active
      //    tab is the selected composer.
      case "ide.newFollowup":
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, () => {
            void focusChatSurface(tabs).then(() => {
              const host = makeChatAttachHost(tabs);
              const editor = vscode.window.activeTextEditor;
              if (editor && !editor.selection.isEmpty) {
                const { label, content } = buildEditorSelectionLabel(
                  realVscodeSeam,
                  editor.document,
                  editor.selection,
                );
                host.postToWebview({ type: "addSelectionContext", label, content });
              }
              host.postToWebview({ type: "focusInput" });
            });
          }),
        );
        break;
      // Doc-gap B8: chat tabs are real now (ChatTabService) — new/next/
      // previous/select/close are wired, not scaffolds.
      case "ide.newAgentChat":
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, () => {
            // P1-3 (QA-CHATEDITOR): gated on ide.chat.openAsEditorTabs —
            // OFF opens the new tab in the legacy stacked sidebar view.
            tabs.createAndActivate({ mode: "agent" });
            // QA-REVERIFY-2-02: shared helper — the new tab is now active,
            // so its editor-tabs branch reveals it (identical to the old
            // inline if/else).
            void focusChatSurface(tabs);
          }),
        );
        break;
      // WORKER-GAPS-22A (agent-new-agent-command-family): runtime of the
      // workbench-core `glass.newAgent*` family (Cursor 3.25.9 parity).
      case "ide.newAgent":
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, (rawArgs?: unknown) => {
            void newAgent(tabs, sanitizeNewAgentArgs(rawArgs));
          }),
        );
        break;
      case "ide.newAgentWithModel":
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, (modelId?: unknown) => {
            // Binary-verbatim guard (glass.newAgentWithModel run):
            // non-string or blank modelId is a no-op.
            if (typeof modelId !== "string" || modelId.trim().length === 0) {
              return;
            }
            void newAgentWithModel(tabs, modelId);
          }),
        );
        break;
      case "ide.newProjectSubagent":
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, (rawArgs?: unknown) => {
            void newProjectSubagent(tabs, sanitizeNewAgentArgs(rawArgs));
          }),
        );
        break;
      case "ide.toggleChatAsEditor":
        // P3-11 (QA-CHATEDITOR): real implementation — was a dead scaffold
        // (notifyScaffold popup) with three live keybindings. Flips
        // ide.chat.openAsEditorTabs and migrates the current surface.
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, async () => {
            const cfg = vscode.workspace.getConfiguration("ide.chat");
            const current = cfg.get<boolean>("openAsEditorTabs", true);
            await cfg.update("openAsEditorTabs", !current, vscode.ConfigurationTarget.Global);
            if (!current) {
              await openChatEditor(tabs, undefined, tabs.activeTab.id);
            } else {
              await vscode.commands.executeCommand("ideAgent.chatView.focus");
            }
            void vscode.window.showInformationMessage(
              `IDE Agent: new chats will now open as ${!current ? "editor tabs" : "the sidebar view"}.`,
            );
          }),
        );
        break;
      // DEV-FULLSCREEN-COMPOSER (Cursor 3.25.9 parity): binary-verified
      // glass.enterEditorPanelFullscreen / glass.exitEditorPanelFullscreen
      // (both Ctrl/Cmd+Shift+M; Ctrl/Cmd+Shift+I is DevTools in Cursor).
      case "ide.openFullscreenComposer":
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, () => void enterFullscreenComposer(tabs)),
        );
        break;
      case "ide.exitFullscreenComposer":
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, () => void exitFullscreenComposer(tabs)),
        );
        break;
      case "ide.nextChatTab":
      case "ide.selectNextChat":
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, () => {
            tabs.nextTab();
            // QA-REVERIFY-2-02: reveal the chat editor tab, not the sidebar.
            void focusChatSurface(tabs);
          }),
        );
        break;
      case "ide.previousChatTab":
      case "ide.selectPreviousChat":
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, () => {
            tabs.previousTab();
            // QA-REVERIFY-2-02: reveal the chat editor tab, not the sidebar.
            void focusChatSurface(tabs);
          }),
        );
        break;
      case "ide.closeChatTab":
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, () => {
            const active = tabs.activeTab;
            void tabs.closeTab(active.id);
          }),
        );
        break;
      case "ide.cancelAgentStep":
        // W65D (chat-cancel-generation-shortcut): runtime of the
        // binary-verbatim `composer.cancelComposerStep` /
        // `composer.cancelComposerStepInputFocused` ("Cancel Chat",
        // Ctrl/Cmd+Shift+Backspace, workbench.glass.main.js 3.25.9
        // @39862622/@39865699). Binary run: resolve the selected
        // composer; if the tab service would show the cancel affordance
        // (shouldShowCancel) -> trackEvent("composer.cancel_chat",
        // {composerId, source:"cmd_backspace"}) + cancelCurrentStep; else
        // if the view would show accept/reject-all -> rejectAll. Fork
        // port: a running turn -> abort the step (the fork's
        // cancelCurrentStep; no prompt restore — the binary does not
        // restore the query, unlike the Stop button's
        // abort({restoreQuery:true})). The fork's engine applies file
        // edits directly (no pending accept/reject-all suggestion
        // state), so that branch is a documented silent no-op — never
        // invented.
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, (arg?: unknown) => {
            const composer = tabs.activeComposer;
            if (!composer.isRunning) {
              return;
            }
            // The binary's trackEvent payload, logged inspectably (no
            // fake analytics service in the fork). DEV-GAPS-64/W64E: the
            // core actions forward their binary source ("cmd_backspace"
            // for composer.cancelComposerStep, "winctrl_c" for
            // composer.cancelComposerStepInputFocused); composer.cancelChat
            // forwards no source and the binary logs nothing for it.
            const telemetrySource =
              typeof arg === "object" && arg !== null
                ? (arg as { telemetrySource?: unknown }).telemetrySource
                : undefined;
            if (telemetrySource === "cmd_backspace" || telemetrySource === "winctrl_c") {
              if (!cancelChatTelemetryChannel) {
                cancelChatTelemetryChannel = vscode.window.createOutputChannel("IDE Agent");
              }
              cancelChatTelemetryChannel.appendLine(
                `[telemetry] composer.cancel_chat composerId=${tabs.activeTab.id} source=${telemetrySource}`,
              );
            }
            composer.abort();
          }),
        );
        break;
      // DEV-GAPS-66/W66A (agent-accept-pending-decisions): runtime of the
      // binary-verbatim `composer.acceptComposerStep` ("Accept pending
      // agent pane action", workbench.glass.main.js 3.25.9 class LAb
      // @39863346):
      //   const s = r ? n.getPendingUserDecisionGroup(r) : [];
      //   if (s.length > 0) { for (const o of s) o.accept(); return }
      //   e.acceptNotification()
      // — the binary uses the RAW selectedComposerId (no resolve), and the
      // active chat tab is the fork's "selected composer". The group is
      // accepted UNCONDITIONALLY (no per-item filtering) — exactly like the
      // binary; the empty-group fallback is acceptNotification()
      // (documented no-op in the fork: no host-owned composer notification
      // service). No warnings on empty selection / no handle — the binary
      // silently falls through to the notification path.
      case "ide.acceptComposerStep":
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, () => {
            const composer = tabs.activeComposer;
            const group = composer.getPendingUserDecisionGroup();
            if (group.length > 0) {
              for (const decision of group) {
                decision.accept();
              }
              return;
            }
            composer.acceptNotification();
          }),
        );
        break;
      // DEV-GAPS-56 (agent-resume-chat): runtime of the binary-verbatim
      // `composer.resumeCurrentChat` ("Resume Current Chat",
      // workbench.glass.main.js 3.25.9, class CAb — palette-HIDDEN, NO
      // keybinding; the run-34 audit's f1:!0 is BÁC BỎ):
      //   async run(t,e){const n=t.get(L0),i=t.get(no),r=t.get($r),
      //     s=i.selectedComposerId;
      //     if(s){const o=i.getHandleIfLoaded(s);
      //       if(!o){r.warn("Cannot resume: composer not loaded");return}
      //       try{n.resumeChat(o,{isAutoResume:e?.isAutoResume===!0})}
      //       catch(a){r.warn(a instanceof Error?a.message:"Cannot resume")}}}
      // The fork's active chat tab is the "selected composer".
      // CORRECTION (2026-10-20, REA spec rea-spec-accept-resume-2026-10-20):
      // the binary warns through $r=Qn("notificationService").warn() — the
      // core `composer.resumeCurrentChat` Action2 owns that warn, so this
      // runtime lets errors PROPAGATE (it no longer logs them itself) and the
      // core maps them to notification warnings exactly like the binary's
      // catch.
      //
      // Fork port of the binary's ComposerChatService.resumeChat (glass
      // @20423725). Binary-verified guard: throw verbatim "Cannot resume:
      // chat not found" when the composer holds no conversation data (the
      // fork's bubble transcript is the conversation data). The post-guard
      // body is NOT statically recoverable (truncated @20423725); the
      // internal auto-resume call site @20410301 shows it continues an
      // interrupted turn. The fork resumes by re-submitting the last human
      // message so the engine continues the conversation; a turn already in
      // flight (or draining its follow-ups) is a silent no-op. isAutoResume
      // is accepted and passed through without downstream inference (spec:
      // "chỉ pass-through, không suy diễn downstream").
      case "ide.resumeCurrentChat":
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, (arg?: { isAutoResume?: unknown }) => {
            const composer = tabs.activeComposer;
            if (!composer) {
              throw new Error("Cannot resume: composer not loaded");
            }
            const bubbles = composer.bubbles.getAllInOrder();
            if (bubbles.length === 0) {
              throw new Error("Cannot resume: chat not found");
            }
            if (composer.isRunning || composer.isDraining) {
              return;
            }
            const lastHuman = [...bubbles].reverse().find((b) => b.role === "human");
            if (lastHuman) {
              composer.submit(lastHuman.text);
            }
          }),
        );
        break;
      // W69C (changes-tab-base-branch-menu): runtime of the
      // binary-verbatim `cursor.openBranchMenu` ("Open Branch Menu",
      // workbench.glass.main.js 3.25.9, class JXl @27418580):
      //   const s = n.selectedComposerId;
      //   !s || !n.getComposerDataIfLoaded(s) ||
      //     !i.isComposerConversationEmpty(s) ||
      //     r.fireDidRequestOpenBranchMenu({composerId:s})
      // The core Action2 already resolved the selection + loaded guards
      // (active/open chat editor); the fork's selected composer is the
      // active chat tab, which always holds loaded data, so the remaining
      // binary guard here is the conversation-empty check. Every failure
      // is a SILENT no-op — this command never warns (binary-verbatim).
      // The fired event is consumed by the branch-selector handler
      // registered at activation (BranchMenuService).
      case "ide.openBranchMenu":
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, () => {
            const composer = tabs.activeComposer;
            if (!composer) {
              return;
            }
            if (!composer.isComposerConversationEmpty()) {
              return;
            }
            branchMenu.fireDidRequestOpenBranchMenu({
              composerId: tabs.activeTab.id,
            });
          }),
        );
        break;
      // DEV-GAPS-73 (chat-tab-close-actions): runtime of the core
      // `composer.clearComposerTabs` ("Close All Tabs", ViewTitle
      // '0_chatManage' order 3) and `composer.closeOtherComposerTabs`
      // ("Close Other Tabs", f1:true, ViewTitle menu order 2) —
      // binary-verbatim ids/titles (Cursor 3.25.9 glass @39825552 /
      // @39862165; `f1:!0` = true). The service reuses
      // per-tab closeTab semantics; the running-tab confirm dialog
      // (DEV-GAPS-81) fires from closeTab itself, so nothing extra is
      // shown here.
      case "ide.closeAllChatTabs":
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, () => {
            void tabs.closeAllChatTabs();
          }),
        );
        break;
      // DEV-GAPS-56 (deeplink-prompt-prefill, Cursor 3.25.9 parity):
      // runtime of the binary-verbatim `deeplink.prompt.prefill`
      // (extensions/cursor-deeplink/dist/main.js, 3.25.9, route `Xs`).
      // The ide-deeplink extension executes this after its text validation
      // (Vs) and workspace routing; the payload is { text, mode? } with
      // mode from the 3.25.9 `mode` query param. Prefill-only: the text
      // lands in the chat input (webview `prefill` message, user reviews
      // and sends) — never auto-submits. The mode is applied to the
      // active composer before prefill (ModeService.setMode never throws;
      // unknown ids default to "agent").
      case "deeplink.prompt.prefill":
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, (arg?: { text?: unknown; mode?: unknown }) => {
            const text = typeof arg?.text === "string" ? arg.text : "";
            if (!text) {
              return;
            }
            if (typeof arg?.mode === "string" && arg.mode) {
              tabs.activeComposer.modes.setMode(arg.mode);
            }
            void (async () => {
              await focusChatSurface(tabs);
              makeChatAttachHost(tabs).postToWebview({ type: "prefill", text });
            })();
          }),
        );
        break;
      case "ide.closeOtherChatTabs":
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, () => {
            void tabs.closeOtherTabs(tabs.activeTab.id);
          }),
        );
        break;
      case "ide.openInlinePrompt":
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, () => void inlineEdit.openPrompt()),
        );
        break;
      case "ide.acceptInlineEdit":
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, () => inlineEdit.accept()),
        );
        break;
      case "ide.rejectInlineEdit":
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, () => void inlineEdit.reject()),
        );
        break;
      case "ide.cancelInlineEditGeneration":
        // WORKER-GAPS-34C (inline-edit-command-ids): web/aux fallback for the
        // core `editor.action.inlineDiffs.cancelEdits` (weight 600). Palette-
        // hidden (package.json `menus.commandPalette`) — the canonical
        // user-facing command is the core `editor.action.inlineDiffs.*` one.
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, () => inlineEdit.cancelGeneration()),
        );
        break;
      case "ide.acceptPartialInlineEdit":
        // PARTIAL-DIFF (Cursor parity): accept only the current hunk.
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, () => void inlineEdit.acceptPartial()),
        );
        break;
      case "ide.rejectPartialInlineEdit":
        // PARTIAL-DIFF (Cursor parity): reject only the current hunk.
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, () => void inlineEdit.rejectPartial()),
        );
        break;
      case "ide.nextInlineChange":
        // PARTIAL-DIFF (Cursor parity): Alt+J — next pending change.
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, () => inlineEdit.nextChange()),
        );
        break;
      case "ide.previousInlineChange":
        // PARTIAL-DIFF (Cursor parity): Alt+K — previous pending change.
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, () => inlineEdit.previousChange()),
        );
        break;
      case "ide.nextInlineDiffFile":
        // PARTIAL-DIFF (Cursor parity): Alt+L — next diff file (single-session
        // model: graceful no-op with an info message for now).
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, () => inlineEdit.nextDiffFile()),
        );
        break;
      case "ide.previousInlineDiffFile":
        // PARTIAL-DIFF (Cursor parity): Alt+H — previous diff file.
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, () => inlineEdit.previousDiffFile()),
        );
        break;
      case "ide.focusEditorFromDiff":
        // K-20 (Cursor parity): return focus to the editor while the inline
        // prompt bar / diff preview is open. Bound to Ctrl/Cmd+K only while an
        // inline edit is pending, so the stock chord prefix is untouched.
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, () => {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
              void vscode.window.showTextDocument(editor.document, {
                viewColumn: editor.viewColumn,
                preserveFocus: false,
              });
            }
          }),
        );
        break;
      case "ide.addSelectionToInlinePrompt":
        // K-08 (Cursor parity): attach the current editor selection to the
        // next inline edit prompt (Ctrl/Cmd+Shift+K), then open the prompt.
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, () => {
            if (attachPendingSelection()) {
              void vscode.commands.executeCommand("ide.openInlinePrompt");
            }
          }),
        );
        break;
      case "ide.sendToAgent":
        // C8 (Cursor parity): escalate the inline task into a full agent turn.
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, () => void inlineEdit.escalateToAgent()),
        );
        break;
      case "ide.submitInlinePromptToChat":
        // F2-A (2026-10-20): core inline-edit bridge — the workbench-core
        // IInlineEditService escalates an inline prompt ("Send to Chat" mode
        // / composer.sendToAgent) through this command. Same behavior as the
        // extension's own prefillChat: submit to the ACTIVE composer, then
        // focus the chat surface.
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, (text?: unknown) => {
            if (typeof text === "string" && text.length > 0) {
              tabs.activeComposer.submit(text);
              return focusChatSurface(tabs);
            }
            return undefined;
          }),
        );
        break;
      case "ide.openModeMenu":
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, () => void pickMode(tabs.activeComposer)),
        );
        break;
      case "ide.cycleMode": {
        // P3 (QA-PLANMODE-01): hidden from the palette because it is
        // registered programmatically here with NO contributes.commands
        // entry in package.json — not "f1:false" (that's a menus-
        // contribution property, not applicable).
        // Shift+Tab rotates Agent → Plan → Debug → Multitask → Ask → ….
        // Registered programmatically only, so it never appears in the palette.
        const doCycle = () => {
          const next = cycleMode(tabs.activeComposer.modes.getMode());
          tabs.activeComposer.modes.setMode(next);
          // QA-REVERIFY-2-02: reveal the chat editor tab, not the sidebar.
          void focusChatSurface(tabs);
        };
        context.subscriptions.push(vscode.commands.registerCommand(cmd.id, doCycle));
        break;
      }
      case "ide.setAgentMode":
      case "ide.setPlanMode":
      case "ide.setAskMode":
      case "ide.setDebugMode":
      case "ide.setMultitaskMode": {
        // Cursor parity: palette commands "X Mode" (glassCategory "Mode").
        const target: ModeName =
          cmd.id === "ide.setAgentMode"
            ? "agent"
            : cmd.id === "ide.setPlanMode"
              ? "plan"
              : cmd.id === "ide.setAskMode"
                ? "chat"
                : cmd.id === "ide.setDebugMode"
                  ? "debug"
                  : "multitask";
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, () => {
            tabs.activeComposer.modes.setMode(target);
            // QA-REVERIFY-2-02: reveal the chat editor tab, not the sidebar.
            void focusChatSurface(tabs);
          }),
        );
        break;
      }
      case "ide.startMultitasking":
        // DEV-MULTITASK: Cursor's queue-tray "Start Multitasking" button
        // (spec §4.1: startMultitasking({entrypoint:"queue_tray"}) then
        // submits the first queue item; failure string verbatim below).
        // The multitask flow itself starts when the user submits in
        // multitask mode, so this switches the mode and reveals the chat
        // surface for the request.
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, () => {
            try {
              // entrypoint: "queue_tray" (Cursor tracks
              // composer.multitask_mode.entry_point — §4.1).
              tabs.activeComposer.modes.setMode("multitask");
              // QA-REVERIFY-2-02: reveal the chat editor tab, not the sidebar.
              void focusChatSurface(tabs);
            } catch {
              void vscode.window.showErrorMessage("Failed to start multitasking.");
            }
          }),
        );
        break;
      case "ide.acceptPlan":
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, () => void tabs.activeComposer.acceptPlan()),
        );
        break;
      case "ide.toggleSandboxDebugLogging":
        // W-DEV1 (2026-10-20): bridge for core `composer.toggleSandboxDebugLogging`.
        // Core now replicates Cursor (storage key `sandboxDebugOutputDir`,
        // workbench.desktop.main.js @29974171); the `composer.sandbox.debugLogging`
        // config no longer exists. Core passes the new enabled state explicitly;
        // with no arg we toggle the flag. Fork-only step: Cursor's sandbox is
        // in-core, ours still lives here in the extension host.
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, (enabled?: boolean) => {
            const next = typeof enabled === "boolean" ? enabled : !isSandboxDebugLogging();
            setSandboxDebugLogging(next);
          }),
        );
        break;
      case "ide.openModelPicker":
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, () => void pickModel(tabs.activeComposer)),
        );
        break;
      case "ide.cycleModel":
        // M-09 (real): rotate to the next ENABLED model (skips models
        // disabled via ide.agent.enabledModels), switch it on the engine,
        // and announce it in the status bar + composer header.
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, () => void cycleModel(tabs.activeComposer)),
        );
        break;
      // DEV-GAPS-29 (Cursor 3.25.9 binary: run `lhw() ||
      // executeCommand(cycleModel)`): try cycling the focused model-parameter
      // target in the window first (the binary's `isCycleableByHotkey &&
      // count > 1` lookup over model.parameterDefinitions — see services/
      // modelParameterService.ts); if nothing is cycleable, fall back to
      // cycling the model.
      case "ide.cycleModelParameter":
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, () => {
            void cycleFocusedModelParameter(tabs.activeComposer, context.globalState).then((cycled) => {
              if (!cycled) {
                void vscode.commands.executeCommand("ide.cycleModel");
              }
            });
          }),
        );
        break;
      case "ide.manageModels":
        // M-04 (real): checkbox UI for ide.agent.enabledModels.
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, () => void manageModels(tabs.activeComposer, tabs)),
        );
        break;
      case "ide.generateGitCommitMessage":
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, () => void generateGitCommitMessage(tabs.activeComposer)),
        );
        break;
      case "ide.restoreCheckpoint":
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, () => void restoreCheckpoint(tabs.activeComposer)),
        );
        break;
      case "ide.approveShellTool":
      case "ide.approveShellToolAllowlist":
      case "ide.skipShellTool": {
        const optionId =
          cmd.id === "ide.approveShellTool"
            ? "approve-once"
            : cmd.id === "ide.approveShellToolAllowlist"
              ? "approve-allowlist"
              : "skip";
        // Cursor parity (rXs in the glass bundle): run/allowlist refocus the
        // composer input after deciding; skip leaves focus where it is.
        const refocusComposer = cmd.id !== "ide.skipShellTool";
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, () => {
            const reviews = tabs.activeComposer.reviews;
            const current = reviews.currentApproval;
            if (!current) {
              void vscode.window.showInformationMessage(
                "IDE Agent: no pending tool approval to respond to.",
              );
              return;
            }
            reviews.resolveApproval(current.approvalId, { optionId });
            if (refocusComposer) {
              void focusChatSurface(tabs).then(() => {
                makeChatAttachHost(tabs).postToWebview({ type: "focusInput" });
              });
            }
          }),
        );
        break;
      }
      // GAPS-14 (agent-shell-approval-keyboard-flow): `ide.cancelTerminalToolCall`
      // is the runtime target of core `composer.cancelTerminalToolCall`
      // (Shift+Backspace). Mirrors Cursor's run body: reject the pending
      // RUN_TERMINAL_COMMAND_V2 decisions first (then return); otherwise
      // cancel the running terminal tool call. No-ops with an info message
      // when neither is present.
      case "ide.cancelTerminalToolCall":
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, () => {
            const reviews = tabs.activeComposer.reviews;
            const pendingShell = reviews.getPendingApprovals().filter(isShellToolApproval);
            // GAPS-14: binary run-body order (glass bundle 3.25.6) — reject
            // pending RUN_TERMINAL_COMMAND_V2 decisions first, else cancel
            // the running terminal stream.
            const target = decideCancelTerminalTarget({
              hasPendingShellApproval: pendingShell.length > 0,
              hasActiveRun: terminal.hasActiveRun(),
            });
            if (target === "reject-pending-approval") {
              for (const req of pendingShell) {
                reviews.resolveApproval(req.approvalId, { optionId: "skip" });
              }
            } else if (target === "cancel-running-call") {
              terminal.cancelActiveRun();
            } else {
              void vscode.window.showInformationMessage(
                "IDE Agent: no running terminal tool call to cancel.",
              );
            }
          }),
        );
        break;
      case "ide.fixWithAI":
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, () => void fixWithAI(tabs, tabs.activeComposer)),
        );
        break;
      // WORKER-GAPS-42D (bugbot-auto-review): binary-verbatim
      // `cursor.runEditorBugbot` — the auto-run-on-commit entry dispatched by
      // the commit trigger with (rootUri, headRef). Reviews the repo branch
      // at headRef, gated on the `autoRunBugbotOnCommit` storage flag +
      // `bugbot_autorun_killswitch` (Cursor 3.25.9, byte 41777801).
      case BUGBOT_RUN_EDITOR_REVIEW_COMMAND_ID:
        context.subscriptions.push(
          registerBugbotReviewCommand(context, () => tabs.activeComposer, bugbotReviewHistory, (line) =>
            ideOutput.appendLine(line),
          ),
        );
        break;
      // DEV-GAPS-15 (bugbot-remaining-commands): binary-verbatim
      // `cursor.openBugbotPane` (Cursor 3.25.6) — opens the Bugbot pane
      // listing the latest review runs (real history, no fabricated
      // findings). HONEST-DIVERGENCE: the title is INFERRED.
      case BUGBOT_OPEN_PANE_COMMAND_ID:
        context.subscriptions.push(registerOpenBugbotPaneCommand(bugbotReviewHistory));
        break;
      // DEV-GAPS-15: binary-verbatim `cursor.reviewBugbotFromAd` (Cursor
      // 3.25.6) — ad/CTA entry point; same real review flow as
      // `cursor.runEditorBugbot` with its own telemetry route
      // `bug_bot.ad_review_cta_route` (event name INFERRED from the
      // DEV-GAPS-10 pattern — not binary-verified).
      case BUGBOT_REVIEW_FROM_AD_COMMAND_ID:
        context.subscriptions.push(
          registerBugbotFromAdCommand(context, () => tabs.activeComposer, bugbotReviewHistory, (line) =>
            ideOutput.appendLine(line),
          ),
        );
        break;
      // WORKER-GAPS-42D: binary-verbatim `cursor.enableAutoReviewOnCommit`
      // (Cursor 3.25.9, byte 41781073) — unconditionally enables the
      // `autoRunBugbotOnCommit` storage flag + telemetry
      // `bug_bot.autorun_on_commit_toggled` {enabled, source:"in_app_ad"}.
      // (The old quickpick toggle misread the binary and was removed.)
      case BUGBOT_ENABLE_AUTO_REVIEW_COMMAND_ID:
        context.subscriptions.push(
          registerBugbotAutoReviewEnableCommand(context, (line) =>
            ideOutput.appendLine(line),
          ),
        );
        break;
      // DEV-GAPS-65 (cursor-install-cli): `cursor.installCli` handler body
      // @36708706 — guard on `cliDetectionStatus.agentStatus`, else Panel
      // terminal + verbatim `curl https://cursor.com/install -fsS | bash`.
      case INSTALL_CLI_COMMAND_ID:
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, () => void runInstallCliCommand(context)),
        );
        break;
      case "ide.addToChat":
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, (rawArgs?: unknown) =>
            addToChat(tabs, sanitizeAddToChatArgs(rawArgs)),
          ),
        );
        break;
      // Cursor parity: chat title context menu (chat editor tabs).
      case "ide.copyRequestId":
      case "ide.giveFeedback":
      case "ide.renameChat":
      case "ide.forkChat":
      case "ide.pinChat":
      case "ide.unpinChat":
      case "ide.openAgentSettings":
      case "ide.shareChat":
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, (uri?: vscode.Uri) =>
            runChatTitleCommand(cmd.id, tabs, uri),
          ),
        );
        break;
      // Cursor parity: Customize editor tab (workbench.action.openCustomizeEditor).
      case "ide.openCustomize":
      case "workbench.action.openCustomizeEditor":
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, () => {
            if (customizeEditorProviderRef) {
              void openCustomizeEditor(customizeEditorProviderRef);
            } else {
              void vscode.window.showWarningMessage("IDE Agent: Customize view is not ready yet.");
            }
          }),
        );
        break;
      case "workbench.action.customize.openPlugins":
      case "workbench.action.customize.openMCPs":
      case "workbench.action.customize.openSkills":
      case "workbench.action.customize.openSubagents":
      case "workbench.action.customize.openRules":
      case "workbench.action.customize.openCommands":
      case "workbench.action.customize.openHooks": {
        const entry = (Object.entries(CUSTOMIZE_OPEN_TAB_COMMANDS) as Array<[CustomizeSectionId, string]>).find(
          ([, commandId]) => commandId === cmd.id,
        );
        const tab: CustomizeSectionId = entry ? entry[0] : "plugins";
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, () => {
            if (customizeEditorProviderRef) {
              void openCustomizeEditor(customizeEditorProviderRef, tab);
            } else {
              void vscode.window.showWarningMessage("IDE Agent: Customize view is not ready yet.");
            }
          }),
        );
        break;
      }
      case "ide.terminalAiCommand":
        // K-14 (Cursor parity): Cmd/Ctrl+K in the terminal. Delegates to
        // TerminalService.openTerminalPrompt: Enter sends the request to the
        // agent with terminal context; the insert button puts text into the
        // terminal without running it (Cursor's "Escape accepts").
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, () => void terminal.openTerminalPrompt()),
        );
        break;
      case "ide.searchConversations":
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, () => void searchConversations(tabs.activeComposer, tabs)),
        );
        break;
      case "aiCodeTracking.resetDailyStats":
        // DD-SB-7: Cursor palette command (category "AI Code Tracking",
        // title "Reset AI Code Tracking Stats") — resets all live counters.
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, () => {
            tracking.resetDailyStats();
          }),
        );
        break;
      case "ide.worktreeCommand":
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, () => void worktreeFlow(new WorktreeService())),
        );
        break;
      case "ide.listWorktrees":
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, () => void listWorktrees(new WorktreeService())),
        );
        break;
      case "ide.deleteWorktree":
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, () => void deleteWorktreeFlow(new WorktreeService())),
        );
        break;
      case "ide.applyWorktree":
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, () => void applyWorktreeFlow(new WorktreeService())),
        );
        break;
      // FIND-IN-CHAT (QA "declared, no handler" fix): the chat surface is a
      // webview — the VS Code native find widget cannot search inside it, so
      // the find bar is owned by the webview (components/composer.ts). The
      // host just tells the ACTIVE chat surface (sidebar or editor tab) to
      // show/hide it. Keybindings (Ctrl/Cmd+F / Escape, when: chatSurface)
      // live in workbench core composerActions.ts and delegate to these
      // commands; the when-clause is disjoint from the editor's
      // editorTextFocus, so there is no conflict with editor find.
      case "ide.findInChat":
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, () => {
            // Mirror ide.focusChatInput: reveal the surface first (command-
            // palette path), then ask the webview to show the bar.
            void focusChatSurface(tabs).then(() => {
              showFindInChat(makeChatAttachHost(tabs));
            });
          }),
        );
        break;
      case "ide.hideFindInChat":
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, () => {
            // The webview hides the bar and returns DOM focus to the
            // composer input. No reveal needed — hiding a hidden bar is a
            // harmless no-op.
            hideFindInChat(makeChatAttachHost(tabs));
          }),
        );
        break;
      // DEV-GAPS-29: binary-verbatim `composer.find.next` /
      // `composer.find.previous` ("Find Next/Previous in Chat", F3/Enter and
      // Shift+F3/Shift+Enter, when composerFindWidgetFocused). The host
      // forwards the intent to the active surface's webview, which owns the
      // match highlights; a closed bar makes these harmless no-ops.
      case "ide.findNextInChat":
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, () => {
            findNextInChat(makeChatAttachHost(tabs));
          }),
        );
        break;
      case "ide.findPreviousInChat":
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, () => {
            findPreviousInChat(makeChatAttachHost(tabs));
          }),
        );
        break;
      // DEV-GAPS-10: Changes tab (Cursor `glass.openChangesTab` parity,
      // audit-fix-queue run 24). The real UI lives in workbench core
      // (`composer.openChangesTab`); the extension command normalizes the
      // binary-verbatim args and delegates, mirroring the
      // `ide.openBrowserTab` -> `workbench.action.browser.open` precedent.
      case "ide.openChangesTab":
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, (args?: unknown) =>
            void vscode.commands.executeCommand(
              CHANGES_TAB_COMMAND_IDS.core,
              normalizeOpenChangesTabArgs(args),
            ),
          ),
        );
        break;
      // WORKER-GAPS-36D (rules-user): Cursor knowledge-base commands,
      // binary-verified in 3.25.9 — editor.action.knowledgeBase.add
      // ("Add User Rule") and editor.action.knowledgeBase.list
      // ("View User Rules"), keybinding category "knowledge_base". Global
      // User Rules applied to every Agent Chat turn.
      case "editor.action.knowledgeBase.add":
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, () => void addUserRuleFlow(tabs)),
        );
        break;
      case "editor.action.knowledgeBase.list":
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, () => void viewUserRulesFlow(tabs)),
        );
        break;
      default:
        // Browser tab commands (registered above in COMMANDS).
        if (cmd.id === "ide.openBrowserTab" || cmd.id === "ide.openBrowser") {
          // IDE-CODE: open the NATIVE Integrated Browser tab (WebContentsView,
          // Cursor-equivalent) instead of the legacy webview screencast tab.
          context.subscriptions.push(
            vscode.commands.registerCommand(cmd.id, (url?: string) =>
              void vscode.commands.executeCommand(
                "workbench.action.browser.open",
                typeof url === "string" ? url : undefined,
              ),
            ),
          );
        } else if (cmd.id === "ide.browserTab.newTab") {
          context.subscriptions.push(
            vscode.commands.registerCommand(cmd.id, () => void browserTabs.newTab()),
          );
        } else if (cmd.id === "ide.browserTab.reloadTab") {
          context.subscriptions.push(
            vscode.commands.registerCommand(cmd.id, () => void browserTabs.reload()),
          );
        } else if (cmd.id === "ide.browserTab.focusOmnibar") {
          context.subscriptions.push(
            vscode.commands.registerCommand(cmd.id, () => browserTabs.focusOmnibar()),
          );
        } else if (cmd.id === "ide.browserTab.screenshotToChat") {
          context.subscriptions.push(
            vscode.commands.registerCommand(cmd.id, () => void browserTabs.captureToChat()),
          );
        } else if (cmd.id === "ide.browserTab.togglePicker") {
          context.subscriptions.push(
            vscode.commands.registerCommand(cmd.id, () => browserTabs.togglePicker()),
          );
        } else if (cmd.id === "ide.browserTab.captureAreaScreenshot") {
          context.subscriptions.push(
            vscode.commands.registerCommand(cmd.id, () => browserTabs.startAreaSelect()),
          );
        } else if (cmd.id === "ide.browserTab.hardReload") {
          context.subscriptions.push(
            vscode.commands.registerCommand(cmd.id, () => void browserTabs.hardReload()),
          );
        } else if (cmd.id === "ide.browserTab.copyCurrentUrl") {
          context.subscriptions.push(
            vscode.commands.registerCommand(cmd.id, () => void browserTabs.copyCurrentUrl()),
          );
        } else if (cmd.id === "ide.browserTab.zoomIn") {
          context.subscriptions.push(
            vscode.commands.registerCommand(cmd.id, () => void browserTabs.zoomStep("in")),
          );
        } else if (cmd.id === "ide.browserTab.zoomOut") {
          context.subscriptions.push(
            vscode.commands.registerCommand(cmd.id, () => void browserTabs.zoomStep("out")),
          );
        } else if (cmd.id === "ide.browserTab.zoomReset") {
          context.subscriptions.push(
            vscode.commands.registerCommand(cmd.id, () => void browserTabs.zoomStep("reset")),
          );
        } else if (cmd.id === "ide.browserTab.clearBrowsingData") {
          context.subscriptions.push(
            vscode.commands.registerCommand(cmd.id, () => void browserTabs.clearBrowsingDataMenu()),
          );
        } else if (cmd.id === "ide.browserTab.openDevTools") {
          context.subscriptions.push(
            vscode.commands.registerCommand(cmd.id, () => void browserTabs.openDevTools()),
          );
        } else {
          context.subscriptions.push(
            vscode.commands.registerCommand(cmd.id, () => notifyScaffold(cmd)),
          );
        }
        break;
    }
  }

  // WORKER-GAPS-38D (`agent-chat-export`): transcript provider for the
  // workbench's binary-verbatim `composer.exportChatAsMd` command. The core
  // action owns the command id, the Markdown algorithm, the save dialog and
  // the notification; it asks here for the transcript because the extension
  // owns the chat data (ChatTabService).
  context.subscriptions.push(
    vscode.commands.registerCommand(
      GET_CHAT_EXPORT_TRANSCRIPT_COMMAND,
      (tabId?: unknown): ChatExportTranscript | undefined => {
        const id = typeof tabId === "string" && tabId.length > 0 ? tabId : undefined;
        const tab = id ? tabs.listTabs().find((t) => t.id === id) : undefined;
        const resolved = tab ?? resolveChatEditorTab(tabs);
        return resolved ? chatTabToExportTranscript(resolved) : undefined;
      },
    ),
  );

  // WORKER-GAPS-66A (`chat-tab-title-menu-inventory`): request-id provider
  // for the workbench's binary-verbatim `composer.copyRequestId` command
  // (workbench.desktop.main.js @29931829, class a2S: it reads the request id
  // then `clipboard.writeText(id ?? "No request ID found")`). The core action
  // owns the command id, the target resolution (`{kind:"composerId"|"editor"|"pane"}`)
  // and the clipboard write; it asks here for the id because the extension
  // owns the chat data (ChatTabService).
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ide.getChatRequestId",
      (tabId?: unknown): string | undefined => {
        const id = typeof tabId === "string" && tabId.length > 0 ? tabId : undefined;
        const tab = id ? tabs.listTabs().find((t) => t.id === id) : undefined;
        const resolved = tab ?? resolveChatEditorTab(tabs);
        return resolved ? lastChatRequestId(resolved) : undefined;
      },
    ),
  );

  // WORKER-GAPS-66A (`chat-tab-title-menu-inventory`): runtime target of the
  // core action `composer.openPromptQuality` (binary-verbatim id, Cursor
  // 3.25.9 @29785997; internal-gated in the title menu). Opens the fork's
  // prompt-quality review panel (services/promptQualityService.ts) for the
  // active chat tab's current human prompt.
  context.subscriptions.push(
    vscode.commands.registerCommand("ide.openPromptQualityPanel", async (): Promise<void> => {
      const tab = resolveChatEditorTab(tabs);
      const prompt = tab
        ? (() => {
          const human = tab.composer.bubbles.getAllInOrder().filter((b) => b.role === "human");
          const lastBubble = human[human.length - 1];
          return typeof lastBubble?.text === "string" ? lastBubble.text : "";
        })()
        : "";
      if (!prompt.trim()) {
        void vscode.window.showInformationMessage(
          "IDE Agent: no prompt to review yet — ask the agent something first.",
        );
        return;
      }
      const panel = vscode.window.createWebviewPanel(
        "ide.promptQuality",
        "Prompt Quality",
        vscode.ViewColumn.One,
        { enableScripts: false },
      );
      panel.webview.html = buildPromptQualityPanelHtml(prompt, scorePrompt(prompt));
    }),
  );

  // ---- 2. Chat participant (@ide) ----------------------------------------
  // Zero-placeholder (was a canned scaffold reply): @ide now runs a real
  // turn against the ide-code sidecar engine, streaming the model's text
  // into the VS Code chat response.
  const participant = vscode.chat.createChatParticipant(
    "ide.agent",
    async (
      request: vscode.ChatRequest,
      _chatContext: vscode.ChatContext,
      stream: vscode.ChatResponseStream,
      token: vscode.CancellationToken,
    ): Promise<void> => {
      const engineCfg = vscode.workspace.getConfiguration("ide.agent");
      if (engineCfg.get<string>("engineMode", "sidecar") !== "sidecar") {
        // Honest precondition (mirrors InlineEditService): the participant
        // needs the real engine + a configured model to generate.
        stream.markdown(
          "**IDE Agent** — `@ide` needs the ide-code engine. Set `ide.agent.engineMode` to `\"sidecar\"` and configure a model, then try again.",
        );
        return;
      }
      const output = vscode.window.createOutputChannel("IDE Agent Chat Participant");
      const adapter = new IdeCodeEngineAdapter({
        enginePath: engineCfg.get<string>("enginePath", "") || defaultEnginePath(),
        output,
        // The chat-participant surface has no approval UI: tool calls that
        // need approval are rejected ("skip"), reads still run. @ide answers
        // and reads the workspace for real, but never mutates it — edits
        // stay in the sidebar where the approval cards live.
        requestApproval: () => Promise.resolve({ optionId: "skip" }),
      });
      token.onCancellationRequested(() => adapter.abortTurn());
      try {
        stream.progress("IDE Agent working…");
        for await (const ev of adapter.runTurn({
          prompt: request.prompt,
          mode: "agent",
          bubbleId: "ide-chat-participant",
        })) {
          if (ev.type === "textDelta") {
            stream.markdown(ev.delta);
          } else if (ev.type === "thinking") {
            stream.progress(ev.text);
          }
          // toolCall / questionApproval / turnSettled: no card UI exists on
          // this surface — the streamed text is what the user sees.
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        stream.markdown(`\n\n**IDE Agent error:** ${message}`);
      } finally {
        adapter.dispose();
      }
    },
  );
  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "icon.svg");
  context.subscriptions.push(participant);

  // ---- 3. Chat webview view ----------------------------------------------
  const chatProvider = new ChatViewProvider(context, tabs, terminal, slash);
  activeChatView = chatProvider;
  context.subscriptions.push(vscode.window.registerWebviewViewProvider("ideAgent.chatView", chatProvider));

  // ---- 3b. Model status bar item (M-09) ------------------------------------
  // Shows the ACTIVE TAB's agent model; clicking opens the model picker.
  // Updates live via modelChanged events from any tab plus tab switches, so
  // the bar never shows a stale model.
  const modelStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  modelStatusBar.command = "ide.openModelPicker";
  const refreshModelStatusBar = (selection: ModelSelection): void => {
    modelStatusBar.text = `$(zap) ${selection.label}`;
    modelStatusBar.tooltip = `IDE Agent model: ${selection.label} — click to change`;
    modelStatusBar.show();
  };
  refreshModelStatusBar(tabs.activeComposer.models.getSelection());
  context.subscriptions.push(
    modelStatusBar,
    tabs.onDidChange((tabEvent) => {
      if (tabEvent.kind === "tabsChanged") {
        refreshModelStatusBar(tabs.activeComposer.models.getSelection());
      } else if (tabEvent.event.kind === "modelChanged") {
        // Only the active tab drives the bar — a background tab's model
        // change refreshes when the user switches to it.
        if (tabEvent.tabId === tabs.activeTab.id) {
          refreshModelStatusBar(tabEvent.event.selection);
        }
      }
    }),
  );

  // ---- 4. Sessions tree view (empty until the engine creates sessions) -----
  const sessionsProvider = new SessionsProvider();
  context.subscriptions.push(vscode.window.registerTreeDataProvider("ideAgent.sessionsView", sessionsProvider));

  // ---- 4b. Chat Inbox tree view (Cursor Inbox CONCEPT parity: "what needs
  // attention" — the STANDALONE tree-view SURFACE is TEAM DESIGN, see
  // HONEST-DIVERGENCE in src/services/chatInboxService.ts) --------------------
  // Aggregates REAL state only: pending tool-call approvals
  // (HumanReviewService), unanswered clarifying questions
  // (ComposerDataService.getPendingQuestions) and running agent turns
  // (ComposerDataService.isRunning) across chat tabs. Evidence and
  // HONEST-DIVERGENCE notes live in src/services/chatInboxService.ts —
  // notably "PRs in review" is NOT included: the changelog mentions it but
  // no wiring to the inbox was found in the Cursor 3.25.9 binary (UNKNOWN).
  const inbox = new ChatInboxService(tabs);
  context.subscriptions.push(inbox);
  const inboxProvider = new ChatInboxTreeProvider(inbox);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("ideAgent.inboxView", inboxProvider),
    inboxProvider,
    vscode.commands.registerCommand("ideAgent.inbox.revealTab", (tabId: string) => {
      // Switch to the tab that needs the user, then focus the chat view so
      // the approval card / question widget / running turn is visible.
      if (typeof tabId === "string" && tabs.switchTab(tabId)) {
        void vscode.commands.executeCommand("ideAgent.chatView.focus");
      }
    }),
  );

  // ---- 4c. Onboarding checklist tree view (DEV-GAPS-5-ONBOARDING) ----------
  // Cursor's aiserver.v1.OnboardingChecklistService (verified in shipped
  // 3.25.9) is: listable, completable, dismissible items, separate from the
  // first-run onboarding flow. The default items are OUR OWN (Cursor does
  // not publish its list — see HONEST-DIVERGENCE in
  // src/services/onboardingChecklistService.ts). `createTreeView` (not
  // registerTreeDataProvider) is used so checkbox toggles flow through
  // onDidChangeCheckboxState. The view contribution is gated on the
  // `ide.onboarding.showChecklist` config (package.json) so the user can
  // re-show the checklist after finishing it.
  const onboarding = new OnboardingChecklistService(context);
  context.subscriptions.push(onboarding);
  const onboardingProvider = new OnboardingChecklistTreeProvider(onboarding);
  const onboardingView = vscode.window.createTreeView("ideAgent.onboardingChecklist", {
    treeDataProvider: onboardingProvider,
    showCollapseAll: false,
    canSelectMany: false,
  });
  onboardingView.onDidChangeCheckboxState((e) => {
    // e.items: ReadonlyArray<[element, checkboxState]>.
    for (const [element, checkboxState] of e.items) {
      const node = element as OnboardingTreeNode;
      const id = node.node === "item" && typeof node.item.id === "string" ? node.item.id : undefined;
      if (!id) continue;
      if (checkboxState === vscode.TreeItemCheckboxState.Checked) {
        void onboarding.completeItem(id);
      } else {
        void onboarding.uncompleteItem(id);
      }
    }
  });
  context.subscriptions.push(
    onboardingView,
    onboardingProvider,
    vscode.commands.registerCommand("ide.onboarding.showChecklist", () => {
      void vscode.commands.executeCommand("ideAgent.onboardingChecklist.focus");
    }),
    vscode.commands.registerCommand("ide.onboarding.resetChecklist", () => {
      void onboarding.resetChecklist();
    }),
    vscode.commands.registerCommand("ide.onboarding.completeItem", (itemId: string) => {
      // Called from the tree item click / inline button with the item id as
      // the argument. Guard the argument so a stray invocation never touches
      // real state (service itself also ignores unknown ids).
      if (typeof itemId === "string") {
        void onboarding.completeItem(itemId);
      }
    }),
    vscode.commands.registerCommand("ide.onboarding.dismissItem", (itemId: string) => {
      if (typeof itemId === "string") {
        void onboarding.dismissItem(itemId);
      }
    }),
  );

  // ---- 5. Default context keys for the contributed when-clauses ------------
  // P3 (QA-FILE-07): the four dead keys (promptBarVisible, promptBarFocused,
  // composerFocused, subagentTabsVisible) were removed — nothing ever sets
  // them true, and no when clause references them.
  const defaults: Array<[string, boolean]> = [
    ["ideAgent.chatInputFocused", false],
    ["ideAgent.toolApprovalVisible", false],
    // DEV-GAPS-12 (agent-shell-approval-keyboard-flow): gates the core
    // `composer.approvePendingShellToolDecision` (Enter) /
    // `composer.approvePendingShellToolDecisionAllowlist` (Shift+Enter) /
    // `composer.skipPendingShellToolDecision` (Esc) keybindings; set by the
    // approval subscription above while a shell-tool approval is pending.
    ["ideAgent.shellToolPendingKeybindingsActive", false],
    ["ideAgent.shellToolAllowlistShortcutActive", false],
    // GAPS-14 (agent-shell-approval-keyboard-flow): gates core
    // `composer.cancelTerminalToolCall` (Shift+Backspace); set by
    // TerminalService while a terminal tool call runs.
    ["ideAgent.terminalToolCallRunning", false],
    // DEV-FULLSCREEN-COMPOSER: mirrors the VERBATIM Cursor context key
    // `glassEditorPanelFullscreen` (binary workbench.glass.main.js 3.25.9;
    // read by the `glass.enterEditorPanelFullscreen` /
    // `glass.exitEditorPanelFullscreen` keybinding `when` clauses in core).
    ["glassEditorPanelFullscreen", false],
  ];
  for (const [key, value] of defaults) {
    void vscode.commands.executeCommand("setContext", key, value);
  }

  // ---- Tab completion engine ----
  // P2 (QA-04-VERIFY): surface activation failures instead of letting them
  // become unhandled rejections that silently disable Tab.
  // DEV-HOOKS: the Tab engine gets the hook service for beforeTabFileRead /
  // afterTabFileEdit (Cursor parity).
  // TAB-BACKEND: Tab reuses the active chat tab's engine adapter — the SAME
  // sidecar process (dedicated tab session inside it). It never spawns its
  // own engine. In stub engine mode the getter resolves a non-engine and Tab
  // stays honestly silent ("no model backend", no fake suggestions).
  activateTab(context, hookService, {
    getEngineAdapter: () => tabs.activeComposer.getEngineAdapter(),
  }).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    void vscode.window.showWarningMessage(`IDE Agent: Tab completion failed to activate (${message}).`);
  });

  // DEV-HOOKS: workspaceOpen (app-lifecycle hook, Cursor parity). Runs after
  // activation completes. pluginPaths in hook output: this build has no
  // plugin host, so the paths are recorded in the execution log, not loaded.
  if (hookService.hasHooks("workspaceOpen")) {
    void hookService
      .runHooks("workspaceOpen", {
        workspaceRoots: vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [],
      })
      .then((r) => {
        if (r.pluginPaths.length > 0) {
          hooksOutput.appendLine(
            `[hooks] workspaceOpen returned pluginPaths (${r.pluginPaths.join(", ")}) — no plugin host in this build; recorded only.`,
          );
        }
      })
      .catch(() => {});
  }

  // DEV-GAPS-34 (hooks-21-events): workspaceOpen "fires once when Cursor
  // opens a workspace and again on every workspace folder change. Skipped
  // when the window has zero workspace folders." (cursor.com/docs/hooks).
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      const roots = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
      if (roots.length === 0) {
        return; // docs: skipped when the window has zero workspace folders
      }
      if (hookService.hasHooks("workspaceOpen")) {
        void hookService
          .runHooks("workspaceOpen", { workspaceRoots: roots })
          .catch(() => {});
      }
    }),
  );

  // ---- Agents Window (F7 fix 2026-10-20) ----
  // Opens/focuses the IDE's dedicated Agents ("glass") window via the core
  // `ide.openOrFocusGlassWindow` command — the analog of Cursor's
  // `cursor.openOrFocusGlassWindow` (binary evidence in
  // src/vs/workbench/contrib/composer/electron-browser/glassWindowActions.ts).
  // Must NEVER delegate to the stock `workbench.action.openAgentsWindow`
  // (the VS Code Copilot-style agent-sessions window,
  // `INativeHostService.openAgentsWindow`, precondition
  // `chat.agent.enabled`) — opening that window was finding F7.
  context.subscriptions.push(
    vscode.commands.registerCommand("ide.openAgentsWindow", (...args: unknown[]) => {
      const rawArgs = args[0] as { agentsWindowOpenSource?: unknown } | undefined;
      const agentsWindowOpenSource =
        typeof rawArgs?.agentsWindowOpenSource === "string"
          ? rawArgs.agentsWindowOpenSource
          : "ide_extension_open_agents_window";
      return vscode.commands.executeCommand("ide.openOrFocusGlassWindow", {
        agentsWindowOpenSource,
      });
    })
  );

  // ---- Subagent preview tray (WORKER-GAPS-11D) ----
  // Cursor `glass.openSubagentPreviewInAgentsTray` parity ("Open subagent
  // preview in agents tray", palette-hidden f1:!1, glassCategory Agent).
  // Validates args against Cursor's schema, opens/focuses the Agents Window
  // (the "agents tray" surface), and emits
  // `openSubagentPreviewInAgentsTrayRequested` for tray consumers.
  // See subagentPreviewService.ts for binary evidence + HONEST-DIVERGENCE.
  const subagentPreviews = new SubagentPreviewService({
    executeCommand: (cmd, args) => vscode.commands.executeCommand(cmd, args),
  });
  context.subscriptions.push(
    vscode.commands.registerCommand(
      OPEN_SUBAGENT_PREVIEW_IN_AGENTS_TRAY_COMMAND,
      (rawArgs: unknown) => subagentPreviews.requestPreview(rawArgs),
    ),
    subagentPreviews,
  );

  // ---- Desktop bridge (ide-code desktop ls|send parity, spec §3.1/§5 P2) ---
  // Unix-socket HTTP server the `ide-code desktop` CLI talks to:
  // ~/.ide-code/desktop-bridge/instance-<pid>.json advertises the socket +
  // 64-hex bearer token. Started last so every service it reads (chat tabs)
  // is already up; failures are surfaced, never silent.
  const desktopBridge = new DesktopBridgeServer({
    chatTabs: tabs,
    appVersion: context.extension.packageJSON?.version ?? "0.1.0-alpha",
    userDataDir: context.globalStorageUri?.fsPath ?? "",
  });
  desktopBridgeServerRef = desktopBridge;
  desktopBridge.start().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    void vscode.window.showWarningMessage(
      `IDE Agent: desktop bridge failed to start (${message}) — "ide-code desktop" will not see this instance.`,
    );
  });

  // Extension exports: the `cursor.*` API surface (Cursor parity).
  return { cursor: cursorApi };
}

async function pickMode(composer: ComposerDataService): Promise<void> {
  // Cursor parity: the mode dropdown lists exactly plan/debug/multitask/ask
  // (Ask = wire id "chat"); Agent is the implicit default, not listed.
  const picked = await vscode.window.showQuickPick(
    DROPDOWN_MODES.map((id) => {
      const def = modeDef(id);
      return { label: def.label, description: def.description, id: def.id };
    }),
    { placeHolder: "Select agent mode" },
  );
  if (picked) {
    composer.modes.setMode(picked.id);
  }
}

/**
 * M-03 (model picker): real picker with engine backend wiring.
 *
 * Opens a QuickPick grouped by provider (vscode.QuickPickItemKind.Separator),
 * built from the engine's live model catalog (GET /api/model). The choice:
 *   1. is switched on the engine immediately via adapter.setModel
 *      (POST /api/session/:id/model for live sessions; recorded for future
 *      session.create calls), and
 *   2. is persisted per workspace (workspaceState) and shown in the composer
 *      model button (modelChanged event → webview).
 *
 * When the engine has no model catalog (scripted stub), the picker says so
 * honestly instead of presenting a fake list.
 */
/** Chat UI settings snapshot sent to the webview (baked at render + live updates). */
export interface IdeChatUiConfig {
  /** Text size scale for chat messages (mirrors cursor.composer.textSizeScale). */
  textSizeScale: number;
  /** Tool-call card display density (mirrors cursor.composer.conversationDensity). */
  conversationDensity: "compact-all-grouped" | "compact-ungrouped" | "detailed";
  /** Wrap long lines in chat code blocks. */
  codeBlockWordWrap: boolean;
  /** Show rotating tips on the empty chat screen. */
  showEmptyStateTips: boolean;
  /** Grayscale antialiased text rendering in the chat view. */
  fontSmoothingAntialiased: boolean;
  /** Cmd/Ctrl+P opens the file picker in the chat input. */
  cmdPFilePicker: boolean;
  /** Max width of agent conversations in px (mirrors cursor.composer.chatMaxWidth).
   *  Always normalized to [600, 1600] by normalizeChatWidth; default 900 is
   *  our choice — Cursor's canonical default is UNKNOWN (see chatWidthService). */
  chatMaxWidth: number;
}

/**
 * WORKER-GAPS-24C: canonicalize a raw `ide.composer.conversationDensity`
 * value to one of the 3 changelog levels. Mirrors Cursor 3.25.6
 * (workbench.glass.main.js): normalizeDensity passes through the known
 * values, "verbose"→"detailed", "minimal"→"compact-all-grouped", and
 * unknown→"compact-all-grouped"; the SNv settings migration maps legacy
 * "compact-shells"→"compact-ungrouped" (Balanced) and
 * "compact-grouped"→"compact-all-grouped" (Compact).
 */
export function normalizeConversationDensity(
  raw: unknown,
): "compact-all-grouped" | "compact-ungrouped" | "detailed" {
  switch (raw) {
    case "detailed":
      return "detailed";
    case "compact-shells": // legacy "Diff Focus" → Balanced
    case "compact-ungrouped":
      return "compact-ungrouped";
    case "compact-grouped": // legacy "Grouped" → Compact
    case "compact-all-grouped":
    case "minimal":
      return "compact-all-grouped";
    case "verbose":
      return "detailed";
    default:
      return "compact-all-grouped";
  }
}

/** Read the chat UI settings into a webview-safe snapshot. */
export function readChatUiConfig(): IdeChatUiConfig {
  const composer = vscode.workspace.getConfiguration("ide.composer");
  const general = vscode.workspace.getConfiguration("ide.general");
  const scale = composer.get<number>("textSizeScale", 1);
  const density = composer.get<string>("conversationDensity", "compact-all-grouped");
  return {
    textSizeScale: [0.85, 1, 1.15, 1.3].includes(scale) ? scale : 1,
    // WORKER-GAPS-24C: canonicalize the density at the config boundary.
    // Mirrors Cursor 3.25.6 (workbench.glass.main.js): normalizeDensity
    // passes through the 5 known values, maps "verbose"→"detailed",
    // "minimal"→"compact-all-grouped", and falls back to
    // "compact-all-grouped" for anything else; the SNv migration maps
    // legacy "compact-shells"→Balanced and "compact-grouped"→Compact so
    // the webview only ever sees the 3 changelog levels.
    conversationDensity: normalizeConversationDensity(density),
    codeBlockWordWrap: composer.get<boolean>("codeBlockWordWrap", false),
    showEmptyStateTips: composer.get<boolean>("showEmptyStateTips", true),
    fontSmoothingAntialiased: general.get<boolean>("fontSmoothingAntialiased", true),
    cmdPFilePicker: composer.get<boolean>("cmdPFilePicker2", true),
    // CHAT-WIDTH: normalizeChatWidth clamps hand-edited values to
    // [600, 1600] and falls back to our 900px default for non-numbers.
    chatMaxWidth: normalizeChatWidth(composer.get<unknown>("chatMaxWidth", 900)),
  };
}

/** M-04: read the enabled-models allowlist (empty = all enabled). */
function getEnabledModels(): string[] {
  const raw = vscode.workspace.getConfiguration("ide.agent").get<unknown>("enabledModels", []);
  if (!Array.isArray(raw)) return [];
  return raw.filter((e): e is string => typeof e === "string");
}

/**
 * P1 (QA-MODELPICKER-01): shared selection↔allowlist reconciliation.
 *
 * The current model selection must always be allowed by
 * `ide.agent.enabledModels`. When the selected model is no longer enabled
 * (disabled via Manage Models, hand-edited in settings.json, or persisted
 * while the extension was off), switch the engine to "auto" FIRST (best
 * effort — even if the engine rejects it, the UI must not point at a disabled
 * model) and reset the selection. Returns true when it changed anything.
 *
 * Callers: manageModels (after writing the setting), the
 * `ide.agent.enabledModels` config-change listener, and once at startup
 * (covers the persisted-selection restore path).
 *
 * Named export (not module-private) ONLY so the Round B lock-in tests
 * (run-roundb-lockin-tests.ts, RB-X3 items 1+2) can exercise the real
 * reconcile path; nothing else in the extension imports it.
 */
export async function reconcileSelectionWithAllowlist(composer: ComposerDataService): Promise<boolean> {
  const allowlist = getEnabledModels();
  const current = composer.models.getSelection();
  // Virtual selectors ("auto"/"cursor-default") are automatic, never a fixed
  // model, so they can never be "disabled" by the allowlist — only an
  // explicit ref needs the check.
  if (selectionKind(current) !== "explicit" || (current.ref && isModelEnabled(current.ref, allowlist))) {
    return false;
  }
  const adapter = composer.getEngineAdapter();
  if (typeof adapter.setModel === "function") {
    try {
      await adapter.setModel(undefined);
    } catch (err) {
      // Best effort: the engine keeps its (disabled) model, but the UI still
      // falls back to auto so it never lies about what will be used.
      const message = err instanceof Error ? err.message : String(err);
      // P2 (QA-MODELPICKER Round-B): say exactly what happened — the switch
      // failed for the CURRENT live session (its cached engine session still
      // runs the disabled model), while new sessions are created with
      // selectedModel cleared (setModel records undefined BEFORE the throw in
      // ideCodeEngineAdapter.ts), so they are safe.
      void vscode.window.showWarningMessage(
        `IDE Agent: could not switch the engine to auto after disabling "${current.label}" — ${message}. ` +
          "The engine switch failed for the current live session, which may still use the disabled model. " +
          "New sessions are safe — details in the IDE Agent output channel.",
      );
    }
  }
  composer.models.setSelection(autoSelection());
  return true;
}

/**
 * P1 (QA-MODELPICKER Round-B): reconcile EVERY tab's selection against the
 * allowlist, not just the active tab's. Each tab owns its own
 * ComposerDataService + IdeCodeEngineAdapter with an independent
 * `selectedModel` (`chatTabService.ts`), and `switchTab` doesn't re-validate —
 * so disabling a model while tab B is in the background left tab B's engine
 * on the disabled model, burning real money on tab B's next turn.
 *
 * Chosen over turn-time validation inside the engine adapter: the allowlist is
 * extension-level config (`ide.agent.enabledModels`) while the adapter is the
 * per-tab engine client — keeping the check in the extension layer avoids a
 * config read on the hot turn path and keeps a single change point where the
 * allowlist can mutate (manageModels, the config-change listener, startup).
 *
 * Returns the previous label of every tab whose selection changed, for honest
 * reporting ("which tabs were affected").
 *
 * Named export (not module-private) ONLY so the Round B lock-in tests
 * (run-roundb-lockin-tests.ts, RB-X3 item 1) can exercise the real multi-tab
 * path; nothing else in the extension imports it.
 */
export async function reconcileAllTabsWithAllowlist(
  tabs: ChatTabService,
): Promise<Array<{ tabId: string; previousLabel: string }>> {
  const changed: Array<{ tabId: string; previousLabel: string }> = [];
  for (const tab of tabs.listTabs()) {
    const previousLabel = tab.composer.models.getSelection().label;
    if (await reconcileSelectionWithAllowlist(tab.composer)) {
      changed.push({ tabId: tab.id, previousLabel });
    }
  }
  return changed;
}

/**
 * Shared engine model loading for the picker / cycler / manager.
 * Returns undefined (after showing the reason) when the catalog is unavailable.
 */
async function loadEngineModels(
  composer: ComposerDataService,
  title: string,
): Promise<EngineModelInfo[] | undefined> {
  const adapter = composer.getEngineAdapter();
  if (typeof adapter.listModels !== "function" || typeof adapter.setModel !== "function") {
    void vscode.window.showInformationMessage(
      `IDE Agent: ${title} needs the real engine — set ide.agent.engineMode to "sidecar" (turns currently run against a scripted stub).`,
    );
    return undefined;
  }
  try {
    const models = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "IDE Agent: loading models from the engine…" },
      () => adapter.listModels!(),
    );
    if (models.length === 0) {
      void vscode.window.showWarningMessage(
        "IDE Agent: the engine returned no models. Check the IDE Agent output channel.",
      );
      return undefined;
    }
    return models;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(
      `IDE Agent: could not load models from the engine — ${message}. See the IDE Agent output channel.`,
    );
    return undefined;
  }
}

export async function pickModel(composer: ComposerDataService): Promise<void> {
  const models = await loadEngineModels(composer, "the model picker");
  if (!models) return;
  const adapter = composer.getEngineAdapter();
  const enabledModels = getEnabledModels();
  const disabledCount = models.length - filterEnabledModels(models, enabledModels).length;

  const current = composer.models.getSelection();
  const currentValue = selectionValue(current);
  interface ModelPickItem extends vscode.QuickPickItem {
    /** Picker entry value: "auto" | "cursor-default" | ref wire form. */
    value: string;
    ref?: ModelRef;
  }
  // P1 (DEV-MODEL-PICKER-ENTRIES): entries come from buildModelPickerEntries —
  // "Auto" + "Cursor Default" virtual selectors first (Cursor parity), then
  // the enabled engine catalog.
  const items: ModelPickItem[] = buildModelPickerEntries(models, enabledModels).map((e) => ({
    label: e.label,
    description: e.description,
    detail: e.value === currentValue ? "(current)" : undefined,
    value: e.value,
    ...(e.ref ? { ref: e.ref } : {}),
  }));

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder:
      disabledCount > 0
        ? `Select model for agent turns (${disabledCount} hidden by ide.agent.enabledModels)`
        : "Select model for agent turns",
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) {
    return;
  }
  // Virtual selectors resolve to the engine default (the adapter treats
  // ref undefined = automatic; the selection KIND stays distinct so the
  // button/label honestly shows what the user picked). Cursor's server-side
  // "Auto" smart routing has no local equivalent — honest gap, see report.
  const selection: ModelSelection =
    picked.value === CURSOR_DEFAULT_VALUE
      ? cursorDefaultSelection()
      : picked.value === AUTO_MODEL_VALUE || !picked.ref
        ? autoSelection()
        : { kind: "explicit", ref: picked.ref, label: picked.label };
  // Switch on the engine FIRST; persist + notify the webview only on success,
  // so the composer never shows a model the engine rejected.
  try {
    await adapter.setModel!(selection.ref);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`IDE Agent: the engine rejected the model switch — ${message}.`);
    return;
  }
  composer.models.setSelection(selection);
  void vscode.window.showInformationMessage(
    selection.ref
      ? `IDE Agent: model set to "${selection.label}". Applies to new turns immediately.`
      : selectionKind(selection) === "cursor-default"
        ? 'IDE Agent: model set to Cursor Default for new turns; existing sessions keep their model until a new chat.'
        : 'IDE Agent: model set to Auto for new turns; existing sessions keep their model until a new chat.',
  );
}
/**
 * DEV-GAPS-29 (chat-cycle-model-parameter fix, 2026-10-20): real
 * implementation of Cursor 3.25.9's `lhw()` = cycleFocusedTargetInWindow.
 * Scans the current model's parameterDefinitions (services/
 * modelParameterService.ts) for `isCycleableByHotkey && options.length > 1`
 * — the binary's `isCycleableByHotkey&&count>1` lookup — and cycles the
 * first cycleable parameter to its next option (wrapping). Returns true when
 * a parameter was cycled, false when nothing is cycleable; the caller
 * (ide.cycleModelParameter) then falls back to ide.cycleModel, exactly as
 * the binary's `lhw() || executeCommand(cycleModel)` does.
 *
 * The fork's real per-model multi-option surface is the engine catalog's
 * model `variant` (e.g. thinking/non-thinking variants of the same model);
 * the value is applied via adapter.setModel (engine first, like cycleModel)
 * and persisted per model in globalState. Cursor's binary keywords
 * ("effort"/"thinking") have no counterpart in our engine catalog — no fake
 * effort levels are invented; see modelParameterService.ts.
 */
async function cycleFocusedModelParameter(
  composer: ComposerDataService,
  globalState: vscode.Memento,
): Promise<boolean> {
  const models = await loadEngineModels(composer, "the model parameter cycler");
  if (!models) {
    return false;
  }
  const current = composer.models.getSelection();
  const definitions = buildModelParameterDefinitions(models, current.ref);
  const cycleable = findCycleableParameters(definitions);
  if (cycleable.length === 0) {
    return false;
  }
  // Cursor cycles the FOCUSED parameter target in the window; this fork has
  // a single parameter surface, so the first cycleable parameter of the
  // current model is the target.
  const def = cycleable[0]!;
  const stateKey = `ideAgent.modelParameter.${current.ref!.providerID}.${current.ref!.id}.${def.id}`;
  const stored = globalState.get<string>(stateKey);
  const next = nextParameterOption(def, stored ?? current.ref!.variant);
  if (def.id === "variant") {
    const ref: ModelRef = {
      id: current.ref!.id,
      providerID: current.ref!.providerID,
      ...(next ? { variant: next } : {}),
    };
    const adapter = composer.getEngineAdapter();
    try {
      await adapter.setModel!(ref);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(
        `IDE Agent: the engine rejected the parameter switch — ${message}.`,
      );
      return false;
    }
    await globalState.update(stateKey, next);
    const info: EngineModelInfo = {
      id: ref.id,
      providerID: ref.providerID,
      name: current.label,
      ...(next ? { variant: next } : {}),
    };
    // The picker shows the bare model name, so append the cycled variant to
    // keep the header honest about which variant is active.
    const label = next ? `${ModelService.labelFor(info)} (${next})` : current.label;
    composer.models.setSelection({ kind: "explicit", ref, label });
    void vscode.window.showInformationMessage(
      `IDE Agent: ${def.label} cycled to "${next}". Applies to new turns immediately.`,
    );
    return true;
  }
  return false;
}

/**
 * M-09 (real): cycle to the next ENABLED model.
 *
 * Loads the engine catalog, skips models disabled via ide.agent.enabledModels,
 * switches the engine to the next one after the current selection (wrapping),
 * and persists the selection — the composer header model button and the
 * status bar item update via the modelChanged event. Switching happens on the
 * engine first so the UI never shows a model the engine rejected.
 *
 * P1 (DEV-MODEL-PICKER-ENTRIES): the virtual selectors ("auto"/"cursor-default")
 * are automatic — never a fixed model — so cycling from either (or from a
 * now-disabled explicit selection) restarts at the first enabled model; the
 * cycle order covers concrete models only.
 */
async function cycleModel(composer: ComposerDataService): Promise<void> {
  const models = await loadEngineModels(composer, "the model cycler");
  if (!models) return;
  const adapter = composer.getEngineAdapter();
  const enabledModels = getEnabledModels();
  const current = composer.models.getSelection();
  const next = nextEnabledModel(models, enabledModels, current.ref);
  if (!next) {
    void vscode.window.showWarningMessage(
      "IDE Agent: no enabled models to cycle to — check ide.agent.enabledModels (IDE Agent: Manage Models…).",
    );
    return;
  }
  const ref: ModelRef = {
    id: next.id,
    providerID: next.providerID,
    ...(next.variant ? { variant: next.variant } : {}),
  };
  if (ModelService.refEquals(current.ref, ref)) {
    void vscode.window.showInformationMessage(
      `IDE Agent: only one model enabled — still on "${current.label}".`,
    );
    return;
  }
  const label = ModelService.labelFor(next);
  try {
    await adapter.setModel!(ref);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`IDE Agent: the engine rejected the model switch — ${message}.`);
    return;
  }
  composer.models.setSelection({ ref, label });
  void vscode.window.showInformationMessage(
    `IDE Agent: model cycled to "${label}". Applies to new turns immediately.`,
  );
}

/**
 * M-04 (real): checkbox UI for ide.agent.enabledModels.
 *
 * Multi-select quickpick over the live engine catalog; checked = enabled.
 * Writes the exact allowlist back to the setting. When the currently selected
 * chat model ends up disabled, the selection falls back to "auto" so the
 * composer never points at a model the user just turned off.
 */
async function manageModels(composer: ComposerDataService, tabs: ChatTabService): Promise<void> {
  const models = await loadEngineModels(composer, "the model manager");
  if (!models) return;
  const enabledModels = getEnabledModels();
  interface ManageItem extends vscode.QuickPickItem {
    wire: string;
  }
  const items: ManageItem[] = models.map((m) => {
    const ref: ModelRef = {
      id: m.id,
      providerID: m.providerID,
      ...(m.variant ? { variant: m.variant } : {}),
    };
    const wire = ModelService.refToString(ref);
    return {
      label: ModelService.labelFor(m),
      description: m.name && m.name !== m.id ? m.id : m.providerID,
      wire,
      picked: isModelEnabled(ref, enabledModels),
    };
  });
  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    placeHolder: "IDE Agent: check the models to enable (uncheck to disable)",
    matchOnDescription: true,
  });
  if (!picked) return; // dismissed — keep the current setting untouched
  const next = picked.map((p) => p.wire).sort();
  // P1.5 (QA-MODELPICKER-X1) / P2 (QA-MODELPICKER-X2): unchecking everything
  // writes [] which semantically means "all enabled" — a silent surprise.
  // Make it explicit instead of quietly re-enabling everything.
  if (next.length === 0) {
    const confirm = await vscode.window.showWarningMessage(
      'IDE Agent: unchecking all models re-enables every model (an empty list means "all enabled"). Continue?',
      { modal: true },
      "Re-enable all",
      "Keep current",
    );
    if (confirm !== "Re-enable all") return; // keep the current setting untouched
  }
  // Prefer the workspace scope; fall back to global when no folder is open
  // (update() with WorkspaceTarget rejects without an open workspace).
  const target = vscode.workspace.workspaceFolders?.length
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
  await vscode.workspace.getConfiguration("ide.agent").update("enabledModels", next, target);
  // P1 (QA-MODELPICKER-01) + P1 (Round-B): reconcile via the shared helper so
  // the engine is switched to auto too — on ALL tabs, since each tab has its
  // own engine adapter. The UI must never say "auto" while any tab's engine
  // keeps burning the model the user just disabled.
  const changed = await reconcileAllTabsWithAllowlist(tabs);
  if (changed.length > 0) {
    const labels = [...new Set(changed.map((c) => c.previousLabel))]
      .map((l) => `"${l}"`)
      .join(", ");
    const tabSuffix = changed.length > 1 ? ` on ${changed.length} tabs` : "";
    void vscode.window.showInformationMessage(
      `IDE Agent: ${labels} ${changed.length > 1 ? "were" : "was"} disabled — model reset to auto${tabSuffix} (engine default).`,
    );
  } else {
    void vscode.window.showInformationMessage(
      `IDE Agent: ${next.length === 0 ? "all models enabled" : `${next.length} model(s) enabled`}.`,
    );
  }
}

async function restoreCheckpoint(composer: ComposerDataService): Promise<void> {
  // One entry per human message ("before" checkpoints only — those are what
  // restore targets; "after" checkpoints are for undo via checkoutToLatest).
  const checkpoints = composer.checkpoints.list().filter((c) => !c.isAfter);
  if (checkpoints.length === 0) {
    void vscode.window.showInformationMessage(
      "IDE Agent: no checkpoints yet — send a message first.",
    );
    return;
  }
  const picked = await vscode.window.showQuickPick(
    checkpoints.map((c) => ({
      label: c.label,
      description: c.checkpointId,
      detail: new Date(c.createdAt).toLocaleTimeString(),
      bubbleId: c.bubbleId,
    })),
    { placeHolder: "Restore conversation to checkpoint (checkout_to_message)" },
  );
  if (picked) {
    // revertToCheckpoint shows its own result/warning messages.
    await composer.revertToCheckpoint(picked.bubbleId);
  }
}

/** DEV-GAPS-65 `cursor-install-cli` (Cursor parity).
 *
 * VS Code-facing half of the binary-verbatim `cursor.installCli` handler
 * (workbench.desktop.main.js @36708706, Cursor 3.25.9). The decision logic
 * lives in `./cli-install` (node-tested); this builds the real probe deps
 * (PATH + ~/.local/bin, mirroring `checkPathForExecutables` @40635349) and
 * the real side effects: globalState persistence (Cursor persists in
 * `applicationUserPersistentStorage` under the same `cliDetectionStatus`
 * key — HONEST-DIVERGENCE), an info toast, and a Panel terminal that runs
 * the verbatim install command.
 */
async function runInstallCliCommand(context: vscode.ExtensionContext): Promise<void> {
  const probeDeps: CliProbeDeps = {
    pathEnv: process.env.PATH,
    pathDelimiter: path.delimiter,
    homeDir: os.homedir(),
    joinPath: (...parts: string[]) => path.join(...parts),
    isExecutableFile: (candidate: string) => {
      try {
        if (!fs.existsSync(candidate)) {
          return false;
        }
        if (process.platform === "win32") {
          return true;
        }
        fs.accessSync(candidate, fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
    executableVariants: (name: string) =>
      process.platform === "win32" ? [name, `${name}.exe`, `${name}.cmd`] : [name],
  };
  const refreshStatus = (): CliDetectionStatus =>
    buildCliDetectionStatus(probeCliExecutables(probeDeps), Date.now());
  await runInstallCliFlow({
    readStatus: () =>
      parseCliDetectionStatus(context.globalState.get(CLI_DETECTION_STATUS_STORAGE_KEY)),
    refreshStatus,
    writeStatus: async (status) => {
      await context.globalState.update(CLI_DETECTION_STATUS_STORAGE_KEY, status);
    },
    showAlreadyInstalled: () => {
      // HONEST-DIVERGENCE: binary toast text (nls 10693) UNKNOWN — the
      // message constant is a documented placeholder, not a verbatim string.
      void vscode.window.showInformationMessage(ALREADY_INSTALLED_MESSAGE);
    },
    runInstallInPanelTerminal: (command: string) => {
      // Binary: createTerminal({location: Panel}) → set active, show panel,
      // focus, then run the command. In VS Code ext API terms:
      // createTerminal({location: TerminalLocation.Panel}) + show() focuses
      // the panel terminal; sendText(text, true) types + executes.
      const terminal = vscode.window.createTerminal({
        name: "Install CLI",
        location: vscode.TerminalLocation.Panel,
      });
      terminal.show();
      terminal.sendText(command, true);
    },
  });
}

/** DEV-GAPS-54 `ai-commit-message-generation` (Cursor parity).
 *
 * Mirrors Cursor's `cursor.generateGitCommitMessage` pipeline
 * (cursor-always-local, Cursor 3.25.9):
 *   GetCurrentIndexAndRecentCommits({rawUris, rootPath})
 *     -> {diffs, previousCommitMessages}
 *   generateCommitMessage({diffs, previousCommitMessages, explicitContext})
 *     -> input.setValue(message)
 *
 * Flow: prefer the staged (index) change set, fall back to the working
 * tree when nothing is staged; fetch recent commit subjects as style
 * context; build the explicit context; run one composer turn and wait for
 * it; write the message into the SCM input box (falling back to an
 * offer-copy notification when the git extension API is unavailable).
 * Errors surface as notifications.
 */
async function generateGitCommitMessage(composer: ComposerDataService): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!folder) {
    void vscode.window.showInformationMessage("IDE Agent: open a workspace folder first.");
    return;
  }
  const insideRepo = (await runGit(folder, ["rev-parse", "--is-inside-work-tree"])).trim() === "true";
  if (!insideRepo) {
    void vscode.window.showInformationMessage("IDE Agent: the workspace folder is not a git repository.");
    return;
  }
  // Cursor: collects staged (index-group) OR working-tree files. Prefer the
  // index; use the working tree only when the index is empty.
  let source: CommitDiffSource = "staged";
  let diff = await runGit(folder, ["diff", "--cached", "--", "."]);
  let stat = await runGit(folder, ["diff", "--cached", "--stat", "--", "."]);
  if (!diff.trim()) {
    diff = await runGit(folder, ["diff", "--", "."]);
    stat = await runGit(folder, ["diff", "--stat", "--", "."]);
    source = "working-tree";
  }
  if (!diff.trim()) {
    void vscode.window.showInformationMessage(
      "IDE Agent: no changes to describe — modify a file or stage something first (git add).",
    );
    return;
  }
  // Recent commit messages as style reference (Cursor's
  // previousCommitMessages input). Best-effort: empty on failure.
  const previousCommitMessages = parseRecentCommitMessages(
    await runGit(folder, ["log", "--format=%s", "-n", String(COMMIT_MESSAGE_RECENT_COUNT), "--", "."]),
  );
  if (composer.isRunning) {
    void vscode.window.showWarningMessage("IDE Agent: wait for the current turn to finish first.");
    return;
  }
  const before = new Set(composer.bubbles.getOrderedIds());
  const prompt = buildCommitMessagePrompt({ diff, stat, previousCommitMessages, source });
  const message = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Generating commit message…" },
    async () => {
      composer.submit(prompt);
      return waitForNewAssistantText(composer, before, 180_000);
    },
  );
  const cleaned = cleanCommitMessage(message);
  if (!cleaned) {
    void vscode.window.showWarningMessage("IDE Agent: the agent did not produce a commit message.");
    return;
  }
  const repo = findGitRepo(folder);
  if (repo) {
    // Cursor: input.setValue(message).
    repo.inputBox.value = cleaned;
    void vscode.window.showInformationMessage(
      source === "staged"
        ? "IDE Agent: commit message generated — review it in Source Control before committing."
        : "IDE Agent: commit message generated from unstaged changes (nothing is staged) — review it in Source Control before committing.",
    );
  } else {
    const choice = await vscode.window.showInformationMessage(
      `Suggested commit message: ${cleaned}`,
      "Copy message",
    );
    if (choice === "Copy message") {
      await vscode.env.clipboard.writeText(cleaned);
    }
  }
}

/** Run git and return stdout ("" on any failure).
 * DEV-GAPS-14 `ext-git-sanitize`: URL credentials stripped, safe `-c`
 * configs forced before the subcommand. */
function runGit(cwd: string, args: string[]): Promise<string> {
  return gitExecFile(cwd, args, { timeoutMs: 15_000, maxBuffer: 4 * 1024 * 1024 }).then(
    ({ stdout }) => stdout,
    () => "",
  );
}

/** Best-effort access to the built-in git extension's API. */
function findGitRepo(
  folder: string,
): { rootUri?: vscode.Uri; inputBox: { value: string } } | undefined {
  try {
    const api = vscode.extensions.getExtension("vscode.git")?.exports?.getAPI?.(1);
    const repos = api?.repositories as Array<{ rootUri?: vscode.Uri; inputBox: { value: string } }> | undefined;
    if (!repos || repos.length === 0) return undefined;
    return repos.find((r) => r.rootUri?.fsPath === folder) ?? repos[0];
  } catch {
    return undefined;
  }
}

/**
 * Wait for the current turn to end, then return the text of the newest
 * assistant bubble created after `before` was captured.
 */
async function waitForNewAssistantText(
  composer: ComposerDataService,
  before: Set<string>,
  timeoutMs: number,
): Promise<string> {
  const start = Date.now();
  while (composer.isRunning && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 500));
  }
  const ids = composer.bubbles.getOrderedIds().filter((id) => !before.has(id));
  for (let i = ids.length - 1; i >= 0; i--) {
    const bubble = composer.bubbles.getBubbleData(ids[i]!);
    if (bubble?.role === "assistant" && bubble.text.trim()) {
      return bubble.text;
    }
  }
  return "";
}

/** K-13 (Cursor parity): Cmd/Ctrl+Shift+E — send selection/file + diagnostics to the agent to fix. */
/**
 * DEV-GAPS-83 (agent-fix-with-agent-error): handler for `ide.fixWithAgent`,
 * the extension runtime of the core `editor.action.fixInAgent` command.
 * Builds the production seam for services/fixWithAgentService.ts:
 * documents via the workspace API, dedupe against the ACTIVE composer's
 * bubbles (role "human" — the fork's BubbleRole for user bubbles),
 * new-chat via ChatTabService.createAndActivate, context chip via the
 * shared chat attach host (explicit new-tab id so the chip lands in the
 * NEW tab), submit via the target tab's composer.
 */
async function fixWithAgentFromCore(
  tabs: ChatTabService,
  uriString: unknown,
  errorMessage: unknown,
  range: unknown,
  addToCurrent: unknown,
): Promise<void> {
  if (typeof uriString !== "string" || typeof errorMessage !== "string" || !range || typeof range !== "object") {
    return;
  }
  const r = range as Partial<FixWithAgentRange>;
  if (
    typeof r.startLineNumber !== "number" || typeof r.startColumn !== "number" ||
    typeof r.endLineNumber !== "number" || typeof r.endColumn !== "number"
  ) {
    return;
  }
  let targetTabId: string | undefined;
  await fixErrorWithAgent(
    {
      uriString,
      errorMessage,
      range: {
        startLineNumber: r.startLineNumber,
        startColumn: r.startColumn,
        endLineNumber: r.endLineNumber,
        endColumn: r.endColumn,
      },
      addToCurrent: addToCurrent !== false,
    },
    {
      openDocument: async (uri) => {
        try {
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
          return {
            lineCount: doc.lineCount,
            getLines: (startLine: number, endLine: number) => {
              const from = Math.max(1, Math.min(startLine, doc.lineCount));
              const to = Math.max(from, Math.min(endLine, doc.lineCount));
              return doc.getText(
                new vscode.Range(from - 1, 0, to - 1, doc.lineAt(to - 1).range.end.character),
              );
            },
          };
        } catch {
          return undefined;
        }
      },
      lastHumanBubbleText: () => {
        const humans = tabs.activeComposer.bubbles.getAllInOrder().filter((b) => b.role === "human");
        return humans.length ? humans[humans.length - 1].text : undefined;
      },
      isGenerating: () => tabs.activeComposer.isRunning,
      createNewChat: async () => {
        const tab = tabs.createAndActivate({ mode: "agent" });
        targetTabId = tab.id;
      },
      addSelectionContext: (label: string, content: string) => {
        makeChatAttachHost(tabs, targetTabId).postToWebview({ type: "addSelectionContext", label, content });
      },
      submit: (prompt: string) => {
        const target = targetTabId
          ? tabs.listTabs().find((t) => t.id === targetTabId)?.composer
          : tabs.activeComposer;
        (target ?? tabs.activeComposer).submit(prompt);
      },
      focusChat: () => focusChatSurface(tabs),
      trackEvent: (eventName: string, data: Record<string, unknown>) => {
        if (!newAgentTelemetryChannel) {
          newAgentTelemetryChannel = vscode.window.createOutputChannel("IDE Agent");
        }
        newAgentTelemetryChannel.appendLine(
          `[telemetry] ${eventName} useCurrent=${String(data.useCurrent)} mode=${String(data.mode)}`,
        );
      },
    },
  );
}

async function fixWithAI(tabs: ChatTabService, composer: ComposerDataService): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showInformationMessage("IDE Agent: open a file to fix with AI.");
    return;
  }
  const doc = editor.document;
  const sel = editor.selection;
  const range = sel.isEmpty ? doc.validateRange(new vscode.Range(0, 0, doc.lineCount, 0)) : sel;
  const code = doc.getText(range);
  if (!code.trim()) {
    void vscode.window.showInformationMessage("IDE Agent: nothing to fix — the selection is empty.");
    return;
  }
  const diags = vscode.languages
    .getDiagnostics(doc.uri)
    .filter((d) => range.contains(d.range))
    .map((d) => `- [${vscode.DiagnosticSeverity[d.severity]}] line ${d.range.start.line + 1}: ${d.message}`);
  const prompt = [
    `Fix the following ${sel.isEmpty ? "file" : "selected code"} (${vscode.workspace.asRelativePath(doc.uri)}):`,
    "```" + (doc.languageId || ""),
    code,
    "```",
    diags.length ? `Diagnostics:\n${diags.join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  composer.submit(prompt);
  // REVERIFY-P2-3 (H2): focus the chat where the composer lives — the open
  // editor tab when editor tabs are ON, not the hidden sidebar.
  await makeChatAttachHost(tabs).focusChatView();
}

/**
 * QA-REVERIFY-2-02: shared focus helper for commands that focus the chat
 * WITHOUT attaching content to a specific tab (mode switches, tab
 * navigation, conversation search, approval review, inline-edit prefill).
 * Content routing for these is already correct (they act on
 * `tabs.activeComposer`); this only fixes the focus TARGET: when chats live
 * in editor tabs, reveal the active chat editor tab instead of yanking focus
 * to a hidden sidebar view. Reuses the same openChatAsEditorTabs logic as
 * makeChatAttachHost.focusChatView.
 */
async function focusChatSurface(tabs: ChatTabService): Promise<void> {
  if (openChatAsEditorTabs()) {
    await openChatEditor(tabs, undefined, tabs.activeTab.id);
  } else {
    await vscode.commands.executeCommand("ideAgent.chatView.focus");
  }
}

/**
 * DEV-FULLSCREEN-COMPOSER (Cursor 3.25.9 parity).
 *
 * Binary: `glass.enterEditorPanelFullscreen` ("Enter Full Screen") /
 * `glass.exitEditorPanelFullscreen` ("Exit Full Screen"), both bound to
 * Ctrl/Cmd+Shift+M with mutually exclusive `when` clauses on the fullscreen
 * state. Our surface is the chat editor tab (`ide-chat` URI scheme); the
 * "fullscreen" is the editor group maximized via the real workbench
 * commands — never a CSS/DOM fake.
 *
 * State is tracked here AND mirrored to the VERBATIM Cursor
 * `glassEditorPanelFullscreen` context key (binary workbench.glass.main.js
 * 3.25.9, `VXt`; read by the `glass.enterEditorPanelFullscreen` /
 * `glass.exitEditorPanelFullscreen` keybinding `when` clauses in core
 * composerActions.ts). Enter uses the maximize-only
 * `workbench.action.maximizeEditorHideSidebar` so re-entering (or entering
 * while the user already maximized manually) is a no-op instead of a
 * toggle-off; exit uses `workbench.action.toggleMaximizeEditorGroup` to
 * restore the previous layout.
 */
let fullscreenComposerActive = false;

async function setFullscreenComposerActive(active: boolean): Promise<void> {
  fullscreenComposerActive = active;
  // WORKER-GAPS-20C: verbatim binary key `glassEditorPanelFullscreen`
  // (supersedes the earlier `composer.fullscreenActive` analog).
  await vscode.commands.executeCommand("setContext", "glassEditorPanelFullscreen", active);
}

async function enterFullscreenComposer(tabs: ChatTabService): Promise<void> {
  if (fullscreenComposerActive) {
    return;
  }
  if (openChatAsEditorTabs()) {
    await openChatEditor(tabs, undefined, tabs.activeTab.id);
  } else {
    // Sidebar surface: open the chat as an editor tab just for this
    // fullscreen session (does NOT flip the user's ide.chat.openAsEditorTabs
    // preference); maximizing the editor group only makes sense for a tab.
    await vscode.commands.executeCommand(
      "vscode.openWith",
      chatEditorUriForTab(tabs.activeTab.id),
      CHAT_EDITOR_VIEW_TYPE,
    );
  }
  await vscode.commands.executeCommand("workbench.action.maximizeEditorHideSidebar");
  await setFullscreenComposerActive(true);
  // Move DOM focus into the composer input once the tab is maximized.
  makeChatAttachHost(tabs).postToWebview({ type: "focusInput" });
}

async function exitFullscreenComposer(tabs: ChatTabService): Promise<void> {
  if (!fullscreenComposerActive) {
    return;
  }
  await vscode.commands.executeCommand("workbench.action.toggleMaximizeEditorGroup");
  await setFullscreenComposerActive(false);
  // Return focus to the chat on the user's configured surface.
  await focusChatSurface(tabs);
}

/**
 * REVERIFY-P2-3 (H2): shared editor-tab-aware attach host. ALL chat-attach
 * paths (addToChat, browser image/element attach, native browser bridge,
 * fixWithAI) must route through here so chips land in the OPEN chat editor
 * tab when `ide.chat.openAsEditorTabs` is ON — never the hidden sidebar.
 *
 * REVERIFY-P2-1 (newChat misroute): when the caller just created a new tab,
 * pass its id as `explicitTabId`. `resolveChatEditorTab` looks at VS Code's
 * tab-group UI state, which hasn't caught up yet — without the explicit id
 * it would resolve the OLD tab when exactly one chat editor is open.
 */
function makeChatAttachHost(tabs: ChatTabService, explicitTabId?: string): AddToChatHost {
  const asEditor = openChatAsEditorTabs();
  const resolveTarget = (): ChatTab | undefined => {
    if (explicitTabId) {
      const tab = tabs.listTabs().find((t) => t.id === explicitTabId);
      if (tab) {
        return tab;
      }
    }
    return resolveChatEditorTab(tabs);
  };
  return {
    postToWebview: (message: unknown) => {
      if (asEditor && chatEditorProviderRef) {
        const tab = resolveTarget();
        const editorHost = tab ? chatEditorProviderRef.getHost(tab.id) : undefined;
        if (editorHost) {
          editorHost.postToWebview(message);
          return;
        }
      }
      activeChatView?.postToWebview(message);
    },
    focusChatView: async (): Promise<void> => {
      if (asEditor) {
        // Open (or reveal) the target chat editor tab — do NOT pull focus
        // to the sidebar.
        const tab = resolveTarget() ?? tabs.activeTab;
        await openChatEditor(tabs, undefined, tab.id);
      } else {
        await vscode.commands.executeCommand("ideAgent.chatView.focus");
      }
    },
  };
}

/**
 * WORKER-GAPS-22A (agent-new-agent-command-family): runtime of the
 * workbench-core `glass.newAgent*` family (Cursor 3.25.9 parity,
 * workbench.glass.main.js @45354715).
 *
 * Binary `newAgent` run branches (verbatim):
 *  1. args[0].cloudRepoUrls is an array -> emit
 *     `newAgentWithCloudTargetRequested` {repoUrls} and return.
 *  2. args[0].folderUri is a non-empty string -> parse as a URI; on parse
 *     failure or non-`file` scheme -> emit `newAgentRequested` (plain new
 *     agent) and return; otherwise resolve the single-folder workspace
 *     identifier and emit `newAgentWithWorkspaceTargetRequested`
 *     (presentation "picker-with-files" when source === "cli").
 *  3. Default -> emit `newAgentRequested` (plain new agent).
 *
 * Fork port (real behavior, ChatTabService-owned):
 *  1. Cloud repos: the fork has no cloud-agent target service (honest
 *     divergence) — a new agent tab is created and every repo URL is
 *     attached as a context chip, so the agent starts with the repos in
 *     context instead of silently dropping them.
 *  2. folderUri: `file`-scheme URIs are added to the workspace folders (so
 *     the new agent targets that folder, the fork's analog of Cursor's
 *     workspace-targeted agent) before the new agent tab opens; parse
 *     failure / non-file scheme falls through to the plain new agent,
 *     exactly like the binary.
 *  3. Default (incl. Ctrl+N "keyboard_shortcut" source): new agent tab +
 *     reveal on the configured chat surface.
 *  `shouldOpenEditorPanel` (Ctrl+Alt+N "preserve editor panel"): the new
 *  agent tab is opened in the EDITOR panel (chat editor tab) directly,
 *  bypassing the sidebar fallback — the editor panel stays visible, which
 *  is the fork's real meaning of Cursor's "preserve editor panel".
 *
 * Telemetry: the core forwards the binary's
 * `trackEvent("agent_layout.new_agent_clicked", {source, keybinding})`
 * payload in `args`; it is logged to the IDE Agent output channel here
 * (no fake analytics service).
 */
export interface NewAgentArgs {
  source?: string;
  keybinding?: string;
  cloudRepoUrls?: string[];
  folderUri?: string;
  shouldOpenEditorPanel?: boolean;
}

let newAgentTelemetryChannel: vscode.OutputChannel | undefined;
/** W65D (chat-cancel-generation-shortcut): inspectable log for the binary's
 * trackEvent("composer.cancel_chat", {composerId, source:"cmd_backspace"}). */
let cancelChatTelemetryChannel: vscode.OutputChannel | undefined;

export function sanitizeNewAgentArgs(raw: unknown): NewAgentArgs | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const out: NewAgentArgs = {};
  let known = false;
  if (typeof record.source === "string") {
    out.source = record.source;
    known = true;
  }
  if (typeof record.keybinding === "string") {
    out.keybinding = record.keybinding;
    known = true;
  }
  if (Array.isArray(record.cloudRepoUrls)) {
    const urls = record.cloudRepoUrls.filter(
      (u): u is string => typeof u === "string" && u.trim().length > 0,
    );
    if (urls.length > 0) {
      out.cloudRepoUrls = urls;
      known = true;
    }
  }
  if (typeof record.folderUri === "string" && record.folderUri.length > 0) {
    out.folderUri = record.folderUri;
    known = true;
  }
  if (record.shouldOpenEditorPanel === true) {
    out.shouldOpenEditorPanel = true;
    known = true;
  }
  return known ? out : undefined;
}

export async function newAgent(tabs: ChatTabService, args?: NewAgentArgs): Promise<void> {
  const telemetry = args?.source
    ? `agent_layout.new_agent_clicked source=${args.source}${args.keybinding ? ` keybinding=${args.keybinding}` : ""}`
    : undefined;
  if (telemetry) {
    // The binary's trackEvent payload, logged inspectably (no fake
    // analytics service in the fork).
    if (!newAgentTelemetryChannel) {
      newAgentTelemetryChannel = vscode.window.createOutputChannel("IDE Agent");
    }
    newAgentTelemetryChannel.appendLine(`[telemetry] ${telemetry}`);
  }

  // Binary branch 1: cloudRepoUrls array -> cloud-target agent.
  if (args?.cloudRepoUrls && args.cloudRepoUrls.length > 0) {
    const tab = tabs.createAndActivate({ mode: "agent" });
    const host = makeChatAttachHost(tabs, tab.id);
    await host.focusChatView();
    for (const url of args.cloudRepoUrls) {
      // Honest divergence (no cloud-agent service in the fork): attach the
      // repo URLs as context chips in the fresh agent tab instead of
      // dropping them.
      host.postToWebview({ type: "addSelectionContext", label: `cloud repo: ${url}`, content: url });
    }
    return;
  }

  // Binary branch 2: folderUri string -> workspace-target agent.
  if (args?.folderUri) {
    let uri: vscode.Uri | undefined;
    try {
      uri = vscode.Uri.parse(args.folderUri);
    } catch {
      uri = undefined;
    }
    if (uri && uri.scheme === "file") {
      const alreadyOpen = vscode.workspace.workspaceFolders?.some(
        (f) => f.uri.fsPath === uri!.fsPath,
      );
      if (!alreadyOpen) {
        const index = vscode.workspace.workspaceFolders?.length ?? 0;
        vscode.workspace.updateWorkspaceFolders(index, 0, { uri });
      }
    }
    // Parse failure / non-file scheme: fall through to the plain new agent
    // (the binary emits newAgentRequested in both cases).
  }

  // Binary default branch + shouldOpenEditorPanel (Ctrl+Alt+N) payload.
  const tab = tabs.createAndActivate({ mode: "agent" });
  if (args?.shouldOpenEditorPanel) {
    // Preserve the editor panel: open the new agent as a chat EDITOR tab
    // directly (never yank focus to the sidebar), keeping the editor area
    // visible.
    await vscode.commands.executeCommand("vscode.openWith", chatEditorUriForTab(tab.id), CHAT_EDITOR_VIEW_TYPE);
    return;
  }
  await focusChatSurface(tabs);
}

/**
 * WORKER-GAPS-40B: runtime of `glass.newProjectSubagent` (Cursor 3.25.9
 * parity, workbench.glass.main.js @45345673). The binary emits
 * `newProjectSubagentRequested` (with {source:"keyboard_shortcut"} on the
 * Ctrl+T path) — a DISTINCT event from `newAgentRequested`.
 *
 * HONEST-DIVERGENCE: the fork has no separate project-subagent target (no
 * project selector, no workspace-target agent service beyond the folderUri
 * branch), and the run body past the emission was not statically recovered.
 * The runtime therefore creates a new agent session through the shared
 * newAgent() path — the same real behavior as the sibling "New Agent"
 * commands — while preserving the distinct `newProjectSubagentRequested`
 * emission name in the telemetry log so the two can diverge later without
 * renaming.
 */
export async function newProjectSubagent(tabs: ChatTabService, args?: NewAgentArgs): Promise<void> {
  const emission = `newProjectSubagentRequested${args?.source ? ` source=${args.source}` : ""}${
    args?.keybinding ? ` keybinding=${args.keybinding}` : ""
  }`;
  if (!newAgentTelemetryChannel) {
    newAgentTelemetryChannel = vscode.window.createOutputChannel("IDE Agent");
  }
  // The binary's emission, logged inspectably (no fake analytics service).
  newAgentTelemetryChannel.appendLine(`[telemetry] ${emission}`);
  await newAgent(tabs, args);
}

/**
 * WORKER-GAPS-22A: runtime of `glass.newAgentWithModel` (Cursor 3.25.9
 * parity). Binary XQb: emit newAgentRequested, then
 * setModelConfigForComposer({selectedModels:[{modelId, parameters}]},
 * updateGlobalConfig:!0) — the new session is seeded with the given model.
 *
 * Fork port (real behavior): create a new agent tab, resolve `modelId`
 * against the engine catalog (the same entry values the model picker uses:
 * "auto" | "cursor-default" | "providerID/modelID[#variant]"), switch the
 * engine to it FIRST, then persist the selection on the new tab's composer
 * (the composer never shows a model the engine rejected — same discipline
 * as the model picker). Unknown modelId -> warning, the new agent keeps
 * the current model (never a silent wrong model).
 */
export async function newAgentWithModel(tabs: ChatTabService, modelId: string): Promise<void> {
  const tab = tabs.createAndActivate({ mode: "agent" });
  const composer = tab.composer;
  const models = await loadEngineModels(composer, "New Agent with Model");
  if (models) {
    const entries = buildModelPickerEntries(models, getEnabledModels());
    const entry = entries.find((e) => e.value === modelId);
    if (!entry) {
      void vscode.window.showWarningMessage(
        `IDE Agent: unknown model "${modelId}" — the new agent keeps the current model.`,
      );
    } else {
      const selection: ModelSelection =
        entry.value === CURSOR_DEFAULT_VALUE
          ? cursorDefaultSelection()
          : entry.value === AUTO_MODEL_VALUE || !entry.ref
            ? autoSelection()
            : { kind: "explicit", ref: entry.ref, label: entry.label };
      try {
        const adapter = composer.getEngineAdapter();
        await adapter.setModel!(selection.ref);
        composer.models.setSelection(selection);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(
          `IDE Agent: the engine rejected the model switch — ${message}.`,
        );
      }
    }
  }
  await focusChatSurface(tabs);
}

/** K-07 (Cursor parity): Cmd/Ctrl+Shift+L — attach the editor selection as a chip in the chat input. */
/**
 * Cursor parity: "Add to Chat" (Ctrl+L, editor/context + terminal/context,
 * floating terminal selection toolbar).
 * Thin wrapper — the logic lives in services/addToChat.ts (testable).
 * Label "Add to Chat" is verbatim from Cursor's selectionHoverActions.
 * Accepts optional `{ source: 'terminal', text }` from the workbench-core
 * terminal selection toolbar (selection text pre-resolved, no clipboard).
 *
 * P2-3 (QA-CHATEDITOR): the chip goes to the OPEN chat editor tab when one
 * exists — never yanks focus to the sidebar. Legacy sidebar path only when
 * `ide.chat.openAsEditorTabs` is OFF. P3-12: raw menu args are sanitized
 * (a forwarded Uri is not AddToChatArgs).
 *
 * P3-10 (QA-CHATEDITOR, resolved): the `editor/context` menu has no API to
 * report which editor was right-clicked, so the editor path uses
 * `activeTextEditor` — the documented pattern. In the modal menu flow the
 * right-click focuses the editor before the command runs, so this is the
 * right editor in practice; the palette path is disambiguated by the
 * keybinding `args`.
 */
function addToChat(tabs: ChatTabService, args?: AddToChatArgs): void {
  // IDE-CODE (Cursor parity, DETAIL-TERMINAL): Ctrl/Cmd+click on the
  // terminal floating button passes { newChat: true } — create a fresh
  // agent tab first and pin its id (REVERIFY-P2-1); focusChatView below
  // will reveal it.
  let explicitTabId: string | undefined;
  if (args?.newChat) {
    explicitTabId = tabs.createAndActivate({ mode: "agent" }).id;
  }
  const host = makeChatAttachHost(tabs, explicitTabId);
  void addToChatService(host, realVscodeSeam, args);
}

/**
 * Cursor parity: chat title context menu commands. The target tab is
 * resolved from the right-clicked editor tab when it is one of our chat
 * editors (see resolveChatEditorTab), falling back to the sidebar's active
 * tab — right-clicking a non-active editor tab does not activate it, so the
 * heuristic matters.
 *
 * P2-1: the title menu forwards the right-clicked tab's resource URI as the
 * first command arg — it must be honored, not dropped.
 */
/**
 * WORKER-GAPS-66A (`chat-tab-title-menu-inventory`): the last assistant
 * bubble's request id for a chat tab — the fork analog of the binary's
 * `latestChatGenerationUUID` (workbench.desktop.main.js @29931829, `Fgm`).
 * Shared by the `ide.copyRequestId` handler and the `ide.getChatRequestId`
 * provider command the core `composer.copyRequestId` action calls.
 */
function lastChatRequestId(tab: ChatTab): string | undefined {
  const bubbles = tab.composer.bubbles.getAllInOrder().filter((b) => b.role === "assistant");
  const last = bubbles[bubbles.length - 1];
  return last?.serverBubbleId ?? last?.bubbleId;
}

async function runChatTitleCommand(
  commandId: string,
  tabs: ChatTabService,
  rightClickedUri?: vscode.Uri,
): Promise<void> {
  const tab = resolveChatEditorTab(tabs, rightClickedUri);
  // Contested P3-11 (2-2): keep this guard. closeTab never empties the map,
  // but dispose() clears it — post-dispose the guard is reachable, and it
  // costs nothing as defense.
  if (!tab && commandId !== "ide.openAgentSettings") {
    void vscode.window.showInformationMessage("IDE Agent: no chat tab to act on.");
    return;
  }
  switch (commandId) {
    case "ide.copyRequestId": {
      // Cursor's Copy Request ID copies the last turn's backend request id
      // (for support). Ours: the last assistant bubble's server-assigned id.
      const requestId = lastChatRequestId(tab!);
      if (requestId) {
        await vscode.env.clipboard.writeText(requestId);
        void vscode.window.showInformationMessage("IDE Agent: request ID copied to the clipboard.");
      } else {
        void vscode.window.showInformationMessage("IDE Agent: no request ID yet — ask the agent something first.");
      }
      break;
    }
    case "ide.giveFeedback": {
      // P3-1 (QA-CHATEDITOR): the old input-box → "thanks" discarded the
      // text — a fake. Feedback is now genuinely persisted to
      // ~/.ide-code/feedback/ (one Markdown file per submission) where the
      // team can read it; the user is told exactly where it went.
      const text = await vscode.window.showInputBox({
        prompt: "IDE Agent feedback",
        placeHolder: "What worked, what didn't…",
      });
      if (text && text.trim()) {
        try {
          const dir = path.join(os.homedir(), ".ide-code", "feedback");
          await fs.promises.mkdir(dir, { recursive: true });
          const stamp = new Date().toISOString().replace(/[:.]/g, "-");
          const file = path.join(dir, `feedback-${stamp}.md`);
          const body = `# IDE Agent feedback\n\nSubmitted: ${new Date().toISOString()}\n\n${text.trim()}\n`;
          await fs.promises.writeFile(file, body, "utf8");
          void vscode.window.showInformationMessage(
            `IDE Agent: feedback saved to ${file} — thank you!`,
          );
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err);
          void vscode.window.showErrorMessage(`IDE Agent: could not save feedback — ${m}`);
        }
      }
      break;
    }
    case "ide.renameChat": {
      const title = await vscode.window.showInputBox({
        prompt: "Rename chat",
        value: tab!.title,
      });
      if (title && title.trim()) {
        tabs.renameTab(tab!.id, title.trim());
      }
      break;
    }
    case "ide.forkChat": {
      // P3-2/P3-14 (QA-CHATEDITOR): fork = a NEW tab seeded with a DEEP copy
      // of this tab's transcript. Fresh client bubble ids (no cross-tab
      // aliasing — Copy Request ID in the fork must not copy the source's
      // ids), fresh tool-call objects, and NO serverBubbleId (the fork has no
      // server session yet). The pending message queue is carried over so
      // queued work continues; pending clarifying questions are NOT copied —
      // they belong to the source tab's live approval state and re-asking
      // them in a fresh session would orphan the answers. The user is told
      // exactly this.
      const source = tab!;
      const fork = tabs.createTab({ title: `${source.title} (fork)` });
      const copies = source.composer.bubbles.getAllInOrder().map((b) => ({
        ...b,
        bubbleId: fork.composer.bubbles.newClientBubbleId(),
        serverBubbleId: undefined,
        toolCalls: b.toolCalls.map((tc) => ({ ...tc })),
        // REVERIFY-P3-8 (H3): deep-copy `thinking` — the source tab may
        // still be streaming (mutating bubble.thinking.done/text in place);
        // a shared reference would corrupt the fork mid-turn.
        thinking: b.thinking ? { ...b.thinking } : undefined,
      }));
      fork.composer.bubbles.appendBubbles(copies);
      for (const q of source.composer.queue.getItems()) {
        fork.composer.queue.enqueue(q.text, q.mode, q.attachments ? [...q.attachments] : undefined);
      }
      const pendingQuestions = source.composer.getPendingQuestions().length;
      await openChatEditor(tabs, undefined, fork.id);
      void vscode.window.showInformationMessage(
        "IDE Agent: forked into a new tab — transcript and queued messages copied; " +
          "the agent session starts fresh here." +
          (pendingQuestions > 0
            ? ` (${pendingQuestions} pending question(s) stayed with the original tab.)`
            : ""),
      );
      break;
    }
    case "ide.openAgentSettings": {
      await vscode.commands.executeCommand("workbench.action.openSettings", "ide.agent");
      break;
    }
    case "ide.shareChat": {
      // WORKER-GAPS-66A: Cursor's `composer.shareChat` shares the conversation
      // through its server (shareConversation + manage-sharing modal). The
      // fork has NO share backend — report that honestly instead of faking a
      // link. The core menu item is additionally gated on
      // `isSharedChatsEnabled` (false until a backend lands), so this path is
      // only reachable by direct command execution.
      void vscode.window.showInformationMessage(
        "IDE Agent: chat sharing isn't available in this build yet — use Export Transcript to save the chat as Markdown instead.",
      );
      break;
    }
    // Cursor 2.1 parity (cursor.com/changelog/page/13): pin the chat so it
    // stays at the top of every chat list, ordered by pin time. Target-tab
    // resolution is shared with the other chat title menu commands above.
    case "ide.pinChat": {
      if (!tabs.pinChat(tab!.id)) {
        void vscode.window.showInformationMessage("IDE Agent: this chat is already pinned.");
      }
      break;
    }
    case "ide.unpinChat": {
      if (!tabs.unpinChat(tab!.id)) {
        void vscode.window.showInformationMessage("IDE Agent: this chat is not pinned.");
      }
      break;
    }
  }
}


/**
 * Conversation search across ALL agent chat sessions (DEV-GAPS-45,
 * chat-conversation-search).
 *
 * REA spec (deep-docs-all.md:59): "Cmd/Ctrl+K in Agents Window searches past
 * chats (3.11+, local index, thousands of conversations)" — a local index
 * across past transcripts, NOT just the current one (audit-fix-queue P2:
 * "Conversation search is current-transcript-only").
 *
 * The index (services/conversationSearch.ts) scores every tab's transcript
 * (title + all turns). The QuickPick shows the match snippet, the session
 * title, the role and the date; picking a result switches to that tab and
 * reveals the chat surface.
 */
async function searchConversations(composer: ComposerDataService, tabs: ChatTabService): Promise<void> {
  const sessions: SearchableSession[] = tabs.listTabs().map((t) => ({
    id: t.id,
    title: t.title,
    createdAt: t.createdAt,
    messages: t.composer.bubbles.getAllInOrder().map((b) => ({
      id: b.bubbleId,
      role: (b.role === "human" || b.role === "assistant" ? b.role : "system") as
        | "human"
        | "assistant"
        | "system",
      text: b.text ?? "",
      createdAt: b.createdAt,
    })),
  }));
  const query = await vscode.window.showInputBox({
    title: "Search Conversations",
    prompt: "Search across all agent chats",
    placeHolder: "Type to search past chats…",
  });
  if (query === undefined || !query.trim()) {
    return;
  }
  const results = searchConversationIndex(query, sessions);
  if (!results.length) {
    void vscode.window.showInformationMessage(
      `IDE Agent: no conversations match "${query.trim()}".`,
    );
    return;
  }
  interface SearchPick extends vscode.QuickPickItem {
    result: (typeof results)[number];
  }
  const picked = await vscode.window.showQuickPick<SearchPick>(
    results.map((r) => ({
      label: r.snippet || "(empty)",
      description: r.sessionTitle,
      detail: `${r.role === "human" ? "You" : "Agent"} · ${new Date(r.createdAt).toLocaleString()}`,
      result: r,
    })),
    { placeHolder: `Search conversations — ${results.length} match${results.length === 1 ? "" : "es"}`, matchOnDescription: true },
  );
  if (picked) {
    // QA-REVERIFY-2-02: reveal the chat editor tab, not the sidebar.
    tabs.switchTab(picked.result.sessionId);
    await focusChatSurface(tabs);
  }
}

/* ------------------------------------------------------------------ */
/* User Rules (GAPS-36D, rules-user) — Cursor knowledge-base parity      */
/* ------------------------------------------------------------------ */

/**
 * `editor.action.knowledgeBase.add` ("Add User Rule", binary-verified in
 * Cursor 3.25.9). Collects a title and the rule content, then stores the
 * rule globally — "User Rules apply to all of your chats".
 */
async function addUserRuleFlow(tabs: ChatTabService): Promise<void> {
  const title = await vscode.window.showInputBox({
    title: "Add User Rule",
    prompt: "Short title for this rule",
    placeHolder: "e.g. Always use TypeScript strict mode",
  });
  if (title === undefined) {
    return; // Esc — cancelled.
  }
  const content = await vscode.window.showInputBox({
    title: "Add User Rule",
    prompt: "Rule content — instructions applied to every Agent chat (Agent Chat only, never Tab or Cmd+K)",
    placeHolder: "e.g. Prefer functional components; never use class components.",
  });
  if (content === undefined) {
    return; // Esc — cancelled.
  }
  if (!content.trim()) {
    void vscode.window.showWarningMessage("IDE Agent: user rule not added — content is empty.");
    return;
  }
  try {
    const rule = await tabs.activeComposer.userRules.addRule(title, content);
    void vscode.window.showInformationMessage(
      `IDE Agent: user rule "${rule.title}" added — applies to all of your Agent chats.`,
    );
  } catch (err) {
    void vscode.window.showErrorMessage(
      `IDE Agent: could not add user rule — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

interface UserRulePickItem extends vscode.QuickPickItem {
  ruleId?: string;
}

/**
 * `editor.action.knowledgeBase.list` ("View User Rules", binary-verified in
 * Cursor 3.25.9). Lists the global rules with per-rule Edit / Rename /
 * Delete actions and an entry point into the Add flow.
 */
async function viewUserRulesFlow(tabs: ChatTabService): Promise<void> {
  const svc = tabs.activeComposer.userRules;
  for (;;) {
    const rules = svc.getRules();
    const items: UserRulePickItem[] = [
      {
        label: "$(add) New User Rule",
        description: "Add a rule that applies to all of your Agent chats",
      },
      ...rules.map((r) => ({
        label: r.title,
        description: r.content.length > 100 ? `${r.content.slice(0, 100)}…` : r.content,
        ruleId: r.id,
      })),
    ];
    const choice = await vscode.window.showQuickPick(items, {
      title: "View User Rules",
      placeHolder: rules.length
        ? "User Rules apply to all of your chats — pick one to manage"
        : "No user rules yet — pick “New User Rule” to add one",
    });
    if (!choice) {
      return; // Esc.
    }
    if (!choice.ruleId) {
      await addUserRuleFlow(tabs);
      continue;
    }
    const rule = svc.getRule(choice.ruleId);
    if (!rule) {
      continue; // Deleted elsewhere; refresh the list.
    }
    const action = await vscode.window.showQuickPick(
      ["Edit content", "Rename", "Delete", "← Back to rules"],
      { title: rule.title, placeHolder: rule.content.slice(0, 160) },
    );
    if (!action || action.startsWith("←")) {
      continue;
    }
    if (action === "Delete") {
      const confirm = await vscode.window.showWarningMessage(
        `Delete user rule "${rule.title}"?`,
        { modal: true },
        "Delete",
      );
      if (confirm === "Delete") {
        await svc.removeRule(rule.id);
      }
      continue;
    }
    if (action === "Rename") {
      const next = await vscode.window.showInputBox({
        title: "Rename User Rule",
        value: rule.title,
        prompt: "Short title for this rule",
      });
      if (next !== undefined && next.trim() && next.trim() !== rule.title) {
        await svc.updateRule(rule.id, { title: next });
      }
      continue;
    }
    // "Edit content".
    const next = await vscode.window.showInputBox({
      title: `Edit User Rule — ${rule.title}`,
      value: rule.content,
      prompt: "Rule content — instructions applied to every Agent chat",
    });
    if (next !== undefined && next.trim() && next.trim() !== rule.content) {
      try {
        await svc.updateRule(rule.id, { content: next });
      } catch (err) {
        void vscode.window.showErrorMessage(
          `IDE Agent: could not update user rule — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}

/** Cmd/Ctrl+Enter: prefix listing every open text file as @-context. */
function fullContextPrefix(): string {
  const files = new Set<string>();
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.input instanceof vscode.TabInputText) {
        files.add("@" + vscode.workspace.asRelativePath(tab.input.uri));
      }
    }
  }
  if (!files.size) {
    return "";
  }
  return `Context (all open files): ${[...files].join(" ")}\n\n`;
}

class SessionsProvider implements vscode.TreeDataProvider<vscode.TreeItem> {  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }
  getChildren(_element?: vscode.TreeItem): Thenable<vscode.TreeItem[]> {
    // ENGINE: return one TreeItem per agent session.
    return Promise.resolve([]);
  }
}

/* ------------------------------------------------------------------ */
/* /worktree — git worktree management (Cursor parity)                 */
/* ------------------------------------------------------------------ */

/** Resolve the repo root or show an error message; returns undefined on failure. */
async function requireRepoRoot(service: WorktreeService): Promise<string | undefined> {
  const root = await service.getRepoRoot().catch(() => undefined);
  if (!root) {
    void vscode.window.showErrorMessage(
      "IDE Agent: /worktree needs an open git repository — open a folder that is a git checkout first.",
    );
    return undefined;
  }
  return root;
}

/**
 * /worktree — create an isolated worktree for the current task so agent work
 * never touches the main checkout (Cursor parity).
 */
async function worktreeFlow(service: WorktreeService): Promise<void> {
  const root = await requireRepoRoot(service);
  if (!root) return;

  const action = await vscode.window.showQuickPick(
    [
      { id: "create", label: "$(plus) Create worktree for current task", description: "new isolated checkout on a new or existing branch" },
      { id: "open", label: "$(window) Open worktree in new window", description: "open an existing worktree" },
      { id: "list", label: "$(list-tree) List worktrees", description: "show all worktrees for this repo" },
      { id: "delete", label: "$(trash) Delete worktree…", description: "remove a worktree (Cursor /delete-worktree)" },
      { id: "prune", label: "$(refresh) Prune stale worktrees", description: "clean up administrative data for removed worktrees" },
    ],
    { placeHolder: "/worktree — isolated checkouts for parallel agent work" },
  );
  if (!action) return;

  switch (action.id) {
    case "create": await createWorktreeFlow(service, root); break;
    case "open": await openWorktreeFlow(service, root); break;
    case "list": await listWorktrees(service); break;
    case "delete": await deleteWorktreeFlow(service); break;
    case "prune":
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Pruning worktrees…" },
        () => service.prune(root),
      );
      void vscode.window.showInformationMessage("IDE Agent: pruned stale worktree metadata.");
      break;
  }
}

async function createWorktreeFlow(service: WorktreeService, root: string): Promise<void> {
  const branch = await vscode.window.showInputBox({
    prompt: "Branch for the new worktree",
    placeHolder: "feature/my-change",
    validateInput: (v) => service.validateBranchName(v),
  });
  if (!branch) return;
  const trimmed = branch.trim();

  const defaultDir = service.resolveWorktreePath(root, trimmed);
  const dirPick = await vscode.window.showQuickPick(
    [
      { id: "default", label: "Use default location", description: defaultDir },
      { id: "choose", label: "Choose folder…", description: "pick a custom directory" },
    ],
    { placeHolder: "Where should the worktree live?" },
  );
  if (!dirPick) return;
  let dir = defaultDir;
  if (dirPick.id === "choose") {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: "Create worktree here",
      defaultUri: vscode.Uri.file(path.dirname(defaultDir)),
    });
    if (!uris?.[0]) return;
    dir = path.join(uris[0].fsPath, path.basename(defaultDir));
  }

  try {
    const created = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Creating worktree for "${trimmed}"…`, cancellable: false },
      () => service.create(root, dir, trimmed),
    );
    const open = await vscode.window.showInformationMessage(
      `IDE Agent: worktree created at ${created.path} on branch ${created.branch ?? trimmed}.`,
      "Open in New Window",
      "Copy Path",
    );
    if (open === "Open in New Window") {
      service.openInNewWindow(created.path);
    } else if (open === "Copy Path") {
      void vscode.env.clipboard.writeText(created.path);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`IDE Agent: failed to create worktree — ${message}`);
  }
}

async function openWorktreeFlow(service: WorktreeService, root: string): Promise<void> {
  const trees = await service.list(root).catch(() => []);
  if (trees.length === 0) {
    void vscode.window.showInformationMessage("IDE Agent: no worktrees found for this repo.");
    return;
  }
  const picked = await vscode.window.showQuickPick(
    trees.map((t) => ({
      label: `${t.isMain ? "$(star) " : ""}${path.basename(t.path)}`,
      description: t.path,
      detail: t.branch ? `branch ${t.branch}` : t.detached ? `detached @ ${t.head.slice(0, 7)}` : undefined,
      path: t.path,
    })),
    { placeHolder: "Open worktree in a new window" },
  );
  if (picked) service.openInNewWindow(picked.path);
}

/** List all worktrees in an information message with follow-up actions. */
async function listWorktrees(service: WorktreeService): Promise<void> {
  const root = await requireRepoRoot(service);
  if (!root) return;
  const trees = await service.list(root).catch(() => []);
  if (trees.length === 0) {
    void vscode.window.showInformationMessage("IDE Agent: no worktrees found for this repo.");
    return;
  }
  const lines = trees.map(
    (t) => `${t.isMain ? "[main] " : ""}${t.path} — ${t.branch ?? (t.detached ? `detached @ ${t.head.slice(0, 7)}` : t.head.slice(0, 7))}${t.prunable ? " (prunable)" : ""}`,
  );
  const sel = await vscode.window.showQuickPick(
    [
      { id: "open", label: "Open a worktree…", description: `${trees.length} worktrees found` },
      { id: "delete", label: "Delete a worktree…", description: "Cursor /delete-worktree" },
      ...trees.map((t) => ({ id: t.path, label: path.basename(t.path), description: t.path })),
    ],
    { placeHolder: `Worktrees (${trees.length}) — ${lines[0]}` },
  );
  if (!sel) return;
  if (sel.id === "open") void openWorktreeFlow(service, root);
  else if (sel.id === "delete") void deleteWorktreeFlow(service);
}

async function deleteWorktreeFlow(service: WorktreeService): Promise<void> {
  const root = await requireRepoRoot(service);
  if (!root) return;
  const trees = (await service.list(root).catch(() => [])).filter((t) => !t.isMain);
  if (trees.length === 0) {
    void vscode.window.showInformationMessage("IDE Agent: no removable worktrees (the main worktree cannot be deleted).");
    return;
  }
  const picked = await vscode.window.showQuickPick(
    trees.map((t) => ({
      label: path.basename(t.path),
      description: t.path,
      detail: t.branch ? `branch ${t.branch}` : undefined,
      path: t.path,
      branch: t.branch,
    })),
    { placeHolder: "Select worktree to delete" },
  );
  if (!picked) return;

  const confirm = await vscode.window.showWarningMessage(
    `Delete worktree at ${picked.path}?`,
    { modal: true },
    "Delete",
    "Delete (force, discard uncommitted changes)",
    "Cancel",
  );
  if (!confirm || confirm === "Cancel") return;
  const force = confirm.startsWith("Delete (force");

  let deleteBranch = false;
  if (picked.branch) {
    deleteBranch = (await vscode.window.showQuickPick(
      [
        { id: "keep", label: "Keep branch", description: `keep branch ${picked.branch}` },
        { id: "delete", label: "Delete branch too", description: `also run git branch -D ${picked.branch}` },
      ],
      { placeHolder: "What should happen to the branch?" },
    ))?.id === "delete";
  }

  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Deleting worktree…" },
      () => service.remove(root, picked.path, { force, deleteBranch }),
    );
    void vscode.window.showInformationMessage(`IDE Agent: deleted worktree ${picked.path}.`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`IDE Agent: failed to delete worktree — ${message}`);
  }
}

/**
 * /apply-worktree — bring a worktree's branch into the current checkout via
 * merge (Cursor parity). Conflicts stop the merge and are reported.
 */
async function applyWorktreeFlow(service: WorktreeService): Promise<void> {
  const root = await requireRepoRoot(service);
  if (!root) return;
  const trees = (await service.list(root).catch(() => [])).filter((t) => !t.isMain && t.branch);
  if (trees.length === 0) {
    void vscode.window.showInformationMessage("IDE Agent: no worktrees with branches to apply.");
    return;
  }
  const picked = await vscode.window.showQuickPick(
    trees.map((t) => ({
      label: t.branch ?? path.basename(t.path),
      description: t.path,
      branch: t.branch as string,
    })),
    { placeHolder: "/apply-worktree — merge a worktree's branch into the current checkout" },
  );
  if (!picked) return;

  const confirm = await vscode.window.showWarningMessage(
    `Merge branch "${picked.branch}" into the current checkout?`,
    { modal: true },
    "Merge",
    "Cancel",
  );
  if (confirm !== "Merge") return;

  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Merging ${picked.branch}…` },
      async () => {
        // DEV-GAPS-14 `ext-git-sanitize`: merge through the sanitizing
        // wrapper — URL credentials stripped, safe `-c` configs forced.
        await gitExecFile(root, ["merge", "--no-edit", picked.branch], { timeoutMs: 120_000 });
      },
    );
    void vscode.window.showInformationMessage(`IDE Agent: merged ${picked.branch} into the current checkout.`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(
      `IDE Agent: merge of ${picked.branch} failed — resolve conflicts in the terminal, then commit. ${message}`,
    );
  }
}

type WebviewMessage =
  | { type: "submit"; text: string; fullContext?: boolean; mentions?: unknown[]; sendMode?: "default" | "manual" | "queue" | "sendNow" }
  | { type: "setMode"; mode: string }
  | { type: "cycleMode" }
  | { type: "acceptPlan" }
  | { type: "discardPlan" }
  /**
   * GAPS-46D (agent-custom-modes): Alt+Enter / "Use as Mode" on a `/` menu
   * skill entry — enter a custom mode backed by that skill.
   */
  | { type: "useSkillAsMode"; name: string }
  /** GAPS-46D (agent-custom-modes): exit the active custom mode. */
  | { type: "exitCustomMode" }
  | { type: "openModelPicker" }
  | { type: "inputFocus"; focused: boolean }
  | { type: "findBarState"; open: boolean }  // DEV-GAPS-29: find-bar open/close -> composerFindWidgetFocused
  | { type: "approvalResolve"; approvalId: string; optionId: string }
  | { type: "webviewReady" }
  | { type: "stopTurn" }
  // Cursor parity: per-human-message Restore button → checkout_to_message.
  | { type: "restoreCheckpoint"; bubbleId: string }
  // Cursor parity — per-message "Fork Chat" (binary 3.25.9: `jav` in
  // AgentTranscriptTurnActions.js + command `composer.duplicateChat` with
  // {sourceComposerId, bubbleId}: branch a new chat from one message).
  | { type: "forkChatFromBubble"; bubbleId: string }
  // DEV-GAPS-73 (chat-copy-message, Cursor 3.25.6 parity): per-message
  // "Copy Message" — clipboard + trackEvent('composer.copy_message') +
  // toast 'Message copied to clipboard' (verbatim).
  | { type: "copyMessage"; bubbleId: string }
  // Edit-resubmit: user edited a sent message → resubmit dialog → truncate + resubmit.
  | { type: "resubmitEditedMessage"; bubbleId: string; text: string }
  // Doc-gap B8: chat tab bar controls.
  | { type: "newTab" }
  | { type: "switchTab"; tabId: string }
  | { type: "closeTab"; tabId: string }
  | { type: "renameTab"; tabId: string; title: string }
  // Cursor 2.1 pin parity: sidebar tab-bar context menu.
  | { type: "pinTab"; tabId: string }
  | { type: "unpinTab"; tabId: string }
  // Doc-gap A14/A15: queue list management (remove/reorder/send-now).
  | { type: "queueRemove"; id: string }
  | { type: "queueMove"; id: string; direction: -1 | 1 }
  | { type: "queueSendNow"; id: string }
  // Doc-gap A12: answer to a clarifying question. Single-select sends
  // optionId; multi-select (P2 QA-CHATTABS-X2) sends optionIds (all toggled
  // options, submitted together via the card's Done button).
  | { type: "answerQuestion"; questionId: string; optionId?: string; optionIds?: string[] }
  // @-mention system: the webview asks the host for items (it cannot query
  // VS Code state); the host replies with serializable MentionItems.
  | { type: "mentionQuery"; requestId: number; query: string }
  // @-mention chip click → open/reveal the referenced target (spec §4.2).
  | { type: "openMention"; chip: unknown };

class ChatViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  /** P2-4: outbound messages queued while the view isn't resolved yet. */
  private readonly pendingOutbound: unknown[] = [];
  // @-mention system: host-side provider registry (the webview cannot query
  // VS Code state, so it asks this service for items).
  private readonly mentions: MentionService;
  /** The tab whose full state was last synced to the webview. */
  private syncedTabId: string | undefined;
  /** Per-tab approval subscriptions (re-synced when the tab list changes). */
  private approvalDisposables = new Map<string, vscode.Disposable>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly tabs: ChatTabService,
    private readonly terminal?: TerminalService,
    private readonly slash?: SlashCommandService,
  ) {
    // Project rules are workspace-scoped (identical across tabs); the
    // provider registry is built once from the first tab's service.
    this.mentions = new MentionService(terminal, this.tabs.activeComposer.projectRules);
  }

  /** The active tab's composer — the transcript the webview shows. */
  private get composer(): ComposerDataService {
    return this.tabs.activeComposer;
  }

  /**
   * GAPS-46D (agent-custom-modes): enter a custom mode from a skill by name
   * (Alt+Enter / "Use as Mode" on a `/` menu skill entry). Docs:
   * "Any skill with a valid frontmatter block can back a mode."
   */
  private enterSkillAsMode(name: string): void {
    const skill = this.slash
      ?.getSkills()
      .find((s) => s.name.toLowerCase() === name.toLowerCase());
    if (!skill) {
      void vscode.window.showWarningMessage(`IDE Agent: no skill named '${name}' found.`);
      return;
    }
    this.composer.enterCustomMode({
      name: skill.name,
      content: skill.content,
      filePath: skill.filePath,
      ...(skill.icon !== undefined ? { icon: skill.icon } : {}),
      ...(skill.color !== undefined ? { color: skill.color } : {}),
    });
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    // P2 (CX2b): the webview bakes its engine-status hint from the real
    // connection state — a static "not connected" hint was factually wrong
    // whenever the sidecar was live.
    // P3 (CX2b): lang/dir come from the UI locale instead of a hardcoded en/LTR.
    const uiLang = vscode.env.language || "en";
    // RTL if the language tag starts with a right-to-left language code
    // (ar, he, fa, ur, yi, ps, sd, ckb, dv).
    const uiDir = /^(ar|he|fa|ur|yi|ps|sd|ckb|dv)(-|$)/i.test(uiLang) ? "rtl" : "ltr";
    webviewView.webview.html = createComposer(webviewView.webview, this.composer.modes.getMode(), this.composer.isEngineConnected, uiLang, uiDir, this.composer.models.getSelection().label, readChatUiConfig());
    // P2 (CX2b): push the live engine status so the hint corrects itself if
    // the connection state changed between html render and now.
    this.composer.notifyEngineStatus();
    // P1 (CX4b): a re-resolved webview (reload / view restore) starts with
    // empty HTML — the conversation survives in composer.bubbles, but the
    // fresh view never receives it because onDidChange only forwards FUTURE
    // deltas. Post the full current state immediately, reusing the message
    // shapes the webview already renders: bubbles, queue length, turn state
    // (so a mid-turn re-resolve still shows Stop), and any open approval
    // card (so it doesn't vanish on reload).
    void this.post({ type: "state", bubbles: this.composer.bubbles.getAllInOrder() });
    void this.post({
      type: "queue",
      length: this.composer.queue.length,
      items: serializeQueue(this.composer.queue.getItems()),
    });
    void this.post({ type: "turnState", running: this.composer.isRunning });
    void this.post({ type: "approval", request: this.composer.reviews.currentApproval ?? null });
    void this.postTabs();
    this.syncedTabId = this.tabs.activeTab.id;
    this.syncApprovalSubscriptions();

    // P0: if the view is closed mid-approval, settle pending approvals so
    // turns don't hang forever waiting for a webview message that never comes.
    // P2 (QA-04-VERIFY): collect the view-scoped subscriptions and dispose them
    // here — otherwise a closed-and-re-resolved view stacks duplicate
    // listeners (duplicate postMessage traffic + duplicate setContext calls).
    const viewDisposables: vscode.Disposable[] = [];
    webviewView.onDidDispose(() => {
      // P2 (QA-FILE-07): clear the view FIRST so post() drops messages
      // instead of posting to a disposed webview (unhandled rejection).
      this.view = undefined;
      // P2-4: drop queued outbound messages — they belong to a dead view;
      // a re-resolve gets a fresh full-state sync anyway.
      this.pendingOutbound.length = 0;
      for (const d of viewDisposables) {
        d.dispose();
      }
      // Settle pending approvals last — the toolApprovalVisible setContext
      // update is not view-dependent. Settle across ALL tabs: a background
      // tab's turn must not hang on a card the user can no longer see.
      for (const tab of this.tabs.listTabs()) {
        tab.composer.reviews.settleAllPending();
      }
      for (const d of this.approvalDisposables.values()) {
        d.dispose();
      }
      this.approvalDisposables.clear();
    });

    // Service → webview: fine-grained deltas (no full re-renders).
    // Tab-aware: the ChatTabService forwards every tab's composer events
    // tagged with tabId. Transcript-level events (bubbles/queue/mode/…)
    // only reach the webview when they come from the ACTIVE tab; tab-list
    // changes always post (tab-bar titles + running spinners).
    viewDisposables.push(
      // SETTINGS-PARITY: live-apply chat UI settings (text size, density,
      // word wrap, tips, font smoothing, Cmd+P picker) without re-rendering
      // the webview.
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("ide.composer") || e.affectsConfiguration("ide.general")) {
          void this.post({ type: "uiConfig", ui: readChatUiConfig() });
        }
      }),
      this.tabs.onDidChange((tabEvent) => {
        if (tabEvent.kind === "tabsChanged") {
          void this.postTabs();
          // The active tab may have changed → resync the full transcript.
          if (this.tabs.activeTab.id !== this.syncedTabId) {
            this.resyncActiveTab();
          }
          this.syncApprovalSubscriptions();
          return;
        }
        const event = tabEvent.event;
        const isActive = tabEvent.tabId === this.tabs.activeTab.id;
        // turnState from ANY tab refreshes the tab-bar spinners.
        if (event.kind === "turnState") {
          if (isActive) {
            void this.post({ type: "turnState", running: event.running });
          }
          void this.postTabs();
          return;
        }
        if (event.kind === "queueChanged") {
          if (isActive) {
            void this.post({ type: "queue", length: event.length, items: serializeQueue(event.items) });
          }
          void this.postTabs();
          return;
        }
        // DEV-ORANGE-DOT (chat-orange-dot): a clarifying question being asked
        // or answered changes a tab's awaiting-input state even when that tab
        // is NOT active — the tab bar needs a refresh so its orange dot
        // appears/clears. newChat resets tab-bar-visible state too (title,
        // queue, pending questions) on any tab. The active tab still gets
        // its question widget / newChat reset via handleComposerEvent below.
        if (
          event.kind === "questionAsked" ||
          event.kind === "questionAnswered" ||
          event.kind === "newChat"
        ) {
          void this.postTabs();
        }
        if (!isActive) {
          return;
        }
        this.handleComposerEvent(event);
      }),
    );

    // Slash-command palette items → webview (Cursor / parity, §4).
    // Initial delivery happens on the webviewReady handshake (posting here
    // would race the webview script load and be dropped); live updates are
    // pushed whenever the registry changes (file watch, MRU updates).
    // The webview filters/ranks locally per keystroke.
    if (this.slash) {
      const slash = this.slash;
      viewDisposables.push(
        slash.onDidChangeCommands(() => {
          void this.post({ type: "slashCommands", items: slash.getPaletteItems() });
        }),
      );
    }

    // Approval cards → webview. Per-tab subscriptions (synced when the tab
    // list changes): the active tab renders the card; background tabs'
    // approvals refresh the tab-bar pending dot. Managed by
    // syncApprovalSubscriptions() — NOT a view disposable (tabs outlive a
    // single webview resolve).
    this.syncApprovalSubscriptions();

    // P2 (QA-04-VERIFY): validate the webview message shape before dispatch —
    // the webview is untrusted input; a malformed payload used to throw
    // TypeError (e.g. `message.text` non-string in `submit`) as an unhandled
    // rejection.
    viewDisposables.push(
      webviewView.webview.onDidReceiveMessage((message: WebviewMessage) => {
        switch (message.type) {
          case "submit":
            if (typeof message.text === "string") {
              // @-mention chips: resolve each chip to its real context block
              // (file contents, diffs, terminal output, …) before the prompt
              // reaches the engine. The webview is untrusted — only chips
              // passing isMentionChip are resolved.
              const chips: MentionChip[] = Array.isArray(message.mentions)
                ? message.mentions.filter(isMentionChip)
                : [];
              // Cursor / parity: a leading `/name args…` is a slash
              // invocation, not chat text (spec §5 — prompt macro /
              // side-effect dispatch). Parsed on the RAW input so context
              // prefixes can't break the leading-`/` match. Unknown `/…`
              // submits as normal text.
              const parsed = this.slash?.parseLeadingCommand(message.text) ?? null;
              const fullCtx = message.fullContext === true;
              // SETTINGS-PARITY: route by how the message was sent while a
              // turn is running (Enter → default, Send button → manual,
              // Alt+Enter → queue, Cmd/Ctrl+Enter or Enter-twice → sendNow).
              // See queueMessageDefaultBehavior / queueManualSendBehavior.
              const sendMode =
                message.sendMode === "manual" ||
                message.sendMode === "queue" ||
                message.sendMode === "sendNow"
                  ? message.sendMode
                  : "default";
              if (parsed) {
                const prefix = fullCtx ? fullContextPrefix() : "";
                void this.mentions
                  .composePromptWithMentions(parsed.rest, chips)
                  .then((restComposed) => {
                    const restText = this.terminal
                      ? this.terminal.expandTerminalMentions(restComposed)
                      : restComposed;
                    return this.runSlashCommand(parsed.name, parsed.args, prefix + restText);
                  })
                  .catch(() => this.runSlashCommand(parsed.name, parsed.args, parsed.rest));
              } else {
                // Cmd/Ctrl+Enter: submit with every open file attached as context.
                const raw = fullCtx ? fullContextPrefix() + message.text : message.text;
                // Browser-tab screenshots: image chips resolve to real engine
                // file attachments (PromptInput.files) — the agent sees them.
                const attachments: FileAttachment[] = this.mentions.extractFileAttachments(chips);
                const submitOpts: {
                  sendMode: SubmitSendMode;
                  attachments?: FileAttachment[];
                } = {
                  sendMode,
                  ...(attachments.length > 0 ? { attachments } : {}),
                };
                void this.mentions
                  .composePromptWithMentions(raw, chips)
                  .then((withMentions) => {
                    // @Terminal(s): expand into the active terminal's recent output.
                    const text = this.terminal ? this.terminal.expandTerminalMentions(withMentions) : withMentions;
                    this.composer.submit(text, submitOpts);
                  })
                  .catch(() => this.composer.submit(raw, submitOpts));
              }
            }
            break;
          // @-mention system: resolve menu items for the webview's query.
          case "mentionQuery":
            if (typeof message.requestId === "number" && typeof message.query === "string") {
              const requestId = message.requestId;
              void this.mentions
                .getMentionItems(message.query)
                .then((items) =>
                  this.post({ type: "mentionItems", requestId, items, isLoading: false }),
                )
                .catch(() =>
                  this.post({ type: "mentionItems", requestId, items: [], isLoading: false }),
                );
            }
            break;
          // @-mention chip click → open/reveal the referenced target
          // (Cursor's Amp action map, spec §4.2).
          case "openMention":
            if (isMentionChip(message.chip)) {
              void this.openMentionTarget(message.chip).catch(() => undefined);
            }
            break;
          case "setMode":
            if (isModeName(message.mode)) {
              this.composer.modes.setMode(message.mode);
            }
            break;
          case "cycleMode":
            // Shift+Tab from the chat input (handled in the webview's
            // keydown) rotates Agent → Plan → Debug → Multitask → Ask.
            this.composer.modes.setMode(cycleMode(this.composer.modes.getMode()));
            break;
          case "acceptPlan":
            this.composer.acceptPlan();
            break;
          case "discardPlan":
            this.composer.discardPlan();
            break;
          // GAPS-46D (agent-custom-modes): Alt+Enter / "Use as Mode" on a
          // `/` menu skill entry — enter a custom mode backed by that skill.
          case "useSkillAsMode":
            this.enterSkillAsMode(message.name);
            break;
          case "exitCustomMode":
            this.composer.exitCustomMode();
            break;
          case "openModelPicker":
            void pickModel(this.composer);
            break;
          case "inputFocus":
            void vscode.commands.executeCommand("setContext", "ideAgent.chatInputFocused", message.focused === true);
            break;
          case "findBarState":
            // DEV-GAPS-29: the chat webview's find bar reports its open/close
            // state so the verbatim context key `composerFindWidgetFocused`
            // gates the core composer.find.hide/next/previous keybindings
            // (binary when-clauses), exactly like Cursor.
            void vscode.commands.executeCommand("setContext", "composerFindWidgetFocused", message.open === true);
            break;
          case "approvalResolve":
            if (typeof message.approvalId === "string" && typeof message.optionId === "string") {
              this.composer.reviews.resolveApproval(message.approvalId, { optionId: message.optionId });
            }
            break;
          case "webviewReady":
            // Initial slash-command palette delivery (avoids the post-before-
            // load race). Later changes are pushed via onDidChangeCommands.
            if (this.slash) {
              void this.post({ type: "slashCommands", items: this.slash.getPaletteItems() });
            }
            // P2-4 (QA-CHATEDITOR): flush messages queued while the view
            // wasn't resolved (chips posted during cold start).
            for (const pending of this.pendingOutbound.splice(0)) {
              void this.post(pending);
            }
            // Context ring: initial live breakdown (later deltas arrive via
            // the `contextUsage` composer event → handleComposerEvent).
            void this.post({ type: "ctxUsage", ...this.composer.getContextUsageSnapshot() });
            // GAPS-46D (agent-custom-modes): restore the custom-mode badge
            // on webview re-resolve (the mode survives webview reloads).
            void this.post({
              type: "customMode",
              active: serializeCustomMode(this.composer.getActiveCustomMode()),
              exitedLabel: null,
            });
            break;
          // P1 (QA-FILE-01): Stop button → abort the running turn.
          // GAPS-11B (agent-abort-restore-query): restoreQuery puts the
          // aborted turn's prompt back into the input (Cursor parity).
          case "stopTurn":
            this.composer.abort({ restoreQuery: true });
            break;
          // Cursor parity: per-message Restore button (no confirmation).
          case "restoreCheckpoint":
            if (typeof message.bubbleId === "string") {
              void this.composer.revertToCheckpoint(message.bubbleId).catch((err: unknown) => {
                const m = err instanceof Error ? err.message : String(err);
                void vscode.window.showErrorMessage(`IDE Agent: restore failed — ${m}`);
              });
            }
            break;
          // Cursor parity — per-message "Fork Chat" (binary 3.25.9:
          // `composer.duplicateChat` with {sourceComposerId, bubbleId}):
          // branch a new chat seeded with the transcript prefix through
          // the selected message (see chatForkFromBubble.ts for the
          // verbatim truncation semantics).
          case "forkChatFromBubble":
            if (typeof message.bubbleId === "string") {
              try {
                const result = forkTabFromBubble(this.tabs, this.tabs.activeTab, message.bubbleId);
                void openChatEditor(this.tabs, undefined, result.tab.id);
                void vscode.window.showInformationMessage(forkInfoMessage(result));
              } catch (err) {
                const m = err instanceof Error ? err.message : String(err);
                void vscode.window.showErrorMessage(m);
              }
            }
            break;
          // DEV-GAPS-73 (chat-copy-message, Cursor 3.25.6 parity):
          // binary-verbatim message action — clipboard write +
          // trackEvent('composer.copy_message') + 'Message copied to
          // clipboard' toast. The text copied is the bubble's raw
          // markdown source (chatCopyMessageService.ts).
          case "copyMessage":
            if (typeof message.bubbleId === "string") {
              void copyBubbleMessageToClipboard(
                this.tabs.activeComposer,
                message.bubbleId,
                makeCopyMessageSeam(),
              ).catch((err: unknown) => {
                const m = err instanceof Error ? err.message : String(err);
                void vscode.window.showErrorMessage(`IDE Agent: copy failed — ${m}`);
              });
            }
            break;
          // Edit-resubmit: user edited a sent message → resubmit dialog
          // ("Continue and revert" / "Continue without reverting") → truncate
          // + resubmit (chatResubmitService).
          case "resubmitEditedMessage":
            if (typeof message.bubbleId === "string" && typeof message.text === "string") {
              void this.composer.resubmitEditedMessage(message.bubbleId, message.text).catch((err: unknown) => {
                const m = err instanceof Error ? err.message : String(err);
                void vscode.window.showErrorMessage(`IDE Agent: resubmit failed — ${m}`);
              });
            }
            break;
          // Doc-gap B8: chat tab controls from the webview tab bar.
          case "newTab":
            this.tabs.createAndActivate({});
            break;
          case "switchTab":
            if (typeof message.tabId === "string") {
              this.tabs.switchTab(message.tabId);
            }
            break;
          case "closeTab":
            if (typeof message.tabId === "string") {
              void this.tabs.closeTab(message.tabId);
            }
            break;
          case "renameTab":
            if (typeof message.tabId === "string" && typeof message.title === "string") {
              this.tabs.renameTab(message.tabId, message.title);
            }
            break;
          // Cursor 2.1 pin parity: sidebar tab-bar context menu.
          case "pinTab":
            if (typeof message.tabId === "string") {
              this.tabs.pinChat(message.tabId);
            }
            break;
          case "unpinTab":
            if (typeof message.tabId === "string") {
              this.tabs.unpinChat(message.tabId);
            }
            break;
          // Doc-gap A14/A15: queue list management from the webview.
          case "queueRemove":
            if (typeof message.id === "string") {
              this.composer.queueRemove(message.id);
            }
            break;
          case "queueMove":
            if (typeof message.id === "string" && (message.direction === -1 || message.direction === 1)) {
              this.composer.queueMove(message.id, message.direction);
            }
            break;
          case "queueSendNow":
            if (typeof message.id === "string") {
              this.composer.queueSendNow(message.id);
            }
            break;
          // Doc-gap A12: the user picked option(s) on a clarifying question.
          case "answerQuestion": {
            const qid = message.questionId;
            if (typeof qid === "string") {
              let ok = false;
              if (Array.isArray(message.optionIds)) {
                // P2 (QA-CHATTABS-X2): multi-select — all toggled options,
                // submitted together.
                const ids = message.optionIds.filter(
                  (o): o is string => typeof o === "string",
                );
                ok = this.composer.answerQuestionMulti(qid, ids);
              } else if (typeof message.optionId === "string") {
                ok = this.composer.answerQuestion(qid, message.optionId);
              }
              if (!ok) {
                void vscode.window.showWarningMessage(
                  "IDE Agent: that question is no longer pending — the answer was not sent.",
                );
              }
            }
            break;
          }
        }
      }),
    );
  }

  private async post(message: unknown): Promise<void> {
    if (this.view) {
      await this.view.webview.postMessage(message);
    }
  }

  /** Post the tab-bar state (titles, active, running spinners, queue counts). */
  private async postTabs(): Promise<void> {
    await this.post({ type: "tabs", tabs: this.tabs.getTabStates() });
  }

  /**
   * Full transcript resync after an active-tab switch (or a re-resolve):
   * bubbles, queue list, turn state, open approval card, mode and model.
   */
  private resyncActiveTab(): void {
    const composer = this.composer;
    this.syncedTabId = this.tabs.activeTab.id;
    void this.post({ type: "state", bubbles: composer.bubbles.getAllInOrder() });
    void this.post({
      type: "queue",
      length: composer.queue.length,
      items: serializeQueue(composer.queue.getItems()),
    });
    void this.post({ type: "turnState", running: composer.isRunning });
    void this.post({ type: "approval", request: composer.reviews.currentApproval ?? null });
    void this.post({ type: "mode", mode: composer.modes.getMode() });
    void this.post({ type: "model", label: composer.models.getSelection().label });
    // P3-13 (QA-CHATTABS-X3): re-post pending clarifying questions. The
    // webview clears its question cards on `state` ("the host re-posts live
    // state right after") — without this, a pending question was lost
    // forever on tab switch / webview re-resolve.
    for (const q of composer.getPendingQuestions()) {
      void this.post({ type: "question", question: q });
    }
    // Context ring: the newly active tab has its own breakdown.
    void this.post({ type: "ctxUsage", ...composer.getContextUsageSnapshot() });
    void this.postTabs();
  }

  /**
   * Keep one approval subscription per tab. Approvals from the ACTIVE tab
   * render the card; approvals from background tabs still refresh the
   * tab-bar state (their tab shows a pending dot via the tab list).
   */
  private syncApprovalSubscriptions(): void {
    const live = new Set(this.tabs.listTabs().map((t) => t.id));
    for (const [id, d] of this.approvalDisposables) {
      if (!live.has(id)) {
        d.dispose();
        this.approvalDisposables.delete(id);
      }
    }
    for (const tab of this.tabs.listTabs()) {
      if (this.approvalDisposables.has(tab.id)) {
        continue;
      }
      const tabId = tab.id;
      this.approvalDisposables.set(
        tabId,
        tab.composer.reviews.onDidChangeApproval((request: ApprovalRequest | undefined) => {
          if (tabId === this.tabs.activeTab.id) {
            void this.post({ type: "approval", request: request ?? null });
            // DEV-GAPS-45 (chat-sound-notify): "Play a sound when agents
            // finish or need attention" — an approval request is the
            // canonical "needs attention" moment (orange dot on the tab).
            // The same toggle as the post-turn chime; off by default.
            if (request !== undefined) {
              this.playAttentionChime();
            }
            void vscode.commands.executeCommand(
              "setContext",
              "ideAgent.toolApprovalVisible",
              request !== undefined,
            );
            // DEV-GAPS-12 (agent-shell-approval-keyboard-flow): Cursor's
            // `composerShellToolPendingKeybindingsActive` /
            // `composerShellToolAllowlistShortcutActive` — the Enter /
            // Shift+Enter / Esc bindings only live while a *shell* tool
            // approval is pending (bridged to the `composer.*` keys in core).
            // An allowlisted identity never shows a card (requestApproval
            // auto-resolves), so a pending shell approval always has
            // allowlist candidates — both keys share the value.
            const shellPending =
              request !== undefined && isShellToolApproval(request);
            void vscode.commands.executeCommand(
              "setContext",
              "ideAgent.shellToolPendingKeybindingsActive",
              shellPending,
            );
            void vscode.commands.executeCommand(
              "setContext",
              "ideAgent.shellToolAllowlistShortcutActive",
              shellPending,
            );
            // Cursor parity: OS-level nudge when the agent needs approval while the
            // window is in the background (gated by ide.agent.terminal.notifyOnApproval).
            if (request && vscode.window.state.focused === false) {
              const notify = vscode.workspace
                .getConfiguration("ide.agent.terminal")
                .get<boolean>("notifyOnApproval", true);
              if (notify) {
                void vscode.window
                  .showInformationMessage(`IDE Agent needs approval: ${request.title}`, "Review")
                  .then((sel) => {
                    if (sel === "Review") {
                      // QA-REVERIFY-2-02: reveal the chat editor tab, not the
                      // hidden sidebar, when editor tabs are ON.
                      void focusChatSurface(this.tabs);
                    }
                  });
              }
            }
          }
          // Any tab's approval change refreshes the tab bar (pending dot).
          void this.postTabs();
        }),
      );
    }
  }

  /**
   * DEV-GAPS-45 (chat-sound-notify): play the completion chime when the
   * agent needs attention (an approval request appeared). Gated by the same
   * `ide.composer.shouldChimeAfterChatFinishes` toggle ("Play a sound when
   * agents finish or need attention", OFF by default); fire-and-forget,
   * never throws (see services/chime.ts).
   */
  private playAttentionChime(): void {
    const cfg = vscode.workspace.getConfiguration("ide.composer");
    if (!cfg.get<boolean>("shouldChimeAfterChatFinishes", false)) {
      return;
    }
    void playChime({
      customPath: cfg.get<string>("customChimeSoundPath", ""),
      defaultPath: defaultChimePath(this.context.extensionPath),
    });
  }

  /**
   * Active-tab composer events that the tab relay doesn't special-case.
   * (turnState/queueChanged are handled in the relay for cross-tab spinners.)
   */
  private handleComposerEvent(event: ComposerEvent): void {
    switch (event.kind) {
      case "bubblesChanged": {
        const bubbles = event.ids
          .map((id) => this.composer.bubbles.getBubbleData(id))
          .filter((b): b is NonNullable<typeof b> => b !== undefined);
        void this.post({ type: "bubbles", bubbles });
        break;
      }
      case "bubblesReset": {
        void this.post({ type: "state", bubbles: this.composer.bubbles.getAllInOrder() });
        break;
      }
      // P1 (CX1b): new chat — the webview resets all composer-local state
      // (chips, input draft, open menus, ctx usage).
      case "newChat": {
        void this.post({ type: "newChat" });
        break;
      }
      case "queueChanged": {
        void this.post({ type: "queue", length: event.length, items: serializeQueue(event.items) });
        break;
      }
      case "modeChanged": {
        void this.post({ type: "mode", mode: event.mode });
        break;
      }
      // Plan mode: a plan-mode turn completed → webview shows the plan tray.
      case "planReady": {
        void this.post({ type: "planReady" });
        break;
      }
      case "planCleared": {
        void this.post({ type: "planCleared" });
        break;
      }
      // GAPS-46D (agent-custom-modes): push badge state to the webview.
      case "customModeChanged": {
        void this.post({
          type: "customMode",
          active: serializeCustomMode(event.active),
          exitedLabel: event.exitedLabel,
        });
        break;
      }
      // Doc-gap A12: clarifying question → clickable widget in the webview.
      case "questionAsked": {
        void this.post({ type: "question", question: event.question });
        break;
      }
      case "questionAnswered": {
        void this.post({ type: "questionAnswered", questionId: event.questionId });
        break;
      }
      // P1 (QA-FILE-01): turn lifecycle → webview Stop/Send toggle.
      case "turnState": {
        void this.post({ type: "turnState", running: event.running });
        break;
      }
      // GAPS-11B (agent-abort-restore-query): the aborted turn's prompt
      // goes back into the composer input for editing (Cursor parity).
      case "restorePrompt": {
        void this.post({ type: "restoreInput", text: event.text });
        break;
      }
      // Context ring: host-computed real 8-category breakdown, live after
      // every settled turn (tokens are chars/4 estimates — never fabricated).
      case "contextUsage": {
        void this.post({
          type: "ctxUsage",
          sources: event.sources,
          totalTokens: event.totalTokens,
          windowPct: event.windowPct,
        });
        break;
      }
      // Cursor parity: restore done → webview shows the "checked out" chip.
      case "checkpointRestored": {
        void this.post({ type: "checkpointRestored", bubbleId: event.bubbleId });
        break;
      }
      // P2 (CX2b): engine connection state → webview engine-status hint.
      case "engineStatus": {
        void this.post({ type: "engineStatus", connected: event.connected });
        break;
      }
      // M-03 (model picker): selection changed → webview model button label.
      case "modelChanged": {
        void this.post({ type: "model", label: event.selection.label });
        break;
      }
    }
  }

  /**
   * @-mention chip click actions (Cursor's Amp map, parity-at-mentions §4.2):
   * file → open in workspace; code → reveal selection; terminal → show;
   * cursorRule → open rule file; browser → focus chat (no tab UI yet);
   * folder/chat/clipboard/mcp/branch/diff → noop (contextual, no target).
   */
  private async openMentionTarget(chip: MentionChip): Promise<void> {
    const p = chip.payload;
    switch (p.case) {
      case "fileSelection":
      case "folderSelection": {
        const uri = this.uriFromPayload(p.uri);
        if (uri) {
          await vscode.commands.executeCommand("vscode.open", uri);
        }
        break;
      }
      case "codeSelection": {
        const uri = this.uriFromPayload(p.uri);
        if (uri) {
          const doc = await vscode.workspace.openTextDocument(uri);
          const editor = await vscode.window.showTextDocument(doc);
          editor.revealRange(
            new vscode.Range(p.startLine, 0, p.endLine, 0),
            vscode.TextEditorRevealType.InCenter,
          );
          editor.selection = new vscode.Selection(p.startLine, 0, p.endLine, 0);
        }
        break;
      }
      case "terminalFile": {
        const term = vscode.window.terminals.find(
          (t) => (t.name || "Terminal") === p.terminalName,
        );
        term?.show();
        break;
      }
      case "cursorRule": {
        const rule = this.composer.projectRules
          .getRules()
          .find((r) => r.filename === p.name);
        if (rule) {
          await vscode.commands.executeCommand(
            "vscode.open",
            vscode.Uri.file(rule.fullPath),
          );
        }
        break;
      }
      default:
        break;
    }
  }

  /** Parse a payload URI, accepting only file: URIs inside the workspace. */
  private uriFromPayload(uri: string): vscode.Uri | undefined {
    try {
      const u = vscode.Uri.parse(uri);
      if (u.scheme !== "file") {
        return undefined;
      }
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (root) {
        const rel = u.fsPath.startsWith(root + "/") || u.fsPath === root;
        if (!rel) {
          return undefined;
        }
      }
      return u;
    } catch {
      return undefined;
    }
  }

  /** Host → webview message (prefill input, attach selection context, …). */
  postToWebview(message: unknown): void {
    // P2-4 (QA-CHATEDITOR): never silently drop a chip when the view isn't
    // resolved yet (cold start, view hidden) — queue it and flush on
    // resolveWebviewView. Bounded so a never-resolving view can't grow it
    // without limit.
    if (this.view) {
      void this.post(message);
    } else {
      if (this.pendingOutbound.length < 100) {
        this.pendingOutbound.push(message);
      }
    }
  }

  /**
   * Cursor / parity: dispatch a slash invocation (spec §5). Built-ins with
   * side effects execute directly; custom commands and skills return a
   * prompt macro that is prepended to the remaining text and submitted as
   * the turn. MRU is recorded + persisted on every dispatch (spec §3).
   */
  private async runSlashCommand(name: string, args: string, rest: string): Promise<void> {
    const slash = this.slash;
    if (!slash) {
      void vscode.window.showWarningMessage(`IDE Agent: slash commands are not available (service not started).`);
      return;
    }
    slash.recordUse(name);
    await this.context.globalState.update("ideAgent.slashMru", slash.serializeMru());
    let result: { macro?: string };
    try {
      result = await slash.run(name, args);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`IDE Agent: /${name} failed — ${m}`);
      return;
    }
    if (result.macro) {
      const prompt = rest ? `${result.macro}\n\n${rest}` : result.macro;
      this.composer.submit(prompt);
    }
    // Built-ins with side effects (worktree, best-of-n, summarize, …) already
    // executed inside run() — nothing further to submit.
  }

}

function isModeName(value: string): value is ModeName {
  return MODES.some((m) => m.id === value);
}


export function deactivate(): void {
  // DEV-HOOKS: sessionEnd (Cursor parity) — best-effort at shutdown; hook
  // output has nowhere to go, but hooks may want the cleanup signal.
  try {
    void hookServiceRef?.runHooks("sessionEnd", {}).catch(() => {});
  } catch {
    /* never throw from deactivate */
  }
  // Browser tab: stop the screencast and kill the tab Chromium.
  try {
    void browserTabsRef?.dispose().catch(() => {});
  } catch {
    /* never throw from deactivate */
  }
  // Desktop bridge: close the socket server, delete the instance JSON +
  // socket (best-effort, never throws).
  try {
    void desktopBridgeServerRef?.stop().catch(() => {});
  } catch {
    /* never throw from deactivate */
  }
}
