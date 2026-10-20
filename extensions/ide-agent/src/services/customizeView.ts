import * as vscode from "vscode";

/**
 * Customize editor tab — Cursor parity (dig-deeper-customize-view-2026-10-19).
 *
 * In Cursor, Customize is a REAL editor tab (`div.ui-customize-view` inside
 * `div.editor-instance`, tab title "Customize") — NOT a settings section. It
 * is the single home for Plugins, MCPs, Skills, Subagents, Rules, Commands
 * and Hooks management.
 *
 * This module registers a VS Code custom editor provider mirroring
 * chatEditorProvider.ts: the document URI is `ide-customize:/<tabId>` and one
 * editor = one Customize webview. Cursor commands implemented:
 *   - `workbench.action.openCustomizeEditor` (also `ide.openCustomize`)
 *   - `workbench.action.customize.open{Plugins,MCPs,Skills,Subagents,Rules,Commands,Hooks}`
 *     each opening the view with that pill tab pre-selected.
 *
 * Data wiring (honest split):
 *   REAL:      MCP servers (mcp.json via McpService.getServerStatuses),
 *              hook execution log (HookService.getExecutionLog + clear),
 *              rules (.mdc via ProjectRulesService.getRules),
 *              skills (.cursor/skills via SlashCommandService.getSkills),
 *              commands (.cursor/commands via SlashCommandService.getCustomCommands),
 *              plugins (installed extensions via vscode.extensions.all —
 *              clicking one opens the platform's extension editor with real
 *              Enable/Disable/Uninstall; Add → Extensions view / Install from VSIX),
 *              subagents (engine agent markdown dirs {agent,agents}/**\/*.md —
 *              the same store the ide-code engine discovers; New writes a real
 *              file the live engine picks up).
 *   PLACEHOLDER (labeled in UI/code): installing plugins from a GitHub
 *              repository URL (no vsix-packaging backend exists yet).
 */

// ---------------------------------------------------------------------------
// View identity
// ---------------------------------------------------------------------------

export const CUSTOMIZE_EDITOR_VIEW_TYPE = "ideAgent.customizeEditor";
export const CUSTOMIZE_EDITOR_SCHEME = "ide-customize";

/** Tab id of the Customize view document when opened without a tab. */
export const CUSTOMIZE_DEFAULT_TAB = "plugins";

/** Document URI for the Customize editor (optionally pre-selecting a tab). */
export function customizeEditorUriForTab(tabId: string): vscode.Uri {
  return vscode.Uri.from({ scheme: CUSTOMIZE_EDITOR_SCHEME, path: `/${tabId}` });
}

