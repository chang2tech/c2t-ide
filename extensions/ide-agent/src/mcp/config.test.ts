/**
 * MCP config merge tests (node:test, zero extra deps).
 *
 * Covers the pure `mergeServerIntoMcpConfig` helper used by the
 * `composer.mcp.deeplinkInstall` command (deeplink-mcp-install): Cursor
 * parity with MCPInstallationService.installProposedServer — merge
 * `mcpServers[name] = server` into the user mcp.json document.
 *
 * Run after `tsc`:  node out/mcp/config.test.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import { mergeServerIntoMcpConfig } from "./config";
import type { McpServerConfig } from "./types";

const SERVER: McpServerConfig = { command: "npx", args: ["-y", "@example/mcp"], env: { KEY: "" } };

describe("mergeServerIntoMcpConfig (deeplink-mcp-install)", () => {
  it("creates a fresh document when no config exists", () => {
    const out = mergeServerIntoMcpConfig(undefined, "example", SERVER);
    assert.deepStrictEqual(JSON.parse(out), { mcpServers: { example: SERVER } });
    // Cursor writes JSON.stringify(doc, null, 2).
    assert.ok(out.includes('\n  "mcpServers"'));
  });

  it("merges into an existing document, keeping other servers and keys", () => {
    const existing = JSON.stringify({ mcpServers: { a: { command: "a" } }, other: 1 });
    const out = mergeServerIntoMcpConfig(existing, "example", SERVER);
    assert.deepStrictEqual(JSON.parse(out), {
      mcpServers: { a: { command: "a" }, example: SERVER },
      other: 1,
    });
  });

  it("overwrites a same-named server (Cursor: n.mcpServers[e.name] = e.server)", () => {
    const existing = JSON.stringify({ mcpServers: { example: { command: "old" } } });
    const out = mergeServerIntoMcpConfig(existing, "example", SERVER);
    assert.deepStrictEqual(JSON.parse(out).mcpServers.example, SERVER);
  });

  it("starts from a fresh document on corrupt JSON (Cursor: read error → keep {mcpServers:{}})", () => {
    const out = mergeServerIntoMcpConfig("{corrupt", "example", SERVER);
    assert.deepStrictEqual(JSON.parse(out), { mcpServers: { example: SERVER } });
  });

  it("starts from a fresh document when mcpServers is not an object", () => {
    const out = mergeServerIntoMcpConfig(JSON.stringify({ mcpServers: ["x"] }), "example", SERVER);
    assert.deepStrictEqual(JSON.parse(out), { mcpServers: { example: SERVER } });
  });

  it("starts from a fresh document for non-object JSON", () => {
    const out = mergeServerIntoMcpConfig(JSON.stringify([1, 2]), "example", SERVER);
    assert.deepStrictEqual(JSON.parse(out), { mcpServers: { example: SERVER } });
  });
});
