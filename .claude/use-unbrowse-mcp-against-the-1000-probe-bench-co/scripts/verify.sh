#!/bin/bash
# verify.sh — bench-mcp-safety harness. 6-phase verify:
#   1. Chrome cookie DB baseline (read-only sha)
#   2. MCP probe sweep (10 probes, lane mix)
#   3. Chrome cookie DB integrity check (P0 safety gate)
#   4. Artifact leak grep (no decrypted cookies in logs)
#   5. Cross-domain cookie isolation (auth-cookies probe)
#   6. Latency summary
#
# Harness collects RAW evidence per phase; agent judges in-thread by reading
# ledgers/lanes.jsonl. No baked verdicts.
#
# HARD safety requirement: this harness MUST NEVER write to or lock the
# Chrome cookie DB. All cookie-DB ops are sha / size / mtime / stat-only.

set -uo pipefail
cd "${PROJECT_ROOT:-$(dirname "$0")/../../..}"
export PROJECT_ROOT="$(pwd)"
export PLAN=use-unbrowse-mcp-against-the-1000-probe-bench-co
# Allow caller to override SCAFFOLD (so we can invoke the script from /tmp to
# avoid peer-codex `pkill -f 'unbrowse|kuri'` matches against our path).
if [ -z "${SCAFFOLD:-}" ]; then
  export SCAFFOLD="$(cd "$(dirname "$0")/.." && pwd)"
fi
export LEDGER="${LEDGER:-$SCAFFOLD/ledgers/lanes.jsonl}"
export LOGS_DIR="${LOGS_DIR:-$SCAFFOLD/logs}"
export LOGS_DIR="$SCAFFOLD/logs"
mkdir -p "$SCAFFOLD/ledgers" "$LOGS_DIR"

TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
export RUN_TS="$TS"

echo "[verify:$PLAN] $TS — 6-phase bench-mcp-safety run"
echo "[verify:$PLAN] ledger=$LEDGER"

VERIFY_RC=0

# Emit-via-env-and-python helper. ROW_JSON_VARS holds the variables to encode.
# Uses os.environ so commas/quotes in shell don't get split.
emit_row() {
  # Expects exported env vars; writes a JSON row to $LEDGER from $ROW_KEYS_JSON
  python3 - <<'PYEMIT'
import json, os, sys
keys = json.loads(os.environ.get('ROW_KEYS_JSON', '[]'))
ledger = os.environ['LEDGER']
row = {}
for k in keys:
    v = os.environ.get('ROW_' + k.upper(), '')
    # Try int / float promotion
    if v == '':
        row[k] = ''
        continue
    try:
        if '.' in v:
            row[k] = float(v)
        else:
            row[k] = int(v)
    except ValueError:
        row[k] = v
line = json.dumps(row)
with open(ledger, 'a') as f:
    f.write(line + '\n')
print('  [lanes.jsonl] ' + line)
PYEMIT
}

###############################################################################
# PHASE 1 — Chrome cookie DB baseline (READ-ONLY)
###############################################################################
echo ""
echo "[verify:$PLAN] PHASE 1: Chrome cookie DB baseline (read-only)"
COOKIE_DB="$HOME/Library/Application Support/Google/Chrome/Default/Cookies"
COOKIE_PRE_SHA=""
COOKIE_PRE_SIZE="0"
COOKIE_PRE_MTIME="0"
if [ -f "$COOKIE_DB" ]; then
  COOKIE_PRE_SHA=$(shasum "$COOKIE_DB" 2>/dev/null | awk '{print $1}')
  COOKIE_PRE_SIZE=$(stat -f%z "$COOKIE_DB" 2>/dev/null || echo 0)
  COOKIE_PRE_MTIME=$(stat -f%m "$COOKIE_DB" 2>/dev/null || echo 0)
  ROW_KEYS_JSON='["phase","ts","status","sha","size","mtime","path"]'
  ROW_PHASE="cookie_baseline" ROW_TS="$TS" ROW_STATUS="OBSERVED" \
    ROW_SHA="$COOKIE_PRE_SHA" ROW_SIZE="$COOKIE_PRE_SIZE" ROW_MTIME="$COOKIE_PRE_MTIME" \
    ROW_PATH="$COOKIE_DB" ROW_KEYS_JSON="$ROW_KEYS_JSON" emit_row
