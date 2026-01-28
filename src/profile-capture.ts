/**
 * Profile Capture — Network capture using Playwright.
 *
 * Smart connection cascade:
 *   1. CDP connect to clawdbot's managed browser (port 18791) — already has cookies
 *   2. CDP connect to Chrome with --remote-debugging-port (if user started it that way)
 *   3. Launch fresh Chromium via Playwright — works for public pages or with unbrowse_login auth
 *
 * Note: Chrome's real profile + --remote-debugging-port don't work together
 * (Chrome blocks it). For authenticated sessions, use unbrowse_login instead.
 */

import type { HarEntry } from "./types.js";
import type { CrawlResult, OpenApiSpec } from "./site-crawler.js";

/** Captured request with full headers. */
interface CapturedEntry {
  method: string;
  url: string;
  headers: Record<string, string>;
  resourceType: string;
  status: number;
  responseHeaders: Record<string, string>;
  timestamp: number;
}

type CaptureResult = {
  har: { log: { entries: HarEntry[] } };
  cookies: Record<string, string>;
  requestCount: number;
  entries: CapturedEntry[];
  method: string;
  crawlResult?: CrawlResult;
};

function attachListeners(
  page: any,
  captured: CapturedEntry[],
  pendingRequests: Map<string, Partial<CapturedEntry>>,
) {
  page.on("request", (req: any) => {
    pendingRequests.set(req.url() + req.method(), {
      method: req.method(),
      url: req.url(),
      headers: req.headers(),
      resourceType: req.resourceType(),
      timestamp: Date.now(),
    });
  });

  page.on("response", (resp: any) => {
    const req = resp.request();
    const key = req.url() + req.method();
    const entry = pendingRequests.get(key);
    if (entry) {
      entry.status = resp.status();
      entry.responseHeaders = resp.headers();
      captured.push(entry as CapturedEntry);
      pendingRequests.delete(key);
    }
  });
}

function toHarResult(captured: CapturedEntry[], cookies: Record<string, string>, method: string): CaptureResult {
  // Filter to only XHR/Fetch requests — skip document, stylesheet, script, image, etc.
  // These are the actual API calls, not page navigation or static resources.
  const apiCaptured = captured.filter((entry) => {
    const rt = entry.resourceType?.toLowerCase();
    if (rt === "xhr" || rt === "fetch") return true;
    // Also keep non-GET requests (POST/PUT/DELETE are always API calls)
    if (entry.method !== "GET") return true;
    // For GET requests without a resource type, check the response content-type
    const ct = entry.responseHeaders?.["content-type"] ?? "";
    if (ct.includes("application/json") || ct.includes("application/xml") || ct.includes("text/xml")) return true;
    return false;
  });

  const harEntries: HarEntry[] = apiCaptured.map((entry) => ({
    request: {
      method: entry.method,
      url: entry.url,
      headers: Object.entries(entry.headers).map(([name, value]) => ({ name, value })),
      cookies: Object.entries(cookies).map(([name, value]) => ({ name, value })),
    },
    response: {
      status: entry.status,
      headers: Object.entries(entry.responseHeaders ?? {}).map(([name, value]) => ({ name, value })),
    },
    time: entry.timestamp,
  }));

  return {
    har: { log: { entries: harEntries } },
    cookies,
    requestCount: apiCaptured.length,
    entries: apiCaptured,
    method,
  };
}

/** Try to connect to a CDP endpoint. Returns null if unavailable. */
async function tryCdpConnect(chromium: any, port: number): Promise<any | null> {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!resp.ok) return null;
    const data = await resp.json() as { webSocketDebuggerUrl?: string };
    const wsUrl = data.webSocketDebuggerUrl ?? `http://127.0.0.1:${port}`;
    const browser = await chromium.connectOverCDP(wsUrl, { timeout: 5000 });
    return browser;
  } catch {
    return null;
  }
}

/**
 * Capture network traffic — smart cascade.
 *
 * 1. Try clawdbot managed browser (CDP port 18791)
 * 2. Try Chrome with remote debugging (CDP port 9222)
 * 3. Launch fresh Playwright Chromium (no profile — works for public pages)
 */
