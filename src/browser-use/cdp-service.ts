/**
 * Browser-Use TypeScript Port - CDP Service
 *
 * Chrome DevTools Protocol integration for advanced browser control.
 * Provides request interception, storage access, and low-level browser APIs.
 *
 * Features:
 * - Network request interception and modification
 * - Header injection and manipulation
 * - Request blocking and filtering
 * - Cookie management
 * - Local/Session storage access
 * - Performance profiling
 */

import type { Page, CDPSession } from "playwright";

/**
 * Request interception handler
 */
export interface InterceptionHandler {
  /** URL pattern to match (glob or regex string) */
  urlPattern?: string;
  /** Resource types to match */
  resourceTypes?: Array<"Document" | "Stylesheet" | "Image" | "Media" | "Font" | "Script" | "XHR" | "Fetch" | "Other">;
  /** Handler function */
  handler: (request: InterceptedRequest) => Promise<InterceptionResponse>;
}

/**
 * Intercepted request data
 */
export interface InterceptedRequest {
  requestId: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  postData?: string;
  resourceType: string;
  /** Continue with modifications */
  continue: (overrides?: RequestOverrides) => Promise<void>;
  /** Fulfill with custom response */
  fulfill: (response: FulfillResponse) => Promise<void>;
  /** Abort the request */
  abort: (reason?: string) => Promise<void>;
}

/**
 * Request override options
 */
export interface RequestOverrides {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  postData?: string;
}

/**
 * Custom response for fulfilling requests
 */
export interface FulfillResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: string | Buffer;
  contentType?: string;
}

/**
 * Interception response from handler
 */
export type InterceptionResponse =
  | { action: "continue"; overrides?: RequestOverrides }
  | { action: "fulfill"; response: FulfillResponse }
  | { action: "abort"; reason?: string };

/**
 * Cookie data
 */
export interface CookieData {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

/**
 * Storage data
 */
export interface StorageEntry {
  key: string;
  value: string;
}

/**
 * CDP Service - Chrome DevTools Protocol operations
 */
export class CDPService {
  private page: Page;
  private cdp: CDPSession | null = null;
  private interceptHandlers: InterceptionHandler[] = [];
  private interceptEnabled = false;

  constructor(page: Page) {
    this.page = page;
  }

  /**
   * Initialize CDP session
   */
  async init(): Promise<void> {
    if (this.cdp) return;
    this.cdp = await this.page.context().newCDPSession(this.page);
  }

  /**
   * Ensure CDP is initialized
   */
  private async ensureCDP(): Promise<CDPSession> {
    if (!this.cdp) {
      await this.init();
    }
    return this.cdp!;
  }

  // =================== NETWORK INTERCEPTION ===================

  /**
   * Enable network request interception
   */
  async enableInterception(): Promise<void> {
    if (this.interceptEnabled) return;

    const cdp = await this.ensureCDP();

    // Enable Fetch domain for interception
    await cdp.send("Fetch.enable", {
      patterns: [{ urlPattern: "*", requestStage: "Request" }],
    });

    // Handle paused requests
    cdp.on("Fetch.requestPaused", async (event: any) => {
      const { requestId, request, resourceType } = event;

      const interceptedRequest: InterceptedRequest = {
        requestId,
        url: request.url,
        method: request.method,
        headers: request.headers,
        postData: request.postData,
        resourceType,
        continue: async (overrides) => {
          await cdp.send("Fetch.continueRequest", {
            requestId,
            url: overrides?.url,
            method: overrides?.method,
            headers: overrides?.headers
              ? Object.entries(overrides.headers).map(([name, value]) => ({ name, value }))
              : undefined,
            postData: overrides?.postData
              ? Buffer.from(overrides.postData).toString("base64")
              : undefined,
          });
        },
        fulfill: async (response) => {
          const body = response.body
            ? Buffer.from(response.body).toString("base64")
            : "";
          await cdp.send("Fetch.fulfillRequest", {
            requestId,
            responseCode: response.status || 200,
            responseHeaders: response.headers
              ? Object.entries(response.headers).map(([name, value]) => ({ name, value }))
              : [{ name: "Content-Type", value: response.contentType || "text/plain" }],
            body,
          });
        },
        abort: async (reason) => {
          await cdp.send("Fetch.failRequest", {
            requestId,
            errorReason: (reason || "Failed") as "Failed" | "Aborted" | "TimedOut" | "AccessDenied" | "ConnectionClosed" | "ConnectionReset" | "ConnectionRefused" | "ConnectionAborted" | "ConnectionFailed" | "NameNotResolved" | "InternetDisconnected" | "AddressUnreachable" | "BlockedByClient" | "BlockedByResponse",
          });
        },
      };

      // Find matching handler
      let handled = false;
      for (const handler of this.interceptHandlers) {
        // Check URL pattern
        if (handler.urlPattern) {
          const pattern = handler.urlPattern
            .replace(/[.+^${}()|[\]\\]/g, "\\$&")
            .replace(/\*/g, ".*");
          if (!new RegExp(pattern).test(request.url)) continue;
        }

        // Check resource type
        if (handler.resourceTypes && !handler.resourceTypes.includes(resourceType)) {
          continue;
        }

        try {
          const response = await handler.handler(interceptedRequest);

          if (response.action === "continue") {
            await interceptedRequest.continue(response.overrides);
          } else if (response.action === "fulfill") {
            await interceptedRequest.fulfill(response.response);
          } else if (response.action === "abort") {
            await interceptedRequest.abort(response.reason);
          }

          handled = true;
          break;
        } catch (err) {
          console.error("[cdp-service] Interception handler error:", err);
        }
      }

      // If no handler matched, continue normally
      if (!handled) {
        try {
          await cdp.send("Fetch.continueRequest", { requestId });
        } catch {
          // Request may have already been handled
        }
      }
    });

    this.interceptEnabled = true;
  }

