#!/usr/bin/env bash
# End-to-end exercise for the Exa/BrowseComp gate manifest.
#
# Full path: manifest artifact -> validator -> manifest tests -> real historical
# BrowseComp gate behavior -> release interpretation. This script intentionally
# allows the old fast gate to pass only when the manifest marks it non-release
# and points to the robust release witness.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

fail=0
note() { echo "[gate-manifest-e2e] $*"; }
bad() { echo "[gate-manifest-e2e] FAIL: $*" >&2; fail=1; }

note "1/5 validate manifest"
python3 bench/exa/validate_gate_manifest.py || bad "manifest validator failed"

note "2/5 run manifest tests"
bun test tests/exa-gate-manifest.test.ts || bad "manifest tests failed"

note "3/5 inspect manifest classification"
if ! python3 - <<'PY'; then
import json
from pathlib import Path
m = json.loads(Path("bench/exa/gate_manifest.json").read_text())
entries = {e["id"]: e for e in m["entries"]}
fast = entries.get("browsecomp-fast-historical")
robust = entries.get("browsecomp-robust-historical")
errors = []
if not fast:
    errors.append("missing browsecomp-fast-historical")
elif fast.get("release_eligible") is not False:
    errors.append("fast historical gate must be non-release")
elif fast.get("replacement") != "bench/browsecomp/beat-exa-robust-gate.sh":
    errors.append("fast historical gate must point to robust replacement")
if not robust:
    errors.append("missing browsecomp-robust-historical")
elif robust.get("release_eligible") is not True:
    errors.append("robust historical gate must be release-eligible")
elif robust.get("minimum_n", 0) < 25:
    errors.append("robust historical gate must require minimum_n >= 25")
if errors:
    print("\n".join(errors))
    raise SystemExit(1)
print("classification ok")
PY
  bad "manifest classification is not release-safe"
fi

note "4/5 observe old fast gate (triage only)"
if bash bench/browsecomp/beat-exa-gate.sh; then
  note "old fast gate is green, but manifest classifies it as non-release"
else
  note "old fast gate is red; still non-release"
fi

note "5/5 observe robust release gate"
if bash bench/browsecomp/beat-exa-robust-gate.sh; then
  note "robust BrowseComp release witness is green"
else
  note "robust BrowseComp release witness is red; completion promise remains unmet"
fi

if [ "$fail" -ne 0 ]; then
  exit 1
fi
note "PASS — manifest governs the old/robust BrowseComp seam without fake-green release"
