/**
 * deeplink — pure URI parsing/validation for ide-code:// deep links.
 *
 * Cursor parity (binary-verified, extensions/cursor-deeplink/dist/main.js,
 * 3.25.9): the `cursor-deeplink` extension activates on `onUri`, registers a
 * URI handler, and requires URLs of the form
 * `cursor://anysphere.cursor-deeplink/<path>?<query>`. Our equivalent is
 * `ide-code://anysphere.ide-code-deeplink/<path>?<query>` (product protocol
 * `ide-code` from product.json; authority = this extension's id, which is
 * what VS Code's ExtensionUrlHandler matches on).
 *
 * `/mcp/install` contract (binary-verified):
 *   - query params: `name` (server name) + `config` (base64-encoded UTF-8 JSON
 *     object — the MCP server config, e.g. {command, args, env})
 *   - missing param  → 'Missing "name" or "config" parameter in deep link.'
 *   - bad base64/JSON → "Invalid server configuration provided: Not valid JSON."
 *   - valid JSON but not an object → "Invalid server configuration provided:
 *     Must be a JSON object."
 *
 * No vscode import here — pure node, unit-tested with node:test.
 */
import * as path from "node:path";

/** Product URL protocol (product.json `urlProtocol`). */
export const DEEPLINK_SCHEME = "ide-code";
/** This extension's id (`publisher.name`) — the URI authority VS Code routes on. */
export const DEEPLINK_AUTHORITY = "anysphere.ide-code-deeplink";

export interface McpInstallRequest {
  name: string;
  config: Record<string, unknown>;
}

/** A Cursor Settings section id passed verbatim to `aiSettings.action.open`. */
export type AiSettingsSection = "background-composer" | "plan-usage" | "plugins";

/** Customize tabs the binary's `/customize` handler accepts (Set `Ps`). */
export type CustomizeDeeplinkTab = "plugins" | "mcps" | "rules" | "hooks";

/** The binary's `initialView` payload for `workbench.action.openCustomizeEditor`. */
export type CustomizeInitialView =
  | { kind: "browse" }
  | { kind: "detail"; pluginId: string }
  | { kind: "manage"; tab: CustomizeDeeplinkTab; scope: "user" };

export type DeeplinkRoute =
  | { kind: "mcp-install"; request: McpInstallRequest }
  | { kind: "command-create"; name: string; content: string }
  | { kind: "rule-create"; name: string; content: string }
  | { kind: "prompt-prefill"; text: string; mode?: string }
  | { kind: "settings-open"; section?: AiSettingsSection }
  | { kind: "customize-open"; initialView?: CustomizeInitialView }
  | {
      kind: "glass-open";
      agentsWindowOpenSource: "deeplink";
      startupHandoff?: false;
      deeplinkUrl?: string;
    }
  | { kind: "root" }
  | { kind: "unknown-path"; path: string }
  | { kind: "invalid"; error: string };

/** Minimal URI shape (vscode.Uri has scheme/authority/path/query). */
export interface DeeplinkUriLike {
  scheme: string;
  authority: string;
  path: string;
  query: string;
  /** Full original URI string (`uri.toString()`); the binary forwards it as
   * the glass-window `deeplinkUrl` handoff (`t.toString(!0)`). Optional in
   * the pure layer: when absent it is reconstructed from the parts. */
  uriString?: string;
}

/** The `deeplinkUrl` handoff value: the full original URI string. */
function deeplinkUrlOf(uri: DeeplinkUriLike): string {
  return (
    uri.uriString ??
    `${uri.scheme}://${uri.authority}${uri.path}${uri.query ? `?${uri.query}` : ""}`
  );
}

/**
 * Route a deeplink URI. Mirrors the cursor-deeplink `handleUri` router:
 * unknown paths are NOT an error here — the caller warns like Cursor
 * ("Unrecognized deep link. Try updating …").
 */
