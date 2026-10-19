/**
 * SSE frame parser for the ide-code engine sidecar stream.
 *
 * This module has NO dependency on `vscode` so it can be unit-tested with
 * plain node (the adapter itself requires the extension host).
 *
 * Wire format (~/workspace/ide-code/packages/server/src/event-feed.ts):
 *   EventFeed.frame = (event) => `data: ${JSON.stringify(event)}\n\n`
 * There is NO `event:` line. The event type lives INSIDE the JSON envelope
 * as { id, type, data }. A parser that requires an `event:` field silently
 * drops 100% of real server events — see QA-FILE-03 (P0).
 *
 * Heartbeat frames (": heartbeat") carry no data and parse to undefined.
 */

export interface SseEvent {
  type: string;
  data: any;
}

export function parseSse(raw: string): SseEvent | undefined {
  let type = "";
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) {
      type = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trim());
    }
  }
  if (dataLines.length === 0) {
    // Comment/heartbeat frame (": heartbeat") or empty frame.
    return undefined;
  }
  let data: any;
  try {
    data = JSON.parse(dataLines.join("\n"));
  } catch {
    return undefined;
  }
  if (type) {
    return { type, data };
  }
  // Real engine frame: no `event:` line — take the type from the JSON
  // envelope { id, type, data }.
  if (data && typeof data === "object" && typeof data.type === "string") {
    return { type: data.type, data: data.data };
  }
  return undefined;
}
