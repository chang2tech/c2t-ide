# Cursor Dark (IDE Code)

A VS Code color theme reproducing Cursor's shipped dark theme with full workbench
fidelity.

- **252 workbench color tokens** — values reproduced from Cursor's
  `cursor-dark-color-theme.json` (chrome `#141414`, editor `#181818`, text
  `#F0F0F0` with alpha-stepped de-emphasis, accent `#81A1C1`, badge teal `#88C0D0`).
- **18 TextMate `tokenColors` rules** — Nord-leaning syntax palette harmonized with
  the workbench accents.
- **11 semantic token mappings**.

## Build

```sh
node tools/build-theme.mjs     # regenerate themes/cursor-dark-color-theme.json from docs/ui/settings-theme-spec.md
node tools/validate-theme.mjs   # assert all 252 tokens verbatim + manifest sanity
npx @vscode/vsce package        # build the .vsix
```

## Install

Install the generated `.vsix` via **Extensions → … → Install from VSIX**, then select
**Cursor Dark** in Preferences → Color Theme.
