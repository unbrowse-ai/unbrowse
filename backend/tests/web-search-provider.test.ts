/**
 * web-search provider chain — adapter selection, Exa-primary, fail-soft fallback.
 *
 * The chain contract: Exa is the primary engine when EXA_API_KEY is set,
 * the keyless DDG scraper is the fallback, WEB_SEARCH_PROVIDER pins the
 * chain, and any provider error/empty falls through without ever throwing
 * (web search is an enrichment, never on the critical path). The outcome
 * reports which engine actually answered, so the wire carries honest
 * provenance instead of a hardcoded vendor label.
 */
import { describe, expect, it } from "bun:test";
import {
  webSearch,
  webSearchProviderChain,
  webSearchWithProvider,
} from "../src/services/web-search/index.js";

const EXA_BODY = JSON.stringify({
  results: [
    {
      url: "https://example.org/a",
      title: "Result A",
      score: 0.91,
      highlights: ["alpha highlight"],
    },
    { url: "https://example.org/b", title: "Result B", highlights: [] },
    { url: "not-a-url", title: "junk" },
  ],
});

const DDG_HTML = `
<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fddg.example%2Fone&rut=x">DDG One</a>
<a class="result__snippet">snippet one</a>
<a class="result__a" href="https://ddg.example/two">DDG Two</a>
<a class="result__snippet">snippet two</a>
`;

function mockFetch(handler: (url: string) => Response | Promise<Response>): typeof fetch {
  return ((input: RequestInfo | URL, _init?: RequestInit) =>
    Promise.resolve(handler(String(input)))) as typeof fetch;
}

describe("webSearchProviderChain", () => {
  it("defaults to ddg-only without a key", () => {
    expect(webSearchProviderChain({})).toEqual(["ddg"]);
  });

  it("puts exa first when EXA_API_KEY is set", () => {
    expect(webSearchProviderChain({ EXA_API_KEY: "k" })).toEqual(["exa", "ddg"]);
  });

  it("honors WEB_SEARCH_PROVIDER pins", () => {
    expect(webSearchProviderChain({ EXA_API_KEY: "k", WEB_SEARCH_PROVIDER: "ddg" })).toEqual(["ddg"]);
    expect(webSearchProviderChain({ EXA_API_KEY: "k", WEB_SEARCH_PROVIDER: "off" })).toEqual([]);
    expect(webSearchProviderChain({ EXA_API_KEY: "k", WEB_SEARCH_PROVIDER: "exa" })).toEqual(["exa", "ddg"]);
  });

  it("degrades a keyless exa pin to ddg instead of failing", () => {
    expect(webSearchProviderChain({ WEB_SEARCH_PROVIDER: "exa" })).toEqual(["ddg"]);
  });
});

describe("webSearchWithProvider", () => {
  it("uses exa as primary and reports provenance + real scores", async () => {
    const fetchImpl = mockFetch((url) => {
      expect(url).toBe("https://api.exa.ai/search");
      return new Response(EXA_BODY, { status: 200 });
    });
    const out = await webSearchWithProvider({ EXA_API_KEY: "k" }, "test query", 5, fetchImpl);
    expect(out.provider).toBe("exa");
    expect(out.results.length).toBe(2); // non-http url dropped
    expect(out.results[0]).toEqual({
      url: "https://example.org/a",
      title: "Result A",
      score: 0.91,
      highlights: ["alpha highlight"],
    });
    // missing score → position-derived fallback, empty highlights omitted
    expect(out.results[1].score).toBeCloseTo(0.9);
    expect(out.results[1].highlights).toBeUndefined();
  });

  it("falls through exa → ddg on provider error", async () => {
    const fetchImpl = mockFetch((url) =>
      url.includes("api.exa.ai")
        ? new Response("nope", { status: 500 })
        : new Response(DDG_HTML, { status: 200 }),
    );
    const out = await webSearchWithProvider({ EXA_API_KEY: "k" }, "test query", 5, fetchImpl);
    expect(out.provider).toBe("ddg");
    expect(out.results.map((r) => r.url)).toEqual(["https://ddg.example/one", "https://ddg.example/two"]);
    expect(out.results[0].highlights).toEqual(["snippet one"]);
  });

  it("falls through exa → ddg on empty exa results", async () => {
    const fetchImpl = mockFetch((url) =>
      url.includes("api.exa.ai")
        ? new Response(JSON.stringify({ results: [] }), { status: 200 })
        : new Response(DDG_HTML, { status: 200 }),
    );
    const out = await webSearchWithProvider({ EXA_API_KEY: "k" }, "test query", 5, fetchImpl);
    expect(out.provider).toBe("ddg");
    expect(out.results.length).toBe(2);
  });

  it("never throws: exhausted chain returns empty with null provider", async () => {
    const fetchImpl = mockFetch(() => new Response("down", { status: 503 }));
    const out = await webSearchWithProvider({ EXA_API_KEY: "k" }, "test query", 5, fetchImpl);
    expect(out).toEqual({ provider: null, results: [] });
  });

  it("respects the off pin", async () => {
    const fetchImpl = mockFetch(() => {
      throw new Error("must not fetch");
    });
    const out = await webSearchWithProvider({ EXA_API_KEY: "k", WEB_SEARCH_PROVIDER: "off" }, "q", 5, fetchImpl);
    expect(out).toEqual({ provider: null, results: [] });
  });

  it("returns empty for a blank query without fetching", async () => {
    const fetchImpl = mockFetch(() => {
      throw new Error("must not fetch");
    });
    const out = await webSearchWithProvider({ EXA_API_KEY: "k" }, "   ", 5, fetchImpl);
    expect(out).toEqual({ provider: null, results: [] });
  });
});

describe("webSearch (results-only wrapper)", () => {
  it("keeps the pre-adapter WebResult[] shape", async () => {
    const fetchImpl = mockFetch(() => new Response(DDG_HTML, { status: 200 }));
    const results = await webSearch({}, "test query", 5, fetchImpl);
    expect(Array.isArray(results)).toBe(true);
    expect(results[0].url).toBe("https://ddg.example/one");
    expect(results[0].score).toBe(1);
  });
});
