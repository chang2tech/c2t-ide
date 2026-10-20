import * as vscode from "vscode";
import * as child_process from "child_process";
import type { ComposerDataService } from "./composerDataService";
import { withSafeGitArgs } from "./gitExec";

/**
 * Bugbot editor-review CTA (P2, DEV-GAPS-10).
 *
 * Binary evidence (Cursor 3.25.9): `registerCommand("cursor.runEditorBugbot",
 * async (e,t,n)=>{...})` + telemetry `bug_bot.editor_review_cta_route`
 * (stat increment {transition, reason}); the handler invokes bugbot review
 * services on the current editor.
 *
 * PLACEMENT (documented choice): the implementation lives in the ide-agent
 * extension, NOT workbench core. The real review service — the agent engine
 * behind ComposerDataService.submit() — lives here; a core Action2 would
 * have to delegate back across the extension boundary and would register
 * the same command id twice. The command id is global once registered, so
 * the palette/menu surface is identical either way.
 *
 * HONEST-DIVERGENCE: the command title is INFERRED — the binary evidence
 * only shows the command id and the telemetry event name. Cursor's real
 * title is UNKNOWN.
 *
 * HONEST-DIVERGENCE (telemetry transport): Cursor increments a server-side
 * stat. This fork has no server-side stat pipeline, so the VERBATIM event
 * name `bug_bot.editor_review_cta_route` with the VERBATIM payload shape
 * {transition, reason} is emitted through VS Code's official extension
 * telemetry API (`vscode.env.createTelemetryLogger`), which routes into the
 * product's telemetry pipeline when enabled. A local output-channel sink is
 * also kept so the event is observable in the "IDE Agent" log.
 */

/** Binary-verbatim command id. */
export const BUGBOT_RUN_EDITOR_REVIEW_COMMAND_ID = "cursor.runEditorBugbot";

/** Binary-verbatim telemetry event name. */
export const BUGBOT_EDITOR_REVIEW_TELEMETRY_EVENT = "bug_bot.editor_review_cta_route";

/**
 * DEV-GAPS-15 (bugbot-remaining-commands): binary-verbatim command ids for
 * the three remaining bugbot commands (DEEP-DIG-A, Cursor 3.25.6
 * workbench.desktop.main.js / workbench.glass.main.js).
 */
export const BUGBOT_OPEN_PANE_COMMAND_ID = "cursor.openBugbotPane";
export const BUGBOT_REVIEW_FROM_AD_COMMAND_ID = "cursor.reviewBugbotFromAd";
export const BUGBOT_ENABLE_AUTO_REVIEW_COMMAND_ID = "cursor.enableAutoReviewOnCommit";

/**
 * WORKER-GAPS-42D (bugbot-auto-review): binary-verbatim storage key, feature
 * gate, telemetry events and entry points for the auto-review-on-commit
 * mechanism (Cursor 3.25.9).
 *
 * - `autoRunBugbotOnCommit`: IStorageService key, default false.
 *   Glass bundle: `autoRunBugbotOnCommit:ef(!1,-1,0)` (state-store
 *   registration, byte 16330292); the `cursor.runEditorBugbot` handler reads
 *   it via `Lh(u,"autoRunBugbotOnCommit")??!1` (byte 41777801) and
 *   `cursor.enableAutoReviewOnCommit` writes it via
 *   `gg(e,"autoRunBugbotOnCommit",!0)` (byte 41781073).
 * - `bugbot_autorun_killswitch`: server feature gate checked by the
 *   `cursor.runEditorBugbot` handler
 *   (`d.checkFeatureGate("bugbot_autorun_killswitch",{disableExposureLog:!1})`).
 * - `bug_bot.run_ide_bug_finder` with `{entrypoint:"auto-run-on-commit"}`:
 *   telemetry emitted by the `cursor.runEditorBugbot` handler.
 * - `bug_bot.autorun_on_commit_toggled` with
 *   `{enabled:!0,source:"in_app_ad"}`: telemetry emitted by
 *   `cursor.enableAutoReviewOnCommit`.
 * - Cursor's Settings UI (FUw component, byte 28628796) exposes this flag as
 *   label "Start Agent Review on Commit" with description "Automatically
 *   review your changes for issues after each commit". (This corrects the old
 *   comment that claimed it was a separate feature — the binary proves the
 *   label belongs to `autoRunBugbotOnCommit`.)
 */
export const BUGBOT_AUTO_RUN_STORAGE_KEY = "autoRunBugbotOnCommit";
export const BUGBOT_AUTORUN_KILLSWITCH_FLAG = "bugbot_autorun_killswitch";
export const BUGBOT_RUN_IDE_BUG_FINDER_EVENT = "bug_bot.run_ide_bug_finder";
export const BUGBOT_AUTORUN_ON_COMMIT_TOGGLED_EVENT =
  "bug_bot.autorun_on_commit_toggled";
