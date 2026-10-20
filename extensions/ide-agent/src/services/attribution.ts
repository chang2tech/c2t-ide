/**
 * DEV-GAPS-145 `settings-attribution` — Commit/PR Attribution ("Made with
 * Cursor"), pure helpers (Cursor parity).
 *
 * Evidence (Cursor 3.25.9, re-sliced by GAPS-145; full notes in
 * `ide-code-mission/docs/rea/work-notes-gaps145.md`):
 *
 *  Registry (workbench.desktop.main.js @37341169, glass @28387642):
 *    hl("git-prs","attribution",{label:"Attribution"}),
 *    hl("git-prs","commit-attribution",{label:"Commit Attribution"}),
 *    hl("git-prs","pr-attribution",{label:"PR Attribution"})
 *
 *  Storage descriptor (desk @14324679, reactive applicationUserPersistentStorage):
 *    attributeCommitsToAgent:Jh(!0,-1,0), attributePRsToAgent:Jh(!0,-1,0)
 *  → both booleans, DEFAULT TRUE (`!0`).
 *
 *  Settings UI control `B5k` (desk @37595653):
 *    [i,r]=Tce("attributeCommitsToAgent"), [s,o]=Tce("attributePRsToAgent")
 *    a = adminLocked ? " (controlled by admin)" : ""
 *    description commit: `Mark Agent commits as 'Made with Cursor'${a}`, label "Commit Attribution"
 *    description PR:     `Mark pull requests as made with Cursor${a}`,  label "PR Attribution"
 *    checked when admin-locked: forced !1 (false); switch disabled.
 *    on change: analytics `ide_settings.setting_changed`
 *      {settingId:"attribute_commits_to_agent"|"attribute_prs_to_agent", section:"attribution", value:String(v)}
 *
 *  Consumer — agent request context (desk @19591501 and @31612592/@31614933;
 *  glass @21001830):
 *    b = !adminSettingsService.isAttributionDisabledByAdmin()
 *        && (storageService "attributeCommitsToAgent" ?? !0)
 *    y = !adminDisabled && (storageService "attributePRsToAgent" ?? !0)
 *    new RequestContext({ ..., commitAttributionMessage: b ? "enabled" : void 0,
 *                               prAttributionMessage:     y ? "enabled" : void 0 })
 *  The workbench inserts NO trailer itself: it sends the string "enabled"
 *  (or omits the field) in the request-context proto; the agent backend /
 *  agent host applies the attribution. Admin lock:
 *    isAttributionDisabledByAdmin(){return getCached().attributionControls?.disableAttribution ?? !1}
 *    (desk @16154522 — team-admin cached setting, default false).
 *
 *  Attribution identity/trailer (workbench.glass.main.js @617935, lazy module
 *  "commit-identity.ts" in the agent-host module set):
 *    agentName = "Cursor", agentEmail = "cursoragent@cursor.com",
 *    trailer = `Co-authored-by: ${agentName} <${agentEmail}>`
 *    knownAgentEmails = ["cursoragent@cursor.com", "noreply@cursor.com"],
 *    isKnownEmail(e) = knownAgentEmails.includes(e.trim().toLowerCase())
 *
 * Fork wiring (this module is the testable core; VS Code-facing parts live
 * in `ideCodeEngineAdapter.ts` + package.json):
 *  - Settings surface: `ide.git.attributeCommitsToAgent` /
 *    `ide.git.attributePRsToAgent` in contributes.configuration ("IDE Git &
 *    PRs"), following the bugbot precedent — Cursor's toggles live in its
 *    React Settings UI over reactive storage; a VS Code configuration entry
 *    is this fork's settings-UI equivalent. Defaults match the binary (true).
 *  - Consumer: the engine adapter resolves the flags per turn and spreads
 *    `commitAttributionMessage:"enabled"` / `prAttributionMessage:"enabled"`
 *    into the prompt request body ONLY when effective — byte-for-byte the
 *    binary's client behaviour (field present as "enabled", omitted when off).
 *  - HONEST-DIVERGENCE: Cursor's mechanical trailer insertion happens in its
 *    agent backend/agent host, driven by the proto flag. This fork's engine
 *    (OpenCode-derived sidecar) has no agent-commit path — agent commits are
 *    model-issued shell commands — so there is no local commit site to
 *    attach the insertion to yet. `getCommitAttribution` /
 *    `applyCommitAttribution` below implement the verbatim trailer so the
 *    engine/commit path can consume them unchanged; the fork also has no
 *    team-admin service, so the admin lock resolves to false locally (the
 *    resolver still implements the binary formula, lock included).
 *
 * node-testable: no vscode imports here.
 */

