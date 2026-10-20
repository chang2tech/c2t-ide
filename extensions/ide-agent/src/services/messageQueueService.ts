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

  // DIG-CONTINUOUS (2026-10-19, binary-verified): Cursor's `addToQueue` is
  // UNBOUNDED — `isValidQueueItem` is just "non-empty query OR context
  // override", and all cap strings are 0 hits in the client and the daemon.
  // The 10-message / 20k-char caps we shipped were fabricated; this queue is
  // unbounded, like Cursor's.

  // DIG-CONTINUOUS (2026-10-19, binary-verified): there is NO overdue concept
  // in Cursor's queue UI (0 hits for `overdue`). The real 5-minute rule is
  // daemon-side `resyncOverduePendingSteerFallback` (admitted-but-undelivered
  // steer retag) — no badge, no toast, no client state. Our 5-minute overdue
  // badge and `isOverdue` were fabricated; removed.

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
    queueSeq += 1;
    const message: QueuedMessage = {
      id: `q-${queueSeq}`,
      text,
      mode,
      enqueuedAt: Date.now(),
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
    };
    this.queue.push(message);
    this.emitter.fire([...this.queue]);
    return message;
  }

  /**
   * Insert at the FRONT of the queue so the message runs ahead of older
   * queued messages. The queue is unbounded (Cursor's addToQueue has no
   * caps) — nothing is dropped.
   */
  enqueueFront(
    text: string,
    mode: string,
    attachments?: import("./mentionService").FileAttachment[],
  ): QueuedMessage {
    queueSeq += 1;
    const message: QueuedMessage = {
      id: `q-${queueSeq}`,
      text,
      mode,
      enqueuedAt: Date.now(),
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
    };
    this.queue.unshift(message);
    this.emitter.fire([...this.queue]);
    return message;
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

  /**
   * D4 (dig-debug-multitask-2026-10-19 §3.4) — dispatch hold while the agent
   * waits for the user to reproduce the bug (Cursor's `heldForDebugRepro` /
   * `debugReproWaitingForUser`). While the hold is set, queued items must NOT
   * be dispatched: the dispatch decision point (`tryDispatchNextQueueItem`)
   * consults the hold.
   */
  private dispatchHold = false;

  /** D4: engage or release the dispatch hold. */
  setDispatchHold(held: boolean): void {
    this.dispatchHold = held;
    this.emitter.fire([...this.queue]);
  }

  /** D4: whether queue dispatch is currently held (debug repro wait). */
  isDispatchHeld(): boolean {
    return this.dispatchHold;
  }

  /**
   * D4: the single dispatch decision point. While the hold is active, queued
   * items resolve `{shouldDispatch:false, heldForDebugRepro:true}` and stay
   * queued — they are NOT dispatched. Otherwise the head item is dequeued
   * for dispatch.
   */
  tryDispatchNextQueueItem(): QueueDispatchDecision {
    if (this.dispatchHold) {
      return { shouldDispatch: false, heldForDebugRepro: true };
    }
    const item = this.queue.shift();
    if (item) {
      this.emitter.fire([...this.queue]);
    }
    return { shouldDispatch: true, item };
  }

  /**
   * D4: Cursor's `retryDispatchHeldForDebugRepro()` — clear the hold and
   * dispatch every held item through `onDispatch`, in FIFO order. Called
   * without a dispatcher it just clears the hold (the next drain picks the
   * items up).
   */
  releaseDispatchHold(onDispatch?: (item: QueuedMessage) => void): QueuedMessage[] {
    this.dispatchHold = false;
    const dispatched: QueuedMessage[] = [];
    if (!onDispatch) {
      return dispatched;
    }
    for (;;) {
      const decision = this.tryDispatchNextQueueItem();
      if (!decision.shouldDispatch || !decision.item) {
        break;
      }
      dispatched.push(decision.item);
      onDispatch(decision.item);
    }
    return dispatched;
  }
}

/**
 * D4 dispatch decision (dig-debug-multitask §3.4): a held queue resolves
 * `{shouldDispatch:false, heldForDebugRepro:true}` instead of dispatching.
 */
export type QueueDispatchDecision =
  | { shouldDispatch: true; item: QueuedMessage | undefined }
  | { shouldDispatch: false; heldForDebugRepro: true };
