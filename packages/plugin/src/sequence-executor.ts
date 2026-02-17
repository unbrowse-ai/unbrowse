import type { CapturedExchange } from "./types.js";
import type { CorrelationGraphV1, CorrelationLinkV1 } from "./correlation-engine.js";
import { safeParseJson } from "./schema-inferrer.js";

export type StepResponseRuntime = {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
  contentType?: string;
  bodyJson?: unknown;
};

export type PreparedRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  bodyText?: string;
};

function normalizeHeaderMap(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    const name = String(k || "").trim();
    if (!name) continue;
    out[name] = String(v ?? "");
  }
  return out;
}

function getHeaderCaseInsensitive(headers: Record<string, string>, name: string): string | undefined {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (k.toLowerCase() === want) return v;
  }
  return undefined;
}

function parsePathTokens(path: string): string[] {
  const p = String(path || "").trim();
  if (!p) return [];
  return p.split(".").filter(Boolean);
}

function getAtPath(obj: unknown, path: string): unknown {
  if (!obj) return undefined;
  const tokens = parsePathTokens(path);
  let cur: any = obj;
  for (const t of tokens) {
    if (t === "[]") return undefined;
    if (cur == null) return undefined;
    cur = cur[t];
  }
  return cur;
}

function setAtPath(obj: any, path: string, value: unknown): boolean {
  const tokens = parsePathTokens(path);
  if (tokens.length === 0) return false;
  let cur: any = obj;
  for (let i = 0; i < tokens.length - 1; i++) {
    const t = tokens[i];
    if (t === "[]") return false;
    if (cur[t] == null || typeof cur[t] !== "object") cur[t] = {};
    cur = cur[t];
  }
  const last = tokens[tokens.length - 1];
  if (last === "[]") return false;
  cur[last] = value;
  return true;
}

function filterRequestHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    const lower = k.toLowerCase();
    if (lower.startsWith(":")) continue;
    if (lower === "host" || lower === "connection" || lower === "content-length" || lower === "transfer-encoding") continue;
    if (lower === "cookie") continue;
    out[k] = v;
  }
  return out;
}

function parseMaybeJsonResponse(bodyText: string, contentType: string | undefined): unknown | undefined {
  const ct = String(contentType ?? "").toLowerCase();
  if (ct.includes("application/json") || ct.includes("+json")) {
    const parsed = safeParseJson(bodyText);
    return parsed !== null ? parsed : undefined;
  }
  // Also try JSON for obvious payloads.
  const trimmed = String(bodyText ?? "").trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const parsed = safeParseJson(trimmed);
    return parsed !== null ? parsed : undefined;
  }
  return undefined;
}

function extractFromRuntime(
  runtimeByIndex: Map<number, StepResponseRuntime>,
  link: CorrelationLinkV1,
): string | undefined {
  const src = runtimeByIndex.get(link.sourceRequestIndex);
  if (!src) return undefined;

  if (link.sourceLocation === "header") {
    const headerName = link.sourcePath.replace(/^header\./, "");
    return getHeaderCaseInsensitive(src.headers, headerName);
  }

  if (link.sourceLocation === "body") {
    const json = src.bodyJson ?? parseMaybeJsonResponse(src.bodyText, src.contentType);
    if (!json) return undefined;
    const v = getAtPath(json, link.sourcePath);
    if (v === undefined || v === null) return undefined;
    return typeof v === "string" ? v : JSON.stringify(v);
  }

  // cookie/url/query sources not implemented yet (rare in practice)
  return undefined;
}

function applyInjectionToUrl(url: string, targetPath: string, value: string): string {
  // targetPath shapes:
  // - query.foo
  // - query.variables.some.nested
  try {
    const u = new URL(url);
    const parts = targetPath.split(".").filter(Boolean);
    if (parts[0] !== "query") return url;
    const key = parts[1];
    if (!key) return url;

    if (parts.length <= 2) {
      u.searchParams.set(key, value);
      return u.toString();
    }

    // Nested JSON-in-query param
    const nestedPath = parts.slice(2).join(".");
    const existing = u.searchParams.get(key) ?? "{}";
    const parsed = safeParseJson(existing.trim());
    const base = (parsed && typeof parsed === "object") ? (parsed as any) : {};
    setAtPath(base, nestedPath, value);
    u.searchParams.set(key, JSON.stringify(base));
    return u.toString();
  } catch {
    return url;
  }
}

function applyInjectionToBody(bodyText: string | undefined, targetPath: string, value: string): string | undefined {
  const parts = targetPath.split(".").filter(Boolean);
  if (parts[0] !== "body") return bodyText;
  const nested = parts.slice(1).join(".");
  if (!nested) return bodyText;

  const existing = String(bodyText ?? "").trim();
  const parsed = safeParseJson(existing);
  if (!parsed || typeof parsed !== "object") return bodyText;
  const base: any = parsed;
  const ok = setAtPath(base, nested, value);
  if (!ok) return bodyText;
  return JSON.stringify(base);
}

export function prepareRequestForStep(
  exchanges: CapturedExchange[],
  graph: CorrelationGraphV1,
  stepIndex: number,
  runtimeByIndex: Map<number, StepResponseRuntime>,
  opts?: {
    sessionHeaders?: Record<string, string>;
    sessionCookies?: Record<string, string>;
    bodyOverrideText?: string;
  },
): PreparedRequest | null {
  const ex = exchanges.find((e) => e.index === stepIndex);
  if (!ex) return null;

  const reqHeadersBase: Record<string, string> = {
    ...filterRequestHeaders(normalizeHeaderMap(ex.request.headers ?? {})),
    ...(opts?.sessionHeaders ?? {}),
  };

  let url = ex.request.url;
  let bodyText = typeof opts?.bodyOverrideText === "string" ? opts.bodyOverrideText : ex.request.bodyRaw;
  if (ex.request.body !== undefined && typeof ex.request.bodyRaw !== "string") {
    try { bodyText = JSON.stringify(ex.request.body); } catch { /* ignore */ }
  }

  const incoming = graph.links.filter((l) => l.targetRequestIndex === stepIndex);
  for (const link of incoming) {
    const v = extractFromRuntime(runtimeByIndex, link);
    if (!v) continue;

    if (link.targetLocation === "header") {
      const headerName = link.targetPath.replace(/^header\./, "");
      if (headerName) reqHeadersBase[headerName] = v;
      continue;
    }
    if (link.targetLocation === "query") {
      url = applyInjectionToUrl(url, link.targetPath, v);
      continue;
    }
    if (link.targetLocation === "body") {
      bodyText = applyInjectionToBody(bodyText, link.targetPath, v);
      continue;
    }
    // cookie/url injections can be added later
  }

  return {
    method: ex.request.method,
    url,
    headers: reqHeadersBase,
    bodyText,
  };
}