/** Reactive-storage keys in Cursor (verbatim). */
export const ATTRIBUTION_COMMITS_STORAGE_KEY = "attributeCommitsToAgent";
export const ATTRIBUTION_PRS_STORAGE_KEY = "attributePRsToAgent";

/** Analytics setting ids fired on toggle (verbatim, desk B5k handlers). */
export const ATTRIBUTION_COMMITS_ANALYTICS_ID = "attribute_commits_to_agent";
export const ATTRIBUTION_PRS_ANALYTICS_ID = "attribute_prs_to_agent";
/** Analytics section + event name (verbatim, desk Z6m @37592943). */
export const ATTRIBUTION_ANALYTICS_SECTION = "attribution";
export const ATTRIBUTION_ANALYTICS_EVENT = "ide_settings.setting_changed";

/** Binary defaults: `Jh(!0,-1,0)` for both keys (desk @14324679). */
export const ATTRIBUTION_COMMITS_DEFAULT = true;
export const ATTRIBUTION_PRS_DEFAULT = true;

/** Settings-UI strings (verbatim, desk B5k @37595653). */
export const ATTRIBUTION_SECTION_LABEL = "Attribution";
export const COMMIT_ATTRIBUTION_LABEL = "Commit Attribution";
export const PR_ATTRIBUTION_LABEL = "PR Attribution";
export const COMMIT_ATTRIBUTION_DESCRIPTION = "Mark Agent commits as 'Made with Cursor'";
export const PR_ATTRIBUTION_DESCRIPTION = "Mark pull requests as made with Cursor";
/** Suffix appended to both descriptions when the admin lock is on (verbatim). */
export const ATTRIBUTION_ADMIN_SUFFIX = " (controlled by admin)";

/** Fork settings surface (contributes.configuration keys). */
export const ATTRIBUTION_CONFIG_SECTION = "ide.git";
export const ATTRIBUTION_COMMITS_CONFIG_KEY = "attributeCommitsToAgent";
export const ATTRIBUTION_PRS_CONFIG_KEY = "attributePRsToAgent";

/** Agent commit identity (verbatim, glass commit-identity.ts @617935). */
export const CURSOR_AGENT_NAME = "Cursor";
export const CURSOR_AGENT_EMAIL = "cursoragent@cursor.com";
/** The trailer line, template-expanded verbatim: `Co-authored-by: Cursor <cursoragent@cursor.com>`. */
export const COMMIT_ATTRIBUTION_TRAILER = `Co-authored-by: ${CURSOR_AGENT_NAME} <${CURSOR_AGENT_EMAIL}>`;
/** Known Cursor agent emails (verbatim list `zyd`, glass @617972). */
export const KNOWN_CURSOR_AGENT_EMAILS: readonly string[] = [
  CURSOR_AGENT_EMAIL,
  "noreply@cursor.com",
];

/** The request-context flag value the binary sends when attribution is on. */
export const ATTRIBUTION_ENABLED_FLAG = "enabled";

/**
 * Mirror of glass `Gyd` (commit-identity.ts): is this email one of the known
 * Cursor agent emails? Binary semantics: `t.email?.trim().toLowerCase()`
 * must be defined and included in the known list.
 */
