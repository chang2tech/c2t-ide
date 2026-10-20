/**
 * agentWebSocketProtocol — typed model of the `agent.v1` Agent WebSocket
 * streaming protocol. REWORKED 2026-10-20 (DEV-GAPS-62, W62C) after W58E
 * found the previous revision contained fabrication.
 *
 * REWORK METHOD: every claim below was re-verified directly against the
 * reference Cursor binaries (READ-ONLY reference material) before writing:
 * - `extensions/cursor-agent-host/dist/agent-host-daemon/dist/bin/daemon.cjs`
 *   (3.25.6): protobuf-es compact descriptors for `agent/v1/agent_websocket`
 *   (byte offset ~7,666,500), the redacted field-classification table
 *   (~5,525,585), the `validateAgentWebSocket*` function bodies
 *   (~17,017,315), wire constants (`agent-websocket-wire.js` bundle), and
 *   the duplicated lifecycle-error message table.
 * - `extensions/cursor-agent-host/dist/254.js` (3.25.6): the same
 *   descriptors, `AGENT_WEBSOCKET_*` usage, the sequence tracker
 *   (`next=BigInt(0)`, `Agent WebSocket sequence ${e} arrived out of order`),
 *   the frame constructor helpers, and `createAgentWebSocketRunSession` —
 *   which is a **socket-pool-manager factory** returning
 *   `{run, preconnect, retireWhenIdle, close}` (byte offset ~38,930),
 *   NOT a per-run session object.
 * Spot-checked for consistency against 3.25.9
 * (`reference/cursor-3.25.9/...`): subprotocol, frame descriptors, error
 * strings, and index descriptors all match 3.25.6.
 *
 * What the rework changed (QA step 1 — "does Cursor do this?"):
 * - Frame oneof field numbers are **1–5**, not 0–4 (descriptor-verified).
 * - JS field case is **camelCase** (`runId`, `requestId`, `protocolVersion`,
 *   `rawMessage`, `typeName`, `binaryValue`); proto field names stay
 *   snake_case in descriptor strings only. Zero snake_case JS property
 *   usage exists in the binaries.
 * - `AgentWebSocketConnectCode` 0 is **UNSPECIFIED**, not OK — the old
 *   `OK=0` value was fabricated. Values 0–16 are descriptor-verified.
 * - Frames are `{frame: {case, value}}` (oneof named `frame`, cases
 *   camelCase); the old flat `{case, fieldNumber, value}` tuple was
 *   invented.
 * - `validateAgentWebSocketRunIdentity` takes ONE argument (identity);
 *   it does not compare against an expected identity.
 * - `validateAgentWebSocketHello` accepts ONLY `AGENT_WEBSOCKET_PROTOCOL_VERSION`
 *   (= V1); it does not accept UNSPECIFIED.
 * - `validateAgentWebSocketConnectError` rejects codes < CANCELED(1) and
 *   > UNAUTHENTICATED(16); it does not use `code in enum`.
 * - Empty message bytes throw a PLAIN Error with the exact binary string
 *   ("missing Agent WebSocket server message bytes"), NOT
 *   `AgentWebSocketDeliveryAmbiguousError`.
 * - `AgentWebSocketLifecycleError` carries a machine `code` (e.g.
 *   `manager_closed`) and the message comes from a VERIFIED code→message
 *   table (duplicated in both reference bundles).
 * - The old `AGENT_WEBSOCKET_SAFETY` keys were kept but CORRECTED: the
 *   bundled redacted table is keyed by fully-qualified type names
 *   (`"agent.v1.AgentWebSocketRunIdentity"`); all 8 entries match the
 *   binary byte-for-byte, so the table was NOT removed. W58E's "fabricated
 *   table" claim was refuted by the binary itself.
 * - The old per-run lifecycle state machine (`open/startRun/sendMessage/
 *   halfClose/cancelRun/receive` with invented states) is REMOVED. The real
 *   binary surface is the pool manager returned by
 *   `createAgentWebSocketRunSession`; a minimal in-process pool is provided
 *   as a LOCAL STAND-IN (see below) — it is not claimed to open sockets.
 *
 * LOCAL STAND-IN (explicitly not Cursor parity): `createAgentWebSocketRunSession`
 * here returns a working in-process socket pool implementing the VERIFIED
 * manager contract `{run, preconnect, retireWhenIdle, close}` and the
 * verified lifecycle-error paths. No real sockets are opened — the actual
 * transport (WebSocket + length-prefixed binary framing) lives in Cursor's
 * electron/browser layer and stays UNKNOWN (wire framing bytes are minified).
 * Do not claim this module performs network I/O.
 */

