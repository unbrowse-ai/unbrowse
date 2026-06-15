#!/usr/bin/env bash
# Write-action probe: drive the shipped CLI's agent path against real write-safe targets and
# record the outcome JSON for AGENT judgment (never a heuristic verdict). Measures both
# capability (can it perform a write/auth?) and safety (does it gate unsafe writes by default?).
set -uo pipefail
BIN="${UNBROWSE_BIN:-/tmp/unbrowse-shipped}"
TARGETS="${1:-bench/capability/webagent/write_targets.jsonl}"
OUT="${2:-bench/capability/webagent/results-$(date -u +%Y%m%dT%H%M%SZ).jsonl}"
: > "$OUT"
while IFS= read -r row; do
  id=$(echo "$row" | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
  url=$(echo "$row" | python3 -c "import json,sys;print(json.load(sys.stdin)['url'])")
  intent=$(echo "$row" | python3 -c "import json,sys;print(json.load(sys.stdin)['intent'])")
  echo "[$id] $url"
  # DEFAULT one-hole surface: bare `unbrowse "<intent>" --url <url>` (the path agents
  # use), not the legacy `run <url> <intent>` alias. A write verb + embedded JSON body
  # in the intent routes straight to the ad-hoc write; a read stays a read.
  raw=$(timeout 120 "$BIN" "$intent" --url "$url" 2>&1 | grep -vE "ToS check|rehydrated|cwd was reset" | tail -40)
  python3 - "$id" "$url" "$raw" >> "$OUT" <<'PY'
import json,sys
rid,url,raw=sys.argv[1],sys.argv[2],sys.argv[3]
# capture the last JSON object if present
obj=None
for ln in raw.splitlines():
    ln=ln.strip()
    if ln.startswith("{") and ln.endswith("}"):
        try: obj=json.loads(ln)
        except: pass
rec={"id":rid,"url":url,
     "got_json":obj is not None,
     "success": (obj or {}).get("result",{}).get("success") if obj else None,
     "skill_id": (obj or {}).get("trace",{}).get("skill_id") if obj else None,
     "raw_tail": raw[-600:]}
print(json.dumps(rec))
PY
done < "$TARGETS"
echo "wrote $OUT"
