import * as vscode from "vscode";
import { ChatTabService } from "./chatTabService";

/**
 * ChatRenameService — agent chat rename (Cursor parity).
 *
 * Binary evidence (Cursor 3.25.6, workbench.glass.main.js, static literals):
 * - command 'composer.renameChat' (categorized 'chat_management' in
 *   command-telemetry)
 * - command 'composer.renameComposer' with label/tooltip 'Rename Chat'
 *   (inline rename action)
 *
 * Behavior: the user renames an agent chat from the chat UI (context menu +
 * inline rename) so a conversation is easy to identify later.
 *
 * Placement note (evidence-exact): the two command ids and the 'Rename Chat'
 * label/tooltip are evidence-backed. Which menu/context each id is wired to
 * in Cursor beyond "inline rename action" for renameComposer is UNKNOWN, so
 * both commands accept an optional tab-id argument (context-menu/menu
 * invocation) and fall back to the active tab (inline/composer invocation).
 * The prompt UI beyond that is also UNKNOWN — this implementation uses a
 * standard input box prefilled with the current title.
 */

/** Cursor command: rename a chat (command-telemetry category: 'chat_management'). */
export const RENAME_CHAT_COMMAND = "composer.renameChat";
/** Cursor command: inline rename action on the composer, label 'Rename Chat'. */
export const RENAME_COMPOSER_COMMAND = "composer.renameComposer";
/** Evidence-backed label/tooltip for both commands. */
export const RENAME_CHAT_LABEL = "Rename Chat";

/** Title given to a tab that was never renamed (ChatTabService default). */
export const DEFAULT_CHAT_TITLE = "New chat";

export interface ChatRenameOptions {
  /**
   * Resolves the tab the rename targets when the command is invoked without
   * an explicit tab id. Defaults to the active tab.
   */
  resolveTargetTabId?: () => string | undefined;
  /**
   * Prompts the user for a title; returns undefined on cancel. Defaults to
   * vscode.window.showInputBox. Tests inject a canned prompt.
   */
  promptTitle?: (currentTitle: string) => Promise<string | undefined>;
  /** Fired after a rename succeeds (UI refresh / telemetry hook). */
  onRenamed?: (tabId: string, title: string) => void;
}

/**
 * Manual-title tracker + rename flow.
 *
 * The title itself lives in tab state (ChatTab.title, written via
 * ChatTabService.renameTab). This service layers the manual-vs-auto
 * distinction on top: a title is "manual" only when set through this
 * service's rename flow. Auto-generated titles (first-message summary, set
 * internally by ChatTabService) never enter the manual set.
 *
 * Reconciliation: when a tab is closed the tab id disappears from the tab
 * list; when a tab is cleared (newChat) its title returns to "New chat" —
 * both cases drop the manual flag on the next tabsChanged event. A manual
 * rename back to the literal "New chat" is indistinguishable from the auto
 * reset, so it is treated as a reset too.
 *
 * NOTE: the manual set is session-scoped on purpose. Tab ids regenerate
 * every session ('tab-N'), so a persisted flag could not reliably denote
 * the same chat — the same limitation documented for pin restore in
 * ChatTabService.
 */
export class ChatRenameService implements vscode.Disposable {
  private readonly manualTitles = new Set<string>();
  private readonly tabSubscription: vscode.Disposable;

  constructor(
    private readonly chatTabs: ChatTabService,
    private readonly options: ChatRenameOptions = {},
  ) {
    this.tabSubscription = this.chatTabs.onDidChange((event) => {
      if (event.kind === "tabsChanged") {
        this.reconcileManualTitles();
      }
    });
  }

  /** True when the tab's title is a manual override, not auto-generated. */
  isManualTitle(tabId: string): boolean {
    return this.manualTitles.has(tabId);
  }

  /**
   * Run the rename flow for one tab.
   * @param targetTabId explicit tab id (context-menu invocation); when
   * omitted the active tab (or options.resolveTargetTabId) is used.
   * @returns true when the tab was renamed; false on cancel/invalid/no tab.
   */
  async runRename(targetTabId?: string): Promise<boolean> {
    const id =
      targetTabId ??
      this.options.resolveTargetTabId?.() ??
      this.chatTabs.activeTab.id;
    const tab = this.chatTabs.listTabs().find((t) => t.id === id);
    if (!tab) {
      void vscode.window.showErrorMessage(
        "IDE Agent: chat tab not found — cannot rename it.",
      );
      return false;
    }
    const answer = await this.promptForTitle(tab.title);
    if (answer === undefined) {
      return false; // user cancelled
    }
    const clean = answer.replace(/\s+/g, " ").trim();
    if (clean.length === 0) {
      void vscode.window.showErrorMessage(
        "IDE Agent: chat title cannot be empty.",
      );
      return false;
    }
    const ok = this.chatTabs.renameTab(id, clean);
    if (!ok) {
      void vscode.window.showErrorMessage(
        "IDE Agent: could not rename the chat.",
      );
      return false;
    }
    this.manualTitles.add(id);
    try {
      this.options.onRenamed?.(id, tab.title);
    } catch {
      /* a listener must never break the rename */
    }
    return true;
  }

  /** Drop manual flags for closed tabs and tabs reset to the default title. */
  private reconcileManualTitles(): void {
    const live = new Map(
      this.chatTabs.listTabs().map((t) => [t.id, t.title] as const),
    );
    for (const id of [...this.manualTitles]) {
      const title = live.get(id);
      if (title === undefined || title === DEFAULT_CHAT_TITLE) {
        this.manualTitles.delete(id);
      }
    }
  }

  private promptForTitle(currentTitle: string): Promise<string | undefined> {
    if (this.options.promptTitle) {
      return this.options.promptTitle(currentTitle);
    }
    // showInputBox returns a Thenable, not a Promise — normalize it.
    return Promise.resolve(
      vscode.window.showInputBox({
        prompt: RENAME_CHAT_LABEL,
        value: currentTitle,
        placeHolder: "Give this chat a recognizable name",
        validateInput: (v) =>
          v.replace(/\s+/g, " ").trim().length === 0
            ? "Title cannot be empty"
            : undefined,
      }),
    );
  }

  dispose(): void {
    this.tabSubscription.dispose();
    this.manualTitles.clear();
  }
}

/**
 * Register the two Cursor rename commands on the extension context.
 *
 * - 'composer.renameChat'      — primary command (chat list context menu /
 *                                command palette), label 'Rename Chat'.
 * - 'composer.renameComposer'  — inline rename action, label/tooltip
 *                                'Rename Chat'.
 *
 * Both accept an optional tab-id argument; without one they rename the
 * active tab.
 */
export function registerChatRenameCommands(
  context: vscode.ExtensionContext,
  chatTabs: ChatTabService,
  options?: ChatRenameOptions,
): vscode.Disposable {
  const service = new ChatRenameService(chatTabs, options);
  const make = (command: string) =>
    vscode.commands.registerCommand(command, (tabId?: unknown) =>
      // Fire-and-forget: command handlers must not reject into the host.
      service
        .runRename(typeof tabId === "string" ? tabId : undefined)
        .then(
          () => undefined,
          () => undefined,
        ),
    );
  const renameChat = make(RENAME_CHAT_COMMAND);
  const renameComposer = make(RENAME_COMPOSER_COMMAND);
  context.subscriptions.push(service, renameChat, renameComposer);
  return {
    dispose: () => {
      renameChat.dispose();
      renameComposer.dispose();
      service.dispose();
    },
  };
}
