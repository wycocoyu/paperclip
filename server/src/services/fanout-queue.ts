/**
 * The post-commit fan-out state machine, with the asset type factored out.
 *
 * MUL-559 step 3 grew this inside skill-fanout.ts; step 4 needs the same
 * behaviour for Team Rules and Team Wiki, and a second copy of a retry
 * scheduler is a second set of bugs. What is shared is the scheduling —
 * newest-wins coalescing, bounded exponential backoff, a terminal failure
 * list — while snapshot loading, sinks and gating stay with each asset.
 *
 * `Ctx` is whatever delivery needs and identity does not: the db handle rides
 * along with the publish that queued the work rather than being captured at
 * module load, so tests can hand in a stub per call.
 */
const DEFAULT_MAX_ATTEMPTS = 6;
const RETRY_BASE_MS = 1_000;
const RETRY_CEILING_MS = 30_000;

export interface FanoutQueueFailure<E> {
  event: E;
  error: string;
  attempts: number;
  at: string;
}

export interface FanoutQueueOptions<Ctx, E> {
  /** Task identity. A later publish for the same key supersedes the earlier one. */
  keyOf(event: E): string;
  /** Throws to request a retry. */
  deliver(ctx: Ctx, event: E): Promise<void>;
  /**
   * True for errors that mean a peer is mid-write on the same target. Those
   * wait out the backoff without spending the retry budget, so a long-running
   * peer cannot exhaust it.
   */
  isDeferrable?(err: unknown): boolean;
  onDeferred?(event: E, key: string): void;
  onRetry(event: E, key: string, err: unknown, attempt: number): void;
  onGaveUp(event: E, key: string, err: unknown, attempts: number): void;
  maxAttempts?: number;
}

export interface FanoutQueue<Ctx, E> {
  /**
   * Never throws and never awaits: callers are on a request path that has
   * already committed, so a fan-out problem must not turn into a failed write.
   */
  publish(ctx: Ctx, event: E): void;
  failures(): FanoutQueueFailure<E>[];
  /** Test seam: the queue owns process-wide state, tests own its lifetime. */
  reset(): void;
}

export function createFanoutQueue<Ctx, E>(options: FanoutQueueOptions<Ctx, E>): FanoutQueue<Ctx, E> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const pending = new Map<string, { ctx: Ctx; event: E }>();
  const attempts = new Map<string, number>();
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const failures = new Map<string, FanoutQueueFailure<E>>();
  let draining = false;

  function recordFailure(key: string, ctx: Ctx, event: E, err: unknown): void {
    const deferrable = options.isDeferrable?.(err) ?? false;
    const attempt = deferrable ? (attempts.get(key) ?? 0) : (attempts.get(key) ?? 0) + 1;
    if (!deferrable) attempts.set(key, attempt);
    if (!deferrable && attempt >= maxAttempts) {
      attempts.delete(key);
      failures.set(key, {
        event,
        error: err instanceof Error ? err.message : String(err),
        at: new Date().toISOString(),
        attempts: attempt,
      });
      options.onGaveUp(event, key, err, attempt);
      return;
    }
    if (deferrable) options.onDeferred?.(event, key);
    else options.onRetry(event, key, err, attempt);
    const delayMs = Math.min(RETRY_BASE_MS * 2 ** (Math.max(attempt, 1) - 1), RETRY_CEILING_MS);
    const timer = setTimeout(() => {
      retryTimers.delete(key);
      // A publish that arrived during the backoff already supersedes this event.
      if (!pending.has(key)) pending.set(key, { ctx, event });
      void drain();
    }, delayMs);
    timer.unref?.();
    retryTimers.set(key, timer);
  }

  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      for (;;) {
        const next = pending.entries().next();
        if (next.done) return;
        const [key, task] = next.value;
        pending.delete(key);
        try {
          await options.deliver(task.ctx, task.event);
          attempts.delete(key);
          failures.delete(key);
        } catch (err) {
          recordFailure(key, task.ctx, task.event, err);
        }
      }
    } finally {
      draining = false;
    }
  }

  return {
    publish(ctx, event) {
      const key = options.keyOf(event);
      const timer = retryTimers.get(key);
      if (timer) {
        clearTimeout(timer);
        retryTimers.delete(key);
      }
      // Newest wins: an asset published three times in a row is delivered once.
      pending.set(key, { ctx, event });
      attempts.delete(key);
      void drain();
    },
    failures: () => [...failures.values()],
    reset() {
      for (const timer of retryTimers.values()) clearTimeout(timer);
      retryTimers.clear();
      pending.clear();
      attempts.clear();
      failures.clear();
      draining = false;
    },
  };
}
