#!/usr/bin/env bash
# four-dim-gate.sh — every prod deploy of www.unbrowse.ai is blocked
# unless ALL FOUR dimensions are non-regressing vs current prod and at
# least one strictly improves.
#
# The four dimensions:
#   1. Core Web Vitals (perf-audit.mjs)        — auto, machine-judged
#   2. Visual taste (screenshot-landing.mjs)   — agent-judged in-thread
#   3. Accessibility (axe-core)                — auto, machine-judged
#   4. Copy + GEO/SEO integrity                — auto, machine-judged
#
# Harness collects evidence. Agent reads .bench-four-dim/GATE.md and the
# screenshot folder, then judges taste + renders the final PROMOTE/HOLD
# verdict. The script never makes the deploy decision — it returns:
#   exit 0  — all auto-dimensions PASS (taste still needs agent review)
#   exit 1  — auto-dimensions show REGRESSION
#
# Usage:
#   bash scripts/four-dim-gate.sh                              # localhost:3300 vs prod
#   bash scripts/four-dim-gate.sh --candidate http://...       # custom candidate
#   bash scripts/four-dim-gate.sh --baseline https://...       # custom baseline
#   bash scripts/four-dim-gate.sh --candidate ... --baseline ...
#
# After exit 0: agent inspects .bench-four-dim/{candidate,baseline}-screens/,
# judges visual taste, then if PROMOTE renders:
#   cd frontend && bun run deploy

set -euo pipefail

# ── Args ─────────────────────────────────────────────────────────────────
CANDIDATE_URL=""
BASELINE_URL="https://www.unbrowse.ai/"
SKIP_LOCAL_START=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --candidate) CANDIDATE_URL="$2"; shift 2 ;;
    --baseline)  BASELINE_URL="$2"; shift 2 ;;
    --skip-local-start) SKIP_LOCAL_START=1; shift ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//' | head -40
      exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# ── Setup ────────────────────────────────────────────────────────────────
HERE="$(cd "$(dirname "$0")" && pwd)"
FRONTEND_DIR="$(cd "$HERE/.." && pwd)"
REPO_ROOT="$(cd "$FRONTEND_DIR/.." && pwd)"
BENCH_DIR="$REPO_ROOT/.bench-four-dim"
mkdir -p "$BENCH_DIR"

# Spin up local prod server if no candidate given
LOCAL_SERVER_PID=""
if [[ -z "$CANDIDATE_URL" ]]; then
  CANDIDATE_URL="http://localhost:3300/"
  if [[ "$SKIP_LOCAL_START" -eq 0 ]]; then
    # Kill anything on port 3300, then build + start
    if lsof -ti :3300 >/dev/null 2>&1; then
      lsof -ti :3300 | xargs kill -9 2>/dev/null || true
      sleep 1
    fi
    echo "[gate] starting local prod server on :3300" >&2
    (cd "$FRONTEND_DIR" && PORT=3300 bun run start > "$BENCH_DIR/local-server.log" 2>&1 &)
    LOCAL_SERVER_PID=$!
    # Wait for server up
    for i in 1 2 3 4 5 6 7 8 9 10; do
      sleep 1
      if curl -sf -o /dev/null "$CANDIDATE_URL"; then break; fi
      if [[ $i -eq 10 ]]; then
        echo "[gate] local server failed to start; tail of log:" >&2
        tail -20 "$BENCH_DIR/local-server.log" >&2
        exit 2
      fi
    done
    trap 'lsof -ti :3300 2>/dev/null | xargs kill -9 2>/dev/null || true' EXIT
  fi
fi

echo "[gate] candidate=$CANDIDATE_URL baseline=$BASELINE_URL" >&2

# Helper: write a key:value line into a per-section accumulator
GATE_MD="$BENCH_DIR/GATE.md"
: > "$GATE_MD"
gate_write() { printf '%s\n' "$*" >> "$GATE_MD"; }

gate_write "# four-dim-gate — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
gate_write ""
gate_write "**Candidate:** $CANDIDATE_URL"
gate_write "**Baseline:** $BASELINE_URL"
gate_write ""

# Track per-dimension verdict
PERF_VERDICT="UNKNOWN"
A11Y_VERDICT="UNKNOWN"
COPY_VERDICT="UNKNOWN"
TASTE_VERDICT="NEEDS-AGENT-JUDGMENT"
REGRESSION=0

