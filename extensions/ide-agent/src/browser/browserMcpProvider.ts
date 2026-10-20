/**
 * The built-in `cursor-ide-browser` MCP provider (DEV-GAPS-88).
 *
 * BINARY EVIDENCE (Cursor 3.25.9, self-extracted 2026-10-20 from
 * `resources/app/extensions/cursor-browser-automation/dist/extension.js`):
 * - Provider class (offset ~193898): `this.id = "cursor-ide-browser"`,
 *   `this.featureGateName = void 0`, `this.instructions = 'The
 *   cursor-ide-browser MCP server provides …'` (full text below, verbatim),
 *   `this.tools = [...]` — a STATIC catalog of exactly 16 tools in this
 *   order: browser_navigate, browser_snapshot, browser_click,
 *   browser_mouse_click_xy, browser_type, browser_fill,
 *   browser_select_option, browser_press_key, browser_scroll,
 *   browser_drag, browser_get_bounding_box, browser_highlight,
 *   browser_tabs, browser_cdp, browser_take_screenshot, browser_lock.
 * - `async initialize(globalStoragePath)` (offset 211425): log-only in
 *   Cursor ("initialized with direct execution"); the registering
 *   extension calls it itself BEFORE registering (offset 221465:
 *   `await e.initialize(t.globalStorageUri.fsPath)` →
 *   `o.cursor.registerMcpProvider($t)` → Disposable pushed into
 *   `context.subscriptions`).
 * - `async listOfferings()` (offset 211521):
 *   `{ tools: [...this.tools], prompts: [], resources: [] }`.
 * - `async callTool(name, args, context)` (offset 211597): the caller
 *   identity is `ownerAgentId = context?.composerId`.
 * - `async onTurnEnded(context)` (offset 213171): clears device emulation
 *   (via `cursor.browserView.clearAgentDeviceEmulation`) for viewIds that
 *   were tracked through `browser_cdp` calls during the turn.
 *
 * FORK WIRING (same contract, fork idiom — see providerRegistry.ts):
 * - The provider registers through the existing
 *   `McpService.registerMcpProvider()` (the fork's
 *   `cursor.registerMcpProvider()`), so its tools surface as
 *   `mcp__cursor-ide-browser__<tool>` through the standard MCP approval
 *   gate. Registration happens in extension.ts right after the
 *   BrowserTabManager exists, mirroring Cursor's activation order
 *   (initialize → register → subscriptions.push).
 * - Tool execution dispatches to the fork's existing 16 browser tools
 *   (`createBrowserMcpTools`, browser/mcp-tools.ts) bound to the SAME
 *   BrowserService the user-visible browser tab uses (lazily obtained —
 *   listing offerings must never launch a browser). The caller id is the
 *   call context's `composerId`, matching Cursor's `ownerAgentId`.
 * - `browser_cdp` is enabled for this provider: it is one of Cursor's 16
 *   registered tools, and `BrowserService.cdp()` enforces Cursor's CDP
 *   denylist unconditionally (service.ts `assertCdpMethodAllowed`).
 * - The fork's 3 extra tools (browser_screenshot alias,
 *   browser_pick_element, browser_close) are NOT offered here — Cursor
 *   registers exactly 16, and `browser_fill_form` / `browser_hover` stay
 *   unregistered (dead code in Cursor, per dig-continuous-mcp-deep §4.1).
 *
 * HONEST DIVERGENCES:
 * - `onTurnEnded` is NOT implemented: Cursor's version only clears CDP
 *   device emulation tracked during the turn; the fork's BrowserService
 *   has no such tracker (its `browser_cdp` path records no emulation
 *   state), so there is nothing to clear. The hook stays absent rather
 *   than faked.
 * - Tool descriptions/parameter schemas come from the fork's existing
 *   `createBrowserMcpTools` definitions (3.25.6-verified wave), not from
 *   re-extracting the 3.25.9 `this.tools` JSON — wording may differ in
 *   small details from 3.25.9 (e.g. browser_navigate's description).
 * - The catalog instance used for `listOfferings()` is bound to a
 *   BrowserService whose driver factory throws if ever invoked: listing
 *   is purely static (mirroring Cursor's `[...this.tools]`) and must not
 *   start Chromium / open a tab. Handlers from that instance are never
 *   called — `callTool` always builds tools on the real service.
 */
import { BrowserService, type DriverFactory } from "./service";
import { createBrowserMcpTools } from "./mcp-tools";
import type { McpToolDef } from "./types";
import type {
  McpProvider,
  McpProviderCallContext,
  McpProviderOfferings,
} from "../mcp/providerRegistry";

/** The provider id, verbatim from the Cursor 3.25.9 binary. */
export const CURSOR_IDE_BROWSER_PROVIDER_ID = "cursor-ide-browser";

