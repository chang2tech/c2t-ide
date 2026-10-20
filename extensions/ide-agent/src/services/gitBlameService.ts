/**
 * gitBlameService — REAL git blame backend for the Cursor Blame editors
 * (DEV-GAPS-76 / W76B, feature-matrix `cursor-blame-editor-view` R1).
 *
 * ARCHITECTURE — mirrors Cursor 3.25.9's layering (binary evidence below):
 * the workbench never spawns git itself. Cursor's workbench calls a
 * `gitContextService` facade (`getGitLineBlameWithAbsolutePath`,
 * `getGitFileLineBlameWithAbsolutePath`, `getGitRoot`,
 * `hasGitContextProvider`), which proxies to the extension-host
 * `cursor-retrieval` extension's `GitProvider`, which is what actually runs
 * git. In this fork the `ide-agent` extension is that provider layer: this
 * service runs git through the sanitized `gitExecFile` (DEV-GAPS-14
 * `ext-git-sanitize`) and the workbench `cursorBlame` contribution reaches
 * it through the `ide.cursorBlame.*` commands registered in `extension.ts`
 * — the fork's provider seam, standing in for Cursor's extHost proxy.
 *
 * BINARY EVIDENCE (Cursor 3.25.9, grepped 2026-10-20 by W76B):
 *
 *  - workbench `workbench.desktop.main.js` @16474491:
 *    `getGitLineBlameWithAbsolutePath(e,t,n)` converts the absolute path via
 *    `workspaceContextService.asRelativePath` and delegates to the provider's
 *    `getGitLineBlame(relPath, line, count)`; @16475113 the same facade for
 *    `getGitFileLineBlameWithAbsolutePath` → `getGitFileLineBlame(relPath,
 *    revision)`. `viewCommit`'s run body (@~31312k) reads
 *    `?.commits?.[0]` → `{commit, message, author, date}` and maps it to the
 *    blame editor input `{commitId: commit, subject: firstLine(message),
 *    message: "", author, timestamp: new Date(date).getTime(), repoRoot:
 *    await getGitRoot(dirname(fsPath))}`.
 *  - provider `extensions/cursor-retrieval/dist/main.js`:
 *    - `getGitLogForLine` @1821610 (registered as `getGitLineBlame`):
 *      argv `["--no-pager","log","-L","<line>,<line>:<relPath>",
 *      "--pretty=format:%H:_:%an:_:%ad:_:%s","--no-patch","-n","<count>"]`,
 *      each output line split on `":_:"` → `{commit, author, date,
 *      message}`. Reproduced VERBATIM in `getLineBlame` below.
 *    - `getGitFileLineBlame` @1824862 (registered as
 *      `getGitFileLineBlame`): argv `["blame","--root","--incremental"]`,
 *      plus `"-w"` iff `git.blame.ignoreWhitespace` is set, plus the
 *      revision when given, then `"--", <relPath>`; the output is parsed by
 *      `parseGitBlame` and shallow-boundary commits are flagged from
 *      `rev-parse --is-shallow-repository` + `.git/shallow`.
 *    - `parseGitBlame` @1826156: header regex `/^([0-9a-f]{40})/gm`; the
 *      header line's fields 3/4 (1-based: final-line, count) give
 *      `startLineNumber = Number(parts[2])`,
 *      `endLineNumber = start + Number(parts[3]) - 1`; per group it reads
 *      `author ` → authorName, `author-mail ` → authorEmail (angle brackets
 *      stripped), `author-time ` → `authorDate = 1000 * seconds`,
 *      `summary ` → subject; a group is flushed on its `filename ` line.
 *      Result is GROUPED BY HASH: `{hash, authorName, authorEmail,
 *      authorDate, subject, ranges: [{startLineNumber, endLineNumber}]}`.
 *      Reproduced VERBATIM in `parseGitBlameIncremental` below.
 *    - `getGitRoot` @1839604: `["rev-parse","--show-toplevel"]`, trimmed;
 *      a "not a git repository" failure resolves to `undefined` (the
 *      workbench then shows NLS k(5320) "No git repository found").
 *
 * TASK-SPECIFIED ADDITION (`git blame --porcelain`): the per-line pane data
 * is served from `git blame --porcelain` (`getFileBlame` +
 * `parseGitBlamePorcelain`), yielding one entry per line —
 * `{commit, author, authorTime, summary, lineNumber, ...}`. Porcelain and
 * `--incremental` carry the same underlying fields (porcelain is a
 * superset: it also has committer fields and the line content); the
 * incremental parser above is kept verbatim for Cursor parity, and the two
 * parsers are cross-checked against each other in the tests.
 *
 * AI ATTRIBUTION — HONEST NOTE: Cursor Blame's AI attribution (Tab vs
 * agent-by-model vs human, per-line conversation links; matrix entry
 * `cursor-blame-details`) is an Enterprise/server feature. The 3.25.9
 * binaries grepped for this wave show the COMMIT pane tracking
 * `cursor_blame.ai_details_opened` and grouping commit files under "Agent
 * conversations" / "Non-agent files", but NO per-line AI-attribution field
 * exists in the git provider's blame output (`parseGitBlame` recovers only
 * hash/author/email/date/subject/ranges). There is therefore NO evidence
 * for an AI field in per-line blame data, so this backend returns plain
 * git blame only and invents no attribution field.
 */

