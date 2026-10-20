/**
 * DEV-CUSTOMIZE-VIEW tests (node:test, vscode stubbed via ./vscode-stub).
 *
 * Covers (DD-CV-1..4):
 *  - Section metadata: 7 pill tabs in verbatim order, ids, labels, titles,
 *    descriptions, button variants (DD-CV-1, DD-CV-2, DD-CV-3, DD-CV-4).
 *  - Document URIs: customizeEditorUriForTab / customizeTabIdFromUri
 *    (fail-closed on foreign/traversal/unknown ids).
 *  - Per-tab open commands → tab ids (binary evidence:
 *    workbench.action.customize.open<Label>).
 *  - Migration banner: renders on "general" ONLY (corrects
 *    detail-settings-2026-10-19 §1 "all sections" claim), verbatim copy.
 *  - Search + scope filters (pure functions).
 *  - HTML: pills, search placeholder, Browse Marketplace, Manage scope,
 *    Plugins Add menu, Hooks execution log panel (count, empty state,
 *    NO "New" button on hooks).
 *  - Entry points: openCustomizeEditor issues vscode.openWith with the
 *    singleton URI + view type, and selects the requested tab.
 *
 * Run after `tsc`:  node --test out/services/test/run-customize-view-tests.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import "./vscode-stub";
import { vscodeStub } from "./vscode-stub";
import {
  CUSTOMIZE_DEFAULT_TAB,
  CUSTOMIZE_EDITOR_SCHEME,
  CUSTOMIZE_EDITOR_VIEW_TYPE,
  CUSTOMIZE_IDE_OPEN_TAB_COMMANDS,
  CUSTOMIZE_OPEN_TAB_COMMANDS,
  CUSTOMIZE_SEARCH_PLACEHOLDER,
  CUSTOMIZE_SECTIONS,
  SCOPE_ALL,
  SCOPE_USER,
  createCustomizeHtml,
  customizeEditorUriForTab,
  customizeTabIdFromUri,
  filterCommands,
  filterHookLog,
  filterMcpServers,
  filterPlugins,
  filterRules,
  filterSkills,
  filterSubagents,
  isCustomizeSectionId,
  openCustomizeEditor,
  scopeForWorkspace,
  sectionMatchesQuery,
  sectionMeta,
  type CustomizeHostDeps,
  type CustomizeSectionId,
  type CustomizeSnapshot,
} from "../customizeView";

function emptySnapshot(): CustomizeSnapshot {
  return {
    plugins: [],
    mcps: [],
    skills: [],
    agents: [],
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

describe("Customize sections — verbatim metadata (DD-CV-1/3)", () => {
  it("has exactly 7 pill tabs in verbatim order", () => {
    assert.deepEqual(
      CUSTOMIZE_SECTIONS.map((s) => s.id),
      ["plugins", "mcps", "skills", "agents", "rules", "commands", "hooks"],
    );
    assert.deepEqual(
      CUSTOMIZE_SECTIONS.map((s) => s.label),
      ["Plugins", "MCPs", "Skills", "Subagents", "Rules", "Commands", "Hooks"],
    );
  });

  it("DD-CV-3: Subagents tab id is 'agents'; MCPs label is 'MCPs' (not 'Tools & MCPs')", () => {
    const subagents = CUSTOMIZE_SECTIONS.find((s) => s.label === "Subagents");
    assert.ok(subagents);
    assert.equal(subagents!.id, "agents");
    assert.ok(!CUSTOMIZE_SECTIONS.some((s) => s.label === "Tools & MCPs"));
    assert.equal(sectionMeta("mcps").label, "MCPs");
  });

  it("default selected tab is plugins", () => {
    assert.equal(CUSTOMIZE_DEFAULT_TAB, "plugins");
    assert.ok(isCustomizeSectionId("plugins"));
    assert.equal(isCustomizeSectionId("nope"), false);
  });

  it("carries the verbatim section titles and descriptions", () => {
    const expected: Array<[CustomizeSectionId, string, string]> = [
      ["plugins", "Extend Cursor with Plugins", "Plugins bundle rules, skills, subagents, commands, MCP servers, and hooks into one installable package."],
      ["mcps", "Connect External Tools with MCP", "Model Context Protocol servers connect Cursor to external tools and data sources like Linear, Figma, and Notion."],
      ["skills", "Teach Cursor New Skills", "Skills package domain-specific knowledge and workflows that Agent applies automatically when relevant."],
      ["agents", "Delegate Work to Subagents", "Subagents are specialized assistants that run in their own context window so Agent can parallelize and stay focused."],
      ["rules", "Guide Agent with Rules", "Rules give Agent persistent, system-level instructions for your coding standards and workflows."],
      ["commands", "Create Reusable Commands", "Commands are reusable prompts you invoke with /name to standardize common workflows across your team."],
      ["hooks", "Automate with Hooks", "Hooks run custom scripts at lifecycle events to observe, control, and extend the agent loop."],
    ];
    for (const [id, title, description] of expected) {
      const meta = sectionMeta(id);
      assert.equal(meta.title, title, id);
      assert.equal(meta.description, description, id);
    }
  });

  it("DD-CV-4: button variants — plugins gets Add menu, others New, hooks has no New", () => {
    const byId = Object.fromEntries(CUSTOMIZE_SECTIONS.map((s) => [s.id, s.action]));
    assert.equal(byId.plugins, "add-menu");
    for (const id of ["mcps", "skills", "agents", "rules", "commands"] as const) {
      assert.equal(byId[id], "new", id);
    }
    assert.equal(byId.hooks, "log");
  });
});

describe("Per-tab open commands (binary evidence)", () => {
  it("maps every section to its workbench.action.customize.open* command", () => {
    assert.deepEqual(CUSTOMIZE_OPEN_TAB_COMMANDS, {
      plugins: "workbench.action.customize.openPlugins",
      mcps: "workbench.action.customize.openMCPs",
      skills: "workbench.action.customize.openSkills",
      agents: "workbench.action.customize.openSubagents",
      rules: "workbench.action.customize.openRules",
      commands: "workbench.action.customize.openCommands",
      hooks: "workbench.action.customize.openHooks",
    });
  });

  it("DEV-GAPS-74: maps every section to its ide.customize.open* core-delegate alias", () => {
    assert.deepEqual(CUSTOMIZE_IDE_OPEN_TAB_COMMANDS, {
      plugins: "ide.customize.openPlugins",
      mcps: "ide.customize.openMCPs",
      skills: "ide.customize.openSkills",
      agents: "ide.customize.openSubagents",
      rules: "ide.customize.openRules",
      commands: "ide.customize.openCommands",
      hooks: "ide.customize.openHooks",
    });
  });
});

describe("Document URIs", () => {
  it("round-trips tab ids through ide-customize:/ URIs", () => {
    for (const s of CUSTOMIZE_SECTIONS) {
      const uri = customizeEditorUriForTab(s.id);
      assert.equal(uri.scheme, CUSTOMIZE_EDITOR_SCHEME);
      assert.equal(customizeTabIdFromUri(uri), s.id);
    }
  });

  it("rejects foreign schemes, traversal, and unknown ids (fail-closed)", () => {
    const foreign = { scheme: "file", path: "/plugins" };
    assert.equal(customizeTabIdFromUri(foreign as never), undefined);
    for (const bad of ["", "/", "/..", "/../etc", "/plugins/x", "/unknown"]) {
      assert.equal(
        customizeTabIdFromUri({ scheme: CUSTOMIZE_EDITOR_SCHEME, path: bad } as never),
        undefined,
        bad,
      );
    }
  });
});

describe("Search and scope filters", () => {
  it("sectionMatchesQuery is case-insensitive and empty-query matches all", () => {
    assert.equal(sectionMatchesQuery("Linear MCP Server", ""), true);
    assert.equal(sectionMatchesQuery("Linear MCP Server", "  "), true);
    assert.equal(sectionMatchesQuery("Linear MCP Server", "linear"), true);
    assert.equal(sectionMatchesQuery("Linear MCP Server", "MCP"), true);
    assert.equal(sectionMatchesQuery("Linear MCP Server", "figma"), false);
  });

  const mcps = [
    { id: "a", name: "Linear", scope: "workspace" as const, state: "ready", toolCount: 3 },
    { id: "b", name: "Figma", scope: "user" as const, state: "ready", toolCount: 1, lastError: "boom" },
  ];

  it("filterMcpServers honors scope and query", () => {
    assert.equal(filterMcpServers(mcps, SCOPE_ALL, "").length, 2);
    assert.deepEqual(
      filterMcpServers(mcps, SCOPE_USER, "").map((s) => s.name),
      ["Figma"],
    );
    assert.deepEqual(
      filterMcpServers(mcps, scopeForWorkspace("/ws/project"), "").map((s) => s.name),
      ["Linear"],
    );
    assert.deepEqual(
      filterMcpServers(mcps, SCOPE_ALL, "fig").map((s) => s.name),
      ["Figma"],
    );
  });

  it("filterSkills honors scope and query", () => {
    const skills = [
      { name: "code-review", description: "reviews code", filePath: "/ws/project/.cursor/skills/x", scope: "workspace" as const },
      { name: "personal", description: "mine", filePath: "/home/u/.cursor/skills/y", scope: "user" as const },
    ];
    assert.equal(filterSkills(skills, SCOPE_ALL, "").length, 2);
    assert.deepEqual(filterSkills(skills, SCOPE_USER, "").map((s) => s.name), ["personal"]);
    assert.deepEqual(filterSkills(skills, SCOPE_ALL, "review").map((s) => s.name), ["code-review"]);
  });

  it("filterRules: .mdc rules are workspace-level (User scope hides them)", () => {
    const rules = [
      { name: "fastapi.mdc", description: "", filePath: "/ws/project/.cursor/rules/fastapi.mdc", workspaceRoot: "/ws/project" },
    ];
    assert.equal(filterRules(rules, SCOPE_ALL, "").length, 1);
    assert.equal(filterRules(rules, SCOPE_USER, "").length, 0);
    assert.equal(filterRules(rules, scopeForWorkspace("/ws/project"), "").length, 1);
    assert.equal(filterRules(rules, scopeForWorkspace("/ws/other"), "").length, 0);
  });

  it("filterCommands honors personal vs workspace source", () => {
    const commands = [
      { name: "deploy", description: "", source: "workspace" as const, filePath: "/ws/.cursor/commands/deploy.md" },
      { name: "summarize", description: "", source: "personal" as const, filePath: "/home/u/.cursor/commands/summarize.md" },
    ];
    assert.deepEqual(filterCommands(commands, SCOPE_USER, "").map((c) => c.name), ["summarize"]);
    assert.deepEqual(
      filterCommands(commands, scopeForWorkspace("/ws"), "").map((c) => c.name),
      ["deploy"],
    );
  });

  it("filterHookLog matches on event/command/source (scope does not partition the log)", () => {
    const log = [
      { at: 1, event: "beforeSubmit", source: "user", command: "lint.sh", exitCode: 0, durationMs: 12, decision: "approve" },
    ];
    assert.equal(filterHookLog(log, SCOPE_ALL, "").length, 1);
    assert.equal(filterHookLog(log, SCOPE_USER, "").length, 1);
    assert.equal(filterHookLog(log, SCOPE_ALL, "lint").length, 1);
    assert.equal(filterHookLog(log, SCOPE_ALL, "zzz").length, 0);
  });

  it("filterPlugins matches on name/id/description (scope never partitions plugins)", () => {
    const plugins = [
      { id: "ms-python.python", displayName: "Python", version: "1.2.3", description: "Python language support" },
      { id: "ide-agent", displayName: "IDE Agent", version: "0.1.0", description: "AI chat" },
    ];
    assert.equal(filterPlugins(plugins, "").length, 2);
    // Scope does not partition: user/workspace scopes still see everything.
    assert.equal(filterPlugins(plugins, "").length, 2);
    assert.deepEqual(filterPlugins(plugins, "python").map((p) => p.id), ["ms-python.python"]);
    assert.deepEqual(filterPlugins(plugins, "AI chat").map((p) => p.id), ["ide-agent"]);
    assert.equal(filterPlugins(plugins, "zzz").length, 0);
  });

  it("filterSubagents honors scope and query", () => {
    const agents = [
      { name: "reviewer", description: "reviews code", filePath: "/home/u/.config/opencode/agent/reviewer.md", scope: "user" as const },
      { name: "writer", description: "writes docs", filePath: "/ws/project/.opencode/agent/writer.md", scope: "workspace" as const },
    ];
    assert.equal(filterSubagents(agents, SCOPE_ALL, "").length, 2);
    assert.deepEqual(filterSubagents(agents, SCOPE_USER, "").map((a) => a.name), ["reviewer"]);
    assert.deepEqual(filterSubagents(agents, scopeForWorkspace("/ws/project"), "").map((a) => a.name), ["writer"]);
    assert.deepEqual(filterSubagents(agents, SCOPE_ALL, "docs").map((a) => a.name), ["writer"]);
  });
});

describe("Customize HTML", () => {
  const html = createCustomizeHtml(emptySnapshot(), "plugins", SCOPE_ALL, "");

  it("renders the 7 pills with verbatim labels and tab ids", () => {
    for (const s of CUSTOMIZE_SECTIONS) {
      assert.ok(html.includes(`data-customize-manage-tab-id="${s.id}"`), s.id);
      assert.ok(html.includes(`>${s.label}</span>`), s.label);
    }
    assert.ok(html.includes('aria-selected="true" data-action="switch-tab" data-tab="plugins"') ||
      html.includes('data-tab="plugins"'));
  });

  it("header has the verbatim search placeholder, Browse Marketplace and Manage scope", () => {
    assert.ok(html.includes(`placeholder="${CUSTOMIZE_SEARCH_PLACEHOLDER}"`));
    assert.equal(CUSTOMIZE_SEARCH_PLACEHOLDER, "Search Plugins, Skills, MCPs...");
    assert.ok(html.includes('aria-label="Browse Marketplace"'));
    assert.ok(html.includes('aria-label="Manage scope"'));
  });

  it("DD-CV-4: Plugins has primary '+ Add' with the 3-source menu", () => {
    assert.ok(html.includes("From Marketplace"));
    assert.ok(html.includes("From GitHub Repository"));
    assert.ok(html.includes("From Local Repository"));
    assert.ok(html.includes("cv-btn--primary"));
  });

  it("DD-CV-4: other sections have secondary New + outline Documentation", () => {
    assert.ok(html.includes("cv-btn--secondary"));
    assert.ok(html.includes(">Documentation</button>"));
  });

  it("DD-CV-4: Hooks has Execution Log (count badge, empty state) and NO New button", () => {
    const hooksPane = html.split('data-pane="hooks"')[1] ?? "";
    assert.ok(hooksPane.includes("Execution Log"));
    assert.ok(hooksPane.includes("No hook executions yet"));
    assert.ok(hooksPane.includes("Hooks that run during the agent's loop will show up here."));
    assert.ok(hooksPane.includes("Clear log"));
    assert.ok(!hooksPane.includes(">New</button>"), "hooks pane must not have a New button");
  });

  it("DD-CV-2: Commands section shows 'Create Reusable Commands' with /name copy", () => {
    const commandsPane = html.split('data-pane="commands"')[1] ?? "";
    assert.ok(commandsPane.includes("Create Reusable Commands"));
    assert.ok(commandsPane.includes("/name"));
  });

  it("renders real item rows (MCP servers) with scope/state badges", () => {
    const snap = emptySnapshot();
    snap.mcps = [
      { id: "linear", name: "Linear", scope: "workspace", state: "ready", toolCount: 5 },
    ];
    const h = createCustomizeHtml(snap, "mcps", SCOPE_ALL, "");
    assert.ok(h.includes("Linear"));
    assert.ok(h.includes("5 tools"));
    assert.ok(h.includes("Workspace · ready"));
  });

  it("plugins section renders real installed extensions (open-plugin rows, no placeholder note)", () => {
    const snap = emptySnapshot();
    snap.plugins = [
      { id: "ms-python.python", displayName: "Python", version: "1.2.3", description: "Python language support" },
    ];
    const h = createCustomizeHtml(snap, "plugins", SCOPE_ALL, "");
    const pane = h.split('data-pane="plugins"')[1].split('data-pane="mcps"')[0];
    assert.ok(pane.includes("Python"));
    assert.ok(pane.includes("v1.2.3"));
    assert.ok(pane.includes('data-action="open-plugin"'));
    assert.ok(pane.includes('data-id="ms-python.python"'));
    assert.ok(!pane.includes("cv-source-note"), "real sections must not show the placeholder note");
  });

  it("subagents section renders real engine agent files (open-item rows, no placeholder note)", () => {
    const snap = emptySnapshot();
    snap.agents = [
      { name: "reviewer", description: "reviews code", filePath: "/home/u/.config/opencode/agent/reviewer.md", scope: "user" },
    ];
    const h = createCustomizeHtml(snap, "agents", SCOPE_ALL, "");
    const pane = h.split('data-pane="agents"')[1].split('data-pane="rules"')[0];
    assert.ok(pane.includes("reviewer"));
    assert.ok(pane.includes("reviews code"));
    assert.ok(pane.includes("User"));
    assert.ok(pane.includes('data-action="open-item"'));
    assert.ok(pane.includes('data-kind="agent"'));
    assert.ok(!pane.includes("cv-source-note"), "real sections must not show the placeholder note");
  });

  it("plugins search filters rows without dropping the section", () => {
    const snap = emptySnapshot();
    snap.plugins = [
      { id: "a.x", displayName: "Alpha", version: "1.0.0", description: "" },
      { id: "b.y", displayName: "Beta", version: "2.0.0", description: "" },
    ];
    const h = createCustomizeHtml(snap, "plugins", SCOPE_ALL, "beta");
    const pane = h.split('data-pane="plugins"')[1].split('data-pane="mcps"')[0];
    assert.ok(pane.includes("Beta"));
    assert.ok(!pane.includes("Alpha"));
  });

  it("escapes item names (no HTML injection from config files)", () => {
    const snap = emptySnapshot();
    snap.skills = [
      { name: "<img src=x>", description: "d", filePath: "/f", scope: "user" },
    ];
    const h = createCustomizeHtml(snap, "skills", SCOPE_ALL, "");
    assert.ok(!h.includes("<img src=x>"));
    assert.ok(h.includes("&lt;img src=x&gt;"));
  });
});

describe("Entry points", () => {
  it("openCustomizeEditor issues vscode.openWith on the singleton URI and selects the tab", async () => {
    const calls: Array<{ command: string; args: unknown[] }> = [];
    (vscodeStub.commands as { calls: Array<{ command: string; args: unknown[] }> }).calls.length = 0;
    const selected: string[] = [];
    const provider = {
      selectTab: (tab: CustomizeSectionId) => {
        selected.push(tab);
      },
    } as never;

    await openCustomizeEditor(provider, "hooks");
    const openWith = (vscodeStub.commands as { calls: Array<{ command: string; args: unknown[] }> }).calls;
    assert.equal(openWith.length, 1);
    assert.equal(openWith[0].command, "vscode.openWith");
    const uri = openWith[0].args[0] as { scheme: string; path: string };
    assert.equal(uri.scheme, CUSTOMIZE_EDITOR_SCHEME);
    assert.equal(openWith[0].args[1], CUSTOMIZE_EDITOR_VIEW_TYPE);
    assert.deepEqual(selected, ["hooks"]);
    void calls;
  });

  it("openCustomizeEditor without a tab opens the default (plugins) view", async () => {
    (vscodeStub.commands as { calls: Array<{ command: string; args: unknown[] }> }).calls.length = 0;
    const provider = { selectTab: (_t: CustomizeSectionId) => undefined } as never;
    await openCustomizeEditor(provider);
    const openWith = (vscodeStub.commands as { calls: Array<{ command: string; args: unknown[] }> }).calls;
    const uri = openWith[0].args[0] as { scheme: string; path: string };
    assert.equal(uri.path, "/plugins");
  });

  it("CustomizeHostDeps shape is honored by the provider module", () => {
    // Compile-time check: a minimal deps object satisfies the interface.
    const deps: CustomizeHostDeps = {
      getSnapshot: () => emptySnapshot(),
      refreshSources: () => undefined,
      clearHookLog: () => undefined,
      openDocumentation: () => undefined,
      browseMarketplace: () => undefined,
      addPluginFrom: () => undefined,
      openPlugin: () => undefined,
      createMcp: () => undefined,
      createSkill: () => undefined,
      createSubagent: () => undefined,
      createRule: () => undefined,
      createCommand: () => undefined,
      openItem: () => undefined,
    };
    assert.ok(deps);
  });
});
