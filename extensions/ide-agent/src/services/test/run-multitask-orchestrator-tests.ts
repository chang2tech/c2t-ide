/**
 * Functional tests for the real Multitask orchestration (DEV-MULTITASK).
 *
 * Spec: docs/rea/dig-debug-multitask-2026-10-19.md §4 (M1, M2, M4) —
 * decompose → per-subtask git worktrees → parallel worker sessions capped
 * at MULTITASK_MAX_RUNNING (4) → branch+summary report-back → synthesis.
 *
 * node:test, zero extra deps. The `vscode` module is stubbed via
 * ./vscode-stub (imported FIRST). The engine and WorktreeService are
 * MOCKED — these tests never spawn the sidecar and never create real git
 * worktrees (a hard rule for this task).
 *
 * Run after `tsc`:  node --test out/services/test/run-multitask-orchestrator-tests.js
 */
import "./vscode-stub";
import { describe, it } from "node:test";
import * as assert from "node:assert";
import * as path from "node:path";
import { MULTITASK_MAX_RUNNING } from "../modeService";
import { WorktreeService, managedWorktreesRoot, type Worktree } from "../worktreeService";
import {
  DECOMPOSE_INSTRUCTION,
  WORKER_INSTRUCTION,
  buildWorkerPrompt,
  parseSubtasks,
  parseWorktreeReport,
  slugifyForBranch,
  MultitaskService,
  type MultitaskEngine,
  type OrchestrateResult,
} from "../multitaskService";

// ---------------------------------------------------------------------------
// Fakes — never touch the engine or git.
// ---------------------------------------------------------------------------

/** WorktreeService with git calls replaced by in-memory records. */
class FakeWorktreeService extends WorktreeService {
  repoRoot: string | undefined = "/fake/repo";
  readonly created: Array<{ dir: string; branch: string }> = [];

  override async getRepoRoot(): Promise<string | undefined> {
    return this.repoRoot;
  }

  // NOTE (DEV-GAPS-18-W3, 2026-10-20): the fake deliberately inherits the REAL
  // defaultWorktreePath()/resolveWorktreePath() from WorktreeService — the
  // legacy sibling `<repo>-worktrees/<slug>` convention is retired (see
  // worktreeService.ts evidence header). resolveWorktreePath() only calls
  // fs.existsSync on the fake legacy path (which never exists), so it never
  // spawns git and never touches the filesystem.

  override async create(repoRoot: string, dir: string, branch: string): Promise<Worktree> {
    this.created.push({ dir, branch });
    return {
      path: dir,
      head: "deadbee",
      branch,
      bare: false,
      detached: false,
      locked: false,
      prunable: false,
      isMain: false,
    };
  }
}

/** MultitaskEngine mock: tracks concurrent in-flight turns (cap test). */
class FakeEngine implements MultitaskEngine {
  /** What the decompose turn returns. */
  decomposeText = "";
  /** Per-worker outputs, in call order (fallback: a valid report block). */
  workerTexts: string[] = [];
  /** Throw from runWorkerTurn for the worker at this call index. */
  failWorkerAt: number | undefined = undefined;
  inFlight = 0;
  maxInFlight = 0;
  workerCalls = 0;

  async createWorkerSession(directory: string, title: string): Promise<string> {
    const safe = `${title}`.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase();
    return `sess-${safe}`;
  }

  async runWorkerTurn(sessionID: string, _prompt: string): Promise<string> {
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      // Small delay so parallel dispatches actually overlap.
      await new Promise((r) => setTimeout(r, 10));
      if (sessionID.includes("decompose")) {
        return this.decomposeText;
      }
      const idx = this.workerCalls++;
      if (this.failWorkerAt === idx) {
        throw new Error("worker blew up");
      }
      return (
        this.workerTexts[idx] ??
        `<worktree-report><summary>done ${idx}</summary><files><file>src/a${idx}.ts</file></files></worktree-report>`
      );
    } finally {
      this.inFlight -= 1;
    }
  }
}

const TWO_SUBTASKS = [
  '<subtask title="Add login form"><goal>Add a login form to the settings page with validation.</goal><scope>src/pages/settings/*</scope></subtask>',
  '<subtask title="Write tests"><goal>Cover the login form with unit tests.</goal><scope>src/pages/settings/*.test.*</scope></subtask>',
].join("\n");

function sixSubtasks(): string {
  return Array.from(
    { length: 6 },
    (_, i) =>
      `<subtask title="task ${i + 1}"><goal>do thing ${i + 1}</goal><scope>src/part${i + 1}/*</scope></subtask>`,
  ).join("\n");
}

function okOf(r: OrchestrateResult): Extract<OrchestrateResult, { ok: true }> {
  assert.strictEqual(r.ok, true, `expected ok:true, got ${JSON.stringify(r)}`);
  return r as Extract<OrchestrateResult, { ok: true }>;
}

