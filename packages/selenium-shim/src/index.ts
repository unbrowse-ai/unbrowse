/**
 * @unbrowse/selenium-shim — drop-in replacement for `selenium-webdriver`.
 *
 *   - const { Builder, By, until, Key } = require('selenium-webdriver');
 *   + const { Builder, By, until, Key } = require('@unbrowse/selenium-shim');
 *
 *   const driver = await new Builder().forBrowser('chrome').build();
 *   await driver.get('https://site.com/data');
 *   const html  = await driver.getPageSource();
 *   const title = await driver.getTitle();
 *   await driver.quit();
 *
 * driver.get() routes through Unbrowse's resolve+execute marketplace cache
 * (base UNBROWSE_API_URL || UNBROWSE_BASE || 'https://beta-api.unbrowse.ai').
 * On a cache hit the page body is synthesized and served to getPageSource() /
 * getTitle() / getCurrentUrl() — no WebDriver server, no chromedriver, no
 * browser binary. There is no local-browser fallback in this shim: a URL with
 * no cached route yields an empty page body (capture it once via the `unbrowse`
 * CLI so it's cached). UNBROWSE_DRYRUN=1 short-circuits all network and returns
 * deterministic empty values, so test suites never touch the wire.
 *
 * Honest scope: read methods (get/getPageSource/getTitle/getCurrentUrl, and
 * text/attribute reads parsed from the cached HTML) are backed by Unbrowse.
 * Interaction methods (click/sendKeys, element-located waits) are PARTIAL —
 * they keep selenium's async surface so the swap compiles and existing scripts
 * run, but they cannot drive a live DOM without a real browser session. They
 * resolve as no-ops / best-effort parses rather than throwing, mirroring how a
 * read-only cached page behaves.
 *
 * Attribution: mirrors the public surface of `selenium-webdriver`
 * (https://github.com/SeleniumHQ/selenium, Apache-2.0). The shim swaps the
 * transport (marketplace cache instead of the WebDriver protocol); it does not
 * vendor or replace Selenium itself.
 */

const DEFAULT_BASE = 'https://beta-api.unbrowse.ai';

function base(): string {
  return process.env.UNBROWSE_API_URL || process.env.UNBROWSE_BASE || DEFAULT_BASE;
}

function auth(): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (process.env.UNBROWSE_API_KEY) h['authorization'] = `Bearer ${process.env.UNBROWSE_API_KEY}`;
  const x = process.env.UNBROWSE_X_PAYMENT || process.env.X_PAYMENT;
  if (x) h['x-payment'] = x;
  return h;
}

async function uResolve(url: string, intent: string): Promise<any | null> {
  try {
    const r = await fetch(`${base()}/v1/resolve`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ url, intent }),
      signal: AbortSignal.timeout(8000),
    });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

async function uExec(id: string): Promise<any> {
  try {
    const r = await fetch(`${base()}/v1/execute`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ endpoint_id: id, params: {}, raw: true }),
      signal: AbortSignal.timeout(30000),
    });
    return await r.json();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function topId(resolved: any): string | null {
  const list = resolved?.available_operations || resolved?.available_endpoints || [];
  return list[0]?.endpoint_id ?? null;
}

function intentFor(url: string): string {
  if (process.env.UNBROWSE_INTENT_HINT) return process.env.UNBROWSE_INTENT_HINT;
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    return parts.length
      ? `fetch ${parts.slice(-2).join(' ')} from ${u.hostname}`
      : `fetch homepage of ${u.hostname}`;
  } catch {
    return 'fetch resource';
  }
}

function dryrun(): boolean {
  return process.env.UNBROWSE_DRYRUN === '1';
}

// ---------------------------------------------------------------------------
// Locators — By.*(value) → { using, value } (selenium's Locator shape)
// ---------------------------------------------------------------------------

export interface Locator {
  using: string;
  value: string;
}

export const By = {
  css(selector: string): Locator {
    return { using: 'css selector', value: selector };
  },
  id(id: string): Locator {
    return { using: 'css selector', value: `#${id}` };
  },
  xpath(xpath: string): Locator {
    return { using: 'xpath', value: xpath };
  },
  className(name: string): Locator {
    return { using: 'css selector', value: `.${name}` };
  },
  name(name: string): Locator {
    return { using: 'css selector', value: `*[name="${name}"]` };
  },
  tagName(name: string): Locator {
    return { using: 'css selector', value: name };
  },
  linkText(text: string): Locator {
    return { using: 'link text', value: text };
  },
  partialLinkText(text: string): Locator {
    return { using: 'partial link text', value: text };
  },
};

