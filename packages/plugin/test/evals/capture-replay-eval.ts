#!/usr/bin/env bun
/**
 * Capture-Replay E2E Eval — Full unbrowse pipeline test.
 *
 * Playwright capture → HAR parse → header profile → API replay.
 * Tests against real internal API endpoints, NOT web pages.
 *
 * Run: cd packages/plugin && bun test/evals/capture-replay-eval.ts
 */

import { chromium, type Page } from "playwright";
import { parseHar } from "../../src/har-parser.js";
import { resolveHeaders, classifyHeader } from "../../src/header-profiler.js";
import type { HarEntry, HeaderProfileFile } from "../../src/types.js";

// ── Test targets ────────────────────────────────────────────────────────────

interface TestSite {
  name: string;
  startUrl: string;
  /** Max seconds for capture phase */
  captureTimeout: number;
  actions: (page: Page) => Promise<void>;
  /** Filter captured requests to actual internal API calls */
  isApiCall: (url: string, method: string, resourceType: string) => boolean;
}

const SITES: TestSite[] = [
  {
    name: "Reddit",
    startUrl: "https://www.reddit.com/r/programming/",
    captureTimeout: 15,
    actions: async (page) => {
      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(4000);
      await page.evaluate(() => window.scrollBy(0, 800));
      await page.waitForTimeout(2000);
    },
    isApiCall: (url, _method, resourceType) => {
      if (url.includes("gql.reddit.com")) return true;
      if (url.includes("gateway.reddit.com")) return true;
      if (url.includes("reddit.com/svc/")) return true;
      if (url.includes(".json") && url.includes("reddit.com")) return true;
      if (url.includes("reddit.com") && (resourceType === "xhr" || resourceType === "fetch")) {
        if (url.includes(".js") || url.includes(".css") || url.includes(".png")) return false;
        return true;
      }
      return false;
    },
  },
  {
    name: "Carousell",
    startUrl: "https://www.carousell.sg/search/laptop",
    captureTimeout: 15,
    actions: async (page) => {
      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(4000);
      await page.evaluate(() => window.scrollBy(0, 500));
      await page.waitForTimeout(2000);
    },
    isApiCall: (url, _method, resourceType) => {
      if (url.includes("/ds/") && url.includes("carousell")) return true;
      if (url.includes("/api/") && url.includes("carousell")) return true;
      if (url.includes("/aps/") && url.includes("carousell")) return true;
      if (url.includes("carousell") && (resourceType === "xhr" || resourceType === "fetch")) {
        if (url.includes(".js") || url.includes(".css") || url.includes(".png") || url.includes(".svg")) return false;
        return true;
      }
      return false;
    },
  },
  {
    name: "Hacker News",
    startUrl: "https://hacker-news.firebaseio.com/v0/topstories.json",
    captureTimeout: 10,
    actions: async (page) => {
      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(1000);
    },
    isApiCall: (url) => {
      return url.includes("firebaseio.com") && url.includes(".json");
    },
  },
  {
    name: "Wikipedia",
    startUrl: "https://en.wikipedia.org/wiki/Main_Page",
    captureTimeout: 10,
    actions: async (page) => {
      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(2000);
    },
    isApiCall: (url, _method, resourceType) => {
      if (url.includes("/api/rest_v1/")) return true;
      if (url.includes("/w/api.php")) return true;
      if (url.includes("wikipedia.org") && (resourceType === "xhr" || resourceType === "fetch")) {
        if (url.includes(".js") || url.includes(".css") || url.includes(".png") || url.includes(".svg")) return false;
        return true;
      }
      return false;
    },
  },
  {
    name: "NPM Registry",
    startUrl: "https://www.npmjs.com/search?q=express",
    captureTimeout: 10,
    actions: async (page) => {
      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(3000);
    },
    isApiCall: (url, _method, resourceType) => {
      if (url.includes("registry.npmjs.org")) return true;
      if (url.includes("api.npmjs.org")) return true;
      if (url.includes("npmjs.com") && (resourceType === "xhr" || resourceType === "fetch")) {
        if (url.includes(".js") || url.includes(".css") || url.includes(".png") || url.includes(".svg") || url.includes(".woff")) return false;
        return true;
      }
      return false;
    },
  },
  {
    name: "Stack Overflow",
    startUrl: "https://stackoverflow.com/questions?tab=newest",
    captureTimeout: 12,
    actions: async (page) => {
      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(3000);
    },
    isApiCall: (url, _method, resourceType) => {
      if (url.includes("api.stackexchange.com")) return true;
      if (url.includes("stackoverflow.com/ajax/") || url.includes("stackoverflow.com/posts/")) return true;
      if (url.includes("stackoverflow.com") && (resourceType === "xhr" || resourceType === "fetch")) {
        if (url.includes(".js") || url.includes(".css") || url.includes(".png") || url.includes(".svg")) return false;
        return true;
      }
      return false;
    },
  },
  {
    name: "Amazon",
    startUrl: "https://www.amazon.com/s?k=laptop",
    captureTimeout: 15,
    actions: async (page) => {
      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(4000);
      await page.evaluate(() => window.scrollBy(0, 600));
      await page.waitForTimeout(2000);
    },
    isApiCall: (url, _method, resourceType) => {
      if (url.includes("completion.amazon.com")) return true;
      if (url.includes("amazon.com/api/")) return true;
      if (url.includes("amazon.com/s/ref")) return false; // search page, not API
      if (url.includes("amazon.com") && (resourceType === "xhr" || resourceType === "fetch")) {
        if (url.includes(".js") || url.includes(".css") || url.includes(".png") || url.includes(".jpg") || url.includes(".gif")) return false;
        return true;
      }
      return false;
    },
  },
  {
    name: "eBay",
    startUrl: "https://www.ebay.com/sch/i.html?_nkw=laptop",
    captureTimeout: 12,
    actions: async (page) => {
      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(3000);
      await page.evaluate(() => window.scrollBy(0, 500));
      await page.waitForTimeout(2000);
    },
    isApiCall: (url, _method, resourceType) => {
      if (url.includes("ebay.com/sch/") || url.includes("ebay.com/itm/")) return false; // pages
      if (url.includes("svcs.ebay.com")) return true;
      if (url.includes("ebay.com/api/")) return true;
      if (url.includes("ebay.com") && (resourceType === "xhr" || resourceType === "fetch")) {
        if (url.includes(".js") || url.includes(".css") || url.includes(".png") || url.includes(".jpg") || url.includes(".gif") || url.includes(".svg")) return false;
        return true;
      }
      return false;
    },
  },
  {
    name: "YouTube",
    startUrl: "https://www.youtube.com/trending",
    captureTimeout: 15,
    actions: async (page) => {
      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(4000);
      await page.evaluate(() => window.scrollBy(0, 600));
      await page.waitForTimeout(2000);
    },
    isApiCall: (url, _method, resourceType) => {
      if (url.includes("youtubei.googleapis.com")) return true;
      if (url.includes("youtube.com/youtubei/")) return true;
      if (url.includes("youtube.com/api/")) return true;
      if (url.includes("youtube.com") && (resourceType === "xhr" || resourceType === "fetch")) {
        if (url.includes(".js") || url.includes(".css") || url.includes(".png") || url.includes(".jpg")) return false;
        return true;
      }
      return false;
    },
  },
  {
    name: "Shopee SG",
    startUrl: "https://shopee.sg/search?keyword=laptop",
    captureTimeout: 15,
    actions: async (page) => {
      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(4000);
      await page.evaluate(() => window.scrollBy(0, 500));
      await page.waitForTimeout(2000);
    },
    isApiCall: (url, _method, resourceType) => {
      if (url.includes("shopee.sg/api/")) return true;
      if (url.includes("shopee.sg") && (resourceType === "xhr" || resourceType === "fetch")) {
        if (url.includes(".js") || url.includes(".css") || url.includes(".png") || url.includes(".svg")) return false;
        return true;
      }
      return false;
    },
  },
];

