/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Origin-allowlist slice of the Cursor-parity browser-view command surface.
 *
 * BINARY EVIDENCE (Cursor 3.25.9, verified 2026-10-20):
 * - workbench.glass.main.js @40555630 (desktop @32032556):
 *   registerCommand("cursor.browserOriginAllowlist.ensureNavigationAllowed",(t,e)=>{
 *     const n=t.get(Eqc),i=typeof e=="string"?e:e?.url;
 *     if(typeof i!="string"||i.length===0)throw new Error("A URL must be provided to validate navigation.");
 *     n.ensureNavigationAllowed(i)})
 * - workbench.glass.main.js @40555895 (desktop @32032821):
 *   registerCommand("cursor.browserOriginAllowlist.ensurePageOriginAllowed",(t,e)=>{
 *     const n=t.get(Eqc),i=typeof t=="object"&&t?.toolName?t.toolName:"browser_tool";let r;
 *     typeof t=="string"?r=t:typeof t=="object"&&t&&(r=t.url??t.origin),
 *     n.ensurePageOriginAllowed(i,r)})
 *   Both handlers are synchronous (not async) and return undefined; failures
 *   throw. Registered in the same registerCommand region as the
 *   cursor.browserView.* commands (@40541183-40555886 glass).
 *
 * Service semantics (browserOriginAllowlistService, desktop @32030476; DI deps:
 * adminSettingsService, reactiveStorageService):
 * - ensureNavigationAllowed(url):
 *     - parses the URL (parse failure tolerated); protocol "file:" throws
 *       "Security restriction: file:// URLs are not allowed. The browser
 *       navigation tool can only access web URLs (http:// or https://). If you
 *       need to view local files, use the file reading tools instead."
 *     - policy = getPolicy(); when !enforce -> return.
 *     - origin = tryGetOrigin(url); falsy -> throw "Invalid URL provided to
 *       browser_navigate".
 *     - !isOriginAllowed(origin, allowlist) -> throw `Navigation to ${origin}
 *       is blocked by administrator settings. Allowed origins: ${description}`.
 * - ensurePageOriginAllowed(toolName, url?):
 *     - when url is given: parses it (failure tolerated); protocol "file:"
 *       throws `Security restriction: Browser tool ${toolName} cannot be used
 *       on file:// URLs. Only web URLs (http:// or https://) are allowed.`
 *     - policy = getPolicy(); when !enforce -> return.
 *     - !url -> throw `Browser tool ${toolName} is blocked because the current
 *       page origin cannot be determined. Allowed origins: ${description}`.
 *     - origin = tryGetOrigin(url); falsy -> throw `Browser tool ${toolName}
 *       is blocked because the current page URL is invalid. Allowed origins:
 *       ${description}`.
 *     - !isOriginAllowed(origin, allowlist) -> throw `Browser tool ${toolName}
 *       is blocked on origin ${origin} by administrator settings. Allowed
 *       origins: ${description}`.
 * - getPolicy(): allowlist = (adminSettingsService.getCached()
 *     .browserOriginAllowlist ?? []).map(trim).filter(non-empty);
 *   enforce = getBrowserFeaturesForCurrentIdentity() === true
 *     && allowlist.length > 0 && isEnterprise !== false;
 *   description = allowlist.join(", ").
 * - tryGetOrigin(url): try { return new URL(url).origin } catch { return undefined }.
 * - isOriginAllowed(origin, allowlist): allowlist.some(entry =>
 *     entry.includes("*")
 *       ? new RegExp("^" + entry.replace(/[.+?^${}()|[\]\\]/g, "\\$&")
 *           .replace(/[*]/g, ".*") + "$").test(origin)
 *       : entry === origin).
 *
 * HONEST-DIVERGENCE:
 * - The fork has no adminSettingsService / reactiveStorageService carrying a
 *   browserOriginAllowlist array, and no browser-features/enterprise identity
 *   flags, so the fork-local policy always reports enforce:false. The origin
 *   checks therefore pass exactly as they do in Cursor when no administrator
 *   policy is configured. The file:// guards above are kept verbatim because
 *   the binary enforces them unconditionally (before the enforce check).
 */

import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';

interface IBrowserOriginAllowlistPolicy {
	readonly enforce: boolean;
	readonly allowlist: readonly string[];
	readonly description: string;
}

/**
 * Fork-local equivalent of Cursor's browserOriginAllowlistService.
 * Stateless; a single module-level instance serves both commands, mirroring
 * the binary's workbench-scope singleton (registered via `un(a_a, c_a, 0)`).
 */
class BrowserOriginAllowlistService {

	ensureNavigationAllowed(url: string): void {
		let parsed: URL | undefined;
		try {
			parsed = new URL(url);
		} catch {
			// Tolerated: tryGetOrigin below reports the invalid URL.
		}
		if (parsed?.protocol === 'file:') {
			throw new Error('Security restriction: file:// URLs are not allowed. The browser navigation tool can only access web URLs (http:// or https://). If you need to view local files, use the file reading tools instead.');
		}
		const policy = this.getPolicy();
		if (!policy.enforce) {
			return;
		}
		const origin = this.tryGetOrigin(url);
		if (!origin) {
			throw new Error('Invalid URL provided to browser_navigate');
		}
		if (!this.isOriginAllowed(origin, policy.allowlist)) {
			throw new Error(`Navigation to ${origin} is blocked by administrator settings. Allowed origins: ${policy.description}`);
		}
	}

	ensurePageOriginAllowed(toolName: string, url?: string): void {
		if (url) {
			let parsed: URL | undefined;
			try {
				parsed = new URL(url);
			} catch {
				// Tolerated: tryGetOrigin below reports the invalid URL.
			}
			if (parsed?.protocol === 'file:') {
				throw new Error(`Security restriction: Browser tool ${toolName} cannot be used on file:// URLs. Only web URLs (http:// or https://) are allowed.`);
			}
		}
		const policy = this.getPolicy();
		if (!policy.enforce) {
			return;
		}
		if (!url) {
			throw new Error(`Browser tool ${toolName} is blocked because the current page origin cannot be determined. Allowed origins: ${policy.description}`);
		}
		const origin = this.tryGetOrigin(url);
		if (!origin) {
			throw new Error(`Browser tool ${toolName} is blocked because the current page URL is invalid. Allowed origins: ${policy.description}`);
		}
		if (!this.isOriginAllowed(origin, policy.allowlist)) {
			throw new Error(`Browser tool ${toolName} is blocked on origin ${origin} by administrator settings. Allowed origins: ${policy.description}`);
		}
	}

	private getPolicy(): IBrowserOriginAllowlistPolicy {
		// The fork has no adminSettingsService/reactiveStorageService with a
		// browserOriginAllowlist array and no browser-features/enterprise
		// identity flags, so the binary's
		//   enforce = browserFeatures && allowlist.length > 0 && isEnterprise !== false
		// can never be true here.
		return { enforce: false, allowlist: [], description: '' };
	}

	private tryGetOrigin(url: string): string | undefined {
		try {
			return new URL(url).origin;
		} catch {
			return undefined;
		}
	}

	private isOriginAllowed(origin: string, allowlist: readonly string[]): boolean {
		return allowlist.some(entry => {
			if (entry.includes('*')) {
				const pattern = entry.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
				return new RegExp(`^${pattern}$`).test(origin);
			}
			return entry === origin;
		});
	}
}

let _allowlistService: BrowserOriginAllowlistService | undefined;

function getBrowserOriginAllowlistService(): BrowserOriginAllowlistService {
	if (!_allowlistService) {
		_allowlistService = new BrowserOriginAllowlistService();
	}
	return _allowlistService;
}

let _registered = false;

/** Registers the origin-allowlist command pair. Idempotent. */
export function registerBrowserViewOriginAllowlistCommands(): void {
	if (_registered) {
		return;
	}
	_registered = true;
	// Binary @40555630: (t,e)=>{const n=t.get(Eqc),i=typeof e=="string"?e:e?.url;
	// if(typeof i!="string"||i.length===0)throw new Error("A URL must be provided to validate navigation.");
	// n.ensureNavigationAllowed(i)}
	CommandsRegistry.registerCommand('cursor.browserOriginAllowlist.ensureNavigationAllowed', (_accessor: ServicesAccessor, arg?: unknown) => {
		const url = typeof arg === 'string' ? arg : (arg as { url?: unknown } | null | undefined)?.url;
		if (typeof url !== 'string' || url.length === 0) {
			throw new Error('A URL must be provided to validate navigation.');
		}
		getBrowserOriginAllowlistService().ensureNavigationAllowed(url);
	});
	// Binary @40555895: (t,e)=>{const n=t.get(Eqc),i=typeof t=="object"&&t?.toolName?t.toolName:"browser_tool";
	// let r;typeof t=="string"?r=t:typeof t=="object"&&t&&(r=t.url??t.origin),n.ensurePageOriginAllowed(i,r)}
	CommandsRegistry.registerCommand('cursor.browserOriginAllowlist.ensurePageOriginAllowed', (_accessor: ServicesAccessor, arg?: unknown) => {
		const bag = (typeof arg === 'object' && arg !== null ? arg : undefined) as { toolName?: unknown; url?: unknown; origin?: unknown } | undefined;
		const toolName = bag?.toolName ? bag.toolName as string : 'browser_tool';
		let url: string | undefined;
		if (typeof arg === 'string') {
			url = arg;
		} else if (bag) {
			url = (bag.url ?? bag.origin) as string | undefined;
		}
		getBrowserOriginAllowlistService().ensurePageOriginAllowed(toolName, url);
	});
}
