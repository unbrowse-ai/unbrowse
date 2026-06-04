// withDeadline — bound a promise so a wedged dependency can never hang the
// caller forever. The classic failure this fixes: an un-timed broker/IPC/network
// await (e.g. kuri closeTab/harStop) blocking `unbrowse_close` indefinitely.
//
// Resolves with the promise's value if it settles within `ms`; otherwise resolves
// with `fallback` and lets the original promise finish (or fail) in the
// background — its rejection is swallowed so it can't become an unhandled
// rejection. Use a fallback that honestly signals "did not finish in time".

export interface DeadlineResult<T> {
  value: T;
  timedOut: boolean;
}

/** Returns the promise's value, or `fallback` if it doesn't settle within `ms`. */
export async function withDeadline<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return (await withDeadlineResult(p, ms, fallback)).value;
}

/** Like withDeadline but also reports whether the deadline fired. */
export function withDeadlineResult<T>(p: Promise<T>, ms: number, fallback: T): Promise<DeadlineResult<T>> {
  return new Promise<DeadlineResult<T>>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ value: fallback, timedOut: true });
    }, ms);
    p.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ value, timedOut: false });
      },
      () => {
        // Original rejected before the deadline: surface the fallback (honest
        // "no result") rather than throw, so the close path always returns.
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ value: fallback, timedOut: false });
      },
    );
    // Detach the background settle so a late rejection isn't unhandled.
    void p.catch(() => {});
  });
}
