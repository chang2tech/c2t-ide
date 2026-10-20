/**
 * chatResubmitService tests (node:test, zero extra deps).
 *
 * Covers the Cursor edit-resubmit dialog (forum.cursor.com staff, 2026-03-23,
 * verbatim): "Continue and revert" restores files to the message's checkpoint,
 * "Continue without reverting" keeps current files — and BOTH truncate the
 * messages after the edited one. Cancel does nothing.
 *
 * The service's side effects (restore / truncate / resubmit) are injected as
 * hooks, so these tests exercise the dialog + decision logic without a
 * composer. Production hooks live in
 * ComposerDataService.resubmitEditedMessage (the only place allowed to
 * mutate the bubble store).
 *
 * Run after `tsc`:  node out/services/test/run-chat-resubmit-tests.js
 */
import { describe, it, beforeEach } from "node:test";
import * as assert from "node:assert";
import { Module } from "node:module";
// Type-only import: the value import of the service must happen AFTER the
// vscode stub is installed (see below) — otherwise require("vscode") throws.
import type { ChatResubmitHooks, ChatResubmitService } from "../chatResubmitService";

/* ---------- minimal vscode stub ---------- */
const infoDialogs: Array<{ message: string; options: any; items: string[] }> = [];
let dialogChoice: string | undefined;

const vscodeStub: any = {
  window: {
    showInformationMessage: (message: string, options?: any, ...items: string[]) => {
      infoDialogs.push({ message, options, items });
      return Promise.resolve(dialogChoice);
    },
    showWarningMessage: () => Promise.resolve(undefined),
    showErrorMessage: () => Promise.resolve(undefined),
  },
};

