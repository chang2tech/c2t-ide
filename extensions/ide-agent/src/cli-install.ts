/**
 * DEV-GAPS-65 `cursor-install-cli` — pure helpers (Cursor parity).
 *
 * Feature-matrix entries: `cursor-install-cli` + `r2m-003`
 * ("cursor.installCli handler fully read — spec enrichment").
 *
 * BINARY EVIDENCE (Cursor 3.25.9, `out/vs/workbench/workbench.desktop.main.js`,
 * handler fully read in docs/rea/dig-root-team/redig2-misc.md §ND-05):
 *   - Registration @36708706 (1 hit): `Yg({id:"cursor.installCli",
 *     title:"Install Cursor CLI", f1:..., run: async ...})` — title nls 10694,
 *     `f1:!Ho` (hidden from the palette on web).
 *   - Handler step 1 (guard): reads
 *     `applicationUserPersistentStorage.cliDetectionStatus?.agentStatus`;
 *     if `==="installed"` → show info toast (nls key 10693) and return.
 *   - Handler step 2 (install flow): create a new terminal at the Panel
 *     (`createTerminal({location: Panel})`), set it active, show the panel,
 *     focus it, then run the verbatim command
 *     `curl https://cursor.com/install -fsS | bash`.
 *     No download/binary management, elevation, or PATH edits in the client —
 *     the install script does all of that.
 *   - Detection (`workbench.contrib.pathInspection`, same file @40635349):
 *     `checkPathForExecutables` probes the executables
 *     `codex, claude, amp, gemini, agent` via `checkExecutableInPath` in the
 *     PATH + `~/.local/bin` (native only; skipped on web), and persists
 *     `applicationUserPersistentStorage.cliDetectionStatus =
 *     {claudeStatus, codexStatus, agentStatus, checkedAt}` where each status
 *     is `"installed"|"not_found"|"unknown"`. The command keys off
 *     `agentStatus` (the CLI binary is named `agent`).
 *   - Experiment gate helper `_userQualifiesForExperiment` (@36705799): the
 *     user qualifies for the install tip when `claude`/`codex` is installed
 *     but `agent` is not. The `terminal_tip` default is
 *     `{message:"Install Cursor CLI?",
 *       action:"curl https://cursor.com/install -fsS | bash", ...}`
 *     (@16262049) — the tip surface itself is experiment-gated server-side,
 *     so only the qualifier is modelled here (see HONEST-DIVERGENCE).
 *
 * Layer: Cursor registers this command in workbench core. In this fork the
 * verbatim `cursor.*` command family already lives in this extension
 * (`cursor.runEditorBugbot`, `cursor.openBugbotPane`, … — same pattern, the
 * user-visible result is identical: palette command, Panel terminal, toast).
 *
 * HONEST-DIVERGENCE:
 *   - The already-installed toast text (nls 10693) was never captured from
 *     the binary — only its nls key is known. `ALREADY_INSTALLED_MESSAGE`
 *     below is a plain factual placeholder, NOT a verbatim Cursor string.
 *   - Cursor persists detection in `applicationUserPersistentStorage`;
 *     this fork persists the same shape in extension `globalState` under
 *     the verbatim key `cliDetectionStatus` (same durability class).
 *   - The `terminal_tip` inline terminal hint and the `cli_install_ad`
 *     experiment gate are NOT rendered here: in Cursor both are driven by
 *     its server-side experiment service, which this fork has no equivalent
 *     of. Only the qualification predicate is implemented + tested.
 *   - `f1:!Ho` hides the command on web in Cursor; this extension only
 *     activates on desktop, so no explicit web guard is needed.
 *
 * node-testable: no vscode imports here. All side effects are injected.
 */

// ---------------------------------------------------------------------------
// Verbatim constants (offsets above)
// ---------------------------------------------------------------------------

/** Command id, verbatim: `cursor.installCli` (@36708706). */
export const INSTALL_CLI_COMMAND_ID = "cursor.installCli";

/** Command title, verbatim (nls 10694): "Install Cursor CLI". */
export const INSTALL_CLI_TITLE = "Install Cursor CLI";

/**
 * The command the handler runs in the Panel terminal, verbatim — also the
 * `terminal_tip` default action (@16262049).
 */
export const CLI_INSTALL_COMMAND = "curl https://cursor.com/install -fsS | bash";

