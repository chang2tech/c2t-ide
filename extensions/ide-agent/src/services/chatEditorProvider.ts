import * as vscode from "vscode";
import { ChatTab, ChatTabService, ChatTabEvent } from "./chatTabService";
import { ComposerDataService, ComposerEvent, SubmitSendMode } from "./composerDataService";
import { CONTEXT_REDUCTION_PROMPT } from "./contextUsageReport";
import { MentionService, MentionChip, isMentionChip, FileAttachment } from "./mentionService";
import { createComposer } from "../components/composer";
import {
  copyBubbleMessageToClipboard,
  makeCopyMessageSeam,
} from "./chatCopyMessageService";
import {
  copyPendingPlanMarkdownToClipboard,
  makePlanCopySeam,
} from "./planCopyService";
import { CHAT_INPUT_EMPTY_CONTEXT_KEY } from "./chatJumpMessages";
import { findBarContextUpdates } from "./findInChat";
import { planFindBarContextUpdates, planTrayContextUpdates } from "./findInPlan";
import {
  CURSOR_MENTION_LINK_TOOLBAR_ID,
  mentionLinkToolbarController,
} from "./mentionLinkToolbar";
import { cycleMode, customModeBadgeAppearance } from "./modeService";
import type { CustomModeSession } from "./modeService";
import { DebugModeController } from "./debugModeController";
import type { ModeName } from "../model";
import type { TerminalService } from "./terminalService";
import type { SlashCommandService } from "./slashCommandService";
import type { QueuedMessage } from "./messageQueueService";
import { saveUserImageDataUrl } from "../browser/chromium";
import { emitTooltipEvent, forwardWebviewTooltipEvent } from "./tooltipEvents";
import {
  forkInfoMessage,
  forkTabFromBubble,
} from "./chatForkFromBubble";

/**
 * Chat editor tabs — Cursor parity (dig-chattab-editor-menu-2026-10-19).
 *
 * In Cursor, chat tabs are REAL editor tabs (view category "Chat Editors"),
 * so the native editor title context menu (Close/Split/Pin/Move into New
 * Window/…) works on them. Our tabs used to live in a single sidebar
 * webview with a self-drawn tab bar — no native menu.
 *
 * This module registers a VS Code custom editor provider: each ChatTab gets
 * a document URI `ide-chat:/<tabId>` and opens as a real editor. One tab =
 * one ComposerDataService (unchanged architecture — ChatTabService still
 * owns tab lifetimes).
 */

export const CHAT_EDITOR_VIEW_TYPE = "ideAgent.chatEditor";
export const CHAT_EDITOR_SCHEME = "ide-chat";

/** Document URI for a chat tab. */
export function chatEditorUriForTab(tabId: string): vscode.Uri {
  return vscode.Uri.from({ scheme: CHAT_EDITOR_SCHEME, path: `/${tabId}` });
}

