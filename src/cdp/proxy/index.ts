// CDP_PRIMITIVES.md §iproyal-proxy-as-breath-effect — plane re-exports + per-context attach
//
// Eph 6:11 — "Put on the whole armor of God." The proxy plane is the
// network-layer armor; this file composes its pieces (iproyal residential
// IP + libcurl-impersonate TLS re-fingerprint + auth-challenge handler).
//
// W13 — real composition surface. `buildProxyChain()` returns the right
// shape so the rest of v7 compiles against it and the chain ALWAYS
// terminates honestly (direct connect on missing creds, no TLS spoof on
// missing binary).

export * as iproyal from "./iproyal.js";
export * as libcurlImpersonate from "./libcurl-impersonate.js";
export * as utlsDaemon from "./utls-daemon.js";
export * as authChallenge from "./auth-challenge.js";

import * as iproyalMod from "./iproyal.js";
import * as libcurlMod from "./libcurl-impersonate.js";
import * as utlsDaemonMod from "./utls-daemon.js";

import type { BrowserContext, ProxyConfig, Target } from "../types.js";

export interface ProxyChainOk {
  ok: true;
  /** What Chrome's --proxy-server consumes. */
  chromeProxyServer: string;
  /** Whether TLS JA3/JA4 spoof is armed on this chain. */
  tlsSpoof: boolean;
  /** Iproyal residential IP creds (satisfied via Fetch.continueWithAuth, NEVER URL-embedded). */
  upstream?: ProxyConfig;
  /** Local TLS-spoof front (utls-daemon preferred; libcurl-impersonate legacy), present only when tlsSpoof=true. */
  local?: { url: string; pid: number; binary: string; stop: () => Promise<void> };
  /** Stops every layer in reverse order. Safe to call multiple times. */
  stop: () => Promise<void>;
  /** Honest record of which layers are armed for the receipt. */
  layers: Array<"direct" | "iproyal" | "libcurl_impersonate" | "utls_daemon">;
}

export interface ProxyChainGap {
  ok: false;
  status: 503;
  /** Which layer failed open. */
  error:
    | "iproyal_creds_missing"
    | "iproyal_creds_malformed"
    | "iproyal_creds_unreadable"
    | "libcurl_impersonate_missing"
    | "libcurl_impersonate_not_a_proxy"
    | "libcurl_impersonate_spawn_failed"
    | "utls_proxy_missing"
    | "utls_proxy_spawn_failed"
    | "utls_proxy_not_ready"
    | "utls_proxy_unsupported_platform";
  hint: string;
  /** Whether the caller can fall through to a partial chain (e.g. iproyal-only when only libcurl is missing). */
  partial?: ProxyChainOk;
}

export type ProxyChain = ProxyChainOk | ProxyChainGap;

export interface BuildProxyChainOpts {
  /** Country lock for iproyal residential exit. */
  jurisdiction?: string;
  /** Sticky session id for iproyal. */
  sessionId?: string;
  /** When true, attempt to spawn the libcurl-impersonate TLS front. False = iproyal-only. */
  useTlsSpoof: boolean;
  /** Bypass list passed straight through to Chrome. */
  bypassList?: string;
}

/**
 * Compose the full proxy chain:
 *
 *   Chrome → [local libcurl-impersonate (if useTlsSpoof)] → iproyal → real
 *
 * Failure modes are all HONEST:
 *   - no iproyal creds → direct connect (no proxy at all), `partial` absent
 *   - iproyal creds + no libcurl binary → iproyal-only chain in `partial`
 *   - iproyal + libcurl both present → full chain in the OK branch
 *
 * Chrome's `--proxy-server` always points at the OUTERMOST hop of the
 * armed chain: the local libcurl-impersonate URL when spoof is armed,
 * the iproyal `host:port` otherwise. iproyal credentials are satisfied
 * via Fetch.continueWithAuth at request time (see ./auth-challenge.ts) —
 * Chrome rejects URL-embedded creds in --proxy-server (W9-C finding).
 */
