#!/usr/bin/env bash
# rank-evidence.sh — primitive that emits top-N candidate evidence for an LLM judge.
# Reasoning: the deterministic ranker (BM25 + a few generic signals) is enough
# to surface the top ~5 candidates. Picking the right one in ambiguous cases
# (sparse descriptions, GraphQL ops, multi-resource pages) is a job for an LLM
# reading the evidence — NOT a hard-coded registry of `if domain == X then op Y`.
#
# Usage:
#   bash harness/probes/rank-evidence.sh --intent "..." --url "..."
#
# Output (stdout): a JSON object the agent can pipe to an LLM along with the
# question "given this intent and context, which candidate best satisfies it?"
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
INTENT=""
URL=""
TOP_N=5
while [ $# -gt 0 ]; do
  case "$1" in
    --intent)  INTENT="$2"; shift 2 ;;
    --url)     URL="$2"; shift 2 ;;
    --top)     TOP_N="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
[ -z "$INTENT" ] || [ -z "$URL" ] && { echo "usage: $0 --intent X --url Y [--top N]" >&2; exit 2; }

pkill -9 -f 'kuri|chrome' 2>/dev/null
TMP=$(mktemp -t rank-evidence)
timeout 45 bun "$REPO/src/cli.ts" resolve --intent "$INTENT" --url "$URL" >"$TMP" 2>/dev/null
python3 - "$INTENT" "$URL" "$TOP_N" "$TMP" <<'PY'
import sys, json
intent, url, top_n, path = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]
raw = open(path).read()
import re
m = re.search(r'\{', raw)
parsed = None
if m:
    chunk = raw[m.start():].rstrip()
    while chunk:
        try:
            parsed = json.loads(chunk, strict=False)
            if isinstance(parsed, dict) and any(k in parsed for k in ('result','available_endpoints','available_operations')):
                break
            parsed = None
        except Exception:
            pass
        last = chunk.rfind('}')
        if last <= 0: break
        chunk = chunk[:last+1]
if not parsed:
    print(json.dumps({"error":"parse_failed","intent":intent,"url":url}))
    sys.exit(0)
r = parsed.get('result', parsed)
ae = r.get('available_endpoints', [])[:top_n]
ao = r.get('available_operations', [])[:top_n]
out = {
    "intent": intent,
    "context_url": url,
    "diagnostic": r.get('diagnostic'),
    "shortlist_for_judgment": [
        {
            "rank": i,
            "endpoint_id": ep.get('endpoint_id'),
            "method": ep.get('method'),
            "url": ep.get('url'),
            "score": ep.get('score'),
            "description": ep.get('description'),
            "input_params": ep.get('input_params'),
            "schema_summary": ep.get('schema_summary'),
            "example_fields": ep.get('example_fields'),
            "sample_values": ep.get('sample_values'),
            "needs_params": ep.get('needs_params'),
            "trigger_url": ep.get('trigger_url'),
        }
        for i, ep in enumerate(ae)
    ],
    "agent_facing_shortlist": [
        {
            "rank": i,
            "endpoint_id": op.get('endpoint_id'),
            "method": op.get('method'),
            "url_template": op.get('url_template') or op.get('url'),
            "description": op.get('description_out') or op.get('description'),
        }
        for i, op in enumerate(ao)
    ],
    "judgment_question": (
        f"Given the intent {intent!r} on {url!r}, which of the {len(ae)} candidate "
        "endpoints in `shortlist_for_judgment` best satisfies the intent? Reply "
        "with the endpoint_id of the best match and a one-line reason. If none "
        "match (e.g. the right endpoint isn't in the cache), say `defer_to_capture`."
    ),
}
print(json.dumps(out, indent=2))
PY
rm -f "$TMP"
