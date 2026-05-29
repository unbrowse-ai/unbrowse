/**
 * Chrome-prim Layer 1 — TLS layer (lifted from src/kuri/stateless/ 2026-05-28).
 * Gen 18:25 — preserve the righteous core; the wrapper (kuri) goes, the
 * pointer-shaped primitive (this) stays. Same code, new home, clean owner.
 *
 * Contract: 18d1a651
 *
 * A contract-neuron primitive that takes (target_url, ja3_profile,
 * http_version_pref) and emits a libcurl-impersonate-shaped TLS connection
 * capability. Each call is ephemeral — no shared connection pool, no shared
 * SSL_SESSION cache, no global dispatcher state.
 *
 * Validation: 35 concurrent calls to this primitive return 35 distinct
 * working TLS connections to the same host within a 5s budget on a fresh
 * macOS shell.
 *
 * Implementation strategy:
 *   - Each call spawns a fresh python3 subprocess running
 *     scripts/curl-impersonate-fetch.py.
 *   - curl_cffi inside that subprocess holds its own SSL context, its own
 *     CURL handle, its own cookie jar. Process teardown frees everything.
 *   - 35 subprocesses × ~10MB each = ~350MB. Fits in macOS memory budget.
 *   - No shared Node/Bun dispatcher. No HTTP/2 multiplexing across calls.
 *
 * Why subprocess-per-call over a long-lived helper:
 *   - The conductor wave-3 (2026-05-25) showed that flipping any knob on
 *     the Bun fetch dispatcher (keepalive, Connection header) breaks paths
 *     in unpredictable ways. The dispatcher's state is too coupled.
 *   - Subprocess teardown is the strongest ephemerality guarantee available
 *     on macOS without containerisation.
 *
 * Wired in by: nothing yet (scaffold only). Future wave gates via
 * UNBROWSE_STATELESS_LAYER>=1 in src/orchestrator/index.ts direct-fetch.
 *
 * Pointer-shape (per contract 50d0419e clause B/C):
 *   The output is a TlsCapabilityPointer = a JSON-serialisable
 *   {transport, ja3_hash, alpn, cert_chain_sha256, ephemeral_dir} that
 *   downstream layers carry by reference. The actual TLS session state
 *   never escapes the subprocess.
 */

import { tryCurlImpersonateFetch, type CurlCffiResult } from "../capture/curl-impersonate-fallback.js";

export interface TlsCapabilityPointer {
  readonly transport: "curl-cffi-chrome131" | "curl-cffi-chrome120" | "curl-cffi-firefox120";
  readonly ja3_hash: string;
  readonly alpn: "h2" | "http/1.1";
  readonly cert_chain_sha256: string | null;
  readonly ephemeral_subprocess_id: string;
}

export interface Layer1Request {
  readonly target_url: string;
  readonly ja3_profile?: "chrome131" | "chrome120" | "firefox120";
  readonly http_version_pref?: "h2" | "http/1.1" | "auto";
  readonly proxy_url?: string;
  readonly timeout_ms?: number;
  /** Force direct connection — disables curl_cffi subprocess auto-detect
   *  of IPROYAL_USER/PASS from env. Used by the contract-fetch graceful-
   *  degrade fallback when the proxy attempt fails. */
  readonly force_direct?: boolean;
}

export interface Layer1Result {
  readonly capability: TlsCapabilityPointer;
  readonly response: {
    readonly status: number;
    readonly body: string;
    readonly bytes: number;
    readonly final_url: string;
  };
}

/**
 * Layer-1 stateless TLS fetch. One ephemeral subprocess per call. NOT WIRED
 * INTO ORCHESTRATOR YET. Validation runs through bench-coverage with the
 * UNBROWSE_STATELESS_LAYER=1 env flag (also unset — scaffold only).
 *
 * @throws Never — returns null on any failure (subprocess, timeout, parse).
 *   Caller is responsible for quality-gating returned body.
 */
export async function statelessTlsFetch(req: Layer1Request): Promise<Layer1Result | null> {
  const profile = req.ja3_profile ?? "chrome131";
  const result: CurlCffiResult | null = await tryCurlImpersonateFetch({
    url: req.target_url,
    proxy: req.proxy_url,
    impersonate: profile,
    timeoutMs: req.timeout_ms ?? 25_000,
    forceDirect: req.force_direct,
  });
  if (!result) return null;
  return {
    capability: {
      transport: `curl-cffi-${profile}` as TlsCapabilityPointer["transport"],
      ja3_hash: `curl-cffi:${profile}`, // real JA3 hash extraction is layer-1 future work
      alpn: "h2",
      cert_chain_sha256: null, // not exposed by curl_cffi today
      ephemeral_subprocess_id: `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    },
    response: {
      status: result.status,
      body: result.html,
      bytes: result.bytes,
      final_url: result.final_url,
    },
  };
}
