// IDE-CODE: Migrated from extensions/ide-agent/src/services/aiCodeTracking.ts (CAT-A, pure logic).
/**
 * AI code tracking — port of Cursor's `aiCodeTrackingService` +
 * `aiCodeTracking` workbench contribution (DIG-STATUSBAR-AI, 2026-10-19).
 *
 * Cursor keeps per-day counters of AI-suggested vs AI-accepted lines for two
 * sources — Tab completions and the Composer/Agent — plus a scored-commit
 * record, and renders three display-only status-bar items:
 *   - `aiCodeTracking.stats.tab`         @ priority 100
 *   - `aiCodeTracking.stats.composer`     @ priority 99
 *   - `aiCodeTracking.stats.recentCommit` @ priority 98
 * ...and the palette command `aiCodeTracking.resetDailyStats`.
 *
 * This module is intentionally vscode-free (pure logic + persistence behind a
 * minimal memento interface) so it is unit-testable with plain node:test.
 * The status-bar UI lives in `aiCodeTrackingStatusBar.ts`; the git commit
 * hook lives in `commitScoreWatcher.ts`.
 *
 * Honest divergences from Cursor (see also the itemized comments below):
 *  1. Persistence: Cursor writes `aiCodeTracking.dailyStats.v1.5.{date}` to
 *     the storage service with scope -1 (WORKSPACE) and `aiCodeTracking.recentCommit`
 *     with scope 1 (PROFILE). We use `ExtensionContext.workspaceState` and
 *     `globalState` respectively — the same effective scopes through the
 *     extension-host API. Key names are kept verbatim for parity.
 *  2. Line counting: Cursor diffs previousContent vs updatedContent per
 *     analytics event (`linesAdded + linesRemoved`). A suggestion/accept is a
 *     pure text insertion, so our `countLines(text)` equals that diff for the
 *     Tab path; the inline-edit path counts the real diff hunks.
 *  3. Commit attribution: Cursor scores commits SERVER-SIDE with exact
 *     generation provenance. We only know what this client generated, so we
 *     attribute a commit's added/removed lines by CONTENT MATCH against the
 *     accepted-line sets recorded today (see `AttributionIndex`). Deleted
 *     lines are attributed the same way (a deleted line counts as AI if its
 *     content was AI-generated). This is a best-effort local heuristic.
 *  4. Oversized-commit threshold: Cursor skips commits whose diff is omitted
 *     as oversized (exact server limit unknown); we skip at
 *     OVERSIZED_COMMIT_LINE_LIMIT changed lines — a local choice.
 *  5. Composer events: inline-edit preview/accept are wired
 *     (`composer.diff_summary` / `composer.accept_diff` analogs). File edits
 *     applied directly by the engine process (outside the extension host)
 *     have no in-extension event — `recordComposerSuggest` /
 *     `recordComposerAccept` are public so any future engine bridge can feed
 *     them.
 */

export type TrackingSource = 'TAB' | 'COMPOSER';

/** One day of counters. Mirrors the shape Cursor persists per date. */
export interface DailyStats {
  date: string; // local YYYY-MM-DD
  tabSuggested: number;
  tabAccepted: number;
  composerSuggested: number;
  composerAccepted: number;
}

/** Scored-commit record (Cursor's `onDidScoreCommit` payload shape). */
export interface ScoredCommit {
  commitHash: string;
  shortHash: string;
  commitMessage: string;
  commitDate: string;
  repoName?: string;
  branchName?: string;
  aiPercentage: number;
  tabLinesAdded: number;
  tabLinesDeleted: number;
  composerLinesAdded: number;
  composerLinesDeleted: number;
  linesAdded: number;
  linesDeleted: number;
  timestamp: number;
}

