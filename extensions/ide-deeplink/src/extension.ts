/**
 * ide-deeplink — extension entry point.
 *
 * Cursor parity (binary-verified, extensions/cursor-deeplink/dist/main.js,
 * 3.25.6): a DEDICATED extension (not core) activates on `onUri` and
 * registers `vscode.window.registerUriHandler`. Incoming
 * `ide-code://anysphere.ide-code-deeplink/…` URLs are validated and routed;
 * `/mcp/install` parses `name` + base64 `config` and fires the workbench
 * command `composer.mcp.deeplinkInstall` (McpService), which proposes the
 * server to the user and installs it into the user mcp.json on confirm.
 *
 * HONEST-DIVERGENCE: Cursor's handler first executes
 * `aiSettings.action.open("mcp")` to open the MCP settings page before
 * firing the install command. This fork has no MCP settings page (no
 * `aiSettings` command exists), so that step is skipped; the install
 * prompt notification from `composer.mcp.deeplinkInstall` is the
 * user-visible surface.
 *
 * DEV-GAPS-110: the settings / customize / plugin / glass routes from the
 * same binary route table are dispatched below (`openAiSettings`,
 * `openCustomizeDeeplink`, the glass payload). Their fork divergences —
 * missing `aiSettings.action.open`, missing background-composer /
 * plan-usage pages, unconsumed `initialView` / glass handoff fields —
 * and the routes deliberately NOT implemented (/createchat,
 * /background-agent/setup, /automations*, /pr-review,
 * /github-connect-callback) are documented with binary offsets in
 * deeplink.ts.
 */
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  DEBUG_TRIGGER_PLACEHOLDER,
  DEBUG_TRIGGER_PROMPT,
  getDeeplinkQueryParam,
  routeDeeplink,
  validateDebugDeeplinkInput,
  type CustomizeDeeplinkTab,
  type CustomizeInitialView,
} from "./deeplink";

/** Binary Ns @423793: the Customize editor command the deeplink routes open. */
const OPEN_CUSTOMIZE_EDITOR_COMMAND = "workbench.action.openCustomizeEditor";
/** Binary ks @423835: the AI Settings command the settings routes open. */
const AI_SETTINGS_OPEN_COMMAND = "aiSettings.action.open";
/**
 * Fork analog of the binary's `cursor.openOrFocusGlassWindow`: the core
 * `ide.openOrFocusGlassWindow` action (glassWindowActions.ts). It reads
 * only `agentsWindowOpenSource` today — see the glass divergence note in
 * deeplink.ts.
 */
const OPEN_GLASS_WINDOW_COMMAND = "ide.openOrFocusGlassWindow";

/**
 * The binary's `Fs(err, id)` test: an error counts as "command not found"
 * when its message includes the command id AND the word "command"
 * (lowercase-checked). Only then do the binary's customize handlers fall
 * back; every other error propagates.
 */
function isCommandNotFoundError(err: unknown, commandId: string): boolean {
  return (
    err instanceof Error &&
    err.message.includes(commandId) &&
    err.message.toLowerCase().includes("command")
  );
}

/**
 * Open a Cursor AI Settings section — the binary's
 * `aiSettings.action.open(section?)` (no argument when `section` is
 * undefined). HONEST-DIVERGENCE: that command is not registered anywhere
 * in this fork, so on a command-not-found error this falls back to the
 * fork's existing AI-settings surface — `workbench.action.openSettings`
 * with query "ide.agent", the exact fallback `ide.openAgentSettings`
 * (ide-agent extension) already uses for `aiSettings.action.open`. The
 * fork has no dedicated "background-composer" / "plan-usage" pages, so
 * those sections land on the generic agent settings (documented in
 * deeplink.ts). Any non-command-not-found error propagates, like the
 * binary.
 */
async function openAiSettings(section?: string): Promise<void> {
  try {
    if (section === undefined) {
      await vscode.commands.executeCommand(AI_SETTINGS_OPEN_COMMAND);
    } else {
      await vscode.commands.executeCommand(AI_SETTINGS_OPEN_COMMAND, section);
    }
  } catch (err) {
    if (!isCommandNotFoundError(err, AI_SETTINGS_OPEN_COMMAND)) {
      throw err;
    }
    await vscode.commands.executeCommand("workbench.action.openSettings", "ide.agent");
  }
}

/** Per-tab customize commands (workbench-core → ide-agent customize editor). */
const CUSTOMIZE_TAB_COMMANDS: Readonly<Record<CustomizeDeeplinkTab, string>> = {
  plugins: "workbench.action.customize.openPlugins",
  mcps: "workbench.action.customize.openMCPs",
  rules: "workbench.action.customize.openRules",
  hooks: "workbench.action.customize.openHooks",
};

