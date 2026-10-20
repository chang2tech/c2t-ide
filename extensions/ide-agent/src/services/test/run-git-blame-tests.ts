/**
 * Unit tests for DEV-GAPS-76 / W76B `gitBlameService` — the REAL git blame
 * backend behind the Cursor Blame editors (feature-matrix
 * `cursor-blame-editor-view` R1).
 *
 * Fixtures are hand-written to the documented formats:
 *  - `git blame --porcelain`: header `<sha> <orig> <final> <count>`,
 *    metadata key/value lines (full metadata only on a commit's FIRST
 *    group), `filename`, then the TAB-prefixed content line.
 *  - `git blame --root --incremental` (Cursor's provider format,
 *    cursor-retrieval/dist/main.js `parseGitBlame` @1826156): same header
 *    shape, group flushed on `filename`.
 *  - `git log -L` with `--pretty=format:%H:_:%an:_:%ad:_:%s` (Cursor's
 *    `getGitLogForLine` @1821610).
 *
 * The service is driven through the REAL sanitized `gitExecFile` with its
 * spawner swapped for a recording fake (the `ext-git-sanitize` test seam),
 * so the tests also prove every blame argv carries the four safe `-c`
 * flags before the subcommand. No real git is spawned.
 *
 * Run after `tsc`:  node --test out/services/test/run-git-blame-tests.js
 */
import "./vscode-stub";
import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  parseGitBlamePorcelain,
  parseGitBlameIncremental,
  parseGitLogLineBlame,
  parseGitCommitMetadata,
  parseGitUnifiedDiff,
  parseFullCommitDiff,
  parseGitFullCommit,
  GIT_COMMIT_METADATA_SEPARATOR,
  GIT_FULL_COMMIT_DIFF_TOO_LARGE,
  GitBlameService,
} from "../gitBlameService";
import { __setGitSpawnerForTests, __resetGitSpawnerForTests } from "../gitExec";

const SHA_A = "9fceb02d0ae598e95dc970b74767f19372d61af8";
const SHA_B = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d";
const ZERO = "0000000000000000000000000000000000000000";

/**
 * Hand-written porcelain for a 5-line `src/a.ts`:
 *  lines 1-2 → SHA_A (one group of 2; metadata only on line 1's block),
 *  line 3    → SHA_B (boundary commit),
 *  line 4    → uncommitted (zero SHA, "Not Committed Yet"),
 *  line 5    → SHA_A again (later group, metadata served from the cache).
 */
const PORCELAIN = [
  `${SHA_A} 1 1 2`,
  "author Ada Lovelace",
  "author-mail <ada@example.com>",
  "author-time 1720000000",
  "author-tz +0700",
  "committer Ada Lovelace",
  "committer-mail <ada@example.com>",
  "committer-time 1720000100",
  "committer-tz +0700",
  "summary Fix the thing",
  "filename src/a.ts",
  "\tconst a = 1;",
  // Real-git continuation line (verified git 2.43, W76B-R 2026-10-20):
  // inside a group, later lines carry a 3-field header (no group count),
  // NO metadata and NO `filename` line — content follows directly.
  `${SHA_A} 2 2`,
  "\tconst b = 2;",
  `${SHA_B} 1 3 1`,
  "author Bob Martin",
  "author-mail <bob@example.com>",
  "author-time 1721000000",
  "author-tz +0000",
  "committer Bob Martin",
  "committer-mail <bob@example.com>",
  "committer-time 1721000000",
  "committer-tz +0000",
  "summary Add the third line",
  "boundary",
  "filename src/a.ts",
  "\tconst c = 3;",
  `${ZERO} 4 4 1`,
  "author Not Committed Yet",
  "author-mail <not.committed.yet>",
  "author-time 1722000000",
  "author-tz +0700",
  "committer Not Committed Yet",
  "committer-mail <not.committed.yet>",
  "committer-time 1722000000",
  "committer-tz +0700",
  "summary Version of src/a.ts from src/a.ts",
  "previous " + SHA_B + " src/a.ts",
  "filename src/a.ts",
  "\tconst d = 4;",
  `${SHA_A} 3 5 1`,
  "filename src/a.ts",
  "\tconst e = 5;",
  "",
].join("\n");

/** Same history in Cursor's `--incremental` stream shape. */
const INCREMENTAL = [
  `${SHA_A} 1 1 2`,
  "author Ada Lovelace",
  "author-mail <ada@example.com>",
  "author-time 1720000000",
  "author-tz +0700",
  "committer Ada Lovelace",
  "committer-mail <ada@example.com>",
  "committer-time 1720000100",
  "committer-tz +0700",
  "summary Fix the thing",
  "filename src/a.ts",
  `${SHA_B} 3 3 1`,
  "author Bob Martin",
  "author-mail <bob@example.com>",
  "author-time 1721000000",
  "author-tz +0000",
  "committer Bob Martin",
  "committer-mail <bob@example.com>",
  "committer-time 1721000000",
  "committer-tz +0000",
  "summary Add the third line",
  "filename src/a.ts",
  `${SHA_A} 3 5 1`,
  "author Ada Lovelace",
  "author-mail <ada@example.com>",
  "author-time 1720000000",
  "author-tz +0700",
  "committer Ada Lovelace",
  "committer-mail <ada@example.com>",
  "committer-time 1720000100",
  "committer-tz +0700",
  "summary Fix the thing",
  "filename src/a.ts",
  "",
].join("\n");