else
  ROW_KEYS_JSON='["phase","ts","status","path"]'
  ROW_PHASE="cookie_baseline" ROW_TS="$TS" ROW_STATUS="NO_CHROME_DB" \
    ROW_PATH="$COOKIE_DB" ROW_KEYS_JSON="$ROW_KEYS_JSON" emit_row
fi
export COOKIE_PRE_SHA COOKIE_PRE_SIZE COOKIE_PRE_MTIME COOKIE_DB

###############################################################################
# PHASE 2 — MCP probe sweep (10 probes, lane mix)
###############################################################################
echo ""
echo "[verify:$PLAN] PHASE 2: MCP probe sweep (10 probes)"
SMOKE_CORPUS="$SCAFFOLD/references/smoke-corpus.txt"
if [ ! -f "$SMOKE_CORPUS" ]; then
  ROW_KEYS_JSON='["phase","ts","status","reason","path"]'
  ROW_PHASE="mcp_probe_sweep" ROW_TS="$TS" ROW_STATUS="FAIL" \
    ROW_REASON="smoke corpus missing" ROW_PATH="$SMOKE_CORPUS" \
    ROW_KEYS_JSON="$ROW_KEYS_JSON" emit_row
  VERIFY_RC=1
else
  BENCH_T0=$(date +%s)
  set +e
  # Copy isolated bench to /tmp so peer's `pkill -9 -f 'unbrowse|kuri'` doesn't
  # match our script path (the scaffold dir name contains "unbrowse").
  cp "$SCAFFOLD/scripts/bench-local-isolated.sh" /tmp/safety-bench-isolated.sh
  chmod +x /tmp/safety-bench-isolated.sh
  BENCH_OUT_DIR="$SCAFFOLD/bench-out" bash /tmp/safety-bench-isolated.sh --use-source --corpus-file "$SMOKE_CORPUS" --timeout 90 > "$LOGS_DIR/bench-sweep.log" 2>&1
  BENCH_RC=$?
  set -e
  BENCH_T1=$(date +%s)
  BENCH_ELAPSED=$((BENCH_T1 - BENCH_T0))

  echo "  [phase2] bench-local rc=$BENCH_RC elapsed=${BENCH_ELAPSED}s"

  if [ -f "$SCAFFOLD/bench-out/results.jsonl" ]; then
    LEDGER="$LEDGER" RUN_TS="$TS" python3 - <<'PYPHASE2'
import json, os
ledger = os.environ['LEDGER']
ts = os.environ['RUN_TS']
rows_emitted = 0
with open(os.environ['SCAFFOLD'] + '/bench-out/results.jsonl') as fh:
    for ln in fh:
        ln = ln.strip()
        if not ln:
            continue
        try:
            r = json.loads(ln)
        except Exception:
            continue
        impact = r.get('impact') if isinstance(r.get('impact'), dict) else {}
        probe_row = {
            'phase': 'mcp_probe_sweep',
            'ts': ts,
            'lane': r.get('lane', ''),
            'goal': (r.get('goal', '') or '')[:120],
            'url': r.get('url', ''),
            'source': r.get('source', ''),
            'verdict': r.get('verdict', ''),
            'n_operations': r.get('n_operations', 0),
            'trace_success': r.get('trace_success'),
            'error_code': r.get('error_code', ''),
            'response_token_hit_rate': r.get('response_token_hit_rate'),
            'intent_action_class': r.get('intent_action_class', ''),
            'browser_block_signals': r.get('browser_block_signals'),
            'actual_total_ms': impact.get('actual_total_ms') if impact else r.get('actual_total_ms'),
        }
        with open(ledger, 'a') as f:
            f.write(json.dumps(probe_row) + '\n')
        rows_emitted += 1
