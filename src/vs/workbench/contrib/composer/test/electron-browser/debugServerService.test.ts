/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { DebugServerService } from '../../electron-browser/debugServerService.js';

/**
 * GAPS-48C — NDJSON ingest SERVER behavior (route/header validation), QA step 2.
 * Re-verified verbatim against Cursor 3.25.9
 * `extensions/cursor-ndjson-ingest/dist/main.js` module 93
 * (class `NdjsonIngestServer`):
 *
 * - POST bodies are OPAQUE BYTES (appendExclusive stream pipeline; the only
 *   transformation is a guaranteed trailing newline — NO JSON validation);
 * - the only validated input is the `X-Debug-Session-Id` header against
 *   `/^[a-zA-Z0-9-]+$/`;
 * - routes: POST /ingest/{targetId} → 204; OPTIONS → 200;
 *   missing/invalid session header → 400; anything else → 404;
 * - log file `{logDir}/debug-{sessionId}.log`, logDir = `<ws>/.cursor`
 *   or `~/.cursor/debug-logs`;
 * - the server refuses untrusted workspaces
 *   ("debug mode disabled in untrusted workspace.").
 *
 * These tests run against a REAL DebugServerService (real localhost HTTP
 * server on 127.0.0.1). Kept separate from debugIngestCommands.test.ts:
 * that file covers the `ide.ndjsonIngest.*` COMMANDS (GAPS-46B); this one
 * covers the server's wire behavior.
 */

interface ProbeResult {
	status: number;
	text: string;
	headers: http.IncomingHttpHeaders;
}

function probe(
	method: string,
	url: string,
	headers: Record<string, string> = {},
	body?: string,
): Promise<ProbeResult> {
	return new Promise((resolve, reject) => {
		const u = new URL(url);
		const req = http.request(
			{ method, hostname: u.hostname, port: Number(u.port), path: u.pathname + u.search, headers },
			(res) => {
				let text = '';
				res.on('data', (c: Buffer) => (text += c.toString()));
				res.on('end', () => resolve({ status: res.statusCode ?? 0, text, headers: res.headers }));
			},
		);
		req.on('error', reject);
		req.setTimeout(5000, () => req.destroy(new Error('timeout')));
		req.end(body);
	});
}

function postIngest(url: string, body: string, sessionId?: string): Promise<ProbeResult> {
	const headers: Record<string, string> = { 'Content-Type': 'application/x-ndjson' };
	if (sessionId !== undefined) {
		headers['X-Debug-Session-Id'] = sessionId;
	}
	return probe('POST', url, headers, body);
}

function corsHeadersPresent(headers: http.IncomingHttpHeaders): void {
	assert.strictEqual(headers['access-control-allow-origin'], '*');
	assert.ok(String(headers['access-control-allow-methods']).includes('OPTIONS'));
	assert.ok(String(headers['access-control-allow-headers']).includes('X-Debug-Session-Id'));
}