// ---------------------------------------------------------------------------
// Pure parsing / instruction tests.
// ---------------------------------------------------------------------------

describe("parseSubtasks", () => {
  it("parses valid blocks", () => {
    const subs = parseSubtasks(TWO_SUBTASKS);
    assert.strictEqual(subs.length, 2);
    assert.strictEqual(subs[0].title, "Add login form");
    assert.strictEqual(subs[0].goal, "Add a login form to the settings page with validation.");
    assert.strictEqual(subs[0].scope, "src/pages/settings/*");
    assert.strictEqual(subs[1].title, "Write tests");
  });

  it("ignores surrounding prose", () => {
    const subs = parseSubtasks(`Here are the subtasks:\n${TWO_SUBTASKS}\nLet me know if that works.`);
    assert.strictEqual(subs.length, 2);
  });

  it("invalid output (no blocks) → empty", () => {
    assert.deepStrictEqual(parseSubtasks("I cannot split this request, it is one thing."), []);
  });

  it("empty string → empty", () => {
    assert.deepStrictEqual(parseSubtasks(""), []);
  });

  it("drops blocks with empty title or goal", () => {
    const subs = parseSubtasks(
      '<subtask title=""><goal>has goal but no title</goal><scope>x</scope></subtask>\n' +
        '<subtask title="t"><goal>   </goal><scope>x</scope></subtask>\n' +
        '<subtask title="kept"><goal>real</goal><scope>x</scope></subtask>',
    );
    assert.strictEqual(subs.length, 1);
    assert.strictEqual(subs[0].title, "kept");
  });
});

describe("parseWorktreeReport", () => {
  it("parses a valid report", () => {
    const r = parseWorktreeReport(
      "some prose\n<worktree-report><summary>Added the form and validation.</summary><files><file>src/a.ts</file><file>src/b.ts</file></files></worktree-report>",
    );
    assert.ok(r);
    assert.strictEqual(r.summary, "Added the form and validation.");
    assert.deepStrictEqual(r.filesChanged, ["src/a.ts", "src/b.ts"]);
  });

  it("missing report → undefined (caller falls back to full output)", () => {
    assert.strictEqual(parseWorktreeReport("just some text, no block"), undefined);
  });

  it("empty files block → empty list", () => {
    const r = parseWorktreeReport(
      "<worktree-report><summary>read-only research, no changes</summary><files></files></worktree-report>",
    );
    assert.ok(r);
    assert.deepStrictEqual(r.filesChanged, []);
  });
});

describe("instruction consts", () => {
  it("DECOMPOSE_INSTRUCTION demands 2-6 subtasks and ONLY the blocks", () => {
    assert.ok(DECOMPOSE_INSTRUCTION.includes("2-6"));
    assert.ok(/output only/i.test(DECOMPOSE_INSTRUCTION));
    assert.ok(DECOMPOSE_INSTRUCTION.includes("<subtask"));
  });

  it("buildWorkerPrompt fills the WORKER_INSTRUCTION placeholders", () => {
    const p = buildWorkerPrompt({ title: "T", goal: "G", scope: "S" });
    assert.ok(!p.includes("{title}") && !p.includes("{goal}") && !p.includes("{scope}"));
    assert.ok(p.includes("T") && p.includes("G") && p.includes("S"));
    assert.ok(p.includes("<worktree-report>"));
    assert.ok(WORKER_INSTRUCTION.includes("{title}"));
  });

  it("slugifyForBranch is filesystem-safe (no slashes)", () => {
    const s = slugifyForBranch("Add login: form & validation!!");
    assert.ok(!s.includes("/"));
    assert.ok(/^[a-z0-9-]+$/.test(s));
    assert.ok(s.length <= 32);
    assert.strictEqual(slugifyForBranch("!!!"), "task");
  });
});

// ---------------------------------------------------------------------------
// Orchestration tests (mocked engine + worktrees).
// ---------------------------------------------------------------------------

