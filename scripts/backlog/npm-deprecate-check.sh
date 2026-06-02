#!/usr/bin/env bash
# npm-deprecate-check.sh — witness for the npm-deprecate backlog item.
# Passes when the live @unbrowse/sdk@latest deprecation message points at the
# consolidated `unbrowse` package (and NOT the never-published @unbrowse/client).
# Re-deprecating requires npm 2FA OTP, so a human runs it; this verifies the result.
set -uo pipefail
dep=$(curl -s "https://registry.npmjs.org/@unbrowse%2Fsdk" 2>/dev/null \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);const l=j['dist-tags'].latest;process.stdout.write((j.versions[l]||{}).deprecated||'')})" 2>/dev/null)
if printf '%s' "$dep" | grep -qiE "package/unbrowse\b|unbrowse/sdk" && ! printf '%s' "$dep" | grep -qE "@unbrowse/client"; then
  echo "ok: @unbrowse/sdk@latest deprecation points to the unbrowse package"
  exit 0
fi
echo "not yet: @unbrowse/sdk@latest deprecation still wrong/absent — run (with your npm OTP):"
echo "  npm deprecate '@unbrowse/sdk@7.2.0' \"The Unbrowse SDK is now part of the 'unbrowse' package: npm i unbrowse, import { Unbrowse } from 'unbrowse/sdk'. Docs: https://www.npmjs.com/package/unbrowse\""
exit 1
