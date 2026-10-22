/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { constants, existsSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { additionalDeps } from './dep-lists.ts';
import type { DebianArchString } from './types.ts';

// Vendored dpkg-shlibdeps.pl (alpha.35, vendor B1). The script is
// vendored in this repo at vendor/dpkg-shlibdeps.pl next to this
// file — it is NOT downloaded at build time. The download path was
// removed after the GitHub contents API rate-limited (HTTP 429) all
// 5 attempts from the CI runner in the alpha.34 run (SIG-B34-01);
// the earlier alpha.33 download from the raw host hit the same
// limit. The vendored file is validated on every build exactly
// like a downloaded one was: validateDpkgShlibdeps() below checks
// the size floor, the perl shebang and the content marker, and
// verifies the pinned SHA-256. See vendor/README.md.
const DPKG_SHLIBDEPS_SHA256 = '71b61bee790bf06797c901334f60b916c41f8346f9f8c333f9fa378d7e3b05bd';
// ^ SHA-256 of the vendored dpkg-shlibdeps.pl in vendor/ next to
// this file (alpha.35 vendor B1), byte-identical to
// dpkg-shlibdeps.pl at the Chromium pin in cgmanifest.json
// (version 150.0.7871.250, commitHash
// f916f1b7136907af19d96b95b891533d091d932a; hash verified from two
// independent sources by lane B). When the cgmanifest Chromium
// registration moves, replace the vendored file AND update this
// pin in the same commit — see vendor/README.md.
const DPKG_SHLIBDEPS_MIN_SIZE = 4096; // real script: 31,983 bytes; captured HTTP 429 page: 313 bytes
const DPKG_SHLIBDEPS_VENDOR_PATH = path.join(import.meta.dirname, 'vendor', 'dpkg-shlibdeps.pl');

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

// alpha.35 (vendor B1): dpkg-shlibdeps.pl is vendored in this repo at
// vendor/dpkg-shlibdeps.pl next to this file — it is NOT downloaded.
// The contents API rate-limited (HTTP 429) all 5 attempts from the CI
// runner in the alpha.34 run (SIG-B34-01), so the download path was
// removed entirely. The vendored file is validated exactly like a
// downloaded one was: validateDpkgShlibdeps() above, including the
// pinned SHA-256, runs on it on every build.
function loadVendoredDpkgShlibdeps(): string {
	if (!existsSync(DPKG_SHLIBDEPS_VENDOR_PATH)) {
		throw new Error(`Vendored dpkg-shlibdeps.pl not found at ${DPKG_SHLIBDEPS_VENDOR_PATH} — expected build/linux/debian/vendor/dpkg-shlibdeps.pl in the repository (alpha.35 vendor B1; there is no network fallback). Restore the vendored file and re-run.`);
	}
	const problem = validateDpkgShlibdeps(DPKG_SHLIBDEPS_VENDOR_PATH);
	if (problem) {
		throw new Error(`Vendored dpkg-shlibdeps.pl at ${DPKG_SHLIBDEPS_VENDOR_PATH} failed validation: ${problem}`);
	}
	return DPKG_SHLIBDEPS_VENDOR_PATH;
}

export function generatePackageDeps(files: string[], arch: DebianArchString, chromiumSysroot: string, vscodeSysroot: string): Set<string>[] {
	// DC-4: load and validate the vendored dpkg-shlibdeps.pl exactly once
	// here (the only caller chain is dependencies-generator.ts ->
	// generatePackageDeps) and pass the path down, instead of loading it
	// for every binary.
	const dpkgShlibdepsScriptLocation = loadVendoredDpkgShlibdeps();
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

	// dpkg-shlibdeps.pl was vendored and validated once by
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
	if (!depsStr) {
		throw new Error(`dpkg-shlibdeps produced no 'shlibs:Depends=' line for ${binaryPath}. stdout:\n${dpkgShlibdepsResult.stdout}`);
	}
	const filteredDeps = depsStr.split(', ').filter(dependency => {
		return !dependency.startsWith('libgcc-s1');
	}).sort();
	const requires = new Set(filteredDeps);
	return requires;
}
