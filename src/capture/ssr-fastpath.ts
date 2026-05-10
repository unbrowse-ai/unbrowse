/**
 * SSR fast-path on browser-block — invoked from the capture pipeline when
 * the live browser session got vendor-blocked (block_signals contains
 * vendor:cloudflare / vendor:datadome / etc.) but libcurl-impersonate may
 * still fetch the page directly. Glassdoor on 2026-05-08 was the motivating
 * case: Kuri --headless=new triggered CF challenge ("Just a moment...")
 * but `unbrowse fetch <url>` got the real 14MB Reviews page back via
 * libcurl-impersonate Chrome131 JA4 in the same Kuri sandbox.
 *
 * This is the missing seam between "browser-blocked" and "give up".
 *
 * The existing `tryHttpFetch` (src/execution/index.ts:1562) uses Node's
 * bare fetch with a Chrome UA string — does NOT impersonate Chrome's JA4.
 * CF and other modern detectors classify it as a bot.
 *
 * runBundleReplay routes through the Kuri sandbox runtime which ships
 * libcurl-impersonate. Mirroring `cmdFetch` simple-mode (cli.ts:2266+):
 * synthesize a `__nativeFetch` bundle, post-eval `globalThis.r` for status
 * + body + final_url.
 */

import { runBundleReplay, type SeedCookie, type ObservedRoute } from "../sandbox/bundle-replay-client.js";

export interface SsrFastPathResult {
  html: string;
  status: number;
  observed_routes: ObservedRoute[];
  final_url: string;
  cookies: Array<{ name: string; value: string; domain: string }>;
  ms: number;
}

export interface SsrFastPathInput {
  url: string;
  seedCookies?: SeedCookie[];
  kuriBase?: string;
  fingerprint?: "chrome_mac_arm" | "chrome_windows";
  impersonate?: string;
  timeoutMs?: number;
  extraHeaders?: Record<string, string>;
  /** Optional proxy URL forwarded to runBundleReplay → Kuri's libcurl handle.
   * Caller may pass `process.env.UNBROWSE_PROXY_URL` to opt into residential
   * proxy routing for the SSR fast-path (plan-v10 Phase A). */
  proxy?: string;
}

/**
 * Attempt a libcurl-impersonate GET via the Kuri sandbox. Returns null on
 * timeout, network error, non-2xx, or HTML body too small to be useful.
 *
 * Caller decides what to do with the result:
 *  - Run extractFromDOM on html → harvest endpoints from embedded SSR data
 *  - Synthesize page_fetch endpoint pointing at url
 *  - Publish skill so phase 2 of the bench has something to call
 */
export async function trySsrFastPathOnBlock(input: SsrFastPathInput): Promise<SsrFastPathResult | null> {
  const { url } = input;
  let targetOrigin: string;
  try {
    targetOrigin = new URL(url).origin;
  } catch {
    return null;
  }
  const reqHeaders: Record<string, string> = {
    Accept: "*/*",
    ...(input.extraHeaders ?? {}),
  };
  const headersLiteral = JSON.stringify(reqHeaders).replace(/'/g, "\\'");
  const bundleSource = `(() => {
    const r = __nativeFetch(${JSON.stringify("GET")}, ${JSON.stringify(url)}, ${headersLiteral}, null);
    globalThis.r = { status: r.status, content_type: (r.headers && (r.headers['content-type'] || r.headers['Content-Type'])) || null, body: r.body, final_url: r.url };
  })()`;

  try {
    const resp = await runBundleReplay({
      targetOrigin,
      targetHref: url,
      bundleSource,
      postEval: "globalThis.r",
      fingerprint: input.fingerprint ?? "chrome_mac_arm",
      impersonate: input.impersonate ?? "chrome131",
      timeoutMs: input.timeoutMs ?? 15_000,
      seedCookies: input.seedCookies,
      ...(input.proxy ? { proxy: input.proxy } : {}),
    }, { kuriBase: input.kuriBase });

    if (!resp.ok) return null;

    // post_eval is the JSON-encoded result of `globalThis.r` from the bundle.
    let parsed: { status?: number; body?: string; final_url?: string; content_type?: string } | null = null;
    if (typeof resp.post_eval === "string") {
      try { parsed = JSON.parse(resp.post_eval); } catch { /* swallow */ }
    } else if (resp.post_eval && typeof resp.post_eval === "object") {
      parsed = resp.post_eval as typeof parsed;
    }
    if (!parsed) return null;

    const status = parsed.status ?? 0;
    const html = typeof parsed.body === "string" ? parsed.body : "";

    // Guard rails (mirror tryHttpFetch's existing checks):
    //   - status 2xx
    //   - html non-trivial (>= 1KB)
    if (status < 200 || status >= 400) return null;
    if (!html || html.length < 1024) return null;

    return {
      html,
      status,
      observed_routes: resp.routes_observed ?? [],
      final_url: parsed.final_url ?? url,
      cookies: (resp.cookies ?? []).map((c) => ({ name: c.name, value: c.value, domain: c.domain ?? targetOrigin })),
      ms: resp.ms ?? 0,
    };
  } catch {
    return null;
  }
}
