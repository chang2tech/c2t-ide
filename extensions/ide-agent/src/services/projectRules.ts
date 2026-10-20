/**
 * Project Rules (.mdc) — pure parsing, classification, and matching logic.
 *
 * Cursor parity spec: docs/rea/parity-rules-mcp.md §A.
 * This module has NO vscode dependency so it can be unit-tested with plain node.
 *
 * Format (custom line-based frontmatter parser — NOT YAML):
 *   ---
 *   description: FastAPI routers, dependencies and Pydantic v2 schemas
 *   globs: src/app/**\/router.py,src/app/**\/schemas.py
 *   alwaysApply: false
 *   attachToBackgroundAgents: true
 *   metadata:
 *     environments: desktop
 *     disabledEnvironments: cloud
 *   ---
 *   - One APIRouter per feature...
 */

export type RuleKind = "always" | "autoAttached" | "agentRequested" | "manual";

export interface ParsedRule {
  /** File name, e.g. "fastapi.mdc". */
  filename: string;
  /** Absolute fs path of the .mdc file. */
  fullPath: string;
  /** Workspace root this rule was discovered under (fs path). */
  workspaceRoot: string;
  /** Path from workspace root to the .cursor/rules dir holding this rule ("" for root-level). */
  subdirPath: string;
  /** Path of the rule file inside its .cursor/rules dir. */
  internalPath: string;
  description: string;
  globs: string[];
  alwaysApply: boolean;
  attachToBackgroundAgents: boolean;
  environments: string[];
  disabledEnvironments: string[];
  /** Markdown body after the frontmatter block. */
  body: string;
  kind: RuleKind;
  warnings: string[];
  parseError?: string;
}

/** This host's environment name for metadata gating. Cursor's known value is "cloud". */
export const CURRENT_ENVIRONMENT = "desktop";

/** Parse a single .mdc file's content. Never throws — problems go to parseError/warnings. */
export function parseMdcFile(
  filename: string,
  fullPath: string,
  workspaceRoot: string,
  subdirPath: string,
  internalPath: string,
  content: string,
): ParsedRule {
  const rule: ParsedRule = {
    filename,
    fullPath,
    workspaceRoot,
    subdirPath,
    internalPath,
    description: "",
    globs: [],
    alwaysApply: false,
    attachToBackgroundAgents: false,
    environments: [],
    disabledEnvironments: [],
    body: content,
    kind: "manual",
    warnings: [],
  };

  try {
    const { frontmatterLines, body } = splitFrontmatter(content);
    rule.body = body;
    if (frontmatterLines === null) {
      // No frontmatter: rule with defaults (manual kind, no globs).
      rule.kind = classifyRule(rule);
      return rule;
    }
    parseFrontmatterLines(frontmatterLines, rule);
    rule.kind = classifyRule(rule);
  } catch (err) {
    rule.parseError = err instanceof Error ? err.message : String(err);
    rule.kind = classifyRule(rule);
  }
  return rule;
}

interface FrontmatterSplit {
  /** null when the file has no frontmatter block. */
  frontmatterLines: string[] | null;
  body: string;
}

function splitFrontmatter(content: string): FrontmatterSplit {
  const lines = content.split(/\r?\n/);
  // The opening fence must be the first non-empty line (Cursor is lenient here).
  let start = 0;
  while (start < lines.length && lines[start].trim() === "") {
    start++;
  }
  if (start >= lines.length || lines[start].trim() !== "---") {
    return { frontmatterLines: null, body: content };
  }
  let end = start + 1;
  while (end < lines.length && lines[end].trim() !== "---") {
    end++;
  }
  if (end >= lines.length) {
    // Unterminated frontmatter: treat the whole file as body with a warning.
    return { frontmatterLines: [], body: content };
  }
  return {
    frontmatterLines: lines.slice(start + 1, end),
    body: lines.slice(end + 1).join("\n"),
  };
}

