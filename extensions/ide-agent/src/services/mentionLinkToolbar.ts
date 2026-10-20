/**
 * Mention Link Toolbar — host-side service mirror + pure helpers
 * (GAPS-131, `mention-link-toolbar`).
 *
 * QA step 1 = CONFIRMED on Cursor 3.25.9 (full dissection in
 * docs/rea/work-notes-gaps131.md):
 *
 * - Command (workbench.desktop.main.js @40072383, glass @47717752):
 *     {id:"cursor.mentionLinkToolbar",
 *      title:{value:"Mention Link Toolbar",original:"Mention Link Toolbar"},
 *      f1:!1}
 *     async run(t,n,...i){ await t.get(m1).showMentionLinkToolbar(n) }
 *   `f1:!1` = palette-hidden; the command is only invoked
 *   programmatically, and run() AWAITS the service promise — it resolves
 *   when the toolbar closes.
 * - Service `uiOverlayService.js` (desk @2343463 state, @2345232/@2345349):
 *     this.mentionLinkToolbar = new vv(void 0)   // observable state
 *     showMentionLinkToolbar(e){ return this.mentionLinkToolbar.change(e),
 *       new Promise(t=>this._mentionLinkToolbarResolve=t) }
 *     closeMentionLinkToolbar(){ this._mentionLinkToolbarResolve &&
 *       (this._mentionLinkToolbarResolve(),
 *        this._mentionLinkToolbarResolve=void 0,
 *        this.mentionLinkToolbar.change(void 0)) }
 * - Call site (desk @24666605, glass @23452648): clicking a `.mention`
 *   whose `data-typeahead-type` is `link` in the Lexical composer input
 *   executes the command with
 *     {x: rect.left, y: rect.bottom + 2, link: data-mention-name,
 *      onRemove: () => { insertText(link); mentionNode.remove();
 *                        removeLink(key); focus() }}
 * - Toolbar UI (desk @40175362 + template @40171210 + desktop css
 *   @1240870): backdrop (fixed, z-index 100000, click closes) + toolbar
 *   (fixed, z-index 100001, top=y, left=x) with exactly two items whose
 *   labels are verbatim "Open" (Codicon linkExternal → openerService.open
 *   (link), then close) and "Unlink" (Codicon close → onRemove(), then
 *   close).
 * - Link mentions are born from pasting a URL (desk @24723930): a plain
 *   text paste with `supportsLink && !isMentionsMenuOpen() &&
 *   text.length < 2000 && isUrl(text)` becomes a link mention node plus
 *   `insertLink({url, uuid})` instead of raw text.
 *
 * Fork wiring (same layer shape as the Find-in-Chat / jump-messages
 * precedents, DEV-GAPS-29 / DEV-GAPS-119): the workbench-core Action2
 * lives in contrib/composer/browser/composerActions.ts under the
 * binary-verbatim id/title and delegates to the `ide.mentionLinkToolbar`
 * runtime command registered in extension.ts; the controller below
 * mirrors the binary service (state + Promise) and posts the show
 * message to the ACTIVE chat surface's webview via makeChatAttachHost().
 *
 * HONEST-DIVERGENCE (see work-notes-gaps131 Slice 2):
 *  D1 — Cursor renders the toolbar as a Solid component of the
 *       workbench `uiOverlayService`; this fork has no such core
 *       service and its chat surface is a webview, so the webview
 *       renders the verbatim toolbar DOM/CSS at the same fixed
 *       coordinates. User-visible behavior is identical.
 *  D2 — the binary's `onRemove` is an in-process Lexical closure passed
 *       as a command argument. Command arguments cannot carry closures
 *       across this fork's extension-host boundary, so the serializable
 *       payload carries the chip `uuid` instead; the webview (which owns
 *       the chips/input) performs the onRemove semantics on Unlink.
 *       GAPS-143 (NF-1, QA round 11): the binary overlay lives in the
 *       workbench uiOverlayService, independent of the composer
 *       surface's lifetime, so it can always be closed; the fork's
 *       toolbar DOM lives INSIDE a webview surface, so both hosts now
 *       close this controller on surface teardown — ChatViewProvider
 *       (extension.ts: `webviewView.onDidDispose` + the re-resolve path
 *       at the top of `resolveWebviewView`) and the editor-tab host
 *       (chatEditorProvider.ts: `ChatEditorHost.dispose()`, reached via
 *       `panel.onDidDispose`, + the re-resolve path in
 *       `resolveCustomEditor`). Teardown calls `closeMentionLinkToolbar()`
 *       with NO host (the surface is dead — posting a hide message to it
 *       would be wrong), which resolves the pending promise and clears
 *       `current`. RESIDUAL: this controller is a singleton shared by
 *       both surfaces, so a teardown/re-resolve of ANY surface closes a
 *       toolbar that may be displayed on the other surface; and the
 *       binary-verbatim second-show resolver overwrite (see the
 *       controller doc below) still leaks the overwritten promise by
 *       design — both are kept deliberately, not hidden.
 *  D3 — the binary's URL predicate for paste auto-parse is a shared
 *       minified helper whose exact rules are UNKNOWN; the fork uses
 *       "single token, URL-parseable, http:/https:" (see
 *       isAutoParseLinkText).
 *  D5 — activation guard (GAPS-143, NF-2, QA round 11). The binary
 *       (desk pre-@24666605) refuses to open the toolbar when the input
 *       is readonly, or when the input does not contain focus AND the
 *       mention is not `mention-clickable` AND the click is not in the
 *       remove region. Only the readonly leg maps onto the fork's
 *       webview model: the chip-label click handler in composer.ts does
 *       not post the request when the composer `<textarea id="input">`
 *       is `readOnly` or `disabled` (the element's real DOM properties;
 *       no fork code sets them today, so the guard is a no-op until a
 *       surface does — it is NOT a fabricated model flag). The other
 *       legs do NOT map 1-1 and are not silently dropped:
 *         - focus containment: binary mentions are inline Lexical nodes
 *           INSIDE the input, so "input contains document.activeElement"
 *           is meaningful; fork chips live in a separate chips row
 *           OUTSIDE the textarea (D4) and the label is not focusable, so
 *           applying the check literally would block virtually every
 *           legitimate chip click.
 *         - `mention-clickable`: fork chip labels are always rendered
 *           clickable (cursor:pointer + click handler for every chip),
 *           so this leg is always satisfied by construction.
 *         - remove region: the binary hit-tests a 14px region of the
 *           mention wrapper; the fork's remove control is a SEPARATE
 *           `×` button element with its own click handler
 *           (stopPropagation), so a label click can never fall inside
 *           the remove region.
 */