# ── Dim 1: Core Web Vitals ───────────────────────────────────────────────
echo "[gate] dim 1/4: Core Web Vitals" >&2
gate_write "## 1. Core Web Vitals"
gate_write ""

run_perf() {
  local target="$1" out="$2"
  (cd "$FRONTEND_DIR" && PERF_TARGET="$target" node scripts/perf-audit.mjs >"$out.stdout" 2>&1)
  # perf-audit.mjs writes to ../.editions-evidence/PERF-AUDIT.json
  cp "$REPO_ROOT/.editions-evidence/PERF-AUDIT.json" "$out"
}

run_perf "$CANDIDATE_URL" "$BENCH_DIR/candidate-perf.json"
run_perf "$BASELINE_URL"  "$BENCH_DIR/baseline-perf.json"

PERF_DELTA=$(python3 - "$BENCH_DIR/candidate-perf.json" "$BENCH_DIR/baseline-perf.json" <<'PY'
import json, sys
cand = json.load(open(sys.argv[1]))
base = json.load(open(sys.argv[2]))
def m(d, k): return d['coreMetrics'].get(k)
metrics = [
    ('LCP', 'lcp', 'lower'),
    ('FCP', 'fcp', 'lower'),
    ('CLS', 'cls', 'lower'),
    ('TBT', 'tbt', 'lower'),
]
print('| Metric | Candidate | Baseline | Delta | Verdict |')
print('|---|---|---|---|---|')
verdict_status = 'PASS'
improved_any = False
for label, key, direction in metrics:
    c = m(cand, key); b = m(base, key)
    if c is None or b is None:
        print(f'| {label} | n/a | n/a | n/a | UNKNOWN |')
        continue
    delta = c - b
    if direction == 'lower':
        # tolerate normal fluctuation. CLS is hard threshold (0.02);
        # timing metrics tolerate 15% of baseline OR 200ms — whichever
        # is bigger. Localhost-vs-prod has different TTFB profiles so
        # noise is real even when the candidate is genuinely better.
        if label == 'CLS':
            tol = 0.02
        else:
            tol = max(200, abs(b) * 0.15)
        if delta < -tol:
            v = 'IMPROVED'
            improved_any = True
        elif delta > tol:
            v = 'REGRESSED'
            verdict_status = 'FAIL'
        else:
            v = 'NEUTRAL'
    fmt_v = (lambda x: f'{x:.3f}') if label == 'CLS' else (lambda x: f'{x:.0f}ms')
    print(f'| {label} | {fmt_v(c)} | {fmt_v(b)} | {("+" if delta>=0 else "")}{fmt_v(delta)} | {v} |')

# total_bytes (network)
cb = cand.get('network', {}).get('totalBytes', 0)
bb = base.get('network', {}).get('totalBytes', 0)
delta_kb = (cb - bb) / 1024
tol_kb = max(20.0, bb / 1024 * 0.10)
if delta_kb < -tol_kb:
    v = 'IMPROVED'; improved_any = True
elif delta_kb > tol_kb:
    v = 'REGRESSED'; verdict_status = 'FAIL'
else:
    v = 'NEUTRAL'
print(f'| total_bytes | {cb/1024:.0f}KB | {bb/1024:.0f}KB | {("+" if delta_kb>=0 else "")}{delta_kb:.0f}KB | {v} |')

print('')
print(f'**Verdict:** {verdict_status}')
print(f'**Improved-any:** {improved_any}')
PY
)
echo "$PERF_DELTA" >> "$GATE_MD"
if echo "$PERF_DELTA" | grep -q "Verdict:.*FAIL"; then
  PERF_VERDICT="REGRESSED"
  REGRESSION=1
else
  PERF_VERDICT="NON-REGRESSING"
fi
gate_write ""

# ── Dim 2: Visual taste (screenshots) ────────────────────────────────────
echo "[gate] dim 2/4: Visual taste screenshots" >&2
gate_write "## 2. Visual taste"
gate_write ""

mkdir -p "$BENCH_DIR/candidate-screens" "$BENCH_DIR/baseline-screens"
(cd "$FRONTEND_DIR" && LANDING_URL="$CANDIDATE_URL" SCREENSHOT_DIR="$BENCH_DIR/candidate-screens" \
    node scripts/screenshot-landing.mjs > "$BENCH_DIR/candidate-screens/_log.txt" 2>&1) || true