const REAL_SHA_A = "f9f7be98134a3753c20847e889497cd974c8b2d6";
const REAL_SHA_B = "5e33043e16e87aad13ad8723e874ffac49c99261";

/**
 * REGRESSION FIXTURE — copied VERBATIM from real `git blame --porcelain`
 * output (W76E-R2 / W76B-R, 2026-10-20, git 2.43.0). NOT hand-written.
 * Recipe used to generate it (temp repo):
 *   git init; user Ada Lovelace <ada@example.com>
 *   a.txt = "const a = 1;" / "const b = 2;" / "const c = 3;"
 *   GIT_AUTHOR_DATE=GIT_COMMITTER_DATE="2024-07-03T15:04:05+07:00"
 *     git commit -m "Fix the thing"
 *   user Bob Martin <bob@example.com>; line 3 changed to "const c = 33;"
 *   GIT_AUTHOR_DATE=GIT_COMMITTER_DATE="2024-07-10T15:04:05+07:00"
 *     git commit -m "Add the third line"
 *   append uncommitted line 4 "const d = 4;"
 *   git blame --porcelain -- a.txt   ← output below, byte for byte
 * (The zero-SHA block's author-time is the capture wall-clock; the two
 * commit SHAs are deterministic under the pinned dates above.)
 * NOTE line 2's header: `f9f7be98… 2 2` — THREE tokens, no group count,
 * no metadata, no filename. That is the shape that broke the old
 * 4-token-only header regex (W76E-R2 repro: 4-line file parsed to 3).
 */
const REAL_PORCELAIN = [
  `${REAL_SHA_A} 1 1 2`,
  "author Ada Lovelace",
  "author-mail <ada@example.com>",
  "author-time 1719993845",
  "author-tz +0700",
  "committer Ada Lovelace",
  "committer-mail <ada@example.com>",
  "committer-time 1719993845",
  "committer-tz +0700",
  "summary Fix the thing",
  "boundary",
  "filename a.txt",
  "\tconst a = 1;",
  `${REAL_SHA_A} 2 2`,
  "\tconst b = 2;",
  `${REAL_SHA_B} 3 3 1`,
  "author Bob Martin",
  "author-mail <bob@example.com>",
  "author-time 1720598645",
  "author-tz +0700",
  "committer Bob Martin",
  "committer-mail <bob@example.com>",
  "committer-time 1720598645",
  "committer-tz +0700",
  "summary Add the third line",
  `previous ${REAL_SHA_A} a.txt`,
  "filename a.txt",
  "\tconst c = 33;",
  `${ZERO} 4 4 1`,
  "author Not Committed Yet",
  "author-mail <not.committed.yet>",
  "author-time 1792495218",
  "author-tz +0000",
  "committer Not Committed Yet",
  "committer-mail <not.committed.yet>",
  "committer-time 1792495218",
  "committer-tz +0000",
  "summary Version of a.txt from a.txt",
  `previous ${REAL_SHA_B} a.txt`,
  "filename a.txt",
  "\tconst d = 4;",
  "",
].join("\n");

const REAL_ROOT_SHA = "5b6e0709c50f2c50fe47bea77a8b8f0d7f4de3c0";
const REAL_BOB_SHA = "4a5b00a6707c5f3ded38c6bcc142fc1c2f2c0dc0";

/**
 * Second VERBATIM real-git fixture (same capture session as above),
 * for the `boundary`-cache question raised by W76E-R2: a root commit
 * whose lines end up in TWO separated groups (lines 1 and 3, with a
 * Bob line between). Recipe: root commit by Ada (2024-07-03, pinned
 * dates) with three "root line …" lines, then Bob (2024-07-10) replaces
 * the middle line. Real git prints the root commit's metadata —
 * INCLUDING `boundary` — only on its FIRST group; the second group is
 * a bare header + content (no metadata, no filename, no boundary).
 */
const REAL_BOUNDARY_PORCELAIN = [
  `${REAL_ROOT_SHA} 1 1 1`,
  "author Ada Lovelace",
  "author-mail <ada@example.com>",
  "author-time 1719993845",
  "author-tz +0700",
  "committer Ada Lovelace",
  "committer-mail <ada@example.com>",
  "committer-time 1719993845",
  "committer-tz +0700",
  "summary root commit",
  "boundary",
  "filename f.txt",
  "\troot line one",
  `${REAL_BOB_SHA} 2 2 1`,
  "author Bob Martin",
  "author-mail <bob@example.com>",
  "author-time 1720598645",
  "author-tz +0700",
  "committer Bob Martin",
  "committer-mail <bob@example.com>",
  "committer-time 1720598645",
  "committer-tz +0700",
  "summary bob replaces middle",
  `previous ${REAL_ROOT_SHA} f.txt`,
  "filename f.txt",
  "\tbob middle line",
  `${REAL_ROOT_SHA} 3 3 1`,
  "\troot line three",
  "",
].join("\n");

