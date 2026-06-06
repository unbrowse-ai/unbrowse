#!/usr/bin/env bash
# witness-locality-gate.sh — the witness-locality debt is fixed: the execute-don't-guess
# proofs run from the unbrowse repo, not a sibling. Exit 0 iff all hold.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
fail(){ echo "[locality] FAIL: $*"; exit 1; }
# 1. the 4 witnesses + server + r1 dep are vendored here
for f in codebench_witness.py farformula_witness.py specialist_witness.py skillfollow_witness.py aiko_server.py r1_witness.py; do
  [ -f "$f" ] || fail "missing vendored $f"
done
echo "[locality] ok: 4 witnesses + server + r1 dep vendored in unbrowse"
# 2. self-contained: no hardcoded sibling-repo path
! grep -rqn 'tinytools-agent\|/Users/' *.py || fail "a vendored script has a hardcoded sibling/absolute path"
echo "[locality] ok: self-contained (no hardcoded sibling-repo paths)"
# 3. compile clean
for f in *.py; do python3 -m py_compile "$f" 2>/dev/null || fail "$f does not compile"; done
echo "[locality] ok: all vendored scripts compile"
# 4. proof-of-run: codebench produced a green result FROM HERE
[ -f .codebench_proof ] && grep -q "CODEBENCH PASS" .codebench_proof || fail "no proof codebench ran green from the vendored location (run: RIFE codebench_witness.py | tee .codebench_proof)"
echo "[locality] ok: codebench ran green from the vendored location ($(grep -oE 'improved.*100' .codebench_proof | head -1))"
echo "[locality] PASS — execute-don't-guess witnesses are reproducible from the unbrowse repo"
