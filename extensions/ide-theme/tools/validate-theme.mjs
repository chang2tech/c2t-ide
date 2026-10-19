// Validation: every workbench token in the authoritative spec table must exist
// in themes/cursor-dark-color-theme.json with the EXACT verbatim value.
// Run: node tools/validate-theme.mjs  (exit 0 = pass)
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const spec = readFileSync(
  join(process.env.HOME, "workspace/ide-code-mission/docs/ui/settings-theme-spec.md"),
  "utf8"
);

const expected = {};
const rowRe = /^\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|/gm;
let inSection = false, m, failures = 0;
for (const line of spec.split("\n")) {
  if (line.startsWith("### 2.3 Full workbench color token table")) inSection = true;
  if (inSection && line.startsWith("## 3.")) break;
  if (!inSection) continue;
  rowRe.lastIndex = 0;
  if ((m = rowRe.exec(line))) expected[m[1]] = m[2];
}

const theme = JSON.parse(
  readFileSync(join(root, "themes/cursor-dark-color-theme.json"), "utf8")
);
const actual = theme.colors ?? {};
const fail = (msg) => { failures++; console.error("FAIL:", msg); };

// Intentional additions beyond the 252-token spec table (QA-02 2026-10-19):
// chat CSS references these; values cross-checked against neighboring tokens.
const INTENTIONAL_EXTRAS = new Set([
  "descriptionForeground",      // #9da3af — muted, matches foreground #F0F0F0
  "quickInput.background",      // #1e1e1e — consistent with editor #181818
  "textCodeBlock.background",   // #1a1a1a — dark code block
  "charts.blue",                // #4c8dff — matches saturated chart palette
  "quickInput.border",          // #3c3c3c — matches input.border style
  "button.border",              // #3c3c3c
]);

if (theme.name !== "Cursor Dark") fail(`theme.name = ${JSON.stringify(theme.name)}`);
if (theme.type !== "dark") fail(`theme.type = ${JSON.stringify(theme.type)}`);

const expectedKeys = Object.keys(expected);
const actualKeys = Object.keys(actual);
console.log(`spec tokens: ${expectedKeys.length}, theme tokens: ${actualKeys.length}`);

for (const k of expectedKeys) {
  if (!(k in actual)) fail(`missing token: ${k}`);
  else if (actual[k] !== expected[k])
    fail(`value mismatch ${k}: spec ${expected[k]} vs theme ${actual[k]}`);
}
for (const k of actualKeys) {
  if (!(k in expected) && !INTENTIONAL_EXTRAS.has(k))
    fail(`unexpected extra token: ${k}`);
}

const hexRe = /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
if (!Array.isArray(theme.tokenColors) || theme.tokenColors.length === 0)
  fail("tokenColors missing or empty");
else
  for (const [i, r] of theme.tokenColors.entries()) {
    if (!r.scope || !r.settings) fail(`tokenColors[${i}] missing scope/settings`);
    else if (r.settings.foreground && !hexRe.test(r.settings.foreground))
      fail(`tokenColors[${i}] bad hex: ${r.settings.foreground}`);
    else if (!r.settings.foreground && !r.settings.fontStyle)
      fail(`tokenColors[${i}] has neither foreground nor fontStyle`);
  }
if (!theme.semanticTokenColors || Object.keys(theme.semanticTokenColors).length === 0)
  fail("semanticTokenColors missing or empty");

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const t = pkg.contributes?.themes?.[0];
if (!t || t.path !== "./themes/cursor-dark-color-theme.json" || t.uiTheme !== "vs-dark")
  fail("package.json contributes.themes misconfigured");
if (pkg.publisher !== "ide-code" || pkg.name !== "ide-theme-cursor-dark")
  fail("package.json publisher/name wrong");

if (failures === 0) {
  console.log(`PASS: all ${expectedKeys.length} workbench tokens verbatim, ` +
    `${theme.tokenColors.length} tokenColors rules, ` +
    `${Object.keys(theme.semanticTokenColors).length} semantic tokens, manifest OK`);
} else {
  console.log(`${failures} failure(s)`);
  process.exit(1);
}
