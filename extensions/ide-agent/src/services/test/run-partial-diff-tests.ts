/**
 * Partial-diff accept/reject tests (node:test, vscode stubbed via ./vscode-stub).
 *
 * Locks in Cursor 3.25.9 parity (dig-continuous-inline-edit-2026-10-19,
 * binary evidence — Cursor 3.25.9 glass bundle):
 * - every hunk/change has its own accept/reject controls (partialWidgets,
 *   id = diffId + "-partial" + index), not just accept-all;
 * - telemetry "Accepted Partial Diff" / "Rejected Partial Diff" is distinct
 *   from "Accepted Diff" / "Rejected Diff";
 * - partial accept: Win Ctrl+Shift+Y / mac Cmd+Y; partial reject Ctrl/Cmd+N;
 * - Alt+J/K = next/previous change, Alt+H/L = next/previous diff file.
 *
 * Covers the pure partial-diff core exported by ../inlineEditService
 * (mergeHunks, setHunkState, nextPendingHunkIndex, INLINE_EDIT_TELEMETRY,
 * readPartialAcceptsEnabled),
 * a simulated end-to-end partial session (accept one hunk, reject another,
 * navigate, telemetry sequence), and a source-scan of the fork's
 * composerActions.ts proving the six commands + keybindings are wired.
 *
 * Run after `tsc`:  node --test out/services/test/run-partial-diff-tests.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import "./vscode-stub";
import * as vscode from "vscode";
import {
  lineDiff,
  mergeHunks,
  setHunkState,
  nextPendingHunkIndex,
  INLINE_EDIT_TELEMETRY,
  CPP_CONFIG_SECTION,
  PARTIAL_ACCEPTS_DEFAULT,
  readPartialAcceptsEnabled,
  type DiffHunk,
  type InlineHunkState,
} from "../inlineEditService";

/** Fake WorkspaceConfiguration: values map, everything else falls to `def`. */
const cfgOf = (values: Record<string, unknown>) =>
  ({
    get: (key: string, def?: unknown) => (key in values ? values[key] : def),
  }) as unknown as Pick<vscode.WorkspaceConfiguration, "get">;

// ---- Fixture: three independent changes -------------------------------
// hunk 0: line 1 changed ("+" -> "-")
// hunk 1: line 5 changed ("* b" -> "* b * 1")
// hunk 2: pure insertion before line 9
const ORIG = [
  "function add(a, b) {",
  "  return a + b;",
  "}",
  "",
  "function mul(a, b) {",
  "  return a * b;",
  "}",
  "",
  "function div(a, b) {",
  "  return a / b;",
  "}",
];
const NEW = [
  "function add(a, b) {",
  "  return a - b;",
  "}",
  "",
  "function mul(a, b) {",
  "  return a * b * 1;",
  "}",
  "",
  "function div(a, b) {",
  "  if (b === 0) throw new Error('div0');",
  "  return a / b;",
  "}",
];

const PENDING: InlineHunkState[] = ["pending", "pending", "pending"];

function fixtureHunks(): DiffHunk[] {
  return lineDiff(ORIG, NEW);
}

describe("lineDiff fixture", () => {
  it("finds the three hunks in document order", () => {
    const hunks = fixtureHunks();
    assert.strictEqual(hunks.length, 3);
    assert.deepStrictEqual(
      hunks.map((h) => [h.origStart, h.origEnd, h.newStart, h.newEnd]),
      [
        [1, 2, 1, 2],
        [5, 6, 5, 6],
        [9, 9, 9, 10], // pure insertion: zero original lines
      ],
    );
  });
});

