#!/usr/bin/env bun
/**
 * Production Benchmark — Header Profiler Impact on Real Marketplace Skills
 *
 * Fetches published skills from the production database, captures live traffic
 * to build header profiles, then compares replay success rates:
 *   - PRE-CHANGE:  bare fetch (no headers) — how execViaFetch worked before
 *   - POST-CHANGE: node mode (app headers + cookies) — new default
 *   - CEILING:     exact replay (original captured headers)
 *
 * Run: cd packages/plugin && bun test/evals/production-benchmark.ts [limit]
 */

import { chromium, type Page, type BrowserContext } from "playwright";
import { parseHar } from "../../src/har-parser.js";
import { resolveHeaders, classifyHeader } from "../../src/header-profiler.js";
import { extractEndpoints } from "../../src/skill-sanitizer.js";
import type { HarEntry, HeaderProfileFile } from "../../src/types.js";

const API_BASE = "https://index.unbrowse.ai";

// ── Fetch skills from production ──────────────────────────────────────────

interface SkillSummary {
  skillId: string;
  name: string;
  domain: string | null;
  authType: string | null;
  downloadCount: number;
  qualityScore: number;
  priceUsdc: string;
}

interface SkillContent {
  skillId: string;
  name: string;
  domain: string | null;
  skillMd: string;
  scripts?: Record<string, string>;
}

async function fetchSkills(limit: number): Promise<SkillSummary[]> {
  const resp = await fetch(`${API_BASE}/marketplace/skills?limit=${limit}`);
  const data = await resp.json() as any;
  return (data.skills ?? []).filter((s: any) => s.domain && parseFloat(s.priceUsdc || "0") === 0);
}

async function fetchSkillContent(skillId: string): Promise<SkillContent | null> {
  const resp = await fetch(`${API_BASE}/marketplace/skills/${skillId}`);
  const data = await resp.json() as any;
  if (!data.skill?.skillMd) return null;
  return data.skill;
}

// ── Capture traffic from a domain ─────────────────────────────────────────

async function captureTraffic(
  domain: string,
  startUrl: string,
  timeout: number,
): Promise<{ entries: HarEntry[]; apiEndpoints: CapturedEndpoint[] }> {
  // Hard timeout wrapper — some sites stall headless browsers indefinitely
  const HARD_TIMEOUT = 30_000;

  return Promise.race([
    captureTrafficInner(domain, startUrl, timeout),
    new Promise<{ entries: HarEntry[]; apiEndpoints: CapturedEndpoint[] }>((_, reject) =>
      setTimeout(() => reject(new Error("Hard timeout reached")), HARD_TIMEOUT)
    ),
  ]);
}

async function captureTrafficInner(
  domain: string,
  startUrl: string,
  timeout: number,
): Promise<{ entries: HarEntry[]; apiEndpoints: CapturedEndpoint[] }> {
  const browser = await chromium.launch({ headless: true });
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
      const status = response.status();
      const resourceType = request.resourceType();

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

      // Track API calls (XHR/Fetch to target domain)
      if (
        (resourceType === "xhr" || resourceType === "fetch") &&
        url.includes(domain) &&
        !url.endsWith(".js") && !url.endsWith(".css") && !url.endsWith(".png") &&
        !url.endsWith(".svg") && !url.endsWith(".jpg") && !url.endsWith(".woff2")
      ) {
        apiEndpoints.push({ method, url, status, headers: reqHeaders });
      }
    } catch { /* detached */ }
  });

  const page = await context.newPage();
  try {
    await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: timeout * 1000 });
    await page.waitForTimeout(3000);
    await page.evaluate(() => window.scrollBy(0, 600)).catch(() => {});
    await page.waitForTimeout(1500);
  } catch {
    // Some sites may timeout or block headless
  }

  // Force close with timeout to prevent hanging
  await Promise.race([
    (async () => {
      await page.close().catch(() => {});
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    })(),
    new Promise<void>(r => setTimeout(r, 5000)),
  ]);

  return { entries: allEntries, apiEndpoints };
}

// ── Replay ────────────────────────────────────────────────────────────────

interface CapturedEndpoint {
  method: string;
  url: string;
  status: number;
  headers: Record<string, string>;
}

interface ReplayResult {
  endpoint: string;
  domain: string;
  originalStatus: number;
  bare: { status: number; blocked: boolean };
  node: { status: number; blocked: boolean };
  nodeCookies: { status: number; blocked: boolean };
  exact: { status: number; blocked: boolean };
}