import * as path from "node:path";
import { readFile } from "node:fs/promises";
import { gitExecFile } from "./gitExec";

/** One blamed line, from `git blame --porcelain`. */
export interface IBlameLine {
  /** Full 40-char commit SHA (`CURSOR_BLAME_ZERO_HASH` when uncommitted). */
  commit: string;
  author: string;
  /** Raw `author-mail` value with the surrounding `<>` stripped. */
  authorMail: string;
  /** Author timestamp, SECONDS since epoch (verbatim porcelain value). */
  authorTime: number;
  authorTz: string;
  committer: string;
  committerMail: string;
  /** Committer timestamp, SECONDS since epoch. */
  committerTime: number;
  committerTz: string;
  summary: string;
  filename: string;
  /** Final (current-file) line number, 1-based. */
  lineNumber: number;
  /** Line number in the original commit, 1-based. */
  originalLineNumber: number;
  /** The line's text content (porcelain content line, tab stripped). */
  content: string;
  /** True when the group carried the porcelain `boundary` flag. */
  boundary: boolean;
}

/**
 * One commit group from `git blame --incremental` — the verbatim shape of
 * Cursor's `parseGitBlame` result (cursor-retrieval @1826156), plus the
 * caller's `isShallowBoundary` flag.
 */
export interface IBlameCommitGroup {
  hash: string;
  authorName: string | undefined;
  authorEmail: string | undefined;
  /** Author timestamp, MILLISECONDS since epoch (Cursor: `1e3 * seconds`). */
  authorDate: number | undefined;
  subject: string | undefined;
  ranges: Array<{ startLineNumber: number; endLineNumber: number }>;
  isShallowBoundary?: boolean;
}

/** One entry of Cursor's `getGitLogForLine` result (`getGitLineBlame`). */
export interface ILineBlameCommit {
  commit: string;
  author: string;
  /** Date string as printed by `%ad` (Cursor keeps it a string). */
  date: string;
  message: string;
}

/**
 * Porcelain header: `<sha> <orig-line> <final-line> [<group-count>]`.
 * The group-count field is present ONLY on the first line of a group;
 * continuation lines of the same group carry a 3-field header (and no
 * metadata / `filename` line) — verified against real `git blame
 * --porcelain` output (git 2.43, 2026-10-20, W76B-R): a 3-line single-
 * commit file emits `… 1 1 3` + metadata + filename + content, then
 * `… 2 2` + content and `… 3 3` + content. A 4-field-only regex silently
 * DROPS every continuation line, so the count group is optional here.
 */
const BLAME_HEADER_RE = /^([0-9a-f]{40}) (\d+) (\d+)(?: (\d+))?$/;

function stripMailBrackets(mail: string): string {
  return mail.startsWith("<") && mail.endsWith(">") ? mail.slice(1, -1) : mail;
}

/**
 * Parse `git blame --porcelain` output into one entry per line.
 *
 * Porcelain emits a header line per line, metadata key/value lines, a
 * `filename` line, then the content line prefixed with a TAB. Commit
 * metadata is printed in full only for the FIRST group of each commit;
 * later groups of the same commit carry just header + filename +
 * content, so metadata is cached by SHA (this is the documented porcelain
 * behavior — `--line-porcelain` would repeat it, plain `--porcelain`
 * does not). CONTINUATION lines inside one group are even terser: a
 * 3-field header (no group count) followed directly by the TAB content
 * line — no metadata, no `filename` (real git 2.43 output, verified
 * 2026-10-20 by W76B-R); the cached metadata supplies their fields.
 */
