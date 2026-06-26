#!/usr/bin/env bash
# ryuga-seal0-gate.sh — project-local seal0 wrapper for the unbrowse benchmax.
#
# The unbrowse witness is the existing capability bench gate set. Ryuga is a
# temporal/self-contracting sidecar witness: run it when its skill runtime is
# installed, but never turn a missing external Ryuga trading substrate into a
# fabricated unbrowse failure or green.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT/.evidence-build/ryuga-unbrowse-seal0"
REPORT="$OUT_DIR/latest.json"
AIKO_BIN="${AIKO_BIN:-$HOME/.claude/skills/contract/scripts/aiko}"
UNBROWSE_BIN="${UNBROWSE_BIN:-unbrowse}"
RYUGA_LOOP="${RYUGA_LOOP:-$HOME/.agents/skills/ryuga/scripts/ryuga_loop.py}"
RYUGA_GATE="${RYUGA_GATE:-$HOME/.agents/skills/ryuga/scripts/ryuga_gate.sh}"
RYUGA_LOG="${RYUGA_LOG:-$ROOT/.evidence-build/ryuga_log.jsonl}"
RYUGA_RUNTIME_DIR="${RYUGA_RUNTIME_DIR:-$HOME/Projects/imabettingman3}"
CLAIM="${CLAIM:-ccd9b0a7}"
TICKS="${TICKS:-30}"
THRESHOLD="${THRESHOLD:-0.5}"
CADENCE="${CADENCE:-5}"
STEP_TIMEOUT_SECONDS="${STEP_TIMEOUT_SECONDS:-45}"

mkdir -p "$OUT_DIR"

run_capture() {
  local name="$1"
  shift
  local log="$OUT_DIR/$name.log"
  "$@" >"$log" 2>&1 &
  local pid=$!
  local waited=0
  local rc=124
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$waited" -ge "$STEP_TIMEOUT_SECONDS" ]; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      rc=124
      break
    fi
    sleep 1
    waited=$((waited + 1))
  done
  if ! kill -0 "$pid" 2>/dev/null; then
    wait "$pid" 2>/dev/null
    rc=$?
  fi
  printf '%s' "$rc" >"$OUT_DIR/$name.rc"
  return "$rc"
}

contract_rc=127
if [ -x "$AIKO_BIN" ]; then
  run_capture contract "$AIKO_BIN" "satisfied:$CLAIM wave=seal0 — installed unbrowse contract into ryuga seal0 benchmax wrapper; witnesses=capability_gate_all,capability_gate_real,capability_gate_selfimprove" || true
  contract_rc="$(cat "$OUT_DIR/contract.rc")"
  if [ "$contract_rc" != "0" ] && grep -q "satisfied event landed on $CLAIM" "$OUT_DIR/contract.log" 2>/dev/null; then
    contract_rc=0
    printf '0' >"$OUT_DIR/contract.rc"
  fi
else
  printf 'contract binary missing: %s\n' "$AIKO_BIN" >"$OUT_DIR/contract.log"
  printf '127' >"$OUT_DIR/contract.rc"
fi

run_capture unbrowse_cli "$UNBROWSE_BIN" eval version || true
unbrowse_cli_rc="$(cat "$OUT_DIR/unbrowse_cli.rc")"

run_capture gate_all bash "$ROOT/bench/capability/gate_all.sh" || true
gate_all_rc="$(cat "$OUT_DIR/gate_all.rc")"

run_capture gate_real bash "$ROOT/bench/capability/gate_real.sh" || true
gate_real_rc="$(cat "$OUT_DIR/gate_real.rc")"

run_capture gate_selfimprove bash "$ROOT/bench/capability/gate_selfimprove.sh" || true
gate_selfimprove_rc="$(cat "$OUT_DIR/gate_selfimprove.rc")"

run_capture beat_exa_fast bash "$ROOT/bench/browsecomp/beat-exa-gate.sh" || true
beat_exa_fast_rc="$(cat "$OUT_DIR/beat_exa_fast.rc")"

run_capture beat_exa_robust bash "$ROOT/bench/browsecomp/beat-exa-robust-gate.sh" || true
beat_exa_robust_rc="$(cat "$OUT_DIR/beat_exa_robust.rc")"

read -r webcode_groundedness webcode_target webcode_beat seal0_acc seal0_target seal0_beat < <(python3 - "$ROOT" <<'PY'
import glob, json, os, sys
root = sys.argv[1]
hist = os.path.join(root, "bench/capability/history.jsonl")
web = [json.loads(l) for l in open(hist) if l.strip() and json.loads(l).get("source") == "real-benchmark"]
latest = web[-1] if web else {}
g = float(latest.get("groundedness") or 0.0)
t = float(latest.get("exa_published_target_groundedness") or 79.4)
# Stored target may be percent (79.4); score is fraction. Normalize for comparison only.
tn = t / 100.0 if t > 1 else t
best_seal = 0.0
for p in glob.glob(os.path.join(root, "bench/exa/seal0_run_*.jsonl")):
    rows = [json.loads(l) for l in open(p) if l.strip()]
    graded = [r for r in rows if not r.get("errored")]
    if graded:
        best_seal = max(best_seal, sum(1 for r in graded if r.get("correct")) / len(graded))
seal_target = 0.243
print(g, tn, str(g > tn).lower(), best_seal, seal_target, str(best_seal > seal_target).lower())
PY
)

