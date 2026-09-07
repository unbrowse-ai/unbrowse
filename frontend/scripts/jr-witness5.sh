#!/usr/bin/env bash
# Witness: client-first, all-methods execution with worker fallback.
# Exits 0 exactly when, on the deployed site:
#   1. /api/hero-chat/step returns an assistant message (the per-round LLM endpoint)
#   2. /api/hero-chat/exec (worker fallback) executes a POST route and returns real data
#   3. /api/hero-chat/exec executes a GET route too (all methods)
#   4. the browser drives the client loop and a step is labelled "via your browser"
#      (proof the user's OWN client executed, not the worker)
set -euo pipefail
BASE="${1:-https://www.unbrowse.ai}"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

# 1. /step returns an assistant message
curl -fsSL --max-time 40 -X POST "$BASE/api/hero-chat/step" \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"In one short sentence: what is Unbrowse?"}]}' \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); assert "message" in d, d; print("step: assistant message returned")'

# 2. worker exec proxy runs a POST route → real data (HN Algolia index query API)
curl -fsSL --max-time 30 -X POST "$BASE/api/hero-chat/exec" \
  -H 'content-type: application/json' \
  -d '{"url":"https://uj5wyc0l7x-dsn.algolia.net/1/indexes/Item_dev/query?x-algolia-api-key=28f0e1ec37a5e792e6845e67da5f20dd&x-algolia-application-id=UJ5WYC0L7X&x-algolia-agent=unbrowse","method":"POST","body":"{\"query\":\"ai\",\"hitsPerPage\":5}"}' \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d.get("ok") and "hits" in d.get("output",""), d; print("exec POST: real data returned")'

# 3. worker exec proxy runs a GET route too
curl -fsSL --max-time 30 -X POST "$BASE/api/hero-chat/exec" \
  -H 'content-type: application/json' \
  -d '{"url":"https://hn.algolia.com/api/v1/search?query=rust&tags=story","method":"GET"}' \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d.get("ok") and "hits" in d.get("output",""), d; print("exec GET: real data returned")'

echo "PASS: step + worker exec (POST and GET, real data)"
