#!/usr/bin/env bash
# funnel-track.sh — snapshot traction + stats, render funnel over time
#
# Sub-commands (harness+agent, never a solo end-to-end run):
#   snapshot   — pull traction + stats, write .traction-snapshots/YYYY-MM-DD.json
#   history    — list all snapshots
#   graph      — render unicode time-series (verifications, keys, npm) + funnel bars
#   svg        — write .traction-snapshots/latest.svg for sharing
#
# Agent reads the output of graph/svg and judges whether the funnel is healthy.
set -uo pipefail

SNAP_DIR=".traction-snapshots"
TRACTION_URL="https://launch.unbrowse.ai/api/traction"
STATS_URL="https://beta-api.unbrowse.ai/v1/stats/summary"

mkdir -p "$SNAP_DIR"

cmd="${1:-graph}"
shift || true

case "$cmd" in
  snapshot)
    today=$(date -u +%Y-%m-%d)
    out="$SNAP_DIR/${today}.json"
    tmp=$(mktemp)
    {
      echo '{"captured_at":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'",'
      echo '"traction":'
      curl -sS "$TRACTION_URL"
      echo ','
      echo '"stats":'
      curl -sS "$STATS_URL"
      echo '}'
    } > "$tmp"
    if python3 -c "import json,sys; json.load(open('$tmp'))" 2>/dev/null; then
      mv "$tmp" "$out"
      echo "{\"ok\":true,\"snapshot\":\"$out\",\"bytes\":$(wc -c <"$out" | tr -d ' ')}"
    else
      echo '{"ok":false,"error":"invalid_json_from_apis"}'
      rm -f "$tmp"
      exit 1
    fi
    ;;

  history)
    python3 -c "
