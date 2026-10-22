/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawnSync, execSync } from 'child_process';
import { tmpdir } from 'os';
import fs from 'fs';
import https from 'https';
import path from 'path';
import { createHash } from 'crypto';
import { download } from '../../lib/download.ts';
import { getElectronVersion } from '../../lib/electronVersion.ts';
import type { DebianArchString } from './types.ts';

// Based on https://source.chromium.org/chromium/chromium/src/+/main:build/linux/sysroot_scripts/install-sysroot.py.
const URL_PREFIX = 'https://msftelectronbuild.z5.web.core.windows.net';
const URL_PATH = 'sysroots/toolchain';
const REPO_ROOT = path.dirname(path.dirname(path.dirname(import.meta.dirname)));

const ghApiHeaders: Record<string, string> = {
	Accept: 'application/vnd.github.v3+json',
	'User-Agent': 'VSCode Build',
};

if (process.env.GITHUB_TOKEN) {
	ghApiHeaders.Authorization = 'Basic ' + Buffer.from(process.env.GITHUB_TOKEN).toString('base64');
}

const ghDownloadHeaders = {
	...ghApiHeaders,
	Accept: 'application/octet-stream',
};

interface IFetchOptions {
	assetName: string;
	checksumSha256?: string;
	dest: string;
}

function getSha(filename: fs.PathLike): string {
	const hash = createHash('sha256');
	// Read file 1 MB at a time
	const fd = fs.openSync(filename, 'r');
	const buffer = Buffer.alloc(1024 * 1024);
	let position = 0;
	let bytesRead = 0;
	while ((bytesRead = fs.readSync(fd, buffer, 0, buffer.length, position)) === buffer.length) {
		hash.update(buffer);
		position += bytesRead;
	}
	hash.update(buffer.slice(0, bytesRead));
	return hash.digest('hex');
}

function getVSCodeSysrootChecksum(expectedName: string) {
	const checksums = fs.readFileSync(path.join(REPO_ROOT, 'build', 'checksums', 'vscode-sysroot.txt'), 'utf8');
	for (const line of checksums.split('\n')) {
		const [checksum, name] = line.split(/\s+/);
		if (name === expectedName) {
			return checksum;
		}
	}
	return undefined;
}

/*
 * Do not use the fetch implementation from build/lib/fetch as it relies on vinyl streams
 * and vinyl-fs breaks the symlinks in the compiler toolchain sysroot. We use the native
 * tar implementation for that reason.
 */
async function fetchUrl(options: IFetchOptions): Promise<void> {
	const version = '20260212-405735';
	const releaseUrl = `https://api.github.com/repos/Microsoft/vscode-linux-build-agent/releases/tags/v${version}`;
	const downloadOptions = {
		attempts: 11,
		onRetry: (error: Error) => console.log(`Fetching failed: ${error}`)
	};
	const releaseContents = await download(releaseUrl, { ...downloadOptions, headers: ghApiHeaders });
	const asset = JSON.parse(Buffer.from(releaseContents).toString()).assets.find((a: { name: string }) => a.name === options.assetName);
	if (!asset) {
		throw new Error(`Could not find asset in release of Microsoft/vscode-linux-build-agent @ ${version}`);
	}

	console.log(`Found asset ${options.assetName} @ ${asset.url}.`);
	const assetContents = Buffer.from(await download(asset.url, {
		...downloadOptions,
		headers: ghDownloadHeaders,
		checksumSha256: options.checksumSha256
	}));
	console.log(`Fetched response body buffer: ${assetContents.byteLength} bytes`);
	console.log(`Verified SHA256 checksums match for ${asset.url}`);
	execSync(`tar -xz -C ${options.dest}`, { input: assetContents });
	console.log('Fetch complete!');
}

type SysrootDictEntry = {
	Sha256Sum: string;
	SysrootDir: string;
	Tarball: string;
};

