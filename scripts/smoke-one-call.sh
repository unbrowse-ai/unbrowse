#!/usr/bin/env bash
# smoke-one-call.sh — live witness for the SKILL.md promoted "one path":
#   unbrowse "<task>" --url "<site>"
# Runs it against two real, structurally different sites (static HTML, JSON API)
# via the actual shipped CLI and asserts each call returns real data with no error.
set -euo pipefail

BIN="${UNBROWSE_BIN:-unbrowse}"

check_one() {
  local intent="$1" url="$2"
  local out
  out="$("$BIN" "$intent" --url "$url" 2>/dev/null | tail -1)"
  if [[ -z "$out" ]]; then
    echo "FAIL ($url): empty output" >&2
    return 1
  fi
  python3 - "$out" "$url" <<'PYEOF'
import json, sys
raw, url = sys.argv[1], sys.argv[2]
try:
    d = json.loads(raw)
except Exception as e:
    print(f"FAIL ({url}): output is not valid JSON — {e}", file=sys.stderr)
    sys.exit(1)
if d.get("error"):
    print(f"FAIL ({url}): {d.get('error')}", file=sys.stderr)
    sys.exit(1)
print(f"PASS ({url})")
PYEOF
}

check_one "top stories" "https://news.ycombinator.com" && \
check_one "list repos" "https://api.github.com/users/torvalds/repos"