// ── Capture ─────────────────────────────────────────────────────────────────

interface CapturedEndpoint {
  method: string;
  url: string;
  status: number;
  headers: Record<string, string>;
  contentType?: string;
}

interface CapturedTraffic {
  entries: HarEntry[];
  apiEndpoints: CapturedEndpoint[];
}

async function captureTraffic(site: TestSite): Promise<CapturedTraffic> {
  const browser = await chromium.launch({ headless: true });

  // Don't use recordHar — it hangs on context.close() for sites with persistent connections.
  // Instead, intercept requests/responses directly via events.
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });

  const apiEndpoints: CapturedEndpoint[] = [];
  const allEntries: HarEntry[] = [];

  context.on("response", async (response) => {
    try {
      const request = response.request();
      const url = request.url();
      const method = request.method();
      const resourceType = request.resourceType();
      const status = response.status();

      // Capture ALL requests as HarEntry for header profiling
      const reqHeaders = await request.allHeaders();
      const respHeaders = response.headers();
      allEntries.push({
        request: {
          method,
          url,
          headers: Object.entries(reqHeaders).map(([name, value]) => ({ name, value })),
        },
        response: {
          status,
          headers: Object.entries(respHeaders).map(([name, value]) => ({ name, value })),
        },
      });

      // Also track API-specific endpoints for replay
      if (site.isApiCall(url, method, resourceType)) {
        apiEndpoints.push({
          method,
          url,
          status,
          headers: reqHeaders,
          contentType: respHeaders["content-type"],
        });
      }
    } catch { /* response may be detached */ }
  });

  const page = await context.newPage();

  try {
    await page.goto(site.startUrl, {
      waitUntil: "domcontentloaded",
      timeout: site.captureTimeout * 1000,
    });
    await site.actions(page);
  } catch (err) {
    console.log(`    Warning: ${String(err).slice(0, 80)}`);
  }

  // Force close — no recordHar to flush, so this won't hang
  await page.close().catch(() => {});
  await context.close().catch(() => {});
  await browser.close().catch(() => {});

  return { entries: allEntries, apiEndpoints };
}

