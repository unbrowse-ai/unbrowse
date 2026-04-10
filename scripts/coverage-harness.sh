#!/usr/bin/env bash
# coverage-harness.sh — aggregate live unbrowse trace logs into coverage report
#
# No curated test cases. No harvested URLs. The primitive being used IS the eval.
# Reads ~/.unbrowse/traces/ which is every real resolve/execute Lewis has run.
#
# Usage:
#   bash scripts/coverage-harness.sh                   # local traces
#   bash scripts/coverage-harness.sh --remote HOST     # remote traces
#   bash scripts/coverage-harness.sh --since YYYY-MM-DD
#
set -uo pipefail

REMOTE=""
SINCE=""
for arg in "$@"; do
  case "$arg" in
    --remote) shift; REMOTE="${1:-}"; shift || true ;;
    --since) shift; SINCE="${1:-}"; shift || true ;;
  esac
done

if [ -n "$REMOTE" ]; then
  exec ssh -o ConnectTimeout=10 "$REMOTE" "SINCE='$SINCE' bash -s" < "$0"
fi

# ── Running on target host ──
TRACES_DIR="$HOME/.unbrowse/traces"
if [ ! -d "$TRACES_DIR" ]; then
  echo '{"error":"no_traces_dir","path":"'"$TRACES_DIR"'"}'
  exit 0
fi

SINCE="${SINCE:-}"
python3 -c "
import os, glob, json, sys
from collections import Counter, defaultdict

traces_dir = '$TRACES_DIR'
since = '$SINCE'
all_files = sorted(glob.glob(os.path.join(traces_dir, '*.json')))
if since:
    all_files = [f for f in all_files if os.path.basename(f) >= since]

success = [f for f in all_files if 'success' in os.path.basename(f)]
failure = [f for f in all_files if 'failure' in os.path.basename(f)]

# Sample parse of some files to understand failure modes
failure_reasons = Counter()
success_domains = Counter()
failure_domains = Counter()
goals = Counter()
for f in failure[-500:]:
    try:
        with open(f) as fh: d = json.load(fh)
        reason = d.get('failure_reason') or d.get('error') or d.get('result',{}).get('error') or 'unknown'
        failure_reasons[reason] += 1
        domain = d.get('domain') or 'unknown'
        failure_domains[domain] += 1
    except: pass

for f in success[-500:]:
    try:
        with open(f) as fh: d = json.load(fh)
        domain = d.get('domain') or 'unknown'
        success_domains[domain] += 1
        goal = d.get('goal') or ''
        if goal: goals[goal] += 1
    except: pass

report = {
    'traces_dir': traces_dir,
    'since': since or 'all time',
    'total_attempts': len(all_files),
    'success_count': len(success),
    'failure_count': len(failure),
    'success_rate': round(100 * len(success) / max(len(all_files), 1), 1),
    'top_failure_reasons': failure_reasons.most_common(15),
    'top_success_domains': success_domains.most_common(15),
    'top_failure_domains': failure_domains.most_common(15),
    'top_goals': goals.most_common(10),
    'unique_domains_success': len(success_domains),
    'unique_domains_failure': len(failure_domains),
}
print(json.dumps(report, indent=2))
"
