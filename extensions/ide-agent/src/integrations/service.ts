/**
 * Integration service — connected-state model + connect/disconnect UI.
 *
 * Mirrors Cursor's `integrationAuth` query surface (workbench.glass.main.js):
 * `{ githubConnected, linearConnected, isLoading }`, plus the
 * `glass-github-connect-nudge.js` pattern: a throttled toast offering
 * "Connect GitHub" whose primary action opens the integrations surface.
 */
import * as vscode from "vscode";
import { EventEmitter } from "node:events";
import {
  INTEGRATION_PROVIDERS,
  INTEGRATION_PROVIDER_IDS,
  IntegrationProviderId,
  resolveClientCredentials,
} from "./providers";
import { IntegrationTokenStore } from "./tokenStore";
import { runOAuthCodeFlow } from "./oauth";

/**
 * Connected-state snapshot. Field names mirror Cursor's `integrationAuth`
 * (`githubConnected`, `linearConnected`, `isLoading`).
 */
export interface IntegrationAuthState {
  githubConnected: boolean;
  linearConnected: boolean;
  isLoading: boolean;
}

export type IntegrationServiceEvent = { kind: "authStateChanged" };

/** Throttle for the GitHub connect nudge (Cursor: last-prompt timestamp gate). */
const GITHUB_NUDGE_KEY = "ide.integrations.githubConnectNudge.lastPromptAtMs";
const GITHUB_NUDGE_THROTTLE_MS = 24 * 60 * 60 * 1000;

export class IntegrationService implements vscode.Disposable {
  private readonly emitter = new EventEmitter();
  private readonly tokenStore: IntegrationTokenStore;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly connected = new Set<IntegrationProviderId>();
  private loading = false;
  private initialized = false;

  readonly onDidChange = (
    listener: (e: IntegrationServiceEvent) => void,
  ): vscode.Disposable => {
    this.emitter.on("event", listener);
    return { dispose: () => this.emitter.off("event", listener) };
  };

  constructor(private readonly context: vscode.ExtensionContext) {
    this.tokenStore = new IntegrationTokenStore(context.secrets);
  }

  /** Load connected state from SecretStorage. Call once at activation. */
  async initialize(): Promise<void> {
    this.loading = true;
    try {
      for (const id of INTEGRATION_PROVIDER_IDS) {
        if (await this.tokenStore.get(id)) {
          this.connected.add(id);
        }
      }
    } finally {
      this.loading = false;
      this.initialized = true;
      this.emit();
    }
  }

  /** Cursor-`integrationAuth`-shaped snapshot. */
  getAuthState(): IntegrationAuthState {
    return {
      githubConnected: this.connected.has("github"),
      linearConnected: this.connected.has("linear"),
      isLoading: this.loading || !this.initialized,
    };
  }

  isConnected(id: IntegrationProviderId): boolean {
    return this.connected.has(id);
  }

  /**
   * Run the OAuth connect flow for a provider. Credentials resolve
   * explicit arg > `ide.integrations.<id>.clientId` setting >
   * `IDE_INTEGRATIONS_<ID>_CLIENT_ID` env.
   */
  async connect(id: IntegrationProviderId, clientId?: string): Promise<boolean> {
    const def = INTEGRATION_PROVIDERS[id];
    const resolved =
      (clientId ? { clientId } : undefined) ??
      resolveClientCredentials(id, (key) => vscode.workspace.getConfiguration().get<string>(key));
    let creds = resolved;
    if (!creds) {
      const picked = await vscode.window.showInputBox({
        prompt: `${def.name} OAuth client ID (register an OAuth App with ${def.name} first)`,
        placeHolder: "OAuth client ID",
        ignoreFocusOut: true,
      });
      if (!picked) {
        return false;
      }
      creds = { clientId: picked };
    }
    return this.connectWith({
      providerId: id,
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      openExternal: (url) => vscode.env.openExternal(vscode.Uri.parse(url)),
    });
  }

  /**
   * Connect-flow core with injectable endpoints/opener (unit-testable).
   * `connect()` is the production entry point that fills these in from the
   * provider definition and the real vscode API.
   */
  async connectWith(options: {
    providerId: IntegrationProviderId;
    clientId: string;
    clientSecret?: string;
    authorizeUrl?: string;
    tokenUrl?: string;
    openExternal: (url: string) => unknown;
  }): Promise<boolean> {
    const def = INTEGRATION_PROVIDERS[options.providerId];
    try {
      const tokens = await runOAuthCodeFlow({
        authorizeUrl: options.authorizeUrl ?? def.authorizeUrl,
        tokenUrl: options.tokenUrl ?? def.tokenUrl,
        clientId: options.clientId,
        clientSecret: options.clientSecret,
        scopes: def.scopes,
        openExternal: options.openExternal,
      });
      await this.tokenStore.set(options.providerId, tokens);
      this.connected.add(options.providerId);
      this.emit();
      void vscode.window.showInformationMessage(`${def.name} connected.`);
      return true;
    } catch (e) {
      void vscode.window.showErrorMessage(
        `Failed to connect ${def.name}: ${e instanceof Error ? e.message : String(e)}`,
      );
      return false;
    }
  }