// ── Replay ──────────────────────────────────────────────────────────────────

interface ReplayResult {
  endpoint: string;
  originalStatus: number;
  /** No headers at all */
  bare: { status: number; blocked: boolean; bodyLen: number };
  /** node mode: app headers only (no context) */
  nodeMode: { status: number; blocked: boolean; bodyLen: number };
  /** node mode + cookies from capture (simulates primeHeaders) */
  nodeCookies: { status: number; blocked: boolean; bodyLen: number };
  /** node mode + generic user-agent (not Chrome) */
  nodeUA: { status: number; blocked: boolean; bodyLen: number };
  /** browser mode: full profile including context headers */
  browserMode: { status: number; blocked: boolean; bodyLen: number };
  /** Original captured headers replayed exactly */
  exactReplay: { status: number; blocked: boolean; bodyLen: number };
}

function isBlocked(status: number, body: string): boolean {
  if (status === 0 || status === 403 || status === 503 || status === 429) return true;
  if (body.includes("challenge") || body.includes("blocked") || body.includes("Access Denied")) return true;
  if (body.length < 50 && status !== 204) return true;
  return false;
}

async function doFetch(url: string, headers: Record<string, string>): Promise<{ status: number; blocked: boolean; bodyLen: number }> {
  try {
    const resp = await fetch(url, {
      method: "GET",
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
    });
    const body = await resp.text();
    return { status: resp.status, blocked: isBlocked(resp.status, body), bodyLen: body.length };
  } catch {
    return { status: 0, blocked: true, bodyLen: 0 };
  }
}

