/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Desktop bridge CLI client — `ide-code desktop ls|send`.
//
// Ported from Cursor 3.25.6 `out/cli.js` modules `desktop-bridge.ts`
// (shared protocol + validation), `desktopBridgeCliClient.js` (ls/send
// orchestration) and `cliDesktopBridge.js` (usage text + subcommand
// dispatch), verified against the reference binary:
//
//   - protocolVersion = 1, token /^[0-9a-f]{64}$/, thread id UUID regex
//   - discovery: *.json under the bridge dir (env override), 4-way
//     concurrency, pid liveness via process.kill(pid, 0) (EPERM = alive)
//   - transport: HTTP POST / over a unix domain socket,
//     `Authorization: Bearer <token>`, 10s request timeout
//   - `ls` lists at most 200 threads, sorted by lastUpdatedAt desc
//   - dispatch quirk (OBSERVED in Cursor): `desktop` only routes to the
//     bridge when a live desktop instance exists, or under VSCODE_DEV;
//     otherwise the CLI falls through to the normal open path silently.
//
// De-branded for this fork: `ide-code` / `IDE Code` replace `cursor` /
// `Cursor`, and the bridge dir is ~/.ide-code/desktop-bridge (env
// override IDE_CODE_DESKTOP_BRIDGE_DIR), matching the in-app server in
// extensions/ide-agent/src/services/desktopBridgeServer.ts.
//
// Deviation from Cursor's validators (needed for interop with our own
// server): windowId is accepted as a number OR a string, because the
// ide-agent bridge server reports windowId "main" (string), whereas
// Cursor's server always reports an integer window id.

import { request as httpRequest } from 'http';
import { promises as fs } from 'fs';
import { homedir } from 'os';
import { join } from '../../base/common/path.js';
import product from '../../platform/product/common/product.js';

/** desktop-bridge.ts: Vn — the only supported bridge protocol version. */
export const DESKTOP_BRIDGE_PROTOCOL_VERSION = 1;

/** desktop-bridge.ts: wl = 256 * 1024 (declared in the Cursor bundle). */
export const DESKTOP_BRIDGE_MAX_BODY_BYTES = 256 * 1024;

/** desktop-bridge.ts: zn — `ls` surfaces at most this many threads. */
export const DESKTOP_BRIDGE_MAX_THREADS = 200;

const TOKEN_REGEX = /^[0-9a-f]{64}$/;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** desktopBridgeCliClient.js: x1 — discovery / list concurrency. */
const BRIDGE_CONCURRENCY = 4;

/** desktopBridgeCliClient.js: ao = 1e4 — per-request timeout (ms). */
const BRIDGE_REQUEST_TIMEOUT_MS = 1e4;

export interface IDesktopBridgeDiscovery {
	readonly protocolVersion: number;
	readonly pid: number;
	readonly socketPath: string;
	readonly token: string;
	readonly appName: string;
	readonly appVersion: string;
	readonly userDataDir: string;
	readonly createdAt: number;
}

export interface IDesktopBridgeInstance {
	readonly discovery: IDesktopBridgeDiscovery;
	/** `${appName} ${appVersion}` — the "WHERE" column / error prefix. */
	readonly label: string;
}

export type DesktopBridgeThreadSource = 'local' | 'cloud' | 'draft' | 'claude-code';
export type DesktopBridgeThreadStatus = 'idle' | 'running' | 'completed' | 'error' | 'unknown';

export interface IDesktopBridgeThread {
	readonly id: string;
	readonly title: string;
	readonly source: DesktopBridgeThreadSource;
	readonly status: DesktopBridgeThreadStatus;
	readonly lastUpdatedAt: number;
	// Cursor validates windowId as an integer; our ide-agent server sends
	// the string "main" — accept both (see header comment).
	readonly windowId: number | string;
	readonly instance: IDesktopBridgeInstance;
}

export type DesktopBridgeSendResult =
	| { readonly status: 'submitted' | 'queued'; readonly threadId: string; readonly windowId: number | string; readonly threadTitle: string }
	| { readonly status: 'unknown-thread' }
	| { readonly status: 'timeout' }
	| { readonly status: 'not-sendable'; readonly reason: string }
	| { readonly status: 'error'; readonly message: string };

