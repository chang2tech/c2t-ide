/**
 * Canvas context usage report (GAPS-167) — Cursor 3.25.9 parity.
 *
 * Binary evidence (workbench.desktop.main.js, Cursor 3.25.9; glass bundle
 * carries the same source at +2,850,421 bytes):
 * - The report is a React canvas app whose FULL readable source is embedded
 *   in the bundle as `CONTEXT_USAGE_CANVAS_SOURCE` (module
 *   `contextUsageCanvasSource.js`, desk@22090791; template literal
 *   desk@22090858–22157958, 67,100 chars). Every COPY string, category help
 *   text and formatter below is copied verbatim from that source.
 * - Host producer (desk@28059533 `s8y`, desk@28061011 `a8y`): category
 *   totals come from the SERVER `promptTokenBreakdown` on composer data;
 *   item rows come from `rootPromptMessagesJson` + the composer blob store
 *   (local) or the `GetPromptContextUsage` RPC (cloud). The host writes a
 *   managed canvas file `context-usage-<composerId>` plus a data file keyed
 *   `contextUsage` (constants module desk@~22090610: `j7o = "contextUsage"`,
 *   top-focus sentinel `"__context_usage_canvas_top__"`) and opens it as a
 *   canvas tab. Trigger: the composer context tray's "View Report" button
 *   (desk@28074033, `composer-context-usage-tray__see-details-button`).
 *
 * HONEST DIVERGENCES for this fork (do not remove without new evidence):
 * - SURFACE: the fork has no Cursor-style managed-canvas surface (feature
 *   `agent-canvas` is still DISCOVERED; the upstream sessions canvas is a
 *   different mechanism). The report renders as a panel inside the chat
 *   webview — the same webview that hosts the fork's context tray, which is
 *   where Cursor's own "View Report" entry point lives.
 * - DATA: the engine exposes no `promptTokenBreakdown` /
 *   `GetPromptContextUsage` equivalent, so totals are the fork's REAL
 *   host-observed chars/4 estimates from contextUsageService.ts (the exact
 *   heuristic the Cursor canvas itself uses for items without an
 *   estimatedTokens value: `Math.round(text.length / 4)`). "System prompt"
 *   and "Tools" are engine-owned and unobservable on the host — they
 *   measure 0 and are filtered out exactly like the binary's `a8y` filters
 *   zero-token categories; they are NEVER guessed.
 * - The canvas reads `useCanvasState('contextUsage')`; the fork webview
 *   receives the same data shape as a `ctxUsageReport` host message built
 *   by ComposerDataService.getContextUsageReport().
 * - DENOMINATOR (GAPS-183): the window size is the ACTIVE model's real
 *   `contextTokenLimit` from the engine model catalog, resolved by
 *   ComposerDataService (resolveActiveContextTokenLimit in
 *   modelService.ts) and shared with the context ring — the same source
 *   the binary's host uses conceptually (its limit arrives from the server
 *   on composer data; the fork's best real source is its engine catalog).
 *   Only when no limit can be resolved does the fork fall back to 200k
 *   (FALLBACK_CONTEXT_WINDOW_TOKENS) — that fallback is fork-local; the
 *   binary has no such fallback.
 *
 * This module is PURE (no vscode import) so the report math/formatting is
 * unit-testable with node:test.
 */

/** Data shape — mirrors `ContextUsageCanvasData` in the binary source. */
export interface ContextUsageReportCategory {
  id: string;
  label: string;
  tokens: number;
  displayTokens: string;
  color?: string;
}

export interface ContextUsageReportItem {
  id: string;
  parentId?: string;
  categoryId: string;
  label: string;
  text: string;
  estimatedTokens?: number;
}

export interface ContextUsageReportConversationTurn {
  id: string;
  title: string;
  itemIds: string[];
}

export interface ContextUsageReportData {
  categories: ContextUsageReportCategory[];
  contextWindowSize: number;
  contextWindowLabel: string;
  totalTokensUsed: number;
  totalTokensLabel: string;
  percentFullLabel: string;
  items?: ContextUsageReportItem[];
  conversationTurns?: ContextUsageReportConversationTurn[];
  composerChatName?: string;
  repository?: string;
  /** Some transcript segments were no longer available when built. */
  incompleteReport?: boolean;
}

