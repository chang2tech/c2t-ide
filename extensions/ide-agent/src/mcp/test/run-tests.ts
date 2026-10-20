/**
 * MCP module tests (node:test, zero extra deps).
 *
 * Unit: namespacing (§B4), variable expansion + config discovery + precedence
 * (§B1), allowlist patterns + precheck (§B5), result normalization.
 * Integration: a fake MCP server (node script speaking NDJSON JSON-RPC)
 * exercises the stdio client handshake, tools/list pagination, tools/call,
 * roots/list and server→client ping.
 *
 * Provider API: `cursor.registerMcpProvider()` (DEV-GAPS-8) — registry unit
 * tests plus McpService-level register/unregister/callTool tests. The
 * `./vscode-shim` import MUST stay first: it stubs `require("vscode")`
 * before `../service` loads under plain node.
 *
 * Run after `tsc`:  node out/mcp/test/run-tests.mjs
 */
import "./vscode-shim";
// W50D (mcp-symbolic-file-args): $file: symbolic argument tests live in
// ./symbolicFileArgs.test.ts — imported here so they run under the shim.
import "./symbolicFileArgs.test";
import { describe, it, before, after } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { toolName, parseToolName, approvalLabel, serverId, displayNameFor } from "../names";
import {
  discoverServers,
  expandVariables,
  expandServerConfig,
  parseEnvFile,
  detectTransport,
  extractRestMcpServerId,
} from "../config";
import { McpAllowlist, matchAllowlistPattern, normalizeGrantEntry } from "../allowlist";
import {
  ExtensionMcpGrantStore,
  InMemoryMcpGrantStore,
  MCP_ALLOWED_TOOLS_GLOBAL_KEY,
} from "../grantStore";
import { normalizeResult, formatResultMarkdown } from "../results";
import { McpStdioClient } from "../stdioClient";
import { McpHttpClient, McpAuthError, parseSseEvents } from "../httpClient";
import { McpServerManager, DEFAULT_MCP_RECONNECT_POLICY } from "../serverManager";
import { mcpApprovalOptions } from "../approvalOptions";
import { McpLogger, McpReconnectPolicy } from "../types";
import { McpProviderRegistry } from "../providerRegistry";
import type { McpProvider, McpProviderCallContext } from "../providerRegistry";
import { McpService } from "../service";
import { createCursorApi } from "../providerApi";
import {
  CURSOR_IDE_BROWSER_INSTRUCTIONS,
  CURSOR_IDE_BROWSER_PROVIDER_ID,
  CURSOR_IDE_BROWSER_TOOL_NAMES,
  createCursorIdeBrowserProvider,
} from "../../browser/browserMcpProvider";
import type { BrowserService } from "../../browser/service";

/* ---------- names (§B4 verbatim) ---------- */
describe("mcp names", () => {
  it("builds mcp__<server>__<tool>", () => {
    assert.strictEqual(toolName("fs", "read"), "mcp__fs__read");
  });
  it("parses back server + tool", () => {
    assert.deepStrictEqual(parseToolName("mcp__fs__read"), { server: "fs", tool: "read" });
  });
  it("keeps __ inside tool names (parts[2..])", () => {
    assert.deepStrictEqual(parseToolName("mcp__srv__a__b"), { server: "srv", tool: "a__b" });
  });
  it("rejects non-mcp names and short names", () => {
    assert.strictEqual(parseToolName("read"), undefined);
    assert.strictEqual(parseToolName("mcp__onlyserver"), undefined);
    assert.strictEqual(parseToolName("mcp____"), undefined);
  });
  it("approval label is MCP:<tool>", () => {
    assert.strictEqual(approvalLabel("fs", "read"), "MCP:read");
  });
  it("scope prefixes encode scope and strip for display", () => {
    assert.strictEqual(serverId("project", "fs"), "project-fs");
    assert.strictEqual(serverId("user", "fs"), "user-fs");
    assert.strictEqual(displayNameFor("project-fs"), "fs");
    assert.strictEqual(displayNameFor("user-fs"), "fs");
  });
});

/* ---------- variable expansion (§B1, docs list) ---------- */
describe("variable expansion", () => {
  const ctx = { workspaceFolder: path.join(os.tmpdir(), "wf"), env: { MY_KEY: "secret" } as NodeJS.ProcessEnv };
  it("expands ${env:NAME}", () => {
    assert.strictEqual(expandVariables("k=${env:MY_KEY}", ctx), "k=secret");
  });
  it("leaves unknown ${env:} literal", () => {
    const seen: string[] = [];
    assert.strictEqual(expandVariables("${env:NOPE}", ctx, (n) => seen.push(n)), "${env:NOPE}");
    assert.deepStrictEqual(seen, ["env:NOPE"]);
  });
  it("expands ${userHome}, ${workspaceFolder}, ${workspaceFolderBasename}, ${pathSeparator}, ${/}", () => {
    assert.strictEqual(expandVariables("${userHome}", ctx), os.homedir());
    assert.strictEqual(expandVariables("${workspaceFolder}", ctx), ctx.workspaceFolder);
    assert.strictEqual(expandVariables("${workspaceFolderBasename}", ctx), "wf");
    assert.strictEqual(expandVariables("a${pathSeparator}b", ctx), `a${path.sep}b`);
    assert.strictEqual(expandVariables("a${/}b", ctx), `a${path.sep}b`);
  });
  it("leaves unknown variables literal and reports them", () => {
    const seen: string[] = [];
    assert.strictEqual(expandVariables("x${input:foo}y", ctx, (n) => seen.push(n)), "x${input:foo}y");
    assert.deepStrictEqual(seen, ["input:foo"]);
  });
});

describe("envFile parsing", () => {
  it("parses KEY=VALUE with comments and quotes", () => {
    const env = parseEnvFile("# comment\nA=1\nB=\"two words\"\nC='three'\nEMPTY=\nNOEQ\n");
    assert.deepStrictEqual(env, { A: "1", B: "two words", C: "three", EMPTY: "" });
  });
});

/* ---------- config discovery + precedence ---------- */
describe("config discovery", () => {
  let root: string;
  let home: string;
  let oldHome: string | undefined;
  const logs: string[] = [];
  const logger: McpLogger = { appendLine: (m) => logs.push(m) };

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-root-"));
    home = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-home-"));
    oldHome = process.env.HOME;
    process.env.HOME = home; // os.homedir() follows $HOME on linux
    fs.mkdirSync(path.join(root, ".cursor"), { recursive: true });
    fs.mkdirSync(path.join(root, ".vscode"), { recursive: true });
    fs.mkdirSync(path.join(home, ".cursor"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".cursor", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          proj: { command: "node", args: ["${workspaceFolder}/s.js"], env: { K: "${env:MY_KEY}" } },
          shared: { command: "from-project" },
        },
      }),
    );
    fs.writeFileSync(
      path.join(home, ".cursor", "mcp.json"),
      JSON.stringify({ mcpServers: { shared: { command: "from-user" }, useronly: { command: "u" } } }),
    );
    fs.writeFileSync(
      path.join(root, ".vscode", "mcp.json"),
      JSON.stringify({ mcpServers: { vsc: { command: "v" } } }),
    );
    process.env.MY_KEY = "secret";
  });

  after(() => {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    delete process.env.MY_KEY;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("project > user > vscode precedence, first-wins on name", () => {
    const servers = discoverServers({ workspaceFolders: [root], logger });
    const byName = new Map(servers.map((s) => [s.displayName, s]));
    assert.strictEqual(byName.get("shared")?.scope, "project");
    assert.strictEqual(byName.get("shared")?.config.command, "from-project");
    assert.strictEqual(byName.get("useronly")?.scope, "user");
    assert.strictEqual(byName.get("vsc")?.scope, "vscode");
    assert.strictEqual(servers.length, 4);
  });

  it("expands variables and injects stdio env", () => {
    const servers = discoverServers({ workspaceFolders: [root], logger });
    const proj = servers.find((s) => s.displayName === "proj")!;
    assert.deepStrictEqual(proj.config.args, [path.join(root, "s.js")]);
    assert.strictEqual(proj.config.env?.["K"], "secret");
    assert.strictEqual(proj.config.env?.["WORKSPACE_FOLDER_PATHS"], root);
    assert.strictEqual(proj.config.env?.["npm_config_yes"], "true");
    assert.strictEqual(proj.config.env?.["NPM_CONFIG_YES"], "true");
  });

  it("scoped ids encode scope", () => {
    const servers = discoverServers({ workspaceFolders: [root], logger });
    const proj = servers.find((s) => s.displayName === "proj")!;
    assert.strictEqual(proj.id, "project-proj");
  });

  it("ignores invalid JSON without throwing", () => {
    fs.writeFileSync(path.join(root, ".cursor", "mcp.json"), "{ broken");
    const servers = discoverServers({ workspaceFolders: [root], logger });
    // project file broken → user/vscode servers still discovered
    assert.ok(servers.some((s) => s.displayName === "useronly"));
    assert.ok(logs.some((l) => l.includes("invalid JSON")));
  });
});