  /** Disconnect a provider (clears stored tokens). */
  async disconnect(id: IntegrationProviderId): Promise<void> {
    await this.tokenStore.clear(id);
    this.connected.delete(id);
    this.emit();
  }

  /** Stored access token for a connected provider (for API calls). */
  getAccessToken(id: IntegrationProviderId): Promise<string | undefined> {
    return this.tokenStore.get(id).then((t) => t?.access_token);
  }

  /**
   * Throttled "Connect GitHub" toast — mirrors
   * `glass-github-connect-nudge.js`: shown at most once per 24h, primary
   * action opens the integrations surface (here: runs the connect flow).
   */
  async maybeNudgeGitHubConnect(): Promise<void> {
    if (this.connected.has("github")) {
      return;
    }
    const last = this.context.globalState.get<number>(GITHUB_NUDGE_KEY, 0);
    if (Date.now() - last < GITHUB_NUDGE_THROTTLE_MS) {
      return;
    }
    await this.context.globalState.update(GITHUB_NUDGE_KEY, Date.now());
    const choice = await vscode.window.showInformationMessage(
      "Connect GitHub to create, update, and merge pull requests directly from the IDE.",
      "Connect GitHub",
      "Dismiss",
    );
    if (choice === "Connect GitHub") {
      await this.connect("github");
    }
  }

  /** Register `ide.integrations.*` commands. */
  registerCommands(): void {
    this.disposables.push(
      vscode.commands.registerCommand("ide.integrations.connect", async () => {
        const id = await this.pickProvider("Connect integration");
        if (id) {
          await this.connect(id);
        }
      }),
      vscode.commands.registerCommand("ide.integrations.disconnect", async () => {
        const connected = INTEGRATION_PROVIDER_IDS.filter((id) => this.connected.has(id));
        if (connected.length === 0) {
          void vscode.window.showInformationMessage("No integrations connected.");
          return;
        }
        const pick = await vscode.window.showQuickPick(
          connected.map((id) => ({ label: INTEGRATION_PROVIDERS[id].name, id })),
          { placeHolder: "Disconnect integration" },
        );
        if (pick) {
          await this.disconnect(pick.id);
        }
      }),
      vscode.commands.registerCommand("ide.integrations.openSettings", async () => {
        // HONEST-DIVERGENCE (DEV-GAPS-82 / W82B): this handler does NOT open
        // any settings UI — it only offers the provider picker (selecting a
        // disconnected provider starts its connect flow via pickProvider).
        // QA step 1 could NOT verify a Cursor settings surface for this:
        // in the Cursor 3.25.9 binary (workbench.desktop.main.js +
        // workbench.glass.main.js, re-checked against 3.26.13) there is no
        // "integrations" tab in the in-IDE Cursor Settings — the string
        // `"integrations"` never appears as a settingsTab value, and the
        // only literal `cursor.openCursorSettings` call site passes
        // `{settingsTab:"general",idToScrollTo:"privacy-mode-section"}`.
        // What IS verified: Cursor manages integrations on an EXTERNAL web
        // dashboard — `getIntegrationsUrl()` returns
        // `${cursorCreds.websiteUrl}/dashboard?tab=integrations`, opened via
        // `openerService.open(..., {openExternal:true})` (docs:
        // cursor.com/docs/integrations/linear, "Go to Cursor integrations").
        // This fork has no Cursor account / cursorCreds website URL and its
        // integrations are local direct-OAuth connections, so opening the
        // Cursor dashboard would not manage them. Until a real surface is
        // verified, the picker behaviour stays and no fake settings
        // page/webview is invented here.
        await this.pickProvider("Integrations");
      }),
    );
  }

  dispose(): void {
    for (const d of this.disposables) {
      try {
        d.dispose();
      } catch {
        /* ignore */
      }
    }
    this.emitter.removeAllListeners();
  }

  private async pickProvider(
    placeHolder: string,
  ): Promise<IntegrationProviderId | undefined> {
    const pick = await vscode.window.showQuickPick(
      INTEGRATION_PROVIDER_IDS.map((id) => {
        const def = INTEGRATION_PROVIDERS[id];
        return {
          label: def.name,
          description: this.connected.has(id) ? "connected" : def.description,
          id,
        };
      }),
      { placeHolder },
    );
    if (pick && !this.connected.has(pick.id)) {
      // Selecting a disconnected provider starts the connect flow,
      // mirroring Cursor's nudge action opening the integrations surface.
      await this.connect(pick.id);
      return undefined;
    }
    return pick?.id;
  }

  private emit(): void {
    this.emitter.emit("event", { kind: "authStateChanged" } satisfies IntegrationServiceEvent);
  }
}
