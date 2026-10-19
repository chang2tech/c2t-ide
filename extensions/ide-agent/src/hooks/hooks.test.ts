/**
 * Hooks system tests (node:test, zero extra deps).
 *
 * Unit: config loader (validation, per-source errors, claude compat),
 * runner (exit-code semantics, timeout, env/stdin contract),
 * service (matcher filtering, decision merge, context flow, tool gate).
 *
 * Run after `tsc`:  node out/hooks/hooks.test.js
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parseAndValidateHooksConfig, loadAllHookSources, flattenHooks } from "./hookLoader";
import { runHookProcess, buildHookEnv, buildHookInput } from "./hookRunner";
import { HookService } from "./hookService";
import { HookPayload, LoadedHook } from "./hookTypes";

const PAYLOAD: HookPayload = {
  hook_event_name: "beforeShellExecution",
  cursor_version: "0.0.0-test",
  workspace_roots: ["/ws"],
};

function loadedHook(command: string, overrides: Partial<LoadedHook["entry"]> = {}): LoadedHook {
  return {
    entry: { command, type: "command", ...overrides },
    source: "project",
    sourcePath: "/ws/.ide-code/hooks.json",
    event: "beforeShellExecution",
  };
}

const RUN_OPTS = { cwd: os.tmpdir(), appVersion: "0.0.0-test" };

// ---------------------------------------------------------------- loader

describe("hookLoader.parseAndValidateHooksConfig", () => {
  it("parses a valid config with all fields", () => {
    const { hooks, errors } = parseAndValidateHooksConfig(
      {
        version: 1,
        hooks: {
          beforeShellExecution: [
            { command: ".ide-code/hooks/guard.sh", type: "command", timeout: 30, loop_limit: 5, failClosed: true, matcher: "rm" },
          ],
          stop: [{ command: "echo done", loop_limit: null }],
        },
      },
      "project",
      "/ws/.ide-code/hooks.json",
    );
    assert.strictEqual(errors.length, 0);
    assert.strictEqual(hooks.length, 2);
    assert.strictEqual(hooks[0].entry.failClosed, true);
    assert.strictEqual(hooks[0].entry.matcher, "rm");
    assert.strictEqual(hooks[1].entry.loop_limit, null);
    assert.strictEqual(hooks[1].event, "stop");
  });

  it("rejects unknown events without inventing them", () => {
    const { hooks, errors } = parseAndValidateHooksConfig(
      { hooks: { frobnicate: [{ command: "echo x" }], stop: [{ command: "echo y" }] } },
      "user",
      "~/.ide-code/hooks.json",
    );
    assert.strictEqual(hooks.length, 1);
    assert.strictEqual(hooks[0].event, "stop");
    assert.ok(errors.some((e) => e.includes('unknown hook event "frobnicate"')));
  });

  it("skips entries with missing/invalid fields, keeps the rest", () => {
    const { hooks, errors } = parseAndValidateHooksConfig(
      {
        hooks: {
          preToolUse: [
            { type: "command" }, // no command
            { command: "", }, // empty command
            { command: "echo ok", matcher: "[invalid" }, // bad regex
            { command: "echo ok", type: "weird" }, // bad type
            { command: "echo ok" }, // good
          ],
        },
      },
      "project",
      "p",
    );
    assert.strictEqual(hooks.length, 1);
    assert.strictEqual(hooks[0].entry.command, "echo ok");
    assert.strictEqual(errors.length, 4);
  });

  it("rejects a non-object top level", () => {
    const { hooks, errors } = parseAndValidateHooksConfig([1, 2], "project", "p");
    assert.strictEqual(hooks.length, 0);
    assert.strictEqual(errors.length, 1);
  });

  it("accepts an empty/missing hooks key", () => {
    const { hooks, errors } = parseAndValidateHooksConfig({}, "project", "p");
    assert.strictEqual(hooks.length, 0);
    assert.strictEqual(errors.length, 0);
  });
});

describe("hookLoader.loadAllHookSources", () => {
  let dir: string;
  let origHome: string | undefined;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "hooks-test-"));
    origHome = process.env.HOME;
    process.env.HOME = dir; // user-level sources resolve under $HOME
    fs.mkdirSync(path.join(dir, ".ide-code"), { recursive: true });
  });
  afterEach(() => {
    process.env.HOME = origHome;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("a bad source does not kill the other sources", () => {
    fs.writeFileSync(path.join(dir, ".ide-code", "hooks.json"), "{ not json");
    fs.mkdirSync(path.join(dir, "proj", ".ide-code"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "proj", ".ide-code", "hooks.json"),
      JSON.stringify({ hooks: { stop: [{ command: "echo ok" }] } }),
    );
    const results = loadAllHookSources([path.join(dir, "proj")]);
    const user = results.find((r) => r.kind === "user");
    const project = results.find((r) => r.kind === "project");
    assert.ok(user?.found);
    assert.strictEqual(user?.hooks.length, 0);
    assert.ok(user && user.errors.length > 0, "bad JSON must surface a per-source error");
    assert.strictEqual(project?.hooks.length, 1);
    const { hooks } = flattenHooks(results);
    assert.strictEqual(hooks.length, 1);
  });

  it("missing files are found:false with no errors", () => {
    const results = loadAllHookSources([path.join(dir, "empty")]);
    const missing = results.filter((r) => !r.found);
    assert.ok(missing.length > 0);
    assert.ok(missing.every((r) => r.errors.length === 0));
  });

  it("adapts claude settings.json hooks", () => {
    fs.mkdirSync(path.join(dir, "proj", ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "proj", ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo guard", timeout: 5 }] }],
          Notification: [{ matcher: "", hooks: [{ type: "command", command: "echo n" }] }],
        },
      }),
    );
    const results = loadAllHookSources([path.join(dir, "proj")]);
    const claude = results.find((r) => r.kind === "claude-compat");
    assert.ok(claude?.found);
    assert.strictEqual(claude?.hooks.length, 1);
    assert.strictEqual(claude?.hooks[0].event, "preToolUse");
    assert.strictEqual(claude?.hooks[0].entry.matcher, "Bash");
    assert.ok(claude && claude.errors.some((e) => e.includes("Notification")), "Notification has no equivalent — must be noted");
  });
});

// ---------------------------------------------------------------- runner

describe("hookRunner exit-code semantics", () => {
  it("exit 0 → allow", async () => {
    const o = await runHookProcess(loadedHook(`node -e "process.exit(0)"`), PAYLOAD, RUN_OPTS);
    assert.strictEqual(o.decision, "allow");
    assert.strictEqual(o.blocks, false);
  });

  it("exit 2 → block with the verbatim no-reason message", async () => {
    const o = await runHookProcess(loadedHook(`node -e "process.exit(2)"`), PAYLOAD, RUN_OPTS);
    assert.strictEqual(o.decision, "deny");
    assert.strictEqual(o.blocks, true);
    assert.ok(o.reason?.includes("blocked this action (exit code 2) but provided no reason"));
  });

  it("exit 2 with JSON reason → block with that reason", async () => {
    const o = await runHookProcess(
      loadedHook(`node -e "console.log(JSON.stringify({reason:'nope'})); process.exit(2)"`),
      PAYLOAD,
      RUN_OPTS,
    );
    assert.strictEqual(o.blocks, true);
    assert.strictEqual(o.reason, "nope");
  });

  it('JSON {"decision":"deny"} with exit 0 → block', async () => {
    const o = await runHookProcess(
      loadedHook(`node -e "console.log(JSON.stringify({decision:'deny',reason:'policy'}))"`),
      PAYLOAD,
      RUN_OPTS,
    );
    assert.strictEqual(o.decision, "deny");
    assert.strictEqual(o.blocks, true);
    assert.strictEqual(o.reason, "policy");
  });

  it("other non-zero → fail-open", async () => {
    const o = await runHookProcess(loadedHook(`node -e "process.exit(1)"`), PAYLOAD, RUN_OPTS);
    assert.strictEqual(o.decision, "allow");
    assert.strictEqual(o.blocks, false);
  });

  it("other non-zero + failClosed → block", async () => {
    const o = await runHookProcess(
      loadedHook(`node -e "process.exit(1)"`, { failClosed: true }),
      PAYLOAD,
      RUN_OPTS,
    );
    assert.strictEqual(o.blocks, true);
  });

  it("timeout → fail-open (failClosed → block)", { timeout: 15000 }, async () => {
    const slow = loadedHook(`node -e "setTimeout(()=>{}, 5000)"`, { timeout: 1 });
    const o = await runHookProcess(slow, PAYLOAD, RUN_OPTS);
    assert.strictEqual(o.timedOut, true);
    assert.strictEqual(o.blocks, false);
    const o2 = await runHookProcess(loadedHook(`node -e "setTimeout(()=>{}, 5000)"`, { timeout: 1, failClosed: true }), PAYLOAD, RUN_OPTS);
    assert.strictEqual(o2.timedOut, true);
    assert.strictEqual(o2.blocks, true);
  });

  it("injects the CURSOR_* env contract and JSON stdin", async () => {
    const o = await runHookProcess(
      loadedHook(`node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const p=JSON.parse(s);console.log(process.env.CURSOR_PROJECT_DIR+'|'+p.hook_event_name)})"`),
      { ...PAYLOAD, workspace_roots: ["/ws"] },
      RUN_OPTS,
    );
    assert.ok(o.stdout.includes("/ws|beforeShellExecution"), `got: ${o.stdout}`);
  });

  it("prompt-type hooks are not spawned", async () => {
    const o = await runHookProcess(
      loadedHook(`node -e "process.exit(2)"`, { type: "prompt" }),
      PAYLOAD,
      RUN_OPTS,
    );
    assert.strictEqual(o.exitCode, null);
    assert.strictEqual(o.blocks, false);
  });
});

describe("hookRunner.buildHookEnv / buildHookInput", () => {
  it("sets both CURSOR_* and IDE_CODE_* vars", () => {
    const env = buildHookEnv({ ...PAYLOAD, workspace_roots: ["/ws"], user_email: "u@x.io" }, undefined);
    assert.strictEqual(env.CURSOR_PROJECT_DIR, "/ws");
    assert.strictEqual(env.CURSOR_USER_EMAIL, "u@x.io");
    assert.strictEqual(env.IDE_CODE_PROJECT_DIR, "/ws");
    assert.strictEqual(env.IDE_CODE_HOOK_EVENT, "beforeShellExecution");
    assert.strictEqual(env.CLAUDE_PROJECT_DIR, "/ws");
  });

  it("input JSON carries the input contract fields", () => {
    const p = JSON.parse(buildHookInput({ ...PAYLOAD, workspace_roots: ["/a", "/b"] })) as Record<string, unknown>;
    assert.strictEqual(p.hook_event_name, "beforeShellExecution");
    assert.deepStrictEqual(p.workspace_roots, ["/a", "/b"]);
    assert.strictEqual(p.cursor_version, "0.0.0-test");
  });
});

// ---------------------------------------------------------------- service

function testService(workspaceRoots?: string[]): { svc: HookService; lines: string[] } {
  const lines: string[] = [];
  const svc = new HookService({
    workspaceRoots: workspaceRoots ?? [],
    appVersion: "0.0.0-test",
    log: (l) => lines.push(l),
  });
  return { svc, lines };
}

describe("HookService", () => {
  let dir: string;
  let origHome: string | undefined;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "hooks-svc-"));
    origHome = process.env.HOME;
    process.env.HOME = dir;
  });
  afterEach(() => {
    process.env.HOME = origHome;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeUserConfig(obj: unknown): void {
    fs.mkdirSync(path.join(dir, ".ide-code"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".ide-code", "hooks.json"), JSON.stringify(obj));
  }

  it("hasHooks fast path and empty run", async () => {
    const { svc } = testService();
    assert.strictEqual(svc.hasHooks("stop"), false);
    const r = await svc.runHooks("stop", {});
    assert.strictEqual(r.blocked, false);
    assert.strictEqual(r.decision, "allow");
  });

  it("matcher filters beforeShellExecution by command text", async () => {
    writeUserConfig({
      hooks: { beforeShellExecution: [{ command: `node -e "process.exit(2)"`, matcher: "rm -rf" }] },
    });
    const { svc } = testService();
    assert.strictEqual(svc.hasHooks("beforeShellExecution"), true);
    const blocked = await svc.runHooks("beforeShellExecution", { tool: "bash", command: "rm -rf /tmp/x" });
    assert.strictEqual(blocked.blocked, true);
    const allowed = await svc.runHooks("beforeShellExecution", { tool: "bash", command: "ls -la" });
    assert.strictEqual(allowed.blocked, false);
  });

  it("merges decisions deny > ask > allow; user_message concatenates; followup last-wins", async () => {
    writeUserConfig({
      hooks: {
        afterAgentResponse: [
          { command: `node -e "console.log(JSON.stringify({decision:'allow',user_message:'m1'}))"` },
          { command: `node -e "console.log(JSON.stringify({decision:'ask',user_message:'m2',followup_message:'f1'}))"` },
          { command: `node -e "console.log(JSON.stringify({decision:'deny',followup_message:'f2'}))"` },
        ],
      },
    });
    const { svc } = testService();
    const r = await svc.runHooks("afterAgentResponse", {});
    assert.strictEqual(r.decision, "deny");
    // afterAgentResponse is not a blocking event → deny recorded, not enforced
    assert.strictEqual(r.blocked, false);
    assert.deepStrictEqual(r.userMessages, ["m1", "m2"]);
    assert.deepStrictEqual(r.followupMessages, ["f2"]);
  });

  it("deny on a blocking event is enforced", async () => {
    writeUserConfig({
      hooks: { beforeSubmitPrompt: [{ command: `node -e "process.exit(2)"`, matcher: "UserPromptSubmit" }] },
    });
    const { svc } = testService();
    const r = await svc.runHooks("beforeSubmitPrompt", { submitKind: "UserPromptSubmit", prompt: "hi" });
    assert.strictEqual(r.blocked, true);
    assert.ok(r.blockReason?.includes("exit code 2"));
  });

  it("hook stdout flows to context additions (non-JSON)", async () => {
    writeUserConfig({
      hooks: { afterFileEdit: [{ command: `node -e "console.log('formatted 3 files')"` }] },
    });
    const { svc } = testService();
    const r = await svc.runHooks("afterFileEdit", { file: "a.ts" });
    assert.ok(r.contextAdditions.some((c) => c.includes("formatted 3 files")));
    const drained = svc.drainContextAdditions();
    assert.ok(drained.some((c) => c.includes("formatted 3 files")));
    assert.strictEqual(svc.drainContextAdditions().length, 0, "drain empties the buffer");
  });

  it("JSON decision blobs do not pollute context", async () => {
    writeUserConfig({
      hooks: { afterFileEdit: [{ command: `node -e "console.log(JSON.stringify({decision:'allow'}))"` }] },
    });
    const { svc } = testService();
    const r = await svc.runHooks("afterFileEdit", {});
    assert.strictEqual(r.contextAdditions.length, 0);
  });

  it("checkToolGate fires preToolUse and the specialized event", async () => {
    writeUserConfig({
      hooks: {
        preToolUse: [{ command: `node -e "process.exit(0)"`, matcher: "MCP" }],
        beforeShellExecution: [{ command: `node -e "process.exit(2)"`, matcher: "rm" }],
      },
    });
    const { svc } = testService();
    const g = await svc.checkToolGate("bash", ["rm -rf /"], { command: "rm -rf /" });
    assert.strictEqual(g.blocked, true);
    const g2 = await svc.checkToolGate("bash", ["ls"], { command: "ls" });
    assert.strictEqual(g2.blocked, false);
  });

  it("checkToolGate formats MCP tools as MCP:<tool> for the matcher", async () => {
    writeUserConfig({
      hooks: { preToolUse: [{ command: `node -e "process.exit(2)"`, matcher: "^MCP:read$" }] },
    });
    const { svc } = testService();
    const g = await svc.checkToolGate("mcp__fs__read", ["x"], {});
    assert.strictEqual(g.blocked, true);
    const g2 = await svc.checkToolGate("read", ["x"], {});
    assert.strictEqual(g2.blocked, false);
  });

  it("prompt-type hooks skip honestly without an evaluator", async () => {
    writeUserConfig({
      hooks: { stop: [{ command: "decide whether to stop: $ARGUMENTS", type: "prompt" }] },
    });
    const { svc, lines } = testService();
    const r = await svc.runHooks("stop", { stopKind: "Stop" });
    assert.strictEqual(r.blocked, false);
    assert.ok(lines.some((l) => l.includes("prompt-type hook skipped")));
  });

  it("prompt-type hooks use the injected evaluator", async () => {
    writeUserConfig({
      hooks: { stop: [{ command: "should stop? $ARGUMENTS", type: "prompt" }] },
    });
    const lines: string[] = [];
    const svc = new HookService({
      workspaceRoots: [],
      appVersion: "0.0.0-test",
      log: (l) => lines.push(l),
      promptEvaluator: async (prompt) => {
        assert.ok(prompt.includes("should stop?"));
        assert.ok(prompt.includes('"hook_event_name":"stop"'), "payload substituted for $ARGUMENTS");
        return { ok: false, reason: "keep going" };
      },
    });
    const r = await svc.runHooks("stop", { stopKind: "Stop" });
    assert.strictEqual(r.decision, "deny");
    assert.strictEqual(r.blocked, true, "stop is a blocking event");
    assert.strictEqual(r.blockReason, "keep going");
  });

  it("refuses to invent events", async () => {
    const { svc } = testService();
    await assert.rejects(() => svc.runHooks("frobnicate" as never, {}), /unknown hook event/);
  });

  it("records an execution log", async () => {
    writeUserConfig({ hooks: { stop: [{ command: `node -e "process.exit(0)"` }] } });
    const { svc } = testService();
    await svc.runHooks("stop", { stopKind: "Stop" });
    const log = svc.getExecutionLog();
    assert.strictEqual(log.length, 1);
    assert.strictEqual(log[0].event, "stop");
    assert.strictEqual(log[0].decision, "allow");
  });
});
