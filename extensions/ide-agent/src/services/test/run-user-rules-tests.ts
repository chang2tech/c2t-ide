/**
 * Unit tests for GAPS-36D `rules-user` (UserRulesService).
 *
 * Evidence (Cursor 3.25.9, verified by own binary grep 2026-10-20):
 * - `editor.action.knowledgeBase.add` = "Add User Rule"
 * - `editor.action.knowledgeBase.list` = "View User Rules"
 * - "User Rules apply to all of your chats" (global scope)
 * - docs.cursor.com/docs/rules: User Rules used by Agent (Chat) ONLY —
 *   never Tab, never Inline Edit.
 *
 * Assertions:
 *  - buildUserRulesBlock: "" for no rules; <user_rules>/<user_rule name>
 *    XML shape; name attribute escaped; content injected verbatim
 *    ("Rule content reaches Agent as written"); blank title falls back to
 *    the binary string "User Rule".
 *  - CRUD: add/update/remove round-trip; unknown ids → false; empty content
 *    rejected; getRules returns oldest-first copies.
 *  - Persistence: rules survive across service instances (global store file);
 *    corrupt JSON → empty set, no throw; save repairs on next write.
 *  - onDidChangeRules fires on add/update/remove.
 *
 * node:test, zero extra deps. The `vscode` module is stubbed via
 * ./vscode-stub (imported FIRST).
 *
 * Run after `tsc`:  node out/services/test/run-user-rules-tests.mjs
 */
import "./vscode-stub";
import { describe, it } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildUserRulesBlock,
  DEFAULT_USER_RULE_TITLE,
  parseUserRule,
  USER_RULES_FILE_NAME,
  UserRule,
  UserRulesService,
} from "../userRulesService";

function makeService(dir?: string): { svc: UserRulesService; dir: string } {
  const storageDir = dir ?? fs.mkdtempSync(path.join(os.tmpdir(), "ide-user-rules-"));
  const svc = new UserRulesService({ globalStorageDir: storageDir });
  return { svc, dir: storageDir };
}