/** Tab id from a Customize editor document URI (undefined for foreign/invalid URIs). */
export function customizeTabIdFromUri(uri: vscode.Uri): CustomizeSectionId | undefined {
  if (uri.scheme !== CUSTOMIZE_EDITOR_SCHEME) {
    return undefined;
  }
  const id = uri.path.replace(/^\//, "");
  if (!id || id.includes("/") || id === "." || id === ".." || id.includes("..")) {
    return undefined;
  }
  return isCustomizeSectionId(id) ? id : undefined;
}

// ---------------------------------------------------------------------------
// Section metadata — verbatim Cursor copy (dig-deeper-customize-view §3–§4)
// ---------------------------------------------------------------------------

export type CustomizeSectionId =
  | "plugins"
  | "mcps"
  | "skills"
  | "agents"
  | "rules"
  | "commands"
  | "hooks";

/** DD-CV-3: Subagents tab id is "agents"; MCPs label is "MCPs" (not "Tools & MCPs"). */
export interface CustomizeSectionMeta {
  id: CustomizeSectionId;
  /** Verbatim pill label. */
  label: string;
  /** Verbatim section title. */
  title: string;
  /** Verbatim section description. */
  description: string;
  /** Button variant: plugins gets primary "+ Add ▾" w/ 3-source menu; hooks gets no New. */
  action: "add-menu" | "new" | "log";
}

/** Verbatim pill order: Plugins → MCPs → Skills → Subagents → Rules → Commands → Hooks. */
export const CUSTOMIZE_SECTIONS: readonly CustomizeSectionMeta[] = [
  {
    id: "plugins",
    label: "Plugins",
    title: "Extend Cursor with Plugins",
    description:
      "Plugins bundle rules, skills, subagents, commands, MCP servers, and hooks into one installable package.",
    action: "add-menu",
  },
  {
    id: "mcps",
    label: "MCPs",
    title: "Connect External Tools with MCP",
    description:
      "Model Context Protocol servers connect Cursor to external tools and data sources like Linear, Figma, and Notion.",
    action: "new",
  },
  {
    id: "skills",
    label: "Skills",
    title: "Teach Cursor New Skills",
    description:
      "Skills package domain-specific knowledge and workflows that Agent applies automatically when relevant.",
    action: "new",
  },
  {
    id: "agents",
    label: "Subagents",
    title: "Delegate Work to Subagents",
    description:
      "Subagents are specialized assistants that run in their own context window so Agent can parallelize and stay focused.",
    action: "new",
  },
  {
    id: "rules",
    label: "Rules",
    title: "Guide Agent with Rules",
    description:
      "Rules give Agent persistent, system-level instructions for your coding standards and workflows.",
    action: "new",
  },
  {
    id: "commands",
    label: "Commands",
    title: "Create Reusable Commands",
    description:
      "Commands are reusable prompts you invoke with /name to standardize common workflows across your team.",
    action: "new",
  },
  {
    id: "hooks",
    label: "Hooks",
    title: "Automate with Hooks",
    description:
      "Hooks run custom scripts at lifecycle events to observe, control, and extend the agent loop.",
    action: "log",
  },
] as const;

export function isCustomizeSectionId(id: string): id is CustomizeSectionId {
  return CUSTOMIZE_SECTIONS.some((s) => s.id === id);
}

export function sectionMeta(id: CustomizeSectionId): CustomizeSectionMeta {
  const meta = CUSTOMIZE_SECTIONS.find((s) => s.id === id);
  // isCustomizeSectionId narrows at call sites; this is the fail-closed fallback.
  return meta ?? CUSTOMIZE_SECTIONS[0];
}

/** Per-tab open commands (Cursor binary: workbench.action.customize.open<Label>). */
export const CUSTOMIZE_OPEN_TAB_COMMANDS: Readonly<Record<CustomizeSectionId, string>> = {
  plugins: "workbench.action.customize.openPlugins",
  mcps: "workbench.action.customize.openMCPs",
  skills: "workbench.action.customize.openSkills",
  agents: "workbench.action.customize.openSubagents",
  rules: "workbench.action.customize.openRules",
  commands: "workbench.action.customize.openCommands",
  hooks: "workbench.action.customize.openHooks",
};

/**
 * DEV-GAPS-74: extension-owned aliases for the per-tab open commands.
 * The `workbench.action.customize.open*` ids are owned by workbench-core
 * Action2 classes (composerActions.ts), whose registrations shadow the
 * extension's same-id registrations — so the core actions delegate to
 * these `ide.customize.open*` aliases instead (same pattern as
 * `ide.openCustomize` for `workbench.action.openCustomizeEditor`).
 * Each alias opens this same real Customize editor on its section tab
 * via {@link openCustomizeEditor}.
 */
export const CUSTOMIZE_IDE_OPEN_TAB_COMMANDS: Readonly<Record<CustomizeSectionId, string>> = {
  plugins: "ide.customize.openPlugins",
  mcps: "ide.customize.openMCPs",
  skills: "ide.customize.openSkills",
  agents: "ide.customize.openSubagents",
  rules: "ide.customize.openRules",
  commands: "ide.customize.openCommands",
  hooks: "ide.customize.openHooks",
};

/** Search placeholder (verbatim — does not change per tab in this Cursor build). */
export const CUSTOMIZE_SEARCH_PLACEHOLDER = "Search Plugins, Skills, MCPs...";

// ---------------------------------------------------------------------------
// Migration banner — Settings → General ONLY
// (dig-deeper-customize-view §5; corrects detail-settings-2026-10-19 §1 which
// claimed the banner appears on all sections.)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Data model (host → webview)
// ---------------------------------------------------------------------------

/** Scope filter: "all" | "user" | "workspace:<fsPath>". Mirrors Cursor's Manage scope menu. */
export type CustomizeScope = string;
export const SCOPE_ALL = "all";
export const SCOPE_USER = "user";
export const scopeForWorkspace = (fsPath: string): CustomizeScope => `workspace:${fsPath}`;

export interface CustomizeMcpServer {
  id: string;
  name: string;
  scope: "user" | "workspace";
  state: string;
  toolCount: number;
  lastError?: string;
}

export interface CustomizeSkill {
  name: string;
  description: string;
  filePath: string;
  scope: "user" | "workspace";
}

export interface CustomizeRule {
  name: string;
  description: string;
  filePath: string;
  workspaceRoot: string;
  /**
   * GAPS-36D (rules-user): "mdc" = .cursor/rules file (workspace-level);
   * "user" = global User Rule stored in extension global storage (applies
   * to all of your chats — binary string, Cursor 3.25.9).
   */
  kind?: "mdc" | "user";
  /** Stable rule id for user rules (no file to open). */
  userRuleId?: string;
}

export interface CustomizeCommand {
  name: string;
  description: string;
  source: "workspace" | "personal";
  filePath: string;
}

/**
 * One installed extension, shown in the Plugins section. In this IDE,
 * plugins ARE extensions — vscode.extensions.all is the real backing store
 * (Cursor's Plugins tab lists its installed plugins the same way).
 */
export interface CustomizePlugin {
  /** Extension id, e.g. "publisher.name". */
  id: string;
  displayName: string;
  version: string;
  description: string;
}

/**
 * One engine subagent: a markdown agent definition ({agent,agents}/**\/*.md)
 * that the ide-code engine discovers from its config entries. Creating one
 * here writes a file the live engine picks up (it watches config entries).
 */
export interface CustomizeSubagent {
  /** File basename without .md. */
  name: string;
  description: string;
  filePath: string;
  scope: "user" | "workspace";
  /**
   * DEV-GAPS-40 (subagent-builtin): true for Cursor's built-in subagents
   * (explore, browser). Builtins have no backing file (filePath is ""),
   * cannot be deleted, and are always listed regardless of scope filter.
   */
  builtin?: boolean;
}

export interface CustomizeHookLogEntry {
  at: number;
  event: string;
  source: string;
  command: string;
  exitCode: number | null;
  durationMs: number;
  decision: string;
}

export interface CustomizeSnapshot {
  plugins: CustomizePlugin[];
  mcps: CustomizeMcpServer[];
  skills: CustomizeSkill[];
  agents: CustomizeSubagent[];
  rules: CustomizeRule[];
  commands: CustomizeCommand[];
  hookLog: CustomizeHookLogEntry[];
  hookConfiguredCount: number;
  workspaces: Array<{ fsPath: string; name: string }>;
  /** Which sections have real data vs placeholders (honest labeling). */
  dataSource: Record<CustomizeSectionId, "real" | "placeholder">;
}

/** Host-side dependencies, injected from extension.ts (keeps this module UI-only). */
export interface CustomizeHostDeps {
  getSnapshot(): CustomizeSnapshot;
  refreshSources(): void;
  clearHookLog(): void;
  openDocumentation(section: CustomizeSectionId): void;
  browseMarketplace(): void;
  /**
   * DEV-GAPS-5-SKILLS: Agent Skills Store actions from the Skills section
   * buttons (Install/Publish/Resync/Unpublish/Migrate). Optional so older
   * deps objects keep compiling; the host wires it to the ide.* skill
   * commands.
   */
  skillStoreAction?: (action: "install" | "publish" | "resync" | "unpublish" | "migrate") => void;
  /**
   * GAPS-36D (rules-user): open the "View User Rules" management flow
   * (editor.action.knowledgeBase.list). Optional so older deps objects keep
   * compiling.
   */
  openUserRule?: () => void;
  addPluginFrom(source: "marketplace" | "github" | "local"): void;
  /** Open the platform's extension editor for a plugin (real enable/disable/uninstall). */
  openPlugin(id: string): void;
  createMcp(): void;
  createSkill(): void;
  createSubagent(): void;
  createRule(): void;
  createCommand(): void;
  openItem(kind: "mcp" | "skill" | "rule" | "command" | "agent", filePath: string): void;
}

/** Minimal document — the Customize view is a singleton, owned by the provider. */
export class CustomizeEditorDocument implements vscode.CustomDocument {
  constructor(
    readonly uri: vscode.Uri,
    readonly initialTab: CustomizeSectionId,
  ) {}
  dispose(): void {
    // Singleton view; nothing to tear down per document.
  }
}

// ---------------------------------------------------------------------------
// Filtering (pure — unit tested)
// ---------------------------------------------------------------------------

/** Case-insensitive substring filter for the search box. */
export function sectionMatchesQuery(text: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) {
    return true;
  }
  return text.toLowerCase().includes(q);
}