/* ------------------------------------------------------------------ */
/* Binary-verbatim ids, titles, labels and message types.              */
/* ------------------------------------------------------------------ */

/** Core command id (binary registration, desk @40072383). */
export const CURSOR_MENTION_LINK_TOOLBAR_ID = "cursor.mentionLinkToolbar";
/** Command title (binary-verbatim). */
export const MENTION_LINK_TOOLBAR_TITLE = "Mention Link Toolbar";
/** Runtime command the core Action2 delegates to (fork `ide.*` layer). */
export const IDE_MENTION_LINK_TOOLBAR_ID = "ide.mentionLinkToolbar";

/** Toolbar item labels (template euw, desk @40171210 — verbatim). */
export const MENTION_LINK_TOOLBAR_OPEN_LABEL = "Open";
export const MENTION_LINK_TOOLBAR_UNLINK_LABEL = "Unlink";

/** Webview → host: the webview asks the host to run the toolbar command
 *  (the fork's analog of the binary renderer's
 *  `commandService.executeCommand("cursor.mentionLinkToolbar", …)`). */
export const MENTION_LINK_TOOLBAR_REQUEST = "mentionLinkToolbar";
/** Host → webview: render the toolbar with this payload. */
export const SHOW_MENTION_LINK_TOOLBAR = "showMentionLinkToolbar";
/** Host → webview: hide the toolbar (external close). */
export const HIDE_MENTION_LINK_TOOLBAR = "hideMentionLinkToolbar";
/** Webview → host: user chose "Open" — open the link, then close. */
export const MENTION_LINK_TOOLBAR_OPEN = "mentionLinkToolbarOpen";
/** Webview → host: toolbar closed (backdrop click, Open, or Unlink) —
 *  resolves the pending show promise (binary closeMentionLinkToolbar). */
export const MENTION_LINK_TOOLBAR_CLOSE = "mentionLinkToolbarClose";

/** The binary positions the toolbar at `rect.bottom + 2` (desk @24666605). */
export const MENTION_LINK_TOOLBAR_Y_OFFSET_PX = 2;
/** Paste auto-parse cap: the binary requires `text.length < 2e3`. */
export const AUTO_PARSE_LINK_MAX_LENGTH = 2000;

/* ------------------------------------------------------------------ */
/* Payload.                                                            */
/* ------------------------------------------------------------------ */

/**
 * Serializable toolbar payload. The binary's shape is
 * `{x, y, link, onRemove}`; per divergence D2 the fork carries the
 * chip `uuid` in place of the `onRemove` closure.
 */
export interface MentionLinkToolbarPayload {
  /** Toolbar left edge in surface viewport coordinates (binary: rect.left). */
  x: number;
  /** Toolbar top edge (binary: rect.bottom + 2). */
  y: number;
  /** The link URL (binary: the mention's `data-mention-name`). */
  link: string;
  /** Fork-only (D2): uuid of the link chip the toolbar acts on. */
  uuid?: string;
}

