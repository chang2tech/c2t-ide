/**
 * GAPS-167 — canvas-context-usage-report.
 *
 * Evidence: Cursor 3.25.9 workbench.desktop.main.js embeds the report's
 * full readable canvas source (`CONTEXT_USAGE_CANVAS_SOURCE`,
 * desk@22090858–22157958) and the host producer (`a8y`/`s8y`,
 * desk@28059533/28061011). These tests pin the verbatim COPY, the verbatim
 * formatters, and the builder semantics (zero-token categories filtered
 * like `a8y`, categories sorted by tokens per the verbatim explorer intro).
 * The pure module needs no vscode shim.
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import {
  CONTEXT_FULL_CALLOUT_THRESHOLD_PCT,
  CONTEXT_REDUCTION_PROMPT,
  CONTEXT_USAGE_CATEGORY_HELP,
  CONTEXT_USAGE_COPY,
  buildContextUsageReport,
  contextUsagePercentFull,
  conversationItemsFromSegments,
  estimateTokensFromText,
  formatContextFullCalloutBody,
  formatPercentFullLabel,
  formatTokenCount,
  formatTokenLabel,
  getContextUsageCategoryHelpText,
  getItemEstimatedTokens,
} from "./contextUsageReport";
import { FALLBACK_CONTEXT_WINDOW_TOKENS } from "./contextUsageService";

describe("contextUsageReport COPY (verbatim from binary canvas source)", () => {
  it("pins the COPY block strings", () => {
    assert.strictEqual(CONTEXT_USAGE_COPY.eyebrow, "Context Usage Report");
    assert.strictEqual(CONTEXT_USAGE_COPY.donutCaption, "Full");
    assert.strictEqual(CONTEXT_USAGE_COPY.explorerTitle, "Context Explorer");
    assert.strictEqual(CONTEXT_USAGE_COPY.debugButton, "Debug with Agent");
    assert.strictEqual(CONTEXT_USAGE_COPY.expandAll, "Expand All");
    assert.strictEqual(CONTEXT_USAGE_COPY.collapseAll, "Collapse All");
    assert.strictEqual(CONTEXT_USAGE_COPY.openChat, "Open Chat");
    assert.strictEqual(CONTEXT_USAGE_COPY.emptyState, "No context breakdown loaded yet.");
    assert.strictEqual(CONTEXT_USAGE_COPY.contextFullTitle, "Context window is getting full");
    assert.strictEqual(CONTEXT_USAGE_COPY.incompleteReportTitle, "Some items could not be loaded");
    assert.strictEqual(CONTEXT_USAGE_COPY.metaRepository, "Repository");
    assert.strictEqual(CONTEXT_USAGE_COPY.metaContextSize, "Context size");
    assert.strictEqual(CONTEXT_USAGE_COPY.metaTokensUsed, "Tokens used");
    assert.ok(CONTEXT_USAGE_COPY.intro.startsWith("The context window contains everything your agent sees"));
    assert.ok(CONTEXT_USAGE_COPY.explorerIntro.includes("sorted by how many tokens"));
  });

  it("pins the Debug with Agent prompt verbatim", () => {
    assert.strictEqual(
      CONTEXT_REDUCTION_PROMPT,
      "Read this context usage canvas and its corresponding data. Are there any opportunities to reduce context usage? Feel free to update the canvas to call out specific items or opportunities if helpful.",
    );
  });

  it("category help: known ids verbatim, unknown id falls back verbatim", () => {
    assert.ok(CONTEXT_USAGE_CATEGORY_HELP.rules!.startsWith("Rules are standing instructions"));
    assert.ok(CONTEXT_USAGE_CATEGORY_HELP.conversation!.startsWith("This is the running back-and-forth"));
    assert.strictEqual(
      getContextUsageCategoryHelpText("no-such-category"),
      "How much of the context window this category used on the last agent turn.",
    );
  });
});

describe("contextUsageReport formatting (verbatim binary functions)", () => {
  it("formatTokenCount: full count with en-US separators, rounded", () => {
    assert.strictEqual(formatTokenCount(8134), "8,134");
    assert.strictEqual(formatTokenCount(8134.6), "8,135");
    assert.strictEqual(formatTokenCount(200000), "200,000");
    assert.strictEqual(formatTokenCount(0), "0");
  });

  it("estimateTokensFromText: chars/4 rounded, clamped at 0", () => {
    assert.strictEqual(estimateTokensFromText(""), 0);
    assert.strictEqual(estimateTokensFromText("abcd"), 1);
    assert.strictEqual(estimateTokensFromText("abcdef"), 2); // round(1.5) = 2
  });

  it("formatTokenLabel prefixes ~; item trailing prefers explicit estimatedTokens", () => {
    assert.strictEqual(formatTokenLabel(8134), "~8,134");
    assert.strictEqual(getItemEstimatedTokens({ id: "x", categoryId: "rules", label: "a", text: "abcd", estimatedTokens: 42 }), 42);
    assert.strictEqual(getItemEstimatedTokens({ id: "x", categoryId: "rules", label: "a", text: "abcd", estimatedTokens: 0 }), 1);
  });

  it("percentFullLabel + percent: 0% Full when window is 0", () => {
    assert.strictEqual(formatPercentFullLabel(0, 0), "0% Full");
    assert.strictEqual(formatPercentFullLabel(50000, 200000), "25% Full");
    assert.strictEqual(contextUsagePercentFull(50000, 200000), 25);
    assert.strictEqual(contextUsagePercentFull(10, 0), 0);
  });

  it("context-full callout body is the verbatim template", () => {
    assert.strictEqual(
      formatContextFullCalloutBody({ label: "Conversation", tokens: 123456 }),
      "Conversation is your largest bucket at 123,456 tokens. Summarizing the conversation or starting a new chat usually frees the most room. Expand categories below to find the biggest individual items.",
    );
  });
});

describe("buildContextUsageReport", () => {
  it("filters zero-token categories (a8y semantics), sorts desc, totals = sum", () => {
    const report = buildContextUsageReport({
      sources: [
        { name: "System prompt", tokens: 0 },
        { name: "Tools", tokens: 0 },
        { name: "Rules", tokens: 1200 },
        { name: "Skills", tokens: 300 },
        { name: "MCP", tokens: 0 },
        { name: "Subagents", tokens: 500 },
        { name: "Summarized conversation", tokens: 0 },
        { name: "Conversation", tokens: 5000 },
      ],
      contextWindowTokens: 200000,
    });
    assert.deepStrictEqual(
      report.categories.map((c) => c.id),
      ["conversation", "rules", "subagents", "skills"],
    );
    assert.strictEqual(report.totalTokensUsed, 7000);
    assert.strictEqual(report.totalTokensLabel, "~7,000");
    assert.strictEqual(report.percentFullLabel, "4% Full"); // round(3.5) = 4
    assert.strictEqual(report.contextWindowLabel, "200,000");
    assert.strictEqual(report.categories[0]!.color, "orange");
    assert.strictEqual(report.categories[0]!.displayTokens, "5,000");
    assert.strictEqual(report.composerChatName, "Untitled Chat");
    assert.strictEqual(report.items, undefined);
  });

  it("sanitizes non-finite/negative source tokens to 0", () => {
    const report = buildContextUsageReport({
      sources: [
        { name: "Rules", tokens: Number.NaN },
        { name: "Skills", tokens: -50 },
        { name: "Conversation", tokens: 100.4 },
      ],
      contextWindowTokens: 200000,
    });
    assert.deepStrictEqual(report.categories.map((c) => c.id), ["conversation"]);
    assert.strictEqual(report.categories[0]!.tokens, 100);
  });

  it("attaches items only for present categories, with per-category ids + estimates", () => {
    const report = buildContextUsageReport({
      sources: [
        { name: "Rules", tokens: 10 },
        { name: "Conversation", tokens: 20 },
      ],
      contextWindowTokens: 1000,
      itemsByCategory: new Map([
        ["rules", [{ label: "a.mdc", text: "12345678" }]],
        ["mcp", [{ label: "ghost", text: "should be dropped" }]],
      ]),
      composerChatName: "  My Chat  ",
      repository: " my-repo ",
      incompleteReport: true,
    });
    assert.strictEqual(report.items!.length, 1);
    assert.strictEqual(report.items![0]!.id, "rules-0");
    assert.strictEqual(report.items![0]!.estimatedTokens, 2);
    assert.strictEqual(report.composerChatName, "My Chat");
    assert.strictEqual(report.repository, "my-repo");
    assert.strictEqual(report.incompleteReport, true);
  });

  it("empty sources → empty categories (webview renders the empty state)", () => {
    const report = buildContextUsageReport({ sources: [], contextWindowTokens: 200000 });
    assert.deepStrictEqual(report.categories, []);
    assert.strictEqual(report.totalTokensUsed, 0);
    assert.strictEqual(report.percentFullLabel, "0% Full");
  });
});

describe("GAPS-183 — report denominator is the active model's real limit", () => {
  it("128k catalog limit: percent + label + window size all use 128,000", () => {
    const report = buildContextUsageReport({
      sources: [{ name: "Conversation", tokens: 102_400 }],
      // The value ComposerDataService resolved from the engine catalog for
      // a model whose contextTokenLimit is 128k (see modelService
      // resolveActiveContextTokenLimit tests).
      contextWindowTokens: 128_000,
    });
    assert.strictEqual(report.contextWindowSize, 128_000);
    assert.strictEqual(report.contextWindowLabel, "128,000");
    assert.strictEqual(report.totalTokensUsed, 102_400);
    assert.strictEqual(report.percentFullLabel, "80% Full");
    // The ≥80 "getting full" callout threshold is hit with the real
    // denominator — at the old hard-coded 200k it would NOT have fired.
    assert.strictEqual(contextUsagePercentFull(102_400, 128_000), 80);
    assert.ok(contextUsagePercentFull(102_400, 128_000) >= CONTEXT_FULL_CALLOUT_THRESHOLD_PCT);
    assert.ok(contextUsagePercentFull(102_400, 200_000) < CONTEXT_FULL_CALLOUT_THRESHOLD_PCT);
  });

  it("1M catalog limit: the same usage is a small percent of the real window", () => {
    const report = buildContextUsageReport({
      sources: [{ name: "Conversation", tokens: 50_000 }],
      contextWindowTokens: 1_000_000,
    });
    assert.strictEqual(report.contextWindowSize, 1_000_000);
    assert.strictEqual(report.contextWindowLabel, "1,000,000");
    assert.strictEqual(report.percentFullLabel, "5% Full");
    assert.strictEqual(contextUsagePercentFull(50_000, 1_000_000), 5);
  });

  it("fallback: FALLBACK_CONTEXT_WINDOW_TOKENS is the fork's 200k, used only when unresolved", () => {
    assert.strictEqual(FALLBACK_CONTEXT_WINDOW_TOKENS, 200_000);
    const report = buildContextUsageReport({
      sources: [{ name: "Conversation", tokens: 50_000 }],
      contextWindowTokens: FALLBACK_CONTEXT_WINDOW_TOKENS,
    });
    assert.strictEqual(report.contextWindowSize, 200_000);
    assert.strictEqual(report.contextWindowLabel, "200,000");
    assert.strictEqual(report.percentFullLabel, "25% Full");
  });
});

describe("conversationItemsFromSegments", () => {
  it("groups tracker segments into turns with canvas-convention labels", () => {
    const { items, turns } = conversationItemsFromSegments([
      "## User\nFix the bug in parser\nmore detail\n",
      "## Assistant\nLooking into it.\n",
      "## Tool: read\nInput: {\"path\":\"a.ts\"}\n",
      "Result (t1): file contents\n",
      "## User\nThanks, now add a test\n",
      "## Assistant\nDone.\n",
    ]);
    assert.deepStrictEqual(
      items.map((i) => i.label),
      ["User Message", "Assistant", "Tool: read", "Tool result", "User Message", "Assistant"],
    );
    assert.strictEqual(turns.length, 2);
    assert.strictEqual(turns[0]!.title, "Fix the bug in parser");
    assert.deepStrictEqual(turns[0]!.itemIds, ["conversation-0", "conversation-1", "conversation-2", "conversation-3"]);
    assert.deepStrictEqual(turns[1]!.itemIds, ["conversation-4", "conversation-5"]);
    assert.strictEqual(items[0]!.text, "Fix the bug in parser\nmore detail");
  });

  it("segments before the first user prompt form a leading Conversation turn", () => {
    const { items, turns } = conversationItemsFromSegments(["## Assistant\nHi.\n"]);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(turns.length, 1);
    assert.strictEqual(turns[0]!.title, "Conversation");
  });

  it("empty input → no items, no turns", () => {
    const { items, turns } = conversationItemsFromSegments([]);
    assert.deepStrictEqual(items, []);
    assert.deepStrictEqual(turns, []);
  });
});