describe("transport detection", () => {
  it("command → stdio, url → streamableHttp/sse, else unknown", () => {
    assert.strictEqual(detectTransport({ command: "npx" }), "stdio");
    assert.strictEqual(detectTransport({ url: "https://x/mcp" }), "streamableHttp");
    assert.strictEqual(detectTransport({ url: "https://x", transportType: "sse" }), "sse");
    assert.strictEqual(detectTransport({}), "unknown");
  });

  // WORKER-GAPS-32C (mcp-transport-types): Cursor's binary enum is camelCase
  // `streamableHttp` (cursor-mcp/dist/main.js 3.25.9); the legacy snake_case
  // spelling is accepted at the parse boundary and normalized to canonical.
  it("accepts both streamableHttp and streamable_http spellings", () => {
    assert.strictEqual(
      detectTransport({ url: "https://x/mcp", transportType: "streamableHttp" }),
      "streamableHttp",
    );
    assert.strictEqual(
      detectTransport({ url: "https://x/mcp", transportType: "streamable_http" }),
      "streamableHttp",
    );
    // unknown spellings fall through to the default HTTP transport (parity:
    // binary compares n.type against "streamableHttp" only)
    assert.strictEqual(
      detectTransport({ url: "https://x/mcp", transportType: "websocket" }),
      "streamableHttp",
    );
  });
});

