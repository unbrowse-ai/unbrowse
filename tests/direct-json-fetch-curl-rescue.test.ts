import { describe, expect, test } from "bun:test";
import { tryDirectJsonFetch } from "../src/orchestrator/index.js";

// bun's native fetch can stall on certain servers' TLS/HTTP config where curl
// succeeds (usgs.gov geojson). The probe-winner JSON fast path (tryDirectJsonFetch)
// must rescue via curl-impersonate so an obvious JSON API on a stalling server
// still returns data instead of falling through to the Exa shortcut.

const hangFetch = (() => Promise.reject(new Error("native fetch stalled"))) as typeof fetch;

describe("tryDirectJsonFetch — curl-impersonate rescue on native-fetch stall", () => {
  test("rescues a JSON API via curl when native fetch fails", async () => {
    const curl = async () => ({
      status: 200, bytes: 13, html: '{"rates":{"EUR":0.9}}',
      final_url: "https://x.test/api", proxy_used: false, impersonate: "chrome131",
    });
    const out = await tryDirectJsonFetch("https://x.test/api", { timeoutMs: 50, fetchImpl: hangFetch, curlFallback: curl });
    expect(out).not.toBeNull();
    expect((out!.data as { rates?: unknown }).rates).toEqual({ EUR: 0.9 });
  });

  test("returns null when curl also misses (graceful)", async () => {
    const curl = async () => null;
    const out = await tryDirectJsonFetch("https://x.test/api", { timeoutMs: 50, fetchImpl: hangFetch, curlFallback: curl });
    expect(out).toBeNull();
  });

  test("returns null when curl returns non-JSON", async () => {
    const curl = async () => ({
      status: 200, bytes: 5, html: "<html>not json</html>",
      final_url: "https://x.test/api", proxy_used: false, impersonate: "chrome131",
    });
    const out = await tryDirectJsonFetch("https://x.test/api", { timeoutMs: 50, fetchImpl: hangFetch, curlFallback: curl });
    expect(out).toBeNull();
  });

  test("uses native fetch when it succeeds (curl never called)", async () => {
    let curlCalled = false;
    const curl = async () => { curlCalled = true; return null; };
    const okFetch = (async () => new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
    const out = await tryDirectJsonFetch("https://x.test/api", { fetchImpl: okFetch, curlFallback: curl });
    expect((out!.data as { ok?: boolean }).ok).toBe(true);
    expect(curlCalled).toBe(false);
  });
});
