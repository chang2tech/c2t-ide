/**
 * Enablement gates for Tab completion — port of Cursor's `isCppEnabled` family:
 *   isCppEnabled(editor) = isAllowedCpp() && isCppEnabledForEditor(editor)
 *
 * Pure functions here; vscode-specific reads (document text, config) live in
 * provider.ts / extension.ts. Glob matching is a small self-contained
 * implementation (supports `*`, `**`, `?`) so this module stays dependency-free.
 */

import { MAX_FILE_CHARS } from './types';

/** File-size gate: skip Tab for models larger than 5M chars (quu=5e6). */
export function isFileTooLarge(charCount: number): boolean {
  return charCount > MAX_FILE_CHARS;
}

/** Convert a single glob segment pattern to a RegExp source fragment. */
function segmentToRegex(seg: string): string {
  let out = '';
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i]!;
    if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return out;
}

/** Match a path against one glob pattern (`*`, `**`, `?`; `/`-aware). */
export function globMatch(pattern: string, path: string): boolean {
  const normPat = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
  const normPath = path.replace(/\\/g, '/');
  // P2 (QA-FILE-06): matchBase semantics — a pattern with no `/` matches the
  // basename at any depth, gitignore-style (`*.ts` matches src/a.ts).
  if (!normPat.includes('/')) {
    const base = normPath.split('/').pop() ?? normPath;
    return new RegExp('^' + segmentToRegex(normPat) + '$').test(base);
  }
  // `**/` can match zero directories; trailing `/**` matches everything below.
  const segs = normPat.split('/');
  let src = '^';
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]!;
    const last = i === segs.length - 1;
    if (seg === '**') {
      // Leading/middle `**/` matches zero or more directories; trailing `/**`
      // matches everything below (files included).
      src += last ? '.*' : '(?:.*/)?';
    } else {
      src += segmentToRegex(seg);
      if (!last) src += '/';
    }
  }
  src += '$';
  return new RegExp(src).test(normPath);
}

/** True if `path` matches any of the ignore patterns (analog of .cursorignore). */
export function matchesAnyPattern(path: string, patterns: string[]): boolean {
  return patterns.some((p) => p.trim().length > 0 && globMatch(p.trim(), path));
}

/** Per-language disable: config list OR persistent per-language toggle. */
export function isLanguageDisabled(
  languageId: string,
  disabledLanguages: string[],
  perLanguageState: Record<string, 'disabled' | 'enabled' | undefined>,
): boolean {
  if (disabledLanguages.includes(languageId)) return true;
  return perLanguageState[languageId] === 'disabled';
}

/**
 * Line-comment markers per language id (subset covering the common cases).
 * Used by `ide.tab.suggestionWhileCommenting`.
 */
const LINE_COMMENT_MARKERS: Record<string, string[]> = {
  javascript: ['//'],
  typescript: ['//'],
  javascriptreact: ['//'],
  typescriptreact: ['//'],
  java: ['//'],
  c: ['//'],
  cpp: ['//'],
  csharp: ['//'],
  go: ['//'],
  rust: ['//'],
  swift: ['//'],
  kotlin: ['//'],
  scala: ['//'],
  php: ['//'],
  dart: ['//'],
  python: ['#'],
  ruby: ['#'],
  shellscript: ['#'],
  bash: ['#'],
  sh: ['#'],
  perl: ['#'],
  r: ['#'],
  yaml: ['#'],
  dockerfile: ['#'],
  makefile: ['#'],
  ini: ['#', ';'],
  sql: ['--'],
  lua: ['--'],
  haskell: ['--'],
  clojure: [';'],
  lisp: [';'],
  scheme: [';'],
  tex: ['%'],
  latex: ['%'],
  html: ['<!--'],
  xml: ['<!--'],
  vue: ['<!--'],
  css: ['/*'],
  less: ['//'],
  scss: ['//'],
};

/**
 * Heuristic: is the cursor on a comment? `linePrefix` is the current line's
 * text before the cursor. True when the line starts with a comment marker
 * or a marker appears after whitespace (trailing comment).
 *
 * Deliberately heuristic (no semantic tokens at this layer) — documented as
 * such. Strings containing markers (e.g. URLs) can false-positive; the
 * setting defaults to ON so this only bites when the user opts out.
 */
export function isCommentPosition(linePrefix: string, languageId: string): boolean {
  const markers = LINE_COMMENT_MARKERS[languageId] ?? ['//', '#'];
  const trimmed = linePrefix.trimStart();
  for (const m of markers) {
    if (trimmed.startsWith(m)) return true;
    // Trailing comment: marker preceded by start-of-line or whitespace.
    let idx = linePrefix.indexOf(m);
    while (idx > 0) {
      if (/\s/.test(linePrefix[idx - 1]!)) return true;
      idx = linePrefix.indexOf(m, idx + 1);
    }
  }
  return false;
}

export interface EditorGateInput {
  charCount: number;
  fsPath: string;
  /**
   * Workspace-relative path (via `vscode.workspace.asRelativePath`), used for
   * matching user ignore patterns (e.g. `src` + `/**` + `/*.ts`). Falls back
   * to `fsPath` when the file is outside any workspace folder. P2 (QA-FILE-06):
   * patterns were previously matched against the absolute path, so
   * workspace-relative patterns could never match.
   */
  relPath?: string;
  languageId: string;
  disabledLanguages: string[];
  perLanguageState: Record<string, 'disabled' | 'enabled' | undefined>;
  ignorePatterns: string[];
  /**
   * SETTINGS-PARITY (`ide.tab.suggestionWhileCommenting`): when false and
   * `cursorLinePrefix` is provided, no suggestion is offered on comment
   * lines. Defaults to true (suggest everywhere).
   */
  suggestionWhileCommenting?: boolean;
  /** Current line's text before the cursor (for the comment heuristic). */
  cursorLinePrefix?: string;
}

export type GateVerdict =
  | { allowed: true }
  | { allowed: false; reason: 'too_large' | 'ignored' | 'language_disabled' | 'comment' };

/** Per-editor half of `isCppEnabledForEditor`. */
export function gateEditor(input: EditorGateInput): GateVerdict {
  if (isFileTooLarge(input.charCount)) return { allowed: false, reason: 'too_large' };
  const matchPath = input.relPath && input.relPath.length > 0 ? input.relPath : input.fsPath;
  if (matchesAnyPattern(matchPath, input.ignorePatterns)) return { allowed: false, reason: 'ignored' };
  if (isLanguageDisabled(input.languageId, input.disabledLanguages, input.perLanguageState))
    return { allowed: false, reason: 'language_disabled' };
  if (
    input.suggestionWhileCommenting === false &&
    input.cursorLinePrefix !== undefined &&
    isCommentPosition(input.cursorLinePrefix, input.languageId)
  )
    return { allowed: false, reason: 'comment' };
  return { allowed: true };
}
