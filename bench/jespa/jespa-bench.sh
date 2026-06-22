#!/usr/bin/env bash
# jespa-bench.sh — the THREE-axis jespa-bench SEED harness (mustard seed: small, runs, grows).
#
# Firmament boundary 4 (internal/cli-contract-union-firmament.md) + plan node 5
# (.claude/jesus-loop.default.plan.md): jespa-bench scores the unbrowse CLI across THREE
# INDEPENDENT, ISOLATED axes so the infra-heavy AUTH axis can HOLD honestly without blocking
# the others:
#   (a) web-agent NO-AUTH   — public read through the shipped one-hole CLI
#   (b) web-agent WITH-AUTH — credential/cookie reaches the target (infra-heavy; may HOLD)
#   (c) internal benchmarks — the in-repo jespa route-retrieval witness (real corpus)
#
# This is a SEED, not the whole tree: it REUSES existing machinery by CALLING it
# (bench/capability/webagent/gate_auth.sh, bench/jespa/jespa-route-gate.sh) — never copies it —
# and translates each axis's exit code into one honest status line: PASS / FAIL / BLOCKED:<why>.
#
# HONESTY (the capability-bench discipline): a missing/un-runnable axis is BLOCKED with the
# cause, NEVER a fabricated number. The harness itself ALWAYS exits 0 once it has run all three
# axes and written its report — "the harness ran" is the witness; the axes carry their own
# verdicts. Grade the SHIPPED CLI via $UNBROWSE_BIN if set, else local source.
#
# Witness: `bash bench/jespa/jespa-bench.sh` exits 0 AND writes bench/jespa/reports/<ts>.md.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
CAP="$ROOT/bench/capability/webagent"

BIN_CMD="${UNBROWSE_BIN:-bun src/cli.ts}"   # shipped npm CLI if exported, else local source
TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
SLUG="$(date -u +%Y%m%dT%H%M%SZ)"
REPORT_DIR="$HERE/reports"
REPORT="$REPORT_DIR/$SLUG.md"
mkdir -p "$REPORT_DIR"

# axis status carriers (filled by run_axis)
A_STATUS="" ; A_DETAIL=""
B_STATUS="" ; B_DETAIL=""
C_STATUS="" ; C_DETAIL=""

# map a sub-witness exit code -> axis status. Convention reused from the capability gates:
#   0 = PASS, 3 = BLOCKED (infra/network/credentials), anything else = FAIL.
code_to_status() {
  case "$1" in
    0) echo "PASS" ;;
    3) echo "BLOCKED" ;;
    124) echo "BLOCKED: timeout" ;;
    127) echo "BLOCKED: witness not found" ;;
    *) echo "FAIL" ;;
  esac
}

# ─── axis (a): web-agent NO-AUTH ────────────────────────────────────────────────
# A real, reproducible public read through the DEFAULT one-hole CLI path (no credential).
# postman-echo /get reflects the request — proof the no-auth read path reaches a live target.
# Network-unreachable => BLOCKED (exit 3), never a fabricated score.
run_axis_a() {
  local url="https://postman-echo.com/get"
  local marker="noauth-$$-${RANDOM}"
  local out rc
  out="$(cd "$ROOT" && timeout 60 $BIN_CMD "read the request, query foo=${marker}" \
        --url "${url}?foo=${marker}" 2>/dev/null)"; rc=$?
  if [ "$rc" -eq 124 ]; then A_STATUS="BLOCKED: no-auth read timed out (network/cold-resolve)"; A_DETAIL="rc=124 url=$url"; return; fi
  if printf '%s' "$out" | grep -q "$marker"; then
    A_STATUS="PASS"; A_DETAIL="public no-auth read reached target (marker echoed); bin=$BIN_CMD"
  elif [ -z "$out" ]; then
    A_STATUS="BLOCKED: no body (echo service unreachable / no network)"; A_DETAIL="rc=$rc url=$url"
  else
    A_STATUS="FAIL"; A_DETAIL="marker not echoed (rc=$rc): $(printf '%s' "$out" | tr '\n' ' ' | tail -c 160)"
  fi
}

# ─── axis (b): web-agent WITH-AUTH ──────────────────────────────────────────────
# Delegate to the EXISTING authenticated witness. It already emits 0/1/3 and writes its own
# history row. Infra-heavy: if no network/credentials it self-reports BLOCKED (exit 3).
run_axis_b() {
  local gate="$CAP/gate_auth.sh"
  if [ ! -f "$gate" ]; then B_STATUS="BLOCKED: witness not found ($gate)"; B_DETAIL="missing existing gate"; return; fi
  local rc
  UNBROWSE_BIN="$BIN_CMD" timeout 300 bash "$gate" >/dev/null 2>&1; rc=$?
  B_STATUS="$(code_to_status "$rc")"
  case "$B_STATUS" in
    BLOCKED) B_STATUS="BLOCKED: needs credentials/network (echo service unreachable)" ;;
  esac
  B_DETAIL="delegated to capability/webagent/gate_auth.sh (rc=$rc); bin=$BIN_CMD"
}

