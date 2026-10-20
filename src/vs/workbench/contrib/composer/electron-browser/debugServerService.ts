// IDE-CODE: Migrated from extensions/ide-agent/src/services/debugServerService.ts (CAT-B).
// Request handling re-verified verbatim against Cursor 3.25.9
// `extensions/cursor-ndjson-ingest/dist/main.js` module 93 (class
// `NdjsonIngestServer`): the POST body is OPAQUE BYTES (appendExclusive
// stream pipeline, only a trailing newline is ensured — NO JSON schema
// validation); the only validated input is the `X-Debug-Session-Id`
// header against `/^[a-zA-Z0-9-]+$/`; routes are OPTIONS → 200,
// POST /ingest/{targetId} → 204, missing/invalid session header → 400,
// anything else → 404; log file `{logDir}/debug-{sessionId}.log` with
// logDir = `<workspace>/.cursor` or `~/.cursor/debug-logs`; the server
// refuses untrusted workspaces ("debug mode disabled in untrusted
// workspace.").
//
// vscode API → core mapping used here:
//   vscode.Disposable                    → Disposable (vs/base/common/lifecycle)
//   vscode.OutputChannel (interface)      → minimal IDebugOutputChannel (appendLine + dispose)
//   vscode.window.createOutputChannel    → optional ctor-injected factory; skipped when absent
//                                          (log file + onLine listeners still carry the lines)
//   vscode.workspace.getConfiguration   → ctor-injected opts.ndjsonPort
//                                          ("ide.debug.ndjsonPort")
//   vscode.workspace.isTrusted           → ctor-injected opts.workspaceTrusted
//   vscode.workspace.workspaceFolders   → ctor-injected opts.workspaceFolderPath

import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { IDisposable } from "../../../../base/common/lifecycle.js";
import { DebugModeConfig } from "../common/modeService.js";

/**
 * Minimal output-channel surface the debug server needs.
 * The wiring site may inject a factory that adapts the core output channel;
 * when omitted, lines go to the log file + line listeners only.
 */
export interface IDebugOutputChannel {
	appendLine(value: string): void;
	dispose(): void;
}

export interface DebugServerOptions {
	/**
	 * Explicit log directory override (tests). When omitted the binary's
	 * resolution applies ([BIN] module 593): `<workspace>/.cursor` when
	 * `workspaceFolderPath` is set, else `~/.cursor/debug-logs`.
	 */
	logDir?: string;
	/**
	 * fsPath of the first workspace folder; `<workspace>/.cursor` becomes
	 * the log directory ([BIN] module 593).
	 */
	workspaceFolderPath?: string;
	/**
	 * Workspace trust state. `false` refuses to start with the binary's
	 * verbatim error ([BIN] module 593: "debug mode disabled in untrusted
	 * workspace."). `undefined` means trust is unknown to this DI-free
	 * service — start proceeds; the wiring site should pass the real state.
	 */
	workspaceTrusted?: boolean;
	/** `ide.debug.ndjsonPort` — 0/undefined = auto-allocate in PORT_MIN..PORT_MAX. */
	ndjsonPort?: number;
	/** Optional factory for the "IDE Agent — Debug Logs" output channel. */
	createOutputChannel?: (name: string) => IDebugOutputChannel;
}

export interface ChooseNdjsonPortOptions {
	/**
	 * Pinned port (Cursor's `ndjson.port` / our `ide.debug.ndjsonPort`).
	 * Returned as-is when non-zero — Cursor's `chooseNdjsonPort` does no
	 * probing for a pinned port.
	 */
	configuredPort?: number;
	/** Previously allocated port to reuse when still free (sticky identity). */
	previouslyAllocatedPort?: number;
	/** Ports that must not be picked (e.g. the port being reassigned away from). */
	excludedPorts?: number[];
	bindAddress?: string;
	rangeStart?: number;
	rangeEnd?: number;
}

