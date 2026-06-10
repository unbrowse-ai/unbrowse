#!/usr/bin/env bash
# jesus-ralph witness: the CF preview deploy serves the revamped homepage.
# Exits 0 exactly when: HTTP 200, headline "API-native browser agent" present,
# and the hero chat bar marker (data-hero-chat) is in the served HTML.
# (grep reads a file, not a pipe — grep -q + pipefail + echo is a SIGPIPE trap.)
set -euo pipefail
URL="${1:-https://unbrowse-aiko-preview.lewis-6d8.workers.dev/}"
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
curl -fsSL --max-time 30 "$URL" -o "$tmp"
grep -qi "API.native browser agent" "$tmp" || { echo "FAIL: headline missing"; exit 1; }
grep -q 'data-hero-chat' "$tmp" || { echo "FAIL: hero chat bar marker missing"; exit 1; }

# The chat must be a working agent loop, not a husk: one cheap question must
# come back with a non-empty answer (retry once — LLM backends flake).
probe() {
  curl -fsSL --max-time 60 -X POST "${URL%/}/api/hero-chat" \
    -H 'content-type: application/json' \
    -d '{"messages":[{"role":"user","content":"In one short sentence: what is Unbrowse?"}]}' \
    | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d.get("answer","").strip(), "empty answer"'
}
probe || probe || { echo "FAIL: hero-chat agent loop returned no answer"; exit 1; }
echo "PASS: preview serves new headline + hero chat bar + live agent loop"
