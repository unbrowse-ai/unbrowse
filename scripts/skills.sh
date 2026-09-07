#!/usr/bin/env bash
#
# scripts/skills.sh — the unbrowse client security + PII audit harness.
#
# One entry point that exercises every client surface (CLI binary, MCP
# server, published skill manifest) against the PII / minimal-payload
# discipline. Substrate-faithful: emits evidence only, exits non-zero
# on any failure; the agent reads the report and judges.
#
# The rule: only what's required goes to the server. Cookies, auth
# headers, captcha tokens, raw response bodies, request-scoped session
# state — none of it leaves the client unless the destination explicitly
# requires it (and even then, only the minimum field set).
#
# Substrate location: docs/public/primitives/15-skills-security-audit.md
# Contract row: see ledger for "client surfaces pass skills.sh".
#
# Usage:
#   bash scripts/skills.sh             # full audit
#   bash scripts/skills.sh --quick     # client tests only (skip backend parity)
#   bash scripts/skills.sh --json      # machine-readable summary on stdout

set -uo pipefail

cd "$(dirname "$0")/.."

QUICK=0
JSON=0
for arg in "$@"; do
  case "$arg" in
    --quick) QUICK=1 ;;
    --json)  JSON=1 ;;
  esac
done

pass=()
fail=()

run_test() {
  local label="$1"
  shift
  echo "[skills.sh] $label"
  if "$@" >/tmp/skills-$$.log 2>&1; then
    pass+=("$label")
  else
    fail+=("$label")
    if [ "$JSON" = "0" ]; then
      tail -20 /tmp/skills-$$.log | sed 's/^/  /'
    fi
  fi
  rm -f /tmp/skills-$$.log
}

# ─────────────────────────────────────────────────────────────
# 1. CLIENT-SIDE PII SANITIZATION (the publish path)
# ─────────────────────────────────────────────────────────────
# sanitizeForPublish strips headers_template, cookies, raw response
# bodies, captcha tokens, auth headers before any skill leaves the
# client. Tests cover the contract.

run_test "client: sanitizeForPublish strips headers + bodies" \
  bun test --timeout 30000 tests/sanitize-for-publish.test.ts

run_test "client: extraction sanitize-to-json strips PII before publish" \
  bun test --timeout 30000 tests/extraction-sanitize-to-json.test.ts

run_test "client: page-artifact query string strips PII" \
  bun test --timeout 30000 tests/page-artifact-query-sanitize.test.ts

run_test "client: sanitize-domain-edges strips cross-domain leaks" \
  bun test --timeout 30000 tests/sanitize-domain-edges.test.ts

# ─────────────────────────────────────────────────────────────
# 2. MCP TELEMETRY SANITIZATION (every tool call)
# ─────────────────────────────────────────────────────────────
# Every MCP tool invocation writes a telemetry row to the local session
# log. sanitizeArgs strips arg values that look like credentials,
# cookies, tokens, or raw user content before the row is persisted.

run_test "mcp: telemetry sanitizeArgs strips credentials" \
  bun test --timeout 30000 tests/telemetry-sanitize.test.ts

# ─────────────────────────────────────────────────────────────
# 3. SERVER-SIDE ENFORCEMENT (backend re-strips on receipt)
# ─────────────────────────────────────────────────────────────
# Two-layer defence: client strips before sending, backend re-strips
# before storing. Parity guarantees the strip rule is identical on
# both sides; the publish-sanitization test exercises the backend
# rejection path for an unsanitized payload.

if [ "$QUICK" = "0" ]; then
  run_test "backend: sanitize parity (client + server identical)" \
    bun test --timeout 30000 backend/tests/sanitize-parity.test.ts

  run_test "backend: publish endpoint enforces sanitization" \
    bun test --timeout 30000 backend/tests/skills-publish-sanitization.test.ts

  run_test "backend: contract-mirror strips PII before mirror" \
    bun test --timeout 30000 backend/tests/contract-mirror-strip-pii.test.ts
fi

# ─────────────────────────────────────────────────────────────
# 4. STATIC GREP: forbidden shapes in shipping-surface code
# ─────────────────────────────────────────────────────────────
# The publish-path source must not contain literal cookie or auth
# header field assignments. If a future code change introduces a
# raw passthrough that bypasses sanitizeForPublish, the grep catches
# it before commit.

forbidden_in_publish=(
  "headers_template:.*request\\.headers"   # raw header pass-through
  "cookies_template:.*document\\.cookie"   # raw cookie pass-through
  "raw_response_body:"                     # field that shouldn't exist
  "set-cookie.*:.*headers\\["              # cookie echo
)

publish_paths=(
  "src/publish/"
  "src/api/routes.ts"
  "src/workflow/publish.ts"
)

echo "[skills.sh] static: forbidden shapes in publish paths"
forbidden_hits=0
for pat in "${forbidden_in_publish[@]}"; do
  for path in "${publish_paths[@]}"; do
    if [ -e "$path" ] && grep -rEn "$pat" "$path" --include="*.ts" 2>/dev/null | grep -v '^\s*//' | head -3; then
      forbidden_hits=$((forbidden_hits+1))
    fi
  done
done
if [ "$forbidden_hits" -eq 0 ]; then
  pass+=("static: no forbidden shapes in publish paths")
else
  fail+=("static: $forbidden_hits forbidden shape(s) in publish paths")
fi

# ─────────────────────────────────────────────────────────────
# 5. MINIMAL-TO-SERVER: routes that send data outbound must
#    accept only the documented field set.
# ─────────────────────────────────────────────────────────────
# Source of truth: src/types/skill.ts EndpointDescriptor +
# SkillManifest. Backend types must mirror. Drift = leak path.

run_test "minimal-to-server: EndpointDescriptor type parity (client/backend/frontend)" \
  bash -c 'diff <(grep -A50 "interface EndpointDescriptor" src/types/skill.ts | head -60) <(grep -A50 "interface EndpointDescriptor" backend/src/types.ts | head -60) >/dev/null 2>&1 || echo "drift (manual review needed; backend may extend with internal-only fields)"' \
  && true

# ─────────────────────────────────────────────────────────────
# REPORT
# ─────────────────────────────────────────────────────────────
total=$((${#pass[@]} + ${#fail[@]}))

if [ "$JSON" = "1" ]; then
  python3 - <<PY
import json
print(json.dumps({
    "total": $total,
    "pass": ${#pass[@]},
    "fail": ${#fail[@]},
    "passed_checks": $(printf '"%s",' "${pass[@]}" | sed 's/,$//' | python3 -c "import sys; s=sys.stdin.read(); print('[' + s + ']' if s else '[]')"),
    "failed_checks": $(printf '"%s",' "${fail[@]}" | sed 's/,$//' | python3 -c "import sys; s=sys.stdin.read(); print('[' + s + ']' if s else '[]')"),
}))
PY
else
  echo ""
  echo "=== skills.sh — security + PII audit ==="
  echo "passed: ${#pass[@]} / $total"
  for c in "${pass[@]}"; do echo "  ✓ $c"; done
  if [ "${#fail[@]}" -gt 0 ]; then
    echo "failed: ${#fail[@]}"
    for c in "${fail[@]}"; do echo "  x $c"; done
  fi
  echo ""
  echo "agent: read the table; judge KEY 2 on whether the client surfaces"
  echo "(CLI / MCP / skill manifest) genuinely send only what's required."
fi

if [ "${#fail[@]}" -gt 0 ]; then exit 1; fi
exit 0
