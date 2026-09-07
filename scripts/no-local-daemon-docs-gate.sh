#!/usr/bin/env bash
# Fail if agent-facing docs still present localhost:6969 as the default runtime.
# Allowed: optional serve, stale-daemon warnings, "do not probe", tests that prove no bind.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
fail=0
log() { echo "$*"; }

SURFACES=(
  README.md
  SKILL.md
  openapi.yaml
  docs/architecture/CLI.md
  docs/whitepaper/system-today.md
  docs/sdk/onboarding-validators.md
  packages/sdk/README.md
  packages/sdk/docs/README.md
  packages/sdk/docs/getting-started/installation.md
)

# Banned phrases: claim 6969 is the default core path
BANNED=(
  'Local server** (`localhost:6969`)'
  'defaulting to `http://localhost:6969`'
  'auto-starts on demand on `http://localhost:6969`'
  'auto-starts on demand at `http://localhost:6969`'
  'Wraps `http://localhost:6969`'
  'probes `127.0.0.1:6969`, connects if a daemon is alive'
  'Local Server** (`http://localhost:6969`)'
)

log "== banned default-daemon claims =="
for f in "${SURFACES[@]}"; do
  [ -f "$f" ] || continue
  for p in "${BANNED[@]}"; do
    if grep -Fq "$p" "$f" 2>/dev/null; then
      log "  FAIL: $f still contains: $p"
      fail=1
    fi
  done
done

log "== required: in-process / stateless narrative =="
grep -qiE 'in-process|stateless' README.md SKILL.md || { log "  FAIL: README/SKILL missing in-process narrative"; fail=1; }
grep -qiE 'in-process|stateless|no.*daemon' packages/sdk/README.md || { log "  FAIL: sdk README still daemon-first"; fail=1; }

log "== openapi servers: beta-api first =="
# first server url should be beta-api
python3 - <<'PY' || fail=1
import re,sys
t=open("openapi.yaml").read()
m=re.search(r"servers:\n((?:  - .*\n(?:    .*\n)*)+)", t)
if not m:
  print("  FAIL: no servers block"); sys.exit(1)
block=m.group(1)
urls=re.findall(r"url:\s*(\S+)", block)
print("  servers:", urls)
if not urls or "beta-api.unbrowse.ai" not in urls[0]:
  print("  FAIL: beta-api should be first server"); sys.exit(1)
print("  OK: beta-api first")
sys.exit(0)
PY

if [[ "$fail" -ne 0 ]]; then
  log "NO-DAEMON DOCS GATE RED"
  exit 1
fi
log "NO-DAEMON DOCS GATE GREEN"
exit 0
