/**
 * Prompt Quality host-glue tests — node:test, zero extra deps.
 *
 * Exercises services/promptQualityService.ts:
 *  - registerPromptQualityCommands registers the two command ids verbatim
 *    from the Cursor 3.25.6 binary evidence (composer.openPromptQuality,
 *    composer.openPromptQualityFromPane) and both open the review panel.
 *  - scorePrompt is deterministic, bounded 0–100, and returns our own
 *    3-dimension rubric (clarity / specificity / context).
 *  - buildPromptQualityPanelHtml renders the prompt + rubric and escapes
 *    user-supplied text (no raw HTML injection).
 *
 * Run after `tsc`:  node --test out/services/test/run-prompt-quality-tests.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import {
  OPEN_PROMPT_QUALITY,
  OPEN_PROMPT_QUALITY_FROM_PANE,
  OPEN_PROMPT_QUALITY_TITLE,
  registerPromptQualityCommands,
  scorePrompt,
  buildPromptQualityPanelHtml,
  escapeHtml,
  type PromptQualityHost,
  type RubricDimension,
} from "../promptQualityService";

function mockHost(): {
  host: PromptQualityHost;
  registered: Map<string, (prompt?: string) => void>;
  opened: string[];
} {
  const registered = new Map<string, (prompt?: string) => void>();
  const opened: string[] = [];
  return {
    registered,
    opened,
    host: {
      registerCommand: (id: string, handler: (prompt?: string) => void): void => {
        registered.set(id, handler);
      },
      openPromptQualityPanel: (prompt: string): void => {
        opened.push(prompt);
      },
    },
  };
}

const GOOD_PROMPT =
  "Fix the race condition in src/services/chatTabService.ts. The tab title flickers when two chats load at once. Keep the existing event API, and make sure the change is covered by run-chattabs-tests.ts.";
const VAGUE_PROMPT = "do stuff";

describe("promptQualityService command ids match binary evidence", () => {
  it("pins both ids and the label verbatim", () => {
    assert.strictEqual(OPEN_PROMPT_QUALITY, "composer.openPromptQuality");
    assert.strictEqual(OPEN_PROMPT_QUALITY_FROM_PANE, "composer.openPromptQualityFromPane");
    assert.strictEqual(OPEN_PROMPT_QUALITY_TITLE, "Open in Prompt Quality");
  });

  it("registers exactly the two evidence command ids, nothing else", () => {
    const { host, registered } = mockHost();
    registerPromptQualityCommands(host);
    assert.strictEqual(registered.size, 2);
    assert.ok(registered.has("composer.openPromptQuality"));
    assert.ok(registered.has("composer.openPromptQualityFromPane"));
  });

  it("both handlers open the panel with the prompt argument", () => {
    const { host, registered, opened } = mockHost();
    registerPromptQualityCommands(host);
    registered.get("composer.openPromptQuality")!(GOOD_PROMPT);
    registered.get("composer.openPromptQualityFromPane")!(VAGUE_PROMPT);
    assert.deepStrictEqual(opened, [GOOD_PROMPT, VAGUE_PROMPT]);
  });

  it("handler invoked without an argument opens the panel with an empty prompt", () => {
    const { host, registered, opened } = mockHost();
    registerPromptQualityCommands(host);
    registered.get("composer.openPromptQuality")!();
    assert.deepStrictEqual(opened, [""]);
  });
});

describe("scorePrompt — our own rubric (not Cursor's; UNKNOWN)", () => {
  function checkShape(dims: RubricDimension[]): void {
    assert.strictEqual(dims.length, 3);
    assert.deepStrictEqual(
      dims.map((d) => d.id),
      ["clarity", "specificity", "context"],
    );
    for (const d of dims) {
      assert.ok(Number.isInteger(d.score), `${d.id} score is an integer`);
      assert.ok(d.score >= 0 && d.score <= 100, `${d.id} score in 0..100`);
      assert.ok(typeof d.label === "string" && d.label.length > 0);
      assert.ok(typeof d.feedback === "string" && d.feedback.length > 0);
    }
  }

  it("returns 3 well-formed dimensions for a real prompt", () => {
    checkShape(scorePrompt(GOOD_PROMPT));
  });

  it("is deterministic — same input yields the same scores", () => {
    assert.deepStrictEqual(scorePrompt(GOOD_PROMPT), scorePrompt(GOOD_PROMPT));
  });

  it("scores empty / whitespace-only prompts as 0 with an explanation", () => {
    for (const p of ["", "   "]) {
      const dims = scorePrompt(p);
      assert.ok(dims.every((d) => d.score === 0), "empty prompt scores 0");
      assert.ok(dims.every((d) => /no prompt text/i.test(d.feedback)));
    }
  });

  it("rates the concrete prompt higher than the vague one on every dimension", () => {
    const good = scorePrompt(GOOD_PROMPT);
    const vague = scorePrompt(VAGUE_PROMPT);
    for (let i = 0; i < 3; i++) {
      assert.ok(
        good[i].score > vague[i].score,
        `${good[i].id}: ${good[i].score} should exceed ${vague[i].score}`,
      );
    }
  });

  it("never throws on arbitrary input", () => {
    assert.doesNotThrow(() => scorePrompt("<script>alert(1)</script>"));
    assert.doesNotThrow(() => scorePrompt("x".repeat(10000)));
  });
});

describe("buildPromptQualityPanelHtml", () => {
  it("renders the title, all rubric labels, and the numeric scores", () => {
    const dims = scorePrompt(GOOD_PROMPT);
    const html = buildPromptQualityPanelHtml(GOOD_PROMPT, dims);
    assert.ok(html.includes("Open in Prompt Quality"));
    for (const d of dims) {
      assert.ok(html.includes(d.label), `contains label ${d.label}`);
      assert.ok(html.includes(`${d.score}/100`), `contains score ${d.score}/100`);
    }
  });

  it("escapes user-supplied prompt text (no raw HTML injection)", () => {
    const evil = "<script>alert('xss')</script> & <b>bold</b>";
    const html = buildPromptQualityPanelHtml(evil, scorePrompt(evil));
    assert.ok(!html.includes("<script>"), "no raw script tag");
    assert.ok(!html.includes("<b>bold</b>"), "no raw bold tag");
    assert.ok(html.includes(escapeHtml(evil)), "escaped text present");
  });

  it("shows a placeholder for an empty prompt", () => {
    const html = buildPromptQualityPanelHtml("", scorePrompt(""));
    assert.ok(html.includes("(empty prompt)"));
  });
});

describe("escapeHtml", () => {
  it("escapes the five XML/HTML specials", () => {
    assert.strictEqual(escapeHtml('&<>"\''), "&amp;&lt;&gt;&quot;&#39;");
  });

  it("leaves normal text untouched", () => {
    assert.strictEqual(escapeHtml("Fix the bug in auth.ts"), "Fix the bug in auth.ts");
  });
});
