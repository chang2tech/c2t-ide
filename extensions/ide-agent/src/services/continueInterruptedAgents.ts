/**
 * continueInterruptedAgents — "Continue Interrupted Agents" (Cursor parity).
 *
 * EVIDENCE (live CDP, Cursor 3.25.9 — docs/rea/detail-settings-2026-10-19.md:63,
 * Settings › General › Startup):
 *   "Continue Interrupted Agents" — "Automatically resume working on agents
 *   and their subagents after a reload or restart" — toggle ON (live: checked).
 * Mirrored setting: `ide.agent.continueInterruptedAgents` (boolean, default
 * true), registered in src/vs/workbench/contrib/composer/common/
 * composerConfiguration.ts (IDE Code › General).
 *
 * MECHANISM (fork): a ComposerDataService turn is in-flight state that dies
 * with the extension host. runTurn persists an {@link InterruptedTurnRecord}
 * the moment a turn starts and clears it when the turn settles — so a record
 * that SURVIVES to the next activation is, by construction, a turn that was
 * interrupted by a reload/restart (its settle path never ran). The startup
 * sweep in extension.ts re-submits each surviving record's prompt into the
 * active composer when the setting is on. Records are dropped (not resumed)
 * when the setting is off.
 *
 * HONEST DIVERGENCES vs Cursor:
 *  - Cursor resumes the same agent conversation. This fork's chat transcripts
 *    live in memory only (no transcript persistence in the extension runtime),
 *    so a resume starts a NEW turn with the interrupted prompt in the active
 *    chat tab — the agent continues working on the same task, but without the
 *    pre-reload transcript or the old engine session id.
 *  - "and their subagents": subagents in this engine are spawned by a turn
 *    (the `task` tool), so resuming the parent turn covers the subagent tree
 *    transitively — there is no separate per-subagent record.
 *  - Records from multiple chat tabs all resume into the startup-active tab
 *    (later records queue behind the first turn per the normal queue rules).
 *
 * This module is vscode-free (same pattern as engineWire.ts) so the record
 * bookkeeping and the resume decision are unit-testable in plain node.
 */

/** workspaceState key holding the surviving in-flight turn records. */
export const INTERRUPTED_TURNS_STORAGE_KEY = "ideAgent.interruptedTurns.v1";

/** Config section + key of the mirrored Cursor setting. */
export const CONTINUE_INTERRUPTED_SECTION = "ide.agent";
export const CONTINUE_INTERRUPTED_KEY = "continueInterruptedAgents";

/**
 * One in-flight agent turn. Written at turn start, cleared at turn settle;
 * a record still present at the next activation means the turn's process
 * died (reload/restart/crash) before it could settle.
 */
export interface InterruptedTurnRecord {
  /** Composer (chat tab) that owned the turn — observability only; ids do not survive a restart. */
  composerId: string;
  /** The prompt the interrupted turn was working on. */
  prompt: string;
  /** Epoch ms when the turn started. */
  startedAt: number;
}

function isRecord(value: unknown): value is InterruptedTurnRecord {
  if (!value || typeof value !== "object") {
    return false;
  }
  const o = value as Record<string, unknown>;
  return (
    typeof o.composerId === "string" &&
    o.composerId.length > 0 &&
    typeof o.prompt === "string" &&
    o.prompt.trim().length > 0 &&
    typeof o.startedAt === "number" &&
    Number.isFinite(o.startedAt)
  );
}

/**
 * Validate persisted state into a clean record list. Anything malformed
 * (older schema, hand-edited state, non-array) degrades to no records —
 * a corrupt record must never resurrect a phantom turn at startup.
 */
export function parseInterruptedTurnRecords(raw: unknown): InterruptedTurnRecord[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: InterruptedTurnRecord[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!isRecord(entry) || seen.has(entry.composerId)) {
      continue;
    }
    seen.add(entry.composerId);
    out.push({ composerId: entry.composerId, prompt: entry.prompt, startedAt: entry.startedAt });
  }
  return out;
}

/**
 * Record a turn start: one in-flight record per composer — a follow-up turn
 * replaces the composer's previous record (only the LATEST prompt is what a
 * resume should continue).
 */
export function recordTurnStarted(
  records: readonly InterruptedTurnRecord[],
  record: InterruptedTurnRecord,
): InterruptedTurnRecord[] {
  const rest = records.filter((r) => r.composerId !== record.composerId);
  return [...rest, { ...record }];
}

/** Record a turn settle: the composer's turn ended normally, so no resume. */
export function recordTurnSettled(
  records: readonly InterruptedTurnRecord[],
  composerId: string,
): InterruptedTurnRecord[] {
  return records.filter((r) => r.composerId !== composerId);
}

/**
 * The startup resume decision. Setting OFF → nothing resumes (the caller
 * still clears the records: they belong to a dead process and must not pile
 * up or fire later if the user re-enables the setting). Setting ON → every
 * surviving record resumes, oldest first (the order the turns started).
 */
export function selectTurnsToResume(
  records: readonly InterruptedTurnRecord[],
  enabled: boolean,
): InterruptedTurnRecord[] {
  if (!enabled) {
    return [];
  }
  return [...records].sort((a, b) => a.startedAt - b.startedAt);
}

/** Dependencies for the startup sweep — injected so it is node-testable. */
export interface InterruptedAgentsResumeDeps {
  /** Read `ide.agent.continueInterruptedAgents` (default true). */
  isEnabled(): boolean;
  /** Read the persisted records (already parsed/validated). */
  readRecords(): InterruptedTurnRecord[];
  /** Persist the (possibly emptied) record list. */
  writeRecords(records: InterruptedTurnRecord[]): void;
  /** Resume one interrupted turn (submit its prompt into a live composer). */
  resume(record: InterruptedTurnRecord): void;
  /** Diagnostics sink (the shared "IDE Agent" output channel in production). */
  log(line: string): void;
}

/**
 * Startup sweep: resume every turn a reload/restart interrupted, per the
 * setting. Records are cleared BEFORE resuming so a crash mid-sweep cannot
 * double-resume on the next start. Never throws — a resume failure must not
 * break extension activation.
 */
export function runInterruptedAgentsResume(deps: InterruptedAgentsResumeDeps): InterruptedTurnRecord[] {
  let records: InterruptedTurnRecord[];
  try {
    records = deps.readRecords();
  } catch {
    return [];
  }
  if (records.length === 0) {
    return [];
  }
  const enabled = deps.isEnabled();
  const toResume = selectTurnsToResume(records, enabled);
  try {
    deps.writeRecords([]);
  } catch {
    /* clearing is best-effort; resuming below is still correct */
  }
  if (!enabled) {
    deps.log(
      `[ide-agent] Continue Interrupted Agents is off — dropping ${records.length} interrupted turn record(s) without resuming.`,
    );
    return [];
  }
  for (const record of toResume) {
    try {
      deps.resume(record);
      deps.log(
        `[ide-agent] Continue Interrupted Agents: resumed turn for composer ${record.composerId} started at ${new Date(record.startedAt).toISOString()}.`,
      );
    } catch (err) {
      deps.log(
        `[ide-agent] Continue Interrupted Agents: failed to resume a turn (${err instanceof Error ? err.message : String(err)}).`,
      );
    }
  }
  return toResume;
}
