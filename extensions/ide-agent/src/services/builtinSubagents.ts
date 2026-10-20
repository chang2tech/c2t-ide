/**
 * Built-in subagents — Cursor `subagent-builtin` parity (P2).
 *
 * Spec (verbatim, docs/rea/deep-docs-all.md §"Subagents — new details",
 * sourced from cursor.com/docs Subagents, read directly, HIGH confidence):
 *   - "Built-in: explore (codebase search), browser (browser automation via MCP)"
 *   - "Invoke: `/name` syntax or natural mention"
 *   - A user-configured agent with the same name overrides the builtin
 *     (engine rule, packages/core/src/tool/plugin/subagent.ts: "A
 *     user-configured agent named \"explore\" overrides the builtin").
 *
 * The engine (sidecar) resolves the agent id server-side through its
 * subagent tool — the extension's job is the client surface Cursor shows:
 * the builtins are listed in Customize → Subagents (marked Built-in,
 * non-deletable, no backing file) and invocable via `/explore` / `/browser`
 * slash commands. Execution follows the extension's prompt-macro semantics
 * (slashCommandService §5): the macro inserts a `<subagent name="…">`
 * reference into the prompt; the model then dispatches the engine's
 * subagent tool with that agent id — the same two-step `/name` invoke
 * Cursor's docs describe.
 *
 * HONEST-DIVERGENCE: the engine ships a real builtin `explore`
 * (packages/core/src/indexing/explore.ts, EXPLORE_AGENT_ID = "explore") so
 * `/explore` resolves out of the box. The engine has no `browser` agent
 * yet — `/browser` and the listing follow Cursor's client contract and
 * resolve once a browser-capable agent is configured (Cursor's builtin is
 * "browser automation via MCP"; a browser MCP server provides the tools).
 * The macro never pretends the agent exists locally.
 */

/** One Cursor built-in subagent. */
export interface BuiltinSubagentDef {
  /** Agent id, e.g. "explore" — also the `/name` invoke name. */
  name: string;
  /** Cursor-docs-faithful description. */
  description: string;
}

/**
 * The two Cursor built-in subagents (spec verbatim).
 * Order is stable: explore, browser.
 */
export const BUILTIN_SUBAGENTS: readonly BuiltinSubagentDef[] = [
  {
    name: "explore",
    description:
      "Built-in codebase-search subagent: explores the codebase read-only in its own context window and reports summarized findings.",
  },
  {
    name: "browser",
    description:
      "Built-in browser-automation subagent: drives the browser via MCP tools.",
  },
];

/** Case-insensitive lookup of a builtin by name. */
export function getBuiltinSubagent(name: string): BuiltinSubagentDef | undefined {
  const lower = name.trim().toLowerCase();
  return BUILTIN_SUBAGENTS.find((b) => b.name === lower);
}

/** True when `name` is one of Cursor's built-in subagent ids. */
export function isBuiltinSubagentName(name: string): boolean {
  return getBuiltinSubagent(name) !== undefined;
}

/**
 * Minimal shape of a file-discovered subagent (mirrors the Customize
 * view's CustomizeSubagent without importing vscode-land types).
 */
export interface DiscoveredSubagent {
  name: string;
  description: string;
  filePath: string;
  scope: "user" | "workspace";
}

/**
 * Merge Cursor's builtins with the file-discovered subagents for display
 * (Customize → Subagents). Builtins come first and are marked
 * `builtin: true`; a user-defined agent with the same name (case-insensitive)
 * overrides the builtin — matching the engine's own rule.
 */
export function mergeBuiltinSubagents(
  discovered: DiscoveredSubagent[],
): Array<DiscoveredSubagent & { builtin?: boolean }> {
  const overridden = new Set(
    discovered.map((d) => d.name.trim().toLowerCase()),
  );
  const out: Array<DiscoveredSubagent & { builtin?: boolean }> = [];
  for (const b of BUILTIN_SUBAGENTS) {
    if (!overridden.has(b.name)) {
      out.push({
        name: b.name,
        description: b.description,
        filePath: "",
        scope: "user",
        builtin: true,
      });
    }
  }
  out.push(...discovered);
  return out;
}

/**
 * Build the `/name` invoke prompt macro for a builtin subagent.
 * Same execution semantics as skills (slashCommandService §5): the caller
 * inserts the macro into the composer input; the model dispatches the
 * engine's subagent tool with the named agent id.
 *
 * `task` is the user's text after the slash command (may be empty — the
 * model then asks what to delegate, mirroring a bare `/name` mention).
 */
export function buildSubagentInvokeMacro(name: string, task: string): string {
  const def = getBuiltinSubagent(name);
  if (!def) {
    throw new Error(`not a built-in subagent: ${name}`);
  }
  const trimmed = task.trim();
  const taskBlock = trimmed ? `\n<task>${trimmed}</task>` : "";
  return (
    `<subagent name="${def.name}">\n` +
    `<invoke>Delegate the following to the built-in "${def.name}" subagent ` +
    `(${def.description}). Use the subagent tool with agent "${def.name}".</invoke>` +
    `${taskBlock}\n` +
    `</subagent>`
  );
}