export async function buildProxyChain(opts: BuildProxyChainOpts): Promise<ProxyChain> {
  // ── Layer 1: iproyal ───────────────────────────────────────────────────
  const credsResult = await iproyalMod.load();
  if (credsResult.ok !== true) {
    // No iproyal creds → direct connect is the only honest answer.
    // We still return ok:false so the caller's receipt records the gap.
    return {
      ok: false,
      status: 503,
      error: credsResult.error,
      hint: credsResult.hint,
    };
  }

  const upstream = iproyalMod.buildIproyalProxy({
    username: credsResult.creds.username,
    password: credsResult.creds.password,
    host: credsResult.creds.host,
    port: credsResult.creds.port,
    country: opts.jurisdiction,
    sessionId: opts.sessionId,
    bypassList: opts.bypassList,
  });

  // ── Layer 2 (optional): libcurl-impersonate TLS front ───────────────────
  if (!opts.useTlsSpoof) {
    const stop = async () => {
      /* iproyal is stateless on our side — nothing to stop */
    };
    return {
      ok: true,
      chromeProxyServer: upstream.server,
      tlsSpoof: false,
      upstream,
      stop,
      layers: ["iproyal"],
    };
  }

  // ── Layer 2 path-A: utls-daemon (preferred, W13.1) ─────────────────────
  // Default ON; opt-out via `UNBROWSE_UTLS_PROXY=0`. Old env name
  // `UNBROWSE_LIBCURL_IMPERSONATE_PROXY_MODE` is honored only when the
  // new var is absent (backwards-compat during rip; see W13).
  const newOptIn = process.env.UNBROWSE_UTLS_PROXY;
  const legacyOptIn = process.env.UNBROWSE_LIBCURL_IMPERSONATE_PROXY_MODE;
  const preferUtls =
    newOptIn === "1" || newOptIn === "true" || newOptIn === undefined ? true : false;

  const partialIproyal: ProxyChainOk = {
    ok: true,
    chromeProxyServer: upstream.server,
    tlsSpoof: false,
    upstream,
    stop: async () => {
      /* no-op */
    },
    layers: ["iproyal"],
  };

  if (preferUtls) {
    const probe = utlsDaemonMod.probeAvailable();
    if (probe.available) {
      const daemon = await utlsDaemonMod.start({
        upstream,
        upstreamAuth: `${upstream.username ?? ""}:${upstream.password ?? ""}`,
      });
      if (daemon.ok === true) {
        const stop = async () => {
          try {
            await daemon.stop();
          } catch {
            /* best-effort */
          }
        };
        return {
          ok: true,
          chromeProxyServer: daemon.localProxyUrl,
          tlsSpoof: true,
          upstream,
          local: {
            url: daemon.localProxyUrl,
            pid: daemon.pid,
            binary: daemon.binary,
            stop: daemon.stop,
          },
          stop,
          layers: ["utls_daemon", "iproyal"],
        };
      }
      // utls-daemon spawn failed → fall through to legacy libcurl path,
      // and if that also fails, surface the utls error with partial iproyal.
      if (legacyOptIn !== "1") {
        return {
          ok: false,
          status: 503,
          error: daemon.error,
          hint: daemon.hint,
          partial: partialIproyal,
        };
      }
    }
    // Binary missing AND no legacy opt-in → honest 503 with iproyal partial.
    if (legacyOptIn !== "1") {
      return {
        ok: false,
        status: 503,
        error: "utls_proxy_missing",
        hint: probe.hint ?? "utls-proxy not available; iproyal-only chain offered as partial.",
        partial: partialIproyal,
      };
    }
  }

  // ── Layer 2 path-B: libcurl-impersonate (legacy / opt-in only) ─────────
  const front = await libcurlMod.start({ upstream });
  if (front.ok !== true) {
    return {
      ok: false,
      status: 503,
      error: front.error,
      hint: front.hint,
      partial: partialIproyal,
    };
  }

  const stop = async () => {
    try {
      await front.stop();
    } catch {
      /* best-effort */
    }
  };
  return {
    ok: true,
    chromeProxyServer: front.localProxyUrl,
    tlsSpoof: true,
    upstream,
    local: { url: front.localProxyUrl, pid: front.pid, binary: front.binary, stop: front.stop },
    stop,
    layers: ["libcurl_impersonate", "iproyal"],
  };
}

/**
 * Attach a proxy to an existing BrowserContext. CDP path:
 *   Target.createBrowserContext({proxyServer, proxyBypassList}) — at creation
 *   Fetch.continueWithAuth — satisfies proxy auth on Fetch.requestPaused
 *
 * NOTE: per CDP, the proxy is set at CONTEXT-CREATION (Target.createBrowser-
 * Context) — not via a post-hoc mutator. This function is the no-op
 * acknowledgement path used by callers that already created the context
 * with the right `{proxyServer, proxyBypassList}` (per
 * src/cdp/target.ts:createBrowserContext) and now want a receipt-shaped
 * confirmation.
 */
export async function attachProxy(
  _ctx: BrowserContext,
  _proxy: ProxyConfig,
): Promise<{ attached: true; note: string }> {
  return {
    attached: true,
    note:
      "Proxy is set at Target.createBrowserContext({proxyServer}); pass the ProxyConfig there. The runtime Fetch.continueWithAuth handler installs via installProxyAuthHandler.",
  };
}

/**
 * Install a Fetch.requestPaused handler on a target that auto-fills proxy
 * auth via the auth-challenge helper. Returns an unsubscribe.
 *
 * The handler is OPT-IN — the caller arms Fetch.enable with
 * `handleAuthRequests: true` first, then subscribes here.
 */
export function installProxyAuthHandler(target: Target, proxy: ProxyConfig): () => void {
  // Dynamic import to keep auth-challenge out of the synchronous import graph
  // for callers that never use the proxy plane.
  type AuthMod = typeof import("./auth-challenge.js");
  let unsubscribed = false;

  const unsubscribe = target.cdp.on(
    "Fetch.authRequired",
    async (params: unknown, sessionId?: string) => {
      if (unsubscribed) return;
      const p = params as {
        requestId: string;
        authChallenge?: { source?: "Server" | "Proxy"; origin?: string; scheme?: string; realm?: string };
      };
      const authMod = (await import("./auth-challenge.js")) as AuthMod;
      const { continueWithAuth } = await authMod.handle(proxy, {
        source: p.authChallenge?.source ?? "Proxy",
        origin: p.authChallenge?.origin ?? "",
        scheme: p.authChallenge?.scheme ?? "",
        realm: p.authChallenge?.realm ?? "",
      });
      try {
        await target.cdp.call(
          "Fetch.continueWithAuth",
          { requestId: p.requestId, ...continueWithAuth },
          sessionId ?? target.sessionId,
        );
      } catch {
        /* best-effort — auth failure is logged elsewhere via decision_trace */
      }
    },
  );

  return () => {
    unsubscribed = true;
    try {
      unsubscribe();
    } catch {
      /* best-effort */
    }
  };
}
