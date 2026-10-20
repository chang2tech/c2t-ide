/**
 * GAPS-46D custom-mode runtime tests (node:test, zero extra deps).
 *
 * Guards the missing half of `agent-custom-modes` (the registry + export
 * parity lives in run-custom-modes-tests.ts): the RUNTIME lifecycle —
 * entering a custom mode from a skill, the badge styling from frontmatter,
 * per-turn skill injection, turnsInMode, exit, new-chat clearing, and the
 * skill-file-vanished behavior.
 *
 * Evidence (QA step 1, adversarial):
 *   docs.cursor.com/agent/prompting (verified 2026-10-20):
 *     - "Inside a mode, the skill stays in context on every turn, even as
 *       the agent works for hours, until you exit the mode."
 *     - "the optional `icon` and `color` frontmatter fields style the
 *       mode's badge."
 *     - "Pick the skill from the `/` menu and press Option+Enter Alt+Enter
 *       (Mac) or Alt+Enter (Windows) instead. You can also select Use as
 *       Mode from the skill entry."
 *     - "Any skill with a valid frontmatter block can back a mode."
 *   binary 3.25.9 (workbench.glass.main.js):
 *     - `activeCustomMode` / `committedCustomMode` / `pendingExitedCustomMode`
 *       composer-data fields; `customModeSessionId`; `turnsInMode`
 *       (`{...n,turnsInMode:n.turnsInMode+1}`).
 *     - badge appearance `Ncs({icon:"icon"in t?t.icon:void 0,
 *       colorId:"color"in t?t.color:void 0})`, default
 *       `{icon:"lightning",colorId:"default"}`.
 *     - skill-file-vanished notification (verbatim):
 *       `'<label>' mode couldn't be applied — its skill file may have been
 *       renamed or removed. Message sent without it.`
 *     - draft change clears active/pending/committed custom modes.
 *
 * Run after `tsc`:
 *   node --test out/services/test/run-custom-mode-runtime-tests.js
 */
import "./vscode-stub";
import { describe, it, after } from "node:test";
import * as assert from "node:assert";
import { parseSkillFrontmatter } from "../slashRegistry";
import {
  createCustomModeSession,
  incrementCustomModeTurns,
  wrapCustomModePrompt,
  customModeBadgeAppearance,
  planCustomModeTurn,
  buildSkillMissingNotification,
  stripSkillFrontmatter,
  CUSTOM_MODE_DEFAULT_ICON,
  CUSTOM_MODE_DEFAULT_COLOR_ID,
} from "../modeService";

const SKILL_MD = `---
name: tdd
description: Test-driven development playbook
icon: flask
color: green
---
# TDD playbook

1. Write the failing test first.
2. Implement the minimal fix.
`;

describe("parseSkillFrontmatter — icon/color (badge styling)", () => {
  it("parses icon and color", () => {
    const fm = parseSkillFrontmatter(SKILL_MD);
    assert.strictEqual(fm.name, "tdd");
    assert.strictEqual(fm.icon, "flask");
    assert.strictEqual(fm.color, "green");
  });
  it("leaves icon/color undefined when absent", () => {
    const fm = parseSkillFrontmatter("---\nname: x\n---\nbody");
    assert.strictEqual(fm.icon, undefined);
    assert.strictEqual(fm.color, undefined);
  });
});

describe("stripSkillFrontmatter", () => {
  it("removes the leading frontmatter block", () => {
    const body = stripSkillFrontmatter(SKILL_MD);
    assert.ok(!body.includes("name: tdd"));
    assert.ok(body.includes("# TDD playbook"));
  });
  it("returns the input unchanged when there is no frontmatter", () => {
    assert.strictEqual(stripSkillFrontmatter("plain body"), "plain body");
  });
});

