#!/usr/bin/env bash
# Layer contract gate: fold a URL through DNS -> TLS -> native fetch -> curl impersonation
# -> direct-document -> installed CLI search, and fail with the exact unclosed pipe hole.
set -uo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

OUT="${UNBROWSE_LAYER_CONTRACT_OUT:-.evidence-build/layer-contract/latest.json}"
mkdir -p "$(dirname "$OUT")"

if bun bench/exa/layer-contract.ts > "$OUT"; then
  python3 - "$OUT" <<'PY'
import json, sys
obj=json.load(open(sys.argv[1]))
print(f"LAYER CONTRACT PASS: {len(obj['reports'])} target(s)")
for report in obj['reports']:
    print(f"  {report['url']}")
    for layer in report['layers']:
        detail=layer.get('detail') or {}
        bits=[]
        for k in ('status','bytes','markdown_bytes','source','reason','skipped'):
            if k in detail: bits.append(f"{k}={detail[k]}")
        print(f"    {layer['layer']}: {layer['status']} {' '.join(bits)}")
PY
  exit 0
fi

python3 - "$OUT" <<'PY'
import json, sys
obj=json.load(open(sys.argv[1]))
print("LAYER CONTRACT FAIL")
for report in obj.get('reports', []):
    print(f"  {report.get('url')}")
    for hole in report.get('holes', []):
        print(f"    HOLE {hole['layer']}: {hole['reason']}")
PY
exit 1
