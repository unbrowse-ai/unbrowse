/**
 * Bridge UNBROWSE_KURI_PROXY → KURI_PROXY for Kuri's managed Chrome.
 *
 * Kuri's Zig binary reads KURI_PROXY (or BROWDIE_PROXY) and emits
 * `--proxy-server=<url>` on Chrome launch. See
 * submodules/kuri/src/bridge/config.zig:30 and
 * submodules/kuri/src/chrome/launcher.zig:172-174.
 *
 * This module wires Unbrowse's residential-proxy env convention into
 * Kuri WITHOUT editing src/kuri/client.ts (banned per CLAUDE.md).
 *
 * As of 2026-05-27 (covenant
 *   sha256:65714387c8c9f6a151f2e8fec26992e7a289b4924e54fcb184312b7763c028a4):
 * residential-proxy egress is the DEFAULT, not opt-in. When the toggle is
 * unset, the bridge behaves as if it were "auto" and routes Kuri's Chrome
 * through resolveEgressProxy() (which falls through to ProxyKingdom when
 * no other creds are present). UNBROWSE_DIRECT_EGRESS=1 is the explicit
 * opt-out for dev / health-check / local-only flows.
 *
 * Toggle semantics:
 *   - unset                 → treated as "auto" (the new default)
 *   - "0" / "false"         → no-op (legacy explicit opt-out for kuri only)
 *   - "auto" / "1" / "true" → resolveEgressProxy() (UNBROWSE_DIRECT_EGRESS still wins)
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

import { resolveEgressProxy } from "../execution/proxy-fetch.js";

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

// PIDs of auth-forwarders this process spawned. The forwarder is spawned
// detached+unref'd so it can outlive a transient parent in the long-lived
// server/broker case — but a one-shot `unbrowse run` CLI invocation has no
// broker doing shutdown cleanup, so without this the forwarder leaks once per
// run (8873 orphaned Python processes observed after a 10k-site index campaign,
// hitting the per-user process ceiling → `fork: Resource temporarily
// unavailable`). When the spawning process exits, the forwarder is useless
// anyway (the Chrome that used KURI_PROXY is gone), so reaping it on exit is
// always correct. Exported for tests.
const trackedForwarders = new Set<number>();
let forwarderCleanupRegistered = false;

export function killTrackedForwarders(): void {
  for (const pid of trackedForwarders) {
    try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
  }
  trackedForwarders.clear();
}

function ensureForwarderCleanupRegistered(): void {
  if (forwarderCleanupRegistered) return;
  forwarderCleanupRegistered = true;
  // 'exit' is sync-only; process.kill is sync, so this is safe. SIGINT/SIGTERM
  // don't trigger 'exit' on their own, so reap explicitly then re-raise default.
  process.once("exit", killTrackedForwarders);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(sig, () => {
      killTrackedForwarders();
      // Re-raise with default disposition so exit codes / parent semantics hold.
      process.kill(process.pid, sig);
    });
  }
}

export function trackForwarderPid(pid: number): void {
  trackedForwarders.add(pid);
  ensureForwarderCleanupRegistered();
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
    // Reap-on-exit: track the live forwarder so it dies with the spawning
    // process (one-shot CLI runs have no broker shutdown to catch it).
    if (child.pid) trackForwarderPid(child.pid);
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

  // UNBROWSE_DIRECT_EGRESS=1 is the canonical kill-switch for the
  // residential-proxy-default policy (covenant sha256:65714387c8c9f6...).
  // Honor it before any toggle inspection so dev/health-check flows that
  // set just UNBROWSE_DIRECT_EGRESS work without also unsetting
  // UNBROWSE_KURI_PROXY.
  const directEgress = env.UNBROWSE_DIRECT_EGRESS?.trim().toLowerCase();
  if (directEgress === "1" || directEgress === "true" || directEgress === "yes") {
    return { wired: false, reason: "opt_out" };
  }

  const toggle = env.UNBROWSE_KURI_PROXY?.trim();
  // Legacy explicit opt-out still respected.
  if (toggle === "0" || toggle === "false") {
    return { wired: false, reason: "opt_out" };
  }

  if (toggle && /^(?:https?|socks5):\/\//.test(toggle)) {
    const applied = applyKuriProxy(env, toggle);
    if (!applied) return { wired: false, reason: "chrome_incompatible_proxy_format", redacted: redactProxyUrl(toggle) };
    return { wired: true, source: "explicit_url", redacted: redactProxyUrl(toggle) };
  }

  // Unset OR explicit "auto"/"1"/"true" → resolve via the egress policy.
  // resolveEgressProxy honors UNBROWSE_PROXY_URL → IPROYAL_* →
  // ProxyKingdom default in that order.
  if (!toggle || toggle === "auto" || toggle === "1" || toggle === "true") {
    const proxy = resolveEgressProxy(env);
    if (!proxy) return { wired: false, reason: "creds_missing" };
    const applied = applyKuriProxy(env, proxy);
    if (!applied) return { wired: false, reason: "chrome_incompatible_proxy_format", redacted: redactProxyUrl(proxy) };
    return { wired: true, source: "auto", redacted: redactProxyUrl(proxy) };
  }

  return { wired: false, reason: "invalid_toggle", value: toggle };
}
