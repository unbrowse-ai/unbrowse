/**
 * Client → server residential-proxy fallback.
 *
 * When the client's local execution path is blocked by a residential-IP
 * rate-limit (HTTP 429) or an IP-level block (HTTP 403), the client points to
 * the unbrowse server's POST /v1/proxy route in `residential` mode. The server
 * egresses through the iProyal residential proxy — which the client may not hold
 * creds for locally, or whose local egress IP is itself rate-limited — and
 * returns the recovered body. This is the "client relies on the server's iProyal
 * fallback" path: the canonical residential egress lives server-side.
 *
 * Substrate principle (mirrors proxy-fetch.ts): NO per-domain registry, NO
 * heuristics. The caller decides WHEN to invoke this on a block; this module is
 * the structural primitive that knows HOW to hand off to the server.
 *
 * Honest graceful-degrade — returns null (never throws) when:
 *   - UNBROWSE_DIRECT_EGRESS opt-out is set (direct egress everywhere)
 *   - no API key is resolvable (the server would 402; skip rather than burn it)
 *   - the network call fails, times out, or the server returns a non-OK envelope
 * On null the caller keeps the existing stale-endpoint / Retry-After path.
 */
import { getApiKey } from "../client/index.js";
import { isAuthBearing } from "./auth-bearing.js";

export interface ServerProxyResult {
  status: number;
  body: string;
  proxy_used?: string;
  egress_ip?: string;
  /** True when the server retried a direct 429 via its paid residential fallback. */
  fallback_used?: boolean;
  /** USD toll the server charged for the residential egress on this call. */
  surcharge_usd?: number;
}

export interface ServerProxyRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | null;
  timeoutMs?: number;
}

export interface ServerProxyOpts {
  /** Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Defaults to getApiKey(). Pass explicitly in tests. */
  apiKey?: string;
  /** Caller cancellation. Unlike network failures, cancellation is propagated. */
  signal?: AbortSignal;
  /**
   * Egress tier the server should use:
   *   - "auto" (default): server tries its own clean datacenter IP FIRST (free, the
   *     server-direct tier), escalating to residential only when its IP is also blocked.
   *   - "direct": server egresses from its clean IP only (no residential escalation, no toll).
   *   - "residential": force the residential proxy immediately (tolled).
   * This is what makes the local → server-direct → proxy chain real: a local IP throttle
   * (DDG, rate-limit) usually clears on the server's clean IP alone, with no residential toll.
   */
  mode?: "auto" | "direct" | "residential";
}

function isDirectEgress(env: NodeJS.ProcessEnv): boolean {
  const d = env.UNBROWSE_DIRECT_EGRESS?.trim().toLowerCase();
  return d === "1" || d === "true" || d === "yes";
}

function terminatingServerProxyAllowed(env: NodeJS.ProcessEnv): boolean {
  // The current /v1/proxy endpoint terminates TLS and therefore sees response bodies.
  // Keep it outside the canonical harness until an origin-scoped blind CONNECT lease
  // exists. This explicit operator-only compatibility flag is never chosen by agents.
  return env.UNBROWSE_ALLOW_TERMINATING_SERVER_PROXY === "1";
}

export async function serverProxyFallback(
  req: ServerProxyRequest,
  opts: ServerProxyOpts = {},
): Promise<ServerProxyResult | null> {
  const env = opts.env ?? process.env;
  // Explicit opt-out, plus a fail-closed default for the legacy TLS-terminating
  // remote fetch. Raw origin responses must remain local to the harness.
  if (isDirectEgress(env) || !terminatingServerProxyAllowed(env)) return null;

  // B1 firmament backstop (defense-in-depth): never hand an auth-bearing request
  // to the terminating `/v1/proxy` tier — the server reads the cleartext
  // credential + body there. egressChain already excludes the server tier for
  // these, but this is the single choke to /v1/proxy, so it also catches the
  // direct executeEndpoint 4xx/429 mouths and the egressFetch adapter. Graceful
  // null degrade — the caller keeps its honest stay-local / fail path; the
  // cleartext credential never crosses unbrowse's servers.
  if (isAuthBearing(req.headers)) return null;

  const apiKey = opts.apiKey ?? getApiKey();
  // No key → the server's /v1/proxy returns 402 with payment requirements.
  // Skip rather than make a doomed round-trip (x402 wallet handoff is a
  // separate seam; this primitive uses the agent's Bearer key).
  if (!apiKey || apiKey === "local-only") return null;

  const base = (env.UNBROWSE_API_URL ?? "https://beta-api.unbrowse.ai").replace(/\/+$/, "");
  const timeoutMs = req.timeoutMs ?? 60_000;
  opts.signal?.throwIfAborted();
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort(opts.signal?.reason);
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  const t = setTimeout(() => ctrl.abort(new DOMException("proxy fallback timed out", "TimeoutError")), timeoutMs);
  try {
    const r = await fetch(`${base}/v1/proxy`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        url: req.url,
        method: req.method ?? "GET",
        headers: req.headers,
        body: req.body ?? null,
        // "auto" = server-direct-first (free), escalate to residential on block. The server
        // treats an unknown value as residential (back-compat), so older servers degrade safely.
        proxy: opts.mode ?? "auto",
        timeout_ms: Math.min(timeoutMs, 60_000),
      }),
      signal: ctrl.signal,
    });
    if (!r.ok) return null;
    const payload = (await r.json()) as Partial<ServerProxyResult>;
    if (typeof payload.status !== "number" || typeof payload.body !== "string") return null;
    return {
      status: payload.status,
      body: payload.body,
      proxy_used: payload.proxy_used,
      egress_ip: payload.egress_ip,
      fallback_used: payload.fallback_used,
      surcharge_usd: payload.surcharge_usd,
    };
  } catch {
    // A caller cancellation is control flow, not an unavailable tier. Do not
    // swallow it and continue into another egress path.
    opts.signal?.throwIfAborted();
    return null;
  } finally {
    clearTimeout(t);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}
