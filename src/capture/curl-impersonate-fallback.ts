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
        resolveP({
          status: Number(parsed.status) || 0,
          bytes: Number(parsed.bytes) || 0,
          html,
          final_url: String(parsed.final_url || opts.url),
          proxy_used: Boolean(parsed.proxy_used),
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
