#!/usr/bin/env bash
# replace-gate — the witness for "unbrowse is a drop-in replacement for Exa,
# Browser-Use, MCPs and CLI skills — better AND faster."
#
# HONESTY (read this): a TRUE live head-to-head against the real exa / browser-use
# packages needs API keys, a browser, and the network — flaky, heavy, and belongs in
# CI/turbobox, not a fast local gate. So this gate, like backend/scripts/perf-gate.sh,
# splits into a DETERMINISTIC tier that is GATED (exit 0 depends only on it) and a
# LIVE tier that is best-effort EVIDENCE (never gated, needs keys). The gated tier
# proves the reproducible core of the claim; the live tier is where the real-world
# comparison is recorded. No fabricated green.
#
# GATED (tier 1, hermetic, reproducible):
#   1. privacy/moat frontier green   — scripts/zk-gate.sh (ZK'd-to-wallet backend
#      harness; the "legal via ZK, don't reveal the IP" + "client surfaces only
#      holes" story that makes the replacement safe to open-source)
#   2. faster (mechanism + margin)   — tests/replay-speed.test.ts: the warm cached
#      replay path SKIPS the cold work and is ≥20× faster in real wall-clock; this is
#      WHY unbrowse beats an always-cold agent (Browser-Use) and an always-paid API (Exa)
#   3. drop-in interface parity      — every surface a user would switch FROM exists:
#      exa→search, browser-use→browse+execute(replay), MCP, CLI skills, OpenAI-compat
#      SDK, and the stateless binary the north star requires
#
# LIVE (tier 2, evidence only, needs keys): the exa extraction scorer (quality
# "better": the recorded two-witness 0.8919 > Exa 0.828) and the BrowseComp gate.
set -uo pipefail
cd "$(dirname "$0")/.."   # repo root

fail=0

echo "=== GATED 1/3 — privacy/moat frontier (zk-gate) ==="
if ! bash scripts/zk-gate.sh >/tmp/replace-zk.log 2>&1; then
  echo "[replace-gate] FAIL — zk-gate red:"; tail -6 /tmp/replace-zk.log; fail=1
else
  echo "  ok — backend-is-the-harness frontier green ($(grep -c '  built' /tmp/replace-zk.log) nodes)"
fi

echo "=== GATED 2/3 — faster: warm replay ≥20× the cold path (real wall-clock) ==="
if ! bun test tests/replay-speed.test.ts >/tmp/replace-speed.log 2>&1; then
  echo "[replace-gate] FAIL — replay-speed red:"; tail -6 /tmp/replace-speed.log; fail=1
else
  echo "  ok — $(grep -oE '[0-9]+ pass' /tmp/replace-speed.log | head -1), warm path categorically faster"
fi

echo "=== GATED 3/3 — drop-in interface parity (the surfaces a user switches FROM) ==="
# anchor file/command → what it replaces. A missing anchor fails the gate.
declare -a PARITY=(
  "src/superpattern/cli-surface.ts:::search:::exa → search (exa-like results)"
  "src/superpattern/cli-surface.ts:::execute:::browser-use → resolve+execute (cached replay)"
  "src/superpattern/cli-surface.ts:::go:::browser-use → go/snap/click (live browse when needed)"
  "src/superpattern/cli-surface.ts:::mcp:::MCP server surface"
  "src/superpattern/cli-surface.ts:::skills:::CLI skills surface"
  "src/cli-v7/_stateless.ts:::::::stateless binary (north-star requirement)"
  "packages/ai-sdk/package.json:::::::OpenAI-compat SDK (familiar drop-in wrapper)"
  "src/sdk/index.ts:::::::programmatic SDK surface"
)
parity_fail=0
for entry in "${PARITY[@]}"; do
  file="${entry%%:::*}"; rest="${entry#*:::}"; needle="${rest%%:::*}"; label="${rest##*:::}"
  if [ ! -f "$file" ]; then echo "  MISSING [$label] — $file absent"; parity_fail=1; continue; fi
  if [ -n "$needle" ] && ! grep -q "$needle" "$file"; then
    echo "  MISSING [$label] — '$needle' not in $file"; parity_fail=1; continue
  fi
  echo "  ok — $label"
done
[ "$parity_fail" -ne 0 ] && fail=1

echo
echo "=== LIVE evidence (tier 2, NOT gated; needs keys — CI/turbobox is the real venue) ==="
set -a; . ./.env 2>/dev/null || true; set +a
if [ -n "${UNBROWSE_API_KEY:-}" ] || [ -n "${OPENROUTER_API_KEY:-}" ]; then
  echo "  (keys present — run: bash bench/exa/search-on-top.sh  and  bash bench/browsecomp/browsecomp-gate.sh)"
else
  echo "  (skipped — no keys; quality 'better' is the recorded exa-bench-win 0.8919 > 0.828, commit b07f7617)"
fi

echo
if [ "$fail" -ne 0 ]; then
  echo "[replace-gate] NOT YET — a gated tier is red. Keep walking."
  exit 1
fi
echo "[replace-gate] PASS — privacy frontier green; warm replay categorically faster; every drop-in surface present."
echo "  (faster+safe+parity are gated & reproducible; live head-to-head vs exa/browser-use packages is CI/turbobox evidence.)"
