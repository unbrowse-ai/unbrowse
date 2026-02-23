import { BrowserManager } from "agent-browser/dist/browser.js";
import { executeCommand } from "agent-browser/dist/actions.js";
import { nanoid } from "nanoid";
import { getRegistrableDomain } from "../domain.js";
import { getProfilePath } from "../auth/index.js";
import { log } from "../logger.js";
import fs from "node:fs";

// BUG-GC-012: Use a real Chrome UA — HeadlessChrome is actively blocked by Google and others.
const CHROME_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// Browser launch semaphore: max 3 concurrent browsers
const MAX_CONCURRENT_BROWSERS = 3;
let activeBrowsers = 0;
const waitQueue: Array<() => void> = [];

async function acquireBrowserSlot(): Promise<void> {
  if (activeBrowsers < MAX_CONCURRENT_BROWSERS) {
    activeBrowsers++;
    return;
  }
  return new Promise<void>((resolve) => {
    waitQueue.push(() => { activeBrowsers++; resolve(); });
  });
}

function releaseBrowserSlot(): void {
  activeBrowsers--;
  const next = waitQueue.shift();
  if (next) next();
}

export interface CapturedWsMessage {
  url: string;
  direction: "sent" | "received";
  data: string;
  timestamp: string;
}

export interface CaptureResult {
  requests: RawRequest[];
  har_lineage_id: string;
  domain: string;
  cookies?: Array<{ name: string; value: string; domain: string; path?: string; httpOnly?: boolean; secure?: boolean }>;
  final_url: string;
  ws_messages?: CapturedWsMessage[];
  html?: string;
}

export interface RawRequest {
  url: string;
  method: string;
  request_headers: Record<string, string>;
  request_body?: string;
  response_status: number;
  response_headers: Record<string, string>;
  response_body?: string;
  timestamp: string;
}

export async function captureSession(
  url: string,
  authHeaders?: Record<string, string>,
  cookies?: Array<{ name: string; value: string; domain: string; path?: string; secure?: boolean; httpOnly?: boolean; sameSite?: string; expires?: number }>
): Promise<CaptureResult> {
  await acquireBrowserSlot();
  try {
  const browser = new BrowserManager();
  const domain = new URL(url).hostname;
  const profileDir = getProfilePath(domain);
  const hasProfile = fs.existsSync(profileDir);

  if (hasProfile) {
    try {
      log("capture", `launching with persistent profile (headed): ${profileDir}`);
      await browser.launch({ action: "launch", id: nanoid(), headless: false, profile: profileDir, userAgent: CHROME_UA });
    } catch (err) {
      log("capture", `profile launch failed (${err}), falling back to headless ephemeral`);
      await browser.launch({ action: "launch", id: nanoid(), headless: true, userAgent: CHROME_UA });
    }
  } else {
    await browser.launch({ action: "launch", id: nanoid(), headless: true, userAgent: CHROME_UA });
  }

  if (authHeaders && Object.keys(authHeaders).length > 0) {
    await browser.setExtraHeaders(authHeaders);
  }
  if (cookies && cookies.length > 0) {
    await injectCookies(browser, cookies);
  }

  await browser.startHarRecording();
  browser.startRequestTracking();

  // Hook page.on('response') BEFORE navigation to capture all response bodies
  // including XHR/fetch calls made during initial page load
  const responseBodies = new Map<string, string>();
  const MAX_BODY_SIZE = 512 * 1024; // 512KB
  try {
    const page = browser.getPage();
    page.on("response", async (response) => {
      try {
        const ct = response.headers()["content-type"] ?? "";
        const respUrl = response.url();
        // Capture JSON, protobuf, and batch RPC responses (Google batchexecute etc.)
        const isDataResponse =
          ct.includes("application/json") ||
          ct.includes("+json") ||
          ct.includes("application/x-protobuf") ||
          ct.includes("text/plain") ||
          respUrl.includes("batchexecute") ||
          respUrl.includes("/api/");
        if (!isDataResponse) return;
        // Skip static assets
        if (/\.(js|css|woff2?|png|jpg|svg|ico)(\?|$)/.test(respUrl)) return;
        const body = await response.body();
        if (body.length > MAX_BODY_SIZE) return;
        responseBodies.set(respUrl, body.toString("utf8"));
      } catch {
        // Response body may be unavailable for redirects/aborted
      }
    });
  } catch {
    // page not available — skip body capture
  }

  // CDP-based WebSocket capture
  const wsMessages: CapturedWsMessage[] = [];
  const wsUrlMap = new Map<string, string>(); // requestId -> url
  try {
    const page = browser.getPage();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Network.enable");

    cdp.on("Network.webSocketCreated", (params: { requestId: string; url: string }) => {
      wsUrlMap.set(params.requestId, params.url);
    });

    cdp.on("Network.webSocketFrameReceived", (params: { requestId: string; timestamp: number; response: { payloadData: string } }) => {
      wsMessages.push({
        url: wsUrlMap.get(params.requestId) ?? params.requestId,
        direction: "received",
        data: params.response.payloadData,
        timestamp: new Date(params.timestamp * 1000).toISOString(),
      });
    });

    cdp.on("Network.webSocketFrameSent", (params: { requestId: string; timestamp: number; response: { payloadData: string } }) => {
      wsMessages.push({
        url: wsUrlMap.get(params.requestId) ?? params.requestId,
        direction: "sent",
        data: params.response.payloadData,
        timestamp: new Date(params.timestamp * 1000).toISOString(),
      });
    });
  } catch {
    // CDP session unavailable — skip WS capture
  }

  await executeCommand({ action: "navigate", id: nanoid(), url }, browser);

  // Wait longer for SPA XHR/fetch calls to settle (SPAs like Google Trends need more time)
  await new Promise((r) => setTimeout(r, 5000));

  // BUG-008: Share Cloudflare clearance cookies across subdomains
  try {
    const context = browser.getContext();
    if (context) {
      const allCookies = await context.cookies();
      const cfCookies = allCookies.filter(
        (c) => c.name === "__cf_bm" || c.name === "cf_clearance" || c.name.startsWith("__cf")
      );
      if (cfCookies.length > 0) {
        const baseDomain = getRegistrableDomain(new URL(url).hostname);
        const subdomainCookies = cfCookies.map((c) => ({
          ...c,
          domain: `.${baseDomain}`,
        }));
        try {
          await context.addCookies(subdomainCookies);
        } catch { /* CF cookie sharing is best-effort */ }
      }
    }
  } catch { /* context unavailable */ }

  const trackedRequests = browser.getRequests();
  const har_lineage_id = nanoid();

  // Debug: log all captured request URLs and response body map keys
  log("capture", `tracked ${trackedRequests.length} requests, ${responseBodies.size} response bodies`);
  for (const [bodyUrl] of responseBodies) {
    log("capture", `response body captured: ${bodyUrl.substring(0, 150)}`);
  }

  let final_url = url;
  let html: string | undefined;
  try {
    const page = browser.getPage();
    final_url = page.url();
    html = await page.content();
  } catch {}

  const requests: RawRequest[] = trackedRequests.map((r) => ({
    url: r.url,
    method: r.method,
    request_headers: r.headers,
    response_status: 0,
    response_headers: {},
    response_body: responseBodies.get(r.url),
    timestamp: new Date(r.timestamp).toISOString(),
  }));

  // Extract session cookies so callers can persist auth for future executions
  const ctx = browser.getContext();
  const rawCookies = ctx ? await ctx.cookies().catch(() => []) : [];
  const sessionCookies = rawCookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    httpOnly: c.httpOnly,
    secure: c.secure,
  }));

  return { requests, har_lineage_id, domain, cookies: sessionCookies.length > 0 ? sessionCookies : undefined, final_url, ws_messages: wsMessages.length > 0 ? wsMessages : undefined, html };
  } finally {
    releaseBrowserSlot();
  }
}

