/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';

/**
 * IDE-CODE (DEV-GAPS-147, settings-open-local-links): pure definitions for
 * Cursor's Settings › Browser › "Open Local Links in Cursor Browser".
 *
 * QA step 1 — evidence, self-verified 2026-10-20 against the Cursor 3.25.9
 * binary (`workbench.desktop.main.js`; glass bundle identical at the
 * offsets noted in docs/rea/work-notes-gaps147.md):
 *
 * - The settings-search registry row (desk @37322502, function `IPk`) is
 *   only an index entry: `{id:\`setting:browser:show-localhost-links\`,
 *   label: "Open Local Links in Cursor Browser", description:
 *   "Automatically open localhost links in the Browser Tab",
 *   destination:{kind:"label",…}}`. The sibling row
 *   `setting:browser:open-web-links` ("Open Web Links in Cursor Browser",
 *   "Automatically open http and https links in the Browser Tab") is
 *   pushed ONLY when `surface === "glass"`.
 * - The setting itself is a Cursor reactive-storage preference, NOT a VS
 *   Code configuration property. Storage schema (desk @14326223, glass
 *   @16332322): `autoOpenLocalhostUrls:Jh(!0,-1,0)` and
 *   `glassOpenWebLinksInBrowser:Jh(!1,-1,0)`, where `Jh` is the boolean
 *   codec `{fromStorage: i => i === "true", toStorage: i => i ? "true" :
 *   "false", defaultValue, storageScope, storageTarget}` and the physical
 *   storage key is `"cursor/" + name` (`uGt`). So the VERBATIM facts are:
 *   default **true**, storageScope **-1 (APPLICATION)**, storageTarget
 *   **0 (USER)** for `autoOpenLocalhostUrls`; default **false** for the
 *   glass-only sibling.
 * - The Browser settings UI (desk @37476953) renders a switch bound to
 *   the storage key through a hook whose fallback defaults are
 *   `EOk={autoOpenLocalhostUrls:!0,glassOpenWebLinksInBrowser:!1}`; the
 *   localhost switch is always rendered, the web-links switch only when
 *   `isGlass === true`.
 * - The localhost classifier is `lqt` (desk @16936848, module
 *   `tunnel.js`), ported verbatim as {@link isLocalhostUrl} below, with
 *   its helpers `pBn` ({@link normalizeLocalhostUrl}) and `gph`
 *   ({@link isSameAuthorityAsUrl}).
 * - The primary consumer is the FIRST opener pushed into Cursor's
 *   OpenerService (desk @32435883, glass @40939356), ported as
 *   {@link resolveLocalLinkBrowserOpen} below and wired in
 *   electron-browser/features/openLocalLinksOpener.ts.
 *
 * HONEST-DIVERGENCE (fork architecture), following the established fork
 * precedent for Cursor storage-backed settings (DEV-GAPS-103
 * common/autoHideEditor.ts, DEV-GAPS-83/75 in
 * common/composerConfiguration.ts): the fork has no Cursor-style reactive
 * storage settings page, so the setting is exposed as the VS Code
 * configuration {@link OPEN_LOCAL_LINKS_CONFIG_KEY} in the IDE Code ›
 * Browser & Network section — same default (true), same verbatim
 * description, APPLICATION scope matching the binary's storageScope -1.
 * Divergences that remain (evidence in work-notes-gaps147.md §1.5):
 *  1. The binary's `workbench.action.openBrowserEditor` accepts
 *     `trackingId:"opener_service"` and a privacy-derived `transient`
 *     flag; the fork's action does not honor those options (already
 *     documented in browserTabPaletteCommands.ts).
 *  2. The binary shows a UrlOpenToast after an auto-open whose primary
 *     action disables the setting. CORRECTED by DEV-GAPS-159 (QA-155
 *     NF-2): the nls texts ARE quotable verbatim — they live in
 *     `out/nls.messages.json` of the reference tree (index↔message
 *     alignment cross-verified at 10+ independent indices): 12224 =
 *     "Opening {0} in Cursor Browser", 12225 = "Don't Open", and the C5
 *     terminal-hover suffix 10782 = ", hold shift for your browser".
 *     The toast (binary service `urlOpenToastService`, desk @20961744)
 *     is implemented on the fork's C1 path in
 *     electron-browser/features/openLocalLinksOpener.ts with the fork's
 *     INotificationService/IStorageService; the dedupe logic is
 *     {@link UrlOpenToastTracker} below. Remaining difference: the
 *     binary's "Don't Open" action writes Cursor's reactive storage,
 *     the fork's writes this configuration key to false — same
 *     user-visible effect (the setting turns off).
 *  3. The binary's backend-authority exclusion reads the Cursor backend
 *     URL from its credentials service; the fork has no such service, so
 *     the contribution passes no backend URL and the exclusion is
 *     vacuous (the check itself is ported and unit-tested).
 *  4. Consumer C2 (OpenBrowserUrlsService + terminal OpenInBrowserWatcher
 *     + local-server probe) has no fork equivalent at all and is NOT
 *     replicated here; the setting's click-routing consumer (C1) is.
 *  5. The glass-only sibling `glassOpenWebLinksInBrowser` and its
 *     consumers (glass agent link handler, glass trusted-domain
 *     validator) target the Agents Window glass surface, which the fork
 *     does not have; its constants are recorded below but NO fork
 *     configuration is registered for it (a registration without a
 *     consumer would be a dead setting).
 *  6. The fork's upstream VS Code base carries its OWN localhost-link
 *     mechanism that the binary does not have at all: the configuration
 *     `workbench.browser.openLocalhostLinks` (default false) consumed by
 *     `LocalhostLinkOpenerContribution`, an `IExternalOpener`. In
 *     `OpenerService.open()` contributed external openers run BEFORE the
 *     `_openers` loop (openerService.ts:199-207), so the upstream opener
 *     pre-empted this interceptor on every `allowContributedOpeners`
 *     caller: it swallowed links with a narrower classifier (no
 *     127.0.0.0/8, no trailing-dot handling, no `pBn` rewrite, no
 *     ssh-remote exclusion) and it opened links even when this setting
 *     was false. DEV-GAPS-159 (QA-155 NF-1) gates that provider with
 *     {@link resolveLegacyLocalhostLinkOpenerDecision}: it never opens a
 *     link itself anymore, so the legacy setting is effectively a no-op
 *     for the open decision (its registration is kept for schema
 *     compatibility) and this interceptor — the binary's only consumer,
 *     a strict superset of the legacy classifier — decides alone. The
 *     legacy provider's `isDefaultLinkOpen` hint pill therefore no
 *     longer gets set on link opens (the binary has no such pill; it
 *     shows the UrlOpenToast of divergence 2 instead).
 */

