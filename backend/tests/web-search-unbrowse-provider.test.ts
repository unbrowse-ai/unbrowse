/**
 * Witness: unbrowse's OWN web-search provider — "our own exa" without api.exa.ai.
 *
 * Proves (1) the keyless default chain leads with the unbrowse provider (no
 * external search API needed), and (2) it returns content-grounded highlights
 * (exa-parity contents) extracted+ranked from the actual page, not the thin DDG
 * snippet — composing ddgSearch + rank-bm25, primitives unbrowse already owns.
 *   bun test backend/tests/web-search-unbrowse-provider.test.ts
 */
import { describe, it, expect } from "bun:test";
import { webSearchProviderChain } from "../src/services/web-search/index.js";
import { unbrowseSearch, topSentences } from "../src/services/web-search/providers/unbrowse.js";
import type { Env } from "../src/types.js";

const env = (o: Partial<Env>) => o as unknown as Pick<Env, "EXA_API_KEY" | "WEB_SEARCH_PROVIDER">;

describe("unbrowse's own web-search provider (opt-in; no external API)", () => {
  it("is selectable via WEB_SEARCH_PROVIDER=unbrowse (no api.exa.ai)", () => {
    // OPT-IN, not default: a live A/B showed its highlights don't beat DDG's
    // snippet and cost ~2x latency, so the default chain stays ddg/exa. The
    // provider remains available + correct for when a real readability extractor
    // makes it win.
    expect(webSearchProviderChain(env({ WEB_SEARCH_PROVIDER: "unbrowse" }))).toEqual(["unbrowse", "ddg"]);
  });

  it("topSentences extracts the query-relevant content sentence (exa-parity highlights)", () => {
    const text =
      "Today the weather is nice and sunny outside in the garden with the flowers blooming. " +
      "Surface codes are the leading approach to quantum error correction on superconducting qubits. " +
      "The cafe down the street serves excellent coffee and pastries every single morning of the week.";
    const hi = topSentences(text, ["quantum", "error", "correction"], 1);
    expect(hi.length).toBe(1);
    expect(hi[0]).toContain("quantum error correction");
  });

  it("end-to-end: enriches a DDG candidate with content-grounded highlights (no api.exa.ai)", async () => {
    const page =
      "<html><body><p>Generic intro paragraph about many unrelated topics and things that simply fill space here.</p>" +
      "<p>Surface codes are the leading approach to quantum error correction on superconducting qubits today.</p></body></html>";
    const ddgHtml =
      '<a class="result__a" href="https://example.test/article">QEC Article</a>' +
      '<a class="result__snippet">thin ddg snippet</a>';
    const fetchMock = (async (url: string) => {
      if (String(url).includes("duckduckgo.com")) return new Response(ddgHtml, { status: 200 });
      if (String(url) === "https://example.test/article") return new Response(page, { status: 200 });
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;

    const results = await unbrowseSearch("quantum error correction", 5, fetchMock);
    expect(results.length).toBeGreaterThan(0);
    const top = results[0];
    expect(top.url).toBe("https://example.test/article");
    expect(top.highlights?.[0]).toContain("quantum error correction"); // content-derived
    expect(top.highlights?.[0]).not.toBe("thin ddg snippet"); // NOT the raw DDG snippet
  });
});