/** Probe whether a TCP port is free on the given bind address. */
export function isPortFreeOn(port: number, bindAddress = "127.0.0.1"): Promise<boolean> {
	return new Promise((resolve) => {
		const probe = http.createServer();
		probe.once("error", () => resolve(false));
		probe.listen(port, bindAddress, () => probe.close(() => resolve(true)));
	});
}

/**
 * Binary-verbatim port of Cursor's `chooseNdjsonPort` (module 93 of
 * extensions/cursor-ndjson-ingest/dist/main.js, [BIN]):
 * pinned port → returned as-is; else reuse `previouslyAllocatedPort` when it
 * is still free; else a random-offset scan of [rangeStart..rangeEnd]
 * skipping `excludedPorts`. Default range is Cursor's 7242–7942.
 */
export async function chooseNdjsonPort(opts: ChooseNdjsonPortOptions = {}): Promise<number> {
	const configured = opts.configuredPort ?? 0;
	if (configured !== 0) {
		return configured;
	}
	const bindAddress = opts.bindAddress ?? "127.0.0.1";
	const excluded = new Set((opts.excludedPorts ?? []).filter((p) => p > 0));
	const previous = opts.previouslyAllocatedPort ?? 0;
	if (previous !== 0 && !excluded.has(previous) && (await isPortFreeOn(previous, bindAddress))) {
		return previous;
	}
	const rangeStart = opts.rangeStart ?? DebugServerService.PORT_MIN;
	const rangeEnd = opts.rangeEnd ?? DebugServerService.PORT_MAX;
	if (rangeStart > rangeEnd) {
		throw new Error(`Invalid port range ${rangeStart}-${rangeEnd}`);
	}
	const size = rangeEnd - rangeStart + 1;
	const offset = Math.floor(Math.random() * size);
	for (let i = 0; i < size; i++) {
		const port = rangeStart + ((offset + i) % size);
		if (!excluded.has(port) && (await isPortFreeOn(port, bindAddress))) {
			return port;
		}
	}
	throw new Error(`No available ports in range ${rangeStart}-${rangeEnd}`);
}

/**
 * DebugServerService — localhost NDJSON ingest server for Debug mode.
 * (Behavioral port of the extension version; doc comment preserved.)
 *
 * A localhost HTTP server (127.0.0.1 only) that ingests NDJSON log lines
 * the debug agent's instrumentation POSTs while the user reproduces the
 * bug. Per debug session: one unguessable target id, one NDJSON log file
 * (`{logDir}/debug-{sessionId}.log`), and a bounded in-memory ring buffer
 * of recent lines (a stepping stone toward the "Debug Logs" chat block).
 *
 * Binary-verbatim request handling (module 93 `handleRequest`):
 * CORS headers on every response → OPTIONS 200 →
 * POST /ingest/<targetId> (exact raw-URL match) → 204 with the body as
 * OPAQUE BYTES (no JSON validation) → missing/invalid X-Debug-Session-Id
 * header → 400 → anything else → 404.
 *
 * Port: `ide.debug.ndjsonPort` (0 = auto-allocate in range 7242–7942).
 */
export class DebugServerService implements IDisposable {
	/** Cursor's verbatim auto-allocate range ([BIN] ndjson-ingest). */
	static readonly PORT_MIN = 7242;
	static readonly PORT_MAX = 7942;
	/** Ring-buffer cap for recent lines (UI stepping stone). */
	static readonly MAX_RECENT_LINES = 500;
	/**
	 * Cap for the in-memory copy of a request body kept for the recent-lines
	 * UI feed. The log file write itself streams uncapped, like the binary
	 * (the binary imposes no body size limit).
	 */
	static readonly MAX_LINE_CAPTURE_BYTES = 1024 * 1024;
	/**
	 * [BIN] module 93 verbatim (`const u=/^[a-zA-Z0-9-]+$/`): the only
	 * validated input of the ingest server is the `X-Debug-Session-Id`
	 * header.
	 */
	static readonly SESSION_ID_PATTERN = /^[a-zA-Z0-9-]+$/;