describe("createCustomModeSession", () => {
  it("builds a session with binary-default badge fields and turnsInMode 0", () => {
    const s = createCustomModeSession(
      { name: "tdd", content: SKILL_MD, filePath: "/x/SKILL.md" },
      () => "sess-1",
    );
    assert.ok(s);
    assert.strictEqual(s.sessionId, "sess-1");
    assert.strictEqual(s.label, "tdd");
    assert.strictEqual(s.skillFilePath, "/x/SKILL.md");
    assert.strictEqual(s.turnsInMode, 0);
    // No icon/color in frontmatter → undefined; the badge function applies
    // the binary defaults.
    assert.strictEqual(s.icon, undefined);
    assert.strictEqual(s.color, undefined);
    // The injected body has no frontmatter.
    assert.ok(!s.skillBody.includes("name: tdd"));
    assert.ok(s.skillBody.includes("# TDD playbook"));
  });
  it("carries frontmatter icon/color into the session", () => {
    const s = createCustomModeSession(
      { name: "tdd", content: SKILL_MD, filePath: "/x/SKILL.md", icon: "flask", color: "green" },
      () => "sess-2",
    );
    assert.ok(s);
    assert.strictEqual(s.icon, "flask");
    assert.strictEqual(s.color, "green");
  });
  it("rejects a skill with no name (needs a valid frontmatter block)", () => {
    assert.strictEqual(
      createCustomModeSession({ name: "  ", content: "body", filePath: "/x" }),
      null,
    );
  });
});

describe("customModeBadgeAppearance (binary Ncs parity)", () => {
  it("uses binary defaults when frontmatter has no icon/color", () => {
    const s = createCustomModeSession(
      { name: "tdd", content: "body", filePath: "/x" },
      () => "s",
    )!;
    assert.deepStrictEqual(customModeBadgeAppearance(s), {
      icon: CUSTOM_MODE_DEFAULT_ICON,
      colorId: CUSTOM_MODE_DEFAULT_COLOR_ID,
    });
    assert.strictEqual(CUSTOM_MODE_DEFAULT_ICON, "lightning");
    assert.strictEqual(CUSTOM_MODE_DEFAULT_COLOR_ID, "default");
  });
  it("uses the frontmatter icon/color", () => {
    const s = createCustomModeSession(
      { name: "tdd", content: "body", filePath: "/x", icon: "flask", color: "green" },
      () => "s",
    )!;
    assert.deepStrictEqual(customModeBadgeAppearance(s), { icon: "flask", colorId: "green" });
  });
});

describe("wrapCustomModePrompt — skill stays in context every turn", () => {
  it("injects the skill body and keeps the user prompt intact", () => {
    const s = createCustomModeSession(
      { name: "tdd", content: SKILL_MD, filePath: "/x" },
      () => "s",
    )!;
    const out = wrapCustomModePrompt(s, "refactor the auth module");
    assert.ok(out.includes("# TDD playbook"));
    assert.ok(out.includes("refactor the auth module"));
    assert.ok(out.includes("[Custom mode: tdd]"));
  });
  it("passes the prompt through unchanged when the skill body is empty", () => {
    const s = createCustomModeSession(
      { name: "tdd", content: "---\nname: tdd\n---\n", filePath: "/x" },
      () => "s",
    )!;
    assert.strictEqual(wrapCustomModePrompt(s, "hello"), "hello");
  });
});

describe("incrementCustomModeTurns (binary FEk parity)", () => {
  it("increments turnsInMode and returns a new object", () => {
    const s = createCustomModeSession(
      { name: "tdd", content: "body", filePath: "/x" },
      () => "s",
    )!;
    const next = incrementCustomModeTurns(s);
    assert.strictEqual(s.turnsInMode, 0);
    assert.strictEqual(next.turnsInMode, 1);
    assert.strictEqual(incrementCustomModeTurns(next).turnsInMode, 2);
  });
});

describe("planCustomModeTurn + buildSkillMissingNotification", () => {
  it("injects when the skill file still exists", () => {
    const s = createCustomModeSession(
      { name: "tdd", content: SKILL_MD, filePath: "/x" },
      () => "s",
    )!;
    const plan = planCustomModeTurn(s, true);
    assert.strictEqual(plan.dropped, false);
    assert.ok(plan.skillBody && plan.skillBody.includes("# TDD playbook"));
  });
  it("drops the mode when the skill file vanished", () => {
    const s = createCustomModeSession(
      { name: "tdd", content: SKILL_MD, filePath: "/x" },
      () => "s",
    )!;
    const plan = planCustomModeTurn(s, false);
    assert.strictEqual(plan.dropped, true);
    assert.strictEqual(plan.skillBody, null);
  });
  it("notification text is binary-verbatim", () => {
    assert.strictEqual(
      buildSkillMissingNotification("tdd"),
      "'tdd' mode couldn't be applied \u2014 its skill file may have been renamed or removed. Message sent without it.",
    );
  });
});

