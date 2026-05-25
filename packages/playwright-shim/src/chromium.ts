/**
 * `chromium` export — drop-in for `import { chromium } from 'playwright'`.
 *
 * The launch() returns a fake Browser whose pages route every goto() through
 * Unbrowse's resolve+execute. Cache hit → synthesized Response. Cache miss →
 * fall through to the real `playwright` chromium if it's installed (optional
 * peer dep); otherwise throw with a clear message.
 *
 * Stateless on hits, opaque to callers. The agent UX north-star "two tool
 * calls is the contract" maps here as: every goto IS resolve+execute under
 * the hood. The caller doesn't see those two calls — they see page.goto().
 */
import * as types from './types.js';
import { resolve, execute } from './unbrowse-client.js';

const UNBROWSE_INTENT_HINT = process.env.UNBROWSE_INTENT_HINT || '';

type RealPlaywright = typeof import('playwright');

async function tryRealPlaywright(): Promise<RealPlaywright | null> {
  try {
    return (await import('playwright')) as unknown as RealPlaywright;
  } catch {
    return null;
  }
}

function inferIntentFromContext(url: string): string {
  if (UNBROWSE_INTENT_HINT) return UNBROWSE_INTENT_HINT;
  // Cheap heuristic: take the second-to-last path segment as a hint.
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length === 0) return `fetch homepage of ${u.hostname}`;
    return `fetch ${parts.slice(-2).join(' ')} from ${u.hostname}`;
  } catch {
    return 'fetch resource';
  }
}

function synthesizeResponse(url: string, body: unknown): types.Response {
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
  const bodyBuf = Buffer.from(bodyStr, 'utf-8');
  return {
    url: () => url,
    status: () => 200,
    statusText: () => 'OK',
    headers: () => ({
      'content-type': typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/json',
      'x-unbrowse-source': 'marketplace-cache',
    }),
    ok: () => true,
    body: async () => bodyBuf,
    text: async () => bodyStr,
    json: async () => (typeof body === 'object' ? body : JSON.parse(bodyStr)),
  };
}

class ShimPage implements types.Page {
  private currentUrl = 'about:blank';
  private currentBody: string | unknown | null = null;
  private fallbackPage: types.Page | null = null;

  constructor(private context: ShimContext, fallbackPage?: types.Page) {
    if (fallbackPage) this.fallbackPage = fallbackPage;
  }

  url(): string {
    return this.fallbackPage ? this.fallbackPage.url() : this.currentUrl;
  }

  async goto(url: string, options?: types.GotoOptions): Promise<types.Response | null> {
    if (this.fallbackPage) return this.fallbackPage.goto(url, options);

    const intent = inferIntentFromContext(url);
    const resolved = await resolve(url, intent);

    if (resolved && (resolved.status === 'ok' || resolved.available_operations?.length || resolved.available_endpoints?.length)) {
      const candidates =
        resolved.available_operations ?? resolved.available_endpoints ?? [];
      if (candidates.length > 0) {
        const top = candidates[0];
        const exec = await execute(top.endpoint_id, {}, { raw: true });
        if (exec.ok && exec.body !== undefined) {
          this.currentUrl = url;
          this.currentBody = exec.body;
          return synthesizeResponse(url, exec.body);
        }
      }
    }

    // Fall through: spin up real playwright if available.
    const real = await tryRealPlaywright();
    if (!real) {
      throw new Error(
        `[@unbrowse/playwright-shim] no cached route for ${url} and playwright is not installed. ` +
        `Either capture this URL once via 'unbrowse' CLI (then it'll be cached), or install playwright as a fallback: npm i playwright`,
      );
    }
    const realBrowser = await this.context.ensureRealBrowser(real);
    const realCtx = await realBrowser.newContext();
    const realPage = await realCtx.newPage();
    this.fallbackPage = realPage as unknown as types.Page;
    return this.fallbackPage.goto(url, options);
  }

  async content(): Promise<string> {
    if (this.fallbackPage) return this.fallbackPage.content();
    if (this.currentBody === null) return '';
    return typeof this.currentBody === 'string'
      ? this.currentBody
      : JSON.stringify(this.currentBody);
  }

  async title(): Promise<string> {
    if (this.fallbackPage) return this.fallbackPage.title();
    if (typeof this.currentBody === 'string') {
      const m = this.currentBody.match(/<title[^>]*>([^<]+)<\/title>/i);
      return m ? m[1].trim() : '';
    }
    return '';
  }