	private server: http.Server | undefined;
	private port = 0;
	private targetId = "";
	private sessionId = "";
	private logDir = "";
	private logPath = "";
	/** Serializes appendExclusive calls ([BIN] module 93: `writeQueue`). */
	private writeQueue: Promise<void> = Promise.resolve();
	private readonly recentLines: string[] = [];
	private readonly lineListeners = new Set<(line: string) => void>();
	private output: IDebugOutputChannel | undefined;

	constructor(private readonly opts: DebugServerOptions = {}) {}

	/**
	 * [BIN] module 93 verbatim (`function p(e){if(e&&u.test(e))return e}`).
	 */
	private static validateSessionId(value: string): string | undefined {
		return value && DebugServerService.SESSION_ID_PATTERN.test(value) ? value : undefined;
	}

	/**
	 * [BIN] module 93 verbatim: throws "Expected a valid debug session id"
	 * for anything failing the pattern, otherwise
	 * `{logDir}/debug-{sessionId}.log`. Because the session id is
	 * pattern-validated first, no filename sanitization is needed (the
	 * binary does none either).
	 */
	getLogPathForSession(sessionId: string): string {
		const valid = DebugServerService.validateSessionId(sessionId);
		if (!valid) {
			throw new Error("Expected a valid debug session id");
		}
		return path.join(this.logDir, `debug-${valid}.log`);
	}

	/**
	 * Start (or reuse) the ingest server for a debug session. Idempotent per
	 * session id: calling again with the same id returns the current config
	 * without restarting. A different session id restarts with a fresh
	 * target id; the log file is per session id (`debug-{sessionId}.log`),
	 * so a new session naturally starts with a fresh file.
	 *
	 * Refuses to start when `opts.workspaceTrusted === false`
	 * ([BIN] module 593: "debug mode disabled in untrusted workspace.").
	 */
	async ensureStarted(sessionId: string): Promise<DebugModeConfig> {
		if (this.opts.workspaceTrusted === false) {
			throw new Error("debug mode disabled in untrusted workspace.");
		}
		if (this.server && this.sessionId === sessionId) {
			const existing = this.getConfig();
			if (existing) return existing;
		}
		await this.stop();
		this.sessionId = sessionId;
		this.targetId = randomUUID();
		this.logDir = this.resolveLogDir();
		await fsp.mkdir(this.logDir, { recursive: true });
		// No truncation: the binary appends (flags: "a"); a new session id
		// already yields a fresh file via getLogPathForSession (which throws
		// for an invalid session id, [BIN]).
		this.logPath = this.getLogPathForSession(sessionId);

		const port = await this.pickPort();
		await this.listenOn(port);
		return this.buildConfig();
	}

	/**
	 * Manual start — the `cursor.ndjsonIngest.start` analog ([BIN] module
	 * 593 `$()` @6484). Semantics mirrored from the binary:
	 *   - already running with the same (or no) session id → return the
	 *     current config WITHOUT restarting and without any UI message
	 *     (the binary returns `{externalUrl, logPath}` for the running
	 *     server when the log directory and surface still match);
	 *   - already running with a different session id → restart via
	 *     `ensureStarted` (the binary restarts when the sticky identity
	 *     changes; a new session id is this fork's identity change);
	 *   - not running → start. With no session id, a manual session is
	 *     minted (`debug-manual-<uuid>` — the same precedent as
	 *     `reassignPort()` below; the binary instead keeps a sticky
	 *     workspaceState ingest-path id and a per-request session header,
	 *     returning `logPath: ""` when no session id is given — this fork's
	 *     config is session-bound, so a concrete manual session is the
	 *     documented divergence).
	 * After a `stop()`, the preserved session id is reused (stop keeps the
	 * identity, like the binary's `D()` keeping the workspaceState id).
	 * Untrusted workspaces refuse via `ensureStarted`'s verbatim error.
	 */
	async start(sessionId?: string): Promise<DebugModeConfig> {
		if (this.server) {
			if (sessionId && sessionId !== this.sessionId) {
				return this.ensureStarted(sessionId);
			}
			const existing = this.getConfig();
			if (existing) {
				return existing;
			}
		}
		const effectiveSessionId = sessionId ?? (this.sessionId || `debug-manual-${randomUUID()}`);
		return this.ensureStarted(effectiveSessionId);
	}