/** Minimal memento surface (structurally satisfied by vscode.Memento). */
export interface MementoLike {
  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

/** Read side of the AI-attribution index used by commit scoring. */
export interface AttributionReader {
  /**
   * True when `line` (already normalized by the caller) was AI-generated for
   * `source` in any of the `fileKeys` (callers pass several candidate keys,
   * e.g. repo-relative path + basename, because record-time keys are
   * workspace-relative while score-time paths are repo-relative).
   */
  hasLine(source: TrackingSource, fileKeys: string[], line: string): boolean;
}

/** `YYYY-MM-DD` in the user's local timezone (Cursor rolls over on local date). */
export function todayKey(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Number of lines in `text` — the `linesAdded + linesRemoved` of a pure
 * insertion diff (Cursor's per-event unit). A trailing newline does not add
 * a line (inserting "a\n" is 1 added line in diff terms); empty text is 0.
 */
export function countLines(text: string): number {
  if (typeof text !== 'string' || text.length === 0) return 0;
  const parts = text.split('\n');
  if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
  return parts.length;
}

/** Cursor: `suggested > 0 ? Math.round(accepted / suggested * 100) : 0`. */
export function acceptanceRate(accepted: number, suggested: number): number {
  if (!(suggested > 0)) return 0;
  return Math.round((accepted / suggested) * 100);
}

export function emptyDailyStats(date: string): DailyStats {
  return { date, tabSuggested: 0, tabAccepted: 0, composerSuggested: 0, composerAccepted: 0 };
}

/** Normalize a line for the attribution index: trim, drop empties. */
export function normalizeAttributedLine(line: string): string {
  return line.trim();
}

const DAILY_STATS_KEY_PREFIX = 'aiCodeTracking.dailyStats.v1.5.';
const RECENT_COMMIT_KEY = 'aiCodeTracking.recentCommit';

/** Cap: accepted-line attribution sets (long sessions must not grow unbounded). */
const MAX_ATTRIBUTED_FILES = 500;
const MAX_ATTRIBUTED_LINES_PER_FILE = 2000;

/** Local oversized-commit threshold — see module header note 4. */
export const OVERSIZED_COMMIT_LINE_LIMIT = 10_000;

function dailyStatsKey(date: string): string {
  return `${DAILY_STATS_KEY_PREFIX}${date}`;
}

/**
 * Settle a VS Code `Thenable` without ever surfacing a rejection.
 * (Thenable has no `.catch` — only `then(onF, onR)`.)
 */
function ignoreRejection(t: Thenable<void>): void {
  try {
    t.then(undefined, () => undefined);
  } catch {
    /* memento failures are non-fatal */
  }
}

function sanitizeStats(raw: unknown, date: string): DailyStats {
  const base = emptyDailyStats(date);
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
  return {
    date: typeof r['date'] === 'string' ? r['date'] : date,
    tabSuggested: num(r['tabSuggested']),
    tabAccepted: num(r['tabAccepted']),
    composerSuggested: num(r['composerSuggested']),
    composerAccepted: num(r['composerAccepted']),
  };
}

export class AiCodeTrackingService implements AttributionReader {
  private stats: DailyStats;
  private recentCommit: ScoredCommit | undefined;
  private changeListeners = new Set<() => void>();
  private scoreListeners = new Set<(commit: ScoredCommit) => void>();
  /** fileKey -> source -> insertion-ordered set of normalized accepted lines. */
  private attributed = new Map<string, Map<TrackingSource, Set<string>>>();

  constructor(
    private readonly workspaceState: MementoLike,
    private readonly globalState: MementoLike,
    private readonly now: () => Date = () => new Date(),
  ) {
    const today = todayKey(this.now());
    this.stats = sanitizeStats(this.workspaceState.get(dailyStatsKey(today)), today);
    if (this.stats.date !== today) {
      // Stale entry from a previous day under today's key is impossible in
      // practice (keys are per-date), but a clock jump backwards could do it —
      // treat as a fresh day.
      this.stats = emptyDailyStats(today);
    }
    const savedCommit = this.globalState.get<ScoredCommit>(RECENT_COMMIT_KEY);
    this.recentCommit = savedCommit && typeof savedCommit === 'object' ? savedCommit : undefined;
  }

  /** Subscribe to any counter/commit change (status-bar refresh hook). */
  onDidChange(listener: () => void): { dispose(): void } {
    this.changeListeners.add(listener);
    return { dispose: () => void this.changeListeners.delete(listener) };
  }

  /** Cursor's `aiCodeTrackingService.onDidScoreCommit`. */
  onDidScoreCommit(listener: (commit: ScoredCommit) => void): { dispose(): void } {
    this.scoreListeners.add(listener);
    return { dispose: () => void this.scoreListeners.delete(listener) };
  }

  private fireChange(): void {
    for (const l of [...this.changeListeners]) {
      try {
        l();
      } catch {
        // A status-bar refresh must never break the recording path.
      }
    }
  }

  /** Cursor: on every event, roll over when `todayStats.date !== today`. */
  private ensureToday(): void {
    const today = todayKey(this.now());
    if (this.stats.date !== today) {
      this.stats = emptyDailyStats(today);
    }
  }

  private persist(): void {
    // Fire-and-forget: stats must never block typing/accepting.
    try {
      ignoreRejection(this.workspaceState.update(dailyStatsKey(this.stats.date), this.stats));
    } catch {
      /* memento failures are non-fatal */
    }
  }

  /** Cursor `tab.suggestion` / `composer.diff_summary` analog. */
  recordSuggest(source: TrackingSource, lines: number): void {
    if (!Number.isFinite(lines) || lines <= 0) return;
    this.ensureToday();
    if (source === 'TAB') this.stats.tabSuggested += Math.floor(lines);
    else this.stats.composerSuggested += Math.floor(lines);
    this.persist();
    this.fireChange();
  }

  /** Cursor `tab.accept` / `composer.accept_diff` analog. */
  recordAccept(source: TrackingSource, lines: number): void {
    if (!Number.isFinite(lines) || lines <= 0) return;
    this.ensureToday();
    if (source === 'TAB') this.stats.tabAccepted += Math.floor(lines);
    else this.stats.composerAccepted += Math.floor(lines);
    this.persist();
    this.fireChange();
  }

  /**
   * Remember accepted text per file for commit attribution (heuristic —
   * see module header note 3). Call on every accept with the accepted text.
   */
  recordAcceptedLines(source: TrackingSource, fileKey: string, text: string): void {
    if (!fileKey || typeof text !== 'string' || text.length === 0) return;
    let bySource = this.attributed.get(fileKey);
    if (!bySource) {
      if (this.attributed.size >= MAX_ATTRIBUTED_FILES) {
        // Evict the oldest file (Maps are insertion-ordered).
        const oldest = this.attributed.keys().next();
        if (!oldest.done) this.attributed.delete(oldest.value);
      }
      bySource = new Map();
      this.attributed.set(fileKey, bySource);
    }
    let lines = bySource.get(source);
    if (!lines) {
      lines = new Set();
      bySource.set(source, lines);
    }
    for (const rawLine of text.split('\n')) {
      const line = normalizeAttributedLine(rawLine);
      if (line.length === 0) continue;
      if (lines.size >= MAX_ATTRIBUTED_LINES_PER_FILE) break;
      lines.add(line);
    }
  }

  hasLine(source: TrackingSource, fileKeys: string[], line: string): boolean {
    if (line.length === 0) return false;
    for (const key of fileKeys) {
      if (this.attributed.get(key)?.get(source)?.has(line)) return true;
    }
    // Basename fallback: record-time keys are workspace-relative while
    // score-time paths are repo-relative (nested-repo layouts); a shared
    // basename still identifies the file for this best-effort heuristic.
    for (const key of fileKeys) {
      const base = basenameOf(key);
      for (const [storedKey, bySource] of this.attributed) {
        if (storedKey === key || basenameOf(storedKey) !== base) continue;
        if (bySource.get(source)?.has(line)) return true;
      }
    }
    return false;
  }

  /** Cursor `onDidScoreCommit` → store + save + updateStatusBar. */
  recordScoredCommit(commit: ScoredCommit): void {
    this.recentCommit = commit;
    try {
      ignoreRejection(this.globalState.update(RECENT_COMMIT_KEY, commit));
    } catch {
      /* non-fatal */
    }
    for (const l of [...this.scoreListeners]) {
      try {
        l(commit);
      } catch {
        /* listeners must not break scoring */
      }
    }
    this.fireChange();
  }

  /**
   * Cursor `aiCodeTracking.resetDailyStats` — resets all live counters for
   * today. Attribution history and the recent-commit record are kept (they
   * feed commit scoring, which is not "daily stats").
   */
  resetDailyStats(): void {
    this.stats = emptyDailyStats(todayKey(this.now()));
    this.persist();
    this.fireChange();
  }

  snapshot(): DailyStats {
    this.ensureToday();
    return { ...this.stats };
  }

  getRecentCommit(): ScoredCommit | undefined {
    return this.recentCommit ? { ...this.recentCommit } : undefined;
  }

  tabAcceptance(): number {
    const s = this.snapshot();
    return acceptanceRate(s.tabAccepted, s.tabSuggested);
  }

  composerAcceptance(): number {
    const s = this.snapshot();
    return acceptanceRate(s.composerAccepted, s.composerSuggested);
  }
}

// ---------------------------------------------------------------------------
// Status-bar text formatting (verbatim Cursor strings, DIG-STATUSBAR-AI §1).
// ---------------------------------------------------------------------------

export function formatTabText(stats: DailyStats): string {
  return `Tab Stats: ${stats.tabAccepted}/${stats.tabSuggested} (${acceptanceRate(stats.tabAccepted, stats.tabSuggested)}%)`;
}

export function formatTabAria(stats: DailyStats): string {
  const p = acceptanceRate(stats.tabAccepted, stats.tabSuggested);
  return `Tab AI Stats: ${stats.tabAccepted} accepted out of ${stats.tabSuggested} suggested, ${p} percent acceptance rate`;
}

export function formatTabTooltip(stats: DailyStats): string {
  const p = acceptanceRate(stats.tabAccepted, stats.tabSuggested);
  return `Tab AI Stats (Today): ${stats.tabAccepted}/${stats.tabSuggested} lines (${p}%)`;
}

export function formatComposerText(stats: DailyStats): string {
  return `Agent Stats: ${stats.composerAccepted}/${stats.composerSuggested} (${acceptanceRate(stats.composerAccepted, stats.composerSuggested)}%)`;
}

export function formatComposerAria(stats: DailyStats): string {
  const p = acceptanceRate(stats.composerAccepted, stats.composerSuggested);
  return `Agent AI Stats: ${stats.composerAccepted} accepted out of ${stats.composerSuggested} suggested, ${p} percent acceptance rate`;
}

export function formatComposerTooltip(stats: DailyStats): string {
  const p = acceptanceRate(stats.composerAccepted, stats.composerSuggested);
  return `Agent AI Stats (Today): ${stats.composerAccepted}/${stats.composerSuggested} lines (${p}%)`;
}

export function formatRecentCommitText(commit: ScoredCommit | undefined): string {
  if (!commit) return 'No commit scored';
  return `${commit.shortHash} ${commit.aiPercentage}% AI`;
}

export function formatRecentCommitAria(commit: ScoredCommit | undefined): string {
  if (!commit) return 'No commit has been scored yet';
  return `Most recent commit scored: ${commit.shortHash}, ${commit.aiPercentage} percent AI-generated`;
}

/** Verbatim multi-line tooltip from Cursor's bundle (DIG-STATUSBAR-AI §1c). */
export function formatRecentCommitTooltip(commit: ScoredCommit | undefined): string {
  if (!commit) return 'No commit has been scored yet';
  const tabLines = commit.tabLinesAdded + commit.tabLinesDeleted;
  const composerLines = commit.composerLinesAdded + commit.composerLinesDeleted;
  const aiLines = tabLines + composerLines;
  const lines: string[] = [
    'Most Recent Commit Scored:',
    commit.shortHash,
    commit.commitMessage.slice(0, 40),
  ];
  if (commit.repoName) lines.push(`Repo: ${commit.repoName}`);
  if (commit.branchName) lines.push(`Branch: ${commit.branchName}`);
  lines.push(
    '========================================',
    `AI-Generated: ${commit.aiPercentage}% (${aiLines} lines)`,
    `  - Tab: ${tabLines} lines (${commit.tabLinesAdded} added, ${commit.tabLinesDeleted} deleted)`,
    `  - Composer: ${composerLines} lines (${commit.composerLinesAdded} added, ${commit.composerLinesDeleted} deleted)`,
    `Total Changes: ${commit.linesAdded} added, ${commit.linesDeleted} deleted`,
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Commit scoring pipeline (DD-SB-6).
// ---------------------------------------------------------------------------

/** Minimal git runner (injectable for tests). */
export interface GitRunner {
  run(args: string[], cwd: string): Promise<{ stdout: string; code: number }>;
}

export type ScoreSkipReason =
  | 'merge-commit'
  | 'oversized-commit'
  | 'empty-commit'
  | 'not-found'
  | 'git-error';

export type ScoreOutcome =
  | { kind: 'scored'; commit: ScoredCommit }
  | { kind: 'skipped'; reason: ScoreSkipReason; detail?: string };

export interface ScoreCommitOptions {
  repoPath: string;
  commitHash: string;
  repoName?: string;
  branchName?: string;
  /** Override for tests; default OVERSIZED_COMMIT_LINE_LIMIT. */
  oversizedLineLimit?: number;
}

interface NumstatEntry {
  added: number;
  deleted: number;
  path: string;
}

function parseNumstat(stdout: string): NumstatEntry[] {
  const entries: NumstatEntry[] = [];
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.replace(/\0$/, '');
    if (line.length === 0) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    // Binary files show "-\t-\t<path>".
    const added = parts[0] === '-' ? 0 : Number(parts[0]);
    const deleted = parts[1] === '-' ? 0 : Number(parts[1]);
    if (!Number.isFinite(added) || !Number.isFinite(deleted)) continue;
    entries.push({ added, deleted, path: parts.slice(2).join('\t') });
  }
  return entries;
}

/** `src/{old => new}.ts` → `src/new.ts`; `{a => b}` → `b`; plain → itself. */
export function newPathOf(numstatPath: string): string {
  const arrow = numstatPath.lastIndexOf(' => ');
  if (arrow < 0) return numstatPath;
  let rest = numstatPath.slice(arrow + 4);
  if (rest.endsWith('}')) rest = rest.slice(0, -1);
  // Brace form carries the common directory prefix before `{`.
  const brace = numstatPath.lastIndexOf('{');
  if (brace >= 0 && brace < arrow) {
    return numstatPath.slice(0, brace) + rest;
  }
  return rest;
}

function basenameOf(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

/**
 * Score one commit: skip merges + oversized/empty diffs (Cursor parity),
 * attribute added/removed lines via the attribution index, compute
 * aiPercentage. Never throws — failures become `{kind:'skipped'}`.
 */
export async function scoreCommit(
  opts: ScoreCommitOptions,
  attribution: AttributionReader,
  git: GitRunner,
): Promise<ScoreOutcome> {
  const limit = opts.oversizedLineLimit ?? OVERSIZED_COMMIT_LINE_LIMIT;
  const { repoPath, commitHash } = opts;
  try {
    // 1. Metadata + parents (NUL-separated so subjects with spaces are safe).
    const meta = await git.run(
      ['show', '-s', '--format=%H%x00%P%x00%cI%x00%s', commitHash, '--'],
      repoPath,
    );
    if (meta.code !== 0 || meta.stdout.trim().length === 0) {
      return { kind: 'skipped', reason: 'not-found', detail: commitHash };
    }
    const [hash, parentsRaw, commitDate, subject] = meta.stdout.split('\x00');
    if (!hash) return { kind: 'skipped', reason: 'not-found', detail: commitHash };
    const parents = (parentsRaw ?? '').split(' ').filter((p) => p.length > 0);
    if (parents.length > 1) {
      return { kind: 'skipped', reason: 'merge-commit', detail: `${parents.length} parents` };
    }

    // 2. Numstat for size gating.
    const numstat = await git.run(['show', '--format=', '--numstat', commitHash, '--'], repoPath);
    if (numstat.code !== 0) {
      return { kind: 'skipped', reason: 'git-error', detail: 'numstat failed' };
    }
    const entries = parseNumstat(numstat.stdout);
    let linesAdded = 0;
    let linesDeleted = 0;
    for (const e of entries) {
      linesAdded += e.added;
      linesDeleted += e.deleted;
    }
    const total = linesAdded + linesDeleted;
    if (total > limit) {
      return { kind: 'skipped', reason: 'oversized-commit', detail: `${total} lines > ${limit}` };
    }
    if (total === 0) {
      return { kind: 'skipped', reason: 'empty-commit' };
    }

    // 3. Content diff (zero context) for line-level attribution.
    const diff = await git.run(
      ['show', '--format=', '-U0', '--no-color', commitHash, '--'],
      repoPath,
    );
    if (diff.code !== 0) {
      return { kind: 'skipped', reason: 'git-error', detail: 'diff failed' };
    }
    let tabAdded = 0;
    let tabDeleted = 0;
    let composerAdded = 0;
    let composerDeleted = 0;
    let currentFile = '';
    for (const rawLine of diff.stdout.split('\n')) {
      if (rawLine.startsWith('+++ b/')) {
        currentFile = rawLine.slice('+++ b/'.length);
        continue;
      }
      if (rawLine.startsWith('--- ')) continue;
      if (rawLine.startsWith('+++ ')) continue;
      if (rawLine.startsWith('+') && !rawLine.startsWith('+++')) {
        const line = normalizeAttributedLine(rawLine.slice(1));
        if (line.length === 0 || currentFile.length === 0) continue;
        const keys = [newPathOf(currentFile), basenameOf(newPathOf(currentFile))];
        if (attribution.hasLine('TAB', keys, line)) tabAdded++;
        else if (attribution.hasLine('COMPOSER', keys, line)) composerAdded++;
        continue;
      }
      if (rawLine.startsWith('-') && !rawLine.startsWith('---')) {
        const line = normalizeAttributedLine(rawLine.slice(1));
        if (line.length === 0 || currentFile.length === 0) continue;
        const keys = [newPathOf(currentFile), basenameOf(newPathOf(currentFile))];
        if (attribution.hasLine('TAB', keys, line)) tabDeleted++;
        else if (attribution.hasLine('COMPOSER', keys, line)) composerDeleted++;
      }
    }

    const aiLines = tabAdded + tabDeleted + composerAdded + composerDeleted;
    const aiPercentage = total > 0 ? Math.round((aiLines / total) * 100) : 0;
    return {
      kind: 'scored',
      commit: {
        commitHash: hash,
        shortHash: hash.slice(0, 7),
        commitMessage: (subject ?? '').trim(),
        commitDate: (commitDate ?? '').trim(),
        ...(opts.repoName ? { repoName: opts.repoName } : {}),
        ...(opts.branchName ? { branchName: opts.branchName } : {}),
        aiPercentage,
        tabLinesAdded: tabAdded,
        tabLinesDeleted: tabDeleted,
        composerLinesAdded: composerAdded,
        composerLinesDeleted: composerDeleted,
        linesAdded,
        linesDeleted,
        timestamp: Date.now(),
      },
    };
  } catch (err) {
    return {
      kind: 'skipped',
      reason: 'git-error',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Singleton access (wired once during activation).
// ---------------------------------------------------------------------------

let shared: AiCodeTrackingService | undefined;

/** Call once from the extension `activate` with the real mementos. */
export function initAiCodeTracking(
  workspaceState: MementoLike,
  globalState: MementoLike,
): AiCodeTrackingService {
  shared = new AiCodeTrackingService(workspaceState, globalState);
  return shared;
}

/** The shared service. Throws if `initAiCodeTracking` has not run yet. */
export function getAiCodeTracking(): AiCodeTrackingService {
  if (!shared) {
    throw new Error('aiCodeTracking: initAiCodeTracking() must run during activation first');
  }
  return shared;
}

/** Non-throwing accessor for event paths that must never break the editor. */
export function tryGetAiCodeTracking(): AiCodeTrackingService | undefined {
  return shared;
}
