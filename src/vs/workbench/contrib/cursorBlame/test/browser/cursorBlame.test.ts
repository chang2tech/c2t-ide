/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';

import { URI } from '../../../../../base/common/uri.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Verbosity } from '../../../../../workbench/common/editor.js';
import { EditorContextKeys } from '../../../../../editor/common/editorContextKeys.js';
import { MenuId } from '../../../../../platform/actions/common/actions.js';
import { ILocalizedString } from '../../../../../nls.js';
import {
	CURSOR_BLAME_AI_DETAILS_OPENED_EVENT,
	CURSOR_BLAME_ENABLED_FOR_TEAM_SETTING,
	CURSOR_BLAME_FEATURE_GATE,
	CURSOR_BLAME_FILE_BLAME_OPENED_EVENT,
	CURSOR_BLAME_GET_COMMIT_METADATA_COMMAND,
	CURSOR_BLAME_GET_FILE_CONTENT_AT_REVISION_COMMAND,
	CURSOR_BLAME_GET_FILE_LINE_BLAME_COMMAND,
	CURSOR_BLAME_GET_FULL_COMMIT_COMMAND,
	CURSOR_BLAME_GET_GIT_ROOT_COMMAND,
	CURSOR_BLAME_GET_LINE_BLAME_COMMAND,
	CURSOR_BLAME_HOVER_DELAY_SETTING,
	CURSOR_BLAME_OPEN_COMMIT_IN_GITHUB_CLICKED_EVENT,
	CURSOR_BLAME_SCHEME,
	CURSOR_BLAME_ZERO_HASH,
	CURSOR_FILE_BLAME_REVISION_SCHEME,
	CURSOR_FILE_BLAME_SCHEME,
	ICursorFileLineBlameResult,
	blameColorIndices,
	buildCursorBlameCommitFromLineBlame,
	buildCursorBlameCommitFromMetadata,
	buildCursorBlameUri,
	buildCursorFileBlameUri,
	expandFileLineBlame,
	formatBlameTimeAgo,
	isCursorBlameEnabled,
	isNoCommit,
	parseCursorBlameResource,
	readCursorBlameFeatureGate,
	resolveCursorBlameHoverDelay,
} from '../../common/cursorBlame.js';
import {
	CURSOR_BLAME_EDITOR_DESCRIPTOR_ID,
	CURSOR_FILE_BLAME_EDITOR_DESCRIPTOR_ID,
	CursorBlameEditor,
	CursorBlameEditorInput,
	CursorBlameEditorSerializer,
	CursorFileBlameEditor,
	CursorFileBlameEditorInput,
	CursorFileBlameEditorSerializer,
	OpenCommitAction,
	OpenFileBlameAction,
	OpenInCursorBlameScmAction,
	ViewCommitAction,
	buildCursorBlameCommitFromHistoryItem,
	isCursorBlameEditorType,
	resolveOpenFileBlameTarget,
} from '../../browser/cursorBlame.contribution.js';

/**
 * Cursor Blame parity tests (feature-matrix `cursor-blame-editor-view`).
 *
 * Binary evidence (Cursor 3.25.9 `out/vs/workbench/workbench.desktop.main.js`):
 * - `e.cursorBlame="cursor.blame"`, `e.cursorFileBlame="cursor.fileblame"`
 * - `cursorBlame.openFileBlame` "Open File Blame" / category "Cursor Blame" / f1:!0
 * - `cursorBlame.openCommit` "View Commit" / category "Cursor Blame" / f1:!0
 * - `cursorBlame.viewCommit` "View commit" / category "Cursor Blame" / f1:!1
 * - `workbench.scm.action.graph.openInCursorBlame` f1:!1,
 *   menu SCMHistoryItemContext group "0_view" order 2
 * - gate: `checkFeatureGate("cursor_blame",{disableExposureLog:!1}) &&
 *   isCursorBlameEnabledForTeam()` (`cursorBlameSettings?.enabled ?? !1`)
 * - `cursor.blame.hoverDelay`: number, min 0, max 10000, default undefined;
 *   registered with `included: <gate>` + `markdownDescription` (F8)
 * - commit input display (F5): getName `"<displayId||id[0:7]>: <subject>"`,
 *   truncated at 50 → 47 + "..."; getTitle LONG appends " by <author>";
 *   getIcon = git-commit codicon
 * - SCM action payload (F10): commitParentId/displayId/authorEmail/statistics
 * - commit URI: `n.path.replace(/^\/commit\//,"")` + `repoRoot` query param
 * - zero-hash sentinel `jSp="0000…0000"` for uncommitted lines
 */