describe("rest-mcp hosted gateway detection", () => {
  // WORKER-GAPS-32C (mcp-transport-types): verbatim binary predicate
  // `/^\/rest-mcp\/([^/]+)\/mcp\/?$/` on the URL pathname
  // (cursor-mcp/dist/main.js 3.25.9).
  it("extracts the gateway server id from gateway URLs", () => {
    assert.strictEqual(
      extractRestMcpServerId("https://api.cursor.sh/rest-mcp/my-server/mcp"),
      "my-server",
    );
    // optional trailing slash
    assert.strictEqual(
      extractRestMcpServerId("https://api.cursor.sh/rest-mcp/my-server/mcp/"),
      "my-server",
    );
    // ids are single path segments
    assert.strictEqual(
      extractRestMcpServerId("https://api.cursor.sh/rest-mcp/a-b_c.1/mcp"),
      "a-b_c.1",
    );
  });

  it("returns undefined for non-gateway URLs", () => {
    assert.strictEqual(extractRestMcpServerId("https://x/mcp"), undefined);
    assert.strictEqual(
      extractRestMcpServerId("https://api.cursor.sh/rest-mcp/mcp"),
      undefined,
    );
    assert.strictEqual(
      extractRestMcpServerId("https://api.cursor.sh/rest-mcp/a/b/mcp"),
      undefined,
    );
    assert.strictEqual(
      extractRestMcpServerId("https://api.cursor.sh/rest-mcp/a/mcp/extra"),
      undefined,
    );
    // binary returns early on unparseable/undefined input
    assert.strictEqual(extractRestMcpServerId("not a url"), undefined);
    assert.strictEqual(extractRestMcpServerId(undefined), undefined);
    assert.strictEqual(extractRestMcpServerId(""), undefined);
  });

  it("discoverServers records gatewayServerId for gateway URLs", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-gw-"));
    const logs: string[] = [];
    try {
      fs.mkdirSync(path.join(dir, ".cursor"), { recursive: true });
      fs.writeFileSync(
        path.join(dir, ".cursor", "mcp.json"),
        JSON.stringify({
          mcpServers: {
            gw: { url: "https://api.cursor.sh/rest-mcp/acme-docs/mcp" },
            plain: { url: "https://example.com/mcp" },
          },
        }),
      );
      const servers = discoverServers({ workspaceFolders: [dir], logger: { appendLine: (m: string) => logs.push(m) } });
      const gw = servers.find((s) => s.displayName === "gw");
      const plain = servers.find((s) => s.displayName === "plain");
      assert.strictEqual(gw?.gatewayServerId, "acme-docs");
      assert.strictEqual(gw?.transport, "streamableHttp");
      assert.strictEqual(plain?.gatewayServerId, undefined);
      assert.strictEqual(plain?.transport, "streamableHttp");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("expandServerConfig envFile", () => {
  it("merges envFile under explicit env", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-env-"));
    const logs: string[] = [];
    try {
      fs.writeFileSync(path.join(dir, "s.env"), "A=fromfile\nB=fromfile\n");
      const out = expandServerConfig(
        { command: "x", envFile: "s.env", env: { B: "explicit" } },
        { workspaceFolders: [dir], configDir: dir, logger: { appendLine: (m) => logs.push(m) } },
      );
      assert.strictEqual(out.env?.["A"], "fromfile");
      assert.strictEqual(out.env?.["B"], "explicit");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ---------- allowlist (§B5) ---------- */
describe("allowlist patterns", () => {
  it("matches server:tool, server:*, *:tool, *:*", () => {
    assert.ok(matchAllowlistPattern("fs:read", "fs", "read"));
    assert.ok(!matchAllowlistPattern("fs:read", "fs", "write"));
    assert.ok(matchAllowlistPattern("fs:*", "fs", "anything"));
    assert.ok(!matchAllowlistPattern("other:*", "fs", "read"));
    assert.ok(matchAllowlistPattern("*:read", "fs", "read"));
    assert.ok(matchAllowlistPattern("*:*", "fs", "read"));
    assert.ok(!matchAllowlistPattern("no-colon", "fs", "read"));
  });
});

describe("precheck", () => {
  let root: string;
  const logger: McpLogger = { appendLine: () => {} };
  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-al-"));
    fs.mkdirSync(path.join(root, ".cursor"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".cursor", "permissions.json"),
      JSON.stringify({ mcpAllowlist: ["fs:read", "git:*"] }),
    );
    // Legacy fabricated file: Cursor has no `mcp-approvals.json` (0 hits in
    // the 3.25.9 glass+desktop bundles). It must be IGNORED, even when it
    // records a deny.
    fs.writeFileSync(
      path.join(root, ".cursor", "mcp-approvals.json"),
      JSON.stringify({ approvals: { "fs:write": "deny", "fs:delete": "ask", "net:fetch": "allow" } }),
    );
  });
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  it("permissions.json allowlist still allows; legacy mcp-approvals.json is ignored", () => {
    const al = new McpAllowlist([root], logger, new InMemoryMcpGrantStore());
    // Legacy file says deny/ask — must NOT be honored (binary: file absent).
    assert.strictEqual(al.precheck("fs", "write").decision, "ask");
    assert.strictEqual(al.precheck("fs", "delete").decision, "ask");
    // Legacy file says allow — must NOT be honored either.
    assert.strictEqual(al.precheck("net", "fetch").decision, "ask");
    // permissions.json (real Cursor surface) still works.
    assert.strictEqual(al.precheck("fs", "read").decision, "allow"); // exact
    assert.strictEqual(al.precheck("git", "push").decision, "allow"); // git:*
    const ask = al.precheck("fs", "exec");
    assert.strictEqual(ask.decision, "ask");
    assert.ok(ask.reason.includes("mcpToolsProtection"));
  });

  it("global grants allow (case-insensitive consult), chat grants are composer-scoped", () => {
    const store = new InMemoryMcpGrantStore();
    const al = new McpAllowlist([root], logger, store);
    assert.strictEqual(al.precheck("srv", "tool", "chat-1").decision, "ask");

    // "Always allow" → user-global: visible to every composer, persistent.
    al.rememberAlwaysAllow("srv", "tool");
    assert.deepStrictEqual(store.getGlobalGrants(), ["srv:tool"]);
    assert.strictEqual(al.precheck("srv", "tool", "chat-1").decision, "allow");
    assert.strictEqual(al.precheck("srv", "tool", "chat-2").decision, "allow");
    // Case-insensitive consult (binary WFf).
    assert.strictEqual(al.precheck("SRV", "TOOL", "chat-1").decision, "allow");
  });

  it("chat grants scope to one composer and never leak across chats", () => {
    const store = new InMemoryMcpGrantStore();
    const al = new McpAllowlist([root], logger, store);
    // One-shot RUN → per-composer memory (mcpAllowedToolsForChat).
    al.rememberChatGrant("chat-1", "srv", "tool");
    assert.strictEqual(al.precheck("srv", "tool", "chat-1").decision, "allow");
    assert.strictEqual(al.precheck("srv", "tool", "chat-2").decision, "ask");
    assert.strictEqual(al.precheck("srv", "tool").decision, "ask");
    assert.deepStrictEqual(store.getChatGrants("chat-1"), ["srv:tool"]);
    assert.deepStrictEqual(store.getChatGrants("chat-2"), []);
  });

  it("write-dedupe is case-sensitive (binary K?.includes(W))", () => {
    const store = new InMemoryMcpGrantStore();
    const al = new McpAllowlist([root], logger, store);
    al.rememberAlwaysAllow("srv", "tool");
    al.rememberAlwaysAllow("srv", "tool");
    assert.deepStrictEqual(store.getGlobalGrants(), ["srv:tool"]);
  });

  it("normalizeGrantEntry trims to server:tool", () => {
    assert.strictEqual(normalizeGrantEntry(" srv ", " tool "), "srv:tool");
  });

  it("works with no grant store (permissions.json only)", () => {
    const al = new McpAllowlist([root], logger);
    assert.strictEqual(al.precheck("fs", "read").decision, "allow");
    assert.strictEqual(al.precheck("srv", "tool").decision, "ask");
  });
});

/* ---------- result normalization ---------- */
describe("normalizeResult", () => {
  it("joins text blocks, extracts images, flags errors", () => {
    const r = normalizeResult({
      content: [
        { type: "text", text: "hello" },
        { type: "text", text: "world" },
        { type: "image", mimeType: "image/png", data: "AAA=" },
      ],
      isError: true,
    });
    assert.strictEqual(r.text, "hello\nworld");
    assert.deepStrictEqual(r.images, [{ mimeType: "image/png", data: "AAA=" }]);
    assert.strictEqual(r.isError, true);
  });
  it("surfaces non-standard shapes as text", () => {
    assert.strictEqual(normalizeResult("plain").text, "plain");
    assert.strictEqual(normalizeResult({ weird: 1 }).text, JSON.stringify({ weird: 1 }));
  });
});

/* ---------- stdio client integration (fake server) ---------- */
const FAKE_SERVER = `
const rl = require("readline").createInterface({ input: process.stdin });
let toolListCalls = 0;
rl.on("line", (line) => {
  if (!line.trim()) return;
  const m = JSON.parse(line);
  const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
  if (m.method === "initialize") {
    send({ jsonrpc: "2.0", id: m.id, result: {
      protocolVersion: "2024-11-05",
      serverInfo: { name: "fake", version: "1.0" },
      capabilities: { tools: {} } } });
  } else if (m.method === "tools/list") {
    toolListCalls++;
    send({ jsonrpc: "2.0", id: m.id, result: { tools: [
      { name: "echo", description: "echo back", inputSchema: { type: "object", properties: { text: { type: "string" } } } }
    ] } });
  } else if (m.method === "tools/call") {
    if (m.params.name === "slow") {
      // never answer → client timeout path (test uses short timeout)
      return;
    }
    send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "echo:" + m.params.arguments.text }] } });
  } else if (m.method === "ping") {
    send({ jsonrpc: "2.0", id: m.id, result: {} });
  } else {
    send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "nope" } });
  }
});
// server→client traffic: a ping the client must answer, then a notification
setTimeout(() => {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: "srv-1", method: "ping" }) + "\\n");
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }) + "\\n");
}, 200);
`;

describe("stdio client", () => {
  let dir: string;
  let serverJs: string;
  const logger: McpLogger = { appendLine: () => {} };

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-fake-"));
    serverJs = path.join(dir, "fake.cjs");
    fs.writeFileSync(serverJs, FAKE_SERVER);
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  function makeClient(onNotification?: (n: { method: string }) => void): McpStdioClient {
    return new McpStdioClient({
      command: process.execPath,
      args: [serverJs],
      env: {},
      cwd: dir,
      roots: [dir],
      logger,
      onNotification: onNotification as never,
    });
  }

  it("handshakes, lists tools, calls a tool, answers ping + roots", async () => {
    const notifications: string[] = [];
    const client = makeClient((n) => notifications.push(n.method));
    try {
      const init = await client.start();
      assert.strictEqual(init.serverInfo.name, "fake");
      const tools = await client.listTools();
      assert.strictEqual(tools.length, 1);
      assert.strictEqual(tools[0].name, "echo");
      const res = (await client.callTool("echo", { text: "hi" })) as {
        content: Array<{ text: string }>;
      };
      assert.strictEqual(res.content[0].text, "echo:hi");
      // server→client ping answered (no hang) + notification relayed
      await new Promise((r) => setTimeout(r, 500));
      assert.ok(notifications.includes("notifications/tools/list_changed"));
    } finally {
      client.stop();
    }
  });

  it("times out a hung tool call", async () => {
    const client = makeClient();
    try {
      await client.start();
      await assert.rejects(() => client.callTool("slow", {}, 300), /timed out/);
    } finally {
      client.stop();
    }
  });

  it("fails fast when the command does not exist", async () => {
    const client = new McpStdioClient({
      command: path.join(dir, "nope-binary"),
      args: [],
      env: {},
      cwd: dir,
      roots: [dir],
      logger,
    });
    await assert.rejects(() => client.start(), /MCP initialize failed/);
    client.stop();
  });
});

/* ---------- SSE transport (DEV-MCP-SSE) ---------- */
describe("sse parsing", () => {
  it("splits events on blank lines, skips comments", () => {
    const { ready, remainder } = parseSseEvents(
      ': heartbeat\n\nevent: message\ndata: {"a":1}\n\nevent: endpoint\ndata: /msg\n\n',
    );
    assert.strictEqual(ready.length, 2);
    assert.strictEqual(ready[0].event, "message");
    assert.strictEqual(ready[0].data, '{"a":1}');
    assert.strictEqual(ready[1].event, "endpoint");
    assert.strictEqual(remainder, "");
  });

  it("streaming mode keeps the partial tail", () => {
    const { ready, remainder } = parseSseEvents('event: message\ndata: {"a":', true);
    assert.strictEqual(ready.length, 0);
    assert.strictEqual(remainder, 'event: message\ndata: {"a":');
  });

  it("joins multi-line data with newlines", () => {
    const { ready } = parseSseEvents("data: line1\ndata: line2\n\n");
    assert.strictEqual(ready[0].data, "line1\nline2");
  });
});

describe("http transport config", () => {
  it("url + transportType sse → sse; plain url → streamableHttp", () => {
    assert.strictEqual(detectTransport({ url: "https://x/sse", transportType: "sse" }), "sse");
    assert.strictEqual(detectTransport({ url: "https://x/mcp" }), "streamableHttp");
  });

  it("expands variables in url and headers", () => {
    process.env.MCP_TEST_PORT = "9999";
    process.env.MCP_TEST_TOK = "abc";
    try {
      const out = expandServerConfig(
        { url: "https://x/${env:MCP_TEST_PORT}/mcp", headers: { Authorization: "Bearer ${env:MCP_TEST_TOK}" } },
        { workspaceFolders: ["/ws"], configDir: "/ws", logger: { appendLine: () => undefined } },
      );
      assert.strictEqual(out.url, "https://x/9999/mcp");
      assert.strictEqual(out.headers?.Authorization, "Bearer abc");
    } finally {
      delete process.env.MCP_TEST_PORT;
      delete process.env.MCP_TEST_TOK;
    }
  });
});

describe("approval persistence (Cursor 3.25.9 parity)", () => {
  it("rememberAlwaysAllow persists to the user-global key with no TTL", () => {
    const logger: McpLogger = { appendLine: () => undefined };
    const store = new InMemoryMcpGrantStore();
    const al = new McpAllowlist([], logger, store);
    assert.strictEqual(al.precheck("srv", "tool", "chat-1").decision, "ask");
    al.rememberAlwaysAllow("srv", "tool");
    // A FRESH allowlist over the same store sees the grant (no reload needed,
    // no expiry): the grant is user-global, not per-folder.
    const al2 = new McpAllowlist([], logger, store);
    assert.strictEqual(al2.precheck("srv", "tool", "chat-9").decision, "allow");
  });

  it("global key is the verbatim Cursor storage key", () => {
    assert.strictEqual(MCP_ALLOWED_TOOLS_GLOBAL_KEY, "composerState.mcpAllowedTools");
  });

  it("ExtensionMcpGrantStore round-trips through a memento", async () => {
    const backing = new Map<string, unknown>();
    const memento = {
      get: <T,>(key: string, def: T): T =>
        (backing.has(key) ? (backing.get(key) as T) : def),
      update: (key: string, value: unknown): Promise<void> => {
        backing.set(key, value);
        return Promise.resolve();
      },
    };
    const store = new ExtensionMcpGrantStore(memento);
    store.addGlobalGrant("srv:tool");
    store.addGlobalGrant("srv:tool"); // dedupe
    store.addChatGrant("c1", "srv:other");
    await new Promise((r) => setTimeout(r, 0));
    assert.deepStrictEqual(store.getGlobalGrants(), ["srv:tool"]);
    assert.deepStrictEqual(store.getChatGrants("c1"), ["srv:other"]);
    assert.deepStrictEqual(store.getChatGrants("c2"), []);
    // Corrupt/foreign values are filtered, never crash the precheck.
    backing.set(MCP_ALLOWED_TOOLS_GLOBAL_KEY, { not: "an array" });
    assert.deepStrictEqual(store.getGlobalGrants(), []);
  });

  it("mcpApprovalOptions offers once/always/deny/skip", () => {
    const ids = mcpApprovalOptions("srv", "tool").map((o) => o.id);
    assert.deepStrictEqual(ids, ["approve-once", "approve-always", "deny-always", "skip"]);
  });
});

describe("formatResultMarkdown", () => {
  it("renders text, error callout, truncation, images", () => {
    const ok = formatResultMarkdown({ text: "hello", images: [], isError: false }, "mcp__s__t");
    assert.ok(ok.includes("**mcp__s__t**") && ok.includes("hello"));
    const err = formatResultMarkdown({ text: "boom", images: [], isError: true }, "mcp__s__t");
    assert.ok(err.includes("failed") && err.includes("boom"));
    const long = formatResultMarkdown({ text: "x".repeat(5000), images: [], isError: false }, "t");
    assert.ok(long.includes("[truncated") && long.length < 5000);
    const img = formatResultMarkdown(
      { text: "", images: [{ mimeType: "image/png", data: "AAA" }], isError: false },
      "t",
    );
    assert.ok(img.includes("MCP image 1 (image/png)"));
  });
});

/* ============================================================
 * QA-MCPSSE-01 fix verification (DEV-FIX-MCPSSE + findings X1/X3).
 * Live fake-server probes for the P1/P2 fixes.
 * ============================================================ */

const silentLogger = { appendLine: (_m: string) => undefined };

function startHttpServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: (server.address() as { port: number }).port });
    });
  });
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

