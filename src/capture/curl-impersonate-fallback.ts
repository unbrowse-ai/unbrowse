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

/** Default x402 web-unblocker: OnchainExpat geo residential proxy. Accepts Solana USDC
 *  (gasless feePayer) so pay.sh settles it; returns {status_code, headers, body} where body
 *  is the target HTML. Override with UNBROWSE_X402_UNBLOCKER_URL. */
export const X402_UNBLOCKER_DEFAULT_URL = "https://x402.onchainexpat.com/api/x402-proxy/fetch/geo";

/** The paid-unblocker rung is OFF unless UNBROWSE_X402_UNBLOCKER=1|true|yes — it spends real money. */
export function x402UnblockerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.UNBROWSE_X402_UNBLOCKER ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * Paid x402 web-unblocker rescue — the Cloudflare/JS-challenge-class rescue that ALSO works on
 * the shipped binary (camoufox needs the dev-only `scripts/.camoufox-venv`; this is a paid HTTP
 * call, no local browser). Routes the blocked URL through a residential x402 unblocker (default
 * OnchainExpat geo, Solana USDC ~$0.03/call, gasless feePayer) settled by pay.sh (`pay curl` —
 * the proven path; x402Fetch does not thread the long timeout the slow Solana settle needs).
 *
 * Default-OFF (UNBROWSE_X402_UNBLOCKER=1 to arm — it spends real money). Negative-cache-gated:
 * a target this rung cannot clear (DataDome / PerimeterX answer 403) is recorded antibot and
 * NOT re-paid until its cooldown expires. Returns null on: gate off, pay absent, cooled-down
 * target, settle fail, blocked/short content.
 *
 * Boundary proven 2026-06-13 (pay.sh dealer-ops, Solana USDC):
 *   - Cloudflare JS-challenge (stackoverflow/questions): CLEARED, real 266 KB content.
 *   - DataDome (idealista) + PerimeterX (zillow): still 403 — recorded as honest negatives.
 */
export async function tryX402UnblockerFetch(
  opts: CurlCffiOptions & { country?: string },
): Promise<CurlCffiResult | null> {
  if (!x402UnblockerEnabled()) return null;
  // Skip a target we already know this rung can't clear (any active cooldown — antibot 403, etc.).
  if (peekFailure(opts.url, "x402-unblocker") !== null) return null;
  const endpoint = (process.env.UNBROWSE_X402_UNBLOCKER_URL || X402_UNBLOCKER_DEFAULT_URL).trim();
  const country = (opts.country || process.env.UNBROWSE_X402_UNBLOCKER_COUNTRY || "US").trim();
  const timeoutMs = opts.timeoutMs ?? 240_000;
  const sandbox = (process.env.UNBROWSE_PAY_SANDBOX ?? "").trim().toLowerCase();
  const base = sandbox === "1" || sandbox === "true" ? ["--sandbox"] : [];
  const payload = JSON.stringify({ url: opts.url, country });
  // pay curl -sS -X POST <unblocker> -H 'content-type: application/json' -d '{"url":...}'
  const args = [...base, "curl", "-sS", "-X", "POST", endpoint, "-H", "content-type: application/json", "-d", payload];

  return await new Promise<CurlCffiResult | null>((resolveP) => {
    let killed = false;
    let child;
    try {
      child = spawn("pay", args, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
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
        // Unblocker wraps the target: { status_code, headers, body }, body = target HTML.
        const parsed = JSON.parse(stdout) as { status_code?: number; body?: string; error?: string };
        if (typeof parsed.error === "string") { resolveP(null); return; }
        const status = Number(parsed.status_code) || 0;
        const html = typeof parsed.body === "string" ? parsed.body : "";
        // Record the TARGET's real outcome on this rung's egress: a 403/interstitial classifies
        // antibot → cached, so the next blocked-capture skips re-paying for a site this rung
        // can't clear. A clean 2xx classifies null → no cooldown, the rung stays available.
        const cls = recordOutcome(opts.url, { status, body: html.slice(0, 800) }, "x402-unblocker");
        if (cls !== null || status < 200 || status >= 300 || html.length < 256) { resolveP(null); return; }
        resolveP({
          status,
          bytes: Buffer.byteLength(html, "utf-8"),
          html,
          final_url: opts.url,
          proxy_used: true,
          impersonate: "x402-unblocker",
        });
      } catch { resolveP(null); }
    });
  });
}
