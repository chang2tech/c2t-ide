/**
 * composer-unread-divider — Transcript unread divider + "N New Message(s)" jump pill.
 *
 * BINARY EVIDENCE (Cursor 3.25.9, workbench.glass.main.js — re-verified 2026-10-20):
 *   - transcript row kind:      'unreadDivider' (row height 28px: `case"unreadDivider":return NAa` with NAa=28)
 *   - rowId format:             'unread-divider:<bubbleId>' (R0S: {kind:"unreadDivider",rowId:`unread-divider:${e}`})
 *   - divider CSS class:        'agent-transcript-row-unread-divider'
 *   - divider inner component:  data-component="project-unread-divider", label "New" + " messages below"
 *                               (function Lgp: children ["New", span " messages below"], aria-hidden side rules)
 *   - nls pill keys:            'glass.unreadJumpPill.one'  -> "1 New Message"
 *                               'glass.unreadJumpPill.many' -> "{0} New Messages"
 *   - pill label logic (UKT):   count===1 -> "1 New Message";
 *                               count>30 -> "30+ New Messages" (iNc=30);
 *                               else -> "<count> New Messages"
 *   - pill props (jKT):         {direction, count, onJump, onDismiss};
 *                               direction==="above" -> icon "arrow-up" else "arrow-down";
 *                               data-component="unread-jump-pill", data-direction=<direction>
 *   - pill computation (use-conversation-unread.react.js, function zxT):
 *         below: unread incoming messages arrived after the user scrolled up
 *                (me>0 -> {direction:"below", count:me, jump:scrollToBottom, dismiss:markCursorRead})
 *         above: the unread divider row is currently ABOVE the viewport
 *                (Te -> {direction:"above", count:A(total unread), jump:scrollDividerIntoViewStart,
 *                       dismiss:markAgentRead})
 *         The divider rowId doubles as the scroll target: pxT returns
 *         `unread-divider:<id>` when the divider placement is "above".
 *   - No unreadBubbleId field exists anywhere in the transcript rows.
 *
 * Behavior: while the user is scrolled up (not following the bottom), each
 * newly appended message is counted as unread; a divider row ("New messages
 * below") marks the boundary at the first unread message and a floating
 * "N New Messages" pill jumps back to the newest message (clearing both).
 * If the user scrolls down past the divider without reaching the bottom, the
 * pill flips to direction "above" (arrow-up) and jumps back up to the divider.
 *
 * DOM contract: the TS module below never touches `document` globals — it
 * renders through tiny structural interfaces (MiniDocument/MiniElement) so the
 * logic is unit-testable with a minimal mock. A real `document`/`HTMLElement`
 * satisfies them structurally. The webview half (__unreadDividerBrowserImpl,
 * serialized via unreadDividerWebviewScript() following the
 * markdownTableService precedent) mirrors this logic in vanilla JS against the
 * real DOM.
 *
 * Anything NOT covered by the binary evidence is marked UNKNOWN below.
 */

/** Evidence: rowId format 'unread-divider:<id>' (R0S). */
export const UNREAD_DIVIDER_ROW_ID_PREFIX = "unread-divider:";
/** Evidence: CSS class 'agent-transcript-row-unread-divider'. */
export const UNREAD_DIVIDER_CSS_CLASS = "agent-transcript-row-unread-divider";
/** Evidence: inner divider component data-component="project-unread-divider" (Lgp). */
export const UNREAD_DIVIDER_COMPONENT = "project-unread-divider";
/** Evidence: divider row height 28px (NAa=28). */
export const UNREAD_DIVIDER_ROW_HEIGHT_PX = 28;
/** Evidence: divider label text — "New" + " messages below" (Lgp). */
export const UNREAD_DIVIDER_LABEL_NEW = "New";
export const UNREAD_DIVIDER_LABEL_SUFFIX = " messages below";
/** Evidence: nls key 'glass.unreadJumpPill.one' -> "1 New Message". */
export const UNREAD_JUMP_PILL_NLS_ONE = "glass.unreadJumpPill.one";
export const UNREAD_JUMP_PILL_ONE_TEXT = "1 New Message";
/** Evidence: nls key 'glass.unreadJumpPill.many' -> "{0} New Messages". */
export const UNREAD_JUMP_PILL_NLS_MANY = "glass.unreadJumpPill.many";
export const UNREAD_JUMP_PILL_MANY_TEXT = "{0} New Messages";
/** Evidence: pill count cap iNc=30 — counts above render as "30+". */
export const UNREAD_JUMP_PILL_CAP = 30;
/** Evidence: transcript row kind 'unreadDivider'. */
export type UnreadDividerRowKind = "unreadDivider";
/** Evidence: pill directions — "above" renders icon "arrow-up", else "arrow-down" (jKT). */
export type UnreadDividerDirection = "above" | "below";
/** Evidence: Cursor icon names used by the pill per direction (jKT). */
export const UNREAD_JUMP_PILL_ICON_ABOVE = "arrow-up";
export const UNREAD_JUMP_PILL_ICON_BELOW = "arrow-down";

