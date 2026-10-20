/**
 * UserRulesService — Cursor-style global User Rules for the agent chat.
 *
 * Parity spec: feature-matrix `rules-user` (verified against Cursor 3.25.9
 * binary `workbench.desktop.main.js` + https://cursor.com/docs/rules).
 *
 * Binary evidence (own grep of the 3.25.9 bundle, 2026-10-20):
 * - `editor.action.knowledgeBase.add` → title "Add User Rule"
 * - `editor.action.knowledgeBase.list` → title "View User Rules"
 *   (both registered with keybinding category "knowledge_base")
 * - `aiserver.v1.KnowledgeBase{Add,List,Remove,Update}` RPCs and the
 *   `KnowledgeBaseResult`/`KnowledgeBaseParams` protobufs
 *   (`knowledge_to_store`, `title`, optional `existing_knowledge_id`,
 *   optional `action`)
 * - workbench-side `knowledgeBaseService.js` module, item list keyed via
 *   `getGitUpstreamUrl()`, `[KnowledgeBaseService] Failed to fetch knowledge`
 * - UI string: "User Rules apply to all of your chats"
 *
 * Docs evidence (cursor.com/docs/rules, fetched 2026-10-20):
 * - "User Rules are global preferences defined in Customize → Rules that
 *   apply across all projects."
 * - "User Rules are not applied to Inline Edit (Cmd/Ctrl+K). They are only
 *   used by Agent (Chat)."
 * - Precedence when merging: Team Rules → Project Rules → User Rules.
 *
 * SCOPE (mirrors the project-rules parity spec §A6): this service is only
 * ever consulted from ComposerDataService.submitTurn (agent chat). It is
 * never consulted from Cmd+K or Tab paths.
 */

import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";

/** File name inside the extension global storage dir. */
export const USER_RULES_FILE_NAME = "user-rules.json";

/** One global user rule (mirrors KnowledgeBaseParams: title + knowledge). */
export interface UserRule {
  /** Stable id, e.g. "ur_m4x..." */
  id: string;
  /** Short title shown in lists. */
  title: string;
  /** The rule content, injected into the agent request verbatim. */
  content: string;
  createdAt: number;
  updatedAt: number;
}

/** Fallback title for rules with a blank title (binary string "User Rule"). */
export const DEFAULT_USER_RULE_TITLE = "User Rule";

/**
 * Build the agent-request injection block for a set of user rules.
 * Pure function (no vscode dependency) so it is unit-testable.
 *
 * Rule content reaches the agent as written (docs: "Rule content reaches
 * Agent as written") — only the `name` attribute is XML-escaped. "" when
 * there are no rules (zero-cost no-op at the submit path).
 */
export function buildUserRulesBlock(rules: readonly UserRule[]): string {
  if (rules.length === 0) {
    return "";
  }
  const entries = rules.map((r) => {
    const name = r.title.trim() || DEFAULT_USER_RULE_TITLE;
    return `<user_rule name="${escapeXmlAttr(name)}">\n${r.content.trim()}\n</user_rule>`;
  });
  return `<user_rules>\n${entries.join("\n")}\n</user_rules>`;
}

function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate one parsed JSON value; null for malformed entries. */
export function parseUserRule(value: unknown): UserRule | null {
  if (!isRecord(value)) {
    return null;
  }
  const { id, title, content, createdAt, updatedAt } = value;
  if (typeof id !== "string" || !id) {
    return null;
  }
  if (typeof title !== "string" || typeof content !== "string") {
    return null;
  }
  const created = typeof createdAt === "number" ? createdAt : 0;
  const updated = typeof updatedAt === "number" ? updatedAt : created;
  return { id, title, content, createdAt: created, updatedAt: updated };
}

export interface UserRulesServiceOptions {
  /**
   * Directory for the JSON store. The host passes
   * `context.globalStorageUri.fsPath` — global across all projects,
   * matching "User Rules apply to all of your chats".
   */
  globalStorageDir: string;
  output?: { appendLine(line: string): void };
}

