#!/usr/bin/env bash
# bench-triage.sh — read raw turbobox bench output, extract per-URL verdicts,
# and surface PRODUCT_FAIL candidates for the agent to fix.
#
# The turbobox-parallel benchmark writes per-URL PROGRESS lines inside a
# larger exec-envelope JSON. This tool parses them out so we can see which
# specific URL + intent combinations failed, which is the input the agent
# needs to generate a fix. Without this, bench history is just totals and
# we don't know what to fix.
#
# Sub-commands:
#   latest                  — triage the most recent result file
#   file PATH               — triage a specific result file
#   rerun-on-remote VER     — pull latest file from a remote turbobox run log
#
# Output: JSON to stdout + a human summary to stderr.
set -uo pipefail

cmd="${1:-latest}"
shift || true

triage_one() {
  local result_file="$1"
  if [ ! -f "$result_file" ]; then
    echo "{\"ok\":false,\"error\":\"file_not_found\",\"path\":\"$result_file\"}"
    return 1
  fi
  python3 - "$result_file" <<'PY'
import json, re, sys
path = sys.argv[1]
raw = open(path).read()

# Step 1: unwrap the turbobox exec envelope {"output":"...\n..."}
try:
    env = json.loads(raw, strict=False)
    text = env.get('output', raw) if isinstance(env, dict) else raw
except Exception:
    text = raw

# Step 2: extract PROGRESS lines. Format (from benchmark-turbobox-parallel.sh):
#   PROGRESS [VER] URL -> VERDICT (total=N pass=N fail=N block=N)
progress = re.findall(
    r'PROGRESS \[([^\]]+)\] (\S+) -> (\w+) \(total=(\d+) pass=(\d+) fail=(\d+) block=(\d+)\)',
    text
)

# Step 3: extract the final totals object
totals = {}
m = list(re.finditer(r'\{[^{}]*"version"[^{}]*\}', text))
if m:
    try:
        totals = json.loads(m[-1].group(0))
    except Exception:
        pass

per_url = []
fails = []
blocks = []
for ver, url, verdict, total, p, f, b in progress:
    row = {'version': ver, 'url': url, 'verdict': verdict}
    per_url.append(row)
    if verdict == 'fail':
        fails.append(row)
    elif verdict == 'block':
        blocks.append(row)

# Step 4: extract FAIL_DETAIL blocks that bench now embeds per-fail.
# Format: FAIL_DETAIL_BEGIN [VER] URL ... FAIL_DETAIL_END
detail_re = re.compile(
    r'FAIL_DETAIL_BEGIN \[[^\]]+\] (\S+)\n(.*?)\nFAIL_DETAIL_END',
    re.DOTALL
)
details = {}
for m in detail_re.finditer(text):
    details[m.group(1)] = m.group(2)

# Try to extract the unbrowse result JSON error code + message per URL
err_re = re.compile(r'"error":"([^"]+)".*?"message":"([^"]+)"')
for row in fails:
    raw = details.get(row['url'], '')
    if raw:
        row['raw'] = raw[-1500:]
        em = err_re.search(raw)
        if em:
            row['error_code'] = em.group(1)
            row['error_message'] = em.group(2)

# Fallback: if FAIL_DETAIL was absent (older bench build), scan preceding lines
lines = text.splitlines()
for i, line in enumerate(lines):
    m2 = re.search(r'PROGRESS \[[^\]]+\] (\S+) -> fail', line)
    if m2:
        url = m2.group(1)
        start = max(0, i-15)
        context = '\n'.join(lines[start:i])
        for row in fails:
            if row['url'] == url and 'raw' not in row:
                row['raw'] = context[:1500]
                break

result = {
    'ok': True,
    'source': path,
    'totals': totals,
    'per_url_count': len(per_url),
    'pass_count': sum(1 for r in per_url if r['verdict'] == 'pass'),
    'fail_count': len(fails),
    'block_count': len(blocks),
    'fails': fails,
    'blocks': blocks,
}

# Human summary to stderr
print(f"── bench triage: {path}", file=sys.stderr)
print(f"   pass  = {result['pass_count']}", file=sys.stderr)
print(f"   fail  = {result['fail_count']}  (PRODUCT — fix these)", file=sys.stderr)
print(f"   block = {result['block_count']}  (BROWSER — out of scope)", file=sys.stderr)
if fails:
    print(f"\n   FAILING URLs:", file=sys.stderr)
    for r in fails:
        print(f"     ✗ {r['url']}", file=sys.stderr)
        if r.get('error_code'):
            print(f"       error: {r['error_code']} — {r.get('error_message','')[:120]}", file=sys.stderr)
        elif r.get('raw'):
            hint_lines = [ln for ln in r['raw'].splitlines()
                          if re.search(r'error|fail|timeout|kuri|refused|ECONN|no_endpoints|cloudflare|low_quality', ln, re.I)]
            if hint_lines:
                print(f"       hint: {hint_lines[-1][:120]}", file=sys.stderr)
if blocks:
    print(f"\n   BLOCKED URLs (not counted against coverage):", file=sys.stderr)
    for r in blocks:
        print(f"     · {r['url']}", file=sys.stderr)

print(json.dumps(result, indent=2))
PY
}

case "$cmd" in
  latest)
    # Find most recent result file anywhere under /tmp (turbobox-parallel writes to mktemp -d)
    latest=$(find /tmp /var/folders -maxdepth 4 -name '3.*.json' -path '*tmp*' 2>/dev/null | xargs ls -t 2>/dev/null | head -1)
    if [ -z "$latest" ]; then
      echo '{"ok":false,"error":"no_recent_result_files","hint":"pass a path: bench-triage.sh file /path"}'
      exit 1
    fi
    triage_one "$latest"
    ;;
  file)
    triage_one "$1"
    ;;
  *)
    echo "usage: bash scripts/bench-triage.sh [latest|file PATH]"
    exit 1
    ;;
esac