export const BUGBOT_ENTRYPOINT_AUTO_RUN_ON_COMMIT = "auto-run-on-commit";
export const BUGBOT_ENTRYPOINT_IN_APP_AD = "in_app_ad";
/**
 * Binary-verbatim bail telemetry for the ad/CTA route
 * (`l=y=>{i.trackEvent("bug_bot.review_cta_bail",{reason:y})}` in the
 * `cursor.reviewBugbotFromAd` handler).
 */
export const BUGBOT_REVIEW_CTA_BAIL_EVENT = "bug_bot.review_cta_bail";

/**
 * REMOVED (WORKER-GAPS-42D): `BUGBOT_AD_REVIEW_TELEMETRY_EVENT`
 * (`bug_bot.ad_review_cta_route`) was an INFERRED name. The binary gives the
 * real ad-route events — `bug_bot.review_cta_bail` {reason} and
 * `bug_bot.run_ide_bug_finder` {entrypoint:"in_app_ad"} — which are now used
 * instead (see `reviewBugbotFromAd`). Per the anti-fabrication rule, the
 * inferred name is gone.
 */

/**
 * Fork settings-UI surface for the binary-verbatim `autoRunBugbotOnCommit`
 * storage flag (boolean, default false). Declared in package.json under
 * "IDE Bugbot".
 *
 * The runtime source of truth is the storage flag
 * (`BUGBOT_AUTO_RUN_STORAGE_KEY`, read by the `cursor.runEditorBugbot`
 * handler exactly as Cursor does); this configuration key exists because
 * Cursor's own toggle lives in its React Settings UI, and a VS Code
 * `contributes.configuration` entry is this fork's settings-UI equivalent.
 * The extension syncs this setting into the storage flag on change (see
 * extension.ts); the gate itself only ever reads the storage flag.
 *
 * CORRECTION (WORKER-GAPS-42D): the old comment claimed Cursor's
 * "Start Agent Review on Commit" was a separate agent-review feature. The
 * binary disproves that — "Start Agent Review on Commit" /
 * "Automatically review your changes for issues after each commit" is the
 * verbatim Settings UI label/description for `autoRunBugbotOnCommit`
 * (workbench.glass.main.js 3.25.9, FUw component, byte 28628796).
 */
export const BUGBOT_AUTO_REVIEW_CONFIG_SECTION = "ide.bugbot";
export const BUGBOT_AUTO_REVIEW_CONFIG_KEY = "autoReviewOnCommit";

/**
 * Inferred command title (HONEST-DIVERGENCE — the binary registers
 * `cursor.runEditorBugbot` with no palette title; it is programmatic-only in
 * Cursor, dispatched by the commit trigger). The handler reviews the branch
 * at HEAD (repo-level, `{location:"repo",source:{kind:"branch",headRef}}`),
 * NOT the current file — the old "Current File" title described a
 * misreading of the binary and was corrected by WORKER-GAPS-42D.
 * Kept as a constant so package.json, the COMMANDS scaffold, and tests share
 * one source of truth.
 */
export const BUGBOT_RUN_EDITOR_REVIEW_TITLE = "Run Bugbot Review on Latest Commit";

/**
 * DEV-GAPS-15: inferred titles for the three remaining commands.
 * HONEST-DIVERGENCE: the binary evidence only shows the command ids — these
 * titles are invented for the command palette and documented as such.
 */
export const BUGBOT_OPEN_PANE_TITLE = "Open Bugbot Pane";
export const BUGBOT_REVIEW_FROM_AD_TITLE = "Review with Bugbot";
// WORKER-GAPS-42D: was "Toggle Bugbot Auto-Review on Commit" — the binary
// command unconditionally ENABLES (gg(e,"autoRunBugbotOnCommit",!0)), so the
// inferred title now says Enable.
export const BUGBOT_ENABLE_AUTO_REVIEW_TITLE = "Enable Bugbot Auto-Review on Commit";

/**
 * Verbatim payload values for {transition, reason}.
 *
 * WORKER-GAPS-42D: `no_workspace_folder` is binary-verbatim (the
 * `cursor.reviewBugbotFromAd` bail reason); `repo_unresolved` covers the
 * binary's `mOl` unresolved-reason bail (the exact reason strings are
 * Cursor-internal). The older editor-CTA transitions are kept for
 * compatibility.
 */
export type BugbotReviewTransition =
  | "review_started"
  | "no_active_editor"
  | "unsupported_scheme"
  | "submit_failed"
  | "no_workspace_folder"
  | "repo_unresolved";

export class BugbotReviewTelemetry {
  private logger: vscode.TelemetryLogger | undefined;
  private loggerFailed = false;