suite('CursorBlame common helpers', () => {

	test('scheme constants match Cursor', () => {
		assert.strictEqual(CURSOR_BLAME_SCHEME, 'cursor.blame');
		assert.strictEqual(CURSOR_FILE_BLAME_SCHEME, 'cursor.fileblame');
	});

	test('feature gate name matches Cursor', () => {
		assert.strictEqual(CURSOR_BLAME_FEATURE_GATE, 'cursor_blame');
	});

	test('setting keys', () => {
		assert.strictEqual(CURSOR_BLAME_ENABLED_FOR_TEAM_SETTING, 'cursor.blame.enabledForTeam');
		assert.strictEqual(CURSOR_BLAME_HOVER_DELAY_SETTING, 'cursor.blame.hoverDelay');
	});

	test('zero-hash sentinel is the 40-char all-zero SHA', () => {
		assert.strictEqual(CURSOR_BLAME_ZERO_HASH, '0000000000000000000000000000000000000000');
		assert.strictEqual(CURSOR_BLAME_ZERO_HASH.length, 40);
	});

	test('isNoCommit mirrors Cursor sWo (!e || e === jSp)', () => {
		assert.strictEqual(isNoCommit(undefined), true);
		assert.strictEqual(isNoCommit(''), true);
		assert.strictEqual(isNoCommit(CURSOR_BLAME_ZERO_HASH), true);
		assert.strictEqual(isNoCommit('a1b2c3d'), false);
	});

	test('parseCursorBlameResource extracts commitId and repoRoot', () => {
		const resource = URI.from({ scheme: 'cursor.blame', path: '/commit/a1b2c3d', query: 'repoRoot=%2Frepo' });
		const parsed = parseCursorBlameResource(resource);
		assert.strictEqual(parsed.commitId, 'a1b2c3d');
		assert.strictEqual(parsed.repoRoot, '/repo');
	});

	test('parseCursorBlameResource without query yields no repoRoot', () => {
		const resource = URI.from({ scheme: 'cursor.blame', path: '/commit/a1b2c3d' });
		const parsed = parseCursorBlameResource(resource);
		assert.strictEqual(parsed.commitId, 'a1b2c3d');
		assert.strictEqual(parsed.repoRoot, undefined);
	});

	test('buildCursorBlameUri round-trips through the parser', () => {
		const uri = buildCursorBlameUri('deadbeef', '/my/repo');
		assert.strictEqual(uri.scheme, 'cursor.blame');
		const parsed = parseCursorBlameResource(uri);
		assert.strictEqual(parsed.commitId, 'deadbeef');
		assert.strictEqual(parsed.repoRoot, '/my/repo');
	});

	test('buildCursorBlameUri without repoRoot has empty query', () => {
		const uri = buildCursorBlameUri('deadbeef');
		assert.strictEqual(uri.scheme, 'cursor.blame');
		assert.strictEqual(uri.path, '/commit/deadbeef');
		assert.strictEqual(parseCursorBlameResource(uri).repoRoot, undefined);
	});

	test('buildCursorFileBlameUri carries path and revision', () => {
		const uri = buildCursorFileBlameUri('/repo/src/a.ts', 'abc123');
		assert.strictEqual(uri.scheme, 'cursor.fileblame');
		assert.strictEqual(uri.path, '/repo/src/a.ts');
		assert.strictEqual(uri.query, 'abc123');
	});

	test('readCursorBlameFeatureGate: unknown gates resolve to false', () => {
		assert.strictEqual(readCursorBlameFeatureGate(undefined), false);
		assert.strictEqual(readCursorBlameFeatureGate({}), false);
		assert.strictEqual(readCursorBlameFeatureGate({ other_gate: true }), false);
		assert.strictEqual(readCursorBlameFeatureGate({ cursor_blame: true }), true);
		assert.strictEqual(readCursorBlameFeatureGate({ cursor_blame: false }), false);
	});

	test('isCursorBlameEnabled requires both the gate and the team setting', () => {
		assert.strictEqual(isCursorBlameEnabled({ cursor_blame: true }, true), true);
		assert.strictEqual(isCursorBlameEnabled({ cursor_blame: true }, false), false);
		assert.strictEqual(isCursorBlameEnabled({ cursor_blame: true }, undefined), false);
		assert.strictEqual(isCursorBlameEnabled({ cursor_blame: false }, true), false);
		assert.strictEqual(isCursorBlameEnabled(undefined, true), false);
		assert.strictEqual(isCursorBlameEnabled(undefined, undefined), false);
	});
});