/**
 * Line-based parser (NOT YAML): skip # comments and empties, split on the
 * FIRST colon. `metadata:` opens a section — subsequent indented lines belong
 * to it until a non-indented `key: value` line. Unknown keys are ignored.
 */
function parseFrontmatterLines(lines: string[], rule: ParsedRule): void {
  let inMetadata = false;
  for (const raw of lines) {
    const line = raw.replace(/\t/g, "  ");
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }
    const indented = /^\s/.test(line);
    if (!indented) {
      inMetadata = false;
    }
    const colon = line.indexOf(":");
    if (colon < 0) {
      rule.warnings.push(`ignored frontmatter line without colon: ${trimmed.slice(0, 60)}`);
      continue;
    }
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (inMetadata) {
      parseMetadataKey(key, value, rule);
      continue;
    }
    switch (key) {
      case "description":
        rule.description = stripQuotes(value);
        break;
      case "globs":
        rule.globs = splitList(value);
        break;
      case "alwaysApply":
        rule.alwaysApply = value.toLowerCase() === "true";
        break;
      case "attachToBackgroundAgents":
        rule.attachToBackgroundAgents = value.toLowerCase() === "true";
        break;
      case "metadata":
        // Section opener; the value (if any) is ignored.
        inMetadata = true;
        break;
      default:
        // Unknown keys are ignored (Cursor parity).
        break;
    }
  }
}

function parseMetadataKey(key: string, value: string, rule: ParsedRule): void {
  switch (key) {
    case "environments":
      rule.environments = splitList(value);
      break;
    case "disabledEnvironments":
      rule.disabledEnvironments = splitList(value);
      break;
    default:
      break;
  }
}

function stripQuotes(s: string): string {
  if (s.length >= 2 && ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === "'" && s[s.length - 1] === "'"))) {
    return s.slice(1, -1);
  }
  return s;
}

/** Comma-separated list; also accepts bracket syntax `[a, b]`. */
function splitList(value: string): string[] {
  let v = value.trim();
  if (v.startsWith("[") && v.endsWith("]")) {
    v = v.slice(1, -1);
  }
  return v
    .split(",")
    .map((s) => stripQuotes(s.trim()))
    .filter((s) => s.length > 0);
}

/**
 * Cursor's four rule types (parity spec §A2):
 * - always: alwaysApply: true → injected into every agent request.
 * - autoAttached: globs set → attaches when the agent reads/edits a matching file.
 * - agentRequested: description but no globs and alwaysApply false → the agent
 *   sees the description and fetches the body on demand.
 * - manual: none of the above → attached only via explicit @-mention.
 */
export function classifyRule(rule: Pick<ParsedRule, "alwaysApply" | "globs" | "description">): RuleKind {
  if (rule.alwaysApply) {
    return "always";
  }
  if (rule.globs.length > 0) {
    return "autoAttached";
  }
  if (rule.description.length > 0) {
    return "agentRequested";
  }
  return "manual";
}

/** Environments gating (parity spec §A5): disabled wins; empty whitelist = all. */
export function ruleAppliesToEnv(rule: ParsedRule, env: string = CURRENT_ENVIRONMENT): boolean {
  if (rule.disabledEnvironments.includes(env)) {
    return false;
  }
  if (rule.environments.length === 0) {
    return true;
  }
  return rule.environments.includes(env);
}

// ---------------------------------------------------------------------------
// Glob matching (self-contained; no minimatch dependency in this extension).
// Supports **, *, ?, {a,b} alternation, and [...] character classes.
// Globs match against workspace-relative paths with "/" separators.
// ---------------------------------------------------------------------------

export function normalizeRelPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

