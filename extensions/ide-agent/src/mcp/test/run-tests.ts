/**
 * MCP module tests (node:test, zero extra deps).
 *
 * Unit: namespacing (§B4), variable expansion + config discovery + precedence
 * (§B1), allowlist patterns + precheck (§B5), result normalization.
 * Integration: a fake MCP server (node script speaking NDJSON JSON-RPC)
 * exercises the stdio client handshake, tools/list pagination, tools/call,
 * roots/list and server→client ping.
 *
 * Run after `tsc`:  node out/mcp/test/run-tests.mjs
 */
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
} from "../config";
import { McpAllowlist, matchAllowlistPattern } from "../allowlist";
import { normalizeResult, formatResultMarkdown } from "../results";
import { McpStdioClient } from "../stdioClient";
import { McpHttpClient, McpAuthError, parseSseEvents } from "../httpClient";
import { McpServerManager } from "../serverManager";
import { mcpApprovalOptions } from "../approvalOptions";
import { McpLogger } from "../types";

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
  it("command → stdio, url → streamable_http/sse, else unknown", () => {
    assert.strictEqual(detectTransport({ command: "npx" }), "stdio");
    assert.strictEqual(detectTransport({ url: "https://x/mcp" }), "streamable_http");
    assert.strictEqual(detectTransport({ url: "https://x", transportType: "sse" }), "sse");
    assert.strictEqual(detectTransport({}), "unknown");
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
    fs.writeFileSync(
      path.join(root, ".cursor", "mcp-approvals.json"),
      JSON.stringify({ approvals: { "fs:write": "deny", "fs:delete": "ask", "net:fetch": "allow" } }),
    );
  });
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  it("deny > ask > allow; approvals beat allowlist", () => {
    const al = new McpAllowlist([root], logger);
    assert.strictEqual(al.precheck("fs", "write").decision, "deny");
    assert.strictEqual(al.precheck("fs", "delete").decision, "ask");
    assert.strictEqual(al.precheck("net", "fetch").decision, "allow");
    assert.strictEqual(al.precheck("fs", "read").decision, "allow"); // permissions.json
    assert.strictEqual(al.precheck("git", "push").decision, "allow"); // git:*
    const ask = al.precheck("fs", "exec");
    assert.strictEqual(ask.decision, "ask");
    assert.ok(ask.reason.includes("mcpToolsProtection"));
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
  it("url + transportType sse → sse; plain url → streamable_http", () => {
    assert.strictEqual(detectTransport({ url: "https://x/sse", transportType: "sse" }), "sse");
    assert.strictEqual(detectTransport({ url: "https://x/mcp" }), "streamable_http");
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

describe("approval persistence", () => {
  it("persistApproval writes .cursor/mcp-approvals.json and precheck honors it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-appr-"));
    const logger: McpLogger = { appendLine: () => undefined };
    try {
      const al = new McpAllowlist([dir], logger);
      assert.strictEqual(al.precheck("srv", "tool").decision, "ask");
      al.persistApproval(dir, "srv", "tool", "allow");
      al.reload();
      assert.strictEqual(al.precheck("srv", "tool").decision, "allow");
      al.persistApproval(dir, "srv", "tool", "deny");
      al.reload();
      const denied = al.precheck("srv", "tool");
      assert.strictEqual(denied.decision, "deny");
      const doc = JSON.parse(
        fs.readFileSync(path.join(dir, ".cursor", "mcp-approvals.json"), "utf8"),
      );
      assert.strictEqual(doc.approvals["srv:tool"], "deny");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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

describe("fix P1-3: precheck merges deny > ask > allow across ALL folders", () => {
  let dirA = "";
  let dirB = "";
  before(() => {
    dirA = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-fix-a-"));
    dirB = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-fix-b-"));
    for (const d of [dirA, dirB]) fs.mkdirSync(path.join(d, ".cursor"), { recursive: true });
    fs.writeFileSync(
      path.join(dirA, ".cursor", "mcp-approvals.json"),
      JSON.stringify({ approvals: { "srv:tool": "allow", "srv:other": "allow" } }),
    );
    fs.writeFileSync(
      path.join(dirB, ".cursor", "mcp-approvals.json"),
      JSON.stringify({ approvals: { "srv:tool": "deny", "srv:other": "ask" } }),
    );
  });
  after(() => {
    for (const d of [dirA, dirB]) fs.rmSync(d, { recursive: true, force: true });
  });

  it("deny in ANY folder beats allow, regardless of folder order", () => {
    const d1 = new McpAllowlist([dirA, dirB], silentLogger).precheck("srv", "tool");
    const d2 = new McpAllowlist([dirB, dirA], silentLogger).precheck("srv", "tool");
    assert.strictEqual(d1.decision, "deny");
    assert.strictEqual(d2.decision, "deny");
  });

  it("ask beats allow across folders", () => {
    const d = new McpAllowlist([dirA, dirB], silentLogger).precheck("srv", "other");
    assert.strictEqual(d.decision, "ask");
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
        transport: "streamable_http",
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