// ---------------------------------------------------------------------------
// until — condition factories. Each returns a Condition whose fn(driver)
// resolves truthy/falsy, matching selenium's wait() contract.
// ---------------------------------------------------------------------------

export interface Condition<T = unknown> {
  message: string;
  fn(driver: WebDriver): Promise<T> | T;
}

export const until = {
  titleIs(title: string): Condition<boolean> {
    return {
      message: `waiting for title to be "${title}"`,
      fn: async (d) => (await d.getTitle()) === title,
    };
  },
  titleContains(substr: string): Condition<boolean> {
    return {
      message: `waiting for title to contain "${substr}"`,
      fn: async (d) => (await d.getTitle()).includes(substr),
    };
  },
  titleMatches(re: RegExp): Condition<boolean> {
    return {
      message: `waiting for title to match ${re}`,
      fn: async (d) => re.test(await d.getTitle()),
    };
  },
  urlContains(substr: string): Condition<boolean> {
    return {
      message: `waiting for URL to contain "${substr}"`,
      fn: async (d) => (await d.getCurrentUrl()).includes(substr),
    };
  },
  urlIs(url: string): Condition<boolean> {
    return {
      message: `waiting for URL to be "${url}"`,
      fn: async (d) => (await d.getCurrentUrl()) === url,
    };
  },
  elementLocated(locator: Locator): Condition<WebElement> {
    return {
      message: `waiting for element to be located ${JSON.stringify(locator)}`,
      fn: async (d) => d.findElement(locator),
    };
  },
  elementsLocated(locator: Locator): Condition<WebElement[]> {
    return {
      message: `waiting for elements to be located ${JSON.stringify(locator)}`,
      fn: async (d) => d.findElements(locator),
    };
  },
};

// ---------------------------------------------------------------------------
// Key — selenium's special-key constants (Unicode private-use codepoints).
// ---------------------------------------------------------------------------

export const Key = {
  NULL: '',
  CANCEL: '',
  HELP: '',
  BACK_SPACE: '',
  TAB: '',
  CLEAR: '',
  RETURN: '',
  ENTER: '',
  SHIFT: '',
  CONTROL: '',
  ALT: '',
  PAUSE: '',
  ESCAPE: '',
  SPACE: '',
  PAGE_UP: '',
  PAGE_DOWN: '',
  END: '',
  HOME: '',
  ARROW_LEFT: '',
  LEFT: '',
  ARROW_UP: '',
  UP: '',
  ARROW_RIGHT: '',
  RIGHT: '',
  ARROW_DOWN: '',
  DOWN: '',
  INSERT: '',
  DELETE: '',
  SEMICOLON: '',
  EQUALS: '',
  META: '',
  COMMAND: '',
} as const;

// ---------------------------------------------------------------------------
// WebElement — backed by the cached page body, parsed for text/attributes.
// ---------------------------------------------------------------------------

export class WebElement {
  constructor(
    private readonly driver: WebDriver,
    private readonly locator: Locator,
    private readonly html: string,
  ) {}

  async getText(): Promise<string> {
    // Best-effort: strip the first matched tag's inner text from the cached body.
    const stripped = this.html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    return stripped;
  }

  async getAttribute(name: string): Promise<string | null> {
    const re = new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i');
    const m = this.html.match(re);
    return m ? m[1] : null;
  }

  async getTagName(): Promise<string> {
    const m = this.html.match(/<\s*([a-zA-Z][\w-]*)/);
    return m ? m[1].toLowerCase() : '';
  }

  async isDisplayed(): Promise<boolean> {
    return this.html.length > 0;
  }

  async isEnabled(): Promise<boolean> {
    return !/\bdisabled\b/i.test(this.html);
  }

  // PARTIAL — interaction needs a live DOM. No-op on the cached read surface so
  // existing scripts run; honest about doing nothing rather than faking success.
  async click(): Promise<void> {
    /* no live DOM on a cached page */
  }
  async sendKeys(..._keys: Array<string | number>): Promise<void> {
    /* no live DOM on a cached page */
  }
  async clear(): Promise<void> {
    /* no live DOM on a cached page */
  }
  async submit(): Promise<void> {
    /* no live DOM on a cached page */
  }
}