/** Verbatim label (label map `kce.showLocalhostLinks`, desk @37321941). */
export const OPEN_LOCAL_LINKS_LABEL = 'Open Local Links in Cursor Browser';

/** Verbatim description (settings row + settings UI entry, desk @37322502 / @37476953). */
export const OPEN_LOCAL_LINKS_DESCRIPTION = 'Automatically open localhost links in the Browser Tab';

/** Verbatim settings-search id (`setting:${t}:show-localhost-links`, t = "browser"). */
export const OPEN_LOCAL_LINKS_SEARCH_ID = 'setting:browser:show-localhost-links';

/** Binary storage name (schema key in `Swt`, desk @14326223). */
export const OPEN_LOCAL_LINKS_STORAGE_NAME = 'autoOpenLocalhostUrls';

/** Binary physical storage key (`"cursor/" + name` via `uGt`). */
export const OPEN_LOCAL_LINKS_STORAGE_KEY = 'cursor/autoOpenLocalhostUrls';

/** Binary-verbatim default: `Jh(!0, -1, 0)` — true. */
export const OPEN_LOCAL_LINKS_DEFAULT = true;

/** Fork configuration key backing the setting (see header divergence note). */
export const OPEN_LOCAL_LINKS_CONFIG_KEY = 'ide.browser.openLocalhostLinks';

/** Verbatim label of the glass-only sibling (`kce.openWebLinks`). */
export const OPEN_WEB_LINKS_LABEL = 'Open Web Links in Cursor Browser';

/** Verbatim description of the glass-only sibling (desk @37322502 / @37476953). */
export const OPEN_WEB_LINKS_DESCRIPTION = 'Automatically open http and https links in the Browser Tab';

/** Verbatim settings-search id of the glass-only sibling. */
export const OPEN_WEB_LINKS_SEARCH_ID = 'setting:browser:open-web-links';

/** Binary storage name of the glass-only sibling (desk @14326223). */
export const OPEN_WEB_LINKS_STORAGE_NAME = 'glassOpenWebLinksInBrowser';

/** Binary physical storage key of the glass-only sibling. */
export const OPEN_WEB_LINKS_STORAGE_KEY = 'cursor/glassOpenWebLinksInBrowser';

/** Binary-verbatim default of the glass-only sibling: `Jh(!1, -1, 0)` — false. */
export const OPEN_WEB_LINKS_DEFAULT = false;