suite('CursorBlame command registrations', () => {

	function titleOf(action: { desc: { title: unknown } }): ILocalizedString {
		return action.desc.title as ILocalizedString;
	}

	function menuItems(action: OpenInCursorBlameScmAction): { id: MenuId; group?: string; order?: number }[] {
		const menu = action.desc.menu as unknown;
		const items = Array.isArray(menu) ? menu : menu ? [menu] : [];
		return items as { id: MenuId; group?: string; order?: number }[];
	}

	test('cursorBlame.openFileBlame: verbatim id/title/category, f1:!0', () => {
		const action = new OpenFileBlameAction();
		assert.strictEqual(OpenFileBlameAction.ID, 'cursorBlame.openFileBlame');
		assert.strictEqual(action.desc.id, 'cursorBlame.openFileBlame');
		assert.strictEqual(titleOf(action).value, 'Open File Blame');
		assert.strictEqual((action.desc.category as ILocalizedString).value, 'Cursor Blame');
		assert.strictEqual(action.desc.f1, true);
	});

	test('cursorBlame.openCommit: verbatim id/title/category, f1:!0', () => {
		const action = new OpenCommitAction();
		assert.strictEqual(OpenCommitAction.ID, 'cursorBlame.openCommit');
		assert.strictEqual(action.desc.id, 'cursorBlame.openCommit');
		assert.strictEqual(titleOf(action).value, 'View Commit');
		assert.strictEqual((action.desc.category as ILocalizedString).value, 'Cursor Blame');
		assert.strictEqual(action.desc.f1, true);
	});

	test('cursorBlame.viewCommit: verbatim id/title/category, f1:!1', () => {
		const action = new ViewCommitAction();
		assert.strictEqual(ViewCommitAction.ID, 'cursorBlame.viewCommit');
		assert.strictEqual(action.desc.id, 'cursorBlame.viewCommit');
		assert.strictEqual(titleOf(action).value, 'View commit');
		assert.strictEqual((action.desc.category as ILocalizedString).value, 'Cursor Blame');
		assert.strictEqual(action.desc.f1, false);
	});

	test('workbench.scm.action.graph.openInCursorBlame: f1:!1, SCMHistoryItemContext 0_view order 2', () => {
		const action = new OpenInCursorBlameScmAction();
		assert.strictEqual(OpenInCursorBlameScmAction.ID, 'workbench.scm.action.graph.openInCursorBlame');
		assert.strictEqual(action.desc.id, 'workbench.scm.action.graph.openInCursorBlame');
		assert.strictEqual(action.desc.f1, false);
		const menu = menuItems(action);
		assert.strictEqual(menu.length, 1);
		const item = menu[0];
		assert.strictEqual(item.id, MenuId.SCMHistoryItemContext);
		assert.strictEqual(item.group, '0_view');
		assert.strictEqual(item.order, 2);
	});

	test('editor descriptor ids are the verbatim binary ids (DEV-GAPS-178/R2: Cst/Jfa)', () => {
		assert.strictEqual(CURSOR_BLAME_EDITOR_DESCRIPTOR_ID, 'workbench.editor.cursorblame');
		assert.strictEqual(CURSOR_FILE_BLAME_EDITOR_DESCRIPTOR_ID, 'workbench.editor.cursorfileblame');
	});

	test('pane ids equal the descriptor ids (binary: Tst.ID = Cst, unn.ID = Jfa)', () => {
		assert.strictEqual(CursorBlameEditor.ID, 'workbench.editor.cursorblame');
		assert.strictEqual(CursorFileBlameEditor.ID, 'workbench.editor.cursorfileblame');
	});
});

suite('CursorBlame target resolution', () => {

	test('scheme+path object is used as-is (Cursor: "scheme" in t && "path" in t)', () => {
		const uri = URI.from({ scheme: 'file', path: '/repo/a.ts' });
		const resolved = resolveOpenFileBlameTarget({ scheme: 'file', path: '/repo/a.ts' }, undefined);
		assert.strictEqual(resolved?.toString(), uri.toString());
	});

	test('fsPath object becomes URI.file (Cursor: "fsPath" in t)', () => {
		const resolved = resolveOpenFileBlameTarget({ fsPath: '/repo/b.ts' }, undefined);
		assert.strictEqual(resolved?.scheme, 'file');
		assert.strictEqual(resolved?.fsPath, '/repo/b.ts');
	});

	test('falls back to the active editor original URI', () => {
		const fallback = URI.from({ scheme: 'file', path: '/repo/c.ts' });
		assert.strictEqual(resolveOpenFileBlameTarget(undefined, fallback), fallback);
	});

	test('returns undefined when nothing resolves (Cursor: if(!s)return)', () => {
		assert.strictEqual(resolveOpenFileBlameTarget(undefined, undefined), undefined);
	});
});

