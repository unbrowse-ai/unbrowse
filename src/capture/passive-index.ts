/**
 * passive-index — run the capture → reverse-engineer → index → publish pipeline
 * in the background, in parallel with browsing.
 *
 * Default ON (opt-out via `unbrowse_settings passive_index=false`). When on, a
 * `sync` checkpoint hands the heavy reverse-engineer/index/publish work to
 * `deferCapturePipeline` and returns immediately, so browsing stays fast while
 * the index grows passively. The work is tracked so a clean shutdown can drain
 * it (production also persists the index job to disk, so nothing is lost even on
 * a hard exit).
 */
import { getContributionConfig } from "../config/contribution.js";

/** Opt-out switch. True by default. */
export function isPassiveIndexEnabled(): boolean {
  try {
    return getContributionConfig().contribution.passive_index !== false;
  } catch {
    return true; // default-on even if config is unreadable
  }
}

const pending = new Set<Promise<void>>();

/**
 * Run `work` in the background without blocking the caller. Returns synchronously.
 * Errors are swallowed (logged) — a failed background index must never crash a
 * browse turn. The returned promise is tracked for `drainDeferredCaptureWork`.
 */
export function deferCapturePipeline(label: string, work: () => Promise<void>): void {
  const p = (async () => {
    try {
      await work();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[passive-index] ${label} failed: ${msg}`);
    }
  })();
  pending.add(p);
  void p.finally(() => pending.delete(p));
}

/** Number of background pipelines currently in flight (for diagnostics/tests). */
export function pendingCaptureWorkCount(): number {
  return pending.size;
}

/**
 * Await all in-flight background pipelines. Call on graceful shutdown so a
 * detached index/publish isn't lost to process exit. Bounded by `timeoutMs`
 * (default 30s) so a wedged pipeline can't hang shutdown forever.
 */
export async function drainDeferredCaptureWork(timeoutMs = 30_000): Promise<void> {
  if (pending.size === 0) return;
  const all = Promise.allSettled([...pending]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  await Promise.race([all.then(() => undefined), guard]);
  if (timer) clearTimeout(timer);
}
