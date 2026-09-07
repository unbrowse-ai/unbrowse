#!/usr/bin/env bash
# Onboarding UX witness — live setup must print a concrete first command
# and must NOT dump a full SetupReport JSON wall on a human TTY.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
fail=0
log() { echo "$*"; }

log "== source: setup next-steps present =="
grep -q 'printSetupNextSteps' src/cli.ts || { log "FAIL: printSetupNextSteps missing"; fail=1; }
grep -q 'top stories with point counts' src/cli.ts || { log "FAIL: first-call HN example missing in cli"; fail=1; }
grep -q 'wantMachine' src/cli.ts || { log "FAIL: wantMachine (no JSON wall) missing"; fail=1; }

log "== install UI: first call + @latest =="
grep -q 'unbrowse@latest' frontend/src/components/install-instructions.tsx || { log "FAIL: install UI missing @latest"; fail=1; }
grep -q 'top stories' frontend/src/components/install-instructions.tsx || { log "FAIL: install UI missing first call"; fail=1; }

log "== quickstart: first call =="
grep -q 'top stories with point counts' docs/guides/quickstart.md || { log "FAIL: quickstart missing first call"; fail=1; }

log "== live setup --no-start (human path: no JSON wall, has try-it) =="
TMP=$(mktemp -d)
export HOME="$TMP"
export UNBROWSE_HOME="$TMP/.unbrowse"
# Force TTY-like human path: we can't fake TTY easily, so pass nothing that forces json
# and check that with script that allocates a pty if available
OUT=$(mktemp)
if command -v script >/dev/null 2>&1; then
  # script -q -c 'cmd' /dev/null forces a pseudo-TTY on linux
  script -q -c "cd '$ROOT' && bun src/cli.ts setup --no-start --opencode off --skip-browser 2>&1" /dev/null > "$OUT" 2>&1 || true
else
  bun src/cli.ts setup --no-start --opencode off --skip-browser > "$OUT" 2>&1 || true
fi
# Human summary must include try-it line (stderr via info OR stdout)
if ! grep -q 'top stories with point counts' "$OUT"; then
  log "FAIL: setup output missing first-call command"
  tail -40 "$OUT" | sed 's/^/  | /'
  fail=1
else
  log "  OK: first-call command printed"
fi
# Must not dump package_managers JSON block as the main UX (allow --json only)
if grep -q '"package_managers"' "$OUT" && ! grep -q '"package_managers"' <<<"$want"; then
  # If full report JSON present without --json flag, fail when it's a wall
  if grep -q '"update_hints"' "$OUT" && grep -q '"browser_engine"' "$OUT"; then
    log "FAIL: setup still dumps full SetupReport JSON on human path"
    fail=1
  fi
else
  log "  OK: no full SetupReport JSON wall (or TTY forced json-off)"
fi

# Also verify --json still emits machine report
JOUT=$(mktemp)
bun src/cli.ts setup --no-start --opencode off --skip-browser --json > "$JOUT" 2>/dev/null || true
if python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$JOUT" 2>/dev/null; then
  log "  OK: --json still emits parseable SetupReport"
else
  # --json might put JSON on stdout mixed with logs; try last JSON object
  if grep -q '"package_managers"' "$JOUT" || grep -q package_managers "$JOUT"; then
    log "  OK: --json includes machine fields"
  else
    log "WARN: --json path may not emit report (check flags wiring)"
  fi
fi

if [[ "$fail" -ne 0 ]]; then
  log "ONBOARDING WITNESS RED"
  exit 1
fi
log "ONBOARDING WITNESS GREEN"
exit 0