/**
 * Server instructions, verbatim from the Cursor 3.25.9 binary
 * (`this.instructions`, extension.js offset ~193921; 5,263 chars,
 * extracted programmatically — do not hand-edit).
 */
export const CURSOR_IDE_BROWSER_INSTRUCTIONS: string = "The cursor-ide-browser MCP server provides a Cursor-owned browser tab plus a raw Chrome DevTools Protocol command tool.\n\nCORE WORKFLOW:\n1. Start by understanding the user's goal and what success looks like on the page.\n2. Use browser_tabs with action \"list\" to inspect open tabs and URLs before acting.\n3. Use browser_navigate to create or navigate the target tab. Omit the position parameter for background automation so focus is preserved.\n4. Use browser_lock before longer automation on an existing tab, then browser_lock with action \"unlock\" when finished.\n5. Use browser_snapshot for accessibility context and browser_take_screenshot for visual verification.\n6. Use browser_click, browser_type, browser_fill, browser_select_option, browser_press_key, browser_scroll, and browser_drag for page interactions.\n7. Use browser_highlight and browser_get_bounding_box for visual grounding and coordinate diagnostics.\n8. Use browser_cdp for page inspection, profiling, runtime evaluation, DOM/CSS queries, and performance data.\n\nAVOID RABBIT HOLES:\n1. Do not repeat the same failing action more than once without new evidence such as a fresh snapshot, a different ref, a changed page state, or a clear new hypothesis.\n2. IMPORTANT: If four attempts fail or progress stalls, stop acting and report what you observed, what blocked progress, and the most likely next step.\n3. Prefer gathering evidence over brute force. If the page is confusing, use browser_snapshot, browser_take_screenshot, or CDP inspection before trying more actions.\n4. If you encounter a blocker such as login, passkey/manual user interaction, permissions, captchas, destructive confirmations, missing data, or an unexpected state, stop and report it instead of improvising repeated actions.\n5. Do not get stuck in wait-action-wait loops. Every retry should be justified by something newly observed.\n\nCRITICAL - Lock/unlock workflow:\n1. browser_lock requires an existing browser tab - you CANNOT call browser_lock with action: \"lock\" before browser_navigate\n2. Correct order: browser_navigate -> browser_lock({ action: \"lock\" }) -> (interactions) -> browser_lock({ action: \"unlock\" })\n3. If a browser tab already exists (check with browser_tabs list), call browser_lock with action: \"lock\" FIRST before any interactions\n4. Only call browser_lock with action: \"unlock\" when completely done with ALL browser operations for this turn\n\nIMPORTANT - Waiting strategy:\nWhen waiting for page changes, prefer short CDP polling loops with Runtime.evaluate, DOM queries, Page lifecycle signals, or browser_snapshot checks rather than a single long wait.\n\nCDP USAGE:\n- Use browser_cdp with a DevTools Protocol method and params object, for example Runtime.evaluate, DOM.getDocument, CSS.getComputedStyleForNode, Profiler.start/stop, Performance.getMetrics, Log.enable, and Network.enable.\n- Do not use browser_cdp with CDP Input.* methods. They are denied because they are focus-sensitive in Electron webviews and can route input to Cursor UI instead of the browser page.\n- Use browser_click, browser_type, browser_fill, browser_select_option, browser_press_key, browser_scroll, and browser_drag for clicks, typing, filling inputs, selecting options, keyboard actions, scrolling, and drag-and-drop.\n- Use Runtime.evaluate for advanced DOM-scoped interactions that the dedicated browser tools do not cover.\n- For profiling, call Profiler.enable, Profiler.start, reproduce the behavior, then Profiler.stop. The profile is saved to a file and returned as a log_file; read that file only when you need to inspect details.\n- For JavaScript evaluation, prefer Runtime.evaluate with returnByValue when possible.\n- Device emulation you set with Emulation.setDeviceMetricsOverride, Emulation.setTouchEmulationEnabled, or Emulation.setUserAgentOverride (for example for a phone-sized screenshot) lasts only for the current turn: it is cleared when your turn ends, and the user can reset it from the browser tab at any time. Send Emulation.clearDeviceMetricsOverride yourself once you are done with it within a turn.\n- Some browser-wide or sensitive CDP methods are denied, especially cookie, storage, permission, download, target-management, filesystem-backed file-input commands, system-level commands, and CDP navigation/history navigation commands.\n- Large CDP responses are saved to files instead of being inlined. Prefer using the returned file path over immediately stuffing large payloads into context; read focused sections only when needed.\n\nVISION:\n- browser_take_screenshot attaches an image result that the model can inspect. CDP Page.captureScreenshot returns data inside JSON and should not replace browser_take_screenshot when visual verification is needed.\n\nNOTES:\n- browser_snapshot returns snapshot YAML and is the main source of truth for page structure.\n- Refs are opaque handles tied to the latest browser_snapshot for that tab.\n- Iframe content is not accessible - only elements outside iframes can be interacted with.\n- When you stop to report a blocker, include the current page, the target you were trying to reach, the blocker you observed, and the best next action. If the blocker requires manual user interaction, ask the user to take over at that point rather than assuming it in advance.\n";

