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

  test("non-ok status (e.g. CF 525) still rescues via curl when curl returns JSON", async () => {
    let curlCalled = false;
    const curl = async () => {
      curlCalled = true;
      return {
        status: 200,
        bytes: 22,
        html: '{"flight_number":187}',
        final_url: "https://api.spacexdata.com/v5/launches/latest",
        proxy_used: false,
        impersonate: "chrome131",
      };
    };
    const five25 = (async () =>
      new Response("error code: 525", {
        status: 525,
        headers: { "content-type": "text/plain" },
      })) as typeof fetch;
    const out = await tryDirectJsonFetch("https://api.spacexdata.com/v5/launches/latest", {
      fetchImpl: five25,
      curlFallback: curl,
    });
    expect(curlCalled).toBe(true);
    expect(out).not.toBeNull();
    expect((out!.data as { flight_number?: number }).flight_number).toBe(187);
  });

  test("non-ok + curl miss → null (graceful)", async () => {
    const five25 = (async () =>
      new Response("error", { status: 525 })) as typeof fetch;
    const out = await tryDirectJsonFetch("https://x.test/api", {
      fetchImpl: five25,
      curlFallback: async () => null,
    });
    expect(out).toBeNull();
  });
});