export function routeDeeplink(uri: DeeplinkUriLike): DeeplinkRoute {
  if (uri.scheme !== DEEPLINK_SCHEME || uri.authority !== DEEPLINK_AUTHORITY) {
    return {
      kind: "invalid",
      error: `URL must start with ${DEEPLINK_SCHEME}://${DEEPLINK_AUTHORITY}/`,
    };
  }
  // Dispatch order mirrors the binary router (`ca.handleUri`, ~@434200):
  // /createchat, /mcp/install, /background-agent/setup, /background-agent +
  // /agent, /create-project, /automations*, /customize(+marketplace),
  // /settings*, /prompt, /command, /rule, /pr-review, /plugin/add,
  // /plugin/install-and-prompt, /github-connect-callback, /glass, root.
  // Routes whose binary destination does not exist in this fork are NOT
  // dispatched (they fall through to unknown-path — see the
  // DEV-GAPS-110 note at the bottom of this file): /createchat,
  // /background-agent/setup, /automations*, /pr-review,
  // /github-connect-callback.
  if (uri.path === "/mcp/install") {
    return parseMcpInstall(uri.query);
  }
  if (uri.path === "/background-agent" || uri.path === "/agent") {
    return {
      kind: "glass-open",
      agentsWindowOpenSource: "deeplink",
      startupHandoff: false,
      deeplinkUrl: deeplinkUrlOf(uri),
    };
  }
  if (uri.path === "/create-project") {
    return {
      kind: "glass-open",
      agentsWindowOpenSource: "deeplink",
      startupHandoff: false,
      deeplinkUrl: deeplinkUrlOf(uri),
    };
  }
  if (uri.path === "/customize" || uri.path === "/customize/marketplace") {
    return parseCustomizeDeeplinkRoute(uri.path, uri.query);
  }
  if (uri.path.startsWith("/settings")) {
    return parseSettingsDeeplinkRoute(uri.path, uri.query);
  }
  if (uri.path === "/prompt") {
    return parsePromptDeeplinkRoute(uri.query);
  }
  if (uri.path === "/command") {
    return parseCommandDeeplinkRoute(uri.query);
  }
  if (uri.path === "/rule") {
    return parseRuleDeeplinkRoute(uri.query);
  }
  if (uri.path === "/plugin/add") {
    return parsePluginAddDeeplinkRoute(uri.query);
  }
  if (uri.path === "/plugin/install-and-prompt") {
    return {
      kind: "glass-open",
      agentsWindowOpenSource: "deeplink",
      startupHandoff: false,
      deeplinkUrl: deeplinkUrlOf(uri),
    };
  }
  if (uri.path === "/glass") {
    return parseGlassDeeplinkRoute(uri.query, deeplinkUrlOf(uri));
  }
  if (uri.path === "/" || uri.path === "") {
    // Binary: `"/"===n.path||""===n.path` is a recognized NO-OP (no warn).
    return { kind: "root" };
  }
  return { kind: "unknown-path", path: uri.path };
}

/** Parse + validate the `/mcp/install` query. Error strings are verbatim Cursor. */
export function parseMcpInstall(query: string): DeeplinkRoute {
  const params = new URLSearchParams(query);
  const name = params.get("name");
  const config = params.get("config");
  if (!name || !config) {
    return { kind: "invalid", error: 'Missing "name" or "config" parameter in deep link.' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(config, "base64").toString("utf8"));
  } catch {
    return { kind: "invalid", error: "Invalid server configuration provided: Not valid JSON." };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "invalid", error: "Invalid server configuration provided: Must be a JSON object." };
  }
  return { kind: "mcp-install", request: { name, config: parsed as Record<string, unknown> } };
}

// ---------------------------------------------------------------------------
// `/command` — one-click custom-command creation (DEV-GAPS-64).
//
// Binary evidence (Cursor 3.25.9, extensions/cursor-deeplink/dist/main.js):
//   - route handler `zs` @ 427911: parses `name` + `text` query params
//     with an inline copy of the `Ws` scanner (boundary-checked, with a
//     try/catch decode helper `Hs`), throws
//     "Missing name or text parameter for command deeplink" when either
//     is absent, validates the name, then the content, and finally
//     `commands.executeCommand("deeplink.command.create", { name, content,
//     correlationId: crypto.randomUUID() })` (that string @ 430024).
//   - name validator (inline in `zs`): max length `const Ys = 100`
//     @ 426418 (the identifier `Ys` itself @ 426424).
//   - content validator `Vs` @ 425820 with Js = 1e4 @ 425021,
//     xs = "Invalid text for prompt" @ 425028, format regex Ls @ 425057,
//     repeated-decode helper Cs @ 425132, base64-token scanner qs @ 425380.
//   - query-value scanner `Ws` @ 426581 + value decoder `Ks`: a param value
//     ends at the next `&[A-Za-z][A-Za-z0-9_-]*=` boundary; `+` decodes to a
//     space; decodeURIComponent failures keep the raw value.
// All error strings below are verbatim.
// ---------------------------------------------------------------------------

/** Matches the `&nextParam=` boundary the binary's query scanner cuts on ($s). */
const PARAM_BOUNDARY_RE = /&[a-zA-Z][a-zA-Z0-9_-]*=/;

function decodeQueryValue(raw: string): string {
  const withSpaces = raw.replace(/\+/g, " ");
  try {
    return decodeURIComponent(withSpaces);
  } catch {
    return withSpaces;
  }
}

/**
 * The binary's `Ws(query, name)` scanner: find `name=` at the query start or
 * right after an `&` (skipping look-alikes inside other values), then read
 * until the next `&key=` boundary. Returns null when absent or empty.
 */
