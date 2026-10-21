/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { gulp, replace, rename } from './lib/gulp/facade.ts';
import es from 'event-stream';
import vfs from 'vinyl-fs';
import File from 'vinyl';
import * as zlib from 'zlib';
import { rimraf } from './lib/util.ts';
import { getVersion } from './lib/getVersion.ts';
import { assertNoPlaceholders, findUnreplacedPlaceholders } from './lib/assertNoPlaceholders.ts';
import * as task from './lib/gulp/task.ts';
import packageJson from '../package.json' with { type: 'json' };
import product from '../product.json' with { type: 'json' };
import { getDependencies } from './linux/dependencies-generator.ts';
import { recommendedDeps as debianRecommendedDependencies } from './linux/debian/dep-lists.ts';
import { recommendedDeps as rpmRecommendedDependencies } from './linux/rpm/dep-lists.ts';
import * as path from 'path';
import * as cp from 'child_process';
import { promisify } from 'util';
import fs from 'fs';

const exec = promisify(cp.exec);
const root = path.dirname(import.meta.dirname);
const commit = getVersion(root);
const linuxDesktopName = product.linuxDesktopName;

// Package revision (BUILD-QA B-W3-09): this used to be a module-level
// `const linuxPackageRevision = Math.floor(new Date().getTime() / 1000)`,
// evaluated once when gulp loaded this file. The stamped version then
// depended on module-load time instead of on when the packaging task
// actually ran, and separate prepare-deb / prepare-rpm processes started
// minutes apart by CI stamped different revisions for the same source,
// so the resulting package version was not reproducible. The revision is
// now resolved lazily, each time a prepare task body runs:
//   1. `LINUX_PACKAGE_REVISION` — explicit override, when set;
//   2. `SOURCE_DATE_EPOCH` — the reproducible-builds standard
//      (reproducible-builds.org/docs/source-date-epoch), when set;
//   3. otherwise the current epoch second at task-run time.
// The fork workflow (.github/workflows/build-ide-code.yml) sets neither
// variable today (checked 2026-10-21: no SOURCE_DATE_EPOCH /
// LINUX_PACKAGE_REVISION anywhere in it), so fallback (3) applies in CI
// until a step exports one of them; this fix does not change the
// workflow. A set-but-invalid value (not a non-negative integer number
// of seconds) fails the task instead of stamping a garbled version. The
// final formats are unchanged: deb version is
// `packageJson.version + '-' + revision` and the rpm RELEASE is the
// revision on its own.
function getLinuxPackageRevision(): number {
	for (const envName of ['LINUX_PACKAGE_REVISION', 'SOURCE_DATE_EPOCH'] as const) {
		const raw = process.env[envName];
		if (raw === undefined) {
			continue;
		}
		const parsed = Number(raw);
		if (raw.trim() === '' || !Number.isInteger(parsed) || parsed < 0) {
			throw new Error(`getLinuxPackageRevision: ${envName} must be a non-negative integer (seconds since the epoch), got '${raw}'.`);
		}
		return parsed;
	}
	return Math.floor(new Date().getTime() / 1000);
}

// Installed-Size accounting (BUILD-QA B-W3-09): Debian Policy 5.6.20
// defines Installed-Size (unit: KiB) as the accumulated size of each
// regular file and symlink rounded to 1 KiB units, plus a baseline of
// 1 KiB for any other filesystem object (directories included).
// prepare-deb therefore counts PER FILE through
// `installedSizeKiBForFile` below, applied to every payload stream that
// lands under usr/ in the staging tree. The previous counter summed raw
// bytes over the `code` stream only, rounded once at the end and added
// 4096 bytes per directory — it both missed the non-`code` payload
// (desktop files, appdata, mime, icon, completions, doc files) and
// diverged from the per-file KiB definition above. The DEBIAN control
// area is not counted: Installed-Size covers the files the package
// installs, and the control file cannot count itself.
function installedSizeKiBForFile(f: { isDirectory(): boolean; contents: Buffer | null }): number {
	if (f.isDirectory()) {
		return 1;
	}
	if (!f.contents) {
		return 1;
	}
	return Math.ceil(f.contents.length / 1024);
}

// Preflight for external tools (BUILD-QA B-W3-07, hardened W27 (d)
// item 3 / W39): the deb path shells out
// to tools that are not part of Node. Through getDependencies, prepare-deb
// reaches `curl` (build/linux/debian/calculate-deps.ts,
// build/linux/debian/install-sysroot.ts), `perl`
// (build/linux/debian/calculate-deps.ts), `find`
// (build/linux/dependencies-generator.ts) and `tar`
// (build/linux/debian/install-sysroot.ts); build-deb calls `chmod`,
// `mkdir`, `fakeroot`, `dpkg-deb` and `grep` directly below. Without a
// preflight, a missing tool only fails late, via an opaque shell error,
// after staging work has already run. Assert presence only — nothing is
// installed here. Fail-fast for BOTH stages from prepare-deb:
// prepareDebPackage asserts the prepare list AND the build list at its
// head, so a missing build tool (e.g. `fakeroot` — proven missing on a
// dev machine by W8) fails before any staging/dependency work, not only
// after prepare has run to completion when build-deb starts. The error
// for that early check names the build-deb stage the tool belongs to and
// notes it was checked early in prepare-deb (see `checkedEarlyIn` below).
// buildDebPackage keeps its own identical build-list assert at its head
// as a second layer, so running build-deb on its own still self-checks.
const debPrepareTools = ['curl', 'perl', 'find', 'tar'] as const;
const debBuildTools = ['fakeroot', 'dpkg-deb', 'chmod', 'mkdir', 'grep'] as const;

function assertDebTools(stage: 'prepare-deb' | 'build-deb', tools: readonly string[], checkedEarlyIn?: 'prepare-deb'): void {
	const pathDirs = (process.env.PATH ?? '').split(path.delimiter).filter(dir => dir.length > 0);
	const missing = tools.filter(tool => !pathDirs.some(dir => {
		try {
			fs.accessSync(path.join(dir, tool), fs.constants.X_OK);
			return true;
		} catch {
			return false;
		}
	}));
	if (missing.length > 0) {
		const earlyNote = checkedEarlyIn && checkedEarlyIn !== stage ? ` (checked early in ${checkedEarlyIn}: this tool belongs to the ${stage} stage, failing fast in ${checkedEarlyIn} before any staging work runs)` : '';
		throw new Error(`${stage}: required external tool(s) not found in PATH: ${missing.join(', ')}${earlyNote} — install the missing tool(s) (e.g. 'sudo apt install fakeroot dpkg-dev curl perl') and re-run this task.`);
	}
}

function getDebPackageArch(arch: string): string {
	switch (arch) {
		case 'x64': return 'amd64';
		case 'armhf': return 'armhf';
		case 'arm64': return 'arm64';
		default: throw new Error(`Unknown arch: ${arch}`);
	}
}

