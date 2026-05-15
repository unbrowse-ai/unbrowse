#!/usr/bin/env bash
# Thin wrapper: record the v6.16.0 baseline's resolve responses for every
# corpus probe into .workbench-baseline/golden/manifest.jsonl ONCE.
#
# After this, set WORKBENCH_BASELINE_MODE=recorded in ~/.claude.json (or the
# workbench mcp.json) so the proxy diffs candidate against the golden file
# instead of spawning a live baseline daemon. Halves per-call wave cost.
#
# Re-run this only when you bump the baseline tag (the golden goes stale
# vs the new baseline binary, not vs the live site — resolve key is
# intent+url, site-independent for the shortlist shape it captures).

set -euo pipefail
cd "$(dirname "$0")/.."

exec bun scripts/workbench-record-baseline.ts "$@"