// ---------------------------------------------------------------------------
// Enums (descriptor-verified: 254.js `[[0,"UNSPECIFIED"],[1,"V1"]]`,
// `AgentWebSocketConnectCode` `[[0,"UNSPECIFIED"],...,[16,"UNAUTHENTICATED"]]`)
// ---------------------------------------------------------------------------

/** `agent.v1.AgentWebSocketProtocolVersion` */
export enum AgentWebSocketProtocolVersion {
  UNSPECIFIED = 0,
  V1 = 1,
}

/** `agent.v1.AgentWebSocketConnectCode` — mirrors gRPC status codes. */
export enum AgentWebSocketConnectCode {
  UNSPECIFIED = 0,
  CANCELED = 1,
  UNKNOWN = 2,
  INVALID_ARGUMENT = 3,
  DEADLINE_EXCEEDED = 4,
  NOT_FOUND = 5,
  ALREADY_EXISTS = 6,
  PERMISSION_DENIED = 7,
  RESOURCE_EXHAUSTED = 8,
  FAILED_PRECONDITION = 9,
  ABORTED = 10,
  OUT_OF_RANGE = 11,
  UNIMPLEMENTED = 12,
  INTERNAL = 13,
  UNAVAILABLE = 14,
  DATA_LOSS = 15,
  UNAUTHENTICATED = 16,
}

// ---------------------------------------------------------------------------
// Messages (descriptor-verified field layouts; JS props camelCase, exactly
// as used in the bundled code — e.g. `.runId`, `.requestId`,
// `.protocolVersion`, `.rawMessage`, `.typeName`, `.binaryValue`)
// ---------------------------------------------------------------------------

export interface AgentWebSocketHello {
  /** field 1 (enum AgentWebSocketProtocolVersion) */
  protocolVersion: AgentWebSocketProtocolVersion;
}

export interface AgentWebSocketRunIdentity {
  /** field 1 */ runId: string;
  /** field 2 */ requestId: string;
}

export interface AgentWebSocketHeader {
  /** field 1 */ name: string;
  /** field 2 */ value: string;
}

export interface AgentWebSocketRunStart {
  /** field 1 */ identity: AgentWebSocketRunIdentity;
  /** field 2 (repeated) */ headers: AgentWebSocketHeader[];
}

export interface AgentWebSocketRunAccepted {
  /** field 1 */ identity: AgentWebSocketRunIdentity;
  /** field 2 (repeated) */ headers: AgentWebSocketHeader[];
}

export interface AgentWebSocketRunRejected {
  /** field 1 */ identity: AgentWebSocketRunIdentity;
  /** field 2 */ error: AgentWebSocketConnectError;
}

export interface AgentWebSocketRunEnd {
  /** field 1 */ identity: AgentWebSocketRunIdentity;
  /** field 2 (repeated) */ trailers: AgentWebSocketHeader[];
  /** field 3 (optional) — present when the run ended with a connect error */
  error?: AgentWebSocketConnectError;
}

export interface AgentWebSocketClientMessage {
  /** field 1 */ runId: string;
  /** field 2 (uint64) */ sequence: bigint;
  /** field 3 (bytes) */ message: Uint8Array;
}

export interface AgentWebSocketServerMessage {
  /** field 1 */ runId: string;
  /** field 2 (uint64) */ sequence: bigint;
  /** field 3 (bytes) */ message: Uint8Array;
}

export interface AgentWebSocketClientHalfClose {
  /** field 1 */ runId: string;
}

export interface AgentWebSocketCancelRun {
  /** field 1 */ runId: string;
}

export interface AgentWebSocketConnectErrorDetail {
  /** field 1 */ typeName: string;
  /** field 2 (bytes) */ binaryValue: Uint8Array;
}

export interface AgentWebSocketConnectError {
  /** field 1 (enum) */ code: AgentWebSocketConnectCode;
  /** field 2 */ rawMessage: string;
  /** field 3 (repeated) */ metadata: AgentWebSocketHeader[];
  /** field 4 (repeated) */ details: AgentWebSocketConnectErrorDetail[];
}