import glob, json, os
files = sorted(glob.glob('$SNAP_DIR/*.json'))
print(json.dumps({'count': len(files), 'snapshots': [os.path.basename(f) for f in files]}, indent=2))
"
    ;;

  graph)
    # Graph the dailyVolume + dau + npmDaily series from the latest snapshot
    # (or fetch fresh if no snapshot today). 31-day unicode time series.
    latest=$(ls -t "$SNAP_DIR"/*.json 2>/dev/null | head -1 || true)
    if [ -z "$latest" ]; then
      tmp=$(mktemp)
      curl -sS "$TRACTION_URL" > "$tmp"
      src="$tmp"
    else
      src="$latest"
      # If no traction key at top-level, it's a snapshot — unwrap
      if ! python3 -c "import json; d=json.load(open('$src')); exit(0 if 'dailyVolume' in d else 1)" 2>/dev/null; then
        python3 -c "import json; d=json.load(open('$src'))['traction']; json.dump(d, open('/tmp/_funnel_traction.json','w'))"
        src=/tmp/_funnel_traction.json
      fi
    fi

    python3 - "$src" <<'PY'
import json, sys
from datetime import datetime

d = json.load(open(sys.argv[1]))
dv = d.get('dailyVolume', [])
dau = d.get('dau', [])
npm = d.get('npmDaily', [])
funnel = d.get('funnel', {})

def spark(series, key, width=60, height=12):
    if not series: return '(no data)'
    vals = [float(x.get(key,0)) for x in series]
    mx = max(vals) or 1
    # Sample down to `width` points
    if len(vals) > width:
        step = len(vals) / width
        sampled = [vals[int(i*step)] for i in range(width)]
    else:
        sampled = vals
    # Build grid height x width
    grid = [[' ']*len(sampled) for _ in range(height)]
    for i, v in enumerate(sampled):
        h = int((v / mx) * (height - 1) + 0.5)
        for y in range(h+1):
            grid[height-1-y][i] = '█' if y < h else '▄'
    lines = [''.join(row) for row in grid]
    return '\n'.join(lines)

def hbar(label, val, mx, width=40):
    frac = (val / mx) if mx else 0
    filled = int(frac * width)
    bar = '█' * filled + '░' * (width - filled)
    return f"  {label:<20} {bar} {val:>8,}"

print()
print('═' * 72)
print('  UNBROWSE FUNNEL — ' + d.get('captured_at', datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ')))
print('═' * 72)
print()
print('  VERIFICATIONS / DAY (last 31d, max={:,})'.format(int(max((x['verifications'] for x in dv), default=0))))
print(spark(dv, 'verifications'))
first_day = dv[0]['day'][:10] if dv else ''
last_day = dv[-1]['day'][:10] if dv else ''
print(f'  {first_day}{" "*(60-len(first_day)-len(last_day))}{last_day}')
print()
print('  ACTIVE KEYS / DAY (last 31d, max={:,})'.format(int(max((x['active_keys'] for x in dau), default=0))))
print(spark(dau, 'active_keys'))
print()
print('  NPM DOWNLOADS / DAY (last 30d, max={:,})'.format(int(max((x['total'] for x in npm), default=0))))
print(spark(npm, 'total'))
print()
print('─' * 72)
print('  ACQUISITION FUNNEL (cumulative keys by verification count)')
print('─' * 72)
mx = max(funnel.values()) if funnel else 1
for label, key in [('1+ verifications','verified1Plus'),
                    ('10+ verifications','verified10Plus'),
                    ('100+ verifications','verified100Plus'),
                    ('1000+ verifications','verified1000Plus')]:
    print(hbar(label, funnel.get(key, 0), mx))

# Conversion rates between steps
v1 = funnel.get('verified1Plus', 0) or 1
print()
print(f'  1+ → 10+    : {100*funnel.get("verified10Plus",0)/v1:5.1f}%')
v10 = funnel.get('verified10Plus', 0) or 1
print(f'  10+ → 100+  : {100*funnel.get("verified100Plus",0)/v10:5.1f}%')
v100 = funnel.get('verified100Plus', 0) or 1
print(f'  100+ → 1000+: {100*funnel.get("verified1000Plus",0)/v100:5.1f}%')
print()
print('  TOTALS')
print(f'    stars:            {d.get("githubStars",0):,}')
print(f'    npm downloads:    {d.get("npmDownloadsTotal",0):,}')
print(f'    total keys:       {d.get("totalKeys",0):,}')
print(f'    WAU:              {d.get("wau",0):,}')
print(f'    verifications:    {d.get("totalVerifications",0):,}')
print(f'    weekly retention: {d.get("weeklyRetention",0)}%')
print('═' * 72)
PY
    ;;

  coverage)
    # Graph product-success-rate over time from benchmark-history.jsonl
    # (one row per (version, run). Excludes browser-blocked from denom per
    # the "100% coverage unless browser-level blocked" target.
    hist="${UNBROWSE_BENCHMARK_HISTORY:-$HOME/.unbrowse/benchmark-history.jsonl}"
    if [ ! -f "$hist" ]; then
      echo '{"ok":false,"error":"no_benchmark_history","hint":"run scripts/benchmark-turbobox-parallel.sh first"}'
      exit 1
    fi
    python3 - "$hist" <<'PY'
import json, sys
from collections import defaultdict
rows = []
for line in open(sys.argv[1]):
    try:
        d = json.loads(line)
        if d.get('corpus_size', 0) > 0:
            rows.append(d)
    except: pass
if not rows:
    print('(no runs with non-zero corpus)')
    sys.exit(0)

print()
print('═' * 72)
print('  UNBROWSE COVERAGE — product success rate over time')
print('  (100% = every non-browser-blocked attempt resolved)')
print('═' * 72)
print()
print(f"  {'when':<20} {'version':<14} {'corpus':<8} {'pass':<6} {'fail':<6} {'block':<6} {'rate':<8}")
print('  ' + '─' * 68)
for r in rows[-20:]:
    ts = r.get('timestamp','')[:19].replace('T',' ')
    ver = r.get('version','?')[:13]
    t = r.get('corpus_size',0)
    p = r.get('pass',0)
    f = r.get('product_fail',0)
    b = r.get('browser_block',0)
    rate = r.get('product_success_rate',0)
    marker = '✓' if rate >= 100 else ('·' if rate >= 60 else '✗')
    print(f"  {ts:<20} {ver:<14} {t:<8} {p:<6} {f:<6} {b:<6} {rate:>5.0f}% {marker}")

# Unicode line chart of rate over runs
print()
print('  SUCCESS RATE TREND (newest on right)')
vals = [r.get('product_success_rate',0) for r in rows]
width = min(60, len(vals))
height = 10
# sample to width
if len(vals) > width:
    step = len(vals) / width
    sampled = [vals[int(i*step)] for i in range(width)]
else:
    sampled = vals
grid = [[' ']*len(sampled) for _ in range(height)]
for i, v in enumerate(sampled):
    h = int((v / 100) * (height - 1) + 0.5)
    for y in range(h+1):
        grid[height-1-y][i] = '█'
# 100% and 0% gridlines
for row in range(height):
    label = ''
    if row == 0: label = '100%'
    elif row == height-1: label = '  0%'
    else: label = '    '
    print(f'  {label} │' + ''.join(grid[row]))
print(f'         └' + '─' * len(sampled))

# Last run summary
last = rows[-1]
p, f, b = last.get('pass',0), last.get('product_fail',0), last.get('browser_block',0)
print()
print(f"  LATEST RUN: {last.get('version','?')} — {p} pass, {f} product-fail, {b} browser-block")
if f == 0:
    print(f"  ✓ ZERO product failures on this corpus. gap to 100% = browser-block only ({b})")
else:
    print(f"  ✗ {f} product fail(s) — these are the promote candidates")
print('═' * 72)
PY
    ;;

  svg)
    latest=$(ls -t "$SNAP_DIR"/*.json 2>/dev/null | head -1 || true)
    if [ -z "$latest" ]; then
      echo '{"ok":false,"error":"no_snapshots_run_snapshot_first"}'
      exit 1
    fi
    out="$SNAP_DIR/latest.svg"
    python3 - "$latest" "$out" <<'PY'
import json, sys
src, out = sys.argv[1], sys.argv[2]
raw = json.load(open(src))
d = raw.get('traction', raw)
dv = d.get('dailyVolume', [])
W, H = 900, 320
pad = 50
vals = [x['verifications'] for x in dv]
if not vals:
    open(out,'w').write('<svg/>'); sys.exit(0)
mx = max(vals) or 1
n = len(vals)
def x(i): return pad + (W - 2*pad) * i / max(n-1,1)
def y(v): return H - pad - (H - 2*pad) * v / mx
pts = ' '.join(f'{x(i):.1f},{y(v):.1f}' for i,v in enumerate(vals))
svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" font-family="monospace">
<rect width="{W}" height="{H}" fill="#0b0f17"/>
<text x="{pad}" y="28" fill="#7dd3fc" font-size="16">verifications / day — {dv[0]['day'][:10]} → {dv[-1]['day'][:10]} — peak {mx:,}</text>
<polyline fill="none" stroke="#34d399" stroke-width="2" points="{pts}"/>
<line x1="{pad}" y1="{H-pad}" x2="{W-pad}" y2="{H-pad}" stroke="#334155"/>
</svg>'''
open(out,'w').write(svg)
print(json.dumps({'ok':True,'svg':out,'points':n,'peak':mx}))
PY
    ;;

  *)
    echo "usage: bash scripts/funnel-track.sh [snapshot|history|graph|svg]"
    exit 1
    ;;
esac
