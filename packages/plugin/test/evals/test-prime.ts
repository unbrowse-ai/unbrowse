#!/usr/bin/env bun
/**
 * Quick test: call primeHeaders() against a real browser to verify
 * it captures fresh headers + cookies from a live browser session.
 */
import { primeHeaders } from "../../src/header-profiler.js";
import type { HeaderProfileFile } from "../../src/types.js";

const BROWSER_PORT = 18792; // CDP debug port for Chrome

// Simulate a header profile template like what a downloaded skill would have
const fakeProfile: HeaderProfileFile = {
  version: 1,
  domains: {
    "shopee.sg": {
      domain: "shopee.sg",
      commonHeaders: {
        "accept": { name: "Accept", value: "application/json", category: "context", seenCount: 10 },
        "user-agent": { name: "User-Agent", value: "Mozilla/5.0 (old)", category: "context", seenCount: 10 },
        "referer": { name: "Referer", value: "https://shopee.sg/old", category: "context", seenCount: 10 },
        "x-requested-with": { name: "X-Requested-With", value: "XMLHttpRequest", category: "app", seenCount: 10 },
      },
      requestCount: 10,
      capturedAt: "2026-01-01T00:00:00Z",
    },
  },
  endpointOverrides: {},
};

console.log(`Calling primeHeaders against shopee.sg with browser on port ${BROWSER_PORT}...\n`);

try {
  const result = await primeHeaders("https://shopee.sg/search?keyword=laptop", fakeProfile, BROWSER_PORT);

  console.log("=== HEADERS ===");
  const templateHeaders = fakeProfile.domains["shopee.sg"].commonHeaders;
  for (const [k, v] of Object.entries(result.headers)) {
    const sample = templateHeaders[k.toLowerCase()]?.value;
    const fresh = sample ? v !== sample : true;
    console.log(`  ${k}: ${v.slice(0, 80)}${v.length > 80 ? "..." : ""} ${fresh ? "(FRESH)" : "(fallback)"}`);
  }

  console.log(`\n=== COOKIES (${Object.keys(result.cookies).length}) ===`);
  for (const [k, v] of Object.entries(result.cookies).slice(0, 15)) {
    console.log(`  ${k}: ${v.slice(0, 60)}${v.length > 60 ? "..." : ""}`);
  }
  if (Object.keys(result.cookies).length > 15) {
    console.log(`  ... +${Object.keys(result.cookies).length - 15} more`);
  }

  console.log(`\nRESULT: ${Object.keys(result.headers).length} headers, ${Object.keys(result.cookies).length} cookies`);
  const freshCount = Object.entries(result.headers).filter(([k, v]) => {
    const sample = templateHeaders[k.toLowerCase()]?.value;
    return sample ? v !== sample : true;
  }).length;
  console.log(`FRESH: ${freshCount}/${Object.keys(result.headers).length} headers hydrated from browser`);
  console.log(`VERDICT: ${Object.keys(result.cookies).length > 0 ? "PASS - cookies captured" : "FAIL - no cookies"}`);
} catch (err) {
  console.error("ERROR:", err);
  process.exit(1);
}