const PROBE_INIT_RESULT = {
  protocolVersion: "2024-11-05",
  capabilities: {},
  serverInfo: { name: "probe", version: "1.0" },
};

function jsonRpc(id: unknown, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

describe("fix P1-1: legacy endpoint detection uses streaming parse (X3: event-only)", () => {
  // Replicates the onData loop in openLegacySseStream: only complete
  // `event: endpoint` events resolve the message URL.
  function detectEndpoint(chunks: string[]): string | undefined {
    let buf = "";
    for (const chunk of chunks) {
      buf += chunk;
      for (const evt of parseSseEvents(buf, true).ready) {
        if (evt.event === "endpoint" && evt.data.trim()) {
          return new URL(evt.data.trim(), "http://base/x").toString();
        }
      }
    }
    return undefined;
  }

  it("does not resolve a partial endpoint chunk as an empty URL", () => {
    assert.strictEqual(detectEndpoint(["event: endpoint\nda"]), undefined);
  });

  it("resolves once the chunk completes", () => {
    assert.strictEqual(
      detectEndpoint(["event: endpoint\nda", "ta: /messages\n\n"]),
      "http://base/messages",
    );
  });

  it("ignores data-only lines sent before the endpoint event (X3 P3)", () => {
    assert.strictEqual(detectEndpoint(['data: {"hello":1}\n\n']), undefined);
    assert.strictEqual(
      detectEndpoint(['data: {"hello":1}\n\n', "event: endpoint\ndata: /m\n\n"]),
      "http://base/m",
    );
  });
});

describe("precheck merges allow sources across ALL folders (Cursor parity)", () => {
  let dirA = "";
  let dirB = "";
  before(() => {
    dirA = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-fix-a-"));
    dirB = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-fix-b-"));
    for (const d of [dirA, dirB]) fs.mkdirSync(path.join(d, ".cursor"), { recursive: true });
    // permissions.json allowlists (real Cursor surface) in both folders.
    fs.writeFileSync(
      path.join(dirA, ".cursor", "permissions.json"),
      JSON.stringify({ mcpAllowlist: ["srv:tool"] }),
    );
    fs.writeFileSync(
      path.join(dirB, ".cursor", "permissions.json"),
      JSON.stringify({ mcpAllowlist: ["other:tool"] }),
    );
    // Legacy fabricated file: must be ignored even when it records deny/ask.
    fs.writeFileSync(
      path.join(dirB, ".cursor", "mcp-approvals.json"),
      JSON.stringify({ approvals: { "srv:tool": "deny", "srv:other": "ask" } }),
    );
  });
  after(() => {
    for (const d of [dirA, dirB]) fs.rmSync(d, { recursive: true, force: true });
  });

  it("allow from ANY folder's permissions.json wins, regardless of folder order", () => {
    const store = new InMemoryMcpGrantStore();
    const d1 = new McpAllowlist([dirA, dirB], silentLogger, store).precheck("srv", "tool");
    const d2 = new McpAllowlist([dirB, dirA], silentLogger, store).precheck("other", "tool");
    assert.strictEqual(d1.decision, "allow");
    assert.strictEqual(d2.decision, "allow");
  });

  it("legacy deny in mcp-approvals.json no longer blocks (file is not read)", () => {
    // dirB's legacy file says deny for srv:tool — must NOT be honored.
    const d = new McpAllowlist([dirB], silentLogger, new InMemoryMcpGrantStore()).precheck(
      "srv",
      "tool",
    );
    assert.strictEqual(d.decision, "ask");
  });

  it("global grants apply across folders without reload", () => {
    const store = new InMemoryMcpGrantStore();
    const al = new McpAllowlist([dirA, dirB], silentLogger, store);
    assert.strictEqual(al.precheck("srv", "other").decision, "ask");
    al.rememberAlwaysAllow("srv", "other");
    assert.strictEqual(al.precheck("srv", "other").decision, "allow");
  });
});

describe("fix P2-2: McpRetryableError is retried with backoff (max 3 attempts)", () => {
  it("retries 429 twice then succeeds", async () => {
    let posts = 0;
    const { server, port } = await startHttpServer(async (req, res) => {
      const msg = JSON.parse(await readBody(req));
      posts += 1;
      if (posts <= 2) {
        res.writeHead(429, { "retry-after": "0" });
        res.end();
        return;
      }
      if (msg.method === "initialize") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(jsonRpc(msg.id, PROBE_INIT_RESULT));
      } else if (msg.method === "notifications/initialized") {
        res.writeHead(202);
        res.end();
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(jsonRpc(msg.id, { content: [{ type: "text", text: "ok" }] }));
      }
    });
    const client = new McpHttpClient({
      url: `http://127.0.0.1:${port}/mcp`,
      headers: undefined,
      legacySse: false,
      roots: [],
      logger: silentLogger,
    });
    try {
      await client.start();
      const r = (await client.callTool("t", {})) as { content: Array<{ text: string }> };
      assert.strictEqual(r.content[0].text, "ok");
      // initialize + initialized + 3 call attempts (429, 429, 200)
      assert.strictEqual(posts, 5);
    } finally {
      client.stop();
      server.close();
    }
  });

  it("gives up after 3 attempts with a clear error", async () => {
    let posts = 0;
    const { server, port } = await startHttpServer(async (req, res) => {
      const msg = JSON.parse((await readBody(req)) || "{}");
      if (msg.method === "initialize") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(jsonRpc(msg.id, PROBE_INIT_RESULT));
        return;
      }
      if (msg.method === "notifications/initialized") {
        res.writeHead(202);
        res.end();
        return;
      }
      posts += 1;
      res.writeHead(503, { "retry-after": "0" });
      res.end();
    });
    const client = new McpHttpClient({
      url: `http://127.0.0.1:${port}/mcp`,
      headers: undefined,
      legacySse: false,
      roots: [],
      logger: silentLogger,
    });
    try {
      await client.start();
      await assert.rejects(() => client.callTool("t", {}), /temporarily unavailable.*3 attempts/);
      assert.strictEqual(posts, 3);
    } finally {
      client.stop();
      server.close();
    }
  });
});

describe("fix P2-1: POST 404 re-handshakes and retries the original request", () => {
  it("recovers the tool call on a fresh session", async () => {
    let inits = 0;
    let firstCall = true;
    const { server, port } = await startHttpServer(async (req, res) => {
      if (req.method === "GET") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        return; // keep the stream open; client.stop() aborts it
      }
      const msg = JSON.parse(await readBody(req));
      if (msg.method === "initialize") {
        inits += 1;
        res.writeHead(200, {
          "content-type": "application/json",
          "mcp-session-id": `s${inits}`,
        });
        res.end(jsonRpc(msg.id, PROBE_INIT_RESULT));
        return;
      }
      if (msg.method === "notifications/initialized") {
        res.writeHead(202);
        res.end();
        return;
      }
      if (msg.method === "tools/call" && firstCall) {
        firstCall = false;
        res.writeHead(404); // transient session expiry
        res.end();
        return;
      }
      const sid = req.headers["mcp-session-id"];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(jsonRpc(msg.id, { content: [{ type: "text", text: `ok:${sid}` }] }));
    });
    const client = new McpHttpClient({
      url: `http://127.0.0.1:${port}/mcp`,
      headers: undefined,
      legacySse: false,
      roots: [],
      logger: silentLogger,
    });
    try {
      await client.start();
      const r = (await client.callTool("t", {})) as { content: Array<{ text: string }> };
      assert.strictEqual(inits, 2, "expected exactly one re-handshake");
      assert.strictEqual(r.content[0].text, "ok:s2", "request retried on the fresh session");
    } finally {
      client.stop();
      server.closeAllConnections();
      server.close();
    }
  });
});

describe("fix P1-4: mid-session 401/403 marks the server failed", () => {
  it("callTool 401 → state failed with actionable error", async () => {
    const { server, port } = await startHttpServer(async (req, res) => {
      if (req.method === "GET") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        return; // keep open
      }
      const msg = JSON.parse((await readBody(req)) || "{}");
      if (msg.method === "initialize") {
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s1" });
        res.end(jsonRpc(msg.id, PROBE_INIT_RESULT));
        return;
      }
      if (msg.method === "notifications/initialized") {
        res.writeHead(202);
        res.end();
        return;
      }
      if (msg.method === "tools/list") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(jsonRpc(msg.id, { tools: [{ name: "t", inputSchema: { type: "object" } }] }));
        return;
      }
      res.writeHead(401); // token expired mid-session
      res.end();
    });
    const mgr = new McpServerManager(
      {
        id: "project-probe",
        displayName: "probe",
        scope: "project",
        sourcePath: "/tmp/probe-mcp.json",
        config: { args: [], url: `http://127.0.0.1:${port}/mcp` },
        transport: "streamableHttp",
      },
      [],
      silentLogger,
    );
    try {
      mgr.start();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("server never became ready")), 5000);
        const off = mgr.onEvent((e) => {
          if (e.kind === "stateChanged" && mgr.currentState === "ready") {
            clearTimeout(timer);
            off();
            resolve();
          }
        });
      });
      let thrown: unknown;
      try {
        await mgr.callTool("t", {});
      } catch (e) {
        thrown = e;
      }
      assert.ok(thrown instanceof McpAuthError, `expected McpAuthError, got: ${thrown}`);
      assert.strictEqual(mgr.currentState, "failed");
      assert.ok(
        mgr.error !== undefined && /configure headers/i.test(mgr.error),
        `actionable error message missing: ${mgr.error}`,
      );
    } finally {
      mgr.stop();
      server.closeAllConnections();
      server.close();
    }
  });
});

