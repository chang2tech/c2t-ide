/**
 * conversationSearch tests (node:test, zero extra deps).
 *
 * Pins the local cross-session search index Cursor parity (DEV-GAPS-45):
 * search across ALL agent chat sessions (not just the current transcript),
 * AND token semantics, title/human-turn scoring, snippet windows, recency
 * tie-break, and result limits.
 *
 * Run after `tsc`:  node out/services/conversationSearch.test.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import {
  tokenize,
  makeSnippet,
  searchConversations,
  type SearchableSession,
} from "./conversationSearch";

function session(overrides: Partial<SearchableSession> = {}): SearchableSession {
  return {
    id: "tab-1",
    title: "New chat",
    createdAt: 1000,
    messages: [],
    ...overrides,
  };
}

const SESSIONS: SearchableSession[] = [
  session({
    id: "tab-1",
    title: "Fix the login bug",
    createdAt: 1000,
    messages: [
      { id: "m1", role: "human", text: "the login form crashes on submit", createdAt: 1100 },
      { id: "m2", role: "assistant", text: "I found the bug in the submit handler", createdAt: 1200 },
    ],
  }),
  session({
    id: "tab-2",
    title: "Refactor billing",
    createdAt: 2000,
    messages: [
      { id: "m3", role: "human", text: "optimize the database queries", createdAt: 2100 },
      { id: "m4", role: "assistant", text: "login redirect is handled here", createdAt: 2200 },
    ],
  }),
  session({
    id: "tab-3",
    title: "Empty chat",
    createdAt: 3000,
    messages: [{ id: "m5", role: "human", text: "   ", createdAt: 3100 }],
  }),
];

describe("conversationSearch — tokenize", () => {
  it("lowercases and splits on punctuation", () => {
    assert.deepStrictEqual(tokenize("Login-Form CRASHES!"), ["login", "form", "crashes"]);
  });

  it("keeps accented words (Vietnamese/Cyrillic parity)", () => {
    assert.deepStrictEqual(tokenize("Đăng nhập bị lỗi"), ["đăng", "nhập", "bị", "lỗi"]);
  });

  it("empty input → no tokens", () => {
    assert.deepStrictEqual(tokenize("   !!!"), []);
  });
});

describe("conversationSearch — searchConversations", () => {
  it("finds hits across ALL sessions, not just one transcript", () => {
    const results = searchConversations("login", SESSIONS);
    const sessionIds = new Set(results.map((r) => r.sessionId));
    assert.ok(sessionIds.has("tab-1"), "tab-1 human turn matches");
    assert.ok(sessionIds.has("tab-2"), "tab-2 assistant turn matches");
  });

  it("AND semantics: every token must appear in the session title or the message text", () => {
    // Title and message text form one searchable document per message:
    // "billing" (title) + "login" (message) → the billing tab's hit.
    const results = searchConversations("login billing", SESSIONS);
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0]!.sessionId, "tab-2");
    assert.deepStrictEqual(searchConversations("login zebra", SESSIONS), []);
  });

  it("title hits outrank plain message hits", () => {
    // "login" appears in tab-1's TITLE and in tab-2's message only.
    const results = searchConversations("login", SESSIONS);
    assert.strictEqual(results[0]!.sessionId, "tab-1");
  });

  it("human turns outrank assistant turns at equal token counts", () => {
    // "submit" appears once in m1 (human) and once in m2 (assistant).
    const results = searchConversations("submit", SESSIONS);
    assert.strictEqual(results[0]!.messageId, "m1", "human turn first");
  });

  it("recency breaks score ties", () => {
    const tie: SearchableSession[] = [
      session({
        id: "old",
        createdAt: 100,
        title: "t",
        messages: [{ id: "a", role: "human", text: "same words here", createdAt: 100 }],
      }),
      session({
        id: "new",
        createdAt: 200,
        title: "t",
        messages: [{ id: "b", role: "human", text: "same words here", createdAt: 200 }],
      }),
    ];
    const results = searchConversations("same words", tie);
    assert.strictEqual(results[0]!.sessionId, "new");
  });

  it("empty query or no sessions → empty results", () => {
    assert.deepStrictEqual(searchConversations("", SESSIONS), []);
    assert.deepStrictEqual(searchConversations("login", []), []);
  });

  it("limit caps the result count", () => {
    const results = searchConversations("login", SESSIONS, 1);
    assert.strictEqual(results.length, 1);
  });

  it("blank messages are never indexed", () => {
    const results = searchConversations("empty", SESSIONS);
    assert.ok(!results.some((r) => r.messageId === "m5"));
  });
});

describe("conversationSearch — makeSnippet", () => {
  it("centers on the first query-token hit with ellipsis", () => {
    const text = `lorem ipsum dolor sit amet ${"x ".repeat(40)}needle${" y".repeat(40)}`;
    const snippet = makeSnippet(text, ["needle"]);
    assert.ok(snippet.includes("needle"));
    assert.ok(snippet.startsWith("…"));
    assert.ok(snippet.endsWith("…"));
  });

  it("short text returns as-is with no ellipsis", () => {
    assert.strictEqual(makeSnippet("login crash", ["login"]), "login crash");
  });

  it("title-only hit falls back to the head of the text", () => {
    const text = `no token here at all ${"z ".repeat(100)}`;
    const snippet = makeSnippet(text, ["unmatchedtoken"]);
    assert.ok(snippet.startsWith("no token here"));
    assert.ok(snippet.endsWith("…"));
  });
});