// ---------------------------------------------------------------------------
// Field numbers (descriptor-verified, daemon.cjs `agent_websocket_pb.js`)
// ---------------------------------------------------------------------------

/** Oneof `frame` field numbers for `AgentWebSocketClientFrame`. */
export const AGENT_WEBSOCKET_CLIENT_FRAME_FIELDS = {
  hello: 1,
  runStart: 2,
  clientMessage: 3,
  halfClose: 4,
  cancelRun: 5,
} as const;

/** Oneof `frame` field numbers for `AgentWebSocketServerFrame`. */
export const AGENT_WEBSOCKET_SERVER_FRAME_FIELDS = {
  hello: 1,
  runAccepted: 2,
  serverMessage: 3,
  runEnd: 4,
  runRejected: 5,
} as const;

/** Per-message field numbers, descriptor-verified. */
export const AGENT_WEBSOCKET_MESSAGE_FIELDS = {
  AgentWebSocketHello: { protocolVersion: 1 },
  AgentWebSocketRunIdentity: { runId: 1, requestId: 2 },
  AgentWebSocketHeader: { name: 1, value: 2 },
  AgentWebSocketRunStart: { identity: 1, headers: 2 },
  AgentWebSocketRunAccepted: { identity: 1, headers: 2 },
  AgentWebSocketRunRejected: { identity: 1, error: 2 },
  AgentWebSocketRunEnd: { identity: 1, trailers: 2, error: 3 },
  AgentWebSocketClientMessage: { runId: 1, sequence: 2, message: 3 },
  AgentWebSocketServerMessage: { runId: 1, sequence: 2, message: 3 },
  AgentWebSocketClientHalfClose: { runId: 1 },
  AgentWebSocketCancelRun: { runId: 1 },
  AgentWebSocketConnectError: { code: 1, rawMessage: 2, metadata: 3, details: 4 },
  AgentWebSocketConnectErrorDetail: { typeName: 1, binaryValue: 2 },
} as const;

// ---------------------------------------------------------------------------
// Frames (binary shape: `{frame: {case, value}}` — the oneof is NAMED
// `frame`; cases are camelCase. Verified in 254.js:
// `frame:{case:"runStart",...}`, `frame.frame.value.runId`, ...)
// ---------------------------------------------------------------------------

export type AgentWebSocketClientFrame = {
  frame:
    | { case: "hello"; value: AgentWebSocketHello }
    | { case: "runStart"; value: AgentWebSocketRunStart }
    | { case: "clientMessage"; value: AgentWebSocketClientMessage }
    | { case: "halfClose"; value: AgentWebSocketClientHalfClose }
    | { case: "cancelRun"; value: AgentWebSocketCancelRun };
};

export type AgentWebSocketServerFrame = {
  frame:
    | { case: "hello"; value: AgentWebSocketHello }
    | { case: "runAccepted"; value: AgentWebSocketRunAccepted }
    | { case: "serverMessage"; value: AgentWebSocketServerMessage }
    | { case: "runEnd"; value: AgentWebSocketRunEnd }
    | { case: "runRejected"; value: AgentWebSocketRunRejected };
};

/** Wire constant used on WebSocket open (daemon.cjs: `AGENT_WEBSOCKET_SUBPROTOCOL="cursor-agent-v1"`). */
export const AGENT_WEBSOCKET_SUBPROTOCOL = "cursor-agent-v1";
/** Preconnect handshake subprotocol (`agent-websocket-wire.js` bundle). */
export const AGENT_WEBSOCKET_PRECONNECT_SUBPROTOCOL = "cursor-agent-preconnect-v1";
/** Header carrying the preconnect reservation id (="requestId" of the preconnect request). */
export const AGENT_WEBSOCKET_PRECONNECT_RESERVATION_HEADER =
  "x-cursor-agent-websocket-reservation-id";
/** Reuse header + value (="sequential-v1"), matching the lease manager's `connectionUsePolicy: "sequential-runs"`. */
export const AGENT_WEBSOCKET_REUSE_HEADER = "x-cursor-agent-websocket-reuse";
export const AGENT_WEBSOCKET_SEQUENTIAL_V1_REUSE_VALUE = "sequential-v1";
/** `AGENT_WEBSOCKET_PROTOCOL_VERSION = AgentWebSocketProtocolVersion.V1`. */
export const AGENT_WEBSOCKET_PROTOCOL_VERSION = AgentWebSocketProtocolVersion.V1;

