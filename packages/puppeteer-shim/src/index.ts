/**
 * @unbrowse/puppeteer-shim — drop-in replacement for `puppeteer`.
 *
 *   - import puppeteer from 'puppeteer';
 *   + import puppeteer from '@unbrowse/puppeteer-shim';
 *
 *   const browser = await puppeteer.launch();
 *   const page = await browser.newPage();
 *   await page.goto('https://site.com/data');
 *   const html = await page.content();
 *   await browser.close();
 *
 * page.goto() short-circuits through Unbrowse's resolve+execute on a cache hit
 * (free synthesized response), and falls through to the real `puppeteer` (an
 * optional peer dep) on a miss — so a cost-curious scraping codebase swaps one
 * import line and pays per cached call instead of per browser-hour for any URL
 * already indexed in the marketplace. content() / title() / url() / $eval-style
 * title reads are served from the cached body; anything needing a live DOM
 * (click/type/screenshot) requires the real puppeteer fallback.
 *
 * Attribution: mirrors the public surface of `puppeteer`
 * (https://github.com/puppeteer/puppeteer, Apache-2.0). On a miss it IS
 * puppeteer; this shim only lowers cost on cache hits.
 */

const DEFAULT_BASE = 'https://beta-api.unbrowse.ai';

function unbrowseBase(): string {
  return process.env.UNBROWSE_API_URL || process.env.UNBROWSE_BASE || DEFAULT_BASE;
}

function unbrowseAuth(): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  const apiKey = process.env.UNBROWSE_API_KEY;
  if (apiKey) h['authorization'] = `Bearer ${apiKey}`;
  const x402 = process.env.UNBROWSE_X_PAYMENT || process.env.X_PAYMENT;
  if (x402) h['x-payment'] = x402;
  return h;
}