/** `terminal_tip` default message, verbatim (@16262049). */
export const CLI_INSTALL_TIP_MESSAGE = "Install Cursor CLI?";

/**
 * Executables probed by `checkPathForExecutables` (@40635349), verbatim
 * order: `codex, claude, amp, gemini, agent`.
 */
export const CLI_EXECUTABLE_NAMES = ["codex", "claude", "amp", "gemini", "agent"] as const;
export type CliExecutableName = (typeof CLI_EXECUTABLE_NAMES)[number];

/** The executable the `cursor.installCli` command keys off. */
export const CLI_AGENT_EXECUTABLE: CliExecutableName = "agent";

/**
 * Extra directory probed in addition to the PATH (@40635349: `~/.local/bin`).
 * Kept as a home-relative suffix; resolution against the real home dir
 * happens in the probe deps.
 */
export const CLI_EXTRA_PROBE_DIR_SUFFIX = ".local/bin";

/** globalState key — the verbatim persistent-storage field name. */
export const CLI_DETECTION_STATUS_STORAGE_KEY = "cliDetectionStatus";

/**
 * HONEST-DIVERGENCE (see header): the binary's already-installed toast text
 * (nls 10693) is UNKNOWN. This is a factual placeholder, not a verbatim
 * Cursor string.
 */
export const ALREADY_INSTALLED_MESSAGE = "IDE Code CLI is already installed";

// ---------------------------------------------------------------------------
// Detection status model (verbatim persisted shape @40635349)
// ---------------------------------------------------------------------------

/** Verbatim status literals: `"installed"|"not_found"|"unknown"`. */
export type CliExecutableStatus = "installed" | "not_found" | "unknown";

/**
 * Verbatim persisted shape:
 * `{claudeStatus, codexStatus, agentStatus, checkedAt}`.
 * (Detection probes all 5 executables, but only these three statuses +
 * the timestamp are persisted.)
 */
export interface CliDetectionStatus {
  claudeStatus: CliExecutableStatus;
  codexStatus: CliExecutableStatus;
  agentStatus: CliExecutableStatus;
  checkedAt: number;
}

/** Before any probe ran (and on web, where detection is skipped). */
export function unknownCliDetectionStatus(): CliDetectionStatus {
  return {
    claudeStatus: "unknown",
    codexStatus: "unknown",
    agentStatus: "unknown",
    checkedAt: 0,
  };
}

export function isCliExecutableStatus(value: unknown): value is CliExecutableStatus {
  return value === "installed" || value === "not_found" || value === "unknown";
}

/**
 * Defensive parse of a persisted status blob. Returns `undefined` for
 * anything that is not exactly the binary's shape with valid literals.
 */
export function parseCliDetectionStatus(raw: unknown): CliDetectionStatus | undefined {
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  if (
    !isCliExecutableStatus(r.claudeStatus) ||
    !isCliExecutableStatus(r.codexStatus) ||
    !isCliExecutableStatus(r.agentStatus) ||
    typeof r.checkedAt !== "number" ||
    !Number.isFinite(r.checkedAt)
  ) {
    return undefined;
  }
  return {
    claudeStatus: r.claudeStatus,
    codexStatus: r.codexStatus,
    agentStatus: r.agentStatus,
    checkedAt: r.checkedAt,
  };
}

/** Per-executable probe outcome; a missing entry means the probe failed. */
export type CliProbeResult = Partial<Record<CliExecutableName, CliExecutableStatus>>;

/**
 * Fold a probe run into the persisted shape. Executables whose probe did
 * not produce a result stay `"unknown"` (the binary's third literal).
 */
export function buildCliDetectionStatus(probe: CliProbeResult, checkedAt: number): CliDetectionStatus {
  return {
    claudeStatus: probe.claude ?? "unknown",
    codexStatus: probe.codex ?? "unknown",
    agentStatus: probe.agent ?? "unknown",
    checkedAt,
  };
}

// ---------------------------------------------------------------------------
// Handler decisions (handler body @36708706)
// ---------------------------------------------------------------------------

/** Step 1 of the handler: the already-installed guard. */
export function isCliAlreadyInstalled(status: CliDetectionStatus): boolean {
  return status.agentStatus === "installed";
}

export type InstallCliAction = "already-installed" | "install";