export async function executeInBrowser(
  url: string,
  method: string,
  requestHeaders: Record<string, string>,
  body?: unknown,
  authHeaders?: Record<string, string>,
  cookies?: Array<{ name: string; value: string; domain: string; path?: string; secure?: boolean; httpOnly?: boolean; sameSite?: string; expires?: number }>
): Promise<{ status: number; data: unknown; trace_id: string }> {
  await acquireBrowserSlot();
  try {
  const browser = new BrowserManager();
  await browser.launch({ action: "launch", id: nanoid(), headless: true, userAgent: CHROME_UA });

  const allHeaders = { ...authHeaders, ...requestHeaders };
  if (Object.keys(allHeaders).length > 0) {
    await browser.setExtraHeaders(allHeaders);
  }
  if (cookies && cookies.length > 0) {
    await injectCookies(browser, cookies);
  }

  browser.startRequestTracking();

  // Navigate to origin first so credentials scope correctly
  const origin = new URL(url).origin;
  await executeCommand({ action: "navigate", id: nanoid(), url: origin }, browser);

  const page = browser.getPage();
  const result = await page.evaluate(
    async ({ url, method, headers, body }: { url: string; method: string; headers: Record<string, string>; body: unknown }) => {
      const res = await fetch(url, {
        method,
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
        credentials: "include",
      });
      const text = await res.text();
      let data: unknown;
      try { data = JSON.parse(text); } catch { data = text; }
      return { status: res.status, data };
    },
    { url, method, headers: requestHeaders, body }
  );

  return { ...result, trace_id: nanoid() };
  } finally {
    releaseBrowserSlot();
  }
}

/**
 * Sanitize and inject cookies into browser context.
 * Strips all fields except { name, value, domain, path } to avoid
 * Playwright CDP protocol errors from unexpected cookie properties.
 * Falls back to per-cookie injection if batch fails.
 */
async function injectCookies(
  browser: InstanceType<typeof BrowserManager>,
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path?: string;
    secure?: boolean;
    httpOnly?: boolean;
    sameSite?: string;
    expires?: number;
  }>
): Promise<void> {
  const context = browser.getContext();
  if (!context) return;

  const sanitized = cookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain.startsWith(".") ? c.domain : `.${c.domain}`,
    path: c.path ?? "/",
    ...(c.secure != null ? { secure: c.secure } : {}),
    ...(c.httpOnly != null ? { httpOnly: c.httpOnly } : {}),
    ...(c.sameSite != null ? { sameSite: c.sameSite as "Strict" | "Lax" | "None" } : {}),
    ...(c.expires != null && c.expires > 0 ? { expires: c.expires } : {}),
  }));

  try {
    await context.addCookies(sanitized);
  } catch {
    for (const cookie of sanitized) {
      try {
        await context.addCookies([cookie]);
      } catch {
        // Skip malformed individual cookie
      }
    }
  }
}
