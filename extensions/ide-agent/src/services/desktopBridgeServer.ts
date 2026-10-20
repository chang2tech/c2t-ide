/**
 * Desktop bridge SERVER — the in-IDE side of `ide-code desktop ls|send`.
 *
 * Spec: ~/workspace/ide-code-mission/docs/rea/dig-cli-2026-10-19.md
 * §3.1 (OBSERVED wire spec), §4.2, §5 P2. Every behavior below cites the
 * spec section it mirrors.
 *
 * On start: writes `~/.ide-code/desktop-bridge/instance-<pid>.json` (spec
 * §5 P2-8 schema) and serves HTTP POST `/` over a unix domain socket
 * (`bridge-<pid>.sock`, mode 0600), guarded by `Authorization: Bearer
 * <token>` (64-hex, crypto-generated). On stop: closes the server and
 * deletes the JSON + socket (best-effort, never throws).
 *
 * Concurrency: Node's HTTP server serializes request handling on the event
 * loop, and each request performs only synchronous composer calls
 * (isRunning/abort/submit). Overlapping `sendMessage` requests are therefore
 * safe — one at a time per socket is sufficient by construction.
 */

import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { compareChatTabs } from "./chatTabService";

/** Spec §5 P2-8: bridge dir default. */
export const DESKTOP_BRIDGE_DIR = path.join(os.homedir(), ".ide-code", "desktop-bridge");
/** Spec §3.1 R1: protocolVersion must equal 1. */
export const DESKTOP_BRIDGE_PROTOCOL_VERSION = 1;
/** Spec §3.1 R1: token format /^[0-9a-f]{64}$/ — 32 random bytes as hex. */
export const APP_NAME = "IDE Code";

/** Minimal composer surface the bridge needs. ChatTabService's
 * ComposerDataService satisfies this structurally (isRunning is a public
 * getter, abort() and submit() are the same entry points the chat UI uses).
 * No running-state signal is invented: `isRunning` is the real turn flag
 * (composerDataService.ts) — never "unknown" here because the signal exists. */
export interface BridgeComposer {
  readonly isRunning: boolean;
  abort(): void;
  submit(text: string, opts?: { sendMode?: "default" | "manual" | "queue" | "sendNow" }): void;
}

export interface BridgeChatTab {
  id: string;
  title: string;
  createdAt: number;
  /** Cursor 2.1 pin parity — threads list sorts pinned first. */
  pinned: boolean;
  pinnedAt?: number;
  composer: BridgeComposer;
}

/** Minimal tab-source surface (ChatTabService satisfies this). */
export interface BridgeChatTabSource {
  listTabs(): BridgeChatTab[];
}

export interface DesktopBridgeServerOptions {
  chatTabs: BridgeChatTabSource;
  /** e.g. context.extension.packageJSON?.version — spec §3.1 appVersion. */
  appVersion: string;
  /** e.g. context.globalStorageUri.fsPath — spec §3.1 userDataDir. */
  userDataDir: string;
  /** Override for tests; default ~/.ide-code/desktop-bridge (spec §5 P2-8). */
  bridgeDir?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** 256 KiB request-body cap (spec §3.1 mentions wl=256*1024, unused in the
 * CLI bundle — reused here as a sane server-side limit). */
const MAX_BODY_BYTES = 256 * 1024;

export class DesktopBridgeServer {
  private server: http.Server | undefined;
  private token = "";
  private socketPath = "";
  private instancePath = "";
  private started = false;

  constructor(private readonly opts: DesktopBridgeServerOptions) {}

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    const dir = this.opts.bridgeDir ?? DESKTOP_BRIDGE_DIR;
    fs.mkdirSync(dir, { recursive: true });
    this.token = crypto.randomBytes(32).toString("hex"); // spec §3.1: 64-hex token
    this.socketPath = path.join(dir, `bridge-${process.pid}.sock`);
    try {
      fs.unlinkSync(this.socketPath);
    } catch {
      /* stale socket — ignore */
    }
    this.server = http.createServer((req, res) => {
      void this.handle(req, res).catch(() => {
        /* handle() never rejects, but never let the server die */
      });
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => reject(err);
      this.server!.once("error", onError);
      this.server!.listen(this.socketPath, () => {
        this.server!.removeListener("error", onError);
        resolve();
      });
    });
    try {
      fs.chmodSync(this.socketPath, 0o600);
    } catch {
      /* best-effort */
    }
    // Spec §5 P2-8: instance JSON schema (matches the client's R1 validation).
    this.instancePath = path.join(dir, `instance-${process.pid}.json`);
    const record = {
      protocolVersion: DESKTOP_BRIDGE_PROTOCOL_VERSION,
      pid: process.pid,
      socketPath: this.socketPath,
      token: this.token,
      appName: APP_NAME,
      appVersion: this.opts.appVersion || "0.1.0-alpha",
      userDataDir: this.opts.userDataDir || "",
      createdAt: Date.now(),
    };
    fs.writeFileSync(this.instancePath, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
    this.started = true;
  }

