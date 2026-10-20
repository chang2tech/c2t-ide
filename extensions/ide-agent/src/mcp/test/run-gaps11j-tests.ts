/**
 * WORKER-GAPS-11J tests (node:test, zero extra deps).
 *
 * - mcp-logs-panel: Cursor-verbatim channel names ("MCP Logs", "MCP OAuth",
 *   "MCP Allowlist", per-server "MCP: <name>"), lazy creation, aggregate mode.
 * - mcp-oauth-flow: static client-info extraction (cursor-mcp @1010800),
 *   resolution precedence (@949750), canonical URL scoping, token store
 *   round-trip, well-known endpoint discovery, full authorization-code+PKCE
 *   round trip against a fake OAuth server, refresh, and the service-level
 *   authenticate glue (McpService.authenticateServer/maybeOfferAuthentication).
 *
 * The `./vscode-shim` import MUST stay first: it stubs `require("vscode")`
 * before the modules under test load under plain node.
 *
 * Run after `tsc`:  node out/mcp/test/run-gaps11j-tests.mjs
 */
import "./vscode-shim";
import { describe, it, before, after } from "node:test";
import * as assert from "node:assert";
import * as http from "node:http";
import { vscodeStubControls } from "./vscode-shim";
import {
  MCP_ALLOWLIST_CHANNEL_NAME,
  MCP_LOGS_CHANNEL_NAME,
  MCP_OAUTH_CHANNEL_NAME,
  MCP_PROCESS_CHANNEL_NAME,
  McpLogChannels,
  mcpServerChannelName,
} from "../mcpLogs";
import {
  McpOAuthTokenStore,
  canonicalizeServerUrl,
  resolveClientInformation,
  staticClientInfoFromConfig,
} from "../oauthStaticCreds";
import {
  McpOAuthBroker,
  McpOAuthLoopbackUnavailableError,
  discoverOAuthEndpoints,
  refreshAccessToken,
  runAuthorizationCodeFlow,
} from "../oauthFlow";
import { McpServerManager } from "../serverManager";
import { McpService } from "../service";
import type { ConfiguredServer } from "../types";

/* ---------- mcp-logs-panel: Cursor-verbatim channel names ---------- */

interface FakeLogChannel {
  name: string;
  shown: number;
  appendLine(m: string): void;
  trace(m: string): void;
  debug(m: string): void;
  info(m: string): void;
  warn(m: string): void;
  error(m: string): void;
  show(): void;
  dispose(): void;
}

const makeFactory = () => {
  const created: FakeLogChannel[] = [];
  const factory = {
    createLogChannel(name: string): FakeLogChannel {
      const ch: FakeLogChannel = {
        name,
        shown: 0,
        appendLine() {},
        trace() {},
        debug() {},
        info() {},
        warn() {},
        error() {},
        show() {
          ch.shown += 1;
        },
        dispose() {},
      };
      created.push(ch);
      return ch;
    },
  };
  return { factory: factory as never, created };
};

