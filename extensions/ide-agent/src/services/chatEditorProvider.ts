import * as vscode from "vscode";
import { ChatTab, ChatTabService, ChatTabEvent } from "./chatTabService";
import { ComposerDataService, ComposerEvent, SubmitSendMode } from "./composerDataService";
import { MentionService, MentionChip, isMentionChip, FileAttachment } from "./mentionService";
import { createComposer } from "../components/composer";
import { cycleMode } from "./modeService";
import type { ModeName } from "../model";
import type { TerminalService } from "./terminalService";
import type { SlashCommandService } from "./slashCommandService";
import type { QueuedMessage } from "./messageQueueService";

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
  | { type: "openModelPicker" }
  | { type: "inputFocus"; focused: boolean }
  | { type: "approvalResolve"; approvalId: string; optionId: string }
  | { type: "webviewReady" }
  | { type: "stopTurn" }
  // DETAIL-CHAT §5 (P1): empty-composer submit morphs to "Start voice chat".
  // No realtime voice infrastructure exists yet (mic capture, speech-to-text,
  // voice session) — the host answers honestly instead of faking a session.
  | { type: "startVoiceChat" }
  | { type: "restoreCheckpoint"; bubbleId: string }
  | { type: "newTab" }
  | { type: "switchTab"; tabId: string }
  | { type: "closeTab"; tabId: string }
  | { type: "renameTab"; tabId: string; title: string }
  | { type: "queueRemove"; id: string }
  | { type: "queueMove"; id: string; direction: -1 | 1 }
  | { type: "queueSendNow"; id: string }
  | { type: "answerQuestion"; questionId: string; optionId?: string; optionIds?: string[] }
  | { type: "mentionQuery"; requestId: number; query: string }
  | { type: "openMention"; chip: unknown };

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
    this.postToWebview({ type: "approval", request: composer.reviews.currentApproval ?? null });
    this.postToWebview({ type: "mode", mode: composer.modes.getMode() });
    this.postToWebview({ type: "model", label: composer.models.getSelection().label });
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
        break;
      }
      case "planReady": {
        this.postToWebview({ type: "planReady" });
        break;
      }
      case "planCleared": {
        this.postToWebview({ type: "planCleared" });
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

  private handleMessage(message: WebviewMessage): void {
    const composer = this.composer;
    switch (message.type) {
      case "submit":
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
      case "openModelPicker":
        void this.deps.pickModel(composer);
        break;
      case "inputFocus":
        void vscode.commands.executeCommand("setContext", "ideAgent.chatInputFocused", message.focused === true);
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
        composer.abort();
        break;
      // DETAIL-CHAT §5 (P1): the empty-composer submit slot morphs to
      // "Start voice chat". GAP (honest): no realtime voice-chat
      // infrastructure exists yet (no mic capture, no speech-to-text,
      // no voice session), so clicking it shows an informational
      // message instead of pretending to start a session.
      case "startVoiceChat":
        void vscode.window.showInformationMessage(
          "IDE Agent: voice chat is not available in this build yet.",
        );
        break;
      case "restoreCheckpoint":
        if (typeof message.bubbleId === "string") {
          void composer.revertToCheckpoint(message.bubbleId).catch((err: unknown) => {
            const m = err instanceof Error ? err.message : String(err);
            void vscode.window.showErrorMessage(`IDE Agent: restore failed — ${m}`);
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
      default:
        break;
    }
  }

  dispose(): void {
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
    const host = new ChatEditorHost(this.context, this.tabs, document.tab, webviewPanel, this.deps);
    this.hosts.set(document.tab.id, host);
    webviewPanel.onDidDispose(() => this.hosts.delete(document.tab.id));
    host.resolve();
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
