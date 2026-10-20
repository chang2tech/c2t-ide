/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE (DEV-GAPS-71D, approval-cursorignore-self-protect): `.cursorignore`
// self-protection — the agent cannot modify `.cursorignore` itself.
//
// Binary evidence (Cursor 3.25.9,
// `resources/app/extensions/cursor-agent-exec/dist/main.js` —
// `InteractivePermissionsService.shouldBlockWrite`: method def @6153119
// (method-name anchor, byte-exact — W83E re-verified 2026-10-20 by slicing the
// 3.25.9 reference binary; @6153113 is the alternate `async`-keyword anchor
// of the same method — same method, two anchor conventions),
// `.cursorignore` check @6153702 (delta 583 bytes; the earlier @6137767 cite
// was an unreproducible approximation), step 4 of the write check order):
//   const l=i.originalPath.split(s.sep).pop()?.toLowerCase()??"",
//         u=a.split(s.sep).pop()?.toLowerCase()??"";
//   if(".cursorignore"===l||".cursorignore"===u)return{type:"permissionsConfig"};
// i.e. the lowercased basename of BOTH the requested path (`originalPath`)
// and the resolved path (`resolvedPath`) is compared against ".cursorignore";
// a match hard-blocks the write as `{type:"permissionsConfig"}` — denied,
// no approval prompt.
//
// The resolved path comes from `dl` @6141160 (verbatim):
//   async function dl(e,t){const r=(0,M.o1)(e,t);
//     try{return ll(await(0,n.realpath)(r),r,{status:"resolved"})}
//     catch(e){const t=e;if("ENOENT"!==t.code)return ll(r,r,ul(t));
//     try{if((await(0,n.lstat)(r)).isSymbolicLink()){
//       let e=null;try{e=await(0,n.readlink)(r)}catch{}
//       return ll(r,r,{status:"danglingSymlink",symlinkTarget:e})}
//     ...}}
// i.e. `fs.realpath`, with an ENOENT fallback that lstats and readlinks a
// dangling symlink (which `shouldBlockWrite` then rejects as
// `{type:"unsafeResolution"}`). So a symlink whose target's basename is
// ".cursorignore" IS blocked by the binary (resolved-half match), and a
// dangling symlink is blocked too (unsafe resolution).
//
// Layer mapping (Cursor → fork): Cursor's check lives in the agent runtime's
// write gate, which every file write passes through. The fork's equivalent
// enforcement point is the `permission.asked` choke point (`handleApproval`
// in electron-browser/ideCodeEngineAdapter.ts): a write whose requested OR
// resolved target basename is `.cursorignore` is auto-denied there without
// prompting (decision "skip"), mirroring `{type:"permissionsConfig"}`.
// The resolver (node `fs.realpath` + dangling-symlink `lstat`/`readlink`
// fallback, mirroring `dl` @6141160) is injected at the call site, which runs
// in node context; this module stays dependency-free. A resolution failure
// (e.g. ENOENT for a not-yet-created file) fails OPEN for the resolved half
// only — the requested half still protects, and Cursor likewise must allow
// creating new files.
//
// This module is intentionally dependency-free (pure string logic + an
// injected async resolver) so it can be unit-tested with plain node.

/** The ignore file the agent is never allowed to modify itself. */
export const CURSORIGNORE_FILENAME = ".cursorignore";

/**
 * File-write actions the self-protection applies to.
 * (Cursor: the check lives in `shouldBlockWrite` — the write gate.)
 */
export const CURSORIGNORE_WRITE_ACTIONS: ReadonlySet<string> = new Set([
	"edit",
	"write",
	"patch",
]);

/**
 * Lowercased basename of a path, handling both `/` and `\` separators
 * (Cursor: `path.split(sep).pop()?.toLowerCase()`).
 */
export function baseNameLowerFsPath(fsPath: string): string {
	const afterSlash = fsPath.split("/").pop() ?? fsPath;
	const base = afterSlash.split("\\").pop() ?? afterSlash;
	return base.toLowerCase();
}

/**
 * Returns true when a `permission.asked` file write targets `.cursorignore`
 * — the agent must not modify `.cursorignore` itself.
 *
 * Mirrors Cursor's `shouldBlockWrite` step 4: write action + lowercased
 * basename of the target path equals ".cursorignore" → hard block
 * (`{type:"permissionsConfig"}`, no prompt).
 *
 * NOTE: this checks the REQUESTED path only (the binary's `l` half). Use
 * {@link isCursorIgnoreSelfWriteResolved} when a path resolver is available
 * to also cover the resolved-path half (the binary's `u` half).
 */
export function isCursorIgnoreSelfWrite(
	action: string,
	resources: readonly string[],
): boolean {
	if (!CURSORIGNORE_WRITE_ACTIONS.has(action.toLowerCase())) {
		return false;
	}
	return resources.some(
		(r) =>
			typeof r === "string" &&
			baseNameLowerFsPath(r) === CURSORIGNORE_FILENAME,
	);
}

/**
 * Path resolver for the resolved-path half of the check. Mirrors the binary's
 * `dl` @6141160: `fs.realpath`, falling back on ENOENT to `lstat` + `readlink`
 * for dangling symlinks. The call site (node context) provides the real
 * implementation; tests inject a fake or the real `node:fs/promises`.
 */
export type CursorIgnorePathResolver = (fsPath: string) => Promise<string>;

/**
 * Full-fidelity mirror of Cursor's `shouldBlockWrite` step 4: blocks when the
 * lowercased basename of the REQUESTED path (binary `i.originalPath` → `l`)
 * OR the RESOLVED path (binary `i.resolvedPath` → `u`) equals ".cursorignore".
 *
 * A resolver failure (ENOENT, dangling link whose target can't be read, …)
 * fails OPEN for the resolved half only — the requested-half check above has
 * already run, and blocking on unresolvable paths would break creating new
 * files (which the binary also allows through `dl`).
 */
export async function isCursorIgnoreSelfWriteResolved(
	action: string,
	resources: readonly string[],
	resolvePath: CursorIgnorePathResolver,
): Promise<boolean> {
	if (!CURSORIGNORE_WRITE_ACTIONS.has(action.toLowerCase())) {
		return false;
	}
	for (const r of resources) {
		if (typeof r !== "string") {
			continue;
		}
		// Requested half (binary `l`).
		if (baseNameLowerFsPath(r) === CURSORIGNORE_FILENAME) {
			return true;
		}
		// Resolved half (binary `u`).
		try {
			const resolved = await resolvePath(r);
			if (baseNameLowerFsPath(resolved) === CURSORIGNORE_FILENAME) {
				return true;
			}
		} catch {
			// Unresolvable (e.g. not-yet-created file): skip the resolved half.
		}
	}
	return false;
}
