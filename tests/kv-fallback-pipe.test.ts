/**
 * kv-fallback-pipe.test — the witness for "everything is a fallback kv-cached to a pipe."
 * Proves: highest-capable layer wins; lower layers are fallback, never reached when a
 * higher one acts; a content-addressed cache hit short-circuits the WHOLE descent
 * (no layer walked, the resolver not called again); content-addressing is stable per
 * intent; and null when no layer can act.
 */
import { describe, expect, it } from "bun:test";
import { resolveThroughPipe, cacheKey, memCache, PIPE_LAYERS, type PipeLayer } from "../src/values/kv-fallback-pipe.js";

describe("kv-fallback-pipe", () => {
  it("walks highest-capable-first; the first layer that acts wins, lower layers untouched", async () => {
    const calls: string[] = [];
    const layers: PipeLayer<string>[] = [
      { layer: "screen", resolve: (i) => (calls.push("screen"), null) },
      { layer: "browser", resolve: (i) => (calls.push("browser"), `browser:${i}`) },
      { layer: "cli", resolve: (i) => (calls.push("cli"), `cli:${i}`) },
    ];
    const r = await resolveThroughPipe("buy milk", layers);
    expect(r?.value).toBe("browser:buy milk");
    expect(r?.layer).toBe("browser");
    expect(r?.attempted).toEqual(["screen", "browser"]); // cli never reached
    expect(calls).toEqual(["screen", "browser"]); // cli resolver not even called
  });

  it("a cache hit short-circuits the entire descent — no layer is walked again", async () => {
    const cache = memCache<string>();
    let cliCalls = 0;
    const layers: PipeLayer<string>[] = [
      { layer: "screen", resolve: () => null },
      { layer: "cli", resolve: (i) => (cliCalls++, `cli:${i}`) },
    ];
    const first = await resolveThroughPipe("same intent", layers, cache);
    expect(first?.cached).toBe(false);
    expect(first?.layer).toBe("cli");
    expect(cliCalls).toBe(1);

    const second = await resolveThroughPipe("same intent", layers, cache);
    expect(second?.cached).toBe(true);
    expect(second?.layer).toBe("cache");
    expect(second?.attempted).toEqual([]); // descent skipped entirely
    expect(second?.value).toBe("cli:same intent");
    expect(cliCalls).toBe(1); // the lower layer was NOT re-walked
  });

  it("content-addressing is stable per intent and distinct across intents", () => {
    expect(cacheKey("alpha")).toBe(cacheKey("alpha"));
    expect(cacheKey("alpha")).not.toBe(cacheKey("beta"));
  });

  it("falls all the way through and returns null when no layer can act", async () => {
    const layers: PipeLayer<string>[] = PIPE_LAYERS.map((layer) => ({ layer, resolve: () => null }));
    const r = await resolveThroughPipe("impossible", layers);
    expect(r).toBeNull();
  });

  it("the default pipe order is the descent ladder (screen→…→packet)", () => {
    expect(PIPE_LAYERS).toEqual(["screen", "browser", "cli", "os", "kernel", "packet"]);
  });

  it("awaits async layer resolvers (a layer may do real work before answering)", async () => {
    const layers: PipeLayer<number>[] = [
      { layer: "screen", resolve: async () => null },
      { layer: "browser", resolve: async (i) => (await Promise.resolve(), i.length) },
    ];
    const r = await resolveThroughPipe("abcd", layers);
    expect(r?.value).toBe(4);
    expect(r?.layer).toBe("browser");
  });
});