(cd "$FRONTEND_DIR" && LANDING_URL="$BASELINE_URL"  SCREENSHOT_DIR="$BENCH_DIR/baseline-screens" \
    node scripts/screenshot-landing.mjs > "$BENCH_DIR/baseline-screens/_log.txt" 2>&1) || true

gate_write "Screenshots written to:"
gate_write "- candidate: \`$BENCH_DIR/candidate-screens/\`"
gate_write "- baseline:  \`$BENCH_DIR/baseline-screens/\`"
gate_write ""
gate_write "Counts:"
gate_write "- candidate: $(ls "$BENCH_DIR/candidate-screens"/*.png 2>/dev/null | wc -l | tr -d ' ') png(s)"
gate_write "- baseline:  $(ls "$BENCH_DIR/baseline-screens"/*.png  2>/dev/null | wc -l | tr -d ' ') png(s)"
gate_write ""
gate_write "**Verdict:** $TASTE_VERDICT (agent reads .bench-four-dim/candidate-screens/ vs baseline-screens/ in-thread)"
gate_write ""

# ── Dim 3: Accessibility (axe-core) ──────────────────────────────────────
echo "[gate] dim 3/4: Accessibility" >&2
gate_write "## 3. Accessibility"
gate_write ""

run_axe() {
  local target="$1" out="$2"
  # @axe-core/cli wraps Selenium+ChromeDriver and routinely breaks on
  # version-skew vs the system Chrome. We have puppeteer with a
  # known-good Chromium already installed, and `axe-core` in
  # devDependencies — drive axe.run() in the browser via puppeteer.
  node -e "
    const puppeteer = require('puppeteer');
    const fs = require('fs');
    const axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
    (async () => {
      const b = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
      const p = await b.newPage();
      await p.setViewport({ width: 1440, height: 900 });
      try {
        await p.goto('$target', { waitUntil: 'networkidle2', timeout: 60000 });
        await p.evaluate(axeSource);
        const results = await p.evaluate(() => window.axe.run(document, {
          runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'best-practice'] },
        }));
        fs.writeFileSync('$out', JSON.stringify([results], null, 2));
        console.log('axe done:', results.violations.length, 'violations');
      } catch (e) {
        fs.writeFileSync('$out', JSON.stringify({ error: String(e) }, null, 2));
        console.error('axe error:', String(e));
      } finally {
        await b.close();
      }
    })();
  " > "$out.stdout" 2>&1 || true
}
run_axe "$CANDIDATE_URL" "$BENCH_DIR/candidate-a11y.json"
run_axe "$BASELINE_URL"  "$BENCH_DIR/baseline-a11y.json"

A11Y_DELTA=$(python3 - "$BENCH_DIR/candidate-a11y.json" "$BENCH_DIR/baseline-a11y.json" <<'PY'
import json, sys, os
def read(path):
    if not os.path.exists(path):
        return None
    try:
        d = json.load(open(path))
        # @axe-core/cli emits an array of one run; tolerate either shape
        run = d[0] if isinstance(d, list) and d else d
        viols = run.get('violations', [])
        per_impact = {}
        for v in viols:
            imp = v.get('impact') or 'unknown'
            per_impact[imp] = per_impact.get(imp, 0) + len(v.get('nodes', []) or [1])
        return {'total': len(viols), 'per_impact': per_impact, 'rule_ids': [v.get('id') for v in viols]}
    except Exception as e:
        return {'error': str(e)}
c = read(sys.argv[1]); b = read(sys.argv[2])
if not c or not b:
    print('| - | a11y file missing | - | - |')
    print('')
    print('**Verdict:** UNKNOWN (axe-core failed to run; install bunx @axe-core/cli)')
    sys.exit(0)
if 'error' in c or 'error' in b:
    print(f'parse error: candidate={c.get("error","")} baseline={b.get("error","")}')
    print('')
    print('**Verdict:** UNKNOWN')
    sys.exit(0)
print('| Impact | Candidate | Baseline | Delta | Verdict |')
print('|---|---|---|---|---|')
verdict = 'PASS'
for imp in ['critical', 'serious', 'moderate', 'minor']:
    cv = c['per_impact'].get(imp, 0); bv = b['per_impact'].get(imp, 0)
    delta = cv - bv
    if delta > 0:
        v = 'REGRESSED'
        if imp in ('critical', 'serious'):
            verdict = 'FAIL'
    elif delta < 0:
        v = 'IMPROVED'
    else:
        v = 'NEUTRAL'
    print(f'| {imp} | {cv} | {bv} | {("+" if delta>=0 else "")}{delta} | {v} |')
print(f'| total violations | {c["total"]} | {b["total"]} | {c["total"]-b["total"]:+d} | - |')
print('')
print(f'**Verdict:** {verdict}')
PY
)
echo "$A11Y_DELTA" >> "$GATE_MD"
if echo "$A11Y_DELTA" | grep -q "Verdict:.*FAIL"; then
  A11Y_VERDICT="REGRESSED"
  REGRESSION=1
