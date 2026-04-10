#!/usr/bin/env bash
# job-state.sh — shared library for long-running job state.
#
# Long-running scripts (benchmarks, releases, large installs) should source
# this file and call job_register / job_update / job_done so Lewis can run
# `bash scripts/peek.sh` and see live progress without digging through output
# files or SSHing into sandboxes.
#
# State is a single JSON file per job at ~/.unbrowse/jobs/<id>.json with:
#   id, command, pid, started_at, last_update, stage, progress, peek_cmd, done
#
# peek.sh reads every file, prints the summary table, and if given a job id
# runs the stored peek_cmd (which can curl a turbobox sandbox, tail a log,
# or probe any other live source of truth).
#
# Usage inside a script:
#   source "$(dirname "$0")/job-state.sh"
#   JOB_ID=$(job_register "benchmark-turbobox-parallel" "--versions 3.7.1")
#   job_update "$JOB_ID" "spawning sandbox" 0 "curl -s https://sandbox.trilok.ai/v1/boxes"
#   ...
#   job_update "$JOB_ID" "resolving reddit.com" 3 ""
#   ...
#   job_done "$JOB_ID" "completed" "pass=5 fail=0 block=1"

JOBS_DIR="${UNBROWSE_JOBS_DIR:-$HOME/.unbrowse/jobs}"
mkdir -p "$JOBS_DIR"

# job_register <command_name> <args_summary>
# Prints the generated job id on stdout.
job_register() {
  local name="$1" args="$2"
  local id
  id="$(date +%s)-$$-$(printf '%04x' $((RANDOM * RANDOM % 65536)))"
  local file="$JOBS_DIR/$id.json"
  python3 - "$file" "$id" "$name" "$args" "$$" <<'PYEOF'
import json, sys, time
file, id_, name, args, pid = sys.argv[1:6]
json.dump({
    "id": id_,
    "command": name,
    "args": args,
    "pid": int(pid),
    "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "last_update": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "stage": "started",
    "progress": 0,
    "peek_cmd": "",
    "done": False,
    "result": "",
}, open(file, "w"))
PYEOF
  printf '%s' "$id"
}

# job_update <id> <stage> <progress_int> [peek_cmd]
job_update() {
  local id="$1" stage="$2" progress="$3" peek_cmd="${4:-}"
  local file="$JOBS_DIR/$id.json"
  [ -f "$file" ] || return 0
  python3 - "$file" "$stage" "$progress" "$peek_cmd" <<'PYEOF'
import json, sys, time
file, stage, progress, peek_cmd = sys.argv[1:5]
try:
    d = json.load(open(file))
except Exception:
    sys.exit(0)
d["stage"] = stage
d["progress"] = int(progress or 0)
d["last_update"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
if peek_cmd:
    d["peek_cmd"] = peek_cmd
json.dump(d, open(file, "w"))
PYEOF
}

# job_done <id> <end_state> <result_summary>
job_done() {
  local id="$1" end_state="$2" result="$3"
  local file="$JOBS_DIR/$id.json"
  [ -f "$file" ] || return 0
  python3 - "$file" "$end_state" "$result" <<'PYEOF'
import json, sys, time
file, end_state, result = sys.argv[1:4]
try:
    d = json.load(open(file))
except Exception:
    sys.exit(0)
d["done"] = True
d["stage"] = end_state
d["result"] = result
d["finished_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
d["last_update"] = d["finished_at"]
json.dump(d, open(file, "w"))
PYEOF
}

# job_clean — remove finished jobs older than 24h so the peek list stays useful.
job_clean() {
  python3 - "$JOBS_DIR" <<'PYEOF'
import json, os, sys, time
d = sys.argv[1]
cutoff = time.time() - 86400
for name in os.listdir(d):
    if not name.endswith(".json"): continue
    p = os.path.join(d, name)
    try:
        j = json.load(open(p))
        if j.get("done") and os.path.getmtime(p) < cutoff:
            os.remove(p)
    except Exception:
        pass
PYEOF
}
