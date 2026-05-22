#!/usr/bin/env bash
# bench-targeted.sh — CLI/MCP parity runner.
#
# Runs a corpus of `intent|url` probes through BOTH the CLI and MCP
# (HTTP) transports, prints a side-by-side comparison table, and exits 1
# if any probe has a transport divergence (CLI passes but MCP fails, or
# vice versa).
#
# Usage:
#   bash scripts/bench-targeted.sh [--corpus-file <path>] [--timeout <s>] [--dry-run]
#
# CLI transport:
#   bun src/cli.ts resolve "<url>" --intent "<intent>" --json
#   PASS if: available_operations[] length > 0
#         OR status == "dom-fallback"
#         OR trace_success == true
#
# MCP transport (HTTP proxy to in-process app, same resolveAndExecute path):
#   POST http://localhost:6969/v1/intent/resolve {"url":..., "intent":...}
#   PASS if: available_operations[] length > 0
#         OR status == "dom-fallback"
#         OR trace_success == true
#
# Exit codes:
#   0 -- all probes agree, or MCP server not running (MCP column skipped)
#   1 -- at least one divergence between CLI and MCP

set -uo pipefail

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
CORPUS_FILE="scripts/corpus/bench-on-change.txt"
TIMEOUT=30
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --corpus-file)  CORPUS_FILE="$2"; shift 2 ;;
    --timeout)      TIMEOUT="$2";     shift 2 ;;
    --dry-run)      DRY_RUN=1;        shift   ;;
    *) echo "[bench-targeted] unknown arg: $1" >&2; exit 2 ;;
  esac
done

# Contract gate: --dry-run must print exactly this string and exit 0.
if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "bench-targeted ready"
  exit 0
fi

# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------
REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

if [[ ! -f "$CORPUS_FILE" ]]; then
  echo "[bench-targeted] FATAL: corpus not found: $CORPUS_FILE" >&2
  exit 1
fi

export PATH="$HOME/.npm-global/bin:/opt/nanobrew/prefix/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"

# Temp dir for per-probe artifacts (auto-cleaned on exit).
TMP_DIR="$(mktemp -d /tmp/bench-targeted-XXXXXXXX)"
trap 'rm -rf "$TMP_DIR"' EXIT

# Write a python helper to the temp dir for JSON operations.
cat > "$TMP_DIR/jhelper.py" << 'PY_HELPER'
import sys, json

def pass_check(raw):
    try:
        r = json.loads(raw)
    except Exception:
        return False
    if not isinstance(r, dict):
        return False
    ops = r.get("available_operations") or r.get("available_endpoints") or []
    if isinstance(ops, list) and len(ops) > 0:
        return True
    if r.get("status") == "dom-fallback":
        return True
    if r.get("trace_success") is True:
        return True
    return False

mode = sys.argv[1]
if mode == "pass_check":
    raw = sys.stdin.read()
    sys.exit(0 if pass_check(raw) else 1)
elif mode == "build_body":
    print(json.dumps({"url": sys.argv[2], "intent": sys.argv[3]}))
PY_HELPER

# Check if local server is reachable on port 6969.
MCP_AVAILABLE=0
if curl -s --max-time 2 "http://localhost:6969/health" >/dev/null 2>&1; then
  MCP_AVAILABLE=1
fi

if [[ "$MCP_AVAILABLE" -eq 0 ]]; then
  echo "[bench-targeted] WARNING: local server not running on :6969; MCP column will be skipped." >&2
fi

# ---------------------------------------------------------------------------
# PASS detection helper
# ---------------------------------------------------------------------------
pass_check() {
  printf '%s' "$1" | python3 "$TMP_DIR/jhelper.py" pass_check
}

# ---------------------------------------------------------------------------
# JSON body builder (safe for any url/intent string)
# ---------------------------------------------------------------------------
build_mcp_body() {
  python3 "$TMP_DIR/jhelper.py" build_body "$1" "$2"
}

# ---------------------------------------------------------------------------
# Run probes
# ---------------------------------------------------------------------------
PROBE_WIDTH=35
COL_WIDTH=7

# Table header
printf "%-${PROBE_WIDTH}s | %-${COL_WIDTH}s | %-${COL_WIDTH}s | %s\n" \
  "probe" "CLI" "MCP" "match"
printf -- "%s-+-%s-+-%s-+------\n" \
  "$(printf '%*s' "$PROBE_WIDTH" '' | tr ' ' '-')" \
  "$(printf '%*s' "$COL_WIDTH"   '' | tr ' ' '-')" \
  "$(printf '%*s' "$COL_WIDTH"   '' | tr ' ' '-')"