/**
 * The 16 registered browser tools, in the binary's `this.tools` order
 * (extension.js offset ~199251). Offerings are emitted in exactly this
 * order; any fork tool not listed here is not offered by this provider.
 */
export const CURSOR_IDE_BROWSER_TOOL_NAMES: readonly string[] = [
  "browser_navigate",
  "browser_snapshot",
  "browser_click",
  "browser_mouse_click_xy",
  "browser_type",
  "browser_fill",
  "browser_select_option",
  "browser_press_key",
  "browser_scroll",
  "browser_drag",
  "browser_get_bounding_box",
  "browser_highlight",
  "browser_tabs",
  "browser_cdp",
  "browser_take_screenshot",
  "browser_lock",
];

/** Dependencies for the provider (injected so tests can fake the service). */
export interface CursorIdeBrowserProviderDeps {
  /**
   * Lazily resolve the real BrowserService (the one the user-visible
   * browser tab drives). Called only from `callTool` — never from
   * `listOfferings()` — so registering the provider starts no browser.
   */
  getBrowserService(): Promise<BrowserService>;
  /** Caller id when a call context carries no composerId. */
  defaultCallerId?: string;
}

/** Driver factory for the static catalog instance: must never be invoked. */
const catalogOnlyDriverFactory: DriverFactory = async () => {
  throw new Error(
    "cursor-ide-browser: the offerings catalog is static — a browser session must go through callTool's real BrowserService",
  );
};

/**
 * Build the `cursor-ide-browser` provider for
 * `cursor.registerMcpProvider()` (fork: `McpService.registerMcpProvider`).
 */
export function createCursorIdeBrowserProvider(
  deps: CursorIdeBrowserProviderDeps,
): McpProvider {
  const defaultCallerId = deps.defaultCallerId ?? "default-agent";

  // Static catalog (Cursor: `this.tools`). Built once from the fork's tool
  // definitions on a never-started BrowserService — descriptors are static
  // literals in createBrowserMcpTools, and its handlers are never invoked
  // on this instance (see header note).
  let catalog: McpToolDef[] | undefined;
  const getCatalog = (): McpToolDef[] => {
    if (!catalog) {
      const byName = new Map(
        createBrowserMcpTools(new BrowserService(catalogOnlyDriverFactory), defaultCallerId, {
          enableCdpTool: true,
        }).map((t) => [t.name, t] as const),
      );
      catalog = CURSOR_IDE_BROWSER_TOOL_NAMES.map((name) => {
        const tool = byName.get(name);
        if (!tool) {
          throw new Error(`cursor-ide-browser: browser tool "${name}" is missing from the fork catalog`);
        }
        return tool;
      });
    }
    return catalog;
  };

  return {
    id: CURSOR_IDE_BROWSER_PROVIDER_ID,
    // Cursor's provider sets no `name` and `featureGateName = void 0`.
    featureGateName: undefined,
    instructions: CURSOR_IDE_BROWSER_INSTRUCTIONS,

    /**
     * Cursor calls this itself (with its global-storage path) before
     * registering; in Cursor it only logs. No state is needed here — the
     * parameter is accepted to keep the contract shape identical.
     */
    initialize(_globalStoragePath: string): void {
      /* log-only in Cursor 3.25.9 (offset 211425) — nothing to set up. */
    },

    listOfferings(): McpProviderOfferings {
      return {
        tools: getCatalog().map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        })),
        prompts: [],
        resources: [],
      };
    },

    async callTool(
      name: string,
      args: Record<string, unknown>,
      context: McpProviderCallContext,
    ): Promise<unknown> {
      if (!CURSOR_IDE_BROWSER_TOOL_NAMES.includes(name)) {
        // Same wording as the binary's dispatch default (offset ~213171:
        // `Unknown tool: ${t}`).
        throw new Error(`Unknown tool: ${name}`);
      }
      const service = await deps.getBrowserService();
      // Cursor: ownerAgentId = context?.composerId (offset 211597).
      const callerId = context?.composerId ?? defaultCallerId;
      const tool = createBrowserMcpTools(service, callerId, { enableCdpTool: true }).find(
        (t) => t.name === name,
      );
      if (!tool) {
        throw new Error(`Unknown tool: ${name}`);
      }
      return tool.handler(args ?? {});
    },
  };
}
