/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Glass theme splash persistence — Cursor parity (feature_id
 * `glass-theme-splash-persistence`). Pure logic: no vscode imports,
 * unit-testable under plain node:test (same pattern as cmdkModelEligibility).
 *
 * EVIDENCE — REA docs, verbatim (docs/rea/harvest-workbench-glass-main.js-2026-10-18.md §3.1):
 *  - "`_saveGlassSplash(t)` / `_persistGlassSplash(t)` — `GlassThemeService`
 *    persists the splash on every theme change to `_splashStorageService`."
 *  - "Stored shape: `{splash: {baseTheme, background}, glassPreference:
 *    {detectColorScheme, settingsId}}`."
 *  - "Theme buckets (OBSERVED from a switch): `darkHighContrast` →
 *    `HC_BLACK` / `#0A0A0A`; `dark` → `VS_DARK` / `K5s.dark`. Unexpected bucket
 *    throws `Unexpected glass theme bucket`."
 *  - Reimplementation note in the same doc: "the splash is how Cursor paints
 *    a correct window background before the workbench loads — it's a theme
 *    persistence detail, not a branding screen."
 *
 * FORK MAPPING: the fork's theme themes report `baseTheme` as VS-Code values
 * `hc-black` / `vs-dark` / `vs` / `hc-light`, so the two observed Cursor
 * buckets map as: `hc-black` → `darkHighContrast` (baseTheme `hc-black`,
 * background `#0A0A0A`, both verbatim), `vs-dark` → `dark` (baseTheme
 * `vs-dark`, background = the active theme's editor background).
 *
 * UNKNOWN (honestly, not guessed):
 *  - The hex value behind Cursor's `K5s.dark` token: NOT observed. The fork
 *    substitutes the active theme's own editor background color — the color
 *    that window would paint anyway — rather than inventing a hex.
 *  - Cursor's storage key for the splash snapshot: NOT observed. The fork
 *    uses its own key, {@link GLASS_SPLASH_STORAGE_KEY}.
 *  - Light-theme glass splash behavior: NOT observed (Cursor buckets seen are
 *    only `darkHighContrast` / `dark`). The fork mirrors the binary's strict
 *    switch in {@link resolveGlassThemeBucket} — unknown buckets throw
 *    `Unexpected glass theme bucket` — but the persistence entry point
 *    ({@link persistGlassSplashForTheme}) only persists for the two observed
 *    buckets and returns null for any other theme instead of throwing, so a
 *    light theme can never break window startup through this path.
 */

export const GLASS_SPLASH_STORAGE_KEY = 'ideCode.glassThemeSplash';

/**
 * The persisted snapshot shape — binary-verbatim field names/structure:
 * `{splash: {baseTheme, background}, glassPreference: {detectColorScheme, settingsId}}`.
 */
export interface GlassSplashSnapshot {
	readonly splash: {
		readonly baseTheme: string;
		readonly background: string;
	};
	readonly glassPreference: {
		readonly detectColorScheme: boolean;
		readonly settingsId: string;
	};
}

/** The two theme buckets observed in the Cursor binary switch. */
export type GlassThemeBucket = 'darkHighContrast' | 'dark';

/** `_splashStorageService` stand-in: a minimal string key/value store. */
export interface GlassSplashStore {
	getItem(key: string): string | null | undefined;
	setItem(key: string, value: string): void;
}

/**
 * Map a fork `baseTheme` to a Cursor theme bucket (binary-verbatim switch):
 * unexpected buckets throw `Unexpected glass theme bucket`.
 */
export function resolveGlassThemeBucket(baseTheme: string): GlassThemeBucket {
	switch (baseTheme) {
		case 'hc-black':
			return 'darkHighContrast';
		case 'vs-dark':
			return 'dark';
		default:
			throw new Error('Unexpected glass theme bucket');
	}
}

/**
 * Splash colors for a bucket. `darkHighContrast` is fully verbatim
 * (`HC_BLACK` / `#0A0A0A`). For `dark`, the background token value (`K5s.dark`)
 * is UNKNOWN, so the caller-provided editor background of the active theme is
 * used (see UNKNOWN note in the file header).
 */
export function resolveGlassSplashColors(
	bucket: GlassThemeBucket,
	editorBackground: string,
): { baseTheme: string; background: string } {
	switch (bucket) {
		case 'darkHighContrast':
			return { baseTheme: 'hc-black', background: '#0A0A0A' };
		case 'dark':
			return { baseTheme: 'vs-dark', background: editorBackground };
		default:
			throw new Error('Unexpected glass theme bucket');
	}
}

/** Build the persisted snapshot with the binary-verbatim stored shape. */
export function buildGlassSplashSnapshot(input: {
	readonly baseTheme: string;
	readonly background: string;
	readonly detectColorScheme: boolean;
	readonly settingsId: string;
}): GlassSplashSnapshot {
	return {
		splash: { baseTheme: input.baseTheme, background: input.background },
		glassPreference: {
			detectColorScheme: input.detectColorScheme,
			settingsId: input.settingsId,
		},
	};
}

export function serializeGlassSplash(snapshot: GlassSplashSnapshot): string {
	return JSON.stringify(snapshot);
}

/**
 * Read-side parse: validate the stored shape strictly enough that a corrupt
 * or foreign value can never reach the next-start paint path. Returns null on
 * anything malformed (including non-string input) instead of throwing.
 */
export function parseGlassSplash(raw: string | null | undefined): GlassSplashSnapshot | null {
	if (typeof raw !== 'string' || raw.length === 0) {
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return null;
	}
	const rec = parsed as Record<string, unknown>;
	const splash = rec.splash as Record<string, unknown> | undefined;
	const pref = rec.glassPreference as Record<string, unknown> | undefined;
	if (
		!splash ||
		typeof splash !== 'object' ||
		typeof splash.baseTheme !== 'string' ||
		typeof splash.background !== 'string' ||
		!pref ||
		typeof pref !== 'object' ||
		typeof pref.detectColorScheme !== 'boolean' ||
		typeof pref.settingsId !== 'string'
	) {
		return null;
	}
	return {
		splash: { baseTheme: splash.baseTheme, background: splash.background },
		glassPreference: {
			detectColorScheme: pref.detectColorScheme,
			settingsId: pref.settingsId,
		},
	};
}

/** Read the persisted snapshot for next-start paint; null when none/invalid. */
export function readGlassSplash(store: GlassSplashStore): GlassSplashSnapshot | null {
	return parseGlassSplash(store.getItem(GLASS_SPLASH_STORAGE_KEY));
}

/**
 * Persist the splash snapshot for the given theme on theme change
 * (mirror of `GlassThemeService._saveGlassSplash` / `_persistGlassSplash`).
 *
 * Returns the persisted snapshot for the two observed buckets
 * (`darkHighContrast` / `dark`); returns null — persisting nothing and NOT
 * throwing — for any unobserved bucket (e.g. light themes), because this
 * fork has no evidence for those and must never break theme application.
 */
export function persistGlassSplashForTheme(
	store: GlassSplashStore,
	input: {
		readonly baseTheme: string;
		readonly editorBackground: string;
		readonly detectColorScheme: boolean;
		readonly settingsId: string;
	},
): GlassSplashSnapshot | null {
	let bucket: GlassThemeBucket;
	try {
		bucket = resolveGlassThemeBucket(input.baseTheme);
	} catch {
		return null;
	}
	const { baseTheme, background } = resolveGlassSplashColors(bucket, input.editorBackground);
	const snapshot = buildGlassSplashSnapshot({
		baseTheme,
		background,
		detectColorScheme: input.detectColorScheme,
		settingsId: input.settingsId,
	});
	store.setItem(GLASS_SPLASH_STORAGE_KEY, serializeGlassSplash(snapshot));
	return snapshot;
}
