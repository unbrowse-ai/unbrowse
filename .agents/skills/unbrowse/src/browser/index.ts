import * as kuri from "../kuri/client.js";
import type { KuriHarEntry } from "../kuri/client.js";
import { resolveAndExecute } from "../orchestrator/index.js";
import { generateLocalDescription } from "../orchestrator/index.js";
import { extractEndpoints, extractAuthHeaders } from "../reverse-engineer/index.js";
import type { RawRequest } from "../capture/index.js";
import { queueBackgroundIndex } from "../indexer/index.js";
import { mergeEndpoints } from "../marketplace/index.js";
import { buildSkillOperationGraph } from "../graph/index.js";
import { augmentEndpointsWithAgent } from "../graph/agent-augment.js";
import { findExistingSkillForDomain, cachePublishedSkill } from "../client/index.js";
import { storeCredential } from "../vault/index.js";
import { UnbrowseResponse, type BrowserLaunchOptions, type GotoOptions, type SkillResolutionResult } from "./types.js";
import type { SkillManifest } from "../types/index.js";
import { nanoid } from "nanoid";

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

/** Require a live browser tab, throw if page resolved from skill cache */
function requireTab(tabId: string | null): string {
  if (!tabId) throw new Error("No browser tab — page resolved from skill cache. Call goto() with a URL that requires browser interaction.");
  return tabId;
}

/** Convert Kuri HAR entries to RawRequest format for extractEndpoints */
function harEntriesToRawRequests(entries: KuriHarEntry[]): RawRequest[] {
  return entries
    .filter(e => e.request && e.response)
    .map(e => ({
      url: e.request.url,
      method: e.request.method,
      request_headers: Object.fromEntries(
        (e.request.headers ?? []).map(h => [h.name.toLowerCase(), h.value])
      ),
      request_body: e.request.postData?.text,
      response_status: e.response.status,
      response_headers: Object.fromEntries(
        (e.response.headers ?? []).map(h => [h.name.toLowerCase(), h.value])
      ),
      response_body: e.response.content?.text,
      timestamp: e.startedDateTime ?? new Date().toISOString(),
    }));
}

/** Process captured HAR entries into routes and queue for background indexing */
/** Full passive indexing pipeline — same enrichment as explicit capture */
function passiveIndexHar(entries: KuriHarEntry[], pageUrl: string): void {
  if (entries.length === 0) return;
  const requests = harEntriesToRawRequests(entries);
  if (requests.length === 0) return;

  let domain: string;
  try { domain = new URL(pageUrl).hostname; } catch { return; }
  const intent = `browse ${domain}`;

  void (async () => {
    try {
      const rawEndpoints = extractEndpoints(requests, undefined, { pageUrl, finalUrl: pageUrl });
      if (rawEndpoints.length === 0) return;

      // Store auth credentials
      const capturedAuthHeaders = extractAuthHeaders(requests);
      if (Object.keys(capturedAuthHeaders).length > 0) {
        await storeCredential(`${domain}-session`, JSON.stringify({ headers: capturedAuthHeaders }));
      }

      // Merge with existing skill (never reduce endpoint count)
      const existingSkill = findExistingSkillForDomain(domain, intent);
      const mergedEndpoints = existingSkill
        ? mergeEndpoints(existingSkill.endpoints, rawEndpoints)
        : rawEndpoints;
      if (existingSkill && mergedEndpoints.length < existingSkill.endpoints.length) {
        console.log(`[passive-index] ${domain}: skipping — would reduce endpoints`);
        return;
      }

      // Generate descriptions
      for (const ep of mergedEndpoints) {
        if (!ep.description) ep.description = generateLocalDescription(ep);
      }

      // No LLM augmentation — the calling agent IS the LLM
      const enrichedEndpoints = mergedEndpoints;

      // Build operation graph
      const operationGraph = buildSkillOperationGraph(enrichedEndpoints);

      const skill: SkillManifest = {
        skill_id: existingSkill?.skill_id ?? nanoid(),
        version: "1.0.0",
        schema_version: "1",
        lifecycle: "active" as const,
        execution_type: "http" as const,
        created_at: existingSkill?.created_at ?? new Date().toISOString(),
        updated_at: new Date().toISOString(),
        name: domain,
        intent_signature: intent,
        domain,
        description: `API skill for ${domain}`,
        owner_type: "agent" as const,
        endpoints: enrichedEndpoints,
        operation_graph: operationGraph,
        intents: Array.from(new Set([...(existingSkill?.intents ?? []), intent])),
      };

      try { cachePublishedSkill(skill); } catch { /* best-effort */ }
      queueBackgroundIndex({ skill, domain, intent, contextUrl: pageUrl, cacheKey: `passive:${domain}:${Date.now()}` });
      console.log(`[passive-index] ${domain}: ${enrichedEndpoints.length} endpoints indexed`);
    } catch (err) {
      console.error(`[passive-index] ${domain} failed: ${err instanceof Error ? err.message : err}`);
    }
  })();
}


