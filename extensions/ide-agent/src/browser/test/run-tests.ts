/**
 * Browser-layer tests (node:test, zero extra deps).
 *
 * Unit: PNG encoder, screenshot pipeline, session mutex.
 * Integration (needs IDE_BROWSER_CHROME=path to chrome-headless-shell):
 *   navigate fixture → real PNG bytes → picker pickAt → payload assertions
 *   → MCP tool handlers end-to-end.
 *
 * Run after `tsc`:  node out/browser/test/run-tests.mjs
 */
import { describe, it, before, after } from "node:test";
import * as assert from "node:assert";
import * as path from "node:path";
import { encodePngRgba, isPng, solidRgba } from "../png";
import { captureForAgent, toImageBlock } from "../screenshot";
import { BrowserService, ServiceDriver, assertCdpMethodAllowed } from "../service";
import { createBrowserMcpTools } from "../mcp-tools";
import { isValidRef, selectorForRef, renderSnapshotText, countSnapshotNodes } from "../snapshot";
import { launchHeadlessChromium, CdpPageDriver } from "../driver";
import { CaptureOptions, ScreenshotResult, BrowserError } from "../types";

/* ---------- unit: PNG encoder produces real PNG bytes ---------- */
describe("png encoder", () => {
  it("emits valid PNG magic + decodable header", () => {
    const buf = encodePngRgba(4, 3, solidRgba(4, 3, 255, 106, 0));
    assert.ok(isPng(buf), "must start with PNG magic");
    // IHDR width/height at fixed offsets
    assert.strictEqual(buf.readUInt32BE(16), 4);
    assert.strictEqual(buf.readUInt32BE(20), 3);
    assert.ok(buf.length > 50, "must contain IDAT payload");
  });

  it("rejects bad dimensions", () => {
    assert.throws(() => encodePngRgba(0, 4, Buffer.alloc(0)));
    assert.throws(() => encodePngRgba(2, 2, Buffer.alloc(10)));
  });
});

/* ---------- unit: screenshot pipeline ---------- */
describe("screenshot pipeline", () => {
  it("builds an MCP image block with base64 round-trip", async () => {
    const pngBytes = encodePngRgba(8, 8, solidRgba(8, 8, 20, 20, 20));
    const fakeDriver = {
      captureScreenshot: async (_o: CaptureOptions): Promise<ScreenshotResult> => ({
        data: pngBytes,
        mimeType: "image/png",
        viewportWidth: 8,
        viewportHeight: 8,
        devicePixelRatio: 1,
      }),
    };
    const out = await captureForAgent(fakeDriver as never);
    assert.strictEqual(out.content.length, 2);
    assert.strictEqual(out.content[0].type, "text");
    const img = out.content[1];
    assert.strictEqual(img.type, "image");
    if (img.type === "image") {
      assert.strictEqual(img.mimeType, "image/png");
      const roundTrip = Buffer.from(img.base64Data, "base64");
      assert.ok(isPng(roundTrip), "base64 must decode to real PNG bytes");
      assert.ok(roundTrip.equals(pngBytes));
    }
    // toImageBlock direct
    const block = toImageBlock({
      data: pngBytes,
      mimeType: "image/png",
      viewportWidth: 8,
      viewportHeight: 8,
      devicePixelRatio: 1,
    });
    assert.strictEqual(block.mimeType, "image/png");
  });

  it("rejects absurd clip dimensions before capture", async () => {
    const pngBytes = encodePngRgba(8, 8, solidRgba(8, 8, 20, 20, 20));
    let called = false;
    const fakeDriver = {
      captureScreenshot: async (_o: CaptureOptions): Promise<ScreenshotResult> => {
        called = true;
        return {
          data: pngBytes,
          mimeType: "image/png",
          viewportWidth: 8,
          viewportHeight: 8,
          devicePixelRatio: 1,
        };
      },
    };
    // Absurdly large clip → rejected before touching the driver.
    await assert.rejects(
      () =>
        captureForAgent(fakeDriver as never, {
          clip: { x: 0, y: 0, width: 100000, height: 100000 },
        }),
      (e: unknown) => (e as { code?: string }).code === "INVALID_ARGS",
    );
    assert.strictEqual(called, false, "driver must not be hit for invalid clips");
    // Non-finite clip → rejected.
    await assert.rejects(
      () =>
        captureForAgent(fakeDriver as never, {
          clip: { x: 0, y: 0, width: NaN, height: 100 },
        }),
      (e: unknown) => (e as { code?: string }).code === "INVALID_ARGS",
    );
    assert.strictEqual(called, false);
    // Negative origin → rejected (QA-FILE-05 P3).
    await assert.rejects(
      () =>
        captureForAgent(fakeDriver as never, {
          clip: { x: -10, y: 5, width: 100, height: 100 },
        }),
      (e: unknown) => (e as { code?: string }).code === "INVALID_ARGS",
    );
    assert.strictEqual(called, false);
  });
});

