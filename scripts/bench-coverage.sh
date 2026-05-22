#!/usr/bin/env bash
# bench-coverage.sh - measures Unbrowse coverage index against a corpus.
#
# Runs all probes in parallel via `bun src/cli.ts run`.
# Coverage = PASS / (PASS + PRODUCT_FAIL + BROWSER_BLOCK)
# AUTH_GATED excluded (credential gap, not product gap).
#
# Usage:
#   bash scripts/bench-coverage.sh [--corpus-file <path>] [--timeout <s>] [--dry-run] [--staging]
#   bash scripts/bench-coverage.sh --out-dir <path>
#
# --staging  sets UNBROWSE_BACKEND_URL to the staging worker so bench tests hit
#            staging, not production (default: use source default = beta-api.unbrowse.ai)
#
# Per-probe artifacts are saved to <out-dir>/probes/<idx>.json and persist after
# the run so failing probes can be diagnosed without re-running.

set -uo pipefail

CORPUS_FILE="scripts/corpus/bench-on-change.txt"
TIMEOUT=30
DRY_RUN=0
OUT_DIR=".bench-local"
STAGING=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --corpus-file)  CORPUS_FILE="$2"; shift 2 ;;
    --timeout)      TIMEOUT="$2";     shift 2 ;;
    --out-dir)      OUT_DIR="$2";     shift 2 ;;
    --staging)      STAGING=1;        shift   ;;
    --dry-run)      DRY_RUN=1;        shift   ;;
    *) echo "[bench-coverage] unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "bench-coverage ready"
  exit 0
fi

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"
mkdir -p "$OUT_DIR" "$OUT_DIR/probes"

export PATH="$HOME/.npm-global/bin:/opt/nanobrew/prefix/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"

# Kill any stale unbrowse servers before running so parallel bun processes don't
# race a wedged daemon. Narrowed set per CLAUDE.md — does NOT kill bench scaffolds
# whose cmdline merely contains the path string "unbrowse".
pkill -9 -f 'unbrowse (serve|mcp)( |$)' 2>/dev/null || true
pkill -9 -f 'bun .*src/mcp\.ts' 2>/dev/null || true
pkill -9 -f 'node .*unbrowse/dist/server' 2>/dev/null || true
pkill -9 -f 'unbrowse __drain-queue' 2>/dev/null || true
pkill -9 -f '/\.unbrowse/bin/kuri( |$)' 2>/dev/null || true
pkill -9 -f '/\.kuri/bin/kuri( |$)' 2>/dev/null || true
sleep 1

# Route bench traffic to staging so we don't pollute production metrics.
# Override is respected by all UNBROWSE_BACKEND_URL / UNBROWSE_API_URL consumers in src/.
if [[ "$STAGING" -eq 1 ]]; then
  export UNBROWSE_BACKEND_URL="https://unbrowse-backend-staging.lewis-6d8.workers.dev"
  echo "[bench-coverage] staging mode: UNBROWSE_BACKEND_URL=$UNBROWSE_BACKEND_URL" >&2
fi

TMP_DIR="$(mktemp -d /tmp/bench-coverage-XXXXXXXX)"
trap 'rm -rf "$TMP_DIR"' EXIT


# Inline classifier — emits BUCKET|REASON|WINNER
# WINNER = decision_trace.budget_race.winner for code-level routing visibility
cat > "$TMP_DIR/classify.py" << 'PY_CLASSIFY'
import sys, json

def extract_winner(r):
    dt = r.get("decision_trace") or {}
    br = dt.get("budget_race") or {}
    return br.get("winner") or ""

def classify(raw):
    raw = raw.strip()
    # Find last JSON object line (skip progress messages like "[unbrowse] Still working...")
    json_lines = [l for l in raw.split("\n") if l.strip().startswith("{")]
    if not json_lines:
        return "PRODUCT_FAIL", "timeout_or_empty", ""
    try:
        r = json.loads(json_lines[-1])
    except Exception:
        return "PRODUCT_FAIL", "json_parse_error", ""

    winner = extract_winner(r)
    err = (r.get("error") or "").lower()
    ec = (r.get("error_code") or "").lower()
    signals = r.get("browser_block_signals") or []
    source = r.get("source") or ""

    if ec == "auth_required" or r.get("auth_recommended"):
        return "AUTH_GATED", "auth_required", winner
    if "auth_required" in err or "authentication" in err:
        return "AUTH_GATED", "auth_error_msg", winner

    vendor_signals = [s for s in signals if "vendor:" in str(s) or "challenge_title" in str(s)]
    if vendor_signals:
        return "BROWSER_BLOCK", ",".join(str(s) for s in vendor_signals[:2]), winner
    diag = r.get("capture_diagnostic") or ""
    if diag in ("no_endpoints_extracted", "all_endpoints_filtered_by_noise_rules"):
        return "BROWSER_BLOCK", diag, winner

    result = r.get("result")
    if result and isinstance(result, dict):
        rejected = result.get("rejected", False)
        has_content = bool(result.get("text_excerpt") or result.get("content") or
                          result.get("results") or result.get("data") or
                          result.get("markdown") or result.get("html_bytes", 0) > 0)
        if not rejected and has_content:
            return "PASS", f"run:source={source}", winner

    trace = r.get("trace") or {}
    if trace.get("success") is True:
        return "PASS", f"trace_success:source={source}", winner

    ops = r.get("available_operations") or r.get("available_endpoints") or []
    if isinstance(ops, list) and len(ops) > 0:
        return "PASS", f"ops={len(ops)},source={source}", winner
    if r.get("status") == "dom-fallback":
        return "PASS", "dom-fallback", winner
    if r.get("trace_success") is True:
        return "PASS", f"trace_success_top,source={source}", winner

    return "PRODUCT_FAIL", err[:80] or "no_data_no_block", winner

