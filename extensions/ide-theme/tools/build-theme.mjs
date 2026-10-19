// Build script: parses the authoritative 252-token table from
// docs/ui/settings-theme-spec.md and emits themes/cursor-dark-color-theme.json
// with verbatim workbench colors + curated tokenColors/semanticTokenColors.
// Run: node tools/build-theme.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const specPath = join(
  process.env.HOME,
  "workspace/ide-code-mission/docs/ui/settings-theme-spec.md"
);

const spec = readFileSync(specPath, "utf8");
// Only the token tables in §2.3: rows look like | `token.name` | `#VALUE` |
const colors = {};
const rowRe = /^\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|/gm;
let m;
let inTokenSection = false;
for (const line of spec.split("\n")) {
  if (line.startsWith("### 2.3 Full workbench color token table")) inTokenSection = true;
  if (inTokenSection && line.startsWith("## 3.")) break;
  if (!inTokenSection) continue;
  rowRe.lastIndex = 0;
  const r = rowRe.exec(line);
  if (r) {
    const [, key, value] = r;
    if (colors[key] && colors[key] !== value) {
      throw new Error(`Conflicting values for ${key}: ${colors[key]} vs ${value}`);
    }
    colors[key] = value;
  }
}

const hexRe = /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
for (const [k, v] of Object.entries(colors)) {
  if (!hexRe.test(v)) throw new Error(`Non-hex value for ${k}: ${v}`);
}

// Syntax highlighting: Nord-leaning palette harmonized with the extracted
// workbench accents (81A1C1 / 88C0D0 / B48EAD / 3FA266 / E34671 / F1B467).
const tokenColors = [
  { name: "Comment", scope: ["comment", "punctuation.definition.comment"], settings: { foreground: "#6A9955" } },
  { name: "String", scope: ["string", "string.quoted", "string.template", "punctuation.definition.string"], settings: { foreground: "#A3BE8C" } },
  { name: "Keyword", scope: ["keyword", "keyword.control", "keyword.operator.new", "storage", "storage.type", "storage.modifier"], settings: { foreground: "#81A1C1" } },
  { name: "Number and constant", scope: ["constant.numeric", "constant.language", "constant.character", "variable.other.constant"], settings: { foreground: "#B48EAD" } },
  { name: "Function and method", scope: ["entity.name.function", "support.function", "meta.function-call.generic", "variable.function"], settings: { foreground: "#88C0D0" } },
  { name: "Class and type", scope: ["entity.name.type", "entity.name.class", "entity.name.namespace", "support.type", "support.class", "storage.type.class"], settings: { foreground: "#EBCB8B" } },
  { name: "Variable and parameter", scope: ["variable", "variable.parameter", "variable.other.property", "meta.definition.variable"], settings: { foreground: "#F0F0F0" } },
  { name: "Tag name (markup)", scope: ["entity.name.tag", "punctuation.definition.tag"], settings: { foreground: "#81A1C1" } },
  { name: "Attribute name", scope: ["entity.other.attribute-name", "entity.other.attribute-name.class.css", "entity.other.attribute-name.id.css"], settings: { foreground: "#88C0D0" } },
  { name: "CSS/JSON property", scope: ["support.type.property-name.css", "support.type.property-name.json"], settings: { foreground: "#88C0D0" } },
  { name: "Decorator and annotation", scope: ["meta.annotation", "meta.decorator", "punctuation.decorator"], settings: { foreground: "#F1B467" } },
  { name: "Regular expression", scope: ["string.regexp"], settings: { foreground: "#D2943E" } },
  { name: "Markup heading", scope: ["markup.heading", "entity.name.section.markdown"], settings: { fontStyle: "bold", foreground: "#81A1C1" } },
  { name: "Markup bold", scope: ["markup.bold"], settings: { fontStyle: "bold" } },
  { name: "Markup italic", scope: ["markup.italic"], settings: { fontStyle: "italic" } },
  { name: "Markup link", scope: ["markup.underline.link", "string.other.link"], settings: { fontStyle: "underline", foreground: "#81A1C1" } },
  { name: "Invalid", scope: ["invalid", "invalid.illegal"], settings: { foreground: "#FC6B83" } },
  { name: "Deprecated", scope: ["markup.deprecated", "invalid.deprecated"], settings: { fontStyle: "strikethrough", foreground: "#F0F0F05C" } },
];

const semanticTokenColors = {
  class: "#EBCB8B",
  comment: "#6A9955",
  enumMember: "#B48EAD",
  function: "#88C0D0",
  keyword: "#81A1C1",
  method: "#88C0D0",
  number: "#B48EAD",
  parameter: "#F0F0F0",
  string: "#A3BE8C",
  type: "#EBCB8B",
  "variable.readonly": "#F0F0F0",
};

const theme = {
  name: "Cursor Dark",
  type: "dark",
  colors,
  tokenColors,
  semanticTokenColors,
};

mkdirSync(join(root, "themes"), { recursive: true });
writeFileSync(join(root, "themes/cursor-dark-color-theme.json"), JSON.stringify(theme, null, 2) + "\n");

console.log(`workbench color tokens: ${Object.keys(colors).length}`);
console.log(`tokenColors rules: ${tokenColors.length}`);
console.log(`semanticTokenColors: ${Object.keys(semanticTokenColors).length}`);
console.log("wrote themes/cursor-dark-color-theme.json");