export function getDeeplinkQueryParam(query: string, name: string): string | null {
  if (!query) {
    return null;
  }
  const marker = `${name}=`;
  let pos = 0;
  for (;;) {
    const idx = query.indexOf(marker, pos);
    if (idx === -1) {
      return null;
    }
    if (!(idx === 0 || query[idx - 1] === "&")) {
      pos = idx + marker.length;
      continue;
    }
    const start = idx + marker.length;
    let end = query.length;
    const boundary = query.substring(start).match(PARAM_BOUNDARY_RE);
    if (boundary && typeof boundary.index === "number") {
      end = start + boundary.index;
    }
    const raw = query.substring(start, end);
    return raw ? decodeQueryValue(raw) : null;
  }
}

/** Parse the `/command` query. Null unless BOTH `name` and `text` are present. */
export function parseCommandDeeplink(query: string): { name: string; content: string } | null {
  const name = getDeeplinkQueryParam(query, "name");
  const content = getDeeplinkQueryParam(query, "text");
  if (!name || !content) {
    return null;
  }
  return { name, content };
}

// --- name validation (verbatim rules; "Command" wording for `/command`) ---

const MAX_DEEPLINK_NAME_LENGTH = 100; // binary: const Ys = 100
const CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;
const DEEPLINK_NAME_CHARSET_RE = /^[a-zA-Z0-9._-]+$/;
const WINDOWS_RESERVED_NAMES = [
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];
const TRAVERSAL_SUFFIX = "cannot contain path separators or directory traversal";

/**
 * Shared name-validation algorithm for `/command` and `/rule`. The binary
 * (cursor-deeplink dist/main.js, 3.25.9: route `zs` for command, `Zs` for
 * rule) implements the two validators with identical steps — required check,
 * length, raw control chars, control chars after up to 3 rounds of
 * percent-decoding (so `%2509`-style obfuscation is caught), path.normalize
 * traversal checks (incl. an NFC re-check), charset, and the Windows
 * reserved-name list — differing only in the "Command"/"Rule" wording of
 * the reason strings. `label` selects that wording.
 */
function validateDeeplinkName(name: string, label: "Command" | "Rule"): string | null {
  if (!name || name.trim().length === 0) {
    return `${label} name is required`;
  }
  if (name.length > MAX_DEEPLINK_NAME_LENGTH) {
    return `${label} name must be ${MAX_DEEPLINK_NAME_LENGTH} characters or less`;
  }
  if (CONTROL_CHAR_RE.test(name)) {
    return `${label} name cannot contain control characters`;
  }
  let decoded = name;
  for (let i = 0; i < 3; i++) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) {
        break;
      }
      decoded = next;
    } catch {
      break;
    }
  }
  if (CONTROL_CHAR_RE.test(decoded)) {
    return `${label} name cannot contain control characters`;
  }
  const normalized = path.normalize(decoded);
  if (normalized.split(path.sep).length !== 1) {
    return `${label} name ${TRAVERSAL_SUFFIX}`;
  }
  if (normalized.includes("..")) {
    return `${label} name ${TRAVERSAL_SUFFIX}`;
  }
  if (decoded.includes("/") || decoded.includes("\\")) {
    return `${label} name ${TRAVERSAL_SUFFIX}`;
  }
  if (decoded === "." || decoded === "..") {
    return `${label} name ${TRAVERSAL_SUFFIX}`;
  }
  const nfc = decoded.normalize("NFC");
  if (nfc !== decoded) {
    const nfcNormalized = path.normalize(nfc);
    if (nfcNormalized.split(path.sep).length !== 1 || nfcNormalized.includes("..")) {
      return `${label} name ${TRAVERSAL_SUFFIX}`;
    }
  }
  if (!DEEPLINK_NAME_CHARSET_RE.test(decoded)) {
    return `${label} name can only contain letters, numbers, dots, hyphens, and underscores`;
  }
  if (WINDOWS_RESERVED_NAMES.includes(decoded.toLowerCase())) {
    return `${label} name is reserved and cannot be used`;
  }
  return null;
}

/**
 * Validate a deeplink command name. Returns the verbatim reason string, or
 * null when valid.
 */
export function validateDeeplinkCommandName(name: string): string | null {
  return validateDeeplinkName(name, "Command");
}

/**
 * Validate a deeplink rule name. Returns the verbatim reason string, or
 * null when valid. Binary: `Zs` @ 430085 — same steps as the command
 * validator, "Rule" wording verbatim.
 */
export function validateDeeplinkRuleName(name: string): string | null {
  return validateDeeplinkName(name, "Rule");
}

// --- content validation (`Vs`, shared with `/rule` and `/prompt` in Cursor) ---

/** Binary Js = 1e4: `21 + encodeURIComponent(text).length` must not exceed it. */
const MAX_TEXT_ENCODED_LENGTH = 10000;
/** Binary xs. */
const INVALID_TEXT = "Invalid text for prompt";
/** Binary Ls: printable Unicode text only — rejects Unicode format chars (Cf) and DEL. */
const ALLOWED_TEXT_RE = /^(?!.*(?:\p{Cf}|\u007F))[\p{L}\p{M}\p{N}\p{P}\p{S}\p{Z}\r\n\t !-~]+$/u;