/* ---------- unit: session mutex serializes actions ---------- */
describe("browser service mutex", () => {
  function fakeDriverFactory(): ServiceDriver {
    return {
      navigate: async () => undefined,
      captureScreenshot: async () => ({
        data: encodePngRgba(2, 2, solidRgba(2, 2, 1, 2, 3)),
        mimeType: "image/png" as const,
        viewportWidth: 2,
        viewportHeight: 2,
        devicePixelRatio: 1,
      }),
      evaluate: (async <T>(script: string): Promise<T> => {
        if (script.includes("__idePicker")) {
          // minimal picker surface for service-level tests
          if (script.includes("highlightAt")) return null as T;
          return { ok: true, already: true } as T;
        }
        if (script.includes("querySelector")) return true as T;
        return null as T;
      }) as ServiceDriver["evaluate"],
      getUrl: async () => "about:blank",
      getTitle: async () => "blank",
      rawCdp: (async () => ({})) as ServiceDriver["rawCdp"],
      close: async () => undefined,
    };
  }

  it("serializes concurrent screenshots in issue order", async () => {
    const service = new BrowserService(async () => fakeDriverFactory());
    const s = await service.createSession({ agentId: "agent-1" });
    const seen: number[] = [];
    await Promise.all(
      [1, 2, 3].map((n) =>
        service.screenshot(s.sessionId, "agent-1").then(() => {
          seen.push(n);
        }),
      ),
    );
    assert.deepStrictEqual(seen, [1, 2, 3], "actions must run serialized in order");
    // ownership enforced
    await assert.rejects(
      () => service.screenshot(s.sessionId, "agent-2"),
      (e: unknown) => (e as { code?: string }).code === "OWNED_BY_ANOTHER_AGENT",
    );
    // lock mutex
    await service.lock(s.sessionId, "agent-1");
    const rec = service.listSessions("agent-1")[0];
    assert.strictEqual(rec.locked, true);
    await service.unlock(s.sessionId, "agent-1");
    await service.closeSession(s.sessionId, "agent-1");
    assert.strictEqual(service.listSessions("agent-1").length, 0);
  });

  it("lastInteracted resolves per agent, not globally (QA-FILE-05 P1)", async () => {
    const service = new BrowserService(async () => fakeDriverFactory());
    const a = await service.createSession({ agentId: "agent-a" });
    const b = await service.createSession({ agentId: "agent-b" });
    // Agent B interacted last globally — agent A must still resolve its OWN tab.
    await service.screenshot(b.sessionId, "agent-b");
    // undefined sessionId → per-agent last interacted, no OWNED_BY_ANOTHER_AGENT.
    await service.screenshot(undefined, "agent-a");
    await service.screenshot(undefined, "agent-b");
    // Closing A's tab clears only A's pointer; B still resolves.
    await service.closeSession(a.sessionId, "agent-a");
    await service.screenshot(undefined, "agent-b");
    await assert.rejects(
      () => service.screenshot(undefined, "agent-a"),
      (e: unknown) => (e as { code?: string }).code === "SESSION_NOT_FOUND",
    );
    await service.closeSession(b.sessionId, "agent-b");
  });

  it("browser_lock: owner keeps access while locked; non-owner is rejected", async () => {
    const service = new BrowserService(async () => fakeDriverFactory());
    const s = await service.createSession({ agentId: "agent-1" });
    await service.lock(s.sessionId, "agent-1");
    assert.strictEqual(service.listSessions("agent-1")[0].locked, true);
    // Owner actions still work while the tab is locked (no self-deadlock).
    await service.screenshot(s.sessionId, "agent-1");
    await service.navigate(s.sessionId, "agent-1", "about:blank");
    // A different agent cannot lock, unlock, or act on the tab (ownership first).
    await assert.rejects(
      () => service.lock(s.sessionId, "agent-2"),
      (e: unknown) => (e as { code?: string }).code === "OWNED_BY_ANOTHER_AGENT",
    );
    await assert.rejects(
      () => service.unlock(s.sessionId, "agent-2"),
      (e: unknown) => (e as { code?: string }).code === "OWNED_BY_ANOTHER_AGENT",
    );
    await assert.rejects(
      () => service.screenshot(s.sessionId, "agent-2"),
      (e: unknown) => (e as { code?: string }).code === "OWNED_BY_ANOTHER_AGENT",
    );
    // Owner unlocks; owner can close a locked tab (no lock-deadlock on close).
    await service.unlock(s.sessionId, "agent-1");
    assert.strictEqual(service.listSessions("agent-1")[0].locked, false);
    await service.closeSession(s.sessionId, "agent-1");
  });
});

/* ---------- unit: ref registry pure helpers ---------- */
describe("snapshot ref registry", () => {
  it("isValidRef matches Cursor's /^e\\d+$/ format", () => {
    assert.strictEqual(isValidRef("e0"), true);
    assert.strictEqual(isValidRef("e12"), true);
    assert.strictEqual(isValidRef("e999"), true);
    assert.strictEqual(isValidRef("e"), false);
    assert.strictEqual(isValidRef("12"), false);
    assert.strictEqual(isValidRef("ex"), false);
    assert.strictEqual(isValidRef(""), false);
    assert.strictEqual(isValidRef("e-1"), false);
  });

  it("selectorForRef builds the stamped-attribute selector", () => {
    assert.strictEqual(selectorForRef("e5"), '[data-ide-ref="e5"]');
  });

  it("renderSnapshotText renders the agent-readable tree", () => {
    const text = renderSnapshotText([
      { ref: "e0", role: "button", name: "Sign in", value: "", children: [] },
      {
        ref: "e1",
        role: "textbox",
        name: "Your name",
        value: "Ada",
        children: [{ ref: "e2", role: "link", name: "Help", value: "", children: [] }],
      },
    ]);
    assert.ok(text.includes('- button "Sign in" [e0]'), text);
    assert.ok(text.includes('- textbox "Your name" [e1] value="Ada"'), text);
    assert.ok(text.includes('  - link "Help" [e2]'), text);
  });

  it("countSnapshotNodes counts nested nodes", () => {
    const nodes = [
      { ref: "e0", role: "button", name: "a", value: "", children: [] },
      {
        ref: "e1",
        role: "generic",
        name: "",
        value: "",
        children: [{ ref: "e2", role: "link", name: "b", value: "", children: [] }],
      },
    ];
    assert.strictEqual(countSnapshotNodes(nodes), 3);
  });
});

