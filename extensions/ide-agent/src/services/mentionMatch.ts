/**
 * Pure @-mention matching logic — no vscode dependency, unit-testable.
 *
 * Spec: ~/workspace/ide-code-mission/docs/rea/parity-at-mentions.md §1.2–1.4
 * (Cursor's mentionSuggestionChar, HRn normalization, IMo fuzzy, QCe
 * multi-token matching, L4e = 25 item cap, 120-char query cap).
 */

/** Cursor's canonical mention types (Tmp) plus our `git` extension for the
 * docs-observed working-diff item (Cursor's client type was "(commit)"). */
export type MentionKind =
  | "file"
  | "code"
  | "chat"
  | "folder"
  | "doc"
  | "cursorRule"
  | "browser"
  | "terminal"
  | "branch"
  | "mcp"
  | "canvas"
  | "clipboard"
  | "git"
  /** Local codebase index (Instant Grep + symbols). */
  | "codebase"
  /** Browser-tab screenshot attached as an image chip (host-side only). */
  | "image"
  /** Pasted URL auto-parsed into a link chip (GAPS-131: Cursor's
   * `Zr.link` mention type, born from the paste handler at desk
   * @24723930 of Cursor 3.25.9 — see mentionLinkToolbar.ts). */
  | "link";

/** Payload cases (Emp in Cursor's bundle). */
export type MentionPayload =
  | { case: "fileSelection"; uri: string }
  | { case: "folderSelection"; uri: string }
  | { case: "docSelection"; docId: string; name: string; url?: string }
  | { case: "cursorRule"; name: string; content: string }
  | { case: "terminalFile"; terminalName: string }
  | {
      case: "codeSelection";
      uri: string;
      startLine: number;
      endLine: number;
      filePath: string;
      fileName: string;
    }
  | { case: "browserConnection" }
  | { case: "gitPRDiffSelection" }
  | { case: "chatSelection" }
  | { case: "pastChatSelection"; agentId: string; name: string }
  | { case: "branch"; content: string }
  | { case: "workingDiff"; content: string }
  | { case: "mcpSelection"; serverId: string; status: string }
  | { case: "canvasSelection" }
  | { case: "clipboardSelection"; text: string }
  /** Editor selection attached via the host's addSelectionContext. */
  | { case: "selectionContext"; label: string; content: string }
  /** @Codebase: local index search for a query; resolved at submit time. */
  | { case: "codebaseSelection"; query: string }
  /** Browser-tab screenshot: PNG saved on disk, sent as an engine file attachment. */
  | { case: "imageContext"; label: string; filePath: string; dataUrl: string }
  /** Pasted-URL link chip (GAPS-131): Cursor's `insertLink({url, uuid})`
   * selection (desk @24723930); the URL itself is the attached context. */
  | { case: "linkSelection"; url: string };

/** One row in the mention menu; serializable across the webview boundary. */
export interface MentionItem {
  /** Stable identity, e.g. `file:<uri>`, `terminal:<name>`, `branch:read-branch`. */
  id: string;
  /** Display label. */
  label: string;
  /** Model-visible text when attached (Cursor's rawText). */
  rawText: string;
  plainText?: string;
  mentionType: MentionKind;
  /** Right-aligned sublabel, e.g. "L12-34", "terminal", "branch read-branch". */
  secondaryText?: string;
  /** Under-label description. */
  description?: string;
  payload: MentionPayload;
  /** Extra strings matched against (aliases, paths). */
  searchAliases?: string[];
}

/** A MentionItem the user attached to the composer input. */
export interface MentionChip extends MentionItem {
  uuid: string;
}

/** Per-source item cap (Cursor's L4e = 25). */
export const MENTION_ITEM_CAP = 25;
/** Suggestion query length cap (Cursor's 120). */
export const MENTION_QUERY_CAP = 120;

/** Normalize a raw `@` query: trim → strip leading `@` → lowercase → cap. */
export function normalizeMentionQuery(raw: string): string {
  let q = raw.trim();
  if (q.startsWith("@")) {
    q = q.slice(1);
  }
  return q.toLowerCase().slice(0, MENTION_QUERY_CAP);
}

