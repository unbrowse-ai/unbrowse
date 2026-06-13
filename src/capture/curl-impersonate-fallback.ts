/**
 * curl_cffi Python-helper fallback for the SSR-fastpath rescue chain.
 *
 * Why it exists: Kuri's /v1/sandbox/replay (trySsrFastPathOnBlock) is the
 * primary SSR-fastpath. When that returns no_html (Kuri unavailable, sandbox
 * endpoint not impersonating, upstream non-200 with HTML body, etc.), this is
 * the tertiary fallback. Shells to scripts/curl-impersonate-fetch.py which
 * wraps curl_cffi (pip-installable patched curl with Chrome131 JA3/JA4 spoof).
 *
 * Boundary mapped 2026-05-25 via direct probing:
 *   - youtube class (TLS-fingerprint-only): PASS with 1.05 MB real content
 *   - reddit class (JS-challenge interstitial): BLOCKED, needs T6.2 real Chrome
 *   - ebay class (Akamai hard-block): BLOCKED, needs separate approach
 *
 * Composes with resolveAntibotProxy() in src/execution/index.ts (T2): the
 * helper auto-detects IPROYAL_USER+IPROYAL_PASS env, or accepts an explicit
 * proxy URL. Same fallback semantics — only fires when local CLI runtime has
 * Python 3 + curl_cffi available; cleanly skips on Cloudflare Worker (no
 * subprocess capability) or when the helper script returns error.
 *
 * Standing-gate: DEFERRED-T6.1 was "install curl-impersonate locally" — this
 * supersedes by shipping the Python wheel path that works on macOS-arm64
 * without a C compiler / system curl-impersonate package.
 */

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { resolveEgressProxy } from "../execution/proxy-fetch.js";
import { resolveWalletConfig } from "../payments/x402-fetch.js";
import { payShAvailable } from "../payments/pay-sh.js";
import { peekFailure, recordOutcome } from "../values/failure-cache.js";

export interface CurlCffiResult {
  status: number;
  bytes: number;
  html: string;
  final_url: string;
  proxy_used: boolean;
  impersonate: string;
}

export interface CurlCffiOptions {
  url: string;
  proxy?: string;
  impersonate?: string;
  timeoutMs?: number;
  scriptPath?: string;
  /** Force direct connection even if IPROYAL_* env is set — the subprocess
   *  gets UNBROWSE_NO_PROXY=1 in its env to suppress auto-detect. Used by
   *  the contract-fetch graceful-degrade path when the proxy fails. */
  forceDirect?: boolean;
  /** Cookies to send (Cookie header). Lets cookie-gated sites (reddit,
   *  logged-in pages) return their real content rather than a block page.
   *  Seeded by the caller from the local browser profile / vault. */
  cookies?: Array<{ name: string; value: string }>;
}

/**
 * Attempt curl_cffi-via-python fetch. Returns null on any failure (helper
 * not installed, subprocess error, non-200 response without body, timeout).
 * Caller is responsible for quality-gating the returned html (size threshold,
 * content extraction confidence).
 */
