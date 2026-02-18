import { BrowserManager } from "agent-browser/dist/browser.js";
import { executeCommand } from "agent-browser/dist/actions.js";
import { nanoid } from "nanoid";

export interface CaptureResult {
  requests: RawRequest[];
  har_lineage_id: string;
  domain: string;
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
  cookies?: Array<{ name: string; value: string; domain: string; path?: string }>
): Promise<CaptureResult> {
  const browser = new BrowserManager();
  await browser.launch({ action: "launch", id: nanoid(), headless: true });

  if (authHeaders && Object.keys(authHeaders).length > 0) {
    await browser.setExtraHeaders(authHeaders);
  }
  if (cookies && cookies.length > 0) {
    await browser.getContext()?.addCookies(cookies);
  }

  await browser.startHarRecording();
  browser.startRequestTracking();

  await executeCommand({ action: "navigate", id: nanoid(), url }, browser);

  // Wait for XHR/fetch calls to settle
  await new Promise((r) => setTimeout(r, 2500));

  const trackedRequests = browser.getRequests();
  const domain = new URL(url).hostname;
  const har_lineage_id = nanoid();

  const requests: RawRequest[] = trackedRequests.map((r) => ({
    url: r.url,
    method: r.method,
    request_headers: r.headers,
    response_status: 0, // TrackedRequest doesn't include response — enriched by HAR
    response_headers: {},
    timestamp: new Date(r.timestamp).toISOString(),
  }));

  return { requests, har_lineage_id, domain };
}

export async function executeInBrowser(
  url: string,
  method: string,
  requestHeaders: Record<string, string>,
  body?: unknown,
  authHeaders?: Record<string, string>,
  cookies?: Array<{ name: string; value: string; domain: string; path?: string }>
): Promise<{ status: number; data: unknown; trace_id: string }> {
  const browser = new BrowserManager();
  await browser.launch({ action: "launch", id: nanoid(), headless: true });

  const allHeaders = { ...authHeaders, ...requestHeaders };
  if (Object.keys(allHeaders).length > 0) {
    await browser.setExtraHeaders(allHeaders);
  }
  if (cookies && cookies.length > 0) {
    await browser.getContext()?.addCookies(cookies);
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
}
