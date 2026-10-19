import * as vscode from "vscode";

/**
 * MessageQueueService — messages sent while a turn is running wait here and
 * are delivered at the next turn boundary (Cursor's queuedMessages, including
 * multitask fan-out semantics when the mode supports it).
 */
export interface QueuedMessage {
  id: string;
  text: string;
  mode: string;
  enqueuedAt: number;
  /** File attachments (browser-tab screenshots) — delivered with the turn. */
  attachments?: import("./mentionService").FileAttachment[];
}

let queueSeq = 0;

export class MessageQueueService {
  private queue: QueuedMessage[] = [];
  private readonly emitter = new vscode.EventEmitter<QueuedMessage[]>();
  readonly onDidChangeQueue = this.emitter.event;

  /**
   * Curation restored (user directive 2026-10-19 refined): caps prevent a
   * spam-queued backlog from merging into one giant unfocused prompt on
   * drain. Oldest messages drop first (FIFO) with a visible warning — in
   * practice users never hit 10 queued follow-ups.
   */
  private static readonly MAX_MESSAGES = 10;
  private static readonly MAX_CHARS = 20_000;

  /**
   * Overdue-steer rule (Cursor parity — deepdig-runtime-agent-loop §3:
   * `resyncOverduePendingSteerFallback`). A queued message admitted while a
   * turn runs but still undelivered after 5 minutes is "overdue": it is
   * retagged to the next turn as a queued follow-up instead of being merged
   * into the current turn's context. `isOverdue` lets the UI badge it.
   */
  static readonly OVERDUE_MS = 300_000;

  isOverdue(message: QueuedMessage, now: number = Date.now()): boolean {
    return now - message.enqueuedAt >= MessageQueueService.OVERDUE_MS;
  }

  /** Remove one queued message by id (queue list UI). Returns true if removed. */
  remove(id: string): boolean {
    const idx = this.queue.findIndex((m) => m.id === id);
    if (idx < 0) {
      return false;
    }
    this.queue.splice(idx, 1);
    this.emitter.fire([...this.queue]);
    return true;
  }

  /**
   * Move a queued message one step up (-1) or down (+1) in the queue
   * (Cursor's drag-to-reorder, exposed as up/down buttons). Returns true if
   * the order changed.
   */
  move(id: string, direction: -1 | 1): boolean {
    const idx = this.queue.findIndex((m) => m.id === id);
    const target = idx + direction;
    if (idx < 0 || target < 0 || target >= this.queue.length) {
      return false;
    }
    const [item] = this.queue.splice(idx, 1);
    this.queue.splice(target, 0, item!);
    this.emitter.fire([...this.queue]);
    return true;
  }

  /** Snapshot of the current queue (for the "Send now" promote path). */
  getItems(): QueuedMessage[] {
    return [...this.queue];
  }

  enqueue(
    text: string,
    mode: string,
    attachments?: import("./mentionService").FileAttachment[],
  ): QueuedMessage {
    // REVERIFY-P3-9 (H4): a single message larger than the entire char
    // budget can never fit — reject it upfront with an accurate message
    // instead of enqueueing it, dropping it as "oldest", and returning a
    // dead id.
    if (text.length > MessageQueueService.MAX_CHARS) {
      void vscode.window.showWarningMessage(
        `IDE Agent: message too large (${text.length.toLocaleString()} characters) — ` +
          `the queue holds at most ${MessageQueueService.MAX_CHARS.toLocaleString()} characters total. ` +
          `Please shorten the message.`,
      );
      throw new Error(`Queued message exceeds ${MessageQueueService.MAX_CHARS} characters`);
    }
    queueSeq += 1;
    const message: QueuedMessage = {
      id: `q-${queueSeq}`,
      text,
      mode,
      enqueuedAt: Date.now(),
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
    };
    this.queue.push(message);
    this.enforceCaps("front");
    this.emitter.fire([...this.queue]);
    return message;
  }

  /**
   * Insert at the FRONT of the queue (Cursor "stop-and-send": the message
   * runs as soon as the aborted turn winds down, ahead of older queued
   * messages). Caps still apply — oldest (back) messages drop first.
   */
  enqueueFront(
    text: string,
    mode: string,
    attachments?: import("./mentionService").FileAttachment[],
  ): QueuedMessage {
    // REVERIFY-P3-9 (H4): same single-oversize guard as enqueue().
    if (text.length > MessageQueueService.MAX_CHARS) {
      void vscode.window.showWarningMessage(
        `IDE Agent: message too large (${text.length.toLocaleString()} characters) — ` +
          `the queue holds at most ${MessageQueueService.MAX_CHARS.toLocaleString()} characters total. ` +
          `Please shorten the message.`,
      );
      throw new Error(`Queued message exceeds ${MessageQueueService.MAX_CHARS} characters`);
    }
    queueSeq += 1;
    const message: QueuedMessage = {
      id: `q-${queueSeq}`,
      text,
      mode,
      enqueuedAt: Date.now(),
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
    };
    this.queue.unshift(message);
    this.enforceCaps("back");
    this.emitter.fire([...this.queue]);
    return message;
  }

  /**
   * Drop messages while over cap. `front` drops the oldest (FIFO order —
   * used after a back-push); `back` drops from the tail (used after a
   * front-insert, where the head is the newest priority message).
   */
  private enforceCaps(from: "front" | "back"): void {
    let dropped = 0;
    while (
      this.queue.length > MessageQueueService.MAX_MESSAGES ||
      this.totalChars() > MessageQueueService.MAX_CHARS
    ) {
      if (from === "front") {
        this.queue.shift();
      } else {
        this.queue.pop();
      }
      dropped += 1;
    }
    if (dropped > 0) {
      void vscode.window.showWarningMessage(
        `IDE Agent: message queue is full — dropped ${dropped} oldest queued message(s). ` +
          `The queue holds at most ${MessageQueueService.MAX_MESSAGES} messages / ` +
          `${MessageQueueService.MAX_CHARS} characters.`,
      );
    }
  }

  private totalChars(): number {
    let total = 0;
    for (const m of this.queue) {
      total += m.text.length;
    }
    return total;
  }

  drain(): QueuedMessage[] {
    const items = this.queue;
    this.queue = [];
    if (items.length > 0) {
      this.emitter.fire([]);
    }
    return items;
  }

  get length(): number {
    return this.queue.length;
  }
}