	/**
	 * The ingest URL Cursor's commands copy/show (the binary's `h` variable:
	 * external URL via `asExternalUri`, falling back to the loopback URL).
	 * Core has no `vscode.env.asExternalUri`; the loopback URL is the truthful
	 * value here.
	 */
	getServerUrl(): string | undefined {
		if (!this.server || !this.port || !this.targetId) {
			return undefined;
		}
		return `http://127.0.0.1:${this.port}/ingest/${this.targetId}`;
	}

	/** Bound port, 0 when stopped (analog of the binary's `I(h || p.getLoopbackUrl())`). */
	getPort(): number {
		return this.server ? this.port : 0;
	}

	/** Current config for the running server, or undefined when stopped. */
	getConfig(): DebugModeConfig | undefined {
		if (!this.server || !this.port) return undefined;
		return this.buildConfig();
	}
	private buildConfig(): DebugModeConfig {
		return {
			logPath: this.logPath,
			serverEndpoint: `http://127.0.0.1:${this.port}/ingest/${this.targetId}`,
			sessionId: this.sessionId,
		};
	}

	/** Most recent ingested lines (oldest first), up to `limit`. */
	getRecentLines(limit = 100): string[] {
		return this.recentLines.slice(-Math.max(0, limit));
	}

	/** Subscribe to ingested lines (UI stepping stone). */
	onLine(listener: (line: string) => void): IDisposable {
		this.lineListeners.add(listener);
		return { dispose: () => this.lineListeners.delete(listener) };
	}

	/**
	 * Cursor `cursor.ndjsonIngest.reassignPort` analog (binary offset 3641):
	 * stop the listener and restart on a fresh auto-allocated port — the old
	 * port is excluded from allocation (the binary's `excludedPorts: [n]`) —
	 * keeping the same target id / session / log file. The binary keeps the
	 * ingest path id in workspaceState across reassign; the log file is NOT
	 * truncated (the binary appends across reassign). Starts the server when
	 * it wasn't running (the binary's `$` starts even when `p` is unset).
	 */
	async reassignPort(): Promise<{ oldPort: number; newPort: number }> {
		const oldPort = this.getPort();
		const newPort = await chooseNdjsonPort({
			excludedPorts: oldPort > 0 ? [oldPort] : [],
			bindAddress: "127.0.0.1",
			rangeStart: DebugServerService.PORT_MIN,
			rangeEnd: DebugServerService.PORT_MAX,
		});
		if (!this.targetId) {
			// Never started: mint a sticky identity (the binary mints the path id
			// into workspaceState on first start).
			this.sessionId = `debug-manual-${randomUUID()}`;
			this.targetId = randomUUID();
			this.logDir = this.resolveLogDir();
			await fsp.mkdir(this.logDir, { recursive: true });
			this.logPath = this.getLogPathForSession(this.sessionId);
		}
		await this.stopListening();
		await this.listenOn(newPort);
		return { oldPort, newPort };
	}

	/**
	 * Stop the server. Safe to call when not started. Identity
	 * (sessionId/targetId/logPath) is intentionally preserved — the binary's
	 * `D()` likewise keeps the ingest path id (workspaceState) across
	 * stop/reassign and only clears the server handle + URL.
	 */
	async stop(): Promise<void> {
		await this.stopListening();
		this.recentLines.length = 0;
	}

	/**
	 * Close the listener only, keeping identity (sessionId/targetId/logPath).
	 * Mirrors the binary's `stop()`: `closeAllConnections()`, `close()`,
	 * await the `close` event.
	 */
	private async stopListening(): Promise<void> {
		const server = this.server;
		this.server = undefined;
		this.port = 0;
		if (server) {
			server.closeAllConnections();
			server.close();
			await new Promise<void>((resolve) => server.once("close", () => resolve()));
		}
	}

