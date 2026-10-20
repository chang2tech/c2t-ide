/**
 * Snapshot + ref registry for the browser-for-agent layer.
 *
 * Reimplements Cursor's browser_snapshot perception core (spot-verified against
 * Cursor 3.25.6's cursor-browser-automation extension.js):
 *  - accessibility snapshot: walks the DOM for interactive elements
 *    (INTERACTIVE_ROLES), computes accessible names, stamps stable
 *    `data-ide-ref="e<N>"` attributes (Cursor uses `data-cursor-ref`)
 *  - refs match /^e\d+$/ and are STABLE across snapshots: an element that
 *    already carries a valid ref keeps it (refCounter continues from the max
 *    existing index)
 *  - shadow-DOM aware (`querySelectorAllIncludingOpenShadowRoots`)
 *  - `validateElementForInteraction(ref, expectedDescription)`: staleness /
 *    visibility / description-match checks with Cursor's recovery error
 *    ("The page may have changed. Take a new snapshot.")
 *  - stale refs cleaned via `removeAttribute` when a new snapshot drops them
 *
 * Unlike the interactive picker (which must never write DOM attributes —
 * Cursor broke Next.js HMR doing that), snapshot refs ARE stamped into the
 * DOM, exactly like Cursor's. They are namespaced `data-ide-ref` and cleaned
 * up, so the blast radius is contained.
 */
import { PageDriver } from "./driver";
import { BrowserError, Rect } from "./types";

