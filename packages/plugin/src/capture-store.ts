import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { HarEntry, CaptureSessionFileV1, CapturedExchange, CaptureBodyFormat } from "./types.js";
import { safeParseJson } from "./schema-inferrer.js";

function boundText(input: string | undefined, maxChars: number): string | undefined {
  if (typeof input !== "string") return undefined;
  if (maxChars <= 0) return "";
  return input.length > maxChars ? input.slice(0, maxChars) : input;
}

function headersToRecord(headers: Array<{ name: string; value: string }> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of headers ?? []) {
    const name = String(h?.name ?? "").trim();
    if (!name) continue;
    out[name] = String(h?.value ?? "");
  }
  return out;
}

function cookiesToRecord(cookies: Array<{ name: string; value: string }> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of cookies ?? []) {
    const name = String(c?.name ?? "").trim();
    if (!name) continue;
    out[name] = String(c?.value ?? "");
  }
  return out;
}

function queryToRecord(qs: Array<{ name: string; value: string }> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const q of qs ?? []) {
    const name = String(q?.name ?? "").trim();
    if (!name) continue;
    out[name] = String(q?.value ?? "");
  }
  return out;
}

function bodyFormatFromContentType(contentType: string | undefined): CaptureBodyFormat {
  const ct = String(contentType ?? "").toLowerCase();
  if (ct.includes("application/json") || ct.includes("+json")) return "json";
  if (ct.includes("application/x-www-form-urlencoded")) return "form";
  if (ct.includes("text/") || ct.includes("application/xml") || ct.includes("+xml")) return "text";
  return "unknown";
}

function parseBody(
  raw: string | undefined,
  contentType: string | undefined,
): { bodyRaw?: string; body?: unknown; bodyFormat?: CaptureBodyFormat } {
  const bodyRaw = typeof raw === "string" ? raw : undefined;
  const fmt = bodyFormatFromContentType(contentType);

  if (!bodyRaw) return { bodyRaw: undefined, body: undefined, bodyFormat: fmt };

  if (fmt === "json") {
    const parsed = safeParseJson(bodyRaw);
    return { bodyRaw, body: parsed !== null ? parsed : undefined, bodyFormat: "json" };
  }

  if (fmt === "form") {
    try {
      const params = new URLSearchParams(bodyRaw);
      const out: Record<string, string> = {};
      for (const [k, v] of params.entries()) out[k] = v;
      return { bodyRaw, body: out, bodyFormat: "form" };
    } catch {
      return { bodyRaw, body: undefined, bodyFormat: "form" };
    }
  }

  return { bodyRaw, body: undefined, bodyFormat: fmt };
}

export function harEntriesToCapturedExchanges(
  entries: HarEntry[],
  opts?: {
    maxRequestBodyChars?: number;
    maxResponseBodyChars?: number;
  },
): CapturedExchange[] {
  const maxRequestBodyChars = opts?.maxRequestBodyChars ?? 100_000;
  const maxResponseBodyChars = opts?.maxResponseBodyChars ?? 100_000;

  const out: CapturedExchange[] = [];
  const sorted = [...(entries ?? [])].sort((a, b) => (a.time ?? 0) - (b.time ?? 0));

  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i];
    const reqHeaders = headersToRecord(e.request?.headers);
    const respHeaders = headersToRecord(e.response?.headers);
    const reqCt = reqHeaders["content-type"] ?? reqHeaders["Content-Type"];
    const respCt =
      respHeaders["content-type"] ??
      respHeaders["Content-Type"] ??
      e.response?.content?.mimeType;

    const reqBodyText = boundText(e.request?.postData?.text, maxRequestBodyChars);
    const respBodyText = boundText(e.response?.content?.text, maxResponseBodyChars);

    const reqParsed = parseBody(reqBodyText, e.request?.postData?.mimeType ?? reqCt);
    const respParsed = parseBody(respBodyText, respCt);

    const url = String(e.request?.url ?? "");
    let queryParams: Record<string, string> = {};
    try {
      queryParams = Object.fromEntries(new URL(url).searchParams.entries());
    } catch {
      // best-effort: also populate from HAR queryString
      queryParams = queryToRecord(e.request?.queryString);
    }

    const exchange: CapturedExchange = {
      index: out.length,
      timestamp: typeof e.time === "number" ? e.time : undefined,
      request: {
        method: String(e.request?.method ?? "GET").toUpperCase(),
        url,
        headers: reqHeaders,
        cookies: cookiesToRecord(e.request?.cookies),
        queryParams,
        body: reqParsed.body,
        bodyRaw: reqParsed.bodyRaw,
        bodyFormat: reqParsed.bodyFormat,
        contentType: e.request?.postData?.mimeType ?? reqCt,
      },
      response: {
        status: Number(e.response?.status ?? 0),
        headers: respHeaders,
        cookies: {}, // Set-Cookie parsing happens during replay; keep empty here.
        body: respParsed.body,
        bodyRaw: respParsed.bodyRaw,
        bodyFormat: respParsed.bodyFormat,
        contentType: respCt,
      },
    };
    out.push(exchange);
  }

  return out;
}

export function writeCaptureSessionFile(
  skillDir: string,
  entries: HarEntry[],
  opts?: {
    seedUrl?: string;
    maxRequestBodyChars?: number;
    maxResponseBodyChars?: number;
  },
): { path: string; session: CaptureSessionFileV1 } {
  const capturesDir = join(skillDir, "captures");
  mkdirSync(capturesDir, { recursive: true });

  const capturedAt = new Date().toISOString();
  const fileSafeTs = capturedAt.replace(/[:.]/g, "-");
  const path = join(capturesDir, `session-${fileSafeTs}.json`);

  const exchanges = harEntriesToCapturedExchanges(entries, {
    maxRequestBodyChars: opts?.maxRequestBodyChars,
    maxResponseBodyChars: opts?.maxResponseBodyChars,
  });

  const session: CaptureSessionFileV1 = {
    version: 1,
    capturedAt,
    seedUrl: opts?.seedUrl,
    exchanges,
  };

  writeFileSync(path, JSON.stringify(session, null, 2), "utf-8");
  return { path, session };
}

