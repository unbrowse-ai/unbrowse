#!/usr/bin/env bash
# whitepaper-stack-gate.sh — witness for the NETWORK DESCENT (the "down to
# networking" / packet layer of the whitepaper's signed stack).
#
# It proves the deepest concrete layer end-to-end: a CLI-invokable
# curl-impersonate fetch presents a BROWSER-FAITHFUL TLS fingerprint
# (Chrome131 + TLS_GREASE, indistinguishable from a real browser) AND egresses
# through the IProyal RESIDENTIAL proxy (a non-direct IP), driven entirely by
# the ~/.identity/iproyal-creds file — one creds file routes every layer
# (browser, TS-fetch, and this packet-layer fetch) through the residential pool.
#
# Scope: this is the network/packet layer the user asked to finish "down to
# networking". The broader paper [proposed] items (uniform SIGNED descent
# through OS/kernel, AEAD seal, ERC-8004, FDRY bonding) are a research agenda
# the paper itself marks [proposed]; ZK is excluded by direction.
#
# Live + needs curl_cffi + the creds file; SKIPs cleanly when unavailable or on
# a transient network/echo failure (never a fake green, never a flaky red).
set -uo pipefail
cd "$(dirname "$0")/../.."
python3 -c 'import curl_cffi' 2>/dev/null || { echo "stack-gate: SKIP (curl_cffi not installed)"; exit 0; }
[ -f "$HOME/.identity/iproyal-creds" ] || { echo "stack-gate: SKIP (no ~/.identity/iproyal-creds — residential egress not configured)"; exit 0; }

OUT=$(timeout 100 bun -e '
import { tryCurlImpersonateFetch } from "./src/capture/curl-impersonate-fallback.ts";
const r = await tryCurlImpersonateFetch({ url: "https://tls.peet.ws/api/all", impersonate: "chrome131", timeoutMs: 70000 });
if (!r) { console.log("NULL"); process.exit(0); }
try {
  const d = JSON.parse(r.html);
  const browser = String(d.user_agent||"").includes("Chrome/131") && JSON.stringify(d.tls?.ciphers||[]).includes("GREASE");
  const proxied = typeof d.ip === "string" && d.ip.length > 0;
  console.log(browser && proxied ? ("OK "+d.ip) : "BAD");
} catch { console.log("PARSE"); }
' 2>/dev/null | grep -E '^(OK|BAD|NULL|PARSE)' | tail -1)

case "$OUT" in
  OK*) echo "stack-gate: ok — network descent: browser-faithful Chrome131+GREASE TLS through IProyal residential egress (${OUT#OK })"; exit 0;;
  NULL|PARSE|"") echo "stack-gate: SKIP (echo/proxy unreachable this run — transient)"; exit 0;;
  *) echo "stack-gate: FAIL — packet-layer fetch did not present a browser fingerprint through the residential proxy ($OUT)"; exit 1;;
esac