/**
 * Open the Customize editor for a deeplink `initialView` — the binary's
 * `As`/`Bs` handlers (see deeplink.ts for offsets):
 *   - detail/browse: execute Ns with `{initialView}` verbatim; on a
 *     command-not-found error (the binary's `Fs` test) fall back to
 *     `Rs("plugins")` = aiSettings "plugins" (→ openAiSettings above).
 *   - manage: the binary opens Ns with `{initialView:{kind:"manage",
 *     tab, scope:"user"}}`. DIVERGENCE: the fork's Ns handler takes no
 *     arguments and would land on the default Plugins tab regardless of
 *     `tab`, so this dispatches the fork's per-tab customize command
 *     instead — same editor, correct tab pre-selected. Its
 *     command-not-found fallback is the binary's `Rs(tab)`:
 *     aiSettings with "mcps" mapped back to "mcp".
 *   - undefined (plain `/customize` with no valid tab): Ns with NO
 *     argument, exactly like the binary; fallback aiSettings no-arg.
 */
async function openCustomizeDeeplink(initialView?: CustomizeInitialView): Promise<void> {
  if (initialView?.kind === "manage") {
    const tabCommand = CUSTOMIZE_TAB_COMMANDS[initialView.tab];
    try {
      await vscode.commands.executeCommand(tabCommand);
    } catch (err) {
      if (!isCommandNotFoundError(err, tabCommand)) {
        throw err;
      }
      await openAiSettings(initialView.tab === "mcps" ? "mcp" : initialView.tab);
    }
    return;
  }
  try {
    if (initialView === undefined) {
      await vscode.commands.executeCommand(OPEN_CUSTOMIZE_EDITOR_COMMAND);
    } else {
      await vscode.commands.executeCommand(OPEN_CUSTOMIZE_EDITOR_COMMAND, { initialView });
    }
  } catch (err) {
    if (!isCommandNotFoundError(err, OPEN_CUSTOMIZE_EDITOR_COMMAND)) {
      throw err;
    }
    await openAiSettings(initialView === undefined ? undefined : "plugins");
  }
}

/**
 * The current window's workspace name, exactly the binary's computation in
 * the `/prompt` route `Xs`: the `.code-workspace` file's basename without
 * the extension when a workspace file is open, else the first workspace
 * folder's basename, else undefined.
 */
function currentWorkspaceName(): string | undefined {
  if (vscode.workspace.workspaceFile) {
    return path.basename(vscode.workspace.workspaceFile.fsPath, ".code-workspace");
  }
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder ? path.basename(folder.uri.fsPath) : undefined;
}

