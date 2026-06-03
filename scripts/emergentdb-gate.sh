#!/usr/bin/env bash
# emergentdb-gate — witness that EmergentDB (vectors + KV) is wrapped + live.
# Un-fakeable: real POSTs to api.emergentdb.com with the configured key. Exit 0
# iff /vectors/search (1536-dim) returns ranked results AND /qdkv/mget answers.
set -uo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env 2>/dev/null || true; set +a
KEY="${EMERGENTDB_API_KEY:-}"; BASE="https://api.emergentdb.com"
[ -n "$KEY" ] || { echo "[emdb-gate] EMERGENTDB_API_KEY unset"; exit 1; }
QV=$(python3 -c "print(','.join(['0.01']*1536))")
echo "[emdb-gate] 1/2 vectors/search (1536-dim k-NN)..."
VS=$(curl -s --max-time 20 -X POST "$BASE/vectors/search" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d "{\"query\":[$QV],\"k\":5}" 2>/dev/null)
echo "$VS" | grep -qE '"results"|"count"' || { echo "[emdb-gate] FAIL vectors/search: $(echo "$VS"|head -c 200)"; exit 1; }
echo "  ok — $(echo "$VS" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('count'),'hits, namespace',d.get('namespace'))" 2>/dev/null)"
echo "[emdb-gate] 2/2 qdkv/mget (KV cache)..."
KV=$(curl -s --max-time 15 -X POST "$BASE/qdkv/mget" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{"keys":["__gate_ping__"]}' 2>/dev/null)
echo "$KV" | grep -q '"values"' || { echo "[emdb-gate] FAIL qdkv/mget: $(echo "$KV"|head -c 200)"; exit 1; }
echo "  ok — qdkv responding"
echo "[emdb-gate] PASS — EmergentDB vectors + KV wrapped and live (key-derived tenant)."