// ---------------------------------------------------------------------------
// Frame constructor helpers (mirror the verified helpers in 254.js —
// `z(e,t,n)` clientMessage, `V(e)` halfClose, `X(e)` cancelRun —
// which construct exactly `{frame:{case, value:...}}` objects)
// ---------------------------------------------------------------------------

export function createAgentWebSocketClientMessageFrame(
  runId: string,
  sequence: bigint,
  message: Uint8Array,
): AgentWebSocketClientFrame {
  return { frame: { case: "clientMessage", value: { runId, sequence, message } } };
}

export function createAgentWebSocketHalfCloseFrame(runId: string): AgentWebSocketClientFrame {
  return { frame: { case: "halfClose", value: { runId } } };
}

export function createAgentWebSocketCancelRunFrame(runId: string): AgentWebSocketClientFrame {
  return { frame: { case: "cancelRun", value: { runId } } };
}

export function createAgentWebSocketHelloFrame(): AgentWebSocketClientFrame {
  return {
    frame: {
      case: "hello",
      value: { protocolVersion: AGENT_WEBSOCKET_PROTOCOL_VERSION },
    },
  };
}

export function createAgentWebSocketRunStartFrame(
  identity: AgentWebSocketRunIdentity,
  headers: AgentWebSocketHeader[] = [],
): AgentWebSocketClientFrame {
  return { frame: { case: "runStart", value: { identity, headers } } };
}

// ---------------------------------------------------------------------------
// Errors (verified code→message table, duplicated in 254.js and daemon.cjs)
// ---------------------------------------------------------------------------

export type AgentWebSocketLifecycleErrorCode =
  | "aborted"
  | "context_invalidated"
  | "handshake_failed"
  | "handshake_timeout"
  | "manager_closed"
  | "no_idle_socket"
  | "open_failed"
  | "open_timeout"
  | "pool_exhausted";

const AGENT_WEBSOCKET_LIFECYCLE_MESSAGES: Record<AgentWebSocketLifecycleErrorCode, string> = {
  aborted: "Agent WebSocket acquisition aborted",
  context_invalidated: "Agent WebSocket context invalidated",
  handshake_failed: "Agent WebSocket hello handshake failed",
  handshake_timeout: "Agent WebSocket hello handshake timed out",
  manager_closed: "Agent WebSocket lease manager is closed",
  no_idle_socket: "Agent WebSocket pool had no warm socket to reuse",
  open_failed: "Agent WebSocket failed to open",
  open_timeout: "Agent WebSocket opening timed out",
  pool_exhausted: "Agent WebSocket connection pool is at capacity",
};

/**
 * Binary: `class q extends Error { constructor(e,t) { super(t);
 * this.name = "AgentWebSocketLifecycleError"; this.code = e } }` — code is
 * the machine string, message comes from the table.
 */
export class AgentWebSocketLifecycleError extends Error {
  readonly code: AgentWebSocketLifecycleErrorCode | string;

  constructor(code: AgentWebSocketLifecycleErrorCode | string, message: string) {
    super(message);
    this.name = "AgentWebSocketLifecycleError";
    this.code = code;
  }
}

/**
 * Mirror of the binary `lifecycleError(code, detail)` / `L(e,t)`: looks up
 * the code in the verified message table; `handshake_failed` and
 * `open_failed` append `: <cause.message>` when a cause with a non-empty
 * message is supplied (exactly as in the binary template strings).
 */
export function agentWebSocketLifecycleError(
  code: AgentWebSocketLifecycleErrorCode,
  cause?: unknown,
): AgentWebSocketLifecycleError {
  let message = AGENT_WEBSOCKET_LIFECYCLE_MESSAGES[code];
  if (
    (code === "handshake_failed" || code === "open_failed") &&
    cause instanceof Error &&
    cause.message.length > 0
  ) {
    message = `${message}: ${cause.message}`;
  }
  return new AgentWebSocketLifecycleError(code, message);
}

/**
 * Binary: `class Q extends Error { constructor(e,t) { super(e);
 * this.agentWebSocketDiagnostics = t?.diagnostics; ...
 * this.name = "AgentWebSocketDeliveryAmbiguousError" } }` — a
 * delivery-ambiguity error carrying optional diagnostics. The exact trigger
 * sites are minified; the shape (name, diagnostics passthrough) is
 * verified.
 */
