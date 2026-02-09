#!/usr/bin/env bash
set -uo pipefail

source "${OCT_LIB_DIR}/core.sh"
source "${OCT_LIB_DIR}/config.sh"

setup_title="Unbrowse Plugin Static Validation"

echo "═══════════════════════════════════════════════════════"
echo " $setup_title"
echo "═══════════════════════════════════════════════════════"
echo ""

phase "Environment"
assert "openclaw CLI installed" "$(command -v openclaw &>/dev/null && echo true || echo false)"
assert "Node.js available" "$(command -v node &>/dev/null && echo true || echo false)"
assert "jq available" "$(command -v jq &>/dev/null && echo true || echo false)"

phase "Repo Structure"
assert_file_exists "Manifest exists" "${OCT_PLUGIN_DIR}/openclaw.plugin.json"
assert_file_exists "Entry exists" "${OCT_PLUGIN_DIR}/index.ts"
assert_file_exists "Plugin root exists" "${OCT_PLUGIN_DIR}/src/plugin/plugin.ts"
assert_file_exists "Tools index exists" "${OCT_PLUGIN_DIR}/src/plugin/tools/index.ts"
assert_file_exists "Tool deps contract exists" "${OCT_PLUGIN_DIR}/src/plugin/tools/deps.ts"

phase "Manifest ID"
PLUGIN_ID=$(jq -r '.id' "${OCT_PLUGIN_DIR}/openclaw.plugin.json" 2>/dev/null || echo "INVALID")
assert_eq "Manifest plugin ID" "$PLUGIN_ID" "$OCT_PLUGIN_ID"

source "${OCT_LIB_DIR}/report.sh"
oct_report
exit "$OCT_FAIL"

