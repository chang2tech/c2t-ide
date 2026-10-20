/**
 * DEV-GAPS-5-SKILLS — skill migration into the local skills store.
 *
 * Moves skills from Cursor's home store (~/.cursor/skills/) and any legacy
 * store directories into ~/.ide-code/skills/, with progress reporting,
 * cancellation, and overwrite confirmation (the Cursor skillStore migration
 * flow: copySkillsFromStore/copySkillsToStore/moveSkillOutOfStore/
 * moveSkillToStore/trashMigratedHomeSkills/trashMigratedStoreSkills,
 * confirmOverwrite/isMigrationCancelled/reportMigrationProgress —
 * see dig-ast-ext-findings.md §1).
 *
 * DIVERGENCE: Cursor migrates into its cloud-backed store; we migrate into
 * the LOCAL store (see skillStoreService.ts). "Trash" moves source dirs to
 * ~/.ide-code/trash/skills-<timestamp>/ (recoverable), never deletes.
 *
 * Kept vscode-free so it unit-tests under plain node (see
 * src/services/test/run-skillstore-tests.ts).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  copyDirSync,
  defaultSkillStoreDir,
  ensureSkillStoreDir,
  installSkill,
  invalidateRequestContextSkillsCache,
  listInstalledSkillIds,
  readSkillManifest,
  removeDirSync,
} from "./skillStoreService";

/** Cursor's home skill store (the pre-migration source of truth). */
export function cursorHomeSkillsDir(homeDir: string = os.homedir()): string {
  return path.join(homeDir, ".cursor", "skills");
}

/** Recoverable trash root for migrated-away skill sources. */
export function skillTrashRoot(homeDir: string = os.homedir()): string {
  return path.join(homeDir, ".ide-code", "trash");
}

export interface SkillMigrationProgress {
  phase: string;
  done: number;
  total: number;
  current?: string;
}

export interface SkillMigrationOptions {
  homeDir?: string;
  storeDir?: string;
  /** Extra legacy store dirs to migrate (in addition to ~/.cursor/skills). */
  extraSourceDirs?: string[];
  onProgress?: (p: SkillMigrationProgress) => void;
  isCancelled?: () => boolean;
  /**
   * Called when a source skill collides with an installed one. Return true to
   * overwrite, false to skip. Defaults to skip (fail-closed).
   */
  confirmOverwrite?: (name: string, sourceDir: string, targetDir: string) => boolean | Promise<boolean>;
  controller?: SkillMigrationController;
}

export interface SkillMigrationResult {
  migrated: string[];
  skipped: string[];
  overwritten: string[];
  cancelled: boolean;
  /** Source dirs that were consumed (used by trashMigrated*). */
  sourceDirs: string[];
}

/**
 * Live migration controller — the backing state for Cursor's dynamic
 * skillStore.isMigrationCancelled / skillStore.reportMigrationProgress
 * commands.
 */
export class SkillMigrationController {
  private cancelled = false;
  private lastProgress: SkillMigrationProgress | undefined;

  cancel(): void {
    this.cancelled = true;
  }

  isCancelled(): boolean {
    return this.cancelled;
  }

  reportProgress(p: SkillMigrationProgress): void {
    this.lastProgress = p;
  }

  getLastProgress(): SkillMigrationProgress | undefined {
    return this.lastProgress;
  }

  reset(): void {
    this.cancelled = false;
    this.lastProgress = undefined;
  }
}

const MIGRATION_STATE_FILENAME = ".migration-state.json";

interface MigrationState {
  at: number;
  homeSkillsDir: string;
  extraSourceDirs: string[];
  migrated: string[];
}

/** Where the last migration recorded its source dirs. */
export function migrationStatePath(storeDir: string): string {
  return path.join(storeDir, MIGRATION_STATE_FILENAME);
}

function readMigrationState(storeDir: string): MigrationState | undefined {
  try {
    const raw = fs.readFileSync(migrationStatePath(storeDir), "utf8");
    const parsed = JSON.parse(raw) as Partial<MigrationState>;
    if (
      typeof parsed.at === "number" &&
      typeof parsed.homeSkillsDir === "string" &&
      Array.isArray(parsed.extraSourceDirs) &&
      Array.isArray(parsed.migrated)
    ) {
      return parsed as MigrationState;
    }
  } catch {
    // No state yet — nothing migrated.
  }
  return undefined;
}

