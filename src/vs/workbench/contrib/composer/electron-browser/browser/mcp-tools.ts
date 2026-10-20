// IDE-CODE: Migrated from extensions/ide-agent/src/browser/mcp-tools.ts (CAT-A, pure logic).
/**
 * MCP tool surface for the browser-for-agent layer.
 *
 * Implements 16 of Cursor's 16 registered browser tools (verified against
 * Cursor 3.25.6's cursor-browser-automation extension.js), with Cursor's
 * exact tool names and semantics. Handlers call BrowserService; results carry
 * MCP image blocks the agent literally sees.
 *
 * Tool inventory:
 *  Cursor's 16: navigate, take_screenshot, snapshot, click, mouse_click_xy,
 *    type, fill, select_option, press_key, scroll, drag, highlight,
 *    get_bounding_box, tabs, cdp, lock — all 16 implemented as MCP tools.
 *  Ours (extras): browser_screenshot (back-compat alias of take_screenshot),
 *    browser_pick_element (xpath-payload design-mode grounding),
 *    browser_close (session hygiene — Cursor has no close tool).
 *  browser_fill_form and browser_hover are dead code in Cursor 3.25.6
 *  (handler strings exist but are NOT registered) — NOT implemented.
 *
 * Identity model: browser_snapshot stamps stable `data-ide-ref="e<N>"` refs;
 * browser_click / browser_type / browser_fill / browser_select_option /
 * browser_scroll / browser_drag / browser_get_bounding_box take those refs and
 * validate them (staleness / visibility / description match) before acting.
 */
import { BrowserService } from "./service.js";
import { isValidRef } from "./snapshot.js";
import { McpToolDef } from "./types.js";

/**
 * P0 security fix (QA-03): agentId is NEVER taken from model-supplied tool args.
 * The caller's identity is resolved server-side by the code that creates the
 * tools (the MCP server / extension host), never from the inputSchema.
 * Until a real MCP server passes the invoking session, all tools share the
 * single caller identity provided here.
 */
export interface BrowserToolOptions {
  /**
   * Enable the browser_cdp tool. Default false.
   *
   * RISK: raw CDP access can escape the browser sandbox in ways the dedicated
   * tools prevent (the denylist still blocks Input.*, Browser.*, Target.*,
   * Storage.*, SystemInfo.*, Tethering.* and sensitive exact methods, but
   * CDP is a large surface). Only enable when the host operator explicitly
   * opts in.
   */
  enableCdpTool?: boolean;
}