export class UserRulesService implements vscode.Disposable {
  private readonly filePath: string;
  private rules: UserRule[] = [];
  private idCounter = 0;
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  /** Fires whenever the rule set changes (add/update/remove/load). */
  readonly onDidChangeRules = this.changeEmitter.event;

  constructor(private readonly options: UserRulesServiceOptions) {
    this.filePath = path.join(options.globalStorageDir, USER_RULES_FILE_NAME);
    this.load();
  }

  /** All rules, oldest first (a copy). */
  getRules(): UserRule[] {
    return this.rules.map((r) => ({ ...r }));
  }

  getRule(id: string): UserRule | undefined {
    const found = this.rules.find((r) => r.id === id);
    return found ? { ...found } : undefined;
  }

  /** Add a rule; persists and notifies. Empty content is rejected. */
  async addRule(title: string, content: string): Promise<UserRule> {
    const cleanContent = content.trim();
    if (!cleanContent) {
      throw new Error("User rule content must not be empty.");
    }
    const now = Date.now();
    this.idCounter += 1;
    const rule: UserRule = {
      id: `ur_${now.toString(36)}_${this.idCounter.toString(36)}`,
      title: title.trim() || DEFAULT_USER_RULE_TITLE,
      content: cleanContent,
      createdAt: now,
      updatedAt: now,
    };
    this.rules.push(rule);
    this.sortRules();
    this.save();
    this.changeEmitter.fire();
    return { ...rule };
  }

  /** Update title and/or content; false when the id is unknown. */
  async updateRule(
    id: string,
    patch: { title?: string; content?: string },
  ): Promise<boolean> {
    const rule = this.rules.find((r) => r.id === id);
    if (!rule) {
      return false;
    }
    if (patch.title !== undefined) {
      rule.title = patch.title.trim() || DEFAULT_USER_RULE_TITLE;
    }
    if (patch.content !== undefined) {
      const clean = patch.content.trim();
      if (!clean) {
        throw new Error("User rule content must not be empty.");
      }
      rule.content = clean;
    }
    rule.updatedAt = Date.now();
    this.save();
    this.changeEmitter.fire();
    return true;
  }

  /** Remove a rule; false when the id is unknown. */
  async removeRule(id: string): Promise<boolean> {
    const index = this.rules.findIndex((r) => r.id === id);
    if (index < 0) {
      return false;
    }
    this.rules.splice(index, 1);
    this.save();
    this.changeEmitter.fire();
    return true;
  }

  /**
   * The injection block for the agent request. Called on EVERY agent-chat
   * submit (ComposerDataService.submitTurn) — Agent Chat ONLY, never
   * Cmd+K or Tab.
   */
  buildInjection(): string {
    return buildUserRulesBlock(this.rules);
  }

  private sortRules(): void {
    this.rules.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  private load(): void {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, "utf8");
    } catch {
      // No file yet — first run. Not an error.
      return;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        throw new Error("top-level JSON is not an array");
      }
      const valid: UserRule[] = [];
      for (const entry of parsed) {
        const rule = parseUserRule(entry);
        if (rule) {
          valid.push(rule);
        }
      }
      this.rules = valid;
      this.sortRules();
    } catch (err) {
      // Corrupt store: keep an empty rule set rather than crashing the
      // extension host; the file is repaired on the next save.
      this.log(
        `user-rules store unreadable (${err instanceof Error ? err.message : err}) — starting empty`,
      );
      this.rules = [];
    }
  }

  private save(): void {
    if (!this.options.globalStorageDir) {
      return;
    }
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.rules, null, 2), "utf8");
    } catch (err) {
      this.log(
        `failed to persist user rules (${err instanceof Error ? err.message : err})`,
      );
    }
  }

  private log(message: string): void {
    this.options.output?.appendLine(`[ide-agent][user-rules] ${message}`);
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}
