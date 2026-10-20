import * as vscode from "vscode";
import { ChatTab, ChatTabService } from "./chatTabService";
import { ComposerDataService } from "./composerDataService";
import type { BubbleData } from "../model";
import type { FileAttachment } from "./mentionService";

/**
 * ChatDuplicateService — duplicate / deep-clone an agent chat (Cursor parity).
 *
 * Binary evidence (Cursor 3.25.9, workbench.glass.main.js, static literals —
 * verified 2026-10-19 against the extracted AppImage squashfs):
 * - command 'composer.duplicateChat' (categorized 'chat_management' in
 *   command-telemetry: `["composer.duplicateChat","chat_management"]`)
 * - 'composer.deepCloneComposer' — internal deep-clone API: new composer id
 *   (xi() uuid), id remapping (WeakMap / composerIdRemap), orphaned headers
 *   dropped (metric `composer.deepCloneComposer.orphanedHeadersDropped`),
 *   blob-upload service notified of the clone
 *   (`notifyClone({conversationId, sourceConversationId, sourceRequestId})`),
 *   metrics distribution `composer.deepCloneComposer` tagged with
 *   `messageCount`; the clone's createdAt/lastUpdatedAt are set to now.
 * - command 'composer.duplicate_tab' — the tab command: `trackEvent(
 *   "composer.duplicate_tab")`, then deepCloneComposer with a fresh id;
 *   the clone's name is deduplicated with js0() from
 *   "composerForkNameUtils.js": strip an existing "(N) " prefix (regex
 *   /^\((\d+)\)\s+(.+)$/), then first free "(1) <name>", "(2) <name>", ….
 *   Default forkBubbleId is "latest" — the whole conversation is retained
 *   (`retainedMessageCount`); the new tab is opened afterwards.
 *
 * Behavior: the user duplicates an agent chat — a deep clone of the tab
 * state (transcript, queued context, mode, model selection) into a NEW tab —
 * so they can branch exploration without losing the original.
 *
 * Mapping to this codebase's architecture:
 * - Cursor's global composer store remaps ids on clone because clones share
 *   one store. Here every tab owns its own ComposerBubbleSetStore, so
 *   cross-tab id collisions are impossible; the clone still gets FRESH
 *   client bubble ids (same rationale as the existing `ide.forkChat` in
 *   extension.ts: "Copy Request ID in the fork must not copy the source's
 *   ids") and `serverBubbleId` is cleared — the clone has no server session
 *   yet. Its engine session starts fresh on the next submit (fresh
 *   IdeCodeEngineAdapter per ComposerDataService).
 * - Cursor's "stored messages / conversationMap" ≅ our bubble store
 *   (getAllInOrder); its "queued context" ≅ our MessageQueueService items
 *   (text + attachments — the only persisted context attachments live on).
 * - What is deliberately NOT cloned: the engine session, checkpoint records
 *   (the clone's CheckpointService starts empty — a restore affordance on a
 *   cloned bubble degrades to the existing "no checkpoint found" warning,
 *   looked up by the fresh bubble id), pending approvals/clarifying
 *   questions (transient turn state of the source tab), and hook scope
 *   (each ComposerDataService gets its own `composer-N` scope).
 *
 * Placement note (evidence-exact): the three command ids, the
 * 'chat_management' category of duplicateChat, and the "(N) name" dedup rule
 * are evidence-backed. Whether Cursor shows a toast on duplicate is
 * UNKNOWN — the info message here names exactly what was cloned so the
 * user is never surprised.
 */

/** Cursor command: duplicate the active chat (telemetry category 'chat_management'). */
export const DUPLICATE_CHAT_COMMAND = "composer.duplicateChat";
/** Cursor internal deep-clone API, exposed as a command returning the new tab id. */
export const DEEP_CLONE_COMPOSER_COMMAND = "composer.deepCloneComposer";
/** Cursor command: duplicate a chat tab (trackEvent 'composer.duplicate_tab'). */
export const DUPLICATE_TAB_COMMAND = "composer.duplicate_tab";

/** Title given to a tab that never got a real title (ChatTabService default). */
export const DEFAULT_CHAT_TITLE = "New chat";

/** Cursor js0's fallback base name when the source title is blank. */
const FALLBACK_BASE_NAME = "New chat";

/**
 * Cursor's `composerForkNameUtils.js` duplicate-name rule (evidence-exact):
 * strip an existing "(N) " prefix, then return the first "(r) <base>" that
 * does not collide with an existing chat name.
 */
