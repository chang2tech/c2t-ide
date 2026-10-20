/**
 * chatGotoDefinitionService tests (node:test, zero extra deps).
 *
 * Covers: command id parity with Cursor's
 * `aichat.action.goToDefinitionFromChatResponse`, argument normalization,
 * definition resolution via executeDefinitionProvider, fallback to the
 * captured source location when no definition is found, and command
 * registration.
 *
 * Run after `tsc`:  node out/services/test/run-chat-goto-definition-tests.js
 * (Note: .js — tsconfig outputs CommonJS .js; the sibling abort test header
 *  names .mjs but the on-disk build emits .js.)
 */
import "./vscode-stub";
import { describe, it } from "node:test";
import * as assert from "node:assert";
import {
  COMMAND_ID,
  goToDefinitionFromChatResponse,
  pickDefinitionTarget,
  registerChatGotoDefinition,
  resolveSymbolLocation,
  type GotoDefinitionVscode,
} from "../chatGotoDefinitionService";

interface FakeUri {
  kind: "uri";
  source: string;
  toString(): string;
}
interface FakePosition {
  kind: "position";
  line: number;
  character: number;
}
interface FakeRange {
  kind: "range";
  start: FakePosition;
  end: FakePosition;
}

function makeSeam(overrides: Partial<GotoDefinitionVscode> = {}): GotoDefinitionVscode & {
  calls: { showTextDocument: Array<{ uri: FakeUri; selection: FakeRange }>; info: string[]; errors: unknown[] };
} {
  const calls: { showTextDocument: Array<{ uri: FakeUri; selection: FakeRange }>; info: string[]; errors: unknown[] } = {
    showTextDocument: [],
    info: [],
    errors: [],
  };
  const seam: GotoDefinitionVscode = {
    asUri: (source: string) =>
      ({ kind: "uri", source, toString: () => source }) as unknown as import("vscode").Uri,
    positionAt: (line: number, character: number) =>
      ({ kind: "position", line, character }) as unknown as import("vscode").Position,
    makeRange: (start, end) =>
      ({
        kind: "range",
        start: start as unknown as FakePosition,
        end: end as unknown as FakePosition,
      }) as unknown as import("vscode").Range,
    executeDefinitionProvider: async () => [],
    showTextDocument: async (uri, selection) => {
      calls.showTextDocument.push({
        uri: uri as unknown as FakeUri,
        selection: selection as unknown as FakeRange,
      });
    },
    showInformationMessage: (message: string) => {
      calls.info.push(message);
    },
    logError: (err: unknown) => {
      calls.errors.push(err);
    },
    ...overrides,
  };
  return { ...seam, calls };
}

describe("COMMAND_ID (Cursor parity)", () => {
  it("matches the binary-evidence command id", () => {
    assert.strictEqual(COMMAND_ID, "aichat.action.goToDefinitionFromChatResponse");
  });
});

describe("pickDefinitionTarget", () => {
  it("takes the first Location", () => {
    const loc = {
      uri: { kind: "uri", source: "def.ts" },
      range: { kind: "range" },
    };
    const t = pickDefinitionTarget([loc]);
    assert.ok(t, "expected a target");
    assert.deepStrictEqual(t!.range, { kind: "range" });
  });

  it("takes the first LocationLink (targetUri/targetRange)", () => {
    const link = {
      targetUri: { kind: "uri", source: "link-def.ts" },
      targetRange: { kind: "range", tag: "target" },
      originSelectionRange: {},
    };
    const t = pickDefinitionTarget([link]);
    assert.ok(t, "expected a target");
    assert.deepStrictEqual((t!.uri as unknown as FakeUri).source, "link-def.ts");
    assert.deepStrictEqual(t!.range, { kind: "range", tag: "target" });
  });

  it("returns undefined for empty / non-array results", () => {
    assert.strictEqual(pickDefinitionTarget([]), undefined);
    assert.strictEqual(pickDefinitionTarget(undefined), undefined);
    assert.strictEqual(pickDefinitionTarget({}), undefined);
  });
});

