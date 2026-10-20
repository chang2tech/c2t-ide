/**
 * Integration providers — Cursor parity (surface), direct OAuth (mechanism).
 *
 * Binary evidence (workbench.glass.main.js, cursor-3.25.9):
 * - Proto messages `aiserver.v1.{Github,Linear,Slack,Bitbucket,Gitlab,Jira}IntegrationSettings`
 *   (each carrying a `hidden` scalar) → Cursor models six integrations.
 * - `integrationAuth` query exposing `githubConnected`, `linearConnected`,
 *   `hasSlackAuth`, `isLoading` → the IDE reads a connected-state map.
 * - `glass-github-connect-nudge.js`: "Connect GitHub to create, update, and
 *   merge pull requests directly in Cursor." — throttled toast (storage key
 *   `GITHUB_CONNECT_DIFF_PANEL_NUDGE_LAST_PROMPT_AT_MS`) with a primary
 *   action that opens the integrations surface.
 *
 * HONEST-DIVERGENCE: Cursor brokers these integrations through the cursor.com
 * backend (dashboard "Integrations" page, `dashboardClient().getGithubInstallations()`).
 * This fork has no such backend, so auth runs as a direct OAuth 2.0
 * authorization-code flow against each provider's public endpoints, with
 * tokens in `vscode.SecretStorage`. The user registers an OAuth App with the
 * provider and puts the client id/secret in settings
 * (`ide.integrations.<id>.clientId` / `.clientSecret`) or env
 * (`IDE_INTEGRATIONS_<ID>_CLIENT_ID` / `_CLIENT_SECRET`). The provider
 * registry, connected-state shape, connect/disconnect commands and the
 * connect nudge mirror Cursor's surface.
 */

export type IntegrationProviderId = "github" | "linear";

export interface IntegrationProviderDefinition {
  /** Stable id, used in storage keys and settings. */
  id: IntegrationProviderId;
  /** Display name shown in UI. */
  name: string;
  /** OAuth authorization endpoint. */
  authorizeUrl: string;
  /** OAuth token endpoint. */
  tokenUrl: string;
  /** Default scopes requested. */
  scopes: string[];
  /** Short blurb for the connect UI. */
  description: string;
}

export const INTEGRATION_PROVIDERS: Record<IntegrationProviderId, IntegrationProviderDefinition> = {
  github: {
    id: "github",
    name: "GitHub",
    authorizeUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    scopes: ["repo", "read:user"],
    description: "Create, update, and merge pull requests; read repositories.",
  },
  linear: {
    id: "linear",
    name: "Linear",
    authorizeUrl: "https://linear.app/oauth/authorize",
    tokenUrl: "https://linear.app/oauth/token",
    scopes: ["read", "write"],
    description: "Read and update Linear issues, projects, and cycles.",
  },
};

export const INTEGRATION_PROVIDER_IDS = Object.keys(INTEGRATION_PROVIDERS) as IntegrationProviderId[];

/**
 * Client credentials for a provider. Resolution order: explicit arg >
 * settings (`ide.integrations.<id>.clientId`) > env
 * (`IDE_INTEGRATIONS_<ID>_CLIENT_ID`). The secret must NEVER be committed;
 * prefer env or the OS keychain-backed SecretStorage after first connect.
 */
export interface IntegrationClientCredentials {
  clientId: string;
  clientSecret?: string;
}

export function resolveClientCredentials(
  providerId: IntegrationProviderId,
  getConfig: (key: string) => string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): IntegrationClientCredentials | undefined {
  const envPrefix = `IDE_INTEGRATIONS_${providerId.toUpperCase()}_`;
  // GAPS-168: these keys are now declared in package.json
  // (`contributes.configuration`, "IDE Integrations", default ""). Once a
  // string setting is declared, VS Code's configuration registry serves
  // "" for it when unset (configurationRegistry `getDefaultValue('string')`
  // → ''), NOT undefined — so a `??` fallback would never reach the env
  // value and env-only setups would silently lose their credentials.
  // Treat "" as unset for both fields: non-empty setting > env > undefined.
  const clientId =
    getConfig(`ide.integrations.${providerId}.clientId`) || env[`${envPrefix}CLIENT_ID`];
  if (!clientId) {
    return undefined;
  }
  const clientSecret =
    getConfig(`ide.integrations.${providerId}.clientSecret`) || env[`${envPrefix}CLIENT_SECRET`];
  return { clientId, clientSecret };
}
