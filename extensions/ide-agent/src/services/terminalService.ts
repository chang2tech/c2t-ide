import * as vscode from "vscode";
import { ComposerDataService } from "./composerDataService";
import {
  buildRunWrapper,
  detectShellKind,
  escapeXmlAttr,
  extractRunOutput,
  parseRunEnd,
  stripAnsiText,
} from "./terminalUtils";
import { SHELL_BACKGROUND_TIMEOUT_MS } from "./agentRuntime";

/**
 * TerminalService — Cursor-style terminal integration for the agent.
 *
 * Cursor surface (docs + deep-docs-all.md):
 *   - Cmd+K prompt bar in the terminal (describe a command in plain language;
 *     Enter sends it to the agent with terminal context, Esc/insert puts the
 *     text into the terminal without running it)
 *   - @Terminal(s) mention attaching terminal output to chat
 *   - agent runs commands in the background and sees exit codes
 *   - commands editable before they run (via the existing approval card)
 *   - `terminal.enableAiChecks`-style setting gating AI access to terminals
 *
 * Implementation notes:
 * - Uses the stock VS Code Terminal API only (`window.createTerminal`,
 *   `terminal.sendText`). Terminal *output* capture uses the proposed
 *   `window.onDidWriteTerminalData` event (declared in vscode-proposed.d.ts,
 *   enabled via `enabledApiProposals: ["terminalDataWriteEvent"]` in
 *   package.json) — a per-terminal ring buffer feeds @Terminal and the
 *   background-run streamer.
 * - Background runs execute with a shell-family-aware wrapper
 *   (buildRunWrapper: posix/fish/powershell/cmd detected from
 *   terminal.creationOptions.shellPath) so `exit` inside the command cannot
 *   kill the terminal, and output is framed with
 *   __IDE_RUN_BEGIN__ / __IDE_RUN_END__=<code> markers so the exit code is
 *   recovered exactly and the echoed wrapper line is excluded from chat.
 */
const MAX_RAW_BUFFER = 256 * 1024;
/** Default cap for terminal chars attached as chat context. */
const DEFAULT_CONTEXT_CHARS = 20000; // curation restored 2026-10-19: tail window keeps @Terminal context focused; user-configurable via ide.agent.terminal.maxBufferChars
/**
 * Background command timeout — then Ctrl+C is sent.
 * DD-AR-10 (Cursor parity): 10 min = SHELL_BACKGROUND_TIMEOUT_MS.
 * (Foreground 30s / hard 24h / default 5min live in agentRuntime.ts; the
 * engine's own shell tool enforces them server-side.)
 */
const BG_TIMEOUT_MS = SHELL_BACKGROUND_TIMEOUT_MS;
/** Chat bubble refresh throttle while streaming (ms). */
const STREAM_FLUSH_MS = 500;

interface ActiveRun {
  raw: string;
  resolve: (exitCode: number) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  startedAt: number;
  bubbleId: string;
  lastFlush: number;
}