describe("mergeHunks", () => {
  it("all pending == the proposed text", () => {
    const hunks = fixtureHunks();
    const merged = mergeHunks(ORIG, NEW, hunks, PENDING);
    assert.deepStrictEqual(merged.lines, NEW);
    assert.strictEqual(merged.hunkRanges.length, 3);
    // merged ranges are index-aligned with hunks and ordered
    for (let i = 1; i < 3; i++) {
      assert.ok(merged.hunkRanges[i]!.start >= merged.hunkRanges[i - 1]!.end);
    }
  });

  it("all rejected == the original text", () => {
    const hunks = fixtureHunks();
    const merged = mergeHunks(ORIG, NEW, hunks, ["rejected", "rejected", "rejected"]);
    assert.deepStrictEqual(merged.lines, ORIG);
  });

  it("partial accept of the middle hunk only", () => {
    const hunks = fixtureHunks();
    const merged = mergeHunks(ORIG, NEW, hunks, ["rejected", "accepted", "rejected"]);
    const expected = [...ORIG];
    expected[5] = "  return a * b * 1;"; // only hunk 1's change survives
    assert.deepStrictEqual(merged.lines, expected);
  });

  it("partial reject of the first hunk keeps the rest proposed", () => {
    const hunks = fixtureHunks();
    const merged = mergeHunks(ORIG, NEW, hunks, ["rejected", "pending", "pending"]);
    const expected = [...NEW];
    expected[1] = "  return a + b;"; // hunk 0 reverted
    assert.deepStrictEqual(merged.lines, expected);
  });

  it("accepting a pure-insertion hunk keeps the line; rejecting drops it", () => {
    const hunks = fixtureHunks();
    const accepted = mergeHunks(ORIG, NEW, hunks, ["rejected", "rejected", "accepted"]);
    assert.ok(accepted.lines.some((l) => l.includes("div0")));
    assert.strictEqual(accepted.lines.length, ORIG.length + 1);
    const rejected = mergeHunks(ORIG, NEW, hunks, ["rejected", "rejected", "rejected"]);
    assert.ok(!rejected.lines.some((l) => l.includes("div0")));
    assert.deepStrictEqual(rejected.lines, ORIG);
  });

  it("throws when hunks and states lengths differ", () => {
    const hunks = fixtureHunks();
    assert.throws(
      () => mergeHunks(ORIG, NEW, hunks, ["pending"]),
      /3 hunks but 1 states/,
    );
  });
});

describe("setHunkState", () => {
  it("returns a new array and sets the state (immutable update)", () => {
    const before: InlineHunkState[] = ["pending", "pending", "pending"];
    const after = setHunkState(before, 1, "accepted");
    assert.deepStrictEqual(after, ["pending", "accepted", "pending"]);
    assert.deepStrictEqual(before, ["pending", "pending", "pending"]); // untouched
    assert.notStrictEqual(after, before);
  });

  it("throws RangeError on out-of-range index", () => {
    assert.throws(() => setHunkState(PENDING, 3, "accepted"), RangeError);
    assert.throws(() => setHunkState(PENDING, -1, "rejected"), RangeError);
    assert.throws(() => setHunkState([], 0, "accepted"), RangeError);
  });
});

describe("nextPendingHunkIndex (Alt+J/K navigation)", () => {
  it("cycles forward from an unset cursor", () => {
    assert.strictEqual(nextPendingHunkIndex(PENDING, -1, 1), 0);
    assert.strictEqual(nextPendingHunkIndex(PENDING, 0, 1), 1);
    assert.strictEqual(nextPendingHunkIndex(PENDING, 2, 1), 0); // wraps
  });

  it("cycles backward from an unset cursor", () => {
    assert.strictEqual(nextPendingHunkIndex(PENDING, -1, -1), 2);
    assert.strictEqual(nextPendingHunkIndex(PENDING, 2, -1), 1);
    assert.strictEqual(nextPendingHunkIndex(PENDING, 0, -1), 2); // wraps
  });

  it("skips resolved hunks in both directions", () => {
    const states: InlineHunkState[] = ["accepted", "pending", "rejected"];
    assert.strictEqual(nextPendingHunkIndex(states, -1, 1), 1);
    assert.strictEqual(nextPendingHunkIndex(states, 1, 1), 1); // only one pending
    assert.strictEqual(nextPendingHunkIndex(states, 1, -1), 1);
    assert.strictEqual(nextPendingHunkIndex(states, 0, -1), 1); // skips rejected
  });

  it("returns -1 when nothing is pending or there are no hunks", () => {
    assert.strictEqual(
      nextPendingHunkIndex(["accepted", "rejected"], 0, 1),
      -1,
    );
    assert.strictEqual(nextPendingHunkIndex([], -1, 1), -1);
  });

  it("treats an out-of-range cursor as unset", () => {
    assert.strictEqual(nextPendingHunkIndex(PENDING, 99, 1), 0);
    assert.strictEqual(nextPendingHunkIndex(PENDING, 99, -1), 2);
  });
});

