#!/usr/bin/env bash
# Fail if active user-facing docs still teach legacy build/act/eval/breath CLI prefixes.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
fail=0
log() { echo "$*"; }

# Active surfaces agents/humans install from (not historical benches/plans/archive)
SURFACES=(
  README.md
  SKILL.md
  AGENTS.md
  docs/guides
  docs/sdk
  docs/for-agents
  docs/for-developers
  docs/architecture
  docs/start-here
  docs/agent-internet-layer.md
  docs/THE_FDRY_ECONOMY.md
  packages/skill/README.md
  packages/skill/SKILL.md
  packages/sdk/README.md
  packages/sdk/docs
  packages/pollen-cli/README.md
)

LEGACY_RE='unbrowse (build|act|eval|breath) |`unbrowse (build|act|eval|breath)|npx unbrowse build '

log "== legacy three-verb CLI prefixes in active docs =="
hits=$(rg -n --glob '!**/node_modules/**' -e "$LEGACY_RE" "${SURFACES[@]}" 2>/dev/null || true)
if [ -n "$hits" ]; then
  log "FAIL: legacy prefixes still present:"
  echo "$hits" | head -40 | sed 's/^/  /'
  fail=1
else
  log "  OK: no unbrowse build/act/eval/breath CLI forms in active surfaces"
fi

log "== required flat anchors =="
grep -q 'unbrowse setup' README.md && grep -q 'unbrowse health' README.md && log "  OK: README setup+health" || { log "  FAIL: README"; fail=1; }
grep -qE 'unbrowse (get|resolve|setup|health)' SKILL.md && log "  OK: SKILL flat commands" || { log "  FAIL: SKILL"; fail=1; }
grep -q 'unbrowse setup' packages/skill/README.md && log "  OK: packages/skill README" || { log "  FAIL: packages/skill README"; fail=1; }
# one-call front door present somewhere
if rg -q 'unbrowse ".*" --url|unbrowse get ' README.md SKILL.md packages/skill/README.md docs/guides/quickstart.md 2>/dev/null; then
  log "  OK: one-call front door present"
else
  log "  FAIL: missing unbrowse \"task\" / get front door"
  fail=1
fi

log "== version: install hints prefer @latest or 11.3.x =="
# stale major pins in active install copy (exclude archive)
stale=$(rg -n 'unbrowse@[0-9]+\.[0-9]+\.[0-9]+' README.md SKILL.md packages/skill/README.md docs/guides packages/sdk/docs 2>/dev/null | rg -v '11\.3\.|archive' || true)
if [ -n "$stale" ]; then
  log "  WARN/FAIL stale version pins:"
  echo "$stale" | head -20 | sed 's/^/  /'
  # only fail if not @latest and not 11.3
  fail=1
else
  log "  OK: no pre-11.3 version pins in active install docs"
fi

if [[ "$fail" -ne 0 ]]; then
  log "FLAT-CLI DOCS GATE RED"
  exit 1
fi
log "FLAT-CLI DOCS GATE GREEN"
exit 0