// Network dependency (W3-08): prepare-deb reaches the network through
// getDependencies -> build/linux/debian/install-sysroot.ts and
// build/linux/debian/calculate-deps.ts. The egress hosts are:
//   - api.github.com — VS Code sysroot release metadata + asset
//     (Microsoft/vscode-linux-build-agent); the Authorization header is
//     attached only when GITHUB_TOKEN is set, otherwise the calls are
//     anonymous and hit the much lower GitHub rate limit.
//   - raw.githubusercontent.com — Chromium sysroots.json (electron
//     repo) and dpkg-shlibdeps.pl (chromium repo), both via curl.
//   - msftelectronbuild.z5.web.core.windows.net — Chromium sysroot
//     tarball hosting.
// A machine without egress to these hosts will FAIL in prepare-deb;
// each download site also logs its URL in the debian files above.
function prepareDebPackage(arch: string) {
	// Paths are anchored to `root` (BUILD-QA B-W3-11), not the process cwd:
	// resolved from the repo root these give exactly the same locations as
	// the previous relative forms, but the task now stages into the same
	// tree no matter which directory gulp was invoked from.
	const binaryDir = path.join(root, '..', 'VSCode-linux-' + arch);
	const debArch = getDebPackageArch(arch);
	const destination = path.join(root, '.build/linux/deb/' + debArch + '/' + product.applicationName + '-' + debArch);

	return async function () {
		console.log(`[prepare-deb] NETWORK DEPENDENCY (W3-08): this task downloads from api.github.com (VS Code sysroot release + asset; GITHUB_TOKEN used when set, anonymous otherwise), raw.githubusercontent.com (Chromium sysroots.json + dpkg-shlibdeps.pl via curl) and msftelectronbuild.z5.web.core.windows.net (Chromium sysroot tarball) — see build/linux/debian/install-sysroot.ts and build/linux/debian/calculate-deps.ts. No egress to these hosts will fail this task.`);
		assertDebTools('prepare-deb', debPrepareTools);
		// Fail-fast for the build stage too (W27 (d) item 3 / W39): check
		// the build-deb tools now, at the head of prepare-deb, instead of
		// only when build-deb starts after all of prepare has run. The
		// stage argument stays 'build-deb' (and `checkedEarlyIn` notes the
		// early check) so the error names the stage the missing tool
		// belongs to. build-deb keeps its own assert as a second layer.
		assertDebTools('build-deb', debBuildTools, 'prepare-deb');
		// Pre-flight: the payload source must exist and look complete BEFORE we
		// spend time generating dependencies or copying. `gulp.src` below uses a
		// non-singular glob ('/**/*'), which ends silently on zero matches, so
		// a missing tree would otherwise produce a staging dir without payload
		// that still packages into a valid-looking .deb (BUILD-QA B-W3-02).
		const appBinaryPath = path.join(binaryDir, product.applicationName);
		if (!fs.existsSync(binaryDir)) {
			throw new Error(`prepare-deb: packaged app directory not found: '${binaryDir}' — run the vscode-linux-${arch} packaging task first.`);
		}
		if (!fs.existsSync(appBinaryPath)) {
			throw new Error(`prepare-deb: main binary not found: '${appBinaryPath}' — the packaged app tree in '${binaryDir}' is incomplete.`);
		}
		try {
			fs.accessSync(appBinaryPath, fs.constants.X_OK);
		} catch {
			throw new Error(`prepare-deb: main binary is not executable: '${appBinaryPath}'.`);
		}
		if (!fs.existsSync(path.join(binaryDir, 'resources', 'app'))) {
			throw new Error(`prepare-deb: '${path.join(binaryDir, 'resources', 'app')}' not found — the packaged app tree in '${binaryDir}' is incomplete.`);
		}
		const dependencies = await getDependencies('deb', binaryDir, product.applicationName, debArch);
		if (dependencies.length === 0) {
			throw new Error(`prepare-deb: getDependencies returned an empty dependency list for '${debArch}' — refusing to write a DEBIAN/control with an empty Depends field.`);
		}

		// Installed-Size counting (BUILD-QA B-W3-09): every payload
		// stream staged under usr/ is passed through `tapPayloadStream`,
		// which adds each file's KiB contribution (see
		// `installedSizeKiBForFile`) to `installedSizeKiB` as it flows
		// past and records a promise that resolves when that stream
		// ends. The DEBIAN/control generation below waits for all of
		// those promises before reading the total, so the value written
		// covers the whole payload — not just whichever streams happened
		// to finish first — regardless of stream completion order.
		let installedSizeKiB = 0;
		const payloadStreamEnds: Array<Promise<void>> = [];
		function tapPayloadStream(stream: NodeJS.ReadWriteStream): NodeJS.ReadWriteStream {
			let resolveEnd!: () => void;
			const ended = new Promise<void>(resolve => { resolveEnd = resolve; });
			payloadStreamEnds.push(ended);
			const counted = stream.pipe(es.through(
				function (f) { installedSizeKiB += installedSizeKiBForFile(f); this.emit('data', f); },
				function () { resolveEnd(); this.emit('end'); }
			));
			counted.on('error', () => resolveEnd());
			return counted;
		}

		const desktop = gulp.src(path.join(root, 'resources/linux/code.desktop'), { base: root })
			.pipe(rename(`usr/share/applications/${linuxDesktopName}.desktop`));

		const desktopUrlHandler = gulp.src(path.join(root, 'resources/linux/code-url-handler.desktop'), { base: root })
			.pipe(rename(`usr/share/applications/${linuxDesktopName}.UrlHandler.desktop`));

		const desktops = es.merge(desktop, desktopUrlHandler)
			.pipe(replace('@@NAME_LONG@@', product.nameLong))
			.pipe(replace('@@NAME_SHORT@@', product.nameShort))
			.pipe(replace('@@DESKTOP_NAME@@', linuxDesktopName))
			.pipe(replace('@@NAME@@', product.applicationName))
			.pipe(replace('@@EXEC@@', `/usr/share/${product.applicationName}/${product.applicationName}`))
			.pipe(replace('@@ICON@@', product.linuxIconName))
			.pipe(replace('@@URLPROTOCOL@@', product.urlProtocol))
			.pipe(assertNoPlaceholders('deb desktops'));

		const appdata = gulp.src(path.join(root, 'resources/linux/code.appdata.xml'), { base: root })
			.pipe(replace('@@NAME_LONG@@', product.nameLong))
			.pipe(replace('@@NAME@@', linuxDesktopName))
			.pipe(replace('@@LICENSE@@', product.licenseName))
			.pipe(assertNoPlaceholders('deb appdata'))
			.pipe(rename(`usr/share/appdata/${linuxDesktopName}.appdata.xml`));

		const workspaceMime = gulp.src(path.join(root, 'resources/linux/code-workspace.xml'), { base: root })
			.pipe(replace('@@NAME_LONG@@', product.nameLong))
			.pipe(replace('@@NAME@@', product.applicationName))
			.pipe(assertNoPlaceholders('deb workspace mime'))
			.pipe(rename('usr/share/mime/packages/' + product.applicationName + '-workspace.xml'));

		const icon = gulp.src(path.join(root, 'resources/linux/code.png'), { base: root })
			.pipe(rename('usr/share/pixmaps/' + product.linuxIconName + '.png'));

		const bash_completion = gulp.src(path.join(root, 'resources/completions/bash/code'))
			.pipe(replace('@@APPNAME@@', product.applicationName))
			.pipe(assertNoPlaceholders('deb bash completion'))
			.pipe(rename('usr/share/bash-completion/completions/' + product.applicationName));

		const zsh_completion = gulp.src(path.join(root, 'resources/completions/zsh/_code'))
			.pipe(replace('@@APPNAME@@', product.applicationName))
			.pipe(assertNoPlaceholders('deb zsh completion'))
			.pipe(rename('usr/share/zsh/vendor-completions/_' + product.applicationName));

		const code = gulp.src(binaryDir + '/**/*', { base: binaryDir })
			.pipe(rename(function (p) { p.dirname = 'usr/share/' + product.applicationName + '/' + p.dirname; }));

		// Single version string for this package: DEBIAN/control
		// (@@VERSION@@ below) and the debian changelog heading both use
		// it, so the two can never disagree (BUILD-QA B-W3-13).
		const debVersion = packageJson.version + '-' + getLinuxPackageRevision();

		// The `code` payload goes through the same Installed-Size tap
		// as every other payload stream (BUILD-QA B-W3-09); the control
		// stream below only consumes the tapped stream's end signal to
		// generate DEBIAN/control, it no longer counts anything itself.
		const countedCode = tapPayloadStream(code);
		const control = countedCode.pipe(es.through(
			function () { },
			async function () {
				const that = this;
				// Generate the control file only after ALL payload
				// streams (code + desktop/appdata/mime/icon/completions/
				// doc streams, tapped further below) have ended and
				// been counted, so @@INSTALLEDSIZE@@ is the full KiB
				// total for the staged payload.
				await Promise.all(payloadStreamEnds);
				gulp.src(path.join(root, 'resources/linux/debian/control.template'), { base: root })
					.pipe(replace('@@NAME@@', product.applicationName))
					.pipe(replace('@@VERSION@@', debVersion))
					.pipe(replace('@@ARCHITECTURE@@', debArch))
					.pipe(replace('@@DEPENDS@@', dependencies.join(', ')))
					.pipe(replace('@@RECOMMENDS@@', debianRecommendedDependencies.join(', ')))
					.pipe(replace('@@INSTALLEDSIZE@@', installedSizeKiB.toString()))
					.pipe(assertNoPlaceholders('deb control'))
					.pipe(rename('DEBIAN/control'))
					.pipe(es.through(function (f) { that.emit('data', f); }, function () { that.emit('end'); }));
			}));

		const prerm = gulp.src(path.join(root, 'resources/linux/debian/prerm.template'), { base: root })
			.pipe(replace('@@NAME@@', product.applicationName))
			.pipe(assertNoPlaceholders('deb prerm'))
			.pipe(rename('DEBIAN/prerm'));

		const postrm = gulp.src(path.join(root, 'resources/linux/debian/postrm.template'), { base: root })
			.pipe(replace('@@NAME@@', product.applicationName))
			.pipe(assertNoPlaceholders('deb postrm'))
			.pipe(rename('DEBIAN/postrm'));

		const postinst = gulp.src(path.join(root, 'resources/linux/debian/postinst.template'), { base: root })
			.pipe(replace('@@NAME@@', product.applicationName))
			.pipe(replace('@@ARCHITECTURE@@', debArch))
			.pipe(assertNoPlaceholders('deb postinst'))
			.pipe(rename('DEBIAN/postinst'));

		// Debian doc files (BUILD-QA B-W3-13): a .deb without
		// usr/share/doc/<pkg>/ draws lintian warnings for the missing
		// changelog and copyright. The copyright file is the repo's own
		// LICENSE.txt verbatim — it already carries the project's
		// copyright line and license terms, so nothing is added or
		// reworded here.
		const copyright = gulp.src(path.join(root, 'LICENSE.txt'), { base: root })
			.pipe(rename(`usr/share/doc/${product.applicationName}/copyright`));

		// Minimal debian changelog, gzipped: one entry for the current
		// package version (debVersion — the same string written into
		// DEBIAN/control). No release history is invented; the single
		// change line states only that this is the initial release.
		// The trailer names the maintainer exactly as DEBIAN/control
		// does ('Maintainer: IDE Code' in
		// resources/linux/debian/control.template) — the repo records
		// no maintainer e-mail address anywhere, so none is fabricated
		// here either.
		const changelogDate = new Date().toUTCString().replace('GMT', '+0000');
		const changelogText = `${product.applicationName} (${debVersion}) unstable; urgency=medium\n\n  * Initial release of ${product.nameLong}.\n\n -- IDE Code  ${changelogDate}\n`;
		const changelog = es.readArray([new File({
			path: `usr/share/doc/${product.applicationName}/changelog.gz`,
			contents: zlib.gzipSync(Buffer.from(changelogText, 'utf8'))
		})]);

		// Every remaining payload stream is tapped for Installed-Size
		// before merging (BUILD-QA B-W3-09): desktop files, appdata,
		// mime, icon, shell completions and the usr/share/doc files are
		// part of the installed payload just like `code` above. Only
		// the DEBIAN control-area streams (control/postinst/postrm/
		// prerm) stay untapped — they are not installed files.
		const countedDesktops = tapPayloadStream(desktops);
		const countedAppdata = tapPayloadStream(appdata);
		const countedWorkspaceMime = tapPayloadStream(workspaceMime);
		const countedIcon = tapPayloadStream(icon);
		const countedBashCompletion = tapPayloadStream(bash_completion);
		const countedZshCompletion = tapPayloadStream(zsh_completion);
		const countedCopyright = tapPayloadStream(copyright);
		const countedChangelog = tapPayloadStream(changelog);

		const all = es.merge(control, postinst, postrm, prerm, countedDesktops, countedAppdata, countedWorkspaceMime, countedIcon, countedBashCompletion, countedZshCompletion, countedCopyright, countedChangelog, countedCode);

		return all.pipe(vfs.dest(destination));
	};
}