suite('CursorBlameEditorInput display (F5, binary parity)', () => {

	function commitInput(overrides: Partial<import('../../common/cursorBlame.js').ICursorBlameCommit>) {
		return new CursorBlameEditorInput({ commitId: 'deadbeef1234567890abcdef', subject: '', message: '', ...overrides });
	}

	test('getName: "<displayId||id[0:7]>: <subject>"', () => {
		assert.strictEqual(commitInput({ subject: 'Fix the thing' }).getName(), 'deadbee: Fix the thing');
	});

	test('getName prefers displayId over the 7-char hash prefix', () => {
		assert.strictEqual(commitInput({ displayId: 'abc1234', subject: 'S' }).getName(), 'abc1234: S');
	});

	test('getName truncates at 50 chars to 47 + "..."', () => {
		const name = commitInput({ subject: 'x'.repeat(60) }).getName();
		assert.strictEqual(name, `${'deadbee'}: ${'x'.repeat(38)}...`);
		assert.strictEqual(name.length, 50);
	});

	test('getName does not truncate at exactly 50 chars', () => {
		// "deadbee: " (9) + 41 x's = 50
		const name = commitInput({ subject: 'x'.repeat(41) }).getName();
		assert.strictEqual(name.length, 50);
		assert.ok(!name.endsWith('...'));
	});

	test('getTitle (MEDIUM) truncates like getName', () => {
		const title = commitInput({ subject: 'x'.repeat(60) }).getTitle(Verbosity.MEDIUM);
		assert.strictEqual(title, `${'deadbee'}: ${'x'.repeat(38)}...`);
	});

	test('getTitle LONG appends " by <author>" without truncation', () => {
		const subject = 'x'.repeat(60);
		const title = commitInput({ subject, author: 'Ada' }).getTitle(Verbosity.LONG);
		assert.strictEqual(title, `deadbee: ${subject} by Ada`);
		assert.ok(title.length > 50);
	});

	test('getTitle LONG without author omits the suffix', () => {
		assert.strictEqual(commitInput({ subject: 'S' }).getTitle(Verbosity.LONG), 'deadbee: S');
	});

	test('getIcon is the git-commit codicon (binary: Oe.gitCommit)', () => {
		assert.strictEqual(commitInput({}).getIcon(), Codicon.gitCommit);
	});

	test('capabilities are Readonly only (binary: get capabilities(){return 2}, no Singleton)', () => {
		assert.strictEqual(commitInput({}).capabilities, 2);
	});

	test('getDescription is undefined (binary input class has no getDescription)', () => {
		assert.strictEqual(commitInput({ subject: 'S' }).getDescription(), undefined);
	});

	test('matches(): same commitId+repoRoot, resource-based, super-match (binary QHo matches)', () => {
		const a = commitInput({ commitId: 'deadbeef', repoRoot: '/repo' });
		const same = commitInput({ commitId: 'deadbeef', repoRoot: '/repo', subject: 'Different subject' });
		const diffCommit = commitInput({ commitId: 'abcdef12', repoRoot: '/repo' });
		const diffRoot = commitInput({ commitId: 'deadbeef', repoRoot: '/other' });
		assert.strictEqual(a.matches(same), true);
		assert.strictEqual(a.matches(diffCommit), false);
		assert.strictEqual(a.matches(diffRoot), false);
		// untyped editor input carrying a cursor.blame resource
		assert.strictEqual(a.matches({ resource: a.resource, options: {} } as never), true);
		assert.strictEqual(a.matches({ resource: URI.from({ scheme: 'file', path: '/repo/a.ts' }), options: {} } as never), false);
		// different editor input class
		const fileInput = new CursorFileBlameEditorInput({ fileUri: URI.file('/repo/a.ts'), filePath: 'a.ts' });
		assert.strictEqual(a.matches(fileInput), false);
	});
});

suite('buildCursorBlameCommitFromHistoryItem (F10, binary K2m)', () => {

	test('maps all K2m fields verbatim', () => {
		const commit = buildCursorBlameCommitFromHistoryItem({
			id: 'deadbeef1234',
			parentIds: ['feedface0000'],
			subject: 'Fix the thing',
			message: 'Fix the thing\n\nBody',
			displayId: 'deadbee',
			author: 'Ada',
			authorEmail: 'ada@example.com',
			timestamp: 1720000000000,
			statistics: { files: 2, insertions: 10, deletions: 3 },
		}, '/repo');
		assert.strictEqual(commit.commitId, 'deadbeef1234');
		assert.strictEqual(commit.commitParentId, 'feedface0000');
		assert.strictEqual(commit.displayId, 'deadbee');
		assert.strictEqual(commit.subject, 'Fix the thing');
		assert.strictEqual(commit.message, 'Fix the thing\n\nBody');
		assert.strictEqual(commit.author, 'Ada');
		assert.strictEqual(commit.authorEmail, 'ada@example.com');
		assert.strictEqual(commit.timestamp, 1720000000000);
		assert.deepStrictEqual(commit.statistics, { files: 2, insertions: 10, deletions: 3 });
		assert.strictEqual(commit.repoRoot, '/repo');
	});

	test('optional fields stay undefined when the history item lacks them', () => {
		const commit = buildCursorBlameCommitFromHistoryItem({
			id: 'deadbeef1234',
			parentIds: [],
			subject: 'S',
			message: 'M',
		}, undefined);
		assert.strictEqual(commit.commitParentId, undefined);
		assert.strictEqual(commit.displayId, undefined);
		assert.strictEqual(commit.author, undefined);
		assert.strictEqual(commit.authorEmail, undefined);
		assert.strictEqual(commit.timestamp, undefined);
		assert.strictEqual(commit.statistics, undefined);
		assert.strictEqual(commit.repoRoot, undefined);
	});
});