export async function tryCurlImpersonateFetch(opts: CurlCffiOptions): Promise<CurlCffiResult | null> {
  const scriptPath = opts.scriptPath ?? resolve(process.cwd(), "scripts/curl-impersonate-fetch.py");
  const timeoutMs = opts.timeoutMs ?? 30_000;
  // Bake the residential egress into the packet-layer (fingerprint-faithful)
  // fetch: when the caller didn't pin a proxy and isn't forcing direct, descend
  // through the resolved egress. resolveEgressProxy reads ~/.identity/iproyal-creds
  // -> IProyal (the same source the browser + TS-fetch paths use), so one creds
  // file routes every layer of the network descent through the residential pool.
  const proxy = opts.forceDirect ? undefined : (opts.proxy ?? resolveEgressProxy());
  const args = [scriptPath, opts.url];
  if (proxy) { args.push("--proxy", proxy); }
  if (opts.impersonate) { args.push("--impersonate", opts.impersonate); }
  args.push("--timeout", String(Math.floor(timeoutMs / 1000)));
  if (opts.cookies && opts.cookies.length > 0) {
    const cookieHeader = opts.cookies
      .map((c) => {
        const v = c.value.startsWith('"') && c.value.endsWith('"') ? c.value.slice(1, -1) : c.value;
        return `${c.name}=${v}`;
      })
      .join("; ");
    if (cookieHeader) args.push("--cookies", cookieHeader);
  }

  return await new Promise<CurlCffiResult | null>((resolveP) => {
    let killed = false;
    const childEnv = opts.forceDirect
      ? { ...process.env, UNBROWSE_NO_PROXY: "1" }
      : process.env;
    const child = spawn("python3", args, { stdio: ["ignore", "pipe", "pipe"], env: childEnv });
    let stdout = "";
    const timer = setTimeout(() => {
      killed = true;
      try { child.kill("SIGKILL"); } catch { /* best-effort */ }
      resolveP(null);
    }, timeoutMs + 5_000);

    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.on("error", () => { clearTimeout(timer); resolveP(null); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (killed) return;
      if (code !== 0) { resolveP(null); return; }
      try {
        const parsed = JSON.parse(stdout) as Record<string, unknown>;
        if (typeof parsed.error === "string") { resolveP(null); return; }
        if (typeof parsed.html_b64 !== "string") { resolveP(null); return; }
        const html = Buffer.from(parsed.html_b64, "base64").toString("utf-8");
        const status = Number(parsed.status) || 0;
        const proxyUsed = Boolean(parsed.proxy_used);
        // Negative-cache layer: record an anti-bot / transient outcome so a later capture of
        // the same (site, egress) fails-fast instead of re-paying the rescue. 2xx classifies
        // as null → no record. Keyed by egress so a proxy/direct switch re-probes.
        recordOutcome(opts.url, { status, body: html.slice(0, 800) }, proxyUsed ? "proxy" : "direct");
        resolveP({
          status,
          bytes: Number(parsed.bytes) || 0,
          html,
          final_url: String(parsed.final_url || opts.url),
          proxy_used: proxyUsed,
          impersonate: String(parsed.impersonate || "chrome131"),
        });
      } catch { resolveP(null); }
    });
  });
}

/**
 * Camoufox stealth-Firefox fetch — the JS-challenge-class rescue curl_cffi cannot do.
 * camoufox injects fingerprint spoofing at Firefox's C++ level (invisible to JS), kills
 * CDP/WebRTC leaks, and runs a solve_cloudflare loop, so Cloudflare's "Just a moment…"
 * challenge actually passes (verified: stackoverflow.com/questions → real "Newest Questions"
 * DOM). Yoinked from D4Vinci/Scrapling StealthyFetcher(solve_cloudflare=True); we shell out
 * to a sandboxed venv (no MPL source vendored). Returns null on any failure (helper/venv
 * absent — e.g. the shipped binary without the dev venv — subprocess error, still-blocked,
 * timeout), so callers degrade gracefully.
 */
export async function tryCamoufoxFetch(opts: CurlCffiOptions): Promise<CurlCffiResult | null> {
  const scriptPath = opts.scriptPath ?? resolve(process.cwd(), "scripts/camoufox-fetch.py");
  const pythonPath = resolve(process.cwd(), "scripts/.camoufox-venv/bin/python");
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const proxy = opts.forceDirect ? undefined : (opts.proxy ?? resolveEgressProxy());
  const args = [scriptPath, opts.url, "--timeout", String(Math.floor(timeoutMs / 1000))];
  if (proxy) { args.push("--proxy", proxy); }

  return await new Promise<CurlCffiResult | null>((resolveP) => {
    let killed = false;
    const childEnv = opts.forceDirect ? { ...process.env, UNBROWSE_NO_PROXY: "1" } : process.env;
    let child;
    try {
      child = spawn(pythonPath, args, { stdio: ["ignore", "pipe", "pipe"], env: childEnv });
    } catch { resolveP(null); return; }
    let stdout = "";
    const timer = setTimeout(() => {
      killed = true;
      try { child!.kill("SIGKILL"); } catch { /* best-effort */ }
      resolveP(null);
    }, timeoutMs + 10_000);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.on("error", () => { clearTimeout(timer); resolveP(null); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (killed) return;
      if (code !== 0) { resolveP(null); return; }
      try {
        const parsed = JSON.parse(stdout) as Record<string, unknown>;
        if (typeof parsed.error === "string") { resolveP(null); return; }
        if (typeof parsed.html_b64 !== "string") { resolveP(null); return; }
        if (parsed.solved === false) { resolveP(null); return; }
        const html = Buffer.from(parsed.html_b64, "base64").toString("utf-8");
        resolveP({
          status: Number(parsed.status) || 0,
          bytes: Number(parsed.bytes) || 0,
          html,
          final_url: opts.url,
          proxy_used: Boolean(proxy),
          impersonate: "camoufox",
        });
      } catch { resolveP(null); }
    });
  });
}

