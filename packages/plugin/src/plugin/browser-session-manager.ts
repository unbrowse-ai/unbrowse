type Logger = { info: (msg: string) => void; warn: (msg: string) => void };

export type BrowserSession = {
  browser: any;
  context: any;
  page: any;
  service: string;
  lastUsed: Date;
  method: "cdp-openclaw" | "cdp-chrome";
};

/**
 * Browser session manager
 *
 * Provides a single shared browser (CDP cascade) and a per-service tab map.
 * Tools call `getOrCreateBrowserSession` to reuse tabs and preserve logged-in state.
 */
export function createBrowserSessionManager(opts: {
  logger: Logger;
  browserPort: number;
  sessionTtlMs?: number;
}) {
  const { logger, browserPort } = opts;
  const sessionTtlMs = opts.sessionTtlMs ?? 5 * 60 * 1000;

  let sharedBrowser: any = null;
  let sharedContext: any = null;
  let sharedBrowserMethod: "cdp-openclaw" | "cdp-chrome" = "cdp-openclaw";
  const browserSessions = new Map<string, BrowserSession>();

  async function tryCdpConnect(chromium: any, port: number): Promise<any | null> {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(2000),
      });
      if (!resp.ok) return null;
      const data = await resp.json() as { webSocketDebuggerUrl?: string };
      const wsUrl = data.webSocketDebuggerUrl ?? `http://127.0.0.1:${port}`;
      const browser = await chromium.connectOverCDP(wsUrl, { timeout: 5000 });
      logger.info(`[unbrowse] Connected to CDP at port ${port}`);
      return browser;
    } catch {
      return null;
    }
  }

  async function closeChrome(): Promise<boolean> {
    try {
      const { spawnSync } = await import("node:child_process");
      spawnSync("osascript", ["-e", 'tell application "Google Chrome" to quit'], { timeout: 5000 });
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 500));
        const psResult = spawnSync("pgrep", ["-x", "Google Chrome"], { encoding: "utf-8" });
        if (!psResult.stdout.trim()) {
          logger.info(`[unbrowse] Chrome closed successfully`);
          return true;
        }
      }
      spawnSync("pkill", ["-x", "Google Chrome"], { timeout: 2000 });
      logger.info(`[unbrowse] Chrome force-killed`);
      return true;
    } catch (err) {
      logger.warn(`[unbrowse] Failed to close Chrome: ${(err as Error).message}`);
      return false;
    }
  }

  function cleanupStaleSessions() {
    const now = Date.now();
    for (const [key, session] of browserSessions) {
      if (now - session.lastUsed.getTime() > sessionTtlMs) {
        session.page?.close().catch(() => {});
        browserSessions.delete(key);
        logger.info(`[unbrowse] Closed stale tab for ${key}`);
      }
    }
  }

  async function getOrCreateBrowserSession(
    service: string,
    url: string,
    authCookies: Record<string, string>,
    authHeaders: Record<string, string>,
  ): Promise<BrowserSession> {
    cleanupStaleSessions();

    const existing = browserSessions.get(service);
    if (existing) {
      existing.lastUsed = new Date();
      try {
        await existing.page.evaluate(() => true);
        return existing;
      } catch {
        browserSessions.delete(service);
      }
    }

    let chromium: any;
    try {
      ({ chromium } = await import("playwright-core"));
    } catch {
      // Should not be fatal for the whole agent; caller can fall back to node/backend execution.
      throw new Error("PLAYWRIGHT_MISSING");
    }

    if (sharedBrowser) {
      try {
        const contexts = sharedBrowser.contexts();
        if (contexts.length === 0) throw new Error("No contexts");
      } catch {
        sharedBrowser = null;
        sharedContext = null;
      }
    }

    if (!sharedBrowser) {
      // Prefer OpenClaw-managed Chrome profile first (preserves logins via ~/.openclaw/browser/openclaw).
      sharedBrowser = await tryCdpConnect(chromium, 18800);
      sharedBrowserMethod = "cdp-openclaw";

      if (!sharedBrowser) {
        // "chrome" relay profile (requires the OpenClaw Chrome extension to be attached).
        sharedBrowser = await tryCdpConnect(chromium, 18792);
        sharedBrowserMethod = "cdp-chrome";
      }

      if (!sharedBrowser) {
        // Legacy/local Chrome debugging ports.
        for (const port of [browserPort, 9222, 9229]) {
          sharedBrowser = await tryCdpConnect(chromium, port);
          if (sharedBrowser) {
            sharedBrowserMethod = port === browserPort ? "cdp-openclaw" : "cdp-chrome";
            break;
          }
        }
      }

      if (!sharedBrowser) {
        throw new Error("NO_BROWSER");
      }
    }

    let context = sharedContext;
    if (!context) {
      context = sharedBrowser.contexts()[0];
    }
    if (!context) {
      context = await sharedBrowser.newContext({
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      });
    }

    sharedContext = context;

    if (Object.keys(authCookies).length > 0) {
      try {
        const domain = new URL(url).hostname;
        const cookieObjects = Object.entries(authCookies).map(([name, value]) => ({
          name,
          value,
          domain,
          path: "/",
        }));
        await context.addCookies(cookieObjects);
      } catch { /* non-critical */ }
    }

    if (Object.keys(authHeaders).length > 0) {
      try {
        await context.setExtraHTTPHeaders(authHeaders);
      } catch { /* non-critical */ }
    }

    const page = await context.newPage();
    const session: BrowserSession = {
      browser: sharedBrowser,
      context,
      page,
      service,
      lastUsed: new Date(),
      method: sharedBrowserMethod,
    };
    browserSessions.set(service, session);
    logger.info(`[unbrowse] Created tab for ${service} in shared browser (${sharedBrowserMethod})`);
    return session;
  }

  async function cleanupAllSessions() {
    if (sharedBrowser) {
      try {
        if (sharedContext) await sharedContext.close();
        await sharedBrowser.close();
        logger.info("[unbrowse] Closed shared browser");
      } catch { /* ignore */ }
      sharedBrowser = null;
      sharedContext = null;
    }

    for (const [service, session] of browserSessions) {
      try {
        if (session.context) await session.context.close();
        if (session.browser) await session.browser.close();
        logger.info(`[unbrowse] Closed browser session: ${service}`);
      } catch { /* ignore */ }
    }
    browserSessions.clear();
  }

  return {
    browserSessions,
    getOrCreateBrowserSession,
    getSharedBrowser: () => sharedBrowser,
    closeChrome,
    cleanupAllSessions,
  };
}
