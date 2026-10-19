import { BubbleData } from "../model";

/**
 * ComposerBubbleSetStore — fine-grained bubble store keyed by bubbleId.
 * Mirrors Cursor's ComposerBubbleSetStore (setBubbleData/getBubbleData/
 * updateBubble/appendBubbles). There is deliberately NO single immutable
 * transcript array: bubbles update individually by id, which is what makes
 * streaming updates cheap.
 *
 * MUTATION CONTRACT (issue 5, QA-FILE-02): getBubbleData() returns the LIVE
 * stored object, not a defensive copy — the textDelta hot path mutates
 * `bubble.text += delta` directly in ComposerDataService.applyEvent, so
 * copies would silently drop streamed updates. Callers may mutate the
 * returned object but MUST fire a ComposerEvent ("bubblesChanged" /
 * "bubblesReset") through ComposerDataService after every mutation so the
 * webview stays in sync. All store mutations in ComposerDataService obey
 * this; do not mutate the store from anywhere else.
 */
export class ComposerBubbleSetStore {
  private bubbles = new Map<string, BubbleData>();
  private order: string[] = [];
  private toolCallToBubble = new Map<string, string>();
  private serverToClient = new Map<string, string>();
  private clientSeq = 0;

  /** Optimistic client bubble id, assigned before any server round-trip. */
  newClientBubbleId(): string {
    this.clientSeq += 1;
    return `client-${Date.now().toString(36)}-${this.clientSeq}`;
  }

  setBubbleData(bubble: BubbleData): void {
    const existing = this.bubbles.get(bubble.bubbleId);
    if (existing) {
      // Issue 4 (QA-FILE-02): replacing a bubble must drop the OLD
      // tool-call index entries first, otherwise stale toolCallIds keep
      // resolving to this bubble after the new toolCalls replace them.
      for (const tc of existing.toolCalls) {
        if (this.toolCallToBubble.get(tc.toolCallId) === bubble.bubbleId) {
          this.toolCallToBubble.delete(tc.toolCallId);
        }
      }
    } else {
      this.order.push(bubble.bubbleId);
    }
    this.bubbles.set(bubble.bubbleId, bubble);
    for (const tc of bubble.toolCalls) {
      this.toolCallToBubble.set(tc.toolCallId, bubble.bubbleId);
    }
  }

  getBubbleData(bubbleId: string): BubbleData | undefined {
    return this.bubbles.get(bubbleId);
  }

  updateBubble(bubbleId: string, delta: Partial<BubbleData>): BubbleData | undefined {
    const bubble = this.bubbles.get(bubbleId);
    if (!bubble) {
      return undefined;
    }
    Object.assign(bubble, delta);
    return bubble;
  }

  appendBubbles(bubbles: BubbleData[]): void {
    for (const bubble of bubbles) {
      this.setBubbleData(bubble);
    }
  }

  /** toolCallId → bubbleId index (mirrors getBubbleIdByToolCallId). */
  getBubbleIdByToolCallId(toolCallId: string): string | undefined {
    return this.toolCallToBubble.get(toolCallId);
  }

  /** Reconcile the optimistic client id with the server-assigned id. */
  reconcileServerId(clientBubbleId: string, serverBubbleId: string): void {
    const bubble = this.bubbles.get(clientBubbleId);
    if (bubble) {
      bubble.serverBubbleId = serverBubbleId;
    }
    this.serverToClient.set(serverBubbleId, clientBubbleId);
  }

  getOrderedIds(): string[] {
    return [...this.order];
  }

  getAllInOrder(): BubbleData[] {
    return this.order
      .map((id) => this.bubbles.get(id))
      .filter((b): b is BubbleData => b !== undefined);
  }

  /**
   * Restore = checkout_to_message: drop every bubble after the given one.
   * Returns the removed bubble ids so checkpoints can be pruned too.
   */
  truncateAfter(bubbleId: string): string[] {
    const idx = this.order.indexOf(bubbleId);
    if (idx < 0) {
      return [];
    }
    const removed = this.order.splice(idx + 1);
    const removedSet = new Set(removed);
    for (const id of removed) {
      const bubble = this.bubbles.get(id);
      if (bubble) {
        for (const tc of bubble.toolCalls) {
          this.toolCallToBubble.delete(tc.toolCallId);
        }
      }
      this.bubbles.delete(id);
    }
    // Issue 3 (QA-FILE-02): server→client mappings for truncated bubbles
    // used to leak. Drop any mapping whose client id was removed.
    for (const [serverId, clientId] of this.serverToClient) {
      if (removedSet.has(clientId)) {
        this.serverToClient.delete(serverId);
      }
    }
    return removed;
  }

  /**
   * Drop every bubble and index entry (issue 6, QA-FILE-02: the store was
   * unbounded with no clear path).
   * Wired to the new-chat path: ComposerDataService.newChat() calls clear()
   * as step 1 (fixed by DEV-FIX-CX1B, 2026-10-19).
   */
  clear(): void {
    this.bubbles.clear();
    this.order = [];
    this.toolCallToBubble.clear();
    this.serverToClient.clear();
  }
}