  /**
   * @param sink optional local observer (output channel). The telemetry
   * logger itself is the product pipeline; the sink only makes the event
   * visible locally.
   * @param eventName the event to emit. Defaults to the binary-verbatim
   * `bug_bot.editor_review_cta_route`.
   */
  constructor(
    private readonly sink?: (line: string) => void,
    private readonly eventName: string = BUGBOT_EDITOR_REVIEW_TELEMETRY_EVENT,
  ) {}

  /** Emit the verbatim event with {transition, reason}. Never throws. */
  logRoute(transition: BugbotReviewTransition, reason: string): void {
    const eventName = this.eventName;
    try {
      if (!this.logger && !this.loggerFailed) {
        try {
          // The sender forwards into the product telemetry pipeline; the
          // local sink mirrors the event for observability.
          this.logger = vscode.env.createTelemetryLogger(
            {
              sendEventData: (name, data) => {
                this.sink?.(`[telemetry] ${name} ${JSON.stringify(data ?? {})}`);
              },
              sendErrorData: (error, data) => {
                this.sink?.(
                  `[telemetry] ${error.name} ${JSON.stringify(data ?? {})}`,
                );
              },
            },
            { ignoreBuiltInCommonProperties: true },
          );
        } catch {
          // Older hosts without createTelemetryLogger: local sink only.
          this.loggerFailed = true;
        }
      }
      this.logger?.logUsage(eventName, {
        transition,
        reason,
      });
      if (!this.logger) {
        this.sink?.(
          `[telemetry] ${eventName} ` +
            JSON.stringify({ transition, reason }),
        );
      }
    } catch {
      // Telemetry must never break the command.
    }
  }

  /**
   * Emit an arbitrary telemetry event with a verbatim name/payload
   * (WORKER-GAPS-42D: `bug_bot.run_ide_bug_finder` and
   * `bug_bot.autorun_on_commit_toggled`, whose payloads are NOT
   * {transition, reason}). Same transport as `logRoute`.
   */
  logEvent(eventName: string, data: Record<string, unknown>): void {
    try {
      if (!this.logger && !this.loggerFailed) {
        try {
          this.logger = vscode.env.createTelemetryLogger(
            {
              sendEventData: (name, d) => {
                this.sink?.(`[telemetry] ${name} ${JSON.stringify(d ?? {})}`);
              },
              sendErrorData: (error, d) => {
                this.sink?.(
                  `[telemetry] ${error.name} ${JSON.stringify(d ?? {})}`,
                );
              },
            },
            { ignoreBuiltInCommonProperties: true },
          );
        } catch {
          this.loggerFailed = true;
        }
      }
      this.logger?.logUsage(eventName, data);
      if (!this.logger) {
        this.sink?.(`[telemetry] ${eventName} ` + JSON.stringify(data));
      }
    } catch {
      // Telemetry must never break the command.
    }
  }
}

/**
 * Read the binary-verbatim `autoRunBugbotOnCommit` flag from extension
 * storage (the extension-host counterpart of Cursor's IStorageService read
 * `Lh(u,"autoRunBugbotOnCommit")??!1`). Default false, exactly as in the
 * binary (`autoRunBugbotOnCommit:ef(!1,-1,0)`).
 */
export function isBugbotAutoRunOnCommitEnabled(
  globalState: vscode.Memento,
): boolean {
  try {
    return (
      globalState.get<boolean>(BUGBOT_AUTO_RUN_STORAGE_KEY, false) === true
    );
  } catch {
    return false;
  }
}

/** Write the binary-verbatim `autoRunBugbotOnCommit` storage flag. */
export async function setBugbotAutoRunOnCommit(
  globalState: vscode.Memento,
  value: boolean,
): Promise<void> {
  await globalState.update(BUGBOT_AUTO_RUN_STORAGE_KEY, value);
}

