/**
 * DEV-GAPS-10 (rex-004) `.cursor/permissions.json` tests (node:test, vscode stubbed).
 *
 * - Schema validation: valid doc accepted; approvalMode:"banana" rejected;
 *   wrong types rejected; invalid JSON never crashes (warning + policy kept).
 * - Pattern matching: mcpAllowlist "server:tool" / "server:*"; terminal globs.
 * - HumanReviewService (the single approval choke point):
 *   unrestricted → auto-approve; manual → Ask Every Time (stored allowlist
 *   bypassed); allowlist mode → file patterns auto-approve.
 * - Loader: invalid JSON keeps the current policy; delete clears it.
 *
 * Run after `tsc`:  node out/services/test/run-permissions-file-tests.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import "./vscode-stub";
import {
  CursorPermissionsFileService,
  DEFAULT_PERMISSIONS_POLICY,
  PERMISSIONS_APPROVAL_MODES,
  matchMcpAllowlist,
  matchTerminalAllowlist,
  matchesFileAllowlist,
  parseMcpAction,
  splitAllowlistIdentity,
  validateCursorPermissions,
  type CursorPermissionsPolicy,
} from "../permissionsFileService";
import { HumanReviewService } from "../humanReviewService";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("validateCursorPermissions", () => {
  it("accepts a full valid document", () => {
    const r = validateCursorPermissions({
      mcpAllowlist: ["github:create_pr", "filesystem:*"],
      terminalAllowlist: ["git status", "npm run *"],
      approvalMode: "manual",
      autoRun: true,
      autoReview: false,
    });
    assert.strictEqual(r.ok, true);
    if (r.ok) {
      assert.deepStrictEqual(r.policy.mcpAllowlist, ["github:create_pr", "filesystem:*"]);
      assert.strictEqual(r.policy.approvalMode, "manual");
      assert.strictEqual(r.policy.autoRun, true);
    }
  });

  it("accepts an empty object (all defaults)", () => {
    const r = validateCursorPermissions({});
    assert.strictEqual(r.ok, true);
    if (r.ok) {
      assert.deepStrictEqual(r.policy, DEFAULT_PERMISSIONS_POLICY);
    }
  });

  it('rejects approvalMode:"banana" (enum is verbatim [allowlist, unrestricted, manual])', () => {
    assert.deepStrictEqual([...PERMISSIONS_APPROVAL_MODES], ["allowlist", "unrestricted", "manual"]);
    const r = validateCursorPermissions({ approvalMode: "banana" });
    assert.strictEqual(r.ok, false);
    if (!r.ok) {
      assert.ok(r.errors.some((e) => e.includes("approvalMode")), JSON.stringify(r.errors));
    }
  });

  it("rejects non-objects and wrong types", () => {
    for (const bad of [null, 42, "x", []]) {
      assert.strictEqual(validateCursorPermissions(bad).ok, false, JSON.stringify(bad));
    }
    assert.strictEqual(validateCursorPermissions({ mcpAllowlist: "nope" }).ok, false);
    assert.strictEqual(validateCursorPermissions({ terminalAllowlist: [42] }).ok, false);
    assert.strictEqual(validateCursorPermissions({ autoRun: "yes" }).ok, false);
    assert.strictEqual(validateCursorPermissions({ mcpAllowlist: ["no-colon"] }).ok, false);
  });

  it("ignores unknown properties (forward compatibility)", () => {
    const r = validateCursorPermissions({ futureFlag: true });
    assert.strictEqual(r.ok, true);
  });
});

describe("pattern matching", () => {
  it("matchMcpAllowlist: server:tool exact + server:* wildcard", () => {
    assert.ok(matchMcpAllowlist(["github:create_pr"], "github", "create_pr"));
    assert.ok(!matchMcpAllowlist(["github:create_pr"], "github", "delete_repo"));
    assert.ok(!matchMcpAllowlist(["github:create_pr"], "gitlab", "create_pr"));
    assert.ok(matchMcpAllowlist(["filesystem:*"], "filesystem", "read_file"));
    assert.ok(matchMcpAllowlist(["*:*"], "anything", "whatever"));
  });

  it("matchTerminalAllowlist: glob * against command text", () => {
    assert.ok(matchTerminalAllowlist(["git status"], "git status"));
    assert.ok(!matchTerminalAllowlist(["git status"], "git status --porcelain"));
    assert.ok(matchTerminalAllowlist(["npm run *"], "npm run build"));
    assert.ok(matchTerminalAllowlist(["git *"], "git checkout -b x"));
  });

  it("parseMcpAction + splitAllowlistIdentity", () => {
    assert.deepStrictEqual(parseMcpAction("mcp__github__create_pr"), {
      server: "github",
      tool: "create_pr",
    });
    assert.strictEqual(parseMcpAction("edit"), undefined);
    const parts = splitAllowlistIdentity("bash::git status --porcelain");
    assert.strictEqual(parts.action, "bash");
    assert.deepStrictEqual(parts.resources, ["git status --porcelain"]);
  });

  it("matchesFileAllowlist routes MCP and terminal identities", () => {
    const policy: CursorPermissionsPolicy = {
      ...DEFAULT_PERMISSIONS_POLICY,
      mcpAllowlist: ["github:*"],
      terminalAllowlist: ["git status"],
    };
    assert.ok(matchesFileAllowlist(policy, "mcp__github__create_pr::[]"));
    assert.ok(!matchesFileAllowlist(policy, "mcp__gitlab__create_pr::[]"));
    assert.ok(matchesFileAllowlist(policy, "bash::git status"));
    assert.ok(!matchesFileAllowlist(policy, "bash::rm -rf /"));
    assert.ok(!matchesFileAllowlist(policy, "edit::src/a.ts"));
  });
});

describe("HumanReviewService — file policy at the choke point", () => {
  it("unrestricted → auto-approves without a card", async () => {
    const svc = new HumanReviewService();
    svc.setFilePermissions({ ...DEFAULT_PERMISSIONS_POLICY, approvalMode: "unrestricted" });
    const r = await svc.requestApproval("tc-1", "edit", ["reason"], 50, undefined, "edit::src/a.ts");
    assert.deepStrictEqual(r, { optionId: "approve-once" });
    assert.strictEqual(svc.currentApproval, undefined, "no card should open");
  });

  it("manual (Ask Every Time) → stored allowlist entries do NOT auto-approve", async () => {
    const svc = new HumanReviewService();
    // First: approve-and-allowlist stores the identity (no file policy yet).
    const p1 = svc.requestApproval("tc-1", "edit", ["r"], 5000, undefined, "edit::src/a.ts");
    await sleep(10);
    svc.resolveApproval(svc.currentApproval!.approvalId, { optionId: "approve-allowlist" });
    assert.deepStrictEqual(await p1, { optionId: "approve-allowlist" });
    // Stored entry auto-approves by default...
    const p2 = svc.requestApproval("tc-2", "edit", ["r"], 50, undefined, "edit::src/a.ts");
    assert.deepStrictEqual(await p2, { optionId: "approve-once" });
    // ...but manual mode bypasses it: the card opens (stays pending).
    svc.setFilePermissions({ ...DEFAULT_PERMISSIONS_POLICY, approvalMode: "manual" });
    const pending = svc.requestApproval("tc-3", "edit", ["r"], 200, undefined, "edit::src/a.ts");
    const verdict = await Promise.race([pending.then((r) => ({ settled: r })), sleep(80).then(() => "PENDING" as const)]);
    assert.strictEqual(verdict, "PENDING", "manual mode must ask, not auto-approve");
    assert.ok(svc.currentApproval, "card should be open");
    svc.settleAllPending();
  });

  it("allowlist mode → file mcpAllowlist pattern auto-approves, others ask", async () => {
    const svc = new HumanReviewService();
    svc.setFilePermissions({
      ...DEFAULT_PERMISSIONS_POLICY,
      approvalMode: "allowlist",
      mcpAllowlist: ["github:*"],
    });
    const auto = await svc.requestApproval(
      "tc-1",
      "mcp__github__create_pr",
      ["r"],
      50,
      undefined,
      "mcp__github__create_pr::[]",
    );
    assert.deepStrictEqual(auto, { optionId: "approve-once" });
    const pending = svc.requestApproval("tc-2", "edit", ["r"], 200, undefined, "edit::src/a.ts");
    const verdict = await Promise.race([pending.then((r) => ({ settled: r })), sleep(80).then(() => "PENDING" as const)]);
    assert.strictEqual(verdict, "PENDING", "non-matching tools must still ask");
    svc.settleAllPending();
  });

  it("clearing the policy restores default behavior", async () => {
    const svc = new HumanReviewService();
    svc.setFilePermissions({ ...DEFAULT_PERMISSIONS_POLICY, approvalMode: "unrestricted" });
    svc.setFilePermissions(undefined);
    assert.strictEqual(svc.getFilePermissions(), undefined);
    const pending = svc.requestApproval("tc-1", "edit", ["r"], 200, undefined, "edit::src/a.ts");
    const verdict = await Promise.race([pending.then((r) => ({ settled: r })), sleep(80).then(() => "PENDING" as const)]);
    assert.strictEqual(verdict, "PENDING");
    svc.settleAllPending();
  });
});

describe("CursorPermissionsFileService — loader", () => {
  function makeHarness(files: Record<string, string>) {
    const applied: Array<CursorPermissionsPolicy | undefined> = [];
    const warnings: string[] = [];
    const infos: string[] = [];
    const watchers: Array<{
      onDidChange: (fn: () => void) => void;
      onDidCreate: (fn: () => void) => void;
      onDidDelete: (fn: () => void) => void;
    }> = [];
    const svc = new CursorPermissionsFileService({
      workspaceFolders: () => [{ uri: { fsPath: "/ws" } }],
      applyPolicy: (p) => applied.push(p),
      logWarning: (m) => warnings.push(m),
      logInfo: (m) => infos.push(m),
      readFile: (absPath: string) => {
        const rel = absPath.replace("/ws/", "");
        if (!(rel in files)) {
          const err = new Error(`ENOENT: ${absPath}`) as NodeJS.ErrnoException;
          err.code = "ENOENT";
          throw err;
        }
        return files[rel];
      },
      createWatcher: () => {
        const handlers: Record<string, () => void> = {};
        const w = {
          onDidChange: (fn: () => void) => {
            handlers["change"] = fn;
          },
          onDidCreate: (fn: () => void) => {
            handlers["create"] = fn;
          },
          onDidDelete: (fn: () => void) => {
            handlers["delete"] = fn;
          },
          dispose: () => undefined,
          fire: (kind: "change" | "create" | "delete") => handlers[kind]?.(),
        };
        watchers.push(w);
        return w as unknown as import("vscode").FileSystemWatcher;
      },
    });
    return { svc, applied, warnings, infos, watchers, files };
  }

  it("valid file → policy applied", () => {
    const h = makeHarness({
      ".cursor/permissions.json": JSON.stringify({
        mcpAllowlist: ["github:*"],
        approvalMode: "allowlist",
      }),
    });
    h.svc.start();
    assert.strictEqual(h.applied.length, 1);
    assert.strictEqual(h.applied[0]?.approvalMode, "allowlist");
    assert.deepStrictEqual(h.applied[0]?.mcpAllowlist, ["github:*"]);
    assert.strictEqual(h.warnings.length, 0);
  });

  it("invalid JSON → warning, current policy KEPT (no crash)", () => {
    const h = makeHarness({ ".cursor/permissions.json": "{ not json" });
    h.svc.start();
    assert.strictEqual(h.applied.length, 0, "no policy applied for invalid JSON");
    assert.strictEqual(h.warnings.length, 1);
    assert.ok(/not valid JSON/i.test(h.warnings[0]));
  });

  it("schema violation → warning, current policy KEPT", () => {
    const h = makeHarness({
      ".cursor/permissions.json": JSON.stringify({ approvalMode: "banana" }),
    });
    h.svc.start();
    assert.strictEqual(h.applied.length, 0);
    assert.strictEqual(h.warnings.length, 1);
    assert.ok(/approvalMode/.test(h.warnings[0]));
  });

  it("missing file → no policy, no warning", () => {
    const h = makeHarness({});
    h.svc.start();
    assert.deepStrictEqual(h.applied, [undefined]);
    assert.strictEqual(h.warnings.length, 0);
  });

  it("file change → reload; delete → policy cleared", () => {
    const h = makeHarness({
      ".cursor/permissions.json": JSON.stringify({ approvalMode: "manual" }),
    });
    const d = h.svc.start();
    assert.strictEqual(h.applied[0]?.approvalMode, "manual");
    h.files[".cursor/permissions.json"] = JSON.stringify({ approvalMode: "unrestricted" });
    (h.watchers[0] as unknown as { fire: (k: "change") => void }).fire("change");
    assert.strictEqual(h.applied[1]?.approvalMode, "unrestricted");
    (h.watchers[0] as unknown as { fire: (k: "delete") => void }).fire("delete");
    assert.strictEqual(h.applied[2], undefined);
    d.dispose();
  });

  it("unreadable file (non-ENOENT) → warning, policy kept", () => {
    const h = makeHarness({ ".cursor/permissions.json": JSON.stringify({ approvalMode: "manual" }) });
    h.svc.start();
    assert.strictEqual(h.applied.length, 1);
    const svc2 = new CursorPermissionsFileService({
      workspaceFolders: () => [{ uri: { fsPath: "/ws" } }],
      applyPolicy: (p) => h.applied.push(p),
      logWarning: (m) => h.warnings.push(m),
      logInfo: () => undefined,
      readFile: () => {
        throw new Error("EACCES: permission denied");
      },
    });
    svc2.reload();
    assert.strictEqual(h.applied.length, 1, "policy unchanged on read error");
    assert.ok(h.warnings.some((w) => /could not read/i.test(w)));
  });
});
