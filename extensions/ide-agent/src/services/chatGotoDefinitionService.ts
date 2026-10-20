import * as vscode from "vscode";

/**
 * agent-chat-goto-definition — Go to definition from AI chat response.
 *
 * Cursor parity evidence (binary, Cursor 3.25.6): the string
 * `aichat.action.goToDefinitionFromChatResponse` is registered as a command
 * id in workbench.glass.main.js. Behavior (verified): symbols/entities
 * rendered in an AI chat response are actionable; invoking the command
 * navigates the editor to the definition of the symbol.
 *
 * UNKNOWN (not recoverable from the evidence): whether Cursor resolves the
 * definition via the language server or re-uses a location captured at
 * render time. This implementation resolves via
 * `vscode.executeDefinitionProvider` so the navigation always lands on the
 * current, accurate definition — falling back to the captured location when
 * no definition is found.
 *
 * Testable module: all VS Code access goes through the injected `Vscode`
 * seam. The real seam is the default; tests inject a stub.
 */

export const COMMAND_ID = "aichat.action.goToDefinitionFromChatResponse";

/**
 * Argument payload carried on the chat response's symbol entity.
 * `source` is a file path or URI string pointing at the location of the
 * symbol as rendered (usually the usage site in the response context).
 */
export interface ChatSymbolArgs {
  /** Symbol name as rendered in the chat response. */
  symbol?: string;
  /** File path or URI string of the reference location. */
  source?: string;
  /** Location of the symbol occurrence (0-based). */
  line?: number;
  character?: number;
}

export interface DefinitionTarget {
  uri: vscode.Uri;
  range: vscode.Range;
}

export interface GotoDefinitionVscode {
  asUri(source: string): vscode.Uri;
  positionAt(line: number, character: number): vscode.Position;
  makeRange(start: vscode.Position, end: vscode.Position): vscode.Range;
  executeDefinitionProvider(
    uri: vscode.Uri,
    position: vscode.Position,
  ): Promise<unknown>;
  showTextDocument(uri: vscode.Uri, selection: vscode.Range): Promise<unknown>;
  showInformationMessage(message: string): void;
  logError?(err: unknown): void;
}

/** Production seam backed by the real vscode API. */
export const realGotoDefinitionVscode: GotoDefinitionVscode = {
  asUri: (source: string) =>
    source.includes("://") ? vscode.Uri.parse(source) : vscode.Uri.file(source),
  positionAt: (line, character) => new vscode.Position(line, character),
  makeRange: (start, end) => new vscode.Range(start, end),
  executeDefinitionProvider: (uri, position) =>
    Promise.resolve(
      vscode.commands.executeCommand<unknown[]>(
        "vscode.executeDefinitionProvider",
        uri,
        position,
      ) as unknown,
    ),
  showTextDocument: (uri, selection) =>
    Promise.resolve(
      vscode.window.showTextDocument(uri, {
        selection,
        preview: false,
      }) as unknown,
    ),
  showInformationMessage: (message) =>
    void vscode.window.showInformationMessage(message),
  logError: (err) => console.error("[chatGotoDefinition]", err),
};

function isLocationLike(v: unknown): v is vscode.Location {
  return (
    typeof v === "object" &&
    v !== null &&
    "uri" in v &&
    "range" in v &&
    typeof (v as vscode.Location).uri !== "undefined" &&
    typeof (v as vscode.Location).range !== "undefined"
  );
}

function isLocationLinkLike(v: unknown): v is vscode.LocationLink {
  return (
    typeof v === "object" &&
    v !== null &&
    "targetUri" in v &&
    "targetRange" in v &&
    typeof (v as vscode.LocationLink).targetUri !== "undefined" &&
    typeof (v as vscode.LocationLink).targetRange !== "undefined"
  );
}

/**
 * Resolve a single definition target from the raw
 * `vscode.executeDefinitionProvider` result (Location[] | LocationLink[]).
 * Takes the first item — VS Code's own "Go to Definition" UX also prefers
 * the first result when there is exactly one.
 */
export function pickDefinitionTarget(result: unknown): DefinitionTarget | undefined {
  if (!Array.isArray(result)) return undefined;
  for (const item of result) {
    if (isLocationLike(item)) {
      return { uri: item.uri, range: item.range };
    }
    if (isLocationLinkLike(item)) {
      return { uri: item.targetUri, range: item.targetRange };
    }
  }
  return undefined;
}

export interface ResolvedSymbolLocation {
  uri: vscode.Uri;
  position: vscode.Position;
  symbol?: string;
}

/** Normalize the command argument payload into a concrete URI + position. */
export function resolveSymbolLocation(
  args: unknown,
  seam: GotoDefinitionVscode,
): ResolvedSymbolLocation | undefined {
  const a = (args ?? {}) as ChatSymbolArgs;
  if (!a.source) return undefined;
  const line = Number.isInteger(a.line) ? (a.line as number) : 0;
  const character = Number.isInteger(a.character) ? (a.character as number) : 0;
  if (line < 0 || character < 0) return undefined;
  try {
    return {
      uri: seam.asUri(a.source),
      position: seam.positionAt(line, character),
      symbol: a.symbol,
    };
  } catch {
    return undefined;
  }
}

/**
 * Core behavior: resolve the symbol's definition and reveal it in the
 * editor. Returns a short status string consumed by callers/tests.
 */
export async function goToDefinitionFromChatResponse(
  args: unknown,
  seam: GotoDefinitionVscode = realGotoDefinitionVscode,
): Promise<"navigated" | "fallback-to-source" | "no-source"> {
  const location = resolveSymbolLocation(args, seam);
  if (!location) {
    seam.showInformationMessage("Go to definition: no source location attached to this symbol.");
    return "no-source";
  }
  try {
    const result = await seam.executeDefinitionProvider(location.uri, location.position);
    const target = pickDefinitionTarget(result);
    if (target) {
      await seam.showTextDocument(target.uri, target.range);
      return "navigated";
    }
  } catch (err) {
    seam.logError?.(err);
  }
  // No definition found: fall back to revealing the captured source location
  // (usually the usage site), rather than doing nothing.
  const zeroRange = seam.makeRange(location.position, location.position);
  await seam.showTextDocument(location.uri, zeroRange);
  return "fallback-to-source";
}

/**
 * Register the command on the extension context.
 * Returns the registered command id (== COMMAND_ID).
 */
export function registerChatGotoDefinition(
  context: vscode.ExtensionContext,
  seam: GotoDefinitionVscode = realGotoDefinitionVscode,
): string {
  const disposable = vscode.commands.registerCommand(COMMAND_ID, (args: unknown) => {
    return goToDefinitionFromChatResponse(args, seam);
  });
  context.subscriptions.push(disposable);
  return COMMAND_ID;
}
