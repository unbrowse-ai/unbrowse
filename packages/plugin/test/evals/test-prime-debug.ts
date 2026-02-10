#!/usr/bin/env bun
/**
 * Debug: capture what headers Shopee's search_items actually gets from a real browser,
 * then compare with what primeHeaders produces.
 */
import { chromium } from "playwright";
import { classifyHeader } from "../../src/header-profiler.js";

const TARGET = "https://shopee.sg/search?keyword=laptop";

async function main() {
  // Step 1: Capture real browser headers for search_items
  console.log("[1] Capturing real browser traffic to Shopee search_items...\n");

  const browser = await chromium.connectOverCDP("http://127.0.0.1:18792", { timeout: 3000 }).catch(() => null)
    ?? await chromium.launch({ headless: true });

  const context = browser.contexts()[0] ?? await browser.newContext();
  const page = await context.newPage();

  const searchHeaders: Record<string, string>[] = [];

  page.on("request", (req) => {
    if (req.url().includes("/api/v4/search/search_items")) {
      searchHeaders.push(req.headers());
    }
  });

  await page.goto(TARGET, { waitUntil: "domcontentloaded", timeout: 15000 });
  await page.waitForTimeout(5000);

  // Get cookies
  const cookies = await context.cookies("https://shopee.sg");

  await page.close().catch(() => {});

  if (searchHeaders.length === 0) {
    console.log("  No search_items requests captured. Scrolling to trigger...");
    const page2 = await context.newPage();
    page2.on("request", (req) => {
      if (req.url().includes("/api/v4/search/search_items")) {
        searchHeaders.push(req.headers());
      }
    });
    await page2.goto(TARGET, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page2.waitForTimeout(3000);
    await page2.evaluate(() => window.scrollBy(0, 500));
    await page2.waitForTimeout(3000);
    await page2.close().catch(() => {});
  }

  if (searchHeaders.length === 0) {
    console.log("  Still no search_items requests captured. Checking all requests...\n");
    const page3 = await context.newPage();
    const allReqs: string[] = [];
    page3.on("request", (req) => {
      if (req.url().includes("shopee.sg/api/")) {
        allReqs.push(`${req.method()} ${new URL(req.url()).pathname}`);
      }
    });
    await page3.goto(TARGET, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page3.waitForTimeout(5000);
    console.log("  Shopee API calls seen:");
    for (const r of allReqs) console.log(`    ${r}`);
    await page3.close().catch(() => {});
    return;
  }

  console.log(`  Captured ${searchHeaders.length} search_items request(s)\n`);

  // Show all headers from the first search_items request
  const h = searchHeaders[0];
  console.log("  === Real browser headers for search_items ===");
  const categories: Record<string, string[]> = {};
  for (const [name, value] of Object.entries(h)) {
    const cat = classifyHeader(name);
    if (!categories[cat]) categories[cat] = [];
    categories[cat].push(`${name}: ${value.slice(0, 70)}${value.length > 70 ? "..." : ""}`);
  }
  for (const [cat, headers] of Object.entries(categories).sort()) {
    console.log(`\n  [${cat}]`);
    for (const line of headers) console.log(`    ${line}`);
  }

  // Show cookies
  console.log(`\n  === Cookies (${cookies.length}) ===`);
  for (const c of cookies.slice(0, 10)) {
    console.log(`    ${c.name}: ${c.value.slice(0, 40)}${c.value.length > 40 ? "..." : ""}`);
  }

  // Now replay with exact browser headers
  console.log("\n[2] Replaying search_items with exact captured headers...");
  const searchUrl = `https://shopee.sg/api/v4/search/search_items?by=relevancy&keyword=laptop&limit=60&newest=0&order=desc&page_type=search&scenario=PAGE_GLOBAL_SEARCH&version=2`;

  // Build cookie string
  const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join("; ");

  // Exact replay (all headers including cookies)
  const exactHeaders: Record<string, string> = { ...h };
  exactHeaders["cookie"] = cookieStr;
  // Remove protocol headers
  for (const k of Object.keys(exactHeaders)) {
    if (k.startsWith(":") || classifyHeader(k) === "protocol" || classifyHeader(k) === "browser") {
      delete exactHeaders[k];
    }
  }

  const exactResp = await fetch(searchUrl, { headers: exactHeaders, signal: AbortSignal.timeout(10000) });
  const exactBody = await exactResp.text();
  console.log(`  Exact: ${exactResp.status} (${exactBody.length} bytes)`);
  try {
    const j = JSON.parse(exactBody);
    if (j.items) console.log(`  → ${j.items.length} items returned`);
    else if (j.error) console.log(`  → error: ${j.error}`);
    else console.log(`  → ${exactBody.slice(0, 100)}`);
  } catch {
    console.log(`  → ${exactBody.slice(0, 100)}`);
  }

  // Now strip context headers (user-agent, referer, accept) and try again
  console.log("\n[3] Replaying with app headers + cookies only (no context)...");
  const appHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(exactHeaders)) {
    const cat = classifyHeader(k);
    if (cat === "app" || cat === "cookie" || cat === "auth") {
      appHeaders[k] = v;
    }
  }
  // Ensure cookie is included
  appHeaders["cookie"] = cookieStr;

  console.log("  Headers sent:");
  for (const [k, v] of Object.entries(appHeaders)) {
    console.log(`    ${k}: ${v.slice(0, 60)}${v.length > 60 ? "..." : ""}`);
  }

  const appResp = await fetch(searchUrl, { headers: appHeaders, signal: AbortSignal.timeout(10000) });
  const appBody = await appResp.text();
  console.log(`\n  App+cookies: ${appResp.status} (${appBody.length} bytes)`);
  try {
    const j = JSON.parse(appBody);
    if (j.items) console.log(`  → ${j.items.length} items returned`);
    else if (j.error) console.log(`  → error: ${j.error}`);
    else console.log(`  → ${appBody.slice(0, 100)}`);
  } catch {
    console.log(`  → ${appBody.slice(0, 100)}`);
  }
}

main().catch(console.error);
