/**
 * Functional tests for Debug + Multitask modes (DEV-DEBUG-MULTITASK).
 *
 * Covers dig-debug-multitask-2026-10-19.md: debug = real 6-step loop with a
 * live NDJSON ingest server + ask-gated shell/MCP session ruleset;
 * multitask = real orchestration posture via the engine's `subagent` tool.
 * Zero-placeholder policy: these tests pin behavior that is genuinely
 * different from Agent mode.
 *
 * node:test, zero extra deps. The `vscode` module is stubbed via
 * Module._load interception (no node_modules stub needed, nothing ships).
 *
 * Run after `tsc`:  node --test out/services/test/run-debug-multitask-tests.js
 */
import { describe, it, before, after } from "node:test";
import * as assert from "node:assert";
import Module from "node:module";
import * as http from "node:http";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// ---- vscode API stub (test-only, never packaged) ----
class StubEventEmitter<T> {
  private listeners: Array<(e: T) => void> = [];
  get event() {
    return (listener: (e: T) => void) => {
      this.listeners.push(listener);
      return { dispose: () => undefined };
    };
  }
  fire(e: T): void {
    for (const l of [...this.listeners]) l(e);
  }
  dispose(): void {
    this.listeners = [];
  }
}
const vscodeStub = {
  EventEmitter: StubEventEmitter,
  window: {
    createOutputChannel: () => ({
      appendLine: () => undefined,
      dispose: () => undefined,
      show: () => undefined,
      clear: () => undefined,
    }),
    showWarningMessage: async () => undefined,
  },
  workspace: {
    getConfiguration: () => ({
      get: (_k: string, d: unknown) => d,
      has: () => false,
      update: async () => undefined,
    }),
    workspaceFolders: undefined,
    isTrusted: true,
  },
  Uri: {
    file: (p: string) => ({ fsPath: p, scheme: "file", toString: () => p }),
    joinPath: (base: { fsPath: string }, ...parts: string[]) => ({
      fsPath: [base.fsPath, ...parts].join("/"),
    }),
  },
  Disposable: { from: (...ds: { dispose(): void }[]) => ({ dispose: () => ds.forEach((d) => d.dispose()) }) },
};
const origLoad = (Module as unknown as { _load: Function })._load;
(Module as unknown as { _load: Function })._load = function (
  request: string,
  ...rest: unknown[]
) {
  if (request === "vscode") return vscodeStub;
  return origLoad.call(this, request, ...rest);
};

import {
  MODES,
  MULTITASK_MAX_RUNNING,
  MULTITASK_MODE_INSTRUCTION,
  buildDebugInstruction,
  shouldSuggestDebugMode,
  sessionPermissionsForMode,
  wrapDebugPrompt,
  wrapMultitaskPrompt,
  type DebugModeConfig,
} from "../modeService";
import { DebugServerService } from "../debugServerService";

const TEST_CONFIG: DebugModeConfig = {
  logPath: "/tmp/ide-test/debug-test.ndjson",
  serverEndpoint: "http://127.0.0.1:7242/ingest/test-target",
  sessionId: "debug-test-session",
};

describe("debug/multitask stay pickable (real behavior, not labels)", () => {
  it("debug and multitask remain in the dropdown", () => {
    for (const id of ["debug", "multitask"] as const) {
      const def = MODES.find((m) => m.id === id);
      assert.ok(def, `${id} must exist`);
      assert.strictEqual(def.pickable, true, `${id} must stay pickable — it is implemented real`);
    }
  });

  it("debug keeps Cursor's behavioral flags (autoRun=false, autoFix=false)", () => {
    const debug = MODES.find((m) => m.id === "debug")!;
    assert.strictEqual(debug.autoRun, false);
    assert.strictEqual(debug.autoFix, false);
    assert.strictEqual(debug.shouldAutoApplyIfNoEditTool, true);
  });

  it("multitask keeps Cursor's behavioral flags (autoRun=true, autoFix=false)", () => {
    const mt = MODES.find((m) => m.id === "multitask")!;
    assert.strictEqual(mt.autoRun, true);
    assert.strictEqual(mt.autoFix, false);
    assert.strictEqual(mt.shouldAutoApplyIfNoEditTool, true);
  });
});