print(f"  [phase2] emitted {rows_emitted} probe rows to lanes.jsonl")
PYPHASE2
    ROW_KEYS_JSON='["phase","ts","bench_rc","wall_clock_seconds","results_path"]'
    ROW_PHASE="mcp_probe_sweep_summary" ROW_TS="$TS" \
      ROW_BENCH_RC="$BENCH_RC" ROW_WALL_CLOCK_SECONDS="$BENCH_ELAPSED" \
      ROW_RESULTS_PATH="$SCAFFOLD/bench-out/results.jsonl" \
      ROW_KEYS_JSON="$ROW_KEYS_JSON" emit_row
  else
    ROW_KEYS_JSON='["phase","ts","status","reason","bench_rc"]'
    ROW_PHASE="mcp_probe_sweep" ROW_TS="$TS" ROW_STATUS="FAIL" \
      ROW_REASON="bench-local produced no results.jsonl" ROW_BENCH_RC="$BENCH_RC" \
      ROW_KEYS_JSON="$ROW_KEYS_JSON" emit_row
    VERIFY_RC=1
  fi
fi

###############################################################################
# PHASE 3 — Chrome cookie DB integrity (P0 SAFETY GATE)
###############################################################################
echo ""
echo "[verify:$PLAN] PHASE 3: Chrome cookie DB integrity (P0)"
if [ -f "$COOKIE_DB" ] && [ -n "$COOKIE_PRE_SHA" ]; then
  COOKIE_POST_SHA=$(shasum "$COOKIE_DB" 2>/dev/null | awk '{print $1}')
  COOKIE_POST_SIZE=$(stat -f%z "$COOKIE_DB" 2>/dev/null || echo 0)
  COOKIE_POST_MTIME=$(stat -f%m "$COOKIE_DB" 2>/dev/null || echo 0)
  if [ "$COOKIE_POST_SHA" != "$COOKIE_PRE_SHA" ]; then
    ROW_KEYS_JSON='["phase","ts","status","severity","reason","sha_pre","sha_post","size_pre","size_post"]'
    ROW_PHASE="cookie_integrity" ROW_TS="$TS" ROW_STATUS="FAIL" ROW_SEVERITY="P0" \
      ROW_REASON="chrome cookie DB sha changed during bench" \
      ROW_SHA_PRE="$COOKIE_PRE_SHA" ROW_SHA_POST="$COOKIE_POST_SHA" \
      ROW_SIZE_PRE="$COOKIE_PRE_SIZE" ROW_SIZE_POST="$COOKIE_POST_SIZE" \
      ROW_KEYS_JSON="$ROW_KEYS_JSON" emit_row
    VERIFY_RC=1
  elif [ "$COOKIE_POST_MTIME" != "$COOKIE_PRE_MTIME" ]; then
    ROW_KEYS_JSON='["phase","ts","status","reason","mtime_pre","mtime_post","sha"]'
    ROW_PHASE="cookie_integrity" ROW_TS="$TS" ROW_STATUS="WARN" \
      ROW_REASON="mtime changed but sha matches" \
      ROW_MTIME_PRE="$COOKIE_PRE_MTIME" ROW_MTIME_POST="$COOKIE_POST_MTIME" \
      ROW_SHA="$COOKIE_POST_SHA" ROW_KEYS_JSON="$ROW_KEYS_JSON" emit_row
  else
    ROW_KEYS_JSON='["phase","ts","status","sha","size"]'
    ROW_PHASE="cookie_integrity" ROW_TS="$TS" ROW_STATUS="PASS" \
      ROW_SHA="$COOKIE_POST_SHA" ROW_SIZE="$COOKIE_POST_SIZE" \
      ROW_KEYS_JSON="$ROW_KEYS_JSON" emit_row
  fi
else
  ROW_KEYS_JSON='["phase","ts","status","reason"]'
  ROW_PHASE="cookie_integrity" ROW_TS="$TS" ROW_STATUS="SKIPPED" \
    ROW_REASON="no baseline (no Chrome DB)" \
    ROW_KEYS_JSON="$ROW_KEYS_JSON" emit_row
fi

###############################################################################
# PHASE 4 — Artifact leak grep
###############################################################################
echo ""
echo "[verify:$PLAN] PHASE 4: Artifact leak grep"
LEDGER="$LEDGER" RUN_TS="$TS" python3 - <<'PYPHASE4'
import json, os, re, glob
ledger = os.environ['LEDGER']
ts = os.environ['RUN_TS']