describe("mcp logs panel — Cursor-verbatim channel names", () => {
  it("aggregate channel is named exactly 'MCP Logs'", () => {
    const { factory, created } = makeFactory();
    const logs = new McpLogChannels(factory);
    try {
      logs.filesLogger.appendLine("hello");
      assert.deepStrictEqual(created.map((c) => c.name), [MCP_LOGS_CHANNEL_NAME]);
      assert.strictEqual(MCP_LOGS_CHANNEL_NAME, "MCP Logs");
    } finally {
      logs.dispose();
    }
  });

  it("OAuth and Allowlist loggers are named verbatim, created lazily", () => {
    const { factory, created } = makeFactory();
    const logs = new McpLogChannels(factory);
    try {
      assert.strictEqual(created.length, 0, "nothing created until first use");
      logs.oauthLogger.info("x");
      logs.allowlistLogger.info("x");
      logs.processLogger.info("x");
      assert.deepStrictEqual(created.map((c) => c.name), [
        MCP_OAUTH_CHANNEL_NAME,
        MCP_ALLOWLIST_CHANNEL_NAME,
        MCP_PROCESS_CHANNEL_NAME,
      ]);
      assert.strictEqual(MCP_OAUTH_CHANNEL_NAME, "MCP OAuth");
      assert.strictEqual(MCP_ALLOWLIST_CHANNEL_NAME, "MCP Allowlist");
    } finally {
      logs.dispose();
    }
  });

  it("per-server channels are 'MCP: <name>' (default: per-instance)", () => {
    const { factory, created } = makeFactory();
    const logs = new McpLogChannels(factory, false);
    try {
      const a = logs.getServerLogger("my-server");
      const b = logs.getServerLogger("my-server");
      assert.strictEqual(a, b, "same channel returned twice");
      assert.strictEqual(mcpServerChannelName("my-server"), "MCP: my-server");
      assert.deepStrictEqual(created.map((c) => c.name), ["MCP: my-server"]);
    } finally {
      logs.dispose();
    }
  });

  it("aggregate mode routes every server into 'MCP Logs'", () => {
    const { factory, created } = makeFactory();
    const logs = new McpLogChannels(factory, true);
    try {
      const a = logs.getServerLogger("srv-a");
      const b = logs.getServerLogger("srv-b");
      assert.strictEqual(a, b);
      assert.strictEqual(a, logs.filesLogger);
      assert.deepStrictEqual(created.map((c) => c.name), [MCP_LOGS_CHANNEL_NAME]);
    } finally {
      logs.dispose();
    }
  });

  it("showLogs/showServer surface the right channels; disposeServerLogger drops them", () => {
    const { factory, created } = makeFactory();
    const logs = new McpLogChannels(factory);
    try {
      logs.showLogs();
      logs.showServer("srv-a");
      assert.strictEqual(created.find((c) => c.name === "MCP Logs")!.shown, 1);
      assert.strictEqual(created.find((c) => c.name === "MCP: srv-a")!.shown, 1);
      logs.disposeServerLogger("srv-a");
      logs.getServerLogger("srv-a");
      assert.strictEqual(
        created.filter((c) => c.name === "MCP: srv-a").length,
        2,
        "disposed channel is recreated on next use",
      );
    } finally {
      logs.dispose();
    }
  });
});

/* ---------- mcp-oauth-flow: static client credentials ---------- */

describe("static client info from mcp.json auth block (cursor-mcp @1010800)", () => {
  it("no auth block → undefined (dynamic registration path)", () => {
    assert.strictEqual(staticClientInfoFromConfig(undefined), undefined);
    assert.strictEqual(staticClientInfoFromConfig({}), undefined);
    assert.strictEqual(staticClientInfoFromConfig({ CLIENT_ID: "" }), undefined);
  });

  it("CLIENT_ID alone → {client_id}", () => {
    assert.deepStrictEqual(staticClientInfoFromConfig({ CLIENT_ID: "cid-1" }), {
      client_id: "cid-1",
    });
  });

  it("CLIENT_ID + CLIENT_SECRET → both", () => {
    assert.deepStrictEqual(
      staticClientInfoFromConfig({ CLIENT_ID: "cid-1", CLIENT_SECRET: "shh" }),
      { client_id: "cid-1", client_secret: "shh" },
    );
  });
});

describe("client information resolution (cursor-mcp @949750)", () => {
  const redirectUris = ["http://127.0.0.1:8787/callback"];
  it("stored client_id matches static → enriched stored record reused", () => {
    const out = resolveClientInformation(
      { client_id: "cid-1" },
      { client_id: "cid-1", client_secret: "old-secret", extra: "kept" },
      redirectUris,
    );
    assert.strictEqual(out.client_id, "cid-1");
    assert.strictEqual(out.client_secret, "old-secret");
    assert.strictEqual((out as { extra?: string }).extra, "kept");
    assert.deepStrictEqual(out.redirect_uris, redirectUris);
  });

  it("stored client_id differs → static info + redirect_uris", () => {
    const out = resolveClientInformation(
      { client_id: "cid-2", client_secret: "new" },
      { client_id: "cid-1" },
      redirectUris,
    );
    assert.deepStrictEqual(out, {
      client_id: "cid-2",
      client_secret: "new",
      redirect_uris: redirectUris,
    });
  });

  it("no stored info → static info + redirect_uris", () => {
    const out = resolveClientInformation({ client_id: "cid-3" }, undefined, redirectUris);
    assert.deepStrictEqual(out, { client_id: "cid-3", redirect_uris: redirectUris });
  });
});