export class TerminalService implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly buffers = new Map<
    vscode.Terminal,
    { chunks: string[]; total: number }
  >();
  private bgTerminal: vscode.Terminal | undefined;
  /** Serializes background runs — one at a time. */
  private bgChain: Promise<void> = Promise.resolve();
  private activeRun: ActiveRun | null = null;

  constructor(private readonly getComposer: () => ComposerDataService) {}
  /** The active tab's composer — terminal output always lands in the visible chat. */
  private get composer(): ComposerDataService { return this.getComposer(); }

  activate(context: vscode.ExtensionContext): void {
    this.disposables.push(
      vscode.window.onDidWriteTerminalData((e) =>
        this.onTerminalData(e.terminal, e.data),
      ),
      vscode.window.onDidCloseTerminal((t) => this.onTerminalClosed(t)),
    );
    context.subscriptions.push(this);
  }

  dispose(): void {
    if (this.activeRun) {
      const run = this.activeRun;
      this.activeRun = null;
      clearTimeout(run.timer);
      // GAPS-14: run ended — drop the cancel keybinding's scope and settle
      // the awaiting turn instead of leaking a never-settling promise.
      this.setTerminalToolCallRunning(false);
      run.reject(new Error("the IDE Agent terminal service was disposed"));
    }
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
    this.buffers.clear();
  }

  // ---- output capture ----------------------------------------------------

  private onTerminalData(terminal: vscode.Terminal, data: string): void {
    let buf = this.buffers.get(terminal);
    if (!buf) {
      buf = { chunks: [], total: 0 };
      this.buffers.set(terminal, buf);
    }
    buf.chunks.push(data);
    buf.total += data.length;
    while (buf.total > MAX_RAW_BUFFER && buf.chunks.length > 1) {
      const dropped = buf.chunks.shift();
      buf.total -= dropped ? dropped.length : 0;
    }

    if (this.activeRun && terminal === this.bgTerminal) {
      const run = this.activeRun;
      run.raw += data;
      const now = Date.now();
      if (now - run.lastFlush >= STREAM_FLUSH_MS) {
        run.lastFlush = now;
        const display = extractRunOutput(run.raw);
        if (display !== null) {
          this.composer.updateTerminalOutput(run.bubbleId, display);
        }
      }
      const exitCode = parseRunEnd(run.raw);
      if (exitCode !== null) {
        this.activeRun = null;
        clearTimeout(run.timer);
        const display = extractRunOutput(run.raw) ?? "";
        this.composer.updateTerminalOutput(run.bubbleId, display);
        this.composer.finishTerminalRun(
          run.bubbleId,
          exitCode,
          Date.now() - run.startedAt,
          false,
        );
        run.resolve(exitCode);
        // GAPS-14: run ended — drop the cancel keybinding's scope.
        this.setTerminalToolCallRunning(false);
      }
    }
  }

  private onTerminalClosed(t: vscode.Terminal): void {
    this.buffers.delete(t);
    if (this.bgTerminal === t) {
      this.bgTerminal = undefined;
      if (this.activeRun) {
        const run = this.activeRun;
        this.activeRun = null;
        clearTimeout(run.timer);
        this.composer.finishTerminalRun(
          run.bubbleId,
          -1,
          Date.now() - run.startedAt,
          false,
        );
        run.reject(new Error("the IDE Agent terminal was closed"));
        // GAPS-14: run ended — drop the cancel keybinding's scope.
        this.setTerminalToolCallRunning(false);
      }
    }
  }

  /** Recent output of a terminal, ANSI-stripped, tail-capped. */
  getTerminalText(
    terminal: vscode.Terminal,
  ): { name: string; text: string } | undefined {
    const buf = this.buffers.get(terminal);
    if (!buf || buf.total === 0) {
      return undefined;
    }
    const maxChars = vscode.workspace
      .getConfiguration("ide.agent.terminal")
      .get<number>("maxBufferChars", DEFAULT_CONTEXT_CHARS);
    const clean = stripAnsiText(buf.chunks.join(""));
    const text = clean.slice(Math.max(0, clean.length - maxChars));
    return text ? { name: terminal.name, text } : undefined;
  }

  getActiveTerminalText(): { name: string; text: string } | undefined {
    const term = vscode.window.activeTerminal;
    return term ? this.getTerminalText(term) : undefined;
  }

  /**
   * Expand `@Terminal` / `@Terminals` mentions in chat text into a context
   * block with the active terminal's recent output (Cursor's @Terminals).
   */
  expandTerminalMentions(text: string): string {
    if (!/(^|[\s(])@Terminals?\b/.test(text)) {
      return text;
    }
    const aiChecks = vscode.workspace
      .getConfiguration("ide.agent.terminal")
      .get<boolean>("enableAiChecks", true);
    let context: string;
    if (!aiChecks) {
      context =
        "(terminal context is disabled by ide.agent.terminal.enableAiChecks)";
    } else {
      const t = this.getActiveTerminalText();
      context = t
        ? `<terminal name="${escapeXmlAttr(t.name)}">\n${t.text}\n</terminal>`
        : "(no active terminal with captured output)";
    }
    // Replacer function: context may contain `$` (shell prompts).
    return text.replace(/(^|[\s(])@Terminals?\b/g, (_m, p1: string) => p1 + context);
  }

  // ---- Cmd+K prompt bar in the terminal -----------------------------------

  /**
   * Cursor's terminal Cmd+K: describe a command in plain language.
   * Enter → sends to the agent with the terminal's output as context
   * (commands are reviewed in the approval card before they run).
   * Insert button → puts the text into the terminal without running it
   * (Cursor's "Escape accepts into the terminal").
   */
  async openTerminalPrompt(): Promise<void> {
    const term = vscode.window.activeTerminal;
    if (!term) {
      void vscode.window.showInformationMessage(
        "IDE Agent: open a terminal first, then press Cmd+K (Ctrl+K).",
      );
      return;
    }
    const input = vscode.window.createInputBox();
    input.title = "Terminal AI command";
    // DEV-GAPS-9C: visibility sync for the core `promptBarVisible` context key
    // (browser/terminalCmdkActions.ts — the `cursorai.action.*` Cmd+K family's
    // when-clauses). The workbench side registers
    // `composer.terminalPromptBar.setVisible`; args are JSON-safe for the
    // extension-host boundary. No-op if the workbench side isn't registered.
    const notifyPromptBarVisible = (visible: boolean) => {
      void vscode.commands.executeCommand(
        "composer.terminalPromptBar.setVisible",
        visible,
      );
    };
    input.prompt =
      "Describe the command in plain language. Enter sends it to the agent with terminal context; Esc accepts your text into the terminal without running it; the insert button does the same explicitly.";
    input.placeholder = "e.g. find the largest files in this repo";
    const insertBtn: vscode.QuickInputButton = {
      iconPath: new vscode.ThemeIcon("insert"),
      tooltip: "Insert into terminal without running",
    };
    input.buttons = [insertBtn];
    let done = false;
    const close = () => {
      done = true;
      input.dispose();
      notifyPromptBarVisible(false);
    };
    input.onDidAccept(() => {
      const desc = input.value.trim();
      close();
      if (desc) {
        // GAPS-170: tooltip pipeline disable producer — the binary emits
        // `terminal.cmdk.submit` when the terminal prompt bar is submitted
        // (desk@36718187). The fork's terminal prompt bar lives in this
        // extension, so the event reaches the core tooltipService through
        // the fork-local bridge command `composer.tooltip.registerEvent`.
        void vscode.commands.executeCommand(
          "composer.tooltip.registerEvent",
          "terminal.cmdk.submit",
        );
        this.sendTerminalRequest(term, desc);
      }
    });
    input.onDidTriggerButton((btn) => {
      if (btn === insertBtn) {
        const desc = input.value.trim();
        close();
        if (desc) {
          term.sendText(desc, false);
        }
        term.show();
      }
    });
    input.onDidHide(() => {
      if (!done) {
        // Cursor parity: Escape accepts the typed text into the terminal
        // without running it (same as the insert button).
        const desc = input.value.trim();
        input.dispose();
        notifyPromptBarVisible(false);
        if (desc) {
          term.sendText(desc, false);
          term.show();
        }
      } else {
        input.dispose();
      }
    });
    input.show();
    notifyPromptBarVisible(true);
  }

  private sendTerminalRequest(term: vscode.Terminal, desc: string): void {
    const ctx = this.getTerminalText(term);
    const contextBlock = ctx
      ? `<terminal name="${escapeXmlAttr(ctx.name)}">\n${ctx.text}\n</terminal>\n\n`
      : "";
    this.composer.submit(
      `${contextBlock}Terminal request: ${desc}\n\nRun the needed shell commands for this request via the shell tool. Present each command in the approval card before running so it can be reviewed.`,
    );
    void vscode.commands.executeCommand("ideAgent.chatView.focus");
  }

  // ---- background command execution ---------------------------------------

  /**
   * Run a shell command in the background "IDE Agent" terminal, streaming
   * its output into the chat and reporting the exit code when done.
   * Runs are serialized; a 10-minute timeout sends Ctrl+C.
   */
  runBackgroundCommand(command?: string): Promise<void> {
    const task = async (): Promise<void> => {
      let cmd = (command ?? "").trim();
      if (!cmd) {
        const picked = await vscode.window.showInputBox({
          prompt: "Run a command in the background (output streams to chat)",
          placeHolder: "npm test",
        });
        if (!picked?.trim()) {
          return;
        }
        cmd = picked.trim();
      }
      try {
        await this.execInBackground(cmd);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(
          `IDE Agent: background command failed — ${message}`,
        );
      }
    };
    this.bgChain = this.bgChain.then(task, task);
    return this.bgChain;
  }

  private getBackgroundTerminal(): vscode.Terminal {
    if (!this.bgTerminal) {
      this.bgTerminal = vscode.window.createTerminal({
        name: "IDE Agent",
        hideFromUser: true,
      });
    }
    return this.bgTerminal;
  }

  private execInBackground(cmd: string): Promise<void> {
    const term = this.getBackgroundTerminal();
    const bubbleId = this.composer.postTerminalRun(cmd);
    const startedAt = Date.now();
    // Shell-family-aware wrapper: exit inside the command can't kill our
    // terminal, and the framing markers recover the exit code and exclude
    // the echoed wrapper line from the chat output.
    const creationOptions = term.creationOptions;
    const shellPath =
      creationOptions && "shellPath" in creationOptions
        ? creationOptions.shellPath
        : undefined;
    const kind = detectShellKind(shellPath);
    const wrapped = buildRunWrapper(cmd, kind);
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const run = this.activeRun;
        if (run) {
          this.endActiveRun(run, {
            timedOut: true,
            error: new Error("timed out after 10 minutes (sent Ctrl+C)"),
          });
        }
      }, BG_TIMEOUT_MS);
      this.activeRun = {
        raw: "",
        resolve: () => resolve(),
        reject,
        timer,
        startedAt,
        bubbleId,
        lastFlush: 0,
      };
      this.setTerminalToolCallRunning(true);
      term.sendText(wrapped, true);
    });
  }

  /**
   * GAPS-14: whether a terminal tool call is currently running. Used by the
   * `ide.cancelTerminalToolCall` handler to pick the binary's run-body order
   * (reject pending terminal decisions first, else cancel the running
   * stream) without racing cancelActiveRun().
   */
  hasActiveRun(): boolean {
    return this.activeRun !== null;
  }

  /**
   * GAPS-14 (agent-shell-approval-keyboard-flow): cancel the currently
   * running terminal tool call — the runtime half of Cursor's
   * `composer.cancelTerminalToolCall` (Shift+Backspace). Sends Ctrl+C to
   * the background terminal (the same interrupt the 10-minute timeout
   * uses), marks the chat bubble cancelled and rejects the awaiting turn
   * so the agent observes the cancellation. Returns true when a run was
   * actually interrupted, false when nothing was running.
   */
  cancelActiveRun(): boolean {    const run = this.activeRun;
    if (!run) {
      return false;
    }
    this.endActiveRun(run, {
      cancelled: true,
      error: new Error("cancelled by user"),
    });
    return true;
  }

  /**
   * Shared interrupt path for the timeout and the user cancel: Ctrl+C to
   * the background terminal, bubble bookkeeping, promise settlement and
   * clearing the `ideAgent.terminalToolCallRunning` context key.
   */
  private endActiveRun(
    run: ActiveRun,
    opts: { timedOut?: boolean; cancelled?: boolean; error: Error },
  ): void {
    this.activeRun = null;
    clearTimeout(run.timer);
    if (this.bgTerminal) {
      this.bgTerminal.sendText("\u0003", false); // Ctrl+C
    }
    const display = extractRunOutput(run.raw) ?? "";
    this.composer.updateTerminalOutput(run.bubbleId, display);
    this.composer.finishTerminalRun(
      run.bubbleId,
      -1,
      Date.now() - run.startedAt,
      opts.timedOut ?? false,
      opts.cancelled ?? false,
    );
    run.reject(opts.error);
    this.setTerminalToolCallRunning(false);
  }

  /**
   * GAPS-14: publish whether a terminal tool call is running. Core bridges
   * `ideAgent.terminalToolCallRunning` -> `composer.terminalToolCallRunning`
   * (composerContextKeysBridge.ts) to scope the Shift+Backspace binding.
   */
  private setTerminalToolCallRunning(running: boolean): void {
    try {
      void vscode.commands.executeCommand(
        "setContext",
        "ideAgent.terminalToolCallRunning",
        running,
      );
    } catch {
      // setContext is best-effort: a missing command must never break runs.
    }
  }
}
