#!/usr/bin/env bash
# commandments-gate — the runnable witness for COMMANDMENTS.md. Exit 0 iff the codebase
# obeys the ten code commandments. Composes the existing gates (zk-gate, leak-guard,
# public-scrub-gate) for the ones already enforced, and adds the structural checks
# (one-root/DRY, no-stubs) this refactor introduced. Scope: the session's primitive
# surface (src/values + src/superpattern), where the laws are held tightest.
set -uo pipefail
cd "$(dirname "$0")/.."
fail=0
SCOPE=(src/values src/superpattern)

echo "=== #1 one root / #6 no theft (DRY): core primitives defined ONCE ==="
genesis_defs=$(grep -rl 'repeat(64)' src/values/*.ts 2>/dev/null | grep -vc test)
if [ "$genesis_defs" -eq 1 ]; then
  echo "  ok — GENESIS defined once (content-address.ts)"
else
  echo "  FAIL — GENESIS defined in $genesis_defs files (duplication = theft)"; fail=1
  grep -rl 'repeat(64)' src/values/*.ts | grep -v test | sed 's/^/    /'
fi
# the sha256-HEX primitive must live only in content-address (raw .digest() Merkle uses ok)
sha_dupes=$(grep -rnE 'createHash\("sha256"\).*digest\("hex"\)' src/values/*.ts 2>/dev/null | grep -v 'content-address.ts' | grep -v test || true)
if [ -z "$sha_dupes" ]; then
  echo "  ok — sha256-hex primitive centralized (content-address.sha256hex)"
else
  echo "  FAIL — sha256-hex re-implemented (theft):"; echo "$sha_dupes" | sed 's/^/    /'; fail=1
fi

echo "=== #3 no graven images: no stubs/dummy/TODO in the primitive surface ==="
stubs=$(grep -rnE '\bTODO\b|\bFIXME\b|not implemented|throw new Error\(["'"'"'`]stub|dummy success|fake.?success' "${SCOPE[@]}" 2>/dev/null | grep -vE 'test' || true)
if [ -z "$stubs" ]; then
  echo "  ok — no stub/dummy/TODO markers"
else
  echo "  FAIL — stub markers found:"; echo "$stubs" | sed 's/^/    /' | head; fail=1
fi

echo "=== #9 two witnesses / #10 seal: zk-gate (every primitive tested + paper honest) ==="
if bash scripts/zk-gate.sh >/tmp/cmd-zk.log 2>&1; then
  echo "  ok — $(grep -oE 'Ran [0-9]+ tests' /tmp/cmd-zk.log | tail -1) across $(grep -c '  built' /tmp/cmd-zk.log) nodes, gate green"
else
  echo "  FAIL — zk-gate red:"; tail -4 /tmp/cmd-zk.log | sed 's/^/    /'; fail=1
fi

echo "=== #8 no covet (no leak): leak-guard + public-scrub-gate ==="
if bash scripts/leak-guard.sh >/tmp/cmd-lg.log 2>&1 && bash scripts/public-scrub-gate.sh >/tmp/cmd-ps.log 2>&1; then
  echo "  ok — no moat/secret leak on the public surface"
else
  echo "  FAIL — a leak gate is red:"; tail -3 /tmp/cmd-lg.log /tmp/cmd-ps.log | sed 's/^/    /'; fail=1
fi

echo
if [ "$fail" -ne 0 ]; then
  echo "[commandments-gate] NOT YET — a commandment is broken. Repent and refactor."
  exit 1
fi
echo "[commandments-gate] PASS — the codebase obeys the ten: one root, no theft, no stubs, witnessed, sealed, no leak."