async function unbrowseResolve(url: string, intent: string): Promise<any | null> {
  try {
    const res = await fetch(`${unbrowseBase()}/v1/resolve`, {
      method: 'POST',
      headers: unbrowseAuth(),
      body: JSON.stringify({ url, intent }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function unbrowseExecute(endpointId: string): Promise<any> {
  try {
    const res = await fetch(`${unbrowseBase()}/v1/execute`, {
      method: 'POST',
      headers: unbrowseAuth(),
      body: JSON.stringify({ endpoint_id: endpointId, params: {}, raw: true }),
      signal: AbortSignal.timeout(30000),
    });
    return await res.json();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function topEndpointId(resolved: any): string | null {
  const list = resolved?.available_operations || resolved?.available_endpoints || [];
  return list[0]?.endpoint_id ?? null;
}

function intentFor(url: string): string {
  if (process.env.UNBROWSE_INTENT_HINT) return process.env.UNBROWSE_INTENT_HINT;
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    return parts.length ? `fetch ${parts.slice(-2).join(' ')} from ${u.hostname}` : `fetch homepage of ${u.hostname}`;
  } catch {
    return 'fetch resource';
  }
}

export interface LaunchOptions {
  headless?: boolean | 'new' | 'shell';
  args?: string[];
  executablePath?: string;
  [k: string]: unknown;
}
export interface GoToOptions {
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2';
  timeout?: number;
  referer?: string;
}
export interface HTTPResponse {
  url(): string;
  status(): number;
  statusText(): string;
  ok(): boolean;
  headers(): Record<string, string>;
  text(): Promise<string>;
  json(): Promise<unknown>;
  buffer(): Promise<Buffer>;
}

type RealPuppeteer = typeof import('puppeteer');

async function tryRealPuppeteer(): Promise<RealPuppeteer | null> {
  try {
    return (await import('puppeteer')) as unknown as RealPuppeteer;
  } catch {
    return null;
  }
}

function synthesizeResponse(url: string, body: unknown): HTTPResponse {
  const isStr = typeof body === 'string';
  const bodyStr = isStr ? (body as string) : JSON.stringify(body);
  return {
    url: () => url,
    status: () => 200,
    statusText: () => 'OK',
    ok: () => true,
    headers: () => ({
      'content-type': isStr ? 'text/html; charset=utf-8' : 'application/json',
      'x-unbrowse-source': 'marketplace-cache',
    }),
    text: async () => bodyStr,
    json: async () => (isStr ? JSON.parse(bodyStr) : body),
    buffer: async () => Buffer.from(bodyStr, 'utf-8'),
  };
}

class ShimPage {
  private currentUrl = 'about:blank';
  private currentBody: unknown = null;
  private fallbackPage: any = null;

  constructor(private browser: ShimBrowser) {}

  url(): string {
    return this.fallbackPage ? this.fallbackPage.url() : this.currentUrl;
  }

  async goto(url: string, options?: GoToOptions): Promise<HTTPResponse | null> {
    if (this.fallbackPage) return this.fallbackPage.goto(url, options);

    const resolved = await unbrowseResolve(url, intentFor(url));
    const endpointId = topEndpointId(resolved);
    if (endpointId) {
      const exec = await unbrowseExecute(endpointId);
      if (exec?.ok && exec.body !== undefined) {
        this.currentUrl = url;
        this.currentBody = exec.body;
        return synthesizeResponse(url, exec.body);
      }
    }

    const real = await tryRealPuppeteer();
    if (!real) {
      throw new Error(
        `[@unbrowse/puppeteer-shim] no cached route for ${url} and puppeteer is not installed. ` +
        `Capture this URL once via the 'unbrowse' CLI (then it's cached), or install puppeteer as a fallback: npm i puppeteer`,
      );
    }
    const realBrowser = await this.browser.ensureRealBrowser(real);
    this.fallbackPage = await realBrowser.newPage();
    return this.fallbackPage.goto(url, options);
  }

  async content(): Promise<string> {
    if (this.fallbackPage) return this.fallbackPage.content();
    if (this.currentBody === null) return '';
    return typeof this.currentBody === 'string' ? (this.currentBody as string) : JSON.stringify(this.currentBody);
  }

  async title(): Promise<string> {
    if (this.fallbackPage) return this.fallbackPage.title();
    if (typeof this.currentBody === 'string') {
      const m = this.currentBody.match(/<title[^>]*>([^<]+)<\/title>/i);
      return m ? m[1].trim() : '';
    }
    return '';
  }

  async evaluate<T = unknown>(fn: string | ((...a: any[]) => T), ...args: any[]): Promise<T> {
    if (this.fallbackPage) return this.fallbackPage.evaluate(fn, ...args);
    const src = typeof fn === 'string' ? fn : fn.toString();
    if (src.includes('document.title')) return (await this.title()) as unknown as T;
    if (src.includes('documentElement.outerHTML') || src.includes('document.body.innerHTML')) {
      return (await this.content()) as unknown as T;
    }
    throw new Error('[@unbrowse/puppeteer-shim] page.evaluate() needs a live DOM for non-trivial functions — install puppeteer for fallback.');
  }

  async click(): Promise<void> {
    if (this.fallbackPage) return this.fallbackPage.click(...arguments);
    throw new Error('[@unbrowse/puppeteer-shim] page.click() requires a live browser — install puppeteer for fallback.');
  }
  async type(): Promise<void> {
    if (this.fallbackPage) return this.fallbackPage.type(...arguments);
    throw new Error('[@unbrowse/puppeteer-shim] page.type() requires a live browser — install puppeteer for fallback.');
  }
  async screenshot(): Promise<Buffer> {
    if (this.fallbackPage) return this.fallbackPage.screenshot(...arguments);
    throw new Error('[@unbrowse/puppeteer-shim] page.screenshot() requires a live browser — install puppeteer for fallback.');
  }
  async waitForSelector(): Promise<unknown> {
    if (this.fallbackPage) return this.fallbackPage.waitForSelector(...arguments);
    return null;
  }
  async setViewport(): Promise<void> {
    if (this.fallbackPage) return this.fallbackPage.setViewport(...arguments);
  }
  async close(): Promise<void> {
    if (this.fallbackPage) await this.fallbackPage.close();
  }
}

class ShimBrowser {
  private _pages: ShimPage[] = [];
  private realBrowser: any = null;

  async newPage(): Promise<ShimPage> {
    const p = new ShimPage(this);
    this._pages.push(p);
    return p;
  }
  async pages(): Promise<ShimPage[]> {
    return this._pages;
  }
  async ensureRealBrowser(real: RealPuppeteer): Promise<any> {
    if (this.realBrowser) return this.realBrowser;
    this.realBrowser = await real.launch();
    return this.realBrowser;
  }
  isConnected(): boolean {
    return true;
  }
  version(): Promise<string> {
    return Promise.resolve('unbrowse-puppeteer-shim/0.1.0');
  }
  async close(): Promise<void> {
    for (const p of this._pages) await p.close();
    if (this.realBrowser) await this.realBrowser.close();
  }
}

export async function launch(options?: LaunchOptions): Promise<ShimBrowser> {
  return new ShimBrowser();
}

export async function connect(options?: { browserWSEndpoint?: string; browserURL?: string }): Promise<any> {
  const real = await tryRealPuppeteer();
  if (!real) {
    throw new Error('[@unbrowse/puppeteer-shim] connect() requires puppeteer to be installed for the CDP transport.');
  }
  return (real as any).connect(options);
}

export function executablePath(): string {
  return '/unbrowse/shim/chromium';
}

const puppeteer = { launch, connect, executablePath };
export default puppeteer;
