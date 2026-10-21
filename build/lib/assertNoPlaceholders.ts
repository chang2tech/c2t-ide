/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import es from 'event-stream';
import VinylFile from 'vinyl';
import type through from 'through';

/**
 * Post-replacement guard for packaging template streams (BUILD-QA W46/W50).
 *
 * Every `@@…@@` placeholder in the Linux packaging templates is substituted
 * at build time by a `replace(...)` step in the gulpfiles; no placeholder is
 * ever deferred to a later stage (verified by W46 across the rpm spec, the
 * debian maintainer scripts, snapcraft.yaml and the Inno setup script — the
 * later-stage syntaxes there are `%{…}` for rpmbuild, `$SNAP`-style shell
 * variables for snap/dpkg and `{#…}` for Inno, none of which match the
 * pattern below). A `@@…@@` token that still reaches a staged file therefore
 * always means a replacement was missed or its source value silently fell
 * back to the placeholder itself, and the build must fail instead of
 * shipping it.
 *
 * The allowlist is intentionally EMPTY: any match fails. If a genuinely
 * deferred `@@…@@` placeholder ever appears, allowlist that single token
 * here with the stage that substitutes it — do not widen the pattern or
 * allowlist whole files.
 *
 * Only attach this to text-template streams (spec, control, maintainer
 * scripts, desktop/appdata/mime files, snapcraft.yaml, completions), never
 * to binary payload streams: scanning binary contents as text is both
 * meaningless and wasteful, and placeholders do not live there.
 */
const unreplacedPlaceholderPattern = /@@[A-Za-z0-9_]+@@/g;

/**
 * Returns the distinct unreplaced `@@…@@` tokens in `contents`, in order of
 * first appearance. Exported for tests; {@link assertNoPlaceholders} is the
 * stream form used by the packaging gulpfiles.
 */
export function findUnreplacedPlaceholders(contents: string): string[] {
	const tokens: string[] = [];
	for (const match of contents.matchAll(unreplacedPlaceholderPattern)) {
		if (!tokens.includes(match[0])) {
			tokens.push(match[0]);
		}
	}
	return tokens;
}

/**
 * Returns an `es.through` stream that fails the build when a file still
 * contains an unreplaced `@@…@@` placeholder after its `replace(...)` chain.
 * Pipe it immediately after the last replacement of a template stream (and
 * before `rename`/`dest`). `label` names the stream in the error (e.g.
 * `'rpm spec'`, `'deb control'`) alongside the file path and the token(s)
 * that leaked. Files without buffered contents (directories, streams) pass
 * through untouched.
 */
export function assertNoPlaceholders(label: string): NodeJS.ReadWriteStream {
	return es.through(function (this: through.ThroughStream, file: VinylFile) {
		if (!file.contents || !Buffer.isBuffer(file.contents)) {
			this.emit('data', file);
			return;
		}
		const tokens = findUnreplacedPlaceholders(file.contents.toString('utf8'));
		if (tokens.length > 0) {
			this.emit('error', new Error(`[assertNoPlaceholders] ${label}: unreplaced placeholder(s) ${tokens.join(', ')} in file '${file.path}' — a replace step was missed or its source value is missing; refusing to stage this file.`));
			return;
		}
		this.emit('data', file);
	});
}
