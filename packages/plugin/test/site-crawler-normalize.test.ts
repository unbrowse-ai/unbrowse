import { describe, it, expect } from "bun:test";

import { normalizeCrawlUrl } from "../src/site-crawler.js";

describe("site-crawler normalizeCrawlUrl", () => {
  it("strips hashes, trims trailing slash, sorts query params", () => {
    const a = normalizeCrawlUrl("https://example.com/path/?b=2&a=1#section");
    const b = normalizeCrawlUrl("https://example.com/path?a=1&b=2");
    expect(a).toBe(b);
    expect(a).toBe("https://example.com/path?a=1&b=2");
  });

  it("removes utm_* params (case-insensitive on key)", () => {
    const u = normalizeCrawlUrl("https://example.com/page?utm_source=x&utm_medium=y&q=ok");
    expect(u).toBe("https://example.com/page?q=ok");
  });

  it("removes common click-id tracking params but keeps functional params", () => {
    const u = normalizeCrawlUrl("https://example.com/page?gclid=1&fbclid=2&page=3&q=test");
    expect(u).toBe("https://example.com/page?page=3&q=test");
  });

  it("does not remove non-tracking params that can be functional", () => {
    const u = normalizeCrawlUrl("https://example.com/page?ref=invite&source=app");
    expect(u).toBe("https://example.com/page?ref=invite&source=app");
  });
});

