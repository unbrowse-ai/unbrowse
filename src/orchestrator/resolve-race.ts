/**
 * Phase 8.1 — Per-call latency budget + parallel race primitive.
 *
 * `raceWithDeadline` fires N async lookups concurrently, returns the first one
 * whose result passes `isValid`, and aborts every other in-flight racer. If no
 * racer produces a valid result before `budgetMs`, returns `winner: null` with
 * a per-racer status trace (won / lost / deadline / threw).
 *
 * Used by the resolve pipeline to race recipe-replay || marketplace-lookup ||
 * HEAD-probe within a wall-clock budget instead of running them serially.
 *
 * Design:
 *  - Generic over result type T so each caller defines its own validity rule.
 *  - Aborts via the optional racer-supplied `abort()` callback. Racers that
 *    use fetch should construct their own AbortController and wire its signal.
 *  - Never throws — racer rejections are recorded as `status: "lost"` with the
 *    error reason and counted toward the deadline.
 *  - Deterministic: the first racer whose `isValid(result) === true` wins.
 *    Faster-but-invalid results are recorded as "lost" so callers can see them
 *    in `decision_trace`.
 */

export interface Racer<T> {
  /** Stable identifier (e.g. "recipe", "marketplace", "probe"). Surfaces in `tried`. */
  name: string;
  /** Kicks off the lookup. Must return a promise; rejections are caught. */
  start: () => Promise<T>;
  /** Returns true when this racer's result counts as a winning result. */
  isValid: (result: T) => boolean;
  /**
   * Best-effort abort. Called when another racer wins, when the deadline
   * fires, or when this racer itself has already settled. Must be idempotent.
   */
  abort?: () => void;
}

export interface RacerOutcome<T> {
  name: string;
  /**
   *  - "won": this racer's valid result is the returned winner
   *  - "lost": settled but invalid (or threw)
   *  - "deadline": still in flight when the deadline fired
   */
  status: "won" | "lost" | "deadline";
  ms: number;
  /** Set on "lost" when the racer threw or returned an invalid shape. */
  reason?: string;
  /** Set on "won" — the validated result. */
  result?: T;
}

export interface RaceResult<T> {
  winner: { name: string; result: T; ms: number } | null;
  tried: RacerOutcome<T>[];
  /** Total wall-clock spent in the race (≤ budgetMs + small overhead). */
  ms: number;
}

/**
 * Fire all racers concurrently. First valid result wins; losers are aborted.
 * Returns `winner: null` when the deadline elapses or every racer settles
 * without producing a valid result.
 */
export async function raceWithDeadline<T>(
  racers: Racer<T>[],
  budgetMs: number,
): Promise<RaceResult<T>> {
  const start = Date.now();
  if (racers.length === 0) {
    return { winner: null, tried: [], ms: 0 };
  }

  const outcomes: RacerOutcome<T>[] = racers.map((r) => ({
    name: r.name,
    status: "deadline",
    ms: 0,
  }));
  const settled = new Array<boolean>(racers.length).fill(false);
  let resolved = false;
  let winnerIndex = -1;

  return new Promise<RaceResult<T>>((resolve) => {
    const finalize = () => {
      if (resolved) return;
      resolved = true;
      // Abort everything still in flight
      for (let i = 0; i < racers.length; i++) {
        if (!settled[i]) {
          outcomes[i] = { ...outcomes[i]!, ms: Date.now() - start };
          try { racers[i]!.abort?.(); } catch { /* ignore abort failures */ }
        }
      }
      const ms = Date.now() - start;
      if (winnerIndex >= 0) {
        const w = outcomes[winnerIndex]!;
        resolve({
          winner: { name: w.name, result: w.result as T, ms: w.ms },
          tried: outcomes,
          ms,
        });
      } else {
        resolve({ winner: null, tried: outcomes, ms });
      }
    };

    const deadlineTimer = setTimeout(() => {
      finalize();
    }, Math.max(1, budgetMs));

    racers.forEach((racer, i) => {
      const racerStart = Date.now();
      Promise.resolve()
        .then(() => racer.start())
        .then((result) => {
          settled[i] = true;
          if (resolved) return;
          const ms = Date.now() - racerStart;
          let valid = false;
          try { valid = racer.isValid(result); } catch { valid = false; }
          if (valid) {
            outcomes[i] = { name: racer.name, status: "won", ms, result };
            winnerIndex = i;
            clearTimeout(deadlineTimer);
            finalize();
          } else {
            outcomes[i] = { name: racer.name, status: "lost", ms, reason: "invalid_result" };
            checkAllSettled();
          }
        })
        .catch((err) => {
          settled[i] = true;
          if (resolved) return;
          const ms = Date.now() - racerStart;
          outcomes[i] = {
            name: racer.name,
            status: "lost",
            ms,
            reason: (err && (err as Error).message) ? (err as Error).message : "threw",
          };
          checkAllSettled();
        });
    });

    function checkAllSettled() {
      if (resolved) return;
      if (settled.every(Boolean)) {
        clearTimeout(deadlineTimer);
        finalize();
      }
    }
  });
}