export async function captureFromChromeProfile(
  urls: string[],
  opts: {
    profilePath?: string;
    waitMs?: number;
    headless?: boolean;
    browserPort?: number;
    crawl?: boolean;
    crawlOptions?: {
      maxPages?: number;
      maxTimeMs?: number;
      maxDepth?: number;
      discoverOpenApi?: boolean;
    };
  } = {},
): Promise<CaptureResult> {
  const { chromium } = await import("playwright");
  const waitMs = opts.waitMs ?? 5000;
  const browserPort = opts.browserPort ?? 18791;
  const shouldCrawl = opts.crawl !== false;

  const captured: CapturedEntry[] = [];
  const pendingRequests = new Map<string, Partial<CapturedEntry>>();

  // Helper: crawl after visiting seed URLs (reuses the page with listeners already attached)
  async function maybeCrawl(page: any, context: any): Promise<CrawlResult | undefined> {
    if (!shouldCrawl || !urls[0]) return undefined;
    const { crawlSite } = await import("./site-crawler.js");
    return crawlSite(page, context, urls[0], {
      maxPages: opts.crawlOptions?.maxPages ?? 15,
      maxTimeMs: opts.crawlOptions?.maxTimeMs ?? 60_000,
      maxDepth: opts.crawlOptions?.maxDepth ?? 2,
      discoverOpenApi: opts.crawlOptions?.discoverOpenApi ?? true,
    });
  }

  // ── Strategy 1: Connect to clawdbot's managed browser ──
  let browser = await tryCdpConnect(chromium, browserPort);
  if (browser) {
    const context = browser.contexts()[0];
    if (context) {
      for (const page of context.pages()) attachListeners(page, captured, pendingRequests);
      context.on("page", (page: any) => attachListeners(page, captured, pendingRequests));

      let lastPage: any;
      for (const url of urls) {
        lastPage = await context.newPage();
        attachListeners(lastPage, captured, pendingRequests);
        try {
          await lastPage.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
        } catch {
          await lastPage.waitForTimeout(waitMs);
        }
        await lastPage.waitForTimeout(waitMs);
      }

      const crawlResult = lastPage ? await maybeCrawl(lastPage, context) : undefined;

      const browserCookies = await context.cookies();
      const cookies: Record<string, string> = {};
      for (const c of browserCookies) cookies[c.name] = c.value;

      await browser.close();
      const result = toHarResult(captured, cookies, "clawdbot-browser");
      result.crawlResult = crawlResult;
      return result;
    }
  }

  // ── Strategy 2: Connect to Chrome with remote debug port ──
  for (const port of [9222, 9229]) {
    browser = await tryCdpConnect(chromium, port);
    if (browser) {
      const context = browser.contexts()[0];
      if (context) {
        for (const page of context.pages()) attachListeners(page, captured, pendingRequests);
        context.on("page", (page: any) => attachListeners(page, captured, pendingRequests));

        let lastPage: any;
        for (const url of urls) {
          lastPage = await context.newPage();
          attachListeners(lastPage, captured, pendingRequests);
          try {
            await lastPage.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
          } catch {
            await lastPage.waitForTimeout(waitMs);
          }
          await lastPage.waitForTimeout(waitMs);
        }

        const crawlResult = lastPage ? await maybeCrawl(lastPage, context) : undefined;

        const browserCookies = await context.cookies();
        const cookies: Record<string, string> = {};
        for (const c of browserCookies) cookies[c.name] = c.value;

        await browser.close();
        const result = toHarResult(captured, cookies, "chrome-cdp");
        result.crawlResult = crawlResult;
        return result;
      }
    }
  }

  // ── Strategy 3: Launch fresh Playwright Chromium ──
  browser = await chromium.launch({
    headless: opts.headless ?? true,
    timeout: 15_000,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
    ],
  });

  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });

  const page = await context.newPage();
  attachListeners(page, captured, pendingRequests);

  for (const url of urls) {
    try {
      await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
    } catch {
      await page.waitForTimeout(waitMs);
    }
    await page.waitForTimeout(waitMs);
  }

  const crawlResult = await maybeCrawl(page, context);

  const browserCookies = await context.cookies();
  const cookies: Record<string, string> = {};
  for (const c of browserCookies) cookies[c.name] = c.value;

  await browser.close();
  const result = toHarResult(captured, cookies, "playwright");
  result.crawlResult = crawlResult;
  return result;
}

/**
 * Capture by connecting to an already-running Chrome via CDP.
 */
export async function captureFromChromeDebug(
  urls: string[],
  opts: {
    cdpUrl?: string;
    waitMs?: number;
  } = {},
): Promise<CaptureResult> {
  const { chromium } = await import("playwright");
  const cdpUrl = opts.cdpUrl ?? "http://127.0.0.1:9222";
  const waitMs = opts.waitMs ?? 5000;

  const captured: CapturedEntry[] = [];
  const pendingRequests = new Map<string, Partial<CapturedEntry>>();

  const browser = await chromium.connectOverCDP(cdpUrl);
  const context = browser.contexts()[0];
  if (!context) {
    throw new Error("No browser context found. Is Chrome running with --remote-debugging-port?");
  }

  for (const page of context.pages()) attachListeners(page, captured, pendingRequests);
  context.on("page", (page: any) => attachListeners(page, captured, pendingRequests));

  for (const url of urls) {
    const page = context.pages()[0] ?? await context.newPage();
    try {
      await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
    } catch {
      await page.waitForTimeout(waitMs);
    }
    await page.waitForTimeout(waitMs);
  }

  const browserCookies = await context.cookies();
  const cookies: Record<string, string> = {};
  for (const c of browserCookies) cookies[c.name] = c.value;

  await browser.close();
  return toHarResult(captured, cookies, "chrome-cdp-direct");
}
