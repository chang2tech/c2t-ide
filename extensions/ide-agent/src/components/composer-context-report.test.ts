/**
 * GAPS-167 — composer webview wiring for the context usage report.
 *
 * Strategy (same as composer-jump.test.ts): stub the `vscode` module,
 * call createComposer() for the real HTML, extract the inline <script>,
 * and assert it (a) parses as JS and (b) carries the report wiring:
 * the tray's verbatim "View Report" button, the `ctxUsageReport` host
 * message case, and the verbatim report copy ("Context Usage Report",
 * "Context Explorer", "Debug with Agent").
 *
 * Run after `tsc`:  node out/components/composer-context-report.test.js
 */
import { describe, it, before } from "node:test";
import * as assert from "node:assert";
import * as vm from "node:vm";

const Module = require("module") as { _load: (...args: unknown[]) => unknown };
const origLoad = (Module._load as (...args: unknown[]) => unknown).bind(Module);
(Module as unknown as { _load: (...args: unknown[]) => unknown })._load = function (
  request: unknown,
  ...rest: unknown[]
) {
  if (request === "vscode") {
    return {};
  }
  return origLoad(request, ...rest);
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createComposer } = require("./composer") as typeof import("./composer");
import type { ModeName } from "../model";

let html = "";
let script = "";

before(() => {
  html = createComposer({} as never, "agent" as ModeName, false, "en", "ltr", "auto");
  const m = html.match(/<script nonce="[^"]*">([\s\S]*?)<\/script>/);
  assert.ok(m, "inline webview script not found");
  script = m![1]!;
});

describe("composer context usage report wiring (GAPS-167)", () => {
  it("HTML carries the report panel mount point", () => {
    assert.ok(html.includes('id="ctxReport"'), "missing #ctxReport overlay div");
  });

  it("inline webview script parses as valid JS", () => {
    assert.doesNotThrow(() => new vm.Script(script, { filename: "composer-webview.js" }));
  });

  it("script wires the tray View Report button to the host", () => {
    assert.ok(script.includes("View Report"), "missing verbatim tray button label");
    assert.ok(script.includes("openContextUsageReport"), "missing openContextUsageReport post");
    assert.ok(script.includes("ctxViewReport"), "missing tray button id wiring");
  });

  it("GAPS-183: script carries the host's real denominator (contextWindowTokens)", () => {
    assert.ok(script.includes("contextWindowTokens"), "missing contextWindowTokens read from ctxUsage");
    assert.ok(script.includes("ctxContextWindowTokens"), "missing tray denominator state");
  });

  it("script renders the report from the ctxUsageReport host message with verbatim copy", () => {
    assert.ok(script.includes("case 'ctxUsageReport':"), "missing ctxUsageReport message case");
    assert.ok(script.includes("Context Usage Report"), "missing verbatim eyebrow");
    assert.ok(script.includes("Context Explorer"), "missing verbatim explorer title");
    assert.ok(script.includes("Debug with Agent"), "missing verbatim debug button");
    assert.ok(script.includes("debugContextUsage"), "missing debug post to host");
    assert.ok(script.includes("No context breakdown loaded yet."), "missing verbatim empty state");
    assert.ok(script.includes("Context window is getting full"), "missing verbatim callout title");
  });
});
