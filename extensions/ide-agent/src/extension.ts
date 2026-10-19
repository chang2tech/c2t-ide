import * as vscode from "vscode";
import * as path from "node:path";
import * as childProcess from "node:child_process";
import { ModeName } from "./model";
import { ComposerDataService, ComposerEvent } from "./services/composerDataService";
import { ChatTabService } from "./services/chatTabService";
import { QueuedMessage, MessageQueueService } from "./services/messageQueueService";

/**
 * Serialize queue items for the webview (adds the overdue-steer badge flag —
 * Cursor parity: messages admitted >5min ago are retagged to the next turn).
 */
function serializeQueue(items: QueuedMessage[]): Array<{
  id: string;
  text: string;
  mode: string;
  enqueuedAt: number;
  overdue: boolean;
}> {
  const now = Date.now();
  return items.map((m) => ({
    id: m.id,
    text: m.text,
    mode: m.mode,
    enqueuedAt: m.enqueuedAt,
    overdue: now - m.enqueuedAt >= MessageQueueService.OVERDUE_MS,
  }));
}
import { MODES, DROPDOWN_MODES, modeDef, cycleMode } from "./services/modeService";
import { ApprovalRequest } from "./services/humanReviewService";
import { WorktreeService } from "./services/worktreeService";
import { createComposer } from "./components/composer";
import { activate as activateTab } from "./tab/extension";
import { TerminalService } from "./services/terminalService";
import { InlineEditService } from "./services/inlineEditService";
import { activateMcp } from "./mcp";
import { SlashCommandService } from "./services/slashCommandService";
import { attachPendingSelection } from "./services/inlinePromptSelection";
import { MentionService, MentionChip, isMentionChip, FileAttachment } from "./services/mentionService";
import { SubmitSendMode } from "./services/composerDataService";
import { EngineModelInfo, ModelRef } from "./services/agentService";
import { ModelSelection, ModelService, filterEnabledModels, isModelEnabled, nextEnabledModel } from "./services/modelService";
import { HookService } from "./hooks/hookService";
import { BrowserTabManager } from "./browser/browserTab";

/** Module-level hook service ref so deactivate() can fire sessionEnd hooks. */
let hookServiceRef: HookService | undefined;

/** Module-level browser tab manager ref so deactivate() can stop Chromium. */
let browserTabsRef: BrowserTabManager | undefined;

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
 * StubEngineAdapter and are visibly labeled "engine wiring pending".
 */

interface ScaffoldCommand {
  id: string;
  title: string;
  /** One-line description of what this command will do once the engine lands. */
  does: string;
}

