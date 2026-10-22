/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const nodeCompileCacheKinds = ['main', 'extension-host', 'shared-process', 'pty-host', 'agent-host'] as const;
const nodeCompileCacheTagPattern = /^v\d+\.\d+\.\d+-(arm64|x64)-[0-9a-f]{8}$/;
const nodeCompileCacheEntryPattern = /^[0-9a-f]{8}$/;

export interface INodeCompileCacheProduct {
	readonly applicationName: string;
	readonly nameLong: string;
	readonly nameShort: string;
	readonly quality?: string;
}

export interface INodeCompileCachePaths {
	readonly application: string;
	readonly cacheDirectory: string;
}

export function shouldGenerateNodeCompileCache(platform: string, arch: string, product: INodeCompileCacheProduct): boolean {
	if (!product.quality) {
		return false;
	}

	// TODO: Re-enable POSIX caches once the runtime fixes portable caching with eager/read-only options.
	return platform === 'win32' && arch === 'x64';
}

export function getNodeCompileCachePaths(platform: string, outputDirectory: string, versionedResourcesFolder: string, product: INodeCompileCacheProduct): INodeCompileCachePaths {
	if (platform === 'darwin') {
		const applicationRoot = path.join(outputDirectory, `${product.nameLong}.app`);
		return {
			application: path.join(applicationRoot, 'Contents', 'MacOS', product.nameShort),
			cacheDirectory: path.join(applicationRoot, 'Contents', 'Resources', 'app', 'node-compile-cache')
		};
	}

	const application = platform === 'win32'
		? path.join(outputDirectory, `${product.nameShort}.exe`)
		: path.join(outputDirectory, product.applicationName);

	return {
		application,
		cacheDirectory: path.join(outputDirectory, versionedResourcesFolder, 'resources', 'app', 'node-compile-cache')
	};
}

/**
 * Path of the packaged CLI bundle (`out/cli.js`) inside the packaged app —
 * the entry the shipped `bin/code` / `bin/code.cmd` launchers execute with
 * `ELECTRON_RUN_AS_NODE=1`. Used by the smoke check's `--version` tier
 * (B-W1-F07): invoking the Electron binary with a bare `--version` boots
 * the GUI main process instead, which has no `--version` handling.
 */
export function getPackagedCliEntry(platform: string, outputDirectory: string, product: INodeCompileCacheProduct): string {
	if (platform === 'darwin') {
		return path.join(outputDirectory, `${product.nameLong}.app`, 'Contents', 'Resources', 'app', 'out', 'cli.js');
	}
	return path.join(outputDirectory, 'resources', 'app', 'out', 'cli.js');
}

export function createNodeCompileCacheGenerationEnvironment(portableDirectory: string, parentEnvironment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const env = { ...parentEnvironment };
	delete env.ELECTRON_RUN_AS_NODE;
	delete env.NODE_COMPILE_CACHE;
	delete env.NODE_COMPILE_CACHE_PORTABLE;
	delete env.NODE_COMPILE_CACHE_READONLY;
	delete env.NODE_DISABLE_COMPILE_CACHE;
	delete env.VSCODE_DEV;
	delete env.VSCODE_MEASURE_NODE_COMPILE_CACHE;
	delete env.VSCODE_NODE_COMPILE_CACHE_KIND;
	delete env.VSCODE_NODE_COMPILE_CACHE_MEASUREMENTS;
	delete env.VSCODE_NODE_COMPILE_CACHE_ROOT;
	env.VSCODE_GENERATE_NODE_COMPILE_CACHE = '1';
	env.VSCODE_PORTABLE = portableDirectory;
	return env;
}

