/**
 * composer-unread-divider tests (node:test, minimal DOM mock, zero extra deps).
 *
 * Covers:
 *  - Evidence parity: row kind 'unreadDivider', rowId 'unread-divider:<id>',
 *    CSS class 'agent-transcript-row-unread-divider', pill text 'N New Message'.
 *  - UnreadDividerState: new message while at bottom → no marker; while
 *    scrolled up → anchor = first unread, count grows; scroll-to-bottom clears;
 *    jump clears.
 *  - mountUnreadDivider: divider inserted BEFORE the first unread message
 *    element; pill label counts up; pill click jumps (custom onJump honored,
 *    default scrolls container to bottom) and clears; scroll listener clears
 *    when the user scrolls back down; CSS injected once; destroy() removes
 *    nodes + listeners.
 *
 * Run after `tsc`:  node --test out/services/test/run-unread-divider-tests.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import {
  UNREAD_DIVIDER_COMPONENT,
  UNREAD_DIVIDER_CSS_CLASS,
  UNREAD_DIVIDER_LABEL_CSS_CLASS,
  UNREAD_DIVIDER_ROW_ID_PREFIX,
  UNREAD_JUMP_PILL_CAP,
  UNREAD_JUMP_PILL_CSS_CLASS,
  UNREAD_JUMP_PILL_ICON_ABOVE,
  UNREAD_JUMP_PILL_ICON_BELOW,
  UNREAD_JUMP_PILL_LABEL_CSS_CLASS,
  UNREAD_JUMP_PILL_NLS_MANY,
  UNREAD_JUMP_PILL_NLS_ONE,
  UnreadDividerState,
  buildUnreadDividerRow,
  buildUnreadJumpPill,
  makeUnreadDividerRow,
  mountUnreadDivider,
  unreadDividerWebviewScript,
  unreadJumpPillLabel,
  MiniDocument,
  MiniElement,
  MiniScrollBox,
  UnreadDividerViewport,
} from "../../components/unreadDivider";

/* ---------------- Minimal DOM mock ---------------- */

class MockElement implements MiniElement {
  className = "";
  textContent: string | null = null;
  parentNode: any = null;
  private attrs = new Map<string, string>();
  readonly childList: MockElement[] = [];
  private listeners = new Map<string, ((...a: any[]) => void)[]>();

  constructor(public tagName = "div") {}

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attrs.has(name) ? this.attrs.get(name)! : null;
  }
  get children(): any {
    return this.childList;
  }
  appendChild(child: MockElement): MockElement {
    if (child.parentNode) {
      child.parentNode.removeChild(child);
    }
    child.parentNode = this;
    this.childList.push(child);
    return child;
  }
  insertBefore(child: MockElement, ref: MockElement | null): MockElement {
    if (child.parentNode) {
      child.parentNode.removeChild(child);
    }
    child.parentNode = this;
    const idx = ref ? this.childList.indexOf(ref) : -1;
    if (idx === -1) {
      this.childList.push(child);
    } else {
      this.childList.splice(idx, 0, child);
    }
    return child;
  }
  removeChild(child: MockElement): void {
    const idx = this.childList.indexOf(child);
    if (idx !== -1) {
      this.childList.splice(idx, 1);
      child.parentNode = null;
    }
  }
  remove(): void {
    if (this.parentNode) {
      this.parentNode.removeChild(this);
    }
  }
  addEventListener(type: string, listener: (...a: any[]) => void): void {
    const arr = this.listeners.get(type) || [];
    arr.push(listener);
    this.listeners.set(type, arr);
  }
  removeEventListener(type: string, listener: (...a: any[]) => void): void {
    const arr = this.listeners.get(type) || [];
    this.listeners.set(
      type,
      arr.filter((l) => l !== listener),
    );
  }
  querySelector(sel: string): MockElement | null {
    // Only the subset used by ensureCss: [data-attr]
    if (sel.startsWith("[") && sel.endsWith("]")) {
      const attr = sel.slice(1, -1);
      return this.childList.find((c) => c.getAttribute(attr) !== null) || null;
    }
    return null;
  }
  click(): void {
    this.fire("click");
  }
  fire(type: string): void {
    for (const l of this.listeners.get(type) || []) {
      l();
    }
  }
  scrollListeners(): number {
    return (this.listeners.get("scroll") || []).length;
  }
}