/** Binary `uqt` (desk @16936848): hostnames that are always local. */
const LOCALHOST_HOSTNAMES: readonly string[] = ['localhost', '127.0.0.1', '0:0:0:0:0:0:0:1', '::1'];

/** Binary `mBn` (desk @16936848): unspecified (all-interfaces) hostnames. */
const UNSPECIFIED_HOSTNAMES: readonly string[] = ['0.0.0.0', '0:0:0:0:0:0:0:0', '::'];

/** Binary `JLe(e)`: `mBn.indexOf(e) >= 0`. */
function isUnspecifiedHostname(hostname: string): boolean {
	return UNSPECIFIED_HOSTNAMES.indexOf(hostname) >= 0;
}

/**
 * The binary's localhost classifier `lqt` (desk @16936848), verbatim:
 * only `http`/`https` schemes qualify; the URL hostname is lowercased,
 * stripped of IPv6 brackets and of ONE trailing dot, and is local when
 * it is in `uqt` or `mBn`, ends with `.localhost`, or is in 127.0.0.0/8.
 */
export function isLocalhostUrl(target: URI | string): boolean {
	let uri: URI;
	try {
		uri = typeof target === 'string' ? URI.parse(target) : target;
	} catch {
		return false;
	}
	const scheme = uri.scheme.toLowerCase();
	if (scheme !== 'http' && scheme !== 'https') {
		return false;
	}
	try {
		const hostname = new URL(uri.toString()).hostname.toLowerCase();
		const host = (hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname).replace(/\.$/, '');
		return LOCALHOST_HOSTNAMES.indexOf(host) >= 0
			|| isUnspecifiedHostname(host)
			|| host.endsWith('.localhost')
			|| /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
	} catch {
		return false;
	}
}

/**
 * The binary's `pBn` (desk @16937304), verbatim: a URL whose hostname is
 * an unspecified (all-interfaces) host is rewritten to `localhost`;
 * anything else (including unparseable input) is returned unchanged.
 */
export function normalizeLocalhostUrl(url: string): string {
	try {
		const parsed = new URL(url);
		const hostname = parsed.hostname.toLowerCase();
		const host = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
		return isUnspecifiedHostname(host) ? (parsed.hostname = 'localhost', parsed.toString()) : url;
	} catch {
		return url;
	}
}

/**
 * The binary's `gph` (desk @16937493), verbatim: true when `url` and
 * `otherUrl` share the same authority after `pBn` normalization on both
 * sides (and `otherUrl`'s authority is non-empty). Used by the binary to
 * exclude links to Cursor's own backend from the Browser Tab routing.
 */
export function isSameAuthorityAsUrl(url: string, otherUrl: string): boolean {
	try {
		const authority = URI.parse(normalizeLocalhostUrl(url)).authority.toLowerCase();
		const otherAuthority = URI.parse(normalizeLocalhostUrl(otherUrl)).authority.toLowerCase();
		return otherAuthority.length > 0 && authority === otherAuthority;
	} catch {
		return false;
	}
}

/** Inputs of the binary OpenerService localhost interceptor (desk @32435883). */
export interface ILocalLinkOpenContext {
	/** Binary `options.openExternal` — an explicit external open is never intercepted. */
	readonly openExternal?: boolean;
	/** The setting itself: binary `ph(storageService, "autoOpenLocalhostUrls")`. */
	readonly autoOpenLocalhostUrls: boolean;
	/** Binary `cursorCredsService.getBackendUrl()`; excluded when the URL shares its authority. */
	readonly backendUrl?: string;
	/** Binary `remoteAgentService.getConnection()?.remoteAuthority`. */
	readonly remoteAuthority?: string;
}

/**
 * The decision of the binary's first OpenerService opener (desk
 * @32435883), verbatim: returns the (pBn-normalized) URL to open in the
 * Browser Tab, or `undefined` to let the open fall through to the
 * default handling (external browser for http/https/mailto/vsls) when
 * ANY of these holds: `openExternal` was requested; the setting is off;
 * the URL is not local per `lqt`; the URL belongs to the backend
 * authority; or the window is connected to an ssh remote
 * (`remoteAuthority` starts with `ssh-remote+` or contains
 * `@ssh-remote+`).
 */
