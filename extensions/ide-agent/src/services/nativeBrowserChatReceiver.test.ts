/**
 * nativeBrowserChatReceiver tests (node:test, zero extra deps).
 *
 * DEV-GAPS-55: `ide.browserAttachToChat` receiver for the two GAPS-46 kinds
 * (Design Mode voice + annotations) plus the pre-existing browser
 * attachments. QA is two-step, mirroring the task brief:
 *   step 1 — the receiver's kind set must EQUAL the sender's spec
 *            (IIdeBrowserChatAttachment['kind'] in workbench-core
 *            browserEditorChatFeatures.ts, DEV-GAPS-46);
 *   step 2 — each kind must dispatch to the right host action:
 *            voiceInput → submit transcript (queued while a turn runs,
 *            sent immediately when idle — the "queue changes by voice" REA
 *            spec), designAnnotation → image chip (+ text fallback).
 *
 * Run after `tsc`:  node out/services/nativeBrowserChatReceiver.test.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import * as fs from "fs";
import * as path from "path";
import {
  dispatchNativeBrowserChatAttachment,
  NATIVE_BROWSER_CHAT_ATTACHMENT_KINDS,
  type NativeBrowserChatAttachment,
  type NativeBrowserChatReceiverDeps,
} from "./nativeBrowserChatReceiver";

interface RecordedCalls {
  contexts: Array<{ label: string; content: string }>;
  images: Array<{ imageBase64: string; label: string }>;
  submits: Array<{ text: string; queue: boolean }>;
}

function fakeDeps(agentTurnActive: boolean): { deps: NativeBrowserChatReceiverDeps; calls: RecordedCalls } {
  const calls: RecordedCalls = { contexts: [], images: [], submits: [] };
  const deps: NativeBrowserChatReceiverDeps = {
    postSelectionContext: (label, content) => calls.contexts.push({ label, content }),
    saveBrowserImage: (imageBase64, label) => calls.images.push({ imageBase64, label }),
    isAgentTurnActive: () => agentTurnActive,
    submitPrompt: (text, opts) => calls.submits.push({ text, queue: opts.queue }),
  };
  return { deps, calls };
}

describe("kind set matches the GAPS-46 sender spec", () => {
  it("receiver kinds equal IIdeBrowserChatAttachment kinds", (t) => {
    // Compiled to out/services/ — repo root is four levels up.
    const senderFile = path.resolve(
      __dirname,
      "..",
      "..",
      "..",
      "..",
      "src",
      "vs",
      "workbench",
      "contrib",
      "browserView",
      "electron-browser",
      "features",
      "browserEditorChatFeatures.ts",
    );
    if (!fs.existsSync(senderFile)) {
      t.skip("sender spec file not found (extension-only checkout)");
      return;
    }
    const src = fs.readFileSync(senderFile, "utf8");
    const m = src.match(/interface IIdeBrowserChatAttachment \{[^}]*kind:\s*([^;]+);/);
    assert.ok(m, "IIdeBrowserChatAttachment.kind union must be present in the sender file");
    const senderKinds = new Set(
      [...m[1].matchAll(/'([A-Za-z]+)'/g)].map((g) => g[1]),
    );
    assert.deepStrictEqual(
      new Set(NATIVE_BROWSER_CHAT_ATTACHMENT_KINDS as readonly string[]),
      senderKinds,
      "receiver kind set must equal the sender's IIdeBrowserChatAttachment kinds",
    );
  });

  it("voiceInput and designAnnotation are both covered", () => {
    assert.ok(NATIVE_BROWSER_CHAT_ATTACHMENT_KINDS.includes("voiceInput"));
    assert.ok(NATIVE_BROWSER_CHAT_ATTACHMENT_KINDS.includes("designAnnotation"));
  });
});

describe("voiceInput", () => {
  const payload = (text: string): NativeBrowserChatAttachment => ({
    kind: "voiceInput",
    name: "Voice input",
    text,
  });

  it("transcript is submitted as a user message when idle", () => {
    const { deps, calls } = fakeDeps(false);
    dispatchNativeBrowserChatAttachment(deps, payload("make the header blue"));
    assert.deepStrictEqual(calls.submits, [{ text: "make the header blue", queue: false }]);
    assert.deepStrictEqual(calls.contexts, []);
    assert.deepStrictEqual(calls.images, []);
  });

  it("transcript is queued while a turn runs (queue changes by voice)", () => {
    const { deps, calls } = fakeDeps(true);
    dispatchNativeBrowserChatAttachment(deps, payload("make the header blue"));
    assert.deepStrictEqual(calls.submits, [{ text: "make the header blue", queue: true }]);
  });

  it("empty or whitespace transcript is dropped", () => {
    const { deps, calls } = fakeDeps(false);
    dispatchNativeBrowserChatAttachment(deps, payload(""));
    dispatchNativeBrowserChatAttachment(deps, payload("   \n  "));
    assert.deepStrictEqual(calls.submits, []);
  });

  it("surrounding whitespace is trimmed before submit", () => {
    const { deps, calls } = fakeDeps(false);
    dispatchNativeBrowserChatAttachment(deps, payload("  center the logo  "));
    assert.deepStrictEqual(calls.submits, [{ text: "center the logo", queue: false }]);
  });
});

describe("designAnnotation", () => {
  it("annotated PNG is attached as an image chip under its name", () => {
    const { deps, calls } = fakeDeps(false);
    dispatchNativeBrowserChatAttachment(deps, {
      kind: "designAnnotation",
      name: "Design annotations",
      text: "",
      imageBase64: "iVBORw0KGgo=",
      imageMimeType: "image/png",
    });
    assert.deepStrictEqual(calls.images, [{ imageBase64: "iVBORw0KGgo=", label: "Design annotations" }]);
    assert.deepStrictEqual(calls.contexts, []);
    assert.deepStrictEqual(calls.submits, []);
  });

  it("region list lands as text context via the companion 'element' payload", () => {
    // GAPS-46 sends the spatial region list as a companion generic entry
    // (id `browser-design-annotation-text-*`) which the sender maps to kind
    // 'element' — the region descriptions must reach chat as text context.
    const { deps, calls } = fakeDeps(false);
    dispatchNativeBrowserChatAttachment(deps, {
      kind: "element",
      name: "Design annotation regions",
      text: "Region 1: rectangle at (10, 20) size 100x50",
    });
    assert.deepStrictEqual(calls.contexts, [
      { label: "Element: Design annotation regions", content: "Region 1: rectangle at (10, 20) size 100x50" },
    ]);
  });

  it("annotation without PNG falls back to text context", () => {
    const { deps, calls } = fakeDeps(false);
    dispatchNativeBrowserChatAttachment(deps, {
      kind: "designAnnotation",
      name: "Design annotations",
      text: "Region 1: rectangle",
    });
    assert.deepStrictEqual(calls.contexts, [{ label: "Design annotations", content: "Region 1: rectangle" }]);
    assert.deepStrictEqual(calls.images, []);
  });

  it("empty annotation payload is a no-op", () => {
    const { deps, calls } = fakeDeps(false);
    dispatchNativeBrowserChatAttachment(deps, { kind: "designAnnotation", name: "Design annotations", text: "" });
    assert.deepStrictEqual(calls.images, []);
    assert.deepStrictEqual(calls.contexts, []);
  });
});

describe("pre-existing kinds keep their behavior", () => {
  it("element → selection context + element screenshot", () => {
    const { deps, calls } = fakeDeps(false);
    dispatchNativeBrowserChatAttachment(deps, {
      kind: "element",
      name: "BUTTON.glass-button",
      text: "<button>Buy</button>",
      imageBase64: "AAAA",
    });
    assert.deepStrictEqual(calls.contexts, [{ label: "Element: BUTTON.glass-button", content: "<button>Buy</button>" }]);
    assert.deepStrictEqual(calls.images, [{ imageBase64: "AAAA", label: "Element screenshot: BUTTON.glass-button" }]);
  });

  it("screenshot kinds → image chip only when bytes are present", () => {
    const kinds = ["screenshot", "areaScreenshot", "fullPageScreenshot"] as const;
    for (const kind of kinds) {
      const { deps, calls } = fakeDeps(false);
      dispatchNativeBrowserChatAttachment(deps, { kind, name: kind, text: "", imageBase64: "BBBB" });
      assert.deepStrictEqual(calls.images, [{ imageBase64: "BBBB", label: kind }], `kind ${kind}`);
      dispatchNativeBrowserChatAttachment(deps, { kind, name: kind, text: "" });
      assert.strictEqual(calls.images.length, 1, `kind ${kind} without bytes must not add an image`);
    }
  });

  it("consoleLogs → selection context labelled 'Console Logs'", () => {
    const { deps, calls } = fakeDeps(false);
    dispatchNativeBrowserChatAttachment(deps, { kind: "consoleLogs", name: "Console", text: "[error] boom" });
    assert.deepStrictEqual(calls.contexts, [{ label: "Console Logs", content: "[error] boom" }]);
  });
});

describe("robustness", () => {
  it("null / undefined / non-string kind payloads are ignored", () => {
    const { deps, calls } = fakeDeps(false);
    dispatchNativeBrowserChatAttachment(deps, null);
    dispatchNativeBrowserChatAttachment(deps, undefined);
    dispatchNativeBrowserChatAttachment(
      deps,
      { kind: 42 } as unknown as NativeBrowserChatAttachment,
    );
    assert.deepStrictEqual(calls, { contexts: [], images: [], submits: [] });
  });

  it("unknown kind from a newer sender is ignored, not thrown", () => {
    const { deps, calls } = fakeDeps(false);
    dispatchNativeBrowserChatAttachment(
      deps,
      { kind: "futureKind", name: "X", text: "hi" } as unknown as NativeBrowserChatAttachment,
    );
    assert.deepStrictEqual(calls, { contexts: [], images: [], submits: [] });
  });
});