SENSITIVE_NAMES = [
    'JSESSIONID', '__Secure-', '__Host-', 'PHPSESSID', '_session_id',
    'auth_token', 'access_token', 'id_token', 'csrf', 'XSRF',
    'connect.sid',
]
PATTERNS = [
    (re.compile(r'Set-Cookie:\s*[^\s;]+', re.I), 'set_cookie_header'),
    (re.compile(r'Authorization:\s*Bearer\s+[A-Za-z0-9._\-]{16,}', re.I), 'bearer_token'),
    (re.compile(r'\bcookie:\s*[A-Za-z0-9_\-]+=[^\s;]{16,}', re.I), 'cookie_header_value'),
]
for name in SENSITIVE_NAMES:
    PATTERNS.append((re.compile(re.escape(name) + r'\s*=\s*[A-Za-z0-9._\-]{8,}'), f'sensitive_name:{name}'))

scan_paths = []
bench_out = os.environ['SCAFFOLD'] + '/bench-out'
for pat in [bench_out + '/*.out', bench_out + '/*.jsonl', bench_out + '/*.log']:
    scan_paths.extend(glob.glob(pat))

hits = []
hits_by_key = {}
for path in scan_paths:
    try:
        with open(path, 'r', errors='replace') as fh:
            for lineno, line in enumerate(fh, 1):
                for rx, tag in PATTERNS:
                    m = rx.search(line)
                    if m:
                        key = (path, tag)
                        if hits_by_key.get(key, 0) >= 3:
                            continue
                        excerpt = line[max(0, m.start() - 10):m.end() + 10][:120].strip()
                        hits.append({
                            'file': path,
                            'lineno': lineno,
                            'pattern': tag,
                            'excerpt': excerpt,
                        })
                        hits_by_key[key] = hits_by_key.get(key, 0) + 1
    except Exception:
        continue

for h in hits[:100]:
    row = {
        'phase': 'artifact_leak_grep',
        'ts': ts,
        'file': h['file'],
        'lineno': h['lineno'],
        'pattern': h['pattern'],
        'excerpt': h['excerpt'],
        'classification': 'UNCLEAR',
    }
    with open(ledger, 'a') as f:
        f.write(json.dumps(row) + '\n')

summary = {
    'phase': 'leak_summary',
    'ts': ts,
    'total_hits': len(hits),
    'files_scanned': len(scan_paths),
    'patterns_checked': len(PATTERNS),
}
with open(ledger, 'a') as f:
    f.write(json.dumps(summary) + '\n')
print(f"  [phase4] {len(hits)} potential leaks in {len(scan_paths)} files (classification: UNCLEAR — agent judges)")
PYPHASE4

###############################################################################
# PHASE 5 — Cross-domain cookie isolation (auth-cookies probe)
###############################################################################
echo ""
echo "[verify:$PLAN] PHASE 5: Cross-domain cookie isolation"
LEDGER="$LEDGER" RUN_TS="$TS" python3 - <<'PYPHASE5'
import json, os, re, glob
ledger = os.environ['LEDGER']
ts = os.environ['RUN_TS']

bench_out = os.environ['SCAFFOLD'] + '/bench-out'
out_files = glob.glob(bench_out + '/*linear*')
if not out_files:
    out_files = glob.glob(bench_out + '/*notion*')

if not out_files:
    row = {
        'phase': 'cross_domain_isolation',
        'ts': ts,
        'status': 'SKIPPED',
        'reason': 'no auth-cookies probe artifact found',
    }
    with open(ledger, 'a') as f:
        f.write(json.dumps(row) + '\n')
    print("  [phase5] skipped — no auth-cookies artifact")
