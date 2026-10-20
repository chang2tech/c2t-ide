/**
 * WORKER-GAPS-11J integration tests (node:test, zero extra deps).
 *
 * - Provider registry + credential resolution (settings > env).
 * - SecretStorage token store round-trip.
 * - OAuth authorization-code + PKCE round trip against a fake provider.
 * - IntegrationService: Cursor-`integrationAuth`-shaped state
 *   (`githubConnected` / `linearConnected` / `isLoading`), connectWith /
 *   disconnect, throttled GitHub connect nudge.
 *
 * The `./vscode-shim` import MUST stay first.
 *
 * Run after `tsc`:  node out/integrations/test/run-integration-tests.mjs
 */
import "./vscode-shim";
import { describe, it, before, after } from "node:test";
import * as assert from "node:assert";
import * as http from "node:http";
import { integrationStubControls } from "./vscode-shim";
import {
  INTEGRATION_PROVIDERS,
  INTEGRATION_PROVIDER_IDS,
  resolveClientCredentials,
} from "../providers";
import { IntegrationTokenStore } from "../tokenStore";
import { runOAuthCodeFlow } from "../oauth";
import { IntegrationService } from "../service";
import { activateIntegrations } from "../index";
import * as fs from "node:fs";
import * as path from "node:path";

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
  };
};

const makeContext = () => {
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
    globalState,
  };
};

describe("provider registry", () => {
  it("ships github + linear with public OAuth endpoints", () => {
    assert.deepStrictEqual([...INTEGRATION_PROVIDER_IDS].sort(), ["github", "linear"]);
    assert.ok(INTEGRATION_PROVIDERS.github.authorizeUrl.startsWith("https://github.com/"));
    assert.ok(INTEGRATION_PROVIDERS.linear.authorizeUrl.startsWith("https://linear.app/"));
    assert.ok(INTEGRATION_PROVIDERS.github.scopes.length > 0);
  });

  it("resolveClientCredentials: settings > env > undefined", () => {
    const fromSettings = resolveClientCredentials("github", (k) =>
      k === "ide.integrations.github.clientId" ? "cfg-id" : undefined,
    );
    assert.strictEqual(fromSettings?.clientId, "cfg-id");

    const fromEnv = resolveClientCredentials("linear", () => undefined, {
      IDE_INTEGRATIONS_LINEAR_CLIENT_ID: "env-id",
      IDE_INTEGRATIONS_LINEAR_CLIENT_SECRET: "env-secret",
    } as NodeJS.ProcessEnv);
    assert.deepStrictEqual(fromEnv, { clientId: "env-id", clientSecret: "env-secret" });

    assert.strictEqual(resolveClientCredentials("github", () => undefined, {}), undefined);
  });

  it("resolveClientCredentials: empty-string settings (declared default \"\") fall back to env (GAPS-168)", () => {
    // Once the keys are declared in package.json with default "", VS Code
    // serves "" for unset keys instead of undefined; "" must count as unset
    // or env-only credentials would be shadowed by the declared default.
    const fromEnv = resolveClientCredentials("github", () => "", {
      IDE_INTEGRATIONS_GITHUB_CLIENT_ID: "env-id",
      IDE_INTEGRATIONS_GITHUB_CLIENT_SECRET: "env-secret",
    } as NodeJS.ProcessEnv);
    assert.deepStrictEqual(fromEnv, { clientId: "env-id", clientSecret: "env-secret" });

    // Empty everywhere -> no credentials (same as undefined before).
    assert.strictEqual(resolveClientCredentials("github", () => "", {}), undefined);

    // Non-empty setting still beats env; empty secret falls back on its own.
    const mixed = resolveClientCredentials(
      "linear",
      (k) => (k === "ide.integrations.linear.clientId" ? "cfg-id" : ""),
      {
        IDE_INTEGRATIONS_LINEAR_CLIENT_ID: "env-id",
        IDE_INTEGRATIONS_LINEAR_CLIENT_SECRET: "env-secret",
      } as NodeJS.ProcessEnv,
    );
    assert.deepStrictEqual(mixed, { clientId: "cfg-id", clientSecret: "env-secret" });
  });
});

describe("IntegrationTokenStore", () => {
  it("round-trips per provider; corrupt JSON → undefined", async () => {
    const secrets = makeSecrets();
    const store = new IntegrationTokenStore(secrets as never);
    assert.strictEqual(await store.get("github"), undefined);
    await store.set("github", { access_token: "ghu-1" });
    await store.set("linear", { access_token: "lin-1" });
    assert.strictEqual((await store.get("github"))?.access_token, "ghu-1");
    assert.strictEqual((await store.get("linear"))?.access_token, "lin-1");
    await store.clear("github");
    assert.strictEqual(await store.get("github"), undefined);
    assert.strictEqual((await store.get("linear"))?.access_token, "lin-1");
  });
});

/* ---------- fake OAuth provider ---------- */