/**
 * Filter one section's item rows by scope + search query. Returns whether the
 * section should show (landing always shows; this only gates item rows).
 */
export function filterMcpServers(
  servers: CustomizeMcpServer[],
  scope: CustomizeScope,
  query: string,
): CustomizeMcpServer[] {
  return servers.filter(
    (s) =>
      (scope === SCOPE_ALL ||
        (scope === SCOPE_USER && s.scope === "user") ||
        (scope.startsWith("workspace:") && s.scope === "workspace")) &&
      sectionMatchesQuery(`${s.name} ${s.id} ${s.state}`, query),
  );
}

export function filterSkills(
  skills: CustomizeSkill[],
  scope: CustomizeScope,
  query: string,
): CustomizeSkill[] {
  return skills.filter(
    (s) =>
      (scope === SCOPE_ALL ||
        (scope === SCOPE_USER && s.scope === "user") ||
        (scope.startsWith("workspace:") && s.scope === "workspace")) &&
      sectionMatchesQuery(`${s.name} ${s.description}`, query),
  );
}

export function filterRules(
  rules: CustomizeRule[],
  scope: CustomizeScope,
  query: string,
): CustomizeRule[] {
  return rules.filter(
    (r) =>
      (scope === SCOPE_ALL ||
        // GAPS-36D (rules-user): user rules are global — they show under the
        // User scope and under All.
        ((r.kind === "user" || r.userRuleId) && scope === SCOPE_USER) ||
        (r.kind !== "user" &&
          !r.userRuleId &&
          (scope === SCOPE_USER
            ? false // .mdc rules are workspace-level in this build
            : scope === scopeForWorkspace(r.workspaceRoot))) ||
        (scope.startsWith("workspace:") &&
          r.kind !== "user" &&
          scope === scopeForWorkspace(r.workspaceRoot))) &&
      sectionMatchesQuery(`${r.name} ${r.description}`, query),
  );
}

export function filterCommands(
  commands: CustomizeCommand[],
  scope: CustomizeScope,
  query: string,
): CustomizeCommand[] {
  return commands.filter(
    (c) =>
      (scope === SCOPE_ALL ||
        (scope === SCOPE_USER && c.source === "personal") ||
        (scope.startsWith("workspace:") && c.source === "workspace")) &&
      sectionMatchesQuery(`${c.name} ${c.description}`, query),
  );
}

export function filterHookLog(
  entries: CustomizeHookLogEntry[],
  _scope: CustomizeScope,
  query: string,
): CustomizeHookLogEntry[] {
  // The execution log is global — scope never partitions it; only the
  // search query filters rows.
  return entries.filter((e) =>
    sectionMatchesQuery(`${e.event} ${e.command} ${e.source}`, query),
  );
}

/**
 * Plugins are installed extensions — global to the IDE, so the scope pill
 * never partitions them (same treatment as the hook execution log); only
 * the search query filters rows.
 */
export function filterPlugins(plugins: CustomizePlugin[], query: string): CustomizePlugin[] {
  return plugins.filter((p) =>
    sectionMatchesQuery(`${p.displayName} ${p.id} ${p.description}`, query),
  );
}

