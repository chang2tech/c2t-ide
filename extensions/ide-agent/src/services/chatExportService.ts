/**
 * ChatExportService — export the active agent chat as a Markdown document.
 *
 * CURSOR EVIDENCE (do NOT claim beyond this):
 * - Cursor 3.25.6 binary, workbench.glass.main.js: registers command ids
 *   `composer.exportChatAsMd` and `composer.export_chat`.
 * - The same binary's command-telemetry mapping categorizes
 *   `composer.exportChatAsMd` as `chat_management`.
 * - UNKNOWN (not verified in the binary): how Cursor distinguishes the two
 *   ids' behavior (save-dialog vs. clipboard vs. other), and the exact
 *   Markdown layout Cursor emits. The serialization below and the
 *   file-vs-clipboard split between the two commands are OUR choices,
 *   clearly marked as such — they are not Cursor-verified behavior.
 *
 * What this module does:
 * - serializeChatToMarkdown(tab): pure Markdown serialization of a chat
 *   tab's transcript — chat history (human/assistant/system bubbles),
 *   tool calls (title, kind, status, description, output preview) and code
 *   blocks (bubble text is already Markdown, so fenced blocks survive).
 * - registerChatExportCommands(context, deps): registers the two
 *   `composer.*` command ids and pushes the disposables into
 *   context.subscriptions.
 */
import * as vscode from "vscode";
import type { ChatTab } from "./chatTabService";
import type { BubbleData, ToolCallViewModel } from "../model";

/** Cursor-registered command id: export chat as Markdown (file). */
export const EXPORT_CHAT_AS_MD_COMMAND = "composer.exportChatAsMd";
/** Cursor-registered command id: export chat (second id). */
export const EXPORT_CHAT_COMMAND = "composer.export_chat";

/**
 * Chat data provider for the export commands. In production this is the
 * ChatTabService; the structural type keeps tests (and future surfaces)
 * from depending on the whole service.
 */
export interface ChatExportDeps {
  /** Source of the chat to export — production: the ChatTabService. */
  chatTabs: { readonly activeTab: ChatTab };
}

function roleHeading(role: BubbleData["role"]): string {
  switch (role) {
    case "human":
      return "User";
    case "assistant":
      return "Assistant";
    case "tool":
      return "Tool";
    case "system":
      return "System";
    default:
      return role;
  }
}

function serializeThinking(bubble: BubbleData, lines: string[]): void {
  const thinking = bubble.thinking;
  if (!thinking || !thinking.text) {
    return;
  }
  const seconds = Math.max(0, Math.round((thinking.durationMs ?? 0) / 1000));
  lines.push("<details>", `<summary>Thinking (${seconds}s)</summary>`, "");
  lines.push(thinking.text.trimEnd(), "", "</details>", "");
}

function serializeToolCall(tc: ToolCallViewModel, lines: string[]): void {
  lines.push(`### Tool: ${tc.title || tc.kind}`, "");
  const target = tc.filePath ? ` · \`${tc.filePath}\`` : "";
  lines.push(`- \`${tc.kind}\`${target} — status: **${tc.status}**`, "");
  if (tc.description) {
    lines.push(tc.description.trimEnd(), "");
  }
  if (tc.outputPreview) {
    lines.push("```output", tc.outputPreview.trimEnd(), "```", "");
  }
}

/**
 * Serialize a chat tab's transcript to Markdown.
 *
 * Layout: `# <title>`, then per bubble a `## <role>` section with the
 * bubble's (already Markdown) text, its thinking block as a <details>,
 * and each tool call as a `### Tool:` subsection with kind/status/
 * description/output preview. Empty transcript → title plus a placeholder
 * line so the document is never blank.
 */
export function serializeChatToMarkdown(tab: ChatTab): string {
  const lines: string[] = [`# ${tab.title}`, ""];
  const bubbles = tab.composer.bubbles.getAllInOrder();
  if (bubbles.length === 0) {
    lines.push("_No messages yet._", "");
  }
  for (const bubble of bubbles) {
    lines.push(`## ${roleHeading(bubble.role)}`, "");
    serializeThinking(bubble, lines);
    if (bubble.text) {
      lines.push(bubble.text.trimEnd(), "");
    }
    for (const tc of bubble.toolCalls ?? []) {
      serializeToolCall(tc, lines);
    }
  }
  return lines.join("\n");
}

/**
 * Default export file name from a chat title. Mirrors the existing
 * transcript-export sanitization (strip non word/dash/space chars), so the
 * name is a safe file name on every platform.
 */
export function chatExportFileName(title: string): string {
  const base = (title ?? "").replace(/[^\w\- ]+/g, "").trim() || "chat";
  return `${base}.md`;
}