suite('CursorBlameEditorInput serializer', () => {

	test('serialize/deserialize round-trip preserves the commit payload', async () => {
		const input = new CursorBlameEditorInput({
			commitId: 'deadbeef',
			subject: 'Fix the thing',
			message: 'Fix the thing\n\nMore detail',
			author: 'Ada',
			timestamp: 1720000000000,
			repoRoot: '/repo',
		});
		const serializer = new CursorBlameEditorSerializer();
		assert.strictEqual(await serializer.canSerialize(input), true);
		const serialized = serializer.serialize(input);
		assert.ok(serialized);
		const deserialized = serializer.deserialize(undefined as never, serialized as string) as CursorBlameEditorInput;
		assert.ok(deserialized instanceof CursorBlameEditorInput);
		assert.strictEqual(deserialized.commit.commitId, 'deadbeef');
		assert.strictEqual(deserialized.commit.subject, 'Fix the thing');
		assert.strictEqual(deserialized.commit.author, 'Ada');
		assert.strictEqual(deserialized.commit.timestamp, 1720000000000);
		assert.strictEqual(deserialized.commit.repoRoot, '/repo');
	});

	test('input resource is the cursor.blame commit URI', () => {
		const input = new CursorBlameEditorInput({ commitId: 'abc123', subject: '', message: '', repoRoot: '/repo' });
		assert.strictEqual(input.resource.scheme, 'cursor.blame');
		assert.strictEqual(input.resource.path, '/commit/abc123');
	});

	test('file blame input carries fileUri/filePath', () => {
		const fileUri = URI.file('/repo/src/a.ts');
		const input = new CursorFileBlameEditorInput({ fileUri, filePath: 'src/a.ts', revision: 'abc123' });
		assert.strictEqual(input.options.filePath, 'src/a.ts');
		assert.strictEqual(input.options.revision, 'abc123');
	});

	test('file blame input resource is the cursor.fileblame URI (scheme + path + query revision)', () => {
		const fileUri = URI.file('/repo/src/a.ts');
		const input = new CursorFileBlameEditorInput({ fileUri, filePath: 'src/a.ts', revision: 'abc123' });
		assert.strictEqual(input.resource.scheme, 'cursor.fileblame');
		assert.strictEqual(input.resource.path, fileUri.path);
		assert.strictEqual(input.resource.query, 'abc123');
	});

	test('file blame input resource without revision has empty query (binary: revision || "")', () => {
		const fileUri = URI.file('/repo/src/a.ts');
		const input = new CursorFileBlameEditorInput({ fileUri, filePath: 'src/a.ts' });
		assert.strictEqual(input.resource.scheme, 'cursor.fileblame');
		assert.strictEqual(input.resource.query, '');
	});

	test('file blame input capabilities are Readonly only (binary: return 2, no Singleton)', () => {
		const fileUri = URI.file('/repo/src/a.ts');
		const input = new CursorFileBlameEditorInput({ fileUri, filePath: 'src/a.ts' });
		assert.strictEqual(input.capabilities, 2);
	});

	test('file blame input getName/getTitle mirror Cursor (Blame: <basename> @ <7>, Git Blame: <path>)', () => {
		const fileUri = URI.file('/repo/src/a.ts');
		const revInput = new CursorFileBlameEditorInput({ fileUri, filePath: 'src/a.ts', revision: 'abcdef123456' });
		assert.strictEqual(revInput.getName(), 'Blame: a.ts @ abcdef1');
		assert.strictEqual(revInput.getTitle(2), 'Git Blame: src/a.ts');
		assert.strictEqual(revInput.getTitle(1), 'Blame: a.ts @ abcdef1');
		const headInput = new CursorFileBlameEditorInput({ fileUri, filePath: 'src/a.ts', revision: 'HEAD' });
		assert.strictEqual(headInput.getName(), 'Blame: a.ts');
		const noRevInput = new CursorFileBlameEditorInput({ fileUri, filePath: 'src/a.ts' });
		assert.strictEqual(noRevInput.getName(), 'Blame: a.ts');
	});

	test('file blame input matches(): same class (fileUri+revision), resource-based, super-match', () => {
		const fileUri = URI.file('/repo/src/a.ts');
		const a = new CursorFileBlameEditorInput({ fileUri, filePath: 'src/a.ts', revision: 'abc123' });
		const b = new CursorFileBlameEditorInput({ fileUri, filePath: 'src/a.ts', revision: 'abc123' });
		const diffRev = new CursorFileBlameEditorInput({ fileUri, filePath: 'src/a.ts', revision: 'def456' });
		assert.strictEqual(a.matches(b), true);
		assert.strictEqual(a.matches(diffRev), false);
		// untyped editor input carrying a cursor.fileblame resource
		assert.strictEqual(a.matches({ resource: a.resource, options: {} } as never), true);
		assert.strictEqual(a.matches({ resource: URI.from({ scheme: 'file', path: '/repo/src/a.ts' }), options: {} } as never), false);
		// different editor input class
		const commit = new CursorBlameEditorInput({ commitId: 'deadbeef', subject: '', message: '' });
		assert.strictEqual(a.matches(commit), false);
	});

	test('file blame serializer round-trips the binary field set (fileUri/filePath/revision/revisionMessage/revisionAuthor/revisionTimestamp)', () => {
		const serializer = new CursorFileBlameEditorSerializer();
		const input = new CursorFileBlameEditorInput({
			fileUri: URI.file('/repo/src/a.ts'),
			filePath: 'src/a.ts',
			revision: 'abc123',
			revisionMessage: 'msg',
			revisionAuthor: 'Ada',
			revisionTimestamp: 1720000000000,
		});
		assert.strictEqual(serializer.canSerialize(input), true);
		assert.strictEqual(serializer.canSerialize(new CursorBlameEditorInput({ commitId: 'x', subject: '', message: '' })), false);
		const serialized = serializer.serialize(input);
		assert.ok(serialized);
		const payload = JSON.parse(serialized as string);
		assert.deepStrictEqual(Object.keys(payload).sort(), ['filePath', 'fileUri', 'revision', 'revisionAuthor', 'revisionMessage', 'revisionTimestamp']);
		assert.strictEqual(payload.fileUri, URI.file('/repo/src/a.ts').toString());
		assert.strictEqual(payload.revisionAuthor, 'Ada');
		assert.strictEqual(payload.revisionTimestamp, 1720000000000);
		assert.strictEqual(serializer.serialize(new CursorBlameEditorInput({ commitId: 'x', subject: '', message: '' })), undefined);
	});
});