function buildDebPackage(arch: string) {
	const debArch = getDebPackageArch(arch);
	// Anchored to `root` (BUILD-QA B-W3-11): the exec calls below pass this
	// as their cwd and derive the staging/deb paths from it, so anchoring
	// this one value anchors the whole build-deb path.
	const cwd = path.join(root, `.build/linux/deb/${debArch}`);

	return async () => {
		assertDebTools('build-deb', debBuildTools);
		// Verify the staging tree BEFORE packaging (BUILD-QA B-W3-02):
		// dpkg-deb only requires a syntactically valid DEBIAN/control, so a
		// staging dir with an empty Depends or a missing payload would
		// otherwise be packed into a .deb that looks valid. Fail the build
		// here instead of shipping a silently wrong package.
		const stagingDir = path.join(cwd, `${product.applicationName}-${debArch}`);
		const controlPath = path.join(stagingDir, 'DEBIAN', 'control');
		if (!fs.existsSync(controlPath)) {
			throw new Error(`build-deb: staging control file not found: '${controlPath}' — run vscode-linux-${arch}-prepare-deb first.`);
		}
		const controlContents = fs.readFileSync(controlPath, 'utf8');
		const dependsLine = controlContents.split('\n').find(line => line.startsWith('Depends:'));
		if (!dependsLine || dependsLine.substring('Depends:'.length).trim().length === 0) {
			throw new Error(`build-deb: '${controlPath}' has an empty or missing Depends field — refusing to package. The dependency generation step must have failed silently; re-run prepare-deb and check its output.`);
		}
		const stagedBinary = path.join(stagingDir, 'usr', 'share', product.applicationName, product.applicationName);
		if (!fs.existsSync(stagedBinary)) {
			throw new Error(`build-deb: payload binary missing from staging: '${stagedBinary}' — refusing to package an application-less .deb.`);
		}
		try {
			fs.accessSync(stagedBinary, fs.constants.X_OK);
		} catch {
			throw new Error(`build-deb: payload binary in staging is not executable: '${stagedBinary}'.`);
		}
		// Executable-bit guard for the remaining payload entrypoints
		// (BUILD-QA B-W3-05): the main binary above is asserted by the
		// B-W3-02 verify block, but nothing else in the chain guarantees
		// +x for the CLI script, chrome-sandbox or the tunnel binary —
		// vinyl-fs preserves source modes by design, yet no step checks
		// them, so a mode lost anywhere upstream would ship a .deb whose
		// entrypoints cannot execute. Fail here, before packaging.
		const stagedEntrypoints = [
			path.join(stagingDir, 'usr', 'share', product.applicationName, 'bin', product.applicationName),
			path.join(stagingDir, 'usr', 'share', product.applicationName, 'chrome-sandbox'),
			path.join(stagingDir, 'usr', 'share', product.applicationName, 'bin', product.tunnelApplicationName),
		];
		for (const entrypoint of stagedEntrypoints) {
			if (!fs.existsSync(entrypoint)) {
				throw new Error(`build-deb: payload entrypoint missing from staging: '${entrypoint}' — refusing to package.`);
			}
			try {
				fs.accessSync(entrypoint, fs.constants.X_OK);
			} catch {
				throw new Error(`build-deb: payload entrypoint in staging is not executable: '${entrypoint}'.`);
			}
		}
		const stagedResourcesApp = path.join(stagingDir, 'usr', 'share', product.applicationName, 'resources', 'app');
		if (!fs.existsSync(stagedResourcesApp) || fs.readdirSync(stagedResourcesApp).length === 0) {
			throw new Error(`build-deb: payload directory missing or empty in staging: '${stagedResourcesApp}' — refusing to package.`);
		}
		// Native-binding guard for the Linux payload (BUILD-QA A4-P1):
		// packageTask asar-unpacks every '**/*.node' (createAsar call in
		// build/gulpfile.vscode.ts), so a rebuilt binding reaches the
		// packaged app as a real file under
		// resources/app/node_modules.asar.unpacked/<pkg>/build/Release/
		// <target>.node, and prepare-deb copies that tree verbatim under
		// usr/share/<app>/ in this staging dir. If the CI native rebuild
		// silently produced no binding (or one was stripped afterwards),
		// dpkg-deb would still pack a valid-looking .deb whose storage,
		// logging, keyboard-layout, proxy-auth or watchdog native is broken
		// at runtime — fail here instead, naming the package and the path.
		const stagedNativeBindings: ReadonlyArray<{ packageName: string; stagedPath: string }> = [
			{ packageName: '@vscode/sqlite3', stagedPath: path.join(stagedResourcesApp, 'node_modules.asar.unpacked', '@vscode/sqlite3', 'build', 'Release', 'vscode-sqlite3.node') },
			{ packageName: '@vscode/spdlog', stagedPath: path.join(stagedResourcesApp, 'node_modules.asar.unpacked', '@vscode/spdlog', 'build', 'Release', 'spdlog.node') },
			{ packageName: 'native-keymap', stagedPath: path.join(stagedResourcesApp, 'node_modules.asar.unpacked', 'native-keymap', 'build', 'Release', 'keymapping.node') },
			{ packageName: 'kerberos', stagedPath: path.join(stagedResourcesApp, 'node_modules.asar.unpacked', 'kerberos', 'build', 'Release', 'kerberos.node') },
			{ packageName: '@vscode/native-watchdog', stagedPath: path.join(stagedResourcesApp, 'node_modules.asar.unpacked', '@vscode/native-watchdog', 'build', 'Release', 'watchdog.node') },
		];
		for (const binding of stagedNativeBindings) {
			if (!fs.existsSync(binding.stagedPath)) {
				throw new Error(`build-deb: native binding missing from staging for package '${binding.packageName}': '${binding.stagedPath}' — refusing to package. The Linux native rebuild step must produce this .node file before packaging.`);
			}
			// Hardening (BUILD-QA W27 P3/d): existence alone is not
			// enough — a 0-byte .node (e.g. a native rebuild that died
			// mid-write) passes existsSync but fails only later, at
			// runtime on dlopen. Require a non-empty file, and name the
			// actual size in the throw so the empty-binding case is
			// distinguishable from the missing-binding case above.
			const bindingSize = fs.statSync(binding.stagedPath).size;
			if (bindingSize === 0) {
				throw new Error(`build-deb: native binding is empty (actual size: ${bindingSize} bytes) in staging for package '${binding.packageName}': '${binding.stagedPath}' — refusing to package. The Linux native rebuild step must produce a non-empty .node file before packaging.`);
			}
		}

		await exec(`chmod 755 ${product.applicationName}-${debArch}/DEBIAN/postinst ${product.applicationName}-${debArch}/DEBIAN/prerm ${product.applicationName}-${debArch}/DEBIAN/postrm`, { cwd });
		await exec('mkdir -p deb', { cwd });
		await exec(`fakeroot dpkg-deb -Zxz -b ${product.applicationName}-${debArch} deb`, { cwd });

		// Verify the produced artifact itself, parsed by dpkg-deb (not by our
		// own string handling): exactly one .deb, non-empty Depends, a
		// well-formed Version (hardening BUILD-QA W27 P3/d, below), and the
		// payload present in the archive listing.
		const debDir = path.join(cwd, 'deb');
		const debFiles = fs.readdirSync(debDir).filter(file => file.endsWith('.deb'));
		if (debFiles.length !== 1) {
			throw new Error(`build-deb: expected exactly 1 .deb in '${debDir}' after packaging, found ${debFiles.length} (${debFiles.join(', ')}).`);
		}
		const debFile = debFiles[0];
		const { stdout: debDepends } = await exec(`dpkg-deb -f ${debFile} Depends`, { cwd: debDir });
		if (!debDepends.trim()) {
			throw new Error(`build-deb: packaged '${debFile}' has an empty Depends field according to dpkg-deb — refusing to accept this artifact.`);
		}
		// Hardening (BUILD-QA W27 P3/d): also verify the artifact's
		// Version field. prepare-deb stamps DEBIAN/control with
		// `debVersion = packageJson.version + '-' +
		// getLinuxPackageRevision()` (see prepareDebPackage), so a
		// well-formed artifact Version is exactly that shape: the
		// current product version as prefix, a '-' separator, and the
		// revision (a non-negative integer — the invariant
		// getLinuxPackageRevision enforces) as suffix. No concrete
		// version/revision number is hardcoded here. The revision is
		// matched by shape rather than by re-calling
		// getLinuxPackageRevision() for exact equality: build-deb runs
		// after prepare-deb, and with neither LINUX_PACKAGE_REVISION
		// nor SOURCE_DATE_EPOCH set the revision is an epoch second
		// resolved at prepare time, so an exact re-computation here
		// could legitimately differ and fail a good artifact. An
		// unreplaced '@@VERSION@@', an empty field, a wrong product
		// version or a missing/non-numeric revision all fail here.
		const { stdout: debVersionField } = await exec(`dpkg-deb -f ${debFile} Version`, { cwd: debDir });
		const artifactVersion = debVersionField.trim();
		const expectedVersionPrefix = packageJson.version + '-';
		const artifactRevision = artifactVersion.startsWith(expectedVersionPrefix) ? artifactVersion.substring(expectedVersionPrefix.length) : '';
		if (!artifactVersion || !artifactVersion.startsWith(expectedVersionPrefix) || !/^\d+$/.test(artifactRevision)) {
			throw new Error(`build-deb: packaged '${debFile}' has a missing or malformed Version field according to dpkg-deb: '${artifactVersion}' — expected '${expectedVersionPrefix}<revision>' (debVersion format from prepare-deb: packageJson.version + '-' + getLinuxPackageRevision()) — refusing to accept this artifact.`);
		}
		try {
			await exec(`dpkg-deb --contents ${debFile} | grep -q 'usr/share/${product.applicationName}/${product.applicationName}$'`, { cwd: debDir });
			await exec(`dpkg-deb --contents ${debFile} | grep -q 'usr/share/${product.applicationName}/resources/app/'`, { cwd: debDir });
		} catch {
			throw new Error(`build-deb: packaged '${debFile}' is missing the main binary or resources/app in its contents listing — refusing to accept this artifact.`);
		}
	};
}