const COMMANDS: ScaffoldCommand[] = [
  { id: "ide.newChat", title: "New Chat", does: "focus the IDE Agent chat view and start a fresh conversation" },
  { id: "ide.newFollowup", title: "Focus Chat Followup", does: "focus the follow-up input of the active chat" },
  { id: "ide.newAgentChat", title: "New Agent Chat", does: "open a new agent-mode chat tab" },
  { id: "ide.openInlinePrompt", title: "Open Inline Prompt", does: "open the Cmd+K-style inline prompt bar at the cursor" },
  { id: "ide.acceptInlineEdit", title: "Accept Inline Edit", does: "accept the pending inline edit preview (Ctrl+Enter)" },
  { id: "ide.rejectInlineEdit", title: "Reject Inline Edit", does: "revert the pending inline edit preview (Esc)" },
  { id: "ide.sendToAgent", title: "Send Inline Prompt to Agent", does: "escalate the inline prompt into a full agent turn" },
  { id: "ide.openModeMenu", title: "Open Mode Menu", does: "open the Plan/Debug/Multitask/Ask mode picker (Agent is the implicit default)" },
  { id: "ide.openModelPicker", title: "Open Model Picker", does: "open the model picker quickpick" },
  { id: "ide.manageModels", title: "Manage Models…", does: "enable or disable individual engine models (ide.agent.enabledModels)" },
  { id: "ide.generateGitCommitMessage", title: "Generate Git Commit Message", does: "generate a commit message from the staged diff and fill the SCM input" },
  { id: "ide.cycleModel", title: "Cycle Model", does: "cycle to the next enabled model (skips models disabled in ide.agent.enabledModels)" },
  { id: "ide.toggleChatAsEditor", title: "Toggle Chat as Editor", does: "toggle the chat between side view and editor tab" },
  { id: "ide.nextChatTab", title: "Next Chat Tab", does: "switch to the next chat tab" },
  { id: "ide.previousChatTab", title: "Previous Chat Tab", does: "switch to the previous chat tab" },
  { id: "ide.selectNextChat", title: "Select Next Chat", does: "select the next chat in the chat list" },
  { id: "ide.selectPreviousChat", title: "Select Previous Chat", does: "select the previous chat in the chat list" },
  { id: "ide.selectNextSubagentTab", title: "Select Next Subagent Tab", does: "switch to the next subagent tab" },
  { id: "ide.selectPreviousSubagentTab", title: "Select Previous Subagent Tab", does: "switch to the previous subagent tab" },
  { id: "ide.closeChatTab", title: "Close Chat Tab", does: "close the active chat tab" },
  { id: "ide.cancelAgentStep", title: "Cancel Agent Step", does: "cancel the currently running agent step" },
  { id: "ide.findInChat", title: "Find in Chat", does: "focus the find widget inside the chat view" },
  { id: "ide.hideFindInChat", title: "Hide Find in Chat", does: "hide the find widget inside the chat view" },
  { id: "ide.openAddContextMenu", title: "Add Context…", does: "open the @-mention context picker (files, symbols, browser, images)" },
  { id: "ide.approveShellTool", title: "Approve Pending Shell Command", does: "approve the pending shell tool call once" },
  { id: "ide.approveShellToolAllowlist", title: "Approve Pending Shell Command and Allowlist It", does: "approve the pending shell tool call and add it to the allowlist" },
  { id: "ide.skipShellTool", title: "Skip Pending Shell Command", does: "skip the pending shell tool call" },
  { id: "ide.worktreeCommand", title: "Worktree Command (/worktree)", does: "create an isolated git worktree for the current task (Cursor /worktree parity)" },
  { id: "ide.listWorktrees", title: "List Worktrees", does: "show all git worktrees for the current repo" },
  { id: "ide.deleteWorktree", title: "Delete Worktree…", does: "remove a git worktree (Cursor /delete-worktree parity)" },
  { id: "ide.applyWorktree", title: "Apply Worktree…", does: "bring worktree changes into the main checkout (Cursor /apply-worktree parity)" },
  { id: "ide.focusEditorFromDiff", title: "Focus Editor from Inline Diff", does: "return focus to the editor while the inline prompt bar is open" },
  { id: "ide.addSelectionToInlinePrompt", title: "Add Selection to Inline Prompt", does: "attach the current editor selection to the next inline edit prompt (Cursor K-08 parity)" },
  { id: "ide.acceptPlan", title: "Accept Plan", does: "accept the authored plan and start the build phase" },
  { id: "ide.cycleMode", title: "Cycle Mode", does: "cycle the chat mode Agent → Plan → Debug → Multitask → Ask (Shift+Tab)" },
  { id: "ide.setAgentMode", title: "Open Chat in Agent Mode", does: "switch the chat to Agent mode" },
  { id: "ide.setPlanMode", title: "Open Chat in Plan Mode", does: "switch the chat to Plan mode" },
  { id: "ide.setAskMode", title: "Open Chat in Ask Mode", does: "switch the chat to Ask mode" },
  { id: "ide.setDebugMode", title: "Open Chat in Debug Mode", does: "switch the chat to Debug mode" },
  { id: "ide.setMultitaskMode", title: "Open Chat in Multitask Mode", does: "switch the chat to Multitask mode" },
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
  { id: "ide.reviewChanges", title: "Review Changes with Agent", does: "ask the agent to review the working-tree changes" },
  { id: "ide.fixWithAI", title: "Fix with AI", does: "send the current selection (or file) plus diagnostics to the agent to fix" },
  { id: "ide.addSelectionToChat", title: "Add Selection to Chat", does: "attach the current editor selection as context to the chat input" },
  { id: "ide.terminalAiCommand", title: "Generate Terminal Command with AI", does: "describe a task and prefill the chat to generate a terminal command" },
  { id: "ide.searchConversations", title: "Search Conversations", does: "search across agent conversations" },
  { id: "ide.openSettings", title: "Open IDE Agent Settings", does: "open the IDE Agent settings UI" },
  { id: "ide.terminalRunBackground", title: "Run Command in Background", does: "run a shell command in the background IDE Agent terminal with output streaming to chat" },
];

