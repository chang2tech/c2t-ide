/**
 * DEV-GAPS-145 `settings-attribution` tests (Cursor parity).
 *
 * Evidence (Cursor 3.25.9, re-sliced by GAPS-145 — see
 * ide-code-mission/docs/rea/work-notes-gaps145.md):
 *  - registry desk @37341169: hl("git-prs","commit-attribution",{label:"Commit Attribution"}),
 *    hl("git-prs","pr-attribution",{label:"PR Attribution"}), section label "Attribution".
 *  - storage descriptor desk @14324679: attributeCommitsToAgent:Jh(!0,-1,0),
 *    attributePRsToAgent:Jh(!0,-1,0) → both default TRUE.
 *  - control B5k desk @37595653: descriptions "Mark Agent commits as 'Made with
 *    Cursor'" / "Mark pull requests as made with Cursor", admin suffix
 *    " (controlled by admin)", analytics ids attribute_commits_to_agent /
 *    attribute_prs_to_agent (event ide_settings.setting_changed, section "attribution").
 *  - consumer desk @19591501/@31614933: effective = !adminDisabled && (stored ?? !0);
 *    request context gets commitAttributionMessage:"enabled" /
 *    prAttributionMessage:"enabled", field OMITTED when off.
 *  - trailer glass @617935 (commit-identity.ts): "Co-authored-by: Cursor
 *    <cursoragent@cursor.com>", known emails [cursoragent@cursor.com, noreply@cursor.com].
 *
 * Covers: verbatim constants, the resolver formula (incl. admin lock +
 * unset fallback), trailer application (append / idempotent / off), the
 * known-email check, and static wiring (package.json settings surface +
 * adapter request-context spread).
 *
 * node:test, zero extra deps. Run after `tsc`:
 *   node --test out/services/test/run-attribution-tests.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import * as fs from "fs";
import * as path from "path";

import {
  ATTRIBUTION_ADMIN_SUFFIX,
  ATTRIBUTION_ANALYTICS_EVENT,
  ATTRIBUTION_ANALYTICS_SECTION,
  ATTRIBUTION_COMMITS_ANALYTICS_ID,
  ATTRIBUTION_COMMITS_CONFIG_KEY,
  ATTRIBUTION_COMMITS_DEFAULT,
  ATTRIBUTION_COMMITS_STORAGE_KEY,
  ATTRIBUTION_CONFIG_SECTION,
  ATTRIBUTION_ENABLED_FLAG,
  ATTRIBUTION_PRS_ANALYTICS_ID,
  ATTRIBUTION_PRS_CONFIG_KEY,
  ATTRIBUTION_PRS_DEFAULT,
  ATTRIBUTION_PRS_STORAGE_KEY,
  ATTRIBUTION_SECTION_LABEL,
  COMMIT_ATTRIBUTION_DESCRIPTION,
  COMMIT_ATTRIBUTION_LABEL,
  COMMIT_ATTRIBUTION_TRAILER,
  CURSOR_AGENT_EMAIL,
  CURSOR_AGENT_NAME,
  KNOWN_CURSOR_AGENT_EMAILS,
  PR_ATTRIBUTION_DESCRIPTION,
  PR_ATTRIBUTION_LABEL,
  applyCommitAttribution,
  getCommitAttribution,
  isCommitAttributionEnabled,
  isKnownCursorAgentEmail,
  isPRAttributionEnabled,
  resolveAttributionRequestContext,
} from "../attribution";

// Compiled to out/services/test/*.js → extension root is three levels up.
const EXT_ROOT = path.resolve(__dirname, "..", "..", "..");

describe("gaps145 — verbatim binary constants", () => {
  it("storage keys are verbatim", () => {
    assert.strictEqual(ATTRIBUTION_COMMITS_STORAGE_KEY, "attributeCommitsToAgent");
    assert.strictEqual(ATTRIBUTION_PRS_STORAGE_KEY, "attributePRsToAgent");
  });

  it("defaults are true (Jh(!0,-1,0) for both)", () => {
    assert.strictEqual(ATTRIBUTION_COMMITS_DEFAULT, true);
    assert.strictEqual(ATTRIBUTION_PRS_DEFAULT, true);
  });

  it("UI strings are verbatim", () => {
    assert.strictEqual(ATTRIBUTION_SECTION_LABEL, "Attribution");
    assert.strictEqual(COMMIT_ATTRIBUTION_LABEL, "Commit Attribution");
    assert.strictEqual(PR_ATTRIBUTION_LABEL, "PR Attribution");
    assert.strictEqual(COMMIT_ATTRIBUTION_DESCRIPTION, "Mark Agent commits as 'Made with Cursor'");
    assert.strictEqual(PR_ATTRIBUTION_DESCRIPTION, "Mark pull requests as made with Cursor");
    assert.strictEqual(ATTRIBUTION_ADMIN_SUFFIX, " (controlled by admin)");
  });

  it("analytics ids/event/section are verbatim", () => {
    assert.strictEqual(ATTRIBUTION_COMMITS_ANALYTICS_ID, "attribute_commits_to_agent");
    assert.strictEqual(ATTRIBUTION_PRS_ANALYTICS_ID, "attribute_prs_to_agent");
    assert.strictEqual(ATTRIBUTION_ANALYTICS_SECTION, "attribution");
    assert.strictEqual(ATTRIBUTION_ANALYTICS_EVENT, "ide_settings.setting_changed");
  });

  it("agent identity + trailer are verbatim (glass commit-identity.ts)", () => {
    assert.strictEqual(CURSOR_AGENT_NAME, "Cursor");
    assert.strictEqual(CURSOR_AGENT_EMAIL, "cursoragent@cursor.com");
    assert.strictEqual(COMMIT_ATTRIBUTION_TRAILER, "Co-authored-by: Cursor <cursoragent@cursor.com>");
    assert.deepStrictEqual([...KNOWN_CURSOR_AGENT_EMAILS], [
      "cursoragent@cursor.com",
      "noreply@cursor.com",
    ]);
  });

  it("fork config keys resolve to ide.git.attribute*ToAgent", () => {
    assert.strictEqual(
      `${ATTRIBUTION_CONFIG_SECTION}.${ATTRIBUTION_COMMITS_CONFIG_KEY}`,
      "ide.git.attributeCommitsToAgent",
    );
    assert.strictEqual(
      `${ATTRIBUTION_CONFIG_SECTION}.${ATTRIBUTION_PRS_CONFIG_KEY}`,
      "ide.git.attributePRsToAgent",
    );
    assert.strictEqual(ATTRIBUTION_ENABLED_FLAG, "enabled");
  });
});

describe("gaps145 — resolveAttributionRequestContext (binary consumer formula)", () => {
  it("unset settings fall back to enabled (?? !0) — both fields present as \"enabled\"", () => {
    const ctx = resolveAttributionRequestContext({
      adminDisabledByAdmin: false,
      attributeCommitsToAgent: undefined,
      attributePRsToAgent: undefined,
    });
    assert.deepStrictEqual(ctx, {
      commitAttributionMessage: "enabled",
      prAttributionMessage: "enabled",
    });
  });

  it("both explicitly on → both fields present", () => {
    const ctx = resolveAttributionRequestContext({
      adminDisabledByAdmin: false,
      attributeCommitsToAgent: true,
      attributePRsToAgent: true,
    });
    assert.deepStrictEqual(ctx, {
      commitAttributionMessage: "enabled",
      prAttributionMessage: "enabled",
    });
  });

  it("commit toggle off → commit field OMITTED (not false), PR field stays", () => {
    const ctx = resolveAttributionRequestContext({
      adminDisabledByAdmin: false,
      attributeCommitsToAgent: false,
      attributePRsToAgent: true,
    });
    assert.strictEqual("commitAttributionMessage" in ctx, false);
    assert.strictEqual(ctx.commitAttributionMessage, undefined);
    assert.strictEqual(ctx.prAttributionMessage, "enabled");
  });

  it("PR toggle off → PR field omitted, commit field stays (toggles independent)", () => {
    const ctx = resolveAttributionRequestContext({
      adminDisabledByAdmin: false,
      attributeCommitsToAgent: true,
      attributePRsToAgent: false,
    });
    assert.strictEqual(ctx.commitAttributionMessage, "enabled");
    assert.strictEqual("prAttributionMessage" in ctx, false);
  });

  it("admin lock wins over stored true (binary forces checked !1 + disabled)", () => {
    const ctx = resolveAttributionRequestContext({
      adminDisabledByAdmin: true,
      attributeCommitsToAgent: true,
      attributePRsToAgent: true,
    });
    assert.deepStrictEqual(ctx, {});
  });

  it("admin lock wins over unset fallback too", () => {
    const ctx = resolveAttributionRequestContext({
      adminDisabledByAdmin: true,
      attributeCommitsToAgent: undefined,
      attributePRsToAgent: undefined,
    });
    assert.deepStrictEqual(ctx, {});
  });

  it("boolean helpers agree with the resolver", () => {
    const input = {
      adminDisabledByAdmin: false,
      attributeCommitsToAgent: false,
      attributePRsToAgent: undefined,
    };
    assert.strictEqual(isCommitAttributionEnabled(input), false);
    assert.strictEqual(isPRAttributionEnabled(input), true);
    assert.strictEqual(
      isCommitAttributionEnabled({ ...input, adminDisabledByAdmin: true, attributeCommitsToAgent: true }),
      false,
    );
  });
});

describe("gaps145 — trailer application (commit-identity)", () => {
  it("getCommitAttribution returns the verbatim trailer only when enabled", () => {
    assert.strictEqual(getCommitAttribution(true), "Co-authored-by: Cursor <cursoragent@cursor.com>");
    assert.strictEqual(getCommitAttribution(false), undefined);
  });

  it("enabled: trailer appended as its own paragraph (blank-line separated)", () => {
    assert.strictEqual(
      applyCommitAttribution("Fix the thing", true),
      "Fix the thing\n\nCo-authored-by: Cursor <cursoragent@cursor.com>",
    );
  });

  it("enabled: multi-line message keeps body, trailer goes last", () => {
    assert.strictEqual(
      applyCommitAttribution("Subject\n\nBody line", true),
      "Subject\n\nBody line\n\nCo-authored-by: Cursor <cursoragent@cursor.com>",
    );
  });

  it("disabled: message returned untouched", () => {
    assert.strictEqual(applyCommitAttribution("Fix the thing", false), "Fix the thing");
  });

  it("idempotent: message already carrying the exact trailer is unchanged", () => {
    const msg = "Fix the thing\n\nCo-authored-by: Cursor <cursoragent@cursor.com>";
    assert.strictEqual(applyCommitAttribution(msg, true), msg);
  });

  it("trailing whitespace is normalized before appending", () => {
    assert.strictEqual(
      applyCommitAttribution("Fix the thing\n\n\n", true),
      "Fix the thing\n\nCo-authored-by: Cursor <cursoragent@cursor.com>",
    );
  });

  it("empty message + enabled → trailer only; empty + disabled → empty", () => {
    assert.strictEqual(
      applyCommitAttribution("", true),
      "Co-authored-by: Cursor <cursoragent@cursor.com>",
    );
    assert.strictEqual(applyCommitAttribution("", false), "");
  });
});

describe("gaps145 — isKnownCursorAgentEmail (glass Gyd semantics)", () => {
  it("matches both known emails", () => {
    assert.strictEqual(isKnownCursorAgentEmail("cursoragent@cursor.com"), true);
    assert.strictEqual(isKnownCursorAgentEmail("noreply@cursor.com"), true);
  });

  it("trims + lowercases before matching (binary: trim().toLowerCase())", () => {
    assert.strictEqual(isKnownCursorAgentEmail("  CursorAgent@Cursor.com "), true);
  });

  it("rejects other emails, empty, undefined, null", () => {
    assert.strictEqual(isKnownCursorAgentEmail("dev@example.com"), false);
    assert.strictEqual(isKnownCursorAgentEmail(""), false);
    assert.strictEqual(isKnownCursorAgentEmail(undefined), false);
    assert.strictEqual(isKnownCursorAgentEmail(null), false);
  });
});

describe("gaps145 — static wiring", () => {
  it("package.json registers both settings under 'IDE Git & PRs' with default true + verbatim titles/descriptions", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(EXT_ROOT, "package.json"), "utf8"));
    const groups = pkg.contributes.configuration as Array<{
      title: string;
      properties: Record<string, { type: string; default: unknown; title?: string; markdownDescription?: string }>;
    }>;
    const group = groups.find((g) => g.title === "IDE Git & PRs");
    assert.ok(group, "IDE Git & PRs configuration group exists");
    const commits = group.properties["ide.git.attributeCommitsToAgent"];
    const prs = group.properties["ide.git.attributePRsToAgent"];
    assert.ok(commits && prs, "both attribution properties registered");
    assert.strictEqual(commits.type, "boolean");
    assert.strictEqual(commits.default, true);
    assert.strictEqual(commits.title, "Commit Attribution");
    assert.ok(commits.markdownDescription?.includes("Mark Agent commits as 'Made with Cursor'"));
    assert.strictEqual(prs.type, "boolean");
    assert.strictEqual(prs.default, true);
    assert.strictEqual(prs.title, "PR Attribution");
    assert.ok(prs.markdownDescription?.includes("Mark pull requests as made with Cursor"));
  });

  it("adapter reads the config per turn and spreads the request-context flags into the prompt body", () => {
    const adapterSrc = fs.readFileSync(
      path.join(EXT_ROOT, "src", "services", "ideCodeEngineAdapter.ts"),
      "utf8",
    );
    assert.ok(adapterSrc.includes("readAttributionRequestContext"), "adapter has the resolver reader");
    assert.ok(
      adapterSrc.includes("...this.readAttributionRequestContext()"),
      "prompt body spreads the attribution request context",
    );
    assert.ok(adapterSrc.includes("ATTRIBUTION_CONFIG_SECTION"), "adapter reads the ide.git section");
    const attributionSrc = fs.readFileSync(
      path.join(EXT_ROOT, "src", "services", "attribution.ts"),
      "utf8",
    );
    assert.ok(attributionSrc.includes("commitAttributionMessage"), "module names the proto field");
    assert.ok(attributionSrc.includes("prAttributionMessage"), "module names the PR proto field");
  });
});