/* ---------- unit: CDP denylist ---------- */
describe("browser_cdp denylist", () => {
  it("allows benign methods", () => {
    assertCdpMethodAllowed("Runtime.evaluate");
    assertCdpMethodAllowed("Page.captureScreenshot");
    assertCdpMethodAllowed("DOM.getDocument");
  });

  it("denies Input.* (use dedicated tools)", () => {
    assert.throws(() => assertCdpMethodAllowed("Input.dispatchMouseEvent"), BrowserError);
    assert.throws(() => assertCdpMethodAllowed("Input.dispatchKeyEvent"), BrowserError);
  });

  it("denies sensitive domain prefixes", () => {
    for (const m of ["Browser.getVersion", "Target.createTarget", "Storage.clearDataForOrigin", "SystemInfo.getInfo", "Tethering.bind"]) {
      assert.throws(() => assertCdpMethodAllowed(m), BrowserError, m);
    }
  });

  it("denies sensitive exact methods", () => {
    for (const m of [
      "DOM.setFileInputFiles",
      "Network.getCookies",
      "Network.setCookie",
      "Network.clearBrowserCookies",
      "Page.navigate",
      "Page.getNavigationHistory",
    ]) {
      assert.throws(() => assertCdpMethodAllowed(m), BrowserError, m);
    }
  });

  it("rejects malformed methods", () => {
    assert.throws(() => assertCdpMethodAllowed(""), BrowserError);
    assert.throws(() => assertCdpMethodAllowed("Runtime"), BrowserError);
    assert.throws(() => assertCdpMethodAllowed("Runtime.evaluate.extra"), BrowserError);
  });
});

/* ---------- REVERIFY-P1-1: sanctioned internal clear path ---------- */
describe("clearBrowsingDataInternal (tab chrome)", () => {
  function recordingService(calls: string[]): BrowserService {
    return new BrowserService(async () => ({
      navigate: async () => undefined,
      captureScreenshot: async () => ({
        data: encodePngRgba(2, 2, solidRgba(2, 2, 1, 2, 3)),
        mimeType: "image/png" as const,
        viewportWidth: 2,
        viewportHeight: 2,
        devicePixelRatio: 1,
      }),
      evaluate: (async () => null) as ServiceDriver["evaluate"],
      getUrl: async () => "about:blank",
      getTitle: async () => "blank",
      rawCdp: (async (method: string) => {
        calls.push(method);
        return {};
      }) as ServiceDriver["rawCdp"],
      close: async () => undefined,
    } as ServiceDriver));
  }

  it("lets the tab chrome clear via the sanctioned internal path", async () => {
    const calls: string[] = [];
    const service = recordingService(calls);
    const s = await service.createSession({ agentId: "user" });
    await service.clearBrowsingDataInternal(s.sessionId, "user", "Page.resetNavigationHistory");
    await service.clearBrowsingDataInternal(s.sessionId, "user", "Network.clearBrowserCookies");
    await service.clearBrowsingDataInternal(s.sessionId, "user", "Network.clearBrowserCache");
    assert.deepStrictEqual(calls, [
      "Page.resetNavigationHistory",
      "Network.clearBrowserCookies",
      "Network.clearBrowserCache",
    ]);
  });

  it("refuses a non-allowlisted method at runtime even when cast away (REVERIFY2-P3-1)", async () => {
    // X1's probe: TS type unions are compile-time only — a cast `as any`
    // bypasses them. The runtime allowlist must fail-closed before the
    // driver is touched.
    const calls: string[] = [];
    const service = recordingService(calls);
    const s = await service.createSession({ agentId: "user" });
    await assert.rejects(
      () =>
        service.clearBrowsingDataInternal(
          s.sessionId,
          "user",
          "Input.dispatchKeyEvent" as "Page.resetNavigationHistory",
        ),
      /outside the allowlist/,
    );
    assert.deepStrictEqual(calls, [], "the driver must never be reached");
  });

  it("keeps the agent-facing cdp() denylist intact for the denied methods", async () => {
    const calls: string[] = [];
    const service = recordingService(calls);
    const s = await service.createSession({ agentId: "agent-1" });
    // Only the Network methods are denylisted (Page.resetNavigationHistory
    // is allowed agent-facing — the tab chrome uses the internal path for
    // all three for consistency).
    for (const m of ["Network.clearBrowserCookies", "Network.clearBrowserCache"]) {
      await assert.rejects(
        service.cdp(s.sessionId, "agent-1", m, {}),
        BrowserError,
        `agent-facing cdp() must still deny ${m}`,
      );
    }
    assert.deepStrictEqual(calls, [], "denied calls must never reach the driver");
  });
});

