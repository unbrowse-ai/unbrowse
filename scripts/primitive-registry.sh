#!/usr/bin/env bash
# primitive-registry.sh — meta-primitive that introspects all harness primitives
#
# Tracks every primitive I've built, what it does, what silent failure
# it catches, and whether it still runs cleanly. Helps detect when a
# primitive itself has drifted or rotted.
#
# Usage:
#   bash scripts/primitive-registry.sh          # list all primitives with status
#   bash scripts/primitive-registry.sh --run    # run a --check pass on each
#   bash scripts/primitive-registry.sh --json   # machine-readable
#
set -uo pipefail

MODE="list"
for arg in "$@"; do
  case "$arg" in
    --run) MODE="run" ;;
    --json) MODE="json" ;;
  esac
done

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# The registry — name, script, purpose, silent-failure-caught
declare -a PRIMITIVES=(
  "coverage-harness|scripts/coverage-harness.sh|aggregate live trace logs into coverage report|test fixture traces leaking into prod telemetry"
  "dogfood-loop|scripts/dogfood-loop.sh|sample real (intent,url) pairs from traces and re-run|synthetic test sets drift from real usage"
  "agent-experience-test|scripts/agent-experience-test.sh|collect agent workflow artifacts for agent review|grep-based asserts miss semantic failures"
  "drop-in-onboarding-test|scripts/drop-in-onboarding-test.sh|simulate fresh agent from zero|assumes pre-installed state"
  "npm-dist-tag-sync|scripts/npm-dist-tag-sync.sh|detect and fix drift in npm dist-tags|@preview dist-tag stuck on old version"
  "npm-install-integrity|scripts/npm-install-integrity.sh|verify npm install symlinks/versions are consistent|stale symlinks in ~/.npm-global/bin after re-install"
  "release-with-visibility|scripts/release-with-visibility.sh|wrap release-it with forced stdout capture|release-it dying silently in background shells"
  "release-and-verify|scripts/release-and-verify.sh|full release pipeline with remote blank-slate smoke|release works locally, fails on fresh install"
  "leak-guard|scripts/leak-guard.sh|prevent operational primitives from leaking to public paths|sensitive harness names appearing in SKILL.md, npm tarball, or public mirror"
)

check_primitive() {
  local entry="$1"
  local name=$(echo "$entry" | cut -d'|' -f1)
  local script=$(echo "$entry" | cut -d'|' -f2)
  local purpose=$(echo "$entry" | cut -d'|' -f3)
  local catches=$(echo "$entry" | cut -d'|' -f4)

  local status="OK"
  local detail=""

  # 1. Does the script exist?
  if [ ! -f "$script" ]; then
    status="MISSING"
    detail="file not found"
  elif [ ! -x "$script" ]; then
    status="NOT_EXEC"
    detail="not executable"
  else
    # 2. Does it respond to --help or at least not crash on --check?
    local lines
    lines=$(wc -l < "$script" 2>/dev/null || echo "0")
    detail="${lines} lines"
    # 3. git history — when was it last touched?
    local last_commit
    last_commit=$(git log -1 --format='%ar' -- "$script" 2>/dev/null || echo "untracked")
    detail="$detail, last commit: $last_commit"
  fi

  printf '  %-28s %-10s  %s\n' "$name" "$status" "$detail"
  echo "    purpose: $purpose"
  echo "    catches: $catches"
}

case "$MODE" in
  list)
    echo "[registry] harness primitives (${#PRIMITIVES[@]} registered):"
    echo ""
    for p in "${PRIMITIVES[@]}"; do
      check_primitive "$p"
      echo ""
    done
    ;;
  run)
    echo "[registry] running each primitive in --check mode..."
    echo ""
    PASS=0; FAIL=0
    for p in "${PRIMITIVES[@]}"; do
      name=$(echo "$p" | cut -d'|' -f1)
      script=$(echo "$p" | cut -d'|' -f2)
      if [ -x "$script" ]; then
        echo "[registry] running $name --check..."
        if "$script" --check >/dev/null 2>&1; then
          echo "  ✓ $name"
          PASS=$((PASS + 1))
        else
          echo "  ✗ $name (no --check support or failed)"
          FAIL=$((FAIL + 1))
        fi
      else
        echo "  ✗ $name (missing)"
        FAIL=$((FAIL + 1))
      fi
    done
    echo ""
    echo "[registry] $PASS pass, $FAIL fail"
    ;;
  json)
    python3 -c "
import json
primitives = []
entries = '''
${PRIMITIVES[@]}
'''.strip().split()
# Rejoin — bash array expansion broke it; use the newline-delimited set below
import os, subprocess
ROOT = os.environ.get('ROOT_DIR', os.getcwd())
items = [
    ('coverage-harness','scripts/coverage-harness.sh','aggregate live trace logs','test fixture traces leaking'),
    ('dogfood-loop','scripts/dogfood-loop.sh','real (intent,url) pairs from traces','synthetic test sets drift'),
    ('agent-experience-test','scripts/agent-experience-test.sh','collect agent workflow artifacts','grep-based asserts miss semantic failures'),
    ('drop-in-onboarding-test','scripts/drop-in-onboarding-test.sh','fresh agent from zero','assumes pre-installed state'),
    ('npm-dist-tag-sync','scripts/npm-dist-tag-sync.sh','detect+fix dist-tag drift','preview tag stuck on old version'),
    ('npm-install-integrity','scripts/npm-install-integrity.sh','verify install consistency','stale symlinks after re-install'),
    ('release-with-visibility','scripts/release-with-visibility.sh','wrap release-it with observability','release-it dying silently'),
    ('release-and-verify','scripts/release-and-verify.sh','full release + remote blank-slate smoke','works locally fails on fresh install'),
]
out = []
for name, script, purpose, catches in items:
    path = os.path.join(ROOT, script)
    exists = os.path.exists(path)
    lines = 0
    if exists:
        try: lines = sum(1 for _ in open(path))
        except: pass
    try:
        last = subprocess.run(['git','log','-1','--format=%ar','--', script], capture_output=True, text=True).stdout.strip()
    except: last = ''
    out.append({
        'name': name,
        'script': script,
        'exists': exists,
        'executable': os.access(path, os.X_OK) if exists else False,
        'lines': lines,
        'purpose': purpose,
        'catches': catches,
        'last_commit': last,
    })
print(json.dumps({'primitives': out, 'total': len(out)}, indent=2))
"
    ;;
esac