/** In-page snapshot engine. Exported as a string; injected via driver.evaluate(). */
export const SNAPSHOT_SCRIPT = `
(function () {
  if (window.__ideSnapshotInjected) return { ok: true, already: true };
  if (window !== window.top) return { ok: false, reason: "not-top-frame" };

  var REF_ATTR = "data-ide-ref";
  var INTERACTIVE_ROLES = {
    button: 1, link: 1, textbox: 1, checkbox: 1, radio: 1, combobox: 1,
    listbox: 1, menuitem: 1, menuitemcheckbox: 1, menuitemradio: 1,
    option: 1, slider: 1, spinbutton: 1, "switch": 1, tab: 1,
    treeitem: 1, searchbox: 1
  };
  var SKIP_TAGS = { script: 1, style: 1, head: 1, meta: 1, link: 1, noscript: 1, template: 1 };

  function isValidRef(ref) {
    return typeof ref === "string" && /^e\\d+$/.test(ref);
  }

  function querySelectorAllIncludingOpenShadowRoots(selector) {
    var out = [];
    function walk(root) {
      try {
        var els = root.querySelectorAll(selector);
        for (var i = 0; i < els.length; i++) out.push(els[i]);
        var all = root.querySelectorAll("*");
        for (var j = 0; j < all.length; j++) {
          if (all[j].shadowRoot) walk(all[j].shadowRoot);
        }
      } catch (e) { /* cross-origin / detached */ }
    }
    walk(document);
    return out;
  }

  function getImplicitRole(el) {
    var tag = (el.tagName || "").toLowerCase();
    if (tag === "a" && el.hasAttribute("href")) return "link";
    if (tag === "button") return "button";
    if (tag === "input") {
      var t = (el.getAttribute("type") || "text").toLowerCase();
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (t === "range") return "slider";
      if (t === "number") return "spinbutton";
      if (t === "search") return "searchbox";
      if (t === "submit" || t === "button" || t === "reset" || t === "image") return "button";
      if (t === "hidden") return "generic";
      return "textbox";
    }
    if (tag === "select") return el.hasAttribute("multiple") ? "listbox" : "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "option") return "option";
    if (tag === "img") return "img";
    if (el.hasAttribute("contenteditable")) return "textbox";
    return "generic";
  }

  function computeAccessibleName(el, role) {
    var labelledby = el.getAttribute("aria-labelledby");
    if (labelledby) {
      var parts = [];
      var ids = labelledby.split(/\\s+/);
      for (var i = 0; i < ids.length; i++) {
        if (!ids[i]) continue;
        var refEl = document.getElementById(ids[i]);
        if (refEl && refEl.textContent) parts.push(refEl.textContent);
      }
      var joined = parts.join(" ").replace(/\\s+/g, " ").trim();
      if (joined) return joined.slice(0, 200);
    }
    var ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim().slice(0, 200);
    if (el.id) {
      try {
        var label = document.querySelector('label[for="' + el.id.replace(/"/g, "") + '"]');
        if (label && label.textContent && label.textContent.trim()) {
          return label.textContent.replace(/\\s+/g, " ").trim().slice(0, 200);
        }
      } catch (e) { /* bad id for selector */ }
    }
    var alt = el.getAttribute("alt");
    if (alt && alt.trim()) return alt.trim().slice(0, 200);
    var placeholder = el.getAttribute("placeholder");
    if (placeholder && placeholder.trim()) return placeholder.trim().slice(0, 200);
    var title = el.getAttribute("title");
    if (title && title.trim()) return title.trim().slice(0, 200);
    var text = (el.innerText || "").replace(/\\s+/g, " ").trim();
    if (text) return text.slice(0, 200);
    if (el.tagName && el.tagName.toLowerCase() === "input" && el.value) {
      return String(el.value).slice(0, 200);
    }
    return "";
  }

  function getElementDescription(el) {
    if (!el) return "";
    var tag = (el.tagName || "").toLowerCase();
    // Use the same role + name computation as the snapshot stamping, so a
    // ref's stored description ("<role> <name>") always matches what
    // validateElementForInteraction recomputes. (The old version only looked
    // at explicit role/aria-label/innerText, so e.g. placeholder-named inputs
    // described as just "input" and failed their own description check.)
    var role = el.getAttribute("role") || getImplicitRole(el) || "";
    var name = computeAccessibleName(el, role);
    var parts = [tag];
    if (role) parts.push('role="' + role + '"');
    if (name) parts.push('"' + name.slice(0, 80) + '"');
    return parts.join(" ");
  }

  function findByRef(ref) {
    if (!isValidRef(ref)) return null;
    var els = querySelectorAllIncludingOpenShadowRoots('[' + REF_ATTR + '="' + ref + '"]');
    return els.length > 0 ? els[0] : null;
  }

  function snapshot(opts) {
    opts = opts || {};
    var maxDepth = opts.maxDepth != null ? opts.maxDepth : 20;
    var interactiveOnly = opts.interactive !== false;
    var root = document.body;
    if (opts.selector) {
      var scoped = document.querySelector(opts.selector);
      if (!scoped) return { ok: false, reason: "snapshot selector matched nothing" };
      root = scoped;
    }
    // Stable numbering: continue from the max existing ref index so elements
    // that already carry a ref keep it across snapshots.
    var maxIndex = -1;
    var existing = querySelectorAllIncludingOpenShadowRoots("[" + REF_ATTR + "]");
    for (var i = 0; i < existing.length; i++) {
      var r = existing[i].getAttribute(REF_ATTR);
      if (isValidRef(r)) {
        var n = parseInt(r.substring(1), 10);
        if (n > maxIndex) maxIndex = n;
      }
    }
    var refCounter = maxIndex + 1;
    var usedRefs = {};

    function stamp(el) {
      var already = el.getAttribute(REF_ATTR);
      if (isValidRef(already) && !usedRefs[already]) {
        usedRefs[already] = true;
        return already;
      }
      var ref = "e" + (refCounter++);
      el.setAttribute(REF_ATTR, ref);
      usedRefs[ref] = true;
      return ref;
    }

    function walk(el, depth) {
      if (depth > maxDepth || !el || el.nodeType !== 1) return null;
      var tag = (el.tagName || "").toLowerCase();
      if (SKIP_TAGS[tag]) return null;
      var role = el.getAttribute("role") || getImplicitRole(el);
      var isInteractive = !!INTERACTIVE_ROLES[role];
      var node = null;
      if (isInteractive) {
        var name = computeAccessibleName(el, role);
        if (!name) {
          // Unnamed interactive elements are skipped (Cursor does this), but
          // their children are still walked.
        } else {
          var ref = stamp(el);
          var value = "";
          try {
            if ("value" in el && typeof el.value === "string") value = String(el.value).slice(0, 200);
          } catch (e) { /* ignore */ }
          node = { ref: ref, role: role, name: name, value: value, children: [] };
        }
      } else if (!interactiveOnly) {
        node = { ref: "", role: role, name: "", children: [] };
      }
      var childNodes = [];
      function addChild(c) {
        if (!c) return;
        if (c.role === "fragment") {
          for (var k = 0; k < c.children.length; k++) addChild(c.children[k]);
        } else {
          childNodes.push(c);
        }
      }
      var kids = el.children;
      for (var ci = 0; ci < kids.length; ci++) addChild(walk(kids[ci], depth + 1));
      if (el.shadowRoot) {
        var sKids = el.shadowRoot.children;
        for (var si = 0; si < sKids.length; si++) addChild(walk(sKids[si], depth + 1));
      }
      if (node) {
        node.children = childNodes;
        return node;
      }
      if (childNodes.length > 0) return { role: "fragment", children: childNodes };
      return null;
    }

    var top = walk(root, 0);
    var nodes = [];
    if (top) {
      if (top.role === "fragment") nodes = top.children;
      else nodes = [top];
    }
    return { ok: true, nodes: nodes };
  }

  function validateElementForInteraction(ref, expectedDescription) {
    var el = findByRef(ref);
    if (!el) {
      throw new Error(
        "Element " + ref + " not found. The page may have changed. Take a new snapshot."
      );
    }
    var rootNode = el.getRootNode ? el.getRootNode() : document;
    var inDom = false;
    try {
      inDom = rootNode.contains ? rootNode.contains(el) : document.contains(el);
    } catch (e) { inDom = false; }
    if (!inDom) {
      throw new Error(
        "Element " + ref + " is no longer in the DOM. The page may have changed. Take a new snapshot."
      );
    }
    if (expectedDescription) {
      var actual = getElementDescription(el).toLowerCase();
      var expectedWords = String(expectedDescription)
        .toLowerCase()
        .replace(/[^\\w\\s]/g, " ")
        .split(/\\s+/)
        .filter(function (w) { return w.length > 0; });
      var matched =
        expectedWords.length === 0 ||
        expectedWords.some(function (w) { return actual.indexOf(w) >= 0; });
      if (!matched) {
        throw new Error(
          "Element " + ref + " changed (expected ~\\"" + expectedDescription +
          "\\", found \\"" + getElementDescription(el) +
          "\\"). The page may have changed. Take a new snapshot."
        );
      }
    }
    var rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      throw new Error(
        "Element " + ref + " (" + getElementDescription(el) + ") is not visible (zero dimensions)."
      );
    }
    return {
      ok: true,
      ref: ref,
      description: getElementDescription(el),
      selector: "[" + REF_ATTR + '="' + ref + '"]'
    };
  }

  function cleanupStaleRefs(validRefs) {
    var valid = {};
    for (var i = 0; i < validRefs.length; i++) valid[validRefs[i]] = true;
    var els = querySelectorAllIncludingOpenShadowRoots("[" + REF_ATTR + "]");
    var removed = 0;
    for (var j = 0; j < els.length; j++) {
      var r = els[j].getAttribute(REF_ATTR);
      if (!valid[r]) {
        els[j].removeAttribute(REF_ATTR);
        removed++;
      }
    }
    return { ok: true, removed: removed };
  }

  function boundingBoxForRef(ref) {
    var el = findByRef(ref);
    if (!el) return null;
    var r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }

  window.__ideSnapshot = {
    snapshot: snapshot,
    validate: validateElementForInteraction,
    cleanup: cleanupStaleRefs,
    boundingBox: boundingBoxForRef,
    findByRef: findByRef,
    isValidRef: isValidRef,
    describe: getElementDescription
  };

  window.__ideSnapshotInjected = true;
  return { ok: true, already: false };
})();
`;

