// IDE-CODE: Migrated from extensions/ide-agent/src/mcp/results.ts (CAT-A, pure logic).
/**
 * MCP tool result normalization — pure logic, vscode-free (unit-testable).
 *
 * Normalizes MCP content blocks → text + images (parity §B9: base64 image
 * returns are attached so the agent literally sees them).
 */

/** Normalized tool result. */
export interface McpCallResult {
  /** Concatenated text content. */
  text: string;
  /** Base64-encoded images returned by the tool (parity §B9). */
  images: Array<{ mimeType: string; data: string }>;
  /** True when the tool result was flagged as an error. */
  isError: boolean;
}

interface McpContentBlock {
  type?: string;
  text?: string;
  mimeType?: string;
  data?: string;
  resource?: unknown;
}

/** Normalize MCP content blocks → text + images. */
export function normalizeResult(raw: unknown): McpCallResult {
  const blocks = extractContentBlocks(raw);
  const textParts: string[] = [];
  const images: Array<{ mimeType: string; data: string }> = [];
  let isError = false;
  if (raw && typeof raw === "object" && (raw as { isError?: unknown }).isError === true) {
    isError = true;
  }
  for (const b of blocks) {
    if (b.type === "text" && typeof b.text === "string") {
      textParts.push(b.text);
    } else if (b.type === "image" && typeof b.data === "string") {
      images.push({ mimeType: b.mimeType ?? "image/png", data: b.data });
    } else if (b.type === "resource") {
      textParts.push(`[resource] ${JSON.stringify(b.resource)}`);
    }
  }
  return { text: textParts.join("\n"), images, isError };
}

function extractContentBlocks(raw: unknown): McpContentBlock[] {
  if (raw && typeof raw === "object") {
    const content = (raw as { content?: unknown }).content;
    if (Array.isArray(content)) {
      return content.filter((c): c is McpContentBlock => !!c && typeof c === "object");
    }
  }
  // Non-standard shape — surface it as text rather than dropping it.
  return [{ type: "text", text: typeof raw === "string" ? raw : JSON.stringify(raw) }];
}

/** Max text shown in chat before truncation (parity: keep cards scannable). */
const CHAT_TEXT_LIMIT = 4000;

/**
 * Render a normalized MCP result as chat markdown for the tool-call card.
 * Long text is truncated with a marker, images become numbered references
 * (the card attaches them so the agent literally sees them), errors render
 * as a callout so failures are visually distinct from successes.
 */
export function formatResultMarkdown(
  result: McpCallResult,
  toolLabel: string,
): string {
  const lines: string[] = [];
  lines.push(result.isError ? `**${toolLabel}** — failed` : `**${toolLabel}**`);
  let text = result.text;
  if (text.length > CHAT_TEXT_LIMIT) {
    text = text.slice(0, CHAT_TEXT_LIMIT) + `\n… [truncated, ${result.text.length - CHAT_TEXT_LIMIT} more characters]`;
  }
  if (text.trim()) {
    lines.push("", text);
  }
  for (let i = 0; i < result.images.length; i += 1) {
    const img = result.images[i];
    lines.push("", `![MCP image ${i + 1} (${img.mimeType})](mcp-image:${i})`);
  }
  if (!text.trim() && result.images.length === 0) {
    lines.push("", "_(no output)_");
  }
  return lines.join("\n");
}
