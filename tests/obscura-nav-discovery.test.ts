/**
 * GATE: navigate-discovery works headless — following a discovered same-origin
 * list/pagination link surfaces endpoints the seed page never fired.
 *
 * obscura v0.1.11 does not fire SPA scroll/click discovery, but NAVIGATION is
 * captured. So the honest working "interaction" means is link-following: extract
 * same-origin list/pagination links from the captured HTML/JS, navigate to a
 * bounded set, and union the endpoints those pages fire. All hermetic — the
 * capture runner is injected, no sidecar, no network.
 */

import { test, expect, describe } from "bun:test";
import type { RawRequest } from "../src/capture/index.js";
import type { RunObscuraCaptureResult } from "../src/capture/obscura-capture.js";
import {
  extractSameOriginLinks,
  discoverViaNavigation,
  captureAndIndexViaObscura,
} from "../src/capture/obscura-index.js";

const ORIGIN = "https://quotes.toscrape.com";

function htmlDoc(url: string, body: string): RawRequest {
  return {
    url,
    method: "GET",
    request_headers: {},
    response_status: 200,
    response_headers: { "content-type": "text/html" },
    response_body: body,
    timestamp: new Date(1785853139900).toISOString(),
  };
}

function apiRow(url: string): RawRequest {
  return {
    url,
    method: "GET",
    request_headers: { accept: "application/json" },
    response_status: 200,
    response_headers: { "content-type": "application/json" },
    response_body: JSON.stringify({ has_next: false, quotes: [{ author: { name: "A" }, text: "x", tags: [] }] }),
    timestamp: new Date(1785853139950).toISOString(),
  };
}

/** Seed page: an HTML doc linking to a next page, an external site, and an asset. */
function seedCapture(): RunObscuraCaptureResult {
  const body =
    `<a href="/scroll?page=2">Next</a>` +
    `<a href="https://evil.example/x">external</a>` +
    `<a href="/static/app.css">style</a>` +
    `<a href="/tag/love/">love</a>`;
  return {
    requests: [htmlDoc(`${ORIGIN}/`, body)],
    final_url: `${ORIGIN}/`,
    html_len: body.length,
    cookies: [],
    domain: "quotes.toscrape.com",
  };
}

/** Following /scroll?page=2 fires a NEW endpoint the seed never hit. */
function page2Capture(): RunObscuraCaptureResult {
  return {
    requests: [apiRow(`${ORIGIN}/api/quotes?page=2`)],
    final_url: `${ORIGIN}/scroll?page=2`,
    html_len: 50,
    cookies: [],
    domain: "quotes.toscrape.com",
  };
}

const runCapture = async (url: string): Promise<RunObscuraCaptureResult> =>
  /page=2/.test(url) ? page2Capture() : seedCapture();

describe("extractSameOriginLinks", () => {
  test("keeps same-origin page links, drops cross-origin and assets", () => {
    const links = extractSameOriginLinks(seedCapture());
    expect(links.some((u) => u.includes("/scroll?page=2"))).toBe(true);
    expect(links.some((u) => u.includes("/tag/love/"))).toBe(true);
    expect(links.some((u) => u.includes("evil.example"))).toBe(false);
    expect(links.some((u) => u.includes("app.css"))).toBe(false);
  });
});

describe("discoverViaNavigation", () => {
  test("follows the pagination link and returns its new endpoint", async () => {
    const found = await discoverViaNavigation(seedCapture(), runCapture, { intent: "list quotes", maxFollow: 2 });
    expect(found.some((r) => r.url === `${ORIGIN}/api/quotes?page=2`)).toBe(true);
  });

  test("maxFollow=0 disables navigation", async () => {
    const found = await discoverViaNavigation(seedCapture(), runCapture, { intent: "list quotes", maxFollow: 0 });
    expect(found.length).toBe(0);
  });
});

describe("captureAndIndexViaObscura unions navigate-discovery", () => {
  test("routes include the endpoint found only by following the link", async () => {
    const res = await captureAndIndexViaObscura(`${ORIGIN}/`, "list quotes", {
      runCapture,
      session: null,
      shareToIndex: false,
      maxFollow: 2, // opt into navigate-discovery
    });
    expect(res.navigated.some((r) => r.url === `${ORIGIN}/api/quotes?page=2`)).toBe(true);
    expect(res.routes.some((r) => r.url === `${ORIGIN}/api/quotes?page=2`)).toBe(true);
    // opt-in off => nothing shared
    expect(res.shared).toBe(false);
  });
});
