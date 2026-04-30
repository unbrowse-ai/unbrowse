#!/usr/bin/env bash
# verify.sh — replay the agent-flagged FAIL calls from a prior session
# under a NEW trace session, so the agent can re-judge in-thread.
#
# Inputs:
#   $1 = prior session id (dir under runs/)
#   $2 = path to a fail-list file: one JSON object per line with
#        {"argv": [...]} — the agent writes this after reflect.sh.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
PRIOR="${1:-}"; FAILS="${2:-}"
[[ -z "$PRIOR" || -z "$FAILS" ]] && { echo "usage: verify.sh <session-id> <fails.jsonl>" >&2; exit 1; }
[[ -d "$HERE/runs/$PRIOR" ]] || { echo "no prior session $PRIOR" >&2; exit 1; }
[[ -s "$FAILS" ]] || { echo "no fails file $FAILS" >&2; exit 1; }

NEW="$PRIOR.after"
export UNBROWSE_TRACE_SESSION="$NEW"
echo "── replaying fails from $PRIOR into $NEW ──" >&2

python3 - "$FAILS" "$HERE/unbrowse-traced" <<'PY'
import json, subprocess, sys
fails_path, traced = sys.argv[1], sys.argv[2]
for lineno, line in enumerate(open(fails_path), 1):
    line = line.strip()
    if not line: continue
    try:
        j = json.loads(line)
    except Exception as e:
        print(f"verify: skipping malformed JSON at line {lineno}: {e}", file=sys.stderr)
        continue
    argv = j.get('argv') or []
    if not argv: continue
    print(f"replay: {' '.join(argv)[:120]}", file=sys.stderr)
    subprocess.call([traced] + argv)
PY

echo
echo "AGENT — re-read $HERE/runs/$NEW/calls.jsonl against judge.md."
echo "PASS iff every replayed FAIL flips and no other behavior degrades."