export function createBrowserMcpTools(
  service: BrowserService,
  callerId = "default-agent",
  opts: BrowserToolOptions = {},
): McpToolDef[] {
  const callerAgentId: string = callerId;
  const cdpEnabled = opts.enableCdpTool === true;

  /** Attach a screenshot to a tool result when take_screenshot_afterwards is set. */
  async function maybeScreenshot(
    args: Record<string, unknown>,
    result: Record<string, unknown>,
  ): Promise<void> {
    if (args.take_screenshot_afterwards === true) {
      const shot = await service.screenshot(sessionForViewId(args), callerAgentId, {
        format: "png",
        type: "viewport",
      });
      result.screenshot = shot.content;
    }
  }

  /** Resolve the session for an optional viewId (Cursor's param; ours = sessionId). */
  function sessionForViewId(args: Record<string, unknown>): string | undefined {
    return typeof args.viewId === "string" && args.viewId ? args.viewId : undefined;
  }

  const browser_navigate: McpToolDef = {
    name: "browser_navigate",
    description:
      "Navigate to a URL. By default reuses the agent's existing tab; set newTab:true to open in a new tab.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to navigate to (http/https)" },
        newTab: { type: "boolean", description: "Open in a new tab instead of reusing the current one" },
        take_screenshot_afterwards: {
          type: "boolean",
          description: "Attach a screenshot to the result",
        },
        viewId: { type: "string", description: "Target an explicit tab (default: last interacted)" },
      },
      required: ["url"],
    },
    handler: async (args) => {
      const url = args.url;
      if (typeof url !== "string" || !url) throw new Error("browser_navigate: url is required");
      const agentId = callerAgentId;
      let sessionId = sessionForViewId(args);
      if (args.newTab === true) {
        const s = await service.createSession({ agentId });
        sessionId = s.sessionId;
      } else if (!sessionId) {
        const existing = service.listSessions(agentId);
        if (existing.length === 0) {
          const s = await service.createSession({ agentId });
          sessionId = s.sessionId;
        }
      }
      const nav = await service.navigate(sessionId, agentId, url);
      const result: Record<string, unknown> = {
        ok: true,
        url: nav.url,
        title: nav.title,
      };
      await maybeScreenshot(args, result);
      return result;
    },
  };

  const browser_take_screenshot: McpToolDef = {
    name: "browser_take_screenshot",
    description:
      "Take a screenshot of the current page. You can't perform actions based on the screenshot, " +
      "use browser_snapshot for actions — it returns element refs you can act on.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["png", "jpeg"], description: "Image format (default png)" },
        filename: { type: "string", description: "Optional filename label for the capture" },
        element: { type: "string", description: "CSS selector — screenshot that element's bounding box" },
        ref: { type: "string", description: "Snapshot ref (e.g. e12) — screenshot that element's bounding box" },
        fullPage: { type: "boolean", description: "Capture the full scrollable page" },
        viewId: { type: "string", description: "Target an explicit tab (default: last interacted)" },
      },
    },
    handler: async (args) => {
      const agentId = callerAgentId;
      const format = args.type === "jpeg" ? "jpeg" : "png";
      let element = typeof args.element === "string" ? args.element : undefined;
      if (typeof args.ref === "string" && args.ref) {
        if (!isValidRef(args.ref)) throw new Error(`browser_take_screenshot: invalid ref "${args.ref}"`);
        // Resolve the ref to its stamped selector for element capture.
        element = `[data-ide-ref="${args.ref}"]`;
      }
      const shot = await service.screenshot(sessionForViewId(args), agentId, {
        format,
        type: args.fullPage === true ? "fullPage" : element ? "element" : "viewport",
        element,
        fullPage: args.fullPage === true,
        filename: typeof args.filename === "string" ? args.filename : undefined,
      });
      return { content: shot.content, meta: shot.meta };
    },
  };

  // Back-compat alias: our original name for browser_take_screenshot.
  const browser_screenshot_alias: McpToolDef = {
    ...browser_take_screenshot,
    name: "browser_screenshot",
    description: browser_take_screenshot.description + " (Alias of browser_take_screenshot.)",
  };

  const browser_pick_element: McpToolDef = {
    name: "browser_pick_element",
    description:
      "Pick the UI element at viewport coordinates and return its payload " +
      "(tag, id, classes, text, DOM path, xpath, rect, computed styles, framework " +
      "component) plus a frozen-frame screenshot. The selection lands in the " +
      "agent context as uiElementSelections keyed by xpath.",
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "number", description: "Viewport x in CSS pixels" },
        y: { type: "number", description: "Viewport y in CSS pixels" },
        selector: {
          type: "string",
          description: "Alternative to x/y: CSS selector of the element to pick",
        },
        viewId: { type: "string", description: "Target an explicit tab (default: last interacted)" },
      },
    },
    handler: async (args) => {
      const agentId = callerAgentId;
      const viewId = sessionForViewId(args);
      if (typeof args.selector === "string" && args.selector) {
        const picker = service.pickerFor(viewId, agentId);
        const payload = await picker.payloadForSelector(args.selector);
        if (!payload) throw new Error(`browser_pick_element: selector "${args.selector}" matched nothing`);
        const shot = await service.screenshot(viewId, agentId, { format: "png", type: "viewport" });
        const imageBlock = shot.content.find((c) => c.type === "image");
        const frozenFrameDataUrl =
          imageBlock && imageBlock.type === "image"
            ? `data:${imageBlock.mimeType};base64,${imageBlock.base64Data}`
            : "";
        const selections = [{ xpath: payload.xpath, payload }];
        return {
          selections,
          frozenFrameDataUrl,
          context: { uiElementSelections: selections },
          screenshot: shot.content,
        };
      }
      if (typeof args.x !== "number" || typeof args.y !== "number") {
        throw new Error("browser_pick_element: provide x/y coordinates or a selector");
      }
      const picked = await service.pickAt(viewId, agentId, args.x, args.y);
      const shot = await service.screenshot(viewId, agentId, { format: "png", type: "viewport" });
      return {
        selections: picked.selections,
        frozenFrameDataUrl: picked.frozenFrameDataUrl,
        context: picked.context,
        screenshot: shot.content,
      };
    },
  };

  const browser_click: McpToolDef = {
    name: "browser_click",
    description:
      "Click an element by its snapshot ref (from browser_snapshot, preferred) or CSS selector. " +
      "The element is scrolled into view first. Use this instead of CDP Input.* methods.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Snapshot ref, e.g. e12 (preferred)" },
        selector: { type: "string", description: "CSS selector fallback" },
        element: { type: "string", description: "CSS selector (alias of selector)" },
        doubleClick: { type: "boolean", description: "Dispatch a real double-click sequence" },
        button: {
          type: "string",
          enum: ["left", "right", "middle"],
          description: "Mouse button (right dispatches contextmenu)",
        },
        modifiers: {
          type: "array",
          items: { type: "string" },
          description: 'Modifier keys held during the click: "Alt", "Control", "Meta", "Shift"',
        },
        viewId: { type: "string", description: "Target an explicit tab (default: last interacted)" },
        take_screenshot_afterwards: { type: "boolean", description: "Attach a screenshot to the result" },
      },
    },
    handler: async (args) => {
      const target =
        typeof args.ref === "string" && args.ref
          ? { ref: args.ref }
          : typeof args.selector === "string" && args.selector
            ? { selector: args.selector }
            : typeof args.element === "string" && args.element
              ? { selector: args.element }
              : null;
      if (!target) throw new Error("browser_click: ref, selector, or element is required");
      const btn = args.button;
      if (btn !== undefined && btn !== "left" && btn !== "right" && btn !== "middle") {
        throw new Error('browser_click: button must be "left"|"right"|"middle"');
      }
      const modifiers = Array.isArray(args.modifiers)
        ? args.modifiers.filter((m): m is string => typeof m === "string")
        : [];
      const result: Record<string, unknown> = await service.click(
        sessionForViewId(args),
        callerAgentId,
        target,
        {
          doubleClick: args.doubleClick === true,
          button: btn === "right" || btn === "middle" ? btn : undefined,
          modifiers,
        },
      );
      await maybeScreenshot(args, result);
      return result;
    },
  };

  const browser_type: McpToolDef = {
    name: "browser_type",
    description:
      "Type text into an input, textarea, or contenteditable element by snapshot ref (preferred) " +
      "or CSS selector.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Snapshot ref, e.g. e12 (preferred)" },
        selector: { type: "string", description: "CSS selector fallback" },
        element: { type: "string", description: "CSS selector (alias of selector)" },
        text: { type: "string", description: "Text to type" },
        clear: { type: "boolean", description: "Clear the field first" },
        submit: { type: "boolean", description: "Submit the enclosing form / press Enter afterwards" },
        slowly: { type: "boolean", description: "Type slowly (human-like pacing)" },
        viewId: { type: "string", description: "Target an explicit tab (default: last interacted)" },
        take_screenshot_afterwards: { type: "boolean", description: "Attach a screenshot to the result" },
      },
      required: ["text"],
    },
    handler: async (args) => {
      const target =
        typeof args.ref === "string" && args.ref
          ? { ref: args.ref }
          : typeof args.selector === "string" && args.selector
            ? { selector: args.selector }
            : typeof args.element === "string" && args.element
              ? { selector: args.element }
              : null;
      if (!target) throw new Error("browser_type: ref, selector, or element is required");
      if (typeof args.text !== "string") throw new Error("browser_type: text is required");
      const result: Record<string, unknown> = await service.type(
        sessionForViewId(args),
        callerAgentId,
        target,
        args.text,
        {
          clear: args.clear === true,
          submit: args.submit === true,
          slowly: args.slowly === true,
        },
      );
      await maybeScreenshot(args, result);
      return result;
    },
  };

  const browser_snapshot: McpToolDef = {
    name: "browser_snapshot",
    description:
      "Capture an accessibility snapshot of the page with stable element refs (e.g. e12). " +
      "This is better than a screenshot for acting on the page — pass the refs to browser_click, " +
      "browser_type, browser_fill, and the other action tools.",
    inputSchema: {
      type: "object",
      properties: {
        maxDepth: { type: "number", description: "Max snapshot tree depth (default 20)" },
        compact: { type: "boolean", description: "Compact text rendering" },
        selector: { type: "string", description: "Scope the snapshot to a CSS selector subtree" },
        interactive: { type: "boolean", description: "Only interactive elements (default true)" },
        viewId: { type: "string", description: "Target an explicit tab (default: last interacted)" },
        take_screenshot_afterwards: { type: "boolean", description: "Attach a screenshot to the result" },
      },
    },
    handler: async (args) => {
      const snap = await service.snapshot(sessionForViewId(args), callerAgentId, {
        maxDepth: typeof args.maxDepth === "number" ? args.maxDepth : undefined,
        compact: args.compact === true,
        selector: typeof args.selector === "string" ? args.selector : undefined,
        interactive: args.interactive === false ? false : undefined,
      });
      const result: Record<string, unknown> = {
        snapshot: snap.text,
        refCount: snap.refCount,
      };
      await maybeScreenshot(args, result);
      return result;
    },
  };

  const browser_tabs: McpToolDef = {
    name: "browser_tabs",
    description: "List, create, close, or select browser tabs.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "new", "close", "select"], description: "Tab action" },
        index: { type: "number", description: "Tab index for close/select" },
        url: { type: "string", description: "URL for action=new" },
        position: { type: "string", enum: ["active", "side"], description: "Where to open the tab" },
      },
      required: ["action"],
    },
    handler: async (args) => {
      const action = args.action;
      if (action !== "list" && action !== "new" && action !== "close" && action !== "select") {
        throw new Error('browser_tabs: action must be one of "list"|"new"|"close"|"select"');
      }
      return service.tabs(callerAgentId, action, {
        index: typeof args.index === "number" ? args.index : undefined,
        url: typeof args.url === "string" ? args.url : undefined,
      });
    },
  };

  const browser_fill: McpToolDef = {
    name: "browser_fill",
    description: "Fill an input, textarea, or contenteditable element by its snapshot ref.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Snapshot ref, e.g. e12" },
        value: { type: "string", description: "Value to set" },
        viewId: { type: "string", description: "Target an explicit tab (default: last interacted)" },
        take_screenshot_afterwards: { type: "boolean", description: "Attach a screenshot to the result" },
      },
      required: ["ref", "value"],
    },
    handler: async (args) => {
      if (typeof args.ref !== "string" || !args.ref) throw new Error("browser_fill: ref is required");
      if (typeof args.value !== "string") throw new Error("browser_fill: value is required");
      const result: Record<string, unknown> = await service.fill(
        sessionForViewId(args),
        callerAgentId,
        args.ref,
        args.value,
      );
      await maybeScreenshot(args, result);
      return result;
    },
  };

  const browser_select_option: McpToolDef = {
    name: "browser_select_option",
    description: "Select one or more options in a <select> element by its snapshot ref.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Snapshot ref, e.g. e12" },
        values: {
          type: "array",
          items: { type: "string" },
          description: "Option values (or visible texts) to select",
        },
        viewId: { type: "string", description: "Target an explicit tab (default: last interacted)" },
        take_screenshot_afterwards: { type: "boolean", description: "Attach a screenshot to the result" },
      },
      required: ["ref", "values"],
    },
    handler: async (args) => {
      if (typeof args.ref !== "string" || !args.ref)
        throw new Error("browser_select_option: ref is required");
      if (!Array.isArray(args.values) || args.values.some((v) => typeof v !== "string"))
        throw new Error("browser_select_option: values must be an array of strings");
      const result: Record<string, unknown> = await service.selectOption(
        sessionForViewId(args),
        callerAgentId,
        args.ref,
        args.values as string[],
      );
      await maybeScreenshot(args, result);
      return result;
    },
  };

  const browser_press_key: McpToolDef = {
    name: "browser_press_key",
    description:
      'Press a keyboard key ("Enter", "Escape", "Tab", "ArrowDown", or a single character). ' +
      "Dispatched as DOM keyboard events.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Key to press" },
        viewId: { type: "string", description: "Target an explicit tab (default: last interacted)" },
        take_screenshot_afterwards: { type: "boolean", description: "Attach a screenshot to the result" },
      },
      required: ["key"],
    },
    handler: async (args) => {
      if (typeof args.key !== "string" || !args.key) throw new Error("browser_press_key: key is required");
      const result: Record<string, unknown> = await service.pressKey(
        sessionForViewId(args),
        callerAgentId,
        args.key,
      );
      await maybeScreenshot(args, result);
      return result;
    },
  };

  const browser_scroll: McpToolDef = {
    name: "browser_scroll",
    description:
      "Scroll the page, a scrollable container, or an element into view. " +
      "Use this instead of CDP Input.* wheel events.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Snapshot ref of the element/container to scroll" },
        direction: { type: "string", enum: ["up", "down", "left", "right"] },
        amount: { type: "number", description: "Pixels for direction scrolls (default 500)" },
        deltaX: { type: "number" },
        deltaY: { type: "number" },
        scrollIntoView: { type: "boolean", description: "Scroll the ref element into view" },
        viewId: { type: "string", description: "Target an explicit tab (default: last interacted)" },
        take_screenshot_afterwards: { type: "boolean", description: "Attach a screenshot to the result" },
      },
    },
    handler: async (args) => {
      const dir = args.direction;
      if (dir !== undefined && dir !== "up" && dir !== "down" && dir !== "left" && dir !== "right") {
        throw new Error('browser_scroll: direction must be one of "up"|"down"|"left"|"right"');
      }
      const result: Record<string, unknown> = await service.scroll(sessionForViewId(args), callerAgentId, {
        ref: typeof args.ref === "string" ? args.ref : undefined,
        direction: dir as "up" | "down" | "left" | "right" | undefined,
        amount: typeof args.amount === "number" ? args.amount : undefined,
        deltaX: typeof args.deltaX === "number" ? args.deltaX : undefined,
        deltaY: typeof args.deltaY === "number" ? args.deltaY : undefined,
        scrollIntoView: args.scrollIntoView === true,
      });
      await maybeScreenshot(args, result);
      return result;
    },
  };

  const browser_drag: McpToolDef = {
    name: "browser_drag",
    description: "Drag from a source element to a target element or viewport coordinates.",
    inputSchema: {
      type: "object",
      properties: {
        sourceRef: { type: "string", description: "Snapshot ref of the drag source" },
        targetRef: { type: "string", description: "Snapshot ref of the drop target" },
        targetX: { type: "number", description: "Viewport x of the drop point" },
        targetY: { type: "number", description: "Viewport y of the drop point" },
        viewId: { type: "string", description: "Target an explicit tab (default: last interacted)" },
        take_screenshot_afterwards: { type: "boolean", description: "Attach a screenshot to the result" },
      },
      required: ["sourceRef"],
    },
    handler: async (args) => {
      if (typeof args.sourceRef !== "string" || !args.sourceRef)
        throw new Error("browser_drag: sourceRef is required");
      const result: Record<string, unknown> = await service.drag(sessionForViewId(args), callerAgentId, args.sourceRef, {
        targetRef: typeof args.targetRef === "string" ? args.targetRef : undefined,
        targetX: typeof args.targetX === "number" ? args.targetX : undefined,
        targetY: typeof args.targetY === "number" ? args.targetY : undefined,
      });
      await maybeScreenshot(args, result);
      return result;
    },
  };

  const browser_get_bounding_box: McpToolDef = {
    name: "browser_get_bounding_box",
    description: "Get the viewport bounding box of an element by its snapshot ref (for coordinate diagnostics).",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Snapshot ref, e.g. e12" },
        viewId: { type: "string", description: "Target an explicit tab (default: last interacted)" },
      },
      required: ["ref"],
    },
    handler: async (args) => {
      if (typeof args.ref !== "string" || !args.ref)
        throw new Error("browser_get_bounding_box: ref is required");
      const rect = await service.getBoundingBox(sessionForViewId(args), callerAgentId, args.ref);
      return { ref: args.ref, ...rect };
    },
  };

  const browser_highlight: McpToolDef = {
    name: "browser_highlight",
    description:
      "Visually highlight an element by its snapshot ref with Cursor's orange outline (#ff6a00) — " +
      "for visual grounding, e.g. pointing the user at an element. The outline is removed after durationMs.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Snapshot ref, e.g. e12" },
        durationMs: {
          type: "number",
          description: "How long to show the highlight in ms (default 2000, max 30000)",
        },
        viewId: { type: "string", description: "Target an explicit tab (default: last interacted)" },
      },
      required: ["ref"],
    },
    handler: async (args) => {
      if (typeof args.ref !== "string" || !args.ref)
        throw new Error("browser_highlight: ref is required");
      return service.highlight(
        sessionForViewId(args),
        callerAgentId,
        args.ref,
        typeof args.durationMs === "number" ? args.durationMs : undefined,
      );
    },
  };

  const browser_lock: McpToolDef = {
    name: "browser_lock",
    description:
      "Lock or unlock a browser tab for a longer automation. A locked tab rejects other " +
      "sessions' mutating actions with TAB_LOCKED until it is unlocked.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["lock", "unlock"], description: '"lock"|"unlock"' },
        viewId: { type: "string", description: "Target an explicit tab (default: last interacted)" },
      },
      required: ["action"],
    },
    handler: async (args) => {
      const action = args.action;
      if (action !== "lock" && action !== "unlock") {
        throw new Error('browser_lock: action must be "lock"|"unlock"');
      }
      const sessionId = sessionForViewId(args);
      if (action === "lock") {
        await service.lock(sessionId, callerAgentId);
      } else {
        await service.unlock(sessionId, callerAgentId);
      }
      return { ok: true, action };
    },
  };

  const browser_cdp: McpToolDef = {
    name: "browser_cdp",
    description:
      "Send a raw CDP command. RESTRICTED: disabled unless the host explicitly enables it; " +
      "Input.* and sensitive domains/methods are denied even then. Prefer the dedicated browser tools.",
    inputSchema: {
      type: "object",
      properties: {
        method: { type: "string", description: "CDP method, e.g. Runtime.evaluate" },
        params: { type: "object", description: "CDP params" },
      },
      required: ["method"],
    },
    handler: async (args) => {
      if (!cdpEnabled) {
        throw new Error(
          "browser_cdp is disabled. Raw CDP access can escape the browser sandbox " +
            "(read cookies, navigate, attach to targets). The host must explicitly opt in " +
            "with { enableCdpTool: true } after reviewing the denylist in service.ts.",
        );
      }
      if (typeof args.method !== "string" || !args.method)
        throw new Error("browser_cdp: method is required");
      const params =
        args.params && typeof args.params === "object"
          ? (args.params as Record<string, unknown>)
          : {};
      const out = await service.cdp(undefined, callerAgentId, args.method, params);
      return { ok: true, result: out };
    },
  };

  const browser_mouse_click_xy: McpToolDef = {
    name: "browser_mouse_click_xy",
    description: "Click at viewport coordinates. Prefer browser_click with snapshot refs when possible.",
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "number", description: "Viewport x in CSS pixels" },
        y: { type: "number", description: "Viewport y in CSS pixels" },
        button: { type: "string", enum: ["left", "right", "middle"], description: "Mouse button" },
        viewId: { type: "string", description: "Target an explicit tab (default: last interacted)" },
        take_screenshot_afterwards: { type: "boolean", description: "Attach a screenshot to the result" },
      },
      required: ["x", "y"],
    },
    handler: async (args) => {
      if (typeof args.x !== "number" || typeof args.y !== "number")
        throw new Error("browser_mouse_click_xy: x and y are required");
      const btn = args.button;
      const result: Record<string, unknown> = await service.mouseClickXy(
        sessionForViewId(args),
        callerAgentId,
        args.x,
        args.y,
        {
          button: btn === "right" || btn === "middle" ? btn : undefined,
        },
      );
      await maybeScreenshot(args, result);
      return result;
    },
  };

  const browser_close: McpToolDef = {
    name: "browser_close",
    description: "Close the current browser tab/session, freeing its resources.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    handler: async () => {
      await service.closeSession(undefined, callerAgentId);
      return { ok: true };
    },
  };

  return [
    browser_navigate,
    browser_take_screenshot,
    browser_screenshot_alias,
    browser_snapshot,
    browser_pick_element,
    browser_click,
    browser_mouse_click_xy,
    browser_type,
    browser_fill,
    browser_select_option,
    browser_press_key,
    browser_scroll,
    browser_drag,
    browser_highlight,
    browser_get_bounding_box,
    browser_tabs,
    browser_cdp,
    browser_lock,
    browser_close,
  ];
}

/**
 * Names of all 16 Cursor browser tools (all implemented as MCP tools here)
 * plus our extras. browser_fill_form and browser_hover are dead in
 * Cursor 3.25.6 (handler strings exist but are NOT registered) — excluded.
 */
export const ALL_CURSOR_BROWSER_TOOLS = [
  "browser_navigate",
  "browser_take_screenshot",
  "browser_screenshot", // our back-compat alias
  "browser_pick_element", // our xpath-payload counterpart of snapshot+highlight grounding
  "browser_click",
  "browser_mouse_click_xy",
  "browser_type",
  "browser_snapshot",
  "browser_fill",
  // "browser_fill_form" — dead in Cursor 3.25.6 (handler exists but is NOT registered)
  "browser_select_option",
  "browser_press_key",
  "browser_scroll",
  "browser_drag",
  // "browser_hover" — dead in Cursor 3.25.6 (handler exists but is NOT registered)
  "browser_highlight",
  "browser_get_bounding_box",
  "browser_tabs",
  "browser_cdp",
  "browser_lock",
  "browser_close", // ours, not Cursor's — session hygiene
] as const;