  /** Best-effort teardown: close the server, delete JSON + socket. Never throws. */
  async stop(): Promise<void> {
    try {
      if (this.server) {
        const srv = this.server;
        this.server = undefined;
        await new Promise<void>((resolve) => srv.close(() => resolve()));
      }
    } catch {
      /* never throw */
    }
    for (const p of [this.instancePath, this.socketPath]) {
      if (p) {
        try {
          fs.unlinkSync(p);
        } catch {
          /* best-effort */
        }
      }
    }
    this.started = false;
  }

  /** For tests: the live instance record path. */
  get instanceFilePath(): string {
    return this.instancePath;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const send = (code: number, body: unknown): void => {
      try {
        const text = JSON.stringify(body);
        res.writeHead(code, {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(text),
        });
        res.end(text);
      } catch {
        try {
          res.end();
        } catch {
          /* give up */
        }
      }
    };
    try {
      if (req.method !== "POST" || req.url !== "/") {
        send(404, { status: "error", message: "not found" });
        return;
      }
      // Spec §3.1: Authorization: Bearer <token>, constant-time compare.
      if (!this.checkAuth(req.headers["authorization"])) {
        send(401, { status: "error", message: "unauthorized" });
        return;
      }
      const raw = await this.readBody(req);
      if (raw === undefined) {
        send(400, { status: "error", message: "request body too large" });
        return;
      }
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        send(400, { status: "error", message: "invalid JSON body" }); // spec §3.1: malformed → 400
        return;
      }
      if (!isRecord(body) || typeof body.type !== "string") {
        send(400, { status: "error", message: "missing message type" });
        return;
      }
      switch (body.type) {
        case "listThreads":
          send(200, { threads: this.listThreads() });
          return;
        case "sendMessage":
          send(200, this.sendMessage(body));
          return;
        default:
          send(400, { status: "error", message: `unknown message type: ${body.type}` });
      }
    } catch (err) {
      send(500, {
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Constant-time Bearer comparison (spec §3.1 requires the token check). */
  private checkAuth(header: string | string[] | undefined): boolean {
    if (typeof header !== "string" || !this.token) {
      return false;
    }
    const m = /^Bearer ([^\s]+)$/.exec(header.trim());
    if (!m) {
      return false;
    }
    // Hash both sides so timingSafeEqual never throws on length mismatch.
    const a = crypto.createHash("sha256").update(m[1], "utf8").digest();
    const b = crypto.createHash("sha256").update(this.token, "utf8").digest();
    return crypto.timingSafeEqual(a, b);
  }

  private readBody(req: http.IncomingMessage): Promise<string | undefined> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let tooLarge = false;
      req.on("data", (c: Buffer) => {
        if (tooLarge) {
          return;
        }
        size += c.length;
        if (size > MAX_BODY_BYTES) {
          tooLarge = true;
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => resolve(tooLarge ? undefined : Buffer.concat(chunks).toString("utf8")));
      req.on("error", () => resolve(tooLarge ? undefined : Buffer.concat(chunks).toString("utf8")));
    });
  }

  /**
   * listThreads → {threads:[{id,title,source,status,lastUpdatedAt,windowId}]}
   * (spec §3.1). id/title from listTabs(); status from the real running-turn
   * signal (ComposerDataService.isRunning); source is "local" (we have no
   * cloud/draft/claude-code threads); lastUpdatedAt = tab.createdAt (the
   * ChatTab record carries no separate updated-at signal).
   */
  private listThreads(): Array<Record<string, unknown>> {
    // Cursor 2.1 pin parity: pinned chats first (pin order), then time
    // order — the same comparator as every other chat list surface.
    return this.opts.chatTabs
      .listTabs()
      .slice()
      .sort(compareChatTabs)
      .map((t) => ({
        id: t.id,
        title: t.title,
        source: "local",
        status: t.composer.isRunning ? "running" : "idle",
        lastUpdatedAt: t.createdAt,
        windowId: "main",
      }));
  }

  /**
   * sendMessage → resolve tab by exact id; unknown → {status:"unknown-thread"}.
   * force + running turn → abort() first (the extension's own abort path,
   * ComposerDataService.abort — not reinvented). Submit goes through the
   * same composer.submit() entry point the chat UI uses. Running && !force →
   * {status:"queued"} via submit(sendMode:"queue") — the extension's REAL
   * message queue (MessageQueueService), drained when the current turn ends;
   * queuing is never claimed without this implementation behind it.
   */
  private sendMessage(body: Record<string, unknown>): Record<string, unknown> {
    const threadId = body.threadId;
    const text = body.text;
    const force = body.force === true;
    if (typeof threadId !== "string" || threadId.length === 0) {
      return { status: "error", message: "missing threadId" };
    }
    const tab = this.opts.chatTabs.listTabs().find((t) => t.id === threadId);
    if (!tab) {
      return { status: "unknown-thread", threadId };
    }
    const message = typeof text === "string" ? text : "";
    if (message.trim().length === 0) {
      return { status: "error", message: "message text is empty" };
    }
    const running = tab.composer.isRunning;
    if (force && running) {
      tab.composer.abort();
    }
    if (running && !force) {
      tab.composer.submit(message, { sendMode: "queue" });
      return { status: "queued", threadId, windowId: "main", threadTitle: tab.title };
    }
    tab.composer.submit(message);
    return { status: "submitted", threadId, windowId: "main", threadTitle: tab.title };
  }
}
