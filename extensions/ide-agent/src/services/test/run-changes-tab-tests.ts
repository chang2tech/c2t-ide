/**
 * DEV-GAPS-10: Changes tab tests (node:test, vscode stubbed only where needed).
 *
 * Covers (Cursor `workbench-open-changes-tab` parity, audit-fix-queue run 24):
 *  - normalizeOpenChangesTabArgs: binary-verified defaults (scope "lastTurn",
 *    initialFilterScope "branch", agentId "default"), both verbatim arg
 *    shapes (local {scope,agentId,filePath?} + cloud-agent
 *    {bcId,label,initialFilterScope,ownerAgentId}), unknown keys dropped.
 *  - CHANGES_TAB_NEW_TAB_ACTION: verbatim binary new-tab-model action
 *    {id:"changes", label:"Changes", keywords:["git"], icon:"plus-minus",
 *    keybindingCommandId:"glass.openChangesTab"}.
 *  - CHANGES_TAB_COMMAND_IDS: ide.* -> composer.* -> glass.* layout.
 *  - Static source assertions on workbench core composerChangesTab.ts:
 *    canonical `composer.openChangesTab` + compat `glass.openChangesTab`,
 *    availability-policy names documented as UNKNOWN (not reimplemented),
 *    review editor input/pane + `composer-changes-review` provider,
 *    palette gated on `composer.changesTabEnabled`.
 *  - package.json: `ide.openChangesTab` contributed (title "Changes",
 *    icon fallback `$(diff)` — `plus-minus` is not in this codicon set),
 *    palette entry gated on `composer.changesTabEnabled`.
 *  - extension.ts: COMMANDS entry + delegation case to the core command.
 *
 * Run after `tsc`:  node --test out/services/test/run-changes-tab-tests.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  CHANGES_TAB_COMMAND_IDS,
  CHANGES_TAB_NEW_TAB_ACTION,
  normalizeOpenChangesTabArgs,
} from "../changesTab";

describe("normalizeOpenChangesTabArgs — binary-verified defaults", () => {
  it("applies defaults for empty/missing input", () => {
    for (const raw of [{}, undefined, null, 42, "changes"]) {
      const n = normalizeOpenChangesTabArgs(raw);
      assert.strictEqual(n.scope, "lastTurn");
      assert.strictEqual(n.agentId, "default");
      assert.strictEqual(n.initialFilterScope, "branch");
      assert.strictEqual(n.filePath, undefined);
      assert.strictEqual(n.bcId, undefined);
      assert.strictEqual(n.label, undefined);
      assert.strictEqual(n.ownerAgentId, undefined);
    }
  });

  it("passes through the binary local invocation shape", () => {
    const n = normalizeOpenChangesTabArgs({
      scope: "lastTurn",
      agentId: "agent-1",
      filePath: "/repo/src/a.ts",
    });
    assert.strictEqual(n.scope, "lastTurn");
    assert.strictEqual(n.agentId, "agent-1");
    assert.strictEqual(n.filePath, "/repo/src/a.ts");
    assert.strictEqual(n.initialFilterScope, "branch");
  });

  it("passes through the binary cloud-agent invocation shape", () => {
    const n = normalizeOpenChangesTabArgs({
      bcId: "bc-9",
      label: "Add login page",
      initialFilterScope: "branch",
      ownerAgentId: "owner-7",
    });
    assert.strictEqual(n.bcId, "bc-9");
    assert.strictEqual(n.label, "Add login page");
    assert.strictEqual(n.initialFilterScope, "branch");
    assert.strictEqual(n.ownerAgentId, "owner-7");
    // local defaults still apply alongside
    assert.strictEqual(n.scope, "lastTurn");
    assert.strictEqual(n.agentId, "default");
  });

  it("treats empty strings and non-strings as absent", () => {
    const n = normalizeOpenChangesTabArgs({
      scope: "",
      agentId: "",
      filePath: 123,
      label: "",
    });
    assert.strictEqual(n.scope, "lastTurn");
    assert.strictEqual(n.agentId, "default");
    assert.strictEqual(n.filePath, undefined);
    assert.strictEqual(n.label, undefined);
  });

  it("drops keys outside the evidence-backed arg shape", () => {
    const n = normalizeOpenChangesTabArgs({
      scope: "lastTurn",
      agentId: "a",
      evil: "x",
      __proto__: { polluted: true },
    } as unknown);
    assert.strictEqual((n as unknown as Record<string, unknown>)["evil"], undefined);
    assert.strictEqual(
      (n as unknown as Record<string, unknown>)["polluted"],
      undefined,
    );
  });
});

describe("CHANGES_TAB_NEW_TAB_ACTION — verbatim binary action", () => {
  it("matches the binary new-tab-model action character-for-character", () => {
    assert.strictEqual(CHANGES_TAB_NEW_TAB_ACTION.id, "changes");
    assert.strictEqual(CHANGES_TAB_NEW_TAB_ACTION.label, "Changes");
    assert.deepStrictEqual([...CHANGES_TAB_NEW_TAB_ACTION.keywords], ["git"]);
    assert.strictEqual(CHANGES_TAB_NEW_TAB_ACTION.icon, "plus-minus");
    assert.strictEqual(
      CHANGES_TAB_NEW_TAB_ACTION.keybindingCommandId,
      "glass.openChangesTab",
    );
  });
});

describe("CHANGES_TAB_COMMAND_IDS — ide.* -> composer.* -> glass.* layout", () => {
  it("uses the repo's command-id convention", () => {
    assert.strictEqual(CHANGES_TAB_COMMAND_IDS.extension, "ide.openChangesTab");
    assert.strictEqual(CHANGES_TAB_COMMAND_IDS.core, "composer.openChangesTab");
    assert.strictEqual(CHANGES_TAB_COMMAND_IDS.glassCompat, "glass.openChangesTab");
  });
});

// ---- static source assertions (workbench core + extension wiring) ----------

const vscodeRoot = path.join(
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
  "browser",
);
const changesTabSrc = fs.readFileSync(
  path.join(vscodeRoot, "composerChangesTab.ts"),
  "utf8",
);
const contributionSrc = fs.readFileSync(
  path.join(vscodeRoot, "composer.contribution.ts"),
  "utf8",
);
const extensionSrc = fs.readFileSync(
  path.join(
    __dirname,
    "..",
    "..",
    "..",
    "src",
    "extension.ts",
  ),
  "utf8",
);
const packageJson = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "..", "..", "..", "package.json"),
    "utf8",
  ),
) as {
  contributes: {
    commands: Array<{
      command: string;
      title: string;
      category?: string;
      icon?: string;
    }>;
    menus: { commandPalette: Array<{ command: string; when?: string }> };
  };
};

describe("core composerChangesTab.ts — command surface", () => {
  it("registers the canonical core action `composer.openChangesTab`", () => {
    assert.ok(changesTabSrc.includes("composer.openChangesTab"));
    assert.ok(
      changesTabSrc.includes("class ComposerOpenChangesTabAction"),
      "canonical Action2 class",
    );
  });

  it("does NOT double-register the verbatim binary id `glass.openChangesTab`", () => {
    // `glass.openChangesTab` is owned by
    // src/vs/sessions/contrib/changes/browser/openChangesTabCommand.ts.
    // CommandsRegistry is last-registration-wins per id, so the composer
    // side keeps the verbatim id as DATA only (keybindingCommandId) and must
    // not register an Action2 with it.
    assert.ok(
      !changesTabSrc.includes("class GlassOpenChangesTabCompatAction"),
      "no compat alias class",
    );
    assert.ok(
      changesTabSrc.includes('keybindingCommandId: \'glass.openChangesTab\''),
      "verbatim id kept as data in GLASS_CHANGES_TAB_ACTION",
    );
  });

  it("supports both binary-verbatim arg shapes", () => {
    for (const field of [
      "filePath",
      "bcId",
      "label",
      "initialFilterScope",
      "ownerAgentId",
    ]) {
      assert.ok(
        changesTabSrc.includes(field),
        `OpenChangesTabArgs carries ${field}`,
      );
    }
    assert.ok(
      changesTabSrc.includes('"branch"'),
      'binary default initialFilterScope:"branch"',
    );
  });

  it("documents the availability policy without fabricating semantics", () => {
    for (const name of [
      "changesTabAvailable",
      "_isChangesTabActivatable",
      "preferChangesAsDefault",
      "_panelReplacementAutoSeedPolicy",
    ]) {
      assert.ok(
        changesTabSrc.includes(name),
        `policy name ${name} is documented`,
      );
    }
    assert.ok(
      changesTabSrc.includes("UNKNOWN"),
      "unverifiable semantics are marked UNKNOWN",
    );
    // The one VERIFIED gate is enforced at run() time, not just the palette.
    assert.ok(
      changesTabSrc.includes("ChangesTabAvailabilityPolicy.isAvailable"),
      "run-time availability guard",
    );
  });

  it("gates the palette entry on the showChangesAction analog", () => {
    assert.ok(
      changesTabSrc.includes("ComposerContextKeys.changesTabEnabled"),
      "palette when-clause",
    );
  });

  it("implements the Review Changes editor surface", () => {
    assert.ok(
      changesTabSrc.includes("class ComposerReviewChangesEditorInput"),
      "tab identity (reviewChangesTabIdentity.js analog)",
    );
    assert.ok(
      changesTabSrc.includes("class ComposerReviewChangesEditorPane"),
      "review editor (reviewChangesEditor.js analog)",
    );
    assert.ok(
      changesTabSrc.includes("Review Changes"),
      'verbatim UI string "Review Changes"',
    );
    assert.ok(
      changesTabSrc.includes("composer-changes-review"),
      "before-snapshot content-provider scheme",
    );
    assert.ok(
      changesTabSrc.includes("registerChangesReviewContentProvider"),
      "provider registration entry point",
    );
    assert.ok(
      changesTabSrc.includes("IResourceDiffEditorInput"),
      "per-file diff editors",
    );
  });

  it("keeps the verbatim new-tab-model action as data", () => {
    assert.ok(changesTabSrc.includes("GLASS_CHANGES_TAB_ACTION"));
    assert.ok(changesTabSrc.includes('"plus-minus"'));
    assert.ok(changesTabSrc.includes("keywords: ['git']"));
  });
});

describe("core composer.contribution.ts — wiring", () => {
  it("registers the review before-snapshot content provider", () => {
    assert.ok(
      contributionSrc.includes("registerChangesReviewContentProvider"),
      "provider wired with instantiated services",
    );
  });
});

describe("package.json — ide.openChangesTab contribution", () => {
  it("contributes the command with title 'Changes'", () => {
    const cmd = packageJson.contributes.commands.find(
      (c) => c.command === "ide.openChangesTab",
    );
    assert.ok(cmd, "command is contributed");
    assert.strictEqual(cmd!.title, "Changes");
    assert.strictEqual(cmd!.category, "IDE Agent");
    // `plus-minus` is not in this codicon set — `diff` is the closest
    // fallback (documented in services/changesTab.ts).
    assert.strictEqual(cmd!.icon, "$(diff)");
  });

  // QA-MIGRATION-C (P2 migration-double-commands, 2026-10-20): the extension's
  // `ide.openChangesTab` is palette-HIDDEN (`when: "false"`). The canonical palette
  // entry for the Changes tab action is the core `composer.openChangesTab` Action2
  // (gated on `composer.changesTabEnabled`); showing the extension alias too put two
  // "Changes" rows in the palette for one action. The command id itself must keep
  // existing (registered in extension.ts, delegates to CHANGES_TAB_COMMAND_IDS.core).
  it("hides the palette entry (canonical entry is composer.openChangesTab)", () => {
    const entry = packageJson.contributes.menus.commandPalette.find(
      (m) => m.command === "ide.openChangesTab",
    );
    assert.ok(entry, "palette menu entry exists");
    assert.strictEqual(
      entry!.when,
      "false",
      "ide.openChangesTab must be palette-hidden (when: false); the canonical entry is composer.openChangesTab",
    );
  });
});

describe("extension.ts — registration", () => {
  it("lists ide.openChangesTab in COMMANDS", () => {
    assert.ok(extensionSrc.includes('"ide.openChangesTab"'));
  });

  it("delegates to the canonical core action", () => {
    assert.ok(
      extensionSrc.includes("CHANGES_TAB_COMMAND_IDS.core"),
      "case uses the shared command-id constant",
    );
    assert.ok(
      extensionSrc.includes("normalizeOpenChangesTabArgs"),
      "args are normalized before delegating",
    );
  });
});
