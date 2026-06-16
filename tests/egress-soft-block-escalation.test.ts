/**
 * Witnesses the DDG-202 soft-block escalation fix.
 *
 * The bug: DuckDuckGo throttles a hot IP with HTTP 202 + an anomaly page (a 2xx, zero results),
 * which status-only `isBlock` (0/401/403/429/≥500) accepts — so the egress chain returned the
 * throttled empty page and never escalated, making any multi-resolve run self-throttle.
 *
 * The fix: a body-level block predicate (`ddgSoftBlock`) threaded into the egress chain, so the
 * LOCAL tier treats a 2xx soft-block as a block and escalates to the clean server IP / residential
 * proxy. These tests pin the predicate and the chain wiring deterministically (downstream tiers
 * disabled so the assertion is environment-independent).
 */
import { describe, it, expect } from "bun:test";
import { egressChain, egressFetchWithBlockCheck } from "../src/execution/egress-chain.js";
import { ddgSoftBlock } from "../src/lib/ddg-search.js";

const DDG_202_THROTTLE = `<!DOCTYPE html><html><head><title>DuckDuckGo</title></head>
<body><div>If this error persists, please let us know. This is an anomaly in our traffic.</div></body></html>`;
const DDG_200_SERP = `<html><body>
<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fstripe.com%2Fdocs">Stripe Docs</a>
</body></html>`;

describe("ddgSoftBlock predicate", () => {
  it("flags an HTTP 202 throttle as a block", () => {
    expect(ddgSoftBlock(202, DDG_202_THROTTLE)).toBe(true);
  });
  it("flags a 2xx anomaly page with zero results as a block", () => {
    expect(ddgSoftBlock(200, DDG_202_THROTTLE)).toBe(true);
  });
  it("does NOT flag a real SERP with results", () => {
    expect(ddgSoftBlock(200, DDG_200_SERP)).toBe(false);
  });
  it("does NOT flag an empty-but-not-anomaly 2xx (a genuine zero-result query)", () => {
    expect(ddgSoftBlock(200, "<html><body>No results.</body></html>")).toBe(false);
  });
});

describe("egressChain body-level block", () => {
  it("marks a 202 soft-block as blocked — local tier no longer short-circuits it as served", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(DDG_202_THROTTLE, { status: 202 })) as typeof fetch;
    try {
      const out = await egressChain(
        { url: "https://html.duckduckgo.com/html/?q=test" },
        { isBlockBody: ddgSoftBlock, allowServer: false, allowClientProxy: false },
      );
      expect(out.blocked).toBe(true); // treated as a block → would escalate when tiers are available
      expect(out.tier).toBe("local");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("returns a clean 2xx SERP as served (not blocked)", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(DDG_200_SERP, { status: 200 })) as typeof fetch;
    try {
      const out = await egressChain(
        { url: "https://html.duckduckgo.com/html/?q=test" },
        { isBlockBody: ddgSoftBlock, allowServer: false, allowClientProxy: false },
      );
      expect(out.blocked).toBeFalsy();
      expect(out.status).toBe(200);
      expect(out.body).toContain("result__a");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("egressFetchWithBlockCheck happy path", () => {
  it("returns a clean 2xx SERP verbatim WITHOUT escalating", async () => {
    const realFetch = globalThis.fetch;
    let localCalls = 0;
    globalThis.fetch = (async () => {
      localCalls++;
      return new Response(DDG_200_SERP, { status: 200 });
    }) as typeof fetch;
    try {
      const f = egressFetchWithBlockCheck(ddgSoftBlock);
      const res = await f("https://html.duckduckgo.com/html/?q=test");
      const body = await res.text();
      expect(localCalls).toBe(1); // local tier served it; no escalation round-trip
      expect(res.status).toBe(200);
      expect(body).toContain("result__a");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