/**
 * Subsequence fuzzy match (Cursor's IMo on the first field): every char of
 * the needle must appear in order in the haystack.
 */
export function fuzzyMatch(needle: string, haystack: string): boolean {
  const n = needle.toLowerCase();
  const h = haystack.toLowerCase();
  let j = 0;
  for (let i = 0; i < n.length; i++) {
    const c = n[i];
    while (j < h.length && h[j] !== c) {
      j++;
    }
    // Needle char not found in the remaining haystack — no match.
    if (j >= h.length) {
      return false;
    }
    j++;
  }
  return true;
}

/**
 * Multi-token matching (Cursor's cus/QCe): every query token must match;
 * the first match field is fuzzy, remaining fields are substring.
 */
export function matchesMentionQuery(item: MentionItem, query: string): boolean {
  const tokens = query.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return true;
  }
  const fuzzyFields = [item.label, item.rawText];
  const subFields = [
    item.label,
    item.rawText,
    item.description ?? "",
    item.secondaryText ?? "",
    ...(item.searchAliases ?? []),
  ].map((s) => s.toLowerCase());
  return tokens.every((token) => {
    const t = token.toLowerCase();
    if (fuzzyFields.some((f) => fuzzyMatch(t, f))) {
      return true;
    }
    return subFields.some((f) => f.includes(t));
  });
}

/** Scoped query words (Cursor's getMentionItems switch, §1.4). */
const SCOPES: Record<string, MentionKind[]> = {
  files: ["file", "folder"],
  file: ["file", "folder"],
  folders: ["file", "folder"],
  folder: ["file", "folder"],
  files_and_folders: ["file", "folder"],
  terminals: ["terminal"],
  terminal: ["terminal"],
  term: ["terminal"],
  past_chats: ["chat"],
  pastchats: ["chat"],
  chats: ["chat"],
  chat: ["chat"],
  canvases: ["canvas"],
  canvas: ["canvas"],
  branch: ["branch", "git"],
  branch_diff: ["branch", "git"],
  branchdiff: ["branch", "git"],
  branch_diff_main: ["branch", "git"],
  diff: ["branch", "git"],
  browser: ["browser"],
  web: ["browser"],
  docs: ["doc"],
  doc: ["doc"],
  rules: ["cursorRule"],
  rule: ["cursorRule"],
  clipboard: ["clipboard"],
  clip: ["clipboard"],
  symbols: ["code"],
  symbol: ["code"],
  code: ["code"],
  codebase: ["codebase"],
  mcp: ["mcp"],
};

/** Split a normalized query into an optional scope and the remaining query. */
export function parseMentionScope(normalized: string): {
  kinds: MentionKind[] | null;
  query: string;
} {
  const firstSpace = normalized.indexOf(" ");
  const head = firstSpace === -1 ? normalized : normalized.slice(0, firstSpace);
  const kinds = SCOPES[head];
  if (kinds) {
    return {
      kinds,
      query: firstSpace === -1 ? "" : normalized.slice(firstSpace + 1).trim(),
    };
  }
  return { kinds: null, query: normalized };
}

const KNOWN_KINDS: ReadonlySet<string> = new Set([
  "file",
  "code",
  "chat",
  "folder",
  "doc",
  "cursorRule",
  "browser",
  "terminal",
  "branch",
  "mcp",
  "canvas",
  "clipboard",
  "git",
  "image",
  "codebase",
  "link",
]);

/** The webview is untrusted: validate a chip before resolving context. */
export function isMentionChip(value: unknown): value is MentionChip {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.label === "string" &&
    typeof v.rawText === "string" &&
    typeof v.uuid === "string" &&
    typeof v.mentionType === "string" &&
    KNOWN_KINDS.has(v.mentionType) &&
    typeof v.payload === "object" &&
    v.payload !== null &&
    typeof (v.payload as Record<string, unknown>).case === "string"
  );
}
