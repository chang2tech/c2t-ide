/**
 * cli.ts — entry point for the IDE Code CLI (compiles to out/cli.js).
 *
 * Launched by bin/ide-code as: ELECTRON_RUN_AS_NODE=1 <electron> out/cli.js "$@".
 * Parses argv, dispatches, and exits with the dispatch exit code.
 * Unexpected errors -> stderr + exit 1 (never a silent crash).
 */

import * as process from "node:process";
import { dispatch } from "./dispatch";

async function main(): Promise<void> {
  const code = await dispatch(process.argv.slice(2));
  process.exit(code);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`error: unexpected failure: ${msg}\n`);
  process.exit(1);
});
