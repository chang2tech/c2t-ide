/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { DebugServerService, chooseNdjsonPort } from '../../electron-browser/debugServerService.js';
import {
	IDebugIngestCommandDeps,
	IDebugIngestCommandUi,
	IDebugIngestMessageAction,
	NDJSON_INGEST_COMMAND_IDS,
	NDJSON_INGEST_COMMAND_TITLES,
	copyDebugIngestCurl,
	reassignDebugIngestPort,
	showDebugIngestStatus,
	startDebugIngestServer,
	stopDebugIngestServer,
} from '../../electron-browser/debugIngestCommands.js';

/**
 * GAPS-46B — `ide.ndjsonIngest.*` command parity (P1, evidence: Cursor
 * 3.25.x `cursor-ndjson-ingest` extension binary, see debugIngestCommands.ts).
 *
 * These tests run against a REAL DebugServerService (real localhost HTTP
 * server on 127.0.0.1); only the VS Code UI surface (notifications,
 * clipboard, settings) is stubbed, since the workbench is not available in
 * unit tests.
 *
 * Binary-verbatim strings asserted here:
 *  - copyCurl template: `curl -sS -H "Content-Type: application/x-ndjson"
 *    --data-binary '{"hello":"world"}' "<url>"` (NO session header — that is
 *    Cursor's actual template)
 *  - "Server is not running." / "NDJSON Ingest: curl command copied to
 *    clipboard." / "NDJSON: server not running." / `URL: <url>`
 *  - reassignPort pinned refusal + "Change Port" action; success messages.
 *  - start (GAPS-161): silent {externalUrl, logPath} success return,
 *    "debug mode disabled in untrusted workspace." warning + undefined,
 *    "NDJSON Ingest: …" error + string return on failure.
 */

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

interface StubUi extends IDebugIngestCommandUi {
	infos: string[];
	warns: string[];
	errors: { message: string; actions: IDebugIngestMessageAction[] }[];
	clipboard: string;
	settingsQueries: string[];
}

function createStubUi(): StubUi {
	const ui: StubUi = {
		infos: [],
		warns: [],
		errors: [],
		clipboard: '',
		settingsQueries: [],
		showInformationMessage: (message: string) => {
			ui.infos.push(message);
		},
		showWarningMessage: (message: string) => {
			ui.warns.push(message);
		},
		showErrorMessage: (message: string, actions: IDebugIngestMessageAction[] = []) => {
			ui.errors.push({ message, actions });
		},
		clipboardWriteText: async (text: string) => {
			ui.clipboard = text;
		},
		openSettings: (query: string) => {
			ui.settingsQueries.push(query);
		},
	};
	return ui;
}

function httpOptionsStatus(url: string): Promise<number> {
	return new Promise((resolve) => {
		const u = new URL(url);
		const req = http.request(
			{ method: 'OPTIONS', hostname: u.hostname, port: Number(u.port), path: u.pathname },
			(res) => {
				res.resume();
				res.on('end', () => resolve(res.statusCode ?? 0));
			},
		);
		req.on('error', () => resolve(0));
		req.setTimeout(2000, () => req.destroy());
		req.end();
	});
}

function httpPost(url: string, body: string, sessionId = 'test-session'): Promise<{ status: number; text: string }> {
	return new Promise((resolve) => {
		const u = new URL(url);
		const req = http.request(
			{
				method: 'POST',
				hostname: u.hostname,
				port: Number(u.port),
				path: u.pathname,
				headers: {
					'Content-Type': 'application/x-ndjson',
					'Content-Length': Buffer.byteLength(body),
					'X-Debug-Session-Id': sessionId,
				},
			},
			(res) => {
				let text = '';
				res.on('data', (c) => (text += c));
				res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
			},
		);
		req.on('error', (e) => resolve({ status: 0, text: String(e) }));
		req.setTimeout(2000, () => req.destroy());
		req.end(body);
	});
}

