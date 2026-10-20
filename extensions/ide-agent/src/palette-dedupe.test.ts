/**
 * Palette dedupe tests — QA-MIGRATION-C (P2 `migration-double-commands`, 2026-10-20).
 *
 * The fork registers each user action once under the canonical core `composer.*`
 * prefix (migration decision `ide.*` -> `composer.*`, docs/rea/contributes-migration-map.md
 * decision 1; Cursor's binary uses `composer.*`/`glass.*` ids). The extension-runtime
 * `ide.*` aliases and verbatim-binary compat ids must keep EXISTING (internal
 * `executeCommand('ide.*')` callers + keybindings depend on them) but must NOT be
 * palette-visible — otherwise the Command Palette shows 2-3 rows for one action.
 *
 * This test loads the real registrations (package.json + the core Action2 sources)
 * and asserts:
 *  1. no two palette-visible commands share (title, category);
 *  2. each known action cluster has exactly ONE palette-visible entry;
 *  3. the hidden aliases are still registered (dedupe hides, never deletes);
 *  4. keybindings on the hidden compat ids still exist (palette visibility and
 *     keybindings are independent in `registerAction2`).
 *
 * node:test, zero extra deps. Run after `tsc`: node out/palette-dedupe.test.js
 *
 * DEV-GAPS-82 CORRECTION (2026-10-20): `glass.openChangesTab` is NOT a hidden
 * alias — the Cursor 3.25.9 binary registers it palette-visible
 * (workbench.glass.main.js @45508387: `Ir({id:ogl,title:"Review Changes",...,
 * f1:!0,...})`; `!0` = true). The changes-tab cluster therefore legitimately
 * has TWO visible rows with distinct (title, category): the binary-verbatim
 * "Review Changes" [Sessions] and the fork-canonical gated "Changes"
 * [Composer]. The agents-window cluster is unaffected (its binary analog
 * `cursor.openOrFocusGlassWindow` is f1:!1, desktop.main.js @40623720).
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import * as fs from "fs";
import * as path from "path";

// Compiled to out/palette-dedupe.test.js, so the extension root is one level up.
const EXT_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(EXT_ROOT, "..", "..");
const PACKAGE_JSON = path.join(EXT_ROOT, "package.json");
const EXTENSION_TS = path.join(EXT_ROOT, "src", "extension.ts");

interface PaletteEntry {
  id: string;
  title: string;
  category: string;
  source: string;
}

const CATEGORY_LABELS: Record<string, string> = {
  ComposerActionCategory: "Composer",
  ComposerTabCategory: "Composer Tab",
  ComposerAiCodeTrackingCategory: "Composer AI Code Tracking",
  SessionsCategories_Sessions: "Sessions",
  Categories_View: "View",
};

function categoryLabel(raw: string): string {
  return CATEGORY_LABELS[raw] ?? raw;
}

/** Extract Action2 registrations from a core TS file. */
function parseCoreActions(relPath: string): PaletteEntry[] {
  const src = fs.readFileSync(path.join(REPO_ROOT, relPath), "utf8");
  const entries: PaletteEntry[] = [];
  // DEV-GAPS-82: resolve `static readonly ID = SOME_CONST` via same-file
  // const declarations — openChangesTabCommand.ts uses
  // `ID = OPEN_CHANGES_TAB_COMMAND_ID`, which the literal-only parser used
  // to skip entirely (the glass entry was never actually verified).
  const constIds = new Map<string, string>();
  for (const m of src.matchAll(/(?:export )?const (\w+) = '([^']+)'/g)) {
    constIds.set(m[1], m[2]);
  }
  // Split on every class declaration and keep only Action2 blocks — splitting
  // on Action2 alone merged openChangesTabCommand.ts's availability
  // contribution (which carries its own static ID) into the action's block
  // and the parser read the wrong ID (DEV-GAPS-82).
  const blocks = src
    .split(/(?=(?:export )?class \w+ extends )/)
    .filter((b) => /(?:export )?class \w+ extends Action2/.test(b));
  for (const b of blocks) {
    const idM = b.match(/static readonly ID = '([^']+)'/);
    const idConstM = idM ? null : b.match(/static readonly ID = (\w+)/);
    const id = idM ? idM[1] : (idConstM ? constIds.get(idConstM[1]) : undefined);
    if (!id) continue;
    const titleM = b.match(/title: localize2\([^,]+,\s*(?:"([^"]+)"|'([^']+)')/);
    const title = titleM ? (titleM[1] ?? titleM[2]) : id;
    const catM = b.match(/category: ([\w.]+)/);
    const category = categoryLabel((catM ? catM[1] : "").replace(/\./g, "_"));
    const hasF1True = /f1:\s*true/.test(b);
    const hasF1False = /f1:\s*false/.test(b);
    const hasPaletteMenu = /id:\s*MenuId\.CommandPalette/.test(b);
    const paletteHidden = hasF1False || /when:\s*["'](?:false|never)["']/.test(b);
    // Palette-visible iff (f1:true or an explicit CommandPalette menu entry) and not hidden.
    const visible = !paletteHidden && (hasF1True || hasPaletteMenu);
    if (visible) entries.push({ id, title, category, source: relPath });
  }
  return entries;
}

function paletteVisibleExtensionCommands(): PaletteEntry[] {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, "utf8"));
  const commands: Array<{ command: string; title: string; category?: string }> =
    pkg.contributes?.commands ?? [];
  const palette: Array<{ command: string; when?: string }> =
    pkg.contributes?.menus?.commandPalette ?? [];
  const hidden = new Set(
    palette
      .filter((m) => m.when === "false" || m.when === "never")
      .map((m) => m.command),
  );
  return commands
    .filter((c) => !hidden.has(c.command))
    .map((c) => ({
      id: c.command,
      title: c.title,
      category: c.category ?? "",
      source: "extensions/ide-agent/package.json",
    }));
}

