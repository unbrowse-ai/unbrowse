type Logger = { info: (msg: string) => void; warn: (msg: string) => void };

export type BrowserSession = {
  browser: any;
  context: any;
  page: any;
  service: string;
  lastUsed: Date;
  method: "playwright-persistent";
};

/**
 * Playwright-only browser session manager.
 *
 * Uses a single persistent Playwright context (profile dir) and a per-service tab map.
 * This avoids OpenClaw's extension browser entirely.
 */
export function createBrowserSessionManager(opts: {
  logger: Logger;
  /**
   * Deprecated. Kept for backwards-compat in the plugin constructor signature,
   * but unused in the Playwright-only build.
   */
  browserPort: number;
  playwright?: {
    channel?: string;
    headless?: boolean;
    userDataDir?: string;
    executablePath?: string;
  };
  sessionTtlMs?: number;
}) {
  const { logger } = opts;
  const sessionTtlMs = opts.sessionTtlMs ?? 5 * 60 * 1000;

  let sharedContext: any = null;
  let launching: Promise<any> | null = null;
  const browserSessions = new Map<string, BrowserSession>();

  async function ensureContext(): Promise<any> {
    if (sharedContext) return sharedContext;
    if (launching) return launching;

    launching = (async () => {
      let chromium: any;
      try {
        ({ chromium } = await import("playwright-core"));
      } catch {
        throw new Error("PLAYWRIGHT_MISSING");
      }

      const { join } = await import("node:path");
      const { homedir } = await import("node:os");

      const userDataDir =
        (opts.playwright?.userDataDir && String(opts.playwright.userDataDir).trim()) ||
        join(homedir(), ".openclaw", "unbrowse", "playwright-profile");

      const channel = opts.playwright?.channel && String(opts.playwright.channel).trim()
        ? String(opts.playwright.channel).trim()
        : "chrome";

      const headless = Boolean(opts.playwright?.headless);
      const executablePath = opts.playwright?.executablePath && String(opts.playwright.executablePath).trim()
        ? String(opts.playwright.executablePath).trim()
        : undefined;

      sharedContext = await chromium.launchPersistentContext(userDataDir, {
        headless,
        channel: executablePath ? undefined : channel,
        executablePath,
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      });

      logger.info(
        `[unbrowse] Playwright persistent context ready (channel=${executablePath ? "executablePath" : channel}, headless=${headless})`,
      );
      return sharedContext;
    })();

    try {
      return await launching;
    } finally {
      launching = null;
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

    const context = await ensureContext();

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
    const browser = context.browser?.() ?? null;
    const session: BrowserSession = {
      browser,
      context,
      page,
      service,
      lastUsed: new Date(),
      method: "playwright-persistent",
    };
    browserSessions.set(service, session);
    logger.info(`[unbrowse] Created tab for ${service} in Playwright persistent context`);
    return session;
  }

  async function closeChrome(): Promise<boolean> {
    // Legacy API; kept so core tool deps shape stays stable.
    return false;
  }

  async function cleanupAllSessions() {
    for (const [service, session] of browserSessions) {
      try {
        await session.page?.close();
      } catch { /* ignore */ }
      browserSessions.delete(service);
    }

    if (sharedContext) {
      try {
        await sharedContext.close();
        logger.info("[unbrowse] Closed Playwright persistent context");
      } catch { /* ignore */ }
      sharedContext = null;
    }
  }

  return {
    browserSessions,
    getOrCreateBrowserSession,
    getSharedBrowser: () => (sharedContext?.browser?.() ?? null),
    closeChrome,
    cleanupAllSessions,
  };
}

