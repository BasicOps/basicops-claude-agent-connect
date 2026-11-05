/**
 * One turn per delivery.
 *
 * The listener used to start an agent turn for every inbound event, with no
 * memory of what it had just started. Two things break under that rule:
 *
 * 1. The same instruction can arrive twice. A Growth Engine dispatch is posted
 *    into the BasicOps task (forwarded here as a webhook) and, for an agent
 *    whose own account did not author it, also delivered straight to this
 *    listener. BasicOps has also been seen forwarding one identical webhook
 *    twice, one second apart (tasks 2211812 and 2211818, 2026-10-17 05:52:30).
 *    Either way two turns start on the same task, edit the same files and post
 *    competing replies.
 *
 * 2. Different events on the same conversation can arrive together. An
 *    assignment notice and the instruction that follows it are two separate
 *    messages, so even a single delivery route produces two concurrent turns.
 *
 * The gate fixes both: identical bodies on one conversation inside a short
 * window collapse to the first, and whatever survives runs one at a time per
 * conversation. Sequential turns are what the agent's own session memory
 * already assumes, so the second turn sees the first turn's work instead of
 * racing it.
 *
 * The state is deliberately in-memory. A restart may let one repeat through,
 * which costs a duplicate turn at most; persisting it would risk dropping a
 * real message after a crash, which costs the work itself.
 */
import { createHash } from "node:crypto";

/** How long an identical body on the same conversation is treated as a repeat. */
export const DEDUPE_WINDOW_MS = 120_000;

/**
 * Turns running at once across every conversation. Each turn is a full agent
 * session (several hundred MB); on 2026-11-05 thirteen task reassignments
 * started thirteen sessions together and pinned claw at 100% CPU with memory
 * exhausted until it was restarted. Further turns wait their turn instead.
 * Override with BASICOPS_MAX_CONCURRENT_TURNS.
 */
export const MAX_CONCURRENT_TURNS = Math.max(1, Number(process.env.BASICOPS_MAX_CONCURRENT_TURNS) || 2);

/** Turns allowed to wait behind a running one on the same conversation. */
export const MAX_QUEUED_PER_CONV = 4;

export type GateEvent = {
  event: string;
  convId: string;
  request: string;
  context: Record<string, any>;
};

/** Message text, stripped of markup and whitespace noise so the two delivery
 *  routes of one dispatch hash the same. The engine posts the identical HTML
 *  it wakes with, but editors and transports reflow it. */
export function bodyText(html: unknown): string {
  return String(html ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Identity of a delivery: the conversation plus what it says.
 *
 * Keyed on the body, not on messageId, because that is the only thing the two
 * routes of a single dispatch share — the localhost wake carries no messageId
 * and the webhook does. A state change has no body, so it keys on its own
 * event and entity id instead.
 */
export function deliveryKey(ev: GateEvent): string {
  const text = bodyText(ev.request);
  if (!text) {
    const id = ev.context?.messageId ?? ev.context?.replyId ?? "-";
    return `${ev.convId}|state|${ev.event}|${id}`;
  }
  return `${ev.convId}|body|${createHash("sha1").update(text).digest("hex")}`;
}

type Lane = { tail: Promise<void>; pending: number };

export class DeliveryGate {
  private readonly windowMs: number;
  private readonly maxQueued: number;
  private readonly now: () => number;
  private readonly seen = new Map<string, number>();
  private readonly lanes = new Map<string, Lane>();
  private readonly maxConcurrent: number;
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(opts: { windowMs?: number; maxQueued?: number; maxConcurrent?: number; now?: () => number } = {}) {
    this.maxConcurrent = Math.max(1, opts.maxConcurrent ?? MAX_CONCURRENT_TURNS);
    this.windowMs = opts.windowMs ?? DEDUPE_WINDOW_MS;
    this.maxQueued = opts.maxQueued ?? MAX_QUEUED_PER_CONV;
    this.now = opts.now ?? Date.now;
  }

  /** True the first time this delivery is seen, false for a repeat inside the
   *  window. Repeats refresh nothing: a message resent hours later is real. */
  firstDelivery(ev: GateEvent): boolean {
    const key = deliveryKey(ev);
    const at = this.now();
    for (const [k, t] of this.seen) if (at - t >= this.windowMs) this.seen.delete(k);
    const previous = this.seen.get(key);
    if (previous !== undefined && at - previous < this.windowMs) return false;
    this.seen.set(key, at);
    return true;
  }

  /** Turns running right now, across every conversation. */
  running(): number {
    return this.active;
  }

  private acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiting.push(() => { this.active += 1; resolve(); }));
  }

  private release(): void {
    this.active -= 1;
    this.waiting.shift()?.();
  }

  /** Turns currently running or waiting on a conversation. */
  depth(convId: string): number {
    return this.lanes.get(convId)?.pending ?? 0;
  }

  /**
   * Run `task` after any turn already running on this conversation.
   * `accepted` is false only when the conversation is already backed up, which
   * means something is stuck rather than busy.
   */
  run<T>(convId: string, task: () => Promise<T>): { accepted: boolean; queued: number; result?: Promise<T> } {
    const lane = this.lanes.get(convId) ?? { tail: Promise.resolve(), pending: 0 };
    if (lane.pending >= this.maxQueued) return { accepted: false, queued: lane.pending };
    lane.pending += 1;
    this.lanes.set(convId, lane);
    // Wait for this conversation's previous turn, then for a free slot.
    const result = lane.tail
      .then(() => this.acquire())
      .then(() => task().finally(() => this.release()));
    // The lane must never inherit a rejection, or one failed turn would skip
    // every turn queued behind it.
    lane.tail = result.then(
      () => undefined,
      () => undefined,
    ).then(() => {
      lane.pending -= 1;
      if (lane.pending <= 0 && this.lanes.get(convId) === lane) this.lanes.delete(convId);
    });
    return { accepted: true, queued: lane.pending, result };
  }
}
