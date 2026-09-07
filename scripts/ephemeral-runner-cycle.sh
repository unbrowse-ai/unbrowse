#!/usr/bin/env bash
# ephemeral-runner-cycle.sh — witness for the ephemeral RunPod runner (the manna pattern).
# Exits 0 EXACTLY when a pod spins, an --ephemeral runner comes ONLINE for the repo, and after
# teardown the pod is GONE (gathered → online → released; nothing hoarded).
set -uo pipefail
REPO="${REPO:-unbrowse-ai/unbrowse-dev}"
HERE="$(cd "$(dirname "$0")" && pwd)"

online_eph() { gh api "repos/$REPO/actions/runners" 2>/dev/null | python3 -c '
import sys,json
d=json.load(sys.stdin)
print(len([r for r in d.get("runners",[]) if r.get("status")=="online" and r.get("name","").startswith("eph-")]))'; }

echo "[cycle] 1/4 — up: spin pod + register ephemeral runner"
PID="$(bash "$HERE/release-on-runpod.sh" up)" || { echo "[cycle] FAIL — up errored (pid=$PID)"; [ -n "$PID" ] && bash "$HERE/release-on-runpod.sh" down "$PID"; exit 1; }
[ -n "$PID" ] || { echo "[cycle] FAIL — no pod id"; exit 1; }
echo "[cycle]   pod=$PID"

echo "[cycle] 2/4 — assert an ephemeral runner is ONLINE for the repo"
ok=0
for _ in $(seq 1 12); do [ "$(online_eph)" -ge 1 ] && { ok=1; break; }; sleep 12; done
if [ "$ok" != 1 ]; then echo "[cycle] FAIL — ephemeral runner never came online"; bash "$HERE/release-on-runpod.sh" down "$PID"; exit 1; fi
echo "[cycle]   ephemeral runner online ✓"

echo "[cycle] 3/4 — down: tear the pod down (scale to zero)"
bash "$HERE/release-on-runpod.sh" down "$PID"

echo "[cycle] 4/4 — assert the pod is GONE (nothing hoarded)"
sleep 5
if runpodctl pod list 2>/dev/null | grep -q "$PID"; then echo "[cycle] FAIL — pod $PID still present after teardown"; exit 1; fi
echo "[cycle] PASS — ephemeral cycle clean: gathered → online → released (pod $PID gone)"
exit 0