  async click(selector: string, options?: types.ClickOptions): Promise<void> {
    if (this.fallbackPage) return this.fallbackPage.click(selector, options);
    throw new Error(
      `[@unbrowse/playwright-shim] page.click() requires a live browser. ` +
      `Marketplace-cache pages are synthesized text; install playwright to use click on a fallback session.`,
    );
  }

  async fill(selector: string, value: string, options?: types.FillOptions): Promise<void> {
    if (this.fallbackPage) return this.fallbackPage.fill(selector, value, options);
    throw new Error('[@unbrowse/playwright-shim] page.fill() requires a live browser');
  }

  async type(selector: string, text: string, options?: { delay?: number; noWaitAfter?: boolean; timeout?: number }): Promise<void> {
    if (this.fallbackPage) return this.fallbackPage.type(selector, text, options);
    throw new Error('[@unbrowse/playwright-shim] page.type() requires a live browser');
  }

  async evaluate<T = unknown>(pageFunction: string | ((...args: any[]) => T), arg?: any): Promise<T> {
    if (this.fallbackPage) return this.fallbackPage.evaluate(pageFunction, arg);
    // Best-effort: if it's a simple `() => document.title` we can serve from
    // our cached body. For anything non-trivial, require fallback.
    if (typeof pageFunction === 'string' && pageFunction.includes('document.title')) {
      return (await this.title()) as unknown as T;
    }
    throw new Error(
      `[@unbrowse/playwright-shim] page.evaluate() requires a live browser for non-trivial functions. ` +
      `Install playwright for the fallback path.`,
    );
  }

  async screenshot(options?: types.ScreenshotOptions): Promise<Buffer> {
    if (this.fallbackPage) return this.fallbackPage.screenshot(options);
    throw new Error('[@unbrowse/playwright-shim] page.screenshot() requires a live browser');
  }

  async waitForSelector(selector: string, options?: { timeout?: number; state?: 'attached' | 'detached' | 'visible' | 'hidden' }): Promise<unknown> {
    if (this.fallbackPage) return this.fallbackPage.waitForSelector(selector, options);
    return null;
  }

  async waitForLoadState(state?: 'load' | 'domcontentloaded' | 'networkidle'): Promise<void> {
    if (this.fallbackPage) return this.fallbackPage.waitForLoadState(state);
  }

  async close(): Promise<void> {
    if (this.fallbackPage) await this.fallbackPage.close();
  }
}

class ShimContext implements types.BrowserContext {
  private _pages: ShimPage[] = [];
  private realBrowser: any = null;
  constructor(private browser: ShimBrowser) {}

  async newPage(): Promise<types.Page> {
    const p = new ShimPage(this);
    this._pages.push(p);
    return p;
  }

  pages(): types.Page[] {
    return this._pages;
  }

  async ensureRealBrowser(real: RealPlaywright): Promise<any> {
    if (this.realBrowser) return this.realBrowser;
    this.realBrowser = await real.chromium.launch();
    return this.realBrowser;
  }

  async close(): Promise<void> {
    for (const p of this._pages) await p.close();
    if (this.realBrowser) await this.realBrowser.close();
  }

  async cookies(): Promise<any[]> {
    return [];
  }
  async addCookies(): Promise<void> {}
}

class ShimBrowser implements types.Browser {
  private _contexts: ShimContext[] = [];

  async newContext(options?: types.BrowserContextOptions): Promise<types.BrowserContext> {
    const ctx = new ShimContext(this);
    this._contexts.push(ctx);
    return ctx;
  }

  async newPage(options?: types.BrowserContextOptions): Promise<types.Page> {
    const ctx = await this.newContext(options);
    return ctx.newPage();
  }

  contexts(): types.BrowserContext[] {
    return this._contexts;
  }

  isConnected(): boolean {
    return true;
  }

  version(): string {
    return 'unbrowse-shim-7.0.0';
  }

  async close(): Promise<void> {
    for (const c of this._contexts) await c.close();
  }
}

export const chromium: types.BrowserType = {
  name: () => 'chromium' as const,
  executablePath(): string {
    return '/unbrowse/shim/chromium';
  },
  async launch(options?: types.LaunchOptions): Promise<types.Browser> {
    return new ShimBrowser();
  },
  async connectOverCDP(wsEndpoint: string, options?: { timeout?: number }): Promise<types.Browser> {
    const real = await tryRealPlaywright();
    if (!real) {
      throw new Error(
        `[@unbrowse/playwright-shim] connectOverCDP requires playwright to be installed for CDP transport.`,
      );
    }
    return real.chromium.connectOverCDP(wsEndpoint, options) as unknown as types.Browser;
  },
};

export default chromium;