function isBlocked(status: number, body: string): boolean {
  if (status === 0 || status === 403 || status === 503 || status === 429) return true;
  if (body.includes("Access Denied") || body.includes("blocked") || body.includes("captcha")) return true;
  if (body.length < 50 && status !== 204 && status !== 200) return true;
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
  const shortEndpoint = `${ep.method} ${urlObj.pathname.slice(0, 40)}`;

  // 1. Bare — no headers (PRE-CHANGE baseline)
  const bare = await doFetch(ep.url, {});
  await sleep(200);

  // 2. Node mode — app headers only (POST-CHANGE without cookies)
  const nodeHeaders = profile
    ? resolveHeaders(profile, domain, ep.method, urlObj.pathname, {}, {}, "node")
    : {};
  const node = await doFetch(ep.url, nodeHeaders);
  await sleep(200);

  // 3. Node + cookies (POST-CHANGE with cookie priming)
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
  await sleep(200);

  // 4. Exact replay (ceiling)
  const cleanOriginal: Record<string, string> = {};
  for (const [k, v] of Object.entries(ep.headers)) {
    const cat = classifyHeader(k);
    if (cat !== "protocol" && cat !== "browser") {
      cleanOriginal[k] = v;
    }
  }
  const exact = await doFetch(ep.url, cleanOriginal);

  return {
    endpoint: shortEndpoint,
    domain,
    originalStatus: ep.status,
    bare: { status: bare.status, blocked: bare.blocked },
    node: { status: node.status, blocked: node.blocked },
    nodeCookies: { status: nodeCookies.status, blocked: nodeCookies.blocked },
    exact: { status: exact.status, blocked: exact.blocked },
  };
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const limitArg = parseInt(process.argv[2] || "100");
  const maxSites = parseInt(process.argv[3] || "20");

  console.log("╔══════════════════════════════════════════════════════════════════════╗");
  console.log("║  PRODUCTION BENCHMARK: Header Profiler Impact on Marketplace Skills ║");
  console.log("╚══════════════════════════════════════════════════════════════════════╝\n");

  // Step 1: Fetch skills
  console.log(`[1] Fetching free skills from production API (limit=${limitArg})...`);
  const skills = await fetchSkills(limitArg);
  console.log(`    Found ${skills.length} free skills with domains\n`);

  // Step 2: Fetch content for each skill, extract endpoints
  console.log(`[2] Fetching skill content and extracting endpoints...`);
  interface SkillWithEndpoints {
    skill: SkillSummary;
    endpoints: { method: string; path: string; description: string }[];
    domain: string;
  }

  const skillsToTest: SkillWithEndpoints[] = [];
  const seenDomains = new Set<string>();

  for (const skill of skills) {
    if (!skill.domain || seenDomains.has(skill.domain)) continue;
    if (skillsToTest.length >= maxSites) break;

    const content = await fetchSkillContent(skill.skillId);
    if (!content?.skillMd) continue;

    const endpoints = extractEndpoints(content.skillMd);
    const getEndpoints = endpoints.filter(e => e.method === "GET");
    if (getEndpoints.length === 0) continue;

    seenDomains.add(skill.domain);
    skillsToTest.push({ skill, endpoints: getEndpoints, domain: skill.domain });
    console.log(`    ${skill.name.padEnd(25)} ${skill.domain.padEnd(35)} ${getEndpoints.length} GET endpoints`);
  }

  console.log(`\n    Testing ${skillsToTest.length} unique domains\n`);

  // Step 3: For each skill/domain, capture traffic and replay
  const allResults: {
    skill: string;
    domain: string;
    results: ReplayResult[];
    profile: HeaderProfileFile | undefined;
  }[] = [];

  for (const { skill, endpoints, domain } of skillsToTest) {
    console.log(`\n${"═".repeat(75)}`);
    console.log(`  ${skill.name} (${domain})`);
    console.log(`  Auth: ${skill.authType ?? "none"} | Downloads: ${skill.downloadCount} | Quality: ${skill.qualityScore}`);
    console.log(`${"═".repeat(75)}`);

    // Capture live traffic
    const startUrl = `https://${domain}`;
    console.log(`\n  [CAPTURE] ${startUrl}`);
    let traffic: { entries: HarEntry[]; apiEndpoints: CapturedEndpoint[] };
    try {
      traffic = await captureTraffic(domain, startUrl, 15);
    } catch (err) {
      console.log(`  SKIP: Capture failed — ${String(err).slice(0, 80)}`);
      continue;
    }

    console.log(`  Captured: ${traffic.entries.length} entries, ${traffic.apiEndpoints.length} API calls`);

    // Build header profile from captured traffic
    let profile: HeaderProfileFile | undefined;
    if (traffic.entries.length > 0) {
      const apiData = parseHar({ log: { entries: traffic.entries } }, startUrl);
      profile = apiData.headerProfile;
      if (profile) {
        const domainProfile = profile.domains[domain];
        if (domainProfile) {
          const appHeaders = Object.values(domainProfile.commonHeaders).filter(h => h.category === "app");
          console.log(`  Profile: ${domainProfile.requestCount} reqs, ${appHeaders.length} app headers`);
          for (const h of appHeaders.slice(0, 3)) {
            console.log(`    [app] ${h.name}: ${h.value.slice(0, 50)}`);
          }
        }
      }
    }

    // Select endpoints to replay — prefer ones that were actually captured
    const toReplay = traffic.apiEndpoints
      .filter(ep => ep.method === "GET" && ep.status >= 200 && ep.status < 400)
      .slice(0, 5);

    if (toReplay.length === 0) {
      console.log("  No replayable GET endpoints captured.");
      continue;
    }

    console.log(`\n  [REPLAY] ${toReplay.length} endpoints`);
    console.log(`  ${"Endpoint".padEnd(45)} | Orig | Bare  | Node  | N+Ck  | Exact`);
    console.log(`  ${"─".repeat(90)}`);

    const siteResults: ReplayResult[] = [];
    for (const ep of toReplay) {
      const result = await replayEndpoint(ep, profile);
      siteResults.push(result);

      const fmt = (r: { status: number; blocked: boolean }) => r.blocked ? "BLOCK" : `${r.status} `.slice(0, 5);
      console.log(
        `  ${result.endpoint.padEnd(45)} | ${String(result.originalStatus).padEnd(5)}` +
        `| ${fmt(result.bare).padEnd(6)}| ${fmt(result.node).padEnd(6)}` +
        `| ${fmt(result.nodeCookies).padEnd(6)}| ${fmt(result.exact)}`
      );
    }

    allResults.push({ skill: skill.name, domain, results: siteResults, profile });

    const total = siteResults.length;
    const stats = {
      bare: siteResults.filter(r => !r.bare.blocked).length,
      node: siteResults.filter(r => !r.node.blocked).length,
      nodeCk: siteResults.filter(r => !r.nodeCookies.blocked).length,
      exact: siteResults.filter(r => !r.exact.blocked).length,
    };
    console.log(`\n  Pass: bare=${stats.bare}/${total}  node=${stats.node}/${total}  node+ck=${stats.nodeCk}/${total}  exact=${stats.exact}/${total}`);
  }

  // ── Summary Report ──────────────────────────────────────────────────────

  console.log(`\n\n${"╔".padEnd(76, "═")}╗`);
  console.log(`║  BENCHMARK RESULTS                                                       ║`);
  console.log(`${"╚".padEnd(76, "═")}╝\n`);

  console.log(`  ${"Skill".padEnd(25)} | ${"Domain".padEnd(25)} | Bare  | Node  | N+Ck  | Exact`);
  console.log(`  ${"─".repeat(100)}`);

  let totalEndpoints = 0;
  const globalStats = { bare: 0, node: 0, nodeCk: 0, exact: 0 };

  for (const { skill, domain, results } of allResults) {
    const total = results.length;
    totalEndpoints += total;
    const bare = results.filter(r => !r.bare.blocked).length;
    const node = results.filter(r => !r.node.blocked).length;
    const nodeCk = results.filter(r => !r.nodeCookies.blocked).length;
    const exact = results.filter(r => !r.exact.blocked).length;
    globalStats.bare += bare;
    globalStats.node += node;
    globalStats.nodeCk += nodeCk;
    globalStats.exact += exact;

    console.log(
      `  ${skill.padEnd(25)} | ${domain.slice(0, 25).padEnd(25)} | ${`${bare}/${total}`.padEnd(6)}| ${`${node}/${total}`.padEnd(6)}| ${`${nodeCk}/${total}`.padEnd(6)}| ${`${exact}/${total}`}`
    );
  }

  console.log(`  ${"─".repeat(100)}`);
  console.log(
    `  ${"TOTAL".padEnd(25)} | ${"".padEnd(25)} | ` +
    `${`${globalStats.bare}/${totalEndpoints}`.padEnd(6)}| ` +
    `${`${globalStats.node}/${totalEndpoints}`.padEnd(6)}| ` +
    `${`${globalStats.nodeCk}/${totalEndpoints}`.padEnd(6)}| ` +
    `${`${globalStats.exact}/${totalEndpoints}`}`
  );

  // Percentages
  const pct = (n: number) => totalEndpoints > 0 ? `${Math.round(n / totalEndpoints * 100)}%` : "N/A";
  console.log(
    `  ${"RATE".padEnd(25)} | ${"".padEnd(25)} | ` +
    `${pct(globalStats.bare).padEnd(6)}| ` +
    `${pct(globalStats.node).padEnd(6)}| ` +
    `${pct(globalStats.nodeCk).padEnd(6)}| ` +
    `${pct(globalStats.exact)}`
  );

  // Improvement metrics
  const improvement = globalStats.nodeCk - globalStats.bare;
  const improvementPct = globalStats.bare > 0
    ? Math.round((improvement / globalStats.bare) * 100)
    : (improvement > 0 ? Infinity : 0);

  console.log(`\n  ┌─────────────────────────────────────────────────────────────────┐`);
  console.log(`  │ PRE-CHANGE  (bare fetch):      ${String(globalStats.bare).padStart(3)}/${totalEndpoints} endpoints unblocked (${pct(globalStats.bare)}) │`);
  console.log(`  │ POST-CHANGE (node + cookies):  ${String(globalStats.nodeCk).padStart(3)}/${totalEndpoints} endpoints unblocked (${pct(globalStats.nodeCk)}) │`);
  console.log(`  │ CEILING     (exact replay):    ${String(globalStats.exact).padStart(3)}/${totalEndpoints} endpoints unblocked (${pct(globalStats.exact)}) │`);
  console.log(`  │                                                                 │`);
  console.log(`  │ IMPROVEMENT: +${improvement} endpoints (+${improvementPct}% over baseline)          │`);
  console.log(`  │ GAP TO CEILING: ${globalStats.exact - globalStats.nodeCk} endpoints (requires execInChrome)     │`);
  console.log(`  └─────────────────────────────────────────────────────────────────┘`);

  console.log(`\n  Legend:`);
  console.log(`  - Bare:    No headers — how execViaFetch worked BEFORE header profiler`);
  console.log(`  - Node:    App-only headers from profile (no context, no cookies)`);
  console.log(`  - N+Ck:    Node headers + cookies from primeHeaders — NEW DEFAULT`);
  console.log(`  - Exact:   Original captured headers replayed — theoretical ceiling`);

  // Write JSON results for downstream processing
  const reportPath = new URL("../../docs/benchmark-results.json", import.meta.url).pathname;
  const report = {
    timestamp: new Date().toISOString(),
    totalSkillsInDB: (await fetch(`${API_BASE}/marketplace/skills?limit=1`).then(r => r.json()) as any).total,
    skillsTested: allResults.length,
    totalEndpoints: totalEndpoints,
    strategies: {
      bare: { unblocked: globalStats.bare, rate: totalEndpoints > 0 ? globalStats.bare / totalEndpoints : 0, description: "No headers (pre-change baseline)" },
      node: { unblocked: globalStats.node, rate: totalEndpoints > 0 ? globalStats.node / totalEndpoints : 0, description: "App-only headers from profile" },
      nodeCookies: { unblocked: globalStats.nodeCk, rate: totalEndpoints > 0 ? globalStats.nodeCk / totalEndpoints : 0, description: "App headers + primed cookies (new default)" },
      exact: { unblocked: globalStats.exact, rate: totalEndpoints > 0 ? globalStats.exact / totalEndpoints : 0, description: "Original captured headers (ceiling)" },
    },
    improvement: {
      absolute: improvement,
      relativePct: improvementPct,
      gapToCeiling: globalStats.exact - globalStats.nodeCk,
    },
    perSite: allResults.map(r => ({
      skill: r.skill,
      domain: r.domain,
      endpoints: r.results.length,
      bare: r.results.filter(x => !x.bare.blocked).length,
      node: r.results.filter(x => !x.node.blocked).length,
      nodeCookies: r.results.filter(x => !x.nodeCookies.blocked).length,
      exact: r.results.filter(x => !x.exact.blocked).length,
      hasProfile: !!r.profile,
    })),
  };

  await Bun.write(reportPath, JSON.stringify(report, null, 2));
  console.log(`\n  Results written to: ${reportPath}`);
}

main().catch(console.error);