function startFakeProvider(): Promise<{
  origin: string;
  authorizeUrl: string;
  tokenUrl: string;
  seenBodies: string[];
  close(): void;
}> {
  return new Promise((resolve) => {
    const seenBodies: string[] = [];
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/token" && req.method === "POST") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          seenBodies.push(body);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ access_token: "prov-at-1", token_type: "Bearer" }));
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      const origin = `http://127.0.0.1:${addr.port}`;
      resolve({
        origin,
        authorizeUrl: `${origin}/authorize`,
        tokenUrl: `${origin}/token`,
        seenBodies,
        close: () => server.close(),
      });
    });
  });
}

async function simulateProviderCallback(authorizeUrl: string): Promise<void> {
  const u = new URL(authorizeUrl);
  const redirectUri = u.searchParams.get("redirect_uri")!;
  const state = u.searchParams.get("state")!;
  assert.strictEqual(u.searchParams.get("code_challenge_method"), "S256");
  // DEV-GAPS-82 (W82C): the callback MUST go over a brand-new,
  // non-pooled connection (`agent: false`) — not global fetch, and not
  // http.get on the default agent either. Every OAuth flow binds the
  // same loopback port (8787), so all callbacks share one origin; both
  // undici (global fetch) and http.globalAgent (keepAlive:true since
  // Node 19) pool keep-alive sockets per origin process-wide, and the
  // next flow could reuse the previous — already server-closed —
  // flow's stale socket and die with UND_ERR_SOCKET / ECONNRESET.
  // That cross-test shared state is the proven flake root cause
  // (w82c-findings.md). A real browser redirect does not inherit a
  // dead pooled socket from a previous flow; `agent: false` models
  // exactly that: one fresh connection, destroyed after the response.
  const status = await new Promise<number>((resolve, reject) => {
    http
      .get(
        `${redirectUri}?code=prov-code-9&state=${state}`,
        { agent: false },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        },
      )
      .on("error", reject);
  });
  assert.ok(status >= 200 && status < 300, `callback status ${status}`);
}

describe("runOAuthCodeFlow (integrations)", () => {
  let prov: Awaited<ReturnType<typeof startFakeProvider>>;
  before(async () => {
    prov = await startFakeProvider();
  });
  after(() => prov.close());

  it("full round trip with PKCE + client_secret", async () => {
    const tokens = await runOAuthCodeFlow({
      authorizeUrl: prov.authorizeUrl,
      tokenUrl: prov.tokenUrl,
      clientId: "test-client",
      clientSecret: "test-secret",
      scopes: ["read", "write"],
      openExternal: async (url) => simulateProviderCallback(url),
      timeoutMs: 10_000,
    });
    assert.strictEqual(tokens.access_token, "prov-at-1");
    const body = new URLSearchParams(prov.seenBodies[0]);
    assert.strictEqual(body.get("code"), "prov-code-9");
    assert.strictEqual(body.get("client_secret"), "test-secret");
    assert.ok(body.get("code_verifier"));
  });
});

describe("IntegrationService", () => {
  let prov: Awaited<ReturnType<typeof startFakeProvider>>;
  before(async () => {
    prov = await startFakeProvider();
  });
  after(() => prov.close());

  it("getAuthState mirrors Cursor's integrationAuth shape", async () => {
    integrationStubControls.reset();
    const { context, secrets } = makeContext();
    const store = new IntegrationTokenStore(secrets as never);
    await store.set("github", { access_token: "ghu-seeded" });
    const service = new IntegrationService(context);
    try {
      assert.deepStrictEqual(service.getAuthState(), {
        githubConnected: false,
        linearConnected: false,
        isLoading: true,
      });
      await service.initialize();
      assert.deepStrictEqual(service.getAuthState(), {
        githubConnected: true,
        linearConnected: false,
        isLoading: false,
      });
    } finally {
      service.dispose();
    }
  });

  it("connectWith runs the flow and marks the provider connected", async () => {
    integrationStubControls.reset();
    const { context } = makeContext();
    const service = new IntegrationService(context);
    const events: string[] = [];
    try {
      await service.initialize();
      service.onDidChange((e) => events.push(e.kind));
      const ok = await service.connectWith({
        providerId: "linear",
        clientId: "test-client",
        authorizeUrl: prov.authorizeUrl,
        tokenUrl: prov.tokenUrl,
        openExternal: async (url) => simulateProviderCallback(url),
      });
      assert.strictEqual(ok, true);
      assert.strictEqual(service.isConnected("linear"), true);
      assert.strictEqual(service.getAuthState().linearConnected, true);
      assert.strictEqual(await service.getAccessToken("linear"), "prov-at-1");
      assert.ok(events.includes("authStateChanged"));
    } finally {
      service.dispose();
    }
  });

  it("disconnect clears the token and emits", async () => {
    integrationStubControls.reset();
    const { context, secrets } = makeContext();
    const store = new IntegrationTokenStore(secrets as never);
    await store.set("github", { access_token: "ghu-seeded" });
    const service = new IntegrationService(context);
    try {
      await service.initialize();
      assert.strictEqual(service.isConnected("github"), true);
      await service.disconnect("github");
      assert.strictEqual(service.isConnected("github"), false);
      assert.strictEqual(await service.getAccessToken("github"), undefined);
    } finally {
      service.dispose();
    }
  });

  it("maybeNudgeGitHubConnect: throttled toast, skipped when connected", async () => {
    integrationStubControls.reset();
    const { context, secrets, globalState } = makeContext();
    const service = new IntegrationService(context);
    try {
      await service.initialize();
      await service.maybeNudgeGitHubConnect();
      assert.strictEqual(integrationStubControls.shownMessages.length, 1);
      assert.ok(
        integrationStubControls.shownMessages[0].message.includes("Connect GitHub"),
        integrationStubControls.shownMessages[0].message,
      );
      // Second call within 24h → no toast.
      await service.maybeNudgeGitHubConnect();
      assert.strictEqual(integrationStubControls.shownMessages.length, 1);

      // Connected → never nudges.
      const store = new IntegrationTokenStore(secrets as never);
      await store.set("github", { access_token: "ghu-1" });
      globalState.clear();
      const service2 = new IntegrationService(context);
      try {
        await service2.initialize();
        integrationStubControls.reset();
        await service2.maybeNudgeGitHubConnect();
        assert.strictEqual(integrationStubControls.shownMessages.length, 0);
      } finally {
        service2.dispose();
      }
    } finally {
      service.dispose();
    }
  });
});