export class UnknownThreadRefError extends Error {
	readonly ref: string;
	constructor(ref: string) {
		super(`Unknown desktop thread ref "${ref}"`);
		this.name = 'UnknownThreadRefError';
		this.ref = ref;
	}
}

export class AmbiguousThreadRefError extends Error {
	readonly ref: string;
	readonly candidates: readonly IDesktopBridgeThread[];
	constructor(ref: string, candidates: readonly IDesktopBridgeThread[]) {
		super(`Desktop thread ref "${ref}" is ambiguous`);
		this.name = 'AmbiguousThreadRefError';
		this.ref = ref;
		this.candidates = [...candidates];
	}
}

// ---------------------------------------------------------------------------
// Output helpers (Ze / hr / ge in the Cursor bundle)
// ---------------------------------------------------------------------------

function writeOut(line: string): void {
	process.stdout.write(`${line}\n`);
}

function writeErr(line: string): void {
	process.stderr.write(`${line}\n`);
}

function reportError(json: boolean, message: string): void {
	if (json) {
		writeOut(JSON.stringify({ status: 'error', message }, null, 2));
	} else {
		writeErr(`error: ${message}`);
	}
	process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// Usage text (cliDesktopBridge.js, module constant N1 — verbatim layout)
// ---------------------------------------------------------------------------

export function buildDesktopBridgeUsage(): string {
	return [
		`Usage: ${product.applicationName} desktop <command>`,
		'',
		`Interact with chat threads in a running ${product.nameShort} desktop app.`,
		'',
		'Commands',
		'  ls                                List threads live in running desktop instances',
		'  send <thread> [text...]           Send a message to a live desktop thread',
		'',
		'Options',
		'  --json                            Machine-readable output',
		'  --force                           (send) Submit immediately, interrupting a running turn',
		'  --stdin                           (send) Read message text from stdin',
		'  -h --help                         Print usage',
		'',
		`<thread> is a thread id from \`${product.applicationName} desktop ls\`, or a unique prefix of one.`
	].join('\n');
}

// ---------------------------------------------------------------------------
// Discovery (desktopBridgeCliClient.js: R1 / gl / ml / $l)
// ---------------------------------------------------------------------------

export function resolveDesktopBridgeDir(env: NodeJS.ProcessEnv = process.env): string {
	const override = env['IDE_CODE_DESKTOP_BRIDGE_DIR'];
	if (override !== undefined) {
		return override;
	}
	const home = homedir().replace(/[\\/]+$/, '');
	return join(home, '.ide-code', 'desktop-bridge');
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0;
}

/** Discovery record validation (gl in the Cursor bundle). */
export function validateDiscoveryRecord(value: unknown): IDesktopBridgeDiscovery | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const { protocolVersion, pid, socketPath, token, appName, appVersion, userDataDir, createdAt } = value;
	if (typeof protocolVersion !== 'number' || !Number.isInteger(protocolVersion)) {
		return undefined;
	}
	if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
		return undefined;
	}
	if (!isNonEmptyString(socketPath)) {
		return undefined;
	}
	if (typeof token !== 'string' || !TOKEN_REGEX.test(token)) {
		return undefined;
	}
	if (!isNonEmptyString(appName) || !isNonEmptyString(appVersion) || !isNonEmptyString(userDataDir)) {
		return undefined;
	}
	if (typeof createdAt !== 'number' || !Number.isFinite(createdAt) || createdAt < 0) {
		return undefined;
	}
	return { protocolVersion, pid, socketPath, token, appName, appVersion, userDataDir, createdAt };
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === 'EPERM';
	}
}

/** Bounded-concurrency map (so in the Cursor bundle). */
async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let index = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (index < items.length) {
			const current = index++;
			results[current] = await fn(items[current]);
		}
	});
	await Promise.all(workers);
	return results;
}

/** Instance discovery: read + validate *.json in the bridge dir (R1). */
export async function discoverDesktopInstances(bridgeDir: string = resolveDesktopBridgeDir()): Promise<IDesktopBridgeInstance[]> {
	let entries;
	try {
		entries = await fs.readdir(bridgeDir, { withFileTypes: true });
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			return [];
		}
		throw err;
	}
	const files = entries.filter(entry => entry.isFile() && entry.name.endsWith('.json'));
	const instances = await mapWithConcurrency(files, BRIDGE_CONCURRENCY, async (entry) => {
		try {
			const parsed: unknown = JSON.parse(await fs.readFile(join(bridgeDir, entry.name), 'utf8'));
			const discovery = validateDiscoveryRecord(parsed);
			if (!discovery || discovery.protocolVersion !== DESKTOP_BRIDGE_PROTOCOL_VERSION || !isPidAlive(discovery.pid)) {
				return undefined;
			}
			return { discovery, label: `${discovery.appName} ${discovery.appVersion}` };
		} catch {
			return undefined;
		}
	});
	return instances.filter((instance): instance is IDesktopBridgeInstance => instance !== undefined);
}