function globToRegExpSource(glob: string): string {
  let g = normalizeRelPath(glob.trim());
  // A trailing "/" means "everything under this dir".
  if (g.endsWith("/")) {
    g += "**";
  }
  let out = "";
  let i = 0;
  const n = g.length;
  const escapeChar = (c: string): string =>
    "^$.|+()".includes(c) ? "\\" + c : c;
  while (i < n) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        // "**"
        if (g[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 3;
        } else {
          out += ".*";
          i += 2;
        }
      } else {
        out += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      out += "[^/]";
      i += 1;
    } else if (c === "{") {
      // {a,b,c} alternation (no nesting).
      let j = i + 1;
      let depth = 1;
      while (j < n && depth > 0) {
        if (g[j] === "{") {
          depth++;
        } else if (g[j] === "}") {
          depth--;
        }
        j++;
      }
      const inner = g.slice(i + 1, j - 1);
      const alts = inner.split(",").map((a) => globToRegExpSource(a));
      out += "(?:" + alts.join("|") + ")";
      i = j;
    } else if (c === "[") {
      // Character class: pass through to the closing bracket.
      let j = i + 1;
      if (g[j] === "^" || g[j] === "!") {
        j++;
      }
      if (g[j] === "]") {
        j++;
      }
      while (j < n && g[j] !== "]") {
        j++;
      }
      let cls = g.slice(i, Math.min(j + 1, n));
      if (cls[1] === "!") {
        cls = "[^" + cls.slice(2);
      }
      out += cls;
      i = Math.min(j + 1, n);
    } else {
      out += escapeChar(c);
      i += 1;
    }
  }
  return out;
}

/** True when the workspace-relative path matches the glob. */
export function matchGlob(glob: string, relPath: string): boolean {
  const pattern = normalizeRelPath(glob);
  const target = normalizeRelPath(relPath);
  if (!pattern) {
    return false;
  }
  try {
    const re = new RegExp("^(?:" + globToRegExpSource(pattern) + ")$");
    return re.test(target);
  } catch {
    return false;
  }
}

/** True when the path matches ANY of the rule's globs. */
export function ruleMatchesFile(rule: ParsedRule, relPath: string): boolean {
  return rule.globs.some((g) => matchGlob(g, relPath));
}

/** Filter rules to those whose globs match at least one of the given files. */
export function getRulesForFiles(rules: ParsedRule[], relPaths: string[]): ParsedRule[] {
  const paths = relPaths.map(normalizeRelPath);
  return rules.filter((r) => r.kind === "autoAttached" && paths.some((p) => ruleMatchesFile(r, p)));
}

// ---------------------------------------------------------------------------
// Injection — Cursor's writeRulesEntry() equivalent.
// Called on every agent-chat submit (onBeforeSubmitChat). NOT used for Cmd+K
// or Tab (parity spec §A6) — those paths never call this module.
// ---------------------------------------------------------------------------

export interface RulesInjectionContext {
  /** Workspace-relative paths of files in the current context (active editor, etc.). */
  contextFiles: string[];
  /** Raw user prompt — scanned for @-mentions of manual rules. */
  prompt: string;
  /** Chat mode of the turn (e.g. "background") — gates attachToBackgroundAgents. */
  mode?: string;
  env?: string;
}

export interface AttachedRule {
  filename: string;
  kind: RuleKind;
  /** For autoAttached: the context file(s) that triggered the attach. */
  matchedFiles?: string[];
}

export interface RulesBlock {
  /** The text to inject into the agent request ("" when nothing applies). */
  text: string;
  attached: AttachedRule[];
}

/** Find @-mentions of a rule: @filename, @filename.mdc, or @"multi word" — case-insensitive. */
function findRuleMention(prompt: string, rule: ParsedRule): boolean {
  const stem = rule.filename.replace(/\.mdc$/i, "");
  const candidates = [rule.filename.toLowerCase(), stem.toLowerCase()];
  const tokens = prompt.toLowerCase().match(/@([\w][\w.\-]*)/g) ?? [];
  for (const tok of tokens) {
    const name = tok.slice(1); // strip "@"
    if (candidates.includes(name)) {
      return true;
    }
  }
  return false;
}

