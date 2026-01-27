/**
 * Profile Capture — Network capture using Playwright with Chrome's real profile.
 *
 * Smart connection: tries CDP first (Chrome already open), falls back to
 * launching Chrome with the user's profile (Chrome must be closed).
 *
 * All cookies, sessions, extensions, and saved passwords are available.
 * Captures full request + response headers directly from Playwright events.
 */

import type { HarEntry } from "./types.js";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

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
};

/** Default Chrome profile paths by platform. */
function getDefaultChromeProfilePath(): string {
  const home = homedir();
  const plat = platform();
  if (plat === "darwin") {
    return join(home, "Library", "Application Support", "Google", "Chrome");
  }
  if (plat === "win32") {
    return join(home, "AppData", "Local", "Google", "Chrome", "User Data");
  }
  // Linux
  return join(home, ".config", "google-chrome");
}

/** Check if Chrome is running with a debug port we can connect to. */
async function findChromeDebugPort(): Promise<string | null> {
  // Try common debug ports
  for (const port of [9222, 9229, 18791]) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(1000),
      });
      if (resp.ok) {
        const data = await resp.json() as { webSocketDebuggerUrl?: string };
        return data.webSocketDebuggerUrl ?? `http://127.0.0.1:${port}`;
      }
    } catch {
      // Port not listening
    }
  }
  return null;
}

/** Check if Chrome process is running (macOS/Linux). */
async function isChromeRunning(): Promise<boolean> {
  try {
    const { execSync } = await import("node:child_process");
    execSync("pgrep -x 'Google Chrome'", { timeout: 3000, stdio: "ignore" });
    return true;
  } catch {
    try {
      const { execSync } = await import("node:child_process");
      execSync("pgrep -f 'Google Chrome'", { timeout: 3000, stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }
}

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

function toHarResult(captured: CapturedEntry[], cookies: Record<string, string>): CaptureResult {
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
  };
}

/**
 * Capture network traffic from Chrome — smart mode.
 *
 * 1. Try CDP connect (Chrome already running with debug port)
 * 2. If Chrome is running without debug port — relaunch it with debug port
 * 3. If Chrome is not running — launch with user's profile
 *
 * The user never needs to close Chrome manually.
 */
export async function captureFromChromeProfile(
  urls: string[],
  opts: {
    profilePath?: string;
    waitMs?: number;
    headless?: boolean;
  } = {},
): Promise<CaptureResult> {
  const { chromium } = await import("playwright");

  const profilePath = opts.profilePath ?? getDefaultChromeProfilePath();
  const waitMs = opts.waitMs ?? 5000;

  if (!existsSync(profilePath)) {
    throw new Error(`Chrome profile not found: ${profilePath}. Specify profilePath manually.`);
  }

  const captured: CapturedEntry[] = [];
  const pendingRequests = new Map<string, Partial<CapturedEntry>>();

  // ── Strategy 1: Try CDP connect to already-running Chrome ──
  const debugUrl = await findChromeDebugPort();
  if (debugUrl) {
    try {
      const browser = await chromium.connectOverCDP(debugUrl, { timeout: 5000 });
      const context = browser.contexts()[0];
      if (context) {
        for (const page of context.pages()) {
          attachListeners(page, captured, pendingRequests);
        }
        context.on("page", (page: any) => attachListeners(page, captured, pendingRequests));

        // Navigate to each URL in a new tab
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

        // Don't close — user's Chrome stays open
        await browser.close();
        return toHarResult(captured, cookies);
      }
    } catch {
      // CDP connect failed — try next strategy
    }
  }

  // ── Strategy 2: Chrome is running but no debug port — relaunch with it ──
  const chromeRunning = await isChromeRunning();
  if (chromeRunning) {
    // Launch a separate Chromium instance (not the user's Chrome) with a temp profile
    // that copies cookies from the user's profile. This avoids the lock issue.
    // Actually — the simplest approach: use execPath to launch Chrome with debug port.
    try {
      const { execSync } = await import("node:child_process");
      const plat = platform();

      // Kill Chrome gracefully so we can relaunch with debug port
      if (plat === "darwin") {
        execSync("osascript -e 'tell application \"Google Chrome\" to quit'", { timeout: 5000 });
      } else {
        execSync("pkill -TERM chrome", { timeout: 5000 });
      }

      // Wait for Chrome to close
      await new Promise((r) => setTimeout(r, 2000));
    } catch {
      throw new Error(
        "Chrome is running without a debug port. Close Chrome and retry, or start Chrome with: " +
        "google-chrome --remote-debugging-port=9222"
      );
    }
  }

  // ── Strategy 3: Launch Chrome with user's profile ──
  const context = await chromium.launchPersistentContext(profilePath, {
    channel: "chrome",
    headless: opts.headless ?? false,
    timeout: 15_000,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--remote-debugging-port=9222",
    ],
    ignoreDefaultArgs: ["--enable-automation"],
  });

  for (const page of context.pages()) {
    attachListeners(page, captured, pendingRequests);
  }
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

  await context.close();
  return toHarResult(captured, cookies);
}

/**
 * Capture by connecting to an already-running Chrome via CDP.
 *
 * Chrome must be started with --remote-debugging-port=9222.
 * This mode doesn't require closing Chrome first.
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

  for (const page of context.pages()) {
    attachListeners(page, captured, pendingRequests);
  }
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
  return toHarResult(captured, cookies);
}