const LOG_LINE = `${SHA_A}:_:Ada Lovelace:_:Wed Jul 3 15:04:05 2024 +0700:_:Fix the thing`;

const SEP = GIT_COMMIT_METADATA_SEPARATOR;
const SHOW_OUTPUT = [
  "Fix the thing",
  "Body of the commit",
  "Ada Lovelace",
  "Wed Jul 3 15:04:05 2024 +0700",
  "2024-07-03T15:04:05+07:00",
  `${SHA_B} ${SHA_A}`,
  "diff --git a/src/a.ts b/src/a.ts",
].join(SEP);

/**
 * DEV-GAPS-178 fixture: a realistic unified diff as printed by
 * `git show` — one modified file (2 changed lines, one context line, a
 * `\ No newline at end of file` marker) and one new file.
 */
const UNIFIED_DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,3 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  " const c = 4;",
  "\\ No newline at end of file",
  "diff --git a/src/new.ts b/src/new.ts",
  "new file mode 100644",
  "index 0000000..3333333",
  "--- /dev/null",
  "+++ b/src/new.ts",
  "@@ -0,0 +1,2 @@",
  "+export const x = 1;",
  "+export const y = 2;",
  "",
].join("\n");

/** DEV-GAPS-178 fixture: `getFullCommit` output — the SHOW_OUTPUT fields + the full patch as the 7th `<SEP>` field. */
const SHOW_FULL_OUTPUT = [
  "Fix the thing",
  "Body of the commit",
  "Ada Lovelace",
  "Wed Jul 3 15:04:05 2024 +0700",
  "2024-07-03T15:04:05+07:00",
  `${SHA_B} ${SHA_A}`,
  UNIFIED_DIFF,
].join(SEP);

describe("parseGitBlamePorcelain", () => {
  it("yields one entry per line with commit/author/authorTime/summary/lineNumber", () => {
    const lines = parseGitBlamePorcelain(PORCELAIN);
    assert.strictEqual(lines.length, 5);
    assert.deepStrictEqual(
      lines.map((l) => l.lineNumber),
      [1, 2, 3, 4, 5],
    );
    const first = lines[0]!;
    assert.strictEqual(first.commit, SHA_A);
    assert.strictEqual(first.author, "Ada Lovelace");
    assert.strictEqual(first.authorMail, "ada@example.com");
    assert.strictEqual(first.authorTime, 1720000000);
    assert.strictEqual(first.authorTz, "+0700");
    assert.strictEqual(first.committerTime, 1720000100);
    assert.strictEqual(first.summary, "Fix the thing");
    assert.strictEqual(first.filename, "src/a.ts");
    assert.strictEqual(first.originalLineNumber, 1);
    assert.strictEqual(first.content, "const a = 1;");
    assert.strictEqual(first.boundary, false);
  });

  it("reuses cached metadata for later groups of the same commit (porcelain prints it once)", () => {
    const second = parseGitBlamePorcelain(PORCELAIN)[1]!;
    assert.strictEqual(second.commit, SHA_A);
    assert.strictEqual(second.author, "Ada Lovelace");
    assert.strictEqual(second.authorTime, 1720000000);
    assert.strictEqual(second.summary, "Fix the thing");
    assert.strictEqual(second.content, "const b = 2;");
  });

  it("marks boundary commits and keeps the zero-SHA uncommitted line", () => {
    const lines = parseGitBlamePorcelain(PORCELAIN);
    assert.strictEqual(lines[2]!.commit, SHA_B);
    assert.strictEqual(lines[2]!.boundary, true);
    assert.strictEqual(lines[2]!.author, "Bob Martin");
    assert.strictEqual(lines[3]!.commit, ZERO);
    assert.strictEqual(lines[3]!.author, "Not Committed Yet");
    assert.strictEqual(lines[3]!.content, "const d = 4;");
    // line 5 is a later SHA_A group: metadata comes from the cache
    assert.strictEqual(lines[4]!.commit, SHA_A);
    assert.strictEqual(lines[4]!.author, "Ada Lovelace");
    assert.strictEqual(lines[4]!.summary, "Fix the thing");
  });

  it("returns [] for empty output", () => {
    assert.deepStrictEqual(parseGitBlamePorcelain(""), []);
    assert.deepStrictEqual(parseGitBlamePorcelain("\n"), []);
  });
});

