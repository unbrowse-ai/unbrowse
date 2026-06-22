#!/usr/bin/env bash
# network-is-moat-gate.sh — the BRIDGE witness that gates Phase B (full on-chain, moat opened).
# lewis-brain: opening the RE-engine is safe ONLY when the NETWORK is the moat (maintained
# route-graph + bonded accountability + settlement, per internal/paper/maintenance-network.tex),
# so the engine's secrecy is no longer load-bearing. This gate makes "do a then b next time"
# MECHANICAL: B is HELD until all three metrics are real AND cross threshold. No vibe; a witness.
#
# Exits 0 (→ B may proceed) ONLY when, on REAL data:
#   M1 routes   — maintained public route count        >= ROUTE_MIN   (network breadth)
#   M2 bonding  — bonded maintainers (FDRY stakers)     >= BOND_MIN    (skin in the game)
#   M3 settle   — 30d settlement volume (USDC)          >= SETTLE_MIN  (live economic moat)
# Until then it exits 1 with "B HELD" — opening the engine early gives the moat away for free.
set -uo pipefail
ROUTE_MIN="${ROUTE_MIN:-10000}"; BOND_MIN="${BOND_MIN:-50}"; SETTLE_MIN="${SETTLE_MIN:-10000}"
hold() { echo "B HELD — $1 (Phase B stays held; the network is not yet the moat)"; exit 1; }

# Real sources (on-chain IQ ledger + FDRY Voltr vault + settlement ledger). In-env these are
# not queryable without live RPC/keys → honest BLOCKED, which KEEPS B held (fail-closed, correct).
routes="${NETWORK_ROUTE_COUNT:-}"
bonders="${NETWORK_BONDED_MAINTAINERS:-}"
settle="${NETWORK_SETTLE_30D_USD:-}"

[ -n "$routes" ]  || hold "M1 routes: BLOCKED — maintained-route count not measurable in-env (needs the on-chain registry); set NETWORK_ROUTE_COUNT from real data"
[ -n "$bonders" ] || hold "M2 bonding: BLOCKED — bonded-maintainer count not measurable in-env (needs FDRY Voltr vault read)"
[ -n "$settle" ]  || hold "M3 settle: BLOCKED — 30d settlement volume not measurable in-env (needs the settlement ledger)"

[ "$routes"  -ge "$ROUTE_MIN" ]  || hold "M1 routes=$routes < $ROUTE_MIN"
[ "$bonders" -ge "$BOND_MIN" ]   || hold "M2 bonders=$bonders < $BOND_MIN"
[ "$settle"  -ge "$SETTLE_MIN" ] || hold "M3 settle=$settle < $SETTLE_MIN"

echo "GATE GREEN — network-is-the-moat (routes=$routes bonders=$bonders settle=\$$settle):"
echo "  the RE-engine secrecy is no longer load-bearing → Phase B (open engine, full on-chain) may proceed."
