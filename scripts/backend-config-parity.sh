#!/usr/bin/env bash
# backend-config-parity.sh — ONE structural check over the backend's config and
# secret provisioning. Never reads, prints, or requires a secret VALUE; it only
# compares NAMES and committed constants across four artifacts that have to
# agree and historically did not:
#
#   A  backend/docs/OPS-PROXY-X402-CAPZY-UNLOCK.md   the runbook's secret inventory
#   B  .github/workflows/deploy.yml                  what main deploy provisions
#   C  .github/workflows/gitea-mini-deploy.yml       what the mini path provisions
#   D  backend/src/types.ts                          what the Worker actually reads
#
# The four failure modes it catches, each of which shipped at least once:
#
#   1. RUNBOOK SAYS, NOBODY PROVISIONS. A secret in the inventory that no deploy
#      workflow puts, and that is not declared operator-manual. Silent drift:
#      redeploy a Worker and the feature is off with no error anywhere.
#   2. MAIN/MINI SKEW. deploy.yml provisions a secret gitea-mini-deploy.yml does
#      not (this is exactly how /v1/unlock sat at broker_unconfigured on the mini
#      path while main was fine).
#   3. PROVISIONED INTO THE VOID. A workflow puts a Worker secret that the Env
#      type never declares, so nothing reads it — unless the runbook explicitly
#      says it is consumed elsewhere.
#   4. DOC/CODE CONSTANT DRIFT. The runbook quotes a default that the code no
#      longer has. Operators price against the doc.
#
# The declarations in §0 of the runbook are the escape valve, and they are the
# point: a gap has to be WRITTEN DOWN to pass, so an unprovisioned secret is a
# stated decision instead of an accident.

set -uo pipefail

cd "$(git rev-parse --show-toplevel)"

RUNBOOK="backend/docs/OPS-PROXY-X402-CAPZY-UNLOCK.md"
DEPLOY_MAIN=".github/workflows/deploy.yml"
DEPLOY_MINI=".github/workflows/gitea-mini-deploy.yml"
ENV_TYPES="backend/src/types.ts"

fail=0
note() { printf '[config-parity] %s\n' "$*"; }
bad() { printf '[config-parity] FAIL: %s\n' "$*" >&2; fail=1; }

for f in "$RUNBOOK" "$DEPLOY_MAIN" "$DEPLOY_MINI" "$ENV_TYPES"; do
  [ -f "$f" ] || { bad "missing artifact: $f"; }
done
[ "$fail" = "0" ] || exit 1

# ── read the declarations block out of the runbook ────────────────────
# Lines of the form:  <!-- config-parity: operator-manual NAME reason -->
#                     <!-- config-parity: not-worker-read NAME reason -->
declared() {
  grep -oE "<!-- config-parity: $1 [A-Z0-9_]+" "$RUNBOOK" 2>/dev/null \
    | awk '{print $NF}' | sort -u
}
OPERATOR_MANUAL="$(declared operator-manual)"
NOT_WORKER_READ="$(declared not-worker-read)"

in_set() {
  printf '%s\n' "$2" | grep -qxF "$1"
}

# ── A: the runbook's "| Secret | Purpose |" inventory ─────────────────
# SECTION-SCOPED on purpose. The runbook carries a second table of plain
# committed vars ("| Var | Role |") immediately after; treating both as
# secrets would demand `wrangler secret put UNLOCK_UPSTREAM_COST_USD`,
# which is nonsense. Read rows only between the Secret header and the
# next table header.
RUNBOOK_SECRETS="$(
  awk '
    /^\| *Secret *\| *Purpose *\|/ { in_tbl = 1; next }
    /^\| *Var *\| *Role *\|/       { in_tbl = 0 }
    in_tbl && /^\|/ && !/^\| *-/   { print }
  ' "$RUNBOOK" \
    | awk -F'|' '{print $2}' \
    | grep -oE '[A-Z][A-Z0-9_]{3,}' | sort -u
)"