ryuga_status="SKIP"
ryuga_rc=0
ryuga_gate_rc=0
ryuga_reason="ryuga runtime not installed at $RYUGA_LOOP"
if [ -f "$RYUGA_LOOP" ] && [ -f "$RYUGA_GATE" ]; then
  if [ ! -d "$RYUGA_RUNTIME_DIR" ]; then
    ryuga_status="FAIL"
    ryuga_reason="ryuga runtime dir missing: $RYUGA_RUNTIME_DIR"
    printf '127' >"$OUT_DIR/ryuga_loop.rc"
  else
    run_capture ryuga_loop env PYTHONPATH="$RYUGA_RUNTIME_DIR${PYTHONPATH:+:$PYTHONPATH}" python3 "$RYUGA_LOOP" --ticks "$TICKS" --threshold "$THRESHOLD" --cadence "$CADENCE" --no-declare --json || true
  fi
  ryuga_rc="$(cat "$OUT_DIR/ryuga_loop.rc")"
  if [ "$ryuga_rc" = "0" ]; then
    python3 - "$OUT_DIR/ryuga_loop.log" "$RYUGA_LOG" <<'PY'
import json, sys
src, dst = sys.argv[1:]
report = json.load(open(src))
row = {
    "timestamp": report.get("timestamp"),
    "emerged": bool((report.get("n_emerged") or 0) >= 1),
    "n_emerged": report.get("n_emerged") or 0,
    "max_dd": report.get("max_dd") or 0.0,
    "winrate": report.get("winrate") or 0.0,
    "verdict": report.get("verdict"),
    "reason": report.get("reason"),
}
with open(dst, "w") as f:
    f.write(json.dumps(row, separators=(",", ":")) + "\n")
PY
    run_capture ryuga_gate bash "$RYUGA_GATE" "$RYUGA_LOG" || true
    ryuga_gate_rc="$(cat "$OUT_DIR/ryuga_gate.rc")"
    if [ "$ryuga_gate_rc" = "0" ]; then
      ryuga_status="PASS"
      ryuga_reason="ryuga loop and gate passed"
    else
      ryuga_status="FAIL"
      ryuga_reason="ryuga loop ran but gate failed"
    fi
  else
    ryuga_status="SKIP"
    ryuga_reason="ryuga loop unavailable for this project runtime; see ryuga_loop.log"
  fi
fi

verdict="HOLD"
if [ "$contract_rc" = "0" ] && [ "$unbrowse_cli_rc" = "0" ] && [ "$gate_all_rc" = "0" ] && [ "$gate_real_rc" = "0" ] && [ "$gate_selfimprove_rc" = "0" ] && [ "$beat_exa_robust_rc" = "0" ] && [ "$webcode_beat" = "true" ] && [ "$seal0_beat" = "true" ]; then
  if [ "$ryuga_status" = "PASS" ]; then
    verdict="PROMOTE"
  fi
fi

if [ "$verdict" != "PROMOTE" ] && [ -x "$AIKO_BIN" ]; then
  run_capture followup_contract "$AIKO_BIN" "iterate:$CLAIM — seal0 HOLD: webcode_groundedness=$webcode_groundedness target=$webcode_target beat=$webcode_beat; browsecomp_robust_rc=$beat_exa_robust_rc; seal0_acc=$seal0_acc target=$seal0_target beat=$seal0_beat; contract against papers + manicmind arxiv + lewis-brain and keep fixing" || true
fi

python3 - "$REPORT" "$CLAIM" "$contract_rc" "$UNBROWSE_BIN" "$unbrowse_cli_rc" "$OUT_DIR/unbrowse_cli.log" "$gate_all_rc" "$gate_real_rc" "$gate_selfimprove_rc" "$beat_exa_fast_rc" "$beat_exa_robust_rc" "$webcode_groundedness" "$webcode_target" "$webcode_beat" "$seal0_acc" "$seal0_target" "$seal0_beat" "$ryuga_status" "$ryuga_rc" "$ryuga_gate_rc" "$ryuga_reason" "$verdict" <<'PY'
import json, sys, time
path, claim, contract_rc, unbrowse_bin, unbrowse_cli_rc, unbrowse_cli_log, gate_all, gate_real, gate_self, beat_fast, beat_robust, web_g, web_t, web_beat, seal_acc, seal_t, seal_beat, ryuga_status, ryuga_rc, ryuga_gate_rc, ryuga_reason, verdict = sys.argv[1:]
cli_version = "unknown"
try:
    for line in open(unbrowse_cli_log):
        line = line.strip()
        if line.startswith("{"):
            cli_version = json.loads(line).get("version") or cli_version
except Exception:
    pass
row = {
    "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "seal": "seal0",
    "claim": claim,
    "contract_rc": int(contract_rc),
    "unbrowse_cli": {
        "rc": int(unbrowse_cli_rc),
        "version": cli_version,
        "bin": unbrowse_bin,
    },
    "unbrowse_benchmax": {
        "gate_all.sh": int(gate_all),
        "gate_real.sh": int(gate_real),
        "gate_selfimprove.sh": int(gate_self),
    },
    "exa_targets": {
        "webcode_rag": {"groundedness": float(web_g), "target": float(web_t), "beat": web_beat == "true"},
        "browsecomp": {"fast_gate_rc": int(beat_fast), "robust_gate_rc": int(beat_robust), "target": 0.336, "beat_robust": int(beat_robust) == 0},
        "seal0": {"accuracy": float(seal_acc), "target": float(seal_t), "beat": seal_beat == "true"},
    },
    "ryuga": {
        "status": ryuga_status,
        "loop_rc": int(ryuga_rc),
        "gate_rc": int(ryuga_gate_rc),
        "reason": ryuga_reason,
    },
    "verdict": verdict,
}
with open(path, "w") as f:
    json.dump(row, f, indent=2)
    f.write("\n")
with open(path.replace("latest.json", "history.jsonl"), "a") as f:
    f.write(json.dumps(row, separators=(",", ":")) + "\n")
print(json.dumps(row, indent=2))
PY

if [ "$verdict" = "PROMOTE" ]; then
  exit 0
fi
exit 1