export async function generateNodeCompileCache(platform: string, outputDirectory: string, versionedResourcesFolder: string, product: INodeCompileCacheProduct): Promise<void> {
	const paths = getNodeCompileCachePaths(platform, outputDirectory, versionedResourcesFolder, product);
	const temporaryDirectory = platform === 'win32' ? os.tmpdir() : '/tmp';
	// C-P1-1: no cleanup/setup step around this function may throw out of it
	// and fail the build against the non-fatal design. The temporary portable
	// directory is therefore created inside the guarded region below and
	// every removal goes through tryRemoveDirectory (retry + warn, never
	// throw), so a cleanup failure can neither replace a successful result
	// nor mask a fatal generation/validation error thrown by the try block.
	let portableDirectory: string | undefined;
	try {
		try {
			portableDirectory = await fs.promises.mkdtemp(path.join(temporaryDirectory, 'vscode-cache-'));
		} catch (error) {
			console.warn(`WARNING: Could not create a temporary directory for Node.js compile cache generation (${(error as Error).message.split('\n')[0]}); packaging without a pre-generated compile cache. This package will start slower on every launch (the runtime never populates the cache itself) until a build with a generated cache ships.`);
			return;
		}
		await tryRemoveDirectory(paths.cacheDirectory, 'the stale Node.js compile cache directory');

		const env = createNodeCompileCacheGenerationEnvironment(portableDirectory);
		try {
			await runCacheGenerationWithRetry(paths.application, paths.cacheDirectory, env);
		} catch (error) {
			if (portableDirectory) {
				dumpPackagedAppLogs(portableDirectory, 'compile cache generation');
			}
			const classification = classifyCacheGenerationFailure(error);
			if (classification.fatal) {
				// The app is broken, not the runner: keep the build red. This
				// generation run is the only full packaged-app startup in the
				// -ci series (gulpfile.vscode.ts pushes this task last), so
				// there is no later smoke test to catch it.
				throw error;
			}
			// Infrastructure candidate (timeout on a still-alive child, the
			// builds #14/#15 pattern). Downgrading is only allowed with
			// independent proof that the packaged app starts: run the fatal
			// smoke check. If it throws, the build goes red here.
			await runPackagedAppSmokeCheck(paths.application, getPackagedCliEntry(platform, outputDirectory, product), portableDirectory);
			// NOTE (B-W1-F03): the runtime does NOT warm this cache up later.
			// Without a packaged cache, enableNodeCompileCache reports
			// 'missing' and returns before enabling anything, and existing
			// caches are opened readOnly (src/vs/base/node/nodeCompileCache.ts).
			// A cache-less package is slower on EVERY launch of EVERY process
			// kind until a build with a cache ships — say so plainly.
			console.warn(`::warning title=Node compile cache skipped::Node.js compile cache generation timed out (${classification.reason}); packaging WITHOUT a pre-generated compile cache after the packaged-app smoke check passed. This package will start slower on every launch (the runtime never populates the cache itself) until a build with a generated cache ships.`);
			await tryRemoveDirectory(paths.cacheDirectory, 'the partial Node.js compile cache directory');
			return;
		}
		// Validation failures are fatal and deliberately outside the catch
		// above: generation exited 0, so a malformed cache is an app/cache
		// logic failure, never a slow runner.
		const totalCacheEntryCount = await validateNodeCompileCache(paths.cacheDirectory, process.arch);
		console.log(`Generated ${totalCacheEntryCount} total Node.js compile cache entries in ${paths.cacheDirectory}.`);
	} finally {
		if (portableDirectory) {
			await tryRemoveDirectory(portableDirectory, 'the temporary portable directory');
		}
	}
}

/**
 * Best-effort directory cleanup (C-P1-1). Uses the retrying remover so
 * transient Windows file-lock races (EBUSY/EPERM/ENOTEMPTY) still heal, but
 * a cleanup failure is only ever logged as a warning: it must never throw
 * out of a catch/finally block and replace the primary result — neither a
 * successful generation, a non-fatal downgrade, nor a fatal error that has
 * to fail the build.
 */
async function tryRemoveDirectory(directory: string, description: string): Promise<void> {
	try {
		await removeDirectoryWithRetries(directory);
	} catch (error) {
		console.warn(`WARNING: Failed to clean up ${description} at ${directory} (${(error as Error).message.split('\n')[0]}); continuing.`);
	}
}

/**
 * Best-effort process-tree kill (B-W1-F05). A plain `child.kill()` only
 * signals the direct child: the packaged app spawns sibling processes
 * (shared process, extension host, pty host, agent host) that would
 * otherwise survive a timeout kill as orphans, keep holding file locks,
 * and keep writing into the cache/portable directories after the build
 * layer has already cleaned them up or packaged them.
 *
 * Windows: `taskkill /pid <pid> /T /F` terminates the whole tree (`/T`)
 * by force (`/F`). It is launched via execFile with the pid as a single
 * argv entry — no shell is involved.
 * POSIX: the children spawned in this file use `detached: true`, so the
 * child is a process-group leader and `process.kill(-pid, 'SIGKILL')`
 * signals the whole group, descendants included. If that group does not
 * exist (ESRCH — e.g. a child that was not spawned detached) it falls
 * back to a plain kill of the child itself.
 *
 * Like tryRemoveDirectory, this helper never throws: it is only called
 * from timeout/error paths, and a failed kill must not replace the
 * primary result or change how the surrounding promise settles. The
 * promise still settles from the child's own `close`/`error` events,
 * exactly as with the plain `child.kill()` calls this replaces.
 * Exported so the tree-kill behaviour can be exercised by tests.
 */