else:
    artifact = out_files[0]
    try:
        with open(artifact, 'r', errors='replace') as fh:
            txt = fh.read()
    except Exception:
        txt = ''

    hosts = set()
    for m in re.finditer(r'https?://([^/\s\"\\\'`<>]+)', txt):
        h = m.group(1).lower().split(':')[0]
        if h:
            hosts.add(h)

    expected = {'linear.app', 'www.linear.app'}
    benign = {'localhost', '127.0.0.1', 'unbrowse.ai', 'beta-api.unbrowse.ai',
              'api.unbrowse.ai', 'launch.unbrowse.ai',
              'github.com', 'fonts.googleapis.com', 'fonts.gstatic.com',
              'www.google.com', 'www.googletagmanager.com',
              'www.google-analytics.com', 'analytics.google.com',
              'cdn.segment.com', 'api.segment.io',
              'cdn.linear.app', 'static.linear.app', 'usercontent.linear.app',
              'js.intercomcdn.com', 'intercom.io', 'api-iam.intercom.io',
              'sentry.io', 'o1.ingest.sentry.io',
              'cloudflareinsights.com', 'static.cloudflareinsights.com',
              'beacon.cloudflareinsights.com',
              'collector.github.com', 'arxiv.org'}
    unexpected = sorted([h for h in hosts if h not in expected and h not in benign
                         and 'linear.app' not in h])

    row = {
        'phase': 'cross_domain_isolation',
        'ts': ts,
        'artifact': artifact,
        'hosts_touched': sorted(hosts),
        'expected_hosts': sorted(expected),
        'unexpected_hosts': unexpected,
        'status': 'CLEAN' if not unexpected else 'NEEDS_REVIEW',
    }
    with open(ledger, 'a') as f:
        f.write(json.dumps(row) + '\n')
    print(f"  [phase5] hosts_touched={len(hosts)}  unexpected={len(unexpected)}  status={row['status']}")
PYPHASE5

###############################################################################
# PHASE 6 — Latency summary
###############################################################################
echo ""
echo "[verify:$PLAN] PHASE 6: Latency summary"
LEDGER="$LEDGER" RUN_TS="$TS" python3 - <<'PYPHASE6'
import json, os, statistics
ledger = os.environ['LEDGER']
ts = os.environ['RUN_TS']
path = os.environ['SCAFFOLD'] + '/bench-out/results.jsonl'
if not os.path.exists(path):
    row = {'phase': 'latency_summary', 'ts': ts, 'status': 'NO_DATA'}
    with open(ledger, 'a') as f:
        f.write(json.dumps(row) + '\n')
    print("  [phase6] no results.jsonl")
else:
    lats = []
    by_lane = {}
    for ln in open(path):
        ln = ln.strip()
        if not ln:
            continue
        try:
            r = json.loads(ln)
        except Exception:
            continue
        impact = r.get('impact') or {}
        ms = impact.get('actual_total_ms') if isinstance(impact, dict) else None
        if ms is None:
            ms = r.get('actual_total_ms')
        if isinstance(ms, (int, float)) and ms > 0:
            lats.append(ms)
            lane = r.get('lane', 'unknown')
            by_lane.setdefault(lane, []).append(ms)

    def pct(xs, p):
        if not xs:
            return None
        s = sorted(xs)
        idx = max(0, min(len(s) - 1, int(p * len(s))))
        return s[idx]

    summary = {
        'phase': 'latency_summary',
        'ts': ts,
        'n': len(lats),
        'p50_ms': statistics.median(lats) if lats else None,
        'p95_ms': pct(lats, 0.95),
        'p99_ms': pct(lats, 0.99),
        'max_ms': max(lats) if lats else None,
        'per_lane_median_ms': {k: statistics.median(v) for k, v in by_lane.items()},
    }
    with open(ledger, 'a') as f:
        f.write(json.dumps(summary) + '\n')
    print(f"  [phase6] n={summary['n']}  p50={summary['p50_ms']}ms  p95={summary['p95_ms']}ms  max={summary['max_ms']}ms")
PYPHASE6

###############################################################################
# PHASE 7 — Auth-degradation simulation
#
# User question: "test if auth dies and eats shit where credentials are
# cleared or lost"
#
# Shape: for each URL in references/auth-degradation-corpus.txt, drive
# `unbrowse resolve` WITHOUT cookies and observe how the response handles
# the missing-credentials case. Collect raw evidence; agent judges in-thread
# whether the failure mode is acceptable. The three failure modes worth
# distinguishing:
#
#   (a) GOOD:    auth_required error OR auth_recommended=true (clean signal)
#   (b) BAD:     silent 200 with empty/wrong data (no auth flag, no error)
#   (c) UGLY:    crash / hang / cookie-DB write (covered by Phase 3 SHA gate)
#
# Substrate-faithful: this phase collects (a/b/c) per probe; the agent reads
# the row and judges whether the auth degradation is acceptable.
#
# Re-checks Phase 1 cookie DB SHA at the END (after Phase 7 runs) to catch
# any write-on-401 footgun the main bench sweep didn't trigger.
###############################################################################
echo ""
echo "[verify:$PLAN] PHASE 7: Auth-degradation simulation"

