/**
 * run-agent-cli-tests.ts — node:test suite for the agent CLI.
 *
 * Tests run against a MOCK engine HTTP server (plain node:http) that
 * implements the real wire protocol (same endpoints/auth/SSE format as the
 * production sidecar): no real `bun` is ever spawned. Spawn is dependency-
 * injected via runAgent's clientFactory.
 *
 * Run: npx tsc && node --test out/test/run-agent-cli-tests.js
 */

import { strict as assert } from "node:assert";
import { Writable } from "node:stream";
import { test } from "node:test";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { Readable } from "node:stream";
import {
  EngineClient,
  EngineClientOptions,
  EngineStartError,
  parseSseFrame,
  resolveEnginePath,
  subagentNestingDefaultEnv,
} from "../agent/engine";
import {
  autoDecidePermission,
  cliVersion,
  isAutoReviewable,
  isRiskyShellCommand,
  matchesToolList,
  parseArgs,
  resolveResumeTarget,
  runAgent,
} from "../agent/cli";
import {
  loadRegistry,
  recordSession,
} from "../agent/sessions";
import { loadHooks, parseStopFollowUp, runHookEvent } from "../agent/hooks";
import {
  loadPluginRegistry,
  marketplaceNameFromUrl,
  type GitSpawn,
} from "../agent/plugins";
import { parseSlashCommand as tuiParseSlash, timedConfirm, type TurnRenderHooks, type TurnResult } from "../agent/tui";
import {
  extractMcpServers,
  handleSlashCommand,
  parseSlashCommand as slashParse,
  type SlashRuntime,
  type TurnLogEntry,
} from "../agent/slash";
import {
  DEFAULT_AGENT_CONFIG,
  formatAgentConfig,
  loadAgentConfig,
  saveAgentConfig,
  setAgentConfigValue,
} from "../agent/agent-config";
import {
  activeWorkspaceName,
  addDirToWorkspace,
  listWorkspaceNames,
  removeDirFromWorkspace,
  validateWorkspaceName,
  workspaceDirs,
} from "../agent/workspaces";

// ---------------------------------------------------------------------------
// Mock engine
// ---------------------------------------------------------------------------

interface MockReply {
  reqID: string;
  decision: string;
}

interface MockEngine {
  port: number;
  replies: MockReply[];
  sessionBodies: any[];
  /** Session ids that received a prompt, in order. */
  promptSessionIDs: string[];
  /** Session ids deleted via DELETE /api/session/:id. */
  deletedIDs: string[];
  /** Session ids compacted via POST /api/session/:id/compact. */
  compactedIDs: string[];
  lastAuthHeader: string | undefined;
  close(): Promise<void>;
}

function startMockEngine(): Promise<MockEngine> {
  const replies: MockReply[] = [];
  const sessionBodies: any[] = [];
  const promptSessionIDs: string[] = [];
  const deletedIDs: string[] = [];
  const compactedIDs: string[] = [];
  const mock: MockEngine = {
    port: 0,
    replies,
    sessionBodies,
    promptSessionIDs,
    deletedIDs,
    compactedIDs,
    lastAuthHeader: undefined,
    close: async () => {},
  };
  let emitSse: ((type: string, data: any) => void) | undefined;
  let replyWaiters: Array<() => void> = [];

  const frame = (type: string, data: any): string =>
    `data: ${JSON.stringify({ id: `e${Date.now()}${Math.random()}`, type, data })}\n\n`;

  const server = http.createServer((req, res) => {
    const url = req.url ?? "";
    mock.lastAuthHeader = req.headers.authorization;
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const json = (code: number, obj: unknown) => {
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      if (req.method === "GET" && url === "/api/config") {
        return json(200, {});
      }
      if (req.method === "GET" && url === "/api/model") {
        return json(200, {
          data: [{ id: "m1", modelID: "m1", providerID: "p1", name: "Test Model 1" }],
        });
      }
      if (req.method === "POST" && url === "/api/session") {
        mock.sessionBodies.push(body ? JSON.parse(body) : {});
        return json(200, { data: { id: "ses_test" } });
      }
      const promptMatch = /^\/api\/session\/([^/]+)\/prompt$/.exec(url);
      if (req.method === "POST" && promptMatch) {
        const payload = body ? JSON.parse(body) : {};
        const text: string = payload.text ?? "";
        mock.promptSessionIDs.push(promptMatch[1]);
        // Emit the scripted turn after the event-stream subscriber is in place.
        setTimeout(() => {
          const send = emitSse;
          if (!send) {
            return;
          }
          const sid = "ses_test";
          const finish = () => {
            send("session.text.delta", { sessionID: sid, delta: "hello " });
            send("session.text.delta", { sessionID: sid, delta: "world" });
            send("session.execution.succeeded", { sessionID: sid });
          };
          if (text.includes("SUBAGENT")) {
            // A delegated subagent outlives the main execution: the drain
            // must wait for session.subagent.ended before turn.end.
            send("session.subagent.started", { sessionID: sid, id: "sub1" });
            setTimeout(() => {
              send("session.text.delta", { sessionID: sid, delta: "hello " });
              send("session.text.delta", { sessionID: sid, delta: "world" });
              send("session.execution.succeeded", { sessionID: sid });
            }, 60);
            setTimeout(() => {
              send("session.subagent.ended", { sessionID: sid, id: "sub1" });
            }, 250);
            return;
          }
          if (text.includes("PERM")) {
            send("permission.asked", {
              id: "req1",
              sessionID: sid,
              action: text.includes("shell") ? "shell" : "mcp__x__write_file",
              resources: ["/tmp/x"],
              message: `run ${text.includes("shell") ? "shell" : "mcp tool"}`,
            });
            // Wait for the reply before finishing the turn (bounded).
            const deadline = setTimeout(finish, 3000);
            replyWaiters.push(() => {
              clearTimeout(deadline);
              setTimeout(finish, 20);
            });
          } else {
            setTimeout(finish, 20);
          }
        }, 30);
        return json(200, { data: { id: "msg1" } });
      }
      const replyMatch = /^\/api\/session\/([^/]+)\/permission\/([^/]+)\/reply$/.exec(url);
      if (req.method === "POST" && replyMatch) {
        const payload = body ? JSON.parse(body) : {};
        replies.push({ reqID: replyMatch[2], decision: String(payload.decision ?? "") });
        for (const w of replyWaiters) {
          w();
        }
        replyWaiters = [];
        return json(200, {});
      }
      const compactMatch = /^\/api\/session\/([^/]+)\/compact$/.exec(url);
      if (req.method === "POST" && compactMatch) {
        mock.compactedIDs.push(compactMatch[1]);
        return json(200, {});
      }
      const sessMatch = /^\/api\/session\/([^/]+)$/.exec(url);
      if (sessMatch && req.method === "GET") {
        // getSessionInfo — only the mock's known session exists.
        if (sessMatch[1] === "ses_test") {
          return json(200, { data: { id: "ses_test", title: "Test session" } });
        }
        return json(404, { error: "session not found" });
      }
      if (sessMatch && req.method === "DELETE") {
        mock.deletedIDs.push(sessMatch[1]);
        return json(200, {});
      }
      if (req.method === "GET" && url === "/api/event") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write(": heartbeat\n\n");
        emitSse = (type, data) => {
          try {
            res.write(frame(type, data));
          } catch {
            /* client gone */
          }
        };
        return;
      }
      json(404, { error: "not found" });
    });
  });

  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr !== "object") {
        reject(new Error("mock engine failed to listen"));
        return;
      }
      mock.port = addr.port;
      mock.close = () =>
        new Promise<void>((r) => {
          server.close(() => r());
        });
      resolve(mock);
    });
  });
}

function capture() {
  let text = "";
  const stream = new Writable({
    write(chunk, _enc, cb) {
      text += chunk.toString();
      cb();
    },
  });
  return { stream, get text() { return text; } };
}

function clientFactoryFor(mock: MockEngine) {
  return (_opts: EngineClientOptions) =>
    Promise.resolve(EngineClient.forConnection({ host: "127.0.0.1", port: mock.port, token: "t".repeat(64) }));
}

// ---------------------------------------------------------------------------
// Hermetic local state
// ---------------------------------------------------------------------------
// Registry/plugin/hook/config writes in these tests must never touch the
// real ~/.ide-code. One temp home per file is enough: individual tests
// reset the JSON files they use via resetLocalState().
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ide-cli-test-"));
process.env.IDE_CODE_HOME = TEST_HOME;

function resetLocalState(): void {
  for (const f of ["agent-sessions.json", "plugins.json", "hooks.json", "agent-config.json"]) {
    try {
      fs.rmSync(path.join(TEST_HOME, ".ide-code", f));
    } catch {
      /* already absent */
    }
  }
  try {
    fs.rmSync(path.join(TEST_HOME, ".ide-code", "plugins"), { recursive: true, force: true });
  } catch {
    /* already absent */
  }
}

function seedSession(id: string, extra: Record<string, unknown> = {}): void {
  recordSession({
    id,
    title: `Test ${id}`,
    createdAt: Date.now() - 1000,
    lastUsedAt: Date.now() - 1000,
    cwd: "/tmp/work",
    mode: "agent",
    ...extra,
  });
}

function writeHooksFile(obj: unknown): void {
  const dir = path.join(TEST_HOME, ".ide-code");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "hooks.json"), JSON.stringify(obj), "utf8");
}

/** Fake git spawn for plugin tests: canned exit code + stderr. */
function fakeGitSpawn(code: number, stderr = ""): GitSpawn {
  return ((_cmd: string, _args: string[], _opts: unknown) => {
    const { EventEmitter } = require("node:events");
    const child = new EventEmitter() as any;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => {
      if (stderr) {
        child.stderr.emit("data", Buffer.from(stderr));
      }
      child.emit("close", code);
    });
    return child;
  }) as GitSpawn;
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

test("parseArgs: -p with value and flags", () => {
  const r = parseArgs(["-p", "hello", "--force", "--output-format", "json"]);
  assert.ok("flags" in r);
  assert.equal(r.flags.print, "hello");
  assert.equal(r.flags.force, true);
  assert.equal(r.flags.outputFormat, "json");
});

test("parseArgs: -p without value takes positional prompt", () => {
  const r = parseArgs(["-p", "--yolo", "fix", "the", "bug"]);
  assert.ok("flags" in r);
  assert.equal(r.flags.print, "fix the bug");
  assert.equal(r.flags.force, true);
  assert.deepEqual(r.flags.positional, []);
});

test("parseArgs: --print=value form", () => {
  const r = parseArgs(["--print=hi"]);
  assert.ok("flags" in r);
  assert.equal(r.flags.print, "hi");
});

