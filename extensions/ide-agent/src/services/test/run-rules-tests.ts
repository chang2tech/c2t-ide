/**
 * Project-rules (.mdc) tests (node:test, zero extra deps).
 *
 * Unit: frontmatter parser, rule classification, glob matching, environments
 * gating, injection block builder.
 *
 * Run after `tsc`:  node out/services/test/run-rules-tests.mjs
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import {
  ParsedRule,
  buildRulesBlock,
  classifyRule,
  matchGlob,
  parseMdcFile,
  ruleAppliesToEnv,
  ruleMatchesFile,
} from "../projectRules";

const ROOT = "/ws";
const PATH = "/ws/.cursor/rules/api.mdc";

function makeRule(overrides: Partial<ParsedRule> = {}): ParsedRule {
  return {
    filename: "api.mdc",
    fullPath: PATH,
    workspaceRoot: ROOT,
    subdirPath: "",
    internalPath: "api.mdc",
    description: "",
    globs: [],
    alwaysApply: false,
    attachToBackgroundAgents: false,
    environments: [],
    disabledEnvironments: [],
    body: "Body text.",
    kind: "manual",
    warnings: [],
    ...overrides,
  };
}

function parse(content: string, filename = "api.mdc"): ParsedRule {
  return parseMdcFile(filename, PATH, ROOT, "", filename, content);
}

describe("parseMdcFile", () => {
  it("parses full frontmatter", () => {
    const r = parse(
      [
        "---",
        "description: FastAPI routers and Pydantic v2 schemas",
        "globs: src/app/**/router.py, src/app/**/schemas.py",
        "alwaysApply: false",
        "attachToBackgroundAgents: true",
        "metadata:",
        "  environments: desktop",
        "  disabledEnvironments: cloud",
        "---",
        "- One APIRouter per feature.",
      ].join("\n"),
    );
    assert.strictEqual(r.description, "FastAPI routers and Pydantic v2 schemas");
    assert.deepStrictEqual(r.globs, ["src/app/**/router.py", "src/app/**/schemas.py"]);
    assert.strictEqual(r.alwaysApply, false);
    assert.strictEqual(r.attachToBackgroundAgents, true);
    assert.deepStrictEqual(r.environments, ["desktop"]);
    assert.deepStrictEqual(r.disabledEnvironments, ["cloud"]);
    assert.strictEqual(r.body.trim(), "- One APIRouter per feature.");
    assert.strictEqual(r.parseError, undefined);
  });

  it("splits on the FIRST colon only", () => {
    const r = parse("---\ndescription: Use ports like http://localhost:3000\n---\nBody");
    assert.strictEqual(r.description, "Use ports like http://localhost:3000");
  });

  it("skips # comments and empty lines", () => {
    const r = parse(
      "---\n# a comment\n\ndescription: Hi\n# another\n---\nBody",
    );
    assert.strictEqual(r.description, "Hi");
    assert.deepStrictEqual(r.warnings, []);
  });

  it("ignores unknown keys", () => {
    const r = parse("---\ndescription: Hi\nfrobnicate: 123\n---\nBody");
    assert.strictEqual(r.description, "Hi");
    assert.strictEqual(r.parseError, undefined);
  });

  it("parses booleans case-insensitively", () => {
    const r = parse("---\nalwaysApply: True\nattachToBackgroundAgents: FALSE\n---\nBody");
    assert.strictEqual(r.alwaysApply, true);
    assert.strictEqual(r.attachToBackgroundAgents, false);
  });

  it("accepts bracket list syntax and quoted values", () => {
    const r = parse(
      '---\nglobs: ["src/**/*.ts", \'lib/**/*.js\']\ndescription: "Quoted desc"\n---\nBody',
    );
    assert.deepStrictEqual(r.globs, ["src/**/*.ts", "lib/**/*.js"]);
    assert.strictEqual(r.description, "Quoted desc");
  });

  it("no frontmatter -> whole file is body", () => {
    const r = parse("- Just a rule body.\n- More.");
    assert.strictEqual(r.description, "");
    assert.deepStrictEqual(r.globs, []);
    assert.strictEqual(r.body, "- Just a rule body.\n- More.");
  });

  it("unterminated frontmatter keeps whole file as body", () => {
    const r = parse("---\ndescription: Hi\n- body");
    assert.strictEqual(r.body, "---\ndescription: Hi\n- body");
  });

  it("warns on lines without a colon", () => {
    const r = parse("---\nthis line has no colon\ndescription: Hi\n---\nBody");
    assert.strictEqual(r.description, "Hi");
    assert.ok(r.warnings.length >= 1);
  });

  it("stops metadata section at non-indented key", () => {
    const r = parse(
      "---\nmetadata:\n  environments: cloud\nalwaysApply: true\n---\nBody",
    );
    assert.deepStrictEqual(r.environments, ["cloud"]);
    assert.strictEqual(r.alwaysApply, true);
  });
});