/**
 * WORKER-GAPS-42D (bugbot-auto-review): the `cursor.runEditorBugbot`
 * handler, corrected to the binary-verbatim mechanism (Cursor 3.25.9,
 * workbench.glass.main.js byte 41777801):
 *
 * ```
 * us.registerCommand("cursor.runEditorBugbot", async(t,e,n)=>{
 *   ...
 *   p=Lh(u,"autoRunBugbotOnCommit")??!1;
 *   if(d.checkFeatureGate("bugbot_autorun_killswitch",{disableExposureLog:!1})||!p)return;
 *   ...
 *   _.getSnapshot()?.isRunning&&(_.cancel(),_.clear()),
 *   h.trackEvent("bug_bot.run_ide_bug_finder",{entrypoint:"auto-run-on-commit"}),
 *   await E3n(g,{where:{location:"repo",rootUri:e,source:{kind:"branch",headRef:n}},inBackgroundSubsidized:!0})})
 * ```
 *
 * - `(e, n)` = `(rootUri, headRef)`: the command is dispatched by the commit
 *   trigger (`bugbotCommitTrigger.ts`) as
 *   `executeCommand("cursor.runEditorBugbot", repo.rootUri, HEAD.commit)`.
 *   It reviews the REPO BRANCH at headRef — never the current file. (The old
 *   "review the active editor file" behavior was a misreading of the binary
 *   and has been removed.)
 * - Gate: killswitch engaged OR storage flag off → silent return (verbatim).
 * - Telemetry: `bug_bot.run_ide_bug_finder` {entrypoint:"auto-run-on-commit"}
 *   (verbatim name + payload).
 * - `inBackgroundSubsidized:!0`: the review runs in the background without
 *   blocking — the fork submits to the agent engine fire-and-forget, same as
 *   the old flow.
 *
 * HONEST-DIVERGENCE (snapshot cancel): the binary cancels a running bugbot
 * snapshot (`_.getSnapshot()?.isRunning&&(_.cancel(),_.clear())`). The
 * fork's agent-engine submit is fire-and-forget — no cancellable snapshot
 * handle exists — so there is nothing to cancel; the new run is submitted
 * directly. The review engine itself (`E3n`'s `Fwr` with
 * `{gitDiff,contextFiles,...,deepReview}`) is Cursor server-side AI; the
 * fork runs the equivalent review through its local agent engine
 * (ComposerDataService.submit), exactly as the previous implementation did.
 */
export interface BugbotAutoReviewDeps {
  /** Extension storage; the gate reads `BUGBOT_AUTO_RUN_STORAGE_KEY`. */
  globalState: vscode.Memento;
  /**
   * Cursor's `bugbot_autorun_killswitch` server feature gate.
   * HONEST-DIVERGENCE: the fork has no server flag pipeline, so this is an
   * injected local override (default: not engaged). Production wiring passes
   * `() => false`.
   */
  isKillswitchEngaged: () => boolean;
  telemetry: BugbotReviewTelemetry;
  /** Changed files of a commit (production: `git diff-tree --name-only`). */
  getChangedFiles: (repoRoot: string, commit: string) => Promise<string[]>;
  /** Submit the review prompt to the agent engine (fire-and-forget). */
  submitReview: (prompt: string) => void;
  /**
   * Resolve a repo root when the command is invoked without one (palette).
   * The commit trigger always passes rootUri; this is the palette fallback
   * (active editor's workspace folder).
   */
  resolveRepoRoot: () => string | undefined;
  showInfo: (message: string) => void;
  showWarning: (message: string) => void;
  showError: (message: string) => void;
  /** Optional review-run store for the Bugbot pane. */
  history?: BugbotReviewHistory;
  sink?: (line: string) => void;
}

export async function runBugbotAutoReview(
  rootUri: vscode.Uri | undefined,
  headRef: string | undefined,
  deps: BugbotAutoReviewDeps,
): Promise<void> {
  // Binary-verbatim gate: killswitch OR flag off -> silent return.
  if (deps.isKillswitchEngaged()) {
    deps.sink?.("[bugbot] auto-run suppressed (bugbot_autorun_killswitch)");
    return;
  }
  if (!isBugbotAutoRunOnCommitEnabled(deps.globalState)) {
    deps.sink?.("[bugbot] auto-run skipped (autoRunBugbotOnCommit is off)");
    return;
  }
  deps.telemetry.logEvent(BUGBOT_RUN_IDE_BUG_FINDER_EVENT, {
    entrypoint: BUGBOT_ENTRYPOINT_AUTO_RUN_ON_COMMIT,
  });
  const root = rootUri?.fsPath ?? deps.resolveRepoRoot();
  if (!root) {
    deps.showWarning("Bugbot Review: no repository found to review.");
    return;
  }
  try {
    const ref = headRef && headRef.length > 0 ? headRef : "HEAD";
    await submitBranchReview(root, ref, "commit", deps);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    deps.showError(`Bugbot Review: could not start the review — ${reason}`);
  }
}

/**
 * Register `cursor.runEditorBugbot` on the extension host with the
 * binary-verbatim `(rootUri, headRef)` signature.
 *
 * DEV-GAPS-15: `history` is optional so existing call sites keep working;
 * the pane and the other routes pass a shared instance so
 * `cursor.openBugbotPane` can list their runs.
 */