export function resolveLocalLinkBrowserOpen(target: URI | string, context: ILocalLinkOpenContext): string | undefined {
	if (context.openExternal) {
		return undefined;
	}
	if (!context.autoOpenLocalhostUrls) {
		return undefined;
	}
	if (!isLocalhostUrl(target)) {
		return undefined;
	}
	const normalized = normalizeLocalhostUrl(typeof target === 'string' ? target : target.toString());
	if (context.backendUrl !== undefined && isSameAuthorityAsUrl(normalized, context.backendUrl)) {
		return undefined;
	}
	const remoteAuthority = context.remoteAuthority;
	if (remoteAuthority && (remoteAuthority.startsWith('ssh-remote+') || remoteAuthority.includes('@ssh-remote+'))) {
		return undefined;
	}
	return normalized;
}

/** Verbatim UrlOpenToast message (nls id 12224 in `out/nls.messages.json`, reference 3.25.9). */
export const URL_OPEN_TOAST_MESSAGE = 'Opening {0} in Cursor Browser';

/** Verbatim UrlOpenToast primary-action label (nls id 12225). */
export const URL_OPEN_TOAST_DONT_OPEN_LABEL = `Don't Open`;

/** Verbatim UrlOpenToast action id (`urlOpenToast.dontOpen`, desk @20961744). */
export const URL_OPEN_TOAST_DONT_OPEN_ACTION_ID = 'urlOpenToast.dontOpen';

/** Verbatim never-show-again id (`urlOpenToast.neverShowAgainv1`, desk @20961804). */
export const URL_OPEN_TOAST_NEVER_SHOW_AGAIN_ID = 'urlOpenToast.neverShowAgainv1';

/**
 * Verbatim terminal-link hover suffix of consumer C5 (nls id 10782,
 * desk @36582840). Recorded for the future C5 port; the fork has no C5
 * subsystem yet, so nothing consumes this constant today.
 */
export const TERMINAL_LINK_HOVER_SUFFIX = ', hold shift for your browser';

/**
 * The per-session origin dedupe of the binary's UrlOpenToast service
 * (desk @20961744), verbatim: when the user has NOT chosen
 * never-show-again, each URL `origin` produces at most one toast per
 * session; an unparseable origin or the opaque origin `"null"` is never
 * deduped. When never-show-again IS set the binary skips the bookkeeping
 * and still calls `notify` (the platform notification service itself
 * suppresses the toast), so this returns true without recording.
 */
export class UrlOpenToastTracker {

	private readonly _shownOrigins = new Set<string>();

	/** Returns true when `showUrlOpenToast(url)` should call `notify`. */
	shouldShow(url: string, neverShowAgain: boolean): boolean {
		if (neverShowAgain) {
			return true;
		}
		let origin: string | undefined;
		try {
			origin = new URL(url).origin;
		} catch {
			origin = undefined;
		}
		if (origin !== undefined && origin !== 'null') {
			if (this._shownOrigins.has(origin)) {
				return false;
			}
			this._shownOrigins.add(origin);
		}
		return true;
	}
}

/** The fork's legacy upstream configuration consumed by `LocalhostLinkOpenerContribution`. */
export const LEGACY_OPEN_LOCALHOST_LINKS_CONFIG_KEY = 'workbench.browser.openLocalhostLinks';

/**
 * Why the fork's legacy upstream localhost opener
 * (`LocalhostLinkOpenerContribution`, an `IExternalOpener` for
 * {@link LEGACY_OPEN_LOCALHOST_LINKS_CONFIG_KEY}) must not open a link
 * itself — DEV-GAPS-159 gating (QA-155 NF-1), see header divergence 6:
 * - `disabled`: the legacy setting is off; the provider stays inactive
 *   (unchanged upstream behavior).
 * - `suppressed-by-ide-off`: the legacy setting is on but
 *   `ide.browser.openLocalhostLinks` is false; the binary's single
 *   setting being OFF must win — no path may auto-open the link.
 * - `defer-to-ide-opener`: both settings are on; the provider returns
 *   false so the open falls through to {@link resolveLocalLinkBrowserOpen}
 *   in the `_openers` loop, whose `lqt` classifier is a strict superset
 *   of the legacy classifier and which applies the binary's ssh-remote /
 *   backend exclusions and `pBn` rewrite that the legacy path lacks.
 */
export type LegacyLocalhostLinkOpenerDecision = 'disabled' | 'suppressed-by-ide-off' | 'defer-to-ide-opener';

export function resolveLegacyLocalhostLinkOpenerDecision(legacyEnabled: boolean, ideAutoOpenLocalhostUrls: boolean): LegacyLocalhostLinkOpenerDecision {
	if (!legacyEnabled) {
		return 'disabled';
	}
	if (!ideAutoOpenLocalhostUrls) {
		return 'suppressed-by-ide-off';
	}
	return 'defer-to-ide-opener';
}