export function parseGitBlamePorcelain(stdout: string): IBlameLine[] {
  const lines: IBlameLine[] = [];
  const metaByCommit = new Map<
    string,
    Omit<IBlameLine, "commit" | "lineNumber" | "originalLineNumber" | "content" | "filename"> & { filename: string }
  >();
  let pending:
    | {
        commit: string;
        originalLineNumber: number;
        lineNumber: number;
        author?: string;
        authorMail?: string;
        authorTime?: number;
        authorTz?: string;
        committer?: string;
        committerMail?: string;
        committerTime?: number;
        committerTz?: string;
        summary?: string;
        filename?: string;
        boundary: boolean;
      }
    | undefined;

  const flushMeta = () => {
    if (!pending) {
      return;
    }
    const cached = metaByCommit.get(pending.commit);
    metaByCommit.set(pending.commit, {
      author: pending.author ?? cached?.author ?? "",
      authorMail: pending.authorMail ?? cached?.authorMail ?? "",
      authorTime: pending.authorTime ?? cached?.authorTime ?? 0,
      authorTz: pending.authorTz ?? cached?.authorTz ?? "",
      committer: pending.committer ?? cached?.committer ?? "",
      committerMail: pending.committerMail ?? cached?.committerMail ?? "",
      committerTime: pending.committerTime ?? cached?.committerTime ?? 0,
      committerTz: pending.committerTz ?? cached?.committerTz ?? "",
      summary: pending.summary ?? cached?.summary ?? "",
      filename: pending.filename ?? cached?.filename ?? "",
      boundary: pending.boundary || (cached?.boundary ?? false),
    });
  };

  for (const raw of stdout.split(/\r?\n/)) {
    const header = BLAME_HEADER_RE.exec(raw);
    if (header) {
      flushMeta();
      pending = {
        commit: header[1]!,
        originalLineNumber: Number(header[2]),
        lineNumber: Number(header[3]),
        boundary: false,
      };
      continue;
    }
    if (!pending) {
      continue;
    }
    if (raw.startsWith("\t")) {
      flushMeta();
      const meta = metaByCommit.get(pending.commit)!;
      lines.push({
        commit: pending.commit,
        author: meta.author,
        authorMail: meta.authorMail,
        authorTime: meta.authorTime,
        authorTz: meta.authorTz,
        committer: meta.committer,
        committerMail: meta.committerMail,
        committerTime: meta.committerTime,
        committerTz: meta.committerTz,
        summary: meta.summary,
        filename: pending.filename ?? meta.filename,
        lineNumber: pending.lineNumber,
        originalLineNumber: pending.originalLineNumber,
        content: raw.slice(1),
        boundary: meta.boundary,
      });
      pending = undefined;
      continue;
    }
    if (raw.startsWith("author ")) {
      pending.author = raw.slice("author ".length);
    } else if (raw.startsWith("author-mail ")) {
      pending.authorMail = stripMailBrackets(raw.slice("author-mail ".length));
    } else if (raw.startsWith("author-time ")) {
      pending.authorTime = Number(raw.slice("author-time ".length));
    } else if (raw.startsWith("author-tz ")) {
      pending.authorTz = raw.slice("author-tz ".length);
    } else if (raw.startsWith("committer ")) {
      pending.committer = raw.slice("committer ".length);
    } else if (raw.startsWith("committer-mail ")) {
      pending.committerMail = stripMailBrackets(raw.slice("committer-mail ".length));
    } else if (raw.startsWith("committer-time ")) {
      pending.committerTime = Number(raw.slice("committer-time ".length));
    } else if (raw.startsWith("committer-tz ")) {
      pending.committerTz = raw.slice("committer-tz ".length);
    } else if (raw.startsWith("summary ")) {
      pending.summary = raw.slice("summary ".length);
    } else if (raw.startsWith("filename ")) {
      pending.filename = raw.slice("filename ".length);
    } else if (raw === "boundary") {
      pending.boundary = true;
    }
    // `previous <sha> <filename>` and unknown keys are ignored, like
    // Cursor's parser ignores everything outside its field set.
  }
  return lines;
}

/**
 * VERBATIM port of Cursor's `parseGitBlame` (cursor-retrieval/dist/main.js
 * @1826156) for `git blame --root --incremental` output: groups lines BY
 * HASH into `{hash, authorName, authorEmail, authorDate, subject,
 * ranges}`. Field-for-field the same extraction rules (see the header
 * comment); the only adaptation is TypeScript typing — the binary's
 * temporaries reset to `undefined` after each `filename` flush, exactly as
 * here.
 */
export function parseGitBlameIncremental(stdout: string): IBlameCommitGroup[] {
  const byHash = new Map<string, IBlameCommitGroup>();
  let hash: string | undefined;
  let authorName: string | undefined;
  let authorEmail: string | undefined;
  let authorDate: number | undefined;
  let subject: string | undefined;
  let startLineNumber: number | undefined;
  let endLineNumber: number | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    const headerMatch = /^([0-9a-f]{40})/.exec(line);
    if (!hash && headerMatch) {
      const parts = line.split(" ");
      hash = headerMatch[1];
      startLineNumber = Number(parts[2]);
      endLineNumber = Number(parts[2]) + Number(parts[3]) - 1;
    }
    if (hash && line.startsWith("author ")) {
      authorName = line.substring(7);
    }
    if (hash && line.startsWith("author-mail ")) {
      authorEmail = line.substring(13, line.length - 1);
    }
    if (hash && line.startsWith("author-time ")) {
      authorDate = 1e3 * Number(line.substring(12));
    }
    if (hash && line.startsWith("summary ")) {
      subject = line.substring(8);
    }
    if (hash && startLineNumber !== undefined && endLineNumber !== undefined && line.startsWith("filename ")) {
      const existing = byHash.get(hash);
      if (existing) {
        existing.ranges.push({ startLineNumber, endLineNumber });
      } else {
        byHash.set(hash, {
          hash,
          authorName,
          authorEmail,
          authorDate,
          subject,
          ranges: [{ startLineNumber, endLineNumber }],
        });
      }
      hash = authorName = authorEmail = authorDate = subject = startLineNumber = endLineNumber = undefined;
    }
  }
  return Array.from(byHash.values());
}

