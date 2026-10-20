/**
 * Context ring breakdown (Cursor parity: cursor.com/docs/agent/prompting).
 *
 * "The context ring next to your prompt input shows how full the window is at
 * a glance. Click the ring to open the breakdown tray, which shows the total
 * tokens used split by category: System prompt / Tools / Rules / Skills /
 * MCP / Subagents / Summarized conversation / Conversation."
 *
 * HONESTY CONTRACT (hard rule — never fabricate):
 * - Every category is measured from REAL text the host actually observes
 *   (injected rule bodies, skill name+description list, MCP tool catalog,
 *   subagent instruction text, adopted summary text, SSE-observed
 *   transcript). Token figures are chars/4 ESTIMATES — the engine owns the
 *   authoritative token accounting server-side and reports no usage over
 *   the wire, so host figures are always labeled estimates.
 * - A category the host cannot observe measures 0 with an explicit UNKNOWN
 *   comment at the call site — never a plausible-looking guess.
 *
 * DISCREPANCY (recorded per mission brief): the internal planning matrix
 * called this "9 canonical categories", but cursor.com/docs/agent/prompting
 * (verified 2026-10-19) lists exactly 8. This implements the 8 documented
 * ones; the canonical names below are copied verbatim from the docs page.
 *
 * This module is PURE (no vscode import) so the breakdown math is unit-
 * testable with node:test. All vscode/engine-dependent data gathering lives
 * in the caller (ComposerDataService), which passes measured char counts in.
 */

/** Canonical category names, verbatim from cursor.com/docs/agent/prompting. */
export const CONTEXT_RING_CATEGORIES = [
  "System prompt",
  "Tools",
  "Rules",
  "Skills",
  "MCP",
  "Subagents",
  "Summarized conversation",
  "Conversation",
] as const;

export type ContextRingCategory = (typeof CONTEXT_RING_CATEGORIES)[number];

/**
 * chars/4 token heuristic. MUST be labeled an estimate everywhere it is
 * used — the engine's real tokenizer accounting is not visible to the host.
 */
export const CHARS_PER_TOKEN = 4;

/**
 * GAPS-183: FALLBACK context-window denominator (tokens) for the ring/report
 * when the active model's real `contextTokenLimit` cannot be resolved
 * (unknown model, catalog entry without a limit, stub engine with no
 * catalog, or the catalog has not been loaded yet).
 *
 * This fallback is the FORK's own — Cursor's binary takes the limit from the
 * server (`promptTokenBreakdown` / `contextTokenLimit` on composer data,
 * GAPS-167 Step 0) and has no client-side fallback. The value preserves the
 * pre-GAPS-183 denominator so unresolvable cases behave exactly as before.
 */
export const FALLBACK_CONTEXT_WINDOW_TOKENS = 200_000;