/** One x402 fetch-via unblocker endpoint: POST a target URL, get its HTML back, settled by the
 *  pay adapter. Different providers wrap the response differently, so each carries its own body
 *  builder + parser. The chain tries them in order until one returns real content. */
export interface UnblockerEndpoint {
  /** Stable id — the negative-cache egress key, so each provider's verdict on a target is tracked
   *  separately (a site OnchainExpat can't clear may still be tried via the next provider). */
  id: string;
  url: string;
  body: (target: string, country: string) => string;
  /** Pull {status, html} out of the provider's JSON envelope, or null if unparseable. */
  parse: (json: Record<string, unknown>) => { status: number; html: string } | null;
}

const decodeMaybeB64 = (j: Record<string, unknown>): string => {
  if (typeof j.body === "string") return j.body;
  if (typeof j.body_base64 === "string") return Buffer.from(j.body_base64, "base64").toString("utf-8");
  return "";
};

/** OnchainExpat geo residential proxy — Solana USDC (gasless feePayer), so pay.sh settles it. */
export const ONCHAINEXPAT_UNBLOCKER: UnblockerEndpoint = {
  id: "x402:onchainexpat",
  url: "https://x402.onchainexpat.com/api/x402-proxy/fetch/geo",
  body: (url, country) => JSON.stringify({ url, country }),
  parse: (j) => (typeof j.body === "string" ? { status: Number(j.status_code) || 0, html: j.body } : null),
};
/** 0000402 generic pay-per-request HTTP proxy (Base/EVM USDC — used when a Base wallet is set;
 *  pay.sh-Solana simply errors on it and the chain moves on). */
export const ZERO402_UNBLOCKER: UnblockerEndpoint = {
  id: "x402:0000402",
  url: "https://proxy.0000402.xyz/fetch",
  body: (url) => JSON.stringify({ url, method: "GET" }),
  parse: (j) => { const html = decodeMaybeB64(j); return html ? { status: Number(j.status) || 0, html } : null; },
};

/** The x402 unblocker fallback chain: UNBROWSE_X402_UNBLOCKER_URL override (OnchainExpat-shaped),
 *  then the known providers. "If iproyal no worky" the rescue walks this until one clears the URL. */
export function x402UnblockerChain(env: NodeJS.ProcessEnv = process.env): UnblockerEndpoint[] {
  const chain: UnblockerEndpoint[] = [];
  const override = env.UNBROWSE_X402_UNBLOCKER_URL?.trim();
  if (override) chain.push({ ...ONCHAINEXPAT_UNBLOCKER, id: "x402:override", url: override });
  chain.push(ONCHAINEXPAT_UNBLOCKER, ZERO402_UNBLOCKER);
  return chain;
}

/** A payment method is available, so paid fallback is allowed to spend. Replaces the old manual
 *  UNBROWSE_X402_UNBLOCKER flag: the paid fallback engages automatically iff the user actually has
 *  a way to pay — a configured wallet adapter (lobster/privy/generic/ows via UNBROWSE_WALLET_ADAPTER
 *  or its creds files), OR the pay.sh binary on PATH (the chain settles via `pay curl`). No payment
 *  method at all → never auto-spend. */
export function x402PaymentAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  try { if (resolveWalletConfig(env).adapter !== "none") return true; } catch { /* fall through */ }
  try { return payShAvailable(); } catch { return false; }
}

