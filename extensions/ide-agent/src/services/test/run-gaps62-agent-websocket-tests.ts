/**
 * Agent WebSocket protocol tests — GAPS-62 rework (node:test, zero extra
 * deps). Every assertion below pins a BINARY-VERIFIED fact from the
 * reference Cursor app (3.25.6; spot-checked 3.25.9):
 * - `extensions/cursor-agent-host/dist/agent-host-daemon/dist/bin/daemon.cjs`:
 *   protobuf-es compact descriptors (`agent/v1/agent_websocket`),
 *   redacted field-classification table, `validateAgentWebSocket*`
 *   function bodies, wire constants.
 * - `extensions/cursor-agent-host/dist/254.js`: descriptors, the
 *   `BigInt(0)` sequence tracker, frame helpers, `createAgentWebSocketRunSession`
 *   = factory returning `{run, preconnect, retireWhenIdle, close}`.
 *
 * These are NOT tautologies: field numbers (1–5 vs 0–4), camelCase vs
 * snake_case, `OK=0` vs `UNSPECIFIED=0`, the frame `{frame:{case,value}}`
 * nesting, single-arg validators, the exact error strings, and the plain
 * `Error` (not DeliveryAmbiguousError) on empty message bytes each fail if
 * the implementation drifts.
 *
 * Run after `tsc`:  node --test out/services/test/run-gaps62-agent-websocket-tests.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import {
  AgentWebSocketProtocolVersion,
  AgentWebSocketConnectCode,
  AgentWebSocketLifecycleError,
  AgentWebSocketDeliveryAmbiguousError,
  AGENT_WEBSOCKET_SAFETY,
  AGENT_WEBSOCKET_SUBPROTOCOL,
  AGENT_WEBSOCKET_PRECONNECT_SUBPROTOCOL,
  AGENT_WEBSOCKET_PRECONNECT_RESERVATION_HEADER,
  AGENT_WEBSOCKET_REUSE_HEADER,
  AGENT_WEBSOCKET_SEQUENTIAL_V1_REUSE_VALUE,
  AGENT_WEBSOCKET_PROTOCOL_VERSION,
  AGENT_WEBSOCKET_CLIENT_FRAME_FIELDS,
  AGENT_WEBSOCKET_SERVER_FRAME_FIELDS,
  AGENT_WEBSOCKET_MESSAGE_FIELDS,
  createAgentWebSocketClientMessageFrame,
  createAgentWebSocketHalfCloseFrame,
  createAgentWebSocketCancelRunFrame,
  createAgentWebSocketHelloFrame,
  createAgentWebSocketRunStartFrame,
  agentWebSocketLifecycleError,
  AgentWebSocketSequenceTracker,
  validateAgentWebSocketHello,
  validateAgentWebSocketRunIdentity,
  validateAgentWebSocketConnectError,
  validateAgentWebSocketClientFrame,
  validateAgentWebSocketServerFrame,
  createAgentWebSocketRunSession,
  encodeAgentWebSocketFrame,
  decodeAgentWebSocketClientFrame,
  decodeAgentWebSocketServerFrame,
  type AgentWebSocketClientFrame,
  type AgentWebSocketServerFrame,
  type AgentWebSocketConnectError,
} from "../agentWebSocketProtocol";

const RUN_ID = "run_abc";
const REQ_ID = "req_xyz";

function makeConnectError(code = AgentWebSocketConnectCode.NOT_FOUND): AgentWebSocketConnectError {
  return { code, rawMessage: "not found", metadata: [], details: [] };
}

describe("enums (descriptor-verified)", () => {
  it("protocol version: UNSPECIFIED=0, V1=1", () => {
    assert.strictEqual(AgentWebSocketProtocolVersion.UNSPECIFIED, 0);
    assert.strictEqual(AgentWebSocketProtocolVersion.V1, 1);
  });

  it("connect code 0 is UNSPECIFIED, not OK (old fabrication guard)", () => {
    assert.strictEqual(AgentWebSocketConnectCode.UNSPECIFIED, 0);
    assert.strictEqual("OK" in AgentWebSocketConnectCode, false);
    assert.strictEqual(AgentWebSocketConnectCode.CANCELED, 1);
    assert.strictEqual(AgentWebSocketConnectCode.INVALID_ARGUMENT, 3);
    assert.strictEqual(AgentWebSocketConnectCode.NOT_FOUND, 5);
    assert.strictEqual(AgentWebSocketConnectCode.PERMISSION_DENIED, 7);
    assert.strictEqual(AgentWebSocketConnectCode.UNAUTHENTICATED, 16);
  });
});

describe("field numbers (descriptor-verified)", () => {
  it("client frame oneof fields are 1-5 (not 0-4)", () => {
    assert.deepStrictEqual(AGENT_WEBSOCKET_CLIENT_FRAME_FIELDS, {
      hello: 1,
      runStart: 2,
      clientMessage: 3,
      halfClose: 4,
      cancelRun: 5,
    });
  });

  it("server frame oneof fields are 1-5 (not 0-4)", () => {
    assert.deepStrictEqual(AGENT_WEBSOCKET_SERVER_FRAME_FIELDS, {
      hello: 1,
      runAccepted: 2,
      serverMessage: 3,
      runEnd: 4,
      runRejected: 5,
    });
  });

  it("message field numbers match the descriptors", () => {
    assert.deepStrictEqual(AGENT_WEBSOCKET_MESSAGE_FIELDS.AgentWebSocketClientMessage, {
      runId: 1,
      sequence: 2,
      message: 3,
    });
    assert.deepStrictEqual(AGENT_WEBSOCKET_MESSAGE_FIELDS.AgentWebSocketServerMessage, {
      runId: 1,
      sequence: 2,
      message: 3,
    });
    assert.deepStrictEqual(AGENT_WEBSOCKET_MESSAGE_FIELDS.AgentWebSocketRunEnd, {
      identity: 1,
      trailers: 2,
      error: 3,
    });
    assert.deepStrictEqual(AGENT_WEBSOCKET_MESSAGE_FIELDS.AgentWebSocketConnectError, {
      code: 1,
      rawMessage: 2,
      metadata: 3,
      details: 4,
    });
    assert.deepStrictEqual(AGENT_WEBSOCKET_MESSAGE_FIELDS.AgentWebSocketRunIdentity, {
      runId: 1,
      requestId: 2,
    });
  });
});

describe("wire constants (binary-verified)", () => {
  it("subprotocols, headers, and protocol version constant", () => {
    assert.strictEqual(AGENT_WEBSOCKET_SUBPROTOCOL, "cursor-agent-v1");
    assert.strictEqual(AGENT_WEBSOCKET_PRECONNECT_SUBPROTOCOL, "cursor-agent-preconnect-v1");
    assert.strictEqual(
      AGENT_WEBSOCKET_PRECONNECT_RESERVATION_HEADER,
      "x-cursor-agent-websocket-reservation-id",
    );
    assert.strictEqual(AGENT_WEBSOCKET_REUSE_HEADER, "x-cursor-agent-websocket-reuse");
    assert.strictEqual(AGENT_WEBSOCKET_SEQUENTIAL_V1_REUSE_VALUE, "sequential-v1");
    assert.strictEqual(AGENT_WEBSOCKET_PROTOCOL_VERSION, AgentWebSocketProtocolVersion.V1);
  });
});

describe("safety table (binary-verified byte-for-byte, fully-qualified keys)", () => {
  it("contains exactly the 8 bundled entries", () => {
    assert.deepStrictEqual(AGENT_WEBSOCKET_SAFETY, {
      "agent.v1.AgentWebSocketRunIdentity": { run_id: "SAFE", request_id: "SAFE" },
      "agent.v1.AgentWebSocketHeader": { name: "SAFE", value: "CREDENTIALS" },
      "agent.v1.AgentWebSocketClientMessage": { run_id: "SAFE", message: "CODE" },
      "agent.v1.AgentWebSocketClientHalfClose": { run_id: "SAFE" },
      "agent.v1.AgentWebSocketCancelRun": { run_id: "SAFE" },
      "agent.v1.AgentWebSocketServerMessage": { run_id: "SAFE", message: "CODE" },
      "agent.v1.AgentWebSocketConnectErrorDetail": { type_name: "SAFE", binary_value: "CODE" },
      "agent.v1.AgentWebSocketConnectError": { raw_message: "CODE" },
    });
  });

  it("is keyed by fully-qualified type names, not bare message names", () => {
    assert.strictEqual((AGENT_WEBSOCKET_SAFETY as Record<string, unknown>)["AgentWebSocketHeader"], undefined);
    assert.strictEqual(
      AGENT_WEBSOCKET_SAFETY["agent.v1.AgentWebSocketHeader"]!.value,
      "CREDENTIALS",
    );
  });
});

describe("frame constructors (binary shape {frame:{case,value}})", () => {
  it("builds a nested clientMessage frame with a bigint sequence", () => {
    const bytes = new TextEncoder().encode("hello");
    const frame = createAgentWebSocketClientMessageFrame(RUN_ID, BigInt(0), bytes);
    assert.deepStrictEqual(frame, {
      frame: {
        case: "clientMessage",
        value: { runId: RUN_ID, sequence: BigInt(0), message: bytes },
      },
    });
  });

  it("builds halfClose/cancelRun frames with only runId", () => {
    assert.deepStrictEqual(createAgentWebSocketHalfCloseFrame(RUN_ID), {
      frame: { case: "halfClose", value: { runId: RUN_ID } },
    });
    assert.deepStrictEqual(createAgentWebSocketCancelRunFrame(RUN_ID), {
      frame: { case: "cancelRun", value: { runId: RUN_ID } },
    });
  });

  it("builds hello with the protocol-version constant and runStart with identity", () => {
    assert.deepStrictEqual(createAgentWebSocketHelloFrame(), {
      frame: { case: "hello", value: { protocolVersion: 1 } },
    });
    const start = createAgentWebSocketRunStartFrame(
      { runId: RUN_ID, requestId: REQ_ID },
      [{ name: "x-model", value: "m1" }],
    );
    assert.strictEqual(start.frame.case, "runStart");
    if (start.frame.case !== "runStart") throw new Error("unreachable");
    assert.deepStrictEqual(start.frame.value.identity, { runId: RUN_ID, requestId: REQ_ID });
    assert.deepStrictEqual(start.frame.value.headers, [{ name: "x-model", value: "m1" }]);
  });
});

describe("validators (binary-verified names + bodies)", () => {
  it("hello accepts ONLY the protocol-version constant (UNSPECIFIED rejected)", () => {
    validateAgentWebSocketHello({ protocolVersion: AgentWebSocketProtocolVersion.V1 });
    assert.throws(
      () => validateAgentWebSocketHello({ protocolVersion: AgentWebSocketProtocolVersion.UNSPECIFIED }),
      (e: unknown) =>
        e instanceof Error &&
        e.message === "unsupported Agent WebSocket protocol version",
    );
  });

  it("runIdentity takes ONE argument; undefined and empty ids throw exact strings", () => {
    validateAgentWebSocketRunIdentity({ runId: RUN_ID, requestId: REQ_ID });
    assert.throws(
      () => validateAgentWebSocketRunIdentity(undefined as never),
      /missing Agent WebSocket run identity/,
    );
    assert.throws(
      () => validateAgentWebSocketRunIdentity({ runId: "", requestId: REQ_ID }),
      /missing Agent WebSocket run_id/,
    );
    assert.throws(
      () => validateAgentWebSocketRunIdentity({ runId: RUN_ID, requestId: "" }),
      /missing Agent WebSocket request_id/,
    );
  });

  it("connectError rejects code 0 (UNSPECIFIED) and validates detail type_name", () => {
    validateAgentWebSocketConnectError(makeConnectError());
    assert.throws(
      () =>
        validateAgentWebSocketConnectError(
          makeConnectError(AgentWebSocketConnectCode.UNSPECIFIED),
        ),
      (e: unknown) => e instanceof Error && e.message === "invalid Agent WebSocket Connect error code",
    );
    assert.throws(
      () =>
        validateAgentWebSocketConnectError({
          ...makeConnectError(),
          details: [{ typeName: "", binaryValue: new Uint8Array() }],
        }),
      /Connect error detail type_name/,
    );
    assert.throws(
      () => validateAgentWebSocketConnectError(undefined as never),
      /missing Agent WebSocket Connect error/,
    );
  });

  it("empty client message bytes throw a PLAIN Error with the binary string", () => {
    const frame: AgentWebSocketClientFrame = {
      frame: { case: "clientMessage", value: { runId: RUN_ID, sequence: 0n, message: new Uint8Array() } },
    };
    assert.throws(
      () => validateAgentWebSocketClientFrame(frame),
      (e: unknown) =>
        e instanceof Error &&
        !(e instanceof AgentWebSocketLifecycleError) &&
        !(e instanceof AgentWebSocketDeliveryAmbiguousError) &&
        e.message === "missing Agent WebSocket client message bytes",
    );
  });

  it("empty server message bytes throw a PLAIN Error (not DeliveryAmbiguousError)", () => {
    const frame: AgentWebSocketServerFrame = {
      frame: { case: "serverMessage", value: { runId: RUN_ID, sequence: 0n, message: new Uint8Array() } },
    };
    assert.throws(
      () => validateAgentWebSocketServerFrame(frame),
      (e: unknown) =>
        e instanceof Error &&
        !(e instanceof AgentWebSocketDeliveryAmbiguousError) &&
        e.message === "missing Agent WebSocket server message bytes",
    );
  });

  it("unknown variants throw the frame-variant strings; runEnd validates optional error", () => {
    const badClient = { frame: { case: "nope" } } as unknown as AgentWebSocketClientFrame;
    assert.throws(
      () => validateAgentWebSocketClientFrame(badClient),
      (e: unknown) => e instanceof Error && e.message === "missing Agent WebSocket client frame variant",
    );
    const badServer = { frame: { case: "nope" } } as unknown as AgentWebSocketServerFrame;
    assert.throws(
      () => validateAgentWebSocketServerFrame(badServer),
      (e: unknown) => e instanceof Error && e.message === "missing Agent WebSocket server frame variant",
    );
    // valid full server frames pass
    validateAgentWebSocketServerFrame({
      frame: {
        case: "runEnd",
        value: {
          identity: { runId: RUN_ID, requestId: REQ_ID },
          trailers: [],
          error: makeConnectError(AgentWebSocketConnectCode.INTERNAL),
        },
      },
    });
    validateAgentWebSocketServerFrame({
      frame: {
        case: "runRejected",
        value: {
          identity: { runId: RUN_ID, requestId: REQ_ID },
          error: makeConnectError(AgentWebSocketConnectCode.PERMISSION_DENIED),
        },
      },
    });
  });
});

describe("sequence tracker (verified: BigInt(0) start, exact out-of-order string)", () => {
  it("accepts BigInt(0) first, then increments; out-of-order throws the binary string", () => {
    const t = new AgentWebSocketSequenceTracker();
    assert.strictEqual(t.expected, BigInt(0));
    t.accept(BigInt(0));
    assert.strictEqual(t.expected, BigInt(1));
    t.accept(BigInt(1)); // in order — next advances to 2
    assert.strictEqual(t.expected, BigInt(2));
    assert.throws(
      () => t.accept(BigInt(1)), // replay of an old sequence
      (e: unknown) =>
        e instanceof Error && e.message === "Agent WebSocket sequence 1 arrived out of order",
    );
  });

  it("starting at a non-zero sequence throws immediately", () => {
    const t = new AgentWebSocketSequenceTracker();
    assert.throws(
      () => t.accept(BigInt(5)),
      (e: unknown) =>
        e instanceof Error && e.message === "Agent WebSocket sequence 5 arrived out of order",
    );
  });
});

describe("lifecycle errors (verified code -> message table)", () => {
  it("maps every code to its binary-verbatim message and carries the code", () => {
    const cases: Array<[string, string]> = [
      ["aborted", "Agent WebSocket acquisition aborted"],
      ["context_invalidated", "Agent WebSocket context invalidated"],
      ["handshake_failed", "Agent WebSocket hello handshake failed"],
      ["handshake_timeout", "Agent WebSocket hello handshake timed out"],
      ["manager_closed", "Agent WebSocket lease manager is closed"],
      ["no_idle_socket", "Agent WebSocket pool had no warm socket to reuse"],
      ["open_failed", "Agent WebSocket failed to open"],
      ["open_timeout", "Agent WebSocket opening timed out"],
      ["pool_exhausted", "Agent WebSocket connection pool is at capacity"],
    ];
    for (const [code, message] of cases) {
      const e = agentWebSocketLifecycleError(code as never);
      assert.ok(e instanceof AgentWebSocketLifecycleError);
      assert.strictEqual(e.name, "AgentWebSocketLifecycleError");
      assert.strictEqual(e.code, code);
      assert.strictEqual(e.message, message);
    }
  });

  it("handshake_failed/open_failed append the cause message (binary template strings)", () => {
    const cause = new Error("dial tcp: timeout");
    assert.strictEqual(
      agentWebSocketLifecycleError("open_failed", cause).message,
      "Agent WebSocket failed to open: dial tcp: timeout",
    );
    assert.strictEqual(
      agentWebSocketLifecycleError("handshake_failed", cause).message,
      "Agent WebSocket hello handshake failed: dial tcp: timeout",
    );
    // non-template codes ignore the cause
    assert.strictEqual(
      agentWebSocketLifecycleError("manager_closed", cause).message,
      "Agent WebSocket lease manager is closed",
    );
  });
});

describe("delivery-ambiguous errors (verified shape)", () => {
  it("carries the name and passes diagnostics/cause through", () => {
    const diag = { socket: "s1" };
    const e = new AgentWebSocketDeliveryAmbiguousError("delivery unknown", {
      diagnostics: diag,
      cause: new Error("x"),
    });
    assert.strictEqual(e.name, "AgentWebSocketDeliveryAmbiguousError");
    assert.strictEqual(e.agentWebSocketDiagnostics, diag);
  });
});

describe("pool manager (verified surface {run, preconnect, retireWhenIdle, close})", () => {
  it("createAgentWebSocketRunSession returns exactly the four manager methods", () => {
    const m = createAgentWebSocketRunSession();
    assert.deepStrictEqual(Object.keys(m).sort(), ["close", "preconnect", "retireWhenIdle", "run"]);
  });

  it("preconnect uses requestId as the reservation id; occupancy tracks generations", () => {
    const m = createAgentWebSocketRunSession();
    const occ = (m as unknown as { occupancy(): number }).occupancy;
    m.preconnect({ runId: RUN_ID, requestId: REQ_ID });
    assert.strictEqual(occ(), 1);
    const h = m.run({ runId: RUN_ID, requestId: REQ_ID });
    assert.strictEqual(h.runId, RUN_ID);
    assert.strictEqual(h.requestId, REQ_ID);
    h.close();
    assert.strictEqual(occ(), 1); // generation released but not retired
    m.retireWhenIdle("test");
    assert.strictEqual(occ(), 0); // idle generation retired immediately
  });

  it("preconnect after close throws the verified manager_closed error", () => {
    const m = createAgentWebSocketRunSession();
    m.close();
    assert.throws(
      () => m.preconnect({ runId: RUN_ID, requestId: REQ_ID }),
      (e: unknown) =>
        e instanceof AgentWebSocketLifecycleError &&
        e.code === "manager_closed" &&
        e.message === "Agent WebSocket lease manager is closed",
    );
    assert.throws(
      () => m.run({ runId: RUN_ID, requestId: REQ_ID }),
      (e: unknown) =>
        e instanceof AgentWebSocketLifecycleError && e.code === "manager_closed",
    );
  });

  it("run validates identity (empty ids throw the binary string)", () => {
    const m = createAgentWebSocketRunSession();
    assert.throws(() => m.run({ runId: "", requestId: REQ_ID }), /missing Agent WebSocket run_id/);
    assert.throws(() => m.run({ runId: RUN_ID, requestId: "" }), /missing Agent WebSocket request_id/);
  });

  it("retireWhenIdle keeps a leased generation until its handle closes, then retires it", () => {
    const m = createAgentWebSocketRunSession();
    const occ = (m as unknown as { occupancy(): number }).occupancy;
    const h = m.run({ runId: RUN_ID, requestId: REQ_ID });
    m.retireWhenIdle("scaling-down");
    assert.strictEqual(occ(), 1); // leased -> not retired yet
    h.close();
    assert.strictEqual(occ(), 0); // retireAfterLease -> retired on release
  });

  it("close retires every generation and is idempotent", () => {
    const m = createAgentWebSocketRunSession();
    const occ = (m as unknown as { occupancy(): number }).occupancy;
    m.preconnect({ runId: "a", requestId: "a" });
    m.preconnect({ runId: "b", requestId: "b" });
    assert.strictEqual(occ(), 2);
    m.close();
    assert.strictEqual(occ(), 0);
    m.close(); // no throw
    assert.strictEqual(occ(), 0);
  });
});

describe("local JSON representation (round-trip)", () => {
  it("round-trips a client message frame with bigint sequence and bytes", () => {
    const frame = createAgentWebSocketClientMessageFrame(
      RUN_ID,
      BigInt(7),
      new TextEncoder().encode("chunk"),
    );
    const back = decodeAgentWebSocketClientFrame(encodeAgentWebSocketFrame(frame));
    assert.deepStrictEqual(back, frame);
    if (back.frame.case !== "clientMessage") throw new Error("unreachable");
    assert.strictEqual(back.frame.value.sequence, BigInt(7));
    assert.deepStrictEqual(Array.from(back.frame.value.message), Array.from(new TextEncoder().encode("chunk")));
  });

  it("round-trips a server run_end frame", () => {
    const frame: AgentWebSocketServerFrame = {
      frame: {
        case: "runEnd",
        value: {
          identity: { runId: RUN_ID, requestId: REQ_ID },
          trailers: [{ name: "grpc-status", value: "0" }],
          error: makeConnectError(AgentWebSocketConnectCode.INTERNAL),
        },
      },
    };
    const back = decodeAgentWebSocketServerFrame(encodeAgentWebSocketFrame(frame));
    assert.deepStrictEqual(back, frame);
  });
});
