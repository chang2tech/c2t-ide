/**
 * engineWire — pure (vscode-free) parsing of the ide-code engine's wire protocol.
 *
 * Kept separate from ideCodeEngineAdapter.ts so the protocol layer is
 * unit-testable in plain node without the vscode module. Every shape here is
 * verified against the real server sources:
 *
 *   SSE framing        → packages/server/src/event-feed.ts  (EventFeed.frame:
 *                        `data: ${JSON.stringify(event)}\n\n` — NO `event:` line;
 *                        the event type lives INSIDE the JSON as {id, type, data})
 *   permission.asked    → packages/schema/src/v1/permission.ts (Request.fields:
 *                        {id, sessionID, permission, patterns, metadata, always, tool?})
 *   permission reply    → packages/server/src/handlers/permission.ts
 *                        (session.permission.reply, payload {decision, message} →
 *                        reply({requestID, reply: decision, message}))
 *   session.error       → packages/schema/src/v1/session.ts (AssistantErrorSchema:
 *                        namedError(name, fields) → {name, data: {...}} — the
 *                        message lives at data.message, and
 *                        MessageOutputLengthError has NO message field at all)
 *   message.part.delta  → {sessionID, messageID, partID, field, delta}
 *   message.part.updated→ {sessionID, part}
 *   session.execution.* → Base = {sessionID}
 */

export interface SseEvent {
  type: string;
  data: any;
}

/**
 * Parse one SSE frame block (raw text between \n\n boundaries) into an event.
 *
 * Real server frames are `data: {"id":..., "type":"<event-type>", "data":{...}}`
 * with no `event:` line. An explicit `event:` line is also tolerated (some
 * proxies inject one); when present it wins over the JSON body's type.
 */
export function parseSse(raw: string): SseEvent | undefined {
  let declaredType = "";
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) {
      declaredType = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trim());
    }
    // Comment lines (": heartbeat") and empty lines are ignored.
  }
  const rawData = dataLines.join("\n");
  if (!rawData) {
    return undefined;
  }
  let payload: any;
  try {
    payload = JSON.parse(rawData);
  } catch {
    return undefined;
  }
  const type =
    declaredType ||
    (payload && typeof payload === "object" && typeof payload.type === "string"
      ? payload.type
      : "");
  if (!type) {
    return undefined;
  }
  const data =
    payload && typeof payload === "object" && "data" in payload
      ? payload.data
      : payload;
  return { type, data };
}

/** Real permission.asked request shape (Request.fields in v1/permission.ts). */
export interface PermissionRequest {
  requestID: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  metadata: Record<string, unknown>;
  always: string[];
  tool?: { messageID: string; callID: string };
}

/**
 * Validate the `data` of a `permission.asked` event against the real Request
 * shape. Returns undefined when required fields are missing or malformed —
 * callers must drop (not prompt for) such events rather than building cards
 * with garbage fields.
 */
export function parsePermissionRequest(d: unknown): PermissionRequest | undefined {
  if (!d || typeof d !== "object") {
    return undefined;
  }
  const o = d as Record<string, unknown>;
  if (typeof o.id !== "string" || !o.id) {
    return undefined;
  }
  if (typeof o.sessionID !== "string" || !o.sessionID) {
    return undefined;
  }
  if (typeof o.permission !== "string" || !o.permission) {
    return undefined;
  }
  const patterns = Array.isArray(o.patterns)
    ? o.patterns.filter((p): p is string => typeof p === "string")
    : [];
  const always = Array.isArray(o.always)
    ? o.always.filter((a): a is string => typeof a === "string")
    : [];
  const metadata =
    o.metadata && typeof o.metadata === "object" && !Array.isArray(o.metadata)
      ? (o.metadata as Record<string, unknown>)
      : {};
  const tool =
    o.tool && typeof o.tool === "object" && !Array.isArray(o.tool)
      ? {
          messageID:
            typeof (o.tool as Record<string, unknown>).messageID === "string"
              ? ((o.tool as Record<string, unknown>).messageID as string)
              : "",
          callID:
            typeof (o.tool as Record<string, unknown>).callID === "string"
              ? ((o.tool as Record<string, unknown>).callID as string)
              : "",
        }
      : undefined;
  return {
    requestID: o.id,
    sessionID: o.sessionID,
    permission: o.permission,
    patterns,
    metadata,
    always,
    tool,
  };
}

/**
 * Render a `session.error` payload as human-readable text.
 *
 * Real errors are namedError(name, fields) → {name, data: {...}}; the message
 * (when the variant has one) is at data.message. MessageOutputLengthError has
 * no message field, so the error NAME is rendered instead of "[object Object]".
 */
export function parseSessionErrorText(error: unknown): string {
  if (typeof error === "string") {
    return error || "unknown engine error";
  }
  if (error && typeof error === "object") {
    const o = error as Record<string, unknown>;
    const data = o.data;
    if (data && typeof data === "object") {
      const msg = (data as Record<string, unknown>).message;
      if (typeof msg === "string" && msg) {
        return msg;
      }
    }
    if (typeof o.message === "string" && o.message) {
      return o.message;
    }
    if (typeof o.name === "string" && o.name) {
      return `Engine error: ${o.name}`;
    }
  }
  return "unknown engine error";
}

/** Validate a server-returned session ID before it becomes part of URLs. */
export function parseSessionID(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/** The engine reply values the server accepts (PermissionV1.Reply). */
export const ENGINE_REPLY = {
  once: "once",
  always: "always",
  reject: "reject",
} as const;
export type EngineReply = (typeof ENGINE_REPLY)[keyof typeof ENGINE_REPLY];
