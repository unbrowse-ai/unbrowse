import { log } from "../logger.js";

export interface ProbeResult {
  status: number;                     // HTTP status, or 0 on network failure
  content_type?: string;              // lowercased
  byte_length?: number;               // from Content-Length / Content-Range header
  ms: number;                         // wall-clock time
  error?: string;                     // network error reason on status:0
  method_used: "HEAD" | "GET-1byte";  // which request type produced this result
}

export interface ProbeOptions {
  cookies?: Array<{ name: string; value: string }>;
  headers?: Record<string, string>;
  timeout_ms?: number;                // per-attempt; default 1500 HEAD / 1000 ranged-GET
}

/**
 * Probe a URL for structural evidence: status + content-type + body size.
 *
 * Used by the executor to decide whether the URL is self-fetchable
 * (serverFetch will work) or page-triggered (triggerAndIntercept needed).
 *
 * Cheap by design: HEAD first, ranged GET on 405/501/timeout. Never downloads
 * the body. Always returns a ProbeResult — never throws. status:0 with error
 * set means network failure; the caller decides whether to escalate.
 */
export async function probeUrl(url: string, opts: ProbeOptions = {}): Promise<ProbeResult> {
  const headers: Record<string, string> = {
    "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "accept": "*/*",
    "accept-language": "en-US,en;q=0.9",
    ...(opts.headers ?? {}),
  };
  if (opts.cookies && opts.cookies.length > 0) {
    headers["cookie"] = opts.cookies
      .map((c) => {
        const v = c.value.startsWith('"') && c.value.endsWith('"') ? c.value.slice(1, -1) : c.value;
        return `${c.name}=${v}`;
      })
      .join("; ");
  }

  const headTimeout = opts.timeout_ms ?? 1500;
  const rangedTimeout = opts.timeout_ms ?? 1000;

  // Step 1: HEAD
  const start = Date.now();
  try {
    const res = await fetchWithTimeout(
      url,
      { method: "HEAD", headers, redirect: "follow" },
      headTimeout,
    );
    // Some servers happily return 200 to HEAD but never set headers — accept
    // whatever they tell us. If method is rejected (405/501) we still try a
    // ranged GET below for richer evidence.
    if (res.status !== 405 && res.status !== 501) {
      const ct = (res.headers.get("content-type") || "").toLowerCase();
      const lenHeader = res.headers.get("content-length");
      const byte_length = lenHeader && Number.isFinite(Number(lenHeader)) ? Number(lenHeader) : undefined;
      return {
        status: res.status,
        content_type: ct || undefined,
        byte_length,
        ms: Date.now() - start,
        method_used: "HEAD",
      };
    }
    log("probe", `HEAD ${url} returned ${res.status}; trying ranged GET`);
  } catch (err) {
    log("probe", `HEAD ${url} failed: ${(err as Error).message}; trying ranged GET`);
  }

  // Step 2: ranged GET 1 byte (some servers reject HEAD, some return body-less HEAD)
  const start2 = Date.now();
  try {
    const res = await fetchWithTimeout(
      url,
      {
        method: "GET",
        headers: { ...headers, range: "bytes=0-0" },
        redirect: "follow",
      },
      rangedTimeout,
    );
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    const range = res.headers.get("content-range"); // "bytes 0-0/12345"
    const lenHeader = res.headers.get("content-length");
    let byte_length: number | undefined;
    if (range) {
      const slash = range.split("/")[1];
      const total = Number(slash);
      if (Number.isFinite(total)) byte_length = total;
    }
    if (byte_length === undefined && lenHeader && Number.isFinite(Number(lenHeader))) {
      // No Content-Range — server may have ignored Range. Use Content-Length
      // only if it looks like the full body (>1 byte means range was ignored).
      const n = Number(lenHeader);
      if (n > 1) byte_length = n;
    }
    // Drain the 1 byte body so the connection can be reused.
    try { await res.arrayBuffer(); } catch { /* ignore */ }
    return {
      status: res.status === 206 ? 200 : res.status, // partial-content normalises to 200
      content_type: ct || undefined,
      byte_length,
      ms: Date.now() - start + (Date.now() - start2),
      method_used: "GET-1byte",
    };
  } catch (err) {
    return {
      status: 0,
      ms: Date.now() - start,
      error: (err as Error).message || "network_error",
      method_used: "GET-1byte",
    };
  }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ----------------------------------------------------------------------------
