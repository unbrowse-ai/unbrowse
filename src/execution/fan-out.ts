/**
 * Bounded-concurrency fan-out — "fan agents out to do the rest."
 *
 * The third tier of the client-first execution strategy. Client-first execution
 * (local libcurl-impersonate) and the server-proxy fallback (server-proxy-fallback.ts)
 * handle ONE target. When there is a batch of targets/intents/candidates left to
 * do, fan them out across parallel workers — but BOUNDED, so a 50-item batch
 * never opens 50 simultaneous egress connections (the old unbounded `Promise.all`
 * stampede), and ISOLATED, so one worker throwing doesn't sink the batch.
 *
 * Substrate principle (mirrors proxy-fetch.ts / server-proxy-fallback.ts): no
 * per-domain registry, no heuristics. A structural primitive — the caller
 * supplies the worker (which is itself client-first); this knows only HOW to
 * spread N of them across a fixed pool and collect ordered, settled results.
 */

export interface FanOutResult<R> {
  /** True when the worker resolved; false when it threw. */
  ok: boolean;
  /** The worker's return value when ok. */
  value?: R;
  /** The error message when not ok. */
  error?: string;
}

export interface FanOutOptions {
  /** Max workers in flight at once. Bounded — never an unbounded stampede. */
  concurrency?: number;
}

/** Default pool size: enough to parallelise without hammering an origin. */
export const DEFAULT_FANOUT_CONCURRENCY = 6;

/**
 * Run `worker` over every item with at most `concurrency` in flight at once.
 * Results come back in INPUT ORDER (index-aligned), each a settled entry — a
 * thrown worker yields `{ ok: false, error }` rather than rejecting the batch.
 *
 * @param items       the work-list (the "rest" to do)
 * @param worker      client-first unit of work; receives (item, index)
 * @param options.concurrency  pool size (default DEFAULT_FANOUT_CONCURRENCY, min 1)
 */
export async function fanOut<T, R>(
  items: readonly T[],
  worker: (item: T, index: number) => Promise<R>,
  options: FanOutOptions = {},
): Promise<Array<FanOutResult<R>>> {
  const total = items.length;
  const results: Array<FanOutResult<R>> = new Array(total);
  if (total === 0) return results;

  const cap = Math.max(1, Math.min(options.concurrency ?? DEFAULT_FANOUT_CONCURRENCY, total));

  let nextIndex = 0;
  async function runWorkerSlot(): Promise<void> {
    for (;;) {
      const i = nextIndex++;
      if (i >= total) return;
      try {
        const value = await worker(items[i], i);
        results[i] = { ok: true, value };
      } catch (err) {
        results[i] = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  }

  const pool = Array.from({ length: cap }, () => runWorkerSlot());
  await Promise.all(pool);
  return results;
}
