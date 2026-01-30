/**
 * Profile Capture — Network capture using OpenClaw's browser control API.
 *
 * Uses the browser control HTTP server (port 18791) which wraps Playwright's
 * network capture. Works with both `openclaw` (managed browser) and `chrome`
 * (extension relay) profiles.
 *
 * Browser control API (port 18791):
 *   POST /tabs/open         — open URL in new tab
 *   POST /navigate          — navigate current tab to URL
 *   GET  /requests          — captured network requests (includes headers)
 *   GET  /requests?clear=true — clear buffer after reading
 *   GET  /cookies           — all cookies from the browser
 *   POST /start             — start browser if not running
 *
 * Fallback: If OpenClaw browser is unavailable, launches fresh Playwright.
 */

import type { HarEntry } from "./types.js";
import type { CrawlResult } from "./site-crawler.js";

const DEFAULT_PORT = 18791;

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

/** Shape returned by OpenClaw's GET /requests endpoint. */
interface BrowserRequestEntry {
  id: string;
  timestamp: string;
  method: string;
  url: string;
  resourceType: string;
  status?: number;
  headers?: Record<string, string>;
  responseHeaders?: Record<string, string>;
}

/** Check if OpenClaw browser is available and start it if needed. */
async function ensureBrowserRunning(port: number): Promise<boolean> {
  try {
    const statusResp = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!statusResp.ok) return false;
    const status = await statusResp.json() as { running?: boolean };

    if (!status.running) {
      const startResp = await fetch(`http://127.0.0.1:${port}/start`, {
        method: "POST",
        signal: AbortSignal.timeout(10000),
      });
      if (!startResp.ok) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Open a URL in a new tab via OpenClaw browser API. */
async function openTab(url: string, port: number): Promise<string | null> {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/tabs/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(30000),
    });
    if (!resp.ok) return null;
    const data = await resp.json() as { targetId?: string };
    return data.targetId ?? null;
  } catch {
    return null;
  }
}

