/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * WORKER-GAPS-66D (`tab-close-restore`) — Cursor parity for Cmd+Shift+T
 * reopening closed chat/app tabs.
 *
 * Binary evidence (Cursor 3.25.9, workbench.glass.main.js):
 *   HistoryService.recentlyClosedEditors + reopenLastClosedEditor @27652666
 *   workbench.action.reopenClosedEditor (CtrlCmd+Shift+T, weight 200) @38319944
 *   composer chat input `toUntyped(){resource, options:{override}}` @27634878
 *   review-changes input `toUntyped(){resource, options:{override, pinned:!0}}` @26562063
 * Docs evidence: cursor.com/docs/release-notes — "Cmd+Shift+T reopens whatever
 * you closed most recently, chat or app tab, including Agent, Environment,
 * Changes, Desktop, Machine, and voice call transcript tabs."
 *
 * NOTE: the extension's full `tsc -p ./` is blocked by a pre-existing TS1005
 * syntax error in components/composer.ts:2799 (noted by WORKER-GAPS-22B, out of
 * this task's scope), so this file is compiled standalone into
 * out/services/test/ and run with node --test, like the other run-*-tests.js
 * runners.
 */

import { describe, it } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as ts from "typescript";

// Compiled into out/services/test/ — 5 ups = repo root.
const repoRoot = path.join(__dirname, "..", "..", "..", "..", "..");
const COMPOSER = path.join(repoRoot, "src", "vs", "workbench", "contrib", "composer");

function read(rel: string): string {
	return fs.readFileSync(path.join(COMPOSER, rel), "utf8");
}

// --- behavioral: transpile the zero-dependency core module and load it ---
const pureSrc = read(path.join("common", "tabCloseRestore.ts"));
const pureJs = ts.transpileModule(pureSrc, {
	compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const pureMod = { exports: {} as Record<string, unknown> };
// The module has no imports; `require` is passed but never called.
new Function("module", "exports", "require", pureJs)(pureMod, pureMod.exports, require);
const M = pureMod.exports as Record<string, any>;

const SECTIONS = ["plugins", "mcps", "skills", "subagents", "rules", "commands", "hooks"];

describe("tab-close-restore wiring (GAPS-66D)", () => {

	it("core files exist at the expected layout", () => {
		assert.ok(fs.existsSync(path.join(COMPOSER, "common", "tabCloseRestore.ts")), "common/tabCloseRestore.ts");
		assert.ok(fs.existsSync(path.join(COMPOSER, "test", "common", "tabCloseRestore.test.ts")), "test/common/tabCloseRestore.test.ts");
		assert.ok(fs.existsSync(path.join(COMPOSER, "browser", "composerEditorInput.ts")), "browser/composerEditorInput.ts");
		assert.ok(fs.existsSync(path.join(COMPOSER, "browser", "composerChangesTab.ts")), "browser/composerChangesTab.ts");
		assert.ok(fs.existsSync(path.join(COMPOSER, "browser", "composerCustomizeEditor.ts")), "browser/composerCustomizeEditor.ts");
	});

	it("verbatim editor ids + schemes survive into the core module", () => {
		assert.strictEqual(M.COMPOSER_CHAT_EDITOR_ID, "composer.chatEditor");
		assert.strictEqual(M.COMPOSER_CHANGES_EDITOR_ID, "composer.changesTab");
		assert.strictEqual(M.COMPOSER_REVIEW_CHANGES_EDITOR_ID, "composer.reviewChangesTab");
		assert.strictEqual(M.COMPOSER_CUSTOMIZE_EDITOR_ID, "composer.customizeEditor");
		assert.strictEqual(M.COMPOSER_CHAT_SCHEME, "ide-chat");
		assert.strictEqual(M.COMPOSER_CHANGES_SCHEME, "composer-changes");
		assert.strictEqual(M.COMPOSER_CUSTOMIZE_SCHEME, "ide-customize");
	});

	it("buildReopenUntypedInput emits the binary-verbatim shapes", () => {
		// Chat: {resource, options:{override}} — no pinned key (binary @27634878).
		const chat = M.buildReopenUntypedInput({ uri: "ide-chat:/t1" }, "composer.chatEditor");
		assert.deepStrictEqual(chat, { resource: { uri: "ide-chat:/t1" }, options: { override: "composer.chatEditor" } });
		// Review changes: {resource, options:{override, pinned:!0}} (binary @26562063).
		const review = M.buildReopenUntypedInput({ uri: "composer-changes:/review/t1" }, "composer.reviewChangesTab", true);
		assert.deepStrictEqual(review, {
			resource: { uri: "composer-changes:/review/t1" },
			options: { override: "composer.reviewChangesTab", pinned: true },
		});
	});

	it("chat resource parse is fail-closed", () => {
		assert.strictEqual(M.parseComposerChatTabRef({ scheme: "ide-chat", path: "/tab-42", query: "" }), "tab-42");
		assert.strictEqual(M.parseComposerChatTabRef({ scheme: "file", path: "/tab-42", query: "" }), undefined);
		assert.strictEqual(M.parseComposerChatTabRef({ scheme: "ide-chat", path: "/", query: "" }), undefined);
		assert.strictEqual(M.parseComposerChatTabRef({ scheme: "ide-chat", path: "/a/b", query: "" }), undefined);
		assert.strictEqual(M.parseComposerChatTabRef({ scheme: "ide-chat", path: "/..", query: "" }), undefined);
	});

	it("changes resource parse distinguishes changes vs review + decodes scope", () => {
		assert.deepStrictEqual(
			M.parseComposerChangesTabRef({ scheme: "composer-changes", path: "/agent-1", query: "scope=branch" }),
			{ kind: "changes", agentId: "agent-1", scope: "branch" },
		);
		assert.deepStrictEqual(
			M.parseComposerChangesTabRef({ scheme: "composer-changes", path: "/review/agent-1", query: "scope=last%20turn" }),
			{ kind: "review", agentId: "agent-1", scope: "last turn" },
		);
		assert.strictEqual(M.parseComposerChangesTabRef({ scheme: "composer-changes", path: "/review/..", query: "" }), undefined);
		assert.strictEqual(M.parseComposerChangesTabRef({ scheme: "composer-changes", path: "/a/b/c", query: "" }), undefined);
	});

	it("customize resource parse validates against the section list", () => {
		assert.strictEqual(M.parseComposerCustomizeTabRef({ scheme: "ide-customize", path: "/skills", query: "" }, SECTIONS), "skills");
		assert.strictEqual(M.parseComposerCustomizeTabRef({ scheme: "ide-customize", path: "/nope", query: "" }, SECTIONS), undefined);
	});

	it("the four composer inputs implement toUntyped() via the shared builder", () => {
		const chatInput = read(path.join("browser", "composerEditorInput.ts"));
		assert.ok(chatInput.includes("import { buildReopenUntypedInput } from '../common/tabCloseRestore.js';"), "chat imports builder");
		assert.ok(chatInput.includes("override toUntyped(): IUntypedEditorInput"), "chat overrides toUntyped");
		assert.ok(chatInput.includes("return buildReopenUntypedInput(this.resource, ComposerChatEditorInput.ID);"), "chat binary shape (no pinned)");

		const changesTab = read(path.join("browser", "composerChangesTab.ts"));
		assert.ok(changesTab.includes("import { buildReopenUntypedInput } from '../common/tabCloseRestore.js';"), "changes imports builder");
		const changesUntyped = changesTab.match(/override toUntyped\(\): IUntypedEditorInput \{[^}]*\}/g) ?? [];
		assert.strictEqual(changesUntyped.length, 2, "both changes inputs override toUntyped");
		assert.ok(changesTab.includes("return buildReopenUntypedInput(this.getResource(), ComposerChangesEditorInput.ID, true);"), "changes binary shape (pinned)");
		assert.ok(changesTab.includes("return buildReopenUntypedInput(this.getResource(), ComposerReviewChangesEditorInput.ID, true);"), "review binary shape (pinned)");

		const customize = read(path.join("browser", "composerCustomizeEditor.ts"));
		assert.ok(customize.includes("override toUntyped(): IUntypedEditorInput"), "customize overrides toUntyped");
		assert.ok(customize.includes("return buildReopenUntypedInput(this.resource, ComposerCustomizeEditorInput.ID, true);"), "customize binary shape (pinned)");
	});

	it("contribution registers resolver factories for all four schemes", () => {
		const contrib = read(path.join("browser", "composer.contribution.ts"));
		assert.ok(contrib.includes("registerTabCloseRestoreResolvers(instantiationService)"), "resolvers registered in constructor");
		assert.ok(contrib.includes("`${COMPOSER_CHAT_EDITOR_SCHEME}:**/**`"), "ide-chat glob registered");
		assert.ok(contrib.includes("ComposerChatEditorInput.ID"), "chat editor id in resolver");
		assert.ok(contrib.includes("ComposerChangesEditorInput.ID"), "changes editor id in resolver");
		assert.ok(contrib.includes("ComposerReviewChangesEditorInput.ID"), "review changes editor id in resolver");
		assert.ok(contrib.includes("ComposerCustomizeEditorInput.ID"), "customize editor id in resolver");
		assert.ok(contrib.includes("parseComposerChatTabRef"), "chat factory parses the resource");
		assert.ok(contrib.includes("parseComposerChangesTabRef"), "changes factory parses the resource");
		assert.ok(contrib.includes("parseComposerCustomizeTabRef"), "customize factory parses the resource");
		assert.ok(contrib.includes("@IEditorResolverService private readonly editorResolverService: IEditorResolverService"), "resolver service injected");
	});

	it("history service keeps the stock close-record gate (no fork changes needed)", () => {
		const history = fs.readFileSync(
			path.join(repoRoot, "src", "vs", "workbench", "services", "history", "browser", "historyService.ts"),
			"utf8",
		);
		assert.ok(history.includes("reopenLastClosedEditor"), "stock reopen flow intact");
		assert.ok(history.includes("handleEditorCloseEventInReopen"), "stock close-record gate intact");
	});
});
