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
 * Egress default: DIRECT. There is NO baked-in proxy. Proxying is strictly
 * opt-in; `resolveEgressProxy` resolves an outbound proxy in this order:
 *   1. UNBROWSE_DIRECT_EGRESS=1 → undefined (explicit direct, dev/health-check path)
 *   2. UNBROWSE_PROXY_URL set    → use it verbatim (user / CI override wins)
 *   3. IPROYAL creds present     → compose IProyal URL (env or ~/.identity/iproyal-creds)
 *   4. UNBROWSE_PROXYKINGDOM_URL → that x402 proxy URL (operator opt-in)
 *   5. else                      → undefined (DIRECT)
 *
 * A hardcoded `proxykingdom.cn2.ai` default previously sat at step 5,
 * silently routing every fresh user's browser + fetch egress through an
 * x402-gated proxy. With no wallet wired that proxy is unreachable, and
 * Chrome's `--proxy-server` (set by the Kuri bridge) has no graceful
 * degrade — so every navigation died with ERR_TUNNEL_CONNECTION_FAILED and
 * `fetch` returned a cryptic "No matching skill found". The default was
 * removed; an operator who wants a residential/x402 pool sets one of the
 * opt-in vars above.
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
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { x402Fetch, type X402SubState } from "../payments/x402-fetch.js";
import { peekFailure, recordFailure, recordOutcome } from "../values/failure-cache.js";
import { loadCredsFileSync } from "../cdp/proxy/iproyal.js";

// CROSS-PROCESS-stable IProyal sticky-session id. The exit IP an IProyal sticky
// session maps to is held for `lifetime` (default 30m). The WAF clearance a site
// hands out (Tencent WAF ticket, cf_clearance, ...) is IP-BOUND — so a
// `unbrowse auth` (interactive solve, process A) and a later `unbrowse fetch`
// (process B) MUST exit from the SAME residential IP or the clearance is worthless
// and the WAF re-challenges. A per-process-random id breaks that: A and B roll
// different ids → different IPs → re-challenge + rate-limit ("Refreshing too often").
//
// So the session id is PERSISTED to ~/.unbrowse/iproyal-session.json and reused by
// every unbrowse process for the window below — one stable residential identity the
// solved clearance stays bound to. Refreshes after STICKY_SESSION_MAX_AGE_MS (kept
// under IProyal's lifetime so we never reuse an id whose IP already rotated).
// Override per-call via UNBROWSE_IPROYAL_SESSION; opt out of persistence with
// UNBROWSE_IPROYAL_SESSION_PERSIST=0 (back to per-process-random).
const STICKY_SESSION_MAX_AGE_MS = 25 * 60_000; // < IProyal default lifetime (30m)

function stickySessionStatePath(env: NodeJS.ProcessEnv): string {
  const base = env.UNBROWSE_STATE_DIR?.trim() || join(homedir(), ".unbrowse");
  return join(base, "iproyal-session.json");
}

let _processStickyFallback: string | undefined;

/** Resolve the cross-process-stable sticky session id (see block comment above). */
export function stickySessionId(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.UNBROWSE_IPROYAL_SESSION?.trim();
  if (explicit) return explicit;

  const persistOff = (env.UNBROWSE_IPROYAL_SESSION_PERSIST ?? "").trim().toLowerCase();
  if (persistOff === "0" || persistOff === "false" || persistOff === "no") {
    return (_processStickyFallback ??= randomBytes(4).toString("hex"));
  }

  const path = stickySessionStatePath(env);
  try {
    const st = statSync(path);
    if (Date.now() - st.mtimeMs < STICKY_SESSION_MAX_AGE_MS) {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { id?: unknown };
      if (typeof parsed.id === "string" && parsed.id.length > 0) return parsed.id;
    }
  } catch {
    /* missing / unreadable / expired → mint a fresh one below */
  }

  const id = randomBytes(4).toString("hex");
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify({ id, createdAt: Date.now() }), { mode: 0o600 });
  } catch {
    /* state dir unwritable — degrade to in-process stability for this run */
    return (_processStickyFallback ??= id);
  }
  return id;
}