describe("fix P2-6: no auth headers leak to cross-origin legacy endpoints", () => {
  it("strips Authorization when the server-declared endpoint is a different origin", async () => {
    let seenHeaders: http.IncomingHttpHeaders | undefined;
    const { server: serverB, port: portB } = await startHttpServer(async (req, res) => {
      const msg = JSON.parse(await readBody(req));
      seenHeaders = req.headers;
      if (msg.method === "initialize") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(jsonRpc(msg.id, PROBE_INIT_RESULT));
      } else if (msg.method === "notifications/initialized") {
        res.writeHead(202);
        res.end();
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(jsonRpc(msg.id, { tools: [] }));
      }
    });
    const { server: serverA, port: portA } = await startHttpServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      // server-declared endpoint on a DIFFERENT origin (different port)
      res.write(`event: endpoint\ndata: http://127.0.0.1:${portB}/messages\n\n`);
      // keep the stream open; client.stop() aborts it
    });
    const client = new McpHttpClient({
      url: `http://127.0.0.1:${portA}/sse`,
      headers: { Authorization: "Bearer secret-token", "X-Custom": "keep-me" },
      legacySse: true,
      roots: [],
      logger: silentLogger,
    });
    try {
      await client.start();
      await client.listTools();
      assert.ok(seenHeaders, "message endpoint must have received the POST");
      assert.strictEqual(seenHeaders!.authorization, undefined, "Authorization must be stripped");
      assert.strictEqual(seenHeaders!["x-custom"], "keep-me", "non-auth headers are kept");
      assert.strictEqual(seenHeaders!["content-type"], "application/json");
    } finally {
      client.stop();
      serverA.closeAllConnections();
      serverA.close();
      serverB.closeAllConnections();
      serverB.close();
    }
  });
});

describe("fix P3-1: unknown variable names are redacted in logs", () => {
  it("logs a count, not the variable name", () => {
    const logs: string[] = [];
    expandServerConfig(
      { command: "x", env: { K: "${env:DEFINITELY_NOT_SET_12345}" } },
      {
        workspaceFolders: ["/ws"],
        configDir: "/ws",
        logger: { appendLine: (m: string) => logs.push(m) },
      },
    );
    const line = logs.find((l) => l.includes("unknown variable"));
    assert.ok(line, `expected a log line, got: ${logs.join(" | ")}`);
    assert.ok(!line.includes("DEFINITELY_NOT_SET_12345"), line);
    assert.ok(/\d+ unknown variable/.test(line), line);
  });
});

