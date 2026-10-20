/**
 * instantGrepService tests (node:test, vscode stubbed).
 *
 * The service shells out to the engine's slim indexing CLI; here the process
 * runner is swapped for a fake so the tests pin arg-building, JSON parsing,
 * failure→[] honesty, and the short-lived cache — without spawning bun.
 *
 * Run after `tsc`:  node out/services/test/run-instant-grep-tests.js
 */
import { describe, it, beforeEach } from "node:test";
import * as assert from "node:assert";
import "./vscode-stub";
import { vscodeStub } from "./vscode-stub";
import {
  instantGrep,
  __setInstantGrepRunnerForTests,
  __resetInstantGrepRunnerForTests,
  __clearInstantGrepCacheForTests,
} from "../instantGrepService";

// Point the stub at a fake workspace root so the result cache engages
// (it is skipped when no workspace folder is open).
(vscodeStub as { workspace: unknown }).workspace = {
  getConfiguration: () => ({ get: (_key: string, def?: unknown) => def }),
  workspaceFolders: [{ uri: { fsPath: "/tmp/ide-agent-instant-grep-test" } }],
};

interface SeenCall {
  args: string[];
  timeoutMs: number;
}

let seen: SeenCall[] = [];
let nextStdout: string | undefined = '{"kind":"grep","matches":[]}';

function fakeRunner(args: string[], timeoutMs: number): Promise<string | undefined> {
  seen.push({ args, timeoutMs });
  return Promise.resolve(nextStdout);
}

beforeEach(() => {
  seen = [];
  nextStdout = '{"kind":"grep","matches":[]}';
  __clearInstantGrepCacheForTests();
  __setInstantGrepRunnerForTests(fakeRunner);
});

function cliJson(matches: { path: string; line: number; text: string }[]): string {
  return JSON.stringify({ kind: "grep", matches });
}

describe("instantGrep", () => {
  it("parses CLI JSON into ranked matches", async () => {
    nextStdout = cliJson([
      { path: "src/a.ts", line: 3, text: "import { PaymentService } from './pay'" },
      { path: "src/b.ts", line: 10, text: "const svc: PaymentService" },
    ]);
    const out = await instantGrep("import.*PaymentService");
    assert.deepStrictEqual(out, [
      { path: "src/a.ts", line: 3, text: "import { PaymentService } from './pay'" },
      { path: "src/b.ts", line: 10, text: "const svc: PaymentService" },
    ]);
    // Pattern goes after the `--` separator; --root precedes it.
    const args = seen[0]!.args;
    assert.strictEqual(args[0], "grep");
    assert.ok(args.includes("--json"));
    const sep = args.indexOf("--");
    assert.ok(sep > 0);
    assert.deepStrictEqual(args.slice(sep + 1), ["import.*PaymentService"]);
  });

  it("passes search flags through to the CLI", async () => {
    await instantGrep("PaymentFailedError", {
      regex: false,
      wordBoundary: true,
      caseSensitive: true,
      include: "*.ts",
      exclude: "*.test.ts",
      limit: 7,
    });
    const args = seen[0]!.args;
    assert.ok(args.includes("--literal"));
    assert.ok(args.includes("--word-boundary"));
    assert.ok(args.includes("--case-sensitive"));
    assert.ok(args.includes("--include"));
    assert.ok(args.includes("--exclude"));
    assert.ok(args.includes("*.ts"));
    assert.ok(args.includes("*.test.ts"));
    const limitIdx = args.indexOf("--limit");
    assert.strictEqual(args[limitIdx + 1], "25"); // fetch floor, like codebaseIndexService
  });

  it("defaults to regex mode (no --literal)", async () => {
    await instantGrep("import.*PaymentService");
    assert.ok(!seen[0]!.args.includes("--literal"));
  });

  it("returns [] when the runner fails — never fabricated matches", async () => {
    nextStdout = undefined;
    assert.deepStrictEqual(await instantGrep("anything"), []);
  });

  it("returns [] on invalid JSON", async () => {
    nextStdout = "not json {{{";
    assert.deepStrictEqual(await instantGrep("anything"), []);
  });

  it("returns [] on wrong kind or missing matches", async () => {
    nextStdout = JSON.stringify({ kind: "symbols", hits: [] });
    assert.deepStrictEqual(await instantGrep("anything"), []);
    __clearInstantGrepCacheForTests();
    nextStdout = JSON.stringify({ kind: "grep" });
    assert.deepStrictEqual(await instantGrep("anything"), []);
  });

  it("skips malformed match entries instead of throwing", async () => {
    nextStdout = JSON.stringify({
      kind: "grep",
      matches: [
        { path: "src/a.ts", line: 1, text: "ok" },
        { path: 42, line: "x", text: null },
        { path: "src/b.ts", line: 2 },
      ],
    });
    assert.deepStrictEqual(await instantGrep("ok"), [{ path: "src/a.ts", line: 1, text: "ok" }]);
  });

  it("empty pattern returns [] without spawning", async () => {
    assert.deepStrictEqual(await instantGrep(""), []);
    assert.strictEqual(seen.length, 0);
  });

  it("caches repeated queries within the TTL", async () => {
    nextStdout = cliJson([{ path: "src/a.ts", line: 1, text: "hit" }]);
    const first = await instantGrep("cached-query", { limit: 5 });
    const second = await instantGrep("cached-query", { limit: 5 });
    assert.deepStrictEqual(first, second);
    assert.strictEqual(seen.length, 1);
    // A different option set is a different cache key.
    await instantGrep("cached-query", { limit: 5, wordBoundary: true });
    assert.strictEqual(seen.length, 2);
  });

  it("resets to the default runner", () => {
    __resetInstantGrepRunnerForTests();
    // No assertion on the real runner (it would spawn bun); the reset just
    // must not throw and must restore module state for other suites.
    __setInstantGrepRunnerForTests(fakeRunner);
  });
});
