/**
 * Bridge UNBROWSE_KURI_PROXY → KURI_PROXY for Kuri's managed Chrome.
 *
 * Kuri's Zig binary reads KURI_PROXY (or BROWDIE_PROXY) and emits
 * `--proxy-server=<url>` on Chrome launch. See
 * submodules/kuri/src/bridge/config.zig:30 and
 * submodules/kuri/src/chrome/launcher.zig:172-174.
 *
 * This module wires Unbrowse's existing residential-proxy env convention
 * (IPROYAL_USER + IPROYAL_PASS, optionally IPROYAL_HOST + IPROYAL_PORT;
 * or a direct UNBROWSE_PROXY_URL) into Kuri WITHOUT editing
 * src/kuri/client.ts (banned per CLAUDE.md).
 *
 * Opt-in by design — residential proxy is paid + slower. Default behavior
 * (UNBROWSE_KURI_PROXY unset) is unchanged: Kuri's managed Chrome runs
 * direct. Users who hit JS-challenge sites (Reddit, Cloudflare-protected)
 * set:
 *   IPROYAL_USER=...
 *   IPROYAL_PASS=...
 *   UNBROWSE_KURI_PROXY=auto
 * and Kuri's Chrome routes through the residential proxy on next spawn.
 *
 * Toggle semantics:
 *   - unset / "0" / "false" → no-op (default)
 *   - "auto" / "1" / "true" → derive from UNBROWSE_PROXY_URL or IPROYAL_*
 *   - explicit URL (starts with http:// or socks5://) → use verbatim
 *
 * Must be called BEFORE kuri/client first spawns, so the inherited
 * process.env carries KURI_PROXY into the spawned Zig binary.
 *
 * Runtime gap (closed 2026-05-25 same day): when the proxy is wired,
 * the bridge ALSO sets KURI_DISABLE_CDP_ATTACH=1 so kuri's launch
 * config forces managed Chrome instead of attaching to the user's
 * existing Chrome. This guarantees --proxy-server is actually applied
 * even in local dev where the user has Chrome running. Without this,
 * the bridge would log `wired` correctly but Reddit / Cloudflare still
 * return datacenter-IP responses because CDP cannot retrofit a proxy
 * onto an already-launched Chrome process.
 *
 * KURI_DISABLE_CDP_ATTACH is the documented opt-OUT in kuri's launch
 * config (src/kuri/client.ts:resolveKuriLaunchConfig). Setting it from
 * the bridge respects the kuri-client/edit-ban (CLAUDE.md) while
 * closing the gap end-to-end.
 */

import { resolveProxyUrl } from "../execution/proxy-fetch.js";

export type KuriProxyBridgeOutcome =
  | { wired: false; reason: "opt_out" }
  | { wired: false; reason: "already_set"; existing: string }
  | { wired: false; reason: "creds_missing" }
  | { wired: false; reason: "chrome_incompatible_proxy_format"; redacted: string }
  | { wired: false; reason: "invalid_toggle"; value: string }
  | { wired: true; source: "explicit_url" | "auto"; redacted: string };

function redactProxyUrl(url: string): string {
  return url.replace(/\/\/[^@]+@/, "//***@");
}

// Whether the proxy URL has inline credentials (user:pass@host).
// Chrome's --proxy-server flag REJECTS such URLs with
// ERR_NO_SUPPORTED_PROXIES on every navigation. Bridge spawns a local
// auth-injecting forwarder on localhost so Chrome connects unauth and
// the forwarder adds the Proxy-Authorization header on its way upstream.
function hasInlineAuth(proxyUrl: string): boolean {
  return /^\w+:\/\/[^/@]+@/.test(proxyUrl);
}