function allPaletteEntries(): PaletteEntry[] {
  return [
    ...parseCoreActions("src/vs/workbench/contrib/composer/browser/composerActions.ts"),
    ...parseCoreActions("src/vs/workbench/contrib/composer/browser/composerChangesTab.ts"),
    ...parseCoreActions("src/vs/workbench/contrib/composer/electron-browser/glassWindowActions.ts"),
    ...parseCoreActions("src/vs/sessions/contrib/changes/browser/openChangesTabCommand.ts"),
    ...paletteVisibleExtensionCommands(),
  ];
}

describe("palette dedupe (QA-MIGRATION-C)", () => {
  it("no two palette-visible commands share (title, category)", () => {
    const entries = allPaletteEntries();
    const seen = new Map<string, PaletteEntry>();
    const collisions: string[] = [];
    for (const e of entries) {
      const key = `${e.title} \u0000 ${e.category}`;
      const prev = seen.get(key);
      if (prev) {
        collisions.push(
          `"${e.title}" [${e.category}]: ${prev.id} (${prev.source}) vs ${e.id} (${e.source})`,
        );
      } else {
        seen.set(key, e);
      }
    }
    assert.deepStrictEqual(collisions, [], `palette collisions:\n${collisions.join("\n")}`);
  });

  it("agents-window cluster has exactly one palette entry (composer.openAgentsWindow)", () => {
    const ids = new Set(allPaletteEntries().map((e) => e.id));
    const cluster = ["composer.openAgentsWindow", "ide.openAgentsWindow", "ide.openOrFocusGlassWindow"];
    const visible = cluster.filter((id) => ids.has(id));
    assert.deepStrictEqual(
      visible,
      ["composer.openAgentsWindow"],
      `expected only composer.openAgentsWindow visible, got: ${visible.join(", ")}`,
    );
  });

  it("changes-tab cluster: fork-canonical + binary-verbatim entries visible, extension alias hidden", () => {
    // DEV-GAPS-82: glass.openChangesTab is palette-visible in the Cursor
    // binary (f1:!0, glass @45508387), so both core rows are expected; only
    // the extension alias ide.openChangesTab stays hidden. The two visible
    // rows never collide on (title, category) — see the first test.
    const ids = new Set(allPaletteEntries().map((e) => e.id));
    const cluster = ["composer.openChangesTab", "ide.openChangesTab", "glass.openChangesTab"];
    const visible = cluster.filter((id) => ids.has(id));
    assert.deepStrictEqual(
      visible,
      ["composer.openChangesTab", "glass.openChangesTab"],
      `expected composer.openChangesTab + glass.openChangesTab visible, got: ${visible.join(", ")}`,
    );
  });

  it("hidden aliases are still registered (dedupe hides, never deletes)", () => {
    const extSrc = fs.readFileSync(EXTENSION_TS, "utf8");
    // ide.openAgentsWindow is registered by literal id; ide.openChangesTab via the
    // COMMANDS loop (`registerCommand(cmd.id, …)` inside `case "ide.openChangesTab":`).
    assert.ok(
      extSrc.includes('registerCommand("ide.openAgentsWindow"'),
      "ide.openAgentsWindow must stay registered in extension.ts (internal executeCommand callers depend on it)",
    );
    assert.ok(
      extSrc.includes('case "ide.openChangesTab":'),
      "ide.openChangesTab must stay registered in extension.ts (internal executeCommand callers depend on it)",
    );
    const glassSrc = fs.readFileSync(
      path.join(REPO_ROOT, "src/vs/sessions/contrib/changes/browser/openChangesTabCommand.ts"),
      "utf8",
    );
    assert.ok(
      glassSrc.includes("registerAction2(OpenChangesTabAction)"),
      "glass.openChangesTab must stay registered (keybinding + compat callers depend on it)",
    );
    const glassWindowSrc = fs.readFileSync(
      path.join(REPO_ROOT, "src/vs/workbench/contrib/composer/electron-browser/glassWindowActions.ts"),
      "utf8",
    );
    assert.ok(
      glassWindowSrc.includes("registerAction2(OpenOrFocusGlassWindowAction)"),
      "ide.openOrFocusGlassWindow must stay registered (delegation chain depends on it)",
    );
  });

  it("keybindings survive palette-hiding", () => {
    const composerSrc = fs.readFileSync(
      path.join(REPO_ROOT, "src/vs/workbench/contrib/composer/browser/composerActions.ts"),
      "utf8",
    );
    // composer.openAgentsWindow keeps its keybinding (CtrlCmd+Alt+O).
    const agentsBlock = composerSrc.slice(
      composerSrc.indexOf("class ComposerOpenAgentsWindowAction"),
    );
    assert.ok(/keybinding:\s*\{/.test(agentsBlock.slice(0, 2000)), "composer.openAgentsWindow lost its keybinding");
    // glass.openChangesTab keeps its CtrlCmd+E keybinding and is
    // palette-VISIBLE like the binary (f1:!0 -> f1:true, DEV-GAPS-82).
    const glassSrc = fs.readFileSync(
      path.join(REPO_ROOT, "src/vs/sessions/contrib/changes/browser/openChangesTabCommand.ts"),
      "utf8",
    );
    assert.ok(/primary:\s*KeyMod\.CtrlCmd\s*\|\s*KeyCode\.KeyE/.test(glassSrc), "glass.openChangesTab lost its CtrlCmd+E keybinding");
    assert.ok(/f1:\s*true/.test(glassSrc), "glass.openChangesTab should be palette-visible (binary f1:!0)");
  });
});