test("parseArgs: all real flags", () => {
  const r = parseArgs([
    "--stream-partial-output",
    "--trust",
    "--approve-mcps",
    "--plan",
    "--model",
    "p1/m1",
    "--mode",
    "ask",
    "-H",
    "X-A: 1",
    "-H",
    "X-B:2",
    "--engine-path",
    "/tmp/e",
    "--timeout",
    "5000",
  ]);
  assert.ok("flags" in r);
  assert.equal(r.flags.streamPartialOutput, true);
  assert.equal(r.flags.trust, true);
  assert.equal(r.flags.approveMcps, true);
  assert.equal(r.flags.mode, "ask"); // --plan then --mode ask: last one wins
  assert.equal(r.flags.model, "p1/m1");
  assert.deepEqual(r.flags.headers, { "X-A": "1", "X-B": "2" });
  assert.equal(r.flags.enginePath, "/tmp/e");
  assert.equal(r.flags.timeoutMs, 5000);
});

test("parseArgs: invalid values are rejected", () => {
  assert.ok("error" in parseArgs(["--output-format", "yaml"]));
  assert.ok("error" in parseArgs(["--mode", "turbo"]));
  assert.ok("error" in parseArgs(["--timeout", "nope"]));
  assert.ok("error" in parseArgs(["-H"]));
  assert.ok("error" in parseArgs(["-H", "no-colon"]));
  assert.ok("error" in parseArgs(["--mystery"]));
});

test("parseArgs: unsupported Cursor flags fail honestly", () => {
  for (const argv of [
    ["--sandbox", "enabled"],
    ["--api-key", "k"],
    ["-w"],
    ["--worktree", "x"],
    ["--worktree-base", "main"],
    ["--skip-worktree-setup"],
  ]) {
    const r = parseArgs(argv);
    assert.ok("error" in r, `expected error for ${argv.join(" ")}`);
  }
});

test("parseArgs: subcommands", () => {
  const s = parseArgs(["status"]);
  assert.ok("flags" in s && s.flags.subcommand === "status");
  const l = parseArgs(["login"]);
  assert.ok("flags" in l && l.flags.subcommand === "login");
  // "--" terminator: status is positional, not a subcommand
  const t = parseArgs(["--", "status"]);
  assert.ok("flags" in t && t.flags.subcommand === undefined);
  assert.deepEqual(t.flags.positional, ["status"]);
});

// ---------------------------------------------------------------------------
// Print mode
// ---------------------------------------------------------------------------

test("print mode: text output is the final answer only, exit 0", async () => {
  const mock = await startMockEngine();
  const out = capture();
  const err = capture();
  const code = await runAgent(["-p", "hello"], {
    out: out.stream,
    err: err.stream,
    isTTY: false,
    clientFactory: clientFactoryFor(mock),
  });
  assert.equal(code, 0);
  assert.equal(out.text.trim(), "hello world");
  assert.ok(mock.sessionBodies[0].title.includes("print"));
  await mock.close();
});

test("print mode: --output-format json envelope shape", async () => {
  const mock = await startMockEngine();
  const out = capture();
  const err = capture();
  const code = await runAgent(["-p", "hello", "--output-format", "json", "--model", "p1/m1"], {
    out: out.stream,
    err: err.stream,
    isTTY: false,
    clientFactory: clientFactoryFor(mock),
  });
  assert.equal(code, 0);
  const env = JSON.parse(out.text.trim());
  assert.equal(env.result, "hello world");
  assert.equal(env.sessionID, "ses_test");
  assert.equal(env.model, "p1/m1");
  assert.equal(env.endKind, "succeeded");
  await mock.close();
});

test("print mode: stream-json emits deltas and turn.end", async () => {
  const mock = await startMockEngine();
  const out = capture();
  const err = capture();
  const code = await runAgent(
    ["-p", "hello", "--output-format", "stream-json", "--stream-partial-output"],
    { out: out.stream, err: err.stream, isTTY: false, clientFactory: clientFactoryFor(mock) },
  );
  assert.equal(code, 0);
  const lines = out.text.trim().split("\n").map((l) => JSON.parse(l));
  const types = lines.map((l) => l.type);
  assert.ok(types.includes("turn.start"));
  const deltas = lines.filter((l) => l.type === "text.delta");
  assert.equal(
    deltas.map((d) => d.delta).join(""),
    "hello world",
  );
  const end = lines.find((l) => l.type === "turn.end");
  assert.equal(end.endKind, "succeeded");
  assert.equal(end.result, "hello world");
  await mock.close();
});

test("print mode: --yolo auto-approves permission.asked", async () => {
  const mock = await startMockEngine();
  const out = capture();
  const err = capture();
  const code = await runAgent(["-p", "--yolo", "PERM", "shell"], {
    out: out.stream,
    err: err.stream,
    isTTY: false,
    clientFactory: clientFactoryFor(mock),
  });
  assert.equal(code, 0);
  assert.equal(mock.replies.length, 1);
  assert.equal(mock.replies[0].reqID, "req1");
  assert.equal(mock.replies[0].decision, "once");
  await mock.close();
});

test("print mode: non-TTY without --force denies mutating actions (fail-safe)", async () => {
  const mock = await startMockEngine();
  const out = capture();
  const err = capture();
  const code = await runAgent(["-p", "PERM shell"], {
    out: out.stream,
    err: err.stream,
    isTTY: false,
    clientFactory: clientFactoryFor(mock),
  });
  assert.equal(code, 0);
  assert.equal(mock.replies.length, 1);
  assert.equal(mock.replies[0].decision, "reject");
  await mock.close();
});

test("print mode: --approve-mcps approves MCP tools", async () => {
  const mock = await startMockEngine();
  const out = capture();
  const err = capture();
  const code = await runAgent(["-p", "--approve-mcps", "PERM", "mcp"], {
    out: out.stream,
    err: err.stream,
    isTTY: false,
    clientFactory: clientFactoryFor(mock),
  });
  assert.equal(code, 0);
  assert.equal(mock.replies.length, 1);
  assert.equal(mock.replies[0].decision, "once");
  await mock.close();
});

test("print mode: plan mode sends the read-only permission ruleset", async () => {
  const mock = await startMockEngine();
  const out = capture();
  const err = capture();
  const code = await runAgent(["-p", "hello", "--plan"], {
    out: out.stream,
    err: err.stream,
    isTTY: false,
    clientFactory: clientFactoryFor(mock),
  });
  assert.equal(code, 0);
  const perms = mock.sessionBodies[0].permissions;
  assert.ok(Array.isArray(perms), "plan mode must send permissions");
  assert.ok(perms.some((p: any) => p.action === "edit" && p.effect === "deny"));
  assert.ok(perms.some((p: any) => p.action === "shell" && p.effect === "deny"));
  assert.ok(perms.some((p: any) => p.action === "mcp__*" && p.effect === "deny"));
  assert.ok(perms.some((p: any) => p.action === "mcp__*__read_file" && p.effect === "allow"));
  await mock.close();
});

test("print mode: extra headers are sent", async () => {
  const mock = await startMockEngine();
  const out = capture();
  const err = capture();
  await runAgent(["status", "-H", "X-Test: yes"], {
    out: out.stream,
    err: err.stream,
    isTTY: false,
    clientFactory: (opts) => {
      assert.equal(opts.extraHeaders?.["X-Test"], "yes");
      return clientFactoryFor(mock)(opts);
    },
  });
  await mock.close();
});

// ---------------------------------------------------------------------------
// status / login / errors
// ---------------------------------------------------------------------------

test("status: engine reachability + model list", async () => {
  const mock = await startMockEngine();
  const out = capture();
  const err = capture();
  const code = await runAgent(["status"], {
    out: out.stream,
    err: err.stream,
    isTTY: false,
    clientFactory: clientFactoryFor(mock),
  });
  assert.equal(code, 0);
  assert.ok(out.text.includes("engine: reachable"));
  assert.ok(out.text.includes("models: 1 available"));
  assert.ok(out.text.includes("p1/m1"));
  await mock.close();
});

test("login/logout/update are refused honestly", async () => {
  for (const sub of ["login", "logout", "update"]) {
    const mock = await startMockEngine();
    const out = capture();
    const err = capture();
    const code = await runAgent([sub], {
      out: out.stream,
      err: err.stream,
      isTTY: false,
      clientFactory: clientFactoryFor(mock),
    });
    assert.equal(code, 1, sub);
    assert.ok(err.text.includes("not supported"), sub);
    await mock.close();
  }
});

test("engine start failure → stderr + exit 1 (no fake result)", async () => {
  const out = capture();
  const err = capture();
  const code = await runAgent(["-p", "hello"], {
    out: out.stream,
    err: err.stream,
    isTTY: false,
    clientFactory: () =>
      Promise.reject(
        new EngineStartError("could not start IDE Code engine (invalid engine path /bogus)"),
      ),
  });
  assert.equal(code, 1);
  assert.ok(err.text.includes("could not start IDE Code engine"));
  assert.equal(out.text, "");
});

test("--help lists only implemented flags", async () => {
  const out = capture();
  const err = capture();
  // --help returns before any engine contact; the factory must never run.
  const code = await runAgent(["--help"], {
    out: out.stream,
    err: err.stream,
    isTTY: false,
    clientFactory: () => Promise.reject(new Error("must not start the engine for --help")),
  });
  assert.equal(code, 0);
  const help = out.text;
  for (const flag of [
    "--print",
    "--output-format",
    "--stream-partial-output",
    "--force",
    "--yolo",
    "--trust",
    "--approve-mcps",
    "--model",
    "--mode",
    "--plan",
    "--header",
    "--engine-path",
    "--timeout",
    "status",
  ]) {
    assert.ok(help.includes(flag), `help should list ${flag}`);
  }
  // Deliberate omissions must not be listed as SUPPORTED flags. They are
  // documented (with reasons) in the "Deliberately not implemented" epilogue,
  // so scope the check to the Options section above it.
  const optionsSection = help.split("Deliberately not implemented")[0];
  assert.ok(!optionsSection.includes("--sandbox"), "options must not list --sandbox");
  assert.ok(!optionsSection.includes("--api-key"), "options must not list --api-key");
  assert.ok(!optionsSection.includes("--worktree"), "options must not list --worktree");
  assert.ok(!optionsSection.includes("login"), "options must not list login");
});

// ---------------------------------------------------------------------------
// Engine path resolution / SSE parser / slash commands
// ---------------------------------------------------------------------------

test("resolveEnginePath: env beats heuristic", () => {
  const prev = process.env.IDE_CODE_ENGINE_PATH;
  process.env.IDE_CODE_ENGINE_PATH = "/tmp/custom-engine";
  try {
    assert.equal(resolveEnginePath("/whatever"), "/tmp/custom-engine");
  } finally {
    if (prev === undefined) {
      delete process.env.IDE_CODE_ENGINE_PATH;
    } else {
      process.env.IDE_CODE_ENGINE_PATH = prev;
    }
  }
});

test("resolveEnginePath: heuristic is <ide-cli>/../ide-code", () => {
  const prev = process.env.IDE_CODE_ENGINE_PATH;
  delete process.env.IDE_CODE_ENGINE_PATH;
  try {
    assert.equal(resolveEnginePath("/home/u/vscode/ide-cli"), "/home/u/vscode/ide-code");
  } finally {
    if (prev !== undefined) {
      process.env.IDE_CODE_ENGINE_PATH = prev;
    }
  }
});