export function killProcessTree(child: cp.ChildProcess, description: string): void {
	try {
		if (child.exitCode !== null || child.signalCode !== null) {
			return; // Already exited: there is no tree left to kill.
		}
		const pid = child.pid;
		if (pid === undefined) {
			// The spawn never produced a pid (the spawn itself failed and
			// the `error` handler owns settling): there is no tree to
			// address, so only attempt the plain kill.
			child.kill('SIGKILL');
			return;
		}
		if (process.platform === 'win32') {
			cp.execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, error => {
				if (error) {
					console.warn(`WARNING: Failed to kill ${description} (pid ${pid}) with taskkill (${error.message.split('\n')[0]}); falling back to a plain kill.`);
					try {
						child.kill('SIGKILL');
					} catch {
						// Already gone; the close/error handlers settle.
					}
				}
			});
			return;
		}
		// POSIX: signal the child's whole process group.
		try {
			process.kill(-pid, 'SIGKILL');
			return;
		} catch (groupError) {
			if ((groupError as NodeJS.ErrnoException).code !== 'ESRCH') {
				console.warn(`WARNING: Failed to kill the process group of ${description} (pid ${pid}) (${(groupError as Error).message.split('\n')[0]}); falling back to a plain kill.`);
			}
			// ESRCH means the group does not exist (the child was not a
			// group leader): fall through to the plain kill below.
		}
		try {
			process.kill(pid, 'SIGKILL');
		} catch (killError) {
			if ((killError as NodeJS.ErrnoException).code !== 'ESRCH') {
				console.warn(`WARNING: Failed to kill ${description} (pid ${pid}) (${(killError as Error).message.split('\n')[0]}); continuing.`);
			}
			// ESRCH: the child is already gone — nothing left to do.
		}
	} catch (error) {
		console.warn(`WARNING: Failed to kill ${description} (${(error as Error).message.split('\n')[0]}); continuing.`);
	}
}

/**
 * Timeout and retry policy for the compile-cache generation subprocess.
 *
 * On CI (notably GitHub-hosted Windows runners) the packaged app can take
 * much longer than the historical 120s budget to reach all readiness markers:
 * the main process alone must reach the Eventually phase and then run the
 * synchronous `flushCompileCache()` before writing its marker. Observed in
 * build #14: identical binary passed in build #13, but the #14 runner was slow
 * enough (esbuild bundle took 260s) that the 120s budget expired with only
 * agent-host/pty-host markers written. A longer budget plus one retry absorbs
 * slow-runner flakiness. Only timeouts are retried: spawn/exit failures are
 * deterministic app failures and fail fast (see classifyCacheGenerationFailure
 * for how the final failure is then treated — fatal, or downgraded only
 * after the packaged-app smoke check passes).
 */
const CACHE_GENERATION_TIMEOUT_MS = 300_000;
const CACHE_GENERATION_MAX_ATTEMPTS = 2;

/**
 * Structured failure of one cache-generation run. The `failureKind` — not the
 * message text — drives the fatal/non-fatal decision in
 * generateNodeCompileCache:
 * - 'spawn' / 'exit': the packaged app itself is broken (missing binary,
 *   crash, early exit). Always fatal: this run is the only full packaged-app
 *   startup in the -ci series, so swallowing it ships a broken app green.
 * - 'timeout': the child was still alive when our budget expired and its
 *   output carries no app-fatal signature. This is the only kind that may be
 *   infrastructure (slow runner, see builds #14/#15) — and even then it is
 *   only downgraded after an independent smoke check proves the app starts.
 * - 'unknown': conservative default — fatal.
 */
type NodeCompileCacheFailureKind = 'timeout' | 'exit' | 'spawn' | 'unknown';

class NodeCompileCacheGenerationError extends Error {
	// Plain field declarations, not constructor parameter properties:
	// build/tsconfig.json sets erasableSyntaxOnly (the build pipeline runs
	// these .ts files through type stripping), which forbids them.
	readonly failureKind: NodeCompileCacheFailureKind;
	readonly readyKinds: readonly string[];
	readonly childLifetimeMs: number;

	constructor(message: string, failureKind: NodeCompileCacheFailureKind, readyKinds: readonly string[], childLifetimeMs: number) {
		super(message);
		this.name = 'NodeCompileCacheGenerationError';
		this.failureKind = failureKind;
		this.readyKinds = readyKinds;
		this.childLifetimeMs = childLifetimeMs;
	}
}