/**
 * Page — Kuri browser tab with Unbrowse acceleration.
 *
 * Kuri is the primary browser primitive. Every method proxies directly to
 * Kuri's CDP-based HTTP API. The one exception is goto(): Unbrowse
 * transparently checks the skill cache and shared route graph first,
 * returning structured API data in <200ms when a cached route exists.
 * On cache miss, goto() falls through to Kuri navigation and captures
 * traffic in the background for future acceleration.
 */
export class Page {
  private _tabId: string | null = null;
  private _url: string = "about:blank";
  private _skillResult: SkillResolutionResult | null = null;
  private _html: string | null = null;
  private _closed = false;
  private _defaultIntent?: string;
  private _harActive = false;

  /** @internal */
  constructor(tabId: string | null, defaultIntent?: string) {
    this._tabId = tabId;
    this._defaultIntent = defaultIntent;
    // Start passive HAR recording so all network traffic is captured
    if (tabId) {
      kuri.harStart(tabId).then(() => { this._harActive = true; }).catch(() => {});
    }
  }

  /** Whether this page has a live browser tab (vs skill-cache-only) */
  get hasTab(): boolean { return this._tabId !== null; }

  /** The raw Kuri tab ID, for direct kuri API calls */
  get tabId(): string | null { return this._tabId; }

  // ── Navigation ──────────────────────────────────────────────────────