/** Exported so the context-ring measures the exact injected text (honest char count). */
export function formatRuleEntry(rule: ParsedRule, matchedFiles?: string[]): string {
  const header =
    matchedFiles && matchedFiles.length > 0
      ? `<rule name="${rule.filename}" type="${rule.kind}" matched="${matchedFiles.join(",")}">`
      : `<rule name="${rule.filename}" type="${rule.kind}">`;
  return `${header}\n${rule.body.trim()}\n</rule>`;
}

/**
 * Build the rules block for one agent-chat submit.
 * Merge order mirrors Cursor's dedupeRules: a rule attaches at most once,
 * preferring the richest attachment (full body over description listing).
 */
export function buildRulesBlock(rules: ParsedRule[], ctx: RulesInjectionContext): RulesBlock {
  const env = ctx.env ?? CURRENT_ENVIRONMENT;
  const eligible = rules.filter((r) => ruleAppliesToEnv(r, env) && !r.parseError);
  const contextFiles = ctx.contextFiles.map(normalizeRelPath);

  const attached: AttachedRule[] = [];
  const entries: string[] = [];
  const listed: string[] = [];
  const seen = new Set<string>(); // fullPath dedup

  const attach = (rule: ParsedRule, matchedFiles?: string[]): void => {
    if (seen.has(rule.fullPath)) {
      return;
    }
    seen.add(rule.fullPath);
    attached.push({ filename: rule.filename, kind: rule.kind, matchedFiles });
    entries.push(formatRuleEntry(rule, matchedFiles));
  };

  // 1. Always rules: full body, every request.
  for (const rule of eligible) {
    if (rule.kind === "always") {
      attach(rule);
    }
  }

  // 2. Auto-attached: full body when a context file matches the globs.
  for (const rule of eligible) {
    if (rule.kind !== "autoAttached") {
      continue;
    }
    const matched = contextFiles.filter((f) => ruleMatchesFile(rule, f));
    if (matched.length > 0) {
      attach(rule, matched);
    }
  }

  // 3. Manual rules: full body only when explicitly @-mentioned in the prompt.
  // Agent-requested rules are ALSO @-mentionable: this is the on-demand
  // fetch path — the user (or a follow-up turn) can pull the full body
  // after seeing the rule listed in <available-rules>.
  for (const rule of eligible) {
    if (rule.kind !== "manual" && rule.kind !== "agentRequested") {
      continue;
    }
    if (findRuleMention(ctx.prompt, rule)) {
      attach(rule);
    }
  }

  // 3b. Background agents: rules flagged attachToBackgroundAgents are
  // attached with full body when the turn runs in background mode,
  // regardless of their normal kind (Cursor parity — the flag means the
  // rule also applies to background agents).
  if (ctx.mode === "background") {
    for (const rule of eligible) {
      if (rule.attachToBackgroundAgents) {
        attach(rule);
      }
    }
  }

  // 4. Agent-requested: list name + description so the agent can fetch the body.
  // (Cursor's agentFetched case — the agent decides relevance from the description.)
  for (const rule of eligible) {
    if (rule.kind !== "agentRequested" || seen.has(rule.fullPath)) {
      continue;
    }
    seen.add(rule.fullPath);
    attached.push({ filename: rule.filename, kind: rule.kind });
    listed.push(`- ${rule.filename}: ${rule.description}`);
  }

  const parts: string[] = [];
  if (entries.length > 0) {
    parts.push(
      "<project-rules>\n" +
        "The following project rules apply to this request. Follow them.\n" +
        entries.join("\n") +
        "\n</project-rules>",
    );
  }
  if (listed.length > 0) {
    parts.push(
      "<available-rules>\n" +
        "Additional project rules are available on request. If one is relevant, " +
        "ask for its full text by name.\n" +
        listed.join("\n") +
        "\n</available-rules>",
    );
  }
  return { text: parts.join("\n"), attached };
}