describe("wrapDebugPrompt", () => {
  it("embeds the live DebugModeConfig so the model knows where to POST logs", () => {
    const out = wrapDebugPrompt("app crashes on login", TEST_CONFIG);
    assert.ok(out.includes(TEST_CONFIG.serverEndpoint), "must contain the ingest endpoint");
    assert.ok(out.includes(TEST_CONFIG.logPath), "must contain the log path");
    assert.ok(out.includes(TEST_CONFIG.sessionId), "must contain the session id");
    assert.ok(out.includes("Issue to debug:\napp crashes on login"));
  });

  it("implements the documented 6-step debug loop", () => {
    const out = wrapDebugPrompt("x", TEST_CONFIG);
    for (const step of ["EXPLORE", "HYPOTHESIZE", "INSTRUMENT", "ANALYZE", "FIX", "VERIFY + CLEAN UP"]) {
      assert.ok(out.includes(step), `must contain step ${step}`);
    }
  });

  it("requires user confirmation before the fix and mandates instrumentation cleanup", () => {
    const out = wrapDebugPrompt("x", TEST_CONFIG);
    assert.ok(out.includes("user confirmation"), "no auto-fix without asking");
    assert.ok(out.includes("REMOVE ALL instrumentation"), "cleanup is mandatory");
  });

  it("degrades honestly when the ingest server failed to start", () => {
    const out = wrapDebugPrompt("x", undefined);
    assert.ok(!out.includes("undefined"), "no 'undefined' leaks into the prompt");
    assert.ok(
      out.toLowerCase().includes("unavailable"),
      "must tell the model the server is unavailable",
    );
  });

  it("buildDebugInstruction is pure and deterministic", () => {
    assert.strictEqual(buildDebugInstruction(TEST_CONFIG), buildDebugInstruction(TEST_CONFIG));
  });
});

describe("wrapMultitaskPrompt", () => {
  it("is an orchestration posture, not a solo-implementer prompt", () => {
    const out = wrapMultitaskPrompt("build login + dashboard + settings pages");
    assert.ok(out.includes("ORCHESTRATOR"), "must frame the agent as orchestrator");
    assert.ok(out.includes("subagent"), "must name the engine's subagent tool");
    assert.ok(out.includes("background: true"), "must dispatch workers in parallel");
    assert.ok(
      out.includes(String(MULTITASK_MAX_RUNNING)),
      "must state the max_running cap",
    );
    assert.ok(out.includes("Request to orchestrate:\nbuild login + dashboard + settings pages"));
  });

  it("describes real per-worker git worktree orchestration (gap closed)", () => {
    assert.ok(
      MULTITASK_MODE_INSTRUCTION.includes("git worktree"),
      "must describe real per-subtask git worktrees",
    );
    assert.ok(
      !MULTITASK_MODE_INSTRUCTION.includes("no per-worker git worktree isolation yet"),
      "the old honest-gap wording must be gone — workers are worktree-isolated now",
    );
  });

  it("differs from the agent-mode prompt (zero-placeholder check)", () => {
    const out = wrapMultitaskPrompt("x");
    assert.ok(!out.includes("PINPOINT THE ROOT CAUSE"), "must not be the debug prompt");
    assert.ok(out.length > 200, "must be a substantive instruction, not a label");
  });
});

describe("shouldSuggestDebugMode", () => {
  it("matches Cursor's keyword substrings (debug/bug/debugging)", () => {
    assert.strictEqual(shouldSuggestDebugMode("please debug this crash"), true);
    assert.strictEqual(shouldSuggestDebugMode("there is a bug in login"), true);
    assert.strictEqual(shouldSuggestDebugMode("debugging tips for race conditions"), true);
  });

  it("is case-insensitive", () => {
    assert.strictEqual(shouldSuggestDebugMode("DEBUG the flaky test"), true);
  });

  it("does not fire on unrelated requests", () => {
    assert.strictEqual(shouldSuggestDebugMode("add a dark mode toggle"), false);
    assert.strictEqual(shouldSuggestDebugMode("refactor the auth module"), false);
    assert.strictEqual(shouldSuggestDebugMode(""), false);
  });
});