const origLoad = (Module as any)._load;
(Module as any)._load = function (request: string, parent: any, isMain: any) {
  if (request === "vscode") {
    return vscodeStub;
  }
  return origLoad.call(this, request, parent, isMain);
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const SvcMod = require("../chatResubmitService");

beforeEach(() => {
  infoDialogs.length = 0;
  dialogChoice = SvcMod.RESUBMIT_OPTION_REVERT;
});

function makeHooks(): { hooks: ChatResubmitHooks; calls: string[]; restored: string[]; truncated: string[]; resubmitted: string[] } {
  const calls: string[] = [];
  const restored: string[] = [];
  const truncated: string[] = [];
  const resubmitted: string[] = [];
  const hooks: ChatResubmitHooks = {
    restoreCheckpoint: async (id: string) => {
      calls.push("restore");
      restored.push(id);
    },
    truncateFrom: (id: string) => {
      calls.push("truncate");
      truncated.push(id);
      return ["b2", "b3"];
    },
    resubmit: (text: string) => {
      calls.push("resubmit");
      resubmitted.push(text);
    },
  };
  return { hooks, calls, restored, truncated, resubmitted };
}

beforeEach(() => {
  infoDialogs.length = 0;
  dialogChoice = SvcMod.RESUBMIT_OPTION_REVERT;
});

describe("chatResubmitService — evidence", () => {
  it("option labels are verbatim per the staff quote (never paraphrased)", () => {
    assert.strictEqual(SvcMod.RESUBMIT_OPTION_REVERT, "Continue and revert");
    assert.strictEqual(SvcMod.RESUBMIT_OPTION_KEEP, "Continue without reverting");
  });

  it("dialog presents both verbatim options plus Cancel, as a modal", async () => {
    dialogChoice = SvcMod.RESUBMIT_OPTION_KEEP;
    const svc: ChatResubmitService = new SvcMod.ChatResubmitService();
    const choice = await svc.promptResubmitChoice();
    assert.strictEqual(choice, "keep");
    assert.strictEqual(infoDialogs.length, 1);
    const dlg = infoDialogs[0];
    assert.deepStrictEqual(dlg.items, [
      "Continue and revert",
      "Continue without reverting",
      "Cancel",
    ]);
    assert.strictEqual(dlg.options?.modal, true);
  });
});

describe("chatResubmitService — 'Continue and revert'", () => {
  it("restores the message's checkpoint, truncates, then resubmits (in that order)", async () => {
    dialogChoice = SvcMod.RESUBMIT_OPTION_REVERT;
    const svc: ChatResubmitService = new SvcMod.ChatResubmitService();
    const { hooks, calls, restored, truncated, resubmitted } = makeHooks();
    const ok = await svc.handleResubmit("b1", "edited text", hooks);
    assert.strictEqual(ok, true);
    assert.deepStrictEqual(restored, ["b1"], "restore must target the edited bubble");
    assert.deepStrictEqual(truncated, ["b1"], "truncation must happen on revert");
    assert.deepStrictEqual(resubmitted, ["edited text"]);
    assert.deepStrictEqual(calls, ["restore", "truncate", "resubmit"]);
  });

  it("resubmit receives the exact edited text", async () => {
    dialogChoice = SvcMod.RESUBMIT_OPTION_REVERT;
    const svc: ChatResubmitService = new SvcMod.ChatResubmitService();
    const { hooks, resubmitted } = makeHooks();
    await svc.handleResubmit("b1", "  padded edit  ", hooks);
    assert.deepStrictEqual(resubmitted, ["  padded edit  "]);
  });

  it("a failing restore aborts before truncation (fail closed)", async () => {
    dialogChoice = SvcMod.RESUBMIT_OPTION_REVERT;
    const svc: ChatResubmitService = new SvcMod.ChatResubmitService();
    const { hooks } = makeHooks();
    let truncated = false;
    let resubmitted = false;
    hooks.restoreCheckpoint = async () => {
      throw new Error("disk exploded");
    };
    hooks.truncateFrom = () => {
      truncated = true;
      return [];
    };
    hooks.resubmit = () => {
      resubmitted = true;
    };
    await assert.rejects(() => svc.handleResubmit("b1", "x", hooks), /disk exploded/);
    assert.strictEqual(truncated, false, "must not truncate when the restore failed");
    assert.strictEqual(resubmitted, false, "must not resubmit when the restore failed");
  });
});

describe("chatResubmitService — 'Continue without reverting'", () => {
  it("does NOT restore files, but still truncates and resubmits", async () => {
    dialogChoice = SvcMod.RESUBMIT_OPTION_KEEP;
    const svc: ChatResubmitService = new SvcMod.ChatResubmitService();
    const { hooks, calls, restored, truncated, resubmitted } = makeHooks();
    const ok = await svc.handleResubmit("b1", "edited text", hooks);
    assert.strictEqual(ok, true);
    assert.deepStrictEqual(restored, [], "keep-files option must never restore");
    assert.deepStrictEqual(truncated, ["b1"], "truncation ALWAYS happens on resubmit");
    assert.deepStrictEqual(resubmitted, ["edited text"]);
    assert.deepStrictEqual(calls, ["truncate", "resubmit"]);
  });
});

describe("chatResubmitService — cancel / dismiss", () => {
  it("Cancel does nothing: no restore, no truncate, no resubmit", async () => {
    dialogChoice = SvcMod.RESUBMIT_OPTION_CANCEL;
    const svc: ChatResubmitService = new SvcMod.ChatResubmitService();
    const { hooks, calls } = makeHooks();
    const ok = await svc.handleResubmit("b1", "edited text", hooks);
    assert.strictEqual(ok, false);
    assert.deepStrictEqual(calls, []);
  });

  it("dismissing the dialog (Esc) is treated as cancel", async () => {
    dialogChoice = undefined;
    const svc: ChatResubmitService = new SvcMod.ChatResubmitService();
    const { hooks, calls } = makeHooks();
    const ok = await svc.handleResubmit("b1", "edited text", hooks);
    assert.strictEqual(ok, false);
    assert.deepStrictEqual(calls, []);
  });
});

describe("chatResubmitService — truncation is unconditional", () => {
  it("truncateFrom runs for BOTH options (history truncation always happens on resubmit)", async () => {
    const svc: ChatResubmitService = new SvcMod.ChatResubmitService();
    for (const choice of [SvcMod.RESUBMIT_OPTION_REVERT, SvcMod.RESUBMIT_OPTION_KEEP]) {
      dialogChoice = choice;
      const { hooks, truncated } = makeHooks();
      const ok = await svc.handleResubmit("b1", "t", hooks);
      assert.strictEqual(ok, true, `choice ${choice}`);
      assert.deepStrictEqual(truncated, ["b1"], `truncation must happen for "${choice}"`);
    }
  });
});

describe("chatResubmitService — promptResubmitChoice mapping", () => {
  it("maps each dialog outcome to the right choice", async () => {
    const svc: ChatResubmitService = new SvcMod.ChatResubmitService();
    const cases: Array<[string | undefined, string]> = [
      [SvcMod.RESUBMIT_OPTION_REVERT, "revert"],
      [SvcMod.RESUBMIT_OPTION_KEEP, "keep"],
      [SvcMod.RESUBMIT_OPTION_CANCEL, "cancel"],
      [undefined, "cancel"],
      ["Some other string", "cancel"],
    ];
    for (const [dialog, expected] of cases) {
      dialogChoice = dialog;
      assert.strictEqual(await svc.promptResubmitChoice(), expected, `dialog=${dialog}`);
    }
  });
});