/**
 * Append IProyal sticky-session params to the PASSWORD segment (the documented IProyal grammar
 * — keys live in the password, NOT the username: `pass_country-my,sg_session-<id>_lifetime-30m`).
 *
 * ON BY DEFAULT: a STABLE residential IP per process is more human-like (rotating a fresh IP on
 * every request is itself a bot signal anti-bot systems flag), and it lets an IP-bound cookie /
 * cf_clearance from a capture survive the replay. Opt OUT with UNBROWSE_IPROYAL_STICKY=0 (back to
 * rotating — better only for high-volume API scraping where per-IP rate limits dominate). Tunable:
 *   UNBROWSE_IPROYAL_COUNTRY   e.g. "my,sg" (comma-joined, kept literal — never URL-encoded)
 *   UNBROWSE_IPROYAL_SESSION   stable id (default: per-process STICKY_SESSION_ID)
 *   UNBROWSE_IPROYAL_LIFETIME  session lifetime, default "30m" (IProyal min 1s, max 7d)
 * Returns the raw suffix to append AFTER the URL-encoded base password (so the comma survives).
 */
export function iproyalStickySuffix(env: NodeJS.ProcessEnv = process.env): string {
  const off = (env.UNBROWSE_IPROYAL_STICKY ?? "").trim().toLowerCase();
  if (off === "0" || off === "false" || off === "no") return ""; // explicit opt-out → rotating
  const country = env.UNBROWSE_IPROYAL_COUNTRY?.trim();
  const session = stickySessionId(env);
  const lifetime = env.UNBROWSE_IPROYAL_LIFETIME?.trim() || "30m";
  return `${country ? `_country-${country}` : ""}_session-${session}_lifetime-${lifetime}`;
}

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
  skipped_reason?: "creds_missing" | "runtime_unsupported" | "proxy_dead_fellback_raw";
}

/** Build the IProyal proxy URL from env. Returns undefined when creds are
 *  missing — caller emits the "creds_missing" decision_trace step. */
export function resolveProxyUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  let user = env.IPROYAL_USER?.trim();
  let pass = env.IPROYAL_PASS?.trim();
  let host = env.IPROYAL_HOST?.trim();
  let port = env.IPROYAL_PORT?.trim();
  // Env wins; otherwise fall back to the persistent ~/.identity/iproyal-creds
  // file (the same source the browser/CDP proxy reads), so a single creds file
  // bakes IProyal into BOTH the browser and the fetch/network-descent egress.
  // The secret stays in ~/.identity (mode 600), never in source.
  if (!user || !pass) {
    const f = loadCredsFileSync();
    if (f) {
      user ||= f.username;
      pass ||= f.password;
      host ||= f.host;
      port ||= String(f.port);
    }
  }
  if (!user || !pass) return undefined;
  host = host || "geo.iproyal.com";
  port = port || "12321";
  // Encode the base creds; append the sticky suffix RAW (its comma/underscore are IProyal
  // routing grammar, not data — URL-encoding the comma to %2C breaks the country list).
  return `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}${iproyalStickySuffix(env)}@${host}:${port}`;
}

/**
 * Resolve the outbound proxy URL the runtime should use for THIS request.
 *
 * Egress is DIRECT by default — there is NO baked-in default proxy. A proxy is
 * used ONLY when the operator explicitly opts in. Order (first match wins):
 *   1. UNBROWSE_DIRECT_EGRESS=1 / true / yes → undefined (explicit direct)
 *   2. UNBROWSE_PROXY_URL set                → verbatim
 *   3. IProyal creds present (env or ~/.identity/iproyal-creds) → resolveProxyUrl(env)
 *   4. UNBROWSE_PROXYKINGDOM_URL set         → that x402 proxy URL
 *   5. else                                  → undefined (DIRECT)
 *
 * History: a hardcoded `proxykingdom.cn2.ai` default used to sit at step 5,
 * silently routing every fresh user's browser + fetch egress through an
 * x402-gated proxy. When that proxy is unreachable (the common case for a
 * user with no wallet wired) Chrome's `--proxy-server` has no graceful
 * degrade and every navigation died with ERR_TUNNEL_CONNECTION_FAILED, while
 * `fetch` fell through to a cryptic "No matching skill found". The default is
 * removed: proxying is now strictly opt-in.
 */