function getRpmBuildPath(rpmArch: string): string {
	// Anchored to `root` (BUILD-QA W38, rpm counterpart of B-W3-11 for
	// deb): resolved from the repo root this gives exactly the same
	// location as the previous relative form, but prepare-rpm/build-rpm
	// stage into the same tree no matter which directory gulp was
	// invoked from.
	return path.join(root, '.build/linux/rpm/' + rpmArch + '/rpmbuild');
}

function getRpmPackageArch(arch: string): string {
	switch (arch) {
		case 'x64': return 'x86_64';
		case 'armhf': return 'armv7hl';
		case 'arm64': return 'aarch64';
		default: throw new Error(`Unknown arch: ${arch}`);
	}
}

// Preflight for external tools (BUILD-QA W66, rpm counterpart of
// B-W3-07 / W39 for deb and of the inline snap preflight from W57):
// the rpm path shells out to tools that are not part of Node. Through
// getDependencies, prepare-rpm reaches `find`
// (build/linux/dependencies-generator.ts, spawnSync('find', ...));
// build-rpm calls `mkdir`, `rpmbuild`, `cp` and `ls` (the last inside
// the `$(ls ...)` substitution of its copy command) directly in the
// exec calls of buildRpmPackage below. Without a preflight, a
// missing `rpmbuild` only failed late, via an opaque shell error from
// that exec, after prepare-rpm had already staged the whole tree.
// Assert presence only — nothing is installed here. Fail-fast for
// BOTH stages from prepare-rpm, mirroring W39 for deb:
// prepareRpmPackage asserts the prepare list AND the build list as
// its first statements, so a missing build tool fails before any
// dependency/staging work, not only after prepare has run to
// completion when build-rpm starts. The error for that early check
// names the build-rpm stage the tool belongs to and notes it was
// checked early in prepare-rpm (see `checkedEarlyIn` below).
// buildRpmPackage keeps its own identical build-list assert at its
// head as a second layer, so running build-rpm on its own still
// self-checks.
// This is a separate helper rather than a widening of
// assertDebTools: that helper's stage union only accepts
// 'prepare-deb' | 'build-deb' (the same reason the snap preflight in
// buildSnapPackage is inlined instead of routed through it, W57),
// and widening it would touch the deb zone for a non-deb concern.
// The PATH scan itself is identical to assertDebTools and to the
// snap preflight (fs.accessSync X_OK per PATH directory).
// Deliberately NOT asserted here, because the rpm code does not look
// them up through PATH: `/usr/lib/rpm/find-requires`
// (build/linux/rpm/calculate-deps.ts) is spawned by absolute path —
// its failure already throws there with its exit code and stderr,
// and a PATH scan could never find it — and the strip binary (the
// `STRIP` env value or `/usr/bin/strip`, see prepareRpmPackage) is
// only interpolated into the spec as `__strip` for rpmbuild to
// invoke, again not a PATH lookup by this file. Tools with no call
// site on the rpm path at all (e.g. `rpm2cpio`, `chmod` — the rpm
// exec sites are only the mkdir / rpmbuild / cp lines of
// buildRpmPackage) are likewise not asserted.
const rpmPrepareTools = ['find'] as const;
const rpmBuildTools = ['mkdir', 'rpmbuild', 'cp', 'ls'] as const;

function assertRpmTools(stage: 'prepare-rpm' | 'build-rpm', tools: readonly string[], checkedEarlyIn?: 'prepare-rpm'): void {
	const pathDirs = (process.env.PATH ?? '').split(path.delimiter).filter(dir => dir.length > 0);
	const missing = tools.filter(tool => !pathDirs.some(dir => {
		try {
			fs.accessSync(path.join(dir, tool), fs.constants.X_OK);
			return true;
		} catch {
			return false;
		}
	}));
	if (missing.length > 0) {
		const earlyNote = checkedEarlyIn && checkedEarlyIn !== stage ? ` (checked early in ${checkedEarlyIn}: this tool belongs to the ${stage} stage, failing fast in ${checkedEarlyIn} before any staging work runs)` : '';
		throw new Error(`${stage}: required external tool(s) not found in PATH: ${missing.join(', ')}${earlyNote} — install the missing tool(s) and re-run this task (rpmbuild is provided by the 'rpm' package on Debian/Ubuntu and by the 'rpm-build' package on Fedora/RHEL; find is in findutils and mkdir/cp/ls are in coreutils).`);
	}
}