/** Resolve what the command run does for a given detection status. */
export function resolveInstallCliAction(status: CliDetectionStatus): InstallCliAction {
  return isCliAlreadyInstalled(status) ? "already-installed" : "install";
}

/**
 * `_userQualifiesForExperiment` (@36705799), verbatim rule: the user has
 * `claude`/`codex` installed but `agent` is not installed.
 */
export function qualifiesForCliInstallTip(status: CliDetectionStatus): boolean {
  return (
    (status.claudeStatus === "installed" || status.codexStatus === "installed") &&
    status.agentStatus !== "installed"
  );
}

// ---------------------------------------------------------------------------
// Executable probing (`checkExecutableInPath` semantics @40635349)
// ---------------------------------------------------------------------------

export interface CliProbeDeps {
  /** The raw PATH value (may be undefined/empty). */
  pathEnv: string | undefined;
  /** PATH entry separator (`:` POSIX, `;` Windows). */
  pathDelimiter: string;
  /** Absolute path of the user's home directory. */
  homeDir: string;
  /** Platform join for probe candidates. */
  joinPath: (...parts: string[]) => string;
  /** True when `candidate` exists and is an executable file. */
  isExecutableFile: (candidate: string) => boolean;
  /** File-name variants to try per directory (e.g. `["agent"]`,
   *  or `["agent", "agent.exe"]` on Windows). */
  executableVariants: (name: string) => string[];
}

/**
 * `checkExecutableInPath` equivalent: search the PATH entries plus
 * `~/.local/bin` for an executable `name`.
 */
export function findExecutableInPath(name: string, deps: CliProbeDeps): boolean {
  const dirs: string[] = [];
  if (deps.pathEnv) {
    for (const entry of deps.pathEnv.split(deps.pathDelimiter)) {
      if (entry) {
        dirs.push(entry);
      }
    }
  }
  dirs.push(deps.joinPath(deps.homeDir, CLI_EXTRA_PROBE_DIR_SUFFIX));
  for (const dir of dirs) {
    for (const variant of deps.executableVariants(name)) {
      if (deps.isExecutableFile(deps.joinPath(dir, variant))) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Probe all 5 verbatim executables. A probe that throws leaves that
 * executable's status `"unknown"` in the folded result.
 */
export function probeCliExecutables(deps: CliProbeDeps): CliProbeResult {
  const result: CliProbeResult = {};
  for (const name of CLI_EXECUTABLE_NAMES) {
    try {
      result[name] = findExecutableInPath(name, deps) ? "installed" : "not_found";
    } catch {
      result[name] = "unknown";
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// The command flow (handler body @36708706, side effects injected)
// ---------------------------------------------------------------------------

export interface InstallCliFlowDeps {
  /** Read the persisted detection status (undefined when never stored). */
  readStatus: () => CliDetectionStatus | undefined;
  /** Re-probe the executables and return the fresh folded status. */
  refreshStatus: () => CliDetectionStatus;
  /** Persist a status blob. */
  writeStatus: (status: CliDetectionStatus) => void | Promise<void>;
  /** Show the already-installed info toast. */
  showAlreadyInstalled: () => void;
  /** Create a Panel terminal, show/focus it, and run `command` in it. */
  runInstallInPanelTerminal: (command: string) => void;
}

/**
 * The handler, transcribed step-for-step:
 *   1. read persisted `cliDetectionStatus`; `agentStatus==="installed"`
 *      → info toast, return;
 *   2. otherwise refresh detection (first-run case: nothing persisted),
 *      re-check the guard against the fresh status, persist, and only
 *      then open the Panel terminal running the install command.
 *
 * (Refreshing on first run keeps a stale "unknown" from re-installing over
 * an existing CLI; the binary re-derives `cliDetectionStatus` from the
 * same `pathInspection` pass before the command reads it.)
 */
export async function runInstallCliFlow(deps: InstallCliFlowDeps): Promise<InstallCliAction> {
  let status = deps.readStatus();
  if (!status) {
    status = deps.refreshStatus();
    await deps.writeStatus(status);
  }
  if (resolveInstallCliAction(status) === "already-installed") {
    deps.showAlreadyInstalled();
    return "already-installed";
  }
  deps.runInstallInPanelTerminal(CLI_INSTALL_COMMAND);
  return "install";
}