describe("DEV-GAPS-80 (W80B) — activate() wiring for ide.integrations.*", () => {
  it("activateIntegrations registers exactly the 3 commands and pushes the service to subscriptions", async () => {
    integrationStubControls.reset();
    const { context } = makeContext();
    const service = activateIntegrations(context as never);
    try {
      assert.deepStrictEqual(
        [...integrationStubControls.registeredCommands.keys()].sort(),
        [
          "ide.integrations.connect",
          "ide.integrations.disconnect",
          "ide.integrations.openSettings",
        ],
      );
      assert.ok(
        (context as unknown as { subscriptions: unknown[] }).subscriptions.includes(service),
        "activateIntegrations must push the service into context.subscriptions",
      );
      // Let initialize() settle so no dangling promise outlives the test.
      await new Promise((r) => setTimeout(r, 10));
      assert.strictEqual(service.getAuthState().isLoading, false);
    } finally {
      service.dispose();
    }
    // Disposal (what context.subscriptions disposal does on deactivate)
    // must unregister every command — no leaked registrations.
    assert.strictEqual(integrationStubControls.registeredCommands.size, 0);
  });

  it("the registered disconnect handler is live: no connections -> 'No integrations connected.'", async () => {
    integrationStubControls.reset();
    const { context } = makeContext();
    const service = activateIntegrations(context as never);
    try {
      await new Promise((r) => setTimeout(r, 10));
      const handler = integrationStubControls.registeredCommands.get(
        "ide.integrations.disconnect",
      );
      assert.ok(handler, "disconnect handler must be registered");
      await handler();
      assert.ok(
        integrationStubControls.shownMessages.some(
          (m) => m.message === "No integrations connected.",
        ),
        `expected the real disconnect handler to report no connections, got ${JSON.stringify(integrationStubControls.shownMessages)}`,
      );
    } finally {
      service.dispose();
    }
  });

  it("extension.ts activate() wires activateIntegrations directly, exactly once, and mcp/index.ts no longer calls it", () => {
    // Compiled to out/integrations/test/, so src/ is ../../../src.
    const SRC = path.resolve(__dirname, "..", "..", "..", "src");
    const extensionTs = fs.readFileSync(path.join(SRC, "extension.ts"), "utf8");
    const mcpIndexTs = fs.readFileSync(path.join(SRC, "mcp", "index.ts"), "utf8");
    assert.ok(
      extensionTs.includes('import { activateIntegrations } from "./integrations";'),
      "extension.ts must import activateIntegrations from ./integrations",
    );
    const calls = extensionTs.match(/activateIntegrations\(context\)/g) ?? [];
    assert.strictEqual(calls.length, 1, "activate() must call activateIntegrations(context) exactly once");
    // The call must sit inside activate(), before the activateMcp call it
    // used to hide behind (so an MCP failure cannot take it down).
    const activateStart = extensionTs.indexOf("export function activate(");
    const wireAt = extensionTs.indexOf("activateIntegrations(context)");
    const mcpAt = extensionTs.indexOf("activateMcp(context");
    assert.ok(activateStart >= 0 && wireAt > activateStart, "wiring must be inside activate()");
    assert.ok(wireAt < mcpAt, "integrations wiring must precede activateMcp");
    assert.ok(
      !/activateIntegrations\(context\)/.test(mcpIndexTs),
      "mcp/index.ts must NOT call activateIntegrations (duplicate registration)",
    );
  });
});
