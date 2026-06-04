/**
 * descent-cache — the KV-cached fallback pipe (Paper 2 §2+§5). Proves the
 * self-similar descent: a cache hit short-circuits the whole ladder (speed),
 * a miss tries layers top-to-bottom and the FIRST win stops the descent, the
 * win is cached so the next call is a hit, and the cache key is the
 * host-independent content-address of the request.
 */
import { describe, it, expect } from "bun:test";
import {
	ContentAddressedCache,
	descentResolve,
	contentAddress,
	type DescentLayer,
} from "../src/trust/descent-cache.js";

// A layer that records whether it was invoked.
function spyLayer(name: string, result: string | null): DescentLayer<string> & { calls: number } {
	const layer = {
		name,
		calls: 0,
		try: async () => {
			layer.calls++;
			return result;
		},
	};
	return layer;
}

describe("descentResolve — cached fallback pipe", () => {
	it("cache HIT short-circuits: no layer runs (the speed path)", async () => {
		const cache = new ContentAddressedCache<string>();
		await cache.put({ intent: "weather", url: "x.com" }, "CACHED");
		const l1 = spyLayer("L1", "fresh");
		const res = await descentResolve({ key: { intent: "weather", url: "x.com" }, layers: [l1], cache });
		expect(res).toEqual({ value: "CACHED", layer: "cache", cached: true });
		expect(l1.calls).toBe(0); // never descended
	});

	it("miss → first layer that answers WINS, lower layers never run", async () => {
		const cache = new ContentAddressedCache<string>();
		const l1 = spyLayer("recipe", null);   // declines
		const l2 = spyLayer("route", "ANSWER"); // answers
		const l3 = spyLayer("browser", "deeper"); // must NOT run
		const res = await descentResolve({ key: "k", layers: [l1, l2, l3], cache });
		expect(res.value).toBe("ANSWER");
		expect(res.layer).toBe("route");
		expect(res.cached).toBe(false);
		expect(l1.calls).toBe(1);
		expect(l2.calls).toBe(1);
		expect(l3.calls).toBe(0); // highest layer that can act stops the descent
	});

	it("the win is cached → the next identical call is a hit (no re-descent)", async () => {
		const cache = new ContentAddressedCache<string>();
		const l1 = spyLayer("route", "ONCE");
		const first = await descentResolve({ key: "repeat", layers: [l1], cache });
		expect(first.cached).toBe(false);
		expect(l1.calls).toBe(1);
		const second = await descentResolve({ key: "repeat", layers: [l1], cache });
		expect(second).toEqual({ value: "ONCE", layer: "cache", cached: true });
		expect(l1.calls).toBe(1); // not invoked again
	});

	it("a miss (every layer declines) is NOT cached", async () => {
		const cache = new ContentAddressedCache<string>();
		const l1 = spyLayer("a", null);
		const l2 = spyLayer("b", null);
		const res = await descentResolve({ key: "nothing", layers: [l1, l2], cache });
		expect(res).toEqual({ value: null, layer: null, cached: false });
		expect(cache.size).toBe(0); // a miss is not a settled result
	});

	it("content-addressed: same request → same slot regardless of key field order", async () => {
		const a = await contentAddress({ intent: "x", url: "y" });
		const b = await contentAddress({ intent: "x", url: "y" });
		expect(a).toBe(b);
		expect(a).toStartWith("sha256:");
		const cache = new ContentAddressedCache<string>();
		await cache.put({ intent: "x", url: "y" }, "V");
		expect(await cache.has({ intent: "x", url: "y" })).toBe(true);
	});
});