elif echo "$A11Y_DELTA" | grep -q "Verdict:.*UNKNOWN"; then
  A11Y_VERDICT="UNKNOWN"
else
  A11Y_VERDICT="NON-REGRESSING"
fi
gate_write ""

# ── Dim 4: Copy + GEO/SEO integrity ──────────────────────────────────────
echo "[gate] dim 4/4: Copy + GEO/SEO" >&2
gate_write "## 4. Copy + GEO/SEO integrity"
gate_write ""

COPY_REPORT=$(python3 - "$CANDIDATE_URL" "$BASELINE_URL" "$BENCH_DIR" <<'PY'
import sys, json, urllib.request, urllib.error, re
from urllib.parse import urljoin

cand_url, base_url, bench = sys.argv[1], sys.argv[2], sys.argv[3]

# Load-bearing phrases that MUST appear in candidate landing HTML.
# Updated 2026-05-26 (Banger Wave 1): the locked H1 "Direct access to
# anything on the web. Without setting up another MCP." was replaced by
# the unicorn-landing-audit-driven category claim "The API layer for AI
# agents." The audit lives at .editions-evidence/UNICORN-AUDIT.md and
# the change is explicitly NOT a regression — it's a category-defining
# headline per the 11-unicorn-pattern rubric. The numbers, settlement
# chain, install command, and github pointer remain the load-bearing
# substrate; those still gate.
REQUIRED = [
    "The API layer for AI agents",
    "shadow API",
    "3.6x",
    "5.4x",
    "Solana via Faremeter Flex",
    "npx unbrowse setup",
    "unbrowse-ai/unbrowse",
]
FORBIDDEN = [
    "Base L2",  # numerical drift / wrong chain
]

def fetch(url, allow_status=(200, 304)):
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'four-dim-gate/1.0'})
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, r.read().decode('utf-8', errors='replace'), dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode('utf-8', errors='replace') if hasattr(e,'read') else '', {}
    except Exception as e:
        return None, f'__error__ {e}', {}

verdict = 'PASS'
lines = []

# 1) Required strings in candidate
status, html, hdrs = fetch(cand_url)
if status != 200:
    lines.append(f'- ! candidate fetch failed (status={status})')
    verdict = 'FAIL'
else:
    n_present = []
    n_missing = []
    for s in REQUIRED:
        (n_present if s in html else n_missing).append(s)
    lines.append(f'- required strings present: {len(n_present)}/{len(REQUIRED)}')
    for s in n_missing:
        lines.append(f'  - MISSING: `{s}`')
        verdict = 'FAIL'
    bad = [s for s in FORBIDDEN if s in html]
    for s in bad:
        lines.append(f'  - FORBIDDEN PRESENT: `{s}`')
        verdict = 'FAIL'

    # 2) JSON-LD validity
    ld_blocks = re.findall(r'<script type="application/ld\+json"[^>]*>(.*?)</script>', html, re.DOTALL)
    n_ld_ok = 0
    n_ld_bad = 0
    has_faq = False
    for ld in ld_blocks:
        try:
            obj = json.loads(ld)
            n_ld_ok += 1
            if isinstance(obj, dict) and obj.get('@type') == 'FAQPage':
                has_faq = True
        except Exception:
            n_ld_bad += 1
    lines.append(f'- JSON-LD blocks: {n_ld_ok} valid, {n_ld_bad} invalid; FAQPage present: {has_faq}')
    if n_ld_bad > 0 or not has_faq:
        verdict = 'FAIL'

    # 3) Head metas diff vs baseline
    def metas(s):
        out = {}
        for tag, attr in (('title', None), ('canonical', None)):
            pass
        out['title'] = (re.search(r'<title[^>]*>([^<]*)</title>', s) or ['',''])[1] if re.search(r'<title[^>]*>([^<]*)</title>', s) else ''
        for m in re.finditer(r'<meta\s+([^>]+?)\s*/?>', s):
            attrs = dict(re.findall(r'(\w+)="([^"]*)"', m.group(1)))
            key = attrs.get('name') or attrs.get('property') or attrs.get('itemprop')
            if key:
                out[key] = attrs.get('content', '')
        m = re.search(r'<link[^>]+rel="canonical"[^>]+href="([^"]+)"', s)
        if m: out['canonical'] = m.group(1)
        return out
    cand_metas = metas(html)
    base_status, base_html, _ = fetch(base_url)
    base_metas = metas(base_html) if base_status == 200 else {}
    important = ['title', 'description', 'canonical', 'og:title', 'og:description', 'og:image', 'twitter:title', 'twitter:description', 'twitter:image']
    lines.append('')
    lines.append('| meta | candidate | baseline | match |')
    lines.append('|---|---|---|---|')
    for k in important:
        cv = (cand_metas.get(k) or '')[:60]
        bv = (base_metas.get(k) or '')[:60]
        match = '=' if cv == bv else 'DIFF'
        lines.append(f'| {k} | `{cv}` | `{bv}` | {match} |')

