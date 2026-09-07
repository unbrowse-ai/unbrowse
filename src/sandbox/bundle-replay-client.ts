/**
 * bundle-replay-client.ts — Node-side wrapper for Kuri's /v1/sandbox/replay.
 *
 * Talks to a running Kuri instance (default http://127.0.0.1:6969) and runs an
 * anti-bot / signed-URL / HMAC bundle in a sandboxed QuickJS runtime with
 * curl-impersonate as the network adapter.
 *
 * Usage:
 *   import { runBundleReplay } from "./sandbox/bundle-replay-client";
 *   const r = await runBundleReplay({
 *     targetOrigin: "https://www.reddit.com",
 *     targetHref:   "https://www.reddit.com/search/?q=foo",
 *     bundleUrl:    "https://www.reddit.com/_px/captcha-bundle.js",
 *     postEval:     "JSON.stringify({ pxToken: localStorage.getItem('_px3') })",
 *   });
 *   // r.cookies[]   — harvested set-cookies (attach to the real call)
 *   // r.postEval    — JSON-stringified result of postEval expression
 *   // r.ms          — wall-clock total
 *
 * This is the consumer half of the deep-reveng plan in docs/deep-reveng.md.
 */

export interface SandboxReplayRequest {
  /** Origin of the target site, e.g. "https://reddit.com". Used by the shim's
   * location.origin, document.domain, and as the default for cookie scoping. */
  targetOrigin: string;
  /** Full URL the bundle thinks it's running on. Defaults to targetOrigin if
   * omitted. The shim's location.* accessors return parsed pieces of this. */
  targetHref?: string;
  /** Either bundleUrl OR bundleSource must be provided. */
  bundleUrl?: string;
  bundleSource?: string;
  /** Fingerprint pool key. "chrome_mac_arm" | "chrome_windows" for Phase 1. */
  fingerprint?: "chrome_mac_arm" | "chrome_windows";
  /** curl-impersonate target profile. Match to your installed binary. */
  impersonate?: string;
  /** JS expression evaluated AFTER the bundle runs. Result returned verbatim
   * as `post_eval` in the response (already JSON-stringified by the runtime). */
  postEval?: string;
  /** Wall-clock cap in ms. Default 5000. */
  /** Wall-clock cap in ms. Default 5000. */
  timeoutMs?: number;
  /** Cookies to populate the sandbox jar with BEFORE the bundle runs.
   * Same shape as findBestBrowserSession's BrowserCookie output, so you can
   * pass cookies extracted from the user's real Chrome/Arc/Brave directly. */
  seedCookies?: SeedCookie[];
  /** Optional proxy URL — e.g. "http://user:pass@host:port" or "socks5://host:port".
   * Forwarded to Kuri's libcurl-impersonate handle via CURLOPT_PROXY (plan-v10
   * Phase A). Requires Kuri >= the SHA carrying the CURLOPT_PROXY patches in
   * sandbox/curl_lib.zig (see plan-v11). When the vendored Kuri binary doesn't
   * support proxy, the field is silently ignored on the Kuri side. */
  proxy?: string;
}

/** Seed cookie shape — compatible with src/auth/browser-cookies.ts BrowserCookie. */
export interface SeedCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  /** Both `httpOnly` (browser-cookies output) and `http_only` accepted. */
  httpOnly?: boolean;
  http_only?: boolean;
  /** `sameSite` (browser-cookies output) or `same_site`. */
  sameSite?: string;
  same_site?: string;
  expires?: number;
}

export interface SandboxCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number; // unix seconds, 0 = session
  secure: boolean;
  http_only: boolean;
  same_site: string;
}

export interface ObservedRoute {
  url: string;
  method: string;
  status: number;
  final_url: string;
  content_type: string;
  body_excerpt: string;
  body_size: number;
  redirected: boolean;
}

