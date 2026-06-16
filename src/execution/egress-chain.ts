/**
 * Standardized client egress chain for the HOLE (internal-API) call and web-search.
 *
 * One interface, three tiers, each degrading honestly to the next on a block:
 *   1. LOCAL        — direct fetch from the client's own IP (fast; the common case).
 *   2. SERVER       — client → unbrowse server `/v1/proxy` mode="auto": the server egresses
 *                     from its clean datacenter IP FIRST (free, no toll), escalating to
 *                     residential only when its IP is also blocked. A local-IP throttle
 *                     (DDG, rate-limit) usually clears here with no toll.
 *   3. CLIENT-PROXY — last resort: the client's own residential egress (UNBROWSE_PROXY_URL /
 *                     IProyal creds), for users who hold local creds but no server API key.
 *
 * Why server-before-client-proxy: the canonical residential egress lives server-side
 * (server-proxy-fallback.ts) — the server owns the proxy tier, so the client prefers it and
 * only uses its own proxy when the server tier is unavailable (no API key). This is the
 * "local end OR server side as a fallback that falls back to a proxy" shape.
 *
 * Honest degradation: every tier that can't run (no key, no creds, throw, block status)
 * silently advances to the next; the final return is the best result obtained.
 */
import { serverProxyFallback } from "./server-proxy-fallback.js";
import { proxiedFetchOnce, resolveEgressProxy } from "./proxy-fetch.js";

export type EgressTier = "local" | "server" | "client-proxy";

export interface EgressRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | null;
  timeoutMs?: number;
}

export interface EgressOutcome {
  status: number;
  body: string;
  tier: EgressTier;
  /** True when no tier produced a non-block status (caller decides what to do). */
  blocked?: boolean;
}

export interface EgressOpts {
  /** Skip the local tier (caller already tried it with its own init). */
  skipLocal?: boolean;
  /** Disable the server tier (e.g. tests / explicit local-only). */
  allowServer?: boolean;
  /** Disable the client-side residential proxy tier. */
  allowClientProxy?: boolean;
  /**
   * Body-level block predicate. Some throttles are invisible to the status code: a soft-block
   * arrives as a 2xx whose BODY is the anomaly page (e.g. DuckDuckGo returns HTTP 202 + a
   * ~14KB "unusual traffic" page with zero results — never a 429). Status-only `isBlock` would
   * accept that throttled page and never escalate. When supplied, a tier's result counts as
   * blocked if `isBlock(status) || isBlockBody(status, body)`, so escalation continues through
   * server → client-proxy until a tier returns a genuinely-served body.
   */
  isBlockBody?: (status: number, body: string) => boolean;
}

/** A status that means "this egress path is blocked / dead — try the next tier." */
function isBlock(status: number): boolean {
  return status === 0 || status === 401 || status === 403 || status === 429 || status >= 500;
}

/** A tier's result is blocked if the status is a block OR the body is a soft-block (opt-in). */
function tierBlocked(status: number, body: string, opts: EgressOpts): boolean {
  return isBlock(status) || (opts.isBlockBody?.(status, body) ?? false);
}

