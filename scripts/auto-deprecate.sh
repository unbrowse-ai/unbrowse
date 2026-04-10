#!/usr/bin/env bash
# auto-deprecate.sh — deprecate npm versions that fail the benchmark
#
# Reads ~/.unbrowse/benchmark-history.jsonl and finds versions with
# broken behavior (install failure, 0 successes on a non-empty corpus,
# or product success rate below a threshold). For each bad version,
# runs `npm deprecate` with a reason pointing to the latest good release.
#
# Safe by default — prints what it WOULD do and requires --apply to
# actually run npm deprecate.
#
# Usage:
#   bash scripts/auto-deprecate.sh                     # dry-run: show what would be deprecated
#   bash scripts/auto-deprecate.sh --apply             # actually deprecate
#   bash scripts/auto-deprecate.sh --threshold 0.8     # deprecate if rate < 80%
#
set -uo pipefail

APPLY=false
THRESHOLD=0.5   # default: deprecate if < 50% success
PKG="unbrowse"
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=true ;;
    --threshold) shift; THRESHOLD="${1:-0.5}"; shift || true ;;
  esac
done

HISTORY_FILE="${UNBROWSE_BENCHMARK_HISTORY:-$HOME/.unbrowse/benchmark-history.jsonl}"
if [ ! -f "$HISTORY_FILE" ]; then
  echo "[auto-deprecate] no history at $HISTORY_FILE — run benchmark-historical first"
  exit 0
fi

echo "[auto-deprecate] reading $HISTORY_FILE"
echo "[auto-deprecate] threshold: ${THRESHOLD} (versions below this rate get deprecated)"
echo "[auto-deprecate] apply: $APPLY"
echo ""

# Aggregate per-version stats from history
python3 -c "
import json, sys
from collections import defaultdict

by_version = defaultdict(lambda: {'pass':0,'fail':0,'block':0,'upstream':0,'runs':0})
latest_good = None
for line in open('$HISTORY_FILE'):
    try:
        r = json.loads(line)
        v = r.get('version','?')
        by_version[v]['pass'] += r.get('pass', 0)
        by_version[v]['fail'] += r.get('product_fail', 0)
        by_version[v]['block'] += r.get('browser_block', 0)
        by_version[v]['upstream'] += r.get('upstream_kuri', 0)
        by_version[v]['runs'] += 1
    except: pass

# Decide bad versions
bad = []
for v, s in sorted(by_version.items()):
    total_real = s['pass'] + s['fail']
    if total_real == 0 and s['runs'] > 0:
        # Benchmark couldn't get any data — install broken or server broken
        bad.append((v, 'install_or_server_broken', s))
        continue
    if total_real == 0: continue
    rate = s['pass'] / total_real
    if rate < $THRESHOLD:
        bad.append((v, f'low_success_rate_{rate:.1%}', s))

# Find latest working version for the deprecate message
working = [v for v, s in sorted(by_version.items())
           if (s['pass'] + s['fail']) > 0 and s['pass'] / (s['pass'] + s['fail']) >= $THRESHOLD]
latest = working[-1] if working else None

print(f'== per-version from history ==')
for v, s in sorted(by_version.items()):
    total = s['pass'] + s['fail']
    rate = f\"{100*s['pass']/total:.0f}%\" if total > 0 else 'n/a'
    marker = '✗' if any(bv[0] == v for bv in bad) else '✓'
    print(f'  {marker} {v:22} pass={s[\"pass\"]:3} fail={s[\"fail\"]:3} block={s[\"block\"]:3} runs={s[\"runs\"]} rate={rate}')
print()
print(f'latest good version: {latest or \"(none)\"}')
print()
if not bad:
    print('[auto-deprecate] no bad versions to deprecate')
    sys.exit(0)
print(f'[auto-deprecate] would deprecate {len(bad)} version(s):')
for v, reason, s in bad:
    print(f'  npm deprecate ${PKG}@{v} \"{reason} — upgrade to {latest or \"latest\"}\"')
with open('/tmp/auto-deprecate-plan.txt', 'w') as f:
    for v, reason, s in bad:
        msg = f'{reason} — upgrade to {latest or \"latest\"}'
        f.write(f'{v}|{msg}\n')
"

if [ "$APPLY" != "true" ]; then
  echo ""
  echo "[auto-deprecate] dry-run only. Use --apply to execute npm deprecate."
  exit 0
fi

# Apply: actually run npm deprecate
if [ ! -f /tmp/auto-deprecate-plan.txt ]; then
  echo "[auto-deprecate] no plan file — nothing to apply"
  exit 0
fi
while IFS='|' read -r VER MSG; do
  [ -z "$VER" ] && continue
  echo "[auto-deprecate] deprecating $VER: $MSG"
  npm deprecate "${PKG}@${VER}" "$MSG" 2>&1 | tail -3
done < /tmp/auto-deprecate-plan.txt
rm -f /tmp/auto-deprecate-plan.txt