/** Binary Cs: lowercase, then up to 2 rounds of percent-decoding. */
function lowercaseAndDecode(v: string): string {
  let t = v.toLowerCase();
  for (let i = 0; i < 2; i++) {
    try {
      const d = decodeURIComponent(t);
      if (d === t) {
        break;
      }
      t = d;
    } catch {
      break;
    }
  }
  return t;
}

/** Binary js: up to 2 rounds of percent-decoding (case preserved). */
function decodeTwice(v: string): string {
  let t = v;
  for (let i = 0; i < 2; i++) {
    try {
      const d = decodeURIComponent(t);
      if (d === t) {
        break;
      }
      t = d;
    } catch {
      break;
    }
  }
  return t;
}

/**
 * Binary qs: split on whitespace; every token that looks like base64
 * (charset check, length % 4 === 0) is decoded to lowercased text, catching
 * injection payloads smuggled in base64 form.
 */
function base64DecodedTokens(v: string): string {
  const decoded: string[] = [];
  for (const token of v.split(/\s+/)) {
    if (/^[A-Za-z0-9+/=]+$/.test(token) && token.length % 4 === 0) {
      try {
        const text = Buffer.from(token, "base64").toString("utf8");
        if (text) {
          decoded.push(text.toLowerCase());
        }
      } catch {
        // undecodable token — ignored, same as the binary
      }
    }
  }
  return decoded.join(" ");
}

/** Binary-verbatim credential-theft patterns (`.env` check runs as its own pattern). */
const ENV_PATTERN = /\.env(\b|\W)/;
const CREDENTIAL_THEFT_PATTERNS = [
  /read.*\.env.*print/i,
  /cat.*\.ssh\/id_rsa/i,
  /upload.*passwords\.txt/i,
  /dump.*token/i,
  /dump.*password/i,
  /exfiltrate.*credential/i,
  /leak.*secret/i,
  /how.*extract.*credential/i,
];

/**
 * Binary guard: build the decoded variants exactly as Cursor does —
 * [lowercase, Cs(lowercase), Cs again, base64-decoded of raw,
 *  base64-decoded of twice-decoded] — and run the patterns over all of them.
 */