function prepareRpmPackage(arch: string) {
	// Paths are anchored to `root` (BUILD-QA W38, rpm counterpart of
	// B-W3-11 for deb), not the process cwd: resolved from the repo root
	// these give exactly the same locations as the previous relative
	// forms, but the task now stages from/into the same tree no matter
	// which directory gulp was invoked from.
	const binaryDir = path.join(root, '..', 'VSCode-linux-' + arch);
	const rpmArch = getRpmPackageArch(arch);
	const stripBinary = process.env['STRIP'] ?? '/usr/bin/strip';

	return async function () {
		assertRpmTools('prepare-rpm', rpmPrepareTools);
		// Fail-fast for the build stage too (W66, mirroring W39 for
		// deb): check the build-rpm tools now, as the first statements
		// of prepare-rpm, instead of only when build-rpm starts after
		// all of prepare has run. The stage argument stays 'build-rpm'
		// (and `checkedEarlyIn` notes the early check) so the error
		// names the stage the missing tool belongs to. build-rpm keeps
		// its own assert as a second layer.
		assertRpmTools('build-rpm', rpmBuildTools, 'prepare-rpm');
		const dependencies = await getDependencies('rpm', binaryDir, product.applicationName, rpmArch);

		const desktop = gulp.src(path.join(root, 'resources/linux/code.desktop'), { base: root })
			.pipe(rename(`BUILD/usr/share/applications/${linuxDesktopName}.desktop`));

		const desktopUrlHandler = gulp.src(path.join(root, 'resources/linux/code-url-handler.desktop'), { base: root })
			.pipe(rename(`BUILD/usr/share/applications/${linuxDesktopName}.UrlHandler.desktop`));

		const desktops = es.merge(desktop, desktopUrlHandler)
			.pipe(replace('@@NAME_LONG@@', product.nameLong))
			.pipe(replace('@@NAME_SHORT@@', product.nameShort))
			.pipe(replace('@@DESKTOP_NAME@@', linuxDesktopName))
			.pipe(replace('@@NAME@@', product.applicationName))
			.pipe(replace('@@EXEC@@', `/usr/share/${product.applicationName}/${product.applicationName}`))
			.pipe(replace('@@ICON@@', product.linuxIconName))
			.pipe(replace('@@URLPROTOCOL@@', product.urlProtocol))
			.pipe(assertNoPlaceholders('rpm desktops'));

		const appdata = gulp.src(path.join(root, 'resources/linux/code.appdata.xml'), { base: root })
			.pipe(replace('@@NAME_LONG@@', product.nameLong))
			.pipe(replace('@@NAME@@', linuxDesktopName))
			.pipe(replace('@@LICENSE@@', product.licenseName))
			.pipe(assertNoPlaceholders('rpm appdata'))
			.pipe(rename(`BUILD/usr/share/appdata/${linuxDesktopName}.appdata.xml`));

		const workspaceMime = gulp.src(path.join(root, 'resources/linux/code-workspace.xml'), { base: root })
			.pipe(replace('@@NAME_LONG@@', product.nameLong))
			.pipe(replace('@@NAME@@', product.applicationName))
			.pipe(assertNoPlaceholders('rpm workspace mime'))
			.pipe(rename('BUILD/usr/share/mime/packages/' + product.applicationName + '-workspace.xml'));

		const icon = gulp.src(path.join(root, 'resources/linux/code.png'), { base: root })
			.pipe(rename('BUILD/usr/share/pixmaps/' + product.linuxIconName + '.png'));

		const bash_completion = gulp.src(path.join(root, 'resources/completions/bash/code'))
			.pipe(replace('@@APPNAME@@', product.applicationName))
			.pipe(assertNoPlaceholders('rpm bash completion'))
			.pipe(rename('BUILD/usr/share/bash-completion/completions/' + product.applicationName));

		const zsh_completion = gulp.src(path.join(root, 'resources/completions/zsh/_code'))
			.pipe(replace('@@APPNAME@@', product.applicationName))
			.pipe(assertNoPlaceholders('rpm zsh completion'))
			.pipe(rename('BUILD/usr/share/zsh/site-functions/_' + product.applicationName));

		const code = gulp.src(binaryDir + '/**/*', { base: binaryDir })
			.pipe(rename(function (p) { p.dirname = 'BUILD/usr/share/' + product.applicationName + '/' + p.dirname; }));

		const spec = gulp.src(path.join(root, 'resources/linux/rpm/code.spec.template'), { base: root })
			.pipe(replace('@@NAME@@', product.applicationName))
			.pipe(replace('@@NAME_LONG@@', product.nameLong))
			.pipe(replace('@@DESKTOP_NAME@@', linuxDesktopName))
			.pipe(replace('@@ICON@@', product.linuxIconName))
			.pipe(replace('@@VERSION@@', packageJson.version))
			.pipe(replace('@@RELEASE@@', getLinuxPackageRevision().toString()))
			.pipe(replace('@@ARCHITECTURE@@', rpmArch))
			.pipe(replace('@@LICENSE@@', product.licenseName))
			.pipe(replace('@@QUALITY@@', (product as typeof product & { quality?: string }).quality || '@@QUALITY@@'))
			// No UPDATEURL replacement (BUILD-QA W50): product.json has no `updateUrl` key and no template in this stream contains that token anymore (W42 replaced its last occurrence in code.spec.template with the literal `<updateUrl>`), so the former replace — whose fallback was the placeholder itself — was a permanent no-op that re-injected the token. The guard below now fails the build if the token ever reappears in the spec.
			.pipe(replace('@@DEPENDENCIES@@', dependencies.join(', ')))
			.pipe(replace('@@RECOMMENDS@@', rpmRecommendedDependencies.join(', ')))
			.pipe(replace('@@STRIP@@', stripBinary))
			.pipe(assertNoPlaceholders('rpm spec'))
			.pipe(rename('SPECS/' + product.applicationName + '.spec'));

		const specIcon = gulp.src(path.join(root, 'resources/linux/rpm/code.xpm'), { base: root })
			.pipe(rename('SOURCES/' + product.applicationName + '.xpm'));

		const all = es.merge(code, desktops, appdata, workspaceMime, icon, bash_completion, zsh_completion, spec, specIcon);

		return all.pipe(vfs.dest(getRpmBuildPath(rpmArch)));
	};
}

// RPM artifact verification (BUILD-QA W74, implementing the LÀM-NGAY
// part of the W69 design,
// ide-code-mission/scratch/build-qa/analyze-rpm-verify-design.md §3.2/§5):
// the deb path verifies its produced artifact at the end of
// buildDebPackage (exactly one .deb, non-empty Depends, well-formed
// Version, payload present — all parsed by dpkg-deb). The rpm path had
// no artifact verification at all: after rpmbuild it copied
// `"${rpmOut}/$(ls ${rpmOut})"` — whichever entry `ls` happened to list
// first — to the destination, with no count, no size check and no
// content check (W30 §4.3 [P2]; W56 matrix: rpm "Verify artifact" = ❌).
//
// Per W69 §3.1 the verification is split into a Parse layer (the only
// place that would invoke the format's own tool, as dpkg-deb does for
// deb) and a pure Assert layer (functions over the parsed data, no
// tool calls), so the asserts are fixture-testable on a machine
// without the tool.
//
// TODO (CHỜ-DỮ-KIỆN — W69 §4.2 item C1): the Parse layer,
// readRpmArtifact(rpmFilePath), is deliberately NOT implemented here
// and has NO call site on today's run path — this comment is its only
// presence in the code. Its unlock conditions are data, not code:
// (i) the `rpm` binary present on the machine that runs the verify,
// and (ii) one real .rpm produced by buildRpmPackage, to calibrate
// the actual output of each header/payload query once (line endings,
// the exact shape of the auto-generated requirement lines the
// Requires assert filters out, scriptlet headers, the array query
// behind the payload path→size map) — see W69 §3.2/§3.4 for the
// evidence that neither exists on this machine today. Writing a query
// invocation before that calibration would be inventing unverified
// output syntax, so none is written. Once calibrated, readRpmArtifact
// returns the RpmArtifactInfo struct below and verifyRpmArtifact
// additionally runs assertRpmArtifactFields + assertRpmArtifactPayload
// on it: the asserts are already written and fixture-tested (W74),
// only their data source is missing.

export interface RpmArtifactInfo {
	name: string;
	version: string;
	release: string;
	arch: string;
	sizeBytes: number;
	requires: string[];
	files: ReadonlyMap<string, number>;
	headerAndScriptText: string;
}