suite('Git backend mappings (DEV-GAPS-76, binary verbatim)', () => {

	test('buildCursorBlameCommitFromLineBlame mirrors the viewCommit run body', () => {
		const commit = buildCursorBlameCommitFromLineBlame({
			commit: 'deadbeef1234',
			author: 'Ada',
			date: 'Wed Jul 3 15:04:05 2024 +0700',
			message: 'Fix the thing\n\nLonger body',
		}, '/repo');
		assert.strictEqual(commit.commitId, 'deadbeef1234');
		// subject is the FIRST LINE of the provider message; message is "" verbatim
		assert.strictEqual(commit.subject, 'Fix the thing');
		assert.strictEqual(commit.message, '');
		assert.strictEqual(commit.author, 'Ada');
		assert.strictEqual(commit.timestamp, new Date('Wed Jul 3 15:04:05 2024 +0700').getTime());
		assert.strictEqual(commit.repoRoot, '/repo');
	});

	test('buildCursorBlameCommitFromLineBlame: empty date yields undefined timestamp', () => {
		const commit = buildCursorBlameCommitFromLineBlame({ commit: 'abc', author: 'A', date: '', message: 'S' }, undefined);
		assert.strictEqual(commit.timestamp, undefined);
		assert.strictEqual(commit.repoRoot, undefined);
	});

	test('buildCursorBlameCommitFromMetadata mirrors the openCommit run body', () => {
		const commit = buildCursorBlameCommitFromMetadata('deadbeef1234', {
			message: 'Fix the thing\nsecond line',
			description: 'Body of the commit',
			author: 'Ada',
			date: 'Wed Jul 3 15:04:05 2024 +0700',
		});
		assert.strictEqual(commit.commitId, 'deadbeef1234');
		assert.strictEqual(commit.subject, 'Fix the thing');
		// openCommit carries the DESCRIPTION as message (unlike viewCommit's "")
		assert.strictEqual(commit.message, 'Body of the commit');
		assert.strictEqual(commit.author, 'Ada');
		assert.strictEqual(commit.timestamp, new Date('Wed Jul 3 15:04:05 2024 +0700').getTime());
		assert.strictEqual(commit.repoRoot, undefined);
	});

	test('buildCursorBlameCommitFromMetadata: missing fields stay empty/undefined', () => {
		const commit = buildCursorBlameCommitFromMetadata('deadbeef1234', { message: '' });
		assert.strictEqual(commit.subject, '');
		assert.strictEqual(commit.message, '');
		assert.strictEqual(commit.author, undefined);
		assert.strictEqual(commit.timestamp, undefined);
	});
});