export function isKnownCursorAgentEmail(email: string | undefined | null): boolean {
  if (email === undefined || email === null) return false;
  const normalized = email.trim().toLowerCase();
  if (normalized.length === 0) return false;
  return KNOWN_CURSOR_AGENT_EMAILS.includes(normalized);
}

/**
 * The commit-identity trailer when attribution is enabled, `undefined`
 * when it is not. (The trailer constant itself is verbatim from glass
 * commit-identity.ts; its consuming call site is not textually visible in
 * the workbench bundles — module-registry indirection — so this helper
 * encodes the evidenced on/off semantics only, no invented call shape.)
 */
export function getCommitAttribution(enabled: boolean): string | undefined {
  return enabled ? COMMIT_ATTRIBUTION_TRAILER : undefined;
}

export interface AttributionSettingsInput {
  /** Team-admin lock (`attributionControls.disableAttribution`); fork local = false. */
  adminDisabledByAdmin: boolean;
  /** Stored `attributeCommitsToAgent`; `undefined` = unset (binary fallback `?? !0`). */
  attributeCommitsToAgent: boolean | undefined;
  /** Stored `attributePRsToAgent`; `undefined` = unset (binary fallback `?? !0`). */
  attributePRsToAgent: boolean | undefined;
}

export interface AttributionRequestContext {
  /** Present as `"enabled"` only when effective; omitted otherwise (proto semantics). */
  commitAttributionMessage?: typeof ATTRIBUTION_ENABLED_FLAG;
  prAttributionMessage?: typeof ATTRIBUTION_ENABLED_FLAG;
}

/**
 * The binary's consumer formula (desk @19591501 / @31612592), verbatim:
 *   effective = !isAttributionDisabledByAdmin() && (stored ?? true)
 * Admin lock wins over a stored `true` (the settings UI likewise forces the
 * switch off + disabled when locked).
 */
export function resolveAttributionRequestContext(
  input: AttributionSettingsInput,
): AttributionRequestContext {
  const commitEnabled =
    !input.adminDisabledByAdmin &&
    (input.attributeCommitsToAgent ?? ATTRIBUTION_COMMITS_DEFAULT);
  const prEnabled =
    !input.adminDisabledByAdmin &&
    (input.attributePRsToAgent ?? ATTRIBUTION_PRS_DEFAULT);
  return {
    ...(commitEnabled ? { commitAttributionMessage: ATTRIBUTION_ENABLED_FLAG } : {}),
    ...(prEnabled ? { prAttributionMessage: ATTRIBUTION_ENABLED_FLAG } : {}),
  };
}

/** Effective on/off for each toggle (same formula, boolean form). */
export function isCommitAttributionEnabled(input: AttributionSettingsInput): boolean {
  return (
    !input.adminDisabledByAdmin &&
    (input.attributeCommitsToAgent ?? ATTRIBUTION_COMMITS_DEFAULT)
  );
}

export function isPRAttributionEnabled(input: AttributionSettingsInput): boolean {
  return (
    !input.adminDisabledByAdmin &&
    (input.attributePRsToAgent ?? ATTRIBUTION_PRS_DEFAULT)
  );
}

/**
 * Apply the commit attribution trailer to a commit message — the mechanical
 * step Cursor's agent backend performs when `commitAttributionMessage` is
 * "enabled". Appends the verbatim trailer as its own trailer paragraph
 * (blank-line separated). Idempotent: a message already carrying the exact
 * trailer line is returned unchanged. When `enabled` is false the message
 * is returned untouched.
 */
export function applyCommitAttribution(message: string, enabled: boolean): string {
  const trailer = getCommitAttribution(enabled);
  if (trailer === undefined) return message;
  const trimmed = message.replace(/\s+$/, "");
  if (trimmed.length === 0) return trailer;
  const lines = trimmed.split("\n");
  if (lines.some((line) => line.trim() === trailer)) return trimmed;
  return `${trimmed}\n\n${trailer}`;
}