export async function egressChain(req: EgressRequest, opts: EgressOpts = {}): Promise<EgressOutcome> {
  const method = req.method ?? "GET";
  const timeoutMs = req.timeoutMs ?? 15_000;
  let last: EgressOutcome = { status: 0, body: "", tier: "local", blocked: true };

  // 1. LOCAL
  if (!opts.skipLocal) {
    try {
      const r = await fetch(req.url, {
        method,
        headers: req.headers,
        body: req.body ?? undefined,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "follow",
      });
      const body = await r.text();
      if (!tierBlocked(r.status, body, opts)) return { status: r.status, body, tier: "local" };
      last = { status: r.status, body, tier: "local", blocked: true };
    } catch {
      last = { status: 0, body: "", tier: "local", blocked: true };
    }
  }

  // 2. SERVER (clean datacenter IP first, residential escalation server-side) — needs API key.
  if (opts.allowServer !== false) {
    try {
      const sp = await serverProxyFallback(
        { url: req.url, method, headers: req.headers, body: req.body, timeoutMs },
        { mode: "auto" },
      );
      if (sp && !tierBlocked(sp.status, sp.body, opts)) return { status: sp.status, body: sp.body, tier: "server" };
      if (sp) last = { status: sp.status, body: sp.body, tier: "server", blocked: true };
    } catch { /* server tier unavailable — advance */ }
  }

  // 3. CLIENT-PROXY (last resort: the client's own residential egress).
  if (opts.allowClientProxy !== false) {
    const proxyUrl = resolveEgressProxy();
    if (proxyUrl) {
      try {
        const { response } = await proxiedFetchOnce(
          req.url,
          { method, headers: req.headers, body: req.body ?? undefined },
          proxyUrl,
        );
        const body = await response.text();
        if (!tierBlocked(response.status, body, opts)) return { status: response.status, body, tier: "client-proxy" };
        last = { status: response.status, body, tier: "client-proxy", blocked: true };
      } catch { /* fall through to honest failure */ }
    }
  }

  return last;
}

/**
 * fetch-compatible adapter over the chain, for web-search and any `typeof fetch` consumer
 * (e.g. ddgSearch). Tries LOCAL with the caller's own init (preserving signal/headers); on a
 * block/throw, advances through the server → client-proxy tiers. The chosen tier is reported
 * back in the `x-egress-tier` response header for honest provenance.
 */
export const egressFetch: typeof fetch = async (input, init) => {
  const url = typeof input === "string" ? input : (input as URL).toString();
  // 1. LOCAL with the caller's init (its own timeout signal, headers).
  try {
    const r = await fetch(input as Parameters<typeof fetch>[0], init);
    if (!isBlock(r.status)) return r;
  } catch { /* throttle / block — fall to the server → proxy tiers */ }

  const method = init?.method ?? "GET";
  const headers = init?.headers
    ? Object.fromEntries(new Headers(init.headers as Record<string, string>).entries())
    : undefined;
  const body = typeof init?.body === "string" ? init.body : undefined;
  const out = await egressChain({ url, method, headers, body, timeoutMs: 12_000 }, { skipLocal: true });
  return new Response(out.body, { status: out.status || 502, headers: { "x-egress-tier": out.tier } });
};

/**
 * Body-aware variant of {@link egressFetch}: same local → server → client-proxy chain, but the
 * LOCAL tier ALSO escalates when a 2xx body is itself a soft-block (per `isBlockBody`). This is
 * the fix for status-invisible throttles — DuckDuckGo's HTTP 202 anomaly page is a 2xx that
 * status-only `isBlock` accepts, so without a body check the chain returns the throttled empty
 * page and never reaches the clean server IP. The local tier must read the body to test it, so
 * it reconstructs a fresh `Response` (the stream is consumed) for the caller to read again.
 * The predicate is threaded into `egressChain` so every downstream tier applies it too.
 */
export function egressFetchWithBlockCheck(
  isBlockBody: (status: number, body: string) => boolean,
): typeof fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    // 1. LOCAL with the caller's init; escalate on a status block OR a soft-block body.
    try {
      const r = await fetch(input as Parameters<typeof fetch>[0], init);
      if (!isBlock(r.status)) {
        const text = await r.text();
        if (!isBlockBody(r.status, text)) {
          return new Response(text, { status: r.status, headers: r.headers });
        }
        // 2xx soft-block (e.g. DDG 202 anomaly page) → fall through to escalate.
      }
    } catch { /* throttle / block — fall to the server → proxy tiers */ }

    const method = init?.method ?? "GET";
    const headers = init?.headers
      ? Object.fromEntries(new Headers(init.headers as Record<string, string>).entries())
      : undefined;
    const body = typeof init?.body === "string" ? init.body : undefined;
    const out = await egressChain(
      { url, method, headers, body, timeoutMs: 12_000 },
      { skipLocal: true, isBlockBody },
    );
    return new Response(out.body, { status: out.status || 502, headers: { "x-egress-tier": out.tier } });
  };
}
