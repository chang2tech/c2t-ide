/**
 * slashRegistry — pure (vscode-free) helpers for the slash-command system.
 *
 * Spec: ~/workspace/ide-code-mission/docs/rea/parity-slash-commands.md
 *
 * Kept dependency-free so it can be unit-tested with bun/node without the
 * vscode API. The webview duplicates the fuzzy scorer in plain JS (see
 * components/composer.ts) — keep the two implementations behaviorally equal.
 */

export type SlashItemType = "builtin" | "command" | "skill";
export type SlashItemSource = "builtin" | "workspace" | "personal" | "skill";

export interface SlashItem {
  name: string;
  description: string;
  argumentHint?: string;
  source: SlashItemSource;
  type: SlashItemType;
  keywords?: string[];
  aliases?: string[];
  /** True for skills with disable-model-invocation: menu-only, never auto-pulled. */
  menuOnly?: boolean;
  /** Global MRU rank (0 = most recent). Undefined = never used. */
  mruRank?: number;
}

/** Subsequence check: every char of needle appears in hay in order. */
export function isSubsequence(hay: string, needle: string): boolean {
  let j = 0;
  for (let i = 0; i < hay.length && j < needle.length; i++) {
    if (hay[i] === needle[j]) {
      j++;
    }
  }
  return j === needle.length;
}

/**
 * Fuzzy score for palette filtering (spec §4.2: match over name, aliases,
 * keywords, description). 0 = no match. Higher = better.
 */
export function fuzzyScore(
  query: string,
  item: Pick<SlashItem, "name" | "description" | "keywords" | "aliases">,
): number {
  const q = query.trim().toLowerCase();
  if (!q) {
    return 1;
  }
  const name = item.name.toLowerCase();
  if (name === q) {
    return 100;
  }
  if (name.startsWith(q)) {
    return 80;
  }
  if (isSubsequence(name, q)) {
    return 60;
  }
  const words: string[] = [...(item.aliases ?? []), ...(item.keywords ?? [])];
  for (const w of words) {
    const lw = w.toLowerCase();
    if (lw.startsWith(q)) {
      return 40;
    }
  }
  for (const w of words) {
    if (isSubsequence(w.toLowerCase(), q)) {
      return 30;
    }
  }
  if (item.description.toLowerCase().includes(q)) {
    return 10;
  }
  return 0;
}

/**
 * Rank items for a query. Empty query → host order (already MRU-sorted).
 * Non-empty → fuzzy score desc, MRU rank asc as tiebreak, name asc as final.
 */
export function rankItems<T extends SlashItem>(query: string, items: T[]): T[] {
  const q = query.trim();
  if (!q) {
    return [...items];
  }
  const scored = items
    .map((item) => ({ item, score: fuzzyScore(q, item) }))
    .filter((s) => s.score > 0);
  scored.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    const ra = a.item.mruRank ?? Number.MAX_SAFE_INTEGER;
    const rb = b.item.mruRank ?? Number.MAX_SAFE_INTEGER;
    if (ra !== rb) {
      return ra - rb;
    }
    return a.item.name.localeCompare(b.item.name);
  });
  return scored.map((s) => s.item);
}

/**
 * Case-insensitive dedup, first list wins (spec §2.2/§3 load order).
 */
export function dedupeByName<T extends { name: string }>(lists: T[][]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const list of lists) {
    for (const item of list) {
      const key = item.name.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

/** Longest-prefix command match for paste handling (spec §4.1). */
export function matchPastedCommand<T extends { name: string }>(token: string, items: T[]): T | undefined {
  const lower = token.toLowerCase();
  let best: T | undefined;
  for (const item of items) {
    const name = item.name.toLowerCase();
    if (lower === name || (lower.startsWith(name) && /\s/.test(lower[name.length] ?? ""))) {
      if (!best || name.length > best.name.length) {
        best = item;
      }
    }
  }
  return best;
}

export interface SlashMru {
  /** Per-type MRU lists, most-recent first, capped at 5 (spec §3). */
  byType: Record<string, string[]>;
  /** Global cross-type order, most-recent first, capped at 15 (spec §3). */
  global: string[];
}

export const MRU_TYPE_CAP = 5;
export const MRU_GLOBAL_CAP = 15;

export function emptyMru(): SlashMru {
  return { byType: {}, global: [] };
}

/** Record a use; returns a NEW mru object (immutable update). */
export function recordMru(mru: SlashMru, type: string, name: string): SlashMru {
  const key = `${type}:${name.toLowerCase()}`;
  const byType: Record<string, string[]> = {};
  for (const [t, list] of Object.entries(mru.byType)) {
    byType[t] = list.filter((k) => k !== key);
  }
  const list = byType[type] ?? [];
  list.unshift(key);
  byType[type] = list.slice(0, MRU_TYPE_CAP);
  const global = [key, ...mru.global.filter((k) => k !== key)].slice(0, MRU_GLOBAL_CAP);
  return { byType, global };
}

/** Global MRU rank for an item (0 = most recent), or undefined. */
export function mruRankOf(mru: SlashMru, type: string, name: string): number | undefined {
  const key = `${type}:${name.toLowerCase()}`;
  const idx = mru.global.indexOf(key);
  return idx === -1 ? undefined : idx;
}

export interface SkillFrontmatter {
  name?: string;
  description?: string;
  disableModelInvocation?: boolean;
  /**
   * GAPS-46D (agent-custom-modes): optional `icon` / `color` fields style the
   * custom mode's badge (docs.cursor.com/agent/prompting: "the optional
   * `icon` and `color` frontmatter fields style the mode's badge"; binary
   * 3.25.9: `Ncs({icon:"icon"in t?t.icon:void 0,colorId:"color"in t?t.color:void 0})`).
   */
  icon?: string;
  color?: string;
}

/** Parse SKILL.md frontmatter (name/description/disable-model-invocation/icon/color). */
export function parseSkillFrontmatter(raw: string): SkillFrontmatter {
  const out: SkillFrontmatter = {};
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) {
    return out;
  }
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.*?)\s*$/);
    if (!kv) {
      continue;
    }
    const k = kv[1].toLowerCase();
    const v = kv[2].replace(/^["']|["']$/g, "");
    if (k === "name") {
      out.name = v;
    } else if (k === "description") {
      out.description = v;
    } else if (k === "disable-model-invocation" || k === "disable_model_invocation") {
      out.disableModelInvocation = /^(true|1|yes)$/i.test(v);
    } else if (k === "icon") {
      out.icon = v;
    } else if (k === "color") {
      out.color = v;
    }
  }
  return out;
}