/** Ul: does any live desktop instance exist? */
export async function hasLiveDesktopInstance(bridgeDir?: string): Promise<boolean> {
	try {
		return (await discoverDesktopInstances(bridgeDir)).length > 0;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Transport (desktopBridgeCliClient.js: no / io)
// ---------------------------------------------------------------------------

interface IBridgeResponse {
	readonly statusCode: number;
	readonly body: unknown;
}

function bridgeHttpError(instance: IDesktopBridgeInstance, response: IBridgeResponse): Error {
	const detail = isRecord(response.body) && typeof response.body.error === 'string' ? `: ${response.body.error}` : '';
	return new Error(`${instance.label} desktop bridge returned HTTP ${response.statusCode}${detail}`);
}

/** HTTP POST / over the instance's unix domain socket (no). */
export function bridgeRequest(instance: IDesktopBridgeInstance, payload: unknown): Promise<IBridgeResponse> {
	const data = JSON.stringify(payload);
	return new Promise((resolve, reject) => {
		const req = httpRequest({
			socketPath: instance.discovery.socketPath,
			path: '/',
			method: 'POST',
			headers: {
				authorization: `Bearer ${instance.discovery.token}`,
				'content-type': 'application/json',
				'content-length': Buffer.byteLength(data),
			},
		}, res => {
			const chunks: Buffer[] = [];
			res.on('data', (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
			res.on('error', reject);
			res.on('end', () => {
				let body: unknown;
				try {
					body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
				} catch {
					reject(new Error(`${instance.label} desktop bridge returned invalid JSON`));
					return;
				}
				resolve({ statusCode: res.statusCode ?? 500, body });
			});
		});
		req.setTimeout(BRIDGE_REQUEST_TIMEOUT_MS, () => {
			req.destroy(new Error(`${instance.label} desktop bridge request timed out`));
		});
		req.on('error', reject);
		req.end(data);
	});
}

// ---------------------------------------------------------------------------
// Response validation (desktop-bridge.ts: vl / jl / Wl)
// ---------------------------------------------------------------------------

function isThreadSource(value: unknown): value is DesktopBridgeThreadSource {
	return value === 'local' || value === 'cloud' || value === 'draft' || value === 'claude-code';
}

function isThreadStatus(value: unknown): value is DesktopBridgeThreadStatus {
	return value === 'idle' || value === 'running' || value === 'completed' || value === 'error' || value === 'unknown';
}

/** Single-thread validation (vl). windowId: see the header deviation note. */
export function validateThread(value: unknown): Omit<IDesktopBridgeThread, 'instance'> | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const { id, title, source, status, lastUpdatedAt, windowId } = value;
	if (!isNonEmptyString(id) || typeof title !== 'string' || !isThreadSource(source) || !isThreadStatus(status)) {
		return undefined;
	}
	if (typeof lastUpdatedAt !== 'number' || !Number.isFinite(lastUpdatedAt)) {
		return undefined;
	}
	if (typeof windowId !== 'number' && typeof windowId !== 'string') {
		return undefined;
	}
	return { id, title, source, status, lastUpdatedAt, windowId };
}

/** listThreads response validation (jl): any invalid thread voids the list. */
export function validateThreadsResponse(value: unknown): { readonly threads: Omit<IDesktopBridgeThread, 'instance'>[] } | undefined {
	if (!isRecord(value) || !Array.isArray(value.threads)) {
		return undefined;
	}
	const threads: Omit<IDesktopBridgeThread, 'instance'>[] = [];
	for (const entry of value.threads) {
		const thread = validateThread(entry);
		if (!thread) {
			return undefined;
		}
		threads.push(thread);
	}
	return { threads };
}

/** sendMessage response validation (Wl). windowId: see deviation note. */
export function validateSendResult(value: unknown): DesktopBridgeSendResult | undefined {
	if (!isRecord(value) || typeof value.status !== 'string') {
		return undefined;
	}
	switch (value.status) {
		case 'submitted':
		case 'queued': {
			const { threadId, windowId, threadTitle } = value;
			if (!isNonEmptyString(threadId) || typeof threadTitle !== 'string') {
				return undefined;
			}
			if (typeof windowId !== 'number' && typeof windowId !== 'string') {
				return undefined;
			}
			return { status: value.status, threadId, windowId, threadTitle };
		}
		case 'unknown-thread':
			return { status: 'unknown-thread' };
		case 'timeout':
			return { status: 'timeout' };
		case 'not-sendable':
			return typeof value.reason === 'string' ? { status: 'not-sendable', reason: value.reason } : undefined;
		case 'error':
			return typeof value.message === 'string' ? { status: 'error', message: value.message } : undefined;
		default:
			return undefined;
	}
}

// ---------------------------------------------------------------------------
// ls / send orchestration (desktopBridgeCliClient.js: Bl / oo / Gl / Hl / Kl)
// ---------------------------------------------------------------------------

/** listThreads against one instance (Bl). */
export async function listInstanceThreads(instance: IDesktopBridgeInstance): Promise<IDesktopBridgeThread[]> {
	const response = await bridgeRequest(instance, { type: 'listThreads' });
	if (response.statusCode !== 200) {
		throw bridgeHttpError(instance, response);
	}
	const parsed = validateThreadsResponse(response.body);
	if (!parsed) {
		throw new Error(`${instance.label} desktop bridge returned invalid threads`);
	}
	return parsed.threads.map(thread => ({ ...thread, instance }));
}

/** List threads across all instances, newest first, capped (oo). */
export async function listAllThreads(instances: readonly IDesktopBridgeInstance[]): Promise<IDesktopBridgeThread[]> {
	const outcomes = await mapWithConcurrency(instances, BRIDGE_CONCURRENCY, async (instance) => {
		try {
			return { ok: true as const, threads: await listInstanceThreads(instance) };
		} catch {
			return { ok: false as const, label: instance.label };
		}
	});
	const failedLabels = outcomes.flatMap(outcome => outcome.ok ? [] : [outcome.label]);
	if (instances.length > 0 && failedLabels.length === instances.length) {
		throw new Error(`all desktop instances failed to list threads: ${failedLabels.join(', ')}`);
	}
	return outcomes
		.flatMap(outcome => outcome.ok ? outcome.threads : [])
		.sort((a, b) => b.lastUpdatedAt - a.lastUpdatedAt)
		.slice(0, DESKTOP_BRIDGE_MAX_THREADS);
}

function isUuidLikeRef(trimmed: string): boolean {
	return UUID_REGEX.test(trimmed) || trimmed.length >= 36;
}

/** Vl: trim; UUID-shaped refs are lowercased for matching. */
export function normalizeThreadRef(ref: string): string {
	const trimmed = ref.trim();
	return isUuidLikeRef(trimmed) ? trimmed.toLowerCase() : trimmed;
}

function mostRecentlyUpdated(threads: readonly IDesktopBridgeThread[]): IDesktopBridgeThread {
	return threads.reduce((best, thread) => thread.lastUpdatedAt > best.lastUpdatedAt ? thread : best);
}

/**
 * Resolve a user thread ref (Gl): exact id match (most recently updated
 * wins), else unique prefix match, else — for a UUID-shaped ref — a
 * pseudo-thread per instance so `send` can target an id absent from `ls`.
 */
export async function resolveThreadRef(
	instances: readonly IDesktopBridgeInstance[],
	ref: string,
	listFn: (instances: readonly IDesktopBridgeInstance[]) => Promise<IDesktopBridgeThread[]> = listAllThreads,
): Promise<IDesktopBridgeThread[]> {
	const normalized = normalizeThreadRef(ref);
	if (normalized.length === 0) {
		throw new UnknownThreadRefError(normalized);
	}
	const threads = await listFn(instances);
	const exact = threads.filter(thread => thread.id === normalized);
	if (exact.length >= 1) {
		return [mostRecentlyUpdated(exact)];
	}
	const prefixed = threads.filter(thread => thread.id.startsWith(normalized));
	if (prefixed.length === 1) {
		return [prefixed[0]];
	}
	if (prefixed.length > 1) {
		throw new AmbiguousThreadRefError(normalized, prefixed);
	}
	if (isUuidLikeRef(normalized)) {
		return instances.map(instance => ({
			id: normalized,
			title: normalized,
			source: 'local' as const,
			status: 'idle' as const,
			lastUpdatedAt: 0,
			windowId: 0,
			instance,
		}));
	}
	throw new UnknownThreadRefError(ref);
}

/** sendMessage against one thread's instance (Hl). */
export async function sendToThread(
	thread: IDesktopBridgeThread,
	text: string,
	options: { readonly force: boolean },
	requestFn: (instance: IDesktopBridgeInstance, payload: unknown) => Promise<IBridgeResponse> = bridgeRequest,
): Promise<DesktopBridgeSendResult> {
	const response = await requestFn(thread.instance, { type: 'sendMessage', threadId: thread.id, text, force: options.force });
	const result = validateSendResult(response.body);
	if (response.statusCode !== 200) {
		if (result?.status === 'error') {
			return result;
		}
		throw bridgeHttpError(thread.instance, response);
	}
	if (!result) {
		throw new Error(`${thread.instance.label} desktop bridge returned an invalid send result`);
	}
	return result;
}

/**
 * Try candidates in order (Kl): a submitted/queued/timeout result wins
 * immediately; otherwise the most severe outcome is kept
 * (not-sendable/error > unknown-thread > other).
 */
export async function sendToFirstAvailable(
	candidates: readonly IDesktopBridgeThread[],
	text: string,
	options: { readonly force: boolean },
	sendFn: (thread: IDesktopBridgeThread, text: string, options: { readonly force: boolean }) => Promise<DesktopBridgeSendResult> = sendToThread,
): Promise<{ readonly thread: IDesktopBridgeThread; readonly response: DesktopBridgeSendResult }> {
	if (candidates.length === 0) {
		throw new Error('Failed to send to any desktop instance');
	}
	const severity = (result: DesktopBridgeSendResult): number => {
		switch (result.status) {
			case 'submitted':
			case 'queued':
			case 'timeout':
				return 4;
			case 'not-sendable':
			case 'error':
				return 3;
			case 'unknown-thread':
				return 1;
			default:
				return 0;
		}
	};
	let thread = candidates[0];
	let best: DesktopBridgeSendResult | undefined;
	let lastError: unknown;
	for (const candidate of candidates) {
		try {
			const result = await sendFn(candidate, text, { force: options.force });
			thread = candidate;
			if (result.status === 'submitted' || result.status === 'queued' || result.status === 'timeout') {
				best = result;
				break;
			}
			if (!best || severity(result) >= severity(best)) {
				best = result;
			}
			if (result.status === 'not-sendable' || result.status === 'error' || candidates.length === 1) {
				break;
			}
		} catch (err) {
			lastError = err;
			best = undefined;
			if (candidates.length === 1) {
				throw err;
			}
		}
	}
	if (!best) {
		throw lastError ?? new Error('Failed to send to any desktop instance');
	}
	return { thread, response: best };
}

// ---------------------------------------------------------------------------
// Presentation (cliDesktopBridge.js: Xl / Yl / Ql / Zl / lo / e0, t0 / s0)
// ---------------------------------------------------------------------------

const ANSI_ESCAPE_REGEX = /\x1B(?:\][^\u0007\x1B]*(?:\u0007|\x1B\\)|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/g;
const CONTROL_CHARS_REGEX = /[\x00-\x1F\x7F-\x9F]/g;

/** Strip ANSI escapes + control characters from a title (Ql). */
export function stripAnsiAndControls(text: string): string {
	return text.replace(ANSI_ESCAPE_REGEX, '').replace(CONTROL_CHARS_REGEX, '');
}

/** Two-space separated, column-aligned table (Yl). */
export function formatTable(header: readonly string[], rows: readonly (readonly string[])[]): string {
	const widths = header.map((heading, column) => {
		let width = heading.length;
		for (const row of rows) {
			width = Math.max(width, (row[column] ?? '').length);
		}
		return width;
	});
	const pad = (value: string, width: number) => `${value}${' '.repeat(Math.max(0, width - value.length))}`;
	const renderRow = (row: readonly string[]) => row.map((value, column) => pad(value, widths[column])).join('  ').trimEnd();
	return [renderRow(header), ...rows.map(renderRow)].join('\n');
}

/** The `ls` table (Xl). */
export function formatThreadTable(threads: readonly IDesktopBridgeThread[]): string {
	return formatTable(
		['THREAD ID', 'TITLE', 'SOURCE', 'STATUS', 'WHERE'],
		threads.map(thread => [
			thread.id,
			stripAnsiAndControls(thread.title || '(untitled)'),
			thread.source,
			thread.status,
			thread.instance.label,
		]),
	);
}

/** JSON shape of a thread for `--json` output (Zl). */
export function threadToJson(thread: IDesktopBridgeThread) {
	const { instance, ...rest } = thread;
	return {
		...rest,
		instance: {
			label: instance.label,
			appName: instance.discovery.appName,
			appVersion: instance.discovery.appVersion,
			userDataDir: instance.discovery.userDataDir,
		},
	};
}

/** Human error message for a bridge failure (lo). */
export function formatBridgeError(err: unknown): string {
	if (err instanceof UnknownThreadRefError) {
		return `thread ref ${JSON.stringify(err.ref)} was not found`;
	}
	if (err instanceof AmbiguousThreadRefError) {
		const candidates = err.candidates.map(thread => `${thread.id} ${JSON.stringify(thread.title)}`).join(', ');
		return `thread ref ${JSON.stringify(err.ref)} is ambiguous: ${candidates}`;
	}
	return err instanceof Error ? err.message : String(err);
}

/** Print a send result the way Cursor does (e0). */
function printSendResult(thread: IDesktopBridgeThread, result: DesktopBridgeSendResult, force: boolean): void {
	switch (result.status) {
		case 'submitted': {
			const suffix = force && thread.status === 'running' ? ' (interrupted running turn)' : '';
			writeOut(`Submitted to ${JSON.stringify(result.threadTitle)} (${result.threadId})${suffix}`);
			return;
		}
		case 'queued':
			writeOut(`Queued in ${JSON.stringify(result.threadTitle)} (agent is running; will submit when the current turn ends)`);
			return;
		case 'unknown-thread':
			reportError(false, `thread ${JSON.stringify(thread.id)} is no longer available`);
			return;
		case 'timeout':
			reportError(false, 'desktop did not confirm the message before timeout; it may have been submitted');
			return;
		case 'not-sendable':
			reportError(false, `thread ${JSON.stringify(thread.title)} is not sendable: ${result.reason}`);
			return;
		case 'error':
			reportError(false, result.message);
			return;
		default:
			throw new Error(`Unhandled desktop send result: ${String((result as { status: string }).status)}`);
	}
}

async function readStdinText(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return Buffer.concat(chunks).toString('utf8');
}

async function runListCommand(options: { readonly json: boolean }): Promise<void> {
	try {
		const instances = await discoverDesktopInstances();
		if (instances.length === 0) {
			reportError(options.json, `no running ${product.nameShort} desktop instance found (is the app open?)`);
			return;
		}
		const threads = await listAllThreads(instances);
		if (options.json) {
			writeOut(JSON.stringify(threads.map(threadToJson), null, 2));
			return;
		}
		const summary = `${threads.length} thread${threads.length === 1 ? '' : 's'} across ${instances.length} running ${product.nameShort} instance${instances.length === 1 ? '' : 's'}`;
		writeOut(`${formatThreadTable(threads)}\n${summary}`);
	} catch (err) {
		reportError(options.json, formatBridgeError(err));
	}
}

async function runSendCommand(ref: string, textParts: readonly string[], options: { readonly force: boolean; readonly stdin: boolean; readonly json: boolean }): Promise<void> {
	try {
		const text = options.stdin ? await readStdinText() : textParts.join(' ');
		if (text.length === 0) {
			reportError(options.json, 'message text is empty (provide text or use --stdin)');
			return;
		}
		const instances = await discoverDesktopInstances();
		if (instances.length === 0) {
			reportError(options.json, `no running ${product.nameShort} desktop instance found (is the app open?)`);
			return;
		}
		const candidates = await resolveThreadRef(instances, ref);
		const { thread, response } = await sendToFirstAvailable(candidates, text, { force: options.force });
		if (options.json) {
			writeOut(JSON.stringify(response, null, 2));
			if (response.status !== 'submitted' && response.status !== 'queued') {
				process.exitCode = 1;
			}
			return;
		}
		printSendResult(thread, response, options.force);
	} catch (err) {
		reportError(options.json, formatBridgeError(err));
	}
}

// ---------------------------------------------------------------------------
// Subcommand routing (cli.js: L1 / fl / i0 / dl, cliDesktopBridge.js: n0)
// ---------------------------------------------------------------------------

/**
 * The CLI argv tail (L1): raw argv minus node + script. Under VSCODE_DEV
 * the first non-option argument is the app location and is stripped
 * (mirrors argvHelper.stripAppPath).
 */
export function cliArgvTail(argv: readonly string[], isDev: boolean = !!process.env['VSCODE_DEV']): string[] {
	let tail = argv.slice(2);
	if (isDev) {
		const index = tail.findIndex(arg => !/^-/.test(arg));
		if (index > -1) {
			tail = [...tail.slice(0, index), ...tail.slice(index + 1)];
		}
	}
	return tail;
}

/** fl: is the first non-option argument the `desktop` subcommand? */
export function isDesktopSubcommand(argv: readonly string[], isDev?: boolean): boolean {
	return cliArgvTail(argv, isDev).find(arg => arg.length > 0 && arg[0] !== '-') === 'desktop';
}

/**
 * i0 gate (OBSERVED quirk): the bridge only handles `desktop` when a live
 * desktop instance exists, or in a dev build (VSCODE_DEV). Otherwise the
 * CLI silently falls through to the normal open path.
 */
export async function shouldRouteToDesktopBridge(argv: readonly string[]): Promise<boolean> {
	if (!isDesktopSubcommand(argv)) {
		return false;
	}
	if (process.env['VSCODE_DEV']) {
		return true;
	}
	return hasLiveDesktopInstance();
}

export interface IParsedDesktopArgs {
	readonly command: string | undefined;
	readonly rest: readonly string[];
	readonly json: boolean;
	readonly force: boolean;
	readonly stdin: boolean;
	readonly help: boolean;
}

/**
 * Parse the tokens after `desktop` (T1 schema: json/force/stdin/booleans,
 * help aliased -h, positionals in _). Unknown options are ignored,
 * matching Cursor's onUnknownOption no-op for this subcommand.
 */
export function parseDesktopArgs(tokens: readonly string[]): IParsedDesktopArgs {
	let json = false;
	let force = false;
	let stdin = false;
	let help = false;
	const positionals: string[] = [];
	let endOfOptions = false;
	for (const token of tokens) {
		if (!endOfOptions && token === '--') {
			endOfOptions = true;
			continue;
		}
		if (!endOfOptions && token.length > 1 && token[0] === '-') {
			switch (token) {
				case '--json': json = true; break;
				case '--force': force = true; break;
				case '--stdin': stdin = true; break;
				case '--help':
				case '-h': help = true; break;
				default: break; // ignored
			}
			continue;
		}
		positionals.push(token);
	}
	const [command, ...rest] = positionals;
	return { command, rest, json, force, stdin, help };
}

/** Subcommand entry point (n0). Caller: cli.ts main(). */
export async function runDesktopSubcommand(argv: readonly string[]): Promise<void> {
	const tail = cliArgvTail(argv);
	const desktopIndex = tail.indexOf('desktop');
	const args = parseDesktopArgs(desktopIndex >= 0 ? tail.slice(desktopIndex + 1) : tail);
	const usage = buildDesktopBridgeUsage();

	if (args.help || args.command === undefined) {
		writeOut(usage);
		if (args.command === undefined && !args.help) {
			process.exitCode = 1;
		}
		return;
	}

	switch (args.command) {
		case 'ls':
			await runListCommand({ json: args.json });
			return;
		case 'send': {
			const [ref, ...textParts] = args.rest;
			if (ref === undefined) {
				reportError(args.json, `missing required argument 'thread' (a thread id from \`${product.applicationName} desktop ls\`, or a unique prefix of one)`);
				return;
			}
			await runSendCommand(ref, textParts, { force: args.force, stdin: args.stdin, json: args.json });
			return;
		}
		default:
			if (args.json) {
				reportError(true, `unknown desktop command '${args.command}'`);
				return;
			}
			writeErr(`error: unknown desktop command '${args.command}'`);
			writeErr('');
			writeErr(usage);
			process.exitCode = 1;
	}
}
