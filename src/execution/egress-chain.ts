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
}

/** A status that means "this egress path is blocked / dead — try the next tier." */
function isBlock(status: number): boolean {
  return status === 0 || status === 401 || status === 403 || status === 429 || status >= 500;
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
      if (!isBlock(r.status)) return { status: r.status, body, tier: "local" };
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
      if (sp && !isBlock(sp.status)) return { status: sp.status, body: sp.body, tier: "server" };
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
        if (!isBlock(response.status)) return { status: response.status, body, tier: "client-proxy" };
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
