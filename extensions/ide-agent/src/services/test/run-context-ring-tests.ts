/**
 * Context-ring breakdown tests (node:test, zero extra deps).
 *
 * Unit: the 8 canonical category names (verbatim from
 * cursor.com/docs/agent/prompting), chars/4 token estimates, pct shares
 * summing to exactly 100 (largest remainder), honest-0 for unmeasurable
 * categories, window-full percentage.
 *
 * Run after `tsc`:  node out/services/test/run-context-ring-tests.mjs
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import {
  CONTEXT_RING_CATEGORIES,
  CHARS_PER_TOKEN,
  computeContextUsageBreakdown,
  estimateTokensFromChars,
  mcpCatalogChars,
  ruleEntryChars,
  sharePercentages,
  skillsListChars,
  type ContextUsageInput,
} from "../contextUsageService";
import { formatRuleEntry } from "../projectRules";

function fixtureInput(overrides: Partial<ContextUsageInput> = {}): ContextUsageInput {
  return {
    systemPromptChars: 0, // UNKNOWN on host — honestly 0
    toolDefChars: 0, // UNKNOWN on host — honestly 0
    rulesTextChars: 400, // → 100 tokens
    skillsTextChars: 200, // → 50 tokens
    mcpTextChars: 800, // → 200 tokens
    subagentDocChars: 1200, // → 300 tokens
    summarizedChars: 0, // no summary adopted yet — honestly 0
    conversationTokens: 650, // real estimate from transcript tracker
    contextWindowTokens: 200_000,
    ...overrides,
  };
}

describe("CONTEXT_RING_CATEGORIES", () => {
  it("lists exactly the 8 documented categories in docs order", () => {
    assert.deepStrictEqual([...CONTEXT_RING_CATEGORIES], [
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
  it("uses the chars/4 heuristic and is documented as an estimate", () => {
    assert.strictEqual(CHARS_PER_TOKEN, 4);
    assert.strictEqual(estimateTokensFromChars(400), 100);
    assert.strictEqual(estimateTokensFromChars(401), 101); // ceil, never understates
    assert.strictEqual(estimateTokensFromChars(0), 0);
    assert.strictEqual(estimateTokensFromChars(-5), 0);
  });
});

describe("computeContextUsageBreakdown", () => {
  it("emits 8 sources with the canonical names and honest 0s for unknowns", () => {
    const b = computeContextUsageBreakdown(fixtureInput());
    assert.strictEqual(b.sources.length, 8);
    assert.deepStrictEqual(
      b.sources.map((s) => s.name),
      [...CONTEXT_RING_CATEGORIES],
    );
    const byName = new Map(b.sources.map((s) => [s.name, s]));
    // Unknown to the host → 0 tokens, 0%, never a guess.
    assert.strictEqual(byName.get("System prompt")!.tokens, 0);
    assert.strictEqual(byName.get("System prompt")!.pct, 0);
    assert.strictEqual(byName.get("Tools")!.tokens, 0);
    assert.strictEqual(byName.get("Tools")!.pct, 0);
    // No adopted summary yet → honest 0.
    assert.strictEqual(byName.get("Summarized conversation")!.tokens, 0);
    // Measured categories carry real estimates.
    assert.strictEqual(byName.get("Rules")!.tokens, 100);
    assert.strictEqual(byName.get("Skills")!.tokens, 50);
    assert.strictEqual(byName.get("MCP")!.tokens, 200);
    assert.strictEqual(byName.get("Subagents")!.tokens, 300);
    assert.strictEqual(byName.get("Conversation")!.tokens, 650);
    assert.strictEqual(b.totalTokens, 100 + 50 + 200 + 300 + 650);
  });

  it("pct shares sum to exactly 100", () => {
    const b = computeContextUsageBreakdown(fixtureInput());
    const sum = b.sources.reduce((a, s) => a + s.pct, 0);
    assert.strictEqual(sum, 100);
    for (const s of b.sources) {
      assert.ok(Number.isInteger(s.pct), `${s.name} pct must be an integer`);
      assert.ok(s.pct >= 0 && s.pct <= 100);
    }
  });

  it("all-zero input → all-zero rows (no NaN, no division by zero)", () => {
    const b = computeContextUsageBreakdown(fixtureInput({
      rulesTextChars: 0,
      skillsTextChars: 0,
      mcpTextChars: 0,
      subagentDocChars: 0,
      conversationTokens: 0,
    }));
    assert.strictEqual(b.totalTokens, 0);
    assert.ok(b.sources.every((s) => s.tokens === 0 && s.pct === 0));
    assert.strictEqual(b.windowPct, 0);
  });

  it("windowPct reflects how full the context window is, capped at 100", () => {
    const b = computeContextUsageBreakdown(fixtureInput({ contextWindowTokens: 2600 }));
    assert.strictEqual(b.totalTokens, 1300);
    assert.strictEqual(b.windowPct, 50);
    const over = computeContextUsageBreakdown(fixtureInput({ contextWindowTokens: 100 }));
    assert.strictEqual(over.windowPct, 100);
  });

  it("zero window → windowPct 0 (never NaN)", () => {
    const b = computeContextUsageBreakdown(fixtureInput({ contextWindowTokens: 0 }));
    assert.strictEqual(b.windowPct, 0);
  });
});

describe("sharePercentages", () => {
  it("largest remainder keeps the sum at exactly 100", () => {
    assert.strictEqual(sharePercentages([1, 1, 1]).reduce((a, b) => a + b, 0), 100);
    assert.strictEqual(sharePercentages([7, 3, 5, 11, 2]).reduce((a, b) => a + b, 0), 100);
    assert.deepStrictEqual(sharePercentages([0, 0, 0]), [0, 0, 0]);
    assert.deepStrictEqual(sharePercentages([100]), [100]);
  });
});

describe("text measurement helpers", () => {
  it("ruleEntryChars matches the real injected <rule> entry text", () => {
    const rule = {
      filename: "api.mdc",
      fullPath: "/ws/.cursor/rules/api.mdc",
      workspaceRoot: "/ws",
      subdirPath: "",
      internalPath: "api.mdc",
      description: "",
      globs: [],
      alwaysApply: true,
      attachToBackgroundAgents: false,
      environments: [],
      disabledEnvironments: [],
      body: "Use FastAPI routers.",
      kind: "always" as const,
      warnings: [],
    };
    assert.strictEqual(
      ruleEntryChars({ filename: rule.filename, kind: rule.kind, body: rule.body }),
      formatRuleEntry(rule).length,
    );
  });

  it("skillsListChars sums name+description as injected", () => {
    assert.strictEqual(skillsListChars([]), 0);
    assert.strictEqual(
      skillsListChars([{ name: "plan", description: "Plan first" }]),
      "plan".length + 1 + "Plan first".length,
    );
  });

  it("mcpCatalogChars sums namespaced name+description+schema", () => {
    assert.strictEqual(mcpCatalogChars([]), 0);
    const tools = [
      { namespacedName: "mcp__fs__read", description: "Read a file", inputSchemaJson: '{"type":"object"}' },
    ];
    assert.strictEqual(
      mcpCatalogChars(tools),
      "mcp__fs__read".length + 1 + "Read a file".length + 1 + '{"type":"object"}'.length,
    );
  });
});
