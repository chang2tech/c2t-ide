/**
 * CheckpointService integration tests (node:test, zero extra deps).
 *
 * Exercises the REAL CheckpointService against a temp directory, with a
 * minimal `vscode` module stub (workspace.fs, Uri, workspaceFolders,
 * createFileSystemWatcher). Covers the full Cursor-style lifecycle:
 * captureBefore → noteToolCall (pending, pre-edit) → edit → captureAfter →
 * checkoutToCheckpoint (revert + delete created files + remove created
 * folders) → idempotent second restore (isSame).
 *
 * Run after `tsc`:  node out/services/test/run-checkpoint-service-tests.js
 */
import { describe, it, before, after } from "node:test";
import * as assert from "node:assert";
import * as path from "node:path";
import * as os from "node:os";
import { promises as fsp } from "node:fs";
import { Module } from "node:module";
import { ToolCallViewModel } from "../../model";

/* ---------- minimal vscode stub ---------- */
let ROOT = "";

/** Records of the restore confirmation dialog for assertions (Cursor parity). */
const dialogCalls: Array<{ message: string; options: any; items: string[] }> = [];
/** What the user "clicks" in the confirmation dialog ("Continue" | "Cancel" | "Don't ask again" | undefined=dismiss). */
let dialogChoice: string | undefined = "Continue";
/** In-memory stand-in for the `ide.agent` workspace configuration. */
const configValues = new Map<string, unknown>();

function makeUri(fsPath: string) {
  return {
    fsPath,
    scheme: "file",
    toString: () => fsPath,
  };
}