export function dedupeDuplicateName(
  sourceTitle: string,
  existingTitles: Iterable<string>,
): string {
  const stripped = sourceTitle.trim().replace(/^\(\d+\)\s+/, "");
  const base = stripped.length > 0 ? stripped : FALLBACK_BASE_NAME;
  const taken = new Set(existingTitles);
  let n = 1;
  let candidate = `(${n}) ${base}`;
  while (taken.has(candidate)) {
    n += 1;
    candidate = `(${n}) ${base}`;
  }
  return candidate;
}

export interface ChatDuplicateOptions {
  /**
   * Resolves the tab a command targets when invoked without an explicit tab
   * id. Defaults to the active tab.
   */
  resolveTargetTabId?: () => string | undefined;
  /**
   * Reveals the cloned tab after duplication. Defaults to switching to the
   * new tab (tabsChanged → the host's resyncActiveTab posts the full cloned
   * state) plus opening it the way `ide.forkChat` does. The chatEditorProvider
   * import is lazy so this service stays free of webview code at load time.
   * Tests inject a spy.
   */
  revealNewTab?: (tabs: ChatTabService, newTabId: string) => Promise<void>;
  /** Fired after a duplicate succeeds (UI refresh / telemetry hook). */
  onDuplicated?: (sourceTabId: string, newTabId: string) => void;
}

export interface DuplicateChatResult {
  sourceTabId: string;
  newTabId: string;
  /** Transcript bubbles cloned. */
  bubbleCount: number;
  /** Queued context messages cloned. */
  queuedCount: number;
}

/**
 * Deep-clone one bubble into the target composer's id space: fresh client
 * bubble id, no serverBubbleId (no server session yet — same as the existing
 * `ide.forkChat`), and fully detached tool-call / thinking objects so a
 * still-streaming source tab cannot mutate the clone mid-turn.
 */
function cloneBubbleFor(
  target: ComposerDataService,
  source: BubbleData,
): BubbleData {
  return {
    ...source,
    bubbleId: target.bubbles.newClientBubbleId(),
    serverBubbleId: undefined,
    text: source.text,
    thinking: source.thinking ? structuredClone(source.thinking) : undefined,
    toolCalls: source.toolCalls.map((tc) => structuredClone(tc)),
  };
}

/**
 * Deep-clone a chat tab: new tab holding a snapshot of the source's
 * transcript (bubbles), queued context (message queue incl. attachments),
 * mode, and model selection. The original tab is untouched.
 *
 * @param tabs the tab service owning both tabs.
 * @param sourceTabId the tab to clone; defaults to the active tab.
 * @returns the new tab, or undefined when the source tab does not exist.
 */
export function duplicateChatTab(
  tabs: ChatTabService,
  sourceTabId?: string,
): { tab: ChatTab; result: DuplicateChatResult } | undefined {
  const source =
    (sourceTabId
      ? tabs.listTabs().find((t) => t.id === sourceTabId)
      : undefined) ?? tabs.activeTab;
  if (sourceTabId && !tabs.listTabs().some((t) => t.id === sourceTabId)) {
    return undefined;
  }
  const title = dedupeDuplicateName(
    source.title,
    tabs.listTabs().map((t) => t.title),
  );
  const clone = tabs.createTab({ title, mode: source.composer.modes.getMode() });

  // Transcript: deep copy, fresh ids, order preserved. setBubbleData
  // rebuilds the toolCall→bubble index for the clone's own store.
  const sources = source.composer.bubbles.getAllInOrder();
  const copies = sources.map((b) => cloneBubbleFor(clone.composer, b));
  clone.composer.bubbles.appendBubbles(copies);

  // Model selection: same model continues in the branch. structuredClone
  // detaches the ref object; the workspaceState persist is a same-value
  // write at clone time (each composer keeps its own in-session selection).
  clone.composer.models.setSelection(
    structuredClone(source.composer.models.getSelection()),
  );

  // Queued context: pending messages (with their file attachments) move
  // with the branch so queued work continues there.
  let queuedCount = 0;
  for (const q of source.composer.queue.getItems()) {
    const attachments: FileAttachment[] | undefined =
      q.attachments && q.attachments.length > 0
        ? structuredClone(q.attachments)
        : undefined;
    clone.composer.queue.enqueue(q.text, q.mode, attachments);
    queuedCount += 1;
  }

  return {
    tab: clone,
    result: {
      sourceTabId: source.id,
      newTabId: clone.id,
      bubbleCount: copies.length,
      queuedCount,
    },
  };
}