// Pure Assert layer, header fields (W69 V-R3…V-R7, V-R10, V-R11).
// Exported for fixture tests, like findUnreplacedPlaceholders;
// nothing here calls any external tool — `info` is data already
// parsed by the (future) Parse layer.
export function assertRpmArtifactFields(info: RpmArtifactInfo, rpmArch: string, rpmFile: string): void {
	// V-R3: Name is the artifact's identity key (install / repo
	// metadata); prepare-rpm stamps it from product.applicationName
	// as @@NAME@@ in the spec.
	if (info.name !== product.applicationName) {
		throw new Error(`build-rpm: packaged '${rpmFile}' has Name '${info.name}' in its rpm header — expected '${product.applicationName}' (product.applicationName, stamped as @@NAME@@ by prepare-rpm) — refusing to accept this artifact.`);
	}
	// V-R4: Version is matched EXACTLY. Unlike deb — where Version
	// embeds the revision and can only be shape-matched (see
	// buildDebPackage) — the rpm spec stamps @@VERSION@@ with
	// packageJson.version verbatim and keeps the revision in the
	// separate Release field, so there is no legitimate drift here.
	if (info.version !== packageJson.version) {
		throw new Error(`build-rpm: packaged '${rpmFile}' has Version '${info.version}' in its rpm header — expected exactly '${packageJson.version}' (packageJson.version, stamped as @@VERSION@@ by prepare-rpm) — refusing to accept this artifact.`);
	}
	// V-R5: Release is matched by SHAPE, not by re-computing the
	// revision: the spec template is `Release: @@RELEASE@@.el8` and
	// prepare-rpm stamps @@RELEASE@@ with getLinuxPackageRevision(),
	// an epoch second resolved at prepare time — re-calling it here
	// could legitimately differ and fail a good artifact (same W36
	// reasoning as the deb Version check).
	if (!/^\d+\.el8$/.test(info.release)) {
		throw new Error(`build-rpm: packaged '${rpmFile}' has Release '${info.release}' in its rpm header — expected '<revision>.el8' (spec template 'Release: @@RELEASE@@.el8' with @@RELEASE@@ = getLinuxPackageRevision(), a non-negative integer) — refusing to accept this artifact.`);
	}
	// V-R6: Arch must be the arch rpmbuild was targeted with
	// (`--target=${rpmArch}` in buildRpmPackage — an external
	// parameter, so a wrong-target artifact is a real rpm-only
	// failure mode), and the file name must be the canonical
	// <Name>-<Version>-<Release>.<Arch>.rpm the header describes.
	if (info.arch !== rpmArch) {
		throw new Error(`build-rpm: packaged '${rpmFile}' has Arch '${info.arch}' in its rpm header — expected '${rpmArch}' (the --target passed to rpmbuild) — refusing to accept this artifact.`);
	}
	const expectedFileName = `${info.name}-${info.version}-${info.release}.${info.arch}.rpm`;
	if (path.basename(rpmFile) !== expectedFileName) {
		throw new Error(`build-rpm: packaged file name '${path.basename(rpmFile)}' does not match its rpm header — expected '${expectedFileName}' (<Name>-<Version>-<Release>.<Arch>.rpm built from the header fields) — refusing to accept this artifact.`);
	}
	// V-R7 (counterpart of the deb Depends check): Requires must
	// still name at least one real dependency after dropping the
	// `rpmlib(…)` bookkeeping lines rpmbuild records for its own
	// format features — those lines are present regardless of the
	// spec's `Requires: @@DEPENDENCIES@@`, so without the filter an
	// artifact whose real Requires were lost would still pass.
	const realRequires = info.requires.map(requirement => requirement.trim()).filter(requirement => requirement.length > 0 && !requirement.startsWith('rpmlib('));
	if (realRequires.length === 0) {
		throw new Error(`build-rpm: packaged '${rpmFile}' has no real Requires in its rpm header (found: ${info.requires.map(requirement => `'${requirement}'`).join(', ') || 'none'} — every entry is an 'rpmlib(…)' bookkeeping line or empty) — expected at least one dependency from the spec's 'Requires: @@DEPENDENCIES@@' — refusing to accept this artifact.`);
	}
	// V-R10 (goal-equivalent replacement for deb's Installed-Size,
	// which has no rpm field with the same semantics — W69 §4.3 D1):
	// the header SIZE (total installed size rpm records) must be a
	// positive integer; equality with the payload size sum is NOT
	// asserted until a real artifact calibrates the semantics
	// (W69 §4.2 C2).
	if (!Number.isInteger(info.sizeBytes) || info.sizeBytes <= 0) {
		throw new Error(`build-rpm: packaged '${rpmFile}' has SIZE '${info.sizeBytes}' in its rpm header — expected a positive integer (total installed size recorded by rpm) — refusing to accept this artifact.`);
	}
	// V-R11: no @@…@@ placeholder may survive on any artifact
	// surface the header exposes — the text fields + scriptlets
	// (passed in as one string) and every payload file name.
	const leakedTokens = [...findUnreplacedPlaceholders(info.headerAndScriptText)];
	for (const fileName of info.files.keys()) {
		for (const token of findUnreplacedPlaceholders(fileName)) {
			if (!leakedTokens.includes(token)) {
				leakedTokens.push(token);
			}
		}
	}
	if (leakedTokens.length > 0) {
		throw new Error(`build-rpm: packaged '${rpmFile}' still contains unreplaced placeholder(s) ${leakedTokens.join(', ')} in its rpm header text, scriptlets or payload file names — a replace step in prepare-rpm was missed or its source value is missing — refusing to accept this artifact.`);
	}
}

// Pure Assert layer, payload (W69 V-R8/V-R9). Payload paths inside an
// .rpm are the ABSOLUTE install paths (unlike the deb contents
// listing). The .node check runs on the artifact itself — stronger
// than deb, which checks .node only in staging — because rpmbuild's
// %install step is a second copy of the payload that nothing else
// verifies (W69 §2): a binding lost in that copy would not fail
// rpmbuild, since the spec's %files entry is the whole app directory.
export function assertRpmArtifactPayload(files: ReadonlyMap<string, number>, rpmFile: string): void {
	const appDir = `/usr/share/${product.applicationName}`;
	const mainBinary = `${appDir}/${product.applicationName}`;
	if (!files.has(mainBinary)) {
		throw new Error(`build-rpm: packaged '${rpmFile}' is missing the main binary '${mainBinary}' in its payload listing — refusing to accept this artifact.`);
	}
	if (![...files.keys()].some(file => file.startsWith(`${appDir}/resources/app/`))) {
		throw new Error(`build-rpm: packaged '${rpmFile}' has no payload under '${appDir}/resources/app/' in its payload listing — refusing to accept this artifact.`);
	}
	const artifactNativeBindings: ReadonlyArray<{ packageName: string; artifactPath: string }> = [
		{ packageName: '@vscode/sqlite3', artifactPath: `${appDir}/resources/app/node_modules.asar.unpacked/@vscode/sqlite3/build/Release/vscode-sqlite3.node` },
		{ packageName: '@vscode/spdlog', artifactPath: `${appDir}/resources/app/node_modules.asar.unpacked/@vscode/spdlog/build/Release/spdlog.node` },
		{ packageName: 'native-keymap', artifactPath: `${appDir}/resources/app/node_modules.asar.unpacked/native-keymap/build/Release/keymapping.node` },
		{ packageName: 'kerberos', artifactPath: `${appDir}/resources/app/node_modules.asar.unpacked/kerberos/build/Release/kerberos.node` },
		{ packageName: '@vscode/native-watchdog', artifactPath: `${appDir}/resources/app/node_modules.asar.unpacked/@vscode/native-watchdog/build/Release/watchdog.node` },
	];
	for (const binding of artifactNativeBindings) {
		if (!files.has(binding.artifactPath)) {
			throw new Error(`build-rpm: native binding missing from artifact for package '${binding.packageName}': '${binding.artifactPath}' in packaged '${rpmFile}' — refusing to accept this artifact. The binding was present in staging (guarded above), so it was lost in the rpmbuild %install copy.`);
		}
		const bindingSize = files.get(binding.artifactPath)!;
		if (bindingSize === 0) {
			throw new Error(`build-rpm: native binding is empty (actual size: ${bindingSize} bytes) in artifact for package '${binding.packageName}': '${binding.artifactPath}' in packaged '${rpmFile}' — refusing to accept this artifact.`);
		}
	}
}

// L3 (W69 §4.1): re-read the staged spec in build-rpm and re-scan it
// for @@…@@, instead of trusting that the copy prepare-rpm scanned
// (assertNoPlaceholders('rpm spec') in prepareRpmPackage) is still
// the copy rpmbuild is about to consume — the spec is the one staged
// text file whose full contents the .rpm does NOT embed (W69 §4.3
// D2), so the staged file is the only place its full text can be
// re-checked.
function assertRpmStagedSpecHasNoPlaceholders(specPath: string): void {
	if (!fs.existsSync(specPath)) {
		throw new Error(`build-rpm: staged spec not found: '${specPath}' — run the prepare-rpm task first.`);
	}
	const tokens = findUnreplacedPlaceholders(fs.readFileSync(specPath, 'utf8'));
	if (tokens.length > 0) {
		throw new Error(`build-rpm: staged spec '${specPath}' still contains unreplaced placeholder(s) ${tokens.join(', ')} — a replace step in prepare-rpm was missed or its source value is missing — refusing to accept an artifact built from it.`);
	}
}

