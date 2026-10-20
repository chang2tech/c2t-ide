/**
 * Generic OAuth 2.0 authorization-code + PKCE flow over a loopback redirect.
 *
 * Same mechanism as `mcp/oauthFlow.ts` (Cursor's `gd` redirect strategy:
 * `http://localhost:8787/callback`, ephemeral-port fallback), factored for
 * the integrations surface. The browser opener is injectable so tests can
 * simulate the provider callback without a real browser.
 */
import * as crypto from "node:crypto";
import * as http from "node:http";

export interface OAuthCodeFlowRequest {
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  scopes: string[];
  /** Extra authorize-url params (e.g. Linear's `actor`). */
  extraAuthorizeParams?: Record<string, string>;
  openExternal: (url: string) => unknown;
  /** Preferred loopback ports; 0 (ephemeral) is always tried last. */
  preferredPorts?: number[];
  timeoutMs?: number;
}

export interface OAuthTokens {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_at_ms?: number;
  scope?: string;
}

const base64Url = (buf: Buffer): string =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export class OAuthFlowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthFlowError";
  }
}

export async function runOAuthCodeFlow(req: OAuthCodeFlowRequest): Promise<OAuthTokens> {
  const timeoutMs = req.timeoutMs ?? 5 * 60 * 1000;
  const { server, port, redirectUri } = await bindLoopback(req.preferredPorts ?? [8787]);
  const state = base64Url(crypto.randomBytes(16));
  const verifier = base64Url(crypto.randomBytes(48));
  const challenge = base64Url(crypto.createHash("sha256").update(verifier).digest());

  const authUrl = new URL(req.authorizeUrl);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", req.clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", req.scopes.join(" "));
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  for (const [k, v] of Object.entries(req.extraAuthorizeParams ?? {})) {
    authUrl.searchParams.set(k, v);
  }

  // Attach the callback waiter BEFORE opening the browser: the provider
  // may redirect back instantly (and tests simulate exactly that). Opening
  // first would leave the loopback with no request handler → deadlock.
  const waiter = waitForCallback(server, redirectUri, state, timeoutMs);
  // DEV-GAPS-82 (W82C): if openExternal throws, waiter.promise is never
  // awaited. Without a handler its eventual rejection (e.g. the 300s
  // timeout) surfaces as an unhandledRejection, and without cancel() its
  // timer keeps the event loop alive for the full timeout — in the test
  // suite this hung the process ~303s after the test had already failed.
  // The noop catch only marks the promise handled; the `await` below
  // still observes the same rejection on the normal path.
  waiter.promise.catch(() => {});
  try {
    await req.openExternal(authUrl.toString());
    const code = await waiter.promise;
    return await exchangeCode(req, code, redirectUri, verifier);
  } finally {
    waiter.cancel();
    server.close();
  }
}

async function bindLoopback(
  preferredPorts: number[],
): Promise<{ server: http.Server; port: number; redirectUri: string }> {
  for (const port of [...preferredPorts, 0]) {
    try {
      const server = await listenOnce(port);
      const addr = server.address();
      if (addr && typeof addr === "object") {
        return { server, port: addr.port, redirectUri: `http://127.0.0.1:${addr.port}/callback` };
      }
      server.close();
    } catch {
      /* busy — try next */
    }
  }
  throw new OAuthFlowError("OAuth loopback redirect could not be bound");
}

function listenOnce(port: number): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

function waitForCallback(
  server: http.Server,
  redirectUri: string,
  state: string,
  timeoutMs: number,
): { promise: Promise<string>; cancel: () => void } {
  const expectedPath = new URL(redirectUri).pathname;
  let cancel: () => void = () => {};
  const promise = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new OAuthFlowError("OAuth flow timed out waiting for the browser callback"));
    }, timeoutMs);
    const onRequest = (req: http.IncomingMessage, res: http.ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== expectedPath) {
        res.writeHead(404);
        res.end();
        return;
      }
      const finish = (ok: boolean, body: string) => {
        res.writeHead(200);
        res.end(body);
        cleanup();
      };
      if (url.searchParams.get("state") !== state) {
        finish(false, "Invalid state — you can close this tab.");
        reject(new OAuthFlowError("OAuth callback state mismatch"));
        return;
      }
      const error = url.searchParams.get("error");
      if (error) {
        finish(false, "Authorization failed — you can close this tab.");
        reject(new OAuthFlowError(`Authorization failed: ${error}`));
        return;
      }
      const code = url.searchParams.get("code");
      finish(true, "Connected — you can close this tab.");
      if (code) {
        resolve(code);
      } else {
        reject(new OAuthFlowError("OAuth callback missing authorization code"));
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      server.removeListener("request", onRequest);
    };
    // cancel() only disarms the waiter (timer + listener); it deliberately
    // does NOT settle the promise, so an aborted flow leaves no rejection
    // behind and holds no event-loop handle.
    cancel = cleanup;
    server.on("request", onRequest);
  });
  return { promise, cancel: () => cancel() };
}

async function exchangeCode(
  req: OAuthCodeFlowRequest,
  code: string,
  redirectUri: string,
  verifier: string,
): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: req.clientId,
    code_verifier: verifier,
  });
  if (req.clientSecret) {
    body.set("client_secret", req.clientSecret);
  }
  const res = await fetch(req.tokenUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new OAuthFlowError(`Token exchange failed: HTTP ${res.status}`);
  }
  const json = (await res.json()) as Record<string, unknown>;
  if (typeof json.access_token !== "string") {
    const err = typeof json.error_description === "string" ? json.error_description : "missing access_token";
    throw new OAuthFlowError(`Token exchange failed: ${err}`);
  }
  const tokens: OAuthTokens = { access_token: json.access_token };
  if (typeof json.refresh_token === "string") tokens.refresh_token = json.refresh_token;
  if (typeof json.token_type === "string") tokens.token_type = json.token_type;
  if (typeof json.scope === "string") tokens.scope = json.scope;
  if (typeof json.expires_in === "number") tokens.expires_at_ms = Date.now() + json.expires_in * 1000;
  return tokens;
}