/**
 * Register the two Cursor `composer.*` export command ids.
 *
 * - `composer.exportChatAsMd`: serialize the active tab and save it through
 *   a save dialog (file on disk).
 * - `composer.export_chat`: serialize the active tab and copy the Markdown
 *   to the clipboard.
 *
 * NOTE (UNKNOWN from evidence): Cursor's binary proves both ids exist and
 * that exportChatAsMd is telemetry-categorized as chat_management; it does
 * NOT show how Cursor splits behavior between the two ids. The
 * file-vs-clipboard split here is our choice for utility, not Cursor parity.
 */
export function registerChatExportCommands(
  context: vscode.ExtensionContext,
  deps: ChatExportDeps,
): void {
  async function exportToFile(): Promise<void> {
    const tab = deps.chatTabs.activeTab;
    const md = serializeChatToMarkdown(tab);
    const fileName = chatExportFileName(tab.title);
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    const defaultUri = folder ? vscode.Uri.joinPath(folder, fileName) : vscode.Uri.file(fileName);
    const uri = await vscode.window.showSaveDialog({
      defaultUri,
      filters: { Markdown: ["md"] },
      saveLabel: "Export Chat",
    });
    if (!uri) {
      return; // user cancelled
    }
    await vscode.workspace.fs.writeFile(uri, Buffer.from(md, "utf8"));
    void vscode.window.showInformationMessage(`IDE Agent: chat exported to ${uri.fsPath}`);
  }

  async function exportToClipboard(): Promise<void> {
    const tab = deps.chatTabs.activeTab;
    const md = serializeChatToMarkdown(tab);
    await vscode.env.clipboard.writeText(md);
    void vscode.window.showInformationMessage("IDE Agent: chat copied to clipboard as Markdown.");
  }

  context.subscriptions.push(
    vscode.commands.registerCommand(EXPORT_CHAT_AS_MD_COMMAND, () => void exportToFile()),
    vscode.commands.registerCommand(EXPORT_CHAT_COMMAND, () => void exportToClipboard()),
  );
}

/**
 * Transcript provider for the workbench's binary-verbatim
 * `composer.exportChatAsMd` command (WORKER-GAPS-38D, `agent-chat-export`).
 *
 * The command id the workbench core calls; the extension owns the chat data
 * (ChatTabService), so core asks here for the transcript and runs Cursor's
 * Markdown algorithm itself.
 */
export const GET_CHAT_EXPORT_TRANSCRIPT_COMMAND = "ide.getChatExportTranscript";

/** One message in Cursor's export model (`W.type===HUMAN ? "User" : "Cursor"`). */
export interface ChatExportTranscriptMessage {
  author: "User" | "Cursor";
  text: string;
  codeBlocks: { content: string; languageId: string }[];
  askQuestion?: {
    title?: string;
    questions: { id: string; prompt: string; options: { id: string; label: string }[] }[];
  };
}

/** The transcript handed to the workbench for Markdown serialization. */
export interface ChatExportTranscript {
  name: string;
  messages: ChatExportTranscriptMessage[];
}

/**
 * Map a ChatTab's bubbles to Cursor's export message shape.
 *
 * Mapping notes (HONEST-DIVERGENCES from the binary's bubble model):
 * - author: the binary splits HUMAN vs everything-else; the fork maps
 *   `human` -> "User" and every other role (`assistant`/`tool`/`system`) ->
 *   "Cursor", mirroring the binary's binary split.
 * - codeBlocks: the binary carries structured code blocks per bubble; the
 *   fork's bubble text is already Markdown (fences survive), so this is
 *   empty — the text passes through unchanged.
 * - ASK_QUESTION: mapped from the `ask_question_tool_call` tool call's
 *   `ClarifyingQuestion` payload. The fork's view model does not retain the
 *   user's selected options (the answer arrives back as a separate human
 *   bubble), so the result is left undefined and no ✔ marks render.
 */
export function chatTabToExportTranscript(tab: ChatTab): ChatExportTranscript {
  const messages: ChatExportTranscriptMessage[] = [];
  for (const bubble of tab.composer.bubbles.getAllInOrder()) {
    const askToolCall = (bubble.toolCalls ?? []).find(
      (tc) => tc.kind === "ask_question_tool_call" && tc.question,
    );
    const question = askToolCall?.question;
    messages.push({
      author: bubble.role === "human" ? "User" : "Cursor",
      text: bubble.text ?? "",
      codeBlocks: [],
      ...(question
        ? {
            askQuestion: {
              title: question.header,
              questions: [
                {
                  id: question.questionId,
                  prompt: question.question,
                  options: question.options.map((o) => ({ id: o.id, label: o.label })),
                },
              ],
            },
          }
        : {}),
    });
  }
  return { name: tab.title, messages };
}