/** UNKNOWN: Cursor's real pill CSS class was not in the dissected evidence — local name. */
export const UNREAD_JUMP_PILL_CSS_CLASS = "ide-unread-jump-pill";
/** UNKNOWN: Cursor's divider line inner markup was not in the dissected evidence — local name. */
export const UNREAD_DIVIDER_LINE_CSS_CLASS = "ide-unread-divider-line";
/** UNKNOWN: Cursor's divider label markup — local name (evidence: text "New messages below"). */
export const UNREAD_DIVIDER_LABEL_CSS_CLASS = "ide-unread-divider-label";
/** UNKNOWN: Cursor's pill arrow/close markup — local names (evidence: icon names + onClose). */
export const UNREAD_JUMP_PILL_ARROW_CSS_CLASS = "ide-unread-jump-pill-arrow";
export const UNREAD_JUMP_PILL_LABEL_CSS_CLASS = "ide-unread-jump-pill-label";
export const UNREAD_JUMP_PILL_CLOSE_CSS_CLASS = "ide-unread-jump-pill-close";

/** Transcript-row descriptor matching Cursor's row shape (kind + rowId). */
export interface UnreadDividerRow {
  kind: UnreadDividerRowKind;
  /** 'unread-divider:<id>' — evidence format, NOT a bubbleId. */
  rowId: string;
}

export function makeUnreadDividerRow(id: string): UnreadDividerRow {
  return { kind: "unreadDivider", rowId: UNREAD_DIVIDER_ROW_ID_PREFIX + id };
}

/**
 * Pill label. Evidence (UKT, iNc=30):
 *   count === 1  -> "1 New Message"
 *   count > 30   -> "30+ New Messages"
 *   otherwise    -> "<count> New Messages"
 */
export function unreadJumpPillLabel(count: number): string {
  if (count === 1) {
    return UNREAD_JUMP_PILL_ONE_TEXT;
  }
  const shown =
    count > UNREAD_JUMP_PILL_CAP
      ? UNREAD_JUMP_PILL_CAP + "+"
      : String(count);
  return shown + " New Messages";
}

/** Same near-bottom threshold the composer uses for its auto-follow (48px). */
export const UNREAD_NEAR_BOTTOM_PX = 48;

/**
 * Pure unread state: no DOM. `gapPx` = scrollHeight - scrollTop - clientHeight
 * of the transcript container at the moment of the event.
 *
 * Direction mirrors Cursor's use-conversation-unread hook: "below" while new
 * messages keep arriving under a scrolled-up viewport; "above" once the
 * divider row itself has scrolled above the viewport (the mount recomputes it
 * from live geometry via UnreadDividerViewport).
 */
export class UnreadDividerState {
  private anchorId: string | null = null;
  private unreadCount = 0;
  private pillHidden = false;
  private dir: UnreadDividerDirection = "below";
  private nearBottomPx: number;

  constructor(nearBottomPx = UNREAD_NEAR_BOTTOM_PX) {
    this.nearBottomPx = nearBottomPx;
  }

  /** A new message row was appended while the container sat at `gapPx`. */
  onMessageAppended(id: string, gapPx: number): void {
    if (gapPx < this.nearBottomPx) {
      // User was following the bottom: the message is seen, no divider.
      this.clear();
      return;
    }
    if (this.anchorId === null) {
      this.anchorId = id;
    }
    this.unreadCount += 1;
    this.pillHidden = false;
    this.dir = "below";
  }

  /** The user scrolled; reaching the bottom dismisses the unread marker. */
  onScrolled(gapPx: number): void {
    if (gapPx < this.nearBottomPx) {
      this.clear();
    }
  }

  /** The divider row scrolled above the viewport: pill flips to "above". */
  onDividerAboveViewport(above: boolean): void {
    if (this.anchorId !== null) {
      this.dir = above ? "above" : "below";
    }
  }

