/**
 * Mention matching tests (node:test, zero extra deps).
 *
 * Unit: normalizeMentionQuery, fuzzyMatch, matchesMentionQuery,
 * parseMentionScope, isMentionChip.
 *
 * Run after `tsc`:  node out/services/test/run-mention-tests.mjs
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import {
  fuzzyMatch,
  isMentionChip,
  matchesMentionQuery,
  MENTION_ITEM_CAP,
  MentionItem,
  normalizeMentionQuery,
  parseMentionScope,
} from "../mentionMatch";

function makeItem(overrides: Partial<MentionItem> = {}): MentionItem {
  return {
    id: "file:file:///ws/src/auth.ts",
    label: "auth.ts",
    rawText: "src/auth.ts",
    mentionType: "file",
    description: "src",
    payload: { case: "fileSelection", uri: "file:///ws/src/auth.ts" },
    ...overrides,
  };
}

describe("normalizeMentionQuery", () => {
  it("strips leading @, trims, lowercases, caps at 120", () => {
    assert.equal(normalizeMentionQuery("  @Auth.TS  "), "auth.ts");
    assert.equal(normalizeMentionQuery("FILES foo").length <= MENTION_ITEM_CAP * 10, true);
    assert.equal(normalizeMentionQuery("@" + "x".repeat(200)).length, 120);
    assert.equal(normalizeMentionQuery(""), "");
  });
});

describe("fuzzyMatch", () => {
  it("matches subsequences in order", () => {
    assert.equal(fuzzyMatch("ath", "auth.ts"), true);
    assert.equal(fuzzyMatch("ats", "auth.ts"), true);
    assert.equal(fuzzyMatch("tsa", "auth.ts"), false);
    assert.equal(fuzzyMatch("", "anything"), true);
    assert.equal(fuzzyMatch("AUTH", "auth.ts"), true);
  });
});

describe("matchesMentionQuery", () => {
  it("empty query matches everything", () => {
    assert.equal(matchesMentionQuery(makeItem(), ""), true);
  });
  it("single token fuzzy on label", () => {
    assert.equal(matchesMentionQuery(makeItem(), "ath"), true);
    assert.equal(matchesMentionQuery(makeItem(), "zzz"), false);
  });
  it("multi-token: every token must match", () => {
    assert.equal(matchesMentionQuery(makeItem(), "auth src"), true);
    assert.equal(matchesMentionQuery(makeItem(), "auth zzz"), false);
  });
  it("matches description and aliases as substrings", () => {
    const item = makeItem({ searchAliases: ["login-module"] });
    assert.equal(matchesMentionQuery(item, "login"), true);
    assert.equal(matchesMentionQuery(item, "src"), true);
  });
});

describe("parseMentionScope", () => {
  it("detects scope words", () => {
    assert.deepEqual(parseMentionScope("files auth").kinds, ["file", "folder"]);
    assert.deepEqual(parseMentionScope("terminals").kinds, ["terminal"]);
    assert.deepEqual(parseMentionScope("branch").kinds, ["branch", "git"]);
    assert.equal(parseMentionScope("branch").query, "");
    assert.equal(parseMentionScope("files auth.ts").query, "auth.ts");
  });
  it("returns null kinds for unscoped queries", () => {
    const r = parseMentionScope("auth.ts");
    assert.equal(r.kinds, null);
    assert.equal(r.query, "auth.ts");
  });
});

describe("isMentionChip", () => {
  it("accepts a well-formed chip", () => {
    assert.equal(
      isMentionChip({ ...makeItem(), uuid: "u1", payload: { case: "fileSelection", uri: "x" } }),
      true,
    );
  });
  it("rejects malformed input", () => {
    assert.equal(isMentionChip(null), false);
    assert.equal(isMentionChip({ id: "x" }), false);
    assert.equal(
      isMentionChip({ ...makeItem(), uuid: "u1", mentionType: "nope", payload: { case: "x" } }),
      false,
    );
    assert.equal(
      isMentionChip({ ...makeItem(), uuid: "u1", payload: null }),
      false,
    );
  });
});

describe("codebase mention kind", () => {
  const codebaseItem = (): MentionItem => ({
    id: "codebase:hello",
    label: "@Codebase",
    rawText: "@Codebase hello",
    mentionType: "codebase",
    description: 'Search the local codebase index for "hello"',
    payload: { case: "codebaseSelection", query: "hello" },
  });
  it("parses the codebase scope word", () => {
    const r = parseMentionScope("codebase hello");
    assert.deepEqual(r.kinds, ["codebase"]);
    assert.equal(r.query, "hello");
  });
  it("matches @Codebase items by query text", () => {
    assert.equal(matchesMentionQuery(codebaseItem(), "hello"), true);
    assert.equal(matchesMentionQuery(codebaseItem(), "codebase"), true);
    assert.equal(matchesMentionQuery(codebaseItem(), "zzz-no-match"), false);
  });
  it("accepts a well-formed @Codebase chip", () => {
    assert.equal(isMentionChip({ ...codebaseItem(), uuid: "u9" }), true);
  });
});
