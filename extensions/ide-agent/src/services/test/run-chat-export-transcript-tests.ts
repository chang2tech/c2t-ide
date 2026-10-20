/**
 * Chat export transcript provider tests (node:test, vscode stubbed via ./vscode-stub).
 *
 * Covers `chatTabToExportTranscript` (WORKER-GAPS-38D, `agent-chat-export`):
 * the extension-side mapping from ChatTab bubbles to Cursor's binary export
 * message shape, consumed by the workbench's binary-verbatim
 * `composer.exportChatAsMd` command (`ide.getChatExportTranscript`).
 *
 * Mapping contract (HONEST-DIVERGENCES documented in chatExportService.ts):
 * - `human` -> "User", every other role -> "Cursor" (binary: HUMAN vs rest).
 * - text passes through unchanged; codeBlocks is empty (fork bubble text is
 *   already Markdown).
 * - ASK_QUESTION comes from the `ask_question_tool_call` tool call's
 *   ClarifyingQuestion payload; no selected answers are retained.
 *
 * Run after `tsc`:  node --test out/services/test/run-chat-export-transcript-tests.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import "./vscode-stub";
import type { BubbleData, ToolCallViewModel } from "../../model";
import type { ChatTab } from "../chatTabService";
import {
  GET_CHAT_EXPORT_TRANSCRIPT_COMMAND,
  chatTabToExportTranscript,
} from "../chatExportService";

let bubbleSeq = 0;

function bubble(partial: Partial<BubbleData> & { role: BubbleData["role"]; text: string }): BubbleData {
  bubbleSeq += 1;
  return {
    bubbleId: `b-${bubbleSeq}`,
    mode: "agent",
    toolCalls: [],
    createdAt: Date.now(),
    ...partial,
  };
}

function toolCall(partial: Partial<ToolCallViewModel> & { kind: string; title: string }): ToolCallViewModel {
  return {
    toolCallId: `tc-${bubbleSeq}-${Math.floor(Math.random() * 1e6)}`,
    status: "done",
    description: "",
    outputPreview: "",
    expanded: false,
    ...partial,
  };
}

function fakeTab(title: string, bubbles: BubbleData[]): ChatTab {
  return {
    id: "tab-1",
    title,
    createdAt: Date.now(),
    pinned: false,
    composer: {
      bubbles: { getAllInOrder: () => bubbles },
    },
  } as unknown as ChatTab;
}

describe("chatTabToExportTranscript", () => {
  it("exposes the provider command id the workbench calls", () => {
    assert.strictEqual(GET_CHAT_EXPORT_TRANSCRIPT_COMMAND, "ide.getChatExportTranscript");
  });

  it("maps human -> User and assistant -> Cursor, passing text through", () => {
    const tab = fakeTab("My chat", [
      bubble({ role: "human", text: "do the thing" }),
      bubble({ role: "assistant", text: "done." }),
    ]);
    const t = chatTabToExportTranscript(tab);
    assert.strictEqual(t.name, "My chat");
    assert.deepStrictEqual(
      t.messages.map((m) => [m.author, m.text]),
      [
        ["User", "do the thing"],
        ["Cursor", "done."],
      ],
    );
    assert.deepStrictEqual(t.messages[0].codeBlocks, []);
    assert.strictEqual(t.messages[0].askQuestion, undefined);
  });

  it("maps tool/system roles to Cursor like the binary's non-HUMAN branch", () => {
    const tab = fakeTab("t", [
      bubble({ role: "tool", text: "tool output" }),
      bubble({ role: "system", text: "sys" }),
    ]);
    const t = chatTabToExportTranscript(tab);
    assert.deepStrictEqual(t.messages.map((m) => m.author), ["Cursor", "Cursor"]);
  });

  it("maps the ask_question tool call to the binary ASK_QUESTION payload", () => {
    const tab = fakeTab("t", [
      bubble({
        role: "assistant",
        text: "",
        toolCalls: [
          toolCall({
            kind: "ask_question_tool_call",
            title: "Ask question",
            question: {
              questionId: "q-1",
              header: "Pick one",
              question: "Which?",
              options: [
                { id: "a", label: "A" },
                { id: "b", label: "B" },
              ],
              multiple: false,
              toolCallId: "tc-1",
            },
          }),
        ],
      }),
    ]);
    const t = chatTabToExportTranscript(tab);
    assert.strictEqual(t.messages.length, 1);
    assert.deepStrictEqual(t.messages[0].askQuestion, {
      title: "Pick one",
      questions: [{ id: "q-1", prompt: "Which?", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }],
    });
  });

  it("returns an empty message list for an empty transcript", () => {
    const t = chatTabToExportTranscript(fakeTab("Empty", []));
    assert.strictEqual(t.name, "Empty");
    assert.deepStrictEqual(t.messages, []);
  });
});