describe("sessionPermissionsForMode — debug ruleset", () => {
  it("shell and MCP resolve to ask (autoRun=false), not deny", () => {
    const rules = sessionPermissionsForMode("debug");
    assert.ok(rules, "debug must have a session ruleset");
    const shell = rules.find((r) => r.action === "shell");
    assert.ok(shell, "shell rule must exist");
    assert.strictEqual(shell.effect, "ask");
    const mcp = rules.find((r) => r.action === "mcp__*");
    assert.ok(mcp, "mcp rule must exist");
    assert.strictEqual(mcp.effect, "ask");
  });

  it("does NOT hard-deny edit (Debug's loop requires instrumentation + fix)", () => {
    const rules = sessionPermissionsForMode("debug")!;
    const editDeny = rules.find((r) => r.action === "edit" && r.effect === "deny");
    assert.strictEqual(editDeny, undefined, "no edit deny — Cursor has no tool denylist for debug");
  });

  it("keeps read-only MCP observation tools card-free (allowlisted after the ask)", () => {
    const rules = sessionPermissionsForMode("debug")!;
    const askIdx = rules.findIndex((r) => r.action === "mcp__*");
    const allowIdx = rules.findIndex((r) => r.action === "mcp__*__read_file");
    assert.ok(allowIdx > askIdx, "allowlist must come after the mcp__* ask (engine findLast)");
    assert.strictEqual(rules[allowIdx].effect, "allow");
  });

  it("plan/ask deny rulesets are unchanged (regression guard)", () => {
    for (const mode of ["plan", "chat"] as const) {
      const rules = sessionPermissionsForMode(mode)!;
      assert.ok(rules, `${mode} must keep a ruleset`);
      assert.strictEqual(rules.find((r) => r.action === "edit")?.effect, "deny");
      assert.strictEqual(rules.find((r) => r.action === "shell")?.effect, "deny");
    }
  });

  it("agent and multitask send no permissions payload", () => {
    assert.strictEqual(sessionPermissionsForMode("agent"), undefined);
    assert.strictEqual(sessionPermissionsForMode("multitask"), undefined);
  });
});

