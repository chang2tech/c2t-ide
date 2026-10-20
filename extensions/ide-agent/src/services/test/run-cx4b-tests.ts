/**
 * CX4b regression tests (node:test, vscode stubbed via ./vscode-stub).
 *
 * Covers the DEV-FIX-CX4B round:
 *  - MessageQueueService is UNBOUNDED (DIG-CONTINUOUS 2026-10-19 debunked the
 *    10-message / 20k-char caps — Cursor's addToQueue has no caps; locked in
 *    here so a cap can't regress silently).
 *  - HumanReviewService per-approval timeout (P2 CX4b).
 *  - Session 404 helpers: sessionIdFromApiPath + httpStatusCode (P2 CX4b).
 *
 * Run after `tsc`:  node out/services/test/run-cx4b-tests.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import "./vscode-stub";
import { windowStub } from "./vscode-stub";
import { MessageQueueService } from "../messageQueueService";
import { HumanReviewService } from "../humanReviewService";
import { httpStatusCode, sessionIdFromApiPath } from "../ideCodeEngineAdapter";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("MessageQueueService — unbounded (DIG-CONTINUOUS 2026-10-19: Cursor's addToQueue has no caps)", () => {
  it("does NOT cap at 10 messages — all 11 stay queued, no warning", () => {
    windowStub.consumeWarning();
    const q = new MessageQueueService();
    for (let i = 1; i <= 11; i++) {
      q.enqueue(`msg-${i}`, "agent");
    }
    assert.strictEqual(q.length, 11);
    const drained = q.drain().map((m) => m.text);
    assert.deepStrictEqual(drained, [
      "msg-1",
      "msg-2",
      "msg-3",
      "msg-4",
      "msg-5",
      "msg-6",
      "msg-7",
      "msg-8",
      "msg-9",
      "msg-10",
      "msg-11",
    ]);
    assert.strictEqual(windowStub.consumeWarning(), undefined, "no drop warning expected");
  });

  it("does NOT cap total chars — a giant message is kept alongside the others", () => {
    windowStub.consumeWarning();
    const q = new MessageQueueService();
    q.enqueue("small-1", "agent");
    q.enqueue("small-2", "agent");
    q.enqueue("x".repeat(19_999), "agent");
    // 7 + 7 + 19999 chars — unbounded, so nothing is dropped.
    assert.strictEqual(q.length, 3);
    const drained = q.drain();
    assert.strictEqual(drained.length, 3);
    assert.strictEqual(drained[2]!.text.length, 19_999);
    assert.strictEqual(windowStub.consumeWarning(), undefined, "no drop warning expected");
  });

  it("preserves each message's queued mode", () => {
    const q = new MessageQueueService();
    q.enqueue("a", "agent");
    q.enqueue("b", "chat");
    const drained = q.drain();
    assert.deepStrictEqual(
      drained.map((m) => m.mode),
      ["agent", "chat"],
    );
  });
});

describe("HumanReviewService approval timeout (P2 CX4b)", () => {
  it("auto-resolves undefined (skip) after the timeout", async () => {
    const svc = new HumanReviewService();
    const p = svc.requestApproval("tc-1", "title", ["reason"], 40);
    const result = await p;
    assert.strictEqual(result, undefined);
    assert.strictEqual(svc.pendingCount(), 0);
    assert.strictEqual(svc.currentApproval, undefined);
  });

  it("a manual resolve before the timeout wins and clears the timer", async () => {
    const svc = new HumanReviewService();
    const p = svc.requestApproval("tc-2", "title", ["reason"], 40);
    await sleep(10);
    svc.resolveApproval(svc.currentApproval!.approvalId, { optionId: "approve-once" });
    const result = await p;
    assert.deepStrictEqual(result, { optionId: "approve-once" });
    // Timer must be gone: waiting past the timeout changes nothing.
    await sleep(80);
    assert.strictEqual(svc.pendingCount(), 0);
  });

  it("settleAllPending resolves everything and clears timers", async () => {
    const svc = new HumanReviewService();
    const p1 = svc.requestApproval("tc-3", "t", [], 30);
    const p2 = svc.requestApproval("tc-4", "t", [], 30);
    svc.settleAllPending();
    assert.deepStrictEqual([await p1, await p2], [undefined, undefined]);
    await sleep(60);
    assert.strictEqual(svc.pendingCount(), 0);
  });

  it("the timeout also clears the visible card via onDidChangeApproval", async () => {
    const svc = new HumanReviewService();
    const seen: Array<unknown> = [];
    svc.onDidChangeApproval((req) => seen.push(req === undefined ? "cleared" : "opened"));
    const p = svc.requestApproval("tc-5", "title", [], 30);
    await p;
    assert.deepStrictEqual(seen, ["opened", "cleared"]);
  });
});

describe("session 404 helpers (P2 CX4b)", () => {
  it("sessionIdFromApiPath extracts the id from session-scoped paths", () => {
    assert.strictEqual(sessionIdFromApiPath("/api/session/abc-123/prompt"), "abc-123");
    assert.strictEqual(
      sessionIdFromApiPath("/api/session/ses_01J/session/permission/req-1/reply"),
      "ses_01J",
    );
    assert.strictEqual(sessionIdFromApiPath("/api/session"), undefined);
    assert.strictEqual(sessionIdFromApiPath("/api/config"), undefined);
    assert.strictEqual(sessionIdFromApiPath("/api/event"), undefined);
  });

  it("httpStatusCode reads the attached status", () => {
    const err = new Error("boom") as Error & { statusCode?: number };
    err.statusCode = 404;
    assert.strictEqual(httpStatusCode(err), 404);
    assert.strictEqual(httpStatusCode(new Error("plain")), undefined);
    assert.strictEqual(httpStatusCode(undefined), undefined);
    assert.strictEqual(httpStatusCode({ statusCode: "404" }), undefined);
  });
});