export function filterSubagents(
  agents: CustomizeSubagent[],
  scope: CustomizeScope,
  query: string,
): CustomizeSubagent[] {
  return agents.filter(
    (a) =>
      // DEV-GAPS-40: builtins are product-level, not user/workspace —
      // the scope filter never partitions them (only the search query).
      (a.builtin ||
        scope === SCOPE_ALL ||
        (scope === SCOPE_USER && a.scope === "user") ||
        (scope.startsWith("workspace:") && a.scope === "workspace")) &&
      sectionMatchesQuery(`${a.name} ${a.description}`, query),
  );
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function itemRow(
  title: string,
  sub: string,
  badge: string,
  action: string,
  dataKind: string,
  dataId?: string,
): string {
  return (
    `<div class="cv-item" data-action="${action}" data-kind="${dataKind}"` +
    (dataId ? ` data-id="${esc(dataId)}"` : "") +
    `>` +
    `<div class="cv-item__main"><div class="cv-item__title">${esc(title)}</div>` +
    (sub ? `<div class="cv-item__sub">${esc(sub)}</div>` : "") +
    `</div><div class="cv-item__side"><span class="cv-badge">${esc(badge)}</span></div></div>`
  );
}

function sectionHtml(
  meta: CustomizeSectionMeta,
  rowsHtml: string,
  opts: { extraButtons?: string; after?: string; dataSource: "real" | "placeholder" },
): string {
  let actionBtn = "";
  if (meta.action === "add-menu") {
    // DD-CV-4: Plugins uses a PRIMARY "+ Add ▾" with a 3-source popup menu.
    actionBtn =
      `<div class="cv-menuwrap"><button class="cv-btn cv-btn--primary" data-action="toggle-add-menu" aria-haspopup="menu" aria-label="Add">+ Add <span aria-hidden="true">▾</span></button>` +
      `<div class="cv-menu" role="menu" hidden>` +
      `<button role="menuitem" data-action="add-plugin" data-source="marketplace">From Marketplace</button>` +
      `<button role="menuitem" data-action="add-plugin" data-source="github">From GitHub Repository</button>` +
      `<button role="menuitem" data-action="add-plugin" data-source="local">From Local Repository</button>` +
      `</div></div>`;
  } else if (meta.action === "new") {
    // DD-CV-4: every other section except Hooks uses a SECONDARY "New" button.
    actionBtn = `<button class="cv-btn cv-btn--secondary" data-action="new-item" data-section="${meta.id}">New</button>`;
  }
  const docBtn = `<button class="cv-btn cv-btn--outline" data-action="documentation" data-section="${meta.id}">Documentation</button>`;
  const sourceNote =
    opts.dataSource === "placeholder"
      ? `<div class="cv-source-note">Placeholder — management for this section is not wired up yet.</div>`
      : "";
  return (
    `<section class="cv-section" data-section="${meta.id}">` +
    `<h2 class="cv-title">${esc(meta.title)}</h2>` +
    `<p class="cv-desc">${esc(meta.description)}</p>` +
    `<div class="cv-actions">${actionBtn}${opts.extraButtons ?? ""}${docBtn}</div>` +
    sourceNote +
    (rowsHtml ? `<div class="cv-items">${rowsHtml}</div>` : "") +
    (opts.after ?? "") +
    `</section>`
  );
}

function hookLogHtml(entries: CustomizeHookLogEntry[]): string {
  const count = entries.length;
  const rows =
    entries.length === 0
      ? `<div class="cv-log-empty"><div class="cv-log-empty__t">No hook executions yet</div>` +
        `<div class="cv-log-empty__d">Hooks that run during the agent's loop will show up here.</div></div>`
      : entries
          .slice()
          .reverse()
          .slice(0, 200)
          .map(
            (e) =>
              `<div class="cv-logrow"><span class="cv-logrow__time">${esc(
                new Date(e.at).toLocaleTimeString(),
              )}</span><span class="cv-logrow__event">${esc(e.event)}</span>` +
              `<span class="cv-logrow__cmd">${esc(e.command || e.source)}</span>` +
              `<span class="cv-logrow__meta">${e.exitCode === null ? "running" : `exit ${e.exitCode}`} · ${e.durationMs}ms · ${esc(
                e.decision,
              )}</span></div>`,
          )
          .join("");
  return (
    `<div class="cv-logpanel"><div class="cv-logpanel__head"><h3>Execution Log</h3>` +
    `<span class="cv-count" aria-label="${count} hook executions">${count}</span></div>` +
    `<div class="cv-logrows">${rows}</div></div>`
  );
}

/**
 * The 7 section panes HTML (used by the full page and by host→webview
 * re-renders after data changes).
 */
export function createCustomizePanesHtml(
  snap: CustomizeSnapshot,
  activeTab: CustomizeSectionId,
  scope: CustomizeScope,
  query: string,
): string {
  const sections: Record<CustomizeSectionId, string> = {
    plugins: sectionHtml(
      sectionMeta("plugins"),
      filterPlugins(snap.plugins, query)
        .map((p) =>
          itemRow(
            p.displayName,
            p.description || p.id,
            p.version ? `v${p.version}` : "",
            "open-plugin",
            "plugin",
            p.id,
          ),
        )
        .join(""),
      { dataSource: snap.dataSource.plugins },
    ),
    mcps: sectionHtml(
      sectionMeta("mcps"),
      filterMcpServers(snap.mcps, scope, query)
        .map((s) =>
          itemRow(
            s.name,
            s.lastError ? `Error: ${s.lastError}` : `${s.toolCount} tool${s.toolCount === 1 ? "" : "s"}`,
            `${s.scope === "user" ? "User" : "Workspace"} · ${s.state}`,
            "open-item",
            "mcp",
          ),
        )
        .join(""),
      { dataSource: snap.dataSource.mcps },
    ),
    skills: sectionHtml(
      sectionMeta("skills"),
      filterSkills(snap.skills, scope, query)
        .map((s) =>
          itemRow(s.name, s.description, s.scope === "user" ? "User" : "Workspace", "open-item", "skill"),
        )
        .join(""),
      // DEV-GAPS-5-SKILLS: Agent Skills Store actions (Cursor's skill-store
      // command surface: install / publish / resync / unpublish / migrate).
      {
        dataSource: snap.dataSource.skills,
        extraButtons:
          `<button class="cv-btn cv-btn--outline cv-btn--tone-secondary" data-action="skill-store" data-store-action="install">Install</button>` +
          `<button class="cv-btn cv-btn--outline cv-btn--tone-secondary" data-action="skill-store" data-store-action="publish">Publish</button>` +
          `<button class="cv-btn cv-btn--outline cv-btn--tone-secondary" data-action="skill-store" data-store-action="resync">Resync</button>` +
          `<button class="cv-btn cv-btn--outline cv-btn--tone-secondary" data-action="skill-store" data-store-action="unpublish">Unpublish</button>` +
          `<button class="cv-btn cv-btn--outline cv-btn--tone-secondary" data-action="skill-store" data-store-action="migrate">Migrate</button>`,
      },
    ),
    agents: sectionHtml(
      sectionMeta("agents"),
      filterSubagents(snap.agents, scope, query)
        .map((a) =>
          itemRow(
            a.name,
            a.description || a.filePath,
            // DEV-GAPS-40: builtins carry a "Built-in" badge instead of a
            // scope badge — they are product-level, not user/workspace.
            a.builtin ? "Built-in" : a.scope === "user" ? "User" : "Workspace",
            "open-item",
            "agent",
          ),
        )
        .join(""),
      {
        dataSource: snap.dataSource.agents,
        // DEV-GAPS-40 (subagent-nested): Cursor's nesting rule, verbatim
        // from docs/rea/deep-docs-all.md ("Nested: main → subagent →
        // sub-subagent allowed (2.5+), one level"). The engine enforces it
        // via experimental.subagent_depth (IDE default 2 — see
        // subagentNesting.ts).
        after: `<div class="cv-note">Subagents can nest one level deep: a subagent may launch its own subagent, which cannot launch further.</div>`,
      },
    ),
    rules: sectionHtml(
      sectionMeta("rules"),
      filterRules(snap.rules, scope, query)
        .map((r) =>
          itemRow(
            r.name,
            r.description || r.filePath,
            r.kind === "user" || r.userRuleId ? "User" : "Workspace",
            "open-item",
            "rule",
            // GAPS-36D (rules-user): user rules carry their stable id so the
            // host can open the management flow instead of a file.
            r.userRuleId,
          ),
        )
        .join(""),
      { dataSource: snap.dataSource.rules },
    ),
    commands: sectionHtml(
      sectionMeta("commands"),
      filterCommands(snap.commands, scope, query)
        .map((c) =>
          itemRow(
            `/${c.name}`,
            c.description,
            c.source === "personal" ? "User" : "Workspace",
            "open-item",
            "command",
          ),
        )
        .join(""),
      { dataSource: snap.dataSource.commands },
    ),
    hooks: sectionHtml(sectionMeta("hooks"), "", {
      dataSource: snap.dataSource.hooks,
      extraButtons: `<button class="cv-btn cv-btn--outline cv-btn--tone-secondary" data-action="clear-hook-log">Clear log</button>`,
      after: hookLogHtml(filterHookLog(snap.hookLog, scope, query)),
    }),
  };

  return CUSTOMIZE_SECTIONS.map(
    (s) =>
      `<div class="cv-pane" data-pane="${s.id}"${s.id === activeTab ? "" : " hidden"}>${sections[s.id]}</div>`,
  ).join("");
}

/**
 * Full webview HTML. `activeTab` is the selected pill; `scope`/`query` are the
 * current header filter values. Item rows are pre-rendered host-side so the
 * view works even before its script boots.
 */
export function createCustomizeHtml(
  snap: CustomizeSnapshot,
  activeTab: CustomizeSectionId,
  scope: CustomizeScope,
  query: string,
): string {
  const pills = CUSTOMIZE_SECTIONS.map(
    (s) =>
      `<button class="cv-pill${s.id === activeTab ? " cv-pill--active" : ""}" role="tab" ` +
      `aria-selected="${s.id === activeTab}" data-action="switch-tab" data-tab="${s.id}" ` +
      `data-customize-manage-tab-id="${s.id}"><span class="cv-pill__label">${esc(s.label)}</span></button>`,
  ).join("");

  const scopeOptions =
    `<option value="${SCOPE_ALL}"${scope === SCOPE_ALL ? " selected" : ""}>All</option>` +
    `<option value="${SCOPE_USER}"${scope === SCOPE_USER ? " selected" : ""}>User</option>` +
    snap.workspaces
      .map(
        (w) =>
          `<option value="${esc(scopeForWorkspace(w.fsPath))}"${
            scope === scopeForWorkspace(w.fsPath) ? " selected" : ""
          }>${esc(w.name)}</option>`,
      )
      .join("");

  const sectionBlocks = createCustomizePanesHtml(snap, activeTab, scope, query);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; font-family: -apple-system, "Segoe UI", system-ui, sans-serif; font-size: 13px;
  color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); }
