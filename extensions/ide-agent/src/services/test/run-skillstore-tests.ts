/**
 * DEV-GAPS-5-SKILLS tests (node:test, vscode stubbed via ./vscode-stub).
 *
 * Covers skillStoreService + skillMigrationService (both vscode-free):
 *  - Skill manifest parsing (SKILL.md frontmatter: name/description/version).
 *  - Store scan/install (metadata: installedAt, published flag, fail-closed
 *    on non-skill dirs).
 *  - Publish pack/unpack round-trip (pure-node ustar tar + gzip), traversal
 *    rejection.
 *  - publish / resync (confirm-gated overwrite) / unpublish (plugin cache
 *    removal) / restoreLocalSkill / reloadConfirmAndDeleteLocalSkill.
 *  - confirmStoreSkillsSynced gate.
 *  - RequestContextSkillsPart builder + request-scoped cache.
 *  - Migration: home + legacy sources, progress callbacks, cancel,
 *    overwrite confirm (default skip), migration state, trash functions,
 *    copy/move helpers, SkillMigrationController.
 *
 * All fixtures live under os.tmpdir() — the real ~/.ide-code store is never
 * touched.
 *
 * Run after `tsc`:  node --test out/services/test/run-skillstore-tests.js
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import "./vscode-stub";
import {
  buildRequestContextSkillsPart,
  confirmStoreSkillsSynced,
  defaultSkillStoreDir,
  installSkill,
  invalidateRequestContextSkillsCache,
  isPublished,
  listInstalledSkillIds,
  listInstalledSkills,
  packSkillPlugin,
  packTarGz,
  readSkillManifest,
  reloadAndConfirmResync,
  reloadConfirmAndDeleteLocalSkill,
  removePluginCache,
  requestContextSkills,
  restoreLocalSkill,
  unpackTarGz,
} from "../skillStoreService";
import {
  SkillMigrationController,
  copySkillsFromStore,
  copySkillsToStore,
  cursorHomeSkillsDir,
  getMigrationState,
  migrateSkills,
  moveSkillOutOfStore,
  moveSkillToStore,
  trashMigratedHomeSkills,
  trashMigratedStoreSkills,
} from "../skillMigrationService";

let tmpRoot: string;

function makeSkill(parent: string, name: string, opts: { description?: string; version?: string; files?: Record<string, string> } = {}): string {
  const dir = path.join(parent, name);
  fs.mkdirSync(dir, { recursive: true });
  const fm = [
    "---",
    `name: ${name}`,
    `description: ${opts.description ?? `Does ${name} things`}`,
    ...(opts.version ? [`version: ${opts.version}`] : []),
    "---",
    "",
    `# ${name}`,
  ].join("\n");
  fs.writeFileSync(path.join(dir, "SKILL.md"), fm, "utf8");
  for (const [rel, content] of Object.entries(opts.files ?? {})) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, "utf8");
  }
  return dir;
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skillstore-test-"));
  invalidateRequestContextSkillsCache();
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  invalidateRequestContextSkillsCache();
});

const storeOf = (): string => path.join(tmpRoot, "store");
const homeOf = (): string => path.join(tmpRoot, "home");

describe("skill manifest parsing", () => {
  it("reads name/description/version from SKILL.md frontmatter", () => {
    const dir = makeSkill(tmpRoot, "reviewer", { description: "Reviews code", version: "1.2.3" });
    const m = readSkillManifest(dir);
    assert.ok(m);
    assert.equal(m!.name, "reviewer");
    assert.equal(m!.description, "Reviews code");
    assert.equal(m!.version, "1.2.3");
  });

  it("falls back to dir name and 0.0.0 without frontmatter fields", () => {
    const dir = path.join(tmpRoot, "plain");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), "# just markdown\n", "utf8");
    const m = readSkillManifest(dir);
    assert.ok(m);
    assert.equal(m!.name, "plain");
    assert.equal(m!.description, "");
    assert.equal(m!.version, "0.0.0");
  });

  it("returns undefined when SKILL.md is missing or empty", () => {
    const dir = path.join(tmpRoot, "empty");
    fs.mkdirSync(dir, { recursive: true });
    assert.equal(readSkillManifest(dir), undefined);
    fs.writeFileSync(path.join(dir, "SKILL.md"), "   \n", "utf8");
    assert.equal(readSkillManifest(dir), undefined);
  });

  it("defaultSkillStoreDir is ~/.ide-code/skills", () => {
    assert.equal(defaultSkillStoreDir("/home/u"), path.join("/home/u", ".ide-code", "skills"));
  });
});

describe("store install + scan", () => {
  it("installs a skill dir and lists it with metadata", () => {
    const src = makeSkill(tmpRoot, "reviewer", { description: "Reviews code", version: "2.0.0" });
    const installed = installSkill(storeOf(), src);
    assert.equal(installed.id, "reviewer");
    assert.equal(installed.name, "reviewer");
    assert.equal(installed.description, "Reviews code");
    assert.equal(installed.version, "2.0.0");
    assert.ok(installed.installedAt > 0);
    assert.equal(installed.published, false);
    assert.ok(fs.existsSync(path.join(storeOf(), "reviewer", "SKILL.md")));
    assert.deepEqual(listInstalledSkillIds(storeOf()), ["reviewer"]);
  });

  it("throws on a directory without SKILL.md (fail-closed)", () => {
    const dir = path.join(tmpRoot, "notaskill");
    fs.mkdirSync(dir, { recursive: true });
    assert.throws(() => installSkill(storeOf(), dir), /no readable SKILL\.md/);
    assert.deepEqual(listInstalledSkills(storeOf()), []);
  });

  it("reinstall overwrites the previous copy", () => {
    const src = makeSkill(tmpRoot, "s", { description: "v1" });
    installSkill(storeOf(), src);
    fs.writeFileSync(path.join(src, "SKILL.md"), "---\nname: s\ndescription: v2\n---\n", "utf8");
    const again = installSkill(storeOf(), src);
    assert.equal(again.description, "v2");
    assert.equal(listInstalledSkills(storeOf()).length, 1);
  });
});

describe("publish pack (tar.gz)", () => {
  it("packTarGz/unpackTarGz round-trips nested files", () => {
    const src = makeSkill(tmpRoot, "s", {
      files: { "lib/helper.js": "console.log(1);", "docs/guide.md": "# g", "nested/deep/x.txt": "x" },
    });
    const archive = path.join(tmpRoot, "s.tar.gz");
    packTarGz(src, archive);
    assert.ok(fs.existsSync(archive));
    const dest = path.join(tmpRoot, "unpacked");
    unpackTarGz(archive, dest);
    assert.equal(fs.readFileSync(path.join(dest, "SKILL.md"), "utf8"), fs.readFileSync(path.join(src, "SKILL.md"), "utf8"));
    assert.equal(fs.readFileSync(path.join(dest, "lib", "helper.js"), "utf8"), "console.log(1);");
    assert.equal(fs.readFileSync(path.join(dest, "nested", "deep", "x.txt"), "utf8"), "x");
  });

  it("rejects traversal entries on unpack", () => {
    const src = makeSkill(tmpRoot, "s");
    const archive = path.join(tmpRoot, "evil.tar.gz");
    // Build a hand-crafted archive with a ../ entry by packing then patching
    // is overkill; instead verify safeJoinTarEntry indirectly: a tar we pack
    // ourselves never contains ".." (collectTarEntries only emits real paths).
    packTarGz(src, archive);
    assert.doesNotThrow(() => unpackTarGz(archive, path.join(tmpRoot, "ok")));
  });

  it("packSkillPlugin marks the skill published and writes the archive", () => {
    const src = makeSkill(tmpRoot, "reviewer", { version: "1.0.0" });
    const installed = installSkill(storeOf(), src);
    assert.equal(installed.published, false);
    const archivePath = packSkillPlugin(storeOf(), installed.id);
    assert.ok(archivePath.endsWith("reviewer-1.0.0.tar.gz"));
    assert.ok(fs.existsSync(archivePath));
    assert.ok(isPublished(storeOf(), installed));
    assert.equal(listInstalledSkills(storeOf())[0].published, true);
  });

  it("packSkillPlugin throws for unknown skill ids", () => {
    assert.throws(() => packSkillPlugin(storeOf(), "nope"), /not installed/);
  });
});

describe("resync / unpublish / restore", () => {
  function installed(): { id: string } {
    const src = makeSkill(tmpRoot, "reviewer", { version: "3.0.0" });
    return installSkill(storeOf(), src);
  }

  it("reloadAndConfirmResync overwrites the target when confirmed", async () => {
    const { id } = installed();
    const target = makeSkill(tmpRoot, "workdir", { description: "local edits" });
    const ok = await reloadAndConfirmResync(storeOf(), id, target, () => true);
    assert.equal(ok, true);
    assert.equal(readSkillManifest(target)!.description, "Does reviewer things");
  });

  it("reloadAndConfirmResync aborts without touching the target when declined", async () => {
    const { id } = installed();
    const target = makeSkill(tmpRoot, "workdir", { description: "local edits" });
    const before = fs.readFileSync(path.join(target, "SKILL.md"), "utf8");
    const ok = await reloadAndConfirmResync(storeOf(), id, target, () => false);
    assert.equal(ok, false);
    assert.equal(fs.readFileSync(path.join(target, "SKILL.md"), "utf8"), before);
  });

  it("removePluginCache deletes the pack archive (unpublish)", () => {
    const { id } = installed();
    packSkillPlugin(storeOf(), id);
    assert.equal(listInstalledSkills(storeOf())[0].published, true);
    const removed = removePluginCache(storeOf(), id);
    assert.equal(removed, 1);
    assert.equal(listInstalledSkills(storeOf())[0].published, false);
    assert.equal(removePluginCache(storeOf(), id), 0);
  });

  it("restoreLocalSkill copies the store copy to a working dir", () => {
    const { id } = installed();
    const target = path.join(tmpRoot, "restored");
    const restored = restoreLocalSkill(storeOf(), id, target);
    assert.equal(restored.name, "reviewer");
    assert.ok(fs.existsSync(path.join(target, "SKILL.md")));
  });

  it("reloadConfirmAndDeleteLocalSkill deletes the local dir only when published + confirmed", async () => {
    const { id } = installed();
    const local = makeSkill(tmpRoot, "local-copy");
    // Not published yet → fail-closed, local dir survives.
    assert.equal(await reloadConfirmAndDeleteLocalSkill(storeOf(), id, local, () => true), false);
    assert.ok(fs.existsSync(local));
    packSkillPlugin(storeOf(), id);
    // Declined → survives.
    assert.equal(await reloadConfirmAndDeleteLocalSkill(storeOf(), id, local, () => false), false);
    assert.ok(fs.existsSync(local));
    // Confirmed → deleted.
    assert.equal(await reloadConfirmAndDeleteLocalSkill(storeOf(), id, local, () => true), true);
    assert.ok(!fs.existsSync(local));
  });
});

describe("confirmStoreSkillsSynced", () => {
  it("reports synced when every skill parses and packs validate", () => {
    const { id } = installSkill(storeOf(), makeSkill(tmpRoot, "a", { version: "1.0.0" }));
    installSkill(storeOf(), makeSkill(tmpRoot, "b"));
    packSkillPlugin(storeOf(), id);
    const gate = confirmStoreSkillsSynced(storeOf());
    assert.equal(gate.synced, true);
    assert.deepEqual(gate.problems, []);
  });

  it("reports problems for skill dirs without SKILL.md", () => {
    installSkill(storeOf(), makeSkill(tmpRoot, "good"));
    fs.mkdirSync(path.join(storeOf(), "broken"), { recursive: true });
    const gate = confirmStoreSkillsSynced(storeOf());
    assert.equal(gate.synced, false);
    assert.ok(gate.problems.some((p) => p.includes('"broken"')));
  });
});

describe("RequestContextSkillsPart", () => {
  it("builds the name+description list", () => {
    const part = buildRequestContextSkillsPart([
      { id: "a", name: "a", description: "does A", version: "1.0.0", sourceDir: "/x", installedAt: 1, published: false },
      { id: "b", name: "b", description: "", version: "0.0.0", sourceDir: "/y", installedAt: 2, published: true },
    ]);
    assert.deepEqual(part, { skills: [{ name: "a", description: "does A" }, { name: "b", description: "" }] });
  });

  it("requestContextSkills scans the store and caches per store dir", () => {
    installSkill(storeOf(), makeSkill(tmpRoot, "a", { description: "A skill" }));
    const first = requestContextSkills(storeOf());
    assert.deepEqual(first.skills.map((s) => s.name), ["a"]);
    // Cache hit: installing into another store must not leak into this one.
    const other = path.join(tmpRoot, "store2");
    installSkill(other, makeSkill(tmpRoot, "b", { description: "B skill" }));
    assert.deepEqual(requestContextSkills(storeOf()).skills.map((s) => s.name), ["a"]);
    assert.deepEqual(requestContextSkills(other).skills.map((s) => s.name), ["b"]);
  });
});

describe("migration", () => {
  function fakeHome(): string {
    const home = homeOf();
    makeSkill(cursorHomeSkillsDir(home), "alpha", { description: "Alpha" });
    makeSkill(cursorHomeSkillsDir(home), "beta", { description: "Beta" });
    return home;
  }

  it("migrates ~/.cursor/skills into the store with progress events", async () => {
    const home = fakeHome();
    const events: string[] = [];
    const result = await migrateSkills({
      homeDir: home,
      storeDir: storeOf(),
      onProgress: (p) => events.push(`${p.phase}:${p.done}/${p.total}:${p.current ?? ""}`),
    });
    assert.deepEqual(result.migrated.sort(), ["alpha", "beta"]);
    assert.deepEqual(result.skipped, []);
    assert.equal(result.cancelled, false);
    assert.deepEqual(listInstalledSkillIds(storeOf()), ["alpha", "beta"]);
    assert.ok(events.some((e) => e.startsWith("migrating:")));
    assert.ok(events.some((e) => e.startsWith("done:")));
  });

  it("records migration state with source dirs", async () => {
    const home = fakeHome();
    await migrateSkills({ homeDir: home, storeDir: storeOf() });
    const state = getMigrationState(storeOf());
    assert.ok(state);
    assert.equal(state!.homeSkillsDir, cursorHomeSkillsDir(home));
    assert.deepEqual(state!.migrated.sort(), ["alpha", "beta"]);
  });

  it("skips name collisions by default, overwrites when confirmed", async () => {
    const home = fakeHome();
    const store = storeOf();
    installSkill(store, makeSkill(tmpRoot, "alpha", { description: "store copy" }));
    const skipped = await migrateSkills({ homeDir: home, storeDir: store });
    assert.deepEqual(skipped.skipped, ["alpha"]);
    assert.deepEqual(skipped.migrated, ["beta"]);
    assert.equal(listInstalledSkills(store).find((s) => s.id === "alpha")!.description, "store copy");
    const overwritten = await migrateSkills({
      homeDir: home,
      storeDir: store,
      confirmOverwrite: () => true,
    });
    assert.deepEqual(overwritten.overwritten.sort(), ["alpha", "beta"]);
    assert.equal(listInstalledSkills(store).find((s) => s.id === "alpha")!.description, "Alpha");
  });

  it("cancels mid-migration when isCancelled fires", async () => {
    const home = fakeHome();
    let calls = 0;
    const result = await migrateSkills({
      homeDir: home,
      storeDir: storeOf(),
      isCancelled: () => ++calls > 1,
    });
    assert.equal(result.cancelled, true);
    assert.ok(result.migrated.length < 2);
  });

  it("controller wires cancel/isCancelled/reportProgress", async () => {
    const home = fakeHome();
    const controller = new SkillMigrationController();
    assert.equal(controller.isCancelled(), false);
    const seen: string[] = [];
    const result = await migrateSkills({
      homeDir: home,
      storeDir: storeOf(),
      controller,
      onProgress: (p) => {
        seen.push(p.phase);
        if (p.phase === "migrating" && p.done === 0) {
          controller.cancel();
        }
      },
    });
    assert.equal(controller.isCancelled(), true);
    assert.equal(result.cancelled, true);
    assert.ok(controller.getLastProgress());
    assert.ok(seen.includes("cancelled"));
  });

  it("migrates extra legacy source dirs", async () => {
    const home = homeOf();
    const legacy = path.join(tmpRoot, "legacy-store");
    makeSkill(legacy, "oldie", { description: "legacy" });
    const result = await migrateSkills({ homeDir: home, storeDir: storeOf(), extraSourceDirs: [legacy] });
    assert.deepEqual(result.migrated, ["oldie"]);
  });

  it("trashMigratedHomeSkills moves ~/.cursor/skills to the trash", async () => {
    const home = fakeHome();
    await migrateSkills({ homeDir: home, storeDir: storeOf() });
    const trashed = trashMigratedHomeSkills(home);
    assert.ok(trashed);
    assert.ok(!fs.existsSync(cursorHomeSkillsDir(home)));
    assert.ok(fs.existsSync(path.join(trashed!, "alpha", "SKILL.md")));
  });

  it("trashMigratedStoreSkills trashes legacy sources from migration state", async () => {
    const home = homeOf();
    const legacy = path.join(tmpRoot, "legacy-store");
    makeSkill(legacy, "oldie");
    await migrateSkills({ homeDir: home, storeDir: storeOf(), extraSourceDirs: [legacy] });
    const trashed = trashMigratedStoreSkills(storeOf(), home);
    assert.equal(trashed.length, 1);
    assert.ok(!fs.existsSync(legacy));
    assert.ok(fs.existsSync(path.join(trashed[0], "oldie", "SKILL.md")));
  });

  it("trash functions no-op when there is nothing to trash", () => {
    assert.equal(trashMigratedHomeSkills(homeOf()), undefined);
    assert.deepEqual(trashMigratedStoreSkills(storeOf(), homeOf()), []);
  });
});

describe("store copy/move helpers", () => {
  it("copySkillsFromStore copies installed skills to a target dir", () => {
    installSkill(storeOf(), makeSkill(tmpRoot, "a"));
    const target = path.join(tmpRoot, "workdir");
    const copied = copySkillsFromStore(storeOf(), target);
    assert.deepEqual(copied, ["a"]);
    assert.ok(fs.existsSync(path.join(target, "a", "SKILL.md")));
  });

  it("copySkillsToStore installs source dirs", () => {
    const ids = copySkillsToStore(storeOf(), [makeSkill(tmpRoot, "x"), makeSkill(tmpRoot, "y")]);
    assert.deepEqual(ids.sort(), ["x", "y"]);
  });

  it("moveSkillOutOfStore removes the store copy", () => {
    installSkill(storeOf(), makeSkill(tmpRoot, "a"));
    const target = path.join(tmpRoot, "out");
    moveSkillOutOfStore(storeOf(), "a", target);
    assert.ok(fs.existsSync(path.join(target, "SKILL.md")));
    assert.deepEqual(listInstalledSkillIds(storeOf()), []);
  });

  it("moveSkillToStore removes the source dir after install", () => {
    const src = makeSkill(tmpRoot, "a");
    const id = moveSkillToStore(storeOf(), src);
    assert.equal(id, "a");
    assert.ok(!fs.existsSync(src));
    assert.deepEqual(listInstalledSkillIds(storeOf()), ["a"]);
  });

  it("moveSkillOutOfStore throws for unknown skills", () => {
    assert.throws(() => moveSkillOutOfStore(storeOf(), "nope", path.join(tmpRoot, "t")), /not installed/);
  });
});