async function replayEndpoint(
  ep: CapturedEndpoint,
  profile: HeaderProfileFile | undefined,
): Promise<ReplayResult> {
  const urlObj = new URL(ep.url);
  const domain = urlObj.hostname;
  const shortEndpoint = `${ep.method} ${urlObj.pathname.slice(0, 45)}`;

  // 1. Bare — no headers
  const bare = await doFetch(ep.url, {});
  await new Promise(r => setTimeout(r, 200));

  // 2. Node mode — app headers only, no context (user-agent, accept, etc.)
  const nodeHeaders = profile
    ? resolveHeaders(profile, domain, ep.method, urlObj.pathname, {}, {}, "node")
    : {};
  const nodeMode = await doFetch(ep.url, nodeHeaders);
  await new Promise(r => setTimeout(r, 200));

  // 3. Node + cookies — app headers + cookies from capture (simulates primeHeaders)
  const capturedCookies: Record<string, string> = {};
  const cookieHeader = ep.headers["cookie"] || ep.headers["Cookie"] || "";
  if (cookieHeader) {
    for (const pair of cookieHeader.split(";")) {
      const eq = pair.indexOf("=");
      if (eq > 0) {
        capturedCookies[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
      }
    }
  }
  const nodeCookieHeaders = profile
    ? resolveHeaders(profile, domain, ep.method, urlObj.pathname, {}, capturedCookies, "node")
    : {};
  const nodeCookies = await doFetch(ep.url, nodeCookieHeaders);
  await new Promise(r => setTimeout(r, 200));

  // 4. Node mode + generic UA — app headers + a non-Chrome user-agent
  const nodeUAHeaders = {
    ...nodeHeaders,
    "User-Agent": "unbrowse/1.0",
  };
  const nodeUA = await doFetch(ep.url, nodeUAHeaders);
  await new Promise(r => setTimeout(r, 200));

  // 5. Browser mode — full profile with context headers (Chrome UA from Node.js)
  const browserHeaders = profile
    ? resolveHeaders(profile, domain, ep.method, urlObj.pathname, {}, {}, "browser")
    : {};
  const browserMode = await doFetch(ep.url, browserHeaders);
  await new Promise(r => setTimeout(r, 200));

  // 6. Exact replay — use the original captured headers (minus protocol/browser headers)
  const cleanOriginal: Record<string, string> = {};
  for (const [k, v] of Object.entries(ep.headers)) {
    const cat = classifyHeader(k);
    if (cat !== "protocol" && cat !== "browser") {
      cleanOriginal[k] = v;
    }
  }
  const exactReplay = await doFetch(ep.url, cleanOriginal);

  return { endpoint: shortEndpoint, originalStatus: ep.status, bare, nodeMode, nodeCookies, nodeUA, browserMode, exactReplay };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== Capture-Replay E2E Eval ===");
  console.log("Pipeline: Playwright capture → parseHar → header profile → replay internal APIs");
  console.log(`Sites: ${SITES.length}\n`);

  const allResults: { site: string; results: ReplayResult[] }[] = [];

  // Allow running a subset via CLI arg
  const filterArg = process.argv[2];
  const sitesToRun = filterArg
    ? SITES.filter(s => s.name.toLowerCase().includes(filterArg.toLowerCase()))
    : SITES;

  for (const site of sitesToRun) {
    console.log(`\n${"═".repeat(70)}`);
    console.log(`  ${site.name}`);
    console.log(`${"═".repeat(70)}`);

    // ── Capture ──
    console.log(`\n  [CAPTURE] Opening ${site.startUrl}`);
    let traffic: CapturedTraffic;
    try {
      traffic = await captureTraffic(site);
    } catch (err) {
      console.log(`  SKIP: Capture failed — ${String(err).slice(0, 100)}`);
      continue;
    }

    console.log(`  Captured: ${traffic.entries.length} HAR entries, ${traffic.apiEndpoints.length} API calls`);
    for (const ep of traffic.apiEndpoints.slice(0, 5)) {
      const u = new URL(ep.url);
      const ct = ep.contentType?.split(";")[0] ?? "";
      console.log(`    ${ep.method.padEnd(5)} ${u.pathname.slice(0, 50).padEnd(50)} ${ep.status} ${ct}`);
    }
    if (traffic.apiEndpoints.length > 5) console.log(`    ... +${traffic.apiEndpoints.length - 5} more`);

    if (traffic.apiEndpoints.length === 0) {
      console.log("  SKIP: No API endpoints captured.");
      continue;
    }

    // ── Parse ──
    console.log(`\n  [PARSE] Building header profile...`);
    const apiData = parseHar({ log: { entries: traffic.entries } }, site.startUrl);
    const profile = apiData.headerProfile;

    if (profile) {
      // Only show the primary domain (most requests)
      const sorted = Object.entries(profile.domains).sort((a, b) => b[1].requestCount - a[1].requestCount);
      const top = sorted.slice(0, 2);
      for (const [d, dp] of top) {
        const appHeaders = Object.values(dp.commonHeaders).filter(h => h.category === "app");
        console.log(`  ${d}: ${dp.requestCount} reqs, ${appHeaders.length} app headers, ${Object.keys(dp.commonHeaders).length} total`);
        for (const h of appHeaders) {
          console.log(`    [app] ${h.name}: ${h.value.slice(0, 50)}${h.value.length > 50 ? "..." : ""}`);
        }
      }
      if (sorted.length > 2) console.log(`  ... +${sorted.length - 2} more domains`);
    } else {
      console.log("  WARNING: No header profile generated");
    }

    // ── Replay ──
    const toReplay = traffic.apiEndpoints
      .filter(ep => ep.method === "GET" && ep.status >= 200 && ep.status < 400)
      .slice(0, 5);

    if (toReplay.length === 0) {
      const nonGet = traffic.apiEndpoints.filter(ep => ep.status >= 200 && ep.status < 400).slice(0, 3);
      if (nonGet.length === 0) {
        console.log("  No replayable endpoints found.");
        continue;
      }
      console.log("  (No GET endpoints — POST/etc. not replayed for safety)");
      for (const ep of nonGet) {
        const u = new URL(ep.url);
        console.log(`    ${ep.method} ${u.pathname.slice(0, 55)} → ${ep.status}`);
      }
      continue;
    }

    console.log(`\n  [REPLAY] ${toReplay.length} GET endpoints`);
    console.log(`  Endpoint                                        | Orig | Bare  | Node  | N+Ck  | N+UA  | Full  | Exact`);
    console.log(`  ${"─".repeat(108)}`);

    const siteResults: ReplayResult[] = [];
    for (const ep of toReplay) {
      const result = await replayEndpoint(ep, profile);
      siteResults.push(result);

      const fmt = (r: { status: number; blocked: boolean }) => r.blocked ? "BLOCK" : `${r.status} `.slice(0, 5);
      console.log(
        `  ${result.endpoint.padEnd(50)}| ${String(result.originalStatus).padEnd(5)}` +
        `| ${fmt(result.bare).padEnd(6)}| ${fmt(result.nodeMode).padEnd(6)}` +
        `| ${fmt(result.nodeCookies).padEnd(6)}| ${fmt(result.nodeUA).padEnd(6)}` +
        `| ${fmt(result.browserMode).padEnd(6)}| ${fmt(result.exactReplay)}`
      );
    }

    allResults.push({ site: site.name, results: siteResults });

    // Site summary
    const total = siteResults.length;
    const stats = {
      bare: siteResults.filter(r => !r.bare.blocked).length,
      node: siteResults.filter(r => !r.nodeMode.blocked).length,
      nodeCk: siteResults.filter(r => !r.nodeCookies.blocked).length,
      nodeUA: siteResults.filter(r => !r.nodeUA.blocked).length,
      full: siteResults.filter(r => !r.browserMode.blocked).length,
      exact: siteResults.filter(r => !r.exactReplay.blocked).length,
    };

    console.log(`\n  Pass: bare=${stats.bare}/${total}  node=${stats.node}/${total}  node+ck=${stats.nodeCk}/${total}  node+UA=${stats.nodeUA}/${total}  full=${stats.full}/${total}  exact=${stats.exact}/${total}`);
  }

  // ── Global summary ──
  console.log(`\n${"═".repeat(70)}`);
  console.log("  SUMMARY");
  console.log(`${"═".repeat(70)}\n`);

  console.log(`  ${"Site".padEnd(20)} | Bare  | Node  | N+Ck  | N+UA  | Full  | Exact`);
  console.log(`  ${"─".repeat(78)}`);

  let totalEndpoints = 0;
  const globalStats = { bare: 0, node: 0, nodeCk: 0, nodeUA: 0, full: 0, exact: 0 };

  for (const { site, results } of allResults) {
    const total = results.length;
    totalEndpoints += total;
    const bare = results.filter(r => !r.bare.blocked).length;
    const node = results.filter(r => !r.nodeMode.blocked).length;
    const nodeCk = results.filter(r => !r.nodeCookies.blocked).length;
    const nodeUA = results.filter(r => !r.nodeUA.blocked).length;
    const full = results.filter(r => !r.browserMode.blocked).length;
    const exact = results.filter(r => !r.exactReplay.blocked).length;
    globalStats.bare += bare;
    globalStats.node += node;
    globalStats.nodeCk += nodeCk;
    globalStats.nodeUA += nodeUA;
    globalStats.full += full;
    globalStats.exact += exact;
    console.log(
      `  ${site.padEnd(20)} | ${`${bare}/${total}`.padEnd(6)}| ${`${node}/${total}`.padEnd(6)}` +
      `| ${`${nodeCk}/${total}`.padEnd(6)}| ${`${nodeUA}/${total}`.padEnd(6)}` +
      `| ${`${full}/${total}`.padEnd(6)}| ${`${exact}/${total}`}`
    );
  }

  console.log(`  ${"─".repeat(78)}`);
  console.log(
    `  ${"TOTAL".padEnd(20)} | ${`${globalStats.bare}/${totalEndpoints}`.padEnd(6)}` +
    `| ${`${globalStats.node}/${totalEndpoints}`.padEnd(6)}` +
    `| ${`${globalStats.nodeCk}/${totalEndpoints}`.padEnd(6)}` +
    `| ${`${globalStats.nodeUA}/${totalEndpoints}`.padEnd(6)}` +
    `| ${`${globalStats.full}/${totalEndpoints}`.padEnd(6)}` +
    `| ${`${globalStats.exact}/${totalEndpoints}`}`
  );

  // Determine best strategy
  const strategies = [
    { name: "bare", score: globalStats.bare },
    { name: "node", score: globalStats.node },
    { name: "node+cookies", score: globalStats.nodeCk },
    { name: "node+UA", score: globalStats.nodeUA },
    { name: "full (browser)", score: globalStats.full },
    { name: "exact", score: globalStats.exact },
  ];
  strategies.sort((a, b) => b.score - a.score);

  console.log(`\n  BEST STRATEGY: ${strategies[0].name} (${strategies[0].score}/${totalEndpoints} unblocked)`);
  console.log(`  Ranking: ${strategies.map(s => `${s.name}=${s.score}`).join(" > ")}`);

  console.log("\n  Legend:");
  console.log("  - bare:  No headers at all");
  console.log("  - node:  App-only headers from profile (no UA/accept/referer)");
  console.log("  - N+Ck:  Node headers + cookies (simulates primeHeaders)");
  console.log("  - N+UA:  App headers + generic 'unbrowse/1.0' user-agent");
  console.log("  - full:  Full profile including Chrome UA (risks TLS mismatch)");
  console.log("  - exact: Original captured headers replayed (includes cookies)\n");
}

main().catch(console.error);