// Spawns scripts/local-proxy-auth-forwarder.py for the given upstream
// URL. Reads the first line of stdout ("ready port=<N>") to discover
// the kernel-picked port. Returns the localhost URL Chrome can use.
// Returns null if the forwarder didn't start within 3 seconds or
// stdout didn't carry a `port=` line. The child process is detached
// (unref'd) so it survives parent exit until something else kills it;
// kuri-broker shutdown + the standard pkill set already catch this.
function spawnAuthForwarder(upstreamUrl: string): string | null {
  try {
    const { spawnSync, spawn } = require("node:child_process") as typeof import("node:child_process");
    const path = require("node:path") as typeof import("node:path");
    const fs = require("node:fs") as typeof import("node:fs");

    // Locate scripts/local-proxy-auth-forwarder.py: walk up from this
    // file until we find a `scripts/` directory containing it. The
    // bridge module ships under src/env/, so the script is two dirs up.
    let here = __dirname;
    let scriptPath: string | null = null;
    for (let i = 0; i < 6; i++) {
      const candidate = path.join(here, "scripts", "local-proxy-auth-forwarder.py");
      if (fs.existsSync(candidate)) {
        scriptPath = candidate;
        break;
      }
      const parent = path.dirname(here);
      if (parent === here) break;
      here = parent;
    }
    if (!scriptPath) {
      process.stderr.write("[kuri-proxy] could not locate local-proxy-auth-forwarder.py; auth-proxy bridge unavailable.\n");
      return null;
    }

    // Probe — confirm python3 + script can parse the URL before
    // backgrounding. spawnSync with a 1s timeout, --help-like dry-run
    // via empty stdin. Skipped here; rely on background spawn's
    // ready-line as the probe.

    // File-based ready signal — more reliable than racing the
    // child's stdout pipe across the bun/node runtime boundary.
    const os = require("node:os") as typeof import("node:os");
    const readyFile = path.join(os.tmpdir(), `kuri-proxy-forwarder-${process.pid}-${Date.now()}.ready`);
    try { fs.unlinkSync(readyFile); } catch { /* not present yet */ }

    const child = spawn("python3", [scriptPath, "--upstream", upstreamUrl, "--quiet", "--ready-file", readyFile], {
      stdio: "ignore",
      detached: true,
    });
    child.unref();

    // Poll the ready file up to 3 seconds. Forwarder writes
    // "port=<N>\n" once listening.
    const deadline = Date.now() + 3000;
    let port: string | null = null;
    while (Date.now() < deadline) {
      try {
        const content = fs.readFileSync(readyFile, "utf-8");
        const m = content.match(/port=(\d+)/);
        if (m) {
          port = m[1];
          break;
        }
      } catch { /* not ready yet */ }
      spawnSync("sh", ["-c", "sleep 0.1"]);
    }

    // Best-effort cleanup of the ready file (forwarder doesn't need it after start)
    try { fs.unlinkSync(readyFile); } catch { /* ignore */ }

    if (!port) {
      try { if (child.pid) process.kill(child.pid, "SIGTERM"); } catch { /* ignore */ }
      process.stderr.write("[kuri-proxy] auth-proxy forwarder failed to report ready within 3s\n");
      return null;
    }
    return `http://127.0.0.1:${port}`;
  } catch (err) {
    process.stderr.write(`[kuri-proxy] auth-proxy spawn error: ${err instanceof Error ? err.message : String(err)}\n`);
    return null;
  }
}

// Forces Kuri to launch managed Chrome instead of attaching to user's
// existing Chrome. Kuri's attach-vs-managed decision lives in
// src/kuri/client.ts:resolveKuriLaunchConfig — it reads
// KURI_DISABLE_CDP_ATTACH (opt-OUT) which trumps the opt-IN
// KURI_ATTACH_EXISTING_CHROME. Only called when the proxy URL is
// Chrome-compatible (no inline auth).
function forceManagedChrome(env: NodeJS.ProcessEnv): void {
  if (!env.KURI_DISABLE_CDP_ATTACH) {
    env.KURI_DISABLE_CDP_ATTACH = "1";
  }
}

// Apply the proxy to kuri's environment. When the URL has inline
// credentials, spawn a local auth-injecting forwarder and point
// KURI_PROXY at the localhost endpoint (Chrome-compatible). When the
// URL is already Chrome-compatible (no inline auth), set KURI_PROXY
// directly. Returns false only when the forwarder failed to start;
// caller surfaces that as chrome_incompatible_proxy_format so the
// agent knows kuri's Chrome will run direct.
function applyKuriProxy(env: NodeJS.ProcessEnv, proxyUrl: string): boolean {
  if (hasInlineAuth(proxyUrl)) {
    const forwarderUrl = spawnAuthForwarder(proxyUrl);
    if (!forwarderUrl) return false;
    env.KURI_PROXY = forwarderUrl;
    forceManagedChrome(env);
    process.stderr.write(
      `[kuri-proxy] auth-forwarder bridged: Chrome connects to ${forwarderUrl} (unauth), ` +
      "forwarder injects Proxy-Authorization to upstream. Chrome accepts the unauth localhost " +
      "URL where it rejected inline-auth.\n",
    );
    return true;
  }
  env.KURI_PROXY = proxyUrl;
  forceManagedChrome(env);
  return true;
}

export function bridgeKuriProxyEnv(
  env: NodeJS.ProcessEnv = process.env,
): KuriProxyBridgeOutcome {
  if (env.KURI_PROXY) {
    // Pre-existing KURI_PROXY is respected as-is (don't overwrite, don't
    // force managed Chrome — the caller knows what they're doing).
    return { wired: false, reason: "already_set", existing: redactProxyUrl(env.KURI_PROXY) };
  }

  const toggle = env.UNBROWSE_KURI_PROXY?.trim();
  if (!toggle || toggle === "0" || toggle === "false") {
    return { wired: false, reason: "opt_out" };
  }

  if (/^(?:https?|socks5):\/\//.test(toggle)) {
    const applied = applyKuriProxy(env, toggle);
    if (!applied) return { wired: false, reason: "chrome_incompatible_proxy_format", redacted: redactProxyUrl(toggle) };
    return { wired: true, source: "explicit_url", redacted: redactProxyUrl(toggle) };
  }

  if (toggle === "auto" || toggle === "1" || toggle === "true") {
    const fromUrl = env.UNBROWSE_PROXY_URL?.trim();
    const proxy = fromUrl || resolveProxyUrl(env);
    if (!proxy) return { wired: false, reason: "creds_missing" };
    const applied = applyKuriProxy(env, proxy);
    if (!applied) return { wired: false, reason: "chrome_incompatible_proxy_format", redacted: redactProxyUrl(proxy) };
    return { wired: true, source: "auto", redacted: redactProxyUrl(proxy) };
  }

  return { wired: false, reason: "invalid_toggle", value: toggle };
}