// Coordinator for the artifact checks that run TODAY (called by
// buildRpmPackage after rpmbuild, mirroring the position of the deb
// artifact verify at the end of buildDebPackage): L3 (staged-spec
// re-scan — the spec file survives rpmbuild, so it is re-read here,
// before anything is copied to the destination) and V-R1/V-R2 —
// exactly one .rpm in rpmOut, copied by its explicit name (the old
// `cp "${rpmOut}/$(ls ${rpmOut})"` took whichever entry `ls` listed
// first), with size > 0 asserted on the source and on the copied
// destination file. The header/payload asserts above join this
// function once the Parse layer exists (TODO at the head of this
// block) — they need data only that layer can provide.
async function verifyRpmArtifact(rpmOut: string, destination: string, stagedSpecPath: string): Promise<void> {
	assertRpmStagedSpecHasNoPlaceholders(stagedSpecPath);
	const rpmFiles = fs.readdirSync(rpmOut).filter(file => file.endsWith('.rpm'));
	if (rpmFiles.length !== 1) {
		throw new Error(`build-rpm: expected exactly 1 .rpm in '${rpmOut}' after packaging, found ${rpmFiles.length} (${rpmFiles.join(', ')}).`);
	}
	const rpmFile = rpmFiles[0];
	const rpmSourcePath = path.join(rpmOut, rpmFile);
	const sourceSize = fs.statSync(rpmSourcePath).size;
	if (sourceSize === 0) {
		throw new Error(`build-rpm: packaged '${rpmFile}' in '${rpmOut}' is empty (actual size: ${sourceSize} bytes) — refusing to accept this artifact.`);
	}
	await exec(`cp "${rpmSourcePath}" ${destination}/`);
	const rpmDestPath = path.join(destination, rpmFile);
	if (!fs.existsSync(rpmDestPath)) {
		throw new Error(`build-rpm: copying packaged '${rpmFile}' from '${rpmOut}' did not produce '${rpmDestPath}' — refusing to accept this artifact.`);
	}
	const destSize = fs.statSync(rpmDestPath).size;
	if (destSize === 0) {
		throw new Error(`build-rpm: packaged '${rpmFile}' copied to '${rpmDestPath}' is empty (actual size: ${destSize} bytes) — refusing to accept this artifact.`);
	}
}

function buildRpmPackage(arch: string) {
	const rpmArch = getRpmPackageArch(arch);
	const rpmBuildPath = getRpmBuildPath(rpmArch);
	const rpmOut = `${rpmBuildPath}/RPMS/${rpmArch}`;
	// Anchored to `root` (BUILD-QA W38, rpm counterpart of B-W3-11 for
	// deb): `rpmBuildPath` above is anchored via getRpmBuildPath, so
	// `rpmOut` is anchored with it; anchoring `destination` here anchors
	// the mkdir/HOME/cp commands below (the HOME assignment previously
	// prefixed the then-relative destination with `$(pwd)`).
	const destination = path.join(root, `.build/linux/rpm/${rpmArch}`);

	return async () => {
		// Preflight as the second layer (W66): prepare-rpm already
		// asserted this same build list early, but build-rpm re-checks
		// at its own head — before the staging guard below and before
		// the rpmbuild exec — so the task still self-checks.
		assertRpmTools('build-rpm', rpmBuildTools);
		// Native-binding guard for the Linux payload (BUILD-QA A4-P1,
		// RPM counterpart of the build-deb guard above): packageTask
		// asar-unpacks every '**/*.node' (createAsar call in
		// build/gulpfile.vscode.ts), so a rebuilt binding reaches the
		// packaged app as a real file under
		// resources/app/node_modules.asar.unpacked/<pkg>/build/Release/
		// <target>.node, and prepare-rpm copies that tree verbatim under
		// BUILD/usr/share/<app>/ in this rpmbuild staging dir
		// (getRpmBuildPath). The guard sits here, at the head of
		// build-rpm, because prepare-rpm only returns a stream — the
		// staging tree is complete once that task has finished, which
		// is before this task runs, and rpmbuild has not packed
		// anything yet. If the CI native rebuild silently produced no
		// binding (or one was stripped afterwards), rpmbuild would
		// still pack a valid-looking .rpm whose storage, logging,
		// keyboard-layout, proxy-auth or watchdog native is broken at
		// runtime — fail here instead, naming the package and the path.
		const stagedResourcesApp = path.join(rpmBuildPath, 'BUILD', 'usr', 'share', product.applicationName, 'resources', 'app');
		const stagedNativeBindings: ReadonlyArray<{ packageName: string; stagedPath: string }> = [
			{ packageName: '@vscode/sqlite3', stagedPath: path.join(stagedResourcesApp, 'node_modules.asar.unpacked', '@vscode/sqlite3', 'build', 'Release', 'vscode-sqlite3.node') },
			{ packageName: '@vscode/spdlog', stagedPath: path.join(stagedResourcesApp, 'node_modules.asar.unpacked', '@vscode/spdlog', 'build', 'Release', 'spdlog.node') },
			{ packageName: 'native-keymap', stagedPath: path.join(stagedResourcesApp, 'node_modules.asar.unpacked', 'native-keymap', 'build', 'Release', 'keymapping.node') },
			{ packageName: 'kerberos', stagedPath: path.join(stagedResourcesApp, 'node_modules.asar.unpacked', 'kerberos', 'build', 'Release', 'kerberos.node') },
			{ packageName: '@vscode/native-watchdog', stagedPath: path.join(stagedResourcesApp, 'node_modules.asar.unpacked', '@vscode/native-watchdog', 'build', 'Release', 'watchdog.node') },
		];
		for (const binding of stagedNativeBindings) {
			if (!fs.existsSync(binding.stagedPath)) {
				throw new Error(`build-rpm: native binding missing from staging for package '${binding.packageName}': '${binding.stagedPath}' — refusing to package. The Linux native rebuild step must produce this .node file before packaging.`);
			}
			// Hardening (BUILD-QA W27 P3/d): existence alone is not
			// enough — a 0-byte .node (e.g. a native rebuild that died
			// mid-write) passes existsSync but fails only later, at
			// runtime on dlopen. Require a non-empty file, and name the
			// actual size in the throw so the empty-binding case is
			// distinguishable from the missing-binding case above.
			const bindingSize = fs.statSync(binding.stagedPath).size;
			if (bindingSize === 0) {
				throw new Error(`build-rpm: native binding is empty (actual size: ${bindingSize} bytes) in staging for package '${binding.packageName}': '${binding.stagedPath}' — refusing to package. The Linux native rebuild step must produce a non-empty .node file before packaging.`);
			}
		}

		await exec(`mkdir -p ${destination}`);
		await exec(`HOME="${destination}" rpmbuild -bb ${rpmBuildPath}/SPECS/${product.applicationName}.spec --target=${rpmArch}`);
		// Verify the produced artifact and copy it out by its explicit
		// name (W74, replacing the `cp "${rpmOut}/$(ls ${rpmOut})"` that
		// took whichever entry `ls` listed first): exactly one .rpm in
		// rpmOut, size > 0, staged spec re-scanned for @@…@@ — see
		// verifyRpmArtifact above.
		await verifyRpmArtifact(rpmOut, destination, path.join(rpmBuildPath, 'SPECS', `${product.applicationName}.spec`));
	};
}

function getSnapBuildPath(arch: string): string {
	// Anchored to `root` (BUILD-QA draft, snap counterpart of B-W3-11
	// for deb and W38 for rpm): resolved from the repo root this gives
	// exactly the same location as the previous relative form, but
	// prepare-snap/build-snap stage into the same tree no matter which
	// directory gulp was invoked from.
	return path.join(root, `.build/linux/snap/${arch}/${product.applicationName}-${arch}`);
}

function prepareSnapPackage(arch: string) {
	// Paths are anchored to `root` (BUILD-QA W67, snap counterpart of
	// B-W3-11 for deb and W38 for rpm), not the process cwd: resolved
	// from the repo root these give exactly the same locations as the
	// previous relative forms, but the task now stages from/into the
	// same tree no matter which directory gulp was invoked from.
	// (`destination` below was already anchored via getSnapBuildPath.)
	const binaryDir = path.join(root, '..', 'VSCode-linux-' + arch);
	const destination = getSnapBuildPath(arch);

	return function () {
		// A desktop file that is placed in snap/gui will be placed into meta/gui verbatim.
		const desktop = gulp.src(path.join(root, 'resources/linux/code.desktop'), { base: root })
			.pipe(rename(`snap/gui/${product.applicationName}.desktop`));

		// A desktop file that is placed in snap/gui will be placed into meta/gui verbatim.
		const desktopUrlHandler = gulp.src(path.join(root, 'resources/linux/code-url-handler.desktop'), { base: root })
			.pipe(rename(`snap/gui/${product.applicationName}-url-handler.desktop`));

		const desktops = es.merge(desktop, desktopUrlHandler)
			.pipe(replace('@@NAME_LONG@@', product.nameLong))
			.pipe(replace('@@NAME_SHORT@@', product.nameShort))
			.pipe(replace('@@DESKTOP_NAME@@', `${product.applicationName}_${product.applicationName}`))
			.pipe(replace('@@NAME@@', product.applicationName))
			.pipe(replace('@@EXEC@@', `${product.applicationName} --force-user-env`))
			.pipe(replace('@@ICON@@', `\${SNAP}/meta/gui/${product.linuxIconName}.png`))
			.pipe(replace('@@URLPROTOCOL@@', product.urlProtocol))
			.pipe(assertNoPlaceholders('snap desktops'));

		// An icon that is placed in snap/gui will be placed into meta/gui verbatim.
		const icon = gulp.src(path.join(root, 'resources/linux/code.png'), { base: root })
			.pipe(rename(`snap/gui/${product.linuxIconName}.png`));

		const code = gulp.src(binaryDir + '/**/*', { base: binaryDir })
			.pipe(rename(function (p) { p.dirname = `usr/share/${product.applicationName}/${p.dirname}`; }));

		const snapcraft = gulp.src(path.join(root, 'resources/linux/snap/snapcraft.yaml'), { base: root })
			.pipe(replace('@@NAME@@', product.applicationName))
			.pipe(replace('@@VERSION@@', commit!.substr(0, 8)))
			// Possible run-on values https://snapcraft.io/docs/architectures
			.pipe(replace('@@ARCHITECTURE@@', arch === 'x64' ? 'amd64' : arch))
			.pipe(assertNoPlaceholders('snap snapcraft'))
			.pipe(rename('snap/snapcraft.yaml'));

		const electronLaunch = gulp.src(path.join(root, 'resources/linux/snap/electron-launch'), { base: root })
			.pipe(rename('electron-launch'));

		const all = es.merge(desktops, icon, code, snapcraft, electronLaunch);

		return all.pipe(vfs.dest(destination));
	};
}

