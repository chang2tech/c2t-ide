/**
 * DEV-GAPS-65 `cursor-install-cli` tests (Cursor parity).
 *
 * Spec (feature-matrix.json `cursor-install-cli` + `r2m-003`; handler fully
 * read in docs/rea/dig-root-team/redig2-misc.md §ND-05 from Cursor 3.25.9
 * workbench.desktop.main.js):
 *   - @36708706: command `cursor.installCli`, title "Install Cursor CLI";
 *     guard `cliDetectionStatus.agentStatus==="installed"` → info toast;
 *     else Panel terminal running `curl https://cursor.com/install -fsS | bash`.
 *   - @40635349: detection probes `codex, claude, amp, gemini, agent` in
 *     PATH + ~/.local/bin; persists {claudeStatus, codexStatus,
 *     agentStatus, checkedAt} with "installed"|"not_found"|"unknown".
 *   - @36705799: tip qualifier = claude/codex installed && agent not.
 *
 * node:test, zero extra deps. Run after `tsc`:
 *   node --test out/cli-install.test.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import * as fs from "fs";
import * as path from "path";

import {
  ALREADY_INSTALLED_MESSAGE,
  CLI_EXECUTABLE_NAMES,
  CLI_INSTALL_COMMAND,
  CLI_INSTALL_TIP_MESSAGE,
  INSTALL_CLI_COMMAND_ID,
  INSTALL_CLI_TITLE,
  buildCliDetectionStatus,
  findExecutableInPath,
  isCliAlreadyInstalled,
  parseCliDetectionStatus,
  probeCliExecutables,
  qualifiesForCliInstallTip,
  resolveInstallCliAction,
  runInstallCliFlow,
  unknownCliDetectionStatus,
  type CliProbeDeps,
  type CliDetectionStatus,
} from "./cli-install";

const EXT_ROOT = path.resolve(__dirname, "..");
const PACKAGE_JSON = path.join(EXT_ROOT, "package.json");

const probeDeps = (existing: Set<string>, over: Partial<CliProbeDeps> = {}): CliProbeDeps => ({
  pathEnv: "/usr/bin:/opt/bin",
  pathDelimiter: ":",
  homeDir: "/home/user",
  joinPath: (...parts: string[]) => parts.join("/"),
  isExecutableFile: (candidate: string) => existing.has(candidate),
  executableVariants: (name: string) => [name],
  ...over,
});

describe("verbatim constants (binary @36708706 / @16262049)", () => {
  it("command id and title are verbatim", () => {
    assert.strictEqual(INSTALL_CLI_COMMAND_ID, "cursor.installCli");
    assert.strictEqual(INSTALL_CLI_TITLE, "Install Cursor CLI");
  });

  it("install command is the verbatim curl line", () => {
    assert.strictEqual(CLI_INSTALL_COMMAND, "curl https://cursor.com/install -fsS | bash");
    assert.strictEqual(CLI_INSTALL_TIP_MESSAGE, "Install Cursor CLI?");
  });

  it("probed executables are the verbatim five, in binary order", () => {
    assert.deepStrictEqual([...CLI_EXECUTABLE_NAMES], ["codex", "claude", "amp", "gemini", "agent"]);
  });

  it("package.json contributes the verbatim command for the palette", () => {
    const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, "utf8"));
    const commands = pkg.contributes?.commands ?? [];
    const entry = commands.find((c: { command: string }) => c.command === "cursor.installCli");
    assert.ok(entry, "cursor.installCli must be contributed");
    assert.strictEqual(entry.title, "Install Cursor CLI");
  });

  it("already-installed message is a non-empty placeholder (nls 10693 text UNKNOWN)", () => {
    assert.ok(ALREADY_INSTALLED_MESSAGE.length > 0);
  });
});

describe("cliDetectionStatus model (@40635349)", () => {
  it("unknown status is all-unknown with checkedAt 0", () => {
    assert.deepStrictEqual(unknownCliDetectionStatus(), {
      claudeStatus: "unknown",
      codexStatus: "unknown",
      agentStatus: "unknown",
      checkedAt: 0,
    });
  });

  it("buildCliDetectionStatus folds probe results, missing → unknown", () => {
    const status = buildCliDetectionStatus(
      { claude: "installed", codex: "not_found", agent: "installed" },
      1234,
    );
    assert.deepStrictEqual(status, {
      claudeStatus: "installed",
      codexStatus: "not_found",
      agentStatus: "installed",
      checkedAt: 1234,
    });
    assert.strictEqual(buildCliDetectionStatus({}, 5).agentStatus, "unknown");
  });

  it("parseCliDetectionStatus round-trips a valid blob and rejects garbage", () => {
    const valid: CliDetectionStatus = {
      claudeStatus: "installed",
      codexStatus: "not_found",
      agentStatus: "unknown",
      checkedAt: 42,
    };
    assert.deepStrictEqual(parseCliDetectionStatus(valid), valid);
    assert.strictEqual(parseCliDetectionStatus(undefined), undefined);
    assert.strictEqual(parseCliDetectionStatus("installed"), undefined);
    assert.strictEqual(parseCliDetectionStatus({ ...valid, agentStatus: "yes" }), undefined);
    assert.strictEqual(parseCliDetectionStatus({ ...valid, checkedAt: "now" }), undefined);
    assert.strictEqual(parseCliDetectionStatus({ claudeStatus: "installed" }), undefined);
  });
});

describe("handler decisions (@36708706 / @36705799)", () => {
  const withAgent = (agentStatus: CliDetectionStatus["agentStatus"]): CliDetectionStatus => ({
    claudeStatus: "unknown",
    codexStatus: "unknown",
    agentStatus,
    checkedAt: 1,
  });

  it("guard: only agentStatus installed short-circuits to the toast", () => {
    assert.strictEqual(isCliAlreadyInstalled(withAgent("installed")), true);
    assert.strictEqual(isCliAlreadyInstalled(withAgent("not_found")), false);
    assert.strictEqual(isCliAlreadyInstalled(withAgent("unknown")), false);
    assert.strictEqual(resolveInstallCliAction(withAgent("installed")), "already-installed");
    assert.strictEqual(resolveInstallCliAction(withAgent("not_found")), "install");
    assert.strictEqual(resolveInstallCliAction(withAgent("unknown")), "install");
  });

  it("tip qualifier: claude/codex installed and agent missing", () => {
    const base = unknownCliDetectionStatus();
    assert.strictEqual(qualifiesForCliInstallTip({ ...base, claudeStatus: "installed" }), true);
    assert.strictEqual(qualifiesForCliInstallTip({ ...base, codexStatus: "installed" }), true);
    assert.strictEqual(
      qualifiesForCliInstallTip({ ...base, claudeStatus: "installed", agentStatus: "installed" }),
      false,
    );
    assert.strictEqual(qualifiesForCliInstallTip(base), false);
    assert.strictEqual(qualifiesForCliInstallTip({ ...base, agentStatus: "not_found" }), false);
  });
});

describe("executable probing (checkExecutableInPath @40635349)", () => {
  it("finds executables on the PATH", () => {
    const deps = probeDeps(new Set(["/opt/bin/agent"]));
    assert.strictEqual(findExecutableInPath("agent", deps), true);
    assert.strictEqual(findExecutableInPath("claude", deps), false);
  });

  it("also probes ~/.local/bin", () => {
    const deps = probeDeps(new Set(["/home/user/.local/bin/agent"]));
    assert.strictEqual(findExecutableInPath("agent", deps), true);
  });

  it("tolerates an empty/undefined PATH (home probe still runs)", () => {
    const deps = probeDeps(new Set(["/home/user/.local/bin/codex"]), { pathEnv: undefined });
    assert.strictEqual(findExecutableInPath("codex", deps), true);
    assert.strictEqual(findExecutableInPath("agent", deps), false);
  });

  it("probeCliExecutables reports installed/not_found for all five names", () => {
    const deps = probeDeps(new Set(["/usr/bin/claude", "/home/user/.local/bin/agent"]));
    assert.deepStrictEqual(probeCliExecutables(deps), {
      codex: "not_found",
      claude: "installed",
      amp: "not_found",
      gemini: "not_found",
      agent: "installed",
    });
  });

  it("a throwing probe leaves that executable unknown after folding", () => {
    const deps = probeDeps(new Set(), {
      isExecutableFile: () => {
        throw new Error("fs gone");
      },
    });
    const folded = buildCliDetectionStatus(probeCliExecutables(deps), 7);
    assert.deepStrictEqual(folded, {
      claudeStatus: "unknown",
      codexStatus: "unknown",
      agentStatus: "unknown",
      checkedAt: 7,
    });
  });
});

describe("runInstallCliFlow (handler body @36708706)", () => {
  const harness = (persisted: CliDetectionStatus | undefined, fresh: CliDetectionStatus) => {
    const calls: string[] = [];
    const deps = {
      readStatus: () => persisted,
      refreshStatus: () => {
        calls.push("refresh");
        return fresh;
      },
      writeStatus: () => {
        calls.push("write");
      },
      showAlreadyInstalled: () => {
        calls.push("toast");
      },
      runInstallInPanelTerminal: (command: string) => {
        calls.push(`terminal:${command}`);
      },
    };
    return { calls, deps };
  };

  it("installed → toast only, no terminal, no refresh", async () => {
    const installed: CliDetectionStatus = {
      claudeStatus: "unknown",
      codexStatus: "unknown",
      agentStatus: "installed",
      checkedAt: 9,
    };
    const { calls, deps } = harness(installed, unknownCliDetectionStatus());
    assert.strictEqual(await runInstallCliFlow(deps), "already-installed");
    assert.deepStrictEqual(calls, ["toast"]);
  });

  it("not installed → Panel terminal runs the verbatim install command", async () => {
    const missing: CliDetectionStatus = {
      claudeStatus: "installed",
      codexStatus: "not_found",
      agentStatus: "not_found",
      checkedAt: 9,
    };
    const { calls, deps } = harness(missing, unknownCliDetectionStatus());
    assert.strictEqual(await runInstallCliFlow(deps), "install");
    assert.deepStrictEqual(calls, ["terminal:curl https://cursor.com/install -fsS | bash"]);
  });

  it("first run (nothing persisted) refreshes + persists before deciding", async () => {
    const fresh: CliDetectionStatus = {
      claudeStatus: "not_found",
      codexStatus: "not_found",
      agentStatus: "installed",
      checkedAt: 10,
    };
    const { calls, deps } = harness(undefined, fresh);
    assert.strictEqual(await runInstallCliFlow(deps), "already-installed");
    assert.deepStrictEqual(calls, ["refresh", "write", "toast"]);
  });
});