/**
 * Parse Cursor's `getGitLogForLine` output: one commit per line, fields
 * joined by `":_:"` in `%H:_:%an:_:%ad:_:%s` order (cursor-retrieval
 * @1821610, verbatim split).
 */
export function parseGitLogLineBlame(stdout: string): ILineBlameCommit[] {
  return stdout
    .split("\n")
    .filter((line) => "" !== line.trim())
    .map((line) => {
      const [commit, author, date, message] = line.split(":_:");
      return { commit: commit ?? "", author: author ?? "", date: date ?? "", message: message ?? "" };
    });
}

/** Separator of Cursor's `getFullCommit` pretty format (`Zpe` in cursor-retrieval). */
export const GIT_COMMIT_METADATA_SEPARATOR = "<|ENT|><|RY|>";

/**
 * Commit metadata as returned by Cursor's provider `getFullCommit` /
 * `getCommitMetadataOnly` (cursor-retrieval @1880342): the workbench maps
 * it to the blame editor input as `{subject: firstLine(message), message:
 * description, author, timestamp: new Date(date).getTime()}`.
 */
export interface ICommitMetadata {
  sha: string;
  /** `%s` — the subject line (the provider names this field `message`). */
  message: string;
  /** `%b` — the commit body. */
  description: string;
  /** `%an` — author name. */
  author: string;
  /** `%ad` — author date string. */
  date: string;
  /** `%cI` — committer date, strict ISO. */
  committerDate: string;
  /** `%P` — parent SHAs. */
  parents: string[];
}

/**
 * Parse Cursor's `getFullCommit` output: `git show -m
 * --pretty=format:%s<SEP>%b<SEP>%an<SEP>%ad<SEP>%cI<SEP>%P<SEP>` split on
 * `<SEP>` (cursor-retrieval, verbatim field order). The trailing diff
 * field is dropped — metadata consumers never read it.
 */
export function parseGitCommitMetadata(stdout: string, sha: string): ICommitMetadata {
  const [message = "", description = "", author = "", date = "", committerDate = "", parents = ""] =
    stdout.split(GIT_COMMIT_METADATA_SEPARATOR);
  return {
    sha,
    message,
    description,
    author,
    date,
    committerDate,
    parents: parents.trim().split(" ").filter((p) => p.length > 0),
  };
}

/** Injectable git seam for tests (default: the sanitized `gitExecFile`). */
export type GitBlameExec = (
  cwd: string,
  args: readonly string[],
  opts?: { maxBuffer?: number; timeoutMs?: number },
) => Promise<{ stdout: string; stderr: string }>;

/** One change line of a unified-diff chunk (Cursor parse-diff output subset: `{type, content}`; `content` INCLUDES the leading `+`/`-`/` ` char). */
export interface ICommitDiffChange {
  type: "add" | "del" | "normal";
  content: string;
}

/** One chunk of a unified-diff file (Cursor parse-diff output shape). */
export interface ICommitDiffChunk {
  content: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  changes: ICommitDiffChange[];
}

/** One file of a commit's diff (Cursor parse-diff output shape). */
export interface ICommitFileDiff {
  from?: string;
  to?: string;
  new?: boolean;
  deleted?: boolean;
  additions: number;
  deletions: number;
  chunks: ICommitDiffChunk[];
}

/**
 * Cursor's oversize-diff placeholder (cursor-retrieval `pce`/`_ce`,
 * VERBATIM incl. the binary's "to large" typo): returned when the raw
 * patch text exceeds 5,000,000 chars.
 */
export const GIT_FULL_COMMIT_DIFF_TOO_LARGE: ICommitFileDiff[] = [
  {
    to: "Diff to large to display",
    deletions: 0,
    additions: 0,
    chunks: [
      {
        content: "Diff to large to display",
        changes: [],
        newStart: 0,
        newLines: 0,
        oldStart: 0,
        oldLines: 0,
      },
    ],
  },
];