  /**
   * The pill's main action. "below" -> jump to newest (clears the marker;
   * Cursor: scrollToBottom). "above" -> reveal the divider row (Cursor:
   * scrollToTranscriptRow(dividerRowId, {align:"start"})); the marker stays
   * until the user reaches the bottom or dismisses it.
   * Returns "bottom" | "divider" so the host knows what to scroll to.
   */
  onJump(): "bottom" | "divider" {
    if (this.dir === "above") {
      return "divider";
    }
    this.clear();
    return "bottom";
  }

  /**
   * The pill's X (Cursor: onDismiss/onClose). Below-dismiss keeps the divider
   * row but hides the pill (Cursor: cursor advances to latest, me -> 0).
   * Above-dismiss clears everything (Cursor: markAgentRead).
   */
  onDismiss(): void {
    if (this.dir === "above") {
      this.clear();
    } else {
      this.pillHidden = true;
    }
  }

  clear(): void {
    this.anchorId = null;
    this.unreadCount = 0;
    this.pillHidden = false;
    this.dir = "below";
  }

  get visible(): boolean {
    return this.anchorId !== null;
  }

  get pillVisible(): boolean {
    return this.anchorId !== null && !this.pillHidden;
  }

  get anchor(): string | null {
    return this.anchorId;
  }

  get count(): number {
    return this.unreadCount;
  }

  get direction(): UnreadDividerDirection {
    return this.dir;
  }

  /** 'unread-divider:<anchorId>' — evidence rowId format. */
  rowId(): string | null {
    return this.anchorId === null
      ? null
      : UNREAD_DIVIDER_ROW_ID_PREFIX + this.anchorId;
  }

  /** Evidence pill text via unreadJumpPillLabel. */
  jumpLabel(): string {
    return unreadJumpPillLabel(this.unreadCount);
  }
}

/* ------------------------------------------------------------------ */
/* Minimal DOM surface — satisfied structurally by real DOM and mocks.  */
/* ------------------------------------------------------------------ */

export interface MiniElement {
  className: string;
  textContent: string | null;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  appendChild(child: any): any;
  insertBefore(child: any, ref: any): any;
  remove(): void;
  addEventListener(type: string, listener: (...args: any[]) => void): void;
  removeEventListener(type: string, listener: (...args: any[]) => void): void;
  parentNode: any;
  readonly children: any;
}

export interface MiniDocument {
  createElement(tagName: string): MiniElement;
  head: MiniElement;
}