export class AgentWebSocketDeliveryAmbiguousError extends Error {
  readonly agentWebSocketDiagnostics?: unknown;

  constructor(message: string, opts?: { diagnostics?: unknown; cause?: unknown }) {
    super(message, opts && "cause" in opts ? { cause: opts.cause } : undefined);
    this.name = "AgentWebSocketDeliveryAmbiguousError";
    if (opts && "diagnostics" in opts) {
      this.agentWebSocketDiagnostics = opts.diagnostics;
    }
  }
}

// ---------------------------------------------------------------------------
// Redacted field-classification table (binary-verified — daemon.cjs
// redacted-protos table, ~5,525,585; keys are the FULLY-QUALIFIED type
// names exactly as bundled. SAFE = identifier, CODE = code/payload,
// CREDENTIALS = secret.)
// ---------------------------------------------------------------------------

export type AgentWebSocketFieldClassification = "SAFE" | "CODE" | "CREDENTIALS" | "PATH";

export const AGENT_WEBSOCKET_SAFETY: Readonly<
  Record<string, Readonly<Record<string, AgentWebSocketFieldClassification>>>
> = {
  "agent.v1.AgentWebSocketRunIdentity": { run_id: "SAFE", request_id: "SAFE" },
  "agent.v1.AgentWebSocketHeader": { name: "SAFE", value: "CREDENTIALS" },
  "agent.v1.AgentWebSocketClientMessage": { run_id: "SAFE", message: "CODE" },
  "agent.v1.AgentWebSocketClientHalfClose": { run_id: "SAFE" },
  "agent.v1.AgentWebSocketCancelRun": { run_id: "SAFE" },
  "agent.v1.AgentWebSocketServerMessage": { run_id: "SAFE", message: "CODE" },
  "agent.v1.AgentWebSocketConnectErrorDetail": { type_name: "SAFE", binary_value: "CODE" },
  "agent.v1.AgentWebSocketConnectError": { raw_message: "CODE" },
} as const;

// ---------------------------------------------------------------------------
// Validators (function names AND bodies verified — daemon.cjs ~17,017,315.
// The binary throws plain `Error`s with the exact strings below.)
// ---------------------------------------------------------------------------

/** Binary: `if (value.length === 0) throw new Error(`missing Agent WebSocket ${field}`)`. */
export function validateRequiredAgentWebSocketString(value: string, field: string): void {
  if (value.length === 0) {
    throw new Error(`missing Agent WebSocket ${field}`);
  }
}

/**
 * Binary: `if (hello.protocolVersion !== AGENT_WEBSOCKET_PROTOCOL_VERSION)
 * throw new Error("unsupported Agent WebSocket protocol version")`.
 */
export function validateAgentWebSocketHello(hello: AgentWebSocketHello): void {
  if (hello.protocolVersion !== AGENT_WEBSOCKET_PROTOCOL_VERSION) {
    throw new Error("unsupported Agent WebSocket protocol version");
  }
}

/**
 * Binary (single argument): `if (identity === void 0) throw new Error(
 * "missing Agent WebSocket run identity")`, then required run_id/request_id.
 */
export function validateAgentWebSocketRunIdentity(identity: AgentWebSocketRunIdentity): void {
  if (identity === undefined) {
    throw new Error("missing Agent WebSocket run identity");
  }
  validateRequiredAgentWebSocketString(identity.runId, "run_id");
  validateRequiredAgentWebSocketString(identity.requestId, "request_id");
}

/**
 * Binary: undefined → "missing Agent WebSocket Connect error";
 * code < CANCELED(1) || code > UNAUTHENTICATED(16) → "invalid Agent
 * WebSocket Connect error code"; each detail.typeName required with field
 * name "Connect error detail type_name".
 */
export function validateAgentWebSocketConnectError(error: AgentWebSocketConnectError): void {
  if (error === undefined) {
    throw new Error("missing Agent WebSocket Connect error");
  }
  if (
    error.code < AgentWebSocketConnectCode.CANCELED ||
    error.code > AgentWebSocketConnectCode.UNAUTHENTICATED
  ) {
    throw new Error("invalid Agent WebSocket Connect error code");
  }
  for (const detail of error.details) {
    validateRequiredAgentWebSocketString(detail.typeName, "Connect error detail type_name");
  }
}