describe("DebugServerService (live NDJSON ingest server)", () => {
  let svc: DebugServerService;
  let tmpLogDir: string;

  before(() => {
    // Hermetic log dir: the binary defaults to ~/.cursor/debug-logs when no
    // workspace folder exists, which the test must not touch.
    tmpLogDir = fs.mkdtempSync(path.join(os.tmpdir(), "ide-agent-debug-test-"));
    svc = new DebugServerService(undefined, { logDir: tmpLogDir });
  });

  after(async () => {
    await svc.stop();
    svc.dispose();
    fs.rmSync(tmpLogDir, { recursive: true, force: true });
  });

  function post(
    endpoint: string,
    body: string,
    sessionId = "test-session-1",
    omitSessionHeader = false,
    extraHeaders: Record<string, string> = {},
  ): Promise<{ status: number; text: string; headers: http.IncomingHttpHeaders }> {
    return new Promise((resolve, reject) => {
      const url = new URL(endpoint);
      const headers: Record<string, string> = {
        "content-type": "application/x-ndjson",
        ...extraHeaders,
      };
      if (!omitSessionHeader) {
        headers["x-debug-session-id"] = sessionId;
      }
      const req = http.request(
        {
          hostname: url.hostname,
          port: Number(url.port),
          path: url.pathname + url.search,
          method: "POST",
          headers,
        },
        (res) => {
          let data = "";
          res.on("data", (c: Buffer) => (data += c.toString()));
          res.on("end", () =>
            resolve({ status: res.statusCode ?? 0, text: data, headers: res.headers }),
          );
        },
      );
      req.on("error", reject);
      req.setTimeout(5000, () => req.destroy(new Error("timeout")));
      req.end(body);
    });
  }

  function options(endpoint: string): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
    return new Promise((resolve, reject) => {
      const url = new URL(endpoint);
      const req = http.request(
        { hostname: url.hostname, port: Number(url.port), path: url.pathname, method: "OPTIONS" },
        (res) => {
          res.resume();
          res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
        },
      );
      req.on("error", reject);
      req.setTimeout(5000, () => req.destroy(new Error("timeout")));
      req.end();
    });
  }

  function get(endpoint: string): Promise<{ status: number; json: unknown }> {
    return new Promise((resolve, reject) => {
      const url = new URL(endpoint);
      const req = http.request(
        { hostname: url.hostname, port: Number(url.port), path: url.pathname, method: "GET" },
        (res) => {
          let data = "";
          res.on("data", (c: Buffer) => (data += c.toString()));
          res.on("end", () => {
            try {
              resolve({ status: res.statusCode ?? 0, json: JSON.parse(data) });
            } catch {
              resolve({ status: res.statusCode ?? 0, json: data });
            }
          });
        },
      );
      req.on("error", reject);
      req.setTimeout(5000, () => req.destroy(new Error("timeout")));
      req.end();
    });
  }

  it("starts on 127.0.0.1 in Cursor's 7242–7942 range and returns a DebugModeConfig", async () => {
    const config = await svc.ensureStarted("test-session-1");
    assert.ok(config.serverEndpoint.startsWith("http://127.0.0.1:"), "loopback only");
    const port = Number(new URL(config.serverEndpoint).port);
    assert.ok(
      port >= DebugServerService.PORT_MIN && port <= DebugServerService.PORT_MAX,
      `port ${port} must be in 7242–7942`,
    );
    assert.ok(config.serverEndpoint.includes("/ingest/"), "endpoint carries the target id");
    assert.strictEqual(
      path.basename(config.logPath),
      "debug-test-session-1.log",
      "per-session log file is debug-{sessionId}.log ([BIN])",
    );
    assert.strictEqual(config.sessionId, "test-session-1");
    assert.deepStrictEqual(svc.getConfig(), config);
  });

  it("ingests NDJSON lines to the log file and the recent-lines buffer", async () => {
    const config = (await svc.ensureStarted("test-session-1")) as DebugModeConfig;
    const lines = [
      JSON.stringify({ ts: 1, level: "info", msg: "repro started", file: "app.ts", line: 10 }),
      JSON.stringify({ ts: 2, level: "error", msg: "null ref", file: "app.ts", line: 42 }),
    ];
    const seen: string[] = [];
    const sub = svc.onLine((l) => seen.push(l));
    const res = await post(config.serverEndpoint, lines.join("\n") + "\n");
    assert.strictEqual(res.status, 204, "binary returns 204 with an empty body");
    assert.strictEqual(res.text, "");
    const file = await fsp.readFile(config.logPath, "utf8");
    for (const l of lines) assert.ok(file.includes(l), "log file must contain the line");
    assert.deepStrictEqual(svc.getRecentLines(10), lines);
    assert.deepStrictEqual(seen, lines);
    sub.dispose();
  });

  it("treats the body as opaque bytes: no JSON validation, trailing newline ensured", async () => {
    const config = (await svc.ensureStarted("test-session-1")) as DebugModeConfig;
    // Not JSON at all, and no trailing newline — the binary still 204s and
    // appends the raw bytes plus exactly one newline.
    const res = await post(config.serverEndpoint, "this is { not } json");
    assert.strictEqual(res.status, 204);
    const file = await fsp.readFile(config.logPath, "utf8");
    assert.ok(file.endsWith("this is { not } json\n"), "raw bytes + one trailing newline");
    assert.ok(!file.endsWith("\n\n"), "no double newline when one was already there");
  });

  it("serializes concurrent writes: every byte lands, one trailing newline", async () => {
    const config = (await svc.ensureStarted("test-session-1")) as DebugModeConfig;
    const before = await fsp.readFile(config.logPath, "utf8");
    const bodies = Array.from({ length: 20 }, (_, i) => `concurrent-line-${i}`);
    const results = await Promise.all(bodies.map((b) => post(config.serverEndpoint, b)));
    assert.ok(results.every((r) => r.status === 204), "all concurrent writes 204");
    const after = await fsp.readFile(config.logPath, "utf8");
    const added = after.slice(before.length);
    for (const b of bodies) {
      assert.ok(added.includes(`${b}\n`), `missing bytes for ${b}`);
    }
    assert.ok(added.endsWith("\n") && !added.endsWith("\n\n"), "single trailing newline");
  });

  it("X-Debug-Session-Id truth table: /^[a-zA-Z0-9-]+$/ ([BIN] module 93)", async () => {
    const config = (await svc.ensureStarted("test-session-1")) as DebugModeConfig;
    const valid = ["abc", "ABC", "123", "a-b-c-1", "debug-composer-7", "x".repeat(200)];
    for (const id of valid) {
      const res = await post(config.serverEndpoint, "{}\n", id);
      assert.strictEqual(res.status, 204, `header ${JSON.stringify(id)} must be accepted`);
    }
    const invalid: Array<[string, string]> = [
      ["", "empty"],
      ["has space", "space"],
      ["under_score", "underscore"],
      ["dot.name", "dot"],
      ["../escape", "slash"],
      ["semi;colon", "semicolon"],
      ["ünïcodé", "non-ascii"],
      ["tab\there", "tab"],
    ];
    for (const [id, why] of invalid) {
      const res = await post(config.serverEndpoint, "{}\n", id);
      assert.strictEqual(res.status, 400, `header with ${why} must be rejected`);
      assert.strictEqual(res.text, "invalid-session-id");
    }
    const missing = await post(config.serverEndpoint, "{}\n", "", true);
    assert.strictEqual(missing.status, 400);
    assert.strictEqual(missing.text, "missing-session-id");
  });

  it("route table: OPTIONS 200 (CORS), wrong target 404, other methods/paths 404", async () => {
    const config = (await svc.ensureStarted("test-session-1")) as DebugModeConfig;
    const base = config.serverEndpoint.replace(/\/ingest\/.*$/, "");

    const opt = await options(`${base}/ingest/anything`);
    assert.strictEqual(opt.status, 200, "OPTIONS → 200 ([BIN])");
    assert.strictEqual(opt.headers["access-control-allow-origin"], "*");
    assert.ok(
      String(opt.headers["access-control-allow-methods"]).includes("OPTIONS"),
      "CORS methods header",
    );
    assert.ok(
      String(opt.headers["access-control-allow-headers"]).includes("X-Debug-Session-Id"),
      "CORS headers header",
    );

    const wrongTarget = await post(`${base}/ingest/wrong-id`, "{}\n");
    assert.strictEqual(wrongTarget.status, 404, "unguessable per-session target id");

    const withQuery = await post(`${config.serverEndpoint}?x=1`, "{}\n");
    assert.strictEqual(withQuery.status, 404, "exact raw-URL match: query string → 404");

    const getRes = await get(`${config.serverEndpoint}`);
    assert.strictEqual(getRes.status, 404, "GET on the ingest path → 404 (no /health; [BIN])");
  });

  it("ensureStarted is idempotent per session id (no port churn)", async () => {
    const a = await svc.ensureStarted("test-session-1");
    const b = await svc.ensureStarted("test-session-1");
    assert.strictEqual(a.serverEndpoint, b.serverEndpoint, "same session → same server");
  });

  it("a new session id restarts with a fresh target id and a fresh (empty) log file", async () => {
    const a = await svc.ensureStarted("test-session-1");
    await post(a.serverEndpoint, JSON.stringify({ msg: "old" }) + "\n");
    const b = await svc.ensureStarted("test-session-2");
    assert.notStrictEqual(a.serverEndpoint, b.serverEndpoint, "fresh unguessable target id");
    assert.strictEqual(path.basename(b.logPath), "debug-test-session-2.log");
    // The binary never creates/truncates the file at start — it appends on
    // first write. Post one line as session-2: its per-session file must
    // contain only session-2's bytes, proving per-request session routing.
    await post(b.serverEndpoint, JSON.stringify({ msg: "new" }) + "\n", "test-session-2");
    const file = await fsp.readFile(b.logPath, "utf8");
    assert.ok(!file.includes('"old"'), "session-2 file must not contain session-1 lines");
    assert.ok(file.includes('"new"'), "session-2 file contains its own write");
    // old endpoint is dead after restart
    const res = await post(a.serverEndpoint, JSON.stringify({ msg: "stale" }) + "\n").catch(
      (e: Error) => ({ status: -1, text: e.message, headers: {} as http.IncomingHttpHeaders }),
    );
    assert.ok(res.status === 404 || res.status === -1, "old target id must not ingest");
  });

  it("getLogPathForSession throws on an invalid session id ([BIN])", async () => {
    await svc.ensureStarted("test-session-1");
    assert.throws(() => svc.getLogPathForSession("../escape"), /Expected a valid debug session id/);
    assert.throws(() => svc.getLogPathForSession(""), /Expected a valid debug session id/);
    assert.strictEqual(svc.getLogPathForSession("ok-123"), path.join(tmpLogDir, "debug-ok-123.log"));
  });

  it("refuses to start in an untrusted workspace ([BIN] module 593)", async () => {
    const other = new DebugServerService(undefined, { logDir: tmpLogDir });
    const stub = vscodeStub as unknown as { workspace: { isTrusted: boolean } };
    const prev = stub.workspace.isTrusted;
    stub.workspace.isTrusted = false;
    try {
      await assert.rejects(
        other.ensureStarted("untrusted-session"),
        /debug mode disabled in untrusted workspace\./,
      );
      assert.strictEqual(other.getConfig(), undefined, "no server may be running");
    } finally {
      stub.workspace.isTrusted = prev;
      await other.stop();
    }
  });

  it("stop() shuts the server down", async () => {
    const config = (await svc.ensureStarted("test-session-3")) as DebugModeConfig;
    await svc.stop();
    assert.strictEqual(svc.getConfig(), undefined);
    await assert.rejects(post(config.serverEndpoint, "{}\n"), "connection must be refused");
  });
});