/** Tab id from a chat editor document URI (undefined for foreign URIs). */
export function tabIdFromUri(uri: vscode.Uri): string | undefined {
  if (uri.scheme !== CHAT_EDITOR_SCHEME) {
    return undefined;
  }
  // P3-5 (QA-CHATEDITOR): reject anything that isn't exactly `/<tabId>`.
  // `ide-chat:/../../..` used to produce a garbage id that then missed every
  // lookup — fail closed here instead.
  const id = uri.path.replace(/^\//, "");
  if (!id || id.includes("/") || id === "." || id === ".." || id.includes("..")) {
    return undefined;
  }
  return id;
}

export interface ChatEditorDeps {
  terminal?: TerminalService;
  slash?: SlashCommandService;
  /** Shared model picker (lives in extension.ts). */
  pickModel: (composer: ComposerDataService) => Promise<void>;
  /** Shared chat UI config reader (lives in extension.ts). */
  readChatUiConfig: () => unknown;
}

/** Minimal document — the tab (and its composer) is owned by ChatTabService. */
export class ChatEditorDocument implements vscode.CustomDocument {
  constructor(
    readonly uri: vscode.Uri,
    readonly tab: ChatTab,
  ) {}
  dispose(): void {
    // Tab lifetime is owned by ChatTabService, not the document.
  }
}

/** Serialize the message queue for the webview (mirrors extension.ts). */
function serializeQueue(items: QueuedMessage[]): Array<{ id: string; text: string; mode: string }> {
  return items.map((m) => ({ id: m.id, text: m.text, mode: m.mode }));
}

function isModeName(value: string): value is ModeName {
  return (
    value === "agent" ||
    value === "chat" ||
    value === "edit" ||
    value === "debug" ||
    value === "multitask" ||
    value === "plan"
  );
}

/** Prefix listing every open text file as @-context (mirrors extension.ts). */
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

type WebviewMessage =
  | { type: "submit"; text: string; fullContext?: boolean; mentions?: unknown[]; sendMode?: "default" | "manual" | "queue" | "sendNow" }
  | { type: "setMode"; mode: string }
  | { type: "cycleMode" }
  | { type: "acceptPlan" }
  | { type: "discardPlan" }
  // DEV-GAPS-77 (W77D): Cursor `glass.copy-plan-markdown` parity — the plan
  // tray's "Copy as Markdown" button (binary PlanTabContent `onCopyAsMarkdown`).
  | { type: "copyPlanMarkdown" }
  | { type: "openModelPicker" }
  // GAPS-167 (canvas-context-usage-report): see extension.ts union.
  | { type: "openContextUsageReport" }
  | { type: "debugContextUsage" }
  | { type: "inputFocus"; focused: boolean }
  | { type: "inputEmpty"; empty: boolean }  // DEV-GAPS-119: prompt emptiness -> ideAgent.chatInputEmpty (glassPromptInputEmpty analog)
  | { type: "findBarState"; open: boolean; inputFocused?: boolean }  // DEV-GAPS-29 + GAPS-134: find-bar state -> composerFindWidgetFocused + glassChatFindBarVisible/glassChatFindInputFocused
  | { type: "planFindBarState"; open: boolean; inputFocused?: boolean }  // GAPS-157: plan find-bar state -> glassPlanFindBarVisible + glassFindInputFocused
  | { type: "approvalResolve"; approvalId: string; optionId: string }
  // GAPS-176: webview-reported tooltip-pipeline chat events (allowlist in
  // services/tooltipEvents.ts) -> core bridge `composer.tooltip.registerEvent`.
  | { type: "tooltipEvent"; event: string }
  | { type: "webviewReady" }
  | { type: "stopTurn" }
  | { type: "restoreCheckpoint"; bubbleId: string }
  // Cursor parity — per-message "Fork Chat" (binary 3.25.9: `jav` in
  // AgentTranscriptTurnActions.js + command `composer.duplicateChat` with
  // {sourceComposerId, bubbleId}: retain the transcript through the
  // selected bubble, then deep-clone into a new chat).
  | { type: "forkChatFromBubble"; bubbleId: string }
  // DEV-GAPS-73 (chat-copy-message): per-message "Copy Message" —
  // clipboard + trackEvent('composer.copy_message') + verbatim toast.
  | { type: "copyMessage"; bubbleId: string }
  // Edit-resubmit: user edited a sent message → resubmit dialog → truncate + resubmit.
  | { type: "resubmitEditedMessage"; bubbleId: string; text: string }
  | { type: "newTab" }
  | { type: "switchTab"; tabId: string }
  | { type: "closeTab"; tabId: string }
  | { type: "renameTab"; tabId: string; title: string }
  /** Cursor 2.1 pin parity (no-op UI here — native editor tabs have no
   * self-drawn bar; the native title menu drives pin/unpin via commands). */
  | { type: "pinTab"; tabId: string }
  | { type: "unpinTab"; tabId: string }
  | { type: "queueRemove"; id: string }
  | { type: "queueMove"; id: string; direction: -1 | 1 }
  | { type: "queueSendNow"; id: string }
  | { type: "answerQuestion"; questionId: string; optionId?: string; optionIds?: string[] }
  | { type: "mentionQuery"; requestId: number; query: string }
  | { type: "openMention"; chip: unknown }
  // GAPS-131 (mention-link-toolbar): mirror of the ChatViewProvider
  // messages in extension.ts for the editor-tab surface.
  | { type: "mentionLinkToolbar"; x: number; y: number; link: string; uuid?: string }
  | { type: "mentionLinkToolbarOpen"; link: string }
  | { type: "mentionLinkToolbarClose" }
  /** DEV-DEBUG-HOLD-UI (spec D5): Enter on empty input / Proceed button in debug mode. */
  | { type: "debugProceed" }
  /** DEV-DEBUG-HOLD-UI (spec D5): Mark fixed button in debug mode. */
  | { type: "debugMarkFixed" }
  /** agent-image-files-disk-convention: webview posts pasted/dropped images as data URLs. */
  | { type: "addUserImage"; dataUrl: string; fileName?: string }
  /**
   * GAPS-46D (agent-custom-modes): Alt+Enter / "Use as Mode" on a `/` menu
   * skill entry — enter a custom mode backed by that skill.
   */
  | { type: "useSkillAsMode"; name: string }
  /** GAPS-46D (agent-custom-modes): exit the active custom mode. */
  | { type: "exitCustomMode" };

/** Serialize the active custom mode for the webview badge (label + badge styling). */
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

/**
 * Per-editor webview host, bound to ONE fixed tab. Mirrors the message
 * handling of the sidebar ChatViewProvider but without the tab bar (native
 * editor tabs replace it) and without active-tab filtering.
 */
class ChatEditorHost implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly mentions: MentionService;
  private disposed = false;
  /**
   * DEV-DEBUG-HOLD-UI: per-chat debug state (dispatch hold + Debug Logs
   * feed + proceed flow). Created in resolve(); undefined before that.
   */
  private debugController: DebugModeController | undefined;
  /**
   * P2-3/P2-4 (QA-CHATEDITOR): outbound messages posted before the webview
   * signals `webviewReady` are buffered and flushed in order — posting to a
   * webview whose scripts haven't loaded yet would silently drop the chip.
   *
   * REVERIFY-P3-1 (NF-1): the buffer is bounded (100) like the sidebar path —
   * an unbounded buffer is a memory leak if the webview never becomes ready.
   * Oldest messages drop first when over cap.
   */
  private readonly pendingOutbound: unknown[] = [];
  private static readonly MAX_PENDING_OUTBOUND = 100;
  private webviewReady = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly tabs: ChatTabService,
    private readonly tab: ChatTab,
    private readonly panel: vscode.WebviewPanel,
    private readonly deps: ChatEditorDeps,
  ) {
    this.mentions = new MentionService(deps.terminal, tab.composer.projectRules);
  }

  /** Post a host→webview message to THIS tab (buffers until the webview is ready). */
  postToWebview(message: unknown): void {
    if (this.disposed) {
      return;
    }
    if (this.webviewReady) {
      void this.post(message);
    } else {
      // REVERIFY-P3-1 (NF-1): bound the buffer — drop oldest first.
      if (this.pendingOutbound.length >= ChatEditorHost.MAX_PENDING_OUTBOUND) {
        this.pendingOutbound.shift();
      }
      this.pendingOutbound.push(message);
    }
  }

  private get composer(): ComposerDataService {
    return this.tab.composer;
  }

  resolve(): void {
    const { panel, composer } = this;
    // GAPS-176: `chat.open` — the chat editor surface materializes here
    // (open / re-resolve), exactly once per resolve. NOT emitted on tab
    // reveals of an already-resolved editor: a repeated `chat.open` would
    // reset the editor pipeline's sequence 2 in the core matcher (see
    // work-notes-gaps176.md Slice 1).
    emitTooltipEvent("chat.open");
    panel.webview.options = { enableScripts: true };
    const uiLang = vscode.env.language || "en";
    const uiDir = /^(ar|he|fa|ur|yi|ps|sd|ckb|dv)(-|$)/i.test(uiLang) ? "rtl" : "ltr";
    panel.webview.html = createComposer(
      panel.webview,
      composer.modes.getMode(),
      composer.isEngineConnected,
      uiLang,
      uiDir,
      composer.models.getSelection().label,
      this.deps.readChatUiConfig() as never,
    );
    panel.title = this.tab.title;
    this.postFullState();
    // Hide the webview's self-drawn tab bar — native editor tabs replace it.
    this.postToWebview({ type: "tabs", tabs: [] });
    // ORANGE-DOT (DEV-GAPS-14, 2026-10-20): Cursor's orange dot
    // (cursor.com/changelog/0-48-x: "When a tab is awaiting your input,
    // you'll see an orange dot on that tab") now renders on the NATIVE
    // editor tab too. VS Code's extension API exposes no per-tab
    // badge/decoration API (TabInputCustom has no badge; tab.dirty is
    // read-only; FileDecorationProvider does not render on editor tabs),
    // so this is a workbench-core patch drawing native DOM in the tab
    // strip: extension.ts runs ChatTabBadgeSync (services/chatTabBadgeSync.ts),
    // which pushes approval/question-pending state over the
    // `ide.chat.setEditorTabBadge` bridge command to IEditorTabBadgeService
    // (src/vs/workbench/browser/parts/editor/editorTabBadges.ts); the tab
    // controls toggle the `awaiting-input` class and CSS draws the dot.
    // The exact Cursor orange hex is UNKNOWN — the dot uses the
    // `tab.awaitingInputDot` theme color with the same #e8a13c fallback the
    // webview tab bar dot uses, not a claimed Cursor value.
    // DEV-DEBUG-HOLD-UI: per-chat debug controller (dispatch hold, Debug
    // Logs feed, proceed/mark-fixed flow). State posts buffer until the
    // webview signals webviewReady.
    this.debugController = new DebugModeController(composer, (message) =>
      this.postToWebview(message),
    );
    this.debugController.syncInitialState();
    this.disposables.push(this.debugController);

    this.disposables.push(
      this.tabs.onDidChange((tabEvent: ChatTabEvent) => {
        if (this.disposed) {
          return;
        }
        if (tabEvent.kind === "tabsChanged") {
          // Keep the native editor title in sync with the chat title.
          const tab = this.tabs.listTabs().find((t) => t.id === this.tab.id);
          if (tab && this.panel.title !== tab.title) {
            this.panel.title = tab.title;
          }
          return;
        }
        if (tabEvent.tabId !== this.tab.id) {
          return;
        }
        this.handleComposerEvent(tabEvent.event);
      }),
      // Approval card for this tab.
      this.tab.composer.reviews.onDidChangeApproval((request) => {
        if (this.disposed) {
          return;
        }
        this.postToWebview({ type: "approval", request: request ?? null });
      }),
      // Live-apply chat UI settings.
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("ide.composer") || e.affectsConfiguration("ide.general")) {
          this.postToWebview({ type: "uiConfig", ui: this.deps.readChatUiConfig() });
        }
      }),
      panel.webview.onDidReceiveMessage((message: WebviewMessage) => {
        if (this.disposed) {
          return;
        }
        this.handleMessage(message);
      }),
      panel.onDidDispose(() => this.dispose()),
    );
  }

  private async post(message: unknown): Promise<void> {
    if (!this.disposed) {
      await this.panel.webview.postMessage(message);
    }
  }

  /** Full transcript sync (initial resolve / re-resolve). Buffered until webviewReady. */
  private postFullState(): void {
    const composer = this.composer;
    this.postToWebview({ type: "state", bubbles: composer.bubbles.getAllInOrder() });
    this.postToWebview({
      type: "queue",
      length: composer.queue.length,
      items: serializeQueue(composer.queue.getItems()),
    });
    this.postToWebview({ type: "turnState", running: composer.isRunning });
    // Context ring: initial live breakdown (later deltas arrive via the
    // `contextUsage` composer event → handleComposerEvent).
    this.postToWebview({ type: "ctxUsage", ...composer.getContextUsageSnapshot() });
    this.postToWebview({ type: "approval", request: composer.reviews.currentApproval ?? null });
    this.postToWebview({ type: "mode", mode: composer.modes.getMode() });
    this.postToWebview({ type: "model", label: composer.models.getSelection().label });
    // GAPS-46D (agent-custom-modes): restore the custom-mode badge on
    // re-resolve (the mode survives webview reloads).
    this.postToWebview({
      type: "customMode",
      active: serializeCustomMode(composer.getActiveCustomMode()),
      exitedLabel: null,
    });
    for (const q of composer.getPendingQuestions()) {
      this.postToWebview({ type: "question", question: q });
    }
  }

  private handleComposerEvent(event: ComposerEvent): void {
    const composer = this.composer;
    switch (event.kind) {
      case "bubblesChanged": {
        const bubbles = event.ids
          .map((id) => composer.bubbles.getBubbleData(id))
          .filter((b): b is NonNullable<typeof b> => b !== undefined);
        this.postToWebview({ type: "bubbles", bubbles });
        break;
      }
      case "bubblesReset": {
        this.postToWebview({ type: "state", bubbles: composer.bubbles.getAllInOrder() });
        break;
      }
      case "newChat": {
        this.postToWebview({ type: "newChat" });
        break;
      }
      case "queueChanged": {
        this.postToWebview({ type: "queue", length: event.length, items: serializeQueue(event.items) });
        break;
      }
      case "modeChanged": {
        this.postToWebview({ type: "mode", mode: event.mode });
        // DEV-DEBUG-HOLD-UI (spec D2): leaving debug releases held
        // dispatches; (re-)entering replays buffered log lines.
        this.debugController?.onModeChanged(event.mode === "debug");
        break;
      }
      // GAPS-46D (agent-custom-modes): push badge state to the webview.
      case "customModeChanged": {
        this.postToWebview({
          type: "customMode",
          active: serializeCustomMode(event.active),
          exitedLabel: event.exitedLabel,
        });
        break;
      }
      case "planReady": {
        // GAPS-157: carry the plan's bubbleId (webview plan find scope)
        // and maintain the fork-only `composerPlanTrayVisible` key —
        // same bridge as the sidebar surface (extension.ts).
        this.postToWebview({ type: "planReady", bubbleId: event.plan.bubbleId });
        for (const [key, value] of planTrayContextUpdates(true)) {
          void vscode.commands.executeCommand("setContext", key, value);
        }
        break;
      }
      case "planCleared": {
        this.postToWebview({ type: "planCleared" });
        for (const [key, value] of planTrayContextUpdates(false)) {
          void vscode.commands.executeCommand("setContext", key, value);
        }
        break;
      }
      case "questionAsked": {
        this.postToWebview({ type: "question", question: event.question });
        break;
      }
      case "questionAnswered": {
        this.postToWebview({ type: "questionAnswered", questionId: event.questionId });
        break;
      }
      case "turnState": {
        this.postToWebview({ type: "turnState", running: event.running });
        if (!event.running) {
          this.onTurnSettled();
        }
        break;
      }
      case "restorePrompt": {
        // GAPS-11B (agent-abort-restore-query): put the aborted turn's
        // prompt back into the composer input for editing (Cursor parity).
        this.postToWebview({ type: "restoreInput", text: event.text });
        break;
      }
      case "contextUsage": {
        // Context ring: host-computed real 8-category breakdown, live after
        // every settled turn. tokens are chars/4 estimates (see
        // contextUsageService.ts honesty contract) — never fabricated.
        this.postToWebview({
          type: "ctxUsage",
          sources: event.sources,
          totalTokens: event.totalTokens,
          windowPct: event.windowPct,
          // GAPS-183: the denominator windowPct was computed against.
          contextWindowTokens: event.contextWindowTokens,
        });
        break;
      }
      case "checkpointRestored": {
        this.postToWebview({ type: "checkpointRestored", bubbleId: event.bubbleId });
        break;
      }
      case "engineStatus": {
        this.postToWebview({ type: "engineStatus", connected: event.connected });
        break;
      }
      case "modelChanged": {
        this.postToWebview({ type: "model", label: event.selection.label });
        break;
      }
    }
  }

  /**
   * DEV-DEBUG-HOLD-UI (spec D4): when a debug-mode turn ends, the controller
   * arms the dispatch hold until the user reproduces the bug (proceed /
   * mark-fixed) or sends another message. This is the client's
   * approximation of Cursor's "instrument → wait for repro" gate: the agent
   * instruments, the turn settles, and the user reproduces in their app
   * while the queue stays held.
   */
  private onTurnSettled(): void {
    if (this.disposed || !this.debugController) {
      return;
    }
    if (this.composer.modes.getMode() === "debug") {
      this.debugController.onDebugTurnSettled();
    }
  }

  private handleMessage(message: WebviewMessage): void {
    const composer = this.composer;
    switch (message.type) {
      case "submit":
        // DEV-DEBUG-HOLD-UI: any normal user message submit clears the
        // debug repro wait and releases the queue hold.
        this.debugController?.onUserSubmit();
        if (typeof message.text === "string") {
          const chips: MentionChip[] = Array.isArray(message.mentions)
            ? message.mentions.filter(isMentionChip)
            : [];
          const parsed = this.deps.slash?.parseLeadingCommand(message.text) ?? null;
          const fullCtx = message.fullContext === true;
          const sendMode =
            message.sendMode === "manual" || message.sendMode === "queue" || message.sendMode === "sendNow"
              ? message.sendMode
              : "default";
          if (parsed) {
            const prefix = fullCtx ? fullContextPrefix() : "";
            void this.mentions
              .composePromptWithMentions(parsed.rest, chips)
              .then((restComposed) => {
                const restText = this.deps.terminal
                  ? this.deps.terminal.expandTerminalMentions(restComposed)
                  : restComposed;
                return this.runSlashCommand(parsed.name, parsed.args, prefix + restText);
              })
              .catch(() => this.runSlashCommand(parsed.name, parsed.args, parsed.rest));
          } else {
            const raw = fullCtx ? fullContextPrefix() + message.text : message.text;
            const attachments: FileAttachment[] = this.mentions.extractFileAttachments(chips);
            const submitOpts: { sendMode: SubmitSendMode; attachments?: FileAttachment[] } = {
              sendMode,
              ...(attachments.length > 0 ? { attachments } : {}),
            };
            void this.mentions
              .composePromptWithMentions(raw, chips)
              .then((withMentions) => {
                const text = this.deps.terminal
                  ? this.deps.terminal.expandTerminalMentions(withMentions)
                  : withMentions;
                composer.submit(text, submitOpts);
              })
              .catch(() => composer.submit(raw, submitOpts));
          }
        }
        break;
      case "debugProceed":
        // DEV-DEBUG-HOLD-UI (spec D5): Enter on empty input in debug mode,
        // or the Proceed button — submits "Issue reproduced, please proceed".
        this.debugController?.proceed();
        break;
      case "debugMarkFixed":
        // DEV-DEBUG-HOLD-UI (spec D5): Mark fixed button — submits
        // "The issue has been fixed. Please clean up the instrumentation."
        this.debugController?.markFixed();
        break;
      // GAPS-46D (agent-custom-modes): Alt+Enter / "Use as Mode" on a `/`
      // menu skill entry — enter a custom mode backed by that skill.
      case "useSkillAsMode":
        this.enterSkillAsMode(message.name);
        break;
      case "exitCustomMode":
        this.composer.exitCustomMode();
        break;
      case "addUserImage": {
        // agent-image-files-disk-convention: the webview posts pasted/dropped
        // images as data URLs. Save to disk (never base64 in the context) and
        // feed back through the existing addImageContext chip flow, so the
        // image becomes an engine file attachment and an <image_files> block
        // entry on submit.
        if (typeof message.dataUrl === "string") {
          try {
            const workspaceFsPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            const filePath = saveUserImageDataUrl(message.dataUrl, workspaceFsPath);
            const label = typeof message.fileName === "string" && message.fileName ? message.fileName : "Attached image";
            void this.post({ type: "addImageContext", filePath, label, dataUrl: message.dataUrl });
          } catch (err) {
            void vscode.window.showWarningMessage(
              `IDE Agent: could not attach image (${err instanceof Error ? err.message : String(err)})`,
            );
          }
        }
        break;
      }
      case "mentionQuery":
        if (typeof message.requestId === "number" && typeof message.query === "string") {
          const requestId = message.requestId;
          void this.mentions
            .getMentionItems(message.query)
            .then((items) => this.post({ type: "mentionItems", requestId, items, isLoading: false }))
            .catch(() => this.post({ type: "mentionItems", requestId, items: [], isLoading: false }));
        }
        break;
      case "openMention":
        if (isMentionChip(message.chip)) {
          void this.openMentionTarget(message.chip).catch(() => undefined);
        }
        break;
      // GAPS-131 (mention-link-toolbar): mirror of extension.ts
      // ChatViewProvider — run the binary-verbatim command, open the
      // link externally on "Open", resolve the controller on close.
      case "mentionLinkToolbar":
        if (
          typeof message.x === "number" &&
          typeof message.y === "number" &&
          typeof message.link === "string"
        ) {
          void vscode.commands.executeCommand(CURSOR_MENTION_LINK_TOOLBAR_ID, {
            x: message.x,
            y: message.y,
            link: message.link,
            uuid: typeof message.uuid === "string" ? message.uuid : undefined,
          });
        }
        break;
      case "mentionLinkToolbarOpen":
        if (
          typeof message.link === "string" &&
          (message.link.startsWith("https://") || message.link.startsWith("http://"))
        ) {
          void vscode.env.openExternal(vscode.Uri.parse(message.link));
        }
        mentionLinkToolbarController.closeMentionLinkToolbar();
        break;
      case "mentionLinkToolbarClose":
        mentionLinkToolbarController.closeMentionLinkToolbar();
        break;
      case "setMode":
        if (isModeName(message.mode)) {
          composer.modes.setMode(message.mode);
        }
        break;
      case "cycleMode":
        composer.modes.setMode(cycleMode(composer.modes.getMode()));
        break;
      case "acceptPlan":
        composer.acceptPlan();
        break;
      case "discardPlan":
        composer.discardPlan();
        break;
      case "copyPlanMarkdown":
        // DEV-GAPS-77 (W77D): Cursor `glass.copy-plan-markdown` parity —
        // plan tray "Copy as Markdown" -> binary-verbatim copy/toast/log flow
        // (planCopyService.ts). performCopy never throws (the binary's catch
        // logs), but keep the defensive guard like the copyMessage case.
        void copyPendingPlanMarkdownToClipboard(composer, makePlanCopySeam()).catch(
          (err: unknown) => {
            const m = err instanceof Error ? err.message : String(err);
            void vscode.window.showErrorMessage(`IDE Agent: copy failed — ${m}`);
          },
        );
        break;
      case "openModelPicker":
        void this.deps.pickModel(composer);
        break;
      case "openContextUsageReport":
        // GAPS-167: see extension.ts — report built from real measured data.
        this.postToWebview({
          type: "ctxUsageReport",
          report: composer.getContextUsageReport({
            chatName: this.tab.title,
            repository: vscode.workspace.workspaceFolders?.[0]?.name,
          }),
        });
        break;
      case "debugContextUsage": {
        // GAPS-167: new chat tab seeded with the verbatim reduction prompt.
        const created = this.tabs.createAndActivate({});
        created.composer.submit(CONTEXT_REDUCTION_PROMPT);
        break;
      }
      case "inputFocus":
        void vscode.commands.executeCommand("setContext", "ideAgent.chatInputFocused", message.focused === true);
        break;
      case "tooltipEvent":
        // GAPS-176: forward allowlisted webview chat events (chat.type /
        // chat.paste / chat.copy.codeblock.manual / chat.insert_selection.*)
        // to the core tooltipService bridge.
        forwardWebviewTooltipEvent(message.event);
        break;
      case "inputEmpty":
        // DEV-GAPS-119 (chat-jump-messages-kbd): the webview reports prompt
        // emptiness; core mirrors ideAgent.chatInputEmpty to
        // composer.chatInputEmpty for the jump keybindings' when-clause
        // (!inputFocus || prompt empty — the binary's glassPromptInputEmpty
        // conjunct in `gno`, glass @45335715).
        void vscode.commands.executeCommand("setContext", CHAT_INPUT_EMPTY_CONTEXT_KEY, message.empty === true);
        break;
      case "findBarState":
        // DEV-GAPS-29: same find-bar state bridge as the sidebar surface —
        // gates the core composer.find.hide/next/previous keybindings.
        // GAPS-134: also maintains the pane-level family's verbatim keys
        // glassChatFindBarVisible / glassChatFindInputFocused via the
        // shared pure mapping (services/findInChat.ts).
        for (const [key, value] of findBarContextUpdates(message)) {
          void vscode.commands.executeCommand("setContext", key, value);
        }
        break;
      case "planFindBarState":
        // GAPS-157: same plan find-bar state bridge as the sidebar
        // surface — maintains the verbatim keys glassPlanFindBarVisible /
        // glassFindInputFocused via the shared pure mapping
        // (services/findInPlan.ts).
        for (const [key, value] of planFindBarContextUpdates(message)) {
          void vscode.commands.executeCommand("setContext", key, value);
        }
        break;
      case "approvalResolve":
        if (typeof message.approvalId === "string" && typeof message.optionId === "string") {
          composer.reviews.resolveApproval(message.approvalId, { optionId: message.optionId });
        }
        break;
      case "webviewReady":
        // The webview's scripts are loaded — flush anything posted before
        // it was ready (initial state, early chips), in order.
        this.webviewReady = true;
        for (const pending of this.pendingOutbound.splice(0)) {
          void this.post(pending);
        }
        if (this.deps.slash) {
          this.postToWebview({ type: "slashCommands", items: this.deps.slash.getPaletteItems() });
        }
        break;
      case "stopTurn":
        // GAPS-11B (agent-abort-restore-query): the explicit user Stop path —
        // Cursor's abortAgentAndRestoreQuery restores the aborted turn's
        // query; restoreQuery: true puts the prompt back in the input.
        composer.abort({ restoreQuery: true });
        break;
      case "restoreCheckpoint":
        if (typeof message.bubbleId === "string") {
          void composer.revertToCheckpoint(message.bubbleId).catch((err: unknown) => {
            const m = err instanceof Error ? err.message : String(err);
            void vscode.window.showErrorMessage(`IDE Agent: restore failed — ${m}`);
          });
        }
        break;
      // Per-message "Fork Chat" — branch a new chat from one message.
      // Mirrors Cursor's `composer.duplicateChat` ({sourceComposerId, bubbleId}):
      // the transcript through the selected bubble (inclusive; a following
      // assistant bubble is kept too) is deep-cloned into a new tab.
      case "forkChatFromBubble":
        if (typeof message.bubbleId === "string") {
          try {
            const result = forkTabFromBubble(this.tabs, this.tab, message.bubbleId);
            void openChatEditor(this.tabs, this.deps, result.tab.id);
            void vscode.window.showInformationMessage(forkInfoMessage(result));
          } catch (err) {
            const m = err instanceof Error ? err.message : String(err);
            void vscode.window.showErrorMessage(m);
          }
        }
        break;
      // DEV-GAPS-73 (chat-copy-message): copy the bubble's raw markdown
      // source to the clipboard (Cursor 3.25.6 verbatim:
      // trackEvent('composer.copy_message') + 'Message copied to
      // clipboard' toast).
      case "copyMessage":
        if (typeof message.bubbleId === "string") {
          void copyBubbleMessageToClipboard(
            this.composer,
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
          void composer.resubmitEditedMessage(message.bubbleId, message.text).catch((err: unknown) => {
            const m = err instanceof Error ? err.message : String(err);
            void vscode.window.showErrorMessage(`IDE Agent: resubmit failed — ${m}`);
          });
        }
        break;
      // In an editor tab there is no self-drawn tab bar: newTab opens a new
      // editor, closeTab closes this editor, switchTab reveals the target.
      case "newTab":
        void openChatEditor(this.tabs, this.deps);
        break;
      case "switchTab":
        if (typeof message.tabId === "string") {
          void openChatEditor(this.tabs, this.deps, message.tabId);
        }
        break;
      case "closeTab":
        void vscode.commands.executeCommand("workbench.action.closeActiveEditor");
        break;
      case "renameTab":
        if (typeof message.tabId === "string" && typeof message.title === "string") {
          this.tabs.renameTab(message.tabId, message.title);
        }
        break;
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
      case "queueRemove":
        if (typeof message.id === "string") {
          composer.queueRemove(message.id);
        }
        break;
      case "queueMove":
        if (typeof message.id === "string" && (message.direction === -1 || message.direction === 1)) {
          composer.queueMove(message.id, message.direction);
        }
        break;
      case "queueSendNow":
        if (typeof message.id === "string") {
          composer.queueSendNow(message.id);
        }
        break;
      case "answerQuestion": {
        const qid = message.questionId;
        if (typeof qid === "string") {
          let ok = false;
          if (Array.isArray(message.optionIds)) {
            const ids = message.optionIds.filter((o): o is string => typeof o === "string");
            ok = composer.answerQuestionMulti(qid, ids);
          } else if (typeof message.optionId === "string") {
            ok = composer.answerQuestion(qid, message.optionId);
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
  }

  /**
   * GAPS-46D (agent-custom-modes): enter a custom mode from a skill by name
   * (Alt+Enter / "Use as Mode" on a `/` menu skill entry). Docs:
   * "Any skill with a valid frontmatter block can back a mode."
   */
  private enterSkillAsMode(name: string): void {
    const slash = this.deps.slash;
    const skill = slash
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

  private async runSlashCommand(name: string, args: string, rest: string): Promise<void> {
    const slash = this.deps.slash;
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
  }

  /** @-mention chip click actions (mirrors ChatViewProvider.openMentionTarget). */
  private async openMentionTarget(chip: MentionChip): Promise<void> {
    const p = chip.payload;
    const uriFromPayload = (u: string): vscode.Uri | undefined => {
      try {
        const parsed = vscode.Uri.parse(u);
        return parsed.scheme === "file" ? parsed : undefined;
      } catch {
        return undefined;
      }
    };
    switch (p.case) {
      case "fileSelection":
      case "folderSelection": {
        const uri = uriFromPayload(p.uri);
        if (uri) {
          await vscode.commands.executeCommand("vscode.open", uri);
        }
        break;
      }
      case "codeSelection": {
        const uri = uriFromPayload(p.uri);
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
        const term = vscode.window.terminals.find((t) => t.name === p.terminalName);
        if (term) {
          term.show();
        }
        break;
      }
      case "linkSelection": {
        // GAPS-131: fallback only — the webview normally routes link
        // chips to the mention-link toolbar instead of openMention.
        if (p.url.startsWith("https://") || p.url.startsWith("http://")) {
          await vscode.env.openExternal(vscode.Uri.parse(p.url));
        }
        break;
      }
      default:
        break;
    }
  }

  dispose(): void {
    // GAPS-143 (NF-1, mention-link-toolbar teardown): this dispose() is
    // the host's central teardown — it runs when the panel disposes
    // (resolve() registers `panel.onDidDispose(() => this.dispose())`).
    // The toolbar DOM lived in this panel's webview and is gone now, so
    // close the shared controller (bare close, no host: the dead surface
    // must not be posted to) — the pending show promise resolves and
    // `current` clears instead of leaking until the next show. See D2
    // residual in services/mentionLinkToolbar.ts.
    mentionLinkToolbarController.closeMentionLinkToolbar();
    this.disposed = true;
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

export class ChatEditorProvider implements vscode.CustomEditorProvider<ChatEditorDocument> {
  /**
   * P2-3 (QA-CHATEDITOR): live webview hosts by tab id, so host-side code
   * (Add to Chat, browser attach) can post to the OPEN chat editor tab
   * instead of yanking focus to the sidebar. Registered in
   * resolveCustomEditor, removed when the panel disposes.
   */
  private readonly hosts = new Map<string, ChatEditorHost>();

  /**
   * DEV-GAPS-14 (orange-dot-native-tabs): set by extension.ts. Re-pushes the
   * native-tab badge state when a chat editor (re)opens — workbench core
   * drops badge state for editors that were never open (or whose input was
   * disposed on close), so the diff-based ChatTabBadgeSync alone would leave
   * a reopened awaiting tab without its orange dot.
   */
  badgeSync: { pushTab(tabId: string): void } | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly tabs: ChatTabService,
    private readonly deps: ChatEditorDeps,
  ) {}

  /** The live webview host for a tab id, if that tab is open as an editor. */
  getHost(tabId: string): ChatEditorHost | undefined {
    return this.hosts.get(tabId);
  }

  async openCustomDocument(
    uri: vscode.Uri,
    _openContext: vscode.CustomDocumentOpenContext,
    _token: vscode.CancellationToken,
  ): Promise<ChatEditorDocument> {
    const tabId = tabIdFromUri(uri);
    let tab = tabId ? this.tabs.listTabs().find((t) => t.id === tabId) : undefined;
    if (!tab) {
      tab = this.tabs.createTab({});
    }
    return new ChatEditorDocument(chatEditorUriForTab(tab.id), tab);
  }

  async resolveCustomEditor(
    document: ChatEditorDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    // GAPS-143 (NF-1, mention-link-toolbar teardown): a RE-resolve builds
    // a fresh host + fresh webview HTML (ChatEditorHost.resolve), so any
    // toolbar DOM from a previous resolve of this panel is gone — close
    // the shared controller first (bare close, no host) so its promise
    // resolves and `current` clears. No-op when nothing is open.
    mentionLinkToolbarController.closeMentionLinkToolbar();
    const host = new ChatEditorHost(this.context, this.tabs, document.tab, webviewPanel, this.deps);
    this.hosts.set(document.tab.id, host);
    webviewPanel.onDidDispose(() => this.hosts.delete(document.tab.id));
    host.resolve();
    // DEV-GAPS-14 (orange-dot-native-tabs): the editor (re)opened — re-push
    // its badge state so a tab that is still awaiting input gets its dot
    // even though core dropped the badge while the editor was closed.
    this.badgeSync?.pushTab(document.tab.id);
    // Host lifetime follows the panel; the tab itself stays owned by ChatTabService.
  }

  onDidChangeCustomDocument = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<ChatEditorDocument>>().event;
  saveCustomDocument = async (): Promise<void> => undefined;
  saveCustomDocumentAs = async (): Promise<void> => undefined;
  revertCustomDocument = async (): Promise<void> => undefined;
  backupCustomDocument = async (): Promise<vscode.CustomDocumentBackup> => ({
    id: "",
    delete: () => undefined,
  });
}

/**
 * Whether chats open as real editor tabs (Cursor "Open Chat as Editor Tabs",
 * General > Layout). When OFF, chats stay in the legacy stacked sidebar view.
 * P1-3 (QA-CHATEDITOR / DETAIL-SETTINGS): Cursor has this as a toggle; we
 * used to force editor tabs unconditionally.
 */
export function openChatAsEditorTabs(): boolean {
  try {
    return vscode.workspace.getConfiguration("ide.chat").get<boolean>("openAsEditorTabs", true);
  } catch {
    return true;
  }
}

/**
 * Open a chat tab as a real editor tab. Creates a tab when tabId is omitted.
 * Uses `vscode.openWith` so the custom editor provider handles the URI.
 *
 * P1-3: when `ide.chat.openAsEditorTabs` is OFF, the chat opens in the
 * legacy stacked sidebar view instead — no editor tab is created.
 */
export async function openChatEditor(
  tabs: ChatTabService,
  _deps?: ChatEditorDeps,
  tabId?: string,
): Promise<ChatTab> {
  const tab = tabId ? tabs.listTabs().find((t) => t.id === tabId) ?? tabs.createTab({}) : tabs.createAndActivate({});
  if (openChatAsEditorTabs()) {
    await vscode.commands.executeCommand("vscode.openWith", chatEditorUriForTab(tab.id), CHAT_EDITOR_VIEW_TYPE);
  } else {
    await vscode.commands.executeCommand("ideAgent.chatView.focus");
  }
  return tab;
}

/**
 * Resolve the chat tab a title-context menu command should act on.
 *
 * P2-1 (QA-CHATEDITOR): the editor title context menu forwards the
 * right-clicked tab's resource URI as the first command arg
 * (menuActionOptions.shouldForwardArgs, editorTabsControl.ts). When that URI
 * is one of our chat editors, it wins — right-clicking a non-active tab must
 * act on THAT tab, not the active one.
 *
 * Without a URI (palette invocation): prefer the active tab when it is one
 * of our chat editors; fall back to the single open chat editor; finally
 * fall back to the sidebar's active tab.
 */
export function resolveChatEditorTab(tabs: ChatTabService, rightClickedUri?: vscode.Uri): ChatTab | undefined {
  if (rightClickedUri) {
    const tabId = tabIdFromUri(rightClickedUri);
    const tab = tabId ? tabs.listTabs().find((t) => t.id === tabId) : undefined;
    if (tab) {
      return tab;
    }
    // A foreign URI (or a stale chat URI): fall through to the heuristics.
  }
  const activeTab = vscode.window.tabGroups.activeTabGroup?.activeTab;
  const input = activeTab?.input;
  if (input instanceof vscode.TabInputCustom && input.viewType === CHAT_EDITOR_VIEW_TYPE) {
    const tabId = tabIdFromUri(input.uri);
    const tab = tabId ? tabs.listTabs().find((t) => t.id === tabId) : undefined;
    if (tab) {
      return tab;
    }
  }
  const chatEditors = vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .filter(
      (t): t is vscode.Tab & { input: vscode.TabInputCustom } =>
        t.input instanceof vscode.TabInputCustom && t.input.viewType === CHAT_EDITOR_VIEW_TYPE,
    );
  if (chatEditors.length === 1) {
    const tabId = tabIdFromUri(chatEditors[0].input.uri);
    const tab = tabId ? tabs.listTabs().find((t) => t.id === tabId) : undefined;
    if (tab) {
      return tab;
    }
  }
  return tabs.listTabs().length > 0 ? tabs.activeTab : undefined;
}

/** Markdown export of a tab's transcript (Cursor "Export Transcript"). */
export function transcriptToMarkdown(tab: ChatTab): string {
  const lines: string[] = [`# ${tab.title}`, ""];
  for (const b of tab.composer.bubbles.getAllInOrder()) {
    const who = b.role === "human" ? "User" : b.role === "assistant" ? "Assistant" : b.role;
    lines.push(`## ${who}`, "", b.text || "", "");
  }
  return lines.join("\n");
}
