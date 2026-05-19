/**
 * IProyal residential-proxy dispatcher for the opt-in 429 paid fallback.
 *
 * Two runtimes, one surface:
 *   - bun: `fetch(url, { proxy: "http://user:pass@host:port", ... })` is
 *     native (Bun-specific option, undici-style). We pass it through.
 *   - node: undici `ProxyAgent` attached via `dispatcher`. Lazy-import so
 *     bun builds do not eagerly pull undici from node_modules.
 *
 * Substrate principle: NO per-domain registry, NO heuristics. Caller
 * decides WHEN to dispatch via proxy (the 429 branch in executeEndpoint);
 * this module is the structural primitive that knows HOW.
 *
 * Creds source: env vars only (IPROYAL_USER + IPROYAL_PASS, optionally
 * IPROYAL_HOST + IPROYAL_PORT for country-locked endpoints). Never baked.
 * See memory note reference_iproyal_proxy.md for the country-lock format.
 *
 * Plan: add-an-opt-in-paid-residential-proxy-fallback-fo / Wave 3.
 */

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
