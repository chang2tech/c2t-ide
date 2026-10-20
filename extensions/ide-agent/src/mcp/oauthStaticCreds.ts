/**
 * MCP OAuth static client credentials — Cursor parity.
 *
 * Binary evidence (cursor-mcp/dist/main.js, cursor-3.25.9):
 * - @1010800: `const c = qFm("auth" in r ? r.auth?.CLIENT_ID : void 0),
 *   u = c ? { client_id: c, ..."auth" in r && r.auth?.CLIENT_SECRET
 *     ? { client_secret: r.auth.CLIENT_SECRET } : {} } : void 0`
 *   → an mcp.json server entry may carry `auth: { CLIENT_ID, CLIENT_SECRET }`;
 *   when CLIENT_ID is present it becomes `staticClientInformation` on the
 *   OAuth provider and DYNAMIC CLIENT REGISTRATION IS SKIPPED.
 * - @949750 (`getCurrentClientInformationForAttempt`): when static info is
 *   present, stored client info is read; if the stored `client_id` equals the
 *   static one the enriched stored record is reused, otherwise
 *   `{...staticClientInformation, redirect_uris: canonicalAuthRedirectUrls}`.
 * - @946600: `hostedCallback = usesLoopbackRedirect && t.hostedCallback===true
 *   && staticClientInformation===undefined` → hosted (portal) callbacks are
 *   disabled for static-cred servers.
 * - @946600: token storage is keyed by canonical server URL
 *   (`storageScope` default `"canonicalServerUrl"`).
 *
 * HONEST-DIVERGENCE: Cursor persists OAuth data in a `diskKV` abstraction
 * (commands `mcp.diskKV*`) inside mcpProcess. Our fork stores the same data
 * in `vscode.SecretStorage` (OS-keychain-backed) — strictly better security
 * posture, same keying scheme. Recorded in docs/rea/deep-mcp.md §9.
 */
import * as crypto from "node:crypto";
import * as vscode from "vscode";
import type { McpServerAuthConfig } from "./types";

export type { McpServerAuthConfig };

/** Static OAuth client information, as handed to the OAuth provider. */
export interface StaticClientInfo {
  client_id: string;
  client_secret?: string;
}

/** OAuth client information enriched with redirect URIs (post-resolution). */
export interface ResolvedClientInfo extends StaticClientInfo {
  redirect_uris: string[];
  [key: string]: unknown;
}

/** Stored client info record (as previously persisted). */
export interface StoredClientInfo {
  client_id: string;
  client_secret?: string;
  redirect_uris?: string[];
  [key: string]: unknown;
}

/** OAuth tokens persisted per server. */
export interface McpOAuthTokens {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_at_ms?: number;
  scope?: string;
}

/**
 * Build `staticClientInformation` from an mcp.json `auth` block.
 * Verbatim logic from cursor-mcp @1010800:
 * `CLIENT_ID` present → `{client_id, ...(CLIENT_SECRET ? {client_secret} : {})}`,
 * otherwise `undefined` (dynamic client registration path).
 */
export function staticClientInfoFromConfig(
  auth: McpServerAuthConfig | undefined,
): StaticClientInfo | undefined {
  const clientId = auth?.CLIENT_ID;
  if (!clientId) {
    return undefined;
  }
  const info: StaticClientInfo = { client_id: clientId };
  if (auth?.CLIENT_SECRET) {
    info.client_secret = auth.CLIENT_SECRET;
  }
  return info;
}

/**
 * Resolve the client information for an OAuth attempt.
 * Verbatim precedence from cursor-mcp @949750:
 * 1. If stored client info exists AND its `client_id` equals the static one,
 *    reuse the enriched stored record.
 * 2. Otherwise use `{...staticClientInformation, redirect_uris}`.
 */
export function resolveClientInformation(
  staticInfo: StaticClientInfo,
  stored: StoredClientInfo | undefined,
  redirectUris: string[],
): ResolvedClientInfo {
  if (stored && stored.client_id === staticInfo.client_id) {
    return { ...staticInfo, ...stored, redirect_uris: redirectUris } as ResolvedClientInfo;
  }
  return { ...staticInfo, redirect_uris: redirectUris };
}

/**
 * Canonical server URL for token storage scoping (Cursor's
 * `storageScope: "canonicalServerUrl"`). Normalizes scheme+host case,
 * drops default ports and trailing slashes so `https://x/` and
 * `https://x` share one token record.
 */
export function canonicalizeServerUrl(serverUrl: string): string {
  try {
    const u = new URL(serverUrl);
    const isDefaultPort =
      (u.protocol === "https:" && u.port === "443") || (u.protocol === "http:" && u.port === "80");
    const host = u.hostname.toLowerCase() + (u.port && !isDefaultPort ? `:${u.port}` : "");
    const path = u.pathname.replace(/\/+$/, "") || "";
    return `${u.protocol}//${host}${path}`;
  } catch {
    return serverUrl.trim().replace(/\/+$/, "");
  }
}

const storageKey = (kind: "tokens" | "clientInfo", serverUrl: string): string => {
  const digest = crypto.createHash("sha256").update(canonicalizeServerUrl(serverUrl)).digest("hex").slice(0, 32);
  return `ide.mcp.oauth.${kind}.${digest}`;
};

/**
 * SecretStorage-backed OAuth persistence, keyed by canonical server URL.
 * (Cursor: diskKV in mcpProcess — see HONEST-DIVERGENCE note above.)
 */
export class McpOAuthTokenStore {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  async getTokens(serverUrl: string): Promise<McpOAuthTokens | undefined> {
    return this.read<McpOAuthTokens>(storageKey("tokens", serverUrl));
  }

  async saveTokens(serverUrl: string, tokens: McpOAuthTokens): Promise<void> {
    await this.secrets.store(storageKey("tokens", serverUrl), JSON.stringify(tokens));
  }

  async clearTokens(serverUrl: string): Promise<void> {
    await this.secrets.delete(storageKey("tokens", serverUrl));
  }

  async getStoredClientInfo(serverUrl: string): Promise<StoredClientInfo | undefined> {
    return this.read<StoredClientInfo>(storageKey("clientInfo", serverUrl));
  }

  async saveStoredClientInfo(serverUrl: string, info: StoredClientInfo): Promise<void> {
    await this.secrets.store(storageKey("clientInfo", serverUrl), JSON.stringify(info));
  }

  private async read<T>(key: string): Promise<T | undefined> {
    const raw = await this.secrets.get(key);
    if (!raw) {
      return undefined;
    }
    try {
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  }
}