/** One node of the accessibility snapshot tree. */
export interface SnapshotNode {
  /** Stable ref, e.g. "e12". */
  ref: string;
  /** ARIA role (button, link, textbox, ...). */
  role: string;
  /** Accessible name. */
  name: string;
  /** Current value for inputs ("" otherwise). */
  value: string;
  /** Nested interactive descendants. */
  children: SnapshotNode[];
}

/** Options for SnapshotController.snapshot(). */
export interface SnapshotOptions {
  /** Max tree depth (default 20, Cursor's default). */
  maxDepth?: number;
  /** Compact text rendering (default false). */
  compact?: boolean;
  /** Scope the snapshot to a CSS selector subtree. */
  selector?: string;
  /** Only interactive elements (default true). */
  interactive?: boolean;
}

/** Result of a snapshot: structured nodes + agent-readable text. */
export interface SnapshotData {
  nodes: SnapshotNode[];
  /** Rendered tree text, e.g. `- button "Sign in" [e3]`. */
  text: string;
  refCount: number;
}

interface RawNode {
  ref?: string;
  role?: string;
  name?: string;
  value?: string;
  children?: RawNode[];
}

/** Ref format check (mirrors the in-page isValidRef). */
export function isValidRef(ref: string): boolean {
  return typeof ref === "string" && /^e\d+$/.test(ref);
}

/** CSS selector that resolves a stamped ref (stable while the page lives). */
export function selectorForRef(ref: string): string {
  return `[data-ide-ref="${ref}"]`;
}

function toSnapshotNode(raw: RawNode): SnapshotNode {
  return {
    ref: raw.ref ?? "",
    role: raw.role ?? "generic",
    name: raw.name ?? "",
    value: raw.value ?? "",
    children: (raw.children ?? []).map(toSnapshotNode),
  };
}

/** Render the snapshot tree as agent-readable text. Pure and unit-testable. */
export function renderSnapshotText(nodes: SnapshotNode[], compact = false): string {
  const lines: string[] = [];
  const walk = (ns: SnapshotNode[], depth: number) => {
    for (const n of ns) {
      const indent = compact ? "" : "  ".repeat(depth);
      const valuePart = n.value ? ` value="${n.value.slice(0, 60)}"` : "";
      lines.push(`${indent}- ${n.role} "${n.name}" [${n.ref}]${valuePart}`);
      if (n.children.length > 0) walk(n.children, depth + 1);
    }
  };
  walk(nodes, 0);
  return lines.join("\n");
}

