#!/usr/bin/env bash
# bench-hard.sh — anti-cheat benchmark runner for hard-target corpus.
#
# Wipes ~/.unbrowse/skills + ~/.unbrowse/skill-cache between EVERY URL so
# the local marketplace can't accumulate state across rows (every URL is
# evaluated cold). Profiles + vault stay (auth/cookies are not cheating —
# they're real-world signal).
#
# Appends to .bench-history/runs.jsonl: one row per URL per run with
# verdict + evidence, plus per-run summary in .bench-history/<run_id>/.
#
# Usage:
#   bash scripts/bench-hard.sh                          # full hard-target corpus
#   bash scripts/bench-hard.sh --corpus F               # override corpus
#   bash scripts/bench-hard.sh --only-url URL           # one URL only (post-repair re-run)
#   bash scripts/bench-hard.sh --use-source             # bun src/cli.ts (no global)
#   bash scripts/bench-hard.sh --timeout 90
set -uo pipefail

export PATH="$HOME/.npm-global/bin:/opt/nanobrew/prefix/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"

CORPUS="scripts/corpus/hard-target-bench.txt"
TIMEOUT=90
CLI_CMD="unbrowse"
ONLY_URL=""
NOTE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --corpus) CORPUS="$2"; shift 2 ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    --use-source) CLI_CMD="bun src/cli.ts"; shift ;;
    --only-url) ONLY_URL="$2"; shift 2 ;;
    --note) NOTE="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [ ! -f "$CORPUS" ]; then
  echo "[bench-hard] corpus not found: $CORPUS" >&2
  exit 1
fi

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
RUN_DIR=".bench-history/$RUN_ID"
mkdir -p "$RUN_DIR"
HISTORY_JSONL=".bench-history/runs.jsonl"
touch "$HISTORY_JSONL"

# Reuse bench-local's per-URL extractor (extract.py) — it's already the
# source of truth for verdict classification. Stage it once per run.
mkdir -p .bench-local
bash -c "OUT_DIR=.bench-local; cat > \$OUT_DIR/extract.py" <<'PY' >/dev/null
PY
# Just copy from bench-local script's embedded extractor by running a tiny
# preflight: run bench-local with a 1-line empty corpus to materialize the
# python file, then reuse it.
EXTRACT_PY=".bench-local/extract.py"
if [ ! -s "$EXTRACT_PY" ]; then
  TMP_CORPUS=$(mktemp)
  echo "" > "$TMP_CORPUS"
  bash scripts/bench-local.sh --corpus-file "$TMP_CORPUS" --timeout 5 >/dev/null 2>&1 || true
  rm -f "$TMP_CORPUS"
fi
if [ ! -s "$EXTRACT_PY" ]; then
  echo "[bench-hard] could not materialize $EXTRACT_PY; bench-local stage failed" >&2
  exit 1
fi

wipe_marketplace() {
  pkill -9 -f 'unbrowse|kuri' 2>/dev/null || true
  sleep 0.3
  # Wipe captured/published skills + per-skill response cache. NEVER touch
  # profiles/vault/logs/bin/config — those are real auth + the runtime.
  rm -rf "$HOME/.unbrowse/skills"/* 2>/dev/null || true
  rm -rf "$HOME/.unbrowse/skill-cache"/* 2>/dev/null || true
  rm -rf "$HOME/.unbrowse/traces"/* 2>/dev/null || true
}

i=0
results_file="$RUN_DIR/results.jsonl"
> "$results_file"
echo "[bench-hard] run=$RUN_ID corpus=$CORPUS timeout=${TIMEOUT}s only_url=${ONLY_URL:-<all>}" >&2

while IFS='|' read -r goal url; do
  goal="${goal## }"; goal="${goal%% }"
  url="${url## }"; url="${url%% }"
  case "$goal" in ''|\#*) continue ;; esac
  [ -z "$url" ] && continue
  if [ -n "$ONLY_URL" ] && [ "$url" != "$ONLY_URL" ]; then
    continue
  fi
  i=$((i+1))

  wipe_marketplace
  slug=$(printf '%s' "$url" | tr '/:?&=.' '_')
  out_file="$RUN_DIR/${i}_${slug:0:60}.out"
  echo "[bench-hard] ($i) $url" >&2

  # --force-capture: skip the probe short-circuit and exercise the real
  # capture pipeline. Without it resolve's "budget_race" probe wins in
  # ~1s with no_match for any site that doesn't already have a published
  # skill — defeating the whole point of a hard-target benchmark.
  # shellcheck disable=SC2086
  timeout "$TIMEOUT" $CLI_CMD resolve --intent "$goal" --url "$url" --force-capture </dev/null > "$out_file" 2>&1
  cli_exit=$?
  if [ "$cli_exit" -ne 0 ]; then
    echo "  [bench-hard] cli exit=$cli_exit (124=timeout)" >&2
  fi

  record=$(python3 "$EXTRACT_PY" "$out_file" "$goal" "$url" "$cli_exit")
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  enriched=$(printf '%s' "$record" | python3 -c "
import sys, json
row = json.loads(sys.stdin.read())
row['run_id'] = '$RUN_ID'
row['ts'] = '$ts'
row['note'] = '''${NOTE//\'/}'''
print(json.dumps(row))
")
  echo "$enriched" >> "$results_file"
  echo "$enriched" >> "$HISTORY_JSONL"

  # Compact one-line live status
  printf '%s' "$enriched" | python3 -c "
import sys, json
d = json.loads(sys.stdin.read())
parts = [d.get('verdict') or '?']
if d.get('source'): parts.append(f\"src={d['source']}\")
if d.get('n_operations'): parts.append(f\"ops={d['n_operations']}\")
if d.get('error_code'): parts.append(f\"err={d['error_code']}\")
bs = d.get('browser_block_signals') or ''
if bs and bs != '[]': parts.append(f\"block={bs[:80]}\")
diag = d.get('capture_diagnostic') or ''
if diag: parts.append(f\"diag={diag}\")
print('  ' + ' | '.join(parts), file=sys.stderr)
"
done < "$CORPUS"

echo "[bench-hard] wrote $i rows to $results_file" >&2
echo "[bench-hard] appended to $HISTORY_JSONL" >&2

# Per-run summary
python3 - "$results_file" "$RUN_DIR/summary.json" <<'PY'
import sys, json, collections
rows = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
buckets = collections.Counter(r.get('verdict') or 'UNKNOWN' for r in rows)
total = len(rows)
reachable_passes = buckets.get('PASS', 0)
fallback_passes = buckets.get('PASS_DOM_FALLBACK_ONLY', 0)
blocked = buckets.get('BROWSER_BLOCK', 0) + buckets.get('AUTH_GATED', 0)
reachable = total - blocked
summary = {
    'total': total,
    'buckets': dict(buckets),
    'reachable': reachable,
    'real_pass_rate_pct': round(100*reachable_passes/reachable, 1) if reachable else None,
    'pass_or_fallback_rate_pct': round(100*(reachable_passes+fallback_passes)/reachable, 1) if reachable else None,
}
open(sys.argv[2], 'w').write(json.dumps(summary, indent=2))
print('\n[bench-hard] summary:', file=sys.stderr)
for k,v in buckets.most_common():
    print(f'  {k:<30} {v}', file=sys.stderr)
if reachable:
    print(f'  REAL-API pass rate: {summary["real_pass_rate_pct"]}% ({reachable_passes}/{reachable})', file=sys.stderr)
PY

echo "[bench-hard] done. run dir: $RUN_DIR" >&2