describe("fix P3-2: server names containing __ are rejected with a clear message", () => {
  it("skips the server and logs why", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-dunder-"));
    const logs: string[] = [];
    try {
      fs.mkdirSync(path.join(dir, ".cursor"), { recursive: true });
      fs.writeFileSync(
        path.join(dir, ".cursor", "mcp.json"),
        JSON.stringify({ mcpServers: { a__b: { command: "x" }, ok: { command: "y" } } }),
      );
      const servers = discoverServers({
        workspaceFolders: [dir],
        logger: { appendLine: (m: string) => logs.push(m) },
      });
      assert.ok(!servers.some((s) => s.displayName === "a__b"));
      assert.ok(servers.some((s) => s.displayName === "ok"));
      assert.ok(
        logs.some((l) => l.includes('"a__b"') && l.includes("__")),
        logs.join(" | "),
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("fix P3-3: truncated SSE in POST response fails fast", () => {
  it("rejects with a clear error instead of timing out", async () => {
    const { server, port } = await startHttpServer(async (req, res) => {
      const msg = JSON.parse(await readBody(req));
      if (msg.method === "initialize") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(jsonRpc(msg.id, PROBE_INIT_RESULT));
        return;
      }
      if (msg.method === "notifications/initialized") {
        res.writeHead(202);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end('event: message\ndata: {"jsonrpc":"2.0","id":"x","resu'); // truncated
    });
    const client = new McpHttpClient({
      url: `http://127.0.0.1:${port}/mcp`,
      headers: undefined,
      legacySse: false,
      roots: [],
      logger: silentLogger,
    });
    try {
      await client.start();
      await assert.rejects(() => client.callTool("t", {}, 2000), /truncated SSE/);
    } finally {
      client.stop();
      server.close();
    }
  });
});

describe("fix R1: 405 on the GET stream is streamUnsupported — no reconnect storm, POST keeps working", () => {
  it("marks the stream unsupported on first 405 and never re-GETs", async () => {
    let gets = 0;
    let onCloseFired = false;
    const { server, port } = await startHttpServer(async (req, res) => {
      if (req.method === "GET") {
        gets += 1;
        res.writeHead(405); // spec 2025-03-26: no standalone SSE stream offered
        res.end();
        return;
      }
      const msg = JSON.parse((await readBody(req)) || "{}");
      if (msg.method === "initialize") {
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s1" });
        res.end(jsonRpc(msg.id, PROBE_INIT_RESULT));
        return;
      }
      if (msg.method === "notifications/initialized") {
        res.writeHead(202);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(jsonRpc(msg.id, { content: [{ type: "text", text: "ok" }] }));
    });
    const client = new McpHttpClient({
      url: `http://127.0.0.1:${port}/mcp`,
      headers: undefined,
      legacySse: false,
      roots: [],
      logger: silentLogger,
      onClose: () => {
        onCloseFired = true;
      },
    });
    try {
      await client.start();
      const r = (await client.callTool("t", {})) as { content: Array<{ text: string }> };
      assert.strictEqual(r.content[0].text, "ok", "POST transport unaffected by 405 on GET");
      // Settle past the reconnect backoff floor (1000ms): any storm would re-GET.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const internals = client as unknown as Record<string, unknown>;
      assert.strictEqual(gets, 1, "exactly one GET — no reconnect storm");
      assert.strictEqual(internals.streamUnsupported, true, "405 ⇒ streamUnsupported");
      assert.strictEqual(internals.streamReconnectTimer, undefined, "no reconnect timer scheduled");
      assert.strictEqual(internals.streamReconnectInFlight, false, "no reconnect in flight");
      assert.strictEqual(internals.streamDead, false, "server must NOT be marked dead");
      assert.strictEqual(onCloseFired, false, "onClose must NOT fire on 405");
    } finally {
      client.stop();
      server.close();
    }
  });
});

describe("fix R2: GET-404 counter is independent from the drop-reconnect budget", () => {
  it("a stream blip followed by one GET 404 recovers via re-handshake, not permanent death", async () => {
    let gets = 0;
    let inits = 0;
    let streamRes: http.ServerResponse | undefined;
    const { server, port } = await startHttpServer(async (req, res) => {
      if (req.method === "GET") {
        gets += 1;
        if (gets === 1) {
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
          streamRes = res; // blip will drop this socket below
          return;
        }
        if (gets === 2) {
          res.writeHead(404); // one transient 404 on the reconnected GET
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        return; // keep open; client.stop() aborts it
      }
      const msg = JSON.parse((await readBody(req)) || "{}");
      if (msg.method === "initialize") {
        inits += 1;
        res.writeHead(200, {
          "content-type": "application/json",
          "mcp-session-id": `s${inits}`,
        });
        res.end(jsonRpc(msg.id, PROBE_INIT_RESULT));
        return;
      }
      if (msg.method === "notifications/initialized") {
        res.writeHead(202);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(jsonRpc(msg.id, { content: [{ type: "text", text: "ok" }] }));
    });
    // Blip: kill the held stream socket 150ms after it opened.
    setTimeout(() => streamRes?.destroy(), 150);
    const client = new McpHttpClient({
      url: `http://127.0.0.1:${port}/mcp`,
      headers: undefined,
      legacySse: false,
      roots: [],
      logger: silentLogger,
    });
    try {
      await client.start();
      // blip (150ms) + reconnect backoff (1000ms) + 404 recovery handshake
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const internals = client as unknown as Record<string, unknown>;
      assert.strictEqual(inits, 2, "one re-handshake after the GET 404");
      assert.ok(gets >= 3, `expected ≥3 GETs (initial, 404, fresh), got ${gets}`);
      assert.strictEqual(internals.streamUnsupported, false, "single 404 must NOT kill the stream");
      assert.strictEqual(internals.streamDead, false, "server must NOT be marked dead");
      const r = (await client.callTool("t", {})) as { content: Array<{ text: string }> };
      assert.strictEqual(r.content[0].text, "ok", "tools/call still works on the recovered session");
    } finally {
      client.stop();
      server.closeAllConnections();
      server.close();
    }
  });

  it("two consecutive GET 404s (fresh handshake in between) mark the stream unsupported — bounded, no reconnect", async () => {
    let gets = 0;
    const { server, port } = await startHttpServer(async (req, res) => {
      if (req.method === "GET") {
        gets += 1;
        res.writeHead(404); // server never offers the standalone stream
        res.end();
        return;
      }
      const msg = JSON.parse((await readBody(req)) || "{}");
      if (msg.method === "initialize") {
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "fresh" });
        res.end(jsonRpc(msg.id, PROBE_INIT_RESULT));
        return;
      }
      if (msg.method === "notifications/initialized") {
        res.writeHead(202);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(jsonRpc(msg.id, { content: [{ type: "text", text: "ok" }] }));
    });
    const client = new McpHttpClient({
      url: `http://127.0.0.1:${port}/mcp`,
      headers: undefined,
      legacySse: false,
      roots: [],
      logger: silentLogger,
    });
    try {
      await client.start();
      await new Promise((resolve) => setTimeout(resolve, 600));
      const internals = client as unknown as Record<string, unknown>;
      assert.strictEqual(gets, 2, `expected exactly 2 GETs (404 → re-handshake → 404), got ${gets}`);
      assert.strictEqual(internals.streamUnsupported, true, "second consecutive 404 ⇒ unsupported");
      assert.strictEqual(internals.streamNotFoundAttempts, 0, "404 counter resets after marking unsupported");
      assert.strictEqual(internals.streamReconnectAttempts, 0, "drop-reconnect budget untouched by 404s");
      assert.strictEqual(internals.streamReconnectTimer, undefined, "no reconnect timer for 404s");
      const r = (await client.callTool("t", {})) as { content: Array<{ text: string }> };
      assert.strictEqual(r.content[0].text, "ok", "POSTs keep working on the fresh session");
    } finally {
      client.stop();
      server.close();
    }
  });
});

/* ---------- cursor.registerMcpProvider (DEV-GAPS-8) ---------- */

interface FakeToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

const providerToolDefs: FakeToolDef[] = [
  {
    name: "ping",
    description: "Reply with pong.",
    parameters: { type: "object", properties: { msg: { type: "string" } } },
  },
  {
    name: "add",
    description: "Add two numbers.",
    parameters: {
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } },
      required: ["a", "b"],
    },
  },
];

interface FakeProvider extends McpProvider {
  calls: Array<{ name: string; args: Record<string, unknown>; ctx: McpProviderCallContext }>;
  turnEnded: unknown[];
  setTools(tools: FakeToolDef[]): void;
}

const makeFakeProvider = (id = "demo", overrides: Partial<McpProvider> = {}): FakeProvider => {
  const calls: FakeProvider["calls"] = [];
  const turnEnded: unknown[] = [];
  let tools: FakeToolDef[] = providerToolDefs.map((t) => ({ ...t }));
  return {
    id,
    name: `${id} display`,
    instructions: `Instructions for ${id}.`,
    async listOfferings() {
      return { tools: tools.map((t) => ({ ...t })), prompts: [], resources: [] };
    },
    async callTool(name, args, ctx) {
      calls.push({ name, args, ctx });
      return { content: [{ type: "text", text: `ok:${name}` }] };
    },
    async onTurnEnded(ctx) {
      turnEnded.push(ctx);
    },
    calls,
    turnEnded,
    setTools(next: FakeToolDef[]): void {
      tools = next.map((t) => ({ ...t }));
    },
    ...overrides,
  };
};

describe("mcp provider registry", () => {
  it("register → refresh → tools cached; unregister → gone", async () => {
    const reg = new McpProviderRegistry();
    const provider = makeFakeProvider("demo");
    const handle = reg.register(provider);
    assert.deepStrictEqual(reg.ids(), ["demo"]);
    assert.strictEqual(reg.getTools().length, 0, "no tools before offerings are fetched");
    await reg.refreshOfferings("demo");
    const tools = reg.getTools();
    assert.strictEqual(tools.length, 2);
    assert.deepStrictEqual(
      tools.map((t) => t.tool.name).sort(),
      ["add", "ping"],
    );
    handle.dispose();
    assert.deepStrictEqual(reg.ids(), []);
    assert.strictEqual(reg.getTools().length, 0);
  });

  it("rejects invalid providers", () => {
    const reg = new McpProviderRegistry();
    assert.throws(() => reg.register(makeFakeProvider("")), /provider\.id must be a non-empty string/);
    assert.throws(
      () => reg.register(makeFakeProvider("x", { listOfferings: undefined as never })),
      /must define listOfferings/,
    );
    assert.throws(
      () => reg.register(makeFakeProvider("x", { callTool: undefined as never })),
      /must define callTool/,
    );
  });

  it("duplicate id: last registration wins (Cursor extHost parity)", () => {
    const reg = new McpProviderRegistry();
    const first = makeFakeProvider("demo");
    const second = makeFakeProvider("demo", { instructions: "second" });
    reg.register(first);
    reg.register(second);
    assert.strictEqual(reg.get("demo")?.instructions, "second");
  });

  it("dispose is idempotent; unregister unknown id returns false", () => {
    const reg = new McpProviderRegistry();
    const handle = reg.register(makeFakeProvider("demo"));
    handle.dispose();
    handle.dispose();
    assert.strictEqual(reg.unregister("demo"), false);
    assert.strictEqual(reg.unregister("nope"), false);
  });

  it("callTool dispatches with Cursor-verbatim errors", async () => {
    const reg = new McpProviderRegistry();
    const provider = makeFakeProvider("demo");
    reg.register(provider);
    await reg.refreshOfferings("demo");
    await assert.rejects(
      reg.callTool("missing", "ping", {}, {}),
      /MCP provider with id 'missing' not found/,
    );
    await assert.rejects(
      reg.callTool("demo", "nope", {}, {}),
      /Tool "nope" was not found on "demo"\./,
    );
    const raw = await reg.callTool("demo", "ping", { msg: "hi" }, { composerId: "c1" });
    assert.deepStrictEqual(raw, { content: [{ type: "text", text: "ok:ping" }] });
    assert.deepStrictEqual(provider.calls[0], {
      name: "ping",
      args: { msg: "hi" },
      ctx: { composerId: "c1" },
    });
  });

  it("notifyTurnEnded fans out; one failing provider does not break others", async () => {
    const reg = new McpProviderRegistry();
    const good = makeFakeProvider("good");
    const bad = makeFakeProvider("bad", {
      async onTurnEnded() {
        throw new Error("boom");
      },
    });
    const silent = makeFakeProvider("silent", { onTurnEnded: undefined });
    reg.register(good);
    reg.register(bad);
    reg.register(silent);
    await reg.notifyTurnEnded({ conversationId: "conv-1" });
    assert.deepStrictEqual(good.turnEnded, [{ conversationId: "conv-1" }]);
  });

  it("onDidChange fires on register / refresh / unregister", async () => {
    const reg = new McpProviderRegistry();
    const kinds: string[] = [];
    const sub = reg.onDidChange((e) => kinds.push(e.kind));
    const handle = reg.register(makeFakeProvider("demo"));
    await reg.refreshOfferings("demo");
    handle.dispose();
    sub.dispose();
    assert.ok(kinds.includes("providersChanged"), `expected providersChanged, got ${kinds}`);
    assert.ok(kinds.includes("toolsChanged"), `expected toolsChanged, got ${kinds}`);
  });
});

describe("mcp provider via McpService (cursor.registerMcpProvider)", () => {
  const makeService = (approvalResult: { optionId: string } = { optionId: "approve-once" }) => {
    const approvals: Array<{ toolCallId: string; label: string }> = [];
    const fakeComposer = {
      composerId: "composer-9",
      reviews: {
        requestApproval: async (toolCallId: string, label: string) => {
          approvals.push({ toolCallId, label });
          return approvalResult;
        },
      },
    };
    const globalStateBacking = new Map<string, unknown>();
    const service = new McpService(
      {
        subscriptions: [],
        // McpService persists "Always allow" grants to globalState
        // (composerState.mcpAllowedTools, Cursor parity).
        globalState: {
          get<T>(key: string, def: T): T {
            return (globalStateBacking.has(key) ? globalStateBacking.get(key) : def) as T;
          },
          update(key: string, value: unknown): Promise<void> {
            globalStateBacking.set(key, value);
            return Promise.resolve();
          },
        },
      } as never,
      () => fakeComposer as never,
    );
    return { service, approvals, fakeComposer };
  };

  it("register → tool appears in getTools() with mcp__<server>__<tool>; dispose → disappears", async () => {
    const { service } = makeService();
    try {
      const provider = makeFakeProvider("demo");
      const handle = service.registerMcpProvider(provider);
      assert.deepStrictEqual(service.getProviderIds(), ["demo"]);
      await service.refreshProviderTools("demo");
      const tools = service.getTools();
      const ping = tools.find((t) => t.namespacedName === "mcp__demo__ping");
      assert.ok(ping, `expected mcp__demo__ping in ${tools.map((t) => t.namespacedName)}`);
      assert.strictEqual(ping.serverId, "demo");
      assert.strictEqual(ping.toolName, "ping");
      assert.strictEqual(ping.description, "Reply with pong.");
      assert.deepStrictEqual(ping.inputSchema, {
        type: "object",
        properties: { msg: { type: "string" } },
      });
      assert.ok(tools.some((t) => t.namespacedName === "mcp__demo__add"));

      handle.dispose();
      assert.strictEqual(
        service.getTools().some((t) => t.namespacedName === "mcp__demo__ping"),
        false,
        "provider tools must vanish after unregister",
      );
      assert.deepStrictEqual(service.getProviderIds(), []);
    } finally {
      service.dispose();
    }
  });

  it("callTool runs the approval gate then dispatches to the provider", async () => {
    const { service, approvals } = makeService();
    try {
      const provider = makeFakeProvider("demo");
      service.registerMcpProvider(provider);
      await service.refreshProviderTools("demo");
      const result = await service.callTool("mcp__demo__ping", { msg: "hi" }, { toolCallId: "t1" });
      assert.strictEqual(result.text, "ok:ping");
      assert.strictEqual(result.isError, false);
      // Approval flow preserved: card requested with the MCP:<tool> label.
      assert.strictEqual(approvals.length, 1);
      assert.strictEqual(approvals[0].toolCallId, "t1");
      assert.strictEqual(approvals[0].label, "MCP:ping");
      // Provider receives (name, args, { composerId }).
      assert.deepStrictEqual(provider.calls[0], {
        name: "ping",
        args: { msg: "hi" },
        ctx: { composerId: "composer-9" },
      });
    } finally {
      service.dispose();
    }
  });

  it("callTool denied at the approval card throws without touching the provider", async () => {
    const { service } = makeService({ optionId: "skip" });
    try {
      const provider = makeFakeProvider("demo");
      service.registerMcpProvider(provider);
      await service.refreshProviderTools("demo");
      await assert.rejects(
        service.callTool("mcp__demo__ping", {}, { toolCallId: "t2" }),
        /skipped by user/,
      );
      assert.strictEqual(provider.calls.length, 0, "provider must not be called on skip");
    } finally {
      service.dispose();
    }
  });

  it("approve-once writes a chat-scoped grant: second call in the same chat skips the card", async () => {
    // Binary: case DJ.RUN (unless allowOnce) → mcpAllowedToolsForChat.
    const { service, approvals } = makeService({ optionId: "approve-once" });
    try {
      const provider = makeFakeProvider("demo");
      service.registerMcpProvider(provider);
      await service.refreshProviderTools("demo");
      await service.callTool("mcp__demo__ping", {}, { toolCallId: "t1" });
      assert.strictEqual(approvals.length, 1, "first call shows the card");
      await service.callTool("mcp__demo__ping", {}, { toolCallId: "t2" });
      assert.strictEqual(approvals.length, 1, "second call in the same chat must not re-prompt");
      assert.strictEqual(provider.calls.length, 2);
    } finally {
      service.dispose();
    }
  });

  it("approve-always writes a user-global grant visible to other chats", async () => {
    // Binary: ALLOWLIST_TOOL → composerState.mcpAllowedTools (no TTL).
    const { service, approvals, fakeComposer } = makeService({ optionId: "approve-always" });
    try {
      const provider = makeFakeProvider("demo");
      service.registerMcpProvider(provider);
      await service.refreshProviderTools("demo");
      await service.callTool("mcp__demo__ping", {}, { toolCallId: "t1" });
      assert.strictEqual(approvals.length, 1);
      await service.callTool("mcp__demo__ping", {}, { toolCallId: "t2" });
      assert.strictEqual(approvals.length, 1, "global grant silences the card afterwards");
      // A different composer sees the same global grant.
      fakeComposer.composerId = "composer-other";
      await service.callTool("mcp__demo__ping", {}, { toolCallId: "t3" });
      assert.strictEqual(approvals.length, 1, "global grant applies to other chats too");
    } finally {
      service.dispose();
    }
  });

  it("unknown provider id falls through to the server path (not configured)", async () => {
    const { service } = makeService();
    try {
      await assert.rejects(
        service.callTool("mcp__nosuch__ping", {}, { toolCallId: "t3" }),
        /MCP server "nosuch" is not configured/,
      );
    } finally {
      service.dispose();
    }
  });
});

describe("cursor api surface (createCursorApi)", () => {
  const makeService = () => {
    const fakeComposer = {
      composerId: "composer-9",
      reviews: { requestApproval: async () => ({ optionId: "approve-once" }) },
    };
    return new McpService({ subscriptions: [] } as never, () => fakeComposer as never);
  };

  it("registerMcpProvider exposes tools; pushMcpSnapshots refreshes them", async () => {
    const service = makeService();
    try {
      const api = createCursorApi(service);
      const provider = makeFakeProvider("demo");
      const handle = api.registerMcpProvider(provider);
      await service.refreshProviderTools("demo");
      assert.ok(service.getTools().some((t) => t.namespacedName === "mcp__demo__ping"));

      // Offerings change → snapshot push refreshes the tool list.
      provider.setTools([
        { name: "brand-new", description: "New tool.", parameters: { type: "object", properties: {} } },
      ]);
      await api.pushMcpSnapshots([
        {
          serverIdentifier: "demo",
          serverName: "demo",
          snapshotEpoch: Date.now(),
          snapshotRevision: 2,
          status: "connected",
          tools: [],
          resources: [],
          prompts: [],
          instructions: "",
        },
      ]);
      const names = service.getTools().map((t) => t.namespacedName);
      assert.ok(names.includes("mcp__demo__brand-new"), `after push: ${names}`);
      assert.ok(!names.includes("mcp__demo__ping"), `stale tool gone: ${names}`);

      // Unknown serverIdentifier in a push is ignored, not fatal.
      await api.pushMcpSnapshots([
        {
          serverIdentifier: "ghost",
          serverName: "ghost",
          snapshotEpoch: 0,
          snapshotRevision: 1,
          status: "connected",
          tools: [],
          resources: [],
          prompts: [],
          instructions: "",
        },
      ]);

      handle.dispose();
      assert.strictEqual(
        service.getTools().some((t) => t.namespacedName.startsWith("mcp__demo__")),
        false,
      );
    } finally {
      service.dispose();
    }
  });
});

/* ---------- DEV-GAPS-88: built-in cursor-ide-browser provider ---------- */

describe("cursor-ide-browser provider (DEV-GAPS-88)", () => {
  /** Fake BrowserService: records the caller id the tools were built with. */
  const makeFakeBrowserService = () => {
    const state = {
      tabsCalls: [] as Array<{ agentId: string; action: string }>,
      lockCalls: [] as Array<{ agentId: string; action: string }>,
    };
    const fake = {
      tabs: async (agentId: string, action: "list" | "new" | "close" | "select") => {
        state.tabsCalls.push({ agentId, action });
        return { tabs: [], activeViewId: undefined };
      },
      lock: async (_sessionId: string | undefined, agentId: string) => {
        state.lockCalls.push({ agentId, action: "lock" });
      },
      unlock: async (_sessionId: string | undefined, agentId: string) => {
        state.lockCalls.push({ agentId, action: "unlock" });
      },
    };
    return { service: fake as unknown as BrowserService, state };
  };

  it("id + instructions are the binary-verbatim values", () => {
    const { service } = makeFakeBrowserService();
    const provider = createCursorIdeBrowserProvider({ getBrowserService: async () => service });
    assert.strictEqual(provider.id, "cursor-ide-browser");
    assert.strictEqual(CURSOR_IDE_BROWSER_PROVIDER_ID, "cursor-ide-browser");
    assert.strictEqual(provider.featureGateName, undefined);
    assert.ok(
      provider.instructions.startsWith(
        "The cursor-ide-browser MCP server provides a Cursor-owned browser tab plus a raw Chrome DevTools Protocol command tool.",
      ),
    );
    assert.strictEqual(provider.instructions, CURSOR_IDE_BROWSER_INSTRUCTIONS);
    assert.ok(provider.instructions.includes("CORE WORKFLOW:"));
    assert.ok(provider.instructions.includes("CRITICAL - Lock/unlock workflow:"));
  });

  it("listOfferings returns exactly Cursor's 16 tools, in binary order, without starting a browser", async () => {
    let serviceRequested = false;
    const { service } = makeFakeBrowserService();
    const provider = createCursorIdeBrowserProvider({
      getBrowserService: async () => {
        serviceRequested = true;
        return service;
      },
    });
    const offerings = await provider.listOfferings();
    assert.deepStrictEqual(
      offerings.tools.map((t) => t.name),
      [...CURSOR_IDE_BROWSER_TOOL_NAMES],
    );
    assert.strictEqual(offerings.tools.length, 16);
    assert.deepStrictEqual(offerings.prompts, []);
    assert.deepStrictEqual(offerings.resources, []);
    // Fork extras must NOT be offered (Cursor registers exactly 16).
    for (const extra of ["browser_screenshot", "browser_pick_element", "browser_close", "browser_fill_form", "browser_hover"]) {
      assert.ok(!offerings.tools.some((t) => t.name === extra), `${extra} must not be offered`);
    }
    // Every offering carries a description + an object parameters schema.
    for (const t of offerings.tools) {
      assert.ok(t.description.length > 0, `${t.name} description`);
      assert.strictEqual((t.parameters as { type?: unknown }).type, "object", `${t.name} parameters`);
    }
    assert.strictEqual(serviceRequested, false, "listing offerings must not start the browser service");
  });

  it("callTool dispatches to the real browser tools with ownerAgentId = context.composerId", async () => {
    const { service, state } = makeFakeBrowserService();
    const provider = createCursorIdeBrowserProvider({ getBrowserService: async () => service });
    const out = await provider.callTool("browser_tabs", { action: "list" }, { composerId: "composer-42" });
    assert.deepStrictEqual(out, { tabs: [], activeViewId: undefined });
    assert.deepStrictEqual(state.tabsCalls, [{ agentId: "composer-42", action: "list" }]);

    await provider.callTool("browser_lock", { action: "lock" }, {});
    assert.deepStrictEqual(state.lockCalls, [{ agentId: "default-agent", action: "lock" }]);
  });

  it("callTool rejects tools Cursor does not register (Unknown tool)", async () => {
    const { service } = makeFakeBrowserService();
    const provider = createCursorIdeBrowserProvider({ getBrowserService: async () => service });
    await assert.rejects(provider.callTool("browser_fill_form", {}, {}), /Unknown tool: browser_fill_form/);
    await assert.rejects(provider.callTool("browser_close", {}, {}), /Unknown tool: browser_close/);
  });

  it("registers in McpService: tools surface as mcp__cursor-ide-browser__*; lookup by id works", async () => {
    const fakeComposer = {
      composerId: "composer-9",
      reviews: { requestApproval: async () => ({ optionId: "approve-once" }) },
    };
    const globalStateBacking = new Map<string, unknown>();
    const service = new McpService(
      {
        subscriptions: [],
        globalState: {
          get<T>(key: string, def: T): T {
            return (globalStateBacking.has(key) ? globalStateBacking.get(key) : def) as T;
          },
          update(key: string, value: unknown): Promise<void> {
            globalStateBacking.set(key, value);
            return Promise.resolve();
          },
        },
      } as never,
      () => fakeComposer as never,
    );
    try {
      const { service: browserService, state } = makeFakeBrowserService();
      let browserRequested = false;
      const provider = createCursorIdeBrowserProvider({
        getBrowserService: async () => {
          browserRequested = true;
          return browserService;
        },
      });
      provider.initialize?.("/tmp/fake-global-storage");
      const handle = service.registerMcpProvider(provider);
      assert.deepStrictEqual(service.getProviderIds(), ["cursor-ide-browser"]);
      await service.refreshProviderTools("cursor-ide-browser");
      const names = service.getTools().map((t) => t.namespacedName);
      assert.strictEqual(names.length, 16, `expected 16 namespaced tools, got ${names.join(",")}`);
      assert.ok(names.includes("mcp__cursor-ide-browser__browser_navigate"));
      assert.ok(names.includes("mcp__cursor-ide-browser__browser_cdp"));
      assert.ok(names.includes("mcp__cursor-ide-browser__browser_lock"));
      assert.strictEqual(browserRequested, false, "registration/listing must not start the browser");

      const result = await service.callTool(
        "mcp__cursor-ide-browser__browser_tabs",
        { action: "list" },
        { toolCallId: "gaps88-1" },
      );
      assert.strictEqual(result.isError, false);
      assert.strictEqual(browserRequested, true, "callTool resolves the real browser service");
      assert.deepStrictEqual(state.tabsCalls, [{ agentId: "composer-9", action: "list" }]);

      handle.dispose();
      assert.deepStrictEqual(service.getProviderIds(), []);
      assert.strictEqual(
        service.getTools().some((t) => t.namespacedName.startsWith("mcp__cursor-ide-browser__")),
        false,
      );
    } finally {
      service.dispose();
    }
  });
});

/* ---------- GAPS-22D: wake/retry config keys — real Cursor keys only ---------- */

describe("fix GAPS-22D: wake/retry config uses verified Cursor keys", () => {
  it("policy keys are exactly the verified Cursor keys (no fabrications)", () => {
    const keys = Object.keys(DEFAULT_MCP_RECONNECT_POLICY).sort();
    assert.deepStrictEqual(keys, [
      "networkResumeReconnectDebounceMs",
      "networkResumeReconnectEnabled",
      "retryNonRetryableOnWake",
    ]);
  });

  it("fabricated keys connectOnWake/retryOnWake do not exist", () => {
    const policy = DEFAULT_MCP_RECONNECT_POLICY as unknown as Record<string, unknown>;
    assert.ok(!("connectOnWake" in policy), "connectOnWake is fabricated (0 hits in 3.25.9)");
    assert.ok(!("retryOnWake" in policy), "retryOnWake is fabricated (0 hits in 3.25.9)");
    assert.ok("retryNonRetryableOnWake" in policy, "real Cursor key must exist");
  });

  it("networkResumeReconnectDebounceMs default is the observed 3.25.9 value (5000ms)", () => {
    assert.strictEqual(DEFAULT_MCP_RECONNECT_POLICY.networkResumeReconnectDebounceMs, 5000);
  });

  it("manager exposes the merged policy; overrides apply", () => {
    const mgr = new McpServerManager(
      {
        id: "project-keyprobe",
        displayName: "keyprobe",
        scope: "project",
        sourcePath: "/tmp/keyprobe-mcp.json",
        config: { args: [], url: "http://127.0.0.1:1/mcp" },
        transport: "streamableHttp",
      },
      [],
      silentLogger,
      { retryNonRetryableOnWake: true, networkResumeReconnectDebounceMs: 100 },
    );
    const policy = mgr.reconnectPolicy;
    assert.strictEqual(policy.retryNonRetryableOnWake, true);
    assert.strictEqual(policy.networkResumeReconnectDebounceMs, 100);
    assert.strictEqual(policy.networkResumeReconnectEnabled, true);
    assert.ok(!("connectOnWake" in policy) && !("retryOnWake" in policy));
    mgr.stop();
  });
});

describe("fix GAPS-22D: handleWake reconnect semantics", () => {
  /** HTTP MCP server that always 401s the initialize handshake (auth = non-retryable). */
  function startAuthFailingServer() {
    return startHttpServer((req, res) => {
      if (req.method === "GET") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        return;
      }
      res.writeHead(401);
      res.end();
    });
  }

  function makeManager(port: number, policy?: McpReconnectPolicy) {
    return new McpServerManager(
      {
        id: "project-wakeprobe",
        displayName: "wakeprobe",
        scope: "project",
        sourcePath: "/tmp/wakeprobe-mcp.json",
        config: { args: [], url: `http://127.0.0.1:${port}/mcp` },
        transport: "streamableHttp",
      },
      [],
      silentLogger,
      policy,
    );
  }

  async function waitForState(mgr: McpServerManager, state: string, ms = 5000): Promise<void> {
    if (mgr.currentState === state) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`never reached state ${state}`)), ms);
      const off = mgr.onEvent((e) => {
        if (e.kind === "stateChanged" && mgr.currentState === state) {
          clearTimeout(timer);
          off();
          resolve();
        }
      });
    });
  }

  it("auth failure -> failed; wake does NOT retry when retryNonRetryableOnWake=false", async () => {
    const { server, port } = await startAuthFailingServer();
    const mgr = makeManager(port);
    try {
      mgr.start();
      await waitForState(mgr, "failed");
      const failuresBefore = mgr.failureCount;
      mgr.handleWake();
      // Wait longer than a connect attempt could take; no new attempt may start.
      await new Promise((r) => setTimeout(r, 600));
      assert.strictEqual(mgr.currentState, "failed", "must stay failed");
      assert.strictEqual(mgr.failureCount, failuresBefore, "no new attempt may start");
    } finally {
      mgr.stop();
      server.closeAllConnections();
      server.close();
    }
  });

  it("auth failure -> failed; wake DOES retry when retryNonRetryableOnWake=true", async () => {
    const { server, port } = await startAuthFailingServer();
    const mgr = makeManager(port, {
      retryNonRetryableOnWake: true,
      networkResumeReconnectDebounceMs: 0,
    });
    try {
      mgr.start();
      await waitForState(mgr, "failed");
      const failuresBefore = mgr.failureCount;
      mgr.handleWake();
      await waitForState(mgr, "failed"); // it fails again (still 401) — the point is it retried
      assert.ok(
        mgr.failureCount > failuresBefore,
        `expected a new attempt (failures ${failuresBefore} -> ${mgr.failureCount})`,
      );
    } finally {
      mgr.stop();
      server.closeAllConnections();
      server.close();
    }
  });

  it("wake is debounced: burst of wake signals triggers one attempt", async () => {
    const { server, port } = await startHttpServer((req, res) => {
      res.writeHead(401);
      res.end();
    });
    const mgr = makeManager(port, {
      retryNonRetryableOnWake: true,
      networkResumeReconnectDebounceMs: 1000,
    });
    try {
      mgr.start();
      await waitForState(mgr, "failed");
      const failuresBefore = mgr.failureCount;
      for (let i = 0; i < 10; i++) mgr.handleWake();
      await new Promise((r) => setTimeout(r, 400));
      assert.strictEqual(
        mgr.failureCount,
        failuresBefore + 1,
        `burst must collapse to one attempt (failures ${failuresBefore} -> ${mgr.failureCount})`,
      );
    } finally {
      mgr.stop();
      server.closeAllConnections();
      server.close();
    }
  });

  it("networkResumeReconnectEnabled=false disables wake reconnect entirely", async () => {
    const { server, port } = await startHttpServer((req, res) => {
      res.writeHead(401);
      res.end();
    });
    const mgr = makeManager(port, {
      retryNonRetryableOnWake: true,
      networkResumeReconnectEnabled: false,
    });
    try {
      mgr.start();
      await waitForState(mgr, "failed");
      const failuresBefore = mgr.failureCount;
      mgr.handleWake();
      await new Promise((r) => setTimeout(r, 400));
      assert.strictEqual(mgr.currentState, "failed");
      assert.strictEqual(mgr.failureCount, failuresBefore);
    } finally {
      mgr.stop();
      server.closeAllConnections();
      server.close();
    }
  });
});
