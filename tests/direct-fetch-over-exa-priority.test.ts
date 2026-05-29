// W35 falsifier — direct-fetch beats exa for obvious JSON APIs even on a
// budget race. Regression of contracts c3f05a50 / 3b3e67d1 / a4bfd532 /
// 6bb821ff ("JSON API URL falls through to exa instead of direct call").
//
// Root cause: when the resolve budget-race's `probe` racer wins (a HEAD /
// GET-1byte that confirmed `content-type: application/json`), the
// orchestrator jumped straight to Exa web-search instead of fetching the
// confirmed-JSON URL's body. The faster Exa shortcut beat the slower direct
// fetch on speed even though the URL IS a direct API. The fix prioritizes a
// direct JSON fetch BEFORE Exa whenever the probe's own content-type signal
// (generic — no per-domain heuristic) says the URL is a JSON API.
//
// 1 Thess 5:21 — "Prove all things; hold fast that which is good."
//
// Pure unit test: no browser / kuri / network. `tryDirectJsonFetch` takes a
// `fetchImpl` test seam so the budget-race timing is simulated with a slow
// direct-fetch and a fast exa, asserting direct-fetch still wins.

import { describe, expect, test } from "bun:test";
import {
  probeLooksLikeDirectJsonApi,
  tryDirectJsonFetch,
} from "../src/orchestrator/index.ts";

describe("probeLooksLikeDirectJsonApi — generic content-type signal", () => {
  test("application/json content-type on a 200 → true", () => {
    expect(
      probeLooksLikeDirectJsonApi({ status: 200, content_type: "application/json; charset=utf-8" }),
    ).toBe(true);
  });
  test("+json (e.g. application/vnd.api+json) → true", () => {
    expect(probeLooksLikeDirectJsonApi({ status: 200, content_type: "application/vnd.api+json" })).toBe(true);
  });
  test("text/json → true", () => {
    expect(probeLooksLikeDirectJsonApi({ status: 200, content_type: "text/json" })).toBe(true);
  });
  test("text/html → false (let exa / browser handle it)", () => {
    expect(probeLooksLikeDirectJsonApi({ status: 200, content_type: "text/html; charset=utf-8" })).toBe(false);
  });
  test("missing content-type → false", () => {
    expect(probeLooksLikeDirectJsonApi({ status: 200 })).toBe(false);
  });
  test("non-2xx/3xx status → false even with JSON ct", () => {
    expect(probeLooksLikeDirectJsonApi({ status: 500, content_type: "application/json" })).toBe(false);
    expect(probeLooksLikeDirectJsonApi({ status: 404, content_type: "application/json" })).toBe(false);
  });
});

describe("tryDirectJsonFetch — body retrieval", () => {
  const makeRes = (opts: { ok: boolean; ct: string; body: string }) =>
    ({
      ok: opts.ok,
      headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? opts.ct : null) },
      json: async () => JSON.parse(opts.body),
      text: async () => opts.body,
    }) as unknown as Response;

  test("application/json response → parsed data", async () => {
    const fetchImpl = (async () =>
      makeRes({ ok: true, ct: "application/json", body: '{"bitcoin":{"usd":72978}}' })) as unknown as typeof fetch;
    const out = await tryDirectJsonFetch("https://api.coingecko.com/api/v3/simple/price", { fetchImpl });
    expect(out).not.toBeNull();
    expect((out!.data as any).bitcoin.usd).toBe(72978);
  });

  test("body-sniff: JSON body with text/plain content-type → parsed", async () => {
    const fetchImpl = (async () =>
      makeRes({ ok: true, ct: "text/plain", body: '[{"id":1}]' })) as unknown as typeof fetch;
    const out = await tryDirectJsonFetch("https://example.com/feed", { fetchImpl });
    expect(out).not.toBeNull();
    expect(Array.isArray(out!.data)).toBe(true);
  });

  test("HTML page body → null (not a JSON API)", async () => {
    const fetchImpl = (async () =>
      makeRes({ ok: true, ct: "text/html", body: "<html><body>hi</body></html>" })) as unknown as typeof fetch;
    const out = await tryDirectJsonFetch("https://example.com/page", { fetchImpl });
    expect(out).toBeNull();
  });

  test("non-ok response → null", async () => {
    const fetchImpl = (async () =>
      makeRes({ ok: false, ct: "application/json", body: '{"err":1}' })) as unknown as typeof fetch;
    const out = await tryDirectJsonFetch("https://example.com/api", { fetchImpl });
    expect(out).toBeNull();
  });

  test("fetch throws → null (best-effort, never throws)", async () => {
    const fetchImpl = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const out = await tryDirectJsonFetch("https://example.com/api", { fetchImpl });
    expect(out).toBeNull();
  });
});