describe("parseGitBlamePorcelain — regression on REAL git output (W76E-R2)", () => {
  it("keeps every line of a multi-line group whose continuation headers carry only 3 tokens", () => {
    const lines = parseGitBlamePorcelain(REAL_PORCELAIN);
    // The bug dropped line 2 (3-token continuation header): 4 → 3 lines.
    assert.strictEqual(lines.length, 4);
    assert.deepStrictEqual(
      lines.map((l) => l.lineNumber),
      [1, 2, 3, 4],
    );
    assert.deepStrictEqual(
      lines.map((l) => l.commit),
      [REAL_SHA_A, REAL_SHA_A, REAL_SHA_B, ZERO],
    );
    assert.deepStrictEqual(
      lines.map((l) => l.author),
      ["Ada Lovelace", "Ada Lovelace", "Bob Martin", "Not Committed Yet"],
    );
    assert.deepStrictEqual(
      lines.map((l) => l.content),
      ["const a = 1;", "const b = 2;", "const c = 33;", "const d = 4;"],
    );
    // Continuation line 2: metadata served from the per-commit cache.
    const second = lines[1]!;
    assert.strictEqual(second.authorTime, 1719993845);
    assert.strictEqual(second.summary, "Fix the thing");
    assert.strictEqual(second.filename, "a.txt");
    assert.strictEqual(second.originalLineNumber, 2);
    assert.strictEqual(lines[2]!.summary, "Add the third line");
    assert.strictEqual(lines[3]!.summary, "Version of a.txt from a.txt");
  });

  it("boundary is commit-level metadata git prints once — the cache propagation matches git, no leak (W76E-R2 check)", () => {
    const lines = parseGitBlamePorcelain(REAL_BOUNDARY_PORCELAIN);
    assert.strictEqual(lines.length, 3);
    // Root commit's second group arrives bare (header + content only);
    // author AND boundary both come from the cache, exactly like every
    // other commit field — git's print-once convention is commit-level,
    // so a later group of the same commit is the same boundary commit,
    // not a leak. A NON-boundary commit (Bob) stays false throughout.
    assert.deepStrictEqual(
      lines.map((l) => l.commit),
      [REAL_ROOT_SHA, REAL_BOB_SHA, REAL_ROOT_SHA],
    );
    assert.strictEqual(lines[0]!.boundary, true);
    assert.strictEqual(lines[1]!.boundary, false);
    assert.strictEqual(lines[2]!.boundary, true);
    assert.strictEqual(lines[2]!.author, "Ada Lovelace");
    assert.strictEqual(lines[2]!.summary, "root commit");
    // Same conclusion on the main real fixture: Ada's root-commit
    // continuation line is boundary, Bob's and the uncommitted line not.
    const main = parseGitBlamePorcelain(REAL_PORCELAIN);
    assert.deepStrictEqual(
      main.map((l) => l.boundary),
      [true, true, false, false],
    );
  });
});

describe("parseGitBlameIncremental (Cursor parseGitBlame, verbatim port)", () => {
  it("groups ranges by hash with authorName/authorEmail/authorDate(ms)/subject", () => {
    const groups = parseGitBlameIncremental(INCREMENTAL);
    assert.strictEqual(groups.length, 2);
    const a = groups.find((g) => g.hash === SHA_A)!;
    assert.strictEqual(a.authorName, "Ada Lovelace");
    assert.strictEqual(a.authorEmail, "ada@example.com");
    assert.strictEqual(a.authorDate, 1720000000000);
    assert.strictEqual(a.subject, "Fix the thing");
    assert.deepStrictEqual(a.ranges, [
      { startLineNumber: 1, endLineNumber: 2 },
      { startLineNumber: 5, endLineNumber: 5 },
    ]);
    const b = groups.find((g) => g.hash === SHA_B)!;
    assert.deepStrictEqual(b.ranges, [{ startLineNumber: 3, endLineNumber: 3 }]);
    assert.strictEqual(b.authorDate, 1721000000000);
  });

  it("agrees with the porcelain parse on commit/author/summary per line", () => {
    const perLine = parseGitBlamePorcelain(PORCELAIN);
    const groups = parseGitBlameIncremental(INCREMENTAL);
    for (const group of groups) {
      for (const range of group.ranges) {
        for (let n = range.startLineNumber; n <= range.endLineNumber; n++) {
          const line = perLine[n - 1]!;
          assert.strictEqual(line.commit, group.hash);
          assert.strictEqual(line.author, group.authorName);
          assert.strictEqual(line.summary, group.subject);
          assert.strictEqual(line.authorTime * 1000, group.authorDate);
        }
      }
    }
  });
});

describe("parseGitLogLineBlame (Cursor getGitLogForLine format)", () => {
  it("splits %H:_:%an:_:%ad:_:%s into {commit, author, date, message}", () => {
    assert.deepStrictEqual(parseGitLogLineBlame(LOG_LINE), [
      {
        commit: SHA_A,
        author: "Ada Lovelace",
        date: "Wed Jul 3 15:04:05 2024 +0700",
        message: "Fix the thing",
      },
    ]);
  });

  it("skips blank lines and returns [] for empty output", () => {
    assert.deepStrictEqual(parseGitLogLineBlame(""), []);
    assert.deepStrictEqual(parseGitLogLineBlame("\n\n"), []);
  });
});

interface RecordedSpawn {
  file: string;
  args: string[];
  opts: { cwd: string; timeout: number; maxBuffer: number };
}

let recorded: RecordedSpawn[];
let inRepo: boolean;
/**
 * W80D shallow fixture: when set, the fake spawner reports the repo as
 * shallow (`true` + the relative `--git-path shallow` answer real git
 * prints at a repo root) and `--show-toplevel` resolves to a REAL temp
 * directory on disk that contains a REAL `.git/shallow` file (written by
 * `makeShallowRepo` below). `GitBlameService` reads that file with the
 * real `fs.readFile` — only the git process itself is faked, exactly
 * like every other test in this file.
 */
let shallowRoot: string | undefined;

