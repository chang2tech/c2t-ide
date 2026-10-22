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

// Vendored sysroots.json (alpha.35, vendor B1; same class as the
// dpkg-shlibdeps.pl vendor in calculate-deps.ts). The dict is NOT
// downloaded at build time: it lives in vendor/sysroots.json next
// to this file and is validated before the caller parses it. The
// download path was removed after the GitHub contents API
// rate-limited (HTTP 429) the alpha.34 CI run (SIG-B34-01); the
// earlier alpha.33 download from the raw host hit the same limit.
//
// Validation decision for the JSON dict: the 4,096-byte floor used
// for the perl script is NOT applied here. Instead the structural
// equivalent is used: the content must be a JSON object (first
// non-whitespace character '{', parses as JSON, top level is a
// non-null object). The file is additionally pinned by SHA-256
// (SYSROOTS_JSON_SHA256 below): the vendored copy is
// byte-identical to script/sysroots.json of electron/electron at
// the pinned Electron version, so a stale vendored file after an
// Electron bump fails the build loudly instead of silently
// selecting an old sysroot. See vendor/README.md.
const SYSROOTS_JSON_SHA256 = '2fcdb40d559e8e5334618afca7da27f7e3b40321780372f3fed4e40585805e6c';
// ^ SHA-256 of the vendored sysroots.json in vendor/ next to this
// file, byte-identical to script/sysroots.json of electron/electron
// at the pinned Electron version (v43.7.7 — .npmrc target, registered
// in cgmanifest.json). When the Electron version moves, replace the
// vendored file AND update this pin in the same commit — see
// vendor/README.md.

const SYSROOTS_JSON_VENDOR_PATH = path.join(import.meta.dirname, 'vendor', 'sysroots.json');

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
	const sha256 = createHash('sha256').update(fs.readFileSync(dictLocation)).digest('hex');
	if (sha256 !== SYSROOTS_JSON_SHA256) {
		return `SHA-256 mismatch: expected ${SYSROOTS_JSON_SHA256}, actual ${sha256}`;
	}
	return undefined;
}

// alpha.35 (vendor B1): sysroots.json is vendored in this repo at
// vendor/sysroots.json next to this file — it is NOT downloaded. The
// download path was removed after the contents API rate-limited the
// alpha.34 CI run (SIG-B34-01). The vendored file goes through the
// same validateSysrootsDict() structural check a downloaded file did.
function loadVendoredSysrootsDict(): string {
	if (!fs.existsSync(SYSROOTS_JSON_VENDOR_PATH)) {
		throw new Error(`Vendored sysroots.json not found at ${SYSROOTS_JSON_VENDOR_PATH} — expected build/linux/debian/vendor/sysroots.json in the repository (alpha.35 vendor B1; there is no network fallback). Restore the vendored file and re-run.`);
	}
	const problem = validateSysrootsDict(SYSROOTS_JSON_VENDOR_PATH);
	if (problem) {
		throw new Error(`Vendored sysroots.json at ${SYSROOTS_JSON_VENDOR_PATH} failed validation: ${problem}`);
	}
	return SYSROOTS_JSON_VENDOR_PATH;
}

export async function getChromiumSysroot(arch: DebianArchString): Promise<string> {
	const sysrootDictLocation = loadVendoredSysrootsDict();
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