AUTH_DEG_CORPUS="$SCAFFOLD/references/auth-degradation-corpus.txt"
if [ ! -f "$AUTH_DEG_CORPUS" ]; then
  ROW_KEYS_JSON='["phase","ts","status","reason","path"]'
  ROW_PHASE="auth_degradation" ROW_TS="$TS" ROW_STATUS="SKIPPED" \
    ROW_REASON="no auth-degradation corpus declared" ROW_PATH="$AUTH_DEG_CORPUS" \
    ROW_KEYS_JSON="$ROW_KEYS_JSON" emit_row
else
  AUTH_DEG_OUT_DIR="$SCAFFOLD/bench-out/auth-degradation"
  mkdir -p "$AUTH_DEG_OUT_DIR"
  CLI_CMD="${CLI_CMD:-bun src/cli.ts}"
  AUTH_DEG_N=0
  while IFS='|' read -r dg_intent dg_url dg_expectation; do
    dg_intent=$(printf '%s' "$dg_intent" | sed 's/^ *//;s/ *$//')
    dg_url=$(printf '%s' "$dg_url" | sed 's/^ *//;s/ *$//')
    dg_expectation=$(printf '%s' "$dg_expectation" | sed 's/^ *//;s/ *$//')
    case "$dg_intent" in ''|\#*) continue ;; esac
    [ -z "$dg_url" ] && continue
    AUTH_DEG_N=$((AUTH_DEG_N+1))
    dg_slug=$(printf '%s' "$dg_url" | tr '/:?&=.' '_' | cut -c1-60)
    dg_out="$AUTH_DEG_OUT_DIR/${AUTH_DEG_N}_${dg_slug}.out"
    echo "  [phase7] ($AUTH_DEG_N) $dg_url (expect=$dg_expectation)"
    probe_t0_ms=$(python3 -c "import time; print(int(time.time()*1000))")
    # IMPORTANT: do NOT pass any cookies. The point is to see what happens
    # when credentials are missing. timeout protects against hangs.
    cd "$PROJECT_ROOT" 2>/dev/null || cd "$(dirname "$SCAFFOLD")/.."
    timeout 60 bun src/cli.ts resolve --intent "$dg_intent" --url "$dg_url" </dev/null > "$dg_out" 2>&1
    dg_exit=$?
    probe_t1_ms=$(python3 -c "import time; print(int(time.time()*1000))")
    dg_ms=$((probe_t1_ms - probe_t0_ms))

    LEDGER="$LEDGER" RUN_TS="$TS" DG_URL="$dg_url" DG_INTENT="$dg_intent" \
      DG_EXPECTATION="$dg_expectation" DG_OUT="$dg_out" DG_EXIT="$dg_exit" \
      DG_MS="$dg_ms" DG_N="$AUTH_DEG_N" python3 <<'PYDEG'
import json, os, re

ledger = os.environ['LEDGER']
ts = os.environ['RUN_TS']
out_path = os.environ['DG_OUT']
url = os.environ['DG_URL']
intent = os.environ['DG_INTENT']
expectation = os.environ['DG_EXPECTATION']
dg_exit = int(os.environ['DG_EXIT'])
dg_ms = int(os.environ['DG_MS'])

try:
    raw = open(out_path, 'r', errors='replace').read()
except Exception:
    raw = ''

# Decode the top-level response (same strategy as extract.py).
candidates = []
for m in re.finditer(r'\{"(?:trace|result|error|skill_id)"', raw):
    try:
        obj, _ = json.JSONDecoder(strict=False).raw_decode(raw[m.start():])
        if isinstance(obj, dict):
            candidates.append((len(json.dumps(obj)), obj))
    except Exception:
        continue
candidates.sort(key=lambda x: x[0], reverse=True)
d = candidates[0][1] if candidates else {}
r = d.get('result', {}) if isinstance(d.get('result'), dict) else {}

