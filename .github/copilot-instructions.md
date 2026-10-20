# IDE Code — Copilot Instructions

IDE Code is a desktop AI IDE built on a fork of the VS Code codebase (Electron + TypeScript), with an OpenCode-derived agent engine as the AI backend.

## Working in this repo

- Follow the conventions in the root `AGENTS.md` and the nearest package-level docs.
- TypeScript throughout the workbench (`src/`), built-in extensions (`extensions/`), and build tooling (`build/`).
- Do not edit generated output under `out/` or `out-build/`; change the sources instead.
- Run the narrowest relevant checks for a change (unit tests for the touched area, `tsc` for the touched project) before broader validation; full builds run in CI.
- Never commit secrets, tokens, or machine-local configuration.