function makeShallowRepo(hashes: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-blame-shallow-"));
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  // Real `.git/shallow` format: one full 40-hex boundary commit per line.
  fs.writeFileSync(path.join(root, ".git", "shallow"), hashes.join("\n") + "\n", "utf8");
  shallowRoot = root;
  return root;
}

/**
 * W82D regression fixture: a shallow repo root whose `.git/shallow` file
 * is MISSING, so the service's real `fs.readFile` fails (ENOENT) AFTER
 * the fake git process has already reported `--is-shallow-repository`
 * as `true` (the spawner keys that answer off `shallowRoot` alone).
 */
function makeShallowRepoWithMissingShallowFile(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-blame-shallow-missing-"));
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  // Deliberately NO `.git/shallow` file written.
  shallowRoot = root;
  return root;
}

beforeEach(() => {
  recorded = [];
  inRepo = true;
  shallowRoot = undefined;
  __setGitSpawnerForTests(async (file, args, opts) => {
    recorded.push({ file, args: [...args], opts });
    if (!inRepo) {
      throw new Error("fatal: not a git repository (or any of the parent directories): .git");
    }
    if (args.includes("--show-toplevel")) {
      return { stdout: `${shallowRoot ?? "/repo"}\n`, stderr: "" };
    }
    if (args.includes("--is-shallow-repository")) {
      if (shallowRoot) {
        return { stdout: "true\n.git/shallow\n", stderr: "" };
      }
      return { stdout: "false\n", stderr: "" };
    }
    if (args.includes("--porcelain")) {
      return { stdout: PORCELAIN, stderr: "" };
    }
    if (args.includes("--incremental")) {
      return { stdout: INCREMENTAL, stderr: "" };
    }
    if (args.includes("log")) {
      return { stdout: LOG_LINE, stderr: "" };
    }
    if (args.includes("show")) {
      return { stdout: SHOW_OUTPUT, stderr: "" };
    }
    throw new Error(`unexpected git argv: ${args.join(" ")}`);
  });
});

afterEach(() => {
  __resetGitSpawnerForTests();
  if (shallowRoot) {
    fs.rmSync(shallowRoot, { recursive: true, force: true });
    shallowRoot = undefined;
  }
});

