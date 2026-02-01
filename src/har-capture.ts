/**
 * HAR Capture — Playwright-native HAR recording with full headers.
 *
 * Uses Playwright's built-in `recordHar` option which captures complete
 * request/response headers, cookies, timing, and content. No patches needed.
 *
 * This is the preferred capture method as it gets FULL headers including:
 * - Authorization headers (Bearer tokens, API keys)
 * - Cookies (auto-attached by browser)
 * - CSRF tokens
 * - All auto-added headers (User-Agent, Origin, etc.)
 */

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { readFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { HarEntry } from "./types.js";
import type { CrawlResult } from "./site-crawler.js";

export interface HarCaptureResult {
  har: { log: { entries: HarEntry[] } };
  cookies: Record<string, string>;
  requestCount: number;
  method: "playwright-har";
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
}

/**
 * Capture API traffic using Playwright's native HAR recording.
 * Launches a fresh browser, visits URLs, and captures everything.
 */
export async function captureWithHar(
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

  // Launch browser
  if (opts.userDataDir) {
    // Persistent context (keeps login state)
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

  // Inject cookies if provided
  if (opts.cookies && Object.keys(opts.cookies).length > 0) {
    const cookiesToSet = [];
    for (const url of urls) {
      try {
        const parsed = new URL(url);
        for (const [name, value] of Object.entries(opts.cookies)) {
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