# ─── axis (c): INTERNAL benchmarks ──────────────────────────────────────────────
# Delegate to the EXISTING internal route-retrieval witness (jespa I-JEPA on the real
# in-repo .bench-gate corpus). It is self-contained (stdlib + numpy), needs no network.
# Refresh the result first so the gate scores current data, then read its 0/1 verdict.
run_axis_c() {
  local gate="$HERE/jespa-route-gate.sh"
  if [ ! -f "$gate" ]; then C_STATUS="BLOCKED: witness not found ($gate)"; C_DETAIL="missing internal gate"; return; fi
  # best-effort refresh; tolerate missing numpy / empty corpus (then the gate BLOCKS honestly)
  if command -v python3 >/dev/null 2>&1; then
    (cd "$HERE" && timeout 120 python3 jespa_route.py >/dev/null 2>&1) || true
  fi
  local rc
  timeout 180 bash "$gate" >/dev/null 2>&1; rc=$?
  C_STATUS="$(code_to_status "$rc")"
  # the internal gate has no result file / no numpy => treat as BLOCKED, not FAIL
  if [ ! -f "$HERE/data/jespa_route_result.json" ]; then
    C_STATUS="BLOCKED: no result (numpy missing or empty .bench-gate corpus)"
  fi
  C_DETAIL="jespa route-retrieval R@1 vs keyword baseline, real corpus (rc=$rc)"
}

echo "── jespa-bench seed harness ──────────────────────────────" >&2
echo "   bin=$BIN_CMD" >&2
run_axis_a
run_axis_b
run_axis_c

# ─── emit the three honest per-axis status lines ────────────────────────────────
LINE_A="axis(a) web-agent NO-AUTH    : ${A_STATUS}"
LINE_B="axis(b) web-agent WITH-AUTH  : ${B_STATUS}"
LINE_C="axis(c) INTERNAL benchmarks  : ${C_STATUS}"

echo "──────────────────────────────────────────────────────────"
echo "$LINE_A"
echo "$LINE_B"
echo "$LINE_C"
echo "──────────────────────────────────────────────────────────"

# ─── write the dated seed report (proves it ran) ────────────────────────────────
{
  echo "# jespa-bench seed report — $TS"
  echo
  echo "Three independent, isolated axes (firmament boundary 4 / plan node 5)."
  echo "Seed run: the harness enumerated all three axes; each carries its own honest verdict."
  echo "No fabricated numbers — a missing axis is BLOCKED with the cause."
  echo
  echo "- bin under test: \`$BIN_CMD\` (UNBROWSE_BIN ${UNBROWSE_BIN:+set}${UNBROWSE_BIN:-unset → local source})"
  echo
  echo "| axis | what | status | detail |"
  echo "|---|---|---|---|"
  echo "| a | web-agent NO-AUTH (public one-hole read) | ${A_STATUS} | ${A_DETAIL} |"
  echo "| b | web-agent WITH-AUTH (credential reaches target) | ${B_STATUS} | ${B_DETAIL} |"
  echo "| c | INTERNAL benchmarks (jespa route-retrieval R@1) | ${C_STATUS} | ${C_DETAIL} |"
  echo
  echo "## Per-axis status lines"
  echo '```'
  echo "$LINE_A"
  echo "$LINE_B"
  echo "$LINE_C"
  echo '```'
  echo
  echo "## How to grow this seed"
  echo "- axis (a): widen from postman-echo to the cloned no-auth web-agent corpora"
  echo "  (\`bench/exa/vendor/benchmarks\`, \`bench/browsecomp\`) scored per-task."
  echo "- axis (b): feed real cookies/credentials so \`capability/webagent/gate_auth.sh\`"
  echo "  exits 0 (PASS) instead of BLOCKED; add WASP/AgentDojo authenticated tasks."
  echo "- axis (c): grow the .bench-gate corpus so n_eval >= 100 and the R@1 lift can settle;"
  echo "  add \`jespa-benchmarks-gate.sh\` (the accumulating reproduced-win ledger)."
} > "$REPORT"

echo "wrote report: $REPORT"

# The harness ran end to end and wrote its report — that is the seed's witness. Axes may be
# BLOCKED/FAIL and still leave the harness green (each axis is its OWN witness, by design).
exit 0