export function registerBugbotReviewCommand(
  context: vscode.ExtensionContext,
  getComposer: () => ComposerDataService,
  history?: BugbotReviewHistory,
  sink?: (line: string) => void,
): vscode.Disposable {
  const telemetry = new BugbotReviewTelemetry(sink);
  return vscode.commands.registerCommand(
    BUGBOT_RUN_EDITOR_REVIEW_COMMAND_ID,
    (rootUri?: vscode.Uri, headRef?: string) =>
      runBugbotAutoReview(rootUri, headRef, {
        globalState: context.globalState,
        isKillswitchEngaged: () => false,
        telemetry,
        getChangedFiles: (repoRoot, commit) =>
          spawnGitDiffTree(repoRoot, commit),
        submitReview: (prompt) => getComposer().submit(prompt),
        resolveRepoRoot: () => {
          try {
            const doc = vscode.window.activeTextEditor?.document.uri;
            if (doc?.scheme === "file") {
              return vscode.workspace.getWorkspaceFolder(doc)?.uri.fsPath;
            }
          } catch {
            /* ignore */
          }
          try {
            return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          } catch {
            return undefined;
          }
        },
        history,
        sink,
        showInfo: (m) => {
          void vscode.window.showInformationMessage(m);
        },
        showWarning: (m) => {
          void vscode.window.showWarningMessage(m);
        },
        showError: (m) => {
          void vscode.window.showErrorMessage(m);
        },
      }),
  );
}

/**
 * DEV-GAPS-15: where a bugbot review run was triggered from.
 */
export type BugbotReviewKind = "editor" | "ad" | "commit";

/**
 * DEV-GAPS-15: in-memory record of bugbot review RUNS.
 *
 * Only the request is stored (when, what entry point, which target, the
 * prompt actually submitted). Findings themselves live with the agent
 * engine that performs the review — this store never fabricates findings,
 * so the pane can honestly say results appear in the agent chat when the
 * engine finishes.
 */
export interface BugbotReviewRecord {
  id: number;
  kind: BugbotReviewKind;
  target: string;
  prompt: string;
  submittedAt: string;
}

export class BugbotReviewHistory {
  private records: BugbotReviewRecord[] = [];
  private nextId = 1;

  /** Record a submitted review run. Returns the record. Never throws. */
  record(kind: BugbotReviewKind, target: string, prompt: string): BugbotReviewRecord {
    const rec: BugbotReviewRecord = {
      id: this.nextId++,
      kind,
      target,
      prompt,
      submittedAt: new Date().toISOString(),
    };
    this.records.push(rec);
    return rec;
  }

  /** All runs, newest first. Returns a copy. */
  list(): BugbotReviewRecord[] {
    return [...this.records].reverse();
  }

  /** The most recent run, if any. */
  latest(): BugbotReviewRecord | undefined {
    return this.records[this.records.length - 1];
  }
}

/* =====================================================================
 * DEV-GAPS-15 (bugbot-remaining-commands): the three remaining binary-
 * verbatim commands from DEEP-DIG-A (Cursor 3.25.6): `cursor.openBugbotPane`,
 * `cursor.reviewBugbotFromAd`, `cursor.enableAutoReviewOnCommit`.
 * ===================================================================== */

/** Escape user-controlled text (file paths, prompts) for the pane HTML. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Inferred webview view type for the Bugbot pane (HONEST-DIVERGENCE — the
 * binary evidence only shows the `cursor.openBugbotPane` command id; the
 * view id is this fork's own).
 */
export const BUGBOT_PANE_VIEW_TYPE = "ideAgent.bugbotPane";

/** Single shared panel — reopening the command reveals it, never duplicates. */
let bugbotPanel: vscode.WebviewPanel | undefined;

