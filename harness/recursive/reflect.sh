#!/usr/bin/env bash
# reflect.sh — at end of a real working session, print the trace so the
# CALLING AGENT can judge it in-thread (per judge.md) and propose patches
# / new corpus rows. No autonomous classification here.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
SESSION="${1:-${UNBROWSE_TRACE_SESSION:-$(date -u +session-%Y%m%d)}}"
DIR="$HERE/runs/$SESSION"
LOG="$DIR/calls.jsonl"
[[ -s "$LOG" ]] || { echo "no calls in $LOG" >&2; exit 1; }

echo "── session $SESSION ── $(wc -l <"$LOG" | tr -d ' ') calls"
echo
python3 - "$LOG" <<'PY'
import json, sys
for i, line in enumerate(open(sys.argv[1]), 1):
    line = line.strip()
    if not line: continue
    try:
        j = json.loads(line)
    except Exception as e:
        print(f"#{i:02d} [unparseable row: {e}]")
        continue
    argv = ' '.join(j.get('argv') or [])[:140]
    sline = (j.get('stdout_excerpt') or '').split('\n', 1)[0][:120]
    eline = (j.get('stderr_excerpt') or '').split('\n', 1)[0][:120]
    print(f"#{i:02d} [{j.get('duration_ms', '?'):>5}ms exit={j.get('exit', '?')}] {j.get('verb', '?')}")
    print(f"    argv: {argv}")
    if sline: print(f"    out:  {sline}")
    if eline: print(f"    err:  {eline}")
PY
echo
echo "AGENT — read $LOG against harness/recursive/judge.md."
echo "For each FAIL/friction call:"
echo "  1. note issue_class + smallest_patch_hint"
echo "  2. propose 'intent | url | execute_data' row to append to corpus.txt"
echo "  3. apply the patch to src/ (never src/kuri/client.ts)"
echo "  4. re-do the same call via unbrowse-traced; verify it now works"
