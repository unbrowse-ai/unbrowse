#!/usr/bin/env bash
# rollout-ready-gate.sh — everything MECHANICAL for the sequenced rollout is done;
# the human sign-off is wired as a separate gate, not a loop-trap.
#
# The lesson (re-lens): a never-exit witness must test what the AGENT can settle,
# never a person's signature. The signature is real and tracked (paper/SIGNOFF.md +
# whitepaper-signoff-gate.sh), but it is GRACE — outside this gate. This gate is
# green when the rollout is fully prepared and sequenced:
#   1. Papers finished as code (papers-done-gate).
#   2. Public surface is org-clean + publishable (github-public-gate + the two
#      publish-readiness checks).
#   3. The rollout is wired: the ordered pipeline, the human sign-off gate + sheet,
#      and the drafted sign-off request all exist.
# When this is green the only things left are credentialed/human triggers (publish
# logins; Kevin/Rach's signature) — which no agent can or should fake.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
fail=0
section() { echo; echo "=== $1 ==="; }
run() { if bash "$@" >/tmp/rrg.out 2>&1; then echo "  green: $*"; else echo "  FAIL: $* (see /tmp/rrg.out)"; fail=1; fi; }

section "1. papers finished as code"
run scripts/papers-done-gate.sh

section "2. public surface org-clean + publishable"
run scripts/github-public-gate.sh
run scripts/check-dropins-publishable.sh
if python3 scripts/check-python-publishable.py >/tmp/rrg_py.out 2>&1; then echo "  green: python wheels (6/6)"; else echo "  FAIL: check-python-publishable"; fail=1; fi

section "3. rollout wired (pipeline + human gate + drafted request)"
for f in scripts/rollout-sequence.sh scripts/whitepaper-signoff-gate.sh paper/SIGNOFF.md; do
  [ -f "$f" ] && echo "  present: $f" || { echo "  MISSING: $f"; fail=1; }
done
if [ -f "$HOME/.outbox/paper2-signoff-request.md" ]; then echo "  present: sign-off request drafted (~/.outbox/paper2-signoff-request.md)"; else echo "  MISSING: drafted sign-off request"; fail=1; fi
# the pipeline must run and name the current blocker honestly
if bash scripts/rollout-sequence.sh 2>/dev/null | grep -q "Current blocker: Stage 2"; then echo "  honest: pipeline names the Stage-2 sign-off as the current blocker"; else echo "  FAIL: rollout-sequence does not name the blocker"; fail=1; fi

echo
if [ "$fail" -ne 0 ]; then echo "ROLLOUT-READY-GATE FAIL — mechanical rollout prep is not complete."; exit 1; fi
echo "ROLLOUT-READY-GATE PASS — rollout fully prepared + sequenced; only credentialed/human triggers remain (publish logins; Kevin/Rach sign-off)."