test("parseSseFrame: engine frame without event: line", () => {
  const ev = parseSseFrame(
    'data: {"id":"e1","type":"session.text.delta","data":{"delta":"hi"}}\n',
  );
  assert.ok(ev);
  assert.equal(ev.type, "session.text.delta");
  assert.equal(ev.data.delta, "hi");
});

test("parseSseFrame: heartbeat → undefined", () => {
  assert.equal(parseSseFrame(": heartbeat\n"), undefined);
  assert.equal(parseSseFrame(""), undefined);
});

test("parseSlashCommand", () => {
  assert.deepEqual(tuiParseSlash("/sandbox"), { cmd: "sandbox", arg: "" });
  assert.deepEqual(tuiParseSlash("/model p1/m1"), { cmd: "model", arg: "p1/m1" });
  assert.equal(tuiParseSlash("hello"), undefined);
  // the CLI's interactive loop uses the same helper
  assert.deepEqual(tuiParseSlash("/plan"), { cmd: "plan", arg: "" });
});

// ---------------------------------------------------------------------------
// New slash commands: parsing
// ---------------------------------------------------------------------------

test("parseSlashCommand: all new commands, aliases, case-insensitive", () => {
  assert.deepEqual(slashParse("/btw what is x"), { cmd: "btw", arg: "what is x" });
  assert.deepEqual(slashParse("/fork"), { cmd: "fork", arg: "" });
  assert.deepEqual(slashParse("/branch"), { cmd: "branch", arg: "" });
  assert.deepEqual(slashParse("/duplicate"), { cmd: "duplicate", arg: "" });
  assert.deepEqual(slashParse("/rewind 2"), { cmd: "rewind", arg: "2" });
  assert.deepEqual(slashParse("/undo"), { cmd: "undo", arg: "" });
  assert.deepEqual(slashParse("/restore"), { cmd: "restore", arg: "" });
  assert.deepEqual(slashParse("/usage"), { cmd: "usage", arg: "" });
  assert.deepEqual(slashParse("/resume abc123"), { cmd: "resume", arg: "abc123" });
  assert.deepEqual(slashParse("/detach"), { cmd: "detach", arg: "" });
  assert.deepEqual(slashParse("/auto-review off"), { cmd: "auto-review", arg: "off" });
  assert.deepEqual(slashParse("/mcp"), { cmd: "mcp", arg: "" });
  assert.deepEqual(slashParse("/add-dir /tmp/x"), { cmd: "add-dir", arg: "/tmp/x" });
  assert.deepEqual(slashParse("/save-workspace w1"), { cmd: "save-workspace", arg: "w1" });
  assert.deepEqual(slashParse("/load-workspace w1"), { cmd: "load-workspace", arg: "w1" });
  assert.deepEqual(slashParse("/config set trust on"), { cmd: "config", arg: "set trust on" });
  assert.deepEqual(slashParse("/trust"), { cmd: "trust", arg: "" });
  assert.deepEqual(slashParse("/OPUS"), { cmd: "opus", arg: "" });
  assert.deepEqual(slashParse("/Composer"), { cmd: "composer", arg: "" });
  assert.deepEqual(slashParse("/FAST"), { cmd: "fast", arg: "" });
  assert.deepEqual(slashParse("/skills"), { cmd: "skills", arg: "" });
  assert.deepEqual(slashParse("/skill pdf"), { cmd: "skill", arg: "pdf" });
  // tui.ts re-exports the same parser
  assert.deepEqual(tuiParseSlash("/btw hi"), { cmd: "btw", arg: "hi" });
});

// ---------------------------------------------------------------------------
// New slash commands: handlers driven by a fake SlashRuntime
// ---------------------------------------------------------------------------