/** Count all nodes (including nested). */
export function countSnapshotNodes(nodes: SnapshotNode[]): number {
  let n = 0;
  const walk = (ns: SnapshotNode[]) => {
    for (const x of ns) {
      n++;
      walk(x.children);
    }
  };
  walk(nodes);
  return n;
}

/**
 * SnapshotController — host-side driver of the in-page snapshot engine.
 * One per browser session (held by BrowserService, like PickerController).
 * Remembers the last snapshot's ref → description map so ref-based actions
 * can pass an expected description to validateElementForInteraction.
 */
export class SnapshotController {
  private lastDescriptions = new Map<string, string>();

  constructor(private readonly driver: PageDriver) {}

  /** Inject the snapshot script (idempotent). */
  async inject(): Promise<{ already: boolean }> {
    const res = await this.driver.evaluate<{ ok: boolean; already?: boolean; reason?: string }>(
      SNAPSHOT_SCRIPT,
    );
    if (!res.ok) {
      throw new BrowserError("EVAL_FAILED", `snapshot inject failed: ${res.reason ?? "unknown"}`);
    }
    return { already: !!res.already };
  }

  /** Take an accessibility snapshot with stable e<N> refs. */
  async snapshot(opts: SnapshotOptions = {}): Promise<SnapshotData> {
    await this.inject();
    const res = await this.driver.evaluate<{ ok: boolean; nodes?: RawNode[]; reason?: string }>(
      `window.__ideSnapshot.snapshot(${JSON.stringify({
        maxDepth: opts.maxDepth ?? 20,
        compact: !!opts.compact,
        selector: opts.selector,
        interactive: opts.interactive !== false,
      })})`,
    );
    if (!res.ok || !res.nodes) {
      throw new BrowserError("EVAL_FAILED", `snapshot failed: ${res.reason ?? "unknown"}`);
    }
    const nodes = res.nodes.map(toSnapshotNode);
    // Remember ref → description for later validation.
    this.lastDescriptions.clear();
    const index = (ns: SnapshotNode[]) => {
      for (const n of ns) {
        if (n.ref) this.lastDescriptions.set(n.ref, `${n.role} ${n.name}`);
        index(n.children);
      }
    };
    index(nodes);
    // Clean stamped refs that no longer appear (Cursor does removeAttribute).
    const validRefs = [...this.lastDescriptions.keys()];
    await this.driver
      .evaluate<{ ok: boolean }>(`window.__ideSnapshot.cleanup(${JSON.stringify(validRefs)})`)
      .catch(() => undefined);
    return { nodes, text: renderSnapshotText(nodes, opts.compact), refCount: countSnapshotNodes(nodes) };
  }

  /** Expected description for a ref from the last snapshot (if any). */
  descriptionFor(ref: string): string | undefined {
    return this.lastDescriptions.get(ref);
  }

  /**
   * Validate a ref before interacting: resolves to a stable CSS selector.
   * Throws BrowserError with Cursor's recovery message when stale/invisible.
   */
  async validate(ref: string): Promise<{ selector: string; description: string }> {
    if (!isValidRef(ref)) {
      throw new BrowserError("INVALID_ARGS", `invalid ref "${ref}" (expected e<N> from browser_snapshot)`);
    }
    await this.inject();
    const expected = this.descriptionFor(ref);
    let res: { ok: boolean; selector?: string; description?: string };
    try {
      res = await this.driver.evaluate<{ ok: boolean; selector?: string; description?: string }>(
        `window.__ideSnapshot.validate(${JSON.stringify(ref)}, ${JSON.stringify(expected ?? null)})`,
      );
    } catch (e) {
      // The in-page validator throws with Cursor's recovery message; surface it.
      const msg = e instanceof Error ? e.message : String(e);
      const m = msg.match(/page script threw: (.*)$/);
      throw new BrowserError("EVAL_FAILED", m ? m[1] : msg);
    }
    if (!res.ok || !res.selector) {
      throw new BrowserError("EVAL_FAILED", `ref ${ref} failed validation`);
    }
    return { selector: res.selector, description: res.description ?? "" };
  }

  /** Viewport bounding box for a ref (validates first). */
  async getBoundingBox(ref: string): Promise<Rect> {
    await this.validate(ref);
    const rect = await this.driver.evaluate<Rect | null>(
      `window.__ideSnapshot.boundingBox(${JSON.stringify(ref)})`,
    );
    if (!rect) throw new BrowserError("EVAL_FAILED", `no bounding box for ref ${ref}`);
    return rect;
  }
}
