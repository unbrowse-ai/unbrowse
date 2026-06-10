#!/usr/bin/env bash
# jesus-ralph witness #2: ONE chat surface — the real agent loop — everywhere.
# Exits 0 exactly when, on the CF preview deploy:
#   1. /, /aiko, /playground serve NO reference to the bare-LLM chat.unbrowse.ai
#   2. /aiko and /playground serve the agent chat (data-hero-chat marker)
#   3. / still serves the headline + agent chat
#   4. POST /api/hero-chat returns a non-empty answer (the loop is alive)
set -euo pipefail
BASE="${1:-https://unbrowse-aiko-preview.lewis-6d8.workers.dev}"
tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

for path in "/" "/aiko" "/playground"; do
  f="$tmpdir/$(echo "$path" | tr '/' '_').html"
  curl -fsSL --max-time 30 "${BASE}${path}" -o "$f"
  if grep -q "chat\.unbrowse\.ai" "$f"; then
    echo "FAIL: ${path} still references chat.unbrowse.ai"; exit 1
  fi
  grep -q 'data-hero-chat' "$f" || { echo "FAIL: ${path} missing agent chat marker"; exit 1; }
done
grep -qi "API.native browser agent" "$tmpdir/_.html" || { echo "FAIL: headline missing on /"; exit 1; }

probe() {
  curl -fsSL --max-time 60 -X POST "${BASE}/api/hero-chat" \
    -H 'content-type: application/json' \
    -d '{"messages":[{"role":"user","content":"In one short sentence: what is Unbrowse?"}]}' \
    | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d.get("answer","").strip(), "empty answer"'
}
probe || probe || { echo "FAIL: hero-chat agent loop returned no answer"; exit 1; }
echo "PASS: one agent chat everywhere; bare-LLM surfaces gone; loop alive"