describe("resolveSymbolLocation", () => {
  it("normalizes a file path + 0-based line/character", () => {
    const seam = makeSeam();
    const loc = resolveSymbolLocation(
      { symbol: "foo", source: "/repo/src/foo.ts", line: 10, character: 4 },
      seam,
    );
    assert.ok(loc, "expected a resolved location");
    assert.strictEqual((loc!.uri as unknown as FakeUri).source, "/repo/src/foo.ts");
    assert.strictEqual((loc!.position as unknown as FakePosition).line, 10);
    assert.strictEqual((loc!.position as unknown as FakePosition).character, 4);
    assert.strictEqual(loc!.symbol, "foo");
  });

  it("defaults missing line/character to 0", () => {
    const seam = makeSeam();
    const loc = resolveSymbolLocation({ source: "file:///repo/x.ts" }, seam);
    assert.ok(loc);
    assert.strictEqual((loc!.position as unknown as FakePosition).line, 0);
    assert.strictEqual((loc!.position as unknown as FakePosition).character, 0);
  });

  it("rejects args without a source or with negative coords", () => {
    const seam = makeSeam();
    assert.strictEqual(resolveSymbolLocation({ symbol: "foo" }, seam), undefined);
    assert.strictEqual(resolveSymbolLocation(undefined, seam), undefined);
    assert.strictEqual(
      resolveSymbolLocation({ source: "/a.ts", line: -1 }, seam),
      undefined,
    );
  });
});

describe("goToDefinitionFromChatResponse", () => {
  it("navigates to the resolved definition", async () => {
    const defUri = { kind: "uri", source: "/repo/src/def.ts", toString: () => "/repo/src/def.ts" };
    const defRange = { kind: "range", tag: "def" };
    const seam = makeSeam({
      executeDefinitionProvider: async () => [{ uri: defUri, range: defRange }],
    });
    const status = await goToDefinitionFromChatResponse(
      { symbol: "bar", source: "/repo/src/use.ts", line: 3, character: 7 },
      seam,
    );
    assert.strictEqual(status, "navigated");
    assert.strictEqual(seam.calls.showTextDocument.length, 1);
    assert.strictEqual(seam.calls.showTextDocument[0].uri.source, "/repo/src/def.ts");
    assert.deepStrictEqual(seam.calls.showTextDocument[0].selection, defRange);
  });

  it("falls back to the captured source location when no definition is found", async () => {
    const seam = makeSeam({ executeDefinitionProvider: async () => [] });
    const status = await goToDefinitionFromChatResponse(
      { symbol: "bar", source: "/repo/src/use.ts", line: 5, character: 2 },
      seam,
    );
    assert.strictEqual(status, "fallback-to-source");
    assert.strictEqual(seam.calls.showTextDocument.length, 1);
    const shown = seam.calls.showTextDocument[0];
    assert.strictEqual(shown.uri.source, "/repo/src/use.ts");
    assert.strictEqual(shown.selection.kind, "range");
    assert.strictEqual(shown.selection.start.line, 5);
    assert.strictEqual(shown.selection.start.character, 2);
  });

  it("falls back (and logs) when the provider throws", async () => {
    const seam = makeSeam({
      executeDefinitionProvider: async () => {
        throw new Error("language server down");
      },
    });
    const status = await goToDefinitionFromChatResponse(
      { source: "/repo/src/use.ts", line: 1, character: 1 },
      seam,
    );
    assert.strictEqual(status, "fallback-to-source");
    assert.strictEqual(seam.calls.errors.length, 1);
    assert.strictEqual(seam.calls.showTextDocument.length, 1);
  });

  it("reports no-source and shows an info message for empty args", async () => {
    const seam = makeSeam();
    const status = await goToDefinitionFromChatResponse(undefined, seam);
    assert.strictEqual(status, "no-source");
    assert.strictEqual(seam.calls.showTextDocument.length, 0);
    assert.strictEqual(seam.calls.info.length, 1);
  });
});

describe("registerChatGotoDefinition", () => {
  it("registers the Cursor command id and pushes a disposable", async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const vscodeStubModule = require("vscode") as {
      commands: Record<string, unknown>;
    };
    const registered: Array<{ id: string; handler: (args: unknown) => Promise<string> }> = [];
    vscodeStubModule.commands.registerCommand = (id: string, handler: (args: unknown) => Promise<string>) => {
      registered.push({ id, handler });
      return { dispose: () => undefined };
    };

    const seam = makeSeam({
      executeDefinitionProvider: async () => [],
    });
    const subscriptions: Array<{ dispose(): void }> = [];
    const context = {
      subscriptions: subscriptions as unknown[],
    } as import("vscode").ExtensionContext;

    const id = registerChatGotoDefinition(context, seam);
    assert.strictEqual(id, "aichat.action.goToDefinitionFromChatResponse");
    assert.strictEqual(registered.length, 1);
    assert.strictEqual(registered[0].id, "aichat.action.goToDefinitionFromChatResponse");
    assert.strictEqual(subscriptions.length, 1);

    // The registered handler performs the goto behavior with the seam.
    const status = await registered[0].handler({
      symbol: "x",
      source: "/repo/x.ts",
      line: 2,
      character: 3,
    });
    assert.strictEqual(status, "fallback-to-source");
    assert.strictEqual(seam.calls.showTextDocument.length, 1);
    assert.strictEqual(seam.calls.showTextDocument[0].uri.source, "/repo/x.ts");
  });
});
