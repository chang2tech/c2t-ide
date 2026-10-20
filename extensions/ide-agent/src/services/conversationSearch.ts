/**
 * Conversation search — local search index across ALL agent chat sessions
 * (DEV-GAPS-45, chat-conversation-search).
 *
 * REA spec (deep-docs-all.md:59, deep-changelog-timeline.md:132,
 * doc-gap-chat-agent.md:26, audit-fix-queue "P2 — Conversation search is
 * current-transcript-only"):
 *   - Cmd/Ctrl+K in the Agents Window searches PAST chats via a local index
 *     ("3.11+, local index, thousands of conversations");
 *   - Cmd/Ctrl+F is find WITHIN the open chat with a match counter (already
 *     implemented — services/findInChat.ts + the webview find bar).
 *
 * This module is the host-side index: pure functions over session
 * transcripts, no vscode import, so it is fully unit-testable. The caller
 * (extension.ts `ide.searchConversations`) feeds it one
 * SearchableSession per chat tab and jumps to the picked result's tab.
 */

/** One transcript message, trimmed to what the index needs. */
export interface SearchableMessage {
  id: string;
  role: "human" | "assistant" | "system";
  text: string;
  createdAt: number;
}

/** One chat session (a chat tab's transcript). */
export interface SearchableSession {
  id: string;
  title: string;
  createdAt: number;
  messages: SearchableMessage[];
}

/** One hit: the matching message plus the session to open. */
export interface ConversationSearchResult {
  sessionId: string;
  sessionTitle: string;
  messageId: string;
  role: SearchableMessage["role"];
  createdAt: number;
  /** Short context window around the first query-token hit. */
  snippet: string;
  score: number;
}

const SNIPPET_RADIUS = 60;
const DEFAULT_LIMIT = 25;

/** Tokenize: lowercase words; drop empties and single punctuation. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9\u00c0-\u024f\u1e00-\u1eff\u0400-\u04ff]+/u)
    .filter((t) => t.length > 0);
}

/**
 * Build a snippet around the first occurrence of any query token.
 * Falls back to the head of the text when no token is visible there
 * (title-only hits).
 */
export function makeSnippet(text: string, queryTokens: string[]): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) {
    return "";
  }
  const lower = clean.toLowerCase();
  let hit = -1;
  for (const tok of queryTokens) {
    const idx = lower.indexOf(tok);
    if (idx >= 0 && (hit < 0 || idx < hit)) {
      hit = idx;
    }
  }
  if (hit < 0) {
    return clean.length > 2 * SNIPPET_RADIUS ? `${clean.slice(0, 2 * SNIPPET_RADIUS)}…` : clean;
  }
  const start = Math.max(0, hit - SNIPPET_RADIUS);
  const end = Math.min(clean.length, hit + SNIPPET_RADIUS);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < clean.length ? "…" : "";
  return `${prefix}${clean.slice(start, end)}${suffix}`;
}

interface ScoredMessage {
  session: SearchableSession;
  message: SearchableMessage;
  score: number;
}

/**
 * Search every session's transcript (title + all turns) for `query`.
 *
 * Semantics: tokenize the query; a message matches when EVERY token appears
 * in its session title or message text (AND — precision first, the way the
 * Agents Window's search behaves). Scoring per matched message:
 *   title token hit ........ +3
 *   human-turn token hit .... +2
 *   assistant/system hit ..... +1
 * Results sort by score desc, then recency desc (Cursor surfaces the latest
 * relevant chat first).
 */
export function searchConversations(
  query: string,
  sessions: SearchableSession[],
  limit: number = DEFAULT_LIMIT,
): ConversationSearchResult[] {
  const tokens = tokenize(query);
  if (!tokens.length || !sessions.length || limit <= 0) {
    return [];
  }
  const hits: ScoredMessage[] = [];
  for (const session of sessions) {
    const titleTokens = new Set(tokenize(session.title));
    const titleMatches = tokens.filter((t) => titleTokens.has(t)).length;
    for (const message of session.messages) {
      const text = message.text || "";
      if (!text.trim()) {
        continue;
      }
      const messageTokens = new Set(tokenize(text));
      // Every query token must appear in the title or the message text.
      const allHit = tokens.every((t) => titleTokens.has(t) || messageTokens.has(t));
      if (!allHit) {
        continue;
      }
      const roleWeight = message.role === "human" ? 2 : 1;
      const tokenScore = tokens.filter((t) => messageTokens.has(t)).length * roleWeight;
      const score = titleMatches * 3 + tokenScore;
      hits.push({ session, message, score });
    }
  }
  hits.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return b.message.createdAt - a.message.createdAt;
  });
  return hits.slice(0, limit).map((h) => ({
    sessionId: h.session.id,
    sessionTitle: h.session.title,
    messageId: h.message.id,
    role: h.message.role,
    createdAt: h.message.createdAt,
    snippet: makeSnippet(h.message.text, tokens),
    score: h.score,
  }));
}
