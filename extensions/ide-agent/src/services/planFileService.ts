/**
 * Plan-file runtime resolve + failure telemetry (DEV-GAPS-16, ext-plan-files).
 *
 * Evidence: DIG-AST-EXT 2026-10-19 on cursor-agent-host/dist/main.js 3.25.6 —
 * plan mode writes plan files; the runtime recreates/resolves them with
 * failure telemetry (agent.execute_plan.* semantics).
 *
 * HONEST DIVERGENCE (anti-fabrication): the binary evidence confirms the
 * MECHANISM (recreate/resolve on missing or broken plan files, failure
 * handling) but does NOT reveal Cursor's real telemetry event names. The
 * names in PLAN_FILE_TELEMETRY below are OUR OWN invention, stable only for
 * this codebase — do NOT claim Cursor sends these names.
 *
 * The plan file FORMAT is unchanged: `# Plan — <ISO>` header + body,
 * written by savePlanFile in composerDataService.ts.
 */
import * as path from "node:path";

export const PLAN_FILE_TELEMETRY = {
  /** A plan file was found on disk (explicit, workspace, or global dir). */
  fileResolved: "ide.plan.fileResolved",
  /** No usable file on disk — recreated from the in-memory plan text. */
  fileRecreated: "ide.plan.fileRecreated",
  /** No file found AND recreate failed — the build cannot proceed. */
  fileResolveFailed: "ide.plan.fileResolveFailed",
} as const;

export type PlanFileTelemetryEvent = (typeof PLAN_FILE_TELEMETRY)[keyof typeof PLAN_FILE_TELEMETRY];

export type PlanFileResolveSource = "explicit" | "workspace" | "global" | "recreated" | "failed";

export interface PlanFileResolveOutcome {
  /** The resolved, readable plan file path — null when resolution failed. */
  path: string | null;
  source: PlanFileResolveSource;
  /** Why resolution failed, or which step fell back (diagnostics only). */
  reason?: string;
}

export interface PlanFileResolveDeps {
  /** True when the file can be read. */
  fileUsable: (p: string) => Promise<boolean>;
  homedir: () => string;
  /** Absolute workspace root paths (may be empty). */
  workspaceRoots: () => string[];
  /**
   * Recreate a plan file from the in-memory text. Returns the absolute path,
   * or "" when the save failed. Must preserve the existing plan file format.
   */
  recreate: (text: string) => Promise<string>;
  /** Failure/info telemetry sink — no backend, log in-memory + output. */
  emit: (event: PlanFileTelemetryEvent, source: PlanFileResolveSource, reason?: string) => void;
}

const PLANS_DIR_NAME = ".ide-code";

/**
 * Resolve the persisted plan file, in order:
 *   1. explicit path (plan.savedPath) — the normal case,
 *   2. workspace `.ide-code/plans/<basename>`,
 *   3. global `~/.ide-code/plans/<basename>`,
 *   4. recreate from the in-memory plan text,
 *   5. telemetry failure (fileResolveFailed).
 *
 * A file counts as "usable" when it exists and reads back non-empty. A
 * missing, unreadable, or empty/corrupt file falls through to the next
 * step — the plan in memory is never lost and resolve never throws.
 */
export async function resolvePlanFilePath(
  plan: { savedPath: string; text: string },
  deps: PlanFileResolveDeps,
): Promise<PlanFileResolveOutcome> {
  // 1. Explicit path.
  if (plan.savedPath) {
    if (await deps.fileUsable(plan.savedPath)) {
      deps.emit(PLAN_FILE_TELEMETRY.fileResolved, "explicit");
      return { path: plan.savedPath, source: "explicit" };
    }
    // A same-named file may still live in a plans dir (user moved the
    // file, or the explicit path pointed at the wrong machine).
    const basename = path.basename(plan.savedPath);
    // 2. Workspace .ide-code/plans/.
    for (const root of deps.workspaceRoots()) {
      const candidate = path.join(root, PLANS_DIR_NAME, "plans", basename);
      if (await deps.fileUsable(candidate)) {
        deps.emit(PLAN_FILE_TELEMETRY.fileResolved, "workspace", `fell back from ${plan.savedPath}`);
        return { path: candidate, source: "workspace", reason: `fell back from ${plan.savedPath}` };
      }
    }
    // 3. Global ~/.ide-code/plans/.
    const globalCandidate = path.join(deps.homedir(), PLANS_DIR_NAME, "plans", basename);
    if (await deps.fileUsable(globalCandidate)) {
      deps.emit(PLAN_FILE_TELEMETRY.fileResolved, "global", `fell back from ${plan.savedPath}`);
      return { path: globalCandidate, source: "global", reason: `fell back from ${plan.savedPath}` };
    }
  }
  // 4. Recreate from memory (never throws; "" on save failure).
  try {
    const recreated = await deps.recreate(plan.text);
    if (recreated && (await deps.fileUsable(recreated))) {
      deps.emit(PLAN_FILE_TELEMETRY.fileRecreated, "recreated", `recreated from memory`);
      return { path: recreated, source: "recreated", reason: "recreated from memory" };
    }
  } catch {
    // Fall through to the failure branch below.
  }
  // 5. Everything failed.
  const reason = !plan.text.trim() ? "empty plan text" : "plan file missing/corrupt and recreate failed";
  deps.emit(PLAN_FILE_TELEMETRY.fileResolveFailed, "failed", reason);
  return { path: null, source: "failed", reason };
}
