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
  | { wired: false; reason: "invalid_toggle"; value: string }
  | { wired: true; source: "explicit_url" | "auto"; redacted: string };

function redactProxyUrl(url: string): string {
  return url.replace(/\/\/[^@]+@/, "//***@");
}

// Forces Kuri to launch managed Chrome instead of attaching to user's
// existing Chrome. Kuri's attach-vs-managed decision lives in
// src/kuri/client.ts:resolveKuriLaunchConfig — it reads
// KURI_DISABLE_CDP_ATTACH (opt-OUT) which trumps the opt-IN
// KURI_ATTACH_EXISTING_CHROME. Setting it here is the documented fix
// for the runtime gap noted in this module's header: when proxy is
// wired but kuri attaches to user Chrome, --proxy-server is never
// applied. Forcing managed Chrome closes the gap.
function forceManagedChrome(env: NodeJS.ProcessEnv): void {
  if (!env.KURI_DISABLE_CDP_ATTACH) {
    env.KURI_DISABLE_CDP_ATTACH = "1";
  }
}

export function bridgeKuriProxyEnv(
  env: NodeJS.ProcessEnv = process.env,
): KuriProxyBridgeOutcome {
  if (env.KURI_PROXY) {
    forceManagedChrome(env);
    return { wired: false, reason: "already_set", existing: redactProxyUrl(env.KURI_PROXY) };
  }

  const toggle = env.UNBROWSE_KURI_PROXY?.trim();
  if (!toggle || toggle === "0" || toggle === "false") {
    return { wired: false, reason: "opt_out" };
  }

  if (/^(?:https?|socks5):\/\//.test(toggle)) {
    env.KURI_PROXY = toggle;
    forceManagedChrome(env);
    return { wired: true, source: "explicit_url", redacted: redactProxyUrl(toggle) };
  }

  if (toggle === "auto" || toggle === "1" || toggle === "true") {
    const fromUrl = env.UNBROWSE_PROXY_URL?.trim();
    const proxy = fromUrl || resolveProxyUrl(env);
    if (!proxy) return { wired: false, reason: "creds_missing" };
    env.KURI_PROXY = proxy;
    forceManagedChrome(env);
    return { wired: true, source: "auto", redacted: redactProxyUrl(proxy) };
  }

  return { wired: false, reason: "invalid_toggle", value: toggle };
}