/**
 * Binary `validateAgentWebSocketClientFrame` — switches on
 * `frame.frame.case`; hello → validateHello; runStart → validate identity;
 * clientMessage → required run_id ("client message run_id") + non-empty
 * message bytes; halfClose → "half-close run_id"; cancelRun →
 * "cancel run_id"; default → "missing Agent WebSocket client frame variant".
 */
export function validateAgentWebSocketClientFrame(frame: AgentWebSocketClientFrame): void {
  switch (frame.frame.case) {
    case "hello":
      validateAgentWebSocketHello(frame.frame.value);
      return;
    case "runStart":
      validateAgentWebSocketRunIdentity(frame.frame.value.identity);
      return;
    case "clientMessage":
      validateRequiredAgentWebSocketString(frame.frame.value.runId, "client message run_id");
      if (frame.frame.value.message.byteLength === 0) {
        throw new Error("missing Agent WebSocket client message bytes");
      }
      return;
    case "halfClose":
      validateRequiredAgentWebSocketString(frame.frame.value.runId, "half-close run_id");
      return;
    case "cancelRun":
      validateRequiredAgentWebSocketString(frame.frame.value.runId, "cancel run_id");
      return;
    default:
      throw new Error("missing Agent WebSocket client frame variant");
  }
}

/**
 * Binary `validateAgentWebSocketServerFrame` — same shape, server cases;
 * serverMessage → "server message run_id" + "missing Agent WebSocket
 * server message bytes" when empty; runEnd → identity + optional error
 * validated; runRejected → identity + error validated; default →
 * "missing Agent WebSocket server frame variant".
 */
export function validateAgentWebSocketServerFrame(frame: AgentWebSocketServerFrame): void {
  switch (frame.frame.case) {
    case "hello":
      validateAgentWebSocketHello(frame.frame.value);
      return;
    case "runAccepted":
      validateAgentWebSocketRunIdentity(frame.frame.value.identity);
      return;
    case "serverMessage":
      validateRequiredAgentWebSocketString(frame.frame.value.runId, "server message run_id");
      if (frame.frame.value.message.byteLength === 0) {
        // Plain Error — NOT AgentWebSocketDeliveryAmbiguousError (verified).
        throw new Error("missing Agent WebSocket server message bytes");
      }
      return;
    case "runEnd":
      validateAgentWebSocketRunIdentity(frame.frame.value.identity);
      if (frame.frame.value.error !== undefined) {
        validateAgentWebSocketConnectError(frame.frame.value.error);
      }
      return;
    case "runRejected":
      validateAgentWebSocketRunIdentity(frame.frame.value.identity);
      validateAgentWebSocketConnectError(frame.frame.value.error);
      return;
    default:
      throw new Error("missing Agent WebSocket server frame variant");
  }
}

// ---------------------------------------------------------------------------
// Sequence tracker (verified in 254.js — minified class with
// `constructor() { this.next = BigInt(0) }`,
// `accept(e) { if (e !== this.next) throw new Error(`Agent WebSocket
// sequence ${e} arrived out of order`); this.next += BigInt(1) }`.
// The binary sends its first client message with `sequence: BigInt(0)`.
// Class NAME was minified away; the behavior is byte-verified.)
// ---------------------------------------------------------------------------

export class AgentWebSocketSequenceTracker {
  private next: bigint;

  constructor() {
    this.next = BigInt(0);
  }

  /** The next sequence value the tracker will accept. */
  get expected(): bigint {
    return this.next;
  }

  accept(sequence: bigint): void {
    if (sequence !== this.next) {
      throw new Error(`Agent WebSocket sequence ${sequence} arrived out of order`);
    }
    this.next += BigInt(1);
  }
}

// ---------------------------------------------------------------------------
// Socket pool manager — `createAgentWebSocketRunSession` is VERIFIED (254.js,
// byte ~38,930) to be a FACTORY returning the pool-manager surface
// `{run, preconnect, retireWhenIdle, close}` — NOT a per-run session.
// The real implementation builds a connection pool + lease manager
// (`connectionUsePolicy: "sequential-runs"`) around real WebSocket
// sockets. The pool below is an IN-PROCESS LOCAL STAND-IN: it keeps the
// verified contract shape, the verified `reservationId = request.requestId`
// preconnect behavior, the verified retirement/close semantics, and the
// verified lifecycle error paths. It opens NO sockets.
// ---------------------------------------------------------------------------