describe("GitBlameService (mock gitExec via the gitExec spawner seam)", () => {
  const service = new GitBlameService();

  it("getGitRoot returns the trimmed rev-parse --show-toplevel output", async () => {
    assert.strictEqual(await service.getGitRoot("/repo/src"), "/repo");
    const call = recorded.find((r) => r.args.includes("--show-toplevel"))!;
    assert.strictEqual(call.opts.cwd, "/repo/src");
  });

  it("getGitRoot resolves undefined outside a git repository", async () => {
    inRepo = false;
    assert.strictEqual(await service.getGitRoot("/nowhere"), undefined);
  });

  it("getFileBlame runs sanitized `blame --porcelain -- <relPath>` at the repo root", async () => {
    const lines = await service.getFileBlame("/repo/src/a.ts");
    assert.ok(lines);
    assert.strictEqual(lines.length, 5);
    assert.strictEqual(lines[0]!.summary, "Fix the thing");
    const call = recorded.find((r) => r.args.includes("--porcelain"))!;
    assert.strictEqual(call.opts.cwd, "/repo");
    // the four safe -c configs from gitExec precede the subcommand
    assert.ok(call.args.indexOf("blame") > call.args.indexOf("core.attributesFile=/dev/null"));
    assert.deepStrictEqual(call.args.slice(call.args.indexOf("blame")), [
      "blame",
      "--porcelain",
      "--",
      "src/a.ts",
    ]);
  });

  it("getFileBlame passes the revision through when given", async () => {
    await service.getFileBlame("/repo/src/a.ts", "HEAD~1");
    const call = recorded.find((r) => r.args.includes("--porcelain"))!;
    assert.deepStrictEqual(call.args.slice(call.args.indexOf("blame")), [
      "blame",
      "--porcelain",
      "HEAD~1",
      "--",
      "src/a.ts",
    ]);
  });

  it("getFileBlame resolves undefined outside a git repository", async () => {
    inRepo = false;
    assert.strictEqual(await service.getFileBlame("/nowhere/a.ts"), undefined);
  });

  it("getFileLineBlame uses Cursor's verbatim --root --incremental argv", async () => {
    const result = await service.getFileLineBlame("/repo/src/a.ts");
    assert.ok(result);
    assert.strictEqual(result.isRepositoryShallow, false);
    assert.strictEqual(result.blameInformation.length, 2);
    const call = recorded.find((r) => r.args.includes("--incremental"))!;
    assert.deepStrictEqual(call.args.slice(call.args.indexOf("blame")), [
      "blame",
      "--root",
      "--incremental",
      "--",
      "src/a.ts",
    ]);
  });

  it("getFileLineBlame adds -w only when ignoreWhitespace is set (Cursor: git.blame.ignoreWhitespace)", async () => {
    await service.getFileLineBlame("/repo/src/a.ts", undefined, { ignoreWhitespace: true });
    const call = recorded.find((r) => r.args.includes("--incremental"))!;
    assert.deepStrictEqual(call.args.slice(call.args.indexOf("blame")), [
      "blame",
      "--root",
      "--incremental",
      "-w",
      "--",
      "src/a.ts",
    ]);
  });

  // W80D — shallow=true branch of getFileLineBlame (previously untested:
  // the only shallow assertion in this file was isRepositoryShallow=false).
  // The service's shallow path is Cursor's readRepositoryShallowInfo: one
  // `rev-parse --is-shallow-repository --git-path shallow` call, then the
  // named `.git/shallow` file is read from disk and every blame group
  // whose hash it lists gets isShallowBoundary=true. These tests use a
  // REAL temp repo root with a REAL `.git/shallow` file (see
  // makeShallowRepo), so the readFile + relative-path join + 40-hex line
  // filter all run for real; only the git process is faked.
  it("getFileLineBlame (shallow=true) flags the boundary commit listed in .git/shallow", async () => {
    const root = makeShallowRepo([SHA_A]);
    const result = await service.getFileLineBlame(`${root}/src/a.ts`);
    assert.ok(result);
    assert.strictEqual(result.isRepositoryShallow, true);
    assert.strictEqual(result.blameInformation.length, 2);
    const a = result.blameInformation.find((g) => g.hash === SHA_A)!;
    const b = result.blameInformation.find((g) => g.hash === SHA_B)!;
    // SHA_A is the shallow boundary commit; SHA_B is not in .git/shallow.
    assert.strictEqual(a.isShallowBoundary, true);
    assert.strictEqual(b.isShallowBoundary, undefined);
    // Both of SHA_A's ranges belong to the one flagged group (grouped by hash).
    assert.deepStrictEqual(a.ranges, [
      { startLineNumber: 1, endLineNumber: 2 },
      { startLineNumber: 5, endLineNumber: 5 },
    ]);
    // Cursor's verbatim shallow-info argv, run at the (real) repo root.
    const shallowCall = recorded.find((r) => r.args.includes("--is-shallow-repository"))!;
    assert.strictEqual(shallowCall.opts.cwd, root);
    assert.deepStrictEqual(shallowCall.args.slice(shallowCall.args.indexOf("rev-parse")), [
      "rev-parse",
      "--is-shallow-repository",
      "--git-path",
      "shallow",
    ]);
  });

  it("getFileLineBlame (shallow=true) flags only the listed hash — the flag is per-commit, not repo-wide", async () => {
    const root = makeShallowRepo([SHA_B]);
    const result = await service.getFileLineBlame(`${root}/src/a.ts`);
    assert.ok(result);
    assert.strictEqual(result.isRepositoryShallow, true);
    const a = result.blameInformation.find((g) => g.hash === SHA_A)!;
    const b = result.blameInformation.find((g) => g.hash === SHA_B)!;
    assert.strictEqual(a.isShallowBoundary, undefined);
    assert.strictEqual(b.isShallowBoundary, true);
  });

  // W82D regression: the old code had ONE catch around both the
  // rev-parse flag parse AND the `.git/shallow` readFile, resetting
  // `isRepositoryShallow = false` on ANY failure — so a readFile error
  // after the flag had already parsed as `true` silently reported a
  // shallow repo as not shallow. The fix keeps the parsed flag: the
  // repo IS shallow, only the boundary list is unknown.
  it("getFileLineBlame (shallow=true) keeps isRepositoryShallow=true when reading .git/shallow fails after the flag parsed true", async () => {
    const root = makeShallowRepoWithMissingShallowFile();
    const result = await service.getFileLineBlame(`${root}/src/a.ts`);
    assert.ok(result);
    assert.strictEqual(result.isRepositoryShallow, true);
    // Blame data is still returned, and with the boundary list unknown
    // no group can be flagged.
    assert.strictEqual(result.blameInformation.length, 2);
    for (const group of result.blameInformation) {
      assert.strictEqual(group.isShallowBoundary, undefined);
    }
  });

  it("getFileLineBlame (shallow=true) with a .git/shallow listing no blamed commit flags nothing but still reports shallow", async () => {
    // A boundary commit that is not an author of this file (e.g. the
    // shallow cut landed on another branch's history).
    const root = makeShallowRepo(["ffffffffffffffffffffffffffffffffffffffff"]);
    const result = await service.getFileLineBlame(`${root}/src/a.ts`);
    assert.ok(result);
    assert.strictEqual(result.isRepositoryShallow, true);
    assert.strictEqual(result.blameInformation.length, 2);
    for (const group of result.blameInformation) {
      assert.strictEqual(group.isShallowBoundary, undefined);
    }
  });

  it("getLineBlame uses Cursor's verbatim log -L argv and parses commits[0] for viewCommit", async () => {
    const result = await service.getLineBlame("/repo/src/a.ts", 1, 1);
    assert.ok(result);
    assert.strictEqual(result.commits.length, 1);
    assert.strictEqual(result.commits[0]!.commit, SHA_A);
    assert.strictEqual(result.commits[0]!.author, "Ada Lovelace");
    assert.strictEqual(result.commits[0]!.message, "Fix the thing");
    const call = recorded.find((r) => r.args.includes("log"))!;
    assert.strictEqual(call.opts.cwd, "/repo");
    assert.deepStrictEqual(call.args.slice(call.args.indexOf("--no-pager")), [
      "--no-pager",
      "log",
      "-L",
      "1,1:src/a.ts",
      "--pretty=format:%H:_:%an:_:%ad:_:%s",
      "--no-patch",
      "-n",
      "1",
    ]);
  });

  it("getLineBlame resolves undefined outside a git repository (workbench maps this to 'No git repository found')", async () => {
    inRepo = false;
    assert.strictEqual(await service.getLineBlame("/nowhere/a.ts", 1, 1), undefined);
  });

  it("getCommitMetadata uses Cursor's verbatim git show argv and parses the fields openCommit reads", async () => {
    const meta = await service.getCommitMetadata("/repo", SHA_A);
    assert.ok(meta);
    assert.strictEqual(meta.sha, SHA_A);
    assert.strictEqual(meta.message, "Fix the thing");
    assert.strictEqual(meta.description, "Body of the commit");
    assert.strictEqual(meta.author, "Ada Lovelace");
    assert.strictEqual(meta.date, "Wed Jul 3 15:04:05 2024 +0700");
    assert.strictEqual(meta.committerDate, "2024-07-03T15:04:05+07:00");
    assert.deepStrictEqual(meta.parents, [SHA_B, SHA_A]);
    const call = recorded.find((r) => r.args.includes("show"))!;
    assert.deepStrictEqual(call.args.slice(call.args.indexOf("show")), [
      "show",
      "-m",
      `--pretty=format:%s${SEP}%b${SEP}%an${SEP}%ad${SEP}%cI${SEP}%P${SEP}`,
      SHA_A,
    ]);
  });

  it("getCommitMetadata resolves undefined when git fails (workbench keeps Cursor's empty subject/message fallback)", async () => {
    inRepo = false;
    assert.strictEqual(await service.getCommitMetadata("/nowhere", SHA_A), undefined);
  });
});