describe("budget-race simulation — slow direct-fetch beats fast exa for API-shaped target", () => {
  // Simulate the exact regression: a fast exa (8ms here) vs a slow
  // direct-fetch (40ms here). The fix is that direct-fetch is NOT a
  // concurrent racer for obvious JSON APIs — it is consulted FIRST (after
  // the probe confirms JSON content-type), so exa never gets a chance to
  // win on speed. We model the orchestrator's decision: given a JSON probe
  // winner, attempt direct fetch; only on null fall back to exa.
  async function decideSource(
    probe: { status: number; content_type?: string },
    directFetchImpl: typeof fetch,
  ): Promise<"direct-fetch" | "exa"> {
    if (probeLooksLikeDirectJsonApi(probe)) {
      const direct = await tryDirectJsonFetch("https://api.spacexdata.com/v5/launches/latest", {
        fetchImpl: directFetchImpl,
      });
      if (direct) return "direct-fetch";
    }
    return "exa";
  }

  test("JSON-API probe winner → direct-fetch even though exa would be faster", async () => {
    const slowButCorrectFetch = (async () => {
      await new Promise((r) => setTimeout(r, 40)); // slower than exa's 8ms
      return {
        ok: true,
        headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? "application/json" : null) },
        json: async () => ({ name: "Starlink", flight_number: 187 }),
        text: async () => "",
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const source = await decideSource({ status: 200, content_type: "application/json" }, slowButCorrectFetch);
    expect(source).toBe("direct-fetch");
  });

  test("non-API (HTML) probe winner → exa (direct-fetch not forced)", async () => {
    const htmlFetch = (async () =>
      ({
        ok: true,
        headers: { get: () => "text/html" },
        json: async () => ({}),
        text: async () => "<html></html>",
      }) as unknown as Response) as unknown as typeof fetch;

    const source = await decideSource({ status: 200, content_type: "text/html" }, htmlFetch);
    expect(source).toBe("exa");
  });

  test("JSON probe but direct fetch fails → falls back to exa (exa preserved)", async () => {
    const failingFetch = (async () => {
      throw new Error("timeout");
    }) as unknown as typeof fetch;
    const source = await decideSource({ status: 200, content_type: "application/json" }, failingFetch);
    expect(source).toBe("exa");
  });
});

describe("orchestrator source — anti-regression (the fast path must exist)", () => {
  test("probe-winner branch calls direct-fetch before exa", () => {
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const src = readFileSync(new URL("../src/orchestrator/index.ts", import.meta.url), "utf8");
    // The probe-winner JSON fast path must be wired in the orchestrator.
    expect(src).toContain("probeLooksLikeDirectJsonApi(w)");
    expect(src).toContain("tryDirectJsonFetch(raceContextUrl)");
    // It must appear BEFORE the exa search (`searchIntentResolve`) so the
    // direct fetch wins the priority, not the budget race.
    const fastPathIdx = src.indexOf("probe-winner JSON-API fast path");
    const exaSearchIdx = src.indexOf("const exaBudgetMs = Math.max(1000, budgetMs - raceOutcome.ms)");
    expect(fastPathIdx).toBeGreaterThan(0);
    expect(exaSearchIdx).toBeGreaterThan(0);
    expect(fastPathIdx).toBeLessThan(exaSearchIdx);
  });
});
