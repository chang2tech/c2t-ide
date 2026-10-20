/**
 * SecretStorage-backed token store for integrations.
 *
 * One record per provider id: `ide.integrations.tokens.<providerId>`.
 * Tokens never touch disk in plaintext; SecretStorage is OS-keychain-backed.
 */
import * as vscode from "vscode";
import type { IntegrationProviderId } from "./providers";
import type { OAuthTokens } from "./oauth";

const keyFor = (providerId: IntegrationProviderId): string =>
  `ide.integrations.tokens.${providerId}`;

export class IntegrationTokenStore {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  async get(providerId: IntegrationProviderId): Promise<OAuthTokens | undefined> {
    const raw = await this.secrets.get(keyFor(providerId));
    if (!raw) {
      return undefined;
    }
    try {
      const parsed = JSON.parse(raw) as OAuthTokens;
      return typeof parsed.access_token === "string" ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  async set(providerId: IntegrationProviderId, tokens: OAuthTokens): Promise<void> {
    await this.secrets.store(keyFor(providerId), JSON.stringify(tokens));
  }

  async clear(providerId: IntegrationProviderId): Promise<void> {
    await this.secrets.delete(keyFor(providerId));
  }
}
