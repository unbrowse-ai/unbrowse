/**
 * HAR Capture
 *
 * Modes:
 * - `playwright-har`: local browser + Playwright `recordHar` (full HAR file).
 * - `playwright-cdp`: attach to running OpenClaw browser over CDP (default :18800)
 *   and manually collect request/response events because `recordHar` is not
 *   supported on CDP-attached contexts.
 */

import { chromium, type Browser, type BrowserContext } from "playwright-core";
import { readFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { HarEntry } from "./types.js";
import type { CrawlResult } from "./site-crawler.js";
import { captureCdpNetworkTraffic } from "./cdp-ws.js";

export interface HarCaptureResult {
  har: { log: { entries: HarEntry[] } };
  cookies: Record<string, string>;
  requestCount: number;
  method: "playwright-har" | "playwright-cdp";
  crawlResult?: CrawlResult;
}

export interface HarCaptureOptions {
  /** Time to wait on each page for network activity (ms). Default: 5000 */
  waitMs?: number;
  /** Run browser in headless mode. Default: true */
  headless?: boolean;
  /** Crawl same-domain links to discover more endpoints. Default: true */
  crawl?: boolean;
  /** Crawl options */
  crawlOptions?: {
    maxPages?: number;
    maxTimeMs?: number;
    maxDepth?: number;
    discoverOpenApi?: boolean;
  };
  /** Existing cookies to inject (e.g., from prior login) */
  cookies?: Record<string, string>;
  /** Existing auth headers to inject */
  headers?: Record<string, string>;
  /** User data dir for persistent profile (optional) */
  userDataDir?: string;
  /** Attach to existing browser CDP endpoint (default auto: http://127.0.0.1:18800). Set `false` to disable. */
  cdpEndpoint?: string | false;
}

function buildCookiesForUrls(
  urls: string[],
  cookies: Record<string, string>
): Array<{ name: string; value: string; domain: string; path: string }> {
  const cookiesToSet: Array<{ name: string; value: string; domain: string; path: string }> = [];
  for (const url of urls) {
    try {
      const parsed = new URL(url);
      for (const [name, value] of Object.entries(cookies)) {
        cookiesToSet.push({
          name,
          value,
          domain: parsed.hostname,
          path: "/",
        });
      }
    } catch {
      // Invalid URL, skip
    }
  }
  return cookiesToSet;
}

/**
 * Capture API traffic using Playwright's native HAR recording.
 * Launches a fresh browser, visits URLs, and captures everything.
 */
export async function captureWithHar(
  urls: string[],
  opts: HarCaptureOptions = {}
): Promise<HarCaptureResult> {
  const requestedCdpEndpoint = opts.cdpEndpoint;
  const autoCdpEndpoint = "http://127.0.0.1:18800";
  const cdpEndpoint = typeof requestedCdpEndpoint === "string"
    ? requestedCdpEndpoint.trim()
    : requestedCdpEndpoint === false
      ? ""
      : autoCdpEndpoint;

  // Preferred for authenticated capture: attach to running OpenClaw browser.
  // If auto mode fails, fall back to local recordHar.
  if (cdpEndpoint) {
    const shouldFallbackToRecordHar = requestedCdpEndpoint === undefined;
    try {
      return await captureWithCdp(urls, { ...opts, cdpEndpoint });
    } catch (err) {
      if (!shouldFallbackToRecordHar) {
        throw err;
      }
    }
  }

  return captureWithPlaywrightHar(urls, opts);
}

async function captureWithPlaywrightHar(
  urls: string[],
  opts: HarCaptureOptions = {}
): Promise<HarCaptureResult> {
  const waitMs = opts.waitMs ?? 5000;
  const headless = opts.headless ?? true;
  const shouldCrawl = opts.crawl !== false;

  // Temp file for HAR output
  const harPath = join(tmpdir(), `unbrowse-${randomUUID()}.har`);

  let browser: Browser;
  let context: BrowserContext;

  // Launch browser with native HAR recording.
  if (opts.userDataDir) {
    // Persistent context (keeps login state).
    context = await chromium.launchPersistentContext(opts.userDataDir, {
      headless,
      recordHar: { path: harPath, mode: "full" },
    });
    browser = null as any; // No separate browser handle with persistent context
  } else {
    browser = await chromium.launch({ headless });
    context = await browser.newContext({
      recordHar: { path: harPath, mode: "full" },
      extraHTTPHeaders: opts.headers,
    });
  }

  // Inject cookies if provided.
  if (opts.cookies && Object.keys(opts.cookies).length > 0) {
    const cookiesToSet = buildCookiesForUrls(urls, opts.cookies);
    if (cookiesToSet.length > 0) {
      await context.addCookies(cookiesToSet);
    }
  }

  const page = await context.newPage();
  let crawlResult: CrawlResult | undefined;

  try {
    // Visit each URL
    for (const url of urls) {
      try {
        await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
      } catch {
        // Timeout is OK, page might have long-polling
      }
      // Extra wait for any delayed API calls
      await page.waitForTimeout(waitMs);
    }

    // Optional crawl to discover more endpoints
    if (shouldCrawl && urls[0]) {
      try {
        const { crawlSite } = await import("./site-crawler.js");
        crawlResult = await crawlSite(page, context, urls[0], {
          maxPages: opts.crawlOptions?.maxPages ?? 15,
          maxTimeMs: opts.crawlOptions?.maxTimeMs ?? 60_000,
          maxDepth: opts.crawlOptions?.maxDepth ?? 2,
          discoverOpenApi: opts.crawlOptions?.discoverOpenApi ?? true,
        });
      } catch {
        // Crawl is optional, continue without it
      }
    }
  } finally {
    // Get cookies before closing
    const browserCookies = await context.cookies();

    // Close context to flush HAR file
    await context.close();
    if (browser) {
      await browser.close();
    }

    // Read the HAR file
    let har: { log: { entries: HarEntry[] } } = { log: { entries: [] } };
    if (existsSync(harPath)) {
      try {
        const harContent = readFileSync(harPath, "utf-8");
        har = JSON.parse(harContent);
      } catch {
        // HAR parse failed
      } finally {
        // Clean up temp file
        try {
          unlinkSync(harPath);
        } catch {
          // Ignore cleanup errors
        }
      }
    }

    // Convert browser cookies to simple map
    const cookies: Record<string, string> = {};
    for (const c of browserCookies) {
      cookies[c.name] = c.value;
    }

    return {
      har,
      cookies,
      requestCount: har.log?.entries?.length ?? 0,
      method: "playwright-har",
      crawlResult,
    };
  }
}

async function captureWithCdp(
  urls: string[],
  opts: HarCaptureOptions
): Promise<HarCaptureResult> {
  const waitMs = opts.waitMs ?? 5000;
  const shouldCrawl = opts.crawl !== false;
  const cdpHttpBase = typeof opts.cdpEndpoint === "string" && opts.cdpEndpoint.trim().length > 0
    ? opts.cdpEndpoint.trim().replace(/\/$/, "")
    : "http://127.0.0.1:18800";

  const cookiesToSet = opts.cookies && Object.keys(opts.cookies).length > 0
    ? buildCookiesForUrls(urls, opts.cookies)
    : [];

  const { captured, cookies: browserCookies } = await captureCdpNetworkTraffic({
    cdpHttpBase,
    urls,
    waitMs,
    extraHeaders: opts.headers,
    cookies: cookiesToSet,
    keepTypes: new Set(["xhr", "fetch"]),
  });

  const harEntries: HarEntry[] = captured.map((entry) => ({
    request: {
      method: entry.method,
      url: entry.url,
      headers: Object.entries(entry.requestHeaders ?? {}).map(([name, value]) => ({ name, value: String(value) })),
      cookies: [],
      postData: entry.postData ? { text: entry.postData } : undefined,
    },
    response: {
      status: entry.status ?? 0,
      headers: Object.entries(entry.responseHeaders ?? {}).map(([name, value]) => ({ name, value: String(value) })),
      content: entry.responseBody != null
        ? { mimeType: entry.mimeType, text: entry.responseBody, size: entry.responseBody.length }
        : undefined,
    },
    time: entry.timestamp,
  }));

  const har = { log: { entries: harEntries } };
  const cookieArray = (browserCookies ?? []).map((c: any) => ({ name: c.name, value: c.value }));
  for (const entry of har.log.entries) entry.request.cookies = cookieArray;

  const cookies: Record<string, string> = {};
  for (const c of browserCookies as any[]) {
    if (c?.name && typeof c?.value === "string") cookies[c.name] = c.value;
  }

  // Crawl is only supported in recordHar mode (needs a Page object).
  let crawlResult: CrawlResult | undefined = undefined;
  if (shouldCrawl) {
    crawlResult = undefined;
  }

  return {
    har,
    cookies,
    requestCount: har.log.entries.length,
    method: "playwright-cdp",
    crawlResult,
  };
}

/**
 * Capture with existing auth from a skill's auth.json.
 * Loads cookies and headers from the auth file before browsing.
 */
export async function captureWithAuth(
  urls: string[],
  authPath: string,
  opts: Omit<HarCaptureOptions, "cookies" | "headers"> = {}
): Promise<HarCaptureResult> {
  let cookies: Record<string, string> = {};
  let headers: Record<string, string> = {};

  if (existsSync(authPath)) {
    try {
      const auth = JSON.parse(readFileSync(authPath, "utf-8"));
      cookies = auth.cookies ?? {};
      headers = auth.headers ?? {};
    } catch {
      // Invalid auth file
    }
  }

  return captureWithHar(urls, { ...opts, cookies, headers });
}
