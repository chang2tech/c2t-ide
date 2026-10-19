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