/** Verbatim from the binary canvas source (`const COPY = { … }`, desk@22095564). */
export const CONTEXT_USAGE_COPY = {
  eyebrow: "Context Usage Report",
  donutCaption: "Full",
  explorerTitle: "Context Explorer",
  debugButton: "Debug with Agent",
  expandAll: "Expand All",
  collapseAll: "Collapse All",
  openChat: "Open Chat",
  emptyState: "No context breakdown loaded yet.",
  contextFullTitle: "Context window is getting full",
  incompleteReportTitle: "Some items could not be loaded",
  incompleteReportBody:
    "Part of this conversation was not available when the report was built. The category totals are complete; reopen the report to try loading the missing items.",
  metaRepository: "Repository",
  metaContextSize: "Context size",
  metaTokensUsed: "Tokens used",
  intro:
    "The context window contains everything your agent sees on a single turn. This includes Cursor\u2019s own instructions, any relevant files, the tools it can access, and the conversation itself. The agent reads all of this each turn, and it can only hold so much. As the context window fills up, the agent has less room to reason, replies can slow down, and older details may be dropped to make space. Some of what\u2019s here is set up by Cursor and some is yours to control.",
  explorerIntro:
    "The categories below show what\u2019s in your agent\u2019s context window, sorted by how many tokens it\u2019s using right now.",
} as const;

/** Verbatim `CATEGORY_HELP` from the binary canvas source (desk@22091k). */
export const CONTEXT_USAGE_CATEGORY_HELP: Record<string, string> = {
  system_prompt:
    "The system prompt is the set of instructions Cursor provides to an agent at the start of every chat. It defines the agent\u2019s tone, sets ground rules, and outlines how it should use tools.",
  tools:
    "Tool definitions describe everything the agent can do, such as reading files, running commands, or searching the web. Tool definitions help the agent know what its options are, and Cursor manages this for you.",
  rules:
    "Rules are standing instructions the agent follows each turn. Use them to define style conventions, security best practices, or general context for how your project fits together. Keep rules focused and lightweight to avoid bloat.",
  skills:
    "Skills are reusable prompts for common tasks. The agent can invoke skills automatically when they\u2019re appropriate, or you can trigger them yourself via a slash command. Use skills when you notice yourself spelling out the same steps over and over.",
  mcp:
    "MCP servers connect the agent to outside services like workplace messengers, issue trackers, and design tools. Each additional MCP occupies some of the context window, so it\u2019s worth keeping them to just the ones you need.",
  subagents:
    "Subagents are focused helpers the main agent can delegate tasks to, in order to complete big jobs in parallel. This workflow can help free up context in the main agent, since it doesn\u2019t need to occupy itself with every detail.",
  summarized_conversation:
    "Conversations are automatically summarized into a short recap when they get too long. This helps the main agent free up context and maintain space for the task at hand.",
  conversation:
    "This is the running back-and-forth of your chat: your prompts, the agent\u2019s replies, and the tool calls in between. It\u2019s normal for the conversation to grow quite large as you work, and Cursor will periodically summarize it to free up space.",
  uncategorized:
    "This covers tokens that don\u2019t fall neatly into the buckets above.",
};

/** Verbatim fallback from the binary's `getCategoryHelpText`. */
export function getContextUsageCategoryHelpText(categoryId: string): string {
  return (
    CONTEXT_USAGE_CATEGORY_HELP[categoryId] ??
    "How much of the context window this category used on the last agent turn."
  );
}

/**
 * Verbatim prompt the binary's "Debug with Agent" button sends as a new
 * composer chat (`CONTEXT_REDUCTION_PROMPT`, desk canvas source; dispatched
 * as `{type:'newComposerChat', userPrompt}`).
 */
export const CONTEXT_REDUCTION_PROMPT =
  "Read this context usage canvas and its corresponding data. Are there any opportunities to reduce context usage? Feel free to update the canvas to call out specific items or opportunities if helpful.";

/**
 * Category metadata. Ids + colors verbatim from the binary host color map
 * (`rQp`, desk@~28060500); labels are the fork context ring's canonical
 * category names (cursor.com/docs/agent/prompting — the same 8 the binary
 * tray uses; the binary's 9th bucket, `uncategorized`/"Other", is the
 * remainder bucket added by `a8y` when the server total exceeds the sum of
 * categories — impossible here because the fork total IS the sum).
 */