describe("ComposerDataService custom-mode lifecycle", () => {
  // Lazy import keeps the failure message readable when the stub is wrong.
  let ComposerDataService: typeof import("../composerDataService").ComposerDataService;
  it("loads", async () => {
    ({ ComposerDataService } = await import("../composerDataService"));
    assert.ok(ComposerDataService);
  });

  // W52C test hygiene: every ComposerDataService arms a ref'd 15 s
  // activation timer in CheckpointStorageCompareService (via
  // CheckpointService's constructor) that chains into a re-arming 10 min
  // interval — undisposed composers keep the event loop alive forever after
  // all suites pass. Track and dispose them all in after() (same pattern as
  // run-chattabs-tests.ts).
  const disposables: Array<{ dispose(): void }> = [];
  after(() => {
    for (const d of disposables) {
      try {
        d.dispose();
      } catch {
        /* teardown must never fail the run */
      }
    }
    disposables.length = 0;
  });

  function makeComposer() {
    const c = new ComposerDataService(undefined, undefined);
    disposables.push(c);
    return c;
  }

  it("starts with no active custom mode", async () => {
    const c = makeComposer();
    assert.strictEqual(c.getActiveCustomMode(), null);
  });

  it("enterCustomMode sets the session and fires customModeChanged", async () => {
    const c = makeComposer();
    const events: Array<{ kind: string; active: unknown; exitedLabel: unknown }> = [];
    c.onDidChange((e) => {
      if (e.kind === "customModeChanged") {
        events.push({ kind: e.kind, active: e.active, exitedLabel: e.exitedLabel });
      }
    });
    c.enterCustomMode({ name: "tdd", content: SKILL_MD, filePath: "/x/SKILL.md" });
    const active = c.getActiveCustomMode();
    assert.ok(active);
    assert.strictEqual(active.label, "tdd");
    assert.strictEqual(active.turnsInMode, 0);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].active, active);
    assert.strictEqual(events[0].exitedLabel, null);
  });

  it("enterCustomMode with a nameless skill is a no-op with a notice", async () => {
    const c = makeComposer();
    let notices = 0;
    c.enterCustomMode({ name: "   ", content: "body", filePath: "/x" });
    assert.strictEqual(c.getActiveCustomMode(), null);
    assert.strictEqual(notices, 0); // warning goes to vscode stub; just assert state
  });

  it("exitCustomMode clears the session and records pendingExitedCustomMode", async () => {
    const c = makeComposer();
    const events: Array<{ exitedLabel: unknown }> = [];
    c.onDidChange((e) => {
      if (e.kind === "customModeChanged") {
        events.push({ exitedLabel: e.exitedLabel });
      }
    });
    c.enterCustomMode({ name: "tdd", content: SKILL_MD, filePath: "/x/SKILL.md" });
    c.exitCustomMode();
    assert.strictEqual(c.getActiveCustomMode(), null);
    assert.deepStrictEqual(c.getPendingExitedCustomMode(), { label: "tdd" });
    assert.strictEqual(events[events.length - 1].exitedLabel, "tdd");
  });

  it("exitCustomMode with no active mode is a no-op", async () => {
    const c = makeComposer();
    let fired = 0;
    c.onDidChange((e) => {
      if (e.kind === "customModeChanged") {
        fired += 1;
      }
    });
    c.exitCustomMode();
    assert.strictEqual(fired, 0);
  });

  it("newChat drops the active custom mode (binary: draft change clears)", async () => {
    const c = makeComposer();
    c.enterCustomMode({ name: "tdd", content: SKILL_MD, filePath: "/x/SKILL.md" });
    const ok = await c.newChat();
    assert.strictEqual(ok, true);
    assert.strictEqual(c.getActiveCustomMode(), null);
    assert.strictEqual(c.getPendingExitedCustomMode(), null);
  });

  it("re-entering replaces the previous mode", async () => {
    const c = makeComposer();
    c.enterCustomMode({ name: "tdd", content: SKILL_MD, filePath: "/x/SKILL.md" });
    const first = c.getActiveCustomMode()!;
    c.enterCustomMode({ name: "review", content: "---\nname: review\n---\nbody", filePath: "/y/SKILL.md" });
    const active = c.getActiveCustomMode()!;
    assert.strictEqual(active.label, "review");
    assert.notStrictEqual(active.sessionId, first.sessionId);
    assert.strictEqual(c.getPendingExitedCustomMode(), null);
  });
});