  /**
   * Disable network interception
   */
  async disableInterception(): Promise<void> {
    if (!this.interceptEnabled) return;

    const cdp = await this.ensureCDP();
    await cdp.send("Fetch.disable");
    this.interceptEnabled = false;
  }

  /**
   * Add an interception handler
   */
  addInterceptHandler(handler: InterceptionHandler): void {
    this.interceptHandlers.push(handler);
  }

  /**
   * Remove all interception handlers
   */
  clearInterceptHandlers(): void {
    this.interceptHandlers = [];
  }

  /**
   * Block requests matching a pattern
   */
  async blockRequests(urlPattern: string): Promise<void> {
    await this.enableInterception();
    this.addInterceptHandler({
      urlPattern,
      handler: async () => ({ action: "abort", reason: "BlockedByClient" }),
    });
  }

  /**
   * Inject headers into matching requests
   */
  async injectHeaders(
    urlPattern: string,
    headers: Record<string, string>
  ): Promise<void> {
    await this.enableInterception();
    this.addInterceptHandler({
      urlPattern,
      handler: async (req) => ({
        action: "continue",
        overrides: {
          headers: { ...req.headers, ...headers },
        },
      }),
    });
  }

  /**
   * Mock a URL with a custom response
   */
  async mockResponse(
    urlPattern: string,
    response: FulfillResponse
  ): Promise<void> {
    await this.enableInterception();
    this.addInterceptHandler({
      urlPattern,
      handler: async () => ({ action: "fulfill", response }),
    });
  }

  // =================== COOKIES ===================

