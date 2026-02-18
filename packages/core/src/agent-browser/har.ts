import type { HarEntry } from "../types.js";
import { runAgentBrowserJson } from "./runner.js";

export interface AgentBrowserHarOptions {
  session: string;
  /** Max number of request details to fetch. */
  maxRequests?: number;
  /** Only include these resource types if present (xhr/fetch are typical). */
  includeTypes?: string[];
}

function toHarHeaders(headers: any): Array<{ name: string; value: string }> {
  if (!headers) return [];
  if (Array.isArray(headers)) {
    return headers
      .map((h) => {
        if (!h) return null;
        if (typeof h.name === "string") return { name: h.name, value: String(h.value ?? "") };
        return null;
      })
      .filter(Boolean) as any;
  }
  if (typeof headers === "object") {
    return Object.entries(headers).map(([k, v]) => ({ name: k, value: String(v ?? "") }));
  }
  return [];
}

function coalesceString(...vals: any[]): string | undefined {
  for (const v of vals) {
    if (typeof v === "string" && v.length) return v;
  }
  return undefined;
}

function coalesceNumber(...vals: any[]): number | undefined {
  for (const v of vals) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return undefined;
}

function safeText(val: any, max = 250_000): string | undefined {
  if (typeof val !== "string") return undefined;
  if (val.length <= max) return val;
  return val.slice(0, max) + "\n/* …truncated… */";
}

function toHarEntry(detail: any): HarEntry | null {
  const req = detail?.request ?? detail?.req ?? detail;
  const res = detail?.response ?? detail?.res ?? detail;

  const method = coalesceString(req?.method, detail?.method) ?? "GET";
  const url = coalesceString(req?.url, detail?.url);
  if (!url) return null;

  const requestHeaders = toHarHeaders(req?.headers ?? req?.requestHeaders ?? detail?.requestHeaders ?? detail?.headers);
  const responseHeaders = toHarHeaders(res?.headers ?? res?.responseHeaders ?? detail?.responseHeaders);

  const started = (() => {
    const ts = coalesceNumber(detail?.timestamp, detail?.startedAt, req?.timestamp);
    if (!ts) return undefined;
    // agent-browser timestamps vary; accept ms epoch or seconds epoch.
    const ms = ts > 10_000_000_000 ? ts : ts * 1000;
    return new Date(ms).toISOString();
  })();

  const postDataText = coalesceString(req?.postData, req?.body, req?.bodyText, detail?.postData, detail?.body);
  const respBodyText = coalesceString(res?.body, res?.bodyText, detail?.responseBody, detail?.bodyText);
  const mimeType = coalesceString(
    req?.mimeType,
    req?.contentType,
    (requestHeaders.find((h) => h.name.toLowerCase() === "content-type")?.value),
  );

  const status = coalesceNumber(res?.status, detail?.status) ?? 0;
  const respMimeType = coalesceString(
    res?.mimeType,
    res?.contentType,
    (responseHeaders.find((h) => h.name.toLowerCase() === "content-type")?.value),
  );

  return {
    startedDateTime: started,
    request: {
      method,
      url,
      headers: requestHeaders,
      postData: postDataText ? { mimeType, text: safeText(postDataText) } : undefined,
    },
    response: {
      status,
      headers: responseHeaders,
      content: respBodyText ? { mimeType: respMimeType, text: safeText(respBodyText) } : undefined,
    },
  };
}

export async function captureHarFromAgentBrowser(opts: AgentBrowserHarOptions): Promise<{
  har: { log: { entries: HarEntry[] } };
  cookies: Record<string, string>;
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
  requestCount: number;
}> {
  const includeTypes = (opts.includeTypes && opts.includeTypes.length) ? new Set(opts.includeTypes.map((t) => t.toLowerCase())) : null;
  const maxRequests = Number.isFinite(opts.maxRequests) && (opts.maxRequests as number) > 0 ? Math.trunc(opts.maxRequests as number) : 500;

  const list = await runAgentBrowserJson(["--session", opts.session, "--json", "network", "requests"]);
  const items: any[] = Array.isArray(list) ? list : Array.isArray(list?.requests) ? list.requests : [];

  const filtered = items.filter((it) => {
    if (!includeTypes) return true;
    const t = String(it?.type ?? it?.resourceType ?? "").toLowerCase();
    return includeTypes.has(t);
  });

  const ids = filtered
    .map((it) => it?.id ?? it?.requestId ?? it?.request_id ?? it?.requestID)
    .filter(Boolean)
    .slice(0, maxRequests)
    .map((x) => String(x));

  const entries: HarEntry[] = [];
  for (const id of ids) {
    const detail = await runAgentBrowserJson(["--session", opts.session, "--json", "network", "request", id]).catch(() => null);
    const harEntry = detail ? toHarEntry(detail) : null;
    if (harEntry) entries.push(harEntry);
  }

  const cookiesJson = await runAgentBrowserJson(["--session", opts.session, "--json", "cookies", "get"]).catch(() => null);
  const cookieList: any[] = Array.isArray(cookiesJson) ? cookiesJson : Array.isArray(cookiesJson?.cookies) ? cookiesJson.cookies : [];
  const cookies: Record<string, string> = {};
  for (const c of cookieList) {
    if (c && typeof c.name === "string") cookies[c.name] = String(c.value ?? "");
  }

  const localJson = await runAgentBrowserJson(["--session", opts.session, "--json", "storage", "local", "get"]).catch(() => null);
  const sessionJson = await runAgentBrowserJson(["--session", opts.session, "--json", "storage", "session", "get"]).catch(() => null);

  const localStorage: Record<string, string> = (localJson && typeof localJson === "object" && !Array.isArray(localJson)) ? localJson : {};
  const sessionStorage: Record<string, string> = (sessionJson && typeof sessionJson === "object" && !Array.isArray(sessionJson)) ? sessionJson : {};

  return {
    har: { log: { entries } },
    cookies,
    localStorage,
    sessionStorage,
    requestCount: entries.length,
  };
}

