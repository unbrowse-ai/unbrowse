#!/usr/bin/env bash
# jesus-ralph witness: the route index is populated end-to-end — a live resolve/search
# against the target backend returns at least one REAL route. exit 0 only then.
# Target backend via UNBROWSE_API_URL (default the experiments backend, where a fresh
# official CLI is release-valid and autoIndexFromReveng writes on capture).
set -uo pipefail
cd "$(dirname "$0")/../.."
API="${UNBROWSE_API_URL:-https://beta-api.unbrowse.ai}"
n=$(curl -s -m15 -X POST "$API/v1/search" -H "Content-Type: application/json" -d '{"query":"quotes","limit":3}' 2>/dev/null | python3 -c "import sys,json;d=json.load(sys.stdin);r=d.get('results') or d.get('domain_results') or d.get('skills') or [];print(len(r) if isinstance(r,list) else 0)" 2>/dev/null || echo 0)
echo "resolve routes (@$API) = $n"
if [ "${n:-0}" -ge 1 ]; then echo "INDEX POPULATED — resolve returns a real route. exit 0"; exit 0; fi
echo "index still empty — resolve returns nothing. exit 1"; exit 1
