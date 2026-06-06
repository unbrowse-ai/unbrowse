#!/usr/bin/env bash
# whitepaper-benchmarks-gate.sh — the witness for "benchmarks included + published".
# Exits 0 exactly when the REAL benchmark results are honestly included across the
# whitepaper (tex + rendered pdf + md), the public docs, and the pbcopy md — moat-safe.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$ROOT"
fail(){ echo "[wp-bench] FAIL: $*"; exit 1; }
ok(){ echo "[wp-bench] ok: $*"; }
TEX="paper/crypto-was-all-you-needed.tex"

# 1. the pbcopy md exists + carries the honest wins
B="bench/BENCHMARKS.md"
[ -s "$B" ] || fail "no $B (the pbcopy benchmarks md)"
grep -qE '9/9' "$B" && grep -qE '68%.*100%' "$B" || fail "$B missing the anti-bot or execute-don't-guess result (honest 68%->100%)"
ok "benchmarks md present (anti-bot 9/9 + execute-don't-guess)"

# 2. the whitepaper tex includes the anti-bot retrieval result AND the execute-don't-guess thesis
grep -qE '9/9|9,9' "$TEX" || fail "paper tex missing anti-bot 9/9 result"
grep -qiE 'execute,? not guess|execute.don.t.guess|route to a real tool|68.*100' "$TEX" || fail "paper tex missing the execute-don't-guess benchmark"
ok "whitepaper tex includes anti-bot + execute-don't-guess benchmarks"

# 3. paper renders (pdf + md fresh) — both >= tex mtime
for ext in pdf md; do
  f="paper/crypto-was-all-you-needed.$ext"
  [ -f "$f" ] || fail "$f not rendered"
  [ "$TEX" -nt "$f" ] && fail "$f older than tex (re-render)"
done
ok "whitepaper rendered (pdf + md current)"

# 4. paper-gate: reflects code + no moat leak
bash scripts/paper-gate.sh "$TEX" >/dev/null 2>&1 || fail "paper-gate failed (reflects-code or moat leak)"
ok "paper-gate passes (reflects code + no leak)"

# 5. public docs include the benchmark (the website/docs surface)
grep -qE '9/9|3\.6.|anti-bot' docs/benchmarks.md 2>/dev/null || fail "docs/benchmarks.md missing the benchmark results"
ok "public docs include the benchmarks"

# 6. moat-safe: leak-guard clean + no site name in the public benchmark surfaces
bash scripts/leak-guard.sh >/dev/null 2>&1 || fail "leak-guard hit a public path"
grep -qiE '\breddit\b' "$B" docs/benchmarks.md "$TEX" 2>/dev/null && fail "site name leaked into a public benchmark surface (use 'a major social platform')"
ok "moat-safe (leak-guard clean, no site names)"

# 7. docs-sync-gate green (docs accurate to code)
bash scripts/docs-sync-gate.sh >/dev/null 2>&1 || fail "docs-sync-gate red"
ok "docs-sync-gate green"

echo "[wp-bench] PASS — benchmarks honestly included in whitepaper (tex+pdf+md) + public docs + pbcopy md, moat-safe"
exit 0
