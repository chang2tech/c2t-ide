/**
 * MCP OAuth authorization-code flow with static client credentials — Cursor parity.
 *
 * Binary evidence (cursor-mcp/dist/main.js, cursor-3.25.9):
 * - Redirect strategies (deep-mcp.md §3.2): `gd` → `http://localhost:8787/callback`
 *   (plus per-port variants). Our flow binds a loopback listener on
 *   127.0.0.1 and uses `http://127.0.0.1:<port>/callback` — the same mechanism
 *   (loopback redirect); we prefer an ephemeral port with 8787 as the first
 *   try, and fall back cleanly (`McpOAuthLoopbackUnavailableError` equivalent
 *   → hard failure, NOT retryable, per deep-mcp.md §2.4).
 * - `proper_well_known_for_mcp_scopes` feature gate → token/authorization
 *   endpoint discovery via RFC 8414 / RFC 9728 well-known documents.
 * - Events: `{target:"auth", kind:"auth_required", authorizationUrl}` and
 *   `{target:"auth", kind:"tokens_saved"}` (@1012900).
 * - `backendOnlyTokenExchange` → server-side OAuth is out of scope for local
 *   mcp.json entries (cloud MCP surface only).
 *
 * What this module does:
 * 1. Discovers the authorization + token endpoints from well-known metadata.
 * 2. Runs the authorization-code flow with PKCE (S256) via a loopback server.
 * 3. Persists tokens through McpOAuthTokenStore (SecretStorage).
 * 4. `McpOAuthBroker.promptAndAuthenticate()` — the service-level glue:
 *    on an auth failure for a static-cred server, offers "Authenticate",
 *    runs the flow, and reports success so the caller can restart the server.
 */
import * as crypto from "node:crypto";
import * as http from "node:http";
import * as vscode from "vscode";
import {
  McpOAuthTokenStore,
  McpOAuthTokens,
  StaticClientInfo,
  canonicalizeServerUrl,
  resolveClientInformation,
} from "./oauthStaticCreds";

/** Error taxonomy (deep-mcp.md §3.4, subset relevant to the flow). */
export class McpOAuthLoopbackUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpOAuthLoopbackUnavailableError";
  }
}
export class McpOAuthFlowCancelledError extends Error {
  constructor() {
    super("MCP OAuth flow cancelled by the user");
    this.name = "McpOAuthFlowCancelledError";
  }
}
export class McpOAuthDiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpOAuthDiscoveryError";
  }
}

export interface OAuthEndpoints {
  authorizationEndpoint: string;
  tokenEndpoint: string;
}

/** Injectable browser opener (default: `vscode.env.openExternal`). */
export type OpenExternal = (url: string) => unknown;

interface ProtectedResourceMetadata {
  authorization_servers?: string[];
}

/**
 * Discover OAuth endpoints for an MCP server (RFC 9728 → RFC 8414).
 * Mirrors Cursor's well-known discovery (`proper_well_known_for_mcp_scopes`).
 */
export async function discoverOAuthEndpoints(serverUrl: string): Promise<OAuthEndpoints> {
  const resource = new URL("/.well-known/oauth-protected-resource", serverUrl).toString();
  const prm = await fetchJson<ProtectedResourceMetadata>(resource).catch(() => undefined);
  const authServers = prm?.authorization_servers?.length
    ? prm.authorization_servers
    : [new URL(serverUrl).origin];
  for (const authServer of authServers) {
    const docUrl = new URL("/.well-known/oauth-authorization-server", authServer).toString();
    const doc = await fetchJson<{
      authorization_endpoint?: string;
      token_endpoint?: string;
    }>(docUrl).catch(() => undefined);
    if (doc?.authorization_endpoint && doc?.token_endpoint) {
      return { authorizationEndpoint: doc.authorization_endpoint, tokenEndpoint: doc.token_endpoint };
    }
  }
  throw new McpOAuthDiscoveryError(
    `No OAuth authorization server metadata found for ${canonicalizeServerUrl(serverUrl)}`,
  );
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { redirect: "manual" });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

const base64Url = (buf: Buffer): string =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const newCodeVerifier = (): string => base64Url(crypto.randomBytes(48));
const codeChallenge = (verifier: string): string =>
  base64Url(crypto.createHash("sha256").update(verifier).digest());