/** Navigate existing tab to URL. */
async function navigate(url: string, port: number): Promise<boolean> {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/navigate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(30000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

/** Fetch captured requests from OpenClaw browser. */
async function fetchRequests(port: number, clear = false): Promise<BrowserRequestEntry[]> {
  try {
    const url = new URL(`http://127.0.0.1:${port}/requests`);
    if (clear) url.searchParams.set("clear", "true");

    const resp = await fetch(url.toString(), {
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return [];

    const data = await resp.json() as { requests?: BrowserRequestEntry[] };
    return data.requests ?? [];
  } catch {
    return [];
  }
}

/** Fetch cookies from OpenClaw browser. */
async function fetchCookies(port: number): Promise<Record<string, string>> {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/cookies`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return {};

    const data = await resp.json() as { cookies?: Array<{ name: string; value: string }> };
    const cookies: Record<string, string> = {};
    for (const c of data.cookies ?? []) {
      cookies[c.name] = c.value;
    }
    return cookies;
  } catch {
    return {};
  }
}

/** Close a tab by targetId. */
async function closeTab(targetId: string, port: number): Promise<void> {
  try {
    await fetch(`http://127.0.0.1:${port}/tabs/${targetId}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // Ignore close errors
  }
}

/** Filter requests to API calls only. */
function filterApiRequests(entries: BrowserRequestEntry[]): CapturedEntry[] {
  return entries
    .filter((entry) => {
      const rt = entry.resourceType?.toLowerCase();
      if (rt === "xhr" || rt === "fetch") return true;
      if (entry.method !== "GET") return true;
      const ct = entry.responseHeaders?.["content-type"] ?? "";
      if (ct.includes("application/json") || ct.includes("application/xml") || ct.includes("text/xml")) return true;
      return false;
    })
    .map((entry) => ({
      method: entry.method,
      url: entry.url,
      headers: entry.headers ?? {},
      resourceType: entry.resourceType,
      status: entry.status ?? 0,
      responseHeaders: entry.responseHeaders ?? {},
      timestamp: entry.timestamp ? new Date(entry.timestamp).getTime() : Date.now(),
    }));
}

/** Convert captured entries to HAR format. */
function toHarResult(captured: CapturedEntry[], cookies: Record<string, string>, method: string): CaptureResult {
  const harEntries: HarEntry[] = captured.map((entry) => ({
    request: {
      method: entry.method,
      url: entry.url,
      headers: Object.entries(entry.headers).map(([name, value]) => ({ name, value })),
      cookies: Object.entries(cookies).map(([name, value]) => ({ name, value })),
    },
    response: {
      status: entry.status,
      headers: Object.entries(entry.responseHeaders).map(([name, value]) => ({ name, value })),
    },
    time: entry.timestamp,
  }));

  return {
    har: { log: { entries: harEntries } },
    cookies,
    requestCount: captured.length,
    entries: captured,
    method,
  };
}

/**
 * Capture network traffic using OpenClaw's browser API.
 * Requires OpenClaw browser to be running (no local Playwright fallback).
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
  const waitMs = opts.waitMs ?? 5000;
  const browserPort = opts.browserPort ?? DEFAULT_PORT;
  const shouldCrawl = opts.crawl !== false;

  // Try OpenClaw browser first
  if (await ensureBrowserRunning(browserPort)) {
    // Clear any existing captured requests
    await fetchRequests(browserPort, true);

    const openedTabs: string[] = [];

    // Open each URL in a new tab
    for (const url of urls) {
      const targetId = await openTab(url, browserPort);
      if (targetId) {
        openedTabs.push(targetId);
        // Wait for page to load and make API calls
        await new Promise(r => setTimeout(r, waitMs));
      }
    }

    // Optional crawl using Playwright CDP connection
    let crawlResult: CrawlResult | undefined;
    if (shouldCrawl && urls[0]) {
      try {
        const { chromium } = await import("playwright");
        // Connect to OpenClaw's CDP
        const browser = await chromium.connectOverCDP(`http://127.0.0.1:${browserPort}`, { timeout: 5000 });
        const context = browser.contexts()[0];
        if (context) {
          const page = context.pages()[0];
          if (page) {
            const { crawlSite } = await import("./site-crawler.js");
            crawlResult = await crawlSite(page, context, urls[0], {
              maxPages: opts.crawlOptions?.maxPages ?? 15,
              maxTimeMs: opts.crawlOptions?.maxTimeMs ?? 60_000,
              maxDepth: opts.crawlOptions?.maxDepth ?? 2,
              discoverOpenApi: opts.crawlOptions?.discoverOpenApi ?? true,
            });
          }
        }
        await browser.close();
      } catch {
        // Crawl is optional, continue without it
      }
    }

    // Fetch captured requests and cookies
    const [rawRequests, cookies] = await Promise.all([
      fetchRequests(browserPort),
      fetchCookies(browserPort),
    ]);

    // Close opened tabs
    for (const targetId of openedTabs) {
      await closeTab(targetId, browserPort);
    }

    const captured = filterApiRequests(rawRequests);
    const result = toHarResult(captured, cookies, "openclaw-api");
    result.crawlResult = crawlResult;
    return result;
  }

  // No fallback - require OpenClaw browser
  throw new Error(
    "OpenClaw browser not available. Start it with: openclaw browser start"
  );
}

/**
 * Capture by connecting to an already-running Chrome via CDP.
 * @deprecated Use captureFromChromeProfile which handles this automatically
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

  const attachListeners = (page: any) => {
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
  };

  for (const page of context.pages()) attachListeners(page);
  context.on("page", attachListeners);

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

  const apiCaptured = captured.filter((entry) => {
    const rt = entry.resourceType?.toLowerCase();
    if (rt === "xhr" || rt === "fetch") return true;
    if (entry.method !== "GET") return true;
    const ct = entry.responseHeaders?.["content-type"] ?? "";
    if (ct.includes("application/json") || ct.includes("application/xml") || ct.includes("text/xml")) return true;
    return false;
  });

  return toHarResult(apiCaptured, cookies, "chrome-cdp-direct");
}