/** Estimate tokens from a char count (chars/4 heuristic — an ESTIMATE). */
export function estimateTokensFromChars(chars: number): number {
  if (!Number.isFinite(chars) || chars <= 0) {
    return 0;
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * Measured inputs for one breakdown computation. Each char count must be the
 * length of REAL text the host observes flowing into the agent request —
 * except the two engine-owned categories, which the caller passes as 0 with
 * an UNKNOWN comment (see ComposerDataService.computeContextUsage).
 */
export interface ContextUsageInput {
  /** UNKNOWN on host: the engine (sidecar) assembles the system prompt server-side. */
  systemPromptChars: number;
  /** UNKNOWN on host: built-in tool definitions live in the engine. */
  toolDefChars: number;
  /** Real injected <rule>…</rule> entry text (always-inject rules). */
  rulesTextChars: number;
  /** Real skill name+description list injected into the request context. */
  skillsTextChars: number;
  /** Real MCP tool catalog text (namespaced names + descriptions + schemas). */
  mcpTextChars: number;
  /** Real subagent instruction text sent when the agent launches subagents. */
  subagentDocChars: number;
  /** Adopted background-summary text (0 when no summary has been adopted). */
  summarizedChars: number;
  /** Transcript estimate from the SSE-observed transcript (chars/4). */
  conversationTokens: number;
  /** Context window size used as the "how full" denominator. */
  contextWindowTokens: number;
}

/** One category row pushed to the webview as {type:'ctxUsage', sources:[{name,tokens,pct}]}. */
export interface ContextUsageSource {
  /** One of the 8 canonical category names. */
  name: string;
  /** Estimated tokens (chars/4 heuristic) — an estimate, not engine accounting. */
  tokens: number;
  /** Share of totalTokens, integer percent; the 8 rows sum to exactly 100 when totalTokens > 0. */
  pct: number;
}

export interface ContextUsageBreakdown {
  /** Exactly 8 sources in canonical docs order. */
  sources: ContextUsageSource[];
  /** Sum of category estimates. */
  totalTokens: number;
  /** Window used for the "how full the ring is" figure. */
  contextWindowTokens: number;
  /** Rounded percent of the window in use (drives the tray button label). */
  windowPct: number;
}

/**
 * Build the 8-category breakdown. pct uses the largest-remainder method so
 * the rows sum to exactly 100 (never 99/101 from naive rounding).
 */
export function computeContextUsageBreakdown(input: ContextUsageInput): ContextUsageBreakdown {
  const cat = CONTEXT_RING_CATEGORIES;
  const tokens: number[] = [
    estimateTokensFromChars(input.systemPromptChars),
    estimateTokensFromChars(input.toolDefChars),
    estimateTokensFromChars(input.rulesTextChars),
    estimateTokensFromChars(input.skillsTextChars),
    estimateTokensFromChars(input.mcpTextChars),
    estimateTokensFromChars(input.subagentDocChars),
    estimateTokensFromChars(input.summarizedChars),
    input.conversationTokens > 0 ? Math.round(input.conversationTokens) : 0,
  ];
  const totalTokens = tokens.reduce((a, b) => a + b, 0);
  const pcts = sharePercentages(tokens);
  const sources: ContextUsageSource[] = cat.map((name, i) => ({
    name,
    tokens: tokens[i]!,
    pct: pcts[i]!,
  }));
  const window = input.contextWindowTokens > 0 ? Math.round(input.contextWindowTokens) : 0;
  return {
    sources,
    totalTokens,
    contextWindowTokens: window,
    windowPct: window > 0 ? Math.min(100, Math.round((totalTokens / window) * 100)) : 0,
  };
}

/** Integer shares of a total that sum to exactly 100 (largest remainder). */
export function sharePercentages(values: number[]): number[] {
  const total = values.reduce((a, b) => a + b, 0);
  const out = values.map(() => 0);
  if (total <= 0) {
    return out;
  }
  const exact = values.map((v) => (v / total) * 100);
  const floors = exact.map((e) => Math.floor(e));
  let remainder = 100 - floors.reduce((a, b) => a + b, 0);
  const order = exact
    .map((e, i) => ({ frac: e - Math.floor(e), i }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (remainder <= 0) {
      break;
    }
    floors[i]! += 1;
    remainder -= 1;
  }
  for (let i = 0; i < out.length; i++) {
    out[i] = floors[i]!;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Text-measurement helpers: each mirrors the REAL text injected into the
// agent request, so the caller passes honest char counts.
// ---------------------------------------------------------------------------

/** Minimal rule shape needed to mirror the injected <rule> entry. */
export interface RuleEntryText {
  filename: string;
  kind: string;
  body: string;
}

/**
 * Mirror of projectRules.formatRuleEntry (the real injected text):
 * `<rule name="…" type="…">\n<body>\n</rule>`.
 */
export function ruleEntryChars(rule: RuleEntryText): number {
  return `<rule name="${rule.filename}" type="${rule.kind}">\n${rule.body.trim()}\n</rule>`.length;
}

/** One skill in the agent request context (name + description). */
export interface SkillEntryText {
  name: string;
  description: string;
}

/** The request-context skill list is exactly name+description per skill. */
export function skillsListChars(skills: SkillEntryText[]): number {
  return skills.reduce((a, s) => a + s.name.length + 1 + s.description.length, 0);
}

/** One MCP tool in the connected-servers catalog. */
export interface McpCatalogEntry {
  namespacedName: string;
  description: string;
  /** JSON text of the tool's input schema (as sent to the model). */
  inputSchemaJson: string;
}

/** Catalog text the model sees per tool: name + description + schema. */
export function mcpCatalogChars(tools: McpCatalogEntry[]): number {
  return tools.reduce(
    (a, t) => a + t.namespacedName.length + 1 + t.description.length + 1 + t.inputSchemaJson.length,
    0,
  );
}
