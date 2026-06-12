/**
 * Witness: the @mendable/firecrawl-js drop-in. Same `new FirecrawlApp({...})` with
 * `.scrapeUrl/.search/.mapUrl/.crawlUrl`, firecrawl-shaped responses, and — the
 * load-bearing claim — every call routed through the wallet-sealed hole (the x402
 * pay-per-use path), never Firecrawl's flat-rate API. Stub transport keeps it hermetic.
 */
import { test, expect } from "bun:test";
import FirecrawlApp from "../src/sdk/adapters/firecrawl.js";
import type { HoleTransport, HoleRequest } from "../src/sdk/hole.js";

function recordingStub() {
  const calls: HoleRequest[] = [];
  const transport: HoleTransport = async (req) => {
    calls.push(req);
    if (req.intent.startsWith("contents of")) {
      return { ok: true, intent: req.intent, items: [{ url: req.url, title: "Doc", text: "# scraped body" }] };
    }
    if (req.intent.startsWith("links on")) {
      return { ok: true, intent: req.intent, items: [{ url: "https://site.example/a" }, { url: "https://site.example/b" }] };
    }
    if (req.intent.startsWith("crawl")) {
      return { ok: true, intent: req.intent, items: [{ url: "https://site.example/1", text: "p1" }, { url: "https://site.example/2", text: "p2" }] };
    }
    return { ok: true, intent: req.intent, items: [
      { title: "R1", url: "https://a.example/1", text: "alpha", score: 0.7 },
      { title: "R2", url: "https://b.example/2", text: "beta", score: 0.6 },
    ] };
  };
  return { transport, calls };
}

test("scrapeUrl returns the firecrawl scrape shape, routed through the hole", async () => {
  const { transport, calls } = recordingStub();
  const app = new FirecrawlApp({ apiKey: "ignored", transport });
  const res = await app.scrapeUrl("https://example.com/page");
  expect(res.success).toBe(true);
  expect(res.markdown).toBe("# scraped body");
  expect(res.metadata?.sourceURL).toBe("https://example.com/page");
  expect(res.metadata?.title).toBe("Doc");
  // x402 routing: the call went through the wallet-sealed hole, not Firecrawl's API.
  expect(calls.length).toBe(1);
  expect(calls[0].url).toBe("https://example.com/page");
});

test("search returns firecrawl data[] shape with limit honored", async () => {
  const { transport, calls } = recordingStub();
  const app = new FirecrawlApp({ transport });
  const res = await app.search("anthropic news", { limit: 1 });
  expect(res.success).toBe(true);
  expect(res.data.length).toBe(1);
  expect(res.data[0].url).toBe("https://a.example/1");
  expect(res.data[0].markdown).toBe("alpha");
  expect(calls[0].intent).toBe("anthropic news");
});

test("mapUrl returns the links list", async () => {
  const { transport } = recordingStub();
  const app = new FirecrawlApp({ transport });
  const res = await app.mapUrl("https://site.example");
  expect(res.success).toBe(true);
  expect(res.links).toEqual(["https://site.example/a", "https://site.example/b"]);
});

test("crawlUrl returns a completed crawl with documents", async () => {
  const { transport } = recordingStub();
  const app = new FirecrawlApp({ transport });
  const res = await app.crawlUrl("https://site.example", { limit: 5 });
  expect(res.success).toBe(true);
  expect(res.status).toBe("completed");
  expect(res.total).toBe(2);
  expect(res.data.map((d) => d.url)).toEqual(["https://site.example/1", "https://site.example/2"]);
});

test("no transport calls escape the hole (every method is x402-routed)", async () => {
  const { transport, calls } = recordingStub();
  const app = new FirecrawlApp({ transport });
  await app.scrapeUrl("https://x.example");
  await app.search("q");
  await app.mapUrl("https://y.example");
  await app.crawlUrl("https://z.example");
  expect(calls.length).toBe(4); // all four calls went through the wallet-sealed hole
});