if [ -z "$RUNBOOK_SECRETS" ]; then
  bad "found no '| Secret | Purpose |' inventory rows in $RUNBOOK — the gate would pass vacuously"
fi

# ── B/C: what each deploy workflow provisions ─────────────────────────
puts_in() {
  grep -oE 'wrangler secret put [A-Z0-9_]+' "$1" 2>/dev/null | awk '{print $NF}' | sort -u
}
MAIN_PUTS="$(puts_in "$DEPLOY_MAIN")"
MINI_PUTS="$(puts_in "$DEPLOY_MINI")"
ALL_PUTS="$(printf '%s\n%s\n' "$MAIN_PUTS" "$MINI_PUTS" | grep -v '^$' | sort -u)"

if [ -z "$ALL_PUTS" ]; then
  bad "no 'wrangler secret put' found in either deploy workflow — the gate would pass vacuously"
fi

# ── 1. runbook secret must be provisioned or declared operator-manual ─
for s in $RUNBOOK_SECRETS; do
  if in_set "$s" "$ALL_PUTS"; then continue; fi
  if in_set "$s" "$OPERATOR_MANUAL"; then
    note "operator-manual (declared): $s"
    continue
  fi
  # not-worker-read implies not-a-Worker-secret: it is inventoried here because
  # an operator has to place it SOMEWHERE (the mini-egress host), but a deploy
  # workflow pushing it into the Worker would be exactly the mistake #3 catches.
  if in_set "$s" "$NOT_WORKER_READ"; then
    note "host-side, not a Worker secret (declared): $s"
    continue
  fi
  bad "$s is in the runbook inventory but no deploy workflow provisions it, and it is not declared operator-manual or not-worker-read in $RUNBOOK"
done

# ── 2. main and mini must provision the same set ──────────────────────
for s in $MAIN_PUTS; do
  in_set "$s" "$MINI_PUTS" || bad "$DEPLOY_MAIN provisions $s but $DEPLOY_MINI does not (main/mini skew)"
done
for s in $MINI_PUTS; do
  in_set "$s" "$MAIN_PUTS" || bad "$DEPLOY_MINI provisions $s but $DEPLOY_MAIN does not (main/mini skew)"
done

# ── 3. a provisioned Worker secret must be readable by the Worker ─────
for s in $ALL_PUTS; do
  if grep -qE "^[[:space:]]*$s\??:" "$ENV_TYPES"; then continue; fi
  if in_set "$s" "$NOT_WORKER_READ"; then
    note "not read by the Worker (declared): $s"
    continue
  fi
  bad "$s is provisioned as a Worker secret but is not a field of Env in $ENV_TYPES, and is not declared not-worker-read"
done

# ── 4. doc/code constant parity ───────────────────────────────────────
CODE_BPS="$(grep -oE 'export const FAIR_COMPENSATION_BPS *= *[0-9]+' backend/src/services/fair-compensation.ts 2>/dev/null | grep -oE '[0-9]+$')"
if [ -z "$CODE_BPS" ]; then
  bad "could not read FAIR_COMPENSATION_BPS from backend/src/services/fair-compensation.ts"
elif ! grep -qE "code default $CODE_BPS\b" "$RUNBOOK"; then
  bad "$RUNBOOK does not state the code's FAIR_COMPENSATION_BPS default ($CODE_BPS) as 'code default $CODE_BPS'"
else
  note "FAIR_COMPENSATION_BPS: code=$CODE_BPS, runbook agrees"
fi

if [ "$fail" != "0" ]; then
  echo "" >&2
  echo "[config-parity] backend config/secret provisioning is out of parity." >&2
  echo "[config-parity] Either provision the secret in BOTH deploy workflows, or declare the" >&2
  echo "[config-parity] gap in $RUNBOOK with a line like:" >&2
  echo "[config-parity]   <!-- config-parity: operator-manual NAME why it is put by hand -->" >&2
  exit 1
fi

note "GREEN — runbook, both deploy workflows, Env, and the quoted constants agree"
exit 0