	/** Create the HTTP listener and bind it to `port` (127.0.0.1 only). */
	private async listenOn(port: number): Promise<void> {
		this.server = http.createServer((req, res) => {
			void this.handleRequest(req, res).catch(() => {
				try {
					res.writeHead(500);
					res.end("write-failed");
				} catch {
					/* already closed */
				}
			});
		});
		await new Promise<void>((resolve, reject) => {
			const onError = (err: unknown): void => reject(err);
			this.server!.once("error", onError);
			this.server!.listen(port, "127.0.0.1", () => {
				this.server!.removeListener("error", onError);
				resolve();
			});
		});
		this.port = port;
		if (!this.output && this.opts.createOutputChannel) {
			this.output = this.opts.createOutputChannel("IDE Agent — Debug Logs");
		}
		this.output?.appendLine(`[debug] ingest server listening on 127.0.0.1:${port} (session ${this.sessionId})`);
	}

	dispose(): void {
		void this.stop();
		this.lineListeners.clear();
		this.output?.dispose();
		this.output = undefined;
	}

	private async pickPort(): Promise<number> {
		const configured = this.opts.ndjsonPort ?? 0;
		if (configured && configured > 0) {
			await this.assertPortFree(configured);
			return configured;
		}
		for (let port = DebugServerService.PORT_MIN; port <= DebugServerService.PORT_MAX; port++) {
			if (await isPortFreeOn(port, "127.0.0.1")) {
				return port;
			}
		}
		throw new Error(
			`IDE Agent: no free debug ingest port in ${DebugServerService.PORT_MIN}–${DebugServerService.PORT_MAX} ` +
				`(set ide.debug.ndjsonPort to override)`,
		);
	}

	private async assertPortFree(port: number): Promise<void> {
		if (!(await isPortFreeOn(port, "127.0.0.1"))) {
			throw new Error(`IDE Agent: ide.debug.ndjsonPort ${port} is already in use`);
		}
	}

	/**
	 * [BIN] module 593 ($) verbatim resolution: `<workspace>/.cursor` when a
	 * workspace folder is known, else `~/.cursor/debug-logs`. An explicit
	 * `opts.logDir` overrides both (tests).
	 */
	private resolveLogDir(): string {
		if (this.opts.logDir) {
			return this.opts.logDir;
		}
		if (this.opts.workspaceFolderPath) {
			return path.join(this.opts.workspaceFolderPath, ".cursor");
		}
		return path.join(os.homedir(), ".cursor", "debug-logs");
	}

