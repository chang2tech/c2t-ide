/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import type { ISCMHistoryItemStatistics } from '../../scm/common/history.js';

/**
 * Cursor parity: the `cursor.blame` / `cursor.fileblame` schemes (Cursor
 * 3.25.9 `out/vs/workbench/workbench.desktop.main.js` scheme enum:
 * `e.cursorBlame="cursor.blame", e.cursorFileBlame="cursor.fileblame"`).
 * `cursor.blame` hosts the commit-addressable blame editor
 * (`cursor.blame:/commit/<commitId>?repoRoot=<path>`); `cursor.fileblame`
 * hosts the per-file blame view opened by `cursorBlame.openFileBlame`.
 */
export const CURSOR_BLAME_SCHEME = 'cursor.blame';
export const CURSOR_FILE_BLAME_SCHEME = 'cursor.fileblame';

/**
 * Cursor parity: the experiment gate name checked before any blame UI is
 * exposed (`experimentService.checkFeatureGate("cursor_blame",
 * {disableExposureLog:!1})`, 3.25.9 `workbench.desktop.main.js`).
 */
export const CURSOR_BLAME_FEATURE_GATE = 'cursor_blame';

/**
 * Cursor parity: the all-zero SHA sentinel for uncommitted lines
 * (`jSp="0000000000000000000000000000000000000000"` in 3.25.9; Cursor's
 * `sWo(e)` returns true for falsy values and for this sentinel).
 */
export const CURSOR_BLAME_ZERO_HASH = '0000000000000000000000000000000000000000';

/**
 * Returns true when a blamed commit id means "no real commit" (uncommitted
 * line), mirroring Cursor's `sWo` check (`!e || e === jSp`).
 */
export function isNoCommit(commitId: string | undefined | null): boolean {
	return !commitId || commitId === CURSOR_BLAME_ZERO_HASH;
}

/**
 * The commit payload carried by the Cursor Blame editor input. Field names
 * are verbatim from Cursor's SCM-graph mapping `K2m(e,t)` (3.25.9):
 * `{commitId:e.id,commitParentId:e.parentIds[0],displayId:e.displayId,
 *  subject:e.subject,message:e.message,author:e.author,authorEmail:e.authorEmail,
 *  timestamp:e.timestamp,statistics:e.statistics,repoRoot:t}`.
 */
export interface ICursorBlameCommit {
	commitId: string;
	commitParentId?: string;
	displayId?: string;
	subject: string;
	message: string;
	author?: string;
	authorEmail?: string;
	timestamp?: number;
	statistics?: ISCMHistoryItemStatistics;
	repoRoot?: string;
}

/**
 * The file payload carried by the Cursor File Blame editor input. Field
 * names are verbatim from Cursor's file-blame serializer
 * `Vfa.serialize`/`deserialize` (3.25.9
 * `out/vs/workbench/workbench.desktop.main.js`): `{fileUri, filePath,
 * revision, revisionMessage, revisionAuthor, revisionTimestamp}`.
 */
export interface ICursorFileBlameData {
	fileUri: URI;
	filePath: string;
	revision?: string;
	revisionMessage?: string;
	revisionAuthor?: string;
	revisionTimestamp?: number;
}

/**
 * Parses a `cursor.blame:/commit/<commitId>?repoRoot=<path>` resource into
 * its commit id and repo root. Mirrors Cursor's
 * `createEditorInput: ({resource:n}) => { const i =
 * n.path.replace(/^\/commit\//,""), r = n.query ? new
 * URLSearchParams(n.query).get("repoRoot") ?? void 0 : void 0; ... }`
 * (3.25.9).
 */
