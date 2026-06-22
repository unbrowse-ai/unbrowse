#!/usr/bin/env bash
# grind-honesty-check.sh — the falsifiable signals over the Day-3/4 work (Gen 1:14, lights for judgement).
# Three checks, each exits non-zero if violated. The load-bearing one is HONESTY: every grind capture
# dir must correspond to a REAL captured endpoint (its capture.meta.json url_template, re-encoded, must
# match the dir name) — so no fabricated route can inflate n (Matt 9:17, no broken bottle; Luke 15:4,
# chase the one bad sheep). Plus: the multi-episode fix yields n>=100, and the gate thresholds are UNTOUCHED.
set -uo pipefail
cd "$(dirname "$0")/../.."
fail(){ echo "[grind-honesty] FAIL: $*"; exit 1; }

# ── Signal 1 (load-bearing): every grind capture dir is a REAL endpoint, not fabricated ──
python3 - <<'PY' || exit 1
import os, re, json, glob, sys
root = "."
grind_dirs = glob.glob(os.path.join(root, ".bench-gate", "grind-*", "*", "capture.meta.json"))
if not grind_dirs:
    print("[grind-honesty] (no grind captures yet — signal vacuously OK while grind warms up)"); sys.exit(0)
bad = 0
for meta in grind_dirs:
    d = os.path.basename(os.path.dirname(meta))
    m = re.match(r"^\d+_([a-z-]+)_(https?_.+)$", d)            # jespa-readable dir name
    if not m:
        print(f"[grind-honesty] dir not jespa-readable: {d}"); bad += 1; continue
    try:
        ep = json.load(open(meta))
    except Exception:
        print(f"[grind-honesty] unreadable meta: {meta}"); bad += 1; continue
    u = (ep.get("url_template") or "")
    if not u.startswith("http"):
        print(f"[grind-honesty] meta has no real url_template: {d}"); bad += 1; continue
    enc = re.sub(r"[^a-z0-9]", "_", u.lower())[:120]            # must match how the grind encoded it
    if enc not in d:                                            # the dir name IS the real endpoint, re-derived
        print(f"[grind-honesty] dir name does not match its real endpoint (fabricated?): {d}  vs  {enc}"); bad += 1
if bad:
    print(f"[grind-honesty] {bad} fabricated/mismatched dirs — leaven"); sys.exit(1)
print(f"[grind-honesty] OK — all {len(grind_dirs)} grind routes trace to a real captured endpoint")
PY

# ── Signal 2: the multi-episode fix yields n_eval >= 100 (no false-negative from underpowered eval) ──
R=bench/jespa/data/jespa_route_result.json
if [ -f "$R" ]; then
  python3 - "$R" <<'PY' || exit 1
import json,sys
d=json.load(open(sys.argv[1]))
for s in d.get("seeds",[]):
    if s.get("n_eval",0) < 100:
        print(f"[grind-honesty] FAIL: seed {s.get('seed')} n_eval={s.get('n_eval')} < 100 (multi-episode fix regressed)"); sys.exit(1)
print("[grind-honesty] OK — n_eval >= 100 on all seeds (underpowered false-negative fixed)")
PY
fi

# ── Signal 3 (firmament): the gate thresholds are UNTOUCHED (never loosened to pass) ──
grep -qE 'MARGIN=.*0\.05' bench/jespa/jespa-route-gate.sh || fail "gate MARGIN no longer 0.05 — threshold tampered"
grep -qE 'MIN_EVAL=.*100' bench/jespa/jespa-route-gate.sh || fail "gate MIN_EVAL no longer 100 — threshold tampered"
echo "[grind-honesty] OK — gate thresholds untouched (MARGIN=0.05, MIN_EVAL=100)"
echo "[grind-honesty] PASS — all signals hold"