function hasCredentialTheftPayload(text: string): boolean {
  const lower = text.toLowerCase();
  const once = lowercaseAndDecode(lower);
  const twice = lowercaseAndDecode(once);
  const variants = [lower, once, twice];
  const fromRaw = base64DecodedTokens(text);
  if (fromRaw) {
    variants.push(fromRaw);
  }
  const fromDecoded = base64DecodedTokens(decodeTwice(text));
  if (fromDecoded) {
    variants.push(fromDecoded);
  }
  for (const variant of variants) {
    if (ENV_PATTERN.test(variant)) {
      return true;
    }
  }
  for (const variant of variants) {
    for (const pattern of CREDENTIAL_THEFT_PATTERNS) {
      if (pattern.test(variant)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Validate deeplink text content (the binary's `Vs`): empty/whitespace is
 * invalid, format/control characters are invalid, an encoded length over the
 * cap is invalid, and credential-theft injection payloads are invalid.
 * Returns "Invalid text for prompt" or null.
 */
export function validateDeeplinkText(text: string): string | null {
  if (!text || text.trim() === "") {
    return INVALID_TEXT;
  }
  if (!ALLOWED_TEXT_RE.test(text)) {
    return INVALID_TEXT;
  }
  if (21 + encodeURIComponent(text).length > MAX_TEXT_ENCODED_LENGTH) {
    return INVALID_TEXT;
  }
  if (hasCredentialTheftPayload(text)) {
    return INVALID_TEXT;
  }
  return null;
}

/**
 * Route the `/command` path: parse → name validation → content validation,
 * exactly the binary's order. Errors are the thrown messages, verbatim.
 */
export function parseCommandDeeplinkRoute(query: string): DeeplinkRoute {
  const parsed = parseCommandDeeplink(query);
  if (!parsed) {
    return { kind: "invalid", error: "Missing name or text parameter for command deeplink" };
  }
  const nameError = validateDeeplinkCommandName(parsed.name);
  if (nameError) {
    return { kind: "invalid", error: `Invalid command name: ${nameError}` };
  }
  const textError = validateDeeplinkText(parsed.content);
  if (textError) {
    return { kind: "invalid", error: textError };
  }
  return { kind: "command-create", name: parsed.name, content: parsed.content };
}

// ---------------------------------------------------------------------------
// `/rule` — one-click user-rule creation (matrix feature
// `deeplink-create-rule`).
//
// Binary evidence (Cursor 3.25.9, extensions/cursor-deeplink/dist/main.js):
//   - route handler `Zs` @ 430085, dispatched from the router @ 435638
//     (`"/rule"===n.path?await Zs(n)`).
//   - PARSER DIFFERS FROM `/command` (binary-verified; W68B finding F1,
//     mirrored in W70B): `Zs` does NOT use the `Ws` scanner. It carries
//     its own inline parser — bare `indexOf("name=")` @ 430188 and
//     `indexOf("text=")` @ 430389 with NO param-boundary check (a
//     `name=` look-alike inside another value, even `xname=`, matches),
//     the value cut at the same `&key=` boundary regex, `+` → space,
//     then a BARE `decodeURIComponent` with no try/catch: a malformed
//     `%` sequence throws URIError out of `Zs` (gated by the extension
//     host's error dialog, as in the binary's handler). Null unless
//     BOTH decoded values are non-empty.
//   - throws "Missing name or text parameter for rule deeplink"
//     @ 430643 when either is absent, validates the name (same steps as
//     `/command`, "Rule" wording), validates the content with the
//     shared `Vs` validator, then
//     `commands.executeCommand("deeplink.rule.create", { name, content,
//     correlationId: crypto.randomUUID() })` (that string @ 432213).
//   - name error wrapper: `Invalid rule name: ${reason}` (verbatim).
// ---------------------------------------------------------------------------

/**
 * Parse the `/rule` query — an exact port of the binary `Zs` handler's
 * OWN inline parser (see the evidence block above): bare `indexOf` for
 * `name=`/`text=` with no boundary check, value cut at the next `&key=`
 * boundary, `+` → space, and an UNCAUGHT `decodeURIComponent` —
 * malformed percent-encoding throws URIError, exactly as in the binary
 * (the extension host's catch turns it into the error dialog, mirroring
 * the binary). Deliberately NOT the `Ws` scanner `/command` + `/prompt`
 * use: in the binary the two routes genuinely parse differently.
 */
export function parseRuleDeeplink(query: string): { name: string; content: string } | null {
  if (!query) {
    return null;
  }
  let name: string | null = null;
  let content: string | null = null;
  const nameIdx = query.indexOf("name=");
  if (nameIdx !== -1) {
    const start = nameIdx + "name=".length;
    let end = query.length;
    const boundary = query.substring(start).match(PARAM_BOUNDARY_RE);
    if (boundary && typeof boundary.index === "number") {
      end = start + boundary.index;
    }
    name = decodeURIComponent(query.substring(start, end).replace(/\+/g, " "));
  }
  const textIdx = query.indexOf("text=");
  if (textIdx !== -1) {
    const start = textIdx + "text=".length;
    let end = query.length;
    const boundary = query.substring(start).match(PARAM_BOUNDARY_RE);
    if (boundary && typeof boundary.index === "number") {
      end = start + boundary.index;
    }
    content = decodeURIComponent(query.substring(start, end).replace(/\+/g, " "));
  }
  return name && content ? { name, content } : null;
}

/**
 * Route the `/rule` path: parse → name validation → content validation,
 * exactly the binary's order. Errors are the thrown messages, verbatim.
 * One deliberate non-`invalid` outcome, mirroring the binary: malformed
 * percent-encoding propagates out of `parseRuleDeeplink` as a URIError
 * (the binary's bare `decodeURIComponent`), which the extension host
 * catches into its "Error handling deep link" dialog.
 */
export function parseRuleDeeplinkRoute(query: string): DeeplinkRoute {
  const parsed = parseRuleDeeplink(query);
  if (!parsed) {
    return { kind: "invalid", error: "Missing name or text parameter for rule deeplink" };
  }
  const nameError = validateDeeplinkRuleName(parsed.name);
  if (nameError) {
    return { kind: "invalid", error: `Invalid rule name: ${nameError}` };
  }
  const textError = validateDeeplinkText(parsed.content);
  if (textError) {
    return { kind: "invalid", error: textError };
  }
  return { kind: "rule-create", name: parsed.name, content: parsed.content };
}

// ---------------------------------------------------------------------------
// Debug command — `cursor-deeplink.debug.triggerDeeplink` (matrix feature
// `deeplink-debug-trigger`, DEV-GAPS-70/W70D-R3).
//
// Binary evidence (Cursor 3.25.9, extensions/cursor-deeplink/package.json +
// dist/main.js):
//   - package.json contributes exactly one command:
//     {command: "cursor-deeplink.debug.triggerDeeplink",
//      title: "Debug: Trigger Arbitrary Deeplink",
//      category: "Cursor Deeplink"}.
//   - dist/main.js @ 437536 registers it:
//     registerCommand("cursor-deeplink.debug.triggerDeeplink", async () => {
//       const t = await window.showInputBox({
//         prompt: "Enter a deeplink URL to test (e.g., " +
//           "cursor://anysphere.cursor-deeplink/command/create?name=test&content=...)",
//         placeHolder: "cursor://anysphere.cursor-deeplink/...",
//         validateInput: t => {
//           if (!t) return "Please enter a deeplink URL";
//           try {
//             const n = Uri.parse(t);
//             return "cursor" !== n.scheme ||
//                    "anysphere.cursor-deeplink" !== n.authority
//               ? "URL must start with cursor://anysphere.cursor-deeplink/"
//               : null;
//           } catch { return "Invalid URL format"; }
//         }});
//       if (t) try { await handler.handleUri(Uri.parse(t)); }
//              catch (e) { showErrorMessage(`Error processing deeplink: …`) }
//     });
//   The fork keeps the same mechanism (extension-layer command →
//   showInputBox → the shared URI handler) and substitutes only the
//   product scheme/authority in the strings — the fork's established
//   deeplink convention (see routeDeeplink's invalid error above and the
//   IMPLEMENTED deeplink-create-command / deeplink-create-rule entries).
// ---------------------------------------------------------------------------

/** Input-box prompt for the debug command (binary verbatim modulo scheme/authority). */
export const DEBUG_TRIGGER_PROMPT =
  `Enter a deeplink URL to test (e.g., ${DEEPLINK_SCHEME}://${DEEPLINK_AUTHORITY}/command/create?name=test&content=...)`;
/** Input-box placeholder for the debug command (binary verbatim modulo scheme/authority). */
export const DEBUG_TRIGGER_PLACEHOLDER = `${DEEPLINK_SCHEME}://${DEEPLINK_AUTHORITY}/...`;
/** validateInput message for empty input (binary verbatim). */
export const DEBUG_TRIGGER_EMPTY_MESSAGE = "Please enter a deeplink URL";
/** validateInput message for a wrong scheme/authority (binary verbatim modulo scheme/authority). */
export const DEBUG_TRIGGER_PREFIX_MESSAGE =
  `URL must start with ${DEEPLINK_SCHEME}://${DEEPLINK_AUTHORITY}/`;
/** validateInput message when the value does not parse as a URI (binary verbatim). */
export const DEBUG_TRIGGER_INVALID_MESSAGE = "Invalid URL format";

/**
 * The debug command's `validateInput`, ported 1:1 from the binary: empty
 * → "Please enter a deeplink URL"; unparseable → "Invalid URL format";
 * wrong scheme/authority → the "URL must start with …" message; otherwise
 * null (valid). `parse` is the host's URI parser (vscode.Uri.parse in the
 * extension; a stub in tests) — only its throw / scheme / authority are
 * observed, exactly as in the binary.
 */
export function validateDebugDeeplinkInput(
  value: string,
  parse: (value: string) => { scheme: string; authority: string },
): string | null {
  if (!value) {
    return DEBUG_TRIGGER_EMPTY_MESSAGE;
  }
  try {
    const parsed = parse(value);
    return parsed.scheme !== DEEPLINK_SCHEME || parsed.authority !== DEEPLINK_AUTHORITY
      ? DEBUG_TRIGGER_PREFIX_MESSAGE
      : null;
  } catch {
    return DEBUG_TRIGGER_INVALID_MESSAGE;
  }
}

// ---------------------------------------------------------------------------
// `/prompt` — prefill the chat prompt from a link (matrix features
// `deeplink-prompt-prefill` + `deeplink-prompt-injection-guard`).
//
// Binary evidence (Cursor 3.25.9, extensions/cursor-deeplink/dist/main.js):
//   - route handler `Xs` (dispatched from the router: `"/prompt"===n.path ?
//     await Xs(n)`): reads the `text` query param with the binary's own
//     scanner (`Ws` — the same scanner ported above as
//     `getDeeplinkQueryParam`), throws
//     "Missing text parameter for prompt deeplink" when absent OR empty
//     (the scanner returns null for an empty value), then runs the shared
//     `Vs` text validator (`validateDeeplinkText` above — format/control
//     character rejection, the `21 + encodeURIComponent(text).length > 1e4`
//     cap, and the credential-theft injection guard over percent- and
//     base64-decoded variants) and throws its message
//     ("Invalid text for prompt") on failure.
//   - after validation it resolves the optional `workspace` param (handled
//     by the extension host — it needs the live window list) and fires
//     `commands.executeCommand("deeplink.prompt.prefill", { text,
//     mode: Ws(query, "mode") ?? undefined })`.
// ---------------------------------------------------------------------------

/**
 * Route the `/prompt` path: parse → validate, exactly the binary's order.
 * Errors are the thrown messages, verbatim. The `workspace` param is NOT
 * consumed here: the binary routes to another window AFTER validation, in
 * extension-host code, so `parsePromptDeeplinkRoute` deliberately leaves
 * it for `extension.ts` (see `handleDeeplinkUri`).
 */
export function parsePromptDeeplinkRoute(query: string): DeeplinkRoute {
  const text = getDeeplinkQueryParam(query, "text");
  if (!text) {
    return { kind: "invalid", error: "Missing text parameter for prompt deeplink" };
  }
  const textError = validateDeeplinkText(text);
  if (textError) {
    return { kind: "invalid", error: textError };
  }
  const mode = getDeeplinkQueryParam(query, "mode");
  return { kind: "prompt-prefill", text, mode: mode ?? undefined };
}

// ---------------------------------------------------------------------------
// Settings + Customize + plugin + glass routes (DEV-GAPS-110, matrix
// feature `deeplink-ai-settings-routes` + the customize/plugin/glass
// entries from the same binary route table).
//
// Binary evidence (Cursor 3.25.9, extensions/cursor-deeplink/dist/main.js,
// byte offsets in that file):
//   - constants @423793: Ns = "workbench.action.openCustomizeEditor",
//     ks = "aiSettings.action.open" @423835, Is = "/customize" @423862,
//     Os = "/customize/marketplace" @423878,
//     Ps = new Set(["plugins","mcps","rules","hooks"]).
//   - `Ms(query)` @~4239xx: `new URLSearchParams(query).get("pluginId")
//     ?.trim() || undefined` (ported as parseDeeplinkPluginId below).
//   - `As(pluginId?)` (customize detail/browse): try Ns with
//     {initialView:{kind:"browse"}} (no pluginId) or
//     {initialView:{kind:"detail",pluginId}}; on error, ONLY when `Fs(err,
//     Ns)` (error message includes Ns AND lowercased includes "command")
//     fall back to `Rs("plugins")` = aiSettings.action.open("plugins");
//     any other error is rethrown. The try/catch + fallback live in
//     extension.ts (`openCustomizeDeeplink`), this layer only classifies.
//   - `Bs(uri)` (/customize + /customize/marketplace): marketplace →
//     As(Ms(query)). Otherwise tab = URLSearchParams.get("tab"): null/""
//     → undefined; "mcp" → "mcps"; must be in Ps else undefined. Then try
//     Ns {initialView:{kind:"manage",tab,scope:"user"}} (or Ns with NO
//     argument when tab is undefined), Fs-fallback → Rs(tab) =
//     aiSettings.action.open(tab === "mcps" ? "mcp" : tab), or
//     aiSettings.action.open() with no argument when tab is undefined.
//   - settings handler (router @435052, dispatched on
//     path.startsWith("/settings")): startsWith
//     "/settings/background-composer" @435110 →
//     aiSettings.action.open("background-composer"); else startsWith
//     "/settings/plugins" @435249 → pluginId = Ms(query): defined →
//     As(pluginId), else aiSettings.action.open("plugins"); else
//     startsWith "/settings/plan-usage" @435417 →
//     aiSettings.action.open("plan-usage"); else
//     aiSettings.action.open() with NO argument.
//   - `/plugin/add` @436270: id = URLSearchParams.get("id")?.trim();
//     truthy → Ns {initialView:{kind:"detail",pluginId:id}} DIRECTLY (no
//     Fs fallback in the binary); falsy → showErrorMessage(
//     'Missing "id" parameter in deep link.') @436482.
//   - glass routes: "/background-agent" @434450 / "/agent" @434480 /
//     "/create-project" @434725 / "/plugin/install-and-prompt" @436525 →
//     cursor.openOrFocusGlassWindow {agentsWindowOpenSource:"deeplink",
//     startupHandoff:false, deeplinkUrl: uri.toString(true)};
//     "/glass" @436785 → target = query "target" trimmed + lowercased:
//     "cloud" → the same handoff payload; anything else →
//     {agentsWindowOpenSource:"deeplink"} ONLY.
//
// HONEST-DIVERGENCES (fork destinations, handled in extension.ts):
//   - `aiSettings.action.open` is NOT registered anywhere in this fork.
//     extension.ts tries the verbatim id first (forward-compatible; the
//     same try-a-command-and-fall-back pattern this extension already
//     uses for `deeplink.routeToWorkspaceName`, and the binary itself
//     uses for Ns) and falls back to the fork's existing AI-settings
//     surface, `workbench.action.openSettings` with query "ide.agent"
//     (the exact fallback `ide.openAgentSettings` already uses).
//   - The fork has NO Settings pages for the "background-composer" or
//     "plan-usage" sections, so those sections fall back to the generic
//     agent-settings open above (the caveat the GAPS-97C shortlist #6
//     recorded in advance). "plugins" without a pluginId does the same;
//     the fork's real Plugins management surface is the Customize
//     editor, reached via /customize, /customize/marketplace,
//     /plugin/add and /settings/plugins?pluginId=….
//   - The fork's Customize editor does not consume the `initialView`
//     argument (its `workbench.action.openCustomizeEditor` handler is
//     registered with no parameters), so a detail/manage view is not
//     pre-selected beyond what extension.ts maps to the per-tab
//     customize commands; the payload is still forwarded verbatim.
//   - The fork's glass analog `ide.openOrFocusGlassWindow` reads only
//     `agentsWindowOpenSource`; `startupHandoff`/`deeplinkUrl` are
//     forwarded verbatim but currently have no consumer, so the window
//     opens/focuses and the handoff is dropped.
//
// NOT IMPLEMENTED (kept as unknown-path — no handler is invented for a
// destination this fork does not have):
//   - "/createchat": payload is validated against JWT keys fetched from
//     the Cursor backend (RS256, listJwtPublicKeys) or an unsigned v1
//     schema — cloud/backend dependent.
//   - "/background-agent/setup": destination command
//     `workbench.action.backgroundComposer.startSetup` @434401 does not
//     exist in the fork.
//   - "/automations" + "/automations/*": gated on the Cursor-only
//     extension API `cursor.checkFeatureGate` ("glass_automations_ui"
//     @433390 / "custom_agents_enabled" @433416) and an Automations
//     surface the fork does not have.
//   - "/pr-review": destination command `deeplink.prReview.open`
//     @436066 does not exist in the fork.
//   - "/github-connect-callback": OAuth callback into
//     `cursor.githubConnect.completeCallback` @432281 (with a
//     [250,500,1000,2000,3500]ms command-not-found retry loop) — needs
//     the GitHub-connect backend; the shortlist explicitly did not
//     promise this one locally.
// ---------------------------------------------------------------------------

/** The binary's `Ms`: the `pluginId` query param, trimmed; empty → undefined. */
export function parseDeeplinkPluginId(query: string): string | undefined {
  const pluginId = new URLSearchParams(query).get("pluginId")?.trim();
  return pluginId || undefined;
}

/**
 * Route any path starting with `/settings` (the binary dispatches on
 * `startsWith`, in this exact branch order): background-composer, then
 * plugins (a `pluginId` switches to the binary's `As` customize-detail
 * route), then plan-usage, else the no-argument settings open.
 */
export function parseSettingsDeeplinkRoute(path: string, query: string): DeeplinkRoute {
  if (path.startsWith("/settings/background-composer")) {
    return { kind: "settings-open", section: "background-composer" };
  }
  if (path.startsWith("/settings/plugins")) {
    const pluginId = parseDeeplinkPluginId(query);
    if (pluginId !== undefined) {
      return { kind: "customize-open", initialView: { kind: "detail", pluginId } };
    }
    return { kind: "settings-open", section: "plugins" };
  }
  if (path.startsWith("/settings/plan-usage")) {
    return { kind: "settings-open", section: "plan-usage" };
  }
  return { kind: "settings-open" };
}

/** The binary's `/customize` tab mapping: "mcp"→"mcps", Ps membership, else undefined. */
export function parseCustomizeDeeplinkTab(query: string): CustomizeDeeplinkTab | undefined {
  const tab = new URLSearchParams(query).get("tab");
  if (tab === null || tab === "") {
    return undefined;
  }
  const mapped = tab === "mcp" ? "mcps" : tab;
  return mapped === "plugins" || mapped === "mcps" || mapped === "rules" || mapped === "hooks"
    ? mapped
    : undefined;
}

/**
 * Route `/customize` and `/customize/marketplace` (the binary's `Bs`):
 * marketplace → `As(Ms(query))` (browse/detail); plain customize → the
 * manage view for a valid `tab`, else a no-argument customize open.
 */
export function parseCustomizeDeeplinkRoute(path: string, query: string): DeeplinkRoute {
  if (path === "/customize/marketplace") {
    const pluginId = parseDeeplinkPluginId(query);
    return {
      kind: "customize-open",
      initialView: pluginId !== undefined ? { kind: "detail", pluginId } : { kind: "browse" },
    };
  }
  const tab = parseCustomizeDeeplinkTab(query);
  return {
    kind: "customize-open",
    initialView: tab !== undefined ? { kind: "manage", tab, scope: "user" } : undefined,
  };
}

/**
 * Route `/plugin/add` (binary @436270): a trimmed `id` param → the
 * customize detail view for that plugin; missing/empty → the verbatim
 * error message (the binary shows it via showErrorMessage, which is
 * exactly what this extension does with the `invalid` kind).
 */
export function parsePluginAddDeeplinkRoute(query: string): DeeplinkRoute {
  const id = new URLSearchParams(query).get("id")?.trim();
  if (!id) {
    return { kind: "invalid", error: 'Missing "id" parameter in deep link.' };
  }
  return { kind: "customize-open", initialView: { kind: "detail", pluginId: id } };
}

/**
 * Route `/glass` (binary @436785): `target=cloud` (trimmed, lowercased)
 * → glass open WITH the deeplink handoff payload; any other target →
 * glass open with only the source field.
 */
export function parseGlassDeeplinkRoute(query: string, deeplinkUrl: string): DeeplinkRoute {
  const target = new URLSearchParams(query).get("target")?.trim().toLowerCase();
  if (target === "cloud") {
    return {
      kind: "glass-open",
      agentsWindowOpenSource: "deeplink",
      startupHandoff: false,
      deeplinkUrl,
    };
  }
  return { kind: "glass-open", agentsWindowOpenSource: "deeplink" };
}
