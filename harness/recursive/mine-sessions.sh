#!/usr/bin/env bash
# mine-sessions.sh — scan ~/.claude, ~/.codex, ~/.aiko for unbrowse mentions,
# extract domain + intent + failure signal, append novel rows to corpus.txt.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/runs/mining-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUT"
RAW="$OUT/raw-hits.jsonl"
DERIVED="$OUT/derived-domains.tsv"
NEW_CORPUS="$OUT/new-corpus-rows.txt"

ROOTS=(
  "$HOME/.claude/projects"
  "$HOME/.codex"
  "$HOME/.aiko/projects"
)

echo "[mine] scanning ${#ROOTS[@]} roots…" >&2

# Stream every jsonl line that mentions unbrowse + a URL/domain/error.
# We capture lines containing 'unbrowse' AND any of: error, fail, browser_session, 0 endpoints, no operations, http://, https://, *.com, *.world, *.io, *.ai, *.net, *.org
python3 - "${ROOTS[@]}" "$RAW" <<'PY'
import json, os, sys, re, glob
roots = sys.argv[1:-1]
out = sys.argv[-1]
url_re = re.compile(r'https?://[^\s"\'<>)`]+')
dom_re = re.compile(r'\b([a-z0-9-]+(?:\.[a-z0-9-]+){1,3})\b', re.I)
fail_markers = (
    'browser_session_open', 'browser-fallback', 'no_endpoint',
    'No relevant endpoint', 'auth_required', 'failed', 'error',
    'extraction_hints', 'data: []', 'empty', 'timed out',
    'available_operations":[]', 'available_operations": []',
    'Still working', 'execute failed', 'resolve failed',
)
files = []
for r in roots:
    if not os.path.isdir(r): continue
    for f in glob.iglob(os.path.join(r, '**/*.jsonl'), recursive=True):
        files.append(f)
print(f'[mine] {len(files)} jsonl files', file=sys.stderr)
hits = 0
seen_line = set()
with open(out, 'w') as o:
    for fp in files:
        try:
            with open(fp, 'rb') as f:
                for raw in f:
                    if b'unbrowse' not in raw and b'Unbrowse' not in raw:
                        continue
                    s = raw.decode('utf-8', errors='replace')
                    low = s.lower()
                    if not any(m in low for m in (m.lower() for m in fail_markers)):
                        # also keep if it explicitly invokes unbrowse resolve/execute
                        if 'unbrowse resolve' not in low and 'unbrowse execute' not in low and 'unbrowse go' not in low:
                            continue
                    urls = url_re.findall(s)
                    if not urls:
                        continue
                    key = (fp, urls[0][:120], len(s))
                    if key in seen_line: continue
                    seen_line.add(key)
                    o.write(json.dumps({
                        'file': fp,
                        'urls': urls[:5],
                        'snippet': s[:1500],
                    }, ensure_ascii=False) + '\n')
                    hits += 1
        except Exception as e:
            continue
print(f'[mine] {hits} hits → {out}', file=sys.stderr)
PY

echo "[mine] derive domain × failure-class table" >&2
python3 - "$RAW" "$DERIVED" <<'PY'
import json, sys, re, collections
inp, out = sys.argv[1], sys.argv[2]
url_re = re.compile(r'https?://([^/\s"\'<>)`]+)')
SKIP = {
  'unbrowse.ai','beta-api.unbrowse.ai','launch.unbrowse.ai','api.unbrowse.ai',
  'github.com','raw.githubusercontent.com','npmjs.com','registry.npmjs.org',
  'localhost','127.0.0.1','arxiv.org','google.com','www.google.com',
  'anthropic.com','claude.ai',
}
dom_count = collections.Counter()
dom_signals = collections.defaultdict(set)
dom_intent_sample = {}
for line in open(inp):
    j = json.loads(line)
    s = j['snippet'].lower()
    for u in j['urls']:
        m = url_re.match(u)
        if not m: continue
        d = m.group(1).lower().split(':')[0]
        if d.startswith('www.'): d = d[4:]
        if d in SKIP: continue
        # heuristic: skip pure CDN/static
        if any(d.endswith(x) for x in ('.cloudfront.net','.amazonaws.com','.googleapis.com','.gstatic.com')):
            continue
        dom_count[d] += 1
        if 'browser_session_open' in s: dom_signals[d].add('browser_open')
        if 'no relevant endpoint' in s: dom_signals[d].add('no_endpoint')
        if 'available_operations":[]' in s.replace(' ',''): dom_signals[d].add('zero_ops')
        if 'extraction_hints' in s: dom_signals[d].add('extract_hints_only')
        if 'auth_required' in s: dom_signals[d].add('auth')
        if 'data: []' in s or 'data":[]' in s: dom_signals[d].add('empty_data')
        if 'still working' in s: dom_signals[d].add('slow')
        # try to capture an --intent value near this domain
        if d not in dom_intent_sample:
            mi = re.search(r'--intent\s+["\']?([^"\'\n]{6,80})', j['snippet'])
            if mi: dom_intent_sample[d] = mi.group(1).strip()
with open(out, 'w') as o:
    o.write('domain\thits\tsignals\tintent_sample\n')
    for d, n in dom_count.most_common(200):
        if n < 2: continue   # need to see it more than once
        sig = ','.join(sorted(dom_signals[d])) or '-'
        intent = dom_intent_sample.get(d, '')
        o.write(f'{d}\t{n}\t{sig}\t{intent}\n')
print(f'[mine] {sum(1 for _ in open(out))-1} domains kept', file=sys.stderr)
PY

echo "[mine] propose new corpus rows for domains with failure signals" >&2
python3 - "$DERIVED" "$HERE/corpus.txt" "$NEW_CORPUS" <<'PY'
import sys
derived, corpus, out = sys.argv[1:]
existing = open(corpus).read().lower()
rows = []
for i, line in enumerate(open(derived)):
    if i == 0: continue
    parts = line.rstrip('\n').split('\t')
    if len(parts) < 4: continue
    d, hits, sig, intent = parts
    if sig == '-': continue
    if d in existing: continue
    if 'browser_open' in sig or 'no_endpoint' in sig or 'zero_ops' in sig or 'empty_data' in sig:
        intent = intent or f'fetch data from {d}'
        rows.append(f'{intent} | https://{d} | execute_data  # mined: hits={hits} sig={sig}')
with open(out, 'w') as o:
    o.write('\n'.join(rows) + ('\n' if rows else ''))
print(f'[mine] {len(rows)} new rows → {out}', file=sys.stderr)
PY

echo
echo "── mining complete ──"
echo "  raw hits:   $RAW"
echo "  domains:    $DERIVED"
echo "  new corpus: $NEW_CORPUS"
echo
echo "review then append:  cat $NEW_CORPUS >> $HERE/corpus.txt"