function buildSnapPackage(arch: string) {
	const cwd = getSnapBuildPath(arch);

	return async () => {
		// Preflight (BUILD-QA draft, snap counterpart of assertDebTools
		// for deb): build-snap shells out to `snapcraft` below, so fail
		// here — at the head of the callback, before the staging guard
		// and before packaging — with the tool named, instead of
		// surfacing a bare spawn ENOENT from exec. Same PATH scan as
		// assertDebTools (fs.accessSync X_OK per PATH directory). It is
		// inlined rather than routed through assertDebTools because that
		// helper's stage union only accepts 'prepare-deb' | 'build-deb'.
		const pathDirs = (process.env.PATH ?? '').split(path.delimiter).filter(dir => dir.length > 0);
		const snapcraftFound = pathDirs.some(dir => {
			try {
				fs.accessSync(path.join(dir, 'snapcraft'), fs.constants.X_OK);
				return true;
			} catch {
				return false;
			}
		});
		if (!snapcraftFound) {
			throw new Error(`build-snap: required external tool not found in PATH: snapcraft — install it (e.g. 'sudo snap install snapcraft --classic') and re-run this task.`);
		}

		// Native-binding guard for the Linux payload (BUILD-QA A4-P1,
		// snap counterpart of the build-deb/build-rpm guards above):
		// packageTask asar-unpacks every '**/*.node' (createAsar call in
		// build/gulpfile.vscode.ts), so a rebuilt binding reaches the
		// packaged app as a real file under
		// resources/app/node_modules.asar.unpacked/<pkg>/build/Release/
		// <target>.node, and prepare-snap copies that tree verbatim
		// under usr/share/<app>/ in this staging dir (the snap build
		// path itself — no BUILD/ segment as in rpm, no per-package
		// subdir as in deb). The guard sits here, at the head of
		// build-snap, because build-snap is series(prepare-snap,
		// build-snap): the staging tree is complete once prepare-snap
		// has finished, which is before this callback runs, and
		// snapcraft has not packed anything yet. If the CI native
		// rebuild silently produced no binding (or one was stripped
		// afterwards), snapcraft would still pack a valid-looking .snap
		// whose storage, logging, keyboard-layout, proxy-auth or
		// watchdog native is broken at runtime — fail here instead,
		// naming the package and the path.
		const stagedResourcesApp = path.join(cwd, 'usr', 'share', product.applicationName, 'resources', 'app');
		const stagedNativeBindings: ReadonlyArray<{ packageName: string; stagedPath: string }> = [
			{ packageName: '@vscode/sqlite3', stagedPath: path.join(stagedResourcesApp, 'node_modules.asar.unpacked', '@vscode/sqlite3', 'build', 'Release', 'vscode-sqlite3.node') },
			{ packageName: '@vscode/spdlog', stagedPath: path.join(stagedResourcesApp, 'node_modules.asar.unpacked', '@vscode/spdlog', 'build', 'Release', 'spdlog.node') },
			{ packageName: 'native-keymap', stagedPath: path.join(stagedResourcesApp, 'node_modules.asar.unpacked', 'native-keymap', 'build', 'Release', 'keymapping.node') },
			{ packageName: 'kerberos', stagedPath: path.join(stagedResourcesApp, 'node_modules.asar.unpacked', 'kerberos', 'build', 'Release', 'kerberos.node') },
			{ packageName: '@vscode/native-watchdog', stagedPath: path.join(stagedResourcesApp, 'node_modules.asar.unpacked', '@vscode/native-watchdog', 'build', 'Release', 'watchdog.node') },
		];
		for (const binding of stagedNativeBindings) {
			if (!fs.existsSync(binding.stagedPath)) {
				throw new Error(`build-snap: native binding missing from staging for package '${binding.packageName}': '${binding.stagedPath}' — refusing to package. The Linux native rebuild step must produce this .node file before packaging.`);
			}
			// Hardening, same as the build-deb guard (W27 P3/d):
			// existence alone is not enough — a 0-byte .node passes
			// existsSync but fails only later, at runtime on dlopen.
			// Require a non-empty file, and name the actual size in
			// the throw so the empty-binding case is distinguishable
			// from the missing-binding case above.
			const bindingSize = fs.statSync(binding.stagedPath).size;
			if (bindingSize === 0) {
				throw new Error(`build-snap: native binding is empty (actual size: ${bindingSize} bytes) in staging for package '${binding.packageName}': '${binding.stagedPath}' — refusing to package. The Linux native rebuild step must produce a non-empty .node file before packaging.`);
			}
		}

		await exec('snapcraft', { cwd });
	};
}

const BUILD_TARGETS = [
	{ arch: 'x64' },
	{ arch: 'armhf' },
	{ arch: 'arm64' },
];

BUILD_TARGETS.forEach(({ arch }) => {
	const debArch = getDebPackageArch(arch);
	// WARNING (BUILD-QA B-W3-12): this rimraf deletes the whole per-arch
	// deb tree `.build/linux/deb/<debArch>`, which is also where
	// build-deb writes its output (`<debArch>/deb/*.deb` — see
	// buildDebPackage). Inside the task graph that ordering is safe:
	// build-deb is `series(prepareDebTask, buildDebPackage)` below, so
	// the .deb is always (re)written after the rimraf of the same run.
	// But re-running prepare-deb ALONE after a successful build deletes
	// the built .deb with no warning — consume/upload the artifact
	// before re-running prepare-deb by itself.
	const prepareDebTask = task.define(`vscode-linux-${arch}-prepare-deb`, task.series(rimraf(path.join(root, `.build/linux/deb/${debArch}`)), prepareDebPackage(arch)));
	task.task(prepareDebTask);
	const buildDebTask = task.define(`vscode-linux-${arch}-build-deb`, task.series(prepareDebTask, buildDebPackage(arch)));
	task.task(buildDebTask);

	const rpmArch = getRpmPackageArch(arch);
	// WARNING (BUILD-QA W38, rpm counterpart of B-W3-12 for deb): this
	// rimraf deletes the whole per-arch rpm tree
	// `.build/linux/rpm/<rpmArch>`, which is also where build-rpm copies
	// its output (`<rpmArch>/*.rpm` — see buildRpmPackage). Inside the
	// task graph that ordering is safe: build-rpm is
	// `series(prepareRpmTask, buildRpmPackage)` below, so the .rpm is
	// always (re)written after the rimraf of the same run. But
	// re-running prepare-rpm ALONE after a successful build deletes the
	// built .rpm with no warning — consume/upload the artifact before
	// re-running prepare-rpm by itself.
	const prepareRpmTask = task.define(`vscode-linux-${arch}-prepare-rpm`, task.series(rimraf(path.join(root, `.build/linux/rpm/${rpmArch}`)), prepareRpmPackage(arch)));
	task.task(prepareRpmTask);
	// Series with prepare (BUILD-QA W38, rpm counterpart of B-W3-01 for
	// deb): build-rpm previously ran buildRpmPackage alone, so invoking
	// it directly skipped every prepare-rpm guard (the F-2 throw in
	// getDependencies, reached only from prepareRpmPackage) and then
	// failed in the W33 native-binding guard in buildRpmPackage on an
	// empty staging tree, with a message that pointed at the native
	// rebuild instead of at the missing prepare step. Mirrors the
	// build-deb and build-snap registrations.
	const buildRpmTask = task.define(`vscode-linux-${arch}-build-rpm`, task.series(prepareRpmTask, buildRpmPackage(arch)));
	task.task(buildRpmTask);

	const prepareSnapTask = task.define(`vscode-linux-${arch}-prepare-snap`, task.series(rimraf(path.join(root, `.build/linux/snap/${arch}`)), prepareSnapPackage(arch)));
	task.task(prepareSnapTask);
	const buildSnapTask = task.define(`vscode-linux-${arch}-build-snap`, task.series(prepareSnapTask, buildSnapPackage(arch)));
	task.task(buildSnapTask);
});