/** Transcript scroll container: an element exposing scroll metrics. */
export interface MiniScrollBox extends MiniElement {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/**
 * Viewport geometry hooks the pure state cannot compute. The webview
 * implements these against the real DOM (getBoundingClientRect /
 * scrollIntoView); tests may omit them (direction stays "below").
 */
export interface UnreadDividerViewport {
  /** True when the divider row is currently scrolled above the visible viewport. */
  isDividerAbove(dividerEl: MiniElement): boolean;
  /** Scroll the divider row into view near the top (Cursor: align "start"). */
  revealDivider(dividerEl: MiniElement): void;
}

function containerGap(box: MiniScrollBox): number {
  return box.scrollHeight - box.scrollTop - box.clientHeight;
}

/** Injected stylesheet (scoped, idempotent). Visuals are local; only the
 * divider class name, the "New messages below" text, and the pill label come
 * from evidence. */
function ensureCss(doc: MiniDocument): void {
  const head: any = doc.head;
  if (
    head &&
    typeof head.querySelector === "function" &&
    head.querySelector("[data-ide-unread-divider-css]")
  ) {
    return;
  }
  const style = doc.createElement("style");
  style.setAttribute("data-ide-unread-divider-css", "1");
  style.textContent =
    `.${UNREAD_DIVIDER_CSS_CLASS}{display:flex;align-items:center;gap:8px;margin:2px 0;` +
    `min-height:${UNREAD_DIVIDER_ROW_HEIGHT_PX}px;}` +
    `.${UNREAD_DIVIDER_CSS_CLASS} .${UNREAD_DIVIDER_LINE_CSS_CLASS}{flex:1;border-top:1px solid var(--vscode-editorWidget-border,rgba(128,128,128,.35));}` +
    `.${UNREAD_DIVIDER_CSS_CLASS} .${UNREAD_DIVIDER_LABEL_CSS_CLASS}{font-size:11px;color:var(--vscode-descriptionForeground);white-space:nowrap;}` +
    `.${UNREAD_JUMP_PILL_CSS_CLASS}{position:sticky;bottom:12px;align-self:center;z-index:5;` +
    `display:inline-flex;align-items:center;gap:6px;` +
    `padding:4px 8px 4px 12px;border-radius:999px;border:1px solid var(--vscode-button-border,transparent);` +
    `background:var(--vscode-button-background);color:var(--vscode-button-foreground);` +
    `font-size:12px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.25);white-space:nowrap;}` +
    `.${UNREAD_JUMP_PILL_CSS_CLASS}:hover{background:var(--vscode-button-hoverBackground);}` +
    `.${UNREAD_JUMP_PILL_CSS_CLASS} .${UNREAD_JUMP_PILL_ARROW_CSS_CLASS}{display:inline-flex;line-height:1;}` +
    `.${UNREAD_JUMP_PILL_CSS_CLASS} .${UNREAD_JUMP_PILL_CLOSE_CSS_CLASS}{` +
    `background:transparent;border:0;color:inherit;cursor:pointer;font-size:12px;line-height:1;` +
    `padding:2px 4px;border-radius:4px;}` +
    `.${UNREAD_JUMP_PILL_CSS_CLASS} .${UNREAD_JUMP_PILL_CLOSE_CSS_CLASS}:hover{` +
    `background:var(--vscode-toolbar-hoverBackground,rgba(128,128,128,.2));}`;
  if (head && typeof head.appendChild === "function") {
    head.appendChild(style);
  }
}

/**
 * Divider row. Evidence: class 'agent-transcript-row-unread-divider', inner
 * data-component="project-unread-divider" with label "New" + " messages below"
 * between two aria-hidden rules (Lgp).
 */
export function buildUnreadDividerRow(
  doc: MiniDocument,
  rowId: string,
): MiniElement {
  const row = doc.createElement("div");
  row.className = UNREAD_DIVIDER_CSS_CLASS;
  row.setAttribute("data-rowid", rowId);
  row.setAttribute("role", "separator");
  row.setAttribute("aria-label", "Unread messages");
  const inner = doc.createElement("div");
  inner.className = UNREAD_DIVIDER_CSS_CLASS + "-inner";
  inner.setAttribute("data-component", UNREAD_DIVIDER_COMPONENT);
  inner.setAttribute("style", "display:flex;align-items:center;gap:8px;width:100%;");
  const rule1 = doc.createElement("span");
  rule1.className = UNREAD_DIVIDER_LINE_CSS_CLASS;
  rule1.setAttribute("aria-hidden", "true");
  const label = doc.createElement("span");
  label.className = UNREAD_DIVIDER_LABEL_CSS_CLASS;
  const newWord = doc.createElement("span");
  newWord.textContent = UNREAD_DIVIDER_LABEL_NEW;
  const rest = doc.createElement("span");
  rest.textContent = UNREAD_DIVIDER_LABEL_SUFFIX;
  label.appendChild(newWord);
  label.appendChild(rest);
  const rule2 = doc.createElement("span");
  rule2.className = UNREAD_DIVIDER_LINE_CSS_CLASS;
  rule2.setAttribute("aria-hidden", "true");
  inner.appendChild(rule1);
  inner.appendChild(label);
  inner.appendChild(rule2);
  row.appendChild(inner);
  return row;
}

/**
 * Jump pill. Evidence: data-component="unread-jump-pill",
 * data-direction=<direction>, icon "arrow-up" for "above" else "arrow-down"
 * (jKT), label from the unreadJumpPill nls strings, and an onClose affordance
 * (DD onClose). The arrow glyph is local rendering; the data-icon attribute
 * carries Cursor's verbatim icon name.
 */
export function buildUnreadJumpPill(
  doc: MiniDocument,
  label: string,
  direction: UnreadDividerDirection,
  onJump: () => void,
  onDismiss: () => void,
): MiniElement {
  const pill = doc.createElement("button");
  pill.className = UNREAD_JUMP_PILL_CSS_CLASS;
  pill.setAttribute("type", "button");
  pill.setAttribute("data-component", "unread-jump-pill");
  pill.setAttribute("data-direction", direction);
  const arrow = doc.createElement("span");
  arrow.className = UNREAD_JUMP_PILL_ARROW_CSS_CLASS;
  arrow.setAttribute(
    "data-icon",
    direction === "above"
      ? UNREAD_JUMP_PILL_ICON_ABOVE
      : UNREAD_JUMP_PILL_ICON_BELOW,
  );
  arrow.setAttribute("aria-hidden", "true");
  arrow.textContent = direction === "above" ? "\u2191" : "\u2193";
  const text = doc.createElement("span");
  text.className = UNREAD_JUMP_PILL_LABEL_CSS_CLASS;
  text.textContent = label;
  const close = doc.createElement("button");
  close.className = UNREAD_JUMP_PILL_CLOSE_CSS_CLASS;
  close.setAttribute("type", "button");
  close.setAttribute("aria-label", "Dismiss");
  close.textContent = "\u00d7";
  close.addEventListener("click", function (e: any) {
    if (e && typeof e.stopPropagation === "function") {
      e.stopPropagation();
    }
    onDismiss();
  });
  pill.appendChild(arrow);
  pill.appendChild(text);
  pill.appendChild(close);
  pill.addEventListener("click", onJump);
  return pill;
}

export interface UnreadDividerMountOptions {
  /** Real `document`, or a MiniDocument mock in tests. */
  doc: MiniDocument;
  /** The transcript scroll container (composer's #messages). */
  messagesEl: MiniScrollBox;
  /**
   * Custom jump behavior for the "below" direction. Default: scroll the
   * container to the bottom (Cursor's pill jumps to the newest message).
   */
  onJump?: () => void;
  /** Viewport geometry hooks (direction "above" support). Omit in tests. */
  viewport?: UnreadDividerViewport;
  nearBottomPx?: number;
}

export interface UnreadDividerHandle {
  readonly state: UnreadDividerState;
  /**
   * Notify that a new message row was appended. Pass the row's element so the
   * divider can be inserted directly before the first unread message.
   * `gapPx` overrides the live scroll metrics (tests); when omitted the
   * current container metrics are read.
   */
  messageAppended(anchorId: string, newMessageEl?: any, gapPx?: number): void;
  /** Dismiss the pill only (divider stays) — Cursor's below-dismiss. */
  dismissPill(): void;
  /** Dismiss the divider + pill (e.g. user reached the bottom another way). */
  clear(): void;
  /** Remove divider, pill, CSS guard and listeners. */
  destroy(): void;
}

/**
 * Mount the unread divider + jump pill onto a transcript container.
 *
 * Wiring (composer.ts — NOT done here): call `messageAppended(bubbleId, el)`
 * in patchBubble's new-bubble branch right after the bubble element is
 * appended to #messages. The module decides from live scroll metrics whether
 * the user was following the bottom (no divider) or scrolled up (divider).
 */
export function mountUnreadDivider(
  opts: UnreadDividerMountOptions,
): UnreadDividerHandle {
  const { doc, messagesEl, viewport } = opts;
  const state = new UnreadDividerState(opts.nearBottomPx);
  ensureCss(doc);

  let dividerEl: MiniElement | null = null;
  let pillEl: MiniElement | null = null;
  let destroyed = false;

  function removeDivider(): void {
    if (dividerEl) {
      dividerEl.remove();
      dividerEl = null;
    }
  }

  function removePill(): void {
    if (pillEl) {
      pillEl.remove();
      pillEl = null;
    }
  }

  function removeNodes(): void {
    removeDivider();
    removePill();
  }

  function jump(): void {
    if (destroyed) {
      return;
    }
    const target = state.onJump();
    if (target === "divider") {
      // "above": reveal the divider row; the marker stays.
      if (viewport && dividerEl) {
        viewport.revealDivider(dividerEl);
      }
      return;
    }
    removeNodes();
    if (opts.onJump) {
      opts.onJump();
    } else {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  }

  function dismiss(): void {
    if (destroyed) {
      return;
    }
    state.onDismiss();
    if (!state.visible) {
      removeNodes();
    } else {
      removePill();
    }
  }

  function refreshPill(): void {
    if (!state.pillVisible) {
      removePill();
      return;
    }
    if (!pillEl) {
      pillEl = buildUnreadJumpPill(
        doc,
        state.jumpLabel(),
        state.direction,
        jump,
        dismiss,
      );
      messagesEl.appendChild(pillEl);
    } else {
      const wantDir = state.direction;
      if (pillEl.getAttribute("data-direction") !== wantDir) {
        // Direction flipped (divider scrolled above the viewport): rebuild
        // so the arrow + data-direction match Cursor's jKT rendering.
        removePill();
        pillEl = buildUnreadJumpPill(
          doc,
          state.jumpLabel(),
          state.direction,
          jump,
          dismiss,
        );
        messagesEl.appendChild(pillEl);
        return;
      }
      const labelEl = findChildByClass(pillEl, UNREAD_JUMP_PILL_LABEL_CSS_CLASS);
      if (labelEl) {
        labelEl.textContent = state.jumpLabel();
      } else {
        pillEl.textContent = state.jumpLabel();
      }
    }
  }

  function findChildByClass(
    parent: MiniElement,
    cls: string,
  ): MiniElement | null {
    const kids: any = parent.children;
    if (kids && typeof kids.length === "number") {
      for (let i = 0; i < kids.length; i++) {
        const k: MiniElement = kids[i];
        if (k && typeof k.className === "string" && k.className.indexOf(cls) !== -1) {
          return k;
        }
      }
    }
    return null;
  }

  function onScroll(): void {
    if (destroyed) {
      return;
    }
    const wasVisible = state.visible;
    state.onScrolled(containerGap(messagesEl));
    if (!state.visible) {
      if (wasVisible) {
        removeNodes();
      }
      return;
    }
    // Cursor's pxT: when the divider row sits above the viewport, the pill
    // flips to direction "above" (arrow-up, jumps back up to the divider).
    if (viewport && dividerEl) {
      state.onDividerAboveViewport(viewport.isDividerAbove(dividerEl));
    }
    refreshPill();
  }
  messagesEl.addEventListener("scroll", onScroll);

  const handle: UnreadDividerHandle = {
    state,
    messageAppended(anchorId: string, newMessageEl?: any, gapPx?: number): void {
      if (destroyed) {
        return;
      }
      const gap = gapPx === undefined ? containerGap(messagesEl) : gapPx;
      const wasVisible = state.visible;
      state.onMessageAppended(anchorId, gap);
      if (!state.visible) {
        // User was at the bottom — auto-follow handled the message; make
        // sure no stale marker lingers.
        if (wasVisible) {
          removeNodes();
        }
        return;
      }
      if (!dividerEl) {
        const rowId = state.rowId();
        dividerEl = buildUnreadDividerRow(doc, rowId === null ? "" : rowId);
        if (
          newMessageEl &&
          newMessageEl.parentNode === (messagesEl as unknown as MiniElement)
        ) {
          messagesEl.insertBefore(dividerEl, newMessageEl);
        } else {
          // Fallback (host did not hand the row element): marker lands at the
          // end; positioning precision is UNKNOWN without the anchor element.
          messagesEl.appendChild(dividerEl);
        }
      }
      refreshPill();
    },
    dismissPill(): void {
      dismiss();
    },
    clear(): void {
      state.clear();
      removeNodes();
    },
    destroy(): void {
      destroyed = true;
      removeNodes();
      messagesEl.removeEventListener("scroll", onScroll);
    },
  };
  return handle;
}

/* ------------------------------------------------------------------ */
/* Webview half — serialized into the composer webview <script>.        */
/*                                                                     */
/* Follows the markdownTableService precedent: authored as a real TS   */
/* function (tsc-checked), serialized with Function.prototype.toString */
/* by unreadDividerWebviewScript(). Constraints (guarded by unit       */
/* tests): no imports, no backticks, no "${" (it is interpolated into  */
/* composer.ts's webview <script> template literal), no TS-only emit   */
/* (enums, parameter properties). It installs `ideMountUnreadDivider`  */
/* on globalThis.                                                      */
/* ------------------------------------------------------------------ */

function __unreadDividerBrowserImpl(): void {
  /* composer-unread-divider — browser half (vanilla JS, real DOM). */
  var ROW_ID_PREFIX = "unread-divider:";
  var ROW_CSS = "agent-transcript-row-unread-divider";
  var ROW_COMPONENT = "project-unread-divider";
  var ROW_HEIGHT_PX = 28;
  var LABEL_NEW = "New";
  var LABEL_SUFFIX = " messages below";
  var PILL_CSS = "ide-unread-jump-pill";
  var LINE_CSS = "ide-unread-divider-line";
  var LABEL_CSS = "ide-unread-divider-label";
  var ARROW_CSS = "ide-unread-jump-pill-arrow";
  var PLABEL_CSS = "ide-unread-jump-pill-label";
  var PCLOSE_CSS = "ide-unread-jump-pill-close";
  var PILL_CAP = 30;
  var NEAR_BOTTOM_PX = 48;
  var CSS_GUARD = "data-ide-unread-divider-css";
  var ARROW_UP_SVG =
    '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" ' +
    'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M8 13V3"/><path d="M3.5 7.5 8 3l4.5 4.5"/></svg>';
  var ARROW_DOWN_SVG =
    '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" ' +
    'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M8 3v10"/><path d="M3.5 8.5 8 13l4.5-4.5"/></svg>';

  function pillLabel(count: number): string {
    // Evidence (UKT, iNc=30): 1 -> "1 New Message"; >30 -> "30+ New Messages".
    if (count === 1) {
      return "1 New Message";
    }
    return (count > PILL_CAP ? PILL_CAP + "+" : String(count)) + " New Messages";
  }

  function gapOf(box: any): number {
    return box.scrollHeight - box.scrollTop - box.clientHeight;
  }

  function ensureCss(doc: any): void {
    if (doc.querySelector("[" + CSS_GUARD + "]")) {
      return;
    }
    var style = doc.createElement("style");
    style.setAttribute(CSS_GUARD, "1");
    style.textContent =
      "." + ROW_CSS + "{display:flex;align-items:center;gap:8px;margin:2px 0;min-height:" + ROW_HEIGHT_PX + "px;}" +
      "." + ROW_CSS + " ." + LINE_CSS + "{flex:1;border-top:1px solid var(--vscode-editorWidget-border,rgba(128,128,128,.35));}" +
      "." + ROW_CSS + " ." + LABEL_CSS + "{font-size:11px;color:var(--vscode-descriptionForeground);white-space:nowrap;}" +
      "." + PILL_CSS + "{position:sticky;bottom:12px;align-self:center;z-index:5;display:inline-flex;align-items:center;gap:6px;" +
      "padding:4px 8px 4px 12px;border-radius:999px;border:1px solid var(--vscode-button-border,transparent);" +
      "background:var(--vscode-button-background);color:var(--vscode-button-foreground);" +
      "font-size:12px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.25);white-space:nowrap;}" +
      "." + PILL_CSS + ":hover{background:var(--vscode-button-hoverBackground);}" +
      "." + PILL_CSS + " ." + ARROW_CSS + "{display:inline-flex;line-height:1;}" +
      "." + PILL_CSS + " ." + PCLOSE_CSS + "{background:transparent;border:0;color:inherit;cursor:pointer;font-size:12px;line-height:1;padding:2px 4px;border-radius:4px;}" +
      "." + PILL_CSS + " ." + PCLOSE_CSS + ":hover{background:var(--vscode-toolbar-hoverBackground,rgba(128,128,128,.2));}";
    // Real webview documents always have <head>; guard keeps vm-based tests
    // with minimal fake DOMs (and any headless host) from throwing.
    var head = doc.head;
    if (head && typeof head.appendChild === "function") {
      head.appendChild(style);
    }
  }

  function buildDividerRow(doc: any, rowId: string): any {
    var row = doc.createElement("div");
    row.className = ROW_CSS;
    row.setAttribute("data-rowid", rowId);
    row.setAttribute("role", "separator");
    row.setAttribute("aria-label", "Unread messages");
    var inner = doc.createElement("div");
    inner.setAttribute("data-component", ROW_COMPONENT);
    inner.setAttribute("style", "display:flex;align-items:center;gap:8px;width:100%;");
    var rule1 = doc.createElement("span");
    rule1.className = LINE_CSS;
    rule1.setAttribute("aria-hidden", "true");
    var label = doc.createElement("span");
    label.className = LABEL_CSS;
    var newWord = doc.createElement("span");
    newWord.textContent = LABEL_NEW;
    var rest = doc.createElement("span");
    rest.textContent = LABEL_SUFFIX;
    label.appendChild(newWord);
    label.appendChild(rest);
    var rule2 = doc.createElement("span");
    rule2.className = LINE_CSS;
    rule2.setAttribute("aria-hidden", "true");
    inner.appendChild(rule1);
    inner.appendChild(label);
    inner.appendChild(rule2);
    row.appendChild(inner);
    return row;
  }

  function buildPill(
    doc: any,
    label: string,
    direction: string,
    onJump: () => void,
    onDismiss: () => void,
  ): any {
    var pill = doc.createElement("button");
    pill.className = PILL_CSS;
    pill.setAttribute("type", "button");
    pill.setAttribute("data-component", "unread-jump-pill");
    pill.setAttribute("data-direction", direction);
    var arrow = doc.createElement("span");
    arrow.className = ARROW_CSS;
    arrow.setAttribute(
      "data-icon",
      direction === "above" ? "arrow-up" : "arrow-down",
    );
    arrow.setAttribute("aria-hidden", "true");
    arrow.innerHTML = direction === "above" ? ARROW_UP_SVG : ARROW_DOWN_SVG;
    var text = doc.createElement("span");
    text.className = PLABEL_CSS;
    text.textContent = label;
    var close = doc.createElement("button");
    close.className = PCLOSE_CSS;
    close.setAttribute("type", "button");
    close.setAttribute("aria-label", "Dismiss");
    close.textContent = "\u00d7";
    close.addEventListener("click", function (e: any) {
      if (e && typeof e.stopPropagation === "function") {
        e.stopPropagation();
      }
      onDismiss();
    });
    pill.appendChild(arrow);
    pill.appendChild(text);
    pill.appendChild(close);
    pill.addEventListener("click", onJump);
    return pill;
  }

  function mount(messagesEl: any): any {
    var doc = messagesEl.ownerDocument || document;
    ensureCss(doc);
    var anchorId: string | null = null;
    var unreadCount = 0;
    var pillHidden = false;
    var direction = "below";
    var dividerEl: any = null;
    var pillEl: any = null;
    var destroyed = false;

    function removeDivider(): void {
      if (dividerEl) {
        dividerEl.remove();
        dividerEl = null;
      }
    }
    function removePill(): void {
      if (pillEl) {
        pillEl.remove();
        pillEl = null;
      }
    }
    function removeNodes(): void {
      removeDivider();
      removePill();
    }
    function clearState(): void {
      anchorId = null;
      unreadCount = 0;
      pillHidden = false;
      direction = "below";
    }
    function isDividerAbove(): boolean {
      if (!dividerEl) {
        return false;
      }
      var r = dividerEl.getBoundingClientRect();
      var c = messagesEl.getBoundingClientRect();
      return r.bottom < c.top;
    }
    function jump(): void {
      if (destroyed) {
        return;
      }
      if (direction === "above" && dividerEl) {
        // Cursor: scrollToTranscriptRow(dividerRowId, {align:"start"}).
        dividerEl.scrollIntoView({ block: "start", behavior: "smooth" });
        return;
      }
      clearState();
      removeNodes();
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
    function dismiss(): void {
      if (destroyed) {
        return;
      }
      if (direction === "above") {
        clearState();
        removeNodes();
      } else {
        // Cursor's below-dismiss: pill hides, divider row stays.
        pillHidden = true;
        removePill();
      }
    }
    function refreshPill(): void {
      var show = anchorId !== null && !pillHidden;
      if (!show) {
        removePill();
        return;
      }
      if (!pillEl) {
        pillEl = buildPill(doc, pillLabel(unreadCount), direction, jump, dismiss);
        messagesEl.appendChild(pillEl);
        return;
      }
      if (pillEl.getAttribute("data-direction") !== direction) {
        removePill();
        pillEl = buildPill(doc, pillLabel(unreadCount), direction, jump, dismiss);
        messagesEl.appendChild(pillEl);
        return;
      }
      var labelEl = pillEl.querySelector("." + PLABEL_CSS);
      if (labelEl) {
        labelEl.textContent = pillLabel(unreadCount);
      }
    }
    function onScroll(): void {
      if (destroyed) {
        return;
      }
      var wasVisible = anchorId !== null;
      if (gapOf(messagesEl) < NEAR_BOTTOM_PX) {
        if (wasVisible) {
          clearState();
          removeNodes();
        }
        return;
      }
      if (dividerEl) {
        direction = isDividerAbove() ? "above" : "below";
      }
      refreshPill();
    }
    messagesEl.addEventListener("scroll", onScroll);

    return {
      messageAppended: function (id: string, newMessageEl?: any): void {
        if (destroyed) {
          return;
        }
        var gap = gapOf(messagesEl);
        var wasVisible = anchorId !== null;
        if (gap < NEAR_BOTTOM_PX) {
          if (wasVisible) {
            clearState();
            removeNodes();
          }
          return;
        }
        if (anchorId === null) {
          anchorId = id;
        }
        unreadCount += 1;
        pillHidden = false;
        direction = "below";
        if (!dividerEl) {
          dividerEl = buildDividerRow(doc, ROW_ID_PREFIX + (anchorId as string));
          if (newMessageEl && newMessageEl.parentNode === messagesEl) {
            messagesEl.insertBefore(dividerEl, newMessageEl);
          } else {
            messagesEl.appendChild(dividerEl);
          }
        }
        refreshPill();
      },
      clear: function (): void {
        clearState();
        removeNodes();
      },
      destroy: function (): void {
        destroyed = true;
        removeNodes();
        messagesEl.removeEventListener("scroll", onScroll);
      },
    };
  }

  (globalThis as any).ideMountUnreadDivider = mount;
}

/**
 * The browser-side implementation as a runnable script string. The returned
 * source is the compiled __unreadDividerBrowserImpl plus an immediate
 * invocation that installs `ideMountUnreadDivider` on globalThis.
 */
export function unreadDividerWebviewScript(): string {
  return __unreadDividerBrowserImpl.toString() + "\n__unreadDividerBrowserImpl();";
}
