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
 * Runtime gap (documented 2026-05-25):
 * The bridge has effect ONLY when kuri launches MANAGED Chrome. When
 * kuri attaches to a user's pre-existing Chrome via CDP (the default
 * dev path when Chrome is already running on the user's machine), the
 * `--proxy-server` flag is never applied — that Chrome was launched
 * without a proxy and CDP cannot retrofit one. Symptom: bridge logs
 * `wired KURI_PROXY` correctly but Reddit/Cloudflare still return
 * datacenter-IP responses.
 *
 * Affects local dev with user Chrome running. CI bench probes that
 * spawn a clean environment with no pre-existing Chrome get the
 * managed-Chrome path and the proxy DOES take effect. To force the
 * managed path locally: kill user Chrome (or close all Chrome windows)
 * before invoking unbrowse, OR set KURI_ATTACH_TO_EXISTING_CHROME=0.
 */

import { resolveProxyUrl } from "../execution/proxy-fetch.js";

export type KuriProxyBridgeOutcome =
  | { wired: false; reason: "opt_out" }
  | { wired: false; reason: "already_set"; existing: string }
  | { wired: false; reason: "creds_missing" }
  | { wired: false; reason: "invalid_toggle"; value: string }
  | { wired: true; source: "explicit_url" | "auto"; redacted: string };

function redactProxyUrl(url: string): string {
  return url.replace(/\/\/[^@]+@/, "//***@");
}

export function bridgeKuriProxyEnv(
  env: NodeJS.ProcessEnv = process.env,
): KuriProxyBridgeOutcome {
  if (env.KURI_PROXY) {
    return { wired: false, reason: "already_set", existing: redactProxyUrl(env.KURI_PROXY) };
  }

  const toggle = env.UNBROWSE_KURI_PROXY?.trim();
  if (!toggle || toggle === "0" || toggle === "false") {
    return { wired: false, reason: "opt_out" };
  }

  if (/^(?:https?|socks5):\/\//.test(toggle)) {
    env.KURI_PROXY = toggle;
    return { wired: true, source: "explicit_url", redacted: redactProxyUrl(toggle) };
  }

  if (toggle === "auto" || toggle === "1" || toggle === "true") {
    const fromUrl = env.UNBROWSE_PROXY_URL?.trim();
    const proxy = fromUrl || resolveProxyUrl(env);
    if (!proxy) return { wired: false, reason: "creds_missing" };
    env.KURI_PROXY = proxy;
    return { wired: true, source: "auto", redacted: redactProxyUrl(proxy) };
  }

  return { wired: false, reason: "invalid_toggle", value: toggle };
}
