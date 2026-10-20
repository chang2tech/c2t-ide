/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { test } from 'node:test';
import {
	GLASS_SPLASH_STORAGE_KEY,
	buildGlassSplashSnapshot,
	parseGlassSplash,
	persistGlassSplashForTheme,
	readGlassSplash,
	resolveGlassSplashColors,
	resolveGlassThemeBucket,
	serializeGlassSplash,
} from '../../common/glassSplashPersistence.js';

/**
 * DEV-GAPS-63 — glass-theme-splash-persistence tests (Cursor parity).
 *
 * Evidence grounding (see common/glassSplashPersistence.ts):
 *  - harvest-workbench-glass-main.js-2026-10-18.md §3.1: `_saveGlassSplash(t)`
 *    / `_persistGlassSplash(t)` — `GlassThemeService` persists the splash on
 *    every theme change to `_splashStorageService`; stored shape
 *    `{splash: {baseTheme, background}, glassPreference: {detectColorScheme,
 *    settingsId}}`; theme buckets `darkHighContrast` → `HC_BLACK` / `#0A0A0A`,
 *    `dark` → `VS_DARK` / `K5s.dark`; unexpected bucket throws
 *    `Unexpected glass theme bucket`.
 */

class MemoryStore {
	private readonly map = new Map<string, string>();
	getItem(key: string): string | null | undefined {
		return this.map.get(key) ?? null;
	}
	setItem(key: string, value: string): void {
		this.map.set(key, value);
	}
	injectRaw(key: string, value: string): void {
		this.map.set(key, value);
	}
}

test('bucket resolution maps fork baseThemes to the binary-verbatim buckets', () => {
	assert.strictEqual(resolveGlassThemeBucket('hc-black'), 'darkHighContrast');
	assert.strictEqual(resolveGlassThemeBucket('vs-dark'), 'dark');
});

test('unexpected bucket throws the binary-verbatim error message', () => {
	assert.throws(
		() => resolveGlassThemeBucket('vs'),
		(err: Error) => err.message === 'Unexpected glass theme bucket',
		'expected verbatim throw message',
	);
	assert.throws(
		() => resolveGlassThemeBucket('hc-light'),
		(err: Error) => err.message === 'Unexpected glass theme bucket',
	);
	assert.throws(() => resolveGlassThemeBucket(''));
});

test('darkHighContrast colors are binary-verbatim: HC_BLACK / #0A0A0A', () => {
	assert.deepStrictEqual(resolveGlassSplashColors('darkHighContrast', '#000000'), {
		baseTheme: 'hc-black',
		background: '#0A0A0A',
	});
});

test('dark bucket uses the theme editor background (K5s.dark hex is UNKNOWN)', () => {
	assert.deepStrictEqual(resolveGlassSplashColors('dark', 'rgb(30, 30, 30)'), {
		baseTheme: 'vs-dark',
		background: 'rgb(30, 30, 30)',
	});
});

test('snapshot has the binary-verbatim stored shape', () => {
	const snapshot = buildGlassSplashSnapshot({
		baseTheme: 'hc-black',
		background: '#0A0A0A',
		detectColorScheme: true,
		settingsId: 'theme-id',
	});
	assert.deepStrictEqual(Object.keys(snapshot).sort(), ['glassPreference', 'splash']);
	assert.deepStrictEqual(Object.keys(snapshot.splash).sort(), ['background', 'baseTheme']);
	assert.deepStrictEqual(Object.keys(snapshot.glassPreference).sort(), ['detectColorScheme', 'settingsId']);
	assert.deepStrictEqual(snapshot, {
		splash: { baseTheme: 'hc-black', background: '#0A0A0A' },
		glassPreference: { detectColorScheme: true, settingsId: 'theme-id' },
	});
});

test('serialize/parse round-trips through the storage key', () => {
	const store = new MemoryStore();
	const snapshot = buildGlassSplashSnapshot({
		baseTheme: 'vs-dark',
		background: 'rgb(30, 30, 30)',
		detectColorScheme: false,
		settingsId: 'Default Dark+',
	});
	store.setItem(GLASS_SPLASH_STORAGE_KEY, serializeGlassSplash(snapshot));
	assert.deepStrictEqual(readGlassSplash(store), snapshot);
});

test('readGlassSplash returns null when nothing stored or malformed', () => {
	const store = new MemoryStore();
	assert.strictEqual(readGlassSplash(store), null);
	store.injectRaw(GLASS_SPLASH_STORAGE_KEY, 'not json');
	assert.strictEqual(readGlassSplash(store), null);
	store.injectRaw(GLASS_SPLASH_STORAGE_KEY, JSON.stringify({ splash: {} }));
	assert.strictEqual(readGlassSplash(store), null);
	store.injectRaw(GLASS_SPLASH_STORAGE_KEY, JSON.stringify({
		splash: { baseTheme: 'vs-dark', background: '#1E1E1E' },
		glassPreference: { detectColorScheme: 'yes', settingsId: 'x' },
	}));
	assert.strictEqual(readGlassSplash(store), null, 'wrong field types rejected');
});

test('persistGlassSplashForTheme persists dark buckets on theme change', () => {
	const store = new MemoryStore();
	const result = persistGlassSplashForTheme(store, {
		baseTheme: 'hc-black',
		editorBackground: 'rgb(0, 0, 0)',
		detectColorScheme: true,
		settingsId: 'hc-theme',
	});
	assert.deepStrictEqual(result, {
		splash: { baseTheme: 'hc-black', background: '#0A0A0A' },
		glassPreference: { detectColorScheme: true, settingsId: 'hc-theme' },
	});
	assert.deepStrictEqual(readGlassSplash(store), result);
});

test('persistGlassSplashForTheme skips unobserved buckets without throwing', () => {
	const store = new MemoryStore();
	assert.strictEqual(
		persistGlassSplashForTheme(store, {
			baseTheme: 'vs', // light: NOT observed in the binary
			editorBackground: 'rgb(255, 255, 255)',
			detectColorScheme: false,
			settingsId: 'Default Light+',
		}),
		null,
	);
	assert.strictEqual(readGlassSplash(store), null, 'nothing persisted for light');
});
