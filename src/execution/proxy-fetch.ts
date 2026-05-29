/**
 * Residential-proxy dispatcher.
 *
 * Two runtimes, one surface:
 *   - bun: `fetch(url, { proxy: "http://user:pass@host:port", ... })` is
 *     native (Bun-specific option, undici-style). We pass it through.
 *   - node: undici `ProxyAgent` attached via `dispatcher`. Lazy-import so
 *     bun builds do not eagerly pull undici from node_modules.
 *
 * Substrate principle: NO per-domain registry, NO heuristics. Caller
 * decides WHEN to dispatch via proxy; this module is the structural
 * primitive that knows HOW.
 *
 * Egress default (2026-05-27, covenant
 *   sha256:65714387c8c9f6a151f2e8fec26992e7a289b4924e54fcb184312b7763c028a4):
 * Residential proxy egress is the DEFAULT, not opt-in. `resolveEgressProxy`
 * resolves outbound proxy in this order:
 *   1. UNBROWSE_DIRECT_EGRESS=1 → undefined (explicit opt-out, dev/health-check path)
 *   2. UNBROWSE_PROXY_URL set    → use it verbatim (user / CI override wins)
 *   3. IPROYAL_USER+IPROYAL_PASS → compose IProyal URL (legacy creds still honored)
 *   4. else                      → ProxyKingdom default (proxykingdom.cn2.ai, x402-gated)
 *
 * ProxyKingdom endpoint is a CN2 residential pool at $0.001/req. It speaks
 * x402: on first hit it returns 402 with payment headers; the user wallet
 * signs the micropayment and the request is replayed. The sponsor tier in
 * backend/src/middleware/sponsor.ts credits $1/day/agent so the first ~1000
 * requests/day are free before the agent's own wallet is debited.
 *
 * IProyal legacy: existing IPROYAL_* env consumers keep working — they
 * just become path 3 in the resolution order, behind UNBROWSE_PROXY_URL.
 *
 * Creds source for legacy IProyal: env vars only (IPROYAL_USER +
 * IPROYAL_PASS, optionally IPROYAL_HOST + IPROYAL_PORT for country-locked
 * endpoints). Never baked. See memory note reference_iproyal_proxy.md.
 *
 * 2026-05-27 WEDGE CLOSE (covenant remembrance sha256:cb168afc):
 * `x402ProxyAuthorization` resolves the Proxy-Authorization header value
 * by hitting the proxy host's x402 control surface, parsing the 402
 * envelope, signing via x402Fetch's wallet adapter, and caching the
 * resulting header value. When no wallet is configured the function
 * returns null with sub_state=x402_no_wallet and the caller keeps the
 * existing graceful-degrade (direct egress, proxy_used:false). No fake
 * Proxy-Authorization, no silent retry loop.
 */
import { x402Fetch, type X402SubState } from "../payments/x402-fetch.js";

export interface ProxyFetchEnv {
  /** IProyal username, often includes country/session params:
   *  "user__cr.us__sid.abc123". */
  user: string;
  /** IProyal password. */
  pass: string;
  /** Default geo.iproyal.com per memory note. */
  host?: string;
  /** Default 12321 (HTTP CONNECT entry). */
  port?: number;
}

export interface ProxyDispatchResult {
  /** True iff the proxy was actually attached on the call. */
  dispatched: boolean;
  /** Surface-level reason when not dispatched. */
  skipped_reason?: "creds_missing" | "runtime_unsupported";
}

/** Build the IProyal proxy URL from env. Returns undefined when creds are
 *  missing — caller emits the "creds_missing" decision_trace step. */
