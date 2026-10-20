/**
 * MultitaskService — real Multitask orchestration (DEV-MULTITASK).
 *
 * Spec: docs/rea/dig-debug-multitask-2026-10-19.md §4 (M1, M2, M4).
 * Cursor's Multitask: mode=multitask (AgentMode 7) → the SERVER fans out
 * async subagents (TASK/CREATE_AGENT), each isolated in its own git
 * worktree under a unique filesystem-safe branch name, capped by
 * `agent.v1.AgentHostLocalSubagentLimits{max_running}`. Our engine has no
 * server-side fan-out, so the EXTENSION orchestrates: decompose →
 * per-subtask git worktrees → parallel engine worker sessions (capped at
 * MULTITASK_MAX_RUNNING) → branch+summary report-back → synthesis.
 *
 * The engine is a sidecar HTTP server; worker sessions are created with
 * `POST /api/session { title, location: { directory } }` (verified against
 * packages/protocol/src/groups/session.ts + packages/server/src/handlers/
 * session.ts: the payload field is `location: Location.PublicRef`, not a
 * bare `directory` — corrected here) and driven silently via
 * IdeCodeEngineAdapter.runWorkerTurn (no chat bubbles, no mode sessions).
 *
 * Worktrees are NEVER auto-deleted — the user merges them (like Cursor's
 * per-worker create-pull-requests flow); their paths are in the result.
 */
import { MULTITASK_MAX_RUNNING } from "./modeService";
import { WorktreeService } from "./worktreeService";

/**
 * The narrow engine surface MultitaskService needs. IdeCodeEngineAdapter
 * satisfies it structurally (public methods); tests inject a mock.
 */
export interface MultitaskEngine {
  createWorkerSession(directory: string, title: string): Promise<string>;
  runWorkerTurn(sessionID: string, prompt: string, opts?: { timeoutMs?: number }): Promise<string>;
}

export interface MultitaskCallbacks {
  /** Progress text — the composer appends it to the assistant bubble. */
  onProgress?: (text: string) => void;
  /** Cooperative abort, checked between phases and worker dispatches. */
  isAborted?: () => boolean;
}

/** One decomposed subtask (parsed from the decompose turn). */
export interface MultitaskSubtask {
  title: string;
  goal: string;
  scope: string;
}

/** What one worker did. `ok:false` = the worker threw/timed out. */
export interface SubtaskResult {
  title: string;
  branch: string;
  worktreePath: string;
  summary: string;
  filesChanged: string[];
  /** The worker's full final text (or the partial output on failure). */
  output: string;
  ok: boolean;
  error?: string;
}

export type OrchestrateResult =
  | { ok: true; subtasks: SubtaskResult[] }
  | { ok: false; reason: string };

export interface MultitaskServiceOptions {
  maxRunning?: number;
  decomposeTimeoutMs?: number;
  workerTimeoutMs?: number;
}

const DEFAULT_DECOMPOSE_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_WORKER_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Instructs the decomposer model to split the request into 2–6 independent
 * subtasks, outputting ONLY the machine-readable blocks. Pure const —
 * unit-tested (the model must not emit prose: the parser rejects anything
 * outside the blocks).
 */
export const DECOMPOSE_INSTRUCTION = [
  "You are the multitask ORCHESTRATOR's decomposer. Split the user's request below into 2-6 INDEPENDENT subtasks that can be worked on in parallel by separate workers, each in its own git worktree.",
  "",
  "Rules:",
  "- Each subtask MUST be doable in its own git worktree without touching files another subtask needs. If two pieces of work share files, merge them into ONE subtask.",
  "- Prefer 2-4 subtasks; never emit more than 6.",
  "- Output ONLY the subtask blocks — no prose, no markdown fences, no commentary, nothing before or after the blocks.",
  "",
  "Format (exactly, one block per subtask):",
  '<subtask title="short title"><goal>what this subtask must achieve (1-3 sentences)</goal><scope>the files/dirs it may touch and any explicit out-of-scope boundaries</scope></subtask>',
].join("\n");

/**
 * Worker framing. `{title}`/`{goal}`/`{scope}` are filled by
 * buildWorkerPrompt — kept as a const so the template is unit-testable.
 * The worker must END its response with the <worktree-report> block so the
 * orchestrator can parse branch+summary+files (spec §4.1: each worker
 * "reports branch + summary to parent").
 */