/** Hermetic ~/.ide-code for one test; returns a cleanup function. */
function tempHome(): () => void {
  const prev = process.env.IDE_CODE_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ide-cli-slash-test-"));
  process.env.IDE_CODE_HOME = dir;
  return () => {
    if (prev === undefined) {
      delete process.env.IDE_CODE_HOME;
    } else {
      process.env.IDE_CODE_HOME = prev;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  };
}

function fakeSlashRuntime(overrides: Partial<SlashRuntime> = {}) {
  const out = capture();
  const err = capture();
  const calls: {
    setModel: string[];
    compact: number;
    pendingSkill?: { name: string; content: string };
  } = { setModel: [], compact: 0 };
  let autoReview = false;
  let trust = false;
  const rt: SlashRuntime = {
    out: out.stream,
    err: err.stream,
    getMode: () => "agent",
    setMode: async () => {},
    setModel: async (name: string) => {
      calls.setModel.push(name);
      return undefined;
    },
    statusLine: () => "session: ses_cur  mode: agent  model: (engine default)",
    autoDecidePermission: async () => undefined,
    promptPermission: async () => "reject",
    runTurnWith: async (): Promise<TurnResult> => {
      throw new Error("runTurnWith must not be called by slash handlers");
    },
    runReadOnlyTurn: async (text: string, render: TurnRenderHooks): Promise<TurnResult> => {
      // Simulate the real streaming behavior: the answer arrives via deltas.
      const answer = `side answer to: ${text}`;
      render.onTextDelta(answer);
      return { text: answer, endKind: "succeeded" };
    },
    withTurnActive: async (fn) => fn(),
    currentSessionID: () => "ses_cur",
    forkCurrentSession: async () => ({ from: "ses_cur", to: "ses_fork" }),
    attachSession: async (id: string) => `title of ${id}`,
    detachCurrentSession: async () => ({ id: "ses_cur", title: "cur title" }),
    getEngineConfig: async () => ({}),
    listModels: async () => [],
    compactCurrentSession: async () => {
      calls.compact += 1;
      return "ses_cur";
    },
    getAutoReview: () => autoReview,
    setAutoReview: (on: boolean) => {
      autoReview = on;
    },
    getTrust: () => trust,
    setTrust: (on: boolean) => {
      trust = on;
    },
    listSkills: () => [],
    attachSkill: async () => ({ error: "no skill" }),
    setPendingSkill: (name: string, content: string) => {
      calls.pendingSkill = { name, content };
    },
    getTurnLog: () => [] as TurnLogEntry[],
    ...overrides,
  };
  return {
    rt,
    calls,
    outText: () => out.text,
    errText: () => err.text,
    get autoReview() {
      return autoReview;
    },
    get trust() {
      return trust;
    },
  };
}

test("slash /help lists every new command", async () => {
  const f = fakeSlashRuntime();
  const action = await handleSlashCommand({ cmd: "help", arg: "" }, f.rt);
  assert.equal(action, "continue");
  for (const c of [
    "/btw", "/context", "/fork", "/rewind", "/usage", "/resume", "/detach",
    "/auto-review", "/mcp", "/add-dir", "/save-workspace", "/load-workspace",
    "/config", "/trust", "/opus", "/composer", "/fast", "/skills", "/skill",
    "/summarize",
  ]) {
    assert.ok(f.outText().includes(c), `help should list ${c}`);
  }
});

test("slash /summarize compacts via the runtime; /compact and /compress aliases execute directly", async () => {
  for (const cmd of ["summarize", "compact", "compress"]) {
    const f = fakeSlashRuntime();
    const action = await handleSlashCommand({ cmd, arg: "" }, f.rt);
    assert.equal(action, "continue", cmd);
    assert.equal(f.calls.compact, 1, `${cmd} must execute compaction directly`);
    assert.ok(f.outText().includes("summarized session ses_cur"), f.outText());
    assert.equal(f.errText(), "", f.errText());
  }
});

test("slash /summarize reports a compaction failure honestly", async () => {
  const f = fakeSlashRuntime({
    compactCurrentSession: async () => {
      throw new Error("no active session in this mode yet — send a message first, then /summarize");
    },
  });
  const action = await handleSlashCommand({ cmd: "summarize", arg: "" }, f.rt);
  assert.equal(action, "continue");
  assert.ok(f.errText().includes("could not summarize the session"), f.errText());
  assert.ok(f.errText().includes("no active session"), f.errText());
});

test("slash unknown command and /exit /quit", async () => {
  const f = fakeSlashRuntime();
  assert.equal(await handleSlashCommand({ cmd: "frobnicate", arg: "" }, f.rt), "continue");
  assert.ok(f.errText().includes("unknown command"));
  assert.equal(await handleSlashCommand({ cmd: "exit", arg: "" }, f.rt), "exit");
  assert.equal(await handleSlashCommand({ cmd: "quit", arg: "" }, f.rt), "exit");
});

test("slash /btw runs a read-only side turn; main history untouched", async () => {
  const f = fakeSlashRuntime();
  const action = await handleSlashCommand({ cmd: "btw", arg: "what is 2+2" }, f.rt);
  assert.equal(action, "continue");
  assert.ok(f.outText().includes("side answer to: what is 2+2"));
  assert.ok(f.outText().includes("history untouched"));
});

test("slash /btw without a question prints usage and runs nothing", async () => {
  let readOnlyCalled = false;
  const f = fakeSlashRuntime({
    runReadOnlyTurn: async (): Promise<TurnResult> => {
      readOnlyCalled = true;
      throw new Error("must not run");
    },
  });
  await handleSlashCommand({ cmd: "btw", arg: "" }, f.rt);
  assert.equal(readOnlyCalled, false);
  assert.ok(f.errText().includes("usage: /btw"));
});

test("slash /context shows a local estimate and the honest limitation", async () => {
  const f = fakeSlashRuntime({
    getTurnLog: () => [
      { n: 1, promptPreview: "hello", at: Date.now(), endKind: "succeeded", toolCalls: 2 },
      { n: 2, promptPreview: "do it", at: Date.now(), endKind: "failed", toolCalls: 0 },
    ],
  });
  await handleSlashCommand({ cmd: "context", arg: "" }, f.rt);
  const out = f.outText();
  assert.ok(out.includes("turns:       2 (1 succeeded, 1 failed, 0 interrupted)"));
  assert.ok(out.includes("tool calls:  2"));
  assert.ok(out.includes("the engine exposes no usage API"));
  assert.ok(out.includes("ses_cur"));
});

test("slash /rewind lists the timeline; restore is honestly unsupported", async () => {
  const f = fakeSlashRuntime({
    getTurnLog: () => [
      { n: 1, promptPreview: "hello", at: 1_700_000_000_000, endKind: "succeeded", toolCalls: 1 },
      { n: 2, promptPreview: "do the thing", at: 1_700_000_060_000, endKind: "interrupted", toolCalls: 0 },
    ],
  });
  await handleSlashCommand({ cmd: "rewind", arg: "" }, f.rt);
  const out = f.outText();
  assert.ok(out.includes("#1"));
  assert.ok(out.includes("#2"));
  assert.ok(out.includes("succeeded"));
  assert.ok(out.includes("1 tool call"));
  assert.ok(out.includes("no session-restore API"));
  // /rewind <n> (and the /undo alias) are refused honestly
  const f2 = fakeSlashRuntime();
  await handleSlashCommand({ cmd: "rewind", arg: "1" }, f2.rt);
  assert.ok(f2.errText().includes("no session-restore API"));
  const f3 = fakeSlashRuntime();
  await handleSlashCommand({ cmd: "undo", arg: "" }, f3.rt);
  assert.ok(f3.outText().includes("no turns yet"));
});

test("slash /fork branches the session (and aliases)", async () => {
  for (const cmd of ["fork", "branch", "duplicate"]) {
    const f = fakeSlashRuntime();
    assert.equal(await handleSlashCommand({ cmd, arg: "" }, f.rt), "continue");
    assert.ok(f.outText().includes("ses_cur → ses_fork"), cmd);
    assert.ok(f.outText().includes("parentID"), cmd);
  }
});

test("slash /fork with no active session errors honestly", async () => {
  const f = fakeSlashRuntime({
    forkCurrentSession: async () => {
      throw new Error("no active session in this mode yet");
    },
  });
  await handleSlashCommand({ cmd: "fork", arg: "" }, f.rt);
  assert.ok(f.errText().includes("no active session"));
});

test("slash /usage reports local stats with the no-cloud-billing note", async () => {
  const restore = tempHome();
  try {
    const f = fakeSlashRuntime();
    await handleSlashCommand({ cmd: "usage", arg: "" }, f.rt);
    const out = f.outText();
    assert.ok(out.includes("no cloud billing"));
    assert.ok(out.includes("saved sessions:            0"));
    assert.ok(out.includes("turns this TUI session:    0"));
  } finally {
    restore();
  }
});

test("slash /resume with an empty registry", async () => {
  const restore = tempHome();
  try {
    const f = fakeSlashRuntime();
    await handleSlashCommand({ cmd: "resume", arg: "" }, f.rt);
    assert.ok(f.outText().includes("no saved sessions yet"));
  } finally {
    restore();
  }
});

test("slash /resume lists, picks by number, and attaches", async () => {
  const restore = tempHome();
  try {
    recordSession({ id: "ses_aaa111", title: "first chat", createdAt: 1, lastUsedAt: 100, cwd: "/tmp", mode: "agent" });
    recordSession({ id: "ses_bbb222", title: "second chat", createdAt: 2, lastUsedAt: 200, cwd: "/tmp", mode: "plan" });
    const f = fakeSlashRuntime();
    await handleSlashCommand({ cmd: "resume", arg: "" }, f.rt);
    const list = f.outText();
    assert.ok(list.includes("ses_bbb222"), "most recent first");
    assert.ok(list.indexOf("ses_bbb222") < list.indexOf("ses_aaa111"));
    let attached = "";
    f.rt.attachSession = async (id: string) => {
      attached = id;
      return "second chat";
    };
    await handleSlashCommand({ cmd: "resume", arg: "1" }, f.rt);
    assert.equal(attached, "ses_bbb222");
    assert.ok(f.outText().includes("resumed session ses_bbb222"));
    // mode mismatch (plan session in agent view) is disclosed, not hidden
    assert.ok(f.errText().includes("plan"));
    // id-prefix match
    const f2 = fakeSlashRuntime();
    let attached2 = "";
    f2.rt.attachSession = async (id: string) => {
      attached2 = id;
      return "first chat";
    };
    await handleSlashCommand({ cmd: "resume", arg: "ses_aaa" }, f2.rt);
    assert.equal(attached2, "ses_aaa111");
    // unknown id
    const f3 = fakeSlashRuntime();
    await handleSlashCommand({ cmd: "resume", arg: "zzz" }, f3.rt);
    assert.ok(f3.errText().includes("no saved session matches"));
  } finally {
    restore();
  }
});

test("slash /resume reports a stale engine session honestly", async () => {
  const restore = tempHome();
  try {
    recordSession({ id: "ses_gone", title: "gone", createdAt: 1, lastUsedAt: 1, cwd: "/tmp", mode: "agent" });
    const f = fakeSlashRuntime({
      attachSession: async () => {
        throw new Error('session "ses_gone" not found on the engine');
      },
    });
    await handleSlashCommand({ cmd: "resume", arg: "ses_gone" }, f.rt);
    assert.ok(f.errText().includes("no longer has session ses_gone"));
  } finally {
    restore();
  }
});

test("slash /detach saves the session and exits the loop", async () => {
  const f = fakeSlashRuntime();
  const action = await handleSlashCommand({ cmd: "detach", arg: "" }, f.rt);
  assert.equal(action, "exit");
  assert.ok(f.outText().includes("ses_cur"));
  assert.ok(f.outText().includes("/resume"));
});

test("slash /auto-review toggles, sets, and validates", async () => {
  const f = fakeSlashRuntime();
  await handleSlashCommand({ cmd: "auto-review", arg: "" }, f.rt);
  assert.equal(f.autoReview, true);
  assert.ok(f.outText().includes("auto-review: on"));
  await handleSlashCommand({ cmd: "auto-review", arg: "off" }, f.rt);
  assert.equal(f.autoReview, false);
  assert.ok(f.outText().includes("auto-review: off"));
  await handleSlashCommand({ cmd: "auto-review", arg: "bogus" }, f.rt);
  assert.ok(f.errText().includes("usage: /auto-review"));
});

test("slash /trust toggles with the honest no-gate note", async () => {
  const f = fakeSlashRuntime();
  await handleSlashCommand({ cmd: "trust", arg: "" }, f.rt);
  assert.equal(f.trust, true);
  assert.ok(f.errText().includes("no workspace-trust gate"));
  await handleSlashCommand({ cmd: "trust", arg: "off" }, f.rt);
  assert.equal(f.trust, false);
});

test("slash /mcp is honest when the engine exposes no MCP list", async () => {
  const f = fakeSlashRuntime({ getEngineConfig: async () => ({}) });
  await handleSlashCommand({ cmd: "mcp", arg: "" }, f.rt);
  assert.ok(f.errText().includes("exposes no MCP server list"));
});

test("slash /mcp groups servers by scope when the engine reports them", async () => {
  const f = fakeSlashRuntime({
    getEngineConfig: async () => ({
      mcp: {
        filesystem: { type: "local" },
        github: { scope: "project", type: "remote" },
      },
    }),
  });
  await handleSlashCommand({ cmd: "mcp", arg: "" }, f.rt);
  const out = f.outText();
  assert.ok(out.includes("[local]"), out);
  assert.ok(out.includes("[project]"), out);
  assert.ok(out.includes("filesystem"), out);
  assert.ok(out.includes("github"), out);
});

test("extractMcpServers: shapes and scope grouping", () => {
  assert.equal(extractMcpServers(undefined), undefined);
  assert.equal(extractMcpServers(null), undefined);
  assert.equal(extractMcpServers({}), undefined);
  assert.equal(extractMcpServers({ mcp: {} })?.length, 0);
  assert.deepEqual(extractMcpServers({ mcp: { a: { type: "local" }, b: { scope: "user" } } }), [
    { name: "a", scope: "local" },
    { name: "b", scope: "user" },
  ]);
  assert.deepEqual(extractMcpServers({ mcpServers: [{ name: "x" }, "y"] }), [
    { name: "x", scope: "default" },
    { name: "y", scope: "default" },
  ]);
});

test("slash /config show/get/set round-trip", async () => {
  const restore = tempHome();
  try {
    const f = fakeSlashRuntime();
    await handleSlashCommand({ cmd: "config", arg: "" }, f.rt);
    assert.ok(f.outText().includes("subagentModel"));
    assert.ok(f.outText().includes("modelSlashCommands"));
    await handleSlashCommand({ cmd: "config", arg: "set trust on" }, f.rt);
    assert.equal(loadAgentConfig().trust, true);
    assert.ok(f.outText().includes("set trust = on"));
    await handleSlashCommand({ cmd: "config", arg: "get trust" }, f.rt);
    assert.ok(f.outText().includes("trust = true"));
    await handleSlashCommand({ cmd: "config", arg: "set subagentModel disabled" }, f.rt);
    assert.equal(loadAgentConfig().subagentModel, "disabled");
    await handleSlashCommand({ cmd: "config", arg: "set bogus on" }, f.rt);
    assert.ok(f.errText().includes("unknown config key"));
    await handleSlashCommand({ cmd: "config", arg: "set trust maybe" }, f.rt);
    assert.ok(f.errText().includes("must be on|off"));
    await handleSlashCommand({ cmd: "config", arg: "get" }, f.rt);
    assert.ok(f.errText().includes("usage: /config get"));
  } finally {
    restore();
  }
});

test("slash /add-dir validates the path and records real directories", async () => {
  const restore = tempHome();
  try {
    const f = fakeSlashRuntime();
    await handleSlashCommand({ cmd: "add-dir", arg: "/does/not/exist-xyz" }, f.rt);
    assert.ok(f.errText().includes("directory not found"));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-"));
    try {
      const f2 = fakeSlashRuntime();
      await handleSlashCommand({ cmd: "add-dir", arg: dir }, f2.rt);
      assert.ok(f2.outText().includes("added to workspace"));
      assert.deepEqual(workspaceDirs(), [dir]);
      // no-arg form lists
      const f3 = fakeSlashRuntime();
      await handleSlashCommand({ cmd: "add-dir", arg: "" }, f3.rt);
      assert.ok(f3.outText().includes(dir));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    restore();
  }
});

test("slash /save-workspace and /load-workspace round-trip", async () => {
  const restore = tempHome();
  const prevCwd = process.cwd();
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-"));
    try {
      const f = fakeSlashRuntime();
      await handleSlashCommand({ cmd: "add-dir", arg: dir }, f.rt);
      await handleSlashCommand({ cmd: "save-workspace", arg: "proj" }, f.rt);
      assert.ok(listWorkspaceNames().includes("proj"));
      assert.ok(f.outText().includes('"proj"'));
      const f2 = fakeSlashRuntime();
      await handleSlashCommand({ cmd: "load-workspace", arg: "proj" }, f2.rt);
      assert.equal(activeWorkspaceName(), "proj");
      assert.equal(process.cwd(), dir);
      assert.ok(f2.outText().includes("cwd is now"));
      const f3 = fakeSlashRuntime();
      await handleSlashCommand({ cmd: "load-workspace", arg: "nope" }, f3.rt);
      assert.ok(f3.errText().includes("unknown workspace"));
      const f4 = fakeSlashRuntime();
      await handleSlashCommand({ cmd: "save-workspace", arg: "" }, f4.rt);
      assert.ok(f4.errText().includes("usage: /save-workspace"));
    } finally {
      process.chdir(prevCwd);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    restore();
  }
});

test("slash /opus /composer /fast map to the engine model list", async () => {
  const restore = tempHome();
  try {
    const models = [
      { id: "a", modelID: "claude-opus-4-1", providerID: "anthropic", name: "Claude Opus" },
      { id: "b", modelID: "gpt-5-mini", providerID: "openai", name: "GPT-5 mini" },
    ];
    const f = fakeSlashRuntime({ listModels: async () => models });
    await handleSlashCommand({ cmd: "opus", arg: "" }, f.rt);
    assert.deepEqual(f.calls.setModel, ["claude-opus-4-1"]);
    assert.ok(f.outText().includes("via /opus"));
    const f2 = fakeSlashRuntime({ listModels: async () => models });
    await handleSlashCommand({ cmd: "composer", arg: "" }, f2.rt);
    assert.deepEqual(f2.calls.setModel, []);
    assert.ok(f2.errText().includes('no model matching "composer"'));
    const f3 = fakeSlashRuntime({ listModels: async () => [models[0]] });
    await handleSlashCommand({ cmd: "fast", arg: "" }, f3.rt);
    assert.ok(f3.errText().includes("no model matching"));
    assert.ok(f3.errText().includes("no speed or pricing metadata"));
    const f4 = fakeSlashRuntime({ listModels: async () => models });
    await handleSlashCommand({ cmd: "fast", arg: "" }, f4.rt);
    assert.deepEqual(f4.calls.setModel, ["gpt-5-mini"]);
  } finally {
    restore();
  }
});

test("slash model shortcuts respect /config modelSlashCommands=off", async () => {
  const restore = tempHome();
  try {
    saveAgentConfig({ ...DEFAULT_AGENT_CONFIG, modelSlashCommands: false });
    const f = fakeSlashRuntime({
      listModels: async () => [{ id: "a", modelID: "x-opus", providerID: "p", name: "Opus" }],
    });
    await handleSlashCommand({ cmd: "opus", arg: "" }, f.rt);
    assert.deepEqual(f.calls.setModel, []);
    assert.ok(f.errText().includes("is disabled"));
  } finally {
    restore();
  }
});

test("slash /skills lists and /skill stages one-shot", async () => {
  const f = fakeSlashRuntime({
    listSkills: () => [{ name: "pdf", description: "read PDFs" }],
    attachSkill: async (name: string) =>
      name === "pdf" ? { content: "# PDF skill" } : { error: `no skill named ${JSON.stringify(name)}` },
  });
  await handleSlashCommand({ cmd: "skills", arg: "" }, f.rt);
  assert.ok(f.outText().includes("pdf — read PDFs"));
  await handleSlashCommand({ cmd: "skill", arg: "pdf" }, f.rt);
  assert.deepEqual(f.calls.pendingSkill, { name: "pdf", content: "# PDF skill" });
  assert.ok(f.outText().includes("one-shot"));
  const f2 = fakeSlashRuntime({
    listSkills: () => [],
    attachSkill: async () => ({ error: 'no skill named "nope"' }),
  });
  await handleSlashCommand({ cmd: "skills", arg: "" }, f2.rt);
  assert.ok(f2.outText().includes("no skills found"));
  await handleSlashCommand({ cmd: "skill", arg: "nope" }, f2.rt);
  assert.ok(f2.errText().includes("no skill named"));
});

// ---------------------------------------------------------------------------
// agent-config.ts
// ---------------------------------------------------------------------------

test("agent-config: defaults, validation, persistence", () => {
  const restore = tempHome();
  try {
    assert.deepEqual(loadAgentConfig(), DEFAULT_AGENT_CONFIG);
    assert.equal(setAgentConfigValue("subagentModel", "disabled"), undefined);
    assert.equal(loadAgentConfig().subagentModel, "disabled");
    assert.equal(setAgentConfigValue("subagentModel", "anthropic/claude-opus-4-1"), undefined);
    assert.equal(loadAgentConfig().subagentModel, "anthropic/claude-opus-4-1");
    assert.equal(
      setAgentConfigValue("subagentModel", ""),
      "subagentModel must be default|disabled|inherit or a model id",
    );
    assert.equal(setAgentConfigValue("autoReview", "on"), undefined);
    assert.equal(loadAgentConfig().autoReview, true);
    assert.equal(setAgentConfigValue("autoReview", "off"), undefined);
    assert.ok(setAgentConfigValue("autoReview", "maybe") !== undefined);
    assert.ok(setAgentConfigValue("nope", "x") !== undefined);
    const shown = formatAgentConfig();
    assert.ok(shown.includes("subagentModel"));
    assert.ok(shown.includes("modelSlashCommands  on"));
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// workspaces.ts
// ---------------------------------------------------------------------------

test("workspaces: name validation and add/remove dir", () => {
  const restore = tempHome();
  try {
    assert.equal(validateWorkspaceName(""), "workspace name must not be empty");
    assert.ok(validateWorkspaceName("bad name!") !== undefined);
    assert.equal(validateWorkspaceName("proj-1"), undefined);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-"));
    try {
      assert.equal(addDirToWorkspace(dir), undefined);
      assert.deepEqual(workspaceDirs(), [dir]);
      // adding twice does not duplicate
      assert.equal(addDirToWorkspace(dir), undefined);
      assert.deepEqual(workspaceDirs(), [dir]);
      assert.equal(removeDirFromWorkspace(dir), undefined);
      assert.deepEqual(workspaceDirs(), []);
      assert.ok(removeDirFromWorkspace(dir) !== undefined);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// isAutoReviewable (cli.ts): /auto-review permission policy
// ---------------------------------------------------------------------------

test("isAutoReviewable: shell/mcp/fetch yes; edit no; lists respected", () => {
  const req = (action: string) => ({ id: "r", sessionID: "s", action, resources: [] as string[] });
  assert.equal(isAutoReviewable(req("shell"), {}), true);
  assert.equal(isAutoReviewable(req("mcp__fs__read"), {}), true);
  assert.equal(isAutoReviewable(req("webfetch"), {}), true);
  assert.equal(isAutoReviewable(req("websearch"), {}), true);
  assert.equal(isAutoReviewable(req("edit"), {}), false);
  assert.equal(isAutoReviewable(req("subagent"), {}), false);
  assert.equal(isAutoReviewable(req("shell"), { toolDenylist: ["shell"] }), false);
  assert.equal(isAutoReviewable(req("shell"), { toolDenylist: ["SHELL"] }), false);
  assert.equal(isAutoReviewable(req("shell"), { toolAllowlist: ["webfetch"] }), false);
  assert.equal(isAutoReviewable(req("webfetch"), { toolAllowlist: ["webfetch"] }), true);
  assert.equal(isAutoReviewable(req("shell"), { toolAllowlist: [] }), false);
});

// ---------------------------------------------------------------------------
// Subcommand parsing: persist / ls / plugin / --resume / --version
// ---------------------------------------------------------------------------

test("parseArgs: persist/ls/plugin subcommands and their args", () => {
  const p = parseArgs(["persist", "attach", "abc123"]);
  assert.ok("flags" in p);
  assert.equal(p.flags.subcommand, "persist");
  assert.deepEqual(p.flags.subcommandArgs, ["attach", "abc123"]);

  const l = parseArgs(["ls", "--format", "json"]);
  assert.ok("flags" in l && l.flags.subcommand === "ls");
  assert.equal(l.flags.pluginFormat, "json");

  const pl = parseArgs(["plugin", "marketplace", "add", "https://example.com/m.git", "--git-ref", "v1"]);
  assert.ok("flags" in pl && pl.flags.subcommand === "plugin");
  assert.deepEqual(pl.flags.subcommandArgs, ["marketplace", "add", "https://example.com/m.git"]);
  assert.equal(pl.flags.gitRef, "v1");
});

test("parseArgs: --resume with and without id", () => {
  const r1 = parseArgs(["--resume"]);
  assert.ok("flags" in r1 && r1.flags.resume === true);
  assert.equal(r1.flags.resumeId, undefined);
  const r2 = parseArgs(["--resume", "abc123"]);
  assert.ok("flags" in r2 && r2.flags.resume === true);
  assert.equal(r2.flags.resumeId, "abc123");
});

test("parseArgs: --continue is --resume with no id (and takes no value)", () => {
  const r = parseArgs(["--continue"]);
  assert.ok("flags" in r && r.flags.resume === true);
  assert.equal(r.flags.resumeId, undefined);
  // A following token is NOT swallowed as an id — it stays a positional.
  const r2 = parseArgs(["--continue", "fix the bug"]);
  assert.ok("flags" in r2 && r2.flags.resume === true);
  assert.equal(r2.flags.resumeId, undefined);
  assert.deepEqual(r2.flags.positional, ["fix the bug"]);
});

test("parseArgs: models / resume subcommands and --list-models", () => {
  const m = parseArgs(["models"]);
  assert.ok("flags" in m && m.flags.subcommand === "models");

  const lm = parseArgs(["--list-models"]);
  assert.ok("flags" in lm && lm.flags.listModels === true);

  const r0 = parseArgs(["resume"]);
  assert.ok("flags" in r0 && r0.flags.subcommand === "resume");
  assert.deepEqual(r0.flags.subcommandArgs, []);

  const r1 = parseArgs(["resume", "abc123"]);
  assert.ok("flags" in r1 && r1.flags.subcommand === "resume");
  assert.deepEqual(r1.flags.subcommandArgs, ["abc123"]);
});

test("parseArgs: --auto-review, --tools, --disallowed-tools", () => {
  const r = parseArgs(["--auto-review", "--tools", "shell,webfetch", "--disallowed-tools", "edit"]);
  assert.ok("flags" in r);
  assert.equal(r.flags.autoReview, true);
  assert.deepEqual(r.flags.toolAllowlist, ["shell", "webfetch"]);
  assert.deepEqual(r.flags.toolDenylist, ["edit"]);

  const t = parseArgs(["--tools", "[]"]);
  assert.ok("flags" in t);
  assert.deepEqual(t.flags.toolAllowlist, []);
});

test("parseArgs: --version / -V", () => {
  for (const argv of [["--version"], ["-V"]]) {
    const r = parseArgs(argv);
    assert.ok("flags" in r && r.flags.version === true, argv.join(" "));
  }
});

test("parseArgs: honest errors for &, --computer-use, --admin*", () => {
  const amp = parseArgs(["&"]);
  assert.ok("error" in amp && amp.error.includes("cloud"));

  const cu = parseArgs(["--computer-use"]);
  assert.ok("error" in cu && cu.error.includes("computer-use"));

  for (const argv of [["--admin"], ["--admin-restrict"], ["--admin=x"]]) {
    const r = parseArgs(argv);
    assert.ok("error" in r, argv.join(" "));
    assert.ok(
      (r as { error: string }).error.includes("admin"),
      `expected an admin-gating message for ${argv.join(" ")}`,
    );
  }
});

test("cliVersion: matches package.json", () => {
  assert.equal(cliVersion(), "0.1.0");
});

test("--version prints without touching the engine", async () => {
  const out = capture();
  const err = capture();
  const code = await runAgent(["--version"], {
    out: out.stream,
    err: err.stream,
    isTTY: false,
    clientFactory: () => Promise.reject(new Error("must not start the engine for --version")),
  });
  assert.equal(code, 0);
  assert.ok(out.text.includes("ide-code agent"), out.text);
  assert.ok(out.text.includes("0.1.0"), out.text);
});

// ---------------------------------------------------------------------------
// Shared permission policy (autoDecidePermission)
// ---------------------------------------------------------------------------

test("policy: --disallowed-tools beats --force (hard constraint)", async () => {
  const req = { id: "r", sessionID: "s", action: "shell", resources: [] as string[], message: "rm x" };
  const d = await autoDecidePermission(req, { force: true, toolDenylist: ["shell"] });
  assert.equal(d, "reject");
});

test("policy: --tools [] denies every tool (text-only)", async () => {
  const req = { id: "r", sessionID: "s", action: "webfetch", resources: [] as string[] };
  const d = await autoDecidePermission(req, { toolAllowlist: [] });
  assert.equal(d, "reject");
});

test("policy: --tools restricts to its allowlist", async () => {
  const shell = { id: "r", sessionID: "s", action: "shell", resources: [] as string[] };
  const edit = { id: "r", sessionID: "s", action: "edit", resources: [] as string[] };
  assert.equal(await autoDecidePermission(shell, { toolAllowlist: ["shell"] }), undefined);
  assert.equal(await autoDecidePermission(edit, { toolAllowlist: ["shell"] }), "reject");
});

test("policy: --auto-review approves allowlisted actions in print mode", async () => {
  const shell = {
    id: "r",
    sessionID: "s",
    action: "shell",
    resources: [] as string[],
    message: "ls -la",
  };
  assert.equal(await autoDecidePermission(shell, { autoReview: true }), "once");
  const mcp = { id: "r", sessionID: "s", action: "mcp__fs__read_file", resources: [] as string[] };
  assert.equal(await autoDecidePermission(mcp, { autoReview: true }), "once");
  const edit = { id: "r", sessionID: "s", action: "edit", resources: [] as string[] };
  assert.equal(await autoDecidePermission(edit, { autoReview: true }), undefined);
});

test("matchesToolList: wildcards and case-insensitivity", () => {
  assert.ok(matchesToolList("mcp__fs__read", ["mcp__*"]));
  assert.ok(matchesToolList("SHELL", ["shell"]));
  assert.ok(!matchesToolList("edit", ["shell"]));
  assert.ok(matchesToolList("webfetch", ["*fetch"]));
});

test("isRiskyShellCommand: recursive/force/wildcard deletes are risky", () => {
  assert.ok(isRiskyShellCommand("rm -rf /tmp/x"));
  assert.ok(isRiskyShellCommand("rm -r ./build"));
  assert.ok(isRiskyShellCommand("rm *"));
  assert.ok(isRiskyShellCommand("rm $OUT_DIR"));
  assert.ok(isRiskyShellCommand("sudo rm x"));
  assert.ok(!isRiskyShellCommand("ls -la"));
  assert.ok(!isRiskyShellCommand("git status"));
});

test("isAutoReviewable: risky shell commands are not auto-approved", () => {
  const req = (message: string) => ({
    id: "r",
    sessionID: "s",
    action: "shell",
    resources: [] as string[],
    message,
  });
  assert.equal(isAutoReviewable(req("rm -rf /tmp/x"), {}), false);
  assert.equal(isAutoReviewable(req("ls -la"), {}), true);
});

test("print mode: --auto-review approves the mock's shell permission", async () => {
  const mock = await startMockEngine();
  const out = capture();
  const err = capture();
  const code = await runAgent(["-p", "--auto-review", "PERM", "shell"], {
    out: out.stream,
    err: err.stream,
    isTTY: false,
    clientFactory: clientFactoryFor(mock),
  });
  await mock.close();
  assert.equal(code, 0);
  assert.equal(mock.replies.length, 1);
  assert.equal(mock.replies[0].decision, "once");
});

test("print mode: --disallowed-tools beats --yolo", async () => {
  const mock = await startMockEngine();
  const out = capture();
  const err = capture();
  const code = await runAgent(["-p", "--yolo", "--disallowed-tools", "shell", "PERM", "shell"], {
    out: out.stream,
    err: err.stream,
    isTTY: false,
    clientFactory: clientFactoryFor(mock),
  });
  await mock.close();
  assert.equal(code, 0);
  assert.equal(mock.replies.length, 1);
  assert.equal(mock.replies[0].decision, "reject");
});

// ---------------------------------------------------------------------------
// agent ls / persist list
// ---------------------------------------------------------------------------

test("ls: empty registry", async () => {
  resetLocalState();
  const out = capture();
  const err = capture();
  const mock = await startMockEngine();
  const code = await runAgent(["ls"], {
    out: out.stream,
    err: err.stream,
    isTTY: false,
    clientFactory: () => Promise.reject(new Error("ls must not start the engine")),
  });
  await mock.close();
  assert.equal(code, 0);
  assert.ok(out.text.includes("no persisted sessions"), out.text);
});

test("ls: lists seeded sessions across workspaces, --format json parses", async () => {
  resetLocalState();
  seedSession("ses_test", { cwd: "/tmp/work-a", mode: "agent" });
  seedSession("other123", { cwd: "/tmp/work-b", mode: "plan" });
  const out = capture();
  const err = capture();
  const mock = await startMockEngine();
  const code = await runAgent(["ls"], {
    out: out.stream,
    err: err.stream,
    isTTY: false,
    clientFactory: () => Promise.reject(new Error("ls must not start the engine")),
  });
  await mock.close();
  assert.equal(code, 0);
  assert.ok(out.text.includes("/tmp/work-a"), out.text);
  assert.ok(out.text.includes("/tmp/work-b"), out.text);

  const jout = capture();
  const jerr = capture();
  const mock2 = await startMockEngine();
  const code2 = await runAgent(["ls", "--format", "json"], {
    out: jout.stream,
    err: jerr.stream,
    isTTY: false,
    clientFactory: () => Promise.reject(new Error("ls must not start the engine")),
  });
  await mock2.close();
  assert.equal(code2, 0);
  const arr = JSON.parse(jout.text) as Array<{ id: string; cwd: string }>;
  assert.equal(arr.length, 2);
  assert.ok(arr.some((s) => s.id === "ses_test" && s.cwd === "/tmp/work-a"));
});

test("persist list mirrors ls", async () => {
  resetLocalState();
  seedSession("ses_test");
  const out = capture();
  const err = capture();
  const mock = await startMockEngine();
  const code = await runAgent(["persist", "list"], {
    out: out.stream,
    err: err.stream,
    isTTY: false,
    clientFactory: () => Promise.reject(new Error("persist list must not start the engine")),
  });
  await mock.close();
  assert.equal(code, 0);
  assert.ok(out.text.includes("ses_test"), out.text);
});

// ---------------------------------------------------------------------------
// agent persist attach / stop / --resume
// ---------------------------------------------------------------------------

test("persist attach: unknown id fails honestly", async () => {
  resetLocalState();
  const out = capture();
  const err = capture();
  const mock = await startMockEngine();
  const code = await runAgent(["persist", "attach", "bogus-id"], {
    out: out.stream,
    err: err.stream,
    isTTY: false,
    clientFactory: clientFactoryFor(mock),
  });
  await mock.close();
  assert.equal(code, 1);
  assert.ok(
    err.text.includes("no persisted session matches") || err.text.includes("no longer on the engine"),
    err.text,
  );
});

test("persist attach: stale registry entry fails honestly", async () => {
  resetLocalState();
  seedSession("gone123");
  const out = capture();
  const err = capture();
  const mock = await startMockEngine();
  const code = await runAgent(["persist", "attach", "gone123"], {
    out: out.stream,
    err: err.stream,
    isTTY: false,
    clientFactory: clientFactoryFor(mock),
  });
  await mock.close();
  assert.equal(code, 1);
  assert.ok(err.text.includes("no longer on the engine"), err.text);
});

test("persist attach: live session opens the TUI seeded (scripted /exit)", async () => {
  resetLocalState();
  seedSession("ses_test");
  const out = capture();
  const err = capture();
  const mock = await startMockEngine();
  const code = await runAgent(["persist", "attach", "ses_test"], {
    out: out.stream,
    err: err.stream,
    isTTY: true,
    input: Readable.from(["/exit\n"]),
    clientFactory: clientFactoryFor(mock),
  });
  await mock.close();
  assert.equal(code, 0);
  // The seeded session was adopted, not recreated.
  assert.equal(mock.sessionBodies.length, 0);
});

test("persist stop: stops on the engine and unregisters", async () => {
  resetLocalState();
  seedSession("ses_test");
  const out = capture();
  const err = capture();
  const mock = await startMockEngine();
  const code = await runAgent(["persist", "stop", "ses_test"], {
    out: out.stream,
    err: err.stream,
    isTTY: false,
    clientFactory: clientFactoryFor(mock),
  });
  await mock.close();
  assert.equal(code, 0);
  assert.deepEqual(mock.deletedIDs, ["ses_test"]);
  assert.equal(loadRegistry().sessions.length, 0);
  assert.ok(out.text.includes("stopped session"), out.text);
});

test("persist stop: unknown id fails honestly", async () => {
  resetLocalState();
  const out = capture();
  const err = capture();
  const mock = await startMockEngine();
  const code = await runAgent(["persist", "stop", "nope"], {
    out: out.stream,
    err: err.stream,
    isTTY: false,
    clientFactory: clientFactoryFor(mock),
  });
  await mock.close();
  assert.equal(code, 1);
  assert.ok(err.text.includes("no persisted session matches"), err.text);
});

test("print --resume: continues the persisted session without creating one", async () => {
  resetLocalState();
  seedSession("ses_test");
  const out = capture();
  const err = capture();
  const mock = await startMockEngine();
  const code = await runAgent(["--resume", "-p", "hello"], {
    out: out.stream,
    err: err.stream,
    isTTY: false,
    clientFactory: clientFactoryFor(mock),
  });
  await mock.close();
  assert.equal(code, 0);
  assert.equal(out.text.trim(), "hello world");
  assert.equal(mock.sessionBodies.length, 0, "resume must not create a session");
  assert.deepEqual(mock.promptSessionIDs, ["ses_test"]);
  assert.ok(err.text.includes("resuming session"), err.text);
});

test("print --resume: empty registry fails honestly", async () => {
  resetLocalState();
  const out = capture();
  const err = capture();
  const mock = await startMockEngine();
  const code = await runAgent(["--resume", "-p", "hello"], {
    out: out.stream,
    err: err.stream,
    isTTY: false,
    clientFactory: clientFactoryFor(mock),
  });
  await mock.close();
  assert.equal(code, 1);
  assert.ok(err.text.includes("no persisted session to resume"), err.text);
});

test("print --continue: resumes the most recent session, like --resume", async () => {
  resetLocalState();
  seedSession("ses_test");
  const out = capture();
  const err = capture();
  const mock = await startMockEngine();
  const code = await runAgent(["--continue", "-p", "hello"], {
    out: out.stream,
    err: err.stream,
    isTTY: false,
    clientFactory: clientFactoryFor(mock),
  });
  await mock.close();
  assert.equal(code, 0);
  assert.equal(out.text.trim(), "hello world");
  assert.equal(mock.sessionBodies.length, 0, "--continue must not create a session");
  assert.deepEqual(mock.promptSessionIDs, ["ses_test"]);
});

test("print `agent resume [id]`: subcommand spelling of --resume", async () => {
  resetLocalState();
  seedSession("ses_test");
  const mock = await startMockEngine();
  // No id: most recent session.
  const out1 = capture();
  const err1 = capture();
  const code1 = await runAgent(["resume", "-p", "hello"], {
    out: out1.stream,
    err: err1.stream,
    isTTY: false,
    clientFactory: clientFactoryFor(mock),
  });
  assert.equal(code1, 0);
  assert.deepEqual(mock.promptSessionIDs, ["ses_test"]);
  // Explicit id.
  const out2 = capture();
  const err2 = capture();
  const code2 = await runAgent(["resume", "ses_test", "-p", "hello"], {
    out: out2.stream,
    err: err2.stream,
    isTTY: false,
    clientFactory: clientFactoryFor(mock),
  });
  await mock.close();
  assert.equal(code2, 0);
  assert.deepEqual(mock.promptSessionIDs, ["ses_test", "ses_test"]);
  assert.equal(mock.sessionBodies.length, 0, "resume must not create a session");
});

test("`agent resume` with two ids fails before touching the engine", async () => {
  const out = capture();
  const err = capture();
  const code = await runAgent(["resume", "a", "b"], {
    out: out.stream,
    err: err.stream,
    isTTY: false,
    clientFactory: () => Promise.reject(new Error("must not start the engine")),
  });
  assert.equal(code, 1);
  assert.ok(err.text.includes("at most one session id"), err.text);
});

test("`agent models` and --list-models list engine models and exit (no session)", async () => {
  for (const argv of [["models"], ["--list-models"]]) {
    resetLocalState();
    const out = capture();
    const err = capture();
    const mock = await startMockEngine();
    const code = await runAgent(argv, {
      out: out.stream,
      err: err.stream,
      isTTY: false,
      clientFactory: clientFactoryFor(mock),
    });
    await mock.close();
    assert.equal(code, 0, argv.join(" "));
    assert.ok(out.text.includes("models: 1 available"), out.text);
    assert.ok(out.text.includes("p1/m1"), out.text);
    assert.ok(out.text.includes("Test Model 1"), out.text);
    assert.equal(mock.sessionBodies.length, 0, "models must not create a session");
    assert.deepEqual(mock.promptSessionIDs, []);
  }
});

test("interactive /summarize compacts the live session and fires preCompaction hooks", async () => {
  resetLocalState();
  const marker = path.join(TEST_HOME, "precompaction-fired");
  writeHooksFile({ preCompaction: [`touch ${marker}`] });
  const out = capture();
  const err = capture();
  const mock = await startMockEngine();
  const code = await runAgent([], {
    out: out.stream,
    err: err.stream,
    isTTY: true,
    input: Readable.from(["hello\n", "/summarize\n", "/exit\n"]),
    clientFactory: clientFactoryFor(mock),
  });
  await mock.close();
  assert.equal(code, 0, err.text);
  assert.deepEqual(mock.compactedIDs, ["ses_test"]);
  assert.ok(out.text.includes("summarized session ses_test"), out.text);
  assert.ok(fs.existsSync(marker), "preCompaction hook should have fired");
});

test("interactive /summarize before any turn fails honestly (no session yet)", async () => {
  resetLocalState();
  const out = capture();
  const err = capture();
  const mock = await startMockEngine();
  const code = await runAgent([], {
    out: out.stream,
    err: err.stream,
    isTTY: true,
    input: Readable.from(["/summarize\n", "/exit\n"]),
    clientFactory: clientFactoryFor(mock),
  });
  await mock.close();
  assert.equal(code, 0, err.text);
  assert.deepEqual(mock.compactedIDs, []);
  assert.ok(err.text.includes("no active session"), err.text);
});

test("print mode records the session in the registry", async () => {
  resetLocalState();
  const out = capture();
  const err = capture();
  const mock = await startMockEngine();
  const code = await runAgent(["-p", "hello"], {
    out: out.stream,
    err: err.stream,
    isTTY: false,
    clientFactory: clientFactoryFor(mock),
  });
  await mock.close();
  assert.equal(code, 0);
  const reg = loadRegistry();
  assert.equal(reg.sessions.length, 1);
  assert.equal(reg.sessions[0].id, "ses_test");
});

test("resolveResumeTarget: id, prefix, ambiguity, missing", () => {
  resetLocalState();
  const now = Date.now();
  seedSession("abcdef123", { lastUsedAt: now - 3000 });
  seedSession("abcdef456", { lastUsedAt: now - 2000 });
  seedSession("xyz999", { lastUsedAt: now - 1000 });
  assert.equal(resolveResumeTarget({ resumeId: "abcdef123" }).id, "abcdef123");
  assert.equal(resolveResumeTarget({ resumeId: "xyz" }).id, "xyz999");
  assert.throws(() => resolveResumeTarget({ resumeId: "abcdef" }), /ambiguous/);
  assert.throws(() => resolveResumeTarget({ resumeId: "nope" }), /no persisted session matches/);
  assert.equal(resolveResumeTarget({}).id, "xyz999"); // most recent
  resetLocalState();
  assert.throws(() => resolveResumeTarget({}), /no persisted session to resume/);
});

// ---------------------------------------------------------------------------
// agent plugin marketplace
// ---------------------------------------------------------------------------

test("plugin marketplace add/list/remove round-trip (fake git)", async () => {
  resetLocalState();
  const out = capture();
  const err = capture();
  const deps = { pluginSpawn: fakeGitSpawn(0) };
  const addCode = await runAgent(
    ["plugin", "marketplace", "add", "https://example.com/org/cool.git", "--git-ref", "v1"],
    { out: out.stream, err: err.stream, isTTY: false, ...deps },
  );
  assert.equal(addCode, 0);
  assert.ok(out.text.includes('"cool"') || out.text.includes("cool"), out.text);
  const reg = loadPluginRegistry();
  assert.equal(reg.marketplaces.length, 1);
  assert.equal(reg.marketplaces[0].name, "cool");
  assert.equal(reg.marketplaces[0].ref, "v1");

  const lout = capture();
  const listCode = await runAgent(["plugin", "marketplace", "list"], {
    out: lout.stream,
    err: err.stream,
    isTTY: false,
    ...deps,
  });
  assert.equal(listCode, 0);
  assert.ok(lout.text.includes("cool"), lout.text);
  assert.ok(lout.text.includes("https://example.com/org/cool.git"), lout.text);

  const jout = capture();
  const jsonCode = await runAgent(["plugin", "marketplace", "list", "--format", "json"], {
    out: jout.stream,
    err: err.stream,
    isTTY: false,
    ...deps,
  });
  assert.equal(jsonCode, 0);
  const arr = JSON.parse(jout.text) as Array<{ name: string }>;
  assert.equal(arr[0].name, "cool");

  const rout = capture();
  const rmCode = await runAgent(["plugin", "marketplace", "remove", "cool"], {
    out: rout.stream,
    err: err.stream,
    isTTY: false,
    ...deps,
  });
  assert.equal(rmCode, 0);
  assert.equal(loadPluginRegistry().marketplaces.length, 0);
});

test("plugin marketplace add: git failure is reported honestly", async () => {
  resetLocalState();
  const out = capture();
  const err = capture();
  const code = await runAgent(["plugin", "marketplace", "add", "https://example.com/org/nope.git"], {
    out: out.stream,
    err: err.stream,
    isTTY: false,
    pluginSpawn: fakeGitSpawn(128, "fatal: repository not found"),
  });
  assert.equal(code, 1);
  assert.ok(err.text.includes("git clone failed"), err.text);
  assert.ok(err.text.includes("repository not found"), err.text);
  assert.equal(loadPluginRegistry().marketplaces.length, 0);
});

test("plugin marketplace add: duplicate is refused", async () => {
  resetLocalState();
  const err = capture();
  const deps = { pluginSpawn: fakeGitSpawn(0) };
  const out1 = capture();
  assert.equal(
    await runAgent(["plugin", "marketplace", "add", "https://example.com/org/dup.git"], {
      out: out1.stream,
      err: err.stream,
      isTTY: false,
      ...deps,
    }),
    0,
  );
  const out2 = capture();
  const code = await runAgent(["plugin", "marketplace", "add", "https://example.com/org/dup.git"], {
    out: out2.stream,
    err: err.stream,
    isTTY: false,
    ...deps,
  });
  assert.equal(code, 1);
  assert.ok(err.text.includes("already registered"), err.text);
});

test("plugin marketplace update: ok and failing results", async () => {
  resetLocalState();
  const err = capture();
  const deps = { pluginSpawn: fakeGitSpawn(0) };
  const out1 = capture();
  await runAgent(["plugin", "marketplace", "add", "https://example.com/org/up.git"], {
    out: out1.stream,
    err: err.stream,
    isTTY: false,
    ...deps,
  });
  // Make the clone dir look like a git checkout so update runs pull.
  fs.mkdirSync(path.join(TEST_HOME, ".ide-code", "plugins", "up", ".git"), { recursive: true });

  const uout = capture();
  const okCode = await runAgent(["plugin", "marketplace", "update", "up"], {
    out: uout.stream,
    err: err.stream,
    isTTY: false,
    ...deps,
  });
  assert.equal(okCode, 0);
  assert.ok(uout.text.includes("ok"), uout.text);

  const uout2 = capture();
  const failCode = await runAgent(["plugin", "marketplace", "update", "up", "--format", "json"], {
    out: uout2.stream,
    err: err.stream,
    isTTY: false,
    pluginSpawn: fakeGitSpawn(1, "fatal: no upstream"),
  });
  assert.equal(failCode, 1);
  const results = JSON.parse(uout2.text) as Array<{ ok: boolean }>;
  assert.equal(results[0].ok, false);
});

test("plugin: usage errors", async () => {
  resetLocalState();
  for (const argv of [["plugin"], ["plugin", "marketplace"], ["plugin", "marketplace", "frobnicate"]]) {
    const out = capture();
    const err = capture();
    const code = await runAgent(argv, { out: out.stream, err: err.stream, isTTY: false });
    assert.equal(code, 1, argv.join(" "));
  }
  const out = capture();
  const err = capture();
  const code = await runAgent(["plugin", "marketplace", "remove"], {
    out: out.stream,
    err: err.stream,
    isTTY: false,
  });
  assert.equal(code, 1);
  assert.ok(err.text.includes("requires a <name|url>"), err.text);
});

test("marketplaceNameFromUrl", () => {
  const { strict: eq } = assert;
  void eq;
  assert.equal(marketplaceNameFromUrl("https://github.com/org/repo.git"), "repo");
  assert.equal(marketplaceNameFromUrl("git@github.com:org/repo"), "repo");
  assert.equal(marketplaceNameFromUrl("https://example.com/x/y/"), "y");
});

// ---------------------------------------------------------------------------
// Hooks: loading, env, stop follow-ups, lifecycle wiring
// ---------------------------------------------------------------------------

test("loadHooks: merges global + project, warns on junk", () => {
  resetLocalState();
  writeHooksFile({ sessionStart: ["echo hi"], bogus: ["x"], stop: "not-an-array-ok" });
  const loaded = loadHooks("/nonexistent-project-dir");
  assert.deepEqual(loaded.commands.sessionStart, ["echo hi"]);
  assert.ok(loaded.warnings.some((w) => w.includes("bogus")), loaded.warnings.join(";"));
});

test("runHookEvent: env vars and failure logging", async () => {
  resetLocalState();
  const seen: Array<{ cmd: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  const spawn = ((cmd: string, args: string[], opts: any) => {
    seen.push({ cmd, args, env: opts.env });
    const { EventEmitter } = require("node:events");
    const child = new EventEmitter() as any;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => {
      child.stdout.emit("data", Buffer.from("out1\n"));
      child.emit("close", 0);
    });
    return child;
  }) as GitSpawn;
  const logs: string[] = [];
  const stdouts = await runHookEvent(
    { commands: { sessionStart: [], sessionEnd: [], stop: ["true"], preCompaction: [], subagentStart: [], subagentEnd: [] }, warnings: [] },
    "stop",
    { sessionID: "s1", mode: "agent", cwd: "/tmp/w" },
    { spawn, log: (m) => logs.push(m) },
  );
  assert.deepEqual(stdouts, ["out1\n"]);
  assert.equal(seen[0].env.IDE_CODE_HOOK_EVENT, "stop");
  assert.equal(seen[0].env.IDE_CODE_SESSION_ID, "s1");
  assert.equal(seen[0].env.IDE_CODE_MODE, "agent");
  assert.equal(seen[0].env.IDE_CODE_CWD, "/tmp/w");
  assert.deepEqual(logs, []);
});

test("parseStopFollowUp: extracts the follow-up text", () => {
  assert.equal(parseStopFollowUp(['noise\n{"followUp": "keep going"}\n']), "keep going");
  assert.equal(parseStopFollowUp(["nothing here"]), undefined);
  assert.equal(parseStopFollowUp(['{"followUp": "  "}']), undefined);
});

test("hooks wiring: sessionStart/sessionEnd run around a print turn", async () => {
  resetLocalState();
  const started = path.join(TEST_HOME, "hook-started");
  const ended = path.join(TEST_HOME, "hook-ended");
  writeHooksFile({
    sessionStart: [`touch ${started}`],
    sessionEnd: [`touch ${ended}`],
  });
  const out = capture();
  const err = capture();
  const mock = await startMockEngine();
  const code = await runAgent(["-p", "hello"], {
    out: out.stream,
    err: err.stream,
    isTTY: false,
    clientFactory: clientFactoryFor(mock),
  });
  await mock.close();
  assert.equal(code, 0);
  assert.ok(fs.existsSync(started), "sessionStart hook should have run");
  assert.ok(fs.existsSync(ended), "sessionEnd hook should have run");
  resetLocalState();
});

test("hooks wiring: stop hook follow-up runs a second turn (cap respected)", async () => {
  resetLocalState();
  // Every stop hook asks for exactly one follow-up; the cap is 3, so with a
  // hook that always answers we get 1 + 3 = 4 prompts.
  writeHooksFile({ stop: [`echo '{"followUp": "again"}'`] });
  const out = capture();
  const err = capture();
  const mock = await startMockEngine();
  const code = await runAgent(["-p", "hello"], {
    out: out.stream,
    err: err.stream,
    isTTY: false,
    clientFactory: clientFactoryFor(mock),
  });
  await mock.close();
  assert.equal(code, 0);
  assert.equal(mock.promptSessionIDs.length, 4);
  assert.ok(err.text.includes("follow-up turn (3/3)"), err.text);
  resetLocalState();
});

// ---------------------------------------------------------------------------
// Subagent drain (print mode waits for subagents before exiting)
// ---------------------------------------------------------------------------

test("print mode drains subagents: turn.end comes after subagent.end", async () => {
  resetLocalState();
  const out = capture();
  const err = capture();
  const mock = await startMockEngine();
  const code = await runAgent(["-p", "SUBAGENT", "--output-format", "stream-json"], {
    out: out.stream,
    err: err.stream,
    isTTY: false,
    clientFactory: clientFactoryFor(mock),
  });
  await mock.close();
  assert.equal(code, 0);
  const lines = out.text.trim().split("\n").map((l) => JSON.parse(l));
  const types = lines.map((l: any) => l.type);
  const startIdx = types.indexOf("subagent.start");
  const endIdx = types.indexOf("subagent.end");
  const turnEndIdx = types.indexOf("turn.end");
  assert.ok(startIdx >= 0, "expected a subagent.start line");
  assert.ok(endIdx > startIdx, "expected subagent.end after subagent.start");
  assert.ok(turnEndIdx > endIdx, "turn.end must wait for the subagent drain");
});

// ---------------------------------------------------------------------------
// timedConfirm (mode-switch approvals)
// ---------------------------------------------------------------------------

test("timedConfirm: silence auto-rejects", async () => {
  const err = capture();
  const rl = readline.createInterface({
    input: Readable.from([]),
    output: new Writable({ write(_c, _e, cb) { cb(); } }),
  });
  const ok = await timedConfirm(rl, "switch?", 60, err.stream);
  rl.close();
  assert.equal(ok, false);
  assert.ok(err.text.includes("auto-rejected"), err.text);
});

test("timedConfirm: explicit yes confirms", async () => {
  const err = capture();
  const rl = readline.createInterface({
    input: Readable.from(["y\n"]),
    output: new Writable({ write(_c, _e, cb) { cb(); } }),
  });
  const ok = await timedConfirm(rl, "switch?", 5000, err.stream);
  rl.close();
  assert.equal(ok, true);
});

// ---------------------------------------------------------------------------
// --help documents the new surface
// ---------------------------------------------------------------------------

test("--help lists the new flags and subcommands", async () => {
  resetLocalState();
  const out = capture();
  const err = capture();
  const code = await runAgent(["--help"], {
    out: out.stream,
    err: err.stream,
    isTTY: false,
    clientFactory: () => Promise.reject(new Error("must not start the engine for --help")),
  });
  assert.equal(code, 0);
  const help = out.text;
  for (const flag of [
    "--auto-review",
    "--tools",
    "--disallowed-tools",
    "--resume",
    "--version",
    "--format",
    "--git-ref",
    "persist",
    "plugin",
    "agent ls",
  ]) {
    assert.ok(help.includes(flag), `help should mention ${flag}`);
  }
});

test("persist (bare): starts a persistent session and opens the TUI", async () => {
  resetLocalState();
  const out = capture();
  const err = capture();
  const mock = await startMockEngine();
  const code = await runAgent(["persist"], {
    out: out.stream,
    err: err.stream,
    isTTY: true,
    input: Readable.from(["/exit\n"]),
    clientFactory: clientFactoryFor(mock),
  });
  await mock.close();
  assert.equal(code, 0);
  assert.equal(mock.sessionBodies.length, 1);
  assert.ok(out.text.includes("persistent session ses_test"), out.text);
  assert.ok(out.text.includes("persist attach"), out.text);
  assert.equal(loadRegistry().sessions.length, 1);
  resetLocalState();
});

test("hooks wiring: subagentStart/subagentEnd fire on subagent lifecycle", async () => {
  resetLocalState();
  const started = path.join(TEST_HOME, "sub-started");
  const ended = path.join(TEST_HOME, "sub-ended");
  writeHooksFile({
    subagentStart: [`touch ${started}`],
    subagentEnd: [`touch ${ended}`],
  });
  const out = capture();
  const err = capture();
  const mock = await startMockEngine();
  const code = await runAgent(["-p", "SUBAGENT"], {
    out: out.stream,
    err: err.stream,
    isTTY: false,
    clientFactory: clientFactoryFor(mock),
  });
  await mock.close();
  assert.equal(code, 0);
  // Hook firing is fire-and-forget; poll briefly for the side effects.
  const deadline = Date.now() + 3000;
  while ((!fs.existsSync(started) || !fs.existsSync(ended)) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(fs.existsSync(started), "subagentStart hook should have run");
  assert.ok(fs.existsSync(ended), "subagentEnd hook should have run");
  resetLocalState();
});

test("subagentNestingDefaultEnv: injects Cursor-parity default when unset", () => {
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), "ide-xdg-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ide-cwd-"));
  const prevCwd = process.cwd();
  process.chdir(cwd);
  try {
    const out = subagentNestingDefaultEnv({ XDG_CONFIG_HOME: xdg } as NodeJS.ProcessEnv);
    assert.deepEqual(out, {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ experimental: { subagent_depth: 2 } }),
    });
  } finally {
    process.chdir(prevCwd);
    fs.rmSync(xdg, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("subagentNestingDefaultEnv: skips when env already sets OPENCODE_CONFIG_CONTENT", () => {
  const out = subagentNestingDefaultEnv({
    OPENCODE_CONFIG_CONTENT: '{"experimental":{"subagent_depth":5}}',
  } as NodeJS.ProcessEnv);
  assert.deepEqual(out, {});
});

test("subagentNestingDefaultEnv: skips when a config file sets subagent_depth", () => {
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), "ide-xdg-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ide-cwd-"));
  const prevCwd = process.cwd();
  process.chdir(cwd);
  try {
    fs.mkdirSync(path.join(xdg, "opencode"), { recursive: true });
    fs.writeFileSync(
      path.join(xdg, "opencode", "opencode.json"),
      '{ "experimental": { "subagent_depth": 3 } }',
      "utf8",
    );
    // Note: global dir is <xdg>/opencode — the helper joins "opencode" itself.
    const out = subagentNestingDefaultEnv({ XDG_CONFIG_HOME: xdg } as NodeJS.ProcessEnv);
    assert.deepEqual(out, {});
  } finally {
    process.chdir(prevCwd);
    fs.rmSync(xdg, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("subagentNestingDefaultEnv: skips when the project config sets subagent_depth", () => {
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), "ide-xdg-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ide-cwd-"));
  const prevCwd = process.cwd();
  process.chdir(cwd);
  try {
    fs.writeFileSync(cwd + "/opencode.jsonc", '// local\n{ "experimental": { "subagent_depth": 1 } }', "utf8");
    const out = subagentNestingDefaultEnv({ XDG_CONFIG_HOME: xdg } as NodeJS.ProcessEnv);
    assert.deepEqual(out, {});
  } finally {
    process.chdir(prevCwd);
    fs.rmSync(xdg, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