suite('EditorContextCursorBlame is a MenuId, not a context key', () => {

	test('verbatim binary literal: MenuId.EditorContextCursorBlame has PascalCase id (binary: new MenuId("EditorContextCursorBlame"))', () => {
		const menuId = MenuId.EditorContextCursorBlame;
		assert.ok(menuId);
		assert.strictEqual(menuId.id, 'EditorContextCursorBlame');
	});

	test('no fabricated editorContextCursorBlame context key remains in editorContextKeys', () => {
		const anyKeys = EditorContextKeys as unknown as Record<string, unknown>;
		assert.strictEqual(anyKeys['EditorContextCursorBlame'], undefined);
	});

	test('isCursorBlameEditorType matches both blame editor inputs', () => {
		assert.strictEqual(CursorBlameEditorInput.ID, 'workbench.editor.cursorblame.input');
		assert.strictEqual(CursorFileBlameEditorInput.ID, 'workbench.editor.cursorfileblame.input');
		assert.strictEqual(isCursorBlameEditorType(CursorBlameEditorInput.ID), true);
		assert.strictEqual(isCursorBlameEditorType(CursorFileBlameEditorInput.ID), true);
	});

	test('isCursorBlameEditorType is false for other editors and empty input', () => {
		assert.strictEqual(isCursorBlameEditorType('workbench.editors.files.fileEditorInput'), false);
		assert.strictEqual(isCursorBlameEditorType(''), false);
		assert.strictEqual(isCursorBlameEditorType('workbench.editor.cursorblame.input '), false);
		// The pre-GAPS-178 fork ids no longer match (R2 verbatim-id migration).
		assert.strictEqual(isCursorBlameEditorType('workbench.input.cursorBlame'), false);
	});
});

suite('Provider seam command ids + analytics events (DEV-GAPS-178)', () => {

	test('provider command ids match the extension registrations', () => {
		assert.strictEqual(CURSOR_BLAME_GET_GIT_ROOT_COMMAND, 'ide.cursorBlame.getGitRoot');
		assert.strictEqual(CURSOR_BLAME_GET_LINE_BLAME_COMMAND, 'ide.cursorBlame.getLineBlame');
		assert.strictEqual(CURSOR_BLAME_GET_COMMIT_METADATA_COMMAND, 'ide.cursorBlame.getCommitMetadata');
		// R1.4: the grouped incremental seam the file pane now consumes.
		assert.strictEqual(CURSOR_BLAME_GET_FILE_LINE_BLAME_COMMAND, 'ide.cursorBlame.getFileLineBlame');
		// R1.1: the commit pane's full-commit seam.
		assert.strictEqual(CURSOR_BLAME_GET_FULL_COMMIT_COMMAND, 'ide.cursorBlame.getFullCommit');
		// R1.2: the file pane's revision-content seam.
		assert.strictEqual(CURSOR_BLAME_GET_FILE_CONTENT_AT_REVISION_COMMAND, 'ide.cursorBlame.getFileContentAtRevision');
	});

	test('analytics event names are verbatim binary trackEvent names (R1.3)', () => {
		assert.strictEqual(CURSOR_BLAME_AI_DETAILS_OPENED_EVENT, 'cursor_blame.ai_details_opened');
		assert.strictEqual(CURSOR_BLAME_FILE_BLAME_OPENED_EVENT, 'cursor_blame.file_blame_opened');
		assert.strictEqual(CURSOR_BLAME_OPEN_COMMIT_IN_GITHUB_CLICKED_EVENT, 'cursor_blame.open_commit_in_github_clicked');
	});

	test('revision model scheme is verbatim (cursor-file-blame-revision)', () => {
		assert.strictEqual(CURSOR_FILE_BLAME_REVISION_SCHEME, 'cursor-file-blame-revision');
	});
});