/** Shared handler used by the registered URI handler and the debug command. */
async function handleDeeplinkUri(uri: vscode.Uri): Promise<void> {
  try {
    const route = routeDeeplink({
      scheme: uri.scheme,
      authority: uri.authority,
      path: uri.path,
      query: uri.query,
      // Binary: the glass handoff forwards `uri.toString(true)`.
      uriString: uri.toString(true),
    });
    if (route.kind === "invalid") {
      await vscode.window.showErrorMessage(route.error);
      return;
    }
    if (route.kind === "root") {
      // Binary: "/" and "" are recognized no-ops — no warning, no action.
      return;
    }
    if (route.kind === "settings-open") {
      // DEV-GAPS-110: `/settings`, `/settings/background-composer`,
      // `/settings/plan-usage`, `/settings/plugins` (+ any other
      // `/settings*`) — binary settings handler @435052: fires
      // `aiSettings.action.open(section?)`. See openAiSettings for the
      // fork fallback (no aiSettings command / no such pages here).
      await openAiSettings(route.section);
      return;
    }
    if (route.kind === "customize-open") {
      // DEV-GAPS-110: `/customize`, `/customize/marketplace`,
      // `/plugin/add`, and `/settings/plugins?pluginId=…` — the binary's
      // `Bs`/`As` customize handlers. See openCustomizeDeeplink.
      await openCustomizeDeeplink(route.initialView);
      return;
    }
    if (route.kind === "glass-open") {
      // DEV-GAPS-110: `/agent`, `/background-agent`, `/create-project`,
      // `/plugin/install-and-prompt`, `/glass` — binary fires
      // `cursor.openOrFocusGlassWindow` with this exact payload shape;
      // the fork analog is `ide.openOrFocusGlassWindow` (it currently
      // consumes only `agentsWindowOpenSource` — handoff fields are
      // forwarded verbatim, see the divergence note in deeplink.ts).
      const payload: {
        agentsWindowOpenSource: string;
        startupHandoff?: boolean;
        deeplinkUrl?: string;
      } = { agentsWindowOpenSource: route.agentsWindowOpenSource };
      if (route.startupHandoff !== undefined) {
        payload.startupHandoff = route.startupHandoff;
      }
      if (route.deeplinkUrl !== undefined) {
        payload.deeplinkUrl = route.deeplinkUrl;
      }
      await vscode.commands.executeCommand(OPEN_GLASS_WINDOW_COMMAND, payload);
      return;
    }
    if (route.kind === "unknown-path") {
      // Cursor parity: warn + nudge to update (binary: console.warn
      // "Unrecognized deeplink" + showWarningMessage("Unrecognized deep
      // link. Try updating Cursor")).
      console.warn("[ide-deeplink] Unrecognized deeplink", uri.toString());
      await vscode.window.showWarningMessage("Unrecognized deep link. Try updating IDE Code");
      return;
    }
    if (route.kind === "command-create") {
      // DEV-GAPS-64: `/command` — validated name + content → the workbench
      // `deeplink.command.create` command (Cursor parity: same verbatim id,
      // same single-arg `{name, content, correlationId}` payload; binary
      // `extensions/cursor-deeplink/dist/main.js`, route `zs` @ 427911).
      await vscode.commands.executeCommand("deeplink.command.create", {
        name: route.name,
        content: route.content,
        correlationId: randomUUID(),
      });
      return;
    }
    if (route.kind === "rule-create") {
      // `/rule` (matrix feature `deeplink-create-rule`) — validated name +
      // content → the workbench `deeplink.rule.create` command (Cursor parity:
      // same verbatim id, same single-arg `{name, content, correlationId}`
      // payload; binary `extensions/cursor-deeplink/dist/main.js` @ 430085).
      await vscode.commands.executeCommand("deeplink.rule.create", {
        name: route.name,
        content: route.content,
        correlationId: randomUUID(),
      });
      return;
    }
    if (route.kind === "prompt-prefill") {
      // `/prompt` (matrix features `deeplink-prompt-prefill` +
      // `deeplink-prompt-injection-guard`) — binary-verbatim route `Xs`
      // (extensions/cursor-deeplink/dist/main.js, 3.25.9): after the
      // text-validation above, the binary resolves the optional `workspace`
      // param — comparing it (case-insensitively) against this window's
      // workspace name (the `.code-workspace` file basename without the
      // extension, else the first workspace folder's basename) — and when
      // it names a DIFFERENT window it executes
      // `deeplink.routeToWorkspaceName(name, deeplinkUrl)` and returns
      // early if the command reports it routed. HONEST-DIVERGENCE: the fork
      // has no cross-window deeplink router, so a non-matching workspace
      // falls through with the binary's own fallback warning
      // ("...continuing in current window") instead of a silent drop.
      const workspaceParam = getDeeplinkQueryParam(uri.query, "workspace")?.trim();
      if (workspaceParam) {
        try {
          const currentName = currentWorkspaceName();
          const matches =
            currentName !== undefined &&
            (currentName === workspaceParam ||
              currentName.toLowerCase() === workspaceParam.toLowerCase());
          if (!matches) {
            let routed = false;
            try {
              routed = (await vscode.commands.executeCommand(
                "deeplink.routeToWorkspaceName",
                workspaceParam,
                uri.toString(),
              )) as boolean;
            } catch {
              // No such command registered yet in the fork — falls through
              // to the binary's own "continuing in current window" path.
            }
            if (routed) {
              return;
            }
            console.warn(
              `[ide-deeplink] No window found with workspace name "${workspaceParam}", continuing in current window`,
            );
          }
        } catch (err) {
          console.error(
            "[ide-deeplink] Error handling workspace parameter for prompt deeplink",
            err,
          );
        }
      }
      // Binary: `commands.executeCommand("deeplink.prompt.prefill",
      // { text, mode: Ws(query, "mode") ?? undefined })`.
      await vscode.commands.executeCommand("deeplink.prompt.prefill", {
        text: route.text,
        mode: route.mode,
      });
      return;
    }
    // mcp-install: validated name + config object → workbench install flow.
    await vscode.commands.executeCommand(
      "composer.mcp.deeplinkInstall",
      route.request.name,
      route.request.config,
    );
  } catch (err) {
    console.error("[ide-deeplink] Error handling deep link", err);
    await vscode.window.showErrorMessage(
      `Error handling deep link: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.window.registerUriHandler({ handleUri: handleDeeplinkUri }),
  );
  // Cursor parity: `cursor-deeplink.debug.triggerDeeplink` ("Debug: Trigger
  // Arbitrary Deeplink") — lets developers feed an arbitrary deeplink URL
  // through the same handler. DEV-GAPS-70/W70D-R3: the input box now uses
  // the binary-verbatim prompt/placeHolder and the binary's validateInput
  // (dist/main.js @ 437536: empty → "Please enter a deeplink URL",
  // unparseable → "Invalid URL format", wrong scheme/authority →
  // "URL must start with …/"), with only the product scheme/authority
  // substituted (the fork's deeplink convention).
  context.subscriptions.push(
    vscode.commands.registerCommand("ide-deeplink.debug.triggerDeeplink", async () => {
      const input = await vscode.window.showInputBox({
        prompt: DEBUG_TRIGGER_PROMPT,
        placeHolder: DEBUG_TRIGGER_PLACEHOLDER,
        validateInput: (value) =>
          validateDebugDeeplinkInput(value, (v) => {
            const u = vscode.Uri.parse(v);
            return { scheme: u.scheme, authority: u.authority };
          }),
      });
      if (!input) {
        return;
      }
      try {
        await handleDeeplinkUri(vscode.Uri.parse(input));
      } catch (err) {
        await vscode.window.showErrorMessage(
          `Error processing deeplink: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }),
  );
}

export function deactivate(): void {
  /* nothing to clean up */
}