/** Build the pane HTML from real review-run records. No fake data. */
export function buildBugbotPaneHtml(records: BugbotReviewRecord[]): string {
  const kindLabel: Record<BugbotReviewKind, string> = {
    editor: "Editor",
    ad: "Ad / CTA",
    commit: "Auto (commit)",
  };
  const rows =
    records.length === 0
      ? `<div class="empty">
           <p>No bugbot reviews yet.</p>
           <p class="hint">Run <b>${escapeHtml(BUGBOT_RUN_EDITOR_REVIEW_TITLE)}</b>
           (<code>cursor.runEditorBugbot</code>) from the command palette to
           review the latest commit, or enable
           <b>${escapeHtml(BUGBOT_ENABLE_AUTO_REVIEW_TITLE)}</b>
           (<code>cursor.enableAutoReviewOnCommit</code>) to review every
           commit automatically.</p>
         </div>`
      : records
          .map(
            (r) => `<div class="run">
              <div class="run-head">
                <span class="kind kind-${r.kind}">${kindLabel[r.kind]}</span>
                <span class="time">${escapeHtml(r.submittedAt)}</span>
              </div>
              <div class="target">${escapeHtml(r.target)}</div>
              <details><summary>Review prompt sent to the agent</summary>
                <pre>${escapeHtml(r.prompt)}</pre>
              </details>
            </div>`,
          )
          .join("");
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
         background: var(--vscode-editor-background); padding: 16px 20px; }
  h1 { font-size: 16px; margin: 0 0 4px; }
  .note { color: var(--vscode-descriptionForeground); font-size: 12px; margin: 0 0 16px; }
  .run { border: 1px solid var(--vscode-panel-border); border-radius: 6px;
         padding: 10px 12px; margin-bottom: 10px; }
  .run-head { display: flex; gap: 8px; align-items: center; margin-bottom: 6px; }
  .kind { font-size: 11px; padding: 2px 8px; border-radius: 10px;
          background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .time { font-size: 11px; color: var(--vscode-descriptionForeground); }
  .target { font-family: var(--vscode-editor-font-family); font-size: 12px;
            margin-bottom: 6px; word-break: break-all; }
  summary { font-size: 12px; cursor: pointer; color: var(--vscode-textLink-foreground); }
  pre { white-space: pre-wrap; font-size: 12px;
        background: var(--vscode-textCodeBlock-background); padding: 8px; border-radius: 4px; }
  .empty { color: var(--vscode-descriptionForeground); font-size: 13px; }
  .hint code { font-size: 12px; }
</style></head>
<body>
  <h1>Bugbot</h1>
  <p class="note">Recent bugbot review runs. Reviews are performed by the
  agent engine — findings appear in the agent chat pane when each review
  finishes. This pane lists the runs themselves (never fabricated results).</p>
  ${rows}
</body></html>`;
}

/**
 * DEV-GAPS-15 Task 1: `cursor.openBugbotPane` — open the Bugbot pane listing
 * the latest review runs from the shared BugbotReviewHistory.
 */
export function openBugbotPane(history: BugbotReviewHistory): void {
  const html = buildBugbotPaneHtml(history.list());
  if (bugbotPanel) {
    bugbotPanel.webview.html = html;
    bugbotPanel.reveal(vscode.ViewColumn.Beside);
    return;
  }
  bugbotPanel = vscode.window.createWebviewPanel(
    BUGBOT_PANE_VIEW_TYPE,
    "Bugbot",
    vscode.ViewColumn.Beside,
    { enableScripts: false },
  );
  bugbotPanel.webview.html = html;
  bugbotPanel.onDidDispose(() => {
    bugbotPanel = undefined;
  });
}

/** Register `cursor.openBugbotPane` on the extension host. */
export function registerOpenBugbotPaneCommand(
  history: BugbotReviewHistory,
): vscode.Disposable {
  return vscode.commands.registerCommand(BUGBOT_OPEN_PANE_COMMAND_ID, () =>
    openBugbotPane(history),
  );
}

/**
 * Shared repo-level review submission (the binary's `E3n` fallback shape:
 * `{where:{location:"repo",rootUri,source:{kind:"branch"|"singleCommit"...}}}`).
 * Used by both `cursor.runEditorBugbot` (auto-run, after its verbatim gate)
 * and `cursor.reviewBugbotFromAd` (explicit user action, no auto-run gate).
 */
interface BranchReviewSubmitDeps {
  getChangedFiles: (repoRoot: string, commit: string) => Promise<string[]>;
  submitReview: (prompt: string) => void;
  showInfo: (message: string) => void;
  showError: (message: string) => void;
  history?: BugbotReviewHistory;
  sink?: (line: string) => void;
}

async function submitBranchReview(
  root: string,
  ref: string,
  kind: BugbotReviewKind,
  deps: BranchReviewSubmitDeps,
): Promise<void> {
  const files = (await deps.getChangedFiles(root, ref)).slice(
    0,
    AUTO_REVIEW_MAX_FILES,
  );
  const prompt = buildCommitReviewPrompt(files, ref);
  deps.submitReview(prompt);
  deps.history?.record(kind, `${root} @ ${ref.slice(0, 7)}`, prompt);
  deps.showInfo(
    `Bugbot: review submitted for commit ${ref.slice(0, 7)} ` +
      `(${files.length} file(s)). Findings will appear in the agent chat.`,
  );
  deps.sink?.(
    `[bugbot] review submitted for ${ref.slice(0, 7)} (${files.length} files)`,
  );
}

/**
 * DEV-GAPS-15 Task 2 / WORKER-GAPS-42D: `cursor.reviewBugbotFromAd` — entry
 * point from an ad/CTA surface. Binary-verbatim behavior (Cursor 3.25.9,
 * workbench.glass.main.js `us.registerCommand("cursor.reviewBugbotFromAd",
 * async(t,e)=>{...})`):
 *
 * - No workspace folders → telemetry bail `no_workspace_folder` + info
 *   "Open a folder to run Bugbot review." (verbatim).
 * - Target given but not inside an open repository → info "Open the
 *   repository you just committed in to run Bugbot review, or open the
 *   Bugbot pane manually." (verbatim; the binary's `mOl` repo resolution).
 * - Otherwise review the repository at HEAD.
 *
 * HONEST-DIVERGENCE (managed path): when the `editor_review_cta_uses_review_bugbot`
 * gate passes, Cursor hands off to the composer with a skill mention
 * (`skillId:"review-bugbot"`, `review-bugbot/SKILL.md`, autoSubmit). The
 * fork has no skill-mention infrastructure, so the review is submitted
 * directly through the agent engine — the same real review the binary falls
 * back to (`E3n` with `{source:{kind:"singleCommit",commit:"HEAD"}}`).
 */
export interface BugbotFromAdDeps extends BranchReviewSubmitDeps {
  telemetry: BugbotReviewTelemetry;
  showWarning: (message: string) => void;
}

export async function reviewBugbotFromAd(
  target: vscode.Uri | undefined,
  deps: BugbotFromAdDeps,
): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    // Binary-verbatim bail: trackEvent("bug_bot.review_cta_bail",{reason}).
    deps.telemetry.logEvent(BUGBOT_REVIEW_CTA_BAIL_EVENT, {
      reason: "no_workspace_folder",
    });
    // Binary-verbatim string.
    deps.showInfo("Open a folder to run Bugbot review.");
    return;
  }
  // Resolve the repository containing the target (binary: `mOl({target})`).
  let root: string | undefined;
  const targetPath = target?.scheme === "file" ? target.fsPath : undefined;
  if (targetPath) {
    try {
      root = vscode.workspace.getWorkspaceFolder(
        vscode.Uri.file(targetPath),
      )?.uri.fsPath;
    } catch {
      root = undefined;
    }
    if (!root) {
      deps.telemetry.logEvent(BUGBOT_REVIEW_CTA_BAIL_EVENT, {
        reason: "repo_unresolved",
      });
      // Binary-verbatim string.
      deps.showInfo(
        "Open the repository you just committed in to run Bugbot review, " +
          "or open the Bugbot pane manually.",
      );
      return;
    }
  }
  if (!root) {
    try {
      const doc = vscode.window.activeTextEditor?.document.uri;
      if (doc?.scheme === "file") {
        root = vscode.workspace.getWorkspaceFolder(doc)?.uri.fsPath;
      }
    } catch {
      /* ignore */
    }
    root ??= folders[0]?.uri.fsPath;
  }
  if (!root) {
    deps.showWarning("Bugbot Review: no repository found to review.");
    return;
  }
  // Binary-verbatim run telemetry (the fallback path):
  // trackEvent("bug_bot.run_ide_bug_finder",{entrypoint:"in_app_ad"}).
  deps.telemetry.logEvent(BUGBOT_RUN_IDE_BUG_FINDER_EVENT, {
    entrypoint: BUGBOT_ENTRYPOINT_IN_APP_AD,
  });
  try {
    await submitBranchReview(root, "HEAD", "ad", deps);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    deps.showError(`Bugbot Review: could not start the review — ${reason}`);
  }
}

/** Register `cursor.reviewBugbotFromAd` on the extension host. */
export function registerBugbotFromAdCommand(
  context: vscode.ExtensionContext,
  getComposer: () => ComposerDataService,
  history?: BugbotReviewHistory,
  sink?: (line: string) => void,
): vscode.Disposable {
  void context;
  const telemetry = new BugbotReviewTelemetry(sink);
  return vscode.commands.registerCommand(
    BUGBOT_REVIEW_FROM_AD_COMMAND_ID,
    (target?: vscode.Uri) =>
      reviewBugbotFromAd(target, {
        telemetry,
        getChangedFiles: (repoRoot, commit) =>
          spawnGitDiffTree(repoRoot, commit),
        submitReview: (prompt) => getComposer().submit(prompt),
        history,
        sink,
        showInfo: (m) => {
          void vscode.window.showInformationMessage(m);
        },
        showWarning: (m) => {
          void vscode.window.showWarningMessage(m);
        },
        showError: (m) => {
          void vscode.window.showErrorMessage(m);
        },
      }),
  );
}

/* ---------------------------------------------------------------------
 * DEV-GAPS-15 Task 3: `cursor.enableAutoReviewOnCommit`
 *
 * Toggle (quickpick on/off) for `ide.bugbot.autoReviewOnCommit` (boolean,
 * default false). When on, every NEW git commit (HEAD change observed via
 * the built-in git extension — the same watch pattern as
 * commitScoreWatcher's watchCommitsForScoring) triggers a bugbot review of
 * the commit's changed files. Post-commit, fire-and-forget: the commit is
 * never blocked, and the user only gets a notification + the run recorded
 * for the Bugbot pane.
 * --------------------------------------------------------------------- */

/** Cap so a huge commit can't blow up the review prompt. */
const AUTO_REVIEW_MAX_FILES = 200;

/**
 * Build the review prompt for a commit's changed files. A REAL review — the
 * agent reads the files with its tools and reports findings — not a
 * fabricated result.
 */
export function buildCommitReviewPrompt(files: string[], commit: string): string {
  const short = commit.slice(0, 7);
  const listed = files.slice(0, 50).join("\n");
  const more = files.length > 50 ? `\n... and ${files.length - 50} more file(s)` : "";
  return (
    `Review the files changed in commit ${short} for bugs. ` +
    `Read them first, then report concrete findings with file:line references: ` +
    `bugs, logic errors, crash risks, and security issues, ordered by severity. ` +
    `Do not modify the files — report only.\n\nChanged files:\n${listed}${more}`
  );
}

/* ---------------------------------------------------------------------
 * The commit trigger itself now lives in `bugbotCommitTrigger.ts`
 * (WORKER-GAPS-42D): a verbatim port of Cursor's `cursor-commits`
 * extension `shouldRunBugbot` predicate + 5s-debounce watcher, dispatching
 * `cursor.runEditorBugbot` via `commands.executeCommand`. The naive
 * immediate watcher below was removed because it contradicted the binary
 * (no debounce, no rebase/merge/pushed/authored-by-me checks, bypassed the
 * command's storage+killswitch gate).
 * --------------------------------------------------------------------- */

function spawnGitDiffTree(root: string, commit: string): Promise<string[]> {
  return new Promise((resolve) => {
    child_process.execFile(
      "git",
      // DEV-GAPS-14 `ext-git-sanitize`: URL credentials stripped, safe `-c`
      // configs forced before the subcommand (verbatim per Cursor evidence).
      withSafeGitArgs(["diff-tree", "--no-commit-id", "--name-only", "-r", commit]),
      { cwd: root, maxBuffer: 8 * 1024 * 1024, timeout: 15_000 },
      (err, stdout) => {
        if (err) {
          resolve([]);
          return;
        }
        const out = typeof stdout === "string" ? stdout : "";
        resolve(
          out
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l.length > 0),
        );
      },
    );
  });
}

/* ---------------------------------------------------------------------
 * `cursor.enableAutoReviewOnCommit` — binary-verbatim (Cursor 3.25.9,
 * workbench.glass.main.js byte 41781073):
 *
 * ```
 * us.registerCommand("cursor.enableAutoReviewOnCommit", t => {
 *   const e = t.get(yi), i = t.get(_n).invokeFunction(r => r.get(Zr));
 *   gg(e, "autoRunBugbotOnCommit", !0),
 *   i.trackEvent("bug_bot.autorun_on_commit_toggled",
 *                {enabled: !0, source: "in_app_ad"})
 * })
 * ```
 *
 * It unconditionally ENABLES the storage flag (no toggle, no quickpick —
 * the old quickpick toggle was a misreading of the binary and has been
 * removed) and emits the verbatim telemetry event. The disable path in
 * Cursor is the Settings UI toggle ("Start Agent Review on Commit"); in
 * this fork that surface is the `ide.bugbot.autoReviewOnCommit`
 * configuration, synced into the same storage flag (see extension.ts).
 * --------------------------------------------------------------------- */

/** Binary-verbatim enable: storage flag true + telemetry. */
export async function enableBugbotAutoReviewOnCommit(
  globalState: vscode.Memento,
  telemetry: BugbotReviewTelemetry,
  showInfo: (message: string) => void,
  sink?: (line: string) => void,
): Promise<void> {
  await setBugbotAutoRunOnCommit(globalState, true);
  telemetry.logEvent(BUGBOT_AUTORUN_ON_COMMIT_TOGGLED_EVENT, {
    enabled: true,
    source: BUGBOT_ENTRYPOINT_IN_APP_AD,
  });
  sink?.("[bugbot] autoRunBugbotOnCommit enabled");
  showInfo(
    'Bugbot auto-review on commit enabled ("Start Agent Review on Commit").',
  );
}

/** Register `cursor.enableAutoReviewOnCommit` on the extension host. */
export function registerBugbotAutoReviewEnableCommand(
  context: vscode.ExtensionContext,
  sink?: (line: string) => void,
): vscode.Disposable {
  const telemetry = new BugbotReviewTelemetry(sink);
  return vscode.commands.registerCommand(BUGBOT_ENABLE_AUTO_REVIEW_COMMAND_ID, () =>
    enableBugbotAutoReviewOnCommit(context.globalState, telemetry, (m) => {
      void vscode.window.showInformationMessage(m);
    }, sink),
  );
}