suite('File pane blame helpers (DEV-GAPS-178, verbatim binary ports)', () => {

	const SHA_A = 'a'.repeat(40);
	const SHA_B = 'b'.repeat(40);

	function groupedResult(): ICursorFileLineBlameResult {
		return {
			isRepositoryShallow: false,
			blameInformation: [
				{ hash: SHA_A, authorName: 'Ada', authorEmail: 'ada@example.com', authorDate: 1720000000000, subject: 'First commit', ranges: [{ startLineNumber: 1, endLineNumber: 2 }, { startLineNumber: 5, endLineNumber: 5 }] },
				{ hash: SHA_B, authorName: undefined, authorDate: undefined, subject: undefined, ranges: [{ startLineNumber: 3, endLineNumber: 4 }] },
			],
		};
	}

	test('expandFileLineBlame expands group ranges per line (d8S port)', () => {
		const byLine = expandFileLineBlame(groupedResult(), 5);
		assert.strictEqual(byLine.size, 5);
		assert.deepStrictEqual(byLine.get(1), { commitHash: SHA_A, author: 'Ada', authorDate: 1720000000000, message: 'First commit' });
		assert.deepStrictEqual(byLine.get(2), byLine.get(1));
		assert.deepStrictEqual(byLine.get(5), byLine.get(1));
		// Missing author/subject/date fall back to "Unknown" / "" / 0 (binary verbatim).
		assert.deepStrictEqual(byLine.get(3), { commitHash: SHA_B, author: 'Unknown', authorDate: 0, message: '' });
		assert.deepStrictEqual(byLine.get(4), byLine.get(3));
	});

	test('expandFileLineBlame clamps lines beyond lineCount (d8S: u <= t)', () => {
		const byLine = expandFileLineBlame(groupedResult(), 3);
		assert.strictEqual(byLine.size, 3);
		assert.strictEqual(byLine.has(4), false);
		assert.strictEqual(byLine.has(5), false);
	});

	test('expandFileLineBlame skips shallow-boundary groups only when the repo is shallow', () => {
		const shallow: ICursorFileLineBlameResult = {
			isRepositoryShallow: true,
			blameInformation: [
				{ hash: SHA_A, authorName: 'Ada', subject: 'Boundary', ranges: [{ startLineNumber: 1, endLineNumber: 2 }], isShallowBoundary: true },
				{ hash: SHA_B, authorName: 'Bob', subject: 'Normal', ranges: [{ startLineNumber: 3, endLineNumber: 3 }] },
			],
		};
		const skipped = expandFileLineBlame(shallow, 3);
		assert.strictEqual(skipped.size, 1);
		assert.strictEqual(skipped.get(3)?.author, 'Bob');
		// Same groups in a non-shallow repo are NOT skipped.
		const kept = expandFileLineBlame({ ...shallow, isRepositoryShallow: false }, 3);
		assert.strictEqual(kept.size, 3);
	});

	test('blameColorIndices maps the first two hex chars mod 4 (eSm port)', () => {
		assert.deepStrictEqual(blameColorIndices('0f' + 'a'.repeat(38)), { baseColorIndex: 0, opacityIndex: 3 });
		assert.deepStrictEqual(blameColorIndices('f0' + 'a'.repeat(38)), { baseColorIndex: 3, opacityIndex: 0 });
		assert.deepStrictEqual(blameColorIndices('5a' + 'b'.repeat(38)), { baseColorIndex: 1, opacityIndex: 2 });
	});

	test('blameColorIndices defaults to {3, 2} for missing/short hashes (eSm port)', () => {
		assert.deepStrictEqual(blameColorIndices(undefined), { baseColorIndex: 3, opacityIndex: 2 });
		assert.deepStrictEqual(blameColorIndices(''), { baseColorIndex: 3, opacityIndex: 2 });
		assert.deepStrictEqual(blameColorIndices('a'), { baseColorIndex: 3, opacityIndex: 2 });
	});

	test('formatBlameTimeAgo day-granularity labels (Qym port)', () => {
		const now = Date.UTC(2024, 6, 10, 12, 0, 0);
		const day = 24 * 60 * 60 * 1000;
		assert.strictEqual(formatBlameTimeAgo(0, now), '');
		assert.strictEqual(formatBlameTimeAgo(now - 60 * 1000, now), 'today');
		assert.strictEqual(formatBlameTimeAgo(now - 1 * day, now), 'yesterday');
		assert.strictEqual(formatBlameTimeAgo(now - 3 * day, now), '3 days ago');
		assert.strictEqual(formatBlameTimeAgo(now - 7 * day, now), '1 week ago');
		assert.strictEqual(formatBlameTimeAgo(now - 21 * day, now), '3 weeks ago');
		assert.strictEqual(formatBlameTimeAgo(now - 30 * day, now), '1 month ago');
		assert.strictEqual(formatBlameTimeAgo(now - 90 * day, now), '3 months ago');
		assert.strictEqual(formatBlameTimeAgo(now - 365 * day, now), '1 year ago');
		assert.strictEqual(formatBlameTimeAgo(now - 800 * day, now), '2 years ago');
	});

	test('resolveCursorBlameHoverDelay prefers the configured setting (USp port)', () => {
		assert.strictEqual(resolveCursorBlameHoverDelay({ userValue: 250 }, 300), 250);
		assert.strictEqual(resolveCursorBlameHoverDelay({ workspaceValue: 0, userValue: 250 }, 300), 0);
		assert.strictEqual(resolveCursorBlameHoverDelay({ workspaceFolderValue: 42, workspaceValue: 250 }, 300), 42);
		assert.strictEqual(resolveCursorBlameHoverDelay({ userRemoteValue: 700, userLocalValue: 800, userValue: 900 }, 300), 700);
	});

	test('resolveCursorBlameHoverDelay falls back to max(editor.hover.delay ?? 300, 500)', () => {
		assert.strictEqual(resolveCursorBlameHoverDelay(undefined, undefined), 500);
		assert.strictEqual(resolveCursorBlameHoverDelay({}, 300), 500);
		assert.strictEqual(resolveCursorBlameHoverDelay({}, 800), 800);
		assert.strictEqual(resolveCursorBlameHoverDelay({}, 100), 500);
	});
});