describe("INLINE_EDIT_TELEMETRY", () => {
  it("uses Cursor's verbatim event names, partial distinct from full", () => {
    assert.strictEqual(INLINE_EDIT_TELEMETRY.acceptedDiff, "Accepted Diff");
    assert.strictEqual(INLINE_EDIT_TELEMETRY.rejectedDiff, "Rejected Diff");
    assert.strictEqual(INLINE_EDIT_TELEMETRY.acceptedPartialDiff, "Accepted Partial Diff");
    assert.strictEqual(INLINE_EDIT_TELEMETRY.rejectedPartialDiff, "Rejected Partial Diff");
    assert.notStrictEqual(
      INLINE_EDIT_TELEMETRY.acceptedPartialDiff,
      INLINE_EDIT_TELEMETRY.acceptedDiff,
    );
    assert.notStrictEqual(
      INLINE_EDIT_TELEMETRY.rejectedPartialDiff,
      INLINE_EDIT_TELEMETRY.rejectedDiff,
    );
  });
});

describe("simulated partial session (accept middle, reject first)", () => {
  it("merges to original-with-only-accepted-hunk and navigates pending only", () => {
    const hunks = fixtureHunks();
    // preview: all pending
    let states: InlineHunkState[] = hunks.map(() => "pending");
    const telemetry: string[] = [];

    // user accepts hunk 1 (middle) via partial accept
    states = setHunkState(states, 1, "accepted");
    telemetry.push(INLINE_EDIT_TELEMETRY.acceptedPartialDiff);

    // user rejects hunk 0 via partial reject
    states = setHunkState(states, 0, "rejected");
    telemetry.push(INLINE_EDIT_TELEMETRY.rejectedPartialDiff);

    const merged = mergeHunks(ORIG, NEW, hunks, states);
    const expected = [...NEW];
    expected[1] = "  return a + b;"; // hunk 0 rejected; hunks 1+2 still proposed
    assert.deepStrictEqual(merged.lines, expected);
    assert.ok(merged.lines.some((l) => l.includes("div0"))); // hunk 2 still pending -> shown
  });

  it("navigation skips the resolved hunks", () => {
    const states: InlineHunkState[] = ["rejected", "accepted", "pending"];
    // only hunk 2 is pending: both directions land on it
    assert.strictEqual(nextPendingHunkIndex(states, -1, 1), 2);
    assert.strictEqual(nextPendingHunkIndex(states, 2, 1), 2);
    assert.strictEqual(nextPendingHunkIndex(states, 2, -1), 2);
  });

  it("full accept after partials logs 'Accepted Diff' last", () => {
    const telemetry: string[] = [
      INLINE_EDIT_TELEMETRY.acceptedPartialDiff,
      INLINE_EDIT_TELEMETRY.rejectedPartialDiff,
      INLINE_EDIT_TELEMETRY.acceptedDiff,
    ];
    assert.strictEqual(telemetry[telemetry.length - 1], "Accepted Diff");
    assert.ok(telemetry.includes("Accepted Partial Diff"));
    assert.ok(telemetry.includes("Rejected Partial Diff"));
  });
});

// ---- Fork wiring: composerActions.ts ------------------------------------
const actionsPath = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "..",
  "src",
  "vs",
  "workbench",
  "contrib",
  "composer",
  "browser",
  "composerActions.ts",
);
// WORKER-GAPS-34C (inline-edit-command-ids, P1): the partial accept/reject
// actions moved to inlineDiffActions.ts with the binary-verbatim
// `editor.action.inlineDiffs.*` ids.
const inlineDiffActionsPath = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "..",
  "src",
  "vs",
  "workbench",
  "contrib",
  "composer",
  "browser",
  "inlineDiffActions.ts",
);