describe("classifyRule", () => {
  it("alwaysApply wins over globs", () => {
    assert.strictEqual(
      classifyRule({ alwaysApply: true, globs: ["src/**"], description: "x" }),
      "always",
    );
  });
  it("globs -> autoAttached", () => {
    assert.strictEqual(
      classifyRule({ alwaysApply: false, globs: ["src/**"], description: "" }),
      "autoAttached",
    );
  });
  it("description only -> agentRequested", () => {
    assert.strictEqual(
      classifyRule({ alwaysApply: false, globs: [], description: "x" }),
      "agentRequested",
    );
  });
  it("nothing -> manual", () => {
    assert.strictEqual(
      classifyRule({ alwaysApply: false, globs: [], description: "" }),
      "manual",
    );
  });
});

describe("matchGlob", () => {
  it("** crosses directories", () => {
    assert.ok(matchGlob("src/app/**/router.py", "src/app/api/v1/router.py"));
    assert.ok(matchGlob("src/app/**/router.py", "src/app/router.py"));
    assert.ok(!matchGlob("src/app/**/router.py", "src/other/router.py"));
  });
  it("* does not cross /", () => {
    assert.ok(matchGlob("src/*.ts", "src/a.ts"));
    assert.ok(!matchGlob("src/*.ts", "src/sub/a.ts"));
  });
  it("supports ? and character classes and alternation", () => {
    assert.ok(matchGlob("src/a?.ts", "src/ab.ts"));
    assert.ok(!matchGlob("src/a?.ts", "src/abc.ts"));
    assert.ok(matchGlob("src/*.{ts,js}", "src/a.js"));
    assert.ok(matchGlob("src/[ab].ts", "src/b.ts"));
  });
  it("trailing / means everything under the dir", () => {
    assert.ok(matchGlob("docs/", "docs/guide/intro.md"));
  });
});

describe("ruleMatchesFile", () => {
  it("matches any of several globs", () => {
    const r = makeRule({ globs: ["src/**/*.ts", "lib/**/*.js"] });
    assert.ok(ruleMatchesFile(r, "lib/x.js"));
    assert.ok(!ruleMatchesFile(r, "test/x.ts"));
  });
});

describe("ruleAppliesToEnv", () => {
  it("disabledEnvironments wins over whitelist", () => {
    const r = makeRule({ environments: ["desktop"], disabledEnvironments: ["desktop"] });
    assert.strictEqual(ruleAppliesToEnv(r, "desktop"), false);
  });
  it("empty whitelist allows all", () => {
    const r = makeRule();
    assert.strictEqual(ruleAppliesToEnv(r, "desktop"), true);
    assert.strictEqual(ruleAppliesToEnv(r, "cloud"), true);
  });
  it("whitelist filters", () => {
    const r = makeRule({ environments: ["cloud"] });
    assert.strictEqual(ruleAppliesToEnv(r, "desktop"), false);
    assert.strictEqual(ruleAppliesToEnv(r, "cloud"), true);
  });
});