/** Binary-verified factory dependency names (from the minified factory). */
export interface AgentWebSocketRunSessionDeps {
  /** `deps.createSocket` — used by the real factory to open WebSocket sockets. UNUSED by the stand-in (it opens no sockets). */
  createSocket?: (...args: unknown[]) => unknown;
  /** `deps.runWithNetworkContext` — wraps socket creation in the real factory. Optional in the stand-in. */
  runWithNetworkContext?: <T>(fn: () => T) => T;
  /** `deps.connectionContext` — compared per-generation in the real factory. Optional in the stand-in. */
  connectionContext?: unknown;
  maxConnections?: number;
  keepalivePingIntervalMs?: number;
  keepalivePingTimeoutMs?: number;
  timers?: { setTimeout: (fn: () => void, ms: number) => unknown; clearTimeout: (h: unknown) => void };
  observePreconnect?: (info: unknown) => void;
  onPoolWentCold?: () => void;
  onIdleSocketsExhausted?: () => void;
  observeLifecycle?: (info: unknown) => void;
  observeFirstMessagePipeline?: (info: unknown) => void;
}

/** The preconnect/run request. Verified: preconnect derives `reservationId` from `requestId`. */
export interface AgentWebSocketRunRequest {
  runId: string;
  requestId: string;
}

export interface AgentWebSocketRunOptions {
  reservationId?: string;
  /** LOCAL stand-in extra: bypass the warm-socket check and force a fresh generation. */
  forceFresh?: boolean;
}

/** Handle returned by `run()` — LOCAL stand-in (lease-manager semantics in Cursor are minified). */
export interface AgentWebSocketRunHandle {
  readonly runId: string;
  readonly requestId: string;
  close(): void;
}

/**
 * The VERIFIED pool-manager surface:
 * `{run, preconnect, retireWhenIdle, close}` (254.js export
 * `createAgentWebSocketRunSession`).
 */
export interface AgentWebSocketPoolManager {
  run(request: AgentWebSocketRunRequest, opts?: AgentWebSocketRunOptions): AgentWebSocketRunHandle;
  preconnect(request: AgentWebSocketRunRequest, opts?: AgentWebSocketRunOptions): void;
  retireWhenIdle(cause?: string): void;
  close(reason?: string): void;
}

interface AgentWebSocketPoolGeneration {
  reservationId: string;
  requestId: string;
  runId?: string;
  leased: boolean;
  preconnectReady: boolean;
  retireAfterLease: boolean;
  deferredRetirementCause?: string;
}

/**
 * In-process stand-in socket pool implementing the verified manager
 * contract. Verified semantics kept:
 * - `preconnect` after `close()` → lifecycle error `manager_closed`;
 *   while retiring → `pool_exhausted` (mirrors binary `retirementDepth > 0`).
 * - `reservationId` defaults to `request.requestId` (binary: `preconnect:
 *   (e,t={}) => n.preconnect(e, {...t, reservationId: e.requestId})`).
 * - `retireWhenIdle(cause = "unknown")` marks every generation
 *   `retireAfterLease`, sets `deferredRetirementCause ??= cause`, and
 *   immediately retires generations that are idle (`ready && !leased`).
 * - `close(reason = "manager_closed")` marks the manager closed and retires
 *   every generation.
 * NOT verified / stand-in-only: generation lifecycle bookkeeping, `run()`
 * returning an in-process handle, `occupancy()`. No network I/O happens.
 */