/* ---------- unit: new tool schemas ---------- */
describe("new browser tool schemas", () => {
  function fakeService(): BrowserService {
    return new BrowserService(async () => ({
      navigate: async () => undefined,
      captureScreenshot: async () => ({
        data: encodePngRgba(2, 2, solidRgba(2, 2, 1, 2, 3)),
        mimeType: "image/png" as const,
        viewportWidth: 2,
        viewportHeight: 2,
        devicePixelRatio: 1,
      }),
      evaluate: (async () => null) as ServiceDriver["evaluate"],
      getUrl: async () => "about:blank",
      getTitle: async () => "blank",
      rawCdp: (async () => ({})) as ServiceDriver["rawCdp"],
      close: async () => undefined,
    } as ServiceDriver));
  }

  it("registers all 12 new tools with Cursor's exact names", () => {
    const tools = createBrowserMcpTools(fakeService());
    const names = tools.map((t) => t.name);
    for (const n of [
      "browser_snapshot",
      "browser_tabs",
      "browser_fill",
      "browser_select_option",
      "browser_press_key",
      "browser_scroll",
      "browser_drag",
      "browser_highlight",
      "browser_get_bounding_box",
      "browser_cdp",
      "browser_lock",
      "browser_mouse_click_xy",
      "browser_take_screenshot",
    ]) {
      assert.ok(names.includes(n), `${n} must be registered`);
    }
    // browser_fill_form must NOT be registered (dead in Cursor 3.25.6)
    assert.ok(!names.includes("browser_fill_form"), "browser_fill_form must not exist");
    assert.ok(!names.includes("browser_hover"), "browser_hover must not exist");
  });

  it("browser_cdp is gated off by default", async () => {
    const tools = createBrowserMcpTools(fakeService());
    const cdp = tools.find((t) => t.name === "browser_cdp")!;
    await assert.rejects(() => cdp.handler({ method: "Runtime.evaluate" }), /disabled/);
  });

  it("browser_cdp enforces the denylist when enabled", async () => {
    const tools = createBrowserMcpTools(fakeService(), "agent-1", { enableCdpTool: true });
    const cdp = tools.find((t) => t.name === "browser_cdp")!;
    await assert.rejects(
      () => cdp.handler({ method: "Input.dispatchMouseEvent" }),
      (e: unknown) => (e as { code?: string }).code === "INVALID_ARGS",
    );
    await assert.rejects(
      () => cdp.handler({ method: "Network.getCookies" }),
      (e: unknown) => (e as { code?: string }).code === "INVALID_ARGS",
    );
  });

  it("browser_click requires ref, selector, or element", async () => {
    const tools = createBrowserMcpTools(fakeService());
    const click = tools.find((t) => t.name === "browser_click")!;
    await assert.rejects(() => click.handler({}), /ref/);
  });

  it("browser_drag requires a target", async () => {
    const tools = createBrowserMcpTools(fakeService());
    const drag = tools.find((t) => t.name === "browser_drag")!;
    await assert.rejects(() => drag.handler({}), /sourceRef is required/);
  });
});