const vscodeStub: any = {
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  workspace: {
    get workspaceFolders() {
      return ROOT ? [{ uri: makeUri(ROOT), name: "test", index: 0 }] : undefined;
    },
    getConfiguration: (section?: string) => ({
      get: (key: string, def?: unknown) => {
        const full = section ? `${section}.${key}` : key;
        return configValues.has(full) ? configValues.get(full) : def;
      },
      update: async (key: string, value: unknown) => {
        const full = section ? `${section}.${key}` : key;
        configValues.set(full, value);
      },
    }),
    fs: {
      readFile: (uri: any) => fsp.readFile(uri.fsPath),
      writeFile: async (uri: any, content: Uint8Array) => {
        await fsp.mkdir(path.dirname(uri.fsPath), { recursive: true });
        await fsp.writeFile(uri.fsPath, content);
      },
      delete: (uri: any, opts?: any) =>
        fsp.rm(uri.fsPath, { recursive: !!(opts && opts.recursive), force: true }),
      createDirectory: (uri: any) => fsp.mkdir(uri.fsPath, { recursive: true }),
    },
    createFileSystemWatcher: () => ({
      onDidChange: () => {},
      onDidCreate: () => {},
      dispose: () => {},
    }),
  },
  Uri: {
    file: (p: string) => makeUri(p),
    joinPath: (base: any, ...parts: string[]) => makeUri(path.join(base.fsPath, ...parts)),
  },
  window: {
    showWarningMessage: (message: string, options?: any, ...items: string[]) => {
      dialogCalls.push({ message, options, items });
      return Promise.resolve(dialogChoice);
    },
    showInformationMessage: () => {},
    showErrorMessage: () => {},
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
const { CheckpointService } = require("../checkpointService");

function toolCall(filePath: string, kind = "edit_tool_call"): ToolCallViewModel {
  return {
    toolCallId: `tc-${Math.random().toString(36).slice(2)}`,
    kind,
    title: kind,
    status: "pending",
    description: "",
    outputPreview: "",
    expanded: false,
    filePath,
  };
}

describe("CheckpointService end-to-end", () => {
  let dir = "";
  let svc: any;

  before(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ckpt-svc-test-"));
    ROOT = dir;
    // The restore confirmation dialog (Cursor parity): existing tests choose
    // "Continue" so the restore proceeds as before the dialog existed.
    dialogChoice = "Continue";
    const context: any = {
      globalStorageUri: makeUri(path.join(dir, ".storage")),
      subscriptions: [],
    };
    svc = new CheckpointService(context);
  });

  after(async () => {
    svc?.dispose();
    await fsp.rm(dir, { recursive: true, force: true });
    ROOT = "";
  });

  it("full lifecycle: edit reverted, created file + folder removed, second restore isSame", async () => {
    const a = path.join(dir, "a.ts");
    const b = path.join(dir, "b.ts");
    await fsp.writeFile(a, "v1");
    await fsp.writeFile(b, "keep");

    // 1. "before" checkpoint on user send.
    await svc.captureBefore("bubble-1", "first message");

    // 2. Agent turn: pending toolCall events arrive BEFORE the tools run.
    await svc.noteToolCall(toolCall(a)); // edit a.ts → pre-edit snapshot "v1"
    const c = path.join(dir, "c.ts");
    await svc.noteToolCall(toolCall(c)); // write c.ts → marked newly created
    const deep = path.join(dir, "newdir", "sub", "d.ts");
    await svc.noteToolCall(toolCall(deep)); // parents don't exist → folders tracked

    // 3. The tools run.
    await fsp.writeFile(a, "v2");
    await fsp.writeFile(c, "brand new");
    await fsp.mkdir(path.dirname(deep), { recursive: true });
    await fsp.writeFile(deep, "deep file");

    // 4. "after" checkpoint on generation end.
    await svc.captureAfter("bubble-1", "after: first message");

    // 5. Restore to the "before" checkpoint.
    const r1 = await svc.checkoutToCheckpoint("bubble-1");
    assert.strictEqual(r1.isSame, false);
    assert.strictEqual(await fsp.readFile(a, "utf8"), "v1", "a.ts must be reverted");
    assert.strictEqual(await fsp.readFile(b, "utf8"), "keep", "b.ts untouched");
    await assert.rejects(fsp.stat(c), "c.ts (created during turn) must be deleted");
    await assert.rejects(fsp.stat(deep), "d.ts (created during turn) must be deleted");
    await assert.rejects(
      fsp.stat(path.join(dir, "newdir")),
      "newdir (created during turn) must be removed",
    );

    // 6. Restoring again is a no-op.
    const r2 = await svc.checkoutToCheckpoint("bubble-1");
    assert.strictEqual(r2.isSame, true);
    assert.deepStrictEqual(r2.reverted, []);
    assert.deepStrictEqual(r2.deleted, []);
  });

  it("files created during the target turn are deleted even when a later turn exists", async () => {
    const x = path.join(dir, "x.ts");
    await fsp.writeFile(x, "orig");

    await svc.captureBefore("bubble-A", "A");
    const created = path.join(dir, "created-by-A.ts");
    await svc.noteToolCall(toolCall(created)); // pending → newly created
    await fsp.writeFile(created, "hello");
    await svc.captureAfter("bubble-A", "after A");

    await svc.captureBefore("bubble-B", "B");
    await svc.noteToolCall(toolCall(x)); // pending → snapshot "orig"
    await fsp.writeFile(x, "modified by B");
    await svc.captureAfter("bubble-B", "after B");

    // Restore to A: x.ts back to "orig", created-by-A.ts gone.
    const r = await svc.checkoutToCheckpoint("bubble-A");
    assert.strictEqual(r.isSame, false);
    assert.strictEqual(await fsp.readFile(x, "utf8"), "orig");
    await assert.rejects(fsp.stat(created), "file created during target turn must be deleted");
  });

  it("unknown bubble id restores nothing", async () => {
    const r = await svc.checkoutToCheckpoint("no-such-bubble");
    assert.strictEqual(r.isSame, false);
    assert.deepStrictEqual(r.reverted, []);
    assert.deepStrictEqual(r.deleted, []);
  });
});

/* ---------- restore confirmation dialog (Cursor parity) ---------- */

describe("CheckpointService restore confirmation dialog", () => {
  let dir = "";
  let svc: any;

  const TITLE = "Discard all changes up to this checkpoint?";
  const BODY = "You can always undo this later.";
  const NOTEBOOK_NOTE = "\nNote: Notebook cells are not supported for reverting.";

  before(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ckpt-dlg-test-"));
    ROOT = dir;
    const context: any = {
      globalStorageUri: makeUri(path.join(dir, ".storage")),
      subscriptions: [],
    };
    svc = new CheckpointService(context);
  });

  after(async () => {
    svc?.dispose();
    await fsp.rm(dir, { recursive: true, force: true });
    ROOT = "";
  });

  function resetDialog() {
    dialogCalls.length = 0;
    dialogChoice = "Continue";
    configValues.clear();
  }

  /** Set up: before-checkpoint → agent edits file → after-checkpoint. */
  async function makeRestorable(bubbleId: string, filePath: string, before: string, after: string) {
    await fsp.writeFile(filePath, before);
    await svc.captureBefore(bubbleId, "dlg test");
    await svc.noteToolCall(toolCall(filePath));
    await fsp.writeFile(filePath, after);
    await svc.captureAfter(bubbleId, "after dlg test");
  }

  it("shows the Cursor-verbatim dialog, modal, with Continue as the first button", async () => {
    resetDialog();
    const f = path.join(dir, "dlg.ts");
    await makeRestorable("bubble-dlg-1", f, "v1", "v2");

    const r = await svc.checkoutToCheckpoint("bubble-dlg-1");
    assert.strictEqual(r.isSame, false);
    assert.strictEqual(await fsp.readFile(f, "utf8"), "v1");

    assert.strictEqual(dialogCalls.length, 1);
    const call = dialogCalls[0];
    assert.strictEqual(call.message, `${TITLE}\n\n${BODY}`);
    assert.deepStrictEqual(call.options, { modal: true });
    // Continue is primary (first), then Cancel, then the don't-ask-again
    // approximation (VS Code has no native checkbox).
    assert.deepStrictEqual(call.items, ["Continue", "Cancel", "Don't ask again"]);
  });

  it("Cancel aborts the restore — no files are reverted", async () => {
    resetDialog();
    dialogChoice = "Cancel";
    const f = path.join(dir, "dlg-cancel.ts");
    await makeRestorable("bubble-dlg-2", f, "before", "after");

    const r = await svc.checkoutToCheckpoint("bubble-dlg-2");
    assert.strictEqual(r.cancelled, true);
    assert.deepStrictEqual(r.reverted, []);
    assert.deepStrictEqual(r.deleted, []);
    assert.strictEqual(
      await fsp.readFile(f, "utf8"),
      "after",
      "file must NOT be reverted when the user cancels",
    );
  });

  it("dismissing the dialog (undefined choice) aborts the restore too", async () => {
    resetDialog();
    dialogChoice = undefined; // user pressed Esc / closed the dialog
    const f = path.join(dir, "dlg-dismiss.ts");
    await makeRestorable("bubble-dlg-3", f, "before", "after");

    const r = await svc.checkoutToCheckpoint("bubble-dlg-3");
    assert.strictEqual(r.cancelled, true);
    assert.strictEqual(await fsp.readFile(f, "utf8"), "after");
  });

  it("\"Don't ask again\" proceeds, persists the skip preference, and skips future dialogs", async () => {
    resetDialog();
    dialogChoice = "Don't ask again";
    const f = path.join(dir, "dlg-noask.ts");
    await makeRestorable("bubble-dlg-4", f, "v1", "v2");

    const r1 = await svc.checkoutToCheckpoint("bubble-dlg-4");
    assert.strictEqual(r1.cancelled, undefined);
    assert.strictEqual(await fsp.readFile(f, "utf8"), "v1", "restore must proceed");
    assert.strictEqual(
      configValues.get("ide.agent.composer-checkout-to-message"),
      true,
      "preference must be persisted under the Cursor dialogKey",
    );

    // Second restore with real changes: dialog must be skipped entirely.
    await fsp.writeFile(f, "v2-again");
    dialogCalls.length = 0;
    dialogChoice = "Cancel"; // must have no effect — dialog is skipped
    const r2 = await svc.checkoutToCheckpoint("bubble-dlg-4");
    assert.strictEqual(dialogCalls.length, 0, "dialog must be skipped after don't-ask-again");
    assert.strictEqual(r2.cancelled, undefined);
    assert.strictEqual(await fsp.readFile(f, "utf8"), "v1", "restore still proceeds when skipped");
  });

  it("appends the notebook note when the revert set contains .ipynb files", async () => {
    resetDialog();
    const nb = path.join(dir, "analysis.ipynb");
    await makeRestorable("bubble-dlg-5", nb, '{"v":1}', '{"v":2}');

    const r = await svc.checkoutToCheckpoint("bubble-dlg-5");
    assert.strictEqual(r.isSame, false);
    assert.strictEqual(dialogCalls.length, 1);
    assert.strictEqual(dialogCalls[0].message, `${TITLE}\n\n${BODY}${NOTEBOOK_NOTE}`);
  });

  it("no notebook note when the revert set has no notebooks", async () => {
    resetDialog();
    const f = path.join(dir, "plain.ts");
    await makeRestorable("bubble-dlg-6", f, "a", "b");

    await svc.checkoutToCheckpoint("bubble-dlg-6");
    assert.strictEqual(dialogCalls.length, 1);
    assert.strictEqual(dialogCalls[0].message, `${TITLE}\n\n${BODY}`);
    assert.ok(!dialogCalls[0].message.includes("Notebook"));
  });
});