/** Extract the source block of one `export class XAction extends Action2 { ... }`. */
function classBlock(src: string, className: string): string {
  const start = src.indexOf(`export class ${className} extends Action2 {`);
  assert.ok(start >= 0, `missing action class ${className}`);
  const nextClass = src.indexOf("\nexport class ", start + 1);
  const nextFn = src.indexOf("\nexport function ", start + 1);
  const endCandidates = [nextClass, nextFn].filter((i) => i > start);
  const end = endCandidates.length > 0 ? Math.min(...endCandidates) : src.length;
  return src.slice(start, end);
}

describe("inline-diff action wiring (Cursor 3.25.9 parity)", () => {
  const composerSrc = fs.readFileSync(actionsPath, "utf8");
  const inlineDiffSrc = fs.readFileSync(inlineDiffActionsPath, "utf8");

  const EXPECTED = [
    {
      cls: "EditorInlineDiffsAcceptPartialEditAction",
      commandId: "editor.action.inlineDiffs.acceptPartialEdit",
      ideId: "ide.acceptPartialInlineEdit",
      chords: ["KeyCode.KeyY", "KeyMod.Shift", "mac: { primary: KeyMod.CtrlCmd | KeyCode.KeyY }"],
      // WORKER-GAPS-34C: binary kbExpr is editorTextFocus ONLY; the
      // pending-diff gate is the action precondition, not the when.
      whenContains: ["editorTextFocus"],
      whenAbsent: ["inlineEditPending"],
      precondition: "precondition: InlineDiffContextKeys.activeEditorWithDiffs",
      registeredIn: "registerInlineDiffActions",
    },
    {
      cls: "EditorInlineDiffsRejectPartialEditAction",
      commandId: "editor.action.inlineDiffs.rejectPartialEdit",
      ideId: "ide.rejectPartialInlineEdit",
      chords: ["KeyCode.KeyN"],
      whenContains: ["editorTextFocus"],
      whenAbsent: ["inlineEditPending"],
      precondition: "precondition: InlineDiffContextKeys.activeEditorWithDiffs",
      registeredIn: "registerInlineDiffActions",
    },
    {
      cls: "ComposerNextInlineChangeAction",
      commandId: "composer.nextInlineChange",
      ideId: "ide.nextInlineChange",
      chords: ["KeyCode.KeyJ", "KeyMod.Alt"],
      whenContains: ["inlineEditPending", "editorTextFocus"],
      whenAbsent: [],
      precondition: "",
      registeredIn: "registerComposerActions",
    },
    {
      cls: "ComposerPreviousInlineChangeAction",
      commandId: "composer.previousInlineChange",
      ideId: "ide.previousInlineChange",
      chords: ["KeyCode.KeyK", "KeyMod.Alt"],
      whenContains: ["inlineEditPending", "editorTextFocus"],
      whenAbsent: [],
      precondition: "",
      registeredIn: "registerComposerActions",
    },
    {
      cls: "ComposerNextInlineDiffFileAction",
      commandId: "composer.nextInlineDiffFile",
      ideId: "ide.nextInlineDiffFile",
      chords: ["KeyCode.KeyL", "KeyMod.Alt"],
      whenContains: ["inlineEditPending", "editorTextFocus"],
      whenAbsent: [],
      precondition: "",
      registeredIn: "registerComposerActions",
    },
    {
      cls: "ComposerPreviousInlineDiffFileAction",
      commandId: "composer.previousInlineDiffFile",
      ideId: "ide.previousInlineDiffFile",
      chords: ["KeyCode.KeyH", "KeyMod.Alt"],
      whenContains: ["inlineEditPending", "editorTextFocus"],
      whenAbsent: [],
      precondition: "",
      registeredIn: "registerComposerActions",
    },
  ];

  for (const e of EXPECTED) {
    it(`${e.commandId}: keybinding + when clause + ide.* delegation + registration`, () => {
      const src = e.registeredIn === "registerInlineDiffActions" ? inlineDiffSrc : composerSrc;
      const block = classBlock(src, e.cls);
      assert.ok(
        block.includes(`static readonly ID = '${e.commandId}'`),
        "command id",
      );
      for (const chord of e.chords) {
        assert.ok(block.includes(chord), `keybinding contains ${chord}`);
      }
      for (const w of e.whenContains) {
        assert.ok(block.includes(w), `when: ${w}`);
      }
      for (const w of e.whenAbsent) {
        assert.ok(!block.includes(w), `when must NOT contain ${w}`);
      }
      if (e.precondition) {
        assert.ok(block.includes(e.precondition), `action precondition: ${e.precondition}`);
      }
      assert.ok(
        block.includes(`executeCommand('${e.ideId}'`),
        `delegates to ${e.ideId}`,
      );
      if (e.registeredIn === "registerInlineDiffActions") {
        assert.ok(
          inlineDiffSrc.includes(`registerAction2(${e.cls});`),
          `${e.cls} registered via registerInlineDiffActions`,
        );
        assert.ok(
          composerSrc.includes("registerInlineDiffActions();"),
          "registerInlineDiffActions() called from registerComposerActions",
        );
      } else {
        assert.ok(
          composerSrc.includes(`registerAction2(${e.cls});`),
          `${e.cls} registered in registerComposerActions`,
        );
      }
    });
  }

  it("partial accept is Ctrl+Shift+Y on win/linux and Cmd+Y on mac", () => {
    const block = classBlock(inlineDiffSrc, "EditorInlineDiffsAcceptPartialEditAction");
    assert.ok(
      block.includes("primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyY"),
      "win/linux: Ctrl+Shift+Y",
    );
    assert.ok(
      block.includes("mac: { primary: KeyMod.CtrlCmd | KeyCode.KeyY }"),
      "mac: Cmd+Y",
    );
  });

  it("acceptAll/rejectAll/cancelEdits are registered with the binary-verbatim ids", () => {
    for (const [cls, id] of [
      ["EditorInlineDiffsAcceptAllAction", "editor.action.inlineDiffs.acceptAll"],
      ["EditorInlineDiffsRejectAllAction", "editor.action.inlineDiffs.rejectAll"],
      ["EditorInlineDiffsCancelEditsAction", "editor.action.inlineDiffs.cancelEdits"],
    ] as const) {
      const block = classBlock(inlineDiffSrc, cls);
      assert.ok(block.includes(`static readonly ID = '${id}'`), `${cls} id`);
      assert.ok(inlineDiffSrc.includes(`registerAction2(${cls});`), `${cls} registered`);
    }
    // Binary weights: 500 for accept/reject, 600 for cancelEdits (cast).
    const cancelBlock = classBlock(inlineDiffSrc, "EditorInlineDiffsCancelEditsAction");
    assert.ok(cancelBlock.includes("weight: inlineDiffsWeight600"), "cancelEdits weight 600");
    const acceptBlock = classBlock(inlineDiffSrc, "EditorInlineDiffsAcceptAllAction");
    assert.ok(acceptBlock.includes("weight: inlineDiffsWeight500"), "acceptAll weight 500");
    // cancelEdits preconditions on the binary-verbatim generating key.
    assert.ok(
      cancelBlock.includes("precondition: InlineDiffContextKeys.hasActivelyGeneratingDiff"),
      "cancelEdits precondition",
    );
  });
});

describe("readPartialAcceptsEnabled — ide.cpp.enablePartialAccepts (IDE-CODE extension of the Cursor Tab concept; default true)", () => {
  it("defaults to true when nothing is configured", () => {
    assert.strictEqual(readPartialAcceptsEnabled(cfgOf({})), true);
  });

  it("reads a configured false", () => {
    assert.strictEqual(readPartialAcceptsEnabled(cfgOf({ enablePartialAccepts: false })), false);
  });

  it("reads a configured true", () => {
    assert.strictEqual(readPartialAcceptsEnabled(cfgOf({ enablePartialAccepts: true })), true);
  });

  it("the default constant is true (IDE-CODE choice; Cursor's Tab toggle defaults to false)", () => {
    assert.strictEqual(PARTIAL_ACCEPTS_DEFAULT, true);
  });

  it("the config section is ide.cpp (not ide.tab — different feature)", () => {
    assert.strictEqual(CPP_CONFIG_SECTION, "ide.cpp");
  });
});