export const WORKER_INSTRUCTION = [
  "You are a multitask WORKER. Complete the subtask below and nothing else.",
  "",
  "Subtask: {title}",
  "Goal: {goal}",
  "Scope: {scope}",
  "",
  "Rules:",
  "- You are already inside a dedicated git worktree created for this subtask — work ONLY inside the current working directory. Do not read, write, or run commands outside it.",
  "- Make the minimal changes needed to achieve the goal.",
  "- Do not ask clarifying questions; use your best judgment and note assumptions in the summary.",
  "",
  "When you are done, END your response with this exact block (no markdown fences, nothing after it):",
  "<worktree-report><summary>1-3 sentences: what you did and the result</summary><files><file>path/of/changed/file</file></files></worktree-report>",
  "List one <file> entry per file you created or modified, with paths relative to the worktree root. If you changed no files, leave the <files> block empty.",
].join("\n");

/** Fill the WORKER_INSTRUCTION placeholders. Pure; unit-tested. */
export function buildWorkerPrompt(subtask: MultitaskSubtask): string {
  return WORKER_INSTRUCTION.replace("{title}", subtask.title)
    .replace("{goal}", subtask.goal)
    .replace("{scope}", subtask.scope);
}

const SUBTASK_RE =
  /<subtask\s+title="([^"]*)">\s*<goal>([\s\S]*?)<\/goal>\s*<scope>([\s\S]*?)<\/scope>\s*<\/subtask>/g;

/**
 * Parse decompose output into subtasks. Blocks with an empty title or goal
 * are dropped (a subtask with no goal cannot be dispatched). Returns []
 * when nothing parses — the caller falls back to a normal agent turn
 * (honest, never fake).
 */
export function parseSubtasks(text: string): MultitaskSubtask[] {
  const out: MultitaskSubtask[] = [];
  SUBTASK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SUBTASK_RE.exec(text)) !== null) {
    const title = m[1].trim();
    const goal = m[2].trim();
    const scope = m[3].trim();
    if (title.length > 0 && goal.length > 0) {
      out.push({ title, goal, scope });
    }
  }
  return out;
}

const REPORT_RE =
  /<worktree-report>\s*<summary>([\s\S]*?)<\/summary>\s*<files>([\s\S]*?)<\/files>\s*<\/worktree-report>/;
const FILE_RE = /<file>([\s\S]*?)<\/file>/g;

/**
 * Parse a worker's <worktree-report> block. Returns undefined when the
 * worker did not emit one — the caller falls back to the full output.
 */
export function parseWorktreeReport(text: string): { summary: string; filesChanged: string[] } | undefined {
  const m = REPORT_RE.exec(text);
  if (!m) {
    return undefined;
  }
  FILE_RE.lastIndex = 0;
  const filesChanged: string[] = [];
  let f: RegExpExecArray | null;
  while ((f = FILE_RE.exec(m[2])) !== null) {
    const p = f[1].trim();
    if (p.length > 0) {
      filesChanged.push(p);
    }
  }
  return { summary: m[1].trim(), filesChanged };
}

/**
 * Filesystem-safe slug for branch names (Cursor: unique branch, no "/").
 * Validated afterwards with WorktreeService.validateBranchName.
 */
export function slugifyForBranch(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "task"
  );
}

/** Tiny counting semaphore — the MULTITASK_MAX_RUNNING cap (spec §4 M2). */
class Semaphore {
  private running = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async acquire(): Promise<() => void> {
    if (this.running < this.max) {
      this.running += 1;
      return () => this.release();
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.running += 1;
    return () => this.release();
  }

  private release(): void {
    this.running -= 1;
    const next = this.waiters.shift();
    if (next) {
      next();
    }
  }
}

export class MultitaskService {
  private readonly maxRunning: number;
  private readonly decomposeTimeoutMs: number;
  private readonly workerTimeoutMs: number;

  constructor(
    private readonly engine: MultitaskEngine,
    private readonly worktree: WorktreeService = new WorktreeService(),
    opts: MultitaskServiceOptions = {},
  ) {
    this.maxRunning = opts.maxRunning ?? MULTITASK_MAX_RUNNING;
    this.decomposeTimeoutMs = opts.decomposeTimeoutMs ?? DEFAULT_DECOMPOSE_TIMEOUT_MS;
    this.workerTimeoutMs = opts.workerTimeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS;
  }

