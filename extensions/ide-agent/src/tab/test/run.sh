#!/bin/bash
# Self-test runner for the Tab engine (QA-FILE-06 regression suite).
# Compiles the vscode-free tab modules + the fork's real KeybindingParser,
# then runs 55 checks (baseline mechanics + QA-FILE-06 fix regressions).
# Usage: bash src/tab/test/run.sh   (from extensions/ide-agent/)
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
EXT="$HERE/../../.."
FORK="$HERE/../../../../.."
OUTDIR=/tmp/tab-test/out
VSOUT=/tmp/tab-test/vs-out
TSC="$EXT/node_modules/.bin/tsc"

mkdir -p "$OUTDIR" "$VSOUT"
"$TSC" --outDir "$OUTDIR" --declaration false --esModuleInterop --skipLibCheck \
  --lib ES2022,DOM --module commonjs --moduleResolution node --target ES2022 \
  --types node --typeRoots "$EXT/node_modules/@types" \
  "$EXT/src/tab/wordAccept.ts" "$EXT/src/tab/gates.ts" "$EXT/src/tab/telemetry.ts" \
  "$EXT/src/tab/nextEdit.ts" "$EXT/src/tab/types.ts" "$EXT/src/tab/backend.ts" \
  "$EXT/src/tab/snooze.ts" "$EXT/src/tab/debounce.ts"
"$TSC" --outDir "$VSOUT" --declaration false --esModuleInterop --skipLibCheck \
  --lib ES2022,DOM --module nodenext --moduleResolution nodenext --target ES2022 \
  "$FORK/src/vs/base/common/keybindingParser.ts" \
  "$FORK/src/vs/base/common/keybindings.ts" \
  "$FORK/src/vs/base/common/keyCodes.ts"
node "$HERE/selftest-tab.cjs"
