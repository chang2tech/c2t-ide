/**
 * DEV-GAPS-40 (subagent-builtin) tests (node:test, vscode stubbed via ./vscode-stub).
 *
 * Locks in Cursor builtin-subagent parity
 * (spec verbatim — docs/rea/deep-docs-all.md §"Subagents — new details",
 * sourced from cursor.com/docs Subagents, read directly, HIGH confidence):
 *   - "Built-in: explore (codebase search), browser (browser automation via MCP)"
 *   - "Invoke: `/name` syntax or natural mention"
 *   - a user-configured agent with the same name overrides the builtin
 *     (engine rule — packages/core/src/tool/plugin/subagent.ts).
 *
 * Covers:
 *  - BUILTIN_SUBAGENTS: exactly the two Cursor builtins, stable order,
 *    faithful descriptions;
 *  - name lookup (case-insensitive; unknown → undefined);
 *  - buildSubagentInvokeMacro: `<subagent name="…">` macro naming the
 *    builtin agent id, carrying the task; throws for non-builtins;
 *  - mergeBuiltinSubagents: builtins first, marked builtin with no file;
 *    a user-defined same-name agent overrides (case-insensitive); custom
 *    agents are preserved after the builtins;
 *  - slash commands: /explore and /browser registered as builtin entries;
 *    run("explore"/"browser") returns the invoke macro (§5 prompt-macro
 *    semantics); unknown names stay unknown;
 *  - Customize view: builtins render with a "Built-in" badge, survive the
 *    User/Workspace scope filters (product-level), and match the search
 *    query filter.
 *
 * Run after `tsc`:  node --test out/services/test/run-builtin-subagents-tests.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import "./vscode-stub";
import {
  BUILTIN_SUBAGENTS,
  buildSubagentInvokeMacro,
  getBuiltinSubagent,
  isBuiltinSubagentName,
  mergeBuiltinSubagents,
} from "../builtinSubagents";
import { SlashCommandService } from "../slashCommandService";
import {
  SCOPE_ALL,
  SCOPE_USER,
  createCustomizeHtml,
  filterSubagents,
  type CustomizeSnapshot,
} from "../customizeView";

function makeSlashService(): SlashCommandService {
  // The vscode stub now provides createFileSystemWatcher + RelativePattern.
  return new SlashCommandService(
    {} as import("vscode").ExtensionContext,
    () => undefined,
  );
}

function snapshotWithAgents(
  agents: CustomizeSnapshot["agents"],
): CustomizeSnapshot {
  return {
    plugins: [],
    mcps: [],
    skills: [],
    agents,
    rules: [],
    commands: [],
    hookLog: [],
    hookConfiguredCount: 0,
    workspaces: [{ fsPath: "/ws/project", name: "project" }],
    dataSource: {
      plugins: "real",
      mcps: "real",
      skills: "real",
      agents: "real",
      rules: "real",
      commands: "real",
      hooks: "real",
    },
  };
}

describe("builtin subagent registry (Cursor subagent-builtin spec)", () => {
  it("lists exactly Cursor's two builtins: explore, browser", () => {
    assert.deepEqual(
      BUILTIN_SUBAGENTS.map((b) => b.name),
      ["explore", "browser"],
    );
  });

  it("carries faithful descriptions (codebase search / browser automation via MCP)", () => {
    const explore = getBuiltinSubagent("explore")!;
    const browser = getBuiltinSubagent("browser")!;
    assert.match(explore.description, /codebase/i);
    assert.match(explore.description, /read-only|explor/i);
    assert.match(browser.description, /browser/i);
    assert.match(browser.description, /MCP/i);
  });

  it("looks up names case-insensitively; unknown names are not builtins", () => {
    assert.equal(getBuiltinSubagent("EXPLORE")?.name, "explore");
    assert.equal(getBuiltinSubagent("  Browser ")?.name, "browser");
    assert.equal(getBuiltinSubagent("reviewer"), undefined);
    assert.equal(isBuiltinSubagentName("explore"), true);
    assert.equal(isBuiltinSubagentName("planner"), false);
  });
});

describe("subagent invoke macro (/name syntax)", () => {
  it("builds a <subagent name> macro carrying the agent id and task", () => {
    const macro = buildSubagentInvokeMacro("explore", "where is auth implemented?");
    assert.ok(macro.includes('<subagent name="explore">'));
    assert.ok(macro.includes("where is auth implemented?"));
    assert.ok(macro.includes('agent "explore"'));
  });

  it("works with an empty task (bare /name mention)", () => {
    const macro = buildSubagentInvokeMacro("browser", "  ");
    assert.ok(macro.includes('<subagent name="browser">'));
  });

  it("throws for non-builtin names — never fabricates a macro", () => {
    assert.throws(() => buildSubagentInvokeMacro("reviewer", "x"), /not a built-in subagent/);
  });
});

describe("mergeBuiltinSubagents (Customize snapshot)", () => {
  it("puts builtins first, marked builtin, with no backing file", () => {
    const merged = mergeBuiltinSubagents([
      { name: "reviewer", description: "reviews code", filePath: "/ws/.opencode/agent/reviewer.md", scope: "workspace" },
    ]);
    assert.deepEqual(
      merged.map((a) => a.name),
      ["explore", "browser", "reviewer"],
    );
    assert.equal(merged[0].builtin, true);
    assert.equal(merged[1].builtin, true);
    assert.equal(merged[0].filePath, "");
    assert.equal(merged[2].builtin, undefined);
  });

  it("a user-defined same-name agent overrides the builtin (engine rule)", () => {
    const merged = mergeBuiltinSubagents([
      { name: "Explore", description: "mine", filePath: "/home/u/.config/opencode/agent/explore.md", scope: "user" },
    ]);
    // The builtin "explore" entry is dropped (the user's agent wins for
    // resolution); display order stays builtins-then-custom.
    assert.deepEqual(merged.map((a) => a.name), ["browser", "Explore"]);
    assert.equal(merged[1].builtin, undefined);
    assert.equal(merged[1].filePath, "/home/u/.config/opencode/agent/explore.md");
  });

  it("returns just the builtins when no custom agents exist", () => {
    const merged = mergeBuiltinSubagents([]);
    assert.equal(merged.length, 2);
    assert.ok(merged.every((a) => a.builtin === true));
  });
});

describe("slash commands /explore and /browser", () => {
  it("registers both as builtin commands", () => {
    const svc = makeSlashService();
    const builtins = svc.getBuiltins();
    const explore = builtins.find((b) => b.name === "explore");
    const browser = builtins.find((b) => b.name === "browser");
    assert.ok(explore);
    assert.ok(browser);
    assert.equal(explore!.source, "builtin");
    assert.equal(browser!.source, "builtin");
    assert.ok(explore!.argumentHint);
  });

  it("run('explore', task) returns the invoke macro (§5 prompt-macro semantics)", async () => {
    const svc = makeSlashService();
    const res = await svc.run("explore", "find the login flow");
    assert.ok(res.macro);
    assert.ok(res.macro!.includes('<subagent name="explore">'));
    assert.ok(res.macro!.includes("find the login flow"));
  });

  it("run('browser', task) returns the invoke macro", async () => {
    const svc = makeSlashService();
    const res = await svc.run("BROWSER", "screenshot the homepage");
    assert.ok(res.macro);
    assert.ok(res.macro!.includes('<subagent name="browser">'));
    assert.ok(res.macro!.includes("screenshot the homepage"));
  });

  it("does not collide with custom commands or skills of the same name", () => {
    // First-wins ordering is covered by run(): custom/skill lookup happens
    // before the builtin switch. Here we lock the registry shape only.
    const svc = makeSlashService();
    const names = svc.getBuiltins().map((b) => b.name.toLowerCase());
    assert.equal(names.filter((n) => n === "explore").length, 1);
    assert.equal(names.filter((n) => n === "browser").length, 1);
  });
});

describe("Customize view — builtin subagent rows", () => {
  const agents = mergeBuiltinSubagents([
    { name: "reviewer", description: "reviews code", filePath: "/ws/.opencode/agent/reviewer.md", scope: "workspace" },
  ]);

  it("builtins survive the User scope filter (product-level, not partitioned)", () => {
    const filtered = filterSubagents(agents, SCOPE_USER, "");
    assert.deepEqual(
      filtered.map((a) => a.name),
      ["explore", "browser"],
    );
  });

  it("builtins survive the All scope filter alongside custom agents", () => {
    const filtered = filterSubagents(agents, SCOPE_ALL, "");
    assert.deepEqual(
      filtered.map((a) => a.name),
      ["explore", "browser", "reviewer"],
    );
  });

  it("the search query still filters builtins", () => {
    const filtered = filterSubagents(agents, SCOPE_ALL, "brows");
    assert.deepEqual(filtered.map((a) => a.name), ["browser"]);
  });

  it("renders a Built-in badge for builtins (not a scope badge)", () => {
    const html = createCustomizeHtml(snapshotWithAgents(agents), "agents", SCOPE_ALL, "");
    assert.ok(html.includes(">Built-in<"), "expected a Built-in badge in the agents pane");
    // The custom agent keeps its scope badge.
    assert.ok(html.includes(">Workspace<"));
  });

  it("renders the one-level nesting note in the agents section", () => {
    const html = createCustomizeHtml(snapshotWithAgents(agents), "agents", SCOPE_ALL, "");
    assert.ok(html.includes("nest one level deep"));
  });
});