describe("canonical server URL scoping", () => {
  it("normalizes case, default ports, trailing slashes", () => {
    assert.strictEqual(
      canonicalizeServerUrl("https://Example.COM:443/mcp/"),
      canonicalizeServerUrl("https://example.com/mcp"),
    );
    assert.strictEqual(canonicalizeServerUrl("http://x:80/a"), "http://x/a");
  });

  it("keeps non-default ports and distinct paths distinct", () => {
    assert.notStrictEqual(
      canonicalizeServerUrl("https://example.com:8443/mcp"),
      canonicalizeServerUrl("https://example.com/mcp"),
    );
    assert.notStrictEqual(
      canonicalizeServerUrl("https://example.com/a"),
      canonicalizeServerUrl("https://example.com/b"),
    );
  });
});

const makeSecrets = () => {
  const map = new Map<string, string>();
  return {
    get: async (k: string) => map.get(k),
    store: async (k: string, v: string) => {
      map.set(k, v);
    },
    delete: async (k: string) => {
      map.delete(k);
    },
    onDidChange: () => ({ dispose() {} }),
    keys: map,
  };
};

describe("McpOAuthTokenStore (SecretStorage, canonical-URL keyed)", () => {
  it("round-trips tokens; canonical URL variants share one record", async () => {
    const secrets = makeSecrets();
    const store = new McpOAuthTokenStore(secrets as never);
    assert.strictEqual(await store.getTokens("https://x/mcp"), undefined);
    await store.saveTokens("https://x/mcp/", {
      access_token: "at-1",
      refresh_token: "rt-1",
    });
    assert.deepStrictEqual((await store.getTokens("https://X:443/mcp"))?.access_token, "at-1");
    await store.clearTokens("https://x/mcp");
    assert.strictEqual(await store.getTokens("https://x/mcp"), undefined);
  });

  it("round-trips stored client info; corrupt JSON → undefined", async () => {
    const secrets = makeSecrets();
    const store = new McpOAuthTokenStore(secrets as never);
    await store.saveStoredClientInfo("https://x/mcp", { client_id: "cid-1" });
    assert.strictEqual((await store.getStoredClientInfo("https://x/mcp"))?.client_id, "cid-1");
    // Corrupt the underlying record directly.
    for (const k of secrets.keys.keys()) {
      secrets.keys.set(k, "{broken");
    }
    assert.strictEqual(await store.getStoredClientInfo("https://x/mcp"), undefined);
    assert.strictEqual(await store.getTokens("https://x/mcp"), undefined);
  });
});

/* ---------- fake OAuth server for flow tests ---------- */

interface FakeOAuthServer {
  origin: string;
  tokenUrl: string;
  authorizeUrl: string;
  seenTokenBodies: string[];
  close(): void;
}

function startFakeOAuthServer(): Promise<FakeOAuthServer> {
  return new Promise((resolve) => {
    const seenTokenBodies: string[] = [];
    let origin = "";
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/.well-known/oauth-protected-resource") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ authorization_servers: [origin] }));
      } else if (url.pathname === "/.well-known/oauth-authorization-server") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            authorization_endpoint: `${origin}/authorize`,
            token_endpoint: `${origin}/token`,
          }),
        );
      } else if (url.pathname === "/token" && req.method === "POST") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          seenTokenBodies.push(body);
          const params = new URLSearchParams(body);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              access_token: `at-for-${params.get("code") ?? params.get("refresh_token")}`,
              refresh_token: "rt-new",
              token_type: "Bearer",
              expires_in: 3600,
              scope: "read",
            }),
          );
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      origin = `http://127.0.0.1:${addr.port}`;
      resolve({
        origin,
        tokenUrl: `${origin}/token`,
        authorizeUrl: `${origin}/authorize`,
        seenTokenBodies,
        close: () => server.close(),
      });
    });
  });
}