/** Strip the `a/`/`b/`-style prefix parse-diff removes from diff paths (`Wle`). */
function stripDiffPathPrefix(p: string): string {
  return p.replace(/^(a|b|i|w|c|o|1|2)\//, "");
}

/**
 * Port of parse-diff's filename cleanup (`Kle`/`Jle`): trims the leading
 * `-`/`+` markers and whitespace, drops a trailing tab-or-date timestamp,
 * strips surrounding quotes, then removes the `a/`/`b/` prefix.
 */
function cleanDiffPath(raw: string): string {
  let p = raw.replace(/^[-+\s]+/, "").trim();
  const ts = /\t.*|\d{4}-\d\d-\d\d\s\d\d:\d\d:\d\d(.\d+)?\s(\+|-)\d\d\d\d/.exec(p);
  if (ts) {
    p = p.slice(0, ts.index).trim();
  }
  p = p.replace(/^\\?['"]|\\?['"]$/g, "");
  return stripDiffPathPrefix(p);
}

/** Extract `[from, to]` from a `diff --git a/<from> b/<to>` line (parse-diff `Hle`/`Vle`, verbatim regex). */
function parseDiffGitLine(line: string): [string | undefined, string | undefined] {
  const parts = line.match(/(a|i|w|c|o|1|2)\/.*(?=["']? ["']?(b|i|w|c|o|1|2)\/)|(b|i|w|c|o|1|2)\/.*$/g);
  if (!parts || parts.length === 0) {
    return [undefined, undefined];
  }
  const cleaned = parts.map((part) => stripDiffPathPrefix(part).replace(/("|')$/, ""));
  return [cleaned[0], cleaned[cleaned.length - 1]];
}

const DIFF_CHUNK_HEADER_RE = /^@@\s+-(\d+),?(\d+)?\s+\+(\d+),?(\d+)?\s@@/;

/**
 * VERBATIM-semantics port of Cursor's parse-diff (`qle`, cursor-retrieval
 * @1794930): parses unified-diff text into files
 * `{from, to, new?, deleted?, additions, deletions, chunks}` where chunk
 * changes are `{type: "add"|"del"|"normal", content}` with `content`
 * keeping its leading marker char. Faithful quirks kept: a file record is
 * created on the `diff ` line (or lazily by a following header line); the
 * `\ No newline at end of file` marker appends a copy-typed change entry
 * WITHOUT touching the addition/deletion counters; empty input or
 * whitespace-only input yields `[]`. The binary's per-change `ln`/`ln1`/
 * `ln2` counters and the `add`/`del`/`normal` boolean flags are omitted —
 * no pane consumer reads them.
 */
export function parseGitUnifiedDiff(diff: string): ICommitFileDiff[] {
  if (!diff || /^\s+$/.test(diff)) {
    return [];
  }
  const files: ICommitFileDiff[] = [];
  let file: ICommitFileDiff | undefined;
  let chunk: ICommitDiffChunk | undefined;
  let oldLine = 0;
  let newLine = 0;
  let remaining: { oldLines: number; newLines: number } | undefined;

  const startFile = (line: string) => {
    const [from, to] = parseDiffGitLine(line);
    file = { chunks: [], deletions: 0, additions: 0, from, to };
    files.push(file);
    chunk = undefined;
    remaining = undefined;
  };
  // parse-diff's `d()`: reuse the pending file while it has no chunks
  // yet (header lines belong to it); otherwise start a fresh record.
  const ensureFile = (line: string) => {
    if (!file || file.chunks.length > 0) {
      startFile(line);
    }
  };
  const appendNoNewlineMarker = (line: string) => {
    if (!chunk || chunk.changes.length === 0) {
      return;
    }
    const last = chunk.changes[chunk.changes.length - 1]!;
    chunk.changes.push({ type: last.type, content: line });
  };

  for (const line of diff.split("\n")) {
    if (remaining) {
      // Inside a chunk body.
      if (/^\\ No newline at end of file$/.test(line)) {
        appendNoNewlineMarker(line);
      } else if (line.startsWith("-")) {
        if (chunk && file) {
          chunk.changes.push({ type: "del", content: line });
          file.deletions++;
          oldLine++;
          remaining.oldLines--;
        }
      } else if (line.startsWith("+")) {
        if (chunk && file) {
          chunk.changes.push({ type: "add", content: line });
          file.additions++;
          newLine++;
          remaining.newLines--;
        }
      } else if (/^\s/.test(line) || line === "") {
        // parse-diff treats whitespace-led lines as context; a truly
        // empty line matches none of its patterns and is skipped WITHOUT
        // decrementing the remaining counters — replicate by only
        // counting whitespace-led lines.
        if (line !== "" && chunk) {
          chunk.changes.push({ type: "normal", content: line });
          oldLine++;
          newLine++;
          remaining.oldLines--;
          remaining.newLines--;
        }
      }
      if (remaining && remaining.oldLines === 0 && remaining.newLines === 0) {
        remaining = undefined;
      }
      continue;
    }
    // Header territory.
    let m: RegExpExecArray | null;
    if (/^diff\s/.test(line)) {
      startFile(line);
    } else if ((m = /^new file mode (\d+)$/.exec(line))) {
      ensureFile(line);
      if (file) {
        file.new = true;
        file.from = "/dev/null";
      }
    } else if ((m = /^deleted file mode (\d+)$/.exec(line))) {
      ensureFile(line);
      if (file) {
        file.deleted = true;
        file.to = "/dev/null";
      }
    } else if (/^old mode (\d+)$/.test(line) || /^new mode (\d+)$/.test(line)) {
      ensureFile(line);
    } else if (/^index\s[\da-zA-Z]+\.\.[\da-zA-Z]+(\s(\d+))?$/.test(line)) {
      ensureFile(line);
    } else if (/^---\s/.test(line)) {
      ensureFile(line);
      if (file) {
        file.from = cleanDiffPath(line.slice("--- ".length - 1));
      }
    } else if (/^\+\+\+\s/.test(line)) {
      ensureFile(line);
      if (file) {
        file.to = cleanDiffPath(line.slice("+++ ".length - 1));
      }
    } else if ((m = DIFF_CHUNK_HEADER_RE.exec(line))) {
      if (!file) {
        startFile(line);
      }
      oldLine = Number(m[1]);
      newLine = Number(m[3]);
      chunk = {
        content: line,
        changes: [],
        oldStart: oldLine,
        oldLines: Number(m[2] || 1),
        newStart: newLine,
        newLines: Number(m[4] || 1),
      };
      remaining = { oldLines: chunk.oldLines, newLines: chunk.newLines };
      file!.chunks.push(chunk);
    } else if (/^\\ No newline at end of file$/.test(line)) {
      appendNoNewlineMarker(line);
    }
  }
  return files;
}

/**
 * Cursor's `pce` (cursor-retrieval): patches longer than 5,000,000 chars
 * resolve to the {@link GIT_FULL_COMMIT_DIFF_TOO_LARGE} placeholder;
 * anything else goes through the parse-diff port.
 */
export function parseFullCommitDiff(diff: string): ICommitFileDiff[] {
  return diff.length > 5_000_000 ? GIT_FULL_COMMIT_DIFF_TOO_LARGE : parseGitUnifiedDiff(diff);
}

/** The provider's `getFullCommit` result: commit metadata + the parsed diff (Cursor verbatim field set). */
export interface ICommitFull extends ICommitMetadata {
  diff: ICommitFileDiff[];
  /** Fork addition mirroring Cursor's pane state: true when the patch overflowed the exec buffer and only metadata was loaded (the pane's large-commit mode). */
  diffOmitted?: boolean;
}

/**
 * Parse Cursor's `getFullCommit` output (cursor-retrieval @1880342): the
 * same `<SEP>`-joined pretty format as {@link parseGitCommitMetadata},
 * split with the binary's own `split(Zpe, 7)` limit — the 7th field is the
 * raw patch text, parsed by {@link parseFullCommitDiff}.
 */
export function parseGitFullCommit(stdout: string, sha: string): ICommitFull {
  const parts = stdout.split(GIT_COMMIT_METADATA_SEPARATOR, 7);
  const [message = "", description = "", author = "", date = "", committerDate = "", parents = "", patch = ""] = parts;
  return {
    sha,
    message,
    description,
    author,
    date,
    committerDate,
    parents: parents.trim().split(" ").filter((p) => p.length > 0),
    diff: parseFullCommitDiff(patch),
  };
}

export interface IGitPathTarget {
  /** Absolute git repo root (the cwd git runs in). */
  cwd: string;
  /** File path relative to the repo root, POSIX separators. */
  repoRelativePath: string;
}

export class GitBlameService {
  constructor(private readonly exec: GitBlameExec = gitExecFile) {}

  /**
   * Cursor `getGitRoot` (cursor-retrieval): `git rev-parse
   * --show-toplevel` in `cwd`, trimmed. Resolves `undefined` when `cwd` is
   * not inside a git repository (Cursor checks the error text; any exec
   * failure here means "no usable repo" for blame purposes, so all
   * failures resolve `undefined` — the workbench maps that to Cursor's
   * own k(5320) "No git repository found" branch).
   */
  async getGitRoot(cwd: string): Promise<string | undefined> {
    try {
      const { stdout } = await this.exec(cwd, ["rev-parse", "--show-toplevel"]);
      const root = stdout.trim();
      return root.length > 0 ? root : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Simplified port of Cursor's `resolveGitPathTarget`: the repo root is
   * discovered from the file's directory and the repo-relative path is
   * computed against it. HONEST-DIVERGENCE: Cursor resolves through
   * workspace folders + `realpath` canonicalization (symlink handling);
   * this fork's provider resolves from the file path alone, which agrees
   * whenever the file is addressed by its real path (the common case).
   * Returns `undefined` when the file is not in a git repository.
   */
  async resolveGitPathTarget(fsPath: string): Promise<IGitPathTarget | undefined> {
    const root = await this.getGitRoot(path.dirname(fsPath));
    if (!root) {
      return undefined;
    }
    const repoRelativePath = path.relative(root, fsPath).split(path.sep).join("/");
    if (!repoRelativePath || repoRelativePath.startsWith("..")) {
      return undefined;
    }
    return { cwd: root, repoRelativePath };
  }

  /**
   * Per-line blame for a whole file via `git blame --porcelain`
   * (task-specified format; see the header comment for how it relates to
   * Cursor's `--incremental` path). Resolves `undefined` when the file is
   * not in a git repository or git fails (untracked file, no commits) —
   * the same failure contract as Cursor's `getGitFileLineBlame`, which
   * catches and resolves `undefined`.
   */
  async getFileBlame(fsPath: string, revision?: string): Promise<IBlameLine[] | undefined> {
    const target = await this.resolveGitPathTarget(fsPath);
    if (!target) {
      return undefined;
    }
    const args: string[] = ["blame", "--porcelain"];
    if (revision) {
      args.push(revision);
    }
    args.push("--", target.repoRelativePath);
    try {
      const { stdout } = await this.exec(target.cwd, args);
      return parseGitBlamePorcelain(stdout);
    } catch {
      return undefined;
    }
  }

  /**
   * Cursor's `getGitFileLineBlame`, verbatim argv and result shape:
   * `git blame --root --incremental [-w] [revision] -- <relPath>` parsed
   * by the verbatim `parseGitBlame` port, with shallow-boundary commits
   * flagged. Resolves `undefined` on any failure, like Cursor.
   *
   * Shallow handling is Cursor's verbatim `readRepositoryShallowInfo`
   * (cursor-retrieval, adjacent to `parseGitBlame` @1826156): one
   * `rev-parse --is-shallow-repository --git-path shallow` call; when the
   * first line is `true`, the `shallow` file it names (relative paths
   * resolved against the repo root) is read and every blame group whose
   * hash is listed gets `isShallowBoundary = true`. HONEST-DIVERGENCE:
   * Cursor caches that info for 30 s; this fork re-reads per call.
   * (Fixed by W76B-R, 2026-10-20: the earlier revision consulted only
   * `--is-shallow-repository`, never set `isShallowBoundary`, and its
   * comment misdescribed the mechanism.)
   */
  async getFileLineBlame(
    fsPath: string,
    revision?: string,
    options: { ignoreWhitespace?: boolean } = {},
  ): Promise<{ blameInformation: IBlameCommitGroup[]; isRepositoryShallow: boolean } | undefined> {
    const target = await this.resolveGitPathTarget(fsPath);
    if (!target) {
      return undefined;
    }
    const args: string[] = ["blame", "--root", "--incremental"];
    if (options.ignoreWhitespace) {
      args.push("-w");
    }
    if (revision) {
      args.push(revision);
    }
    args.push("--", target.repoRelativePath);
    try {
      const { stdout } = await this.exec(target.cwd, args);
      const blameInformation = parseGitBlameIncremental(stdout);
      let isRepositoryShallow = false;
      try {
        const shallow = await this.exec(target.cwd, [
          "rev-parse",
          "--is-shallow-repository",
          "--git-path",
          "shallow",
        ]);
        const [flag, shallowPath] = shallow.stdout.trim().split(/\r?\n/);
        isRepositoryShallow = flag === "true";
        if (isRepositoryShallow && shallowPath) {
          try {
            const absShallowPath = path.isAbsolute(shallowPath)
              ? shallowPath
              : path.join(target.cwd, shallowPath);
            const shallowHashes = new Set(
              (await readFile(absShallowPath, "utf8"))
                .split(/\r?\n/)
                .filter((line) => /^[0-9a-f]{40}$/.test(line)),
            );
            if (shallowHashes.size > 0) {
              for (const group of blameInformation) {
                if (shallowHashes.has(group.hash)) {
                  group.isShallowBoundary = true;
                }
              }
            }
          } catch {
            // The shallow flag was already parsed as true above; a
            // failure reading the shallow file (e.g. it vanished between
            // rev-parse and this read) must not overwrite it with
            // false — the repo IS shallow, only the boundary list is
            // unknown, so no group gets flagged.
          }
        }
      } catch {
        isRepositoryShallow = false;
      }
      return { blameInformation, isRepositoryShallow };
    } catch {
      return undefined;
    }
  }

  /**
   * Cursor's `getGitLogForLine` (registered as the provider's
   * `getGitLineBlame`), verbatim argv:
   * `git --no-pager log -L <line>,<line>:<relPath>
   * --pretty=format:%H:_:%an:_:%ad:_:%s --no-patch -n <count>`.
   * This is the exact call `cursorBlame.viewCommit` consumes via
   * `getGitLineBlameWithAbsolutePath(fsPath, line, 1)`. Resolves
   * `undefined` when the file is not in a git repository; git failures
   * (e.g. uncommitted file) propagate as an empty commit list, matching
   * Cursor, whose caller treats a missing first commit as "not committed
   * yet" (k(5321)).
   */
  async getLineBlame(
    fsPath: string,
    line: number,
    count = 1,
  ): Promise<{ commits: ILineBlameCommit[] } | undefined> {
    const target = await this.resolveGitPathTarget(fsPath);
    if (!target) {
      return undefined;
    }
    const args = [
      "--no-pager",
      "log",
      "-L",
      `${line},${line}:${target.repoRelativePath}`,
      "--pretty=format:%H:_:%an:_:%ad:_:%s",
      "--no-patch",
      "-n",
      `${count}`,
    ];
    try {
      const { stdout } = await this.exec(target.cwd, args);
      return { commits: parseGitLogLineBlame(stdout) };
    } catch {
      return { commits: [] };
    }
  }

  /**
   * Cursor's provider `getCommitMetadataOnly`/`getFullCommit`
   * (cursor-retrieval @1880342), verbatim argv:
   * `git show -m --pretty=format:%s<SEP>%b<SEP>%an<SEP>%ad<SEP>%cI<SEP>%P<SEP> <sha>`
   * run in `cwd` (Cursor uses the first workspace folder). This is the
   * call `cursorBlame.openCommit` consumes; the workbench's own try/catch
   * maps any failure to its empty subject/message fallback, so this
   * resolves `undefined` on failure instead of throwing.
   */
  async getCommitMetadata(cwd: string, commitId: string): Promise<ICommitMetadata | undefined> {
    const sep = GIT_COMMIT_METADATA_SEPARATOR;
    try {
      const { stdout } = await this.exec(cwd, [
        "show",
        "-m",
        `--pretty=format:%s${sep}%b${sep}%an${sep}%ad${sep}%cI${sep}%P${sep}`,
        commitId,
      ]);
      return parseGitCommitMetadata(stdout, commitId);
    } catch {
      return undefined;
    }
  }

  /**
   * Cursor's provider `getFullCommit` (cursor-retrieval @1880342),
   * verbatim: `git show -m --pretty=format:%s<SEP>%b<SEP>%an<SEP>%ad<SEP>
   * %cI<SEP>%P<SEP> <sha>` with `maxBuffer: 31457280`, the output split
   * into metadata + raw patch (see {@link parseGitFullCommit}). This is
   * the call the workbench commit pane (`CursorBlamePane.pe`) consumes.
   *
   * Failure contract mirrors the binary's two layers: when the exec dies
   * with `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`, Cursor's provider falls
   * back to `getCommitMetadataOnly` and the pane enters large-commit
   * (metadata-only) mode — here that is `{...metadata, diff: [],
   * diffOmitted: true}`, or `undefined` when even the metadata call
   * fails. Any other git failure resolves `undefined`; the pane maps it
   * to its "Could not find commit" state (the binary instead surfaces
   * "Failed to load commit: <fatal>" for an unknown SHA — documented
   * divergence of the error TEXT only, both are terminal error states).
   *
   * NOTE: this fork's sanitized `gitExecFile` caps output at its own
   * `GIT_MAX_BUFFER` (4MB, DEV-GAPS-14) unless a larger `maxBuffer` is
   * passed; the binary's 30MB is passed explicitly here, so the effective
   * cap matches Cursor's provider.
   */
  async getFullCommit(cwd: string, commitId: string): Promise<ICommitFull | undefined> {
    const sep = GIT_COMMIT_METADATA_SEPARATOR;
    try {
      const { stdout } = await this.exec(
        cwd,
        [
          "show",
          "-m",
          `--pretty=format:%s${sep}%b${sep}%an${sep}%ad${sep}%cI${sep}%P${sep}`,
          commitId,
        ],
        { maxBuffer: 31457280 },
      );
      return parseGitFullCommit(stdout, commitId);
    } catch (err) {
      const code = (err as { code?: unknown } | undefined)?.code;
      const message = err instanceof Error ? err.message : String(err);
      if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || message.includes("maxBuffer")) {
        const metadata = await this.getCommitMetadata(cwd, commitId);
        return metadata ? { ...metadata, diff: [], diffOmitted: true } : undefined;
      }
      return undefined;
    }
  }

  /**
   * File content at a revision, for the file pane's revision model.
   * Cursor's file-blame component resolves the path at the revision
   * (`ls-tree` / `log --follow` rename tracking, `c8S`) and then runs
   * `executeGitCommand(cwd, ["show", "<rev>:<path>"])` through the git
   * facade (3.25.9). HONEST-DIVERGENCE: this fork uses the file's current
   * repo-relative path directly (no rename tracking); when that fails —
   * including the renamed-file case Cursor handles — it resolves
   * `undefined` and the pane falls back to the current file model, which
   * is also Cursor's own failure fallback ("Could not load file at
   * revision, using current").
   */
  async getFileContentAtRevision(fsPath: string, revision: string): Promise<string | undefined> {
    const target = await this.resolveGitPathTarget(fsPath);
    if (!target) {
      return undefined;
    }
    try {
      const { stdout } = await this.exec(target.cwd, ["show", `${revision}:${target.repoRelativePath}`]);
      return stdout;
    } catch {
      return undefined;
    }
  }
}

/** Shared provider instance used by the `ide.cursorBlame.*` commands. */
export const gitBlameService = new GitBlameService();