  /**
   * Full orchestration: decompose → worktrees → parallel workers → results.
   * `{ok:false}` is never faked — the caller falls back to a normal agent
   * turn (with wrapMultitaskPrompt) or surfaces the reason.
   */
  async orchestrate(request: string, callbacks: MultitaskCallbacks = {}): Promise<OrchestrateResult> {
    const onProgress = callbacks.onProgress ?? ((): void => undefined);
    const isAborted = callbacks.isAborted ?? ((): boolean => false);

    // Phase 1: need a git repo (worktrees are git-native; spec §4.1).
    const repoRoot = await this.worktree.getRepoRoot();
    if (!repoRoot) {
      return { ok: false, reason: "needs an open git repository" };
    }
    if (isAborted()) {
      return { ok: false, reason: "aborted" };
    }

    // Phase 2: decompose via a silent worker turn (no chat bubbles).
    onProgress("*Decomposing the request into parallel subtasks…*\n");
    let decomposeText: string;
    try {
      const decomposeSession = await this.engine.createWorkerSession(repoRoot, "multitask: decompose");
      decomposeText = await this.engine.runWorkerTurn(
        decomposeSession,
        `${DECOMPOSE_INSTRUCTION}\n\n---\n\nUser request:\n${request}`,
        { timeoutMs: this.decomposeTimeoutMs },
      );
    } catch (err) {
      return { ok: false, reason: `decompose turn failed: ${errMessage(err)}` };
    }
    const subtasks = parseSubtasks(decomposeText);
    if (subtasks.length === 0) {
      return { ok: false, reason: "could not decompose the request into subtasks" };
    }
    if (isAborted()) {
      return { ok: false, reason: "aborted" };
    }

    // Phase 3: one git worktree per subtask (spec §4.1 — unique
    // filesystem-safe branch name, no "/").
    const slug = slugifyForBranch(request);
    const prepared: Array<{ subtask: MultitaskSubtask; branch: string; worktreePath: string }> = [];
    for (let i = 0; i < subtasks.length; i++) {
      if (isAborted()) {
        return { ok: false, reason: "aborted" };
      }
      const branch = `multitask-${slug}-${i + 1}`;
      const invalid = this.worktree.validateBranchName(branch);
      if (invalid) {
        return { ok: false, reason: `invalid branch name for subtask "${subtasks[i].title}": ${invalid}` };
      }
      const dir = this.worktree.resolveWorktreePath(repoRoot, branch);
      onProgress(`*Creating worktree \`${branch}\`…*\n`);
      try {
        const wt = await this.worktree.create(repoRoot, dir, branch);
        prepared.push({ subtask: subtasks[i], branch, worktreePath: wt.path });
      } catch (err) {
        return {
          ok: false,
          reason: `failed to create worktree for "${subtasks[i].title}": ${errMessage(err)}`,
        };
      }
    }
    if (isAborted()) {
      return { ok: false, reason: "aborted" };
    }

    // Phase 4: dispatch workers, capped at maxRunning in flight (spec §4.2
    // AgentHostLocalSubagentLimits{max_running}). Workers run silently in
    // their own engine sessions scoped to the worktree directory.
    const sem = new Semaphore(this.maxRunning);
    const results: SubtaskResult[] = new Array(prepared.length);
    onProgress(`*Dispatching ${prepared.length} worker(s), up to ${this.maxRunning} in parallel…*\n`);
    await Promise.all(
      prepared.map(
        (p, i) =>
          (async (): Promise<void> => {
            const release = await sem.acquire();
            try {
              onProgress(`*Worker ${i + 1}/${prepared.length} (\`${p.branch}\`) started…*\n`);
              results[i] = await this.runWorker(p);
              onProgress(
                `*Worker ${i + 1}/${prepared.length} (\`${p.branch}\`) ${results[i].ok ? "done" : "failed"}.*\n`,
              );
            } finally {
              release();
            }
          })(),
      ),
    );

    const succeeded = results.filter((r) => r.ok).length;
    onProgress(`*Multitask finished: ${succeeded}/${results.length} subtask(s) succeeded.*\n`);
    return { ok: true, subtasks: results };
  }

  /** One worker: session in the worktree dir → turn → parse the report. */
  private async runWorker(p: {
    subtask: MultitaskSubtask;
    branch: string;
    worktreePath: string;
  }): Promise<SubtaskResult> {
    const base: Omit<SubtaskResult, "ok" | "summary" | "filesChanged" | "output"> = {
      title: p.subtask.title,
      branch: p.branch,
      worktreePath: p.worktreePath,
    };
    try {
      const sessionID = await this.engine.createWorkerSession(
        p.worktreePath,
        `multitask worker: ${p.subtask.title}`,
      );
      const output = await this.engine.runWorkerTurn(sessionID, buildWorkerPrompt(p.subtask), {
        timeoutMs: this.workerTimeoutMs,
      });
      const report = parseWorktreeReport(output);
      return {
        ...base,
        ok: true,
        summary: report?.summary ?? output.slice(0, 2000),
        filesChanged: report?.filesChanged ?? [],
        output,
      };
    } catch (err) {
      // Honest: keep whatever partial output the error carries, mark failed.
      const message = errMessage(err);
      return { ...base, ok: false, error: message, summary: `failed: ${message}`, filesChanged: [], output: message };
    }
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