suite('GAPS-48C debug-ingest-server wire behavior', () => {
	let server: DebugServerService;
	let logDir: string;

	setup(() => {
		logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dss-test-'));
		server = new DebugServerService({ logDir });
	});

	teardown(async () => {
		await server.stop();
		server.dispose();
		fs.rmSync(logDir, { recursive: true, force: true });
	});

	test('SESSION_ID_PATTERN is the binary-verbatim /^[a-zA-Z0-9-]+$/', () => {
		assert.strictEqual(String(DebugServerService.SESSION_ID_PATTERN), '/^[a-zA-Z0-9-]+$/');
		const valid = ['a', 'Z', '0', 'abc-123-XYZ', 'debug-composer-7', 'x'.repeat(500)];
		for (const id of valid) {
			assert.ok(DebugServerService.SESSION_ID_PATTERN.test(id), `${id} must be accepted`);
		}
		const invalid = ['', ' ', 'a b', 'a_b', 'a.b', 'a/b', '../x', 'a;b', 'a:b', 'ünï', 'a\tb', 'a\nb'];
		for (const id of invalid) {
			assert.ok(!DebugServerService.SESSION_ID_PATTERN.test(id), `${JSON.stringify(id)} must be rejected`);
		}
	});

	test('route table over the wire: OPTIONS 200, POST+valid header 204, bad header 400, other 404', async () => {
		const config = await server.ensureStarted('wire-test');
		const url = config.serverEndpoint;
		const base = url.replace(/\/ingest\/.*$/, '');

		// OPTIONS → 200 on any path, with CORS headers.
		const opt = await probe('OPTIONS', `${base}/ingest/does-not-matter`);
		assert.strictEqual(opt.status, 200);
		corsHeadersPresent(opt.headers);

		// Valid POST → 204, empty body, CORS headers present too.
		const ok = await postIngest(url, '{"hello":"world"}\n', 'wire-test');
		assert.strictEqual(ok.status, 204);
		assert.strictEqual(ok.text, '');
		corsHeadersPresent(ok.headers);

		// Missing header → 400 "missing-session-id".
		const missing = await postIngest(url, '{}\n');
		assert.strictEqual(missing.status, 400);
		assert.strictEqual(missing.text, 'missing-session-id');

		// Invalid header → 400 "invalid-session-id" (pattern mismatch).
		for (const bad of ['no good', 'under_score', '../x', '']) {
			const res = await postIngest(url, '{}\n', bad);
			assert.strictEqual(res.status, 400, `header ${JSON.stringify(bad)}`);
			assert.strictEqual(res.text, 'invalid-session-id');
		}

		// Wrong target id → 404 (unguessable per-session id).
		const wrong = await postIngest(`${base}/ingest/wrong-id`, '{}\n', 'wire-test');
		assert.strictEqual(wrong.status, 404);
		assert.strictEqual(wrong.text, '');

		// Exact raw-URL match: a query string defeats the route → 404.
		const query = await postIngest(`${url}?x=1`, '{}\n', 'wire-test');
		assert.strictEqual(query.status, 404);

		// Other methods/paths → 404 (there is no /health route).
		assert.strictEqual((await probe('GET', url)).status, 404);
		assert.strictEqual((await probe('GET', `${base}/health`)).status, 404);
		assert.strictEqual((await probe('DELETE', url)).status, 404);
	});

	test('body is opaque bytes: non-JSON passes through, trailing newline ensured', async () => {
		const config = await server.ensureStarted('opaque-test');

		// Not JSON at all, no trailing newline → 204, bytes + exactly one \n.
		const res = await postIngest(config.serverEndpoint, 'this is { not } json', 'opaque-test');
		assert.strictEqual(res.status, 204);
		let file = fs.readFileSync(config.logPath, 'utf8');
		assert.ok(file.endsWith('this is { not } json\n'));
		assert.ok(!file.endsWith('\n\n'), 'must not double the newline');

		// Already newline-terminated → no extra newline appended.
		await postIngest(config.serverEndpoint, 'line-a\n', 'opaque-test');
		file = fs.readFileSync(config.logPath, 'utf8');
		assert.ok(file.endsWith('line-a\n') && !file.endsWith('line-a\n\n'));

		// Empty body → 204, nothing written.
		const sizeBefore = fs.statSync(config.logPath).size;
		const empty = await postIngest(config.serverEndpoint, '', 'opaque-test');
		assert.strictEqual(empty.status, 204);
		assert.strictEqual(fs.statSync(config.logPath).size, sizeBefore);

		// The UI line feed still sees best-effort lines (our own stepping stone).
		assert.ok(server.getRecentLines(10).includes('this is { not } json'));
		assert.ok(server.getRecentLines(10).includes('line-a'));
	});

	test('concurrent POSTs serialize: every byte lands exactly once', async () => {
		const config = await server.ensureStarted('concurrent-test');
		const bodies = Array.from({ length: 25 }, (_, i) => `concurrent-${i}`);
		const results = await Promise.all(bodies.map((b) => postIngest(config.serverEndpoint, b, 'concurrent-test')));
		assert.ok(results.every((r) => r.status === 204));
		const file = fs.readFileSync(config.logPath, 'utf8');
		for (const b of bodies) {
			const occurrences = file.split(`${b}\n`).length - 1;
			assert.strictEqual(occurrences, 1, `${b} must appear exactly once`);
		}
		assert.ok(file.endsWith('\n') && !file.endsWith('\n\n'));
	});

	test('log file is {logDir}/debug-{sessionId}.log; per-request header session routes the file', async () => {
		const config = await server.ensureStarted('logpath-test');
		assert.strictEqual(config.logPath, path.join(logDir, 'debug-logpath-test.log'));

		// The header's session id — not the start session — picks the file ([BIN]).
		await postIngest(config.serverEndpoint, 'session-a-line\n', 'logpath-test');
		await postIngest(config.serverEndpoint, 'session-b-line\n', 'other-session');
		assert.ok(fs.readFileSync(config.logPath, 'utf8').includes('session-a-line'));
		assert.ok(!fs.readFileSync(config.logPath, 'utf8').includes('session-b-line'));
		assert.ok(fs.readFileSync(path.join(logDir, 'debug-other-session.log'), 'utf8').includes('session-b-line'));
	});

	test('getLogPathForSession throws the binary-verbatim error on invalid ids', () => {
		assert.throws(() => server.getLogPathForSession('../evil'), /Expected a valid debug session id/);
		assert.throws(() => server.getLogPathForSession(''), /Expected a valid debug session id/);
		assert.throws(() => server.getLogPathForSession('a b'), /Expected a valid debug session id/);
	});

	test('ensureStarted rejects an invalid session id like the binary', async () => {
		await assert.rejects(server.ensureStarted('../evil'), /Expected a valid debug session id/);
		assert.strictEqual(server.getConfig(), undefined);
	});

	test('untrusted workspace: ensureStarted refuses with the binary-verbatim error', async () => {
		const untrusted = new DebugServerService({ logDir, workspaceTrusted: false });
		try {
			await assert.rejects(untrusted.ensureStarted('x'), /debug mode disabled in untrusted workspace\./);
			assert.strictEqual(untrusted.getConfig(), undefined);
		} finally {
			await untrusted.stop();
			untrusted.dispose();
		}
	});

	test('log dir resolution: <workspace>/.cursor when known, ~/.cursor/debug-logs otherwise', async () => {
		const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dss-ws-'));
		try {
			const wsServer = new DebugServerService({ workspaceFolderPath: wsDir });
			const config = await wsServer.ensureStarted('wsdir-test');
			try {
				assert.strictEqual(
					config.logPath,
					path.join(wsDir, '.cursor', 'debug-wsdir-test.log'),
				);
			} finally {
				await wsServer.stop();
				wsServer.dispose();
			}

			// No workspace folder and no override → ~/.cursor/debug-logs ([BIN]).
			// $HOME is honored by os.homedir() on POSIX, so redirect it to stay hermetic.
			const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dss-home-'));
			const realHome = process.env.HOME;
			process.env.HOME = fakeHome;
			try {
				const homeServer = new DebugServerService();
				const homeConfig = await homeServer.ensureStarted('homedir-test');
				try {
					assert.strictEqual(
						homeConfig.logPath,
						path.join(fakeHome, '.cursor', 'debug-logs', 'debug-homedir-test.log'),
					);
				} finally {
					await homeServer.stop();
					homeServer.dispose();
				}
			} finally {
				process.env.HOME = realHome;
				fs.rmSync(fakeHome, { recursive: true, force: true });
			}
		} finally {
			fs.rmSync(wsDir, { recursive: true, force: true });
		}
	});
});
