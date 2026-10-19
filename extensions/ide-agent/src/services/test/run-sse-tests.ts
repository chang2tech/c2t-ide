/**
 * SSE parser tests (node:test, zero extra deps).
 *
 * Frames are built EXACTLY like the real engine does:
 *   EventFeed.frame = (event) => `data: ${JSON.stringify(event)}\n\n`
 * (packages/server/src/event-feed.ts) — no `event:` line, the type lives
 * inside the JSON envelope { id, type, data }.
 *
 * Regression: QA-FILE-03 P0 — the old parser required an `event:` field and
 * silently dropped 100% of real server events, hanging every real-engine
 * turn until the 10-min watchdog.
 *
 * Run after `tsc`:  node out/services/test/run-sse-tests.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import { parseSse } from "../sseParser";

/** Build a frame exactly like EventFeed.frame does. */
function realFrame(type: string, data: unknown): string {
  return `data: ${JSON.stringify({ id: "evt_1", type, data })}\n\n`;
}

describe("parseSse — real engine frames (P0 regression)", () => {
  it("parses a real session.text.delta frame (no event: line)", () => {
    const ev = parseSse(
      realFrame("session.text.delta", {
        sessionID: "ses_1",
        assistantMessageID: "msg_1",
        ordinal: 0,
        delta: "hello world",
      }),
    );
    assert.ok(ev, "real frame must not be dropped");
    assert.strictEqual(ev.type, "session.text.delta");
    assert.strictEqual(ev.data.delta, "hello world");
    assert.strictEqual(ev.data.sessionID, "ses_1");
  });

  it("parses a real permission.asked frame with the CURRENT Request shape", () => {
    // Current schema: Permission.Request =
    // { id, sessionID, action, resources, save?, metadata?, source?, message? }
    // (packages/schema/src/permission.ts — NOT the legacy v1 subtree).
    const ev = parseSse(
      realFrame("permission.asked", {
        id: "per_abc",
        sessionID: "ses_1",
        action: "bash",
        resources: ["rm -rf ~"],
        message: "Run this command?",
      }),
    );
    assert.ok(ev, "real frame must not be dropped");
    assert.strictEqual(ev.type, "permission.asked");
    assert.strictEqual(ev.data.action, "bash");
    assert.deepStrictEqual(ev.data.resources, ["rm -rf ~"]);
    assert.strictEqual(ev.data.message, "Run this command?");
  });

  it("parses a real session.execution.succeeded frame (turn-end signal)", () => {
    const ev = parseSse(realFrame("session.execution.succeeded", { sessionID: "ses_1" }));
    assert.ok(ev);
    assert.strictEqual(ev.type, "session.execution.succeeded");
    assert.strictEqual(ev.data.sessionID, "ses_1");
  });

  it("parses a real session.tool.called frame", () => {
    const ev = parseSse(
      realFrame("session.tool.called", {
        sessionID: "ses_1",
        assistantMessageID: "msg_1",
        id: "tool_1",
        name: "bash",
        input: { command: "ls" },
        executed: true,
      }),
    );
    assert.ok(ev);
    assert.strictEqual(ev.type, "session.tool.called");
    assert.strictEqual(ev.data.name, "bash");
  });
});

describe("parseSse — edge cases", () => {
  it("ignores heartbeat comment frames", () => {
    assert.strictEqual(parseSse(": heartbeat"), undefined);
    assert.strictEqual(parseSse(":heartbeat\n"), undefined);
  });

  it("still honors an explicit event: line (legacy compat)", () => {
    const ev = parseSse('event: message.part.delta\ndata: {"sessionID":"ses_1","delta":"hi"}');
    assert.ok(ev);
    assert.strictEqual(ev.type, "message.part.delta");
    assert.strictEqual(ev.data.delta, "hi");
  });

  it("rejects malformed JSON", () => {
    assert.strictEqual(parseSse("data: {not json"), undefined);
  });

  it("rejects a JSON frame with no type", () => {
    assert.strictEqual(parseSse(`data: ${JSON.stringify({ id: "x", data: {} })}`), undefined);
  });

  it("rejects empty frames", () => {
    assert.strictEqual(parseSse(""), undefined);
    assert.strictEqual(parseSse("\n"), undefined);
  });

  it("handles data split across multiple lines (pretty-printed JSON)", () => {
    const json = JSON.stringify({ id: "e", type: "session.text.delta", data: { delta: "x" } }, null, 2);
    const ev = parseSse(json.split("\n").map((l) => `data:${l}`).join("\n"));
    assert.ok(ev);
    assert.strictEqual(ev.type, "session.text.delta");
  });
});
