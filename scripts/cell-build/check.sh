#!/usr/bin/env bash
# check.sh — run every cell's verify.sh, aggregate into state.json,
# report the top-line. Exits non-zero if ANY cell is not green.
#
# This is the pre-prod gate for the cell-architecture build. Do not
# ship anything downstream if this reports yellow or red.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
CLIENT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"

# Walk cells/*/verify.sh, run each, capture exit + stdout.
TMP="$(mktemp)"
echo '{"generated_at":"'"$NOW"'","client_sha":"'"$CLIENT_SHA"'","cells":[' > "$TMP"
FIRST=1
GREEN=0
YELLOW=0
RED=0

for cell_dir in cells/*/; do
  [ -d "$cell_dir" ] || continue
  cell_name="$(basename "$cell_dir")"
  verify="$cell_dir/verify.sh"
  cell_json="$cell_dir/cell.json"
  if [ ! -x "$verify" ]; then
    verdict="missing_verify"
    exit_code=127
    stdout="[no verify.sh]"
  else
    stdout="$(bash "$verify" 2>&1)"
    exit_code=$?
    case "$exit_code" in
      0)  verdict="pass" ; GREEN=$((GREEN+1)) ;;
      2)  verdict="warn" ; YELLOW=$((YELLOW+1)) ;;
      *)  verdict="fail" ; RED=$((RED+1)) ;;
    esac
  fi

  # Pretty-print compact stdout for the report (first line only).
  summary="$(printf '%s' "$stdout" | head -n 1 | tr -d '\r')"

  # Append VerdictRow into cell.json's verification.history via python.
  if [ -f "$cell_json" ]; then
    python3 - "$cell_json" "$NOW" "$verdict" "$exit_code" "$summary" "$CLIENT_SHA" <<'PY'
import json, sys
path, ts, verdict, exit_code, summary, client_sha = sys.argv[1:7]
try:
    cell = json.load(open(path))
except Exception:
    cell = {}
verification = cell.get("verification") or {}
history = verification.get("history") or []
history.append({
    "ts": ts,
    "verdict": verdict,
    "exit_code": int(exit_code),
    "summary": summary[:200],
    "client_sha": client_sha,
})
# keep last 20 entries
verification["history"] = history[-20:]
verification["current_health"] = (
    "healthy" if verdict == "pass" else
    "degrading" if verdict == "warn" else
    "broken"
)
if verdict == "pass":
    verification["last_pass_at"] = ts
else:
    verification["last_fail_at"] = ts
cell["verification"] = verification
json.dump(cell, open(path, "w"), indent=2)
PY
  fi

  if [ $FIRST -eq 0 ]; then echo "," >> "$TMP"; fi
  FIRST=0
  python3 - "$cell_name" "$verdict" "$exit_code" "$summary" >> "$TMP" <<'PY'
import json, sys
name, verdict, exit_code, summary = sys.argv[1:5]
print(json.dumps({
    "cell": name,
    "verdict": verdict,
    "exit_code": int(exit_code),
    "summary": summary[:200],
}))
PY
done

echo "]," >> "$TMP"
echo "\"summary\":{\"green\":$GREEN,\"yellow\":$YELLOW,\"red\":$RED}}" >> "$TMP"
mv "$TMP" state.json

# Report
echo "[cell-build] $NOW sha=$CLIENT_SHA green=$GREEN yellow=$YELLOW red=$RED"
python3 - state.json <<'PY'
import json, sys
s = json.load(open(sys.argv[1]))
for c in s["cells"]:
    badge = {"pass": "✓", "warn": "!", "fail": "✗", "missing_verify": "?"}.get(c["verdict"], "?")
    print(f"  {badge} {c['cell']:30s} {c['verdict']:15s} {c['summary'][:80]}")
PY

# Exit non-zero if anything isn't green. This is the gate.
if [ "$RED" -gt 0 ] || [ "$YELLOW" -gt 0 ]; then
  echo "[cell-build] NOT GREEN — do not ship" >&2
  exit 1
fi
echo "[cell-build] all cells green — safe to ship"