describe("parseGitCommitMetadata", () => {
  it("splits on Cursor's <|ENT|><|RY|> separator in %s/%b/%an/%ad/%cI/%P order", () => {
    const meta = parseGitCommitMetadata(SHOW_OUTPUT, SHA_A);
    assert.strictEqual(meta.message, "Fix the thing");
    assert.strictEqual(meta.description, "Body of the commit");
    assert.strictEqual(meta.author, "Ada Lovelace");
    assert.deepStrictEqual(meta.parents, [SHA_B, SHA_A]);
  });

  it("yields empty parents for a root commit", () => {
    const meta = parseGitCommitMetadata(["S", "", "A", "D", "C", "", "diff"].join(SEP), SHA_A);
    assert.deepStrictEqual(meta.parents, []);
  });
});

describe("parseGitUnifiedDiff (DEV-GAPS-178, Cursor parse-diff port)", () => {
  it("parses files, chunks and add/del counts with marker-prefixed contents", () => {
    const files = parseGitUnifiedDiff(UNIFIED_DIFF);
    assert.strictEqual(files.length, 2);
    const modified = files[0]!;
    assert.strictEqual(modified.from, "src/a.ts");
    assert.strictEqual(modified.to, "src/a.ts");
    assert.strictEqual(modified.additions, 1);
    assert.strictEqual(modified.deletions, 1);
    assert.strictEqual(modified.chunks.length, 1);
    const chunk = modified.chunks[0]!;
    assert.strictEqual(chunk.oldStart, 1);
    assert.strictEqual(chunk.oldLines, 3);
    assert.strictEqual(chunk.newStart, 1);
    assert.strictEqual(chunk.newLines, 3);
    // Change contents keep their leading marker char (the pane strips it).
    assert.deepStrictEqual(
      chunk.changes.map((c) => `${c.type}:${c.content}`),
      ["normal: const a = 1;", "del:-const b = 2;", "add:+const b = 3;", "normal: const c = 4;", "normal:\\ No newline at end of file"],
    );
  });

  it("flags new files (from /dev/null) and counts their additions", () => {
    const created = parseGitUnifiedDiff(UNIFIED_DIFF)[1]!;
    assert.strictEqual(created.new, true);
    assert.strictEqual(created.from, "/dev/null");
    assert.strictEqual(created.to, "src/new.ts");
    assert.strictEqual(created.additions, 2);
    assert.strictEqual(created.deletions, 0);
    assert.strictEqual(created.chunks[0]!.oldLines, 0);
    assert.strictEqual(created.chunks[0]!.newLines, 2);
  });

  it("flags deleted files (to /dev/null)", () => {
    const files = parseGitUnifiedDiff(
      [
        "diff --git a/src/old.ts b/src/old.ts",
        "deleted file mode 100644",
        "index 4444444..0000000",
        "--- a/src/old.ts",
        "+++ /dev/null",
        "@@ -1,1 +0,0 @@",
        "-gone",
        "",
      ].join("\n"),
    );
    assert.strictEqual(files.length, 1);
    assert.strictEqual(files[0]!.deleted, true);
    assert.strictEqual(files[0]!.to, "/dev/null");
    assert.strictEqual(files[0]!.deletions, 1);
  });

  it("returns [] for empty or whitespace-only input (parse-diff verbatim)", () => {
    assert.deepStrictEqual(parseGitUnifiedDiff(""), []);
    assert.deepStrictEqual(parseGitUnifiedDiff("  \n  "), []);
  });

  it("parseFullCommitDiff returns the verbatim placeholder above 5,000,000 chars (pce)", () => {
    const huge = "diff --git a/x b/x\n" + "+line\n".repeat(900_000);
    assert.ok(huge.length > 5_000_000);
    assert.strictEqual(parseFullCommitDiff(huge), GIT_FULL_COMMIT_DIFF_TOO_LARGE);
    assert.strictEqual(GIT_FULL_COMMIT_DIFF_TOO_LARGE[0]!.to, "Diff to large to display");
    // At/under the limit the real parser runs.
    assert.strictEqual(parseFullCommitDiff(UNIFIED_DIFF).length, 2);
  });
});

