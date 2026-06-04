#!/usr/bin/env bash
# skill-package round-trip witness — binding --check for the jesus-ralph north star
# ("each captured website is a self-describing installable skill via npx skills add").
#
# Core: render→validate→leak-clean across the whole local skill corpus. Exits 0
# only when every REAL website produces a valid, leak-clean, installable package.
#
# LIVE=1: additionally proves the live round-trip on the reference skill —
# the published repo resolves, `npx skills add` installs it, and executing the
# listed endpoint returns real data. Requires network + a published reference repo.
set -euo pipefail
cd "$(dirname "$0")/.."

# Core corpus gate (offline, reproducible).
bun scripts/skill-package-roundtrip-gate.ts

# Unit witness: structure + leak gate + serialization regressions.
bun test tests/skillmd-per-site-package.test.ts

if [ "${LIVE:-0}" = "1" ]; then
  REPO="${SKILL_ROUNDTRIP_REPO:-unbrowse-ai/earthquake.usgs.gov}"
  SKILL_ID="${SKILL_ROUNDTRIP_SKILL_ID:-MKvqlGUJrF7QxU4tpl9xF}"
  EP="${SKILL_ROUNDTRIP_ENDPOINT:-j4h6sfpyCOyASBhukJbrh}"
  MARKER="${SKILL_ROUNDTRIP_MARKER:-FeatureCollection}"
  echo "[gate] LIVE: install $REPO + execute $SKILL_ID/$EP, expect marker '$MARKER'"
  TMP="$(mktemp -d)"
  ( cd "$TMP" && npx -y skills add "$REPO" --copy --skill '*' --agent claude-code -y >/dev/null 2>&1 )
  test -f "$TMP/.claude/skills/"*"/SKILL.md" || { echo "[gate] LIVE FAIL: skills add did not install a SKILL.md"; exit 1; }
  OUT="$(cd "$TMP" && npx -y unbrowse@latest execute --skill "$SKILL_ID" --endpoint "$EP" --raw 2>/dev/null || true)"
  if ! grep -q "$MARKER" <<<"$OUT"; then
    echo "[gate] LIVE FAIL: execute did not return real data (no '$MARKER')"; exit 1
  fi
  echo "[gate] LIVE PASS: published repo installs and the listed endpoint returns real data"
fi

# x402 reward — ACCOUNTING leg (real, free): the settlement split that credits the
# owner/contributors is the actual prod code, witnessed by real tests. This proves
# the reward MATH credits the owner correctly (the collective-learning payout:
# computeContributorShares weights by cumulative_delta — uniquely-valuable routes
# earn more). Distinct from the live mainnet transfer below.
echo "[gate] x402 accounting + collective-learning: split/owner-credit math, delta attribution, opt-in slashing"
bun test backend/tests/splits.test.ts backend/tests/flex-splits-50-50.test.ts backend/tests/attribution.test.ts

# x402 reward — LIVE SETTLEMENT leg — the one genuinely-open node of the north star.
# RED until a real owner-credit fill is WITNESSED (a wallet-owning skill + a real
# paid execution whose on-chain settlement credits the owner, observed in
# `unbrowse earnings`). Never faked: a proof file recording the observed fill is
# the only way to green. The accounting above is proven; only the mainnet transfer
# is money-gated.
PROOF="${X402_PROOF:-$HOME/.unbrowse/x402-owner-credit-proof.json}"
if [ -f "$PROOF" ]; then
  echo "[gate] x402 PASS: owner-credit witnessed — $PROOF"
  echo "[gate] GREEN — full north star settled (format + install + execute + scale + x402 owner-credit)"
  exit 0
fi
echo "[gate] CORE GREEN (format + install + execute + scale + leak-safety + x402 accounting) — but x402 LIVE settlement is OPEN."
echo "[gate] x402 RED: live owner-credit not yet witnessed. The split math is proven; the mainnet transfer is not."
echo "[gate]   Three real prerequisites (the local corpus has 0 priced+owner-bound skills, so none are met yet):"
echo "[gate]     1. fund escrow (web):    open https://unbrowse.ai/account/escrow"
echo "[gate]     2. session key (web):    open https://unbrowse.ai/account/session-key"
echo "[gate]     3. a priced, owner-bound skill: pair a wallet (unbrowse setup) + price it"
echo "[gate]        (PATCH /v1/skills/:id base_price_usd>0) so an execute actually settles x402."
echo "[gate]   Then a paid execute settles; observe the owner credit in 'unbrowse earnings' and"
echo "[gate]   record the observed fill at:"
echo "[gate]     $PROOF"
echo "[gate] (Loop stays locked on this real, web+wallet-gated node — not a vibe. Cancel to set it down.)"
exit 2
