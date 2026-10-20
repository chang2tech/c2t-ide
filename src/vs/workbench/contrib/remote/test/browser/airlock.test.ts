/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: DEV-GAPS-105C — tests for the airlock pure model
// (`../../common/airlock.ts`, ported verbatim from Cursor 3.26.13 — see the
// model header for binary evidence). Ported from the standalone harness used
// by DEV-GAPS-105B (23 cases, all passing).

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	AIRLOCK_CONFIGURATION_PROPERTIES, AIRLOCK_POLICY_NAMES, airlockAttachError,
	airlockAvailabilityError, airlockStepLabel, buildAttachedContainerAuthority,
	buildAttachedContainerUriString, desktopAirlockFailureActions, formatAirlockFailure,
	glassAirlockFailureNotification, isAirlockConfigured, isAirlockContainer, isContainerId,
	normalizePrepareResult, parseAirlockAuthority, resolveAirlockAvailability, resolveAirlockConfig,
} from '../../common/airlock.js';

suite('Airlock (Cursor 3.26.13 model)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const reader = (obj: Record<string, unknown>) => (name: string) => obj[name];
	const POSIX = { isWindows: false };

	test('unconfigured when no policy values', () => {
		assert.strictEqual(resolveAirlockAvailability(reader({}), POSIX).kind, 'unconfigured');
		assert.strictEqual(resolveAirlockAvailability(reader({ AirlockContainerName: '  ' }), POSIX).kind, 'unconfigured');
		assert.strictEqual(isAirlockConfigured(reader({})), false);
	});

	test('available with verbatim target', () => {
		const av = resolveAirlockAvailability(reader({ AirlockContainerName: 'dev-box', AirlockDefaultWorkspace: '/workspaces/app' }), POSIX);
		assert.deepStrictEqual(av, { kind: 'available', containerName: 'dev-box', defaultWorkspace: '/workspaces/app' });
	});

	test('invalid: containerName unset reason verbatim (policy name as {0})', () => {
		const av = resolveAirlockAvailability(reader({ AirlockDefaultWorkspace: '/ws' }), POSIX);
		assert.strictEqual(av.kind, 'invalid');
		if (av.kind === 'invalid') {
			assert.strictEqual(av.reason, "AirlockContainerName isn't set.");
		}
	});

	test('invalid: containerName pattern reason verbatim', () => {
		const av = resolveAirlockAvailability(reader({ AirlockContainerName: '-bad name', AirlockDefaultWorkspace: '/ws' }), POSIX);
		if (av.kind === 'invalid') {
			assert.strictEqual(av.reason, "AirlockContainerName must be a container name: letters, digits, '_', '.' and '-', starting with a letter or digit.");
		} else { assert.fail('expected invalid'); }
	});

	test('invalid: workspace not absolute', () => {
		const av = resolveAirlockAvailability(reader({ AirlockContainerName: 'ok', AirlockDefaultWorkspace: 'relative/ws' }), POSIX);
		if (av.kind === 'invalid') {
			assert.strictEqual(av.reason, 'AirlockDefaultWorkspace must be an absolute path inside the container.');
		} else { assert.fail('expected invalid'); }
	});

	test('invalid: containerUser pattern', () => {
		const av = resolveAirlockAvailability(reader({ AirlockContainerName: 'ok', AirlockDefaultWorkspace: '/ws', AirlockContainerUser: 'bad user' }), POSIX);
		if (av.kind === 'invalid') {
			assert.strictEqual(av.reason, "AirlockContainerUser must be a user name or id, optionally followed by ':' and a group.");
		} else { assert.fail('expected invalid'); }
	});

	test('invalid: engine relative path with slash', () => {
		const av = resolveAirlockAvailability(reader({ AirlockContainerName: 'ok', AirlockDefaultWorkspace: '/ws', AirlockEngine: 'bin/docker' }), POSIX);
		if (av.kind === 'invalid') {
			assert.strictEqual(av.reason, 'AirlockEngine must be docker, podman, or an absolute path.');
		} else { assert.fail('expected invalid'); }
	});

	test('invalid: hook not absolute', () => {
		const av = resolveAirlockAvailability(reader({ AirlockContainerName: 'ok', AirlockDefaultWorkspace: '/ws', AirlockCreateContainerHook: 'rel/hook.sh' }), POSIX);
		if (av.kind === 'invalid') {
			assert.strictEqual(av.reason, 'AirlockCreateContainerHook must be an absolute path.');
		} else { assert.fail('expected invalid'); }
	});

	test('invalid: non-string value', () => {
		const av = resolveAirlockAvailability(reader({ AirlockContainerName: 42, AirlockDefaultWorkspace: '/ws' }), POSIX);
		if (av.kind === 'invalid') {
			assert.strictEqual(av.reason, 'AirlockContainerName must be a string.');
		} else { assert.fail('expected invalid'); }
	});

	test('invalid: hook timeout not positive', () => {
		const av = resolveAirlockAvailability(reader({ AirlockContainerName: 'ok', AirlockDefaultWorkspace: '/ws', AirlockHookTimeoutSeconds: 0 }), POSIX);
		if (av.kind === 'invalid') {
			assert.strictEqual(av.reason, 'AirlockHookTimeoutSeconds must be a positive number of seconds.');
		} else { assert.fail('expected invalid'); }
	});

	test('resolved config defaults: docker engine, 120s timeout', () => {
		const cfg = resolveAirlockConfig(reader({ AirlockContainerName: 'ok', AirlockDefaultWorkspace: '/ws' }), POSIX);
		assert.ok(cfg);
		assert.strictEqual(cfg!.engine.kind, 'docker');
		assert.strictEqual(cfg!.engine.command, 'docker');
		assert.strictEqual(cfg!.hookTimeoutMs, 120000);
		assert.deepStrictEqual(cfg!.hooks, {});
	});

	test('resolved config: podman + hooks + custom timeout', () => {
		const cfg = resolveAirlockConfig(reader({ AirlockContainerName: 'ok', AirlockDefaultWorkspace: '/ws', AirlockEngine: 'podman', AirlockStartContainerHook: '/opt/start.sh', AirlockHookTimeoutSeconds: '30' }), POSIX);
		assert.ok(cfg);
		assert.strictEqual(cfg!.engine.kind, 'podman');
		assert.strictEqual(cfg!.hooks.start_container, '/opt/start.sh');
		assert.strictEqual(cfg!.hookTimeoutMs, 30000);
	});

	test('resolved config: absolute engine path classifies by basename', () => {
		const cfg = resolveAirlockConfig(reader({ AirlockContainerName: 'ok', AirlockDefaultWorkspace: '/ws', AirlockEngine: '/usr/local/bin/podman' }), POSIX);
		assert.strictEqual(cfg?.engine.kind, 'podman');
		const wrap = resolveAirlockConfig(reader({ AirlockContainerName: 'ok', AirlockDefaultWorkspace: '/ws', AirlockEngine: '/opt/wrap.sh' }), POSIX);
		assert.strictEqual(wrap?.engine.kind, 'wrapper');
	});

	test('availability errors verbatim', () => {
		assert.deepStrictEqual(airlockAvailabilityError({ kind: 'disabled' }, 'inspect'), { code: 'disabled', step: 'inspect', message: 'The airlock is only available in SpaceX mode.' });
		assert.deepStrictEqual(airlockAvailabilityError({ kind: 'unconfigured' }, 'inspect'), { code: 'notConfigured', step: 'inspect', message: "IT hasn't set up the airlock on this computer." });
		assert.strictEqual(airlockAvailabilityError({ kind: 'invalid', reason: 'X' }, 'inspect')?.message, "IT's airlock settings on this computer can't be used: X");
		assert.strictEqual(airlockAvailabilityError({ kind: 'signedOut' }, 'inspect')?.message, 'Sign in with your SpaceX account to use the airlock.');
		assert.strictEqual(airlockAvailabilityError({ kind: 'available', containerName: 'a', defaultWorkspace: '/w' }, 'inspect'), undefined);
	});

	test('step labels + failure format verbatim', () => {
		assert.strictEqual(airlockStepLabel('inspect'), 'Looking for the container');
		assert.strictEqual(airlockStepLabel('attach'), 'Getting Dev Containers ready');
		assert.strictEqual(airlockStepLabel('serverCheck'), 'Checking for the Cursor server');
		assert.strictEqual(formatAirlockFailure({ step: 'attach', message: 'boom' }), 'Getting Dev Containers ready: boom');
		assert.strictEqual(formatAirlockFailure({ message: 'boom' }), 'boom');
	});

	test('authority build/parse round-trip', () => {
		const auth = buildAttachedContainerAuthority('dev-box');
		const expectedHex = Buffer.from(JSON.stringify({ containerName: 'dev-box' }), 'utf8').toString('hex');
		assert.strictEqual(auth, `attached-container+${expectedHex}`);
		assert.strictEqual(buildAttachedContainerUriString('dev-box', '/workspaces/app'), `vscode-remote://attached-container+${expectedHex}/workspaces/app`);
		assert.strictEqual(parseAirlockAuthority(auth), 'dev-box');
		assert.strictEqual(parseAirlockAuthority('ssh-remote+abc'), undefined);
		assert.strictEqual(parseAirlockAuthority('attached-container'), undefined);
	});

	test('parse authority with containerId payload + @ suffix', () => {
		const hex = Buffer.from(JSON.stringify({ containerId: 'abc123def456' }), 'utf8').toString('hex');
		assert.strictEqual(parseAirlockAuthority(`dev-container+${hex}@host`), 'abc123def456');
	});

	test('isContainerId + isAirlockContainer', () => {
		assert.strictEqual(isContainerId('abc123def456'), true);
		assert.strictEqual(isContainerId('abc123'), false);
		assert.strictEqual(isContainerId('ABC123DEF456'), false);
		assert.strictEqual(isAirlockContainer('dev-box', 'dev-box', undefined), true);
		assert.strictEqual(isAirlockContainer('abc123def456', 'dev-box', 'abc123def4567890'), true);
		assert.strictEqual(isAirlockContainer('abc123def456', 'dev-box', 'zzz123def4567890'), false);
		assert.strictEqual(isAirlockContainer('other', 'dev-box', undefined), false);
	});

	test('normalizePrepareResult: ok / structured error / fallback verbatim', () => {
		const uriToString = (v: unknown) => typeof v === 'string' && v.startsWith('vscode-remote://') ? v : undefined;
		assert.deepStrictEqual(normalizePrepareResult({ ok: true, uri: 'vscode-remote://x/y' }, uriToString), { ok: true, uriString: 'vscode-remote://x/y' });
		assert.deepStrictEqual(normalizePrepareResult({ ok: false, error: { message: 'm', step: 'attach', logPath: '/tmp/l' } }, uriToString), { ok: false, error: { message: 'm', step: 'attach', logPath: '/tmp/l' } });
		const fallback = normalizePrepareResult({ nonsense: 1 }, uriToString);
		assert.strictEqual(fallback.ok, false);
		if (!fallback.ok) { assert.strictEqual(fallback.error.message, "Cursor couldn't get the airlock ready."); }
	});

	test('glass failure notification model verbatim', () => {
		const n = glassAirlockFailureNotification({ step: 'attach', message: 'boom', logPath: '/logs/a.log' });
		assert.strictEqual(n.id, 'glass.airlock-connect-failed');
		assert.strictEqual(n.message, "Couldn't connect to the airlock. Getting Dev Containers ready: boom");
		assert.strictEqual(n.toastTitle, "Couldn't connect to the airlock");
		assert.deepStrictEqual(n.primary, [{ id: 'glass.airlock.tryAgain', label: 'Try Again' }]);
		assert.deepStrictEqual(n.secondary, [{ id: 'glass.airlock.openLog', label: 'Open Log' }]);
		const noLog = glassAirlockFailureNotification({ message: 'boom' });
		assert.deepStrictEqual(noLog.secondary, []);
		assert.strictEqual(noLog.message, "Couldn't connect to the airlock. boom");
	});

	test('desktop failure actions model', () => {
		assert.deepStrictEqual(desktopAirlockFailureActions({ message: 'x', logPath: '/l' }, true), [{ id: 'airlock.openLog', label: 'Open Log' }, { id: 'airlock.reloadWindow', label: 'Reload Window' }]);
		assert.deepStrictEqual(desktopAirlockFailureActions({ message: 'x', logPath: '/l' }, false), [{ id: 'airlock.openLog', label: 'Open Log' }]);
		assert.deepStrictEqual(desktopAirlockFailureActions({ message: 'x' }, false), []);
		assert.deepStrictEqual(desktopAirlockFailureActions({ message: 'x' }, true), [{ id: 'airlock.reloadWindow', label: 'Reload Window' }]);
	});

	test('airlockAttachError shape', () => {
		assert.deepStrictEqual(airlockAttachError('devContainersMissing', 'm'), { ok: false, error: { code: 'devContainersMissing', step: 'attach', message: 'm' } });
	});

	test('config properties: 10 keys, verbatim order + policies', () => {
		assert.strictEqual(AIRLOCK_CONFIGURATION_PROPERTIES.length, 10);
		assert.deepStrictEqual([...AIRLOCK_POLICY_NAMES], ['AirlockContainerName', 'AirlockDefaultWorkspace', 'AirlockContainerUser', 'AirlockEngine', 'AirlockCreateContainerHook', 'AirlockStartContainerHook', 'AirlockPreAttachContainerHook', 'AirlockRestartContainerHook', 'AirlockContainerStatusHook', 'AirlockHookTimeoutSeconds']);
		assert.strictEqual(AIRLOCK_CONFIGURATION_PROPERTIES[0].key, 'cursorAuth.xaiIdentity.airlock.containerName');
		assert.strictEqual(AIRLOCK_CONFIGURATION_PROPERTIES[9].defaultValue, 120);
	});
});
