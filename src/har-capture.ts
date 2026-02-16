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

import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
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
  /** Connect to existing CDP browser (e.g. OpenClaw on port 18800) */
  cdpEndpoint?: string;
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

  let cdpMode = false;
  let collectedEntries: HarEntry[] = [];

  // CDP endpoint mode: connect to existing browser (e.g., OpenClaw)
  if (opts.cdpEndpoint) {
    browser = await chromium.connectOverCDP(opts.cdpEndpoint);
    // Use first existing context (has all the cookies/session)
    const contexts = browser.contexts();
    if (contexts.length === 0) {
      throw new Error(`CDP browser at ${opts.cdpEndpoint} has no contexts`);
    }
    context = contexts[0];
    cdpMode = true;
  } else if (opts.userDataDir) {
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

  // Inject cookies if provided.
  // Use leading-dot domain so cookies apply to both www.example.com and
  // .example.com, and set secure + httpOnly + sameSite=None to match
  // real session cookies (e.g. li_at on LinkedIn).
  if (opts.cookies && Object.keys(opts.cookies).length > 0) {
    const cookiesToSet: Array<{
      name: string; value: string; domain: string; path: string;
      secure?: boolean; httpOnly?: boolean; sameSite?: "None" | "Lax" | "Strict";
    }> = [];
    const seenDomains = new Set<string>();
    for (const url of urls) {
      try {
        const parsed = new URL(url);
        // Use root domain with leading dot so cookies cover all subdomains
        const host = parsed.hostname;
        const rootDomain = host.replace(/^www\./, "");
        const dotDomain = rootDomain.startsWith(".") ? rootDomain : `.${rootDomain}`;
        if (seenDomains.has(dotDomain)) continue;
        seenDomains.add(dotDomain);

        for (const [name, value] of Object.entries(opts.cookies)) {
          cookiesToSet.push({
            name,
            value,
            domain: dotDomain,
            path: "/",
            secure: true,
            httpOnly: true,
            sameSite: "None",
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

  // For CDP mode, set up manual request/response capture since recordHar doesn't work
  if (cdpMode) {
    context.on("request", (req) => {
      const entry: Partial<HarEntry> = {
        request: {
          method: req.method(),
          url: req.url(),
          headers: Object.fromEntries(req.headersArray().map(h => [h.name, h.value])),
          postData: req.postData() ?? undefined,
        },
        _id: (req as any)._guid ?? randomUUID(),
        _startTime: Date.now(),
      };
      // Store temporarily, will update with response
      (req as any).__harEntry = entry;
    });

    context.on("response", async (res) => {
      const req = res.request();
      const entry = (req as any).__harEntry as Partial<HarEntry> | undefined;
      if (!entry) return;

      try {
        const body = await res.body().catch(() => Buffer.from(""));
        const headers = await res.allHeaders().catch(() => ({}));

        entry.response = {
          status: res.status(),
          statusText: res.statusText(),
          headers,
          content: {
            text: body.toString("utf-8").slice(0, 100_000), // Limit size
            size: body.length,
            mimeType: res.headers()["content-type"]?.split(";")[0] ?? "application/octet-stream",
          },
        };
        entry.time = Date.now() - (entry._startTime ?? Date.now());

        collectedEntries.push(entry as HarEntry);
      } catch {
        // Ignore errors in response handling
      }
    });
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
      // Scroll to trigger lazy-loaded content and GraphQL calls
      try {
        await page.evaluate(() => {
          return new Promise<void>((resolve) => {
            let scrollCount = 0;
            const maxScrolls = 3;
            const interval = setInterval(() => {
              window.scrollBy(0, window.innerHeight);
              scrollCount++;
              if (scrollCount >= maxScrolls || (window.innerHeight + window.scrollY) >= document.body.scrollHeight) {
                clearInterval(interval);
                resolve();
              }
            }, 800);
          });
        });
      } catch {
        // Scroll errors are non-fatal (e.g. JSON endpoints have no DOM)
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

    // Read the HAR file (for non-CDP modes)
    let har: { log: { entries: HarEntry[] } } = { log: { entries: [] } };
    if (!cdpMode && existsSync(harPath)) {
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

    // In CDP mode, use manually collected entries
    if (cdpMode && collectedEntries.length > 0) {
      har = { log: { entries: collectedEntries } };
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
      method: cdpMode ? "playwright-cdp" : "playwright-har",
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