function skillDirNames(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Migrate skills from ~/.cursor/skills/ (and any extraSourceDirs) into the
 * local store. Name collisions are skipped unless confirmOverwrite approves.
 * Records migration state so trashMigrated* knows what it may trash.
 */
export async function migrateSkills(opts: SkillMigrationOptions = {}): Promise<SkillMigrationResult> {
  const homeDir = opts.homeDir ?? os.homedir();
  const storeDir = opts.storeDir ?? defaultSkillStoreDir(homeDir);
  const controller = opts.controller;
  ensureSkillStoreDir(storeDir);

  const sources: string[] = [cursorHomeSkillsDir(homeDir), ...(opts.extraSourceDirs ?? [])];
  const candidates: Array<{ name: string; sourceDir: string }> = [];
  for (const src of sources) {
    for (const name of skillDirNames(src)) {
      const dir = path.join(src, name);
      if (readSkillManifest(dir)) {
        candidates.push({ name, sourceDir: dir });
      }
    }
  }

  const result: SkillMigrationResult = {
    migrated: [],
    skipped: [],
    overwritten: [],
    cancelled: false,
    sourceDirs: sources.filter((s) => fs.existsSync(s)),
  };
  const report = (p: SkillMigrationProgress): void => {
    controller?.reportProgress(p);
    opts.onProgress?.(p);
  };
  const cancelled = (): boolean =>
    controller?.isCancelled() === true || opts.isCancelled?.() === true;

  const total = candidates.length;
  let done = 0;
  for (const { name, sourceDir } of candidates) {
    if (cancelled()) {
      result.cancelled = true;
      report({ phase: "cancelled", done, total, current: name });
      break;
    }
    report({ phase: "migrating", done, total, current: name });
    const installedIds = new Set(listInstalledSkillIds(storeDir));
    if (installedIds.has(name)) {
      const targetDir = path.join(storeDir, name);
      const confirm = opts.confirmOverwrite ?? ((): boolean => false);
      if (await confirm(name, sourceDir, targetDir)) {
        installSkill(storeDir, sourceDir);
        result.overwritten.push(name);
      } else {
        result.skipped.push(name);
      }
    } else {
      installSkill(storeDir, sourceDir);
      result.migrated.push(name);
    }
    done++;
    report({ phase: "migrating", done, total, current: name });
  }

  if (!result.cancelled) {
    const state: MigrationState = {
      at: Date.now(),
      homeSkillsDir: cursorHomeSkillsDir(homeDir),
      extraSourceDirs: opts.extraSourceDirs ?? [],
      migrated: [...result.migrated, ...result.overwritten],
    };
    fs.writeFileSync(migrationStatePath(storeDir), JSON.stringify(state, null, 2) + "\n", "utf8");
    report({ phase: "done", done, total });
  }
  invalidateRequestContextSkillsCache();
  return result;
}

/**
 * Copy installed store skills OUT to a working directory
 * (Cursor: skillStore.copySkillsFromStore).
 */
export function copySkillsFromStore(
  storeDir: string,
  targetDir: string,
  skillIds?: string[],
): string[] {
  const ids = skillIds ?? listInstalledSkillIds(storeDir);
  const copied: string[] = [];
  for (const id of ids) {
    const src = path.join(storeDir, id);
    if (!readSkillManifest(src)) {
      continue;
    }
    copyDirSync(src, path.join(targetDir, id));
    copied.push(id);
  }
  return copied;
}

/**
 * Copy skill directories INTO the store (Cursor: skillStore.copySkillsToStore).
 * Returns the installed ids; throws on dirs without SKILL.md.
 */
export function copySkillsToStore(storeDir: string, sourceDirs: string[]): string[] {
  return sourceDirs.map((dir) => installSkill(storeDir, dir).id);
}

/**
 * Move one installed skill OUT of the store to a target dir
 * (Cursor: skillStore.moveSkillOutOfStore). The store copy is removed.
 */
export function moveSkillOutOfStore(storeDir: string, skillId: string, targetDir: string): void {
  const src = path.join(storeDir, skillId);
  if (!readSkillManifest(src)) {
    throw new Error(`skill not installed in store: ${skillId}`);
  }
  removeDirSync(targetDir);
  copyDirSync(src, targetDir);
  removeDirSync(src);
  invalidateRequestContextSkillsCache();
}

/**
 * Move a skill directory INTO the store (Cursor: skillStore.moveSkillToStore).
 * The source dir is removed after a successful install.
 */
export function moveSkillToStore(storeDir: string, sourceDir: string): string {
  const installed = installSkill(storeDir, sourceDir);
  removeDirSync(sourceDir);
  return installed.id;
}

function trashDir(homeDir: string, dir: string): string | undefined {
  if (!fs.existsSync(dir)) {
    return undefined;
  }
  const dest = path.join(skillTrashRoot(homeDir), `skills-${Date.now()}`, path.basename(dir));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(dir, dest);
  return dest;
}

/**
 * Move the migrated ~/.cursor/skills home dir to the recoverable trash
 * (Cursor: skillStore.trashMigratedHomeSkills). Returns the trash location,
 * or undefined when there was nothing to trash.
 */
export function trashMigratedHomeSkills(homeDir: string = os.homedir()): string | undefined {
  return trashDir(homeDir, cursorHomeSkillsDir(homeDir));
}

/**
 * Move migrated legacy store dirs (recorded in migration state) to the
 * recoverable trash (Cursor: skillStore.trashMigratedStoreSkills).
 */
export function trashMigratedStoreSkills(
  storeDir: string,
  homeDir: string = os.homedir(),
): string[] {
  const state = readMigrationState(storeDir);
  if (!state) {
    return [];
  }
  const trashed: string[] = [];
  for (const dir of state.extraSourceDirs) {
    const dest = trashDir(homeDir, dir);
    if (dest) {
      trashed.push(dest);
    }
  }
  return trashed;
}

/** Read the last migration's recorded state (source dirs + migrated skills). */
export function getMigrationState(storeDir: string): MigrationState | undefined {
  return readMigrationState(storeDir);
}
