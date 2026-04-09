#!/bin/bash
# turbobox-bench.sh — parallel benchmark on turbobox sandboxes
#
# Primitive: spins up N sandbox boxes, installs unbrowse, runs corpus in parallel waves.
# Uses turbobox-setup-box.sh inside each box for reliable Chrome→Kuri→Unbrowse setup.
#
# LEARNED CONSTRAINTS:
# - Max 16 CPU cores / 32GB RAM across all boxes
# - 4 boxes × 4cpu × 4GB = maxes out quota
# - Each box needs: Chrome (headless) + Kuri broker + unbrowse CLI
# - Chrome MUST start before Kuri, Kuri MUST start before unbrowse
# - Use KURI_EXTERNAL_PORT=7700 to skip unbrowse's internal Kuri launch
# - Boxes can go stale — restart Chrome+Kuri between site batches
#
# Usage:
#   bash scripts/turbobox-bench.sh                    # 8 boxes, impossible-30 corpus
#   bash scripts/turbobox-bench.sh --boxes 4          # 4 boxes
#   bash scripts/turbobox-bench.sh --version 3.4.1    # specific version
#   bash scripts/turbobox-bench.sh --corpus evals/trace-loop.reddit-impossible-30.json
#
set -euo pipefail

TB="https://sandbox.trilok.ai"
NUM_BOXES="${1:-8}"
VERSION="${2:-preview}"
CORPUS="${3:-evals/trace-loop.reddit-impossible-30.json}"

echo "=== TURBOBOX BENCHMARK ==="
echo "boxes: $NUM_BOXES  version: $VERSION  corpus: $CORPUS"

# Read sites from corpus
SITES=$(python3 -c "
import json
with open('$CORPUS') as f:
    d = json.load(f)
for c in d['cases']:
    print(f\"{c['id']}|{c['url']}|{c.get('intent','extract data')}\")
")
TOTAL=$(echo "$SITES" | wc -l | tr -d ' ')
echo "sites: $TOTAL"

# Cleanup existing boxes
echo "=== CLEANUP ==="
curl -sf "$TB/v1/boxes" | python3 -c "
import sys,json
for b in json.load(sys.stdin):
    print(b['id'])
" | while read id; do curl -sf -X DELETE "$TB/v1/boxes/$id" > /dev/null 2>&1; done
sleep 2

# Create boxes
echo "=== CREATE $NUM_BOXES BOXES ==="
BIDS=()
for i in $(seq 1 $NUM_BOXES); do
  RESP=$(curl -sf -X POST "$TB/v1/boxes" -H "Content-Type: application/json" -d '{"image":"ubuntu","cpu":2000,"memory":4096}')
  BID=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null)
  BIDS+=("$BID")
done
echo "created: ${#BIDS[@]}"

# Setup all boxes in parallel: Chrome + unbrowse + Kuri
echo "=== SETUP ==="
for BID in "${BIDS[@]}"; do
  curl -sf --max-time 180 -X POST "$TB/v1/boxes/$BID/exec" \
    -d "nohup google-chrome --headless --no-sandbox --disable-gpu --remote-debugging-port=9222 --incognito about:blank > /dev/null 2>&1 & sleep 3 && npm install -g unbrowse@${VERSION} 2>/dev/null && echo y | unbrowse setup --accept-tos --skip-browser --agent-email b@unbrowse.ai --non-interactive 2>/dev/null && CDP_URL=ws://127.0.0.1:9222 PORT=7700 nohup /root/.unbrowse/bin/kuri > /dev/null 2>&1 & sleep 2 && echo READY:$BID" &
done
wait
echo "=== ALL READY ==="

# Run benchmark in waves
echo ""
echo "site,endpoints,status"
WAVE=0
echo "$SITES" | while IFS= read -r SITE_LINE; do
  BOX_IDX=$((WAVE % NUM_BOXES))
  BOX="${BIDS[$BOX_IDX]}"
  SID=$(echo "$SITE_LINE" | cut -d'|' -f1)
  URL=$(echo "$SITE_LINE" | cut -d'|' -f2)

  (
    RESULT=$(curl -sf --max-time 90 -X POST "$TB/v1/boxes/$BOX/exec" \
      -d "KURI_EXTERNAL_PORT=7700 CDP_URL=ws://127.0.0.1:9222 unbrowse go '$URL' 2>&1 | tail -1 && sleep 5 && KURI_EXTERNAL_PORT=7700 unbrowse close 2>&1 | tail -1" 2>&1)
    EP=$(echo "$RESULT" | grep -o '"endpoint_count":[0-9]*' | cut -d: -f2)
    if echo "$RESULT" | grep -q '"ok":true'; then
      echo "$SID,${EP:-0},ok"
    else
      echo "$SID,0,fail"
    fi
  ) &

  WAVE=$((WAVE + 1))
  # Wait after each wave of NUM_BOXES
  if [ $((WAVE % NUM_BOXES)) -eq 0 ]; then
    wait
  fi
done
wait

# Cleanup
echo ""
echo "=== CLEANUP ==="
for BID in "${BIDS[@]}"; do
  curl -sf -X DELETE "$TB/v1/boxes/$BID" > /dev/null 2>&1
done
echo "done"