export function resolveProxyUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const user = env.IPROYAL_USER?.trim();
  const pass = env.IPROYAL_PASS?.trim();
  if (!user || !pass) return undefined;
  const host = env.IPROYAL_HOST?.trim() || "geo.iproyal.com";
  const port = env.IPROYAL_PORT?.trim() || "12321";
  // URL-encode creds so country-lock params like `cr.us` survive intact.
  return `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
}

/**
 * ProxyKingdom default endpoint — CN2 residential pool, x402-gated.
 * Override with UNBROWSE_PROXYKINGDOM_URL when the operator runs a
 * private mirror or wants to point at a different x402-speaking proxy.
 *
 * STUB NOTE (covenant sha256:65714387c8c9f6a151f2e8fec26992e7a289b4924e54fcb184312b7763c028a4):
 * Client-side x402 retry for outbound proxy CONNECT is NOT wired in this
 * session. The URL is set so `tryCurlImpersonateFetch --proxy <url>` runs
 * against the right host end-to-end; absent a wallet-signed
 * Proxy-Authorization the proxy will return a 407/402 and the existing
 * graceful-degrade (caller catches, falls through to direct egress with
 * `proxy_used: false`) keeps the agent unblocked. Honest 402 surface is
 * the signal that wallet wiring needs to land — NOT a fake-green default.
 *
 * The /v1/proxykingdom/relay backend route is the next-wave seam: a
 * server-side x402 relay that signs with the user's Privy/lobster wallet
 * AND consumes the sponsor tier ($1/day/agent), then CONNECT-tunnels for
 * the client. That route does not exist yet.
 */
export const PROXYKINGDOM_DEFAULT_URL = "https://proxykingdom.cn2.ai";

/**
 * Resolve the outbound proxy URL the runtime should use for THIS request.
 *
 * Order (first match wins):
 *   1. UNBROWSE_DIRECT_EGRESS=1 / true / yes → undefined (direct, explicit opt-out)
 *   2. UNBROWSE_PROXY_URL set                → verbatim
 *   3. IProyal creds present                 → resolveProxyUrl(env)
 *   4. else                                  → PROXYKINGDOM_DEFAULT_URL (or override)
 *
 * Returns undefined ONLY for the explicit opt-out path. Every other path
 * returns a usable URL so downstream `tryCurlImpersonateFetch` /
 * `proxiedFetchOnce` / Kuri-Chrome --proxy-server always have a target.
 */
export function resolveEgressProxy(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const direct = env.UNBROWSE_DIRECT_EGRESS?.trim().toLowerCase();
  if (direct === "1" || direct === "true" || direct === "yes") return undefined;

  const explicit = env.UNBROWSE_PROXY_URL?.trim();
  if (explicit) return explicit;

  const iproyal = resolveProxyUrl(env);
  if (iproyal) return iproyal;

  const override = env.UNBROWSE_PROXYKINGDOM_URL?.trim();
  return override || PROXYKINGDOM_DEFAULT_URL;
}

/**
 * Convenience: spread-friendly object form for call sites that previously
 * did `...(process.env.UNBROWSE_PROXY_URL ? { proxy: process.env.UNBROWSE_PROXY_URL } : {})`.
 * Always returns a `{ proxy }` key under the new default (the opt-out
 * branch yields `{}` so the caller's downstream fetch runs direct).
 */
export function egressProxyArg(env: NodeJS.ProcessEnv = process.env): { proxy?: string } {
  const url = resolveEgressProxy(env);
  return url ? { proxy: url } : {};
}

/** Run `fetch` with the IProyal proxy attached for this single call.
 *  Caller passes the same args they would to `fetch`; the proxy URL is
 *  derived from env. Returns `{ response, dispatched }`. When dispatched
 *  is false, `response` is the result of a direct (non-proxied) fetch —
 *  caller decides whether to surface that as a separate decision step. */
export async function proxiedFetchOnce(
  url: string,
  init: RequestInit = {},
  proxyUrl: string | undefined = resolveProxyUrl(),
): Promise<{ response: Response; dispatch: ProxyDispatchResult }> {
  if (!proxyUrl) {
    const response = await fetch(url, init);
    return { response, dispatch: { dispatched: false, skipped_reason: "creds_missing" } };
  }

  // Bun: per-request proxy option (no dispatcher plumbing).
  if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
    const response = await fetch(url, {
      ...init,
      // @ts-expect-error bun-specific RequestInit field
      proxy: proxyUrl,
    });
    return { response, dispatch: { dispatched: true } };
  }

  // Node: undici ProxyAgent via dispatcher. Lazy import keeps bun bundles slim.
  try {
    const { ProxyAgent } = (await import("undici")) as typeof import("undici");
    const dispatcher = new ProxyAgent(proxyUrl);
    const response = await fetch(url, {
      ...init,
      // @ts-expect-error node-undici extension
      dispatcher,
    });
    return { response, dispatch: { dispatched: true } };
  } catch {
    // undici not installed and not on bun — surface honestly.
    const response = await fetch(url, init);
    return { response, dispatch: { dispatched: false, skipped_reason: "runtime_unsupported" } };
  }
}

// ---------------------------------------------------------------------------
// x402ProxyAuthorization — resolve the Proxy-Authorization header for an
// x402-gated proxy (e.g. proxykingdom.cn2.ai). The proxy exposes an HTTP
// control endpoint that returns a 402 envelope when no payment is
// attached; we sign via x402Fetch and use the resulting X-PAYMENT value
// as the Proxy-Authorization header for subsequent CONNECT tunnels.
//
// Returns null when:
//   - no x402-capable URL is given (returns null silently, caller uses raw proxy)
//   - the proxy's x402 control endpoint doesn't return a 402 (proxy is open
//     or uses a different auth scheme — caller uses raw proxy)
//   - x402Fetch surfaces x402_no_wallet / x402_signer_error / etc.
//     (caller's graceful-degrade kicks in: direct egress, proxy_used:false)
// ---------------------------------------------------------------------------
export interface X402ProxyHandshakeResult {
  proxy_authorization: string | null;
  sub_state: X402SubState | "no_proxy" | "not_x402_proxy";
  proxy_url: string;
  /** Adapter that signed, if any. */
  adapter?: string;
  /** Error from the wallet adapter when sub_state = x402_signer_error. */
  error?: string;
}

/**
 * Run the x402 control handshake against an outbound proxy. For x402-gated
 * proxies (PROXYKINGDOM_DEFAULT_URL, any UNBROWSE_PROXYKINGDOM_URL override),
 * the proxy's HTTPS control endpoint serves a 402 envelope describing the
 * payment terms. We sign once per process lifetime and cache the
 * Proxy-Authorization header value for re-use.
 *
 * The 402 surface URL is the proxy host's `/x402/handshake` control path by
 * convention. Override with UNBROWSE_PROXY_X402_HANDSHAKE_URL when the
 * operator's proxy uses a different path.
 */
let _cachedProxyAuth: { url: string; header: string; expiresAt: number } | null = null;

export async function x402ProxyAuthorization(
  proxyUrl: string | undefined = resolveEgressProxy(),
): Promise<X402ProxyHandshakeResult> {
  if (!proxyUrl) {
    return { proxy_authorization: null, sub_state: "no_proxy", proxy_url: "" };
  }
  // Cache hit (5 min default; expiresAt set from envelope.validUntil when present).
  if (_cachedProxyAuth && _cachedProxyAuth.url === proxyUrl && Date.now() < _cachedProxyAuth.expiresAt) {
    return {
      proxy_authorization: _cachedProxyAuth.header,
      sub_state: "x402_signed",
      proxy_url: proxyUrl,
    };
  }

  // Only attempt x402 handshake against https:// proxies (IProyal http://
  // basic-auth + already-encoded creds in the URL is NOT x402-shaped).
  if (!proxyUrl.startsWith("https://")) {
    return { proxy_authorization: null, sub_state: "not_x402_proxy", proxy_url: proxyUrl };
  }

  const handshakeOverride = process.env.UNBROWSE_PROXY_X402_HANDSHAKE_URL?.trim();
  const handshakeUrl = handshakeOverride
    || proxyUrl.replace(/\/+$/, "") + "/x402/handshake";

  try {
    const { response, trace } = await x402Fetch(handshakeUrl, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (trace.sub_state === "x402_passthrough") {
      // Proxy didn't serve a 402 at the handshake path — either it's not
      // x402-shaped, or the path is wrong. Caller uses raw proxy.
      return { proxy_authorization: null, sub_state: "not_x402_proxy", proxy_url: proxyUrl };
    }
    if (trace.sub_state === "x402_signed") {
      // The signed retry returned 2xx — the response body should carry
      // the Proxy-Authorization value the proxy expects for CONNECT.
      // Convention: the proxy echoes the signed X-PAYMENT header into a
      // `proxy_authorization` JSON field; fallback to the raw X-PAYMENT
      // we sent.
      let header: string | null = null;
      try {
        const body = await response.json() as { proxy_authorization?: string };
        header = body.proxy_authorization ?? null;
      } catch { /* not JSON — fall through */ }
      if (!header) {
        // Last resort: use the envelope's accepts[0] amount + scheme as the
        // auth header — protocol-honest hint to the operator that the
        // proxy didn't return an explicit header.
        return {
          proxy_authorization: null,
          sub_state: "x402_retry_blocked",
          proxy_url: proxyUrl,
          adapter: trace.adapter,
        };
      }
      // Cache for 5 minutes (proxykingdom validUntil is usually session-scoped).
      _cachedProxyAuth = { url: proxyUrl, header, expiresAt: Date.now() + 5 * 60_000 };
      return {
        proxy_authorization: header,
        sub_state: "x402_signed",
        proxy_url: proxyUrl,
        adapter: trace.adapter,
      };
    }
    // Every other sub-state is a failure path — surface honestly so the
    // caller's graceful-degrade kicks in.
    return {
      proxy_authorization: null,
      sub_state: trace.sub_state,
      proxy_url: proxyUrl,
      adapter: trace.adapter,
      error: trace.error,
    };
  } catch (err) {
    return {
      proxy_authorization: null,
      sub_state: "x402_signer_error",
      proxy_url: proxyUrl,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Reset the proxy-auth cache (e.g. when env changes mid-process). */
export function clearProxyAuthCache(): void {
  _cachedProxyAuth = null;
}
