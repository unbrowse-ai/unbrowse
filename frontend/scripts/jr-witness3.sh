#!/usr/bin/env bash
# Witness: the warm path is real in prod.
# Exits 0 exactly when:
#   1. the live marketplace search returns a hn.algolia.com route for the HN intent
#   2. prod /api/hero-chat answers the HN question with a successful execute step
#      against hn.algolia.com that is NOT the page-text fallback, and a non-empty answer
set -euo pipefail
API="${API:-https://beta-api.unbrowse.ai}"
PROD="${PROD:-https://www.unbrowse.ai}"

curl -fsSL --max-time 30 -X POST "$API/v1/search" \
  -H 'content-type: application/json' \
  -d '{"intent":"top stories on hacker news"}' \
  | python3 -c '
import json,sys
d=json.load(sys.stdin)
hits=[r for r in d.get("results",[]) if "hn.algolia" in json.dumps(r.get("metadata",{}))]
assert hits, "no hn.algolia route in marketplace search"
print("marketplace: hn.algolia route found")'

curl -fsSL --max-time 90 -X POST "$PROD/api/hero-chat" \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"Top stories on Hacker News right now"}]}' \
  | python3 -c '
import json,sys
d=json.load(sys.stdin)
steps=d.get("steps",[])
labels=[s.get("label","") for s in steps if s.get("ok")]
ok=[l for l in labels if "hn.algolia" in l and "page text" not in l]
assert ok, "no successful hn.algolia execute step; steps: " + "; ".join(labels)
assert d.get("answer","").strip(), "empty answer"
print("prod: HN answered through the hn.algolia route")'
echo "PASS: warm path live in prod"
