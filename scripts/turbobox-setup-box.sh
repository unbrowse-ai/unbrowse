#!/bin/bash
# turbobox-setup-box.sh — setup ONE turbobox for unbrowse benchmarking
#
# The LEARNED sequence (from 10+ failed attempts):
# 1. Kill everything first (stale processes break everything)
# 2. Start Chrome FIRST (headless, port 9222)
# 3. Wait 3s for Chrome to be ready
# 4. Start Kuri broker pointing at Chrome (port 7700)
# 5. Wait 2s for Kuri to connect
# 6. Verify Kuri health
# 7. THEN run unbrowse with KURI_EXTERNAL_PORT=7700
#
# Key learnings:
# - Chrome must be started before Kuri (ConnectionRefused otherwise)
# - Kuri must be started before unbrowse (Kuri failed to start otherwise)
# - unbrowse server must NOT be running (it tries to start its own Kuri)
# - KURI_EXTERNAL_PORT tells unbrowse to use existing broker
# - CDP_URL tells unbrowse where Chrome is
# - All three processes need to be alive simultaneously
#
# Usage (run INSIDE a turbobox via exec):
#   bash /tmp/setup.sh                    # setup only
#   bash /tmp/setup.sh --test <url>       # setup + test one URL
#   bash /tmp/setup.sh --bench <url1> <url2> ...  # setup + bench multiple

set -euo pipefail

# Step 1: Kill stale processes
pkill -9 chrome kuri node 2>/dev/null || true
sleep 1

# Step 2: Start Chrome
nohup google-chrome --headless --no-sandbox --disable-gpu \
  --remote-debugging-port=9222 --incognito about:blank \
  > /dev/null 2>&1 &
sleep 3

# Step 3: Start Kuri broker
CDP_URL=ws://127.0.0.1:9222 PORT=7700 nohup /root/.unbrowse/bin/kuri > /dev/null 2>&1 &
sleep 2

# Step 4: Verify
HEALTH=$(curl -sf http://127.0.0.1:7700/health 2>/dev/null || echo '{"ok":false}')
if echo "$HEALTH" | grep -q '"ok":true'; then
  echo "READY"
else
  echo "FAILED: kuri health check failed"
  echo "$HEALTH"
  exit 1
fi

# Step 5: Run test if requested
if [ "${1:-}" = "--test" ] && [ -n "${2:-}" ]; then
  URL="$2"
  RESULT=$(KURI_EXTERNAL_PORT=7700 CDP_URL=ws://127.0.0.1:9222 unbrowse go "$URL" 2>&1 | tail -1)
  echo "$RESULT"
  sleep 5
  CLOSE=$(KURI_EXTERNAL_PORT=7700 unbrowse close 2>&1 | tail -1)
  echo "$CLOSE"
fi

# Step 6: Bench multiple if requested
if [ "${1:-}" = "--bench" ]; then
  shift
  echo "site,endpoints,status"
  for URL in "$@"; do
    SID=$(echo "$URL" | sed 's|https\?://||;s|/.*||;s|www\.||')
    RESULT=$(KURI_EXTERNAL_PORT=7700 CDP_URL=ws://127.0.0.1:9222 unbrowse go "$URL" 2>&1 | tail -1)
    sleep 5
    CLOSE=$(KURI_EXTERNAL_PORT=7700 unbrowse close 2>&1 | tail -1)
    EP=$(echo "$CLOSE" | grep -o '"endpoint_count":[0-9]*' | cut -d: -f2)
    if echo "$RESULT" | grep -q '"ok":true'; then
      echo "$SID,${EP:-0},ok"
    else
      echo "$SID,0,fail"
    fi
  done
fi