export function createAgentWebSocketRunSession(
  _deps: AgentWebSocketRunSessionDeps = {},
): AgentWebSocketPoolManager {
  const generations: AgentWebSocketPoolGeneration[] = [];
  let closed = false;
  let retirementDepth = 0;

  function retireGeneration(gen: AgentWebSocketPoolGeneration): void {
    const idx = generations.indexOf(gen);
    if (idx >= 0) generations.splice(idx, 1);
  }

  function isIdle(gen: AgentWebSocketPoolGeneration): boolean {
    return gen.preconnectReady && !gen.leased;
  }

  const manager: AgentWebSocketPoolManager = {
    preconnect(request, opts = {}) {
      if (closed) {
        throw agentWebSocketLifecycleError("manager_closed");
      }
      if (retirementDepth > 0) {
        throw agentWebSocketLifecycleError("pool_exhausted");
      }
      validateAgentWebSocketRunIdentity({ runId: request.runId, requestId: request.requestId });
      const reservationId = opts.reservationId ?? request.requestId;
      generations.push({
        reservationId,
        requestId: request.requestId,
        leased: false,
        preconnectReady: true,
        retireAfterLease: false,
      });
    },

    run(request, opts = {}) {
      if (closed) {
        throw agentWebSocketLifecycleError("manager_closed");
      }
      validateAgentWebSocketRunIdentity({ runId: request.runId, requestId: request.requestId });
      const reservationId = opts.reservationId ?? request.requestId;
      let gen = opts.forceFresh
        ? undefined
        : generations.find((g) => g.preconnectReady && !g.leased && g.requestId === request.requestId);
      if (!gen) {
        gen = {
          reservationId,
          requestId: request.requestId,
          runId: request.runId,
          leased: false,
          preconnectReady: true,
          retireAfterLease: false,
        };
        generations.push(gen);
      }
      gen.leased = true;
      gen.runId = request.runId;
      let released = false;
      return {
        runId: request.runId,
        requestId: request.requestId,
        close() {
          if (released) return;
          released = true;
          gen!.leased = false;
          // Binary behavior: a generation flagged retireAfterLease is
          // retired as soon as it becomes idle.
          if (gen!.retireAfterLease) retireGeneration(gen!);
        },
      };
    },

    retireWhenIdle(cause = "unknown") {
      retirementDepth += 1;
      try {
        for (const gen of [...generations]) {
          gen.retireAfterLease = true;
          gen.deferredRetirementCause ??= cause;
        }
        for (const gen of [...generations]) {
          if (isIdle(gen)) retireGeneration(gen);
        }
      } finally {
        retirementDepth -= 1;
      }
    },

    close(_reason = "manager_closed") {
      if (!closed) {
        closed = true;
        for (const gen of [...generations]) retireGeneration(gen);
      }
    },
  };

  // LOCAL stand-in introspection (not part of the verified contract) —
  // attached non-enumerably so the enumerable surface stays exactly the
  // verified {run, preconnect, retireWhenIdle, close}.
  Object.defineProperty(manager, "occupancy", {
    value: () => generations.length,
    enumerable: false,
  });

  return manager;
}

// ---------------------------------------------------------------------------
// Local JSON representation (LOCAL ONLY — the socket wire framing bytes are
// UNKNOWN/minified; this is a debugging representation for the typed frame
// layer, not a claim about Cursor's wire bytes). bytes → base64, sequence
// (bigint) → decimal string.
// ---------------------------------------------------------------------------

type JsonFrame = {
  frame: {
    case: string;
    value: Record<string, unknown>;
  };
};

function frameToJsonable(frame: AgentWebSocketClientFrame | AgentWebSocketServerFrame): JsonFrame {
  const { case: caseName, value } = frame.frame as unknown as {
    case: string;
    value: Record<string, unknown>;
  };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (v instanceof Uint8Array) out[k] = Buffer.from(v).toString("base64");
    else if (typeof v === "bigint") out[k] = v.toString(10);
    else out[k] = v;
  }
  return { frame: { case: caseName, value: out } };
}

function jsonableToFrame(json: string): AgentWebSocketClientFrame | AgentWebSocketServerFrame {
  const parsed = JSON.parse(json) as JsonFrame;
  const { case: caseName, value } = parsed.frame;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (caseName.includes("essage") && k === "message" && typeof v === "string") {
      out[k] = Uint8Array.from(Buffer.from(v, "base64"));
    } else if (caseName.includes("essage") && k === "sequence" && typeof v === "string") {
      out[k] = BigInt(v);
    } else {
      out[k] = v;
    }
  }
  return { frame: { case: caseName, value: out } } as unknown as AgentWebSocketClientFrame;
}

export function encodeAgentWebSocketFrame(
  frame: AgentWebSocketClientFrame | AgentWebSocketServerFrame,
): string {
  return JSON.stringify(frameToJsonable(frame));
}

export function decodeAgentWebSocketClientFrame(json: string): AgentWebSocketClientFrame {
  return jsonableToFrame(json) as AgentWebSocketClientFrame;
}

export function decodeAgentWebSocketServerFrame(json: string): AgentWebSocketServerFrame {
  return jsonableToFrame(json) as AgentWebSocketServerFrame;
}
