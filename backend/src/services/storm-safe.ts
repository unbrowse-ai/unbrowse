/**
 * Storm-safe wrapper for fan-out Promise.all blocks.
 *
 * Wraps an async function so it returns a discriminated result instead of
 * throwing. Routes that fan out to many sub-calls use this so one flaky
 * dependency cannot 500 the whole envelope.
 */
export type Block<T> = { ok: true; value: T } | { ok: false; error: string };

export async function stormSafe<T>(fn: () => Promise<T>): Promise<Block<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    const msg = (err as Error | undefined)?.message;
    return { ok: false, error: msg ?? String(err) };
  }
}
