/**
 * Integrations module public surface.
 *
 * Entry point: `activateIntegrations(context)` — registers the
 * `ide.integrations.*` commands and loads connected state. Called
 * directly from `activate()` in src/extension.ts (DEV-GAPS-80/W80B;
 * previously only indirectly via `activateMcp()` in src/mcp/index.ts,
 * which no longer calls it — exactly one registration path).
 */
import * as vscode from "vscode";
import { IntegrationService } from "./service";

export { IntegrationService } from "./service";
export type { IntegrationAuthState, IntegrationServiceEvent } from "./service";
export { INTEGRATION_PROVIDERS, INTEGRATION_PROVIDER_IDS, resolveClientCredentials } from "./providers";
export type { IntegrationProviderId, IntegrationProviderDefinition } from "./providers";
export { IntegrationTokenStore } from "./tokenStore";
export { runOAuthCodeFlow, OAuthFlowError } from "./oauth";
export type { OAuthCodeFlowRequest, OAuthTokens } from "./oauth";

/**
 * Activate integrations. Safe to call once; returns the service (also pushed
 * to `context.subscriptions` for disposal on deactivate).
 */
export function activateIntegrations(context: vscode.ExtensionContext): IntegrationService {
  const service = new IntegrationService(context);
  context.subscriptions.push(service);
  service.registerCommands();
  void service.initialize();
  return service;
}
