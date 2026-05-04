#!/usr/bin/env bash
# Shared helpers for autonomous-discovery probes.
# Per CLAUDE.md "harness collects, agent judges": no assertions in here.

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
export REPO

if [ -z "${RUN_ID:-}" ]; then
  RUN_ID="$(date -u +%Y-%m-%dT%H-%M-%SZ)-$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n')"
fi
export RUN_ID

OUT_DIR="${REPO}/.harness-out/autonomous-discovery/${RUN_ID}"
mkdir -p "$OUT_DIR"
export OUT_DIR

UNBROWSE_API_BASE="${UNBROWSE_API_BASE:-http://localhost:6969}"
export UNBROWSE_API_BASE

# Use bun src/cli.ts for source-of-truth runs (per CLAUDE.md eval guidance).
UNBROWSE_BIN="${UNBROWSE_BIN:-bun ${REPO}/src/cli.ts}"
export UNBROWSE_BIN

now_ms() { python3 -c 'import time; print(int(time.time()*1000))'; }
export -f now_ms

# Server start. Kills stale unbrowse, boots source with UNBROWSE_DEV=1.
# Per CLAUDE.md "Always kill the running unbrowse server" — global installs
# serve stale code.
ensure_server() {
  if curl -fsS -m 2 "${UNBROWSE_API_BASE}/v1/admin/sessions" >/dev/null 2>&1; then
    echo "[harness] reusing live source server with admin endpoints" >&2
    return 0
  fi
  echo "[harness] killing stale unbrowse/kuri processes" >&2
  pkill -9 -f 'unbrowse.*serve\|src/cli.ts serve\|src/server.ts\|kuri\b' 2>/dev/null || true
  sleep 2
  echo "[harness] booting source server with UNBROWSE_DEV=1" >&2
  ( cd "$REPO" && \
    UNBROWSE_DEV=1 \
    UNBROWSE_NON_INTERACTIVE=1 \
    UNBROWSE_SKIP_TOS_CHECK=1 \
    HEADLESS=true \
    nohup bun src/server.ts 127.0.0.1 6969 \
      >"${OUT_DIR}/server.log" 2>&1 & )
  for i in $(seq 1 60); do
    if curl -fsS -m 2 "${UNBROWSE_API_BASE}/v1/admin/sessions" >/dev/null 2>&1; then
      echo "[harness] source server up after ${i}s" >&2
      return 0
    fi
    sleep 1
  done
  echo "[harness] source server failed to start" >&2
  tail -40 "${OUT_DIR}/server.log" >&2 || true
  return 1
}
export -f ensure_server

# Snapshot session state for an active browse session.
# Hits /v1/admin/sessions/:id/buffer (added in this PR — guard for absence).
session_buffer_snapshot() {
  local session_id="$1"
  local out_file="$2"
  if curl -fsS -m 5 \
      "${UNBROWSE_API_BASE}/v1/admin/sessions/${session_id}/buffer" \
      -o "$out_file" 2>/dev/null; then
    return 0
  fi
  echo '{"error":"buffer_endpoint_unavailable","note":"endpoint missing on this build (BEFORE state)"}' >"$out_file"
  return 0
}
export -f session_buffer_snapshot

# Read the most recent active session id for a domain via /v1/admin/sessions.
# Falls back to empty string if endpoint missing.
latest_session_for_domain() {
  local domain="$1"
  curl -fsS -m 5 "${UNBROWSE_API_BASE}/v1/admin/sessions" 2>/dev/null \
    | python3 -c '
import sys,json
try:
  data=json.load(sys.stdin)
except Exception:
  print(""); sys.exit(0)
sessions=data.get("sessions") or data.get("data") or []
domain=sys.argv[1].lower()
for s in sessions:
  d=(s.get("domain") or s.get("url") or "").lower()
  if domain in d:
    print(s.get("session_id") or s.get("id") or s.get("tab_id") or ""); sys.exit(0)
print("")
' "$domain" 2>/dev/null
}
export -f latest_session_for_domain

# Hit the marketplace skills index for a domain (returns null if not present).
marketplace_skill_for_domain() {
  local domain="$1"
  local out_file="$2"
  curl -fsS -m 10 \
    -H "Content-Type: application/json" \
    "${UNBROWSE_API_BASE}/v1/skills?domain=${domain}" \
    -o "$out_file" 2>/dev/null || echo '{"data":[]}' >"$out_file"
}
export -f marketplace_skill_for_domain

# Pull the last balanced JSON object from a log file (resolve output).
# Same pattern as agent-experience.sh.
extract_last_json() {
  local log_path="$1"
  python3 - "$log_path" <<'PY'
import sys, json, re
log = open(sys.argv[1], 'r', errors='replace').read()
candidate_starts = [m.start() for m in re.finditer(r'^\{', log, re.MULTILINE)]
if not candidate_starts:
    candidate_starts = [m.start() for m in re.finditer(r'\{', log)]
parsed = None
for start in candidate_starts:
    chunk = log[start:].rstrip()
    while chunk:
        try:
            parsed = json.loads(chunk, strict=False)
            if isinstance(parsed, dict) and any(
                k in parsed for k in ('result','available_operations','available_endpoints','trace','source')
            ):
                break
            parsed = None
        except Exception:
            pass
        last_brace = chunk.rfind('}')
        if last_brace <= 0:
            break
        chunk = chunk[:last_brace+1]
    if parsed:
        break
print(json.dumps(parsed if parsed else {}, default=str))
PY
}
export -f extract_last_json

write_manifest_header() {
  local out="$OUT_DIR/manifest.json"
  python3 - "$out" "$RUN_ID" "$REPO" <<'PY'
import sys, json, subprocess, os
out, run_id, repo = sys.argv[1:4]
def run(cmd):
    try:
        return subprocess.check_output(cmd, cwd=repo, text=True, stderr=subprocess.DEVNULL).strip()
    except Exception:
        return ""
manifest = {
    "run_id": run_id,
    "git_sha": run(["git","rev-parse","HEAD"]),
    "git_branch": run(["git","rev-parse","--abbrev-ref","HEAD"]),
    "git_dirty": bool(run(["git","status","--porcelain"])),
    "version": run(["bash","-c","cat package.json | python3 -c 'import sys,json;print(json.load(sys.stdin)[\"version\"])'"]),
    "started_at": run(["date","-u","+%Y-%m-%dT%H:%M:%SZ"]),
    "probes": [],
}
open(out,"w").write(json.dumps(manifest, indent=2))
PY
}
export -f write_manifest_header

append_to_manifest() {
  local probe_name="$1"
  local probe_artifact="$2"
  python3 - "$OUT_DIR/manifest.json" "$probe_name" "$probe_artifact" <<'PY'
import sys, json, os
manifest_path, name, artifact_path = sys.argv[1:4]
m = json.load(open(manifest_path))
m["probes"].append({
    "name": name,
    "artifact": os.path.relpath(artifact_path, os.path.dirname(manifest_path)),
})
open(manifest_path,"w").write(json.dumps(m, indent=2))
PY
}
export -f append_to_manifest