export interface SandboxReplayResponse {
  ok: boolean;
  ms: number;
  egress_bytes: number;
  cookies: SandboxCookie[];
  /** Present iff postEval was passed. JSON-encoded result of the expression. */
  post_eval?: string;
  /** Every __nativeFetch call the bundle made. Caller can feed these
   * through extractEndpoints + publish to contribute to the marketplace
   * flywheel. */
  routes_observed: ObservedRoute[];
}

const DEFAULT_KURI_BASE = process.env.KURI_BASE_URL ?? "http://127.0.0.1:6969";

function isLocalOnly(): boolean {
  return process.env.UNBROWSE_LOCAL_ONLY === "1";
}

/**
 * U-12 privacy fix: is this replay target the user's own machine (loopback)
 * or a remote host? When LOCAL_ONLY is set we must refuse to ship the
 * executable `bundle_source` + the local proxy URL to anything that isn't
 * loopback — those would otherwise leave the machine for Unbrowse infra.
 */
export function isLoopbackBase(base: string): boolean {
  let host: string;
  try {
    host = new URL(base).hostname.toLowerCase();
  } catch {
    return false;
  }
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]" ||
    host.endsWith(".localhost")
  );
}

export class BundleReplayError extends Error {
  constructor(public readonly status: number, public readonly body: string) {
    super(`sandbox replay failed: HTTP ${status}: ${body.slice(0, 200)}`);
    this.name = "BundleReplayError";
  }
}

export class LocalOnlyReplayError extends Error {
  constructor(base: string) {
    super(
      `UNBROWSE_LOCAL_ONLY=1: refusing to ship bundle_source + proxy to non-loopback sandbox host (${base}). ` +
        `Point KURI_BASE_URL at a local Kuri (127.0.0.1) to run replay on this machine.`,
    );
    this.name = "LocalOnlyReplayError";
  }
}

export async function runBundleReplay(
  req: SandboxReplayRequest,
  opts: { kuriBase?: string; signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<SandboxReplayResponse> {
  const base = opts.kuriBase ?? DEFAULT_KURI_BASE;
  const fetchImpl = opts.fetchImpl ?? fetch;

  // U-12: when LOCAL_ONLY is set, the executable bundle_source and the local
  // proxy URL must never leave the machine. A loopback Kuri is still allowed
  // (replay runs on the user's own box); any remote host is refused.
  const localOnly = isLocalOnly();
  if (localOnly && !isLoopbackBase(base)) {
    throw new LocalOnlyReplayError(base);
  }

  const body = JSON.stringify({
    target_origin: req.targetOrigin,
    target_href: req.targetHref,
    bundle_url: req.bundleUrl,
    bundle_source: req.bundleSource,
    fingerprint: req.fingerprint ?? "chrome_mac_arm",
    impersonate: req.impersonate ?? "chrome131",
    post_eval: req.postEval,
    timeout_ms: req.timeoutMs ?? 30_000,
    seed_cookies: req.seedCookies?.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain ?? "",
      path: c.path ?? "/",
      secure: c.secure ?? false,
      http_only: c.http_only ?? c.httpOnly ?? false,
      same_site: c.same_site ?? c.sameSite ?? "",
      expires: c.expires ?? 0,
    })),
    // U-12: never ship the user's local proxy URL (corporate proxy / VPN /
    // mitmproxy — may itself carry proxy-auth creds) when LOCAL_ONLY is set.
    ...(req.proxy && !localOnly ? { proxy: req.proxy } : {}),
  });

  const resp = await fetchImpl(`${base}/v1/sandbox/replay`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    signal: opts.signal,
  });

  const text = await resp.text();
  if (!resp.ok) {
    throw new BundleReplayError(resp.status, text);
  }
  let parsed: SandboxReplayResponse;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BundleReplayError(resp.status, `invalid JSON: ${text.slice(0, 200)}`);
  }
  return parsed;
}

/**
 * Format a cookie array as a Cookie header value, suitable for attaching to a
 * follow-up call into the real API.
 */
export function cookiesToHeaderValue(cookies: SandboxCookie[]): string {
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}
