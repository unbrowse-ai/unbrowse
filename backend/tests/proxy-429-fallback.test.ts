/**
 * Route wiring for the opt-in paid residential-proxy fallback on HTTP 429.
 *
 * The surcharge/consent helpers (recordProxySurcharge/getProxyConsent) already
 * existed + were unit-tested, but routes/proxy.ts never called them. This drives
 * the extracted seam `maybeProxyFallback` (which the route now invokes) to prove
 * the end-to-end behaviour: a direct 429 + agent consent → retry via residential
 * + a `proxy_429_fallback` surcharge row; no consent / non-429 / anon → no toll.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { LocalKV, clearKVCacheForTests } from "../src/services/kv.js";
import { readProxySurchargeTodayUsd, putProxyConsent } from "../src/middleware/sponsor.js";
import { maybeProxyFallback } from "../src/routes/proxy.js";
import type { Env } from "../src/types.js";

const AGENT = "agent_proxy_route_001";
function env(): Env {
  return {
    API_KEY: "k",
    STATS_KV: new LocalKV("stats") as unknown as KVNamespace,
    ENVIRONMENT: "local-dev",
    SPONSOR_PROXY_SURCHARGE_USD: "0.001",
  } as Env;
}
const directResult = (status: number) => ({
  status, headers: {}, body: "", proxy_used: "direct" as const, duration_ms: 1,
});
const resi = () => Promise.resolve({
  status: 200, headers: {}, body: "ok", proxy_used: "residential" as const, duration_ms: 2,
});

beforeEach(() => clearKVCacheForTests());

describe("maybeProxyFallback — 429 paid residential fallback wiring", () => {
  it("429 + consent=yes → retries residential and charges the toll", async () => {
    const e = env();
    await putProxyConsent(e, AGENT, "yes");
    let called = false;
    const out = await maybeProxyFallback(e, AGENT, directResult(429), "direct", async () => { called = true; return resi(); }, "rate.limited.example");
    expect(called).toBe(true);
    expect(out.status).toBe(200);
    expect(out.proxy_used).toBe("residential");
    expect(out.fallback_used).toBe(true);
    // Free-execution posture: the fronted residential-proxy toll passes through at raw cost
    // (0.001), with no unbrowse markup (FAIR_COMPENSATION_BPS defaults to 0). A markup only
    // applies on a deployment that opts in via env, or on an owner-priced endpoint.
    expect(out.surcharge_usd).toBeCloseTo(0.001, 6);
    expect(await readProxySurchargeTodayUsd(e, AGENT)).toBeCloseTo(0.001, 6);
  });

  it("429 + no consent → returns the 429, no fallback, no toll", async () => {
    const e = env();
    let called = false;
    const out = await maybeProxyFallback(e, AGENT, directResult(429), "direct", async () => { called = true; return resi(); }, "h");
    expect(called).toBe(false);
    expect(out.status).toBe(429);
    expect(out.fallback_used).toBeUndefined();
    expect(await readProxySurchargeTodayUsd(e, AGENT)).toBe(0);
  });

  it("non-429 → no fallback even with consent", async () => {
    const e = env();
    await putProxyConsent(e, AGENT, "yes");
    let called = false;
    const out = await maybeProxyFallback(e, AGENT, directResult(200), "direct", async () => { called = true; return resi(); }, "h");
    expect(called).toBe(false);
    expect(out.status).toBe(200);
    expect(await readProxySurchargeTodayUsd(e, AGENT)).toBe(0);
  });

  it("anonymous (x402, no agentId) → no surcharge", async () => {
    const e = env();
    let called = false;
    const out = await maybeProxyFallback(e, undefined, directResult(429), "direct", async () => { called = true; return resi(); }, "h");
    expect(called).toBe(false);
    expect(out.status).toBe(429);
  });
});