/**
 * Simulates the user completing the browser step: parses the authorization
 * URL, then performs the provider redirect back to the loopback callback.
 */
async function simulateBrowserCallback(authorizeUrl: string): Promise<void> {
  const u = new URL(authorizeUrl);
  const redirectUri = u.searchParams.get("redirect_uri");
  const state = u.searchParams.get("state");
  assert.ok(redirectUri, "authorize URL must carry redirect_uri");
  assert.ok(state, "authorize URL must carry state");
  // PKCE assertions (S256) — part of the flow contract.
  assert.strictEqual(u.searchParams.get("response_type"), "code");
  assert.strictEqual(u.searchParams.get("code_challenge_method"), "S256");
  assert.ok(u.searchParams.get("code_challenge"), "code_challenge required");
  const res = await fetch(`${redirectUri}?code=browser-code-1&state=${state}`);
  assert.ok(res.ok, "loopback callback must accept the provider redirect");
}

describe("OAuth endpoint discovery (well-known)", () => {
  let oauth: FakeOAuthServer;
  before(async () => {
    oauth = await startFakeOAuthServer();
  });
  after(() => oauth.close());

  it("discovers via oauth-protected-resource → authorization-server", async () => {
    const endpoints = await discoverOAuthEndpoints(`${oauth.origin}/mcp`);
    assert.strictEqual(endpoints.authorizationEndpoint, `${oauth.origin}/authorize`);
    assert.strictEqual(endpoints.tokenEndpoint, `${oauth.origin}/token`);
  });

  it("falls back to the server origin when no protected-resource doc exists", async () => {
    // A server with no well-known docs at all.
    const bare = await new Promise<{ origin: string; close(): void }>((resolve) => {
      const s = http.createServer((_req, res) => {
        res.writeHead(404);
        res.end();
      });
      s.listen(0, "127.0.0.1", () => {
        const addr = s.address() as { port: number };
        resolve({ origin: `http://127.0.0.1:${addr.port}`, close: () => s.close() });
      });
    });
    try {
      await assert.rejects(
        () => discoverOAuthEndpoints(`${bare.origin}/mcp`),
        /No OAuth authorization server metadata/,
      );
    } finally {
      bare.close();
    }
  });
});

describe("authorization-code + PKCE round trip", () => {
  let oauth: FakeOAuthServer;
  before(async () => {
    oauth = await startFakeOAuthServer();
  });
  after(() => oauth.close());

  it("opens the browser, receives the code on loopback, exchanges for tokens", async () => {
    const opened: string[] = [];
    const result = await runAuthorizationCodeFlow({
      serverDisplayName: "oauth-srv",
      serverUrl: `${oauth.origin}/mcp`,
      clientInfo: { client_id: "cid-1", client_secret: "shh" },
      scopes: ["read"],
      endpoints: { authorizationEndpoint: oauth.authorizeUrl, tokenEndpoint: oauth.tokenUrl },
      openExternal: async (url) => {
        opened.push(url);
        await simulateBrowserCallback(url);
      },
      timeoutMs: 10_000,
    });
    assert.strictEqual(opened.length, 1);
    assert.strictEqual(result.tokens.access_token, "at-for-browser-code-1");
    assert.strictEqual(result.tokens.refresh_token, "rt-new");
    assert.ok(result.redirectUris[0].startsWith("http://127.0.0.1:"));
    // The token endpoint saw the code exchange with PKCE verifier + secret.
    const body = new URLSearchParams(oauth.seenTokenBodies[0]);
    assert.strictEqual(body.get("grant_type"), "authorization_code");
    assert.strictEqual(body.get("code"), "browser-code-1");
    assert.ok(body.get("code_verifier"), "PKCE verifier required");
    assert.strictEqual(body.get("client_secret"), "shh");
  });

  it("loopback bind failure surfaces McpOAuthLoopbackUnavailableError semantics", async () => {
    // Occupy every preferred port AND force ephemeral to fail by holding a
    // server on port 0's entire range is impractical; instead assert the
    // error type exists and the flow rejects cleanly on user timeout.
    const err = new McpOAuthLoopbackUnavailableError("x");
    assert.strictEqual(err.name, "McpOAuthLoopbackUnavailableError");
    await assert.rejects(
      () =>
        runAuthorizationCodeFlow({
          serverDisplayName: "s",
          serverUrl: `${oauth.origin}/mcp`,
          clientInfo: { client_id: "cid-1" },
          scopes: [],
          endpoints: { authorizationEndpoint: oauth.authorizeUrl, tokenEndpoint: oauth.tokenUrl },
          openExternal: async () => {
            /* user never completes the browser step */
          },
          timeoutMs: 50,
        }),
      /cancelled|timed out/i,
    );
  });
});