class MockScrollBox extends MockElement implements MiniScrollBox {
  scrollTop = 0;
  scrollHeight = 1000;
  clientHeight = 400;
}

class MockDocument implements MiniDocument {
  readonly head = new MockElement("head");
  createElement(tagName: string): MiniElement {
    return new MockElement(tagName);
  }
}

function gap(box: MockScrollBox): number {
  return box.scrollHeight - box.scrollTop - box.clientHeight;
}

/* ---------------- Tests ---------------- */

describe("evidence parity (Cursor 3.25.6, workbench.glass.main.js)", () => {
  it("row kind is 'unreadDivider' and rowId is 'unread-divider:<id>'", () => {
    const row = makeUnreadDividerRow("abc123");
    assert.equal(row.kind, "unreadDivider");
    assert.equal(row.rowId, "unread-divider:abc123");
    assert.equal(UNREAD_DIVIDER_ROW_ID_PREFIX, "unread-divider:");
  });

  it("divider CSS class is 'agent-transcript-row-unread-divider'", () => {
    assert.equal(
      UNREAD_DIVIDER_CSS_CLASS,
      "agent-transcript-row-unread-divider",
    );
    const doc = new MockDocument();
    const el = buildUnreadDividerRow(doc, "unread-divider:x");
    assert.equal(el.className, "agent-transcript-row-unread-divider");
    assert.equal(el.getAttribute("data-rowid"), "unread-divider:x");
  });

  it("pill nls keys + label logic (UKT, iNc=30)", () => {
    assert.equal(UNREAD_JUMP_PILL_NLS_ONE, "glass.unreadJumpPill.one");
    assert.equal(UNREAD_JUMP_PILL_NLS_MANY, "glass.unreadJumpPill.many");
    assert.equal(UNREAD_JUMP_PILL_CAP, 30);
    assert.equal(unreadJumpPillLabel(1), "1 New Message");
    assert.equal(unreadJumpPillLabel(2), "2 New Messages");
    assert.equal(unreadJumpPillLabel(5), "5 New Messages");
    assert.equal(unreadJumpPillLabel(30), "30 New Messages");
    assert.equal(unreadJumpPillLabel(31), "30+ New Messages");
    assert.equal(unreadJumpPillLabel(250), "30+ New Messages");
  });

  it("divider inner markup: 'New messages below' + data-component", () => {
    assert.equal(UNREAD_DIVIDER_COMPONENT, "project-unread-divider");
    const doc = new MockDocument();
    const el = buildUnreadDividerRow(doc, "unread-divider:x");
    const inner = (el as MockElement).childList[0] as MockElement;
    assert.equal(inner.getAttribute("data-component"), "project-unread-divider");
    const label = inner.childList[1];
    assert.ok(label.className.includes(UNREAD_DIVIDER_LABEL_CSS_CLASS));
    assert.equal(label.textContent, null); // text lives in child spans
    const words = label.childList.map((c: MockElement) => c.textContent).join("");
    assert.equal(words, "New messages below");
    // aria-hidden rules flank the label (evidence: Lgp)
    assert.equal(inner.childList[0].getAttribute("aria-hidden"), "true");
    assert.equal(inner.childList[2].getAttribute("aria-hidden"), "true");
  });

  it("pill carries data-direction + verbatim icon names", () => {
    assert.equal(UNREAD_JUMP_PILL_ICON_ABOVE, "arrow-up");
    assert.equal(UNREAD_JUMP_PILL_ICON_BELOW, "arrow-down");
    const doc = new MockDocument();
    const noop = () => {};
    const below = buildUnreadJumpPill(doc, "2 New Messages", "below", noop, noop);
    assert.equal(below.getAttribute("data-component"), "unread-jump-pill");
    assert.equal(below.getAttribute("data-direction"), "below");
    const above = buildUnreadJumpPill(doc, "2 New Messages", "above", noop, noop);
    assert.equal(above.getAttribute("data-direction"), "above");
    const arrowOf = (pill: MiniElement) =>
      (pill as MockElement).childList.find((c: MockElement) =>
        c.getAttribute("data-icon") !== null,
      )!;
    assert.equal(arrowOf(below).getAttribute("data-icon"), "arrow-down");
    assert.equal(arrowOf(above).getAttribute("data-icon"), "arrow-up");
  });
});