describe("MultitaskService.orchestrate", () => {
  it("no git repo → ok:false (never fake)", async () => {
    const wt = new FakeWorktreeService();
    wt.repoRoot = undefined;
    const svc = new MultitaskService(new FakeEngine(), wt);
    const r = await svc.orchestrate("do something");
    assert.strictEqual(r.ok, false);
    assert.ok((r as { reason: string }).reason.includes("git repository"));
  });

  it("zero parsed subtasks → ok:false (caller falls back)", async () => {
    const engine = new FakeEngine();
    engine.decomposeText = "This is really one indivisible task.";
    const svc = new MultitaskService(engine, new FakeWorktreeService());
    const r = await svc.orchestrate("do something");
    assert.strictEqual(r.ok, false);
    assert.ok((r as { reason: string }).reason.includes("decompose"));
  });

  it("decompose failure → ok:false", async () => {
    const engine = new FakeEngine();
    engine.decomposeText = "";
    // Force the decompose turn to throw.
    engine.runWorkerTurn = async () => {
      throw new Error("engine down");
    };
    const svc = new MultitaskService(engine, new FakeWorktreeService());
    const r = await svc.orchestrate("do something");
    assert.strictEqual(r.ok, false);
  });

  it("full happy path: worktrees + workers + report-backs", async () => {
    const engine = new FakeEngine();
    engine.decomposeText = TWO_SUBTASKS;
    const wt = new FakeWorktreeService();
    const progress: string[] = [];
    const svc = new MultitaskService(engine, wt);
    const r = okOf(await svc.orchestrate("add a login form", { onProgress: (t) => progress.push(t) }));

    assert.strictEqual(r.subtasks.length, 2);
    // One worktree per subtask, unique filesystem-safe branches (no "/").
    assert.strictEqual(wt.created.length, 2);
    const branches = wt.created.map((c) => c.branch);
    assert.ok(branches[0].startsWith("multitask-") && branches[0].endsWith("-1"));
    assert.ok(branches[1].endsWith("-2"));
    for (const b of branches) {
      assert.ok(!b.includes("/"), `branch must not contain "/": ${b}`);
      assert.strictEqual(wt.validateBranchName(b), undefined);
    }
    assert.notStrictEqual(branches[0], branches[1]);
    // New worktrees MUST be home-relative: ~/.ide-code/worktrees/<repo>/<slug>
    // (Cursor parity — the legacy sibling <repo>-worktrees/ layout is retired).
    const rootPrefix = managedWorktreesRoot() + path.sep;
    for (const c of wt.created) {
      assert.ok(
        c.dir.startsWith(rootPrefix),
        `worktree dir must live under ${managedWorktreesRoot()}: got ${c.dir}`,
      );
    }
    // Result carries branch + worktree path + parsed report.
    assert.strictEqual(r.subtasks[0].branch, branches[0]);
    assert.strictEqual(r.subtasks[0].worktreePath, wt.created[0].dir);
    assert.strictEqual(r.subtasks[0].ok, true);
    assert.strictEqual(r.subtasks[0].summary, "done 0");
    assert.deepStrictEqual(r.subtasks[0].filesChanged, ["src/a0.ts"]);
    // Progress was posted.
    assert.ok(progress.length > 0);
    // Worktrees are NOT deleted by the orchestrator (user merges).
    assert.strictEqual(wt.created.length, 2);
  });

  it("respects the MULTITASK_MAX_RUNNING=4 cap with 6 subtasks", async () => {
    assert.strictEqual(MULTITASK_MAX_RUNNING, 4);
    const engine = new FakeEngine();
    engine.decomposeText = sixSubtasks();
    const wt = new FakeWorktreeService();
    const svc = new MultitaskService(engine, wt, { maxRunning: MULTITASK_MAX_RUNNING });
    const r = okOf(await svc.orchestrate("six things at once"));
    assert.strictEqual(r.subtasks.length, 6);
    assert.strictEqual(wt.created.length, 6);
    // The cap: never more than 4 worker turns in flight at once…
    assert.ok(engine.maxInFlight <= 4, `cap violated: ${engine.maxInFlight} in flight`);
    // …and with 6 workers + 10ms overlap, the cap is actually exercised.
    assert.strictEqual(engine.maxInFlight, 4);
    // Every worker completed.
    assert.ok(r.subtasks.every((s) => s.ok));
  });

  it("worker failure is recorded honestly (ok:false, error kept)", async () => {
    const engine = new FakeEngine();
    engine.decomposeText = TWO_SUBTASKS;
    engine.failWorkerAt = 1;
    const svc = new MultitaskService(engine, new FakeWorktreeService());
    const r = okOf(await svc.orchestrate("two things"));
    assert.strictEqual(r.subtasks[0].ok, true);
    assert.strictEqual(r.subtasks[1].ok, false);
    assert.ok(r.subtasks[1].error?.includes("worker blew up"));
  });

  it("worker without a report block falls back to full output", async () => {
    const engine = new FakeEngine();
    engine.decomposeText = TWO_SUBTASKS;
    engine.workerTexts = ["plain text, no report block", "also plain"];
    const svc = new MultitaskService(engine, new FakeWorktreeService());
    const r = okOf(await svc.orchestrate("two things"));
    assert.strictEqual(r.subtasks[0].summary, "plain text, no report block");
    assert.deepStrictEqual(r.subtasks[0].filesChanged, []);
  });

  it("abort between phases → ok:false", async () => {
    const engine = new FakeEngine();
    engine.decomposeText = TWO_SUBTASKS;
    const svc = new MultitaskService(engine, new FakeWorktreeService());
    // Abort after decompose: isAborted flips once progress was posted.
    let calls = 0;
    const r = await svc.orchestrate("two things", {
      isAborted: () => ++calls > 1,
    });
    assert.strictEqual(r.ok, false);
  });
});