describe("parseGitFullCommit (DEV-GAPS-178)", () => {
  it("parses metadata fields and the parsed diff from the 7th <SEP> field", () => {
    const full = parseGitFullCommit(SHOW_FULL_OUTPUT, SHA_A);
    assert.strictEqual(full.sha, SHA_A);
    assert.strictEqual(full.message, "Fix the thing");
    assert.strictEqual(full.description, "Body of the commit");
    assert.strictEqual(full.author, "Ada Lovelace");
    assert.strictEqual(full.date, "Wed Jul 3 15:04:05 2024 +0700");
    assert.strictEqual(full.committerDate, "2024-07-03T15:04:05+07:00");
    assert.deepStrictEqual(full.parents, [SHA_B, SHA_A]);
    assert.strictEqual(full.diff.length, 2);
    assert.strictEqual(full.diff[0]!.additions, 1);
  });

  it("split(SEP, 7) truncates a patch containing the separator (binary-verbatim limit)", () => {
    const withSep = ["S", "", "A", "D", "C", "", `diff --git a/x b/x${SEP}trailing`].join(SEP);
    const full = parseGitFullCommit(withSep, SHA_A);
    assert.strictEqual(full.diff.length, 1);
    assert.strictEqual(full.diff[0]!.to, "x");
  });
});

describe("GitBlameService.getFullCommit / getFileContentAtRevision (DEV-GAPS-178)", () => {
  const service = new GitBlameService();

  function installSpawner(showBehavior: "full" | "overflow-then-metadata") {
    let showCalls = 0;
    __setGitSpawnerForTests(async (file, args, opts) => {
      recorded.push({ file, args: [...args], opts });
      if (args.includes("--show-toplevel")) {
        return { stdout: "/repo\n", stderr: "" };
      }
      if (args.includes("show")) {
        showCalls++;
        const revPathArg = args.find((a) => a.includes(":") && a.endsWith(".ts") && !a.startsWith("--pretty"));
        if (revPathArg) {
          return { stdout: "export const atRev = true;\n", stderr: "" };
        }
        if (showBehavior === "overflow-then-metadata" && showCalls === 1) {
          throw Object.assign(new Error("stdout maxBuffer exceeded"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
        }
        return { stdout: showBehavior === "full" ? SHOW_FULL_OUTPUT : SHOW_OUTPUT, stderr: "" };
      }
      throw new Error(`unexpected git argv: ${args.join(" ")}`);
    });
  }

  it("getFullCommit runs Cursor's verbatim show argv with the 30MB maxBuffer and parses metadata + diff", async () => {
    installSpawner("full");
    const full = await service.getFullCommit("/repo", SHA_A);
    assert.ok(full);
    assert.strictEqual(full.message, "Fix the thing");
    assert.strictEqual(full.diff.length, 2);
    assert.strictEqual(full.diffOmitted, undefined);
    const call = recorded.find((r) => r.args.includes("show"))!;
    assert.deepStrictEqual(call.args.slice(call.args.indexOf("show")), [
      "show",
      "-m",
      `--pretty=format:%s${SEP}%b${SEP}%an${SEP}%ad${SEP}%cI${SEP}%P${SEP}`,
      SHA_A,
    ]);
    assert.strictEqual(call.opts.maxBuffer, 31457280);
  });

  it("getFullCommit falls back to metadata-only (diffOmitted) on maxBuffer overflow, like Cursor's provider", async () => {
    installSpawner("overflow-then-metadata");
    const full = await service.getFullCommit("/repo", SHA_A);
    assert.ok(full);
    assert.strictEqual(full.message, "Fix the thing");
    assert.deepStrictEqual(full.diff, []);
    assert.strictEqual(full.diffOmitted, true);
  });

  it("getFullCommit resolves undefined when git fails", async () => {
    inRepo = false;
    assert.strictEqual(await service.getFullCommit("/nowhere", SHA_A), undefined);
  });

  it("getFileContentAtRevision runs `git show <rev>:<relPath>` at the repo root", async () => {
    installSpawner("full");
    const content = await service.getFileContentAtRevision("/repo/src/a.ts", "HEAD~1");
    assert.strictEqual(content, "export const atRev = true;\n");
    const call = recorded.find((r) => r.args.some((a) => a === "HEAD~1:src/a.ts"))!;
    assert.strictEqual(call.opts.cwd, "/repo");
  });

  it("getFileContentAtRevision resolves undefined outside a git repository", async () => {
    inRepo = false;
    assert.strictEqual(await service.getFileContentAtRevision("/nowhere/a.ts", "HEAD~1"), undefined);
  });
});
