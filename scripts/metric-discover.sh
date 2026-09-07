#!/usr/bin/env bash
# metric-discover — walk every unbrowse analytics endpoint and print every
# numeric leaf as a probe-ready path. Replaces hand-curated metric lists.
#
# Output format (one line per metric):
#   <endpoint>#<json.path> <current_value> <unit_guess>
#
# Use the path directly with metric-probe.sh:
#   MONEY_METRIC="analytics.funnel#stages[1].users" \
#   MONEY_PROBE="$PWD/scripts/metric-probe.sh" bash <harness>
set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
ADMIN="${UNBROWSE_ADMIN_KEY:-$(grep '^UNBROWSE_ADMIN_KEY' "$REPO_ROOT/.env" 2>/dev/null | sed 's/^[^=]*=//')}"
BASE="${UNBROWSE_API_URL:-https://beta-api.unbrowse.ai}"
LAUNCH="${UNBROWSE_LAUNCH_URL:-https://launch.unbrowse.ai}"

ENDPOINTS=(
  "analytics.dashboard|$BASE/v1/analytics/dashboard|admin"
  "analytics.engagement|$BASE/v1/analytics/engagement|admin"
  "analytics.retention|$BASE/v1/analytics/retention|admin"
  "analytics.funnel|$BASE/v1/analytics/funnel|admin"
  "analytics.growth|$BASE/v1/analytics/growth|admin"
  "analytics.usage|$BASE/v1/analytics/usage|admin"
  "analytics.network|$BASE/v1/analytics/network|admin"
  "analytics.economics|$BASE/v1/analytics/economics|admin"
  "analytics.bottleneck|$BASE/v1/analytics/bottleneck|admin"
  "analytics.flywheel|$BASE/v1/analytics/flywheel|admin"
  "analytics.acquisition|$BASE/v1/analytics/acquisition|admin"
  "analytics.install|$BASE/v1/analytics/install|admin"
  "analytics.install-funnel|$BASE/v1/analytics/install-funnel|admin"
  "analytics.activation|$BASE/v1/analytics/activation|admin"
  "stats.summary|$BASE/v1/stats/summary|public"
  "stats.fees|$BASE/v1/stats/fees|admin"
  "stats.attribution|$BASE/v1/stats/attribution|admin"
  "credits.pool|$BASE/v1/credits/pool|admin"
  "traction|$LAUNCH/api/traction|public"
)

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

fetch_one() {
  local name="$1" url="$2" auth="$3"
  if [ "$auth" = "admin" ]; then
    curl -sS --max-time 8 -H "Authorization: Bearer $ADMIN" "$url" -o "$TMP/$name.json" -w "%{http_code}" 2>/dev/null
  else
    curl -sS --max-time 8 "$url" -o "$TMP/$name.json" -w "%{http_code}" 2>/dev/null
  fi
}

# Parallel fetch — ~20 endpoints in ~2s instead of 40s serial.
pids=()
for ep in "${ENDPOINTS[@]}"; do
  name="${ep%%|*}"; rest="${ep#*|}"; url="${rest%%|*}"; auth="${rest##*|}"
  (fetch_one "$name" "$url" "$auth" > "$TMP/$name.code") &
  pids+=($!)
done
for pid in "${pids[@]}"; do wait "$pid" || true; done

# Walk every JSON body and emit leaves.
python3 <<PY
import json, os
TMP = "$TMP"
def walk(obj, path="", out=None):
    if out is None: out = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            walk(v, f"{path}.{k}" if path else k, out)
    elif isinstance(obj, list):
        if obj and all(isinstance(x, (int, float)) and not isinstance(x, bool) for x in obj):
            pass  # skip raw numeric lists — use summary stats instead
        elif obj and isinstance(obj[0], dict):
            # Emit [0] as template path — user can index others
            walk(obj[0], f"{path}[0]", out)
    elif isinstance(obj, (int, float)) and not isinstance(obj, bool):
        out.append((path, obj))
    return out

def unit_hint(path, value):
    p = path.lower()
    if any(k in p for k in ["_usd","cost","price","revenue","ltv","saved_usd"]): return "usd"
    if any(k in p for k in ["_pct","rate","ratio","_pc"]) and value <= 1.0: return "ratio"
    if any(k in p for k in ["_pct"]): return "pct"
    if any(k in p for k in ["_ms","latency","duration"]): return "ms"
    if any(k in p for k in ["_uc"]): return "uc"
    if any(k in p for k in ["tokens"]): return "tokens"
    return "count"

for fname in sorted(os.listdir(TMP)):
    if not fname.endswith(".json"): continue
    name = fname[:-5]
    code_file = os.path.join(TMP, f"{name}.code")
    code = open(code_file).read().strip() if os.path.exists(code_file) else "?"
    try:
        body = json.load(open(os.path.join(TMP, fname)))
    except Exception as e:
        print(f"# {name}  HTTP {code}  parse-error: {e}")
        continue
    if code != "200":
        print(f"# {name}  HTTP {code}  skipped")
        continue
    leaves = walk(body)
    print(f"# === {name} ({len(leaves)} metrics) ===")
    for p, v in leaves:
        unit = unit_hint(p, v)
        print(f"{name}#{p}  {v}  {unit}")
PY
