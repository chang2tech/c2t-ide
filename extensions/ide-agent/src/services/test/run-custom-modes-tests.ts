/**
 * WORKER-GAPS-11E tests (node:test, no vscode dependency).
 *
 * Guards the agent-custom-modes + agent-mode-triage parity
 * (docs/rea/audit-fix-queue.md; binary workbench.glass.main.js 3.25.6/3.25.9):
 *   src/vs/workbench/contrib/composer/common/customModes.ts
 *
 * Two layers, like the sibling run-approval-review-kinds-tests.ts:
 *  1. Verbatim source checks — binary-pinned constants and the triage def
 *     (PROTECTED_MODE_IDS, ACTION_ID_PREFIX, sort order, picker exclusion,
 *     storage field, export command id, gate name, triage description).
 *  2. Behavioral checks — the core module is dependency-free, so it is
 *     transpiled with typescript.transpileModule and executed for real:
 *     getAllModes() filter/sort semantics, getMode() protected fallback,
 *     checkIfModeExists(), generateActionIdForMode(), registerableModeActions()
 *     (no command for triage/spec), the registry CRUD + export, and the
 *     fvC/OWE ports.
 *
 * Run after `tsc`:
 *   node --test out/services/test/run-custom-modes-tests.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as ts from "typescript";

const corePath =
  process.env.CUSTOM_MODES_PATH ??
  path.join(
    __dirname,
    "..",
    "..",
    "..",
    "..",
    "..",
    "src",
    "vs",
    "workbench",
    "contrib",
    "composer",
    "common",
    "customModes.ts",
  );
const src = fs.readFileSync(corePath, "utf8");

// --- behavioral: transpile the zero-dependency core module and load it ---
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const mod = { exports: {} as Record<string, unknown> };
// The module has no imports; `require` is passed but never called.
new Function("module", "exports", "require", js)(
  mod,
  mod.exports,
  require,
);
const M = mod.exports as Record<string, any>;

function inMemoryStorage(initial: any[] = []) {
  let data: any[] = initial.map((m) => ({ ...m }));
  return {
    load: () => data.map((m) => ({ ...m })),
    save: (modes: any[]) => {
      data = modes.map((m) => ({ ...m }));
    },
  };
}

describe("custom-modes: verbatim binary constants", () => {
  it("ACTION_ID_PREFIX is composerMode.", () => {
    assert.ok(
      src.includes(`export const ACTION_ID_PREFIX = 'composerMode.';`),
      "ACTION_ID_PREFIX verbatim",
    );
  });

  it("PROTECTED_MODE_IDS matches the binary list and order", () => {
    const start = src.indexOf("export const PROTECTED_MODE_IDS = [");
    assert.ok(start >= 0, "missing PROTECTED_MODE_IDS");
    const end = src.indexOf("] as const;", start);
    const body = src.slice(start, end);
    for (const id of [
      "agent",
      "chat",
      "edit",
      "background",
      "plan",
      "spec",
      "debug",
      "multitask",
      "triage",
    ]) {
      assert.ok(body.includes(`'${id}'`), `PROTECTED_MODE_IDS missing ${id}`);
    }
    // Order pinned: triage is last in the binary's array.
    assert.ok(
      body.lastIndexOf("'triage'") > body.lastIndexOf("'multitask'"),
      "triage must be the last protected id (binary order)",
    );
  });

  it("MODE_SORT_ORDER is the binary getAllModes order", () => {
    const start = src.indexOf("export const MODE_SORT_ORDER = [");
    assert.ok(start >= 0, "missing MODE_SORT_ORDER");
    const end = src.indexOf("] as const;", start);
    const body = src.slice(start, end);
    const ids = [...body.matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
    assert.deepStrictEqual(ids, [
      "agent",
      "triage",
      "plan",
      "spec",
      "debug",
      "multitask",
      "chat",
    ]);
  });

  it("picker exclusion is exactly spec + triage", () => {
    assert.ok(
      src.includes(`export const PICKER_EXCLUDED_MODE_IDS = ['spec', 'triage'] as const;`),
      "PICKER_EXCLUDED_MODE_IDS verbatim",
    );
  });

  it("storage field, gate, export command id are binary-verbatim", () => {
    assert.ok(src.includes(`export const MODES_STORAGE_FIELD = 'modes4';`));
    assert.ok(src.includes(`export const CUSTOM_MODES_GATE = 'glass_custom_modes';`));
    assert.ok(
      src.includes(`export const CUSTOM_MODES_GATE_DEFAULT_ON = false;`),
      "gate default OFF like the binary",
    );
    assert.ok(
      src.includes(
        `export const EXPORT_CUSTOM_MODES_COMMAND_ID = 'workbench.action.exportCustomModes';`,
      ),
    );
  });

  it("triage def is binary-verbatim", () => {
    assert.ok(
      src.includes(`description: 'Coordinate long-horizon tasks with delegated subagents'`),
      "triage description verbatim",
    );
    assert.ok(
      src.includes(`id: 'triage', name: 'Triage', actionId: 'composerMode.triage', icon: 'rocket'`),
      "triage identity fields verbatim",
    );
    assert.ok(
      src.includes(`enabledTools: ['TASK_V2', 'APPLY_AGENT_DIFF']`),
      "triage enabledTools verbatim",
    );
  });

  it("triage is pinned as NOT picker-selectable", () => {
    assert.ok(src.includes(`export const TRIAGE_PICKER_SELECTABLE = false;`));
  });

  it("seed order is agent, triage, plan, spec, debug, multitask, chat", () => {
    const start = src.indexOf("export const BUILTIN_MODE_SEEDS");
    assert.ok(start >= 0);
    const ids = [...src.slice(start).matchAll(/id: '([a-z]+)'/g)]
      .map((m) => m[1])
      .slice(0, 7);
    assert.deepStrictEqual(ids, [
      "agent",
      "triage",
      "plan",
      "spec",
      "debug",
      "multitask",
      "chat",
    ]);
  });
});

describe("custom-modes: getAllModes() binary semantics", () => {
  const seeds: any[] = M.BUILTIN_MODE_SEEDS;

  it("drops spec and triage from the picker list", () => {
    const ids = M.getAllModes(seeds).map((m: any) => m.id);
    assert.ok(!ids.includes("spec"), "spec excluded");
    assert.ok(!ids.includes("triage"), "triage excluded");
  });

  it("sorts by the binary order: agent, plan, debug, multitask, chat", () => {
    const ids = M.getAllModes(seeds).map((m: any) => m.id);
    assert.deepStrictEqual(ids, ["agent", "plan", "debug", "multitask", "chat"]);
  });

  it("drops user custom modes (they ride as overlays, not unifiedModes)", () => {
    const stored = [
      ...seeds,
      {
        id: "review-frontend",
        name: "Review Frontend",
        icon: "eye",
        description: "x",
        thinkingLevel: "none",
        shouldAutoApplyIfNoEditTool: false,
        autoFix: false,
        autoRun: false,
        fullAutoRun: false,
        enabledTools: [],
        enabledMcpServers: [],
      },
    ];
    const ids = M.getAllModes(stored).map((m: any) => m.id);
    assert.ok(
      !ids.includes("review-frontend"),
      "custom modes are not in getAllModes() (binary semantics)",
    );
  });

  it("protected ids missing from the sort order keep raw storage order", () => {
    const background = {
      id: "background",
      name: "Background",
      icon: "cloud",
      description: "x",
      thinkingLevel: "none",
      shouldAutoApplyIfNoEditTool: false,
      autoFix: false,
      autoRun: true,
      fullAutoRun: false,
      enabledTools: [],
      enabledMcpServers: [],
    };
    // background appended after chat in storage → stays last (binary: raw index fallback)
    const ids = M.getAllModes([...seeds, background]).map((m: any) => m.id);
    assert.deepStrictEqual(ids, ["agent", "plan", "debug", "multitask", "chat", "background"]);
  });

  it("does not mutate the stored array", () => {
    const stored = [...seeds].reverse();
    M.getAllModes(stored);
    assert.strictEqual(stored[0].id, "chat", "input order preserved");
  });
});

describe("custom-modes: getMode() / checkIfModeExists()", () => {
  const seeds: any[] = M.BUILTIN_MODE_SEEDS;

  it("getMode resolves triage via the protected fallback", () => {
    const triage = M.getMode(seeds, "triage");
    assert.ok(triage, "triage resolves");
    assert.strictEqual(triage.actionId, "composerMode.triage");
  });

  it("getMode resolves spec via the protected fallback", () => {
    assert.strictEqual(M.getMode(seeds, "spec")?.id, "spec");
  });

  it("getMode returns undefined for unknown non-protected ids", () => {
    assert.strictEqual(M.getMode(seeds, "nope"), undefined);
  });

  it("checkIfModeExists is true for picker modes and hidden protected modes", () => {
    assert.ok(M.checkIfModeExists(seeds, "agent"));
    assert.ok(M.checkIfModeExists(seeds, "triage"), "triage exists (protected)");
    assert.ok(M.checkIfModeExists(seeds, "spec"), "spec exists (protected)");
    assert.ok(!M.checkIfModeExists(seeds, "custom-foo"), "custom ids are not unifiedModes");
  });
});

describe("custom-modes: action ids", () => {
  const seeds: any[] = M.BUILTIN_MODE_SEEDS;

  it("generateActionIdForMode slugifies the name", () => {
    const id = M.generateActionIdForMode({ id: "x", name: "Code Review" }, seeds);
    assert.strictEqual(id, "composerMode.code_review");
  });

  it("generateActionIdForMode dedupes with _2", () => {
    const withClash = [
      ...seeds,
      { id: "other", name: "Code Review", actionId: "composerMode.code_review" },
    ];
    const id = M.generateActionIdForMode({ id: "x", name: "Code Review" }, withClash);
    assert.strictEqual(id, "composerMode.code_review_2");
  });

  it("generateActionIdForMode falls back to the id when nameless", () => {
    const id = M.generateActionIdForMode({ id: "x", name: "" }, seeds);
    assert.strictEqual(id, "composerMode.x");
  });

  it("registerableModeActions excludes triage and spec (no command registered)", () => {
    const actions = M.registerableModeActions(seeds);
    const byId = new Map(actions.map((a: any) => [a.modeId, a.actionId]));
    assert.strictEqual(byId.get("agent"), "composerMode.agent");
    assert.strictEqual(byId.get("plan"), "composerMode.plan");
    assert.ok(!byId.has("triage"), "no composerMode.triage command (binary @40173411)");
    assert.ok(!byId.has("spec"), "no composerMode.spec command");
  });
});

describe("custom-modes: registry CRUD", () => {
  it("ensureSeeded seeds an empty store with the builtins", () => {
    const storage = inMemoryStorage([]);
    const reg = new M.ComposerModesRegistry(storage);
    reg.ensureSeeded();
    const ids = storage.load().map((m: any) => m.id);
    assert.deepStrictEqual(ids, [
      "agent",
      "triage",
      "plan",
      "spec",
      "debug",
      "multitask",
      "chat",
    ]);
  });

  it("upsertCustomMode registers a custom mode with a generated actionId", () => {
    const storage = inMemoryStorage([]);
    const reg = new M.ComposerModesRegistry(storage);
    reg.ensureSeeded();
    const created = reg.upsertCustomMode({
      id: "review-frontend",
      name: "Review Frontend",
      icon: "eye",
      description: "Review UI code",
      thinkingLevel: "none",
      shouldAutoApplyIfNoEditTool: false,
      autoFix: false,
      autoRun: false,
      fullAutoRun: false,
      enabledTools: [],
      enabledMcpServers: [],
      customRulesForAI: "Be strict about a11y.",
    });
    assert.strictEqual(created.actionId, "composerMode.review_frontend");
    assert.ok(reg.hasCustomModes(), "existence checker fires");
    assert.deepStrictEqual(
      reg.getCustomModes().map((m: any) => m.id),
      ["review-frontend"],
    );
  });

  it("upsertCustomMode refuses protected ids", () => {
    const storage = inMemoryStorage([]);
    const reg = new M.ComposerModesRegistry(storage);
    reg.ensureSeeded();
    assert.throws(
      () =>
        reg.upsertCustomMode({
          id: "triage",
          name: "Fake Triage",
          icon: "x",
          description: "x",
          thinkingLevel: "none",
          shouldAutoApplyIfNoEditTool: false,
          autoFix: false,
          autoRun: false,
          fullAutoRun: false,
          enabledTools: [],
          enabledMcpServers: [],
        }),
      /protected mode id/,
    );
  });

  it("deleteCustomMode removes customs but never protected modes", () => {
    const storage = inMemoryStorage([]);
    const reg = new M.ComposerModesRegistry(storage);
    reg.ensureSeeded();
    reg.upsertCustomMode({
      id: "review-frontend",
      name: "Review Frontend",
      icon: "eye",
      description: "x",
      thinkingLevel: "none",
      shouldAutoApplyIfNoEditTool: false,
      autoFix: false,
      autoRun: false,
      fullAutoRun: false,
      enabledTools: [],
      enabledMcpServers: [],
    });
    assert.strictEqual(reg.deleteCustomMode("triage"), false, "protected: no delete");
    assert.strictEqual(reg.deleteCustomMode("missing"), false);
    assert.strictEqual(reg.deleteCustomMode("review-frontend"), true);
    assert.ok(!reg.hasCustomModes());
  });

  it("updateMode / setModeAutoRun mutate one stored def", () => {
    const storage = inMemoryStorage([]);
    const reg = new M.ComposerModesRegistry(storage);
    reg.ensureSeeded();
    assert.ok(reg.setModeAutoRun("plan", true));
    assert.strictEqual(reg.getMode("plan")?.autoRun, true);
    assert.ok(reg.setModeThinkingLevel("plan", "high"));
    assert.strictEqual(reg.getMode("plan")?.thinkingLevel, "high");
    assert.strictEqual(reg.setModeAutoRun("nope", true), false);
  });

  it("resetToDefaults restores the seed list", () => {
    const storage = inMemoryStorage([]);
    const reg = new M.ComposerModesRegistry(storage);
    reg.ensureSeeded();
    reg.upsertCustomMode({
      id: "review-frontend",
      name: "Review Frontend",
      icon: "eye",
      description: "x",
      thinkingLevel: "none",
      shouldAutoApplyIfNoEditTool: false,
      autoFix: false,
      autoRun: false,
      fullAutoRun: false,
      enabledTools: [],
      enabledMcpServers: [],
    });
    reg.resetToDefaults();
    assert.ok(!reg.hasCustomModes());
    assert.strictEqual(storage.load().length, 7);
  });
});

describe("custom-modes: export (OWE/BWE port)", () => {
  it("serializeCustomModeExport matches the binary OWE format", () => {
    const content = M.serializeCustomModeExport({
      id: "review-frontend",
      name: "Review Frontend",
      enabledTools: ["TASK_V2", "READ_FILE", "APPLY_AGENT_DIFF", "NOPE_UNKNOWN"],
      customRulesForAI: "Be strict about a11y.",
    });
    // APPLY_AGENT_DIFF → "" (binary BWE has no case) and unknowns are filtered.
    assert.strictEqual(
      content,
      "Only using the following tools: Task, Read\n\nBe strict about a11y.\n",
    );
  });

  it("export omits the tools line when no tools map", () => {
    const content = M.serializeCustomModeExport({
      id: "x",
      name: "X",
      enabledTools: [],
      customRulesForAI: "Rules here.",
    });
    assert.strictEqual(content, "Rules here.\n");
  });

  it("exportFileNameFor sanitizes and dedupes like the binary", () => {
    const taken = new Set<string>();
    const a = M.exportFileNameFor({ name: "Review Frontend" }, 0, taken);
    const b = M.exportFileNameFor({ name: "Review Frontend" }, 1, taken);
    const c = M.exportFileNameFor({ name: "  " }, 2, taken);
    assert.strictEqual(a, "review-frontend.md");
    assert.strictEqual(b, "review-frontend_1.md");
    assert.strictEqual(c, "mode-3.md");
  });

  it("registry.exportCustomModes emits one file per custom mode", () => {
    const storage = inMemoryStorage([]);
    const reg = new M.ComposerModesRegistry(storage);
    reg.ensureSeeded();
    reg.upsertCustomMode({
      id: "review-frontend",
      name: "Review Frontend",
      icon: "eye",
      description: "x",
      thinkingLevel: "none",
      shouldAutoApplyIfNoEditTool: false,
      autoFix: false,
      autoRun: false,
      fullAutoRun: false,
      enabledTools: ["TASK_V2"],
      enabledMcpServers: [],
      customRulesForAI: "Be strict.",
    });
    const files = reg.exportCustomModes();
    assert.strictEqual(files.length, 1);
    assert.strictEqual(files[0].fileName, "review-frontend.md");
    assert.strictEqual(files[0].content, "Only using the following tools: Task\n\nBe strict.\n");
  });
});

describe("custom-modes: slash-command → mode (fvC port)", () => {
  it("returns undefined when no skill filename can be determined", () => {
    assert.strictEqual(
      M.customModeFromSlashCommand({ id: "   ", label: "X" }),
      undefined,
    );
  });

  it("maps fields like the binary fvC", () => {
    const mode = M.customModeFromSlashCommand({
      id: "review-frontend.md",
      label: "Review Frontend",
      commandName: "review-frontend",
      description: "Review UI code",
      sourceUri: "/home/u/.cursor/commands/review-frontend.md",
    });
    assert.ok(mode);
    assert.strictEqual(mode.cacheState, "cached-display");
    assert.strictEqual(mode.label, "Review Frontend");
    assert.strictEqual(mode.fullPath, "/home/u/.cursor/commands/review-frontend.md");
    assert.deepStrictEqual(mode.badgeAppearance, { icon: "lightning", colorId: "default" });
    assert.strictEqual(mode.source, "repo-skill");
    assert.strictEqual(mode.skillFilename, "review-frontend");
  });

  it("managedSkillId selects the managed-skill source", () => {
    const mode = M.customModeFromSlashCommand({
      id: "x.md",
      label: "X",
      managedSkillId: "m-1",
    });
    assert.strictEqual(mode?.source, "managed-skill");
  });

  it("buildCustomModeIdBySkillKey keys by id, label and commandName", () => {
    const mode: any = M.customModeFromSlashCommand({
      id: "review.md",
      label: "Review",
      commandName: "review",
    });
    const map: Map<string, string> = M.buildCustomModeIdBySkillKey([
      { command: { id: "review.md", label: "Review", commandName: "review" }, mode },
    ]);
    assert.strictEqual(map.get("review.md"), mode.id);
    assert.strictEqual(map.get("Review"), mode.id);
    assert.strictEqual(map.get("review"), mode.id);
  });

  it("activateCustomModeOverlay returns a custom-kind descriptor (not a unifiedMode)", () => {
    const mode: any = M.customModeFromSlashCommand({ id: "review.md", label: "Review" });
    const act = M.activateCustomModeOverlay(mode);
    assert.strictEqual(act.kind, "custom");
    assert.strictEqual(act.modeId, mode.id);
  });
});