/* ---------- unit: browser_lock / browser_highlight / viewId / click options ---------- */
describe("lock, highlight, viewId, click options", () => {
  function pngShot() {
    return {
      data: encodePngRgba(2, 2, solidRgba(2, 2, 1, 2, 3)),
      mimeType: "image/png" as const,
      viewportWidth: 2,
      viewportHeight: 2,
      devicePixelRatio: 1,
    };
  }

  /** Fake driver that also simulates the in-page snapshot engine. */
  function snapshotAwareFactory(spy?: { scripts: string[]; byDriver: string[] }) {
    let n = 0;
    return async () => {
      const id = `drv-${++n}`;
      return {
        navigate: async () => undefined,
        captureScreenshot: async () => pngShot(),
        evaluate: (async (script: string) => {
          spy?.scripts.push(script);
          spy?.byDriver.push(id);
          if (script.includes("__ideSnapshotInjected")) return { ok: true, already: true };
          if (script.includes("__ideSnapshot.snapshot("))
            return {
              ok: true,
              nodes: [{ ref: "e1", role: "button", name: "OK", value: "", children: [] }],
            };
          if (script.includes("__ideSnapshot.validate("))
            return { ok: true, selector: '[data-ide-ref="e1"]', description: "button OK" };
          if (script.includes("__ideSnapshot.cleanup(")) return { ok: true };
          if (script.includes("__ide-ref-highlight")) return true;
          return true;
        }) as ServiceDriver["evaluate"],
        getUrl: async () => "about:blank",
        getTitle: async () => "blank",
        rawCdp: (async () => ({})) as ServiceDriver["rawCdp"],
        close: async () => undefined,
      } as ServiceDriver;
    };
  }

  it("browser_lock locks and unlocks via the tool", async () => {
    const service = new BrowserService(snapshotAwareFactory());
    const tools = createBrowserMcpTools(service);
    const lock = tools.find((t) => t.name === "browser_lock")!;
    assert.deepStrictEqual(lock.inputSchema.required, ["action"]);

    // No tab yet → honest SESSION_NOT_FOUND (the tool does not invent a tab).
    await assert.rejects(
      () => lock.handler({ action: "lock" }),
      (e: unknown) => (e as { code?: string }).code === "SESSION_NOT_FOUND",
    );

    await service.createSession({ agentId: "default-agent" });
    const on = (await lock.handler({ action: "lock" })) as { ok: boolean; action: string };
    assert.strictEqual(on.ok, true);
    assert.strictEqual(on.action, "lock");
    assert.strictEqual(service.listSessions("default-agent")[0].locked, true);

    const off = (await lock.handler({ action: "unlock" })) as { ok: boolean; action: string };
    assert.strictEqual(off.ok, true);
    assert.strictEqual(off.action, "unlock");
    assert.strictEqual(service.listSessions("default-agent")[0].locked, false);

    await assert.rejects(() => lock.handler({ action: "smash" }), /lock"|"unlock/);
  });

  it("browser_highlight returns ok + ref + durationMs (default 2000)", async () => {
    const service = new BrowserService(snapshotAwareFactory());
    await service.createSession({ agentId: "default-agent" });
    const tools = createBrowserMcpTools(service);
    const hl = tools.find((t) => t.name === "browser_highlight")!;
    assert.deepStrictEqual(hl.inputSchema.required, ["ref"]);

    const r1 = (await hl.handler({ ref: "e1" })) as {
      ok: boolean;
      ref: string;
      durationMs: number;
    };
    assert.strictEqual(r1.ok, true);
    assert.strictEqual(r1.ref, "e1");
    assert.strictEqual(r1.durationMs, 2000, "default duration must be 2000ms");

    const r2 = (await hl.handler({ ref: "e1", durationMs: 500 })) as { durationMs: number };
    assert.strictEqual(r2.durationMs, 500);

    const r3 = (await hl.handler({ ref: "e1", durationMs: 999999 })) as { durationMs: number };
    assert.strictEqual(r3.durationMs, 30000, "duration must be capped at 30000ms");

    await assert.rejects(() => hl.handler({}), /ref is required/);
    await assert.rejects(() => hl.handler({ ref: "zzz" }), /invalid ref/);
  });

  it("action tools honor viewId instead of last-interacted", async () => {
    const spy = { scripts: [] as string[], byDriver: [] as string[] };
    const service = new BrowserService(snapshotAwareFactory(spy));
    const tools = createBrowserMcpTools(service);
    const a = await service.createSession({ agentId: "default-agent" });
    const b = await service.createSession({ agentId: "default-agent" });
    assert.notStrictEqual(a.sessionId, b.sessionId);
    // Helper takes string[] so TS can't narrow the literal element type
    // across the successive assertions below.
    const allHit = (arr: string[], id: string) => arr.length > 0 && arr.every((d) => d === id);

    const click = tools.find((t) => t.name === "browser_click")!;
    // Default first: last-interacted is session B (created last).
    spy.byDriver.length = 0;
    await click.handler({ selector: "#x" });
    assert.ok(
      allHit(spy.byDriver, "drv-2"),
      `default must hit last-interacted session B (drv-2), got ${spy.byDriver}`,
    );

    // Explicit viewId targets session A; this also makes A the last-interacted.
    spy.byDriver.length = 0;
    await click.handler({ selector: "#x", viewId: a.sessionId });
    assert.ok(
      allHit(spy.byDriver, "drv-1"),
      `explicit viewId must hit session A (drv-1), got ${spy.byDriver}`,
    );

    // fill also honors viewId
    const fill = tools.find((t) => t.name === "browser_fill")!;
    spy.byDriver.length = 0;
    await fill.handler({ ref: "e1", value: "v", viewId: a.sessionId });
    assert.ok(allHit(spy.byDriver, "drv-1"), `fill viewId must hit drv-1, got ${spy.byDriver}`);
  });

  it("click supports doubleClick, right button, and modifiers", async () => {
    const spy = { scripts: [] as string[], byDriver: [] as string[] };
    const service = new BrowserService(snapshotAwareFactory(spy));
    const s = await service.createSession({ agentId: "default-agent" });

    await service.click(s.sessionId, "default-agent", { selector: "#x" }, { doubleClick: true });
    const dbl = spy.scripts[spy.scripts.length - 1];
    assert.ok(dbl.includes("dblclick"), "doubleClick must dispatch a dblclick event");

    await service.click(
      s.sessionId,
      "default-agent",
      { selector: "#x" },
      { button: "right", modifiers: ["Shift"] },
    );
    const right = spy.scripts[spy.scripts.length - 1];
    assert.ok(right.includes("contextmenu"), "right button must dispatch contextmenu");
    assert.ok(right.includes('"shiftKey":true'), "modifiers must reach the MouseEvent init");

    await assert.rejects(
      () => service.click(s.sessionId, "default-agent", { selector: "#x" }, { button: "side" as never }),
      (e: unknown) => (e as { code?: string }).code === "INVALID_ARGS",
    );
  });

  it("click/type accept the element alias for selector", async () => {
    const service = new BrowserService(snapshotAwareFactory());
    await service.createSession({ agentId: "default-agent" });
    const tools = createBrowserMcpTools(service);
    const click = tools.find((t) => t.name === "browser_click")!;
    const res = (await click.handler({ element: "#login" })) as { ok: boolean };
    assert.strictEqual(res.ok, true);

    const type = tools.find((t) => t.name === "browser_type")!;
    const tres = (await type.handler({ element: "#name", text: "Ada" })) as { ok: boolean };
    assert.strictEqual(tres.ok, true);
  });

  it("type slowly types character-by-character through the editing pipeline", async () => {
    const spy = { scripts: [] as string[], byDriver: [] as string[] };
    const service = new BrowserService(snapshotAwareFactory(spy));
    const s = await service.createSession({ agentId: "default-agent" });
    const res = await service.type(s.sessionId, "default-agent", { selector: "#x" }, "Hi", {
      slowly: true,
      clear: true,
    });
    assert.strictEqual(res.ok, true);
    const insertScripts = spy.scripts.filter((sc) => sc.includes("insertText"));
    assert.strictEqual(insertScripts.length, 2, "one insertText evaluate per character");
    assert.ok(insertScripts[0].includes(JSON.stringify("H")), "first char must be H");
    assert.ok(insertScripts[1].includes(JSON.stringify("i")), "second char must be i");
  });
});