.cv { max-width: 860px; margin: 0 auto; padding: 20px 24px 48px; }
.cv-header { display: flex; gap: 10px; align-items: center; margin-bottom: 16px; flex-wrap: wrap; }
.cv-search { display: flex; align-items: center; gap: 8px; flex: 1 1 240px; min-width: 200px;
  border: 1px solid var(--vscode-input-border, rgba(128,128,128,.35)); border-radius: 999px;
  padding: 6px 14px; background: var(--vscode-input-background); }
.cv-search svg { flex: none; opacity: .6; }
.cv-search input { border: 0; outline: 0; background: transparent; color: inherit; width: 100%; font-size: 13px; }
.cv-scope { display: flex; align-items: center; gap: 6px; border: 1px solid var(--vscode-input-border, rgba(128,128,128,.35));
  border-radius: 999px; padding: 6px 12px; background: var(--vscode-input-background); }
.cv-scope select { border: 0; background: transparent; color: inherit; font-size: 13px; outline: none; max-width: 140px; }
.cv-btn { border: 1px solid transparent; border-radius: 999px; padding: 7px 16px; font-size: 13px;
  cursor: pointer; background: transparent; color: inherit; }
.cv-btn--primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.cv-btn--primary:hover { background: var(--vscode-button-hoverBackground); }
.cv-btn--secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
.cv-btn--secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
.cv-btn--outline { border-color: var(--vscode-input-border, rgba(128,128,128,.4)); }
.cv-btn--outline:hover { background: rgba(128,128,128,.12); }
.cv-btn--tone-secondary { opacity: .85; }
.cv-btn--sm { padding: 4px 12px; font-size: 12px; }
.cv-btn--tertiary { color: var(--vscode-textLink-foreground); }
.cv-btn--tertiary:hover { background: rgba(128,128,128,.12); }
.cv-pills { display: flex; gap: 4px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.25));
  margin-bottom: 20px; overflow-x: auto; }
.cv-pill { border: 0; background: transparent; color: inherit; padding: 8px 12px; cursor: pointer;
  font-size: 13px; border-bottom: 2px solid transparent; margin-bottom: -1px; white-space: nowrap; opacity: .75; }
.cv-pill:hover { opacity: 1; }
.cv-pill--active { opacity: 1; font-weight: 600; border-bottom-color: var(--vscode-button-background); }
.cv-title { font-size: 17px; margin: 0 0 8px; font-weight: 600; }
.cv-desc { margin: 0 0 14px; opacity: .8; line-height: 1.5; max-width: 640px; }
.cv-actions { display: flex; gap: 8px; margin-bottom: 18px; flex-wrap: wrap; }
.cv-source-note { font-size: 12px; opacity: .6; margin: -8px 0 14px; font-style: italic; }
.cv-items { display: flex; flex-direction: column; gap: 8px; }
.cv-item { display: flex; align-items: center; gap: 12px; border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.25));
  border-radius: 8px; padding: 10px 14px; cursor: pointer; }