/** Preferred loopback ports (Cursor's `gd` strategy: 8787 first). */
const PREFERRED_LOOPBACK_PORTS = [8787, 18787, 28787, 31787];

export interface AuthorizationRequest {
  serverDisplayName: string;
  serverUrl: string;
  clientInfo: StaticClientInfo;
  scopes: string[];
  endpoints: OAuthEndpoints;
  openExternal?: OpenExternal;
  /** Timeout for the user to complete the browser step (default 5 min). */
  timeoutMs?: number;
}

export interface AuthorizationResult {
  tokens: McpOAuthTokens;
  /** Redirect URIs that were registered/used (for client-info resolution). */
  redirectUris: string[];
}

/**
 * Run one authorization-code + PKCE round trip through a loopback redirect.
 * Opens the authorization URL in the browser and waits for the code on
 * `http://127.0.0.1:<port>/callback`, then exchanges it for tokens.
 */
export async function runAuthorizationCodeFlow(req: AuthorizationRequest): Promise<AuthorizationResult> {
  const openExternal: OpenExternal =
    req.openExternal ?? ((url) => vscode.env.openExternal(vscode.Uri.parse(url)));
  const timeoutMs = req.timeoutMs ?? 5 * 60 * 1000;

  const { server, port } = await bindLoopback();
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const state = base64Url(crypto.randomBytes(16));
  const verifier = newCodeVerifier();

  const authUrl = new URL(req.endpoints.authorizationEndpoint);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", req.clientInfo.client_id);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  if (req.scopes.length > 0) {
    authUrl.searchParams.set("scope", req.scopes.join(" "));
  }
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", codeChallenge(verifier));
  authUrl.searchParams.set("code_challenge_method", "S256");

  try {
    // Attach the callback waiter BEFORE opening the browser: the provider
    // may redirect back instantly (and tests simulate exactly that). Opening
    // first would leave the loopback with no request handler → deadlock.
    const codePromise = waitForCallback(server, state, timeoutMs);
    await openExternal(authUrl.toString());
    const code = await codePromise;
    const tokens = await exchangeCode(req.endpoints.tokenEndpoint, {
      code,
      redirectUri,
      verifier,
      clientId: req.clientInfo.client_id,
      clientSecret: req.clientInfo.client_secret,
    });
    return { tokens, redirectUris: [redirectUri] };
  } finally {
    server.close();
  }
}

async function bindLoopback(): Promise<{ server: http.Server; port: number }> {
  for (const preferred of PREFERRED_LOOPBACK_PORTS) {
    try {
      return await listenOnce(preferred);
    } catch {
      /* port busy — try next */
    }
  }
  try {
    return await listenOnce(0);
  } catch (e) {
    // Cursor: `McpOAuthLoopbackUnavailableError` — hard, non-retryable failure.
    throw new McpOAuthLoopbackUnavailableError(
      `OAuth loopback redirect could not be bound: ${(e as Error).message}`,
    );
  }
}

function listenOnce(port: number): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        resolve({ server, port: addr.port });
      } else {
        reject(new Error("loopback listen failed"));
      }
    });
  });
}

function waitForCallback(server: http.Server, state: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new McpOAuthFlowCancelledError());
    }, timeoutMs);
    const onRequest = (req: http.IncomingMessage, res: http.ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.writeHead(404);
        res.end();
        return;
      }
      if (url.searchParams.get("state") !== state) {
        res.writeHead(400);
        res.end("Invalid state");
        return;
      }
      const error = url.searchParams.get("error");
      if (error) {
        res.writeHead(200);
        res.end("Authorization failed — you can close this tab.");
        cleanup();
        reject(new Error(`OAuth authorization failed: ${error}`));
        return;
      }
      const code = url.searchParams.get("code");
      res.writeHead(200);
      res.end("Authorization complete — you can close this tab.");
      cleanup();
      if (code) {
        resolve(code);
      } else {
        reject(new Error("OAuth callback missing authorization code"));
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      server.removeListener("request", onRequest);
    };
    server.on("request", onRequest);
  });
}