function makeRule(overrides: Partial<UserRule> = {}): UserRule {
  return {
    id: "ur_test1",
    title: "Coding style",
    content: "Always use TypeScript strict mode.",
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

describe("buildUserRulesBlock", () => {
  it("returns empty string when there are no rules (zero-cost no-op)", () => {
    assert.strictEqual(buildUserRulesBlock([]), "");
  });

  it("wraps one rule in <user_rules>/<user_rule name>", () => {
    const text = buildUserRulesBlock([makeRule()]);
    assert.strictEqual(
      text,
      `<user_rules>\n<user_rule name="Coding style">\nAlways use TypeScript strict mode.\n</user_rule>\n</user_rules>`,
    );
  });

  it("emits one <user_rule> per rule, oldest first", () => {
    const text = buildUserRulesBlock([
      makeRule({ id: "a", title: "First", content: "one" }),
      makeRule({ id: "b", title: "Second", content: "two" }),
    ]);
    assert.ok(text.includes('<user_rule name="First">\none\n</user_rule>'));
    assert.ok(text.includes('<user_rule name="Second">\ntwo\n</user_rule>'));
    assert.ok(text.indexOf("First") < text.indexOf("Second"));
  });

  it("escapes the name attribute but injects content verbatim", () => {
    // Docs: "Rule content reaches Agent as written" — no escaping there.
    const text = buildUserRulesBlock([
      makeRule({ title: 'A "quoted" <rule> & more', content: "<raw> & \"verbatim\"" }),
    ]);
    assert.ok(text.includes('<user_rule name="A &quot;quoted&quot; &lt;rule&gt; &amp; more">'));
    assert.ok(text.includes("<raw> & \"verbatim\""));
  });

  it("falls back to the binary string 'User Rule' for a blank title", () => {
    const text = buildUserRulesBlock([makeRule({ title: "   " })]);
    assert.ok(text.includes(`<user_rule name="${DEFAULT_USER_RULE_TITLE}">`));
    assert.strictEqual(DEFAULT_USER_RULE_TITLE, "User Rule");
  });
});

describe("parseUserRule", () => {
  it("accepts a well-formed entry", () => {
    const r = parseUserRule({ id: "x", title: "T", content: "C", createdAt: 5, updatedAt: 6 });
    assert.deepStrictEqual(r, { id: "x", title: "T", content: "C", createdAt: 5, updatedAt: 6 });
  });

  it("rejects malformed entries", () => {
    assert.strictEqual(parseUserRule(null), null);
    assert.strictEqual(parseUserRule([]), null);
    assert.strictEqual(parseUserRule({ title: "T", content: "C" }), null); // no id
    assert.strictEqual(parseUserRule({ id: "x", content: "C" }), null); // no title
    assert.strictEqual(parseUserRule({ id: "x", title: "T" }), null); // no content
  });

  it("defaults missing timestamps to 0", () => {
    const r = parseUserRule({ id: "x", title: "T", content: "C" });
    assert.strictEqual(r?.createdAt, 0);
    assert.strictEqual(r?.updatedAt, 0);
  });
});

describe("UserRulesService CRUD", () => {
  it("starts empty with no store file", () => {
    const { svc, dir } = makeService();
    assert.deepStrictEqual(svc.getRules(), []);
    assert.strictEqual(svc.buildInjection(), "");
    svc.dispose();
    assert.ok(!fs.existsSync(path.join(dir, USER_RULES_FILE_NAME)));
  });

  it("addRule persists and returns the rule", async () => {
    const { svc, dir } = makeService();
    const rule = await svc.addRule("Style", "Use tabs.");
    assert.ok(rule.id.startsWith("ur_"));
    assert.strictEqual(rule.title, "Style");
    assert.strictEqual(rule.content, "Use tabs.");
    assert.deepStrictEqual(
      svc.getRules().map((r) => r.title),
      ["Style"],
    );
    assert.ok(fs.existsSync(path.join(dir, USER_RULES_FILE_NAME)));
    svc.dispose();
  });

  it("addRule rejects empty content", async () => {
    const { svc } = makeService();
    await assert.rejects(() => svc.addRule("Empty", "   "), /must not be empty/);
    svc.dispose();
  });

  it("addRule falls back to 'User Rule' for a blank title", async () => {
    const { svc } = makeService();
    const rule = await svc.addRule("   ", "Some content.");
    assert.strictEqual(rule.title, "User Rule");
    svc.dispose();
  });

  it("updateRule edits title and content; unknown id → false", async () => {
    const { svc } = makeService();
    const rule = await svc.addRule("Old", "old content");
    assert.strictEqual(await svc.updateRule("nope", { title: "X" }), false);
    assert.strictEqual(await svc.updateRule(rule.id, { title: "New", content: "new content" }), true);
    const got = svc.getRule(rule.id);
    assert.strictEqual(got?.title, "New");
    assert.strictEqual(got?.content, "new content");
    assert.ok((got?.updatedAt ?? 0) >= rule.updatedAt);
    svc.dispose();
  });

  it("updateRule rejects empty content", async () => {
    const { svc } = makeService();
    const rule = await svc.addRule("T", "content");
    await assert.rejects(() => svc.updateRule(rule.id, { content: "  " }), /must not be empty/);
    svc.dispose();
  });

  it("removeRule deletes; unknown id → false", async () => {
    const { svc } = makeService();
    const rule = await svc.addRule("T", "content");
    assert.strictEqual(await svc.removeRule("nope"), false);
    assert.strictEqual(await svc.removeRule(rule.id), true);
    assert.deepStrictEqual(svc.getRules(), []);
    svc.dispose();
  });

  it("getRules returns oldest-first copies (mutation-safe)", async () => {
    const { svc } = makeService();
    const a = await svc.addRule("A", "a");
    const b = await svc.addRule("B", "b");
    const list = svc.getRules();
    assert.deepStrictEqual(list.map((r) => r.id), [a.id, b.id]);
    list[0].title = "MUTATED";
    assert.strictEqual(svc.getRule(a.id)?.title, "A");
    svc.dispose();
  });

  it("buildInjection emits the <user_rules> block after adds", async () => {
    const { svc } = makeService();
    await svc.addRule("Style", "Use tabs.");
    const text = svc.buildInjection();
    assert.ok(text.startsWith("<user_rules>"));
    assert.ok(text.includes('<user_rule name="Style">'));
    assert.ok(text.includes("Use tabs."));
    svc.dispose();
  });
});

describe("UserRulesService persistence", () => {
  it("rules survive across instances (global store)", async () => {
    const { dir } = makeService();
    const first = new UserRulesService({ globalStorageDir: dir });
    const rule = await first.addRule("Global", "applies to all projects");
    first.dispose();
    const second = new UserRulesService({ globalStorageDir: dir });
    assert.deepStrictEqual(
      second.getRules().map((r) => r.title),
      ["Global"],
    );
    assert.strictEqual(second.getRule(rule.id)?.content, "applies to all projects");
    second.dispose();
  });

  it("corrupt JSON loads as empty and never throws; next save repairs", async () => {
    const { svc, dir } = makeService();
    svc.dispose();
    fs.writeFileSync(path.join(dir, USER_RULES_FILE_NAME), "{not json", "utf8");
    const logs: string[] = [];
    const broken = new UserRulesService({
      globalStorageDir: dir,
      output: { appendLine: (l) => logs.push(l) },
    });
    assert.deepStrictEqual(broken.getRules(), []);
    assert.ok(logs.some((l) => l.includes("unreadable")));
    await broken.addRule("Repaired", "content");
    const reread = new UserRulesService({ globalStorageDir: dir });
    assert.deepStrictEqual(reread.getRules().map((r) => r.title), ["Repaired"]);
    broken.dispose();
    reread.dispose();
  });

  it("skips malformed entries but keeps valid ones", () => {
    const { dir } = makeService();
    fs.writeFileSync(
      path.join(dir, USER_RULES_FILE_NAME),
      JSON.stringify([{ id: "ok", title: "T", content: "C" }, { bogus: true }, "nope"]),
      "utf8",
    );
    const svc = new UserRulesService({ globalStorageDir: dir });
    assert.deepStrictEqual(svc.getRules().map((r) => r.id), ["ok"]);
    svc.dispose();
  });
});

describe("UserRulesService events", () => {
  it("onDidChangeRules fires on add/update/remove", async () => {
    const { svc } = makeService();
    let fires = 0;
    svc.onDidChangeRules(() => {
      fires += 1;
    });
    const rule = await svc.addRule("T", "content");
    await svc.updateRule(rule.id, { title: "T2" });
    await svc.removeRule(rule.id);
    assert.strictEqual(fires, 3);
    svc.dispose();
  });
});