/** Output signatures of the runtime refusing to enable the cache in
 *  generating mode (src/vs/base/node/nodeCompileCache.ts, the
 *  `isGeneratingCache` throw). An app-side failure even when it surfaces
 *  as a timeout, so it must never be downgraded. */
const APP_FATAL_OUTPUT_SIGNATURES = [
	'Unable to enable the packaged Node.js compile cache',
	'is not active (status:'
] as const;

/** Signature of the internal readiness deadline from
 *  waitForNodeCompileCacheReady (see fix for B-W1-F02). The app exiting
 *  after this deadline is a timeout, not a crash. */
const INTERNAL_WAIT_TIMEOUT_SIGNATURE = 'Node compile cache readiness timed out';

function classifyCacheGenerationFailure(error: unknown): { readonly fatal: boolean; readonly reason: string } {
	if (error instanceof NodeCompileCacheGenerationError) {
		const outputTail = error.message;
		if (APP_FATAL_OUTPUT_SIGNATURES.some(signature => outputTail.includes(signature))) {
			return { fatal: true, reason: 'runtime refused to enable the packaged cache in generating mode' };
		}
		if (error.failureKind === 'timeout' || outputTail.includes(INTERNAL_WAIT_TIMEOUT_SIGNATURE)) {
			return { fatal: false, reason: `generation timed out with the app still alive (ready kinds: ${error.readyKinds.join(', ') || 'none'}, child lived ${Math.round(error.childLifetimeMs / 1000)}s)` };
		}
		return { fatal: true, reason: `packaged app failure (${error.failureKind})` };
	}
	// Spawn errors surface as raw ErrnoException from child.on('error').
	if ((error as NodeJS.ErrnoException)?.code === 'ENOENT' || (error as NodeJS.ErrnoException)?.syscall === 'spawn') {
		return { fatal: true, reason: 'could not spawn the packaged application' };
	}
	return { fatal: true, reason: 'unclassified failure (conservative default)' };
}

async function runCacheGenerationWithRetry(application: string, cacheDirectory: string, env: NodeJS.ProcessEnv): Promise<void> {
	let lastError: unknown;
	for (let attempt = 1; attempt <= CACHE_GENERATION_MAX_ATTEMPTS; attempt++) {
		// Clear any partial output from a previous attempt so validation sees
		// a clean state. Best-effort like every other cleanup (C-P1-1): a
		// locked leftover must not fail the build here — the generation run
		// and the fatal validation that follows judge the result.
		await tryRemoveDirectory(cacheDirectory, 'the partial Node.js compile cache directory from the previous attempt');
		try {
			await runCacheGeneration(application, cacheDirectory, env);
			return;
		} catch (error) {
			lastError = error;
			// Only a timeout can heal by retrying (a warmer/slower runner may
			// finish on the second attempt). Spawn/exit failures are
			// deterministic app failures — fail fast instead of paying for a
			// second doomed run.
			if (!(error instanceof NodeCompileCacheGenerationError) || error.failureKind !== 'timeout') {
				throw error;
			}
			if (attempt < CACHE_GENERATION_MAX_ATTEMPTS) {
				console.log(`Node.js compile cache generation attempt ${attempt}/${CACHE_GENERATION_MAX_ATTEMPTS} failed (${(error as Error).message.split('\n')[0]}); retrying...`);
			}
		}
	}
	throw lastError;
}

/**
 * Fatal smoke check for the non-fatal path (B-W1-F01). Cache generation is
 * the only full packaged-app startup in the -ci series, so before a timeout
 * may be downgraded to "slow runner", the app must prove — independently of
 * the full 5-kind cache run — that it starts:
 *  1. The packaged CLI entry (`out/cli.js`, run exactly the way the shipped
 *     `bin/code.cmd` launcher runs it: `ELECTRON_RUN_AS_NODE=1 <exe>
 *     out/cli.js --version`) prints the version and exits 0 within a small
 *     budget (binary loads, node bootstrap runs, CLI bundle parses args).
 *     NOTE (B-W1-F07): spawning `<exe> --version` WITHOUT the CLI entry is
 *     NOT a version check — the Electron main process has no `--version`
 *     handling in electron-main, so it boots the full GUI app, never prints
 *     a version, and idles until the timeout kills it (exit code 1). That
 *     is what failed build alpha.23 on Windows, not a broken app.
 *  2. A shortened generating-mode launch reaches the `main` readiness
 *     marker, which is only written after the main process reaches the
 *     Eventually phase (src/vs/code/electron-main/app.ts). The other four
 *     kinds are deliberately NOT required here: waiting for all of them on
 *     a slow runner is exactly what timed out in builds #14/#15.
 * Throws on any failure; the caller lets that fail the build.
 */
