#!/usr/bin/env bash
# ralph-bench-loop.sh — continuous agent-experience improvement loop.
#
# Composition of primitives (harnesses on harnesses):
#
#   1. site-miner.sh   — mine problem URLs from github issues + reddit + hn
#                         (uses unbrowse itself to scrape those sources)
#   2. bench-local.sh  — run unbrowse resolve on each candidate URL,
#                         classify via captured_meta signals
#   3. bench-judge.ts  — LLM agent judge for ambiguous cases (uses same
#                         provider as unbrowse's internal agent augmenter)
#   4. this script     — orchestrates: mine → bench → classify → promote
#
# Output:
#   - passing candidates → appended to scripts/corpus/benchmark-baseline.txt
#                          (grows permanent regression coverage)
#   - blocked candidates → appended to .bench-learned-problems/blocks.jsonl
#                          (known-hostile-sites with captured_meta for future
#                          detection tuning)
#   - failing candidates → appended to .bench-learned-problems/fails.jsonl
#                          (real product gaps; agent reviews to fix)
#
# Stop conditions:
#   - N iterations completed (default: 1)
#   - a new failure CLASS appears (grouped by error_code + meta shape)
#   - no new candidates to mine (miner returned zero after dedup)
#
# Usage:
#   bash scripts/ralph-bench-loop.sh --iter 3 --mine-sources github,reddit
#   bash scripts/ralph-bench-loop.sh --no-mine          # reuse existing candidates
#   bash scripts/ralph-bench-loop.sh --stop-on-new-fail # halt if new product fail class
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ITERATIONS=1
MINE=1
MINE_SOURCES="github,reddit,hn"
STOP_ON_NEW_FAIL=0
for arg in "$@"; do
  case "$arg" in
    --iter) shift; ITERATIONS="${1:-1}"; shift || true ;;
    --mine-sources) shift; MINE_SOURCES="${1:-github,reddit}"; shift || true ;;
    --no-mine) MINE=0 ;;
    --stop-on-new-fail) STOP_ON_NEW_FAIL=1 ;;
  esac
done

LEARN_DIR=".bench-learned-problems"
mkdir -p "$LEARN_DIR"
touch "$LEARN_DIR/blocks.jsonl" "$LEARN_DIR/fails.jsonl" "$LEARN_DIR/passes.jsonl"

BASELINE="scripts/corpus/benchmark-baseline.txt"
CANDIDATES="scripts/corpus/benchmark-candidates.txt"

log() { echo "[ralph] $(date +%H:%M:%S) $*"; }

# Capture the current set of failure classes (error_code + rough meta shape)
# so we can tell if a NEW class appears after an iteration
snapshot_fail_classes() {
  python3 - <<'PY' 2>/dev/null || echo ""
import json, os
seen = set()
for line in open('.bench-learned-problems/fails.jsonl'):
    try:
        d = json.loads(line)
        ec = d.get('error_code','')
        meta = d.get('meta',{}) or {}
        reason = meta.get('intent_reason','')
        bucket = int((meta.get('text_bytes',0) or 0) / 1000)
        seen.add(f"{ec}:{reason}:~{bucket}k")
    except: pass
print("\n".join(sorted(seen)))
PY
}

for iter in $(seq 1 "$ITERATIONS"); do
  log "=== iteration $iter / $ITERATIONS ==="

  PREV_FAIL_CLASSES="$(snapshot_fail_classes)"

  if [ "$MINE" = "1" ]; then
    log "mining candidate sites from: $MINE_SOURCES"
    bash scripts/site-miner.sh --sources "$MINE_SOURCES" 2>&1 | sed 's/^/  /'
    if [ ! -s "$CANDIDATES" ]; then
      log "miner returned zero new candidates — stopping"
      break
    fi
    cand_count=$(wc -l < "$CANDIDATES" | tr -d ' ')
    log "have $cand_count candidates to test"
  fi

  # Temporarily swap baseline → candidates so bench-local.sh runs over them
  BASELINE_BAK=$(mktemp)
  cp "$BASELINE" "$BASELINE_BAK"
  cp "$CANDIDATES" "$BASELINE"
  log "running bench-local.sh over candidates..."
  bash scripts/bench-local.sh 2>&1 | grep --line-buffered -E 'running|→ fail|→ block|pass=|rate=' | sed 's/^/  /'
  cp "$BASELINE_BAK" "$BASELINE"
  rm -f "$BASELINE_BAK"

  # Read per-URL results and promote
  if [ ! -f ".bench-local/summary.json" ]; then
    log "no summary.json — iteration failed"
    continue
  fi

  python3 - "$iter" <<'PY'
import sys, json, os
iter_n = sys.argv[1]
try:
    summary = json.load(open('.bench-local/summary.json'))
except Exception as e:
    print(f"[ralph] summary parse err: {e}")
    sys.exit(0)

new_pass = 0
new_block = 0
new_fail = 0
# Load existing baseline to avoid duplicate promotion
baseline_urls = set()
try:
    for line in open('scripts/corpus/benchmark-baseline.txt'):
        if '|' in line:
            _, u = line.strip().split('|', 1)
            baseline_urls.add(u)
except: pass

for r in summary.get('per_url', []):
    url = r.get('url','')
    verdict = r.get('verdict','')
    row = {**r, 'iter': iter_n}
    if verdict == 'pass':
        if url not in baseline_urls:
            # Promote to baseline (grow permanent coverage)
            with open('scripts/corpus/benchmark-baseline.txt', 'a') as f:
                f.write(f"{r.get('goal','get data')}|{url}\n")
            new_pass += 1
        with open('.bench-learned-problems/passes.jsonl','a') as f:
            f.write(json.dumps(row) + "\n")
    elif verdict == 'block':
        with open('.bench-learned-problems/blocks.jsonl','a') as f:
            f.write(json.dumps(row) + "\n")
        new_block += 1
    elif verdict == 'fail':
        with open('.bench-learned-problems/fails.jsonl','a') as f:
            f.write(json.dumps(row) + "\n")
        new_fail += 1

print(f"[ralph] iter {iter_n}: +{new_pass} promoted to baseline, +{new_block} blocks learned, +{new_fail} fails surfaced")
PY

  NEW_FAIL_CLASSES="$(snapshot_fail_classes)"
  if [ "$STOP_ON_NEW_FAIL" = "1" ]; then
    NEW_CLASS="$(comm -23 <(echo "$NEW_FAIL_CLASSES" | sort -u) <(echo "$PREV_FAIL_CLASSES" | sort -u))"
    if [ -n "$NEW_CLASS" ]; then
      log "⚠ new failure class detected:"
      echo "$NEW_CLASS" | sed 's/^/    /'
      log "stopping for agent review (--stop-on-new-fail)"
      break
    fi
  fi
done

log "=== done ==="
log "baseline size: $(wc -l < "$BASELINE" | tr -d ' ') rows"
log "learned blocks: $(wc -l < "$LEARN_DIR/blocks.jsonl" | tr -d ' ')"
log "learned fails:  $(wc -l < "$LEARN_DIR/fails.jsonl" | tr -d ' ')"
log "learned passes: $(wc -l < "$LEARN_DIR/passes.jsonl" | tr -d ' ')"