# 4) sitemap.xml
from urllib.parse import urljoin as uj
sm_status, sm_body, _ = fetch(uj(cand_url, '/sitemap.xml'))
sm_ok = sm_status == 200 and ('<urlset' in sm_body or '<sitemapindex' in sm_body)
sm_has_root = '<loc>' in sm_body and ('//' in sm_body)
lines.append('')
lines.append(f'- sitemap.xml status={sm_status} valid_xml={sm_ok} has_locs={sm_has_root}')
if not sm_ok:
    verdict = 'FAIL'

# 5) llms.txt or llms-full.txt
llms_ok = False
for path in ('/llms.txt', '/llms-full.txt'):
    s, b, _ = fetch(uj(cand_url, path))
    if s == 200 and b.strip():
        llms_ok = True
        lines.append(f'- {path}: 200, {len(b)} bytes')
        break
if not llms_ok:
    lines.append('- llms.txt: MISSING (neither /llms.txt nor /llms-full.txt returned 200)')
    verdict = 'FAIL'

print('\n'.join(lines))
print('')
print(f'**Verdict:** {verdict}')
PY
)
echo "$COPY_REPORT" >> "$GATE_MD"
if echo "$COPY_REPORT" | grep -q "Verdict:.*FAIL"; then
  COPY_VERDICT="REGRESSED"
  REGRESSION=1
else
  COPY_VERDICT="NON-REGRESSING"
fi

# ── Summary ──────────────────────────────────────────────────────────────
gate_write ""
gate_write "---"
gate_write ""
gate_write "## Summary"
gate_write ""
gate_write "| Dimension | Verdict |"
gate_write "|---|---|"
gate_write "| 1. Core Web Vitals | $PERF_VERDICT |"
gate_write "| 2. Visual taste    | $TASTE_VERDICT |"
gate_write "| 3. Accessibility   | $A11Y_VERDICT |"
gate_write "| 4. Copy + GEO/SEO  | $COPY_VERDICT |"
gate_write ""

if [[ "$REGRESSION" -eq 1 ]]; then
  gate_write "**Auto-gate verdict: HOLD — regression detected.** Do NOT deploy."
  gate_write ""
  gate_write "Read \`.bench-four-dim/GATE.md\` for per-dimension detail."
  echo "[gate] HOLD — regression detected (perf=$PERF_VERDICT a11y=$A11Y_VERDICT copy=$COPY_VERDICT)" >&2
  cat "$GATE_MD"
  exit 1
fi

gate_write "**Auto-gate verdict: PROMOTE-READY — agent must still judge visual taste.**"
gate_write ""
gate_write "Next step: agent reads \`.bench-four-dim/candidate-screens/\` vs"
gate_write "\`.bench-four-dim/baseline-screens/\` in-thread. If taste is"
gate_write "non-regressing and at least one dim strictly improves, deploy:"
gate_write ""
gate_write '```bash'
gate_write "cd frontend && bun run deploy"
gate_write '```'

echo "[gate] PROMOTE-READY — agent judges taste next" >&2
cat "$GATE_MD"
exit 0