export const CONTEXT_USAGE_CATEGORY_META: readonly {
  id: string;
  /** Fork ring category name (contextUsageService CONTEXT_RING_CATEGORIES). */
  ringName: string;
  label: string;
  color: string;
}[] = [
  { id: "system_prompt", ringName: "System prompt", label: "System prompt", color: "gray" },
  { id: "tools", ringName: "Tools", label: "Tools", color: "purple" },
  { id: "rules", ringName: "Rules", label: "Rules", color: "green" },
  { id: "skills", ringName: "Skills", label: "Skills", color: "yellow" },
  { id: "mcp", ringName: "MCP", label: "MCP", color: "pink" },
  { id: "subagents", ringName: "Subagents", label: "Subagents", color: "blue" },
  { id: "summarized_conversation", ringName: "Summarized conversation", label: "Summarized conversation", color: "red" },
  { id: "conversation", ringName: "Conversation", label: "Conversation", color: "orange" },
];

// ============================================================================
// Token formatting — verbatim from the binary canvas source.
// ============================================================================

/** Full count with thousands separators (e.g. 8,134), not shortened to 8.1K. */
export function formatTokenCount(count: number): string {
  return Math.round(count).toLocaleString("en-US");
}

export function estimateTokensFromText(text: string): number {
  return Math.max(0, Math.round(text.length / 4));
}

export function getItemEstimatedTokens(item: ContextUsageReportItem): number {
  if (item.estimatedTokens !== undefined && item.estimatedTokens > 0) {
    return item.estimatedTokens;
  }
  return estimateTokensFromText(item.text);
}

/** Trailing counts list a bare number (`~8,134`); only the first category row spells out the "tokens" unit. */
export function formatTokenLabel(tokens: number): string {
  return `~${formatTokenCount(tokens)}`;
}

export function formatItemTrailing(item: ContextUsageReportItem): string {
  return formatTokenLabel(getItemEstimatedTokens(item));
}

/** Verbatim from the binary host (`o8y`, desk@~28060800): `"0% Full"` when size <= 0. */
export function formatPercentFullLabel(totalTokensUsed: number, contextWindowSize: number): string {
  if (contextWindowSize <= 0) {
    return "0% Full";
  }
  return `${Math.round((totalTokensUsed / contextWindowSize) * 100)}% Full`;
}

/** Donut percentage, verbatim formula from the binary canvas root component. */
export function contextUsagePercentFull(totalTokensUsed: number, contextWindowSize: number): number {
  return contextWindowSize > 0 ? (totalTokensUsed / contextWindowSize) * 100 : 0;
}

/** The binary shows the "getting full" callout at percentFull >= 80. */
export const CONTEXT_FULL_CALLOUT_THRESHOLD_PCT = 80;

/** Verbatim callout body template from the binary canvas source. */
export function formatContextFullCalloutBody(largest: { label: string; tokens: number }): string {
  return `${largest.label} is your largest bucket at ${formatTokenCount(largest.tokens)} tokens. Summarizing the conversation or starting a new chat usually frees the most room. Expand categories below to find the biggest individual items.`;
}

// ============================================================================
// Report builder
// ============================================================================

export interface ContextUsageReportInput {
  /** Fork ring sources: canonical name → estimated tokens (contextUsageService). */
  sources: readonly { name: string; tokens: number }[];
  contextWindowTokens: number;
  /** Real measured item texts, keyed by binary category id. */
  itemsByCategory?: ReadonlyMap<string, readonly { label: string; text: string }[]>;
  /** Conversation turns (oldest first) referencing conversation item indexes. */
  conversationTurns?: ContextUsageReportConversationTurn[];
  composerChatName?: string;
  repository?: string;
  incompleteReport?: boolean;
}

/**
 * Build the report data. Mirrors the binary host `a8y` semantics: sanitize
 * token counts (non-finite/negative → 0, rounded), drop zero-token
 * categories, total = max(server total, sum) there — here the fork total IS
 * the category sum (no server total exists). Categories are sorted by
 * tokens descending, per the verbatim explorer intro ("sorted by how many
 * tokens it's using right now").
 */