CLI_PASS=0
CLI_FAIL=0
MCP_PASS=0
MCP_FAIL=0
DIVERGENCES=0
TOTAL=0

while IFS='|' read -r intent url || [[ -n "${intent:-}" ]]; do
  # Skip blank lines and comments
  [[ -z "${intent:-}" || "${intent:-}" =~ ^[[:space:]]*# ]] && continue
  intent="${intent# }"; intent="${intent% }"
  url="${url# }"; url="${url% }"
  [[ -z "${url:-}" ]] && continue

  TOTAL=$(( TOTAL + 1 ))

  # Truncate probe label for display
  label="${intent:0:$PROBE_WIDTH}"

  # -- CLI probe --
  CLI_RESULT="FAIL"
  CLI_OUT_FILE="$TMP_DIR/cli-${TOTAL}.out"
  timeout "$TIMEOUT" bun src/cli.ts resolve "$url" --intent "$intent" --json \
    > "$CLI_OUT_FILE" 2>/dev/null || true
  CLI_JSON="$(< "$CLI_OUT_FILE" 2>/dev/null)" || CLI_JSON=""

  if pass_check "$CLI_JSON"; then
    CLI_RESULT="PASS"
    CLI_PASS=$(( CLI_PASS + 1 ))
  else
    CLI_FAIL=$(( CLI_FAIL + 1 ))
  fi

  # -- MCP probe --
  MCP_RESULT="SKIP"
  if [[ "$MCP_AVAILABLE" -eq 1 ]]; then
    MCP_RESULT="FAIL"
    MCP_BODY="$(build_mcp_body "$url" "$intent")"
    MCP_OUT_FILE="$TMP_DIR/mcp-${TOTAL}.out"
    timeout "$TIMEOUT" curl -s --max-time "$TIMEOUT" \
      -X POST "http://localhost:6969/v1/intent/resolve" \
      -H "Content-Type: application/json" \
      -d "$MCP_BODY" \
      > "$MCP_OUT_FILE" 2>/dev/null || true
    MCP_JSON="$(< "$MCP_OUT_FILE" 2>/dev/null)" || MCP_JSON=""

    if pass_check "$MCP_JSON"; then
      MCP_RESULT="PASS"
      MCP_PASS=$(( MCP_PASS + 1 ))
    else
      MCP_FAIL=$(( MCP_FAIL + 1 ))
    fi
  fi

  # -- Match / Diverge --
  MATCH="OK"
  if [[ "$MCP_RESULT" != "SKIP" ]]; then
    if [[ "$CLI_RESULT" != "$MCP_RESULT" ]]; then
      MATCH="DIVERGE"
      DIVERGENCES=$(( DIVERGENCES + 1 ))
    fi
  fi

  # -- Print row --
  if [[ "$MATCH" == "DIVERGE" ]]; then
    printf "%-${PROBE_WIDTH}s | %-${COL_WIDTH}s | %-${COL_WIDTH}s | %s\n" \
      "$label" "$CLI_RESULT" "$MCP_RESULT" "DIVERGE <- exits 1"
  else
    printf "%-${PROBE_WIDTH}s | %-${COL_WIDTH}s | %-${COL_WIDTH}s | %s\n" \
      "$label" "$CLI_RESULT" "$MCP_RESULT" "$MATCH"
  fi

done < "$CORPUS_FILE"

# ---------------------------------------------------------------------------
# Summary line
# ---------------------------------------------------------------------------
printf -- "---\n"

if [[ "$MCP_AVAILABLE" -eq 1 ]]; then
  EXIT_CODE=0
  [[ "$DIVERGENCES" -gt 0 ]] && EXIT_CODE=1
  printf "PASS: %d/%d (CLI), %d/%d (MCP). Divergences: %d. Exit %d.\n" \
    "$CLI_PASS" "$TOTAL" \
    "$MCP_PASS" "$TOTAL" \
    "$DIVERGENCES" \
    "$EXIT_CODE"
else
  printf "PASS: %d/%d (CLI). MCP skipped (server not running). Exit 0.\n" \
    "$CLI_PASS" "$TOTAL"
fi

# ---------------------------------------------------------------------------
# Exit code
# ---------------------------------------------------------------------------
if [[ "$DIVERGENCES" -gt 0 ]]; then
  exit 1
fi
exit 0