/* ---------- diff-based snapshots (Cursor parity: originalModelDiffWrtV0) ---------- */

describe("CheckpointService diff-based snapshots", () => {
  let dir = "";
  let svc: any;

  function makeService(storageSubdir: string): any {
    const context: any = {
      globalStorageUri: makeUri(path.join(dir, storageSubdir)),
      subscriptions: [],
    };
    return new CheckpointService(context);
  }

  before(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ckpt-diff-test-"));
    ROOT = dir;
    dialogChoice = "Continue";
    svc = makeService(".storage");
  });

  after(async () => {
    svc?.dispose();
    await fsp.rm(dir, { recursive: true, force: true });
    ROOT = "";
  });

  it("new captures write originalModelDiffWrtV0 (no full-file contents)", async () => {
    const f = path.join(dir, "fmt.ts");
    await fsp.writeFile(f, "line1\nline2\nline3\n");
    await svc.captureBefore("bubble-fmt-1", "fmt");
    await svc.noteToolCall(toolCall(f)); // pre-edit snapshot

    const rec = svc.list().find((r: any) => r.bubbleId === "bubble-fmt-1" && !r.isAfter);
    assert.ok(rec, "before-record must exist");
    const snap = rec.files.find((s: any) => s.uri === f);
    assert.ok(snap, "snapshot must exist");
    assert.ok(snap.originalModelDiffWrtV0, "diff must be stored");
    assert.strictEqual(snap.contents, undefined, "legacy contents must NOT be written");
    assert.ok(
      /^[0-9a-f]{40}$/.test(snap.originalModelDiffWrtV0.baseHash),
      "diff must carry a sha1 base hash",
    );
  });

  it("full lifecycle with diff snapshots: edit reverted exactly", async () => {
    const f = path.join(dir, "lifecycle.ts");
    const before = "const a = 1;\nconst b = 2;\nconsole.log(a + b);\n";
    await fsp.writeFile(f, before);

    await svc.captureBefore("bubble-life-1", "life");
    await svc.noteToolCall(toolCall(f)); // pre-edit snapshot -> diff vs v0
    // Agent edit: modify + insert lines (shifts line numbers).
    await fsp.writeFile(
      f,
      "const a = 100;\n// inserted comment\nconst b = 2;\nconsole.log(a + b);\n",
    );
    await svc.captureAfter("bubble-life-1", "after life");

    const r = await svc.checkoutToCheckpoint("bubble-life-1");
    assert.strictEqual(r.isSame, false);
    assert.strictEqual(await fsp.readFile(f, "utf8"), before, "must be reverted exactly");
    assert.deepStrictEqual(r.reverted, [f]);

    // Second restore is a no-op.
    const r2 = await svc.checkoutToCheckpoint("bubble-life-1");
    assert.strictEqual(r2.isSame, true);
  });

  it("diff snapshots + base map survive a service reload (disk persistence)", async () => {
    const f = path.join(dir, "persist.ts");
    const before = "alpha\nbeta\ngamma\n";
    await fsp.writeFile(f, before);

    const svcA = makeService(".storage-reload");
    await svcA.captureBefore("bubble-reload-1", "reload");
    await svcA.noteToolCall(toolCall(f));
    await fsp.writeFile(f, "alpha\nBETA\nGAMMA\n");
    await svcA.captureAfter("bubble-reload-1", "after reload");
    svcA.dispose();

    // New instance over the same storage dir: records AND bases reload.
    const svcB = makeService(".storage-reload");
    dialogChoice = "Continue";
    const r = await svcB.checkoutToCheckpoint("bubble-reload-1");
    svcB.dispose();
    assert.strictEqual(r.isSame, false);
    assert.strictEqual(await fsp.readFile(f, "utf8"), before);
  });

  it("backward-compat: legacy full-file snapshots on disk are still restored", async () => {
    const f = path.join(dir, "legacy.ts");
    await fsp.writeFile(f, "current-content");

    // Hand-write a legacy-format checkpoint file (pre-diff format).
    const storageDir = path.join(dir, ".storage-legacy");
    await fsp.mkdir(storageDir, { recursive: true });
    const legacyRecord = {
      checkpointId: "ckpt-legacy-1",
      bubbleId: "bubble-legacy-1",
      createdAt: Date.now(),
      lastUpdatedAt: Date.now(),
      label: "legacy",
      isAfter: false,
      files: [{ uri: f, contents: "legacy-original" }],
      newlyCreatedFiles: [],
      newlyCreatedFolders: [],
      activeInlineDiffs: [],
    };
    await fsp.writeFile(
      path.join(storageDir, "checkpoints-default.json"),
      JSON.stringify({ records: [legacyRecord] }),
    );

    const svcLegacy = makeService(".storage-legacy");
    dialogChoice = "Continue";
    const r = await svcLegacy.checkoutToCheckpoint("bubble-legacy-1");
    svcLegacy.dispose();
    assert.strictEqual(r.isSame, false);
    assert.deepStrictEqual(r.reverted, [f]);
    assert.strictEqual(
      await fsp.readFile(f, "utf8"),
      "legacy-original",
      "legacy full-file snapshot must restore",
    );
  });

  it("mixed records: legacy + diff snapshots restore together", async () => {
    const fOld = path.join(dir, "mixed-old.ts");
    const fNew = path.join(dir, "mixed-new.ts");
    await fsp.writeFile(fOld, "old-current");
    await fsp.writeFile(fNew, "new-v1\n");

    const storageDir = path.join(dir, ".storage-mixed");
    await fsp.mkdir(storageDir, { recursive: true });
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { computeLineDiff } = require("../checkpointDiff");
    const baseNew = "new-v1\n";
    await fsp.writeFile(
      path.join(storageDir, "checkpoints-default.json"),
      JSON.stringify({
        records: [
          {
            checkpointId: "ckpt-mixed-1",
            bubbleId: "bubble-mixed-1",
            createdAt: Date.now(),
            lastUpdatedAt: Date.now(),
            label: "mixed",
            isAfter: false,
            files: [
              { uri: fOld, contents: "old-original" },
              { uri: fNew, originalModelDiffWrtV0: computeLineDiff(baseNew, baseNew) },
            ],
            newlyCreatedFiles: [],
            newlyCreatedFolders: [],
            activeInlineDiffs: [],
          },
        ],
        bases: { [fNew]: baseNew },
      }),
    );
    await fsp.writeFile(fNew, "new-v2-modified\n");

    const svcMixed = makeService(".storage-mixed");
    dialogChoice = "Continue";
    const r = await svcMixed.checkoutToCheckpoint("bubble-mixed-1");
    svcMixed.dispose();
    assert.strictEqual(r.isSame, false);
    assert.strictEqual(await fsp.readFile(fOld, "utf8"), "old-original");
    assert.strictEqual(await fsp.readFile(fNew, "utf8"), baseNew);
  });
});

