#!/usr/bin/env bun
/**
 * E2E: primeHeaders → resolveHeaders → real API call.
 *
 * Tests whether cookies + headers captured from a live browser
 * are sufficient to replay Shopee's internal API without getting blocked.
 */
import { primeHeaders, resolveHeaders, buildHeaderProfiles } from "../../src/header-profiler.js";
import type { HeaderProfileFile } from "../../src/types.js";

const BROWSER_PORT = 18792;
const TARGET = "https://shopee.sg/search?keyword=laptop";

// Shopee API endpoints to test (from previous eval runs)
const ENDPOINTS = [
  { method: "GET", path: "/api/v4/search/search_items", url: "https://shopee.sg/api/v4/search/search_items?by=relevancy&keyword=laptop&limit=60&newest=0&order=desc&page_type=search&scenario=PAGE_GLOBAL_SEARCH&version=2" },
  { method: "GET", path: "/api/v4/account/basic/get_account_info", url: "https://shopee.sg/api/v4/account/basic/get_account_info" },
  { method: "GET", path: "/api/v4/platform/get_ft_v2", url: "https://shopee.sg/api/v4/platform/get_ft_v2" },
];

// Build a realistic profile template (what a skill would have)
const profile: HeaderProfileFile = {
  version: 1,
  domains: {
    "shopee.sg": {
      domain: "shopee.sg",
      commonHeaders: {
        "accept": { name: "Accept", value: "application/json", category: "context", seenCount: 10 },
        "user-agent": { name: "User-Agent", value: "Mozilla/5.0 (old)", category: "context", seenCount: 10 },
        "referer": { name: "Referer", value: "https://shopee.sg/", category: "context", seenCount: 10 },
        "x-requested-with": { name: "X-Requested-With", value: "XMLHttpRequest", category: "app", seenCount: 10 },
      },
      requestCount: 10,
      capturedAt: "2026-01-01T00:00:00Z",
    },
  },
  endpointOverrides: {},
};

async function main() {
  console.log("=== primeHeaders → resolveHeaders → Replay E2E ===\n");

  // Step 1: Prime headers + cookies from live browser
  console.log("[1] Priming headers + cookies from browser...");
  const primeResult = await primeHeaders(TARGET, profile, BROWSER_PORT);
  console.log(`    Headers: ${Object.keys(primeResult.headers).length}`);
  for (const [k, v] of Object.entries(primeResult.headers)) {
    console.log(`      ${k}: ${v.slice(0, 60)}${v.length > 60 ? "..." : ""}`);
  }
  console.log(`    Cookies: ${Object.keys(primeResult.cookies).length}`);
  for (const [k, v] of Object.entries(primeResult.cookies).slice(0, 5)) {
    console.log(`      ${k}: ${v.slice(0, 40)}${v.length > 40 ? "..." : ""}`);
  }
  if (Object.keys(primeResult.cookies).length > 5) {
    console.log(`      ... +${Object.keys(primeResult.cookies).length - 5} more`);
  }

  // Step 2: For each endpoint, build headers via resolveHeaders and call it
  console.log(`\n[2] Replaying ${ENDPOINTS.length} endpoints...\n`);
  console.log(`  ${"Endpoint".padEnd(50)} | Bare  | Node  | Primed`);
  console.log(`  ${"─".repeat(75)}`);

  for (const ep of ENDPOINTS) {
    // Strategy A: Bare (no headers)
    const bareResult = await doFetch(ep.url, {});
    await sleep(300);

    // Strategy B: Node mode (app headers only, no cookies)
    const nodeHeaders = resolveHeaders(profile, "shopee.sg", ep.method, ep.path, {}, {}, "node");
    const nodeResult = await doFetch(ep.url, nodeHeaders);
    await sleep(300);

    // Strategy C: Primed (node headers + primed cookies from browser)
    const primedHeaders = resolveHeaders(profile, "shopee.sg", ep.method, ep.path, {}, primeResult.cookies, "node");
    // Also overlay any fresh header values from primeResult
    for (const [k, v] of Object.entries(primeResult.headers)) {
      const lower = k.toLowerCase();
      // Only use app headers from prime (skip context to avoid TLS mismatch)
      const existing = Object.keys(primedHeaders).find(h => h.toLowerCase() === lower);
      if (existing) primedHeaders[existing] = v;
    }
    const primedResult = await doFetch(ep.url, primedHeaders);
    await sleep(300);

    const fmt = (r: { status: number; blocked: boolean; bodyLen: number }) =>
      r.blocked ? "BLOCK" : `${r.status}`;
    const shortPath = `${ep.method} ${ep.path.slice(0, 44)}`;
    console.log(
      `  ${shortPath.padEnd(50)} | ${fmt(bareResult).padEnd(6)}| ${fmt(nodeResult).padEnd(6)}| ${fmt(primedResult)}`
    );

    // Show body snippet for primed result
    if (!primedResult.blocked && primedResult.bodySnippet) {
      console.log(`    → ${primedResult.bodySnippet}`);
    }
  }
}

async function doFetch(url: string, headers: Record<string, string>): Promise<{
  status: number;
  blocked: boolean;
  bodyLen: number;
  bodySnippet?: string;
}> {
  try {
    const resp = await fetch(url, {
      method: "GET",
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
    });
    const body = await resp.text();
    const blocked = resp.status === 403 || resp.status === 503 || resp.status === 429
      || body.includes("challenge") || body.includes("blocked") || body.includes("Access Denied")
      || (body.length < 50 && resp.status !== 200 && resp.status !== 204);

    // Extract a meaningful snippet
    let snippet: string | undefined;
    try {
      const json = JSON.parse(body);
      if (json.items) snippet = `${json.items.length} items returned`;
      else if (json.data) snippet = `data: ${JSON.stringify(json.data).slice(0, 80)}...`;
      else if (json.error) snippet = `error: ${json.error}`;
      else snippet = `${body.slice(0, 80)}...`;
    } catch {
      snippet = `${body.slice(0, 80)}...`;
    }

    return { status: resp.status, blocked, bodyLen: body.length, bodySnippet: snippet };
  } catch {
    return { status: 0, blocked: true, bodyLen: 0 };
  }
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

main().catch(console.error);