async function exchangeCode(
  tokenEndpoint: string,
  params: {
    code: string;
    redirectUri: string;
    verifier: string;
    clientId: string;
    clientSecret?: string;
  },
): Promise<McpOAuthTokens> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: params.clientId,
    code_verifier: params.verifier,
  });
  if (params.clientSecret) {
    body.set("client_secret", params.clientSecret);
  }
  const res = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(`Token exchange failed: HTTP ${res.status}`);
  }
  const json = (await res.json()) as Record<string, unknown>;
  if (typeof json.access_token !== "string") {
    throw new Error("Token exchange response missing access_token");
  }
  const tokens: McpOAuthTokens = { access_token: json.access_token };
  if (typeof json.refresh_token === "string") tokens.refresh_token = json.refresh_token;
  if (typeof json.token_type === "string") tokens.token_type = json.token_type;
  if (typeof json.scope === "string") tokens.scope = json.scope;
  if (typeof json.expires_in === "number") tokens.expires_at_ms = Date.now() + json.expires_in * 1000;
  return tokens;
}

/**
 * Refresh an access token (distributed-refresh-locking is out of scope for
 * the single-window extension host; Cursor's diskKV lease pattern only
 * matters multi-window in mcpProcess).
 */
export async function refreshAccessToken(
  tokenEndpoint: string,
  clientInfo: StaticClientInfo,
  refreshToken: string,
): Promise<McpOAuthTokens> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientInfo.client_id,
  });
  if (clientInfo.client_secret) {
    body.set("client_secret", clientInfo.client_secret);
  }
  const res = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(`Token refresh failed: HTTP ${res.status}`);
  }
  const json = (await res.json()) as Record<string, unknown>;
  if (typeof json.access_token !== "string") {
    throw new Error("Refresh response missing access_token");
  }
  const tokens: McpOAuthTokens = {
    access_token: json.access_token,
    refresh_token: typeof json.refresh_token === "string" ? json.refresh_token : refreshToken,
  };
  if (typeof json.token_type === "string") tokens.token_type = json.token_type;
  if (typeof json.scope === "string") tokens.scope = json.scope;
  if (typeof json.expires_in === "number") tokens.expires_at_ms = Date.now() + json.expires_in * 1000;
  return tokens;
}

/**
 * Service-level glue: on an auth failure for a static-cred server, offer the
 * user "Authenticate", run the flow, and persist tokens. Mirrors Cursor's
 * `{target:"auth", kind:"auth_required", authorizationUrl}` → user gesture →
 * `{target:"auth", kind:"tokens_saved"}` event pair.
 */
export class McpOAuthBroker {
  private readonly tokenStore: McpOAuthTokenStore;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly oauthLogger: (message: string) => void,
    private readonly openExternal?: OpenExternal,
  ) {
    this.tokenStore = new McpOAuthTokenStore(context.secrets);
  }

  /**
   * Prompt the user to authenticate a static-cred server that failed with an
   * auth error. Returns true when fresh tokens were saved (caller should
   * restart the server), false when the user declined.
   */
  async promptAndAuthenticate(
    serverDisplayName: string,
    serverUrl: string,
    clientInfo: StaticClientInfo,
    scopes: string[],
  ): Promise<boolean> {
    const choice = await vscode.window.showErrorMessage(
      `MCP server "${serverDisplayName}" needs authentication.`,
      "Authenticate",
      "Dismiss",
    );
    if (choice !== "Authenticate") {
      return false;
    }
    try {
      const endpoints = await discoverOAuthEndpoints(serverUrl);
      const stored = await this.tokenStore.getStoredClientInfo(serverUrl);
      const result = await runAuthorizationCodeFlow({
        serverDisplayName,
        serverUrl,
        clientInfo,
        scopes,
        endpoints,
        openExternal: this.openExternal,
      });
      await this.tokenStore.saveTokens(serverUrl, result.tokens);
      // Persist enriched client info so the next attempt reuses it
      // (cursor-mcp @949750: stored client_id === static client_id → reuse).
      await this.tokenStore.saveStoredClientInfo(
        serverUrl,
        resolveClientInformation(clientInfo, stored, result.redirectUris),
      );
      this.oauthLogger(`[mcp] ${serverDisplayName}: OAuth tokens saved`);
      void vscode.window.showInformationMessage(`MCP server "${serverDisplayName}" authenticated.`);
      return true;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.oauthLogger(`[mcp] ${serverDisplayName}: OAuth failed — ${message}`);
      if (!(e instanceof McpOAuthFlowCancelledError)) {
        void vscode.window.showErrorMessage(`MCP OAuth failed for "${serverDisplayName}": ${message}`);
      }
      return false;
    }
  }

  getTokenStore(): McpOAuthTokenStore {
    return this.tokenStore;
  }
}
