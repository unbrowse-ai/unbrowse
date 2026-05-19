#!/usr/bin/env bash
# win-verify.sh - evidence collector for the Windows-Kuri harness.
#
# Substrate principle: this script COLLECTS raw evidence and prints it.
# It renders NO PASS/FAIL verdict. The agent reads the rows in-thread and
# judges convergence against references/criteria.md.
#
# Two evidence phases:
#   A. LOCAL fast inner signal: cross-compile kuri for x86_64-windows-gnu
#      from this macOS host (Zig 0.16.0, build.zig already uses
#      b.standardTargetOptions). Fails-closed on the missing windows
#      curl-impersonate static archive - the DECLARED long pole, surfaced
#      not hidden.
#   B. AUTHORITATIVE: the GitHub Actions windows-latest browse-E2E run
#      conclusion (the real gate). If the workflow file does not exist
#      yet, that absence is emitted as raw evidence, never a fake pass.
#
# Every observation is appended as a raw JSON row to ledgers/lanes.jsonl.
set -uo pipefail
cd "$(dirname "$0")/../../.."          # -> unbrowse project root
SCAFFOLD="$(cd "$(dirname "$0")/.." && pwd)"
LEDGER="$SCAFFOLD/ledgers/lanes.jsonl"
TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
KURI=submodules/kuri
WIN_ARCHIVE="$KURI/vendor/curl-impersonate/x86_64-windows/libcurl-impersonate.a"
WIN_WORKFLOW=".github/workflows/kuri-windows-e2e.yml"

row() { printf '%s\n' "$1" >> "$LEDGER"; }
emit() { # phase, key, value (value already a JSON scalar/string)
  row "{\"ts\":\"$TS\",\"plan\":\"build-kuri-for-windows\",\"phase\":\"$1\",\"$2\":$3}"
}

echo "[win-verify] === Phase A: local x86_64-windows-gnu cross-compile (fast inner signal) ==="
if ! command -v zig >/dev/null 2>&1; then
  echo "[win-verify] zig NOT on PATH - cannot run local cross-compile signal"
  emit "A-crosscompile" "zig_present" "false"
else
  ZV=$(zig version 2>/dev/null || echo unknown)
  echo "[win-verify] zig $ZV"
  emit "A-crosscompile" "zig_version" "\"$ZV\""
  if [[ -f "$WIN_ARCHIVE" ]]; then
    echo "[win-verify] windows curl-impersonate archive present: $WIN_ARCHIVE"
    emit "A-crosscompile" "win_curl_impersonate_archive_present" "true"
  else
    echo "[win-verify] LONG POLE: windows curl-impersonate static archive ABSENT ($WIN_ARCHIVE)"
    echo "[win-verify]   -> cross-compile link is expected to fail until this is vendored or built."
    emit "A-crosscompile" "win_curl_impersonate_archive_present" "false"
  fi
  BUILD_LOG="$SCAFFOLD/logs/crosscompile-x86_64-windows-gnu.log"
  mkdir -p "$SCAFFOLD/logs"
  set +e
  ( cd "$KURI" && timeout 600 zig build -Dtarget=x86_64-windows-gnu 2>&1 ) | tee "$BUILD_LOG"
  CC_RC=${PIPESTATUS[0]}
  set -e
  EXE=$(ls "$KURI"/zig-out/bin/kuri.exe 2>/dev/null || true)
  echo "[win-verify] zig build -Dtarget=x86_64-windows-gnu rc=$CC_RC kuri.exe=${EXE:-<none>}"
  emit "A-crosscompile" "zig_build_rc" "$CC_RC"
  emit "A-crosscompile" "kuri_exe_built" "$([[ -n "$EXE" ]] && echo true || echo false)"
  if [[ $CC_RC -ne 0 ]]; then
    TAIL=$(tail -8 "$BUILD_LOG" 2>/dev/null | tr '\n' '|' | sed 's/"/\\"/g' | cut -c1-600)
    emit "A-crosscompile" "error_excerpt" "\"$TAIL\""
  fi
fi

echo "[win-verify] === Phase B: GitHub Actions windows-latest browse-E2E (authoritative gate) ==="
if [[ ! -f "$WIN_WORKFLOW" ]]; then
  echo "[win-verify] windows-latest E2E workflow ABSENT: $WIN_WORKFLOW (not yet authored)"
  emit "B-windows-ci" "workflow_present" "false"
elif ! command -v gh >/dev/null 2>&1; then
  echo "[win-verify] gh CLI absent - cannot read windows-latest run conclusion"
  emit "B-windows-ci" "workflow_present" "true"
  emit "B-windows-ci" "gh_present" "false"
else
  emit "B-windows-ci" "workflow_present" "true"
  RUN_JSON=$(gh run list --workflow "$(basename "$WIN_WORKFLOW")" --limit 1 \
    --json status,conclusion,headBranch,databaseId,url 2>/dev/null || echo '[]')
  echo "[win-verify] latest windows-latest run: $RUN_JSON"
  CONCL=$(printf '%s' "$RUN_JSON" | python3 -c 'import sys,json;a=json.load(sys.stdin);print(a[0]["conclusion"] if a else "none")' 2>/dev/null || echo parse_error)
  URL=$(printf '%s' "$RUN_JSON" | python3 -c 'import sys,json;a=json.load(sys.stdin);print(a[0]["url"] if a else "")' 2>/dev/null || echo "")
  emit "B-windows-ci" "latest_run_conclusion" "\"$CONCL\""
  [[ -n "$URL" ]] && emit "B-windows-ci" "latest_run_url" "\"$URL\""
fi

echo "[win-verify] evidence appended to $LEDGER"
echo "[win-verify] NO verdict rendered - agent judges these rows against references/criteria.md"
# Exit 0 always: this is a collector, not a gate. The harness driver +
# agent decide convergence from the ledger, never this script's rc.
exit 0