function httpPostHeaders(
	url: string,
	body: string,
	headers: Record<string, string>,
	method = 'POST',
): Promise<{ status: number; text: string; contentType: string | undefined }> {
	return new Promise((resolve) => {
		const u = new URL(url);
		const req = http.request(
			{
				method,
				hostname: u.hostname,
				port: Number(u.port),
				path: u.pathname,
				headers: {
					'Content-Type': 'application/x-ndjson',
					'Content-Length': Buffer.byteLength(body),
					...headers,
				},
			},
			(res) => {
				let text = '';
				res.on('data', (c) => (text += c));
				res.on('end', () =>
					resolve({ status: res.statusCode ?? 0, text, contentType: res.headers['content-type'] as string | undefined }),
				);
			},
		);
		req.on('error', (e) => resolve({ status: 0, text: String(e), contentType: undefined }));
		req.setTimeout(2000, () => req.destroy());
		req.end(body);
	});
}

suite('GAPS-46B debug-ingest-server-commands', () => {
	let server: DebugServerService;
	let ui: StubUi;
	let deps: IDebugIngestCommandDeps;
	let storageDir: string;

	setup(() => {
		storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dic-test-'));
		server = new DebugServerService({ logDir: storageDir });
		ui = createStubUi();
		deps = { server, getConfiguredPort: () => 0, ui };
	});

	teardown(async () => {
		await server.stop();
		fs.rmSync(storageDir, { recursive: true, force: true });
	});

	test('command ids + titles: the 5 binary commands are registered with binary titles', () => {
		assert.strictEqual(NDJSON_INGEST_COMMAND_IDS.start, 'ide.ndjsonIngest.start');
		assert.strictEqual(NDJSON_INGEST_COMMAND_IDS.stop, 'ide.ndjsonIngest.stop');
		assert.strictEqual(NDJSON_INGEST_COMMAND_IDS.copyCurl, 'ide.ndjsonIngest.copyCurl');
		assert.strictEqual(NDJSON_INGEST_COMMAND_IDS.reassignPort, 'ide.ndjsonIngest.reassignPort');
		assert.strictEqual(NDJSON_INGEST_COMMAND_IDS.showStatus, 'ide.ndjsonIngest.showStatus');
		// Binary titles verbatim ("Cursor NDJSON Ingest: …" minus the brand).
		assert.strictEqual(NDJSON_INGEST_COMMAND_TITLES.start, 'NDJSON Ingest: Start Server');
		assert.strictEqual(NDJSON_INGEST_COMMAND_TITLES.stop, 'NDJSON Ingest: Stop Server');
		assert.strictEqual(NDJSON_INGEST_COMMAND_TITLES.copyCurl, 'NDJSON Ingest: Copy curl command');
		assert.strictEqual(NDJSON_INGEST_COMMAND_TITLES.reassignPort, 'NDJSON Ingest: Reassign port and restart server');
		assert.strictEqual(NDJSON_INGEST_COMMAND_TITLES.showStatus, 'NDJSON Ingest: Show server info');
	});

	// -----------------------------------------------------------------------
	// GAPS-161 — `ide.ndjsonIngest.start` (binary `$()` @6484, wrapper @2960):
	// serialized through N(); success returns {externalUrl, logPath} with NO
	// UI message; already-running returns the live config without restart;
	// untrusted → warning + undefined; failure → error + string return.
	// -----------------------------------------------------------------------

	test('start: starts the server when not running and returns {externalUrl, logPath} silently', async () => {
		const result = await startDebugIngestServer(deps);
		assert.ok(typeof result === 'object' && result !== null, 'success returns the config object (binary $())');
		const { externalUrl, logPath } = result as { externalUrl: string; logPath: string };
		assert.strictEqual(externalUrl, server.getServerUrl());
		assert.strictEqual(logPath, server.getConfig()!.logPath);
		// No session arg → a manual session is minted (reassignPort precedent).
		assert.ok(server.getConfig()!.sessionId.startsWith('debug-manual-'), 'manual session minted');
		assert.ok(logPath.endsWith(`debug-${server.getConfig()!.sessionId}.log`));
		const port = server.getPort();
		assert.ok(port >= 7242 && port <= 7942, 'port in Cursor\'s 7242–7942 range');
		assert.strictEqual(await httpOptionsStatus(externalUrl), 200, 'started server is live');
		// The binary shows NO message on a successful start.
		assert.deepStrictEqual(ui.infos, []);
		assert.deepStrictEqual(ui.warns, []);
		assert.deepStrictEqual(ui.errors, []);
	});

	test('start: a string arg is the session id (binary wrapper @2960); an object arg works too', async () => {
		const byString = await startDebugIngestServer(deps, 'start-test');
		assert.ok(typeof byString === 'object' && byString !== null);
		assert.ok((byString as { logPath: string }).logPath.endsWith('debug-start-test.log'));
		const post = await httpPost(server.getServerUrl()!, '{"hello":"start"}', 'start-test');
		assert.strictEqual(post.status, 204, 'manually started server ingests');

		await stopDebugIngestServer(deps);
		const byObject = await startDebugIngestServer(deps, { sessionId: 'obj-test', surface: 'classic' });
		assert.ok(typeof byObject === 'object' && byObject !== null);
		assert.ok((byObject as { logPath: string }).logPath.endsWith('debug-obj-test.log'));
	});

	test('start: already running with the same session returns the live config WITHOUT restarting', async () => {
		await server.ensureStarted('same-test');
		const urlBefore = server.getServerUrl()!;
		const portBefore = server.getPort();

		const noArg = await startDebugIngestServer(deps);
		assert.deepStrictEqual(noArg, { externalUrl: urlBefore, logPath: server.getConfig()!.logPath });
		const sameArg = await startDebugIngestServer(deps, 'same-test');
		assert.deepStrictEqual(sameArg, { externalUrl: urlBefore, logPath: server.getConfig()!.logPath });

		assert.strictEqual(server.getServerUrl(), urlBefore, 'same target id — no restart happened');
		assert.strictEqual(server.getPort(), portBefore);
		assert.strictEqual(await httpOptionsStatus(urlBefore), 200);
		assert.deepStrictEqual(ui.infos, []);
		assert.deepStrictEqual(ui.warns, []);
		assert.deepStrictEqual(ui.errors, []);
	});

	test('start: a different session id restarts with a fresh target id (binary identity switch)', async () => {
		await server.ensureStarted('first-test');
		const targetBefore = server.getServerUrl()!.split('/ingest/')[1];

		const result = await startDebugIngestServer(deps, 'second-test');
		assert.ok(typeof result === 'object' && result !== null);
		assert.ok((result as { logPath: string }).logPath.endsWith('debug-second-test.log'));
		const targetAfter = server.getServerUrl()!.split('/ingest/')[1];
		assert.notStrictEqual(targetAfter, targetBefore, 'restart mints a fresh target id');
		assert.strictEqual(await httpOptionsStatus(server.getServerUrl()!), 200);
	});

	test('start: untrusted workspace warns verbatim and returns undefined (binary $())', async () => {
		const untrusted = new DebugServerService({ logDir: storageDir, workspaceTrusted: false });
		try {
			const result = await startDebugIngestServer({ server: untrusted, getConfiguredPort: () => 0, ui });
			assert.strictEqual(result, undefined, 'binary returns void on trust refusal');
			assert.deepStrictEqual(ui.warns, ['debug mode disabled in untrusted workspace.']);
			assert.deepStrictEqual(ui.errors, []);
			assert.strictEqual(untrusted.getServerUrl(), undefined, 'server must not start');
		} finally {
			await untrusted.stop();
		}
	});

	test('start: a start failure shows "NDJSON Ingest: …" and returns the message string', async () => {
		// Pin the server to a port that is already occupied.
		const blocker = http.createServer();
		await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', () => resolve()));
		const blockedPort = (blocker.address() as { port: number }).port;
		const pinned = new DebugServerService({ logDir: storageDir, ndjsonPort: blockedPort });
		try {
			const result = await startDebugIngestServer({ server: pinned, getConfiguredPort: () => blockedPort, ui });
			assert.strictEqual(typeof result, 'string', 'binary returns an error string on start failure');
			assert.ok((result as string).includes(`${blockedPort}`), 'string carries the failure');
			assert.strictEqual(ui.errors.length, 1);
			assert.strictEqual(ui.errors[0].message, `NDJSON Ingest: ${result as string}`);
			assert.strictEqual(pinned.getServerUrl(), undefined);
		} finally {
			await pinned.stop();
			await new Promise<void>((resolve) => blocker.close(() => resolve()));
		}
	});

	test('stop: stops the real server; safe to call when not started', async () => {
		await server.ensureStarted('stop-test');
		const url = server.getServerUrl();
		assert.ok(url, 'server should be running');
		// Liveness probe: the binary answers OPTIONS → 200 on any path
		// (there is no /health route — "other → 404").
		assert.strictEqual(await httpOptionsStatus(url!), 200);

		await stopDebugIngestServer(deps);

		assert.strictEqual(server.getServerUrl(), undefined);
		assert.strictEqual(server.getPort(), 0);
		assert.strictEqual(await httpOptionsStatus(url!), 0, 'port should be closed');
		// No UI noise on stop (the binary's D() is silent).
		assert.deepStrictEqual(ui.infos, []);
		assert.deepStrictEqual(ui.warns, []);
		assert.deepStrictEqual(ui.errors, []);

		// Second stop is a safe no-op.
		await stopDebugIngestServer(deps);
	});

	test('copyCurl: warns when the server is not running, clipboard untouched', async () => {
		await copyDebugIngestCurl(deps);
		assert.deepStrictEqual(ui.warns, ['Server is not running.']);
		assert.strictEqual(ui.clipboard, '');
		assert.deepStrictEqual(ui.infos, []);
	});

	test('copyCurl: copies the binary-verbatim curl for the running server; the URL works', async () => {
		await server.ensureStarted('curl-test');
		const url = server.getServerUrl()!;

		await copyDebugIngestCurl(deps);

		// Binary-verbatim template (main.js @~3245) — notably NO session header.
		assert.strictEqual(
			ui.clipboard,
			`curl -sS -H "Content-Type: application/x-ndjson" --data-binary '{"hello":"world"}' "${url}"`,
		);
		assert.deepStrictEqual(ui.infos, ['NDJSON Ingest: curl command copied to clipboard.']);

		// The copied command targets the live endpoint: extract the URL and POST like curl would.
		// (The binary's curl template carries no session header; the test
		// adds the header the agent convention requires.)
		const m = /"([^"]+)"\s*$/.exec(ui.clipboard);
		assert.ok(m, 'curl should end with a quoted URL');
		const post = await httpPost(m![1], '{"hello":"world"}', 'curl-test');
		assert.strictEqual(post.status, 204, 'copied curl URL should accept the POST');
		assert.strictEqual(post.text, '', 'binary returns 204 with an empty body');
		const logPath = server.getConfig()!.logPath;
		assert.ok(fs.readFileSync(logPath, 'utf8').includes('{"hello":"world"}'), 'line should be ingested');
	});

	test('showStatus: shows the URL when running, the not-running line when stopped', async () => {
		showDebugIngestStatus(deps);
		assert.deepStrictEqual(ui.infos, ['NDJSON: server not running.']);

		await server.ensureStarted('status-test');
		const url = server.getServerUrl()!;
		ui.infos.length = 0;
		showDebugIngestStatus(deps);
		assert.deepStrictEqual(ui.infos, [`URL: ${url}`]);
	});

	test('reassignPort: refuses when the port is pinned, with a Change Port action', async () => {
		deps.getConfiguredPort = () => 8080;
		await server.ensureStarted('pinned-test');
		const portBefore = server.getPort();

		const result = await reassignDebugIngestPort(deps);

		assert.strictEqual(result, 'Cannot reassign pinned port 8080');
		assert.strictEqual(ui.errors.length, 1);
		assert.ok(ui.errors[0].message.includes('Cannot reassign the port while ide.debug.ndjsonPort is pinned to 8080'));
		assert.ok(ui.errors[0].message.includes('Set ide.debug.ndjsonPort to 0'));
		const changePort = ui.errors[0].actions.find((a) => a.label === 'Change Port');
		assert.ok(changePort, 'binary j() offers a "Change Port" button');
		changePort!.run();
		assert.deepStrictEqual(ui.settingsQueries, ['ide.debug.ndjsonPort']);
		// Server untouched.
		assert.strictEqual(server.getPort(), portBefore);
	});

	test('reassignPort: restarts on a fresh port, keeps the target id, keeps the log', async () => {
		await server.ensureStarted('reassign-test');
		const urlBefore = server.getServerUrl()!;
		const targetBefore = urlBefore.split('/ingest/')[1];
		const portBefore = server.getPort();
		// Ingest a line first — the binary appends across reassign (no truncation).
		await httpPost(urlBefore, '{"hello":"before"}', 'reassign-test');
		const logPath = server.getConfig()!.logPath;

		const result = await reassignDebugIngestPort(deps);

		assert.ok(typeof result === 'object', 'success returns ports');
		const { oldPort, newPort } = result as { oldPort: number; newPort: number };
		assert.strictEqual(oldPort, portBefore);
		assert.notStrictEqual(newPort, oldPort, 'old port must be excluded from allocation');
		assert.ok(newPort >= 7242 && newPort <= 7942, 'fresh port in Cursor\'s 7242–7942 range');

		const urlAfter = server.getServerUrl()!;
		assert.strictEqual(urlAfter.split('/ingest/')[1], targetBefore, 'target id is sticky across reassign');
		assert.strictEqual(await httpOptionsStatus(urlAfter), 200);
		assert.strictEqual(
			await httpOptionsStatus(urlBefore),
			0,
			'old port should be closed',
		);
		assert.ok(fs.readFileSync(logPath, 'utf8').includes('{"hello":"before"}'), 'log survives reassign');
		assert.deepStrictEqual(ui.infos, [
			`NDJSON Ingest: Reassigned workspace port from ${portBefore} to ${newPort} and restarted the server.`,
		]);
	});

	test('reassignPort: starts the server when it was not running', async () => {
		const result = await reassignDebugIngestPort(deps);
		assert.ok(typeof result === 'object');
		const { oldPort, newPort } = result as { oldPort: number; newPort: number };
		assert.strictEqual(oldPort, 0);
		assert.ok(newPort >= 7242 && newPort <= 7942);
		assert.ok(server.getServerUrl(), 'server should be running');
		assert.deepStrictEqual(ui.infos, [`NDJSON Ingest: Restarted the server on port ${newPort}.`]);
	});

	test('chooseNdjsonPort: respects excludedPorts + configuredPort, stays in range', async () => {
		const picked = await chooseNdjsonPort({ excludedPorts: [7242, 7243] });
		assert.ok(picked >= 7242 && picked <= 7942);
		assert.ok(![7242, 7243].includes(picked));
		assert.strictEqual(await chooseNdjsonPort({ configuredPort: 7500 }), 7500, 'pinned port returned as-is');
		// Excluding the whole range must fail loudly (binary throws).
		await assert.rejects(
			chooseNdjsonPort({
				excludedPorts: Array.from({ length: 7942 - 7242 + 1 }, (_, i) => 7242 + i),
			}),
			/No available ports/,
		);
	});

	test('stop then reassignPort keeps working (serialized chain survives)', async () => {
		await server.ensureStarted('chain-test');
		const p1 = await Promise.all([stopDebugIngestServer(deps), reassignDebugIngestPort(deps)]);
		// Both settle; the server ends up in a sane state (running or stopped, never half-torn).
		const url = server.getServerUrl();
		if (url) {
			assert.strictEqual(await httpOptionsStatus(url), 200);
		}
		assert.ok(p1.length === 2);
	});

	// -----------------------------------------------------------------------
	// W52B — NDJSON route validation parity with the binary
	// (extensions/cursor-ndjson-ingest/dist/main.js, module 93 `handleRequest`):
	// OPTIONS → 200 (any path); non-POST / wrong path → 404;
	// missing X-Debug-Session-Id → 400 "missing-session-id";
	// non-pattern X-Debug-Session-Id → 400 "invalid-session-id"
	// (`/^[a-zA-Z0-9-]+$/`); valid POST → 204 with an EMPTY body (never JSON).
	// -----------------------------------------------------------------------

	test('route: POST without X-Debug-Session-Id → 400 "missing-session-id"', async () => {
		await server.ensureStarted('w52b-noheader');
		const url = server.getServerUrl()!;
		const res = await httpPostHeaders(url, '{"hello":"world"}', {});
		assert.strictEqual(res.status, 400, 'POST without session header must be rejected');
		assert.strictEqual(res.text, 'missing-session-id');
		// Nothing must have been ingested for the rejected request.
		const logPath = server.getConfig()!.logPath;
		assert.ok(!fs.existsSync(logPath) || fs.readFileSync(logPath, 'utf8') === '', 'rejected body must not hit the log');
	});

	test('route: POST with invalid X-Debug-Session-Id → 400 "invalid-session-id"', async () => {
		await server.ensureStarted('w52b-badheader');
		const url = server.getServerUrl()!;
		for (const bad of ['has space', 'bad/id', 'semi;colon', '']) {
			const res = await httpPostHeaders(url, '{"hello":"world"}', { 'X-Debug-Session-Id': bad });
			assert.strictEqual(res.status, 400, `header ${JSON.stringify(bad)} must be rejected`);
			assert.strictEqual(res.text, 'invalid-session-id');
		}
	});

	test('route: valid POST → 204 with empty body (binary never returns JSON here)', async () => {
		await server.ensureStarted('w52b-valid');
		const url = server.getServerUrl()!;
		const res = await httpPostHeaders(url, '{"hello":"world"}', { 'X-Debug-Session-Id': 'w52b-valid' });
		assert.strictEqual(res.status, 204);
		assert.strictEqual(res.text, '', 'binary ends the 204 response with an empty body');
		assert.ok(
			!res.contentType || !res.contentType.includes('json'),
			`must not answer JSON (got content-type: ${res.contentType})`,
		);
		const logPath = server.getConfig()!.logPath;
		assert.ok(fs.readFileSync(logPath, 'utf8').includes('{"hello":"world"}'), 'line should be ingested');
	});

	test('route: wrong ingest path and non-POST → 404', async () => {
		await server.ensureStarted('w52b-404');
		const url = server.getServerUrl()!;
		const wrongUrl = url.replace(/\/ingest\/[^/]+$/, '/ingest/wrong-target-id');
		const res = await httpPostHeaders(wrongUrl, '{"hello":"world"}', { 'X-Debug-Session-Id': 'w52b-404' });
		assert.strictEqual(res.status, 404);
		const get = await httpPostHeaders(url, '', { 'X-Debug-Session-Id': 'w52b-404' }, 'GET');
		assert.strictEqual(get.status, 404, 'binary only serves POST on the ingest path');
	});
});