export function resolveEgressProxy(
  env: NodeJS.ProcessEnv = process.env,
  failureDir?: string,
): string | undefined {
  const direct = env.UNBROWSE_DIRECT_EGRESS?.trim().toLowerCase();
  if (direct === "1" || direct === "true" || direct === "yes") return undefined;

  const explicit = env.UNBROWSE_PROXY_URL?.trim();
  if (explicit) return explicit;

  const iproyal = resolveProxyUrl(env);
  if (iproyal) {
    // Health-gated ladder (2026-06-20): try the proxy, but fall back to RAW
    // (direct) the moment it has recently DIED. A proxy connection failure is
    // recorded as a `structural` failure against the proxy host (see
    // proxiedFetchOnce), so this peek skips a known-dead proxy and egress goes
    // direct instead of hard-failing. `failureKey` normalizes to the proxy host,
    // so the creds-bearing URL and a bare host:port share one cooldown key.
    const cooldown = peekFailure(iproyal, "proxy", failureDir);
    // structural = provider dead; transient = connection refused / timeout. Both
    // mean "the proxy can't carry this request right now" -> degrade to RAW.
    // antibot (the exit IP got challenged by a target) is a per-target axis, not
    // a dead proxy, so it does NOT force raw here.
    if (cooldown === "structural" || cooldown === "transient") return undefined;
    return iproyal;
  }

  // No baked default. ProxyKingdom (or any x402 proxy) is opt-in ONLY via an
  // explicit UNBROWSE_PROXYKINGDOM_URL. Absent it, egress is DIRECT.
  const override = env.UNBROWSE_PROXYKINGDOM_URL?.trim();
  if (!override) return undefined;
  // Negative-cache layer: if this x402 proxy is in a fresh STRUCTURAL cooldown (e.g. the
  // provider returned NO_AVAILABLE_KEYS / 503-dead recently), don't keep routing captures
  // through a known-dead proxy — fail-fast to direct egress until the cooldown expires.
  // (antibot/transient cooldowns do NOT disable the proxy: a fresh IP may still help.)
  if (peekFailure(override, "proxy", failureDir) === "structural") return undefined;
  return override;
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
  let ProxyAgent: typeof import("undici").ProxyAgent;
  try {
    ({ ProxyAgent } = (await import("undici")) as typeof import("undici"));
  } catch {
    // undici not installed and not on bun — surface honestly (NOT a proxy death).
    const response = await fetch(url, init);
    return { response, dispatch: { dispatched: false, skipped_reason: "runtime_unsupported" } };
  }
  try {
    const dispatcher = new ProxyAgent(proxyUrl);
    const response = await fetch(url, {
      ...init,
      // @ts-expect-error node-undici extension
      dispatcher,
    });
    return { response, dispatch: { dispatched: true } };
  } catch (err) {
    // The proxy DIED mid-request (ECONNREFUSED / tunnel failed / timeout). Record a
    // structural failure so resolveEgressProxy's health gate degrades the NEXT call
    // to raw instead of re-dialing a dead proxy, then fall back to RAW for THIS call.
    recordFailure(proxyUrl, "structural", "proxy");
    const response = await fetch(url, init);
    return {
      response,
      dispatch: { dispatched: false, skipped_reason: "proxy_dead_fellback_raw" },
    };
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
 * proxies (an opt-in UNBROWSE_PROXYKINGDOM_URL),
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
      // Proxy didn't serve a 402 at the handshake path — either it's not x402-shaped,
      // or the provider is dead. Record the outcome so a structurally-dead provider
      // (e.g. 503 NO_AVAILABLE_KEYS) lands in the negative cache and resolveEgressProxy
      // stops routing through it until the cooldown expires.
      let body = "";
      try { body = (await response.text()).slice(0, 500); } catch { /* ignore */ }
      recordOutcome(proxyUrl, { status: response.status, body }, "proxy");
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
    // Network-level handshake failure (DNS, connect, timeout) → transient cooldown.
    recordFailure(proxyUrl, "transient", "proxy");
    return {
      proxy_authorization: null,
      sub_state: "x402_signer_error",
      proxy_url: proxyUrl,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