describe("UnreadDividerState — pure logic", () => {
  it("message appended at the bottom: no marker", () => {
    const s = new UnreadDividerState();
    s.onMessageAppended("m1", 10 /* < 48 */);
    assert.equal(s.visible, false);
    assert.equal(s.count, 0);
    assert.equal(s.anchor, null);
    assert.equal(s.rowId(), null);
  });

  it("message appended while scrolled up: anchor + count", () => {
    const s = new UnreadDividerState();
    s.onMessageAppended("m1", 300);
    s.onMessageAppended("m2", 300);
    assert.equal(s.visible, true);
    assert.equal(s.anchor, "m1"); // first unread message anchors the divider
    assert.equal(s.count, 2);
    assert.equal(s.rowId(), "unread-divider:m1");
    assert.equal(s.jumpLabel(), "2 New Messages");
  });

  it("scrolling back to the bottom clears the marker", () => {
    const s = new UnreadDividerState();
    s.onMessageAppended("m1", 300);
    assert.equal(s.visible, true);
    s.onScrolled(5);
    assert.equal(s.visible, false);
    assert.equal(s.count, 0);
    assert.equal(s.anchor, null);
  });

  it("scrolling partway (still away from bottom) keeps the marker", () => {
    const s = new UnreadDividerState();
    s.onMessageAppended("m1", 300);
    s.onScrolled(200);
    assert.equal(s.visible, true);
    assert.equal(s.count, 1);
  });

  it("direction: below jump returns 'bottom' and clears", () => {
    const s = new UnreadDividerState();
    s.onMessageAppended("m1", 300);
    assert.equal(s.direction, "below");
    assert.equal(s.onJump(), "bottom");
    assert.equal(s.visible, false);
  });

  it("direction: divider above viewport flips to 'above'; jump returns 'divider' and keeps the marker", () => {
    const s = new UnreadDividerState();
    s.onMessageAppended("m1", 300);
    s.onDividerAboveViewport(true);
    assert.equal(s.direction, "above");
    assert.equal(s.onJump(), "divider");
    assert.equal(s.visible, true); // marker stays until bottom/dismiss
    s.onDividerAboveViewport(false);
    assert.equal(s.direction, "below");
  });

  it("dismiss: below hides the pill but keeps the divider; above clears everything", () => {
    const s = new UnreadDividerState();
    s.onMessageAppended("m1", 300);
    s.onDismiss(); // direction "below"
    assert.equal(s.pillVisible, false);
    assert.equal(s.visible, true);
    s.onMessageAppended("m2", 300); // new unread -> pill returns
    assert.equal(s.pillVisible, true);

    s.onDividerAboveViewport(true);
    s.onDismiss(); // direction "above"
    assert.equal(s.visible, false);
  });

  it("message at the bottom after an unread marker was set: marker cleared", () => {
    const s = new UnreadDividerState();
    s.onMessageAppended("m1", 300);
    s.onMessageAppended("m2", 0); // user jumped back to bottom; m2 is seen
    assert.equal(s.visible, false);
  });
});