const PENDING = "engine wiring pending";

/** The live chat webview provider, when the chat view has been created. */
let activeChatView: ChatViewProvider | undefined;

function notifyScaffold(cmd: ScaffoldCommand): void {
  void vscode.window.showInformationMessage(
    `IDE Agent (scaffold): "${cmd.title}" — ${PENDING}. This will ${cmd.does}.`,
    "OK",
  );
}

export function activate(context: vscode.ExtensionContext): void {
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

  // ---- Chat tabs (doc-gap B8): each tab owns a full ComposerDataService —
  // its own bubbles/mode/queue/checkpoints/engine session. `tabs` is the
  // single owner; everything below resolves the active tab live.
  const tabs = new ChatTabService(context, hookService);
  context.subscriptions.push(tabs);
  // P1 (QA-MODELPICKER-01): keep the model selection honest when
  // ide.agent.enabledModels changes outside the Manage Models quickpick
  // (hand-edited settings.json), and re-validate once at startup in case the
  // persisted selection was disabled while the extension was off (covers the
  // composerDataService restore path without touching that file).
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("ide.agent.enabledModels")) {
        void reconcileSelectionWithAllowlist(tabs.activeComposer);
      }
    }),
  );
  void reconcileSelectionWithAllowlist(tabs.activeComposer);
  const terminal = new TerminalService(() => tabs.activeComposer);
  terminal.activate(context);

  // ---- MCP (Cursor parity, docs/rea/parity-rules-mcp.md §B) ----------------
  // Extension-host MCP client: .cursor/mcp.json discovery, stdio lifecycle,
  // mcp__<server>__<tool> namespacing, allowlist + HumanReview approval gate.
  activateMcp(context, () => tabs.activeComposer);

  // ---- Slash commands (Cursor / palette parity, parity-slash-commands.md) --
  const slash = new SlashCommandService(context, () => tabs.activeComposer);
  slash.restoreMru(context.globalState.get<string>("ideAgent.slashMru"));
  void slash.reloadCustomCommands();
  void slash.reloadSkills();
  context.subscriptions.push(slash);

  // ---- Inline edit (Cursor Cmd+K flow, parity C1–C8) -----------------------
  // prefillChat escalates to a full agent turn: submit the prepared prompt to
  // the chat composer and focus it (same pattern as ide.fixWithAI).
  const inlineEdit = new InlineEditService(context, {
    prefillChat: async (text: string) => {
      tabs.activeComposer.submit(text);
      await vscode.commands.executeCommand("ideAgent.chatView.focus");
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
      postImageToChat: (filePath, label, dataUrl) => {
        activeChatView?.postToWebview({ type: "addImageContext", filePath, label, dataUrl });
        void vscode.commands.executeCommand("ideAgent.chatView.focus");
      },
      postElementToChat: (label, content) => {
        activeChatView?.postToWebview({ type: "addSelectionContext", label, content });
        void vscode.commands.executeCommand("ideAgent.chatView.focus");
      },
    },
    () => vscode.workspace.getConfiguration("ide.browser").get<string>("chromiumPath", ""),
  );
  browserTabsRef = browserTabs;
  context.subscriptions.push({ dispose: () => void browserTabs.dispose() });

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
      case "ide.newChat":
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, () => {
            // P1 (CX1b): real new chat — clears bubbles, checkpoints, the
            // message queue and composer state of the ACTIVE tab. Refuses
            // while a turn runs.
            void tabs.activeComposer.newChat().then((ok) => {
              if (ok) {
                void vscode.commands.executeCommand("ideAgent.chatView.focus");
              }
            });
          }),
        );
        break;
      // Doc-gap B8: chat tabs are real now (ChatTabService) — new/next/
      // previous/select/close are wired, not scaffolds.
      case "ide.newAgentChat":
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, () => {
            tabs.createAndActivate({ mode: "agent" });
            void vscode.commands.executeCommand("ideAgent.chatView.focus");
          }),
        );
        break;
      case "ide.nextChatTab":
      case "ide.selectNextChat":
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, () => {
            tabs.nextTab();
            void vscode.commands.executeCommand("ideAgent.chatView.focus");
          }),
        );
        break;
      case "ide.previousChatTab":
      case "ide.selectPreviousChat":
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, () => {
            tabs.previousTab();
            void vscode.commands.executeCommand("ideAgent.chatView.focus");
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
          void vscode.commands.executeCommand("ideAgent.chatView.focus");
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
            void vscode.commands.executeCommand("ideAgent.chatView.focus");
          }),
        );
        break;
      }
      case "ide.acceptPlan":
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, () => void tabs.activeComposer.acceptPlan()),
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
      case "ide.manageModels":
        // M-04 (real): checkbox UI for ide.agent.enabledModels.
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, () => void manageModels(tabs.activeComposer)),
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
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, () => {
            const current = tabs.activeComposer.reviews.currentApproval;
            if (!current) {
              void vscode.window.showInformationMessage(
                "IDE Agent: no pending tool approval to respond to.",
              );
              return;
            }
            tabs.activeComposer.reviews.resolveApproval(current.approvalId, { optionId });
          }),
        );
        break;
      }
      case "ide.fixWithAI":
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, () => void fixWithAI(tabs.activeComposer)),
        );
        break;
      case "ide.addSelectionToChat":
        context.subscriptions.push(
          vscode.commands.registerCommand(cmd.id, () => addSelectionToChat()),
        );
        break;
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
          vscode.commands.registerCommand(cmd.id, () => void searchConversations(tabs.activeComposer)),
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
      default:
        // Browser tab commands (registered above in COMMANDS).
        if (cmd.id === "ide.openBrowserTab" || cmd.id === "ide.openBrowser") {
          context.subscriptions.push(
            vscode.commands.registerCommand(cmd.id, (url?: string) =>
              void browserTabs.open(typeof url === "string" ? url : undefined),
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
        } else {
          context.subscriptions.push(
            vscode.commands.registerCommand(cmd.id, () => notifyScaffold(cmd)),
          );
        }
        break;
    }
  }

  // ---- 2. Chat participant (@ide) ----------------------------------------
  const participant = vscode.chat.createChatParticipant(
    "ide.agent",
    async (
      request: vscode.ChatRequest,
      _chatContext: vscode.ChatContext,
      stream: vscode.ChatResponseStream,
      _token: vscode.CancellationToken,
    ): Promise<void> => {
      stream.progress("IDE Agent scaffold working…");
      stream.markdown(
        [
          "**IDE Agent (scaffold)** — the agent engine is not wired up yet.",
          "",
          "You asked:",
          "",
          `> ${request.prompt}`,
          "",
          "When the engine lands, `@ide` will run the full agent loop — plan, tools,",
          "edits, checkpoints — backed by the ide-code core. For now, try the IDE Agent",
          "sidebar view for the chat UI skeleton.",
        ].join("\n"),
      );
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

  // ---- 5. Default context keys for the contributed when-clauses ------------
  // P3 (QA-FILE-07): the four dead keys (promptBarVisible, promptBarFocused,
  // composerFocused, subagentTabsVisible) were removed — nothing ever sets
  // them true, and no when clause references them.
  const defaults: Array<[string, boolean]> = [
    ["ideAgent.chatInputFocused", false],
    ["ideAgent.toolApprovalVisible", false],
  ];
  for (const [key, value] of defaults) {
    void vscode.commands.executeCommand("setContext", key, value);
  }

  // ---- Tab completion engine ----
  // P2 (QA-04-VERIFY): surface activation failures instead of letting them
  // become unhandled rejections that silently disable Tab.
  // DEV-HOOKS: the Tab engine gets the hook service for beforeTabFileRead /
  // afterTabFileEdit (Cursor parity).
  activateTab(context, hookService).catch((err: unknown) => {
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

  // ---- Agents Window ----
  context.subscriptions.push(
    vscode.commands.registerCommand("ide.openAgentsWindow", () => {
      // Opens the Agents Window via the built-in workbench command
      // (workbench.action.openAgentsWindow), which routes through the
      // native host service to the main process.
      void vscode.commands.executeCommand("workbench.action.openAgentsWindow").then(
        undefined,
        () => {
          void vscode.window.showErrorMessage(
            "Could not open the Agents Window. Please try again.",
            "Retry"
          ).then(selection => {
            if (selection === "Retry") {
              void vscode.commands.executeCommand("ide.openAgentsWindow");
            }
          });
        }
      );
    })
  );
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
}

/** Read the chat UI settings into a webview-safe snapshot. */
export function readChatUiConfig(): IdeChatUiConfig {
  const composer = vscode.workspace.getConfiguration("ide.composer");
  const general = vscode.workspace.getConfiguration("ide.general");
  const scale = composer.get<number>("textSizeScale", 1);
  const density = composer.get<string>("conversationDensity", "compact-all-grouped");
  return {
    textSizeScale: [0.85, 1, 1.15, 1.3].includes(scale) ? scale : 1,
    conversationDensity:
      density === "detailed" || density === "compact-ungrouped" ? density : "compact-all-grouped",
    codeBlockWordWrap: composer.get<boolean>("codeBlockWordWrap", false),
    showEmptyStateTips: composer.get<boolean>("showEmptyStateTips", true),
    fontSmoothingAntialiased: general.get<boolean>("fontSmoothingAntialiased", true),
    cmdPFilePicker: composer.get<boolean>("cmdPFilePicker2", true),
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
 */
async function reconcileSelectionWithAllowlist(composer: ComposerDataService): Promise<boolean> {
  const allowlist = getEnabledModels();
  const current = composer.models.getSelection();
  if (!current.ref || isModelEnabled(current.ref, allowlist)) {
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
      void vscode.window.showWarningMessage(
        `IDE Agent: could not switch the engine to auto after disabling "${current.label}" — ${message}. ` +
          "New turns may still use the disabled model; check the IDE Agent output channel.",
      );
    }
  }
  composer.models.setSelection({ label: "auto" });
  return true;
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

async function pickModel(composer: ComposerDataService): Promise<void> {
  const models = await loadEngineModels(composer, "the model picker");
  if (!models) return;
  const adapter = composer.getEngineAdapter();
  const enabledModels = getEnabledModels();
  const enabled = filterEnabledModels(models, enabledModels);
  const disabledCount = models.length - enabled.length;

  const current = composer.models.getSelection();
  interface ModelPickItem extends vscode.QuickPickItem {
    ref?: ModelRef;
  }
  const items: ModelPickItem[] = [
    {
      label: "auto (engine default)",
      description: current.ref ? undefined : "(current)",
      ref: undefined,
    },
  ];
  const byProvider = new Map<string, EngineModelInfo[]>();
  for (const m of enabled) {
    const list = byProvider.get(m.providerID);
    if (list) {
      list.push(m);
    } else {
      byProvider.set(m.providerID, [m]);
    }
  }
  for (const provider of [...byProvider.keys()].sort()) {
    items.push({ label: provider, kind: vscode.QuickPickItemKind.Separator });
    const list = byProvider.get(provider)!;
    list.sort((a, b) => ModelService.labelFor(a).localeCompare(ModelService.labelFor(b)));
    for (const m of list) {
      const ref: ModelRef = {
        id: m.id,
        providerID: m.providerID,
        ...(m.variant ? { variant: m.variant } : {}),
      };
      items.push({
        label: ModelService.labelFor(m),
        description: m.name && m.name !== m.id ? m.id : undefined,
        detail: ModelService.refEquals(current.ref, ref) ? "(current)" : undefined,
        ref,
      });
    }
  }

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
  const label = picked.ref ? picked.label : "auto";
  const selection: ModelSelection = picked.ref ? { ref: picked.ref, label } : { label: "auto" };
  // Switch on the engine FIRST; persist + notify the webview only on success,
  // so the composer never shows a model the engine rejected.
  try {
    await adapter.setModel!(picked.ref);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`IDE Agent: the engine rejected the model switch — ${message}.`);
    return;
  }
  composer.models.setSelection(selection);
  void vscode.window.showInformationMessage(
    picked.ref
      ? `IDE Agent: model set to "${label}". Applies to new turns immediately.`
      : 'IDE Agent: model set to auto (engine default) for new turns; existing sessions keep their model until a new chat.',
  );
}

/**
 * M-09 (real): cycle to the next ENABLED model.
 *
 * Loads the engine catalog, skips models disabled via ide.agent.enabledModels,
 * switches the engine to the next one after the current selection (wrapping),
 * and persists the selection — the composer header model button and the
 * status bar item update via the modelChanged event. Switching happens on the
 * engine first so the UI never shows a model the engine rejected.
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
async function manageModels(composer: ComposerDataService): Promise<void> {
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
  // P1 (QA-MODELPICKER-01): reconcile via the shared helper so the engine is
  // switched to auto too — the UI must never say "auto" while the engine
  // keeps burning the model the user just disabled.
  const current = composer.models.getSelection();
  const reconciled = await reconcileSelectionWithAllowlist(composer);
  if (reconciled) {
    void vscode.window.showInformationMessage(
      `IDE Agent: "${current.label}" was disabled — model reset to auto (engine default).`,
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

/** K-parity: generate a git commit message from the staged diff.
 *
 * Asks the agent for a one-line message, waits for the turn, then fills the
 * Source Control input box (falls back to offer-copy when the git API is
 * unavailable). Mirrors cursor.composer.generateGitCommitMessage.
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
  const diff = await runGit(folder, ["diff", "--cached", "--", "."]);
  if (!diff.trim()) {
    void vscode.window.showInformationMessage(
      "IDE Agent: no staged changes — stage something first (git add).",
    );
    return;
  }
  if (composer.isRunning) {
    void vscode.window.showWarningMessage("IDE Agent: wait for the current turn to finish first.");
    return;
  }
  const stat = await runGit(folder, ["diff", "--cached", "--stat", "--", "."]);
  const before = new Set(composer.bubbles.getOrderedIds());
  composer.submit(
    `Write a single git commit message for the staged changes below. Rules: imperative mood, ` +
      `subject line of 72 characters or fewer, no body unless the change needs explanation, ` +
      `output ONLY the message text — no code fences, no explanation.\n\n${stat}\n\n${diff.slice(0, 12000)}`,
  );
  const message = await waitForNewAssistantText(composer, before, 180_000);
  const cleaned =
    message
      .replace(/^```[a-z]*\s*/i, "")
      .replace(/\s*```$/, "")
      .trim()
      .split("\n")[0]
      ?.trim() ?? "";
  if (!cleaned) {
    void vscode.window.showWarningMessage("IDE Agent: the agent did not produce a commit message.");
    return;
  }
  const repo = findGitRepo(folder);
  if (repo) {
    repo.inputBox.value = cleaned;
    void vscode.window.showInformationMessage(
      "IDE Agent: commit message generated — review it in Source Control before committing.",
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

/** Run git and return stdout ("" on any failure). */
function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    childProcess.execFile(
      "git",
      args,
      { cwd, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => resolve(err ? "" : stdout),
    );
  });
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
async function fixWithAI(composer: ComposerDataService): Promise<void> {
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
  await vscode.commands.executeCommand("ideAgent.chatView.focus");
}

/** K-07 (Cursor parity): Cmd/Ctrl+Shift+L — attach the editor selection as a chip in the chat input. */
function addSelectionToChat(): void {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    void vscode.window.showInformationMessage("IDE Agent: select code in the editor first.");
    return;
  }
  const doc = editor.document;
  const sel = editor.selection;
  const label = `selection:${vscode.workspace.asRelativePath(doc.uri)}:${sel.start.line + 1}`;
  const content = doc.getText(sel);
  void vscode.commands.executeCommand("ideAgent.chatView.focus").then(() => {
    activeChatView?.postToWebview({ type: "addSelectionContext", label, content });
  });
}


/** Conversation search across agent turns. */
async function searchConversations(composer: ComposerDataService): Promise<void> {
  // ENGINE: list real sessions when the session store lands; for now the
  // transcript's human turns are the searchable conversations.
  const humans = composer.bubbles.getAllInOrder().filter((b) => b.role === "human");
  if (!humans.length) {
    void vscode.window.showInformationMessage("IDE Agent: no conversations yet.");
    return;
  }
  const picked = await vscode.window.showQuickPick(
    humans.map((b) => ({
      label: b.text.slice(0, 80) || "(empty)",
      description: new Date(b.createdAt).toLocaleString(),
      id: b.bubbleId,
    })),
    { placeHolder: "Search conversations", matchOnDescription: true },
  );
  if (picked) {
    await vscode.commands.executeCommand("ideAgent.chatView.focus");
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

  const defaultDir = service.defaultWorktreePath(root, trimmed);
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
        const { execFile } = await import("node:child_process");
        const { promisify } = await import("node:util");
        await promisify(execFile)("git", ["merge", "--no-edit", picked.branch], { cwd: root, timeout: 120_000 });
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
  | { type: "openModelPicker" }
  | { type: "inputFocus"; focused: boolean }
  | { type: "approvalResolve"; approvalId: string; optionId: string }
  | { type: "webviewReady" }
  | { type: "stopTurn" }
  // Cursor parity: per-human-message Restore button → checkout_to_message.
  | { type: "restoreCheckpoint"; bubbleId: string }
  // Doc-gap B8: chat tab bar controls.
  | { type: "newTab" }
  | { type: "switchTab"; tabId: string }
  | { type: "closeTab"; tabId: string }
  | { type: "renameTab"; tabId: string; title: string }
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
          case "openModelPicker":
            void pickModel(this.composer);
            break;
          case "inputFocus":
            void vscode.commands.executeCommand("setContext", "ideAgent.chatInputFocused", message.focused === true);
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
            break;
          // P1 (QA-FILE-01): Stop button → abort the running turn.
          case "stopTurn":
            this.composer.abort();
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
            void vscode.commands.executeCommand(
              "setContext",
              "ideAgent.toolApprovalVisible",
              request !== undefined,
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
                      void vscode.commands.executeCommand("ideAgent.chatView.focus");
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
    void this.post(message);
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
}
