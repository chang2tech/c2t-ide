/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { spawnSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { getChromiumSysroot, getVSCodeSysroot } from './debian/install-sysroot.ts';
import { generatePackageDeps as generatePackageDepsDebian } from './debian/calculate-deps.ts';
import { generatePackageDeps as generatePackageDepsRpm } from './rpm/calculate-deps.ts';
import { referenceGeneratedDepsByArch as debianGeneratedDeps } from './debian/dep-lists.ts';
import { referenceGeneratedDepsByArch as rpmGeneratedDeps } from './rpm/dep-lists.ts';
import { type DebianArchString, isDebianArchString } from './debian/types.ts';
import { isRpmArchString, type RpmArchString } from './rpm/types.ts';
import product from '../../product.json' with { type: 'json' };

// A flag that can easily be toggled.
// Make sure to compile the build directory after toggling the value.
// If false, we warn about new dependencies if they show up
// while running the prepare package tasks for a release.
// If true, we fail the build if there are new dependencies found during that task.
// The reference dependencies, which one has to update when the new dependencies
// are valid, are in dep-lists.ts
const FAIL_BUILD_FOR_NEW_DEPENDENCIES: boolean = true;

// Based on https://source.chromium.org/chromium/chromium/src/+/refs/tags/150.0.7871.250:chrome/installer/linux/BUILD.gn;l=64-80
// and the Linux Archive build
// Shared library dependencies that we already bundle.
const bundledDeps = [
	'libEGL.so',
	'libGLESv2.so',
	'libvulkan.so.1',
	'libvk_swiftshader.so',
	'libffmpeg.so',
];

export async function getDependencies(packageType: 'deb' | 'rpm', buildDir: string, applicationName: string, arch: string): Promise<string[]> {
	if (packageType === 'deb') {
		if (!isDebianArchString(arch)) {
			throw new Error('Invalid Debian arch string ' + arch);
		}
	}
	if (packageType === 'rpm' && !isRpmArchString(arch)) {
		throw new Error('Invalid RPM arch string ' + arch);
	}

	// Get the files for which we want to find dependencies.
	// Native modules are unpacked next to the ASAR archive in `node_modules.asar.unpacked`.
	const nativeModulesPath = path.join(buildDir, 'resources', 'app', 'node_modules.asar.unpacked');
	// Fail loudly if the unpacked native-modules tree is missing. Returning an
	// empty dependency list here previously produced a package with an empty
	// `Depends:` field that still built and uploaded as if it were valid
	// (BUILD-QA B-W3-02), and it also skipped the FAIL_BUILD_FOR_NEW_DEPENDENCIES
	// gate below, which only runs on the non-empty path.
	if (!fs.existsSync(nativeModulesPath)) {
		throw new Error(`getDependencies: native modules path does not exist: '${nativeModulesPath}'. The packaged app tree '${buildDir}' is missing or incomplete; refusing to generate package dependencies from it.`);
	}
	const findResult = spawnSync('find', [nativeModulesPath, '-name', '*.node']);
	if (findResult.error || findResult.status !== 0) {
		const detail = findResult.error ? String(findResult.error) : (findResult.stderr?.toString() ?? `exit status ${findResult.status}`);
		throw new Error(`getDependencies: 'find' failed for native modules under '${nativeModulesPath}': ${detail}`);
	}

	const appPath = path.join(buildDir, applicationName);
	// Add the native modules
	const nativeModuleFiles = findResult.stdout.toString().split('\n').map(line => line.trim()).filter(line => line.length > 0);
	if (nativeModuleFiles.length === 0) {
		throw new Error(`getDependencies: no '*.node' files found under '${nativeModulesPath}'. The packaged app tree '${buildDir}' looks incomplete; refusing to generate package dependencies from it.`);
	}
	const files = [...nativeModuleFiles];
	// Add the tunnel binary.
	files.push(path.join(buildDir, 'bin', product.tunnelApplicationName));
	// Add the main executable.
	files.push(appPath);
	// Add chrome sandbox and crashpad handler.
	files.push(path.join(buildDir, 'chrome-sandbox'));
	files.push(path.join(buildDir, 'chrome_crashpad_handler'));

	// Generate the dependencies.
	let dependencies: Set<string>[];
	if (packageType === 'deb') {
		const chromiumSysroot = await getChromiumSysroot(arch as DebianArchString);
		const vscodeSysroot = await getVSCodeSysroot(arch as DebianArchString);
		dependencies = generatePackageDepsDebian(files, arch as DebianArchString, chromiumSysroot, vscodeSysroot);
	} else {
		dependencies = generatePackageDepsRpm(files);
	}

	// Merge all the dependencies.
	const mergedDependencies = mergePackageDeps(dependencies);

	// Exclude bundled dependencies and sort
	const sortedDependencies: string[] = Array.from(mergedDependencies).filter(dependency => {
		return !bundledDeps.some(bundledDep => dependency.startsWith(bundledDep));
	}).sort();

	const referenceGeneratedDeps = packageType === 'deb' ?
		debianGeneratedDeps[arch as DebianArchString] :
		rpmGeneratedDeps[arch as RpmArchString];
	if (JSON.stringify(sortedDependencies) !== JSON.stringify(referenceGeneratedDeps)) {
		const failMessage = 'The dependencies list has changed.'
			+ '\nOld:\n' + referenceGeneratedDeps.join('\n')
			+ '\nNew:\n' + sortedDependencies.join('\n');
		if (FAIL_BUILD_FOR_NEW_DEPENDENCIES) {
			throw new Error(failMessage);
		} else {
			console.warn(failMessage);
		}
	}

	return sortedDependencies;
}


// Based on https://source.chromium.org/chromium/chromium/src/+/main:chrome/installer/linux/rpm/merge_package_deps.py.
function mergePackageDeps(inputDeps: Set<string>[]): Set<string> {
	const requires = new Set<string>();
	for (const depSet of inputDeps) {
		for (const dep of depSet) {
			const trimmedDependency = dep.trim();
			if (trimmedDependency.length && !trimmedDependency.startsWith('#')) {
				requires.add(trimmedDependency);
			}
		}
	}
	return requires;
}