/** Validate an untrusted payload (command args / webview messages). */
export function isMentionLinkToolbarPayload(
  value: unknown,
): value is MentionLinkToolbarPayload {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v.x === "number" &&
    Number.isFinite(v.x) &&
    typeof v.y === "number" &&
    Number.isFinite(v.y) &&
    typeof v.link === "string" &&
    v.link.length > 0 &&
    (v.uuid === undefined || typeof v.uuid === "string")
  );
}

/** CSS position for the toolbar element (binary: top=y px, left=x px). */
export function mentionLinkToolbarPosition(payload: MentionLinkToolbarPayload): {
  left: string;
  top: string;
} {
  return { left: `${payload.x}px`, top: `${payload.y}px` };
}

/* ------------------------------------------------------------------ */
/* Paste auto-parse predicate (desk @24723930).                        */
/* ------------------------------------------------------------------ */

/**
 * Whether a plain-text paste becomes a link mention. Binary conditions:
 * supportsLink (the fork's composer supports links), the mentions menu
 * is closed, `text.length < 2000`, and the text is a URL. The binary's
 * exact URL predicate is UNKNOWN (D3); the fork accepts a single
 * whitespace-free token that `URL` parses with an http:/https: scheme.
 */
export function isAutoParseLinkText(text: string): boolean {
  if (typeof text !== "string" || text.length === 0 || text.length >= AUTO_PARSE_LINK_MAX_LENGTH) {
    return false;
  }
  const trimmed = text.trim();
  if (trimmed.length === 0 || /\s/.test(trimmed)) {
    return false;
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return false;
  }
  return url.protocol === "http:" || url.protocol === "https:";
}

/* ------------------------------------------------------------------ */
/* The service mirror (uiOverlayService semantics).                    */
/* ------------------------------------------------------------------ */

/** Minimal host surface — anything that can post to the chat webview. */
export interface MentionLinkToolbarHost {
  postToWebview(message: unknown): void;
}

/**
 * Mirror of the binary's mentionLinkToolbar slice of uiOverlayService:
 * observable-ish state plus a Promise that resolves on close.
 *
 * Verbatim semantics kept from the binary:
 *  - show() replaces the current state and stores a NEW resolver —
 *    showing twice overwrites the previous resolver, whose promise then
 *    never resolves (binary behavior, kept deliberately).
 *  - close() resolves the pending promise (with no value), clears the
 *    resolver and the state; closing when nothing is open is a no-op.
 */
export class MentionLinkToolbarController {
  private state: MentionLinkToolbarPayload | undefined;
  private resolvePending: (() => void) | undefined;

  /** Current toolbar payload, or undefined when closed (binary `.value`). */
  get current(): MentionLinkToolbarPayload | undefined {
    return this.state;
  }

  get isOpen(): boolean {
    return this.state !== undefined;
  }

  /**
   * Binary `showMentionLinkToolbar(e)`: set state, post the show message
   * to the chat surface, and return a Promise that resolves on close.
   */
  showMentionLinkToolbar(
    host: MentionLinkToolbarHost,
    payload: MentionLinkToolbarPayload,
  ): Promise<void> {
    this.state = payload;
    host.postToWebview({ type: SHOW_MENTION_LINK_TOOLBAR, ...payload });
    return new Promise<void>((resolve) => {
      this.resolvePending = resolve;
    });
  }

  /**
   * Binary `closeMentionLinkToolbar()`: resolve + clear. When `host` is
   * given (an external close, not initiated by the webview itself) the
   * surface is also told to hide its toolbar DOM.
   *
   * GAPS-143 (NF-1): surface teardown (ChatViewProvider onDidDispose /
   * re-resolve, ChatEditorHost.dispose / resolveCustomEditor re-resolve)
   * calls this with NO host — the webview that owned the toolbar DOM is
   * gone, so there is nothing to hide, but the pending promise must
   * still resolve and `current` must still clear instead of leaking
   * until the next show overwrites the resolver.
   */
  closeMentionLinkToolbar(host?: MentionLinkToolbarHost): void {
    if (this.resolvePending) {
      this.resolvePending();
      this.resolvePending = undefined;
    }
    this.state = undefined;
    if (host) {
      host.postToWebview({ type: HIDE_MENTION_LINK_TOOLBAR });
    }
  }
}

/** Shared controller for the extension host process (both chat surfaces
 *  and the `ide.mentionLinkToolbar` command act on the same toolbar —
 *  the binary likewise has exactly one uiOverlayService instance). */
export const mentionLinkToolbarController = new MentionLinkToolbarController();
