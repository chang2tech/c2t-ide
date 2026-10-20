/**
 * Loop skill tests (node:test, zero extra deps).
 *
 * Covers the built-in /loop skill (WORKER-GAPS-11G):
 * - loopSkill.ts: LOOP_PROTECTED_SKILL_NAMES verbatim port, the
 *   protectLoopSkillDescription flag seam, binary-exact keywords, and the
 *   applyLoopSkillProtection catalog guard.
 * - SlashCommandService: /loop + /autopilot + /babysit builtins carry the
 *   binary-exact keywords; /loop invocation returns the <skill> prompt
 *   macro; /babysit resolves to the honest cloud-unavailable branch.
 *
 * Run after `tsc`:  node out/services/test/run-loop-skill-tests.js
 */
// The vscode stub MUST be installed before slashCommandService (it imports
// "vscode" at runtime). The stub is NOT extended here — construction of the
// full service is avoided via Object.create (see below).
import "./vscode-stub";
import { describe, it } from "node:test";
import * as assert from "node:assert";
import {
  LOOP_PROTECTED_SKILL_NAMES,
  LOOP_SKILL_CONTENT,
  LOOP_SKILL_DESCRIPTION,
  LOOP_SKILL_KEYWORDS,
  LOOP_SKILL_NAME,
  applyLoopSkillProtection,
  isLoopSkillProtected,
  setProtectLoopSkillDescription,
} from "../loopSkill";
import { SlashCommandService } from "../slashCommandService";

/* ---------- loopSkill.ts: verbatim mechanism port ---------- */

describe("LOOP_PROTECTED_SKILL_NAMES (Cursor daemon verbatim)", () => {
  it("protects exactly the loop skill", () => {
    assert.ok(LOOP_PROTECTED_SKILL_NAMES.has("loop"));
    assert.strictEqual(LOOP_PROTECTED_SKILL_NAMES.size, 1);
  });
  it("isLoopSkillProtected follows the flag", () => {
    setProtectLoopSkillDescription(true);
    try {
      assert.ok(isLoopSkillProtected("loop"));
      assert.ok(!isLoopSkillProtected("other-skill"));
    } finally {
      setProtectLoopSkillDescription(true);
    }
    setProtectLoopSkillDescription(false);
    try {
      assert.ok(!isLoopSkillProtected("loop"));
    } finally {
      setProtectLoopSkillDescription(true);
    }
  });
});

describe("loop skill metadata", () => {
  it("keywords are binary-exact (3.25.9 slashMenuData.js)", () => {
    assert.deepStrictEqual([...LOOP_SKILL_KEYWORDS], ["Repeat", "Recurring", "Interval", "Periodic"]);
  });
  it("name and description", () => {
    assert.strictEqual(LOOP_SKILL_NAME, "loop");
    assert.strictEqual(LOOP_SKILL_DESCRIPTION, "Recurring skill execution");
  });
  it("content covers the daemon's loop domain", () => {
    assert.ok(LOOP_SKILL_CONTENT.includes("name: loop"));
    assert.ok(LOOP_SKILL_CONTENT.includes("every N minutes/hours/days"));
    assert.ok(LOOP_SKILL_CONTENT.includes("standing watch"));
    assert.ok(LOOP_SKILL_CONTENT.includes("recurring job"));
  });
});

describe("applyLoopSkillProtection (applySkillCatalogBudget analog)", () => {
  it("restores a shortened loop description from the full map", () => {
    const full = "full loop description";
    const out = applyLoopSkillProtection(
      [
        { name: "loop", description: "tru…" },
        { name: "other", description: "tru…" },
      ],
      new Map([["loop", full]]),
    );
    assert.strictEqual(out[0].description, full);
    assert.strictEqual(out[1].description, "tru…");
  });
  it("leaves full descriptions untouched and others alone", () => {
    const skills = [
      { name: "loop", description: "full" },
      { name: "other", description: "full" },
    ];
    const out = applyLoopSkillProtection(skills, new Map([["loop", "full"]]));
    assert.strictEqual(out[0].description, "full");
    assert.strictEqual(out[1].description, "full");
  });
  it("is a no-op for the loop skill when the flag is off", () => {
    setProtectLoopSkillDescription(false);
    try {
      const out = applyLoopSkillProtection([{ name: "loop", description: "tru…" }], new Map([["loop", "full"]]));
      assert.strictEqual(out[0].description, "tru…");
    } finally {
      setProtectLoopSkillDescription(true);
    }
  });
});

/* ---------- SlashCommandService integration (no full construction) ---------- */

/** Minimal service instance: getBuiltins()/run("loop") only read these fields. */
function bareService(): SlashCommandService {
  const svc = Object.create(SlashCommandService.prototype) as SlashCommandService;
  (svc as unknown as { customCommands: unknown[] }).customCommands = [];
  (svc as unknown as { skills: unknown[] }).skills = [];
  return svc;
}

describe("slash builtins: /loop, /autopilot, /babysit", () => {
  it("/loop is registered with binary-exact keywords", () => {
    const loop = bareService().getBuiltins().find((b) => b.name === "loop");
    assert.ok(loop, "/loop must be a builtin");
    assert.deepStrictEqual(loop!.keywords, ["Repeat", "Recurring", "Interval", "Periodic"]);
    assert.strictEqual(loop!.description, "Recurring skill execution");
    assert.strictEqual(loop!.source, "builtin");
  });
  it("/autopilot carries the binary-exact PR/CI/Comments/Merge keywords", () => {
    const ap = bareService().getBuiltins().find((b) => b.name === "autopilot");
    assert.ok(ap, "/autopilot must be a builtin");
    assert.deepStrictEqual(ap!.keywords, ["PR", "CI", "Comments", "Merge"]);
  });
  it("/babysit is a separate builtin entry (Cursor lists it alongside autopilot)", () => {
    const bb = bareService().getBuiltins().find((b) => b.name === "babysit");
    assert.ok(bb, "/babysit must be a builtin");
    assert.deepStrictEqual(bb!.keywords, ["PR", "CI", "Comments", "Merge"]);
  });
  it("/loop invocation returns the <skill> prompt macro (§2.4 treatment)", async () => {
    const res = await bareService().run("loop", "every morning check CI");
    assert.ok(res.macro, "must return a macro");
    assert.ok(res.macro!.startsWith('<skill name="loop">\n'));
    assert.ok(res.macro!.includes("every N minutes/hours/days"));
    assert.ok(res.macro!.includes("Arguments: every morning check CI"));
    assert.ok(res.macro!.endsWith("</skill>"));
  });
  it("/loop with no args returns the macro without an Arguments suffix", async () => {
    const res = await bareService().run("loop", "");
    assert.ok(res.macro!.startsWith('<skill name="loop">\n'));
    assert.ok(!res.macro!.includes("Arguments:"));
  });
  it("/babysit resolves to the honest cloud-unavailable branch (no throw)", async () => {
    const res = await bareService().run("babysit", "");
    assert.deepStrictEqual(res, {});
  });
  it("findCommand resolves /loop and /babysit", () => {
    const svc = bareService();
    assert.ok(svc.findCommand("loop"));
    assert.ok(svc.findCommand("babysit"));
    assert.ok(svc.findCommand("autopilot"));
  });
});