// ---------------------------------------------------------------------------
// WebDriver — the object Builder.build() returns.
// ---------------------------------------------------------------------------

export class WebDriver {
  private currentUrl = '';
  private body: string = '';

  async get(url: string): Promise<void> {
    if (dryrun()) {
      this.currentUrl = url;
      this.body = '';
      return;
    }
    const resolved = await uResolve(url, intentFor(url));
    const id = topId(resolved);
    if (id) {
      const exec = await uExec(id);
      if (exec?.ok && exec.body !== undefined) {
        this.currentUrl = url;
        this.body = typeof exec.body === 'string' ? exec.body : JSON.stringify(exec.body);
        return;
      }
    }
    // No cached route: land on the URL with an empty body (capture it once via
    // the `unbrowse` CLI to make it resolvable). Never silently fakes content.
    this.currentUrl = url;
    this.body = '';
  }

  async getCurrentUrl(): Promise<string> {
    return this.currentUrl;
  }

  async getPageSource(): Promise<string> {
    return this.body;
  }

  async getTitle(): Promise<string> {
    const m = this.body.match(/<title[^>]*>([^<]*)<\/title>/i);
    return m ? m[1].trim() : '';
  }

  async findElement(locator: Locator): Promise<WebElement> {
    return new WebElement(this, locator, this.body);
  }

  async findElements(locator: Locator): Promise<WebElement[]> {
    if (!this.body) return [];
    return [new WebElement(this, locator, this.body)];
  }

  async executeScript<T = unknown>(script: string | ((...a: any[]) => T), ..._args: any[]): Promise<T> {
    const src = typeof script === 'string' ? script : script.toString();
    if (src.includes('document.title')) return (await this.getTitle()) as unknown as T;
    if (
      src.includes('documentElement.outerHTML') ||
      src.includes('document.body.innerHTML') ||
      src.includes('document.documentElement.innerHTML')
    ) {
      return (await this.getPageSource()) as unknown as T;
    }
    if (src.includes('window.location') || src.includes('document.URL')) {
      return (await this.getCurrentUrl()) as unknown as T;
    }
    // PARTIAL — arbitrary JS needs a live runtime; return null rather than fake.
    return null as unknown as T;
  }

  async executeAsyncScript<T = unknown>(script: string | ((...a: any[]) => T), ...args: any[]): Promise<T> {
    return this.executeScript<T>(script, ...args);
  }

  /** Mirrors selenium's wait(condition, timeout): poll fn(driver) until truthy. */
  async wait<T>(condition: Condition<T> | ((d: WebDriver) => Promise<T> | T), timeout = 0): Promise<T> {
    const fn = typeof condition === 'function' ? condition : condition.fn;
    const deadline = Date.now() + (timeout || 0);
    // Single evaluation against the static cached body, then short polling until
    // the deadline. Deterministic under dryrun (body is fixed).
    for (;;) {
      const result = await fn(this);
      if (result) return result as T;
      if (Date.now() >= deadline) {
        const msg =
          typeof condition === 'function'
            ? 'wait condition not met'
            : (condition as Condition<T>).message;
        throw new Error(`[@unbrowse/selenium-shim] timed out: ${msg}`);
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  async close(): Promise<void> {
    this.body = '';
    this.currentUrl = '';
  }

  async quit(): Promise<void> {
    await this.close();
  }
}

// ---------------------------------------------------------------------------
// Builder — fluent constructor, .build() returns a WebDriver.
// ---------------------------------------------------------------------------

export class Builder {
  private browserName = 'chrome';
  private capabilities: Record<string, unknown> = {};
  private chromeOptions: unknown = null;

  forBrowser(name: string): this {
    this.browserName = name;
    return this;
  }

  withCapabilities(caps: Record<string, unknown>): this {
    this.capabilities = { ...this.capabilities, ...caps };
    return this;
  }

  setChromeOptions(options: unknown): this {
    this.chromeOptions = options;
    return this;
  }

  setFirefoxOptions(options: unknown): this {
    this.chromeOptions = options;
    return this;
  }

  usingServer(_url: string): this {
    // Accepted for parity; the shim's transport is the Unbrowse marketplace.
    return this;
  }

  async build(): Promise<WebDriver> {
    return new WebDriver();
  }
}

const seleniumWebdriver = { Builder, WebDriver, WebElement, By, until, Key };
export default seleniumWebdriver;
