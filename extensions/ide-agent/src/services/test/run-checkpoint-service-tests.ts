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

function makeUri(fsPath: string) {
  return {
    fsPath,
    scheme: "file",
    toString: () => fsPath,
  };
}

const vscodeStub: any = {
  workspace: {
    get workspaceFolders() {
      return ROOT ? [{ uri: makeUri(ROOT), name: "test", index: 0 }] : undefined;
    },
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
    showWarningMessage: () => {},
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
