/**
 * Context ring breakdown tests (node:test, zero extra deps).
 *
 * Unit: CONTEXT_RING_CATEGORIES (8 canonical docs-verbatim labels),
 * estimateTokensFromChars, sharePercentages (largest remainder → sums to 100),
 * computeContextUsageBreakdown (binary t2f percent formula), and the
 * text-measurement helpers (ruleEntryChars, skillsListChars, mcpCatalogChars).
 *
 * Run after `tsc`:  node out/services/test/run-context-usage-tests.mjs
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import {
  CONTEXT_RING_CATEGORIES,
  computeContextUsageBreakdown,
  estimateTokensFromChars,
  mcpCatalogChars,
  ruleEntryChars,
  sharePercentages,
  skillsListChars,
} from "../contextUsageService";

describe("CONTEXT_RING_CATEGORIES", () => {
  it("lists exactly the 8 docs-canonical categories in docs order", () => {
    // Labels verbatim from cursor.com/docs/agent/prompting ("9 canonical
    // categories" in the matrix name is a misnomer — the docs list 8).
    assert.deepEqual([...CONTEXT_RING_CATEGORIES], [
      "System prompt",
      "Tools",
      "Rules",
      "Skills",
      "MCP",
      "Subagents",
      "Summarized conversation",
      "Conversation",
    ]);
  });
});

describe("estimateTokensFromChars", () => {
  it("uses the chars/4 heuristic (ceil)", () => {
    assert.equal(estimateTokensFromChars(0), 0);
    assert.equal(estimateTokensFromChars(1), 1);
    assert.equal(estimateTokensFromChars(4), 1);
    assert.equal(estimateTokensFromChars(5), 2);
    assert.equal(estimateTokensFromChars(400), 100);
  });
  it("never returns negative or NaN", () => {
    assert.equal(estimateTokensFromChars(-10), 0);
    assert.equal(estimateTokensFromChars(Number.NaN), 0);
  });
});

describe("sharePercentages", () => {
  it("sums to exactly 100 (largest remainder, no 99/101 rounding drift)", () => {
    const pcts = sharePercentages([1, 1, 1]);
    assert.equal(pcts.reduce((a, b) => a + b, 0), 100);
    // 33.33… each → the remainder goes to the first bucket.
    assert.deepEqual(pcts, [34, 33, 33]);
  });
  it("returns all zeros when the total is zero", () => {
    assert.deepEqual(sharePercentages([0, 0, 0]), [0, 0, 0]);
    assert.deepEqual(sharePercentages([]), []);
  });
  it("gives 100 to the only non-zero bucket", () => {
    assert.deepEqual(sharePercentages([0, 7, 0]), [0, 100, 0]);
  });
});

describe("computeContextUsageBreakdown", () => {
  function input(overrides: Record<string, number> = {}) {
    return {
      systemPromptChars: 0,
      toolDefChars: 0,
      rulesTextChars: 0,
      skillsTextChars: 0,
      mcpTextChars: 0,
      subagentDocChars: 0,
      summarizedChars: 0,
      conversationTokens: 0,
      contextWindowTokens: 200_000,
      ...overrides,
    };
  }
  it("produces 8 sources in canonical order with tokens + pct", () => {
    const b = computeContextUsageBreakdown(input({ rulesTextChars: 400, conversationTokens: 100 }));
    assert.equal(b.sources.length, 8);
    assert.deepEqual(
      b.sources.map((s) => s.name),
      [...CONTEXT_RING_CATEGORIES],
    );
    const rules = b.sources[2]!;
    assert.equal(rules.tokens, 100); // 400 chars / 4
    const conv = b.sources[7]!;
    assert.equal(conv.tokens, 100); // conversationTokens pass through
    assert.equal(b.totalTokens, 200);
  });
  it("windowPct follows the binary t2f formula: min(used,max)/max*100, rounded", () => {
    const b = computeContextUsageBreakdown(input({ conversationTokens: 50_000 }));
    assert.equal(b.windowPct, 25);
    // Capped at 100 like the binary's Math.min(usedTokens, maxTokens).
    const over = computeContextUsageBreakdown(
      input({ conversationTokens: 500_000 }),
    );
    assert.equal(over.windowPct, 100);
  });
  it("windowPct is 0 when the window is missing or <= 0", () => {
    assert.equal(computeContextUsageBreakdown(input({ contextWindowTokens: 0 })).windowPct, 0);
    assert.equal(
      computeContextUsageBreakdown(input({ contextWindowTokens: -5 })).windowPct,
      0,
    );
  });
  it("empty input yields zero tokens and zero pcts", () => {
    const b = computeContextUsageBreakdown(input());
    assert.equal(b.totalTokens, 0);
    assert.equal(b.windowPct, 0);
    assert.ok(b.sources.every((s) => s.tokens === 0 && s.pct === 0));
  });
});

describe("measurement helpers", () => {
  it("ruleEntryChars mirrors the injected <rule> entry text", () => {
    const rule = { filename: "a.mdc", kind: "always", body: "  be nice  " };
    const expected = `<rule name="a.mdc" type="always">\nbe nice\n</rule>`.length;
    assert.equal(ruleEntryChars(rule), expected);
  });
  it("skillsListChars sums name+description", () => {
    assert.equal(
      skillsListChars([
        { name: "ab", description: "cdef" },
        { name: "g", description: "" },
      ]),
      2 + 1 + 4 + (1 + 1 + 0),
    );
  });
  it("mcpCatalogChars sums namespaced name + description + schema JSON", () => {
    assert.equal(
      mcpCatalogChars([
        { namespacedName: "mcp__s__t", description: "does things", inputSchemaJson: "{}" },
      ]),
      "mcp__s__t".length + 1 + "does things".length + 1 + "{}".length,
    );
  });
});