	/**
	 * [BIN] module 93 verbatim request handling: CORS headers on every
	 * response → OPTIONS 200 → non-POST / wrong-path 404 → missing/invalid
	 * X-Debug-Session-Id 400 → stream the opaque body to the session's log
	 * file → 204 (500 "write-failed" on write error).
	 */
	private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		res.setHeader("Access-Control-Allow-Origin", "*");
		res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
		res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Debug-Session-Id");
		if (req.method === "OPTIONS") {
			res.writeHead(200);
			res.end();
			return;
		}
		// Exact raw-URL match — no URL parsing, no query-string tolerance.
		if (req.method !== "POST" || req.url !== `/ingest/${this.targetId}`) {
			res.writeHead(404);
			res.end();
			return;
		}
		const headerValue = req.headers["x-debug-session-id"];
		if (headerValue === undefined) {
			this.output?.appendLine("Rejected NDJSON ingest request without X-Debug-Session-Id header");
			res.writeHead(400);
			res.end("missing-session-id");
			return;
		}
		if (typeof headerValue !== "string") {
			this.output?.appendLine("Rejected NDJSON ingest request with invalid X-Debug-Session-Id header");
			res.writeHead(400);
			res.end("invalid-session-id");
			return;
		}
		const sessionId = DebugServerService.validateSessionId(headerValue);
		if (!sessionId) {
			this.output?.appendLine("Rejected NDJSON ingest request with invalid X-Debug-Session-Id header");
			res.writeHead(400);
			res.end("invalid-session-id");
			return;
		}
		// Bounded in-memory copy for the recent-lines UI feed; the file write
		// streams the raw bytes uncapped, like the binary.
		const chunks: Buffer[] = [];
		let capturedBytes = 0;
		try {
			await this.appendExclusive(req, this.getLogPathForSession(sessionId), (chunk) => {
				if (capturedBytes < DebugServerService.MAX_LINE_CAPTURE_BYTES) {
					chunks.push(chunk);
					capturedBytes += chunk.length;
				}
			});
		} catch (e) {
			this.output?.appendLine(
				`NDJSON ingest write error: ${e instanceof Error ? e.message : String(e)}`,
			);
			res.writeHead(500);
			res.end("write-failed");
			return;
		}
		res.writeHead(204);
		res.end();
		this.emitLines(Buffer.concat(chunks).toString("utf8"));
	}

	/**
	 * [BIN] module 93 verbatim: appends the request's raw bytes to the log
	 * file (stream pipeline, `flags: "a"`); the only transformation is a
	 * guaranteed trailing newline. Bodies are OPAQUE — no JSON parsing, no
	 * line splitting. Writes serialize through `writeQueue`; a failed write
	 * is logged and the queue continues, while the caller still sees the
	 * rejection.
	 *
	 * `onChunk` is our own addition: it taps the raw chunks for the
	 * recent-lines UI feed without touching the bytes written to disk.
	 */
	private async appendExclusive(
		req: http.IncomingMessage,
		logPath: string,
		onChunk?: (chunk: Buffer) => void,
	): Promise<void> {
		const run = async (): Promise<void> => {
			let lastByte = 10; // "\n" — an empty body writes nothing.
			const out = fs.createWriteStream(logPath, { flags: "a" });
			await pipeline(
				req,
				new Transform({
					transform(chunk: Buffer, _encoding, callback) {
						if (chunk.length > 0) {
							lastByte = chunk[chunk.length - 1];
						}
						onChunk?.(chunk);
						callback(null, chunk);
					},
					flush(callback) {
						if (lastByte !== 10) {
							this.push(Buffer.from("\n"));
						}
						callback();
					},
				}),
				out,
			);
		};
		const pending = this.writeQueue.then(run, run);
		this.writeQueue = pending.catch((e) => {
			this.output?.appendLine(
				`Error appending to log file: ${e instanceof Error ? e.message : String(e)}`,
			);
		});
		return pending;
	}

	/**
	 * Our own UI stepping stone (not in the binary): a best-effort line view
	 * of the ingested bytes for the recent-lines ring buffer, the line
	 * listeners and the output channel. The log file always gets the verbatim
	 * bytes.
	 */
	private emitLines(body: string): void {
		const lines = body
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l.length > 0);
		if (lines.length === 0) {
			return;
		}
		for (const line of lines) {
			this.recentLines.push(line);
			if (this.recentLines.length > DebugServerService.MAX_RECENT_LINES) {
				this.recentLines.shift();
			}
			this.output?.appendLine(formatLine(line));
			for (const listener of this.lineListeners) {
				try {
					listener(line);
				} catch {
					/* listener errors must not break ingestion */
				}
			}
		}
	}
}

/** Best-effort pretty line for the output channel: "<time> <msg>". */
function formatLine(line: string): string {
	try {
		const obj = JSON.parse(line) as { ts?: number; level?: string; msg?: string; message?: string };
		const time = typeof obj.ts === "number" ? new Date(obj.ts).toISOString().slice(11, 23) : "";
		const msg = obj.msg ?? obj.message ?? line;
		const level = obj.level ? `[${obj.level}] ` : "";
		return `${time} ${level}${msg}`.trim();
	} catch {
		return line;
	}
}
