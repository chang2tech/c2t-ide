/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { constObservable } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { Event } from '../../../../../base/common/event.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { ISession, ISessionWorkspace } from '../../../../services/sessions/common/session.js';
import {
	CHANGES_NEW_TAB_MODEL_ACTION_ID,
	getNewTabModelAction,
	isNewTabModelActionShown,
	getVisibleNewTabModelActions,
	isRemoteEnvironmentSession,
	OPEN_CHANGES_TAB_COMMAND_ID,
	parseOpenChangesTabArgs,
} from '../../browser/openChangesTabCommand.js';
import { SessionReviewChangesEditorInput, SessionReviewChangesEditorSerializer } from '../../browser/sessionReviewChangesEditor.js';
import { SessionChangesEditorInput } from '../../browser/sessionChangesEditorInput.js';
import { IReviewChangesProps } from '../../common/sessionChangesService.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('openChangesTabCommand (workbench-open-changes-tab)', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	suite('parseOpenChangesTabArgs', () => {
		test('parses the local invocation shape {scope:"lastTurn", agentId, filePath?}', () => {
			assert.deepStrictEqual(
				parseOpenChangesTabArgs({ scope: 'lastTurn', agentId: 'agent-1', filePath: '/repo/a.ts' }),
				{ scope: 'lastTurn', agentId: 'agent-1', filePath: '/repo/a.ts', bcId: undefined, label: undefined, initialFilterScope: undefined, ownerAgentId: undefined },
			);
		});

		test('parses the cloud shape {bcId, label, initialFilterScope:"branch", ownerAgentId}', () => {
			assert.deepStrictEqual(
				parseOpenChangesTabArgs({ bcId: 'bc-9', label: 'Cloud run', initialFilterScope: 'branch', ownerAgentId: 'agent-2' }),
				{ scope: undefined, agentId: undefined, filePath: undefined, bcId: 'bc-9', label: 'Cloud run', initialFilterScope: 'branch', ownerAgentId: 'agent-2' },
			);
		});

		test('garbage input yields the default invocation {}', () => {
			assert.deepStrictEqual(parseOpenChangesTabArgs(undefined), {});
			assert.deepStrictEqual(parseOpenChangesTabArgs(null), {});
			assert.deepStrictEqual(parseOpenChangesTabArgs('glass.openChangesTab'), {});
			assert.deepStrictEqual(parseOpenChangesTabArgs(42), {});
			assert.deepStrictEqual(parseOpenChangesTabArgs({}), { scope: undefined, agentId: undefined, filePath: undefined, bcId: undefined, label: undefined, initialFilterScope: undefined, ownerAgentId: undefined });
		});

		test('drops empty strings and non-"lastTurn" scopes', () => {
			const parsed = parseOpenChangesTabArgs({ scope: 'everything', agentId: '', filePath: '', bcId: '' });
			assert.strictEqual(parsed.scope, undefined);
			assert.strictEqual(parsed.agentId, undefined);
			assert.strictEqual(parsed.filePath, undefined);
			assert.strictEqual(parsed.bcId, undefined);
		});
	});

	suite('new-tab-model action registry', () => {
		test('the "changes" entry carries the verbatim binary data', () => {
			const entry = getNewTabModelAction(CHANGES_NEW_TAB_MODEL_ACTION_ID);
			assert.ok(entry, 'changes entry must be registered');
			assert.strictEqual(entry?.id, 'changes');
			assert.strictEqual(entry?.label, 'Changes');
			assert.deepStrictEqual(entry ? [...entry.keywords] : [], ['git']);
			assert.strictEqual(entry?.keybindingCommandId, OPEN_CHANGES_TAB_COMMAND_ID);
			assert.strictEqual(entry?.keybindingCommandId, 'glass.openChangesTab');
		});

		test('showChangesAction-style gate follows the verbatim changesTabAvailable policy', () => {
			const shown = { getContextKeyValue: (key: string) => key === 'changesTabAvailable' ? true : undefined } as IContextKeyService;
			const hidden = { getContextKeyValue: (_key: string) => false } as IContextKeyService;
			const unset = { getContextKeyValue: (_key: string) => undefined } as IContextKeyService;

			assert.strictEqual(isNewTabModelActionShown('changes', shown), true);
			assert.strictEqual(isNewTabModelActionShown('changes', hidden), false);
			assert.strictEqual(isNewTabModelActionShown('changes', unset), false);
			assert.strictEqual(isNewTabModelActionShown('no-such-action', shown), false);

			assert.deepStrictEqual(getVisibleNewTabModelActions(shown).map(a => a.id), ['changes']);
			assert.deepStrictEqual(getVisibleNewTabModelActions(hidden), []);
		});
	});

	suite('isRemoteEnvironmentSession (binary _isChangesTabActivatable bA predicate)', () => {
		function fakeSession(environment: string, workspace?: ISessionWorkspace): ISession {
			return {
				environment,
				workspace: constObservable(workspace),
				worktreePending: constObservable(false),
			} as unknown as ISession;
		}

		function folderWorkspace(uri: string): ISessionWorkspace {
			return {
				uri: URI.parse(uri),
				isVirtualWorkspace: false,
				folders: [{ gitRepository: undefined }],
			} as unknown as ISessionWorkspace;
		}

		test('empty/non-string environment id is not remote (bA typeof check fails)', () => {
			assert.strictEqual(isRemoteEnvironmentSession(fakeSession('')), false);
		});

		test('local environment is not remote (Kl)', () => {
			assert.strictEqual(isRemoteEnvironmentSession(fakeSession('local')), false);
		});

		test('local folder workspace with uri is not remote (Kl, structural)', () => {
			assert.strictEqual(isRemoteEnvironmentSession(fakeSession('some-id', folderWorkspace('file:///repo'))), false);
		});

		test('cloud environment is remote (not a local folder workspace)', () => {
			assert.strictEqual(isRemoteEnvironmentSession(fakeSession('cloud')), true);
		});

		test('remote host identifier is remote', () => {
			assert.strictEqual(isRemoteEnvironmentSession(fakeSession('ssh://devbox-1')), true);
		});

		test('non-file workspace uri with a custom env id is remote', () => {
			const ws = folderWorkspace('vscode-remote://ssh/devbox/repo');
			assert.strictEqual(isRemoteEnvironmentSession(fakeSession('devbox', ws)), true);
		});
	});

	suite('SessionReviewChangesEditorInput', () => {
		const instantiationService = new TestInstantiationService();
		const fakeSessionChangesService = { activeSessionUncommittedChangesCountObs: constObservable(0) } as never;
		const fakeLayoutService = { onDidChangePartVisibility: Event.None, isVisible: () => true } as never;

		function createReviewInput(reviewProps: IReviewChangesProps = {}) {
			return disposables.add(new SessionReviewChangesEditorInput(
				URI.parse('changes-multi-diff-source://session'),
				reviewProps,
				instantiationService,
				fakeSessionChangesService,
				fakeLayoutService,
			));
		}

		test('carries the review identity (name "Review Changes", distinct ids)', () => {
			const input = createReviewInput({ composerId: 'agent-1', scrollToFile: '/repo/a.ts' });
			assert.strictEqual(input.getName(), 'Review Changes');
			assert.strictEqual(input.typeId, 'workbench.input.agentSessions.sessionReviewChanges');
			assert.strictEqual(input.editorId, 'workbench.editor.agentSessions.sessionReviewChanges');
			assert.deepStrictEqual(input.reviewProps, { composerId: 'agent-1', scrollToFile: '/repo/a.ts' });
			assert.strictEqual(SessionReviewChangesEditorInput.CURSOR_INPUT_ID, 'workbench.editor.reviewchanges');
		});

		test('toJSON uses the verbatim serialized shape {composerIdOverride, parentComposerId, options}', () => {
			const input = createReviewInput({ composerId: 'agent-1', parentComposerId: 'agent-0', scrollToFile: '/repo/a.ts', gitMode: true });
			const json = input.toJSON();
			assert.strictEqual(json.multiDiffSourceUri, 'changes-multi-diff-source://session');
			assert.strictEqual(json.composerIdOverride, 'agent-1');
			assert.strictEqual(json.parentComposerId, 'agent-0');
			assert.deepStrictEqual(json.options, { composerId: 'agent-1', parentComposerId: 'agent-0', scrollToFile: '/repo/a.ts', gitMode: true });
		});

		test('serializer round-trips through the verbatim shape', () => {
			const serializer = new SessionReviewChangesEditorSerializer();
			const input = createReviewInput({ composerId: 'agent-1', scrollToFile: '/repo/a.ts' });
			assert.strictEqual(serializer.canSerialize(input), true);
			const serialized = serializer.serialize(input);
			if (typeof serialized !== 'string') {
				throw new Error('expected the review input to serialize');
			}
			const parsed = JSON.parse(serialized);
			assert.strictEqual(parsed.composerIdOverride, 'agent-1');
			const restored = serializer.deserialize(instantiationService, serialized);
			assert.ok(restored instanceof SessionReviewChangesEditorInput);
			assert.deepStrictEqual((restored as SessionReviewChangesEditorInput).reviewProps.scrollToFile, '/repo/a.ts');
		});

		test('does not match the plain Changes editor input for the same session', () => {
			const reviewInput = createReviewInput({ composerId: 'agent-1' });
			const changesInput = disposables.add(new SessionChangesEditorInput(
				URI.parse('changes-multi-diff-source://session'),
				instantiationService,
				fakeSessionChangesService,
				fakeLayoutService,
			));
			assert.strictEqual(reviewInput.matches(changesInput), false);
			assert.strictEqual(changesInput.matches(reviewInput), false);
			// ...but two review inputs for the same agent+file do match.
			const sameReviewInput = createReviewInput({ composerId: 'agent-1' });
			assert.strictEqual(reviewInput.matches(sameReviewInput), true);
		});
	});
});