export function buildContextUsageReport(input: ContextUsageReportInput): ContextUsageReportData {
  const sanitize = (v: number): number =>
    v === undefined || !Number.isFinite(v) ? 0 : Math.max(0, Math.round(v));

  const byRingName = new Map(input.sources.map((s) => [s.name, sanitize(s.tokens)]));
  const categories: ContextUsageReportCategory[] = [];
  for (const meta of CONTEXT_USAGE_CATEGORY_META) {
    const tokens = byRingName.get(meta.ringName) ?? 0;
    if (tokens <= 0) {
      continue;
    }
    categories.push({
      id: meta.id,
      label: meta.label,
      tokens,
      displayTokens: formatTokenCount(tokens),
      color: meta.color,
    });
  }
  categories.sort((a, b) => b.tokens - a.tokens);

  const totalTokensUsed = categories.reduce((a, c) => a + c.tokens, 0);
  const contextWindowSize = sanitize(input.contextWindowTokens);

  const items: ContextUsageReportItem[] = [];
  if (input.itemsByCategory) {
    for (const category of categories) {
      const rows = input.itemsByCategory.get(category.id) ?? [];
      rows.forEach((row, i) => {
        items.push({
          id: `${category.id}-${i}`,
          categoryId: category.id,
          label: row.label,
          text: row.text,
          estimatedTokens: estimateTokensFromText(row.text),
        });
      });
    }
  }

  const chatName = input.composerChatName?.trim();
  return {
    categories,
    contextWindowSize,
    contextWindowLabel: formatTokenCount(contextWindowSize),
    totalTokensUsed,
    totalTokensLabel: formatTokenLabel(totalTokensUsed),
    percentFullLabel: formatPercentFullLabel(totalTokensUsed, contextWindowSize),
    ...(items.length > 0 ? { items } : {}),
    ...(input.conversationTurns && input.conversationTurns.length > 0
      ? { conversationTurns: input.conversationTurns }
      : {}),
    composerChatName: chatName && chatName.length > 0 ? chatName : "Untitled Chat",
    ...(input.repository?.trim() ? { repository: input.repository.trim() } : {}),
    ...(input.incompleteReport === true ? { incompleteReport: true } : {}),
  };
}

/**
 * Group raw TranscriptTracker segments into conversation turns + items.
 * Segment formats are the tracker's own (`## User\n…`, `## Assistant\n…`,
 * `## Tool: <name>\n…`, `Result (<id>): …`). A new turn starts at each
 * `## User` segment; the turn title is the first line of that user prompt.
 * Item labels follow the binary canvas's own conventions: user rows are
 * labeled "User Message" (the canvas special-cases that exact label) and
 * tool rows start with "Tool" (the canvas renders the wrench glyph for
 * labels starting with "tool", case-insensitive).
 */
export function conversationItemsFromSegments(segments: readonly string[]): {
  items: { label: string; text: string }[];
  turns: ContextUsageReportConversationTurn[];
} {
  const items: { label: string; text: string }[] = [];
  const turns: ContextUsageReportConversationTurn[] = [];
  let currentTurn: ContextUsageReportConversationTurn | undefined;

  const pushItem = (label: string, text: string): void => {
    const id = `conversation-${items.length}`;
    items.push({ label, text });
    if (!currentTurn) {
      currentTurn = { id: `turn-${turns.length}`, title: "Conversation", itemIds: [] };
      turns.push(currentTurn);
    }
    currentTurn.itemIds.push(id);
  };

  for (const segment of segments) {
    if (segment.startsWith("## User\n")) {
      const text = segment.slice("## User\n".length).trim();
      const firstLine = text.split("\n")[0]?.trim() ?? "";
      currentTurn = {
        id: `turn-${turns.length}`,
        title: firstLine.length > 0 ? firstLine.slice(0, 80) : "User Message",
        itemIds: [],
      };
      turns.push(currentTurn);
      pushItem("User Message", text);
    } else if (segment.startsWith("## Assistant\n")) {
      pushItem("Assistant", segment.slice("## Assistant\n".length).trim());
    } else if (segment.startsWith("## Tool: ")) {
      const rest = segment.slice("## Tool: ".length);
      const name = rest.split("\n")[0]?.trim() ?? "";
      pushItem(`Tool: ${name}`, rest.slice(name.length).trim());
    } else if (segment.startsWith("Result (")) {
      pushItem("Tool result", segment.trim());
    } else if (segment.trim().length > 0) {
      pushItem("Conversation", segment.trim());
    }
  }
  // Turn itemIds use the `conversation-<index>` scheme in item order, which
  // is exactly the id scheme buildContextUsageReport assigns per category.
  return { items, turns };
}