/** Settle one endpoint via `pay curl` (the proven slow-Solana path; x402Fetch doesn't thread the
 *  long timeout). Records the target's real outcome under this endpoint's id, returns content or null. */
async function payFetchVia(ep: UnblockerEndpoint, target: string, country: string, timeoutMs: number): Promise<CurlCffiResult | null> {
  const sandbox = (process.env.UNBROWSE_PAY_SANDBOX ?? "").trim().toLowerCase();
  const base = sandbox === "1" || sandbox === "true" ? ["--sandbox"] : [];
  const args = [...base, "curl", "-sS", "-X", "POST", ep.url, "-H", "content-type: application/json", "-d", ep.body(target, country)];
  return await new Promise<CurlCffiResult | null>((resolveP) => {
    let killed = false;
    let child;
    try { child = spawn("pay", args, { stdio: ["ignore", "pipe", "pipe"], env: process.env }); }
    catch { resolveP(null); return; }
    let stdout = "";
    const timer = setTimeout(() => { killed = true; try { child!.kill("SIGKILL"); } catch { /* best-effort */ } resolveP(null); }, timeoutMs + 10_000);
    child.stdout.on("data", (c) => { stdout += String(c); });
    child.on("error", () => { clearTimeout(timer); resolveP(null); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (killed) return;
      if (code !== 0) { resolveP(null); return; }
      try {
        const j = JSON.parse(stdout) as Record<string, unknown>;
        if (typeof j.error === "string") { resolveP(null); return; }
        const got = ep.parse(j);
        if (!got) { resolveP(null); return; }
        // A 403/interstitial classifies antibot → cached under ep.id, so this provider isn't re-paid
        // for a site it can't clear; a clean 2xx classifies null → the provider stays available.
        const cls = recordOutcome(target, { status: got.status, body: got.html.slice(0, 800) }, ep.id);
        if (cls !== null || got.status < 200 || got.status >= 300 || got.html.length < 256) { resolveP(null); return; }
        resolveP({ status: got.status, bytes: Buffer.byteLength(got.html, "utf-8"), html: got.html, final_url: target, proxy_used: true, impersonate: ep.id });
      } catch { resolveP(null); }
    });
  });
}

/**
 * Paid x402 web-unblocker rescue — the Cloudflare/JS-challenge-class rescue that ALSO works on the
 * shipped binary (camoufox needs the dev-only venv; this is a paid HTTP call, no local browser).
 * When IProyal / the free rungs fail, walk the x402 unblocker fallback chain (OnchainExpat, then
 * any further providers) until one returns real content. Settled by the pay adapter.
 *
 * Engages automatically when a payment method is configured (x402PaymentAvailable) — no manual
 * flag. Per-endpoint negative-cache-gated: a target a provider can't clear (DataDome/PerimeterX
 * 403) is not re-paid via that provider until cooldown, but the next provider still gets a shot.
 * Bounded by the wallet's per-call spend ceiling (UNBROWSE_X402_MAX_COST_USD). Returns null when
 * no payment is configured, every provider is cooled-down/failed, or content stays blocked.
 *
 * Boundary proven 2026-06-13/14: Cloudflare (stackoverflow) CLEARED; DataDome (idealista) +
 * PerimeterX (zillow) NOT — the IProyal/residential IP pool is DataDome-banned (t=bv), honest negative.
 */
export async function tryX402UnblockerFetch(
  opts: CurlCffiOptions & { country?: string },
): Promise<CurlCffiResult | null> {
  if (!x402PaymentAvailable()) return null; // no wallet configured → never auto-spend
  const country = (opts.country || process.env.UNBROWSE_X402_UNBLOCKER_COUNTRY || "US").trim();
  const timeoutMs = opts.timeoutMs ?? 240_000;
  for (const ep of x402UnblockerChain()) {
    if (peekFailure(opts.url, ep.id) !== null) continue; // this provider already can't clear this target
    const r = await payFetchVia(ep, opts.url, country, timeoutMs);
    if (r) return r; // first provider to return real content wins
  }
  return null;
}