raw = sys.stdin.read()
bucket, reason, winner = classify(raw)
print(f"{bucket}|{reason}|{winner}")
PY_CLASSIFY

# Phase 1: read corpus, spawn all probes in parallel
INTENTS_FILE="$TMP_DIR/intents.txt"
URLS_FILE="$TMP_DIR/urls.txt"
touch "$INTENTS_FILE" "$URLS_FILE"

IDX=0
while IFS='|' read -r intent url || [[ -n "${intent:-}" ]]; do
  [[ -z "${intent:-}" || "${intent:-}" =~ ^[[:space:]]*# ]] && continue
  intent="${intent# }"; intent="${intent% }"
  url="${url# }"; url="${url% }"
  [[ -z "${url:-}" ]] && continue

  echo "$intent" >> "$INTENTS_FILE"
  echo "$url"    >> "$URLS_FILE"

  PROBE_OUT="$OUT_DIR/probes/${IDX}.json"

  (
    timeout "$TIMEOUT" bun src/cli.ts run "$url" "$intent" \
      > "$PROBE_OUT" 2>/dev/null
    echo $? > "$TMP_DIR/raw-${IDX}.exit"
  ) &

  IDX=$(( IDX + 1 ))
done < "$CORPUS_FILE"

TOTAL=$IDX
echo "[bench-coverage] $TOTAL probes running in parallel (timeout=${TIMEOUT}s each)..." >&2
wait

# Phase 2: classify and tally
PASS_COUNT=0
AUTH_COUNT=0
BLOCK_COUNT=0
FAIL_COUNT=0

RESULTS_FILE="$OUT_DIR/coverage-results.jsonl"
: > "$RESULTS_FILE"

INTENTS=()
while IFS= read -r _line; do INTENTS+=("$_line"); done < "$INTENTS_FILE"

URLS=()
while IFS= read -r _line; do URLS+=("$_line"); done < "$URLS_FILE"

for (( i=0; i<TOTAL; i++ )); do
  PROBE_OUT="$OUT_DIR/probes/${i}.json"
  raw="$(< "$PROBE_OUT" 2>/dev/null)" || raw=""
  classification="$(printf '%s' "$raw" | python3 "$TMP_DIR/classify.py" 2>/dev/null)" || classification="PRODUCT_FAIL|parse_error|"
  bucket="${classification%%|*}"
  rest="${classification#*|}"
  reason="${rest%%|*}"
  winner="${rest#*|}"

  case "$bucket" in
    PASS)          PASS_COUNT=$(( PASS_COUNT + 1 )) ;;
    AUTH_GATED)    AUTH_COUNT=$(( AUTH_COUNT + 1 )) ;;
    BROWSER_BLOCK) BLOCK_COUNT=$(( BLOCK_COUNT + 1 )) ;;
    *)             FAIL_COUNT=$(( FAIL_COUNT + 1 )) ;;
  esac

  printf '{"idx":%d,"intent":"%s","url":"%s","bucket":"%s","reason":"%s","winner":"%s"}\n' \
    "$i" "${INTENTS[$i]:-}" "${URLS[$i]:-}" "$bucket" "$reason" "$winner" >> "$RESULTS_FILE"
done

# Phase 3: compute coverage index
COUNTABLE=$(( PASS_COUNT + FAIL_COUNT + BLOCK_COUNT ))
if [[ "$COUNTABLE" -gt 0 ]]; then
  COVERAGE=$(python3 -c "print(f'{100*$PASS_COUNT/$COUNTABLE:.1f}')")
else
  COVERAGE="0.0"
fi

echo ""
echo "=== Unbrowse Coverage Index ==="
printf "PASS:          %d / %d\n" "$PASS_COUNT" "$TOTAL"
printf "BROWSER_BLOCK: %d / %d  (antibot gap)\n" "$BLOCK_COUNT" "$TOTAL"
printf "AUTH_GATED:    %d / %d  (excluded)\n" "$AUTH_COUNT" "$TOTAL"
printf "PRODUCT_FAIL:  %d / %d\n" "$FAIL_COUNT" "$TOTAL"
echo "---"
printf "Coverage index: %s%%  (PASS / (PASS+PRODUCT_FAIL+BROWSER_BLOCK))\n" "$COVERAGE"
printf "Corpus: %s (%d probes)\n" "$CORPUS_FILE" "$TOTAL"
echo ""

# Save index
{
  echo "coverage_index=${COVERAGE}%"
  echo "pass=${PASS_COUNT}"
  echo "product_fail=${FAIL_COUNT}"
  echo "browser_block=${BLOCK_COUNT}"
  echo "auth_gated=${AUTH_COUNT}"
  echo "total=${TOTAL}"
  echo "countable=${COUNTABLE}"
  echo "corpus=${CORPUS_FILE}"
  echo "ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "$OUT_DIR/coverage-index.txt"

echo "[bench-coverage] results:  $RESULTS_FILE" >&2
echo "[bench-coverage] index:    $OUT_DIR/coverage-index.txt" >&2
echo "[bench-coverage] probes:   $OUT_DIR/probes/<idx>.json (persistent)" >&2

# Per-probe breakdown with code-level routing (winner field)
echo "--- per-probe breakdown ---"
python3 -c "
import json
rows = [json.loads(l) for l in open('$RESULTS_FILE')]
for r in rows:
    bucket = r['bucket']
    reason = (r['reason'] or '')[:30]
    winner = (r.get('winner') or '-')[:12]
    intent = (r['intent'] or '')[:25]
    url    = (r['url']    or '')[:42]
    print(f'  {bucket:<14} {winner:<13} {intent:<26} {url:<43} {reason}')
"
