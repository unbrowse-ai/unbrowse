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
  const harEntries: HarEntry[] = captured.map((entry) => ({
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
    requestCount: captured.length,
    entries: captured,
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
  } = {},
): Promise<CaptureResult> {
  const { chromium } = await import("playwright");
  const waitMs = opts.waitMs ?? 5000;
  const browserPort = opts.browserPort ?? 18791;

  const captured: CapturedEntry[] = [];
  const pendingRequests = new Map<string, Partial<CapturedEntry>>();

  // ── Strategy 1: Connect to clawdbot's managed browser ──
  let browser = await tryCdpConnect(chromium, browserPort);
  if (browser) {
    const context = browser.contexts()[0];
    if (context) {
      for (const page of context.pages()) attachListeners(page, captured, pendingRequests);
      context.on("page", (page: any) => attachListeners(page, captured, pendingRequests));

      for (const url of urls) {
        const page = await context.newPage();
        attachListeners(page, captured, pendingRequests);
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
      return toHarResult(captured, cookies, "clawdbot-browser");
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

        for (const url of urls) {
          const page = await context.newPage();
          attachListeners(page, captured, pendingRequests);
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
        return toHarResult(captured, cookies, "chrome-cdp");
      }
    }
  }

  // ── Strategy 3: Launch fresh Playwright Chromium ──
  // No real Chrome profile (Chrome blocks --remote-debugging-port with default profile).
  // This works for public pages. For authenticated pages, use unbrowse_login first.
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

  const browserCookies = await context.cookies();
  const cookies: Record<string, string> = {};
  for (const c of browserCookies) cookies[c.name] = c.value;

  await browser.close();
  return toHarResult(captured, cookies, "playwright");
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
