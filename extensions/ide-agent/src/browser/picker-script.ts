/**
 * Injected element-picker script (runs INSIDE the page).
 *
 * Reimplements Cursor's design-mode picker (dissect-browser-interaction.md §3.2):
 *  - idempotent top-frame injection
 *  - element identity in an off-DOM WeakMap — NEVER writes tracking attributes
 *    (Cursor learned this the hard way: foreign attributes broke Next.js HMR)
 *  - crosshair cursor + orange (#ff6a00) hover outline
 *  - bubble-to-meaningful-ancestor from elementFromPoint
 *  - multi-select with per-pick hue coding
 *  - buildPayload(): tagName/id/class/innerText(≤200)/uniqueId/DOM path/xpath/
 *    attributes/rect/computed styles/React-Vue component stack
 *  - host bridge on window.__idePicker
 *
 * Exported as a string; the PickerController injects it via driver.evaluate().
 * Fully testable headless: inject into a real page, dispatch synthetic
 * pointer events, assert highlights + payloads.
 */

export const PICKER_SCRIPT = `
(function () {
  if (window.__idePickerInjected) return { ok: true, already: true };
  if (window !== window.top) return { ok: false, reason: "not-top-frame" };

  var HIGHLIGHT_COLOR = "#ff6a00";
  var HUE_COLORS = ["#ff6a00", "#22c55e", "#3b82f6", "#a855f7", "#eab308", "#ec4899", "#14b8a6", "#f97316"];
  var uidCounter = 0;
  var uidRand = Math.random().toString(36).slice(2, 8);

  /** Off-DOM identity: element -> uniqueId. Never touches the DOM. */
  var identity = new WeakMap();
  function uniqueIdFor(el) {
    var id = identity.get(el);
    if (!id) {
      id = "ide-el-" + uidRand + "-" + (uidCounter++);
      identity.set(el, id);
    }
    return id;
  }

  var active = false;
  var selections = []; // [{element, hue, payload}]
  var hovered = null;
  var hoverOutlinePrev = null;

  var styleEl = document.createElement("style");
  styleEl.setAttribute("data-ide-picker", "1");
  styleEl.textContent =
    "* { cursor: crosshair !important; }" +
    ".__ide-picker-hover { outline: 2px solid " + HIGHLIGHT_COLOR + " !important;" +
    " box-shadow: 0 0 0 2px rgba(255,106,0,.4) !important; }";
  function hueRule(hue, idx) {
    return ".__ide-picker-sel-" + idx + " { outline: 2px solid " + hue + " !important;" +
      " box-shadow: 0 0 0 2px " + hue + "55 !important; }";
  }

  function isMeaningful(el) {
    if (!el || el === document.documentElement || el === document.body) return false;
    var tag = (el.tagName || "").toLowerCase();
    if (["script", "style", "meta", "link", "head", "noscript", "template"].indexOf(tag) >= 0) return false;
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    return true;
  }

  /** Climb from the raw hit to a "meaningful" ancestor (skips tiny wrappers). */
  function bubbleToMeaningfulElement(el) {
    var cur = el;
    var depth = 0;
    while (cur && depth < 8 && !isMeaningful(cur)) {
      cur = cur.parentElement;
      depth++;
    }
    return isMeaningful(cur) ? cur : null;
  }

  function setHover(el) {
    if (hovered === el) return;
    if (hovered) hovered.classList.remove("__ide-picker-hover");
    hovered = el;
    if (hovered) hovered.classList.add("__ide-picker-hover");
  }

  function cssPath(el) {
    var parts = [];
    var cur = el;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      var tag = cur.tagName.toLowerCase();
      var seg = tag;
      if (cur.id) {
        seg += "#" + cur.id;
        parts.unshift(seg);
        break;
      } else {
        if (cur.className && typeof cur.className === "string") {
          var cls = cur.className.trim().split(/\\s+/).slice(0, 3).join(".");
          if (cls) seg += "." + cls;
        }
        var idx = 1;
        var sib = cur.previousElementSibling;
        while (sib) { if (sib.tagName === cur.tagName) idx++; sib = sib.previousElementSibling; }
        seg += ":nth-of-type(" + idx + ")";
        parts.unshift(seg);
      }
      cur = cur.parentElement;
    }
    return parts.join(" > ");
  }

  function xpathFor(el) {
    var parts = [];
    var cur = el;
    while (cur && cur.nodeType === 1) {
      var idx = 1;
      var sib = cur.previousSibling;
      while (sib) { if (sib.nodeType === 1 && sib.nodeName === cur.nodeName) idx++; sib = sib.previousSibling; }
      parts.unshift(cur.nodeName.toLowerCase() + "[" + idx + "]");
      cur = cur.parentNode;
    }
    return "/" + parts.join("/");
  }

  function detectFramework(el) {
    try {
      var cur = el;
      var depth = 0;
      while (cur && depth < 12) {
        var keys = Object.keys(cur);
        for (var i = 0; i < keys.length; i++) {
          var k = keys[i];
          if (k.indexOf("__reactFiber$") === 0 || k.indexOf("__reactInternalInstance$") === 0) {
            return { framework: "react", component: guessReactName(cur[k]), stack: [] };
          }
          if (k === "__vue__" || k.indexOf("__vueParent") === 0) {
            return { framework: "vue", component: guessVueName(cur[k]), stack: [] };
          }
        }
        if (cur._reactRootContainer) return { framework: "react", component: null, stack: [] };
        cur = cur.parentElement;
        depth++;
      }
    } catch (e) { /* best effort */ }
    return { framework: null, component: null, stack: [] };
  }

  function guessReactName(fiber) {
    try {
      var cur = fiber;
      var stack = [];
      var d = 0;
      while (cur && d < 6) {
        var tag = cur.tag;
        // 0 = FunctionComponent, 1 = ClassComponent
        if ((tag === 0 || tag === 1) && cur.type) {
          var name = cur.type.displayName || cur.type.name;
          if (name) { stack.unshift(name); if (!stack.name0) stack.name0 = name; }
        }
        cur = cur.return;
        d++;
      }
      return stack.name0 || stack[0] || null;
    } catch (e) { return null; }
  }

  function guessVueName(inst) {
    try {
      if (inst && inst.$options && (inst.$options.name || inst.$options._componentTag)) {
        return inst.$options.name || inst.$options._componentTag;
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  function buildPayload(el) {
    var rect = el.getBoundingClientRect();
    var cs = window.getComputedStyle(el);
    var attrs = [];
    try {
      var names = el.getAttributeNames ? el.getAttributeNames() : [];
      for (var i = 0; i < Math.min(names.length, 20); i++) {
        var v = el.getAttribute(names[i]);
        attrs.push({ name: names[i], value: v === null ? "" : String(v).slice(0, 200) });
      }
    } catch (e) { /* ignore */ }
    var fw = detectFramework(el);
    var text = (el.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 200);
    return {
      tagName: el.tagName.toLowerCase(),
      id: el.id || "",
      className: (typeof el.className === "string" ? el.className : "") || "",
      innerText: text,
      uniqueId: uniqueIdFor(el),
      path: cssPath(el),
      xpath: xpathFor(el),
      attributes: attrs,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      styles: {
        color: cs.color,
        backgroundColor: cs.backgroundColor,
        fontSize: cs.fontSize,
        fontFamily: cs.fontFamily,
        display: cs.display,
        position: cs.position
      },
      framework: fw.framework,
      component: fw.component,
      componentStack: fw.stack
    };
  }

  function onPointerMove(ev) {
    if (!active) return;
    var hit = document.elementFromPoint(ev.clientX, ev.clientY);
    if (hit === styleEl) hit = null;
    var target = hit ? bubbleToMeaningfulElement(hit) : null;
    setHover(target);
  }

  function onClick(ev) {
    if (!active) return;
    ev.preventDefault();
    ev.stopPropagation();
    var hit = document.elementFromPoint(ev.clientX, ev.clientY);
    var target = hit ? bubbleToMeaningfulElement(hit) : null;
    if (!target) return;
    var hue = HUE_COLORS[selections.length % HUE_COLORS.length];
    var idx = selections.length;
    styleEl.textContent += hueRule(hue, idx);
    target.classList.add("__ide-picker-sel-" + idx);
    var payload = buildPayload(target);
    selections.push({ element: target, hue: hue, payload: payload });
    window.postMessage({ __idePickerEvent: "element-selected", payload: payload }, "*");
  }

  function onKeyDown(ev) {
    if (!active) return;
    if (ev.key === "Escape") {
      window.__idePicker.stop();
      window.postMessage({ __idePickerEvent: "picker-cancelled" }, "*");
    }
  }

  function start() {
    if (active) return { ok: true };
    active = true;
    document.documentElement.appendChild(styleEl);
    document.addEventListener("pointermove", onPointerMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKeyDown, true);
    return { ok: true };
  }

  function stop() {
    if (!active) return { ok: true, selections: selections.map(function (s) { return s.payload; }) };
    active = false;
    document.removeEventListener("pointermove", onPointerMove, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKeyDown, true);
    if (hovered) hovered.classList.remove("__ide-picker-hover");
    hovered = null;
    if (styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
    return { ok: true, selections: selections.map(function (s) { return s.payload; }) };
  }

  window.__idePicker = {
    start: start,
    stop: stop,
    clear: function () {
      for (var i = 0; i < selections.length; i++) {
        selections[i].element.classList.remove("__ide-picker-sel-" + i);
      }
      selections = [];
      return { ok: true };
    },
    getSelections: function () {
      return selections.map(function (s) { return s.payload; });
    },
    highlightAt: function (x, y) {
      var hit = document.elementFromPoint(x, y);
      var target = hit ? bubbleToMeaningfulElement(hit) : null;
      setHover(target);
      return target ? buildPayload(target) : null;
    },
    clearHover: function () {
      setHover(null);
      return { ok: true };
    },
    payloadForSelector: function (selector) {
      var el = document.querySelector(selector);
      if (!el) return null;
      return buildPayload(bubbleToMeaningfulElement(el) || el);
    },
    isActive: function () { return active; }
  };

  window.__idePickerInjected = true;
  return { ok: true, already: false };
})();
`;