export async function getVSCodeSysroot(arch: DebianArchString, isMusl: boolean = false): Promise<string> {
	let expectedName: string;
	let triple: string;
	const prefix = process.env['VSCODE_SYSROOT_PREFIX'] ?? '-glibc-2.28-gcc-10.5.0';
	switch (arch) {
		case 'amd64':
			expectedName = `x86_64-linux-gnu${prefix}.tar.gz`;
			triple = 'x86_64-linux-gnu';
			break;
		case 'arm64':
			if (isMusl) {
				expectedName = 'aarch64-linux-musl-gcc-10.3.0.tar.gz';
				triple = 'aarch64-linux-musl';
			} else {
				expectedName = `aarch64-linux-gnu${prefix}.tar.gz`;
				triple = 'aarch64-linux-gnu';
			}
			break;
		case 'armhf':
			expectedName = `arm-rpi-linux-gnueabihf${prefix}.tar.gz`;
			triple = 'arm-rpi-linux-gnueabihf';
			break;
	}
	console.log(`Fetching ${expectedName} for ${triple}`);
	const checksumSha256 = getVSCodeSysrootChecksum(expectedName);
	if (!checksumSha256) {
		throw new Error(`Could not find checksum for ${expectedName}`);
	}
	const sysroot = process.env['VSCODE_SYSROOT_DIR'] ?? path.join(tmpdir(), `vscode-${arch}-sysroot`);
	const stamp = path.join(sysroot, '.stamp');
	let result = `${sysroot}/${triple}/${triple}/sysroot`;
	if (isMusl) {
		result = `${sysroot}/output/${triple}`;
	}
	if (fs.existsSync(stamp) && fs.readFileSync(stamp).toString() === expectedName) {
		return result;
	}
	console.log(`Installing ${arch} root image: ${sysroot}`);
	fs.rmSync(sysroot, { recursive: true, force: true });
	fs.mkdirSync(sysroot, { recursive: true });
	await fetchUrl({
		checksumSha256,
		assetName: expectedName,
		dest: sysroot
	});
	fs.writeFileSync(stamp, expectedName);
	return result;
}

// Download hardening for sysroots.json (alpha.33; z3 §4 item 5, same class
// as the dpkg-shlibdeps.pl fix in calculate-deps.ts). The previous bare
// `curl` had no `--fail`, so it exited 0 on an HTTP error page and a 429
// page would only surface later as a misleading JSON.parse error. The
// download below never trusts curl's exit code alone: it reads the real
// HTTP status and Retry-After from the dumped headers on every attempt
// (outer retry loop, max 5 attempts, Retry-After wins over the base
// backoff) and validates the content before the caller parses it.
//
// Magic-check decision for the JSON dict: the 4,096-byte floor used for
// the perl script is NOT applied here — the real size of sysroots.json is
// not pinned in evidence and a hard floor could reject a valid dict.
// Instead the structural equivalent is used: the content must be a JSON
// object (first non-whitespace character '{', parses as JSON, top level
// is a non-null object). No SHA-256 pin is applied because no verified
// hash for sysroots.json exists in evidence (unlike dpkg-shlibdeps.pl).
const SYSROOT_DICT_MAX_ATTEMPTS = 5;
const SYSROOT_DICT_BASE_BACKOFF_MS = [5000, 10000, 20000, 40000];
const SYSROOT_DICT_BACKOFF_CAP_MS = 60000;

const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms: number): void {
	Atomics.wait(sleepBuffer, 0, 0, ms);
}

function parseHttpStatus(headers: string): number | undefined {
	const match = headers.match(/^HTTP\/[\d.]+ (\d+)/m);
	return match ? Number(match[1]) : undefined;
}

function parseRetryAfterMs(headers: string): number {
	const match = headers.match(/^Retry-After:\s*(\d+)/im);
	return match ? Number(match[1]) * 1000 : 0;
}

// Returns a problem description, or undefined when the file is acceptable.
function validateSysrootsDict(dictLocation: string): string | undefined {
	const content = fs.readFileSync(dictLocation, 'utf8');
	if (!content.trimStart().startsWith('{')) {
		return `content does not start with '{' (first bytes: ${JSON.stringify(content.slice(0, 60))})`;
	}
	try {
		const parsed = JSON.parse(content);
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
			return 'top-level JSON value is not an object';
		}
	} catch (e) {
		return `content is not valid JSON: ${e instanceof Error ? e.message : String(e)}`;
	}
	return undefined;
}