// decideFromProbe — pure function from probe evidence to execution strategy.
// ----------------------------------------------------------------------------

export type ExecStrategy = "server" | "trigger-intercept" | "browser" | "return-error";

export interface DecisionInput {
  probe: ProbeResult;
  has_trigger_url: boolean;
  intent_wants_dom?: boolean;         // e.g. article extraction wants HTML
  has_dom_extraction?: boolean;       // endpoint already has a DOM extraction recipe
}

export interface Decision {
  strategy: ExecStrategy;
  reason: string;                     // human-readable, lands in decision_trace
}

const SMALL_HTML_BYTES = 5_000;

const JSON_LIKE = /(application\/json|application\/[\w.+-]+\+json|text\/csv|application\/xml|text\/xml)/i;
const HTML_LIKE = /text\/html|application\/xhtml\+xml/i;

export function decideFromProbe(input: DecisionInput): Decision {
  const { probe, has_trigger_url, intent_wants_dom, has_dom_extraction } = input;
  const { status, content_type = "", byte_length } = probe;

  // 401/403 — fetch full body (not just probe stub). The body may carry
  // vendor-block markers (DataDome, CF, PerimeterX, etc.) that the executor's
  // classifyExecuteFailure() needs for honest bucketing — return-error short-
  // circuits with a synthesized stub that has no body to classify.
  if (status === 401 || status === 403) {
    return {
      strategy: "server",
      reason: `probe status ${status} — fetch body for vendor-block classification`,
    };
  }
  // Other 4xx/5xx — return as-is. No "let me try a different strategy" theatre.
  // The agent reads the actual server error and decides next move.
  if (status >= 400) {
    return {
      strategy: "return-error",
      reason: `probe status ${status}; returning to caller`,
    };
  }

  // Network error — escalate to browser (different DNS/TLS/UA path may work).
  // Never to trigger-intercept (which would also need a working tab).
  if (status === 0) {
    return {
      strategy: "browser",
      reason: `probe network error: ${probe.error ?? "unknown"}`,
    };
  }

  const isJson = JSON_LIKE.test(content_type);
  const isHtml = HTML_LIKE.test(content_type);
  const bodyLarge = (byte_length ?? 0) >= SMALL_HTML_BYTES;

  if (isJson) {
    return {
      strategy: "server",
      reason: `probe ${status} + ${content_type} — direct fetchable`,
    };
  }

  if (isHtml && bodyLarge) {
    return {
      strategy: "server",
      reason: `probe ${status} + html ${byte_length}B — server-rendered, fetch + extract`,
    };
  }

  // When the endpoint already has a DOM extraction recipe and the probe
  // returned HTML, fetch the page server-side and run the recipe. The
  // 1-byte range probe can't tell SSR from SPA, but if we have a recipe
  // the page must have rendered the data we want when captured.
  if (isHtml && has_dom_extraction) {
    return {
      strategy: "server",
      reason: `probe ${status} + html + dom_extraction recipe — server fetch + extract`,
    };
  }

  if (isHtml && !bodyLarge && has_trigger_url) {
    return {
      strategy: "trigger-intercept",
      reason: `probe ${status} + html ${byte_length ?? "?"}B — likely SPA shell, trigger-intercept`,
    };
  }

  if (isHtml && !bodyLarge) {
    return {
      strategy: "browser",
      reason: `probe ${status} + html ${byte_length ?? "?"}B SPA shell, no trigger_url — browser`,
    };
  }

  if (intent_wants_dom) {
    return {
      strategy: "browser",
      reason: `intent wants DOM, content-type ${content_type || "unknown"} — browser`,
    };
  }

  // Unknown content-type, non-error status — try server first.
  return {
    strategy: "server",
    reason: `probe ${status}, content-type ${content_type || "unknown"} — try server`,
  };
}
