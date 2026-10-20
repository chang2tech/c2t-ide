/**
 * Engine checkout path helpers.
 *
 * Split out of composerDataService so light-weight bridges (codebase index,
 * instant grep) can resolve the engine path without importing the whole
 * composer module graph. composerDataService re-exports this; existing
 * imports keep working.
 */
import * as path from "path";

/** Best-effort default for the engine checkout: ~/workspace/ide-code. */
export function defaultEnginePath(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  return path.join(home, "workspace", "ide-code");
}