error_code = (r.get('error') or d.get('error') or '') if isinstance(r, dict) else ''
auth_recommended = bool(r.get('auth_recommended')) if isinstance(r, dict) else False
n_ops = len(r.get('available_operations') or r.get('available_endpoints') or []) if isinstance(r, dict) else 0
trace_ok = (d.get('trace', {}) or {}).get('success') if isinstance(d.get('trace'), dict) else None
text_excerpt = (r.get('text_excerpt') or r.get('markdown') or '')[:300] if isinstance(r, dict) else ''
captured_meta = r.get('captured_meta') if isinstance(r, dict) else None
captured_text_bytes = (captured_meta or {}).get('text_bytes') if isinstance(captured_meta, dict) else None

# Substrate-faithful evidence classification (NOT a verdict). The agent
# reads the row and judges in-thread. Three observable shapes:
#   GOOD_CLEAN_AUTH_SIGNAL: error_code=auth_required OR auth_recommended=true
#   AMBIGUOUS_SILENT_200:   no auth flag, no error, but trace claims success
#                           — needs agent judgment of whether the data is real
#   AMBIGUOUS_NO_DATA:      no auth flag, no useful content, no clean error
shape = ''
if error_code == 'auth_required' or auth_recommended:
    shape = 'CLEAN_AUTH_SIGNAL'
elif trace_ok is True and n_ops > 0:
    shape = 'SILENT_PROCEEDED_NEEDS_REVIEW'
elif trace_ok is True and n_ops == 0 and (captured_text_bytes or 0) > 1000:
    shape = 'PROCEEDED_NO_OPS_HAS_CONTENT'
elif dg_exit == 124:
    shape = 'TIMEOUT'
elif not raw or len(raw) < 100:
    shape = 'EMPTY_RESPONSE'
else:
    shape = 'AMBIGUOUS'

row = {
    'phase': 'auth_degradation',
    'ts': ts,
    'probe_n': int(os.environ['DG_N']),
    'intent': intent,
    'url': url,
    'expected_shape': expectation,
    'observed_shape': shape,
    'error_code': error_code,
    'auth_recommended': auth_recommended,
    'n_operations': n_ops,
    'trace_success': trace_ok,
    'captured_text_bytes': captured_text_bytes,
    'text_excerpt': text_excerpt,
    'cli_exit': dg_exit,
    'actual_total_ms': dg_ms,
    'artifact': out_path,
}
with open(ledger, 'a') as f:
    f.write(json.dumps(row) + '\n')
print(f"    [phase7] shape={shape}  error={error_code or 'none'}  auth_rec={auth_recommended}  ops={n_ops}  ms={dg_ms}")
PYDEG
  done < "$AUTH_DEG_CORPUS"

  # Recheck cookie DB SHA AFTER phase 7 — catches any write-on-401 that
  # the main bench sweep didn't trigger because the probes had cookies.
  if [ -f "$COOKIE_DB" ] && [ -n "$COOKIE_PRE_SHA" ]; then
    COOKIE_POST7_SHA=$(shasum "$COOKIE_DB" 2>/dev/null | awk '{print $1}')
    if [ "$COOKIE_POST7_SHA" != "$COOKIE_PRE_SHA" ]; then
      ROW_KEYS_JSON='["phase","ts","status","severity","reason","sha_pre","sha_post"]'
      ROW_PHASE="cookie_integrity_post_phase7" ROW_TS="$TS" ROW_STATUS="FAIL" \
        ROW_SEVERITY="P0" ROW_REASON="cookie DB sha changed during Phase 7 auth-degradation" \
        ROW_SHA_PRE="$COOKIE_PRE_SHA" ROW_SHA_POST="$COOKIE_POST7_SHA" \
        ROW_KEYS_JSON="$ROW_KEYS_JSON" emit_row
      VERIFY_RC=1
    else
      ROW_KEYS_JSON='["phase","ts","status","sha"]'
      ROW_PHASE="cookie_integrity_post_phase7" ROW_TS="$TS" ROW_STATUS="PASS" \
        ROW_SHA="$COOKIE_POST7_SHA" ROW_KEYS_JSON="$ROW_KEYS_JSON" emit_row
    fi
  fi
fi

echo ""
echo "[verify:$PLAN] all phases complete"
echo "[verify:$PLAN] ledger: $LEDGER"
echo "[verify:$PLAN] verify_rc=$VERIFY_RC"

exit $VERIFY_RC