describe("mountUnreadDivider — DOM behavior (mock)", () => {
  function mount(
    gapPx?: number,
    extra?: { viewport?: UnreadDividerViewport; onJump?: () => void },
  ) {
    const doc = new MockDocument();
    const box = new MockScrollBox();
    if (gapPx !== undefined) {
      box.scrollTop = box.scrollHeight - box.clientHeight - gapPx;
    }
    let jumped = false;
    const handle = mountUnreadDivider({
      doc,
      messagesEl: box,
      onJump:
        extra?.onJump !== undefined
          ? extra.onJump
          : () => {
              jumped = true;
            },
      viewport: extra?.viewport,
    });
    return {
      doc,
      box,
      handle,
      wasJumped: () => jumped,
    };
  }

  function pillLabelText(pill: MockElement): string | null {
    const label = pill.childList.find((c: MockElement) =>
      c.className.includes(UNREAD_JUMP_PILL_LABEL_CSS_CLASS),
    );
    return label ? label.textContent : pill.textContent;
  }

  function pillCloseButton(pill: MockElement): MockElement {
    return pill.childList.find((c: MockElement) =>
      c.getAttribute("aria-label") === "Dismiss",
    )!;
  }

  function appendMessage(box: MockScrollBox, id: string): MockElement {
    const el = new MockElement("div");
    el.setAttribute("data-bubble", id);
    box.appendChild(el);
    return el;
  }

  function findDivider(box: MockScrollBox): MockElement | null {
    return (
      box.childList.find((c) =>
        c.className.includes(UNREAD_DIVIDER_CSS_CLASS),
      ) || null
    );
  }
  function findPill(box: MockScrollBox): MockElement | null {
    return (
      box.childList.find((c) =>
        c.className.includes(UNREAD_JUMP_PILL_CSS_CLASS),
      ) || null
    );
  }

  it("no divider when the message arrives at the bottom (auto-follow)", () => {
    const { box, handle } = mount(0);
    const el = appendMessage(box, "m1");
    handle.messageAppended("m1", el);
    assert.equal(findDivider(box), null);
    assert.equal(findPill(box), null);
  });

  it("divider is inserted BEFORE the first unread message, pill counts up", () => {
    const { box, handle } = mount(300);
    const m1 = appendMessage(box, "m1");
    handle.messageAppended("m1", m1);
    const m2 = appendMessage(box, "m2");
    handle.messageAppended("m2", m2);

    const divider = findDivider(box);
    assert.ok(divider, "divider must exist");
    assert.equal(divider!.getAttribute("data-rowid"), "unread-divider:m1");
    const idxDivider = box.childList.indexOf(divider!);
    const idxM1 = box.childList.indexOf(m1);
    const idxM2 = box.childList.indexOf(m2);
    assert.ok(
      idxDivider < idxM1 && idxM1 < idxM2,
      "divider must precede the first unread message",
    );

    const pill = findPill(box);
    assert.ok(pill, "pill must exist");
    assert.equal(pillLabelText(pill!), "2 New Messages");
    assert.equal(pill!.getAttribute("data-direction"), "below");
  });

  it("pill click jumps and clears divider + pill", () => {
    const t = mount(300);
    const m1 = appendMessage(t.box, "m1");
    t.handle.messageAppended("m1", m1);
    const pill = findPill(t.box);
    assert.ok(pill);
    pill!.click();
    assert.equal(t.wasJumped(), true);
    assert.equal(findDivider(t.box), null);
    assert.equal(findPill(t.box), null);
    assert.equal(t.handle.state.visible, false);
  });

  it("scroll listener: scrolling to the bottom clears the marker", () => {
    const t = mount(300);
    const m1 = appendMessage(t.box, "m1");
    t.handle.messageAppended("m1", m1);
    assert.ok(findDivider(t.box));
    // user scrolls down to the bottom
    t.box.scrollTop = t.box.scrollHeight - t.box.clientHeight;
    t.box.fire("scroll");
    assert.equal(findDivider(t.box), null);
    assert.equal(findPill(t.box), null);
  });

  it("injects the stylesheet exactly once", () => {
    const t = mount(0);
    const styles = t.doc.head.childList.filter(
      (c) => c.getAttribute("data-ide-unread-divider-css") !== null,
    );
    assert.equal(styles.length, 1);
  });

  it("destroy() removes nodes and the scroll listener", () => {
    const t = mount(300);
    const m1 = appendMessage(t.box, "m1");
    t.handle.messageAppended("m1", m1);
    assert.ok(findDivider(t.box));
    assert.equal(t.box.scrollListeners(), 1);
    t.handle.destroy();
    assert.equal(findDivider(t.box), null);
    assert.equal(findPill(t.box), null);
    assert.equal(t.box.scrollListeners(), 0);
    // post-destroy calls are ignored
    t.handle.messageAppended("m2", appendMessage(t.box, "m2"));
    assert.equal(findDivider(t.box), null);
  });

  it("pill X dismisses the pill but keeps the divider (below-dismiss)", () => {
    const t = mount(300);
    const m1 = appendMessage(t.box, "m1");
    t.handle.messageAppended("m1", m1);
    const pill = findPill(t.box);
    assert.ok(pill);
    pillCloseButton(pill!).click();
    assert.equal(findPill(t.box), null, "pill hidden");
    assert.ok(findDivider(t.box), "divider stays (Cursor below-dismiss)");
    assert.equal(t.handle.state.visible, true);
    assert.equal(t.wasJumped(), false);
  });

  it("direction 'above': divider scrolled above viewport flips the pill; jump reveals the divider", () => {
    let revealed = 0;
    const viewport: UnreadDividerViewport = {
      isDividerAbove: () => true,
      revealDivider: () => {
        revealed += 1;
      },
    };
    const t = mount(300, { viewport });
    const m1 = appendMessage(t.box, "m1");
    t.handle.messageAppended("m1", m1);
    // user scrolls down past the divider (but not to the bottom)
    t.box.scrollTop = 100;
    t.box.fire("scroll");
    const pill = findPill(t.box);
    assert.ok(pill, "pill still visible");
    assert.equal(pill!.getAttribute("data-direction"), "above");
    pill!.click();
    assert.equal(revealed, 1, "jump reveals the divider row");
    assert.ok(findDivider(t.box), "marker stays (Cursor above-jump)");
    assert.equal(t.wasJumped(), false);
  });

  it("clear() dismisses without a jump", () => {
    const t = mount(300);
    const m1 = appendMessage(t.box, "m1");
    t.handle.messageAppended("m1", m1);
    t.handle.clear();
    assert.equal(findDivider(t.box), null);
    assert.equal(findPill(t.box), null);
    assert.equal(t.wasJumped(), false);
  });
});

describe("unreadDividerWebviewScript — serialization constraints + evidence tokens", () => {
  it("contains no backticks or ${ (composer.ts template-literal safety)", () => {
    const src = unreadDividerWebviewScript();
    assert.ok(!src.includes("`"), "no backticks allowed");
    assert.ok(!src.includes("${"), "no ${ allowed");
    assert.ok(
      src.includes("ideMountUnreadDivider"),
      "installs ideMountUnreadDivider on globalThis",
    );
  });

  it("carries the evidence tokens verbatim", () => {
    const src = unreadDividerWebviewScript();
    for (const token of [
      "unread-divider:", // rowId prefix
      "agent-transcript-row-unread-divider", // divider CSS class
      "project-unread-divider", // inner component
      "1 New Message", // nls one
      "New Messages", // nls many
      "unread-jump-pill", // pill data-component
      "arrow-up", // direction icon names
      "arrow-down",
      "New", // divider label words
      "messages below",
    ]) {
      assert.ok(src.includes(token), "webview script must contain " + token);
    }
  });
});