/**
 * Register the three Cursor duplicate commands on the extension context.
 *
 * - 'composer.duplicateChat'   — duplicate the ACTIVE chat (chat_management),
 *                                 then reveal the new tab.
 * - 'composer.deepCloneComposer' — deep-clone the given tab id (or active),
 *                                 resolves to the new tab id. Mirrors
 *                                 Cursor's internal async deepCloneComposer
 *                                 returning the cloned composer.
 * - 'composer.duplicate_tab'   — duplicate the given tab id (or active),
 *                                 then reveal the new tab (Cursor's tab
 *                                 command: trackEvent + open new tab).
 */
export function registerChatDuplicateCommands(
  context: vscode.ExtensionContext,
  tabs: ChatTabService,
  options: ChatDuplicateOptions = {},
): vscode.Disposable {
  const resolveId = (arg: unknown): string | undefined =>
    typeof arg === "string" && arg.length > 0
      ? arg
      : (options.resolveTargetTabId?.() ?? tabs.activeTab.id);

  const notifyDuplicated = (result: DuplicateChatResult): void => {
    try {
      options.onDuplicated?.(result.sourceTabId, result.newTabId);
    } catch {
      /* a listener must never break the duplicate */
    }
  };

  /** Reveal the clone the way `ide.forkChat` does (editor tab or chat view). */
  const revealNewTab =
    options.revealNewTab ??
    (async (t: ChatTabService, newTabId: string): Promise<void> => {
      t.switchTab(newTabId);
      try {
        const { openChatEditor } = await import("./chatEditorProvider");
        await openChatEditor(t, undefined, newTabId);
      } catch {
        // Reveal must never break the duplicate — switchTab above already
        // moved the UI to the clone via tabsChanged → resyncActiveTab.
      }
    });

  const duplicateChat = vscode.commands.registerCommand(
    DUPLICATE_CHAT_COMMAND,
    (tabId?: unknown) => {
      // Fire-and-forget: command handlers must not reject into the host.
      void (async () => {
        const id = resolveId(tabId);
        const cloned = duplicateChatTab(tabs, id);
        if (!cloned) {
          void vscode.window.showErrorMessage(
            "IDE Agent: chat tab not found — cannot duplicate it.",
          );
          return;
        }
        await revealNewTab(tabs, cloned.result.newTabId);
        notifyDuplicated(cloned.result);
        void vscode.window.showInformationMessage(
          `IDE Agent: duplicated chat — transcript (${cloned.result.bubbleCount} messages), ` +
            `mode, model and ${cloned.result.queuedCount} queued message(s) copied to a new tab. ` +
            "The original is untouched.",
        );
      })().then(
        () => undefined,
        () => undefined,
      );
    },
  );

  const deepCloneComposer = vscode.commands.registerCommand(
    DEEP_CLONE_COMPOSER_COMMAND,
    (tabId?: unknown): Promise<string | undefined> => {
      const id = resolveId(tabId);
      const cloned = duplicateChatTab(tabs, id);
      if (!cloned) {
        void vscode.window.showErrorMessage(
          "IDE Agent: chat tab not found — cannot clone it.",
        );
        return Promise.resolve(undefined);
      }
      notifyDuplicated(cloned.result);
      return Promise.resolve(cloned.result.newTabId);
    },
  );

  const duplicateTab = vscode.commands.registerCommand(
    DUPLICATE_TAB_COMMAND,
    (tabId?: unknown) => {
      // Fire-and-forget: command handlers must not reject into the host.
      void (async () => {
        const id = resolveId(tabId);
        const cloned = duplicateChatTab(tabs, id);
        if (!cloned) {
          void vscode.window.showErrorMessage(
            "IDE Agent: chat tab not found — cannot duplicate it.",
          );
          return;
        }
        await revealNewTab(tabs, cloned.result.newTabId);
        notifyDuplicated(cloned.result);
      })().then(
        () => undefined,
        () => undefined,
      );
    },
  );

  context.subscriptions.push(duplicateChat, deepCloneComposer, duplicateTab);
  return {
    dispose: () => {
      duplicateChat.dispose();
      deepCloneComposer.dispose();
      duplicateTab.dispose();
    },
  };
}
