#!/usr/bin/env bash
# peek.sh — list and inspect long-running jobs registered via job-state.sh.
#
# Usage:
#   bash scripts/peek.sh                  # list all active jobs
#   bash scripts/peek.sh --all            # include finished jobs
#   bash scripts/peek.sh <job_id>         # run stored peek_cmd for that job
#   bash scripts/peek.sh --follow <id>    # re-run peek_cmd every 3s until job done
#   bash scripts/peek.sh --clean          # prune finished jobs >24h old
#
# The peek_cmd stored by the job is the source of truth for "what is this
# thing actually doing right now" — it might curl a turbobox box, tail a log,
# or probe a local process. This primitive only knows how to invoke it.

JOBS_DIR="${UNBROWSE_JOBS_DIR:-$HOME/.unbrowse/jobs}"
mkdir -p "$JOBS_DIR"

SHOW_DONE=false
FOLLOW=false
TARGET=""
CLEAN=false
for arg in "$@"; do
  case "$arg" in
    --all) SHOW_DONE=true ;;
    --follow) FOLLOW=true ;;
    --clean) CLEAN=true ;;
    --*) ;;
    *) TARGET="$arg" ;;
  esac
done

if [ "$CLEAN" = "true" ]; then
  source "$(dirname "$0")/job-state.sh"
  job_clean
  echo "[peek] cleaned old finished jobs"
  exit 0
fi

list_jobs() {
  python3 - "$JOBS_DIR" "$SHOW_DONE" <<'PYEOF'
import json, os, sys, time
d, show_done_s = sys.argv[1:3]
show_done = show_done_s == "true"
rows = []
for name in sorted(os.listdir(d)):
    if not name.endswith(".json"): continue
    try:
        j = json.load(open(os.path.join(d, name)))
    except Exception:
        continue
    if j.get("done") and not show_done:
        continue
    rows.append(j)
if not rows:
    print("[peek] no active jobs" + (" (use --all for finished)" if not show_done else ""))
    sys.exit(0)
print(f"{'id':34} {'command':28} {'stage':24} {'progress':8} {'age':>8}")
print("-" * 108)
now = time.time()
for j in rows:
    try:
        # started_at is stored as UTC ("...Z"); use calendar.timegm for a tz-safe age
        import calendar
        ts = calendar.timegm(time.strptime(j.get("started_at",""), "%Y-%m-%dT%H:%M:%SZ"))
        age = int(now - ts)
    except Exception:
        age = 0
    marker = "✓" if j.get("done") else "…"
    print(f"{marker} {j.get('id','?'):32} {j.get('command','?')[:28]:28} {j.get('stage','?')[:24]:24} {str(j.get('progress',0)):8} {age:>6}s")
    if j.get("done") and j.get("result"):
        print(f"  result: {j['result']}")
PYEOF
}

peek_one() {
  local id="$1"
  local file="$JOBS_DIR/$id.json"
  if [ ! -f "$file" ]; then
    echo "[peek] no job with id '$id' in $JOBS_DIR"
    return 1
  fi
  python3 - "$file" <<'PYEOF'
import json, sys
j = json.load(open(sys.argv[1]))
print(f"id        : {j.get('id')}")
print(f"command   : {j.get('command')} {j.get('args','')}")
print(f"pid       : {j.get('pid')}")
print(f"started   : {j.get('started_at')}")
print(f"updated   : {j.get('last_update')}")
print(f"stage     : {j.get('stage')}")
print(f"progress  : {j.get('progress')}")
print(f"done      : {j.get('done')}")
if j.get("result"):
    print(f"result    : {j['result']}")
print(f"peek_cmd  : {j.get('peek_cmd','(none)')}")
print("---")
PYEOF
  local peek_cmd
  peek_cmd=$(python3 -c "import json; print(json.load(open('$file')).get('peek_cmd',''))")
  if [ -n "$peek_cmd" ]; then
    echo "[peek] running peek_cmd..."
    eval "$peek_cmd"
  else
    echo "[peek] no peek_cmd registered — nothing live to show"
  fi
}

if [ -z "$TARGET" ]; then
  list_jobs
  exit 0
fi

if [ "$FOLLOW" = "true" ]; then
  while true; do
    clear 2>/dev/null || printf '\033[H\033[J'
    peek_one "$TARGET"
    done_flag=$(python3 -c "import json; print(json.load(open('$JOBS_DIR/$TARGET.json')).get('done',False))" 2>/dev/null)
    if [ "$done_flag" = "True" ]; then
      echo "[peek] job done"
      break
    fi
    sleep 3
  done
else
  peek_one "$TARGET"
fi
