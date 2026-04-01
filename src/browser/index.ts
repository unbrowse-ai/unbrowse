import * as kuri from "../kuri/client.js";
import { resolveAndExecute } from "../orchestrator/index.js";
import { UnbrowseResponse, type BrowserLaunchOptions, type GotoOptions, type SkillResolutionResult } from "./types.js";
import type { SkillManifest } from "../types/index.js";

/**
 * Infer a search intent from a URL's path and query params.
 * e.g. "https://github.com/search?q=react" → "search react on github.com"
 */
function inferIntentFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const pathSegments = u.pathname.split("/").filter(Boolean);
    const query = u.searchParams.get("q") ?? u.searchParams.get("query") ?? u.searchParams.get("search") ?? "";
    const action = pathSegments[pathSegments.length - 1] ?? "browse";
    const parts = [action];
    if (query) parts.push(query);
    parts.push("on", u.hostname);
    return parts.join(" ");
  } catch {
    return `browse ${url}`;
  }
}

export class Page {
  private _tabId: string | null = null;
  private _url: string = "about:blank";
  private _skillResult: SkillResolutionResult | null = null;
  private _html: string | null = null;
  private _closed = false;
  private _defaultIntent?: string;

  /** @internal */
  constructor(tabId: string | null, defaultIntent?: string) {
    this._tabId = tabId;
    this._defaultIntent = defaultIntent;
  }

  /**
   * Navigate to a URL. Checks skill cache first — if a cached skill exists,
   * returns the skill result without opening a browser tab.
   */
  async goto(url: string, options?: GotoOptions): Promise<UnbrowseResponse> {
    this._url = url;
    this._skillResult = null;
    this._html = null;

    const intent = options?.intent ?? this._defaultIntent ?? inferIntentFromUrl(url);
    const domain = new URL(url).hostname;

    try {
      const result = await resolveAndExecute(
        intent,
        {},
        { url, domain },
        undefined,
        { intent },
      );

      if (result.trace.success && result.result) {
        this._skillResult = {
          skill: result.skill,
          trace: result.trace,
          result: result.result,
          source: result.source ?? "unknown",
        };

        return new UnbrowseResponse({
          status: 200,
          headers: { "content-type": "application/json", "x-unbrowse-source": String(result.source ?? "skill") },
          url,
          body: result.result,
        });
      }
    } catch {
      // Resolve failed — fall through to kuri navigation
    }

    // Cache miss or resolve failure — navigate via kuri.
    // resolveAndExecute already runs the full capture pipeline (marketplace lookup,
    // first-pass browser action, live capture + indexing) as its last resort.
    // This fallback only fires when that entire pipeline fails, so we keep it
    // lightweight: navigate, grab HTML, and return.
    if (this._tabId) {
      await kuri.navigate(this._tabId, url);
      const finalUrl = await kuri.getCurrentUrl(this._tabId).catch(() => url);
      if (typeof finalUrl === "string" && finalUrl.startsWith("http")) {
        this._url = finalUrl;
      }

      // Fetch HTML eagerly so content() returns useful data immediately
      try {
        const html = await kuri.getPageHtml(this._tabId);
        if (typeof html === "string" && html.startsWith("<")) {
          this._html = html;
        }
      } catch {
        // Non-fatal — content() will retry on demand
      }
    }

    return new UnbrowseResponse({
      status: 200,
      headers: { "x-unbrowse-source": "browser" },
      url: this._url,
      body: this._html ?? null,
    });
  }

  /** Get page HTML content */
  async content(): Promise<string> {
    if (this._skillResult) {
      const data = this._skillResult.result;
      return `<!DOCTYPE html><html><body><script type="application/json" id="unbrowse-data">${JSON.stringify(data)}</script></body></html>`;
    }
    if (this._tabId) {
      const html = await kuri.getPageHtml(this._tabId).catch(() => "");
      if (typeof html === "string" && html.startsWith("<")) {
        this._html = html;
        return html;
      }
    }
    return this._html ?? "";
  }

  /** Get current URL */
  url(): string {
    return this._url;
  }

  /** Evaluate JavaScript in page context */
  async evaluate<T = unknown>(fn: string | (() => T)): Promise<T> {
    if (!this._tabId) throw new Error("No browser tab — page resolved from skill cache");
    const script = typeof fn === "function" ? `(${fn.toString()})()` : fn;
    const result = await kuri.evaluate(this._tabId, script);
    return result as T;
  }

  /** Take a screenshot (returns base64-encoded PNG string) */
  async screenshot(): Promise<string> {
    if (!this._tabId) throw new Error("No browser tab — page resolved from skill cache");
    return await kuri.screenshot(this._tabId);
  }

  /** Click an element (BROWSER-02 — uses evaluate fallback if kuri hook unavailable) */
  async click(selector: string): Promise<void> {
    if (!this._tabId) throw new Error("No browser tab — page resolved from skill cache");
    await kuri.evaluate(this._tabId, `document.querySelector(${JSON.stringify(selector)})?.click()`);
  }

  /** Fill an input (BROWSER-02 — uses evaluate fallback if kuri hook unavailable) */
  async fill(selector: string, value: string): Promise<void> {
    if (!this._tabId) throw new Error("No browser tab — page resolved from skill cache");
    await kuri.evaluate(this._tabId, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (el) { el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', {bubbles:true})); } })()`);
  }

  /** Wait for a selector to appear */
  async waitForSelector(selector: string, options?: { timeout?: number }): Promise<void> {
    if (!this._tabId) return; // No-op for skill-resolved pages
    const timeout = options?.timeout ?? 5000;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const found = await kuri.evaluate(this._tabId, `!!document.querySelector(${JSON.stringify(selector)})`);
      if (found === "true" || found === true) return;
      await new Promise(r => setTimeout(r, 200));
    }
    throw new Error(`waitForSelector: timeout waiting for ${selector}`);
  }

  /** Close this page */
  async close(): Promise<void> {
    if (this._tabId && !this._closed) {
      await kuri.closeTab(this._tabId).catch(() => {});
      this._closed = true;
    }
  }

  /** Access raw unbrowse skill data (non-Playwright extension) */
  get $unbrowse(): SkillResolutionResult | null {
    return this._skillResult;
  }
}

export class Browser {
  private _pages: Page[] = [];
  private _defaultIntent?: string;
  private _started = false;

  private constructor(options?: BrowserLaunchOptions) {
    this._defaultIntent = options?.intent;
  }

  /** Launch a new browser instance */
  static async launch(options?: BrowserLaunchOptions): Promise<Browser> {
    const browser = new Browser(options);
    await kuri.start().catch(() => {});
    browser._started = true;
    return browser;
  }

  /** Create a new page (tab) */
  async newPage(): Promise<Page> {
    let tabId: string | null = null;
    try {
      tabId = await kuri.newTab();
    } catch {
      // kuri may not be available — Page works without a tab for skill-resolved navigation
    }
    const page = new Page(tabId, this._defaultIntent);
    this._pages.push(page);
    return page;
  }

  /** Get all open pages */
  pages(): Page[] {
    return [...this._pages];
  }

  /** Close the browser and all pages */
  async close(): Promise<void> {
    for (const page of this._pages) {
      await page.close();
    }
    this._pages = [];
    if (this._started) {
      await kuri.stop().catch(() => {});
      this._started = false;
    }
  }
}
