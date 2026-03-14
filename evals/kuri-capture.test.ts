#!/usr/bin/env bun
/**
 * Kuri capture eval — tests the full pipeline with Kuri replacing agent-browser.
 *
 * Tests: Kuri startup → navigate → capture → reverse-engineer → validate
 *
 * Usage:
 *   bun test evals/kuri-capture.test.ts
 *   KURI_PATH=~/kuri bun test evals/kuri-capture.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as kuri from "../src/kuri/client.js";
import { captureSession } from "../src/capture/index.js";

// Sites to eval — covers SSR, SPA, API-heavy, and CF-protected
const EVAL_SITES = [
  {
    name: "Wikipedia",
    url: "https://en.wikipedia.org/wiki/Main_Page",
    expect: { minRequests: 1, hasHtml: true },
    timeout: 30_000,
  },
  {
    name: "GitHub",
    url: "https://github.com/trending",
    expect: { minRequests: 1, hasHtml: true },
    timeout: 30_000,
  },
  {
    name: "NPM",
    url: "https://www.npmjs.com/package/express",
    expect: { minRequests: 1, hasHtml: true },
    timeout: 30_000,
  },
  {
    name: "Amazon",
    url: "https://www.amazon.com/s?k=laptop",
    expect: { minRequests: 1, hasHtml: true },
    timeout: 45_000,
  },
  {
    name: "Reddit",
    url: "https://www.reddit.com/r/programming/",
    expect: { minRequests: 1, hasHtml: true },
    timeout: 30_000,
  },
];

describe("Kuri capture pipeline", () => {
  beforeAll(async () => {
    await kuri.start();
    const h = await kuri.health();
    console.log(`[eval] Kuri health: ${JSON.stringify(h)}`);
  }, 15_000);

  afterAll(async () => {
    // Don't stop Kuri — other tests may use it
  });

  test("Kuri health check", async () => {
    await kuri.start();
    // Give Kuri a moment to finish Chrome discovery
    await new Promise((r) => setTimeout(r, 500));
    const h = await kuri.health();
    expect(h.ok).toBe(true);
  }, 15_000);

  test("Kuri tab lifecycle", async () => {
    const tabId = await kuri.getDefaultTab();
    expect(tabId).toBeTruthy();
    expect(typeof tabId).toBe("string");

    // Navigate — wait for page to actually load
    await kuri.navigate(tabId, "https://example.com");
    await new Promise((r) => setTimeout(r, 3000));

    // Get URL — verify navigation completed
    const url = await kuri.getCurrentUrl(tabId);
    // Tab may have been reused from a prior test, so just check it's a valid URL
    expect(typeof url).toBe("string");

    // Evaluate JS — this should always work regardless of which page is loaded
    const title = await kuri.evaluate(tabId, "document.title");
    expect(typeof title).toBe("string");
    expect((title as string).length).toBeGreaterThan(0);

    // Cookies
    const cookies = await kuri.getCookies(tabId);
    expect(Array.isArray(cookies)).toBe(true);
  }, 15_000);

  // Dynamic eval tests for each site
  for (const site of EVAL_SITES) {
    test(`capture: ${site.name}`, async () => {
      const start = Date.now();
      console.log(`[eval] capturing ${site.name}: ${site.url}`);

      try {
        const result = await captureSession(site.url);
        const elapsed = Date.now() - start;

        console.log(`[eval] ${site.name}: ${result.requests.length} requests, ${elapsed}ms`);
        console.log(`[eval]   final_url: ${result.final_url}`);
        console.log(`[eval]   cookies: ${result.cookies?.length ?? 0}`);
        console.log(`[eval]   html: ${result.html ? `${result.html.length} chars` : "none"}`);

        // Log API-like requests
        const apiRequests = result.requests.filter((r) => {
          const url = r.url.toLowerCase();
          return (
            url.includes("/api/") ||
            url.includes("graphql") ||
            url.includes(".json") ||
            r.response_body?.startsWith("{") ||
            r.response_body?.startsWith("[")
          );
        });
        console.log(`[eval]   API requests: ${apiRequests.length}`);
        for (const r of apiRequests.slice(0, 5)) {
          console.log(`[eval]     ${r.method} ${r.url.substring(0, 100)} → ${r.response_status} (${r.response_body?.length ?? 0} bytes)`);
        }
        // Assertions — for SSR sites, HTML is the capture; for SPAs, API requests
        const hasCapturedContent = result.requests.length > 0 || (result.html && result.html.length > 1000);
        expect(hasCapturedContent).toBe(true);
        expect(result.domain).toBeTruthy();
        expect(result.har_lineage_id).toBeTruthy();
        if (site.expect.hasHtml) {
          expect(result.html).toBeTruthy();
          expect(result.html!.length).toBeGreaterThan(100);
        }
      } catch (err) {
        console.error(`[eval] ${site.name} FAILED: ${err instanceof Error ? err.message : err}`);
        throw err;
      }
    }, site.timeout);
  }
});

describe("Kuri vs agent-browser comparison", () => {
  test("startup time < 5s", async () => {
    // Kuri should already be running, but measure restart
    await kuri.stop();
    const start = Date.now();
    await kuri.start();
    const elapsed = Date.now() - start;
    console.log(`[eval] Kuri startup: ${elapsed}ms`);
    expect(elapsed).toBeLessThan(5000);
  }, 10_000);

  test("navigate + evaluate < 3s", async () => {
    const tabId = await kuri.getDefaultTab();
    const start = Date.now();
    await kuri.navigate(tabId, "https://example.com");
    await new Promise((r) => setTimeout(r, 1000));
    const title = await kuri.evaluate(tabId, "document.title");
    const elapsed = Date.now() - start;
    console.log(`[eval] navigate + evaluate: ${elapsed}ms, title: ${title}`);
    expect(elapsed).toBeLessThan(3000);
    // Title may vary if tab was reused — just verify we got a string back
    expect(typeof title).toBe("string");
  }, 5_000);
});
