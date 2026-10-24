# IDE Code

IDE Code is a Cursor-class AI-native code editor built on the open-source
[VS Code](https://github.com/microsoft/vscode) foundation (MIT).

It pairs a full workbench — editor, terminal, Git, debugging, extensions —
with a deeply integrated AI agent powered by the
[ide-code](https://github.com/chang2tech/ide-code) engine:

- **Agent / Ask / Plan / Debug / Multitask** chat modes, as editor tabs or sidebar
- **Tab completion** with next-edit prediction
- **Inline edit** (Cmd+K) with follow-up history
- **Browser tab for the agent**: navigate, screenshot, pick elements, feed to chat
- **Terminal "Add to Chat"** floating toolbar on text selection
- **MCP servers**, **Agent Skills**, **Hooks**, **Checkpoints**, **Rules**
- **Local-first codebase indexing** — your code is never uploaded

## Download — v0.1.0-alpha.42

The latest alpha with a fully green build (Linux + Windows) and a passing
boot-test on the real packaged app
([build run 40028283461](https://github.com/chang2tech/c2t-ide/actions/runs/40028283461)):

| Platform | File | Size | Download |
|----------|------|------|----------|
| Windows x64 | `ide-code-windows-x64-v1.143.0.zip` (contains `IDE-Code-Setup-x64-1.143.0.exe`) | 380,372,762 B | [Download](https://github.com/chang2tech/c2t-ide/actions/runs/40028283461/artifacts/12535560708) |
| Linux (.deb) | `ide-code-linux-x64-deb-v1.143.0.zip` (contains `ide-code_1.143.0-1792792421_amd64.deb`) | 371,739,204 B | [Download](https://github.com/chang2tech/c2t-ide/actions/runs/40028283461/artifacts/12534173217) |
| Linux (AppImage) | `ide-code-linux-x64-appimage-v1.143.0.zip` (contains `IDE-Code-1.143.0-linux-x64.AppImage`) | 477,153,968 B | [Download](https://github.com/chang2tech/c2t-ide/actions/runs/40028283461/artifacts/12533873913) |

SHA-256 (of the .zip files):

- Windows: `29b41dcec300e650366a060985da8fde59ab894b9c4446e6b0abff9cc89c45d9`
- Linux .deb: `fbc1011a30359e21222f1dd162b5afb07fd8c35fb300e81d849347f1f445163a`
- Linux AppImage: `e2476fd9e07184fdf742c2bc81d547bd15fb803b33642adb008f77c35b485a9b`

Notes: these are GitHub Actions artifacts (GitHub sign-in required) and
expire on 2027-01-21. Builds are unsigned — on Windows, SmartScreen will
warn: choose **More info → Run anyway**.

## Building

```sh
npm ci --ignore-scripts
npm run gulp vscode-linux-x64
```

Prebuilt binaries are published from the
[Actions](../../actions/workflows/build-ide-code.yml) workflow
(`Build IDE Code (Linux)` → AppImage + .deb).

## License

MIT — see [LICENSE.txt](LICENSE.txt). This project is a fork of
[microsoft/vscode](https://github.com/microsoft/vscode); the original
Microsoft copyright notice is retained as required by the license.