  /**
   * Navigate to a URL. Unbrowse transparently checks skill cache first —
   * if a cached route exists, returns structured API data without opening
   * a browser tab. On cache miss, navigates via Kuri and captures traffic
   * in the background for future acceleration.
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

    // Cache miss or resolve failure — navigate via Kuri directly.
    if (this._tabId) {
      const newDomain = new URL(url).hostname.replace(/^www\./, "");
      const oldDomain = this._url !== "about:blank" ? (() => { try { return new URL(this._url).hostname.replace(/^www\./, ""); } catch { return ""; } })() : "";

      // Flush any prior HAR entries before navigating to a new page
      if (this._harActive && this._url !== "about:blank") {
        try {
          const { entries } = await kuri.harStop(this._tabId);
          passiveIndexHar(entries, this._url);
        } catch { /* non-fatal */ }
        this._harActive = false;
      }

      // Auto-save auth profile for old domain, load for new domain
      if (oldDomain && oldDomain !== newDomain) {
        await kuri.authProfileSave(this._tabId, oldDomain).catch(() => {});
      }
      if (newDomain && newDomain !== oldDomain) {
        await kuri.authProfileLoad(this._tabId, newDomain).catch(() => {});
      }

      await kuri.navigate(this._tabId, url);
      const finalUrl = await kuri.getCurrentUrl(this._tabId).catch(() => url);
      if (typeof finalUrl === "string" && finalUrl.startsWith("http")) {
        this._url = finalUrl;
      }

      // Restart HAR recording for the new page
      if (!this._harActive) {
        kuri.harStart(this._tabId).then(() => { this._harActive = true; }).catch(() => {});
      }

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

  /** Navigate back */
  async goBack(): Promise<void> {
    await kuri.goBack(requireTab(this._tabId));
  }

  /** Navigate forward */
  async goForward(): Promise<void> {
    await kuri.goForward(requireTab(this._tabId));
  }

  /** Reload the page */
  async reload(): Promise<void> {
    await kuri.reload(requireTab(this._tabId));
  }

  /** Get current URL */
  url(): string {
    return this._url;
  }

  // ── Content Extraction ──────────────────────────────────────────────

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

  /** Get page text content (stripped of HTML) */
  async text(): Promise<string> {
    return kuri.getText(requireTab(this._tabId));
  }

  /** Get page content as Markdown */
  async markdown(): Promise<string> {
    return kuri.getMarkdown(requireTab(this._tabId));
  }

  /** Extract all links from the page */
  async links(): Promise<unknown> {
    return kuri.getLinks(requireTab(this._tabId));
  }

  /**
   * Get accessibility tree snapshot — token-optimized for LLMs.
   * Returns elements with stable @eN refs for use with click/fill/action.
   * This is Kuri's primary observation primitive for agent loops.
   */
  async snapshot(filter?: string): Promise<string> {
    return kuri.snapshot(requireTab(this._tabId), filter);
  }

  // ── Actions (ref-based via Kuri) ────────────────────────────────────

  /**
   * Click an element by ref (from snapshot) or CSS selector.
   * Ref-based clicks (e.g. "e5") use Kuri's native action system.
   * CSS selectors fall back to evaluate-based clicking.
   */
  async click(refOrSelector: string): Promise<void> {
    const tabId = requireTab(this._tabId);
    if (/^e\d+$/.test(refOrSelector)) {
      await kuri.click(tabId, refOrSelector);
    } else {
      await kuri.evaluate(tabId, `document.querySelector(${JSON.stringify(refOrSelector)})?.click()`);
    }
  }

  /**
   * Fill an input by ref (from snapshot) or CSS selector.
   * Ref-based fills use Kuri's native action system with input event dispatch.
   */
  async fill(refOrSelector: string, value: string): Promise<void> {
    const tabId = requireTab(this._tabId);
    if (/^e\d+$/.test(refOrSelector)) {
      await kuri.fill(tabId, refOrSelector, value);
    } else {
      await kuri.evaluate(tabId, `(() => { const el = document.querySelector(${JSON.stringify(refOrSelector)}); if (el) { el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', {bubbles:true})); } })()`);
    }
  }

  /** Select an option by ref */
  async select(ref: string, value: string): Promise<void> {
    await kuri.select(requireTab(this._tabId), ref, value);
  }

  /** Scroll by direction */
  async scroll(direction: "up" | "down" | "left" | "right" = "down", amount?: number): Promise<void> {
    await kuri.scroll(requireTab(this._tabId), direction, amount);
  }

  /** Scroll an element into view by ref */
  async scrollIntoView(ref: string): Promise<void> {
    await kuri.scrollIntoView(requireTab(this._tabId), ref);
  }

  /** Drag from one ref to another */
  async drag(fromRef: string, toRef: string): Promise<void> {
    await kuri.drag(requireTab(this._tabId), fromRef, toRef);
  }

  /** Press a key (e.g. "Enter", "Tab", "Escape") */
  async press(key: string): Promise<void> {
    await kuri.press(requireTab(this._tabId), key);
  }

  /** Perform a raw Kuri action by ref */
  async action(actionType: string, ref: string, value?: string): Promise<unknown> {
    return kuri.action(requireTab(this._tabId), actionType as any, ref, value);
  }

  // ── Keyboard ────────────────────────────────────────────────────────

  /** Type text with key events */
  async type(text: string): Promise<void> {
    await kuri.keyboardType(requireTab(this._tabId), text);
  }

  /** Insert text directly (no key events) */
  async insertText(text: string): Promise<void> {
    await kuri.keyboardInsertText(requireTab(this._tabId), text);
  }

  /** Dispatch a keydown event */
  async keyDown(key: string): Promise<void> {
    await kuri.keyDown(requireTab(this._tabId), key);
  }

  /** Dispatch a keyup event */
  async keyUp(key: string): Promise<void> {
    await kuri.keyUp(requireTab(this._tabId), key);
  }

  // ── Wait ────────────────────────────────────────────────────────────

  /** Wait for a CSS selector to appear */
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

  /** Wait for page load */
  async waitForLoad(): Promise<void> {
    await kuri.waitForLoad(requireTab(this._tabId));
  }

  // ── Evaluate ────────────────────────────────────────────────────────

  /** Evaluate JavaScript in page context */
  async evaluate<T = unknown>(fn: string | (() => T)): Promise<T> {
    const tabId = requireTab(this._tabId);
    const script = typeof fn === "function" ? `(${fn.toString()})()` : fn;
    const result = await kuri.evaluate(tabId, script);
    return result as T;
  }

  // ── DOM Queries ─────────────────────────────────────────────────────

  /** Query DOM elements by CSS selector */
  async query(selector: string): Promise<unknown> {
    return kuri.domQuery(requireTab(this._tabId), selector);
  }

  /** Get element HTML by CSS selector */
  async innerHTML(selector: string): Promise<unknown> {
    return kuri.domHtml(requireTab(this._tabId), selector);
  }

  /** Get element attributes by ref */
  async attributes(ref: string): Promise<unknown> {
    return kuri.domAttributes(requireTab(this._tabId), ref);
  }

  /** Find text matches in the page */
  async findText(query: string): Promise<unknown> {
    return kuri.findText(requireTab(this._tabId), query);
  }

  // ── Screenshots & Media ─────────────────────────────────────────────

  /** Take a screenshot (returns base64-encoded PNG string) */
  async screenshot(): Promise<string> {
    return kuri.screenshot(requireTab(this._tabId));
  }

  // ── Cookies & Auth ──────────────────────────────────────────────────

  /** Get cookies for the current page */
  async cookies(): Promise<unknown> {
    return kuri.getCookies(requireTab(this._tabId));
  }

  /** Set a cookie */
  async setCookie(name: string, value: string, domain?: string): Promise<void> {
    await kuri.setCookie(requireTab(this._tabId), name, value, domain);
  }

  /** Set custom request headers */
  async setHeaders(headers: Record<string, string>): Promise<void> {
    await kuri.setHeaders(requireTab(this._tabId), headers);
  }

  // ── HAR Recording ───────────────────────────────────────────────────

  /** Start recording network traffic (HAR format) */
  async harStart(): Promise<void> {
    await kuri.harStart(requireTab(this._tabId));
  }

  /** Stop recording and return HAR 1.2 JSON */
  async harStop(): Promise<unknown> {
    return kuri.harStop(requireTab(this._tabId));
  }

  /** Get network events */
  async networkEvents(): Promise<unknown> {
    return kuri.getNetworkEvents(requireTab(this._tabId));
  }

  // ── Viewport & Emulation ────────────────────────────────────────────

  /** Set viewport size */
  async setViewport(width: number, height: number): Promise<void> {
    await kuri.setViewport(requireTab(this._tabId), width, height);
  }

  /** Override user agent */
  async setUserAgent(ua: string): Promise<void> {
    await kuri.setUserAgent(requireTab(this._tabId), ua);
  }

  /** Set HTTP basic auth credentials */
  async setCredentials(username: string, password: string): Promise<void> {
    await kuri.setCredentials(requireTab(this._tabId), username, password);
  }

  // ── Session ─────────────────────────────────────────────────────────

  /** Save browser session (cookies + storage) */
  async sessionSave(name: string): Promise<void> {
    await kuri.sessionSave(requireTab(this._tabId), name);
  }

  /** Restore a saved browser session */
  async sessionLoad(name: string): Promise<void> {
    await kuri.sessionLoad(requireTab(this._tabId), name);
  }

  /** List saved sessions */
  async sessionList(): Promise<unknown> {
    return kuri.sessionList(requireTab(this._tabId));
  }

  // ── Debug ───────────────────────────────────────────────────────────

  /** Get console messages */
  async console(): Promise<unknown> {
    return kuri.getConsole(requireTab(this._tabId));
  }

  /** Get page/runtime errors */
  async errors(): Promise<unknown> {
    return kuri.getErrors(requireTab(this._tabId));
  }

  /** Inject JavaScript into the page */
  async injectScript(script: string): Promise<void> {
    await kuri.scriptInject(requireTab(this._tabId), script);
  }

  // ── Lifecycle ───────────────────────────────────────────────────────

  /** Close this page. Saves auth profile, stops HAR, indexes captured traffic. */
  async close(): Promise<void> {
    if (this._tabId && !this._closed) {
      // Save auth profile for current domain before closing
      if (this._url !== "about:blank") {
        try {
          const domain = new URL(this._url).hostname.replace(/^www\./, "");
          await kuri.authProfileSave(this._tabId, domain);
        } catch { /* non-fatal */ }
      }

      // Stop HAR and passively index any captured API traffic
      if (this._harActive) {
        try {
          const { entries } = await kuri.harStop(this._tabId);
          passiveIndexHar(entries, this._url);
        } catch { /* HAR stop failure is non-fatal */ }
        this._harActive = false;
      }
      await kuri.closeTab(this._tabId).catch(() => {});
      this._closed = true;
    }
  }

  /** Access raw unbrowse skill data (non-Playwright extension) */
  get $unbrowse(): SkillResolutionResult | null {
    return this._skillResult;
  }
}

/**
 * Browser — launches Kuri (Zig-native CDP broker) as the primary browser.
 *
 * Kuri is the agent's browser. Unbrowse runs in the background, learning
 * internal APIs from traffic and progressively replacing browser calls with
 * direct API calls via the skill cache.
 */
export class Browser {
  private _pages: Page[] = [];
  private _defaultIntent?: string;
  private _started = false;

  private constructor(options?: BrowserLaunchOptions) {
    this._defaultIntent = options?.intent;
  }

  /** Launch Kuri browser instance */
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
