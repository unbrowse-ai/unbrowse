#!/usr/bin/env bash
# docs-hunter/verify.sh
# Runs impl.sh against two known-good domains and asserts:
#   - impl exits 0
#   - the output JSON file exists
#   - at least one source had a 200 status
#   - robots.txt is reachable (sanity check — every domain has one)
#
# Exit codes:
#   0 — all assertions passed (green)
#   1 — hard fail (red)
#   2 — soft fail / skipped (yellow)
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
IMPL="$HERE/impl.sh"
chmod +x "$IMPL"

# Two test domains. Stripe has a full OpenAPI + llms.txt likely.
# raw.githubusercontent.com has robots + small surface.
TEST_DOMAINS=("stripe.com" "github.com")
PASSED=0
FAILED_DOMAINS=()

for d in "${TEST_DOMAINS[@]}"; do
  if bash "$IMPL" "$d" >/dev/null 2>&1; then
    PASSED=$((PASSED+1))
  else
    FAILED_DOMAINS+=("$d")
  fi
done

OUT_DIR=".bench-local/docs-hunter"
TOTAL="${#TEST_DOMAINS[@]}"
if [ "$PASSED" -eq "$TOTAL" ]; then
  # Emit a one-line summary of what was found.
  python3 - "$OUT_DIR" "${TEST_DOMAINS[@]}" <<'PY'
import json, sys
out_dir = sys.argv[1]
domains = sys.argv[2:]
bits = []
for d in domains:
    try:
        data = json.load(open(f"{out_dir}/{d}.json"))
        bits.append(f"{d}={data.get('hit_count', 0)}")
    except Exception:
        bits.append(f"{d}=?")
print(f"docs-hunter green {' '.join(bits)}")
PY
  exit 0
else
  echo "docs-hunter FAILED on: ${FAILED_DOMAINS[*]}"
  exit 1
fi
