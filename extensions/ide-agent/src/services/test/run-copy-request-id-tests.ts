/**
 * copyRequestIdService tests (node:test, zero extra deps).
 *
 * Verifies the Copy Request ID commands (Cursor 3.25.6 parity:
 * 'composer.copyRequestId', 'composer.copyRequestIdFromPane',
 * 'composer.copyRequestIdFromEditor'):
 *  - all three command ids get registered;
 *  - the invoked command copies the resolver's id to the clipboard and shows
 *    a confirmation message;
 *  - the source argument tells the resolver where the command came from;
 *  - no request id -> no clipboard write, informative message instead;
 *  - dispose() disposes every registration.
 *
 * Run after `tsc`:  node out/services/test/run-copy-request-id-tests.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import {
  COPY_REQUEST_ID_COMMAND,
  COPY_REQUEST_ID_FROM_PANE_COMMAND,
  COPY_REQUEST_ID_FROM_EDITOR_COMMAND,
  registerCopyRequestIdCommands,
  copyCurrentTurnRequestId,
  type CopyRequestIdResolver,
  type CopyRequestIdSeam,
  type CopyRequestIdSource,
} from "../copyRequestIdService";

class StubSeam implements CopyRequestIdSeam {
  readonly handlers = new Map<string, (args?: unknown) => void | Promise<void>>();
  readonly disposed = new Set<string>();
  readonly clipboard: string[] = [];
  readonly messages: string[] = [];

  registerCommand(id: string, handler: (args?: unknown) => void | Promise<void>) {
    this.handlers.set(id, handler);
    return {
      dispose: () => {
        this.disposed.add(id);
      },
    };
  }

  async writeClipboardText(text: string): Promise<void> {
    this.clipboard.push(text);
  }

  showInformationMessage(message: string): void {
    this.messages.push(message);
  }

  async fire(id: string, args?: unknown): Promise<void> {
    const handler = this.handlers.get(id);
    assert.ok(handler, `expected a handler for command '${id}'`);
    await handler!(args);
  }
}

function makeResolver(id: string | undefined, seenSources: CopyRequestIdSource[]): CopyRequestIdResolver {
  return {
    getCurrentTurnRequestId: (source: CopyRequestIdSource) => {
      seenSources.push(source);
      return id;
    },
  };
}

describe("registerCopyRequestIdCommands", () => {
  it("registers all three Cursor-parity command ids", () => {
    const seam = new StubSeam();
    const sources: CopyRequestIdSource[] = [];
    const disposable = registerCopyRequestIdCommands({
      resolver: makeResolver("req-123", sources),
      seam,
    });
    try {
      assert.ok(seam.handlers.has(COPY_REQUEST_ID_COMMAND), "composer.copyRequestId missing");
      assert.ok(seam.handlers.has(COPY_REQUEST_ID_FROM_PANE_COMMAND), "composer.copyRequestIdFromPane missing");
      assert.ok(seam.handlers.has(COPY_REQUEST_ID_FROM_EDITOR_COMMAND), "composer.copyRequestIdFromEditor missing");
    } finally {
      disposable.dispose();
    }
  });

  it("copies the turn request id to the clipboard from the pane", async () => {
    const seam = new StubSeam();
    const sources: CopyRequestIdSource[] = [];
    const disposable = registerCopyRequestIdCommands({
      resolver: makeResolver("srv-abc", sources),
      seam,
    });
    try {
      await seam.fire(COPY_REQUEST_ID_FROM_PANE_COMMAND);
      assert.deepStrictEqual(seam.clipboard, ["srv-abc"], "expected the request id on the clipboard");
      assert.deepStrictEqual(sources, ["pane"], "resolver should be told the command came from the pane");
      assert.ok(
        seam.messages.some((m) => /copied/i.test(m)),
        `expected a confirmation message, got: ${JSON.stringify(seam.messages)}`,
      );
    } finally {
      disposable.dispose();
    }
  });

  it("passes the editor source for the FromEditor command", async () => {
    const seam = new StubSeam();
    const sources: CopyRequestIdSource[] = [];
    const disposable = registerCopyRequestIdCommands({
      resolver: makeResolver("srv-ed", sources),
      seam,
    });
    try {
      await seam.fire(COPY_REQUEST_ID_FROM_EDITOR_COMMAND);
      assert.deepStrictEqual(seam.clipboard, ["srv-ed"]);
      assert.deepStrictEqual(sources, ["editor"]);
    } finally {
      disposable.dispose();
    }
  });

  it("shows a hint and leaves the clipboard alone when there is no request id", async () => {
    const seam = new StubSeam();
    const sources: CopyRequestIdSource[] = [];
    const disposable = registerCopyRequestIdCommands({
      resolver: makeResolver(undefined, sources),
      seam,
    });
    try {
      await seam.fire(COPY_REQUEST_ID_COMMAND);
      assert.strictEqual(seam.clipboard.length, 0, "clipboard must stay untouched");
      assert.deepStrictEqual(sources, ["palette"]);
      assert.ok(
        seam.messages.some((m) => /no request id/i.test(m)),
        `expected a 'no request ID' hint, got: ${JSON.stringify(seam.messages)}`,
      );
    } finally {
      disposable.dispose();
    }
  });

  it("dispose() disposes all three registrations", () => {
    const seam = new StubSeam();
    const sources: CopyRequestIdSource[] = [];
    const disposable = registerCopyRequestIdCommands({
      resolver: makeResolver("req-123", sources),
      seam,
    });
    disposable.dispose();
    assert.strictEqual(seam.disposed.size, 3, `expected 3 disposals, got ${seam.disposed.size}`);
  });
});

describe("copyCurrentTurnRequestId (exported helper)", () => {
  it("returns true and writes the id when the resolver has one", async () => {
    const seam = new StubSeam();
    const sources: CopyRequestIdSource[] = [];
    const ok = await copyCurrentTurnRequestId(
      { resolver: makeResolver("srv-direct", sources), seam },
      "editor",
    );
    assert.strictEqual(ok, true);
    assert.deepStrictEqual(seam.clipboard, ["srv-direct"]);
    assert.deepStrictEqual(sources, ["editor"]);
  });

  it("returns false and writes nothing when the resolver has none", async () => {
    const seam = new StubSeam();
    const sources: CopyRequestIdSource[] = [];
    const ok = await copyCurrentTurnRequestId(
      { resolver: makeResolver(undefined, sources), seam },
      "pane",
    );
    assert.strictEqual(ok, false);
    assert.strictEqual(seam.clipboard.length, 0);
  });
});