.cv-item:hover { background: rgba(128,128,128,.08); }
.cv-item__main { flex: 1; min-width: 0; }
.cv-item__title { font-weight: 600; }
.cv-item__sub { font-size: 12px; opacity: .65; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cv-badge { font-size: 11px; opacity: .6; border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.3));
  border-radius: 999px; padding: 2px 8px; white-space: nowrap; }
.cv-menuwrap { position: relative; }
.cv-menu { position: absolute; top: calc(100% + 4px); left: 0; z-index: 10; min-width: 220px;
  background: var(--vscode-menu-background); border: 1px solid var(--vscode-menu-border, rgba(128,128,128,.3));
  border-radius: 8px; padding: 4px; box-shadow: 0 8px 24px rgba(0,0,0,.25); }
.cv-menu button { display: block; width: 100%; text-align: left; border: 0; background: transparent; color: inherit;
  padding: 8px 12px; border-radius: 6px; cursor: pointer; font-size: 13px; }
.cv-menu button:hover { background: var(--vscode-menu-selectionBackground); color: var(--vscode-menu-selectionForeground); }
.cv-logpanel { margin-top: 20px; border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.25)); border-radius: 8px; }
.cv-logpanel__head { display: flex; align-items: center; gap: 8px; padding: 10px 14px;
  border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.25)); }
.cv-logpanel__head h3 { margin: 0; font-size: 13px; font-weight: 600; }
.cv-count { font-size: 11px; min-width: 20px; text-align: center; border-radius: 999px;
  background: rgba(128,128,128,.18); padding: 2px 8px; }
.cv-logrows { max-height: 320px; overflow-y: auto; }
.cv-logrow { display: flex; gap: 12px; padding: 8px 14px; font-size: 12px; border-bottom: 1px solid rgba(128,128,128,.12);
  font-family: var(--vscode-editor-font-family, monospace); }
.cv-logrow:last-child { border-bottom: 0; }
.cv-logrow__time { opacity: .55; flex: none; }
.cv-logrow__event { flex: none; min-width: 120px; font-weight: 600; }
.cv-logrow__cmd { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: .8; }
.cv-logrow__meta { flex: none; opacity: .55; }
.cv-log-empty { padding: 28px 14px; text-align: center; }
.cv-log-empty__t { font-weight: 600; margin-bottom: 6px; }
.cv-log-empty__d { font-size: 12px; opacity: .65; }
.cv-banner { display: flex; gap: 12px; align-items: center; justify-content: space-between;
  border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.3)); border-radius: 8px;
  padding: 12px 16px; margin-bottom: 16px; }
.cv-banner__title { font-weight: 600; margin-bottom: 2px; }
.cv-banner__desc { font-size: 12px; opacity: .7; }
.cv-banner__actions { display: flex; gap: 8px; flex: none; }
</style>
</head>
<body>
<div class="cv" role="main" aria-label="Customize">
  <div class="cv-header">
    <label class="cv-search" aria-label="${esc(CUSTOMIZE_SEARCH_PLACEHOLDER)}">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M11.7 10.3l3.1 3.1-1.4 1.4-3.1-3.1a5 5 0 1 1 1.4-1.4zM7 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z"/></svg>
      <input id="cv-search" type="search" placeholder="${esc(CUSTOMIZE_SEARCH_PLACEHOLDER)}" value="${esc(query)}" aria-label="${esc(CUSTOMIZE_SEARCH_PLACEHOLDER)}">
    </label>
    <button class="cv-btn cv-btn--primary" data-action="browse-marketplace" aria-label="Browse Marketplace">Browse Marketplace</button>
    <label class="cv-scope" aria-label="Manage scope">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 1.2c.9 0 1.8.7 2.4 1.9.3.7.6 1.5.7 2.4H4.9c.1-.9.4-1.7.7-2.4.6-1.2 1.5-1.9 2.4-1.9zM4.4 6.5h7.2c.1.5.2 1 .2 1.5s-.1 1-.2 1.5H4.4c-.1-.5-.2-1-.2-1.5s.1-1 .2-1.5zM8 14.8c-.9 0-1.8-.7-2.4-1.9-.3-.7-.6-1.5-.7-2.4h6.2c-.1.9-.4 1.7-.7 2.4-.6 1.2-1.5 1.9-2.4 1.9z"/></svg>
      <select id="cv-scope" aria-label="Manage scope">${scopeOptions}</select>
    </label>
  </div>
  <div class="cv-pills" role="tablist" aria-label="Customize sections">${pills}</div>
  ${sectionBlocks}