  /**
   * Get all cookies
   */
  async getCookies(urls?: string[]): Promise<CookieData[]> {
    const cdp = await this.ensureCDP();
    const result = await cdp.send("Network.getCookies", { urls });
    return result.cookies.map((c: any) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      expires: c.expires,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite,
    }));
  }

  /**
   * Set a cookie
   */
  async setCookie(cookie: CookieData): Promise<void> {
    const cdp = await this.ensureCDP();
    await cdp.send("Network.setCookie", {
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path || "/",
      expires: cookie.expires,
      httpOnly: cookie.httpOnly,
      secure: cookie.secure,
      sameSite: cookie.sameSite,
    });
  }

  /**
   * Delete cookies
   */
  async deleteCookies(name: string, domain?: string): Promise<void> {
    const cdp = await this.ensureCDP();
    await cdp.send("Network.deleteCookies", { name, domain });
  }

  /**
   * Clear all cookies
   */
  async clearCookies(): Promise<void> {
    const cdp = await this.ensureCDP();
    await cdp.send("Network.clearBrowserCookies");
  }

  // =================== STORAGE ===================

  /**
   * Get localStorage entries
   */
  async getLocalStorage(): Promise<StorageEntry[]> {
    const entries = await this.page.evaluate(() => {
      const items: Array<{ key: string; value: string }> = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key) {
          items.push({ key, value: localStorage.getItem(key) || "" });
        }
      }
      return items;
    });
    return entries;
  }

  /**
   * Set localStorage item
   */
  async setLocalStorage(key: string, value: string): Promise<void> {
    await this.page.evaluate(
      ({ key, value }) => localStorage.setItem(key, value),
      { key, value }
    );
  }

  /**
   * Get localStorage item
   */
  async getLocalStorageItem(key: string): Promise<string | null> {
    return this.page.evaluate((key) => localStorage.getItem(key), key);
  }

  /**
   * Remove localStorage item
   */
  async removeLocalStorageItem(key: string): Promise<void> {
    await this.page.evaluate((key) => localStorage.removeItem(key), key);
  }

  /**
   * Clear localStorage
   */
  async clearLocalStorage(): Promise<void> {
    await this.page.evaluate(() => localStorage.clear());
  }

  /**
   * Get sessionStorage entries
   */
  async getSessionStorage(): Promise<StorageEntry[]> {
    const entries = await this.page.evaluate(() => {
      const items: Array<{ key: string; value: string }> = [];
      for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i);
        if (key) {
          items.push({ key, value: sessionStorage.getItem(key) || "" });
        }
      }
      return items;
    });
    return entries;
  }

  /**
   * Set sessionStorage item
   */
  async setSessionStorage(key: string, value: string): Promise<void> {
    await this.page.evaluate(
      ({ key, value }) => sessionStorage.setItem(key, value),
      { key, value }
    );
  }

  /**
   * Clear sessionStorage
   */
  async clearSessionStorage(): Promise<void> {
    await this.page.evaluate(() => sessionStorage.clear());
  }

  // =================== PERFORMANCE ===================

  /**
   * Get performance metrics
   */
  async getPerformanceMetrics(): Promise<Record<string, number>> {
    const cdp = await this.ensureCDP();
    await cdp.send("Performance.enable");
    const result = await cdp.send("Performance.getMetrics");
    await cdp.send("Performance.disable");

    const metrics: Record<string, number> = {};
    for (const m of result.metrics as any[]) {
      metrics[m.name] = m.value;
    }
    return metrics;
  }

  /**
   * Get resource timing data
   */
  async getResourceTiming(): Promise<PerformanceResourceTiming[]> {
    return this.page.evaluate(() =>
      performance.getEntriesByType("resource") as PerformanceResourceTiming[]
    );
  }

  // =================== NETWORK LOGGING ===================

  /**
   * Enable detailed network logging
   */
  async enableNetworkLogging(
    onRequest?: (data: any) => void,
    onResponse?: (data: any) => void
  ): Promise<void> {
    const cdp = await this.ensureCDP();
    await cdp.send("Network.enable");

    if (onRequest) {
      cdp.on("Network.requestWillBeSent", onRequest);
    }
    if (onResponse) {
      cdp.on("Network.responseReceived", onResponse);
    }
  }

  /**
   * Disable network logging
   */
  async disableNetworkLogging(): Promise<void> {
    const cdp = await this.ensureCDP();
    await cdp.send("Network.disable");
  }

  // =================== JAVASCRIPT INJECTION ===================

  /**
   * Add script to run on every page load
   */
  async addInitScript(script: string): Promise<void> {
    const cdp = await this.ensureCDP();
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: script,
    });
  }

  /**
   * Emulate device
   */
  async emulateDevice(options: {
    width: number;
    height: number;
    deviceScaleFactor?: number;
    mobile?: boolean;
    userAgent?: string;
  }): Promise<void> {
    const cdp = await this.ensureCDP();

    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: options.width,
      height: options.height,
      deviceScaleFactor: options.deviceScaleFactor || 1,
      mobile: options.mobile || false,
    });

    if (options.userAgent) {
      await cdp.send("Emulation.setUserAgentOverride", {
        userAgent: options.userAgent,
      });
    }
  }

  // =================== CLEANUP ===================

  /**
   * Close CDP session
   */
  async close(): Promise<void> {
    if (this.cdp) {
      await this.cdp.detach();
      this.cdp = null;
    }
    this.interceptEnabled = false;
    this.interceptHandlers = [];
  }

  /**
   * Update page reference
   */
  async setPage(page: Page): Promise<void> {
    await this.close();
    this.page = page;
  }
}

/**
 * Create a CDP service for a page
 */
export async function createCDPService(page: Page): Promise<CDPService> {
  const service = new CDPService(page);
  await service.init();
  return service;
}
