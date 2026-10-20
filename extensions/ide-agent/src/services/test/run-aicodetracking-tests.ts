/**
 * aiCodeTracking tests (node:test, vscode-free — the module under test
 * imports no `vscode`).
 *
 * Covers DD-SB-1..7: aggregation math, daily rollover, persistence
 * round-trip (workspace + global memento keys verbatim), reset command,
 * verbatim status-bar strings, and the commit-scoring pipeline
 * (merge/oversized/empty skips + attribution math).
 *
 * Run after `tsc`:  node --test out/services/test/run-aicodetracking-tests.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import {
  AiCodeTrackingService,
  AttributionReader,
  GitRunner,
  MementoLike,
  ScoredCommit,
  acceptanceRate,
  countLines,
  emptyDailyStats,
  formatComposerAria,
  formatComposerText,
  formatComposerTooltip,
  formatRecentCommitAria,
  formatRecentCommitText,
  formatRecentCommitTooltip,
  formatTabAria,
  formatTabText,
  formatTabTooltip,
  newPathOf,
  scoreCommit,
} from "../aiCodeTracking";

class FakeMemento implements MementoLike {
  private map = new Map<string, unknown>();
  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    if (this.map.has(key)) return this.map.get(key) as T;
    return defaultValue;
  }
  async update(key: string, value: unknown): Promise<void> {
    this.map.set(key, value);
  }
  has(key: string): boolean {
    return this.map.has(key);
  }
}

const tick = () => new Promise<void>((r) => setImmediate(r));

function serviceAt(
  ws: FakeMemento,
  gs: FakeMemento,
  y: number,
  m: number,
  d: number,
): AiCodeTrackingService {
  return new AiCodeTrackingService(ws, gs, () => new Date(y, m - 1, d, 12, 0, 0));
}

function fakeGit(scripts: Record<string, { stdout: string; code: number }>): GitRunner {
  return {
    run: async (args: string[], _cwd: string) => {
      const key = args.slice(0, 3).join(" ");
      const hit = scripts[key];
      if (!hit) throw new Error(`unexpected git call: ${args.join(" ")}`);
      return hit;
    },
  };
}

const META_KEY = "show -s --format=%H%x00%P%x00%cI%x00%s";
const NUMSTAT_KEY = "show --format= --numstat";
const DIFF_KEY = "show --format= -U0";

describe("countLines", () => {
  it("counts newline-separated lines, ignoring a trailing newline (diff-consistent)", () => {
    assert.strictEqual(countLines("foo"), 1);
    assert.strictEqual(countLines("a\nb\nc"), 3);
    assert.strictEqual(countLines("a\n"), 1);
    assert.strictEqual(countLines("a\nb\n"), 2);
    assert.strictEqual(countLines(""), 0);
    assert.strictEqual(countLines("\n"), 1);
  });
});

describe("acceptanceRate", () => {
  it("is 0 when nothing was suggested (Cursor: suggested > 0 ? ... : 0)", () => {
    assert.strictEqual(acceptanceRate(0, 0), 0);
    assert.strictEqual(acceptanceRate(5, 0), 0);
  });
  it("rounds half-up like Math.round", () => {
    assert.strictEqual(acceptanceRate(1, 2), 50);
    assert.strictEqual(acceptanceRate(1, 3), 33);
    assert.strictEqual(acceptanceRate(2, 3), 67);
    assert.strictEqual(acceptanceRate(3, 3), 100);
  });
});

describe("aggregation", () => {
  it("accumulates suggest/accept per source independently", () => {
    const s = serviceAt(new FakeMemento(), new FakeMemento(), 2026, 10, 19);
    s.recordSuggest("TAB", 10);
    s.recordSuggest("TAB", 5);
    s.recordAccept("TAB", 4);
    s.recordSuggest("COMPOSER", 20);
    s.recordAccept("COMPOSER", 20);
    const snap = s.snapshot();
    assert.strictEqual(snap.tabSuggested, 15);
    assert.strictEqual(snap.tabAccepted, 4);
    assert.strictEqual(snap.composerSuggested, 20);
    assert.strictEqual(snap.composerAccepted, 20);
    assert.strictEqual(s.tabAcceptance(), 27); // Math.round(4/15*100)
    assert.strictEqual(s.composerAcceptance(), 100);
  });

  it("ignores non-positive / non-finite line counts", () => {
    const s = serviceAt(new FakeMemento(), new FakeMemento(), 2026, 10, 19);
    s.recordSuggest("TAB", 0);
    s.recordSuggest("TAB", -3);
    s.recordSuggest("TAB", NaN);
    s.recordAccept("TAB", Infinity);
    assert.deepStrictEqual(s.snapshot(), emptyDailyStats("2026-10-19"));
  });

  it("fires onDidChange on every recorded event", () => {
    const s = serviceAt(new FakeMemento(), new FakeMemento(), 2026, 10, 19);
    let fires = 0;
    const sub = s.onDidChange(() => fires++);
    s.recordSuggest("TAB", 2);
    s.recordAccept("TAB", 1);
    s.recordSuggest("COMPOSER", 3);
    assert.strictEqual(fires, 3);
    sub.dispose();
    s.recordSuggest("TAB", 1);
    assert.strictEqual(fires, 3);
  });
});

describe("daily rollover", () => {
  it("resets counters when the date changes (Cursor: todayStats.date !== today)", async () => {
    const ws = new FakeMemento();
    const gs = new FakeMemento();
    const yesterday = serviceAt(ws, gs, 2026, 10, 18);
    yesterday.recordSuggest("TAB", 10);
    yesterday.recordAccept("TAB", 7);
    await tick();
    assert.ok(ws.has("aiCodeTracking.dailyStats.v1.5.2026-10-18"));

    const today = serviceAt(ws, gs, 2026, 10, 19);
    assert.deepStrictEqual(today.snapshot(), emptyDailyStats("2026-10-19"));
  });
});

describe("persistence round-trip", () => {
  it("restores today's counters from the workspace memento verbatim key", async () => {
    const ws = new FakeMemento();
    const gs = new FakeMemento();
    const s1 = serviceAt(ws, gs, 2026, 10, 19);
    s1.recordSuggest("TAB", 8);
    s1.recordAccept("TAB", 3);
    s1.recordSuggest("COMPOSER", 12);
    await tick();

    const s2 = serviceAt(ws, gs, 2026, 10, 19);
    const snap = s2.snapshot();
    assert.strictEqual(snap.tabSuggested, 8);
    assert.strictEqual(snap.tabAccepted, 3);
    assert.strictEqual(snap.composerSuggested, 12);
    assert.strictEqual(snap.composerAccepted, 0);
  });

  it("round-trips the recent commit through the global memento verbatim key", async () => {
    const ws = new FakeMemento();
    const gs = new FakeMemento();
    const s1 = serviceAt(ws, gs, 2026, 10, 19);
    const commit: ScoredCommit = {
      commitHash: "abc1234def",
      shortHash: "abc1234",
      commitMessage: "fix things",
      commitDate: "2026-10-19T00:00:00+07:00",
      aiPercentage: 78,
      tabLinesAdded: 5,
      tabLinesDeleted: 1,
      composerLinesAdded: 2,
      composerLinesDeleted: 0,
      linesAdded: 9,
      linesDeleted: 1,
      timestamp: 1,
    };
    let scored: ScoredCommit | undefined;
    s1.onDidScoreCommit((c) => (scored = c));
    s1.recordScoredCommit(commit);
    await tick();
    assert.deepStrictEqual(scored, commit);
    assert.ok(gs.has("aiCodeTracking.recentCommit"));

    const s2 = serviceAt(ws, gs, 2026, 10, 19);
    assert.deepStrictEqual(s2.getRecentCommit(), commit);
  });

  it("sanitizes corrupt persisted stats instead of throwing", () => {
    const ws = new FakeMemento();
    const gs = new FakeMemento();
    void ws.update("aiCodeTracking.dailyStats.v1.5.2026-10-19", {
      tabSuggested: "lots",
      tabAccepted: -5,
      composerSuggested: NaN,
    });
    const s = serviceAt(ws, gs, 2026, 10, 19);
    assert.deepStrictEqual(s.snapshot(), emptyDailyStats("2026-10-19"));
  });
});

describe("resetDailyStats (palette command)", () => {
  it("zeroes today's counters but keeps the recent commit + attribution", async () => {
    const ws = new FakeMemento();
    const gs = new FakeMemento();
    const s = serviceAt(ws, gs, 2026, 10, 19);
    s.recordSuggest("TAB", 10);
    s.recordAccept("TAB", 4);
    s.recordAcceptedLines("TAB", "src/a.ts", "const ai = 1;\n");
    const commit: ScoredCommit = {
      commitHash: "abc1234def",
      shortHash: "abc1234",
      commitMessage: "m",
      commitDate: "",
      aiPercentage: 50,
      tabLinesAdded: 1,
      tabLinesDeleted: 0,
      composerLinesAdded: 0,
      composerLinesDeleted: 0,
      linesAdded: 2,
      linesDeleted: 0,
      timestamp: 1,
    };
    s.recordScoredCommit(commit);
    await tick();

    let fires = 0;
    s.onDidChange(() => fires++);
    s.resetDailyStats();
    assert.deepStrictEqual(s.snapshot(), emptyDailyStats("2026-10-19"));
    assert.strictEqual(fires, 1);
    // Kept: recent commit (feeds the status item) and attribution (feeds scoring).
    assert.deepStrictEqual(s.getRecentCommit(), commit);
    assert.ok(s.hasLine("TAB", ["src/a.ts"], "const ai = 1;"));
  });
});

describe("attribution index", () => {
  it("matches normalized lines per source across candidate file keys", () => {
    const s = serviceAt(new FakeMemento(), new FakeMemento(), 2026, 10, 19);
    s.recordAcceptedLines("TAB", "src/a.ts", "  const x = 1;  \n\nconst y = 2;\n");
    s.recordAcceptedLines("COMPOSER", "src/a.ts", "const z = 3;\n");
    assert.ok(s.hasLine("TAB", ["other.ts", "src/a.ts"], "const x = 1;"));
    assert.ok(s.hasLine("TAB", ["a.ts"], "const y = 2;")); // basename candidate
    assert.ok(!s.hasLine("COMPOSER", ["src/a.ts"], "const x = 1;")); // source-separated
    assert.ok(s.hasLine("COMPOSER", ["src/a.ts"], "const z = 3;"));
    assert.ok(!s.hasLine("TAB", ["src/a.ts"], "")); // empties never match
    assert.ok(!s.hasLine("TAB", ["src/a.ts"], "const nope = 0;"));
  });
});

describe("verbatim status-bar strings (DIG-STATUSBAR-AI §1)", () => {
  const stats = {
    date: "2026-10-19",
    tabSuggested: 10,
    tabAccepted: 4,
    composerSuggested: 8,
    composerAccepted: 8,
  };
  it("tab item", () => {
    assert.strictEqual(formatTabText(stats), "Tab Stats: 4/10 (40%)");
    assert.strictEqual(
      formatTabAria(stats),
      "Tab AI Stats: 4 accepted out of 10 suggested, 40 percent acceptance rate",
    );
    assert.strictEqual(formatTabTooltip(stats), "Tab AI Stats (Today): 4/10 lines (40%)");
  });
  it("composer item", () => {
    assert.strictEqual(formatComposerText(stats), "Agent Stats: 8/8 (100%)");
    assert.strictEqual(
      formatComposerAria(stats),
      "Agent AI Stats: 8 accepted out of 8 suggested, 100 percent acceptance rate",
    );
    assert.strictEqual(formatComposerTooltip(stats), "Agent AI Stats (Today): 8/8 lines (100%)");
  });
  it("recent commit — empty state", () => {
    assert.strictEqual(formatRecentCommitText(undefined), "No commit scored");
    assert.strictEqual(formatRecentCommitAria(undefined), "No commit has been scored yet");
    assert.strictEqual(formatRecentCommitTooltip(undefined), "No commit has been scored yet");
  });
  it("recent commit — scored state (verbatim multi-line tooltip)", () => {
    const commit: ScoredCommit = {
      commitHash: "abc1234def5678",
      shortHash: "abc1234",
      // Note: char 40 of this message is a space — Cursor truncates with a raw
      // 40-char slice, so the tooltip keeps the trailing space verbatim.
      commitMessage: "add shiny feature that does things well indeed yes",
      commitDate: "",
      repoName: "demo",
      branchName: "main",
      aiPercentage: 78,
      tabLinesAdded: 5,
      tabLinesDeleted: 2,
      composerLinesAdded: 3,
      composerLinesDeleted: 1,
      linesAdded: 12,
      linesDeleted: 4,
      timestamp: 1,
    };
    assert.strictEqual(formatRecentCommitText(commit), "abc1234 78% AI");
    assert.strictEqual(
      formatRecentCommitAria(commit),
      "Most recent commit scored: abc1234, 78 percent AI-generated",
    );
    assert.strictEqual(
      formatRecentCommitTooltip(commit),
      [
        "Most Recent Commit Scored:",
        "abc1234",
        "add shiny feature that does things well ",
        "Repo: demo",
        "Branch: main",
        "========================================",
        "AI-Generated: 78% (11 lines)",
        "  - Tab: 7 lines (5 added, 2 deleted)",
        "  - Composer: 4 lines (3 added, 1 deleted)",
        "Total Changes: 12 added, 4 deleted",
      ].join("\n"),
    );
  });
  it("recent commit tooltip omits Repo/Branch lines when absent", () => {
    const commit: ScoredCommit = {
      commitHash: "abc1234",
      shortHash: "abc1234",
      commitMessage: "m",
      commitDate: "",
      aiPercentage: 0,
      tabLinesAdded: 0,
      tabLinesDeleted: 0,
      composerLinesAdded: 0,
      composerLinesDeleted: 0,
      linesAdded: 1,
      linesDeleted: 0,
      timestamp: 1,
    };
    const tip = formatRecentCommitTooltip(commit);
    assert.ok(!tip.includes("Repo:"));
    assert.ok(!tip.includes("Branch:"));
  });
});

describe("newPathOf", () => {
  it("resolves rename targets", () => {
    assert.strictEqual(newPathOf("src/a.ts"), "src/a.ts");
    assert.strictEqual(newPathOf("src/{old.ts => new.ts}"), "src/new.ts");
    assert.strictEqual(newPathOf("{a.ts => b.ts}"), "b.ts");
  });
});

describe("scoreCommit pipeline", () => {
  const meta = (parents: string, subject = "add feature") =>
    `abc1234def5678\x00${parents}\x002026-10-19T10:00:00+07:00\x00${subject}`;

  it("skips merge commits (parents > 1)", async () => {
    const git = fakeGit({ [META_KEY]: { stdout: meta("aaa111 bbb222"), code: 0 } });
    const attr: AttributionReader = { hasLine: () => false };
    const out = await scoreCommit({ repoPath: "/r", commitHash: "abc1234" }, attr, git);
    assert.strictEqual(out.kind, "skipped");
    if (out.kind === "skipped") assert.strictEqual(out.reason, "merge-commit");
  });

  it("skips oversized commits", async () => {
    const git = fakeGit({
      [META_KEY]: { stdout: meta("aaa111"), code: 0 },
      [NUMSTAT_KEY]: { stdout: "9000\t2000\tbig.ts\n", code: 0 },
    });
    const attr: AttributionReader = { hasLine: () => false };
    const out = await scoreCommit(
      { repoPath: "/r", commitHash: "abc1234", oversizedLineLimit: 100 },
      attr,
      git,
    );
    assert.strictEqual(out.kind, "skipped");
    if (out.kind === "skipped") assert.strictEqual(out.reason, "oversized-commit");
  });

  it("skips empty commits", async () => {
    const git = fakeGit({
      [META_KEY]: { stdout: meta("aaa111"), code: 0 },
      [NUMSTAT_KEY]: { stdout: "", code: 0 },
    });
    const attr: AttributionReader = { hasLine: () => false };
    const out = await scoreCommit({ repoPath: "/r", commitHash: "abc1234" }, attr, git);
    assert.strictEqual(out.kind, "skipped");
    if (out.kind === "skipped") assert.strictEqual(out.reason, "empty-commit");
  });

  it("skips unknown commits without throwing", async () => {
    const git = fakeGit({ [META_KEY]: { stdout: "", code: 1 } });
    const attr: AttributionReader = { hasLine: () => false };
    const out = await scoreCommit({ repoPath: "/r", commitHash: "nope" }, attr, git);
    assert.strictEqual(out.kind, "skipped");
    if (out.kind === "skipped") assert.strictEqual(out.reason, "not-found");
  });

  it("scores a normal commit with per-source attribution", async () => {
    const git = fakeGit({
      [META_KEY]: { stdout: meta("aaa111", "add feature"), code: 0 },
      [NUMSTAT_KEY]: { stdout: "3\t2\tsrc/a.ts\n", code: 0 },
      [DIFF_KEY]: {
        stdout: [
          "diff --git a/src/a.ts b/src/a.ts",
          "--- a/src/a.ts",
          "+++ b/src/a.ts",
          "@@ -1,2 +1,3 @@",
          " const keep = 1;",
          "+const tabLine = 2;",
          "+const composerLine = 3;",
          "-const manualOld = 0;",
          "-const deadAi = 9;",
          "",
        ].join("\n"),
        code: 0,
      },
    });
    const s = serviceAt(new FakeMemento(), new FakeMemento(), 2026, 10, 19);
    s.recordAcceptedLines("TAB", "src/a.ts", "const tabLine = 2;\n");
    s.recordAcceptedLines("COMPOSER", "src/a.ts", "const composerLine = 3;\nconst deadAi = 9;\n");

    const out = await scoreCommit(
      { repoPath: "/r", commitHash: "abc1234", repoName: "demo", branchName: "main" },
      s,
      git,
    );
    assert.strictEqual(out.kind, "scored");
    if (out.kind !== "scored") return;
    const c = out.commit;
    assert.strictEqual(c.shortHash, "abc1234");
    assert.strictEqual(c.tabLinesAdded, 1);
    assert.strictEqual(c.tabLinesDeleted, 0);
    assert.strictEqual(c.composerLinesAdded, 1);
    assert.strictEqual(c.composerLinesDeleted, 1); // deleted line was AI-generated
    assert.strictEqual(c.linesAdded, 3);
    assert.strictEqual(c.linesDeleted, 2);
    assert.strictEqual(c.aiPercentage, 60); // 3/5
    assert.strictEqual(c.repoName, "demo");
    assert.strictEqual(c.branchName, "main");
    assert.strictEqual(c.commitMessage, "add feature");
  });

  it("never throws on git runner failures", async () => {
    const git: GitRunner = {
      run: async () => {
        throw new Error("git exploded");
      },
    };
    const attr: AttributionReader = { hasLine: () => false };
    const out = await scoreCommit({ repoPath: "/r", commitHash: "abc1234" }, attr, git);
    assert.strictEqual(out.kind, "skipped");
    if (out.kind === "skipped") assert.strictEqual(out.reason, "git-error");
  });
});
