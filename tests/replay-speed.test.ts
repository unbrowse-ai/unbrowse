/**
 * replay-speed.test — the witness for "we win on speed every time."
 *
 * The whitepaper's thesis (§2): a cached signed plan beats a CLI call beats a
 * browser action beats moving a mouse across pixels. The economic + latency win is
 * "capture once, replay everywhere" — the warm path is a content-addressed cache
 * hit that SKIPS the cold work entirely, while an always-cold agent (Browser-Use
 * class) and an always-paid API (Exa class) pay the full cost on every call.
 *
 * This measures it in REAL wall-clock, hermetically (no network, no browser): the
 * cold path does substantial work each time; the warm path is a cache hit that does
 * none. Proves both the MECHANISM (the warm resolution never reaches the slow layer)
 * and the MARGIN (warm is categorically faster — here ≥20×, with a large cold floor
 * so the ratio is stable even under load).
 */
import { describe, expect, it } from "bun:test";
import { resolveThroughPipe, memCache, type PipeLayer } from "../src/values/kv-fallback-pipe.js";

const COLD_FLOOR_MS = 120; // the cold path's hard work floor (a browser render / paid API round-trip is far worse)
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const now = () => Number(process.hrtime.bigint() / 1000n) / 1000; // ms, monotonic

/** A layer that pays a real, substantial cost every time it is reached — the
 *  always-cold agent / paid API. */
function coldLayer(calls: { n: number }): PipeLayer<string> {
  return {
    layer: "browser",
    resolve: async (intent) => {
      calls.n++;
      await sleep(COLD_FLOOR_MS);
      return `rendered:${intent}`;
    },
  };
}

describe("replay-speed — the warm cached path categorically beats the cold path", () => {
  it("the warm replay path SKIPS the slow layer (the speed mechanism)", async () => {
    const cache = memCache<string>();
    const calls = { n: 0 };
    const layers = [coldLayer(calls)];

    const cold = await resolveThroughPipe("buy milk", layers, cache); // primes the cache (cold)
    expect(cold?.cached).toBe(false);
    expect(calls.n).toBe(1);

    const warm = await resolveThroughPipe("buy milk", layers, cache); // cache hit
    expect(warm?.cached).toBe(true);
    expect(warm?.value).toBe("rendered:buy milk");
    expect(calls.n).toBe(1); // the slow layer was NOT reached again — replay, not re-render
  });

  it("the warm path is ≥20× faster than the cold path in real wall-clock", async () => {
    const cache = memCache<string>();
    const layers = [coldLayer({ n: 0 })];

    const t0 = now();
    await resolveThroughPipe("read calendar", layers, cache); // COLD
    const coldMs = now() - t0;

    // measure several warm hits; take the median so a single GC pause cannot skew it
    const warmSamples: number[] = [];
    for (let i = 0; i < 9; i++) {
      const w0 = now();
      const w = await resolveThroughPipe("read calendar", layers, cache); // WARM (cache hit)
      warmSamples.push(now() - w0);
      expect(w?.cached).toBe(true);
    }
    warmSamples.sort((a, b) => a - b);
    const warmMedianMs = warmSamples[Math.floor(warmSamples.length / 2)];

    // the cold path has a hard floor; the warm path does ~no work. The ratio is
    // huge and stable. Assert ≥20× to leave generous headroom under CI load.
    expect(coldMs).toBeGreaterThanOrEqual(COLD_FLOOR_MS * 0.8);
    expect(warmMedianMs * 20).toBeLessThan(coldMs);
  });
});
