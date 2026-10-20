/**
 * Subagent preview tray tests (node:test, zero extra deps).
 *
 * Locks in Cursor `glass.openSubagentPreviewInAgentsTray` parity
 * (binary evidence — 3.25.6 glass bundle registration + 3.25.9 desktop
 * bundle call sites; see subagentPreviewService.ts header):
 * - arg schema matches Cursor's zod `eAx` exactly
 *   ({composerId, name, initialPrompt?, initialPromptTaskToolCallId?,
 *   environment?: "cloud"|"local"});
 * - invalid args are rejected (null / false), never partially applied;
 * - a valid request opens/focuses the Agents Window via `ide.openAgentsWindow`
 *   with `agentsWindowOpenSource: "subagent_preview_tray"`, records the
 *   entry, and emits Cursor's verbatim event
 *   `openSubagentPreviewInAgentsTrayRequested` with the validated payload;
 * - the command is registered exactly once in extension.ts, declared in
 *   package.json with Cursor's verbatim title, and NOT in the command
 *   palette (Cursor: f1:!1).
 *
 * Run after `tsc`:  node --test out/services/test/run-subagent-preview-tests.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  OPEN_SUBAGENT_PREVIEW_IN_AGENTS_TRAY_COMMAND,
  OPEN_SUBAGENT_PREVIEW_TITLE,
  SUBAGENT_PREVIEW_REQUESTED_EVENT,
  SUBAGENT_PREVIEW_WINDOW_SOURCE,
  parseSubagentPreviewArgs,
  SubagentPreviewService,
  type SubagentPreviewArgs,
} from "../subagentPreviewService";

// Compiled to out/services/test/, so the extension root is ../../..
const EXT_ROOT = path.resolve(__dirname, "..", "..", "..");
const EXTENSION_TS = path.join(EXT_ROOT, "src", "extension.ts");
const PACKAGE_JSON = path.join(EXT_ROOT, "package.json");

function makeService() {
  const executed: Array<{ command: string; args: unknown }> = [];
  const emitted: Array<{ event: string; payload: unknown }> = [];
  let clock = 1_700_000_000_000;
  const svc = new SubagentPreviewService({
    executeCommand: (command: string, args?: unknown) => {
      executed.push({ command, args });
      return Promise.resolve(undefined);
    },
    now: () => clock++,
  });
  svc.on(SUBAGENT_PREVIEW_REQUESTED_EVENT, (payload: SubagentPreviewArgs) => {
    emitted.push({ event: SUBAGENT_PREVIEW_REQUESTED_EVENT, payload });
  });
  return { svc, executed, emitted };
}

describe("parseSubagentPreviewArgs (Cursor eAx schema)", () => {
  it("accepts the full arg shape", () => {
    assert.deepStrictEqual(
      parseSubagentPreviewArgs({
        composerId: "abc123",
        name: "Subagent",
        initialPrompt: "fix the bug",
        initialPromptTaskToolCallId: "call_1",
        environment: "local",
      }),
      {
        composerId: "abc123",
        name: "Subagent",
        initialPrompt: "fix the bug",
        initialPromptTaskToolCallId: "call_1",
        environment: "local",
      },
    );
  });

  it("accepts the minimal shape (composerId + name)", () => {
    assert.deepStrictEqual(
      parseSubagentPreviewArgs({ composerId: "x", name: "y" }),
      { composerId: "x", name: "y" },
    );
  });

  it("accepts environment=cloud", () => {
    assert.strictEqual(
      parseSubagentPreviewArgs({ composerId: "x", name: "y", environment: "cloud" })
        ?.environment,
      "cloud",
    );
  });

  it("rejects missing/empty composerId", () => {
    assert.strictEqual(parseSubagentPreviewArgs({ name: "y" }), null);
    assert.strictEqual(parseSubagentPreviewArgs({ composerId: "", name: "y" }), null);
    assert.strictEqual(
      parseSubagentPreviewArgs({ composerId: 42, name: "y" }),
      null,
    );
  });

  it("rejects missing/empty name", () => {
    assert.strictEqual(parseSubagentPreviewArgs({ composerId: "x" }), null);
    assert.strictEqual(parseSubagentPreviewArgs({ composerId: "x", name: "" }), null);
  });

  it("rejects non-string optionals and bad environment", () => {
    assert.strictEqual(
      parseSubagentPreviewArgs({ composerId: "x", name: "y", initialPrompt: 7 }),
      null,
    );
    assert.strictEqual(
      parseSubagentPreviewArgs({
        composerId: "x",
        name: "y",
        initialPromptTaskToolCallId: null,
      }),
      null,
    );
    assert.strictEqual(
      parseSubagentPreviewArgs({ composerId: "x", name: "y", environment: "remote" }),
      null,
    );
  });

  it("rejects non-objects", () => {
    assert.strictEqual(parseSubagentPreviewArgs(undefined), null);
    assert.strictEqual(parseSubagentPreviewArgs(null), null);
    assert.strictEqual(parseSubagentPreviewArgs("composerId"), null);
    assert.strictEqual(parseSubagentPreviewArgs([]), null);
  });
});

describe("SubagentPreviewService.requestPreview", () => {
  it("routes a valid request: agents window + tracker + event", async () => {
    const { svc, executed, emitted } = makeService();
    const ok = await svc.requestPreview({
      composerId: "c1",
      name: "My Subagent",
      environment: "local",
    });
    assert.strictEqual(ok, true);
    assert.deepStrictEqual(executed, [
      {
        command: "ide.openAgentsWindow",
        args: { agentsWindowOpenSource: SUBAGENT_PREVIEW_WINDOW_SOURCE },
      },
    ]);
    assert.strictEqual(emitted.length, 1);
    assert.strictEqual(emitted[0].event, SUBAGENT_PREVIEW_REQUESTED_EVENT);
    assert.deepStrictEqual(emitted[0].payload, {
      composerId: "c1",
      name: "My Subagent",
      environment: "local",
    });
    const previews = svc.getRequestedPreviews();
    assert.strictEqual(previews.length, 1);
    assert.strictEqual(previews[0].composerId, "c1");
    assert.ok(previews[0].requestedAt > 0);
    assert.strictEqual(svc.getPreviewFor("c1")?.name, "My Subagent");
    assert.strictEqual(svc.getPreviewFor("nope"), undefined);
    svc.dispose();
  });

  it("keeps entries ordered oldest-first", async () => {
    const { svc } = makeService();
    await svc.requestPreview({ composerId: "a", name: "A" });
    await svc.requestPreview({ composerId: "b", name: "B" });
    const ids = svc.getRequestedPreviews().map((e) => e.composerId);
    assert.deepStrictEqual(ids, ["a", "b"]);
    // latest entry wins for a repeated composer
    await svc.requestPreview({ composerId: "a", name: "A2" });
    assert.strictEqual(svc.getPreviewFor("a")?.name, "A2");
    svc.dispose();
  });

  it("rejects invalid args without side effects", async () => {
    const { svc, executed, emitted } = makeService();
    assert.strictEqual(await svc.requestPreview({ name: "no id" }), false);
    assert.strictEqual(await svc.requestPreview(undefined), false);
    assert.deepStrictEqual(executed, []);
    assert.deepStrictEqual(emitted, []);
    assert.deepStrictEqual(svc.getRequestedPreviews(), []);
    svc.dispose();
  });
});

describe("command wiring (static)", () => {
  it("registers ide.openSubagentPreviewInAgentsTray exactly once in extension.ts", () => {
    const src = fs.readFileSync(EXTENSION_TS, "utf8");
    // Registered via the OPEN_SUBAGENT_PREVIEW_IN_AGENTS_TRAY_COMMAND
    // constant (single source of truth for the command id).
    const hits =
      src.match(
        /registerCommand\(\s*OPEN_SUBAGENT_PREVIEW_IN_AGENTS_TRAY_COMMAND/g,
      ) ?? [];
    assert.strictEqual(hits.length, 1, `expected 1 registration, found ${hits.length}`);
    assert.strictEqual(
      OPEN_SUBAGENT_PREVIEW_IN_AGENTS_TRAY_COMMAND,
      "ide.openSubagentPreviewInAgentsTray",
    );
  });

  it("declares the command in package.json with Cursor's verbatim title", () => {
    const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, "utf8"));
    const cmds = pkg.contributes.commands as Array<{
      command: string;
      title: string;
    }>;
    const found = cmds.filter(
      (c) => c.command === OPEN_SUBAGENT_PREVIEW_IN_AGENTS_TRAY_COMMAND,
    );
    assert.strictEqual(found.length, 1, "command missing from package.json");
    assert.strictEqual(
      found[0].title,
      OPEN_SUBAGENT_PREVIEW_TITLE,
      "title is not Cursor's verbatim title",
    );
    assert.strictEqual(
      OPEN_SUBAGENT_PREVIEW_TITLE,
      "Open subagent preview in agents tray",
    );
  });

  it("is NOT in the command palette (Cursor: f1:!1)", () => {
    const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, "utf8"));
    const palette: Array<{ command?: string }> =
      pkg.contributes?.menus?.commandPalette ?? [];
    const found = palette.filter(
      (m) => m.command === OPEN_SUBAGENT_PREVIEW_IN_AGENTS_TRAY_COMMAND,
    );
    assert.strictEqual(
      found.length,
      0,
      "command must stay palette-hidden like Cursor's f1:!1",
    );
  });
});