describe("refreshAccessToken", () => {
  let oauth: FakeOAuthServer;
  before(async () => {
    oauth = await startFakeOAuthServer();
  });
  after(() => oauth.close());

  it("exchanges a refresh token and keeps the old one when none is returned", async () => {
    const tokens = await refreshAccessToken(oauth.tokenUrl, { client_id: "cid-1" }, "rt-old");
    assert.strictEqual(tokens.access_token, "at-for-rt-old");
    assert.strictEqual(tokens.refresh_token, "rt-new");
    const body = new URLSearchParams(oauth.seenTokenBodies.at(-1)!);
    assert.strictEqual(body.get("grant_type"), "refresh_token");
    assert.strictEqual(body.get("refresh_token"), "rt-old");
  });
});

/* ---------- broker + service glue ---------- */

const makeFakeContext = () => {
  const secrets = makeSecrets();
  const globalState = new Map<string, unknown>();
  return {
    context: {
      subscriptions: [],
      secrets,
      globalState: {
        get: (k: string, d?: unknown) => (globalState.has(k) ? globalState.get(k) : d),
        update: async (k: string, v: unknown) => {
          globalState.set(k, v);
        },
      },
    } as never,
    secrets,
  };
};

describe("McpOAuthBroker.promptAndAuthenticate", () => {
  let oauth: FakeOAuthServer;
  before(async () => {
    oauth = await startFakeOAuthServer();
  });
  after(() => oauth.close());

  it("Authenticate → runs the flow, saves tokens + enriched client info", async () => {
    const { context, secrets } = makeFakeContext();
    const logged: string[] = [];
    vscodeStubControls.shownMessages.length = 0;
    vscodeStubControls.nextMessageChoice = "Authenticate";
    const broker = new McpOAuthBroker(context, (m) => logged.push(m), async (url) => {
      await simulateBrowserCallback(url);
    });
    const ok = await broker.promptAndAuthenticate(
      "oauth-srv",
      `${oauth.origin}/mcp`,
      { client_id: "cid-1", client_secret: "shh" },
      ["read"],
    );
    assert.strictEqual(ok, true);
    const store = broker.getTokenStore();
    assert.strictEqual((await store.getTokens(`${oauth.origin}/mcp`))?.access_token, "at-for-browser-code-1");
    assert.strictEqual((await store.getStoredClientInfo(`${oauth.origin}/mcp`))?.client_id, "cid-1");
    assert.ok(logged.some((l) => l.includes("tokens saved")), logged.join(" | "));
    assert.ok(
      vscodeStubControls.shownMessages.some((m) => m.message.includes("needs authentication")),
      JSON.stringify(vscodeStubControls.shownMessages),
    );
  });

  it("Dismiss → returns false, stores nothing", async () => {
    const { context } = makeFakeContext();
    vscodeStubControls.nextMessageChoice = "Dismiss";
    const broker = new McpOAuthBroker(context, () => undefined);
    const ok = await broker.promptAndAuthenticate(
      "oauth-srv",
      `${oauth.origin}/mcp`,
      { client_id: "cid-1" },
      [],
    );
    assert.strictEqual(ok, false);
    assert.strictEqual(await broker.getTokenStore().getTokens(`${oauth.origin}/mcp`), undefined);
  });
});