function downloadSysrootsDict(url: string, dictLocation: string): void {
	const headerFile = `${dictLocation}.headers`;
	let lastProblem = 'unknown';
	for (let attempt = 1; attempt <= SYSROOT_DICT_MAX_ATTEMPTS; attempt++) {
		const result = spawnSync('curl', ['--fail', '--silent', '--show-error', '-D', headerFile, url, '-o', dictLocation]);
		const headers = fs.existsSync(headerFile) ? fs.readFileSync(headerFile, 'utf8') : '';
		const status = parseHttpStatus(headers);
		if (result.status === 0) {
			const problem = validateSysrootsDict(dictLocation);
			if (!problem) {
				return;
			}
			lastProblem = `downloaded content from ${url} failed magic check: ${problem}`;
		} else {
			lastProblem = `HTTP ${status ?? '?'} from ${url} (curl exit ${result.status})`;
		}
		if (attempt < SYSROOT_DICT_MAX_ATTEMPTS) {
			const retryAfterMs = parseRetryAfterMs(headers);
			const wait = Math.min(SYSROOT_DICT_BACKOFF_CAP_MS, Math.max(SYSROOT_DICT_BASE_BACKOFF_MS[attempt - 1] ?? 40000, retryAfterMs));
			sleepSync(wait);
		}
	}
	throw new Error(`Cannot retrieve sysroots.json after ${SYSROOT_DICT_MAX_ATTEMPTS} attempts: ${lastProblem}`);
}

export async function getChromiumSysroot(arch: DebianArchString): Promise<string> {
	const sysrootJSONUrl = `https://raw.githubusercontent.com/electron/electron/v${getElectronVersion().electronVersion}/script/sysroots.json`;
	const sysrootDictLocation = `${tmpdir()}/sysroots.json`;
	downloadSysrootsDict(sysrootJSONUrl, sysrootDictLocation);
	const sysrootInfo = JSON.parse(fs.readFileSync(sysrootDictLocation, 'utf8'));
	const sysrootArch = `bullseye_${arch}`;
	const sysrootDict: SysrootDictEntry = sysrootInfo[sysrootArch];
	const tarballFilename = sysrootDict['Tarball'];
	const tarballSha = sysrootDict['Sha256Sum'];
	const sysroot = path.join(tmpdir(), sysrootDict['SysrootDir']);
	const url = [URL_PREFIX, URL_PATH, tarballSha].join('/');
	const stamp = path.join(sysroot, '.stamp');
	if (fs.existsSync(stamp) && fs.readFileSync(stamp).toString() === url) {
		return sysroot;
	}

	console.log(`Installing Debian ${arch} root image: ${sysroot}`);
	fs.rmSync(sysroot, { recursive: true, force: true });
	fs.mkdirSync(sysroot);
	const tarball = path.join(sysroot, tarballFilename);
	console.log(`Downloading ${url}`);
	let downloadSuccess = false;
	for (let i = 0; i < 3 && !downloadSuccess; i++) {
		fs.writeFileSync(tarball, '');
		await new Promise<void>((c) => {
			https.get(url, (res) => {
				res.on('data', (chunk) => {
					fs.appendFileSync(tarball, chunk);
				});
				res.on('end', () => {
					downloadSuccess = true;
					c();
				});
			}).on('error', (err) => {
				console.error('Encountered an error during the download attempt: ' + err.message);
				c();
			});
		});
	}
	if (!downloadSuccess) {
		fs.rmSync(tarball);
		throw new Error('Failed to download ' + url);
	}
	const sha = getSha(tarball);
	if (sha !== tarballSha) {
		throw new Error(`Tarball checksum is wrong. Expected ${tarballSha}, actual ${sha}`);
	}

	const proc = spawnSync('tar', ['xf', tarball, '-C', sysroot]);
	if (proc.status) {
		throw new Error('Tarball extraction failed with code ' + proc.status);
	}
	fs.rmSync(tarball);
	fs.writeFileSync(stamp, url);
	return sysroot;
}