const SMOKE_VERSION_TIMEOUT_MS = 30_000;
const SMOKE_MAIN_MARKER_TIMEOUT_MS = 120_000;

/**
 * Launch args for every GUI launch of the packaged app in this file (cache
 * generation + Tier-2 smoke). These launches only need the app's processes
 * to boot and write readiness markers on CI runners that have no real GPU
 * (GitHub-hosted Windows = Windows Server with a basic render driver).
 * Electron's GPU process initialization can stall there, leaving the
 * workbench renderer unable to ever signal ready — the alpha.24–alpha.26
 * pattern (pty-host/agent-host markers written in ~5s, main/extension-host/
 * shared-process markers never written, main log silent after ~0.9s).
 * `--disable-gpu` forces software rendering for these build-only launches;
 * it is never passed to the shipped app or its launchers.
 * `--log trace` raises the log level of these build-only launches to
 * trace: the level propagates from the main process to the renderer
 * (window configuration) and the shared process, so their file logs
 * (renderer.log, sharedprocess.log) record where a startup stall
 * actually stops instead of staying silent at the default info level.
 * Like `--disable-gpu`, it applies only to launches from this file.
 */
const PACKAGED_APP_CI_LAUNCH_ARGS: readonly string[] = ['--disable-gpu', '--log', 'trace'];

/**
 * Best-effort dump of the packaged app's own log files (main + renderer)
 * from the portable user-data directory into the build output. The child
 * stdout/stderr captured by the spawns above does NOT include the app's
 * file logs, so a renderer that stalls before signalling ready is
 * otherwise invisible in CI (builds alpha.24–alpha.26 failed with a
 * ~0.9s main log and no renderer evidence at all). Synchronous on
 * purpose: it is called from timeout callbacks and failure paths where
 * the process tree is about to be killed and the portable directory is
 * about to be removed. Never throws.
 */
function dumpPackagedAppLogs(portableDirectory: string, context: string): void {
	try {
		const logsRoot = path.join(portableDirectory, 'user-data', 'logs');
		if (!fs.existsSync(logsRoot)) {
			console.log(`[node-compile-cache] No app log directory found for ${context} at ${logsRoot}.`);
			return;
		}
		// renderer.log and sharedprocess.log carry the decisive evidence
		// for a renderer startup stall: they are dumped IN FULL below —
		// no 120-line tail and no share of the character budget. Both
		// loggers are spdlog rotating loggers (up to 6 files each: the
		// current file plus .1.log (newest) ... .5.log (oldest), ~5 MB
		// per file), so the full dump covers the whole file FAMILY —
		// the startup segment sits in the oldest rotated file once
		// rotation has happened. Every other file keeps the previous
		// tail+budget behaviour.
		const rotatedLogName = /^(renderer|sharedprocess)\.(\d+)\.log$/;
		const isFullDumpFile = (name: string): boolean => name === 'renderer.log' || name === 'sharedprocess.log' || rotatedLogName.test(name);
		const files: string[] = [];
		const collect = (dir: string, depth: number): void => {
			if (depth > 3 || files.length > 48) {
				return;
			}
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					collect(full, depth + 1);
				} else if (entry.isFile() && (entry.name === 'main.log' || isFullDumpFile(entry.name))) {
					files.push(full);
				}
			}
		};
		collect(logsRoot, 0);
		if (files.length === 0) {
			console.log(`[node-compile-cache] No app log files found for ${context} under ${logsRoot}.`);
			return;
		}
		// Full-dump files first, so the decisive content reaches the
		// build log before any tail-budgeted file. Within one family,
		// oldest first: rotated index descending (.5 = oldest) with
		// the current file (index 0) last, so a family's content reads
		// in chronological order.
		const rotationIndex = (name: string): number => {
			const match = rotatedLogName.exec(name);
			return match ? parseInt(match[2], 10) : 0;
		};
		const familyStem = (name: string): string => name.replace(/(\.\d+)?\.log$/, '');
		files.sort((a, b) => {
			const aName = path.basename(a);
			const bName = path.basename(b);
			const aFull = isFullDumpFile(aName);
			const bFull = isFullDumpFile(bName);
			if (aFull !== bFull) {
				return aFull ? -1 : 1;
			}
			if (!aFull) {
				return 0;
			}
			const byDirectory = path.dirname(a).localeCompare(path.dirname(b));
			if (byDirectory !== 0) {
				return byDirectory;
			}
			const byFamily = familyStem(aName).localeCompare(familyStem(bName));
			if (byFamily !== 0) {
				return byFamily;
			}
			return rotationIndex(bName) - rotationIndex(aName);
		});
		// Manifest: declare up front how many full-dump files exist
		// and how large each is (bytes on disk), so a reader can tell
		// whether rotation happened and whether every declared file
		// actually appears below.
		const fullDumpFiles = files.filter(file => isFullDumpFile(path.basename(file)));
		if (fullDumpFiles.length > 0) {
			const listing = fullDumpFiles.map(file => {
				let size = '?';
				try {
					size = `${fs.statSync(file).size}B`;
				} catch {
					// Size unknown; the per-file dump below reports more.
				}
				return `${path.relative(portableDirectory, file)}=${size}`;
			}).join(', ');
			console.log(`[node-compile-cache] ----- app log dump manifest (${context}): ${fullDumpFiles.length} full-dump file(s) [${listing}] -----`);
		}
		let budget = 40_000;
		for (const file of files) {
			const isFullDump = isFullDumpFile(path.basename(file));
			if (!isFullDump && budget <= 0) {
				break;
			}
			try {
				const content = fs.readFileSync(file, 'utf8');
				if (isFullDump) {
					const lineCount = content.split(/\r?\n/).length;
					console.log(`[node-compile-cache] ----- app log (${context}): ${path.relative(portableDirectory, file)} (FULL dump, ${content.length} chars, ${lineCount} lines) -----\n${content}`);
				} else {
					const lines = content.split(/\r?\n/);
					const tail = lines.slice(-120).join('\n').slice(-budget);
					budget -= tail.length;
					console.log(`[node-compile-cache] ----- app log (${context}): ${path.relative(portableDirectory, file)} (last ${Math.min(120, lines.length)} lines) -----\n${tail}`);
				}
			} catch (error) {
				// A locked or vanished log file must not fail the dump —
				// but the loss is reported, not silent.
				console.log(`[node-compile-cache] Could not read app log file ${path.relative(portableDirectory, file)} for ${context} (${(error as Error).message.split('\n')[0]}); skipping.`);
			}
		}
	} catch {
		// Diagnostics only: never let the dump replace the real failure.
	}
}