describe("buildRulesBlock", () => {
  const always = makeRule({
    filename: "always.mdc",
    fullPath: "/ws/.cursor/rules/always.mdc",
    alwaysApply: true,
    kind: "always",
    body: "Always do X.",
  });
  const auto = makeRule({
    filename: "py.mdc",
    fullPath: "/ws/.cursor/rules/py.mdc",
    globs: ["src/**/*.py"],
    kind: "autoAttached",
    body: "Python rules.",
  });
  const requested = makeRule({
    filename: "db.mdc",
    fullPath: "/ws/.cursor/rules/db.mdc",
    description: "Database conventions",
    kind: "agentRequested",
    body: "DB rules body.",
  });
  const manual = makeRule({
    filename: "deploy.mdc",
    fullPath: "/ws/.cursor/rules/deploy.mdc",
    kind: "manual",
    body: "Deploy steps.",
  });
  const rules = [always, auto, requested, manual];

  it("always rules attach on every request", () => {
    const b = buildRulesBlock(rules, { contextFiles: [], prompt: "hi" });
    assert.ok(b.text.includes("Always do X."));
    assert.ok(b.text.includes("<project-rules>"));
    assert.ok(b.attached.some((a) => a.filename === "always.mdc" && a.kind === "always"));
  });

  it("auto-attached rules attach when a context file matches", () => {
    const b = buildRulesBlock(rules, {
      contextFiles: ["src/app/main.py"],
      prompt: "fix it",
    });
    assert.ok(b.text.includes("Python rules."));
    const a = b.attached.find((x) => x.filename === "py.mdc");
    assert.ok(a);
    assert.deepStrictEqual(a.matchedFiles, ["src/app/main.py"]);
  });

  it("auto-attached rules stay out when nothing matches", () => {
    const b = buildRulesBlock(rules, { contextFiles: ["README.md"], prompt: "hi" });
    assert.ok(!b.text.includes("Python rules."));
  });

  it("manual rules attach only on @-mention", () => {
    const silent = buildRulesBlock(rules, { contextFiles: [], prompt: "deploy now" });
    assert.ok(!silent.text.includes("Deploy steps."));
    const loud = buildRulesBlock(rules, { contextFiles: [], prompt: "follow @deploy" });
    assert.ok(loud.text.includes("Deploy steps."));
  });

  it("agent-requested rules are @-mentionable for on-demand fetch", () => {
    const b = buildRulesBlock(rules, { contextFiles: [], prompt: "use @db please" });
    assert.ok(b.text.includes("DB rules body."));
  });

  it("agent-requested rules are listed with description otherwise", () => {
    const b = buildRulesBlock(rules, { contextFiles: [], prompt: "hi" });
    assert.ok(b.text.includes("<available-rules>"));
    assert.ok(b.text.includes("- db.mdc: Database conventions"));
    assert.ok(!b.text.includes("DB rules body."));
  });

  it("attachToBackgroundAgents attaches in background mode", () => {
    const bg = makeRule({
      filename: "bg.mdc",
      fullPath: "/ws/.cursor/rules/bg.mdc",
      description: "Background-only",
      kind: "agentRequested",
      attachToBackgroundAgents: true,
      body: "BG body.",
    });
    const fg = buildRulesBlock([bg], { contextFiles: [], prompt: "hi", mode: "agent" });
    assert.ok(!fg.text.includes("BG body."));
    const back = buildRulesBlock([bg], { contextFiles: [], prompt: "hi", mode: "background" });
    assert.ok(back.text.includes("BG body."));
  });

  it("dedups: a rule attaches at most once", () => {
    const dup = makeRule({
      filename: "always.mdc",
      fullPath: "/ws/.cursor/rules/always.mdc",
      alwaysApply: true,
      kind: "always",
      body: "Always do X.",
    });
    const b = buildRulesBlock([always, dup], { contextFiles: [], prompt: "@always" });
    const count = b.text.split("Always do X.").length - 1;
    assert.strictEqual(count, 1);
  });

  it("respects environments gating", () => {
    const gated = makeRule({
      filename: "g.mdc",
      fullPath: "/ws/.cursor/rules/g.mdc",
      alwaysApply: true,
      kind: "always",
      disabledEnvironments: ["desktop"],
      body: "Gated body.",
    });
    const b = buildRulesBlock([gated], { contextFiles: [], prompt: "hi", env: "desktop" });
    assert.ok(!b.text.includes("Gated body."));
  });

  it("excludes rules with parse errors", () => {
    const bad = makeRule({
      filename: "bad.mdc",
      fullPath: "/ws/.cursor/rules/bad.mdc",
      alwaysApply: true,
      kind: "always",
      parseError: "boom",
      body: "Bad body.",
    });
    const b = buildRulesBlock([bad], { contextFiles: [], prompt: "hi" });
    assert.ok(!b.text.includes("Bad body."));
  });

  it("returns empty text when nothing applies", () => {
    const b = buildRulesBlock([auto, manual], { contextFiles: [], prompt: "hi" });
    assert.strictEqual(b.text, "");
    assert.deepStrictEqual(b.attached, []);
  });
});
