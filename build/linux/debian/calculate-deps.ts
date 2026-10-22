/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { constants, existsSync, readFileSync, statSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import manifests from '../../../cgmanifest.json' with { type: 'json' };
import { additionalDeps } from './dep-lists.ts';
import type { DebianArchString } from './types.ts';

// Download hardening for dpkg-shlibdeps.pl (alpha.33; z3 §4 + lane-B
// corrections DC-1..DC-5). The previous bare `curl` had no `--fail`, so it
// exited 0 on an HTTP error page: a GitHub 429 page was written to disk and
// handed to perl, which died with a misleading syntax error (the alpha.32
// prepare-deb failure, 2/2 attempts). The download below therefore never
// trusts curl's exit code alone (DC-5): it reads the real HTTP status and
// Retry-After from the dumped headers on every attempt (DC-1), validates the
// downloaded content (DC-2) and verifies a pinned SHA-256 (DC-3).
// alpha.34: the script is fetched from the GitHub contents API
// (api.github.com, Accept: application/vnd.github.raw) instead of the
// previous raw host, which rate-limited (HTTP 429) the alpha.33 CI
// run; the contents API serves byte-identical content (verified
// against the pin below).
const DPKG_SHLIBDEPS_SHA256 = '71b61bee790bf06797c901334f60b916c41f8346f9f8c333f9fa378d7e3b05bd';
// ^ SHA-256 of dpkg-shlibdeps.pl at the Chromium pin in cgmanifest.json
// (version 150.0.7871.250, commitHash f916f1b7136907af19d96b95b891533d091d932a;
// hash verified from two independent sources by lane B). Update this pin
// together with the cgmanifest Chromium registration.
const DPKG_SHLIBDEPS_MIN_SIZE = 4096; // real script: 31,983 bytes; captured HTTP 429 page: 313 bytes
const DOWNLOAD_MAX_ATTEMPTS = 5;
const DOWNLOAD_BASE_BACKOFF_MS = [5000, 10000, 20000, 40000];
const DOWNLOAD_BACKOFF_CAP_MS = 60000;

// Headers for the contents-API download (alpha.34, AD-1): Bearer auth
// only, and only when GITHUB_TOKEN is set; anonymous otherwise. The
// token is passed to curl as an argument and is never logged.
const ghContentsHeaders: Record<string, string> = {
	Accept: 'application/vnd.github.raw',
	'User-Agent': 'VSCode Build',
};

if (process.env.GITHUB_TOKEN) {
	ghContentsHeaders.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
}

function curlHeaderArgs(headers: Record<string, string>): string[] {
	const args: string[] = [];
	for (const [name, value] of Object.entries(headers)) {
		args.push('-H', `${name}: ${value}`);
	}
	return args;
}

const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms: number): void {
	// Synchronous sleep: calculatePackageDeps and its callers are sync.
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

function readHeaderDump(headerFile: string): string {
	return existsSync(headerFile) ? readFileSync(headerFile, 'utf8') : '';
}

// Returns a problem description, or undefined when the file is acceptable.
function validateDpkgShlibdeps(scriptLocation: string): string | undefined {
	const size = statSync(scriptLocation).size;
	if (size < DPKG_SHLIBDEPS_MIN_SIZE) {
		return `size ${size} below floor ${DPKG_SHLIBDEPS_MIN_SIZE}`;
	}
	const head = readFileSync(scriptLocation, 'utf8').slice(0, 512);
	const firstLine = head.split('\n')[0];
	if (!/^#!.*perl/.test(firstLine)) {
		return `first line is not a perl shebang: ${JSON.stringify(firstLine.slice(0, 60))}`;
	}
	if (!head.includes('dpkg-shlibdeps')) {
		return `head does not contain 'dpkg-shlibdeps'`;
	}
	const sha256 = createHash('sha256').update(readFileSync(scriptLocation)).digest('hex');
	if (sha256 !== DPKG_SHLIBDEPS_SHA256) {
		return `SHA-256 mismatch: expected ${DPKG_SHLIBDEPS_SHA256}, actual ${sha256}`;
	}
	return undefined;
}

function downloadDpkgShlibdeps(url: string, scriptLocation: string): void {
	const headerFile = `${scriptLocation}.headers`;
	let lastProblem = 'unknown';
	for (let attempt = 1; attempt <= DOWNLOAD_MAX_ATTEMPTS; attempt++) {
		const result = spawnSync('curl', ['--fail', '--silent', '--show-error', '-D', headerFile, ...curlHeaderArgs(ghContentsHeaders), url, '-o', scriptLocation]);
		const headers = readHeaderDump(headerFile);
		const status = parseHttpStatus(headers);
		if (result.status === 0) {
			const problem = validateDpkgShlibdeps(scriptLocation);
			if (!problem) {
				return;
			}
			lastProblem = `downloaded content from ${url} failed validation: ${problem}`;
		} else {
			// With --fail, an HTTP error (e.g. 429) makes curl exit non-zero;
			// the status parsed from the header dump is the authoritative
			// cause and is what the final error reports (DC-1/DC-5).
			lastProblem = `HTTP ${status ?? '?'} from ${url} (curl exit ${result.status})`;
		}
		if (attempt < DOWNLOAD_MAX_ATTEMPTS) {
			const retryAfterMs = parseRetryAfterMs(headers);
			const wait = Math.min(DOWNLOAD_BACKOFF_CAP_MS, Math.max(DOWNLOAD_BASE_BACKOFF_MS[attempt - 1] ?? 40000, retryAfterMs));
			sleepSync(wait);
		}
	}
	throw new Error(`Cannot retrieve dpkg-shlibdeps after ${DOWNLOAD_MAX_ATTEMPTS} attempts: ${lastProblem}`);
}

export function generatePackageDeps(files: string[], arch: DebianArchString, chromiumSysroot: string, vscodeSysroot: string): Set<string>[] {
	// DC-4: download and validate dpkg-shlibdeps.pl exactly once here (the
	// only caller chain is dependencies-generator.ts -> generatePackageDeps)
	// and pass the path down, instead of re-downloading it for every binary.
	const chromiumManifest = manifests.registrations.filter(registration => {
		return registration.component.type === 'git' && registration.component.git!.name === 'chromium';
	});
	const dpkgShlibdepsUrl = `https://api.github.com/repos/chromium/chromium/contents/third_party/dpkg-shlibdeps/dpkg-shlibdeps.pl?ref=${chromiumManifest[0].version}`;
	const dpkgShlibdepsScriptLocation = `${tmpdir()}/dpkg-shlibdeps.pl`;
	downloadDpkgShlibdeps(dpkgShlibdepsUrl, dpkgShlibdepsScriptLocation);
	const dependencies: Set<string>[] = files.map(file => calculatePackageDeps(file, arch, chromiumSysroot, vscodeSysroot, dpkgShlibdepsScriptLocation));
	const additionalDepsSet = new Set(additionalDeps);
	dependencies.push(additionalDepsSet);
	return dependencies;
}

// Based on https://source.chromium.org/chromium/chromium/src/+/main:chrome/installer/linux/debian/calculate_package_deps.py.
function calculatePackageDeps(binaryPath: string, arch: DebianArchString, chromiumSysroot: string, vscodeSysroot: string, dpkgShlibdepsScriptLocation: string): Set<string> {
	try {
		if (!(statSync(binaryPath).mode & constants.S_IXUSR)) {
			throw new Error(`Binary ${binaryPath} needs to have an executable bit set.`);
		}
	} catch (e) {
		// The package might not exist. Don't re-throw the error here.
		// (BUILD-AUTOLOOP alpha.25: this covers bin/<tunnelApplicationName> —
		// the GitHub workflow does not build or mix in the Rust CLI
		// (upstream's azure "Mix in CLI" step is not replicated), so the file
		// is absent from the packaged app. Falling through to dpkg-shlibdeps
		// on a nonexistent path fails the build hard ("cannot read ...: No
		// such file or directory", exit 25), so skip the dependency scan for
		// a missing file instead.
		console.error('Tried to stat ' + binaryPath + ' but failed; skipping dependency scan for it.');
		return new Set<string>();
	}

	// dpkg-shlibdeps.pl was downloaded and validated once by
	// generatePackageDeps (DC-4) and is only consumed here.
	const cmd = [dpkgShlibdepsScriptLocation, '--ignore-weak-undefined', '--ignore-missing-info'];
	switch (arch) {
		case 'amd64':
			cmd.push(`-l${chromiumSysroot}/usr/lib/x86_64-linux-gnu`,
				`-l${chromiumSysroot}/lib/x86_64-linux-gnu`,
				`-l${vscodeSysroot}/usr/lib/x86_64-linux-gnu`,
				`-l${vscodeSysroot}/lib/x86_64-linux-gnu`);
			break;
		case 'armhf':
			cmd.push(`-l${chromiumSysroot}/usr/lib/arm-linux-gnueabihf`,
				`-l${chromiumSysroot}/lib/arm-linux-gnueabihf`,
				`-l${vscodeSysroot}/usr/lib/arm-linux-gnueabihf`,
				`-l${vscodeSysroot}/lib/arm-linux-gnueabihf`);
			break;
		case 'arm64':
			cmd.push(`-l${chromiumSysroot}/usr/lib/aarch64-linux-gnu`,
				`-l${chromiumSysroot}/lib/aarch64-linux-gnu`,
				`-l${vscodeSysroot}/usr/lib/aarch64-linux-gnu`,
				`-l${vscodeSysroot}/lib/aarch64-linux-gnu`);
			break;
	}
	cmd.push(`-l${chromiumSysroot}/usr/lib`);
	cmd.push(`-l${path.dirname(path.resolve(binaryPath))}`);
	cmd.push(`-L${vscodeSysroot}/debian/libxkbfile1/DEBIAN/shlibs`);
	cmd.push('-O', '-e', path.resolve(binaryPath));

	const dpkgShlibdepsResult = spawnSync('perl', cmd, { cwd: chromiumSysroot });
	if (dpkgShlibdepsResult.status !== 0) {
		throw new Error(`dpkg-shlibdeps failed with exit code ${dpkgShlibdepsResult.status}. stderr:\n${dpkgShlibdepsResult.stderr} `);
	}

	const shlibsDependsPrefix = 'shlibs:Depends=';
	const requiresList = dpkgShlibdepsResult.stdout.toString('utf-8').trimEnd().split('\n');
	let depsStr = '';
	for (const line of requiresList) {
		if (line.startsWith(shlibsDependsPrefix)) {
			depsStr = line.substring(shlibsDependsPrefix.length);
		}
	}
	// Refs https://chromium-review.googlesource.com/c/chromium/src/+/3572926
	// Chromium depends on libgcc_s, is from the package libgcc1.  However, in
	// Bullseye, the package was renamed to libgcc-s1.  To avoid adding a dep
	// on the newer package, this hack skips the dep.  This is safe because
	// libgcc-s1 is a dependency of libc6.  This hack can be removed once
	// support for Debian Buster and Ubuntu Bionic are dropped.
	//
	// Remove kerberos native module related dependencies as the versions
	// computed from sysroot will not satisfy the minimum supported distros
	// Refs https://github.com/microsoft/vscode/issues/188881.
	// TODO(deepak1556): remove this workaround in favor of computing the
	// versions from build container for native modules.
	const filteredDeps = depsStr.split(', ').filter(dependency => {
		return !dependency.startsWith('libgcc-s1');
	}).sort();
	const requires = new Set(filteredDeps);
	return requires;
}