/* ---------- per-record isNewlyCreated (Cursor record shape, OBSERVED) ---------- */

describe("CheckpointService per-record isNewlyCreated", () => {
  let dir = "";
  let svc: any;

  before(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ckpt-isnew-test-"));
    ROOT = dir;
    // The restore confirmation dialog (Cursor parity): choose "Continue" so
    // the restore proceeds.
    dialogChoice = "Continue";
    const context: any = {
      globalStorageUri: makeUri(path.join(dir, ".storage")),
      subscriptions: [],
    };
    svc = new CheckpointService(context);
  });

  after(async () => {
    svc?.dispose();
    await fsp.rm(dir, { recursive: true, force: true });
    ROOT = "";
  });

  it("snapshots a session-created file with isNewlyCreated: true; pre-existing files omit it", async () => {
    const created = path.join(dir, "g20-new.ts");
    const existing = path.join(dir, "g20-old.ts");
    await fsp.writeFile(existing, "old-v1");

    await svc.captureBefore("bubble-g20-1", "g20");
    await svc.noteToolCall(toolCall(existing)); // pre-edit snapshot
    await svc.noteToolCall(toolCall(created)); // pending, file absent → newly created
    await fsp.writeFile(existing, "old-v2");
    await fsp.writeFile(created, "brand new");
    await svc.captureAfter("bubble-g20-1", "after g20");

    const afterRec = svc
      .list()
      .find((r: any) => r.bubbleId === "bubble-g20-1" && r.isAfter);
    assert.ok(afterRec, "after-record must exist");
    const createdSnap = afterRec.files.find((s: any) => s.uri === created);
    assert.ok(createdSnap, "created file must be snapshotted by the capture loop");
    assert.strictEqual(
      createdSnap.isNewlyCreated,
      true,
      "session-created file must be flagged isNewlyCreated: true",
    );
    const existingSnap = afterRec.files.find((s: any) => s.uri === existing);
    assert.ok(existingSnap, "existing file must be snapshotted");
    assert.ok(
      !existingSnap.isNewlyCreated,
      "pre-existing file must NOT be flagged (field omitted/falsy)",
    );
    // Dual-format intact: new captures still write diffs, never full contents.
    assert.ok(createdSnap.originalModelDiffWrtV0, "diff format preserved");
    assert.strictEqual(createdSnap.contents, undefined, "legacy contents not written");
  });

  it("per-record flag alone drives deletion on restore (legacy list emptied)", async () => {
    const created = path.join(dir, "g20-flagonly.ts");
    const existing = path.join(dir, "g20-keep.ts");
    await fsp.writeFile(existing, "keep-v1");

    await svc.captureBefore("bubble-g20-2", "g20 flag");
    await svc.noteToolCall(toolCall(existing));
    await svc.noteToolCall(toolCall(created));
    await fsp.writeFile(existing, "keep-v2");
    await fsp.writeFile(created, "flagged");
    await svc.captureAfter("bubble-g20-2", "after g20 flag");

    // Simulate the Cursor record shape where only the per-record flag
    // survives: list() returns the live record objects, so clearing the
    // legacy list here mutates the service's own records.
    for (const r of svc.list()) {
      if (r.bubbleId === "bubble-g20-2") {
        r.newlyCreatedFiles.length = 0;
      }
    }
    const afterRec = svc
      .list()
      .find((r: any) => r.bubbleId === "bubble-g20-2" && r.isAfter);
    assert.strictEqual(
      afterRec.files.find((s: any) => s.uri === created)?.isNewlyCreated,
      true,
      "flag must survive on the record",
    );

    dialogChoice = "Continue";
    const r = await svc.checkoutToCheckpoint("bubble-g20-2");
    assert.strictEqual(r.isSame, false);
    assert.strictEqual(
      await fsp.readFile(existing, "utf8"),
      "keep-v1",
      "existing file must be reverted",
    );
    await assert.rejects(
      fsp.stat(created),
      "flagged file must be deleted via per-record isNewlyCreated",
    );
    assert.ok(r.deleted.includes(created), "deleted list must name the flagged file");
  });
});
