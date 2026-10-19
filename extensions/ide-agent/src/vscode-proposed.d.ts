// Local declarations for the proposed `terminalDataWriteEvent` API.
// Runtime: implemented in the fork's extHost, gated by "enabledApiProposals"
// in package.json. Types: declared here because @types/vscode only ships the
// stable API surface.
declare module "vscode" {
  export interface TerminalDataWriteEvent {
    readonly terminal: Terminal;
    readonly data: string;
  }
  namespace window {
    export const onDidWriteTerminalData: Event<TerminalDataWriteEvent>;
  }
}
