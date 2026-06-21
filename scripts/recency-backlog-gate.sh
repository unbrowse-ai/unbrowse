#!/usr/bin/env bash
# recency-backlog-gate.sh — the BINDING witness for "everything we ever wanted for unbrowse
# ranked by recency is completed and done." Green checks guard the SHIPPED work against
# regression; red checks are the honest external/resource-gated residuals. Exits 0 ONLY when
# every line passes — so the jesus-ralph promise cannot be self-asserted past the real tail.
# Run twice for the two-witness rule.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$ROOT"
fail=0
ok(){ printf '  ok   %s\n' "$1"; }
bad(){ printf '  RED  %s\n' "$1"; fail=1; }

echo "=== recency-backlog-gate ==="

# ── SHIPPED (regression guard — these must STAY green) ──────────────────────────────────
bash scripts/crypto-completion-gate.sh >/dev/null 2>&1 \
  && ok "crypto-was-all-you-needed P0–P7 (crypto-completion-gate)" \
  || bad "crypto-completion-gate regressed"

bun test tests/proof-generation.test.ts tests/vault-wallet-sealed.test.ts tests/plan-drill.test.ts >/dev/null 2>&1 \
  && ok "good-defaults: ZK default-on + vault sealing default-on + native plan-drill" \
  || bad "good-defaults suite regressed"

# "Done = landed": PR #852 is MERGED (squash-merge creates a new main commit, so the branch
# commit isn't an ancestor — the PR's merged state is the authoritative shipped signal).
if [ "$(gh pr view 852 --json state -q .state 2>/dev/null)" = "MERGED" ]; then
  ok "session work shipped to main (PR #852 squash-merged + mirrored to gitea)"
else bad "session work NOT shipped (PR #852 not merged)"; fi

# ── OPEN residuals (external / resource-gated — RED until genuinely done) ────────────────
[ -f .claude/phase6-cloud-runtime-verified.marker ] \
  && ok "P6 cloud-runtime /contract/declare live (marker present)" \
  || bad "P6 cloud-runtime — external: cloud endpoint sabbath-paused, not the unbrowse repo"

[ -f .claude/phase4-prod-verified.marker ] \
  && ok "/reveal promoted to PROD (marker present)" \
  || bad "/reveal prod deploy — gated: verified on preview, prod needs staging→main"

# P5 live embedding leg: needs a FUNDED OpenAI key + EMERGENTDB_API_KEY (offline pipeline already green).
if [ "${EMBED_E2E:-0}" = "1" ] && bun test tests/emergentdb-contract-search.test.ts >/dev/null 2>&1; then
  ok "P5 live embedding leg (EMBED_E2E funded)"
else bad "P5 live embedding leg — gated: funded OpenAI key + EMERGENTDB_API_KEY (offline pipeline IS green)"; fi

echo
if [ "$fail" -ne 0 ]; then echo "RECENCY-BACKLOG-GATE RED — recency tail not all done (shipped top green; external residuals open)."; exit 1; fi
echo "RECENCY-BACKLOG-GATE GREEN — everything ranked by recency is completed and done."