/* ---------- integration: real headless Chromium ---------- */
const CHROME = process.env.IDE_BROWSER_CHROME ?? "";
import * as http from "node:http";
import * as fs from "node:fs";

let FIXTURE_URL = "";
let fixtureServer: http.Server | null = null;

async function startFixtureServer(): Promise<string> {
  const html = fs.readFileSync(path.join(__dirname, "fixture.html"), "utf8");
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  fixtureServer = server;
  return `http://127.0.0.1:${port}/fixture.html`;
}

describe("integration (headless chromium)", { skip: !CHROME }, () => {
  let stop: () => void = () => undefined;
  let port = 0;

  before(async () => {
    FIXTURE_URL = await startFixtureServer();
    const launched = await launchHeadlessChromium(CHROME, { viewport: { width: 900, height: 700 } });
    port = launched.port;
    stop = launched.stop;
  });

  after(() => {
    stop();
    fixtureServer?.close();
  });

  it("navigate → real PNG screenshot bytes", async () => {
    const service = new BrowserService(async () => {
      const d = await CdpPageDriver.attach("127.0.0.1", port);
      return d as unknown as ServiceDriver;
    });
    const s = await service.createSession({ agentId: "agent-1" });
    const nav = await service.navigate(s.sessionId, "agent-1", FIXTURE_URL);
    assert.ok(nav.title.includes("Fixture"), `title was "${nav.title}"`);
    const shot = await service.screenshot(s.sessionId, "agent-1", { format: "png", type: "viewport" });
    const img = shot.content.find((c) => c.type === "image");
    assert.ok(img && img.type === "image", "must include image block");
    if (img.type === "image") {
      const bytes = Buffer.from(img.base64Data, "base64");
      assert.ok(isPng(bytes), "CDP must return real PNG bytes");
      assert.ok(bytes.length > 1000, `screenshot too small: ${bytes.length}`);
    }
    await service.closeSession(s.sessionId, "agent-1");
  });

  it("picker inject → pickAt button → real payload", async () => {
    const service = new BrowserService(async () => {
      const d = await CdpPageDriver.attach("127.0.0.1", port);
      return d as unknown as ServiceDriver;
    });
    const s = await service.createSession({ agentId: "agent-1" });
    await service.navigate(s.sessionId, "agent-1", FIXTURE_URL);
    // Button is roughly at (100, 150) in the 900x700 viewport; find it precisely.
    const picker = service.pickerFor(s.sessionId, "agent-1");
    const probed = await picker.payloadForSelector("#login-btn");
    assert.ok(probed, "selector payload must resolve");
    assert.strictEqual(probed!.tagName, "button");
    assert.strictEqual(probed!.id, "login-btn");
    assert.ok(probed!.innerText.includes("Sign in"));
    assert.ok(probed!.xpath.includes("button"), `xpath: ${probed!.xpath}`);
    assert.ok(probed!.rect.width > 0 && probed!.rect.height > 0);
    assert.ok(probed!.uniqueId.startsWith("ide-el-"), `uniqueId: ${probed!.uniqueId}`);
    assert.ok(!("data-ide" in probed!), "identity must be off-DOM");
    // pickAt at the button's center → same element
    const cx = probed!.rect.x + probed!.rect.width / 2;
    const cy = probed!.rect.y + probed!.rect.height / 2;
    const picked = await service.pickAt(s.sessionId, "agent-1", cx, cy);
    assert.strictEqual(picked.selections.length, 1);
    assert.strictEqual(picked.selections[0].payload.id, "login-btn");
    assert.strictEqual(picked.context.uiElementSelections[0].xpath, picked.selections[0].xpath);
    assert.ok(picked.frozenFrameDataUrl.startsWith("data:image/png;base64,"));
    await service.closeSession(s.sessionId, "agent-1");
  });

  it("picker applies the orange hover highlight class to real elements", async () => {
    const service = new BrowserService(async () => {
      const d = await CdpPageDriver.attach("127.0.0.1", port);
      return d as unknown as ServiceDriver;
    });
    const s = await service.createSession({ agentId: "agent-1" });
    await service.navigate(s.sessionId, "agent-1", FIXTURE_URL);
    const picker = service.pickerFor(s.sessionId, "agent-1");
    await picker.inject();
    await picker.start(); // attaches the <style> with the orange highlight rules
    // Hover the button via the picker's highlightAt, then read its class list.
    const probed = await picker.payloadForSelector("#login-btn");
    assert.ok(probed);
    const cx = probed!.rect.x + probed!.rect.width / 2;
    const cy = probed!.rect.y + probed!.rect.height / 2;
    await picker.pickAt(cx, cy);
    // Ask the page which element currently carries the hover class.
    const driver = (service as unknown as { sessions: Map<string, { driver: ServiceDriver }> }).sessions.get(
      s.sessionId,
    )!.driver;
    const highlightedId = await (driver as unknown as import("../driver").PageDriver).evaluate<string | null>(
      `(function(){var el=document.querySelector(".__ide-picker-hover");return el?el.id||el.tagName:null;})()`,
    );
    assert.strictEqual(highlightedId, "login-btn", "hovered element must carry the orange highlight class");
    // And the highlight color rule must be the Cursor orange.
    const rule = await (driver as unknown as import("../driver").PageDriver).evaluate<string>(
      `(function(){var el=document.querySelector('style[data-ide-picker]');return el?el.textContent.slice(0,200):"";})()`,
    );
    assert.ok(rule.includes("#ff6a00"), "highlight must use Cursor's #ff6a00 orange");
    await service.closeSession(s.sessionId, "agent-1");
  });

  it("MCP tools: navigate/click/type/screenshot/pick_element end-to-end", async () => {
    const service = new BrowserService(async () => {
      const d = await CdpPageDriver.attach("127.0.0.1", port);
      return d as unknown as ServiceDriver;
    });
    const tools = createBrowserMcpTools(service);
    // 19 tools: Cursor's 16 + browser_screenshot alias + browser_pick_element + browser_close
    assert.strictEqual(tools.length, 19);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    // Cursor's exact tool names must all be present
    for (const name of [
      "browser_navigate",
      "browser_take_screenshot",
      "browser_snapshot",
      "browser_click",
      "browser_mouse_click_xy",
      "browser_type",
      "browser_fill",
      "browser_select_option",
      "browser_press_key",
      "browser_scroll",
      "browser_drag",
      "browser_highlight",
      "browser_get_bounding_box",
      "browser_tabs",
      "browser_lock",
      "browser_cdp",
    ]) {
      assert.ok(byName[name], `tool ${name} must be registered`);
    }

    const navRes = await byName.browser_navigate.handler({ url: FIXTURE_URL, agentId: "agent-1" });
    assert.strictEqual(navRes.ok, true);

    const clickRes = await byName.browser_click.handler({ selector: "#login-btn", agentId: "agent-1" });
    assert.strictEqual(clickRes.ok, true);

    const typeRes = await byName.browser_type.handler({
      selector: "#name-input",
      text: "Ada",
      clear: true,
      agentId: "agent-1",
    });
    assert.strictEqual(typeRes.ok, true);

    const shotRes = await byName.browser_screenshot.handler({ type: "png", agentId: "agent-1" });
    const content = shotRes.content as Array<{ type: string }>;
    assert.ok(content.some((c) => c.type === "image"), "screenshot tool must return image block");

    const pickRes = await byName.browser_pick_element.handler({ selector: "#info-card", agentId: "agent-1" });
    const sels = pickRes.selections as Array<{ xpath: string }>;
    assert.ok(sels.length >= 1, "must pick the card");
    const ctx = pickRes.context as { uiElementSelections: unknown[] };
    assert.ok(ctx.uiElementSelections.length >= 1);
  });

  it("browser_snapshot: stable e<N> refs, then ref-based click/type/fill", async () => {
    const service = new BrowserService(async () => {
      const d = await CdpPageDriver.attach("127.0.0.1", port);
      return d as unknown as ServiceDriver;
    });
    const tools = createBrowserMcpTools(service);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    await byName.browser_navigate.handler({ url: FIXTURE_URL, agentId: "agent-1" });

    const snapRes = (await byName.browser_snapshot.handler({ agentId: "agent-1" })) as {
      snapshot: string;
      refCount: number;
    };
    assert.ok(snapRes.refCount >= 4, `expected >=4 refs, got ${snapRes.refCount}:\n${snapRes.snapshot}`);
    assert.match(snapRes.snapshot, /\[e\d+\]/, "refs must look like e<N>");
    assert.ok(snapRes.snapshot.includes("Sign in"), "button must be named");

    // Extract the button's ref from the snapshot text.
    const btnMatch = snapRes.snapshot.match(/- button "Sign in" \[(e\d+)\]/);
    assert.ok(btnMatch, "button ref must be present");
    const btnRef = btnMatch![1];
    const inputMatch = snapRes.snapshot.match(/- textbox "Your name" \[(e\d+)\]/);
    assert.ok(inputMatch, "input ref must be present");
    const inputRef = inputMatch![1];

    // Ref-based click works.
    const clickRes = await byName.browser_click.handler({ ref: btnRef, agentId: "agent-1" });
    assert.strictEqual(clickRes.ok, true);

    // Ref-based type works.
    const typeRes = await byName.browser_type.handler({
      ref: inputRef,
      text: "Ada",
      clear: true,
      agentId: "agent-1",
    });
    assert.strictEqual(typeRes.ok, true);

    // browser_fill sets the value.
    const fillRes = await byName.browser_fill.handler({ ref: inputRef, value: "Grace", agentId: "agent-1" });
    assert.strictEqual(fillRes.ok, true);

    // Second snapshot keeps stable refs.
    const snap2 = (await byName.browser_snapshot.handler({ agentId: "agent-1" })) as { snapshot: string };
    assert.ok(snap2.snapshot.includes(`[${btnRef}]`), "button ref must be stable across snapshots");

    // Stale ref is rejected with the recovery message.
    await assert.rejects(
      () => byName.browser_click.handler({ ref: "e99999", agentId: "agent-1" }),
      /The page may have changed/,
    );
    await service.closeSession(undefined, "agent-1");
  });

  it("browser_select_option / browser_press_key / browser_get_bounding_box", async () => {
    const service = new BrowserService(async () => {
      const d = await CdpPageDriver.attach("127.0.0.1", port);
      return d as unknown as ServiceDriver;
    });
    const tools = createBrowserMcpTools(service);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    await byName.browser_navigate.handler({ url: FIXTURE_URL, agentId: "agent-1" });
    const snap = (await byName.browser_snapshot.handler({ agentId: "agent-1" })) as { snapshot: string };
    const selMatch = snap.snapshot.match(/- (combobox|listbox) "Favorite color" \[(e\d+)\]/);
    assert.ok(selMatch, `select ref must be present:\n${snap}`);
    const selRef = selMatch![2];

    const selRes = (await byName.browser_select_option.handler({
      ref: selRef,
      values: ["green"],
      agentId: "agent-1",
    })) as { ok: boolean; selected: string[] };
    assert.strictEqual(selRes.ok, true);
    assert.deepStrictEqual(selRes.selected, ["green"]);

    const boxRes = (await byName.browser_get_bounding_box.handler({ ref: selRef, agentId: "agent-1" })) as {
      ref: string;
      width: number;
      height: number;
    };
    assert.strictEqual(boxRes.ref, selRef);
    assert.ok(boxRes.width > 0 && boxRes.height > 0);

    // press_key dispatches a real DOM key event (fixture logs it).
    await byName.browser_press_key.handler({ key: "Enter", agentId: "agent-1" });
    const driver = (
      service as unknown as { sessions: Map<string, { driver: ServiceDriver }> }
    ).sessions.values().next().value!.driver;
    const keyLog = await (driver as unknown as import("../driver").PageDriver).evaluate<string[]>(
      "window.__keyLog",
    );
    assert.ok(keyLog.includes("Enter"), `key log must include Enter: ${keyLog}`);
    await service.closeSession(undefined, "agent-1");
  });

  it("browser_scroll / browser_drag / browser_mouse_click_xy / browser_tabs", async () => {
    const service = new BrowserService(async () => {
      const d = await CdpPageDriver.attach("127.0.0.1", port);
      return d as unknown as ServiceDriver;
    });
    const tools = createBrowserMcpTools(service, "agent-1", { enableCdpTool: true });
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    await byName.browser_navigate.handler({ url: FIXTURE_URL, agentId: "agent-1" });

    // tabs list shows the tab
    const listRes = (await byName.browser_tabs.handler({ action: "list", agentId: "agent-1" })) as {
      viewIds: string[];
      tabs: Array<{ url: string }>;
    };
    assert.strictEqual(listRes.viewIds.length, 1);
    assert.ok(listRes.tabs[0].url.includes("fixture.html"));

    // tabs new + select + close
    const newRes = (await byName.browser_tabs.handler({ action: "new", agentId: "agent-1" })) as {
      viewId: string;
    };
    const list2 = (await byName.browser_tabs.handler({ action: "list", agentId: "agent-1" })) as {
      viewIds: string[];
    };
    assert.strictEqual(list2.viewIds.length, 2);
    await byName.browser_tabs.handler({ action: "close", agentId: "agent-1" });
    const list3 = (await byName.browser_tabs.handler({ action: "list", agentId: "agent-1" })) as {
      viewIds: string[];
    };
    assert.strictEqual(list3.viewIds.length, 1);

    // scroll down moves the viewport
    const driver = (
      service as unknown as { sessions: Map<string, { driver: ServiceDriver }> }
    ).sessions.values().next().value!.driver;
    const page = driver as unknown as import("../driver").PageDriver;
    const y0 = await page.evaluate<number>("window.scrollY");
    await byName.browser_scroll.handler({ direction: "down", amount: 800, agentId: "agent-1" });
    const y1 = await page.evaluate<number>("window.scrollY");
    assert.ok(y1 > y0, `scroll must move viewport (${y0} -> ${y1})`);

    // drag source -> target fires drop (fixture records it)
    const snap = (await byName.browser_snapshot.handler({ agentId: "agent-1" })) as { snapshot: string };
    const srcMatch = snap.snapshot.match(/"drag me" \[(e\d+)\]/);
    const tgtMatch = snap.snapshot.match(/"drop here" \[(e\d+)\]/);
    assert.ok(srcMatch && tgtMatch, `drag refs must be present:\n${snap}`);
    const dragRes = await byName.browser_drag.handler({
      sourceRef: srcMatch![1],
      targetRef: tgtMatch![1],
      agentId: "agent-1",
    });
    assert.strictEqual(dragRes.ok, true);
    const dropped = await page.evaluate<boolean>("window.__dropHappened");
    assert.strictEqual(dropped, true, "drop event must fire on the target");

    // mouse_click_xy clicks the login button at its coordinates
    const boxRes = (await byName.browser_get_bounding_box.handler({
      ref: (snap.snapshot.match(/- button "Sign in" \[(e\d+)\]/) as RegExpMatchArray)[1],
      agentId: "agent-1",
    })) as { x: number; y: number; width: number; height: number };
    const clickRes = await byName.browser_mouse_click_xy.handler({
      x: boxRes.x + boxRes.width / 2,
      y: boxRes.y + boxRes.height / 2,
      agentId: "agent-1",
    });
    assert.strictEqual(clickRes.ok, true);
    const clicked = await page.evaluate<boolean>("window.__fixtureClicked");
    assert.strictEqual(clicked, true, "coordinate click must hit the button");

    // browser_cdp passes through allowed methods when enabled
    const cdpRes = (await byName.browser_cdp.handler({
      method: "Runtime.evaluate",
      params: { expression: "1+1", returnByValue: true },
      agentId: "agent-1",
    })) as { ok: boolean; result: { value: number } };
    assert.strictEqual(cdpRes.ok, true);
    assert.strictEqual(cdpRes.result.value, 2);
    await service.closeSession(undefined, "agent-1");
  });
});

/* ---------- browser tab UI (DEV-BROWSER-TAB-UI) ---------- */
import "./browser-tab.test";
/* ---------- browser "..." menu host handlers (QA-BROWSERMENU P3-6) ---------- */
import "./browser-menu-handlers.test";
