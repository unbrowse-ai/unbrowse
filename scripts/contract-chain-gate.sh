#!/usr/bin/env bash
# contract-chain-gate.sh — the BINDING witness for "cli + server + frontend bound as ONE source
# of truth, precedence papers → code → cli → frontend, all /contract-native, with /taste."
#
# It witnesses each adjacent reflection LINK with a runnable check (never asserted), proves the
# /taste + chain logic settles (bun tests), then records the bound chain as one /contract on the
# stack (IQ + emergent cache + RAG) — fail-open per tier. The chain BINDS only when every link
# reflects AND its taste settles.
#
#   Link A  papers → code      paper-gate            (every shipped claim maps to a code anchor)
#   Link B  code   → cli        cli-papers-docs-check (eval stats --json surfaces the code's story)
#   Link C  cli    → frontend   contract-chain-frontend-check (papers.ts ↔ index, PDFs, /contract)
#   /taste  + chain logic       bun tests (taste = min over links; one broken link breaks both)
#
# Two-witness rule: run twice (the gate is idempotent). Exit 0 only when the chain binds.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$ROOT"
fail=0
A=f; B=f; C=f

echo "=== contract-chain-gate: papers → code → cli → frontend ==="

# Link A — papers → code
if bash scripts/paper-gate.sh paper/crypto-was-all-you-needed.tex >/dev/null 2>&1; then
  echo "  ok   A: papers → code   (claims map to code anchors)"; A=t
else echo "  RED  A: papers → code  (paper-gate)"; fail=1; fi

# Link B — code → cli
if bash scripts/cli-papers-docs-check.sh >/dev/null 2>&1; then
  echo "  ok   B: code → cli      (eval stats --json surfaces the papers/economy/privacy story)"; B=t
else echo "  RED  B: code → cli     (cli-papers-docs-check)"; fail=1; fi

# Link C — cli → frontend
if bash scripts/contract-chain-frontend-check.sh >/dev/null 2>&1; then
  echo "  ok   C: cli → frontend  (papers.ts ↔ index, PDFs present, /contract surfaced)"; C=t
else echo "  RED  C: cli → frontend (contract-chain-frontend-check)"; fail=1; fi

# /taste + chain logic + reconcile + broadcast — the binding settles only when every axis (link)
# clears the bar; reconcile catches contradicting /contract claims; broadcast is fail-open.
if timeout 150 bun test tests/contract-taste.test.ts tests/contract-chain.test.ts \
     tests/contract-reconcile.test.ts tests/contract-broadcast.test.ts >/dev/null 2>&1; then
  echo "  ok   /taste + chain + reconcile + broadcast logic (min over links/pairs; fail-open sinks)"
else echo "  RED  /taste + chain + reconcile + broadcast (bun tests)"; fail=1; fi

echo
if [ "$fail" -ne 0 ]; then
  echo "CONTRACT-CHAIN-GATE RED — chain not bound."
  exit 1
fi

# All links reflect → record the bound chain as one /contract on the stack (fail-open per tier).
echo "--- recording the bound chain as a /contract on the stack ---"
bun scripts/contract-chain-bind.ts --links "$A,$B,$C" 2>&1 | sed 's/^/  /'
rc=${PIPESTATUS[0]}

echo
[ "$rc" -eq 0 ] && { echo "CONTRACT-CHAIN-GATE GREEN — papers → code → cli → frontend BOUND, /taste settled."; exit 0; } \
                 || { echo "CONTRACT-CHAIN-GATE RED — bind step reported unbound."; exit 1; }