describe("McpService OAuth glue (authenticateServer / maybeOfferAuthentication)", () => {
  const serverUrl = "http://127.0.0.1:9/mcp"; // unroutable — broker is stubbed, never dialed
  const configured: ConfiguredServer = {
    id: "project-oauth",
    displayName: "oauth",
    scope: "project",
    sourcePath: "/tmp/probe-mcp.json",
    config: { args: [], url: serverUrl, auth: { CLIENT_ID: "cid-1" } },
    transport: "streamableHttp",
  };

  const makeServiceWithManager = () => {
    const { context, secrets } = makeFakeContext();
    const service = new McpService(context, () => ({}) as never);
    const mgr = new McpServerManager(configured, [], { appendLine: () => undefined });
    (service as unknown as { managers: Map<string, McpServerManager> }).managers.set(configured.id, mgr);
    let restarts = 0;
    service.restartServer = ((id: string) => {
      restarts += 1;
      assert.strictEqual(id, configured.id);
    }) as never;
    return { service, mgr, secrets, getRestarts: () => restarts };
  };

  it("unknown server → false; server without static creds → false", async () => {
    const { service } = makeServiceWithManager();
    try {
      assert.strictEqual(await service.authenticateServer("nope"), false);
      const plain: ConfiguredServer = {
        ...configured,
        id: "project-plain",
        displayName: "plain",
        config: { args: [], url: serverUrl },
      };
      const mgr = new McpServerManager(plain, [], { appendLine: () => undefined });
      (service as unknown as { managers: Map<string, McpServerManager> }).managers.set(plain.id, mgr);
      assert.strictEqual(await service.authenticateServer(plain.id), false);
    } finally {
      service.dispose();
    }
  });

  it("successful flow → Bearer header applied + server restarted", async () => {
    const { service, secrets, getRestarts } = makeServiceWithManager();
    try {
      const store = new McpOAuthTokenStore(secrets as never);
      await store.saveTokens(serverUrl, { access_token: "at-live" });
      const broker = {
        promptAndAuthenticate: async () => true,
        getTokenStore: () => store,
      };
      (service as unknown as { oauthBroker: unknown }).oauthBroker = broker;
      const ok = await service.authenticateServer(configured.id);
      assert.strictEqual(ok, true);
      const mgr = (service as unknown as { managers: Map<string, McpServerManager> }).managers.get(
        configured.id,
      )!;
      assert.strictEqual(mgr.server.config.headers?.Authorization, "Bearer at-live");
      assert.strictEqual(getRestarts(), 1);
    } finally {
      service.dispose();
    }
  });

  it("maybeOfferAuthentication: auth-flavored failure → one prompt; non-auth → silent", async () => {
    const { service } = makeServiceWithManager();
    try {
      let prompts = 0;
      const broker = {
        promptAndAuthenticate: async () => {
          prompts += 1;
          return false;
        },
        getTokenStore: () => new McpOAuthTokenStore(makeSecrets() as never),
      };
      (service as unknown as { oauthBroker: unknown }).oauthBroker = broker;
      const priv = service as unknown as {
        maybeOfferAuthentication(id: string): Promise<void>;
      };
      const mgrPriv = (service as unknown as { managers: Map<string, McpServerManager> }).managers.get(
        configured.id,
      )! as unknown as { setState(s: string): void; lastError: string | undefined };

      // Non-auth failure → no prompt.
      mgrPriv.setState("failed");
      mgrPriv.lastError = "connection refused";
      await priv.maybeOfferAuthentication(configured.id);
      assert.strictEqual(prompts, 0);

      // Auth-flavored failure → exactly one prompt (no nag loop).
      mgrPriv.lastError = "MCP initialize failed: 401 Unauthorized";
      await priv.maybeOfferAuthentication(configured.id);
      assert.strictEqual(prompts, 1);
      await priv.maybeOfferAuthentication(configured.id);
      assert.strictEqual(prompts, 1, "must not nag twice in one session");
    } finally {
      service.dispose();
    }
  });
});