export function parseCursorBlameResource(resource: URI): { commitId: string; repoRoot?: string } {
	const commitId = resource.path.replace(/^\/commit\//, '');
	const repoRoot = resource.query ? new URLSearchParams(resource.query).get('repoRoot') ?? undefined : undefined;
	return { commitId, repoRoot };
}

/**
 * Builds the `cursor.blame:/commit/<commitId>` URI opened by the Cursor
 * Blame editor.
 */
export function buildCursorBlameUri(commitId: string, repoRoot?: string): URI {
	const query = repoRoot ? `repoRoot=${encodeURIComponent(repoRoot)}` : '';
	return URI.from({ scheme: CURSOR_BLAME_SCHEME, path: `/commit/${commitId}`, query });
}

/**
 * Builds the `cursor.fileblame:/<filePath>` URI opened by
 * `cursorBlame.openFileBlame`. Mirrors Cursor's fileblame
 * `createEditorInput`, which reads the file path from `resource.path` and
 * the revision from `resource.query`.
 */
export function buildCursorFileBlameUri(filePath: string, revision?: string): URI {
	return URI.from({ scheme: CURSOR_FILE_BLAME_SCHEME, path: filePath, query: revision ?? '' });
}

/**
 * DEV-GAPS-76 (W76B): the git-provider command bridge. Cursor's workbench
 * reaches git through its `gitContextService` facade, proxied to the
 * extension-host `cursor-retrieval` GitProvider (3.25.9
 * `workbench.desktop.main.js` @16474491 `getGitLineBlameWithAbsolutePath`,
 * @16475113 `getGitFileLineBlameWithAbsolutePath`; provider argv/parsers in
 * `extensions/cursor-retrieval/dist/main.js` @1821616 / @1826156). This
 * fork has no such facade, so the workbench calls the `ide-agent`
 * extension's provider commands instead — same layering (workbench →
 * extension-host git provider), different transport (command bridge
 * instead of the extHost SCM proxy). The extension side lives in
 * `extensions/ide-agent/src/services/gitBlameService.ts`.
 */
export const CURSOR_BLAME_GET_GIT_ROOT_COMMAND = 'ide.cursorBlame.getGitRoot';
export const CURSOR_BLAME_GET_LINE_BLAME_COMMAND = 'ide.cursorBlame.getLineBlame';
export const CURSOR_BLAME_GET_FILE_BLAME_COMMAND = 'ide.cursorBlame.getFileBlame';
export const CURSOR_BLAME_GET_COMMIT_METADATA_COMMAND = 'ide.cursorBlame.getCommitMetadata';

/**
 * DEV-GAPS-178 (R1.4): the 5th provider seam, registered by the extension
 * since DEV-GAPS-76 but until now without a workbench consumer. In Cursor
 * this IS the file-blame pane's data source: the pane calls
 * `gitContextService.getGitFileLineBlameWithAbsolutePath(fsPath, revision)`
 * (3.25.9 file-blame component) which proxies to the provider's
 * `getGitFileLineBlame` (`git blame --root --incremental`). The fork's file
 * pane now consumes it the same way (see `CursorFileBlameEditor`).
 */
export const CURSOR_BLAME_GET_FILE_LINE_BLAME_COMMAND = 'ide.cursorBlame.getFileLineBlame';

/**
 * DEV-GAPS-178 (R1.1): the commit pane's data source. Cursor's
 * CursorBlamePane calls `gitContextService.getFullCommit(commitId,
 * repoRoot)` (3.25.9); the provider runs `git show -m
 * --pretty=format:%s<SEP>%b<SEP>%an<SEP>%ad<SEP>%cI<SEP>%P<SEP>` and parses
 * the trailing patch (cursor-retrieval @1880344). The fork mirrors it
 * through this command (extension `GitBlameService.getFullCommit`).
 */
export const CURSOR_BLAME_GET_FULL_COMMIT_COMMAND = 'ide.cursorBlame.getFullCommit';

/**
 * DEV-GAPS-178 (R1.2): file content at a revision, for the file pane's
 * revision model. Cursor's file-blame component runs it through the git
 * facade: `executeGitCommand(cwd, ["show", "<rev>:<pathAtRevision>"])`
 * (3.25.9) and falls back to the current file model on failure.
 */
export const CURSOR_BLAME_GET_FILE_CONTENT_AT_REVISION_COMMAND = 'ide.cursorBlame.getFileContentAtRevision';

/**
 * URI scheme of the file pane's synthetic revision model (Cursor 3.25.9,
 * verbatim): `URI.from({scheme:"cursor-file-blame-revision", path:
 * fileUri.path, query: "<revision>:<pathAtRevision>"})`.
 */
export const CURSOR_FILE_BLAME_REVISION_SCHEME = 'cursor-file-blame-revision';

/**
 * Cursor parity (3.25.9, verbatim analytics event names): the commit pane
 * fires `trackEvent("cursor_blame.ai_details_opened")` and the file pane
 * fires `trackEvent("cursor_blame.file_blame_opened")` — both with NO
 * properties argument, and only when the pane actually (re)renders (new
 * input identity: commitId/repoRoot, resp. fileUri/revision). The fork has
 * no analytics service; following the established fork mapping for binary
 * `trackEvent` (see composer onboardingService), the panes emit these via
 * `ITelemetryService.publicLog(<event>)` with no data.
 */
export const CURSOR_BLAME_AI_DETAILS_OPENED_EVENT = 'cursor_blame.ai_details_opened';
export const CURSOR_BLAME_FILE_BLAME_OPENED_EVENT = 'cursor_blame.file_blame_opened';
export const CURSOR_BLAME_OPEN_COMMIT_IN_GITHUB_CLICKED_EVENT = 'cursor_blame.open_commit_in_github_clicked';

/** The provider's commit-metadata shape (Cursor `getCommitMetadataOnly` result fields read by `cursorBlame.openCommit`: `message`, `description`, `author`, `date`). */
export interface ICursorCommitMetadata {
	message: string;
	description?: string;
	author?: string;
	date?: string;
}

/**
 * Maps provider commit metadata to the blame editor input, mirroring
 * Cursor's `cursorBlame.openCommit` run body verbatim (3.25.9):
 * `l=(f.message??"").split(/\r?\n/)[0].trim(), u=f.description??"",
 * h=f.author, p=f.date?new Date(f.date).getTime():void 0`, then
 * `createInstance(cIe,{commitId,subject:l,message:u,author:h,timestamp:p})`
 * (no repoRoot — the binary does not set one here).
 */
export function buildCursorBlameCommitFromMetadata(commitId: string, metadata: ICursorCommitMetadata): ICursorBlameCommit {
	return {
		commitId,
		subject: (metadata.message ?? '').split(/\r?\n/)[0].trim(),
		message: metadata.description ?? '',
		author: metadata.author,
		timestamp: metadata.date ? new Date(metadata.date).getTime() : undefined,
	};
}

/** One entry of the provider's `getGitLineBlame` result (Cursor verbatim field set: `{commit, author, date, message}`). */
export interface ICursorLineBlameCommit {
	commit: string;
	author: string;
	date: string;
	message: string;
}

/** One per-line row of the provider's `git blame --porcelain` result. Mirrors `IBlameLine` in the extension's `gitBlameService.ts`. Kept for the provider seam's other consumers; the file pane itself now renders the grouped incremental data (see {@link ICursorBlameCommitGroup}). */
export interface ICursorBlameLine {
	commit: string;
	author: string;
	authorTime: number;
	summary: string;
	lineNumber: number;
	content: string;
}

/**
 * One commit group of the provider's `git blame --root --incremental`
 * result — verbatim shape of Cursor's `parseGitBlame` output
 * (cursor-retrieval @1826156), mirrored as `IBlameCommitGroup` in the
 * extension's `gitBlameService.ts`.
 */
export interface ICursorBlameCommitGroup {
	hash: string;
	authorName?: string;
	authorEmail?: string;
	/** Author timestamp, MILLISECONDS since epoch (Cursor: `1e3 * seconds`). */
	authorDate?: number;
	subject?: string;
	ranges: Array<{ startLineNumber: number; endLineNumber: number }>;
	isShallowBoundary?: boolean;
}

/** The provider's `getGitFileLineBlame` result (Cursor verbatim field names). */
export interface ICursorFileLineBlameResult {
	blameInformation: ICursorBlameCommitGroup[];
	isRepositoryShallow: boolean;
}

/** One line's blame info after group expansion (Cursor's `d8S` entry shape, 3.25.9). */
export interface ICursorBlameLineInfo {
	commitHash: string;
	author: string;
	/** Author timestamp, MILLISECONDS since epoch (`0` when unknown). */
	authorDate: number;
	message: string;
}

/**
 * VERBATIM port of Cursor's `d8S` (3.25.9 file-blame component): expands
 * grouped blame ranges into a per-line map. Shallow-boundary groups are
 * SKIPPED entirely when the repository is shallow
 * (`if(e.isRepositoryShallow && i.isShallowBoundary) continue`), missing
 * author falls back to `"Unknown"`, missing subject/date to `""`/`0`, and
 * lines beyond `lineCount` are clamped out.
 */
export function expandFileLineBlame(result: ICursorFileLineBlameResult, lineCount: number): Map<number, ICursorBlameLineInfo> {
	const byLine = new Map<number, ICursorBlameLineInfo>();
	for (const group of result.blameInformation) {
		if (result.isRepositoryShallow && group.isShallowBoundary) {
			continue;
		}
		const info: ICursorBlameLineInfo = {
			commitHash: group.hash,
			author: group.authorName || 'Unknown',
			authorDate: group.authorDate || 0,
			message: group.subject || '',
		};
		for (const range of group.ranges) {
			for (let line = range.startLineNumber; line <= range.endLineNumber; line++) {
				if (line <= lineCount) {
					byLine.set(line, info);
				}
			}
		}
	}
	return byLine;
}

/**
 * VERBATIM port of Cursor's `eSm` (3.25.9 file-blame component): maps a
 * commit hash to the whole-line decoration color indices. Falsy/short
 * hashes yield the default `{baseColorIndex: 3, opacityIndex: 2}`;
 * otherwise `baseColorIndex = parseInt(hash[0], 16) % 4` (NaN → 0) and
 * `opacityIndex = parseInt(hash[1], 16) % 4` (NaN → 2).
 */
export function blameColorIndices(commitHash: string | undefined | null): { baseColorIndex: number; opacityIndex: number } {
	if (!commitHash || commitHash.length < 2) {
		return { baseColorIndex: 3, opacityIndex: 2 };
	}
	const first = parseInt(commitHash[0], 16);
	const second = parseInt(commitHash[1], 16);
	return {
		baseColorIndex: isNaN(first) ? 0 : first % 4,
		opacityIndex: isNaN(second) ? 2 : second % 4,
	};
}

/**
 * VERBATIM port of Cursor's `Qym` (3.25.9 file-blame component): relative
 * day-granularity label for an author timestamp (ms). `now` is a parameter
 * only so tests can pin it; Cursor reads `Date.now()` (with an hourly
 * memo cache this port omits — the labels are pure functions of the two
 * timestamps).
 */
export function formatBlameTimeAgo(authorDate: number, now: number = Date.now()): string {
	if (!authorDate) {
		return '';
	}
	const days = Math.floor((now - authorDate) / (1000 * 60 * 60 * 24));
	if (days === 0) {
		return 'today';
	}
	if (days === 1) {
		return 'yesterday';
	}
	if (days < 7) {
		return `${days} days ago`;
	}
	if (days < 30) {
		const weeks = Math.floor(days / 7);
		return `${weeks} week${weeks > 1 ? 's' : ''} ago`;
	}
	if (days < 365) {
		const months = Math.floor(days / 30);
		return `${months} month${months > 1 ? 's' : ''} ago`;
	}
	const years = Math.floor(days / 365);
	return `${years} year${years > 1 ? 's' : ''} ago`;
}

/** The `IConfigurationService.inspect()` slice Cursor's `USp` reads (3.25.9). */
export interface ICursorBlameHoverDelayInspection {
	workspaceFolderValue?: number;
	workspaceValue?: number;
	userRemoteValue?: number;
	userLocalValue?: number;
	userValue?: number;
}

/**
 * VERBATIM port of Cursor's `USp` (3.25.9 @22849912): the blame hover delay
 * is the first defined of the inspected `cursor.blame.hoverDelay` values
 * (workspaceFolder → workspace → userRemote → userLocal → user); when the
 * setting is unset it falls back to `editor.hover.delay` (default 300)
 * with a 500ms minimum: `Math.max(editorHoverDelay ?? 300, 500)`.
 */
export function resolveCursorBlameHoverDelay(inspected: ICursorBlameHoverDelayInspection | undefined, editorHoverDelay: number | undefined): number {
	const configured = inspected?.workspaceFolderValue ?? inspected?.workspaceValue ?? inspected?.userRemoteValue ?? inspected?.userLocalValue ?? inspected?.userValue;
	if (configured !== undefined) {
		return configured;
	}
	return Math.max(editorHoverDelay ?? 300, 500);
}

/** One chunk of a unified-diff file (Cursor's parse-diff output shape, provider-side `pce`). */
export interface ICursorCommitDiffChunk {
	content: string;
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	changes: Array<{ type: 'add' | 'del' | 'normal'; content: string }>;
}

/** One file of a commit's diff (Cursor's parse-diff output shape, provider-side `pce`). */
export interface ICursorCommitFileDiff {
	from?: string;
	to?: string;
	new?: boolean;
	deleted?: boolean;
	additions: number;
	deletions: number;
	chunks: ICursorCommitDiffChunk[];
}

/**
 * The provider's `getFullCommit` result: the `getCommitMetadataOnly`
 * fields plus the parsed per-file `diff` (Cursor 3.25.9, cursor-retrieval
 * @1880344). `diffOmitted` is set by the fork provider when the patch
 * exceeded the exec buffer and only metadata was loaded — the pane's
 * large-commit mode (Cursor sets the same mode when `getFullCommit`
 * throws maxBuffer and it falls back to `getCommitMetadataOnly`).
 */
export interface ICursorFullCommit {
	sha: string;
	/** `%s` — the subject line (the provider names this field `message`). */
	message: string;
	/** `%b` — the commit body. */
	description: string;
	author: string;
	/** `%ad` — author date string. */
	date: string;
	committerDate: string;
	parents: string[];
	diff: ICursorCommitFileDiff[];
	diffOmitted?: boolean;
}

/**
 * Maps the provider's line-blame result to the blame editor input,
 * mirroring Cursor's `cursorBlame.viewCommit` run body verbatim (3.25.9):
 * `createInstance(cIe, {commitId: g, subject: (p?.message ?? "").split(
 * /\r?\n/)[0].trim(), message: "", author: p?.author, timestamp:
 * p?.date ? new Date(p.date).getTime() : void 0, repoRoot: y})` where `g`
 * is `commits[0].commit` and `y` is `getGitRoot(dirname(fsPath))`.
 */
export function buildCursorBlameCommitFromLineBlame(entry: ICursorLineBlameCommit, repoRoot: string | undefined): ICursorBlameCommit {
	return {
		commitId: entry.commit,
		subject: (entry.message ?? '').split(/\r?\n/)[0].trim(),
		message: '',
		author: entry.author,
		timestamp: entry.date ? new Date(entry.date).getTime() : undefined,
		repoRoot,
	};
}

/**
 * Setting that gates the Cursor Blame UI per team. Fork analog of Cursor's
 * `adminSettingsService.getCached().cursorBlameSettings?.enabled ?? !1`
 * (`isCursorBlameEnabledForTeam`, 3.25.9): this fork has no admin settings
 * service, so the team gate is a local setting defaulting to false, exactly
 * like Cursor's `?? !1` fallback.
 */
export const CURSOR_BLAME_ENABLED_FOR_TEAM_SETTING = 'cursor.blame.enabledForTeam';

/**
 * Cursor parity: `cursor.blame.hoverDelay` (3.25.9
 * `workbench.contrib.cursorBlameConfiguration`: number, minimum 0, maximum
 * 10000, default `void 0`, scope 1).
 */
export const CURSOR_BLAME_HOVER_DELAY_SETTING = 'cursor.blame.hoverDelay';

/**
 * Reads Cursor's `cursor_blame` experiment gate the way this fork does
 * everywhere else (see `extHostCursor.ts` `checkFeatureGate`): from the
 * local `ide.agent.featureGates` configuration record; unknown gates
 * resolve to false. Cursor reads a server-driven experiment service, which
 * this fork does not have.
 */
export function readCursorBlameFeatureGate(featureGates: Record<string, boolean> | undefined): boolean {
	return featureGates?.[CURSOR_BLAME_FEATURE_GATE] ?? false;
}

/**
 * The full Cursor gate for the blame UI: `checkFeatureGate("cursor_blame",
 * {disableExposureLog:!1}) && adminSettingsService.isCursorBlameEnabledForTeam()`
 * (3.25.9, SCM graph action run + `Bzn` contribution). Fork mapping:
 * `ide.agent.featureGates["cursor_blame"]` + the
 * `cursor.blame.enabledForTeam` setting.
 */
export function isCursorBlameEnabled(featureGates: Record<string, boolean> | undefined, enabledForTeam: boolean | undefined): boolean {
	return readCursorBlameFeatureGate(featureGates) && (enabledForTeam ?? false);
}