async function runPackagedAppSmokeCheck(application: string, cliEntry: string, portableDirectory: string): Promise<void> {
	console.log('Running packaged-app smoke check before packaging without a compile cache...');
	// Tier 1: --version through the packaged CLI entry, exactly like the
	// shipped bin/code.cmd launcher (ELECTRON_RUN_AS_NODE=1 <exe> out/cli.js).
	await new Promise<void>((resolve, reject) => {
		const env = createNodeCompileCacheGenerationEnvironment(portableDirectory);
		delete env.VSCODE_GENERATE_NODE_COMPILE_CACHE;
		// Run the CLI bundle as Node inside the packaged Electron binary,
		// mirroring resources/win32/bin/code.cmd. Spawning `<exe> --version`
		// directly would boot the GUI main process (no --version handling in
		// electron-main) and hang until the timeout — see B-W1-F07 above.
		env.ELECTRON_RUN_AS_NODE = '1';
		// detached on POSIX so killProcessTree can signal the whole process group (B-W1-F05).
		const child = cp.spawn(application, [cliEntry, '--version'], { env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
		let output = '';
		const timeout = setTimeout(() => killProcessTree(child, 'the packaged-app smoke check (--version) process tree'), SMOKE_VERSION_TIMEOUT_MS);
		child.stdout.on('data', chunk => output += chunk.toString());
		child.stderr.on('data', chunk => output += chunk.toString());
		child.on('error', error => { clearTimeout(timeout); reject(new Error(`Packaged-app smoke check (--version) could not spawn the application: ${error.message}`)); });
		child.on('close', (code, signal) => {
			clearTimeout(timeout);
			if (code !== 0) {
				reject(new Error(`Packaged-app smoke check failed: --version exited with code ${code} and signal ${signal ?? 'none'}.` + '\n' + output));
			} else if (!/\d+\.\d+\.\d+/.test(output)) {
				reject(new Error('Packaged-app smoke check failed: --version exited 0 but printed no version string.' + '\n' + output));
			} else {
				resolve();
			}
		});
	});
	// Tier 2: shortened generating-mode launch, main marker only, throwaway cache root
	const smokeRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vscode-smoke-cache-'));
	try {
		const env = createNodeCompileCacheGenerationEnvironment(portableDirectory);
		env.VSCODE_NODE_COMPILE_CACHE_ROOT = smokeRoot;
		await new Promise<void>((resolve, reject) => {
			// detached on POSIX so killProcessTree can signal the whole process group (B-W1-F05).
			const child = cp.spawn(application, [...PACKAGED_APP_CI_LAUNCH_ARGS], { env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
			let output = '';
			child.stdout.on('data', chunk => output += chunk.toString());
			child.stderr.on('data', chunk => output += chunk.toString());
			const mainMarker = path.join(smokeRoot, 'main', '.ready');
			let poll: ReturnType<typeof setInterval>;
			let timeout: ReturnType<typeof setTimeout>;
			const stopWatching = () => { clearInterval(poll); clearTimeout(timeout); };
			// At most one log dump per smoke run: the timeout handler
			// dumps and then the process tree dies, which still fires
			// 'close' — without this guard the close handler would
			// dump the same logs a second time.
			let logsDumped = false;
			const dumpLogsOnce = () => {
				if (logsDumped) {
					return;
				}
				logsDumped = true;
				dumpPackagedAppLogs(portableDirectory, 'packaged-app smoke check');
			};
			poll = setInterval(() => {
				if (fs.existsSync(mainMarker)) {
					stopWatching();
					killProcessTree(child, 'the packaged-app smoke check process tree');
					resolve();
				}
			}, 250);
			timeout = setTimeout(() => {
				stopWatching();
				killProcessTree(child, 'the packaged-app smoke check process tree');
				dumpLogsOnce();
				reject(new Error(`Packaged-app smoke check failed: main readiness marker not written within ${SMOKE_MAIN_MARKER_TIMEOUT_MS / 1000}s — the app did not reach the Eventually phase.\n${output}`));
			}, SMOKE_MAIN_MARKER_TIMEOUT_MS);
			// Spawn failure: this launch never ran, so there are no new
			// logs to dump — and setting the flag stops a 'close' event
			// fired after this 'error' from dumping older sessions.
			child.on('error', error => { stopWatching(); logsDumped = true; reject(new Error(`Packaged-app smoke check could not spawn the application: ${error.message}`)); });
			child.on('close', (code, signal) => {
				stopWatching();
				if (fs.existsSync(mainMarker)) {
					resolve();
				} else {
					dumpLogsOnce();
					reject(new Error(`Packaged-app smoke check failed: application exited with code ${code} and signal ${signal ?? 'none'} before the main readiness marker.\n${output}`));
				}
			});
		});
	} finally {
		// C-P1-1: smoke cleanup is best-effort too — a cleanup failure here
		// must not replace the smoke result (pass or fatal failure).
		await tryRemoveDirectory(smokeRoot, 'the smoke-check compile cache directory');
	}
	console.log('Packaged-app smoke check passed.');
}

/**
 * Removes a directory tree, retrying on Windows file-lock races.
 *
 * On CI (notably Windows), the launched application process may exit while a
 * lingering sibling process (e.g. the shared process) still holds a lock on a
 * file inside the temporary portable user-data directory (observed:
 * `user-data/Shared Dictionary/db-journal`). A single `fs.promises.rm` then
 * fails with EBUSY/EPERM/ENOTEMPTY even with `force: true` (force only ignores
 * ENOENT). Retrying with a short backoff lets the lock release instead of
 * failing the whole packaging step.
 */
async function removeDirectoryWithRetries(directory: string, attempts = 12, delayMs = 500): Promise<void> {
	let lastError: unknown;
	for (let i = 0; i < attempts; i++) {
		try {
			await fs.promises.rm(directory, { recursive: true, force: true });
			return;
		} catch (error) {
			lastError = error;
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'ENOTEMPTY') {
				throw error;
			}
			if (i < attempts - 1) {
				await new Promise(resolve => setTimeout(resolve, delayMs));
			}
		}
	}
	throw lastError;
}

export async function validateNodeCompileCache(rootDirectory: string, architecture: string): Promise<number> {
	let totalCacheEntryCount = 0;
	for (const kind of nodeCompileCacheKinds) {
		const kindDirectory = path.join(rootDirectory, kind);
		const entries = await fs.promises.readdir(kindDirectory, { withFileTypes: true });
		const tagDirectories = entries.filter(entry => entry.isDirectory() && nodeCompileCacheTagPattern.exec(entry.name)?.[1] === architecture);
		if (tagDirectories.length !== 1) {
			throw new Error(`Node.js compile cache generation produced ${tagDirectories.length} ${architecture} version-tag directories for ${kind} in ${kindDirectory}; expected exactly one.`);
		}
		if (!entries.some(entry => entry.isFile() && entry.name === '.ready')) {
			throw new Error(`Node.js compile cache generation did not produce a readiness marker for ${kind} in ${kindDirectory}.`);
		}
		const unexpectedEntries = entries.filter(entry => entry.name !== '.ready' && entry.name !== tagDirectories[0].name);
		if (unexpectedEntries.length > 0) {
			throw new Error(`Node.js compile cache generation produced unexpected ${kind} entries in ${kindDirectory}: ${unexpectedEntries.map(entry => entry.name).join(', ')}.`);
		}

		const cacheDirectory = path.join(kindDirectory, tagDirectories[0].name);
		const cacheEntries = await fs.promises.readdir(cacheDirectory, { withFileTypes: true });
		const validCacheEntries = cacheEntries.filter(entry => entry.isFile() && nodeCompileCacheEntryPattern.test(entry.name));
		const cacheEntryCount = validCacheEntries.length;
		if (cacheEntryCount === 0) {
			throw new Error(`Node.js compile cache generation produced no ${kind} cache entries in ${cacheDirectory}.`);
		}
		const unexpectedCacheEntries = cacheEntries.filter(entry => !entry.isFile() || !nodeCompileCacheEntryPattern.test(entry.name));
		if (unexpectedCacheEntries.length > 0) {
			throw new Error(`Node.js compile cache generation produced unexpected ${kind} cache entries in ${cacheDirectory}: ${unexpectedCacheEntries.map(entry => entry.name).join(', ')}.`);
		}
		totalCacheEntryCount += cacheEntryCount;
		console.log(`Generated ${cacheEntryCount} ${kind} Node.js compile cache entries in ${cacheDirectory}.`);
		await fs.promises.rm(path.join(kindDirectory, '.ready'));
	}
	return totalCacheEntryCount;
}

function runCacheGeneration(application: string, cacheDirectory: string, env: NodeJS.ProcessEnv): Promise<void> {
	return new Promise((resolve, reject) => {
		const startedAt = Date.now();
		// Marker progress timeline: which kinds became ready, and when, so a
		// timeout report distinguishes "still progressing slowly" from
		// "stuck before phase X" (B-W1-F02).
		const readyObservedAt = new Map<string, number>();
		const progressPoll = setInterval(() => {
			for (const kind of nodeCompileCacheKinds) {
				if (!readyObservedAt.has(kind) && fs.existsSync(path.join(cacheDirectory, kind, '.ready'))) {
					readyObservedAt.set(kind, Date.now() - startedAt);
					console.log(`Node.js compile cache marker '${kind}' ready after ${Math.round((Date.now() - startedAt) / 1000)}s.`);
				}
			}
		}, 5_000);
		const child = cp.spawn(application, [...PACKAGED_APP_CI_LAUNCH_ARGS], {
			env,
			stdio: ['ignore', 'pipe', 'pipe'],
			// detached on POSIX so killProcessTree can signal the whole process group (B-W1-F05).
			detached: process.platform !== 'win32'
		});
		let output = '';
		let didTimeOut = false;
		const timeout = setTimeout(() => {
			didTimeOut = true;
			killProcessTree(child, 'the Node.js compile cache generation process tree');
		}, CACHE_GENERATION_TIMEOUT_MS);

		child.stdout.on('data', chunk => output += chunk.toString());
		child.stderr.on('data', chunk => output += chunk.toString());
		child.on('error', error => {
			clearTimeout(timeout);
			clearInterval(progressPoll);
			reject(new NodeCompileCacheGenerationError(`Node.js compile cache generation could not spawn the packaged application: ${error.message}\n${output}`, 'spawn', [...readyObservedAt.keys()], Date.now() - startedAt));
		});
		child.on('close', (code, signal) => {
			clearTimeout(timeout);
			clearInterval(progressPoll);
			if (didTimeOut) {
				const missingKinds = nodeCompileCacheKinds.filter(kind => !fs.existsSync(path.join(cacheDirectory, kind, '.ready')));
				const missingKindsMessage = missingKinds.length > 0 ? ` Missing readiness markers: ${missingKinds.join(', ')}.` : '';
				reject(new NodeCompileCacheGenerationError(`Node.js compile cache generation timed out.${missingKindsMessage}\n${output}`, 'timeout', [...readyObservedAt.keys()], Date.now() - startedAt));
			} else if (code !== 0) {
				reject(new NodeCompileCacheGenerationError(`Node.js compile cache generation exited with code ${code} and signal ${signal ?? 'none'}.\n${output}`, 'exit', [...readyObservedAt.keys()], Date.now() - startedAt));
			} else {
				resolve();
			}
		});
	});
}
