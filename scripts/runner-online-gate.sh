#!/usr/bin/env bash
# runner-online-gate.sh — witness for "self-host the runner": exits 0 EXACTLY when the repo has
# at least one self-hosted GitHub Actions runner with status "online".
set -uo pipefail
REPO="${1:-unbrowse-ai/unbrowse-dev}"
out="$(gh api "repos/$REPO/actions/runners" 2>/dev/null)" || { echo "[runner-gate] FAIL — gh api error"; exit 1; }
echo "$out" | python3 -c '
import sys, json
d = json.load(sys.stdin); rs = d.get("runners", [])
online = [r for r in rs if r.get("status")=="online"]
for r in rs: print("  runner: %s status=%s labels=%s" % (r.get("name"), r.get("status"), [l["name"] for l in r.get("labels",[])]))
print("[runner-gate] %s — %d online of %d" % ("PASS" if online else "FAIL", len(online), len(rs)))
sys.exit(0 if online else 1)
'