</div>
<script>
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  function post(type, extra) { vscode.postMessage(Object.assign({ type }, extra || {})); }

  // Pill tab switching (client-side; host persists nothing per tab).
  $$('[data-action="switch-tab"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.getAttribute("data-tab");
      $$(".cv-pill").forEach((p) => {
        const on = p.getAttribute("data-tab") === tab;
        p.classList.toggle("cv-pill--active", on);
        p.setAttribute("aria-selected", on ? "true" : "false");
      });
      $$(".cv-pane").forEach((pane) => {
        pane.hidden = pane.getAttribute("data-pane") !== tab;
      });
      post("switchTab", { tab });
    });
  });

  // Search + scope re-render host-side (host re-sends filtered rows).
  const search = $("#cv-search");
  let searchTimer = null;
  search.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => post("search", { query: search.value }), 180);
  });
  $("#cv-scope").addEventListener("change", (e) => post("scope", { scope: e.target.value }));

  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-action]");
    // Close the Add menu when clicking elsewhere.
    if (!el || el.getAttribute("data-action") !== "toggle-add-menu") {
      $$(".cv-menu").forEach((m) => (m.hidden = true));
    }
    if (!el) return;
    const action = el.getAttribute("data-action");
    if (action === "toggle-add-menu") {
      const menu = el.parentElement.querySelector(".cv-menu");
      menu.hidden = !menu.hidden;
    } else if (action === "add-plugin") {
      post("addPlugin", { source: el.getAttribute("data-source") });
    } else if (action === "browse-marketplace") {
      post("browseMarketplace", {});
    } else if (action === "new-item") {
      post("newItem", { section: el.getAttribute("data-section") });
    } else if (action === "documentation") {
      post("documentation", { section: el.getAttribute("data-section") });
    } else if (action === "clear-hook-log") {
      post("clearHookLog", {});
    } else if (action === "skill-store") {
      // DEV-GAPS-5-SKILLS: Skills section store buttons.
      post("skillStoreAction", { storeAction: el.getAttribute("data-store-action") });
    } else if (action === "open-item") {
      const row = el.closest(".cv-item");
      post("openItem", {
        kind: row.getAttribute("data-kind"),
        title: row.querySelector(".cv-item__title").textContent,
        // GAPS-36D (rules-user): user-rule rows carry their stable id so the
        // host opens the management flow instead of a file.
        id: row.getAttribute("data-id"),
      });
    } else if (action === "open-plugin") {
      const row = el.closest(".cv-item");
      post("openPlugin", { id: row.getAttribute("data-id") });
    } else if (action === "dismiss-banner") {
      post("dismissBanner", {});
    } else if (action === "open-customize") {
      post("openCustomize", {});
    }
  });

  window.addEventListener("message", (event) => {
    const msg = event.data || {};
    if (msg.type === "rerender") {
      // Host sends fresh section HTML after data changes (new/clear/refresh).
      const tmp = document.createElement("div");
      tmp.innerHTML = msg.html;
      $$(".cv-pane").forEach((pane) => {
        const id = pane.getAttribute("data-pane");
        const fresh = tmp.querySelector('[data-pane="' + id + '"]');
        if (fresh) pane.innerHTML = fresh.innerHTML;
      });
      if (typeof msg.hookCount === "number") {
        const badge = document.querySelector(".cv-logpanel .cv-count");
        if (badge) {
          badge.textContent = String(msg.hookCount);
          badge.setAttribute("aria-label", msg.hookCount + " hook executions");
        }
      }
    } else if (msg.type === "selectTab" && msg.tab) {
      const btn = document.querySelector('[data-action="switch-tab"][data-tab="' + msg.tab + '"]');
      if (btn) btn.click();
    }
  });

  post("webviewReady", {});
})();
</script>
</body>
</html>`;
}

type CustomizeWebviewMessage =
  | { type: "webviewReady" }
  | { type: "switchTab"; tab: string }
  | { type: "search"; query: string }
  | { type: "scope"; scope: string }
  | { type: "newItem"; section: string }
  | { type: "documentation"; section: string }
  | { type: "addPlugin"; source: string }
  | { type: "browseMarketplace" }
  | { type: "clearHookLog" }
  // DEV-GAPS-5-SKILLS: Agent Skills Store action buttons (install / publish /
  // resync / unpublish / migrate). storeAction is validated on the host side
  // before being forwarded to the deps handler.
  | { type: "skillStoreAction"; storeAction: string }
  | { type: "openItem"; kind: string; title: string; id?: string | null }
  | { type: "openPlugin"; id: string }
  | { type: "dismissBanner" }
  | { type: "openCustomize" };

class CustomizeEditorHost implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;
  private readonly pendingOutbound: unknown[] = [];
  private static readonly MAX_PENDING_OUTBOUND = 100;
  private webviewReady = false;
  private activeTab: CustomizeSectionId;
  private scope: CustomizeScope = SCOPE_ALL;
  private query = "";

  constructor(
    private readonly document: CustomizeEditorDocument,
    private readonly panel: vscode.WebviewPanel,
    private readonly deps: CustomizeHostDeps,
  ) {
    this.activeTab = document.initialTab;
  }

  resolve(): void {
    const { panel } = this;
    panel.webview.options = { enableScripts: true };
    panel.title = "Customize";
    this.render();
    this.disposables.push(
      panel.webview.onDidReceiveMessage((message: CustomizeWebviewMessage) => {
        if (!this.disposed) {
          this.handleMessage(message);
        }
      }),
      panel.onDidDispose(() => this.dispose()),
    );
  }

  private render(): void {
    this.panel.webview.html = createCustomizeHtml(
      this.deps.getSnapshot(),
      this.activeTab,
      this.scope,
      this.query,
    );
  }

  /** Re-render panes after data changes (New / Clear log / external refresh). */
  private rerender(): void {
    const snap = this.deps.getSnapshot();
    this.postToWebview({
      type: "rerender",
      html: createCustomizePanesHtml(snap, this.activeTab, this.scope, this.query),
      hookCount: snap.hookLog.length,
    });
  }

  /** Select a pill tab programmatically (per-tab open commands). */
  selectTab(tab: CustomizeSectionId): void {
    this.activeTab = tab;
    this.postToWebview({ type: "selectTab", tab });
  }

  private postToWebview(message: unknown): void {
    if (this.disposed) {
      return;
    }
    if (this.webviewReady) {
      void this.panel.webview.postMessage(message);
    } else {
      if (this.pendingOutbound.length >= CustomizeEditorHost.MAX_PENDING_OUTBOUND) {
        this.pendingOutbound.shift();
      }
      this.pendingOutbound.push(message);
    }
  }

  private handleMessage(message: CustomizeWebviewMessage): void {
    switch (message.type) {
      case "webviewReady":
        this.webviewReady = true;
        for (const pending of this.pendingOutbound.splice(0)) {
          void this.panel.webview.postMessage(pending);
        }
        break;
      case "switchTab":
        if (typeof message.tab === "string" && isCustomizeSectionId(message.tab)) {
          this.activeTab = message.tab;
        }
        break;
      case "search":
        this.query = typeof message.query === "string" ? message.query : "";
        // Pane-only re-render: a full reload would drop search-box focus on
        // every keystroke.
        this.rerender();
        break;
      case "scope":
        this.scope = typeof message.scope === "string" ? message.scope : SCOPE_ALL;
        this.rerender();
        break;
      case "newItem":
        if (message.section === "mcps") {
          this.deps.createMcp();
        } else if (message.section === "skills") {
          this.deps.createSkill();
        } else if (message.section === "agents") {
          this.deps.createSubagent();
        } else if (message.section === "rules") {
          this.deps.createRule();
        } else if (message.section === "commands") {
          this.deps.createCommand();
        }
        // Host refreshes data sources, then re-renders.
        this.deps.refreshSources();
        this.rerender();
        break;
      case "documentation":
        if (typeof message.section === "string" && isCustomizeSectionId(message.section)) {
          this.deps.openDocumentation(message.section);
        }
        break;
      case "addPlugin":
        if (
          message.source === "marketplace" ||
          message.source === "github" ||
          message.source === "local"
        ) {
          this.deps.addPluginFrom(message.source);
        }
        break;
      case "browseMarketplace":
        this.deps.browseMarketplace();
        break;
      case "clearHookLog":
        this.deps.clearHookLog();
        this.rerender();
        break;
      case "skillStoreAction":
        // DEV-GAPS-5-SKILLS: Skills section store buttons.
        if (
          typeof message.storeAction === "string" &&
          (message.storeAction === "install" ||
            message.storeAction === "publish" ||
            message.storeAction === "resync" ||
            message.storeAction === "unpublish" ||
            message.storeAction === "migrate")
        ) {
          this.deps.skillStoreAction?.(message.storeAction);
          this.deps.refreshSources();
          this.rerender();
        }
        break;
      case "openItem":
        if (
          typeof message.kind === "string" &&
          typeof message.title === "string" &&
          (message.kind === "mcp" ||
            message.kind === "skill" ||
            message.kind === "rule" ||
            message.kind === "command" ||
            message.kind === "agent")
        ) {
          this.openItemByTitle(
            message.kind,
            message.title,
            typeof message.id === "string" && message.id ? message.id : undefined,
          );
        }
        break;
      case "openPlugin":
        if (typeof message.id === "string" && message.id) {
          this.deps.openPlugin(message.id);
        }
        break;
    }
  }

  private openItemByTitle(
    kind: "mcp" | "skill" | "rule" | "command" | "agent",
    title: string,
    itemId?: string,
  ): void {
    // GAPS-36D (rules-user): a user rule has no file — open the "View User
    // Rules" management flow (editor.action.knowledgeBase.list) instead.
    if (kind === "rule" && itemId) {
      this.deps.openUserRule?.();
      return;
    }
    const snap = this.deps.getSnapshot();
    const clean = title.startsWith("/") ? title.slice(1) : title;
    let filePath: string | undefined;
    if (kind === "skill") {
      filePath = snap.skills.find((s) => s.name === clean)?.filePath;
    } else if (kind === "rule") {
      filePath = snap.rules.find((r) => r.name === clean)?.filePath;
    } else if (kind === "command") {
      filePath = snap.commands.find((c) => c.name === clean)?.filePath;
    } else if (kind === "agent") {
      const agent = snap.agents.find((a) => a.name === clean);
      // DEV-GAPS-40 (subagent-builtin): builtins have no backing file —
      // tell the user how to invoke them instead of opening anything.
      if (agent?.builtin) {
        void vscode.window.showInformationMessage(
          `IDE Agent: "${agent.name}" is a built-in subagent. Invoke it with /${agent.name} <task> in the chat.`,
          "OK",
        );
        return;
      }
      filePath = agent?.filePath;
    } else {
      // MCP servers live in mcp.json — open the config file.
      filePath = undefined;
    }
    if (kind === "mcp" || !filePath) {
      this.deps.createMcp(); // opens the mcp.json config (also the "New" path)
      return;
    }
    this.deps.openItem(kind, filePath);
  }

  dispose(): void {
    this.disposed = true;
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

export class CustomizeEditorProvider implements vscode.CustomEditorProvider<CustomizeEditorDocument> {
  private host: CustomizeEditorHost | undefined;

  constructor(private readonly deps: CustomizeHostDeps) {}

  async openCustomDocument(
    uri: vscode.Uri,
    _openContext: vscode.CustomDocumentOpenContext,
    _token: vscode.CancellationToken,
  ): Promise<CustomizeEditorDocument> {
    // Singleton view: any ide-customize:/ URI resolves to the same document.
    const tab = customizeTabIdFromUri(uri) ?? CUSTOMIZE_DEFAULT_TAB;
    return new CustomizeEditorDocument(customizeEditorUriForTab(CUSTOMIZE_DEFAULT_TAB), tab);
  }

  async resolveCustomEditor(
    document: CustomizeEditorDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    // Singleton: re-resolving an already-open view just re-renders it.
    if (this.host) {
      this.host.dispose();
    }
    const host = new CustomizeEditorHost(document, webviewPanel, this.deps);
    this.host = host;
    webviewPanel.onDidDispose(() => {
      if (this.host === host) {
        this.host = undefined;
      }
    });
    host.resolve();
  }

  /** Programmatically select a pill tab in the open view (per-tab commands). */
  selectTab(tab: CustomizeSectionId): void {
    this.host?.selectTab(tab);
  }

  onDidChangeCustomDocument = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<CustomizeEditorDocument>>().event;
  saveCustomDocument = async (): Promise<void> => undefined;
  saveCustomDocumentAs = async (): Promise<void> => undefined;
  revertCustomDocument = async (): Promise<void> => undefined;
  backupCustomDocument = async (): Promise<vscode.CustomDocumentBackup> => ({
    id: "",
    delete: () => undefined,
  });
}

/**
 * Open (or focus — same URI, so no duplicate) the Customize editor tab,
 * optionally pre-selecting a pill tab.
 */
export async function openCustomizeEditor(
  provider: CustomizeEditorProvider,
  tabId?: CustomizeSectionId,
): Promise<void> {
  await vscode.commands.executeCommand(
    "vscode.openWith",
    customizeEditorUriForTab(CUSTOMIZE_DEFAULT_TAB),
    CUSTOMIZE_EDITOR_VIEW_TYPE,
  );
  if (tabId) {
    provider.selectTab(tabId);
  }
}
